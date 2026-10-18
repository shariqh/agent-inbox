import { describe, expect, it } from 'vitest'
import { knownHistory, knownOutcomes, mergeClosedHistory, olderHistory } from '../public/closed-history.js'

const at = (minute: number): string => new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString()

interface Entry {
  id: string
  project: string
  agent: string
  title: string
  kind: string
  status: string
  created_at: string
  [key: string]: unknown
}

function item(id: string, minute: number, extra: Record<string, unknown> = {}): Entry {
  return {
    id, project: 'alpha', agent: 'copilot', title: id, kind: 'question', status: 'resolved',
    created_at: at(minute), ...extra,
  }
}

const SUMMARY = {
  total: 9,
  loaded: 3,
  before: at(30),
  older: [
    { project: 'alpha', agent: 'claude', items: 1, outcomes: 0, latest: null },
    { project: 'alpha', agent: 'copilot', items: 2, outcomes: 1, latest: at(12) },
    { project: 'beta', agent: 'copilot', items: 3, outcomes: 2, latest: at(25) },
  ],
}

describe('mergeClosedHistory', () => {
  it('keeps the complete order while the page stays authoritative for every item it carries', () => {
    const page = {
      needsYou: [{ project: 'alpha', items: [item('reopened-race', 50, { status: 'open' })] }],
      notes: [],
      done: [
        item('new-after-history', 60, { title: 'closed after the history read' }),
        item('milestone', 40, { kind: 'done', status: 'open', title: 'current milestone' }),
        item('recent', 35, { outcome: 'current outcome' }),
      ],
      history: SUMMARY,
    }
    const complete = [
      item('reopened-race', 50),
      item('milestone', 40, { kind: 'done', status: 'open', title: 'stale milestone' }),
      item('recent', 35, { outcome: 'stale outcome' }),
      item('older', 20),
      item('oldest', 10),
    ]
    const merged = mergeClosedHistory(page, complete)
    expect(merged.needsYou).toBe(page.needsYou)
    expect(merged.done.map((entry) => entry.id))
      .toEqual(['new-after-history', 'milestone', 'recent', 'older', 'oldest'])
    expect(merged.done.find((entry) => entry.id === 'milestone')?.title).toBe('current milestone')
    expect(merged.done.find((entry) => entry.id === 'recent')?.outcome).toBe('current outcome')
    expect(merged.done.find((entry) => entry.id === 'reopened-race')).toBeUndefined()
    expect(merged.done.find((entry) => entry.id === 'older')).toBe(complete[3])
  })

  it('reuses the complete list order for ties the page cannot see', () => {
    const tie = at(5)
    const page = { needsYou: [], notes: [], done: [{ ...item('b', 5), created_at: tie }] }
    const complete = [{ ...item('a', 5), created_at: tie }, { ...item('b', 5), created_at: tie }, item('c', 1)]
    expect(mergeClosedHistory(page, complete).done.map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('olderHistory', () => {
  it('sums the omitted groups a lens would show', () => {
    expect(olderHistory(SUMMARY)).toEqual({
      items: 6, outcomes: 3, latest: at(25), projects: ['alpha', 'beta'], agents: ['claude', 'copilot'],
    })
    expect(olderHistory(SUMMARY, { project: 'alpha' })).toEqual({
      items: 3, outcomes: 1, latest: at(12), projects: ['alpha'], agents: ['claude', 'copilot'],
    })
    expect(olderHistory(SUMMARY, { agent: 'copilot', hidden: ['beta'] })).toEqual({
      items: 2, outcomes: 1, latest: at(12), projects: ['alpha'], agents: ['copilot'],
    })
    expect(olderHistory(SUMMARY, { agent: 'claude' }).latest).toBeNull()
  })

  it('bounds a group without a newest outcome stamp by the touch boundary', () => {
    const legacy = { ...SUMMARY, older: [{ project: 'alpha', agent: 'copilot', items: 2, outcomes: 1 }] }
    expect(olderHistory(legacy).latest).toBe(SUMMARY.before)
  })

  it('reports nothing omitted for complete history', () => {
    const none = { items: 0, outcomes: 0, latest: null, projects: [], agents: [] }
    expect(olderHistory(null)).toEqual(none)
    expect(olderHistory({ total: 2, loaded: 2, before: null, older: [] })).toEqual(none)
  })
})

describe('knownHistory', () => {
  it('keeps only the leading entries no omitted item can precede', () => {
    const done = [
      item('a', 50),
      item('milestone', 40, { kind: 'done', status: 'open' }),
      item('b', 31),
      item('touched-recently', 30),
      item('c', 45),
    ]
    expect(knownHistory(done, at(30)).map((entry) => entry.id)).toEqual(['a', 'milestone', 'b'])
    expect(knownHistory(done, null)).toBe(done)
  })

  it('ends at aged notes, which always follow every closed item', () => {
    const done = [item('a', 50), item('aged-note', 45, { kind: 'note', status: 'open' })]
    expect(knownHistory(done, at(30)).map((entry) => entry.id)).toEqual(['a'])
  })
})

describe('knownOutcomes', () => {
  it('keeps the leading outcomes stamped after the boundary', () => {
    const outcomes = [
      { kind: 'item', item: item('a', 10, { outcome: 'x', outcome_at: at(55) }) },
      { kind: 'row', row: { id: 'r', label: 'row', status: 'done', outcome: 'y', outcome_at: at(40) }, board: { id: 'b', project: 'alpha', title: 'B', rows: [] } },
      { kind: 'item', item: item('boundary', 5, { outcome: 'z', outcome_at: at(30) }) },
      { kind: 'item', item: item('older', 1, { outcome: 'w', outcome_at: at(20) }) },
    ] as const
    expect(knownOutcomes([...outcomes], at(30)).map((entry) => (entry.kind === 'row' ? entry.row.id : entry.item.id)))
      .toEqual(['a', 'r'])
    expect(knownOutcomes([...outcomes], null)).toHaveLength(4)
  })
})
