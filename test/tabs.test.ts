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
  it('boots to Dashboard and keeps Live as a footer strip rather than a tab', () => {
    expect(DEFAULT_TAB).toBe('dashboard')
    expect(TAB_IDS).toEqual(['dashboard', 'needsYou', 'boards', 'notes', 'done'])
    expect(TAB_IDS[0]).toBe(DEFAULT_TAB)
  })

  // (A `livePresence still works — the footer strip reuses it` case used to sit
  // here. The claim was false — livebar.js's liveSummary derives `!a.idle`
  // itself — and it was the only caller, which is exactly how a dead export
  // keeps looking load-bearing. Both are gone; test/livebar.test.ts covers the
  // real presence read. Issue #31.4.)

  it('counts the scoped view for boards and done, and takes notes as a precomputed number', () => {
    const c = tabCounts({
      globalAttention: 7,
      unreadNotes: 2,
      scoped: { boards: [{ id: 'b1' }], done: [{ id: 'd1' }] },
    })
    expect(c).toEqual({ needsYou: 7, boards: 1, notes: 2, done: 1 })
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

describe('Notes count is unread-only (spec §8)', () => {
  it('reports the unread note count, not how many notes are on screen', () => {
    const c = tabCounts({
      globalAttention: 0,
      unreadNotes: 1,
      scoped: { boards: [], notes: [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }], done: [] },
    })
    expect(c.notes).toBe(1)
  })
  it('is 0 once every note has been seen, even with notes in the list', () => {
    const c = tabCounts({
      globalAttention: 0,
      unreadNotes: 0,
      scoped: { boards: [], notes: [{ id: 'n1' }, { id: 'n2' }], done: [] },
    })
    expect(c.notes).toBe(0)
  })
})
