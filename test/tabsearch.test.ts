import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import uFuzzy from '@leeoniya/ufuzzy'
import { liveEntity, searchIndex, tabMatchCounts, projectMatchCounts, otherTabMatches, elsewhereLabel } from '../public/tabsearch.js'

const uf = new uFuzzy({ intraMode: 1 })
const fuzzy = (hay: string[], needle: string) => uf.filter(hay, needle)

const data = {
  g: {
    needsYou: [{ project: 'api', items: [{ id: 'q1', title: 'rotate the auth token', project: 'api', agent: 'claude' }] }],
    notes: [{ project: 'web', items: [{ id: 'n1', title: 'auth cookie workaround', project: 'web', agent: 'claude' }] }],
    done: [{ id: 'd1', title: 'billing migration', project: 'web', agent: 'claude' }],
  },
  boards: [{ id: 'b1', title: 'Auth rollout', project: 'api', agent: 'claude', rows: [{ label: 'Deploy', note: '' }] }],
  archived: [{ id: 'b2', title: 'Old auth spike', project: 'infra', agent: 'claude', rows: [] }],
  activity: [
    { session: 's1', project: 'infra', agent: 'claude', stream: '', doing: 'wiring auth headers', detail: '', children: [] },
    { session: 's2', project: 'web', agent: 'codex', stream: '', doing: 'writing docs', detail: '', children: [{ name: 'sub', doing: 'lint' }] },
  ],
}

describe('liveEntity', () => {
  it('flattens a session (and its children) into a haystack-shaped entity', () => {
    const e = liveEntity(data.activity[1]!)
    expect(e.id).toBe('s2')
    expect(e.title).toBe('writing docs')
    expect(e.detail).toBe('sub lint')
  })
})

describe('searchIndex', () => {
  it('returns null per tab when there is no query (everything shows)', () => {
    const idx = searchIndex(data, '  ', fuzzy)
    expect(idx.needsYou).toBeNull()
    expect(idx.boards).toBeNull()
    expect(idx.live).toBeNull()
  })
  it('indexes each tab independently, across the whole dataset', () => {
    const idx = searchIndex(data, 'auth', fuzzy)
    expect([...idx.needsYou!]).toEqual(['q1'])
    expect([...idx.notes!]).toEqual(['n1'])
    expect([...idx.boards!].sort()).toEqual(['b1', 'b2'])
    expect([...idx.live!]).toEqual(['s1'])
    expect([...idx.done!]).toEqual([])
  })
})

describe('tabMatchCounts', () => {
  it('counts matches behind every tab, not just the active one', () => {
    expect(tabMatchCounts(data, 'auth', fuzzy)).toEqual({ needsYou: 1, boards: 2, live: 1, notes: 1, done: 0 })
  })
  it('is all-null with no query', () => {
    expect(tabMatchCounts(data, '', fuzzy)).toEqual({ needsYou: null, boards: null, live: null, notes: null, done: null })
  })
})

describe('projectMatchCounts', () => {
  it('counts matching entities per project across all tabs', () => {
    const m = projectMatchCounts(data, 'auth', fuzzy)
    expect(m.get('api')).toBe(2)   // q1 + b1
    expect(m.get('web')).toBe(1)   // n1
    expect(m.get('infra')).toBe(2) // b2 + s1
  })
  it('is empty with no query', () => {
    expect(projectMatchCounts(data, '', fuzzy).size).toBe(0)
  })
})

describe('otherTabMatches', () => {
  it('lists the tabs holding matches you are not looking at', () => {
    const counts = { needsYou: 0, boards: 2, live: 1, notes: 1, done: 0 }
    expect(otherTabMatches(counts, 'needsYou')).toEqual([{ tab: 'boards', n: 2 }, { tab: 'live', n: 1 }, { tab: 'notes', n: 1 }])
  })
  it('is empty when nothing matches anywhere else', () => {
    expect(otherTabMatches({ needsYou: 3, boards: 0, live: 0, notes: 0, done: 0 }, 'needsYou')).toEqual([])
  })
  it('is empty with no query (null counts)', () => {
    expect(otherTabMatches({ needsYou: null, boards: null, live: null, notes: null, done: null }, 'needsYou')).toEqual([])
  })
})

// Issue #31.3: the §12 pointer ("2 in Boards · 1 in Notes") used to exist only
// as a fragment inside app.js's emptyMsg, so the ONE path that must not print
// emptyMsg — a Needs-you search whose only hits are inside the collapsed stale
// fold (fix round 2 / I2) — lost the pointer along with the false "no matches"
// claim, and printed nothing at all. Lifting it here gives both surfaces one
// builder. Label map injected so this module stays presentation-free.
describe('elsewhereLabel', () => {
  const LABELS = { needsYou: 'Needs you', boards: 'Boards', live: 'Live', notes: 'Notes', done: 'Done' } as const
  it('names the tabs holding matches you are not looking at', () => {
    const counts = { needsYou: 1, boards: 2, live: 0, notes: 1, done: 0 }
    expect(elsewhereLabel(counts, 'needsYou', LABELS)).toBe('2 in Boards · 1 in Notes')
  })
  it('is empty when the only matches are in the active tab', () => {
    expect(elsewhereLabel({ needsYou: 3, boards: 0, live: 0, notes: 0, done: 0 }, 'needsYou', LABELS)).toBe('')
  })
  it('is empty with no query (null counts)', () => {
    expect(elsewhereLabel({ needsYou: null, boards: null, live: null, notes: null, done: null }, 'needsYou', LABELS)).toBe('')
  })
  it('falls back to the raw tab id when no label is supplied', () => {
    expect(elsewhereLabel({ needsYou: 0, boards: 1, live: 0, notes: 0, done: 0 }, 'needsYou')).toBe('1 in boards')
  })
})

// fix round 1: matchCounts/otherTabMatches were originally fed RAW `lastData`
// in app.js's render() — unscoped by the active project/agent rail filter.
// Repro: rail filtered to project 'web'; the only match ('auth') lives on a
// needsYou item under project 'api'. The rendered needsYou list is empty
// (filterData() drops the 'api' item before applySearch even sees it), but
// the raw-data matchCounts.needsYou would still read 1 — and since no OTHER
// tab has an unfiltered match either, otherTabMatches() comes back empty and
// emptyMsg() renders "No matches ... or in any other tab", which is FALSE:
// the match exists, just behind the project pill, not behind another tab.
// The fix scopes tabMatchCounts' INPUT by project/agent (matching what
// render() actually shows), while projectMatchCounts stays fed the GLOBAL
// `lastData` on purpose — the rail's per-project badge is how the user
// discovers a match sitting behind a DIFFERENT project pill. This pins the
// SOURCE TEXT at the call site — WHICH of the two datasets each counter is
// fed, which no rendered output can distinguish — the same way
// test/tabs.test.ts's filter-blindness guard and test/shell.test.ts's
// Live-strip-global guard do. The rendered consequence (an empty state that
// never denies a match a fold is holding) is covered in
// test/dom/render-agreement.test.ts.
describe('tabMatchCounts is scoped by the active rail filter, not fed raw lastData (fix round 1, spec §12 generalized)', () => {
  const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  const m = js.match(/function render\(\)[\s\S]*?\n\}/)
  const body = m ? m[0] : ''

  it('render() exists and was matched', () => {
    expect(body, 'render() not found in app.js').toBeTruthy()
  })

  it('feeds tabMatchCounts data derived from filterData(lastData) — a match hidden by the rail filter must not be counted as reachable', () => {
    const line = body.split('\n').find((l) => l.includes('tabMatchCounts('))
    expect(line, 'no tabMatchCounts( call found in render()').toBeTruthy()
    expect(line, line).not.toMatch(/tabMatchCounts\(\s*lastData\s*,/)
  })

  it('keeps projectMatchCounts fed the GLOBAL lastData — the rail badge is how the user discovers a match under a different project pill', () => {
    const line = body.split('\n').find((l) => l.includes('projectMatchCounts('))
    expect(line, 'no projectMatchCounts( call found in render()').toBeTruthy()
    expect(line, line).toMatch(/projectMatchCounts\(\s*lastData\s*,/)
  })
})
