import { describe, it, expect } from 'vitest'
import { liveSummary, lastActivityAt, isDormant, activitySynopsis } from '../public/livebar.js'

const NOW = Date.parse('2026-07-24T12:00:00.000Z')
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const sess = (o: Partial<Record<string, unknown>> = {}) => ({
  session: 's1', project: 'oris', agent: 'claude-code', stream: '', doing: 'working',
  last_doing: 'working', detail: '', children: [], idle: false, updated_at: at(1000), started_at: at(60_000),
  last_call_at: at(1000), ...o,
})

describe('liveSummary', () => {
  it('counts only non-idle sessions and labels them project/agent', () => {
    const s = liveSummary([sess(), sess({ session: 's2', project: 'api', idle: true })], NOW)
    expect(s.count).toBe(1)
    expect(s.idleCount).toBe(1)
    expect(s.label).toBe('1 working')
    expect(s.sessions).toEqual([{
      session: 's1', project: 'oris', agent: 'claude-code',
      label: 'oris/claude-code', tone: 'fresh',
    }])
  })

  it('pluralises', () => {
    const s = liveSummary([sess(), sess({ session: 's2', project: 'api' })], NOW)
    expect(s.label).toBe('2 working')
  })

  it('reads idle when nothing is running — the strip still renders', () => {
    const s = liveSummary([sess({ idle: true })], NOW)
    expect(s.count).toBe(0)
    expect(s.idleCount).toBe(1)
    expect(s.tone).toBe('idle')
    expect(s.label).toBe('no agents running')
    expect(s.sessions).toEqual([])
  })

  it('empty activity is idle, never a crash', () => {
    expect(liveSummary([], NOW).label).toBe('no agents running')
    expect(liveSummary(undefined as never, NOW).label).toBe('no agents running')
  })

  it('strip tone is the FRESHEST session — one live agent must not read as quiet', () => {
    const s = liveSummary([sess({ last_call_at: at(10 * 60_000) }), sess({ session: 's2', last_call_at: at(500) })], NOW)
    expect(s.tone).toBe('fresh')
  })

  it('per-session tones use the shared freshness scale', () => {
    const s = liveSummary([
      sess({ session: 'a', last_call_at: at(500) }),
      sess({ session: 'b', last_call_at: at(2 * 60_000) }),
      sess({ session: 'c', last_call_at: at(30 * 60_000) }),
    ], NOW)
    expect(s.sessions.map((x) => x.tone)).toEqual(['fresh', 'aging', 'quiet'])
  })

  // Issue #45 — `updated_at` is bumped every 5 minutes by the server's liveness
  // heartbeat whether or not the agent did anything, so a dot keyed on it
  // re-greened forever and "last activity 30s ago" was never more than a claim
  // that the process had not crashed.
  it('tone reads the last REAL call, never the liveness heartbeat', () => {
    const s = liveSummary([sess({ updated_at: at(0), last_call_at: at(20 * 60_000) })], NOW)
    expect(s.sessions[0]!.tone).toBe('quiet')
  })
})

describe('lastActivityAt / isDormant (#45)', () => {
  it('prefers the real-call stamp and falls back to session start, never to the heartbeat', () => {
    expect(lastActivityAt(sess({ last_call_at: at(5000), started_at: at(9e6), updated_at: at(0) }))).toBe(at(5000))
    // NULL until a session makes its first call — a just-connected presence row
    expect(lastActivityAt(sess({ last_call_at: null, started_at: at(9e6), updated_at: at(0) }))).toBe(at(9e6))
  })

  it('marks a session nobody has touched in hours, and only that one', () => {
    expect(isDormant(sess({ last_call_at: at(9 * 3600_000), updated_at: at(0) }), NOW)).toBe(true)
    expect(isDormant(sess({ last_call_at: at(60 * 60_000) }), NOW)).toBe(false)
    expect(isDormant(sess({ last_call_at: at(1000) }), NOW)).toBe(false)
  })
})

describe('activitySynopsis', () => {
  it('uses the last meaningful claim without reviving it as current work', () => {
    expect(activitySynopsis(sess({ doing: 'open', idle: true, last_doing: 'Preparing the release' }))).toEqual({
      text: 'Preparing the release',
      historical: true,
    })
  })

  it('is explicit when a session has never reported an activity summary', () => {
    expect(activitySynopsis(sess({ doing: 'open', idle: true, last_doing: '' }))).toEqual({
      text: 'No activity summary yet',
      historical: false,
    })
  })
})
