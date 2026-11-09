// The agent's own filter over every provider's results (web search design §5.3): a result
// whose host is excluded, outside `sites`, an IP literal or not http(s) is dropped, so are
// duplicates by URL and results older than the recency window when they carry a date.
// Lists merge by URL, the first provider's results first.
import { isIP } from 'node:net'
import type { ProviderSource, Recency } from './provider.js'

export type Provider = 'searxng' | 'ollama'
export type Candidate = ProviderSource & { provider: Provider; host: string }
export type Filter = { recency: Recency; sites: string[]; excludeSites: string[] }

const DAY_MS = 24 * 60 * 60_000
const WINDOW_DAYS: Record<Recency, number> = { any: Infinity, day: 1, week: 7, month: 31, year: 366 }
const under = (host: string, site: string): boolean => host === site || host.endsWith(`.${site}`)
const key = (url: URL): string => {
  const u = new URL(url.href)
  u.hash = ''
  return u.href
}

export function usable(sources: ProviderSource[], provider: Provider, f: Filter, now: number): Candidate[] {
  const out: Candidate[] = []
  for (const s of sources) {
    let url: URL
    try {
      url = new URL(s.url)
    } catch {
      continue
    }
    const host = url.hostname.replace(/\.$/, '')
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.href.length > 2048 || !host) continue
    if (isIP(host) || host.startsWith('[') || /^[\d.]+$/.test(host)) continue
    if (f.excludeSites.some((site) => under(host, site)) || (f.sites.length > 0 && !f.sites.some((site) => under(host, site)))) continue
    const published = s.publishedAt ? Date.parse(s.publishedAt) : NaN
    if (Number.isFinite(published) && now - published > WINDOW_DAYS[f.recency] * DAY_MS) continue
    out.push({ ...s, url: key(url), provider, host })
  }
  return merge(out, [])
}

/** One list by URL, `first`'s results first; a duplicate lends its page text to the result it repeats. */
export function merge(first: Candidate[], second: Candidate[]): Candidate[] {
  const byUrl = new Map<string, Candidate>()
  for (const c of [...first, ...second]) {
    const seen = byUrl.get(c.url)
    if (!seen) byUrl.set(c.url, c)
    else if (!seen.page && c.page) byUrl.set(c.url, { ...seen, page: c.page })
  }
  return [...byUrl.values()]
}
