// The web search agent process, W1 (web search design §2.1, §3.2, §4, §13): the
// SDK spike. It refuses to start unless mesh.json's `agents.web-search` names a
// loopback endpoint, serves A2A there behind its own front door, and exits within
// a minute of that key or the caller token changing, or after 30 idle minutes. At start
// it signs its card with its own key, when `meshctl key create web-search` made one
// (publishable-agent design §3.10, C7); without one it serves the card unsigned.
// The real run is `createRun` (answer.ts: W3's search, W4's answer); until W5
// reads the profile that builds it, `startAgent` answers from one fixed result. The
// executor never rejects, so the SDK never logs or returns an error message. Every console call and process-level error or warning writes a fixed
// line: no query, argument or error message reaches stderr or a log. Its card, executor and
// output guard are the agent kit's (src/kit/, #539).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadSigningKeys } from '../card-signing.js'
import type { SigningKey } from '../card-signing.js'
import { ConfigError, appendPrivate, localDate, readPrivate } from '../files.js'
import { readToken } from '../kit/agent.js'
import { PROFILE, meshCard, servedCard as signedCard } from '../kit/card.js'
import { createExecutor as createKitExecutor } from '../kit/executor.js'
import type { Executor, Run } from '../kit/executor.js'
import { guardOutput } from '../kit/guard.js'
import { meshDir, meshFile, readMesh } from '../mesh-config.js'
import { EXTENSION, startFrontDoor } from './front-door.js'

export const GATE_MS = 60_000
export const IDLE_MS = 30 * 60_000
type Json = Record<string, unknown>
export type { Run, RunResult } from '../kit/executor.js'
export type StopReason = 'mesh.json' | 'token' | 'idle' | 'signal'
export type AgentOptions = { meshDir: string; run?: Run; now?: () => number; every?: (ms: number, fn: () => void) => () => void }
export type Agent = { port: number; exited: Promise<StopReason>; stop(reason: StopReason): Promise<void>; failAll(): void }

// The profile extension (publishable-agent design §3.7, §8): the stable id, the signing keys'
// public halves, and per skill what leaves with the caller's input and where the work may run.
// Hosts are "operator": a card names no private search or model host, and every copy serves one card.
export { PROFILE }
export const AGENT_ID = 'shariqh.github.io/agent-inbox/web-search'

/**
 * The card of §4.1 and the publishable-agent design's §8: nothing per copy but the interface URL,
 * which the card pin leaves out, and the keys this copy signs with (none: the card is unsigned, and
 * its profile lists no keys). Canonical-stable (no empty or default value; the bearer requirement
 * names the role "call"), so card-signing.ts signs it and every A2A verifier checks the same bytes.
 */
export const card = (url: string, version: string, keys: Json[] = []): Json => meshCard({
  name: 'web-search', description: 'Searches the public web for one question and returns a cited answer or the sources alone.', version,
  provider: { organization: 'agent-inbox', url: 'https://github.com/shariqh/agent-inbox' }, id: AGENT_ID, streaming: true,
  extensions: [{ uri: EXTENSION, description: 'web-search task parameters and result', params: { api: 1, modes: ['answer', 'sources'], recency: ['any', 'day', 'week', 'month', 'year'], maxSources: 10, maxQueryChars: 400, maxSites: 5, maxExcludeSites: 10 } }],
  inputModes: ['text/plain'], outputModes: ['text/plain', 'application/json'],
  skills: [{
    id: 'web-search', name: 'web-search', description: 'Answers one question from the public web with numbered sources, or returns the sources alone.', tags: ['search', 'web'],
    egress: [{ purpose: 'search', hosts: 'operator', sends: 'input' }, { purpose: 'model', hosts: 'operator', sends: 'input' }], residency: 'caller-mesh',
  }],
}, url, keys)

/** The card this copy serves: signed by every key in `<mesh dir>/mesh/keys/web-search.jwk` (and `-next.jwk` while rotating), or unsigned when there is none. */
export const servedCard = (url: string, version: string, keys: SigningKey[]): Json => signedCard((listed) => card(url, version, listed), keys)

/** W1 answers every query from one fixed result; W3 and W4 replace it. */
export const fixtureRun: Run = async (_query, options, _signal, onState) => {
  const mode = options.mode === 'sources' ? 'sources' : 'answer'
  for (const state of mode === 'sources' ? ['searching'] : ['searching', 'answering', 'checking']) {
    onState(state)
    await new Promise((resolve) => setImmediate(resolve))
  }
  const sources = [{ n: 1, url: 'https://example.com/', host: 'example.com', title: 'Example Domain', snippet: 'This domain is for use in documentation examples.', retrievedAt: new Date().toISOString(), provider: 'fixture', suspect: false }]
  const answer = { text: 'example.com is reserved for use in documentation [1].', found: true, citations: [1], model: 'fixture', attempts: 1 }
  const data = { code: 0, mode, untrusted: true, provider: 'fixture', cache: 'miss', ...(mode === 'answer' ? { answer } : {}), sources, warnings: [], ms: { queued: 0, search: 0, model: 0, check: 0 } }
  return { state: 'completed', text: mode === 'answer' ? `${answer.text}\n\nSources:\n[1] Example Domain — https://example.com/` : '1 source', data }
}

/** The kit's executor, its artifact `web-search` and its log entry naming the mode. */
export const createExecutor = (run: Run, log: (entry: Json) => void): Executor =>
  createKitExecutor(run, log, { artifact: 'web-search', extension: EXTENSION, logFields: (options) => ({ mode: options.mode === 'sources' ? 'sources' : 'answer' }) })

/** The port of `agents.web-search.endpoint`, which must be http://127.0.0.1:<port>. */
export function endpointPort(dir: string): number {
  const read = readMesh(meshFile(dir))
  const endpoint = read.kind === 'present' ? (read.doc as { agents?: { 'web-search'?: { endpoint?: unknown } } }).agents?.['web-search']?.endpoint : undefined
  if (endpoint === undefined) throw new ConfigError('mesh.json has no agents.web-search: run meshctl enable --web-search')
  const port = Number(/^http:\/\/127\.0\.0\.1:(\d{1,5})\/?$/.exec(String(endpoint))?.[1])
  if (!(port >= 1 && port <= 65535) || port === 80) throw new ConfigError('agents.web-search.endpoint must be http://127.0.0.1:<port>')
  return port
}

export async function startAgent(o: AgentOptions): Promise<Agent> {
  const now = o.now ?? Date.now
  const port = endpointPort(o.meshDir)
  const root = join(o.meshDir, 'mesh')
  const tokenFile = join(root, 'tokens', 'web-search')
  const token = readToken(tokenFile)
  const version = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version
  // read once per start, before the port opens: a key file that breaks a rule stops the start
  const keys = loadSigningKeys(o.meshDir, 'web-search')
  const executor = createExecutor(o.run ?? fixtureRun, (entry) => {
    try {
      appendPrivate(join(root, 'logs', `web-search-${localDate(now())}.log`), JSON.stringify({ at: new Date(now()).toISOString(), ...entry }))
    } catch {
      process.stderr.write('agent: could not write the task log\n')
    }
  })
  const door = await startFrontDoor({ port, tokens: [token], card: (url) => servedCard(url, version, keys), executor, busy: () => executor.open() > 0, now })

  let finished: (reason: StopReason) => void = () => {}
  const exited = new Promise<StopReason>((resolve) => { finished = resolve })
  let stopping: Promise<void> | undefined
  const every = o.every ?? ((ms, fn) => {
    const timer = setInterval(fn, ms)
    return () => clearInterval(timer)
  })
  const stop = (reason: StopReason): Promise<void> => {
    stopping ??= (async () => {
      cancelTick()
      executor.failAll('agent-stopped')
      await door.close()
      finished(reason)
    })()
    return stopping
  }
  const cancelTick = every(GATE_MS, () => {
    let on = false
    let sameToken = false
    try {
      on = endpointPort(o.meshDir) === port
    } catch {}
    try {
      sameToken = readPrivate(tokenFile).trim() === token
    } catch {}
    if (!on) void stop('mesh.json')
    else if (!sameToken) void stop('token')
    else if (door.idleMs() >= IDLE_MS) void stop('idle')
  })
  return { port, exited, stop, failAll: () => executor.failAll('internal') }
}

/** Runs the agent until it stops: 0 when it stops, 1 when it refuses to start. Output is this package's fixed lines only. */
export async function serve(o: AgentOptions, write: (text: string) => void): Promise<number> {
  let agent: Agent | undefined
  guardOutput((line) => write(`${line}\n`), () => {
    try {
      agent?.failAll()
    } finally {
      setTimeout(() => process.exit(1), 100)
    }
  })
  try {
    agent = await startAgent(o)
  } catch (error) {
    write(`agent-inbox-wrap: ${error instanceof ConfigError ? error.message : 'internal error'}\n`)
    return 1
  }
  write(`agent-inbox-wrap: web-search listening on http://127.0.0.1:${agent.port}\n`)
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => void agent?.stop('signal'))
  write(`agent-inbox-wrap: stopped (${await agent.exited})\n`)
  return 0
}

export async function main(args: string[], env: NodeJS.ProcessEnv, write: (text: string) => void): Promise<number> {
  const flag = (name: string): string | undefined => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined)
  if (args.length !== 4 || flag('--agent') !== 'web-search' || flag('--profile') !== 'web-search') {
    write('usage: agent-inbox-wrap --agent web-search --profile web-search\n')
    return 4
  }
  return serve({ meshDir: meshDir(env) }, write)
}
