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
// `meshctl call` (#530) proves an added loopback agent with the label `a2a-mesh` and the card
// URL's path, and calls an added tailnet agent through tlsLink: TLS (always verified) and the
// card pin prove that origin instead (D17), so it sends no challenge.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { Agent, request } from 'node:http'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { Agent as TlsAgent, request as tlsRequest } from 'node:https'
import type { LookupFunction } from 'node:net'

export type Reply = { status: number; type: string; body: string }
/** `unproven`: the peer did not prove it holds the token, and nothing but a challenge reached it. */
export type Exchange = Reply | 'refused' | 'error' | 'unproven'
type Request = { method: string; path: string; headers?: Record<string, string>; body?: string; timeoutMs: number; signal?: AbortSignal; onChunk?: (text: string) => void }
type Socket = NonNullable<ClientRequest['socket']>
type Hooks = { gate?: (socket: Socket, req: ClientRequest) => boolean; accept?: (res: IncomingMessage) => boolean }
type Target = { origin: URL; lookup?: LookupFunction }
const CARD_PATH = '/.well-known/agent-card.json'

/** One HTTP exchange with `target` on `pool`; `onChunk` streams a 200 body instead of collecting it. */
function exchange(pool: Agent, { origin, lookup }: Target, o: Request, hooks: Hooks = {}): Promise<Exchange> {
  const tls = origin.protocol === 'https:'
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
    const req = (tls ? tlsRequest : request)({
      host: origin.hostname, port: origin.port || (tls ? 443 : 80), method: o.method, path: o.path, agent: pool, lookup,
      servername: tls ? origin.hostname : undefined, headers: { host: origin.host, ...o.headers },
    }, (res) => {
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

/**
 * A loopback agent's link: the card request carries the challenge, and the proof is
 * base64url(HMAC-SHA256(token, `${label}/v1\n` + nonce)).
 */
export function meshLink(port: number, token: string, label: 'unslop' | 'a2a-mesh', cardPath = CARD_PATH): MeshLink {
  // one connection at a time, so a request waits for the proven one rather than opening another
  const pool = new Agent({ keepAlive: true, maxSockets: 1 })
  const target = { origin: new URL(`http://127.0.0.1:${port}`) }
  const proven = new WeakSet<Socket>()
  const card = (timeoutMs: number, signal?: AbortSignal): Promise<Exchange> => {
    const nonce = randomBytes(32).toString('base64url')
    const want = Buffer.from(createHmac('sha256', token).update(`${label}/v1\n${nonce}`).digest('base64url'))
    return exchange(pool, target, { method: 'GET', path: cardPath, headers: { 'a2a-mesh-challenge': nonce }, timeoutMs, signal }, {
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
      const result = await exchange(pool, target, o, {
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

/**
 * An https agent's link (D17): certificate verification always on, whatever the environment says,
 * no proxy, and the token (when there is one) on every request to `origin` only. `ca` replaces
 * the system roots and `lookup` the DNS: test seams only.
 */
export function tlsLink(origin: URL, token: string | undefined, cardPath: string, { lookup, ca }: { lookup?: LookupFunction; ca?: string } = {}): MeshLink {
  const pool = new TlsAgent({ keepAlive: true, maxSockets: 1, rejectUnauthorized: true, ...(ca === undefined ? {} : { ca }) })
  const target = { origin, lookup }
  return {
    card: (timeoutMs) => exchange(pool, target, { method: 'GET', path: cardPath, headers: { accept: 'application/json' }, timeoutMs }),
    call: (o) => exchange(pool, target, { ...o, headers: { ...o.headers, ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) } }),
    close: () => pool.destroy(),
  }
}

/**
 * A link that sends no token and asks for no proof (`meshctl check`'s live.auth, #538): a probe
 * the agent must refuse. Plain http on loopback, else tlsLink without a token.
 */
export function bareLink(origin: URL, cardPath: string, seams: { lookup?: LookupFunction; ca?: string } = {}): MeshLink {
  if (origin.protocol === 'https:') return tlsLink(origin, undefined, cardPath, seams)
  const pool = new Agent({ keepAlive: false, maxSockets: 1 })
  const target = { origin }
  return {
    card: (timeoutMs) => exchange(pool, target, { method: 'GET', path: cardPath, timeoutMs }),
    call: (o) => exchange(pool, target, o),
    close: () => pool.destroy(),
  }
}
