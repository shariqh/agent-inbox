// Issue #412 step 3, PR 2: Electron main's control of driven sessions, tested
// without Electron (everything is injected): the switch's file, the
// safeStorage-held key and the approval MAC, the login-shell env capture, the
// driver's exact start, the controller (what the renderer may send, the native
// confirmation, the §9 off contract, the launch gate), the IPC and its grants,
// the window binding's `launch` grant, the preload bridge and main's wiring.
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import sessionLaunch from '../electron/session-launch.cjs'
import launchKeys from '../electron/launch-key.cjs'
import shellEnv from '../electron/shell-env.cjs'
import driverProcess from '../electron/driver-process.cjs'
import controllerModule from '../electron/launch-controller.cjs'
import launchIpc from '../electron/launch-ipc.cjs'
import sessionWorktree from '../electron/session-worktree.cjs'
import { terminalSafe } from '../src/driver-policy.js'
import { verifyApproval } from '../src/launch-sign.js'
import { parseLaunchSpec } from '../src/launch-spec.js'
import { launchKey as fixtureLaunchKey, sign as fixtureSign } from './launch-fixtures.js'
import { stageRuntime } from './hooks-runtime.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

const REPO = join(import.meta.dirname, '..')
type Binding = { navigationStarted(url: string): void; navigationCommitted(url: string): Promise<boolean>; refresh(): void }
const setupRunner = createRequire(import.meta.url)('../electron/setup-runner.cjs') as {
  createInstallBinding(options: Json): Binding
  installedDriverRuntime(options: Json): { node?: string; entry?: string; error?: string }
  driverRuntime(options: Json): { node?: string; entry?: string; error?: string }
}
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8')
const ID = '22222222-3333-4444-8555-666666666666'
type Json = Record<string, unknown>

afterEach(() => {
  removeScratchDirs()
  vi.restoreAllMocks()
})

// a stand-in for Electron's safeStorage: reversible, and never the plain text
function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (text: string) => Buffer.from(`enc:${Buffer.from(text).reverse().toString('base64')}`),
    decryptString: (bytes: Buffer) => {
      const text = bytes.toString()
      if (!text.startsWith('enc:')) throw new Error('not ours')
      return Buffer.from(text.slice(4), 'base64').reverse().toString()
    },
  }
}

describe('the switch’s file (§9)', () => {
  it('is off by default, tolerant of a corrupt file, never overwrites a newer schema, and keeps unknown fields', async () => {
    const dir = scratchDir('session-launch-')
    const filePath = join(dir, 'session-launch.json')
    const settings = sessionLaunch.createSessionLaunchSettings({ filePath })
    expect(await settings.read()).toEqual({ enabled: false })
    writeFileSync(filePath, '{not json')
    expect(await settings.read()).toEqual({ enabled: false })
    writeFileSync(filePath, JSON.stringify({ schema: 1, enabled: true, later: 'kept' }))
    expect(await settings.read()).toEqual({ enabled: true })
    expect(await settings.setEnabled(false)).toEqual({ enabled: false })
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ schema: 1, enabled: false, later: 'kept' })
    writeFileSync(filePath, JSON.stringify({ schema: 2, enabled: true }))
    expect(await settings.read()).toEqual({ enabled: false })
    expect(await settings.setEnabled(true)).toEqual({ enabled: false, refused: 'newer' })
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ schema: 2, enabled: true })
    await expect(settings.setEnabled('yes' as unknown as boolean)).rejects.toThrow(TypeError)
  })

  it('keeps the cap on sessions at once as one optional field of 1 to 8 (#432 §5)', async () => {
    const dir = scratchDir('session-launch-')
    const filePath = join(dir, 'session-launch.json')
    const settings = sessionLaunch.createSessionLaunchSettings({ filePath })
    expect(await settings.readMaxDrivers()).toBeNull()
    writeFileSync(filePath, JSON.stringify({ schema: 1, enabled: true, worktreeRoot: '/w', later: 'kept' }))
    expect(await settings.setMaxDrivers(3)).toEqual({ maxDrivers: 3 })
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ schema: 1, enabled: true, worktreeRoot: '/w', later: 'kept', maxDrivers: 3 })
    expect(await settings.readMaxDrivers()).toBe(3)
    await expect(settings.setMaxDrivers(9)).rejects.toThrow(TypeError)
    writeFileSync(filePath, JSON.stringify({ schema: 1, enabled: true, maxDrivers: 40 }))
    expect(await settings.readMaxDrivers()).toBeNull()
  })

  it('keeps the worktree folder as one optional field, beside the switch and unknown fields (#432)', async () => {
    const dir = scratchDir('session-launch-')
    const filePath = join(dir, 'session-launch.json')
    const settings = sessionLaunch.createSessionLaunchSettings({ filePath })
    expect(await settings.readWorktreeRoot()).toBeNull()
    writeFileSync(filePath, JSON.stringify({ schema: 1, enabled: true, later: 'kept' }))
    expect(await settings.setWorktreeRoot('/w/trees')).toEqual({ root: '/w/trees' })
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ schema: 1, enabled: true, later: 'kept', worktreeRoot: '/w/trees' })
    expect(await settings.readWorktreeRoot()).toBe('/w/trees')
    expect(await settings.setEnabled(false)).toEqual({ enabled: false })
    expect(await settings.readWorktreeRoot()).toBe('/w/trees')
    expect(await settings.setWorktreeRoot(null)).toEqual({ root: null })
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ schema: 1, enabled: false, later: 'kept' })
    writeFileSync(filePath, JSON.stringify({ schema: 1, enabled: true, worktreeRoot: 'relative' }))
    expect(await settings.readWorktreeRoot()).toBeNull()
    await expect(settings.setWorktreeRoot('relative')).rejects.toThrow(TypeError)
    writeFileSync(filePath, JSON.stringify({ schema: 2, enabled: true }))
    expect(await settings.setWorktreeRoot('/w')).toEqual({ root: null, refused: 'newer' })
  })
})

describe('the approval key (§4.3, §14.3)', () => {
  it('keeps the master key only encrypted, derives each launch key by HMAC, and signs what the driver verifies', async () => {
    const dir = scratchDir('launch-key-')
    const filePath = join(dir, 'launch-master-key')
    const keys = launchKeys.createLaunchKeys({ safeStorage: fakeSafeStorage(), filePath })
    expect(keys.available()).toBe(true)
    const key = await keys.launchKey(ID)
    const stored = readFileSync(filePath)
    const master = Buffer.from(fakeSafeStorage().decryptString(stored), 'hex')
    expect(stored.toString()).not.toContain(master.toString('hex'))
    expect((await import('node:fs')).statSync(filePath).mode & 0o777).toBe(0o600)
    expect(key.equals(fixtureLaunchKey(master, ID))).toBe(true)
    const signature = await keys.sign(ID, { item: 'item-1', revision: 0, optionId: 'allow_once' })
    expect(signature).toBe(fixtureSign(key, 'item-1', 0, 'allow_once'))
    expect(verifyApproval(key, { item: 'item-1', revision: 0, optionId: 'allow_once' }, signature)).toBe(true)
    // the same key after a relaunch: a running driver's asks stay approvable
    const again = launchKeys.createLaunchKeys({ safeStorage: fakeSafeStorage(), filePath })
    expect((await again.launchKey(ID)).equals(key)).toBe(true)
    expect((await again.launchKey('33333333-3333-4333-8333-333333333333')).equals(key)).toBe(false)
  })

  it('refuses without safeStorage encryption or with Linux’s plain-text backend, and never replaces a key it cannot read', async () => {
    const dir = scratchDir('launch-key-')
    const filePath = join(dir, 'launch-master-key')
    const off = launchKeys.createLaunchKeys({ safeStorage: fakeSafeStorage(false), filePath })
    expect(off.available()).toBe(false)
    await expect(off.launchKey(ID)).rejects.toThrow(/cannot encrypt/)
    expect(existsSync(filePath)).toBe(false)
    const basic = launchKeys.createLaunchKeys({ safeStorage: { ...fakeSafeStorage(), getSelectedStorageBackend: () => 'basic_text' }, filePath, platform: 'linux' })
    expect(basic.available()).toBe(false)
    writeFileSync(filePath, 'garbage')
    const broken = launchKeys.createLaunchKeys({ safeStorage: fakeSafeStorage(), filePath })
    await expect(broken.launchKey(ID)).rejects.toThrow(/cannot be decrypted/)
    expect(readFileSync(filePath, 'utf8')).toBe('garbage')
  })

  it('creates one master key even when two launches ask at once', async () => {
    const dir = scratchDir('launch-key-')
    const filePath = join(dir, 'launch-master-key')
    const a = launchKeys.createLaunchKeys({ safeStorage: fakeSafeStorage(), filePath })
    const b = launchKeys.createLaunchKeys({ safeStorage: fakeSafeStorage(), filePath })
    const [ka, kb] = await Promise.all([a.launchKey(ID), b.launchKey(ID)])
    expect(ka.equals(kb)).toBe(true)
  })
})

describe('the environment capture (§8)', () => {
  function fakeShell(dir: string, body: string): string {
    const shell = join(dir, 'fake-shell')
    writeFileSync(shell, `#!/bin/sh\n${body}\n`)
    chmodSync(shell, 0o755)
    return shell
  }

  it('runs the login shell interactive in the launch folder, stdin closed, and reads only what lies between its markers', async () => {
    const dir = scratchDir('shell-env-')
    mkdirSync(join(dir, 'work'))
    // an rc file's banner and noise on either side of the command, and the folder it started in
    const shell = fakeShell(dir, `echo "rc banner"; export SEEN_ARGS="$1 $2 $3"; export SEEN_PWD="$(pwd -P)"; [ -t 0 ] && export SEEN_TTY=yes; read -r line && export SEEN_STDIN="$line"; /bin/sh -c "$4"; echo "rc trailer"`)
    const calls: unknown[][] = []
    const result = await shellEnv.captureShellEnv({
      shell, cwd: join(dir, 'work'), baseEnv: { PATH: '/usr/bin:/bin', HOME: dir, KEEP: 'a=b' },
      spawnImpl: (...args: unknown[]) => { calls.push(args); return (spawn as (...a: unknown[]) => ReturnType<typeof spawn>)(...args) },
    })
    expect(result.ok).toBe(true)
    const env = (result as { env: Record<string, string> }).env
    expect(env).toMatchObject({ SEEN_ARGS: '-i -l -c', KEEP: 'a=b', HOME: dir })
    expect(env.SEEN_PWD).toBe((await import('node:fs')).realpathSync(join(dir, 'work')))
    expect(env.SEEN_TTY).toBeUndefined()
    expect(env.SEEN_STDIN).toBeUndefined()
    expect(Object.keys(env).some((name) => name.includes('banner'))).toBe(false)
    expect(calls[0]![2]).toMatchObject({ stdio: ['ignore', 'pipe', 'ignore'], shell: false, cwd: join(dir, 'work') })
  })

  it('fails visibly on a timeout (the group killed), missing markers or a relative shell; never loops', async () => {
    const dir = scratchDir('shell-env-')
    const slow = fakeShell(dir, 'sleep 30')
    const started = Date.now()
    expect(await shellEnv.captureShellEnv({ shell: slow, cwd: dir, baseEnv: {}, spawnImpl: spawn, timeoutMs: 200 })).toEqual({ ok: false, reason: 'timeout' })
    expect(Date.now() - started).toBeLessThan(5000)
    const quiet = fakeShell(dir, 'echo nothing')
    expect(await shellEnv.captureShellEnv({ shell: quiet, cwd: dir, baseEnv: {}, spawnImpl: spawn })).toEqual({ ok: false, reason: 'failed' })
    const never = vi.fn()
    expect(await shellEnv.captureShellEnv({ shell: 'zsh', cwd: dir, baseEnv: {}, spawnImpl: never })).toEqual({ ok: false, reason: 'shell' })
    expect(never).not.toHaveBeenCalled()
  })

  it('parses env -0 output, dropping names that are not variables', () => {
    const out = shellEnv.parseCapturedEnv('noise S\0A=1\0B=x=y\0BASH_FUNC_f%%=() {}\0=bad\0E\0', 'S', 'E')
    expect(out).toEqual({ A: '1', B: 'x=y' })
    expect(shellEnv.parseCapturedEnv('no markers', 'S', 'E')).toBeNull()
  })
})

describe('starting the driver (§8)', () => {
  // a driver stand-in: checks fd 3 is a socket, reads the spec, echoes what it got, and answers with its status line
  function fakeDriver(dir: string, answer: string): string {
    const entry = join(dir, 'driver-cli.js')
    writeFileSync(entry, `const fs = require('fs')
const kind = fs.fstatSync(3)
const chunks = []
const b = Buffer.alloc(65536)
for (let n; (n = fs.readSync(3, b, 0, b.length, null)) > 0;) chunks.push(Buffer.from(b.subarray(0, n)))
fs.writeFileSync(${JSON.stringify(join(dir, 'seen.json'))}, JSON.stringify({ argv: process.argv.slice(2), socket: kind.isSocket(), spec: JSON.parse(Buffer.concat(chunks).toString()), cwd: process.cwd(), env: process.env.ONLY }))
${answer}`)
    return entry
  }

  it('spawns exactly [node, driver-cli.js, run, id, hub], detached with no shell, the spec on a socket on fd 3, and reads one status line', async () => {
    const dir = scratchDir('driver-process-')
    const entry = fakeDriver(dir, `process.stdout.write(JSON.stringify({ ok: true, launch: process.argv[3] }) + '\\n'); setTimeout(() => {}, 200)`)
    const calls: unknown[][] = []
    const result = await driverProcess.startDriver({
      platform: 'darwin', node: process.execPath, entry, launchId: ID, hubPath: join(dir, 'hub', 'inbox.db'),
      spec: { v: 1, kind: 'resume', launchId: ID }, logPath: join(dir, 'hub', 'launches', ID, 'driver.log'), env: { ONLY: 'this' },
      spawnImpl: (...args: unknown[]) => { calls.push(args); return (spawn as (...a: unknown[]) => ReturnType<typeof spawn>)(...args) },
    })
    expect(result).toMatchObject({ ok: true, launch: ID })
    expect(calls).toHaveLength(1)
    expect(calls[0]![0]).toBe(process.execPath)
    expect(calls[0]![1]).toEqual([entry, 'run', ID, join(dir, 'hub', 'inbox.db')])
    expect(calls[0]![2]).toMatchObject({ cwd: '/', detached: true, shell: false, env: { ONLY: 'this' } })
    await vi.waitFor(() => expect(existsSync(join(dir, 'seen.json'))).toBe(true))
    expect(JSON.parse(readFileSync(join(dir, 'seen.json'), 'utf8'))).toEqual({
      argv: ['run', ID, join(dir, 'hub', 'inbox.db')], socket: true, spec: { v: 1, kind: 'resume', launchId: ID }, cwd: '/', env: 'this',
    })
    expect((await import('node:fs')).statSync(join(dir, 'hub', 'launches', ID, 'driver.log')).mode & 0o777).toBe(0o600)
  })

  it('hands each phase line to onPhase and resolves on the status line after them (#432 PR 5)', async () => {
    const dir = scratchDir('driver-process-')
    const seen: string[] = []
    const result = await driverProcess.startDriver({
      platform: 'darwin', node: process.execPath, launchId: ID, hubPath: join(dir, 'inbox.db'), spec: {}, logPath: join(dir, 'driver.log'), env: {},
      spawnImpl: spawn, onPhase: (phase) => { seen.push(phase) },
      entry: fakeDriver(dir, `process.stdout.write(JSON.stringify({ phase: 'worktree' }) + '\\n' + JSON.stringify({ phase: 'copilot' }) + '\\n'); setTimeout(() => process.stdout.write(JSON.stringify({ ok: true, launch: process.argv[3] }) + '\\n'), 50); setTimeout(() => {}, 200)`),
    })
    expect(result).toMatchObject({ ok: true, launch: ID })
    expect(seen).toEqual(['worktree', 'copilot'])
    // an unknown phase, or a phase line with more in it, is not a phase
    for (const line of [{ phase: 'shell' }, { phase: 'copilot', extra: 1 }]) {
      expect(await driverProcess.startDriver({
        platform: 'darwin', node: process.execPath, launchId: ID, hubPath: join(dir, 'inbox.db'), spec: {}, logPath: join(dir, 'driver.log'), env: {},
        spawnImpl: spawn, entry: fakeDriver(dir, `process.stdout.write(${JSON.stringify(JSON.stringify(line))} + '\\n')`),
      })).toEqual({ ok: false, error: 'The driver reported something unexpected.' })
    }
  })

  it('reports the driver’s own refusal, an exit before any status, and a status for another launch', async () => {
    const dir = scratchDir('driver-process-')
    const run = (answer: string) => driverProcess.startDriver({
      platform: 'darwin', node: process.execPath, entry: fakeDriver(dir, answer), launchId: ID, hubPath: join(dir, 'inbox.db'),
      spec: {}, logPath: join(dir, 'driver.log'), env: {}, spawnImpl: spawn,
    })
    expect(await run(`process.stdout.write(JSON.stringify({ ok: false, error: 'at the driver cap' }) + '\\n'); process.exit(75)`))
      .toEqual({ ok: false, error: 'at the driver cap' })
    expect(await run('process.exit(1)')).toEqual({ ok: false, error: 'The driver stopped before the session started (exit 1).' })
    expect(await run(`process.stdout.write(JSON.stringify({ ok: true, launch: 'x' }) + '\\n')`)).toEqual({ ok: false, error: 'The driver reported something unexpected.' })
  })

  it('fails closed before spawning anything on any platform but macOS, or with a relative path', async () => {
    const spawnImpl = vi.fn()
    for (const platform of ['linux', 'win32', 'freebsd']) {
      expect(await driverProcess.startDriver({ platform, node: '/n', entry: '/e', launchId: ID, hubPath: '/h', spec: {}, logPath: '/l', env: {}, spawnImpl }))
        .toEqual({ ok: false, error: 'Starting sessions from Agent Inbox is available on macOS only.' })
    }
    expect(await driverProcess.startDriver({ platform: 'darwin', node: 'node', entry: '/e', launchId: ID, hubPath: '/h', spec: {}, logPath: '/l', env: {}, spawnImpl }))
      .toEqual({ ok: false, error: 'The driver could not be found.' })
    expect(spawnImpl).not.toHaveBeenCalled()
  })
})

describe('running the driver’s worktree command (#432 §5)', () => {
  it('runs exactly [node, driver-cli.js, worktree, verb, id, hub, --discard?] with no shell and reads its JSON answer', async () => {
    const dir = scratchDir('worktree-command-')
    const entry = join(dir, 'driver-cli.js')
    writeFileSync(entry, `process.stdout.write(JSON.stringify(process.argv[3] === 'inspect' ? { ok: true, dirty: 2, argv: process.argv.slice(2), env: process.env.ONLY, cwd: process.cwd() } : { ok: false, error: 'git said no' }) + '\\n')`)
    const calls: unknown[][] = []
    const spawnImpl = (...args: unknown[]) => { calls.push(args); return (spawn as (...a: unknown[]) => ReturnType<typeof spawn>)(...args) }
    const common = { platform: 'darwin', node: process.execPath, entry, launchId: ID, hubPath: join(dir, 'inbox.db'), env: { ONLY: 'this' }, spawnImpl }
    expect(await driverProcess.runWorktreeCommand({ ...common, verb: 'inspect' })).toEqual({
      ok: true, dirty: 2, argv: ['worktree', 'inspect', ID, join(dir, 'inbox.db')], env: 'this', cwd: '/',
    })
    expect(calls[0]![2]).toMatchObject({ cwd: '/', shell: false, env: { ONLY: 'this' } })
    expect(await driverProcess.runWorktreeCommand({ ...common, verb: 'remove', discard: 'a'.repeat(64) })).toEqual({ ok: false, error: 'git said no' })
    expect(calls[1]![1]).toEqual([entry, 'worktree', 'remove', ID, join(dir, 'inbox.db'), '--discard', 'a'.repeat(64)])
    const never = vi.fn()
    for (const bad of [{ verb: 'prune' }, { verb: 'inspect', discard: 'a'.repeat(64) }, { verb: 'remove', discard: '--force' }, { verb: 'inspect', launchId: '../x' }]) {
      expect(await driverProcess.runWorktreeCommand({ ...common, spawnImpl: never, ...bad } as never)).toEqual({ ok: false, error: 'The launch is not valid.' })
    }
    expect(await driverProcess.runWorktreeCommand({ ...common, spawnImpl: never, platform: 'linux', verb: 'inspect' })).toMatchObject({ ok: false })
    expect(never).not.toHaveBeenCalled()
  })
})

// The controller with every effect recorded
function rig(over: Json = {}) {
  const calls: string[] = []
  const spawned: Json[] = []
  const state = {
    enabled: true, folders: [{ root: '/work/alpha', project: 'alpha' }] as unknown, launches: {} as Record<string, Json>, confirm: true,
    worktreeRoot: null as string | null, chosenRoot: null as string | null,
    inspected: { path: '/w/alpha/fix-22222222', branch: 'agent-inbox/fix-22222222', missing: false, dirty: 0, ahead: 2, upstream: false, status: 'b'.repeat(64) } as Json,
    answer: 'Remove',
    cap: null as number | null,
    capReads: 0,
    // #586: what the stored terminal setting reads as (an Error throws), how often it was read, and how each open ends
    terminal: null as unknown,
    terminalReads: 0,
    opens: undefined as undefined | ((command: { args: string[] }) => { ok: boolean; missing?: boolean; timedOut?: boolean }),
  }
  const keyStore = launchKeys.createLaunchKeys({ safeStorage: fakeSafeStorage(), filePath: join(scratchDir('controller-'), 'k') })
  const posted: Array<[string, unknown]> = []
  const deps = {
    platform: 'darwin',
    isEnabled: () => state.enabled,
    keys: {
      available: () => { calls.push('keys.available'); return true },
      launchKey: (id: string) => { calls.push('keys.launchKey'); return keyStore.launchKey(id) },
      sign: (id: string, a: { item: string; revision: number; optionId: string }) => { calls.push('keys.sign'); return keyStore.sign(id, a) },
    },
    viewer: {
      getJson: async (route: string) => {
        calls.push(`GET ${route}`)
        if (route === '/api/launch-folders') return state.folders
        if (route.startsWith('/api/launches/')) return state.launches[route.slice('/api/launches/'.length)] ?? null
        if (route === '/api/launches') return Object.values(state.launches)
        if (route.startsWith('/api/launch-asks/')) {
          return { item_id: 'item-1', launch_id: ID, filed_revision: 0, response_revision: 2, options: [{ optionId: 'allow_once', label: 'Allow once' }] }
        }
        return null
      },
      postJson: async (route: string, body?: unknown) => {
        calls.push(`POST ${route}`)
        posted.push([route, body])
        if (route.endsWith('/close')) return { ok: true, childPgid: 900, childStartedAt: 'darwin:Mon Nov  2 12:00:00 2026' }
        return { ok: true, status: 'stopping' }
      },
    },
    captureEnv: async (cwd: string) => {
      calls.push(`captureEnv ${cwd}`)
      return { ok: true, env: { PATH: '/opt/bin:/usr/bin', SECRET: 's', ELECTRON_RUN_AS_NODE: '1', AGENT_INBOX_DB: '/x', NODE_OPTIONS: '--x', COPILOT_ALLOW_ALL: '1', COPILOT_HOME: '/c', TMUX: '/tmp/tmux-test/default,1,0', TMUX_PANE: '%3' } }
    },
    confirm: async (text: Json) => { calls.push('confirm'); spawned.push({ confirmation: text }); return state.confirm },
    chooseFolder: async () => { calls.push('chooseFolder'); return '/picked/beta' },
    driverRuntime: () => { calls.push('driverRuntime'); return { node: '/rt/bin/node', entry: '/rt/dist/driver-cli.js' } },
    startDriver: async (args: Json) => { calls.push('startDriver'); spawned.push(args); return { ok: true, launch: args.launchId } },
    hubPath: '/hub/inbox.db',
    driverEnv: { PATH: '/usr/bin:/bin' },
    randomUUID: () => ID,
    realDirectory: (folder: string) => (folder.startsWith('/missing') ? null : folder),
    processStart: async () => 'darwin:Mon Nov  2 12:00:00 2026',
    kill: vi.fn(),
    worktreeSettings: {
      read: async () => { calls.push('worktreeSettings.read'); return state.worktreeRoot },
      write: async (root: string | null) => { calls.push(`worktreeSettings.write ${root}`); state.worktreeRoot = root; return { root } },
    },
    chooseWorktreeFolder: async () => { calls.push('chooseWorktreeFolder'); return state.chosenRoot },
    runWorktree: async (args: Json) => {
      calls.push(`runWorktree ${args.verb}${args.discard ? ` --discard ${args.discard}` : ''}`)
      spawned.push(args)
      return args.verb === 'inspect' ? { ok: true, ...state.inspected } : { ok: true }
    },
    ask: async (text: { buttons: string[] }) => { calls.push('ask'); spawned.push({ removal: text }); return text.buttons.indexOf(state.answer) },
    terminal: {
      read: async () => { state.terminalReads += 1; if (state.terminal instanceof Error) throw state.terminal; return state.terminal },
      run: async (command: { args: string[] }) => { calls.push(`open ${command.args.join(' ')}`); return state.opens?.(command) ?? { ok: true } },
    },
    // #432 §5: counted apart from `calls`, whose exact order the start tests pin
    sessionCap: {
      read: async () => { state.capReads += 1; return state.cap },
      write: async (cap: number) => { state.cap = cap; return { maxDrivers: cap } },
    },
    ...over,
  }
  return { controller: controllerModule.createLaunchController(deps), calls, spawned, state, posted, deps }
}

const REQUEST = {
  root: '/work/alpha', mode: 'plan', model: 'claude-haiku-4.5', reasoningEffort: 'none',
  budgets: { activeMs: 7_200_000, toolCalls: 500 }, prompt: 'Fix the failing test.',
}

describe('the launch controller', () => {
  it('starts only after a confirmation main builds itself, and sends exactly the spec it showed', async () => {
    const r = rig()
    const result = await r.controller.start(REQUEST)
    expect(result).toEqual({ ok: true, launch: ID })
    // the order: no shell runs before the human confirmed
    expect(r.calls.filter((c) => !c.startsWith('keys.available'))).toEqual([
      'GET /api/launch-folders', 'driverRuntime', 'confirm', 'captureEnv /work/alpha', 'keys.launchKey', 'driverRuntime', 'startDriver',
    ])
    const confirmation = r.spawned[0]!.confirmation as { message: string; detail: string; buttons: string[] }
    expect(confirmation.message).toBe('Start a Copilot session in alpha?')
    expect(confirmation.buttons).toEqual(['Start', 'Cancel'])
    expect(confirmation.detail).toContain('Folder: /work/alpha')
    expect(confirmation.detail).toContain('Mode: Plan first. The agent writes a plan first; once you approve it, each tool call asks.')
    expect(confirmation.detail).toContain('Model: claude-haiku-4.5, reasoning effort none')
    expect(confirmation.detail).toContain('Budgets: up to 2 h of active turn time and 500 tool calls.')
    expect(confirmation.detail).toContain('Once any shell command is allowed, the session can run anything')
    expect(confirmation.detail).toContain('Task: Fix the failing test.')
    // Edits in the worktree says what runs unasked, and the page offers the same words (#412 step 3, PR 4)
    const edits = controllerModule.confirmation({ project: 'alpha', folder: '/w', mode: 'edits', budgets: { activeMs: 90_000, toolCalls: 3 }, prompt: 'x' })
    expect(edits.detail).toContain('Mode: Edits in the worktree. File edits inside the session’s folder (its worktree, when it has one) run without asking, never a .git folder or file;')
    expect(controllerModule.launchRequest({ ...REQUEST, mode: 'edits' })).toMatchObject({ mode: 'edits' })
    // #479: a budget is null (no limit) or within the spec's bounds; never left out or 0
    const limits = (budgets: { activeMs: number | null; toolCalls: number | null }) => controllerModule.confirmation({ project: 'alpha', folder: '/w', mode: 'ask', budgets, prompt: 'x' }).detail.split('\n').find((line: string) => line.startsWith('Budgets:'))
    expect(limits({ activeMs: null, toolCalls: null })).toBe('Budgets: no limit on active turn time or tool calls.')
    expect(limits({ activeMs: 7_200_000, toolCalls: null })).toBe('Budgets: up to 2 h of active turn time and no limit on tool calls.')
    expect(limits({ activeMs: null, toolCalls: 500 })).toBe('Budgets: no limit on active turn time and up to 500 tool calls.')
    expect(controllerModule.launchRequest({ ...REQUEST, budgets: { activeMs: null, toolCalls: null } })).toMatchObject({ budgets: { activeMs: null, toolCalls: null } })
    for (const budgets of [{ activeMs: 7_200_000 }, { activeMs: 0, toolCalls: null }, { activeMs: null, toolCalls: 2001 }, { activeMs: undefined, toolCalls: null }]) {
      expect(controllerModule.launchRequest({ ...REQUEST, budgets }), JSON.stringify(budgets)).toBeNull()
    }
    const page = await import('../public/launches.js')
    for (const mode of page.LAUNCH_MODES) expect(controllerModule.MODES[mode.id], mode.id).toEqual({ label: mode.label, copy: mode.copy })
    expect(Object.keys(controllerModule.MODES).sort()).toEqual(page.LAUNCH_MODES.map((m) => m.id).sort())
    const args = r.spawned[1]!
    expect(args).toMatchObject({ platform: 'darwin', node: '/rt/bin/node', entry: '/rt/dist/driver-cli.js', launchId: ID, hubPath: '/hub/inbox.db', logPath: `/hub/launches/${ID}/driver.log`, env: { PATH: '/usr/bin:/bin' } })
    // the spec the driver will parse: exactly the confirmed facts, the env through the denylist, the derived key
    const spec = args.spec as Json
    const parsed = parseLaunchSpec(JSON.stringify(spec), ID)
    expect(parsed.ok).toBe(true)
    expect(parsed.ok && parsed.spec).toMatchObject({
      kind: 'new', cwd: '/work/alpha', mode: 'plan', model: 'claude-haiku-4.5', reasoningEffort: 'none',
      budgets: { activeMs: 7_200_000, toolCalls: 500 }, prompt: 'Fix the failing test.',
      env: { PATH: '/opt/bin:/usr/bin', SECRET: 's', COPILOT_HOME: '/c' },
    })
    expect(Object.keys(spec.env as Json).sort()).toEqual(['COPILOT_HOME', 'PATH', 'SECRET'])
  })

  it('shows a long task cut at 300 characters and makes invisible characters visible', () => {
    const text = controllerModule.confirmation({
      project: 'alpha\u202e', folder: '/w', mode: 'ask', budgets: { activeMs: 90_000, toolCalls: 3 }, prompt: `${'x'.repeat(310)}`,
    })
    expect(text.message).toBe('Start a Copilot session in alpha<U+202E>?')
    expect(text.detail).toContain(`Task: ${'x'.repeat(300)}…`)
    expect(text.detail).toContain('up to 2 min of active turn time')
    expect(text.detail).toContain('Model: your Copilot default')
  })

  it('keeps a project an agent named to one capped line, with separators and format characters visible (#430 review)', () => {
    const project = 'alpha\u2028\u2028Folder: /Users/me/alpha\u2028Mode: Read-only.'
    const text = controllerModule.confirmation({ project, folder: '/w\nMode: Read-only.', mode: 'ask', budgets: { activeMs: 90_000, toolCalls: 3 }, prompt: 'x' })
    expect(text.message).toBe('Start a Copilot session in alpha<U+2028><U+2028>Folder: /Users/me/alpha<U+2028>Mode: Read-only.?')
    expect(text.message).not.toMatch(/[\n\u2028\u2029]/)
    expect(text.detail.split('\n')[0]).toBe('Folder: /w\\x0aMode: Read-only.')
    for (const ch of ['\u2029', '\u061c', '\u2060', '\u2061', '\u2062', '\u2063', '\u2064', '\u00ad', '\u{e0041}']) {
      expect(controllerModule.displayLine(`a${ch}b`), JSON.stringify(ch)).toBe(`a<U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}>b`)
    }
    const long = controllerModule.confirmation({ project: 'p'.repeat(500), folder: `/${'f'.repeat(500)}`, mode: 'ask', budgets: { activeMs: 90_000, toolCalls: 3 }, prompt: 'x' })
    expect(long.message).toBe(`Start a Copilot session in ${'p'.repeat(119)}…?`)
    expect(long.detail.split('\n')[0]).toBe(`Folder: /${'f'.repeat(118)}…`)
    const quit = controllerModule.displayLine('😀'.repeat(200))
    expect(Array.from(quit)).toHaveLength(120)
    // cut on the raw text, then escaped: never through an escape
    expect(controllerModule.displayLine(`${'a'.repeat(118)}\u2028${'b'.repeat(10)}`)).toBe(`${'a'.repeat(118)}<U+2028>…`)
    expect(controllerModule.displayLine('\u2028'.repeat(500))).toBe(`${'<U+2028>'.repeat(119)}…`)
  })

  it('escapes exactly the characters the driver’s terminalSafe escapes', () => {
    const differs: string[] = []
    for (let code = 0; code <= 0x10ffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue
      // a tab, a newline and a carriage return are each side's own line handling
      if (code === 0x09 || code === 0x0a || code === 0x0d) continue
      const ch = String.fromCodePoint(code)
      if ((controllerModule.displaySafe(ch) !== ch) !== (terminalSafe(ch) !== ch)) differs.push(code.toString(16))
    }
    expect(differs).toEqual([])
    expect(terminalSafe('a\u2028b\u061cc\u2060d')).toBe('a<U+2028>b<U+061C>c<U+2060>d')
  })

  it('takes a folder only from the repository folders the hub knows, or from main’s own dialog', async () => {
    const r = rig()
    expect(await r.controller.start({ ...REQUEST, root: '/etc' })).toMatchObject({ ok: false, error: expect.stringMatching(/not one Agent Inbox knows/) })
    expect(r.calls).not.toContain('startDriver')
    const picked = rig()
    expect(await picked.controller.start({ ...REQUEST, root: null })).toEqual({ ok: true, launch: ID })
    expect(picked.calls).toContain('chooseFolder')
    expect(((picked.spawned[1]!.spec) as Json).cwd).toBe('/picked/beta')
    expect((picked.spawned[0]!.confirmation as Json).message).toBe('Start a Copilot session in beta?')
  })

  it.each([
    ['a path for an executable', { ...REQUEST, command: '/bin/sh' }],
    ['argv', { ...REQUEST, args: ['--yolo'] }],
    ['an env', { ...REQUEST, env: { PATH: '/evil' } }],
    ['a relative folder', { ...REQUEST, root: 'work' }],
    ['an unknown mode', { ...REQUEST, mode: 'autopilot' }],
    ['a budget out of bounds', { ...REQUEST, budgets: { activeMs: 1, toolCalls: 500 } }],
    ['an empty task', { ...REQUEST, prompt: ' ' }],
    ['not an object', 'start'],
    // #432: the renderer asks for a worktree, and names nothing of it
    ['a worktree path', { ...REQUEST, worktree: '/w/alpha/fix' }],
    ['a worktree plan', { ...REQUEST, worktree: { path: '/w/alpha/fix-22222222', branch: 'agent-inbox/fix-22222222' } }],
    ['a branch', { ...REQUEST, worktree: true, branch: 'main' }],
    ['a worktree root', { ...REQUEST, worktree: true, worktreeRoot: '/w' }],
    ['a worktree flag that is not true', { ...REQUEST, worktree: 1 }],
    // #432 PR 5 review: the start's tag is a bounded token only
    ['a start tag that is too short', { ...REQUEST, startId: 'abc' }],
    ['a start tag with a path in it', { ...REQUEST, startId: '/Users/shariqh/x/../y' }],
    ['a start tag that is not text', { ...REQUEST, startId: 12345678901234567 }],
  ])('refuses a request carrying %s before anything runs', async (_, request) => {
    const r = rig()
    expect(await r.controller.start(request)).toEqual({ ok: false, error: 'The new session request is not valid.' })
    expect(r.calls.filter((c) => !c.startsWith('keys.available'))).toEqual([])
  })

  it('starts nothing when cancelled, or when the switch went off or a quit began while the dialog was open', async () => {
    const cancelled = rig()
    cancelled.state.confirm = false
    expect(await cancelled.controller.start(REQUEST)).toMatchObject({ ok: false, cancelled: true })
    expect(cancelled.calls).not.toContain('captureEnv /work/alpha')
    for (const late of ['off', 'quit'] as const) {
      const r = rig({
        confirm: async () => { if (late === 'off') r.state.enabled = false; else r.controller.beginQuit(); return true },
      })
      const result = await r.controller.start(REQUEST)
      expect(result.ok, late).toBe(false)
      expect(r.calls, late).not.toContain('startDriver')
    }
  })

  it('starts nothing when a quit begins or the switch goes off during the key read, and settled() waits for a start in flight', async () => {
    for (const late of ['off', 'quit'] as const) {
      const r = rig()
      const read = r.deps.keys.launchKey
      r.deps.keys.launchKey = async (id: string) => {
        const key = await read(id)
        if (late === 'off') r.state.enabled = false
        else r.controller.beginQuit()
        return key
      }
      const result = await r.controller.start(REQUEST)
      expect(result, late).toMatchObject({ ok: false })
      expect(r.calls, late).toContain('keys.launchKey')
      expect(r.calls, late).not.toContain('startDriver')
    }
    const r = rig()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const read = r.deps.keys.launchKey
    r.deps.keys.launchKey = async (id: string) => { await gate; return read(id) }
    const started = r.controller.start(REQUEST)
    let settled = false
    const waiting = r.controller.settled().then(() => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(settled).toBe(false)
    release()
    await waiting
    expect(await started).toEqual({ ok: true, launch: ID })
  })

  it('verifies the runtime again immediately before the spawn, and spawns what that check found (#435)', async () => {
    const answers: Array<Json> = [
      { node: '/rt/bin/node', entry: '/rt/dist/driver-cli.js' },
      { error: 'The installed v2.3.0 runtime failed integrity verification: reinstall it from Settings → Setup.' },
    ]
    const changed = rig({ driverRuntime: () => answers.shift() })
    expect(await changed.controller.start(REQUEST)).toEqual({ ok: false, error: expect.stringMatching(/failed integrity verification/) })
    expect(changed.calls).toContain('keys.launchKey')
    expect(changed.calls).not.toContain('startDriver')
    const bundle = [{ node: '/rt/bin/node', entry: '/rt/dist/driver-cli.js' }, { node: '/app/rt/bin/node', entry: '/app/rt/dist/driver-cli.js' }]
    const r = rig({ driverRuntime: () => bundle.shift() })
    expect(await r.controller.start(REQUEST)).toEqual({ ok: true, launch: ID })
    expect(r.spawned.at(-1)).toMatchObject({ node: '/app/rt/bin/node', entry: '/app/rt/dist/driver-cli.js' })
  })

  it('off means off (§9 e): no env, no runtime, no spawn, no folder read, no key, and available() says off', async () => {
    const r = rig()
    r.state.enabled = false
    expect(r.controller.available()).toEqual({ enabled: false, available: false, error: expect.stringMatching(/is off/) })
    for (const result of [
      await r.controller.start(REQUEST), await r.controller.resume(ID), await r.controller.approve({ item: 'item-1', revision: 2, optionId: 'allow_once' }),
      await r.controller.start({ ...REQUEST, worktree: true }), await r.controller.chooseWorktreeRoot(), await r.controller.resetWorktreeRoot(),
      await r.controller.chooseFolder(),
      // #586 phase 2: Continue here… reads no chat, no launch list and no folder
      await r.controller.continueChat({ tool: 'copilot', id: ID, mode: 'ask', prompt: 'Go on.' }),
    ]) expect(result.ok).toBe(false)
    // #432 §8 (e): no worktree setting read, no folder dialog, no folder made, and no cap read or written
    expect(await r.controller.worktreeRoot()).toBeNull()
    expect(await r.controller.maxSessions()).toBeNull()
    expect(await r.controller.setMaxSessions(3)).toMatchObject({ ok: false })
    expect(r.state).toMatchObject({ cap: null, capReads: 0 })
    expect(r.calls).toEqual([])
    // reading whether it may be turned on never touches safeStorage
    expect(r.controller.canEnable()).toBeNull()
    expect(r.calls).toEqual([])
  })

  it('refuses everywhere but macOS, and without safeStorage', async () => {
    expect(rig({ platform: 'linux' }).controller.available()).toMatchObject({ available: false, error: expect.stringMatching(/macOS only/) })
    const noKeys = rig()
    noKeys.deps.keys.available = () => false
    const fresh = controllerModule.createLaunchController(noKeys.deps)
    expect(fresh.available()).toMatchObject({ available: false, error: expect.stringMatching(/cannot encrypt/) })
    expect(fresh.canEnable({ withKeys: true })).toMatchObject({ ok: false })
  })

  it('resumes only a parked launch, or one stopped with its session (step 5), with no second confirmation, in its own folder', async () => {
    const r = rig()
    const refusal = { ok: false, error: 'This session cannot be resumed: only a parked session, or one you stopped after its task was sent, can be.' }
    for (const over of [
      { status: 'running' }, { status: 'ended', end_reason: 'stopped', resumable: false }, { status: 'ended', end_reason: 'handed_off', resumable: true },
      { status: 'ended', end_reason: 'budget:active_time', resumable: true },
      { status: 'ended', end_reason: 'stopped', resumable: true, worktree_path: '/w/a', worktree_removed_at: '2026-11-03T12:00:00.000Z' },
    ]) {
      r.state.launches[ID] = { id: ID, cwd: '/work/alpha', ...over }
      expect(await r.controller.resume(ID), JSON.stringify(over)).toEqual(refusal)
    }
    expect(r.calls.filter((c) => c === 'startDriver')).toEqual([])
    r.state.launches[ID] = { id: ID, status: 'ended', end_reason: 'stopped', resumable: true, cwd: '/work/alpha' }
    expect(await r.controller.resume(ID)).toEqual({ ok: true, launch: ID })
    expect(parseLaunchSpec(JSON.stringify(r.spawned.at(-1)!.spec), ID)).toMatchObject({ ok: true, spec: { kind: 'resume' } })
    r.state.launches[ID] = { id: ID, status: 'parked', cwd: '/work/alpha' }
    expect(await r.controller.resume(ID)).toEqual({ ok: true, launch: ID })
    expect(r.calls).not.toContain('confirm')
    expect(r.calls).toContain('captureEnv /work/alpha')
    const spec = r.spawned.at(-1)!.spec as Json
    expect(parseLaunchSpec(JSON.stringify(spec), ID)).toMatchObject({ ok: true, spec: { kind: 'resume', launchId: ID } })
  })

  describe('Resume with more budget… (#451)', () => {
    const BUDGET_ENDED = {
      id: ID, project: 'alpha', cwd: '/work/alpha', mode: 'ask', status: 'ended', end_reason: 'budget:tool_calls', resumable: true, revision: 9,
      budget_active_ms: 7_200_000, budget_tool_calls: 500, active_ms: 2_280_000, tool_calls: 500,
    }
    const ADD = { activeMs: 3_600_000, toolCalls: 250 }

    it('resumes a budget-ended launch only after main’s own confirmation, bound to the revision it read, with exactly the allowance', async () => {
      const r = rig()
      r.state.launches[ID] = { ...BUDGET_ENDED }
      expect(await r.controller.resumeWithBudget({ id: ID, add: ADD })).toEqual({ ok: true, launch: ID })
      expect(r.calls.filter((c) => !c.startsWith('keys.available'))).toEqual([
        `GET /api/launches/${ID}`, 'driverRuntime', 'confirm', 'captureEnv /work/alpha', 'keys.launchKey', 'driverRuntime', 'startDriver',
      ])
      const shown = r.spawned[0]!.confirmation as { message: string; detail: string; buttons: string[] }
      expect(shown.message).toBe('Resume the session of alpha with more budget?')
      expect(shown.buttons).toEqual(['Resume', 'Cancel'])
      expect(shown.detail.split('\n').slice(0, 6)).toEqual([
        'Folder: /work/alpha',
        'It ended when it used its tool-call budget. Its session is kept.',
        'Budgets: 2 h of active turn time and 500 tool calls.',
        'Used: 38 min of active turn time and 500 tool calls.',
        'Add: 1 h and 250 tool calls.',
        'New budgets: 3 h of active turn time and 750 tool calls.',
      ])
      const parsed = parseLaunchSpec(JSON.stringify(r.spawned[1]!.spec), ID)
      expect(parsed.ok && parsed.spec).toMatchObject({ kind: 'resume', raise: { revision: 9, activeMs: 3_600_000, toolCalls: 250 } })
      // Cancel starts nothing
      r.state.confirm = false
      expect(await r.controller.resumeWithBudget({ id: ID, add: ADD })).toEqual({ ok: false, error: 'Not resumed.', cancelled: true })
      expect(r.calls.filter((c) => c === 'startDriver')).toHaveLength(1)
      // the plain resume never takes it
      r.state.confirm = true
      expect(await r.controller.resume(ID)).toMatchObject({ ok: false })
      expect(r.calls.filter((c) => c === 'startDriver')).toHaveLength(1)
    })

    it('refuses before any dialog a request out of bounds, a launch a budget did not end, and an allowance that leaves it spent', async () => {
      const r = rig()
      r.state.launches[ID] = { ...BUDGET_ENDED }
      for (const bad of [
        { id: ID, add: { activeMs: 0, toolCalls: 0 } }, { id: ID, add: { activeMs: 90_000, toolCalls: 1 } }, { id: ID, add: { activeMs: 8 * 3_600_000 + 60_000, toolCalls: 0 } },
        { id: ID, add: { activeMs: 0, toolCalls: 2001 } }, { id: ID, add: { ...ADD, revision: 9 } }, { id: ID, add: ADD, revision: 9 }, { id: '../x', add: ADD }, ID,
      ]) expect(await r.controller.resumeWithBudget(bad), JSON.stringify(bad)).toEqual({ ok: false, error: 'The budget to add is not valid.' })
      for (const over of [
        { status: 'parked' }, { end_reason: 'stopped' }, { end_reason: 'error:setup' }, { resumable: false }, { revision: undefined },
        { worktree_path: '/w/a', worktree_removed_at: '2026-11-03T12:00:00.000Z' },
      ]) {
        r.state.launches[ID] = { ...BUDGET_ENDED, ...over }
        expect(await r.controller.resumeWithBudget({ id: ID, add: ADD }), JSON.stringify(over)).toMatchObject({ ok: false, error: expect.stringMatching(/cannot be resumed with more budget/) })
      }
      r.state.launches[ID] = { ...BUDGET_ENDED }
      expect(await r.controller.resumeWithBudget({ id: ID, add: { activeMs: 3_600_000, toolCalls: 0 } })).toEqual({ ok: false, error: 'Add tool calls: it has used 500 tool calls.' })
      r.state.launches[ID] = { ...BUDGET_ENDED, end_reason: 'budget:active_time', active_ms: 7_200_000, tool_calls: 12 }
      expect(await r.controller.resumeWithBudget({ id: ID, add: { activeMs: 0, toolCalls: 10 } })).toEqual({ ok: false, error: 'Add active time: it has used 2 h of it.' })
      expect(r.calls).not.toContain('confirm')
      expect(r.calls).not.toContain('startDriver')
      // off means off
      r.state.enabled = false
      r.state.launches[ID] = { ...BUDGET_ENDED }
      const before = r.calls.length
      expect(await r.controller.resumeWithBudget({ id: ID, add: ADD })).toMatchObject({ ok: false, error: expect.stringMatching(/is off/) })
      expect(r.calls.slice(before)).toEqual([])
    })

    it('#479: takes a launch with no limit on the other budget, adds nothing to it, and says so', async () => {
      const r = rig()
      r.state.launches[ID] = { ...BUDGET_ENDED, budget_active_ms: null }
      expect(await r.controller.resumeWithBudget({ id: ID, add: ADD })).toEqual({ ok: false, error: 'It has no active-time limit to add to.' })
      expect(await r.controller.resumeWithBudget({ id: ID, add: { activeMs: 0, toolCalls: 250 } })).toEqual({ ok: true, launch: ID })
      expect((r.spawned[0]!.confirmation as { detail: string }).detail.split('\n').slice(2, 6)).toEqual([
        'Budgets: no limit on active turn time and 500 tool calls.',
        'Used: 38 min of active turn time and 500 tool calls.',
        'Add: 0 min and 250 tool calls.',
        'New budgets: no limit on active turn time and 750 tool calls.',
      ])
      r.state.launches[ID] = { ...BUDGET_ENDED, end_reason: 'budget:active_time', active_ms: 7_200_000, budget_tool_calls: null }
      expect(await r.controller.resumeWithBudget({ id: ID, add: ADD })).toEqual({ ok: false, error: 'It has no tool-call limit to add to.' })
    })

    it('shows an agent-set project and mode visibly on one line', () => {
      const text = controllerModule.budgetConfirmation({ launch: { ...BUDGET_ENDED, project: 'a\u2028Add: 8 h', mode: 'x\ny' }, folder: '/w\nUsed: 0', add: ADD })
      expect(text.message).toBe('Resume the session of a<U+2028>Add: 8 h with more budget?')
      expect(text.detail.split('\n')[0]).toBe('Folder: /w\\x0aUsed: 0')
      expect(text.detail).toContain('Mode: x\\x0ay.')
    })
  })

  it('signs an approval over the ask’s filing revision under its launch key, and writes it at the revision shown', async () => {
    const r = rig()
    expect(await r.controller.approve({ item: 'item-1', revision: 2, optionId: 'allow_once' })).toEqual({ ok: true })
    const [route, body] = r.posted.at(-1)!
    expect(route).toBe('/api/launch-asks/item-1/answer')
    const key = await r.deps.keys.launchKey(ID)
    expect(body).toEqual({ revision: 2, optionId: 'allow_once', signature: fixtureSign(key, 'item-1', 0, 'allow_once') })
    expect(await r.controller.approve({ item: 'item-1', revision: 2, optionId: 'allow_always' })).toMatchObject({ ok: false })
    expect(await r.controller.approve({ item: 'item-1', revision: 2, optionId: 'allow_once', extra: 1 })).toMatchObject({ ok: false })
  })

  it('Close kills the lost launch’s process group only while it still started when the driver recorded it', async () => {
    const r = rig()
    expect(await r.controller.close(ID)).toEqual({ ok: true, killed: true })
    expect(r.deps.kill).toHaveBeenCalledWith(-900, 'SIGTERM')
    const reused = rig({ processStart: async () => 'darwin:Tue Nov  3 09:00:00 2026' })
    expect(await reused.controller.close(ID)).toEqual({ ok: true, killed: false })
    expect(reused.deps.kill).not.toHaveBeenCalled()
  })

  it('a start still waiting on its confirmation never hides running sessions from the quit prompt, and never spawns (#430 review)', async () => {
    let answer!: (ok: boolean) => void
    const r = rig({ confirm: () => new Promise<boolean>((resolve) => { answer = resolve }) })
    r.state.launches = { [ID]: { id: ID, status: 'running', project: 'alpha', mode: 'ask', driver: 'running' } }
    const pending = r.controller.start(REQUEST)
    await new Promise((resolve) => setTimeout(resolve, 10))
    r.controller.beginQuit()
    const started = Date.now()
    expect(await controllerModule.runningAtQuit(r.controller, { settleMs: 50, readMs: 1000 })).toEqual([{ id: ID, project: 'alpha', mode: 'ask' }])
    expect(Date.now() - started).toBeLessThan(900)
    // the human answers Start after the prompt: the gate is closed, nothing spawns
    answer(true)
    expect(await pending).toMatchObject({ ok: false, error: expect.stringMatching(/quitting/) })
    expect(r.calls).not.toContain('startDriver')
    expect(r.calls).not.toContain('captureEnv /work/alpha')
    // a read that never answers is bounded too
    expect(await controllerModule.runningAtQuit({ settled: async () => {}, running: () => new Promise(() => {}) } as never, { settleMs: 10, readMs: 30 })).toEqual([])
  })

  it('lists for the quit prompt only launches whose driver is running, and the prompt has no Cancel', async () => {
    const r = rig()
    r.state.launches = {
      [ID]: { id: ID, status: 'running', project: 'alpha', mode: 'ask', driver: 'running' },
      '33333333-3333-4333-8333-333333333333': { id: '33333333-3333-4333-8333-333333333333', status: 'running', project: 'beta', mode: 'ask', driver: 'lost' },
    }
    expect(await r.controller.running()).toEqual([{ id: ID, project: 'alpha', mode: 'ask' }])
    const showMessageBox = vi.fn(async () => ({ response: 1 }))
    expect(await controllerModule.quitChoice({ running: [{ id: ID, project: 'alpha', mode: 'ask' }], showMessageBox })).toBe('stop')
    expect((showMessageBox.mock.calls[0] as unknown as [Json])[0]).toMatchObject({ buttons: ['Keep running', 'Stop all'], cancelId: 0 })
    showMessageBox.mockResolvedValueOnce({ response: 0 })
    expect(await controllerModule.quitChoice({ running: [{ id: ID, project: 'alpha', mode: 'ask' }], showMessageBox })).toBe('keep')
  })
})

describe('a session in its own worktree (#432)', () => {
  // real scratch folders: main checks them with lstat and realpath, and runs no git
  function worktreeRig(over: Json = {}) {
    const dir = realpathSync(scratchDir('wt-controller-'))
    const work = join(dir, 'alpha')
    mkdirSync(join(work, '.git'), { recursive: true })
    const hub = join(dir, 'hub')
    mkdirSync(hub, { mode: 0o700 })
    const r = rig({
      hubPath: join(hub, 'inbox.db'),
      realDirectory: (folder: string) => { try { return realpathSync(folder) } catch { return null } },
      ...over,
    })
    r.state.folders = [{ root: work, project: 'alpha' }]
    const wanted = { ...REQUEST, root: work, worktree: true }
    return { ...r, dir, work, hub, wanted, planned: join(hub, 'worktrees', 'alpha', 'fix-the-failing-test-22222222') }
  }

  it('plans the path and branch before the confirmation, shows them, and sends them in the spec the driver accepts', async () => {
    const r = worktreeRig({ randomUUID: () => { r.calls.push('randomUUID'); return ID } })
    expect(await r.controller.start(r.wanted)).toEqual({ ok: true, launch: ID })
    const order = r.calls.filter((c) => !c.startsWith('keys.available'))
    expect(order.indexOf('randomUUID')).toBeLessThan(order.indexOf('confirm'))
    expect(order.slice(0, order.indexOf('confirm'))).toEqual(['GET /api/launch-folders', 'driverRuntime', 'randomUUID', 'worktreeSettings.read', 'GET /api/launches'])
    const detail = (r.spawned[0]!.confirmation as { detail: string }).detail.split('\n')
    // a long path keeps its end, which names the branch and the launch
    const shown = Array.from(r.planned).length > 120 ? `…${Array.from(r.planned).slice(-119).join('')}` : r.planned
    expect(detail.slice(0, 4)).toEqual([
      `Folder: ${controllerModule.displayLine(r.work)}`,
      `Worktree: ${shown}`,
      'Branch: agent-inbox/fix-the-failing-test-22222222, from your checkout’s last commit. Uncommitted changes stay in your checkout.',
      'Creating it runs your repository’s checkout hooks.',
    ])
    const args = r.spawned[1]!
    // the status comes once Copilot is set up (#432 PR 5), after up to 2 minutes of worktree
    expect(args.timeoutMs).toBe(420_000)
    const parsed = parseLaunchSpec(JSON.stringify(args.spec), ID)
    expect(parsed).toMatchObject({ ok: true, spec: { cwd: r.work, worktree: { path: r.planned, branch: 'agent-inbox/fix-the-failing-test-22222222' } } })
    // the env is still captured in the checkout; main created nothing
    expect(r.calls).toContain(`captureEnv ${r.work}`)
    expect(existsSync(join(r.hub, 'worktrees'))).toBe(false)
    // a start without a worktree keeps the driver's own status timeout and reads no worktree setting
    const plain = worktreeRig()
    expect(await plain.controller.start({ ...plain.wanted, worktree: undefined })).toEqual({ ok: true, launch: ID })
    expect(plain.spawned[1]).not.toHaveProperty('timeoutMs')
    expect((plain.spawned[1]!.spec as Json).worktree).toBeUndefined()
    expect(plain.calls).not.toContain('worktreeSettings.read')
  })

  it('warns when another running session of this app works in the folder itself, and uses the folder chosen in Settings', async () => {
    const r = worktreeRig()
    const root = join(r.dir, 'trees')
    mkdirSync(root, { mode: 0o700 })
    r.state.worktreeRoot = root
    r.state.launches = {
      a: { id: 'a', status: 'running', cwd: r.work, worktree_path: null },
      b: { id: 'b', status: 'running', cwd: join(r.hub, 'x'), worktree_path: join(r.hub, 'x') },
    }
    expect(await r.controller.start(r.wanted)).toEqual({ ok: true, launch: ID })
    const detail = (r.spawned[0]!.confirmation as { detail: string }).detail
    expect(detail).toContain(`Worktree: ${join(root, 'alpha', 'fix-the-failing-test-22222222')}`)
    expect(detail).toContain('Another session Agent Inbox started is running in this folder itself, not in a worktree.')
  })

  it.each([
    ['a folder that is not a repository’s top', (r: ReturnType<typeof worktreeRig>) => { rmSync(join(r.work, '.git'), { recursive: true }) }, /is not the top folder of a git repository/],
    ['a root inside the repository', (r: ReturnType<typeof worktreeRig>) => { r.state.worktreeRoot = join(r.work, 'trees') }, /inside this repository/],
    ['a root whose <repo> folder is the repository itself', (r: ReturnType<typeof worktreeRig>) => { r.state.worktreeRoot = r.dir }, /inside this repository/],
    ['a chosen root that no longer exists', (r: ReturnType<typeof worktreeRig>) => { r.state.worktreeRoot = join(r.dir, 'gone') }, /does not exist/],
    ['a symlinked root', (r: ReturnType<typeof worktreeRig>) => {
      mkdirSync(join(r.dir, 'real'), { mode: 0o700 })
      symlinkSync(join(r.dir, 'real'), join(r.dir, 'link'))
      r.state.worktreeRoot = join(r.dir, 'link')
    }, /is a symlink or lies under one/],
    ['a root others can write', (r: ReturnType<typeof worktreeRig>) => {
      mkdirSync(join(r.dir, 'open'))
      chmodSync(join(r.dir, 'open'), 0o777)
      r.state.worktreeRoot = join(r.dir, 'open')
    }, /others can write/],
    ['a root a tool pattern would read', (r: ReturnType<typeof worktreeRig>) => {
      mkdirSync(join(r.dir, 'w (1)'), { mode: 0o700 })
      r.state.worktreeRoot = join(r.dir, 'w (1)')
    }, /has one of/],
    ['an existing path', (r: ReturnType<typeof worktreeRig>) => { mkdirSync(r.planned, { recursive: true, mode: 0o700 }) }, /already exists/],
  ] as Array<[string, (r: ReturnType<typeof worktreeRig>) => void, RegExp]>)('refuses %s before the confirmation, creating nothing', async (_, arrange, error) => {
    const r = worktreeRig()
    arrange(r)
    const made = existsSync(join(r.hub, 'worktrees'))
    expect(await r.controller.start(r.wanted)).toEqual({ ok: false, error: expect.stringMatching(error) })
    expect(r.calls).not.toContain('confirm')
    expect(r.calls).not.toContain('startDriver')
    expect(existsSync(join(r.hub, 'worktrees'))).toBe(made)
  })

  it('Choose folder… asks main’s own dialog before Start, says whether it is a repository, and only that folder may then be named', async () => {
    const r = worktreeRig()
    const plain = join(r.dir, 'notes')
    mkdirSync(plain)
    let picked = r.work
    r.deps.chooseFolder = async () => { r.calls.push('chooseFolder'); return picked }
    const controller = controllerModule.createLaunchController(r.deps)
    expect(await controller.chooseFolder()).toEqual({ ok: true, folder: r.work, project: 'alpha', repository: true })
    picked = plain
    expect(await controller.chooseFolder()).toEqual({ ok: true, folder: plain, project: 'notes', repository: false })
    // a folder main's dialog chose is accepted like a known one; it runs in place without a worktree
    expect(await controller.start({ ...REQUEST, root: plain })).toEqual({ ok: true, launch: ID })
    expect((r.spawned.at(-1)!.spec as Json).cwd).toBe(plain)
    expect((r.spawned.at(-2)!.confirmation as Json).message).toBe('Start a Copilot session in notes?')
    // defence in depth: main still refuses a worktree there, before the confirmation
    const confirms = r.calls.filter((c) => c === 'confirm').length
    expect(await controller.start({ ...REQUEST, root: plain, worktree: true })).toEqual({ ok: false, error: expect.stringMatching(/not the top folder of a git repository/) })
    expect(r.calls.filter((c) => c === 'confirm')).toHaveLength(confirms)
    // a folder neither the hub knows nor main chose is still refused
    expect(await controller.start({ ...REQUEST, root: join(r.dir, 'hub') })).toMatchObject({ ok: false, error: expect.stringMatching(/not one Agent Inbox knows/) })
    r.deps.chooseFolder = async () => null as unknown as string
    expect(await controllerModule.createLaunchController(r.deps).chooseFolder()).toMatchObject({ ok: false, cancelled: true })
  })

  // review of #444: a root in another letter case than the folder, on a case-insensitive volume
  it.skipIf(!(tmpdir().toUpperCase() !== tmpdir() && existsSync(tmpdir().toUpperCase())))(
    'refuses a root inside the folder written in another letter case, before the confirmation', async () => {
      const r = worktreeRig()
      mkdirSync(join(r.work, 'trees'), { mode: 0o700 })
      r.state.worktreeRoot = join(r.dir, 'ALPHA', 'trees')
      expect(await r.controller.start(r.wanted)).toEqual({ ok: false, error: expect.stringMatching(/on-disk letter case/) })
      expect(r.calls).not.toContain('confirm')
      expect(existsSync(join(r.work, 'trees', 'alpha'))).toBe(false)
    })

  describe('Remove worktree and Open in Terminal (§5, §6)', () => {
    const ENDED = { id: ID, status: 'ended', project: 'alpha', cwd: '/w/alpha/fix-22222222', worktree_path: '/w/alpha/fix-22222222', checkout_root: '/work/alpha', branch: 'agent-inbox/fix-22222222', worktree_removed_at: null }

    it('inspects, asks in main’s own dialog, then removes; the env is captured in the checkout and the branch is never named for deletion', async () => {
      const r = rig()
      r.state.launches[ID] = { ...ENDED }
      expect(await r.controller.removeWorktree(ID)).toEqual({ ok: true })
      expect(r.calls.filter((c) => !c.startsWith('keys.available'))).toEqual([
        `GET /api/launches/${ID}`, 'driverRuntime', 'captureEnv /work/alpha', 'runWorktree inspect', 'ask', 'runWorktree remove',
      ])
      const removal = (r.spawned.find((x) => 'removal' in x)!.removal) as { message: string; detail: string; buttons: string[] }
      expect(removal).toEqual({
        message: 'Remove the worktree of alpha?',
        detail: [
          'Worktree: /w/alpha/fix-22222222',
          'The branch agent-inbox/fix-22222222 and its 2 commits stay in your repository; it has no upstream, so they are only there.',
          'Ignored files such as node_modules are deleted.',
        ].join('\n'),
        buttons: ['Remove', 'Cancel'],
      })
      expect(r.spawned.find((x) => x.verb === 'inspect')).toMatchObject({ launchId: ID, hubPath: '/hub/inbox.db', node: '/rt/bin/node', env: { PATH: '/opt/bin:/usr/bin' } })
    })

    it('offers Discard only with changes, bound to the status it inspected; Cancel removes nothing', async () => {
      const r = rig()
      r.state.launches[ID] = { ...ENDED }
      r.state.inspected = { ...r.state.inspected, dirty: 3, upstream: true, examples: ['a.txt', 'out/b.txt', 'out/c.txt'], noDiscard: null }
      r.state.answer = 'Discard 3 changes and remove'
      expect(await r.controller.removeWorktree(ID)).toEqual({ ok: true })
      const removal = (r.spawned.find((x) => 'removal' in x)!.removal) as { detail: string; buttons: string[] }
      expect(removal.buttons).toEqual(['Remove', 'Discard 3 changes and remove', 'Cancel'])
      expect(removal.detail).toContain('It has 3 uncommitted changes: a.txt, out/b.txt, out/c.txt.\nRemove refuses while they are there; Discard deletes them.')
      expect(removal.detail).toContain('and its 2 commits stay in your repository.')
      expect(r.calls).toContain(`runWorktree remove --discard ${'b'.repeat(64)}`)
      const cancelled = rig()
      cancelled.state.launches[ID] = { ...ENDED }
      cancelled.state.answer = 'Cancel'
      expect(await cancelled.controller.removeWorktree(ID)).toMatchObject({ ok: false, cancelled: true })
      expect(cancelled.calls).not.toContain('runWorktree remove')
    })

    it('names up to 5 changes and how many more, made visible, and offers no Discard when the driver refused one (review of #446)', () => {
      const many = controllerModule.removalConfirmation({
        project: 'alpha', path: '/w/a', branch: 'agent-inbox/a-22222222', missing: false, dirty: 12, ahead: 0, upstream: false,
        examples: ['a', 'b\u202e', 'c\nMode: Read-only.', 'd', 'e'], noDiscard: null,
      })
      expect(many.detail).toContain('It has 12 uncommitted changes: a, b<U+202E>, c\\x0aMode: Read-only., d, e and 7 more.')
      expect(many.buttons).toEqual(['Remove', 'Discard 12 changes and remove', 'Cancel'])
      const nested = controllerModule.removalConfirmation({
        project: 'alpha', path: '/w/a', branch: 'agent-inbox/a-22222222', missing: false, dirty: 1, ahead: 0, upstream: false,
        examples: ['vendor/lib/'], noDiscard: 'It contains a nested git repository at vendor/lib/; move it out first.',
      })
      expect(nested.buttons).toEqual(['Remove', 'Cancel'])
      expect(nested.detail).toContain('Remove refuses while they are there. It contains a nested git repository at vendor/lib/; move it out first.')
      expect(nested.detail).not.toContain('Terminal')
    })

    it('reminds the human that a session taken over in Terminal may still work in the worktree (step 5)', async () => {
      const r = rig()
      r.state.launches[ID] = { ...ENDED, end_reason: 'handed_off' }
      expect(await r.controller.removeWorktree(ID)).toEqual({ ok: true })
      expect(((r.spawned.find((x) => x.removal)!.removal) as { detail: string }).detail)
        .toContain('Its session was taken over in Terminal: quit that Copilot first.')
    })

    it.each([
      ['a running launch', { status: 'running' }, /End the session/],
      ['a parked launch', { status: 'parked' }, /End the session/],
      ['a removed worktree', { worktree_removed_at: '2026-11-03T12:00:00.000Z' }, /no worktree/],
      ['a launch with none', { worktree_path: null }, /no worktree/],
      ['a repository that is gone', { checkout_root: '/missing/alpha' }, /not there any more/],
    ] as Array<[string, Json, RegExp]>)('refuses %s before running anything', async (_, over, error) => {
      const r = rig()
      r.state.launches[ID] = { ...ENDED, ...over }
      expect(await r.controller.removeWorktree(ID)).toEqual({ ok: false, error: expect.stringMatching(error) })
      expect(r.calls.filter((c) => c.startsWith('runWorktree') || c.startsWith('captureEnv') || c === 'ask')).toEqual([])
    })

    it('opens Terminal only at the worktree a fresh read names, while it is its own real folder', async () => {
      const r = rig()
      r.state.launches[ID] = { ...ENDED, status: 'running' }
      expect(await r.controller.openWorktree(ID)).toEqual({ ok: true })
      expect(r.calls).toContain('open -b com.apple.Terminal -- /w/alpha/fix-22222222')
      for (const over of [{ worktree_removed_at: '2026-11-03T12:00:00.000Z' }, { worktree_path: '/missing/x' }, { worktree_path: null }]) {
        const refusedRig = rig()
        refusedRig.state.launches[ID] = { ...ENDED, ...over }
        expect(await refusedRig.controller.openWorktree(ID)).toMatchObject({ ok: false })
        expect(refusedRig.calls.filter((c) => c.startsWith('open '))).toEqual([])
      }
      expect(await r.controller.openWorktree('../x')).toMatchObject({ ok: false })
    })

    // #586: Open in Terminal follows the Terminal setting, through terminal-launch.cjs
    it('opens the worktree in iTerm2 when it is chosen, and reads anything else as Terminal (#586)', async () => {
      const r = rig()
      r.state.launches[ID] = { ...ENDED, status: 'running' }
      r.state.terminal = 'iterm2'
      expect(await r.controller.openWorktree(ID)).toEqual({ ok: true })
      expect(r.calls.filter((c) => c.startsWith('open '))).toEqual(['open -b com.googlecode.iterm2 -- /w/alpha/fix-22222222'])
      for (const value of ['Hyper', 'iTerm2', 7, { x: 1 }, new Error('unreadable')]) {
        const odd = rig()
        odd.state.launches[ID] = { ...ENDED, status: 'running' }
        odd.state.terminal = value
        expect(await odd.controller.openWorktree(ID)).toEqual({ ok: true })
        expect(odd.calls.filter((c) => c.startsWith('open '))).toEqual(['open -b com.apple.Terminal -- /w/alpha/fix-22222222'])
      }
    })

    it('falls back to Terminal once when iTerm2 is missing, and says so (#586)', async () => {
      const r = rig()
      r.state.launches[ID] = { ...ENDED, status: 'running' }
      r.state.terminal = 'iterm2'
      r.state.opens = (c) => (c.args.includes('com.googlecode.iterm2') ? { ok: false, missing: true } : { ok: true })
      expect(await r.controller.openWorktree(ID)).toEqual({ ok: true, notice: 'iTerm2 could not be opened, so Terminal was opened instead.' })
      expect(r.calls.filter((c) => c.startsWith('open '))).toEqual([
        'open -b com.googlecode.iterm2 -- /w/alpha/fix-22222222', 'open -b com.apple.Terminal -- /w/alpha/fix-22222222',
      ])
    })

    it('names the app that could not be opened, and tries nothing else after a timeout (#586)', async () => {
      const plain = rig()
      plain.state.launches[ID] = { ...ENDED, status: 'running' }
      plain.state.opens = () => ({ ok: false, missing: true })
      expect(await plain.controller.openWorktree(ID)).toEqual({ ok: false, error: 'Terminal could not be opened.' })
      const both = rig()
      both.state.launches[ID] = { ...ENDED, status: 'running' }
      both.state.terminal = 'iterm2'
      both.state.opens = () => ({ ok: false, missing: true })
      expect(await both.controller.openWorktree(ID)).toEqual({ ok: false, error: 'iTerm2 and Terminal could not be opened.' })
      expect(both.calls.filter((c) => c.startsWith('open '))).toHaveLength(2)
      const slow = rig()
      slow.state.launches[ID] = { ...ENDED, status: 'running' }
      slow.state.terminal = 'iterm2'
      slow.state.opens = () => ({ ok: false, timedOut: true })
      expect(await slow.controller.openWorktree(ID)).toEqual({ ok: false, error: 'iTerm2 could not be opened.' })
      expect(slow.calls.filter((c) => c.startsWith('open '))).toEqual(['open -b com.googlecode.iterm2 -- /w/alpha/fix-22222222'])
    })

    it('names the chosen terminal only to the granted caller, and not while blocked (#586)', async () => {
      const r = rig()
      r.state.terminal = 'iterm2'
      expect(await r.controller.terminalChoice()).toBe('iterm2')
      r.state.terminal = 'Hyper'
      expect(await r.controller.terminalChoice()).toBe('terminal')
      r.state.terminal = new Error('unreadable')
      expect(await r.controller.terminalChoice()).toBe('terminal')
      r.state.enabled = false
      r.state.terminalReads = 0
      expect(await r.controller.terminalChoice()).toBeNull()
      expect(r.state.terminalReads).toBe(0)
    })

    it('does nothing with the switch off', async () => {
      const r = rig()
      r.state.enabled = false
      r.state.launches[ID] = { ...ENDED }
      expect(await r.controller.removeWorktree(ID)).toMatchObject({ ok: false })
      expect(await r.controller.openWorktree(ID)).toMatchObject({ ok: false })
      expect(r.calls).toEqual([])
    })
  })

  describe('Forget (#478)', () => {
    const ENDED = {
      id: ID, status: 'ended', end_reason: 'stopped', project: 'alpha', stream: 'agent-inbox/fix-22222222', cwd: '/w/alpha/fix-22222222',
      worktree_path: '/w/alpha/fix-22222222', checkout_root: '/work/alpha', branch: 'agent-inbox/fix-22222222',
      worktree_removed_at: '2026-11-03T12:00:00.000Z', resumable: false, revision: 7,
    }
    const forgetRig = (launch: Json | null, answer: unknown = { ok: true }) => {
      const r = rig({
        viewer: {
          getJson: async (route: string) => {
            r.calls.push(`GET ${route}`)
            return route.endsWith('/prompt') ? { prompt: 'Fix the flaky test\nthen open a PR.' } : route === `/api/launches/${ID}` ? launch : null
          },
          postJson: async (route: string, body?: unknown) => { r.calls.push(`POST ${route}`); r.posted.push([route, body]); return answer },
        },
      })
      return r
    }

    it('names the session and what goes and stays in main’s own dialog, then forgets it at the revision it showed', async () => {
      const r = forgetRig(ENDED)
      expect(await r.controller.forget(ID)).toEqual({ ok: true })
      expect(r.calls.filter((c) => !c.startsWith('keys.available'))).toEqual([
        `GET /api/launches/${ID}`, `GET /api/launches/${ID}/prompt`, 'confirm', `POST /api/launches/${ID}/forget`,
      ])
      expect(r.posted).toEqual([[`/api/launches/${ID}/forget`, { revision: 7 }]])
      expect(r.spawned[0]!.confirmation).toEqual({
        message: 'Forget the session of alpha?',
        detail: [
          'Session: alpha · agent-inbox/fix-22222222',
          'Task: Fix the flaky test',
          'Agent Inbox removes its card, its transcript and its logs. This cannot be undone.',
          'The branch agent-inbox/fix-22222222 and its commits stay in your repository.',
          'Copilot’s own session files, and what the session flagged in the inbox, are left as they are.',
        ].join('\n'),
        buttons: ['Forget', 'Cancel'],
      })
      // the owner's case: stopped with its session kept, never a worktree, so it resumes until forgotten
      const kept = forgetRig({ ...ENDED, stream: 'main', worktree_path: null, branch: null, worktree_removed_at: null, resumable: true })
      expect(await kept.controller.forget(ID)).toEqual({ ok: true })
      expect((kept.spawned[0]!.confirmation as { detail: string }).detail.split('\n')).toEqual([
        'Session: alpha · main',
        'Task: Fix the flaky test',
        'Agent Inbox removes its card, its transcript and its logs. This cannot be undone.',
        'It can no longer be resumed from Agent Inbox, but copilot --resume can still open it if you know its session id.',
        'Copilot’s own session files, and what the session flagged in the inbox, are left as they are.',
      ])
      // #479: a launch a budget ended, its other budget with no limit, is resumable too until forgotten
      const spent = forgetRig({
        ...ENDED, end_reason: 'budget:tool_calls', stream: 'main', worktree_path: null, branch: null, worktree_removed_at: null, resumable: true,
        budget_active_ms: null, budget_tool_calls: 500, active_ms: 600_000, tool_calls: 500,
      })
      expect(await spent.controller.forget(ID)).toEqual({ ok: true })
      expect((spent.spawned[0]!.confirmation as { detail: string }).detail).toContain('It can no longer be resumed from Agent Inbox')
      // a session in its folder, resumable or handed off, with hostile text made visible on one line
      const text = controllerModule.forgetConfirmation({
        project: 'alpha\nMode: Read-only.', branch: null, stream: 'main', task: 'Do it\u202e', endReason: 'handed_off', resumable: true,
      })
      expect(text.detail.split('\n').slice(0, 2)).toEqual(['Session: alpha\\x0aMode: Read-only. · main', 'Task: Do it<U+202E>'])
      expect(text.detail).toContain('The Copilot it was handed off to in Terminal is not touched.')
      expect(text.detail).toContain('It can no longer be resumed from Agent Inbox, but copilot --resume can still open it if you know its session id.')
      expect(text.detail).not.toContain('branch')
    })

    it.each([
      ['a running launch', { status: 'running' }, /Stop the session before/],
      ['a parked launch', { status: 'parked' }, /End the session before/],
      ['a kept worktree', { worktree_removed_at: null }, /Remove worktree… first/],
      ['a launch that is gone', null, /not there any more/],
    ] as Array<[string, Json | null, RegExp]>)('refuses %s before the dialog', async (_, over, error) => {
      const r = forgetRig(over === null ? null : { ...ENDED, ...over })
      expect(await r.controller.forget(ID)).toEqual({ ok: false, error: expect.stringMatching(error) })
      expect(r.calls).not.toContain('confirm')
      expect(r.posted).toEqual([])
    })

    it('forgets nothing on Cancel, off, or a bad id, and says why the hub refused', async () => {
      const cancelled = forgetRig({ ...ENDED, worktree_path: null, branch: null })
      cancelled.state.confirm = false
      expect(await cancelled.controller.forget(ID)).toEqual({ ok: false, error: 'Not forgotten.', cancelled: true })
      expect(cancelled.posted).toEqual([])
      const off = forgetRig(ENDED)
      off.state.enabled = false
      expect(await off.controller.forget(ID)).toMatchObject({ ok: false })
      expect(await off.controller.forget('../x')).toMatchObject({ ok: false })
      expect(off.calls).toEqual([])
      const stale = forgetRig(ENDED, { ok: false, reason: 'revision' })
      expect(await stale.controller.forget(ID)).toEqual({ ok: false, error: expect.stringMatching(/changed since you confirmed/) })
      const unanswered = forgetRig(ENDED, null)
      expect(await unanswered.controller.forget(ID)).toEqual({ ok: false, error: 'The session was not forgotten.' })
    })
  })

  it('sends the human’s cap on sessions at once in every spec, 4 by default, and keeps it to 1 to 8 (§5)', async () => {
    const r = rig()
    expect(await r.controller.start(REQUEST)).toEqual({ ok: true, launch: ID })
    expect(parseLaunchSpec(JSON.stringify(r.spawned.at(-1)!.spec), ID)).toMatchObject({ ok: true, spec: { maxDrivers: 4 } })
    expect(await r.controller.maxSessions()).toBe(4)
    expect(await r.controller.setMaxSessions(6)).toEqual({ ok: true, maxSessions: 6 })
    for (const bad of [0, 9, 1.5, '6']) expect(await r.controller.setMaxSessions(bad)).toMatchObject({ ok: false })
    expect(await r.controller.maxSessions()).toBe(6)
    r.state.launches[ID] = { id: ID, status: 'parked', cwd: '/work/alpha' }
    expect(await r.controller.resume(ID)).toEqual({ ok: true, launch: ID })
    expect(parseLaunchSpec(JSON.stringify(r.spawned.at(-1)!.spec), ID)).toMatchObject({ ok: true, spec: { kind: 'resume', maxDrivers: 6 } })
  })

  it('reports each start phase to the page and logs how long each took, and none while off or cancelled (#432 PR 5)', async () => {
    const phases: string[] = []
    const lines: string[] = []
    const r = rig({
      progress: (phase: string, launch: string, startId?: string) => { phases.push(`${phase} ${launch} ${startId}`) },
      log: (line: string) => { lines.push(line) },
      startDriver: async (args: { launchId: string; spec: Json; onPhase: (phase: string) => void }) => {
        expect(args.spec).not.toHaveProperty('startId')
        args.onPhase('worktree')
        args.onPhase('copilot')
        return { ok: true, launch: args.launchId }
      },
    })
    // the page's tag for the start comes back with each phase, and never reaches the spec
    expect(await r.controller.start({ ...REQUEST, startId: 'tag-0123456789abcdef' })).toEqual({ ok: true, launch: ID })
    expect(phases).toEqual(['environment', 'runtime', 'worktree', 'copilot'].map((phase) => `${phase} ${ID} tag-0123456789abcdef`))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^launch 22222222 started: environment \d+ ms, runtime \d+ ms, driver \d+ ms, worktree \d+ ms, copilot \d+ ms$/)
    const quiet: string[] = []
    const cancelled = rig({ progress: (phase: string) => { quiet.push(phase) } })
    cancelled.state.confirm = false
    expect(await cancelled.controller.start(REQUEST)).toMatchObject({ ok: false, cancelled: true })
    const off = rig({ progress: (phase: string) => { quiet.push(phase) } })
    off.state.enabled = false
    expect(await off.controller.start(REQUEST)).toMatchObject({ ok: false })
    expect(quiet).toEqual([])
  })

  it('names the branch when a parked session’s worktree is gone', async () => {
    const r = rig()
    r.state.launches[ID] = { id: ID, status: 'parked', cwd: '/missing/alpha/fix-22222222', branch: 'agent-inbox/fix-22222222' }
    expect(await r.controller.resume(ID)).toEqual({
      ok: false, error: 'The session’s folder does not exist any more. Its branch agent-inbox/fix-22222222 is still in your repository.',
    })
  })

  it('chooses the worktree folder through main’s own dialog, keeps only a private real folder, and resets to the default', async () => {
    const r = worktreeRig()
    expect(await r.controller.worktreeRoot()).toEqual({ path: join(r.hub, 'worktrees'), isDefault: true })
    r.state.chosenRoot = join(r.dir, 'trees')
    mkdirSync(r.state.chosenRoot, { mode: 0o700 })
    expect(await r.controller.chooseWorktreeRoot()).toEqual({ ok: true, worktreeRoot: { path: join(r.dir, 'trees'), isDefault: false } })
    expect(await r.controller.worktreeRoot()).toEqual({ path: join(r.dir, 'trees'), isDefault: false })
    mkdirSync(join(r.dir, 'open'))
    chmodSync(join(r.dir, 'open'), 0o777)
    r.state.chosenRoot = join(r.dir, 'open')
    expect(await r.controller.chooseWorktreeRoot()).toMatchObject({ ok: false, error: expect.stringMatching(/others can write/) })
    expect(r.state.worktreeRoot).toBe(join(r.dir, 'trees'))
    expect(await r.controller.resetWorktreeRoot()).toEqual({ ok: true, worktreeRoot: { path: join(r.hub, 'worktrees'), isDefault: true } })
    expect(r.state.worktreeRoot).toBeNull()
  })

  it('derives the slug and repository folder from the task and project, never from a path the renderer sent', () => {
    const { planWorktree, worktreeSlug, worktreeRepoName } = sessionWorktree
    expect(worktreeSlug('Fix the failing test.\nThen more.')).toBe('fix-the-failing-test')
    expect(worktreeSlug('\n\n  Café – naïve résumé  ')).toBe('caf-na-ve-r-sum')
    expect(worktreeSlug('日本語のタスク')).toBe('session')
    expect(worktreeSlug('')).toBe('session')
    expect(worktreeSlug('one two three four five six seven eight nine')).toBe('one-two-three-four-five-six')
    expect(worktreeSlug('x'.repeat(40))).toBe('x'.repeat(32))
    expect(worktreeRepoName('agent-inbox', '/w/x')).toBe('agent-inbox')
    expect(worktreeRepoName('@sessions', '/w/my-app')).toBe('my-app')
    expect(worktreeRepoName('a b', '/w/..')).toBe('repo')
    const plan = planWorktree({ root: '/r', project: 'alpha', folder: '/w/alpha', task: 'Fix it', launchId: ID })
    expect(plan).toEqual({ path: '/r/alpha/fix-it-22222222', branch: 'agent-inbox/fix-it-22222222' })
    expect(parseLaunchSpec(JSON.stringify({
      v: 1, kind: 'new', launchId: ID, host: 'copilot', cwd: '/w/alpha', mode: 'ask', budgets: { activeMs: 60_000, toolCalls: 1 }, prompt: 'x', env: {},
      launchKey: Buffer.alloc(32).toString('base64'), worktree: planWorktree({ root: '/r', project: '日本', folder: '/w/日本', task: '日本語', launchId: ID }),
    }), ID)).toMatchObject({ ok: true, spec: { worktree: { path: '/r/repo/session-22222222', branch: 'agent-inbox/session-22222222' } } })
  })
})

describe('Take over in Terminal (step 5, §3.5)', () => {
  const SESSION = 'ab72df37-a3ee-4716-bcb8-f0f1955c8fd8'
  const RUNNING = { id: ID, status: 'running', project: 'alpha', cwd: '/work/alpha', driver: 'running', stop_requested_at: null, resumable: false }
  const HANDED = { ok: true, state: 'handed_off', session: SESSION, cwd: '/work/alpha', model: 'claude-haiku-4.5', effort: 'none' }

  // the hub as main reaches it: the launch row, and the hand-off route answering in turn
  function takeOverRig(launch: Json, answers: unknown[], over: Json = {}) {
    const scripts: Array<[string, string]> = []
    const queue = [...answers]
    // a read that is an Error throws, as a hub restart mid-poll would
    const reads: Array<Json | Error> = []
    // what each withdrawal answers, { ok: true } once these run out
    const withdrawals: unknown[] = []
    const held: { r?: ReturnType<typeof rig> } = {}
    const log = (line: string) => held.r!.calls.push(line)
    const r = rig({
      viewer: {
        getJson: async (route: string) => {
          log(`GET ${route}`)
          const next = reads.shift() ?? launch
          if (next instanceof Error) throw next
          return next
        },
        postJson: async (route: string) => {
          log(`POST ${route}`)
          if (route.endsWith('/withdraw')) return withdrawals.length ? withdrawals.shift() : { ok: true }
          return queue.shift() ?? null
        },
      },
      writeScript: async (file: string, text: string) => { log(`writeScript ${file}`); scripts.push([file, text]); return true },
      terminal: {
        read: async () => { held.r!.state.terminalReads += 1; if (held.r!.state.terminal instanceof Error) throw held.r!.state.terminal; return held.r!.state.terminal },
        run: async (command: { args: string[] }) => { log(`open ${command.args.join(' ')}`); return held.r!.state.opens?.(command) ?? { ok: true } },
      },
      confirm: async (text: Json) => { log('confirm'); held.r!.spawned.push({ confirmation: text }); return held.r!.state.confirm },
      wait: async () => {},
      ...over,
    })
    held.r = r
    return { ...r, scripts, reads, withdrawals }
  }

  it('asks a running launch’s driver to hand off, waits for it, then opens Terminal on copilot --resume in its folder', async () => {
    const t = takeOverRig(RUNNING, [{ ok: true, state: 'requested' }, HANDED])
    t.reads.push(RUNNING, RUNNING, { ...RUNNING, driver: 'running' }, { ...RUNNING, status: 'ended', end_reason: 'handed_off' })
    expect(await t.controller.takeOver(ID)).toEqual({ ok: true })
    const script = `/hub/launches/${ID}/take-over.command`
    expect(t.calls.filter((c) => !c.startsWith('keys.available'))).toEqual([
      `GET /api/launches/${ID}`, 'confirm', `POST /api/launches/${ID}/hand-off`,
      `GET /api/launches/${ID}`, `GET /api/launches/${ID}`, `GET /api/launches/${ID}`,
      `POST /api/launches/${ID}/hand-off`, `writeScript ${script}`, `open -b com.apple.Terminal -- ${script}`,
    ])
    const confirmation = t.spawned[0]!.confirmation as { message: string; detail: string; buttons: string[] }
    expect(confirmation.message).toBe('Take over the session of alpha in Terminal?')
    expect(confirmation.buttons).toEqual(['Take over', 'Cancel'])
    expect(confirmation.detail).toContain('its current turn and any approval it waits on are cancelled')
    expect(confirmation.detail).toContain('does not resume it, push messages to it or approve for it again')
    expect(t.scripts[0]![1]).toBe([
      '#!/bin/sh',
      '# Agent Inbox: Take over in Terminal (launch 22222222)',
      "cd -- '/work/alpha' || exit 1",
      `'copilot' '--resume=${SESSION}' '--model' 'claude-haiku-4.5' '--reasoning-effort' 'none'`,
      'exec "${SHELL:-/bin/sh}" -l',
      '',
    ].join('\n'))
  })

  it('hands a stopped launch with its session off like a parked one (step 5, full resume)', async () => {
    const t = takeOverRig({ ...RUNNING, status: 'ended', end_reason: 'stopped', driver: null, resumable: true }, [HANDED])
    expect(await t.controller.takeOver(ID)).toEqual({ ok: true })
    const text = t.spawned[0]!.confirmation as { message: string; detail: string }
    expect(text.message).toBe('Take over the session of alpha in Terminal?')
    expect(text.detail).not.toContain('current turn')
    const none = takeOverRig({ ...RUNNING, status: 'ended', end_reason: 'stopped', driver: null, resumable: false }, [HANDED])
    expect(await none.controller.takeOver(ID)).toEqual({ ok: false, error: 'This session has ended.' })
  })

  it('hands a parked launch off at once, and opens Terminal again on one already handed off', async () => {
    const parked = takeOverRig({ ...RUNNING, status: 'parked', driver: null, resumable: true }, [HANDED])
    expect(await parked.controller.takeOver(ID)).toEqual({ ok: true })
    expect(parked.calls.filter((c) => c.startsWith('POST'))).toEqual([`POST /api/launches/${ID}/hand-off`])
    expect((parked.spawned[0]!.confirmation as Json).detail).not.toContain('current turn')
    const again = takeOverRig({ ...RUNNING, status: 'ended', end_reason: 'handed_off', driver: null }, [HANDED])
    expect(await again.controller.takeOver(ID)).toEqual({ ok: true })
    const text = again.spawned[0]!.confirmation as { message: string; detail: string; buttons: string[] }
    expect(text.message).toBe('Open Terminal on the session of alpha again?')
    expect(text.buttons).toEqual(['Open Terminal', 'Cancel'])
    expect(text.detail).toContain('two Copilots must never work in one session')
  })

  it.each([
    ['a stopping launch', { stop_requested_at: '2026-11-03T12:00:00.000Z' }, /stopping/],
    ['a launch whose driver is not responding', { driver: 'lost' }, /Close it instead/],
    ['a parked launch never prompted', { status: 'parked', driver: null, resumable: false }, /never started its task/],
    ['an ended launch', { status: 'ended', end_reason: 'stopped', driver: null }, /has ended/],
    ['a folder that is gone', { cwd: '/missing/alpha', branch: 'agent-inbox/fix-22222222' }, /Its branch agent-inbox\/fix-22222222 is still/],
    ['a folder with a control character', { cwd: '/work/al\npha' }, /does not exist any more/],
  ] as Array<[string, Json, RegExp]>)('refuses %s before asking or handing anything off', async (_, over, error) => {
    const t = takeOverRig({ ...RUNNING, ...over }, [HANDED])
    expect(await t.controller.takeOver(ID)).toEqual({ ok: false, error: expect.stringMatching(error) })
    expect(t.calls.filter((c) => c === 'confirm' || c.startsWith('POST') || c.startsWith('open '))).toEqual([])
  })

  // #586: Take over / Resume in Terminal follow the Terminal setting
  it('takes over in iTerm2 when it is chosen, naming it in main’s own confirmation (#586)', async () => {
    const t = takeOverRig(RUNNING, [{ ok: true, state: 'requested' }, HANDED])
    t.state.terminal = 'iterm2'
    t.reads.push(RUNNING, RUNNING, { ...RUNNING, driver: 'running' }, { ...RUNNING, status: 'ended', end_reason: 'handed_off' })
    expect(await t.controller.takeOver(ID)).toEqual({ ok: true })
    const text = t.spawned[0]!.confirmation as { message: string; detail: string; buttons: string[] }
    expect(text.message).toBe('Take over the session of alpha in iTerm2?')
    expect(text.buttons).toEqual(['Take over', 'Cancel'])
    expect(text.detail).toContain('iTerm2 then runs copilot --resume there')
    expect(text.detail).toContain('you answer it in iTerm2')
    expect(text.detail).toContain('iTerm2 may first ask whether to run the script')
    expect(t.calls.at(-1)).toBe(`open -b com.googlecode.iterm2 -- /hub/launches/${ID}/take-over.command`)
    // the script itself does not change with the terminal
    expect(t.scripts[0]![1]).toContain(`'copilot' '--resume=${SESSION}'`)
  })

  it('names iTerm2 when it opens a handed-off session again (#586)', async () => {
    const t = takeOverRig({ ...RUNNING, status: 'ended', end_reason: 'handed_off', driver: null }, [HANDED])
    t.state.terminal = 'iterm2'
    expect(await t.controller.takeOver(ID)).toEqual({ ok: true })
    const text = t.spawned[0]!.confirmation as { message: string; detail: string; buttons: string[] }
    expect(text.message).toBe('Open iTerm2 on the session of alpha again?')
    expect(text.buttons).toEqual(['Open iTerm2', 'Cancel'])
    expect(text.detail).toContain('If it is still open in another iTerm2 window')
    expect(text.detail).toContain('iTerm2 may first ask whether to run the script')
  })

  it('reads the choice once, so the dialog and the open name the same terminal (#586)', async () => {
    const answers = ['iterm2', 'terminal']
    const t = takeOverRig({ ...RUNNING, status: 'parked', driver: null, resumable: true }, [HANDED], {
      terminal: {
        read: async () => { t.state.terminalReads += 1; return answers.shift() },
        run: async (command: { args: string[] }) => { t.calls.push(`open ${command.args.join(' ')}`); return { ok: true } },
      },
    })
    expect(await t.controller.takeOver(ID)).toEqual({ ok: true })
    expect((t.spawned[0]!.confirmation as Json).message).toBe('Take over the session of alpha in iTerm2?')
    expect(t.calls.at(-1)).toBe(`open -b com.googlecode.iterm2 -- /hub/launches/${ID}/take-over.command`)
    expect(t.state.terminalReads).toBe(1)
  })

  it('reads a hand-edited or unreadable terminal value as Terminal, in the dialog and the open (#586)', async () => {
    for (const value of ['Hyper', new Error('unreadable')]) {
      const t = takeOverRig({ ...RUNNING, status: 'parked', driver: null, resumable: true }, [HANDED])
      t.state.terminal = value
      expect(await t.controller.takeOver(ID)).toEqual({ ok: true })
      expect((t.spawned[0]!.confirmation as Json).message).toBe('Take over the session of alpha in Terminal?')
      expect(t.calls.at(-1)).toBe(`open -b com.apple.Terminal -- /hub/launches/${ID}/take-over.command`)
    }
  })

  it('falls back to Terminal once when iTerm2 is missing, and says so (#586)', async () => {
    const t = takeOverRig({ ...RUNNING, status: 'parked', driver: null, resumable: true }, [HANDED])
    t.state.terminal = 'iterm2'
    t.state.opens = (c) => (c.args.includes('com.googlecode.iterm2') ? { ok: false, missing: true } : { ok: true })
    expect(await t.controller.takeOver(ID)).toEqual({ ok: true, notice: 'iTerm2 could not be opened, so Terminal was opened instead.' })
    expect(t.calls.filter((c) => c.startsWith('open '))).toEqual([
      `open -b com.googlecode.iterm2 -- /hub/launches/${ID}/take-over.command`, `open -b com.apple.Terminal -- /hub/launches/${ID}/take-over.command`,
    ])
  })

  it('never opens the script twice: a timeout is reported, not retried in Terminal (#586)', async () => {
    const t = takeOverRig({ ...RUNNING, status: 'parked', driver: null, resumable: true }, [HANDED])
    t.state.terminal = 'iterm2'
    t.state.opens = () => ({ ok: false, timedOut: true })
    expect(await t.controller.takeOver(ID)).toEqual({ ok: false, error: 'The session is handed off, but iTerm2 could not be opened. Try Resume in Terminal.' })
    expect(t.calls.filter((c) => c.startsWith('open '))).toEqual([`open -b com.googlecode.iterm2 -- /hub/launches/${ID}/take-over.command`])
  })

  it('names the app when nothing opens (#586)', async () => {
    const plain = takeOverRig({ ...RUNNING, status: 'parked', driver: null, resumable: true }, [HANDED])
    plain.state.opens = () => ({ ok: false, missing: true })
    expect(await plain.controller.takeOver(ID)).toEqual({ ok: false, error: 'The session is handed off, but Terminal could not be opened. Try Resume in Terminal.' })
    const both = takeOverRig({ ...RUNNING, status: 'parked', driver: null, resumable: true }, [HANDED])
    both.state.terminal = 'iterm2'
    both.state.opens = () => ({ ok: false, missing: true })
    expect(await both.controller.takeOver(ID)).toEqual({ ok: false, error: 'The session is handed off, but iTerm2 and Terminal could not be opened. Try Resume in Terminal.' })
  })

  it('hands nothing off when the human cancels, or with the switch off, or for a bad id', async () => {
    const t = takeOverRig(RUNNING, [HANDED])
    t.state.confirm = false
    expect(await t.controller.takeOver(ID)).toEqual({ ok: false, error: 'Not taken over.', cancelled: true })
    expect(t.calls.filter((c) => c.startsWith('POST'))).toEqual([])
    const off = takeOverRig(RUNNING, [HANDED])
    off.state.enabled = false
    expect(await off.controller.takeOver(ID)).toMatchObject({ ok: false })
    expect(await off.controller.takeOver('../x')).toMatchObject({ ok: false })
    expect(off.calls).toEqual([])
  })

  // review of #450: the flow ends in exactly one of Terminal opened, or no request of its own left behind
  const posts = (t: { calls: string[] }) => t.calls.filter((c) => c.startsWith('POST')).map((c) => c.slice(`POST /api/launches/${ID}`.length))
  const ENDED_HANDED = { ...RUNNING, status: 'ended', end_reason: 'handed_off', driver: null }

  it('withdraws its request when the hub fails mid-poll, so no driver hands off later without a Terminal', async () => {
    const t = takeOverRig(RUNNING, [{ ok: true, state: 'requested' }])
    t.reads.push(RUNNING, RUNNING, new Error('ECONNREFUSED'))
    expect(await t.controller.takeOver(ID)).toEqual({ ok: false, error: 'The session could not be handed off.' })
    expect(posts(t)).toEqual(['/hand-off', '/hand-off/withdraw'])
    expect(t.calls.filter((c) => c.startsWith('open '))).toEqual([])
    // an unreadable row is not proof it stopped running: it waits out the deadline, then withdraws
    let clock = 0
    const blind = takeOverRig(RUNNING, [{ ok: true, state: 'requested' }], { wait: async () => { clock += 30_000 }, handOffWaitMs: 60_000 })
    blind.reads.push(RUNNING, null as unknown as Json, null as unknown as Json)
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    expect(await blind.controller.takeOver(ID)).toMatchObject({ ok: false, error: expect.stringMatching(/within a minute/) })
    expect(posts(blind)).toEqual(['/hand-off', '/hand-off/withdraw'])
    // a hand-off POST with no answer (a timeout) may have stored its request: it is withdrawn on the way out
    const silent = takeOverRig(RUNNING, [null])
    expect(await silent.controller.takeOver(ID)).toEqual({ ok: false, error: 'The session could not be handed off.' })
    expect(posts(silent)).toEqual(['/hand-off', '/hand-off/withdraw'])
    // a definite refusal leaves nothing to withdraw
    const refusedRig = takeOverRig(RUNNING, [{ ok: false, reason: 'stopping' }])
    expect(await refusedRig.controller.takeOver(ID)).toMatchObject({ ok: false })
    expect(posts(refusedRig)).toEqual(['/hand-off'])
    // a withdrawal the hub does not answer is tried once more on the way out
    const deaf = takeOverRig(RUNNING, [{ ok: true, state: 'requested' }], { wait: async () => { clock += 30_000 }, handOffWaitMs: 60_000 })
    deaf.withdrawals.push(null)
    expect(await deaf.controller.takeOver(ID)).toMatchObject({ ok: false })
    expect(posts(deaf)).toEqual(['/hand-off', '/hand-off/withdraw', '/hand-off/withdraw'])
  })

  it('a withdrawal that loses to the driver completes the hand-off and opens Terminal', async () => {
    let clock = 0
    const t = takeOverRig(RUNNING, [{ ok: true, state: 'requested' }, HANDED], { wait: async () => { clock += 30_000 }, handOffWaitMs: 60_000 })
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    // still running at the deadline; the driver took the request just before the withdrawal, then ended handed off
    t.reads.push(RUNNING, RUNNING, RUNNING, RUNNING, ENDED_HANDED)
    t.withdrawals.push({ ok: false })
    expect(await t.controller.takeOver(ID)).toEqual({ ok: true })
    expect(posts(t)).toEqual(['/hand-off', '/hand-off/withdraw', '/hand-off'])
    expect(t.calls.at(-1)).toBe(`open -b com.apple.Terminal -- /hub/launches/${ID}/take-over.command`)
    // if it is still running after a second minute, it says to use Resume in Terminal once it has
    const slow = takeOverRig(RUNNING, [{ ok: true, state: 'requested' }], { wait: async () => { clock += 30_000 }, handOffWaitMs: 60_000 })
    slow.withdrawals.push({ ok: false })
    expect(await slow.controller.takeOver(ID)).toEqual({ ok: false, error: expect.stringMatching(/still handing off.*Resume in Terminal/) })
    // the driver holds the request: there is nothing of ours to withdraw again
    expect(posts(slow)).toEqual(['/hand-off', '/hand-off/withdraw'])
  })

  it('a Resume during the re-post never leaves a request behind: withdrawn, or completed when a driver took it', async () => {
    // the launch left running (parked), then a Resume ran it again before the second post
    const t = takeOverRig(RUNNING, [{ ok: true, state: 'requested' }, { ok: true, state: 'requested' }])
    t.reads.push(RUNNING, { ...RUNNING, status: 'parked', driver: null, resumable: true })
    expect(await t.controller.takeOver(ID)).toEqual({ ok: false, error: expect.stringMatching(/resumed meanwhile/) })
    expect(posts(t)).toEqual(['/hand-off', '/hand-off', '/hand-off/withdraw'])
    expect(t.calls.filter((c) => c.startsWith('open '))).toEqual([])
    // the resumed launch's driver took that second request first: it hands off, and Terminal opens
    const raced = takeOverRig(RUNNING, [{ ok: true, state: 'requested' }, { ok: true, state: 'requested' }, HANDED])
    raced.reads.push(RUNNING, { ...RUNNING, status: 'parked', driver: null, resumable: true }, RUNNING, ENDED_HANDED)
    raced.withdrawals.push({ ok: false })
    expect(await raced.controller.takeOver(ID)).toEqual({ ok: true })
    expect(posts(raced)).toEqual(['/hand-off', '/hand-off', '/hand-off/withdraw', '/hand-off'])
    expect(raced.calls.at(-1)).toBe(`open -b com.apple.Terminal -- /hub/launches/${ID}/take-over.command`)
  })

  it('withdraws a request the driver did not take in time, and opens nothing for an answer it cannot trust', async () => {
    let clock = 0
    const slow = takeOverRig(RUNNING, [{ ok: true, state: 'requested' }], { wait: async () => { clock += 30_000 }, handOffWaitMs: 60_000 })
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    expect(await slow.controller.takeOver(ID)).toEqual({ ok: false, error: expect.stringMatching(/did not hand off within a minute/) })
    expect(slow.calls.filter((c) => c.startsWith('POST'))).toEqual([`POST /api/launches/${ID}/hand-off`, `POST /api/launches/${ID}/hand-off/withdraw`])
    vi.restoreAllMocks()
    for (const answer of [
      { ...HANDED, session: 'not-a-session; rm -rf ~' }, { ...HANDED, session: SESSION.toUpperCase() }, { ...HANDED, cwd: '/elsewhere' },
      { ...HANDED, cwd: '/missing/alpha' },
      { ok: false, reason: 'ended' }, null,
    ]) {
      const t = takeOverRig({ ...RUNNING, status: 'parked', driver: null, resumable: true }, [answer])
      expect(await t.controller.takeOver(ID)).toMatchObject({ ok: false })
      expect(t.calls.filter((c) => c.startsWith('writeScript') || c.startsWith('open '))).toEqual([])
    }
    // a model or effort that is not one of their own is left out, never quoted in
    const odd = takeOverRig({ ...RUNNING, status: 'parked', driver: null, resumable: true }, [{ ...HANDED, model: "x' && y", effort: 'turbo' }])
    expect(await odd.controller.takeOver(ID)).toEqual({ ok: true })
    expect(odd.scripts[0]![1]).toContain(`'copilot' '--resume=${SESSION}'\n`)
  })

  it('the script runs copilot --resume in the folder, with nothing in the folder’s name expanded', () => {
    const dir = scratchDir('take-over-')
    const folder = join(dir, "it's $(touch pwned) `x` here")
    mkdirSync(folder)
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'copilot'), '#!/bin/sh\nprintf "%s\\n" "$PWD" "$@" > "$OUT"\n')
    chmodSync(join(bin, 'copilot'), 0o755)
    const script = controllerModule.takeOverScript({ launchId: ID, folder, session: SESSION, model: null, reasoningEffort: null })!
    const file = join(dir, 'take-over.command')
    writeFileSync(file, script, { mode: 0o700 })
    const out = join(dir, 'out.txt')
    execFileSync('/bin/sh', [file], { env: { PATH: `${bin}:/usr/bin:/bin`, OUT: out, SHELL: '/usr/bin/true' }, cwd: dir })
    expect(readFileSync(out, 'utf8').split('\n').slice(0, 2)).toEqual([folder, `--resume=${SESSION}`])
    expect(existsSync(join(dir, 'pwned'))).toBe(false)
    expect(existsSync(join(folder, 'pwned'))).toBe(false)
    // anything unchecked refuses instead
    expect(controllerModule.takeOverScript({ launchId: ID, folder: 'relative', session: SESSION })).toBeNull()
    expect(controllerModule.takeOverScript({ launchId: ID, folder: '/a\nb', session: SESSION })).toBeNull()
    expect(controllerModule.takeOverScript({ launchId: ID, folder: '/a', session: '--help' })).toBeNull()
    expect(controllerModule.takeOverScript({ launchId: ID, folder: '/a', session: SESSION, model: 'a b' })).toBeNull()
  })
})

// #586 phase 2, PR 5: Continue here… on a Copilot CLI chat (design §3.2–§3.7). The chat comes
// from the viewer's one-chat route, never the page; every refusal spawns nothing. Fixtures are synthetic.
const CHAT = '00000000-0000-4000-8000-0000000000c1'
const CHAT2 = '00000000-0000-4000-8000-0000000000c2'
const HOME = '/Users/tester'
const CHAT_FOLDER = '/Users/tester/dev/alpha'
const OLD_DRIVER = 'launch spec: kind must be new or resume'
const CONTINUE = { tool: 'copilot', id: CHAT, mode: 'ask', prompt: 'Carry on with the parser tests.', startId: 'tag-0123456789abcdef' }

function chatEntry(over: Json = {}): Json {
  return {
    id: CHAT, tool: 'copilot', title: 'Fix the parser', titleAuto: false, project: 'alpha', cwd: CHAT_FOLDER, branch: 'main',
    createdAt: '2026-11-14T10:00:00.000Z', lastActiveAt: '2026-11-14T11:00:00.000Z', live: false, pr: null, hidden: [], ...over,
  }
}

// the controller rig, with the one-chat route, the whole chat list and the launch list answered from `chat`
function chatRig(over: Json = {}) {
  const chat = {
    lookup: { chat: chatEntry(), launch: null } as unknown,
    list: { chats: [chatEntry()] } as unknown,
    launches: [] as unknown,
    env: { ok: true, env: { PATH: '/opt/bin:/usr/bin', HOME, SECRET: 's', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--x', COPILOT_ALLOW_ALL: '1', TMUX: '/tmp/tmux-test/default,1,0', TMUX_PANE: '%3' } } as Json,
    repository: true,
  }
  const r: ReturnType<typeof rig> = rig({
    homeDir: HOME,
    inRepository: (folder: string) => { r.calls.push(`inRepository ${folder}`); return chat.repository },
    captureEnv: async (cwd: string) => { r.calls.push(`captureEnv ${cwd}`); return chat.env },
    ...over,
  })
  r.deps.viewer.getJson = async (route: string) => {
    r.calls.push(`GET ${route}`)
    if (route === `/api/chats/copilot/${CHAT}`) return chat.lookup
    if (route === '/api/chats?all=1') return chat.list
    if (route === '/api/launches') return chat.launches
    if (route.startsWith('/api/launches/')) return r.state.launches[route.slice('/api/launches/'.length)] ?? null
    return null
  }
  const steps = () => r.calls.filter((c) => c !== 'keys.available')
  return { ...r, chat, steps }
}

const LOOKUP = `GET /api/chats/copilot/${CHAT}`
const confirmationOf = (r: { spawned: Json[] }) => r.spawned.find((s) => s.confirmation)!.confirmation as { message: string; detail: string; buttons: string[] }

describe('Continue a chat (#586 phase 2)', () => {
  it('reads the chat through the one-chat route, confirms natively, and sends exactly the chat spec it showed', async () => {
    const r = chatRig()
    expect(await r.controller.continueChat(CONTINUE)).toEqual({ ok: true, launch: ID })
    // no shell before the human confirmed, and the runtime verified again right before the spawn
    expect(r.steps()).toEqual([
      LOOKUP, 'GET /api/launches', 'driverRuntime', 'GET /api/chats?all=1', `inRepository ${CHAT_FOLDER}`, 'confirm',
      `captureEnv ${CHAT_FOLDER}`, 'keys.launchKey', 'driverRuntime', 'startDriver',
    ])
    const args = r.spawned.at(-1)!
    expect(args).toMatchObject({ launchId: ID, hubPath: '/hub/inbox.db', logPath: `/hub/launches/${ID}/driver.log` })
    expect(args).not.toHaveProperty('timeoutMs')
    const spec = args.spec as Json
    expect(Object.keys(spec).sort()).toEqual(['chatId', 'cwd', 'env', 'host', 'kind', 'launchId', 'launchKey', 'maxDrivers', 'mode', 'prompt', 'v'])
    expect(spec).toMatchObject({ v: 1, kind: 'chat', launchId: ID, host: 'copilot', chatId: CHAT, cwd: CHAT_FOLDER, mode: 'ask', prompt: CONTINUE.prompt, maxDrivers: 4 })
    // the env through the denylist; the start tag never reaches the spec
    expect(spec.env).toEqual({ PATH: '/opt/bin:/usr/bin', HOME, SECRET: 's' })
    expect(JSON.stringify(spec)).not.toContain('tag-0123456789abcdef')
    // the driver of this build parses it
    const parsed = parseLaunchSpec(JSON.stringify(spec), ID)
    expect(parsed).toMatchObject({ ok: true, spec: { kind: 'chat', chatId: CHAT, cwd: CHAT_FOLDER, mode: 'ask' } })
    expect(confirmationOf(r).buttons).toEqual(['Continue', 'Cancel'])
  })

  it('takes the folder, title and project from the route’s answer, the folder resolved now; a read-only chat says so', async () => {
    const r = chatRig({ realDirectory: (folder: string) => (folder === CHAT_FOLDER ? '/Volumes/Work/alpha' : folder) })
    r.chat.lookup = { chat: chatEntry({ title: 'Route title', project: 'route-project' }), launch: null }
    expect(await r.controller.continueChat({ ...CONTINUE, mode: 'read-only' })).toEqual({ ok: true, launch: ID })
    const spec = r.spawned.at(-1)!.spec as Json
    expect(spec).toMatchObject({ cwd: '/Volumes/Work/alpha', mode: 'read-only' })
    expect(r.calls).toContain('captureEnv /Volumes/Work/alpha')
    const text = confirmationOf(r)
    expect(text.message).toBe('Continue this Copilot chat in route-project?')
    expect(text.detail.split('\n').slice(0, 2)).toEqual(['Chat: Route title (00000000)', 'Folder: /Volumes/Work/alpha'])
    expect(text.detail).toContain(`Mode: Read-only. ${controllerModule.MODES['read-only']!.copy}`)
  })

  it.each([
    ['a folder', { cwd: '/etc' }],
    ['a root', { root: '/work/alpha' }],
    ['an executable', { command: '/bin/sh' }],
    ['argv', { args: ['--yolo'] }],
    ['an env', { env: { PATH: '/evil', COPILOT_HOME: '/evil' } }],
    ['a title', { title: 'Folder: /etc' }],
    ['a project', { project: 'alpha' }],
    ['a worktree', { worktree: true }],
    ['a model', { model: 'gpt-5' }],
    ['budgets', { budgets: { activeMs: null, toolCalls: null } }],
    ['a launch id', { launchId: ID }],
    ['an uppercase id', { id: CHAT.toUpperCase() }],
    ['an id with more after it', { id: `${CHAT}/../x` }],
    ['the Plan first mode', { mode: 'plan' }],
    ['the Edits mode', { mode: 'edits' }],
    ['an empty message', { prompt: '  \n ' }],
    ['a message over 65,536 characters', { prompt: 'x'.repeat(65_537) }],
    ['a start tag with a path in it', { startId: '/Users/tester/../x' }],
    ['no message', { prompt: undefined }],
  ])('refuses a request carrying %s before anything is read', async (_, change) => {
    const r = chatRig()
    const request: Json = { ...CONTINUE, ...change }
    for (const [key, value] of Object.entries(change)) if (value === undefined) delete request[key]
    expect(await r.controller.continueChat(request)).toEqual({ ok: false, reason: 'invalid', error: 'This chat can’t be continued here.' })
    expect(r.steps()).toEqual([])
  })

  it('refuses another tool with its own text, and anything that is not one request object', async () => {
    const r = chatRig()
    expect(await r.controller.continueChat({ ...CONTINUE, tool: 'claude' })).toEqual({ ok: false, reason: 'invalid', error: 'Only Copilot CLI chats can be continued here for now.' })
    // another tool and another fault: the general text
    expect(await r.controller.continueChat({ ...CONTINUE, tool: 'claude', cwd: '/x' })).toEqual({ ok: false, reason: 'invalid', error: 'This chat can’t be continued here.' })
    for (const bad of [null, 'copilot', [CONTINUE], CHAT, { ...CONTINUE, tool: undefined }]) {
      expect(await r.controller.continueChat(bad)).toMatchObject({ ok: false, reason: 'invalid' })
    }
    // the request main checks is exactly what chatRequest keeps
    expect(controllerModule.chatRequest({ ...CONTINUE })).toEqual(CONTINUE)
    const { startId: _tag, ...untagged } = CONTINUE
    expect(controllerModule.chatRequest(untagged)).toEqual(untagged)
    expect(r.steps()).toEqual([])
  })

  it('refuses in §3.7’s order, and nothing spawns, runs a shell or confirms for any refusal', async () => {
    const runtimes: Array<Json | null> = []
    let started: Json = { ok: false, error: OLD_DRIVER }
    const r: ReturnType<typeof chatRig> = chatRig({
      driverRuntime: () => { r.calls.push('driverRuntime'); return runtimes.length ? runtimes.shift() : { node: '/rt/bin/node', entry: '/rt/dist/driver-cli.js' } },
      startDriver: async (args: Json) => { r.calls.push('startDriver'); r.spawned.push(args); return started },
    })
    // every fault at once; each step fixes the one the last refusal named
    r.state.enabled = false
    let request: Json = { ...CONTINUE, cwd: '/etc' }
    r.chat.lookup = null
    r.chat.launches = null
    r.chat.list = null
    r.chat.env = { ok: false, reason: 'timeout' }
    r.state.confirm = false
    const seen: string[] = []
    const steps: Array<[string, () => void]> = [
      ['blocked', () => { r.state.enabled = true }],
      ['invalid', () => { request = { ...CONTINUE } }],
      ['index', () => { r.chat.lookup = { chat: null, launch: null } }],
      ['missing', () => {
        r.chat.lookup = { chat: chatEntry({ live: true, hidden: ['non-interactive', 'folder-gone'], cwd: '/missing/alpha' }), launch: { id: ID, status: 'parked', resumable: true } }
      }],
      ['driven', () => { (r.chat.lookup as Json).launch = { id: ID, status: 'ended', end_reason: 'handed_off', resumable: true } }],
      ['live', () => { ((r.chat.lookup as Json).chat as Json).live = false }],
      ['kind', () => { ((r.chat.lookup as Json).chat as Json).hidden = ['folder-gone'] }],
      ['folder', () => { ((r.chat.lookup as Json).chat as Json).hidden = [] }],
      // a folder that is not a directory now
      ['folder', () => { ((r.chat.lookup as Json).chat as Json).cwd = CHAT_FOLDER }],
      ['sessions', () => { r.chat.launches = [{ id: ID, status: 'ended', worktree_path: '/Users/tester/dev', worktree_removed_at: null }] }],
      ['worktree', () => {
        r.chat.launches = [{ id: ID, status: 'ended', worktree_path: '/Users/tester/dev', worktree_removed_at: '2026-11-14T12:00:00.000Z' }]
        runtimes.push({ error: 'The installed runtime failed integrity verification: reinstall it from Settings → Setup.' })
      }],
      ['runtime', () => {}],
      ['index', () => { r.chat.list = { chats: [] } }],
      ['cancelled', () => { r.state.confirm = true }],
      ['environment', () => { r.chat.env = { ok: true, env: { PATH: '/usr/bin', HOME, COPILOT_HOME: '/Users/tester/.copilot-work' } } }],
      ['copilot_home', () => { r.chat.env = { ok: true, env: { PATH: '/usr/bin', HOME } } }],
      ['outdated', () => { started = { ok: true, launch: ID } }],
    ]
    for (const [name, fix] of steps) {
      const before = r.calls.length
      const result = await r.controller.continueChat(request) as Json
      const reason = result.ok ? 'ok'
        : result.cancelled ? 'cancelled'
          : typeof result.reason === 'string' ? result.reason
            : /is off/.test(String(result.error)) ? 'blocked'
              : /integrity/.test(String(result.error)) ? 'runtime' : `? ${String(result.error)}`
      seen.push(reason)
      const made = r.calls.slice(before)
      // only a runtime older than the app got as far as the driver, which wrote no row
      if (name !== 'outdated') expect(made, name).not.toContain('startDriver')
      if (!['cancelled', 'environment', 'copilot_home', 'outdated'].includes(name)) expect(made, name).not.toContain('confirm')
      if (!['environment', 'copilot_home', 'outdated'].includes(name)) expect(made.some((c) => c.startsWith('captureEnv')), name).toBe(false)
      if (name !== 'outdated') expect(made, name).not.toContain('keys.launchKey')
      if (typeof result.reason === 'string' && result.reason !== 'environment') expect(result.error, name).toBe(controllerModule.CHAT_REFUSALS[result.reason])
      fix()
    }
    expect(seen).toEqual(steps.map(([name]) => name))
    expect(await r.controller.continueChat(request)).toEqual({ ok: true, launch: ID })
    expect(r.calls.filter((c) => c === 'startDriver')).toHaveLength(2)
  })

  it.each([
    ['running', { status: 'running' }],
    ['parked', { status: 'parked', resumable: false }],
    ['stopped with its session', { status: 'ended', end_reason: 'stopped', resumable: true }],
    ['ended by a budget with its session', { status: 'ended', end_reason: 'budget:tool_calls', resumable: true }],
  ])('refuses a chat a launch here holds (%s) as driven', async (_, launch) => {
    const r = chatRig()
    r.chat.lookup = { chat: chatEntry(), launch }
    expect(await r.controller.continueChat(CONTINUE)).toEqual({ ok: false, reason: 'driven', error: 'This chat already has a session here: use Show session.' })
    expect(r.steps()).toEqual([LOOKUP])
  })

  it.each([
    ['handed off', { status: 'ended', end_reason: 'handed_off', resumable: true }],
    ['ended in an error', { status: 'ended', end_reason: 'error:load', resumable: false }],
    ['stopped before its first message', { status: 'ended', end_reason: 'stopped', resumable: false }],
  ])('continues a chat whose launch here has let it go (%s)', async (_, launch) => {
    const r = chatRig()
    r.chat.lookup = { chat: chatEntry(), launch }
    expect(await r.controller.continueChat(CONTINUE)).toEqual({ ok: true, launch: ID })
  })

  it.each([
    ['no answer', null],
    ['no launch key', { chat: chatEntry() }],
    ['another chat', { chat: chatEntry({ id: CHAT2 }), launch: null }],
    ['a Claude chat', { chat: chatEntry({ tool: 'claude' }), launch: null }],
    ['no project', { chat: chatEntry({ project: null }), launch: null }],
    ['no hidden list', { chat: chatEntry({ hidden: 'empty' }), launch: null }],
    ['a list for a launch', { chat: chatEntry(), launch: [] }],
  ])('refuses a route answer it cannot read (%s) as the index', async (_, lookup) => {
    const r = chatRig()
    r.chat.lookup = lookup
    expect(await r.controller.continueChat(CONTINUE)).toEqual({ ok: false, reason: 'index', error: 'Agent Inbox could not read the chat list.' })
    expect(r.steps()).toEqual([LOOKUP])
  })

  it.each([
    ['live', { live: true }, 'live'],
    ['of unknown liveness', { live: undefined }, 'live'],
    ['empty', { hidden: ['empty'] }, 'kind'],
    ['non-interactive', { hidden: ['temp', 'non-interactive'] }, 'kind'],
    ['folder-gone', { hidden: ['folder-gone'] }, 'folder'],
    ['without a folder', { cwd: null }, 'folder'],
    ['in a relative folder', { cwd: 'dev/alpha' }, 'folder'],
    ['in a folder with a newline', { cwd: '/Users/tester/a\nb' }, 'folder'],
    ['in a folder with U+2028', { cwd: '/Users/tester/a\u2028b' }, 'folder'],
    ['in a folder that is gone', { cwd: '/missing/alpha' }, 'folder'],
  ])('refuses a chat that is %s', async (_, change, reason) => {
    const r = chatRig()
    r.chat.lookup = { chat: chatEntry(change), launch: null }
    expect(await r.controller.continueChat(CONTINUE)).toEqual({ ok: false, reason, error: controllerModule.CHAT_REFUSALS[reason] })
    expect(r.steps()).toEqual([LOOKUP])
  })

  it('a temp folder is no refusal', async () => {
    const r = chatRig()
    r.chat.lookup = { chat: chatEntry({ hidden: ['temp'], cwd: '/private/tmp/scratch' }), launch: null }
    expect(await r.controller.continueChat(CONTINUE)).toEqual({ ok: true, launch: ID })
  })

  it('refuses a folder at or under a worktree a launch here has not removed, as the same launch list reads (§3.2)', async () => {
    for (const [worktree, removed, refusedHere] of [
      [CHAT_FOLDER, null, true], ['/Users/tester/dev', null, true], ['/Users/tester/dev/', null, true],
      ['/Users/tester/dev/alp', null, false], [`${CHAT_FOLDER}/sub`, null, false], ['/Users/tester/dev', '2026-11-14T12:00:00.000Z', false],
    ] as const) {
      const r = chatRig()
      r.chat.launches = [{ id: ID, status: 'parked', cwd: worktree, worktree_path: worktree, worktree_removed_at: removed }]
      const result = await r.controller.continueChat(CONTINUE)
      if (refusedHere) {
        expect(result, worktree).toEqual({ ok: false, reason: 'worktree', error: 'This chat’s folder is a worktree of another session here. Continue that session instead.' })
        expect(r.steps(), worktree).toEqual([LOOKUP, 'GET /api/launches'])
      } else {
        expect(result, worktree).toEqual({ ok: true, launch: ID })
      }
    }
    // the recorded folder counts as well as the resolved one
    const linked = chatRig({ realDirectory: (folder: string) => (folder === CHAT_FOLDER ? '/Volumes/Work/alpha' : folder) })
    linked.chat.launches = [{ id: ID, status: 'ended', worktree_path: CHAT_FOLDER, worktree_removed_at: null }]
    expect(await linked.controller.continueChat(CONTINUE)).toMatchObject({ ok: false, reason: 'worktree' })
  })

  it('warns, without refusing, about another session in the folder: one of this app’s running there without a worktree, and a live chat', async () => {
    const r = chatRig()
    r.chat.repository = false
    r.chat.launches = [
      { id: ID, status: 'running', cwd: CHAT_FOLDER, worktree_path: null },
      { id: '33333333-3333-4333-8333-333333333333', status: 'running', cwd: '/elsewhere', worktree_path: null },
    ]
    r.chat.list = { chats: [chatEntry(), chatEntry({ id: CHAT2, live: true, cwd: CHAT_FOLDER })] }
    expect(await r.controller.continueChat(CONTINUE)).toEqual({ ok: true, launch: ID })
    const lines = confirmationOf(r).detail.split('\n')
    expect(lines.slice(2, 6)).toEqual([
      'It works in this folder itself, not in a worktree: what it changes, it changes in your files there, uncommitted work included.',
      'This folder is not inside a git repository, so git cannot show or undo what it changes.',
      'Another session Agent Inbox started is running in this folder itself, not in a worktree.',
      'Another session is live in this folder.',
    ])
    // none of them for a repository with nothing else in it: a session in its own worktree, a live chat elsewhere
    const quiet = chatRig()
    quiet.chat.launches = [{ id: ID, status: 'running', cwd: CHAT_FOLDER, worktree_path: '/w/alpha/fix-22222222', worktree_removed_at: null }]
    quiet.chat.list = { chats: [chatEntry(), chatEntry({ id: CHAT2, live: true, cwd: '/Users/tester/dev/beta' })] }
    expect(await quiet.controller.continueChat(CONTINUE)).toEqual({ ok: true, launch: ID })
    expect(confirmationOf(quiet).detail).not.toMatch(/git repository|Another session/)
  })

  it('finds a repository by a .git folder or file at the folder or up to 10 levels above it, lstat only (§3.2)', () => {
    const base = realpathSync(scratchDir('continue-repo-'))
    const deep = (n: number) => join(base, ...Array.from({ length: n }, (_, i) => `d${i}`))
    mkdirSync(deep(11), { recursive: true })
    expect(sessionWorktree.insideRepository(deep(11))).toBe(false)
    mkdirSync(join(deep(1), '.git'))
    expect(sessionWorktree.insideRepository(deep(11))).toBe(true)
    expect(sessionWorktree.insideRepository(deep(12))).toBe(false)
    // a linked worktree's .git file counts; a .git link decides it is not one
    writeFileSync(join(deep(5), '.git'), 'gitdir: /elsewhere\n')
    expect(sessionWorktree.insideRepository(deep(11))).toBe(true)
    symlinkSync(join(deep(1), '.git'), join(deep(9), '.git'))
    expect(sessionWorktree.insideRepository(deep(11))).toBe(false)
    expect(sessionWorktree.insideRepository('relative/folder')).toBe(false)
  })

  it('shows §3.4’s lines exactly', () => {
    const text = controllerModule.chatConfirmation({
      project: 'alpha', title: 'Fix the parser', chatId: CHAT, folder: CHAT_FOLDER, repository: false, shared: true, liveHere: true, mode: 'ask', prompt: 'Carry on.',
    })
    expect(text.message).toBe('Continue this Copilot chat in alpha?')
    expect(text.buttons).toEqual(['Continue', 'Cancel'])
    expect(text.detail.split('\n')).toEqual([
      'Chat: Fix the parser (00000000)',
      `Folder: ${CHAT_FOLDER}`,
      'It works in this folder itself, not in a worktree: what it changes, it changes in your files there, uncommitted work included.',
      'This folder is not inside a git repository, so git cannot show or undo what it changes.',
      'Another session Agent Inbox started is running in this folder itself, not in a worktree.',
      'Another session is live in this folder.',
      'Agent Inbox drives it from this window: the agent acts in that folder, its approvals come here, and your messages reach it as turns.',
      'Mode: Ask for everything. Each tool call asks you first, except what your own Copilot settings already allow, such as a command you told Copilot not to ask about again in this folder.',
      'Once any shell command is allowed, the session can run anything, in its folder and beyond. Answer each approval with that in mind.',
      'Budgets: no limit on active turn time or tool calls.',
      'Each turn spends Copilot premium requests, as it would in your terminal.',
      '',
      'Message: Carry on.',
    ])
    const plain = controllerModule.chatConfirmation({
      project: 'alpha', title: null, chatId: CHAT, folder: CHAT_FOLDER, repository: true, shared: false, liveHere: false, mode: 'read-only', prompt: 'x'.repeat(310),
    })
    const lines = plain.detail.split('\n')
    expect(lines[0]).toBe('Chat: Untitled (00000000)')
    expect(lines).toHaveLength(10)
    expect(lines).toContain('Mode: Read-only. File-edit tools are denied; shell commands still ask. This does not make writes impossible.')
    expect(lines.at(-1)).toBe(`Message: ${'x'.repeat(300)}…`)
  })

  it('keeps the end of a long folder, and shows look-alike spaces and blanks and a trailing space, on the Folder line only (review)', async () => {
    const folderOf = (folder: string) => controllerModule.chatConfirmation({
      project: 'alpha', title: null, chatId: CHAT, folder, repository: true, shared: false, liveHere: false, mode: 'ask', prompt: 'x',
    }).detail.split('\n')[1]!
    const long = `/Users/tester/${'deep/'.repeat(40)}the-folder-it-runs-in`
    const line = folderOf(long)
    expect(line.startsWith('Folder: /Users/tester/deep/deep/')).toBe(true)
    expect(line.endsWith('/deep/the-folder-it-runs-in')).toBe(true)
    expect(Array.from(line.slice('Folder: '.length))).toHaveLength(120)
    expect(line.match(/…/g)).toHaveLength(1)
    // a cut never splits an escape, and the end keeps its escapes
    expect(folderOf(`/Users/tester/${'d'.repeat(200)}/proj `).endsWith('/proj<U+00A0>')).toBe(true)
    expect(folderOf(`/Users/tester/${'ㅤ'.repeat(200)}`)).toBe(`Folder: /Users/tester/${'<U+3164>'.repeat(40 - '/Users/tester/'.length)}…${'<U+3164>'.repeat(79)}`)
    for (const [end, shown] of [
      [' ', '<U+00A0>'], ['ㅤ', '<U+3164>'], [' ', '<U+0020>'], ['⠀', '<U+2800>'], ['ᅟ', '<U+115F>'], ['ᅠ', '<U+1160>'],
      ['ﾠ', '<U+FFA0>'], [' ', '<U+2003>'], ['　', '<U+3000>'], [' ', '<U+202F>'],
    ]) expect(folderOf(`/Users/x/proj${end}`), JSON.stringify(end)).toBe(`Folder: /Users/x/proj${shown}`)
    // an ordinary space inside a name stays as it is; so does a folder that is short and plain
    expect(folderOf('/Users/x/my proj')).toBe('Folder: /Users/x/my proj')
    expect(folderOf('/Users/x/a b ')).toBe('Folder: /Users/x/a<U+00A0>b<U+0020>')
    // displayLine is unchanged for its other callers: the New session confirmation, projects, titles
    expect(controllerModule.displayLine('proj  ')).toBe('proj  ')
    expect(controllerModule.displayLine(`/${'f'.repeat(500)}`)).toBe(`/${'f'.repeat(118)}…`)
    expect(controllerModule.confirmation({ project: 'alpha', folder: '/w/proj ', mode: 'ask', budgets: { activeMs: null, toolCalls: null }, prompt: 'x' }).detail.split('\n')[0]).toBe('Folder: /w/proj ')
    // through main: the folder the route names, as the dialog shows it
    const r = chatRig({ realDirectory: (folder: string) => folder })
    r.chat.lookup = { chat: chatEntry({ cwd: '/Users/tester/dev/alphaㅤ' }), launch: null }
    expect(await r.controller.continueChat(CONTINUE)).toEqual({ ok: true, launch: ID })
    expect(confirmationOf(r).detail.split('\n')[1]).toBe('Folder: /Users/tester/dev/alpha<U+3164>')
    expect((r.spawned.at(-1)!.spec as Json).cwd).toBe('/Users/tester/dev/alphaㅤ')
  })

  it('says when the chat list was cut, so a live chat in the folder may be missing from it (review)', async () => {
    const note = 'Agent Inbox could not check every chat for another live session in this folder.'
    const r = chatRig()
    r.chat.list = { chats: [chatEntry()], truncated: true }
    expect(await r.controller.continueChat(CONTINUE)).toEqual({ ok: true, launch: ID })
    const lines = confirmationOf(r).detail.split('\n')
    expect(lines[3]).toBe(note)
    expect(lines).toHaveLength(11)
    // a live chat found is the warning itself; a whole list says nothing
    const found = chatRig()
    found.chat.list = { chats: [chatEntry(), chatEntry({ id: CHAT2, live: true })], truncated: true }
    await found.controller.continueChat(CONTINUE)
    expect(confirmationOf(found).detail).toContain('Another session is live in this folder.')
    expect(confirmationOf(found).detail).not.toContain(note)
    for (const truncated of [false, undefined, 'true']) {
      const whole = chatRig()
      whole.chat.list = { chats: [chatEntry()], truncated }
      await whole.controller.continueChat(CONTINUE)
      expect(confirmationOf(whole).detail, String(truncated)).not.toMatch(/could not check|is live in this folder/)
    }
  })

  it('resolves only live chats’ folders to find one live in this folder through a link, and one that cannot be resolved is not (review)', async () => {
    const resolved: string[] = []
    const links: Record<string, string | null> = { '/tmp/alpha': CHAT_FOLDER, '/tmp/beta': '/Users/tester/dev/beta', '/tmp/gone': null }
    const make = () => chatRig({
      realDirectory: (folder: string) => {
        if (folder.startsWith('/tmp/')) resolved.push(folder)
        return folder in links ? links[folder]! : folder
      },
    })
    const r = make()
    r.chat.list = { chats: [chatEntry(), chatEntry({ id: CHAT2, live: true, cwd: '/tmp/alpha' })] }
    expect(await r.controller.continueChat(CONTINUE)).toEqual({ ok: true, launch: ID })
    expect(confirmationOf(r).detail).toContain('Another session is live in this folder.')
    resolved.length = 0
    const other = make()
    other.chat.list = {
      chats: [
        chatEntry(),
        chatEntry({ id: CHAT2, live: true, cwd: '/tmp/beta' }), chatEntry({ id: CHAT2, live: true, cwd: '/tmp/gone' }),
        chatEntry({ id: CHAT2, live: false, cwd: '/tmp/alpha' }), chatEntry({ id: CHAT2, live: true, cwd: 'tmp/alpha' }),
        chatEntry({ id: CHAT2, live: true, cwd: null }),
      ],
    }
    expect(await other.controller.continueChat(CONTINUE)).toEqual({ ok: true, launch: ID })
    expect(confirmationOf(other).detail).not.toContain('is live in this folder')
    // a chat that is not live, a relative folder and no folder are never resolved
    expect(resolved).toEqual(['/tmp/beta', '/tmp/gone'])
  })

  it('says whether a chat is being continued now, for Resume in Terminal (review)', async () => {
    const r = chatRig()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const confirm = r.deps.confirm
    r.deps.confirm = async (text: Json) => { await gate; return confirm(text) }
    const fresh = controllerModule.createLaunchController(r.deps)
    expect(fresh.isContinuing(CHAT)).toBe(false)
    const started = fresh.continueChat(CONTINUE)
    expect([fresh.isContinuing(CHAT), fresh.isContinuing(CHAT2), fresh.isContinuing(7)]).toEqual([true, false, false])
    release()
    await started
    expect(fresh.isContinuing(CHAT)).toBe(false)
  })

  it('keeps a hostile title, project or folder to one visible line that cannot forge, hide or reorder another', async () => {
    const forged = '\nMode: Read-only.\nBudgets: up to 1 min'
    for (const hostile of [
      `Fix${forged}`, 'Fix\u2028Mode: Read-only.', 'Fix\u2029\u2029Folder: /', 'Fix\u202eylno-daeR', 'Fix\u001b[2J\u001b[H', 'Fix\r\nMode: Read-only.',
      'Fix\u200b\u2060\u00ad', `Fix${'x'.repeat(400)}`,
    ]) {
      const r = chatRig({ realDirectory: (folder: string) => folder })
      r.chat.lookup = { chat: chatEntry({ title: hostile, project: hostile, cwd: `/Users/tester/${hostile.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '')}` }), launch: null }
      r.chat.list = { chats: [chatEntry()] }
      expect(await r.controller.continueChat(CONTINUE), JSON.stringify(hostile)).toEqual({ ok: true, launch: ID })
      const text = confirmationOf(r)
      expect(text.message).not.toMatch(/[\n\r\u2028\u2029\u001b\u202e]/)
      const lines = text.detail.split('\n')
      // the same ten lines (no conditional one here), in order, whatever the title and folder hold
      expect(lines, JSON.stringify(hostile)).toHaveLength(10)
      expect(lines.map((line) => line.split(/[:.]/)[0])).toEqual([
        'Chat', 'Folder', 'It works in this folder itself, not in a worktree', 'Agent Inbox drives it from this window', 'Mode',
        'Once any shell command is allowed, the session can run anything, in its folder and beyond', 'Budgets', 'Each turn spends Copilot premium requests, as it would in your terminal', '', 'Message',
      ])
      expect(text.detail).not.toMatch(/[\r\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202e\u200b\u2060\u00ad]/)
      expect(Array.from(lines[0]!).length).toBeLessThanOrEqual('Chat: '.length + 120 * 10 + ' (00000000)'.length)
    }
    // a folder whose name holds a line break never gets as far as the dialog
    const r = chatRig({ realDirectory: (folder: string) => folder })
    r.chat.lookup = { chat: chatEntry({ cwd: `/Users/tester/a${forged}` }), launch: null }
    expect(await r.controller.continueChat(CONTINUE)).toMatchObject({ ok: false, reason: 'folder' })
    expect(r.calls).not.toContain('confirm')
  })

  it('sends the shell’s COPILOT_HOME only when it is the folder the index reads, <home>/.copilot (§3.3)', async () => {
    const homes: Array<[Json, boolean]> = [
      [{ HOME }, true],
      [{ HOME, COPILOT_HOME: '/Users/tester/.copilot' }, true],
      [{ HOME, COPILOT_HOME: '/Users/tester/.copilot/' }, true],
      // a link that resolves there is the same folder
      [{ HOME, COPILOT_HOME: '/Users/tester/copilot-link' }, true],
      [{ HOME, COPILOT_HOME: '/Users/tester/.copilot-work' }, false],
      [{ HOME, COPILOT_HOME: '.copilot' }, false],
      [{ HOME, COPILOT_HOME: '' }, false],
      [{ HOME, COPILOT_HOME: '/missing/copilot' }, false],
      [{ HOME: '/Users/other' }, false],
      [{}, false],
    ]
    for (const [env, ok] of homes) {
      const r = chatRig({
        realDirectory: (folder: string) => (folder.startsWith('/missing') ? null : folder === '/Users/tester/copilot-link' ? '/Users/tester/.copilot' : folder.replace(/\/+$/, '')),
      })
      r.chat.env = { ok: true, env: { PATH: '/usr/bin', ...env } }
      const result = await r.controller.continueChat(CONTINUE)
      if (ok) {
        expect(result, JSON.stringify(env)).toEqual({ ok: true, launch: ID })
        expect((r.spawned.at(-1)!.spec as Json).env, JSON.stringify(env)).toEqual({ PATH: '/usr/bin', ...env })
      } else {
        expect(result, JSON.stringify(env)).toEqual({ ok: false, reason: 'copilot_home', error: 'Your shell sets COPILOT_HOME to another folder, so Copilot would not find this chat.' })
        expect(r.calls, JSON.stringify(env)).not.toContain('startDriver')
      }
    }
    // no home folder given to main, or none there: nothing to match, so nothing starts
    for (const over of [{ homeDir: undefined }, { homeDir: 'Users/tester' }, { homeDir: '/missing/home' }]) {
      const r = chatRig(over)
      expect(await r.controller.continueChat(CONTINUE)).toMatchObject({ ok: false, reason: 'copilot_home' })
    }
  })

  it('reads an older runtime’s refusal of the kind from the driver’s status line, and says to update', async () => {
    const dir = scratchDir('continue-old-driver-')
    const entry = join(dir, 'driver-cli.js')
    // what a driver before the chat kind does with a chat spec (refuseStart): its status line, then exit 65
    writeFileSync(entry, `process.stdout.write(JSON.stringify({ ok: false, error: ${JSON.stringify(OLD_DRIVER)} }) + '\\n'); process.exit(65)`)
    const run = (answer?: string) => {
      if (answer) writeFileSync(entry, answer)
      return chatRig({
        hubPath: join(dir, 'hub', 'inbox.db'),
        driverRuntime: () => ({ node: process.execPath, entry }),
        startDriver: (args: Json) => driverProcess.startDriver({ ...args, spawnImpl: spawn } as unknown as Parameters<typeof driverProcess.startDriver>[0]),
      })
    }
    const r = run()
    expect(await r.controller.continueChat(CONTINUE)).toEqual({ ok: false, reason: 'outdated', error: 'This Agent Inbox runtime is older than the app. Update agents in Setup.' })
    // any other refusal on the status line is the driver's own text
    const capped = run(`process.stdout.write(JSON.stringify({ ok: false, error: 'at the driver cap' }) + '\\n'); process.exit(75)`)
    expect(await capped.controller.continueChat(CONTINUE)).toEqual({ ok: false, error: 'at the driver cap' })
    const newer = run(`process.stdout.write(JSON.stringify({ ok: false, error: 'launch spec: kind must be new, resume or chat' }) + '\\n'); process.exit(65)`)
    expect(await newer.controller.continueChat(CONTINUE)).toEqual({ ok: false, error: 'launch spec: kind must be new, resume or chat' })
  })

  it('one chat, one launch: two concurrent calls spawn one driver, and the chat is free again on every way out', async () => {
    const r = chatRig()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const confirm = r.deps.confirm
    r.deps.confirm = async (text: Json) => { await gate; return confirm(text) }
    const fresh = controllerModule.createLaunchController(r.deps)
    const first = fresh.continueChat(CONTINUE)
    expect(await fresh.continueChat(CONTINUE)).toEqual({ ok: false, reason: 'busy', error: 'This chat is already starting.' })
    expect(await fresh.continueChat({ ...CONTINUE, prompt: 'Something else.' })).toMatchObject({ ok: false, reason: 'busy' })
    release()
    expect(await first).toEqual({ ok: true, launch: ID })
    expect(r.calls.filter((c) => c === 'startDriver')).toHaveLength(1)
    // after a success, a refusal, a cancel and a throw, the next call is not busy
    expect(await fresh.continueChat(CONTINUE)).toEqual({ ok: true, launch: ID })
    r.chat.lookup = { chat: null, launch: null }
    expect(await fresh.continueChat(CONTINUE)).toMatchObject({ reason: 'missing' })
    r.chat.lookup = { chat: chatEntry(), launch: null }
    r.state.confirm = false
    expect(await fresh.continueChat(CONTINUE)).toMatchObject({ ok: false, cancelled: true })
    r.state.confirm = true
    const read = r.deps.viewer.getJson
    r.deps.viewer.getJson = async () => { throw new Error('viewer gone') }
    expect(await fresh.continueChat(CONTINUE)).toEqual({ ok: false, error: 'The session could not be started.' })
    r.deps.viewer.getJson = read
    expect(await fresh.continueChat(CONTINUE)).toEqual({ ok: true, launch: ID })
  })

  it('another chat is not held back by one starting', async () => {
    const r = chatRig()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const confirm = r.deps.confirm
    r.deps.confirm = async (text: Json) => { await gate; return confirm(text) }
    const fresh = controllerModule.createLaunchController(r.deps)
    const first = fresh.continueChat(CONTINUE)
    // CHAT2 is not listed in this rig, so it gets as far as the route
    expect(await fresh.continueChat({ ...CONTINUE, id: CHAT2 })).toMatchObject({ ok: false, reason: 'index' })
    release()
    expect(await first).toEqual({ ok: true, launch: ID })
  })

  it('reports its environment phase with the page’s start tag, and starts nothing when the switch goes off or a quit begins in the dialog', async () => {
    const phases: string[] = []
    const r = chatRig({ progress: (phase: string, launch: string, startId?: string) => { phases.push(`${phase} ${launch} ${startId}`) } })
    expect(await r.controller.continueChat(CONTINUE)).toEqual({ ok: true, launch: ID })
    expect(phases).toEqual([`environment ${ID} tag-0123456789abcdef`, `runtime ${ID} tag-0123456789abcdef`])
    for (const late of ['off', 'quit'] as const) {
      const l: ReturnType<typeof chatRig> = chatRig({
        confirm: async () => { if (late === 'off') l.state.enabled = false; else l.controller.beginQuit(); return true },
      })
      expect(await l.controller.continueChat(CONTINUE), late).toMatchObject({ ok: false })
      expect(l.calls.some((c) => c.startsWith('captureEnv')), late).toBe(false)
      expect(l.calls, late).not.toContain('startDriver')
    }
  })

  it('off means off: no read, no dialog, no shell and no spawn, everywhere but macOS and without safeStorage too', async () => {
    const off = chatRig()
    off.state.enabled = false
    expect(await off.controller.continueChat(CONTINUE)).toEqual({ ok: false, error: 'Starting sessions from Agent Inbox is off. Turn it on in Settings → Agent sessions.' })
    // even a request that is not valid is refused by the gate first, and reads nothing
    expect(await off.controller.continueChat({ ...CONTINUE, cwd: '/etc' })).toMatchObject({ ok: false, error: expect.stringMatching(/is off/) })
    expect(off.calls).toEqual([])
    expect(await chatRig({ platform: 'linux' }).controller.continueChat(CONTINUE)).toMatchObject({ ok: false, error: expect.stringMatching(/macOS only/) })
    const noKeys = chatRig()
    noKeys.deps.keys.available = () => false
    expect(await controllerModule.createLaunchController(noKeys.deps).continueChat(CONTINUE)).toMatchObject({ ok: false, error: expect.stringMatching(/cannot encrypt/) })
    const quitting = chatRig()
    quitting.controller.beginQuit()
    expect(await quitting.controller.continueChat(CONTINUE)).toMatchObject({ ok: false, error: expect.stringMatching(/quitting/) })
    for (const r of [noKeys, quitting]) expect(r.steps(), 'no read').toEqual([])
  })

  it('settled() waits for a continue in flight, so the quit prompt sees its launch', async () => {
    const r = chatRig()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const confirm = r.deps.confirm
    r.deps.confirm = async (text: Json) => { await gate; return confirm(text) }
    const fresh = controllerModule.createLaunchController(r.deps)
    const started = fresh.continueChat(CONTINUE)
    let settled = false
    const waiting = fresh.settled().then(() => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(settled).toBe(false)
    release()
    await waiting
    expect(await started).toEqual({ ok: true, launch: ID })
  })

  describe('Resume of a launch that continues a chat (§3.3)', () => {
    const PARKED = { id: ID, status: 'parked', cwd: CHAT_FOLDER, chat_id: CHAT, resumable: true }

    it('re-reads the chat and refuses when a terminal now holds it live, starting nothing', async () => {
      const r = chatRig()
      r.state.launches[ID] = PARKED
      r.chat.lookup = { chat: chatEntry({ live: true }), launch: PARKED }
      expect(await r.controller.resume(ID)).toEqual({ ok: false, reason: 'live', error: 'This chat is live in another process.' })
      expect(r.steps()).toEqual([`GET /api/launches/${ID}`, LOOKUP])
      r.chat.lookup = null
      expect(await r.controller.resume(ID)).toMatchObject({ ok: false, reason: 'index' })
      r.chat.lookup = { chat: null, launch: PARKED }
      expect(await r.controller.resume(ID)).toMatchObject({ ok: false, reason: 'missing' })
      expect(r.calls.some((c) => c === 'startDriver' || c.startsWith('captureEnv'))).toBe(false)
    })

    it('resumes it as any launch once the chat is not live, and stopped with its session too', async () => {
      for (const launch of [PARKED, { ...PARKED, status: 'ended', end_reason: 'stopped' }]) {
        const r = chatRig()
        r.state.launches[ID] = launch
        r.chat.lookup = { chat: chatEntry(), launch }
        expect(await r.controller.resume(ID)).toEqual({ ok: true, launch: ID })
        expect(r.steps()).toEqual([`GET /api/launches/${ID}`, LOOKUP, 'driverRuntime', `captureEnv ${CHAT_FOLDER}`, 'keys.launchKey', 'driverRuntime', 'startDriver'])
        expect(parseLaunchSpec(JSON.stringify(r.spawned.at(-1)!.spec), ID)).toMatchObject({ ok: true, spec: { kind: 'resume' } })
      }
    })

    it('reads no chat for a launch that continues none, and refuses a chat id it cannot use', async () => {
      const r = chatRig()
      r.state.launches[ID] = { id: ID, status: 'parked', cwd: CHAT_FOLDER, chat_id: null }
      expect(await r.controller.resume(ID)).toEqual({ ok: true, launch: ID })
      expect(r.calls.some((c) => c.startsWith('GET /api/chats'))).toBe(false)
      for (const chatId of ['../x', CHAT.toUpperCase(), 7]) {
        r.state.launches[ID] = { id: ID, status: 'parked', cwd: CHAT_FOLDER, chat_id: chatId }
        expect(await r.controller.resume(ID)).toEqual({ ok: false, error: 'The launch is not valid.' })
      }
    })
  })
})

describe('the launch IPC and its grants (§8)', () => {
  function world({ owned = true, granted = true } = {}) {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const r = rig()
    const settings = { setEnabled: vi.fn(async (enabled: boolean) => ({ enabled })) }
    const onEnabled = vi.fn()
    let made = 0
    launchIpc.registerLaunchIpc({
      ipcMain: { handle: (channel: string, fn: unknown) => handlers.set(channel, fn as (event: unknown, ...args: unknown[]) => unknown) },
      controller: () => { made++; return r.controller },
      settings, settled: async () => {}, isOwned: () => owned, isGranted: () => granted, onEnabled,
    })
    const call = (channel: string, ...args: unknown[]) => handlers.get(`agent-inbox:${channel}`)!({}, ...args)
    return { call, r, settings, onEnabled, handlers, made: () => made }
  }

  it('registers the seventeen channels, and makes no controller until one is used', () => {
    const w = world()
    expect([...w.handlers.keys()].sort()).toEqual([
      'available', 'approve', 'choose-folder', 'choose-worktree-root', 'close', 'continue-chat', 'forget', 'open-worktree', 'remove-worktree', 'reset-worktree-root', 'resume',
      'resume-with-budget', 'set-enabled', 'set-max-sessions', 'start', 'stop', 'take-over',
    ].map((name) => `agent-inbox:launch-${name}`).sort())
    expect(w.made()).toBe(0)
  })

  it('names the terminal only to the granted window, with the switch on (#586)', async () => {
    const w = world()
    expect(await w.call('launch-available')).toMatchObject({ available: true, terminal: 'terminal' })
    expect(w.r.state.terminalReads).toBe(1)
    w.r.state.terminal = 'iterm2'
    expect(await w.call('launch-available')).toMatchObject({ available: true, terminal: 'iterm2' })
    w.r.state.terminal = 'Hyper'
    expect(await w.call('launch-available')).toMatchObject({ terminal: 'terminal' })
    const ungranted = world({ owned: true, granted: false })
    ungranted.r.state.terminal = 'iterm2'
    expect(await ungranted.call('launch-available')).not.toHaveProperty('terminal')
    const off = world()
    off.r.state.terminal = 'iterm2'
    off.r.state.enabled = false
    expect(await off.call('launch-available')).not.toHaveProperty('terminal')
    expect(off.r.state.terminalReads).toBe(0)
  })

  it('answers only the owned viewer for the switch, and only the granted window for actions', async () => {
    const browser = world({ owned: false, granted: false })
    expect(await browser.call('launch-available')).toEqual({ owned: false, enabled: false, available: false })
    expect(await browser.call('launch-set-enabled', true)).toMatchObject({ ok: false })
    expect(await browser.call('launch-start', REQUEST)).toMatchObject({ ok: false })
    expect(browser.settings.setEnabled).not.toHaveBeenCalled()
    expect(browser.r.calls).toEqual([])

    const owned = world({ owned: true, granted: false })
    owned.r.state.enabled = false
    expect(await owned.call('launch-available')).toMatchObject({ owned: true, enabled: false, available: false, canEnable: true })
    expect(await owned.call('launch-set-enabled', true)).toEqual({ ok: true, enabled: true })
    expect(owned.onEnabled).toHaveBeenCalledWith(true)
    expect(await owned.call('launch-start', REQUEST)).toMatchObject({ ok: false })
    expect(owned.r.calls).not.toContain('startDriver')
  })

  it('reports the worktree folder only to the granted window, and chooses or resets it only there, with no argument (#432)', async () => {
    const owned = world({ owned: true, granted: false })
    expect(await owned.call('launch-available')).not.toHaveProperty('worktreeRoot')
    expect(await owned.call('launch-choose-worktree-root')).toMatchObject({ ok: false })
    expect(await owned.call('launch-reset-worktree-root')).toMatchObject({ ok: false })
    expect(owned.r.calls.filter((c) => c.startsWith('worktree') || c === 'chooseWorktreeFolder')).toEqual([])
    expect(await owned.call('launch-available')).not.toHaveProperty('maxSessions')
    expect(await owned.call('launch-set-max-sessions', 3)).toMatchObject({ ok: false })
    expect(owned.r.state.cap).toBeNull()
    const w = world()
    expect(await w.call('launch-available')).toMatchObject({ worktreeRoot: { path: '/hub/worktrees', isDefault: true }, maxSessions: 4 })
    expect(await w.call('launch-set-max-sessions', 3)).toEqual({ ok: true, maxSessions: 3 })
    expect(await w.call('launch-set-max-sessions')).toEqual({ ok: false, error: 'invalid' })
    expect(await w.call('launch-choose-worktree-root', '/elsewhere')).toEqual({ ok: false, error: 'invalid' })
    expect(await w.call('launch-reset-worktree-root', null)).toEqual({ ok: false, error: 'invalid' })
    expect(await w.call('launch-choose-worktree-root')).toMatchObject({ ok: false, cancelled: true })
    expect(await w.call('launch-choose-folder', '/elsewhere')).toEqual({ ok: false, error: 'invalid' })
    expect(await owned.call('launch-choose-folder')).toMatchObject({ ok: false })
    expect(owned.r.calls).not.toContain('chooseFolder')
    expect(w.r.calls).toContain('chooseWorktreeFolder')
  })

  it('removes or opens a worktree only for the granted window, with exactly a launch id (#432)', async () => {
    const owned = world({ owned: true, granted: false })
    owned.r.state.launches[ID] = { id: ID, status: 'ended', project: 'alpha', worktree_path: '/w/alpha/fix-22222222', checkout_root: '/work/alpha', worktree_removed_at: null }
    for (const channel of ['launch-remove-worktree', 'launch-open-worktree', 'launch-take-over', 'launch-forget']) expect(await owned.call(channel, ID)).toMatchObject({ ok: false })
    expect(owned.r.calls).toEqual([])
    const w = world()
    w.r.state.launches[ID] = owned.r.state.launches[ID]!
    expect(await w.call('launch-remove-worktree')).toEqual({ ok: false, error: 'invalid' })
    expect(await w.call('launch-open-worktree', ID, '/w')).toEqual({ ok: false, error: 'invalid' })
    expect(await w.call('launch-take-over', ID, 'copilot --yolo')).toEqual({ ok: false, error: 'invalid' })
    expect(await w.call('launch-take-over')).toEqual({ ok: false, error: 'invalid' })
    expect(await w.call('launch-forget', ID, 1)).toEqual({ ok: false, error: 'invalid' })
    expect(await w.call('launch-open-worktree', ID)).toEqual({ ok: true })
    expect(await w.call('launch-remove-worktree', ID)).toEqual({ ok: true })
  })

  it('continues a chat only for the granted window, with exactly one request, and reads nothing with the switch off (#586 phase 2)', async () => {
    const request = { tool: 'copilot', id: ID, mode: 'ask', prompt: 'Go on.' }
    for (const w of [world({ owned: false, granted: false }), world({ owned: true, granted: false })]) {
      expect(await w.call('launch-continue-chat', request)).toEqual({ ok: false, error: 'Agent sessions work only in Agent Inbox’s own window, with Settings → Agent sessions on.' })
      expect(w.r.calls).toEqual([])
      expect(w.made()).toBe(0)
    }
    const w = world()
    expect(await w.call('launch-continue-chat')).toEqual({ ok: false, error: 'invalid' })
    expect(await w.call('launch-continue-chat', request, '/Users/tester/dev')).toEqual({ ok: false, error: 'invalid' })
    expect(w.made()).toBe(0)
    w.r.state.enabled = false
    expect(await w.call('launch-continue-chat', request)).toMatchObject({ ok: false, error: expect.stringMatching(/is off/) })
    expect(w.r.calls).toEqual([])
    // with the switch on, the controller gets exactly the one argument and reads the chat itself
    w.r.state.enabled = true
    expect(await w.call('launch-continue-chat', request)).toMatchObject({ ok: false, reason: 'index' })
    expect(w.r.calls).toContain(`GET /api/chats/copilot/${ID}`)
  })

  it('takes exactly its arguments, and refuses turning the switch off while sessions run', async () => {
    const w = world()
    expect(await w.call('launch-set-enabled')).toEqual({ ok: false, error: 'invalid' })
    expect(await w.call('launch-set-enabled', 'on')).toEqual({ ok: false, error: 'invalid' })
    expect(await w.call('launch-start', REQUEST, 'extra')).toEqual({ ok: false, error: 'invalid' })
    expect(await w.call('launch-available', 1)).toEqual({ owned: false, enabled: false, available: false })
    w.r.state.launches = { [ID]: { id: ID, status: 'running', project: 'alpha', mode: 'ask', driver: 'running' } }
    expect(await w.call('launch-set-enabled', false)).toMatchObject({ ok: false, error: expect.stringMatching(/Stop the sessions/) })
    expect(w.settings.setEnabled).not.toHaveBeenCalled()
    expect(await w.call('launch-start', REQUEST)).toEqual({ ok: true, launch: ID })
  })
})

describe('the window binding’s launch grant (#216, #300)', () => {
  const VIEWER = 'http://127.0.0.1:4319/'
  function binding({ launch = true, quitting = false } = {}) {
    const applied: Json[] = []
    const state = { launch, quitting, proof: true }
    const b = setupRunner.createInstallBinding({
      viewerUrl: VIEWER, setupAllowed: () => true, updateAllowed: () => true, filesAllowed: () => true,
      launchAllowed: () => state.launch, isQuitting: () => state.quitting, proveOwnership: async () => state.proof,
      apply: (grants: Json) => applied.push(grants),
    })
    return { b, applied, state }
  }

  it('grants launch with the others at the first load, revokes it on navigation, and re-grants it only after the re-proof', async () => {
    const { b, applied, state } = binding()
    b.navigationStarted(VIEWER)
    expect(applied.at(-1)).toEqual({ setup: true, update: true, files: true, launch: true })
    b.navigationStarted(VIEWER)
    expect(applied.at(-1)).toEqual({ setup: false, update: false, files: false, launch: false })
    state.proof = false
    expect(await b.navigationCommitted(VIEWER)).toBe(false)
    expect(applied.at(-1)!.launch).toBe(false)
    b.navigationStarted(VIEWER)
    state.proof = true
    expect(await b.navigationCommitted(VIEWER)).toBe(true)
    expect(applied.at(-1)!.launch).toBe(true)
  })

  it('refresh() re-applies the switch to a bound window, and never binds a revoked one or one that is quitting', async () => {
    const { b, applied, state } = binding({ launch: false })
    b.navigationStarted(VIEWER)
    expect(applied.at(-1)!.launch).toBe(false)
    state.launch = true
    b.refresh()
    expect(applied.at(-1)).toEqual({ setup: true, update: true, files: true, launch: true })
    b.navigationStarted(VIEWER) // revoked, awaiting its re-proof
    const count = applied.length
    b.refresh()
    expect(applied).toHaveLength(count)
    expect(await b.navigationCommitted(VIEWER)).toBe(true)
    state.quitting = true
    b.refresh()
    expect(applied).toHaveLength(count + 1)
  })

  it('a grant asked while quitting is never launch', () => {
    const { b, applied } = binding({ quitting: true })
    b.navigationStarted(VIEWER)
    expect(applied).toEqual([])
  })
})

describe('the driver runtime (§8, #206)', () => {
  const selection = { ok: true, manifest: { runtimeId: 'rt-1' }, digest: 'sha256:abc', packageVersion: '2.3.0' }

  it('is the installed copy of this release’s runtime, verified against its signed digest with the driver and spec v1 required', () => {
    const verify = vi.fn(() => ({ manifest: { runtimeId: 'rt-1' } }))
    expect(setupRunner.installedDriverRuntime({ runtimeRoot: '/root', selection, platform: 'darwin', arch: 'arm64', verify }))
      .toEqual({ node: '/root/rt-1/bin/node', entry: '/root/rt-1/dist/driver-cli.js' })
    const options = (verify.mock.calls[0] as unknown as [Json])[0]
    expect(options).toMatchObject({ root: '/root/rt-1', expectedManifestDigest: 'sha256:abc', expectedPackageVersion: '2.3.0' })
    expect(options.requiredFiles).toEqual(expect.arrayContaining(['dist/driver-cli.js', 'dist/launch-spec.js']))
  })

  it('explains a missing runtime (Setup installs it only with an agent registration, never over a checkout), asks to reinstall a changed one, and refuses without a verified selection', () => {
    const missing = () => { throw Object.assign(new Error('x'), { code: 'not-found' }) }
    const notInstalled = setupRunner.installedDriverRuntime({ runtimeRoot: '/root', selection, verify: missing }).error
    expect(notInstalled).toMatch(/not installed yet/)
    expect(notInstalled).toMatch(/never over a source checkout/)
    expect(notInstalled).toMatch(/npm run build, then npm run electron/)
    // Setup offers no Update agents for a checkout's hosts, so the copy never sends the human there
    expect(notInstalled).not.toMatch(/Update agents/)
    const changed = () => { throw new Error('hash') }
    expect(setupRunner.installedDriverRuntime({ runtimeRoot: '/root', selection, verify: changed }).error).toMatch(/failed integrity/)
    expect(setupRunner.installedDriverRuntime({ runtimeRoot: '/root', selection: { ok: false } }).error).toMatch(/no verified runtime/)
    expect(setupRunner.installedDriverRuntime({ runtimeRoot: null, selection }).error).toMatch(/absolute/)
  })

  // #435: a release app whose agents run from a checkout has no installed runtime
  describe('the bundle fallback (#435)', () => {
    const RT = { manifest: { runtimeId: 'rt-1' } }
    function world(...segments: string[]) {
      const base = realpathSync(scratchDir('driver-runtime-'))
      const bundle = join(base, ...segments, 'Agent Inbox.app', 'Contents', 'Resources', 'app', 'runtime', 'darwin-arm64')
      mkdirSync(bundle, { recursive: true })
      const root = join(base, 'runtime')
      return { root, bundle, installed: join(root, 'rt-1'), selection: { ...selection, path: bundle } }
    }
    // verify, answering per folder: verified, not installed, or changed
    const verifyBy = (answers: Record<string, 'ok' | 'not-found' | 'changed'>) => vi.fn((options: Json) => {
      const answer = answers[options.root as string] ?? 'not-found'
      if (answer === 'ok') return RT
      throw answer === 'changed' ? new Error('hash') : Object.assign(new Error('x'), { code: 'not-found' })
    })
    const roots = (verify: ReturnType<typeof verifyBy>) => verify.mock.calls.map((call) => (call[0] as Json).root)

    it('uses the installed runtime first, and never looks at the bundle then', () => {
      const w = world()
      const verify = verifyBy({ [w.installed]: 'ok', [w.bundle]: 'ok' })
      expect(setupRunner.driverRuntime({ runtimeRoot: w.root, selection: w.selection, platform: 'darwin', arch: 'arm64', verify }))
        .toEqual({ node: join(w.installed, 'bin', 'node'), entry: join(w.installed, 'dist', 'driver-cli.js') })
      expect(roots(verify)).toEqual([w.installed])
    })

    it('runs this app’s own payload when none is installed, verified against the same signed digest with the driver required', () => {
      const w = world()
      const verify = verifyBy({ [w.bundle]: 'ok' })
      expect(setupRunner.driverRuntime({ runtimeRoot: w.root, selection: w.selection, platform: 'darwin', arch: 'arm64', verify }))
        .toEqual({ node: join(w.bundle, 'bin', 'node'), entry: join(w.bundle, 'dist', 'driver-cli.js') })
      expect(roots(verify)).toEqual([w.installed, w.bundle])
      const options = verify.mock.calls[1]![0] as Json
      expect(options).toMatchObject({ expectedManifestDigest: 'sha256:abc', expectedPackageVersion: '2.3.0', expectedPlatform: 'darwin', expectedArch: 'arm64' })
      expect(options.requiredFiles).toEqual(expect.arrayContaining(['dist/driver-cli.js', 'dist/launch-spec.js']))
    })

    it('never falls back from an installed runtime that fails verification', () => {
      const w = world()
      const verify = verifyBy({ [w.installed]: 'changed', [w.bundle]: 'ok' })
      expect(setupRunner.driverRuntime({ runtimeRoot: w.root, selection: w.selection, platform: 'darwin', arch: 'arm64', verify }).error)
        .toBe('The installed v2.3.0 runtime failed integrity verification: reinstall it from Settings → Setup.')
      expect(roots(verify)).toEqual([w.installed])
    })

    it('refuses a translocated bundle, a bundle that fails verification, and one that moved since it started, with the not-installed copy first', () => {
      const translocated = world('AppTranslocation', 'ABC', 'd')
      const tVerify = verifyBy({ [translocated.bundle]: 'ok' })
      const tError = setupRunner.driverRuntime({ runtimeRoot: translocated.root, selection: translocated.selection, platform: 'darwin', arch: 'arm64', verify: tVerify }).error
      expect(tError).toMatch(/^This app's v2\.3\.0 runtime is not installed yet\./)
      expect(tError).toMatch(/App Translocation.*move Agent Inbox to the Applications folder/)
      expect(roots(tVerify)).toEqual([translocated.installed])

      const w = world()
      const changed = verifyBy({ [w.bundle]: 'changed' })
      const cError = setupRunner.driverRuntime({ runtimeRoot: w.root, selection: w.selection, platform: 'darwin', arch: 'arm64', verify: changed }).error
      expect(cError).toMatch(/^This app's v2\.3\.0 runtime is not installed yet\..*This app's own runtime failed integrity verification too: reinstall Agent Inbox\.$/)

      // the bundle was renamed, or its folder became a link, after startup resolved it
      const link = join(dirname(w.bundle), 'linked')
      symlinkSync(w.bundle, link)
      for (const path of [join(dirname(w.bundle), 'gone'), link]) {
        const verify = verifyBy({ [path]: 'ok' })
        expect(setupRunner.driverRuntime({ runtimeRoot: w.root, selection: { ...w.selection, path }, platform: 'darwin', arch: 'arm64', verify }).error)
          .toMatch(/moved since it started/)
        expect(roots(verify)).toEqual([w.installed])
      }
    })

    it('never falls back off macOS, without a verified selection, or with a relative runtime root', () => {
      const w = world()
      const verify = verifyBy({ [w.bundle]: 'ok' })
      const linux = setupRunner.driverRuntime({ runtimeRoot: w.root, selection: w.selection, platform: 'linux', arch: 'x64', verify })
      expect(linux).toEqual({ error: expect.stringMatching(/^This app's v2\.3\.0 runtime is not installed yet\. .*npm run electron\.$/) })
      expect(roots(verify)).toEqual([w.installed])
      expect(setupRunner.driverRuntime({ runtimeRoot: w.root, selection: { ...w.selection, ok: false }, platform: 'darwin', verify }).error).toMatch(/no verified runtime/)
      expect(setupRunner.driverRuntime({ runtimeRoot: null, selection: w.selection, platform: 'darwin', verify }).error).toMatch(/absolute/)
      expect(roots(verify)).toEqual([w.installed])
    })

    it('falls back only when the installed runtime is truly absent (ENOENT); one that cannot be read refuses (#440 review)', () => {
      const realVerify = (createRequire(import.meta.url)('../electron/runtime-verify.cjs') as { verifyRuntimePayload(o: Json): unknown }).verifyRuntimePayload
      const attempt = (root: string, w: ReturnType<typeof world>) => {
        const seen: string[] = []
        const codes: unknown[] = []
        const verify = (options: Json) => {
          seen.push(options.root as string)
          if (options.root === w.bundle) return RT
          try {
            return realVerify(options)
          } catch (err) {
            codes.push((err as { code?: unknown }).code)
            throw err
          }
        }
        return { result: setupRunner.driverRuntime({ runtimeRoot: root, selection: w.selection, platform: 'darwin', arch: 'arm64', verify }), seen, codes }
      }
      const NOT_INSTALLED = /^This app's v2\.3\.0 runtime is not installed yet\. .*npm run electron\.$/

      const absent = world()
      mkdirSync(absent.root)
      const a = attempt(absent.root, absent)
      expect(a.result).toEqual({ node: join(absent.bundle, 'bin', 'node'), entry: join(absent.bundle, 'dist', 'driver-cli.js') })
      expect(a.codes).toEqual(['not-found'])

      const refusals: Array<[string, (w: ReturnType<typeof world>) => string, string, RegExp]> = [
        // the runtime root is a file: ENOTDIR
        ['a file for the root', (w) => { writeFileSync(w.root, ''); return w.root }, 'unreadable', NOT_INSTALLED],
        // a symlink loop above the runtime folder: ELOOP
        ['a symlink loop', (w) => { symlinkSync(`${w.root}-b`, w.root); symlinkSync(w.root, `${w.root}-b`); return w.root }, 'unreadable', NOT_INSTALLED],
        // a file in place of the runtime folder
        ['a file for the runtime', (w) => { mkdirSync(w.root); writeFileSync(w.installed, ''); return w.root }, 'not-a-directory', /failed integrity verification: reinstall it from Settings → Setup\.$/],
      ]
      if (process.getuid?.() !== 0) {
        refusals.push(['an unreadable root (EACCES)', (w) => { mkdirSync(w.root, { mode: 0o000 }); return w.root }, 'unreadable', NOT_INSTALLED])
      }
      for (const [label, make, code, error] of refusals) {
        const w = world()
        const root = make(w)
        try {
          const r = attempt(root, w)
          expect(r.codes, label).toEqual([code])
          expect(r.result, label).toEqual({ error: expect.stringMatching(error) })
          expect(r.seen, label).toEqual([w.installed])
        } finally {
          if (label.includes('EACCES')) chmodSync(w.root, 0o700)
        }
      }
    })

    it.runIf(process.platform === 'darwin')('verifies a real bundled payload, and refuses one changed or without the driver', () => {
      const base = realpathSync(scratchDir('driver-bundle-'))
      const bundle = join(base, 'app', 'runtime', `darwin-${process.arch}`)
      const staged = stageRuntime(bundle, '2.3.0', { driver: true })
      const real = { ok: true, path: bundle, digest: staged.digest, packageVersion: '2.3.0', manifest: { runtimeId: staged.runtimeId } }
      const runtimeRoot = join(base, 'runtime')
      expect(setupRunner.driverRuntime({ runtimeRoot, selection: real, platform: 'darwin', arch: process.arch }))
        .toEqual({ node: join(bundle, 'bin', 'node'), entry: join(bundle, 'dist', 'driver-cli.js') })
      appendFileSync(join(bundle, 'dist', 'driver-cli.js'), '// changed\n')
      expect(setupRunner.driverRuntime({ runtimeRoot, selection: real, platform: 'darwin', arch: process.arch }).error).toMatch(/failed integrity verification too/)
      const older = join(base, 'older', 'runtime', `darwin-${process.arch}`)
      const noDriver = stageRuntime(older, '2.3.0')
      expect(setupRunner.driverRuntime({
        runtimeRoot, selection: { ...real, path: older, digest: noDriver.digest, manifest: { runtimeId: noDriver.runtimeId } }, platform: 'darwin', arch: process.arch,
      }).error).toMatch(/failed integrity verification too/)
    })
  })
})

describe('the preload bridge (§8)', () => {
  function loadPreload(answer: (channel: string, ...args: unknown[]) => unknown) {
    const exposed: Record<string, unknown> = {}
    const invoke = vi.fn(async (channel: string, ...args: unknown[]) => answer(channel, ...args))
    const electron = {
      contextBridge: { exposeInMainWorld: (name: string, api: unknown) => { exposed[name] = api } },
      ipcRenderer: { invoke, on: () => {}, removeListener: () => {} },
    }
    const factory = vm.runInThisContext(`(function (require, process) {\n${read('electron/setup-preload.cjs')}\n})`, { filename: 'setup-preload.cjs' }) as
      (require: (id: string) => unknown, process: { argv: string[] }) => void
    factory((id) => {
      if (id !== 'electron') throw new Error(`unexpected require ${id}`)
      return electron
    }, { argv: [] })
    return { launch: exposed.agentInboxLaunch as Record<string, (...args: unknown[]) => Promise<Json>>, invoke }
  }

  it('has exactly its eighteen methods, each with exact arity, and passes nothing it was not given', async () => {
    const { launch, invoke } = loadPreload(() => ({ ok: true, launch: ID, path: '/secret', enabled: true }))
    expect(Object.keys(launch).sort()).toEqual([
      'approve', 'available', 'chooseFolder', 'chooseWorktreeRoot', 'close', 'continueChat', 'forget', 'onStartProgress', 'openWorktree', 'removeWorktree', 'resetWorktreeRoot', 'resume',
      'resumeWithBudget', 'setEnabled', 'setMaxSessions', 'start', 'stop', 'takeOver',
    ])
    // #432 §5: a cap of 1 to 8 only
    for (const bad of [0, 9, 2.5, '4']) expect(await launch.setMaxSessions!(bad)).toEqual({ ok: false, error: 'invalid' })
    expect(await launch.setMaxSessions!(4, 5)).toEqual({ ok: false, error: 'invalid' })
    // #432: a launch id only, never a path
    for (const method of ['removeWorktree', 'openWorktree', 'takeOver', 'forget']) {
      expect(await launch[method]!('/w/alpha')).toEqual({ ok: false, error: 'invalid' })
      expect(await launch[method]!(ID, '/w/alpha')).toEqual({ ok: false, error: 'invalid' })
    }
    expect(await launch.chooseFolder!('/elsewhere')).toEqual({ ok: false, error: 'invalid' })
    // #432: main's own dialog chooses the worktree folder; the page passes nothing
    expect(await launch.chooseWorktreeRoot!('/elsewhere')).toEqual({ ok: false, error: 'invalid' })
    expect(await launch.resetWorktreeRoot!(true)).toEqual({ ok: false, error: 'invalid' })
    expect(await launch.stop!(ID, 'x')).toEqual({ ok: false, error: 'invalid' })
    expect(await launch.stop!('../x')).toEqual({ ok: false, error: 'invalid' })
    expect(await launch.setEnabled!('yes')).toEqual({ ok: false, error: 'invalid' })
    expect(await launch.start!(['/bin/sh'])).toEqual({ ok: false, error: 'invalid' })
    // #451: one request object, which main checks again
    expect(await launch.resumeWithBudget!(ID)).toEqual({ ok: false, error: 'invalid' })
    expect(await launch.resumeWithBudget!({ id: ID }, 1)).toEqual({ ok: false, error: 'invalid' })
    expect(invoke).not.toHaveBeenCalled()
    // a checked answer: nothing beyond the known fields comes back
    expect(await launch.start!(REQUEST)).toEqual({ ok: true, launch: ID, enabled: true })
    expect(invoke).toHaveBeenCalledWith('agent-inbox:launch-start', REQUEST)
  })

  it('continueChat sends a fresh object of the five allowed keys, refuses any other shape before asking main, and keeps a known reason (#586 phase 2)', async () => {
    const request = { tool: 'copilot', id: ID, mode: 'read-only', prompt: 'Go on.', startId: 'tag-0123456789abcdef' }
    const { launch, invoke } = loadPreload(() => ({ ok: false, reason: 'driven', error: 'This chat already has a session here: use Show session.', folder: '/secret', extra: 1 }))
    const invalid = { ok: false, reason: 'invalid', error: 'This chat can’t be continued here.' }
    for (const args of [
      [], [request, 'extra'], [null], [ID], [[request]],
      [{ ...request, cwd: '/Users/tester/dev' }], [{ ...request, env: { PATH: '/evil' } }], [{ ...request, args: ['--yolo'] }], [{ ...request, title: 'x' }],
      [{ ...request, tool: 'sh' }], [{ ...request, id: ID.toUpperCase().replace('2222', 'AAAA') }], [{ ...request, id: `${ID};id` }],
      [{ ...request, mode: 'edits' }], [{ ...request, prompt: ' ' }], [{ ...request, prompt: 'x'.repeat(65_537) }], [{ ...request, startId: 'short' }],
    ]) expect(await launch.continueChat!(...args), JSON.stringify(args).slice(0, 80)).toEqual(invalid)
    expect(invoke).not.toHaveBeenCalled()
    expect(await launch.continueChat!(request)).toEqual({ ok: false, reason: 'driven', error: 'This chat already has a session here: use Show session.' })
    const { startId: _tag, ...untagged } = request
    await launch.continueChat!({ ...untagged, tool: 'claude' })
    expect(invoke.mock.calls).toEqual([['agent-inbox:launch-continue-chat', request], ['agent-inbox:launch-continue-chat', { ...untagged, tool: 'claude' }]])
    // a fresh object, not the page's
    expect(invoke.mock.calls[0]![1]).not.toBe(request)
    // an unknown reason is dropped; a launch and a cancel pass as for every other start
    expect(await loadPreload(() => ({ ok: false, reason: 'shell', error: 'x' })).launch.continueChat!(request)).toEqual({ ok: false, error: 'x' })
    expect(await loadPreload(() => ({ ok: true, launch: ID })).launch.continueChat!(request)).toEqual({ ok: true, launch: ID })
    expect(await loadPreload(() => ({ ok: false, error: 'Not continued.', cancelled: true })).launch.continueChat!(request)).toEqual({ ok: false, error: 'Not continued.', cancelled: true })
    expect(await loadPreload(() => { throw new Error('gone') }).launch.continueChat!(request)).toEqual({ ok: false, error: 'Agent Inbox did not answer.' })
    for (const reason of Object.keys(controllerModule.CHAT_REFUSALS).filter((key) => key !== 'tool').concat('environment')) {
      expect(await loadPreload(() => ({ ok: false, reason, error: 'e' })).launch.continueChat!(request), reason).toEqual({ ok: false, reason, error: 'e' })
    }
  })

  it('onStartProgress keeps one listener, passes only known phases, and null removes it (#432 PR 5)', async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>()
    const exposed: Record<string, unknown> = {}
    const electron = {
      contextBridge: { exposeInMainWorld: (name: string, api: unknown) => { exposed[name] = api } },
      ipcRenderer: {
        invoke: vi.fn(),
        on: (channel: string, fn: (...args: unknown[]) => void) => { listeners.set(channel, fn) },
        removeListener: (channel: string, fn: unknown) => { if (listeners.get(channel) === fn) listeners.delete(channel) },
      },
    }
    const factory = vm.runInThisContext(`(function (require, process) {\n${read('electron/setup-preload.cjs')}\n})`, { filename: 'setup-preload.cjs' }) as
      (require: (id: string) => unknown, process: { argv: string[] }) => void
    factory(() => electron, { argv: [] })
    const launch = exposed.agentInboxLaunch as { onStartProgress: (...args: unknown[]) => boolean }
    const seen: unknown[] = []
    expect(launch.onStartProgress('nope')).toBe(false)
    expect(launch.onStartProgress((phase: string, id?: string, tag?: string) => seen.push([phase, id, tag]))).toBe(true)
    const send = listeners.get('agent-inbox:launch-progress')!
    for (const phase of ['environment', 'shell', 'copilot', { phase: 'runtime' }]) send({}, phase, ID, 'tag-0123456789abcdef')
    send({}, 'copilot', '../x', 'no')
    // only known phases, and only a launch id and a start tag that are one
    expect(seen).toEqual([['environment', ID, 'tag-0123456789abcdef'], ['copilot', ID, 'tag-0123456789abcdef'], ['copilot', undefined, undefined]])
    expect(launch.onStartProgress(null)).toBe(true)
    expect(listeners.has('agent-inbox:launch-progress')).toBe(false)
  })

  it('keeps a terminal only when the launch is available and the value is on the list (#586)', async () => {
    const base = { owned: true, enabled: true, available: true, canEnable: true }
    expect(await loadPreload(() => ({ ...base, terminal: 'iterm2' })).launch.available!()).toEqual({ ...base, terminal: 'iterm2' })
    expect(await loadPreload(() => ({ ...base, terminal: 'terminal' })).launch.available!()).toEqual({ ...base, terminal: 'terminal' })
    for (const terminal of ['Hyper', 'iTerm2', 3, null, {}]) expect(await loadPreload(() => ({ ...base, terminal })).launch.available!()).not.toHaveProperty('terminal')
    expect(await loadPreload(() => ({ ...base, available: false, terminal: 'iterm2' })).launch.available!()).not.toHaveProperty('terminal')
    expect(await loadPreload(() => ({ ...base, enabled: false, terminal: 'iterm2' })).launch.available!()).not.toHaveProperty('terminal')
  })

  it('passes a notice on a result, cut to 500, and nothing else it was not given (#586)', async () => {
    const note = 'iTerm2 could not be opened, so Terminal was opened instead.'
    expect(await loadPreload(() => ({ ok: true, notice: note })).launch.openWorktree!(ID)).toEqual({ ok: true, notice: note })
    expect(await loadPreload(() => ({ ok: true, notice: 'x'.repeat(900) })).launch.takeOver!(ID)).toEqual({ ok: true, notice: 'x'.repeat(500) })
    expect(await loadPreload(() => ({ ok: true, notice: { text: 'x' } })).launch.takeOver!(ID)).toEqual({ ok: true })
  })

  it('says off unless main says the owned viewer has the switch on and the grant', async () => {
    const off = loadPreload(() => ({ owned: true, enabled: false, available: true, canEnable: true }))
    expect(await off.launch.available!()).toEqual({ owned: true, enabled: false, available: false, canEnable: true })
    const broken = loadPreload(() => { throw new Error('gone') })
    expect(await broken.launch.available!()).toEqual({ owned: false, enabled: false, available: false, canEnable: false })
    // #432: the worktree folder only with the switch on and the grant, and only as a checked absolute path
    const on = loadPreload(() => ({ owned: true, enabled: true, available: true, canEnable: true, worktreeRoot: { path: '/w', isDefault: true, extra: 1 } }))
    expect(await on.launch.available!()).toEqual({ owned: true, enabled: true, available: true, canEnable: true, worktreeRoot: { path: '/w', isDefault: true } })
    const offRoot = loadPreload(() => ({ owned: true, enabled: false, available: false, canEnable: true, worktreeRoot: { path: '/w', isDefault: true } }))
    expect(await offRoot.launch.available!()).not.toHaveProperty('worktreeRoot')
    const relative = loadPreload(() => ({ owned: true, enabled: true, available: true, worktreeRoot: { path: 'w', isDefault: false } }))
    expect(await relative.launch.available!()).not.toHaveProperty('worktreeRoot')
  })
})

describe('main’s wiring (source)', () => {
  const main = read('electron/main.cjs')

  it('grants launch only to the owned viewer, with the switch on, on macOS, and drops it when a quit begins', () => {
    expect(main).toContain("launchAllowed: () => viewerOwned && launchEnabled && process.platform === 'darwin',")
    expect(main).toContain('launchWebContentsId = launch ? setupWindowWebContentsId : null')
    const begin = main.slice(main.indexOf('function beginAppQuit()'), main.indexOf('installGate.beginQuit()'))
    expect(begin).toContain('launchWebContentsId = null')
    expect(begin).toContain('launchController?.beginQuit()')
    // the quit prompt waits for a start already past the gate, so it lists that launch too
    const ask = main.slice(main.indexOf('async function askAboutRunningSessions()'))
    expect(ask.slice(0, ask.indexOf('quitChoice('))).toContain('await runningAtQuit(launchControllerFor())')
  })

  it('sends a start’s phases only to the window holding the launch grant (#432 PR 5)', () => {
    expect(main).toContain('const target = launchWebContentsId === null ? null : BrowserWindow.getAllWindows().map((win) => win.webContents).find((wc) => wc.id === launchWebContentsId)')
    expect(main).toContain("if (target && !target.isDestroyed()) target.send('agent-inbox:launch-progress', phase, launch, startId)")
    expect(main.match(/'agent-inbox:launch-progress'/g)).toHaveLength(1)
  })

  it('opens a terminal only through terminal-launch.cjs, with a fixed argv and no shell, and runs worktree commands from the verified runtime (#432, #586)', () => {
    expect(main).toContain("execFile(command.file, command.args, { env: { PATH: '/usr/bin:/bin' }, timeout: 10_000 }, (error) => resolve(runOutcome(error)))")
    expect(main).toContain('read: () => linkPrefs().readTerminal(),')
    expect(main).not.toContain('openTerminal')
    expect(main).not.toContain("'/usr/bin/open'")
    expect(main).not.toContain("'-a'")
    expect(read('electron/terminal-launch.cjs').match(/'\/usr\/bin\/open'/g)).toHaveLength(1)
    // step 5: the Take over script, written 0700 by temp file and rename, opened by that same argv
    expect(main).toContain('writeFileSync(temp, text, { mode: 0o700 })')
    expect(main).toContain('renameSync(temp, file)')
    expect(main).toContain('runWorktree: (args) => runWorktreeCommand({ ...args, spawnImpl: spawn }),')
  })

  it('registers the launch IPC once, behind the viewer-window sender check, and opens no launch channel of its own', () => {
    expect(main.match(/registerLaunchIpc\(/g)).toHaveLength(1)
    expect(main).toContain('isGranted: (event) => linkSender(event) && launchWebContentsId !== null && event.sender.id === launchWebContentsId,')
    expect(main).toContain('isOwned: (event) => linkSender(event) && linkFilesPermitted(event),')
    expect(main).not.toMatch(/ipcMain\.handle\('agent-inbox:launch-/)
  })

  it('reads the switch only for the owned viewer on macOS, and asks at quit only with it on', () => {
    expect(main).toContain("launchEnabled = process.platform === 'darwin' && (await launchSettings().read()).enabled")
    expect(main).toContain('if (launchEnabled && viewerOwned && !launchQuitAsked) {')
    // the master key lives in userData, encrypted by safeStorage, never anywhere else
    expect(main).toContain("createLaunchKeys({ safeStorage, filePath: path.join(app.getPath('userData'), 'launch-master-key') })")
    // #586 phase 2: Continue here… matches COPILOT_HOME against the home folder whose .copilot the index reads
    expect(main).toContain("homeDir: app.getPath('home'),")
    // ...and Resume in Terminal asks it, through its accessor, whether a chat is being continued
    expect(main).toContain('isContinuing: (id) => launchController !== null && launchController.isContinuing(id) === true,')
    expect(main).not.toMatch(/console\.(log|error)\([^)]*(launchKey|masterKey|spec)/)
  })
})
