import { describe, it, expect } from 'vitest'
import { haystackFor, paginate, paginateGroups } from '../public/search.js'

describe('haystackFor', () => {
  it('includes item fields, lowercased', () => {
    const h = haystackFor({
      id: '1', title: 'Fix Auth', detail: 'JWT bug', next_step: 'Rotate the token',
      project: 'API', agent: 'claude', reply: 'go ahead', reply_context: 'start with tmcc',
    })
    expect(h).toBe('fix auth api claude jwt bug rotate the token go ahead start with tmcc')
  })
  it('includes board row text and is lowercased', () => {
    const h = haystackFor({
      id: 'b1', title: 'Rollout', project: 'Web',
      rows: [{
        label: 'Deploy',
        note: 'Staging first',
        next_step: 'Approve production',
        options: [{ label: 'Ship now', detail: 'Canary is green' }, { label: 'Hold' }],
      }],
    })
    expect(h).toContain('deploy')
    expect(h).toContain('staging first')
    expect(h).toContain('approve production')
    expect(h).toContain('ship now')
    expect(h).toContain('canary is green')
    expect(h).toContain('rollout')
    expect(h).toBe(h.toLowerCase())
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
