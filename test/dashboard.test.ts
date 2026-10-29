import { describe, expect, it } from 'vitest'
import { buildActivitySeries, buildDashboard } from '../public/dashboard.js'
import { attentionEntries, sortNeedsYou, sortRail } from '../public/attention.js'
import type { DashboardModel } from '../public/dashboard.js'

const NOW = Date.parse('2026-08-24T20:00:00.000Z')

const ask = (id: string, created: string, extra: Record<string, unknown> = {}) => ({
  id, project: 'alpha', agent: 'copilot', kind: 'question', status: 'open', title: id,
  created_at: created, reply: null, ...extra,
})
const railIds = (model: DashboardModel): string[] =>
  model.rail.cards.map((entry) => entry.kind === 'item' ? entry.item.id : entry.row.id)

describe('the Needs you rail (#303)', () => {
  const items = [
    ask('parked-old', '2026-08-24T12:00:00.000Z'),
    ask('waiting-new', '2026-08-24T19:00:00.000Z', { session: 'live' }),
    ask('waiting-old', '2026-08-24T18:00:00.000Z', { session: 'live' }),
    ask('snoozed', '2026-08-24T11:00:00.000Z', { snoozed_until: '2026-08-25T00:00:00.000Z' }),
    ask('pinned', '2026-08-24T11:00:00.000Z', { pinned_at: '2026-08-24T19:00:00.000Z' }),
    ask('closed', '2026-08-24T11:00:00.000Z', { project: 'retired' }),
  ]
  const boards = [{
    id: 'b', project: 'alpha', title: 'Plan', rows: [
      { id: 'blocked', label: 'Approve', status: 'blocked', position: 0, annotation: null, annotation_unseen: false },
      { id: 'tracked', label: 'Build', status: 'tracked', position: 1, annotation: null, annotation_unseen: false },
    ],
  }]
  const input = {
    items, boards, archived: [], activity: [], nowMs: NOW, liveSessionIds: ['live'], closedProjects: ['retired'],
  }

  it('holds exactly the attention set: three cards, the rest counted, deferred asks only counted', () => {
    const model = buildDashboard(input)
    const all = sortRail(attentionEntries(items, boards, NOW, ['live'], ['retired']), NOW)
      .map((entry) => entry.kind === 'item' ? entry.item.id : entry.row.id)
    expect(all).toHaveLength(4)
    expect(railIds(model)).toEqual(all.slice(0, 3))
    expect(model.rail.more).toBe(1)
    expect(model.rail.cards.length + model.rail.more).toBe(model.signals.waiting)
    expect(model.rail.later).toBe(2)
  })

  it('ranks asks an agent is waiting on first without changing membership', () => {
    expect(railIds(buildDashboard(input))).toEqual(['waiting-old', 'waiting-new', 'blocked'])
    const parked = buildDashboard({ ...input, liveSessionIds: [] })
    // Nobody is live: Needs-you order, blocked rows first, and the same four asks.
    expect(railIds(parked)).toEqual(['blocked', 'parked-old', 'waiting-old'])
    expect(parked.rail.more).toBe(1)
    const entries = attentionEntries(items, boards, NOW, ['live'], ['retired'])
    expect(new Set(sortRail(entries, NOW))).toEqual(new Set(entries))
    expect(sortRail(entries, NOW).map((entry) => entry.kind === 'item' ? entry.item.id : entry.row.id))
      .toEqual(['waiting-old', 'waiting-new', ...sortNeedsYou(entries, NOW)
        .filter((entry) => !(entry.kind === 'item' && entry.liveness === 'waiting'))
        .map((entry) => entry.kind === 'item' ? entry.item.id : entry.row.id)])
  })
})

describe('buildDashboard', () => {
  it('projects current data through the existing ownership and live models', () => {
    const model = buildDashboard({
      items: [
        {
          id: 'needs',
          project: 'alpha',
          kind: 'question',
          status: 'open',
          title: 'Merge?',
          created_at: '2026-08-24T18:00:00.000Z',
          reply: null,
        },
        {
          id: 'agent',
          project: 'alpha',
          kind: 'question',
          status: 'open',
          title: 'Publish?',
          created_at: '2026-08-24T17:00:00.000Z',
          reply: 'Publish',
          reply_kind: 'answer',
          replied_at: '2026-08-24T18:30:00.000Z',
        },
        {
          id: 'done',
          project: 'alpha',
          kind: 'question',
          status: 'resolved',
          title: 'Ship?',
          created_at: '2026-08-23T17:00:00.000Z',
          outcome: 'Release shipped.',
          outcome_at: '2026-08-24T19:00:00.000Z',
        },
        {
          id: 'closed',
          project: 'closed-project',
          kind: 'question',
          status: 'open',
          title: 'Hidden',
          created_at: '2026-08-24T18:00:00.000Z',
          reply: null,
        },
      ],
      boards: [{
        id: 'plan',
        project: 'alpha',
        title: 'Launch',
        rows: [],
      }],
      archived: [{
        id: 'archive',
        project: 'alpha',
        title: 'Finished rollout',
        rows: [{
          id: 'row-done',
          label: 'Canary',
          status: 'done',
          annotation: null,
          annotation_unseen: false,
          outcome: 'Canary reached 100%.',
          outcome_at: '2026-08-24T19:30:00.000Z',
        }],
      }],
      activity: [
        {
          session: 'working',
          project: 'alpha',
          agent: 'copilot',
          doing: 'Implementing dashboard',
          idle: false,
          started_at: '2026-08-24T18:00:00.000Z',
          last_call_at: '2026-08-24T19:59:00.000Z',
        },
        {
          session: 'quiet',
          project: 'alpha',
          agent: 'claude-code',
          doing: 'open',
          idle: true,
          started_at: '2026-08-24T16:00:00.000Z',
          last_call_at: '2026-08-24T17:00:00.000Z',
        },
      ],
      nowMs: NOW,
      liveSessionIds: new Set(['working', 'quiet']),
      closedProjects: ['closed-project'],
    })

    expect(model.signals).toEqual({
      waiting: 1,
      withAgents: 1,
      plans: 1,
      outcomes: 2,
      projects: 1,
    })
    expect(model.rail).toEqual({ cards: [expect.objectContaining({ kind: 'item' })], more: 0, later: 0 })
    expect(model.lanes.map((lane) => lane.session)).toEqual(['working'])
    expect(model.idleConnections).toBe(1)
    expect(model.recentOutcomes.map((entry) => entry.kind === 'item' ? entry.item.id : entry.row.id))
      .toEqual(['row-done', 'done'])
  })

  it('counts subagents only under visible working lanes', () => {
    const model = buildDashboard({
      items: [],
      boards: [],
      archived: [],
      activity: [
        {
          session: 'manager',
          project: 'alpha',
          agent: 'copilot',
          doing: 'Coordinating',
          idle: false,
          children: [
            {
              name: 'worker-a',
              doing: 'Testing',
              project: 'closed-project',
              agent: 'claude',
            },
            { name: 'worker-b', doing: 'Reviewing', state: 'idle' },
          ],
          started_at: '2026-08-24T18:00:00.000Z',
          last_call_at: '2026-08-24T19:59:00.000Z',
        },
        {
          session: 'quiet',
          project: 'alpha',
          agent: 'copilot',
          doing: 'open',
          idle: true,
          children: [{ name: 'stale-worker', doing: 'Must not count' }],
          started_at: '2026-08-24T16:00:00.000Z',
          last_call_at: '2026-08-24T17:00:00.000Z',
        },
        {
          session: 'malformed',
          project: 'alpha',
          agent: 'copilot',
          doing: 'Working without a valid child list',
          idle: false,
          children: { name: 'not-an-array' },
          started_at: '2026-08-24T18:30:00.000Z',
          last_call_at: '2026-08-24T19:58:00.000Z',
        },
        {
          session: 'closed-manager',
          project: 'closed-project',
          agent: 'copilot',
          doing: 'Hidden with its children',
          idle: false,
          children: [
            {
              name: 'closed-worker-a',
              doing: 'Hidden',
              project: 'alpha',
              agent: 'copilot',
            },
            { name: 'closed-worker-b', doing: 'Hidden' },
          ],
          started_at: '2026-08-24T18:00:00.000Z',
          last_call_at: '2026-08-24T19:57:00.000Z',
        },
      ],
      nowMs: NOW,
      liveSessionIds: new Set(['manager', 'quiet', 'malformed', 'closed-manager']),
      closedProjects: ['closed-project'],
    })

    expect(model.now).toMatchObject({ working: 2, subagents: 2 })
    expect(model.idleConnections).toBe(1)
    expect(model.lanes.map((lane) => lane.session)).toEqual(['manager', 'malformed'])
  })

  it('returns an empty, honest model when no work exists', () => {
    const model = buildDashboard({
      items: [],
      boards: [],
      archived: [],
      activity: [],
      nowMs: NOW,
      liveSessionIds: new Set(),
    })

    expect(model.signals).toEqual({
      waiting: 0,
      withAgents: 0,
      plans: 0,
      outcomes: 0,
      projects: 0,
    })
    expect(model.lanes).toEqual([])
    expect(model.now).toEqual({ working: 0, subagents: 0, waiting: 0, oldestWaitingMs: null, plans: { done: 0, countable: 0 } })
    expect(model.recentOutcomes).toEqual([])
  })

  // Issue #184: the page omits older closed items; the summary keeps every count
  // exact, and recent outcomes list only what nothing omitted could outrank.
  it('counts omitted outcomes and projects, and lists only outcomes no omitted item can outrank', () => {
    const outcome = (id: string, at: string) => ({
      id, project: 'alpha', kind: 'question', status: 'resolved', title: id,
      created_at: '2026-08-20T00:00:00.000Z', outcome: `${id} done`, outcome_at: at,
    })
    const input = {
      items: [outcome('newest', '2026-08-24T19:00:00.000Z'), outcome('boundary', '2026-08-24T12:00:00.000Z')],
      boards: [],
      archived: [{
        id: 'archive', project: 'alpha', title: 'Rollout',
        rows: [{
          id: 'row', label: 'Canary', status: 'done', annotation: null, annotation_unseen: false,
          outcome: 'Shipped.', outcome_at: '2026-08-24T18:00:00.000Z',
        }],
      }],
      activity: [],
      nowMs: NOW,
      liveSessionIds: new Set<string>(),
    }
    const complete = buildDashboard(input)
    expect(buildDashboard({ ...input, history: { older: { items: 0, outcomes: 0, latest: null, projects: [], agents: [] } } }))
      .toEqual(complete)
    expect(complete.recentOutcomesComplete).toBe(true)

    const paged = buildDashboard({
      ...input,
      history: { older: { items: 5, outcomes: 2, latest: '2026-08-24T12:00:00.000Z', projects: ['alpha', 'archive-only'], agents: ['copilot'] } },
    })
    expect(paged.signals.outcomes).toBe(complete.signals.outcomes + 2)
    expect(paged.signals.projects).toBe(2)
    expect(paged.recentOutcomes.map((entry) => entry.kind === 'item' ? entry.item.id : entry.row.id))
      .toEqual(['newest', 'row'])
    expect(paged.recentOutcomesComplete).toBe(false)

    // The Dashboard lists four: once four are proven, omitted history is not needed.
    const proven = buildDashboard({
      ...input,
      items: ['19', '18', '17', '16'].map((hour) => outcome(`at-${hour}`, `2026-08-24T${hour}:00:00.000Z`)),
      archived: [],
      history: { older: { items: 9, outcomes: 9, latest: '2026-08-24T12:00:00.000Z', projects: ['alpha'], agents: ['copilot'] } },
    })
    expect(proven.recentOutcomes).toHaveLength(4)
    expect(proven.recentOutcomesComplete).toBe(true)
  })

  // Issue #299: archived plans in brief carry only their projects' newest
  // outcomes and say what they omit; the counts stay exact, and the Dashboard
  // says which omitted source, read, would prove its list.
  it('counts outcomes archived plans omit, and names which omission keeps the list unproven', () => {
    const outcome = (id: string, at: string) => ({
      id, project: 'alpha', kind: 'question', status: 'resolved', title: id,
      created_at: '2026-08-20T00:00:00.000Z', outcome: `${id} done`, outcome_at: at,
    })
    const plan = (rows: Array<[string, string]>) => ({
      id: 'archive', project: 'alpha', title: 'Rollout',
      rows: rows.map(([id, at]) => ({
        id, label: id, status: 'done' as const, annotation: null, annotation_unseen: false, outcome: `${id} shipped.`, outcome_at: at,
      })),
    })
    const base = { boards: [], activity: [], nowMs: NOW, liveSessionIds: new Set<string>() }
    const none = { items: 0, outcomes: 0, latest: null, projects: [], agents: [] }
    const ids = (model: ReturnType<typeof buildDashboard>) =>
      model.recentOutcomes.map((entry) => entry.kind === 'item' ? entry.item.id : entry.row.id)

    // Four carried outcomes newer than everything the brief omits: proven.
    const proven = buildDashboard({
      ...base,
      items: [outcome('item', '2026-08-24T10:00:00.000Z')],
      archived: [plan([['r19', '2026-08-24T19:00:00.000Z'], ['r18', '2026-08-24T18:00:00.000Z'],
        ['r17', '2026-08-24T17:00:00.000Z'], ['r16', '2026-08-24T16:00:00.000Z']])],
      history: { older: none, archived: { outcomes: 3, latest: '2026-08-24T15:00:00.000Z' } },
    })
    expect(proven.signals.outcomes).toBe(8)
    expect(ids(proven)).toEqual(['r19', 'r18', 'r17', 'r16'])
    expect(proven.recentOutcomesComplete).toBe(true)
    expect(proven.recentOutcomesWait).toEqual({ history: false, archived: false })

    // An omitted archived outcome newer than the third: only the archived plans can prove it.
    const archivedWait = buildDashboard({
      ...base,
      items: [outcome('item', '2026-08-24T10:00:00.000Z')],
      archived: [plan([['r19', '2026-08-24T19:00:00.000Z'], ['r18', '2026-08-24T18:00:00.000Z']])],
      history: { older: none, archived: { outcomes: 2, latest: '2026-08-24T17:30:00.000Z' } },
    })
    expect(archivedWait.signals.outcomes).toBe(5)
    expect(ids(archivedWait)).toEqual(['r19', 'r18'])
    expect(archivedWait.recentOutcomesComplete).toBe(false)
    expect(archivedWait.recentOutcomesWait).toEqual({ history: false, archived: true })

    // Both omit something; the list waits on whichever source alone cannot be proven.
    const both = buildDashboard({
      ...base,
      items: [outcome('item', '2026-08-24T10:00:00.000Z')],
      archived: [plan([['r19', '2026-08-24T19:00:00.000Z'], ['r18', '2026-08-24T18:00:00.000Z'],
        ['r17', '2026-08-24T17:00:00.000Z'], ['r16', '2026-08-24T16:00:00.000Z']])],
      history: {
        older: { items: 1, outcomes: 1, latest: '2026-08-24T18:30:00.000Z', projects: ['alpha'], agents: ['copilot'] },
        archived: { outcomes: 1, latest: '2026-08-24T12:00:00.000Z' },
      },
    })
    expect(both.signals.outcomes).toBe(7)
    expect(ids(both)).toEqual(['r19'])
    expect(both.recentOutcomesWait).toEqual({ history: true, archived: false })
  })
})

describe('buildActivitySeries', () => {
  const startMs = Date.parse('2026-08-24T00:00:00.000Z')
  const endMs = Date.parse('2026-08-24T02:00:00.000Z')

  it('clips truthful span overlap into fixed buckets', () => {
    const series = buildActivitySeries([
      {
        session: 'a',
        started_at: '2026-08-24T00:15:00.000Z',
        effective_ended_at: '2026-08-24T01:15:00.000Z',
      },
      {
        session: 'b',
        started_at: '2026-08-24T00:30:00.000Z',
        effective_ended_at: '2026-08-24T00:45:00.000Z',
      },
    ], { startMs, endMs, bucketCount: 2 })

    expect(series.hasHistory).toBe(true)
    expect(series.totalActiveMs).toBe(75 * 60 * 1000)
    expect(series.buckets.map((bucket) => bucket.activeMs)).toEqual([
      60 * 60 * 1000,
      15 * 60 * 1000,
    ])
    expect(series.buckets.map((bucket) => bucket.sessions)).toEqual([2, 1])
  })

  it('uses the selected range end for a genuinely open span', () => {
    const series = buildActivitySeries([{
      session: 'open',
      started_at: '2026-08-24T01:30:00.000Z',
      effective_ended_at: null,
    }], { startMs, endMs, bucketCount: 2 })

    expect(series.totalActiveMs).toBe(30 * 60 * 1000)
    expect(series.buckets.map((bucket) => bucket.activeMs)).toEqual([0, 30 * 60 * 1000])
  })

  it('renders no-history state instead of a synthetic zero trend', () => {
    expect(buildActivitySeries([], { startMs, endMs, bucketCount: 2 })).toEqual({
      hasHistory: false,
      totalActiveMs: 0,
      buckets: [],
    })
  })
})
