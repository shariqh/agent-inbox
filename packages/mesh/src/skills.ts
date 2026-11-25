// The two skills the A2A server (src/a2a.ts) can serve, one per agent process:
// unslop (one public text, edited by the rules) and unslop-code (changed files, the
// comments a coding agent added removed by a patch). Each is the card's identity, the
// extension, the proof label, how a message becomes a task, and how a result becomes
// an artifact. Log fields are sizes, counts and classes: never text or a path.
import type { Accepted, Skill } from './a2a.js'
import { maxTokens } from './backend.js'
import { parseKind } from './screen.js'
import type { UnslopResult, UnslopTask } from './unslop.js'
import type { CodeFile, CodeSlopResult, CodeSlopTask } from './unslop-code.js'

type Json = Record<string, unknown>

export const EXTENSION = 'urn:agent-inbox:ext:unslop:v1'
const TOKENS_PER_S = 44

export type RunResult = UnslopResult & { skillStale?: boolean }
export type UnslopInput = { text: string; kind: unknown }

export function unslopSkill(o: {
  rules: () => { rulesSha256: string; bytes: number; loadedAt: string }
  run: (task: UnslopTask, onState: (state: string) => void) => Promise<RunResult>
}): Skill<UnslopInput, RunResult> {
  return {
    name: 'unslop',
    description: 'Copy-edits public text (PR descriptions, issues, release notes, public docs, blog posts) by the unslop rules, with a fidelity check.',
    entry: { description: 'Edit one public text; the result carries the check report.', tags: ['editing'] },
    modes: { input: ['text/plain'], output: ['text/plain', 'application/json'] },
    extension: { uri: EXTENSION, description: 'unslop task parameters and result', params: () => ({ api: 1, skillId: 'unslop', ...o.rules() }) },
    proofLabel: 'unslop/v1',
    bodyMax: 64 * 1024,
    malformed: 'Expected one text part from ROLE_USER',
    accept: (part, meta) => {
      const text = part.text
      if (typeof text !== 'string') return undefined
      return { input: { text, kind: meta.kind }, estimateMs: (maxTokens(text) / TOKENS_PER_S) * 1000, log: { kind: parseKind(meta.kind), bytesIn: Buffer.byteLength(text) } }
    },
    run: (input, c, onState) => o.run({ text: input.text, kind: input.kind, taskId: c.taskId, queuedMs: c.queuedMs, budgetMs: c.budgetMs, signal: c.signal }, onState),
    outcome: (result) => {
      const { text, ...data } = result
      return result.code === 0 || result.code === 10 ? { content: { text, mediaType: 'text/plain' }, data } : { data }
    },
  }
}

export const CODE_EXTENSION = 'urn:agent-inbox:ext:unslop-code:v1'
/** the queue's estimate per file: three questions at the box's usual speed */
export const CODE_FILE_MS = 12_000
/**
 * The cap on that estimate (Claude Code D5): the 270 s the task limit was, so every task an idle
 * queue admits at the default 280 s timeout still fits, while the run's own budget may be longer.
 */
export const ESTIMATE_MAX_MS = 270_000
export type CodeInput = { files: CodeFile[]; suggest?: boolean }

const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

/** The data part's fields, type-checked; only the known ones are copied, so the task function sees nothing else. */
function codeInput(data: Json): CodeInput | undefined {
  if (!Array.isArray(data.files) || (data.suggest !== undefined && typeof data.suggest !== 'boolean')) return undefined
  const files: CodeFile[] = []
  for (const f of data.files as unknown[]) {
    if (!isObject(f) || typeof f.path !== 'string' || typeof f.text !== 'string' || !Array.isArray(f.added)) return undefined
    const added = f.added as unknown[]
    if (!added.every((n) => Number.isSafeInteger(n))) return undefined
    files.push({ path: f.path, text: f.text, added: added as number[] })
  }
  return { files, ...(data.suggest === undefined ? {} : { suggest: data.suggest as boolean }) }
}

export function codeSkill(o: {
  run: (task: CodeSlopTask, onState: (state: string) => void) => Promise<CodeSlopResult>
}): Skill<CodeInput, CodeSlopResult> {
  return {
    name: 'unslop-code',
    description: 'Removes the comments an AI coding agent added that a maintainer would not write, from changed JavaScript and TypeScript files; returns a patch.',
    entry: { description: 'Clean the comments a change added; the result carries a patch and a report per file.', tags: ['code'] },
    modes: { input: ['application/json'], output: ['text/x-diff', 'application/json'] },
    extension: { uri: CODE_EXTENSION, description: 'unslop-code task parameters and result', params: () => ({ api: 1, skillId: 'unslop-code' }) },
    proofLabel: 'unslop-code/v1',
    bodyMax: 4 * 1024 * 1024,
    malformed: 'Expected one data part from ROLE_USER',
    accept: (part, _meta): Accepted<CodeInput> | { refuse: string; log: Json } | undefined => {
      if (part.text !== undefined || !('data' in part)) return undefined
      const input = isObject(part.data) ? codeInput(part.data) : undefined
      if (!input) return { refuse: 'malformed', log: {} }
      const bytesIn = input.files.reduce((sum, f) => sum + Buffer.byteLength(f.text), 0)
      return { input, estimateMs: Math.min(input.files.length * CODE_FILE_MS, ESTIMATE_MAX_MS), log: { files: input.files.length, bytesIn } }
    },
    run: (input, c, onState) => o.run({ ...input, taskId: c.taskId, queuedMs: c.queuedMs, budgetMs: c.budgetMs, signal: c.signal }, onState),
    outcome: (result) => {
      const { patch, ...data } = result
      return result.code === 0 ? { content: { text: patch, mediaType: 'text/x-diff' }, data } : { data }
    },
  }
}
