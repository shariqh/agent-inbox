// src/shape.ts — payload shaping for the MCP READ tools (issue #42).
//
// WHAT THIS IS FOR. `context` is written FOR THE HUMAN: docs/reporting-snippet.md
// tells agents it renders as a collapsed dropdown, so length there is free — and
// agents write generously, correctly. Then every agent that READS a board pays
// for it. Measured against the live db: `board_get()` with no title cost ~11,500
// tokens in one project, ~7,050 of which was the `context` field alone, and #37's
// at-least-once row delivery re-shipped a blocked row's full context on EVERY
// poll (27 rows carry >220 tokens of it; worst ~720; 20 polls ≈ 14,400 tokens of
// text the agent already had).
//
// WHERE IT LIVES AND WHY. Trimming is a SHAPING concern, not a storage one:
// store.ts stays the only door to SQLite and keeps returning whole rows, and this
// module reshapes what the MCP tools hand to an agent. The VIEWER never routes
// through here — /api/boards and /api/items must stay byte-identical (issue #42,
// constraint B; pinned in test/viewer.test.ts). Pure functions plus one tiny
// per-process ledger, so all of it is unit-testable without a server.
//
// THE ONE LINE THAT MATTERS: only AGENT-AUTHORED `context` is ever trimmed. The
// human's `annotation` (and `reply`/`reply_context`) is never omitted, on any
// path, under any option — that is the whole point of #37 and #42 must not undo
// it while saving tokens.
import type { BoardWithRows, BoardRow, Progress, RowStatus } from './store.js'

interface HasContext {
  context: string
}

/**
 * The swap: the long agent-authored text out, its SIZE in — `String.length`, so
 * UTF-16 CODE UNITS, not bytes and not code points (an astral emoji counts 2).
 * That is a size hint for "is this worth fetching", not a character count, and
 * the tool descriptions say so in those words; test/shape.test.ts pins the
 * astral case so the number can never quietly change meaning.
 *
 * `context_chars` present means "there is text here you do not have"; absent
 * means there is none, so an empty context costs nothing at all rather than the
 * `"context":""` every row used to carry.
 */
export type Trimmed<T extends HasContext> = Omit<T, 'context'> & { context_chars?: number }

export function trimContext<T extends HasContext>(o: T): Trimmed<T> {
  const { context, ...rest } = o
  return context ? { ...rest, context_chars: context.length } : rest
}

// ── the per-PROCESS ledger: an optimisation, not a delivery guarantee ───────
//
// WHAT IT ACTUALLY IS. A Map in the MCP server process, recording which contexts
// this PROCESS has already handed over. Not per session, and not per agent:
//
//   · one stdio server is spawned per CLI, and it is long-lived — a server can
//     outlive many "sessions" (one observed with 3.5 days of uptime);
//   · a Claude Code SUBAGENT does not get its own server. Its `pending()` is
//     served by the PARENT CLI's process, so an in-process fan-out — manager
//     plus N subagents — SHARES ONE LEDGER. The first sibling to poll consumes
//     the delivery; every other one is handed `context_chars` for text it has
//     never seen.
//
// Earlier revisions of this file asserted the opposite ("one process lives
// exactly as long as one session, which makes an in-memory Map precisely
// session-scoped"). That was measured and found false — do not restore it.
//
// WHY THAT IS SURVIVABLE. Because nothing depends on the ledger being right.
// Every trimmed context is RECOVERABLE on demand, by the agent that holds the
// `context_chars`, in the same call it is already making:
//
//   · `pending({ full: true })`          — items AND rows, this poll's payload
//   · `board_get({ title, full: true })` — a board's rows
//
// So the worst a wrong guess costs is one extra round-trip, chosen by the agent
// that noticed. Who-has-seen-what is not load-bearing; it only decides whether
// the common case is cheap. The persisted stamp could not even do that much:
// `annotation_seen_at` is per-ROW and `annotation_seen_by` is a CLIENT NAME
// ('claude-code') that every sibling shares, so "already stamped" says nothing
// about which agent holds the text.
//
// Keyed by id AND content: if the text changes it is new text, and it ships
// again. Bounded by the number of distinct rows/items handed over (one entry
// each, overwritten in place), not by how often anyone polls. It starts EMPTY,
// so a restart costs one extra ship, never a starve.
//
// Deliberately NOT claimed on WRITES (board_upsert / board_row), even though an
// agent that just wrote a context obviously has it: upsertBoard returns no row
// ids, so only half the write paths could claim, and a rule that holds for one
// tool and not its twin is a rule nobody can remember. Reads only.
export interface ContextLedger {
  /** true = this PROCESS has not handed over this exact text under this key yet (and it is now recorded). */
  claim(key: string, context: string): boolean
}

export function makeContextLedger(): ContextLedger {
  const shipped = new Map<string, string>()
  return {
    claim(key, context) {
      if (!context) return false // nothing to hand over
      if (shipped.get(key) === context) return false
      shipped.set(key, context)
      return true
    },
  }
}

/** Ledger keys are namespaced by entity so a row id and an item id can never collide. */
export const rowKey = (rowId: string): string => `row:${rowId}`
export const itemKey = (itemId: string): string => `item:${itemId}`

/**
 * pending()'s rule: the first delivery out of this process carries the context,
 * a re-delivery carries only its size — unless the caller asks for `full`, which
 * always returns the text and records the delivery. `full` is the escape hatch
 * that makes the ledger a mere optimisation: an agent handed `context_chars` for
 * text it has never seen (a sibling in the same process drained it) can always
 * get it back.
 *
 * The human's annotation/reply is untouched on every path — it is re-delivered
 * in full for as long as #37 says it should be.
 */
export function deliverContext<T extends HasContext>(
  o: T,
  key: string,
  ledger: ContextLedger,
  opts: { full?: boolean } = {},
): T | Trimmed<T> {
  // claim FIRST, and unconditionally: a `full` delivery is still a delivery, so
  // the next ordinary poll does not re-ship what this one just handed over.
  const first = ledger.claim(key, o.context)
  return first || opts.full === true ? o : trimContext(o)
}

// ── board_get ───────────────────────────────────────────────────────────────

export type ShapedBoard = BoardWithRows | (Omit<BoardWithRows, 'rows'> & { rows: Trimmed<BoardRow>[] })

/**
 * board_get({ title }) — the whole board, with row context swapped for its size.
 * board_get({ title, full: true }) — the real text, and the delivery is recorded
 * so a pending() poll later from the same process does not re-ship what this
 * call just handed over. It is also the recovery path: an agent handed
 * `context_chars` for a row it has never seen asks for the board in full.
 */
export function shapeBoard(board: BoardWithRows, opts: { full?: boolean; ledger: ContextLedger }): ShapedBoard {
  if (opts.full !== true) return { ...board, rows: board.rows.map(trimContext) }
  for (const r of board.rows) opts.ledger.claim(rowKey(r.id), r.context)
  return board
}

export interface RowSummary {
  label: string
  status: RowStatus
  note?: string
  context_chars?: number
  annotation?: string
  annotated_at?: string | null
  annotation_seen_at?: string | null
  annotation_seen_by?: string | null
  annotation_unseen?: boolean
  // issue #36 — the human's OTHER answer on a blocked row. Same rule as the
  // annotation: it is theirs, so it is never trimmed and never omitted when it
  // exists; an unmarked row spends nothing on it.
  handled_at?: string | null
  handled_seen_at?: string | null
  handled_seen_by?: string | null
}

export interface BoardSummary {
  title: string
  stream: string
  agent: string
  status: 'active' | 'archived'
  updated_at: string
  progress: Progress
  rows: RowSummary[]
}

/**
 * board_get() with NO title — the shape of "what are my boards". Titles, labels,
 * statuses, notes and the human's annotations; never row context. Naming a board
 * is what buys full rows.
 *
 * Absent fields are omitted rather than sent as ''/null: with 37 rows in one
 * project, `"note":""` and a four-field null annotation block on every unannotated
 * row is real money for zero information. An annotation that EXISTS is always
 * carried, in full, with the delivery stamps the human's card is showing.
 */
export function summariseBoard(b: BoardWithRows): BoardSummary {
  return {
    title: b.title,
    stream: b.stream,
    agent: b.agent,
    status: b.status,
    updated_at: b.updated_at,
    progress: b.progress,
    rows: b.rows.map(summariseRow),
  }
}

function summariseRow(r: BoardRow): RowSummary {
  const out: RowSummary = { label: r.label, status: r.status }
  if (r.note) out.note = r.note
  if (r.context) out.context_chars = r.context.length
  // the same predicate store.ts's withUnseen() uses for "this row has a note"
  if (r.annotation != null && r.annotation !== '') {
    out.annotation = r.annotation
    out.annotated_at = r.annotated_at
    out.annotation_seen_at = r.annotation_seen_at
    out.annotation_seen_by = r.annotation_seen_by
    out.annotation_unseen = r.annotation_unseen
  }
  // #36 — the mark is the human's word too, and it is the one fact that decides
  // what the agent does next ("the account exists now, go on"). A summary that
  // dropped it would send every agent back to board_get for it, which is the
  // round-trip this shape exists to avoid. No `annotation_unseen`-style derived
  // twin: `handled_at && !handled_seen_at` says undelivered on its own.
  if (r.handled_at) {
    out.handled_at = r.handled_at
    out.handled_seen_at = r.handled_seen_at
    out.handled_seen_by = r.handled_seen_by
  }
  return out
}
