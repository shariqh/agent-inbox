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
import { card, createExecutor, fixtureRun } from '../src/web-search/agent.js'
import { startFrontDoor } from '../src/web-search/front-door.js'
import { screen } from '../src/screen.js'
import type { ScreenClass } from '../src/screen.js'
import { FIXTURES, TOKEN, record } from './web-search-record.js'

type Json = Record<string, any>
const read = (rel: string): string => readFileSync(join(FIXTURES, rel), 'utf8')
const folder = (name: string): string[] => readdirSync(join(FIXTURES, name)).sort().map((f) => `${name}/${f}`)

afterEach(() => vi.restoreAllMocks())

describe('recorded fixtures (§11)', () => {
  it('the committed card and exchanges are exactly what W1 records now', async () => {
    const recorded = await record()
    expect([...recorded.keys()].filter((k) => k.startsWith('exchanges/')).sort()).toEqual(folder('exchanges'))
    for (const [rel, text] of recorded) expect(read(rel), rel).toBe(text)
  })

  it("card.sha256 is §4.1's raw-JCS hash of card.json", () => {
    expect(cardHash(JSON.parse(read('card.json')) as Json)).toBe(read('card.sha256').trim())
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
