// The provider and fetcher interfaces (web search design §5.3) and the one transport
// both adapters use: node:http(s) to one fixed host, a fresh socket, no redirects
// (a 3xx is a bad response, never followed) and no proxy environment. A failure is a
// fixed reason: never a URL (a `?q=` holds the query), a response body or a key.
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

export type Recency = 'any' | 'day' | 'week' | 'month' | 'year'
export type ProviderReason = 'http-429' | 'http-5xx' | 'unreachable' | 'timeout' | 'bad-response' | 'auth'
export type ProviderSource = { url: string; title: string; snippet: string; page?: string; engines?: string[]; publishedAt?: string; fetchedAt?: string }
export type ProviderQuery = { text: string; recency: Recency; max: number; sites: string[]; excludeSites: string[] }
export type ProviderResult =
  | { ok: true; sources: ProviderSource[] }
  | { ok: false; outcome: 'busy' | 'failed'; retryAfterMs?: number; reason: ProviderReason }
export interface SearchProvider { readonly id: string; search(q: ProviderQuery, signal: AbortSignal): Promise<ProviderResult> }
export interface PageFetcher { fetch(url: string, signal: AbortSignal): Promise<{ ok: true; text: string } | { ok: false; reason: ProviderReason }> }

export type HttpRequest = { method: 'GET' | 'POST'; url: URL; headers: Record<string, string>; body?: string; timeoutMs: number; signal: AbortSignal }
export type HttpReply = { status: number; retryAfter?: string; body: string }
/** Resolves with any status; rejects only with `{ reason: 'unreachable' | 'timeout' }`. Adapters never read a rejection's message. */
export type Send = (r: HttpRequest) => Promise<HttpReply>

const RESPONSE_MAX = 2 * 1024 * 1024
const RETRY_DEFAULT_MS = 60_000
const RETRY_MAX_MS = 60 * 60_000

const fail = (reason: 'unreachable' | 'timeout'): { reason: string } => ({ reason })

export const send: Send = (r) => new Promise((resolve, reject) => {
  let req: ReturnType<typeof httpRequest>
  try {
    const body = r.body === undefined ? {} : { 'content-length': String(Buffer.byteLength(r.body)) }
    req = (r.url.protocol === 'https:' ? httpsRequest : httpRequest)(r.url, { method: r.method, agent: false, headers: { ...r.headers, ...body } })
  } catch {
    return reject(fail('unreachable'))
  }
  let settled = false
  const finish = (error?: object, reply?: HttpReply): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    r.signal.removeEventListener('abort', onAbort)
    if (error) {
      req.destroy()
      reject(error)
    } else resolve(reply!)
  }
  const onAbort = (): void => finish(fail('timeout'))
  const timer = setTimeout(onAbort, Math.max(0, r.timeoutMs))
  req.on('error', () => finish(fail('unreachable')))
  req.on('response', (res) => {
    const chunks: Buffer[] = []
    let size = 0
    res.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size <= RESPONSE_MAX) return void chunks.push(chunk)
      finish(undefined, { status: 0, body: '' })
      req.destroy()
    })
    res.on('end', () => finish(undefined, { status: res.statusCode ?? 0, retryAfter: res.headers['retry-after'], body: Buffer.concat(chunks).toString('utf8') }))
    res.on('error', () => finish(fail('unreachable')))
  })
  if (r.signal.aborted) return onAbort()
  r.signal.addEventListener('abort', onAbort, { once: true })
  req.end(r.body)
})

/** A non-2xx reply as a provider failure; undefined for a 2xx. A 429 is busy with its Retry-After. */
export function failure(reply: HttpReply, now = Date.now()): Extract<ProviderResult, { ok: false }> | undefined {
  if (reply.status >= 200 && reply.status < 300) return undefined
  if (reply.status === 429) return { ok: false, outcome: 'busy', reason: 'http-429', retryAfterMs: retryAfterMs(reply.retryAfter, now) }
  if (reply.status === 401 || reply.status === 403) return { ok: false, outcome: 'failed', reason: 'auth' }
  return { ok: false, outcome: 'failed', reason: reply.status >= 500 ? 'http-5xx' : 'bad-response' }
}

function retryAfterMs(value: string | undefined, now: number): number {
  const ms = value === undefined ? NaN : /^\d+$/.test(value.trim()) ? Number(value.trim()) * 1000 : Date.parse(value) - now
  return Math.min(RETRY_MAX_MS, Math.max(1000, Number.isFinite(ms) ? ms : RETRY_DEFAULT_MS))
}

/** A rejected send as a reason, from its fixed `reason` field only. */
export const reasonOf = (error: unknown): ProviderReason => ((error as { reason?: unknown } | undefined)?.reason === 'timeout' ? 'timeout' : 'unreachable')

export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
export const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')

/** `sites` as `site:` terms, since neither provider takes a site parameter. */
export const withSites = (text: string, sites: string[]): string =>
  sites.length === 0 ? text : `${text} ${sites.length === 1 ? `site:${sites[0]}` : `(${sites.map((s) => `site:${s}`).join(' OR ')})`}`
