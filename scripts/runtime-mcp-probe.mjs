#!/usr/bin/env node
// Prove a staged runtime's MCP server STARTS (issue #103 PR2 review).
//
// `hook-cli.js selftest` loads the store and the native binding, but the MCP
// server also reaches pure modules under ../public/ that hook-cli never
// imports. A runtime missing one of them passed every selftest while its MCP
// server died with ERR_MODULE_NOT_FOUND. So, run with the runtime's OWN Node:
//
//   <runtime>/bin/node scripts/runtime-mcp-probe.mjs <runtime> [--timeout-ms N]
//
// it starts <runtime>/dist/mcp-server.js against a scratch database, sends
// initialize and tools/list over stdio, and requires the agent-inbox tools.
// Then it closes the server's stdin and waits for it to exit, killing it only
// if it does not. Argv only, piped streams, bounded by a timeout; it writes
// nothing to stdout and reports a failure, with the server's stderr, on stderr
// and exit 1.
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROBE = fileURLToPath(import.meta.url)
const REQUIRED_TOOLS = ['flag', 'pending', 'board_get']
const PROTOCOL_VERSION = '2025-06-18'
const STDERR_CAP = 64 * 1024
// How long the server gets to exit by itself once its stdin closes
const EXIT_GRACE_MS = 2_000
export const MCP_PROBE_TIMEOUT_MS = 30_000

/**
 * Run the probe with `node` (the runtime's own) against `runtime`. Throws an
 * Error carrying the probe's stderr when the server cannot start or answer.
 */
export function probeRuntimeMcp(node, runtime, { timeout = MCP_PROBE_TIMEOUT_MS } = {}) {
  try {
    execFileSync(node, [PROBE, runtime, '--timeout-ms', String(timeout)], {
      cwd: runtime,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeout + 15_000,
    })
  } catch (err) {
    const detail = err.stderr?.toString().trim() || err.message
    throw new Error(`MCP server probe (initialize + tools/list) failed: ${detail}`)
  }
}

function probe(runtime, timeoutMs) {
  const scratch = mkdtempSync(join(tmpdir(), 'agent-inbox-mcp-probe-'))
  const child = spawn(process.execPath, [join(runtime, 'dist', 'mcp-server.js')], {
    cwd: runtime,
    env: { ...process.env, AGENT_INBOX_DB: join(scratch, 'inbox.db') },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { if (stderr.length < STDERR_CAP) stderr += chunk })
  const closed = new Promise((done) => child.once('close', done))

  const waiting = new Map()
  let buffered = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffered += chunk
    for (let nl = buffered.indexOf('\n'); nl >= 0; nl = buffered.indexOf('\n')) {
      const line = buffered.slice(0, nl).trim()
      buffered = buffered.slice(nl + 1)
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      waiting.get(message.id)?.(message)
    }
  })
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  const request = (id, method, params) => new Promise((done) => {
    waiting.set(id, done)
    send({ id, method, params })
  })

  const exchange = (async () => {
    const init = await request(1, 'initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'agent-inbox-runtime-probe', version: '1' },
    })
    if (!init.result) throw new Error(`initialize failed: ${JSON.stringify(init.error ?? init)}`)
    send({ method: 'notifications/initialized' })
    const list = await request(2, 'tools/list', {})
    const names = new Set((list.result?.tools ?? []).map((tool) => tool.name))
    const missing = REQUIRED_TOOLS.filter((name) => !names.has(name))
    if (missing.length) throw new Error(`tools/list is missing ${missing.join(', ')}`)
  })()
  const exited = closed.then((code) => { throw new Error(`the server exited (${code}) before answering`) })
  let timer
  const expired = new Promise((_, fail) => {
    timer = setTimeout(() => fail(new Error(`the server did not answer within ${timeoutMs} ms`)), timeoutMs)
  })

  return Promise.race([exchange, exited, expired])
    .catch((err) => { throw new Error(`${err.message}${stderr.trim() ? `\n--- server stderr ---\n${stderr.trim()}` : ''}`) })
    .finally(async () => {
      clearTimeout(timer)
      exited.catch(() => {})
      // Closing stdin lets the server finish what it is running and exit. On
      // Windows a kill is TerminateProcess, which would orphan a git the server
      // runs for its presence write, still open inside the runtime (#333).
      child.stdin.end()
      const stopper = setTimeout(() => child.kill('SIGTERM'), EXIT_GRACE_MS)
      const killer = setTimeout(() => child.kill('SIGKILL'), EXIT_GRACE_MS + 5_000)
      await closed
      clearTimeout(stopper)
      clearTimeout(killer)
      rmSync(scratch, { recursive: true, force: true })
    })
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(PROBE)
  } catch {
    return false
  }
}

if (isMain()) {
  const [runtimeArg, flag, value] = process.argv.slice(2)
  const timeoutMs = flag === '--timeout-ms' ? Number(value) : MCP_PROBE_TIMEOUT_MS
  if (!runtimeArg || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    process.stderr.write('usage: runtime-mcp-probe.mjs <runtime-root> [--timeout-ms N]\n')
    process.exit(2)
  }
  try {
    await probe(resolve(runtimeArg), timeoutMs)
  } catch (err) {
    process.stderr.write(`runtime MCP probe failed: ${err.message}\n`)
    process.exit(1)
  }
}
