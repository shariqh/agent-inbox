// A made agent's card file and stored description (agents a chat makes, step 1, D1): the runner's
// copy of the rule src/mesh-made.ts holds for meshctl new. The package cannot import the app's
// source, so the shared cases in test/fixtures/made-agents/ hold both readers to the same verdicts
// in the same words. A card file is one JSON object with exactly `name` (the agent's id),
// `description` (one line, 1 to 200 characters once trimmed), `instructions` (1 to 16384
// characters of text: line breaks and tabs, no other control character), `server` (a model
// server's name in servers.json) and `model` (optional for a Claude Code server, where it is
// sonnet). The stored description, `<mesh dir>/mesh/agents/<id>.json`, is the same object with
// `"schema": 1` and the model always written. A refusal names the key and the rule, never a value.
import { CLAUDE_MODELS } from './claude-post.js'
import { SERVER_NAME } from './mesh-config.js'

export type MadeCard = { name: string; description: string; instructions: string; server: string; model: string }
/** What servers.json holds under a name: a Claude Code server, an address server, or nothing. */
export type ServerKind = (name: string) => 'claude-code' | 'address' | undefined

export const CARD_FILE_MAX = 64 * 1024
/** The id rule of meshctl add's --id (src/mesh-entry.ts). */
export const MADE_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
const KEYS = ['name', 'description', 'instructions', 'server', 'model'] as const
const MODEL_NAME = /^[A-Za-z0-9._:/-]{1,64}$/
const ONE_LINE_BAD = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/
const TEXT_BAD = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/
const INSTRUCTIONS_MAX = 16384
/** A lone surrogate: text that is not well-formed Unicode (it has no UTF-8 form). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

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

/** The card (or, with `stored`, the description) for the agent `id`, or why not. */
export function checkMadeCard(value: unknown, id: string, kind: ServerKind, stored = false): { card: MadeCard } | { refused: string } {
  const what = stored ? 'the description' : 'the card file'
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { refused: `${what} must be one JSON object` }
  const doc = value as Record<string, unknown>
  const allowed: readonly string[] = stored ? ['schema', ...KEYS] : KEYS
  const unknown = Object.keys(doc).find((key) => !allowed.includes(key))
  if (unknown !== undefined) return { refused: /^[a-z]{1,32}$/.test(unknown) ? `${what} holds the key "${unknown}", which it does not take` : `${what} holds a key this build does not know` }
  if (stored && doc['schema'] !== 1) return { refused: 'the description\'s "schema" must be 1' }
  const missing = KEYS.find((key) => (stored || key !== 'model') && !Object.hasOwn(doc, key))
  if (missing !== undefined) return { refused: `${what} has no "${missing}"` }
  if (KEYS.some((key) => typeof doc[key] === 'string' && LONE_SURROGATE.test(doc[key] as string))) return { refused: `${what} holds text that is not well-formed Unicode (a lone surrogate)` }
  const { name, description, instructions, server, model } = doc
  if (typeof name !== 'string' || name !== id || !MADE_ID.test(name)) return { refused: RULES.name }
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

/** checkMadeCard on a file's text: at most 64 KiB of JSON. */
export function parseMadeCard(text: string, id: string, kind: ServerKind, stored = false): { card: MadeCard } | { refused: string } {
  const what = stored ? 'the description' : 'the card file'
  if (Buffer.byteLength(text) > CARD_FILE_MAX) return { refused: `${what} is larger than 64 KiB` }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { refused: `${what} is not valid JSON` }
  }
  return checkMadeCard(value, id, kind, stored)
}
