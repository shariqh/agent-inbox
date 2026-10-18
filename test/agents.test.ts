// Issue #197, part 2 — the Setup panel's agents block, as pure functions: one
// line per host saying which build it is registered to run, the ONE explicit
// action that moves the Setup-managed hosts onto this app's runtime (in either
// direction: an older runtime is updated, a newer one after an app downgrade is
// matched back), the fixed install target that moves exactly those hosts, and —
// afterwards — which running sessions still need a restart and how. It never
// says a running session reloaded.
import { describe, expect, it } from 'vitest'
import { agentsAction, hostLine, restartGuidance, updateTarget } from '../public/agents.js'

const runtime = (version: string) => ({ kind: 'runtime', version, runtimeId: `agent-inbox-runtime-${version}-darwin-arm64-0123456789abcdef` })

describe('hostLine', () => {
  it('names the Setup runtime a host runs and which way it differs from this app\'s', () => {
    expect(hostLine('claude', runtime('1.2.8'), '1.3.0')).toEqual({
      host: 'claude', label: 'Claude Code', kind: 'runtime', outdated: true, drift: 'older',
      text: 'v1.2.8 runtime (Setup) — older than this app\'s v1.3.0',
    })
    expect(hostLine('copilot', runtime('1.3.0'), '1.3.0')).toMatchObject({ drift: null, outdated: false, text: 'v1.3.0 runtime (Setup)' })
    expect(hostLine('claude', runtime('1.3.1'), '1.3.0')).toEqual({
      host: 'claude', label: 'Claude Code', kind: 'runtime', outdated: false, drift: 'newer',
      text: 'v1.3.1 runtime (Setup) — newer than this app\'s v1.3.0',
    })
    // a checkout viewer has no runtime of its own to compare with
    expect(hostLine('claude', runtime('1.2.8'), null)).toMatchObject({ outdated: false, drift: null, text: 'v1.2.8 runtime (Setup)' })
    expect(hostLine('claude', { kind: 'runtime' }, '1.3.0')).toMatchObject({ outdated: false, drift: null, text: 'Setup runtime (version unknown)' })
  })

  it('reports a checkout honestly, and anything Setup does not manage as such', () => {
    expect(hostLine('copilot', { kind: 'checkout', path: '/Users/me/src/agent-inbox' }, '1.3.0')).toEqual({
      host: 'copilot', label: 'Copilot CLI', kind: 'checkout', outdated: false, drift: null,
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
    expect(hostLine('hooks', runtime('1.2.4'), '1.3.0')).toMatchObject({ drift: 'older', text: 'v1.2.4 runtime (Setup) — older than this app\'s v1.3.0' })
    expect(hostLine('hooks', runtime('1.4.0'), '1.3.0')).toMatchObject({ drift: 'newer', text: 'v1.4.0 runtime (Setup) — newer than this app\'s v1.3.0' })
  })
})

describe('agentsAction', () => {
  const agents = (claude: unknown, copilot: unknown, extra: Record<string, unknown> = {}) =>
    ({ current: '1.3.0', updatable: true, claude, copilot, hooks: runtime('1.0.0'), hooksCommand: '', ...extra })

  it('updates the Setup-managed hosts on an older runtime', () => {
    expect(agentsAction(agents(runtime('1.2.8'), runtime('1.3.0')))).toEqual({
      target: 'claude',
      hosts: ['claude'],
      label: 'Update agents',
      hint: 'Update agents moves Claude Code to the v1.3.0 runtime. Running sessions keep their build until you restart them.',
      elsewhere: 'Open Settings in the Agent Inbox app to update Claude Code to the v1.3.0 runtime.',
      progress: 'Updating Claude Code…',
      done: 'Claude Code updated.',
    })
    expect(agentsAction(agents(runtime('1.2.8'), runtime('1.1.0'))))
      .toMatchObject({ target: 'all', hosts: ['claude', 'copilot'], label: 'Update agents' })
  })

  it('matches a host on a NEWER runtime back to this app\'s, and says so', () => {
    expect(agentsAction(agents(runtime('1.3.0'), runtime('1.3.1')))).toEqual({
      target: 'copilot',
      hosts: ['copilot'],
      label: 'Match agents to v1.3.0',
      hint: 'Copilot CLI runs a newer runtime than this app. Match agents to v1.3.0 moves it to this app\'s runtime. Running sessions keep their build until you restart them.',
      elsewhere: 'Open Settings in the Agent Inbox app to match Copilot CLI to the v1.3.0 runtime.',
      progress: 'Matching Copilot CLI to v1.3.0…',
      done: 'Copilot CLI now matches v1.3.0.',
    })
    expect(agentsAction(agents(runtime('1.4.0'), runtime('2.0.0'))))
      .toMatchObject({ target: 'all', hosts: ['claude', 'copilot'], label: 'Match agents to v1.3.0' })
  })

  it('takes ONE action, named for what it does, when one host is behind and another ahead', () => {
    expect(agentsAction(agents(runtime('1.2.8'), runtime('1.4.0')))).toEqual({
      target: 'all',
      hosts: ['claude', 'copilot'],
      label: 'Match agents to v1.3.0',
      hint: 'Match agents to v1.3.0 updates Claude Code and moves Copilot CLI back to this app\'s runtime. Running sessions keep their build until you restart them.',
      elsewhere: 'Open Settings in the Agent Inbox app to match Claude Code and Copilot CLI to the v1.3.0 runtime.',
      progress: 'Matching Claude Code and Copilot CLI to v1.3.0…',
      done: 'Claude Code and Copilot CLI now match v1.3.0.',
    })
  })

  it('offers nothing when every Setup-managed host already runs this app\'s runtime', () => {
    expect(agentsAction(agents(runtime('1.3.0'), runtime('1.3.0')))).toBeNull()
    // build metadata has no precedence: the same release
    expect(agentsAction(agents(runtime('1.3.0+build.7'), { kind: 'none' }))).toBeNull()
  })

  it('never includes a checkout, a custom or unverifiable registration, or a runtime of unknown version', () => {
    for (const other of [{ kind: 'checkout', path: '/src' }, { kind: 'other' }, { kind: 'unknown' }, { kind: 'none' }, { kind: 'runtime' }]) {
      expect(agentsAction(agents(runtime('1.2.8'), other))?.hosts, JSON.stringify(other)).toEqual(['claude'])
      expect(agentsAction(agents(other, runtime('1.4.0')))?.hosts, JSON.stringify(other)).toEqual(['copilot'])
    }
  })

  it('offers nothing where Setup cannot install this app\'s runtime, or there is none to compare with', () => {
    expect(agentsAction(agents(runtime('1.2.8'), runtime('1.4.0'), { updatable: false }))).toBeNull()
    expect(agentsAction(agents(runtime('1.2.8'), runtime('1.4.0'), { current: null }))).toBeNull()
    expect(agentsAction(null)).toBeNull()
  })

  it('maps hosts to the one fixed install target that moves exactly them', () => {
    expect(updateTarget(['claude', 'copilot'])).toBe('all')
    expect(updateTarget(['claude'])).toBe('claude')
    expect(updateTarget(['copilot'])).toBe('copilot')
    expect(updateTarget([])).toBeNull()
  })
})

describe('restartGuidance', () => {
  const row = (agent: string, version: string | null, source = 'runtime') =>
    ({ session: `${agent}-${version}-${Math.random()}`, agent, server_version: version, server_source: source })

  it('counts the running sessions of each moved host that still run an older build, and says how to restart them', () => {
    const activity = [
      row('claude-code', '1.2.8'), row('claude-code', '1.2.6', 'checkout'), row('claude-code', '1.3.0'),
      row('copilot', '1.2.8'), row('codex', '1.0.0'),
    ]
    expect(restartGuidance(activity, ['claude', 'copilot'], '1.3.0')).toEqual([
      'Claude Code: 2 running sessions still run an older build. Restart each one to load v1.3.0: exit it, then run claude --resume to pick the conversation back up.',
      'Copilot CLI: 1 running session still runs an older build. Restart it to load v1.3.0: exit it, then run copilot --resume to pick the conversation back up.',
    ])
  })

  it('after matching a newer runtime, counts the sessions still on the newer build — or on both sides', () => {
    expect(restartGuidance([row('copilot', '1.3.1'), row('copilot', '1.3.0')], ['copilot'], '1.3.0')).toEqual([
      'Copilot CLI: 1 running session still runs a newer build. Restart it to load v1.3.0: exit it, then run copilot --resume to pick the conversation back up.',
    ])
    expect(restartGuidance([row('claude-code', '1.2.8'), row('claude-code', '1.4.0')], ['claude'], '1.3.0')).toEqual([
      'Claude Code: 2 running sessions still run a different build. Restart each one to load v1.3.0: exit it, then run claude --resume to pick the conversation back up.',
    ])
  })

  it('says so when every session already runs this build, and is honest about sessions that report none', () => {
    const activity = [row('claude-code', '1.3.0'), row('claude-code', null), row('copilot', '1.2.8')]
    expect(restartGuidance(activity, ['claude'], '1.3.0')).toEqual([
      'Claude Code: every running session that reports its build already runs v1.3.0. 1 session does not report its build; restart it to be sure.',
    ])
    expect(restartGuidance([], ['copilot'], '1.3.0')).toEqual(['Copilot CLI: no running sessions.'])
    for (const line of restartGuidance(activity, ['claude', 'copilot'], '1.3.0')) {
      expect(line).not.toMatch(/reloaded|reconnected|now running/i)
    }
  })
})
