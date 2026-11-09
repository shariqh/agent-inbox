// The memory cache (web search design §9.2): 15 minutes (5 for `recency: day`), at most
// 200 entries, never on disk. The key is a SHA-256 over the normalised query, recency,
// maxSources, the sorted sites and exclusions, and `pages` (whether page text was
// fetched), so a `sources` call may reuse an `answer` call's entry but never the other way.
import { createHash } from 'node:crypto'
import type { Recency } from './provider.js'

export type CacheKey = { query: string; recency: Recency; maxSources: number; sites: string[]; excludeSites: string[]; pages: boolean }
export type Cache<T> = { get(key: string): T | undefined; set(key: string, value: T, recency: Recency): void; delete(key: string): void }

const TTL_MS = 15 * 60_000
const DAY_TTL_MS = 5 * 60_000
const ENTRIES = 200

export const normaliseQuery = (query: string): string => query.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()

export const cacheKey = (k: CacheKey): string => createHash('sha256').update(JSON.stringify([
  'web-search/v1', normaliseQuery(k.query), k.recency, k.maxSources, [...k.sites].sort(), [...k.excludeSites].sort(), k.pages,
])).digest('hex')

export function createCache<T>(now: () => number = Date.now): Cache<T> {
  const entries = new Map<string, { value: T; until: number }>()
  return {
    get(key) {
      const e = entries.get(key)
      if (e && e.until > now()) return e.value
      entries.delete(key)
      return undefined
    },
    delete: (key) => void entries.delete(key),
    set(key, value, recency) {
      entries.delete(key)
      entries.set(key, { value, until: now() + (recency === 'day' ? DAY_TTL_MS : TTL_MS) })
      // a Map keeps insertion order, so the first key is the oldest
      while (entries.size > ENTRIES) entries.delete(entries.keys().next().value!)
    },
  }
}
