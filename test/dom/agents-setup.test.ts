// @vitest-environment jsdom
// test/dom/agents-setup.test.ts
//
// Issue #197, part 2, through the real viewer over a real DB and real host
// config files in a scratch home: Setup says which build each host's agents
// are registered to run and offers ONE explicit "Update agents" for exactly the
// Setup-managed hosts that run an older runtime than this app's. It runs the
// existing fixed-target install through the existing Electron bridge — no new
// command — and never switches a checkout or custom registration. Afterwards
// it re-reads every host, refreshes Live, and says which running sessions still
// need a restart and how; it never claims a running session reloaded.
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

type InstallResult = { ok: boolean; exitCode: number | null; target: string; timedOut: boolean; output: string }
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

  it.each([
    ['both hosts on an older runtime', 'all', (r: ReleaseRuntime) => {
      const old = r.installVersion('1.2.8')
      r.register('claude', old)
      r.register('copilot', old)
    }],
    ['only Claude Code behind', 'claude', (r: ReleaseRuntime) => {
      r.register('claude', r.installVersion('1.2.8'))
      r.register('copilot', r.install())
    }],
    ['Copilot CLI behind, Claude Code on a checkout it must not switch', 'copilot', (r: ReleaseRuntime) => {
      registerHost(r.home, 'claude', process.execPath, join(checkoutIn(r), 'dist', 'mcp-server.js'))
      r.register('copilot', r.installVersion('1.1.0'))
    }],
  ])('offers one Update agents for exactly the Setup-managed hosts that are older: %s', async (_label, target, arrange) => {
    const release = releaseRuntime('2.0.0')
    arrange(release)
    const install = vi.fn<Install>(async (t) => ok(String(t)))
    bridge(install)

    await boot(release)
    const run = updateButton()
    expect(run?.textContent).toBe('Update agents')
    run!.click()
    await settle()

    // the existing fixed-target bridge, one call, one fixed target, nothing else
    expect(install).toHaveBeenCalledTimes(1)
    expect(install.mock.calls[0]).toEqual([target])
  })

  it('offers no Update agents when nothing Setup manages is behind', async () => {
    const release = releaseRuntime('2.0.0')
    const dir = release.install()
    release.register('claude', dir)
    release.register('copilot', dir)
    const install = vi.fn<Install>(async (t) => ok(String(t)))
    bridge(install)

    await boot(release)

    expect(updateButton()).toBeNull()
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

  it('says Update agents does not move Claude\'s hooks, and that the command which does comes once the runtime is installed', async () => {
    const release = releaseRuntime('2.0.0')
    const old = release.installVersion('1.2.4')
    release.register('claude', old)
    release.registerHooks(old)

    await boot(release)

    expect(lines()[2]).toBe('Claude hooks: v1.2.4 runtime (Setup) — older than this app\'s v2.0.0')
    expect(agentsText()).toContain('Update agents does not move Claude hooks. Once the v2.0.0 runtime is installed, the command that moves them appears here.')
    expect(document.querySelector('.agents-hooks-command')).toBeNull()
  })

  it('hands over the terminal command that moves Claude\'s hooks onto the installed runtime', async () => {
    const release = releaseRuntime('2.0.0')
    const old = release.installVersion('1.2.4')
    release.registerHooks(old)
    const installed = release.install()
    release.register('claude', installed)

    await boot(release)

    expect(agentsText()).toContain('Update agents does not move Claude hooks. To move them to v2.0.0, run this in a terminal:')
    expect(document.querySelector('.agents-hooks-command')?.textContent)
      .toBe(`bash '${join(installed, 'scripts', 'install-hooks.sh')}' --apply`)
    expect(updateButton()).toBeNull()
  })
})
