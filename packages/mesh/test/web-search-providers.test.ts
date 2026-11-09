// W3 (web search design §5, §6, §7.1, §9, §13 "W3:"): the providers, the fallback, the
// filter, the passages, the cache, the budgets and the query screen, through counting
// fakes that answer from test/fixtures/a2a-web-search/providers/. No real provider and
// no network but loopback.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo, Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { screenQuery } from '../src/screen.js'
import type { QueryScreenOptions } from '../src/screen.js'
import { createBudget, createPacer } from '../src/web-search/budget.js'
import type { Caps, Store } from '../src/web-search/budget.js'
import { cacheKey, createCache } from '../src/web-search/cache.js'
import { createOllama } from '../src/web-search/ollama.js'
import { KEEP_CHARS, KEEP_CHUNKS, chunks, rankPassages } from '../src/web-search/passages.js'
import { send as realSend } from '../src/web-search/provider.js'
import type { HttpReply, HttpRequest, Send } from '../src/web-search/provider.js'
import { screenOptions, shapeQuery } from '../src/web-search/query.js'
import { createSearch, providersFrom } from '../src/web-search/search.js'
import type { Found, NotFound, SearchRequest } from '../src/web-search/search.js'
import { createSearxng, searxngEndpoint } from '../src/web-search/searxng.js'
import { FIXTURES } from './web-search-record.js'

type Json = Record<string, any>
const fixture = (name: string): Json => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Json
const provider = (name: string): Json => fixture(`providers/${name}.json`)
const SCREEN = fixture('screen.json')
const CONTEXT: QueryScreenOptions = {
  deny: (SCREEN.context.deny as string[]).join('\n'), customerPaths: SCREEN.context.customerPaths, allowEmails: SCREEN.context.allowEmails,
  interfaces: SCREEN.context.interfaces, tailnets: [SCREEN.context.tailnet], user: SCREEN.context.user,
}
const KEY = 'placeholder-ollama-key-Kc4n4ry'
const ENDPOINT = 'https://searxng.tailnet-example.ts.net'
const Q = 'example runtime long-term support'

const made: string[] = []
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const reply = (f: Json): HttpReply => ({
  status: f.response.status as number, retryAfter: f.response.headers['retry-after'] as string | undefined,
  body: typeof f.response.body === 'string' ? f.response.body : JSON.stringify(f.response.body),
})
const searxngWith = (results: Json[]): HttpReply => {
  const f = provider('searxng-results')
  return reply({ response: { ...f.response, body: { ...f.response.body, results } } })
}
const RESULTS = provider('searxng-results').response.body.results as Json[]
/** n distinct results on distinct hosts, built from the fixture's first. */
const many = (n: number): Json[] => Array.from({ length: n }, (_, i) => ({ ...RESULTS[0], url: `https://docs${i}.example.com/page`, title: `Result ${i}` }))

type Route = HttpReply | 'unreachable' | ((r: HttpRequest) => HttpReply | Promise<HttpReply>)
type Fake = Send & { calls: Record<'searxng' | 'search' | 'fetch', HttpRequest[]>; routes: Record<'searxng' | 'search' | 'fetch', Route> }
function fakeSend(routes: Partial<Fake['routes']> = {}): Fake {
  const calls: Fake['calls'] = { searxng: [], search: [], fetch: [] }
  const all: Fake['routes'] = { searxng: reply(provider('searxng-results')), search: reply(provider('ollama-search')), fetch: reply(provider('ollama-fetch')), ...routes }
  const fake = (async (r: HttpRequest) => {
    const which = r.url.pathname === '/search' ? 'searxng' : r.url.pathname === '/api/web_search' ? 'search' : 'fetch'
    calls[which].push(r)
    const route = all[which]
    // what a careless transport would say: the URL with ?q=, the key
    if (route === 'unreachable') throw Object.assign(new Error(`${r.method} ${r.url.href} failed (${r.headers.authorization ?? ''})`), { reason: 'unreachable' })
    return typeof route === 'function' ? route(r) : route
  }) as Fake
  return Object.assign(fake, { calls, routes: all })
}

const memory = (): Store & { text?: string } => {
  const s: Store & { text?: string } = { load: () => s.text, save: (t) => { s.text = t } }
  return s
}
type Setup = { fake: Fake; store: ReturnType<typeof memory>; search: ReturnType<typeof createSearch> }
function setup(o: { routes?: Partial<Fake['routes']>; fetch?: 'ollama' | 'none'; caps?: Record<'searxng' | 'ollama', Caps>; spacingMs?: number; waitMs?: number; now?: () => number; store?: ReturnType<typeof memory>; searxng?: boolean } = {}): Setup {
  const fake = fakeSend(o.routes)
  const store = o.store ?? memory()
  const ollama = createOllama({ key: KEY, send: fake })
  const search = createSearch({
    searxng: o.searxng === false ? undefined : createSearxng({ endpoint: ENDPOINT, send: fake }), ollama: ollama.search, fetcher: ollama.fetcher,
    fetch: o.fetch ?? 'ollama', budget: createBudget({ store, caps: o.caps, now: o.now }), pacer: createPacer({ spacingMs: o.spacingMs ?? 0, waitMs: o.waitMs ?? 5000 }),
    cache: createCache<Found>(o.now), screen: () => CONTEXT, now: o.now,
  })
  return { fake, store, search }
}
const req = (extra: Partial<SearchRequest> = {}): SearchRequest => ({ query: Q, mode: 'answer', recency: 'any', maxSources: 5, sites: [], excludeSites: [], fresh: false, ...extra })
const go = (s: Setup, extra: Partial<SearchRequest> = {}): Promise<Found | NotFound> => s.search(req(extra), new AbortController().signal)
const found = (r: Found | NotFound): Found => {
  expect(r.ok, JSON.stringify(r)).toBe(true)
  return r as Found
}
const notFound = (r: Found | NotFound): NotFound => {
  expect(r.ok, JSON.stringify(r)).toBe(false)
  return r as NotFound
}
const count = (f: Fake): number[] => [f.calls.searxng.length, f.calls.search.length, f.calls.fetch.length]

describe('the query screen (§7.1) against screen.json', () => {
  const cases = SCREEN.cases as Json[]

  it.each(cases.map((c) => [c.query as string, c] as const))('%s', (query, c) => {
    const shaped = shapeQuery(query)
    if (c.expect === 'pass') {
      expect(shaped).toBeDefined()
      expect(screenQuery(shaped!, CONTEXT)).toEqual({ ok: true })
    } else if ((c.classes as string[]).includes('shape')) expect(shaped).toBeUndefined()
    else {
      const r = screenQuery(shaped!, CONTEXT)
      expect(r.ok ? [] : [...r.classes].sort()).toEqual([...(c.classes as string[])].sort())
    }
  })

  it("keeps the router addresses even inside this Mac's subnet, and refuses a neighbour; the tailnet's own name too", () => {
    const o = { ...CONTEXT, interfaces: ['10.0.0.5/24', 'fd7a:115c:a1e0::5/48'] }
    expect(screenQuery('is 10.0.0.1 a router address', o).ok).toBe(true)
    expect(screenQuery('10.0.0.7 drops packets', o)).toEqual({ ok: false, classes: ['private-name'] })
    expect(screenQuery('ping fd7a:115c:a1e0::9 fails', o)).toEqual({ ok: false, classes: ['private-name'] })
    expect(screenQuery('http://10.0.0.7:8080/ is slow', o)).toEqual({ ok: false, classes: ['private-name'] })
    expect(screenQuery('<host>.local and *.internal names', o).ok).toBe(true)
  })

  it('reads both deny lists, fresh each time, and the tailnet from the seeded .ts.net names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mesh-w3-'))
    made.push(dir)
    mkdirSync(join(dir, 'mesh'), { recursive: true })
    const write = (name: string, text: string): void => {
      writeFileSync(join(dir, 'mesh', name), text)
      chmodSync(join(dir, 'mesh', name), 0o600)
    }
    write('web-search-deny.txt', '# seeded by meshctl\nexample-private-repo\nbuild-box.tailnet-other.ts.net\n')
    expect(screenQuery('example-private-repo build fails', { ...screenOptions(dir), user: 'u' })).toEqual({ ok: false, classes: ['deny-list'] })
    expect(screenQuery('Acme Widgets SSO outage', { ...screenOptions(dir), user: 'u' }).ok).toBe(true)
    write('unslop-deny.txt', 'Acme Widgets\n')
    expect(screenQuery('Acme Widgets SSO outage', { ...screenOptions(dir), user: 'u' })).toEqual({ ok: false, classes: ['deny-list'] })
    expect(screenOptions(dir).tailnets).toEqual(['tailnet-other.ts.net'])
    expect(screenQuery('tailnet-other acl syntax', { ...screenOptions(dir), user: 'u' })).toEqual({ ok: false, classes: ['private-name'] })
  })

  it('a refused query or site never reaches either provider, spends nothing, and the refusal names classes only', async () => {
    const s = setup()
    for (const c of (SCREEN.cases as Json[]).filter((x) => x.expect === 'refuse')) {
      const r = notFound(await go(s, { query: c.query as string }))
      expect(r.code).toBe(11)
      if (String(c.query).length >= 8) expect(JSON.stringify(r)).not.toContain(String(c.query).slice(0, 12))
    }
    for (const site of ['studio-mini.local', 'example-private-repo.example.com', '192.0.2.1', 'docs.example.com:443', 'https://docs.example.com', 'nas']) {
      expect(notFound(await go(s, { sites: [site] })).code).toBe(11)
      expect(notFound(await go(s, { excludeSites: [site] })).code).toBe(11)
    }
    expect(count(s.fake)).toEqual([0, 0, 0])
    expect(s.store.text).toBeUndefined()
  })
})

describe('the SearXNG adapter (§2.2, §5.3)', () => {
  it('sends the fixed GET and reads only url, title, content, engines and publishedDate', async () => {
    const fake = fakeSend()
    const r = await createSearxng({ endpoint: ENDPOINT, send: fake }).search({ text: Q, recency: 'any', max: 5, sites: [], excludeSites: [] }, new AbortController().signal)
    const [call] = fake.calls.searxng
    expect(call!.method).toBe('GET')
    expect(call!.url.origin).toBe(ENDPOINT)
    expect(`${call!.url.pathname}${call!.url.search}`).toBe(provider('searxng-results').request.path)
    expect(call!.body).toBeUndefined()
    expect(r).toEqual({ ok: true, sources: RESULTS.map((x) => ({ url: x.url, title: x.title, snippet: x.content, engines: x.engines, ...(x.publishedDate ? { publishedAt: String(x.publishedDate).slice(0, 10) } : {}) })) })
    await createSearxng({ endpoint: ENDPOINT, send: fake }).search({ text: Q, recency: 'week', max: 5, sites: ['docs.example.com'], excludeSites: ['example.net'] }, new AbortController().signal)
    expect(fake.calls.searxng[1]!.url.searchParams.get('time_range')).toBe('week')
    expect(fake.calls.searxng[1]!.url.searchParams.get('q')).toBe(Q)
  })

  it('maps 5xx, an unreachable host, a bad body and a redirect to fixed reasons', async () => {
    const search = (route: Route): Promise<unknown> => createSearxng({ endpoint: ENDPOINT, send: fakeSend({ searxng: route }) }).search({ text: Q, recency: 'any', max: 5, sites: [], excludeSites: [] }, new AbortController().signal)
    expect(await search(reply(provider('searxng-5xx')))).toEqual({ ok: false, outcome: 'failed', reason: 'http-5xx' })
    expect(await search('unreachable')).toEqual({ ok: false, outcome: 'failed', reason: 'unreachable' })
    expect(await search({ status: 200, body: '<html>' })).toEqual({ ok: false, outcome: 'failed', reason: 'bad-response' })
    expect(await search({ status: 302, body: '' })).toEqual({ ok: false, outcome: 'failed', reason: 'bad-response' })
  })

  it('the endpoint rule refuses a public host, an IP literal, a path and a missing tunnel port', () => {
    for (const ok of [ENDPOINT, `${ENDPOINT}:8443`, 'http://127.0.0.1:8888', 'http://127.0.0.1:8888/']) expect(() => searxngEndpoint(ok)).not.toThrow()
    for (const bad of ['https://search.example.com', 'https://192.0.2.1', 'https://[2001:db8::1]', 'http://192.0.2.1:8888', 'https://100.64.0.1',
      'http://searxng.tailnet-example.ts.net', `${ENDPOINT}/searx`, `${ENDPOINT}:443`, 'http://127.0.0.1', 'http://localhost:8888', 'https://a.b.c.ts.net', 'https://user@x.tailnet-example.ts.net', 42]) {
      expect(() => searxngEndpoint(bad)).toThrow('searxng.endpoint must be')
    }
  })

  it('never follows a redirect over the real transport', async () => {
    let elsewhere = 0
    const other = await listen((_q, res) => { elsewhere++; res.end('{"results":[]}') })
    const target = await listen((_q, res) => { res.writeHead(302, { location: `http://127.0.0.1:${other}/search?q=moved` }); res.end() })
    const r = await createSearxng({ endpoint: `http://127.0.0.1:${target}`, send: realSend }).search({ text: Q, recency: 'any', max: 5, sites: [], excludeSites: [] }, new AbortController().signal)
    expect(r).toEqual({ ok: false, outcome: 'failed', reason: 'bad-response' })
    expect(elsewhere).toBe(0)
  })
})

describe('the Ollama adapter (§5.3)', () => {
  const signal = new AbortController().signal

  it('posts the fixed search and fetch with the bearer key; content becomes page', async () => {
    const fake = fakeSend()
    const o = createOllama({ key: KEY, send: fake })
    const r = await o.search.search({ text: Q, recency: 'any', max: 5, sites: [], excludeSites: [] }, signal)
    const want = provider('ollama-search').request
    const [call] = fake.calls.search
    expect([call!.method, call!.url.href, JSON.parse(call!.body!)]).toEqual([want.method, want.url, want.body])
    expect(call!.headers.authorization).toBe(`Bearer ${KEY}`)
    const results = provider('ollama-search').response.body.results as Json[]
    expect(r.ok && r.sources.map((s) => [s.url, s.title, s.page])).toEqual(results.map((x) => [x.url, x.title, x.content]))
    const page = await o.fetcher.fetch('https://docs.example.com/releases/1', signal)
    expect(JSON.parse(fake.calls.fetch[0]!.body!)).toEqual(provider('ollama-fetch').request.body)
    expect(page).toEqual({ ok: true, text: provider('ollama-fetch').response.body.content })
  })

  it('429 is busy with its retry time; 5xx, 401 and a careless transport are fixed reasons without the key or the query', async () => {
    const run = async (search: Route, fetch: Route = search): Promise<[unknown, unknown]> => {
      const o = createOllama({ key: KEY, send: fakeSend({ search, fetch }) })
      return [await o.search.search({ text: Q, recency: 'any', max: 5, sites: [], excludeSites: [] }, signal), await o.fetcher.fetch('https://docs.example.com/releases/1', signal)]
    }
    expect(await run(reply(provider('ollama-search-429')), reply(provider('ollama-fetch-429')))).toEqual([{ ok: false, outcome: 'busy', reason: 'http-429', retryAfterMs: 30_000 }, { ok: false, reason: 'http-429' }])
    expect(await run(reply(provider('ollama-search-5xx')), reply(provider('ollama-fetch-5xx')))).toEqual([{ ok: false, outcome: 'failed', reason: 'http-5xx' }, { ok: false, reason: 'http-5xx' }])
    expect((await run({ status: 401, body: `{"error":"bad key ${KEY}"}` }))[0]).toEqual({ ok: false, outcome: 'failed', reason: 'auth' })
    const careless = await run('unreachable')
    expect(careless).toEqual([{ ok: false, outcome: 'failed', reason: 'unreachable' }, { ok: false, reason: 'unreachable' }])
    expect(JSON.stringify(careless)).not.toMatch(/Kc4n4ry|long-term/)
  })

  it('reads the key from the profile as { env }, and refuses a profile with no provider', async () => {
    const fake = fakeSend()
    const p = providersFrom({ searxng: { endpoint: ENDPOINT }, ollama: { apiKey: { env: 'W3_OLLAMA_KEY' } } }, { W3_OLLAMA_KEY: `${KEY}\n` }, fake)
    await p.ollama!.search({ text: Q, recency: 'any', max: 5, sites: [], excludeSites: [] }, signal)
    expect(fake.calls.search[0]!.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(() => providersFrom({ ollama: { apiKey: { env: 'W3_MISSING' } } }, {}, fake)).toThrow('the API key source is empty')
    expect(() => providersFrom({}, {}, fake)).toThrow('names no search provider')
    expect(() => providersFrom({ searxng: { endpoint: 'https://search.example.com' } }, {}, fake)).toThrow('searxng.endpoint must be')
  })
})

describe('the fallback (§5.2) and the filter (§5.3)', () => {
  it.each([0, 1, 2])('Ollama runs when SearXNG returns %i usable results, merged by URL with SearXNG first', async (n) => {
    const s = setup({ routes: { searxng: searxngWith(RESULTS.slice(0, n)) } })
    const r = found(await go(s, { mode: 'sources' }))
    expect(count(s.fake)).toEqual([1, 1, 0])
    expect(r.providers).toEqual(['searxng', 'ollama'])
    expect(r.fallback).toBe(true)
    expect(r.sources.slice(0, n).every((x) => x.provider === 'searxng')).toBe(true)
    expect(new Set(r.sources.map((x) => x.url)).size).toBe(r.sources.length)
    expect(r.sources.map((x) => x.n)).toEqual(r.sources.map((_, i) => i + 1))
  })

  it('Ollama does not run on 3 usable results, and does when filtering leaves 2 of them', async () => {
    const s = setup()
    expect(found(await go(s, { mode: 'sources' })).providers).toEqual(['searxng'])
    expect(count(s.fake)).toEqual([1, 0, 0])
    expect(found(await go(s, { mode: 'sources', excludeSites: ['wiki.example.org'] })).fallback).toBe(true)
    expect(count(s.fake)).toEqual([2, 1, 0])
  })

  it('Ollama alone when SearXNG is unreachable or erroring', async () => {
    for (const searxng of ['unreachable', reply(provider('searxng-5xx'))] as Route[]) {
      const s = setup({ routes: { searxng } })
      const r = found(await go(s, { mode: 'sources' }))
      expect([r.providers, r.fallback, count(s.fake)]).toEqual([['ollama'], true, [1, 1, 0]])
    }
  })

  it('drops excluded hosts, hosts outside sites, IP literals, other schemes, duplicates and results older than the window', async () => {
    const results = [
      ...RESULTS, { ...RESULTS[0], url: 'https://docs.example.com/releases/1#frag' }, { ...RESULTS[0], url: 'https://192.0.2.9/x' },
      { ...RESULTS[0], url: 'ftp://docs.example.com/x' }, { ...RESULTS[0], url: 'https://user:pw@docs.example.com/y' }, { ...RESULTS[0], url: 'https://evil.example.net/z' },
    ]
    const s = setup({ routes: { searxng: searxngWith(results) }, now: () => Date.parse('2026-10-30T18:00:00Z') })
    const r = found(await go(s, { mode: 'sources', sites: ['example.com'], recency: 'year', fresh: true }))
    expect(r.sources.filter((x) => x.provider === 'searxng').map((x) => x.url)).toEqual(['https://docs.example.com/releases/3'])
    expect(r.sources.every((x) => x.host.endsWith('example.com'))).toBe(true)
    expect(found(await go(s, { mode: 'sources', excludeSites: ['example.org'], maxSources: 1 })).sources.map((x) => x.url)).toEqual(['https://docs.example.com/releases/1'])
  })
})

describe('page text (§6)', () => {
  it('sources mode and fetch "none" never call web_fetch', async () => {
    const s = setup({ routes: { searxng: searxngWith(many(5)) } })
    const r = found(await go(s, { mode: 'sources' }))
    expect(r.sources.every((x) => x.passages === undefined && x.pageText === undefined)).toBe(true)
    const none = setup({ routes: { searxng: searxngWith(many(5)) }, fetch: 'none' })
    const a = found(await go(none))
    expect(a.sources.every((x) => x.pageText === 'snippet' && x.passages!.length === 1)).toBe(true)
    expect([s.fake.calls.fetch.length, none.fake.calls.fetch.length]).toEqual([0, 0])
  })

  it('answer mode fetches at most the top 3 results, never one that already has page text', async () => {
    const s = setup({ routes: { searxng: searxngWith(many(6)) } })
    const r = found(await go(s, { maxSources: 6 }))
    expect(s.fake.calls.fetch.map((c) => JSON.parse(c.body!).url)).toEqual(r.sources.slice(0, 3).map((x) => x.url))
    expect(r.sources.map((x) => x.pageText)).toEqual(['ollama-fetch', 'ollama-fetch', 'ollama-fetch', 'snippet', 'snippet', 'snippet'])
    const fallback = setup({ routes: { searxng: searxngWith([]) } })
    const f = found(await go(fallback))
    expect(f.sources.map((x) => x.pageText)).toEqual(['ollama-search', 'ollama-search'])
    expect(fallback.fake.calls.fetch).toHaveLength(0)
  })

  it('a failed fetch leaves the snippet; the passages drop the menu, images and link targets', async () => {
    const s = setup({ routes: { searxng: searxngWith(RESULTS), fetch: (r) => (JSON.parse(r.body!).url === RESULTS[0]!.url ? reply(provider('ollama-fetch')) : reply(provider('ollama-fetch-5xx'))) } })
    const r = found(await go(s))
    expect(r.sources.map((x) => x.pageText)).toEqual(['ollama-fetch', 'snippet', 'snippet'])
    const text = r.sources[0]!.passages!.join('\n')
    expect(text).toContain('long-term support on 2025-10-28')
    expect(text).not.toMatch(/Downloads|https?:|!\[|timeline\.png/)
    expect(r.sources[1]!.passages).toEqual([RESULTS[1]!.content])
  })
})

describe('the chunker (§6)', () => {
  const para = (i: number, word = 'runtime'): string => `Paragraph ${i} explains the example ${word} support window in some detail. `.repeat(4).trim()

  it('keeps at most 3 chunks and 2,400 characters per source, in page order', () => {
    const page = Array.from({ length: 12 }, (_, i) => para(i)).join('\n\n')
    const [kept] = rankPassages('example runtime support window', [{ text: page, whole: true }])
    expect(kept!.length).toBeLessThanOrEqual(KEEP_CHUNKS)
    expect(kept!.join('').length).toBeLessThanOrEqual(KEEP_CHARS)
    const order = kept!.map((c) => Number(/Paragraph (\d+)/.exec(c)![1]))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    const long = rankPassages('runtime', [{ text: `${'A long sentence about the runtime and its release line. '.repeat(200)}`, whole: true }])[0]!
    expect(long.length).toBeLessThanOrEqual(KEEP_CHUNKS)
    expect(long.join('').length).toBeLessThanOrEqual(KEEP_CHARS)
    expect(long.every((c) => c.length <= 800)).toBe(true)
  })

  it('ranks by the query: the matching paragraphs win over the first', () => {
    const page = [para(0, 'banana'), para(1, 'banana'), para(2, 'banana'), para(3, 'zebra'), para(4, 'banana'), para(5, 'zebra')].join('\n\n')
    expect(rankPassages('zebra', [{ text: page, whole: true }])[0]!.map((c) => /Paragraph (\d)/.exec(c)![1])).toEqual(['0', '3', '5'])
  })

  it('drops navigation, menus and chunks under 40 characters of words', () => {
    const menu = ['Home', 'Docs', 'Blog', 'About us', 'Contact'].join('\n')
    const links = '[Home](https://a.example/) · [Docs](https://a.example/d) · [Blog](https://a.example/b) · [About](https://a.example/c)'
    const out = chunks([links, menu, '# Title', 'Too short.', para(1)].join('\n\n'))
    expect(out.join('\n')).not.toMatch(/About|Contact|Blog/)
    expect(out).toHaveLength(1)
    expect(chunks('ok\n\n12345 67890 !!!! ????')).toEqual([])
  })
})

describe('budgets (§9.1)', () => {
  it('SearXNG requests never overlap and keep their spacing', async () => {
    const spans: Array<[number, number]> = []
    const searxng = async (): Promise<HttpReply> => {
      const start = performance.now()
      await new Promise((r) => setTimeout(r, 20))
      spans.push([start, performance.now()])
      return searxngWith(RESULTS)
    }
    const s = setup({ routes: { searxng }, spacingMs: 40 })
    const results = await Promise.all(['alpha', 'beta', 'gamma', 'delta'].map((w) => go(s, { query: `${Q} ${w}`, mode: 'sources' })))
    expect(results.every((r) => r.ok)).toBe(true)
    spans.sort((a, b) => a[0] - b[0])
    for (let i = 1; i < spans.length; i++) expect(spans[i]![0] - spans[i - 1]![1]).toBeGreaterThanOrEqual(38)
  })

  it('a search that cannot get its turn within the wait is busy (12) with a retry time, and spends nothing', async () => {
    const s = setup({ routes: { searxng: async () => { await new Promise((r) => setTimeout(r, 60)); return searxngWith(RESULTS) } }, spacingMs: 0, waitMs: 10 })
    const [a, b] = await Promise.all([go(s, { query: `${Q} one`, mode: 'sources' }), go(s, { query: `${Q} two`, mode: 'sources' })])
    expect(a.ok).toBe(true)
    expect(notFound(b)).toMatchObject({ code: 12, status: 'busy', reason: 'searxng-paced' })
    expect((b as NotFound).retryAfterMs).toBeGreaterThan(0)
    expect(count(s.fake)).toEqual([1, 0, 0])
  })

  it('the hourly and daily caps refuse with 11, persist, and the day rolls over', async () => {
    let t = Date.parse('2026-11-09T10:00:00')
    const now = (): number => t
    const store = memory()
    const hourly = setup({ caps: { searxng: { hour: 2, day: 100 }, ollama: { hour: 30, day: 150 } }, now, store })
    for (const w of ['a', 'b']) found(await go(hourly, { query: `${Q} ${w}`, mode: 'sources' }))
    expect(notFound(await go(hourly, { query: `${Q} c`, mode: 'sources' }))).toMatchObject({ code: 11, status: 'rejected', reason: 'hourly-cap' })
    t += 61 * 60_000
    found(await go(hourly, { query: `${Q} d`, mode: 'sources' }))
    const daily = setup({ caps: { searxng: { hour: 100, day: 3 }, ollama: { hour: 30, day: 150 } }, now, store })
    expect(notFound(await go(daily, { query: `${Q} e`, mode: 'sources' }))).toMatchObject({ code: 11, reason: 'daily-cap' })
    expect(daily.fake.calls.searxng).toHaveLength(0)
    t = Date.parse('2026-11-10T10:00:00')
    found(await go(daily, { query: `${Q} f`, mode: 'sources' }))
  })

  it("Ollama's cap counts search and fetch together, and refuses with 11 when SearXNG has nothing", async () => {
    const s = setup({ routes: { searxng: 'unreachable' }, caps: { searxng: { hour: 30, day: 100 }, ollama: { hour: 30, day: 1 } } })
    found(await go(s, { mode: 'sources' }))
    expect(notFound(await go(s, { query: `${Q} again`, mode: 'sources' }))).toMatchObject({ code: 11, reason: 'daily-cap' })
    const fetches = setup({ routes: { searxng: searxngWith(many(3)) }, caps: { searxng: { hour: 30, day: 100 }, ollama: { hour: 30, day: 2 } } })
    expect(found(await go(fetches)).warnings).toEqual(['fetch-daily-cap'])
    expect(fetches.fake.calls.fetch).toHaveLength(2)
  })

  it('an Ollama 429 is busy (12) with its retry time; a 5xx is busy when SearXNG was short, failed (13) when SearXNG failed too', async () => {
    for (const searxng of [searxngWith(RESULTS.slice(0, 1)), 'unreachable'] as Route[]) {
      expect(notFound(await go(setup({ routes: { searxng, search: reply(provider('ollama-search-429')) } })))).toMatchObject({ code: 12, status: 'busy', retryAfterMs: 30_000 })
    }
    expect(notFound(await go(setup({ routes: { searxng: searxngWith([]), search: reply(provider('ollama-search-5xx')) } })))).toMatchObject({ code: 12, reason: 'ollama-http-5xx' })
    expect(notFound(await go(setup({ routes: { searxng: reply(provider('searxng-5xx')), search: reply(provider('ollama-search-5xx')) } })))).toMatchObject({ code: 13, status: 'failed', reason: 'providers-failed' })
    const short = found(await go(setup({ routes: { searxng: searxngWith(RESULTS.slice(0, 2)), search: 'unreachable' } }), { mode: 'sources' }))
    expect([short.providers, short.sources.length, short.warnings]).toEqual([['searxng'], 2, ['fallback-failed']])
  })
})

describe('the memory cache (§9.2)', () => {
  it('a hit spends nothing; fresh replaces the entry', async () => {
    const s = setup()
    const first = found(await go(s))
    const spent = s.store.text
    const again = found(await go(s, { query: `  EXAMPLE runtime   long-term support ` }))
    expect([first.cache, again.cache, again.spent, count(s.fake), s.store.text]).toEqual(['miss', 'hit', { searxng: 0, ollama: 0 }, [1, 0, 3], spent])
    expect(again.sources).toEqual(first.sources)
    s.fake.routes.searxng = searxngWith([...RESULTS].reverse())
    const fresh = found(await go(s, { fresh: true }))
    expect([fresh.cache, count(s.fake)]).toEqual(['miss', [2, 0, 6]])
    expect(found(await go(s)).sources.map((x) => x.url)).toEqual(fresh.sources.map((x) => x.url))
    expect(count(s.fake)).toEqual([2, 0, 6])
  })

  it('pages is in the key: sources may reuse an answer entry, never the other way round', async () => {
    const base = { query: Q, recency: 'any' as const, maxSources: 5, sites: [] as string[], excludeSites: [] as string[] }
    expect(cacheKey({ ...base, pages: true })).not.toBe(cacheKey({ ...base, pages: false }))
    const s = setup()
    found(await go(s))
    const reuse = found(await go(s, { mode: 'sources' }))
    expect([reuse.cache, count(s.fake)]).toEqual(['hit', [1, 0, 3]])
    expect(reuse.sources.every((x) => x.passages === undefined)).toBe(true)
    const t = setup()
    found(await go(t, { mode: 'sources' }))
    expect(found(await go(t)).cache).toBe('miss')
    expect(count(t.fake)).toEqual([2, 0, 3])
  })

  it('expires after 15 minutes, 5 for recency day', async () => {
    let t = 0
    const s = setup({ now: () => t })
    found(await go(s, { mode: 'sources' }))
    found(await go(s, { mode: 'sources', recency: 'day' }))
    t = 6 * 60_000
    expect(found(await go(s, { mode: 'sources' })).cache).toBe('hit')
    expect(found(await go(s, { mode: 'sources', recency: 'day' })).cache).toBe('miss')
    t = 16 * 60_000
    expect(found(await go(s, { mode: 'sources' })).cache).toBe('miss')
  })
})

async function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }))
  return ((server as Server).address() as AddressInfo).port
}
