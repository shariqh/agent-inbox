'use strict'
// Updating the hub from the connecting Mac (#637), main's half on the hub. Main owns the update
// controller (electron/update-controller.cjs); the remote entry lives in the viewer, which only
// relays (src/remote-update.ts). Every few seconds, and whenever the controller's state changes,
// main reports to its own viewer, on the loopback route POST /api/remote-entry/update with the owner
// token and the loopback Origin, what a paired device may see: the running version, a status word,
// the newer release its controller verified, whether an update could start now and, when not, why.
// The viewer's answer carries the one request a paired device made since (its id and the device's id,
// never anything about what to install). Main then checks its own state again and runs its own
// controller: the download of the release that controller verified, then its install, which ends in
// the restart the controller asks for. Nothing here names a version, URL or file the caller chose.
//
// Main reports only while this Mac shares its Inbox and has a paired device (`shared()`): for anyone
// else no timer tick, no controller change and no look builds a summary or sends anything, and the
// viewer answers `not_ready` by itself.
//
// Architecture notes: docs/architecture/remote-inbox.md ("Updating the hub from another Mac").

const REPORT_EVERY_MS = 3_000
const CHECK_EVERY_MS = 60 * 60_000
const FETCH_TIMEOUT_MS = 5_000
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const REQUEST_ID = /^[0-9a-f]{16}$/
const DEVICE_ID = /^[0-9a-f]{16}$/
// what a device's look may make the hub check: nothing newer is known, and nothing is running
const CHECKABLE = new Set(['idle', 'current', 'unverified', 'stale'])

function isNewer(candidate, current) {
  if (typeof candidate !== 'string' || typeof current !== 'string' || !VERSION.test(candidate) || !VERSION.test(current)) return false
  const left = VERSION.exec(candidate).slice(1).map(BigInt)
  const right = VERSION.exec(current).slice(1).map(BigInt)
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index]
  }
  return false
}

/**
 * What a paired device may see of this hub's update, and whether it may start one now:
 * `{ current, status, newer, canStart, reason }`. `state` is the controller's (null for a build with
 * none: a checkout, an unpackaged or unsupported build); the rest are the gates main already keeps.
 * A start needs a verified newer release that downloads and installs here, on a window that holds the
 * install grant the local install needs too (#216), with no agent setup, install or quit running.
 */
function updateSummary({ state, version, setupRunning, quitting, installing, running }) {
  const current = typeof state?.currentVersion === 'string' && VERSION.test(state.currentVersion) ? state.currentVersion : version
  const offered = state?.available
  const offer = offered && typeof offered.version === 'string' && VERSION.test(offered.version) && isNewer(offered.version, current) ? offered : null
  const newer = offer === null ? null : offer.version
  let status = 'current'
  if (state?.status === 'checking') status = 'checking'
  else if (state?.status === 'downloading') status = 'downloading'
  else if (state?.status === 'installing') status = 'installing'
  else if (offer !== null && (state.status === 'available' || state.status === 'verified')) status = 'available'
  else if (offer !== null && (state.status === 'download-failed' || state.status === 'install-failed')) status = 'failed'
  // a remote update under way: what it is doing, never "available" in between its steps
  if (running && status !== 'downloading') status = 'installing'
  const no = (reason) => ({ current, status, newer, canStart: false, reason })
  if (running || installing || status === 'installing') return no('installing')
  if (setupRunning) return no('setup_running')
  if (quitting || status === 'checking' || status === 'downloading') return no('busy')
  if (!state || state.status === 'unsupported') return no('not_here')
  if (offer === null || status === 'current') return no('nothing_newer')
  if (offer.downloadable !== true || offer.installable !== true) return no('not_here')
  if (offer.installPermitted !== true) return no('busy')
  return { current, status, newer, canStart: true, reason: null }
}

/** The viewer's answer, exactly: a request of two 16-hex ids or null, and whether a device looked. */
function readAnswer(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const request = value.request
  if (request === null) return { request: null, looked: value.looked === true }
  if (!request || typeof request !== 'object' || typeof request.id !== 'string' || !REQUEST_ID.test(request.id)
    || typeof request.device !== 'string' || !DEVICE_ID.test(request.device)) return null
  return { request: { id: request.id, device: request.device }, looked: value.looked === true }
}

/**
 * Main's link to its viewer for the hub's update. `controller()` answers the update controller or
 * null; `shared()` is true while this Mac's remote entry is on and has a paired device (a gate that
 * throws, or none, counts as not shared); `setupRunning()` and `quitting()` are main's install gate; `deviceLabel(id)` the paired
 * device's label (display text only), or null; `notify({ label, version })` the hub's own notice that
 * a device started an update. No operation rejects.
 */
function createRemoteUpdateLink(options) {
  const controller = options.controller
  const fetchImpl = options.fetch ?? ((url, init) => globalThis.fetch(url, init))
  const now = options.now ?? Date.now
  const setIntervalFn = options.setInterval ?? setInterval
  const clearIntervalFn = options.clearInterval ?? clearInterval
  const origin = new URL(options.base).origin
  const url = new URL('api/remote-entry/update', options.base).href
  let timer = null
  let reporting = null
  let again = false
  let running = null
  let lastRequest = null
  let lastCheck = -Infinity

  const isShared = () => {
    try {
      return typeof options.shared === 'function' && options.shared() === true
    } catch {
      return false
    }
  }
  const ask = (gate) => {
    try {
      return Boolean(gate())
    } catch {
      return true
    }
  }
  const current = () => {
    try {
      return controller() ?? null
    } catch {
      return null
    }
  }

  function summary() {
    const update = current()
    return updateSummary({
      state: update?.getState() ?? null,
      version: options.version,
      setupRunning: ask(options.setupRunning),
      quitting: ask(options.quitting),
      installing: update?.isInstalling() === true,
      running: running !== null,
    })
  }

  async function report() {
    if (!isShared()) return null
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Agent-Inbox-Owner': options.ownerToken },
        body: JSON.stringify(summary()),
        redirect: 'error',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      return response.ok ? readAnswer(await response.json()) : null
    } catch {
      return null
    }
  }

  /** The remote update: the verified release's download when it is not here yet, then its install. */
  async function run(update, version) {
    let state = update.getState()
    if (state.status === 'available' || state.status === 'download-failed') state = await update.downloadNow()
    if (state.status !== 'verified' && state.status !== 'install-failed') return
    // the release main started with, still installable on a window that may install it
    if (state.available?.version !== version || state.available?.installPermitted !== true) return
    if (ask(options.setupRunning) || ask(options.quitting)) return
    await update.installNow()
  }

  /** True for a request not seen before, whether or not it starts anything. */
  function begin(request) {
    if (request.id === lastRequest) return false
    lastRequest = request.id
    // main's own state decides, whatever the viewer let through
    const asked = summary()
    const update = current()
    if (!asked.canStart || update === null) return true
    running = run(update, asked.newer).catch(() => {}).finally(() => {
      running = null
      changed()
    })
    Promise.resolve()
      .then(() => options.deviceLabel(request.device))
      .catch(() => null)
      .then((label) => options.notify({ label: typeof label === 'string' ? label : null, version: asked.newer }))
      .catch(() => {})
    return true
  }

  function maybeCheck() {
    const update = current()
    if (update === null || running !== null || !CHECKABLE.has(update.getState()?.status)) return
    const t = now()
    if (t - lastCheck < CHECK_EVERY_MS) return
    lastCheck = t
    Promise.resolve().then(() => update.checkNow()).catch(() => {})
  }

  function sync() {
    if (reporting !== null) {
      again = true
      return reporting
    }
    reporting = (async () => {
      do {
        again = false
        const answer = await report()
        if (answer?.request) {
          // the viewer says "installing" since a new request: it hears main's own answer at once
          if (begin(answer.request)) again = true
        } else if (answer?.looked) {
          maybeCheck()
        }
      } while (again)
    })().catch(() => {}).finally(() => {
      reporting = null
    })
    return reporting
  }

  function changed() {
    void sync()
  }

  return Object.freeze({
    sync,
    changed,
    /** resolves once a remote update this link started has settled */
    settled: () => running ?? Promise.resolve(),
    start() {
      if (timer !== null) return
      timer = setIntervalFn(changed, REPORT_EVERY_MS)
      timer?.unref?.()
      changed()
    },
    stop() {
      if (timer !== null) clearIntervalFn(timer)
      timer = null
    },
  })
}

module.exports = {
  REPORT_EVERY_MS,
  createRemoteUpdateLink,
  updateSummary,
}
