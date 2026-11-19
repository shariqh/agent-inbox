// Updating the hub from the connecting Mac (#637), the connecting Mac's main half: what Settings →
// Use another Mac's Inbox may show of the hub's update, and the one request that starts it. Every
// request goes through the connection's hub fetch (its origin only, the device header, no redirect);
// nothing here sees the device secret. The hub is a fake that answers as the real relay does.
import { describe, expect, it } from 'vitest'
import hubUpdateModule from '../electron/hub-update.cjs'

const { NOT_BACK_MS, UPDATE_ROUTES_FROM, createHubUpdate } = hubUpdateModule

const ID = '0123abcd'
const ORIGIN = 'https://hub.example.ts.net'
const MARK = { 'x-agent-inbox-remote-boundary': 'tailnet-v1', 'content-type': 'application/json' }
const READY = { current: '2.14.1', status: 'available', newer: '2.15.0', canStart: true, reason: null }

type Sent = { url: string; method: string; headers: Record<string, string>; body: unknown }

function fakeHub() {
  const sent: Sent[] = []
  const hub = {
    sent,
    connection: { mode: 'hub', id: ID, label: 'studio', state: 'online', reason: null, version: '2.14.1' } as Record<string, unknown>,
    summary: READY as Record<string, unknown> | null,
    // what GET answers when not the summary: a status, or a thrown fetch
    getStatus: 200,
    postAnswer: { status: 202, body: { ok: true } as unknown },
    unreachable: false,
    kicks: 0,
  }
  const connect = {
    connection: () => ({ ...hub.connection }),
    hubBase: (id: string) => (id === ID ? `${ORIGIN}/` : null),
    kick: async () => { hub.kicks += 1; return { ok: true } },
    hubFetch: () => async (url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) => {
      sent.push({ url, method: init.method ?? 'GET', headers: { ...(init.headers ?? {}) }, body: init.body })
      if (hub.unreachable) throw new TypeError('fetch failed')
      if ((init.method ?? 'GET') === 'POST') return new Response(JSON.stringify(hub.postAnswer.body), { status: hub.postAnswer.status, headers: MARK })
      if (hub.getStatus !== 200) return new Response('Forbidden', { status: hub.getStatus })
      return new Response(JSON.stringify(hub.summary), { status: 200, headers: MARK })
    },
  }
  return { hub, connect }
}

function setup() {
  const clock = { now: 1_000_000 }
  const { hub, connect } = fakeHub()
  const update = createHubUpdate({ connect: () => connect, now: () => clock.now })
  return { hub, update, clock }
}

describe('createHubUpdate: what the connecting Mac shows', () => {
  it('reads the hub\'s update through the hub fetch, and answers it with the connection\'s version', async () => {
    const { hub, update } = setup()
    expect(await update.state(ID)).toEqual({ ok: true, phase: 'idle', version: '2.14.1', status: 'available', newer: '2.15.0', canStart: true, reason: null })
    expect(hub.sent).toEqual([{ url: `${ORIGIN}/api/remote/update`, method: 'GET', headers: {}, body: undefined }])
  })

  it('passes on why the hub cannot start, in its own word', async () => {
    const { hub, update } = setup()
    for (const reason of ['setup_running', 'installing', 'not_here', 'nothing_newer', 'busy', 'not_ready']) {
      hub.summary = { current: '2.14.1', status: 'current', newer: null, canStart: false, reason }
      expect(await update.state(ID)).toMatchObject({ ok: true, phase: 'idle', canStart: false, reason })
    }
  })

  it('says old_hub when an online hub refuses the route: it is older than this change', async () => {
    const { hub, update } = setup()
    hub.getStatus = 403
    expect(await update.state(ID)).toEqual({ ok: true, phase: 'old_hub', version: '2.14.1', status: null, newer: null, canStart: false, reason: null })
  })

  // #637 fix round: a current hub also answers 403 (this device was removed, the login or host changed)
  it('names the version the update routes exist from: 2.15.0', () => {
    expect(UPDATE_ROUTES_FROM).toBe('2.15.0')
  })

  it.each(['2.15.0', '2.15.1', '2.16.0', '3.0.0'])('says refused, not old_hub, when a hub on %s answers 403', async (version) => {
    const { hub, update } = setup()
    hub.getStatus = 403
    hub.connection.version = version
    expect(await update.state(ID)).toEqual({ ok: true, phase: 'refused', version, status: null, newer: null, canStart: false, reason: null })
  })

  it.each([
    ['2.14.99', 'old_hub'],
    ['1.99.99', 'old_hub'],
    ['2.9.0', 'old_hub'],
    [null, 'refused'],
    ['dev', 'refused'],
    ['2.14', 'refused'],
    ['2.014.1', 'refused'],
    [{ not: 'a version' }, 'refused'],
  ])('a 403 from a hub whose version is %j is %s', async (version, phase) => {
    const { hub, update } = setup()
    hub.getStatus = 403
    hub.connection.version = version
    expect(await update.state(ID)).toMatchObject({ ok: true, phase, canStart: false })
  })

  it('asks the connection to check the hub again once per refusal run, and again after a read that was not refused', async () => {
    const { hub, update } = setup()
    hub.getStatus = 403
    hub.connection.version = '2.15.0'
    for (let i = 0; i < 3; i += 1) expect(await update.state(ID)).toMatchObject({ phase: 'refused' })
    await Promise.resolve()
    expect(hub.kicks).toBe(1)
    // the hub answers again: the run is over
    hub.getStatus = 200
    expect(await update.state(ID)).toMatchObject({ phase: 'idle' })
    hub.getStatus = 403
    expect(await update.state(ID)).toMatchObject({ phase: 'refused' })
    await Promise.resolve()
    expect(hub.kicks).toBe(2)
  })

  it('asks nothing of the connection for an old hub: it is not refused, it is old', async () => {
    const { hub, update } = setup()
    hub.getStatus = 403
    expect(await update.state(ID)).toMatchObject({ phase: 'old_hub' })
    await Promise.resolve()
    expect(hub.kicks).toBe(0)
  })

  it('never rejects when the check of the connection throws', async () => {
    const { hub, connect } = fakeHub()
    hub.getStatus = 403
    hub.connection.version = '2.15.0'
    const update = createHubUpdate({ connect: () => ({ ...connect, kick: async () => { throw new Error('gone') } }) })
    expect(await update.state(ID)).toMatchObject({ phase: 'refused' })
  })

  it.each([
    ['an unknown status', { ...READY, status: 'ready' }],
    ['a start with no newer version', { ...READY, newer: null }],
    ['an extra field', { ...READY, url: 'https://example.com/' }],
    ['not an object', [READY]],
  ])('says unreadable for %s', async (_name, summary) => {
    const { hub, update } = setup()
    hub.summary = summary as Record<string, unknown>
    expect(await update.state(ID)).toMatchObject({ ok: true, phase: 'unreadable', canStart: false })
  })

  it('answers offline, asking nothing, while the hub is not online; not_found for another hub', async () => {
    const { hub, update } = setup()
    hub.connection.state = 'retrying'
    expect(await update.state(ID)).toEqual({ ok: true, phase: 'offline', version: '2.14.1', status: null, newer: null, canStart: false, reason: null })
    expect(await update.state('ffffffff')).toEqual({ ok: false, reason: 'not_found' })
    hub.connection = { mode: 'local' }
    expect(await update.state(ID)).toEqual({ ok: false, reason: 'not_found' })
    expect(hub.sent).toEqual([])
  })
})

describe('createHubUpdate: starting it and following it', () => {
  it('posts once, with the hub\'s Origin and nothing else, and answers ok', async () => {
    const { hub, update } = setup()
    await update.state(ID)
    expect(await update.start(ID)).toEqual({ ok: true })
    const post = hub.sent.find((request) => request.method === 'POST')!
    expect(post).toEqual({ url: `${ORIGIN}/api/remote/update`, method: 'POST', headers: { Origin: ORIGIN }, body: undefined })
  })

  it('answers the hub\'s refusal word, and remembers nothing', async () => {
    const { hub, update } = setup()
    hub.postAnswer = { status: 409, body: { ok: false, reason: 'setup_running' } }
    expect(await update.start(ID)).toEqual({ ok: false, reason: 'setup_running' })
    expect(await update.state(ID)).toMatchObject({ phase: 'idle' })
    hub.postAnswer = { status: 409, body: { ok: false, reason: 'Not A Word' } }
    expect(await update.start(ID)).toEqual({ ok: false, reason: 'failed' })
    hub.postAnswer = { status: 403, body: 'Forbidden' }
    expect(await update.start(ID)).toEqual({ ok: false, reason: 'refused' })
    hub.unreachable = true
    expect(await update.start(ID)).toEqual({ ok: false, reason: 'unreachable' })
  })

  // M35: a 202 is a start only when the hub says so in the body
  it.each([
    ['an empty object', {}],
    ['ok: false', { ok: false }],
    ['ok: "yes"', { ok: 'yes' }],
    ['a refusal word', { ok: false, reason: 'busy' }],
    ['a string', 'ok'],
    ['null', null],
  ])('does not take a 202 with %s as a start, and follows nothing', async (_name, body) => {
    const { hub, update } = setup()
    hub.postAnswer = { status: 202, body }
    expect(await update.start(ID)).toEqual({ ok: false, reason: 'failed' })
    expect(await update.state(ID)).toMatchObject({ phase: 'idle' })
  })

  it('does not take a 202 that is not the hub\'s own answer (no marker) as a start', async () => {
    const { hub, connect } = fakeHub()
    const update = createHubUpdate({ connect: () => ({ ...connect, hubFetch: () => async () => new Response(JSON.stringify({ ok: true }), { status: 202 }) }) })
    expect(await update.start(ID)).toEqual({ ok: false, reason: 'failed' })
    expect(hub.kicks).toBe(0)
  })

  it('refuses to start while the hub is not online, or for another hub, sending nothing', async () => {
    const { hub, update } = setup()
    hub.connection.state = 'retrying'
    expect(await update.start(ID)).toEqual({ ok: false, reason: 'offline' })
    hub.connection.state = 'online'
    expect(await update.start('ffffffff')).toEqual({ ok: false, reason: 'not_found' })
    expect(hub.sent).toEqual([])
  })

  it('follows the update: updating, restarting while the hub is away, then done on the new version', async () => {
    const { hub, update } = setup()
    await update.start(ID)
    hub.summary = { ...READY, status: 'downloading', canStart: false, reason: 'installing' }
    expect(await update.state(ID)).toMatchObject({ phase: 'updating', status: 'downloading', version: '2.14.1', newer: '2.15.0' })
    hub.summary = { ...READY, status: 'installing', canStart: false, reason: 'installing' }
    expect(await update.state(ID)).toMatchObject({ phase: 'updating', status: 'installing' })
    // the hub quit: the connection has not noticed yet, so the read fails and the connection is asked to check now
    hub.unreachable = true
    expect(await update.state(ID)).toMatchObject({ phase: 'restarting', version: '2.14.1' })
    expect(hub.kicks).toBe(1)
    hub.connection.state = 'retrying'
    expect(await update.state(ID)).toMatchObject({ phase: 'restarting' })
    expect(hub.kicks).toBe(1)
    hub.unreachable = false
    hub.connection = { ...hub.connection, state: 'online', version: '2.15.0' }
    hub.summary = { current: '2.15.0', status: 'current', newer: null, canStart: false, reason: 'nothing_newer' }
    expect(await update.state(ID)).toEqual({ ok: true, phase: 'done', version: '2.15.0', status: 'current', newer: null, canStart: false, reason: 'nothing_newer' })
  })

  // the request names nothing: the hub may install a release newer than the one this Mac last showed
  it('names the release the hub reports it is installing, not the one this Mac last showed', async () => {
    const { hub, update } = setup()
    expect(await update.state(ID)).toMatchObject({ phase: 'idle', newer: '2.15.0' })
    await update.start(ID)
    hub.summary = { ...READY, status: 'downloading', newer: '2.16.0', canStart: false, reason: 'installing' }
    expect(await update.state(ID)).toMatchObject({ phase: 'updating', newer: '2.16.0' })
    hub.summary = { current: '2.16.0', status: 'current', newer: null, canStart: false, reason: 'nothing_newer' }
    hub.connection.version = '2.16.0'
    expect(await update.state(ID)).toMatchObject({ phase: 'done', version: '2.16.0' })
  })

  it('says not_back once the hub has been away for a few minutes after the start', async () => {
    const { hub, update, clock } = setup()
    await update.start(ID)
    hub.connection.state = 'retrying'
    clock.now += NOT_BACK_MS
    expect(await update.state(ID)).toMatchObject({ phase: 'restarting' })
    clock.now += 1
    expect(await update.state(ID)).toMatchObject({ phase: 'not_back' })
    expect(NOT_BACK_MS).toBeGreaterThanOrEqual(3 * 60_000)
  })

  it('says failed when the hub is online on its old version and no longer updating', async () => {
    const { hub, update } = setup()
    await update.start(ID)
    hub.summary = { ...READY, status: 'failed' }
    expect(await update.state(ID)).toMatchObject({ phase: 'failed', version: '2.14.1', canStart: true })
    // trying again from there follows the new try
    hub.summary = READY
    expect(await update.start(ID)).toEqual({ ok: true })
    hub.summary = { ...READY, status: 'installing', canStart: false, reason: 'installing' }
    expect(await update.state(ID)).toMatchObject({ phase: 'updating' })
  })

  it('forgets a finished update after a while, and a hub that changed', async () => {
    const { hub, update, clock } = setup()
    await update.start(ID)
    hub.summary = { current: '2.15.0', status: 'current', newer: null, canStart: false, reason: 'nothing_newer' }
    hub.connection.version = '2.15.0'
    expect(await update.state(ID)).toMatchObject({ phase: 'done' })
    clock.now += 30 * 60_000
    expect(await update.state(ID)).toMatchObject({ phase: 'idle' })
  })
})
