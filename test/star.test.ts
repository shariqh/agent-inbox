import { describe, it, expect } from 'vitest'
import { starOption, createStagedSend, canUndo } from '../public/star.js'

// hand-driven clock: nothing fires until the test says so, so "5 seconds" costs
// zero milliseconds of test time
function fakeTimers() {
  let nextId = 0
  const timers = new Map<number, () => void>()
  return {
    setTimeoutFn: (fn: () => void) => { const id = ++nextId; timers.set(id, fn); return id },
    clearTimeoutFn: (id: number) => { timers.delete(id) },
    runAll: () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn() } },
    outstanding: () => timers.size,
  }
}

describe('starOption', () => {
  it('returns the single recommended option', () => {
    const it_ = { options: [{ label: 'Ship it', recommended: true }, { label: 'Wait' }] }
    expect(starOption(it_)?.label).toBe('Ship it')
  })
  it('is null when nothing is recommended', () => {
    expect(starOption({ options: [{ label: 'A' }, { label: 'B' }] })).toBeNull()
  })
  it('is null when TWO options are recommended (the store does not validate this)', () => {
    expect(starOption({ options: [{ label: 'A', recommended: true }, { label: 'B', recommended: true }] })).toBeNull()
  })
  it('is null when there are no options at all', () => {
    expect(starOption({ options: [] })).toBeNull()
    expect(starOption({ options: null })).toBeNull()
    expect(starOption({})).toBeNull()
  })
  it('only a literal true recommends — truthy junk does not', () => {
    // @ts-expect-error the API contract is boolean; guard against loose JSON
    expect(starOption({ options: [{ label: 'A', recommended: 'yes' }] })).toBeNull()
  })
})

describe('createStagedSend', () => {
  it('does not send before the delay elapses', () => {
    const t = fakeTimers()
    const sent: unknown[] = []
    const s = createStagedSend({ delayMs: 5000, ...t, send: (p) => sent.push(p) })
    s.stage('i1', { id: 'i1', text: 'Ship it' })
    expect(sent).toEqual([])
    expect(s.pending('i1')).toBe(true)
  })
  it('sends after the delay elapses', () => {
    const t = fakeTimers()
    const sent: unknown[] = []
    const s = createStagedSend({ delayMs: 5000, ...t, send: (p) => sent.push(p) })
    s.stage('i1', { id: 'i1', text: 'Ship it' })
    t.runAll()
    expect(sent).toEqual([{ id: 'i1', text: 'Ship it' }])
    expect(s.pending('i1')).toBe(false)
  })
  it('undo before the delay cancels outright and returns true', () => {
    const t = fakeTimers()
    const sent: unknown[] = []
    const s = createStagedSend({ delayMs: 5000, ...t, send: (p) => sent.push(p) })
    s.stage('i1', { id: 'i1', text: 'Ship it' })
    expect(s.undo('i1')).toBe(true)
    expect(s.pending('i1')).toBe(false)
    expect(t.outstanding()).toBe(0)
    t.runAll()
    expect(sent).toEqual([])
  })
  it('undo after the send returns false and sends nothing extra', () => {
    const t = fakeTimers()
    const sent: unknown[] = []
    const s = createStagedSend({ delayMs: 5000, ...t, send: (p) => sent.push(p) })
    s.stage('i1', { id: 'i1', text: 'Ship it' })
    t.runAll()
    expect(s.undo('i1')).toBe(false)
    expect(sent).toHaveLength(1)
  })
  it('undo for a key that was never staged returns false', () => {
    const t = fakeTimers()
    const s = createStagedSend({ delayMs: 5000, ...t, send: () => {} })
    expect(s.undo('nope')).toBe(false)
  })
  it('flush sends every pending payload immediately and clears the timers', () => {
    const t = fakeTimers()
    const sent: unknown[] = []
    const s = createStagedSend({ delayMs: 5000, ...t, send: (p) => sent.push(p) })
    s.stage('i1', { id: 'i1', text: 'A' })
    s.stage('i2', { id: 'i2', text: 'B' })
    s.flush()
    expect(sent).toEqual([{ id: 'i1', text: 'A' }, { id: 'i2', text: 'B' }])
    expect(t.outstanding()).toBe(0)
    expect(s.pending('i1')).toBe(false)
    t.runAll()
    expect(sent).toHaveLength(2) // the elapsed timer must not double-send
  })
  it('re-staging the same key replaces the payload and sends once', () => {
    const t = fakeTimers()
    const sent: unknown[] = []
    const s = createStagedSend({ delayMs: 5000, ...t, send: (p) => sent.push(p) })
    s.stage('i1', { id: 'i1', text: 'A' })
    s.stage('i1', { id: 'i1', text: 'B' })
    t.runAll()
    expect(sent).toEqual([{ id: 'i1', text: 'B' }])
  })
  it('tracks keys independently', () => {
    const t = fakeTimers()
    const sent: unknown[] = []
    const s = createStagedSend({ delayMs: 5000, ...t, send: (p) => sent.push(p) })
    s.stage('i1', { id: 'i1', text: 'A' })
    s.stage('i2', { id: 'i2', text: 'B' })
    expect(s.undo('i1')).toBe(true)
    t.runAll()
    expect(sent).toEqual([{ id: 'i2', text: 'B' }])
  })
})

describe('canUndo', () => {
  it('is true while the agent has not picked the reply up', () => {
    expect(canUndo({ reply_seen_at: null })).toBe(true)
    expect(canUndo({})).toBe(true)
  })
  it('is false once reply_seen_at is set — that race cannot be won', () => {
    expect(canUndo({ reply_seen_at: '2026-07-24T11:59:00Z' })).toBe(false)
  })
})
