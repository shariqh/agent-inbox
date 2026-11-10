// The unslop agent's A2A server (#483, unslop design §7.2-§7.3, §8.3): a minimal,
// hand-rolled JSON-RPC subset of A2A 1.0 on node:http. 127.0.0.1 only. Every
// request with an Origin header, or a Host other than 127.0.0.1:<port>, is
// refused; every request but the card needs a bearer token. SendMessage,
// SendStreamingMessage (status updates only: the edited text arrives once, with
// COMPLETED), GetTask and CancelTask; no push notifications. One task runs and one
// waits; a task the queue cannot finish within the caller's timeout is refused
// up front as busy. A task belongs to the token that created it. A card request that
// carries an `A2A-Mesh-Challenge` nonce is answered with `A2A-Mesh-Proof` =
// HMAC-SHA256(token, "unslop/v1\n" + nonce) (#492), so the client sends the token and
// the draft only to the process that holds the token; the card itself stays public.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { maxTokens } from './backend.js'
import { ConfigError } from './files.js'
import { parseKind } from './screen.js'
import type { Kind } from './screen.js'
import { TASK_MS } from './unslop.js'
import type { Outcome, UnslopResult, UnslopTask } from './unslop.js'

export const EXTENSION = 'urn:agent-inbox:ext:unslop:v1'
export const DEFAULT_TIMEOUT_MS = 280_000
const BODY_MAX = 64 * 1024
const TOKENS_PER_S = 44
const RETRY_AFTER_MS = 60_000
const KEEP = 64
const S = { submitted: 'TASK_STATE_SUBMITTED', working: 'TASK_STATE_WORKING', completed: 'TASK_STATE_COMPLETED', rejected: 'TASK_STATE_REJECTED', failed: 'TASK_STATE_FAILED', canceled: 'TASK_STATE_CANCELED' } as const
type State = (typeof S)[keyof typeof S]
const TERMINAL = new Set<State>([S.completed, S.rejected, S.failed, S.canceled])

export type RunResult = UnslopResult & { skillStale?: boolean }
export type Refusal = { taskId: string; kind?: Kind; bytesIn: number; code: Outcome; status: string; reason: string; ms: { queued: number } }
export type ServerOptions = {
  host: string
  port: number
  tokens: string[]
  version: string
  rules: () => { rulesSha256: string; bytes: number; loadedAt: string }
  run: (task: UnslopTask, onState: (state: string) => void) => Promise<RunResult>
  budget?: { take(): boolean; spend(modelMs: number): void }
  /** tasks refused or cancelled before the pipeline; the pipeline logs its own */
  log?: (entry: Refusal) => void
  now?: () => number
}
export type A2AServer = { port: number; idleMs(): number; close(): Promise<void> }

type Json = Record<string, unknown>
type Task = {
  id: string; contextId: string; owner: number; text: string; kind: unknown; timeoutMs: number; estimateMs: number
  submittedAt: number; startedAt: number; status: Json & { state: State }; artifact?: Json
  abort: AbortController; listeners: Set<(events: Json[], end: boolean) => void>; done: Promise<void>; settle: () => void
}

const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const estimateMs = (text: string): number => (maxTokens(text) / TOKENS_PER_S) * 1000

export async function startServer(o: ServerOptions): Promise<A2AServer> {
  if (o.host !== '127.0.0.1') throw new ConfigError('the agent binds 127.0.0.1 only')
  const now = o.now ?? Date.now
  const keys = o.tokens.map((t) => Buffer.from(t))
  const tasks = new Map<string, Task>()
  const waiting: Task[] = []
  let running: Task | undefined
  let lastActivity = now()
  let host = ''
  let url = ''

  const card = (): Json => ({
    name: 'unslop', description: 'Copy-edits public text (PR descriptions, issues, release notes, public docs, blog posts) by the unslop rules, with a fidelity check.',
    version: o.version,
    supportedInterfaces: [{ url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    capabilities: {
      streaming: true, pushNotifications: false,
      extensions: [{ uri: EXTENSION, description: 'unslop task parameters and result', required: false, params: { api: 1, skillId: 'unslop', ...o.rules() } }],
    },
    securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain', 'application/json'],
    skills: [{ id: 'unslop', name: 'unslop', description: 'Edit one public text; the result carries the check report.', tags: ['editing'] }],
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

  const note = (t: Task, code: Outcome, status: string, reason: string): void =>
    o.log?.({ taskId: t.id, kind: parseKind(t.kind), bytesIn: Buffer.byteLength(t.text), code, status, reason, ms: { queued: (t.startedAt || now()) - t.submittedAt } })

  function refuse(t: Task, code: 11 | 12, reason: string): void {
    const status = code === 12 ? 'busy' : 'rejected'
    note(t, code, status, reason)
    setState(t, S.rejected, `${status}: ${reason}`, { code, status, reason, ...(code === 12 ? { retryAfterMs: RETRY_AFTER_MS } : {}) })
  }

  function finish(t: Task, result: RunResult | undefined): void {
    if (running === t) running = undefined
    lastActivity = now()
    if (!TERMINAL.has(t.status.state)) {
      if (!result) {
        note(t, 13, 'failed', 'internal')
        setState(t, S.failed, 'failed: internal', { code: 13, status: 'failed', reason: 'internal' })
      } else {
        const { text, ...data } = result
        if (result.code === 0 || result.code === 10) {
          t.artifact = { artifactId: randomUUID(), name: 'unslop', parts: [{ text, mediaType: 'text/plain' }, { data, mediaType: 'application/json' }] }
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
    const task: UnslopTask = { text: t.text, kind: t.kind, taskId: t.id, queuedMs, budgetMs: Math.min(TASK_MS, t.timeoutMs - queuedMs), signal: t.abort.signal }
    o.run(task, (state) => { if (!TERMINAL.has(t.status.state)) setState(t, S.working, state) }).then((r) => finish(t, r), () => finish(t, undefined)).catch(() => fail(t))
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
        if (size > BODY_MAX) resolve(undefined)
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
    const text = obj(parts[0]).text
    if (message.role !== 'ROLE_USER' || parts.length !== 1 || typeof text !== 'string') return rpcError(res, id, -32602, 'Expected one text part from ROLE_USER')
    const meta = obj(obj(message.metadata)[EXTENSION])
    const timeoutMs = meta.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1000 || (timeoutMs as number) > 600_000) return rpcError(res, id, -32602, 'timeoutMs must be an integer from 1000 to 600000')
    let settle = (): void => {}
    const done = new Promise<void>((resolve) => { settle = resolve })
    const t: Task = {
      id: randomUUID(), contextId: typeof message.contextId === 'string' && message.contextId.length <= 128 ? message.contextId : randomUUID(),
      owner, text, kind: meta.kind, timeoutMs: timeoutMs as number, estimateMs: estimateMs(text), submittedAt: now(), startedAt: 0,
      status: { state: S.submitted }, abort: new AbortController(), listeners: new Set(), done, settle,
    }
    tasks.set(t.id, t)
    setState(t, S.submitted, 'waiting')
    admit(t)
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
      // the same exchange as web search's front door, under unslop's own label (#492)
      const nonce = req.headers['a2a-mesh-challenge']
      const proof: Record<string, string> = typeof nonce === 'string' && /^[\w-]{43}$/.test(nonce) && o.tokens[0]
        ? { 'a2a-mesh-proof': createHmac('sha256', o.tokens[0]).update(`unslop/v1\n${nonce}`).digest('base64url') } : {}
      return reply(res, 200, card(), proof)
    }
    if (req.method !== 'POST' || req.url !== '/') return reply(res, 404, { error: 'not found' })
    const owner = authorize(req.headers.authorization)
    if (owner < 0) return reply(res, 401, { error: 'token' }, { 'www-authenticate': 'Bearer' })
    lastActivity = now()
    if (Number(req.headers['content-length'] ?? 0) > BODY_MAX) return reply(res, 413, { error: 'too large' }, { connection: 'close' })
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
