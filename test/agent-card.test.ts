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
import { canonicalCard, cardJson, checkAddedCard, checkCard, summarizeCard } from '../src/agent-card.js'

type Json = Record<string, any>
const REPO = new URL('..', import.meta.url).pathname
const REQUEST_POST: Json = JSON.parse(readFileSync(join(REPO, 'test', 'fixtures', 'a2a-request-post', 'card.json'), 'utf8'))
const UNSLOP_EXT = 'urn:agent-inbox:ext:unslop:v1'
const REQUEST_POST_EXT = 'urn:agent-inbox:ext:request-post:v1'

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
  it('passes the cards both agents serve', () => {
    expect(UNSLOP.name).toBe('unslop')
    expect(checkCard(UNSLOP, 'unslop')).toBeUndefined()
    expect(checkCard(REQUEST_POST, 'request-post')).toBeUndefined()
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
      [`no ${REQUEST_POST_EXT} extension`, (c) => { c.capabilities.extensions[0].uri = UNSLOP_EXT }],
      ['request-post api is not 1', (c) => { c.capabilities.extensions[0].params.api = 2 }],
    ]
    for (const [reason, edit] of cases) expect(checkCard(change(REQUEST_POST, edit), 'request-post'), reason).toBe(reason)
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
