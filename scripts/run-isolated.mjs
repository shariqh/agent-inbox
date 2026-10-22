#!/usr/bin/env node
// Runs one command in a session of its own and relays its exit status
// (issue #211).
//
//   run-isolated.mjs [--timeout-ms <ms>] [--lease-fd <fd>] [--started-file <path>] [--stdout] -- <command> [args...]
//
// install-agents.sh runs the Node steps of a rollback through this: a host
// CLI's `mcp remove` or `mcp get`, and the runtime reference check and prune.
// During a rollback the shell ignores repeat signals, but Node resets ignored
// signals other than PIPE and XFSZ to their defaults at startup, so a second
// Ctrl-C, or Setup's cancel, sent to the installer's process group would
// otherwise stop such a step partway.
//
// · This process ignores HUP, INT, QUIT, ALRM, TERM and XCPU from its first
//   statement on, so those signals cannot stop it while it waits. Node has
//   already reset them by then: a signal that lands while Node is still
//   starting ends this process before it has started anything, with status
//   128 + that signal, and the caller may simply run it again.
// · A command killed by one of those signals ends this process with the same
//   status. --started-file tells the two apart (#214): once this process
//   ignores those signals, and before it starts anything, it creates that
//   file, which must not exist yet. One of those statuses with no file means
//   nothing was started; with the file, the command may have run. If the
//   file cannot be created, nothing is started and the status is 126.
// · It starts a guard, this same script with --guard, detached: in a session
//   of its own, which no signal sent to the caller's process group reaches,
//   not even the SIGKILL Setup sends 10 s after a cancel. The guard starts the
//   command detached too, in a session and process group of its own.
// · The guard waits at most --timeout-ms (default 30000). Then it sends
//   SIGTERM to the command's process group, SIGKILL 2 s later, and exits 124.
//   The bound holds even when this process and its caller have been killed.
// · The command never gets this process's stdin, stdout or stderr, so it
//   cannot keep a reader's pipe open after the caller has gone. Its stdin,
//   stdout and stderr are /dev/null; with --stdout, its stdout is relayed
//   back through the guard and this process instead. --lease-fd hands that
//   one descriptor (the setup lock) to the guard and the command, so the
//   lock is held until both have ended.
// · Otherwise it exits with the command's status: its exit code, or 128 + the
//   signal that ended it. 125 means bad usage, 126 that the command could not
//   be started, 127 that it was not found.
//
// POSIX only; Node core only.
import { spawn } from 'node:child_process'
import { writeFileSync, writeSync } from 'node:fs'
import { constants } from 'node:os'
import { fileURLToPath } from 'node:url'

for (const signal of ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGALRM', 'SIGTERM', 'SIGXCPU']) {
  process.on(signal, () => {})
}

const EXIT_TIMEOUT = 124
const EXIT_USAGE = 125
const EXIT_CANNOT_RUN = 126
const EXIT_NOT_FOUND = 127
const DEFAULT_TIMEOUT_MS = 30_000
// setTimeout's own ceiling; a longer delay would fire at once.
const MAX_TIMEOUT_MS = 2_147_483_647 - 10_000
const KILL_GRACE_MS = 2_000
// After SIGKILL, how long the guard waits for the command's output to close
// before giving up on it: something it started may have left its group.
const CLOSE_GRACE_MS = 1_000
// The guard always ends within its bound plus the two graces above; this
// further margin only protects the caller from a guard that does not.
const GUARD_GRACE_MS = 5_000

function writeAll(fd, bytes) {
  let offset = 0
  try {
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset)
  } catch {
    // Whoever was reading has gone.
  }
}

// Synchronous, so a message is never lost to the process.exit() that follows.
function report(message) {
  writeAll(2, Buffer.from(`run-isolated: ${message}\n`))
}

function fail(status, message) {
  report(message)
  process.exit(status)
}

function parseOptions(argv) {
  const options = { guard: false, timeoutMs: DEFAULT_TIMEOUT_MS, leaseFd: null, startedFile: null, relayStdout: false, command: [] }
  let index = 0
  while (index < argv.length && argv[index] !== '--') {
    const flag = argv[index]
    const value = argv[index + 1] ?? ''
    if (flag === '--stdout' || flag === '--guard') {
      if (flag === '--stdout') options.relayStdout = true
      else options.guard = true
      index += 1
    } else if (flag === '--timeout-ms' && /^[1-9][0-9]*$/.test(value) && Number(value) <= MAX_TIMEOUT_MS) {
      options.timeoutMs = Number(value)
      index += 2
    } else if (flag === '--lease-fd' && /^[1-9][0-9]*$/.test(value) && Number(value) > 2 && Number(value) < 1024) {
      options.leaseFd = Number(value)
      index += 2
    } else if (flag === '--started-file' && value !== '') {
      options.startedFile = value
      index += 2
    } else {
      fail(EXIT_USAGE, `invalid option: ${flag}\nusage: run-isolated.mjs [--timeout-ms <ms>] [--lease-fd <fd>] [--started-file <path>] [--stdout] -- <command> [args...]`)
    }
  }
  options.command = argv.slice(index + 1)
  if (argv[index] !== '--' || options.command.length === 0 || options.command[0] === '') {
    fail(EXIT_USAGE, 'missing -- <command>')
  }
  return options
}

function statusOf(code, signal) {
  if (code !== null) return code >= 0 ? code : EXIT_CANNOT_RUN
  return 128 + (constants.signals[signal] ?? 0)
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal)
  } catch {
    // The whole group is gone already.
  }
}

// Starts a detached child whose stdin is /dev/null and whose stdout and
// stderr are either a pipe back to this process or /dev/null, never this
// process's own. Only the lease descriptor is handed on.
function startDetached(file, args, { stdout, stderr, leaseFd }) {
  const stdio = ['ignore', stdout, stderr]
  if (leaseFd !== null) {
    while (stdio.length < leaseFd) stdio.push('ignore')
    stdio[leaseFd] = leaseFd
  }
  return spawn(file, args, { detached: true, stdio })
}

function collect(stream) {
  const chunks = []
  stream?.on('data', (chunk) => chunks.push(chunk))
  return () => Buffer.concat(chunks)
}

function runGuard({ timeoutMs, leaseFd, relayStdout, command }) {
  let child
  try {
    child = startDetached(command[0], command.slice(1), {
      stdout: relayStdout ? 'pipe' : 'ignore',
      stderr: 'ignore',
      leaseFd,
    })
  } catch (error) {
    fail(EXIT_CANNOT_RUN, `could not start ${command[0]}: ${error.message}`)
  }
  const output = collect(child.stdout)
  let timedOut = false
  let finished = false
  const timers = []
  const finish = (status) => {
    if (finished) return
    finished = true
    for (const timer of timers) clearTimeout(timer)
    writeAll(1, output())
    process.exit(status)
  }

  timers.push(setTimeout(() => {
    timedOut = true
    report(`${command[0]} did not finish within ${timeoutMs} ms; stopping it`)
    signalGroup(child.pid, 'SIGTERM')
    timers.push(setTimeout(() => {
      signalGroup(child.pid, 'SIGKILL')
      timers.push(setTimeout(() => finish(EXIT_TIMEOUT), CLOSE_GRACE_MS))
    }, KILL_GRACE_MS))
  }, timeoutMs))

  child.on('error', (error) => {
    report(`could not start ${command[0]}: ${error.message}`)
    finish(error.code === 'ENOENT' ? EXIT_NOT_FOUND : EXIT_CANNOT_RUN)
  })
  child.on('close', (code, signal) => {
    if (timedOut) {
      // Anything the command started that is still in its group goes too.
      signalGroup(child.pid, 'SIGKILL')
      finish(EXIT_TIMEOUT)
    } else {
      finish(statusOf(code, signal))
    }
  })
}

function runFront({ timeoutMs, leaseFd, relayStdout, startedFile, command }) {
  const args = [...process.execArgv, fileURLToPath(import.meta.url), '--guard', '--timeout-ms', String(timeoutMs)]
  if (relayStdout) args.push('--stdout')
  if (leaseFd !== null) args.push('--lease-fd', String(leaseFd))
  args.push('--', ...command)
  if (startedFile !== null) {
    try {
      writeFileSync(startedFile, '', { flag: 'wx', mode: 0o600 })
    } catch (error) {
      fail(EXIT_CANNOT_RUN, `could not create its start marker: ${error.message}`)
    }
  }
  let guard
  try {
    guard = startDetached(process.execPath, args, {
      stdout: relayStdout ? 'pipe' : 'ignore',
      stderr: 'pipe',
      leaseFd,
    })
  } catch (error) {
    fail(EXIT_CANNOT_RUN, `could not start its guard: ${error.message}`)
  }
  const output = collect(guard.stdout)
  const errors = collect(guard.stderr)
  let finished = false
  const finish = (status) => {
    if (finished) return
    finished = true
    clearTimeout(fallback)
    writeAll(1, output())
    writeAll(2, errors())
    process.exit(status)
  }
  const fallback = setTimeout(() => {
    signalGroup(guard.pid, 'SIGKILL')
    report(`its guard did not end ${GUARD_GRACE_MS} ms after the ${timeoutMs} ms bound; stopped it`)
    finish(EXIT_TIMEOUT)
  }, timeoutMs + KILL_GRACE_MS + CLOSE_GRACE_MS + GUARD_GRACE_MS)

  guard.on('error', (error) => {
    report(`could not start its guard: ${error.message}`)
    finish(EXIT_CANNOT_RUN)
  })
  guard.on('close', (code, signal) => finish(statusOf(code, signal)))
}

const options = parseOptions(process.argv.slice(2))
if (options.guard) runGuard(options)
else runFront(options)
