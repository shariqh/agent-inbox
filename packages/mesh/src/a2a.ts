// The A2A server of unslop and unslop-code (#483, unslop design §7.2-§7.3, §8.3): a minimal,
// hand-rolled JSON-RPC subset of A2A 1.0 on node:http. What one agent does is its
// Skill (src/skills.ts): the card's identity, the extension, the proof label, how a
// message becomes a task, the run and the artifact; the protocol here is shared. 127.0.0.1 only. Every
// request with an Origin header, or a Host other than 127.0.0.1:<port>, is
// refused; every request but the card needs a bearer token. SendMessage,
// SendStreamingMessage (status updates only: the edited text arrives once, with
// COMPLETED), GetTask and CancelTask; no push notifications. One task runs and one
// waits; a task the queue cannot finish within the caller's timeout is refused
// up front as busy. A task belongs to the token that created it. A card request that
// carries an `A2A-Mesh-Challenge` nonce is answered with `A2A-Mesh-Proof` =
// HMAC-SHA256(token, "<proof label>\n" + nonce) (#492), so the client sends the token and
// the draft only to the process that holds the token; the card itself stays public.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ConfigError } from './files.js'
import { TASK_MS } from './unslop.js'

export const DEFAULT_TIMEOUT_MS = 280_000
const RETRY_AFTER_MS = 60_000
const KEEP = 64
const S = { submitted: 'TASK_STATE_SUBMITTED', working: 'TASK_STATE_WORKING', completed: 'TASK_STATE_COMPLETED', rejected: 'TASK_STATE_REJECTED', failed: 'TASK_STATE_FAILED', canceled: 'TASK_STATE_CANCELED' } as const
type State = (typeof S)[keyof typeof S]
const TERMINAL = new Set<State>([S.completed, S.rejected, S.failed, S.canceled])

type Json = Record<string, unknown>
/** What every skill's run returns: the server reads the code, the status line and the model time. */
export type SkillResult = { code: number; status: string; reason?: string; ms: { load: number; model: number } }
export type RunContext = { taskId: string; queuedMs: number; budgetMs: number; signal: AbortSignal }
/** A message the skill takes: its input, its queue estimate and its log fields (sizes and classes only). */
export type Accepted<I> = { input: I; estimateMs: number; log: Json }
/** Everything one agent's server does that the protocol does not. */
export type Skill<I = unknown, R extends SkillResult = SkillResult> = {
  /** the card's name, the skill id and the artifact's name */
  name: string
  description: string
  entry: { description: string; tags: string[] }
  modes: { input: string[]; output: string[] }
  extension: { uri: string; description: string; params: () => Json }
  /** the identity proof's label, e.g. `unslop/v1` */
  proofLabel: string
  bodyMax: number
  /** the JSON-RPC -32602 message for a message this skill cannot read */
  malformed: string
  /** the one part of a user message and its extension metadata: a task, a code 11 refusal reason, or undefined for `malformed` */
  accept: (part: Json, meta: Json) => Accepted<I> | { refuse: string; log: Json } | undefined
  run: (input: I, context: RunContext, onState: (state: string) => void) => Promise<R>
  /** a result's report; `content`, the artifact's first part, only when the task completes */
  outcome: (result: R) => { content?: Json; data: Json }
}
export type Refusal = { taskId: string; code: number; status: string; reason: string; ms: { queued: number }; [field: string]: unknown }
export type ServerOptions<I = unknown, R extends SkillResult = SkillResult> = {
  host: string
  port: number
  tokens: string[]
  version: string
  skill: Skill<I, R>
  budget?: { take(): boolean; spend(modelMs: number): void }
  /** tasks refused or cancelled before the pipeline; the pipeline logs its own */
  log?: (entry: Refusal) => void
  now?: () => number
}
export type A2AServer = { port: number; idleMs(): number; close(): Promise<void> }

type Task = {
  id: string; contextId: string; owner: number; input: unknown; log: Json; timeoutMs: number; estimateMs: number
  submittedAt: number; startedAt: number; status: Json & { state: State }; artifact?: Json
  abort: AbortController; listeners: Set<(events: Json[], end: boolean) => void>; done: Promise<void>; settle: () => void
}

const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})

export async function startServer<I, R extends SkillResult>(o: ServerOptions<I, R>): Promise<A2AServer> {
  if (o.host !== '127.0.0.1') throw new ConfigError('the agent binds 127.0.0.1 only')
  const skill = o.skill
  const now = o.now ?? Date.now
  const keys = o.tokens.map((t) => Buffer.from(t))
  const tasks = new Map<string, Task>()
  const waiting: Task[] = []
  let running: Task | undefined
  let lastActivity = now()
  let host = ''
  let url = ''

  const card = (): Json => ({
    name: skill.name, description: skill.description,
    version: o.version,
    supportedInterfaces: [{ url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    capabilities: {
      streaming: true, pushNotifications: false,
      extensions: [{ uri: skill.extension.uri, description: skill.extension.description, required: false, params: skill.extension.params() }],
    },
    securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    defaultInputModes: skill.modes.input, defaultOutputModes: skill.modes.output,
    skills: [{ id: skill.name, name: skill.name, ...skill.entry }],
  })

  const view = (t: Task): Json => ({ id: t.id, contextId: t.contextId, status: t.status, ...(t.artifact ? { artifacts: [t.artifact] } : {}) })

  function setState(t: Task, state: State, text?: string, data?: Json): void {
    const message = text === undefined ? undefined : {
      messageId: randomUUID(), role: 'ROLE_AGENT', taskId: t.id, contextId: t.contextId,
      parts: [{ text }, ...(data ? [{ data, mediaType: 'application/json' }] : [])],
    }
    t.status = { state, ...(message ? { message } : {}), timestamp: new Date().toISOString() }
    const events: Json[] = [{ statusUpdate: { taskId: t.id, contextId: t.contextId, status: t.status } }]
    if (state === S.completed) events.unshift({ artifactUpdate: { taskId: t.id, contextId: t.contextId, artifact: t.artifact, lastChunk: true } })
    const end = TERMINAL.has(state)
    for (const listener of t.listeners) listener(events, end)
    if (!end) return
    t.listeners.clear()
    t.settle()
    for (const [id, old] of tasks) if (tasks.size > KEEP && TERMINAL.has(old.status.state)) tasks.delete(id)
  }

  const note = (t: Task, code: number, status: string, reason: string): void =>
    o.log?.({ taskId: t.id, ...t.log, code, status, reason, ms: { queued: (t.startedAt || now()) - t.submittedAt } })

  function refuse(t: Task, code: 11 | 12, reason: string): void {
    const status = code === 12 ? 'busy' : 'rejected'
    note(t, code, status, reason)
    setState(t, S.rejected, `${status}: ${reason}`, { code, status, reason, ...(code === 12 ? { retryAfterMs: RETRY_AFTER_MS } : {}) })
  }

  function finish(t: Task, result: R | undefined): void {
    if (running === t) running = undefined
    lastActivity = now()
    if (!TERMINAL.has(t.status.state)) {
      if (!result) {
        note(t, 13, 'failed', 'internal')
        setState(t, S.failed, 'failed: internal', { code: 13, status: 'failed', reason: 'internal' })
      } else {
        const { content, data } = skill.outcome(result)
        if (content) {
          t.artifact = { artifactId: randomUUID(), name: skill.name, parts: [content, { data, mediaType: 'application/json' }] }
          setState(t, S.completed)
        } else {
          const extra = result.code === 12 ? { retryAfterMs: RETRY_AFTER_MS } : {}
          setState(t, result.code === 13 ? S.failed : S.rejected, `${result.status}: ${result.reason ?? ''}`, { ...data, ...extra })
        }
      }
    }
    if (result) {
      try {
        o.budget?.spend(result.ms.model + result.ms.load)
      } catch {
        process.stderr.write('agent-inbox-wrap: budget write failed\n')
      }
    }
    pump()
  }

  // the last resort: a task always reaches a final state and frees its slot
  function fail(t: Task): void {
    try {
      if (running === t) running = undefined
      if (!TERMINAL.has(t.status.state)) setState(t, S.failed, 'failed: internal', { code: 13, status: 'failed', reason: 'internal' })
      pump()
    } catch {}
  }

  function pump(): void {
    const t = running ? undefined : waiting.shift()
    if (!t) return
    running = t
    t.startedAt = now()
    const queuedMs = t.startedAt - t.submittedAt
    const context: RunContext = { taskId: t.id, queuedMs, budgetMs: Math.min(TASK_MS, t.timeoutMs - queuedMs), signal: t.abort.signal }
    skill.run(t.input as I, context, (state) => { if (!TERMINAL.has(t.status.state)) setState(t, S.working, state) }).then((r) => finish(t, r), () => finish(t, undefined)).catch(() => fail(t))
  }

  function admit(t: Task): void {
    if (running && waiting.length) return refuse(t, 12, 'queue-full')
    const wait = running ? Math.max(0, running.estimateMs - (now() - running.startedAt)) : 0
    if (wait + t.estimateMs > t.timeoutMs) return refuse(t, 12, 'wait-too-long')
    let allowed = true
    try {
      allowed = o.budget?.take() ?? true
    } catch {
      process.stderr.write('agent-inbox-wrap: budget write failed\n')
      return refuse(t, 11, 'budget-unavailable')
    }
    if (!allowed) return refuse(t, 11, 'daily-budget')
    waiting.push(t)
    pump()
  }

  function authorize(header: string | undefined): number {
    const presented = /^Bearer ([\x21-\x7E]+)$/.exec(header ?? '')?.[1]
    if (!presented) return -1
    const p = Buffer.from(presented)
    return keys.findIndex((k) => k.length === p.length && timingSafeEqual(k, p))
  }

  const reply = (res: ServerResponse, status: number, body: Json, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }).end(JSON.stringify(body))
  }
  const rpc = (res: ServerResponse, id: unknown, result: Json): void => reply(res, 200, { jsonrpc: '2.0', id, result })
  const rpcError = (res: ServerResponse, id: unknown, code: number, message: string): void => reply(res, 200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } })

  function readBody(req: IncomingMessage): Promise<string | undefined> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > skill.bodyMax) resolve(undefined)
        else chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', () => resolve(undefined))
    })
  }

  async function send(res: ServerResponse, id: unknown, params: Json, owner: number, stream: boolean): Promise<void> {
    const message = obj(params.message)
    const config = obj(params.configuration)
    if (config.taskPushNotificationConfig !== undefined || config.pushNotificationConfig !== undefined) return rpcError(res, id, -32003, 'Push notifications are not supported')
    if (message.taskId !== undefined) return rpcError(res, id, -32004, 'One call is one task: a message cannot continue a task')
    const parts = Array.isArray(message.parts) ? message.parts : []
    const meta = obj(obj(message.metadata)[skill.extension.uri])
    const accepted = message.role === 'ROLE_USER' && parts.length === 1 ? skill.accept(obj(parts[0]), meta) : undefined
    if (!accepted) return rpcError(res, id, -32602, skill.malformed)
    const timeoutMs = meta.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1000 || (timeoutMs as number) > 600_000) return rpcError(res, id, -32602, 'timeoutMs must be an integer from 1000 to 600000')
    let settle = (): void => {}
    const done = new Promise<void>((resolve) => { settle = resolve })
    const t: Task = {
      id: randomUUID(), contextId: typeof message.contextId === 'string' && message.contextId.length <= 128 ? message.contextId : randomUUID(),
      owner, input: 'input' in accepted ? accepted.input : undefined, log: accepted.log, timeoutMs: timeoutMs as number,
      estimateMs: 'input' in accepted ? accepted.estimateMs : 0, submittedAt: now(), startedAt: 0,
      status: { state: S.submitted }, abort: new AbortController(), listeners: new Set(), done, settle,
    }
    tasks.set(t.id, t)
    setState(t, S.submitted, 'waiting')
    if ('refuse' in accepted) refuse(t, 11, accepted.refuse)
    else admit(t)
    if (!stream) {
      if (config.returnImmediately !== true) await t.done
      return rpc(res, id, { task: view(t) })
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
    const write = (events: Json[]): boolean => res.write(events.map((result) => `data: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`).join(''))
    write([{ task: view(t) }])
    if (TERMINAL.has(t.status.state)) return void res.end()
    const listener = (events: Json[], end: boolean): void => {
      write(events)
      if (end) res.end()
    }
    t.listeners.add(listener)
    res.on('close', () => t.listeners.delete(listener))
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.origin !== undefined) return reply(res, 403, { error: 'origin' })
    if (req.headers.host !== host) return reply(res, 403, { error: 'host' })
    if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') {
      // the same exchange as web search's front door, under this skill's own label (#492)
      const nonce = req.headers['a2a-mesh-challenge']
      const proof: Record<string, string> = typeof nonce === 'string' && /^[\w-]{43}$/.test(nonce) && o.tokens[0]
        ? { 'a2a-mesh-proof': createHmac('sha256', o.tokens[0]).update(`${skill.proofLabel}\n${nonce}`).digest('base64url') } : {}
      return reply(res, 200, card(), proof)
    }
    if (req.method !== 'POST' || req.url !== '/') return reply(res, 404, { error: 'not found' })
    const owner = authorize(req.headers.authorization)
    if (owner < 0) return reply(res, 401, { error: 'token' }, { 'www-authenticate': 'Bearer' })
    lastActivity = now()
    if (Number(req.headers['content-length'] ?? 0) > skill.bodyMax) return reply(res, 413, { error: 'too large' }, { connection: 'close' })
    const body = await readBody(req)
    if (body === undefined) return reply(res, 413, { error: 'too large' }, { connection: 'close' })
    let msg: Json
    try {
      msg = obj(JSON.parse(body))
    } catch {
      return rpcError(res, null, -32700, 'Invalid JSON payload')
    }
    const id = typeof msg.id === 'string' || typeof msg.id === 'number' ? msg.id : null
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(res, id, -32600, 'Request payload validation error')
    if (!/^1\.0(?:\.\d+)?$/.test(String(req.headers['a2a-version'] ?? ''))) return rpcError(res, id, -32009, 'A2A-Version 1.0 is required')
    const params = obj(msg.params)
    const t = typeof params.id === 'string' ? tasks.get(params.id) : undefined
    const mine = t && t.owner === owner ? t : undefined
    switch (msg.method) {
      case 'SendMessage':
      case 'SendStreamingMessage':
        return send(res, id, params, owner, msg.method === 'SendStreamingMessage')
      case 'GetTask':
        return mine ? rpc(res, id, view(mine)) : rpcError(res, id, -32001, 'Task not found')
      case 'CancelTask': {
        if (!mine) return rpcError(res, id, -32001, 'Task not found')
        if (TERMINAL.has(mine.status.state)) return rpcError(res, id, -32002, 'Task is not cancelable')
        mine.abort.abort()
        const queued = waiting.indexOf(mine)
        if (queued >= 0) {
          waiting.splice(queued, 1)
          note(mine, 13, 'cancelled', 'cancelled')
        }
        setState(mine, S.canceled, 'cancelled')
        return rpc(res, id, view(mine))
      }
      default:
        return /PushNotificationConfig/.test(msg.method) ? rpcError(res, id, -32003, 'Push notifications are not supported') : rpcError(res, id, -32601, 'Method not found')
    }
  }

  const server = createServer({ requestTimeout: 10_000, headersTimeout: 5_000, maxHeaderSize: 16 * 1024 }, (req, res) => {
    handle(req, res).catch(() => { if (!res.headersSent) reply(res, 500, { error: 'internal' }); else res.end() })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => reject(new ConfigError(`cannot listen on 127.0.0.1:${o.port} (${error.code ?? 'error'})`)))
    server.listen(o.port, o.host, () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  host = `127.0.0.1:${port}`
  url = `http://${host}/`

  return {
    port,
    idleMs: () => (running || waiting.length ? 0 : now() - lastActivity),
    close: async () => {
      for (const t of waiting) note(t, 13, 'failed', 'agent-stopped')
      waiting.length = 0
      for (const t of tasks.values()) {
        if (TERMINAL.has(t.status.state)) continue
        t.abort.abort()
        setState(t, S.failed, 'failed: agent-stopped', { code: 13, status: 'failed', reason: 'agent-stopped' })
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    },
  }
}
