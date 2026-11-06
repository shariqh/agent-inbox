// The model backend (#483, unslop design §7.1, §8.2): one OpenAI-compatible POST
// to `${baseUrl}/v1/chat/completions`, and nothing else. The base URL is
// https://, or http:// on a loopback address literal; redirects are not
// followed, no request carries `tools`, and thinking is off the way the box's
// own CLI turns it off (`chat_template_kwargs.enable_thinking: false`). The API
// key goes only into the Authorization header and never into an error or a log.
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

export type Sampling = { temperature: number; top_p: number; presence_penalty: number }
export type BackendProfile = { baseUrl: string; apiKey?: string; model: string; sampling: Sampling }
export type Message = { role: 'system' | 'user'; content: string }
export type HttpReply = { status: number; body: string }
export type TransportReason = 'unreachable' | 'deadline' | 'aborted' | 'too-large' | 'invalid'
export type Post = (url: URL, body: string, headers: Record<string, string>, options: { timeoutMs: number; signal?: AbortSignal }) => Promise<HttpReply>
export type Reply =
  | { ok: true; content: string; completionTokens?: number; timings?: { promptMs: number; predictedMs: number; predictedN: number } }
  | { ok: false; outcome: 'busy' | 'failed' | 'kept'; reason: string }

export const DEFAULT_MODEL = 'chat-long'
export const DEFAULT_SAMPLING: Sampling = { temperature: 0.2, top_p: 0.9, presence_penalty: 0 }
const CONNECT_MS = 10_000
const RESPONSE_MAX = 1024 * 1024

export function checkBaseUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('the backend base URL is not a URL')
  }
  const loopback = /^127(?:\.\d{1,3}){3}$/.test(url.hostname) || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('the backend base URL must be https://, or http:// on a loopback address')
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('the backend base URL must not carry credentials, a query or a fragment')
  // `//` or `\` in the path would make a relative reference that names another host
  if (/\/\/|\\/.test(url.pathname) || raw.includes('\\')) throw new Error('the backend base URL path must not contain // or a backslash')
  const out = new URL(url.href)
  out.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/chat/completions`
  if (out.origin !== url.origin) throw new Error('the backend base URL changed origin')
  return out
}

/** The trimmed API key, or an error that never repeats it: a header value must be printable Latin-1. */
export function checkApiKey(raw: string | undefined): string | undefined {
  const key = raw?.trim()
  if (key && /[^\x20-\x7E\xA0-\xFF]/.test(key)) throw new Error('the backend API key holds a line break, a control character or a character outside Latin-1')
  return key || undefined
}

/** About three bytes of UTF-8 per token: deliberately high, as the box's CLI measures it. */
export const estimateTokens = (text: string): number => Math.ceil(Buffer.byteLength(text) / 3)
export const maxTokens = (text: string): number => Math.min(Math.ceil(1.3 * estimateTokens(text)) + 256, 6144)

export function requestBody(profile: BackendProfile, messages: Message[], limit: number): string {
  const { temperature, top_p, presence_penalty } = profile.sampling
  return JSON.stringify({
    model: profile.model, messages, max_tokens: limit, temperature, top_p, presence_penalty,
    stream: false, chat_template_kwargs: { enable_thinking: false },
  })
}

export const transportError = (reason: TransportReason): Error & { reason: TransportReason } => Object.assign(new Error(reason), { reason })

// node:http, not fetch: a 10 s connect limit of its own, no redirects, no proxy
// environment, and a fresh socket per request.
// The request is built before any timer is armed: a header Node refuses throws
// here, and must leave nothing behind that fires later.
export const post: Post = (url, body, headers, { timeoutMs, signal }) => new Promise((resolve, reject) => {
  let req: ReturnType<typeof httpRequest>
  try {
    req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'POST', agent: false, headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
    })
  } catch {
    return reject(transportError('invalid'))
  }
  let settled = false
  let connect: NodeJS.Timeout | undefined
  const finish = (error?: Error, reply?: HttpReply): void => {
    if (settled) return
    settled = true
    clearTimeout(deadline)
    clearTimeout(connect)
    signal?.removeEventListener('abort', onAbort)
    if (error) {
      req.destroy()
      reject(error)
    } else resolve(reply!)
  }
  const onAbort = (): void => finish(transportError('aborted'))
  const deadline = setTimeout(() => finish(transportError('deadline')), Math.max(0, timeoutMs))
  req.on('socket', (socket) => {
    if (!socket.connecting) return
    connect = setTimeout(() => finish(transportError('unreachable')), CONNECT_MS)
    socket.once('connect', () => clearTimeout(connect))
  })
  req.on('error', () => finish(transportError('unreachable')))
  req.on('response', (res) => {
    const chunks: Buffer[] = []
    let size = 0
    res.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > RESPONSE_MAX) finish(transportError('too-large'))
      else chunks.push(chunk)
    })
    res.on('end', () => finish(undefined, { status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    res.on('error', () => finish(transportError('unreachable')))
  })
  if (signal?.aborted) return onAbort()
  signal?.addEventListener('abort', onAbort, { once: true })
  req.end(body)
})

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

// §7.1: any 5xx is busy (a model load that failed while image work holds the
// GPU); a truncated, empty or reasoning-only answer, or any tool call, keeps
// the original without a retry.
export function classify(http: HttpReply): Reply {
  if (http.status >= 500) return { ok: false, outcome: 'busy', reason: 'backend-5xx' }
  if (http.status < 200 || http.status >= 300) return { ok: false, outcome: 'failed', reason: `backend-http-${http.status}` }
  let json: unknown
  try {
    json = JSON.parse(http.body)
  } catch {
    return { ok: false, outcome: 'failed', reason: 'backend-bad-response' }
  }
  const choice = obj(Array.isArray(obj(json).choices) ? (obj(json).choices as unknown[])[0] : undefined)
  const message = obj(choice.message)
  if (!Object.keys(message).length) return { ok: false, outcome: 'failed', reason: 'backend-bad-response' }
  const tools = Array.isArray(message.tool_calls) && message.tool_calls.length > 0
  if (tools || message.function_call || choice.finish_reason === 'tool_calls') return { ok: false, outcome: 'kept', reason: 'tool-call' }
  if (choice.finish_reason === 'length') return { ok: false, outcome: 'kept', reason: 'truncated' }
  const content = typeof message.content === 'string' ? message.content : ''
  if (!content.trim()) return { ok: false, outcome: 'kept', reason: message.reasoning_content ? 'reasoning-only' : 'empty' }
  const t = obj(obj(json).timings)
  const [promptMs, predictedMs, predictedN] = [num(t.prompt_ms), num(t.predicted_ms), num(t.predicted_n)]
  return {
    ok: true, content, completionTokens: num(obj(obj(json).usage).completion_tokens),
    ...(predictedMs && predictedN ? { timings: { promptMs: promptMs ?? 0, predictedMs, predictedN } } : {}),
  }
}
