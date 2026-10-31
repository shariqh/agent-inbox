// Issue #411, PR 2: the composer's pure rules — the three delivery states, the
// status line, one session's history and the "Not delivered" fold.
import { describe, expect, it } from 'vitest'
import {
  composerLabel, deliveryState, messageStatus, refusalText, sessionMessages, snapshotHolds, undeliveredMessages, undeliveredReason,
} from '../public/messages.js'

const ago = (iso: string | null) => `<${iso}>`
const message = (n: number, over: Record<string, unknown> = {}) => ({
  id: `m${n}`, session: 'a', project: 'alpha', stream: 'main', agent: 'claude-code', text: `Message ${n}`,
  created_at: `2026-10-30T12:${String(n).padStart(2, '0')}:00.000Z`, revision: 1, status: 'open',
  delivered_at: null, delivered_by: null, outcome: '', closed_at: null, ...over,
})

describe('deliveryState', () => {
  it('says arrives now for a push, an armed message watch or a driven session, and when it next checks otherwise', () => {
    const row = { session: 'a', receives_messages: true }
    expect(deliveryState({ ...row, push_wake: true })).toMatchObject({ state: 'now', canSend: true })
    expect(deliveryState({ ...row, wakes: true })).toMatchObject({ state: 'now', text: 'Arrives now: this session wakes for it.' })
    expect(deliveryState(row, { driven: true })).toMatchObject({ state: 'now', canSend: true })
    // an absent push_wake is unknown, never "won't wake"
    expect(deliveryState(row)).toEqual({ state: 'next-check', text: 'It sees this when it next checks Agent Inbox.', canSend: true })
  })

  it('reads an absent receives_messages as an older server that cannot receive, whatever else it says', () => {
    expect(deliveryState({ session: 'a', push_wake: true, wakes: true })).toEqual({
      state: 'cannot', text: 'Can’t receive: restart this session to load v2.2.0 or later.', canSend: false,
    })
    expect(deliveryState(null)).toMatchObject({ state: 'gone', canSend: false })
  })
})

describe('messageStatus', () => {
  it('walks sent, picked up and acknowledged, and says when a withdrawal came after pickup', () => {
    expect(messageStatus(message(1), ago)).toMatchObject({ text: 'Sent <2026-10-30T12:01:00.000Z> ago · not picked up yet', withdrawable: true })
    expect(messageStatus(message(1, { delivered_at: 'D' }), ago)).toMatchObject({ text: 'Picked up <D> ago · working on it', withdrawable: true })
    expect(messageStatus(message(1, { status: 'acknowledged', delivered_at: 'D', closed_at: 'C', outcome: 'Ran them.' }), ago))
      .toEqual({ tone: 'acknowledged', text: 'Acknowledged <C> ago:', outcome: 'Ran them.', withdrawable: false })
    expect(messageStatus(message(1, { status: 'withdrawn', closed_at: 'C' }), ago).text).toBe('Withdrawn')
    expect(messageStatus(message(1, { status: 'withdrawn', delivered_at: 'D', closed_at: 'C' }), ago).text)
      .toBe('Withdrawn after pickup: it may have started')
  })
})

describe('history and the Not delivered fold', () => {
  it('shows one session’s five newest messages, open and closed, and counts the earlier ones', () => {
    const snapshot = {
      open: [message(1), message(3), message(5), message(7, { session: 'b' })],
      closed: [message(2, { status: 'acknowledged' }), message(4, { status: 'withdrawn' }), message(6, { status: 'acknowledged' })],
    }
    const { shown, earlier } = sessionMessages(snapshot, 'a')
    expect(shown.map((m) => m.id)).toEqual(['m6', 'm5', 'm4', 'm3', 'm2'])
    expect(earlier.map((m) => m.id)).toEqual(['m1'])
    expect(snapshotHolds(snapshot, 'm4')).toBe(true)
    expect(snapshotHolds(null, 'm4')).toBe(false)
  })

  it('lists open messages to sessions no longer listed, newest first, ten shown', () => {
    const open = Array.from({ length: 13 }, (_, i) => message(i + 1, { session: i === 0 ? 'listed' : `gone-${i}` }))
    const lost = undeliveredMessages({ open, closed: [message(30, { session: 'gone-x', status: 'withdrawn' })] }, [{ session: 'listed' }])
    expect(lost.total).toBe(12)
    expect(lost.shown.map((m) => m.id)).toEqual(['m13', 'm12', 'm11', 'm10', 'm9', 'm8', 'm7', 'm6', 'm5', 'm4'])
    expect(lost.more.map((m) => m.id)).toEqual(['m3', 'm2'])
    expect(undeliveredReason(message(1))).toBe('Not delivered: this session is no longer running')
    expect(undeliveredReason(message(1, { delivered_at: 'D' }))).toBe('Picked up, but the session ended before acknowledging')
    expect(undeliveredMessages(null, []).total).toBe(0)
  })

  it('names the session and words each refusal', () => {
    expect(composerLabel({ agent: 'copilot', project: 'agent-inbox', stream: 'feat-x' })).toBe('Message to copilot · agent-inbox · feat-x')
    expect(composerLabel({ agent: 'copilot', project: 'agent-inbox', stream: '' })).toBe('Message to copilot · agent-inbox')
    expect(refusalText({ reason: 'not_open', status: 'acknowledged' }, 'withdraw')).toBe('Not withdrawn: the session already acknowledged it.')
    expect(refusalText(null, 'withdraw')).toBe('Not withdrawn.')
    expect(refusalText({ reason: 'too_many_open' })).toMatch(/^Not sent: this session already has 20 open messages/)
  })
})
