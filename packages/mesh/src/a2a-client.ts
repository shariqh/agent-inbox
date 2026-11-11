// The SDK client's way in (web search design §3.3, §4.1, §10.1): a fetch for
// `@a2a-js/sdk`'s ClientFactory and DefaultAgentCardResolver that talks only to
// one loopback endpoint, over node:http (no redirects, no environment proxy), and
// sends the token only on a connection whose peer proved it holds it: the card
// request carries a fresh nonce and the agent answers HMAC-SHA256(token,
// "<agent>/v1\n" + nonce). A new connection is proved again before it carries the token.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { Agent, request } from 'node:http'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'
import { CARD_PATH, proof } from './kit/identity.js'

export { CARD_PATH }
export class IdentityError extends Error {}

// Web search's extension URIs, preferred first (publishable-agent design §6, C7): the card declares
// the Pages URI; the client accepts a card that declares either and sends metadata under that one,
// and the front door reads metadata under either. C10 drops the old URN.
export const WEB_SEARCH_EXTENSION = 'https://shariqh.github.io/agent-inbox/ext/web-search/v1'
export const WEB_SEARCH_EXTENSIONS: readonly string[] = [WEB_SEARCH_EXTENSION, 'urn:agent-inbox:ext:web-search:v1']

export const proofFor = (token: string, nonce: string, agent = 'web-search'): string => proof(token, nonce, `${agent}/v1`)

type Json = Record<string, unknown>
// RFC 8785 (JCS) for values JSON.parse returns; builds no object, so a "__proto__" key is data
const jcs = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(jcs).join(',')}]`
  if (v && typeof v === 'object') return members(v as Json, () => true)
  return JSON.stringify(v)
}
const members = (o: Json, keep: (key: string) => boolean, value: (key: string) => string = (key) => jcs(o[key])): string =>
  `{${Object.keys(o).filter(keep).sort().map((key) => `${JSON.stringify(key)}:${value(key)}`).join(',')}}`

/** The JCS form of the card without `signatures`: what a card signature covers (card-signing.ts). */
export const signedPayload = (card: Json): string => members(card, (key) => key !== 'signatures')

/**
 * The card pin (web search design §4.1, one rule for every agent since #556): SHA-256 of the
 * card's JCS form as received, without `signatures` and every `supportedInterfaces[].url`, so
 * every copy of one version hashes the same. No SDK normalisation: it drops unknown fields and
 * empty values, whose changes would then never move the pin. The root's `canonicalCard`
 * (src/agent-card.ts) holds the same rule; test/agent-card.test.ts pins the two equal.
 */
export function cardHash(card: unknown): string {
  const c = card && typeof card === 'object' && !Array.isArray(card) ? card as Json : {}
  const canonical = members(c, (key) => key !== 'signatures', (key) => {
    const value = c[key]
    if (key !== 'supportedInterfaces' || !Array.isArray(value)) return jcs(value)
    return `[${value.map((i) => (i && typeof i === 'object' && !Array.isArray(i) ? members(i as Json, (k) => k !== 'url') : jcs(i))).join(',')}]`
  })
  return createHash('sha256').update(canonical).digest('hex')
}

type Socket = ClientRequest['socket'] & object
/** One request on the fetch's own keep-alive pool. With `gate`, the body and the token wait for the socket: a socket the gate refuses gets nothing and is closed. */
function send(agent: Agent, url: URL, method: string, headers: Headers, body: string | undefined, signal?: AbortSignal | null, gate?: (socket: Socket, req: ClientRequest) => boolean): Promise<IncomingMessage | 'unproven'> {
  return new Promise((resolve, reject) => {
    const req = request(url, { agent, method, headers: { ...Object.fromEntries(headers), host: url.host }, signal: signal ?? undefined }, resolve)
    req.on('error', reject)
    if (!gate) return void req.end(body)
    req.once('socket', (socket: Socket) => {
      if (gate(socket, req)) return void req.end(body)
      resolve('unproven')
      req.destroy()
    })
  })
}

export function identityFetch(o: { token: string; endpoint: string; agent?: string }): typeof fetch {
  const base = new URL(o.endpoint)
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || !base.port || base.pathname !== '/' || base.search || base.username) {
    throw new IdentityError('the endpoint must be http://127.0.0.1:<port>')
  }
  // The token travels only on a socket that itself answered the challenge: a squatter
  // that binds the port after the agent exits starts with a new socket, never a proven one.
  const pool = new Agent({ keepAlive: true })
  const proven = new WeakSet<Socket>()
  let everProven = false
  const prove = async (headers: Headers = new Headers(), signal?: AbortSignal | null): Promise<IncomingMessage> => {
    const nonce = randomBytes(32).toString('base64url')
    headers.delete('authorization')
    headers.set('a2a-mesh-challenge', nonce)
    const res = (await send(pool, new URL(CARD_PATH, base), 'GET', headers, undefined, signal)) as IncomingMessage
    const got = Buffer.from(String(res.headers['a2a-mesh-proof'] ?? ''))
    const want = Buffer.from(proofFor(o.token, nonce, o.agent))
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      res.destroy()
      throw new IdentityError('another process holds the agent port')
    }
    proven.add(res.socket as Socket)
    everProven = true
    return res
  }
  const wrap = (res: IncomingMessage): Response => {
    const status = res.statusCode ?? 0
    if (status >= 300 && status < 400) {
      res.destroy()
      throw new IdentityError('refused: a redirect')
    }
    const out = new Headers()
    for (let i = 0; i < res.rawHeaders.length; i += 2) out.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!)
    return new Response(status === 204 ? null : (Readable.toWeb(res) as ReadableStream), { status, headers: out })
  }
  return async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    const card = url.pathname === CARD_PATH
    if (url.origin !== base.origin || url.search || url.hash || url.username || url.password || !(card || url.pathname === '/')) {
      throw new IdentityError('refused: a URL outside the configured endpoint')
    }
    if (!card && !everProven) throw new IdentityError('refused: the agent has not proven its identity')
    if (init.body != null && typeof init.body !== 'string') throw new IdentityError('refused: a body that is not text')
    const headers = new Headers(init.headers)
    if (card) return wrap(await prove(headers, init.signal))
    headers.delete('authorization')
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await send(pool, url, init.method ?? 'GET', headers, init.body ?? undefined, init.signal, (socket, req) => {
        if (!proven.has(socket)) return false
        req.setHeader('authorization', `Bearer ${o.token}`)
        return true
      })
      if (res !== 'unproven') return wrap(res)
      const fresh = await prove(undefined, init.signal)
      // wait until the proven socket is back in the pool, so the retry can be given it
      await new Promise<void>((resolve) => {
        fresh.socket.once('free', resolve).once('close', resolve)
        fresh.resume()
      })
    }
    throw new IdentityError('refused: no proven connection to the agent')
  }
}

/** The web search extension URI `card` declares, the preferred one when it declares both, or undefined. */
export function webSearchExtension(card: unknown): string | undefined {
  const caps = card && typeof card === 'object' ? (card as Json).capabilities : undefined
  const exts = caps && typeof caps === 'object' ? (caps as Json).extensions : undefined
  const uris = Array.isArray(exts) ? exts.map((e) => (e && typeof e === 'object' ? (e as Json).uri : undefined)) : []
  return WEB_SEARCH_EXTENSIONS.find((uri) => uris.includes(uri))
}

/** The identity-checked card, its hash, the web search extension URI it declares (metadata goes under it), and the fetch that proved it. */
export async function resolveCard(endpoint: string, token: string): Promise<{ card: Record<string, unknown>; cardSha256: string; extension: string | undefined; fetch: typeof fetch }> {
  const fetch = identityFetch({ token, endpoint })
  const res = await fetch(new URL(CARD_PATH, endpoint))
  if (!res.ok) throw new IdentityError('the card request failed')
  const card = (await res.json()) as Record<string, unknown>
  return { card, cardSha256: cardHash(card), extension: webSearchExtension(card), fetch }
}
