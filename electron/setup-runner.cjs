const { existsSync, readFileSync } = require('node:fs')
const { homedir } = require('node:os')
const { isAbsolute, join, resolve } = require('node:path')
const { spawn } = require('node:child_process')

const TARGETS = new Set(['all', 'claude', 'copilot'])
const DEFAULT_MAX_OUTPUT = 64 * 1024
const DEFAULT_TIMEOUT_MS = 120_000

function installerPath(repoRoot) {
  return join(repoRoot, 'scripts', 'install-agents.sh')
}

function installerRepoRoot(appRoot) {
  const bakedPath = join(appRoot, 'setup-info.json')
  if (existsSync(bakedPath)) {
    try {
      const root = JSON.parse(readFileSync(bakedPath, 'utf8')).repoRoot
      if (typeof root === 'string' && isAbsolute(root) && existsSync(installerPath(root))) {
        return resolve(root)
      }
    } catch {
      // Fall through to the development checkout.
    }
  }
  return existsSync(installerPath(appRoot)) ? resolve(appRoot) : null
}

function isTrustedSetupSender(senderUrl, viewerUrl) {
  try {
    return new URL(senderUrl).origin === new URL(viewerUrl).origin
  } catch {
    return false
  }
}

function canRunSetup(senderUrl, viewerUrl, senderId, authorizedWebContentsId) {
  return Number.isInteger(senderId) &&
    senderId === authorizedWebContentsId &&
    isTrustedSetupSender(senderUrl, viewerUrl)
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

function runAgentInstall({
  repoRoot,
  target,
  env = process.env,
  maxOutput = DEFAULT_MAX_OUTPUT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnImpl = spawn,
  onCancel = () => {},
}) {
  if (!TARGETS.has(target)) {
    return Promise.resolve({
      ok: false,
      exitCode: null,
      output: `Invalid setup target: ${String(target)}`,
      target: String(target),
      timedOut: false,
      cancelled: false,
    })
  }
  const script = installerPath(repoRoot)
  if (!existsSync(script)) {
    return Promise.resolve({
      ok: false,
      exitCode: null,
      output: `Installer not found at ${script}`,
      target,
      timedOut: false,
      cancelled: false,
    })
  }

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
      child = spawnImpl('/bin/bash', [script, '--apply', '--target', target], {
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
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
      forceTimer = setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
        finish(null)
      }, 10_000)
    }
    onCancel(() => terminate('Installer cancelled because Agent Inbox is closing.'))
    timer = setTimeout(() => terminate(`Installer timed out after ${timeoutMs}ms.`, true), timeoutMs)
  })
}

module.exports = {
  canRunSetup,
  installerRepoRoot,
  isTrustedSetupSender,
  runAgentInstall,
}
