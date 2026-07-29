import { describe, it, expect } from 'vitest'
import {
  classifyLiveness,
  isBlockedRowAttention,
  humanActedOnRow,
  awaitingAgentRows,
  isAskingQuestion,
  attentionEntries,
  staleEntries,
  attentionCount,
  countsByProject,
  sortNeedsYou,
  STALE_MS,
  ESCALATE_MS,
  NOTE_AGE_MS,
} from '../public/attention.js'
import type { AttentionEntry, AttentionItem, AttentionBoard } from '../public/attention.js'

const NOW = Date.parse('2026-07-24T12:00:00Z')

function item(id: string, over: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id,
    project: 'api',
    kind: 'question',
    reply: null,
    session: null,
    created_at: '2026-07-24T11:00:00Z',
    ...over,
  }
}

const board: AttentionBoard = {
  id: 'b1',
  project: 'web',
  title: 'Rollout',
  rows: [
    { id: 'r1', label: 'deploy', status: 'blocked', annotation: null, annotation_unseen: false },
    { id: 'r2', label: 'dns', status: 'blocked', annotation: 'use cloudflare', annotation_unseen: false, annotation_seen_at: '2026-07-24T11:50:00Z' },
    { id: 'r3', label: 'certs', status: 'blocked', annotation: 'wildcard please', annotation_unseen: true, annotation_seen_at: null },
    { id: 'r4', label: 'smoke', status: 'done', annotation: null, annotation_unseen: false },
  ],
}

// Issue #36's shape, kept apart from `board` above so the #37 assertions keep
// asserting exactly what they always did. Every row here is a TASK the human was
// asked to go and do — which is what `blocked` turned out to mean in the wild —
// so the answer is a `handled_at` mark, not words.
const taskBoard: AttentionBoard = {
  id: 'b2',
  project: 'ops',
  title: 'Wave 0',
  rows: [
    { id: 't1', label: 'Paddle account', status: 'blocked', annotation: null, annotation_unseen: false },
    { id: 't2', label: 'Notion integration', status: 'blocked', annotation: null, annotation_unseen: false, handled_at: '2026-07-24T11:40:00Z' },
    { id: 't3', label: 'hero demo', status: 'blocked', annotation: null, annotation_unseen: false, handled_at: '2026-07-24T11:45:00Z', handled_seen_at: '2026-07-24T11:50:00Z' },
    { id: 't4', label: 'both', status: 'blocked', annotation: 'and I emailed them', annotation_unseen: true, handled_at: '2026-07-24T11:55:00Z' },
    { id: 't5', label: 'shipped', status: 'done', annotation: null, annotation_unseen: false, handled_at: '2026-07-24T11:30:00Z' },
  ],
}

describe('humanActedOnRow', () => {
  it('is true for an annotation, true for a mark, true for both, false for neither', () => {
    expect(humanActedOnRow(taskBoard.rows[0]!)).toBe(false)
    expect(humanActedOnRow(taskBoard.rows[1]!)).toBe(true)
    expect(humanActedOnRow(taskBoard.rows[3]!)).toBe(true)
    expect(humanActedOnRow(board.rows[1]!)).toBe(true)
  })

  it('an empty-string mark is no mark, exactly like an empty annotation', () => {
    expect(humanActedOnRow({ id: 'x', label: 'x', status: 'blocked', annotation: '', annotation_unseen: false, handled_at: '' })).toBe(false)
  })

  it('says nothing about status — that is the caller’s half of the rule', () => {
    expect(humanActedOnRow(taskBoard.rows[4]!)).toBe(true)
  })
})

// #36 requirement 2. Before this, the human's ONLY lever on a blocked row was a
// text box, and none of the four live blocked rows was a question — so a task
// they had actually gone and done stayed in the badge until an agent flipped the
// status, and if that session was over, forever.
describe('isBlockedRowAttention with the handled mark (#36)', () => {
  it('still counts a blocked row nobody has answered or done', () => {
    expect(isBlockedRowAttention(taskBoard.rows[0]!)).toBe(true)
  })
  it('drops a blocked row the human marked handled, with no agent round-trip', () => {
    expect(isBlockedRowAttention(taskBoard.rows[1]!)).toBe(false)
  })
  it('drops it whether or not an agent has collected the mark', () => {
    expect(isBlockedRowAttention(taskBoard.rows[2]!)).toBe(false)
  })
  it('an empty-string mark leaves the row in the badge', () => {
    expect(isBlockedRowAttention({ id: 'x', label: 'x', status: 'blocked', annotation: null, annotation_unseen: false, handled_at: '' })).toBe(true)
  })
})

// Requirement 3, the rule the whole surface turns on: NEVER remove the signal —
// relabel it. A marked row leaves the badge and lands in the awaiting-pickup
// foot, and only an agent flipping the status takes it off screen.
describe('awaitingAgentRows with the handled mark (#36)', () => {
  it('holds the marked blocked rows the badge just dropped', () => {
    expect(awaitingAgentRows([taskBoard]).map((e) => e.row.id)).toEqual(['t2', 't3', 't4'])
  })
  it('does not hold a marked row that is no longer blocked — the agent acknowledged it', () => {
    expect(awaitingAgentRows([taskBoard]).map((e) => e.row.id)).not.toContain('t5')
  })
  it('the two sets stay disjoint and together still cover every blocked row', () => {
    const attn = attentionEntries([], [taskBoard], NOW, new Set()).map((e) => (e.kind === 'row' ? e.row.id : ''))
    const foot = awaitingAgentRows([taskBoard]).map((e) => e.row.id)
    expect(attn.filter((id) => foot.includes(id))).toEqual([])
    expect([...attn, ...foot].sort()).toEqual(['t1', 't2', 't3', 't4'])
  })
})

describe('sortNeedsYou with the handled mark (#36)', () => {
  it('sinks a marked row below an unanswered one, into the same foot as an annotated row', () => {
    const entries: AttentionEntry[] = [
      { kind: 'row', row: taskBoard.rows[1]!, board: taskBoard },   // marked
      { kind: 'row', row: taskBoard.rows[0]!, board: taskBoard },   // still asking
      { kind: 'row', row: board.rows[2]!, board },                  // annotated
    ]
    expect(sortNeedsYou(entries, NOW).map((e) => (e.kind === 'row' ? e.row.id : ''))).toEqual(['t1', 't2', 'r3'])
  })
})

describe('constants', () => {
  it('are the spec durations', () => {
    expect(STALE_MS).toBe(72 * 60 * 60 * 1000)
    expect(ESCALATE_MS).toBe(60 * 60 * 1000)
    expect(NOTE_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })
})

describe('classifyLiveness', () => {
  it('is waiting when the asking session is still live', () => {
    expect(classifyLiveness(item('a', { session: 's1' }), NOW, new Set(['s1']))).toBe('waiting')
  })
  it('is parked when no live session but younger than 72h', () => {
    expect(classifyLiveness(item('a', { session: 's1' }), NOW, new Set(['s2']))).toBe('parked')
    expect(classifyLiveness(item('a', { session: null }), NOW, new Set())).toBe('parked')
  })
  it('is stale when no live session and older than 72h', () => {
    const old = item('a', { created_at: new Date(NOW - STALE_MS - 1000).toISOString() })
    expect(classifyLiveness(old, NOW, new Set())).toBe('stale')
  })
  it('exactly 72h old is still parked, not stale', () => {
    const edge = item('a', { created_at: new Date(NOW - STALE_MS).toISOString() })
    expect(classifyLiveness(edge, NOW, new Set())).toBe('parked')
  })
  it('a live session beats age — an old item with a live agent is waiting', () => {
    const old = item('a', { session: 's1', created_at: new Date(NOW - STALE_MS - 1000).toISOString() })
    expect(classifyLiveness(old, NOW, new Set(['s1']))).toBe('waiting')
  })
  it('accepts an array of session ids as well as a Set', () => {
    expect(classifyLiveness(item('a', { session: 's1' }), NOW, ['s1'])).toBe('waiting')
  })
  // Documentation of intent for the #10 backstop, not a new mechanism: hook
  // items carry a Claude Code HARNESS session id, and `activity.session` only
  // ever holds a randomUUID minted by the MCP server. The join therefore always
  // misses, which is exactly what keeps a backstop out of 'waiting' — it is
  // 'parked', then 'stale' past STALE_MS — and so unable to escalate a rail
  // badge, however long the terminal stays blocked.
  it('a hook backstop, whose session id is from the harness id space, is parked', () => {
    const harness = item('h', { session: 'a1b2c3d4-claude-code-session', created_at: new Date(NOW - ESCALATE_MS * 6).toISOString() })
    expect(classifyLiveness(harness, NOW, new Set(['mcp-uuid-1', 'mcp-uuid-2']))).toBe('parked')
    expect(countsByProject([harness], [], NOW, new Set(['mcp-uuid-1']))).toEqual(new Map([['api', { total: 1, escalated: 0 }]]))
  })
})

// ── issues #36 + #37 ────────────────────────────────────────────────────────
// The human's ANSWER leaves the badge immediately; whether an agent picked it up
// is the agent's state, not the human's to-do. That is not a new rule — it is
// exactly what items already do (isAskingQuestion goes false the moment `reply`
// is non-empty; pickup is irrelevant to the count), and the un-picked-up state is
// relabeled rather than deleted (repliedEntries' dimmed foot).
//
// The old rule also made `annotation_unseen` — board mark-seen state written by
// a completely different process — an input to the badge, which is how a note
// could silently stop escalating a day later because some agent called
// board_get. Dropping that dependency removes the whole class of bug.
describe('isBlockedRowAttention', () => {
  it('counts a blocked row with no annotation — nobody has answered it', () => {
    expect(isBlockedRowAttention(board.rows[0]!)).toBe(true)
  })
  it('does NOT count a blocked row the human annotated and an agent picked up', () => {
    expect(isBlockedRowAttention(board.rows[1]!)).toBe(false)
  })
  it('does NOT count one whose annotation is still undelivered either — the human already acted', () => {
    // the old rule kept this in the badge, so annotating (the only lever the
    // viewer offers) never moved the number and the row was unclearable (#36)
    expect(isBlockedRowAttention(board.rows[2]!)).toBe(false)
  })
  it('ignores non-blocked rows', () => {
    expect(isBlockedRowAttention(board.rows[3]!)).toBe(false)
  })
  it('treats an empty-string annotation as no annotation', () => {
    expect(isBlockedRowAttention({ id: 'x', label: 'x', status: 'blocked', annotation: '', annotation_unseen: false })).toBe(true)
  })
  it('no longer reads annotation_unseen at all — board mark-seen state cannot move the badge', () => {
    const base = { id: 'x', label: 'x', status: 'blocked', annotation: 'answered' }
    expect(isBlockedRowAttention({ ...base, annotation_unseen: true })).toBe(false)
    expect(isBlockedRowAttention({ ...base, annotation_unseen: false })).toBe(false)
  })
})

// The other half of "never remove the signal — relabel it truthfully": the rows
// that LEFT the badge above are not gone, they are a separate rendered set, the
// exact shape repliedEntries has for items. Same module, so there is still ONE
// place that knows what a blocked row means (tenet 3).
describe('awaitingAgentRows', () => {
  it('holds exactly the annotated blocked rows the badge dropped', () => {
    expect(awaitingAgentRows([board]).map((e) => e.row.id)).toEqual(['r2', 'r3'])
  })
  it('carries the owning board, like every other row entry', () => {
    expect(awaitingAgentRows([board])[0]!.board.title).toBe('Rollout')
  })
  it('the two sets are disjoint and together cover every blocked row', () => {
    const attn = attentionEntries([], [board], NOW, new Set()).map((e) => (e.kind === 'row' ? e.row.id : ''))
    const foot = awaitingAgentRows([board]).map((e) => e.row.id)
    expect(attn.filter((id) => foot.includes(id))).toEqual([])
    expect([...attn, ...foot].sort()).toEqual(['r1', 'r2', 'r3'])
  })
  it('suppresses a closed project, exactly as the attention set does (issue #32)', () => {
    expect(awaitingAgentRows([board], ['web'])).toEqual([])
    expect(awaitingAgentRows([board], new Set(['web']))).toEqual([])
    expect(awaitingAgentRows([board], []).length).toBe(2)
  })
  it('tolerates missing input the way attentionEntries does', () => {
    expect(awaitingAgentRows(undefined)).toEqual([])
    expect(awaitingAgentRows([{ id: 'b', project: 'p', rows: undefined } as unknown as AttentionBoard])).toEqual([])
  })
})

describe('attentionEntries', () => {
  const items = [
    item('q1', { session: 's1', created_at: '2026-07-24T10:00:00Z' }),
    item('q2', { created_at: '2026-07-24T09:00:00Z' }),
    item('qStale', { created_at: '2026-07-20T00:00:00Z' }),
    item('qAnswered', { reply: 'yes' }),
    item('n1', { kind: 'note' }),
  ]
  const live = new Set(['s1'])

  it('includes unanswered non-stale questions with their liveness, plus UNANSWERED blocked rows', () => {
    const e = attentionEntries(items, [board], NOW, live)
    expect(e.map((x) => (x.kind === 'row' ? `row:${x.row.id}` : x.item.id))).toEqual(['q1', 'q2', 'row:r1'])
    const first = e[0]!
    expect(first.kind).toBe('item')
    if (first.kind === 'item') expect(first.liveness).toBe('waiting')
  })
  it('excludes stale, answered, and non-question items', () => {
    const ids = attentionEntries(items, [board], NOW, live).map((x) => (x.kind === 'item' ? x.item.id : ''))
    expect(ids).not.toContain('qStale')
    expect(ids).not.toContain('qAnswered')
    expect(ids).not.toContain('n1')
  })
  it('REGRESSION: a resolved question with no reply is not attention', () => {
    // resolve() closes an item without ever writing a reply. Keying only on
    // `reply` counts it forever and the badge can never reach zero.
    const resolved = [item('qResolved', { session: 's1', status: 'resolved' })]
    expect(attentionEntries(resolved, [], NOW, live)).toEqual([])
    expect(attentionCount(resolved, [], NOW, live)).toBe(0)
  })
  it('a dismissed question is not attention either', () => {
    expect(attentionCount([item('qDismissed', { status: 'dismissed' })], [], NOW, live)).toBe(0)
  })
  it('an explicitly open question still counts, and so does one with no status field', () => {
    expect(attentionCount([item('qOpen', { status: 'open' })], [], NOW, live)).toBe(1)
    expect(attentionCount([item('qNoStatus')], [], NOW, live)).toBe(1)
  })
  it('carries the owning board on row entries', () => {
    const rowEntry = attentionEntries([], [board], NOW, live)[0]!
    expect(rowEntry.kind).toBe('row')
    if (rowEntry.kind === 'row') expect(rowEntry.board.title).toBe('Rollout')
  })
  it('attentionCount matches the entry count', () => {
    expect(attentionCount(items, [board], NOW, live)).toBe(3)
  })
  it('returns zero when the only blocked row has been annotated — picked up or not', () => {
    const settled: AttentionBoard = { id: 'b2', project: 'web', title: 'Done deal', rows: [board.rows[1]!] }
    const waiting: AttentionBoard = { id: 'b3', project: 'web', title: 'Still waiting', rows: [board.rows[2]!] }
    expect(attentionCount([], [settled], NOW, live)).toBe(0)
    expect(attentionCount([], [waiting], NOW, live)).toBe(0)
  })
})

describe('staleEntries', () => {
  const ancient = item('qStale', { created_at: new Date(NOW - STALE_MS - 60_000).toISOString() })

  it('a >72h question with no live session is ABSENT from attentionEntries but PRESENT in staleEntries', () => {
    expect(attentionEntries([ancient], [], NOW, new Set())).toEqual([])
    const fold = staleEntries([ancient], NOW, new Set())
    expect(fold).toHaveLength(1)
    expect(fold[0]!.item.id).toBe('qStale')
    expect(fold[0]!.liveness).toBe('stale')
  })
  it('a live session keeps an old question out of the stale fold and in the attention set', () => {
    const alive = item('qOld', { session: 's1', created_at: new Date(NOW - STALE_MS - 60_000).toISOString() })
    expect(staleEntries([alive], NOW, new Set(['s1']))).toEqual([])
    expect(attentionCount([alive], [], NOW, new Set(['s1']))).toBe(1)
  })
  it('never demotes a young question', () => {
    expect(staleEntries([item('q1')], NOW, new Set())).toEqual([])
  })
  it('never returns answered, resolved, or non-question items however old', () => {
    const old = new Date(NOW - STALE_MS - 60_000).toISOString()
    const noise = [
      item('answered', { reply: 'yes', created_at: old }),
      item('resolved', { status: 'resolved', created_at: old }),
      item('note', { kind: 'note', created_at: old }),
    ]
    expect(staleEntries(noise, NOW, new Set())).toEqual([])
  })
})

describe('countsByProject', () => {
  it('totals per project and escalates blocked rows and >1h waiting items', () => {
    const items = [
      item('q1', { session: 's1', created_at: '2026-07-24T10:00:00Z' }), // waiting 2h → escalated
      item('q2', { session: 's1', created_at: '2026-07-24T11:45:00Z' }), // waiting 15m → not escalated
      item('q3', { created_at: '2026-07-23T00:00:00Z' }),                // parked, old → never escalates
    ]
    const m = countsByProject(items, [board], NOW, new Set(['s1']))
    expect(m.get('api')).toEqual({ total: 3, escalated: 1 })
    // only r1 is left in `web`: r2/r3 carry the human's answer and are out (#36)
    expect(m.get('web')).toEqual({ total: 1, escalated: 1 })
  })
  it('a parked item never escalates however old it is', () => {
    const parked = [item('p', { created_at: new Date(NOW - ESCALATE_MS * 10).toISOString() })]
    expect(countsByProject(parked, [], NOW, new Set())).toEqual(new Map([['api', { total: 1, escalated: 0 }]]))
  })
  // The honesty valve for the badge decision above: the rail's closed fold is
  // where a suppressed number is RELOCATED. If countsByProject suppressed too,
  // the fold would read 0 and an honest mute would become a silent one.
  it('still counts a closed project — the rail relocates the number, it never destroys it', () => {
    const items = [item('q1', { project: 'dead' })]
    expect(countsByProject(items, [], NOW, new Set()).get('dead')).toEqual({ total: 1, escalated: 0 })
  })

  it('an exactly-1h-old waiting item is not yet escalated (strict >)', () => {
    const items = [item('q', { created_at: new Date(NOW - ESCALATE_MS).toISOString(), session: 's1' })]
    const counts = countsByProject(items, [], NOW, new Set(['s1']))
    expect(counts.get('api')).toEqual({ total: 1, escalated: 0 })
  })
})

// ── issue #32: a closed project leaves the attention set entirely ────────────
// THE BADGE DECISION, for the record. Tenet 2: "a count that counts things
// nobody is waiting on is worse than no count at all. This tenet outranks
// completeness: when in doubt, a thing does not enter the attention set." §6
// already drops unanswered questions from the badge on a bare 72-hour
// heuristic; an explicit human close is stronger evidence than that heuristic,
// not weaker. So closure SUPPRESSES — and it does so HERE, in the one shared
// predicate (tenet 3), never re-implemented at each call site.
describe('closed projects are out of the attention set (issue #32)', () => {
  const q = item('q1', { project: 'dead', session: 's1' })
  const deadBoard: AttentionBoard = {
    id: 'b9', project: 'dead', title: 'Rollout',
    rows: [{ id: 'r9', label: 'deploy', status: 'blocked', annotation: null, annotation_unseen: false }],
  }

  it('attentionEntries drops an unanswered question in a closed project', () => {
    expect(attentionEntries([q], [], NOW, new Set(['s1']))).toHaveLength(1)
    expect(attentionEntries([q], [], NOW, new Set(['s1']), ['dead'])).toEqual([])
  })

  it('attentionEntries drops a blocked board row in a closed project', () => {
    expect(attentionEntries([], [deadBoard], NOW, new Set())).toHaveLength(1)
    expect(attentionEntries([], [deadBoard], NOW, new Set(), ['dead'])).toEqual([])
  })

  it('attentionCount lets the badge rest when the only attention is in a closed project', () => {
    expect(attentionCount([q], [deadBoard], NOW, new Set(['s1']), ['dead'])).toBe(0)
  })

  it('suppresses only the named project — everything else still counts', () => {
    const alive = item('q2', { project: 'live' })
    expect(attentionCount([q, alive], [deadBoard], NOW, new Set(['s1']), ['dead'])).toBe(1)
  })

  it('accepts the closed set as a Set or as an array (the API hands over JSON)', () => {
    expect(attentionCount([q], [], NOW, new Set(['s1']), new Set(['dead']))).toBe(0)
    expect(attentionCount([q], [], NOW, new Set(['s1']), ['dead'])).toBe(0)
  })

  it('an omitted closed list changes nothing — every existing 4-arg call site is unaffected', () => {
    expect(attentionCount([q], [deadBoard], NOW, new Set(['s1']))).toBe(2)
    expect(attentionCount([q], [deadBoard], NOW, new Set(['s1']), [])).toBe(2)
    expect(attentionCount([q], [deadBoard], NOW, new Set(['s1']), undefined)).toBe(2)
  })

  it('staleEntries is untouched by closure — the §6 fold is a different question', () => {
    const ancient = item('old', { project: 'dead', created_at: new Date(NOW - STALE_MS - 60_000).toISOString() })
    expect(staleEntries([ancient], NOW, new Set())).toHaveLength(1)
  })
})

describe('sortNeedsYou', () => {
  it('orders blocked rows, then waiting oldest-first, then parked oldest-first, then answered at the foot', () => {
    const entries: AttentionEntry[] = [
      { kind: 'item', item: item('parkedNew', { created_at: '2026-07-24T11:30:00Z' }), liveness: 'parked' },
      { kind: 'item', item: item('answered', { reply: 'ok' }), liveness: 'parked' },
      { kind: 'item', item: item('waitNew', { created_at: '2026-07-24T11:00:00Z' }), liveness: 'waiting' },
      { kind: 'row', row: board.rows[0]!, board },
      { kind: 'item', item: item('parkedOld', { created_at: '2026-07-24T08:00:00Z' }), liveness: 'parked' },
      { kind: 'item', item: item('waitOld', { created_at: '2026-07-24T09:00:00Z' }), liveness: 'waiting' },
      { kind: 'row', row: board.rows[2]!, board },
    ]
    const out = sortNeedsYou(entries, NOW).map((e) => (e.kind === 'row' ? `row:${e.row.id}` : e.item.id))
    // r3 carries the human's annotation, so it joins `answered` in bucket 3 — the
    // dimmed awaiting-pickup foot. ONE ordering rule covers both nouns (#37).
    expect(out).toEqual(['row:r1', 'waitOld', 'waitNew', 'parkedOld', 'parkedNew', 'answered', 'row:r3'])
  })

  it('sinks an annotated row to the awaiting-pickup foot, below every parked question', () => {
    const entries: AttentionEntry[] = [
      { kind: 'row', row: board.rows[2]!, board },                                        // annotated → foot
      { kind: 'item', item: item('parked', { created_at: '2026-07-24T11:30:00Z' }), liveness: 'parked' },
      { kind: 'row', row: board.rows[0]!, board },                                        // unanswered → top
    ]
    const out = sortNeedsYou(entries, NOW).map((e) => (e.kind === 'row' ? `row:${e.row.id}` : e.item.id))
    expect(out).toEqual(['row:r1', 'parked', 'row:r3'])
  })
  it('is stable for entries in the same bucket with equal timestamps', () => {
    const entries: AttentionEntry[] = [
      { kind: 'item', item: item('a'), liveness: 'parked' },
      { kind: 'item', item: item('b'), liveness: 'parked' },
      { kind: 'item', item: item('c'), liveness: 'parked' },
    ]
    expect(sortNeedsYou(entries, NOW).map((e) => (e.kind === 'item' ? e.item.id : ''))).toEqual(['a', 'b', 'c'])
  })
  it('does not mutate the input array', () => {
    const entries: AttentionEntry[] = [
      { kind: 'item', item: item('a', { created_at: '2026-07-24T11:00:00Z' }), liveness: 'parked' },
      { kind: 'row', row: board.rows[0]!, board },
    ]
    sortNeedsYou(entries, NOW)
    expect(entries[0]!.kind).toBe('item')
  })
})

// Fix round 2 (I1): the triage deck used to run its own second attention
// predicate. Re-validating a deck entry against the live data needs the SAME
// "is this question still asking?" rule the attention set uses, so it has to be
// exported rather than re-implemented (as `!i.reply` was) at the call site.
describe('isAskingQuestion is exported so no second predicate has to be written', () => {
  it('is true only for an open, unanswered question', () => {
    expect(isAskingQuestion(item('a'))).toBe(true)
    expect(isAskingQuestion(item('b', { reply: 'go' }))).toBe(false)
    expect(isAskingQuestion(item('c', { status: 'resolved' }))).toBe(false)
    expect(isAskingQuestion(item('d', { kind: 'note' }))).toBe(false)
  })
  it('treats an absent status as open (hand-built fixtures, legacy rows)', () => {
    const legacy = { ...item('e') } as AttentionItem
    delete (legacy as { status?: string }).status
    expect(isAskingQuestion(legacy)).toBe(true)
  })
})
