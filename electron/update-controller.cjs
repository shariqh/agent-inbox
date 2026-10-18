'use strict'

const MANUAL_RELEASES_URL = 'https://github.com/shariqh/agent-inbox/releases'
const DAY_MS = 24 * 60 * 60_000
const DEFAULT_INITIAL_DELAY_MS = 30_000
const DEFAULT_JITTER_RATIO = 0.1
const ALLOWED_STATUSES = new Set(['current', 'available', 'stale', 'unsupported'])
const CHECKED_MESSAGES = Object.freeze({
  current: 'Agent Inbox is up to date.',
  stale: 'Update information is older than a release this app already verified.',
  unsupported: 'Automatic updates are not supported for this installation.',
})
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const TARGET_STRATEGIES = new Map([
  ['dmg', 'macos-dmg'],
  ['appimage', 'appimage-self-replace'],
  ['deb', 'deb-notify'],
])
// deb-notify stays notify-only: nothing in the app may write into dpkg-owned paths.
const DOWNLOADABLE_STRATEGIES = new Set(['macos-dmg', 'appimage-self-replace'])
const DOWNLOAD_MESSAGES = {
  downloading: 'Downloading the verified update…',
  verified: 'The update was downloaded and verified.',
  'download-failed': 'The update could not be downloaded and verified. Try again or use the releases page.',
}

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

function isNewerVersion(candidate, current) {
  const left = VERSION_RE.exec(candidate).slice(1).map(BigInt)
  const right = VERSION_RE.exec(current).slice(1).map(BigInt)
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index]
  }
  return false
}

function sameArtifact(left, right) {
  return Boolean(
    left
    && right
    && left.version === right.version
    && left.installStrategy === right.installStrategy
    && left.url === right.url
    && left.byteLength === right.byteLength
    && left.sha256 === right.sha256,
  )
}

function createUpdateController(options) {
  if (!options || typeof options.currentVersion !== 'string') throw new TypeError('currentVersion is required')
  if (!options.preferences || typeof options.preferences.read !== 'function') {
    throw new TypeError('preferences adapter is required')
  }
  if (typeof options.checker !== 'function') throw new TypeError('checker is required')
  if (typeof options.notifier !== 'function') throw new TypeError('notifier is required')
  const downloader = options.downloader ?? null
  if (
    downloader !== null
    && ['normalize', 'download', 'cancel', 'prune'].some((name) => typeof downloader[name] !== 'function')
  ) {
    throw new TypeError('downloader adapter is invalid')
  }

  const currentVersion = options.currentVersion
  const preferences = options.preferences
  const trustState = options.trustState ?? null
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
  let highestVerifiedVersion = null
  // Main-process only: the signed artifact behind state.available, the verified
  // file once downloaded, and the running download. None of these is published.
  let artifact = null
  let verifiedArtifact = null
  let downloadOperation = null
  let startupPruned = false

  function publish(next) {
    const available = next.available
      ? Object.freeze({
          ...next.available,
          target: Object.freeze({ ...next.available.target }),
        })
      : undefined
    const download = next.download ? Object.freeze({ ...next.download }) : undefined
    const { available: _available, download: _download, ...rest } = next
    state = Object.freeze({
      ...rest,
      ...(available ? { available } : {}),
      ...(download ? { download } : {}),
    })
    emit(state)
    return state
  }

  function prune(pruneOptions) {
    if (downloader === null) return
    Promise.resolve()
      .then(() => downloader.prune(pruneOptions))
      .catch(() => {})
  }

  function downloadState(status, available, receivedBytes, totalBytes) {
    return {
      status,
      currentVersion,
      automaticChecks: state.automaticChecks,
      checkedAt: state.checkedAt,
      message: DOWNLOAD_MESSAGES[status],
      available,
      download: { receivedBytes, totalBytes },
    }
  }

  function availableState(available) {
    return {
      status: 'available',
      currentVersion,
      automaticChecks: state.automaticChecks,
      checkedAt: state.checkedAt,
      message: 'A verified update is available.',
      available,
    }
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
        downloadable: available.downloadable === true,
      })
    } catch {
      // Notification delivery is best-effort after recording the version.
    }
  }

  // The checker's artifact is accepted only through the downloader's own
  // validation and only when it is exactly the release being offered.
  function acceptArtifact(candidateArtifact, available) {
    if (candidateArtifact === undefined || downloader === null) return null
    const normalized = downloader.normalize(candidateArtifact)
    if (normalized === null || !DOWNLOADABLE_STRATEGIES.has(normalized.installStrategy)) return null
    if (
      normalized.version !== available.version
      || normalized.tag !== available.tag
      || normalized.packageType !== available.target.packageType
      || normalized.installStrategy !== available.target.installStrategy
    ) {
      throw new Error('checker returned an artifact for a different release')
    }
    return normalized
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
      const accepted = acceptArtifact(candidate.artifact, available)
      return {
        artifact: accepted,
        state: {
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
            downloadable: accepted !== null,
          },
        },
      }
    }
    return {
      artifact: null,
      state: {
        status: candidate.status,
        currentVersion,
        automaticChecks,
        checkedAt: candidate.checkedAt,
        message: CHECKED_MESSAGES[candidate.status],
      },
    }
  }

  function rememberVerified(version) {
    if (
      typeof version === 'string'
      && VERSION_RE.test(version)
      && (highestVerifiedVersion === null || isNewerVersion(version, highestVerifiedVersion))
    ) {
      highestVerifiedVersion = version
    }
  }

  // The checker calls this only after a manifest verifies. Memory keeps the mark for this
  // session even when it cannot be saved, and every save writes that session high, so a
  // later successful save also records a release whose own save failed.
  async function recordVerifiedVersion(version) {
    rememberVerified(version)
    if (trustState !== null) {
      try {
        rememberVerified((await trustState.recordVerifiedVersion(highestVerifiedVersion)).highestVerifiedVersion)
      } catch {
        try {
          rememberVerified((await trustState.read()).highestVerifiedVersion)
        } catch {
          // Unreadable storage leaves the in-memory mark for this session.
        }
      }
    }
    return highestVerifiedVersion
  }

  // A re-check that confirms the exact verified artifact keeps it; anything
  // else (a newer release, no release, a notify-only target) discards it.
  function settleCheck(checked) {
    if (
      state.status === 'verified'
      && verifiedArtifact !== null
      && checked.state.status === 'available'
      && sameArtifact(artifact, checked.artifact)
    ) {
      return publish({
        ...state,
        automaticChecks: checked.state.automaticChecks,
        checkedAt: checked.state.checkedAt,
      })
    }
    verifiedArtifact = null
    artifact = checked.artifact
    prune({ keep: checked.state.status === 'available' ? artifact : null, currentVersion })
    return publish(checked.state)
  }

  function runCheck(mode) {
    // The running download already belongs to a release verified moments ago.
    if (state.status === 'downloading') return Promise.resolve(state)
    if (inFlight !== null) {
      if (mode === 'scheduled') inFlight.scheduledRequested = true
      return inFlight.promise
    }

    const operation = { scheduledRequested: mode === 'scheduled', promise: null }
    operation.promise = (async () => {
      let prefs
      // A verified download stays on screen while it is re-confirmed.
      const quiet = state.status === 'verified'
      try {
        prefs = await preferences.read()
        if (mode === 'scheduled' && !prefs.automaticChecks) {
          return publish({
            ...state,
            automaticChecks: false,
          })
        }
        if (!quiet) publish(checkingState(currentVersion, prefs.automaticChecks))
        const candidate = await checker({
          currentVersion,
          automaticChecks: prefs.automaticChecks,
          recordVerifiedVersion,
        })
        let latestPreferences = prefs
        try {
          latestPreferences = await preferences.read()
        } catch {
          latestPreferences = { ...prefs, automaticChecks: state.automaticChecks }
        }
        const checked = safeCheckerState(candidate, latestPreferences.automaticChecks)
        if (checked.state.status === 'available' && operation.scheduledRequested && latestPreferences.automaticChecks) {
          await notifyAvailable(checked.state.available, latestPreferences)
        }
        return settleCheck(checked)
      } catch {
        if (quiet && state.status === 'verified') return state
        return publish(unverifiedState(currentVersion, state.automaticChecks, clock))
      } finally {
        if (inFlight === operation) inFlight = null
      }
    })()
    inFlight = operation
    return operation.promise
  }

  function validVerifiedRecord(record, target) {
    return Boolean(
      record
      && typeof record === 'object'
      && typeof record.path === 'string'
      && record.path !== ''
      && record.version === target.version
      && record.sha256 === target.sha256
      && record.byteLength === target.byteLength
      && record.installStrategy === target.installStrategy,
    )
  }

  async function downloadNow() {
    if (
      disposed
      || downloader === null
      || artifact === null
      // A starting check may still replace the offer; never race it.
      || inFlight !== null
      || (state.status !== 'available' && state.status !== 'download-failed')
      || state.available?.version !== artifact.version
    ) {
      return state
    }
    const target = artifact
    const available = state.available
    const totalBytes = target.byteLength
    const operation = {}
    let receivedBytes = 0
    let publishedPercent = 0
    downloadOperation = operation
    publish(downloadState('downloading', available, 0, totalBytes))
    try {
      const record = await downloader.download(target, {
        onProgress(received) {
          if (downloadOperation !== operation || !Number.isFinite(received)) return
          receivedBytes = Math.min(totalBytes, Math.max(0, Math.trunc(received)))
          // Whole-percent steps bound renderer IPC to ~100 messages per download.
          const percent = Math.floor((receivedBytes * 100) / totalBytes)
          if (percent === publishedPercent) return
          publishedPercent = percent
          publish(downloadState('downloading', available, receivedBytes, totalBytes))
        },
      })
      if (downloadOperation !== operation) return state
      downloadOperation = null
      if (!validVerifiedRecord(record, target)) throw new Error('downloader returned an unexpected artifact')
      verifiedArtifact = Object.freeze({ ...record })
      return publish(downloadState('verified', available, totalBytes, totalBytes))
    } catch (error) {
      if (downloadOperation !== operation) return state
      downloadOperation = null
      if (error?.code === 'cancelled' || error?.code === 'superseded') return publish(availableState(available))
      return publish(downloadState('download-failed', available, receivedBytes, totalBytes))
    }
  }

  return Object.freeze({
    getState() {
      return state
    },
    async rendererReady() {
      if (disposed) return state
      rendererIsReady = true
      if (!startupPruned) {
        startupPruned = true
        prune({ currentVersion })
      }
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
    downloadNow,
    async cancelDownload() {
      if (downloadOperation !== null && downloader !== null) await downloader.cancel()
      return state
    },
    // The install steps' seam: the verified file behind a 'verified' state.
    getVerifiedArtifact() {
      return state.status === 'verified' ? verifiedArtifact : null
    },
    dispose() {
      disposed = true
      clearTimer()
      if (downloadOperation !== null && downloader !== null) {
        try {
          Promise.resolve(downloader.cancel()).catch(() => {})
        } catch {
          // Quitting must not depend on cleanup; stale partials are pruned next launch.
        }
      }
    },
  })
}

module.exports = {
  MANUAL_RELEASES_URL,
  createUpdateController,
}
