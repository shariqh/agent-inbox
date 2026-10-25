import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { constants, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SQLITE_CHECK_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'runtime-sqlite-check.mjs')
// Mirrors SQLITE_CHECK_TIMEOUT_MS in stage-runtime.mjs (#193): the 300,000 statements
// took GitHub's Intel runners roughly 25-35 s when #187 raised the ceiling and now take
// about 35-60 s there, and a real hang still fails.
const SQLITE_CHECK_TIMEOUT_MS = 180_000
const IDENTITY_TIMEOUT_MS = 30_000
const OUTPUT_EXCERPT_CHARS = 2_000
const IDENTITY_PROBE = 'JSON.stringify({platform:process.platform,arch:process.arch,'
  + 'electron:process.versions.electron,node:process.version,modulesAbi:process.versions.modules})'
const SCRATCH_DIRECTORIES = [
  ['HOME', 'home'],
  ['TMPDIR', 'tmp'],
  ['XDG_CACHE_HOME', 'cache'],
  ['XDG_CONFIG_HOME', 'config'],
  ['XDG_DATA_HOME', 'data'],
  ['XDG_STATE_HOME', 'state'],
]

export class ElectronSqliteCheckError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ElectronSqliteCheckError'
  }
}

function isolatedEnvironment(scratch) {
  const env = {
    AGENT_INBOX_DB: join(scratch, 'inbox.db'),
    ELECTRON_RUN_AS_NODE: '1',
  }
  if (process.env.PATH) env.PATH = process.env.PATH
  for (const [name, directory] of SCRATCH_DIRECTORIES) {
    env[name] = join(scratch, directory)
    mkdirSync(env[name])
  }
  return env
}

function signalName(number) {
  return Object.entries(constants.signals).find(([, value]) => value === number)?.[0]
}

function describeOutcome(result, timeoutMs) {
  if (result.error?.code === 'ETIMEDOUT') return `timed out after ${timeoutMs / 1000} s`
  if (result.error) return `failed to run (${result.error.message})`
  if (result.signal) {
    const number = constants.signals[result.signal]
    return `was terminated by ${result.signal}${number ? ` (exit ${128 + number})` : ''}`
  }
  const signal = typeof result.status === 'number' && result.status > 128 ? signalName(result.status - 128) : undefined
  return `exited with status ${result.status}${signal ? ` (${signal})` : ''}`
}

// Node prints the failed assertion first and the native stack after it, so keep
// both ends of long output.
function outputExcerpts(result) {
  const sections = []
  for (const name of ['stderr', 'stdout']) {
    const text = String(result[name] ?? '').trim()
    if (!text) continue
    const omitted = text.length - 2 * OUTPUT_EXCERPT_CHARS
    sections.push(`--- ${name} ---\n${omitted > 0
      ? `${text.slice(0, OUTPUT_EXCERPT_CHARS)}\n[... ${omitted} characters omitted ...]\n${text.slice(-OUTPUT_EXCERPT_CHARS)}`
      : text}`)
  }
  return sections
}

function readIdentity(probe) {
  if (probe.error || probe.signal || probe.status !== 0) return { detail: describeOutcome(probe, IDENTITY_TIMEOUT_MS) }
  const line = String(probe.stdout ?? '').trim().split('\n').at(-1) ?? ''
  try {
    const identity = JSON.parse(line)
    if (identity && typeof identity === 'object' && !Array.isArray(identity)) return { identity }
  } catch {
    // Reported below with the exact output.
  }
  return { detail: `printed ${JSON.stringify(line.slice(-200))}` }
}

/**
 * Run scripts/runtime-sqlite-check.mjs inside a packaged Electron, in Node mode,
 * against that app's own Electron-rebuilt better_sqlite3.node and dist/store.js.
 * Electron's embedded Node carries the Node 24.19 ObjectWrap cleanup-hook change
 * too, and only allocation-driven statement GC reveals the resulting abort (#135):
 * an open/close probe or an explicit global.gc() passes regardless. The child sees
 * only a scratch HOME/TMPDIR/XDG tree and inbox path, so it cannot touch real
 * state, and any failure, signal, or timeout throws.
 */
export function runElectronSqliteCheck({
  executable,
  storePath,
  expected,
  label = 'packaged Electron',
  timeoutMs = SQLITE_CHECK_TIMEOUT_MS,
  log = (line) => process.stderr.write(`${line}\n`),
  spawn = spawnSync,
}) {
  if (!existsSync(storePath)) {
    throw new ElectronSqliteCheckError(
      `${label} is missing the packaged store module at ${storePath}; cannot run the allocation-driven SQLite check (#135)`,
    )
  }
  const scratch = mkdtempSync(join(tmpdir(), 'electron-sqlite-check-'))
  try {
    const options = {
      cwd: scratch,
      env: isolatedEnvironment(scratch),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024,
    }
    const { identity, detail } = readIdentity(
      spawn(executable, ['-p', IDENTITY_PROBE], { ...options, timeout: IDENTITY_TIMEOUT_MS }),
    )
    if (!identity) {
      throw new ElectronSqliteCheckError(
        `${label} did not report its Node-mode identity under ELECTRON_RUN_AS_NODE=1 (${detail}); `
          + "the allocation-driven SQLite check (#135) needs Electron's RunAsNode fuse to stay enabled",
      )
    }
    for (const [field, wanted] of Object.entries(expected)) {
      if (identity[field] !== wanted) {
        throw new ElectronSqliteCheckError(
          `${label} ${field} mismatch: found ${String(identity[field])}, expected ${wanted} (ELECTRON_RUN_AS_NODE=1 identity probe)`,
        )
      }
    }

    const started = process.hrtime.bigint()
    const result = spawn(executable, [SQLITE_CHECK_SCRIPT, storePath], { ...options, timeout: timeoutMs })
    const seconds = (Number(process.hrtime.bigint() - started) / 1e9).toFixed(1)
    if (result.error || result.signal || result.status !== 0) {
      const aborted = result.signal === 'SIGABRT' || result.status === 128 + constants.signals.SIGABRT
      throw new ElectronSqliteCheckError([
        `${label} failed the allocation-driven SQLite check (#135): it ${describeOutcome(result, timeoutMs)} (elapsed ${seconds} s).`,
        aborted
          ? 'An abort here is the #135 crash: better-sqlite3 statement cleanup during garbage collection reaches '
            + "Node.js 24.19+'s node::ObjectWrap cleanup hooks without the runtime fix that Electron 43.6.0 and later "
            + 'carry (electron/electron#53393 in 43.6–43.7; upstream Node.js 24.22.0 from 43.8.0). '
            + 'Refusing to ship this Electron and better_sqlite3.node combination.'
          : 'Refusing to ship an Electron and better_sqlite3.node combination that has not passed this check.',
        ...outputExcerpts(result),
      ].join('\n'))
    }
    log(
      `electron-sqlite-check: ${label} passed: Electron ${identity.electron} with Node ${identity.node} `
        + `(ABI ${identity.modulesAbi}, ${identity.platform}-${identity.arch}) completed the allocation-driven `
        + `SQLite check (#135) in ${seconds} s (limit ${timeoutMs / 1000} s)`,
    )
    return {
      electron: identity.electron,
      node: identity.node,
      modulesAbi: identity.modulesAbi,
      platform: identity.platform,
      arch: identity.arch,
      seconds: Number(seconds),
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
