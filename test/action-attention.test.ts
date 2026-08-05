import { describe, expect, it } from 'vitest'
import {
  attentionEntries,
  awaitingAgentRows,
  isAskingQuestion,
  isBlockedRowAttention,
  snoozedEntries,
} from '../public/attention.js'

const NOW = Date.parse('2026-08-05T00:00:00.000Z')
const FUTURE = new Date(NOW + 24 * 60 * 60_000).toISOString()

describe('human dispositions in the shared attention model', () => {
  it('treats clarification and decline kinds as human responses even without text', () => {
    expect(isAskingQuestion({
      id: 'i', project: 'p', created_at: '2026-08-04T00:00:00.000Z',
      kind: 'question', status: 'open', reply: null, reply_kind: 'clarify',
    }, NOW)).toBe(false)
    expect(isBlockedRowAttention({
      id: 'r', status: 'blocked', annotation: null, annotation_kind: 'decline',
      annotation_unseen: false, handled_at: null,
    }, NOW)).toBe(false)
  })

  it('demotes snoozed unanswered work into an explicit fold instead of losing it', () => {
    const item = {
      id: 'i1',
      project: 'p',
      kind: 'question',
      status: 'open',
      reply: null,
      reply_kind: null,
      session: null,
      created_at: '2026-08-04T00:00:00.000Z',
      snoozed_until: FUTURE,
    }
    const row = {
      id: 'r1',
      status: 'blocked',
      annotation: null,
      annotation_kind: null,
      annotation_unseen: false,
      handled_at: null,
      snoozed_until: FUTURE,
    }
    const board = { id: 'b1', project: 'p', rows: [row] }

    expect(attentionEntries([item], [board], NOW, new Set())).toEqual([])
    expect(awaitingAgentRows([board])).toEqual([])
    expect(snoozedEntries([item], [board], NOW)).toEqual([
      { kind: 'item', item, liveness: 'snoozed' },
      { kind: 'row', row, board, liveness: 'snoozed' },
    ])
  })

  it('returns snoozed work to attention automatically when its time passes', () => {
    const item = {
      id: 'i1',
      project: 'p',
      kind: 'question',
      status: 'open',
      reply: null,
      reply_kind: null,
      session: null,
      created_at: '2026-08-04T00:00:00.000Z',
      snoozed_until: FUTURE,
    }
    expect(attentionEntries([item], [], NOW + 2 * 24 * 60 * 60_000, new Set())).toHaveLength(1)
    expect(snoozedEntries([item], [], NOW + 2 * 24 * 60 * 60_000)).toEqual([])
  })
})
