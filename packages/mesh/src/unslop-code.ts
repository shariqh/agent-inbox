// One unslop-code task as a function (step 2 of 4), shaped like runUnslop: input
// limits and the secret screen before any network; then, per file and one after
// another, up to three questions (remove, keep, suggest, src/code-prompt.ts) whose
// answers are line numbers only; code decides what goes (decide), edits
// (removeLines), checks the program is unchanged (sameProgram) and writes the patch
// (patchFor), all in src/code-slop.ts. Every doubt keeps the file as it is. The log
// callback receives sizes, timings, counts and class names only: never a path, a
// line of code or an answer.
import { randomBytes } from 'node:crypto'
import { DEFAULT_SAMPLING, checkApiKey, checkBaseUrl, classify, post as httpPost, requestBody } from './backend.js'
import type { BackendProfile, Post, Sampling, TransportReason } from './backend.js'
import { lineTexts, questionMessages, windows } from './code-prompt.js'
import type { Question } from './code-prompt.js'
import { commentLines, decide, parsePoints, parseSuggestions, patchFor, removeLines, sameProgram, suggestionsFor } from './code-slop.js'
import type { Decision, DropReason, Suggestion } from './code-slop.js'
import { screen } from './screen.js'
import { TASK_MS } from './unslop.js'

export type CodeOutcome = 0 | 11 | 12 | 13
export type CodeStatus = 'cleaned' | 'unchanged' | 'rejected' | 'busy' | 'failed'
export type FileStatus = 'cleaned' | 'unchanged' | 'skipped' | 'not-reached'
export type CodeFile = { path: string; text: string; added: number[] }
export type FileResult = {
  path: string; status: FileStatus
  /** a class name: skipped (path, language, size, control-bytes, no-added, screen), unchanged (answer, program) */
  reason?: string
  removed: number[]; dropped: Decision['dropped']; suggestions: Suggestion[]
}
export type CodeSlopResult = {
  code: CodeOutcome; status: CodeStatus; reason?: string; patch: string; files: FileResult[]
  model: string; calls: number; ms: { queued: number; load: number; model: number }
}
export type CodeSlopLog = {
  taskId: string; code: CodeOutcome; status: CodeStatus; reason?: string; model: string; calls: number
  files: Array<{ bytes: number; added: number; status: FileStatus; reason?: string; removed: number; dropped: Partial<Record<DropReason, number>>; suggestions: number }>
  ms: CodeSlopResult['ms']
}
export type CodeSlopTask = { files: CodeFile[]; suggest?: boolean; taskId?: string; queuedMs?: number; budgetMs?: number; signal?: AbortSignal }
export type CodeSlopEnv = {
  profile: { baseUrl: string; apiKey?: string; model?: string; sampling?: Partial<Sampling> }
  post?: Post
  now?: () => number
  random?: (bytes: number) => Buffer
  log?: (event: CodeSlopLog) => void
  onState?: (question: Question) => void
  /** a test seam only: the program check after the edit */
  sameProgram?: typeof sameProgram
}

export const CODE_MODEL = 'coder-next'
export const CODE_SAMPLING: Sampling = { ...DEFAULT_SAMPLING, temperature: 0 }
export const MAX_FILES = 40
export const FILE_MAX = 256 * 1024
/** every answer is a short JSON list of line numbers */
export const ANSWER_TOKENS = 512
const DEFAULT_TOKENS_PER_S = 44
const LOAD_GAP_MS = 1000
const EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx'])
const TYPESCRIPT = new Set(['.ts', '.mts', '.cts'])
// tab, line feed and carriage return are text; a lone carriage return makes the guards unsure
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/
const TRANSPORT: Record<TransportReason, string> = { unreachable: 'unreachable', deadline: 'deadline', aborted: 'cancelled', 'too-large': 'backend-too-large', invalid: 'backend-request' }

const extension = (path: string): string => /\.[^./]+$/.exec(path)?.[0].toLowerCase() ?? ''
/** Whether patchFor takes the path: asked of patchFor itself, so the two never disagree. */
const patchable = (path: string): boolean => {
  try { return patchFor(path, 'x\n', '') !== '' } catch { return false }
}

type Prepared = { file: CodeFile; added: number[]; jsx: boolean; shown: string; ask: boolean }
type Stop = { code: 12 | 13; status: 'busy' | 'failed'; reason: string }

export async function runCodeSlop(task: CodeSlopTask, env: CodeSlopEnv): Promise<CodeSlopResult> {
  const now = env.now ?? (() => performance.now())
  const random = env.random ?? randomBytes
  const deadline = now() + (task.budgetMs ?? TASK_MS)
  const profile: BackendProfile = {
    baseUrl: env.profile.baseUrl, apiKey: env.profile.apiKey, model: env.profile.model ?? CODE_MODEL,
    sampling: { ...CODE_SAMPLING, ...env.profile.sampling },
  }
  const check = env.sameProgram ?? sameProgram
  const ms = { queued: task.queuedMs ?? 0, load: 0, model: 0 }
  const results: FileResult[] = []
  let calls = 0

  const end = (code: CodeOutcome, status: CodeStatus, reason?: string): CodeSlopResult => {
    const files = task.files.slice(0, results.length)
    const result: CodeSlopResult = {
      code, status, ...(reason ? { reason } : {}),
      patch: results.map((r, i) => (r.status === 'cleaned' ? patchFor(r.path, files[i]!.text, removeLines(files[i]!.text, r.removed)) : '')).join(''),
      files: results, model: profile.model, calls, ms,
    }
    env.log?.({
      taskId: task.taskId ?? random(8).toString('hex'), code, status, reason, model: profile.model, calls, ms,
      files: results.map((r, i) => {
        const dropped: Partial<Record<DropReason, number>> = {}
        for (const d of r.dropped) dropped[d.why] = (dropped[d.why] ?? 0) + 1
        return {
          bytes: Buffer.byteLength(files[i]!.text), added: files[i]!.added.length, status: r.status, reason: r.reason,
          removed: r.removed.length, dropped, suggestions: r.suggestions.length,
        }
      }),
    })
    return result
  }
  const status = (): CodeStatus => (results.some((r) => r.status === 'cleaned') ? 'cleaned' : 'unchanged')
  const fileResult = (path: string, status: FileStatus, reason?: string, more: Partial<FileResult> = {}): FileResult =>
    ({ path, status, ...(reason ? { reason } : {}), removed: [], dropped: [], suggestions: [], ...more })

  let url: URL
  let apiKey: string | undefined
  try {
    url = checkBaseUrl(profile.baseUrl)
  } catch {
    return end(13, 'failed', 'backend-url')
  }
  try {
    apiKey = checkApiKey(profile.apiKey)
  } catch {
    return end(13, 'failed', 'backend-key')
  }
  if (!task.files.length) return end(11, 'rejected', 'no-files')
  if (task.files.length > MAX_FILES) return end(11, 'rejected', 'too-many-files')

  // every limit and the screen, before any network
  const prepared: Array<Prepared | FileResult> = task.files.map((file) => {
    const ext = extension(file.path)
    const skip = (reason: string): FileResult => fileResult(file.path, 'skipped', reason)
    if (!patchable(file.path)) return skip('path')
    if (!EXTENSIONS.has(ext)) return skip('language')
    if (Buffer.byteLength(file.text) > FILE_MAX) return skip('size')
    // a lone surrogate does not survive UTF-8
    if (CONTROL.test(file.text) || Buffer.from(file.text).toString() !== file.text) return skip('control-bytes')
    const count = lineTexts(file.text).length
    const added = [...new Set(file.added)].filter((n) => Number.isSafeInteger(n) && n >= 1 && n <= count).sort((a, b) => a - b)
    if (!added.length) return skip('no-added')
    const shown = windows(file.text, added)
    if (!screen(shown, {}, ['secret']).ok) return skip('screen')
    const jsx = !TYPESCRIPT.has(ext)
    const lines = commentLines(file.text, { jsx })
    // nothing could be removed from a file the guards cannot read, or with no added whole-line comment
    const ask = !lines.unsure && added.some((n) => lines.whole.has(n))
    return { file, added, jsx, shown, ask }
  })
  if (prepared.every((p) => 'status' in p)) {
    results.push(...(prepared as FileResult[]))
    return end(11, 'rejected', 'all-skipped')
  }

  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  let tokensPerS = DEFAULT_TOKENS_PER_S

  /** One question: the answer's text, null for an unusable answer, 'time' when the time left cannot cover it, or a Stop. */
  const askModel = async (question: Question, shown: string): Promise<string | null | 'time' | Stop> => {
    const left = deadline - now()
    if (left < (ANSWER_TOKENS / tokensPerS) * 1000) return 'time'
    env.onState?.(question)
    calls++
    const sent = now()
    let http
    try {
      http = await (env.post ?? httpPost)(url, requestBody(profile, questionMessages(question, shown), ANSWER_TOKENS), headers, { timeoutMs: left, signal: task.signal })
    } catch (error) {
      const reason = (error as { reason?: TransportReason }).reason
      return { code: 13, status: 'failed', reason: reason ? TRANSPORT[reason] : 'unreachable' }
    }
    const wall = now() - sent
    const reply = classify(http)
    if (!reply.ok) {
      ms.model += wall
      if (reply.outcome === 'busy') return { code: 12, status: 'busy', reason: reply.reason }
      return reply.outcome === 'failed' ? { code: 13, status: 'failed', reason: reply.reason } : null
    }
    const gap = reply.timings ? wall - reply.timings.promptMs - reply.timings.predictedMs : 0
    const load = gap > LOAD_GAP_MS ? gap : 0
    ms.load += load
    ms.model += wall - load
    if (reply.timings) tokensPerS = reply.timings.predictedN / (reply.timings.predictedMs / 1000)
    else if (reply.completionTokens && wall - load > 0) tokensPerS = reply.completionTokens / ((wall - load) / 1000)
    return reply.content
  }

  for (const p of prepared) {
    if ('status' in p) {
      results.push(p)
      continue
    }
    const { file, added, jsx, shown } = p
    const answers: Partial<Record<Question, string | null>> = {}
    const plan: Question[] = [...(p.ask ? ['remove' as const] : []), ...(task.suggest === false ? [] : ['suggest' as const])]
    let decision: Decision = { remove: [], dropped: [] }
    let reason: string | undefined
    for (let q = 0; q < plan.length; q++) {
      const question = plan[q]!
      const answer = await askModel(question, shown)
      if (answer === 'time' || (answer && typeof answer === 'object')) {
        // this file and every later one are not reached; files already decided keep their results
        for (const rest of prepared.slice(results.length)) results.push('status' in rest ? rest : fileResult(rest.file.path, 'not-reached'))
        if (answer !== 'time') return end(answer.code, answer.status, answer.reason)
        return results.some((r) => r.status === 'cleaned' || r.status === 'unchanged') ? end(0, status(), 'budget') : end(13, 'failed', 'deadline')
      }
      answers[question] = answer
      if (question === 'remove') {
        const remove = answer === null ? null : parsePoints(answer, 'remove')
        if (remove === null) {
          reason = 'answer'
          continue
        }
        decision = decide({ source: file.text, added, remove, keep: [], jsx })
        // the keep answer matters only when a listed line would otherwise go
        if (decision.remove.length) plan.splice(q + 1, 0, 'keep')
      } else if (question === 'keep') {
        const keep = answer === null ? null : parsePoints(answer, 'keep')
        // a missing second opinion never loosens a guard
        if (keep === null) {
          decision = { remove: [], dropped: decision.dropped }
          reason = 'answer'
        } else decision = decide({ source: file.text, added, remove: parsePoints(answers.remove!, 'remove'), keep, jsx })
      }
    }
    const suggestions = suggestionsFor(answers.suggest ? parseSuggestions(answers.suggest) : null, added)
    if (decision.remove.length && !check(file.text, removeLines(file.text, decision.remove), { jsx })) {
      decision = { remove: [], dropped: decision.dropped }
      reason = 'program'
    }
    results.push(fileResult(file.path, decision.remove.length ? 'cleaned' : 'unchanged', decision.remove.length ? undefined : reason,
      { removed: decision.remove, dropped: decision.dropped, suggestions }))
  }
  return end(0, status())
}
