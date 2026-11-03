// Issue #412 step 3 — the launch spec Electron main hands a detached driver on
// fd 3 (design §8): versioned, read once, validated strictly before anything
// starts. Main builds it from what the human confirmed in the native dialog;
// the renderer never sends a path, executable, argv or env. A `new` spec carries
// every launch fact plus the captured environment and the launch key; a
// `resume` spec carries only the id, environment and key, since the first
// driver wrote the facts into the launch row. Pure, apart from reading fd 3.
import { readSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { LAUNCH_KEY_BYTES } from './launch-sign.js'
import { isReasoningEffort } from './driver-policy.js'
import type { LaunchMode, ReasoningEffort } from './driver-policy.js'
import { worktreePlanError } from './worktree.js'
import type { WorktreePlan } from './worktree.js'

/** The spec version this driver understands. Main checks the runtime's version before it sends one. */
export const LAUNCH_SPEC_VERSION = 1

export const LAUNCH_BUDGETS = {
  activeMs: { min: 60_000, max: 8 * 60 * 60_000 },
  toolCalls: { min: 1, max: 2000 },
} as const

const MAX_SPEC_BYTES = 1024 * 1024
const MAX_PROMPT = 64 * 1024
const MAX_ENV_ENTRIES = 1000
const LAUNCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MODES: readonly LaunchMode[] = ['ask', 'read-only', 'plan', 'edits']

interface SpecCommon {
  v: 1
  launchId: string
  /** The login-shell environment main captured in the launch folder (§8). */
  env: Record<string, string>
  launchKey: Buffer
}

export interface NewLaunchSpec extends SpecCommon {
  kind: 'new'
  host: 'copilot'
  cwd: string
  mode: LaunchMode
  model?: string
  reasoningEffort?: ReasoningEffort
  budgets: { activeMs: number; toolCalls: number }
  prompt: string
  /** #432: run in a new worktree of `cwd` (the checkout), at the path and on the branch the confirmation showed. */
  worktree?: WorktreePlan
}

export interface ResumeLaunchSpec extends SpecCommon {
  kind: 'resume'
}

export type LaunchSpec = NewLaunchSpec | ResumeLaunchSpec

export type SpecResult = { ok: true; spec: LaunchSpec } | { ok: false; error: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): string | null {
  for (const key of required) if (!(key in value)) return `missing ${key}`
  for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) return `unknown field ${key}`
  return null
}

function budget(value: unknown, bounds: { min: number; max: number }): number | null {
  return Number.isInteger(value) && (value as number) >= bounds.min && (value as number) <= bounds.max ? value as number : null
}

/** Parses and validates a spec for the launch named on the command line. */
export function parseLaunchSpec(text: string, launchId: string): SpecResult {
  const fail = (error: string): SpecResult => ({ ok: false, error: `launch spec: ${error}` })
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return fail('not JSON')
  }
  if (!isRecord(raw)) return fail('not an object')
  if (raw.v !== LAUNCH_SPEC_VERSION) return fail(`version ${String(raw.v)} is not ${LAUNCH_SPEC_VERSION}`)
  if (raw.kind !== 'new' && raw.kind !== 'resume') return fail('kind must be new or resume')
  const shape = raw.kind === 'new'
    ? exactKeys(raw, ['v', 'kind', 'launchId', 'host', 'cwd', 'mode', 'budgets', 'prompt', 'env', 'launchKey'], ['model', 'reasoningEffort', 'worktree'])
    : exactKeys(raw, ['v', 'kind', 'launchId', 'env', 'launchKey'])
  if (shape) return fail(shape)
  if (typeof raw.launchId !== 'string' || !LAUNCH_ID.test(raw.launchId) || raw.launchId !== launchId) {
    return fail('launchId must be the lowercase UUID on the command line')
  }
  if (!isRecord(raw.env)) return fail('env must be an object')
  const entries = Object.entries(raw.env)
  if (entries.length > MAX_ENV_ENTRIES) return fail('env has too many entries')
  const env: Record<string, string> = {}
  for (const [name, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(name) || typeof value !== 'string' || value.includes('\0')) return fail('env must map variable names to strings')
    env[name] = value
  }
  if (typeof raw.launchKey !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(raw.launchKey)) return fail('launchKey must be 32 bytes of base64')
  const launchKey = Buffer.from(raw.launchKey, 'base64')
  if (launchKey.length !== LAUNCH_KEY_BYTES) return fail('launchKey must be 32 bytes of base64')
  const common = { v: 1 as const, launchId: raw.launchId, env, launchKey }
  if (raw.kind === 'resume') return { ok: true, spec: { ...common, kind: 'resume' } }

  if (raw.host !== 'copilot') return fail('host must be copilot')
  if (typeof raw.cwd !== 'string' || !isAbsolute(raw.cwd) || raw.cwd.length > 4096 || raw.cwd.includes('\0')) return fail('cwd must be an absolute path')
  if (!MODES.includes(raw.mode as LaunchMode)) return fail(`mode must be one of ${MODES.join(', ')}`)
  if (raw.model !== undefined && (typeof raw.model !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(raw.model))) return fail('model must be a model id')
  if (raw.reasoningEffort !== undefined && (typeof raw.reasoningEffort !== 'string' || !isReasoningEffort(raw.reasoningEffort))) {
    return fail('reasoningEffort is not a Copilot effort level')
  }
  if (!isRecord(raw.budgets) || exactKeys(raw.budgets, ['activeMs', 'toolCalls'])) return fail('budgets must hold activeMs and toolCalls')
  const activeMs = budget(raw.budgets.activeMs, LAUNCH_BUDGETS.activeMs)
  const toolCalls = budget(raw.budgets.toolCalls, LAUNCH_BUDGETS.toolCalls)
  if (activeMs === null || toolCalls === null) return fail('a budget is out of bounds')
  if (typeof raw.prompt !== 'string' || !raw.prompt.trim() || raw.prompt.length > MAX_PROMPT) return fail('prompt must hold 1 to 65536 characters')
  const worktreeError = raw.worktree === undefined ? null : worktreePlanError(raw.worktree, raw.launchId)
  if (worktreeError) return fail(worktreeError)
  return {
    ok: true,
    spec: {
      ...common,
      kind: 'new',
      host: 'copilot',
      cwd: raw.cwd,
      mode: raw.mode as LaunchMode,
      ...(raw.model === undefined ? {} : { model: raw.model as string }),
      ...(raw.reasoningEffort === undefined ? {} : { reasoningEffort: raw.reasoningEffort as ReasoningEffort }),
      budgets: { activeMs, toolCalls },
      prompt: raw.prompt,
      ...(raw.worktree === undefined ? {} : { worktree: { path: (raw.worktree as WorktreePlan).path, branch: (raw.worktree as WorktreePlan).branch } }),
    },
  }
}

/**
 * The spec's bytes from `fd` (main's pipe), read to its end, at most 1 MiB.
 * Blocking on purpose: nothing else runs until the spec is in.
 */
export function readSpec(fd: number): string | { error: string } {
  const chunks: Buffer[] = []
  let total = 0
  const buffer = Buffer.alloc(64 * 1024)
  for (;;) {
    let read: number
    try {
      read = readSync(fd, buffer, 0, buffer.length, null)
    } catch (error) {
      return { error: `cannot read the launch spec on fd ${fd} (${(error as NodeJS.ErrnoException).code ?? 'error'})` }
    }
    if (read === 0) break
    total += read
    if (total > MAX_SPEC_BYTES) return { error: 'the launch spec is larger than 1 MiB' }
    chunks.push(Buffer.from(buffer.subarray(0, read)))
  }
  return Buffer.concat(chunks).toString('utf8')
}
