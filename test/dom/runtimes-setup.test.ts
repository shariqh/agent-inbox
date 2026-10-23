// @vitest-environment jsdom
// test/dom/runtimes-setup.test.ts
//
// Issue #294, part B, through the real viewer over a real DB and real runtime
// folders and host configs in a scratch home: Settings lists each runtime
// Setup installed, its size and what uses it, and offers ONE explicit action
// that removes the unused ones through the existing Electron bridge's fixed
// `prune-runtimes` target, naming nothing else. Just before it runs, it reads
// the list again and runs only if the button still names what it would remove.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { upsertActivity } from '../../src/store.js'
import { registerHost, releaseRuntime } from '../release-runtime.js'
import type { ReleaseRuntime } from '../release-runtime.js'
import { runtimesAction } from '../../public/runtimes.js'
import { bootApp, click, freshDb, pollTick, settle, useDomTest } from './harness.js'

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

const lines = (): string[] => [...document.querySelectorAll('.runtimes-list li')].map((li) => li.textContent ?? '')
const removeButton = (): HTMLButtonElement | null => document.querySelector('.runtimes-remove-btn')
const blockText = (): string => document.querySelector('.runtimes-status')?.textContent ?? ''
const result = (): string => document.querySelector('.runtimes-result')?.textContent ?? ''
const idOf = (dir: string): string => dir.slice(dir.lastIndexOf('/') + 1)
const done = (output: string): InstallResult => ({ ok: true, exitCode: 0, target: 'prune-runtimes', timedOut: false, output })

/** A release 2.0.0 app with its own runtime installed, an unused 1.2.2 runtime and Claude's hooks on 1.2.4. */
function ownersMac(): { release: ReleaseRuntime; old: string; hooks: string; current: string } {
  const release = releaseRuntime('2.0.0')
  const current = release.install()
  const old = release.installVersion('1.2.2')
  const hooks = release.installVersion('1.2.4')
  release.registerHooks(hooks)
  return { release, old, hooks, current }
}

describe('Setup lists the runtimes and removes the unused ones (#294)', () => {
  it('names each runtime, what uses it and its size, and what Remove removes', async () => {
    const { release } = ownersMac()
    bridge(vi.fn<Install>())

    await boot(release)

    expect(lines()).toEqual([
      expect.stringMatching(/^v1\.2\.2: not used · \d+ KB$/),
      expect.stringMatching(/^v1\.2\.4: used by Claude Code settings · \d+ KB$/),
      expect.stringMatching(/^v2\.0\.0: this app's runtime · \d+ KB$/),
    ])
    expect(removeButton()?.textContent).toMatch(/^Remove the v1\.2\.2 runtime \(\d+ KB\)$/)
    expect(blockText()).toContain('Removes the v1.2.2 runtime. Setup checks again first and keeps any runtime that an agent, a hook or a running session still uses.')
    expect(blockText()).toContain("Setup does not read a project's own settings (.mcp.json or .claude/settings.json). A session started from one keeps its runtime while it runs.")
  })

  it('removes them through the fixed prune-runtimes target and nothing else, then shows what is left', async () => {
    const { release, old } = ownersMac()
    const install = vi.fn<Install>(async () => {
      rmSync(old, { recursive: true })
      return done(`Removed v1.2.2 (${idOf(old)}).\nRemoved 1 runtime.`)
    })
    bridge(install)
    await boot(release)

    removeButton()!.click()
    await settle()

    // one fixed target, never an id, a path or a list
    expect(install.mock.calls).toEqual([['prune-runtimes']])
    expect(result()).toBe(`Removed v1.2.2 (${idOf(old)}).\nRemoved 1 runtime.`)
    expect(document.querySelector('.runtimes-result')?.classList.contains('success')).toBe(true)
    expect(lines()).toHaveLength(2)
    expect(lines().some((line) => line.startsWith('v1.2.2'))).toBe(false)
    expect(removeButton()).toBeNull()
  })

  it('leaves a runtime that changed since Setup installed it out of what Remove removes', async () => {
    const { release } = ownersMac()
    const changed = release.installVersion('1.2.3')
    writeFileSync(join(changed, '.DS_Store'), 'finder\n')
    bridge(vi.fn<Install>())

    await boot(release)

    expect(lines()[1]).toMatch(/^v1\.2\.3: changed since Setup installed it, so Setup leaves it · \d+ KB$/)
    expect(removeButton()?.textContent).toMatch(/^Remove the v1\.2\.2 runtime \(\d+ KB\)$/)
  })

  it('names how many it removes when there are several', async () => {
    const release = releaseRuntime('2.0.0')
    release.installVersion('1.2.2')
    release.installVersion('1.2.4')
    bridge(vi.fn<Install>())

    await boot(release)

    expect(removeButton()?.textContent).toMatch(/^Remove 2 unused runtimes \(\d+ KB\)$/)
    expect(blockText()).toContain('Removes the v1.2.2 and v1.2.4 runtimes.')
  })

  it('runs nothing when the list changed since it was drawn, and shows the new one', async () => {
    const { release, old } = ownersMac()
    const install = vi.fn<Install>()
    bridge(install)
    await boot(release)

    // an agent registered to the runtime the button names, after it was drawn
    registerHost(release.home, 'claude', join(old, 'bin', 'node'), join(old, 'dist', 'mcp-server.js'))
    removeButton()!.click()
    await settle()

    expect(install).not.toHaveBeenCalled()
    expect(result()).toBe('The runtimes changed since Setup listed them, so it removed nothing. Check the list and try again.')
    expect(lines()[0]).toMatch(/^v1\.2\.2: used by Claude Code · \d+ KB$/)
    expect(removeButton()).toBeNull()
  })

  // the button names a set of runtimes, and runs only while that is still the set
  it.each([
    ['one of the two it names is used now', (release: ReleaseRuntime) => {
      release.installVersion('1.2.2')
      const other = release.installVersion('1.2.4')
      return () => registerHost(release.home, 'claude', join(other, 'bin', 'node'), join(other, 'dist', 'mcp-server.js'))
    }],
    ['another runtime is the unused one now', (release: ReleaseRuntime) => {
      const old = release.installVersion('1.2.2')
      release.registerHooks(release.installVersion('1.2.4'))
      return () => release.registerHooks(old)
    }],
  ])('runs nothing when %s', async (_label, arrange) => {
    const release = releaseRuntime('2.0.0')
    release.install()
    const change = arrange(release)
    const install = vi.fn<Install>()
    bridge(install)
    await boot(release)
    expect(removeButton()).not.toBeNull()

    change()
    removeButton()!.click()
    await settle()

    expect(install).not.toHaveBeenCalled()
    expect(result()).toBe('The runtimes changed since Setup listed them, so it removed nothing. Check the list and try again.')
  })

  it('reports a prune that failed as it is, and keeps offering it', async () => {
    const { release, old } = ownersMac()
    bridge(vi.fn<Install>(async () => ({ ok: false, exitCode: 1, target: 'prune-runtimes', timedOut: false, output: `Could not remove v1.2.2 (${idOf(old)}): unexpected file .DS_Store` })))
    await boot(release)

    removeButton()!.click()
    await settle()

    expect(result()).toContain('Could not remove v1.2.2')
    expect(document.querySelector('.runtimes-result')?.classList.contains('failure')).toBe(true)
    expect(removeButton()?.disabled).toBe(false)
  })

  it.each([
    ['in a browser tab', () => {}],
    ['in an app window Setup is not granted to', () => bridge(vi.fn<Install>(), false)],
  ])('offers no Remove %s, and says where to remove them', async (_label, arrange) => {
    const { release } = ownersMac()
    arrange()

    await boot(release)

    expect(removeButton()).toBeNull()
    expect(blockText()).toContain('Open Settings in the Agent Inbox app to remove them.')
  })

  it('offers nothing when a host config cannot be read, and names it', async () => {
    const { release } = ownersMac()
    writeFileSync(join(release.home, '.claude.json'), '{"mcpServers":')
    bridge(vi.fn<Install>())

    await boot(release)

    expect(removeButton()).toBeNull()
    expect(blockText()).toContain("Setup can't tell which runtimes are in use, so it offers to remove none. ~/.claude.json is not valid JSON.")
    expect(lines()[0]).toMatch(/^v1\.2\.2 · \d+ KB$/)
  })

  it('offers no Remove where this release cannot run the prune, and points at the terminal', async () => {
    const release = releaseRuntime('2.0.0', { pruneScript: false })
    release.installVersion('1.2.2')
    bridge(vi.fn<Install>())

    await boot(release)

    expect(removeButton()).toBeNull()
    expect(blockText()).toContain("From a terminal, a runtime's own scripts/prune-runtimes.sh --apply does the same")
  })

  it('says when running sessions report the version of a runtime nothing else uses', async () => {
    const { release } = ownersMac()
    bridge(vi.fn<Install>())
    const database = await boot(release)
    upsertActivity(database, { session: 's1', project: 'alpha', stream: 'main', agent: 'copilot', doing: 'open', idle: true, claim: false, server_version: '1.2.2', server_source: 'runtime' })
    await pollTick()
    // opening Settings reads the list again, with Live's sessions in hand
    click(document.getElementById('gear'))
    await settle()

    expect(lines()[0]).toMatch(/^v1\.2\.2: not used · \d+ KB · 1 running session reports v1\.2\.2, which keeps it while it runs$/)
  })

  // #216: main proves a reloaded window again, which can finish after Setup was built.
  it('offers Remove the next time Settings opens once main allows this window', async () => {
    const { release } = ownersMac()
    let allowed = false
    const install = vi.fn<Install>(async () => done('Nothing to remove.'))
    Object.defineProperty(window, 'agentInboxSetup', { configurable: true, value: { available: async () => allowed, install } })
    await boot(release)
    expect(removeButton()).toBeNull()

    allowed = true
    click(document.getElementById('gear'))
    await settle()
    removeButton()!.click()
    await settle()

    expect(install.mock.calls).toEqual([['prune-runtimes']])
  })

  it('re-reads the runtimes whenever Settings opens, so a removal from a terminal shows up', async () => {
    const { release, old } = ownersMac()
    bridge(vi.fn<Install>())
    await boot(release)
    expect(lines()).toHaveLength(3)

    rmSync(old, { recursive: true })
    click(document.getElementById('gear'))
    await settle()

    expect(lines()).toHaveLength(2)
    expect(removeButton()).toBeNull()
  })

  it('shows no block where Setup installed no runtime', async () => {
    const release = releaseRuntime('2.0.0')
    bridge(vi.fn<Install>())

    await boot(release)

    expect(document.querySelector<HTMLElement>('.runtimes-status')?.hidden).toBe(true)
  })
})

describe('runtimesAction (#294)', () => {
  it('offers nothing unless the viewer could tell what uses each runtime, whatever the entries say', () => {
    const entries = [{ runtimeId: 'a', version: '1.2.2', bytes: 1000, status: 'unused', usedBy: [] }]
    expect(runtimesAction({ state: 'ok', removable: true, entries })?.ids).toEqual(['a'])
    expect(runtimesAction({ state: 'unknown', removable: true, entries })).toBeNull()
  })
})
