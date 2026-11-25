// The agent cards view's server side (design
// docs/superpowers/specs/2026-11-09-agent-cards-view-design.md §3, §4, §7 V2): the lazy
// mesh.json read, the card fetch and its fixed words, the triggers and the two routes.
// Real temp dirs, real fake card servers on loopback; nothing about fs or http is mocked.
import { createServer as createHttpServer } from 'node:http'
import type { IncomingHttpHeaders, Server, ServerResponse } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import type { LookupFunction, Server as NetServer } from 'node:net'
import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { startServer } from '../packages/mesh/src/a2a.js'
import { codeSkill } from '../packages/mesh/src/skills.js'
import { meshAgents } from '../src/mesh-agents.js'
import { canonicalCard, cardJson, summarizeCard } from '../src/agent-card.js'
import { loopbackPort, requestPostEndpoint, writeCardCopy } from '../src/mesh-config.js'
import type { MeshAgentsOpts } from '../src/mesh-agents.js'
import { createViewer } from '../src/viewer.js'
import { openDb } from '../src/store.js'
import type Database from 'better-sqlite3'
import { removeScratchDirs, scratchDir } from './scratch.js'

type Json = Record<string, any>
const REPO = new URL('..', import.meta.url).pathname
const REQUEST_POST: Json = JSON.parse(readFileSync(join(REPO, 'test', 'fixtures', 'a2a-request-post', 'card.json'), 'utf8'))
let UNSLOP: Json
let UNSLOP_CODE: Json
beforeAll(async () => {
  const agent = await startServer({
    host: '127.0.0.1', port: 0, tokens: ['a1'.repeat(32)], version: '0.3.1-test',
    rules: () => ({ rulesSha256: '0'.repeat(64), bytes: 1, loadedAt: new Date(0).toISOString() }), run: () => new Promise(() => {}),
  })
  UNSLOP = await (await fetch(`http://127.0.0.1:${agent.port}/.well-known/agent-card.json`)).json() as Json
  agent.close()
  const code = await startServer({ host: '127.0.0.1', port: 0, tokens: ['b2'.repeat(32)], version: '0.3.1-test', skill: codeSkill({ run: () => new Promise(() => {}) }) })
  UNSLOP_CODE = await (await fetch(`http://127.0.0.1:${code.port}/.well-known/agent-card.json`)).json() as Json
  code.close()
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
// step 2b (D8): the built-ins mesh.json does not name, carried whether or not the mesh is on
const OFFERED: Record<string, Json> = {
  unslop: { name: 'unslop', blurb: 'Copy-edits public text by the unslop rules.', needs: 'model-server' },
  'unslop-code': { name: 'unslop-code', blurb: 'Removes the comments an AI coding agent adds to code.', needs: 'model-server' },
  'request-post': { name: 'request-post', blurb: 'Files a post request with your publishing service.', needs: 'address-and-token' },
}
const ALL_OFFERED = [OFFERED['unslop'], OFFERED['unslop-code'], OFFERED['request-post']]
const OFF_BODY = { on: false, agents: [], available: ALL_OFFERED }
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
      expect(await s.agents(), label).toEqual(OFF_BODY)
      expect(await (await s.post({ trigger: 'refresh' })).json(), label).toEqual({ ok: true })
      expect(await (await s.post({ trigger: 'refresh', name: 'unslop' })).json(), label).toEqual({ ok: false, error: 'not configured' })
    }
    expect(counter.connections).toBe(0)
  })

  it('without opts.mesh the routes touch nothing and answer off', async () => {
    const { plain } = setup(unslopAt(1))
    expect(await (await plain.request('/api/mesh/agents')).json()).toEqual({ on: false, agents: [] })
    // `machine` (#617) is this host's own name, so the list must not depend on it; test/session-place.test.ts pins it
    expect(Object.keys(await (await plain.request('/api/version')).json()).filter((key) => key !== 'machine')).toEqual(['current', 'mode', 'runtimeInstalled', 'updatable', 'hosts'])
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

  it('each built-in agent carries the one line the card shows while no card text is known', async () => {
    const s = setup({ schema: 1, agents: { unslop: { endpoint: 'http://127.0.0.1:4420', profile: 'unslop' }, 'request-post': { endpoint: 'https://svc.tailnet-example.ts.net' } } })
    const rows = (await s.agents()).agents as Json[]
    expect(rows.map((a) => [a.name, a.blurb])).toEqual([
      ['request-post', 'Files a post request with your publishing service.'],
      ['unslop', 'Copy-edits public text by the unslop rules.'],
    ])
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

  it('a request-post card under the old extension URN is up too (publishable-agent design §6, C6, C8)', async () => {
    // the fixture card declares the Pages URI since C8; the service's card before its switch, the old URN
    const card = structuredClone(REQUEST_POST)
    card.capabilities.extensions[0].uri = 'urn:agent-inbox:ext:request-post:v1'
    const s = setup(requestPostAt(`http://127.0.0.1:${(await serve(card)).port}`))
    await s.post({ trigger: 'open' })
    expect((await s.agents()).agents[0]).toMatchObject({ state: 'up', reason: null })
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

  it('an open naming one agent checks only that agent, with its own 60 s skip (cards view V5c1)', async () => {
    const unslopAgent = await serve(UNSLOP)
    const rpAgent = await serve(UNSLOP)
    const s = setup({ schema: 1, agents: { ...unslopAt(unslopAgent.port).agents, 'request-post': { endpoint: `http://127.0.0.1:${rpAgent.port}` } } })
    const counts = () => [unslopAgent.requests.length, rpAgent.requests.length]
    expect(await (await s.post({ trigger: 'open', name: 'unslop' })).json()).toEqual({ ok: true })
    expect(counts()).toEqual([1, 0])
    s.clock.t += 30_000
    await s.post({ trigger: 'open', name: 'unslop' })
    expect(counts()).toEqual([1, 0])
    await s.post({ trigger: 'open' })
    expect(counts()).toEqual([1, 1])
    s.clock.t += 30_000
    await s.post({ trigger: 'open', name: 'unslop' })
    expect(counts()).toEqual([2, 1])
  })
})

describe('unslop\'s usage line (design §4.6, V4)', () => {
  const DAY = 24 * 60 * 60 * 1000
  const ymd = (ms: number) => {
    const d = new Date(ms)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  async function withBudget(write: (file: string, s: ReturnType<typeof setup>) => void) {
    const s = setup({ schema: 1, agents: { ...unslopAt(await freePort()).agents, 'request-post': { endpoint: `http://127.0.0.1:${await freePort()}` } } })
    mkdirSync(join(s.dir, 'mesh'))
    const file = join(s.dir, 'mesh', 'unslop-budget.json')
    write(file, s)
    await s.post({ trigger: 'refresh' })
    const body = await s.agents()
    return { s, file, unslop: body.agents.find((a: Json) => a.name === 'unslop'), other: body.agents.find((a: Json) => a.name === 'request-post') }
  }

  it('today\'s file shows its counts on unslop only, read at a check and not between triggers', async () => {
    const { s, file, unslop, other } = await withBudget((file, s) => writeFileSync(file, JSON.stringify({ date: ymd(s.clock.t), tasks: 12, modelMs: 480000 }), { mode: 0o600 }))
    expect(unslop.state).toBe('not-running')
    expect(unslop.usage).toEqual({ date: ymd(s.clock.t), tasks: 12, modelMs: 480000 })
    expect(other).not.toHaveProperty('usage')
    writeFileSync(file, JSON.stringify({ date: ymd(s.clock.t), tasks: 13, modelMs: 500000 }))
    expect((await s.agents()).agents[1].usage.tasks).toBe(12)
    s.clock.t += 5_000
    await s.post({ trigger: 'refresh' })
    expect((await s.agents()).agents[1].usage.tasks).toBe(13)
    // the day turns with no check: the counts read as zero for the new day
    s.clock.t += DAY
    expect((await s.agents()).agents[1].usage).toEqual({ date: ymd(s.clock.t), tasks: 0, modelMs: 0 })
  })

  it('yesterday\'s file reads as zero for today', async () => {
    const { s, unslop } = await withBudget((file, s) => writeFileSync(file, JSON.stringify({ date: ymd(s.clock.t - DAY), tasks: 40, modelMs: 9_000_000 })))
    expect(unslop.usage).toEqual({ date: ymd(s.clock.t), tasks: 0, modelMs: 0 })
  })

  it('a missing file, a symlink, a directory or a malformed file sends no usage', async () => {
    const good = (ms: number) => ({ date: ymd(ms), tasks: 1, modelMs: 1 })
    const cases: Array<[string, (file: string, now: number) => void]> = [
      ['missing', () => {}],
      ['symlink', (file, now) => { writeFileSync(`${file}.real`, JSON.stringify(good(now))); symlinkSync(`${file}.real`, file) }],
      ['directory', (file) => mkdirSync(file)],
      ['not JSON', (file) => writeFileSync(file, '{')],
      ['an array', (file) => writeFileSync(file, '[]')],
      ['an extra key', (file, now) => writeFileSync(file, JSON.stringify({ ...good(now), limit: 60 }))],
      ['a missing key', (file, now) => writeFileSync(file, JSON.stringify({ date: ymd(now), tasks: 1 }))],
      ['tasks a string', (file, now) => writeFileSync(file, JSON.stringify({ ...good(now), tasks: '12' }))],
      ['tasks fractional', (file, now) => writeFileSync(file, JSON.stringify({ ...good(now), tasks: 1.5 }))],
      ['modelMs negative', (file, now) => writeFileSync(file, JSON.stringify({ ...good(now), modelMs: -1 }))],
      ['a bad date', (file) => writeFileSync(file, JSON.stringify({ date: 'today', tasks: 1, modelMs: 1 }))],
      ['over 4 KiB', (file, now) => writeFileSync(file, JSON.stringify(good(now)) + ' '.repeat(4 * 1024))],
    ]
    for (const [label, write] of cases) {
      const { unslop } = await withBudget((file, s) => write(file, s.clock.t))
      expect(unslop.state, label).toBe('not-running')
      expect(unslop, label).not.toHaveProperty('usage')
    }
  })
})

describe('the built-ins that are not on (agent setup in the app, step 2b, D8)', () => {
  it('lists each drawn built-in mesh.json does not name, from mesh.json alone, on and off, and changes nothing else', async () => {
    const agent = await serve(UNSLOP)
    const s = setup({ schema: 1, agents: { unslop: { endpoint: `http://127.0.0.1:${agent.port}`, profile: 'unslop' }, 'web-search': { endpoint: 'http://127.0.0.1:4430' } } })
    const body = await s.agents()
    expect(body.available).toEqual([OFFERED['unslop-code'], OFFERED['request-post']])
    // the same keys as before, with `available` added last
    expect(Object.keys(body)).toEqual(['on', 'agents', 'others', 'available'])
    expect(body.agents.map((a: Json) => a.name)).toEqual(['unslop'])
    // an invalid endpoint is still configured: on, so not offered
    s.write({ schema: 1, agents: { unslop: { endpoint: 'http://localhost:1' }, 'unslop-code': { endpoint: 'http://127.0.0.1:4421' }, 'request-post': { endpoint: 'https://svc.tailnet-example.ts.net' } } })
    s.clock.t += 5_000
    expect((await s.agents()).available).toEqual([])
    // the mesh off: every drawn built-in; /api/version says nothing about them
    s.write({ schema: 1, agents: {} })
    s.clock.t += 5_000
    expect(await s.agents()).toEqual(OFF_BODY)
    expect(await (await s.app.request('/api/version')).text()).toBe(await (await s.plain.request('/api/version')).text())
    // reading never connects
    expect(agent.connections).toBe(0)
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
    for (const body of ['nope', [], {}, { trigger: 'poll' }, { trigger: 'open', name: 7 }, { trigger: 'refresh', name: 7 }, { trigger: 'open', extra: 1 }]) {
      expect((await s.post(body)).status, JSON.stringify(body)).toBe(400)
    }
    expect(await (await s.post({ trigger: 'refresh', name: 'request-post' })).json()).toEqual({ ok: false, error: 'not configured' })
    expect(await (await s.post({ trigger: 'refresh', name: 'unslop' })).json()).toEqual({ ok: true })
    // cards view V5c1: an agent tab's open names its agent
    expect(await (await s.post({ trigger: 'open', name: 'request-post' })).json()).toEqual({ ok: false, error: 'not configured' })
    expect(await (await s.post({ trigger: 'open', name: 'unslop' })).json()).toEqual({ ok: true })
  })

  it('/api/version carries mesh only while the file names a known agent', async () => {
    const s = setup(unslopAt(4420))
    expect((await (await s.app.request('/api/version')).json()).mesh).toEqual({ agents: 1 })
    s.write({ schema: 1, agents: {} })
    s.clock.t += 5_000
    expect(await (await s.app.request('/api/version')).text()).toBe(await (await s.plain.request('/api/version')).text())
  })
})

describe('run history (cards view V5 §5.7, slice V5b)', () => {
  const ymd = (ms: number) => {
    const d = new Date(ms)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  let n = 0
  const rec = (at: number, extra: Json = {}): Json => ({
    v: 1, id: `${'abcdefgh'[n % 8]}${String.fromCharCode(97 + (Math.floor(n++ / 8) % 26))}aaaaaaaa`, agent: 'unslop', op: 'docs',
    at: new Date(at).toISOString(), ms: 300, exit: 0, outcome: 'ok', ...extra,
  })
  const runsDir = (dir: string) => join(dir, 'mesh', 'runs')
  function append(dir: string, r: Json, agent = 'unslop', date?: string) {
    mkdirSync(runsDir(dir), { recursive: true, mode: 0o700 })
    chmodSync(runsDir(dir), 0o700)
    const file = join(runsDir(dir), `${agent}-${date ?? ymd(Date.parse(r['at']))}.jsonl`)
    appendFileSync(file, `\n${JSON.stringify(r)}\n`, { mode: 0o600 })
    chmodSync(file, 0o600)
  }
  const runs = (s: ReturnType<typeof setup>, name: string, headers: Record<string, string> = {}) => s.app.request(`/api/mesh/agents/runs?name=${name}`, { headers })

  it('without opts.mesh or with the mesh off: off, whatever the runs folder holds', async () => {
    const s = setup(undefined)
    append(s.dir, rec(s.clock.t - 1000))
    expect(await (await runs(s, 'unslop')).json()).toEqual({ on: false, runs: [] })
    expect(await (await s.plain.request('/api/mesh/agents/runs?name=unslop')).json()).toEqual({ on: false, runs: [] })
    s.write({ schema: 1, agents: {} })
    s.clock.t += 5_000
    expect(await (await runs(s, 'unslop')).json()).toEqual({ on: false, runs: [] })
    expect(await s.agents()).toEqual(OFF_BODY)
  })

  it('a missing or unknown name is 400; a known one mesh.json does not configure is ok:false', async () => {
    const s = setup(unslopAt(await freePort()))
    for (const url of ['/api/mesh/agents/runs', '/api/mesh/agents/runs?name=', '/api/mesh/agents/runs?name=later', '/api/mesh/agents/runs?name=__proto__']) {
      expect((await s.app.request(url)).status, url).toBe(400)
    }
    expect((await s.plain.request('/api/mesh/agents/runs')).status).toBe(400)
    for (const name of ['request-post', 'web-search']) expect(await (await runs(s, name)).json(), name).toEqual({ ok: false, error: 'not configured' })
  })

  it('serves the newest 200 runs by end time with the forget command, and never connects, writes or deletes', async () => {
    const counter = await serve(UNSLOP)
    const s = setup(unslopAt(counter.port))
    const t = s.clock.t
    const old = rec(t - 40 * 24 * 3600_000)
    append(s.dir, old)
    // a 4-hour wait that ended last, after three shorter runs that started after it
    const long = rec(t - 1000, { ms: 4 * 3600_000 })
    const shorter = [rec(t - 3 * 3600_000), rec(t - 2 * 3600_000), rec(t - 3600_000)]
    for (const r of [long, ...shorter]) append(s.dir, r, 'unslop', ymd(t))
    for (let i = 0; i < 200; i++) append(s.dir, rec(t - 5 * 3600_000 - i * 1000), 'unslop', ymd(t))
    const listing = () => readdirSync(runsDir(s.dir)).sort().map((f) => [f, statSync(join(runsDir(s.dir), f)).mtimeMs])
    const before = listing()
    const body = await (await runs(s, 'unslop')).json()
    expect(body).toMatchObject({ on: true, name: 'unslop', older: true, skipped: 0, truncated: false, keptDays: 30, forget: 'npm run meshctl -- forget-runs --unslop' })
    expect(body.runs).toHaveLength(200)
    expect(body.runs.slice(0, 4).map((r: Json) => r.id)).toEqual([long, ...[...shorter].reverse()].map((r) => r['id']))
    expect(JSON.stringify(body)).not.toContain(old['id'])
    expect((await s.agents()).agents[0].lastRun).toEqual({ at: long['at'], op: 'docs', outcome: 'ok' })
    expect(listing()).toEqual(before)
    expect(counter.connections).toBe(0)
  })

  it('the canary: text hand-edited into a record never reaches either route', async () => {
    const s = setup(unslopAt(await freePort()))
    const C = 'canary-route-k7'
    // unknown fields are dropped; a known field holding text fails its rule and skips the line
    append(s.dir, rec(s.clock.t - 1000, { title: C, draft: C, url: `https://${C}.example` }))
    append(s.dir, rec(s.clock.t - 900, { status: 'rewritten', note: C }))
    append(s.dir, rec(s.clock.t - 800, { reason: `${C} words` }))
    append(s.dir, rec(s.clock.t - 700, { outcome: C }))
    append(s.dir, rec(s.clock.t - 600, { timing: { queued: 1, load: 1, model: 1, check: 1, text: C } }))
    const body = await (await runs(s, 'unslop')).text()
    expect(body).not.toContain(C)
    expect(JSON.parse(body)).toMatchObject({ skipped: 3, runs: [{ status: 'rewritten' }, { op: 'docs' }] })
    expect(JSON.stringify(await s.agents())).not.toContain(C)
  })

  it('ETag: 304 until a run lands and the 5 s pass is due, then 200; lastRun follows the newest end time', async () => {
    const s = setup({ schema: 1, agents: { ...unslopAt(await freePort()).agents, 'request-post': { endpoint: `http://127.0.0.1:${await freePort()}` } } })
    const first = rec(s.clock.t - 60_000)
    append(s.dir, first)
    const r1 = await runs(s, 'unslop')
    const a1 = await s.app.request('/api/mesh/agents')
    expect(r1.headers.get('cache-control')).toBe('no-store')
    const [tag, agentsTag] = [r1.headers.get('etag')!, a1.headers.get('etag')!]
    const lastRuns = (body: Json) => body.agents.map((a: Json) => [a.name, a.lastRun])
    expect(lastRuns(await a1.json())).toEqual([['request-post', null], ['unslop', { at: first['at'], op: 'docs', outcome: 'ok' }]])
    // idle ticks: identical bytes, 304 on both routes
    for (let i = 0; i < 3; i++) {
      s.clock.t += 5_000
      expect((await runs(s, 'unslop', { 'if-none-match': tag })).status).toBe(304)
      expect((await s.app.request('/api/mesh/agents', { headers: { 'if-none-match': agentsTag } })).status).toBe(304)
    }
    // a run lands: within the 5 s pass nothing is read again
    const later = rec(s.clock.t - 10, { exit: 13, outcome: 'failed', reason: 'internal' })
    append(s.dir, later)
    expect((await runs(s, 'unslop', { 'if-none-match': tag })).status).toBe(304)
    s.clock.t += 5_000
    const r2 = await runs(s, 'unslop', { 'if-none-match': tag })
    expect(r2.status).toBe(200)
    expect((await r2.json()).runs.map((r: Json) => r.id)).toEqual([later['id'], first['id']])
    const a2 = await s.app.request('/api/mesh/agents', { headers: { 'if-none-match': agentsTag } })
    expect(a2.status).toBe(200)
    expect(lastRuns(await a2.json())[1]).toEqual(['unslop', { at: later['at'], op: 'docs', outcome: 'failed' }])
    // an older run appended late does not move lastRun
    append(s.dir, rec(s.clock.t - 3_600_000))
    s.clock.t += 5_000
    expect(lastRuns(await s.agents())[1][1].at).toBe(later['at'])
  })
})

// Agent cards step 1 (D6): an agent meshctl add wrote is shown from the card copy meshctl keeps,
// only while that copy matches the entry's pin; the viewer never checks or contacts it.
describe('added agents (Agent cards step 1, D6)', () => {
  const ECHO: Json = {
    name: 'Echo Agent', description: 'Echoes one text.', version: '1.0.0',
    supportedInterfaces: [{ url: 'http://127.0.0.1:4555/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    capabilities: { streaming: true },
    securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
    skills: [{ id: 'echo', name: 'echo', description: 'Echo one text.', tags: ['test'] }],
  }
  const pinOf = (card: unknown) => createHash('sha256').update(canonicalCard(card)).digest('hex')
  const entry = (over: Json = {}) => ({ card: 'http://127.0.0.1:4555/.well-known/agent-card.json', endpoint: 'http://127.0.0.1:4555/a2a', tokenFile: '/nonexistent/token', cardSha256: pinOf(ECHO), ...over })
  const added = (body: Json) => body.agents.find((a: Json) => a.name === 'echo')
  const copyDir = (dir: string) => join(dir, 'mesh', 'cards')
  const mode = (path: string) => (statSync(path).mode & 0o777).toString(8)

  it('a matching copy shows the card; the state is added, neutral, never checked, and /api/version counts it', async () => {
    const counter = await serve(ECHO)
    const s = setup({ schema: 1, agents: { echo: entry({ card: `http://127.0.0.1:${counter.port}/.well-known/agent-card.json`, endpoint: `http://127.0.0.1:${counter.port}/a2a` }) } })
    writeCardCopy(s.dir, 'echo', ECHO)
    expect([mode(copyDir(s.dir)), mode(join(copyDir(s.dir), 'echo.json'))]).toEqual(['700', '600'])
    expect((await (await s.app.request('/api/version')).json()).mesh).toEqual({ agents: 1 })
    expect(await (await s.post({ trigger: 'open' })).json()).toEqual({ ok: true })
    expect(await (await s.post({ trigger: 'refresh', name: 'echo' })).json()).toEqual({ ok: true })
    const body = await s.agents()
    expect([body.others, 'othersFix' in body]).toEqual([0, false])
    expect(added(body)).toMatchObject({
      key: 'mesh.json:echo', name: 'echo', kind: 'added', where: 'local', state: 'added', reason: null, fix: null, checkedAt: null,
      card: { name: 'Echo Agent', description: 'Echoes one text.', version: '1.0.0' }, cardJson: cardJson(ECHO), lastSeen: null, lastRun: null,
    })
    // nothing connects to an added agent: not a read, an open or a Refresh
    expect(counter.connections).toBe(0)
  })

  it('where: Local on loopback, tailnet for a tailnet name, public for a public entry', async () => {
    const s = setup({
      schema: 1, agents: {
        a: entry(), b: entry({ card: 'https://agent.tailnet-example.ts.net/.well-known/agent-card.json', endpoint: 'https://agent.tailnet-example.ts.net/a2a', tokenFile: undefined }),
        c: entry({ card: 'https://agent.example.com/.well-known/agent-card.json', endpoint: 'https://agent.example.com/a2a', tokenFile: undefined, public: true }),
      },
    })
    expect((await s.agents()).agents.map((a: Json) => [a.name, a.where, a.kind])).toEqual([['a', 'local', 'added'], ['b', 'tailnet', 'added'], ['c', 'public', 'added']])
  })

  it('a missing, symlinked or oversized copy shows the id and the line to run; a mismatching one says so', async () => {
    const s = setup({ schema: 1, agents: { echo: entry() } })
    const line = (body: Json) => [added(body).card, added(body).cardJson, added(body).fix]
    const RUN = 'Run meshctl check echo to show its card'
    // missing
    expect(line(await s.agents())).toEqual([null, null, RUN])
    // mismatching: another card than the pinned one
    writeCardCopy(s.dir, 'echo', { ...ECHO, description: 'Something else.' })
    s.clock.t += 5_000
    expect(line(await s.agents())).toEqual([null, null, 'Its card copy does not match; run meshctl check echo'])
    // a symlink to the right card is refused
    const real = join(s.dir, 'real.json')
    writeFileSync(real, JSON.stringify(ECHO), { mode: 0o600 })
    renameSync(join(copyDir(s.dir), 'echo.json'), join(s.dir, 'moved.json'))
    symlinkSync(real, join(copyDir(s.dir), 'echo.json'))
    s.clock.t += 5_000
    expect(line(await s.agents())).toEqual([null, null, RUN])
    renameSync(join(copyDir(s.dir), 'echo.json'), join(s.dir, 'link.json'))
    // over the 64 KiB cap, though it pins right
    const big = { ...ECHO, padding: 'x'.repeat(64 * 1024) }
    writeFileSync(join(copyDir(s.dir), 'echo.json'), JSON.stringify(big), { mode: 0o600 })
    s.write({ schema: 1, agents: { echo: entry({ cardSha256: pinOf(big) }) } })
    s.clock.t += 5_000
    expect(line(await s.agents())).toEqual([null, null, RUN])
    // open to others: refused too; the right copy, private, shows
    writeFileSync(join(copyDir(s.dir), 'echo.json'), JSON.stringify(ECHO), { mode: 0o644 })
    chmodSync(join(copyDir(s.dir), 'echo.json'), 0o644)
    s.write({ schema: 1, agents: { echo: entry() } })
    s.clock.t += 5_000
    expect(line(await s.agents())).toEqual([null, null, RUN])
    chmodSync(join(copyDir(s.dir), 'echo.json'), 0o600)
    s.clock.t += 5_000
    expect(line(await s.agents())).toEqual([summarizeCard(ECHO), cardJson(ECHO), null])
    // a cards folder that is a symlink is refused as a whole
    renameSync(copyDir(s.dir), join(s.dir, 'cards-real'))
    symlinkSync(join(s.dir, 'cards-real'), copyDir(s.dir))
    s.clock.t += 5_000
    expect(line(await s.agents())).toEqual([null, null, RUN])
  })

  it('an added agent says the app does not check it, and a missing copy is a quiet line, not a problem', async () => {
    const s = setup({ schema: 1, agents: { echo: entry() } })
    const row = async () => added(await s.agents())
    expect(await row()).toMatchObject({ checkNote: 'The app does not check added agents. meshctl check echo does.', fixQuiet: true })
    // a mismatching copy is a problem state
    writeCardCopy(s.dir, 'echo', { ...ECHO, description: 'Something else.' })
    s.clock.t += 5_000
    expect(await row()).toMatchObject({ fixQuiet: false })
    // a refused copy too
    chmodSync(join(copyDir(s.dir), 'echo.json'), 0o644)
    s.clock.t += 5_000
    expect(await row()).toMatchObject({ fixQuiet: false })
    // the right copy: no line at all
    writeCardCopy(s.dir, 'echo', ECHO)
    s.clock.t += 5_000
    expect(await row()).toMatchObject({ fix: null, fixQuiet: false })
  })

  it('an invalid entry is not shown: it counts in others; one that is not an added entry, or a built-in name, too', async () => {
    const s = setup({ schema: 1, agents: { unslop: { endpoint: 'http://127.0.0.1:4420' }, echo: entry(), bad: entry({ cardSha256: 'nope' }), later: {}, 'web-search': { endpoint: 'http://127.0.0.1:4430' }, 'unslop-code': { endpoint: 'http://127.0.0.1:4421', profile: 'unslop-code' } } })
    expect((await (await s.app.request('/api/version')).json()).mesh).toEqual({ agents: 3 })
    const body = await s.agents()
    expect(body.agents.map((a: Json) => a.name)).toEqual(['echo', 'unslop', 'unslop-code'])
    // neither built in nor a valid added entry: bad and later; web-search is built in, not drawn yet
    expect(body.others).toBe(2)
    // the page's line says what to run; the words naming the command come from here (design §3.4)
    expect(body.othersFix).toBe('run meshctl status')
    expect(JSON.stringify(body)).not.toMatch(/"bad"|later/)
    // web-search alone is a built-in this view does not draw yet: off, and no runs route
    const search = setup({ schema: 1, agents: { 'web-search': { endpoint: 'http://127.0.0.1:4430' } } })
    expect(await (await search.app.request('/api/version')).text()).toBe(await (await search.plain.request('/api/version')).text())
    expect(await search.agents()).toEqual(OFF_BODY)
    // only invalid entries: off, byte-identical
    const off = setup({ schema: 1, agents: { bad: entry({ cardSha256: 'nope' }) } })
    expect(await (await off.app.request('/api/version')).text()).toBe(await (await off.plain.request('/api/version')).text())
    expect(await off.agents()).toEqual(OFF_BODY)
  })

  it('runs: an added agent’s records are read and its lastRun shown; the forget command names its id', async () => {
    const s = setup({ schema: 1, agents: { echo: entry() } })
    mkdirSync(join(s.dir, 'mesh', 'runs'), { recursive: true, mode: 0o700 })
    chmodSync(join(s.dir, 'mesh', 'runs'), 0o700)
    const at = new Date(s.clock.t - 60_000)
    const ymd = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
    writeFileSync(join(s.dir, 'mesh', 'runs', `echo-${ymd}.jsonl`), `${JSON.stringify({ v: 1, id: 'abcdefghij', agent: 'echo', op: 'call', at: at.toISOString(), ms: 300, exit: 0, outcome: 'ok' })}\n`, { mode: 0o600 })
    expect(added(await s.agents()).lastRun).toEqual({ at: at.toISOString(), op: 'call', outcome: 'ok' })
    const runs = await (await s.app.request('/api/mesh/agents/runs?name=echo')).json()
    expect([runs.on, runs.runs.length, runs.forget]).toEqual([true, 1, 'npm run meshctl -- forget-runs --id echo'])
    // an id mesh.json does not hold is still a 400
    expect((await s.app.request('/api/mesh/agents/runs?name=other')).status).toBe(400)
  })
})

// unslop-code (#652, step 3c) is drawn as unslop is: a local agent that starts on its first call, with
// its own card rule, budget file and run records. Everything comes from its own files, never unslop's.
describe('unslop-code, the second local agent', () => {
  const ymd = (ms: number) => {
    const d = new Date(ms)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  const codeAt = (port: number, extra: Json = {}) => ({ schema: 1, agents: { 'unslop-code': { endpoint: `http://127.0.0.1:${port}`, profile: 'unslop-code' }, ...extra } })
  const row = (body: Json, name = 'unslop-code') => body.agents.find((a: Json) => a.name === name)

  it('is up when its card answers: local, its profile, its own blurb, no token sent, and a viewer starts unchecked', async () => {
    const agent = await serve(UNSLOP_CODE)
    const s = setup(codeAt(agent.port))
    expect((await (await s.app.request('/api/version')).json()).mesh).toEqual({ agents: 1 })
    expect(row(await s.agents())).toMatchObject({ key: 'mesh.json:unslop-code', kind: 'built-in', state: 'unchecked', blurb: 'Removes the comments an AI coding agent adds to code.', where: 'local' })
    expect(agent.connections).toBe(0)
    expect(await (await s.post({ trigger: 'open' })).json()).toEqual({ ok: true })
    const code = row(await s.agents())
    expect(code).toMatchObject({ where: 'local', endpoint: `http://127.0.0.1:${agent.port}`, profile: 'unslop-code', state: 'up', reason: null, fix: null, lastSeen: null })
    expect(code.card).toMatchObject({ name: 'unslop-code', version: '0.3.1-test' })
    expect(JSON.parse(code.cardJson)).toEqual(UNSLOP_CODE)
    expect(agent.requests).toHaveLength(1)
    for (const name of ['authorization', 'origin', 'cookie', 'a2a-version']) expect(agent.requests[0]![name], name).toBeUndefined()
    expect(code).not.toHaveProperty('usage')
  })

  it('is listed beside unslop and request-post, each with its own line', async () => {
    const s = setup({ schema: 1, agents: { unslop: { endpoint: 'http://127.0.0.1:4420', profile: 'unslop' }, 'unslop-code': { endpoint: 'http://127.0.0.1:4421', profile: 'unslop-code' }, 'request-post': { endpoint: 'https://svc.tailnet-example.ts.net' } } })
    expect((await (await s.app.request('/api/version')).json()).mesh).toEqual({ agents: 3 })
    expect((await s.agents()).agents.map((a: Json) => [a.name, a.where, a.profile, a.blurb])).toEqual([
      ['request-post', 'tailnet', null, 'Files a post request with your publishing service.'],
      ['unslop', 'local', 'unslop', 'Copy-edits public text by the unslop rules.'],
      ['unslop-code', 'local', 'unslop-code', 'Removes the comments an AI coding agent adds to code.'],
    ])
  })

  it('not running says it starts on its first call; a good card then a failure shows lastSeen, never up', async () => {
    const agent = await serve(UNSLOP_CODE)
    const s = setup(codeAt(agent.port))
    await s.post({ trigger: 'refresh' })
    const seenAt = new Date(s.clock.t).toISOString()
    servers.splice(0).forEach((server) => { (server as Server).closeAllConnections(); server.close() })
    s.clock.t += 5_000
    await s.post({ trigger: 'refresh' })
    const code = row(await s.agents())
    expect(code).toMatchObject({ state: 'not-running', reason: 'starts on its first call', card: null, cardJson: null })
    expect(code.lastSeen).toMatchObject({ at: seenAt, card: { name: 'unslop-code' } })
    // never started and never seen: the same words, no last-seen card
    const fresh = setup(codeAt(await freePort()))
    await fresh.post({ trigger: 'open' })
    expect(row(await fresh.agents())).toMatchObject({ state: 'not-running', reason: 'starts on its first call', lastSeen: null })
  })

  it('a squatter on its port is not its agent: not a card, and another agent\'s card, with its own words', async () => {
    const junk = await fake((res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<html>hello</html>'))
    const s = setup(codeAt(junk.port))
    await s.post({ trigger: 'open' })
    expect(row(await s.agents())).toMatchObject({ state: 'not-a-card', reason: 'something other than the unslop-code agent answers (not JSON)', card: null })
    const refused = await fake((res) => res.writeHead(404).end('no'))
    const other = setup(codeAt(refused.port))
    await other.post({ trigger: 'open' })
    expect(row(await other.agents())).toMatchObject({ state: 'not-a-card', reason: 'something other than the unslop-code agent answers (HTTP 404)' })
    // unslop's own card answering on unslop-code's port is a card that is not its own
    const unslopHere = await serve(UNSLOP)
    const third = setup(codeAt(unslopHere.port))
    await third.post({ trigger: 'open' })
    expect(row(await third.agents())).toMatchObject({ state: 'mismatch', reason: 'not the unslop-code agent\'s card', fix: 'rebuild packages/mesh', card: { name: 'unslop' } })
    // and unslop-code's card on unslop's port fails unslop's rule, not its own
    const codeHere = await serve(UNSLOP_CODE)
    const fourth = setup(unslopAt(codeHere.port))
    await fourth.post({ trigger: 'open' })
    expect(row(await fourth.agents(), 'unslop')).toMatchObject({ state: 'mismatch', reason: 'no unslop skill', fix: 'rebuild packages/mesh' })
  })

  it('a card of its name that its client cannot use is a mismatch that names the check', async () => {
    const card = structuredClone(UNSLOP_CODE)
    card.capabilities.extensions[0].params.api = 2
    const s = setup(codeAt((await serve(card)).port))
    await s.post({ trigger: 'open' })
    expect(row(await s.agents())).toMatchObject({ state: 'mismatch', reason: 'unslop-code api is not 1', fix: 'rebuild packages/mesh', card: { name: 'unslop-code' } })
    const noExt = structuredClone(UNSLOP_CODE)
    noExt.capabilities.extensions = []
    const t = setup(codeAt((await serve(noExt)).port))
    await t.post({ trigger: 'open' })
    expect(row(await t.agents())).toMatchObject({ state: 'mismatch', reason: 'no urn:agent-inbox:ext:unslop-code:v1 extension' })
  })

  it('an endpoint that is not loopback http is invalid and never fetched, and a bad profile name is not shown', async () => {
    const counter = await serve(UNSLOP_CODE)
    const s = setup({ schema: 1, agents: { 'unslop-code': { endpoint: `http://localhost:${counter.port}` } } })
    await s.post({ trigger: 'refresh' })
    expect(row(await s.agents())).toMatchObject({ state: 'invalid', endpoint: null, where: 'local', profile: null, fix: 'run npm run meshctl -- status' })
    expect(counter.connections).toBe(0)
    // a profile name that fails its rule is not shown
    const odd = setup({ schema: 1, agents: { 'unslop-code': { endpoint: 'http://127.0.0.1:4421', profile: '../x' } } })
    expect(row(await odd.agents()).profile).toBeNull()
  })

  it('its usage line comes from mesh/unslop-code-budget.json only, and unslop\'s from its own file', async () => {
    const s = setup({ schema: 1, agents: { unslop: { endpoint: `http://127.0.0.1:${await freePort()}`, profile: 'unslop' }, 'unslop-code': { endpoint: `http://127.0.0.1:${await freePort()}`, profile: 'unslop-code' } } })
    mkdirSync(join(s.dir, 'mesh'))
    writeFileSync(join(s.dir, 'mesh', 'unslop-code-budget.json'), JSON.stringify({ date: ymd(s.clock.t), tasks: 7, modelMs: 360000 }), { mode: 0o600 })
    await s.post({ trigger: 'refresh' })
    let body = await s.agents()
    expect(row(body, 'unslop-code').usage).toEqual({ date: ymd(s.clock.t), tasks: 7, modelMs: 360000 })
    expect(row(body, 'unslop')).not.toHaveProperty('usage')
    writeFileSync(join(s.dir, 'mesh', 'unslop-budget.json'), JSON.stringify({ date: ymd(s.clock.t), tasks: 2, modelMs: 60000 }), { mode: 0o600 })
    writeFileSync(join(s.dir, 'mesh', 'unslop-code-budget.json'), JSON.stringify({ date: ymd(s.clock.t - 24 * 3600_000), tasks: 9, modelMs: 1 }), { mode: 0o600 })
    s.clock.t += 5_000
    await s.post({ trigger: 'refresh' })
    body = await s.agents()
    expect(row(body, 'unslop').usage).toEqual({ date: ymd(s.clock.t), tasks: 2, modelMs: 60000 })
    // yesterday's counts read as zero for today
    expect(row(body, 'unslop-code').usage).toEqual({ date: ymd(s.clock.t), tasks: 0, modelMs: 0 })
    // a refused file (here a symlink) sends no usage
    renameSync(join(s.dir, 'mesh', 'unslop-code-budget.json'), join(s.dir, 'mesh', 'real.json'))
    symlinkSync(join(s.dir, 'mesh', 'real.json'), join(s.dir, 'mesh', 'unslop-code-budget.json'))
    s.clock.t += 5_000
    await s.post({ trigger: 'refresh' })
    expect(row(await s.agents(), 'unslop-code')).not.toHaveProperty('usage')
  })

  it('its runs come from its own day files: lastRun, the list, the forget command, and unslop\'s runs stay apart', async () => {
    const s = setup({ schema: 1, agents: { unslop: { endpoint: 'http://127.0.0.1:4420', profile: 'unslop' }, 'unslop-code': { endpoint: 'http://127.0.0.1:4421', profile: 'unslop-code' } } })
    const dir = join(s.dir, 'mesh', 'runs')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    const day = ymd(s.clock.t)
    const record = (agent: string, id: string, at: number, extra: Json) => {
      const file = join(dir, `${agent}-${day}.jsonl`)
      appendFileSync(file, `${JSON.stringify({ v: 1, id, agent, at: new Date(at).toISOString(), ms: 900, exit: 0, outcome: 'ok', ...extra })}\n`, { mode: 0o600 })
      chmodSync(file, 0o600)
    }
    record('unslop-code', 'abcdefghij', s.clock.t - 120_000, { op: 'clean', status: 'cleaned', files: 3, bytesIn: 4096, removed: 12, suggestions: 2, model: 'coder-test', timing: { queued: 1, load: 2, model: 800 } })
    record('unslop-code', 'bcdefghijk', s.clock.t - 60_000, { op: 'clean', exit: 11, outcome: 'refused', reason: 'malformed' })
    record('unslop', 'cdefghijkl', s.clock.t - 30_000, { op: 'docs' })
    const body = await s.agents()
    expect(row(body, 'unslop-code').lastRun).toEqual({ at: new Date(s.clock.t - 60_000).toISOString(), op: 'clean', outcome: 'refused' })
    expect(row(body, 'unslop').lastRun).toEqual({ at: new Date(s.clock.t - 30_000).toISOString(), op: 'docs', outcome: 'ok' })
    const runs = await (await s.app.request('/api/mesh/agents/runs?name=unslop-code')).json()
    expect(runs).toMatchObject({ on: true, name: 'unslop-code', older: false, forget: 'npm run meshctl -- forget-runs --unslop-code' })
    expect(runs.runs.map((r: Json) => [r.id, r.agent, r.op, r.outcome])).toEqual([['bcdefghijk', 'unslop-code', 'clean', 'refused'], ['abcdefghij', 'unslop-code', 'clean', 'ok']])
    expect(runs.runs[1]).toMatchObject({ status: 'cleaned', files: 3, bytesIn: 4096, removed: 12, suggestions: 2, model: 'coder-test', timing: { queued: 1, load: 2, model: 800 } })
    expect(runs.runs[1]).not.toHaveProperty('path')
    // not configured: ok:false, as for any known agent mesh.json does not hold
    const only = setup(unslopAt(await freePort()))
    expect(await (await only.app.request('/api/mesh/agents/runs?name=unslop-code')).json()).toEqual({ ok: false, error: 'not configured' })
    expect(await (await only.post({ trigger: 'refresh', name: 'unslop-code' })).json()).toEqual({ ok: false, error: 'not configured' })
  })

  it('an open or a refresh naming it checks only it, with its own 60 s and 5 s skips', async () => {
    const code = await serve(UNSLOP_CODE)
    const plain = await serve(UNSLOP)
    const s = setup({ schema: 1, agents: { unslop: { endpoint: `http://127.0.0.1:${plain.port}` }, 'unslop-code': { endpoint: `http://127.0.0.1:${code.port}` } } })
    await s.post({ trigger: 'open', name: 'unslop-code' })
    expect([code.connections, plain.connections]).toEqual([1, 0])
    s.clock.t += 30_000
    await s.post({ trigger: 'open', name: 'unslop-code' })
    expect(code.connections).toBe(1)
    await s.post({ trigger: 'refresh', name: 'unslop-code' })
    expect(code.connections).toBe(2)
    expect(plain.connections).toBe(0)
  })
})
