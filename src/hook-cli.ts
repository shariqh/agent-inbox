#!/usr/bin/env node
// The Claude Code hook entry point (issues #10 / #21). Mirrors the
// mcp-server.ts / viewer-server.ts entry split so tsconfig.build.json emits a
// flat dist/hook-cli.js.
//
// This file owns the fail-open envelope: a hook that throws prints in the
// human's terminal and a hook that hangs stalls their prompt, so nothing from
// runHook may reach the harness and stdin reading is both byte- and time-capped.
import { fileURLToPath } from 'node:url'
import { runHook } from './hook.js'

// The last-resort belt. runHook has its own try/catch; this catches anything
// escaping the plumbing around it (a rejected write, a torn-down stdin).
process.on('unhandledRejection', () => process.exit(0))
process.on('uncaughtException', () => process.exit(0))

const MAX_STDIN_BYTES = 256 * 1024
const STDIN_TIMEOUT_MS = 3000

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('')
    let out = ''
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      resolve(out)
    }
    // unref'd: a stdin that never closes must not hold the process — or the
    // human's prompt — open
    const timer = setTimeout(finish, STDIN_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk: string) => {
      out += chunk
      if (out.length > MAX_STDIN_BYTES) {
        out = out.slice(0, MAX_STDIN_BYTES)
        finish()
      }
    })
    process.stdin.on('end', finish)
    process.stdin.on('error', finish)
  })
}

const stdinText = await readStdin()
// The runtime re-launches this same entry, detached, to make the backstop's
// grace-window decision — it cannot know its own path from inside hook.ts.
const env = { ...process.env, AGENT_INBOX_HOOK_ENTRY: fileURLToPath(import.meta.url) }
const result = await runHook(process.argv.slice(2), stdinText, env)
if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)
// exitCode is non-zero only for `watch` (2 — what wakes the model via
// asyncRewake) and a failed `selftest` (1 — what the installer checks).
process.exit(result.exitCode ?? 0)
