// The Ollama adapter (web search design §5.3): POST https://ollama.com/api/web_search
// with { query, max_results } and the bearer key, whose `content` becomes the source's
// `page`; POST /api/web_fetch with { url } is the page fetcher. The key goes into the
// Authorization header only, never into a result, an error or a log.
import { failure, obj, reasonOf, send as defaultSend, str, withSites } from './provider.js'
import type { PageFetcher, ProviderReason, ProviderSource, SearchProvider, Send } from './provider.js'

const ORIGIN = 'https://ollama.com'
const SEARCH_MS = 20_000
const FETCH_MS = 8_000
export const PAGE_MAX = 200_000

export function createOllama(o: { key: string; send?: Send; searchMs?: number; fetchMs?: number }): { search: SearchProvider; fetcher: PageFetcher } {
  const send = o.send ?? defaultSend
  const post = async (path: string, body: object, timeoutMs: number, signal: AbortSignal): Promise<{ ok: true; json: Record<string, unknown> } | Extract<Awaited<ReturnType<SearchProvider['search']>>, { ok: false }>> => {
    let reply
    try {
      reply = await send({
        method: 'POST', url: new URL(path, ORIGIN), body: JSON.stringify(body), timeoutMs, signal,
        headers: { authorization: `Bearer ${o.key}`, 'content-type': 'application/json', accept: 'application/json' },
      })
    } catch (error) {
      return { ok: false, outcome: 'failed', reason: reasonOf(error) }
    }
    const failed = failure(reply)
    if (failed) return failed
    try {
      return { ok: true, json: obj(JSON.parse(reply.body)) }
    } catch {
      return { ok: false, outcome: 'failed', reason: 'bad-response' }
    }
  }
  return {
    search: {
      id: 'ollama',
      async search(q, signal) {
        const r = await post('/api/web_search', { query: withSites(q.text, q.sites), max_results: q.max }, o.searchMs ?? SEARCH_MS, signal)
        if (!r.ok) return r
        if (!Array.isArray(r.json.results)) return { ok: false, outcome: 'failed', reason: 'bad-response' }
        const sources = r.json.results.map(obj).filter((s) => typeof s.url === 'string').map((s): ProviderSource => {
          const page = str(s.content, PAGE_MAX)
          return { url: str(s.url, 4096), title: str(s.title, 1000), snippet: page.slice(0, 400), ...(page.trim() ? { page } : {}) }
        })
        return { ok: true, sources }
      },
    },
    fetcher: {
      async fetch(url, signal): Promise<{ ok: true; text: string } | { ok: false; reason: ProviderReason }> {
        const r = await post('/api/web_fetch', { url }, o.fetchMs ?? FETCH_MS, signal)
        if (!r.ok) return { ok: false, reason: r.reason }
        const text = str(r.json.content, PAGE_MAX)
        return text.trim() ? { ok: true, text } : { ok: false, reason: 'bad-response' }
      },
    },
  }
}
