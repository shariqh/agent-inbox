import { describe, it, expect } from 'vitest'
import uFuzzy from '@leeoniya/ufuzzy'
import { haystackFor, searchMatches, paginate, paginateGroups } from '../public/search.js'

describe('haystackFor', () => {
  it('includes item fields, lowercased', () => {
    const h = haystackFor({ id: '1', title: 'Fix Auth', detail: 'JWT bug', project: 'API', agent: 'claude', reply: 'go ahead' })
    expect(h).toBe('fix auth api claude jwt bug go ahead')
  })
  it('includes board row text and is lowercased', () => {
    const h = haystackFor({ id: 'b1', title: 'Rollout', project: 'Web', rows: [{ label: 'Deploy', note: 'Staging first' }] })
    expect(h).toContain('deploy')
    expect(h).toContain('staging first')
    expect(h).toContain('rollout')
    expect(h).toBe(h.toLowerCase())
  })
})

describe('searchMatches', () => {
  const ents = [{ id: 'a', title: 'alpha' }, { id: 'b', title: 'beta' }, { id: 'c', title: 'gamma' }]
  it('returns null for empty/whitespace query', () => {
    expect(searchMatches(ents, '', () => [])).toBeNull()
    expect(searchMatches(ents, '   ', () => [])).toBeNull()
  })
  it('maps filter indices back to ids', () => {
    expect(searchMatches(ents, 'x', () => [0, 2])).toEqual(new Set(['a', 'c']))
  })
  it('returns an empty Set (not null) when the filter finds nothing', () => {
    expect(searchMatches(ents, 'x', () => null)).toEqual(new Set())
    expect(searchMatches(ents, 'x', () => [])).toEqual(new Set())
  })
  it('works end-to-end with the real uFuzzy engine', () => {
    const uf = new uFuzzy({ intraMode: 1 })
    const rows = [
      { id: 'x', title: 'Auth board', project: 'api' },
      { id: 'y', title: 'Billing rollout', project: 'web' },
    ]
    const set = searchMatches(rows, 'auth', (hay, needle) => uf.filter(hay, needle))!
    expect(set.has('x')).toBe(true)
    expect(set.has('y')).toBe(false)
  })
})

describe('paginate', () => {
  it('slices to the limit and reports the remainder', () => {
    expect(paginate([1, 2, 3, 4, 5], 3)).toEqual({ visible: [1, 2, 3], remaining: 2 })
  })
  it('remaining is 0 when under the limit', () => {
    expect(paginate([1, 2], 5)).toEqual({ visible: [1, 2], remaining: 0 })
  })
})

describe('paginateGroups', () => {
  const groups = [
    { project: 'a', items: [1, 2, 3] },
    { project: 'b', items: [4, 5] },
    { project: 'c', items: [6] },
  ]
  it('spends the budget across groups and truncates the last', () => {
    const r = paginateGroups(groups, 4)
    expect(r.groups).toEqual([{ project: 'a', items: [1, 2, 3] }, { project: 'b', items: [4] }])
    expect(r.remaining).toBe(2)
  })
  it('drops groups past the budget', () => {
    const r = paginateGroups(groups, 3)
    expect(r.groups).toEqual([{ project: 'a', items: [1, 2, 3] }])
    expect(r.remaining).toBe(3)
  })
  it('remaining is 0 when everything fits', () => {
    expect(paginateGroups(groups, 10).remaining).toBe(0)
  })
})
