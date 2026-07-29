// test/shape.test.ts
// Issue #42 — the payload SHAPING layer for MCP reads, unit-tested in isolation.
//
// The rule it exists to enforce, and the one this file must never let slip:
//
//   AGENT-AUTHORED `context` is the only thing that may be trimmed. The HUMAN's
//   `annotation` (and their `reply`/`reply_context`) is never omitted, on any
//   path, under any option. #37 exists to get the human's words to an agent;
//   #42 must not undo it while saving tokens.
//
// src/shape.ts is a pure module on purpose: trimming is a SHAPING concern, not a
// storage one, so it lives beside src/mcp.ts rather than inside src/store.ts —
// and the viewer's /api/boards path never routes through it (pinned in
// test/viewer.test.ts).
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, upsertBoard, listBoards, annotateBoardRow, listPendingAnnotations, markAnnotationDelivered } from '../src/store.js'
import type { BoardWithRows } from '../src/store.js'
import { trimContext, makeContextLedger, deliverContext, shapeBoard, summariseBoard, rowKey, itemKey } from '../src/shape.js'

const LONG = 'why this row exists, at the length agents are told to write. '.repeat(12)

function boardWith(rows: Array<{ label: string; status: 'blocked' | 'tracked' | 'done' | 'partial' | 'na'; note?: string; context?: string }>): {
  db: ReturnType<typeof openDb>
  board: BoardWithRows
} {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'shape-')), 'inbox.db'))
  upsertBoard(db, { project: 'p', stream: 's', agent: 'a', title: 'rollout', rows })
  return { db, board: listBoards(db)[0]! }
}

describe('trimContext — the shape swap', () => {
  it('replaces the context text with its size and leaves every other field byte-identical', () => {
    const row = { id: 'r1', label: 'Merge', note: 'ready', context: 'the long story', annotation: 'merge it' }
    const out = trimContext(row)
    expect(out).not.toHaveProperty('context')
    expect(out.context_chars).toBe('the long story'.length)
    expect(out).toEqual({ id: 'r1', label: 'Merge', note: 'ready', annotation: 'merge it', context_chars: 14 })
  })

  it('counts CHARACTERS, not bytes — a size hint the agent can reason about', () => {
    // 'é' is one character and two UTF-8 bytes: a byte count would say 20
    const out = trimContext({ context: 'é'.repeat(10) })
    expect(out.context_chars).toBe(10)
  })

  // What the number IS, exactly: String.length — UTF-16 code units. An astral
  // character (emoji, most CJK extensions, musical symbols) counts 2, so this is
  // a SIZE HINT, not a character count, and the pin exists because 'é' is BMP
  // and cannot tell the two apart. The tool descriptions say "UTF-16 code units,
  // so an emoji counts 2" in those words; if this assertion is ever changed, the
  // descriptions have to change with it.
  it('is String.length — UTF-16 code units, so an astral emoji counts 2 (#42 F6)', () => {
    expect(trimContext({ context: '😀'.repeat(10) }).context_chars).toBe(20)
    expect([...'😀'.repeat(10)]).toHaveLength(10) // 10 code points, 20 units — the number reports units
  })

  it('emits no field at all when there is no context — absence means "nothing to fetch"', () => {
    const out = trimContext({ label: 'x', context: '' })
    expect(out).toEqual({ label: 'x' })
    expect('context_chars' in out).toBe(false)
  })

  it('never touches the human’s annotation, reply, or reply_context', () => {
    const out = trimContext({ context: LONG, annotation: 'do it my way', reply: 'yes', reply_context: 'but canary first' })
    expect(out.annotation).toBe('do it my way')
    expect(out.reply).toBe('yes')
    expect(out.reply_context).toBe('but canary first')
  })
})

// WHOSE first time is it? Nothing here can answer that, and the tests say so.
// `annotation_seen_at` is per-ROW and `annotation_seen_by` is a CLIENT NAME
// shared by every sibling, so the persisted stamp cannot. Neither can the
// ledger: it is per-PROCESS, one stdio server is long-lived, and a subagent's
// calls are served by its parent's process — so a fan-out SHARES a ledger and
// the first sibling to poll consumes the delivery. What makes that safe is the
// recovery path, pinned below: `full` always returns the text.
describe('makeContextLedger — first delivery is per PROCESS', () => {
  it('hands the text over once, then reports it already delivered', () => {
    const ledger = makeContextLedger()
    expect(ledger.claim(rowKey('r1'), LONG)).toBe(true)
    expect(ledger.claim(rowKey('r1'), LONG)).toBe(false)
    expect(ledger.claim(rowKey('r1'), LONG)).toBe(false)
  })

  it('a DIFFERENT process starts empty — its own first delivery still carries the text', () => {
    const a = makeContextLedger()
    const b = makeContextLedger()
    expect(a.claim(rowKey('r1'), LONG)).toBe(true)
    expect(b.claim(rowKey('r1'), LONG)).toBe(true)
  })

  it('re-ships when the TEXT changes — new text was never delivered', () => {
    const ledger = makeContextLedger()
    expect(ledger.claim(rowKey('r1'), 'first draft')).toBe(true)
    expect(ledger.claim(rowKey('r1'), 'rewritten')).toBe(true)
    expect(ledger.claim(rowKey('r1'), 'rewritten')).toBe(false)
  })

  it('namespaces rows and items so two ids can never collide', () => {
    const ledger = makeContextLedger()
    expect(rowKey('x')).not.toBe(itemKey('x'))
    expect(ledger.claim(rowKey('x'), LONG)).toBe(true)
    expect(ledger.claim(itemKey('x'), LONG)).toBe(true)
  })

  it('claims nothing for an empty context — there is nothing to hand over', () => {
    const ledger = makeContextLedger()
    expect(ledger.claim(rowKey('r1'), '')).toBe(false)
  })
})

describe('deliverContext — first delivery carries it, re-delivery does not', () => {
  it('ships the context once per process and the size thereafter', () => {
    const ledger = makeContextLedger()
    const row = { row_id: 'r1', annotation: 'merge it', context: LONG }
    const first = deliverContext(row, rowKey(row.row_id), ledger)
    expect(first).toHaveProperty('context', LONG)
    const second = deliverContext(row, rowKey(row.row_id), ledger)
    expect(second).not.toHaveProperty('context')
    expect((second as { context_chars: number }).context_chars).toBe(LONG.length)
  })

  it('re-delivers the human’s annotation IN FULL every single time (constraint A)', () => {
    const ledger = makeContextLedger()
    const row = { row_id: 'r1', annotation: 'merge it — but rebase first', context: LONG }
    for (let i = 0; i < 5; i++) {
      expect(deliverContext(row, rowKey(row.row_id), ledger).annotation).toBe('merge it — but rebase first')
    }
  })

  // THE RECOVERY GUARANTEE (#42 F2/F3). The ledger is per-PROCESS and a fan-out
  // shares it, so "already delivered" can be true of a sibling and false of you:
  // the manager below is handed `context_chars` for text it has never seen.
  // Because that is unfixable — MCP gives no subagent identity to key on — the
  // loss must be RECOVERABLE instead, and this is the pin that makes the ledger
  // an optimisation rather than a delivery guarantee it cannot keep.
  it('full: true returns the text however drained the ledger is — the loss is always recoverable', () => {
    const ledger = makeContextLedger() // one process, shared by a manager and its subagents
    const row = { row_id: 'r1', annotation: 'merge it', context: LONG }
    deliverContext(row, rowKey(row.row_id), ledger) // a sibling polls first and consumes the delivery
    expect(deliverContext(row, rowKey(row.row_id), ledger)).not.toHaveProperty('context')
    for (let i = 0; i < 3; i++) {
      expect(deliverContext(row, rowKey(row.row_id), ledger, { full: true })).toHaveProperty('context', LONG)
    }
  })

  it('recovers an ITEM’s context too — pending() is the only read items have', () => {
    const ledger = makeContextLedger()
    const item = { id: 'i1', reply: 'go ahead', context: LONG }
    deliverContext(item, itemKey(item.id), ledger)
    expect(deliverContext(item, itemKey(item.id), ledger)).not.toHaveProperty('context')
    expect(deliverContext(item, itemKey(item.id), ledger, { full: true })).toHaveProperty('context', LONG)
  })

  it('a full delivery is still a delivery — the next ordinary poll does not re-ship it', () => {
    const ledger = makeContextLedger()
    const row = { row_id: 'r1', context: LONG }
    expect(deliverContext(row, rowKey(row.row_id), ledger, { full: true })).toHaveProperty('context', LONG)
    expect(deliverContext(row, rowKey(row.row_id), ledger)).not.toHaveProperty('context')
  })

  it('full: false is the default shape, not a second hatch', () => {
    const ledger = makeContextLedger()
    const row = { row_id: 'r1', context: LONG }
    deliverContext(row, rowKey(row.row_id), ledger)
    expect(deliverContext(row, rowKey(row.row_id), ledger, { full: false })).not.toHaveProperty('context')
  })
})

describe('shapeBoard — board_get({title})', () => {
  it('omits row context by default and reports its size instead', () => {
    const { board } = boardWith([{ label: 'Merge', status: 'blocked', note: 'ready', context: LONG }])
    const out = shapeBoard(board, { ledger: makeContextLedger() })
    expect(out.rows[0]).not.toHaveProperty('context')
    expect((out.rows[0] as { context_chars: number }).context_chars).toBe(LONG.length)
    expect(out.rows[0]!.note).toBe('ready') // the one-line summary always rides along
    expect(out.title).toBe('rollout')
    expect(out.progress.total).toBe(1)
  })

  it('full: true returns the real text', () => {
    const { board } = boardWith([{ label: 'Merge', status: 'blocked', context: LONG }])
    const out = shapeBoard(board, { full: true, ledger: makeContextLedger() })
    expect((out.rows[0] as { context: string }).context).toBe(LONG)
  })

  it('full: true records the delivery, so pending() does not re-ship what this session just read', () => {
    const { board } = boardWith([{ label: 'Merge', status: 'blocked', context: LONG }])
    const ledger = makeContextLedger()
    shapeBoard(board, { full: true, ledger })
    const row = { row_id: board.rows[0]!.id, context: LONG }
    expect(deliverContext(row, rowKey(row.row_id), ledger)).not.toHaveProperty('context')
  })

  it('the DEFAULT form claims nothing — it handed no text over, so pending() still must', () => {
    const { board } = boardWith([{ label: 'Merge', status: 'blocked', context: LONG }])
    const ledger = makeContextLedger()
    shapeBoard(board, { ledger })
    const row = { row_id: board.rows[0]!.id, context: LONG }
    expect(deliverContext(row, rowKey(row.row_id), ledger)).toHaveProperty('context', LONG)
  })

  it('carries the human’s annotation and its delivery stamps in BOTH forms', () => {
    const { db, board } = boardWith([{ label: 'Merge', status: 'blocked', context: LONG }])
    annotateBoardRow(db, board.rows[0]!.id, 'merge it')
    const fresh = listBoards(db)[0]!
    for (const opts of [{ ledger: makeContextLedger() }, { full: true, ledger: makeContextLedger() }]) {
      const out = shapeBoard(fresh, opts)
      expect(out.rows[0]!.annotation).toBe('merge it')
      expect(out.rows[0]!.annotation_unseen).toBe(true)
    }
  })
})

describe('summariseBoard — board_get() with no title', () => {
  it('keeps title, label, status, note and the human’s annotation; drops row context', () => {
    const { db, board } = boardWith([
      { label: 'Merge', status: 'blocked', note: 'ready when you are', context: LONG },
      { label: 'QA', status: 'tracked', context: LONG },
    ])
    annotateBoardRow(db, board.rows[0]!.id, 'merge it')
    markAnnotationDelivered(db, board.rows[0]!.id, listBoards(db)[0]!.rows[0]!.annotated_at, 'claude-code')
    const out = summariseBoard(listBoards(db)[0]!)

    expect(out.title).toBe('rollout')
    expect(out.rows.map((r) => r.label)).toEqual(['Merge', 'QA'])
    expect(out.rows[0]!.status).toBe('blocked')
    expect(out.rows[0]!.note).toBe('ready when you are')
    expect(out.rows[0]!.annotation).toBe('merge it')
    expect(out.rows[0]!.annotation_seen_by).toBe('claude-code')
    expect(out.rows[0]!.annotation_unseen).toBe(false)
    expect(JSON.stringify(out)).not.toContain('why this row exists') // no row context anywhere
    expect(out.rows[0]!.context_chars).toBe(LONG.length)
  })

  // The summary's whole job is "what are my boards" — how far along each one is
  // answers half of that in nine numbers, and it is the one field here that a
  // mutation could blank without any other assertion noticing (#42 F4).
  it('carries the board’s real progress, not a placeholder', () => {
    const { board } = boardWith([
      { label: 'a', status: 'done' },
      { label: 'b', status: 'partial' },
      { label: 'c', status: 'blocked' },
      { label: 'd', status: 'na' },
    ])
    expect(summariseBoard(board).progress).toEqual({
      done: 1, partial: 1, missing: 0, tracked: 0, na: 1, blocked: 1,
      total: 4, countable: 3, fraction: 0.5,
    })
  })

  it('spends nothing on absent fields — no empty note, no null annotation block', () => {
    const { board } = boardWith([{ label: 'QA', status: 'tracked' }])
    const out = summariseBoard(board)
    expect(out.rows[0]).toEqual({ label: 'QA', status: 'tracked' })
  })

  it('delivers no context, so it claims nothing from the ledger (it cannot starve a later poll)', () => {
    const { db, board } = boardWith([{ label: 'Merge', status: 'blocked', context: LONG }])
    annotateBoardRow(db, board.rows[0]!.id, 'merge it')
    const ledger = makeContextLedger()
    summariseBoard(listBoards(db)[0]!)
    const pending = listPendingAnnotations(db, 'p')[0]!
    expect(deliverContext(pending, rowKey(pending.row_id), ledger)).toHaveProperty('context', LONG)
  })
})

// The blanket sweep: whatever else a read path does to a payload, the human's
// words come out the other side intact. This is the test that fails if ANY
// shaping function is ever taught to drop an annotation.
describe('constraint A — no shaping path may drop the human’s annotation', () => {
  it('every MCP-read shape carries the exact annotation text', () => {
    const { db, board } = boardWith([{ label: 'Merge', status: 'blocked', note: 'ready', context: LONG }])
    annotateBoardRow(db, board.rows[0]!.id, 'merge it — but rebase first')
    const fresh = listBoards(db)[0]!
    const pending = listPendingAnnotations(db, 'p')[0]!
    const ledger = makeContextLedger()

    const payloads: unknown[] = [
      shapeBoard(fresh, { ledger: makeContextLedger() }),
      shapeBoard(fresh, { full: true, ledger: makeContextLedger() }),
      summariseBoard(fresh),
      deliverContext(pending, rowKey(pending.row_id), ledger), // first delivery
      deliverContext(pending, rowKey(pending.row_id), ledger), // re-delivery
      deliverContext(pending, rowKey(pending.row_id), ledger, { full: true }), // the recovery hatch
      trimContext(pending),
    ]
    for (const p of payloads) expect(JSON.stringify(p)).toContain('merge it — but rebase first')
  })
})
