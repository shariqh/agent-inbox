'use strict'

const MANUAL_RELEASES_URL = 'https://github.com/shariqh/agent-inbox/releases'
const DAY_MS = 24 * 60 * 60_000
const DEFAULT_INITIAL_DELAY_MS = 30_000
const DEFAULT_JITTER_RATIO = 0.1
const ALLOWED_STATUSES = new Set(['current', 'available', 'unsupported'])
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const TARGET_STRATEGIES = new Map([
  ['dmg', 'macos-dmg'],
  ['appimage', 'appimage-self-replace'],
  ['deb', 'deb-notify'],
])

function idleState(currentVersion, automaticChecks = false) {
  return {
    status: 'idle',
    currentVersion,
    automaticChecks,
    checkedAt: null,
    message: 'Updates have not been checked.',
  }
}

function unverifiedState(currentVersion, automaticChecks, clock) {
  return {
    status: 'unverified',
    currentVersion,
    automaticChecks,
    checkedAt: clock().toISOString(),
    message: 'The update could not be verified. Try again or use the releases page.',
  }
}

function checkingState(currentVersion, automaticChecks) {
  return {
    status: 'checking',
    currentVersion,
    automaticChecks,
    checkedAt: null,
    message: 'Checking for updates…',
  }
}

function createUpdateController(options) {
  if (!options || typeof options.currentVersion !== 'string') throw new TypeError('currentVersion is required')
  if (!options.preferences || typeof options.preferences.read !== 'function') {
    throw new TypeError('preferences adapter is required')
  }
  if (typeof options.checker !== 'function') throw new TypeError('checker is required')
  if (typeof options.notifier !== 'function') throw new TypeError('notifier is required')

  const currentVersion = options.currentVersion
  const preferences = options.preferences
  const checker = options.checker
  const notifier = options.notifier
  const clock = options.clock ?? (() => new Date())
  const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout
  const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout
  const random = options.random ?? Math.random
  const initialDelayMs = Math.max(0, options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS)
  const requestedJitter = options.jitterRatio ?? DEFAULT_JITTER_RATIO
  const jitterRatio = Math.min(0.25, Math.max(0, requestedJitter))
  const emit = options.emit ?? (() => {})

  let state = idleState(currentVersion)
  let rendererIsReady = false
  let timer = null
  let inFlight = null
  let disposed = false

  function publish(next) {
    const available = next.available
      ? Object.freeze({
          ...next.available,
          target: Object.freeze({ ...next.available.target }),
        })
      : undefined
    state = Object.freeze({
      ...next,
      ...(available ? { available } : {}),
    })
    emit(state)
    return state
  }

  function clearTimer() {
    if (timer !== null) clearTimeoutImpl(timer)
    timer = null
  }

  function recurringDelay() {
    const value = Number(random())
    const bounded = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5
    return Math.round(DAY_MS * (1 + jitterRatio * ((2 * bounded) - 1)))
  }

  function arm(delay) {
    if (disposed || !rendererIsReady) return
    clearTimer()
    timer = setTimeoutImpl(async () => {
      timer = null
      await runCheck('scheduled')
      try {
        const latest = await preferences.read()
        if (latest.automaticChecks && !disposed) arm(recurringDelay())
      } catch {
        // Storage failure disables future automatic work until renderer reload or an explicit toggle.
      }
    }, delay)
    timer?.unref?.()
  }

  async function notifyAvailable(available, startingPreferences) {
    if (startingPreferences.lastNotifiedVersion === available.version) return
    try {
      await preferences.setLastNotifiedVersion(available.version)
    } catch {
      return
    }
    try {
      await notifier({
        version: available.version,
        tag: available.tag,
        releaseUrl: available.releaseUrl,
      })
    } catch {
      // Notification delivery is best-effort after recording the version.
    }
  }

  function safeCheckerState(candidate, automaticChecks) {
    if (
      !candidate
      || typeof candidate !== 'object'
      || !ALLOWED_STATUSES.has(candidate.status)
      || candidate.currentVersion !== currentVersion
      || typeof candidate.checkedAt !== 'string'
      || typeof candidate.message !== 'string'
    ) {
      throw new Error('checker returned an invalid state')
    }
    if (candidate.status === 'available') {
      const available = candidate.available
      if (
        !available
        || typeof available.version !== 'string'
        || !VERSION_RE.test(available.version)
        || available.tag !== `v${available.version}`
        || available.releaseUrl !== `https://github.com/shariqh/agent-inbox/releases/tag/${available.tag}`
        || !available.target
        || TARGET_STRATEGIES.get(available.target.packageType) !== available.target.installStrategy
      ) {
        throw new Error('checker returned invalid verified release metadata')
      }
      return {
        status: 'available',
        currentVersion,
        automaticChecks,
        checkedAt: candidate.checkedAt,
        message: 'A verified update is available.',
        available: {
          version: available.version,
          tag: available.tag,
          releaseUrl: available.releaseUrl,
          target: {
            packageType: available.target.packageType,
            installStrategy: available.target.installStrategy,
          },
        },
      }
    }
    return {
      status: candidate.status,
      currentVersion,
      automaticChecks,
      checkedAt: candidate.checkedAt,
      message: candidate.status === 'current'
        ? 'Agent Inbox is up to date.'
        : 'Automatic updates are not supported for this installation.',
    }
  }

  function runCheck(mode) {
    if (inFlight !== null) {
      if (mode === 'scheduled') inFlight.scheduledRequested = true
      return inFlight.promise
    }

    const operation = { scheduledRequested: mode === 'scheduled', promise: null }
    operation.promise = (async () => {
      let prefs
      try {
        prefs = await preferences.read()
        if (mode === 'scheduled' && !prefs.automaticChecks) {
          return publish({
            ...state,
            automaticChecks: false,
          })
        }
        publish(checkingState(currentVersion, prefs.automaticChecks))
        const candidate = await checker({
          currentVersion,
          automaticChecks: prefs.automaticChecks,
        })
        let latestPreferences = prefs
        try {
          latestPreferences = await preferences.read()
        } catch {
          latestPreferences = { ...prefs, automaticChecks: state.automaticChecks }
        }
        const checked = safeCheckerState(candidate, latestPreferences.automaticChecks)
        if (checked.status === 'available' && operation.scheduledRequested && latestPreferences.automaticChecks) {
          await notifyAvailable(checked.available, latestPreferences)
        }
        return publish(checked)
      } catch {
        return publish(unverifiedState(currentVersion, state.automaticChecks, clock))
      } finally {
        if (inFlight === operation) inFlight = null
      }
    })()
    inFlight = operation
    return operation.promise
  }

  return Object.freeze({
    getState() {
      return state
    },
    async rendererReady() {
      if (disposed) return state
      rendererIsReady = true
      const prefs = await preferences.read()
      publish({ ...state, automaticChecks: prefs.automaticChecks })
      if (prefs.automaticChecks) arm(initialDelayMs)
      else clearTimer()
      return state
    },
    checkNow() {
      return runCheck('manual')
    },
    runScheduledCheck() {
      return runCheck('scheduled')
    },
    async setAutomaticChecks(automaticChecks) {
      const prefs = await preferences.setAutomatic(automaticChecks)
      publish({ ...state, automaticChecks: prefs.automaticChecks })
      clearTimer()
      if (prefs.automaticChecks) arm(initialDelayMs)
      return state
    },
    async refreshSchedule() {
      if (disposed) return state
      const prefs = await preferences.read()
      publish({ ...state, automaticChecks: prefs.automaticChecks })
      clearTimer()
      if (prefs.automaticChecks) arm(initialDelayMs)
      return state
    },
    dispose() {
      disposed = true
      clearTimer()
    },
  })
}

module.exports = {
  MANUAL_RELEASES_URL,
  createUpdateController,
}
