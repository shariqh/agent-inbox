// The SearXNG adapter (web search design §2.2, §5.3): GET /search?q=…&format=json on
// the profile's endpoint, which must be a tailnet-only `https://<name>.<tailnet>.ts.net`
// name or, for an SSH tunnel, `http://127.0.0.1:<port>` (request-post's endpoint rule):
// never a public host or an IP literal. It reads results[].url, title, content, engines
// and publishedDate, and nothing else of SearXNG's answer.
import { ConfigError } from '../files.js'
import { failure, obj, reasonOf, send as defaultSend, str } from './provider.js'
import type { ProviderSource, SearchProvider, Send } from './provider.js'

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const TAILNET = new RegExp(`^(https://(?:${LABEL}\\.){2}ts\\.net)(?::([1-9]\\d{0,4}))?/?$`)
const LOOPBACK = /^(http:\/\/127\.0\.0\.1):([1-9]\d{0,4})\/?$/
const SEARCH_MS = 15_000

/** The endpoint as a URL, or a fixed refusal: no path, user, query, leading zero or written-out default port. */
export function searxngEndpoint(raw: unknown): URL {
  const text = typeof raw === 'string' ? raw : ''
  const tailnet = TAILNET.exec(text)
  const match = tailnet ?? LOOPBACK.exec(text)
  const port = match?.[2] === undefined ? undefined : Number(match[2])
  if (!match || (port !== undefined && (port > 65535 || port === (tailnet ? 443 : 80)))) {
    throw new ConfigError('searxng.endpoint must be https://<name>.<tailnet>.ts.net[:<port>] or, for an SSH tunnel, http://127.0.0.1:<port>')
  }
  return new URL(port === undefined ? match[1]! : `${match[1]!}:${port}`)
}

const day = (v: unknown): string | undefined => {
  const m = typeof v === 'string' ? /^(\d{4}-\d{2}-\d{2})(?:[T ]|$)/.exec(v) : null
  return m && !Number.isNaN(Date.parse(m[1]!)) ? m[1] : undefined
}

export function createSearxng(o: { endpoint: string; send?: Send; timeoutMs?: number }): SearchProvider {
  const base = searxngEndpoint(o.endpoint)
  const send = o.send ?? defaultSend
  return {
    id: 'searxng',
    async search(q, signal) {
      const url = new URL('/search', base)
      url.search = new URLSearchParams({ q: q.text, format: 'json', categories: 'general', language: 'en', ...(q.recency === 'any' ? {} : { time_range: q.recency }) }).toString()
      let reply
      try {
        reply = await send({ method: 'GET', url, headers: { accept: 'application/json' }, timeoutMs: o.timeoutMs ?? SEARCH_MS, signal })
      } catch (error) {
        return { ok: false, outcome: 'failed', reason: reasonOf(error) }
      }
      const failed = failure(reply)
      if (failed) return failed.outcome === 'busy' ? { ...failed, outcome: 'failed' } : failed
      let results: unknown
      try {
        results = obj(JSON.parse(reply.body)).results
      } catch {
        return { ok: false, outcome: 'failed', reason: 'bad-response' }
      }
      if (!Array.isArray(results)) return { ok: false, outcome: 'failed', reason: 'bad-response' }
      const sources = results.map(obj).filter((r) => typeof r.url === 'string').map((r): ProviderSource => {
        const engines = Array.isArray(r.engines) ? r.engines.filter((e): e is string => typeof e === 'string').slice(0, 20) : []
        const publishedAt = day(r.publishedDate)
        return { url: str(r.url, 4096), title: str(r.title, 1000), snippet: str(r.content, 2000), ...(engines.length ? { engines } : {}), ...(publishedAt ? { publishedAt } : {}) }
      })
      return { ok: true, sources }
    },
  }
}
