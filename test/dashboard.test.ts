import { describe, expect, it } from 'vitest'
import { buildActivitySeries, buildDashboard } from '../public/dashboard.js'

const NOW = Date.parse('2026-08-24T20:00:00.000Z')

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
      agents: { working: 1, quiet: 1, total: 2, reportedChildren: 0 },
      waiting: 1,
      withAgents: 1,
      plans: 1,
      outcomes: 2,
      projects: 1,
    })
    expect(model.ownership).toEqual({ human: 1, agent: 1, outcome: 2 })
    expect(model.sessions.map((session) => session.session)).toEqual(['working', 'quiet'])
    expect(model.recentOutcomes.map((entry) => entry.kind === 'item' ? entry.item.id : entry.row.id))
      .toEqual(['row-done', 'done'])
  })

  it('counts child lanes only under visible working parents', () => {
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

    expect(model.signals.agents).toEqual({
      working: 4,
      quiet: 1,
      total: 5,
      reportedChildren: 2,
    })
    expect(model.sessions.map((session) => session.session)).toEqual([
      'manager',
      'malformed',
      'quiet',
    ])
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
      agents: { working: 0, quiet: 0, total: 0, reportedChildren: 0 },
      waiting: 0,
      withAgents: 0,
      plans: 0,
      outcomes: 0,
      projects: 0,
    })
    expect(model.sessions).toEqual([])
    expect(model.recentOutcomes).toEqual([])
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
