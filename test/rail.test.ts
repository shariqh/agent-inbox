// test/rail.test.ts
import { describe, it, expect } from 'vitest'
import { railProjects, railEntries, filterRailEntries, shouldShowRailFilter } from '../public/rail.js'

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
