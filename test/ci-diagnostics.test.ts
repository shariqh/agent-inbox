import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PoolOptions } from 'vitest/node'
import { CI_DIAGNOSTICS_ENV, EXIT_WAIT_MS, ciDiagnostics } from './ci-diagnostics.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

const root = resolve(process.cwd())
const workflow = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')
const config = readFileSync(join(root, 'vitest.config.ts'), 'utf8')
const UPLOAD = 'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2'

function step(name: string): string {
  const marker = `      - name: ${name}\n`
  const start = workflow.indexOf(marker)
  if (start < 0) return ''
  const rest = workflow.slice(start + marker.length)
  const next = rest.search(/^ {6}- /m)
  return marker + (next < 0 ? rest : rest.slice(0, next))
}

afterEach(() => {
  removeScratchDirs()
  vi.restoreAllMocks()
})

describe('CI crash diagnostics (#359)', () => {
  it('is off unless the CI-only variable names a directory', () => {
    expect(ciDiagnostics({})).toBeUndefined()
    expect(ciDiagnostics({ [CI_DIAGNOSTICS_ENV]: '' })).toBeUndefined()
    expect(config).toContain('const diagnostics = ciDiagnostics(process.env)')
    expect(config).toContain('...(diagnostics ?? {}),')
  })

  it('gives only the fork workers fatal-error report flags, never NODE_OPTIONS', () => {
    const dir = scratchDir('ci-diagnostics-')
    const d = ciDiagnostics({ [CI_DIAGNOSTICS_ENV]: dir })
    expect(d?.execArgv).toEqual([
      '--report-on-fatalerror',
      // the artifact is public: no runner environment, no network handles
      '--report-exclude-env',
      '--report-exclude-network',
      `--report-directory=${join(dir, 'node-reports')}`,
    ])
    expect(existsSync(join(dir, 'node-reports'))).toBe(true)
    // a built-in name would bypass createPoolWorker
    expect(d?.pool.name).not.toMatch(/^(forks|threads|vmForks|vmThreads|typescript|browser)$/)
    expect(workflow).not.toContain('NODE_OPTIONS')
    expect(workflow).not.toContain('--report-on-fatalerror')
  })

  type FakeChild = EventEmitter & {
    pid: number
    exitCode: number | null
    signalCode: NodeJS.Signals | null
    send: (m: unknown) => void
  }

  // the custom pool's worker around a fake child, as Vitest's PoolRunner drives it:
  // it listens for 'error' and 'exit' after start, and a stop removes only 'exit'
  // (cli-api L3025); 'error' stays until the child is gone
  function fakeWorker() {
    const dir = scratchDir('ci-diagnostics-')
    const d = ciDiagnostics({ [CI_DIAGNOSTICS_ENV]: dir })
    const logger = { outputStream: process.stdout, errorStream: process.stderr }
    const worker = d!.pool.createPoolWorker({
      distPath: root,
      project: { vitest: { logger } },
      execArgv: [],
      env: {},
    } as unknown as PoolOptions)
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      exitCode: null,
      signalCode: null,
      send: () => {},
    }) as FakeChild
    ;(worker as unknown as { _fork: unknown })._fork = child
    const written: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk))
      return true
    })
    worker.send({
      __vitest_worker_request__: true,
      type: 'run',
      context: { files: [{ filepath: '/repo/test/dom/a.test.ts' }] },
    } as never)
    const onError = vi.fn()
    const onExit = vi.fn()
    worker.on('error', onError)
    worker.on('exit', onExit)
    const lines = (): string[] => written.join('').split('\n').filter(Boolean)
    const log = (): string => readFileSync(join(dir, 'worker-exits.log'), 'utf8')
    const stop = (): void => worker.off('exit', onExit)
    const exitLog = join(dir, 'worker-exits.log')
    // the child dies: Node sets these before it emits 'exit'
    const die = (signal: NodeJS.Signals): void => {
      child.signalCode = signal
      child.emit('exit', null, signal)
    }
    return { worker, child, written, lines, log, exitLog, onError, onExit, stop, die }
  }

  const epipe = (): Error => Object.assign(new Error('write EPIPE'), { code: 'EPIPE', errno: -32 })
  const line = (code: string, signal: string): RegExp => new RegExp(
    `^\\[ci-diagnostics\\] Vitest fork worker pid 4242 exited unexpectedly: code=${code} ` +
    `signal=${signal} free=\\d+ MB of \\d+ MB files=/repo/test/dom/a\\.test\\.ts$`,
  )

  it('names the exit code, signal and files when a worker exits unexpectedly', () => {
    const w = fakeWorker()
    // a message shape Vitest might change must never break a worker's start
    w.worker.send({ __vitest_worker_request__: true, type: 'collect' } as never)
    w.worker.send({
      __vitest_worker_request__: true,
      type: 'run',
      context: { files: [{ filepath: '/repo/test/dom/a.test.ts' }] },
    } as never)
    w.die('SIGKILL')
    // a failed write after the exit adds nothing
    w.child.emit('error', epipe())

    expect(w.onExit).toHaveBeenCalledOnce()
    expect(w.onError).toHaveBeenCalledOnce()
    expect(w.lines()).toHaveLength(1)
    expect(w.lines()[0]).toMatch(line('null', 'SIGKILL'))
    expect(w.log()).toBe(w.written.join(''))

    // Vitest removes its 'exit' listener before a requested stop: that exit stays silent
    w.stop()
    expect(w.child.listenerCount('exit')).toBe(0)
    expect(w.child.listenerCount('error')).toBe(1)
  })

  it('stays silent when a stopped worker dies or a write to it fails', () => {
    const w = fakeWorker()
    w.stop()
    w.child.signalCode = 'SIGTERM'
    w.child.emit('error', epipe())
    w.child.emit('exit', null, 'SIGTERM')
    expect(w.onError).toHaveBeenCalledOnce()
    expect(w.lines()).toHaveLength(0)
    expect(existsSync(w.exitLog)).toBe(false)
  })

  it('names the pid of its own child after Vitest clears it', () => {
    const w = fakeWorker()
    ;(w.worker as unknown as { _fork: unknown })._fork = undefined
    w.die('SIGKILL')
    expect(w.lines()).toHaveLength(1)
    expect(w.lines()[0]).toMatch(line('null', 'SIGKILL'))
  })

  it('reports a synchronous send failure and rethrows it unchanged', () => {
    const w = fakeWorker()
    const failure = Object.assign(new Error('channel closed'), { code: 'ERR_IPC_CHANNEL_CLOSED' })
    w.child.signalCode = 'SIGKILL'
    w.child.send = () => { throw failure }
    expect(() => w.worker.send({ __vitest_worker_request__: true, type: 'cancel' } as never))
      .toThrow(failure)
    expect(w.lines()).toHaveLength(1)
    expect(w.lines()[0]).toMatch(line('null', 'SIGKILL'))
  })

  // #375: the parent's next write fails before 'exit', and Vitest, handling that
  // error, stops listening for 'exit' before the child's exit arrives
  it('prints once when a failed write reaches Vitest before the exit', () => {
    vi.useFakeTimers()
    try {
      const w = fakeWorker()
      w.child.emit('error', epipe())
      w.child.emit('error', epipe())
      // Vitest's own handling is unchanged and immediate
      expect(w.onError).toHaveBeenCalledTimes(2)
      w.stop()
      expect(w.lines()).toHaveLength(0)

      expect(vi.getTimerCount()).toBe(1)
      w.die('SIGKILL')
      expect(w.lines()).toHaveLength(1)
      expect(w.lines()[0]).toMatch(line('null', 'SIGKILL'))
      expect(w.log()).toBe(w.written.join(''))
      // the exit cancelled the fallback
      expect(vi.getTimerCount()).toBe(0)
      vi.advanceTimersByTime(5000)
      expect(w.lines()).toHaveLength(1)
      expect(w.onExit).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('prints once when the exit follows a failed write while Vitest still listens', () => {
    const w = fakeWorker()
    w.child.emit('error', epipe())
    w.die('SIGABRT')
    expect(w.onExit).toHaveBeenCalledOnce()
    expect(w.lines()).toHaveLength(1)
    expect(w.lines()[0]).toMatch(line('null', 'SIGABRT'))
    expect(w.log()).toBe(w.written.join(''))
  })

  it('prints what it knows when the exit never arrives after a failed write', () => {
    vi.useFakeTimers()
    try {
      const w = fakeWorker()
      w.child.emit('error', epipe())
      w.stop()
      vi.advanceTimersByTime(EXIT_WAIT_MS - 1)
      expect(w.lines()).toHaveLength(0)
      vi.advanceTimersByTime(1)
      expect(w.lines()).toHaveLength(1)
      expect(w.lines()[0]).toMatch(line('\\?', '\\?'))

      // a late exit is not a second report
      w.die('SIGKILL')
      vi.advanceTimersByTime(5000)
      expect(w.lines()).toHaveLength(1)
      expect(w.log()).toBe(w.written.join(''))
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a dead child at once and ignores other errors of a live one', () => {
    const live = fakeWorker()
    live.child.emit('error', new Error('something else'))
    expect(live.onError).toHaveBeenCalledOnce()
    expect(live.lines()).toHaveLength(0)
    vi.restoreAllMocks()

    const dead = fakeWorker()
    dead.child.signalCode = 'SIGSEGV'
    dead.child.emit('error', new Error('something else'))
    expect(dead.lines()).toHaveLength(1)
    expect(dead.lines()[0]).toMatch(line('null', 'SIGSEGV'))
  })

  // Vitest's pool API is experimental: if an update stops calling worker.on('exit')
  // or renames _fork, this real run is what notices.
  it('prints the line from a real Vitest run whose worker is killed', () => {
    const dir = scratchDir('ci-diagnostics-')
    const env: NodeJS.ProcessEnv = { ...process.env, [CI_DIAGNOSTICS_ENV]: dir }
    for (const name of Object.keys(env)) if (name.startsWith('VITEST')) delete env[name]
    delete env.NODE_OPTIONS
    const run = spawnSync(process.execPath, [
      join(root, 'node_modules', 'vitest', 'vitest.mjs'),
      'run',
      '--root',
      join(root, 'test', 'fixtures', 'ci-diagnostics-crash'),
    ], { cwd: root, env, encoding: 'utf8', timeout: 60_000 })
    const output = `${run.stdout}${run.stderr}`
    expect(run.error).toBeUndefined()
    expect(run.status, output).not.toBe(0)
    expect(output).toMatch(
      /\[ci-diagnostics\] Vitest fork worker pid \d+ exited unexpectedly: code=null signal=SIGKILL free=\d+ MB of \d+ MB files=\S*kills-its-worker\.fixture\.ts\n/,
    )
    expect(readFileSync(join(dir, 'worker-exits.log'), 'utf8')).toMatch(/ pid \d+ .* signal=SIGKILL /)
  }, 60_000)

  it('keeps the required check names and wraps only the full suite', () => {
    expect(workflow).toContain('    name: Node 24 / ${{ matrix.os }}\n')
    expect(workflow).toContain('        os: [ubuntu-latest, macos-14]\n')
    expect(workflow).not.toMatch(/^ {6}- run: npm test$/m)
    const run = step('Run the test suite with crash diagnostics')
    expect(run).toContain('        id: suite\n')
    expect(run).toContain(
      '          AGENT_INBOX_CI_DIAGNOSTICS_DIR: ${{ github.workspace }}/ci-diagnostics\n',
    )
    expect(run).toContain('/usr/bin/time -l npm test')
    expect(run).toContain('/usr/bin/time -v npm test')
    expect(run).not.toMatch(/^\s+if:|continue-on-error|\|\| true/m)
    expect(workflow.match(new RegExp(CI_DIAGNOSTICS_ENV, 'g'))).toHaveLength(1)
    expect(workflow.indexOf(step('Mark the start of the test suite')))
      .toBeLessThan(workflow.indexOf(run))
  })

  it('collects and uploads diagnostics only when the job fails', () => {
    // only when the suite itself failed: a failed typecheck pays no macOS wait
    const onSuiteFailure = "        if: failure() && steps.suite.outcome == 'failure'\n"
    const collect = step('Collect crash diagnostics')
    expect(collect).toContain(onSuiteFailure)
    expect(collect).toContain('-newer "$out/.started"')
    // a bounded poll for one report per SIGABRT/SIGSEGV/SIGBUS worker, never a fixed sleep
    expect(collect).toContain("grep -cE 'signal=(SIGABRT|SIGSEGV|SIGBUS) ' \"$exits\"")
    expect(collect).toContain('for i in $(seq 30); do')
    expect(collect).not.toMatch(/sleep (?!1$)\d+/m)
    expect(collect).toContain('echo "sudo dmesg unavailable: $kernel"')
    expect(collect).toContain("-name 'node*.ips' -o -name 'node*.crash'")
    expect(collect).toContain('sudo -n dmesg')
    const upload = step('Upload crash diagnostics')
    expect(upload).toContain(onSuiteFailure)
    expect(workflow).not.toMatch(/^\s+if: failure\(\)$/m)
    expect(upload).toContain(`uses: ${UPLOAD}`)
    expect(upload).toContain('          path: ci-diagnostics/\n')
    expect(upload).toContain('          if-no-files-found: ignore\n')
    // the only third-party actions are the ones the repository already pins
    const uses = [...workflow.matchAll(/uses: (\S+)/g)].map((m) => m[1])
    expect(new Set(uses)).toEqual(new Set([
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1',
      'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9',
    ]))
  })
})
