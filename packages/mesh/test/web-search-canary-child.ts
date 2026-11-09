// Child process for the canary test (web search design §13, Logs): the real
// agent through `serve`, so the same output guard, front door and gate, with a run
// whose stages try every way to leak the query: an error carrying it, a provider
// failure carrying `?q=<query>`, console calls, a warning, a throw from a timer
// callback and a rejected promise nobody awaits; W3's real search, whose
// transport fails with the URL (`?q=<query>`) and the Ollama key in its message; and
// W4's answer, whose model answers with a canary or fails with the prompt (the query)
// and that answer in its error.
import type { Post } from '../src/backend.js'
import { fixtureRun, serve } from '../src/web-search/agent.js'
import type { Run } from '../src/web-search/agent.js'
import { createRun } from '../src/web-search/answer.js'
import type { CachedAnswer } from '../src/web-search/answer.js'
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

const ANSWER = 'Quuxcanaryanswer: version 24 entered long-term support on 2025-10-28 [1].'
const answerRun = (post: Post): Run => {
  let saved = ''
  const budget = createBudget({ store: { load: () => saved, save: (t) => { saved = t } } })
  const page = 'Version 24 of the example runtime entered long-term support on 2025-10-28, and v24.11.0 is the first release in that line.'
  const searxng = { id: 'searxng', search: async () => ({ ok: true as const, sources: [{ url: 'https://docs.example.com/releases/24', title: 'Example runtime release notes', snippet: page, page }] }) }
  const found = createSearch({ searxng, fetch: 'none', budget, pacer: createPacer({ spacingMs: 0 }), cache: createCache<Found>(), screen: () => ({ user: 'canary-user', interfaces: [] }) })
  return createRun({ search: found, model: { baseUrl: 'http://127.0.0.1:9', model: 'canary-model' }, budget, answers: createCache<CachedAnswer>(), post })
}
const answered = answerRun(async () => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: ANSWER }, finish_reason: 'stop' }] }) }))
const modelFails = answerRun(async (_url, body) => {
  const error = new Error(`model failed on ${body} with ${ANSWER}`)
  console.error('model failed', error, body)
  throw error
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
  if (kind === 'answer-ok') return answered(query, options, signal, onState)
  if (kind === 'answer-error') return modelFails(query, options, signal, onState)
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
