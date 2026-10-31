// Issue #412 — the driver's fixed rules for Copilot over ACP: argv per launch
// mode, mode ids and phases, the option allow-list, prompt framing and the
// child's environment. Pure, so each rule is tested on its own. Design:
// docs/superpowers/specs/2026-10-31-driven-sessions-design.md §3.2, §4.1, §5.3
// and §8; spike amendments §14.4.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Copilot's ACP mode ids are URLs (spike §4). `session/set_mode` refuses any other.
const MODE_BASE = 'https://agentclientprotocol.com/protocol/session-modes'
export const MODE_AGENT = `${MODE_BASE}#agent`
export const MODE_PLAN = `${MODE_BASE}#plan`

/**
 * The launch modes. Step 2's CLI offers `ask` and `read-only`; `plan` is the
 * Plan first machinery step 3 exposes (§4.1).
 */
export type LaunchMode = 'ask' | 'read-only' | 'plan'

/**
 * A launch's phase decides which mode is valid (§4.1). Plan first starts in
 * `awaiting_plan_approval` (only #plan), passes through `switching` (exactly
 * the driver's own one set_mode #agent) and ends in `executing` (only #agent).
 * Every other launch mode is `executing` from the start.
 */
export type Phase = 'awaiting_plan_approval' | 'switching' | 'executing'

export function initialPhase(mode: LaunchMode): Phase {
  return mode === 'plan' ? 'awaiting_plan_approval' : 'executing'
}

export function phaseMode(phase: Phase): string {
  return phase === 'awaiting_plan_approval' ? MODE_PLAN : MODE_AGENT
}

/**
 * Whether a security state is valid for a phase. `allow_all` must be off in
 * every phase; in `switching` the caller accepts the one #agent change its own
 * set_mode produced, so #plan (before it) and #agent (after it) are both valid.
 */
export function stateValid(phase: Phase, state: { mode: string; allowAll: string }): boolean {
  if (state.allowAll !== 'off') return false
  if (phase === 'switching') return state.mode === MODE_PLAN || state.mode === MODE_AGENT
  return state.mode === phaseMode(phase)
}

/**
 * Copilot's argv. No `--mode`: ACP's `session/new` ignores it (spike §4), so
 * the mode is set with `session/set_mode` and verified. The user's own
 * agent-inbox registration is pre-allowed by name (§3.2), and Read-only denies
 * the write tool. Never `--yolo`, `--allow-all-tools` or `--allow-all`.
 */
export function copilotArgs(opts: { mode: LaunchMode; agentInboxServer: string; model?: string }): string[] {
  const args = ['--acp', '--stdio', '--allow-tool', opts.agentInboxServer]
  if (opts.mode === 'read-only') args.push('--deny-tool', 'write')
  if (opts.model) args.push('--model', opts.model)
  return args
}

// ── the option allow-list (§4.1) ────────────────────────────────────────────

export interface PermissionOption {
  optionId: string
  kind: string
  name?: string
}

/**
 * Copilot 1.0.105 offers allow_once, allow_always and reject_once on every
 * request, each id equal to its kind (spike §1). v1 answers an approval with
 * allow_once and a decline with reject_once, and never selects allow_always.
 * Anything else (an unknown id, a mode switch to bypass or auto) is dropped.
 */
const COPILOT_ALLOWED: ReadonlyArray<{ optionId: string; kind: 'allow_once' | 'reject_once' }> = [
  { optionId: 'allow_once', kind: 'allow_once' },
  { optionId: 'reject_once', kind: 'reject_once' },
]

export interface FilteredOptions {
  allow: string | null
  reject: string | null
  /** Every offered option the allow-list dropped, by id. */
  dropped: string[]
}

export function filterOptions(offered: readonly unknown[]): FilteredOptions {
  let allow: string | null = null
  let reject: string | null = null
  const dropped: string[] = []
  for (const raw of offered) {
    const option = raw as Partial<PermissionOption> | null
    const id = typeof option?.optionId === 'string' ? option.optionId : ''
    const match = COPILOT_ALLOWED.find((entry) => entry.optionId === id && entry.kind === option?.kind)
    if (match?.kind === 'allow_once' && allow === null) allow = id
    else if (match?.kind === 'reject_once' && reject === null) reject = id
    else dropped.push(id || '(no id)')
  }
  return { allow, reject, dropped }
}

// ── prompt framing (§4.1 rule 5, §5.3) ──────────────────────────────────────

/** Copilot runs a prompt whose first non-space character is `/` as a slash command. */
export function promptSafe(text: string): boolean {
  return !/^\s*\//.test(text)
}

export interface PushedMessage {
  id: string
  text: string
}

export function firstPrompt(task: string): string {
  return `The human started this session via Agent Inbox with this task:\n\n${task}`
}

export function messagesPrompt(messages: readonly PushedMessage[]): string {
  const n = messages.length
  const head = `The human sent you ${n} message${n === 1 ? '' : 's'} via Agent Inbox. Each is also in pending(); act on each once, then ack_message({ id, outcome }).`
  return [head, ...messages.map((m) => `[${m.id}] ${m.text}`)].join('\n\n')
}

// An agent-authored value is quoted, single-line and bounded.
function quoted(value: string): string {
  const flat = value.replace(/[\r\n\t]+/g, ' ').replace(/'/g, '’').trim()
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat
}

export const PLAN_APPROVED_PROMPT =
  'Agent Inbox: The human approved your plan. Carry it out now; tool calls still ask for approval as before.'

export function answerPingPrompt(title: string): string {
  return `Agent Inbox: The human answered '${quoted(title)}'; call pending().`
}

export function interruptPrompt(messages: readonly PushedMessage[]): string {
  return `Agent Inbox: The human interrupted your previous turn.\n\n${messagesPrompt(messages)}`
}

// ── the approval alert (§4.2, §4.3) ─────────────────────────────────────────

/** "Allow copilot to run `git push origin ai/x`?", from the tool call the human sees. */
export function askTitle(toolTitle: string, rawInput: unknown): string {
  const command = (rawInput as { command?: unknown } | null)?.command
  const what = typeof command === 'string' && command.trim() ? command : toolTitle
  return `Allow copilot to run \`${quoted(what).replace(/`/g, '\'')}\`?`
}

/** The tool input, capped at 4 KB, for the alert's context and the event log. */
export function cappedInput(rawInput: unknown): string {
  const text = rawInput === undefined ? '' : JSON.stringify(rawInput, null, 2) ?? ''
  return text.length > 4096 ? `${text.slice(0, 4096)}\n… (cut at 4 KB)` : text
}

// ── the child's environment (§3.2, §8) ──────────────────────────────────────

const KEPT_COPILOT = new Set(['COPILOT_HOME', 'COPILOT_GITHUB_TOKEN'])

/**
 * The terminal's environment through the denylist: no ELECTRON_*, no
 * AGENT_INBOX_*, no NODE_OPTIONS, no COPILOT_* but COPILOT_HOME and
 * COPILOT_GITHUB_TOKEN (so not COPILOT_ALLOW_ALL, nor a parent Copilot session's
 * ids). Then AGENT_INBOX_HOOKS=0, COPILOT_AUTO_UPDATE=false, and the driver's own
 * hub when it is not the default, because the session's agent-inbox server
 * inherits this environment and must write where the driver reads.
 */
export function childEnv(env: NodeJS.ProcessEnv, hub: { path: string; isDefault: boolean }): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (key.startsWith('ELECTRON_') || key.startsWith('AGENT_INBOX_') || key === 'NODE_OPTIONS') continue
    if (key.startsWith('COPILOT_') && !KEPT_COPILOT.has(key)) continue
    out[key] = value
  }
  out.AGENT_INBOX_HOOKS = '0'
  out.COPILOT_AUTO_UPDATE = 'false'
  if (!hub.isDefault) out.AGENT_INBOX_DB = hub.path
  return out
}

// ── the agent-inbox registration (§3.2) ─────────────────────────────────────

/**
 * The name Copilot loads the user's Agent Inbox server under: the
 * `mcpServers['agent-inbox']` entry the installer manages in
 * `$COPILOT_HOME/mcp-config.json` (default ~/.copilot). Null when there is
 * none, and the driver refuses to start. The file's text is never quoted: it can
 * hold other servers' tokens (#337).
 */
export function copilotAgentInboxServer(env: NodeJS.ProcessEnv): { name: string } | { error: string } {
  const home = env.COPILOT_HOME && env.COPILOT_HOME.startsWith('/') ? env.COPILOT_HOME : join(homedir(), '.copilot')
  const file = join(home, 'mcp-config.json')
  if (!existsSync(file)) return { error: `${file} does not exist: register Agent Inbox with Copilot first (npm run install:agents)` }
  let config: unknown
  try {
    if (!statSync(file).isFile()) return { error: `${file} is not a regular file` }
    config = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return { error: code ? `${file} is unreadable (${code})` : `${file} is not valid JSON` }
  }
  const servers = (config as { mcpServers?: unknown } | null)?.mcpServers
  const entry = servers && typeof servers === 'object' ? (servers as Record<string, unknown>)['agent-inbox'] : undefined
  if (!entry || typeof entry !== 'object') return { error: `${file} registers no agent-inbox server: run npm run install:agents first` }
  return { name: 'agent-inbox' }
}
