#!/usr/bin/env node
// Issue #412, step 2 — `agent-inbox-driver`: start a Copilot session over ACP
// in the foreground and drive it from this terminal. Design:
// docs/superpowers/specs/2026-10-31-driven-sessions-design.md §2, §3.2, §4.3, §7
// and §11 (step 2).
//
//   agent-inbox-driver copilot --cwd <dir> --mode ask|read-only --prompt-file <file> [--model <id>]
//   agent-inbox-driver stop <launch id>
//
// Approvals happen on this terminal, so it refuses to run without a TTY on
// stdin. The copilot child gets its own pipes: its stdout carries ACP only, its
// stderr goes to the launch's log, and nothing of it reaches this terminal
// except what the driver prints.
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  accessSync, appendFileSync, constants, createWriteStream, mkdirSync, readFileSync, realpathSync, renameSync,
  statSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { Driver } from './driver.js'
import type { EndReason } from './driver.js'
import { createTerminal, installStopHandlers, reapProcessGroup } from './driver-tty.js'
import { installedRuntimeOf, processStartedAt, removePin, writePin } from './driver-pin.js'
import { findNativeHost, linkSessions, readProcesses } from './driver-link.js'
import { childEnv, copilotAgentInboxServer, copilotArgs, terminalSafe } from './driver-policy.js'
import type { LaunchMode } from './driver-policy.js'
import { inferProject, inferStream } from './infer.js'
import { claimDriverSlot, defaultDbPath, listHostSessions, openDb, releaseDriverLeases, requestDriverStop } from './store.js'

const USAGE = `usage: agent-inbox-driver copilot --cwd <dir> --mode ask|read-only --prompt-file <file> [--model <id>]
       agent-inbox-driver stop <launch id>
`
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
}

function parseRun(argv: string[]): RunArgs {
  const values = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!
    const value = argv[i + 1]
    if (!['--cwd', '--mode', '--prompt-file', '--model'].includes(flag) || value === undefined || values.has(flag)) {
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
  return { cwd, mode, promptFile, ...(model ? { model } : {}) }
}

// The copilot on this terminal's PATH, as a real path owned by this user or
// root and not writable by group or others (§8).
function resolveCopilot(path: string | undefined): string {
  for (const dir of (path ?? '').split(':')) {
    if (!dir || !isAbsolute(dir)) continue
    const candidate = join(dir, 'copilot')
    try {
      accessSync(candidate, constants.X_OK)
      const real = realpathSync(candidate)
      const info = statSync(real)
      if (!info.isFile()) continue
      const uid = process.getuid?.() ?? -1
      if ((info.uid !== uid && info.uid !== 0) || (info.mode & 0o022) !== 0) {
        fail(`${real} is not owned by you or root, or is writable by others; refusing to run it`)
      }
      return real
    } catch { /* not here */ }
  }
  return fail('no copilot executable on PATH (install GitHub Copilot CLI first)')
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

function stopCommand(argv: string[]): void {
  const id = argv[0]
  if (argv.length !== 1 || !id) {
    process.stderr.write(USAGE)
    process.exit(64)
  }
  const db = openDb(defaultDbPath())
  try {
    requestDriverStop(db, id)
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
  // Run from an installed runtime, the driver pins it for as long as it runs,
  // so no prune removes the runtime under it (§7). Every exit path, forced or
  // not, ends in process.exit, whose 'exit' handler removes the pin; a pin a
  // crash leaves never counts once this process is gone, and the next prune
  // sweeps it.
  const runtime = installedRuntimeOf(fileURLToPath(import.meta.url))
  if (runtime) {
    const startedAt = processStartedAt(process.pid)
    let pinPath: string | null = null
    try {
      if (startedAt) pinPath = writePin(runtime, { launchId, pid: process.pid, startedAt })
    } catch { /* reported below */ }
    if (!pinPath) {
      try { releaseDriverLeases(db, lease) } catch { /* the hub is gone */ }
      fail(`could not pin the runtime it runs from in ${join(runtime.root, '.pins')}, so a prune could remove it mid-session`, 1)
    }
    const pinned = pinPath
    process.on('exit', () => removePin(pinned, launchId))
  }

  const launchDir = join(hubDir, 'launches', launchId)
  const log = eventLog(launchDir)
  const stderrLog = createWriteStream(join(launchDir, 'copilot.stderr.log'), { flags: 'a', mode: 0o600 })

  const child = spawn(copilot, copilotArgs({ mode: args.mode, agentInboxServer: server.name, model: args.model }), {
    cwd,
    env: childEnv(process.env, { path: dbPath, isDefault: process.env.AGENT_INBOX_DB === undefined }),
    stdio: ['pipe', 'pipe', 'pipe'],
    // its own process group, so this terminal's Ctrl-C reaches only the driver,
    // which stops the session in order (§7)
    detached: true,
  })
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
  log({ event: 'spawn', launch: launchId, mode: args.mode, cwd, pid: child.pid ?? null })

  let childStartMs: number | null = null
  const scan = async () => {
    const procs = await readProcesses()
    if (child.pid === undefined) return { hostPid: null, linked: [], dead: [] }
    childStartMs ??= procs.get(child.pid)?.startMs ?? null
    const hostPid = findNativeHost(procs, child.pid)
    if (hostPid === null || childStartMs === null) return { hostPid: null, linked: [], dead: [] }
    const rows = listHostSessions(db, hostPid).map((row) => ({ ...row, host_pid: hostPid }))
    const linked = linkSessions(rows, procs, { hostPid, childStartMs })
    return { hostPid, linked: linked.linked, dead: linked.dead }
  }

  const rawLinkWait = Number(process.env.AGENT_INBOX_DRIVER_LINK_WAIT_MS)
  const linkWaitMs = Number.isInteger(rawLinkWait) && rawLinkWait >= 0 && rawLinkWait <= 10_000 ? rawLinkWait : undefined

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
    child: { kill: (signal) => { if (child.pid) try { process.kill(-child.pid, signal) } catch { /* gone */ } }, exited },
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
  process.exit(reason === 'stopped' || reason === 'idle' || reason === 'child_exit' ? 0 : 1)
}

const [command, ...rest] = process.argv.slice(2)
if (command === 'copilot') await runCopilot(rest)
else if (command === 'stop') stopCommand(rest)
else {
  process.stderr.write(USAGE)
  process.exit(command === '--help' || command === '-h' ? 0 : 64)
}
