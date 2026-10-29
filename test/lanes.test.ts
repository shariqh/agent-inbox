import { describe, expect, it } from 'vitest'
import { MAX_LOOPS, QUIET_MS, buildLanes, laneMotion, pinLaneOrder } from '../public/lanes.js'
import { attentionEntries, sortRail } from '../public/attention.js'
import type { Lane } from '../public/lanes.js'

const NOW = Date.parse('2026-10-28T20:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const MIN = 60_000

const session = (id: string, extra: Record<string, unknown> = {}) => ({
  session: id, project: 'alpha', stream: 'main', agent: 'copilot', doing: `Working on ${id}`, idle: false,
  started_at: ago(60 * MIN), updated_at: ago(0), last_call_at: ago(MIN), ...extra,
})
const lanesOf = (activity: ReturnType<typeof session>[], boards: any[] = [], items: any[] = []) =>
  buildLanes({
    activity,
    boards,
    asks: sortRail(attentionEntries(items, boards, NOW, activity.map((a) => a.session)), NOW),
    nowMs: NOW,
  })
const progress = (rows: Array<{ status: string }>) => {
  const counts: Record<string, number> = { done: 0, partial: 0, missing: 0, tracked: 0, na: 0, blocked: 0 }
  for (const row of rows) counts[row.status]! += 1
  return { ...counts, total: rows.length, countable: rows.length - counts.na!, fraction: 0 }
}
const plan = (id: string, updated: string, rows: any[], extra: Record<string, unknown> = {}) => ({
  id, project: 'alpha', stream: 'main', agent: 'copilot', title: `Plan ${id}`, updated_at: updated,
  rows: rows.map((row, i) => ({ id: `${id}-${i}`, label: `Step ${i}`, annotation: null, ...row })),
  progress: progress(rows), ...extra,
})

describe('lane model (#304)', () => {
  it('reads work from the claim and last_call_at, never from the updated_at heartbeat', () => {
    const model = lanesOf([
      session('calling'),
      session('first-call-pending', { last_call_at: null, started_at: ago(MIN) }),
      session('heartbeat-only', { last_call_at: ago(40 * MIN) }),
      session('never-called', { last_call_at: null, started_at: ago(40 * MIN) }),
      session('released', { idle: true, last_call_at: ago(0) }),
    ])
    expect(model.lanes.map((lane) => lane.session)).toEqual(['calling', 'first-call-pending'])
    expect(model.idle).toBe(3)
    expect(model.now.working).toBe(2)
    // The heartbeat moving changes nothing.
    const heartbeat = lanesOf([session('calling', { updated_at: ago(29 * MIN) })])
    expect(heartbeat.lanes[0]!.sinceMs).toBe(MIN)
  })

  it('says quiet once a working lane has gone five minutes without a call', () => {
    expect(QUIET_MS).toBe(5 * MIN)
    const model = lanesOf([
      session('busy', { last_call_at: ago(QUIET_MS - 1000) }),
      session('quiet', { last_call_at: ago(12 * MIN) }),
    ])
    expect(model.lanes.map((lane) => [lane.session, lane.quiet, lane.sinceMs])).toEqual([
      ['busy', false, QUIET_MS - 1000],
      ['quiet', true, 12 * MIN],
    ])
  })

  it('joins the most recently updated active plan by project, branch and agent', () => {
    const boards = [
      plan('old', ago(30 * MIN), [{ status: 'done' }]),
      plan('new', ago(5 * MIN), [
        { status: 'done' }, { status: 'done' }, { status: 'partial' }, { status: 'blocked' },
        { status: 'blocked', annotation: 'answered' }, { status: 'blocked', snoozed_until: ago(-60 * MIN) },
        { status: 'missing' }, { status: 'tracked' }, { status: 'na' },
      ]),
      plan('other-branch', ago(0), [{ status: 'done' }], { stream: 'feature' }),
      plan('other-agent', ago(0), [{ status: 'done' }], { agent: 'claude-code' }),
      plan('other-project', ago(0), [{ status: 'done' }], { project: 'beta' }),
    ]
    const [lane] = lanesOf([session('s')], boards).lanes
    expect(lane!.plan).toEqual({
      id: 'new', title: 'Plan new', done: 2, countable: 8,
      // Only the row the attention predicate counts waits on you; answered and snoozed rows are to do.
      segments: { done: 2, partial: 1, waiting: 1, todo: 4 },
    })
    expect(lanesOf([session('s', { stream: 'elsewhere' })], boards).lanes[0]!.plan).toBeNull()
  })

  it('totals the Now strip plan steps from the lanes bars, each plan once', () => {
    const boards = [
      plan('shared', ago(0), [{ status: 'done' }, { status: 'missing' }]),
      plan('own', ago(0), [{ status: 'done' }, { status: 'done' }, { status: 'tracked' }], { agent: 'claude-code' }),
      plan('unlinked', ago(0), [{ status: 'done' }, { status: 'missing' }], { stream: 'nobody' }),
    ]
    const model = lanesOf([session('a'), session('b'), session('c', { agent: 'claude-code' })], boards)
    const unique = new Map(model.lanes.flatMap((lane) => lane.plan ? [[lane.plan.id, lane.plan]] : []))
    const bars = [...unique.values()].reduce((sum, bar) => ({ done: sum.done + bar.done, countable: sum.countable + bar.countable }), { done: 0, countable: 0 })
    expect(model.now.plans).toEqual(bars)
    expect(model.now.plans).toEqual({ done: 3, countable: 5 })
  })

  it('hands a lane its own asks in rail order, and its oldest as "waiting on you"', () => {
    const boards = [plan('p', ago(0), [{ status: 'blocked', action_started_at: ago(30 * MIN) }])]
    const items = [
      { id: 'mine-new', project: 'alpha', kind: 'question', status: 'open', title: 'Mine, new', session: 's', created_at: ago(10 * MIN) },
      { id: 'mine-old', project: 'alpha', kind: 'question', status: 'open', title: 'Mine, old', session: 's', created_at: ago(120 * MIN) },
      { id: 'theirs', project: 'alpha', kind: 'question', status: 'open', title: 'Theirs', session: 't', created_at: ago(300 * MIN) },
    ]
    const model = lanesOf([session('s'), session('t', { agent: 'claude-code' })], boards, items)
    const lane = model.lanes.find((l) => l.session === 's')!
    const ids = lane.asks.map((entry) => entry.kind === 'item' ? entry.item.id : entry.row.id)
    expect(ids).toEqual(['mine-old', 'mine-new', 'p-0'])
    expect(lane.waiting).toEqual({ entry: lane.asks[0], ms: 120 * MIN })
    expect(model.now.waiting).toBe(4)
    expect(model.now.oldestWaitingMs).toBe(300 * MIN)
    expect(model.lanes.find((l) => l.session === 't')!.asks).toHaveLength(1)
  })
})

describe('lane order and motion (#304, proposal §10)', () => {
  it('pins lane order between forced paints and appends new sessions', () => {
    const lanes = (...ids: string[]) => ids.map((id) => ({ session: id }))
    expect(pinLaneOrder([], lanes('a', 'b'))).toEqual(['a', 'b'])
    expect(pinLaneOrder(['a', 'b'], lanes('c', 'b', 'a'))).toEqual(['a', 'b', 'c'])
    expect(pinLaneOrder(['a', 'b', 'c'], lanes('c', 'a'))).toEqual(['a', 'c'])
  })

  it('keeps every loop within the cap and sweeps only the lane with the newest call', () => {
    const lane = (id: string, sinceMs: number, children = 3): Lane => ({
      session: id, project: 'alpha', branch: 'main', agent: 'copilot', doing: 'x', detail: '', lastCallAt: ago(sinceMs),
      sinceMs, quiet: false, children: Array.from({ length: children }, (_, i) => ({ name: `c${i}`, doing: '' })),
      plan: null, asks: [], waiting: null,
    })
    const crowded = Array.from({ length: 12 }, (_, i) => lane(`l${i}`, (12 - i) * 1000))
    const busy = laneMotion(crowded)
    expect(busy.sweep).toBe('l11')
    expect(busy.pulse.size + busy.childPulse.size + 1).toBe(MAX_LOOPS)
    expect(busy.childPulse.size).toBe(0)

    const few = laneMotion([lane('a', 5000, 2), lane('b', 1000, 1)])
    expect(few.sweep).toBe('b')
    expect([...few.pulse]).toEqual(['a', 'b'])
    expect(few.childPulse.size).toBe(3)
    expect(laneMotion([])).toEqual({ sweep: null, pulse: new Set(), childPulse: new Set() })
  })
})
