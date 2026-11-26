// The rule for an `agents.<id>` entry `meshctl add` wrote (#529; mesh design §6.7, §8.8): the id
// rule, the endpoint rule's shape and the entry itself. Pure, no I/O, so both meshctl (through
// mesh-add.ts, mesh-call.ts and mesh-check.ts) and the viewer's cards view (src/mesh-agents.ts,
// Agent cards step 1, D6) read an entry by one rule. It moved out of mesh-add.ts so the viewer can
// read an entry without reaching mesh-add.ts's fetch or src/public-address.ts.
import { agentIdRefusal } from './agent-card.js'
import { THUMBPRINT } from './card-signature.js'

/** The agents that ship here, each with its own `mesh.json` shape: `add` never takes their names. */
export const BUILT_IN_AGENTS: readonly string[] = ['unslop', 'unslop-code', 'request-post', 'web-search']

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})

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

export type Place = { url: string; origin: string; loopback: boolean; host: string }

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
// plain segments only: no `.` or `..`, no percent-encoding, query or fragment
const PATH = '(?:/(?!\\.\\.?(?:/|$))[A-Za-z0-9._~-]+)*/?'
const LOOPBACK = new RegExp(`^(http://127\\.0\\.0\\.1:([1-9]\\d{0,4}))${PATH}$`)
const TAILNET = new RegExp(`^(https://(?:${LABEL}\\.){2}ts\\.net(?::([1-9]\\d{0,4}))?)${PATH}$`)
// any https DNS name (#534): lower-case labels and a last label that starts with a letter, so never
// an IP literal (the WHATWG URL parser reads a last label starting with a digit as an IPv4 number)
const NAMED = new RegExp(`^(https://(?:${LABEL}\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?(?::([1-9]\\d{0,4}))?)${PATH}$`)

/**
 * The endpoint rule's shape for added agents (§8.8): `http://127.0.0.1:<port>` or `https://` on a
 * DNS name of at most 253 characters, as written (lower case, no written-out default port), with an
 * optional plain path. Where the name is (this Mac's tailnet or public) is reachOf's question, and
 * whether a public name's addresses are public is publicLookup's (public-address.ts).
 */
export function addedPlace(raw: unknown): Place | { refused: 'rule' } {
  if (typeof raw !== 'string') return { refused: 'rule' }
  const loopback = LOOPBACK.exec(raw)
  const match = loopback ?? NAMED.exec(raw)
  if (!match) return { refused: 'rule' }
  const port = match[2] === undefined ? undefined : Number(match[2])
  // the URL parser rejects some names the shape allows (a malformed punycode label, a port past
  // 65535): those are outside the rule too, refused like any other, never thrown
  let host: string
  try {
    host = new URL(raw).hostname
  } catch {
    return { refused: 'rule' }
  }
  if ((port === undefined || (port <= 65535 && port !== (loopback ? 80 : 443))) && host.length <= 253) return { url: raw, origin: match[1]!, loopback: Boolean(loopback), host }
  return { refused: 'rule' }
}

/** Whether a URL's shape is a `<name>.<tailnet>.ts.net` name, so its entry may be a local one. */
export const tailnetShaped = (url: string): boolean => TAILNET.test(url)

export type AddedEntry = { card: string; endpoint: string; cardSha256: string; tokenFile: string | undefined; agentId: string | undefined; keyThumbprints: string[] | undefined; public: boolean } | 'invalid'

/**
 * An `agents.<id>` value meshctl add wrote (it has a `card`), read back for status, remove, call and
 * the viewer: undefined when it is not one, `invalid` when a field breaks its rule (never echoed).
 * `public: true` (#534) marks an agent added on a public name; only a `<name>.<tailnet>.ts.net` or
 * loopback entry may lack it, and a loopback one may not carry it, so call never takes a public
 * entry for a local one.
 */
export function addedEntry(id: string, value: unknown): AddedEntry | undefined {
  const entry = obj(value)
  if (!('card' in entry)) return undefined
  const card = addedPlace(entry.card)
  const endpoint = addedPlace(entry.endpoint)
  const pin = entry.cardSha256
  const token = entry.tokenFile
  const agentId = entry.agentId
  const keys = entry.keyThumbprints
  const reach = entry.public
  if (reach !== undefined && reach !== true) return 'invalid'
  if (!('refused' in card) && (reach === true ? card.loopback : !card.loopback && !tailnetShaped(card.url))) return 'invalid'
  if (agentId !== undefined && agentIdRefusal(agentId)) return 'invalid'
  if (keys !== undefined && (!Array.isArray(keys) || !keys.length || keys.length > 4 || !keys.every((k) => typeof k === 'string' && THUMBPRINT.test(k)))) return 'invalid'
  if (idRefusal(id) || 'refused' in card || 'refused' in endpoint || card.origin !== endpoint.origin) return 'invalid'
  if (typeof pin !== 'string' || !/^[0-9a-f]{64}$/.test(pin) || (token !== undefined && typeof token !== 'string')) return 'invalid'
  return { card: card.url, endpoint: endpoint.url, cardSha256: pin, tokenFile: token, agentId: agentId as string | undefined, keyThumbprints: keys as string[] | undefined, public: reach === true }
}
