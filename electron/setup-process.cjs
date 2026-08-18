const { existsSync } = require('node:fs')
const { homedir } = require('node:os')
const { isAbsolute, join } = require('node:path')
const { spawn } = require('node:child_process')

const TARGETS = new Set(['all', 'claude', 'copilot'])
const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux'])
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/i
const DEFAULT_MAX_OUTPUT = 64 * 1024
const DEFAULT_TIMEOUT_MS = 120_000
const FORCE_KILL_MS = 10_000

function setupResult(target, output) {
  return {
    ok: false,
    exitCode: null,
    output,
    target: String(target),
    timedOut: false,
    cancelled: false,
  }
}

function installerPath(repoRoot) {
  return join(repoRoot, 'scripts', 'install-agents.sh')
}

function installerEnv(env) {
  const home = env.HOME || homedir()
  const extra = [
    join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
  ]
  return { ...env, PATH: [...extra, env.PATH || ''].filter(Boolean).join(':') }
}

function validatedOperation(operation, platform) {
  const target = operation?.target
  if (!TARGETS.has(target)) {
    return { error: setupResult(target, `Invalid setup target: ${String(target)}`) }
  }
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    return { error: setupResult(target, `Agent Inbox Setup is unsupported on ${platform}.`) }
  }

  const repoRoot = operation?.repoRoot
  if (typeof repoRoot !== 'string' || !isAbsolute(repoRoot)) {
    return { error: setupResult(target, 'Invalid Setup repository root.') }
  }
  const script = installerPath(repoRoot)
  if (!existsSync(script)) {
    return { error: setupResult(target, `Installer not found at ${script}`) }
  }

  const runtime = operation?.runtime
  if (runtime !== null) {
    if (
      !runtime ||
      typeof runtime !== 'object' ||
      typeof runtime.sourceRoot !== 'string' ||
      !isAbsolute(runtime.sourceRoot) ||
      typeof runtime.manifestDigest !== 'string' ||
      !DIGEST_RE.test(runtime.manifestDigest)
    ) {
      return { error: setupResult(target, 'Invalid runtime source or manifest digest.') }
    }
  }

  return { target, repoRoot, script, runtime }
}

function createSetupProcessRunner({
  platform = process.platform,
  env = process.env,
  maxOutput = DEFAULT_MAX_OUTPUT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnImpl = spawn,
  killImpl = process.kill.bind(process),
} = {}) {
  return Object.freeze({
    id: 'posix-shell-v1',
    async start(operation, { onCancel = () => {} } = {}) {
      const validated = validatedOperation(operation, platform)
      if (validated.error) return validated.error

      const { target, repoRoot, script, runtime } = validated
      const runtimeArgs = runtime === null
        ? []
        : [
            '--runtime-source',
            runtime.sourceRoot,
            '--runtime-digest',
            runtime.manifestDigest,
          ]

      return new Promise((resolveResult) => {
        let output = ''
        let truncated = false
        let timedOut = false
        let cancelled = false
        let settled = false
        let terminating = false
        let timer = null
        let forceTimer = null
        const append = (chunk) => {
          output += String(chunk)
          if (output.length > maxOutput) {
            output = output.slice(-maxOutput)
            truncated = true
          }
        }
        const finish = (exitCode, extra = '') => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          clearTimeout(forceTimer)
          if (extra) append(extra)
          resolveResult({
            ok: exitCode === 0 && !timedOut,
            exitCode,
            output: `${truncated ? '[output truncated]\n' : ''}${output}`.trim(),
            target,
            timedOut,
            cancelled,
          })
        }

        let child
        try {
          child = spawnImpl('/bin/bash', [script, '--apply', '--target', target, ...runtimeArgs], {
            cwd: repoRoot,
            detached: true,
            env: installerEnv(env),
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        } catch (err) {
          finish(null, `Could not start installer: ${err.message}`)
          return
        }
        child.stdout?.on('data', append)
        child.stderr?.on('data', append)
        child.on('error', (err) => finish(null, `\nCould not start installer: ${err.message}`))
        child.on('close', (code) => finish(code))
        const terminate = (reason, timeout = false) => {
          if (settled || terminating) return
          terminating = true
          timedOut = timeout
          cancelled = !timeout
          append(`\n${reason}`)
          try {
            killImpl(-child.pid, 'SIGTERM')
          } catch {
            child.kill('SIGTERM')
          }
          forceTimer = setTimeout(() => {
            try {
              killImpl(-child.pid, 'SIGKILL')
            } catch {
              child.kill('SIGKILL')
            }
            finish(null)
          }, FORCE_KILL_MS)
        }
        onCancel(() => terminate('Installer cancelled because Agent Inbox is closing.'))
        timer = setTimeout(() => terminate(`Installer timed out after ${timeoutMs}ms.`, true), timeoutMs)
      })
    },
  })
}

module.exports = { createSetupProcessRunner }
