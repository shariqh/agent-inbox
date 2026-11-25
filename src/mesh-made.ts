// Made agents (agents a chat makes, step 1): what meshctl reads of one. A made agent is an agent
// `meshctl add` added by its loopback card address, plus two private files that let the mesh
// start it: its description, `<mesh dir>/mesh/agents/<id>.json`, and its start profile,
// `<mesh dir>/mesh/wrappers/<id>.json` (`{ "made": true, "port", "start" }`), which name the one
// shared runner in packages/mesh. This module holds the card file rule (D1), which packages/mesh's
// src/made-card.ts repeats for the runner (the shared cases in test/fixtures/made-agents/ hold both
// to the same verdicts in the same words), and the readers status, remove, server and call use.
// Node core and the config reader only; only meshctl imports it.
import { join } from 'node:path'
import { MODEL_NAME, SERVER_NAME, isClaudeServer, readPrivate, readServers } from './mesh-config.js'

export type MadeCard = { name: string; description: string; instructions: string; server: string; model: string }
/** What servers.json holds under a name: a Claude Code server, an address server, or nothing. */
export type ServerKind = (name: string) => 'claude-code' | 'address' | undefined

export const CARD_FILE_MAX = 64 * 1024
const ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
const KEYS = ['name', 'description', 'instructions', 'server', 'model'] as const
const CLAUDE_MODELS = ['haiku', 'sonnet', 'opus']
const ONE_LINE_BAD = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/
const TEXT_BAD = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/
const INSTRUCTIONS_MAX = 16384

const RULES = {
  name: '"name" must equal the agent\'s id: 1 to 40 lower-case letters, digits and inner hyphens',
  description: '"description" must be one line of 1 to 200 characters, with no control characters',
  instructions: `"instructions" must be text of 1 to ${INSTRUCTIONS_MAX} characters: line breaks and tabs, but no other control characters`,
  server: '"server" must be a model server\'s name: 1 to 40 lower-case letters, digits or "-"',
  noServer: '"server" names no model server in servers.json (meshctl server list shows them)',
  claudeModel: '"model" must be haiku, sonnet or opus: the server is Claude Code on this Mac',
  needsModel: '"model" is needed unless the server is Claude Code on this Mac',
  model: '"model" must be 1 to 64 letters, digits, ".", "_", ":", "/" or "-"',
}

/**
 * A card file (or, with `stored`, a stored description) for the agent `id`: one JSON object with
 * exactly name, description, instructions, server and model (optional for a Claude Code server,
 * where it is sonnet; a stored description also has `"schema": 1` and always its model). A
 * refusal names the key and the rule, never a value.
 */
export function parseMadeCard(text: string, id: string, kind: ServerKind, stored = false): { card: MadeCard } | { refused: string } {
  const what = stored ? 'the description' : 'the card file'
  if (Buffer.byteLength(text) > CARD_FILE_MAX) return { refused: `${what} is larger than 64 KiB` }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { refused: `${what} is not valid JSON` }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { refused: `${what} must be one JSON object` }
  const doc = value as Record<string, unknown>
  const allowed: readonly string[] = stored ? ['schema', ...KEYS] : KEYS
  const unknown = Object.keys(doc).find((key) => !allowed.includes(key))
  if (unknown !== undefined) return { refused: /^[a-z]{1,32}$/.test(unknown) ? `${what} holds the key "${unknown}", which it does not take` : `${what} holds a key this build does not know` }
  if (stored && doc['schema'] !== 1) return { refused: 'the description\'s "schema" must be 1' }
  const missing = KEYS.find((key) => (stored || key !== 'model') && !Object.hasOwn(doc, key))
  if (missing !== undefined) return { refused: `${what} has no "${missing}"` }
  const { name, description, instructions, server, model } = doc
  if (typeof name !== 'string' || name !== id || !ID.test(name)) return { refused: RULES.name }
  if (typeof description !== 'string' || ONE_LINE_BAD.test(description) || description.trim().length < 1 || description.trim().length > 200) return { refused: RULES.description }
  if (typeof instructions !== 'string' || TEXT_BAD.test(instructions) || !instructions.trim() || instructions.length > INSTRUCTIONS_MAX) return { refused: RULES.instructions }
  if (typeof server !== 'string' || !SERVER_NAME.test(server)) return { refused: RULES.server }
  const serverKind = kind(server)
  if (serverKind === undefined) return { refused: RULES.noServer }
  const claude = serverKind === 'claude-code'
  if (model === undefined && !claude) return { refused: RULES.needsModel }
  if (model !== undefined && (typeof model !== 'string' || !(claude ? CLAUDE_MODELS.includes(model) : MODEL_NAME.test(model)))) return { refused: claude ? RULES.claudeModel : RULES.model }
  return { card: { name, description: description.trim(), instructions, server, model: (model as string | undefined) ?? 'sonnet' } }
}

/** The kinds of the servers in `<dir>/mesh/servers.json`; none when it is missing or refused. */
export function serverKinds(dir: string): ServerKind {
  const read = readServers(dir)
  return (name) => (read.kind === 'present' && Object.hasOwn(read.servers, name) ? (isClaudeServer(read.servers[name]!) ? 'claude-code' : 'address') : undefined)
}

/** A made agent's files: its description, its start profile and its start log. */
export const madePaths = (dir: string, id: string) => ({
  description: join(dir, 'mesh', 'agents', `${id}.json`),
  profile: join(dir, 'mesh', 'wrappers', `${id}.json`),
  log: join(dir, 'mesh', 'logs', `${id}-agent.log`),
})
