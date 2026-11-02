'use strict'
// Issue #412 step 3 — starting a detached driver (design §8). The one place
// main starts a driven session, after the native confirmation, mirroring
// setup-process.cjs: exact argv only,
//
//   [<runtime>/bin/node, <runtime>/dist/driver-cli.js, 'run', <launch id>, <hub db>]
//
// from the installed runtime main verified against the signed digest (or a
// checkout's own build in development), detached into its own session, no
// shell, stdin closed, stderr to the launch's log, and the spec (with the
// launch key) written to a PIPE on fd 3, never a file. Nothing the renderer
// sends becomes argv, a path or an env. It reads the driver's one stdout status
// line, then lets it run on: drivers outlive the app (§7). Any platform but
// macOS fails closed before anything is spawned (§10).
const fs = require('node:fs')
const path = require('node:path')

const LAUNCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const STATUS_TIMEOUT_MS = 30_000
const MAX_STATUS = 4096

function driverArgv({ entry, launchId, hubPath }) {
  return [entry, 'run', launchId, hubPath]
}

function failure(error) {
  return { ok: false, error }
}

/**
 * Starts the driver and resolves its status: { ok: true, launch, pid } once it
 * says the session is starting, or { ok: false, error }. Never rejects.
 */
function startDriver({
  platform = process.platform, node, entry, launchId, hubPath, spec, logPath, env, spawnImpl, fsImpl = fs, timeoutMs = STATUS_TIMEOUT_MS,
}) {
  if (platform !== 'darwin') return Promise.resolve(failure('Starting sessions from Agent Inbox is available on macOS only.'))
  for (const value of [node, entry, hubPath, logPath]) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) return Promise.resolve(failure('The driver could not be found.'))
  }
  if (typeof launchId !== 'string' || !LAUNCH_ID.test(launchId) || !spec || typeof spec !== 'object') {
    return Promise.resolve(failure('The launch is not valid.'))
  }
  let log
  try {
    fsImpl.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 })
    log = fsImpl.openSync(logPath, 'a', 0o600)
  } catch {
    return Promise.resolve(failure('The launch log could not be created.'))
  }
  let child
  try {
    child = spawnImpl(node, driverArgv({ entry, launchId, hubPath }), {
      cwd: '/', env, detached: true, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', log, 'pipe'],
    })
  } catch {
    return Promise.resolve(failure('The driver could not be started.'))
  } finally {
    try { fsImpl.closeSync(log) } catch { /* closed */ }
  }
  return new Promise((resolve) => {
    let done = false
    let output = ''
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { child.stdout.destroy() } catch { /* gone */ }
      try { child.unref() } catch { /* gone */ }
      resolve(result)
    }
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGTERM') } catch { /* gone */ }
      finish(failure('The driver did not start in time.'))
    }, timeoutMs)
    const specPipe = child.stdio[3]
    specPipe.on('error', () => {})
    specPipe.end(JSON.stringify(spec))
    child.on('error', () => finish(failure('The driver could not be started.')))
    // 'close', not 'exit': its status line is read first
    child.on('close', (code) => finish(failure(`The driver stopped before the session started (exit ${code}).`)))
    child.stdout.on('error', () => {})
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8')
      const line = output.indexOf('\n')
      if (line === -1) {
        if (output.length > MAX_STATUS) finish(failure('The driver reported something unexpected.'))
        return
      }
      let status = null
      try {
        status = JSON.parse(output.slice(0, line))
      } catch { /* checked below */ }
      if (status && status.ok === true && status.launch === launchId) finish({ ok: true, launch: launchId, pid: child.pid })
      else if (status && status.ok === false && typeof status.error === 'string') finish(failure(status.error.slice(0, 500)))
      else finish(failure('The driver reported something unexpected.'))
    })
  })
}

module.exports = { driverArgv, startDriver }
