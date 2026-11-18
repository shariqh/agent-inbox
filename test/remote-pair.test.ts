// Pairing a device with the remote entry (#617, PR 2b; design
// docs/superpowers/specs/2026-11-17-remote-inbox-design.md §3.2 "Pairing" and "The gate, in order"
// step 7). The code is made by POST /api/remote-entry/code on the loopback app, behind the owner
// token; the device pairs with POST /api/remote/pair on the remote entry, which passes with the
// login alone. Real HTTP against the real listeners on scratch ports, built as
// src/viewer-server.ts builds them, with an injected clock.
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmodSync, readFileSync, readdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../src/store.js'
import { createViewer } from '../src/viewer.js'
import { startLocalViewer } from '../src/viewer-network.js'
import { startRemoteEntry } from '../src/viewer-remote.js'
import type { RemoteEntry } from '../src/viewer-remote.js'
import { createPairing, normaliseCode, remoteCodeRoute } from '../src/remote-pair.js'
import { Hono } from 'hono'
import { once } from 'node:events'
import { removeScratchDirs, scratchDir } from './scratch.js'
import { waitUntil } from './wait.js'
import {
  HOST, LOGIN, ORIGIN, device, deviceHeaders, freePort, newSecret, rawRequest, secretSha256, setting, writeSetting,
} from './remote-fixtures.js'
import type { RawResponse } from './remote-fixtures.js'

type Reason = 'host' | 'funnel' | 'login' | 'path' | 'origin' | 'device' | 'route' | 'pair'

const OWNER_TOKEN = 'owner-token-for-the-test-0123456789'
const START = Date.parse('2026-11-20T09:00:00.000Z')
const CODE_SHAPE = /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/
const PAIR_HEADERS: Array<[string, string]> = [['Host', HOST], ['Tailscale-User-Login', LOGIN], ['Origin', ORIGIN]]

interface Hub {
  dir: string
  file: string
  port: number
  localPort: number
  entry: RemoteEntry
  clock: { now: number }
}

const open: Array<{ entry: RemoteEntry; local: Server; db: Database.Database }> = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const { entry, local, db } of open.splice(0)) {
    await entry.close()
    local.close()
    db.close()
  }
  removeScratchDirs()
})

function viewerOpts(home: string) {
  return { agentHome: home, runtimeRoot: join(home, 'runtime'), setupInfoPath: join(home, 'setup-info.json'), stamp: async () => ({ commit: null, dirty: false }) as never }
}

/** A hub as src/viewer-server.ts composes it: the remote entry, and the loopback app with the status and code routes. */
async function startHub(opts: {
  devices?: unknown[]
  extra?: Record<string, unknown>
  value?: (port: number) => unknown
  ownerToken?: string | null
  intervalMs?: number
  listen?: boolean
} = {}): Promise<Hub> {
  const dir = scratchDir('remote-pair-')
  const db = openDb(join(dir, 'inbox.db'))
  const port = await freePort()
  const file = writeSetting(dir, opts.value ? opts.value(port) : setting(port, opts.devices ?? [], opts.extra ?? {}))
  const clock = { now: START }
  const remoteApp = createViewer(db, viewerOpts(dir))
  remoteApp.get('/*', serveStatic({ root: './public' }))
  const entry = startRemoteEntry({ app: remoteApp, dir, viewerPort: 4319, intervalMs: opts.intervalMs ?? 3_600_000, now: () => clock.now })
  const ownerToken = opts.ownerToken === undefined ? OWNER_TOKEN : opts.ownerToken
  const app = createViewer(db, { ...viewerOpts(dir), ...(ownerToken ? { ownerToken } : {}) })
  app.get('/api/remote-entry', (c) => c.json(entry.status()))
  if (ownerToken) app.post('/api/remote-entry/code', remoteCodeRoute(entry, ownerToken))
  app.get('/*', serveStatic({ root: './public' }))
  const local = startLocalViewer(app, 0)
  open.push({ entry, local, db })
  await waitUntil(() => local.listening, 'the loopback viewer')
  if (opts.listen !== false) await waitUntil(() => entry.status().listening, 'the remote entry')
  return { dir, file, port, localPort: (local.address() as { port: number }).port, entry, clock }
}

/** POST /api/remote-entry/code over the loopback listener, as the desktop app's main will. */
async function postCode(hub: Hub, headers: Record<string, string> = { 'X-Agent-Inbox-Owner': OWNER_TOKEN }): Promise<Response> {
  return fetch(`http://127.0.0.1:${hub.localPort}/api/remote-entry/code`, {
    method: 'POST',
    headers: { Origin: `http://127.0.0.1:${hub.localPort}`, ...headers },
  })
}

async function makeCodeWithId(hub: Hub): Promise<{ code: string; codeId: string }> {
  const response = await postCode(hub)
  expect(response.status).toBe(200)
  return await response.json() as { code: string; codeId: string }
}

async function makeCode(hub: Hub): Promise<string> {
  return (await makeCodeWithId(hub)).code
}

/** One pairing request through the remote entry. The clock moves 6.1 s first, so a run of requests stays under ten a minute. */
function pair(hub: Hub, body: unknown, opts: {
  headers?: Array<[string, string]>; target?: string; method?: string; contentType?: string | null; advance?: number
} = {}): Promise<RawResponse> {
  hub.clock.now += opts.advance ?? 6_100
  return rawRequest(hub.port, {
    method: opts.method ?? 'POST',
    target: opts.target ?? '/api/remote/pair',
    headers: opts.headers ?? PAIR_HEADERS,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    contentType: opts.contentType,
  })
}

/** Send, and say which counter rose (exactly one may rise on a refusal, none on success). */
async function attempt(hub: Hub, request: () => Promise<RawResponse>): Promise<{ response: RawResponse; rose: Reason[] }> {
  const before = { ...hub.entry.status().refused }
  const response = await request()
  const after = hub.entry.status().refused
  const rose = (Object.keys(after) as Reason[]).filter((key) => after[key] !== before[key])
  for (const key of rose) expect(after[key] - before[key], key).toBe(1)
  return { response, rose }
}

/** A refusal: the bare 403, no header from the entry or the app, counted under exactly one reason. */
async function expectRefused(hub: Hub, reason: Reason, request: () => Promise<RawResponse>, method = 'POST') {
  const { response, rose } = await attempt(hub, request)
  expect(response.status).toBe(403)
  expect(response.body).toBe(method === 'HEAD' ? '' : 'Forbidden')
  expect(rose).toEqual([reason])
  expect(response.headers['x-agent-inbox-remote-boundary']).toBeUndefined()
  expect(response.headers['x-agent-inbox-local-boundary']).toBeUndefined()
  expect(response.headers['content-security-policy']).toBeUndefined()
  expect(response.headers['x-inbox-boot']).toBeUndefined()
  expect(response.headers['cache-control']).toBeUndefined()
  return response
}

async function expectPaired(hub: Hub, request: () => Promise<RawResponse>): Promise<{ device: string; secret: string }> {
  const { response, rose } = await attempt(hub, request)
  expect(response.status, response.body).toBe(200)
  expect(rose).toEqual([])
  expect(response.headers['x-agent-inbox-remote-boundary']).toBe('tailnet-v1')
  expect(response.headers['cache-control']).toBe('no-store')
  expect(response.headers['x-frame-options']).toBe('DENY')
  expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'")
  expect(response.headers['x-agent-inbox-local-boundary']).toBeUndefined()
  const body = JSON.parse(response.body) as { ok: boolean; device: string; secret: string }
  expect(Object.keys(body).sort()).toEqual(['device', 'ok', 'secret'])
  expect(body.ok).toBe(true)
  expect(body.device).toMatch(/^[0-9a-f]{16}$/)
  expect(body.secret).toMatch(/^[A-Za-z0-9_-]{43}$/)
  return { device: body.device, secret: body.secret }
}

const devicesIn = (hub: Hub) => (JSON.parse(readFileSync(hub.file, 'utf8')) as { devices?: Array<Record<string, unknown>> }).devices ?? []

/** A well-formed code that is not `code`. */
function wrongCode(code: string): string {
  const plain = code.replace('-', '')
  const last = plain[9] === 'Z' ? 'Y' : 'Z'
  return `${plain.slice(0, 5)}-${plain.slice(5, 9)}${last}`
}

describe('the code', () => {
  it('is 10 Crockford base32 characters in two groups of five, valid 10 minutes, with no-store', async () => {
    const hub = await startHub()
    const response = await postCode(hub)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json() as { code: string; codeId: string; expiresAt: string }
    expect(Object.keys(body).sort()).toEqual(['code', 'codeId', 'expiresAt'])
    expect(body.code).toMatch(CODE_SHAPE)
    expect(body.expiresAt).toBe(new Date(START + 10 * 60_000).toISOString())
  })

  it('has an identity: 16 random hex characters, new for each code, unrelated to the code', async () => {
    const hub = await startHub()
    const ids = new Set<string>()
    for (let i = 0; i < 20; i += 1) {
      const { code, codeId } = await makeCodeWithId(hub)
      expect(codeId).toMatch(/^[0-9a-f]{16}$/)
      const plain = code.replace('-', '')
      for (const hash of ['sha256', 'sha1', 'md5']) expect(crypto.createHash(hash).update(plain).digest('hex')).not.toContain(codeId)
      ids.add(codeId)
    }
    expect(ids.size).toBe(20)
  })

  it('draws every character from the alphabet, from node:crypto', async () => {
    const hub = await startHub()
    const draws = vi.spyOn(crypto, 'randomInt')
    const seen = new Set<string>()
    for (let i = 0; i < 40; i += 1) for (const ch of (await makeCode(hub)).replace('-', '')) seen.add(ch)
    expect(draws).toHaveBeenCalled()
    for (const call of draws.mock.calls) expect(call).toEqual([32])
    for (const ch of seen) expect('0123456789ABCDEFGHJKMNPQRSTVWXYZ').toContain(ch)
    // 400 draws of 32 letters: every letter of the alphabet shows up (a miss is about 1 in 10^4)
    expect(seen.size).toBeGreaterThan(28)
  })

  it('pairs once, and never twice', async () => {
    const hub = await startHub()
    const code = await makeCode(hub)
    expect(hub.entry.status().codePending).toBe(true)
    const paired = await expectPaired(hub, () => pair(hub, { code, label: 'laptop' }))
    expect(hub.entry.status().codePending).toBe(false)
    await expectRefused(hub, 'pair', () => pair(hub, { code, label: 'laptop' }))
    expect(devicesIn(hub).map((d) => d['id'])).toEqual([paired.device])
  })

  it('expires 10 minutes after it was made', async () => {
    const hub = await startHub()
    const code = await makeCode(hub)
    hub.clock.now = START + 10 * 60_000
    await expectRefused(hub, 'pair', () => pair(hub, { code, label: 'laptop' }, { advance: 0 }))
    expect(hub.entry.status().codePending).toBe(false)
    // and a second one is good until just before
    const next = await makeCode(hub)
    hub.clock.now += 10 * 60_000 - 1
    await expectPaired(hub, () => pair(hub, { code: next, label: 'laptop' }, { advance: 0 }))
  })

  it('reads a clock that went back as expired', async () => {
    const hub = await startHub()
    const code = await makeCode(hub)
    hub.clock.now = START - 1
    await expectRefused(hub, 'pair', () => pair(hub, { code, label: 'laptop' }, { advance: 0 }))
    expect(hub.entry.status().codePending).toBe(false)
  })

  it('is void after five wrong tries, and the right code then fails', async () => {
    const hub = await startHub()
    const code = await makeCode(hub)
    for (let i = 0; i < 5; i += 1) await expectRefused(hub, 'pair', () => pair(hub, { code: wrongCode(code), label: 'laptop' }))
    expect(hub.entry.status().codePending).toBe(false)
    await expectRefused(hub, 'pair', () => pair(hub, { code, label: 'laptop' }))
    expect(devicesIn(hub)).toEqual([])
  })

  it('is not void after four wrong tries', async () => {
    const hub = await startHub()
    const code = await makeCode(hub)
    for (let i = 0; i < 4; i += 1) await expectRefused(hub, 'pair', () => pair(hub, { code: wrongCode(code), label: 'laptop' }))
    expect(hub.entry.status().codePending).toBe(true)
    await expectPaired(hub, () => pair(hub, { code, label: 'laptop' }))
  })

  it('a newer code voids the older one, and only the newer pairs', async () => {
    const hub = await startHub()
    const older = await makeCode(hub)
    const newer = await makeCode(hub)
    await expectRefused(hub, 'pair', () => pair(hub, { code: older, label: 'laptop' }))
    await expectPaired(hub, () => pair(hub, { code: newer, label: 'laptop' }))
  })

  it('a newer code starts with five fresh tries', async () => {
    const hub = await startHub()
    const older = await makeCode(hub)
    for (let i = 0; i < 4; i += 1) await expectRefused(hub, 'pair', () => pair(hub, { code: wrongCode(older), label: 'laptop' }))
    const newer = await makeCode(hub)
    for (let i = 0; i < 4; i += 1) await expectRefused(hub, 'pair', () => pair(hub, { code: wrongCode(newer), label: 'laptop' }))
    await expectPaired(hub, () => pair(hub, { code: newer, label: 'laptop' }))
  })

  it('with no code ever made, every pairing is refused', async () => {
    const hub = await startHub()
    expect(hub.entry.status().codePending).toBe(false)
    await expectRefused(hub, 'pair', () => pair(hub, { code: '7K3QX-9M2PD', label: 'laptop' }))
  })

  it('two requests racing with the right code pair one device', async () => {
    const hub = await startHub()
    const code = await makeCode(hub)
    const before = hub.entry.status().refused.pair
    const answers = await Promise.all([1, 2, 3].map(() => pair(hub, { code, label: 'laptop' }, { advance: 0 })))
    expect(answers.map((a) => a.status).sort()).toEqual([200, 403, 403])
    expect(hub.entry.status().refused.pair - before).toBe(2)
    expect(devicesIn(hub)).toHaveLength(1)
  })

  it('over real HTTP: eight requests that release the right code\'s body in the same tick pair one device', async () => {
    const hub = await startHub()
    const code = await makeCode(hub)
    const body = JSON.stringify({ code, label: 'laptop' })
    const sockets = Array.from({ length: 8 }, () => connect(hub.port, '127.0.0.1'))
    await Promise.all(sockets.map((socket) => once(socket, 'connect')))
    const answers = sockets.map((socket) => new Promise<number>((resolve, reject) => {
      let text = ''
      socket.on('data', (chunk) => { text += chunk.toString() })
      socket.on('end', () => resolve(Number(text.split(' ')[1])))
      socket.on('error', reject)
    }))
    const head = [...PAIR_HEADERS.map(([k, v]) => `${k}: ${v}`), 'Content-Type: application/json', `Content-Length: ${Buffer.byteLength(body)}`, 'Connection: close']
    for (const socket of sockets) socket.write(`POST /api/remote/pair HTTP/1.1\r\n${head.join('\r\n')}\r\n\r\n`)
    // every request is in the handler by now, waiting for its body
    await new Promise((resolve) => setTimeout(resolve, 300))
    for (const socket of sockets) socket.write(body)
    expect((await Promise.all(answers)).sort()).toEqual([200, 403, 403, 403, 403, 403, 403, 403])
    expect(devicesIn(hub)).toHaveLength(1)
    expect(hub.entry.status().refused.pair).toBe(7)
  })

  it('in process: concurrent calls of the handler with the right code pair once', async () => {
    const dir = scratchDir('remote-pair-')
    const file = join(dir, 'remote.json')
    writeFileSync(file, JSON.stringify({ devices: [] }), { mode: 0o600 })
    let refusals = 0
    const pairing = createPairing<null>({
      file,
      maxBytes: 64 * 1024,
      now: () => START,
      read: (path) => ({ ok: true, setting: null, doc: JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> }),
      stillOn: () => true,
      refused: () => { refusals += 1 },
    })
    const app = new Hono()
    app.post('/pair', pairing.handler)
    const { code } = pairing.makeCode()
    const incoming = { rawHeaders: ['Content-Type', 'application/json'] }
    const answers = await Promise.all(Array.from({ length: 8 }, () => app.request('/pair', {
      method: 'POST', body: JSON.stringify({ code, label: 'laptop' }), headers: { 'content-type': 'application/json' },
    }, { incoming })))
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 403, 403, 403, 403, 403, 403, 403])
    expect(refusals).toBe(7)
    expect((JSON.parse(readFileSync(file, 'utf8')) as { devices: unknown[] }).devices).toHaveLength(1)
  })

  it('compares SHA-256 digests with timingSafeEqual', async () => {
    const hub = await startHub()
    const code = await makeCode(hub)
    const timing = vi.spyOn(crypto, 'timingSafeEqual')
    await expectRefused(hub, 'pair', () => pair(hub, { code: wrongCode(code), label: 'laptop' }))
    expect(timing).toHaveBeenCalledTimes(1)
    const [a, b] = timing.mock.calls[0]!
    expect((a as Buffer).length).toBe(32)
    expect((b as Buffer).length).toBe(32)
  })
})

describe('Crockford normalisation', () => {
  it('ignores case, spaces and dashes, reads I and L as 1 and O as 0', () => {
    expect(normaliseCode('7k3qx-9m2pd')).toBe('7K3QX9M2PD')
    expect(normaliseCode(' 7K3 QX9M- 2PD ')).toBe('7K3QX9M2PD')
    expect(normaliseCode('7--K3QX9M2PD')).toBe('7K3QX9M2PD')
    expect(normaliseCode('IL0O1-iloo1')).toBe('1100111001')
  })

  it.each([
    ['a U', '7K3QX-9M2PU'],
    ['nine characters', '7K3QX-9M2P'],
    ['eleven characters', '7K3QX-9M2PDA'],
    ['empty', ''],
    ['only dashes', '----------'],
    ['a dotless i (upper-cases to I)', '7K3QX-9M2Pı'],
    ['a long s (upper-cases to S)', '7K3QX-9M2Pſ'],
    ['a fullwidth digit', '7K3QX-9M2P７'],
    ['a tab', '7K3QX\t9M2PD'],
    ['an underscore', '7K3QX_9M2PD'],
    ['a dot', '7K3QX.9M2PD'],
  ])('refuses %s', (_name, text) => {
    expect(normaliseCode(text)).toBeNull()
  })

  it('pairs with the code typed in lower case, with spaces and with extra dashes', async () => {
    for (const typed of [(c: string) => c.toLowerCase(), (c: string) => c.replace('-', ' '), (c: string) => c.split('').join('-')]) {
      const hub = await startHub()
      const code = await makeCode(hub)
      await expectPaired(hub, () => pair(hub, { code: typed(code), label: 'laptop' }))
    }
  })

  it('pairs with I or L typed for 1 and O for 0', async () => {
    const hub = await startHub()
    // make codes until one holds both a 1 and a 0 (about one in fourteen does)
    let code = ''
    for (let i = 0; i < 2000 && !(code.includes('1') && code.includes('0')); i += 1) code = await makeCode(hub)
    expect(code).toMatch(/1/)
    expect(code).toMatch(/0/)
    const typed = code.replace(/1/, 'I').replace(/1/g, 'l').replace(/0/g, 'o')
    await expectPaired(hub, () => pair(hub, { code: typed, label: 'laptop' }))
  })

  // Settled for this PR: a code string that does not normalise to 10 letters of the alphabet is a
  // guess that cannot match, and it uses one of the five tries (the reading that refuses more).
  it('a malformed code string uses a try: five of them void the code', async () => {
    const hub = await startHub()
    const code = await makeCode(hub)
    for (const bad of ['7K3QX-9M2PU', 'ABC', '', `${code}A`, 'ſſſſſſſſſſ']) {
      await expectRefused(hub, 'pair', () => pair(hub, { code: bad, label: 'laptop' }))
    }
    expect(hub.entry.status().codePending).toBe(false)
    await expectRefused(hub, 'pair', () => pair(hub, { code, label: 'laptop' }))
  })
})

describe('the rate limit', () => {
  it('lets at most ten requests a minute into the handler, counted when each arrives; one over the limit uses no try', async () => {
    const hub = await startHub()
    const code = await makeCode(hub)
    // four wrong tries and six malformed bodies: ten requests in the minute, four tries used
    for (let i = 0; i < 4; i += 1) await expectRefused(hub, 'pair', () => pair(hub, { code: wrongCode(code), label: 'laptop' }, { advance: 1 }))
    for (let i = 0; i < 6; i += 1) await expectRefused(hub, 'pair', () => pair(hub, 'not json', { advance: 1 }))
    // the eleventh, even with the right code, is refused before the code is looked at
    await expectRefused(hub, 'pair', () => pair(hub, { code, label: 'laptop' }, { advance: 1 }))
    // and the twelfth, a wrong code, would be the fifth try if it reached the comparison
    await expectRefused(hub, 'pair', () => pair(hub, { code: wrongCode(code), label: 'laptop' }, { advance: 1 }))
    expect(hub.entry.status().codePending).toBe(true)
    expect(devicesIn(hub)).toEqual([])
    // a minute after the first, the window has room again, and the code still has its fifth try
    hub.clock.now += 60_000
    await expectPaired(hub, () => pair(hub, { code, label: 'laptop' }, { advance: 0 }))
  })

  it('is one counter for the route, for every client', async () => {
    const hub = await startHub({ extra: { logins: [LOGIN, 'second@example.com'] } })
    const code = await makeCode(hub)
    for (let i = 0; i < 10; i += 1) await expectRefused(hub, 'pair', () => pair(hub, 'not json', { advance: 0 }))
    const other: Array<[string, string]> = [['Host', HOST], ['Tailscale-User-Login', 'second@example.com'], ['Origin', ORIGIN]]
    await expectRefused(hub, 'pair', () => pair(hub, { code, label: 'laptop' }, { headers: other, advance: 0 }))
  })
})

describe('the body', () => {
  const big = (code: string, size: number) => {
    const head = `{"code":${JSON.stringify(code)},`
    const tail = '"label":"laptop"}'
    return `${head}${' '.repeat(size - head.length - tail.length)}${tail}`
  }

  it.each([
    ['no Content-Type', (code: string) => ({ body: { code, label: 'laptop' }, contentType: null })],
    ['text/plain', (code: string) => ({ body: { code, label: 'laptop' }, contentType: 'text/plain' })],
    ['application/json with a charset', (code: string) => ({ body: { code, label: 'laptop' }, contentType: 'application/json; charset=utf-8' })],
    ['a form', (code: string) => ({ body: `code=${code}&label=laptop`, contentType: 'application/x-www-form-urlencoded' })],
    ['over 1 KiB (whitespace that JSON would ignore)', (code: string) => ({ body: big(code, 1025) })],
    ['not JSON', () => ({ body: 'code' })],
    ['empty', () => ({ body: '' })],
    ['a JSON array', (code: string) => ({ body: [code, 'laptop'] })],
    ['JSON null', () => ({ body: 'null' })],
    ['a JSON string', (code: string) => ({ body: JSON.stringify(code) })],
    ['no label', (code: string) => ({ body: { code } })],
    ['no code', () => ({ body: { label: 'laptop' } })],
    ['an extra key', (code: string) => ({ body: { code, label: 'laptop', admin: true } })],
    ['a number for the code', () => ({ body: { code: 1234567890, label: 'laptop' } })],
    ['a list for the code', (code: string) => ({ body: { code: [code], label: 'laptop' } })],
    ['a number for the label', (code: string) => ({ body: { code, label: 7 } })],
    ['a list for the label', (code: string) => ({ body: { code, label: ['laptop'] } })],
    ['an array-like object for the label', (code: string) => ({ body: { code, label: { 0: 'x', length: 1 } } })],
    ['a small number for the code', () => ({ body: { code: 7, label: 'laptop' } })],
    ['a list of one letter for the code', () => ({ body: { code: ['x'], label: 'laptop' } })],
    ['an empty JSON array', () => ({ body: '[]' })],
    ['a JSON string of text', () => ({ body: '"text"' })],
    ['a bidirectional override and a zero-width space in the label', (code: string) => ({ body: { code, label: 'lap‮exe.top​' } })],
    ['a zero-width space alone', (code: string) => ({ body: { code, label: '​' } })],
    ['a byte-order mark in the label', (code: string) => ({ body: { code, label: '﻿laptop' } })],
    ['a bidirectional isolate in the label', (code: string) => ({ body: { code, label: '⁦laptop⁩' } })],
    ['a zero-width joiner inside an emoji sequence', (code: string) => ({ body: { code, label: '\u{1F469}‍\u{1F4BB} desk' } })],
    ['an empty label', (code: string) => ({ body: { code, label: '' } })],
    ['a 41-character label', (code: string) => ({ body: { code, label: 'x'.repeat(41) } })],
    ['a newline in the label', (code: string) => ({ body: { code, label: 'lap\ntop' } })],
    ['a bell in the label', (code: string) => ({ body: { code, label: 'lap\u0007top' } })],
    ['a C1 control in the label', (code: string) => ({ body: { code, label: 'lap\u009ftop' } })],
    ['DEL in the label', (code: string) => ({ body: { code, label: 'lap\u007ftop' } })],
    ['a lone surrogate in the label', (code: string) => ({ body: `{"code":${JSON.stringify(code)},"label":"lap\\ud800top"}` })],
  ] as Array<[string, (code: string) => { body: unknown; contentType?: string | null }]>)('refuses %s, and uses no try', async (_name, make) => {
    const hub = await startHub()
    const code = await makeCode(hub)
    const { body, contentType } = make(code)
    // the right code in every body that has one: only the shape refuses it
    for (let i = 0; i < 5; i += 1) await expectRefused(hub, 'pair', () => pair(hub, body, { contentType }))
    expect(hub.entry.status().codePending).toBe(true)
    expect(devicesIn(hub)).toEqual([])
    await expectPaired(hub, () => pair(hub, { code, label: 'laptop' }))
  })

  it('refuses a repeated Content-Type, even when both say application/json', async () => {
    const hub = await startHub()
    const code = await makeCode(hub)
    await expectRefused(hub, 'pair', () => pair(hub, { code, label: 'laptop' }, { headers: [...PAIR_HEADERS, ['Content-Type', 'application/json']] }))
  })

  it('refuses a chunked body over 1 KiB, read only up to the limit', async () => {
    const hub = await startHub()
    const code = await makeCode(hub)
    const body = big(code, 4096)
    const chunked = `${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`
    const response = await attempt(hub, () => new Promise<RawResponse>((resolve, reject) => {
      const socket = connect(hub.port, '127.0.0.1')
      let text = ''
      socket.on('data', (chunk) => { text += chunk.toString() })
      socket.on('error', reject)
      socket.on('end', () => resolve({ status: Number(text.split(' ')[1]), headers: {}, body: text.split('\r\n\r\n')[1] ?? '' }))
      const head = [...PAIR_HEADERS.map(([k, v]) => `${k}: ${v}`), 'Content-Type: application/json', 'Transfer-Encoding: chunked', 'Connection: close']
      socket.write(`POST /api/remote/pair HTTP/1.1\r\n${head.join('\r\n')}\r\n\r\n${chunked}`)
    }))
    expect(response.response.status).toBe(403)
    expect(response.rose).toEqual(['pair'])
    expect(hub.entry.status().codePending).toBe(true)
  })

  it('refuses a Content-Length over 1 KiB at once, without waiting for the body', async () => {
    const hub = await startHub()
    const code = await makeCode(hub)
    const started = Date.now()
    const response = await attempt(hub, () => new Promise<RawResponse>((resolve, reject) => {
      const socket = connect(hub.port, '127.0.0.1')
      let text = ''
      socket.on('data', (chunk) => {
        text += chunk.toString()
        // the answer came while most of the announced body was never sent
        if (text.includes('\r\n\r\n')) {
          socket.destroy()
          resolve({ status: Number(text.split(' ')[1]), headers: {}, body: text.split('\r\n\r\n')[1] ?? '' })
        }
      })
      socket.on('error', reject)
      const head = [...PAIR_HEADERS.map(([k, v]) => `${k}: ${v}`), 'Content-Type: application/json', 'Content-Length: 100000']
      socket.write(`POST /api/remote/pair HTTP/1.1\r\n${head.join('\r\n')}\r\n\r\n{"code":"${code}"`)
    }))
    expect(response.response.status).toBe(403)
    expect(response.rose).toEqual(['pair'])
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(hub.entry.status().codePending).toBe(true)
  })

  it('takes a label with an emoji and accents that holds no format character', async () => {
    const hub = await startHub()
    const code = await makeCode(hub)
    await expectPaired(hub, () => pair(hub, { code, label: '\u{1F600} Zoë\'s laptop' }))
    expect(devicesIn(hub).map((d) => d['label'])).toEqual(['\u{1F600} Zoë\'s laptop'])
  })

  it('takes a body of exactly 1 KiB and a 40-character label', async () => {
    const hub = await startHub()
    const code = await makeCode(hub)
    await expectPaired(hub, () => pair(hub, big(code, 1024)))
    const next = await makeCode(hub)
    await expectPaired(hub, () => pair(hub, { code: next, label: 'é'.repeat(40) }))
    expect(devicesIn(hub).map((d) => d['label'])).toEqual(['laptop', 'é'.repeat(40)])
  })
})

describe('the device it adds', () => {
  it('answers the secret once and stores only its SHA-256', async () => {
    const hub = await startHub()
    const code = await makeCode(hub)
    const { device: id, secret } = await expectPaired(hub, () => pair(hub, { code, label: 'laptop' }))
    const text = readFileSync(hub.file, 'utf8')
    expect(text).not.toContain(secret)
    expect(devicesIn(hub)).toEqual([{ id, label: 'laptop', secretSha256: secretSha256(secret), pairedAt: new Date(hub.clock.now).toISOString() }])
    // a second request with the same code answers no secret
    const again = await expectRefused(hub, 'pair', () => pair(hub, { code, label: 'laptop' }))
    expect(again.body).not.toContain(secret)
    expect(JSON.stringify(hub.entry.status())).not.toContain(secret)
  })

  it('passes step 8 on the next request; a made-up secret does not', async () => {
    const hub = await startHub()
    const code = await makeCode(hub)
    const { secret } = await expectPaired(hub, () => pair(hub, { code, label: 'laptop' }))
    const ok = await attempt(hub, () => rawRequest(hub.port, { target: '/api/items', headers: deviceHeaders(secret) }))
    expect(ok.response.status).toBe(200)
    expect(ok.rose).toEqual([])
    const made = await attempt(hub, () => rawRequest(hub.port, { target: '/api/items', headers: deviceHeaders(newSecret()) }))
    expect(made.response.status).toBe(403)
    expect(made.rose).toEqual(['device'])
  })

  it('ignores a device header sent with the pairing request', async () => {
    const hub = await startHub()
    const garbage = await makeCode(hub)
    await expectPaired(hub, () => pair(hub, { code: garbage, label: 'laptop' }, { headers: [...PAIR_HEADERS, ['X-Agent-Inbox-Device', 'not-a-secret']] }))
    const made = await makeCode(hub)
    await expectPaired(hub, () => pair(hub, { code: made, label: 'laptop' }, { headers: [...PAIR_HEADERS, ['X-Agent-Inbox-Device', newSecret()]] }))
  })

  it('keeps every field it does not know, at the top level and inside each device', async () => {
    const kept = { ...device(newSecret(), 'aaaaaaaaaaaaaaaa'), colour: 'blue', future: { nested: [1, 'two', null, true] } }
    const hub = await startHub({ devices: [kept], extra: { note: 'kept', later: { a: [1, { b: 'c' }] }, zeta: null } })
    const before = JSON.parse(readFileSync(hub.file, 'utf8')) as Record<string, unknown>
    const code = await makeCode(hub)
    const { device: id, secret } = await expectPaired(hub, () => pair(hub, { code, label: 'laptop' }))
    const after = JSON.parse(readFileSync(hub.file, 'utf8')) as Record<string, unknown>
    expect(after).toEqual({
      ...before,
      devices: [kept, { id, label: 'laptop', secretSha256: secretSha256(secret), pairedAt: new Date(hub.clock.now).toISOString() }],
    })
    expect(Object.keys(after)).toEqual(Object.keys(before))
  })

  it('creates the devices list when the file has none', async () => {
    const hub = await startHub({
      value: (port) => {
        const value: Record<string, unknown> = setting(port, [])
        delete value['devices']
        return value
      },
    })
    const code = await makeCode(hub)
    const { device: id } = await expectPaired(hub, () => pair(hub, { code, label: 'laptop' }))
    expect(devicesIn(hub).map((d) => d['id'])).toEqual([id])
  })

  it('writes the file 0600 by temp file and rename, and leaves no lock or temp file', async () => {
    const hub = await startHub()
    const inode = statSync(hub.file).ino
    const code = await makeCode(hub)
    await expectPaired(hub, () => pair(hub, { code, label: 'laptop' }))
    const stat = statSync(hub.file)
    expect(stat.mode & 0o777).toBe(0o600)
    expect(stat.ino).not.toBe(inode)
    expect(readdirSync(hub.dir).filter((name) => name.includes('remote'))).toEqual(['remote.json'])
  })

  it('makes an id that is not already in the file', async () => {
    const hub = await startHub({ devices: [device(newSecret(), 'aaaaaaaaaaaaaaaa')] })
    // the first id drawn is one the file holds already
    const real = crypto.randomBytes
    let ids = 0
    vi.spyOn(crypto, 'randomBytes').mockImplementation(((size: number) => (size === 8 && ids++ === 0 ? Buffer.from('aaaaaaaaaaaaaaaa', 'hex') : real(size))) as never)
    const code = await makeCode(hub)
    const { device: id } = await expectPaired(hub, () => pair(hub, { code, label: 'laptop' }))
    expect(id).not.toBe('aaaaaaaaaaaaaaaa')
    expect(devicesIn(hub).map((d) => d['id'])).toEqual(['aaaaaaaaaaaaaaaa', id])
  })

  it('refuses with 16 devices in the file, and the code stays void', async () => {
    const sixteen = Array.from({ length: 16 }, (_, i) => device(newSecret(), i.toString(16).padStart(16, '0')))
    const hub = await startHub({ devices: sixteen })
    const before = readFileSync(hub.file, 'utf8')
    const code = await makeCode(hub)
    await expectRefused(hub, 'pair', () => pair(hub, { code, label: 'laptop' }))
    expect(readFileSync(hub.file, 'utf8')).toBe(before)
    expect(hub.entry.status().codePending).toBe(false)
  })

  it('refuses a write that would take the file past 64 KiB', async () => {
    // 100 bytes under the reader's 64 KiB as written; a device entry is longer than that
    const hub = await startHub({
      value: (port) => {
        const bare = JSON.stringify(setting(port, [], { padding: '' })).length
        return setting(port, [], { padding: 'x'.repeat(64 * 1024 - 100 - bare) })
      },
    })
    const before = readFileSync(hub.file, 'utf8')
    expect(before.length).toBe(64 * 1024 - 100)
    const code = await makeCode(hub)
    await expectRefused(hub, 'pair', () => pair(hub, { code, label: 'laptop' }))
    expect(readFileSync(hub.file, 'utf8')).toBe(before)
  })
})

describe('the write, under the lock', () => {
  /** Hold remote.json's lock, send the pairing, change the file while it waits, then release. */
  async function whileLocked(hub: Hub, change: () => void): Promise<RawResponse> {
    const code = await makeCode(hub)
    const lock = `${hub.file}.lock`
    writeFileSync(lock, '', { flag: 'wx', mode: 0o600 })
    const sent = attempt(hub, () => pair(hub, { code, label: 'laptop' }))
    // the code is voided just before the write takes the lock
    await waitUntil(() => !hub.entry.status().codePending, 'the pairing to reach the lock')
    await new Promise((resolve) => setTimeout(resolve, 60))
    change()
    unlinkSync(lock)
    const { response, rose } = await sent
    expect(rose).toEqual(['pair'])
    return response
  }

  it('waits for the lock another process holds, then writes', async () => {
    const hub = await startHub()
    const code = await makeCode(hub)
    const lock = `${hub.file}.lock`
    writeFileSync(lock, '', { flag: 'wx', mode: 0o600 })
    const sent = pair(hub, { code, label: 'laptop' })
    await waitUntil(() => !hub.entry.status().codePending, 'the pairing to reach the lock')
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(devicesIn(hub)).toEqual([])
    unlinkSync(lock)
    expect((await sent).status).toBe(200)
    expect(devicesIn(hub)).toHaveLength(1)
  })

  it('keeps a device another writer added while it waited', async () => {
    const hub = await startHub()
    const other = device(newSecret(), 'bbbbbbbbbbbbbbbb')
    const code = await makeCode(hub)
    const lock = `${hub.file}.lock`
    writeFileSync(lock, '', { flag: 'wx', mode: 0o600 })
    const sent = pair(hub, { code, label: 'laptop' })
    await waitUntil(() => !hub.entry.status().codePending, 'the pairing to reach the lock')
    writeSetting(hub.dir, setting(hub.port, [other], { note: 'written by main' }))
    unlinkSync(lock)
    expect((await sent).status).toBe(200)
    const after = JSON.parse(readFileSync(hub.file, 'utf8')) as { note: string; devices: Array<{ id: string }> }
    expect(after.note).toBe('written by main')
    expect(after.devices.map((d) => d.id)[0]).toBe('bbbbbbbbbbbbbbbb')
    expect(after.devices).toHaveLength(2)
  })

  it.each([
    ['a newer schema', (port: number) => setting(port, [], { schema: 2 }), 0o600],
    ['group bits', (port: number) => setting(port, []), 0o640],
    ['other bits', (port: number) => setting(port, []), 0o604],
    ['turned off', (port: number) => setting(port, [], { enabled: false }), 0o600],
    ['for another viewer', (port: number) => setting(port, [], { viewerPort: 4392 }), 0o600],
    ['moved to another port', (port: number) => setting(port + 1, []), 0o600],
    ['the login no longer allowed', (port: number) => setting(port, [], { logins: ['second@example.com'] }), 0o600],
    ['another host', (port: number) => setting(port, [], { host: 'other.example.ts.net' }), 0o600],
    ['16 devices', (port: number) => setting(port, Array.from({ length: 16 }, (_, i) => device(newSecret(), i.toString(16).padStart(16, '0')))), 0o600],
    ['an invalid field', (port: number) => setting(port, [], { logins: [] }), 0o600],
    ['not JSON', () => '{"schema":1,', 0o600],
  ] as Array<[string, (port: number) => unknown, number]>)('is not written when the file changed to %s', async (_name, value, mode) => {
    const hub = await startHub()
    let written = ''
    const response = await whileLocked(hub, () => {
      writeSetting(hub.dir, value(hub.port), mode)
      written = readFileSync(hub.file, 'utf8')
    })
    expect(response.status).toBe(403)
    expect(readFileSync(hub.file, 'utf8')).toBe(written)
    expect(statSync(hub.file).mode & 0o777).toBe(mode)
  })

  it('is not written when the file became a symlink', async () => {
    const hub = await startHub()
    const real = join(hub.dir, 'elsewhere.json')
    await whileLocked(hub, () => {
      writeFileSync(real, JSON.stringify(setting(hub.port, [])), { mode: 0o600 })
      unlinkSync(hub.file)
      // a symlink in place of the file: readRemoteSetting refuses it, and nothing is written through it
      symlinkSync(real, hub.file)
    })
    expect(JSON.parse(readFileSync(real, 'utf8'))).toEqual(setting(hub.port, []))
  })

  it('a write that fails: the same 403, the code stays void, one fixed log line naming only the error code', async () => {
    const hub = await startHub()
    const lines: string[] = []
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')) })
    }
    const code = await makeCode(hub)
    chmodSync(hub.dir, 0o500)
    try {
      await expectRefused(hub, 'pair', () => pair(hub, { code, label: 'laptop' }))
    } finally {
      chmodSync(hub.dir, 0o700)
    }
    expect(hub.entry.status().codePending).toBe(false)
    expect(lines).toEqual(['agent-inbox remote entry: pairing could not write remote.json (EACCES)'])
    expect(devicesIn(hub)).toEqual([])
  })
})

describe('a lock path that is a dangling symlink', () => {
  it('answers the bare 403 within the lock deadline, and a later code pairs once the link is gone', async () => {
    const hub = await startHub()
    const lines: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')) })
    const lock = `${hub.file}.lock`
    symlinkSync(join(hub.dir, 'nowhere'), lock)
    const code = await makeCode(hub)
    const started = Date.now()
    await expectRefused(hub, 'pair', () => pair(hub, { code, label: 'laptop' }))
    expect(Date.now() - started).toBeLessThan(9_000)
    expect(lines).toEqual(['agent-inbox remote entry: pairing could not write remote.json (error)'])
    expect(devicesIn(hub)).toEqual([])
    unlinkSync(lock)
    const next = await makeCode(hub)
    await expectPaired(hub, () => pair(hub, { code: next, label: 'laptop' }))
    expect(devicesIn(hub)).toHaveLength(1)
  }, 20_000)
})

describe('a code is tied to the file it was made under', () => {
  // raw requests here, never attempt(): its status call would read the file first
  const send = (hub: Hub, code: string) => pair(hub, { code, label: 'laptop' })

  it('the entry off and on again with no poll or request between: the code is void', async () => {
    const hub = await startHub()
    const code = await makeCode(hub)
    writeSetting(hub.dir, setting(hub.port, [], { enabled: false }))
    writeSetting(hub.dir, setting(hub.port, []))
    const response = await send(hub, code)
    expect(response.status).toBe(403)
    expect(hub.entry.status()).toMatchObject({ codePending: false, paired: [] })
    expect(hub.entry.status().refused.pair).toBe(1)
    expect(devicesIn(hub)).toEqual([])
  })

  it('a hand edit that changes nothing the entry uses voids the code', async () => {
    const hub = await startHub()
    const code = await makeCode(hub)
    writeSetting(hub.dir, setting(hub.port, [], { note: 'edited by hand' }))
    expect((await send(hub, code)).status).toBe(403)
    expect(hub.entry.status().refused.pair).toBe(1)
    expect(devicesIn(hub)).toEqual([])
  })

  it('a device removed by anyone voids the code', async () => {
    const hub = await startHub({ devices: [device(newSecret(), 'aaaaaaaaaaaaaaaa')] })
    const code = await makeCode(hub)
    writeSetting(hub.dir, setting(hub.port, []))
    expect((await send(hub, code)).status).toBe(403)
    expect(devicesIn(hub)).toEqual([])
  })

  it('a pairing\'s own write does not disturb the next code', async () => {
    const hub = await startHub()
    const first = await makeCode(hub)
    expect((await send(hub, first)).status).toBe(200)
    const next = await makeCode(hub)
    expect((await send(hub, next)).status).toBe(200)
    expect(devicesIn(hub)).toHaveLength(2)
  })

  it('a file left as it was keeps the code', async () => {
    const hub = await startHub({ intervalMs: 20 })
    const code = await makeCode(hub)
    // the poll and the status read it again and again, unchanged
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(hub.entry.status().codePending).toBe(true)
    }
    expect((await send(hub, code)).status).toBe(200)
  })
})

describe('the entry turned off between making the code and pairing', () => {
  it('refuses at the gate on the next request, before the listener closes, and voids the code', async () => {
    // a poll an hour apart: only the request sees the change
    const hub = await startHub()
    const code = await makeCode(hub)
    writeSetting(hub.dir, setting(hub.port, [], { enabled: false }))
    const off = await attempt(hub, () => pair(hub, { code, label: 'laptop' }))
    expect(off.response.status).toBe(403)
    expect(off.rose).toEqual(['host'])
    await waitUntil(() => !hub.entry.status().listening, 'the entry to close')
    expect(hub.entry.status().codePending).toBe(false)
    expect(devicesIn(hub)).toEqual([])
  })

  it('the poll voids the code when the entry turns off, so it fails when the entry is back on', async () => {
    const hub = await startHub({ intervalMs: 50 })
    const code = await makeCode(hub)
    writeSetting(hub.dir, setting(hub.port, [], { enabled: false }))
    await waitUntil(() => !hub.entry.status().listening, 'the entry to close')
    expect(hub.entry.status().codePending).toBe(false)
    writeSetting(hub.dir, setting(hub.port, []))
    await waitUntil(() => hub.entry.status().listening, 'the entry to reopen')
    await expectRefused(hub, 'pair', () => pair(hub, { code, label: 'laptop' }))
    expect(devicesIn(hub)).toEqual([])
  })

  it('a file with group bits or a newer schema refuses at the gate and is not written', async () => {
    for (const [value, mode] of [[(port: number) => setting(port, []), 0o640], [(port: number) => setting(port, [], { schema: 2 }), 0o600]] as const) {
      const hub = await startHub()
      const code = await makeCode(hub)
      writeSetting(hub.dir, value(hub.port), mode)
      const written = readFileSync(hub.file, 'utf8')
      const refused = await attempt(hub, () => pair(hub, { code, label: 'laptop' }))
      expect(refused.response.status).toBe(403)
      expect(refused.rose).toEqual(['host'])
      expect(readFileSync(hub.file, 'utf8')).toBe(written)
    }
  })
})

describe('steps 1 to 6 still apply to the pairing route', () => {
  it.each([
    ['host', 'a wrong Host', [['Host', 'evil.example'], ['Tailscale-User-Login', LOGIN], ['Origin', ORIGIN]], '/api/remote/pair'],
    ['host', 'the loopback authority', [['Host', '127.0.0.1'], ['Tailscale-User-Login', LOGIN], ['Origin', ORIGIN]], '/api/remote/pair'],
    ['funnel', 'a Funnel header', [...PAIR_HEADERS, ['Tailscale-Funnel-Request', '?1']], '/api/remote/pair'],
    ['login', 'no login', [['Host', HOST], ['Origin', ORIGIN]], '/api/remote/pair'],
    ['login', 'a foreign login', [['Host', HOST], ['Tailscale-User-Login', 'other@example.com'], ['Origin', ORIGIN]], '/api/remote/pair'],
    ['login', 'the login twice', [['Host', HOST], ['Tailscale-User-Login', LOGIN], ['Tailscale-User-Login', LOGIN], ['Origin', ORIGIN]], '/api/remote/pair'],
    ['path', 'a % in the target', PAIR_HEADERS, '/api/remote/p%61ir'],
    ['path', 'a dot-dot segment', PAIR_HEADERS, '/api/x/../remote/pair'],
    ['path', 'a double slash', PAIR_HEADERS, '/api/remote//pair'],
    ['path', 'a trailing slash', PAIR_HEADERS, '/api/remote/pair/'],
    ['origin', 'a foreign Origin', [['Host', HOST], ['Tailscale-User-Login', LOGIN], ['Origin', 'https://evil.example']], '/api/remote/pair'],
    ['origin', 'another node\'s Origin', [['Host', HOST], ['Tailscale-User-Login', LOGIN], ['Origin', 'https://laptop.example.ts.net']], '/api/remote/pair'],
    ['origin', 'no Origin', [['Host', HOST], ['Tailscale-User-Login', LOGIN]], '/api/remote/pair'],
    ['origin', 'Sec-Fetch-Site: cross-site', [...PAIR_HEADERS, ['Sec-Fetch-Site', 'cross-site']], '/api/remote/pair'],
    ['origin', 'Sec-Fetch-Site: same-site', [...PAIR_HEADERS, ['Sec-Fetch-Site', 'same-site']], '/api/remote/pair'],
  ] as Array<[Reason, string, Array<[string, string]>, string]>)('refuses at %s: %s, and the code is untouched', async (reason, _name, headers, target) => {
    const hub = await startHub()
    const code = await makeCode(hub)
    for (let i = 0; i < 6; i += 1) await expectRefused(hub, reason, () => pair(hub, { code, label: 'laptop' }, { headers, target }))
    expect(hub.entry.status().codePending).toBe(true)
    // six refusals at the gate used neither tries nor the rate limit
    for (let i = 0; i < 4; i += 1) await expectRefused(hub, 'pair', () => pair(hub, { code: wrongCode(code), label: 'laptop' }, { advance: 0 }))
    await expectPaired(hub, () => pair(hub, { code, label: 'laptop' }, { advance: 0 }))
  })

  it('passes with Sec-Fetch-Site same-origin', async () => {
    const hub = await startHub()
    const code = await makeCode(hub)
    await expectPaired(hub, () => pair(hub, { code, label: 'laptop' }, { headers: [...PAIR_HEADERS, ['Sec-Fetch-Site', 'same-origin']] }))
  })
})

describe('only the exact target and method get the login-only pass', () => {
  it.each([
    ['POST', '/api/remote/pair?x=1'],
    ['POST', '/api/remote/pair?'],
    ['POST', '/API/remote/pair'],
    ['POST', '/api/remote/Pair'],
    ['POST', '/api/remote/pairing'],
    ['POST', '/api/remote'],
    ['GET', '/api/remote/pair'],
    ['HEAD', '/api/remote/pair'],
    ['PUT', '/api/remote/pair'],
    ['DELETE', '/api/remote/pair'],
    ['PATCH', '/api/remote/pair'],
    ['OPTIONS', '/api/remote/pair'],
    ['POST', '/api/remote-entry/code'],
    ['POST', '/api/items/x/resolve'],
  ])('%s %s falls through to step 8', async (method, target) => {
    const hub = await startHub()
    const code = await makeCode(hub)
    const body = JSON.stringify({ code, label: 'laptop' })
    await expectRefused(hub, 'device', () => pair(hub, body, { method, target }), method)
    expect(hub.entry.status().codePending).toBe(true)
  })

  it.each([
    ['POST', '/api/remote/pair?x=1'],
    ['GET', '/api/remote/pair'],
    ['HEAD', '/api/remote/pair'],
    ['POST', '/api/remote-entry/code'],
  ])('%s %s with a paired device is refused at step 9', async (method, target) => {
    const secret = newSecret()
    const hub = await startHub({ devices: [device(secret)] })
    const code = await makeCode(hub)
    await expectRefused(hub, 'route', () => pair(hub, { code, label: 'laptop' }, { method, target, headers: deviceHeaders(secret, [['Origin', ORIGIN]]) }), method)
    expect(hub.entry.status().codePending).toBe(true)
    expect(devicesIn(hub)).toHaveLength(1)
  })
})

describe('POST /api/remote-entry/code, loopback only', () => {
  it('needs the owner token in X-Agent-Inbox-Owner', async () => {
    const hub = await startHub()
    const tries: Array<Record<string, string>> = [
      {}, { 'X-Agent-Inbox-Owner': '' }, { 'X-Agent-Inbox-Owner': 'wrong' }, { 'X-Agent-Inbox-Owner': `${OWNER_TOKEN}x` },
      { 'X-Agent-Inbox-Owner': OWNER_TOKEN.slice(1) }, { 'X-Agent-Inbox-Owner': OWNER_TOKEN.toUpperCase() }, { Authorization: `Bearer ${OWNER_TOKEN}` },
    ]
    for (const headers of tries) {
      const response = await postCode(hub, headers)
      expect(response.status).toBe(403)
      expect(await response.text()).not.toMatch(/code/)
    }
    expect(hub.entry.status().codePending).toBe(false)
  })

  it('compares the token by timingSafeEqual on SHA-256 digests', async () => {
    const hub = await startHub()
    const timing = vi.spyOn(crypto, 'timingSafeEqual')
    expect((await postCode(hub, { 'X-Agent-Inbox-Owner': 'short' })).status).toBe(403)
    expect(timing).toHaveBeenCalledTimes(1)
    const [a, b] = timing.mock.calls[0]!
    expect((a as Buffer).length).toBe(32)
    expect((b as Buffer).length).toBe(32)
  })

  it('does not exist when the viewer has no owner token', async () => {
    const hub = await startHub({ ownerToken: null })
    const response = await postCode(hub, { 'X-Agent-Inbox-Owner': OWNER_TOKEN })
    expect(response.status).toBe(404)
    expect(hub.entry.status().codePending).toBe(false)
  })

  it('answers 409 when the remote entry is not on, and makes no code', async () => {
    for (const extra of [{ enabled: false }, { viewerPort: 4392 }, { schema: 2 }]) {
      const hub = await startHub({ extra, listen: false })
      const response = await postCode(hub)
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ error: 'remote_entry_off' })
      expect(hub.entry.status().codePending).toBe(false)
    }
  })

  it('answers 409 while the listener is not there (a bind failure)', async () => {
    const blocker = (await import('node:net')).createServer()
    blocker.listen(0, '127.0.0.1')
    await new Promise((resolve) => blocker.once('listening', resolve))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const port = (blocker.address() as { port: number }).port
      const hub = await startHub({ value: () => setting(port, []), listen: false })
      await waitUntil(() => hub.entry.status().error, 'the bind error')
      expect((await postCode(hub)).status).toBe(409)
      expect(hub.entry.status().codePending).toBe(false)
    } finally {
      blocker.close()
    }
  })

  it('needs the loopback Origin, as every unsafe method on the loopback entry does', async () => {
    const hub = await startHub()
    const response = await fetch(`http://127.0.0.1:${hub.localPort}/api/remote-entry/code`, { method: 'POST', headers: { 'X-Agent-Inbox-Owner': OWNER_TOKEN } })
    expect(response.status).toBe(403)
    expect(hub.entry.status().codePending).toBe(false)
  })

  it('works from another local process with a plain fetch, the token and the loopback Origin', async () => {
    const hub = await startHub()
    const script = [
      `const base = 'http://127.0.0.1:${hub.localPort}'`,
      `const r = await fetch(base + '/api/remote-entry/code', { method: 'POST', headers: { Origin: base, 'X-Agent-Inbox-Owner': process.env.TOKEN } })`,
      'console.log(JSON.stringify({ status: r.status, body: await r.json() }))',
    ].join('\n')
    const out = await new Promise<string>((resolve, reject) => {
      execFile(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TOKEN: OWNER_TOKEN }, timeout: 10_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
    })
    const { status, body } = JSON.parse(out) as { status: number; body: { code: string } }
    expect(status).toBe(200)
    expect(body.code).toMatch(CODE_SHAPE)
    expect(hub.entry.status().codePending).toBe(true)
    await expectPaired(hub, () => pair(hub, { code: body.code, label: 'laptop' }))
  })

  it('is never served by the remote entry', async () => {
    const secret = newSecret()
    const hub = await startHub({ devices: [device(secret)] })
    const remote = await attempt(hub, () => rawRequest(hub.port, { method: 'POST', target: '/api/remote-entry/code', headers: deviceHeaders(secret, [['Origin', ORIGIN], ['X-Agent-Inbox-Owner', OWNER_TOKEN]]), body: '{}' }))
    expect(remote.response.status).toBe(403)
    expect(remote.rose).toEqual(['route'])
    expect(hub.entry.status().codePending).toBe(false)
  })
})

describe('the status', () => {
  it('adds codePending, each device paired since start with the code that paired it, the pair count, and nothing secret', async () => {
    const hub = await startHub()
    const start = hub.entry.status()
    expect(start.codePending).toBe(false)
    expect(start.paired).toEqual([])
    expect(start.refused.pair).toBe(0)
    const { code, codeId } = await makeCodeWithId(hub)
    expect(hub.entry.status().codePending).toBe(true)
    // the pending code's identity is never shown: only the app that asked for it knows it
    expect(JSON.stringify(hub.entry.status())).not.toContain(codeId)
    await expectRefused(hub, 'pair', () => pair(hub, { code: wrongCode(code), label: 'my-secret-label' }))
    const { device: id, secret } = await expectPaired(hub, () => pair(hub, { code, label: 'my-secret-label' }))
    const status = hub.entry.status()
    expect(status).toMatchObject({ codePending: false, paired: [{ device: id, codeId }] })
    expect(Object.keys(status.paired[0]!).sort()).toEqual(['codeId', 'device'])
    expect(status.refused.pair).toBe(1)
    expect(Object.keys(status).sort()).toEqual(['codePending', 'error', 'host', 'listening', 'on', 'paired', 'port', 'refused'])
    const next = await makeCodeWithId(hub)
    expect(JSON.stringify(hub.entry.status())).not.toContain(next.codeId)
    const text = JSON.stringify(hub.entry.status())
    for (const value of [secret, secretSha256(secret), 'my-secret-label', code, code.replace('-', ''), next.code, LOGIN]) expect(text).not.toContain(value)
    // and the loopback route serves the same
    const served = await fetch(`http://127.0.0.1:${hub.localPort}/api/remote-entry`).then((r) => r.json())
    expect(served).toEqual(JSON.parse(JSON.stringify(hub.entry.status())))
  })

  it('lists at most the last 16 devices paired since start', async () => {
    const hub = await startHub()
    const ids: Array<{ device: string; codeId: string }> = []
    for (let i = 0; i < 17; i += 1) {
      const { code, codeId } = await makeCodeWithId(hub)
      ids.push({ device: (await expectPaired(hub, () => pair(hub, { code, label: 'laptop' }))).device, codeId })
      // the owner removes it again, as main will
      writeSetting(hub.dir, setting(hub.port, []))
    }
    expect(hub.entry.status().paired).toEqual(ids.slice(1))
  })
})

describe('nothing sensitive reaches a log', () => {
  it('logs no code, secret, hash, label, login or header value', async () => {
    const hub = await startHub()
    const lines: string[] = []
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')) })
    }
    const code = await makeCode(hub)
    await pair(hub, { code: wrongCode(code), label: 'label-in-the-log' })
    await pair(hub, 'not json')
    const { secret } = await expectPaired(hub, () => pair(hub, { code, label: 'label-in-the-log' }))
    const next = await makeCode(hub)
    chmodSync(hub.dir, 0o500)
    try {
      await pair(hub, { code: next, label: 'label-in-the-log' })
    } finally {
      chmodSync(hub.dir, 0o700)
    }
    const text = lines.join('\n')
    for (const value of [code, code.replace('-', ''), next, wrongCode(code), secret, secretSha256(secret), 'label-in-the-log', LOGIN, HOST, OWNER_TOKEN]) {
      expect(text).not.toContain(value)
    }
  })
})
