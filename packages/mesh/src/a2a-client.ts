// The SDK client's way in (web search design §3.3, §4.1, §10.1): a fetch for
// `@a2a-js/sdk`'s ClientFactory and DefaultAgentCardResolver that talks only to
// one loopback endpoint, over node:http (no redirects, no environment proxy), and
// releases the token only after the agent proved it holds it: the card request
// carries a fresh nonce and the agent answers HMAC-SHA256(token, "<agent>/v1\n" + nonce).
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { request } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'
import { canonicalizeAgentCard } from '@a2a-js/sdk'
import type { AgentCard } from '@a2a-js/sdk'

export const CARD_PATH = '/.well-known/agent-card.json'
export class IdentityError extends Error {}

export const proofFor = (token: string, nonce: string, agent = 'web-search'): string =>
  createHmac('sha256', token).update(`${agent}/v1\n${nonce}`).digest('base64url')

/** SHA-256 of the card's JCS form without any interface URL, so every copy of one version hashes the same. */
export function cardHash(card: { supportedInterfaces?: Array<Record<string, unknown>> }): string {
  const supportedInterfaces = (card.supportedInterfaces ?? []).map(({ url: _url, ...rest }) => rest)
  return createHash('sha256').update(canonicalizeAgentCard({ ...card, supportedInterfaces } as unknown as AgentCard)).digest('hex')
}

function send(url: URL, method: string, headers: Headers, body: string | undefined, signal?: AbortSignal | null): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers: { ...Object.fromEntries(headers), host: url.host }, signal: signal ?? undefined }, resolve)
    req.on('error', reject)
    req.end(body)
  })
}

export function identityFetch(o: { token: string; endpoint: string; agent?: string }): typeof fetch {
  const base = new URL(o.endpoint)
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || !base.port || base.pathname !== '/' || base.search || base.username) {
    throw new IdentityError('the endpoint must be http://127.0.0.1:<port>')
  }
  let proven = false
  return async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    const card = url.pathname === CARD_PATH
    if (url.origin !== base.origin || url.search || url.hash || url.username || url.password || !(card || url.pathname === '/')) {
      throw new IdentityError('refused: a URL outside the configured endpoint')
    }
    if (!card && !proven) throw new IdentityError('refused: the agent has not proven its identity')
    if (init.body != null && typeof init.body !== 'string') throw new IdentityError('refused: a body that is not text')
    const headers = new Headers(init.headers)
    headers.delete('authorization')
    const nonce = randomBytes(32).toString('base64url')
    if (card) headers.set('a2a-mesh-challenge', nonce)
    else headers.set('authorization', `Bearer ${o.token}`)
    const res = await send(url, init.method ?? 'GET', headers, init.body ?? undefined, init.signal)
    const status = res.statusCode ?? 0
    if (status >= 300 && status < 400) {
      res.destroy()
      throw new IdentityError('refused: a redirect')
    }
    if (card) {
      const got = Buffer.from(String(res.headers['a2a-mesh-proof'] ?? ''))
      const want = Buffer.from(proofFor(o.token, nonce, o.agent))
      proven = got.length === want.length && timingSafeEqual(got, want)
      if (!proven) {
        res.destroy()
        throw new IdentityError('another process holds the agent port')
      }
    }
    const out = new Headers()
    for (let i = 0; i < res.rawHeaders.length; i += 2) out.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!)
    return new Response(status === 204 ? null : (Readable.toWeb(res) as ReadableStream), { status, headers: out })
  }
}

/** The identity-checked card, its hash, and the fetch that proved it. */
export async function resolveCard(endpoint: string, token: string): Promise<{ card: Record<string, unknown>; cardSha256: string; fetch: typeof fetch }> {
  const fetch = identityFetch({ token, endpoint })
  const res = await fetch(new URL(CARD_PATH, endpoint))
  if (!res.ok) throw new IdentityError('the card request failed')
  const card = (await res.json()) as Record<string, unknown>
  return { card, cardSha256: cardHash(card), fetch }
}
