// CI-only crash diagnostics for Vitest fork workers (#359). Nothing here runs unless
// AGENT_INBOX_CI_DIAGNOSTICS_DIR names a directory, which only ci.yml's test step sets,
// so a local `npm test` keeps Vitest's own forks pool and execArgv byte for byte.
//
// When it is set:
// - each fork worker writes a Node diagnostic report into <dir>/node-reports on a
//   fatal V8 error (OOM, FATAL ERROR, a failed CHECK), without the environment or
//   network handles, since CI uploads it to a public repository. The flags go in the
//   workers' execArgv, not NODE_OPTIONS, so a child a test spawns gets them only when
//   it forwards process.execArgv itself (src/hook.ts does); the variable itself is
//   inherited like any other unless a test builds its child's env from scratch;
// - the forks pool is the stock ForksPoolWorker under another name, whose one change
//   is to print the exit code, signal, files in flight and free memory when a worker
//   exits unexpectedly, on stderr and in <dir>/worker-exits.log, once, whether the
//   death reaches Vitest as 'exit' or first as a failed write (EPIPE, #375).
//   Vitest's own "Worker exited unexpectedly" discards all four.
import type { EventEmitter } from 'node:events'
import { appendFileSync, mkdirSync } from 'node:fs'
import { freemem, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import type { PoolOptions, PoolWorker, WorkerRequest } from 'vitest/node'
import { ForksPoolWorker } from 'vitest/node'

export const CI_DIAGNOSTICS_ENV = 'AGENT_INBOX_CI_DIAGNOSTICS_DIR'
const POOL_NAME = 'forks-ci-diagnostics'

type Listener = (...args: any[]) => void
type Child = EventEmitter & {
  pid?: number
  exitCode: number | null
  signalCode: NodeJS.Signals | null
}
const mb = (bytes: number): string => `${Math.round(bytes / 1048576)} MB`

// How long a send failure waits for the child's 'exit' before printing what it knows.
export const EXIT_WAIT_MS = 1000
// What a write to a worker that has died reports, before or instead of 'exit' (#375)
const SEND_FAILURES = new Set(['EPIPE', 'ECONNRESET', 'ERR_IPC_CHANNEL_CLOSED', 'ERR_IPC_DISCONNECTED'])

class DiagnosticForksPoolWorker extends ForksPoolWorker implements PoolWorker {
  private files: string[] = []
  private readonly wrapped = new Map<string, Map<Listener, Listener>>()
  private reported = false
  private waiting = false

  constructor(options: PoolOptions, private readonly exitLog: string) {
    super(options)
  }

  // _fork is private to Vitest; test/ci-diagnostics.test.ts runs the real pool
  private get child(): Child | undefined {
    return (this as unknown as { _fork?: Child })._fork
  }

  override send(message: WorkerRequest): void {
    // never let a change in Vitest's message shape break a worker's start
    if (message.type === 'run' || message.type === 'collect') {
      const files = (message.context as { files?: { filepath?: unknown }[] } | undefined)?.files
      this.files = Array.isArray(files) ? files.map((f) => String(f?.filepath)) : []
    }
    try {
      super.send(message)
    } catch (error) {
      this.onWorkerError(error)
      throw error
    }
  }

  // Vitest listens for 'exit' only between a worker's start and its requested stop,
  // so the line is printed only for an exit Vitest did not ask for. A worker that
  // dies can reach Vitest first as a failed write ('error' with EPIPE), after which
  // Vitest stops listening for 'exit' (#375): both paths print, exactly once.
  override on(event: string, callback: Listener): void {
    const listener: Listener | undefined =
      event === 'exit'
        ? (code: number | null, signal?: NodeJS.Signals | null) => {
          this.report(code, signal ?? null)
          callback(code)
        }
        : event === 'error'
          ? (error: unknown) => {
            this.onWorkerError(error)
            callback(error)
          }
          : undefined
    if (!listener) return super.on(event, callback)
    let byCallback = this.wrapped.get(event)
    if (!byCallback) this.wrapped.set(event, (byCallback = new Map()))
    byCallback.set(callback, listener)
    super.on(event, listener)
  }

  override off(event: string, callback: Listener): void {
    const listener = this.wrapped.get(event)?.get(callback)
    if (!listener) return super.off(event, callback)
    this.wrapped.get(event)!.delete(callback)
    super.off(event, listener)
  }

  // Only while Vitest still expects the worker to run (it listens for 'exit'), and
  // only for a child that has died or a write that says it has.
  private onWorkerError(error: unknown): void {
    const child = this.child
    if (this.reported || this.waiting || !child || !this.wrapped.get('exit')?.size) return
    const dead = child.exitCode !== null || child.signalCode !== null
    const code = (error as { code?: unknown } | null)?.code
    if (!dead && !(typeof code === 'string' && SEND_FAILURES.has(code))) return
    if (dead) return this.report(child.exitCode, child.signalCode)
    // a listener of our own: Vitest removes its 'exit' listener when it stops the worker
    this.waiting = true
    const done = (): void => {
      clearTimeout(timer)
      child.off('exit', done)
      this.report(child.exitCode, child.signalCode, true)
    }
    const timer = setTimeout(done, EXIT_WAIT_MS)
    child.once('exit', done)
  }

  private report(code: number | null, signal: NodeJS.Signals | null, viaError = false): void {
    if (this.reported) return
    this.reported = true
    // after a failed write, a child that never reported its exit is unknown, not null
    const unknown = viaError && code === null && signal === null
    const line =
      `[ci-diagnostics] Vitest fork worker pid ${this.child?.pid ?? '?'} exited unexpectedly: ` +
      `code=${unknown ? '?' : code ?? 'null'} signal=${unknown ? '?' : signal ?? 'null'} ` +
      `free=${mb(freemem())} of ${mb(totalmem())} ` +
      `files=${this.files.length ? this.files.join(', ') : '(none)'}\n`
    process.stderr.write(line)
    // ci.yml's collect step counts these to know how many crash reports to wait for
    try { appendFileSync(this.exitLog, line) } catch { /* the stderr line stands */ }
  }
}

export function ciDiagnostics(env: NodeJS.ProcessEnv): {
  execArgv: string[]
  pool: { name: string, createPoolWorker: (options: PoolOptions) => PoolWorker }
} | undefined {
  const dir = env[CI_DIAGNOSTICS_ENV]
  if (!dir) return undefined
  const reports = join(resolve(dir), 'node-reports')
  const exitLog = join(resolve(dir), 'worker-exits.log')
  mkdirSync(reports, { recursive: true })
  return {
    execArgv: [
      '--report-on-fatalerror',
      '--report-exclude-env',
      '--report-exclude-network',
      `--report-directory=${reports}`,
    ],
    pool: {
      name: POOL_NAME,
      createPoolWorker: (options) => new DiagnosticForksPoolWorker(options, exitLog),
    },
  }
}
