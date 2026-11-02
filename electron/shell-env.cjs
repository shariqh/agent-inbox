'use strict'
// Issue #412 step 3 — capturing the environment a launch runs with (design §8).
//
// A Finder-launched app has a minimal PATH (no nvm, volta, mise or asdf), so
// for each launch main runs the user's login shell once, interactive (zsh reads
// .zshrc only then, where version managers are set up), WITH ITS CWD SET TO THE
// LAUNCH FOLDER (per-folder version managers pick their version as the shell
// starts there), stdin closed, and a 10 s bound. The command prints a random
// start marker, `env -0` and an end marker; only what lies between the markers
// is read, so banners and rc output are ignored. The result is kept in memory
// and passed on fd 3; it is never written to disk.
//
// A timeout or a failure is reported, never retried in a loop: the human sees
// it and can try again ("Refresh environment" is simply another attempt).
const { randomBytes } = require('node:crypto')
const path = require('node:path')

const TIMEOUT_MS = 10_000
const MAX_OUTPUT = 4 * 1024 * 1024
const MAX_ENTRIES = 1000
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/

/** Parses `env -0` output between the markers; null when they are not both there in order. */
function parseCapturedEnv(output, start, end) {
  const from = output.indexOf(start)
  if (from === -1) return null
  const to = output.indexOf(end, from + start.length)
  if (to === -1) return null
  const env = {}
  let count = 0
  for (const entry of output.slice(from + start.length, to).split('\0')) {
    const equals = entry.indexOf('=')
    if (equals <= 0) continue
    const name = entry.slice(0, equals)
    // exported shell functions and other odd names are not variables the driver passes on
    if (!NAME.test(name) || Object.prototype.hasOwnProperty.call(env, name)) continue
    if (++count > MAX_ENTRIES) break
    env[name] = entry.slice(equals + 1)
  }
  return env
}

/**
 * Runs `<shell> -i -l -c '<markers around env -0>'` in `cwd`. Resolves
 * { ok: true, env } or { ok: false, reason: 'shell' | 'timeout' | 'failed' }.
 * Never rejects.
 */
function captureShellEnv({ shell, cwd, baseEnv, spawnImpl, timeoutMs = TIMEOUT_MS, random = randomBytes }) {
  if (typeof shell !== 'string' || !path.isAbsolute(shell) || typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    return Promise.resolve({ ok: false, reason: 'shell' })
  }
  const start = `__AGENT_INBOX_ENV_${random(12).toString('hex')}__`
  const end = `__AGENT_INBOX_END_${random(12).toString('hex')}__`
  const script = `printf '%s' '${start}'; /usr/bin/env -0; printf '%s' '${end}'`
  return new Promise((resolve) => {
    let child
    try {
      child = spawnImpl(shell, ['-i', '-l', '-c', script], {
        cwd, env: baseEnv, stdio: ['ignore', 'pipe', 'ignore'], detached: true, shell: false, windowsHide: true,
      })
    } catch {
      resolve({ ok: false, reason: 'failed' })
      return
    }
    const chunks = []
    let size = 0
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(result)
    }
    const killGroup = () => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        try { child.kill('SIGKILL') } catch { /* gone */ }
      }
    }
    const timer = setTimeout(() => {
      killGroup()
      finish({ ok: false, reason: 'timeout' })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_OUTPUT) {
        killGroup()
        finish({ ok: false, reason: 'failed' })
        return
      }
      chunks.push(chunk)
    })
    child.on('error', () => finish({ ok: false, reason: 'failed' }))
    child.on('close', () => {
      const env = parseCapturedEnv(Buffer.concat(chunks).toString('utf8'), start, end)
      finish(env ? { ok: true, env } : { ok: false, reason: 'failed' })
    })
  })
}

module.exports = { captureShellEnv, parseCapturedEnv }
