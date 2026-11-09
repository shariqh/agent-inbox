// web-search conformance fixtures (#505, design 2026-11-09 §11, §13 W2). The exchanges are
// recorded from W1's server (packages/mesh/test/web-search-record.ts; the mesh suite re-records
// and compares). These tests prove every fixture conforms, that the validator catches a broken
// one, that the screen and grounding cases cover what §7.1 and §6 name, that MANIFEST.json
// matches the files, and that every value is a placeholder.
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { cardHash, checkCard, checkExchange, checkManifest, checkRefusal, checkResult, exitFor, manifestFiles } from './fixtures/a2a-web-search/conformance.js'

type Json = Record<string, any>
const DIR = new URL('./fixtures/a2a-web-search/', import.meta.url).pathname
const read = (rel: string): Json => JSON.parse(readFileSync(join(DIR, rel), 'utf8'))
const folder = (name: string): Array<[string, Json]> => readdirSync(join(DIR, name)).sort().map((f) => [f, read(`${name}/${f}`)])
const clone = (v: Json): Json => structuredClone(v)
const card = read('card.json')
const exchanges = folder('exchanges')
const refusals = folder('refusals')
const screen = read('screen.json')
const grounding = read('grounding.json')
const byRow = (row: string): Json => clone(exchanges.find(([, x]) => x.row === row)![1])

describe('web-search card (§4.1)', () => {
  it('conforms, and card.sha256 is its hash without the interface URL', () => {
    expect(checkCard(card)).toEqual([])
    expect(cardHash(card)).toBe(readFileSync(join(DIR, 'card.sha256'), 'utf8').trim())
    const moved = clone(card)
    moved.supportedInterfaces[0].url = 'http://127.0.0.1:5555/'
    expect(cardHash(moved)).toBe(cardHash(card))
    const bumped = clone(card)
    bumped.version = '9.9.9'
    expect(cardHash(bumped)).not.toBe(cardHash(card))
  })

  it('fails with push on, another extension api, or a per-copy setting', () => {
    const push = clone(card)
    push.capabilities.pushNotifications = true
    expect(checkCard(push)).toEqual(['capabilities'])
    const api2 = clone(card)
    api2.capabilities.extensions[0].params.api = 2
    expect(checkCard(api2)).toEqual(['extension'])
    const synthesis = clone(card)
    synthesis.capabilities.extensions[0].description = 'synthesis: off'
    expect(checkCard(synthesis)).toEqual(['a per-copy setting'])
  })
})

describe('web-search exchanges (§4.4)', () => {
  it('cover every row of the exit table, streaming, GetTask and the identity challenge', () => {
    expect(exchanges.filter(([, x]) => x.exit !== undefined).map(([, x]) => x.exit).sort((a, b) => a - b)).toEqual([0, 0, 0, 0, 0, 0, 4, 10, 11, 11, 11, 12, 13, 13, 14])
    expect(exchanges.filter(([, x]) => x.clientOnly).map(([, x]) => x.exit).sort()).toEqual([14, 4])
    expect(exchanges.filter(([, x]) => x.events).map(([, x]) => x.exit)).toEqual([0, 0, 11])
    expect(exchanges.map(([, x]) => x.request?.method).filter(Boolean)).toContain('GetTask')
    expect(byRow('answer').request.params.configuration.returnImmediately).toBe(false)
    expect(byRow('identity').challenge.response.headers['A2A-Mesh-Proof']).toMatch(/^[\w-]{43}$/)
  })

  for (const [file, x] of exchanges) it(`${file} conforms`, () => expect(checkExchange(x, card)).toEqual([]))

  it('fails a response that carries history, or echoes the query in a refusal', () => {
    const x = byRow('answer')
    x.response.result.task.history = [x.request.params.message]
    expect(checkExchange(x, card)).toContain('response: history')
    const r = byRow('refused-screen')
    r.response.result.task.status.message.parts[0].text = `rejected: screen (${r.request.params.message.parts[0].text as string})`
    expect(checkExchange(r, card)).toEqual(['response: echoes the query'])
  })

  it('fails an artifact streamed before COMPLETED, and a WORKING message that is not a stage name', () => {
    const x = byRow('stream-answer')
    const artifact = x.events.splice(-2, 1)[0]
    x.events.splice(1, 0, artifact)
    expect(checkExchange(x, card)).toContain('stream: an artifact before COMPLETED')
    const y = byRow('stream-answer')
    y.events[1].result.statusUpdate.status.message.parts[0].text = 'searching for the query'
    expect(checkExchange(y, card)).toEqual(['stream: a WORKING message'])
  })

  it('fails busy without retryAfterMs, a request with a refused key, and a wrong identity proof', () => {
    const busy = byRow('busy')
    delete busy.response.result.task.status.message.parts[1].data.retryAfterMs
    expect(checkExchange(busy, card)).toEqual(['data: retryAfterMs'])
    const tenant = byRow('sources')
    tenant.request.params.tenant = 'other'
    expect(checkExchange(tenant, card)).toEqual(['request: a refused key'])
    const id = byRow('identity')
    id.token = 'another-placeholder-token'
    expect(checkExchange(id, card)).toEqual(['identity: proof'])
  })

  it('exitFor maps sources-only to 10, busy to 12 and a cancel to 13', () => {
    const only = byRow('sources-only').response.result.task
    expect(exitFor(only)).toBe(10)
    expect(exitFor(byRow('busy').response.result.task)).toBe(12)
    expect(exitFor({ status: { state: 'TASK_STATE_CANCELED' } })).toBe(13)
  })
})

describe('checkResult (§4.3)', () => {
  const data = (): Json => clone(byRow('answer').response.result.task.artifacts[0].parts[1].data)
  it('fails a link in the answer, a citation out of range, and sources-only without a warning', () => {
    const link = data()
    link.answer.text = 'See https://docs.example.com/ [1].'
    expect(checkResult(link)).toEqual(['answer: citations or links'])
    const range = data()
    range.answer.citations = [3]
    expect(checkResult(range)).toEqual(['answer: citations or links'])
    const only = clone(byRow('sources-only').response.result.task.artifacts[0].parts[1].data)
    only.warnings = []
    expect(checkResult(only)).toEqual(['sources only: a warning naming why'])
  })

  it('fails a bidirectional override in a title and a URL with user info', () => {
    const bidi = data()
    bidi.sources[0].title = 'Example \u202Etxt.exe'
    expect(checkResult(bidi)).toEqual(['source 1: title, snippet or suspect'])
    const user = data()
    user.sources[0].url = 'https://user:pass@docs.example.com/releases/1'
    expect(checkResult(user)).toEqual(['source 1: url or host'])
  })
})

describe('web-search refusals (§3.2 item 2)', () => {
  for (const [file, r] of refusals) it(`${file} conforms`, () => expect(checkRefusal(r)).toEqual([]))

  it('cover snake_case, tenant, historyLength, a continuation, every push-config spelling, blocking, returnImmediately, a method and a version', () => {
    const text = refusals.map(([, r]) => JSON.stringify(r)).join('\n')
    for (const key of ['message_id', 'task_id', 'tenant', 'historyLength', 'history_length', '"taskId"', 'pushNotificationConfig', 'push_notification_config', 'taskPushNotificationConfig', 'task_push_notification_config', 'blocking', '"returnImmediately":true', 'return_immediately']) {
      expect(text.replace(/\s/g, '')).toContain(key)
    }
    expect(refusals.map(([, r]) => r.request.method)).toEqual(expect.arrayContaining(['Search', 'message/send', 'ListTasks']))
    expect(refusals.filter(([, r]) => r.error.code === -32009)).toHaveLength(3)
  })

  it('fails a refusal whose request the front door would accept', () => {
    const r = clone(refusals[0]![1])
    r.request = byRow('sources').request
    expect(checkRefusal(r)).toEqual(['the request would be accepted'])
  })
})

describe('screen.json (§7.1)', () => {
  const NEAR = [
    'Hello, World program in Zig', 'Hi, what is the default Postgres port', 'how does localhost resolve on macOS', 'what is 192.168.1.1',
    'is 127.0.0.1 the same as ::1', 'printer.local not found on Mac', 'what does ~/ mean in bash', 'PATH=/usr/bin vs /usr/local/bin',
    'C:\\Users folder permissions', 'difference between .local and .internal', 'set up a NAS on a Raspberry Pi with a GPU',
  ]
  it('refuses every class and passes every near miss §11 lists', () => {
    const cases = screen.cases as Json[]
    const refused = new Set(cases.filter((c) => c.expect === 'refuse').flatMap((c) => c.classes))
    expect([...refused].sort()).toEqual(['customer-path', 'deny-list', 'email-address', 'home-path', 'phone-number', 'private-name', 'secret', 'shape'])
    const passing = cases.filter((c) => c.expect === 'pass').map((c) => c.query)
    for (const q of NEAR) expect(passing).toContain(q)
    expect(cases.every((c) => ['pass', 'refuse'].includes(c.expect) && (c.expect === 'pass') === (c.classes === undefined))).toBe(true)
    expect(screen.context.seed.tailnetHosts).toEqual(expect.arrayContaining(['nas', 'pi', 'gpu']))
    for (const short of ['nas', 'pi', 'gpu']) expect(screen.context.deny).not.toContain(short)
  })
})

describe('grounding.json (§6)', () => {
  it('has passing and failing cases, every failure names a known rule, and every rule is covered', () => {
    const cases = grounding.cases as Json[]
    const rules = new Set(cases.filter((c) => c.expect === 'fail').map((c) => c.rule))
    expect([...rules].sort()).toEqual([...grounding.rules].sort())
    expect(cases.filter((c) => c.expect === 'pass').length).toBeGreaterThanOrEqual(8)
    for (const c of cases) expect(typeof c.question === 'string' && typeof c.answer === 'string' && c.sources.length > 0).toBe(true)
    for (const id of ['month-matches-day', 'version-prefix', 'version-not-prefix', 'question-number-uncited', 'paragraph-citation-covers', 'paragraph-citation-misses', 'not-found-uncited', 'not-found-link']) {
      expect(cases.map((c) => c.id)).toContain(id)
    }
  })
})

describe('providers and pages', () => {
  it('provider shapes have a request and a response, with 429 and 5xx for both Ollama endpoints', () => {
    const providers = folder('providers')
    for (const [, p] of providers) expect(['searxng', 'ollama']).toContain(p.provider)
    const statuses = providers.map(([, p]) => `${p.provider as string}:${String(p.request.url ?? p.request.path).replace(/\?.*$/, '').split('/').pop()!}:${p.response.status as number}`)
    expect(statuses).toEqual(expect.arrayContaining(['ollama:web_search:429', 'ollama:web_search:503', 'ollama:web_fetch:429', 'ollama:web_fetch:503', 'searxng:search:502', 'searxng:search:200']))
    for (const [, p] of providers.filter(([, p]) => p.provider === 'searxng' && p.response.status === 200)) {
      for (const r of p.response.body.results) expect(r).toEqual(expect.objectContaining({ url: expect.any(String), title: expect.any(String), content: expect.any(String), engines: expect.any(Array) }))
      expect(p.response.body.results.every((r: Json) => 'publishedDate' in r)).toBe(true)
    }
  })

  it('each injected page holds its injection in the field it names and expects suspect', () => {
    const pages = folder('pages')
    // §12.1's eight, and each again with its key phrase split by a zero-width character
    expect(pages).toHaveLength(16)
    const base = pages.filter(([, p]) => !p.variantOf).map(([, p]) => p.id)
    expect(base).toHaveLength(8)
    expect(pages.filter(([, p]) => p.variantOf).map(([, p]) => p.variantOf).sort()).toEqual([...base].sort())
    for (const [, p] of pages.filter(([, p]) => p.variantOf)) expect(p.injected).toMatch(/\u200B/)
    for (const [, p] of pages) {
      const field = { title: p.source.title, snippet: p.source.snippet, passage: p.source.page }[p.where as string]
      expect(field).toContain(p.injected)
      expect(p.expect).toEqual({ suspect: true })
    }
  })
})

/** Addresses, hosts and mail domains that are not placeholders, read once invisible characters (pages/zw-*) are gone. */
function placeholderProblems(raw: string): string[] {
  const text = raw.replace(/(?![\t\n])[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029]/gu, '')
  const ips = (text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []).filter((ip) => !(/^(?:192\.0\.2|198\.51\.100|203\.0\.113|127\.0\.0)\.\d+$/.test(ip) || ['192.168.1.1', '10.0.0.1'].includes(ip)))
  const hosts = [...text.matchAll(/https?:\/\/([^/\s"'?:)]+)/g)].map((m) => m[1]!).filter((h) => !/(?:^|\.)(?:example\.(?:com|org|net)|example|invalid)$|^127\.0\.0\.1$|^ollama\.com$/.test(h))
  const domains = [...text.matchAll(/[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/g)].map((m) => m[1]!).filter((d) => !/\.invalid$|example\.|^(?:192\.0\.2|198\.51\.100|203\.0\.113)\.\d+$/.test(d))
  return [...ips, ...hosts, ...domains]
}

describe('the folder', () => {
  it('MANIFEST.json matches every file', () => {
    expect(checkManifest(DIR)).toEqual([])
    expect(Object.keys(manifestFiles(DIR)).length).toBeGreaterThan(60)
  })

  it('holds placeholders only: documentation addresses, loopback, reserved names', () => {
    const text = Object.keys(manifestFiles(DIR)).filter((f) => f.endsWith('.json') || f.endsWith('.sha256')).map((f) => readFileSync(join(DIR, f), 'utf8')).join('\n')
    expect(placeholderProblems(text)).toEqual([])
  })

  it('the placeholder guard reads an address split by an invisible character whole', () => {
    expect(placeholderProblems('see 10.1\u200B.2.3 and https://ev\u3164il.test/ or person@mail.te\u00ADst.net')).toEqual(['10.1.2.3', 'evil.test', 'mail.test.net'])
  })
})
