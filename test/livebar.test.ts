import { describe, it, expect } from 'vitest'
import { liveSummary, lastActivityAt, isDormant, activitySynopsis, sessionBuild } from '../public/livebar.js'

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
    expect(s.label).toBe('1 reporting work')
    expect(s.sessions).toEqual([{
      session: 's1', project: 'oris', agent: 'claude-code',
      label: 'oris/claude-code', tone: 'fresh',
    }])
  })

  it('pluralises', () => {
    const s = liveSummary([sess(), sess({ session: 's2', project: 'api' })], NOW)
    expect(s.label).toBe('2 reporting work')
  })

  it('does not mistake a connected agent with no task report for no running agents', () => {
    const s = liveSummary([sess({ idle: true })], NOW)
    expect(s.count).toBe(0)
    expect(s.idleCount).toBe(1)
    expect(s.tone).toBe('idle')
    expect(s.label).toBe('1 connected · no task reported')
    expect(s.sessions).toEqual([])
  })

  it('empty activity is idle, never a crash', () => {
    expect(liveSummary([], NOW).label).toBe('no agent connections')
    expect(liveSummary(undefined as never, NOW).label).toBe('no agent connections')
  })

  it('keeps connections without task reports visible even when they make recent calls', () => {
    const s = liveSummary([
      sess({ idle: true, doing: 'open', last_doing: '', last_call_at: at(0) }),
      sess({ session: 's2', idle: true, doing: 'open', last_doing: '', last_call_at: null }),
    ], NOW)
    expect(s.label).toBe('2 connected · no task reported')
    expect(s.count).toBe(0)
    expect(s.idleCount).toBe(2)
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
      text: 'No task reported yet',
      historical: false,
    })
  })
})

// Issue #197 — which Agent Inbox build a session runs, and whether a restart
// would load a newer one. Display only, and it never guesses: both versions must
// be strict semver before anything is compared, and a session whose own version
// is unknown renders nothing at all.
describe('sessionBuild', () => {
  const build = (own: unknown, current: unknown) => sessionBuild(sess({ server_version: own }), current)
  const isOlder = (own: string, current: string) => build(own, current)?.older

  it('labels a current session and says nothing more', () => {
    expect(build('1.2.8', '1.2.8')).toEqual({ label: 'v1.2.8', older: false, hint: '' })
  })

  it('hints a restart only when the session is strictly older than the current build', () => {
    expect(build('1.2.6', '1.2.8')).toEqual({
      label: 'v1.2.6',
      older: true,
      hint: 'older build — restart this session to load v1.2.8',
    })
    expect(isOlder('1.1.9', '1.2.0')).toBe(true)
    expect(isOlder('0.9.9', '1.0.0')).toBe(true)
    // a session NEWER than this viewer is not an older build
    expect(isOlder('1.3.0', '1.2.8')).toBe(false)
  })

  it('compares numerically, never as text, without losing precision', () => {
    expect(isOlder('1.9.0', '1.10.0')).toBe(true)
    expect(isOlder('1.10.0', '1.9.0')).toBe(false)
    expect(isOlder('1.2.9', '1.2.10')).toBe(true)
    expect(isOlder('1.2.9007199254740992', '1.2.9007199254740993')).toBe(true)
  })

  it('follows semver precedence for pre-releases and ignores build metadata', () => {
    // the precedence chain from semver.org §11, each strictly older than the next
    const chain = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0']
    for (let i = 1; i < chain.length; i++) {
      expect(isOlder(chain[i - 1]!, chain[i]!), `${chain[i - 1]} < ${chain[i]}`).toBe(true)
      expect(isOlder(chain[i]!, chain[i - 1]!), `${chain[i]} !< ${chain[i - 1]}`).toBe(false)
    }
    expect(build('1.2.8+abc123', '1.2.8')).toEqual({ label: 'v1.2.8+abc123', older: false, hint: '' })
    expect(isOlder('1.2.8', '1.2.8+abc123')).toBe(false)
  })

  it('renders nothing for a session with no version or one that is not semver', () => {
    for (const own of [undefined, null, '', 'v1.2.8', '1.2', '1.2.8.1', '01.2.8', '1.2.8-', 'latest', '<img src=x onerror=alert(1)>', 128, `1.2.8-${'x'.repeat(80)}`]) {
      expect(build(own, '1.2.8'), String(own)).toBeNull()
    }
    expect(sessionBuild(null, '1.2.8')).toBeNull()
  })

  it('still labels the session, but never hints, when the current build is unknown', () => {
    for (const current of [undefined, null, '', 'unknown', '1.2', '<b>1.3.0</b>']) {
      expect(build('1.2.6', current), String(current)).toEqual({ label: 'v1.2.6', older: false, hint: '' })
    }
  })
})
