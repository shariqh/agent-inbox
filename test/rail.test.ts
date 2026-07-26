// test/rail.test.ts
import { describe, it, expect } from 'vitest'
import {
  railProjects, railEntries, filterRailEntries, shouldShowRailFilter,
  splitClosed, closedRailEntries, suppressedTotal, closedFoldLabel,
} from '../public/rail.js'

describe('railProjects', () => {
  it('includes a project whose only trace is a live session', () => {
    const projects = railProjects({
      items: [{ project: 'api' }],
      boards: [],
      archived: [],
      activity: [{ session: 's1', project: 'ghost' }],
    })
    expect(projects).toEqual(['api', 'ghost'])
  })

  it('dedupes across items, boards, archived and activity', () => {
    const projects = railProjects({
      items: [{ project: 'web' }, { project: 'web' }],
      boards: [{ project: 'web' }],
      archived: [{ project: 'api' }],
      activity: [{ session: 's1', project: 'api' }],
    })
    expect(projects).toEqual(['api', 'web'])
  })

  it('pins unknown to the bottom even though it sorts mid-alphabet', () => {
    const projects = railProjects({ items: [{ project: 'zeta' }, { project: 'unknown' }, { project: 'api' }] })
    expect(projects).toEqual(['api', 'zeta', 'unknown'])
  })

  it('tolerates missing collections', () => {
    expect(railProjects({})).toEqual([])
    expect(railProjects()).toEqual([])
  })
})

describe('railEntries', () => {
  const counts = new Map([
    ['api', { total: 3, escalated: 1 }],
    ['web', { total: 2, escalated: 0 }],
  ])

  it('pins All first with the summed global totals', () => {
    const entries = railEntries(['api', 'web'], counts)
    expect(entries[0]).toEqual({ key: '__all__', label: 'All', total: 5, escalated: 1, unknown: false })
    expect(entries.map((e) => e.key)).toEqual(['__all__', 'api', 'web'])
  })

  it('gives projects with no attention a zero badge rather than dropping them', () => {
    const entries = railEntries(['api', 'quiet'], counts)
    expect(entries.find((e) => e.key === 'quiet')).toEqual({ key: 'quiet', label: 'quiet', total: 0, escalated: 0, unknown: false })
  })

  it('flags the unknown pseudo-project', () => {
    const entries = railEntries(['api', 'unknown'], counts)
    expect(entries.at(-1)!.unknown).toBe(true)
    expect(entries.find((e) => e.key === 'api')!.unknown).toBe(false)
  })

  // issue #32: renderRail feeds this the OPEN list only, so All automatically
  // sums to exactly the suppressed global badge. Nothing else has to be
  // subtracted anywhere, which is what keeps one predicate honest (tenet 3).
  it('All sums only the projects it was given, so it equals the suppressed badge', () => {
    const { open } = splitClosed(['api', 'web'], ['web'])
    expect(railEntries(open, counts)[0]!.total).toBe(3)
    expect(railEntries(open, counts).map((e) => e.key)).toEqual(['__all__', 'api'])
  })
})

// ── issue #32: the open/closed split and the fold's pure view models ─────────

describe('splitClosed', () => {
  it('moves closed names into the closed list, preserving railProjects order', () => {
    expect(splitClosed(['api', 'dead', 'web'], ['dead'])).toEqual({ open: ['api', 'web'], closed: ['dead'] })
  })

  it('keeps unknown pinned last on whichever side it lands', () => {
    expect(splitClosed(['api', 'web', 'unknown'], ['unknown'])).toEqual({ open: ['api', 'web'], closed: ['unknown'] })
    expect(splitClosed(['api', 'web', 'unknown'], ['web'])).toEqual({ open: ['api', 'unknown'], closed: ['web'] })
  })

  it('ignores a closed name with no remaining trace in the rail', () => {
    expect(splitClosed(['api'], ['ghost'])).toEqual({ open: ['api'], closed: [] })
  })

  it('returns everything open for an empty, missing or Set-shaped closed list', () => {
    expect(splitClosed(['api', 'web'], [])).toEqual({ open: ['api', 'web'], closed: [] })
    expect(splitClosed(['api', 'web'])).toEqual({ open: ['api', 'web'], closed: [] })
    expect(splitClosed(['api', 'web'], new Set(['web']))).toEqual({ open: ['api'], closed: ['web'] })
  })
})

describe('closedRailEntries', () => {
  const counts = new Map([
    ['dead', { total: 4, escalated: 3 }],
    ['quiet', { total: 0, escalated: 0 }],
  ])

  it("carries each closed project's live attention total — the number is relocated, not destroyed", () => {
    expect(closedRailEntries(['dead'], counts)[0]).toEqual({
      key: 'dead', label: 'dead', total: 4, escalated: 0, unknown: false,
    })
  })

  it('never marks a closed row escalated — a suppressed project must not paint red', () => {
    expect(closedRailEntries(['dead'], counts).every((e) => e.escalated === 0)).toBe(true)
  })

  it('gives a closed project with no attention a zero row rather than dropping it', () => {
    expect(closedRailEntries(['quiet', 'never-seen'], counts).map((e) => e.total)).toEqual([0, 0])
  })

  it('flags the unknown pseudo-project on the closed side too', () => {
    expect(closedRailEntries(['unknown'], counts)[0]!.unknown).toBe(true)
  })
})

describe('suppressedTotal', () => {
  it('sums the attention hidden behind the fold', () => {
    const counts = new Map([['a', { total: 2, escalated: 0 }], ['b', { total: 3, escalated: 1 }]])
    expect(suppressedTotal(closedRailEntries(['a', 'b'], counts))).toBe(5)
  })

  it('is 0 for an empty or missing fold', () => {
    expect(suppressedTotal([])).toBe(0)
    expect(suppressedTotal()).toBe(0)
  })
})

describe('closedFoldLabel', () => {
  it('is null when nothing is closed — no fold, no summary', () => {
    expect(closedFoldLabel(0, 0)).toBeNull()
  })

  it('shows the project count and the muted total when attention is suppressed', () => {
    const l = closedFoldLabel(2, 5)!
    expect(l.text).toBe('Closed (2)')
    expect(l.muted).toBe('5 muted')
    expect(l.hint).toContain('not counted in the badge')
  })

  it('drops the muted chip when the closed projects hold no attention at all', () => {
    const l = closedFoldLabel(1, 0)!
    expect(l.muted).toBe('')
    expect(l.hint).toBe('1 closed project')
  })

  it('degrades to the bare count at narrow width but keeps the sentence in the hint', () => {
    const l = closedFoldLabel(3, 2, 'narrow')!
    expect(l.text).toBe('3')
    expect(l.hint).toContain('3 closed projects')
    expect(l.hint).toContain('2 items muted')
  })

  it('says "item" and "project" in the singular — a count of one must not read as a bug', () => {
    expect(closedFoldLabel(1, 1)!.hint).toBe('1 closed project · 1 item muted — not counted in the badge')
  })
})

describe('shouldShowRailFilter', () => {
  const names = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`)

  it('stays hidden at twelve projects and appears at thirteen', () => {
    expect(shouldShowRailFilter(names(12))).toBe(false)
    expect(shouldShowRailFilter(names(13))).toBe(true)
  })

  it('is hidden for an empty or missing list', () => {
    expect(shouldShowRailFilter([])).toBe(false)
    expect(shouldShowRailFilter(undefined)).toBe(false)
  })
})

describe('filterRailEntries', () => {
  const entries = [
    { key: '__all__', label: 'All', total: 5, escalated: 1, unknown: false },
    { key: 'agent-inbox', label: 'agent-inbox', total: 3, escalated: 1, unknown: false },
    { key: 'web', label: 'web', total: 2, escalated: 0, unknown: false },
  ]

  it('returns everything for an empty or whitespace query', () => {
    expect(filterRailEntries(entries, '')).toEqual(entries)
    expect(filterRailEntries(entries, '   ')).toEqual(entries)
    expect(filterRailEntries(entries, undefined)).toEqual(entries)
  })

  it('matches case-insensitively on a substring of the label', () => {
    expect(filterRailEntries(entries, 'INBOX').map((e) => e.key)).toEqual(['__all__', 'agent-inbox'])
  })

  it('always retains All, even when nothing else matches', () => {
    expect(filterRailEntries(entries, 'zzz').map((e) => e.key)).toEqual(['__all__'])
  })
})
