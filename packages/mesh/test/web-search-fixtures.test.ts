// The web-search conformance fixtures against W1's server (design §11, §13 W2): the
// committed card and exchanges are what web-search-record.ts records now, so they
// cannot drift from the SDK's real output; every refusal fixture is refused by the
// real front door before the SDK; and screen.json's cases agree with unslop's five
// classes, which W3's screenQuery() reuses.
import { readFileSync, readdirSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { JsonRpcTransportHandler } from '@a2a-js/sdk/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cardHash } from '../src/a2a-client.js'
import { AGENT_ID, PROFILE, card, createExecutor, fixtureRun } from '../src/web-search/agent.js'
import { thumbprint } from '../src/card-signing.js'
import { verifyAgentCardSignature } from '@a2a-js/sdk'
import type { AgentCard } from '@a2a-js/sdk'
import { startFrontDoor } from '../src/web-search/front-door.js'
import { screen } from '../src/screen.js'
import type { ScreenClass } from '../src/screen.js'
import { FIXTURES, TOKEN, record } from './web-search-record.js'

type Json = Record<string, any>
const read = (rel: string): string => readFileSync(join(FIXTURES, rel), 'utf8')
const folder = (name: string): string[] => readdirSync(join(FIXTURES, name)).sort().map((f) => `${name}/${f}`)

afterEach(() => vi.restoreAllMocks())

// Each recording signs with a key of its own (web-search-record.ts), so the key list and the
// signatures are the one thing two recordings never share; every other byte must match.
const unkeyed = (text: string): string => JSON.stringify(JSON.parse(text, function (this: Json, key, value: unknown) {
  return key === 'signatures' || (key === 'keys' && this.id === AGENT_ID) ? 'recording-specific' : value
}), null, 2)

describe('recorded fixtures (§11)', () => {
  it('the committed card and exchanges are exactly what W1 records now, but for the recording key', async () => {
    const recorded = await record()
    expect([...recorded.keys()].filter((k) => k.startsWith('exchanges/')).sort()).toEqual(folder('exchanges'))
    for (const [rel, text] of recorded) {
      if (rel === 'card.sha256') continue
      if (rel !== 'card.json' && rel !== 'exchanges/30-identity.json') expect(read(rel), rel).toBe(text)
      else expect([read(rel), unkeyed(read(rel))], rel).toEqual([`${JSON.stringify(JSON.parse(read(rel)), null, 2)}\n`, unkeyed(text)])
    }
  })

  it("card.sha256 is §4.1's raw-JCS hash of card.json", () => {
    expect(cardHash(JSON.parse(read('card.json')) as Json)).toBe(read('card.sha256').trim())
  })

  it('card.json is signed by the one key its profile lists, as the agent signs at start, and holds no private key (C7)', async () => {
    const c = JSON.parse(read('card.json')) as Json
    const profile = (c.capabilities.extensions as Json[]).find((e) => e.uri === PROFILE)!
    const keys = profile.params.keys as Json[]
    expect(keys.map((k) => Object.keys(k).sort().join())).toEqual(['crv,kty,x,y'])
    expect(c.signatures).toHaveLength(1)
    const quiet = console.debug
    console.debug = () => {}
    try {
      await expect(verifyAgentCardSignature(async (kid) => keys.find((k) => thumbprint(k) === kid) ?? Promise.reject(new Error('no such key')))(c as unknown as AgentCard)).resolves.toBeUndefined()
    } finally {
      console.debug = quiet
    }
    const recorded = await record()
    expect(JSON.parse(recorded.get('card.json')!).signatures).not.toEqual(c.signatures)
    for (const rel of [...folder('exchanges'), 'card.json']) expect(read(rel), rel).not.toMatch(/"d"\s*:/)
  })
})

describe('refusals (§3.2 item 2)', () => {
  const refusals = folder('refusals').map((rel) => [rel, JSON.parse(read(rel)) as Json] as const)

  it.each(refusals)('%s is refused before the SDK', async (_rel, r) => {
    const handle = vi.spyOn(JsonRpcTransportHandler.prototype, 'handle')
    const executor = createExecutor(fixtureRun, () => {})
    const door = await startFrontDoor({ port: 0, tokens: [TOKEN], card: (url) => card(url, '0.0.0-test'), executor, busy: () => false })
    try {
      const headers: Record<string, string> = { host: `127.0.0.1:${door.port}`, authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
      if (r.headers['A2A-Version'] !== undefined) headers['a2a-version'] = r.headers['A2A-Version'] as string
      const body = await new Promise<string>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: door.port, method: 'POST', path: '/', headers }, (res) => {
          let text = ''
          res.setEncoding('utf8')
          res.on('data', (c: string) => { text += c })
          res.on('end', () => resolve(text))
        })
        req.on('error', reject)
        req.end(JSON.stringify(r.request))
      })
      expect((JSON.parse(body) as Json).error).toEqual(r.error)
      expect(handle).not.toHaveBeenCalled()
    } finally {
      await door.close()
    }
  })
})

describe("screen.json against unslop's five classes (§7.1)", () => {
  const FIVE: ScreenClass[] = ['email-address', 'phone-number', 'secret', 'customer-path', 'deny-list']
  const s = JSON.parse(read('screen.json')) as Json
  const five = (query: string): string[] => {
    const r = screen(query, { deny: (s.context.deny as string[]).join('\n'), customerPaths: s.context.customerPaths as string[], allowEmails: s.context.allowEmails as string[] })
    return r.ok ? [] : r.classes.filter((c) => FIVE.includes(c))
  }

  it.each((s.cases as Json[]).map((c) => [c.query as string, c] as const))('%s', (query, c) => {
    if (c.expect === 'pass') expect(five(query)).toEqual([])
    else expect(five(query)).toEqual((c.classes as ScreenClass[]).filter((k) => FIVE.includes(k)))
  })
})
