import { describe, expect, it } from 'vitest'
import {
  attentionCount,
  attentionEntries,
  awaitingAgentRows,
  countsByProject,
  isAskingQuestion,
  isBlockedRowAttention,
  laterEntries,
  staleEntries,
  STALE_MS,
} from '../public/attention.js'
import type { AttentionBoard, AttentionItem, AttentionRow } from '../public/attention.js'
import { repliedEntries } from '../public/rowview.js'

const NOW = Date.parse('2026-08-05T00:00:00.000Z')
const FUTURE = new Date(NOW + 24 * 60 * 60_000).toISOString()
const PAST = new Date(NOW - 60_000).toISOString()
const PINNED = new Date(NOW - 2 * 24 * 60 * 60_000).toISOString()

describe('human dispositions in the shared attention model', () => {
  it('treats clarification and decline kinds as human responses even without text', () => {
    expect(isAskingQuestion({
      id: 'i', project: 'p', created_at: '2026-08-04T00:00:00.000Z',
      kind: 'question', status: 'open', reply: null, reply_kind: 'clarify',
    }, NOW)).toBe(false)
    expect(isBlockedRowAttention({
      id: 'r', status: 'blocked', annotation: null, annotation_kind: 'decline',
      annotation_unseen: false, handled_at: null,
    }, NOW)).toBe(false)
  })

  it('demotes snoozed unanswered work into an explicit fold instead of losing it', () => {
    const item = {
      id: 'i1',
      project: 'p',
      kind: 'question',
      status: 'open',
      reply: null,
      reply_kind: null,
      session: null,
      created_at: '2026-08-04T00:00:00.000Z',
      snoozed_until: FUTURE,
    }
    const row = {
      id: 'r1',
      status: 'blocked',
      annotation: null,
      annotation_kind: null,
      annotation_unseen: false,
      handled_at: null,
      snoozed_until: FUTURE,
    }
    const board = { id: 'b1', project: 'p', rows: [row] }

    expect(attentionEntries([item], [board], NOW, new Set())).toEqual([])
    expect(awaitingAgentRows([board])).toEqual([])
    expect(laterEntries([item], [board], NOW)).toEqual([
      { kind: 'item', item, liveness: 'later', later: 'snoozed' },
      { kind: 'row', row, board, liveness: 'later', later: 'snoozed' },
    ])
  })

  it('returns snoozed work to attention automatically when its time passes', () => {
    const item = {
      id: 'i1',
      project: 'p',
      kind: 'question',
      status: 'open',
      reply: null,
      reply_kind: null,
      session: null,
      created_at: '2026-08-04T00:00:00.000Z',
      snoozed_until: FUTURE,
    }
    expect(attentionEntries([item], [], NOW + 2 * 24 * 60 * 60_000, new Set())).toHaveLength(1)
    expect(laterEntries([item], [], NOW + 2 * 24 * 60 * 60_000)).toEqual([])
  })
})

// Issue #247: a pin for later is a demotion exactly like a snooze, with no
// return time. The ONE predicate drops it, so every count follows at once.
describe('pinned for later (#247)', () => {
  const question = (over: Partial<AttentionItem> = {}): AttentionItem & { title: string } => ({
    id: 'q', project: 'p', kind: 'question', title: 'Ship it?', status: 'open', reply: null, reply_kind: null,
    session: null, created_at: '2026-08-04T00:00:00.000Z', ...over,
  })
  const blocked = (over: Partial<AttentionRow> = {}): AttentionRow => ({
    id: 'r', status: 'blocked', annotation: null, annotation_kind: null, annotation_unseen: false,
    handled_at: null, revision: 1, ...over,
  })

  it('leaves the attention set, the count and the rail, and lands in Later tagged pinned', () => {
    const item = question({ pinned_at: PINNED })
    const row = blocked({ pinned_at: PINNED })
    const board: AttentionBoard = { id: 'b', project: 'p', rows: [row] }

    expect(isAskingQuestion(item, NOW)).toBe(false)
    expect(isBlockedRowAttention(row, NOW)).toBe(false)
    expect(attentionEntries([item], [board], NOW, ['live'])).toEqual([])
    expect(attentionCount([item], [board], NOW, ['live'])).toBe(0)
    expect(countsByProject([item], [board], NOW, ['live']).size).toBe(0)
    expect(laterEntries([item], [board], NOW)).toEqual([
      { kind: 'item', item, liveness: 'later', later: 'pinned' },
      { kind: 'row', row, board, liveness: 'later', later: 'pinned' },
    ])
  })

  it('has no return time: it stays in Later however much time passes', () => {
    const item = question({ pinned_at: PINNED })
    const later = NOW + 365 * 24 * 60 * 60_000
    expect(attentionEntries([item], [], later, [])).toEqual([])
    expect(laterEntries([item], [], later)).toHaveLength(1)
  })

  it('keeps an old pinned question in Later, never the stale fold', () => {
    const item = question({ pinned_at: PINNED, created_at: new Date(NOW - STALE_MS - 60_000).toISOString() })
    expect(staleEntries([item], NOW, [])).toEqual([])
    expect(laterEntries([item], [], NOW)).toEqual([{ kind: 'item', item, liveness: 'later', later: 'pinned' }])
  })

  it('tags an ask carrying both a pin and a snooze as pinned', () => {
    const item = question({ pinned_at: PINNED, snoozed_until: FUTURE })
    const row = blocked({ pinned_at: PINNED, snoozed_until: FUTURE })
    const board: AttentionBoard = { id: 'b', project: 'p', rows: [row] }
    expect(laterEntries([item], [board], NOW).map((entry) => entry.later)).toEqual(['pinned', 'pinned'])
  })

  it('counts an empty pinned_at as no pin', () => {
    const item = question({ pinned_at: '' })
    expect(isAskingQuestion(item, NOW)).toBe(true)
    expect(laterEntries([item], [], NOW)).toEqual([])
  })

  it('drops a closed project from Later, as from attention', () => {
    const item = question({ pinned_at: PINNED })
    const board: AttentionBoard = { id: 'b', project: 'p', rows: [blocked({ snoozed_until: FUTURE })] }
    expect(laterEntries([item], [board], NOW, ['p'])).toEqual([])
    expect(laterEntries([item], [board], NOW, new Set(['other']))).toHaveLength(2)
  })

  it('never holds an answered, handled, closed or non-blocked ask, pinned or not', () => {
    const items = [
      question({ id: 'answered', pinned_at: PINNED, reply: 'Yes' }),
      question({ id: 'declined', pinned_at: PINNED, reply_kind: 'decline' }),
      question({ id: 'resolved', pinned_at: PINNED, status: 'resolved' }),
      question({ id: 'note', pinned_at: PINNED, kind: 'note' }),
    ]
    const board: AttentionBoard = {
      id: 'b', project: 'p', rows: [
        blocked({ id: 'annotated', pinned_at: PINNED, annotation: 'Go' }),
        blocked({ id: 'handled', pinned_at: PINNED, handled_at: PAST }),
        blocked({ id: 'partial', pinned_at: PINNED, status: 'partial' }),
      ],
    }
    expect(laterEntries(items, [board], NOW)).toEqual([])
  })

  // §4.1: every blocked row is in exactly one of attention, Later or the
  // awaiting-agent foot, and every open question in exactly one of attention,
  // the stale fold, Later or the replied foot.
  it('keeps the complement exact over every state', () => {
    const old = new Date(NOW - STALE_MS - 60_000).toISOString()
    const items = [
      question({ id: 'waiting', session: 'live' }),
      question({ id: 'parked' }),
      question({ id: 'stale', created_at: old }),
      question({ id: 'legacy', status: undefined }),
      question({ id: 'snoozed', snoozed_until: FUTURE }),
      question({ id: 'snooze-ended', snoozed_until: PAST }),
      question({ id: 'pinned', pinned_at: PINNED }),
      question({ id: 'pinned-old', pinned_at: PINNED, created_at: old }),
      question({ id: 'both', pinned_at: PINNED, snoozed_until: FUTURE }),
      question({ id: 'answered', reply: 'Yes' }),
      question({ id: 'answered-pinned', reply: 'Yes', pinned_at: PINNED }),
      question({ id: 'clarify', reply_kind: 'clarify' }),
    ]
    const rows: AttentionRow[] = [
      blocked({ id: 'r-open' }),
      blocked({ id: 'r-snoozed', snoozed_until: FUTURE }),
      blocked({ id: 'r-snooze-ended', snoozed_until: PAST }),
      blocked({ id: 'r-pinned', pinned_at: PINNED }),
      blocked({ id: 'r-both', pinned_at: PINNED, snoozed_until: FUTURE }),
      blocked({ id: 'r-cleared-note', pinned_at: PINNED, annotation: '' }),
      blocked({ id: 'r-annotated', annotation: 'Go' }),
      blocked({ id: 'r-declined', annotation_kind: 'decline' }),
      blocked({ id: 'r-handled', handled_at: PAST }),
      blocked({ id: 'r-annotated-pinned', annotation: 'Go', pinned_at: PINNED }),
    ]
    const board: AttentionBoard = { id: 'b', project: 'p', rows }
    const live = new Set(['live'])
    const ids = (entries: Array<{ kind: string, item?: { id: string }, row?: { id: string } }>) =>
      entries.map((entry) => (entry.kind === 'row' ? entry.row!.id : entry.item!.id))
    const attention = ids(attentionEntries(items, [board], NOW, live))
    const later = ids(laterEntries(items, [board], NOW))
    const stale = ids(staleEntries(items, NOW, live))
    const replied = ids(repliedEntries(items, NOW, live))
    const awaiting = ids(awaitingAgentRows([board]))

    for (const item of items) {
      const homes = [attention, stale, later, replied].filter((set) => set.includes(item.id))
      expect(homes, item.id).toHaveLength(1)
    }
    for (const row of rows) {
      const homes = [attention, later, awaiting].filter((set) => set.includes(row.id))
      expect(homes, row.id).toHaveLength(1)
    }
    expect(later).toEqual([
      'snoozed', 'pinned', 'pinned-old', 'both',
      'r-snoozed', 'r-pinned', 'r-both', 'r-cleared-note',
    ])
  })
})
