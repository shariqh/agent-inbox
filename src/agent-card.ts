// The one A2A agent card rule (agent cards view design §4.4): what a card must hold for
// meshctl's unslop and request-post clients to use it. Each client keeps its own exit
// code and wording around the reason. Pure: no imports and no I/O, so the clients and
// the viewer's cards view (src/mesh-agents.ts) apply one rule; the view also shows a card
// through summarizeCard and cardJson. `meshctl add` (#529, src/mesh-add.ts) checks an agent
// this repo doesn't ship with checkAddedCard and pins it through canonicalCard.

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.map(obj) : [])

const EXPECT = {
  unslop: { skills: ['unslop'], extension: 'urn:agent-inbox:ext:unslop:v1' },
  'request-post': { skills: ['request-post', 'request-post-status'], extension: 'urn:agent-inbox:ext:request-post:v1' },
}

/**
 * Why `agent`'s client cannot use `card`, or undefined when it can: every expected skill,
 * an A2A 1.0 JSON-RPC interface, and the agent's extension with `api: 1`, checked in that
 * order. The reason is fixed words, never text from the card.
 */
export function checkCard(card: unknown, agent: keyof typeof EXPECT): string | undefined {
  const c = obj(card)
  const want = EXPECT[agent]
  const skills = list(c.skills).map((s) => s.id)
  for (const skill of want.skills) if (!skills.includes(skill)) return `no ${skill} skill`
  if (!list(c.supportedInterfaces).some((i) => i.protocolVersion === '1.0' && i.protocolBinding === 'JSONRPC')) return 'no A2A 1.0 JSON-RPC interface'
  const ext = list(obj(c.capabilities).extensions).find((e) => e.uri === want.extension)
  if (!ext) return `no ${want.extension} extension`
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

// RFC 8785 (JCS) for values JSON.parse returns: keys sorted by UTF-16 code unit, numbers and
// strings as ECMAScript's JSON.stringify writes them. Builds no object, so a "__proto__" key is data.
const jcs = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(jcs).join(',')}]`
  if (v && typeof v === 'object') return members(v as Json, () => true)
  return JSON.stringify(v)
}
const members = (o: Json, keep: (key: string) => boolean, value: (key: string) => string = (key) => jcs(o[key])): string =>
  `{${Object.keys(o).filter(keep).sort().map((key) => `${JSON.stringify(key)}:${value(key)}`).join(',')}}`

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
