// Child process for the canary test (web search design §13, Logs): the real
// agent through `serve`, so the same output guard, front door and gate, with a run
// whose stages try every way to leak the query: an error carrying it, a provider
// failure carrying `?q=<query>`, console calls, a warning, a throw from a timer
// callback and a rejected promise nobody awaits; and W3's real search, whose
// transport fails with the URL (`?q=<query>`) and the Ollama key in its message.
import { fixtureRun, serve } from '../src/web-search/agent.js'
import type { Run } from '../src/web-search/agent.js'
import { createBudget, createPacer } from '../src/web-search/budget.js'
import { createCache } from '../src/web-search/cache.js'
import { createOllama } from '../src/web-search/ollama.js'
import type { Send } from '../src/web-search/provider.js'
import { createSearch } from '../src/web-search/search.js'
import type { Found } from '../src/web-search/search.js'
import { createSearxng } from '../src/web-search/searxng.js'

const careless: Send = async (r) => {
  const error = new Error(`${r.method} ${r.url.href} failed with ${r.headers.authorization ?? ''}`)
  console.error('transport failed', error)
  throw error
}
const ollama = createOllama({ key: process.env['W3_CANARY_KEY']!, send: careless })
let state = ''
const search = createSearch({
  searxng: createSearxng({ endpoint: 'http://127.0.0.1:9', send: careless }), ollama: ollama.search, fetcher: ollama.fetcher, fetch: 'ollama',
  budget: createBudget({ store: { load: () => state, save: (t) => { state = t } } }), pacer: createPacer({ spacingMs: 0 }), cache: createCache<Found>(),
  screen: () => ({ user: 'canary-user', interfaces: [] }),
})

const never = new Promise<never>(() => {})
const run: Run = async (query, options, signal, onState) => {
  onState('searching')
  const kind = query.split(' ')[0]
  if (kind === 'throw') throw new Error(`stage failed on ${query}`)
  if (kind === 'provider') {
    const error = new Error(`GET https://kagi.com/api/v0/search?q=${encodeURIComponent(query)} failed`)
    console.error('provider failed', error)
    console.warn(query)
    console.log({ query })
    console.info(query)
    console.debug(query)
    console.trace(query)
    console.dir({ query })
    console.table([query])
    console.assert(false, query)
    throw error
  }
  if (kind === 'search') {
    const r = await search({ query, mode: 'answer', recency: 'any', maxSources: 5, sites: [], excludeSites: [], fresh: false }, signal)
    if (r.ok) return fixtureRun(query, options, signal, () => {})
    return { state: r.code === 13 ? 'failed' : 'rejected', reason: r.reason, data: { code: r.code, status: r.status, reason: r.reason } }
  }
  if (kind === 'warning') {
    process.emitWarning(query)
    process.emitWarning(`again ${query}`, query.replace(/\W/g, ''))
    return fixtureRun(query, options, signal, () => {})
  }
  if (kind === 'timer') {
    setTimeout(() => { throw new Error(query) }, 5)
    return never
  }
  if (kind === 'reject') {
    void Promise.reject(new Error(query))
    return never
  }
  return fixtureRun(query, options, signal, onState)
}

process.exit(await serve({ meshDir: process.env['AGENT_INBOX_MESH_DIR']!, run }, (text) => process.stderr.write(text)))
