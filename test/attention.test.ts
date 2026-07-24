import { describe, it, expect } from 'vitest'
import {
  classifyLiveness,
  isBlockedRowAttention,
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
    { id: 'r2', label: 'dns', status: 'blocked', annotation: 'use cloudflare', annotation_unseen: false },
    { id: 'r3', label: 'certs', status: 'blocked', annotation: 'wildcard please', annotation_unseen: true },
    { id: 'r4', label: 'smoke', status: 'done', annotation: null, annotation_unseen: false },
  ],
}

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
})

describe('isBlockedRowAttention', () => {
  it('counts a blocked row with no annotation', () => {
    expect(isBlockedRowAttention(board.rows[0]!)).toBe(true)
  })
  it('REGRESSION: does NOT count a blocked row the human already annotated and the agent has seen', () => {
    // today's predicate (app.js:139) counts every blocked row, so the badge can
    // never return to zero. An already-seen annotation clears the escalation.
    expect(isBlockedRowAttention(board.rows[1]!)).toBe(false)
  })
  it('still counts a blocked row whose annotation the agent has not seen yet', () => {
    expect(isBlockedRowAttention(board.rows[2]!)).toBe(true)
  })
  it('ignores non-blocked rows', () => {
    expect(isBlockedRowAttention(board.rows[3]!)).toBe(false)
  })
  it('treats an empty-string annotation as no annotation', () => {
    expect(isBlockedRowAttention({ id: 'x', label: 'x', status: 'blocked', annotation: '', annotation_unseen: false })).toBe(true)
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

  it('includes unanswered non-stale questions with their liveness, plus blocked rows', () => {
    const e = attentionEntries(items, [board], NOW, live)
    expect(e.map((x) => (x.kind === 'row' ? `row:${x.row.id}` : x.item.id))).toEqual(['q1', 'q2', 'row:r1', 'row:r3'])
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
    expect(attentionCount(items, [board], NOW, live)).toBe(4)
  })
  it('returns zero when the only blocked row is already annotated and seen', () => {
    const settled: AttentionBoard = { id: 'b2', project: 'web', title: 'Done deal', rows: [board.rows[1]!] }
    expect(attentionCount([], [settled], NOW, live)).toBe(0)
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
    expect(m.get('web')).toEqual({ total: 2, escalated: 2 })
  })
  it('a parked item never escalates however old it is', () => {
    const parked = [item('p', { created_at: new Date(NOW - ESCALATE_MS * 10).toISOString() })]
    expect(countsByProject(parked, [], NOW, new Set())).toEqual(new Map([['api', { total: 1, escalated: 0 }]]))
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
    expect(out).toEqual(['row:r1', 'row:r3', 'waitOld', 'waitNew', 'parkedOld', 'parkedNew', 'answered'])
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
