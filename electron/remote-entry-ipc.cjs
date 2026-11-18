'use strict'
// Settings → Other devices, main's half (#617, PR 2d): what electron/main.cjs uses to put the hub's
// remote-entry controller (./remote-entry.cjs) in front of the owner. Design:
// docs/superpowers/specs/2026-11-17-remote-inbox-design.md §3.2 "The hub's Settings"; architecture
// notes in docs/architecture/remote-inbox.md "The hub's Settings panel".
//
// - registerRemoteEntryIpc: the channels, gated as Settings → Links is: the argument count and each
//   argument's type, then any re-proof of the window in flight, then the viewer window's own top
//   frame, then macOS, then the viewer this app started and owns. Anything else is
//   `{ available: false }`, with `reason: 'unsupported'` or `'unowned'` for the last two.
// - createRemoteEntryPanel: what the panel draws, from one review() and one state(), and each
//   operation's answer cut down to its own few fields. Never a login, a secret hash, the owner token,
//   a code's id or a raw Tailscale answer: the controller's `view.logins` and `state().self` stay
//   here. The pairing code itself does cross, because the owner must read it off the screen; it is
//   never logged or kept.
// - createRemoteNotifier: the native notifications, at most one of each kind in 10 minutes; the
//   words come from public/remote-words.js, the table the panel uses.
// - loginItemFor: Open Agent Inbox at login, the packaged app on macOS only. A checkout build never
//   reads or sets it: a development binary must never become a login item.
// - stopRemoteEntry: stop() then settled(), waited for at most 5 seconds, on quit.
// - watchRemoteEntry: pings the page when what get() shows changed, every 5 seconds. get() reads
//   the viewer's status first, so `listening` (whether it really answers on the port) stays fresh.

const CHANNELS = Object.freeze({
  get: 'agent-inbox:remote-entry',
  turnOn: 'agent-inbox:remote-entry-turn-on',
  turnOff: 'agent-inbox:remote-entry-turn-off',
  removeDevice: 'agent-inbox:remote-entry-remove-device',
  clearUnreadable: 'agent-inbox:remote-entry-clear-unreadable',
  repairPermissions: 'agent-inbox:remote-entry-repair',
  acknowledge: 'agent-inbox:remote-entry-acknowledge',
  test: 'agent-inbox:remote-entry-test',
  addDevice: 'agent-inbox:remote-entry-add-device',
  setOpenAtLogin: 'agent-inbox:remote-entry-open-at-login',
})
// main → page: a bare ping, after which the page asks get() again
const CHANGED = 'agent-inbox:remote-entry-changed'

const DEVICE_ID = /^[0-9a-f]{16}$/
const DIGEST = /^[0-9a-f]{64}$/
const QUIET_MS = 10 * 60_000
const QUIT_WAIT_MS = 5_000
const WATCH_EVERY_MS = 5_000

const isDeviceId = (value) => typeof value === 'string' && DEVICE_ID.test(value)
const isDigest = (value) => typeof value === 'string' && DIGEST.test(value)
const isBoolean = (value) => typeof value === 'boolean'
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// each channel's arguments, checked again here whatever the preload sent
const ARGUMENTS = Object.freeze({
  get: [], turnOn: [], turnOff: [], removeDevice: [isDeviceId], clearUnreadable: [], repairPermissions: [],
  acknowledge: [isDigest], test: [], addDevice: [], setOpenAtLogin: [isBoolean],
})

const UNAVAILABLE = Object.freeze({ available: false })
const UNSUPPORTED = Object.freeze({ available: false, reason: 'unsupported' })
const UNOWNED = Object.freeze({ available: false, reason: 'unowned' })

/**
 * `panel()` is the panel, or null while there is none (another platform, or a viewer this app did
 * not start). `isTrusted(event)`: the viewer window's own top frame; `isOwned(event)`: that window
 * holds the owned-viewer grant.
 */
function registerRemoteEntryIpc({ ipcMain, platform, panel, settled, isTrusted, isOwned }) {
  for (const [name, channel] of Object.entries(CHANNELS)) {
    const checks = ARGUMENTS[name]
    ipcMain.handle(channel, async (event, ...args) => {
      if (args.length !== checks.length || !checks.every((check, i) => check(args[i]))) return { ...UNAVAILABLE }
      await settled()
      if (!isTrusted(event)) return { ...UNAVAILABLE }
      if (platform !== 'darwin') return { ...UNSUPPORTED }
      const current = panel()
      if (!current || !isOwned(event)) return { ...UNOWNED }
      return current[name](...args)
    })
  }
}

// ── what the panel draws ───────────────────────────────────────────────────

const word = (value) => (typeof value === 'string' ? value : null)

/** The controller's answer to an operation, cut to `ok`, a reason word and the named fields. */
function answer(result, fields = []) {
  if (!isObject(result) || typeof result.ok !== 'boolean') return { ok: false, reason: 'failed' }
  if (!result.ok) {
    const out = { ok: false, reason: word(result.reason) ?? 'failed' }
    if (typeof result.step === 'string') out.step = result.step
    if ('rose' in result) out.rose = word(result.rose)
    return out
  }
  const out = { ok: true }
  for (const field of fields) if (field in result) out[field] = result[field]
  return out
}

function createRemoteEntryPanel({ controller, loginItem, changed = () => {}, now = Date.now }) {
  // when the owner last switched sharing on or off here: a stop before it is history, not news
  let switchedAt = -Infinity
  const ping = () => {
    try {
      changed()
    } catch {
      // a page that is gone changes nothing
    }
  }
  const run = async (call, fields, { owner = false } = {}) => {
    if (owner) switchedAt = now()
    try {
      return answer(await call(), fields)
    } catch {
      return { ok: false, reason: 'failed' }
    } finally {
      ping()
    }
  }

  async function get() {
    // one status read first, so `listening` is fresh (and the viewer reconciles its listener now);
    // only the boolean the controller keeps from it is used
    try {
      await controller.entryStatus()
    } catch {
      // the controller keeps not listening
    }
    const review = await controller.review()
    const state = await controller.state()
    const view = review.view
    const stopped = isObject(state.stopped) && state.stopped.at > switchedAt ? state.stopped : null
    const serve = isObject(state.serve) && isObject(state.serve.answer) ? state.serve.answer : null
    return {
      available: true,
      enabled: view.enabled === true,
      host: word(view.host),
      port: controller.port,
      devices: Array.isArray(view.devices) ? view.devices.map(({ id, label, pairedAt }) => ({ id, label, pairedAt })) : [],
      unreadableDevices: view.unreadableDevices,
      problem: word(view.problem),
      flag: review.flag === true,
      digest: word(review.digest),
      wanted: state.wanted === true,
      stopped: stopped && { reason: stopped.reason, willResume: stopped.willResume === true },
      resume: isObject(state.resume) ? { waiting: state.resume.waiting, nextAt: state.resume.nextAt } : null,
      needsOwner: state.needsOwner === 'identity_changed' ? 'identity_changed' : null,
      stateSaved: typeof state.stateSaved === 'boolean' ? state.stateSaved : null,
      serve: serve && (serve.ok === true ? { ok: true } : { ok: false, reason: word(serve.reason) }),
      removalHint: word(state.removalHint),
      command: `tailscale serve --bg ${controller.port}`,
      loginItem: loginItem.read(),
      listening: state.listening === true,
    }
  }

  return Object.freeze({
    get,
    turnOn: () => run(() => controller.turnOn(), ['voidedCode', 'devicesRemoved', 'droppedEntries', 'listening'], { owner: true }),
    turnOff: () => run(() => controller.turnOff(), ['voidedCode'], { owner: true }),
    removeDevice: (id) => run(() => controller.removeDevice(id), ['voidedCode']),
    clearUnreadable: () => run(() => controller.clearUnreadable(), ['voidedCode', 'removed']),
    repairPermissions: () => run(() => controller.repairPermissions(), ['voidedCode', 'devicesRemoved'], { owner: true }),
    acknowledge: (digest) => run(() => controller.acknowledge(digest), []),
    test: () => run(() => controller.selfTest(), []),
    addDevice: () => run(() => controller.requestCode(), ['code', 'expiresAt']),
    setOpenAtLogin: (value) => run(() => loginItem.set(value), ['openAtLogin']),
  })
}

// ── notifications ──────────────────────────────────────────────────────────

const TITLES = Object.freeze({
  paused: 'Agent Inbox paused sharing with your other devices',
  stopped: 'Agent Inbox stopped sharing with your other devices',
  resumed: 'Agent Inbox is sharing with your other devices again.',
  outside: 'Agent Inbox’s sharing settings were changed outside the app',
})

/**
 * The controller's four callbacks as notifications. `show({ title, body })` puts one up (as plain
 * text: a label is text a device chose); `words` is public/remote-words.js, or a promise of it.
 * Each kind shows at most once in 10 minutes; every call, shown or not, pings the panel.
 */
function createRemoteNotifier({ show, words, changed = () => {}, now = Date.now }) {
  const last = new Map()
  const notify = (kind, text) => {
    try {
      changed()
    } catch {
      // nothing to update
    }
    const t = now()
    const at = last.get(kind)
    if (at !== undefined && t >= at && t - at < QUIET_MS) return
    last.set(kind, t)
    Promise.resolve(words).then((loaded) => {
      const { title, body } = text(loaded)
      show({ title, body })
    }).catch(() => {})
  }
  return Object.freeze({
    onStopped(reason, detail) {
      if (detail?.willResume === true) {
        notify('paused', () => ({ title: TITLES.paused, body: 'It comes back by itself when Tailscale is ready.' }))
      } else {
        notify('stopped', (loaded) => ({ title: TITLES.stopped, body: loaded.stopNotice(reason) }))
      }
    },
    onResumed() {
      notify('resumed', () => ({ title: TITLES.resumed, body: '' }))
    },
    onPaired(label) {
      notify('paired', () => ({ title: `${String(label)} can now use this Inbox.`, body: '' }))
    },
    onOutsideChange() {
      notify('outside', () => ({ title: TITLES.outside, body: 'Open Settings to review.' }))
    },
  })
}

// ── Open Agent Inbox at login ──────────────────────────────────────────────

function loginItemFor({ app, platform }) {
  const available = platform === 'darwin' && app.isPackaged === true
  const read = () => {
    if (!available) return { available: false, openAtLogin: false }
    try {
      return { available: true, openAtLogin: app.getLoginItemSettings().openAtLogin === true }
    } catch {
      return { available: true, openAtLogin: false }
    }
  }
  return Object.freeze({
    read,
    set(value) {
      if (!available || typeof value !== 'boolean') return { ok: false, reason: 'unavailable' }
      try {
        app.setLoginItemSettings({ openAtLogin: value })
      } catch {
        return { ok: false, reason: 'failed' }
      }
      return { ok: true, openAtLogin: read().openAtLogin }
    },
  })
}

// ── quitting and watching ──────────────────────────────────────────────────

/** stop(), then settled() waited for at most 5 seconds: quitting never hangs on the state store. */
async function stopRemoteEntry(controller, { setTimeout: setTimeoutFn = setTimeout } = {}) {
  try {
    controller.stop()
  } catch {
    // nothing more to stop
  }
  let bound
  const limit = new Promise((resolve) => {
    bound = setTimeoutFn(resolve, QUIT_WAIT_MS)
    bound?.unref?.()
  })
  await Promise.race([Promise.resolve().then(() => controller.settled()).catch(() => {}), limit])
}

/** Every 5 seconds, get() again; a ping when what it shows changed. */
function watchRemoteEntry({ panel, changed, setInterval: setIntervalFn = setInterval, clearInterval: clearIntervalFn = clearInterval }) {
  let last = null
  let busy = false
  const timer = setIntervalFn(() => {
    if (busy) return
    busy = true
    Promise.resolve().then(() => panel.get()).then((view) => {
      const text = JSON.stringify(view)
      if (last !== null && text !== last) changed()
      last = text
    }).catch(() => {}).finally(() => {
      busy = false
    })
  }, WATCH_EVERY_MS)
  timer?.unref?.()
  return { stop: () => clearIntervalFn(timer) }
}

module.exports = {
  CHANGED,
  CHANNELS,
  createRemoteEntryPanel,
  createRemoteNotifier,
  loginItemFor,
  registerRemoteEntryIpc,
  stopRemoteEntry,
  watchRemoteEntry,
}
