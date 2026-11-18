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
// - createRemoteNotifier: the native notifications, worded from public/remote-words.js, the table
//   the panel uses; an identical one is quieted for 10 minutes, and a pause at app start is held for
//   2 minutes.
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
  // review round 1, item 8: switching on that removes the paired Macs, after the owner agreed
  turnOnRemovingDevices: 'agent-inbox:remote-entry-turn-on-remove-devices',
  // review round 1, item 6: Settings opened, so the removal hint is read again
  recheck: 'agent-inbox:remote-entry-recheck',
})
// main → page: a bare ping, after which the page asks get() again
const CHANGED = 'agent-inbox:remote-entry-changed'

const DEVICE_ID = /^[0-9a-f]{16}$/
const DIGEST = /^[0-9a-f]{64}$/
const QUIET_MS = 10 * 60_000
// at app start, a pause is held this long: one that resumes within it notifies nothing
const START_GRACE_MS = 2 * 60_000
// a refused switch-on is news for this long at most (review round 2, item 1)
const REFUSAL_MS = 2 * 60_000
// this many status reads in a row that fail: the app can't reach its own Inbox (item 5)
const UNREACHABLE_AFTER = 3
const QUIT_WAIT_MS = 5_000
const WATCH_EVERY_MS = 5_000

const isDeviceId = (value) => typeof value === 'string' && DEVICE_ID.test(value)
const isDigest = (value) => typeof value === 'string' && DIGEST.test(value)
const isBoolean = (value) => typeof value === 'boolean'
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// each channel's arguments, checked again here whatever the preload sent
const ARGUMENTS = Object.freeze({
  get: [], turnOn: [], turnOff: [], removeDevice: [isDeviceId], clearUnreadable: [], repairPermissions: [],
  acknowledge: [isDigest], test: [], addDevice: [], setOpenAtLogin: [isBoolean], turnOnRemovingDevices: [], recheck: [],
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
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null)
const LISTEN_ERRORS = new Set(['port_in_use', 'cannot_listen'])
const labels = (value) => (Array.isArray(value) ? value.filter((label) => typeof label === 'string') : [])

/** review()'s facts, rebuilt: labels, booleans and counts only. */
function changesOf(value) {
  if (!isObject(value)) return null
  return {
    unknown: value.unknown === true, missing: value.missing === true, unreadable: value.unreadable === true,
    switched: value.switched === 'on' || value.switched === 'off' ? value.switched : null,
    address: value.address === true, account: value.account === true, port: value.port === true,
    added: labels(value.added), removed: labels(value.removed), keyChanged: labels(value.keyChanged),
    unreadableAdded: count(value.unreadableAdded) ?? 0, unreadableRemoved: count(value.unreadableRemoved) ?? 0,
  }
}

/** The pause's word, refined to what Tailscale said when that is what it waits on (signed out, not installed). */
function waitingOf(resume, self) {
  if (resume.waiting === 'tailscale_unreadable' && isObject(self) && self.ok === false && typeof self.reason === 'string') {
    return `self_not_ok:${self.reason}`
  }
  return resume.waiting
}

/** The controller's answer to an operation, cut to `ok`, a reason word and the named fields. */
function answer(result, fields = []) {
  if (!isObject(result) || typeof result.ok !== 'boolean') return { ok: false, reason: 'failed' }
  if (!result.ok) {
    const out = { ok: false, reason: word(result.reason) ?? 'failed' }
    if (typeof result.step === 'string') out.step = result.step
    if ('rose' in result) out.rose = word(result.rose)
    if (count(result.devices) !== null) out.devices = result.devices
    return out
  }
  const out = { ok: true }
  for (const field of fields) if (field in result) out[field] = result[field]
  return out
}

/**
 * `switched()` runs when an owner's switch worked (on, on removing the paired Macs, off, Make it
 * private): main resets the notifier then (review round 2, item 2).
 */
function createRemoteEntryPanel({ controller, loginItem, changed = () => {}, switched = () => {}, now = Date.now }) {
  // when the owner last switched sharing on or off here: a stop before it is history, not news
  let switchedAt = -Infinity
  // the last refused switch-on (review round 1, item 4): kept here, not on the page, and gone once
  // a later operation works or what get() shows changes; `key` is that state, from the next get()
  let refusal = null
  // status reads in a row that failed
  let failures = 0
  const ping = () => {
    try {
      changed()
    } catch {
      // a page that is gone changes nothing
    }
  }
  const run = async (call, fields, { owner = false, switchOn = false } = {}) => {
    if (owner) switchedAt = now()
    let result
    try {
      result = answer(await call(), fields)
    } catch {
      result = { ok: false, reason: 'failed' }
    }
    if (result.ok) refusal = null
    if (result.ok && owner) {
      try {
        switched()
      } catch {
        // the notifier keeps what it had
      }
    } else if (!result.ok && switchOn) refusal = { reason: result.reason, step: result.step ?? null, devices: result.devices ?? null, at: now(), key: null }
    ping()
    return result
  }

  async function get() {
    // one status read first, so `listening` is fresh (and the viewer reconciles its listener now);
    // only the boolean the controller keeps from it is used
    let read = false
    try {
      read = (await controller.entryStatus())?.ok === true
    } catch {
      // unknown reads as not listening
    }
    failures = read ? 0 : failures + 1
    const review = await controller.review()
    const state = await controller.state()
    const view = review.view
    const stopped = isObject(state.stopped) && state.stopped.at > switchedAt ? state.stopped : null
    const serve = isObject(state.serve) && isObject(state.serve.answer) ? state.serve.answer : null
    const out = {
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
      resume: isObject(state.resume) ? { waiting: waitingOf(state.resume, state.self), nextAt: state.resume.nextAt } : null,
      needsOwner: state.needsOwner === 'identity_changed' ? 'identity_changed' : null,
      stateSaved: typeof state.stateSaved === 'boolean' ? state.stateSaved : null,
      serve: serve && (serve.ok === true ? { ok: true } : { ok: false, reason: word(serve.reason) }),
      removalHint: word(state.removalHint),
      command: `tailscale serve --bg ${controller.port}`,
      loginItem: loginItem.read(),
      listening: read && state.listening === true,
      listenError: read && LISTEN_ERRORS.has(state.listenError) ? state.listenError : null,
      changes: review.flag === true ? changesOf(review.changes) : null,
      inboxUnreachable: failures >= UNREACHABLE_AFTER,
    }
    // A refused switch-on is news, not the present (review round 2, item 1): it goes when anything
    // the panel shows changes, a pause's next try aside, and after 2 minutes at the latest.
    const key = JSON.stringify({ ...out, resume: out.resume && out.resume.waiting, serve: null, removalHint: null, loginItem: null, stateSaved: null })
    if (refusal !== null) {
      if (now() - refusal.at > REFUSAL_MS) refusal = null
      else if (refusal.key === null) refusal.key = key
      else if (refusal.key !== key) refusal = null
    }
    return { ...out, refusal: refusal && { reason: refusal.reason, step: refusal.step, devices: refusal.devices, at: refusal.at } }
  }

  return Object.freeze({
    get,
    turnOn: () => run(() => controller.turnOn(), ['voidedCode', 'devicesRemoved', 'droppedEntries', 'listening'], { owner: true, switchOn: true }),
    turnOnRemovingDevices: () => run(() => controller.turnOn({ removeDevices: true }), ['voidedCode', 'devicesRemoved', 'droppedEntries', 'listening'], { owner: true, switchOn: true }),
    async recheck() {
      try {
        await controller.recheckHint()
      } catch {
        // the hint stays as it was read
      }
      ping()
      return { ok: true }
    },
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
  paused: 'Agent Inbox paused sharing with your other Macs',
  stopped: 'Agent Inbox stopped sharing with your other Macs',
  resumed: 'Agent Inbox is sharing with your other Macs again',
  paired: 'A Mac was paired',
  outside: 'Agent Inbox’s sharing settings were changed outside the app',
})
const SEE = 'Open Settings → Other devices to see what to do.'

/**
 * The controller's four callbacks as notifications (review round 1, items 1, 2 and 13). `show({
 * title, body })` puts one up as plain text (a label is text a device chose); `words` is
 * public/remote-words.js, or a promise of it: a pause or a stop is worded from the same family the
 * panel shows. Every call pings the panel. A pause, a stop or a resume is quieted only when it is
 * the same kind and reason as the last one shown, under 10 minutes ago; a pairing and an outside
 * change never are (the controller calls onOutsideChange once per flagged state). For 2 minutes
 * after started(), a pause is held: one that resumes within 2 minutes notifies nothing, and one
 * still standing then is notified.
 */
function createRemoteNotifier({
  show, words, changed = () => {}, now = Date.now, setTimeout: setTimeoutFn = setTimeout, clearTimeout: clearTimeoutFn = clearTimeout,
}) {
  let last = null
  let startedAt = null
  let held = null
  const ping = () => {
    try {
      changed()
    } catch {
      // nothing to update
    }
  }
  const put = (text) => {
    Promise.resolve(words).then((loaded) => {
      const { title, body } = text(loaded)
      show({ title, body })
    }).catch(() => {})
  }
  const release = () => {
    if (held === null) return
    try {
      clearTimeoutFn(held)
    } catch {
      // the timer fires into nothing
    }
    held = null
  }
  // the family's reason, as the panel's status line has it
  const whyOf = (loaded, reason) => loaded.familyWords(loaded.reasonFamily('stop', reason)).why
  const sharing = (kind, reason, text) => {
    const t = now()
    if (last && last.kind === kind && last.reason === reason && t >= last.at && t - last.at < QUIET_MS) return
    last = { kind, reason, at: t }
    put(text)
  }
  const paused = (reason) => sharing('paused', reason, (loaded) => ({ title: TITLES.paused, body: `Paused: ${whyOf(loaded, reason)}. ${SEE}` }))
  return Object.freeze({
    /** The app started: pauses in the next 2 minutes are held. */
    started() {
      startedAt = now()
    },
    /** The owner's own switch worked: a held pause is dropped, and nothing counts as a repeat. */
    reset() {
      release()
      last = null
    },
    onStopped(reason, detail) {
      ping()
      release()
      if (detail?.willResume === true) {
        if (startedAt !== null && now() - startedAt < START_GRACE_MS) {
          held = setTimeoutFn(() => {
            held = null
            paused(reason)
          }, START_GRACE_MS)
          held?.unref?.()
          return
        }
        paused(reason)
        return
      }
      sharing('stopped', reason, (loaded) => {
        const why = whyOf(loaded, reason)
        return { title: TITLES.stopped, body: `${why[0].toUpperCase()}${why.slice(1)}. ${SEE}` }
      })
    },
    onResumed() {
      ping()
      // a pause at start that came back on its own: nothing at all
      if (held !== null) {
        release()
        return
      }
      sharing('resumed', null, () => ({ title: TITLES.resumed, body: '' }))
    },
    onPaired(label) {
      ping()
      put(() => ({ title: TITLES.paired, body: `${String(label)} can now use this Inbox.` }))
    },
    onOutsideChange() {
      ping()
      put(() => ({ title: TITLES.outside, body: 'Open Settings → Other devices to review.' }))
    },
  })
}

// ── Open Agent Inbox at login ──────────────────────────────────────────────

function loginItemFor({ app, platform }) {
  const available = platform === 'darwin' && app.isPackaged === true
  const read = () => {
    if (!available) return { available: false, openAtLogin: false, needsApproval: false }
    try {
      const settings = app.getLoginItemSettings()
      // macOS 13 and later: the item is there, but the person must allow it in System Settings
      return { available: true, openAtLogin: settings.openAtLogin === true, needsApproval: settings.status === 'requires-approval' }
    } catch {
      return { available: true, openAtLogin: false, needsApproval: false }
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
      // a pause's next try moves every few seconds; the page shows it to the minute
      const text = JSON.stringify(view, (key, value) => (key === 'nextAt' && typeof value === 'number' ? Math.floor(value / 60_000) : value))
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
