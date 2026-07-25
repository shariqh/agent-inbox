// test/tabs.test.ts
import { describe, it, expect } from 'vitest'
import { TAB_IDS, DEFAULT_TAB, tabCounts, livePresence } from '../public/tabs.js'
import { attentionCount } from '../public/attention.js'

const NOW = Date.parse('2026-07-24T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

const items = [
  { id: 'q1', kind: 'question', status: 'open', project: 'api', session: 's1', created_at: ago(10 * 60000), reply: null },
  { id: 'q2', kind: 'question', status: 'open', project: 'web', session: 's2', created_at: ago(10 * 60000), reply: null },
]
const boards = [
  { id: 'b1', project: 'api', title: 'Rollout', rows: [{ id: 'r1', label: 'deploy', status: 'blocked' }] },
]

describe('tab model', () => {
  it('boots to Needs you and lists the five content tabs in order', () => {
    expect(DEFAULT_TAB).toBe('needsYou')
    expect(TAB_IDS).toEqual(['needsYou', 'boards', 'live', 'notes', 'done'])
    expect(TAB_IDS[0]).toBe(DEFAULT_TAB)
  })

  it('gives Live no number — presence is a dot', () => {
    const c = tabCounts({ globalAttention: 0, unreadNotes: 0, scoped: { boards: [], done: [] } })
    expect(c.live).toBeNull()
    expect(livePresence([{ session: 's1', idle: true }])).toBe(false)
    expect(livePresence([{ session: 's1', idle: true }, { session: 's2', idle: false }])).toBe(true)
    expect(livePresence(undefined)).toBe(false)
  })

  it('counts the scoped view for boards and done, and takes notes as a precomputed number', () => {
    const c = tabCounts({
      globalAttention: 7,
      unreadNotes: 2,
      scoped: { boards: [{ id: 'b1' }], done: [{ id: 'd1' }] },
    })
    expect(c).toEqual({ needsYou: 7, boards: 1, live: null, notes: 2, done: 1 })
  })

  it('treats a missing notes number as zero rather than NaN', () => {
    expect(tabCounts({ globalAttention: 0, scoped: { boards: [], done: [] } }).notes).toBe(0)
  })
})

describe('filter-blindness invariant (spec §7)', () => {
  const live = new Set(['s1'])
  const global = attentionCount(items as never, boards as never, NOW, live)

  it('the Needs-you tab count ignores the project filter that empties the list', () => {
    const scopedToApi = { boards: boards.filter((b) => b.project === 'api'), done: [] }
    const scopedToNothing = { boards: [], done: [] }
    expect(global).toBeGreaterThan(1) // api + web both contribute
    expect(tabCounts({ globalAttention: global, unreadNotes: 0, scoped: scopedToApi }).needsYou).toBe(global)
    expect(tabCounts({ globalAttention: global, unreadNotes: 0, scoped: scopedToNothing }).needsYou).toBe(global)
    expect(tabCounts({ globalAttention: global, unreadNotes: 0, scoped: scopedToNothing }).boards).toBe(0)
  })

  it('scoping to one project still narrows every non-global count', () => {
    const apiOnly = tabCounts({ globalAttention: global, unreadNotes: 1, scoped: { boards: boards.filter((b) => b.project === 'api'), done: [] } })
    expect(apiOnly.boards).toBe(1)
    expect(apiOnly.notes).toBe(1)
    expect(apiOnly.done).toBe(0)
    expect(apiOnly.needsYou).toBe(global) // the one count the filter may never touch
  })
})
