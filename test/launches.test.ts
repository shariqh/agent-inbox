// Issue #412 step 3: the launches table and its routes (design §6, §7, §9).
// A launch row holds launch facts only; /api/launches is a retained snapshot
// without the prompt or process ids; whether a running launch's driver is alive
// is read fresh from its lease; Stop is idempotent and unpinned; a hub nobody
// launches from keeps an empty table and every other snapshot unchanged.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import type Database from 'better-sqlite3'
import {
  claimDriverSlot, createLaunch, driverStopRequested, endLaunch, fileLaunchAsk, getItem, getLaunch, launchDriverAlive,
  listLaunchAskReplies, listLaunches, openDb, parkLaunch, readSnapshotState, recordLaunchProgress, replyItem,
  requestLaunchStop, resumeLaunch, settleLaunchAsk, listActivity, markDriverTurn, requestLaunchInterrupt, takeLaunchInterrupt,
  upsertActivity, holdDriverLeases, releaseDriverLeases, requestLaunchPark, takeLaunchPark,
} from '../src/store.js'
import type { NewLaunch } from '../src/store.js'
import { createViewer } from '../src/viewer.js'
import { removeScratchDirs, scratchDir } from './scratch.js'
import { SNAPSHOT_NAMES, SNAPSHOT_ROUTES } from './snapshot-probe.js'

const ID = (n: number) => `11111111-2222-4333-8444-${String(n).padStart(12, '0')}`
const T0 = Date.parse('2026-11-02T12:00:00.000Z')

let db: Database.Database
let clock = T0
function tick(ms = 1000): void {
  clock += ms
  vi.setSystemTime(clock)
}

const launch = (n: number, over: Partial<NewLaunch> = {}): NewLaunch => ({
  id: ID(n), host: 'copilot', project: 'agent-inbox', stream: 'main', cwd: '/work/agent-inbox', mode: 'ask',
  model: 'claude-haiku-4.5', reasoningEffort: 'none', budgetActiveMs: 7_200_000, budgetToolCalls: 500,
  prompt: 'Fix the failing test.', specVersion: 1, driverPid: 4242, ...over,
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  clock = T0
  vi.setSystemTime(clock)
  db = openDb(join(scratchDir('launches-'), 'inbox.db'))
})

afterEach(() => {
  if (db.open) db.close()
  removeScratchDirs()
  vi.useRealTimers()
})

describe('the launch row (§6)', () => {
  it('is created running by its driver, and refuses a reused id', () => {
    createLaunch(db, launch(1))
    expect(getLaunch(db, ID(1))).toMatchObject({
      status: 'running', host: 'copilot', mode: 'ask', prompt: 'Fix the failing test.', driver_pid: 4242, sessions: [],
      active_ms: 0, tool_calls: 0, end_reason: null, revision: 1, spec_version: 1,
    })
    expect(() => createLaunch(db, launch(1))).toThrow()
    expect(() => createLaunch(db, launch(2, { id: 'not-a-uuid' }))).toThrow(/lowercase UUID/)
  })

  it('records progress only while running, and parks keeping the ACP session while forgetting the processes', () => {
    createLaunch(db, launch(1))
    expect(recordLaunchProgress(db, ID(1), { childPgid: 900, childStartedAt: 'Mon Nov  2 12:00:00 2026', hostPid: 901, sessions: ['mcp-1'] })).toBe(true)
    expect(recordLaunchProgress(db, ID(1), { activeMs: 1234.4, toolCalls: 7 })).toBe(true)
    expect(getLaunch(db, ID(1))).toMatchObject({ child_pgid: 900, host_pid: 901, sessions: ['mcp-1'], active_ms: 1234, tool_calls: 7, revision: 3 })
    tick()
    expect(parkLaunch(db, ID(1), { acpSession: 'acp-1', activeMs: 2000, toolCalls: 8 })).toBe('parked')
    expect(getLaunch(db, ID(1))).toMatchObject({
      status: 'parked', acp_session: 'acp-1', child_pgid: null, host_pid: null, driver_pid: null, sessions: ['mcp-1'],
      parked_at: new Date(clock).toISOString(),
    })
    expect(recordLaunchProgress(db, ID(1), { toolCalls: 9 })).toBe(false)
  })

  it('never moves usage backwards: progress, park and end keep the larger totals', () => {
    createLaunch(db, launch(1))
    recordLaunchProgress(db, ID(1), { activeMs: 5000, toolCalls: 7 })
    expect(recordLaunchProgress(db, ID(1), { activeMs: 10, toolCalls: 1 })).toBe(true)
    expect(getLaunch(db, ID(1))).toMatchObject({ active_ms: 5000, tool_calls: 7 })
    parkLaunch(db, ID(1), { acpSession: 'acp-1', activeMs: 20, toolCalls: 2 })
    expect(getLaunch(db, ID(1))).toMatchObject({ active_ms: 5000, tool_calls: 7 })
    resumeLaunch(db, ID(1), 5000)
    recordLaunchProgress(db, ID(1), { activeMs: 6000, toolCalls: 9 })
    endLaunch(db, ID(1), { reason: 'stopped', activeMs: 0, toolCalls: 0 })
    expect(getLaunch(db, ID(1))).toMatchObject({ status: 'ended', active_ms: 6000, tool_calls: 9 })
  })

  it('a resume takes a parked row back exactly once, clearing why it was parked', () => {
    createLaunch(db, launch(1))
    expect(resumeLaunch(db, ID(1), 5000)).toBeNull()
    parkLaunch(db, ID(1), { acpSession: 'acp-1', activeMs: 0, toolCalls: 0, reason: 'Copilot could not load the session: busy' })
    expect(getLaunch(db, ID(1))).toMatchObject({ status: 'parked', acp_session: 'acp-1', park_reason: 'Copilot could not load the session: busy' })
    expect(resumeLaunch(db, ID(1), 5000)).toMatchObject({ status: 'running', driver_pid: 5000, parked_at: null, park_reason: null, acp_session: 'acp-1' })
    expect(resumeLaunch(db, ID(1), 5001)).toBeNull()
  })

  it('Stop is idempotent and unpinned: the first request stands, a parked launch ends at once, an ended one is left alone', () => {
    createLaunch(db, launch(1))
    createLaunch(db, launch(2))
    expect(driverStopRequested(db, ID(1))).toBe(false)
    tick()
    const first = new Date(clock).toISOString()
    expect(requestLaunchStop(db, ID(1))).toBe('stopping')
    // a usage write moves the revision; a second Stop still lands without one
    recordLaunchProgress(db, ID(1), { toolCalls: 3 })
    tick()
    expect(requestLaunchStop(db, ID(1))).toBe('stopping')
    expect(getLaunch(db, ID(1))!.stop_requested_at).toBe(first)
    expect(driverStopRequested(db, ID(1))).toBe(true)
    // a stop that arrives as the driver parks ends the launch instead
    expect(parkLaunch(db, ID(1), { acpSession: 'acp-1', activeMs: 0, toolCalls: 3 })).toBe('ended')
    expect(getLaunch(db, ID(1))).toMatchObject({ status: 'ended', end_reason: 'stopped' })

    parkLaunch(db, ID(2), { acpSession: 'acp-2', activeMs: 0, toolCalls: 0 })
    expect(requestLaunchStop(db, ID(2))).toBe('ended')
    expect(getLaunch(db, ID(2))).toMatchObject({ status: 'ended', end_reason: 'stopped', parked_at: null })
    expect(requestLaunchStop(db, ID(2))).toBeNull()
    expect(requestLaunchStop(db, ID(3))).toBeNull()
    expect(endLaunch(db, ID(2), { reason: 'idle' })).toBe(false)
  })

  it('reads a running launch’s driver as alive only while its own fresh driver lease stands', () => {
    createLaunch(db, launch(1))
    expect(launchDriverAlive(db, ID(1))).toBe(false)
    claimDriverSlot(db, { launchId: ID(2), pid: 77, nonce: 'n' }, 2)
    expect(launchDriverAlive(db, ID(1))).toBe(false)
    claimDriverSlot(db, { launchId: ID(1), pid: 78, nonce: 'n' }, 2)
    expect(launchDriverAlive(db, ID(1))).toBe(true)
    tick(91_000)
    expect(launchDriverAlive(db, ID(1))).toBe(false)
  })

  it('prunes ended launches after 30 days, with their asks’ mapping, when a new one starts', () => {
    createLaunch(db, launch(1))
    fileLaunchAsk(db, ID(1), { project: '@sessions', stream: '', agent: 'copilot', kind: 'question', title: 'Allow?' }, [{ optionId: 'allow_once', label: 'Allow once' }])
    endLaunch(db, ID(1), { reason: 'stopped' })
    createLaunch(db, launch(2))
    tick(30 * 24 * 60 * 60_000 + 1000)
    expect(createLaunch(db, launch(3))).toEqual({ pruned: [ID(1)] })
    expect(getLaunch(db, ID(1))).toBeNull()
    expect(getLaunch(db, ID(2))).not.toBeNull()
    expect(listLaunchAskReplies(db, ID(1))).toEqual([])
  })
})

describe('a launch’s asks (§4.2–4.3)', () => {
  it('files an @sessions question and its mapping in one transaction, and settling removes the mapping', () => {
    createLaunch(db, launch(1))
    expect(() => fileLaunchAsk(db, ID(1), { project: 'agent-inbox', stream: '', agent: 'copilot', kind: 'question', title: 'Allow?' }, [])).toThrow(/reserved/)
    const { itemId, revision } = fileLaunchAsk(db, ID(1), {
      project: '@sessions', stream: 'agent-inbox · main', agent: 'copilot', kind: 'question', title: 'Allow?', action_owner: 'approval',
      options: [{ label: 'Allow once' }, { label: 'Deny' }],
    }, [{ optionId: 'allow_once', label: 'Allow once' }, { optionId: 'reject_once', label: 'Deny' }])
    expect(revision).toBe(0)
    replyItem(db, itemId, 'allow_once', 'f'.repeat(64))
    expect(listLaunchAskReplies(db, ID(1))).toEqual([{ item_id: itemId, status: 'open', reply: 'allow_once', reply_context: 'f'.repeat(64), response_revision: 1 }])
    settleLaunchAsk(db, itemId, 'Allowed once in Agent Inbox.')
    expect(getItem(db, itemId)).toMatchObject({ status: 'resolved', outcome: 'Allowed once in Agent Inbox.' })
    expect(listLaunchAskReplies(db, ID(1))).toEqual([])
  })
})

describe('the routes (§6)', () => {
  it('/api/launches lists launch facts without the prompt, process ids or ACP session, open ones first and newest first', async () => {
    const app = createViewer(db)
    createLaunch(db, launch(1))
    tick()
    createLaunch(db, launch(2))
    recordLaunchProgress(db, ID(2), { childPgid: 900, hostPid: 901, sessions: ['mcp-2'] })
    parkLaunch(db, ID(1), { acpSession: 'acp-1', activeMs: 10, toolCalls: 1 })
    const response = await app.request('/api/launches')
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json() as Array<Record<string, unknown>>
    expect(body.map((l) => [l.id, l.status, l.resumable])).toEqual([[ID(2), 'running', false], [ID(1), 'parked', true]])
    for (const row of body) {
      for (const hidden of ['prompt', 'driver_pid', 'child_pgid', 'child_started_at', 'host_pid', 'acp_session']) expect(row, hidden).not.toHaveProperty(hidden)
    }
    expect(body[0]).toMatchObject({ sessions: ['mcp-2'], mode: 'ask', model: 'claude-haiku-4.5', budget_active_ms: 7_200_000 })
    // a 304 for the same representation
    const again = await app.request('/api/launches', { headers: { 'If-None-Match': response.headers.get('etag')! } })
    expect(again.status).toBe(304)
  })

  it('/api/launches/:id reads the driver fresh, and /prompt serves the prompt per launch', async () => {
    const app = createViewer(db)
    createLaunch(db, launch(1))
    const read = async (path: string) => {
      const response = await app.request(path)
      return { status: response.status, cache: response.headers.get('cache-control'), body: await response.json() as Record<string, unknown> }
    }
    expect(await read(`/api/launches/${ID(1)}`)).toMatchObject({ status: 200, cache: 'no-store', body: { id: ID(1), status: 'running', driver: 'lost' } })
    expect((await read(`/api/launches/${ID(1)}`)).body).not.toHaveProperty('prompt')
    claimDriverSlot(db, { launchId: ID(1), pid: 4242, nonce: 'n' }, 2)
    expect((await read(`/api/launches/${ID(1)}`)).body.driver).toBe('running')
    parkLaunch(db, ID(1), { acpSession: null, activeMs: 0, toolCalls: 0 })
    expect((await read(`/api/launches/${ID(1)}`)).body.driver).toBeNull()
    expect(await read(`/api/launches/${ID(1)}/prompt`)).toEqual({ status: 200, cache: 'no-store', body: { prompt: 'Fix the failing test.' } })
    expect((await read(`/api/launches/${ID(9)}`)).status).toBe(404)
    expect((await read('/api/launches/..%2F..%2Fetc/prompt')).status).toBe(404)
  })
})

describe('the ordinary reply and note routes refuse a launch’s ask (#412 step 3)', () => {
  it('answers 200 {ok:false, reason:launch_ask} and writes nothing, while other @sessions items keep their routes', async () => {
    const app = createViewer(db)
    createLaunch(db, launch(1))
    const { itemId } = fileLaunchAsk(db, ID(1), {
      project: '@sessions', stream: '', agent: 'copilot', kind: 'question', title: 'Allow?', action_owner: 'approval',
      options: [{ label: 'Allow once' }, { label: 'Deny' }],
    }, [{ optionId: 'allow_once', label: 'Allow once' }, { optionId: 'reject_once', label: 'Deny' }])
    const post = async (path: string, body: unknown) => {
      const response = await app.request(path, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      return { status: response.status, body: await response.json() }
    }
    expect(await post(`/api/items/${itemId}/reply`, { text: 'Allow once' })).toEqual({ status: 200, body: { ok: false, reason: 'launch_ask' } })
    expect(await post(`/api/items/${itemId}/reply`, {
      text: 'allow_once', context: 'f'.repeat(64), intent_client_id: 'c', intent_sequence: 1, intent_action_id: 'a',
    })).toEqual({ status: 200, body: { ok: false, reason: 'launch_ask' } })
    expect(await post(`/api/items/${itemId}/annotate`, { text: 'Looks fine.' })).toEqual({ status: 200, body: { ok: false, reason: 'launch_ask' } })
    // closing it here would strand its driver: Resolve and Dismiss refuse it too
    expect(await post(`/api/items/${itemId}/resolve`, undefined)).toEqual({ status: 200, body: { ok: false, reason: 'launch_ask' } })
    expect(await post(`/api/items/${itemId}/dismiss`, undefined)).toEqual({ status: 200, body: { ok: false, reason: 'launch_ask' } })
    expect(getItem(db, itemId)!.status).toBe('open')
    expect(getItem(db, itemId)).toMatchObject({ reply: null, reply_context: null, annotation: null, response_revision: 0 })
    // invalid input is still a 400 first
    expect((await post(`/api/items/${itemId}/reply`, { text: 1 })).status).toBe(400)
    // once settled, the mapping is gone and the item is closed as any other
    settleLaunchAsk(db, itemId, 'Session stopped.')
    expect((await post(`/api/items/${itemId}/reply`, { text: 'Allow once' })).body.reason).toBeUndefined()
  })
})

describe('the composer’s turn state and Interrupt and send (§5.3)', () => {
  const lease = { launchId: ID(1), pid: 4242, nonce: 'n' }
  function driven(session = 'mcp-1') {
    upsertActivity(db, { session, project: 'agent-inbox', stream: 'main', agent: 'copilot', doing: 'open', idle: true, claim: false })
    claimDriverSlot(db, lease, 2)
    holdDriverLeases(db, lease, [session])
  }

  it('serves a driven session’s launch and turn, and nothing new on any other row', () => {
    upsertActivity(db, { session: 'plain', project: 'agent-inbox', stream: 'main', agent: 'claude-code', doing: 'open', idle: true, claim: false })
    const plain = JSON.stringify(listActivity(db).find((a) => a.session === 'plain'))
    driven()
    expect(listActivity(db).find((a) => a.session === 'mcp-1')).toMatchObject({ driven: true, driven_launch: ID(1) })
    expect(listActivity(db).find((a) => a.session === 'mcp-1')).not.toHaveProperty('driven_turn')
    markDriverTurn(db, lease, 'turn', '2026-11-02T12:00:00.000Z')
    expect(listActivity(db).find((a) => a.session === 'mcp-1')!.driven_turn).toEqual({ state: 'turn', since: '2026-11-02T12:00:00.000Z' })
    markDriverTurn(db, lease, 'approval', '2026-11-02T12:00:00.000Z')
    expect(listActivity(db).find((a) => a.session === 'mcp-1')!.driven_turn).toEqual({ state: 'approval', since: '2026-11-02T12:00:00.000Z' })
    // another driver of the same launch cannot clear it
    markDriverTurn(db, { ...lease, nonce: 'other' }, null)
    expect(listActivity(db).find((a) => a.session === 'mcp-1')!.driven_turn).toBeDefined()
    markDriverTurn(db, lease, null)
    expect(listActivity(db).find((a) => a.session === 'mcp-1')).not.toHaveProperty('driven_turn')
    expect(JSON.stringify(listActivity(db).find((a) => a.session === 'plain'))).toBe(plain)
    markDriverTurn(db, lease, 'turn')
    releaseDriverLeases(db, lease)
    expect(listActivity(db).find((a) => a.session === 'mcp-1')).not.toHaveProperty('driven_turn')
  })

  it('an interrupt is requested only for a running launch not stopping, and taken once', () => {
    expect(requestLaunchInterrupt(db, ID(1))).toBe(false)
    createLaunch(db, launch(1))
    expect(requestLaunchInterrupt(db, ID(1))).toBe(true)
    expect(requestLaunchInterrupt(db, ID(1))).toBe(true)
    expect(takeLaunchInterrupt(db, ID(1))).toBe(true)
    expect(takeLaunchInterrupt(db, ID(1))).toBe(false)
    requestLaunchStop(db, ID(1))
    expect(requestLaunchInterrupt(db, ID(1))).toBe(false)
    createLaunch(db, launch(2))
    parkLaunch(db, ID(2), { acpSession: 'acp', activeMs: 0, toolCalls: 0 })
    expect(requestLaunchInterrupt(db, ID(2))).toBe(false)
    expect(requestLaunchInterrupt(db, '../x')).toBe(false)
  })

  it('Park now is requested only for a running launch not stopping, taken once, and gone with its driver (PR 4)', async () => {
    expect(requestLaunchPark(db, ID(1))).toBe(false)
    createLaunch(db, launch(1))
    const app = createViewer(db)
    expect(await (await app.request(`/api/launches/${ID(1)}/park`, { method: 'POST' })).json()).toEqual({ ok: true })
    expect(takeLaunchPark(db, ID(1))).toBe(true)
    expect(takeLaunchPark(db, ID(1))).toBe(false)
    expect(requestLaunchPark(db, ID(1))).toBe(true)
    releaseDriverLeases(db, { launchId: ID(1), pid: 4242, nonce: 'n' })
    expect(takeLaunchPark(db, ID(1))).toBe(false)
    requestLaunchStop(db, ID(1))
    expect(await (await app.request(`/api/launches/${ID(1)}/park`, { method: 'POST' })).json()).toEqual({ ok: false })
    expect(requestLaunchPark(db, 'x')).toBe(false)
  })

  it('the interrupt route answers whether the request was recorded', async () => {
    createLaunch(db, launch(1))
    const app = createViewer(db)
    expect(await (await app.request(`/api/launches/${ID(1)}/interrupt`, { method: 'POST' })).json()).toEqual({ ok: true })
    expect(await (await app.request(`/api/launches/${ID(9)}/interrupt`, { method: 'POST' })).json()).toEqual({ ok: false })
  })
})

describe('the transcript’s events route (§3.6)', () => {
  function log(id: string) {
    const dir = join(db.name, '..', 'launches', id)
    mkdirSync(dir, { recursive: true })
    return join(dir, 'events.ndjson')
  }
  const read = async (app: ReturnType<typeof createViewer>, path: string) => {
    const response = await app.request(path)
    return { status: response.status, cache: response.headers.get('cache-control'), body: await response.json() as Record<string, unknown> }
  }

  it('reads whole lines from a byte offset, skips unreadable ones, and starts again when the log rotated', async () => {
    createLaunch(db, launch(1))
    const app = createViewer(db)
    expect(await read(app, `/api/launches/${ID(1)}/events`)).toEqual({ status: 200, cache: 'no-store', body: { events: [], next: 0, more: false, rotated: false } })
    const file = log(ID(1))
    writeFileSync(file, '{"event":"prompt","kind":"task"}\nnot json\n{"event":"agent_text","text":"hal')
    const first = await read(app, `/api/launches/${ID(1)}/events?after=0`)
    // an unfinished last line is waited on at the page's pace: no "more" to re-read at once
    expect(first.body).toMatchObject({ events: [{ event: 'prompt', kind: 'task' }], more: false, rotated: false })
    const next = first.body.next as number
    expect((await read(app, `/api/launches/${ID(1)}/events?after=${next}`)).body).toEqual({ events: [], next, more: false, rotated: false })
    appendFileSync(file, 'f"}\n')
    expect((await read(app, `/api/launches/${ID(1)}/events?after=${next}`)).body).toMatchObject({ events: [{ event: 'agent_text', text: 'half' }], more: false })
    writeFileSync(file, '{"event":"ended","reason":"stopped"}\n')
    expect((await read(app, `/api/launches/${ID(1)}/events?after=${next + 100}`)).body).toMatchObject({ events: [{ event: 'ended' }], rotated: true, next: 37 })
  })

  it('reads at most 256 KiB at a time, and skips a line longer than that', async () => {
    createLaunch(db, launch(1))
    const app = createViewer(db)
    const file = log(ID(1))
    const line = (n: number) => `${JSON.stringify({ event: 'agent_text', text: 'x'.repeat(1000), n })}\n`
    writeFileSync(file, Array.from({ length: 400 }, (_, n) => line(n)).join(''))
    const first = await read(app, `/api/launches/${ID(1)}/events`)
    expect(first.body.more).toBe(true)
    expect((first.body.events as unknown[]).length).toBeLessThan(400)
    expect(first.body.next as number).toBeLessThanOrEqual(256 * 1024)
    const rest = await read(app, `/api/launches/${ID(1)}/events?after=${first.body.next}`)
    expect((first.body.events as unknown[]).length + (rest.body.events as unknown[]).length).toBe(400)
    writeFileSync(file, `${JSON.stringify({ text: 'y'.repeat(300 * 1024) })}\n{"event":"ended"}\n`)
    const huge = await read(app, `/api/launches/${ID(1)}/events?after=0`)
    expect(huge.body).toMatchObject({ events: [], next: 256 * 1024, more: true })
    expect((await read(app, `/api/launches/${ID(1)}/events?after=${huge.body.next}`)).body).toMatchObject({ events: [{ event: 'ended' }] })
  })

  it('answers 404 for an unknown launch and 400 for a bad offset', async () => {
    createLaunch(db, launch(1))
    const app = createViewer(db)
    expect((await read(app, `/api/launches/${ID(9)}/events`)).status).toBe(404)
    expect((await read(app, `/api/launches/..%2Fx/events`)).status).toBe(404)
    for (const bad of ['-1', 'abc', '1e3', '9'.repeat(16)]) expect((await read(app, `/api/launches/${ID(1)}/events?after=${bad}`)).status, bad).toBe(400)
  })
})

describe('off means off (§9 d)', () => {
  it('a hub nobody launches from has an empty launches table, and a launch’s whole life moves no other snapshot', async () => {
    const app = createViewer(db)
    expect(listLaunches(db)).toEqual([])
    expect(await (await app.request('/api/launches')).text()).toBe('[]')
    const others = SNAPSHOT_NAMES.filter((name) => name !== 'launches')
    const tags = async () => Object.fromEntries(await Promise.all(others.map(async (name) => [name, (await app.request(SNAPSHOT_ROUTES[name])).headers.get('etag')])))
    const before = await tags()
    const versions = readSnapshotState(db).domains
    createLaunch(db, launch(1))
    recordLaunchProgress(db, ID(1), { childPgid: 900, sessions: ['mcp-1'], activeMs: 5, toolCalls: 1 })
    requestLaunchStop(db, ID(1))
    endLaunch(db, ID(1), { reason: 'stopped' })
    expect(await tags()).toEqual(before)
    const after = readSnapshotState(db).domains
    for (const domain of Object.keys(versions) as Array<keyof typeof versions>) {
      if (domain !== 'launches') expect(after[domain], domain).toBe(versions[domain])
    }
  })
})
