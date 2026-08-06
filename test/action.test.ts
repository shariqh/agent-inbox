import { describe, expect, it } from 'vitest'
import {
  actionCategory,
  actionOwnerLabel,
  agentFollowupChip,
  changeKind,
  lifecycleReceipt,
  responseLabel,
} from '../public/action.js'

const T0 = Date.parse('2026-08-05T12:00:00.000Z')

describe('action presentation helpers', () => {
  it('labels ownership and groups approval with decisions', () => {
    expect(actionOwnerLabel({ action_owner: 'decision' })).toBe('Decision')
    expect(actionOwnerLabel({ action_owner: 'task' })).toBe('To do')
    expect(actionOwnerLabel({ action_owner: 'approval' })).toBe('Ready after approval')
    expect(actionCategory({ action_owner: 'approval' })).toBe('decision')
    expect(actionCategory({ action_owner: 'task' })).toBe('task')
  })

  it('derives a sensible legacy owner from options', () => {
    expect(actionOwnerLabel({ options: [{ label: 'A' }, { label: 'B' }] })).toBe('Decision')
    expect(actionOwnerLabel({ options: null })).toBe('To do')
  })

  it('distinguishes new from changed since the prior visit', () => {
    const prior = '2026-08-05T10:00:00.000Z'
    expect(changeKind({
      created_at: '2026-08-05T11:00:00.000Z',
      updated_at: '2026-08-05T11:00:00.000Z',
    }, prior)).toBe('new')
    expect(changeKind({
      created_at: '2026-08-05T09:00:00.000Z',
      updated_at: '2026-08-05T11:00:00.000Z',
    }, prior)).toBe('changed')
    expect(changeKind({
      created_at: '2026-08-05T09:00:00.000Z',
      updated_at: '2026-08-05T09:30:00.000Z',
    }, prior)).toBeNull()
  })

  it('labels clarification, decline, answers, and completed tasks honestly', () => {
    expect(responseLabel({ reply_kind: 'clarify' })).toBe('Clarification requested')
    expect(responseLabel({ annotation_kind: 'decline' })).toBe('Declined')
    expect(responseLabel({ reply: 'yes' })).toBe('You answered')
    expect(responseLabel({ handled_at: '2026-08-05T11:00:00.000Z' })).toBe('You did your part')
  })

  it('turns picked-up-but-unfinished work into an agent-overdue chip without making it human attention', () => {
    expect(agentFollowupChip({
      answered: true,
      pickedUp: true,
      pickedUpAt: new Date(T0 - 30 * 60_000).toISOString(),
    }, T0)).toEqual({ text: 'with agent 30m', tone: 'muted' })
    expect(agentFollowupChip({
      answered: true,
      pickedUp: true,
      pickedUpAt: new Date(T0 - 2 * 60 * 60_000).toISOString(),
    }, T0)).toEqual({ text: 'follow-up due 2h', tone: 'warm' })
  })

  it('builds a concise asked → response → pickup → outcome receipt', () => {
    const receipt = lifecycleReceipt({
      action_started_at: '2026-08-05T08:00:00.000Z',
      annotation: 'Merge',
      annotation_kind: 'answer',
      annotated_at: '2026-08-05T09:00:00.000Z',
      annotation_seen_at: '2026-08-05T09:05:00.000Z',
      outcome: 'Merged PR #42.',
      outcome_at: '2026-08-05T09:30:00.000Z',
    })
    expect(receipt.map((step) => step.label)).toEqual([
      'Asked',
      'You answered',
      'With the agent',
      'Merged PR #42.',
    ])
  })
})
