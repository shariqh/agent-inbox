// Rate limits (web search design §9.1): they protect the home network's address and the
// free Ollama account, not a bill. SearXNG gets one request at a time, at least 2 s apart,
// waiting up to 5 s for its turn before the task is busy; each provider has an hourly and
// a daily cap, persisted 0600 so a restart does not reset them. A cap refuses (11); a
// cache hit spends nothing, because nothing here is called for one.
import { localDate, readPrivate, writePrivate } from '../files.js'

export type Caps = { hour: number; day: number }
export type Metered = 'searxng' | 'ollama'
export type CapReason = 'hourly-cap' | 'daily-cap'
export type Budget = { take(provider: Metered): CapReason | undefined }
export type Store = { load(): string | undefined; save(text: string): void }

export const DEFAULT_CAPS: Record<Metered, Caps> = { searxng: { hour: 30, day: 100 }, ollama: { hour: 30, day: 150 } }
const HOUR_MS = 60 * 60_000

export const fileStore = (path: string): Store => ({ load: () => readPrivate(path, true), save: (text) => writePrivate(path, text) })

type Count = { day: number; hour: number[] }
export function createBudget(o: { store: Store; now?: () => number; caps?: Record<Metered, Caps> }): Budget {
  const now = o.now ?? Date.now
  const caps = o.caps ?? DEFAULT_CAPS
  let state: { date: string; counts: Partial<Record<Metered, Count>> } = { date: '', counts: {} }
  try {
    const saved = JSON.parse(o.store.load() ?? '{}') as typeof state
    if (typeof saved.date === 'string' && saved.counts && typeof saved.counts === 'object') state = saved
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
  }
  return {
    take(provider) {
      const at = now()
      if (state.date !== localDate(at)) {
        state.date = localDate(at)
        for (const c of Object.values(state.counts)) if (c && typeof c === 'object') c.day = 0
      }
      const prior = state.counts[provider]
      const count: Count = { day: Number.isSafeInteger(prior?.day) ? prior!.day : 0, hour: (Array.isArray(prior?.hour) ? prior!.hour : []).filter((t) => typeof t === 'number' && at - t < HOUR_MS && t <= at) }
      state.counts[provider] = count
      if (count.day >= caps[provider].day) return 'daily-cap'
      if (count.hour.length >= caps[provider].hour) return 'hourly-cap'
      count.day++
      count.hour.push(at)
      o.store.save(JSON.stringify(state))
      return undefined
    },
  }
}

export type Pacer = { run<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; retryAfterMs: number }> }

/** One call at a time, `spacingMs` between the end of one and the start of the next; a call that cannot start within `waitMs` is turned away. */
export function createPacer(o: { spacingMs?: number; waitMs?: number; now?: () => number } = {}): Pacer {
  const spacing = o.spacingMs ?? 2000
  const wait = o.waitMs ?? 5000
  const now = o.now ?? Date.now
  let chain: Promise<void> = Promise.resolve()
  let lastEnd = -Infinity
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  return {
    async run(fn) {
      const start = now()
      const prior = chain
      let release!: () => void
      chain = new Promise((resolve) => { release = resolve })
      let timer: NodeJS.Timeout | undefined
      const turn = await Promise.race([prior.then(() => true), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), wait) })])
      clearTimeout(timer)
      // a caller that gives up still releases its place only after the one before it ends
      if (!turn) {
        void prior.then(release)
        return { ok: false, retryAfterMs: wait + spacing }
      }
      const gap = lastEnd + spacing - now()
      if (gap > 0 && now() - start + gap > wait) {
        release()
        return { ok: false, retryAfterMs: Math.ceil(gap) }
      }
      if (gap > 0) await sleep(gap)
      try {
        return { ok: true, value: await fn() }
      } finally {
        lastEnd = now()
        release()
      }
    },
  }
}
