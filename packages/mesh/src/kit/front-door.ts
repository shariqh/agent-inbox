// The front door every kit agent serves A2A behind (web search design §3.2; docs/agent-kit.md):
// node:http on 127.0.0.1, every refusal ours, then `@a2a-js/sdk`'s JsonRpcTransportHandler over
// its DefaultRequestHandler. Any Origin, a Host other than 127.0.0.1:<port>, a missing or wrong
// bearer token, an A2A-Version other than 1.0 or 1.0.<n>, a body over 16 KiB or one not received
// within 10 s (checked every second), never reach the SDK, and at most 16 connections are open at
// once. The JSON-RPC request is rebuilt from an allowlist in camelCase: any other key, at any
// level and in either spelling, is refused with -32602 and any other method with -32601, so the SDK's
// snake_case aliases, `tenant`, continuations and push configs are unreachable. No Task response
// carries `history`: the task store keeps none, and sends and GetTask also ask for none with the
// one field the front door adds, `historyLength: 0`. Message metadata is accepted only under the
// agent's own extension URIs (at most one key), checked field by field against its schema, and
// handed to the SDK under the preferred URI. The card is serialised once, at start, and served
// as those exact bytes with the identity proof under the agent's label.
import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AgentCard } from '@a2a-js/sdk'
import { DefaultRequestHandler, JsonRpcTransportHandler, ServerCallContext } from '@a2a-js/sdk/server'
import type { AgentExecutor } from '@a2a-js/sdk/server'
import { ConfigError } from '../files.js'
import { CARD_PATH, MESH_PROOF_LABEL, proofHeaders } from './identity.js'
import { OwnedTaskStore } from './task-store.js'

const BODY_MAX = 16 * 1024
const METHODS = ['SendMessage', 'SendStreamingMessage', 'GetTask', 'CancelTask']
export const MAX_CONNECTIONS = 16

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const only = (v: unknown, keys: readonly string[]): v is Json => isObj(v) && Object.keys(v).every((k) => keys.includes(k))
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length >= 1 && v.length <= max
const texts = (v: unknown, max: number): v is string[] => Array.isArray(v) && v.length <= max && v.every((s) => text(s, 253))
const int = (v: unknown, min: number, max: number): boolean => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max

/**
 * What a request may carry beyond one text part: the agent's extension URIs, preferred first
 * (none: no metadata at all), and one check per metadata field. A field without a check is refused.
 */
export type RequestSpec = { extensions: readonly string[]; metadata: Record<string, (v: unknown) => boolean> }

/** A new request holding only allowed fields, or undefined to refuse it. */
export function rebuildRequest(body: unknown, spec: RequestSpec): Json | undefined {
  if (!only(body, ['jsonrpc', 'id', 'method', 'params']) || body.jsonrpc !== '2.0') return
  const { id, method, params } = body
  if (!text(id, 128) && !int(id, 0, Number.MAX_SAFE_INTEGER)) return
  // historyLength 0 is ours alone; the store keeps no history either, so CancelTask (which has no such field) echoes nothing
  if (method === 'GetTask' || method === 'CancelTask') return only(params, ['id']) && text(params.id, 128) ? { jsonrpc: '2.0', id, method, params: { id: params.id, ...(method === 'GetTask' ? { historyLength: 0 } : {}) } } : undefined
  if ((method !== 'SendMessage' && method !== 'SendStreamingMessage') || !only(params, ['message', 'configuration'])) return
  const { message: m, configuration: c = {} } = params
  if (!only(m, ['messageId', 'role', 'parts', 'metadata']) || !text(m.messageId, 128) || m.role !== 'ROLE_USER') return
  const part: unknown = Array.isArray(m.parts) && m.parts.length === 1 ? m.parts[0] : undefined
  if (!only(part, ['text', 'mediaType']) || typeof part.text !== 'string' || (part.mediaType !== undefined && part.mediaType !== 'text/plain')) return
  const preferred = spec.extensions[0]
  const meta = m.metadata ?? {}
  // at most one key, under any of the agent's URIs; two at once is ambiguous and refused
  const keys = isObj(meta) ? Object.keys(meta) : []
  const ext = isObj(meta) && keys.length <= 1 ? (meta[keys[0] ?? preferred ?? ''] ?? {}) : undefined
  if (!only(meta, spec.extensions) || !only(ext, Object.keys(spec.metadata)) || !Object.entries(ext).every(([k, v]) => spec.metadata[k]!(v))) return
  if (!only(c, ['returnImmediately', 'acceptedOutputModes']) || (c.returnImmediately !== undefined && c.returnImmediately !== false)) return
  if (c.acceptedOutputModes !== undefined && !texts(c.acceptedOutputModes, 8)) return
  const metadata = m.metadata === undefined || preferred === undefined ? {} : { metadata: { [preferred]: structuredClone(ext) } }
  const configuration = { historyLength: 0, ...(c.acceptedOutputModes === undefined ? {} : { acceptedOutputModes: [...c.acceptedOutputModes] }) }
  return { jsonrpc: '2.0', id, method, params: { message: { messageId: m.messageId, role: 'ROLE_USER', parts: [{ text: part.text, mediaType: 'text/plain' }], ...metadata }, configuration } }
}

export type FrontDoorOptions = {
  port: number
  /** Each caller's bearer token; the first also answers the identity challenge. */
  tokens: string[]
  /** The card for the bound URL, built once at start: the bytes served are exactly these. */
  card: (url: string) => Json
  executor: AgentExecutor
  busy: () => boolean
  now?: () => number
  /** Defaults to no extension and no metadata. */
  request?: RequestSpec
  /** The identity proof's label; `a2a-mesh/v1` (the default) is the one `meshctl call` and `check` prove. */
  proofLabel?: string
  /** The error for a method other than the four served: JSON-RPC's -32601 (the default, which `meshctl check` expects), or -32602 as for any other refusal. */
  unknownMethod?: -32601 | -32602
}
export type FrontDoor = { port: number; url: string; idleMs(): number; close(): Promise<void> }

export async function startFrontDoor(o: FrontDoorOptions): Promise<FrontDoor> {
  const now = o.now ?? Date.now
  const spec = o.request ?? { extensions: [], metadata: {} }
  const label = o.proofLabel ?? MESH_PROOF_LABEL
  const keys = o.tokens.map((t) => Buffer.from(t))
  let lastActivity = now()
  let host = ''
  let cardBytes = '{}'
  let transport: JsonRpcTransportHandler | undefined

  const reply = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }).end(typeof body === 'string' ? body : JSON.stringify(body))
  }
  const rpcError = (res: ServerResponse, id: unknown, code: number, message: string): void =>
    reply(res, 200, { jsonrpc: '2.0', id: typeof id === 'string' || typeof id === 'number' ? id : null, error: { code, message } })
  const owner = (header: string | undefined): number => {
    const presented = Buffer.from(/^Bearer ([\x21-\x7E]+)$/.exec(header ?? '')?.[1] ?? '')
    return presented.length ? keys.findIndex((k) => k.length === presented.length && timingSafeEqual(k, presented)) : -1
  }
  const readBody = (req: IncomingMessage): Promise<string | undefined> => new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > BODY_MAX) resolve(undefined)
      else chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(undefined))
    req.on('close', () => resolve(undefined))
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.origin !== undefined) return reply(res, 403, { error: 'origin' })
    if (req.headers.host !== host) return reply(res, 403, { error: 'host' })
    if (req.method === 'GET' && req.url === CARD_PATH) return reply(res, 200, cardBytes, proofHeaders(req.headers['a2a-mesh-challenge'], o.tokens[0]!, label))
    if (req.method !== 'POST' || req.url !== '/') return reply(res, 404, { error: 'not found' })
    const who = owner(req.headers.authorization)
    if (who < 0) return reply(res, 401, { error: 'token' }, { 'www-authenticate': 'Bearer' })
    lastActivity = now()
    if (Number(req.headers['content-length'] ?? 0) > BODY_MAX) return reply(res, 413, { error: 'too large' }, { connection: 'close' })
    const body = await readBody(req)
    if (res.destroyed || res.headersSent) return
    if (body === undefined) return reply(res, 413, { error: 'too large' }, { connection: 'close' })
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return rpcError(res, null, -32700, 'Invalid JSON payload')
    }
    const id = isObj(parsed) ? parsed.id : null
    if (!/^1\.0(?:\.\d+)?$/.test(String(req.headers['a2a-version'] ?? ''))) return rpcError(res, id, -32009, 'A2A-Version 1.0 is required')
    if ((o.unknownMethod ?? -32601) === -32601 && isObj(parsed) && !METHODS.includes(parsed.method as string)) return rpcError(res, id, -32601, 'Method not found')
    const request = rebuildRequest(parsed, spec)
    if (!request || !transport) return rpcError(res, id, -32602, 'Invalid params')
    // the SDK sees version 1.0, the card's, never a patch number
    const context = new ServerCallContext({ user: { isAuthenticated: true, userName: `token-${who}` }, requestedVersion: '1.0' })
    const result = await transport.handle(request, context)
    if (!(Symbol.asyncIterator in result)) return reply(res, 200, result)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
    // drained to the end even after the caller leaves: the SDK records the task's later states only while its stream is read
    try {
      for await (const event of result) if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`)
    } catch {
      if (!res.destroyed) res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'Internal error' } })}\n\n`)
    }
    res.end()
  }

  // Node enforces both timeouts only on its connection sweep, every 30 s by default
  const server = createServer({ requestTimeout: 10_000, headersTimeout: 5_000, connectionsCheckingInterval: 1_000, maxHeaderSize: 16 * 1024 }, (req, res) => {
    handle(req, res).catch(() => { if (!res.headersSent) reply(res, 500, { error: 'internal' }); else res.end() })
  })
  server.maxConnections = MAX_CONNECTIONS
  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => reject(new ConfigError(`cannot listen on 127.0.0.1:${o.port} (${error.code ?? 'error'})`)))
    server.listen(o.port, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  host = `127.0.0.1:${port}`
  const url = `http://${host}/`
  try {
    const card = o.card(url)
    cardBytes = JSON.stringify(card)
    transport = new JsonRpcTransportHandler(new DefaultRequestHandler(AgentCard.fromJSON(card), new OwnedTaskStore(), o.executor))
  } catch (error) {
    server.close()
    throw error
  }
  return {
    port, url,
    idleMs: () => (o.busy() ? 0 : now() - lastActivity),
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    }),
  }
}
