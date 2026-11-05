// The JSON half of scripts/install-copilot-hooks.sh (#466 PR 3): builds the one
// Copilot CLI hooks file Agent Inbox owns, and tells whether a file at that path
// is that file. No writes here: the shell installer owns the lock, the backup
// and the rename. Plain Node with no dependencies, run with the proven Node.
//
//   node copilot-hooks.mjs build <node> <entry> [--no-tool-stamps]   prints the file
//   node copilot-hooks.mjs check <file|->                            prints "ours" (exit 0), or exit 3
// The installer trusts `check` only when it PRINTS "ours", so a helper that ran
// nothing (exit 0, no output) refuses rather than passes.
import { readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Copilot CLI event → the hook-cli subcommand it runs (docs/hooks.md). Each is a
// subcommand of its own, so an older hook-cli (a checkout switched back and
// rebuilt) refuses it as a silent no-op instead of reading every event as a
// tool. Never preToolUse: a hook that fails there denies the tool call.
const EVENTS = { userPromptSubmitted: 'host-turn', agentStop: 'host-idle', errorOccurred: 'host-error', postToolUse: 'host-tool', sessionEnd: 'host-end' }
// The shape PR 3's first build wrote ([entry, 'activity', kind]), still ours so an upgrade replaces it.
const LEGACY = { userPromptSubmitted: 'turn', agentStop: 'idle', errorOccurred: 'idle', postToolUse: 'tool', sessionEnd: 'end' }

/** The hooks file: exec form, so no path reaches a shell. */
export function copilotHooksFile(node, entry, { tools = true } = {}) {
  const hooks = {}
  for (const [event, kind] of Object.entries(EVENTS)) {
    if (kind === 'host-tool' && !tools) continue
    hooks[event] = [{ type: 'command', exec: node, args: [entry, kind], timeoutSec: 5 }]
  }
  return { version: 1, hooks }
}

const ourArgs = (event, args) => Array.isArray(args) && typeof args[0] === 'string' && args[0].endsWith('hook-cli.js')
  && ((args.length === 2 && args[1] === EVENTS[event]) || (args.length === 3 && args[1] === 'activity' && args[2] === LEGACY[event]))

/** Exactly the shape copilotHooksFile writes (or wrote), whatever its Node, entry or tool choice. */
export function isOurs(value) {
  if (!value || typeof value !== 'object' || value.version !== 1 || !value.hooks || typeof value.hooks !== 'object') return false
  const events = Object.entries(value.hooks)
  return events.length > 0 && events.every(([event, list]) => Object.hasOwn(EVENTS, event) && Array.isArray(list) && list.length === 1
    && list.every((h) => h?.type === 'command' && typeof h.exec === 'string' && ourArgs(event, h.args)))
}

// Both sides canonicalized (runtime-payload.mjs's isMainModule): Node resolves
// a main module's import.meta.url through symlinks (/var → /private/var, a
// symlinked checkout) while argv[1] keeps the path as typed. A naive compare
// skipped the CLI entirely, so `check` passed any file and `build` printed nothing.
const canonical = (path) => {
  try { return realpathSync(path) } catch { return path }
}
if (process.argv[1] && canonical(fileURLToPath(import.meta.url)) === canonical(resolve(process.argv[1]))) {
  const [command, ...rest] = process.argv.slice(2)
  if (command === 'build' && rest.length >= 2) {
    process.stdout.write(`${JSON.stringify(copilotHooksFile(rest[0], rest[1], { tools: !rest.includes('--no-tool-stamps') }), null, 2)}\n`)
  } else if (command === 'check' && rest.length === 1) {
    let value
    try { value = JSON.parse(readFileSync(rest[0] === '-' ? 0 : rest[0], 'utf8')) } catch { value = null }
    if (isOurs(value)) process.stdout.write('ours\n')
    else process.exitCode = 3
  } else {
    process.stderr.write('usage: copilot-hooks.mjs build <node> <entry> [--no-tool-stamps] | check <file|->\n')
    process.exit(2)
  }
}
