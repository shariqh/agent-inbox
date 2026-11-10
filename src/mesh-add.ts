// `meshctl add` (#529; mesh design §6.7, D13–D17, §8.8): the rules for a card-driven
// `agents.<id>` entry, an A2A agent this repo doesn't ship. The id rule, the endpoint rule
// (loopback, or https on a tailnet name; a public host waits for #534), the card fetch (no
// token, no redirect, no proxy, 64 KiB, one deadline) and the card pin. Node core and the
// card rule only; meshctl imports it, never the stdio MCP server or the viewer.
import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { canonicalCard, checkAddedCard, summarizeCard } from './agent-card.js'

/** The agents that ship here, each with its own `mesh.json` shape: `add` never takes their names. */
export const BUILT_IN_AGENTS: readonly string[] = ['unslop', 'request-post', 'web-search']
export const ADDED_RULE = 'http://127.0.0.1:<port>[/<path>] or https://<name>.<tailnet>.ts.net[:<port>][/<path>]'
const CARD_MAX = 64 * 1024
const DEADLINE_MS = 5_000

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.map(obj) : [])

// a file name (the token copy, later the shim) and a shell word, so a small charset
const ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/

/** Why `id` cannot name an added agent, or undefined. Never echoes an id it refuses. */
export function idRefusal(id: string): string | undefined {
  if (BUILT_IN_AGENTS.includes(id)) return `${id} is a built-in agent: pick another --id (meshctl enable and disable manage ${id})`
  return ID.test(id) ? undefined : 'the id must be 1-40 lower-case letters, digits and inner hyphens'
}

/** The id `add` offers when no `--id` is given: the card's name, lower-cased, runs of anything else as one hyphen. */
export function idFromName(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 40).replace(/-+$/, '')
  return ID.test(id) ? id : undefined
}

export type Place = { url: string; origin: string; loopback: boolean }
type Refused = 'rule' | 'public'

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
// plain segments only: no `.` or `..`, no percent-encoding, query or fragment
const PATH = '(?:/(?!\\.\\.?(?:/|$))[A-Za-z0-9._~-]+)*/?'
const LOOPBACK = new RegExp(`^(http://127\\.0\\.0\\.1:([1-9]\\d{0,4}))${PATH}$`)
const TAILNET = new RegExp(`^(https://(?:${LABEL}\\.){2}ts\\.net(?::([1-9]\\d{0,4}))?)${PATH}$`)

/**
 * The endpoint rule for added agents (§8.8): `http://127.0.0.1:<port>` or `https://` on a
 * `<name>.<tailnet>.ts.net` name, as written (lower case, no written-out default port), with an
 * optional plain path. `public` is an https URL on any other DNS name: refused until TLS
 * identity, the card pin and signatures land (#534, #531, #536).
 */
export function addedPlace(raw: unknown): Place | { refused: Refused } {
  if (typeof raw !== 'string') return { refused: 'rule' }
  const loopback = LOOPBACK.exec(raw)
  const match = loopback ?? TAILNET.exec(raw)
  if (match) {
    const port = match[2] === undefined ? undefined : Number(match[2])
    if (port === undefined || (port <= 65535 && port !== (loopback ? 80 : 443))) return { url: raw, origin: match[1]!, loopback: Boolean(loopback) }
    return { refused: 'rule' }
  }
  let url: URL | undefined
  try {
    url = new URL(raw)
  } catch { /* not a URL */ }
  const host = url?.hostname ?? ''
  const name = /[a-z]/.test(host) && !host.includes(':') && !/(^|\.)(ts\.net|localhost)\.?$/.test(host)
  return { refused: url?.protocol === 'https:' && name ? 'public' : 'rule' }
}

/** Fixed words for a refused URL; never the URL, which can carry a user or a secret. */
export function placeRefusal(what: string, refused: Refused): string {
  return refused === 'public'
    ? `${what} is on a public host: adding one waits for TLS identity, the card pin and card signatures (#534, #531, #536); use ${ADDED_RULE}`
    : `${what} must be ${ADDED_RULE}: never another IP address, localhost, plain http to another host, a written-out port 80 or 443, a user, a query or a fragment`
}

/**
 * The endpoint the client will call (§6.7): the first A2A 1.0 JSON-RPC interface on the card's
 * own origin that passes the rule, so the token only ever goes where the card came from (§8.8).
 */
export function cardEndpoint(card: unknown, origin: string): { endpoint: string } | { refused: string } {
  const rpc = list(obj(card).supportedInterfaces).filter((i) => i.protocolVersion === '1.0' && i.protocolBinding === 'JSONRPC')
  for (const i of rpc) {
    const place = addedPlace(i.url)
    if (!('refused' in place) && place.origin === origin) return { endpoint: place.url }
  }
  const first = addedPlace(rpc[0]?.url)
  return { refused: 'refused' in first ? placeRefusal('the card\'s JSON-RPC interface URL', first.refused) : 'the card\'s JSON-RPC interface is on another origin than the card' }
}

/** One terminal line about a card: summarizeCard's cleaned name and skill ids, tabs and newlines as spaces. */
export function cardLine(card: unknown): string {
  const flat = (text: string | null): string => (text ?? '?').replace(/[\t\n]/g, ' ')
  const { name, skills } = summarizeCard(card)
  return `${flat(name)}, skills ${skills.items.map((s) => flat(s.id)).join(', ')}${skills.more ? ` and ${skills.more} more` : ''}`
}

/** The card pin (`cardSha256`): SHA-256 of canonicalCard's form, as hex. */
export const cardSha256 = (card: unknown): string => createHash('sha256').update(canonicalCard(card)).digest('hex')

export type AddedCard = { card: Json; reason?: undefined } | { card?: undefined; reason: string }

// Fixed words for a failed fetch, never a socket's or parser's message.
function failWords(code: string): string {
  if (code === 'ECONNREFUSED') return 'refused the connection'
  if (code === 'timeout') return `did not answer in ${DEADLINE_MS / 1000} s`
  if (/^(ENOTFOUND|EAI_)/.test(code)) return 'does not resolve (is this Mac on the tailnet?)'
  if (/^(ERR_TLS|ERR_SSL|CERT_|UNABLE_TO|DEPTH_ZERO|SELF_SIGNED|HOSTNAME_MISMATCH)/.test(code)) return 'failed the TLS handshake'
  return 'cut the connection'
}

/**
 * One `GET` of the card URL: `agent: false` (no keep-alive, no proxy), `Host` the URL's
 * authority, no token, cookie or Origin, no redirect, 64 KiB at most, and one wall-clock timer
 * over lookup, connect, TLS, headers and body. The card must pass checkAddedCard.
 */
export function fetchAddedCard(place: Place, timeoutMs = DEADLINE_MS): Promise<AddedCard> {
  const url = new URL(place.url)
  const tls = url.protocol === 'https:'
  return new Promise((done) => {
    let settled = false
    const finish = (result: AddedCard): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      req.destroy()
      done(result)
    }
    const fail = (why: string): void => finish({ reason: `the card URL ${why}` })
    const read = (res: IncomingMessage): void => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400) return fail('redirects, and add follows no redirect')
      if (status !== 200) return fail(`answered HTTP ${status}`)
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        if ((size += chunk.length) > CARD_MAX) fail('sent more than 64 KiB')
        else chunks.push(chunk)
      })
      res.on('end', () => {
        let card: unknown
        try {
          card = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch { /* not JSON */ }
        if (!card || typeof card !== 'object' || Array.isArray(card)) return fail('sent no JSON object')
        const why = checkAddedCard(card)
        if (why) return finish({ reason: `the card has ${why}` })
        try {
          canonicalCard(card)
        } catch {
          return fail('sent a card nested too deeply')
        }
        finish({ card: card as Json })
      })
      res.on('close', () => fail(failWords('cut')))
    }
    const req = (tls ? httpsRequest : httpRequest)({
      host: url.hostname, port: url.port || (tls ? 443 : 80), method: 'GET', path: url.pathname,
      agent: false, servername: tls ? url.hostname : undefined,
      headers: { host: url.host, accept: 'application/json' },
    }, read)
    req.on('error', (error: NodeJS.ErrnoException) => fail(failWords(error.code ?? 'error')))
    const timer = setTimeout(() => fail(failWords('timeout')), timeoutMs)
    req.end()
  })
}

export type AddedEntry = { endpoint: string; cardSha256: string; tokenFile: string | undefined } | 'invalid'

/**
 * An `agents.<id>` value meshctl add wrote (it has a `card`), read back for status and remove:
 * undefined when it is not one, `invalid` when a field breaks its rule (never echoed).
 */
export function addedEntry(id: string, value: unknown): AddedEntry | undefined {
  const entry = obj(value)
  if (!('card' in entry)) return undefined
  const card = addedPlace(entry.card)
  const endpoint = addedPlace(entry.endpoint)
  const pin = entry.cardSha256
  const token = entry.tokenFile
  if (idRefusal(id) || 'refused' in card || 'refused' in endpoint || card.origin !== endpoint.origin) return 'invalid'
  if (typeof pin !== 'string' || !/^[0-9a-f]{64}$/.test(pin) || (token !== undefined && typeof token !== 'string')) return 'invalid'
  return { endpoint: endpoint.url, cardSha256: pin, tokenFile: token }
}
