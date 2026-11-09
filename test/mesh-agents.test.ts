// The agent cards view's server side (design
// docs/superpowers/specs/2026-11-09-agent-cards-view-design.md §3, §4, §7 V2): the lazy
// mesh.json read, the card fetch and its fixed words, the triggers and the two routes.
// Real temp dirs, real fake card servers on loopback; nothing about fs or http is mocked.
import { createServer as createHttpServer } from 'node:http'
import type { IncomingHttpHeaders, Server, ServerResponse } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import type { LookupFunction, Server as NetServer } from 'node:net'
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { startServer } from '../packages/mesh/src/a2a.js'
import { meshAgents } from '../src/mesh-agents.js'
import { loopbackPort, requestPostEndpoint } from '../src/mesh-config.js'
import type { MeshAgentsOpts } from '../src/mesh-agents.js'
import { createViewer } from '../src/viewer.js'
import { openDb } from '../src/store.js'
import type Database from 'better-sqlite3'
import { removeScratchDirs, scratchDir } from './scratch.js'

type Json = Record<string, any>
const REPO = new URL('..', import.meta.url).pathname
const REQUEST_POST: Json = JSON.parse(readFileSync(join(REPO, 'test', 'fixtures', 'a2a-request-post', 'card.json'), 'utf8'))
let UNSLOP: Json
beforeAll(async () => {
  const agent = await startServer({
    host: '127.0.0.1', port: 0, tokens: ['a1'.repeat(32)], version: '0.3.1-test',
    rules: () => ({ rulesSha256: '0'.repeat(64), bytes: 1, loadedAt: new Date(0).toISOString() }), run: () => new Promise(() => {}),
  })
  UNSLOP = await (await fetch(`http://127.0.0.1:${agent.port}/.well-known/agent-card.json`)).json() as Json
  agent.close()
})

const servers: Array<Server | NetServer> = []
const dbs: Database.Database[] = []
afterEach(() => {
  for (const s of servers.splice(0)) {
    if ('closeAllConnections' in s) s.closeAllConnections()
    s.close()
  }
  for (const db of dbs.splice(0)) db.close()
  removeScratchDirs()
})
afterAll(() => removeScratchDirs())

interface Fake { port: number; requests: IncomingHttpHeaders[]; connections: number }
async function fake(handle: (res: ServerResponse) => void): Promise<Fake> {
  const state: Fake = { port: 0, requests: [], connections: 0 }
  const server = createHttpServer((req, res) => {
    state.requests.push(req.headers)
    handle(res)
  })
  server.on('connection', () => state.connections++)
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  state.port = (server.address() as { port: number }).port
  return state
}
const serve = (card: unknown) => fake((res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(card)))
async function freePort(): Promise<number> {
  const server = createHttpServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  await new Promise((done) => server.close(done))
  return port
}

function setup(mesh: unknown, extra: Partial<MeshAgentsOpts> = {}) {
  const dir = scratchDir('mesh-agents-')
  if (mesh !== undefined) writeFileSync(join(dir, 'mesh.json'), typeof mesh === 'string' ? mesh : JSON.stringify(mesh))
  const clock = { t: Date.UTC(2026, 10, 9, 22, 0, 0) }
  const db = openDb(join(dir, 'inbox.db'))
  dbs.push(db)
  const base = { agentHome: scratchDir('mesh-home-'), setupInfoPath: join(dir, 'none.json') }
  const app = createViewer(db, { ...base, mesh: meshAgents({ dir, now: () => clock.t, ...extra }) })
  const plain = createViewer(db, base)
  const agents = async () => (await app.request('/api/mesh/agents')).json() as Promise<Json>
  const post = (body: unknown) => app.request('/api/mesh/agents/refresh', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const write = (doc: unknown) => writeFileSync(join(dir, 'mesh.json'), JSON.stringify(doc))
  return { dir, clock, app, plain, agents, post, write }
}
const unslopAt = (port: number) => ({ schema: 1, agents: { unslop: { endpoint: `http://127.0.0.1:${port}`, profile: 'unslop' } } })
const requestPostAt = (endpoint: string) => ({ schema: 1, agents: { 'request-post': { endpoint } } })
const tailnetTo127: LookupFunction = (_host, options, callback) => {
  if (options.all) (callback as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [{ address: '127.0.0.1', family: 4 }])
  else callback(null, '127.0.0.1', 4)
}

describe('off means off (design §2.5, §3.3)', () => {
  it('no file, a refused file or no known agent: /api/version is byte-identical, the routes say off, nothing connects', async () => {
    const counter = await serve(UNSLOP)
    const big = JSON.stringify({ ...unslopAt(counter.port), pad: 'x'.repeat(64 * 1024) })
    const cases: Array<[string, unknown]> = [
      ['no file', undefined], ['not JSON', '{'], ['schema 2', { ...unslopAt(counter.port), schema: 2 }],
      ['64 KiB + 1', big], ['no known key', { schema: 1, agentsView: true, agents: { later: { endpoint: `http://127.0.0.1:${counter.port}` } } }],
      ['symlink', 'symlink'],
    ]
    for (const [label, mesh] of cases) {
      const s = setup(mesh === 'symlink' ? undefined : mesh)
      if (mesh === 'symlink') {
        writeFileSync(join(s.dir, 'real.json'), JSON.stringify(unslopAt(counter.port)))
        symlinkSync(join(s.dir, 'real.json'), join(s.dir, 'mesh.json'))
      }
      const on = await s.app.request('/api/version')
      const off = await s.plain.request('/api/version')
      expect(await on.text(), label).toBe(await off.text())
      expect(await s.agents(), label).toEqual({ on: false, agents: [] })
      expect(await (await s.post({ trigger: 'refresh' })).json(), label).toEqual({ ok: true })
      expect(await (await s.post({ trigger: 'refresh', name: 'unslop' })).json(), label).toEqual({ ok: false, error: 'not configured' })
    }
    expect(counter.connections).toBe(0)
  })

  it('without opts.mesh the routes touch nothing and answer off', async () => {
    const { plain } = setup(unslopAt(1))
    expect(await (await plain.request('/api/mesh/agents')).json()).toEqual({ on: false, agents: [] })
    expect(Object.keys(await (await plain.request('/api/version')).json())).toEqual(['current', 'mode', 'runtimeInstalled', 'updatable', 'hosts'])
  })

  it('an endpoint that fails its rule is shown as invalid, counted, and never fetched', async () => {
    const counter = await serve(UNSLOP)
    const s = setup({ schema: 1, agents: { unslop: { endpoint: `http://localhost:${counter.port}` }, 'request-post': { endpoint: `http://example.com:${counter.port}` } } })
    expect((await (await s.app.request('/api/version')).json()).mesh).toEqual({ agents: 2 })
    await s.post({ trigger: 'refresh' })
    const body = await s.agents()
    expect(body.agents.map((a: Json) => [a.name, a.state, a.endpoint, a.where, a.fix])).toEqual([
      ['request-post', 'invalid', null, null, 'run npm run meshctl -- status'],
      ['unslop', 'invalid', null, 'local', 'run npm run meshctl -- status'],
    ])
    expect(counter.connections).toBe(0)
  })
})

describe('a hand-edited endpoint that is not a string', () => {
  it('is invalid and never fetched; /api/version answers with only the mesh key added', async () => {
    const hostile = { toString: 1 }
    const s = setup({ schema: 1, agents: { unslop: { endpoint: hostile }, 'request-post': { endpoint: hostile } } })
    const on = await s.app.request('/api/version')
    expect(on.status).toBe(200)
    const plain = await (await s.plain.request('/api/version')).json()
    expect(await on.text()).toBe(JSON.stringify({ ...plain, mesh: { agents: 2 } }))
    expect(await (await s.post({ trigger: 'refresh' })).json()).toEqual({ ok: true })
    expect((await s.agents()).agents.map((a: Json) => [a.name, a.state, a.endpoint])).toEqual([
      ['request-post', 'invalid', null], ['unslop', 'invalid', null],
    ])
    // the rule itself, which the meshctl clients share, reads it as off
    expect([loopbackPort(hostile), requestPostEndpoint(hostile), loopbackPort(4420), requestPostEndpoint(['http://127.0.0.1:8443'])]).toEqual([undefined, undefined, undefined, undefined])
  })
})

describe('the lazy config read (design §3.2)', () => {
  it('lstats at most once per 5 s and counts other agents without naming them', async () => {
    const s = setup(unslopAt(4420))
    expect((await (await s.app.request('/api/version')).json()).mesh).toEqual({ agents: 1 })
    s.write({ ...unslopAt(4420), agents: { ...unslopAt(4420).agents, 'request-post': { endpoint: 'http://127.0.0.1:8443' }, later: {} } })
    s.clock.t += 4_999
    expect((await (await s.app.request('/api/version')).json()).mesh).toEqual({ agents: 1 })
    s.clock.t += 1
    expect((await (await s.app.request('/api/version')).json()).mesh).toEqual({ agents: 2 })
    const body = await s.agents()
    expect(body.others).toBe(1)
    expect(JSON.stringify(body)).not.toContain('later')
  })

  it('a changed endpoint starts a fresh unchecked record, and reads never move it to checking', async () => {
    const first = await serve(UNSLOP)
    const s = setup(unslopAt(first.port))
    await s.post({ trigger: 'open' })
    expect((await s.agents()).agents[0].state).toBe('up')
    const second = await serve(UNSLOP)
    s.write(unslopAt(second.port))
    s.clock.t += 5_000
    for (let i = 0; i < 3; i++) {
      const [row] = (await s.agents()).agents
      expect(row).toMatchObject({ state: 'unchecked', reason: 'press Refresh', card: null, lastSeen: null, checkedAt: null, endpoint: `http://127.0.0.1:${second.port}` })
    }
    expect(second.connections).toBe(0)
  })
})

describe('checks and their words (design §2.4, §4.2-§4.5)', () => {
  it('a viewer starts unchecked; reading never connects; a running agent is up with no token sent', async () => {
    const agent = await serve(UNSLOP)
    const s = setup(unslopAt(agent.port))
    for (let i = 0; i < 3; i++) expect((await s.agents()).agents[0]).toMatchObject({ key: 'mesh.json:unslop', state: 'unchecked' })
    expect(agent.connections).toBe(0)
    expect(await (await s.post({ trigger: 'open' })).json()).toEqual({ ok: true })
    const [row] = (await s.agents()).agents
    expect(row).toMatchObject({ name: 'unslop', where: 'local', endpoint: `http://127.0.0.1:${agent.port}`, profile: 'unslop', state: 'up', reason: null, fix: null, lastSeen: null })
    expect(row.checkedAt).toBe(new Date(s.clock.t).toISOString())
    expect(row.card).toMatchObject({ name: 'unslop', version: '0.3.1-test' })
    expect(JSON.parse(row.cardJson)).toEqual(UNSLOP)
    expect(agent.requests).toHaveLength(1)
    const headers = agent.requests[0]!
    expect(headers.host).toBe(`127.0.0.1:${agent.port}`)
    for (const name of ['authorization', 'origin', 'cookie', 'a2a-version']) expect(headers[name], name).toBeUndefined()
  })

  it('unslop refused is not-running; a good card then a failure shows lastSeen, never up', async () => {
    const agent = await serve(UNSLOP)
    const s = setup(unslopAt(agent.port))
    await s.post({ trigger: 'refresh' })
    const seenAt = new Date(s.clock.t).toISOString()
    servers.splice(0).forEach((server) => { (server as Server).closeAllConnections(); server.close() })
    s.clock.t += 5_000
    await s.post({ trigger: 'refresh' })
    const [row] = (await s.agents()).agents
    expect(row).toMatchObject({ state: 'not-running', reason: 'starts on its first call', card: null, cardJson: null })
    expect(row.lastSeen).toMatchObject({ at: seenAt, card: { name: 'unslop' } })
  })

  it('a mismatch names its check and its fix and keeps the failing card', async () => {
    const card = structuredClone(UNSLOP)
    card.capabilities.extensions[0].params.api = 2
    const s = setup(unslopAt((await serve(card)).port))
    await s.post({ trigger: 'open' })
    expect((await s.agents()).agents[0]).toMatchObject({ state: 'mismatch', reason: 'unslop api is not 1', fix: 'rebuild packages/mesh', card: { name: 'unslop' } })
  })

  it('request-post through the SSH tunnel is up; a name that does not resolve is unreachable', async () => {
    const service = await serve(REQUEST_POST)
    const s = setup(requestPostAt(`http://127.0.0.1:${service.port}`))
    await s.post({ trigger: 'open' })
    expect((await s.agents()).agents[0]).toMatchObject({ key: 'mesh.json:request-post', where: 'ssh-tunnel', state: 'up', card: { skills: { more: 0 } } })
    expect(service.requests[0]!.authorization).toBeUndefined()
    const nowhere: LookupFunction = (host, _o, callback) => callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' }), '', 4)
    const t = setup(requestPostAt('https://box.tail1.ts.net'), { lookup: nowhere })
    await t.post({ trigger: 'open' })
    expect((await t.agents()).agents[0]).toMatchObject({ where: 'tailnet', state: 'unreachable', reason: 'does not resolve (is this Mac on the tailnet?)' })
  })

  it('a redirect is not followed, 403 is the service refusing, oversize and non-JSON are not cards', async () => {
    const target = await serve(UNSLOP)
    const cases: Array<[(res: ServerResponse) => void, Json]> = [
      [(res) => res.writeHead(302, { location: `http://127.0.0.1:${target.port}/.well-known/agent-card.json` }).end(), { state: 'not-a-card', reason: 'redirect, not followed' }],
      [(res) => res.writeHead(403).end(), { state: 'unreachable', reason: 'the service refused this device (HTTP 403)' }],
      [(res) => res.writeHead(200).end(JSON.stringify({ ...REQUEST_POST, pad: 'x'.repeat(70 * 1024) })), { state: 'not-a-card', reason: 'larger than 64 KiB' }],
      [(res) => res.writeHead(200).end('<html>'), { state: 'not-a-card', reason: 'not JSON' }],
      [(res) => res.writeHead(404).end(), { state: 'not-a-card', reason: 'HTTP 404' }],
      // parses within 64 KiB, but no stringify could show it
      [(res) => res.writeHead(200).end(`{"x":${'['.repeat(30_000)}${']'.repeat(30_000)}}`), { state: 'not-a-card', reason: 'nested too deeply' }],
    ]
    for (const [handle, want] of cases) {
      const s = setup(requestPostAt(`http://127.0.0.1:${(await fake(handle)).port}`))
      await s.post({ trigger: 'open' })
      expect((await s.agents()).agents[0], want.reason).toMatchObject({ ...want, card: null })
    }
    const u = setup(unslopAt((await fake((res) => res.writeHead(404).end())).port))
    await u.post({ trigger: 'open' })
    expect((await u.agents()).agents[0].reason).toBe('something other than the unslop agent answers (HTTP 404)')
    expect(target.connections).toBe(0)
  })

  it('one total deadline: drip-fed headers end at 3 s for unslop, a drip-fed body at 5 s for request-post', async () => {
    const closedAt: Record<string, number> = {}
    const drip = async (name: string, headersFirst: boolean) => {
      const server = createNetServer((socket) => {
        // headers one byte at a time, or whole headers and then a body one byte at a time
        const text = headersFirst ? 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n' : '{"x":"'
        if (!headersFirst) socket.write('HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\n')
        let i = 0
        const timer = setInterval(() => socket.write(i < text.length ? text[i++]! : 'x'), 500)
        socket.on('error', () => {})
        socket.on('close', () => { clearInterval(timer); closedAt[name] = Date.now() })
      })
      servers.push(server)
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
      return (server.address() as { port: number }).port
    }
    const s = setup({ schema: 1, agents: {
      unslop: { endpoint: `http://127.0.0.1:${await drip('unslop', true)}` },
      'request-post': { endpoint: `http://127.0.0.1:${await drip('request-post', false)}` },
    } })
    const start = Date.now()
    await s.post({ trigger: 'open' })
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(5_000)
    expect(elapsed).toBeLessThan(5_900)
    await new Promise((done) => setTimeout(done, 100))
    expect(closedAt.unslop! - start).toBeGreaterThanOrEqual(3_000)
    expect(closedAt.unslop! - start).toBeLessThan(3_900)
    const rows = (await s.agents()).agents
    expect(rows.map((r: Json) => [r.name, r.state, r.reason])).toEqual([
      ['request-post', 'unreachable', 'no answer in 5 s'],
      ['unslop', 'unreachable', 'no answer in 3 s'],
    ])
  }, 15_000)

  it('a tailnet endpoint is fetched over TLS with the 5 s deadline', async () => {
    let first: number | undefined
    const server = createNetServer((socket) => {
      socket.once('data', (chunk) => { first = chunk[0] })
      socket.on('error', () => {})
    })
    servers.push(server)
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const port = (server.address() as { port: number }).port
    const s = setup(requestPostAt(`https://box.tail1.ts.net:${port}`), { lookup: tailnetTo127 })
    const start = Date.now()
    await s.post({ trigger: 'open' })
    expect(Date.now() - start).toBeGreaterThanOrEqual(5_000)
    expect(first).toBe(0x16) // a TLS handshake record, not plain HTTP
    expect((await s.agents()).agents[0]).toMatchObject({ where: 'tailnet', endpoint: `https://box.tail1.ts.net:${port}`, state: 'unreachable', reason: 'no answer in 5 s' })
  }, 10_000)

  it('one check per agent at a time, reported as checking only while it runs', async () => {
    let release = (): void => {}
    const held = await fake((res) => { release = () => res.writeHead(200).end(JSON.stringify(UNSLOP)) })
    const s = setup(unslopAt(held.port))
    const a = s.post({ trigger: 'refresh' })
    const b = s.post({ trigger: 'refresh' })
    while (!held.requests.length) await new Promise((done) => setTimeout(done, 10))
    expect((await s.agents()).agents[0]).toMatchObject({ state: 'checking', reason: null })
    release()
    await Promise.all([a, b])
    expect(held.requests).toHaveLength(1)
    expect((await s.agents()).agents[0].state).toBe('up')
  })

  it('open skips an agent checked in the last 60 s, refresh one checked in the last 5 s', async () => {
    const agent = await serve(UNSLOP)
    const s = setup(unslopAt(agent.port))
    const step = async (ms: number, trigger: string) => { s.clock.t += ms; await s.post({ trigger }); return agent.requests.length }
    expect(await step(0, 'open')).toBe(1)
    expect(await step(30_000, 'open')).toBe(1)
    expect(await step(0, 'refresh')).toBe(2)
    expect(await step(4_999, 'refresh')).toBe(2)
    expect(await step(1, 'refresh')).toBe(3)
    expect(await step(60_000, 'open')).toBe(4)
  })
})

describe('the routes (design §4.5, §4.7)', () => {
  it('GET is conditional: 304 between triggers, a new tag after one', async () => {
    const s = setup(unslopAt((await serve(UNSLOP)).port))
    const first = await s.app.request('/api/mesh/agents')
    const etag = first.headers.get('etag')!
    expect(first.headers.get('cache-control')).toBe('no-store')
    expect((await s.app.request('/api/mesh/agents', { headers: { 'if-none-match': etag } })).status).toBe(304)
    await s.post({ trigger: 'open' })
    const after = await s.app.request('/api/mesh/agents', { headers: { 'if-none-match': etag } })
    expect(after.status).toBe(200)
    expect(after.headers.get('etag')).not.toBe(etag)
  })

  it('refuses a bad body with 400 and an unknown agent with ok:false', async () => {
    const s = setup(unslopAt(await freePort()))
    for (const body of ['nope', [], {}, { trigger: 'poll' }, { trigger: 'open', name: 'unslop' }, { trigger: 'refresh', name: 7 }, { trigger: 'open', extra: 1 }]) {
      expect((await s.post(body)).status, JSON.stringify(body)).toBe(400)
    }
    expect(await (await s.post({ trigger: 'refresh', name: 'request-post' })).json()).toEqual({ ok: false, error: 'not configured' })
    expect(await (await s.post({ trigger: 'refresh', name: 'unslop' })).json()).toEqual({ ok: true })
  })

  it('/api/version carries mesh only while the file names a known agent', async () => {
    const s = setup(unslopAt(4420))
    expect((await (await s.app.request('/api/version')).json()).mesh).toEqual({ agents: 1 })
    s.write({ schema: 1, agents: {} })
    s.clock.t += 5_000
    expect(await (await s.app.request('/api/version')).text()).toBe(await (await s.plain.request('/api/version')).text())
  })
})
