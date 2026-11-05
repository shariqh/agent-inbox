// The JSON half of scripts/install-copilot-hooks.sh (#466 PR 3): builds the one
// Copilot CLI hooks file Agent Inbox owns, and tells whether a file at that path
// is that file. No writes here: the shell installer owns the lock, the backup
// and the rename. Plain Node with no dependencies, run with the proven Node.
//
//   node copilot-hooks.mjs build <node> <entry> [--no-tool-stamps]   prints the file
//   node copilot-hooks.mjs check <file>                              exit 0 ours, 3 not
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Copilot CLI event → the `activity` kind hook-cli stamps (docs/hooks.md). Never
// preToolUse: a hook that fails there denies the tool call.
const EVENTS = { userPromptSubmitted: 'turn', agentStop: 'idle', errorOccurred: 'idle', postToolUse: 'tool', sessionEnd: 'end' }

/** The hooks file: exec form, so no path reaches a shell. */
export function copilotHooksFile(node, entry, { tools = true } = {}) {
  const hooks = {}
  for (const [event, kind] of Object.entries(EVENTS)) {
    if (kind === 'tool' && !tools) continue
    hooks[event] = [{ type: 'command', exec: node, args: [entry, 'activity', kind], timeoutSec: 5 }]
  }
  return { version: 1, hooks }
}

/** Exactly the shape copilotHooksFile writes, whatever its Node, entry or tool choice. */
export function isOurs(value) {
  if (!value || typeof value !== 'object' || value.version !== 1 || !value.hooks || typeof value.hooks !== 'object') return false
  const events = Object.entries(value.hooks)
  return events.length > 0 && events.every(([event, list]) => Object.hasOwn(EVENTS, event) && Array.isArray(list) && list.length === 1
    && list.every((h) => h?.type === 'command' && typeof h.exec === 'string' && Array.isArray(h.args) && h.args.length === 3
      && typeof h.args[0] === 'string' && h.args[0].endsWith('hook-cli.js') && h.args[1] === 'activity' && h.args[2] === EVENTS[event]))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2)
  if (command === 'build' && rest.length >= 2) {
    process.stdout.write(`${JSON.stringify(copilotHooksFile(rest[0], rest[1], { tools: !rest.includes('--no-tool-stamps') }), null, 2)}\n`)
  } else if (command === 'check' && rest.length === 1) {
    let value
    try { value = JSON.parse(readFileSync(rest[0], 'utf8')) } catch { value = null }
    process.exit(isOurs(value) ? 0 : 3)
  } else {
    process.stderr.write('usage: copilot-hooks.mjs build <node> <entry> [--no-tool-stamps] | check <file>\n')
    process.exit(2)
  }
}
