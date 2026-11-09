// The one A2A card rule (agent cards view design §4.4, slice V1). Both cards that ship
// today pass: request-post's R1 fixture and unslop's card as its agent serves it (the
// agent's own source, so a change to that card that this rule rejects fails here). Each
// rule fails with its fixed reason, checked in order. The clients' exit codes and words
// around these reasons are pinned in test/unslop-client.test.ts and
// test/request-post-client.test.ts.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startServer } from '../packages/mesh/src/a2a.js'
import type { A2AServer } from '../packages/mesh/src/a2a.js'
import { checkCard } from '../src/agent-card.js'

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
