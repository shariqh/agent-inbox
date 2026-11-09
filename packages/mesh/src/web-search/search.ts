// One search (web search design §5.2, §5.3, §6, §7, §9): shape and screen before any
// network; the memory cache; SearXNG, paced and capped; Ollama's search when SearXNG
// returned fewer than 3 usable results or failed, merged by URL with SearXNG's first;
// in `answer` mode with fetching on, Ollama's web_fetch for at most the top 3 results
// that have no page text; then passages. The model and the answer are W4's. No outcome
// carries the query, a URL that holds it, a provider's body or a key.
import { ConfigError } from '../files.js'
import { readApiKey } from '../key-source.js'
import type { KeySource } from '../key-source.js'
import { screenQuery } from '../screen.js'
import type { QueryClass, QueryScreenOptions } from '../screen.js'
import type { Budget, CapReason, Pacer } from './budget.js'
import { cacheKey } from './cache.js'
import type { Cache } from './cache.js'
import { merge, usable } from './filter.js'
import type { Candidate, Provider } from './filter.js'
import { rankPassages } from './passages.js'
import { createOllama } from './ollama.js'
import type { PageFetcher, ProviderQuery, ProviderResult, Recency, SearchProvider, Send } from './provider.js'
import { shapeQuery, siteShape } from './query.js'
import { createSearxng } from './searxng.js'

export type SearchRequest = { query: string; mode: 'answer' | 'sources'; recency: Recency; maxSources: number; sites: string[]; excludeSites: string[]; fresh: boolean }
export type Source = {
  n: number; url: string; host: string; title: string; snippet: string; passages?: string[]; publishedAt?: string; fetchedAt?: string
  retrievedAt: string; provider: Provider; engines?: string[]; pageText?: 'ollama-fetch' | 'ollama-search' | 'snippet'
}
export type Spent = { searxng: number; ollama: number }
export type Found = { ok: true; providers: Provider[]; fallback: boolean; cache: 'hit' | 'miss'; sources: Source[]; warnings: string[]; spent: Spent }
export type NotFound = { ok: false; code: 11 | 12 | 13; status: 'rejected' | 'busy' | 'failed'; reason: string; classes?: QueryClass[]; retryAfterMs?: number; spent: Spent }
export type SearchDeps = {
  searxng?: SearchProvider; ollama?: SearchProvider; fetcher?: PageFetcher; fetch: 'ollama' | 'none'
  budget: Budget; pacer: Pacer; cache: Cache<Found>; screen: () => QueryScreenOptions; threshold?: number; now?: () => number
}

export const FETCH_TOP = 3
const BUSY_MS = 60_000

export function createSearch(deps: SearchDeps): (req: SearchRequest, signal: AbortSignal) => Promise<Found | NotFound> {
  const now = deps.now ?? Date.now
  return async (req, signal) => {
    const spent: Spent = { searxng: 0, ollama: 0 }
    const stop = (code: NotFound['code'], reason: string, extra: Partial<NotFound> = {}): NotFound =>
      ({ ok: false, code, status: code === 11 ? 'rejected' : code === 12 ? 'busy' : 'failed', reason, ...extra, spent })
    const query = shapeQuery(req.query)
    const sites = [...req.sites, ...req.excludeSites]
    if (query === undefined || !sites.every(siteShape)) return stop(11, 'shape')
    const options = deps.screen()
    const classes = [...new Set([query, ...sites].flatMap((text) => { const r = screenQuery(text, options); return r.ok ? [] : r.classes }))]
    if (classes.length) return stop(11, 'screen', { classes })

    const pages = req.mode === 'answer' && deps.fetch === 'ollama' && deps.fetcher !== undefined
    const key = (p: boolean): string => cacheKey({ query, recency: req.recency, maxSources: req.maxSources, sites: req.sites, excludeSites: req.excludeSites, pages: p })
    // a `sources` call may reuse an entry with pages fetched; `fresh` replaces both
    const keys = pages ? [key(true)] : [key(false), key(true)]
    if (req.fresh) for (const k of keys) deps.cache.delete(k)
    const hit = keys.map((k) => deps.cache.get(k)).find(Boolean)
    if (hit) return view({ ...hit, cache: 'hit', spent }, req.mode)

    const pq: ProviderQuery = { text: query, recency: req.recency, max: req.maxSources, sites: req.sites, excludeSites: req.excludeSites }
    const filter = { recency: req.recency, sites: req.sites, excludeSites: req.excludeSites }
    const ollama = async (): Promise<ProviderResult | CapReason> => {
      const cap = deps.budget.take('ollama')
      if (cap) return cap
      spent.ollama++
      return deps.ollama!.search(pq, signal)
    }
    const providers: Provider[] = []
    const warnings: string[] = []
    const received = new Map<Provider, string>()
    let list: Candidate[] = []
    let searxngFailed = deps.searxng === undefined
    if (deps.searxng) {
      const paced = await deps.pacer.run(async (): Promise<ProviderResult | CapReason> => {
        const cap = deps.budget.take('searxng')
        if (cap) return cap
        spent.searxng++
        return deps.searxng!.search(pq, signal)
      })
      if (!paced.ok) return stop(12, 'searxng-paced', { retryAfterMs: paced.retryAfterMs })
      if (typeof paced.value === 'string') return stop(11, paced.value)
      if (paced.value.ok) {
        providers.push('searxng')
        received.set('searxng', new Date(now()).toISOString())
        list = usable(paced.value.sources, 'searxng', filter, now())
      } else searxngFailed = true
    }
    if (list.length < Math.min(deps.threshold ?? 3, req.maxSources) && deps.ollama) {
      const r = await ollama()
      if (typeof r === 'string') {
        if (searxngFailed) return stop(11, r)
        warnings.push(`fallback-${r}`)
      } else if (r.ok) {
        providers.push('ollama')
        received.set('ollama', new Date(now()).toISOString())
        list = merge(list, usable(r.sources, 'ollama', filter, now()))
      } else if (r.reason === 'http-429' || (r.reason === 'http-5xx' && !searxngFailed)) {
        return stop(12, `ollama-${r.reason}`, { retryAfterMs: r.retryAfterMs ?? BUSY_MS })
      } else if (searxngFailed) return stop(13, 'providers-failed')
      else warnings.push('fallback-failed')
    }
    if (!providers.length) return stop(13, deps.searxng || deps.ollama ? 'providers-failed' : 'no-provider')
    list = list.slice(0, req.maxSources)

    const fetched = new Map<number, string>()
    if (pages) {
      await Promise.all(list.slice(0, FETCH_TOP).map(async (c, i) => {
        if (c.page) return
        const cap = deps.budget.take('ollama')
        if (cap) return void warnings.push(`fetch-${cap}`)
        spent.ollama++
        const r = await deps.fetcher!.fetch(c.url, signal)
        if (r.ok) fetched.set(i, r.text)
      }))
    }
    const passages = rankPassages(query, list.map((c, i) => {
      const page = fetched.get(i) ?? c.page
      return page ? { text: page, whole: true } : { text: c.snippet, whole: false }
    }))
    const sources = list.map((c, i): Source => ({
      n: i + 1, url: c.url, host: c.host, title: c.title, snippet: c.snippet, passages: passages[i]!,
      ...(c.publishedAt ? { publishedAt: c.publishedAt } : {}), ...(c.fetchedAt ? { fetchedAt: c.fetchedAt } : {}),
      retrievedAt: received.get(c.provider)!, provider: c.provider, ...(c.engines ? { engines: c.engines } : {}),
      pageText: fetched.has(i) ? 'ollama-fetch' : c.page ? 'ollama-search' : 'snippet',
    }))
    const found: Found = { ok: true, providers, fallback: providers.includes('ollama'), cache: 'miss', sources, warnings: [...new Set(warnings)], spent }
    // a result a failing provider cut short is not kept
    if (!found.warnings.length) deps.cache.set(key(pages), { ...found, spent: { searxng: 0, ollama: 0 } }, req.recency)
    return view(found, req.mode)
  }
}

/** `sources` mode carries no passages (§4.3). */
const view = (found: Found, mode: SearchRequest['mode']): Found =>
  mode === 'answer' ? found : { ...found, sources: found.sources.map(({ passages: _p, pageText: _t, ...s }) => s) }

export type ProvidersProfile = { searxng?: { endpoint: string }; ollama?: { apiKey: KeySource } }

/** The profile's providers: SearXNG at its checked endpoint, Ollama with its key read from `{ env }`, `{ file }` or `{ command }`. */
export function providersFrom(p: ProvidersProfile, env: NodeJS.ProcessEnv, send?: Send): Pick<SearchDeps, 'searxng' | 'ollama' | 'fetcher'> {
  const key = p.ollama ? readApiKey(p.ollama.apiKey, env) : undefined
  if (p.ollama && !key) throw new ConfigError('ollama.apiKey must name a key')
  const ollama = key ? createOllama({ key, send }) : undefined
  if (!p.searxng && !ollama) throw new ConfigError('the profile names no search provider')
  return { searxng: p.searxng ? createSearxng({ endpoint: p.searxng.endpoint, send }) : undefined, ollama: ollama?.search, fetcher: ollama?.fetcher }
}
