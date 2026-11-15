// Dashboard lanes PR 6 (docs/superpowers/specs/2026-11-13-dashboard-lanes-design.md
// §3.5): the Plans in progress lane's model. Which plans qualify, the numbers
// (planBar's, so one definition of countable and of "needs you"), the order
// and the cap of six.
import { describe, expect, it } from 'vitest'
import { PLANS_EMPTY, PLANS_LANE_CAP, capPlans, isOpenRow, plansInProgress } from '../public/plans-lane.js'

const NOW = Date.parse('2026-11-14T12:00:00.000Z')
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()

const plan = (id: string, rows: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
  id, project: 'alpha', title: `Plan ${id}`, status: 'active', updated_at: ago(10),
  progress: { done: rows.filter((r) => r.status === 'done').length, partial: rows.filter((r) => r.status === 'partial').length, countable: rows.filter((r) => r.status !== 'na').length },
  rows: rows.map((r, index) => ({ id: `${id}-r${index}`, label: `Step ${index}`, ...r })),
  ...extra,
})
const ask = { status: 'blocked', action_owner: 'task' }
const ids = (list: Array<{ id: string }>) => list.map((p) => p.id)

describe('the Plans in progress lane’s model (lanes PR 6, §3.5)', () => {
  it('counts a row as open unless it is done or na', () => {
    for (const status of ['missing', 'partial', 'tracked', 'blocked']) expect(isOpenRow({ status }), status).toBe(true)
    for (const status of ['done', 'na']) expect(isOpenRow({ status }), status).toBe(false)
  })

  it('lists only active plans with an open row', () => {
    const boards = [
      plan('open', [{ status: 'done' }, { status: 'missing' }]),
      plan('all-done', [{ status: 'done' }, { status: 'done' }]),
      plan('all-na', [{ status: 'na' }, { status: 'na' }]),
      plan('done-and-na', [{ status: 'done' }, { status: 'na' }]),
      plan('no-rows', []),
      plan('archived', [{ status: 'missing' }], { status: 'archived' }),
    ]
    expect(ids(plansInProgress(boards, NOW))).toEqual(['open'])
  })

  it('takes done, countable and waiting from planBar; an answered ask is not waiting', () => {
    const board = plan('p', [{ status: 'done' }, ask, ask, { ...ask, annotation: 'Did it.' }, { status: 'missing' }])
    board.progress = { done: 7, partial: 1, countable: 15 }
    const [only] = plansInProgress([board], NOW)
    expect(only).toMatchObject({ id: 'p', title: 'Plan p', project: 'alpha', done: 7, countable: 15, waiting: 2 })
    expect(only!.updatedAt).toBe(board.updated_at)
    expect(only!.updatedMs).toBe(Date.parse(board.updated_at))
  })

  it('a plan with no countable rows gives zeros, never NaN', () => {
    // a plan read without its progress (an older server) still shows 0/0
    const board: Record<string, unknown> = plan('p', [{ status: 'missing' }])
    delete board.progress
    const [only] = plansInProgress([board as never], NOW)
    expect(only).toMatchObject({ done: 0, countable: 0, waiting: 0 })
  })

  it('orders plans waiting on you first, then the newest change, then the id', () => {
    const boards = [
      plan('b-new', [{ status: 'missing' }], { updated_at: ago(1) }),
      plan('a-tie', [{ status: 'missing' }], { updated_at: ago(5) }),
      plan('c-tie', [{ status: 'missing' }], { updated_at: ago(5) }),
      plan('waits-old', [ask], { updated_at: ago(500) }),
      plan('no-stamp', [{ status: 'missing' }], { updated_at: 'not a date' }),
      plan('waits-newer', [ask], { updated_at: ago(50) }),
    ]
    const out = plansInProgress(boards, NOW)
    expect(ids(out)).toEqual(['waits-newer', 'waits-old', 'b-new', 'a-tie', 'c-tie', 'no-stamp'])
    expect(out.at(-1)).toMatchObject({ updatedAt: null, updatedMs: null })
  })

  it('shows six and counts the rest', () => {
    expect(PLANS_LANE_CAP).toBe(6)
    const eight = ['1', '2', '3', '4', '5', '6', '7', '8']
    expect(capPlans(eight)).toEqual({ shown: eight.slice(0, 6), more: 2 })
    expect(capPlans(['1', '2', '3'])).toEqual({ shown: ['1', '2', '3'], more: 0 })
    expect(capPlans([])).toEqual({ shown: [], more: 0 })
    expect(PLANS_EMPTY).toBe('No plan in this view has open steps.')
  })

  it('copies agent text as given: the DOM sets it as text', () => {
    const [only] = plansInProgress([plan('p', [{ status: 'missing' }], { title: '<b>x</b>', project: '<i>y</i>' })], NOW)
    expect(only).toMatchObject({ title: '<b>x</b>', project: '<i>y</i>' })
  })
})
