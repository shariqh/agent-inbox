#!/usr/bin/env node
// Runs one command in a session of its own and relays its exit status
// (issue #211).
//
//   run-isolated.mjs [--timeout-ms <ms>] [--lease-fd <fd>] [--stdout] -- <command> [args...]
//
// install-agents.sh runs the Node steps of a rollback through this: a host
// CLI's `mcp remove` or `mcp get`, and the runtime reference check and prune.
// During a rollback the shell ignores repeat signals, but Node resets ignored
// signals other than PIPE and XFSZ to their defaults at startup, so a second
// Ctrl-C, or Setup's cancel, sent to the installer's process group would
// otherwise stop such a step partway.
//
// · The command starts detached, in a new session and process group, so no
//   signal sent to the caller's process group reaches it.
// · This process ignores HUP, INT, QUIT, ALRM, TERM and XCPU from its first
//   statement on, so those signals cannot stop it while it waits either.
//   Node has already reset them by then: a signal that lands while Node is
//   still starting ends this process before it has started anything, with
//   status 128 + that signal, and the caller may simply run it again.
// · The command never gets this process's stdin, stdout or stderr, so it
//   cannot keep a reader's pipe open after the caller has gone. Its stdin,
//   stdout and stderr are /dev/null; with --stdout, its stdout is relayed
//   through this process instead. --lease-fd hands on that one descriptor
//   (the setup lock), so the lock is held for as long as the command runs.
// · It waits at most --timeout-ms (default 30000). Then it sends SIGTERM to
//   the command's process group, SIGKILL 2 s later, and exits 124.
// · Otherwise it exits with the command's status: its exit code, or 128 + the
//   signal that ended it. 125 means bad usage, 126 that the command could not
//   be started, 127 that it was not found.
//
// If this process is killed outright (SIGKILL), the command keeps running,
// without a bound, until it finishes. POSIX only; Node core only.
import { spawn } from 'node:child_process'
import { writeSync } from 'node:fs'
import { constants } from 'node:os'

for (const signal of ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGALRM', 'SIGTERM', 'SIGXCPU']) {
  process.on(signal, () => {})
}

const EXIT_TIMEOUT = 124
const EXIT_USAGE = 125
const EXIT_CANNOT_RUN = 126
const EXIT_NOT_FOUND = 127
const DEFAULT_TIMEOUT_MS = 30_000
// setTimeout's own ceiling; a longer delay would fire at once.
const MAX_TIMEOUT_MS = 2_147_483_647
const KILL_GRACE_MS = 2_000
// After SIGKILL, how long to wait for the command's output to close before
// giving up on it: something it started may have left its process group.
const CLOSE_GRACE_MS = 1_000

// Synchronous, so a message is never lost to the process.exit() that follows.
function report(message) {
  try {
    writeSync(2, `run-isolated: ${message}\n`)
  } catch {
    // Nobody is reading stderr.
  }
}

function fail(status, message) {
  report(message)
  process.exit(status)
}

function parseOptions(argv) {
  const options = { timeoutMs: DEFAULT_TIMEOUT_MS, leaseFd: null, relayStdout: false, command: [] }
  let index = 0
  while (index < argv.length && argv[index] !== '--') {
    const flag = argv[index]
    const value = argv[index + 1] ?? ''
    if (flag === '--stdout') {
      options.relayStdout = true
      index += 1
    } else if (flag === '--timeout-ms' && /^[1-9][0-9]*$/.test(value) && Number(value) <= MAX_TIMEOUT_MS) {
      options.timeoutMs = Number(value)
      index += 2
    } else if (flag === '--lease-fd' && /^[1-9][0-9]*$/.test(value) && Number(value) > 2 && Number(value) < 1024) {
      options.leaseFd = Number(value)
      index += 2
    } else {
      fail(EXIT_USAGE, `invalid option: ${flag}\nusage: run-isolated.mjs [--timeout-ms <ms>] [--lease-fd <fd>] [--stdout] -- <command> [args...]`)
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

const { timeoutMs, leaseFd, relayStdout, command } = parseOptions(process.argv.slice(2))
const stdio = ['ignore', relayStdout ? 'pipe' : 'ignore', 'ignore']
if (leaseFd !== null) {
  while (stdio.length < leaseFd) stdio.push('ignore')
  stdio[leaseFd] = leaseFd
}

let child
try {
  child = spawn(command[0], command.slice(1), { detached: true, stdio })
} catch (error) {
  fail(EXIT_CANNOT_RUN, `could not start ${command[0]}: ${error.message}`)
}

const output = []
child.stdout?.on('data', (chunk) => output.push(chunk))

let timedOut = false
let finished = false
const timers = []

function signalGroup(signal) {
  try {
    process.kill(-child.pid, signal)
  } catch {
    // The whole group is gone already.
  }
}

function finish(status) {
  if (finished) return
  finished = true
  for (const timer of timers) clearTimeout(timer)
  const bytes = Buffer.concat(output)
  let offset = 0
  try {
    while (offset < bytes.length) offset += writeSync(1, bytes, offset)
  } catch {
    // Whoever was reading has gone.
  }
  process.exit(status)
}

timers.push(setTimeout(() => {
  timedOut = true
  report(`${command[0]} did not finish within ${timeoutMs} ms; stopping it`)
  signalGroup('SIGTERM')
  timers.push(setTimeout(() => {
    signalGroup('SIGKILL')
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
    signalGroup('SIGKILL')
    finish(EXIT_TIMEOUT)
  } else {
    finish(statusOf(code, signal))
  }
})
