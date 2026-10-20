// @vitest-environment jsdom
// test/dom/agents-setup.test.ts
//
// Issue #197, part 2, through the real viewer over a real DB and real host
// config files in a scratch home: Setup says which build each host's agents
// are registered to run and offers ONE explicit action for exactly the
// Setup-managed hosts whose runtime differs from this app's — "Update agents"
// when they are behind, "Match agents to vX" when one is ahead (an app
// downgrade). It runs the existing fixed-target install through the existing
// Electron bridge, one host's fixed target after another — no new command, and
// one host's missing CLI never blocks the other — and never switches a
// checkout or custom registration. Afterwards it re-reads every host, refreshes
// Live, and says which running sessions still need a restart and how; it never
// claims a running session reloaded.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { recordActivityCall, upsertActivity } from '../../src/store.js'
import { registerHost, releaseRuntime } from '../release-runtime.js'
import type { ReleaseRuntime } from '../release-runtime.js'
import { advanceClock, bootApp, click, freshDb, pollTick, settle, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
  delete (window as unknown as Record<string, unknown>).agentInboxSetup
})

type InstallResult = { ok: boolean; exitCode: number | null; target: string; timedOut: boolean; cancelled?: boolean; output: string }
type Install = (...args: unknown[]) => Promise<InstallResult>

function bridge(install: Install, available = true): void {
  Object.defineProperty(window, 'agentInboxSetup', {
    configurable: true,
    value: { available: async () => available, install },
  })
}

async function boot(release: ReleaseRuntime): Promise<Database.Database> {
  db = freshDb()
  await bootApp(db, { viewer: { ...release.viewer, stamp: async () => null as never } })
  await settle()
  return db
}

/** A source checkout of this repo inside the scratch home. */
function checkoutIn(release: ReleaseRuntime, name = 'agent-inbox'): string {
  const root = join(release.home, 'src', name)
  mkdirSync(join(root, 'dist'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{"name":"agent-inbox"}')
  writeFileSync(join(root, 'dist', 'mcp-server.js'), '')
  return root
}

const lines = (): string[] => [...document.querySelectorAll('.agents-hosts li')].map((li) => li.textContent ?? '')
const updateButton = (): HTMLButtonElement | null => document.querySelector('.agents-update-btn')
const agentsText = (): string => document.querySelector('.agents-status')?.textContent ?? ''
const ok = (target: string, output = `${target}: registered agent-inbox MCP`): InstallResult =>
  ({ ok: true, exitCode: 0, target, timedOut: false, output })

describe('Setup shows what each host\'s agents run (#197)', () => {
  it('names each host\'s Setup runtime, checkout or absence, compared with this app\'s runtime', async () => {
    const release = releaseRuntime('2.0.0')
    release.register('claude', release.installVersion('1.2.8'))
    // a checkout path comes from a config file: text, never markup
    const root = checkoutIn(release, '<img src=x onerror=alert(1)>')
    registerHost(release.home, 'copilot', process.execPath, join(root, 'dist', 'mcp-server.js'))

    await boot(release)

    expect(lines()).toEqual([
      'Claude Code: v1.2.8 runtime (Setup) — older than this app\'s v2.0.0',
      `Copilot CLI: source checkout at ${realpathSync(root)} (not managed by Setup)`,
      'Claude hooks: not installed',
    ])
    expect(document.querySelector('.agents-hosts li[data-host="claude"]')?.classList.contains('outdated')).toBe(true)
    expect(document.querySelector('#setup img')).toBeNull()
    expect(agentsText()).toContain('Setup does not update a source checkout: run git pull and npm run build in it, then restart its sessions.')
  })

  it('says a host is not registered, and a current one plainly', async () => {
    const release = releaseRuntime('2.0.0')
    release.register('copilot', release.install())

    await boot(release)

    expect(lines()).toEqual([
      'Claude Code: not registered',
      'Copilot CLI: v2.0.0 runtime (Setup)',
      'Claude hooks: not installed',
    ])
    expect(updateButton()).toBeNull()
  })

  const BOTH = [['claude'], ['copilot']]
  it.each([
    ['both hosts on an older runtime', BOTH, 'Update agents', (r: ReleaseRuntime) => {
      const old = r.installVersion('1.2.8')
      r.register('claude', old)
      r.register('copilot', old)
    }],
    ['only Claude Code behind', [['claude']], 'Update agents', (r: ReleaseRuntime) => {
      r.register('claude', r.installVersion('1.2.8'))
      r.register('copilot', r.install())
    }],
    ['Copilot CLI behind, Claude Code on a checkout it must not switch', [['copilot']], 'Update agents', (r: ReleaseRuntime) => {
      registerHost(r.home, 'claude', process.execPath, join(checkoutIn(r), 'dist', 'mcp-server.js'))
      r.register('copilot', r.installVersion('1.1.0'))
    }],
    ['only Claude Code ahead, after an app downgrade', [['claude']], 'Match agents to v2.0.0', (r: ReleaseRuntime) => {
      r.register('claude', r.installVersion('2.1.0'))
      r.register('copilot', r.install())
    }],
    ['Claude Code behind and Copilot CLI ahead', BOTH, 'Match agents to v2.0.0', (r: ReleaseRuntime) => {
      r.register('claude', r.installVersion('1.2.8'))
      r.register('copilot', r.installVersion('2.1.0'))
    }],
  ])('offers one action for exactly the Setup-managed hosts that differ: %s', async (_label, calls, label, arrange) => {
    const release = releaseRuntime('2.0.0')
    arrange(release)
    const install = vi.fn<Install>(async (t) => ok(String(t)))
    bridge(install)

    await boot(release)
    expect(document.querySelectorAll('.agents-update-btn')).toHaveLength(1)
    const run = updateButton()
    expect(run?.textContent).toBe(label)
    run!.click()
    await settle()

    // the existing fixed-target bridge: one fixed target per host, nothing else
    expect(install.mock.calls).toEqual(calls)
  })

  it('moves each host on its own fixed target, so a host whose CLI is gone does not block the other', async () => {
    const release = releaseRuntime('2.0.0')
    const old = release.installVersion('1.2.8')
    release.register('claude', old)
    release.register('copilot', old)
    // Claude Code was uninstalled but its registration remains: it goes FIRST
    const missing = "install-agents: 'claude' CLI is not installed; choose a different --target"
    const install = vi.fn<Install>(async (t) => {
      if (t === 'claude') return { ok: false, exitCode: 1, target: 'claude', timedOut: false, output: missing }
      release.register('copilot', release.install())
      return ok(String(t))
    })
    bridge(install)
    db = freshDb()
    upsertActivity(db, { session: 'c1', project: 'alpha', stream: 'main', agent: 'claude-code', doing: 'open', idle: true, claim: false, server_version: '1.2.8', server_source: 'runtime' })
    upsertActivity(db, { session: 'p1', project: 'beta', stream: 'main', agent: 'copilot', doing: 'open', idle: true, claim: false, server_version: '1.2.8', server_source: 'runtime' })
    await bootApp(db, { viewer: { ...release.viewer, stamp: async () => null as never } })
    await settle()

    click(updateButton())
    await settle()

    expect(install.mock.calls).toEqual([['claude'], ['copilot']])
    const result = document.querySelector('.agents-result')
    // each host's own outcome, and the whole marked as not done
    expect(result?.textContent).toBe(`Claude Code: ${missing}\n\nCopilot CLI: copilot: registered agent-inbox MCP`)
    expect(result?.classList.contains('failure')).toBe(true)
    // Copilot CLI moved; Claude Code did not, and is still offered
    expect(lines().slice(0, 2)).toEqual([
      'Claude Code: v1.2.8 runtime (Setup) — older than this app\'s v2.0.0',
      'Copilot CLI: v2.0.0 runtime (Setup)',
    ])
    expect(updateButton()?.textContent).toBe('Update agents')
    // restart advice only for the host that moved
    const restart = document.querySelector('.agents-restart') as HTMLElement
    expect(restart.hidden).toBe(false)
    expect(restart.textContent).toBe(
      'Running sessions keep the build they started with until you restart them.'
      + 'Copilot CLI: 1 running session still runs an older build. Restart it to load v2.0.0: exit it, then run copilot --resume to pick the conversation back up.',
    )
  })

  // #205 review (BLOCKER): a quit during the first host's install cancels it.
  // Starting the next host then would run it mid-shutdown, where the exit can
  // kill it halfway through replacing a registration. A cancelled or timed-out
  // step, or a bridge that fails outright, ends the run: no later host starts,
  // and each host's state is reported as it is.
  it.each([
    ['cancelled because Agent Inbox is quitting', 'was cancelled',
      async () => ({ ok: false, exitCode: null, target: 'claude', timedOut: false, cancelled: true, output: 'started\nInstaller cancelled because Agent Inbox is closing.' }),
      'started\nInstaller cancelled because Agent Inbox is closing.'],
    ['refused by main because Agent Inbox is quitting', 'was cancelled',
      async () => ({ ok: false, exitCode: null, target: 'claude', timedOut: false, cancelled: true, output: 'Agent Inbox is quitting, so setup did not start.' }),
      'Agent Inbox is quitting, so setup did not start.'],
    ['timed out', 'timed out',
      async () => ({ ok: false, exitCode: null, target: 'claude', timedOut: true, cancelled: false, output: 'Installer timed out after 120000ms.' }),
      'Installer timed out after 120000ms.'],
    ['failed in the bridge itself', 'could not run',
      async () => { throw new Error('Error invoking remote method: render frame was disposed') },
      'Setup failed: Error invoking remote method: render frame was disposed'],
  ])('stops after a host whose install %s, and never starts the next host', async (_label, stopped, claude, claudeReport) => {
    const release = releaseRuntime('2.0.0')
    const old = release.installVersion('1.2.8')
    release.register('claude', old)
    release.register('copilot', old)
    const install = vi.fn<Install>(async (t) => {
      if (t === 'claude') return claude() as Promise<InstallResult>
      release.register('copilot', release.install())
      return ok(String(t))
    })
    bridge(install)

    await boot(release)
    click(updateButton())
    await settle()

    expect(install.mock.calls).toEqual([['claude']])
    const result = document.querySelector('.agents-result')
    expect(result?.textContent).toBe(
      `Claude Code: ${claudeReport}\n\nCopilot CLI: not started, because Setup stopped after Claude Code ${stopped}.`,
    )
    expect(result?.classList.contains('failure')).toBe(true)
    // nothing moved: both still offered, no restart advice
    expect(lines().slice(0, 2)).toEqual([
      'Claude Code: v1.2.8 runtime (Setup) — older than this app\'s v2.0.0',
      'Copilot CLI: v1.2.8 runtime (Setup) — older than this app\'s v2.0.0',
    ])
    expect((document.querySelector('.agents-restart') as HTMLElement).hidden).toBe(true)
  })

  it('still reports the host that moved when the next one is cancelled', async () => {
    const release = releaseRuntime('2.0.0')
    const old = release.installVersion('1.2.8')
    release.register('claude', old)
    release.register('copilot', old)
    const install = vi.fn<Install>(async (t) => {
      if (t === 'copilot') return { ok: false, exitCode: null, target: 'copilot', timedOut: false, cancelled: true, output: 'Installer cancelled because Agent Inbox is closing.' }
      release.register('claude', release.install())
      return ok(String(t))
    })
    bridge(install)

    await boot(release)
    click(updateButton())
    await settle()

    expect(install.mock.calls).toEqual([['claude'], ['copilot']])
    expect(document.querySelector('.agents-result')?.textContent)
      .toBe('Claude Code: claude: registered agent-inbox MCP\n\nCopilot CLI: Installer cancelled because Agent Inbox is closing.')
    expect(lines()[0]).toBe('Claude Code: v2.0.0 runtime (Setup)')
    expect((document.querySelector('.agents-restart') as HTMLElement).textContent).toContain('Claude Code: no running sessions.')
  })

  it('names the one action for what it does when one host is behind and another ahead', async () => {
    const release = releaseRuntime('2.0.0')
    release.register('claude', release.installVersion('1.2.8'))
    release.register('copilot', release.installVersion('2.1.0'))
    bridge(vi.fn<Install>(async (t) => ok(String(t))))

    await boot(release)

    expect(lines().slice(0, 2)).toEqual([
      'Claude Code: v1.2.8 runtime (Setup) — older than this app\'s v2.0.0',
      'Copilot CLI: v2.1.0 runtime (Setup) — newer than this app\'s v2.0.0',
    ])
    expect(document.querySelector('.agents-hosts li[data-host="copilot"]')?.classList.contains('newer')).toBe(true)
    expect(agentsText()).toContain('Match agents to v2.0.0 updates Claude Code and moves Copilot CLI back to this app\'s runtime. Running sessions keep their build until you restart them.')
    expect(agentsText()).not.toContain('Update agents')
  })

  it('offers no action when every Setup-managed host runs exactly this app\'s runtime', async () => {
    const release = releaseRuntime('2.0.0')
    const dir = release.install()
    release.register('claude', dir)
    release.register('copilot', dir)
    const install = vi.fn<Install>(async (t) => ok(String(t)))
    bridge(install)

    await boot(release)

    expect(lines().slice(0, 2)).toEqual(['Claude Code: v2.0.0 runtime (Setup)', 'Copilot CLI: v2.0.0 runtime (Setup)'])
    expect(updateButton()).toBeNull()
    expect(agentsText()).not.toMatch(/Update agents|Match agents/)
    expect(install).not.toHaveBeenCalled()
  })

  it('offers no Update agents in a browser tab, or in an app window that reused a viewer it does not own', async () => {
    const release = releaseRuntime('2.0.0')
    release.register('claude', release.installVersion('1.2.8'))
    const install = vi.fn<Install>(async (t) => ok(String(t)))
    bridge(install, false)

    await boot(release)

    expect(updateButton()).toBeNull()
    expect(agentsText()).toContain('Open Settings in the Agent Inbox app to update Claude Code to the v2.0.0 runtime.')
    expect(install).not.toHaveBeenCalled()
  })

  // #216: main proves a reloaded window again, which can finish after Setup was built.
  it('offers Update agents the next time Settings opens once main allows this window', async () => {
    const release = releaseRuntime('2.0.0')
    release.register('claude', release.installVersion('1.2.8'))
    let allowed = false
    const install = vi.fn<Install>(async (t) => ok(String(t)))
    Object.defineProperty(window, 'agentInboxSetup', {
      configurable: true,
      value: { available: async () => allowed, install },
    })

    await boot(release)
    expect(updateButton()).toBeNull()

    allowed = true
    click(document.getElementById('gear'))
    await settle()
    expect(updateButton()?.textContent).toBe('Update agents')
    click(updateButton())
    await settle()
    expect(install.mock.calls).toEqual([['claude']])
  })

  it('in a browser tab, says where to match a host that runs a newer runtime', async () => {
    const release = releaseRuntime('2.0.0')
    release.register('claude', release.installVersion('2.1.0'))
    bridge(vi.fn<Install>(async (t) => ok(String(t))), false)

    await boot(release)

    expect(updateButton()).toBeNull()
    expect(agentsText()).toContain('Open Settings in the Agent Inbox app to match Claude Code to the v2.0.0 runtime.')
  })

  it('offers no Update agents where this release cannot install its own runtime', async () => {
    const release = releaseRuntime('2.0.0', { hostPayload: false })
    release.register('claude', release.installVersion('1.2.8'))
    bridge(vi.fn<Install>(async (t) => ok(String(t))))

    await boot(release)

    expect(lines()[0]).toBe('Claude Code: v1.2.8 runtime (Setup) — older than this app\'s v2.0.0')
    expect(updateButton()).toBeNull()
  })

  it('after an update, re-reads each host, refreshes Live, and says which running sessions still need a restart', async () => {
    const release = releaseRuntime('2.0.0')
    release.register('claude', release.installVersion('1.2.8'))
    registerHost(release.home, 'copilot', process.execPath, join(checkoutIn(release), 'dist', 'mcp-server.js'))
    const install = vi.fn<Install>(async (t) => {
      // what the installer does for `--target claude`: install the runtime, move the registration
      release.register('claude', release.install())
      return ok(String(t))
    })
    bridge(install)
    db = freshDb()
    for (const [session, project, agent] of [['c1', 'alpha', 'claude-code'], ['c2', 'beta', 'claude-code'], ['p1', 'gamma', 'copilot']] as const) {
      upsertActivity(db, { session, project, stream: 'main', agent, doing: 'open', idle: true, claim: false, server_version: '1.2.8', server_source: agent === 'copilot' ? 'checkout' : 'runtime' })
      upsertActivity(db, { session, project, stream: 'main', agent, doing: `Working in ${project}` })
      recordActivityCall(db, session)
      advanceClock()
    }
    await bootApp(db, { viewer: { ...release.viewer, stamp: async () => null as never } })
    await settle()
    await pollTick()
    const liveHint = (project: string): string | null =>
      [...document.querySelectorAll('#liveDrawer .live-entry')]
        .find((el) => el.querySelector('.live-who')?.textContent?.includes(project))
        ?.querySelector('.live-build-hint')?.textContent ?? null
    expect(liveHint('alpha')).toBe('older build (v1.2.8) — update agents from Setup, then restart this session')

    click(updateButton())
    await settle()

    expect(install.mock.calls).toEqual([['claude']])
    const result = document.querySelector('.agents-result')
    expect(result?.textContent).toBe('claude: registered agent-inbox MCP')
    expect(result?.classList.contains('success')).toBe(true)
    // re-read: Claude Code now runs the new runtime; the checkout is untouched
    expect(lines()[0]).toBe('Claude Code: v2.0.0 runtime (Setup)')
    expect(lines()[1]).toContain('Copilot CLI: source checkout at')
    expect(updateButton()).toBeNull()
    // the sessions already running still run v1.2.8 until restarted, and it says so
    const restart = document.querySelector('.agents-restart') as HTMLElement
    expect(restart.hidden).toBe(false)
    expect(restart.textContent).toBe(
      'Running sessions keep the build they started with until you restart them.'
      + 'Claude Code: 2 running sessions still run an older build. Restart each one to load v2.0.0: exit it, then run claude --resume to pick the conversation back up.',
    )
    expect(restart.textContent).not.toMatch(/reloaded|reconnect/i)
    // and Live's advice follows the new registration, without reopening anything
    await pollTick()
    expect(liveHint('alpha')).toBe('older build (v1.2.8) — restart this session to load v2.0.0')
    expect(liveHint('gamma')).toBe('older build (v1.2.8) — update and rebuild its checkout, then restart this session')
  })

  it('re-reads what each host runs whenever Settings opens, so a terminal install shows up', async () => {
    const release = releaseRuntime('2.0.0')
    release.register('claude', release.installVersion('1.2.8'))

    await boot(release)
    expect(lines()[0]).toBe('Claude Code: v1.2.8 runtime (Setup) — older than this app\'s v2.0.0')

    // `install-agents.sh --apply --target claude` run from a terminal meanwhile
    release.register('claude', release.install())
    click(document.getElementById('gear'))
    await settle()

    expect(document.getElementById('setup')?.hidden).toBe(false)
    expect(lines()[0]).toBe('Claude Code: v2.0.0 runtime (Setup)')
  })

  it('after matching a newer runtime back to this app\'s, re-reads the host and says which sessions still run the newer build', async () => {
    const release = releaseRuntime('2.0.0')
    release.register('claude', release.installVersion('2.1.0'))
    const install = vi.fn<Install>(async (t) => {
      // the installer replaces the owned registration whichever way it moves
      release.register('claude', release.install())
      return ok(String(t))
    })
    bridge(install)
    db = freshDb()
    upsertActivity(db, { session: 'ahead', project: 'alpha', stream: 'main', agent: 'claude-code', doing: 'open', idle: true, claim: false, server_version: '2.1.0', server_source: 'runtime' })
    await bootApp(db, { viewer: { ...release.viewer, stamp: async () => null as never } })
    await settle()

    expect(lines()[0]).toBe('Claude Code: v2.1.0 runtime (Setup) — newer than this app\'s v2.0.0')
    expect(agentsText()).toContain('Claude Code runs a newer runtime than this app. Match agents to v2.0.0 moves it to this app\'s runtime. Running sessions keep their build until you restart them.')
    click(updateButton())
    await settle()

    expect(install.mock.calls).toEqual([['claude']])
    expect(lines()[0]).toBe('Claude Code: v2.0.0 runtime (Setup)')
    expect(updateButton()).toBeNull()
    const restart = document.querySelector('.agents-restart') as HTMLElement
    expect(restart.hidden).toBe(false)
    expect(restart.textContent).toBe(
      'Running sessions keep the build they started with until you restart them.'
      + 'Claude Code: 1 running session still runs a newer build. Restart it to load v2.0.0: exit it, then run claude --resume to pick the conversation back up.',
    )
    expect(restart.textContent).not.toMatch(/reloaded|reconnect/i)
    // and Live marks the session still on the newer build, without reopening anything
    await pollTick()
    const ahead = [...document.querySelectorAll('#liveDrawer .idle-row')]
      .find((el) => el.querySelector('.live-who')?.textContent?.includes('alpha'))
    expect(ahead?.querySelector('.live-build-hint')?.textContent).toBe('newer build (v2.1.0) — restart this session to load v2.0.0')
  })

  it('a failed update says so, re-reads the hosts, and gives no restart advice', async () => {
    const release = releaseRuntime('2.0.0')
    release.register('claude', release.installVersion('1.2.8'))
    const output = 'install-agents: could not install the packaged runtime; host configuration was not changed'
    bridge(vi.fn<Install>(async (t) => ({ ok: false, exitCode: 1, target: String(t), timedOut: false, output })))

    await boot(release)
    click(updateButton())
    await settle()

    const result = document.querySelector('.agents-result')
    expect(result?.textContent).toBe(output)
    expect(result?.classList.contains('failure')).toBe(true)
    expect(lines()[0]).toBe('Claude Code: v1.2.8 runtime (Setup) — older than this app\'s v2.0.0')
    expect((document.querySelector('.agents-restart') as HTMLElement).hidden).toBe(true)
    expect(updateButton()?.disabled).toBe(false)
  })

  // #206: Claude's Setup-managed hooks move with the agents, as one more fixed
  // target (`hooks`) run last, through the same bridge. Setup then re-reads
  // what each host runs and says what moved, and how running sessions pick it up.
  const hooksCommand = (): string | null => document.querySelector('.agents-hooks-command')?.textContent ?? null
  const restartText = (): string => {
    const restart = document.querySelector('.agents-restart') as HTMLElement
    return restart.hidden ? '' : restart.textContent ?? ''
  }
  const HOOKS_MOVED = 'Claude hooks: new Claude Code sessions run the v2.0.0 hooks. Claude Code normally applies changed hooks to running sessions too; to be sure one does, restart it: exit it, then run claude --resume.'

  it('moves Claude\'s Setup-runtime hooks with the agents as a step of their own, after Claude Code, and says what moved', async () => {
    const release = releaseRuntime('2.0.0')
    const old = release.installVersion('1.2.4')
    release.register('claude', old)
    release.registerHooks(old)
    const install = vi.fn<Install>(async (t) => {
      // what the installers do: `claude` installs the runtime and moves the
      // registration; `hooks` runs that runtime's install-hooks.sh
      if (t === 'claude') release.register('claude', release.install())
      if (t === 'hooks') release.registerHooks(release.install())
      return ok(String(t), t === 'hooks' ? 'agent-inbox hooks installed in ~/.claude/settings.json' : undefined)
    })
    bridge(install)

    await boot(release)
    expect(lines()[2]).toBe('Claude hooks: v1.2.4 runtime (Setup) — older than this app\'s v2.0.0')
    expect(agentsText()).toContain('Update agents moves Claude Code and Claude hooks to the v2.0.0 runtime. Running sessions keep their build until you restart them.')
    // the button moves them: no terminal command to copy, no "Setup does not move"
    expect(hooksCommand()).toBeNull()
    expect(agentsText()).not.toContain('Setup does not move Claude hooks')
    click(updateButton())
    await settle()

    expect(install.mock.calls).toEqual([['claude'], ['hooks']])
    const result = document.querySelector('.agents-result')
    expect(result?.textContent).toBe('Claude Code: claude: registered agent-inbox MCP\n\nClaude hooks: agent-inbox hooks installed in ~/.claude/settings.json')
    expect(result?.classList.contains('success')).toBe(true)
    // re-read: both moved, nothing left to offer
    expect(lines()).toEqual([
      'Claude Code: v2.0.0 runtime (Setup)',
      'Copilot CLI: not registered',
      'Claude hooks: v2.0.0 runtime (Setup)',
    ])
    expect(updateButton()).toBeNull()
    expect(restartText()).toBe(
      'Running sessions keep the build they started with until you restart them.'
      + 'Claude Code: no running sessions.'
      + HOOKS_MOVED,
    )
    expect(restartText()).not.toMatch(/reloaded|reconnect/i)
  })

  it('moves hooks alone once this app\'s runtime is installed, with no word about sessions keeping their build', async () => {
    const release = releaseRuntime('2.0.0')
    const installed = release.install()
    release.register('claude', installed)
    release.registerHooks(release.installVersion('2.1.0'))
    const install = vi.fn<Install>(async (t) => {
      release.registerHooks(installed)
      return ok(String(t), 'agent-inbox hooks installed in ~/.claude/settings.json')
    })
    bridge(install)

    await boot(release)
    expect(lines()[2]).toBe('Claude hooks: v2.1.0 runtime (Setup) — newer than this app\'s v2.0.0')
    expect(updateButton()?.textContent).toBe('Match agents to v2.0.0')
    expect(agentsText()).toContain('Claude hooks run a newer runtime than this app. Match agents to v2.0.0 moves them to this app\'s runtime.')
    expect(agentsText()).not.toContain('Running sessions keep their build')
    expect(hooksCommand()).toBeNull()
    click(updateButton())
    await settle()

    expect(install.mock.calls).toEqual([['hooks']])
    expect(document.querySelector('.agents-result')?.textContent).toBe('agent-inbox hooks installed in ~/.claude/settings.json')
    expect(lines()[2]).toBe('Claude hooks: v2.0.0 runtime (Setup)')
    expect(restartText()).toBe(HOOKS_MOVED)
  })

  it('never claims hooks moved when the re-read does not show them on this app\'s runtime', async () => {
    const release = releaseRuntime('2.0.0')
    const old = release.installVersion('1.2.4')
    release.register('claude', release.install())
    release.registerHooks(old)
    // the installer says it finished, but the settings file still names the old runtime
    bridge(vi.fn<Install>(async (t) => ok(String(t), 'agent-inbox hooks installed in ~/.claude/settings.json')))

    await boot(release)
    click(updateButton())
    await settle()

    expect(lines()[2]).toBe('Claude hooks: v1.2.4 runtime (Setup) — older than this app\'s v2.0.0')
    expect(document.querySelector('.agents-result')?.classList.contains('failure')).toBe(true)
    expect(restartText()).toBe('Claude hooks: the installer finished, but Setup does not see them on v2.0.0; the list above shows what it reads.')
    expect(updateButton()?.textContent).toBe('Update agents')
  })

  it('reports a hooks step that failed as it is, and keeps offering it', async () => {
    const release = releaseRuntime('2.0.0')
    release.register('claude', release.install())
    release.registerHooks(release.installVersion('1.2.4'))
    const output = 'install-hooks: another setup is already running'
    bridge(vi.fn<Install>(async (t) => ({ ok: false, exitCode: 1, target: String(t), timedOut: false, output })))

    await boot(release)
    click(updateButton())
    await settle()

    const result = document.querySelector('.agents-result')
    expect(result?.textContent).toBe(output)
    expect(result?.classList.contains('failure')).toBe(true)
    expect(lines()[2]).toBe('Claude hooks: v1.2.4 runtime (Setup) — older than this app\'s v2.0.0')
    expect(restartText()).toBe('')
    expect(updateButton()?.disabled).toBe(false)
  })

  it('does not start the hooks step after the Claude Code step was cancelled', async () => {
    const release = releaseRuntime('2.0.0')
    const old = release.installVersion('1.2.4')
    release.register('claude', old)
    release.registerHooks(old)
    const install = vi.fn<Install>(async () => ({ ok: false, exitCode: null, target: 'claude', timedOut: false, cancelled: true, output: 'Agent Inbox is quitting, so setup did not start.' }))
    bridge(install)

    await boot(release)
    click(updateButton())
    await settle()

    expect(install.mock.calls).toEqual([['claude']])
    expect(document.querySelector('.agents-result')?.textContent).toBe(
      'Claude Code: Agent Inbox is quitting, so setup did not start.\n\nClaude hooks: not started, because Setup stopped after Claude Code was cancelled.',
    )
    expect(lines()[2]).toBe('Claude hooks: v1.2.4 runtime (Setup) — older than this app\'s v2.0.0')
  })

  it.each([
    ['a source checkout', (r: ReleaseRuntime) => {
      // a checkout's installer bakes the user's own Node 24 beside its dist/hook-cli.js
      const entry = join(checkoutIn(r), 'dist', 'hook-cli.js')
      writeFileSync(entry, '')
      mkdirSync(join(r.home, '.claude'), { recursive: true })
      writeFileSync(join(r.home, '.claude', 'settings.json'), JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: process.execPath, args: [entry, 'stop'] }] }] },
      }))
    }, /^Claude hooks: source checkout at .* \(not managed by Setup\)$/],
    ['a runtime that no longer verifies', (r: ReleaseRuntime) => {
      const dir = r.installVersion('1.2.4')
      writeFileSync(join(dir, 'dist', 'hook-cli.js'), '// edited\n')
      r.registerHooks(dir)
    }, /^Claude hooks: could not be verified, so Setup leaves it unchanged$/],
  ] as const)('never moves hooks of %s: Update agents moves only Claude Code', async (_label, arrange, line) => {
    const release = releaseRuntime('2.0.0')
    release.register('claude', release.installVersion('1.2.8'))
    arrange(release)
    const install = vi.fn<Install>(async (t) => ok(String(t)))
    bridge(install)

    await boot(release)
    expect(lines()[2]).toMatch(line)
    expect(agentsText()).toContain('Update agents moves Claude Code to the v2.0.0 runtime.')
    click(updateButton())
    await settle()

    expect(install.mock.calls).toEqual([['claude']])
  })

  it('in a browser tab, says the app moves the hooks and before this app\'s runtime is installed offers no command', async () => {
    const release = releaseRuntime('2.0.0')
    const old = release.installVersion('1.2.4')
    release.register('claude', old)
    release.registerHooks(old)

    await boot(release)

    expect(lines()[2]).toBe('Claude hooks: v1.2.4 runtime (Setup) — older than this app\'s v2.0.0')
    expect(agentsText()).toContain('Open Settings in the Agent Inbox app to update Claude Code and Claude hooks to the v2.0.0 runtime.')
    expect(hooksCommand()).toBeNull()
    expect(updateButton()).toBeNull()
  })

  it('in a browser tab, also hands over the terminal command once this app\'s runtime is installed', async () => {
    const release = releaseRuntime('2.0.0')
    release.registerHooks(release.installVersion('1.2.4'))
    const installed = release.install()
    release.register('claude', installed)

    await boot(release)

    expect(agentsText()).toContain('Open Settings in the Agent Inbox app to update Claude hooks to the v2.0.0 runtime.')
    expect(agentsText()).toContain('Or move them from a terminal:')
    expect(hooksCommand()).toBe(`bash '${join(installed, 'scripts', 'install-hooks.sh')}' --apply`)
    expect(updateButton()).toBeNull()
  })

  it('promises nothing about hooks where this release cannot install its own runtime', async () => {
    const release = releaseRuntime('2.0.0', { hostPayload: false })
    release.registerHooks(release.installVersion('1.2.4'))
    bridge(vi.fn<Install>(async (t) => ok(String(t))))

    await boot(release)

    expect(lines()[2]).toBe('Claude hooks: v1.2.4 runtime (Setup) — older than this app\'s v2.0.0')
    expect(agentsText()).not.toMatch(/runtime is installed|move them|Open Settings/)
    expect(hooksCommand()).toBeNull()
    expect(updateButton()).toBeNull()
  })

  it('says Setup moves hooks once this app\'s runtime is installed, when no agent step would install it', async () => {
    const release = releaseRuntime('2.0.0')
    release.registerHooks(release.installVersion('1.2.4'))
    bridge(vi.fn<Install>(async (t) => ok(String(t))))

    await boot(release)

    expect(updateButton()).toBeNull()
    expect(agentsText()).toContain('Once this app\'s v2.0.0 runtime is installed, Setup can move Claude hooks to it.')
    expect(hooksCommand()).toBeNull()
  })
})
