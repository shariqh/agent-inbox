'use strict'
// The hub view (#617, PR 3b): another Mac's Inbox, shown in this app's window. The connected hub's
// own page is loaded from the hub into a sealed-off WebContentsView laid over the local page, which
// keeps running underneath and is never unloaded.
//
// Design: docs/superpowers/specs/2026-11-17-remote-inbox-design.md §3.3; architecture notes in
// docs/architecture/remote-inbox.md ("The hub view").
//
// The page in that view comes from another machine, so it gets none of this app's privileges: its
// own partition (storage, cache, headers, permission handlers), its own preload
// (remote-preload.cjs, one object, `agentInboxDesk`), a sandbox, a direct connection, no
// downloads, dialogs or client certificates, one permission (clipboard writes), navigation only on
// the hub's origin, and new windows only to the system browser after a key press or click in the
// view in the last 5 seconds (typing into the page counts). The device secret never reaches it: main
// adds the header to each request for its own hub (`sendHeaders`), a page-set one is always
// removed, and a packaged app closes developer tools on the view.
//
// Policy only, with every Electron object injected, so test/hub-view.test.ts runs without Electron.
const { pathToFileURL } = require('node:url')
const { DEVICE_HEADER, hubHref } = require('./remote-connect.cjs')

const HUB_ID = /^[0-9a-f]{8}$/
const DEVICE_HEADER_NAME = DEVICE_HEADER.toLowerCase()
const INPUT_WINDOW_MS = 5_000
const ONLINE_EVERY_MS = 10_000
// a forget waits this long at most for the partition to be cleared
const CLEAR_WAIT_MS = 5_000
// a page that closes its own view gets a fresh one at most this often
const REBUILDS_PER_MINUTE = 3
const MINUTE_MS = 60_000
// #617 PR 3c: the local page draws whose Inbox is on screen in a strip this many CSS pixels tall at
// the top, since the hub's page controls every pixel of its own view. public/hub-strip.js draws it at
// the same height (test/dom/hub-strip.test.ts pins the two); the view starts insetFor(the local
// page's zoom factor) window pixels below the top, so the strip is never covered nor left short.
const HUB_STRIP_HEIGHT = 36
// the View menu's zoom steps, as Electron's zoomIn and zoomOut roles take them, within Chromium's range
const ZOOM_STEP = 0.5
const ZOOM_MIN = -7.5
const ZOOM_MAX = 8.5
const HUB_PARTITION = /^hub-[0-9a-f]{8}$/
const CLIPBOARD_WRITE = 'clipboard-sanitized-write'
// Chromium's code for a navigation that was cancelled, a prevented one included: not a failure
const ERR_ABORTED = -3
const STATES = new Set(['online', 'retrying', 'refused'])
// input that is a person's press, not a hover: a mouse move or wheel does not count
const PRESSES = new Set(['mouseDown', 'mouseUp', 'rawKeyDown', 'keyDown', 'keyUp', 'char', 'gestureTap', 'touchStart', 'touchEnd'])

const DESK_CHANNELS = Object.freeze({
  connection: 'agent-inbox:desk-connection',
  retry: 'agent-inbox:desk-retry',
  // main to the hub view only, with nothing in it: the preload asks `connection` again
  changed: 'agent-inbox:desk-changed',
})
const CONNECT_CHANNELS = Object.freeze({
  view: 'agent-inbox:connect-view',
  connect: 'agent-inbox:connect-connect',
  forget: 'agent-inbox:connect-forget',
  show: 'agent-inbox:connect-show',
  // main to the owned local page only, with nothing in it
  changed: 'agent-inbox:connect-changed',
})

const UNAVAILABLE = Object.freeze({ available: false })

// ── the rules ──────────────────────────────────────────────────────────────

/** `persist:hub-<id>` for an 8-hex id; anything else throws. */
function partitionFor(id) {
  if (typeof id !== 'string' || !HUB_ID.test(id)) throw new TypeError('not a hub id')
  return `persist:hub-${id}`
}

/**
 * The headers a request from the hub view's partition goes out with: every header named
 * `x-agent-inbox-device`, in any case, removed first, then the one `deviceHeaderFor(details.url)`
 * answers, if it answers one. For every request, whatever its URL or type, so a page-set header
 * never leaves and the secret goes only where `deviceHeaderFor` says.
 */
function sendHeaders(details, deviceHeaderFor) {
  const given = details !== null && typeof details === 'object' && details.requestHeaders !== null && typeof details.requestHeaders === 'object'
    ? details.requestHeaders : {}
  const headers = {}
  for (const [name, value] of Object.entries(given)) {
    if (name.toLowerCase() !== DEVICE_HEADER_NAME) headers[name] = value
  }
  let value = null
  try {
    value = deviceHeaderFor(details?.url)
  } catch {
    value = null
  }
  if (typeof value === 'string' && value !== '') headers[DEVICE_HEADER] = value
  return headers
}

/** The offline file at its exact URL: no query, no fragment. */
function isOfflineUrl(url, offlineUrl) {
  if (typeof url !== 'string' || typeof offlineUrl !== 'string') return false
  try {
    const asked = new URL(url)
    const shipped = new URL(offlineUrl)
    return asked.protocol === 'file:' && shipped.protocol === 'file:' && asked.search === '' && asked.hash === '' && asked.href === shipped.href
  } catch {
    return false
  }
}

/** True only for an `https` URL on the hub's exact origin, or the shipped offline file's exact URL. */
function allowNavigation(url, origin, offlineUrl) {
  if (typeof url !== 'string') return false
  return hubHref(url, origin) !== null || isOfflineUrl(url, offlineUrl)
}

/** True only for `clipboard-sanitized-write`, asked by the top frame of a page on the hub's origin. */
function allowPermission(permission, requestingUrl, origin, isMainFrame) {
  return permission === CLIPBOARD_WRITE && isMainFrame === true && typeof requestingUrl === 'string' && hubHref(requestingUrl, origin) !== null
}

/** True only while the view has focus and its last input event is under 5 seconds old. */
function mayOpenExternally({ focused, lastInputAt, now } = {}) {
  return focused === true && Number.isFinite(lastInputAt) && Number.isFinite(now) && now >= lastInputAt && now - lastInputAt < INPUT_WINDOW_MS
}

/**
 * Whether an IPC event really comes from the hub view: its webContents, its top frame, and that
 * frame on the hub origin (`'hub'`) or on the offline file (`'offline'`); else null. Read from
 * `event.sender` and `event.senderFrame` on every call, never from anything the page sent.
 */
function trustedDeskSender(event, view, origin, offlineUrl) {
  try {
    if (!event || !view) return null
    const contents = view.webContents
    if (!contents || contents.isDestroyed() || event.sender !== contents) return null
    const frame = event.senderFrame
    if (!frame || frame.parent !== null) return null
    const url = frame.url
    if (typeof url !== 'string') return null
    if (hubHref(url, origin) !== null) return 'hub'
    if (isOfflineUrl(url, offlineUrl)) return 'offline'
    return null
  } catch {
    return null
  }
}

/** What the hub view may know of the connection, rebuilt: label, state and version. Never an id, an origin or a reason. */
function deskConnection(connection) {
  if (connection === null || typeof connection !== 'object' || connection.mode !== 'hub' || !STATES.has(connection.state)) return null
  return {
    mode: 'hub',
    label: typeof connection.label === 'string' ? connection.label : '',
    state: connection.state,
    version: typeof connection.version === 'string' ? connection.version : null,
  }
}

const activeHub = (connection) => (connection !== null && typeof connection === 'object' && connection.mode === 'hub' && typeof connection.id === 'string' ? connection : null)

/** The window's title: the hub's label is added only while its view is on top. */
function windowTitle(connection, showing) {
  const hub = activeHub(connection)
  return hub !== null && showing === hub.id ? `Agent Inbox — ${hub.label}` : 'Agent Inbox'
}

/** The View menu's This Mac and <label> items, a radio pair, only while a hub exists. */
function hubMenuItems({ connection, showing, show }) {
  const hub = activeHub(connection)
  if (hub === null) return []
  return [
    { label: 'This Mac', type: 'radio', checked: showing !== hub.id, click: () => show(null) },
    { label: hub.label, type: 'radio', checked: showing === hub.id, click: () => show(hub.id) },
  ]
}

/** The view's top inset in window pixels: the strip's CSS height at the local page's zoom factor. */
function insetFor(zoom) {
  const factor = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  return Math.round(HUB_STRIP_HEIGHT * factor)
}

/**
 * The View menu's Actual Size, Zoom In and Zoom Out, doing what Electron's roles do to the focused
 * contents and then calling `after` (main lays the hub view out again: no event says the local page's
 * zoom changed).
 */
function zoomMenuItems({ focused, after }) {
  const apply = (next) => () => {
    let contents = null
    try {
      contents = focused()
    } catch {
      contents = null
    }
    try {
      if (contents && !contents.isDestroyed?.()) contents.setZoomLevel(next(contents.getZoomLevel()))
    } catch {
      // nothing zoomed
    }
    try {
      after()
    } catch {
      // nothing laid out
    }
  }
  return [
    { label: 'Actual Size', accelerator: 'CommandOrControl+0', click: apply(() => 0) },
    { label: 'Zoom In', accelerator: 'CommandOrControl+Plus', click: apply((level) => Math.min(level + ZOOM_STEP, ZOOM_MAX)) },
    { label: 'Zoom Out', accelerator: 'CommandOrControl+-', click: apply((level) => Math.max(level - ZOOM_STEP, ZOOM_MIN)) },
  ]
}

/** Main has no network-change event: `isOnline()` is read every 10 seconds, and a turn from false to true calls `onBack`. */
function watchOnline({ isOnline, onBack, setInterval: every = setInterval, intervalMs = ONLINE_EVERY_MS }) {
  const read = (fallback) => {
    try {
      return isOnline() === true
    } catch {
      return fallback
    }
  }
  let was = read(true)
  const timer = every(() => {
    const now = read(was)
    if (now && !was) onBack()
    was = now
  }, intervalMs)
  timer?.unref?.()
  return timer
}

// ── the view ───────────────────────────────────────────────────────────────

const isHttp = (url) => {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * One view for the active hub. `show(id | null)` puts it or This Mac on top; `current()` says
 * which; `reload()`, `destroy()`, `layout()`, `flush()`, `retry()` and `trusts(event)`. What it
 * shows follows `connect.onConnection`: the hub page once online, kept through `retrying`; the
 * offline file when refused, or while retrying with no hub page; nothing while the first check
 * runs. The active hub going away closes the view and asks its partition to clear everything.
 */
function createHubView(options) {
  const { window: win, session, WebContentsView, connect, openWebLink, offlineFile, preload } = options
  const now = options.now ?? Date.now
  // developer tools on the hub view would show the device header as sent: closed in a packaged app
  const isPackaged = options.isPackaged !== false
  const readPartitions = options.readPartitions ?? (() => [])
  const setTimeoutFn = options.setTimeout ?? setTimeout
  // #617 PR 3c: the one guard every way of showing the hub goes through. True only while this
  // window's page is the one the app owns, which alone hears agentInboxConnect and draws the strip;
  // false by default, so a caller that does not say never shows the hub.
  const mayShow = () => {
    try {
      return options.mayShow?.() === true
    } catch {
      return false
    }
  }
  const offlineUrl = pathToFileURL(offlineFile).href
  // sessions whose handlers are in place (a partition is configured once per run)
  const configured = new WeakSet()
  // { id, origin, ses, view, contents, loaded: null | 'hub' | 'offline', lastInputAt }
  let active = null
  // the hub being made: its id, while its origin is read and its session set up
  let pending = null
  let showing = null
  let destroyed = false
  let epoch = 0
  // the session of the last view, kept after the window closes so will-quit can write it
  let kept = null
  // the hub whose page closed its own view, waiting for a fresh one; when the fresh ones made in the last minute; held: the limit was hit, so only show() makes the next
  let dead = null
  const rebuilds = []
  let held = false
  // the clears in flight, each bounded
  const clears = new Set()

  const clock = () => {
    try {
      const t = now()
      return Number.isFinite(t) ? t : Number.NaN
    } catch {
      return Number.NaN
    }
  }
  const changed = () => {
    try {
      options.onChange?.()
    } catch {
      // a listener that throws stops nothing
    }
  }

  async function configure(ses, origin) {
    if (configured.has(ses)) return
    // Chromium would use the system proxy and trust store; a TLS-intercepting proxy would see the header
    await ses.setProxy({ mode: 'direct' })
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      // this partition's own hub only: during a replace, deviceHeaderFor already answers for the new one
      callback({ requestHeaders: sendHeaders(details, (url) => (hubHref(url, origin) === null ? null : connect.deviceHeaderFor(url))) })
    })
    ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
      callback(allowPermission(permission, details?.requestingUrl, origin, details?.isMainFrame))
    })
    ses.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) =>
      allowPermission(permission, details?.requestingUrl ?? requestingOrigin, origin, details?.isMainFrame))
    ses.setDevicePermissionHandler(() => false)
    ses.on('will-download', (event, item) => {
      event.preventDefault()
      try {
        item.cancel()
      } catch {
        // already gone
      }
    })
    configured.add(ses)
  }

  function maybeOpen(entry, url) {
    if (!isHttp(url)) return
    let focused = false
    try {
      focused = entry.contents.isFocused()
    } catch {
      focused = false
    }
    if (!mayOpenExternally({ focused, lastInputAt: entry.lastInputAt, now: clock() })) return
    // one input, one open: injected script cannot open a stream of tabs on one click
    entry.lastInputAt = null
    try {
      openWebLink(url)
    } catch {
      // nothing opened
    }
  }

  function guard(entry, event, mainFrame) {
    const url = typeof event?.url === 'string' ? event.url : ''
    if (allowNavigation(url, entry.origin, offlineUrl)) return
    event.preventDefault()
    if (mainFrame) maybeOpen(entry, url)
  }

  function load(entry, kind) {
    entry.loaded = kind
    const url = kind === 'hub' ? `${entry.origin}/` : offlineUrl
    try {
      // a failed load also reports did-fail-load, which shows the offline file
      Promise.resolve(entry.contents.loadURL(url)).catch(() => {})
    } catch {
      // the view is going away
    }
  }

  /** The hub page failed or its renderer went away: the offline file instead. A failing offline file is left, so nothing loops. */
  function lost(entry) {
    if (entry !== active || entry.loaded !== 'hub') return
    load(entry, 'offline')
  }

  function wire(entry) {
    const { contents } = entry
    contents.setWindowOpenHandler(({ url }) => {
      maybeOpen(entry, url)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event) => guard(entry, event, true))
    contents.on('will-frame-navigate', (event) => guard(entry, event, event?.isMainFrame === true))
    contents.on('will-redirect', (event) => guard(entry, event, event?.isMainFrame === true))
    contents.on('before-input-event', () => {
      entry.lastInputAt = clock()
    })
    contents.on('input-event', (_event, input) => {
      if (PRESSES.has(input?.type)) entry.lastInputAt = clock()
    })
    contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      if (isMainFrame === true && code !== ERR_ABORTED) lost(entry)
    })
    contents.on('render-process-gone', () => lost(entry))
    // no identity from this Mac's store is ever offered to a server the page reaches
    contents.on('select-client-certificate', (event, _url, _list, callback) => {
      event.preventDefault()
      callback()
    })
    if (isPackaged) {
      contents.on('devtools-opened', () => {
        try {
          contents.closeDevTools()
        } catch {
          // already closed
        }
      })
    }
    // window.close() from the page: Electron destroys the contents
    contents.on('destroyed', () => gone(entry))
  }

  function layout() {
    if (active === null) return
    let zoom = 1
    try {
      zoom = win.webContents.getZoomFactor()
    } catch {
      zoom = 1
    }
    const inset = insetFor(zoom)
    try {
      const [width, height] = win.getContentSize()
      active.view.setBounds({ x: 0, y: inset, width, height: Math.max(0, height - inset) })
    } catch {
      // the window is going away
    }
  }

  function place() {
    // what is on top is laid out at the local page's zoom of this moment
    layout()
    if (active !== null) {
      try {
        active.view.setVisible(showing === active.id)
      } catch {
        // the view is going away
      }
    }
    try {
      if (active !== null && showing === active.id) active.contents.focus()
      else win.webContents.focus()
    } catch {
      // nothing to focus
    }
  }

  function tellPage(entry) {
    try {
      if (entry.contents.isDestroyed() || !allowNavigation(entry.contents.getURL(), entry.origin, offlineUrl)) return
      entry.contents.send(DESK_CHANNELS.changed)
    } catch {
      // the page is going away
    }
  }

  function render(connection) {
    const entry = active
    if (entry === null || connection.mode !== 'hub' || connection.id !== entry.id) return
    if (connection.state === 'online') {
      if (entry.loaded !== 'hub') load(entry, 'hub')
    } else if (connection.state === 'refused') {
      if (entry.loaded !== 'offline') load(entry, 'offline')
    } else if (entry.loaded === null && connection.reason !== 'connecting') {
      load(entry, 'offline')
    }
    tellPage(entry)
  }

  async function activate(id) {
    const at = ++epoch
    pending = id
    let origin = null
    try {
      const view = await connect.view()
      const hub = view?.hub
      if (hub && hub.id === id && typeof hub.origin === 'string' && hubHref(hub.origin, hub.origin) === `${hub.origin}/`) origin = hub.origin
    } catch {
      origin = null
    }
    if (at !== epoch || destroyed) return
    if (origin === null) {
      notBuilt(id)
      return
    }
    const ses = session.fromPartition(partitionFor(id))
    try {
      await configure(ses, origin)
    } catch {
      if (at === epoch && !destroyed) notBuilt(id)
      return
    }
    if (at !== epoch || destroyed) return
    const view = new WebContentsView({
      webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, disableDialogs: true, partition: partitionFor(id) },
    })
    // opaque before it is added: until its page paints, this Mac's page must not show through
    try {
      view.setBackgroundColor(String(options.backgroundColor?.() ?? '#ffffff'))
    } catch {
      // the default background
    }
    const entry = { id, origin, ses, view, contents: view.webContents, loaded: null, lastInputAt: null }
    wire(entry)
    active = entry
    pending = null
    kept = ses
    win.contentView.addChildView(view)
    layout()
    place()
    render(connect.connection())
    changed()
  }

  /** A build that stopped early: nothing is being built, so the next change or show(id) tries again, and nothing claims to be on top. */
  function notBuilt(id) {
    if (pending === id) pending = null
    if (showing === id) {
      showing = null
      place()
    }
    changed()
  }

  function close(entry) {
    entry.closing = true
    try {
      win.contentView.removeChildView(entry.view)
    } catch {
      // already removed
    }
    try {
      if (!entry.contents.isDestroyed()) entry.contents.close()
    } catch {
      // already closed
    }
  }

  /** The active hub went away (forgotten or replaced): close its view, then clear its partition. */
  function drop() {
    epoch += 1
    const entry = active
    const id = entry?.id ?? pending ?? dead
    active = null
    pending = null
    dead = null
    held = false
    kept = null
    if (entry !== null) close(entry)
    if (id !== null) {
      try {
        clearPartition(entry?.ses ?? session.fromPartition(partitionFor(id)))
      } catch {
        // nothing stored
      }
    }
    showing = null
    place()
  }

  /** Everything in the partition (cache, cookies, storage, service workers), waited for at most 5 seconds by cleared(). */
  function clearPartition(ses) {
    let done
    try {
      done = Promise.resolve(ses.clearData()).catch(() => {})
    } catch {
      done = Promise.resolve()
    }
    const bounded = Promise.race([done, new Promise((resolve) => {
      const timer = setTimeoutFn(resolve, CLEAR_WAIT_MS)
      timer?.unref?.()
    })])
    clears.add(bounded)
    bounded.then(() => clears.delete(bounded))
  }

  /** The page closed its own view: drop it and show This Mac; a fresh one comes at the next change or show(). */
  function gone(entry) {
    if (entry.closing || entry !== active) return
    try {
      win.contentView.removeChildView(entry.view)
    } catch {
      // already removed
    }
    active = null
    dead = entry.id
    showing = null
    place()
    changed()
  }

  function mayRebuild() {
    const t = clock()
    if (!Number.isFinite(t)) return false
    while (rebuilds.length > 0 && !(t - rebuilds[0] < MINUTE_MS)) rebuilds.shift()
    return rebuilds.length < REBUILDS_PER_MINUTE
  }

  function rebuild(id) {
    rebuilds.push(clock())
    dead = null
    held = false
    activate(id).catch(() => {})
  }

  /** At start: every hub-<8 hex> partition but the stored hub's is cleared. Only sessions are asked; no file is touched. */
  async function sweep() {
    let ids
    try {
      const names = readPartitions()
      ids = Array.isArray(names) ? names.filter((name) => typeof name === 'string' && HUB_PARTITION.test(name)).map((name) => name.slice(4)) : []
    } catch {
      return
    }
    if (ids.length === 0) return
    let stored
    try {
      const view = await connect.view()
      // a store that cannot be read may still hold the hub: clear nothing
      if (view === null || typeof view !== 'object' || (view.problem !== null && view.problem !== undefined)) return
      stored = view.hub?.id ?? null
    } catch {
      return
    }
    for (const id of ids) {
      const hub = activeHub(connect.connection())
      if (destroyed || id === stored || hub?.id === id || active?.id === id || pending === id || dead === id) continue
      try {
        clearPartition(session.fromPartition(partitionFor(id)))
      } catch {
        // nothing to clear
      }
    }
  }

  function update(connection) {
    if (destroyed) return
    const hub = activeHub(connection)
    if (hub === null) {
      if (active !== null || pending !== null || dead !== null || showing !== null) drop()
    } else if (active !== null && active.id === hub.id) {
      render(hub)
    } else if (dead === hub.id) {
      if (!held && mayRebuild()) rebuild(hub.id)
      else held = true
    } else if (pending !== hub.id) {
      if (active !== null || pending !== null || dead !== null) drop()
      activate(hub.id).catch(() => {})
    }
    changed()
  }

  function flush() {
    try {
      ;(active?.ses ?? kept)?.flushStorageData()
    } catch {
      // nothing to write
    }
  }

  /** Closes the view and keeps its session, which will-quit writes with flush(); its storage stays (only the hub going away clears it). */
  function destroy() {
    if (destroyed) return
    destroyed = true
    epoch += 1
    try {
      unsubscribe()
      win.removeListener('resize', onResize)
      win.removeListener('closed', destroy)
    } catch {
      // nothing to remove
    }
    // closed first, so what the page writes as it goes reaches the session; flush() in will-quit writes it
    if (active !== null) close(active)
    active = null
    pending = null
    showing = null
  }

  const unsubscribe = connect.onConnection(update)
  const onResize = () => layout()
  win.on('resize', onResize)
  win.once('closed', destroy)
  update(connect.connection())
  sweep().catch(() => {})

  return Object.freeze({
    show(id) {
      if (destroyed) return { ok: false, reason: 'destroyed' }
      if (id === null) {
        showing = null
      } else {
        if (typeof id !== 'string' || !HUB_ID.test(id)) return { ok: false, reason: 'bad_id' }
        const hub = activeHub(connect.connection())
        if (hub === null || hub.id !== id) return { ok: false, reason: 'not_found' }
        if (!mayShow()) return { ok: false, reason: 'not_owned' }
        if (dead === id) {
          if (!mayRebuild()) return { ok: false, reason: 'busy' }
          rebuild(id)
        } else if (active?.id !== id && pending !== id) {
          // no view and none being built: start one, and say it is not ready rather than show nothing
          if (active === null && pending === null) activate(id).catch(() => {})
          return { ok: false, reason: 'not_ready' }
        }
        showing = id
      }
      place()
      changed()
      return { ok: true, showing }
    },
    /** The hub whose view is really on top, else null: never one being built or rebuilt. */
    current: () => (showing !== null && active !== null && active.id === showing ? showing : null),
    /** Whether the hub may be shown now (the menu offers it only then). */
    canShow: () => mayShow(),
    /** The local page gained or lost the binding: This Mac comes forward when it is lost. */
    ownerChanged() {
      if (destroyed) return
      if (!mayShow() && showing !== null) {
        showing = null
        place()
      }
      changed()
    },
    reload() {
      if (active === null || active.loaded !== 'hub') return
      try {
        active.contents.reloadIgnoringCache()
      } catch {
        // the page is going away
      }
    },
    destroy,
    layout,
    flush,
    async retry() {
      const entry = active
      if (entry === null || destroyed) return { ok: false }
      await connect.kick()
      if (entry !== active) return { ok: false }
      const connection = connect.connection()
      if (connection.mode === 'hub' && connection.id === entry.id && connection.state === 'online' && entry.loaded !== 'hub') load(entry, 'hub')
      return { ok: true }
    },
    /** Resolves when the partitions being cleared are cleared, or after 5 seconds. */
    cleared: () => Promise.all([...clears]).then(() => undefined),
    trusts: (event) => (active === null ? null : trustedDeskSender(event, active.view, active.origin, offlineUrl)),
  })
}

// ── the IPC ────────────────────────────────────────────────────────────────

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const shortText = (value, max) => typeof value === 'string' && value.length <= max
const CONNECT_KEYS = new Set(['address', 'code', 'replace'])

/** `{ address, code, replace }` rebuilt from exactly one plain object with those keys and types, else null. */
function connectInput(args) {
  if (args.length !== 1 || !isPlainObject(args[0])) return null
  const given = args[0]
  if (Object.keys(given).some((key) => !CONNECT_KEYS.has(key))) return null
  if (!shortText(given.address, 300) || !shortText(given.code, 64)) return null
  if (given.replace !== undefined && typeof given.replace !== 'boolean') return null
  return { address: given.address, code: given.code, replace: given.replace === true }
}

/**
 * The channels of the two bridges. `agentInboxConnect` (connect-*) answers only the viewer this
 * app started and owns (`isOwned`, after `settled()`, as the link settings do), with the argument
 * count and types checked again here; any other sender, and every sender off macOS (no
 * controller), gets `{ available: false }`. `agentInboxDesk` (desk-*) answers only the hub view's
 * top frame on the hub origin or the offline file, checked on every call; retry only the offline
 * file.
 */
function registerHubIpc({ ipcMain, settled, isOwned, connect, hubView }) {
  function owned(channel, read, call) {
    ipcMain.handle(channel, async (event, ...args) => {
      const input = read(args)
      if (input === null) return { ...UNAVAILABLE }
      await settled()
      const controller = connect()
      if (controller === null || !isOwned(event)) return { ...UNAVAILABLE }
      return call(controller, input)
    })
  }
  owned(CONNECT_CHANNELS.view, (args) => (args.length === 0 ? [] : null), async (controller) => ({
    ...(await controller.view()),
    showing: hubView()?.current() ?? null,
  }))
  owned(CONNECT_CHANNELS.connect, connectInput, (controller, input) => controller.connect(input))
  // answered once the forgotten hub's partition is cleared, or after 5 seconds
  owned(CONNECT_CHANNELS.forget, (args) => (args.length === 1 && shortText(args[0], 64) ? args[0] : null), async (controller, id) => {
    const result = await controller.forget(id)
    await hubView()?.cleared()
    return result
  })
  owned(CONNECT_CHANNELS.show, (args) => (args.length === 1 && (args[0] === null || shortText(args[0], 64)) ? { id: args[0] } : null), (_controller, { id }) => {
    const view = hubView()
    return view === null ? { ...UNAVAILABLE } : view.show(id)
  })

  ipcMain.handle(DESK_CHANNELS.connection, (event, ...args) => {
    const view = hubView()
    const controller = connect()
    if (args.length !== 0 || view === null || controller === null || view.trusts(event) === null) return { ...UNAVAILABLE }
    return deskConnection(controller.connection()) ?? { ...UNAVAILABLE }
  })
  ipcMain.handle(DESK_CHANNELS.retry, async (event, ...args) => {
    const view = hubView()
    if (args.length !== 0 || view === null || view.trusts(event) !== 'offline') return { ok: false }
    const result = await view.retry()
    return { ok: result?.ok === true }
  })
}

module.exports = {
  CONNECT_CHANNELS,
  DESK_CHANNELS,
  HUB_STRIP_HEIGHT,
  INPUT_WINDOW_MS,
  insetFor,
  allowNavigation,
  allowPermission,
  createHubView,
  deskConnection,
  hubMenuItems,
  mayOpenExternally,
  partitionFor,
  registerHubIpc,
  sendHeaders,
  trustedDeskSender,
  watchOnline,
  windowTitle,
  zoomMenuItems,
}
