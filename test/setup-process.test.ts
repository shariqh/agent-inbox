import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hookLaunchers, hooksHome, installRuntime } from './hooks-runtime.js'

const require = createRequire(import.meta.url)
const { createSetupProcessRunner } = require('../electron/setup-process.cjs') as {
  createSetupProcessRunner(options?: {
    platform?: NodeJS.Platform
    env?: NodeJS.ProcessEnv
    maxOutput?: number
    timeoutMs?: number
    spawnImpl?: (...args: any[]) => FakeChild
    killImpl?: (pid: number, signal: NodeJS.Signals) => void
  }): {
    id: string
    start(
      operation: {
        repoRoot: string
        target: string
        runtime: null | { sourceRoot: string; manifestDigest: string }
      },
      options?: { onCancel?: (cancel: () => void) => void },
    ): Promise<{
      ok: boolean
      exitCode: number | null
      output: string
      target: string
      timedOut: boolean
      cancelled: boolean
    }>
  }
}

interface FakeChild extends EventEmitter {
  pid: number
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
}

function child(pid = 4242): FakeChild {
  return Object.assign(new EventEmitter(), {
    pid,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  })
}

function fixture(script = '#!/bin/bash\nexit 0\n'): string {
  const root = mkdtempSync(join(tmpdir(), 'setup-process-'))
  const installer = join(root, 'scripts', 'install-agents.sh')
  mkdirSync(dirname(installer), { recursive: true })
  writeFileSync(installer, script)
  return root
}

afterEach(() => {
  vi.useRealTimers()
})

describe('fixed-purpose Setup process runner', () => {
  it('constructs the exact dev installer command internally', async () => {
    const root = fixture()
    const spawned = child()
    let call: unknown[] = []
    const runner = createSetupProcessRunner({
      platform: 'darwin',
      env: { HOME: '/Users/tester', PATH: '/usr/bin:/bin', MARKER: 'kept' },
      spawnImpl: (...args) => {
        call = args
        queueMicrotask(() => spawned.emit('close', 0))
        return spawned
      },
    })

    const result = await runner.start({
      repoRoot: root,
      target: 'copilot',
      runtime: null,
    })

    expect(runner.id).toBe('posix-shell-v1')
    expect(call[0]).toBe('/bin/bash')
    expect(call[1]).toEqual([
      join(root, 'scripts', 'install-agents.sh'),
      '--apply',
      '--target',
      'copilot',
    ])
    expect(call[2]).toMatchObject({
      cwd: root,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        HOME: '/Users/tester',
        MARKER: 'kept',
      },
    })
    expect((call[2] as { env: NodeJS.ProcessEnv }).env.PATH).toBe(
      '/Users/tester/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin',
    )
    expect((call[2] as Record<string, unknown>)).not.toHaveProperty('shell')
    expect(result).toMatchObject({
      ok: true,
      exitCode: 0,
      target: 'copilot',
      timedOut: false,
      cancelled: false,
    })
  })

  it('adds only the exact verified runtime source and digest on Linux', async () => {
    const root = fixture()
    const spawned = child()
    let argv: string[] = []
    const runner = createSetupProcessRunner({
      platform: 'linux',
      spawnImpl: (_executable, args) => {
        argv = args
        queueMicrotask(() => spawned.emit('close', 0))
        return spawned
      },
    })
    const digest = `sha256:${'a'.repeat(64)}`

    const result = await runner.start({
      repoRoot: root,
      target: 'all',
      runtime: { sourceRoot: root, manifestDigest: digest },
    })

    expect(argv).toEqual([
      join(root, 'scripts', 'install-agents.sh'),
      '--apply',
      '--target',
      'all',
      '--runtime-source',
      root,
      '--runtime-digest',
      digest,
    ])
    expect(result.ok).toBe(true)
  })

  it.each(['win32', 'aix'] as const)('fails closed on unsupported platform %s before spawn', async (platform) => {
    const root = fixture()
    const spawnImpl = vi.fn()
    const runner = createSetupProcessRunner({ platform, spawnImpl })

    const result = await runner.start({
      repoRoot: root,
      target: 'claude',
      runtime: null,
    })

    expect(spawnImpl).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      ok: false,
      exitCode: null,
      target: 'claude',
      timedOut: false,
      cancelled: false,
    })
    expect(result.output).toMatch(new RegExp(`unsupported on ${platform}`, 'i'))
  })

  it.each([
    ['invalid target', { target: '../anything', runtime: null }, /invalid setup target/i],
    ['relative repository root', { repoRoot: 'checkout', target: 'all', runtime: null }, /invalid setup repository root/i],
    ['missing runtime digest', { target: 'all', runtime: { sourceRoot: '/payload', manifestDigest: '' } }, /invalid runtime/i],
    ['relative runtime source', { target: 'all', runtime: { sourceRoot: 'payload', manifestDigest: `sha256:${'a'.repeat(64)}` } }, /invalid runtime/i],
  ])('rejects %s without spawning', async (_label, operation, error) => {
    const root = fixture()
    const spawnImpl = vi.fn()
    const runner = createSetupProcessRunner({ platform: 'darwin', spawnImpl })

    const result = await runner.start({ repoRoot: root, ...operation })

    expect(spawnImpl).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(error)
  })

  it('rejects a missing installer without spawning', async () => {
    const root = mkdtempSync(join(tmpdir(), 'setup-process-missing-'))
    const spawnImpl = vi.fn()
    const runner = createSetupProcessRunner({ platform: 'linux', spawnImpl })

    const result = await runner.start({ repoRoot: root, target: 'all', runtime: null })

    expect(spawnImpl).not.toHaveBeenCalled()
    expect(result.output).toMatch(/installer not found/i)
  })

  it('returns a bounded failure when spawn throws', async () => {
    const root = fixture()
    const runner = createSetupProcessRunner({
      platform: 'darwin',
      spawnImpl: () => {
        throw new Error('spawn refused')
      },
    })

    const result = await runner.start({ repoRoot: root, target: 'all', runtime: null })

    expect(result).toMatchObject({ ok: false, exitCode: null, timedOut: false, cancelled: false })
    expect(result.output).toBe('Could not start installer: spawn refused')
  })

  it('settles once when a child error is followed by close', async () => {
    const root = fixture()
    const spawned = child()
    const runner = createSetupProcessRunner({
      platform: 'linux',
      spawnImpl: () => {
        queueMicrotask(() => {
          spawned.emit('error', new Error('exec failed'))
          spawned.emit('close', 0)
        })
        return spawned
      },
    })

    const result = await runner.start({ repoRoot: root, target: 'all', runtime: null })

    expect(result).toMatchObject({ ok: false, exitCode: null, timedOut: false, cancelled: false })
    expect(result.output).toBe('Could not start installer: exec failed')
  })

  it('preserves cancellation and waits for the installer cleanup result', async () => {
    const root = fixture()
    const spawned = child()
    const killImpl = vi.fn()
    let cancel = () => {}
    const runner = createSetupProcessRunner({
      platform: 'darwin',
      spawnImpl: () => spawned,
      killImpl,
    })
    const resultPromise = runner.start(
      { repoRoot: root, target: 'claude', runtime: null },
      { onCancel(fn) { cancel = fn } },
    )

    cancel()
    spawned.stderr.write('rolled back\n')
    spawned.emit('close', 130)
    const result = await resultPromise

    expect(killImpl).toHaveBeenCalledWith(-spawned.pid, 'SIGTERM')
    expect(spawned.kill).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: false, cancelled: true, timedOut: false, exitCode: 130 })
    expect(result.output).toContain('Agent Inbox is closing')
    expect(result.output).toContain('rolled back')
  })

  it('times out, escalates the process group, and bounds captured output', async () => {
    vi.useFakeTimers()
    const root = fixture()
    const spawned = child()
    const killImpl = vi.fn()
    const runner = createSetupProcessRunner({
      platform: 'linux',
      timeoutMs: 25,
      maxOutput: 64,
      spawnImpl: () => spawned,
      killImpl,
    })
    const resultPromise = runner.start({ repoRoot: root, target: 'all', runtime: null })
    spawned.stdout.write('x'.repeat(256))

    await vi.advanceTimersByTimeAsync(25)
    expect(killImpl).toHaveBeenCalledWith(-spawned.pid, 'SIGTERM')
    await vi.advanceTimersByTimeAsync(10_000)
    const result = await resultPromise

    expect(killImpl).toHaveBeenLastCalledWith(-spawned.pid, 'SIGKILL')
    expect(result).toMatchObject({ ok: false, timedOut: true, cancelled: false, exitCode: null })
    expect(result.output).toContain('[output truncated]')
    expect(result.output).toContain('Installer timed out after 25ms')
  })
})

// #206: the one more fixed form this boundary builds. Claude's hooks move only
// through an INSTALLED runtime's own hook installer, in runtime mode, applied
// and never forced: the caller names a directory, never a script or argument.
describe('the Claude hooks target (#206)', () => {
  /** An installed runtime as far as this boundary looks: a runtime manifest and its hook installer. */
  function installed(script = '#!/bin/bash\nexit 0\n'): string {
    const root = mkdtempSync(join(tmpdir(), 'setup-process-hooks-'))
    mkdirSync(join(root, 'scripts'), { recursive: true })
    writeFileSync(join(root, 'scripts', 'install-hooks.sh'), script)
    writeFileSync(join(root, 'runtime-manifest.json'), '{}\n')
    return root
  }

  it('runs exactly /bin/bash <runtime>/scripts/install-hooks.sh --apply --move-only from that runtime', async () => {
    const root = installed()
    const spawned = child()
    let call: unknown[] = []
    const runner = createSetupProcessRunner({
      platform: 'darwin',
      env: { HOME: '/Users/tester', PATH: '/usr/bin:/bin' },
      spawnImpl: (...args) => {
        call = args
        queueMicrotask(() => spawned.emit('close', 0))
        return spawned
      },
    })

    const result = await runner.start({ repoRoot: root, target: 'hooks', runtime: null })

    expect(call[0]).toBe('/bin/bash')
    expect(call[1]).toEqual([join(root, 'scripts', 'install-hooks.sh'), '--apply', '--move-only'])
    expect(call[2]).toMatchObject({ cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    expect((call[2] as Record<string, unknown>)).not.toHaveProperty('shell')
    expect(result).toMatchObject({ ok: true, exitCode: 0, target: 'hooks', timedOut: false, cancelled: false })
  })

  it.each([
    // a checkout's installer would bake the checkout's own Node, never a runtime's
    ['a checkout, with no runtime manifest', () => {
      const root = installed()
      return { root, operation: { repoRoot: root, target: 'hooks', runtime: null }, rm: 'runtime-manifest.json' }
    }, /installed runtime/i],
    // the hooks form takes no runtime arguments at all
    ['runtime source arguments', () => {
      const root = installed()
      return { root, operation: { repoRoot: root, target: 'hooks', runtime: { sourceRoot: root, manifestDigest: `sha256:${'a'.repeat(64)}` } } }
    }, /installed runtime/i],
    ['a runtime with no hook installer', () => {
      const root = installed()
      return { root, operation: { repoRoot: root, target: 'hooks', runtime: null }, rm: 'scripts/install-hooks.sh' }
    }, /installer not found/i],
    ['a relative runtime directory', () => {
      const root = installed()
      return { root, operation: { repoRoot: 'runtime', target: 'hooks', runtime: null } }
    }, /invalid setup repository root/i],
  ] as const)('refuses %s without spawning', async (_label, arrange, error) => {
    const { root, operation, rm } = arrange() as {
      root: string
      operation: { repoRoot: string; target: string; runtime: null | { sourceRoot: string; manifestDigest: string } }
      rm?: string
    }
    if (rm) rmSync(join(root, rm))
    const spawnImpl = vi.fn()
    const runner = createSetupProcessRunner({ platform: 'linux', spawnImpl })

    const result = await runner.start(operation)

    expect(spawnImpl).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: false, exitCode: null, target: 'hooks' })
    expect(result.output).toMatch(error)
  })

  it.each(['win32', 'aix'] as const)('fails closed for hooks on unsupported platform %s before spawn', async (platform) => {
    const spawnImpl = vi.fn()
    const runner = createSetupProcessRunner({ platform, spawnImpl })

    const result = await runner.start({ repoRoot: installed(), target: 'hooks', runtime: null })

    expect(spawnImpl).not.toHaveBeenCalled()
    expect(result.output).toMatch(new RegExp(`unsupported on ${platform}`, 'i'))
  })

  // The real installer in a scratch HOME: the hooks a v1.0.0 Setup runtime
  // installed move to the v1.1.0 runtime, in place, with a timestamped backup,
  // under the shared setup lock, and nothing else in the settings file changes.
  it.skipIf(!['darwin', 'linux'].includes(process.platform))(
    'moves Setup-runtime hooks onto the runtime it runs from, through the real installer',
    async () => {
      const h = hooksHome()
      const older = installRuntime(h, '1.0.0')
      mkdirSync(dirname(h.settings), { recursive: true })
      writeFileSync(h.settings, JSON.stringify({ model: 'x', hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }))
      const first = spawnSync('/bin/bash', [join(older.dir, 'scripts', 'install-hooks.sh'), '--apply'], { encoding: 'utf8', env: h.env })
      expect(first.status, first.stderr).toBe(0)
      expect(new Set(hookLaunchers(h).map((hook) => hook.entry))).toEqual(new Set([join(older.dir, 'dist', 'hook-cli.js')]))
      const before = readdirSync(dirname(h.settings)).filter((name) => name.includes('.bak.')).length
      const newer = installRuntime(h, '1.1.0')
      // the seeding run above took the lock; this one must take it again
      const lock = join(h.home, '.agent-inbox', 'install-agents.lock')
      rmSync(lock)

      const result = await createSetupProcessRunner({ env: h.env }).start({ repoRoot: newer.dir, target: 'hooks', runtime: null })

      expect(result, result.output).toMatchObject({ ok: true, exitCode: 0, target: 'hooks', timedOut: false, cancelled: false })
      expect(result.output).toContain('agent-inbox hooks installed in')
      // Setup shows this output verbatim: no claim that only a fresh session sees hooks,
      // which Claude Code's settings watcher contradicts
      expect(result.output).toContain('Claude Code reads hooks when a session starts and normally applies a change to running sessions too; restart a session to be sure it has this one.')
      expect(result.output).not.toMatch(/FRESH/)
      const hooks = hookLaunchers(h)
      expect(hooks.length).toBeGreaterThan(0)
      for (const hook of hooks) {
        expect(hook).toEqual({ command: join(newer.dir, 'bin', 'node'), entry: join(newer.dir, 'dist', 'hook-cli.js') })
      }
      const settings = JSON.parse(readFileSync(h.settings, 'utf8')) as { model: string; hooks: Record<string, unknown> }
      expect(settings.model).toBe('x')
      expect(settings.hooks['PostToolUse']).toEqual([{ hooks: [{ type: 'command', command: 'echo hi' }] }])
      expect(readdirSync(dirname(h.settings)).filter((name) => name.includes('.bak.')).length).toBe(before + 1)
      // it ran under the shared setup lock, in the scratch HOME
      expect(existsSync(lock)).toBe(true)
    },
  )

  // Review of #236: the renderer offers the step only for a Setup runtime's
  // hooks, but nothing below it checked. `--move-only` makes the installer
  // itself refuse, under the setup lock, when there is no Setup runtime's set
  // to move: a direct `hooks` run never installs hooks afresh.
  describe.skipIf(!['darwin', 'linux'].includes(process.platform))('--move-only', () => {
    const NOTHING = /has no Claude hooks from a Setup runtime to move, so nothing was written/

    it.each([
      ['no settings file', null],
      ['settings without hooks', '{"model":"x"}\n'],
      ['only another tool\'s hooks', `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } })}\n`],
    ] as const)('writes nothing and exits 1 through Setup where there is %s', async (_label, contents) => {
      const h = hooksHome()
      if (contents !== null) {
        mkdirSync(dirname(h.settings), { recursive: true })
        writeFileSync(h.settings, contents)
      }
      const runtime = installRuntime(h, '1.1.0')

      const result = await createSetupProcessRunner({ env: h.env }).start({ repoRoot: runtime.dir, target: 'hooks', runtime: null })

      expect(result).toMatchObject({ ok: false, exitCode: 1, target: 'hooks' })
      expect(result.output).toMatch(NOTHING)
      if (contents === null) {
        expect(existsSync(h.settings)).toBe(false)
      } else {
        expect(readFileSync(h.settings, 'utf8')).toBe(contents)
        expect(readdirSync(dirname(h.settings)).filter((name) => name !== 'settings.json')).toEqual([])
      }
    })

    it('is refused outside a packaged runtime, before anything is read', () => {
      const h = hooksHome()
      const checkout = mkdtempSync(join(tmpdir(), 'move-only-checkout-'))
      mkdirSync(join(checkout, 'scripts'))
      for (const script of ['install-hooks.sh', 'setup-lock.sh']) {
        writeFileSync(join(checkout, 'scripts', script), readFileSync(join(import.meta.dirname, '..', 'scripts', script)))
      }

      const result = spawnSync('/bin/bash', [join(checkout, 'scripts', 'install-hooks.sh'), '--apply', '--move-only'], { encoding: 'utf8', env: h.env })

      expect(result.status).toBe(2)
      expect(result.stderr).toMatch(/--move-only moves a Setup runtime's hooks/)
      expect(existsSync(join(h.home, '.claude'))).toBe(false)
    })

    it('cannot be combined with --uninstall or --force in the config helper', () => {
      const h = hooksHome()
      const helper = join(import.meta.dirname, '..', 'scripts', 'runtime-config.mjs')
      for (const flag of ['--uninstall', '--force']) {
        const result = spawnSync(process.execPath, [
          helper, 'hooks', '--settings', h.settings, '--node', process.execPath, '--entry', '/x/dist/hook-cli.js', '--move-only', flag,
        ], { encoding: 'utf8', env: h.env })
        expect(result.status, flag).toBe(2)
        expect(result.stderr).toMatch(/--move-only .* cannot be combined with --uninstall or --force/)
      }
    })
  })
})
