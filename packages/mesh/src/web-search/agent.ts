// The web search agent process, W1 (web search design §2.1, §3.2, §4, §13): the
// SDK spike. It refuses to start unless mesh.json's `agents.web-search` names a
// loopback endpoint, serves A2A there behind its own front door, and exits within
// a minute of that key or the caller token changing, or after 30 idle minutes.
// The real run is `createRun` (answer.ts: W3's search, W4's answer); until W5
// reads the profile that builds it, `startAgent` answers from one fixed result. The
// executor never rejects, so the SDK never logs or returns an error message. Every console call and process-level error or warning writes a fixed
// line: no query, argument or error message reaches stderr or a log.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Role, TaskState } from '@a2a-js/sdk'
import type { Part } from '@a2a-js/sdk'
import { AgentEvent } from '@a2a-js/sdk/server'
import type { AgentExecutor, ExecutionEventBus } from '@a2a-js/sdk/server'
import { ConfigError, appendPrivate, localDate, readPrivate } from '../files.js'
import { meshDir, meshFile, readMesh } from '../mesh-config.js'
import { EXTENSION, startFrontDoor } from './front-door.js'

export const GATE_MS = 60_000
export const IDLE_MS = 30 * 60_000
type Json = Record<string, unknown>
/** `log` holds fixed names, counts and timings only (§7.1 Logs); the executor adds it to the task's log line. */
export type RunResult = ({ state: 'completed'; text: string; data: Json } | { state: 'rejected' | 'failed'; reason: string; data: Json }) & { log?: Json }
export type Run = (query: string, options: Json, signal: AbortSignal, onState: (state: string) => void) => Promise<RunResult>
export type StopReason = 'mesh.json' | 'token' | 'idle' | 'signal'
export type AgentOptions = { meshDir: string; run?: Run; now?: () => number; every?: (ms: number, fn: () => void) => () => void }
export type Agent = { port: number; exited: Promise<StopReason>; stop(reason: StopReason): Promise<void>; failAll(): void }

/** The card of §4.1: nothing per copy but the interface URL, which the card hash leaves out. */
export const card = (url: string, version: string): Json => ({
  name: 'web-search', description: 'Searches the public web for one question and returns a cited answer or the sources alone.', version,
  supportedInterfaces: [{ url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
  capabilities: {
    streaming: true, pushNotifications: false,
    extensions: [{ uri: EXTENSION, description: 'web-search task parameters and result', required: false, params: { api: 1, modes: ['answer', 'sources'], recency: ['any', 'day', 'week', 'month', 'year'], maxSources: 10, maxQueryChars: 400, maxSites: 5, maxExcludeSites: 10 } }],
  },
  securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
  securityRequirements: [{ schemes: { bearer: { list: [] } } }],
  defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain', 'application/json'],
  skills: [{ id: 'web-search', name: 'web-search', description: 'Answers one question from the public web with numbered sources, or returns the sources alone.', tags: ['search', 'web'] }],
})

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

const part = (value: string | Json): Part => typeof value === 'string'
  ? { content: { $case: 'text', value }, mediaType: 'text/plain', filename: '', metadata: undefined }
  : { content: { $case: 'data', value }, mediaType: 'application/json', filename: '', metadata: undefined }

export function createExecutor(run: Run, log: (entry: Json) => void): AgentExecutor & { open(): number; failAll(reason: string): void } {
  const open = new Map<string, { bus: ExecutionEventBus; contextId: string; abort: AbortController; outcome?: string }>()
  const status = (bus: ExecutionEventBus, taskId: string, contextId: string, state: TaskState, parts?: Part[]): void => bus.publish(AgentEvent.statusUpdate({
    taskId, contextId, metadata: undefined,
    status: { state, timestamp: new Date().toISOString(), message: parts && { messageId: randomUUID(), taskId, contextId, role: Role.ROLE_AGENT, parts, metadata: undefined, extensions: [], referenceTaskIds: [] } },
  }))
  /** Ends a task that is still open with a fixed reason; the one place a non-completed terminal state is published. */
  const end = (id: string, state: TaskState, outcome: string, reason: string, data?: Json): void => {
    const t = open.get(id)
    if (!t) return
    open.delete(id)
    t.outcome = `${outcome}:${reason}`
    t.abort.abort()
    const code = state === TaskState.TASK_STATE_REJECTED ? 11 : 13
    status(t.bus, id, t.contextId, state, state === TaskState.TASK_STATE_CANCELED ? [part('cancelled')] : [part(`${outcome}: ${reason}`), part(data ?? { code, status: outcome, reason })])
  }
  return {
    open: () => open.size,
    failAll: (reason) => { for (const id of [...open.keys()]) end(id, TaskState.TASK_STATE_FAILED, 'failed', reason) },
    cancelTask: async (id) => end(id, TaskState.TASK_STATE_CANCELED, 'cancelled', 'cancelled'),
    execute: async (ctx, bus) => {
      const { taskId: id, contextId } = ctx
      const t = { bus, contextId, abort: new AbortController(), outcome: 'failed:internal' }
      open.set(id, t)
      const started = Date.now()
      const content = ctx.userMessage.parts[0]?.content
      const query = content?.$case === 'text' ? content.value : ''
      const options = (ctx.userMessage.metadata?.[EXTENSION] ?? {}) as Json
      let extra: Json | undefined
      try {
        bus.publish(AgentEvent.task({ id, contextId, status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: new Date().toISOString() }, artifacts: [], history: [], metadata: undefined }))
        const r = await run(query, options, t.abort.signal, (state) => { if (open.has(id)) status(bus, id, contextId, TaskState.TASK_STATE_WORKING, [part(state)]) })
        extra = r.log
        if (!open.has(id)) return
        if (r.state !== 'completed') return end(id, r.state === 'rejected' ? TaskState.TASK_STATE_REJECTED : TaskState.TASK_STATE_FAILED, r.state, r.reason, r.data)
        open.delete(id)
        t.outcome = 'completed'
        // the one artifact goes out only with COMPLETED, so no unchecked answer is ever streamed
        bus.publish(AgentEvent.artifactUpdate({ taskId: id, contextId, artifact: { artifactId: randomUUID(), name: 'web-search', description: '', parts: [part(r.text), part(r.data)], metadata: undefined, extensions: [] }, append: false, lastChunk: true, metadata: undefined }))
        status(bus, id, contextId, TaskState.TASK_STATE_COMPLETED)
      } catch {
        try {
          end(id, TaskState.TASK_STATE_FAILED, 'failed', 'internal')
        } catch {}
      } finally {
        try {
          log({ taskId: id, chars: query.length, words: query.split(/\s+/).filter(Boolean).length, mode: options.mode === 'sources' ? 'sources' : 'answer', outcome: t.outcome, ms: Date.now() - started, ...(extra ? { run: extra } : {}) })
        } catch {}
      }
    },
  }
}

const BUILTIN = [TypeError, RangeError, SyntaxError, ReferenceError, URIError, EvalError, AggregateError, Error]
const WARNINGS = ['Warning', 'DeprecationWarning', 'ExperimentalWarning', 'MaxListenersExceededWarning', 'TimeoutOverflowWarning', 'UnsupportedWarning']
const SDK_EVENTS = ['Agent execution failed', 'Event processing loop failed', 'Error sending push notification', 'Failed to load full task', 'ResultManager', 'Reference task']
const CONSOLE = ['log', 'info', 'debug', 'warn', 'error', 'trace', 'dir', 'dirxml', 'table', 'assert', 'count', 'group', 'groupCollapsed', 'timeLog', 'timeEnd'] as const

/** Every console call and process-level error or warning writes one fixed line: never an argument, a message or a stack. */
export function guardOutput(write: (line: string) => void, fatal: () => void): void {
  for (const name of CONSOLE) {
    console[name] = (...args: unknown[]): void => {
      const event = typeof args[0] === 'string' ? SDK_EVENTS.find((e) => (args[0] as string).startsWith(e)) : undefined
      write(`sdk: ${name}${event ? ` ${event}` : ''}`)
    }
  }
  const die = (error: unknown): void => {
    write(`agent: uncaught ${BUILTIN.find((c) => error instanceof c)?.name ?? 'value'}`)
    fatal()
  }
  process.on('uncaughtException', die)
  process.on('unhandledRejection', die)
  process.removeAllListeners('warning')
  process.on('warning', (w) => write(`agent: warning ${WARNINGS.includes(w.name) ? w.name : 'other'}`))
}

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
  const token = readPrivate(tokenFile).trim()
  if (!/^[\x21-\x7E]{32,}$/.test(token)) throw new ConfigError('the token must be at least 32 printable characters')
  const version = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version
  const executor = createExecutor(o.run ?? fixtureRun, (entry) => {
    try {
      appendPrivate(join(root, 'logs', `web-search-${localDate(now())}.log`), JSON.stringify({ at: new Date(now()).toISOString(), ...entry }))
    } catch {
      process.stderr.write('agent: could not write the task log\n')
    }
  })
  const door = await startFrontDoor({ port, tokens: [token], card: (url) => card(url, version), executor, busy: () => executor.open() > 0, now })

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
