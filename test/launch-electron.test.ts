// Issue #412 step 3, PR 2: Electron main's control of driven sessions, tested
// without Electron (everything is injected): the switch's file, the
// safeStorage-held key and the approval MAC, the login-shell env capture, the
// driver's exact start, the controller (what the renderer may send, the native
// confirmation, the §9 off contract, the launch gate), the IPC and its grants,
// the window binding's `launch` grant, the preload bridge and main's wiring.
import { spawn } from 'node:child_process'
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
      return { ok: true, env: { PATH: '/opt/bin:/usr/bin', SECRET: 's', ELECTRON_RUN_AS_NODE: '1', AGENT_INBOX_DB: '/x', NODE_OPTIONS: '--x', COPILOT_ALLOW_ALL: '1', COPILOT_HOME: '/c' } }
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
    openTerminal: async (folder: string) => { calls.push(`openTerminal ${folder}`); return true },
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

  it('resumes only a parked launch, with no second confirmation, in its own folder', async () => {
    const r = rig()
    r.state.launches[ID] = { id: ID, status: 'running', cwd: '/work/alpha' }
    expect(await r.controller.resume(ID)).toEqual({ ok: false, error: 'This session is not parked.' })
    r.state.launches[ID] = { id: ID, status: 'parked', cwd: '/work/alpha' }
    expect(await r.controller.resume(ID)).toEqual({ ok: true, launch: ID })
    expect(r.calls).not.toContain('confirm')
    expect(r.calls).toContain('captureEnv /work/alpha')
    const spec = r.spawned.at(-1)!.spec as Json
    expect(parseLaunchSpec(JSON.stringify(spec), ID)).toMatchObject({ ok: true, spec: { kind: 'resume', launchId: ID } })
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
    expect(args.timeoutMs).toBe(150_000)
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
      expect(r.calls).toContain('openTerminal /w/alpha/fix-22222222')
      for (const over of [{ worktree_removed_at: '2026-11-03T12:00:00.000Z' }, { worktree_path: '/missing/x' }, { worktree_path: null }]) {
        const refusedRig = rig()
        refusedRig.state.launches[ID] = { ...ENDED, ...over }
        expect(await refusedRig.controller.openWorktree(ID)).toMatchObject({ ok: false })
        expect(refusedRig.calls.filter((c) => c.startsWith('openTerminal'))).toEqual([])
      }
      expect(await r.controller.openWorktree('../x')).toMatchObject({ ok: false })
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

  it('registers the thirteen channels, and makes no controller until one is used', () => {
    const w = world()
    expect([...w.handlers.keys()].sort()).toEqual([
      'available', 'approve', 'choose-folder', 'choose-worktree-root', 'close', 'open-worktree', 'remove-worktree', 'reset-worktree-root', 'resume',
      'set-enabled', 'set-max-sessions', 'start', 'stop',
    ].map((name) => `agent-inbox:launch-${name}`).sort())
    expect(w.made()).toBe(0)
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
    for (const channel of ['launch-remove-worktree', 'launch-open-worktree']) expect(await owned.call(channel, ID)).toMatchObject({ ok: false })
    expect(owned.r.calls).toEqual([])
    const w = world()
    w.r.state.launches[ID] = owned.r.state.launches[ID]!
    expect(await w.call('launch-remove-worktree')).toEqual({ ok: false, error: 'invalid' })
    expect(await w.call('launch-open-worktree', ID, '/w')).toEqual({ ok: false, error: 'invalid' })
    expect(await w.call('launch-open-worktree', ID)).toEqual({ ok: true })
    expect(await w.call('launch-remove-worktree', ID)).toEqual({ ok: true })
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

  it('has exactly its thirteen methods, each with exact arity, and passes nothing it was not given', async () => {
    const { launch, invoke } = loadPreload(() => ({ ok: true, launch: ID, path: '/secret', enabled: true }))
    expect(Object.keys(launch).sort()).toEqual([
      'approve', 'available', 'chooseFolder', 'chooseWorktreeRoot', 'close', 'openWorktree', 'removeWorktree', 'resetWorktreeRoot', 'resume', 'setEnabled',
      'setMaxSessions', 'start', 'stop',
    ])
    // #432 §5: a cap of 1 to 8 only
    for (const bad of [0, 9, 2.5, '4']) expect(await launch.setMaxSessions!(bad)).toEqual({ ok: false, error: 'invalid' })
    expect(await launch.setMaxSessions!(4, 5)).toEqual({ ok: false, error: 'invalid' })
    // #432: a launch id only, never a path
    for (const method of ['removeWorktree', 'openWorktree']) {
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
    expect(invoke).not.toHaveBeenCalled()
    // a checked answer: nothing beyond the known fields comes back
    expect(await launch.start!(REQUEST)).toEqual({ ok: true, launch: ID, enabled: true })
    expect(invoke).toHaveBeenCalledWith('agent-inbox:launch-start', REQUEST)
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
    const begin = main.slice(main.indexOf('function beginAppQuit()'), main.indexOf('return installGate.beginQuit()'))
    expect(begin).toContain('launchWebContentsId = null')
    expect(begin).toContain('launchController?.beginQuit()')
    // the quit prompt waits for a start already past the gate, so it lists that launch too
    const ask = main.slice(main.indexOf('async function askAboutRunningSessions()'))
    expect(ask.slice(0, ask.indexOf('quitChoice('))).toContain('await runningAtQuit(launchControllerFor())')
  })

  it('opens Terminal at a worktree with a fixed argv and no shell, and runs worktree commands from the verified runtime (#432)', () => {
    expect(main).toContain("execFile('/usr/bin/open', ['-a', 'Terminal', '--', folder], { env: { PATH: '/usr/bin:/bin' }, timeout: 10_000 }, (error) => resolve(!error))")
    expect(main.match(/'\/usr\/bin\/open'/g)).toHaveLength(1)
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
    expect(main).not.toMatch(/console\.(log|error)\([^)]*(launchKey|masterKey|spec)/)
  })
})
