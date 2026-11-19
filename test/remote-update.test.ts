// Updating the hub from the connecting Mac (#637), the hub's viewer half: what the remote entry
// answers on GET and POST /api/remote/update, what main reports on the loopback route, and that only
// a paired device, through the gate, can ask for an update. The request carries nothing: the hub's
// own update controller decides what is installed (electron/remote-update.cjs).
import { serveStatic } from '@hono/node-server/serve-static'
import type Database from 'better-sqlite3'
import { Hono } from 'hono'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDb } from '../src/store.js'
import { createViewer } from '../src/viewer.js'
import { startLocalViewer } from '../src/viewer-network.js'
import { remoteRouteAllowed, startRemoteEntry } from '../src/viewer-remote.js'
import type { RemoteEntry } from '../src/viewer-remote.js'
import {
  UPDATE_PATH, createRemoteUpdate, parseSummary, remoteUpdateReportRoute,
} from '../src/remote-update.js'
import type { UpdateSummary } from '../src/remote-update.js'
import { scratchDir } from './scratch.js'
import { waitUntil } from './wait.js'
import { HOST, LOGIN, ORIGIN, device, deviceHeaders, freePort, newSecret, rawRequest, setting, writeSetting } from './remote-fixtures.js'

const OWNER_TOKEN = 'owner-token-for-the-test-0123456789'
// the loopback route src/viewer-server.ts adds for main's report
const UPDATE_REPORT_PATH = '/api/remote-entry/update'
const LAPTOP = '3f9c0a1b2d4e5f60'
const STUDIO = '0a1b2c3d4e5f6071'
const READY: UpdateSummary = { current: '2.14.1', status: 'available', newer: '2.15.0', canStart: true, reason: null }

describe('parseSummary: what main may report', () => {
  it('takes exactly the five fields, in their shapes', () => {
    expect(parseSummary(READY)).toEqual(READY)
    expect(parseSummary({ current: '2.14.1', status: 'current', newer: null, canStart: false, reason: 'nothing_newer' }))
      .toEqual({ current: '2.14.1', status: 'current', newer: null, canStart: false, reason: 'nothing_newer' })
    for (const reason of ['setup_running', 'installing', 'not_here', 'nothing_newer', 'busy']) {
      expect(parseSummary({ ...READY, canStart: false, reason })).not.toBeNull()
    }
  })

  it.each([
    ['an extra key', { ...READY, url: 'https://example.com/' }],
    ['a missing key', { current: '2.14.1', status: 'available', newer: '2.15.0', canStart: true }],
    ['a version that is not three numbers', { ...READY, current: '2.14' }],
    ['a newer version with a leading zero', { ...READY, newer: '2.015.0' }],
    ['an unknown status', { ...READY, status: 'ready' }],
    ['an unknown reason', { ...READY, canStart: false, reason: 'because' }],
    ['the viewer\'s own reason', { ...READY, canStart: false, reason: 'not_ready' }],
    ['a start with a reason', { ...READY, reason: 'busy' }],
    ['a refusal with no reason', { ...READY, canStart: false }],
    ['a start with nothing newer', { ...READY, newer: null }],
    ['canStart that is not a boolean', { ...READY, canStart: 'yes' }],
    ['an array', [READY]],
    ['null', null],
  ])('refuses %s', (_name, value) => {
    expect(parseSummary(value)).toBeNull()
  })
})

describe('createRemoteUpdate', () => {
  const make = () => {
    const clock = { now: 1_000_000 }
    let ids = 0
    const update = createRemoteUpdate({ version: '2.14.1', now: () => clock.now, randomId: () => `${++ids}`.padStart(16, '0') })
    return { update, clock }
  }

  it('answers not_ready until main reports, and again once main has been quiet for 15 seconds', () => {
    const { update, clock } = make()
    const notReady = { current: '2.14.1', status: 'current', newer: null, canStart: false, reason: 'not_ready' }
    expect(update.summary()).toEqual(notReady)
    expect(update.start(LAPTOP)).toEqual({ ok: false, reason: 'not_ready' })
    update.report(READY)
    expect(update.summary()).toEqual(READY)
    clock.now += 15_000
    expect(update.summary()).toEqual(READY)
    clock.now += 1
    expect(update.summary()).toEqual(notReady)
    // a clock that went back is not fresh either
    update.report(READY)
    clock.now -= 60_000
    expect(update.summary()).toEqual(notReady)
  })

  it('records one request with the device, says installing at once, and hands it to main once', () => {
    const { update } = make()
    update.report(READY)
    expect(update.start(LAPTOP)).toEqual({ ok: true })
    expect(update.summary()).toEqual({ ...READY, status: 'installing', canStart: false, reason: 'installing' })
    // a second press, from this device or another, is not a second request
    expect(update.start(STUDIO)).toEqual({ ok: false, reason: 'installing' })
    expect(update.report(READY)).toEqual({ request: { id: '0000000000000001', device: LAPTOP }, looked: false })
    // main's next report has not seen it yet: still installing until it says otherwise
    expect(update.summary()).toEqual({ ...READY, status: 'installing', canStart: false, reason: 'installing' })
    expect(update.report({ ...READY, status: 'downloading', canStart: false, reason: 'installing' })).toEqual({ request: null, looked: false })
    expect(update.summary()).toEqual({ ...READY, status: 'downloading', canStart: false, reason: 'installing' })
  })

  it('refuses a start with main\'s reason when main says it cannot', () => {
    const { update } = make()
    update.report({ current: '2.14.1', status: 'current', newer: null, canStart: false, reason: 'nothing_newer' })
    expect(update.start(LAPTOP)).toEqual({ ok: false, reason: 'nothing_newer' })
    update.report({ ...READY, canStart: false, reason: 'setup_running' })
    expect(update.start(LAPTOP)).toEqual({ ok: false, reason: 'setup_running' })
    expect(update.report(READY)).toEqual({ request: null, looked: false })
  })

  it('tells main once that a device looked, so the hub may check for a release', () => {
    const { update } = make()
    update.report(READY)
    expect(update.get()).toEqual(READY)
    expect(update.report(READY)).toEqual({ request: null, looked: true })
    expect(update.report(READY)).toEqual({ request: null, looked: false })
  })
})

describe('POST /api/remote-entry/update on the loopback app (main\'s report)', () => {
  const app = () => {
    const update = createRemoteUpdate({ version: '2.14.1' })
    const hono = new Hono()
    hono.post(UPDATE_REPORT_PATH, remoteUpdateReportRoute(update, OWNER_TOKEN))
    return { hono, update }
  }
  // as main's fetch sends it: with its length
  const send = (hono: Hono, body: string, headers: Record<string, string> = { 'X-Agent-Inbox-Owner': OWNER_TOKEN, 'Content-Type': 'application/json' }) =>
    hono.request(UPDATE_REPORT_PATH, { method: 'POST', headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body)) }, body })

  it('takes a summary with the owner token and answers the request, if any, with no-store', async () => {
    const { hono, update } = app()
    const response = await send(hono, JSON.stringify(READY))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ request: null, looked: false })
    expect(update.summary()).toEqual(READY)
  })

  it('refuses without the owner token, and changes nothing', async () => {
    const { hono, update } = app()
    for (const headers of [{ 'Content-Type': 'application/json' }, { 'X-Agent-Inbox-Owner': 'wrong', 'Content-Type': 'application/json' }] as Array<Record<string, string>>) {
      expect((await send(hono, JSON.stringify(READY), headers)).status).toBe(403)
    }
    expect(update.summary().reason).toBe('not_ready')
  })

  it.each([
    ['not JSON', 'nope'],
    ['a summary of the wrong shape', JSON.stringify({ ...READY, canStart: 'yes' })],
    ['more than 1 KiB', JSON.stringify({ ...READY, pad: 'x'.repeat(1100) })],
  ])('refuses %s with 400', async (_name, body) => {
    const { hono, update } = app()
    expect((await send(hono, body)).status).toBe(400)
    expect(update.summary().reason).toBe('not_ready')
  })
})

describe('/api/remote/update through the real gate', () => {
  let dir: string
  let db: Database.Database
  let entry: RemoteEntry
  let local: Server
  let port: number
  let localPort: number
  const update = createRemoteUpdate({ version: '2.14.1' })
  const laptop = newSecret()
  const studio = newSecret()
  const report = (summary: UpdateSummary) => fetch(`http://127.0.0.1:${localPort}${UPDATE_REPORT_PATH}`, {
    method: 'POST',
    headers: { Origin: `http://127.0.0.1:${localPort}`, 'X-Agent-Inbox-Owner': OWNER_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(summary),
  }).then((response) => response.json())

  beforeAll(async () => {
    dir = scratchDir('remote-update-')
    db = openDb(join(dir, 'inbox.db'))
    port = await freePort()
    writeSetting(dir, setting(port, [device(laptop), device(studio, STUDIO, 'studio')]))
    // as src/viewer-server.ts builds both apps
    const remoteApp = createViewer(db, { agentHome: dir, runtimeRoot: join(dir, 'runtime') })
    remoteApp.get('/*', serveStatic({ root: './public' }))
    entry = startRemoteEntry({ app: remoteApp, dir, viewerPort: 4319, update })
    const app = createViewer(db, { ownerToken: OWNER_TOKEN, agentHome: dir, runtimeRoot: join(dir, 'runtime') })
    app.post(UPDATE_REPORT_PATH, remoteUpdateReportRoute(update, OWNER_TOKEN))
    app.get('/*', serveStatic({ root: './public' }))
    local = startLocalViewer(app, 0)
    await waitUntil(() => entry.status().listening && local.listening, 'both listeners')
    localPort = (local.address() as { port: number }).port
  })
  afterAll(async () => {
    local.close()
    await entry.close()
    db.close()
  })

  const post = (headers: Array<[string, string]>, extra: { target?: string; body?: string; contentType?: string | null } = {}) =>
    rawRequest(port, { method: 'POST', target: extra.target ?? UPDATE_PATH, headers, body: extra.body ?? '', contentType: extra.contentType ?? null })

  it('is not on the allowlist the wrapped app serves, but the gate lets a paired device reach it', () => {
    expect(remoteRouteAllowed('GET', UPDATE_PATH)).toBe(false)
    expect(remoteRouteAllowed('POST', UPDATE_PATH)).toBe(false)
  })

  it('answers GET to a paired device with what main last reported, with the remote headers', async () => {
    await report(READY)
    const response = await rawRequest(port, { target: UPDATE_PATH, headers: deviceHeaders(laptop) })
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual(READY)
    expect(response.headers['x-agent-inbox-remote-boundary']).toBe('tailnet-v1')
    expect(response.headers['cache-control']).toBe('no-store')
  })

  it('refuses GET and POST without a paired device\'s secret, at the gate', async () => {
    const before = entry.status().refused.device
    expect((await rawRequest(port, { target: UPDATE_PATH, headers: [['Host', HOST], ['Tailscale-User-Login', LOGIN]] })).status).toBe(403)
    expect((await post([['Host', HOST], ['Tailscale-User-Login', LOGIN], ['Origin', ORIGIN], ['X-Agent-Inbox-Device', newSecret()]])).status).toBe(403)
    expect(entry.status().refused.device).toBe(before + 2)
    expect(await report(READY)).toEqual({ request: null, looked: true })
  })

  it('refuses a POST without the hub\'s Origin, or from another site', async () => {
    const before = entry.status().refused.origin
    expect((await post(deviceHeaders(laptop))).status).toBe(403)
    expect((await post(deviceHeaders(laptop, [['Origin', 'https://other.example.ts.net']]))).status).toBe(403)
    expect((await post(deviceHeaders(laptop, [['Origin', ORIGIN], ['Sec-Fetch-Site', 'same-site']]))).status).toBe(403)
    expect(entry.status().refused.origin).toBe(before + 3)
    expect(await report(READY)).toEqual({ request: null, looked: false })
  })

  it('refuses a POST that names anything: a query or a body', async () => {
    const headers = deviceHeaders(laptop, [['Origin', ORIGIN]])
    expect((await post(headers, { target: `${UPDATE_PATH}?version=9.9.9` })).status).toBe(400)
    expect((await post(headers, { body: '{"version":"9.9.9"}', contentType: 'application/json' })).status).toBe(400)
    expect(await report(READY)).toEqual({ request: null, looked: false })
  })

  it('starts on a POST from a paired device with the hub\'s Origin, and main hears which device asked', async () => {
    await report(READY)
    const response = await post(deviceHeaders(studio, [['Origin', ORIGIN]]))
    expect(response.status).toBe(202)
    expect(JSON.parse(response.body)).toEqual({ ok: true })
    expect(response.headers['x-agent-inbox-remote-boundary']).toBe('tailnet-v1')
    const again = await post(deviceHeaders(laptop, [['Origin', ORIGIN]]))
    expect(again.status).toBe(409)
    expect(JSON.parse(again.body)).toEqual({ ok: false, reason: 'installing' })
    const answer = await report(READY) as { request: { id: string; device: string } }
    expect(answer.request.device).toBe(STUDIO)
    expect(answer.request.id).toMatch(/^[0-9a-f]{16}$/)
  })

  it('answers why not, in one word, when main says it cannot start', async () => {
    await report({ current: '2.14.1', status: 'current', newer: null, canStart: false, reason: 'nothing_newer' })
    const response = await post(deviceHeaders(laptop, [['Origin', ORIGIN]]))
    expect(response.status).toBe(409)
    expect(JSON.parse(response.body)).toEqual({ ok: false, reason: 'nothing_newer' })
  })

  it('does not exist on the loopback app: a process on the hub cannot ask for an update there', async () => {
    await report(READY)
    for (const method of ['GET', 'POST']) {
      const response = await rawRequest(localPort, {
        method, target: UPDATE_PATH, body: method === 'POST' ? '' : undefined, contentType: null,
        headers: [['Host', `127.0.0.1:${localPort}`], ['Origin', `http://127.0.0.1:${localPort}`], ['X-Agent-Inbox-Owner', OWNER_TOKEN]],
      })
      expect(response.status, method).toBe(404)
    }
    expect(await report(READY)).toEqual({ request: null, looked: false })
  })

  it('refuses the report route on the remote entry, even with the owner token', async () => {
    const before = entry.status().refused.route
    const response = await rawRequest(port, {
      method: 'POST', target: UPDATE_REPORT_PATH, body: JSON.stringify(READY),
      headers: deviceHeaders(laptop, [['Origin', ORIGIN], ['X-Agent-Inbox-Owner', OWNER_TOKEN]]),
    })
    expect(response.status).toBe(403)
    expect(entry.status().refused.route).toBe(before + 1)
  })
})
