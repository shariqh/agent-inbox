#!/usr/bin/env node
// Issue #412, step 2 — `agent-inbox-driver`: start a Copilot session over ACP
// in the foreground and drive it from this terminal. Design:
// docs/superpowers/specs/2026-10-31-driven-sessions-design.md §2, §3.2, §4.3, §7
// and §11 (step 2).
//
//   agent-inbox-driver copilot --cwd <dir> --mode ask|read-only --prompt-file <file> [--model <id>] [--reasoning-effort <level>]
//   agent-inbox-driver stop <launch id>
//   agent-inbox-driver run <launch id> <hub db>     (step 3: Electron main only)
//   agent-inbox-driver worktree inspect|remove <launch id> <hub db> [--discard <status hash>]
//                                                    (#432: Electron main only)
//
// Approvals happen on this terminal, so it refuses to run without a TTY on
// stdin. The copilot child gets its own pipes: its stdout carries ACP only, its
// stderr goes to the launch's log, and nothing of it reaches this terminal
// except what the driver prints.
//
// `run` is step 3's detached driver (§8): Electron main starts it, after a
// native confirmation, with the launch spec on fd 3 (launch-spec.ts). It needs
// no terminal: approvals are signed by the app (driver-launch.ts). It writes
// exactly one JSON line to stdout, `{"ok":true,"launch":<id>}` once the session
// is starting or `{"ok":false,"error":…}`, and everything else to the launch's
// logs and row.
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  accessSync, appendFileSync, closeSync, constants, createWriteStream, fstatSync, mkdirSync, openSync, readFileSync, readSync,
  realpathSync, renameSync, rmSync, statSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { Driver } from './driver.js'
import type { DriverOptions, EndReason, ScanResult } from './driver.js'
import { appAsks, launchHooks } from './driver-launch.js'
import { LAUNCH_SPEC_VERSION, parseLaunchSpec, readSpec } from './launch-spec.js'
import { createTerminal, installStopHandlers, reapProcessGroup } from './driver-tty.js'
import { locateRuntime, pinRuntime, removePin, runtimeRootFor } from './driver-pin.js'
import { processIdentity } from '../scripts/runtime-pins.mjs'
import { findNativeHost, linkSessions, readProcesses } from './driver-link.js'
import { childEnv, copilotAgentInboxServer, copilotArgs, editsFolder, isReasoningEffort, REASONING_EFFORTS, terminalSafe } from './driver-policy.js'
import type { LaunchMode, ReasoningEffort } from './driver-policy.js'
import { inferProject, inferStream } from './infer.js'
import {
  claimDriverSlot, createLaunch, defaultDbPath, endLaunch, getLaunch, holdDriverLeases, listHostSessions, recordWorktreeSummary, liveSessionServers, markWorktreeRemoved, openDb, parkLaunch,
  recordLaunchProgress, releaseDriverLeases, requestDriverStop, requestLaunchStop, resumeLaunch,
} from './store.js'
import { createWorktree, gitEnv, inspectWorktree, removeLaunchWorktree, undoWorktree, unlockWorktree, worktreeSummarizer } from './worktree.js'
import type { CreatedWorktree } from './worktree.js'
import type Database from 'better-sqlite3'

const USAGE = `usage: agent-inbox-driver copilot --cwd <dir> --mode ask|read-only --prompt-file <file> [--model <id>] [--reasoning-effort <level>]
       agent-inbox-driver stop <launch id>
`
const LAUNCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MODES: readonly LaunchMode[] = ['ask', 'read-only', 'plan', 'edits']
// npm-installed Copilot's loader (§8) needs a current Node
const MIN_NODE_MAJOR = 22
// the terminal driver's cap; an app launch's spec names its own (#432 §5: Settings, 1–8)
const MAX_DRIVERS = 2
const MAX_PROMPT = 64 * 1024
const LOG_ROTATE_BYTES = 20 * 1024 * 1024

function fail(message: string, code = 2): never {
  process.stderr.write(`agent-inbox-driver: ${terminalSafe(message)}\n`)
  process.exit(code)
}

interface RunArgs {
  cwd: string
  mode: LaunchMode
  promptFile: string
  model?: string
  reasoningEffort?: ReasoningEffort
}

function parseRun(argv: string[]): RunArgs {
  const values = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!
    const value = argv[i + 1]
    if (!['--cwd', '--mode', '--prompt-file', '--model', '--reasoning-effort'].includes(flag) || value === undefined || values.has(flag)) {
      process.stderr.write(USAGE)
      process.exit(64)
    }
    values.set(flag, value)
  }
  const mode = values.get('--mode')
  if (mode !== 'ask' && mode !== 'read-only') fail('--mode must be ask or read-only', 64)
  const cwd = values.get('--cwd')
  const promptFile = values.get('--prompt-file')
  if (!cwd || !promptFile) {
    process.stderr.write(USAGE)
    process.exit(64)
  }
  const model = values.get('--model')
  if (model !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(model)) fail('--model must be a model id', 64)
  const effort = values.get('--reasoning-effort')
  if (effort !== undefined && !isReasoningEffort(effort)) fail(`--reasoning-effort must be one of ${REASONING_EFFORTS.join(', ')}`, 64)
  return { cwd, mode, promptFile, ...(model ? { model } : {}), ...(effort ? { reasoningEffort: effort } : {}) }
}

// An executable on PATH, as a real path owned by this user or root and not
// writable by group or others (§8). The first one found decides: an untrusted
// one refuses rather than falling through to the next.
function findExecutable(name: string, path: string | undefined): { path: string } | { error: string } {
  for (const dir of (path ?? '').split(':')) {
    if (!dir || !isAbsolute(dir)) continue
    const candidate = join(dir, name)
    let real: string
    try {
      accessSync(candidate, constants.X_OK)
      real = realpathSync(candidate)
      if (!statSync(real).isFile()) continue
    } catch {
      continue
    }
    return trusted(real) ? { path: real } : { error: `${real} is not owned by you or root, or is writable by others; refusing to run it` }
  }
  return { error: name === 'copilot' ? 'no copilot executable on PATH (install GitHub Copilot CLI first)' : `no ${name} executable on PATH` }
}

function trusted(real: string): boolean {
  const info = statSync(real)
  const uid = process.getuid?.() ?? -1
  return (info.uid === uid || info.uid === 0) && (info.mode & 0o022) === 0
}

// The copilot on this terminal's PATH (step 2).
function resolveCopilot(path: string | undefined): string {
  const found = findExecutable('copilot', path)
  return 'error' in found ? fail(found.error) : found.path
}

// Step 3 (§8): the host executable on the captured PATH, and, when it is a
// script, its interpreter resolved on the same PATH and checked the same way,
// so the launch spawns `[interpreter, script, …]` explicitly and records both.
// An npm-installed Copilot is exactly this: `…/bin/copilot` is npm-loader.js
// (`#!/usr/bin/env node`).
function resolveHost(path: string | undefined): { command: string; args: string[]; script: string } | { error: string } {
  const found = findExecutable('copilot', path)
  if ('error' in found) return found
  let head = ''
  try {
    const fd = openSync(found.path, 'r')
    try {
      const buffer = Buffer.alloc(256)
      head = buffer.toString('utf8', 0, readSync(fd, buffer, 0, buffer.length, 0))
    } finally {
      closeSync(fd)
    }
  } catch {
    return { error: `cannot read ${found.path}` }
  }
  if (!head.startsWith('#!')) return { command: found.path, args: [], script: found.path }
  // `#!/usr/bin/env <name>` or `#!<absolute interpreter>`, with no arguments:
  // the kernel would pass any as one word, and none is needed to run Copilot
  const words = head.slice(2).split('\n')[0]!.trim().split(/\s+/)
  const unresolved = { error: `${found.path} names an interpreter this driver does not resolve` }
  let interpreter: { path: string } | { error: string }
  if (words[0] === '/usr/bin/env') {
    const name = words[1] ?? ''
    if (words.length !== 2 || !/^[A-Za-z0-9._-]+$/.test(name)) return unresolved
    interpreter = findExecutable(name, path)
  } else {
    const named = words[0] ?? ''
    if (words.length !== 1 || !isAbsolute(named)) return unresolved
    try {
      const real = realpathSync(named)
      interpreter = trusted(real) ? { path: real } : { error: `${real} is not owned by you or root, or is writable by others; refusing to run it` }
    } catch {
      interpreter = { error: `${found.path} names an interpreter that does not exist` }
    }
  }
  if ('error' in interpreter) return interpreter
  if (basename(interpreter.path) === 'node') {
    let version = ''
    try {
      version = execFileSync(interpreter.path, ['--version'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin' } })
    } catch { /* checked below */ }
    const major = Number(/^v(\d+)\./.exec(version.trim())?.[1])
    if (!(major >= MIN_NODE_MAJOR)) return { error: `${interpreter.path} is not Node ${MIN_NODE_MAJOR} or later, which Copilot needs` }
  }
  return { command: interpreter.path, args: [found.path], script: found.path }
}

// <hub dir>/launches/<id>/events.ndjson, 0600 in a 0700 folder, rotated at 20 MB (§3.6)
function eventLog(dir: string): (event: Record<string, unknown>) => void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, 'events.ndjson')
  let size = 0
  return (event) => {
    const line = `${JSON.stringify({ t: new Date().toISOString(), ...event })}\n`
    try {
      if (size + line.length > LOG_ROTATE_BYTES) {
        renameSync(file, join(dir, 'events.1.ndjson'))
        size = 0
      }
      appendFileSync(file, line, { mode: 0o600 })
      size += line.length
    } catch { /* a log that cannot be written never stops the session */ }
  }
}

// A test seam read from the driver's own environment, bounded; undefined when unset or out of bounds.
function boundedMs(value: string | undefined, min: number, max: number): number | undefined {
  const ms = Number(value)
  return value !== undefined && Number.isInteger(ms) && ms >= min && ms <= max ? ms : undefined
}

// Run from an installed runtime, the driver pins it for as long as it runs, so
// no prune removes the runtime under it (§7). Every exit path, forced or not,
// ends in process.exit, whose 'exit' handler removes the pin; a pin a crash
// leaves never counts once this process is gone, and the next prune sweeps it.
// Returns why it could not pin, or null.
function pinOwnRuntime(launchId: string): string | null {
  const located = locateRuntime(fileURLToPath(import.meta.url), runtimeRootFor(process.env))
  if (located.kind === 'refuse') return `cannot pin the runtime it runs from: ${located.reason}`
  if (located.kind === 'checkout') return null
  const runtime = located.runtime
  const startedAt = processIdentity(process.pid)
  let pinPath: string | null = null
  let why = startedAt ? '' : 'this process\'s start identity cannot be read'
  try {
    if (startedAt) pinPath = pinRuntime(runtime, { launchId, pid: process.pid, startedAt })
  } catch (err) {
    why = (err as Error).message
  }
  if (!pinPath) return `could not pin the runtime it runs from in ${join(runtime.root, '.pins')} (${why}), so a prune could remove it mid-session`
  const pinned = pinPath
  process.on('exit', () => removePin(pinned, launchId))
  return null
}

// The copilot child, in its own process group (so a terminal's Ctrl-C reaches
// only the driver, which stops the session in order, §7), with its stdout
// carrying ACP only and its stderr in the launch's log; and the ancestry scan
// that links its MCP servers (§5.1).
function spawnSession(o: {
  db: Database.Database
  launchDir: string
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  spawnLog: Record<string, unknown>
}) {
  const log = eventLog(o.launchDir)
  const stderrLog = createWriteStream(join(o.launchDir, 'copilot.stderr.log'), { flags: 'a', mode: 0o600 })
  const child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
  child.stderr.pipe(stderrLog)
  const exited = new Promise<unknown>((resolveExit) => {
    child.once('exit', (code, signal) => {
      log({ event: 'child_exit', code, signal })
      resolveExit(undefined)
    })
    child.once('error', (error) => {
      log({ event: 'child_error', message: error.message })
      resolveExit(undefined)
    })
  })
  log({ event: 'spawn', ...o.spawnLog, pid: child.pid ?? null })

  let childStartMs: number | null = null
  const scan = async (): Promise<ScanResult> => {
    const procs = await readProcesses()
    if (child.pid === undefined) return { hostPid: null, linked: [], dead: [] }
    childStartMs ??= procs.get(child.pid)?.startMs ?? null
    const hostPid = findNativeHost(procs, child.pid)
    if (hostPid === null || childStartMs === null) return { hostPid: null, linked: [], dead: [] }
    const rows = listHostSessions(o.db, hostPid).map((row) => ({ ...row, host_pid: hostPid }))
    const linked = linkSessions(rows, procs, { hostPid, childStartMs })
    return { hostPid, linked: linked.linked, dead: linked.dead }
  }
  const kill = (signal: NodeJS.Signals) => { if (child.pid) try { process.kill(-child.pid, signal) } catch { /* gone */ } }
  return { child, exited, log, stderrLog, scan, kill }
}

function stopCommand(argv: string[]): void {
  const id = argv[0]
  if (argv.length !== 1 || !id) {
    process.stderr.write(USAGE)
    process.exit(64)
  }
  const db = openDb(defaultDbPath())
  try {
    requestDriverStop(db, id)
    // an app launch's driver polls its row; a parked one has no driver and ends here
    requestLaunchStop(db, id)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), 64)
  } finally {
    db.close()
  }
  process.stdout.write(`Asked the driver of launch ${id} to stop.\n`)
}

async function runCopilot(argv: string[]): Promise<void> {
  const args = parseRun(argv)
  if (!process.stdin.isTTY) fail('stdin is not a terminal: approvals are answered here, so the driver runs only in a terminal')
  if (process.platform !== 'darwin' && process.platform !== 'linux') fail(`${process.platform} is not supported`)
  let cwd: string
  try {
    cwd = realpathSync(resolve(args.cwd))
    if (!statSync(cwd).isDirectory()) throw new Error('not a folder')
  } catch {
    return fail(`--cwd ${args.cwd} is not a folder`)
  }
  let task: string
  try {
    task = readFileSync(args.promptFile, 'utf8')
  } catch {
    return fail(`cannot read --prompt-file ${args.promptFile}`)
  }
  if (!task.trim() || task.length > MAX_PROMPT) fail('the prompt file must hold 1 to 65536 characters')
  const server = copilotAgentInboxServer(process.env)
  if ('error' in server) fail(server.error)
  const copilot = resolveCopilot(process.env.PATH)

  const dbPath = defaultDbPath()
  const db = openDb(dbPath)
  const hubDir = dirname(dbPath)
  const launchId = randomUUID()
  const lease = { launchId, pid: process.pid, nonce: randomBytes(8).toString('hex') }
  const slot = claimDriverSlot(db, lease, MAX_DRIVERS)
  if (!slot.ok) {
    fail(`${slot.running.length} driven sessions are already running (launches ${slot.running.map((r) => r.launch).join(', ')}); stop one first`)
  }
  const refuse = (why: string) => {
    try { releaseDriverLeases(db, lease) } catch { /* the hub is gone */ }
    fail(why, 1)
  }
  const unpinned = pinOwnRuntime(launchId)
  if (unpinned) refuse(unpinned)

  const { child, exited, log, stderrLog, scan, kill } = spawnSession({
    db, launchDir: join(hubDir, 'launches', launchId), command: copilot,
    args: copilotArgs({ mode: args.mode, agentInboxServer: server.name, model: args.model, reasoningEffort: args.reasoningEffort }),
    cwd, env: childEnv(process.env, { path: dbPath, isDefault: process.env.AGENT_INBOX_DB === undefined }),
    spawnLog: { launch: launchId, mode: args.mode, cwd },
  })

  const linkWaitMs = boundedMs(process.env.AGENT_INBOX_DRIVER_LINK_WAIT_MS, 0, 10_000)

  // the terminal: every write is sanitized (driver-tty.ts), one approval at a time
  let driver: Driver | null = null
  const terminal = createTerminal({
    write: (text) => { process.stdout.write(text) },
    answer: (askId, approve) => driver?.answer(askId, approve),
    stop: () => driver?.stop(),
    interrupt: () => driver?.interrupt(),
  })
  const out = terminal.print
  const ui = terminal.ui
  // a closed terminal makes writes fail with EIO, emitted as 'error': with no
  // listener that throws and kills the driver before its cleanup (#412 review)
  for (const stream of [process.stdout, process.stderr, process.stdin]) stream.on('error', () => terminal.silence())

  driver = new Driver({
    db, lease, mode: args.mode, cwd, project: inferProject(cwd), stream: inferStream(cwd), task,
    input: child.stdout, output: child.stdin,
    child: { kill, exited },
    ui, log, stateDir: join(hubDir, 'drivers', launchId), scan,
    // a test seam, bounded: how long the first prompt waits for linking (default 10 s)
    ...(linkWaitMs === undefined ? {} : { timing: { linkWaitMs } }),
  })

  const rl = createInterface({ input: process.stdin, terminal: false })
  rl.on('line', (line) => terminal.line(line))
  const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  installStopHandlers({
    signals: process,
    input: rl,
    driver,
    exit: (code) => {
      // forceStop sent the child's group SIGTERM; SIGKILL it if it does not go
      if (child.pid && child.exitCode === null && child.signalCode === null) reapProcessGroup(child.pid, { kill: (pid, signal) => { process.kill(pid, signal) }, sleep })
      process.exit(code)
    },
    notice: (text) => ui.notice(text),
    silence: () => terminal.silence(),
  })

  out(`Agent Inbox drives this Copilot session (launch ${launchId}, mode ${args.mode}).\n`)
  // the same Node and loader flags this process runs with, so it works from source (tsx) and from dist
  const quote = (arg: string) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`)
  const stopLine = [process.execPath, ...process.execArgv, process.argv[1] ?? '', 'stop', launchId].map(quote).join(' ')
  out(`Stop it with Ctrl-C or: ${stopLine}\n`)
  out('Once any shell command is allowed, the session can run anything; answer each ask with that in mind.\n\n')
  const reason: EndReason = await driver.start()
  rl.close()
  // the child exits about 1 s after its stdin closes (spike §1); after 10 s its group gets SIGTERM
  const settled = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 10_000).unref())])
  if (!settled && child.pid) try { process.kill(-child.pid, 'SIGTERM') } catch { /* gone */ }
  try { releaseDriverLeases(db, lease) } catch { /* the hub is gone */ }
  db.close()
  stderrLog.end()
  out(`\n[agent-inbox] Session ended: ${reason}.\n`)
  process.exit(reason === 'stopped' || reason === 'idle' || reason === 'park' || reason === 'child_exit' ? 0 : 1)
}

// ── step 3: `run <launch id> <hub db>`, started by Electron main (§8) ───────

async function runLaunch(argv: string[]): Promise<void> {
  let reported = false
  // the one stdout line main reads; nothing else is ever written to stdout
  const report = (status: Record<string, unknown>) => {
    if (reported) return
    reported = true
    try { process.stdout.write(`${JSON.stringify(status)}\n`) } catch { /* main stopped reading */ }
  }
  const refuseStart = (error: string, code: number): never => {
    report({ ok: false, error })
    return fail(error, code)
  }
  for (const stream of [process.stdout, process.stderr]) stream.on('error', () => undefined)
  const [launchId, dbPath] = argv
  if (argv.length !== 2 || !launchId || !LAUNCH_ID.test(launchId) || !dbPath || !isAbsolute(dbPath)) {
    process.stderr.write('usage: agent-inbox-driver run <launch id> <absolute hub db path>\n')
    process.exit(64)
  }
  if (process.platform !== 'darwin' && process.platform !== 'linux') refuseStart(`${process.platform} is not supported`, 2)
  // fd 3 must be main's pipe: without one, Node's own event loop holds that
  // descriptor (on macOS its kqueue, which fstat reports as a FIFO with no
  // permission bits), and reading or closing it aborts the process. Only a
  // socket (Node's 'pipe' stdio) or a real FIFO is read, and only a descriptor
  // verified and read is closed.
  let specPipe = false
  try {
    const kind = fstatSync(3)
    specPipe = kind.isSocket() || (kind.isFIFO() && (kind.mode & 0o777) !== 0)
  } catch { /* not open */ }
  if (!specPipe) refuseStart('no launch spec on fd 3 (Electron main passes it on a pipe)', 65)
  const text = readSpec(3)
  // fd 3 carried the launch key: close it before anything starts, so copilot
  // and every shell it runs never inherit it
  try { closeSync(3) } catch { /* already closed */ }
  if (typeof text !== 'string') refuseStart(text.error, 65)
  const parsed = parseLaunchSpec(text as string, launchId)
  if (!parsed.ok) return refuseStart(parsed.error, 65)
  const spec = parsed.spec

  const db = openDb(dbPath)
  const hubDir = dirname(dbPath)
  const lease = { launchId, pid: process.pid, nonce: randomBytes(8).toString('hex') }
  const slot = claimDriverSlot(db, lease, spec.maxDrivers ?? MAX_DRIVERS)
  if (!slot.ok) {
    refuseStart(`${slot.running.length} driven sessions are already running (launches ${slot.running.map((r) => r.launch).join(', ')}); stop one first`, 75)
  }
  // a refusal after the row is ours ends a new launch, and parks a resumed one
  // again as it was, so a failed Resume loses nothing
  let undoRow: (() => void) | null = null
  // #432: a worktree this start created is undone too, the worktree before its branch (§2)
  let undoCreated: (() => void) | null = null
  const refuse = (why: string): never => {
    try { undoRow?.() } catch { /* the hub is gone */ }
    // undoWorktree unlocks first; if git cannot remove it, the worktree stays on disk and the row keeps listing it
    try { undoCreated?.() } catch { /* the hub is gone */ }
    try { releaseDriverLeases(db, lease) } catch { /* the hub is gone */ }
    return refuseStart(why, 1)
  }
  const home = spec.env.HOME && isAbsolute(spec.env.HOME) ? spec.env.HOME : null
  const isDefault = home !== null && dbPath === join(home, '.agent-inbox', 'inbox.db')
  const sessionEnv = childEnv(spec.env, { path: dbPath, isDefault })
  // #432: the git that makes and unlocks a launch's worktree, trusted like copilot (§2)
  let git: string | null = null
  const findGit = (): string | { error: string } => {
    if (git) return git
    const found = findExecutable('git', spec.env.PATH)
    if ('error' in found) return found
    git = found.path
    return git
  }
  // the worktree's checkout and path: from the spec, or, resuming, from the row
  let worktreeOf: { checkout: string; path: string; baseRef: string | null; baseSha: string } | null = null
  let created: CreatedWorktree | null = null
  // an ended launch's worktree is unlocked; a parked one keeps its lock (§5)
  let unlocked = false
  const unlockAtEnd = (log?: (event: Record<string, unknown>) => void): void => {
    if (!worktreeOf || unlocked) return
    unlocked = true
    const gitPath = findGit()
    const why = typeof gitPath === 'string' ? unlockWorktree(gitPath, gitEnv(sessionEnv), worktreeOf.checkout, worktreeOf.path) : gitPath.error
    if (why) log?.({ event: 'worktree_unlock_failed', message: why })
  }

  // the launch's facts: from the spec, or, resuming, from the row the first driver wrote
  let facts: { cwd: string; mode: LaunchMode; model?: string; reasoningEffort?: ReasoningEffort; activeMs: number; toolCalls: number; prompt: string; project: string; stream: string }
  // the launch's usage so far: the budgets are per-launch totals across park and resume
  let used = { activeMs: 0, toolCalls: 0 }
  let resume: Pick<DriverOptions, 'loadSessionId' | 'priorSessions'> = {}
  // the session a resume tries to load, kept on the row if the load fails
  let loading: string | null = null
  if (spec.kind === 'new') {
    let cwd: string
    try {
      cwd = realpathSync(spec.cwd)
      if (!statSync(cwd).isDirectory()) throw new Error('not a folder')
    } catch {
      return refuse(`${spec.cwd} is not a folder`)
    }
    // #432: a new worktree of the checkout, made before the row so the row records it (§2 steps 2–5)
    // the checkout in its on-disk case, so no root in another case can pass for outside it
    let checkout = cwd
    if (spec.worktree) {
      try {
        checkout = realpathSync.native(cwd)
      } catch {
        return refuse(`${spec.cwd} is not a folder`)
      }
      const gitPath = findGit()
      if (typeof gitPath !== 'string') return refuse(gitPath.error)
      const made = createWorktree({ git: gitPath, env: gitEnv(sessionEnv), checkout, plan: spec.worktree, launchId })
      if (!made.ok) return refuse(made.error)
      created = made.worktree
      const undo = made.worktree
      undoCreated = () => { if (undoWorktree(gitPath, gitEnv(sessionEnv), undo)) markWorktreeRemoved(db, launchId) }
      cwd = created.path
      worktreeOf = { checkout, path: cwd, baseRef: created.baseRef, baseSha: created.baseSha }
    }
    facts = {
      cwd, mode: spec.mode, ...(spec.model ? { model: spec.model } : {}), ...(spec.reasoningEffort ? { reasoningEffort: spec.reasoningEffort } : {}),
      activeMs: spec.budgets.activeMs, toolCalls: spec.budgets.toolCalls, prompt: spec.prompt,
      // a worktree has the checkout's origin; its stream is its own branch (§4)
      project: inferProject(checkout), stream: created ? created.branch : inferStream(cwd),
    }
    let pruned: string[]
    try {
      pruned = createLaunch(db, {
        id: launchId, host: 'copilot', project: facts.project, stream: facts.stream, cwd, mode: facts.mode,
        model: facts.model ?? null, reasoningEffort: facts.reasoningEffort ?? null, budgetActiveMs: facts.activeMs,
        budgetToolCalls: facts.toolCalls, prompt: facts.prompt, specVersion: LAUNCH_SPEC_VERSION, driverPid: process.pid,
        ...(created ? { worktree: { checkoutRoot: checkout, branch: created.branch, baseSha: created.baseSha, baseRef: created.baseRef } } : {}),
      }).pruned
    } catch {
      return refuse(`launch ${launchId} already exists`)
    }
    undoRow = () => { endLaunch(db, launchId, { reason: 'error:start' }) }
    // logs are pruned with their launch (§8)
    for (const old of pruned) {
      if (!LAUNCH_ID.test(old)) continue
      for (const dir of ['launches', 'drivers']) rmSync(join(hubDir, dir, old), { recursive: true, force: true })
    }
  } else {
    const row = resumeLaunch(db, launchId, process.pid)
    if (!row) return refuse(`launch ${launchId} is not parked`)
    undoRow = () => { parkLaunch(db, launchId, { acpSession: row.acp_session, activeMs: row.active_ms, toolCalls: row.tool_calls }) }
    if (row.worktree_path && row.checkout_root && row.base_sha && row.worktree_removed_at === null) {
      worktreeOf = { checkout: row.checkout_root, path: row.worktree_path, baseRef: row.base_ref, baseSha: row.base_sha }
    }
    const mode = MODES.find((m) => m === row.mode)
    const effort = row.reasoning_effort !== null && isReasoningEffort(row.reasoning_effort) ? row.reasoning_effort : undefined
    if (!mode) return refuse(`launch ${launchId} has an unknown mode`)
    facts = {
      cwd: row.cwd, mode, ...(row.model ? { model: row.model } : {}), ...(effort ? { reasoningEffort: effort } : {}),
      activeMs: row.budget_active_ms, toolCalls: row.budget_tool_calls, prompt: row.prompt, project: row.project, stream: row.stream,
    }
    used = { activeMs: row.active_ms, toolCalls: row.tool_calls }
    // a launch that already used a budget ends here, before anything starts
    const spent = row.tool_calls >= row.budget_tool_calls ? 'budget:tool_calls' : row.active_ms >= row.budget_active_ms ? 'budget:active_time' : null
    if (spent) {
      undoRow = () => { endLaunch(db, launchId, { reason: spent }); unlockAtEnd() }
      return refuse(`launch ${launchId} has used its ${spent === 'budget:tool_calls' ? 'tool-call' : 'active-time'} budget`)
    }
    // the earlier driver's sessions, proved by the row (§14.3): their open
    // messages move to the new server once it links; a server still alive is
    // not ended, so readdressMessages waits for it
    const alive = new Map(liveSessionServers(db, row.sessions).map((a) => [a.session, a.server_pid]))
    const serverAlive = (pid: number | null) => {
      if (pid === null) return false
      try { process.kill(pid, 0); return true } catch { return false }
    }
    loading = row.acp_session
    resume = {
      ...(row.acp_session ? { loadSessionId: row.acp_session } : {}),
      priorSessions: row.sessions.map((session) => ({ session, dead: alive.has(session) && !serverAlive(alive.get(session) ?? null) })),
    }
    // after a Resume every open message is pushed again: the new process may not hold the old turn (§5.3)
    rmSync(join(hubDir, 'drivers', launchId, 'pushed.json'), { force: true })
  }

  const unpinned = pinOwnRuntime(launchId)
  if (unpinned) refuse(unpinned)
  const server = copilotAgentInboxServer(spec.env)
  if ('error' in server) refuse(server.error)
  const host = resolveHost(spec.env.PATH)
  if ('error' in host) return refuse(host.error)
  // Edits in the worktree writes unasked only under the folder as it resolves
  // now: a resumed launch whose folder resolves elsewhere does not start
  let edits: ReturnType<typeof editsFolder> = null
  if (facts.mode === 'edits') {
    let real: string | null = null
    try { real = realpathSync(facts.cwd) } catch { /* gone */ }
    // the home folder as it resolves too, or a symlinked home would compare unequal
    let realHome = home
    try { if (home) realHome = realpathSync(home) } catch { /* compared as written */ }
    edits = real === facts.cwd && editsFolder(facts.cwd, home) ? editsFolder(facts.cwd, realHome) : null
    if (!edits) return refuse(`Edits in the worktree cannot use ${facts.cwd}: choose a project folder (not your home folder) whose path has no ( ) * ? [ ] { } , or \\`)
  }

  const { child, exited, log, stderrLog, scan, kill } = spawnSession({
    db, launchDir: join(hubDir, 'launches', launchId), command: host.command,
    args: [...host.args, ...copilotArgs({
      mode: facts.mode, agentInboxServer: (server as { name: string }).name, model: facts.model, reasoningEffort: facts.reasoningEffort,
      ...(edits ? { editsFolder: edits } : {}),
    })],
    cwd: facts.cwd, env: sessionEnv,
    spawnLog: { launch: launchId, mode: facts.mode, cwd: facts.cwd, kind: spec.kind, host: host.script, interpreter: host.command === host.script ? null : host.command },
  })
  if (created) {
    log({ event: 'worktree', path: created.path, branch: created.branch, checkout: created.checkout, base: created.baseSha })
    // uncommitted and untracked changes stayed in the checkout (§2)
    if (created.dirty) log({ event: 'checkout_dirty', count: created.dirty })
  }
  if (child.pid !== undefined) {
    const startedAt = processIdentity(child.pid)
    try {
      recordLaunchProgress(db, launchId, { childPgid: child.pid, ...(startedAt ? { childStartedAt: startedAt } : {}) })
    } catch { /* a report, not the state */ }
  }

  // test seams from the driver's own environment, bounded
  const linkWaitMs = boundedMs(process.env.AGENT_INBOX_DRIVER_LINK_WAIT_MS, 0, 10_000)
  const idleMs = boundedMs(process.env.AGENT_INBOX_DRIVER_IDLE_MS, 50, 2 * 60 * 60_000)
  const progress = launchHooks(db, launchId)
  // test seam, bounded: the final summary's budget (default 15 s)
  const finalSummaryMs = boundedMs(process.env.AGENT_INBOX_DRIVER_SUMMARY_FINAL_MS, 100, 15_000)
  // #432 §6: the worktree's summary at each turn end, at park and at end
  const held = worktreeOf
  const summaryGit = held ? findGit() : null
  const summarizer = held && typeof summaryGit === 'string'
    ? worktreeSummarizer({
      git: summaryGit, env: gitEnv(sessionEnv), path: held.path, baseRef: held.baseRef, baseSha: held.baseSha,
      write: (summary) => { try { recordWorktreeSummary(db, launchId, summary) } catch { /* the hub is gone */ } },
      ...(finalSummaryMs === undefined ? {} : { finalMs: finalSummaryMs }),
    })
    : null
  const driver = new Driver({
    db, lease, mode: facts.mode, cwd: facts.cwd, project: facts.project, stream: facts.stream, task: facts.prompt,
    input: child.stdout, output: child.stdin, child: { kill, exited },
    ui: { ask: () => undefined, settled: () => undefined, text: () => undefined, notice: (text) => log({ event: 'notice', text }) },
    log, stateDir: join(hubDir, 'drivers', launchId), scan,
    asks: appAsks({ db, launchId, launchKey: spec.launchKey, project: facts.project, stream: facts.stream, log }),
    hooks: { ...progress, ...(summarizer ? { turnEnd: () => summarizer.request() } : {}) },
    // released below, once the final summary is written and the row closed
    releaseLeases: false,
    usage: used,
    ...resume,
    timing: {
      activeMs: facts.activeMs, maxToolCalls: facts.toolCalls,
      ...(linkWaitMs === undefined ? {} : { linkWaitMs }),
      ...(idleMs === undefined ? {} : { idleMs }),
    },
  })

  // SIGTERM or SIGHUP stops in order; a second signal, or a Stop that has not
  // finished in 15 s, forces. Either way the row records how it ended.
  const closeRow = (reason: EndReason) => {
    const usage = driver.usage()
    let ended = true
    try {
      if (reason === 'idle' || reason === 'park') {
        ended = parkLaunch(db, launchId, { acpSession: driver.resumableSession(), ...usage, forgetSession: driver.sessionGone() }) !== 'parked'
      }
      // a load that failed for another reason than "never prompted" parks it again, to retry (§7)
      else if (reason === 'error:load') {
        ended = parkLaunch(db, launchId, { acpSession: loading, ...usage, reason: `Copilot could not load the session: ${driver.loadFailure() ?? 'unknown error'}` }) !== 'parked'
      } else endLaunch(db, launchId, { reason, ...usage })
    } catch { /* the hub is gone: the launch reads as lost */ }
    if (ended) unlockAtEnd(log)
  }
  const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  installStopHandlers({
    signals: process,
    input: { on: () => undefined },
    driver,
    exit: (code) => {
      closeRow('stopped')
      // the driver leaves its leases to this CLI (releaseLeases: false)
      try { releaseDriverLeases(db, lease) } catch { /* the hub is gone */ }
      if (child.pid && child.exitCode === null && child.signalCode === null) reapProcessGroup(child.pid, { kill: (pid, signal) => { process.kill(pid, signal) }, sleep })
      process.exit(code)
    },
    notice: (text) => log({ event: 'notice', text }),
    silence: () => undefined,
  })

  report({ ok: true, launch: launchId })
  const reason: EndReason = await driver.start()
  // the child exits about 1 s after its stdin closes (spike §1); after 10 s its group gets SIGTERM
  const settled = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 10_000).unref())])
  if (!settled) kill('SIGTERM')
  // the worktree as the session left it, at park and at end (§6), at most 15 s, while
  // this driver still holds its lease, so the launch never reads as lost meanwhile
  if (summarizer) {
    try { holdDriverLeases(db, lease, []) } catch { /* the hub is gone */ }
    await summarizer.final()
  }
  closeRow(reason)
  try { releaseDriverLeases(db, lease) } catch { /* the hub is gone */ }
  db.close()
  stderrLog.end()
  process.exit(reason === 'stopped' || reason === 'idle' || reason === 'park' || reason === 'child_exit' ? 0 : 1)
}

// ── #432: Remove worktree, started by Electron main (§5) ────────────────────
//
// `inspect` reads what the confirmation shows; `remove` removes the worktree,
// never its branch, adding --force only with `--discard <hash>` while the
// status still hashes to it. Both need an ended launch whose worktree is kept
// and listed by git on its branch. The env is main's capture in the checkout;
// git is found on its PATH and trust-checked like copilot. One JSON line on
// stdout: `{"ok":true,…}` or `{"ok":false,"error":…}`.
function worktreeCommand(argv: string[]): void {
  const [verb, launchId, dbPath, flag, hash] = argv
  const discard = flag === '--discard' ? hash : undefined
  if ((verb !== 'inspect' && verb !== 'remove') || !launchId || !LAUNCH_ID.test(launchId) || !dbPath || !isAbsolute(dbPath)
    || !(argv.length === 3 || (verb === 'remove' && argv.length === 5 && discard !== undefined && /^[0-9a-f]{64}$/.test(discard)))) {
    process.stderr.write('usage: agent-inbox-driver worktree inspect|remove <launch id> <absolute hub db path> [--discard <status hash>]\n')
    process.exit(64)
  }
  for (const stream of [process.stdout, process.stderr]) stream.on('error', () => undefined)
  const answer = (status: Record<string, unknown>): never => {
    try { process.stdout.write(`${JSON.stringify(status)}\n`) } catch { /* main stopped reading */ }
    return process.exit(status.ok === true ? 0 : 1)
  }
  if (process.platform !== 'darwin' && process.platform !== 'linux') answer({ ok: false, error: `${process.platform} is not supported` })
  const db = openDb(dbPath)
  const row = getLaunch(db, launchId)
  if (!row?.worktree_path || !row.checkout_root || !row.branch || !row.base_sha) return answer({ ok: false, error: 'This session has no worktree of its own.' })
  if (row.worktree_removed_at) return answer({ ok: false, error: 'This session’s worktree was already removed.' })
  if (row.status !== 'ended') return answer({ ok: false, error: 'End the session before removing its worktree.' })
  let checkout: string | null = null
  try { checkout = realpathSync.native(row.checkout_root) } catch { /* gone */ }
  if (checkout !== row.checkout_root) return answer({ ok: false, error: `The repository ${row.checkout_root} is not there any more.` })
  const git = findExecutable('git', process.env.PATH)
  if ('error' in git) return answer({ ok: false, error: git.error })
  const target = {
    git: git.path, env: gitEnv(childEnv(process.env, { path: dbPath, isDefault: true })), checkout,
    path: row.worktree_path, branch: row.branch, baseRef: row.base_ref, baseSha: row.base_sha,
  }
  if (verb === 'inspect') {
    const inspected = inspectWorktree(target)
    return answer(inspected.ok ? { ok: true, path: row.worktree_path, branch: row.branch, ...inspected.state } : inspected)
  }
  const removed = removeLaunchWorktree({ ...target, ...(discard ? { discard } : {}) })
  if (!removed.ok) return answer(removed)
  try { markWorktreeRemoved(db, launchId) } catch { /* removed on disk; the row catches up on the next Remove */ }
  return answer({ ok: true })
}

const [command, ...rest] = process.argv.slice(2)
if (command === 'copilot') await runCopilot(rest)
else if (command === 'stop') stopCommand(rest)
else if (command === 'run') await runLaunch(rest)
else if (command === 'worktree') worktreeCommand(rest)
else {
  process.stderr.write(USAGE)
  process.exit(command === '--help' || command === '-h' ? 0 : 64)
}
