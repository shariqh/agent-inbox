// The hub's page in this app's window (#617, PR 3b; design
// docs/superpowers/specs/2026-11-17-remote-inbox-design.md §3.3): electron/hub-view.cjs shows the
// connected hub's own page in a sealed-off WebContentsView, with its own partition and preload, a
// direct connection, the device header added by main alone, and none of this app's privileges.
//
// Nothing here starts Electron: the window, the view, its webContents and the session are fakes
// that record what was called, in order. The connect controller is a fake for the view's states,
// and the real one (with fake Tailscale, fetch and safeStorage) for the IPC answers. Values are
// synthetic: `hub.example.ts.net`, `owner@example.com`, `laptop`.
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import hubViewModule from '../electron/hub-view.cjs'
import remoteConnect from '../electron/remote-connect.cjs'
import { cliExists, fakeTailscale } from './remote-entry-fixtures.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

const {
  CONNECT_CHANNELS, DESK_CHANNELS, allowNavigation, allowPermission, createHubView, deskConnection, hubMenuItems, mayOpenExternally,
  partitionFor, registerHubIpc, sendHeaders, trustedDeskSender, watchOnline, windowTitle,
} = hubViewModule
const { createRemoteConnect } = remoteConnect

afterEach(() => removeScratchDirs())

const HOST = 'hub.example.ts.net'
const ORIGIN = `https://${HOST}`
const ID = '0123abcd'
const SECRET = 'q7Rk2mVx9LpZt4WcYb8NsDf3HjGu6EaQo1XiKvTn0yM'
const OFFLINE_FILE = join(import.meta.dirname, '..', 'electron', 'remote-offline.html')
const OFFLINE_URL = pathToFileURL(OFFLINE_FILE).href
const PRELOAD = join(import.meta.dirname, '..', 'electron', 'remote-preload.cjs')

/** A deviceHeaderFor with the real decision's shape: the secret only for an https URL on the hub's origin. */
const fakeHeaderFor = (url: unknown) => {
  try {
    const parsed = new URL(String(url))
    return parsed.protocol === 'https:' && parsed.origin === ORIGIN && parsed.username === '' ? SECRET : null
  } catch {
    return null
  }
}

// ── the pure rules ───────────────────────────────────────────────────────────────

describe('partitionFor', () => {
  it('names a persistent partition per hub', () => {
    expect(partitionFor(ID)).toBe('persist:hub-0123abcd')
  })

  it.each(['0123ABCD', '0123abc', '0123abcde', '../hub', 'persist:x', '', 42, null, undefined, {}])('throws for %j', (id) => {
    expect(() => partitionFor(id)).toThrow()
  })
})

describe('sendHeaders: the device header comes only from deviceHeaderFor', () => {
  const PAGE_SET = [['X-Agent-Inbox-Device', 'from-the-page'], ['x-agent-inbox-device', 'lower'], ['X-AGENT-INBOX-DEVICE', 'upper']] as const

  it.each(PAGE_SET)('removes a page-set %s and adds the secret for the hub origin', (name, value) => {
    const headers = sendHeaders({ url: `${ORIGIN}/api/items`, requestHeaders: { Accept: 'application/json', [name]: value } }, fakeHeaderFor)
    expect(headers).toEqual({ Accept: 'application/json', 'X-Agent-Inbox-Device': SECRET })
  })

  it('removes all three spellings at once', () => {
    const requestHeaders = Object.fromEntries(PAGE_SET)
    expect(sendHeaders({ url: `${ORIGIN}/`, requestHeaders }, fakeHeaderFor)).toEqual({ 'X-Agent-Inbox-Device': SECRET })
  })

  it.each([
    ['a sub-resource on the hub', `${ORIGIN}/static/app.js`, SECRET],
    ['a WebSocket to the hub', `wss://${HOST}/live`, null],
    ['a redirect target on another origin', 'https://elsewhere.example.com/landing', null],
    ['a blob: URL', `blob:${ORIGIN}/0f0f-11`, null],
    ['a file: URL', OFFLINE_URL, null],
    ['plain http to the hub', `http://${HOST}/api/items`, null],
  ])('for %s, removes the page-set headers and sends %s', (_label, url, expected) => {
    const headers = sendHeaders({ url, requestHeaders: { 'X-Agent-Inbox-Device': 'page', 'x-agent-inbox-device': 'page2', Cookie: 'c=1' } }, fakeHeaderFor)
    expect(headers).toEqual(expected === null ? { Cookie: 'c=1' } : { Cookie: 'c=1', 'X-Agent-Inbox-Device': expected })
  })

  it('asks deviceHeaderFor with the request URL exactly, and adds nothing it does not answer', () => {
    const asked: unknown[] = []
    const none = (url: unknown) => { asked.push(url); return null }
    expect(sendHeaders({ url: `${ORIGIN}/api/items`, requestHeaders: { 'X-Agent-Inbox-Device': SECRET } }, none)).toEqual({})
    expect(asked).toEqual([`${ORIGIN}/api/items`])
    for (const answer of ['', 42, undefined, { value: SECRET }]) {
      expect(sendHeaders({ url: `${ORIGIN}/`, requestHeaders: {} }, () => answer as never)).toEqual({})
    }
  })

  it('sends no header when deviceHeaderFor throws', () => {
    expect(sendHeaders({ url: `${ORIGIN}/`, requestHeaders: { 'x-agent-inbox-device': 'p' } }, () => { throw new Error('boom') })).toEqual({})
  })

  it('copes with no headers at all', () => {
    expect(sendHeaders({ url: `${ORIGIN}/` }, fakeHeaderFor)).toEqual({ 'X-Agent-Inbox-Device': SECRET })
    expect(sendHeaders(null, fakeHeaderFor)).toEqual({})
  })
})

describe('allowNavigation', () => {
  it.each([`${ORIGIN}/`, `${ORIGIN}`, `${ORIGIN}/?item=x#focus`, `${ORIGIN}:443/api`, 'https://HUB.Example.ts.net/x'])('allows %s', (url) => {
    expect(allowNavigation(url, ORIGIN, OFFLINE_URL)).toBe(true)
  })

  it('allows the offline file at its exact URL', () => {
    expect(allowNavigation(OFFLINE_URL, ORIGIN, OFFLINE_URL)).toBe(true)
  })

  // the forms test/remote-connect.test.ts lists for deviceHeaderFor
  it.each([
    ['http:', `http://${HOST}/api/items`],
    ['another port', `https://${HOST}:8443/api/items`],
    ['port 80', `https://${HOST}:80/`],
    ['a sub-domain', `https://a.${HOST}/`],
    ['the name as a prefix', `https://${HOST}.evil.example/`],
    ['the name as a suffix', `https://evil${HOST}/`],
    ['a look-alike with a dash', 'https://hub-example-ts.ts.net/'],
    ['another peer', 'https://exit-1.example.ts.net/'],
    ['user info', `https://owner@${HOST}/`],
    ['a user and password', `https://owner:pw@${HOST}/`],
    ['an empty user and password', `https://:@${HOST}/`],
    ['user info written with a backslash', `https:\\@${HOST}/`],
    ['a trailing dot', `https://${HOST}./`],
    ['ws:', `wss://${HOST}/`],
    ['a blob URL', `blob:${ORIGIN}/0f0f`],
    ['a data URL', 'data:text/html,hi'],
    ['not a URL', 'hub.example.ts.net/api'],
    ['empty', ''],
    ['javascript:', 'javascript:alert(1)'],
    ['the local viewer', 'http://127.0.0.1:4319/'],
    ['another file', pathToFileURL(join(import.meta.dirname, '..', 'public', 'index.html')).href],
    ['the offline file with a query', `${OFFLINE_URL}?x=1`],
    ['the offline file with a fragment', `${OFFLINE_URL}#x`],
    ['about:blank', 'about:blank'],
  ])('refuses %s', (_label, url) => {
    expect(allowNavigation(url, ORIGIN, OFFLINE_URL)).toBe(false)
  })

  it.each([undefined, null, 42, {}, new URL(`${ORIGIN}/`)])('refuses the non-string %j', (url) => {
    expect(allowNavigation(url, ORIGIN, OFFLINE_URL)).toBe(false)
  })

  it('refuses everything without a hub origin', () => {
    expect(allowNavigation(`${ORIGIN}/`, null, OFFLINE_URL)).toBe(false)
    expect(allowNavigation(OFFLINE_URL, null, OFFLINE_URL)).toBe(true)
    expect(allowNavigation(OFFLINE_URL, ORIGIN, null)).toBe(false)
  })
})

describe('allowPermission', () => {
  it('allows only clipboard-sanitized-write for the hub origin’s top frame', () => {
    expect(allowPermission('clipboard-sanitized-write', `${ORIGIN}/`, ORIGIN, true)).toBe(true)
    expect(allowPermission('clipboard-sanitized-write', ORIGIN, ORIGIN, true)).toBe(true)
  })

  it.each([
    ['a sub-frame', 'clipboard-sanitized-write', `${ORIGIN}/`, true, false],
    ['an unknown frame', 'clipboard-sanitized-write', `${ORIGIN}/`, true, undefined],
    ['another origin', 'clipboard-sanitized-write', 'https://elsewhere.example.com/', true, true],
    ['the offline file', 'clipboard-sanitized-write', OFFLINE_URL, true, true],
    ['no URL', 'clipboard-sanitized-write', undefined, true, true],
    ['clipboard-read', 'clipboard-read', `${ORIGIN}/`, true, true],
    ['notifications', 'notifications', `${ORIGIN}/`, true, true],
    ['media', 'media', `${ORIGIN}/`, true, true],
    ['geolocation', 'geolocation', `${ORIGIN}/`, true, true],
    ['openExternal', 'openExternal', `${ORIGIN}/`, true, true],
    ['fileSystem', 'fileSystem', `${ORIGIN}/`, true, true],
  ])('refuses %s', (_label, permission, url, _hub, mainFrame) => {
    expect(allowPermission(permission, url, ORIGIN, mainFrame)).toBe(false)
  })
})

describe('mayOpenExternally', () => {
  const at = 1_000_000
  it('allows a focused view with input under 5 seconds old', () => {
    expect(mayOpenExternally({ focused: true, lastInputAt: at, now: at })).toBe(true)
    expect(mayOpenExternally({ focused: true, lastInputAt: at, now: at + 4_999 })).toBe(true)
  })

  it.each([
    ['input 5 seconds old', { focused: true, lastInputAt: at, now: at + 5_000 }],
    ['no focus', { focused: false, lastInputAt: at, now: at + 1 }],
    ['focus that is not true', { focused: 1, lastInputAt: at, now: at + 1 }],
    ['no input yet', { focused: true, lastInputAt: null, now: at }],
    ['input from the future', { focused: true, lastInputAt: at + 10, now: at }],
    ['a clock that is not a number', { focused: true, lastInputAt: at, now: Number.NaN }],
  ])('refuses %s', (_label, input) => {
    expect(mayOpenExternally(input)).toBe(false)
  })
})

describe('deskConnection, windowTitle and the menu pair', () => {
  const hub = { mode: 'hub' as const, id: ID, label: 'studio', state: 'online' as const, reason: null, version: '2.12.0' }

  it('gives the hub view the label, state and version only', () => {
    expect(deskConnection(hub)).toEqual({ mode: 'hub', label: 'studio', state: 'online', version: '2.12.0' })
    expect(deskConnection({ ...hub, state: 'refused', reason: 'node_changed', version: null })).toEqual({ mode: 'hub', label: 'studio', state: 'refused', version: null })
    expect(deskConnection({ mode: 'local' })).toBeNull()
    expect(deskConnection({ ...hub, state: 'gone' })).toBeNull()
    expect(deskConnection(null)).toBeNull()
  })

  it('names the hub in the window title only while its view is on top', () => {
    expect(windowTitle(hub, ID)).toBe('Agent Inbox — studio')
    expect(windowTitle(hub, null)).toBe('Agent Inbox')
    expect(windowTitle(hub, 'ffffffff')).toBe('Agent Inbox')
    expect(windowTitle({ mode: 'local' }, ID)).toBe('Agent Inbox')
    expect(windowTitle(null, null)).toBe('Agent Inbox')
  })

  it('offers This Mac and the hub as a radio pair only while a hub exists', () => {
    const show = vi.fn()
    expect(hubMenuItems({ connection: { mode: 'local' }, showing: null, show })).toEqual([])
    expect(hubMenuItems({ connection: null, showing: null, show })).toEqual([])
    const items = hubMenuItems({ connection: hub, showing: ID, show })
    expect(items.map(({ label, type, checked }) => ({ label, type, checked }))).toEqual([
      { label: 'This Mac', type: 'radio', checked: false },
      { label: 'studio', type: 'radio', checked: true },
    ])
    items[0]!.click()
    items[1]!.click()
    expect(show.mock.calls).toEqual([[null], [ID]])
    expect(hubMenuItems({ connection: hub, showing: null, show }).map((item) => item.checked)).toEqual([true, false])
  })
})

describe('watchOnline', () => {
  it('kicks once when the network comes back, read every 10 seconds', () => {
    const ticks: Array<() => void> = []
    let online = true
    const onBack = vi.fn()
    const every = vi.fn((fn: () => void, _ms: number) => { ticks.push(fn); return { unref() {} } })
    watchOnline({ isOnline: () => online, onBack, setInterval: every })
    expect(every.mock.calls[0]![1]).toBe(10_000)
    const tick = () => ticks[0]!()
    tick()
    expect(onBack).not.toHaveBeenCalled()
    online = false
    tick()
    tick()
    expect(onBack).not.toHaveBeenCalled()
    online = true
    tick()
    expect(onBack).toHaveBeenCalledTimes(1)
    tick()
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('treats a read that throws as no change', () => {
    const ticks: Array<() => void> = []
    let state: boolean | 'throw' = false
    const onBack = vi.fn()
    watchOnline({ isOnline: () => { if (state === 'throw') throw new Error('x'); return state }, onBack, setInterval: (fn: () => void) => { ticks.push(fn); return null } })
    state = 'throw'
    ticks[0]!()
    expect(onBack).not.toHaveBeenCalled()
    state = true
    ticks[0]!()
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})

// ── fake Electron ────────────────────────────────────────────────────────────────

type Log = string[]

class FakeContents extends EventEmitter {
  static next = 100
  id = FakeContents.next++
  url = ''
  focused = false
  destroyed = false
  sent: unknown[][] = []
  loads: string[] = []
  reloads = 0
  windowOpen: ((details: { url: string }) => { action: string }) | null = null
  constructor(readonly log: Log) { super() }
  loadURL(url: string) {
    this.log.push(`load ${url}`)
    this.loads.push(url)
    this.url = url
    return Promise.resolve()
  }
  reloadIgnoringCache() { this.reloads += 1; this.log.push('reload') }
  isFocused() { return this.focused }
  focus() { this.log.push(`focus ${this.id}`) }
  close() { this.destroyed = true; this.log.push('close') }
  isDestroyed() { return this.destroyed }
  send(...args: unknown[]) { this.sent.push(args) }
  getURL() { return this.url }
  setWindowOpenHandler(fn: (details: { url: string }) => { action: string }) { this.windowOpen = fn }
}

class FakeSession {
  proxy: unknown = null
  beforeSend: ((details: unknown, callback: (response: unknown) => void) => void) | null = null
  request: ((wc: unknown, permission: string, callback: (ok: boolean) => void, details: unknown) => void) | null = null
  check: ((wc: unknown, permission: string, origin: string, details: unknown) => boolean) | null = null
  device: ((details: unknown) => boolean) | null = null
  downloads: Array<(event: unknown, item: unknown) => void> = []
  cleared = 0
  cacheCleared = 0
  flushed = 0
  constructor(readonly name: string, readonly log: Log) {}
  async setProxy(config: unknown) {
    this.log.push('setProxy')
    await Promise.resolve()
    this.proxy = config
    this.log.push('setProxy done')
  }
  webRequest = {
    onBeforeSendHeaders: (...args: unknown[]) => {
      this.log.push(`onBeforeSendHeaders/${args.length}`)
      this.beforeSend = args[args.length - 1] as never
    },
  }
  setPermissionRequestHandler(fn: never) { this.log.push('permission request'); this.request = fn }
  setPermissionCheckHandler(fn: never) { this.log.push('permission check'); this.check = fn }
  setDevicePermissionHandler(fn: never) { this.log.push('device permission'); this.device = fn }
  on(event: string, fn: never) { this.log.push(`session on ${event}`); if (event === 'will-download') this.downloads.push(fn) }
  async clearStorageData() { this.cleared += 1; this.log.push(`clearStorageData ${this.name}`) }
  async clearCache() { this.cacheCleared += 1 }
  flushStorageData() { this.flushed += 1 }
}

function fakeElectron() {
  const log: Log = []
  const sessions = new Map<string, FakeSession>()
  const session = {
    fromPartition(name: string) {
      let s = sessions.get(name)
      if (!s) { s = new FakeSession(name, log); sessions.set(name, s) }
      return s
    },
  }
  const views: FakeView[] = []
  class FakeView {
    webContents: FakeContents
    bounds: unknown = null
    visible = true
    constructor(readonly options: { webPreferences: Record<string, unknown> }) {
      log.push('view created')
      this.webContents = new FakeContents(log)
      views.push(this)
    }
    setBounds(bounds: unknown) { this.bounds = bounds }
    setVisible(visible: boolean) { this.visible = visible; log.push(`visible ${visible}`) }
  }
  const local = new FakeContents(log)
  const window = Object.assign(new EventEmitter(), {
    webContents: local,
    size: [1200, 800] as [number, number],
    children: [] as unknown[],
    contentView: {
      addChildView: (view: unknown) => { window.children.push(view); log.push('add view') },
      removeChildView: (view: unknown) => { window.children = window.children.filter((v) => v !== view); log.push('remove view') },
    },
    getContentSize: () => window.size,
    isDestroyed: () => false,
  })
  return { log, session, sessions, views, WebContentsView: FakeView, window, local }
}

type Conn = { mode: 'local' } | { mode: 'hub'; id: string; label: string; state: 'online' | 'retrying' | 'refused'; reason: string | null; version: string | null }

function fakeConnect(origin = ORIGIN) {
  let current: Conn = { mode: 'local' }
  const listeners = new Set<(c: Conn) => void>()
  const kicks: number[] = []
  return {
    connection: () => ({ ...current }),
    onConnection(callback: (c: Conn) => void) { listeners.add(callback); return () => listeners.delete(callback) },
    view: async () => ({
      available: true, keychain: true, problem: null,
      hub: current.mode === 'hub' ? { id: current.id, label: current.label, origin, machine: 'studio', state: current.state, reason: current.reason } : null,
    }),
    deviceHeaderFor: fakeHeaderFor,
    kick: vi.fn(async () => { kicks.push(1); return { ok: true } }),
    set(next: Conn) {
      current = next
      for (const listener of [...listeners]) listener({ ...next })
    },
  }
}

const settle = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

const hubState = (state: 'online' | 'retrying' | 'refused', reason: string | null = null, extra: Partial<Conn> = {}): Conn =>
  ({ mode: 'hub', id: ID, label: 'studio', state, reason, version: '2.12.0', ...extra }) as Conn

function world(options: { now?: () => number; origin?: string } = {}) {
  const electron = fakeElectron()
  const connect = fakeConnect(options.origin)
  const opened: string[] = []
  const changes = vi.fn()
  const clock = { t: 5_000_000 }
  const hub = createHubView({
    window: electron.window,
    session: electron.session,
    WebContentsView: electron.WebContentsView,
    connect: connect as never,
    openWebLink: (url: string) => { opened.push(url) },
    offlineFile: OFFLINE_FILE,
    preload: PRELOAD,
    now: options.now ?? (() => clock.t),
    onChange: changes,
  })
  const view = () => electron.views.at(-1)!
  const contents = () => view().webContents
  const ses = () => electron.sessions.get(`persist:hub-${ID}`)!
  return { ...electron, connect, hub, opened, changes, clock, view, contents, ses }
}

/** An Electron navigation event: the details object with preventDefault. */
const navEvent = (url: string, isMainFrame = true) => {
  const event = { url, isMainFrame, defaultPrevented: false, preventDefault() { event.defaultPrevented = true } }
  return event
}

describe('createHubView: the view and its session', () => {
  it('sets the session up before anything loads: direct proxy, header handler, permissions, downloads', async () => {
    const w = world()
    w.connect.set(hubState('online'))
    await settle()
    const log = w.log
    const firstLoad = log.findIndex((line) => line.startsWith('load '))
    expect(firstLoad).toBeGreaterThan(-1)
    for (const step of ['setProxy done', 'onBeforeSendHeaders/1', 'permission request', 'permission check', 'device permission', 'session on will-download']) {
      const at = log.indexOf(step)
      expect(at, step).toBeGreaterThan(-1)
      expect(at, step).toBeLessThan(firstLoad)
    }
    expect(log.indexOf('setProxy done')).toBeLessThan(log.indexOf('view created'))
    expect(w.ses().proxy).toEqual({ mode: 'direct' })
    expect(w.contents().loads).toEqual([`${ORIGIN}/`])
  })

  it('creates the view with exactly the sealed-off preferences and its own partition', async () => {
    const w = world()
    w.connect.set(hubState('online'))
    await settle()
    expect(w.views).toHaveLength(1)
    expect(w.view().options).toEqual({
      webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, partition: 'persist:hub-0123abcd' },
    })
  })

  it('adds the device header to every request through the partition’s handler, and only where deviceHeaderFor says', async () => {
    const w = world()
    w.connect.set(hubState('online'))
    await settle()
    const send = (url: string, requestHeaders: Record<string, string>) => {
      let answer: unknown
      w.ses().beforeSend!({ url, requestHeaders, resourceType: 'xhr' }, (response) => { answer = response })
      return answer
    }
    expect(send(`${ORIGIN}/api/items`, { 'X-Agent-Inbox-Device': 'page' })).toEqual({ requestHeaders: { 'X-Agent-Inbox-Device': SECRET } })
    expect(send('https://elsewhere.example.com/', { 'x-agent-inbox-device': 'page', A: '1' })).toEqual({ requestHeaders: { A: '1' } })
  })

  it('cancels every download', async () => {
    const w = world()
    w.connect.set(hubState('online'))
    await settle()
    const item = { cancel: vi.fn() }
    const event = { preventDefault: vi.fn() }
    expect(w.ses().downloads).toHaveLength(1)
    w.ses().downloads[0]!(event, item)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(item.cancel).toHaveBeenCalled()
  })

  it('answers permissions through allowPermission, the top frame on the hub origin and clipboard writes only', async () => {
    const w = world()
    w.connect.set(hubState('online'))
    await settle()
    const ask = (permission: string, details: unknown) => new Promise((resolve) => w.ses().request!(w.contents(), permission, resolve, details))
    expect(await ask('clipboard-sanitized-write', { requestingUrl: `${ORIGIN}/`, isMainFrame: true })).toBe(true)
    expect(await ask('clipboard-sanitized-write', { requestingUrl: `${ORIGIN}/`, isMainFrame: false })).toBe(false)
    expect(await ask('notifications', { requestingUrl: `${ORIGIN}/`, isMainFrame: true })).toBe(false)
    expect(await ask('clipboard-sanitized-write', { requestingUrl: 'https://elsewhere.example.com/', isMainFrame: true })).toBe(false)
    expect(w.ses().check!(w.contents(), 'clipboard-sanitized-write', ORIGIN, { isMainFrame: true })).toBe(true)
    expect(w.ses().check!(w.contents(), 'clipboard-sanitized-write', ORIGIN, { requestingUrl: `${ORIGIN}/x`, isMainFrame: true })).toBe(true)
    expect(w.ses().check!(w.contents(), 'clipboard-sanitized-write', ORIGIN, { isMainFrame: false })).toBe(false)
    expect(w.ses().check!(w.contents(), 'clipboard-read', ORIGIN, { isMainFrame: true })).toBe(false)
    expect(w.ses().device!({ deviceType: 'hid' })).toBe(false)
  })

  it('fills the window’s content area and follows resizes', async () => {
    const w = world()
    w.connect.set(hubState('online'))
    await settle()
    expect(w.window.children).toEqual([w.view()])
    expect(w.view().bounds).toEqual({ x: 0, y: 0, width: 1200, height: 800 })
    w.window.size = [900, 600]
    w.window.emit('resize')
    expect(w.view().bounds).toEqual({ x: 0, y: 0, width: 900, height: 600 })
  })

  it('never unloads the local page: it is never navigated, closed or removed', async () => {
    const w = world()
    w.connect.set(hubState('online'))
    await settle()
    w.hub.show(ID)
    w.connect.set({ mode: 'local' })
    await settle()
    expect(w.local.loads).toEqual([])
    expect(w.local.destroyed).toBe(false)
  })
})

describe('createHubView: what the view shows', () => {
  it('online, then retrying, then online keeps the hub page loaded: one load', async () => {
    const w = world()
    w.connect.set(hubState('online'))
    await settle()
    w.connect.set(hubState('retrying', 'unreachable'))
    await settle()
    w.connect.set(hubState('online'))
    await settle()
    expect(w.contents().loads).toEqual([`${ORIGIN}/`])
  })

  it('started while unreachable shows nothing while connecting, then the offline file, then the hub once it is online', async () => {
    const w = world()
    w.connect.set(hubState('retrying', 'connecting'))
    await settle()
    expect(w.contents().loads).toEqual([])
    w.connect.set(hubState('retrying', 'unreachable'))
    await settle()
    expect(w.contents().loads).toEqual([OFFLINE_URL])
    w.connect.set(hubState('retrying', 'not_running'))
    await settle()
    expect(w.contents().loads).toEqual([OFFLINE_URL])
    w.connect.set(hubState('online'))
    await settle()
    expect(w.contents().loads).toEqual([OFFLINE_URL, `${ORIGIN}/`])
  })

  it('refused shows the offline file, even over a loaded hub page, and online loads the hub again', async () => {
    const w = world()
    w.connect.set(hubState('online'))
    await settle()
    w.connect.set(hubState('refused', 'refused'))
    await settle()
    expect(w.contents().loads).toEqual([`${ORIGIN}/`, OFFLINE_URL])
    w.connect.set(hubState('refused', 'node_changed'))
    await settle()
    expect(w.contents().loads).toEqual([`${ORIGIN}/`, OFFLINE_URL])
    w.connect.set(hubState('online'))
    await settle()
    expect(w.contents().loads).toEqual([`${ORIGIN}/`, OFFLINE_URL, `${ORIGIN}/`])
  })

  it('reload() reloads a loaded hub page and nothing else', async () => {
    const w = world()
    w.hub.reload()
    w.connect.set(hubState('retrying', 'unreachable'))
    await settle()
    w.hub.reload()
    expect(w.contents().reloads).toBe(0)
    w.connect.set(hubState('online'))
    await settle()
    w.hub.reload()
    expect(w.contents().reloads).toBe(1)
  })

  it('a hub page that fails to load is replaced by the offline file; an aborted load is not', async () => {
    const w = world()
    w.connect.set(hubState('online'))
    await settle()
    w.contents().emit('did-fail-load', {}, -3, 'ERR_ABORTED', `${ORIGIN}/`, true)
    w.contents().emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', `${ORIGIN}/x.png`, false)
    expect(w.contents().loads).toEqual([`${ORIGIN}/`])
    w.contents().emit('did-fail-load', {}, -202, 'ERR_CERT_AUTHORITY_INVALID', `${ORIGIN}/`, true)
    expect(w.contents().loads).toEqual([`${ORIGIN}/`, OFFLINE_URL])
  })

  it('an offline file that fails to load is not loaded again, so nothing loops', async () => {
    const w = world()
    w.connect.set(hubState('refused', 'refused'))
    await settle()
    w.contents().emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', OFFLINE_URL, true)
    w.contents().emit('render-process-gone', {}, { reason: 'crashed' })
    expect(w.contents().loads).toEqual([OFFLINE_URL])
  })

  it('a renderer that goes away is replaced by the offline file', async () => {
    const w = world()
    w.connect.set(hubState('online'))
    await settle()
    w.contents().emit('render-process-gone', {}, { reason: 'crashed' })
    expect(w.contents().loads).toEqual([`${ORIGIN}/`, OFFLINE_URL])
  })

  it('tells the page on every change, with nothing in the message', async () => {
    const w = world()
    w.connect.set(hubState('online'))
    await settle()
    w.connect.set(hubState('retrying', 'unreachable'))
    await settle()
    expect(w.contents().sent.length).toBeGreaterThanOrEqual(1)
    for (const message of w.contents().sent) expect(message).toEqual([DESK_CHANNELS.changed])
  })

  it('forget destroys the view, clears its partition and shows This Mac', async () => {
    const w = world()
    w.connect.set(hubState('online'))
    await settle()
    expect(w.hub.show(ID)).toEqual({ ok: true, showing: ID })
    const contents = w.contents()
    w.connect.set({ mode: 'local' })
    await settle()
    expect(w.window.children).toEqual([])
    expect(contents.destroyed).toBe(true)
    expect(w.ses().cleared).toBe(1)
    expect(w.ses().cacheCleared).toBe(1)
    expect(w.log.indexOf('close')).toBeLessThan(w.log.indexOf(`clearStorageData persist:hub-${ID}`))
    expect(w.hub.current()).toBeNull()
    expect(w.log.at(-1) === `focus ${w.local.id}` || w.log.includes(`focus ${w.local.id}`)).toBe(true)
    expect(w.changes).toHaveBeenCalled()
  })

  it('a new active hub replaces the old one, whose partition is cleared', async () => {
    const w = world()
    w.connect.set(hubState('online'))
    await settle()
    const first = w.contents()
    w.connect.set(hubState('online', null, { id: 'ffff0000' }))
    await settle()
    expect(first.destroyed).toBe(true)
    expect(w.ses().cleared).toBe(1)
    expect(w.views).toHaveLength(2)
    expect(w.view().options.webPreferences.partition).toBe('persist:hub-ffff0000')
  })

  it('makes no view for a hub whose stored origin is not a canonical hub origin', async () => {
    const w = world({ origin: 'http://hub.example.ts.net' })
    w.connect.set(hubState('online'))
    await settle()
    expect(w.views).toHaveLength(0)
  })

  it('retry() checks the node and probes now, and loads the hub page when it is online', async () => {
    const w = world()
    w.connect.set(hubState('retrying', 'unreachable'))
    await settle()
    expect(await w.hub.retry()).toEqual({ ok: true })
    expect(w.connect.kick).toHaveBeenCalledTimes(1)
    expect(w.contents().loads).toEqual([OFFLINE_URL])
    // a probe that comes back online while the state already said online publishes nothing new
    w.contents().emit('did-fail-load', {}, -105, 'x', `${ORIGIN}/`, true)
    w.connect.set(hubState('online'))
    await settle()
    w.contents().emit('did-fail-load', {}, -105, 'x', `${ORIGIN}/`, true)
    expect(w.contents().loads.at(-1)).toBe(OFFLINE_URL)
    await w.hub.retry()
    expect(w.contents().loads.at(-1)).toBe(`${ORIGIN}/`)
  })
})

describe('createHubView: which view is on top', () => {
  it('keeps This Mac on top until asked, and switches with show()', async () => {
    const w = world()
    w.connect.set(hubState('online'))
    await settle()
    expect(w.hub.current()).toBeNull()
    expect(w.view().visible).toBe(false)
    expect(w.hub.show(ID)).toEqual({ ok: true, showing: ID })
    expect(w.view().visible).toBe(true)
    expect(w.hub.current()).toBe(ID)
    expect(w.log.at(-1)).toBe(`focus ${w.contents().id}`)
    expect(w.hub.show(null)).toEqual({ ok: true, showing: null })
    expect(w.view().visible).toBe(false)
    expect(w.log.at(-1)).toBe(`focus ${w.local.id}`)
  })

  it('refuses an id that is not the active hub', async () => {
    const w = world()
    expect(w.hub.show(ID)).toEqual({ ok: false, reason: 'not_found' })
    w.connect.set(hubState('online'))
    await settle()
    expect(w.hub.show('ffff0000')).toEqual({ ok: false, reason: 'not_found' })
    expect(w.hub.show('nope')).toEqual({ ok: false, reason: 'bad_id' })
    expect(w.hub.show(42)).toEqual({ ok: false, reason: 'bad_id' })
    expect(w.hub.current()).toBeNull()
  })

  it('shows the hub chosen before its view was made once it exists', async () => {
    const w = world()
    w.connect.set(hubState('retrying', 'connecting'))
    expect(w.hub.show(ID)).toEqual({ ok: true, showing: ID })
    await settle()
    expect(w.view().visible).toBe(true)
  })

  it('closes itself when its window closes, keeping the partition’s storage', async () => {
    const w = world()
    w.connect.set(hubState('online'))
    await settle()
    w.window.emit('closed')
    expect(w.contents().destroyed).toBe(true)
    expect(w.ses().cleared).toBe(0)
    // the window closes before will-quit, so the hub page's drafts are written here
    expect(w.ses().flushed).toBe(1)
    expect(w.hub.show(ID)).toEqual({ ok: false, reason: 'destroyed' })
  })

  it('destroy() closes the view and keeps the partition’s storage', async () => {
    const w = world()
    w.connect.set(hubState('online'))
    await settle()
    w.hub.destroy()
    expect(w.contents().destroyed).toBe(true)
    expect(w.ses().cleared).toBe(0)
    expect(w.hub.show(ID)).toEqual({ ok: false, reason: 'destroyed' })
    w.connect.set(hubState('refused', 'refused'))
    await settle()
    expect(w.views).toHaveLength(1)
  })
})

describe('createHubView: navigation and links', () => {
  async function shown() {
    const w = world()
    w.connect.set(hubState('online'))
    await settle()
    w.hub.show(ID)
    return w
  }

  it('lets the page navigate on the hub origin and to the offline file', async () => {
    const w = await shown()
    for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
      for (const url of [`${ORIGIN}/?x`, OFFLINE_URL]) {
        const event = navEvent(url)
        w.contents().emit(name, event, url)
        expect(event.defaultPrevented, `${name} ${url}`).toBe(false)
      }
    }
  })

  it.each(['will-navigate', 'will-frame-navigate', 'will-redirect'])('%s off the origin is prevented, and opens nothing without a fresh input', async (name) => {
    const w = await shown()
    const event = navEvent('https://elsewhere.example.com/')
    w.contents().emit(name, event, event.url)
    expect(event.defaultPrevented).toBe(true)
    expect(w.opened).toEqual([])
  })

  it('a prevented top-level http(s) navigation opens externally only with focus and input under 5 seconds old, once per input', async () => {
    const w = await shown()
    w.contents().focused = true
    w.contents().emit('before-input-event', {}, { type: 'keyDown' })
    w.clock.t += 4_000
    const first = navEvent('https://elsewhere.example.com/a')
    w.contents().emit('will-navigate', first, first.url)
    expect(first.defaultPrevented).toBe(true)
    expect(w.opened).toEqual(['https://elsewhere.example.com/a'])
    // the input was used up
    const second = navEvent('https://elsewhere.example.com/b')
    w.contents().emit('will-navigate', second, second.url)
    expect(w.opened).toEqual(['https://elsewhere.example.com/a'])
  })

  it('counts a mouse press as input, but not a mouse move', async () => {
    const w = await shown()
    w.contents().focused = true
    w.contents().emit('input-event', {}, { type: 'mouseMove' })
    const moved = navEvent('https://elsewhere.example.com/m')
    w.contents().emit('will-navigate', moved, moved.url)
    expect(w.opened).toEqual([])
    w.contents().emit('input-event', {}, { type: 'mouseDown' })
    const clicked = navEvent('https://elsewhere.example.com/c')
    w.contents().emit('will-navigate', clicked, clicked.url)
    expect(w.opened).toEqual(['https://elsewhere.example.com/c'])
  })

  it('opens nothing for stale input, without focus, for a sub-frame, or for a scheme that is not http(s)', async () => {
    const w = await shown()
    w.contents().emit('before-input-event', {}, { type: 'keyDown' })
    w.contents().focused = false
    const unfocused = navEvent('https://elsewhere.example.com/u')
    w.contents().emit('will-navigate', unfocused, unfocused.url)
    w.contents().focused = true
    w.clock.t += 5_000
    const stale = navEvent('https://elsewhere.example.com/s')
    w.contents().emit('will-navigate', stale, stale.url)
    w.contents().emit('before-input-event', {}, { type: 'keyDown' })
    const frame = navEvent('https://elsewhere.example.com/f', false)
    w.contents().emit('will-frame-navigate', frame)
    for (const url of ['file:///etc/passwd', 'mailto:owner@example.com', 'javascript:alert(1)', 'x-apple-script:run']) {
      const event = navEvent(url)
      w.contents().emit('will-navigate', event, url)
      expect(event.defaultPrevented).toBe(true)
    }
    expect(w.opened).toEqual([])
  })

  it('denies every new window, and opens an http(s) one externally under the same rule', async () => {
    const w = await shown()
    const open = w.contents().windowOpen!
    expect(open({ url: 'https://elsewhere.example.com/w' })).toEqual({ action: 'deny' })
    expect(w.opened).toEqual([])
    w.contents().focused = true
    w.contents().emit('before-input-event', {}, { type: 'keyDown' })
    expect(open({ url: `${ORIGIN}/elsewhere` })).toEqual({ action: 'deny' })
    expect(w.opened).toEqual([`${ORIGIN}/elsewhere`])
    w.contents().emit('before-input-event', {}, { type: 'keyDown' })
    expect(open({ url: 'file:///Applications/Calculator.app' })).toEqual({ action: 'deny' })
    expect(w.opened).toEqual([`${ORIGIN}/elsewhere`])
  })

  it('registers no certificate-error handler', async () => {
    const w = await shown()
    expect(w.contents().listenerCount('certificate-error')).toBe(0)
  })
})

describe('trustedDeskSender', () => {
  async function shown() {
    const w = world()
    w.connect.set(hubState('online'))
    await settle()
    return w
  }
  const frame = (url: string, parent: unknown = null) => ({ url, parent })

  it('accepts the hub view’s top frame on the hub origin, and on the offline file', async () => {
    const w = await shown()
    expect(trustedDeskSender({ sender: w.contents(), senderFrame: frame(`${ORIGIN}/#x`) }, w.view(), ORIGIN, OFFLINE_URL)).toBe('hub')
    expect(trustedDeskSender({ sender: w.contents(), senderFrame: frame(OFFLINE_URL) }, w.view(), ORIGIN, OFFLINE_URL)).toBe('offline')
    expect(w.hub.trusts({ sender: w.contents(), senderFrame: frame(`${ORIGIN}/`) })).toBe('hub')
  })

  it('refuses a sub-frame, even on the hub origin', async () => {
    const w = await shown()
    expect(trustedDeskSender({ sender: w.contents(), senderFrame: frame(`${ORIGIN}/`, { url: `${ORIGIN}/` }) }, w.view(), ORIGIN, OFFLINE_URL)).toBeNull()
    expect(trustedDeskSender({ sender: w.contents(), senderFrame: { url: `${ORIGIN}/` } }, w.view(), ORIGIN, OFFLINE_URL)).toBeNull()
  })

  it('refuses the view once it shows anything else', async () => {
    const w = await shown()
    for (const url of ['https://elsewhere.example.com/', 'http://127.0.0.1:4319/', `${OFFLINE_URL}?x`, 'about:blank', 'chrome-error://chromewebdata/']) {
      expect(trustedDeskSender({ sender: w.contents(), senderFrame: frame(url) }, w.view(), ORIGIN, OFFLINE_URL), url).toBeNull()
    }
  })

  it('refuses the local window’s webContents, whatever its frame says', async () => {
    const w = await shown()
    expect(trustedDeskSender({ sender: w.local, senderFrame: frame(`${ORIGIN}/`) }, w.view(), ORIGIN, OFFLINE_URL)).toBeNull()
    expect(w.hub.trusts({ sender: w.local, senderFrame: frame(`${ORIGIN}/`) })).toBeNull()
  })

  it('refuses a destroyed view, no view, no frame and no event', async () => {
    const w = await shown()
    expect(trustedDeskSender({ sender: w.contents(), senderFrame: null }, w.view(), ORIGIN, OFFLINE_URL)).toBeNull()
    expect(trustedDeskSender(null, w.view(), ORIGIN, OFFLINE_URL)).toBeNull()
    expect(trustedDeskSender({ sender: w.contents(), senderFrame: frame(`${ORIGIN}/`) }, null, ORIGIN, OFFLINE_URL)).toBeNull()
    w.contents().destroyed = true
    expect(trustedDeskSender({ sender: w.contents(), senderFrame: frame(`${ORIGIN}/`) }, w.view(), ORIGIN, OFFLINE_URL)).toBeNull()
  })
})

// ── the IPC ─────────────────────────────────────────────────────────────────────

const PEERS = JSON.stringify({
  Version: '1.102.4-synthetic', BackendState: 'Running', MagicDNSSuffix: 'example.ts.net',
  Self: { ID: 'nLaptopCNTRL', HostName: 'laptop', DNSName: 'laptop.example.ts.net.', UserID: 7004356810051234 },
  Peer: { 'nodekey:hub': { ID: 'nHubStable1CNTRL', HostName: 'hub', DNSName: `${HOST}.`, UserID: 7004356810051234 } },
  User: { 7004356810051234: { ID: 7004356810051234, LoginName: 'owner@example.com' } },
})
const DEVICE = '3f9c0a1b2d4e5f60'

function fakeSafeStorage() {
  const flip = (bytes: Uint8Array) => Buffer.from(bytes.map((b) => b ^ 0x5a))
  return {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.concat([Buffer.from('v10'), flip(Buffer.from(text, 'utf8'))]),
    decryptString: (blob: Buffer) => flip(blob.subarray(3)).toString('utf8'),
  }
}

const marked = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'x-agent-inbox-remote-boundary': 'tailnet-v1' } })

/** The real controller, connected to a hub through fake Tailscale, fetch and safeStorage. */
function realConnect() {
  const dir = scratchDir('hv-')
  return createRemoteConnect({
    filePath: join(dir, 'remote-connect.json'),
    execFile: fakeTailscale({ peers: { raw: PEERS } }),
    exists: cliExists,
    fetch: async (input: unknown) => {
      const url = String(input)
      if (url === `${ORIGIN}/api/remote/pair`) return marked({ ok: true, device: DEVICE, secret: SECRET })
      if (url === `${ORIGIN}/api/version`) return marked({ current: '2.12.0', machine: 'studio' })
      return new Response('no', { status: 404 })
    },
    safeStorage: fakeSafeStorage(),
    platform: 'darwin',
    hostname: () => 'laptop.local',
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
  })
}

function ipcWorld(options: { connect?: ReturnType<typeof createRemoteConnect> | null; owned?: boolean; hubView?: unknown } = {}) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const owner = { id: 7 }
  const hubContents = { id: 8, isDestroyed: () => false }
  const settled = vi.fn(async () => {})
  const isOwned = vi.fn((event: { sender: unknown }) => (options.owned ?? true) && event.sender === owner)
  const shows: unknown[] = []
  const retries: unknown[] = []
  const hubView = options.hubView === undefined
    ? {
        trusts: (event: unknown) => trustedDeskSender(event, { webContents: hubContents }, ORIGIN, OFFLINE_URL),
        show: (id: unknown) => { shows.push(id); return { ok: true, showing: id } },
        current: () => null,
        retry: async () => { retries.push(1); return { ok: true } },
      }
    : options.hubView
  const connect = options.connect === undefined ? realConnect() : options.connect
  registerHubIpc({
    ipcMain: { handle: (channel: string, fn: never) => { if (handlers.has(channel)) throw new Error(`twice: ${channel}`); handlers.set(channel, fn) } },
    settled,
    isOwned: isOwned as never,
    connect: () => connect,
    hubView: () => hubView as never,
  })
  const local = { sender: owner, senderFrame: { url: 'http://127.0.0.1:4319/', parent: null } }
  const hubEvent = { sender: hubContents, senderFrame: { url: `${ORIGIN}/`, parent: null } }
  const offlineEvent = { sender: hubContents, senderFrame: { url: OFFLINE_URL, parent: null } }
  const call = (channel: string, event: unknown, ...args: unknown[]) => handlers.get(channel)!(event, ...args)
  return { handlers, call, local, hubEvent, offlineEvent, owner, hubContents, settled, isOwned, shows, retries, connect }
}

const UNAVAILABLE = { available: false }

describe('registerHubIpc', () => {
  it('registers exactly the desk and connect channels', () => {
    const w = ipcWorld()
    expect([...w.handlers.keys()].sort()).toEqual([
      CONNECT_CHANNELS.connect, CONNECT_CHANNELS.forget, CONNECT_CHANNELS.show, CONNECT_CHANNELS.view, DESK_CHANNELS.connection, DESK_CHANNELS.retry,
    ].sort())
  })

  it('agentInboxConnect answers the owned viewer only, after the re-proof has settled', async () => {
    const w = ipcWorld()
    const view = await w.call(CONNECT_CHANNELS.view, w.local) as Record<string, unknown>
    expect(view).toMatchObject({ available: true, keychain: true, hub: null, problem: null, showing: null })
    expect(w.settled).toHaveBeenCalled()
    for (const event of [w.hubEvent, w.offlineEvent, { sender: { id: 99 }, senderFrame: { url: 'http://127.0.0.1:4319/', parent: null } }]) {
      expect(await w.call(CONNECT_CHANNELS.view, event)).toEqual(UNAVAILABLE)
      expect(await w.call(CONNECT_CHANNELS.connect, event, { address: HOST, code: '7K3QX-9M2PD' })).toEqual(UNAVAILABLE)
      expect(await w.call(CONNECT_CHANNELS.forget, event, ID)).toEqual(UNAVAILABLE)
      expect(await w.call(CONNECT_CHANNELS.show, event, null)).toEqual(UNAVAILABLE)
    }
    expect(w.shows).toEqual([])
    const unowned = ipcWorld({ owned: false })
    expect(await unowned.call(CONNECT_CHANNELS.view, unowned.local)).toEqual(UNAVAILABLE)
    expect(await unowned.call(CONNECT_CHANNELS.show, unowned.local, null)).toEqual(UNAVAILABLE)
  })

  it('checks the argument count and each argument’s type again in main', async () => {
    const w = ipcWorld({ connect: null })
    const real = ipcWorld()
    const bad: Array<[string, unknown[]]> = [
      [CONNECT_CHANNELS.view, ['extra']],
      [CONNECT_CHANNELS.connect, []],
      [CONNECT_CHANNELS.connect, ['hub.example.ts.net']],
      [CONNECT_CHANNELS.connect, [{ address: HOST, code: '7K3QX-9M2PD' }, 'extra']],
      [CONNECT_CHANNELS.connect, [{ address: HOST, code: 7 }]],
      [CONNECT_CHANNELS.connect, [{ address: 7, code: '7K3QX-9M2PD' }]],
      [CONNECT_CHANNELS.connect, [{ address: HOST, code: '7K3QX-9M2PD', replace: 'yes' }]],
      [CONNECT_CHANNELS.connect, [{ address: HOST, code: '7K3QX-9M2PD', extra: 1 }]],
      [CONNECT_CHANNELS.connect, [[HOST, '7K3QX-9M2PD']]],
      [CONNECT_CHANNELS.connect, [{ address: 'x'.repeat(301), code: '7K3QX-9M2PD' }]],
      [CONNECT_CHANNELS.forget, []],
      [CONNECT_CHANNELS.forget, [42]],
      [CONNECT_CHANNELS.forget, [ID, 'extra']],
      [CONNECT_CHANNELS.show, []],
      [CONNECT_CHANNELS.show, [42]],
      [CONNECT_CHANNELS.show, [undefined]],
      [CONNECT_CHANNELS.show, [ID, 'extra']],
    ]
    for (const [channel, args] of bad) {
      expect(await real.call(channel, real.local, ...args), `${channel} ${JSON.stringify(args)}`).toEqual(UNAVAILABLE)
    }
    expect(real.shows).toEqual([])
    // off macOS there is no controller: every channel answers unavailable
    expect(await w.call(CONNECT_CHANNELS.view, w.local)).toEqual(UNAVAILABLE)
    expect(await w.call(CONNECT_CHANNELS.connect, w.local, { address: HOST, code: '7K3QX-9M2PD' })).toEqual(UNAVAILABLE)
    expect(await w.call(DESK_CHANNELS.connection, w.hubEvent)).toEqual(UNAVAILABLE)
  })

  it('show() reaches the hub view only for the owned viewer, with null or an id', async () => {
    const w = ipcWorld()
    expect(await w.call(CONNECT_CHANNELS.show, w.local, null)).toEqual({ ok: true, showing: null })
    expect(await w.call(CONNECT_CHANNELS.show, w.local, ID)).toEqual({ ok: true, showing: ID })
    expect(w.shows).toEqual([null, ID])
    const none = ipcWorld({ hubView: null })
    expect(await none.call(CONNECT_CHANNELS.show, none.local, null)).toEqual(UNAVAILABLE)
  })

  it('agentInboxDesk answers the hub view’s top frame only, and retry only from the offline file', async () => {
    const w = ipcWorld()
    const result = await w.connect!.connect({ address: HOST, code: '7K3QX-9M2PD' })
    expect(result).toMatchObject({ ok: true, state: 'online' })
    expect(await w.call(DESK_CHANNELS.connection, w.hubEvent)).toEqual({ mode: 'hub', label: 'studio', state: 'online', version: '2.12.0' })
    expect(await w.call(DESK_CHANNELS.connection, w.offlineEvent)).toEqual({ mode: 'hub', label: 'studio', state: 'online', version: '2.12.0' })
    expect(await w.call(DESK_CHANNELS.connection, w.local)).toEqual(UNAVAILABLE)
    expect(await w.call(DESK_CHANNELS.connection, { sender: w.hubContents, senderFrame: { url: `${ORIGIN}/`, parent: {} } })).toEqual(UNAVAILABLE)
    expect(await w.call(DESK_CHANNELS.connection, w.hubEvent, 'extra')).toEqual(UNAVAILABLE)
    expect(await w.call(DESK_CHANNELS.retry, w.hubEvent)).toEqual({ ok: false })
    expect(await w.call(DESK_CHANNELS.retry, w.local)).toEqual({ ok: false })
    expect(await w.call(DESK_CHANNELS.retry, w.offlineEvent, 'extra')).toEqual({ ok: false })
    expect(w.retries).toEqual([])
    expect(await w.call(DESK_CHANNELS.retry, w.offlineEvent)).toEqual({ ok: true })
    expect(w.retries).toEqual([1])
  })

  it('no answer on any channel holds the secret, the encrypted blob, the device id or the node id', async () => {
    const w = ipcWorld()
    const connected = await w.call(CONNECT_CHANNELS.connect, w.local, { address: HOST, code: '7K3QX-9M2PD' }) as { id: string }
    expect(connected).toMatchObject({ ok: true, label: 'studio', state: 'online' })
    const { readFileSync } = await import('node:fs')
    const stored = JSON.parse(readFileSync(w.connect!.file, 'utf8')) as { hubs: Record<string, { secret: string; node: string; device: string }> }
    const entry = Object.values(stored.hubs)[0]!
    const answers: unknown[] = [connected]
    answers.push(await w.call(CONNECT_CHANNELS.view, w.local))
    answers.push(await w.call(CONNECT_CHANNELS.show, w.local, connected.id))
    answers.push(await w.call(CONNECT_CHANNELS.show, w.local, null))
    answers.push(await w.call(DESK_CHANNELS.connection, w.hubEvent))
    answers.push(await w.call(DESK_CHANNELS.connection, w.offlineEvent))
    answers.push(await w.call(DESK_CHANNELS.retry, w.offlineEvent))
    answers.push(await w.call(CONNECT_CHANNELS.connect, w.local, { address: HOST, code: '7K3QX-9M2PD' }))
    answers.push(await w.call(CONNECT_CHANNELS.forget, w.local, connected.id))
    answers.push(await w.call(CONNECT_CHANNELS.view, w.local))
    const text = JSON.stringify(answers)
    for (const value of [SECRET, entry.secret, entry.device, entry.node, DEVICE, 'nHubStable1CNTRL', Buffer.from(SECRET).toString('base64')]) {
      expect(text.includes(value), value).toBe(false)
    }
  })
})
