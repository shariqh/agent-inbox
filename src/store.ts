import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdirSync } from 'node:fs'

export type Kind = 'question' | 'note' | 'done'
export type Status = 'open' | 'resolved' | 'dismissed'
// which channel the current answer came through: the human typed it into the
// inbox card, or an agent recorded what they said in chat (issue #29)
export type ReplySource = 'inbox' | 'agent'

// a proposed answer the agent attaches to a question; detail carries the
// tradeoffs shown in the viewer's compare view
export interface QuestionOption {
  label: string
  detail?: string
  recommended?: boolean
}

export interface Item {
  id: string
  project: string
  stream: string
  agent: string
  // The agent session that raised this item — lets the viewer tell whether the
  // asking agent is still alive (null on legacy rows and non-agent inserts).
  //
  // TWO ID SPACES LIVE IN THIS COLUMN. Normally it is an MCP session id (a
  // randomUUID minted in src/mcp.ts), which is also what `activity.session`
  // holds, so classifyLiveness can join them. A backstop item written by the
  // hooks runtime (src/hook.ts, issue #10) instead carries the *harness*
  // (Claude Code) session id, which is never in the activity table — so the
  // join always misses and the item can never classify 'waiting'. It gets
  // 'parked', and 'stale' once older than STALE_MS (72h); both are
  // non-escalating, which is the point. That degradation is deliberate and
  // load-bearing: a hook item can therefore never masquerade as a live blocked
  // agent or escalate a rail badge to red. Any future code that joins this
  // column against `activity` must know both spaces are here.
  session: string | null
  kind: Kind
  title: string
  detail: string
  context: string
  status: Status
  annotation: string | null
  options: QuestionOption[] | null
  reply: string | null
  reply_context: string | null
  replied_at: string | null
  reply_seen_at: string | null
  reply_source: ReplySource | null
  // issue #30 — the source-link identity inferred locally at write time:
  // `owner/name` for a github.com remote, and the issue number the BRANCH names.
  // Both null whenever the answer was not unambiguous, and null on every row
  // written before #30 (the additive migration backfills nothing — deliberately;
  // there is no way to know what a historical item's remote was).
  repo: string | null
  issue_ref: number | null
  created_at: string
  resolved_at: string | null
}

export interface NewItem {
  project: string
  stream: string
  agent: string
  session?: string
  kind: Kind
  title: string
  detail?: string
  context?: string
  options?: QuestionOption[]
  // optional on the WRITE shape: every pre-#30 call site passes neither
  repo?: string | null
  issue_ref?: number | null
}

export function defaultDbPath(): string {
  return process.env.AGENT_INBOX_DB ?? join(homedir(), '.agent-inbox', 'inbox.db')
}

export function openDb(path: string = defaultDbPath()): Database.Database {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  migrate(db)
  return db
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      stream TEXT NOT NULL DEFAULT '',
      agent TEXT NOT NULL DEFAULT 'unknown',
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      annotation TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_items_status_project ON items(status, project);
    CREATE INDEX IF NOT EXISTS idx_items_created ON items(created_at);
    CREATE TABLE IF NOT EXISTS boards (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      stream TEXT NOT NULL DEFAULT '',
      agent TEXT NOT NULL DEFAULT 'unknown',
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_read_at TEXT,
      UNIQUE(project, title)
    );
    CREATE TABLE IF NOT EXISTS board_rows (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL,
      label TEXT NOT NULL,
      status TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      context TEXT NOT NULL DEFAULT '',
      annotation TEXT,
      annotated_at TEXT,
      position INTEGER NOT NULL,
      UNIQUE(board_id, label)
    );
    CREATE INDEX IF NOT EXISTS idx_boards_status_project ON boards(status, project);
    CREATE INDEX IF NOT EXISTS idx_board_rows_board ON board_rows(board_id, position);
    CREATE TABLE IF NOT EXISTS activity (
      session TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      stream TEXT NOT NULL DEFAULT '',
      agent TEXT NOT NULL DEFAULT 'unknown',
      doing TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      children TEXT,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      ended_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_activity_live ON activity(ended_at, updated_at);
    CREATE TABLE IF NOT EXISTS projects (
      project TEXT PRIMARY KEY,
      closed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_items_project_created ON items(project, created_at);
    CREATE TABLE IF NOT EXISTS source_links (
      repo TEXT NOT NULL,
      branch TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'github',
      pr_number INTEGER,
      pr_url TEXT,
      pr_title TEXT,
      pr_state TEXT,
      pr_draft INTEGER,
      review_decision TEXT,
      checks TEXT,
      issue_number INTEGER,
      issue_url TEXT,
      issue_title TEXT,
      tldr TEXT,
      fetched_at TEXT,
      checked_at TEXT NOT NULL,
      error TEXT,
      PRIMARY KEY (repo, branch)
    );
  `)
  ensureColumn(db, 'board_rows', 'context', `TEXT NOT NULL DEFAULT ''`)
  ensureColumn(db, 'board_rows', 'annotated_at', 'TEXT')
  ensureColumn(db, 'boards', 'last_read_at', 'TEXT')
  ensureColumn(db, 'activity', 'idle', 'INTEGER NOT NULL DEFAULT 0')
  // issue #45 — the second activity stamp. NULL means "this session has not made
  // a tool call since the column existed": a brand-new presence row (registered
  // before the first call) and every row written by a server process still
  // running the old code. Both fall back to `started_at`, so a fresh connection
  // is never born cold and a days-old legacy claim is.
  ensureColumn(db, 'activity', 'last_call_at', 'TEXT')
  ensureColumn(db, 'items', 'context', `TEXT NOT NULL DEFAULT ''`)
  ensureColumn(db, 'items', 'options', 'TEXT')
  ensureColumn(db, 'items', 'reply', 'TEXT')
  ensureColumn(db, 'items', 'reply_context', 'TEXT')
  ensureColumn(db, 'items', 'replied_at', 'TEXT')
  ensureColumn(db, 'items', 'reply_seen_at', 'TEXT')
  ensureColumn(db, 'items', 'reply_source', 'TEXT')
  ensureColumn(db, 'items', 'session', 'TEXT')
  ensureColumn(db, 'items', 'repo', 'TEXT')
  ensureColumn(db, 'items', 'issue_ref', 'INTEGER')
  ensureColumn(db, 'boards', 'repo', 'TEXT')
  ensureColumn(db, 'boards', 'issue_ref', 'INTEGER')
  // issue #36 — the human's "I did my part" mark and its delivery mirror. Plain
  // additive columns: absence genuinely means "no value" (nobody has marked
  // anything), so unlike migrateAnnotationDelivery below there is nothing to
  // backfill and no flood to avoid.
  ensureColumn(db, 'board_rows', 'handled_at', 'TEXT')
  ensureColumn(db, 'board_rows', 'handled_seen_at', 'TEXT')
  ensureColumn(db, 'board_rows', 'handled_seen_by', 'TEXT')
  migrateAnnotationDelivery(db)
}

// Additive migration for DBs created before the column existed. Good enough for
// a column whose absence means "no value" — but NOT for one that needs seeding:
// a migration that must BACKFILL has to ask hasColumn() itself and put the ALTER
// and the UPDATE in ONE transaction, or a crash between them leaves the column
// present and permanently empty. migrateAnnotationDelivery is the worked example.
function ensureColumn(db: Database.Database, table: string, column: string, ddl: string): void {
  if (hasColumn(db, table, column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]
  return cols.some((c) => c.name === column)
}

// ── issue #37: board-level "read" → per-ROW "delivered" ──────────────────────
//
// `annotation_unseen` used to derive from BOARD-level `boards.last_read_at`, so
// one board_get marked every row's annotation seen — including rows the agent
// never looked at, and (title-less board_get) every board in the project at once.
// The per-row stamp is the honest model items already had via reply_seen_at.
//
// THE BACKFILL IS THE WHOLE RISK. Introduce the column NULL-for-all and every
// existing annotation reads as undelivered — so the first `pending()` poll hands
// week-old, already-superseded instructions ("merge it", "spec approved") to a
// live agent that will act on them. That is not a badge flood; it is an agent
// merging something. So the column is seeded from the EXACT inverse of the old
// withUnseen predicate, including its `annotated_at IS NULL` branch:
//   previously SEEN   → annotation_seen_at = the board's last_read_at (a real stamp)
//   previously UNSEEN → NULL, still deliverable
//
// ALTER + backfill are ONE transaction on purpose: a crash between them would
// leave the column present and empty forever, i.e. the flood, permanently, with
// no replay path. It runs inside migrate(), before any read path can touch it.
function migrateAnnotationDelivery(db: Database.Database): void {
  if (hasColumn(db, 'board_rows', 'annotation_seen_at')) {
    ensureColumn(db, 'board_rows', 'annotation_seen_by', 'TEXT')
    return
  }
  db.transaction(() => {
    db.exec(`ALTER TABLE board_rows ADD COLUMN annotation_seen_at TEXT`)
    if (!hasColumn(db, 'board_rows', 'annotation_seen_by')) db.exec(`ALTER TABLE board_rows ADD COLUMN annotation_seen_by TEXT`)
    db.exec(`
      UPDATE board_rows SET annotation_seen_at = (SELECT b.last_read_at FROM boards b WHERE b.id = board_rows.board_id)
       WHERE annotation IS NOT NULL AND annotation <> ''
         AND EXISTS (
           SELECT 1 FROM boards b
            WHERE b.id = board_rows.board_id
              AND b.last_read_at IS NOT NULL
              AND (board_rows.annotated_at IS NULL OR board_rows.annotated_at <= b.last_read_at))`)
  })()
}

export function insertItem(db: Database.Database, item: NewItem): string {
  // milestones are announcements — re-announcing the same open milestone
  // (agent retries, re-runs) must not stack duplicates
  if (item.kind === 'done') {
    const existing = db
      .prepare(`SELECT id FROM items WHERE kind = 'done' AND status = 'open' AND project = ? AND title = ?`)
      .get(item.project, item.title) as { id: string } | undefined
    if (existing) return existing.id
  }
  const id = randomUUID()
  db.prepare(
    `INSERT INTO items (id, project, stream, agent, session, kind, title, detail, context, options, repo, issue_ref, status, created_at)
     VALUES (@id, @project, @stream, @agent, @session, @kind, @title, @detail, @context, @options, @repo, @issue_ref, 'open', @created_at)`,
  ).run({
    id,
    project: item.project,
    stream: item.stream,
    agent: item.agent,
    session: item.session ?? null,
    kind: item.kind,
    title: item.title,
    detail: item.detail ?? '',
    context: item.context ?? '',
    options: item.options?.length ? JSON.stringify(item.options) : null,
    repo: item.repo ?? null,
    issue_ref: item.issue_ref ?? null,
    created_at: new Date().toISOString(),
  })
  return id
}

// Returns false when the write was refused, true otherwise — so a caller
// (the viewer's POST handler) can surface a refusal instead of a silent no-op.
export function replyItem(db: Database.Database, id: string, text: string, context?: string): boolean {
  // a changed answer resets pickup — the agent must see the latest reply;
  // an empty answer reverts the question to unanswered (null, never '') — but
  // ONLY when the agent has not already picked the current reply up. Once
  // reply_seen_at is set, blanking the reply would silently erase an answer
  // the agent may already have read and acted on; refuse instead of losing
  // it. This is the authoritative guard — a client-side freshness check alone
  // is a TOCTOU window, not a fix (a stale client snapshot can still read
  // reply_seen_at as null right up until the request lands here).
  const reply = text.trim()
  const replyContext = context?.trim() ?? ''
  if (!reply) {
    // atomic: the guard condition (reply_seen_at IS NULL) is checked and acted on in the
    // SAME statement as the write, so a concurrent markReplySeen from another connection
    // (e.g. the MCP server's `pending` handler, its own OS process) can never land in a
    // window between a read and a later, unconditional write — there is no such window.
    const info = db
      .prepare(`UPDATE items SET reply = NULL, reply_context = NULL, replied_at = ?, reply_seen_at = NULL, reply_source = NULL WHERE id = ? AND reply_seen_at IS NULL`)
      .run(new Date().toISOString(), id)
    return info.changes > 0
  }
  // unconditional by design: the inbox is the higher-precedence channel, so the
  // human's own reply overwrites anything an agent recorded from chat (#29) and
  // resets pickup so that agent has to read the new one.
  db.prepare(`UPDATE items SET reply = ?, reply_context = ?, replied_at = ?, reply_seen_at = NULL, reply_source = 'inbox' WHERE id = ?`)
    .run(reply, replyContext || null, new Date().toISOString(), id)
  return true
}

// Compare-and-swap on the answer's own version stamp, in ONE statement (issue
// #37). This used to be an unconditional `WHERE id = ?`, while replyItem resets
// reply_seen_at = NULL from the VIEWER's separate OS process: a reply the human
// revised between the agent's read and its stamp got marked picked up by an agent
// that never saw it, and no later pending() would ever return it. Bind the exact
// replied_at the read returned and check the return value — false means the human
// moved it under you, so leave it undelivered and let the next poll carry it.
//
// `IS`, not `=`: replied_at is NULL on an item that has never been answered
// (test/viewer.test.ts stamps exactly that shape), and `= NULL` is never true.
export function markReplySeen(db: Database.Database, id: string, repliedAt: string | null): boolean {
  const info = db
    .prepare(`UPDATE items SET reply_seen_at = ? WHERE id = ? AND reply_seen_at IS NULL AND replied_at IS ?`)
    .run(new Date().toISOString(), id, repliedAt)
  return info.changes > 0
}

export type AnswerRefusal = 'empty' | 'not_found' | 'not_a_question' | 'not_open' | 'unread_inbox_answer'

export interface AnswerResult {
  ok: boolean
  reason?: AnswerRefusal
  // on 'unread_inbox_answer': the answer that is waiting, so the caller can act
  // on it without a second round-trip
  reply?: string | null
  reply_context?: string | null
}

// The agent-side answer channel (#29): an agent records onto the item what the
// human told it in chat. The precedence rule lives entirely in this statement's
// WHERE clause — an inbox answer the agent has NOT picked up outranks a chat
// answer, so this refuses rather than clobbering it; the human's own replyItem
// stays unconditional and outranks everything. Both orderings converge on the
// inbox answer without comparing clocks.
//
// An agent may RECORD an answer but never ERASE one: blank text is refused here,
// and blanking stays the human's guarded prerogative in replyItem. It MAY
// overwrite a human answer it has already picked up (they said something newer
// out loud) — that case is pinned in test/store.test.ts.
export function answerItem(db: Database.Database, id: string, text: string, context?: string): AnswerResult {
  const reply = text.trim()
  if (!reply) return { ok: false, reason: 'empty' }
  const now = new Date().toISOString()
  // ONE conditioned UPDATE, never SELECT-then-UPDATE and never two UPDATEs: the
  // viewer writes to this same WAL file from its own OS process and can land a
  // reply between two statements. reply_seen_at = replied_at because the agent IS
  // the reader — rendering "waiting for agent pickup" for an answer it authored
  // itself would be a lie. Status stays 'open': recording is not resolving.
  const info = db
    .prepare(
      `UPDATE items SET reply = ?, reply_context = ?, replied_at = ?, reply_seen_at = ?, reply_source = 'agent'
       WHERE id = ? AND kind = 'question' AND status = 'open'
         AND (reply IS NULL OR reply = '' OR reply_seen_at IS NOT NULL)`,
    )
    .run(reply, context?.trim() || null, now, now, id)
  if (info.changes > 0) return { ok: true }
  // Diagnosis is advisory and deliberately runs AFTER the write. Reading first to
  // decide would reopen exactly the TOCTOU window the conditioned UPDATE closes;
  // since nothing was written, a concurrent change here can only make the
  // explanation stale, never the stored state wrong.
  const row = db.prepare(`SELECT kind, status, reply, reply_context FROM items WHERE id = ?`).get(id) as
    | { kind: Kind; status: Status; reply: string | null; reply_context: string | null }
    | undefined
  if (!row) return { ok: false, reason: 'not_found' }
  if (row.kind !== 'question') return { ok: false, reason: 'not_a_question' }
  if (row.status !== 'open') return { ok: false, reason: 'not_open' }
  return { ok: false, reason: 'unread_inbox_answer', reply: row.reply, reply_context: row.reply_context }
}

export function listPending(db: Database.Database, project: string): Item[] {
  const rows = db
    .prepare(`SELECT * FROM items WHERE status = 'open' AND kind = 'question' AND project = ? ORDER BY created_at ASC`)
    .all(project)
  return (rows as Array<Omit<Item, 'options'> & { options: string | null }>).map(parseItem)
}

function parseItem(row: Omit<Item, 'options'> & { options: string | null }): Item {
  return { ...row, options: row.options ? (JSON.parse(row.options) as QuestionOption[]) : null }
}

export function resolveItem(db: Database.Database, id: string): void {
  db.prepare(`UPDATE items SET status = 'resolved', resolved_at = ? WHERE id = ?`).run(new Date().toISOString(), id)
}

export function dismissItem(db: Database.Database, id: string): void {
  db.prepare(`UPDATE items SET status = 'dismissed' WHERE id = ?`).run(id)
}

export function annotateItem(db: Database.Database, id: string, text: string): void {
  db.prepare(`UPDATE items SET annotation = ? WHERE id = ?`).run(text, id)
}

export function listItems(db: Database.Database, opts: { status?: Status } = {}): Item[] {
  const rows = opts.status
    ? db.prepare(`SELECT * FROM items WHERE status = ? ORDER BY created_at DESC`).all(opts.status)
    : db.prepare(`SELECT * FROM items ORDER BY created_at DESC`).all()
  return (rows as Array<Omit<Item, 'options'> & { options: string | null }>).map(parseItem)
}

// 'blocked' = the row needs human input and escalates into the attention layer
export type RowStatus = 'done' | 'partial' | 'missing' | 'tracked' | 'na' | 'blocked'

export interface Board {
  id: string
  project: string
  stream: string
  agent: string
  title: string
  status: 'active' | 'archived'
  // issue #30 — same locally-inferred link identity items carry; null on every
  // board written before #30
  repo: string | null
  issue_ref: number | null
  created_at: string
  updated_at: string
  last_read_at: string | null
}

export interface BoardRow {
  id: string
  label: string
  status: RowStatus
  note: string
  context: string
  annotation: string | null
  annotated_at: string | null
  // issue #37 — DELIVERY, not acknowledgement: "this text was handed to some
  // agent", and who it went to. It silences nothing on the human's side; the row
  // stays blocked until an agent flips its status, which is the acknowledgement.
  annotation_seen_at: string | null
  annotation_seen_by: string | null
  // issue #36 — the human's OTHER answer on a blocked row: not words, but "I went
  // and did my part". Deliberately NOT called done: `status: 'done'` is the
  // AGENT's assertion that the row's work is finished, and only an agent may set
  // it. This says the human's half is finished and the row is now waiting on an
  // agent to acknowledge by flipping that status. Same delivery mirror as the
  // annotation, and for the same reason (#37): the age of `handled_seen_at` is
  // the evidence that an agent has known for three hours and done nothing.
  handled_at: string | null
  handled_seen_at: string | null
  handled_seen_by: string | null
  position: number
  annotation_unseen: boolean
}

type BoardRowRecord = Omit<BoardRow, 'annotation_unseen'>

const ROW_COLUMNS = `id, label, status, note, context, annotation, annotated_at, annotation_seen_at, annotation_seen_by, handled_at, handled_seen_at, handled_seen_by, position`

// An annotation is "unseen" until it has been DELIVERED to an agent. Per-row and
// nothing else: `boards.last_read_at` is deliberately not an input any more
// (issue #37 / #36). Two inputs would disagree the first time a row is stamped
// individually while a board is stamped wholesale, and the disagreement would be
// invisible — nothing renders last_read_at.
//
// #36's `handled_at` gets NO derived twin here on purpose. `annotation_unseen`
// exists because "is there text an agent has not been handed" cannot be read off
// `annotation` alone — it needs the emptiness rule above. The mark has no such
// rule: `handled_at != null && handled_seen_at == null` says it exactly, and one
// less derived field is one less thing that can disagree with its own inputs.
function withUnseen(rows: BoardRowRecord[]): BoardRow[] {
  return rows.map((r) => ({
    ...r,
    annotation_unseen: r.annotation != null && r.annotation !== '' && r.annotation_seen_at === null,
  }))
}

export interface Progress {
  done: number
  partial: number
  missing: number
  tracked: number
  na: number
  blocked: number
  total: number
  countable: number
  fraction: number
}

export interface BoardWithRows extends Board {
  rows: BoardRow[]
  progress: Progress
}

export interface NewBoardRow {
  label: string
  status: RowStatus
  note?: string
  context?: string
}

export function findBoard(db: Database.Database, project: string, title: string): Board | undefined {
  return db.prepare(`SELECT * FROM boards WHERE project = ? AND title = ?`).get(project, title) as Board | undefined
}

interface UpsertBoardInput {
  project: string
  stream: string
  agent: string
  title: string
  rows: NewBoardRow[]
  // optional on the WRITE shape: every pre-#30 call site passes neither
  repo?: string | null
  issueRef?: number | null
}

export function upsertBoard(db: Database.Database, input: UpsertBoardInput): { boardId: string; rowCount: number } {
  const run = db.transaction((inp: UpsertBoardInput): { boardId: string; rowCount: number } => {
    const now = new Date().toISOString()
    const boardId = ensureBoard(db, inp, now)
    const existing = db.prepare(`SELECT id, label, status FROM board_rows WHERE board_id = ?`).all(boardId) as { id: string; label: string; status: RowStatus }[]
    const idByLabel = new Map(existing.map((r) => [r.label, r]))
    const incoming = new Set<string>()
    inp.rows.forEach((r, i) => {
      incoming.add(r.label)
      const prev = idByLabel.get(r.label)
      if (prev) {
        const existingId = prev.id
        // annotation column is deliberately NOT touched — human notes survive
        db.prepare(`UPDATE board_rows SET status = ?, note = ?, position = ? WHERE id = ?`).run(r.status, r.note ?? '', i, existingId)
        resetHandledOnReblock(db, existingId, prev.status, r.status)
        // OMITTING `context` KEEPS WHAT IS STORED; only an explicit '' clears it
        // (issue #42). The rule that a row ABSENT from an upsert is deleted is
        // about ROWS and is untouched — this is about a FIELD, and omission is
        // not deletion. It matters because the prescribed flow is read-then-
        // re-upsert (`board_get` → `board_upsert`) and MCP reads no longer carry
        // `context` at all: an agent re-sending exactly what it was handed would
        // wipe every row's backstory. `note` still clears on omission, and that
        // asymmetry is deliberate — a read hands `note` back, so leaving it out
        // is a choice the agent can actually make; it cannot make that choice
        // about text it was never given.
        if (r.context !== undefined) db.prepare(`UPDATE board_rows SET context = ? WHERE id = ?`).run(r.context, existingId)
      } else {
        db.prepare(`INSERT INTO board_rows (id, board_id, label, status, note, context, position) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(randomUUID(), boardId, r.label, r.status, r.note ?? '', r.context ?? '', i)
      }
    })
    for (const r of existing) if (!incoming.has(r.label)) db.prepare(`DELETE FROM board_rows WHERE id = ?`).run(r.id)
    syncBoardStatus(db, boardId)
    return { boardId, rowCount: inp.rows.length }
  })
  return run(input)
}

interface UpdateRowInput {
  project: string
  stream: string
  agent: string
  title: string
  label: string
  status?: RowStatus
  note?: string
  context?: string
  repo?: string | null
  issueRef?: number | null
}

export function updateBoardRow(db: Database.Database, input: UpdateRowInput): { boardId: string; rowId: string } {
  const run = db.transaction((inp: UpdateRowInput): { boardId: string; rowId: string } => {
    const now = new Date().toISOString()
    const boardId = ensureBoard(db, inp, now)
    const existing = db.prepare(`SELECT id, status FROM board_rows WHERE board_id = ? AND label = ?`).get(boardId, inp.label) as { id: string; status: RowStatus } | undefined
    if (existing) {
      if (inp.status !== undefined) {
        db.prepare(`UPDATE board_rows SET status = ? WHERE id = ?`).run(inp.status, existing.id)
        resetHandledOnReblock(db, existing.id, existing.status, inp.status)
      }
      if (inp.note !== undefined) db.prepare(`UPDATE board_rows SET note = ? WHERE id = ?`).run(inp.note, existing.id)
      if (inp.context !== undefined) db.prepare(`UPDATE board_rows SET context = ? WHERE id = ?`).run(inp.context, existing.id)
      syncBoardStatus(db, boardId)
      return { boardId, rowId: existing.id }
    }
    const rowId = randomUUID()
    const pos = (db.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM board_rows WHERE board_id = ?`).get(boardId) as { p: number }).p
    db.prepare(`INSERT INTO board_rows (id, board_id, label, status, note, context, position) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(rowId, boardId, inp.label, inp.status ?? 'tracked', inp.note ?? '', inp.context ?? '', pos)
    syncBoardStatus(db, boardId)
    return { boardId, rowId }
  })
  return run(input)
}

// After every agent write, a board's active/archived status follows its
// completeness: 100% (with countable rows) → archived immediately (the human's
// chosen lifecycle); anything less → active, which also resurrects an archived
// board the agent is still writing to (the "flickered to 100% mid-update" case).
function syncBoardStatus(db: Database.Database, boardId: string): void {
  const rows = db.prepare(`SELECT status FROM board_rows WHERE board_id = ?`).all(boardId) as { status: RowStatus }[]
  const p = computeProgress(rows as BoardRow[])
  const complete = p.countable > 0 && p.fraction === 1
  db.prepare(`UPDATE boards SET status = ?, updated_at = ? WHERE id = ?`)
    .run(complete ? 'archived' : 'active', new Date().toISOString(), boardId)
}

// Find-or-create the board row and stamp the last writer. Shared by upsertBoard/updateBoardRow.
function ensureBoard(
  db: Database.Database,
  inp: { project: string; stream: string; agent: string; title: string; repo?: string | null; issueRef?: number | null },
  now: string,
): string {
  const board = findBoard(db, inp.project, inp.title)
  // #30's repo/issue_ref are restamped on every write, exactly like stream and
  // agent — the board follows whoever is writing to it now. They belong on the
  // `boards` row and nowhere near board_rows, whose annotation column is the
  // human's and must survive every re-upsert untouched.
  if (board) {
    db.prepare(`UPDATE boards SET stream = ?, agent = ?, repo = ?, issue_ref = ?, updated_at = ? WHERE id = ?`)
      .run(inp.stream, inp.agent, inp.repo ?? null, inp.issueRef ?? null, now, board.id)
    return board.id
  }
  const boardId = randomUUID()
  db.prepare(`INSERT INTO boards (id, project, stream, agent, title, repo, issue_ref, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
    .run(boardId, inp.project, inp.stream, inp.agent, inp.title, inp.repo ?? null, inp.issueRef ?? null, now, now)
  return boardId
}

export function archiveBoard(db: Database.Database, boardId: string): void {
  db.prepare(`UPDATE boards SET status = 'archived', updated_at = ? WHERE id = ?`).run(new Date().toISOString(), boardId)
}

export function unarchiveBoard(db: Database.Database, boardId: string): void {
  db.prepare(`UPDATE boards SET status = 'active', updated_at = ? WHERE id = ?`).run(new Date().toISOString(), boardId)
}

// New text resets delivery IN THE SAME STATEMENT that writes it (the replyItem
// invariant, for rows). Split them and a re-annotation of an already-delivered
// row inherits the old stamp and is never handed to anyone.
export function annotateBoardRow(db: Database.Database, rowId: string, text: string): void {
  db.prepare(`UPDATE board_rows SET annotation = ?, annotated_at = ?, annotation_seen_at = NULL, annotation_seen_by = NULL WHERE id = ?`)
    .run(text, new Date().toISOString(), rowId)
}

// ── issue #36: the human's "I did my part" mark ─────────────────────────────
//
// WHY IT IS NOT A STATUS. Every `blocked` row in the wild turned out to be a
// TASK — "create the Paddle account", "register the Notion integration",
// "record the hero demo" — not a question. Agents use `blocked` exactly as the
// rule says (it needs the human), but the only lever the viewer offered was a
// free-text box: a task does not want words, it wants DONE. `status: 'done'` is
// the agent's assertion about the ROW's work and only agents may write it, so
// the human's half needed its own field. This is that field.
//
// THE INVARIANT: `upsertBoard` can never clear it, exactly like `annotation`.
// The prescribed agent flow is a full-table re-send, so "any write mentioning
// this row drops the mark" would erase the human's action on every routine
// refresh — the omitted-field-means-delete failure #42 had to fix at the root,
// wearing a different hat.
export function markRowHandled(db: Database.Database, rowId: string): boolean {
  // New mark, new delivery — the same statement, for annotateBoardRow's reason:
  // split them and a re-mark on an already-delivered row inherits the old stamp
  // and reads "delivered" to the human before anyone has been told.
  const info = db
    .prepare(`UPDATE board_rows SET handled_at = ?, handled_seen_at = NULL, handled_seen_by = NULL WHERE id = ?`)
    .run(new Date().toISOString(), rowId)
  return info.changes > 0
}

// The undo, and the ONLY thing that can take the mark back. Guarded in the SAME
// statement it writes (replyItem's blank-guard precedent, not a read-then-write):
// the MCP server stamps delivery from its own OS process, so a check up here
// would be a TOCTOU window rather than a guard. `false` = an agent has already
// been handed the mark — un-marking cannot un-tell them, so refuse and let the
// caller say so out loud instead of pretending it worked.
//
// It does NOT require the mark to still be there: clearing an already-clear row
// reports success, so two tabs (or a double click) can never turn a harmless
// repeat into a "somebody picked this up" lie.
export function clearRowHandled(db: Database.Database, rowId: string): boolean {
  const info = db
    .prepare(`UPDATE board_rows SET handled_at = NULL, handled_seen_at = NULL, handled_seen_by = NULL
               WHERE id = ? AND handled_seen_at IS NULL`)
    .run(rowId)
  return info.changes > 0
}

// markAnnotationDelivered's twin, same COALESCE (the stamp records the FIRST
// delivery and never moves, because its AGE is the evidence the human's card
// shows) and same version pin (the viewer can re-mark from another process
// between an agent's read and its stamp).
//
// Stricter in one place: `handled_at IS NOT NULL`. markAnnotationDelivered
// deliberately tolerates a NULL pin because real pre-`annotated_at` rows exist in
// the wild; this column has no legacy, so a NULL pin can only mean "you are
// stamping a row that carries no mark" and is refused.
export function markHandledDelivered(
  db: Database.Database,
  rowId: string,
  handledAt: string | null,
  by: string | null,
): boolean {
  const info = db
    .prepare(`UPDATE board_rows SET handled_seen_at = COALESCE(handled_seen_at, ?),
                                    handled_seen_by = COALESCE(handled_seen_by, ?)
               WHERE id = ? AND handled_at IS NOT NULL AND handled_at IS ?`)
    .run(new Date().toISOString(), by, rowId, handledAt)
  return info.changes > 0
}

// The ONE rule that decides when the human's mark dies: a NEW ask, and nothing
// else — a row that was NOT blocked and now is. Re-sending a row that is already
// blocked is not an acknowledgement (both board tool descriptions say so) and
// must therefore not reset anything, or every routine full-table refresh would
// quietly undo the human's action. Flipping the status is the acknowledgement;
// blocking it again afterwards is a fresh request, so it starts from nothing.
function resetHandledOnReblock(db: Database.Database, rowId: string, prev: RowStatus, next: RowStatus): void {
  if (next !== 'blocked' || prev === 'blocked') return
  db.prepare(`UPDATE board_rows SET handled_at = NULL, handled_seen_at = NULL, handled_seen_by = NULL WHERE id = ?`).run(rowId)
}

// The rows-shaped twin of markReplySeen, version-pinned for the same reason: the
// viewer writes annotations from its own OS process, so a SELECT-then-UPDATE
// would stamp text that no longer exists and bury the human's newest instruction
// forever. ONE statement, pinning the exact version the caller read.
//
// It is NOT markReplySeen's exact shape, and the difference is deliberate. That
// one also carries `AND reply_seen_at IS NULL`, so it stamps once and reports
// whether it won. This one drops that clause (see COALESCE below) because for
// rows a second delivery is the normal case, not a lost race.
//
// The return value means EXACTLY ONE THING: the text you read is still the text
// that is there, so it is safe to hand over. `false` = the human replaced it
// under you — drop it, and the newer text stays queued. It deliberately does NOT
// mean "you were the first reader": since rows became at-least-once (F1 below),
// a re-delivery is normal and must not be mistaken for a lost race.
//
// COALESCE, not a plain SET, is what keeps those two apart. The stamp records the
// FIRST delivery and never moves, because its age is what the human's chip shows
// ("delivered to claude-code 3h ago") — and that age is the evidence that an
// agent has had the answer for three hours and done nothing. Re-stamping every
// poll would make it read "delivered moments ago" forever and hide precisely the
// failure it exists to show.
//
// `IS`, not `=`: annotated_at is NULL on rows written before that column existed
// (real ones exist in the wild), and `annotated_at = NULL` is never true — a `=`
// pin would leave every legacy annotation unstampable, so it would never earn a
// "delivered to" attribution at all.
export function markAnnotationDelivered(
  db: Database.Database,
  rowId: string,
  annotatedAt: string | null,
  by: string | null,
): boolean {
  const info = db
    .prepare(`UPDATE board_rows SET annotation_seen_at = COALESCE(annotation_seen_at, ?),
                                    annotation_seen_by = COALESCE(annotation_seen_by, ?)
               WHERE id = ? AND annotated_at IS ?`)
    .run(new Date().toISOString(), by, rowId, annotatedAt)
  return info.changes > 0
}

// DECORATION since issue #37: "when did an agent last read this board" is a
// legitimate fact and the annotation-delivery migration's only input (dropping
// the column would make that backfill unreplayable), so it stays and keeps being
// written — but it no longer marks anything seen. Nothing outside store.ts has
// ever CONSUMED it; it is merely carried along in the board payload.
export function markBoardRead(db: Database.Database, boardId: string): void {
  db.prepare(`UPDATE boards SET last_read_at = ? WHERE id = ?`).run(new Date().toISOString(), boardId)
}

// ── issue #37: the delivery queue for what the human said on a board row ────
//
// The human's per-row note used to be reachable only by an agent independently
// choosing to call board_get — guidance in a document, not a delivery mechanism.
// This is what `pending()` adds to its payload, project-scoped exactly as items
// are, so every agent already polling picks them up with no new discipline.
//
// It carries BOTH shapes the human can answer a row in (issue #36): the
// `annotation` (words) and the `handled_at` mark (they went and DID it). A mark
// the agent cannot see is the same dead end as an undeliverable note, so the two
// ride the same queue and the same at-least-once rule below.
//
// ACTIVE boards only, matching board_get (getBoard returns undefined for an
// archived board). syncBoardStatus auto-archives a board the moment it hits 100%,
// so an annotation on a completed board stays where the human left it rather than
// being re-delivered out of context.
//
// GATED ON THE ACKNOWLEDGEMENT, NOT ON THE DELIVERY STAMP — this is F1, and it is
// what makes rows AT-LEAST-ONCE like items instead of at-most-once. `listPending`
// keeps returning an answered question until the agent `resolve`s it; gating rows
// on `annotation_seen_at` instead meant the human's note went to exactly ONE poll
// from ONE session. This repo fans out subagents constantly, so a sibling's
// incidental poll silently ate the answer, the session that RAISED the row never
// received it, and the human's screen then read "delivered to claude-code" — the
// one signal that tells them to stop chasing it. The same window opened on a
// crash or client timeout between the stamp and the response.
//
// So: a row is pending while it is UNACKNOWLEDGED — some part of what the human
// left has not been handed over, OR it is still `blocked`. `blocked` is exactly the state the human is
// still looking at (public/attention.js keeps an annotated blocked row on screen
// in the awaiting-pickup foot until an agent flips it), so the agent's queue and
// the human's screen now go quiet on the SAME event. One rule, both surfaces.
//
// The two halves are deliberate, not a special case:
//   · blocked   → the human is waiting on you. Re-delivered until you flip the
//                 status with board_row, which IS the acknowledgement. An agent
//                 that acted without flipping keeps being told — and so does the
//                 human, who still sees the row. Neither is silently dropped.
//   · anything  → nothing to acknowledge; the note is an aside, not an answer.
//     else        Handed over once, then it stays put. Without this half a
//                 months-old aside on a live board would be a permanent firehose.
// The payload carries the delivery stamp so a re-delivery is self-labelling: an
// agent polling every few seconds can tell "new to me" from "I already have this".
export interface PendingRow {
  board_id: string
  board_title: string
  project: string
  stream: string
  agent: string
  row_id: string
  label: string
  status: RowStatus
  note: string
  context: string
  // NULLABLE since #36: a row can reach this queue carrying only the human's
  // `handled_at` mark and no words at all. An agent that keys on `annotation`
  // being a string would then silently skip the very thing it is being told.
  annotation: string | null
  annotated_at: string | null
  annotation_seen_at: string | null
  annotation_seen_by: string | null
  handled_at: string | null
  handled_seen_at: string | null
  handled_seen_by: string | null
}

export function listPendingRows(db: Database.Database, project: string): PendingRow[] {
  return db
    .prepare(
      `SELECT b.id AS board_id, b.title AS board_title, b.project AS project, b.stream AS stream, b.agent AS agent,
              r.id AS row_id, r.label AS label, r.status AS status, r.note AS note, r.context AS context,
              r.annotation AS annotation, r.annotated_at AS annotated_at,
              r.annotation_seen_at AS annotation_seen_at, r.annotation_seen_by AS annotation_seen_by,
              r.handled_at AS handled_at, r.handled_seen_at AS handled_seen_at, r.handled_seen_by AS handled_seen_by
         FROM board_rows r JOIN boards b ON b.id = r.board_id
        WHERE b.project = ? AND b.status = 'active'
          AND ((r.annotation IS NOT NULL AND r.annotation <> '') OR r.handled_at IS NOT NULL)
          AND (r.status = 'blocked'
               OR (r.annotation IS NOT NULL AND r.annotation <> '' AND r.annotation_seen_at IS NULL)
               OR (r.handled_at IS NOT NULL AND r.handled_seen_at IS NULL))
        ORDER BY b.updated_at DESC, r.position ASC`,
    )
    .all(project) as PendingRow[]
}

export function computeProgress(rows: BoardRow[]): Progress {
  const counts = { done: 0, partial: 0, missing: 0, tracked: 0, na: 0, blocked: 0 }
  for (const r of rows) counts[r.status]++
  const total = rows.length
  const countable = total - counts.na
  const fraction = countable > 0 ? (counts.done + 0.5 * counts.partial) / countable : 0
  return { ...counts, total, countable, fraction }
}

export function listBoards(db: Database.Database, opts: { status?: 'active' | 'archived' } = {}): BoardWithRows[] {
  const status = opts.status ?? 'active'
  const boards = db.prepare(`SELECT * FROM boards WHERE status = ? ORDER BY updated_at DESC`).all(status) as Board[]
  const rowStmt = db.prepare(`SELECT ${ROW_COLUMNS} FROM board_rows WHERE board_id = ? ORDER BY position ASC`)
  return boards.map((b) => {
    const rows = withUnseen(rowStmt.all(b.id) as BoardRowRecord[])
    return { ...b, rows, progress: computeProgress(rows) }
  })
}

// ── live activity: ephemeral presence, one row per session ──────────────────

export interface ActivityChild {
  name: string
  doing: string
  state?: string
}

export interface Activity {
  session: string
  project: string
  stream: string
  agent: string
  doing: string
  detail: string
  children: ActivityChild[]
  idle: boolean
  started_at: string
  updated_at: string
  /** last REAL MCP call (issue #45). NULL until this session makes one. */
  last_call_at: string | null
}

export interface ActivityUpdate {
  session: string
  project: string
  stream: string
  agent: string
  doing: string
  detail?: string
  children?: ActivityChild[]
  idle?: boolean
  /**
   * Is this write SPEAKING FOR THE AGENT, or merely saying the session is here?
   *
   * Default `true` — CLAIMING — and that half is unchanged: `status({doing})`
   * asserts a claim and `status({done:true})` legitimately revokes one back to
   * `doing: 'open'`, so both must overwrite whatever was there.
   *
   * `false` — REGISTERING — is the presence path in src/mcp.ts, which runs on the
   * initialize handshake AND on an unconditional 2-second fallback. It refreshes
   * scope, `updated_at` and `ended_at` only; `doing`, `detail`, `children` and
   * `idle` are left exactly as the agent last set them. Without this, a
   * `status({doing})` made in a session's first two seconds was wiped by the
   * fallback two seconds later.
   */
  claim?: boolean
}

export function upsertActivity(db: Database.Database, a: ActivityUpdate): void {
  const now = new Date().toISOString()
  // One statement, two modes: on a fresh row the INSERT is identical either way
  // (there is no claim to protect yet); the CASEs only bite on conflict, which
  // is the whole point — registration must never speak over a live claim.
  db.prepare(
    `INSERT INTO activity (session, project, stream, agent, doing, detail, children, idle, started_at, updated_at)
     VALUES (@session, @project, @stream, @agent, @doing, @detail, @children, @idle, @now, @now)
     ON CONFLICT(session) DO UPDATE SET
       project = @project, stream = @stream, agent = @agent,
       doing    = CASE WHEN @claim = 1 THEN @doing ELSE doing END,
       detail   = CASE WHEN @claim = 1 THEN COALESCE(NULLIF(@detail, ''), detail) ELSE detail END,
       children = CASE WHEN @claim = 1 THEN COALESCE(@children, children) ELSE children END,
       idle     = CASE WHEN @claim = 1 THEN @idle ELSE idle END,
       updated_at = @now, ended_at = NULL`,
  ).run({
    session: a.session,
    project: a.project,
    stream: a.stream,
    agent: a.agent,
    doing: a.doing,
    detail: a.detail ?? '',
    children: a.children ? JSON.stringify(a.children) : null,
    idle: a.idle ? 1 : 0,
    claim: a.claim === false ? 0 : 1,
    now,
  })
  // housekeeping: rows dead (ended or silent) for over a day serve no one
  const dayAgo = new Date(Date.now() - 24 * 60 * 60000).toISOString()
  db.prepare(`DELETE FROM activity WHERE (ended_at IS NOT NULL AND ended_at < ?) OR updated_at < ?`).run(dayAgo, dayAgo)
}

export function endActivity(db: Database.Database, session: string): void {
  db.prepare(`UPDATE activity SET ended_at = ? WHERE session = ?`).run(new Date().toISOString(), session)
}

// heartbeat: keep a live session's row from going stale without changing it.
// LIVENESS ONLY (issue #45) — this is what the 5-minute timer in src/mcp.ts
// calls, and it must never touch `last_call_at`, or the two stamps collapse back
// into one and a `doing` claim becomes immortal again.
export function touchActivity(db: Database.Database, session: string): void {
  db.prepare(`UPDATE activity SET updated_at = ? WHERE session = ? AND ended_at IS NULL`).run(new Date().toISOString(), session)
}

// ── issue #45: how long a `doing` claim outlives its last real MCP call ──────
//
// 30 minutes, and the number is a floor on "silent but genuinely working", not a
// guess at "idle". An agent can work for a long stretch without touching this
// server at all — a 10-minute test run, a build, a heads-down edit loop — and a
// claim killed under a session that is still working is a new lie, so the
// threshold is deliberately generous: 6x the heartbeat interval, comfortably past
// the longest single Bash timeout, and past any fan-out gap (a subagent's calls
// are served by the parent CLI's process, so siblings bump this same row). What
// it buys is a bound: the claim can be wrong for half an hour instead of days,
// and any `status({doing})` re-asserts it instantly.
export const CLAIM_COLD_MS = 30 * 60000

const claimCutoff = (nowMs: number): string => new Date(nowMs - CLAIM_COLD_MS).toISOString()

// A REAL tool call: proof the agent is doing something, not just running.
//
// It writes both stamps, and it is also where a claim that already went cold is
// CLEARED rather than renewed. That half is not optional: decaying only on read
// would let any later poll re-list a two-day-old `doing` as live work, which is
// exactly the observed failure — the stale rows belonged to CLIs that were still
// calling. Expressed as one conditional UPDATE (never SELECT-then-UPDATE) so the
// clear and the stamp cannot be split.
export function recordActivityCall(db: Database.Database, session: string): void {
  const now = new Date().toISOString()
  const cold = claimCutoff(Date.now())
  db.prepare(
    `UPDATE activity SET
       doing    = CASE WHEN COALESCE(last_call_at, started_at) < @cold THEN 'open' ELSE doing END,
       detail   = CASE WHEN COALESCE(last_call_at, started_at) < @cold THEN ''     ELSE detail END,
       children = CASE WHEN COALESCE(last_call_at, started_at) < @cold THEN NULL   ELSE children END,
       idle     = CASE WHEN COALESCE(last_call_at, started_at) < @cold THEN 1      ELSE idle END,
       last_call_at = @now,
       updated_at = @now
     WHERE session = @session AND ended_at IS NULL`,
  ).run({ session, now, cold })
}

export function listActivity(db: Database.Database, opts: { staleMinutes?: number } = {}): Activity[] {
  const now = Date.now()
  const cutoff = new Date(now - (opts.staleMinutes ?? 15) * 60000).toISOString()
  const cold = claimCutoff(now)
  const rows = db
    .prepare(`SELECT session, project, stream, agent, doing, detail, children, idle, started_at, updated_at, last_call_at
              FROM activity WHERE ended_at IS NULL AND updated_at >= ?`)
    .all(cutoff) as Array<Omit<Activity, 'children' | 'idle'> & { children: string | null; idle: number }>
  // The row is kept whatever happens here — the session really is present, and
  // public/attention.js classifies an item as "waiting" iff its session id is in
  // this list, so dropping the row would silently downgrade a live blocker. Only
  // the CLAIM decays.
  const out = rows.map((r): Activity => {
    const live = (r.last_call_at ?? r.started_at) >= cold
    return {
      ...r,
      idle: live ? r.idle === 1 : true,
      doing: live ? r.doing : 'open',
      detail: live ? r.detail : '',
      children: live && r.children ? (JSON.parse(r.children) as ActivityChild[]) : [],
    }
  })
  // Working sessions first (longest-running first, as before). Everything else
  // sorts by how recently it actually did something, so the terminal somebody
  // left open on Tuesday sits at the bottom of the fold instead of the top.
  const lastActive = (a: Activity): string => a.last_call_at ?? a.started_at
  return out.sort((a, b) => {
    if (a.idle !== b.idle) return a.idle ? 1 : -1
    if (a.idle) return lastActive(a) < lastActive(b) ? 1 : lastActive(a) > lastActive(b) ? -1 : 0
    return a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : 0
  })
}

export function getBoard(db: Database.Database, project: string, title: string): BoardWithRows | undefined {
  const board = findBoard(db, project, title)
  if (!board || board.status !== 'active') return undefined
  const rows = withUnseen(
    db.prepare(`SELECT ${ROW_COLUMNS} FROM board_rows WHERE board_id = ? ORDER BY position ASC`).all(board.id) as BoardRowRecord[],
  )
  return { ...board, rows, progress: computeProgress(rows) }
}

// ── source links: the cached live PR state, one row per (repo, branch) (#30) ──
//
// Written ONLY by the viewer process (src/prstate.ts, which shells out to `gh`);
// read by the viewer's /api/links and joined in the frontend against each item's
// own repo + stream. Keyed per BRANCH rather than per item so N items raised on
// one branch cost one `gh` call, and a merge updates all of them at once.

export interface SourceLink {
  repo: string
  branch: string
  provider: string
  pr_number: number | null
  pr_url: string | null
  pr_title: string | null
  pr_state: string | null
  pr_draft: boolean
  review_decision: string | null
  checks: string | null
  issue_number: number | null
  issue_url: string | null
  issue_title: string | null
  tldr: string | null
  // when the last SUCCESSFUL fetch landed vs when we last tried at all — the
  // gap between them is exactly how stale a still-rendered good row is
  fetched_at: string | null
  checked_at: string
  error: string | null
}

export interface NewSourceLink {
  repo: string
  branch: string
  provider?: string
  pr_number?: number | null
  pr_url?: string | null
  pr_title?: string | null
  pr_state?: string | null
  pr_draft?: boolean
  review_decision?: string | null
  checks?: string | null
  issue_number?: number | null
  issue_url?: string | null
  issue_title?: string | null
  tldr?: string | null
}

export interface LinkTarget {
  repo: string
  branch: string
}

// a cache row unchecked for this long belongs to a branch nobody works on
const LINK_TTL_DAYS = 30
// hard ceiling on how many branches one refresh pass can ever consider
const MAX_LINK_TARGETS = 50

// A successful fetch: writes every field, stamps BOTH timestamps and clears the
// error. Housekeeping rides along, mirroring upsertActivity's day-old sweep.
export function upsertSourceLink(db: Database.Database, link: NewSourceLink): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO source_links (repo, branch, provider, pr_number, pr_url, pr_title, pr_state, pr_draft,
       review_decision, checks, issue_number, issue_url, issue_title, tldr, fetched_at, checked_at, error)
     VALUES (@repo, @branch, @provider, @pr_number, @pr_url, @pr_title, @pr_state, @pr_draft,
       @review_decision, @checks, @issue_number, @issue_url, @issue_title, @tldr, @now, @now, NULL)
     ON CONFLICT(repo, branch) DO UPDATE SET
       provider = @provider, pr_number = @pr_number, pr_url = @pr_url, pr_title = @pr_title,
       pr_state = @pr_state, pr_draft = @pr_draft, review_decision = @review_decision, checks = @checks,
       issue_number = @issue_number, issue_url = @issue_url, issue_title = @issue_title, tldr = @tldr,
       fetched_at = @now, checked_at = @now, error = NULL`,
  ).run({
    repo: link.repo,
    branch: link.branch,
    provider: link.provider ?? 'github',
    pr_number: link.pr_number ?? null,
    pr_url: link.pr_url ?? null,
    pr_title: link.pr_title ?? null,
    pr_state: link.pr_state ?? null,
    pr_draft: link.pr_draft ? 1 : 0,
    review_decision: link.review_decision ?? null,
    checks: link.checks ?? null,
    issue_number: link.issue_number ?? null,
    issue_url: link.issue_url ?? null,
    issue_title: link.issue_title ?? null,
    tldr: link.tldr ?? null,
    now,
  })
  pruneSourceLinks(db)
}

// A FAILED fetch: touches checked_at and error and NOTHING else, so a laptop
// going offline can never blank a good cached row — the human keeps seeing the
// merged PR they saw a minute ago, with an honest "checked N ago" beside it.
// Every column except repo/branch/checked_at is nullable precisely so this
// INSERT half can succeed for a branch that has never been fetched.
export function recordLinkFailure(db: Database.Database, f: { repo: string; branch: string; error: string }): void {
  db.prepare(
    `INSERT INTO source_links (repo, branch, checked_at, error) VALUES (@repo, @branch, @now, @error)
     ON CONFLICT(repo, branch) DO UPDATE SET checked_at = @now, error = @error`,
  ).run({ repo: f.repo, branch: f.branch, error: f.error, now: new Date().toISOString() })
}

export function listSourceLinks(db: Database.Database): SourceLink[] {
  const rows = db.prepare(`SELECT * FROM source_links ORDER BY repo ASC, branch ASC`).all() as Array<
    Omit<SourceLink, 'pr_draft'> & { pr_draft: number | null }
  >
  return rows.map((r) => ({ ...r, pr_draft: r.pr_draft === 1 }))
}

// Which (repo, branch) pairs are worth spending a `gh` call on: the branches
// OPEN items and ACTIVE boards actually sit on. A resolved item's branch stops
// being refreshed but keeps whatever it last cached.
//
// #32 × #30: a project the human CLOSED is retired from the poller too — it kept
// spawning a `gh` subprocess every 60s and kept eating the shared per-tick budget,
// diluting the refresh rate for projects still in use. Its cached chips survive
// untouched, so a peek still shows what it last knew. The closed set is DERIVED,
// so this asks closedProjects() rather than reading closed_at: a project that
// un-closed itself when an agent flagged in it resumes polling with no other
// change. A branch a closed project SHARES with a live one keeps being refreshed —
// the live project is still rendering that chip.
export function listLinkTargets(db: Database.Database): LinkTarget[] {
  const rows = db
    .prepare(
      `SELECT project, repo, stream AS branch FROM items  WHERE status = 'open'   AND repo IS NOT NULL AND repo <> '' AND stream <> ''
       UNION
       SELECT project, repo, stream AS branch FROM boards WHERE status = 'active' AND repo IS NOT NULL AND repo <> '' AND stream <> ''
       ORDER BY repo ASC, branch ASC`,
    )
    .all() as Array<LinkTarget & { project: string }>
  const closed = new Set(closedProjects(db))
  // the UNION dedupes on (project, repo, branch); (repo, branch) is the cache key,
  // so the collapse to one target per pair happens here instead
  const seen = new Set<string>()
  const targets: LinkTarget[] = []
  for (const row of rows) {
    if (closed.has(row.project)) continue
    const key = `${row.repo}\u0000${row.branch}`
    if (seen.has(key)) continue
    seen.add(key)
    targets.push({ repo: row.repo, branch: row.branch })
  }
  return targets.slice(0, MAX_LINK_TARGETS)
}

export function pruneSourceLinks(db: Database.Database, opts: { nowMs?: number } = {}): void {
  const cutoff = new Date((opts.nowMs ?? Date.now()) - LINK_TTL_DAYS * 24 * 60 * 60000).toISOString()
  db.prepare(`DELETE FROM source_links WHERE checked_at < ?`).run(cutoff)
}

// ── project closure: retiring a dead project tab without losing it (issue #32) ──
//
// Sparse by design: a row exists ONLY for a project the human explicitly closed.
// Closing is PRESENTATION ONLY — nothing is deleted, no item or board is touched,
// and every one of them comes straight back the moment the project is reopened.

export interface ClosedProject {
  project: string
  closed_at: string
}

// Idempotent: re-closing after an implicit reopen simply re-stamps closed_at.
export function closeProject(db: Database.Database, project: string): void {
  db.prepare(
    `INSERT INTO projects (project, closed_at) VALUES (?, ?)
     ON CONFLICT(project) DO UPDATE SET closed_at = excluded.closed_at`,
  ).run(project, new Date().toISOString())
}

export function reopenProject(db: Database.Database, project: string): void {
  db.prepare(`DELETE FROM projects WHERE project = ?`).run(project)
}

// The RAW rows, newest closure first — including projects the derived rule below
// has already reopened (nothing deletes those; the table is bounded by how many
// projects a human has ever closed, which is tiny). Anyone who wants the
// EFFECTIVE closed set must call closedProjects(), never this.
export function listClosedProjects(db: Database.Database): ClosedProject[] {
  return db.prepare(`SELECT project, closed_at FROM projects ORDER BY closed_at DESC`).all() as ClosedProject[]
}

// The EFFECTIVE closed set. Reopen is DERIVED, never written: a project stops
// being closed as soon as new CONTENT is created in it STRICTLY AFTER the close.
//
// Strictly after, and the millisecond boundary is deliberate. Both stamps are
// millisecond-resolution, so a close and a write can genuinely tie, and a tie
// resolves in favour of the human's explicit act. `>=` is the worse trade in both
// directions: closing a project in the same millisecond an item lands — the
// ordinary flow, since you close a project *because* something just finished in
// it — would leave it open, so the × click visibly does nothing and does nothing
// again on every retry while an agent keeps writing. `>` costs one missed
// un-close in a genuine tie, and the next write in any later millisecond undoes
// it by itself. (Contrast sweepStale's deliberately INCLUSIVE `>=`, whose
// inclusivity exists so MAX_AGE_MS=0 can mean "clear every backstop".)
// test/store.test.ts pins the boundary in both directions on a frozen clock.
//
// WHY derived rather than deleting the row inside insertItem: insertItem is the
// one path CLAUDE.md says must never lose a flag, and this way it gains no new
// write and no new failure mode; there is no window in which the item exists but
// the un-close has not run yet; and one rule covers boards and every future
// writer for free.
//
// created_at and closed_at are both ISO-8601 UTC strings from
// `new Date().toISOString()` everywhere in this file, so lexicographic `>` is
// chronologically correct — that is the load-bearing assumption here.
//
// Deliberately NOT reopening on: a board merely re-upserted (ensureBoard moves
// updated_at, never created_at) or a live session appearing (presence is not
// attention). KNOWN LIMITATION, accepted: an agent already blocked on a question
// raised BEFORE the close creates nothing new while it polls pending(), so
// closing that project mutes a genuinely-live blocking question until fresh
// content arrives. Closing is the human's explicit act, and one new flag undoes
// it — but "nothing can be permanently muted" is not true of that one case, and
// saying otherwise would be an overclaim.
export function closedProjects(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT p.project FROM projects p
        WHERE NOT EXISTS (SELECT 1 FROM items  i WHERE i.project = p.project AND i.created_at > p.closed_at)
          AND NOT EXISTS (SELECT 1 FROM boards b WHERE b.project = p.project AND b.created_at > p.closed_at)
        ORDER BY p.project`,
    )
    .all() as { project: string }[]
  return rows.map((r) => r.project)
}
