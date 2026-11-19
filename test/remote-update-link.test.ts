// Updating the hub from the connecting Mac (#637), the hub's main half: what main reports to its
// viewer from the update controller's state and its own gates, and what it does with a paired
// device's request. The request names nothing: main checks its own state again and runs its own
// controller's download and install for the release that controller verified. The real viewer relay
// (src/remote-update.ts) answers through Hono's app.request here, so the two halves are tested
// together; no socket, no app, no network.
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import linkModule from '../electron/remote-update.cjs'
import { createRemoteUpdate, remoteUpdateReportRoute } from '../src/remote-update.js'

const { REPORT_EVERY_MS, createRemoteUpdateLink, updateSummary } = linkModule

const OWNER_TOKEN = 'owner-token-for-the-test-0123456789'
const BASE = 'http://127.0.0.1:4319/'
const LAPTOP = '3f9c0a1b2d4e5f60'

afterEach(() => {
  vi.restoreAllMocks()
})

const offer = (extra: Record<string, unknown> = {}) => ({
  version: '2.15.0', tag: 'v2.15.0', releaseUrl: 'https://github.com/shariqh/agent-inbox/releases/tag/v2.15.0',
  target: { packageType: 'dmg', installStrategy: 'macos-dmg' }, downloadable: true, installable: true, installPermitted: true, ...extra,
})
const state = (status: string, extra: Record<string, unknown> = {}) => ({ status, currentVersion: '2.14.1', automaticChecks: false, checkedAt: null, message: '', ...extra })
const base = { version: '2.14.1', setupRunning: false, quitting: false, installing: false, running: false }

describe('updateSummary: what a paired device may see, and whether it may start', () => {
  it('offers a start for a verified, installable newer release on a window that may install', () => {
    expect(updateSummary({ ...base, state: state('available', { available: offer() }) }))
      .toEqual({ current: '2.14.1', status: 'available', newer: '2.15.0', canStart: true, reason: null })
    expect(updateSummary({ ...base, state: state('verified', { available: offer() }) }))
      .toEqual({ current: '2.14.1', status: 'available', newer: '2.15.0', canStart: true, reason: null })
    // a try that did not work may be tried again
    for (const status of ['download-failed', 'install-failed']) {
      expect(updateSummary({ ...base, state: state(status, { available: offer() }) }))
        .toEqual({ current: '2.14.1', status: 'failed', newer: '2.15.0', canStart: true, reason: null })
    }
  })

  it.each([
    ['nothing newer verified', state('current'), 'current', null, 'nothing_newer'],
    ['never checked', state('idle'), 'current', null, 'nothing_newer'],
    ['a check that did not verify', state('unverified'), 'current', null, 'nothing_newer'],
    ['stale release information', state('stale'), 'current', null, 'nothing_newer'],
    ['a check running', state('checking'), 'checking', null, 'busy'],
    ['a download running here', state('downloading', { available: offer() }), 'downloading', '2.15.0', 'busy'],
    ['an install running', state('installing', { available: offer() }), 'installing', '2.15.0', 'installing'],
    ['an installation that cannot update itself', state('unsupported'), 'current', null, 'not_here'],
    ['a release only the release page offers (a .deb, an app outside Applications)', state('available', { available: offer({ downloadable: false, installable: false }) }), 'available', '2.15.0', 'not_here'],
    ['a release that is installable but not downloadable here', state('available', { available: offer({ downloadable: false }) }), 'available', '2.15.0', 'not_here'],
    ['a release that is downloadable but not installable here', state('available', { available: offer({ installable: false }) }), 'available', '2.15.0', 'not_here'],
    ['a download with no installer here', state('available', { available: offer({ installable: false, installPermitted: false }) }), 'available', '2.15.0', 'not_here'],
    ['a window that may not install right now (a reload)', state('verified', { available: offer({ installPermitted: false }) }), 'available', '2.15.0', 'busy'],
  ])('refuses for %s', (_name, given, status, newer, reason) => {
    expect(updateSummary({ ...base, state: given })).toEqual({ current: '2.14.1', status, newer, canStart: false, reason })
  })

  it('refuses while agent setup runs, an install runs, the app quits, or a remote update is under way', () => {
    const ready = state('verified', { available: offer() })
    expect(updateSummary({ ...base, state: ready, setupRunning: true })).toMatchObject({ canStart: false, reason: 'setup_running' })
    expect(updateSummary({ ...base, state: ready, installing: true })).toMatchObject({ canStart: false, reason: 'installing' })
    expect(updateSummary({ ...base, state: ready, quitting: true })).toMatchObject({ canStart: false, reason: 'busy' })
    expect(updateSummary({ ...base, state: ready, running: true })).toMatchObject({ status: 'installing', canStart: false, reason: 'installing' })
    expect(updateSummary({ ...base, state: state('downloading', { available: offer() }), running: true })).toMatchObject({ status: 'downloading', reason: 'installing' })
  })

  it('never throws on a running version that is not three numbers: nothing is newer than it', () => {
    expect(updateSummary({ ...base, version: 'dev', state: state('available', { currentVersion: 'dev', available: offer() }) }))
      .toEqual({ current: 'dev', status: 'current', newer: null, canStart: false, reason: 'nothing_newer' })
  })

  it('says not_here for a build with no update controller, on the app\'s own version', () => {
    expect(updateSummary({ ...base, version: '2.14.1', state: null })).toEqual({ current: '2.14.1', status: 'current', newer: null, canStart: false, reason: 'not_here' })
  })

  it('never offers a release that is not newer than the running app', () => {
    expect(updateSummary({ ...base, state: state('available', { available: offer({ version: '2.14.1' }) }) }))
      .toEqual({ current: '2.14.1', status: 'current', newer: null, canStart: false, reason: 'nothing_newer' })
  })
})

/** A fake update controller: records calls, and each step moves its state as the real one would. */
function fakeController(initial: ReturnType<typeof state>) {
  const calls: string[] = []
  let current = initial
  const listeners: Array<() => void> = []
  const set = (next: ReturnType<typeof state>) => {
    current = next
    for (const listener of listeners) listener()
    return current
  }
  const controller = {
    calls,
    getState: () => current,
    isInstalling: () => current.status === 'installing',
    set,
    onChange: (listener: () => void) => listeners.push(listener),
    downloadResult: state('verified', { available: offer() }) as ReturnType<typeof state>,
    checkNow: vi.fn(async () => { calls.push('checkNow'); return current }),
    downloadNow: vi.fn(async () => {
      calls.push('downloadNow')
      set(state('downloading', { available: offer() }))
      return set(controller.downloadResult)
    }),
    installNow: vi.fn(async () => {
      calls.push('installNow')
      return set(state('installing', { available: offer() }))
    }),
  }
  return controller
}

function setup(initial = state('available', { available: offer() }), extra: { setupRunning?: () => boolean; quitting?: () => boolean; shared?: () => boolean } = {}) {
  const clock = { now: 1_000_000 }
  const relay = createRemoteUpdate({ version: '2.14.1', now: () => clock.now })
  const viewer = new Hono()
  viewer.post('/api/remote-entry/update', remoteUpdateReportRoute(relay, OWNER_TOKEN))
  const sent: Array<{ url: string; headers: Record<string, string>; redirect: RequestRedirect | undefined }> = []
  const controller = fakeController(initial)
  const notices: unknown[] = []
  const link = createRemoteUpdateLink({
    controller: () => controller,
    version: '2.14.1',
    base: BASE,
    ownerToken: OWNER_TOKEN,
    fetch: async (url: string, init: RequestInit) => {
      const headers = Object.fromEntries(new Headers(init.headers).entries())
      sent.push({ url, headers, redirect: init.redirect })
      // as Node's fetch sends a string body: with its length
      const body = String(init.body)
      return viewer.request(new URL(url).pathname, { ...init, headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) }, body })
    },
    shared: extra.shared ?? (() => true),
    setupRunning: extra.setupRunning ?? (() => false),
    quitting: extra.quitting ?? (() => false),
    deviceLabel: async (id: string) => (id === LAPTOP ? 'laptop' : null),
    notify: (notice: unknown) => notices.push(notice),
    now: () => clock.now,
    setInterval: () => 0,
    clearInterval: () => {},
  })
  controller.onChange(() => link.changed())
  return { relay, controller, link, sent, notices, clock }
}

describe('createRemoteUpdateLink: main and its viewer', () => {
  it('reports to the loopback route with the owner token and the loopback Origin', async () => {
    const { relay, link, sent } = setup()
    await link.sync()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.url).toBe(`${BASE}api/remote-entry/update`)
    expect(sent[0]!.headers['x-agent-inbox-owner']).toBe(OWNER_TOKEN)
    expect(sent[0]!.headers.origin).toBe('http://127.0.0.1:4319')
    expect(relay.summary()).toEqual({ current: '2.14.1', status: 'available', newer: '2.15.0', canStart: true, reason: null })
  })

  it('reports every few seconds once started, and stops', () => {
    const timers: Array<{ fn: () => void; ms: number }> = []
    const cleared: unknown[] = []
    const link = createRemoteUpdateLink({
      controller: () => null, version: '2.14.1', base: BASE, ownerToken: OWNER_TOKEN, fetch: async () => new Response('null', { status: 500 }),
      shared: () => true, setupRunning: () => false, quitting: () => false, deviceLabel: async () => null, notify: () => {},
      setInterval: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return 7 }, clearInterval: (id: unknown) => cleared.push(id),
    })
    link.start()
    link.start()
    expect(timers).toEqual([{ fn: expect.any(Function), ms: REPORT_EVERY_MS }])
    expect(REPORT_EVERY_MS).toBeLessThanOrEqual(5_000)
    link.stop()
    expect(cleared).toEqual([7])
  })

  it('on a device\'s request: notifies with its label and the version, downloads, then installs, and reports each step', async () => {
    const { relay, controller, link, notices } = setup()
    await link.sync()
    expect(relay.start(LAPTOP)).toEqual({ ok: true })
    await link.sync()
    await link.settled()
    expect(controller.calls).toEqual(['downloadNow', 'installNow'])
    expect(notices).toEqual([{ label: 'laptop', version: '2.15.0' }])
    expect(relay.summary()).toMatchObject({ status: 'installing', canStart: false, reason: 'installing' })
  })

  it('installs a download already verified at once', async () => {
    const { relay, controller, link } = setup(state('verified', { available: offer() }))
    await link.sync()
    relay.start(LAPTOP)
    await link.sync()
    await link.settled()
    expect(controller.calls).toEqual(['installNow'])
  })

  it('names no device it does not know, and still updates', async () => {
    const { relay, link, notices } = setup()
    await link.sync()
    relay.start('0a1b2c3d4e5f6071')
    await link.sync()
    await link.settled()
    expect(notices).toEqual([{ label: null, version: '2.15.0' }])
  })

  it('does not install when the download did not verify, and reports the failure', async () => {
    const { relay, controller, link } = setup()
    controller.downloadResult = state('download-failed', { available: offer() })
    await link.sync()
    relay.start(LAPTOP)
    await link.sync()
    await link.settled()
    await link.sync()
    expect(controller.calls).toEqual(['downloadNow'])
    expect(relay.summary()).toMatchObject({ status: 'failed', canStart: true })
  })

  it('does not install when agent setup started during the download', async () => {
    let setupRuns = false
    const { relay, controller, link } = setup(undefined, { setupRunning: () => setupRuns })
    controller.downloadNow.mockImplementation(async () => {
      controller.calls.push('downloadNow')
      setupRuns = true
      return controller.set(state('verified', { available: offer() }))
    })
    await link.sync()
    relay.start(LAPTOP)
    await link.sync()
    await link.settled()
    expect(controller.calls).toEqual(['downloadNow'])
  })

  it('does not install a download that ends on a different release than the one main started with', async () => {
    const { relay, controller, link } = setup()
    controller.downloadResult = state('verified', { available: offer({ version: '2.16.0' }) })
    await link.sync()
    relay.start(LAPTOP)
    await link.sync()
    await link.settled()
    expect(controller.calls).toEqual(['downloadNow'])
  })

  // the request names nothing: the hub installs the newest release its own controller has verified
  // when the request arrives, which can be newer than what the connecting Mac's page last showed
  it('installs the release its controller verified when the request arrives, and the notice names that one', async () => {
    const { relay, controller, link, notices } = setup()
    await link.sync()
    // the device was shown 2.15.0 ...
    expect(relay.get()).toMatchObject({ newer: '2.15.0', canStart: true })
    // ... the press reaches the viewer before main reports again ...
    expect(relay.start(LAPTOP)).toEqual({ ok: true })
    // ... and the controller has meanwhile verified 2.16.0
    controller.downloadResult = state('verified', { available: offer({ version: '2.16.0' }) })
    controller.set(state('available', { available: offer({ version: '2.16.0' }) }))
    const installed: unknown[] = []
    const install = controller.installNow.getMockImplementation()!
    controller.installNow.mockImplementation(async () => {
      installed.push((controller.getState() as unknown as { available: { version: string } }).available.version)
      return install()
    })
    await link.sync()
    await link.settled()
    expect(controller.calls).toEqual(['downloadNow', 'installNow'])
    expect(installed).toEqual(['2.16.0'])
    expect(notices).toEqual([{ label: 'laptop', version: '2.16.0' }])
  })

  it('does not install while the window may not install (the grant the local install needs)', async () => {
    const { relay, controller, link } = setup()
    controller.downloadResult = state('verified', { available: offer({ installPermitted: false }) })
    await link.sync()
    relay.start(LAPTOP)
    await link.sync()
    await link.settled()
    expect(controller.calls).toEqual(['downloadNow'])
  })

  it('checks main\'s own state again: a request the viewer let through is dropped when main cannot start', async () => {
    let setupRuns = false
    const { relay, controller, link, notices } = setup(undefined, { setupRunning: () => setupRuns })
    await link.sync()
    relay.start(LAPTOP)
    setupRuns = true
    await link.sync()
    await link.settled()
    expect(controller.calls).toEqual([])
    expect(notices).toEqual([])
    await link.sync()
    expect(relay.summary()).toMatchObject({ canStart: false, reason: 'setup_running' })
  })

  it('handles each request once, and ignores an answer of the wrong shape', async () => {
    const { controller, link } = setup()
    const answers = [
      { request: { id: '00000000000000aa', device: LAPTOP }, looked: false },
      { request: { id: '00000000000000aa', device: LAPTOP }, looked: false },
      { request: { id: 'x', device: LAPTOP }, looked: false },
      { request: { id: '00000000000000bb', device: 'laptop' }, looked: false },
    ]
    const replay = createRemoteUpdateLink({
      controller: () => controller, version: '2.14.1', base: BASE, ownerToken: OWNER_TOKEN,
      fetch: async () => new Response(JSON.stringify(answers.shift()), { status: 200 }),
      shared: () => true, setupRunning: () => false, quitting: () => false, deviceLabel: async () => null, notify: () => {}, setInterval: () => 0, clearInterval: () => {},
    })
    void link
    await replay.sync()
    await replay.settled()
    controller.set(state('available', { available: offer() }))
    await replay.sync()
    await replay.sync()
    await replay.sync()
    await replay.settled()
    expect(controller.calls).toEqual(['downloadNow', 'installNow'])
  })

  it('reports once more right after a new request, and never loops on a request it has seen', async () => {
    const controller = fakeController(state('current'))
    let fetches = 0
    const link = createRemoteUpdateLink({
      controller: () => controller, version: '2.14.1', base: BASE, ownerToken: OWNER_TOKEN,
      fetch: async () => { fetches += 1; return new Response(JSON.stringify({ request: { id: '00000000000000aa', device: LAPTOP }, looked: false })) },
      shared: () => true, setupRunning: () => false, quitting: () => false, deviceLabel: async () => null, notify: () => {}, setInterval: () => 0, clearInterval: () => {},
    })
    await link.sync()
    expect(fetches).toBe(2)
    await link.sync()
    expect(fetches).toBe(3)
    // nothing newer here: the request starts nothing
    expect(controller.calls).toEqual([])
  })

  it('checks for a release when a device looked and nothing newer is known, at most once an hour', async () => {
    const { relay, controller, link, clock } = setup(state('idle'))
    await link.sync()
    relay.get()
    await link.sync()
    expect(controller.calls).toEqual(['checkNow'])
    relay.get()
    await link.sync()
    expect(controller.calls).toEqual(['checkNow'])
    clock.now += 60 * 60_000
    relay.get()
    await link.sync()
    expect(controller.calls).toEqual(['checkNow', 'checkNow'])
    // nobody looked: no check
    clock.now += 2 * 60 * 60_000
    await link.sync()
    expect(controller.calls).toEqual(['checkNow', 'checkNow'])
  })

  it('does not check when the hub already knows a newer release, or cannot update itself', async () => {
    for (const given of [state('available', { available: offer() }), state('unsupported'), state('checking')]) {
      const { relay, controller, link } = setup(given)
      await link.sync()
      relay.get()
      await link.sync()
      expect(controller.calls).toEqual([])
    }
  })

  // a redirect must not carry the owner token anywhere else
  it('sends its report with redirect: error', async () => {
    const { link, sent } = setup()
    await link.sync()
    expect(sent.map((one) => one.redirect)).toEqual(['error'])
  })

  // the guard in maybeCheck: a check must not run beside a remote update's own download
  it('does not check for a release while its own remote update is running', async () => {
    const { relay, controller, link } = setup()
    let finish!: () => void
    const held = new Promise<void>((resolve) => { finish = resolve })
    controller.downloadNow.mockImplementation(async () => {
      controller.calls.push('downloadNow')
      // the controller's state reads as one a look may check, while main's download is still running
      controller.set(state('stale'))
      await held
      return controller.set(state('verified', { available: offer() }))
    })
    await link.sync()
    relay.start(LAPTOP)
    await link.sync()
    relay.get()
    await link.sync()
    expect(controller.calls).toEqual(['downloadNow'])
    finish()
    await link.settled()
    expect(controller.calls).toEqual(['downloadNow', 'installNow'])
  })

  it('never rejects: a viewer that is down is retried at the next report', async () => {
    const link = createRemoteUpdateLink({
      controller: () => null, version: '2.14.1', base: BASE, ownerToken: OWNER_TOKEN, fetch: async () => { throw new Error('ECONNREFUSED') },
      shared: () => true, setupRunning: () => false, quitting: () => false, deviceLabel: async () => null, notify: () => {}, setInterval: () => 0, clearInterval: () => {},
    })
    await expect(link.sync()).resolves.toBeUndefined()
  })
})

// the report loop runs only while this Mac shares its Inbox with a paired device (#637, fix round)
describe('createRemoteUpdateLink: only while this Mac shares its Inbox', () => {
  it('sends nothing at all while not shared: not on a tick, not on a change of the controller, not on a sync', async () => {
    let shared = false
    const { controller, link, sent } = setup(undefined, { shared: () => shared })
    link.start()
    link.changed()
    controller.set(state('available', { available: offer() }))
    controller.set(state('checking'))
    await link.sync()
    expect(sent).toEqual([])
    shared = true
    await link.sync()
    expect(sent).toHaveLength(1)
  })

  it('never builds a summary or asks the controller for a look while not shared', async () => {
    const calls: string[] = []
    const link = createRemoteUpdateLink({
      controller: () => { calls.push('controller'); return null }, version: '2.14.1', base: BASE, ownerToken: OWNER_TOKEN,
      fetch: async () => { calls.push('fetch'); return new Response('null', { status: 500 }) },
      shared: () => false, setupRunning: () => { calls.push('setupRunning'); return false }, quitting: () => false,
      deviceLabel: async () => null, notify: () => {}, setInterval: () => 0, clearInterval: () => {},
    })
    await link.sync()
    expect(calls).toEqual([])
  })

  it('reports at once, on the next change or sync, when it turns shared', async () => {
    let shared = false
    const { relay, link, sent } = setup(undefined, { shared: () => shared })
    await link.sync()
    expect(sent).toHaveLength(0)
    expect(relay.summary()).toMatchObject({ reason: 'not_ready' })
    shared = true
    link.changed()
    await link.settled()
    await link.sync()
    expect(relay.summary()).toEqual({ current: '2.14.1', status: 'available', newer: '2.15.0', canStart: true, reason: null })
  })

  it('counts a gate that throws, or no gate at all, as not shared', async () => {
    for (const shared of [() => { throw new Error('no panel') }, undefined]) {
      const fetch = vi.fn(async () => new Response('null', { status: 500 }))
      const link = createRemoteUpdateLink({
        controller: () => null, version: '2.14.1', base: BASE, ownerToken: OWNER_TOKEN, fetch, ...(shared ? { shared } : {}),
        setupRunning: () => false, quitting: () => false, deviceLabel: async () => null, notify: () => {}, setInterval: () => 0, clearInterval: () => {},
      })
      link.start()
      await link.sync()
      expect(fetch).not.toHaveBeenCalled()
    }
  })

  it('still handles a request and a look while shared, and stops handling once not shared again', async () => {
    let shared = true
    const { relay, controller, link, sent } = setup(state('idle'), { shared: () => shared })
    await link.sync()
    relay.get()
    await link.sync()
    expect(controller.calls).toEqual(['checkNow'])
    controller.set(state('available', { available: offer() }))
    await link.sync()
    expect(relay.start(LAPTOP)).toEqual({ ok: true })
    await link.sync()
    await link.settled()
    expect(controller.calls).toEqual(['checkNow', 'downloadNow', 'installNow'])
    const before = sent.length
    shared = false
    await link.sync()
    controller.set(state('available', { available: offer() }))
    expect(sent).toHaveLength(before)
  })
})
