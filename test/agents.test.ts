// Issue #197, part 2 — the Setup panel's agents block, as pure functions: one
// line per host saying which build it is registered to run, the ONE explicit
// action that moves the Setup-managed hosts onto this app's runtime (in either
// direction: an older runtime is updated, a newer one after an app downgrade is
// matched back) one fixed install target per host, and — afterwards — which
// running sessions still run another build than their host now loads, and how
// to restart them. It never says a running session reloaded.
import { describe, expect, it } from 'vitest'
import { agentsAction, hooksGuidance, hooksNextStep, hostLine, restartGuidance } from '../public/agents.js'

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
    ({ current: '1.3.0', updatable: true, claude, copilot, hooks: { kind: 'none' }, hooksCommand: '', ...extra })

  // One fixed install target per host, run one after another: a host whose CLI
  // is gone must not block the other, as `--target all` would before changing
  // anything.
  const update = (host: string, label: string) => ({ host, progress: `Updating ${label}…`, done: `${label} updated.` })
  const match = (host: string, label: string) => ({ host, progress: `Matching ${label} to v1.3.0…`, done: `${label} now matches v1.3.0.` })

  it('updates the Setup-managed hosts on an older runtime, one fixed target per host', () => {
    expect(agentsAction(agents(runtime('1.2.8'), runtime('1.3.0')))).toEqual({
      steps: [update('claude', 'Claude Code')],
      label: 'Update agents',
      hint: 'Update agents moves Claude Code to the v1.3.0 runtime. Running sessions keep their build until you restart them.',
      elsewhere: 'Open Settings in the Agent Inbox app to update Claude Code to the v1.3.0 runtime.',
    })
    expect(agentsAction(agents(runtime('1.2.8'), runtime('1.1.0')))).toMatchObject({
      steps: [update('claude', 'Claude Code'), update('copilot', 'Copilot CLI')],
      label: 'Update agents',
    })
  })

  it('matches a host on a NEWER runtime back to this app\'s, and says so', () => {
    expect(agentsAction(agents(runtime('1.3.0'), runtime('1.3.1')))).toEqual({
      steps: [match('copilot', 'Copilot CLI')],
      label: 'Match agents to v1.3.0',
      hint: 'Copilot CLI runs a newer runtime than this app. Match agents to v1.3.0 moves it to this app\'s runtime. Running sessions keep their build until you restart them.',
      elsewhere: 'Open Settings in the Agent Inbox app to match Copilot CLI to the v1.3.0 runtime.',
    })
    expect(agentsAction(agents(runtime('1.4.0'), runtime('2.0.0')))).toMatchObject({
      steps: [match('claude', 'Claude Code'), match('copilot', 'Copilot CLI')],
      label: 'Match agents to v1.3.0',
    })
  })

  it('takes ONE action, named for what it does, when one host is behind and another ahead', () => {
    expect(agentsAction(agents(runtime('1.2.8'), runtime('1.4.0')))).toEqual({
      steps: [update('claude', 'Claude Code'), match('copilot', 'Copilot CLI')],
      label: 'Match agents to v1.3.0',
      hint: 'Match agents to v1.3.0 updates Claude Code and moves Copilot CLI back to this app\'s runtime. Running sessions keep their build until you restart them.',
      elsewhere: 'Open Settings in the Agent Inbox app to match Claude Code and Copilot CLI to the v1.3.0 runtime.',
    })
  })

  it('offers nothing when every Setup-managed host already runs this app\'s runtime', () => {
    expect(agentsAction(agents(runtime('1.3.0'), runtime('1.3.0')))).toBeNull()
    // build metadata has no precedence: the same release
    expect(agentsAction(agents(runtime('1.3.0+build.7'), { kind: 'none' }))).toBeNull()
  })

  it('never includes a checkout, a custom or unverifiable registration, or a runtime of unknown version', () => {
    const hosts = (action: { steps: Array<{ host: string }> } | null) => action?.steps.map((step) => step.host)
    for (const other of [{ kind: 'checkout', path: '/src' }, { kind: 'other' }, { kind: 'unknown' }, { kind: 'none' }, { kind: 'runtime' }]) {
      expect(hosts(agentsAction(agents(runtime('1.2.8'), other))), JSON.stringify(other)).toEqual(['claude'])
      expect(hosts(agentsAction(agents(other, runtime('1.4.0')))), JSON.stringify(other)).toEqual(['copilot'])
    }
  })

  it('offers nothing where Setup cannot install this app\'s runtime, or there is none to compare with', () => {
    expect(agentsAction(agents(runtime('1.2.8'), runtime('1.4.0'), { updatable: false }))).toBeNull()
    expect(agentsAction(agents(runtime('1.2.8'), runtime('1.4.0'), { current: null }))).toBeNull()
    expect(agentsAction(null)).toBeNull()
  })

  // #206: Claude's hooks move through their own fixed `hooks` target, which runs
  // the installed copy of this app's runtime's install-hooks.sh. So the step
  // comes last, after any agent step (each installs that runtime), and without
  // one it needs the runtime installed already: exactly when the viewer hands
  // over `hooksCommand`.
  const COMMAND = "bash '/home/me/.agent-inbox/runtime/agent-inbox-runtime-1.3.0-darwin-arm64-0123456789abcdef/scripts/install-hooks.sh' --apply"

  it('moves Setup-runtime hooks on another version as their own last step, after the agents', () => {
    expect(agentsAction(agents(runtime('1.2.8'), runtime('1.3.0'), { hooks: runtime('1.2.4') }))).toEqual({
      steps: [update('claude', 'Claude Code'), update('hooks', 'Claude hooks')],
      label: 'Update agents',
      hint: 'Update agents moves Claude Code and Claude hooks to the v1.3.0 runtime. Running sessions keep their build until you restart them.',
      elsewhere: 'Open Settings in the Agent Inbox app to update Claude Code and Claude hooks to the v1.3.0 runtime.',
    })
    expect(agentsAction(agents(runtime('1.2.8'), runtime('1.1.0'), { hooks: runtime('1.2.4') }))).toMatchObject({
      steps: [update('claude', 'Claude Code'), update('copilot', 'Copilot CLI'), update('hooks', 'Claude hooks')],
      hint: 'Update agents moves Claude Code, Copilot CLI and Claude hooks to the v1.3.0 runtime. Running sessions keep their build until you restart them.',
    })
  })

  it('moves hooks alone only once this app\'s runtime is installed', () => {
    expect(agentsAction(agents(runtime('1.3.0'), { kind: 'none' }, { hooks: runtime('1.2.4'), hooksCommand: COMMAND }))).toEqual({
      steps: [update('hooks', 'Claude hooks')],
      label: 'Update agents',
      // no agent moves, so nothing about sessions keeping their build
      hint: 'Update agents moves Claude hooks to the v1.3.0 runtime.',
      elsewhere: 'Open Settings in the Agent Inbox app to update Claude hooks to the v1.3.0 runtime.',
    })
    // no agent step would install it first: nothing that cannot succeed
    expect(agentsAction(agents(runtime('1.3.0'), { kind: 'none' }, { hooks: runtime('1.2.4') }))).toBeNull()
    expect(agentsAction(agents({ kind: 'checkout', path: '/src' }, { kind: 'other' }, { hooks: runtime('1.2.4') }))).toBeNull()
  })

  it('matches hooks on a NEWER runtime back to this app\'s, and says so', () => {
    expect(agentsAction(agents(runtime('1.3.0'), runtime('1.3.0'), { hooks: runtime('1.4.0'), hooksCommand: COMMAND }))).toEqual({
      steps: [{ host: 'hooks', progress: 'Matching Claude hooks to v1.3.0…', done: 'Claude hooks now match v1.3.0.' }],
      label: 'Match agents to v1.3.0',
      hint: 'Claude hooks run a newer runtime than this app. Match agents to v1.3.0 moves them to this app\'s runtime.',
      elsewhere: 'Open Settings in the Agent Inbox app to match Claude hooks to the v1.3.0 runtime.',
    })
    expect(agentsAction(agents(runtime('1.2.8'), runtime('1.3.0'), { hooks: runtime('1.4.0') }))).toMatchObject({
      steps: [update('claude', 'Claude Code'), { host: 'hooks', progress: 'Matching Claude hooks to v1.3.0…', done: 'Claude hooks now match v1.3.0.' }],
      label: 'Match agents to v1.3.0',
      hint: 'Match agents to v1.3.0 updates Claude Code and moves Claude hooks back to this app\'s runtime. Running sessions keep their build until you restart them.',
    })
  })

  it('never moves hooks Setup does not manage, of unknown version, already current, or where it cannot install this runtime', () => {
    const hosts = (action: { steps: Array<{ host: string }> } | null) => action?.steps.map((step) => step.host) ?? null
    for (const hooks of [{ kind: 'checkout', path: '/src/agent-inbox' }, { kind: 'other' }, { kind: 'unknown' }, { kind: 'none' }, { kind: 'runtime' }, runtime('1.3.0')]) {
      expect(hosts(agentsAction(agents(runtime('1.2.8'), runtime('1.3.0'), { hooks, hooksCommand: COMMAND }))), JSON.stringify(hooks)).toEqual(['claude'])
      expect(hosts(agentsAction(agents(runtime('1.3.0'), runtime('1.3.0'), { hooks, hooksCommand: COMMAND }))), JSON.stringify(hooks)).toBeNull()
    }
    expect(agentsAction(agents(runtime('1.2.8'), runtime('1.3.0'), { hooks: runtime('1.2.4'), hooksCommand: COMMAND, updatable: false }))).toBeNull()
  })
})

// #278: a hooks line that differs from this app's runtime always ends in a step
// the human can take. Setup installs this app's runtime only while it registers
// an agent it manages, and never switches a checkout, so with Claude Code on a
// checkout nothing in Setup would ever keep a "once this app's runtime is
// installed" promise: the checkout's own hook installer is the step there.
describe('hooksNextStep (#278)', () => {
  const CHECKOUT = '/Users/me/Development/agent-inbox'
  const checkout = { kind: 'checkout', path: CHECKOUT }
  const CHECKOUT_COMMAND = `cd '${CHECKOUT}' && npm run install:hooks -- --apply --replace-existing`
  const RUNTIME_COMMAND = "bash '/home/me/.agent-inbox/runtime/agent-inbox-runtime-1.5.0-darwin-arm64-0123456789abcdef/scripts/install-hooks.sh' --apply"
  const state = (claude: unknown, copilot: unknown, extra: Record<string, unknown> = {}) =>
    ({ current: '1.5.0', updatable: true, claude, copilot, hooks: runtime('1.2.4'), hooksCommand: '', ...extra })
  const FROM_CHECKOUT = {
    text: 'Claude Code runs from your source checkout. To point Claude hooks at it too, run this in a terminal with Node 24:',
    command: CHECKOUT_COMMAND,
  }
  const PROMISE = { text: 'Once this app\'s v1.5.0 runtime is installed, Setup can move Claude hooks to it.', command: null }
  const MANUAL = {
    text: 'Setup cannot move these hooks. To change them, run Agent Inbox\'s hook installer in a terminal, as docs/hooks.md describes.',
    command: null,
  }

  it('hands over the hook command of the checkout Claude Code runs from, and no runtime promise: the reported case', () => {
    const reported = state(checkout, checkout, { checkoutHooksCommand: CHECKOUT_COMMAND })
    expect(agentsAction(reported)).toBeNull()
    expect(hooksNextStep(reported, true)).toEqual(FROM_CHECKOUT)
    expect(hooksNextStep(reported, false)).toEqual(FROM_CHECKOUT)
    // the checkout's own installer even where a Setup install could put this
    // app's runtime in place for Copilot CLI: Claude Code would not run it
    expect(hooksNextStep(state(checkout, { kind: 'none' }, { checkoutHooksCommand: CHECKOUT_COMMAND }), true)).toEqual(FROM_CHECKOUT)
    // hooks on a newer runtime, after an app downgrade
    expect(hooksNextStep(state(checkout, checkout, { hooks: runtime('1.6.0'), checkoutHooksCommand: CHECKOUT_COMMAND }), true)).toEqual(FROM_CHECKOUT)
    // where this release cannot install its own runtime at all
    expect(hooksNextStep(state(checkout, checkout, { updatable: false, checkoutHooksCommand: CHECKOUT_COMMAND }), false)).toEqual(FROM_CHECKOUT)
  })

  it('keeps the promise only where a Setup install could put this app\'s runtime in place', () => {
    // an unregistered host, or one on Setup's runtime, is one Setup can register
    for (const [claude, copilot] of [
      [{ kind: 'none' }, { kind: 'none' }],
      [{ kind: 'other' }, { kind: 'none' }],
      [{ kind: 'unknown' }, { kind: 'runtime' }],
      [{ kind: 'checkout' }, { kind: 'none' }],
    ]) {
      expect(hooksNextStep(state(claude, copilot), true), JSON.stringify([claude, copilot])).toEqual(PROMISE)
      expect(hooksNextStep(state(claude, copilot), false), JSON.stringify([claude, copilot])).toEqual(PROMISE)
    }
  })

  it('says plainly that Setup cannot move them, and where to look, when nothing in Setup could', () => {
    for (const [claude, copilot] of [
      [{ kind: 'other' }, checkout],
      [{ kind: 'unknown' }, { kind: 'other' }],
      // a checkout whose path could not be reported: no command to hand over
      [{ kind: 'checkout' }, checkout],
    ]) {
      expect(hooksNextStep(state(claude, copilot), true), JSON.stringify([claude, copilot])).toEqual(MANUAL)
    }
    // this release cannot install its runtime here, whatever the hosts are
    expect(hooksNextStep(state({ kind: 'none' }, { kind: 'none' }, { updatable: false }), true)).toEqual(MANUAL)
    expect(hooksNextStep(state({ kind: 'runtime' }, { kind: 'none' }, { updatable: false }), false)).toEqual(MANUAL)
  })

  it('leaves the runtime\'s own hook command and the action\'s steps as they were', () => {
    // installed, so the action moves them: its button here, its terminal command elsewhere
    for (const claude of [{ kind: 'none' }, checkout]) {
      const installed = state(claude, { kind: 'none' }, { hooksCommand: RUNTIME_COMMAND, checkoutHooksCommand: CHECKOUT_COMMAND })
      expect(agentsAction(installed)?.steps.map((step) => step.host)).toEqual(['hooks'])
      expect(hooksNextStep(installed, true)).toBeNull()
      expect(hooksNextStep(installed, false)).toEqual({ text: 'Or move them from a terminal:', command: RUNTIME_COMMAND })
    }
    // installed but no action to run it: the command alone
    expect(hooksNextStep(state({ kind: 'none' }, { kind: 'none' }, { hooksCommand: RUNTIME_COMMAND, updatable: false }), true))
      .toEqual({ text: 'To move Claude hooks to v1.5.0, run this in a terminal:', command: RUNTIME_COMMAND })
    // an agent step installs the runtime first: the button, or the action's
    // "Open Settings in the Agent Inbox app" line, is the step
    for (const claude of [runtime('1.2.8'), checkout]) {
      const moving = state(claude, runtime('1.2.8'), { checkoutHooksCommand: CHECKOUT_COMMAND })
      expect(agentsAction(moving)?.steps.at(-1)?.host).toBe('hooks')
      expect(hooksNextStep(moving, true)).toBeNull()
      expect(hooksNextStep(moving, false)).toBeNull()
    }
  })

  it('adds nothing for hooks on the checkout, on this app\'s runtime, absent, or Setup does not compare', () => {
    for (const hooks of [checkout, { kind: 'checkout', path: '/elsewhere/agent-inbox' }, runtime('1.5.0'), { kind: 'runtime' }, { kind: 'none' }, { kind: 'other' }, { kind: 'unknown' }]) {
      expect(hooksNextStep(state(checkout, checkout, { hooks, checkoutHooksCommand: CHECKOUT_COMMAND }), true), JSON.stringify(hooks)).toBeNull()
    }
    // a checkout viewer has no runtime of its own to compare with
    expect(hooksNextStep(state(checkout, checkout, { current: null, checkoutHooksCommand: CHECKOUT_COMMAND }), true)).toBeNull()
    expect(hooksNextStep(null, true)).toBeNull()
  })

  it('never leaves an older or newer hooks line without a next step, and promises only what Setup can do', () => {
    const kinds = [
      { kind: 'none' }, { kind: 'runtime' }, runtime('1.2.8'), runtime('1.5.0'), runtime('1.6.0'),
      checkout, { kind: 'checkout' }, { kind: 'other' }, { kind: 'unknown' },
    ]
    for (const claude of kinds) for (const copilot of kinds) for (const hooks of [runtime('1.2.4'), runtime('1.6.0')]) {
      for (const updatable of [true, false]) for (const hooksCommand of ['', RUNTIME_COMMAND]) for (const canRun of [true, false]) {
        const agents = state(claude, copilot, { hooks, updatable, hooksCommand, ...(claude === checkout ? { checkoutHooksCommand: CHECKOUT_COMMAND } : {}) })
        const label = JSON.stringify({ claude, copilot, hooks, updatable, hooksCommand, canRun })
        const hooksStep = agentsAction(agents)?.steps.some((step) => step.host === 'hooks') === true
        const step = hooksNextStep(agents, canRun)
        // the action's button, its "Open Settings in the Agent Inbox app" line, or this
        expect(hooksStep || step !== null, label).toBe(true)
        if (step?.text === PROMISE.text) {
          expect(updatable && [claude, copilot].some((reg) => reg.kind === 'none' || reg.kind === 'runtime'), label).toBe(true)
        }
      }
    }
  })
})

describe('hooksGuidance', () => {
  const after = (hooks: unknown) => ({ current: '1.3.0', updatable: true, claude: { kind: 'none' }, copilot: { kind: 'none' }, hooks, hooksCommand: '' })

  it('says hooks moved only when the re-read shows them on exactly this version, and how running sessions pick them up', () => {
    expect(hooksGuidance(after(runtime('1.3.0')), '1.3.0')).toEqual({
      moved: true,
      text: 'Claude hooks: new Claude Code sessions run the v1.3.0 hooks. Claude Code normally applies changed hooks to running sessions too; to be sure one does, restart it: exit it, then run claude --resume.',
    })
    expect(hooksGuidance(after(runtime('1.3.0')), '1.3.0').text).not.toMatch(/reloaded|reconnected/i)
  })

  it('never claims a move the re-read does not show', () => {
    for (const hooks of [runtime('1.2.4'), runtime('1.4.0'), { kind: 'unknown' }, { kind: 'none' }, { kind: 'checkout', path: '/src' }]) {
      expect(hooksGuidance(after(hooks), '1.3.0'), JSON.stringify(hooks)).toEqual({
        moved: false,
        text: 'Claude hooks: the installer finished, but Setup does not see them on v1.3.0; the list above shows what it reads.',
      })
    }
    expect(hooksGuidance(null, '1.3.0')).toEqual({
      moved: false,
      text: 'Claude hooks: the installer finished, but Setup could not re-read Claude\'s settings to confirm the move.',
    })
  })
})

describe('restartGuidance', () => {
  const row = (agent: string, version: string | null, source = 'runtime') =>
    ({ session: `${agent}-${version}-${Math.random()}`, agent, server_version: version, server_source: source })
  const moved = (version: string, ...hosts: Array<'claude' | 'copilot'>) => hosts.map((host) => ({ host, version }))

  it('counts the running sessions of each moved host that still run an older build, and says how to restart them', () => {
    const activity = [
      row('claude-code', '1.2.8'), row('claude-code', '1.2.6', 'checkout'), row('claude-code', '1.3.0'),
      row('copilot', '1.2.8'), row('codex', '1.0.0'),
    ]
    expect(restartGuidance(activity, moved('1.3.0', 'claude', 'copilot'))).toEqual([
      'Claude Code: 2 running sessions still run an older build. Restart each one to load v1.3.0: exit it, then run claude --resume to pick the conversation back up.',
      'Copilot CLI: 1 running session still runs an older build. Restart it to load v1.3.0: exit it, then run copilot --resume to pick the conversation back up.',
    ])
  })

  it('after matching a host down from v2.1.0, counts every session still on v2.1.0 — the review\'s case', () => {
    expect(restartGuidance([{ agent: 'claude-code', server_version: '2.1.0' }], [{ host: 'claude', version: '2.0.0' }])).toEqual([
      'Claude Code: 1 running session still runs a newer build. Restart it to load v2.0.0: exit it, then run claude --resume to pick the conversation back up.',
    ])
    expect(restartGuidance([row('copilot', '1.3.1'), row('copilot', '1.3.0')], moved('1.3.0', 'copilot'))).toEqual([
      'Copilot CLI: 1 running session still runs a newer build. Restart it to load v1.3.0: exit it, then run copilot --resume to pick the conversation back up.',
    ])
    expect(restartGuidance([row('claude-code', '1.2.8'), row('claude-code', '1.4.0')], moved('1.3.0', 'claude'))).toEqual([
      'Claude Code: 2 running sessions still run a different build. Restart each one to load v1.3.0: exit it, then run claude --resume to pick the conversation back up.',
    ])
  })

  it('compares each moved host with what IT now runs', () => {
    const activity = [row('claude-code', '1.3.0'), row('copilot', '1.3.0')]
    expect(restartGuidance(activity, [{ host: 'claude', version: '1.3.0' }, { host: 'copilot', version: '1.2.9' }])).toEqual([
      'Claude Code: every running session that reports its build already runs v1.3.0.',
      'Copilot CLI: 1 running session still runs a newer build. Restart it to load v1.2.9: exit it, then run copilot --resume to pick the conversation back up.',
    ])
  })

  it('says so when every session already runs this build, and is honest about sessions that report none', () => {
    const activity = [row('claude-code', '1.3.0'), row('claude-code', null), row('copilot', '1.2.8')]
    expect(restartGuidance(activity, moved('1.3.0', 'claude'))).toEqual([
      'Claude Code: every running session that reports its build already runs v1.3.0. 1 session does not report its build; restart it to be sure.',
    ])
    expect(restartGuidance([], moved('1.3.0', 'copilot'))).toEqual(['Copilot CLI: no running sessions.'])
    for (const line of restartGuidance(activity, moved('1.3.0', 'claude', 'copilot'))) {
      expect(line).not.toMatch(/reloaded|reconnected|now running/i)
    }
  })
})
