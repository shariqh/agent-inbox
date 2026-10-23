// Issue #294, part B: what Setup's Runtimes block says about each runtime,
// read-only in the viewer (src/runtime-inventory.ts), and how cheaply.
//
// "Uses" must mean exactly what prune-runtimes.sh's gate means
// (scripts/runtime-config.mjs `unused`), or the panel would offer to remove a
// runtime the script keeps, or hide one it would remove. The agreement test
// runs that gate over the same scratch homes, for every shared case in
// test/runtime-uses.ts, and holds the two to one answer.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { openDb } from '../src/store.js'
import { measureRuntime, readRuntimes } from '../src/runtime-inventory.js'
import { createViewer } from '../src/viewer.js'
import type { RuntimeInventory, RuntimeMeasurer } from '../src/runtime-inventory.js'
import { hooksHome, installRuntime, installStaged, stageRuntime } from './hooks-runtime.js'
import { installRuntimeVersion, registerHost, releaseRuntime } from './release-runtime.js'
import type { HooksHome, StagedRuntime } from './hooks-runtime.js'
import { configFiles, hooksOf, launcher, notUses, UNREADABLE_CONFIGS, USE_SHAPES, writeJson } from './runtime-uses.js'
import { accentedRoot, RUNTIME_SPELLINGS } from './runtime-spellings.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

const CONFIG_CLI = resolve(import.meta.dirname, '..', 'scripts', 'runtime-config.mjs')

// Versions no other test file stages: the gate's process check matches ids.
const OLD = '1.2.2-r294'
const HOOKS = '1.2.4-r294'
const APP = '1.7.0-r294'

afterEach(removeScratchDirs)

function read(h: HooksHome, current: string | null = null, measure: RuntimeMeasurer = measureRuntime): RuntimeInventory {
  return readRuntimes({ home: h.home, runtimeRoot: h.runtimeRoot, current, measure })
}

/** What a runtime's own manifest records: every file's size, and the manifest itself. */
function recorded(runtime: StagedRuntime): number {
  const manifest = JSON.parse(readFileSync(join(runtime.dir, 'runtime-manifest.json'), 'utf8')) as { files: Array<{ size: number }> }
  return manifest.files.reduce((sum, file) => sum + file.size, 0)
}

// `why` is the first config that proves nothing and the reason, as the human reads it
type Answer = { state: 'unknown'; why: string } | { state: 'ok'; runtimes: Array<{ runtimeId: string; verdict: string; usedBy: string[] }> }

function viewerAnswer(h: HooksHome): Answer {
  const inventory = read(h)
  if (inventory.state === 'unknown') return { state: 'unknown', why: `${inventory.unreadable} ${inventory.reason}` }
  return { state: 'ok', runtimes: inventory.entries.map((e) => ({ runtimeId: e.runtimeId, verdict: e.status, usedBy: [...e.usedBy].sort() })) }
}

function scriptAnswer(h: HooksHome): Answer {
  const result = spawnSync(process.execPath, [CONFIG_CLI, 'unused', '--runtime-root', h.runtimeRoot, '--home', h.home], { encoding: 'utf8', env: h.env })
  expect(result.status, result.stderr).toBe(0)
  const out = JSON.parse(result.stdout) as { status: string; reason: string; runtimes: Array<{ runtimeId: string; verdict: string; usedBy: string[] }> }
  // the script names every config that proves nothing, by its full path
  if (out.status === 'unknown') return { state: 'unknown', why: out.reason.split('; ')[0]!.split(h.home).join('~') }
  return { state: 'ok', runtimes: out.runtimes.map((r) => ({ runtimeId: r.runtimeId, verdict: r.verdict, usedBy: [...r.usedBy].sort() })) }
}

describe('readRuntimes (#294)', () => {
  it('names each runtime folder: this app\'s, used and by what, unused, changed, or no runtime', () => {
    const h = hooksHome()
    const app = installStaged(h, stageRuntime(join(scratchDir('runtimes-app-'), 'payload'), APP))
    const old = installRuntime(h, OLD)
    const hooks = installRuntime(h, HOOKS)
    writeJson(configFiles(h.home).settings, hooksOf(hooks.dir))
    const changed = installRuntime(h, '1.1.0-r294')
    writeFileSync(join(changed.dir, '.DS_Store'), 'finder\n')
    mkdirSync(join(h.runtimeRoot, 'notes'))
    // never followed, never a runtime: a link to one outside the root, and trash
    const outside = stageRuntime(join(scratchDir('runtimes-outside-'), 'payload'), '1.0.0-r294')
    symlinkSync(outside.dir, join(h.runtimeRoot, outside.runtimeId))
    mkdirSync(join(h.runtimeRoot, `.trash-${old.runtimeId}-AbCdEf`, old.runtimeId), { recursive: true })

    const inventory = read(h, app.runtimeId)

    const entry = (runtime: StagedRuntime, status: string, usedBy: string[] = []) =>
      ({ runtimeId: runtime.runtimeId, version: runtime.version, bytes: recorded(runtime), status, usedBy })
    expect(inventory).toEqual({
      state: 'ok',
      entries: [
        entry(changed, 'changed'),
        entry(old, 'unused'),
        entry(hooks, 'used', ['Claude Code settings']),
        entry(app, 'current'),
        { runtimeId: 'notes', version: null, bytes: null, status: 'not-a-runtime', usedBy: [] },
      ].sort((a, b) => (a.runtimeId < b.runtimeId ? -1 : 1)),
    })
  })

  it('says nothing about a runtime root that is not there', () => {
    expect(read(hooksHome())).toEqual({ state: 'ok', entries: [] })
  })

  it.each(UNREADABLE_CONFIGS)('offers nothing when a host config %s, and names it', (_label, arrange) => {
    const h = hooksHome()
    const app = installStaged(h, stageRuntime(join(scratchDir('runtimes-app-'), 'payload'), APP))
    const old = installRuntime(h, OLD)
    const culprit = arrange(h.home)

    const inventory = read(h, app.runtimeId)

    expect(inventory.state).toBe('unknown')
    // the config itself, or (for a folder above it that went missing) one inside that folder
    expect(inventory.unreadable?.startsWith(`~${culprit.slice(h.home.length)}`)).toBe(true)
    expect(inventory.entries.map((e) => [e.runtimeId, e.status])).toEqual([[old.runtimeId, 'unchecked'], [app.runtimeId, 'current']].sort())
  })

  it('keeps nothing from a host config but which runtimes it uses', () => {
    const h = hooksHome()
    const old = installRuntime(h, OLD)
    writeJson(configFiles(h.home).claude, {
      mcpServers: {
        inbox: launcher(old.dir),
        other: { command: '/opt/secret-tool/bin/run', args: ['--token', 'sk-live-hunter2'], env: { API_KEY: 'sk-live-hunter2' } },
      },
    })

    const text = JSON.stringify(read(h))

    expect(text).toContain('"usedBy":["Claude Code"]')
    for (const secret of ['sk-live-hunter2', 'secret-tool', 'API_KEY', 'mcp-server.js', 'bin/node']) expect(text).not.toContain(secret)
  })
})

describe('measureRuntime (#294)', () => {
  it('takes a runtime\'s size from its manifest and checks the folder still matches it', () => {
    const h = hooksHome()
    const old = installRuntime(h, OLD)
    expect(measureRuntime(old.dir, old.runtimeId)).toEqual({ version: OLD, bytes: recorded(old), intact: true })
    // without the walk: what the manifest says, and nothing about the folder
    writeFileSync(join(old.dir, '.DS_Store'), 'finder\n')
    expect(measureRuntime(old.dir, old.runtimeId, false)).toEqual({ version: OLD, bytes: recorded(old), intact: null })
    expect(measureRuntime(old.dir, 'agent-inbox-runtime-another-id')).toBeNull()
  })

  it.each([
    ['carries an extra file', (dir: string) => writeFileSync(join(dir, 'dist', 'extra.js'), '1\n')],
    ['lost a file', (dir: string) => unlinkSync(join(dir, 'dist', 'watch-cli.js'))],
    ['has a file of another size', (dir: string) => writeFileSync(join(dir, 'dist', 'hook-cli.js'), '// longer than it was when it was manifested\n')],
    ['has a file of another mode', (dir: string) => chmodSync(join(dir, 'dist', 'mcp-server.js'), 0o600)],
    ['holds a symlink', (dir: string) => symlinkSync('/etc/hosts', join(dir, 'dist', 'hosts'))],
  ])('calls a folder that %s changed', (_label, change) => {
    const h = hooksHome()
    const old = installRuntime(h, OLD)
    change(old.dir)
    expect(measureRuntime(old.dir, old.runtimeId)).toMatchObject({ version: OLD, bytes: recorded(old), intact: false })
  })

  it.each([
    ['no manifest', (dir: string) => rmSync(join(dir, 'runtime-manifest.json'))],
    ['a manifest that is not JSON', (dir: string) => writeFileSync(join(dir, 'runtime-manifest.json'), '{')],
    ['a manifest that is a symlink', (dir: string) => {
      const real = join(dir, '..', 'elsewhere.json')
      writeFileSync(real, readFileSync(join(dir, 'runtime-manifest.json')))
      rmSync(join(dir, 'runtime-manifest.json'))
      symlinkSync(real, join(dir, 'runtime-manifest.json'))
    }],
    ['another product\'s manifest', (dir: string) => {
      const manifest = JSON.parse(readFileSync(join(dir, 'runtime-manifest.json'), 'utf8')) as Record<string, unknown>
      writeFileSync(join(dir, 'runtime-manifest.json'), JSON.stringify({ ...manifest, product: 'something-else' }))
    }],
  ])('is no runtime with %s', (_label, change) => {
    const h = hooksHome()
    const old = installRuntime(h, OLD)
    change(old.dir)
    expect(measureRuntime(old.dir, old.runtimeId)).toBeNull()
  })
})

// The viewer and prune-runtimes.sh's own gate, over the same files.
describe('readRuntimes agrees with the prune gate (#294)', () => {
  function agree(h: HooksHome): void {
    const viewer = viewerAnswer(h)
    expect(viewer).toEqual(scriptAnswer(h))
  }

  it.each(USE_SHAPES)('%s', (_label, shape) => {
    const h = hooksHome()
    const old = installRuntime(h, OLD)
    installRuntime(h, HOOKS)
    const { file, value } = shape(old.dir, h.home)
    writeJson(file, value)
    agree(h)
    expect(viewerAnswer(h)).toMatchObject({ state: 'ok', runtimes: expect.arrayContaining([expect.objectContaining({ runtimeId: old.runtimeId, verdict: 'used' })]) })
  })

  it('a path to nothing, a config key or a longer name', () => {
    const h = hooksHome()
    const old = installRuntime(h, OLD)
    for (const { file, value } of notUses(old.dir, h.home)) writeJson(file, value)
    agree(h)
    expect(viewerAnswer(h)).toEqual({ state: 'ok', runtimes: [{ runtimeId: old.runtimeId, verdict: 'unused', usedBy: [] }] })
  })

  // folders compared by (dev, ino): a path naming the id, then a shortcut that does not
  for (const [label, spell, here] of RUNTIME_SPELLINGS) {
    it.skipIf(!here)(`a launcher that reaches a runtime through ${label}`, () => {
      const plain = hooksHome()
      const h = { ...plain, runtimeRoot: accentedRoot(plain.home) }
      const old = installRuntime(h, OLD)
      writeJson(configFiles(h.home).claude, { mcpServers: { inbox: { command: spell(join(old.dir, 'bin', 'node')), args: [spell(join(old.dir, 'dist', 'mcp-server.js'))] } } })
      agree(h)
      expect(viewerAnswer(h)).toMatchObject({ state: 'ok', runtimes: [{ verdict: 'used' }] })

      symlinkSync(spell(join(old.dir, 'bin', 'node')), join(h.home, 'inbox-node'))
      writeJson(configFiles(h.home).claude, { mcpServers: { inbox: { command: join(h.home, 'inbox-node'), args: ['/opt/x/server.js'] } } })
      agree(h)
      expect(viewerAnswer(h)).toMatchObject({ state: 'ok', runtimes: [{ verdict: 'used' }] })
    })
  }

  // errors only ever keep
  it.skipIf(process.getuid?.() === 0)('a path naming the runtime that stat cannot follow (EACCES)', () => {
    const h = hooksHome()
    const old = installRuntime(h, OLD)
    const locked = join(h.home, 'locked')
    mkdirSync(join(locked, old.runtimeId, 'bin'), { recursive: true })
    writeJson(configFiles(h.home).claude, { mcpServers: { inbox: { command: join(locked, old.runtimeId, 'bin', 'node') } } })
    chmodSync(locked, 0o000)
    try {
      agree(h)
      expect(viewerAnswer(h)).toMatchObject({ state: 'ok', runtimes: [{ verdict: 'used' }] })
    } finally {
      chmodSync(locked, 0o755)
    }
  })

  it.skipIf(process.getuid?.() === 0)('a launcher path stat cannot follow inside the runtime root', () => {
    const h = hooksHome()
    const old = installRuntime(h, OLD)
    installRuntime(h, HOOKS)
    const locked = join(h.runtimeRoot, '.locked')
    mkdirSync(locked)
    symlinkSync(join(old.dir, 'bin', 'node'), join(locked, 'inbox-node'))
    writeJson(configFiles(h.home).copilot, { mcpServers: { inbox: { command: join(locked, 'inbox-node') } } })
    chmodSync(locked, 0o000)
    try {
      agree(h)
      expect(viewerAnswer(h)).toMatchObject({ state: 'ok', runtimes: [{ verdict: 'used' }, { verdict: 'used' }] })
    } finally {
      chmodSync(locked, 0o755)
    }
  })

  it.each(UNREADABLE_CONFIGS)('a host config that %s', (_label, arrange, why) => {
    const h = hooksHome()
    installRuntime(h, OLD)
    const culprit = arrange(h.home)
    agree(h)
    expect(viewerAnswer(h)).toEqual({ state: 'unknown', why: expect.stringContaining(why) })
    expect(JSON.stringify(read(h))).toContain(culprit.split(h.home).join('~'))
    expect(JSON.stringify(read(h))).not.toContain('s3cret')
  })

  it('no host config at all, and a folder that is no runtime', () => {
    const h = hooksHome()
    installRuntime(h, OLD)
    mkdirSync(join(h.runtimeRoot, 'notes'))
    agree(h)
  })

  // what Finder does to a folder it opens: both leave it, and say so
  it('a runtime that changed since Setup installed it', () => {
    const h = hooksHome()
    const old = installRuntime(h, OLD)
    writeFileSync(join(old.dir, '.DS_Store'), 'finder\n')
    agree(h)
    expect(viewerAnswer(h)).toEqual({ state: 'ok', runtimes: [{ runtimeId: old.runtimeId, verdict: 'changed', usedBy: [] }] })
  })
})

// /api/setup carries the inventory to the Setup panel. Electron serves the
// viewer from its main process, so a read with nothing changed reads stamps
// alone, and a folder is walked again only when its own stamps moved.
describe('/api/setup runtimes (#294)', () => {
  type Runtimes = { state: string; removable: boolean; entries: Array<{ runtimeId: string; status: string; bytes: number | null; usedBy: string[] }> }
  const db = () => openDb(join(scratchDir('runtimes-db-'), 'inbox.db'))
  const read = async (app: { request(path: string): Response | Promise<Response> }): Promise<Runtimes> =>
    ((await (await app.request('/api/setup')).json()) as { runtimes: Runtimes }).runtimes
  const bytesOf = (dir: string): number =>
    (JSON.parse(readFileSync(join(dir, 'runtime-manifest.json'), 'utf8')) as { files: Array<{ size: number }> }).files.reduce((sum, f) => sum + f.size, 0)
  const idOf = (dir: string): string => dir.slice(dir.lastIndexOf('/') + 1)

  it('lists each runtime with its size and what uses it, and offers the prune where the release payload carries it', async () => {
    const release = releaseRuntime('2.0.0')
    const current = release.install()
    const old = release.installVersion('1.2.2')
    const hooks = release.installVersion('1.2.4')
    release.registerHooks(hooks)

    expect(await read(createViewer(db(), release.viewer))).toEqual({
      state: 'ok',
      removable: true,
      entries: [
        { runtimeId: idOf(old), version: '1.2.2', bytes: bytesOf(old), status: 'unused', usedBy: [] },
        { runtimeId: idOf(hooks), version: '1.2.4', bytes: bytesOf(hooks), status: 'used', usedBy: ['Claude Code settings'] },
        { runtimeId: idOf(current), version: '2.0.0', bytes: bytesOf(current), status: 'current', usedBy: [] },
      ],
    })
  })

  it('offers no prune in a checkout\'s viewer, or where the release payload carries no prune script', async () => {
    const release = releaseRuntime('2.0.0')
    release.installVersion('1.2.2')
    const checkout = createViewer(db(), { ...release.viewer, setupInfoPath: join(release.home, 'no-setup-info.json') })
    expect(await read(checkout)).toMatchObject({ state: 'ok', removable: false, entries: [{ status: 'unused' }] })

    const older = releaseRuntime('2.0.0', { pruneScript: false })
    older.installVersion('1.2.2')
    expect(await read(createViewer(db(), older.viewer))).toMatchObject({ state: 'ok', removable: false, entries: [{ status: 'unused' }] })
  })

  it('walks only an unused runtime, once while its stamps hold, re-reads uses when a host config changes, and walks again only a folder that changed', async () => {
    const release = releaseRuntime('2.0.0')
    const current = release.install()
    const old = release.installVersion('1.2.2')
    const hooks = release.installVersion('1.2.4')
    release.registerHooks(hooks)
    const measured: string[] = []
    const app = createViewer(db(), {
      ...release.viewer,
      runtimeMeasurer: (dir, runtimeId, walk) => {
        measured.push(`${walk ? 'walk' : 'read'} ${runtimeId}`)
        return measureRuntime(dir, runtimeId, walk)
      },
    })

    const cold = await read(app)
    // every manifest is read; only the unused runtime is walked: this app's and the hooks' are kept anyway
    expect(measured.sort()).toEqual([`read ${idOf(current)}`, `read ${idOf(hooks)}`, `read ${idOf(old)}`, `walk ${idOf(old)}`].sort())
    expect(cold.entries.find((e) => e.runtimeId === idOf(old))?.status).toBe('unused')

    measured.length = 0
    expect(await read(app)).toEqual(cold)
    expect(measured).toEqual([])

    // a host config changed: its uses are read again, no folder is
    registerHost(release.home, 'claude', join(old, 'bin', 'node'), join(old, 'dist', 'mcp-server.js'))
    expect((await read(app)).entries.find((e) => e.runtimeId === idOf(old))).toMatchObject({ status: 'used', usedBy: ['Claude Code'] })
    expect(measured).toEqual([])

    // a folder changed: only that one is read and walked again
    writeJson(configFiles(release.home).claude, {})
    writeFileSync(join(old, '.DS_Store'), 'finder\n')
    expect((await read(app)).entries.find((e) => e.runtimeId === idOf(old))).toMatchObject({ status: 'changed' })
    expect(measured).toEqual([`read ${idOf(old)}`, `walk ${idOf(old)}`])
  })

  it('sees a change deep inside a runtime, which moves none of its stamps, once the backstop passes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const release = releaseRuntime('2.0.0')
      const old = release.installVersion('1.2.2')
      const app = createViewer(db(), release.viewer)
      expect((await read(app)).entries).toMatchObject([{ runtimeId: idOf(old), status: 'unused' }])

      chmodSync(join(old, 'bin', 'node'), 0o700)
      vi.setSystemTime(Date.now() + 10 * 60_000 - 1)
      expect((await read(app)).entries).toMatchObject([{ status: 'unused' }])
      vi.setSystemTime(Date.now() + 2)
      expect((await read(app)).entries).toMatchObject([{ status: 'changed' }])
    } finally {
      vi.useRealTimers()
    }
  })

  // Setup's installers and prune work in AGENT_INBOX_RUNTIME_ROOT when it is
  // absolute (electron/setup-runner.cjs setupRuntimeRoot), so the list does too.
  it('lists the runtime root Setup uses: an absolute AGENT_INBOX_RUNTIME_ROOT, else the default', async () => {
    const home = scratchDir('runtimes-env-home-')
    const configured = join(scratchDir('runtimes-env-root-'), 'runtimes')
    const inConfigured = idOf(installRuntimeVersion(configured, '1.2.2'))
    const inDefault = idOf(installRuntimeVersion(join(home, '.agent-inbox', 'runtime'), '1.2.4'))
    const viewer = () => createViewer(db(), { setupInfoPath: join(home, 'no-setup-info.json'), agentHome: home })
    try {
      vi.stubEnv('HOME', home)
      vi.stubEnv('AGENT_INBOX_RUNTIME_ROOT', configured)
      expect((await read(viewer())).entries.map((e) => e.runtimeId)).toEqual([inConfigured])

      vi.stubEnv('AGENT_INBOX_RUNTIME_ROOT', 'relative/runtimes')
      expect((await read(viewer())).entries.map((e) => e.runtimeId)).toEqual([inDefault])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('names a host config it cannot read, and offers nothing', async () => {
    const release = releaseRuntime('2.0.0')
    release.installVersion('1.2.2')
    writeJson(configFiles(release.home).claude, {})
    writeFileSync(configFiles(release.home).claude, '{"mcpServers":')

    expect(await read(createViewer(db(), release.viewer))).toMatchObject({
      state: 'unknown',
      unreadable: '~/.claude.json',
      reason: 'is not valid JSON',
      removable: true,
      entries: [{ status: 'unchecked' }],
    })
  })
})

describe('the Runtimes block adds no execution surface (#294)', () => {
  it('reads in the viewer with node:fs and node:path alone, and no HTTP route writes or runs anything', () => {
    const read = (...parts: string[]) => readFileSync(join(import.meta.dirname, '..', ...parts), 'utf8')
    const inventory = read('src', 'runtime-inventory.ts')
    const viewer = read('src', 'viewer.ts')
    const app = read('public', 'app.js')

    expect([...inventory.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])).toEqual(['node:fs', 'node:path'])
    expect(viewer).not.toMatch(/app\.(post|put|patch|delete)\('\/api\/[^']*runtime/)
    // the panel names the fixed target and nothing else
    expect([...app.matchAll(/agentInboxSetup\.install\(([^)]*)\)/g)].map((m) => m[1])).toContain("'prune-runtimes'")
    expect(app).not.toMatch(/install\('prune-runtimes',/)
  })
})
