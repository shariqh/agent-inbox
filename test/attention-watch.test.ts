// The attention watch per source (#19; #617 PR 4a; design
// docs/superpowers/specs/2026-11-17-remote-inbox-design.md §3.4 "Attention, per source"):
// electron/attention-watch.cjs polls one Inbox, reports its share of the dock badge and announces
// new asks, once for This Mac and once for the connected hub. A small pure piece beside it says once
// when the hub has been out of reach for two minutes.
//
// Nothing here starts Electron: `Notification` and the retainer are recorders, and each source is a
// real viewer (createViewer) on a scratch database. The last block runs the hub's watch through the
// real remote entry and its gate, on a loopback listener, the way test/remote-routes.test.ts does.
// Values are synthetic: `hub.example.ts.net`, `owner@example.com`, `laptop`.
import { EventEmitter } from 'node:events'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import attentionWatch from '../electron/attention-watch.cjs'
import { attentionEntries, laterEntries } from '../public/attention.js'
import { focusHashFor } from '../public/badge.js'
import { optionOrder } from '../public/card.js'
import { getBoard, getItem, insertItem, openDb, replyItem, upsertBoard } from '../src/store.js'
import { createViewer } from '../src/viewer.js'
import { startRemoteEntry } from '../src/viewer-remote.js'
import type { RemoteEntry } from '../src/viewer-remote.js'
import { HOST, LOGIN, ORIGIN, device, freePort, newSecret, setting, writeSetting } from './remote-fixtures.js'
import { removeScratchDirs, scratchDir } from './scratch.js'
import { waitUntil } from './wait.js'

const { badgeTotal, createAttentionWatch, createLostHubNotice, hubLive, lostHubText, sourceTitle, waitingHubFetch } = attentionWatch

afterEach(() => removeScratchDirs())

const LOCAL_BASE = 'http://127.0.0.1:4319/'
const HUB_BASE = `${ORIGIN}/`
const ID = '0123abcd'
const MINUTE = 60_000
const mods = Promise.resolve({ attentionEntries, laterEntries, focusHashFor, optionOrder }) as never

// ── recorders ───────────────────────────────────────────────────────────────────

type Options = { title: string; body: string; actions?: Array<{ type: 'button'; text: string }> }

function notifications() {
  const made: FakeNotification[] = []
  class FakeNotification extends EventEmitter {
    static supported = true
    static isSupported() { return FakeNotification.supported }
    shown = false
    constructor(readonly options: Options) {
      super()
      made.push(this)
    }
    show() { this.shown = true }
  }
  const retainer = { show: (note: FakeNotification) => note.show() }
  return { made, Notification: FakeNotification, retainer }
}

const quiet = { log: () => {}, error: () => {} }

interface Call { url: string; method: string; headers: Headers; body: string | null }

/** A source: a real viewer on a scratch database, reached through a recording fetch that can be made to fail. */
function source(base: string) {
  const dir = scratchDir('attention-watch-')
  const db = openDb(join(dir, 'inbox.db'))
  const viewer = createViewer(db)
  const calls: Call[] = []
  const state = { failing: false }
  const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    calls.push({ url, method: init.method ?? 'GET', headers, body: typeof init.body === 'string' ? init.body : null })
    if (state.failing) throw new TypeError('fetch failed')
    return viewer.request(url, init)
  })
  return { db, viewer, calls, state, fetchImpl, close: () => db.close() }
}

type Source = ReturnType<typeof source>

function watchOf(src: Source, extra: Record<string, unknown> = {}) {
  const n = notifications()
  const counts: number[] = []
  const shown: Array<string | null> = []
  const clock = { t: Date.now() }
  const watch = createAttentionWatch({
    base: LOCAL_BASE,
    fetchImpl: src.fetchImpl as never,
    label: null,
    show: (hash) => { shown.push(hash) },
    mods,
    Notification: n.Notification as never,
    retainer: n.retainer as never,
    onCount: (count) => { counts.push(count) },
    now: () => clock.t,
    logger: quiet,
    ...extra,
  })
  return { watch, ...n, counts, shown, clock }
}

const ask = (db: Database.Database, title = 'Ship it?', extra: Record<string, unknown> = {}) =>
  insertItem(db, { project: 'release', stream: '', agent: 'copilot', kind: 'question', title, ...extra })

const OPTIONS = [{ label: 'Hold' }, { label: 'Ship it', recommended: true }]

// ── This Mac ────────────────────────────────────────────────────────────────────

describe('createAttentionWatch: This Mac, as before', () => {
  let src: Source
  beforeEach(() => { src = source(LOCAL_BASE) })
  afterEach(() => src.close())

  it('announces nothing on the first poll, then one notification with its buttons for one new ask', async () => {
    ask(src.db, 'Already here')
    const w = watchOf(src)
    await w.watch.poll()
    expect(w.made).toEqual([])
    expect(w.counts).toEqual([1])

    const id = ask(src.db, 'Ship it?', { options: OPTIONS })
    await w.watch.poll()
    expect(w.made).toHaveLength(1)
    const note = w.made[0]!
    expect(note.options).toEqual({
      title: 'Agent Inbox — needs you',
      body: 'Ship it?',
      // the recommended option first
      actions: [{ type: 'button', text: 'Ship it' }, { type: 'button', text: 'Hold' }],
    })
    expect(note.shown).toBe(true)
    expect(w.counts).toEqual([1, 2])

    // a click lands on that ask through this source's show
    note.emit('click')
    expect(w.shown).toEqual([focusHashFor(id)])
    // and a button answers it through this source's fetch, at this source's base
    note.emit('action', { actionIndex: 0 })
    await waitUntil(() => getItem(src.db, id)!.reply === 'Ship it', 'the answer')
    const post = src.calls.find((call) => call.method === 'POST')!
    expect(post.url).toBe(`${LOCAL_BASE}api/items/${id}/reply`)
    expect(post.headers.get('origin')).toBe('http://127.0.0.1:4319')
  })

  it('sums several new asks in one notification with no buttons', async () => {
    const w = watchOf(src)
    await w.watch.poll()
    ask(src.db, 'One?', { options: OPTIONS })
    ask(src.db, 'Two?')
    ask(src.db, 'Three?')
    ask(src.db, 'Four?')
    await w.watch.poll()
    expect(w.made).toHaveLength(1)
    expect(w.made[0]!.options.title).toBe('Agent Inbox — 4 new need you')
    expect(w.made[0]!.options.body.split('\n')).toHaveLength(3)
    expect(w.made[0]!.options.actions).toBeUndefined()
    w.made[0]!.emit('click')
    expect(w.shown).toEqual([null])
  })

  // a plan's ask, as test/reply-watch.test.ts drives it: its buttons are pinned to the row's revision
  const PLAN = 'Release plan'
  const ROW = {
    label: 'Deploy window', status: 'blocked' as const, note: 'The release candidate is ready.', next_step: 'Choose the deploy window.',
    action_owner: 'decision' as const, impact: 'Schedules the release.', options: [{ label: 'Today', recommended: true }, { label: 'Tomorrow' }],
  }
  const plan = () => getBoard(src.db, 'release', PLAN)!
  const row = () => plan().rows.find((r) => r.label === ROW.label)!
  const replan = (rows: Array<Record<string, unknown>>) =>
    upsertBoard(src.db, { project: 'release', stream: '', agent: 'copilot', title: PLAN, expectedVersion: plan().revision, rows: rows as never })

  it('retries a refused answer against the plan read fresh, when only the plan around the ask moved', async () => {
    const w = watchOf(src)
    await w.watch.poll()
    upsertBoard(src.db, { project: 'release', stream: '', agent: 'copilot', title: PLAN, rows: [ROW] })
    await w.watch.poll()
    expect(w.made).toHaveLength(1)
    expect(w.made[0]!.options.actions).toEqual([{ type: 'button', text: 'Today' }, { type: 'button', text: 'Tomorrow' }])
    replan([{ label: 'Build', status: 'partial', note: 'CI is green.' }, { label: ROW.label, revision: row().revision, status: 'blocked' }])
    await w.watch.poll()
    expect(w.made).toHaveLength(1)
    w.made[0]!.emit('action', { actionIndex: 1 })
    await waitUntil(() => row().annotation === 'Tomorrow', 'the retried answer')
    // the first attempt was refused, the plans were read in full through this source's fetch, and the second applied
    const tail = src.calls.slice(-3).map((call) => `${call.method} ${call.url.slice(LOCAL_BASE.length)}`)
    expect(tail[0]).toMatch(/^POST api\/boards\/.+\/annotate$/)
    expect(tail[1]).toBe('GET api/boards')
    expect(tail[2]).toMatch(/^POST api\/boards\/.+\/annotate$/)
    expect(w.made).toHaveLength(1)
  })

  it('a refused answer whose ask changed is not lost: "Response not applied", and its click lands on the plan', async () => {
    const w = watchOf(src)
    await w.watch.poll()
    upsertBoard(src.db, { project: 'release', stream: '', agent: 'copilot', title: PLAN, rows: [ROW] })
    await w.watch.poll()
    replan([{ label: ROW.label, revision: row().revision, status: 'blocked', note: 'The window moved to Friday.' }])
    w.made[0]!.emit('action', { actionIndex: 0 })
    await waitUntil(() => w.made.length === 2, 'the not-applied notice')
    expect(w.made[1]!.options).toEqual({
      title: 'Agent Inbox — Response not applied',
      body: '“Today” was preserved here because the action changed. Open Agent Inbox to review it.',
    })
    expect(row().annotation).toBeNull()
    w.made[1]!.emit('click')
    expect(w.shown).toEqual([focusHashFor(plan().id)])
  })

  it('reminds when an answer waits for its agent, and wakes the adapter for This Mac', async () => {
    const wake = vi.fn(async () => {})
    const w = watchOf(src, { wake })
    const id = ask(src.db, 'Ship it?')
    replyItem(src.db, id, 'Go')
    await w.watch.poll()
    // the response is new on the first scan: the adapter hears of it at once
    expect(wake).toHaveBeenCalledTimes(1)
    expect((wake.mock.calls[0] as unknown as [Array<{ id: string }>])[0].map((t) => t.id)).toEqual([id])
    expect(w.made).toEqual([])
    w.clock.t += 2 * MINUTE
    await w.watch.poll()
    expect(w.made).toHaveLength(1)
    expect(w.made[0]!.options.title).toBe('Agent Inbox — waiting for agent')
    expect(w.made[0]!.options.body).toBe('release · Ship it?')
    expect(wake).toHaveBeenCalledTimes(2)
    w.made[0]!.emit('click')
    expect(w.shown).toEqual([focusHashFor(id)])
  })

  it('a wake adapter that fails stops nothing', async () => {
    const errors: string[] = []
    const w = watchOf(src, { wake: async () => { throw new Error('boom') }, logger: { log: () => {}, error: (line: string) => errors.push(line) } })
    replyItem(src.db, ask(src.db), 'Go')
    await w.watch.poll()
    expect(errors).toEqual(['[agent-inbox] wake adapter failed: boom'])
    expect(w.counts).toEqual([0])
  })

  it('never overlaps itself, never rejects, and a stopped watch announces and counts nothing', async () => {
    const w = watchOf(src)
    const a = w.watch.poll()
    const b = w.watch.poll()
    expect(b).toBe(a)
    await a
    expect(src.calls.filter((call) => call.url.includes('api/items?scope=attention'))).toHaveLength(1)
    src.state.failing = true
    await expect(w.watch.poll()).resolves.toBeUndefined()
    src.state.failing = false
    ask(src.db)
    const pending = w.watch.poll()
    w.watch.stop()
    await pending
    expect(w.made).toEqual([])
    expect(w.counts).toEqual([0])
  })

  it('stays quiet when the shared modules failed to load', async () => {
    const w = watchOf(src, { mods: Promise.reject(new Error('no module')) })
    await expect(w.watch.poll()).resolves.toBeUndefined()
    expect(src.calls).toEqual([])
    expect(w.counts).toEqual([])
  })
})

// ── the hub ─────────────────────────────────────────────────────────────────────

describe('createAttentionWatch: the connected hub', () => {
  let src: Source
  beforeEach(() => { src = source(HUB_BASE) })
  afterEach(() => src.close())

  const hubWatch = (extra: Record<string, unknown> = {}) => watchOf(src, { base: HUB_BASE, label: 'studio', ...extra })

  it('names the hub in every title', async () => {
    const w = hubWatch()
    await w.watch.poll()
    const one = ask(src.db, 'Ship it?', { options: OPTIONS })
    await w.watch.poll()
    expect(w.made[0]!.options.title).toBe('Agent Inbox · studio — needs you')
    ask(src.db, 'Two?')
    ask(src.db, 'Three?')
    await w.watch.poll()
    expect(w.made[1]!.options.title).toBe('Agent Inbox · studio — 2 new need you')
    // the hub cannot be reached when the button is pressed
    src.state.failing = true
    w.made[0]!.emit('action', { actionIndex: 0 })
    await waitUntil(() => w.made.length === 3, 'the not-applied notice')
    expect(w.made[2]!.options.title).toBe('Agent Inbox · studio — Response not applied')
    src.state.failing = false
    replyItem(src.db, one, 'Hold')
    w.clock.t += 2 * MINUTE
    await w.watch.poll()
    expect(w.made[3]!.options.title).toBe('Agent Inbox · studio — waiting for agent')
    replyItem(src.db, ask(src.db, 'Four?'), 'Go')
    w.clock.t += 2 * MINUTE
    await w.watch.poll()
    // the reminder for "Four?" and, its 15 minutes not up, nothing more for the first
    expect(w.made.at(-1)!.options.title).toBe('Agent Inbox · studio — waiting for agent')
  })

  it('a hub that cannot be written to says so truthfully; This Mac keeps its wording', async () => {
    const w = hubWatch()
    await w.watch.poll()
    ask(src.db, 'Ship it?', { options: OPTIONS })
    await w.watch.poll()
    src.state.failing = true
    w.made[0]!.emit('action', { actionIndex: 0 })
    await waitUntil(() => w.made.length === 2, 'the not-applied notice')
    const answer = w.made[0]!.options.actions![0]!.text
    expect(w.made[1]!.options.body).toBe(`“${answer}” was not saved on studio. Open Agent Inbox to answer it there.`)
    src.state.failing = false
    const named = hubWatch({ label: () => { throw new Error('no label') } })
    await named.watch.poll()
    ask(src.db, 'Another?', { options: OPTIONS })
    await named.watch.poll()
    src.state.failing = true
    named.made[0]!.emit('action', { actionIndex: 0 })
    await waitUntil(() => named.made.length === 2, 'the second not-applied notice')
    expect(named.made[1]!.options.body).toContain('was not saved on another Mac.')
  })

  it('refuses to be made without its own fetch, and never reaches for the global one', () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch')
    const n = notifications()
    const make = (extra: Record<string, unknown>) => () => createAttentionWatch({
      base: HUB_BASE, label: 'studio', show: () => {}, mods, Notification: n.Notification as never, retainer: n.retainer as never, logger: quiet, ...extra,
    })
    for (const bad of [{}, { fetchImpl: undefined }, { fetchImpl: null }, { fetchImpl: 'https://hub.example.ts.net/' }]) {
      let message = ''
      try {
        make(bad)()
      } catch (err) {
        expect(err).toBeInstanceOf(TypeError)
        message = (err as Error).message
      }
      expect(message).not.toBe('')
      expect(message).not.toContain('hub.example.ts.net')
      expect(message).not.toContain('studio')
    }
    expect(globalFetch).not.toHaveBeenCalled()
    globalFetch.mockRestore()
    // This Mac keeps its default
    expect(() => createAttentionWatch({ base: LOCAL_BASE, label: null, show: () => {}, mods, Notification: n.Notification as never, retainer: n.retainer as never, logger: quiet })).not.toThrow()
  })

  it('reads the label at each notification when it is a function', async () => {
    const name = { value: 'hub' }
    const w = hubWatch({ label: () => name.value })
    await w.watch.poll()
    name.value = 'studio'
    ask(src.db)
    await w.watch.poll()
    expect(w.made[0]!.options.title).toBe('Agent Inbox · studio — needs you')
  })

  it('sends every request through its fetch, to the base and a path joined with exactly one slash', async () => {
    const w = hubWatch()
    await w.watch.poll()
    const id = ask(src.db, 'Ship it?', { options: OPTIONS })
    await w.watch.poll()
    w.made[0]!.emit('action', { actionIndex: 1 })
    await waitUntil(() => getItem(src.db, id)!.reply === 'Hold', 'the answer')
    expect(src.calls.length).toBeGreaterThan(8)
    for (const call of src.calls) {
      expect(call.url.startsWith(HUB_BASE), call.url).toBe(true)
      expect(new URL(call.url).pathname.startsWith('/api/'), call.url).toBe(true)
      expect(call.url.slice(HUB_BASE.length).startsWith('/'), call.url).toBe(false)
    }
    expect(new Set(src.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`))).toEqual(new Set([
      'GET /api/items', 'GET /api/boards', 'GET /api/activity', 'GET /api/projects/closed', `POST /api/items/${id}/reply`,
    ]))
    // the answer's Origin is the hub's origin
    const post = src.calls.find((call) => call.method === 'POST')!
    expect(post.headers.get('origin')).toBe(ORIGIN)
  })

  it('keeps what it announced across a failed stretch: an ask that arrived meanwhile is announced once after', async () => {
    const w = hubWatch()
    ask(src.db, 'Old')
    await w.watch.poll()
    src.state.failing = true
    await w.watch.poll()
    const id = ask(src.db, 'Arrived while away', { options: OPTIONS })
    await w.watch.poll()
    expect(w.made).toEqual([])
    src.state.failing = false
    await w.watch.poll()
    expect(w.made).toHaveLength(1)
    expect(w.made[0]!.options.body).toBe('Arrived while away')
    w.made[0]!.emit('click')
    expect(w.shown).toEqual([focusHashFor(id)])
    await w.watch.poll()
    expect(w.made).toHaveLength(1)
    expect(w.counts).toEqual([1, 2, 2])
  })

  it('a new watch announces nothing that was already there', async () => {
    ask(src.db, 'Old one')
    ask(src.db, 'Old two')
    const w = hubWatch()
    await w.watch.poll()
    await w.watch.poll()
    expect(w.made).toEqual([])
    expect(w.counts).toEqual([2, 2])
  })

  it('never runs the wake adapter, even when given one', async () => {
    const wake = vi.fn(async () => {})
    const w = hubWatch({ wake })
    replyItem(src.db, ask(src.db), 'Go')
    await w.watch.poll()
    w.clock.t += 2 * MINUTE
    await w.watch.poll()
    expect(w.made.map((note) => note.options.title)).toEqual(['Agent Inbox · studio — waiting for agent'])
    expect(wake).not.toHaveBeenCalled()
  })

  it('logs no hub text and no host', async () => {
    const lines: string[] = []
    const w = hubWatch({ logger: { log: (line: string) => lines.push(line), error: (line: string) => lines.push(line) } })
    await w.watch.poll()
    ask(src.db, 'Secret plan?')
    await w.watch.poll()
    expect(lines).toEqual(['[agent-inbox] notifying: 1 new from the connected hub'])
  })
})

describe('sourceTitle', () => {
  it('leaves This Mac’s titles alone and puts the label after the app’s name for a hub', () => {
    expect(sourceTitle(null, 'Agent Inbox — needs you')).toBe('Agent Inbox — needs you')
    expect(sourceTitle('studio', 'Agent Inbox — 3 waiting for agent')).toBe('Agent Inbox · studio — 3 waiting for agent')
    // the label is text only, never a pattern
    expect(sourceTitle('$& $1', 'Agent Inbox — needs you')).toBe('Agent Inbox · $& $1 — needs you')
  })
})

// ── the dock badge ──────────────────────────────────────────────────────────────

describe('waitingHubFetch', () => {
  const refused = () => Object.assign(new Error('not the hub'), { code: 'not_hub_origin' })
  const OK = new Response('ok')

  function setup(first: () => Promise<Response> | Response | never, second: () => Promise<Response> | Response | never = () => OK) {
    const order: string[] = []
    const queue = [first, second]
    const hubFetch = vi.fn(async (input: string, init?: RequestInit) => {
      order.push(`fetch ${init?.method ?? 'GET'} ${input}`)
      return (queue.shift() ?? second)()
    })
    const settle = { resolve: () => {} }
    const recheck = vi.fn(() => {
      order.push('recheck')
      return new Promise<void>((resolve) => { settle.resolve = resolve })
    })
    const timers = new Map<number, { fn: () => void; ms: number }>()
    let next = 1
    const cleared: number[] = []
    const send = waitingHubFetch(hubFetch as never, recheck, {
      capMs: 7_000,
      setTimeout: (fn: () => void, ms: number) => { const id = next++; timers.set(id, { fn, ms }); return id },
      clearTimeout: (id: unknown) => { cleared.push(id as number); timers.delete(id as number) },
    })
    return { order, hubFetch, recheck, settle, timers, cleared, send }
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('a POST refused while the hub is checked again waits for the check and is sent once more', async () => {
    const t = setup(() => { throw refused() })
    const done = t.send('https://hub.example.ts.net/api/x', { method: 'post' })
    await tick()
    expect(t.order).toEqual(['fetch post https://hub.example.ts.net/api/x', 'recheck'])
    expect(t.timers.size).toBe(1)
    t.settle.resolve()
    await expect(done).resolves.toBe(OK)
    expect(t.order).toEqual(['fetch post https://hub.example.ts.net/api/x', 'recheck', 'fetch post https://hub.example.ts.net/api/x'])
    expect(t.timers.size).toBe(0)
    expect(t.cleared).toHaveLength(1)
  })

  it('its second refusal is thrown, and there is no third try', async () => {
    const second = refused()
    const t = setup(() => { throw refused() }, () => { throw second })
    const done = t.send('https://hub.example.ts.net/api/x', { method: 'POST' })
    await tick()
    t.settle.resolve()
    await expect(done).rejects.toBe(second)
    expect(t.hubFetch).toHaveBeenCalledTimes(2)
    expect(t.recheck).toHaveBeenCalledTimes(1)
  })

  it('a GET or HEAD refused the same way is thrown at once, and nothing is rechecked', async () => {
    for (const init of [undefined, {}, { method: 'GET' }, { method: 'head' }]) {
      const error = refused()
      const t = setup(() => { throw error })
      await expect(t.send('https://hub.example.ts.net/api/x', init)).rejects.toBe(error)
      expect(t.recheck).not.toHaveBeenCalled()
      expect(t.hubFetch).toHaveBeenCalledTimes(1)
      expect(t.timers.size).toBe(0)
    }
  })

  it('another error on a POST is thrown at once', async () => {
    const error = Object.assign(new Error('nope'), { code: 'ECONNRESET' })
    const t = setup(() => { throw error })
    await expect(t.send('https://hub.example.ts.net/api/x', { method: 'POST' })).rejects.toBe(error)
    const plain = new TypeError('fetch failed')
    const u = setup(() => { throw plain })
    await expect(u.send('https://hub.example.ts.net/api/x', { method: 'PUT' })).rejects.toBe(plain)
    expect(t.recheck).not.toHaveBeenCalled()
    expect(u.recheck).not.toHaveBeenCalled()
    expect(t.hubFetch).toHaveBeenCalledTimes(1)
  })

  it('a success is returned untouched and never rechecks', async () => {
    const t = setup(() => OK)
    await expect(t.send('https://hub.example.ts.net/api/x', { method: 'POST' })).resolves.toBe(OK)
    expect(t.recheck).not.toHaveBeenCalled()
  })

  it('waits at most the cap when the check never settles, then sends once more', async () => {
    const t = setup(() => { throw refused() })
    const done = t.send('https://hub.example.ts.net/api/x', { method: 'POST' })
    await tick()
    expect(t.hubFetch).toHaveBeenCalledTimes(1)
    expect([...t.timers.values()].map((timer) => timer.ms)).toEqual([7_000])
    ;[...t.timers.values()][0]!.fn()
    await expect(done).resolves.toBe(OK)
    expect(t.hubFetch).toHaveBeenCalledTimes(2)
    expect(t.recheck).toHaveBeenCalledTimes(1)
  })

  it('a check that rejects still leads to the one retry', async () => {
    const t = setup(() => { throw refused() })
    t.recheck.mockImplementationOnce(() => Promise.reject(new Error('probe failed')))
    await expect(t.send('https://hub.example.ts.net/api/x', { method: 'POST' })).resolves.toBe(OK)
    expect(t.hubFetch).toHaveBeenCalledTimes(2)
    expect(t.recheck).toHaveBeenCalledTimes(1)
    const throws = setup(() => { throw refused() })
    throws.recheck.mockImplementationOnce(() => { throw new Error('sync failure') })
    await expect(throws.send('https://hub.example.ts.net/api/x', { method: 'POST' })).resolves.toBe(OK)
    expect(throws.hubFetch).toHaveBeenCalledTimes(2)
  })

  it('uses the real timers by default', async () => {
    const hubFetch = vi.fn()
      .mockRejectedValueOnce(refused())
      .mockResolvedValueOnce(OK)
    const send = waitingHubFetch(hubFetch as never, () => Promise.resolve())
    await expect(send('https://hub.example.ts.net/api/x', { method: 'POST' })).resolves.toBe(OK)
  })
})

describe('badgeTotal: the dock badge is the sum of the sources', () => {
  const online = { mode: 'hub', id: ID, label: 'studio', state: 'online', reason: null, version: '2.12.0' } as const

  it('adds the hub’s count to This Mac’s while the hub is online and may be shown', () => {
    expect(badgeTotal({ local: 2, hubs: [{ id: ID, count: 3 }], connection: online, canShow: true })).toBe(5)
    expect(badgeTotal({ local: 0, hubs: [{ id: ID, count: 3 }], connection: online, canShow: true })).toBe(3)
    expect(badgeTotal({ local: 4 })).toBe(4)
  })

  it('counts a hub that is not online as 0', () => {
    for (const state of ['retrying', 'refused'] as const) {
      expect(badgeTotal({ local: 2, hubs: [{ id: ID, count: 3 }], connection: { ...online, state }, canShow: true })).toBe(2)
    }
  })

  it('counts a hub that cannot be shown as 0', () => {
    expect(badgeTotal({ local: 2, hubs: [{ id: ID, count: 3 }], connection: online, canShow: false })).toBe(2)
  })

  it('counts a dropped hub as 0: back to local, another hub, or no watch', () => {
    expect(badgeTotal({ local: 2, hubs: [{ id: ID, count: 3 }], connection: { mode: 'local' }, canShow: true })).toBe(2)
    expect(badgeTotal({ local: 2, hubs: [{ id: ID, count: 3 }], connection: { ...online, id: '89abcdef' }, canShow: true })).toBe(2)
    expect(badgeTotal({ local: 2, hubs: [], connection: online, canShow: true })).toBe(2)
  })

  it('never counts a negative, fractional or missing count', () => {
    expect(badgeTotal({ local: -1, hubs: [{ id: ID, count: 2.5 }], connection: online, canShow: true })).toBe(0)
    expect(badgeTotal({ local: Number.NaN })).toBe(0)
  })

  it('hubLive is the one rule for polling and counting', () => {
    expect(hubLive(online, ID, true)).toBe(true)
    expect(hubLive(online, ID, false)).toBe(false)
    expect(hubLive({ ...online, state: 'retrying' }, ID, true)).toBe(false)
    expect(hubLive(online, '89abcdef', true)).toBe(false)
    expect(hubLive(null, ID, true)).toBe(false)
  })
})

// ── the lost-hub notice ─────────────────────────────────────────────────────────

describe('createLostHubNotice', () => {
  const hub = (state: 'online' | 'retrying' | 'refused', reason: string | null = null, id = ID) =>
    ({ mode: 'hub', id, label: 'studio', state, reason, version: '2.12.0' }) as const

  function notice() {
    const n = notifications()
    const timers = new Map<number, { fn: () => void; ms: number }>()
    let next = 1
    const net = { online: true }
    const shown: string[] = []
    const lost = createLostHubNotice({
      Notification: n.Notification as never,
      retainer: n.retainer as never,
      isOnline: () => net.online,
      show: (id) => { shown.push(id) },
      setTimeout: (fn, ms) => { const id = next++; timers.set(id, { fn, ms }); return id },
      clearTimeout: (id) => { timers.delete(id as number) },
      logger: quiet,
    })
    /** Fires the pending timer, as two minutes passing would. */
    const elapse = () => {
      const pending = [...timers.entries()]
      expect(pending.length, 'one timer pending').toBe(1)
      const [id, timer] = pending[0]!
      expect(timer.ms).toBe(2 * MINUTE)
      timers.delete(id)
      timer.fn()
    }
    return { ...n, lost, timers, net, shown, elapse }
  }

  it('says so once after two minutes out of reach, with a click that shows the hub', () => {
    const t = notice()
    t.lost.update(hub('online'))
    t.lost.update(hub('retrying', 'unreachable'))
    t.lost.update(hub('retrying', 'not_running'))
    t.elapse()
    expect(t.made.map((note) => note.options)).toEqual([{
      title: "Agent Inbox — can't reach studio",
      body: 'New asks from studio will not show on this Mac until it is back. Agent Inbox keeps trying.',
    }])
    t.made[0]!.emit('click')
    expect(t.shown).toEqual([ID])
    // silent from then on while it stays out of reach
    t.lost.update(hub('retrying', 'unreachable'))
    t.lost.awake()
    expect(t.timers.size).toBe(0)
    expect(t.made).toHaveLength(1)
  })

  it('says nothing when the hub came back in time', () => {
    const t = notice()
    t.lost.update(hub('retrying', 'unreachable'))
    t.lost.update(hub('online'))
    expect(t.timers.size).toBe(0)
    expect(t.made).toEqual([])
  })

  it('restarts the two minutes on awake() and on another hub', () => {
    const t = notice()
    t.lost.update(hub('retrying', 'unreachable'))
    const first = [...t.timers.keys()]
    t.lost.awake()
    expect([...t.timers.keys()]).not.toEqual(first)
    expect(t.timers.size).toBe(1)
    const second = [...t.timers.keys()]
    t.lost.update(hub('retrying', 'unreachable', '89abcdef'))
    expect([...t.timers.keys()]).not.toEqual(second)
    t.elapse()
    t.made[0]!.emit('click')
    expect(t.shown).toEqual(['89abcdef'])
  })

  it('does not count time without a network: a timer that fires offline starts over', () => {
    const t = notice()
    t.lost.update(hub('retrying', 'unreachable'))
    t.net.online = false
    t.elapse()
    expect(t.made).toEqual([])
    t.net.online = true
    t.elapse()
    expect(t.made).toHaveLength(1)
  })

  it('says when the hub no longer accepts this Mac', () => {
    const t = notice()
    t.lost.update(hub('refused', 'refused'))
    t.elapse()
    expect(t.made[0]!.options).toEqual({
      title: "Agent Inbox — can't reach studio",
      body: "studio no longer accepts this Mac. Pair it again in Settings → Use another Mac's Inbox.",
    })
    // only the reason `refused` says so; any other refusal gets the keeps-trying wording
    expect(lostHubText(hub('refused', 'node_changed')).body).toBe('New asks from studio will not show on this Mac until it is back. Agent Inbox keeps trying.')
    expect(lostHubText(hub('refused', null)).body).toContain('keeps trying')
    expect(lostHubText(hub('retrying', 'refused')).body).toContain('keeps trying')
  })

  it('never counts a stop (the app quitting)', () => {
    const t = notice()
    t.lost.update(hub('retrying', 'unreachable'))
    t.lost.update(hub('retrying', 'stopped'))
    expect(t.timers.size).toBe(0)
    t.lost.awake()
    expect(t.timers.size).toBe(0)
    expect(t.made).toEqual([])
  })

  it('arms again only after the hub was online', () => {
    const t = notice()
    t.lost.update(hub('retrying', 'unreachable'))
    t.elapse()
    t.lost.update(hub('refused', 'refused'))
    expect(t.timers.size).toBe(0)
    t.lost.update(hub('online'))
    t.lost.update(hub('retrying', 'unreachable'))
    t.elapse()
    expect(t.made).toHaveLength(2)
  })

  it('a hub forgotten (back to local) cancels the wait', () => {
    const t = notice()
    t.lost.update(hub('retrying', 'unreachable'))
    t.lost.update({ mode: 'local' })
    expect(t.timers.size).toBe(0)
    expect(t.made).toEqual([])
  })
})

// ── through the real gate ───────────────────────────────────────────────────────

// The hub's side as a paired laptop meets it behind Tailscale Serve: the remote entry's listener on
// loopback, its gate and allowlist, a real store. The watch's fetch turns `https://hub.example.ts.net/…`
// into a request to that listener with the Host, login and device headers Serve and hubFetch add. If
// the gate ever refused a route the watch needs, a status below would be 403 and this test fails.
describe('createAttentionWatch: a hub watch through the real remote entry and its gate', () => {
  let dir: string
  let db: Database.Database
  let entry: RemoteEntry
  let port: number
  const secret = newSecret()
  const statuses: Array<{ route: string; status: number }> = []

  beforeAll(async () => {
    dir = scratchDir('attention-hub-')
    db = openDb(join(dir, 'inbox.db'))
    port = await freePort()
    writeSetting(dir, setting(port, [device(secret)]))
    const remoteApp = createViewer(db, { agentHome: dir, runtimeRoot: join(dir, 'runtime') })
    entry = startRemoteEntry({ app: remoteApp, dir, viewerPort: 4319 })
    await waitUntil(() => entry.status().listening, 'the remote entry')
  })
  afterAll(async () => {
    await entry.close()
    db.close()
  })

  /** What hubFetch and Serve make of a request to the hub: the same path on the listener, with the headers a paired laptop carries. */
  async function viaServe(input: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(input)
    expect(url.origin).toBe(ORIGIN)
    const headers = new Headers(init.headers)
    headers.set('Host', HOST)
    headers.set('Tailscale-User-Login', LOGIN)
    headers.set('X-Agent-Inbox-Device', secret)
    const body = typeof init.body === 'string' ? init.body : null
    if (body !== null) headers.set('Content-Length', String(Buffer.byteLength(body)))
    const method = init.method ?? 'GET'
    const answer = await new Promise<{ status: number; headers: Headers; body: Buffer }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, method, path: `${url.pathname}${url.search}`, headers: Object.fromEntries(headers) }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const out = new Headers()
          for (const [name, value] of Object.entries(res.headers)) if (typeof value === 'string') out.set(name, value)
          resolve({ status: res.statusCode ?? 0, headers: out, body: Buffer.concat(chunks) })
        })
        res.on('error', reject)
      })
      req.on('error', reject)
      req.end(body ?? undefined)
    })
    statuses.push({ route: `${method} ${url.pathname}`, status: answer.status })
    return new Response(answer.status === 304 ? null : answer.body.toString('utf8'), { status: answer.status, headers: answer.headers })
  }

  it('announces a question flagged on the hub, and its button stores the answer there', async () => {
    const w = watchOf({ fetchImpl: viaServe } as never, { base: HUB_BASE, label: 'studio' })
    await w.watch.poll()
    expect(w.made).toEqual([])
    // all four reads went through the gate and were answered
    expect(statuses).toEqual([
      { route: 'GET /api/items', status: 200 },
      { route: 'GET /api/boards', status: 200 },
      { route: 'GET /api/activity', status: 200 },
      { route: 'GET /api/projects/closed', status: 200 },
    ])

    const id = ask(db, 'Ship it?', { options: OPTIONS })
    await w.watch.poll()
    expect(w.made).toHaveLength(1)
    expect(w.made[0]!.options.title).toBe('Agent Inbox · studio — needs you')
    expect(w.made[0]!.options.body).toBe('Ship it?')
    expect(w.counts).toEqual([0, 1])

    w.made[0]!.emit('action', { actionIndex: 0 })
    await waitUntil(() => getItem(db, id)!.reply === 'Ship it', 'the answer stored on the hub')
    expect(statuses.at(-1)).toEqual({ route: `POST /api/items/${id}/reply`, status: 200 })
    // nothing was ever refused, and an unchanged read came back as a 304 from the conditional reader
    expect(statuses.filter((s) => s.status !== 200 && s.status !== 304)).toEqual([])
    expect(entry.status().refused).toEqual({ host: 0, funnel: 0, login: 0, path: 0, origin: 0, device: 0, route: 0, pair: 0 })
  })
})
