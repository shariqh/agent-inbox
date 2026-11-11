// The one A2A card rule (agent cards view design §4.4, slice V1). Both cards that ship
// today pass: request-post's R1 fixture and unslop's card as its agent serves it (the
// agent's own source, so a change to that card that this rule rejects fails here). Each
// rule fails with its fixed reason, checked in order. V2's summarizeCard and cardJson are
// the bounded, cleaned views the viewer sends the page. The clients' exit codes and words
// around these reasons are pinned in test/unslop-client.test.ts and
// test/request-post-client.test.ts.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startServer } from '../packages/mesh/src/a2a.js'
import type { A2AServer } from '../packages/mesh/src/a2a.js'
import { cardHash as meshCardHash } from '../packages/mesh/src/a2a-client.js'
import { agentIdRefusal, canonicalCard, cardExtension, cardJson, checkAddedCard, checkCard, checkProfile, claim, summarizeCard } from '../src/agent-card.js'
import { cardSha256 } from '../src/mesh-add.js'
import { cardHash as fixtureCardHash } from './fixtures/a2a-web-search/conformance.js'

type Json = Record<string, any>
const REPO = new URL('..', import.meta.url).pathname
const REQUEST_POST: Json = JSON.parse(readFileSync(join(REPO, 'test', 'fixtures', 'a2a-request-post', 'card.json'), 'utf8'))
const WEB_SEARCH_DIR = join(REPO, 'test', 'fixtures', 'a2a-web-search')
const WEB_SEARCH: Json = JSON.parse(readFileSync(join(WEB_SEARCH_DIR, 'card.json'), 'utf8'))
const UNSLOP_EXT = 'urn:agent-inbox:ext:unslop:v1'
const REQUEST_POST_EXT = 'urn:agent-inbox:ext:request-post:v1'
const REQUEST_POST_PAGES = 'https://shariqh.github.io/agent-inbox/ext/request-post/v1'

let agent: A2AServer
let UNSLOP: Json
beforeAll(async () => {
  agent = await startServer({
    host: '127.0.0.1', port: 0, tokens: ['a1'.repeat(32)], version: '0.0.0-test',
    rules: () => ({ rulesSha256: '0'.repeat(64), bytes: 1, loadedAt: new Date(0).toISOString() }), run: () => new Promise(() => {}),
  })
  const res = await fetch(`http://127.0.0.1:${agent.port}/.well-known/agent-card.json`)
  UNSLOP = await res.json() as Json
})
afterAll(() => agent?.close())

const change = (card: Json, edit: (c: Json) => void): Json => {
  const copy = structuredClone(card)
  edit(copy)
  return copy
}

describe('checkCard (agent cards view design §4.4)', () => {
  it('passes the cards the agents serve', () => {
    expect(UNSLOP.name).toBe('unslop')
    expect(checkCard(UNSLOP, 'unslop')).toBeUndefined()
    expect(checkCard(REQUEST_POST, 'request-post')).toBeUndefined()
    expect(checkCard(WEB_SEARCH, 'web-search')).toBeUndefined()
  })

  it('web search: the Pages URI its card declares, the old URN, or both, the Pages one read (publishable-agent design §6, C7)', () => {
    const [PAGES, URN] = ['https://shariqh.github.io/agent-inbox/ext/web-search/v1', 'urn:agent-inbox:ext:web-search:v1']
    expect(cardExtension(WEB_SEARCH, 'web-search')).toBe(PAGES)
    const old = change(WEB_SEARCH, (c) => { c.capabilities.extensions[0].uri = URN })
    expect([checkCard(old, 'web-search'), cardExtension(old, 'web-search')]).toEqual([undefined, URN])
    const both = change(old, (c) => { c.capabilities.extensions.push({ uri: PAGES, params: { api: 2 } }) })
    expect([checkCard(both, 'web-search'), cardExtension(both, 'web-search')]).toEqual(['web-search api is not 1', PAGES])
    expect(checkCard(change(WEB_SEARCH, (c) => { c.capabilities.extensions[0].uri = 'urn:other' }), 'web-search')).toBe(`no ${PAGES} or ${URN} extension`)
    expect(checkCard(WEB_SEARCH, 'unslop')).toBe('no unslop skill')
  })

  it('holds each agent to its own skills and extension', () => {
    expect(checkCard(UNSLOP, 'request-post')).toBe('no request-post skill')
    expect(checkCard(REQUEST_POST, 'unslop')).toBe('no unslop skill')
    expect(checkCard(change(UNSLOP, (c) => c.capabilities.extensions[0].uri = REQUEST_POST_EXT), 'unslop')).toBe(`no ${UNSLOP_EXT} extension`)
  })

  it('unslop: each rule fails with its fixed reason, in order', () => {
    const cases: Array<[string, (c: Json) => void]> = [
      ['no unslop skill', (c) => { c.skills = [{ id: 'other' }] }],
      ['no unslop skill', (c) => { c.skills = 'unslop' }],
      ['no A2A 1.0 JSON-RPC interface', (c) => { c.supportedInterfaces[0].protocolVersion = '0.3' }],
      ['no A2A 1.0 JSON-RPC interface', (c) => { c.supportedInterfaces[0].protocolBinding = 'GRPC' }],
      ['no A2A 1.0 JSON-RPC interface', (c) => { c.supportedInterfaces[0].protocolVersion = 1 }],
      [`no ${UNSLOP_EXT} extension`, (c) => { c.capabilities.extensions = [] }],
      [`no ${UNSLOP_EXT} extension`, (c) => { delete c.capabilities }],
      ['unslop api is not 1', (c) => { c.capabilities.extensions[0].params.api = 2 }],
      ['unslop api is not 1', (c) => { c.capabilities.extensions[0].params.api = '1' }],
      ['unslop api is not 1', (c) => { delete c.capabilities.extensions[0].params }],
      // the first failure wins
      ['no unslop skill', (c) => { c.skills = []; c.supportedInterfaces = [] }],
    ]
    for (const [reason, edit] of cases) expect(checkCard(change(UNSLOP, edit), 'unslop'), reason).toBe(reason)
  })

  it('request-post: each rule fails with its fixed reason, in order', () => {
    const cases: Array<[string, (c: Json) => void]> = [
      ['no request-post skill', (c) => { c.skills = c.skills.filter((s: Json) => s.id !== 'request-post') }],
      ['no request-post-status skill', (c) => { c.skills = c.skills.filter((s: Json) => s.id !== 'request-post-status') }],
      ['no request-post skill', (c) => { c.skills = [] }],
      ['no A2A 1.0 JSON-RPC interface', (c) => { c.supportedInterfaces[0].protocolVersion = '0.3' }],
      ['no A2A 1.0 JSON-RPC interface', (c) => { c.supportedInterfaces = [] }],
      [`no ${REQUEST_POST_PAGES} or ${REQUEST_POST_EXT} extension`, (c) => { c.capabilities.extensions[0].uri = UNSLOP_EXT }],
      ['request-post api is not 1', (c) => { c.capabilities.extensions[0].params.api = 2 }],
    ]
    for (const [reason, edit] of cases) expect(checkCard(change(REQUEST_POST, edit), 'request-post'), reason).toBe(reason)
  })

  it('request-post: either extension URI passes; with both, the Pages URI is the one read (publishable-agent design §6, C6, C8)', () => {
    // the fixture card declares the Pages URI since C8; the service's card before its switch, the old URN
    expect(cardExtension(REQUEST_POST, 'request-post')).toBe(REQUEST_POST_PAGES)
    const old = change(REQUEST_POST, (c) => { c.capabilities.extensions[0].uri = REQUEST_POST_EXT })
    expect(checkCard(old, 'request-post')).toBeUndefined()
    expect(cardExtension(old, 'request-post')).toBe(REQUEST_POST_EXT)
    const both = change(old, (c) => { c.capabilities.extensions.push({ uri: REQUEST_POST_PAGES, params: { api: 1 } }) })
    expect(checkCard(both, 'request-post')).toBeUndefined()
    expect(cardExtension(both, 'request-post')).toBe(REQUEST_POST_PAGES)
    const pagesApi2 = change(both, (c) => { c.capabilities.extensions.at(-1).params.api = 2 })
    expect(checkCard(pagesApi2, 'request-post')).toBe('request-post api is not 1')
    expect(cardExtension(change(REQUEST_POST, (c) => { c.capabilities.extensions = [] }), 'request-post')).toBeUndefined()
    expect(checkCard(change(UNSLOP, (c) => { c.capabilities.extensions[0].uri = 'https://shariqh.github.io/agent-inbox/ext/unslop/v1' }), 'unslop')).toBe(`no ${UNSLOP_EXT} extension`)
  })

  it('a later interface or extension may satisfy the rule; only the first extension with the URI counts', () => {
    const extra = change(UNSLOP, (c) => { c.supportedInterfaces.unshift({ protocolBinding: 'GRPC', protocolVersion: '1.0' }) })
    expect(checkCard(extra, 'unslop')).toBeUndefined()
    const twice = change(UNSLOP, (c) => { c.capabilities.extensions.unshift({ uri: UNSLOP_EXT, params: { api: 2 } }) })
    expect(checkCard(twice, 'unslop')).toBe('unslop api is not 1')
  })

  it('anything that is not a card object fails on its first rule', () => {
    for (const card of [undefined, null, '<html>', 42, [UNSLOP]]) expect(checkCard(card, 'unslop')).toBe('no unslop skill')
  })
})

describe('checkAddedCard and canonicalCard (meshctl add, #529; mesh design §6.7)', () => {
  it('passes both shipped cards and fails each rule with its fixed reason, in order', () => {
    expect(checkAddedCard(UNSLOP)).toBeUndefined()
    expect(checkAddedCard(REQUEST_POST)).toBeUndefined()
    const cases: Array<[string, (c: Json) => void]> = [
      ['no name', (c) => { c.name = '  ' }],
      ['no name', (c) => { c.name = 7; c.skills = [] }],
      ['no skill', (c) => { c.skills = 'unslop' }],
      ['a skill without an id', (c) => { c.skills.push({ id: '' }) }],
      ['no A2A 1.0 JSON-RPC interface', (c) => { c.supportedInterfaces[0].protocolBinding = 'GRPC' }],
    ]
    for (const [reason, edit] of cases) expect(checkAddedCard(change(UNSLOP, edit)), reason).toBe(reason)
    for (const card of [undefined, null, '<html>', [UNSLOP]]) expect(checkAddedCard(card)).toBe('no name')
  })

  it('is RFC 8785 JCS without signatures or interface URLs, whatever the key order or URL', () => {
    expect(canonicalCard({ b: [1, 'é', { d: null, c: true }], a: 1e21, '\u20ac': -0, '1': 0.5, signatures: [{ x: 1 }] }))
      .toBe('{"1":0.5,"a":1e+21,"b":[1,"é",{"c":true,"d":null}],"€":0}')
    const moved = change(UNSLOP, (c) => { c.supportedInterfaces[0].url = 'http://127.0.0.1:1/other'; c.signatures = [{ protected: 'p', signature: 's' }] })
    const reordered = Object.fromEntries(Object.entries(UNSLOP).reverse())
    expect(canonicalCard(moved)).toBe(canonicalCard(UNSLOP))
    expect(canonicalCard(reordered)).toBe(canonicalCard(UNSLOP))
    expect(canonicalCard(UNSLOP)).not.toContain('"url"')
    expect(canonicalCard(change(UNSLOP, (c) => { c.version = 'other' }))).not.toBe(canonicalCard(UNSLOP))
    // a "__proto__" key is data, never a prototype
    expect(canonicalCard(JSON.parse('{"__proto__":{"x":1},"name":"n"}'))).toBe('{"__proto__":{"x":1},"name":"n"}')
  })

  // web search design §4.1, amended by #556: one pin rule for every agent, raw JCS, no SDK normalisation
  it('meshctl add, packages/mesh (resolveCard) and the conformance fixtures pin every card the same', () => {
    expect(cardSha256(WEB_SEARCH)).toBe(readFileSync(join(WEB_SEARCH_DIR, 'card.sha256'), 'utf8').trim())
    // values the SDK's normaliser would drop still move the pin
    const empties = (c: Json) => { c.securityRequirements = []; c.capabilities.extensions.push({ uri: 'urn:x', required: false }); c.extra = '' }
    const signed = (c: Json) => { c.signatures = [{ protected: 'p', signature: 's' }]; c.supportedInterfaces[0].url = 'https://elsewhere.tailnet-example.ts.net/a2a' }
    for (const card of [WEB_SEARCH, UNSLOP, REQUEST_POST, change(UNSLOP, empties), change(WEB_SEARCH, empties)]) {
      const pin = cardSha256(card)
      expect([meshCardHash(card), fixtureCardHash(card), cardSha256(change(card, signed))]).toEqual([pin, pin, pin])
    }
    expect(cardSha256(change(UNSLOP, empties))).not.toBe(cardSha256(UNSLOP))
  })
})

describe('summarizeCard and cardJson (agent cards view design §4.4, slice V2)', () => {
  const HOSTILE = '<img src=x>\u0000\u001b\u200e\u200f\u061c\u202e\u2066\u2028\u2029\u007f\u0085\tok\nend'

  it('summarizes the shipped card and keeps markup as text, replacing every listed control', () => {
    const summary = summarizeCard(REQUEST_POST)
    expect(summary).toMatchObject({
      name: 'request-post', version: '0.0.0-fixture', streaming: false, pushNotifications: false,
      interfaces: { items: [{ url: 'https://request-post.tailnet-name.ts.net/', binding: 'JSONRPC', protocolVersion: '1.0' }], more: 0 },
      auth: { schemes: { items: [{ name: 'bearer', type: 'httpAuthSecurityScheme', scheme: 'Bearer' }], more: 0 }, required: true },
      inputModes: { items: ['text/plain'], more: 0 },
    })
    expect(summary.extensions.items[0]!.params.items).toEqual([
      ['api', '1'], ['brands', 'example-brand, second-brand'], ['channels', 'blog, x-thread, x-standalone, linkedin'],
      ['categories', 'example-category, second-category'], ['maxBriefBytes', '8192'],
    ])
    const hostile = summarizeCard({ ...REQUEST_POST, description: HOSTILE })
    expect(hostile.description).toBe(`<img src=x>${'\uFFFD'.repeat(11)}\tok\nend`)
  })

  it('cuts strings and lists to their caps with a count of what it left out', () => {
    const many = (n: number, f: (i: number) => unknown) => Array.from({ length: n }, (_, i) => f(i))
    const big = summarizeCard({
      name: 'n'.repeat(81), description: 'd'.repeat(501),
      skills: many(20, (i) => ({ id: `s${i}`, description: 's'.repeat(301), tags: many(10, () => 't'.repeat(41)) })),
      supportedInterfaces: many(9, () => ({})),
      capabilities: { extensions: many(9, () => ({ params: { list: many(10, (i) => i), nested: { a: 'p'.repeat(300) } } })) },
    })
    expect(big.name).toBe(`${'n'.repeat(80)}…`)
    expect(big.description).toBe(`${'d'.repeat(500)}…`)
    expect([big.skills.items.length, big.skills.more, big.interfaces.more, big.extensions.more]).toEqual([16, 4, 1, 1])
    expect(big.skills.items[0]!.description).toHaveLength(301)
    expect(big.skills.items[0]!.tags).toEqual({ items: Array(8).fill(`${'t'.repeat(40)}…`), more: 2 })
    expect(big.extensions.items[0]!.params.items[0]).toEqual(['list', '0, 1, 2, 3, 4, 5, 6, 7 +2'])
    expect(big.extensions.items[0]!.params.items[1]![1]).toHaveLength(201)
    expect(summarizeCard('<html>')).toMatchObject({ name: null, skills: { items: [], more: 0 } })
  })

  it('cardJson is two-space JSON with every listed character JSON leaves raw escaped', () => {
    const json = cardJson({ description: HOSTILE })
    expect(json).toMatch(/^\{\n  "description": /)
    expect(json).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/)
    for (const escape of ['\\u0000', '\\u001b', '\\u200e', '\\u200f', '\\u061c', '\\u202e', '\\u2066', '\\u2028', '\\u2029', '\\u007f', '\\u0085']) expect(json).toContain(escape)
    expect(JSON.parse(json)).toEqual({ description: HOSTILE })
  })
})

describe('the v1 profile extension and stable agent ids (#537; publishable-agent design §3.4, §3.7)', () => {
  const URI = 'https://shariqh.github.io/agent-inbox/ext/profile/v1'
  const B43 = 'A'.repeat(42) + 'g'
  const P256 = { kty: 'EC', crv: 'P-256', x: B43, y: B43.replace('A', 'B') }
  const params = (): Json => ({
    id: 'shariqh.github.io/agent-inbox/web-search',
    keys: [P256],
    skills: { 'web-search': { egress: [{ purpose: 'search', hosts: 'operator', sends: 'input' }], residency: 'caller-mesh' } },
  })
  // web search's card without the profile it carries since C7
  const BARE = change(WEB_SEARCH, (c) => { c.capabilities.extensions = c.capabilities.extensions.filter((e: Json) => e.uri !== URI); delete c.signatures })
  const profiled = (edit: (p: Json) => void = () => {}): Json => change(BARE, (c) => {
    const p = params()
    edit(p)
    c.capabilities.extensions.push({ uri: URI, description: 'Stable id, signing keys, and per-skill egress and residency', params: p })
  })

  it('reads the id and the key count; a card without the profile has none', () => {
    const skills = new Map([['web-search', params().skills['web-search']]])
    expect(checkProfile(profiled())).toEqual({ profile: { id: 'shariqh.github.io/agent-inbox/web-search', keys: 1, skills } })
    expect(checkProfile(profiled((p) => { delete p.keys; delete p.skills }))).toEqual({ profile: { id: 'shariqh.github.io/agent-inbox/web-search', keys: 0, skills: new Map() } })
    for (const card of [BARE, UNSLOP, {}, null, 'card']) expect(checkProfile(card)).toBeUndefined()
    // request-post's fixture card carries its profile since C8 (publishable-agent design §8)
    expect(checkProfile(REQUEST_POST)).toEqual({ profile: { id: 'shariqh.github.io/agent-inbox/request-post', keys: 1, skills: new Map([
      ['request-post', { egress: [{ purpose: 'storage', hosts: 'operator', sends: 'input' }], residency: 'caller-mesh' }],
      ['request-post-status', { egress: [{ purpose: 'storage', hosts: 'operator', sends: 'metadata' }], residency: 'caller-mesh' }],
    ]) } })
    // an Ed25519 and a P-384 key, four in all
    const keys = [P256, { kty: 'OKP', crv: 'Ed25519', x: B43 }, { kty: 'EC', crv: 'P-384', x: 'C'.repeat(64), y: 'D'.repeat(64) }, { ...P256, x: B43.replace('A', 'E') }]
    expect(checkProfile(profiled((p) => { p.keys = keys }))).toEqual({ profile: { id: 'shariqh.github.io/agent-inbox/web-search', keys: 4, skills } })
  })

  it('takes a domain-anchored id and refuses every other form with fixed words', () => {
    for (const id of ['example.org/notes', 'shariqh.github.io/agent-inbox/web-search', 'xn--bcher-kva.example/a/b/c', `a.b/${'n'.repeat(40)}`, `${'a'.repeat(63)}.org/x`]) {
      expect(agentIdRefusal(id), id).toBeUndefined()
    }
    const CHARS = 'a profile id with a character other than a-z, 0-9, "-", "." and "/"'
    const DNS = 'a profile id whose domain is not a DNS name'
    const cases: Array<[unknown, string]> = [
      [42, 'a profile id that is not a string'],
      [`example.org/${'a/'.repeat(95)}n`, 'a profile id longer than 200 characters'],
      ['Example.org/notes', CHARS], ['example.org/Notes', CHARS], ['https://example.org/notes', CHARS],
      ['user@example.org/notes', CHARS], ['example.org:8443/notes', CHARS], ['example.org/notes?x=1', CHARS],
      ['example.org/notes#x', CHARS], ['example.org/no tes', CHARS], ['urn:air:example.org:notes', CHARS],
      ['example.org', 'a profile id with no /<name> after its domain'],
      ['localhost/notes', 'a profile id whose domain has no dot'],
      ['-example.org/notes', DNS], ['example-.org/notes', DNS], ['example..org/notes', DNS], ['.example.org/notes', DNS],
      ['127.0.0.1/notes', DNS], ['0x7f.0x0.0x0.0x1/notes', DNS], ['example.0x1/notes', DNS], ['example.9org/notes', DNS], [`${'a'.repeat(64)}.org/x`, DNS], [`${'a.'.repeat(127)}org/x`, 'a profile id longer than 200 characters'],
      ['example.org/notes/', 'a profile id with an empty or dotted path segment'],
      ['example.org//notes', 'a profile id with an empty or dotted path segment'],
      ['example.org/../notes', 'a profile id with an empty or dotted path segment'],
      ['example.org/v1.2/notes', 'a profile id with an empty or dotted path segment'],
      [`example.org/${'n'.repeat(41)}`, 'a profile id whose name is longer than 40 characters'],
    ]
    for (const [id, words] of cases) {
      expect(agentIdRefusal(id), String(id)).toBe(words)
      expect(checkProfile(profiled((p) => { p.id = id })), String(id)).toEqual({ reason: words })
    }
  })

  it('refuses a private key, an unknown member, an unknown curve, a bad coordinate, a duplicate and more than four keys', () => {
    const reason = (edit: (p: Json) => void) => checkProfile(profiled(edit))
    const cases: Array<[unknown, string]> = [
      [{ ...P256, d: B43 }, 'a private profile key'],
      [{ kty: 'OKP', crv: 'Ed25519', x: B43, d: B43 }, 'a private profile key'],
      [{ ...P256, kid: 'k1' }, 'a profile key with a member other than crv, kty, x, y'],
      [{ ...P256, use: 'sig' }, 'a profile key with a member other than crv, kty, x, y'],
      [{ kty: 'OKP', crv: 'Ed25519', x: B43, y: B43 }, 'a profile key with a member other than crv, kty, x'],
      [{ kty: 'EC', crv: 'P-256', x: B43 }, 'a profile key with a member other than crv, kty, x, y'],
      [{ kty: 'RSA', n: 'x', e: 'AQAB' }, 'a profile key that is not P-256, P-384 or Ed25519'],
      [{ ...P256, crv: 'secp256k1' }, 'a profile key that is not P-256, P-384 or Ed25519'],
      [{ ...P256, kty: 'OKP' }, 'a profile key that is not P-256, P-384 or Ed25519'],
      [{ ...P256, crv: '__proto__' }, 'a profile key that is not P-256, P-384 or Ed25519'],
      [{ ...P256, x: `${B43}=` }, 'a profile key with a malformed coordinate'],
      [{ ...P256, y: B43.slice(1) }, 'a profile key with a malformed coordinate'],
      [{ ...P256, x: B43.replace('A', '+') }, 'a profile key with a malformed coordinate'],
      ['thumbprint', 'a profile key that is not a JWK'],
    ]
    for (const [key, words] of cases) expect(reason((p) => { p.keys = [key] }), words).toEqual({ reason: words })
    expect(reason((p) => { p.keys = [P256, { ...P256 }] })).toEqual({ reason: 'a profile key listed twice' })
    expect(reason((p) => { p.keys = Array.from({ length: 5 }, (_, i) => ({ ...P256, x: B43.replace('A', 'BCDEF'[i]!) })) })).toEqual({ reason: 'more than 4 profile keys' })
    expect(reason((p) => { p.keys = P256 })).toEqual({ reason: 'profile keys that are not a list' })
  })

  it('holds the structure: exactly the card\'s skills, no unknown member, no empty value, one profile', () => {
    const reason = (edit: (p: Json) => void) => checkProfile(profiled(edit))
    expect(reason((p) => { p.skills['web-fetch'] = { residency: 'any' } })).toEqual({ reason: 'a profile entry for a skill the card lacks' })
    expect(checkProfile(change(profiled(), (c) => { c.skills.push({ id: 'web-fetch', name: 'f', description: 'f', tags: ['f'] }) }))).toEqual({ reason: 'a skill without a profile entry' })
    expect(reason((p) => { p.skills['web-search'].rate = 1 })).toEqual({ reason: 'a profile skill entry with a member other than egress and residency' })
    expect(reason((p) => { p.skills['web-search'] = 'caller-mesh' })).toEqual({ reason: 'a profile skill entry that is not an object' })
    expect(reason((p) => { p.skills = ['web-search'] })).toEqual({ reason: 'profile skills that are not an object' })
    expect(reason((p) => { p.namespace = 'shariqh' })).toEqual({ reason: 'a profile with a member other than id, keys and skills' })
    expect(reason((p) => { delete p.id })).toEqual({ reason: 'a profile without an id' })
    for (const empty of [[], {}, '', null]) {
      expect(reason((p) => { p.keys = empty }), JSON.stringify(empty)).toEqual({ reason: 'a profile with an empty value' })
      expect(reason((p) => { p.skills['web-search'].egress = empty }), JSON.stringify(empty)).toEqual({ reason: 'a profile with an empty value' })
    }
    expect(reason((p) => { p.skills['web-search'].egress = JSON.parse(`${'['.repeat(40)}1${']'.repeat(40)}`) })).toEqual({ reason: 'a profile nested too deeply' })
    for (const bad of [undefined, 'x', [params()]]) {
      expect(checkProfile(change(BARE, (c) => { c.capabilities.extensions.push({ uri: URI, params: bad }) }))).toEqual({ reason: 'a profile extension whose params are not an object' })
    }
    expect(checkProfile(change(profiled(), (c) => { c.capabilities.extensions.push({ uri: URI, params: params() }) }))).toEqual({ reason: 'more than one profile extension' })
  })

  it('takes declared egress and residency (#535) and refuses every other value with fixed words', () => {
    const declared = (edit: (e: Json) => void) => checkProfile(profiled((p) => edit(p.skills['web-search'])))
    const egress = (value: unknown) => declared((e) => { e.egress = value })
    const entry = (edit: Json) => egress([{ purpose: 'model', hosts: 'operator', sends: 'input', ...edit }])
    // every purpose, sends, hosts form and residency; a skill entry may hold either member alone
    for (const purpose of ['model', 'search', 'storage', 'web', 'api', 'agent']) {
      for (const sends of ['input', 'metadata']) {
        for (const hosts of ['operator', 'any', ['api.example.org'], ['*.example.org', 'xn--bcher-kva.example', 'a-b.c9.example']]) {
          expect(entry({ purpose, sends, hosts }), `${purpose} ${sends} ${hosts}`).toHaveProperty('profile')
        }
      }
    }
    expect(egress('none')).toHaveProperty('profile')
    expect(egress(Array.from({ length: 8 }, () => ({ purpose: 'web', hosts: Array.from({ length: 8 }, (_, i) => `h${i}.example.org`), sends: 'input' })))).toHaveProperty('profile')
    for (const residency of ['caller-host', 'caller-mesh', 'any']) expect(declared((e) => { e.residency = residency })).toHaveProperty('profile')
    expect(declared((e) => { delete e.egress })).toHaveProperty('profile')
    expect(declared((e) => { delete e.residency })).toHaveProperty('profile')

    const HOST = 'a profile egress host that is not a lower-case DNS name'
    const cases: Array<[unknown, string]> = [
      ['None', 'a profile egress that is neither "none" nor a list of entries'],
      ['operator', 'a profile egress that is neither "none" nor a list of entries'],
      [{ purpose: 'model', hosts: 'operator', sends: 'input' }, 'a profile egress that is neither "none" nor a list of entries'],
      [Array.from({ length: 9 }, () => ({ purpose: 'model', hosts: 'operator', sends: 'input' })), 'more than 8 profile egress entries for a skill'],
      [['none'], 'a profile egress entry that is not an object'],
      [[{ purpose: 'model', hosts: 'operator' }], 'a profile egress entry whose members are not exactly purpose, hosts and sends'],
      [[{ purpose: 'model', hosts: 'operator', sends: 'input', note: 'x' }], 'a profile egress entry whose members are not exactly purpose, hosts and sends'],
    ]
    for (const [value, words] of cases) expect(egress(value), JSON.stringify(value)).toEqual({ reason: words })
    const entries: Array<[Json, string]> = [
      [{ purpose: 'telemetry' }, 'a profile egress purpose other than model, search, storage, web, api, agent'],
      [{ purpose: 'Model' }, 'a profile egress purpose other than model, search, storage, web, api, agent'],
      [{ purpose: '__proto__' }, 'a profile egress purpose other than model, search, storage, web, api, agent'],
      [{ sends: 'everything' }, 'a profile egress sends other than input and metadata'],
      [{ sends: ['input'] }, 'a profile egress sends other than input and metadata'],
      [{ hosts: 'none' }, 'profile egress hosts that are neither "operator", "any" nor a list of hosts'],
      [{ hosts: 'api.example.org' }, 'profile egress hosts that are neither "operator", "any" nor a list of hosts'],
      [{ hosts: Array.from({ length: 9 }, (_, i) => `h${i}.example.org`) }, 'more than 8 hosts in a profile egress entry'],
      // hostile hosts: wildcard abuse, IP literals, controls, case, scheme, port, path, overlong
      ...['*', '*.', '*.org', '**.example.org', '0x7f.0x0.0x0.0x1', '1.2.3.0x4', '*.0x0.0x1', 'example.0x', 'example.1a', '*.*.example.org', 'a.*.example.org', 'example.*', '127.0.0.1', '10.0.0.1',
        '[::1]', '::1', 'localhost', 'Example.org', 'https://example.org', 'example.org:443', 'example.org/x', 'user@example.org',
        'example.org.', '.example.org', 'example..org', '-a.example.org', 'a-.example.org', 'exa mple.org', 'example.org\n',
        'exa\u202Emple.org', 'ex\u0000ample.org', 'bücher.example', `${'a'.repeat(64)}.org`, `${'a.'.repeat(126)}org`, `*.${'a.'.repeat(125)}org`, 42,
      ].map((h): [Json, string] => [{ hosts: [h] }, HOST]),
    ]
    for (const [edit, words] of entries) expect(entry(edit), JSON.stringify(edit)).toEqual({ reason: words })
    // the longest allowed name passes, so the 253 cap is the one refusing above
    expect(entry({ hosts: [`${'a.'.repeat(125)}org`] })).toHaveProperty('profile')
    for (const residency of ['Any', 'caller', 'public', 'none', ['any'], 1]) {
      expect(declared((e) => { e.residency = residency }), JSON.stringify(residency)).toEqual({ reason: 'a profile residency other than caller-host, caller-mesh, any' })
    }
    // a changed egress or residency is a card change, so it changes the pin
    const pin = canonicalCard(profiled())
    expect(canonicalCard(profiled((p) => { p.skills['web-search'].egress[0].hosts = ['search.example.org'] }))).not.toBe(pin)
    expect(canonicalCard(profiled((p) => { p.skills['web-search'].egress[0].sends = 'metadata' }))).not.toBe(pin)
    expect(canonicalCard(profiled((p) => { p.skills['web-search'].residency = 'any' }))).not.toBe(pin)
  })

  it('claim() quotes card text for one terminal line: cleaned, capped and escaped', () => {
    expect(claim('Notes search', 80)).toBe('"Notes search"')
    expect(claim('line\none\ttab', 80)).toBe('"line one tab"')
    expect(claim('a\u202Eb\u200Bc\u2028d\u0007e\u{E0041}f\rg', 80)).toBe('"a\uFFFDb\uFFFDc\uFFFDd\uFFFDe\uFFFDf\uFFFDg"')
    expect(claim('say "hi" \\ bye', 80)).toBe('"say \\"hi\\" \\\\ bye"')
    expect(claim('\u{1F600}'.repeat(5), 3)).toBe('"\u{1F600}\u{1F600}\u{1F600}…"')
    for (const v of [undefined, null, 3, ['x'], { a: 1 }]) expect(claim(v, 80)).toBeUndefined()
  })
})
