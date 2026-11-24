// test/tabs.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { TAB_IDS, DEFAULT_TAB, tabCounts } from '../public/tabs.js'
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
  it('boots to Home and keeps Live as a footer strip rather than a tab', () => {
    expect(DEFAULT_TAB).toBe('dashboard')
    // Home (`dashboard`) holds the asks: there is no separate Inbox tab.
    // UX pass, slice 4: Find in place of Notes and History, after Plans, and (step B) of Chats
    // `cards` (Agent cards step 1): last, shown only while the mesh is on
    expect(TAB_IDS).toEqual(['dashboard', 'boards', 'find', 'cards'])
    expect(TAB_IDS[0]).toBe(DEFAULT_TAB)
  })

  // (A `livePresence still works — the footer strip reuses it` case used to sit
  // here. The claim was false — livebar.js's liveSummary derives `!a.idle`
  // itself — and it was the only caller, which is exactly how a dead export
  // keeps looking load-bearing. Both are gone; test/livebar.test.ts covers the
  // real presence read. Issue #31.4.)

  it('counts the scoped view for boards, and takes Find\'s unread notes as a precomputed number', () => {
    const c = tabCounts({
      globalAttention: 7,
      unreadNotes: 2,
      scoped: { boards: [{ id: 'b1' }] },
    })
    // UX pass, slice 4: History's total went with its page
    expect(c).toEqual({ dashboard: 7, boards: 1, find: 2 })
  })

  it('never counts the Agent cards tab (Agent cards step 1, D1)', () => {
    const c = tabCounts({ globalAttention: 7, unreadNotes: 2, scoped: { boards: [{ id: 'b1' }] } })
    expect('cards' in c).toBe(false)
    expect('agent' in c).toBe(false)
  })

  it('treats a missing notes number as zero rather than NaN', () => {
    expect(tabCounts({ globalAttention: 0, scoped: { boards: [] } }).find).toBe(0)
  })
})

describe('filter-blindness invariant (spec §7)', () => {
  const live = new Set(['s1'])
  const global = attentionCount(items as never, boards as never, NOW, live)

  it('Home\'s count ignores the project filter that empties the list', () => {
    const scopedToApi = { boards: boards.filter((b) => b.project === 'api') }
    const scopedToNothing = { boards: [] }
    expect(global).toBeGreaterThan(1) // api + web both contribute
    expect(tabCounts({ globalAttention: global, unreadNotes: 0, scoped: scopedToApi }).dashboard).toBe(global)
    expect(tabCounts({ globalAttention: global, unreadNotes: 0, scoped: scopedToNothing }).dashboard).toBe(global)
    expect(tabCounts({ globalAttention: global, unreadNotes: 0, scoped: scopedToNothing }).boards).toBe(0)
  })

  it('scoping to one project still narrows every non-global count', () => {
    const apiOnly = tabCounts({ globalAttention: global, unreadNotes: 1, scoped: { boards: boards.filter((b) => b.project === 'api') } })
    expect(apiOnly.boards).toBe(1)
    expect(apiOnly.find).toBe(1)
    expect(apiOnly.dashboard).toBe(global) // the one count the filter may never touch
  })
})

// tabCounts() above is pure — it just echoes whatever `globalAttention` number
// it is handed, so those tests can't catch a regression where the REAL call
// site in render() (public/app.js) accidentally wires the locally-shadowed,
// filtered `g`/`boards` into that argument instead of the unfiltered
// `lastData.g`/`lastData.boards`. The rail makes project filtering the
// primary navigation (spec §7), so this one line is the only thing standing
// between "Needs you" and silently hiding attention behind whatever project
// is selected — exactly the failure this task exists to prevent. This pins the
// SOURCE TEXT: WHICH data the call site passes, which is the invariant itself
// and is invisible to any runtime assertion (a render can agree with the badge
// by coincidence on one fixture). Do not delete this as "just a string match".
// test/dom/boot.test.ts drives the same rule through a real rail click.
describe('filter-blindness is pinned at the render() call site (spec §7)', () => {
  const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')

  it('computes globalAttention from the unfiltered lastData, not the filtered g/boards', () => {
    const line = js.split('\n').find((l) => l.includes('globalAttention:'))
    expect(line, 'no globalAttention: line found in app.js').toBeTruthy()
    expect(line, line).toMatch(/globalAttention:\s*attentionCount\(/)
    expect(line, line).toMatch(/lastData\.g\b/)
    expect(line, line).toMatch(/lastData\.boards\b/)
  })
})

describe('Find\'s count is unread notes only (spec §8)', () => {
  it('reports the unread note count, not how many notes are on screen', () => {
    const c = tabCounts({ globalAttention: 0, unreadNotes: 1, scoped: { boards: [] } })
    expect(c.find).toBe(1)
  })
  it('is 0 once every note has been seen, even with notes in the list', () => {
    const c = tabCounts({ globalAttention: 0, unreadNotes: 0, scoped: { boards: [] } })
    expect(c.find).toBe(0)
  })
})
