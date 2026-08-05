import { describe, expect, it } from 'vitest'
import { buildRelay } from '../public/relay.js'
import type { RelayBoard, RelayEntry, RelayItem } from '../public/relay.js'

const NOW = Date.parse('2026-08-05T12:00:00.000Z')

describe('buildRelay', () => {
  it('projects one shared workflow into human, agent, and outcome lanes', () => {
    const items: RelayItem[] = [
      {
        id: 'needs',
        project: 'alpha',
        kind: 'question',
        status: 'open',
        title: 'Merge?',
        created_at: '2026-08-05T09:00:00.000Z',
        reply: null,
        reply_kind: null,
      },
      {
        id: 'agent',
        project: 'alpha',
        kind: 'question',
        status: 'open',
        title: 'Publish?',
        created_at: '2026-08-05T08:00:00.000Z',
        reply: 'Publish',
        reply_kind: 'answer',
        replied_at: '2026-08-05T09:30:00.000Z',
        reply_seen_at: '2026-08-05T09:35:00.000Z',
      },
      {
        id: 'done',
        project: 'alpha',
        kind: 'question',
        status: 'resolved',
        title: 'Ship?',
        created_at: '2026-08-04T08:00:00.000Z',
        outcome: 'Release shipped.',
        outcome_at: '2026-08-05T10:00:00.000Z',
      },
    ]
    const boards: RelayBoard[] = [{
      id: 'board',
      project: 'alpha',
      title: 'Launch',
      rows: [{
        id: 'row',
        label: 'Upload build',
        status: 'blocked',
        annotation: 'Uploaded',
        annotation_kind: 'answer' as const,
        annotation_unseen: false,
        annotated_at: '2026-08-05T09:45:00.000Z',
        annotation_seen_at: null,
        handled_at: null,
      }],
    }]
    const archived: RelayBoard[] = [{
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
        outcome_at: '2026-08-05T11:00:00.000Z',
      }],
    }]

    const relay = buildRelay(items, boards, archived, NOW, new Set())
    const id = (entry: RelayEntry) => entry.kind === 'item' ? entry.item.id : entry.row.id

    expect(relay.human.map(id)).toEqual(['needs'])
    expect(relay.agent.map(id)).toEqual(['agent', 'row'])
    expect(relay.outcomes.map(id)).toEqual(['row-done', 'done'])
  })

  it('suppresses closed projects from every lane', () => {
    const item = {
      id: 'q',
      project: 'closed',
      kind: 'question',
      status: 'open',
      title: 'Hidden',
      created_at: '2026-08-05T09:00:00.000Z',
      reply: null,
    }
    expect(buildRelay([item], [], [], NOW, new Set(), ['closed'])).toEqual({
      human: [],
      agent: [],
      outcomes: [],
    })
  })
})
