// Issue #412 step 3, PR 2: Electron main's control of driven sessions, tested
// without Electron (everything is injected): the switch's file, the
// safeStorage-held key and the approval MAC, the login-shell env capture, the
// driver's exact start, the controller (what the renderer may send, the native
// confirmation, the §9 off contract, the launch gate), the IPC and its grants,
// the window binding's `launch` grant, the preload bridge and main's wiring.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import sessionLaunch from '../electron/session-launch.cjs'
import launchKeys from '../electron/launch-key.cjs'
import shellEnv from '../electron/shell-env.cjs'
import driverProcess from '../electron/driver-process.cjs'
import controllerModule from '../electron/launch-controller.cjs'
import launchIpc from '../electron/launch-ipc.cjs'
import { terminalSafe } from '../src/driver-policy.js'
import { verifyApproval } from '../src/launch-sign.js'
import { parseLaunchSpec } from '../src/launch-spec.js'
import { launchKey as fixtureLaunchKey, sign as fixtureSign } from './launch-fixtures.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

const REPO = join(import.meta.dirname, '..')
type Binding = { navigationStarted(url: string): void; navigationCommitted(url: string): Promise<boolean>; refresh(): void }
const setupRunner = createRequire(import.meta.url)('../electron/setup-runner.cjs') as {
  createInstallBinding(options: Json): Binding
  installedDriverRuntime(options: Json): { node?: string; entry?: string; error?: string }
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

// The controller with every effect recorded
function rig(over: Json = {}) {
  const calls: string[] = []
  const spawned: Json[] = []
  const state = { enabled: true, folders: [{ root: '/work/alpha', project: 'alpha' }] as unknown, launches: {} as Record<string, Json>, confirm: true }
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
      'GET /api/launch-folders', 'driverRuntime', 'confirm', 'captureEnv /work/alpha', 'keys.launchKey', 'startDriver',
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
    expect(edits.detail).toContain('Mode: Edits in the worktree. File edits inside the project folder run without asking, never a .git folder or file;')
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

  it('off means off (§9 e): no env, no runtime, no spawn, no folder read, no key, and available() says off', async () => {
    const r = rig()
    r.state.enabled = false
    expect(r.controller.available()).toEqual({ enabled: false, available: false, error: expect.stringMatching(/is off/) })
    for (const result of [
      await r.controller.start(REQUEST), await r.controller.resume(ID), await r.controller.approve({ item: 'item-1', revision: 2, optionId: 'allow_once' }),
    ]) expect(result.ok).toBe(false)
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

  it('registers the seven channels, and makes no controller until one is used', () => {
    const w = world()
    expect([...w.handlers.keys()].sort()).toEqual([
      'available', 'approve', 'close', 'resume', 'set-enabled', 'start', 'stop',
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

  it('has exactly its seven methods, each with exact arity, and passes nothing it was not given', async () => {
    const { launch, invoke } = loadPreload(() => ({ ok: true, launch: ID, path: '/secret', enabled: true }))
    expect(Object.keys(launch).sort()).toEqual(['approve', 'available', 'close', 'resume', 'setEnabled', 'start', 'stop'])
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
