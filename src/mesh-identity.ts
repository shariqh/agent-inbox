// The identity proof for meshctl's Node-core A2A clients (#492): the exchange web
// search's `identityFetch` uses in packages/mesh (web search design §10.1), for a
// loopback agent at 127.0.0.1:<port>. The card request carries a fresh 256-bit
// `A2A-Mesh-Challenge` nonce and the agent answers `A2A-Mesh-Proof` =
// base64url(HMAC-SHA256(token, "<agent>/v1\n" + nonce)); the label keeps a proof made for
// one agent from passing for another. The token and any request body go out only on a
// keep-alive connection that itself answered the challenge: a request handed any other
// connection sends nothing on it, closes it and proves again first, so a process that
// binds the port after the agent exits gets neither. Node core only; meshctl's clients
// import it, never the stdio MCP server or the viewer.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { Agent, request } from 'node:http'
import type { ClientRequest, IncomingMessage } from 'node:http'

export type Reply = { status: number; type: string; body: string }
/** `unproven`: the peer did not prove it holds the token, and nothing but a challenge reached it. */
export type Exchange = Reply | 'refused' | 'error' | 'unproven'
type Request = { method: string; path: string; headers?: Record<string, string>; body?: string; timeoutMs: number; signal?: AbortSignal; onChunk?: (text: string) => void }
type Socket = NonNullable<ClientRequest['socket']>
type Hooks = { gate?: (socket: Socket, req: ClientRequest) => boolean; accept?: (res: IncomingMessage) => boolean }

/** One HTTP exchange on `pool`; `onChunk` streams a 200 body instead of collecting it. */
function exchange(pool: Agent, port: number, o: Request, hooks: Hooks = {}): Promise<Exchange> {
  return new Promise((done) => {
    let body = ''
    let settled = false
    const finish = (result: Exchange): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      o.signal?.removeEventListener('abort', abort)
      if (typeof result === 'string') req.destroy()
      done(result)
    }
    const req = request({ host: '127.0.0.1', port, method: o.method, path: o.path, agent: pool, headers: { host: `127.0.0.1:${port}`, ...o.headers } }, (res) => {
      if (hooks.accept && !hooks.accept(res)) {
        res.destroy()
        return finish('unproven')
      }
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        if (o.onChunk && res.statusCode === 200) o.onChunk(chunk)
        else if (body.length < 1024 * 1024) body += chunk
      })
      res.on('end', () => finish({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body }))
      res.on('error', () => finish('error'))
      res.on('aborted', () => finish('error'))
    })
    const abort = (): void => finish('error')
    const timer = setTimeout(abort, o.timeoutMs)
    o.signal?.addEventListener('abort', abort, { once: true })
    req.on('error', (error: NodeJS.ErrnoException) => finish(error.code === 'ECONNREFUSED' ? 'refused' : 'error'))
    if (!hooks.gate) return void req.end(o.body)
    // headers and body wait for the socket: one the gate refuses is closed with nothing written
    req.once('socket', (socket: Socket) => {
      if (settled) return
      if (hooks.gate!(socket, req)) req.end(o.body)
      else finish('unproven')
    })
  })
}

export interface MeshLink {
  /** GET the card with a fresh challenge; `unproven` when the answer does not prove the token. */
  card(timeoutMs: number): Promise<Exchange>
  /** One request with `Authorization: Bearer <token>`, sent only on a proven connection. */
  call(o: Request): Promise<Exchange>
  close(): void
}

export function meshLink(port: number, token: string, agent: 'unslop'): MeshLink {
  // one connection at a time, so a request waits for the proven one rather than opening another
  const pool = new Agent({ keepAlive: true, maxSockets: 1 })
  const proven = new WeakSet<Socket>()
  const card = (timeoutMs: number, signal?: AbortSignal): Promise<Exchange> => {
    const nonce = randomBytes(32).toString('base64url')
    const want = Buffer.from(createHmac('sha256', token).update(`${agent}/v1\n${nonce}`).digest('base64url'))
    return exchange(pool, port, { method: 'GET', path: '/.well-known/agent-card.json', headers: { 'a2a-mesh-challenge': nonce }, timeoutMs, signal }, {
      accept: (res) => {
        const got = Buffer.from(String(res.headers['a2a-mesh-proof'] ?? ''))
        if (got.length !== want.length || !timingSafeEqual(got, want)) return false
        proven.add(res.socket)
        return true
      },
    })
  }
  const call = async (o: Request): Promise<Exchange> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await exchange(pool, port, o, {
        gate: (socket, req) => {
          if (!proven.has(socket)) return false
          req.setHeader('authorization', `Bearer ${token}`)
          return true
        },
      })
      if (result !== 'unproven') return result
      const again = await card(Math.min(o.timeoutMs, 3000), o.signal)
      if (typeof again === 'string') return again
    }
    return 'unproven'
  }
  return { card: (timeoutMs) => card(timeoutMs), call, close: () => pool.destroy() }
}
