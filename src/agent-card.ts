// The one A2A agent card rule (agent cards view design §4.4): what a card must hold for
// meshctl's unslop and request-post clients to use it. Each client keeps its own exit
// code and wording around the reason. Pure: no imports and no I/O, so the clients and
// the viewer's cards view (src/mesh-agents.ts) apply one rule; the view also shows a card
// through summarizeCard and cardJson. `meshctl add` (#529, src/mesh-add.ts) checks an agent
// this repo doesn't ship with checkAddedCard and pins it through canonicalCard; checkProfile
// reads the profile extension's stable id, keys and per-skill egress and residency (#537, #535,
// publishable-agent design §3.4, §3.7 to §3.9).

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.map(obj) : [])

// Each agent's extension URIs, preferred first. request-post's (C6) and web search's (C7) move to
// the Pages URI (publishable-agent design §6): the client accepts either, and a card that declares
// both is read under the Pages one. C10 drops the old URNs.
const EXPECT = {
  unslop: { skills: ['unslop'], extensions: ['urn:agent-inbox:ext:unslop:v1'] },
  'request-post': {
    skills: ['request-post', 'request-post-status'],
    extensions: ['https://shariqh.github.io/agent-inbox/ext/request-post/v1', 'urn:agent-inbox:ext:request-post:v1'],
  },
  'web-search': {
    skills: ['web-search'],
    extensions: ['https://shariqh.github.io/agent-inbox/ext/web-search/v1', 'urn:agent-inbox:ext:web-search:v1'],
  },
}

const declared = (c: Json, uris: readonly string[]): Json | undefined => {
  const exts = list(obj(c.capabilities).extensions)
  for (const uri of uris) {
    const ext = exts.find((e) => e.uri === uri)
    if (ext) return ext
  }
  return undefined
}

/** The extension URI `card` declares for `agent`, the preferred one when it declares several. */
export function cardExtension(card: unknown, agent: keyof typeof EXPECT): string | undefined {
  const uri = declared(obj(card), EXPECT[agent].extensions)?.uri
  return typeof uri === 'string' ? uri : undefined
}

/**
 * Why `agent`'s client cannot use `card`, or undefined when it can: every expected skill,
 * an A2A 1.0 JSON-RPC interface, and the agent's extension (under its preferred declared URI)
 * with `api: 1`, checked in that order. The reason is fixed words, never text from the card.
 */
export function checkCard(card: unknown, agent: keyof typeof EXPECT): string | undefined {
  const c = obj(card)
  const want = EXPECT[agent]
  const skills = list(c.skills).map((s) => s.id)
  for (const skill of want.skills) if (!skills.includes(skill)) return `no ${skill} skill`
  if (!list(c.supportedInterfaces).some((i) => i.protocolVersion === '1.0' && i.protocolBinding === 'JSONRPC')) return 'no A2A 1.0 JSON-RPC interface'
  const ext = declared(c, want.extensions)
  if (!ext) return `no ${want.extensions.join(' or ')} extension`
  return obj(ext.params).api === 1 ? undefined : `${agent} api is not 1`
}

/**
 * Why an agent this repo doesn't ship cannot be added (`meshctl add`, mesh design §6.7, D13),
 * or undefined: a name, at least one skill and every skill with an id, and an A2A 1.0 JSON-RPC
 * interface, checked in that order. The reason is fixed words, never text from the card.
 */
export function checkAddedCard(card: unknown): string | undefined {
  const c = obj(card)
  if (typeof c.name !== 'string' || !c.name.trim()) return 'no name'
  const skills = list(c.skills)
  if (!skills.length) return 'no skill'
  if (skills.some((s) => typeof s.id !== 'string' || !s.id)) return 'a skill without an id'
  return list(c.supportedInterfaces).some((i) => i.protocolVersion === '1.0' && i.protocolBinding === 'JSONRPC') ? undefined : 'no A2A 1.0 JSON-RPC interface'
}

// The profile extension (publishable-agent design §3.7, D20; spec: docs/ext/profile-v1.md).
const PROFILE_URI = 'https://shariqh.github.io/agent-inbox/ext/profile/v1'
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const SEGMENT = /^[a-z0-9-]+$/
// a lower-case punycode DNS name with at least one dot, at most 253 characters, and a last label
// that starts with a letter: never an IP address, since the URL parser reads a last label that
// starts with a digit (`1`, `0x7f`) as an IPv4 number
const dnsName = (name: string): boolean => {
  const labels = name.split('.')
  return name.length <= 253 && labels.length > 1 && labels.every((l) => DNS_LABEL.test(l)) && /^[a-z]/.test(labels.at(-1)!)
}

/**
 * Why `id` is not a stable agent id (§3.4, D19), or undefined: `<domain>[/<segment>…]/<name>`,
 * a lower-case DNS name with at least one dot and a last label that starts with a letter, segments of
 * `[a-z0-9-]`, a name of 1-40 such characters, 200 characters in all. The character set alone
 * keeps out a scheme, a user, a port, a query and a fragment. Fixed words, never the id.
 */
export function agentIdRefusal(id: unknown): string | undefined {
  if (typeof id !== 'string') return 'a profile id that is not a string'
  if (id.length > 200) return 'a profile id longer than 200 characters'
  if (!/^[a-z0-9./-]+$/.test(id)) return 'a profile id with a character other than a-z, 0-9, "-", "." and "/"'
  const [domain = '', ...path] = id.split('/')
  if (!path.length) return 'a profile id with no /<name> after its domain'
  if (!domain.includes('.')) return 'a profile id whose domain has no dot'
  if (!dnsName(domain)) return 'a profile id whose domain is not a DNS name'
  if (!path.every((s) => SEGMENT.test(s))) return 'a profile id with an empty or dotted path segment'
  return path.at(-1)!.length > 40 ? 'a profile id whose name is longer than 40 characters' : undefined
}

// RFC 7517 public JWKs: the members each curve needs, and nothing else (§3.7)
const CURVES: Record<string, { kty: string; members: string[]; length: number }> = {
  'P-256': { kty: 'EC', members: ['crv', 'kty', 'x', 'y'], length: 43 },
  'P-384': { kty: 'EC', members: ['crv', 'kty', 'x', 'y'], length: 64 },
  Ed25519: { kty: 'OKP', members: ['crv', 'kty', 'x'], length: 43 },
}
const PRIVATE = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k', 'oth']

function keyRefusal(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'a profile key that is not a JWK'
  const key = value as Json
  if (PRIVATE.some((m) => Object.hasOwn(key, m))) return 'a private profile key'
  const curve = typeof key.crv === 'string' && Object.hasOwn(CURVES, key.crv) ? CURVES[key.crv]! : undefined
  if (!curve || key.kty !== curve.kty) return 'a profile key that is not P-256, P-384 or Ed25519'
  if (Object.keys(key).sort().join() !== curve.members.join()) return `a profile key with a member other than ${curve.members.join(', ')}`
  const coordinate = new RegExp(`^[A-Za-z0-9_-]{${curve.length}}$`)
  return curve.members.filter((m) => m === 'x' || m === 'y').every((m) => typeof key[m] === 'string' && coordinate.test(key[m] as string)) ? undefined : 'a profile key with a malformed coordinate'
}

// "", [], {} or null anywhere, which A2A signers drop (§3.10); a walk that stops at 32 levels
function emptyRefusal(v: unknown, depth = 0): string | undefined {
  if (depth > 32) return 'a profile nested too deeply'
  if (v === null || v === '') return 'a profile with an empty value'
  if (typeof v !== 'object') return undefined
  const values = Array.isArray(v) ? v : Object.values(v as Json)
  if (!values.length) return 'a profile with an empty value'
  for (const x of values) {
    const why = emptyRefusal(x, depth + 1)
    if (why) return why
  }
  return undefined
}

// Declared egress (§3.8, #535) and residency (§3.9, #550): closed lists in v1
const PURPOSES = ['model', 'search', 'storage', 'web', 'api', 'agent'] as const
const SENDS = ['input', 'metadata'] as const
const RESIDENCIES = ['caller-host', 'caller-mesh', 'any'] as const
export type Egress = { purpose: (typeof PURPOSES)[number]; hosts: string[] | 'operator' | 'any'; sends: (typeof SENDS)[number] }
export type Residency = (typeof RESIDENCIES)[number]
export type SkillProfile = { egress?: 'none' | Egress[]; residency?: Residency }

const isIn = <T extends string>(values: readonly T[], v: unknown): v is T => typeof v === 'string' && (values as readonly string[]).includes(v)

/**
 * Why a skill's `egress` breaks profile v1 (§3.8), or undefined: `"none"`, or 1-8 entries of exactly
 * `purpose` (a closed list), `hosts` (`"operator"`, `"any"`, or 1-8 lower-case punycode DNS names,
 * each with at most a leading `*.` before a name that still has a dot) and `sends`. Fixed words.
 */
export function egressRefusal(v: unknown): string | undefined {
  if (v === 'none') return undefined
  if (!Array.isArray(v) || !v.length) return 'a profile egress that is neither "none" nor a list of entries'
  if (v.length > 8) return 'more than 8 profile egress entries for a skill'
  for (const entry of v) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'a profile egress entry that is not an object'
    if (Object.keys(entry).sort().join() !== 'hosts,purpose,sends') return 'a profile egress entry whose members are not exactly purpose, hosts and sends'
    const e = entry as Json
    if (!isIn(PURPOSES, e.purpose)) return `a profile egress purpose other than ${PURPOSES.join(', ')}`
    if (!isIn(SENDS, e.sends)) return 'a profile egress sends other than input and metadata'
    if (e.hosts === 'operator' || e.hosts === 'any') continue
    if (!Array.isArray(e.hosts) || !e.hosts.length) return 'profile egress hosts that are neither "operator", "any" nor a list of hosts'
    if (e.hosts.length > 8) return 'more than 8 hosts in a profile egress entry'
    if (!e.hosts.every((h) => typeof h === 'string' && dnsName(h.startsWith('*.') ? h.slice(2) : h) && h.length <= 253)) return 'a profile egress host that is not a lower-case DNS name'
  }
  return undefined
}

/** Why a skill's `residency` breaks profile v1 (§3.9), or undefined. Fixed words. */
export const residencyRefusal = (v: unknown): string | undefined =>
  isIn(RESIDENCIES, v) ? undefined : `a profile residency other than ${RESIDENCIES.join(', ')}`

export type Profile = { id: string; keys: number; skills: Map<string, SkillProfile> }

/**
 * The card's profile extension (§3.7): undefined when the card has none, else its id, how many
 * keys it lists and each skill's declared egress and residency, or why its params break v1: only
 * `id` (required), `keys` (1-4 public JWKs, none twice) and `skills` (exactly the card's skill ids,
 * each an object holding only `egress` and `residency`, whose values pass egressRefusal and
 * residencyRefusal, #535), and no empty value. The reason is fixed words, never text from the card.
 */
export function checkProfile(card: unknown): { profile: Profile } | { reason: string } | undefined {
  const c = obj(card)
  const found = list(obj(c.capabilities).extensions).filter((e) => e.uri === PROFILE_URI)
  if (!found.length) return undefined
  if (found.length > 1) return { reason: 'more than one profile extension' }
  const raw = found[0]!.params
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { reason: 'a profile extension whose params are not an object' }
  const params = raw as Json
  if (Object.keys(params).some((k) => !['id', 'keys', 'skills'].includes(k))) return { reason: 'a profile with a member other than id, keys and skills' }
  const empty = emptyRefusal(params)
  if (empty) return { reason: empty }
  if (!Object.hasOwn(params, 'id')) return { reason: 'a profile without an id' }
  const idWhy = agentIdRefusal(params.id)
  if (idWhy) return { reason: idWhy }
  let keys = 0
  if (Object.hasOwn(params, 'keys')) {
    if (!Array.isArray(params.keys)) return { reason: 'profile keys that are not a list' }
    if (params.keys.length > 4) return { reason: 'more than 4 profile keys' }
    for (const key of params.keys) {
      const why = keyRefusal(key)
      if (why) return { reason: why }
    }
    if (new Set(params.keys.map((k) => jcs(k))).size !== params.keys.length) return { reason: 'a profile key listed twice' }
    keys = params.keys.length
  }
  const declared = new Map<string, SkillProfile>()
  if (Object.hasOwn(params, 'skills')) {
    const skills = params.skills
    if (!skills || typeof skills !== 'object' || Array.isArray(skills)) return { reason: 'profile skills that are not an object' }
    const ids = list(c.skills).map((s) => s.id)
    const named = Object.keys(skills)
    if (ids.some((id) => typeof id === 'string' && !named.includes(id))) return { reason: 'a skill without a profile entry' }
    if (named.some((id) => !ids.includes(id))) return { reason: 'a profile entry for a skill the card lacks' }
    for (const [id, entry] of Object.entries(skills as Json)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { reason: 'a profile skill entry that is not an object' }
      if (Object.keys(entry).some((k) => k !== 'egress' && k !== 'residency')) return { reason: 'a profile skill entry with a member other than egress and residency' }
      const e = entry as Json
      const why = (Object.hasOwn(e, 'egress') ? egressRefusal(e.egress) : undefined) ?? (Object.hasOwn(e, 'residency') ? residencyRefusal(e.residency) : undefined)
      if (why) return { reason: why }
      declared.set(id, e as SkillProfile)
    }
  }
  return { profile: { id: params.id as string, keys, skills: declared } }
}

// RFC 8785 (JCS) for values JSON.parse returns: keys sorted by UTF-16 code unit, numbers and
// strings as ECMAScript's JSON.stringify writes them. Builds no object, so a "__proto__" key is data.
const jcs = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(jcs).join(',')}]`
  if (v && typeof v === 'object') return members(v as Json, () => true)
  return JSON.stringify(v)
}
const members = (o: Json, keep: (key: string) => boolean, value: (key: string) => string = (key) => jcs(o[key])): string =>
  `{${Object.keys(o).filter(keep).sort().map((key) => `${JSON.stringify(key)}:${value(key)}`).join(',')}}`

/** The JCS form of the card without `signatures`: what a card signature covers (publishable-agent design §3.10). */
export const signedPayload = (card: unknown): string => members(obj(card), (key) => key !== 'signatures')

/**
 * The card pin's input (mesh design §6.7, web search design §4.1): the card's JCS form without
 * `signatures` and without every `supportedInterfaces[].url`, so the per-copy URL never changes
 * the pin. Throws only on a card nested past the stack's depth.
 */
export function canonicalCard(card: unknown): string {
  const c = obj(card)
  return members(c, (key) => key !== 'signatures', (key) => {
    const value = c[key]
    if (key !== 'supportedInterfaces' || !Array.isArray(value)) return jcs(value)
    return `[${value.map((i) => (i && typeof i === 'object' && !Array.isArray(i) ? members(i as Json, (k) => k !== 'url') : jcs(i))).join(',')}]`
  })
}

// §4.4: what a card string never carries to the page: C0 controls but tab and newline, DEL,
// C1, the bidirectional marks, overrides and isolates, and the line and paragraph separators.
const UNSAFE = /[\x00-\x08\x0B-\x1F\x7F-\x9F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\u2028\u2029]/g
// the same list less the C0 controls, which JSON.stringify already escapes
const RAW = /[\x7F-\x9F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\u2028\u2029]/g

const text = (v: unknown, cap: number): string | null => {
  if (typeof v !== 'string') return null
  const chars = [...v.replace(UNSAFE, '\uFFFD')]
  return chars.length > cap ? `${chars.slice(0, cap).join('')}…` : chars.join('')
}
// The terminal's wider list (agent-result.ts's, D16): every control, format and default-ignorable
// character, the tag characters and the line and paragraph separators
const HIDDEN = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029\u{E0000}-\u{E007F}]/gu

/**
 * Card text for one terminal line, as a quoted claim (publishable-agent design §4): tabs and
 * newlines as spaces, every other invisible character as U+FFFD, at most `cap` characters (a cut
 * value ends in `…`), `\` and `"` escaped, inside `"…"`. Undefined when the value is not a string.
 */
export function claim(v: unknown, cap: number): string | undefined {
  if (typeof v !== 'string') return undefined
  const chars = [...v.replace(/[\t\n]/g, ' ').replace(HIDDEN, '\uFFFD')]
  const cut = chars.length > cap ? `${chars.slice(0, cap).join('')}…` : chars.join('')
  return `"${cut.replace(/[\\"]/g, (ch) => `\\${ch}`)}"`
}
const capped = <T>(all: T[], max: number) => ({ items: all.slice(0, max), more: Math.max(0, all.length - max) })
const texts = (v: unknown, cap: number, max: number) =>
  capped((Array.isArray(v) ? v : []).map((t) => text(t, cap)).filter((t) => t !== null), max)
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
const param = (v: unknown): string | null => {
  if (Array.isArray(v)) return text(`${v.slice(0, 8).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ')}${v.length > 8 ? ` +${v.length - 8}` : ''}`, 200)
  return text(v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v), 200)
}

/** The bounded, cleaned view of a card the page gets (§2.3, §4.4); nothing else from the card reaches it. */
export function summarizeCard(card: unknown) {
  const c = obj(card)
  const caps = obj(c.capabilities)
  return {
    name: text(c.name, 80),
    description: text(c.description, 500),
    version: text(c.version, 80),
    interfaces: capped(list(c.supportedInterfaces).map((i) => ({
      url: text(i.url, 200), binding: text(i.protocolBinding, 40), protocolVersion: text(i.protocolVersion, 40),
    })), 8),
    streaming: bool(caps.streaming),
    pushNotifications: bool(caps.pushNotifications),
    auth: {
      schemes: capped(Object.entries(obj(c.securitySchemes)).map(([name, scheme]) => {
        const [type, detail] = Object.entries(obj(scheme))[0] ?? []
        return { name: text(name, 80), type: text(type, 80), scheme: text(obj(detail).scheme, 80) }
      }), 8),
      required: list(c.securityRequirements).length > 0,
    },
    extensions: capped(list(caps.extensions).map((e) => ({
      uri: text(e.uri, 200), required: e.required === true,
      params: capped(Object.entries(obj(e.params)).map(([key, value]) => [text(key, 80), param(value)]), 16),
    })), 8),
    skills: capped(list(c.skills).map((s) => ({
      id: text(s.id, 80), name: text(s.name, 80), description: text(s.description, 300), tags: texts(s.tags, 40, 8),
    })), 16),
    inputModes: texts(c.defaultInputModes, 80, 8),
    outputModes: texts(c.defaultOutputModes, 80, 8),
  }
}

/** The card as received, two-space JSON, with every §4.4 character JSON leaves raw written as a \u escape. */
export function cardJson(card: unknown): string {
  return JSON.stringify(card, null, 2).replace(RAW, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)
}
