// CI-only crash diagnostics for Vitest fork workers (#359). Nothing here runs unless
// AGENT_INBOX_CI_DIAGNOSTICS_DIR names a directory, which only ci.yml's test step sets,
// so a local `npm test` keeps Vitest's own forks pool and execArgv byte for byte.
//
// When it is set:
// - each fork worker (and only the worker: execArgv is not NODE_OPTIONS, so a test's
//   own Node children keep their exact environment) writes a Node diagnostic report
//   into <dir>/node-reports on a fatal V8 error (OOM, FATAL ERROR, a failed CHECK);
// - the forks pool is the stock ForksPoolWorker under another name, whose one change
//   is to print the exit code, signal, files in flight and free memory when a worker
//   exits unexpectedly. Vitest's own "Worker exited unexpectedly" discards all four.
import { mkdirSync } from 'node:fs'
import { freemem, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import type { PoolOptions, PoolWorker, WorkerRequest } from 'vitest/node'
import { ForksPoolWorker } from 'vitest/node'

export const CI_DIAGNOSTICS_ENV = 'AGENT_INBOX_CI_DIAGNOSTICS_DIR'
const POOL_NAME = 'forks-ci-diagnostics'

type ExitListener = (code: number | null, signal?: NodeJS.Signals | null) => void
const mb = (bytes: number): string => `${Math.round(bytes / 1048576)} MB`

class DiagnosticForksPoolWorker extends ForksPoolWorker implements PoolWorker {
  private files: string[] = []
  private pid: number | undefined
  private readonly wrapped = new Map<(arg: any) => void, ExitListener>()

  override async start(): Promise<void> {
    await super.start()
    this.pid = (this as unknown as { _fork?: { pid?: number } })._fork?.pid
  }

  override send(message: WorkerRequest): void {
    if (message.type === 'run' || message.type === 'collect') {
      this.files = message.context.files.map((f) => f.filepath)
    }
    super.send(message)
  }

  // Vitest listens for 'exit' only between a worker's start and its requested stop,
  // so this line is printed only for an exit Vitest did not ask for.
  override on(event: string, callback: (arg: any) => void): void {
    if (event !== 'exit') return super.on(event, callback)
    const listener: ExitListener = (code, signal) => {
      process.stderr.write(
        `[ci-diagnostics] Vitest fork worker pid ${this.pid ?? '?'} exited unexpectedly: ` +
        `code=${code ?? 'null'} signal=${signal ?? 'null'} ` +
        `free=${mb(freemem())} of ${mb(totalmem())} ` +
        `files=${this.files.length ? this.files.join(', ') : '(none)'}\n`,
      )
      callback(code)
    }
    this.wrapped.set(callback, listener)
    super.on(event, listener)
  }

  override off(event: string, callback: (arg: any) => void): void {
    const listener = event === 'exit' ? this.wrapped.get(callback) : undefined
    if (!listener) return super.off(event, callback)
    this.wrapped.delete(callback)
    super.off(event, listener)
  }
}

export function ciDiagnostics(env: NodeJS.ProcessEnv): {
  execArgv: string[]
  pool: { name: string, createPoolWorker: (options: PoolOptions) => PoolWorker }
} | undefined {
  const dir = env[CI_DIAGNOSTICS_ENV]
  if (!dir) return undefined
  const reports = join(resolve(dir), 'node-reports')
  mkdirSync(reports, { recursive: true })
  return {
    execArgv: ['--report-on-fatalerror', `--report-directory=${reports}`],
    pool: {
      name: POOL_NAME,
      createPoolWorker: (options) => new DiagnosticForksPoolWorker(options),
    },
  }
}
