// Child process for the canary test (web search design §13, Logs): the real
// agent through `serve`, so the same output guard, front door and gate, with a run
// whose stages try every way to leak the query: an error carrying it, a provider
// failure carrying `?q=<query>`, console calls, a warning, a throw from a timer
// callback and a rejected promise nobody awaits.
import { fixtureRun, serve } from '../src/web-search/agent.js'
import type { Run } from '../src/web-search/agent.js'

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
