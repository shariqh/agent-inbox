// Issue #197, part 2 — the Setup panel's agents block, as pure functions: one
// line per host saying which build it is registered to run, which hosts the
// one explicit "Update agents" may move, the fixed install target that moves
// exactly those, and — after an update — which running sessions still need a
// restart and how. It never says a running session reloaded.
import { describe, expect, it } from 'vitest'
import { hostLine, outdatedHosts, restartGuidance, updateTarget } from '../public/agents.js'

const runtime = (version: string) => ({ kind: 'runtime', version, runtimeId: `agent-inbox-runtime-${version}-darwin-arm64-0123456789abcdef` })

describe('hostLine', () => {
  it('names the Setup runtime a host runs and compares it with this app\'s', () => {
    expect(hostLine('claude', runtime('1.2.8'), '1.3.0')).toEqual({
      host: 'claude', label: 'Claude Code', kind: 'runtime', outdated: true,
      text: 'v1.2.8 runtime (Setup) — older than this app\'s v1.3.0',
    })
    expect(hostLine('copilot', runtime('1.3.0'), '1.3.0').text).toBe('v1.3.0 runtime (Setup)')
    expect(hostLine('copilot', runtime('1.4.0'), '1.3.0')).toMatchObject({
      outdated: false, text: 'v1.4.0 runtime (Setup) — newer than this app\'s v1.3.0',
    })
    // a checkout viewer has no runtime of its own to compare with
    expect(hostLine('claude', runtime('1.2.8'), null)).toMatchObject({ outdated: false, text: 'v1.2.8 runtime (Setup)' })
    expect(hostLine('claude', { kind: 'runtime' }, '1.3.0')).toMatchObject({ outdated: false, text: 'Setup runtime (version unknown)' })
  })

  it('reports a checkout honestly, and anything Setup does not manage as such', () => {
    expect(hostLine('copilot', { kind: 'checkout', path: '/Users/me/src/agent-inbox' }, '1.3.0')).toEqual({
      host: 'copilot', label: 'Copilot CLI', kind: 'checkout', outdated: false,
      text: 'source checkout at /Users/me/src/agent-inbox (not managed by Setup)',
    })
    expect(hostLine('copilot', { kind: 'checkout' }, '1.3.0').text).toBe('source checkout (not managed by Setup)')
    expect(hostLine('claude', { kind: 'none' }, '1.3.0').text).toBe('not registered')
    expect(hostLine('claude', { kind: 'other' }, '1.3.0').text).toBe('custom command (not managed by Setup)')
    expect(hostLine('claude', { kind: 'unknown' }, '1.3.0').text).toBe('could not be verified, so Setup leaves it unchanged')
    for (const reg of [undefined, null, 'runtime', { kind: 'surprise' }]) {
      expect(hostLine('claude', reg, '1.3.0').text, JSON.stringify(reg)).toBe('could not be verified, so Setup leaves it unchanged')
    }
  })

  it('words Claude\'s hooks as hooks', () => {
    expect(hostLine('hooks', { kind: 'none' }, '1.3.0')).toMatchObject({ label: 'Claude hooks', text: 'not installed' })
    expect(hostLine('hooks', { kind: 'other' }, '1.3.0').text).toBe('custom hooks (not managed by Setup)')
    expect(hostLine('hooks', runtime('1.2.4'), '1.3.0')).toMatchObject({ outdated: true, text: 'v1.2.4 runtime (Setup) — older than this app\'s v1.3.0' })
  })
})

describe('outdatedHosts and updateTarget', () => {
  const agents = (claude: unknown, copilot: unknown, extra: Record<string, unknown> = {}) =>
    ({ current: '1.3.0', updatable: true, claude, copilot, hooks: runtime('1.0.0'), hooksCommand: '', ...extra })

  it('picks exactly the Setup-managed hosts that are older, and the fixed target that moves only them', () => {
    expect(outdatedHosts(agents(runtime('1.2.8'), runtime('1.2.8')))).toEqual(['claude', 'copilot'])
    expect(outdatedHosts(agents(runtime('1.2.8'), runtime('1.3.0')))).toEqual(['claude'])
    expect(outdatedHosts(agents(runtime('1.3.0'), runtime('1.1.0')))).toEqual(['copilot'])
    expect(updateTarget(['claude', 'copilot'])).toBe('all')
    expect(updateTarget(['claude'])).toBe('claude')
    expect(updateTarget(['copilot'])).toBe('copilot')
    expect(updateTarget([])).toBeNull()
  })

  it('never includes a checkout, a custom or unverifiable registration, a newer runtime, or hooks', () => {
    for (const other of [{ kind: 'checkout', path: '/src' }, { kind: 'other' }, { kind: 'unknown' }, { kind: 'none' }, runtime('1.4.0'), { kind: 'runtime' }]) {
      expect(outdatedHosts(agents(runtime('1.2.8'), other)), JSON.stringify(other)).toEqual(['claude'])
    }
    // nothing to compare against, or nothing at all
    expect(outdatedHosts(agents(runtime('1.2.8'), runtime('1.2.8'), { current: null }))).toEqual([])
    expect(outdatedHosts(null)).toEqual([])
  })
})

describe('restartGuidance', () => {
  const row = (agent: string, version: string | null, source = 'runtime') =>
    ({ session: `${agent}-${version}-${Math.random()}`, agent, server_version: version, server_source: source })

  it('counts the running sessions of each updated host that still run an older build, and says how to restart them', () => {
    const activity = [
      row('claude-code', '1.2.8'), row('claude-code', '1.2.6', 'checkout'), row('claude-code', '1.3.0'),
      row('copilot', '1.2.8'), row('codex', '1.0.0'),
    ]
    expect(restartGuidance(activity, ['claude', 'copilot'], '1.3.0')).toEqual([
      'Claude Code: 2 running sessions still run an older build. Restart each one to load v1.3.0: exit it, then run claude --resume to pick the conversation back up.',
      'Copilot CLI: 1 running session still runs an older build. Restart it to load v1.3.0: exit it, then run copilot --resume to pick the conversation back up.',
    ])
  })

  it('says so when no session of an updated host is behind, and is honest about sessions that report no build', () => {
    const activity = [row('claude-code', '1.3.0'), row('claude-code', null), row('copilot', '1.2.8')]
    expect(restartGuidance(activity, ['claude'], '1.3.0')).toEqual([
      'Claude Code: no running session reports an older build. 1 session does not report its build; restart it to be sure.',
    ])
    expect(restartGuidance([], ['copilot'], '1.3.0')).toEqual(['Copilot CLI: no running session reports an older build.'])
    for (const line of restartGuidance(activity, ['claude', 'copilot'], '1.3.0')) {
      expect(line).not.toMatch(/reloaded|reconnected|now running/i)
    }
  })
})
