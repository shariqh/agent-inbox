import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
