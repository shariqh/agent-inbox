// Issue #412 — a Node-core ACP v1 client: newline-delimited JSON-RPC 2.0 over
// an agent child's stdio. Design:
// docs/superpowers/specs/2026-10-31-driven-sessions-design.md §3.1.
//
// It correlates responses with the requests the driver sent, and nothing else.
// Every frame the agent writes, a response included, is handed to `onFrame` in
// the order it was read, so the driver's one state machine sees updates,
// permission requests and results exactly as they arrived (§4.1, Ordering).
// There are no promises here on purpose: a promise resolves on a later
// microtask, which would let a response overtake an update read before it.
//
// The driver writes only protocol messages to the child's stdin. This module is
// part of the driver's graph only; it never enters the stdio MCP server's.
import type { Readable, Writable } from 'node:stream'

export const ACP_PROTOCOL_VERSION = 1

// A frame longer than this is refused rather than buffered without bound.
const MAX_LINE = 8 * 1024 * 1024

export type JsonRpcId = number | string

export type AcpFrame =
  | { kind: 'notification'; method: string; params: Record<string, unknown> }
  | { kind: 'request'; id: JsonRpcId; method: string; params: Record<string, unknown> }
  | { kind: 'response'; id: number; method: string; params: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } }
  | { kind: 'invalid'; reason: string }

export interface AcpConnection {
  /** Sends a request and returns its id; its response arrives as a frame. */
  request(method: string, params: Record<string, unknown>): number
  notify(method: string, params: Record<string, unknown>): void
  respond(id: JsonRpcId, result: unknown): void
  close(): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function connectAcp(opts: {
  input: Readable
  output: Writable
  onFrame: (frame: AcpFrame) => void
  onClose?: () => void
}): AcpConnection {
  let nextId = 1
  const sent = new Map<number, { method: string; params: Record<string, unknown> }>()
  let buffer = ''
  let closed = false

  const write = (message: Record<string, unknown>): void => {
    if (closed || opts.output.destroyed || !opts.output.writable) return
    opts.output.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }

  const parse = (line: string): AcpFrame => {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      return { kind: 'invalid', reason: 'not JSON' }
    }
    if (!isRecord(message) || message.jsonrpc !== '2.0') return { kind: 'invalid', reason: 'not JSON-RPC 2.0' }
    const params = isRecord(message.params) ? message.params : {}
    if (typeof message.method === 'string') {
      if ('id' in message && (typeof message.id === 'number' || typeof message.id === 'string')) {
        return { kind: 'request', id: message.id, method: message.method, params }
      }
      return { kind: 'notification', method: message.method, params }
    }
    if (typeof message.id === 'number' && sent.has(message.id)) {
      const request = sent.get(message.id)!
      sent.delete(message.id)
      const error = isRecord(message.error)
        ? { code: typeof message.error.code === 'number' ? message.error.code : 0, message: String(message.error.message ?? '') }
        : undefined
      return { kind: 'response', id: message.id, method: request.method, params: request.params, ...(error ? { error } : { result: message.result }) }
    }
    return { kind: 'invalid', reason: 'a response to no request' }
  }

  opts.input.setEncoding('utf8')
  opts.input.on('data', (chunk: string) => {
    buffer += chunk
    for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end).trim()
      buffer = buffer.slice(end + 1)
      if (line) opts.onFrame(parse(line))
    }
    if (buffer.length > MAX_LINE) {
      buffer = ''
      opts.onFrame({ kind: 'invalid', reason: 'a frame over 8 MiB' })
    }
  })
  opts.input.on('close', () => {
    closed = true
    opts.onClose?.()
  })

  return {
    request(method, params) {
      const id = nextId++
      sent.set(id, { method, params })
      write({ id, method, params })
      return id
    },
    notify(method, params) {
      write({ method, params })
    },
    respond(id, result) {
      write({ id, result })
    },
    close() {
      if (closed) return
      closed = true
      opts.output.end()
    },
  }
}
