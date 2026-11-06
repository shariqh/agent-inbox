// One unslop task as a function (#483, unslop design §6-§8): kind, input limits
// and the screen before any network; then the prompt, one backend call, the
// answer's classification and the fidelity check; one retry only when the time
// left covers its output limit at the observed speed. The result carries §6.3's
// fields and an exit class from §7.3. The log callback receives sizes, timings,
// classes and check results only: never text, never a matched value.
// U2b wraps this in the A2A server (queue, auth, mesh.json gate); U3 the CLI.
import { randomBytes } from 'node:crypto'
import { DEFAULT_MODEL, DEFAULT_SAMPLING, checkApiKey, checkBaseUrl, classify, maxTokens, post as httpPost, requestBody } from './backend.js'
import type { BackendProfile, Post, Sampling, TransportReason } from './backend.js'
import { checkFidelity } from './fidelity.js'
import type { Failure, FidelityReport } from './fidelity.js'
import { buildMessages, cleanAnswer } from './prompt.js'
import type { Retry } from './prompt.js'
import type { Rules } from './rules.js'
import { parseKind, screen } from './screen.js'
import type { Kind, ScreenClass, ScreenOptions } from './screen.js'

export type Outcome = 0 | 10 | 11 | 12 | 13
export type Status = 'rewritten' | 'unchanged' | 'kept-original' | 'rejected' | 'busy' | 'failed'
export type Ms = { queued: number; load: number; model: number; check: number }
export type UnslopResult = {
  code: Outcome
  status: Status
  /** codes 0 and 10 only: the edited text, or the original */
  text?: string
  /** a class name, never a value */
  reason?: string
  screen?: ScreenClass[]
  failures?: Failure[]
  rulesSha256: string
  model: string
  attempts: number
  hard: Partial<FidelityReport['hard']>
  warnings: FidelityReport['warnings']
  ms: Ms
}
export type UnslopLog = {
  taskId: string; kind?: Kind; bytesIn: number; bytesOut?: number; code: Outcome; status: Status; reason?: string
  screen?: ScreenClass[]; model: string; rulesSha256: string; attempts: number; hard: Partial<FidelityReport['hard']>
  warnings: string[]; failures: Array<Pick<Failure, 'class' | 'kind'>>; ms: Ms
}
export type UnslopProfile = {
  baseUrl: string; apiKey?: string; model?: string; sampling?: Partial<Sampling>; terms?: string[]; screen?: ScreenOptions
}
export type UnslopTask = { text: string; kind: unknown; taskId?: string; queuedMs?: number; budgetMs?: number; signal?: AbortSignal }
export type UnslopEnv = {
  profile: UnslopProfile
  rules: Rules
  post?: Post
  now?: () => number
  random?: (bytes: number) => Buffer
  log?: (event: UnslopLog) => void
  onState?: (state: 'editing' | 'checking' | 'retrying') => void
}

export const INPUT_MAX = 12 * 1024
export const TASK_MS = 270_000
const DEFAULT_TOKENS_PER_S = 44
// a gap this long between the request and the box's own prompt+predict time is a model load
const LOAD_GAP_MS = 1000
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/
const TRANSPORT: Record<TransportReason, string> = { unreachable: 'unreachable', deadline: 'deadline', aborted: 'cancelled', 'too-large': 'backend-too-large', invalid: 'backend-request' }

export async function runUnslop(task: UnslopTask, env: UnslopEnv): Promise<UnslopResult> {
  const now = env.now ?? (() => performance.now())
  const random = env.random ?? randomBytes
  const start = now()
  const deadline = start + (task.budgetMs ?? TASK_MS)
  const profile: BackendProfile = {
    baseUrl: env.profile.baseUrl, apiKey: env.profile.apiKey, model: env.profile.model ?? DEFAULT_MODEL,
    sampling: { ...DEFAULT_SAMPLING, ...env.profile.sampling },
  }
  const input = task.text
  const kind = parseKind(task.kind)
  const ms: Ms = { queued: task.queuedMs ?? 0, load: 0, model: 0, check: 0 }
  let attempts = 0
  let report: FidelityReport | undefined

  const end = (code: Outcome, status: Status, extra: Partial<UnslopResult> = {}): UnslopResult => {
    const result: UnslopResult = {
      code, status, rulesSha256: env.rules.sha256, model: profile.model, attempts,
      hard: report?.hard ?? {}, warnings: report?.warnings ?? [], ms, ...extra,
    }
    env.log?.({
      taskId: task.taskId ?? random(8).toString('hex'), kind, bytesIn: Buffer.byteLength(input),
      bytesOut: result.text === undefined ? undefined : Buffer.byteLength(result.text), code, status, reason: result.reason,
      screen: result.screen, model: result.model, rulesSha256: result.rulesSha256, attempts, hard: result.hard,
      warnings: result.warnings.map((w) => w.class), failures: (result.failures ?? []).map((f) => ({ class: f.class, kind: f.kind })), ms,
    })
    return result
  }
  const kept = (reason: string, failures?: Failure[]): UnslopResult => end(10, 'kept-original', { text: input, reason, ...(failures ? { failures } : {}) })

  let url: URL
  try {
    url = checkBaseUrl(profile.baseUrl)
  } catch {
    return end(13, 'failed', { reason: 'backend-url' })
  }
  let apiKey: string | undefined
  try {
    apiKey = checkApiKey(profile.apiKey)
  } catch {
    return end(13, 'failed', { reason: 'backend-key' })
  }
  if (!kind) return end(11, 'rejected', { reason: 'kind' })
  if (!input.trim()) return end(11, 'rejected', { reason: 'empty' })
  if (Buffer.byteLength(input) > INPUT_MAX) return end(11, 'rejected', { reason: 'size' })
  // a lone surrogate does not survive UTF-8
  if (CONTROL.test(input) || Buffer.from(input).toString() !== input) return end(11, 'rejected', { reason: 'control-bytes' })
  const screened = screen(input, env.profile.screen)
  if (!screened.ok) return end(11, 'rejected', { reason: 'screen', screen: screened.classes })

  const nonce = random(16).toString('hex')
  const limit = maxTokens(input)
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  let retry: Retry | undefined
  let tokensPerS = DEFAULT_TOKENS_PER_S

  for (;;) {
    attempts++
    env.onState?.(retry ? 'retrying' : 'editing')
    const left = deadline - now()
    if (left <= 0) return end(13, 'failed', { reason: 'deadline' })
    const sent = now()
    let http
    try {
      http = await (env.post ?? httpPost)(url, requestBody(profile, buildMessages(env.rules.text, input, nonce, retry), limit), headers, { timeoutMs: left, signal: task.signal })
    } catch (error) {
      const reason = (error as { reason?: TransportReason }).reason
      return end(13, 'failed', { reason: reason ? TRANSPORT[reason] : 'unreachable' })
    }
    const wall = now() - sent
    const reply = classify(http)
    if (!reply.ok) {
      ms.model += wall
      if (reply.outcome === 'busy') return end(12, 'busy', { reason: reply.reason })
      return reply.outcome === 'failed' ? end(13, 'failed', { reason: reply.reason }) : kept(reply.reason)
    }
    const gap = reply.timings ? wall - reply.timings.promptMs - reply.timings.predictedMs : 0
    const load = gap > LOAD_GAP_MS ? gap : 0
    ms.load += load
    ms.model += wall - load
    if (reply.timings) tokensPerS = reply.timings.predictedN / (reply.timings.predictedMs / 1000)
    else if (reply.completionTokens && wall - load > 0) tokensPerS = reply.completionTokens / ((wall - load) / 1000)

    const answer = cleanAnswer(input, reply.content, nonce)
    if (!answer.ok) return kept(answer.reason)
    if (answer.text.trim() === input.trim()) return end(0, 'unchanged', { text: input })
    env.onState?.('checking')
    const checked = now()
    report = checkFidelity(input, answer.text, { terms: env.profile.terms })
    ms.check += now() - checked
    if (report.tooComplex) return kept('too-complex')
    if (report.ok) return end(0, 'rewritten', { text: answer.text })
    const needMs = (limit / tokensPerS) * 1000
    if (retry || deadline - now() < needMs) return kept(retry ? 'fidelity' : 'fidelity-no-time', report.failures)
    retry = {
      keep: report.failures.flatMap((f) => [...f.lost, ...(f.moved ?? [])]),
      added: report.failures.flatMap((f) => f.added),
    }
  }
}
