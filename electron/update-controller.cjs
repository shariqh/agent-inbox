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
  'download-failed': 'Nothing unverified was kept. Try again, or review the release on GitHub.',
}
const INSTALL_MESSAGES = Object.freeze({
  failed: 'The update could not be installed. Nothing was changed. Try again or use Review release.',
  cancelled: 'The update install was cancelled. Nothing was changed.',
  checking: 'Agent Inbox is checking for updates. Try again in a moment.',
  setup: 'Agent setup is running. Try again when it finishes.',
  notNewer: 'This update is not newer than the installed version.',
  stale: 'A newer release was verified since this download. Check for updates again.',
  notHere: 'Agent Inbox cannot install updates from the app here. Use Review release instead.',
  changed: 'The downloaded update changed on disk, so it was removed. Download it again.',
})
const MAX_INSTALL_MESSAGE_LENGTH = 240
// Copy shown to the renderer must never carry a path: no slashes, no control characters.
const UNSAFE_MESSAGE_RE = /[\u0000-\u001f\u007f/\\]/
// Helper exit codes (INSTALL_HELPER_EXIT in update-install.cjs) with a known cause.
const PERMISSION_EXIT_CODES = new Set([70, 71])
const TIMED_OUT_EXIT_CODE = 75
const REFUSED_EXIT_CODE = 65

// What the next app start says about an install that left it on its old version.
function attemptNotice(outcome, runningVersion) {
  let cause = ''
  if (PERMISSION_EXIT_CODES.has(outcome.exitCode)) {
    cause = outcome.platform === 'darwin'
      ? 'macOS did not allow replacing the app. '
      : 'The system did not allow replacing the app. '
  } else if (outcome.exitCode === TIMED_OUT_EXIT_CODE) {
    cause = 'The old app did not quit in time. '
  } else if (outcome.exitCode === REFUSED_EXIT_CODE) {
    cause = 'The app\'s folder changed before the update could replace it. '
  }
  return `Version ${outcome.to} could not be installed, so Agent Inbox is still on ${runningVersion}. ${cause}You can install it manually from the release page.`
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

function sameRecord(left, right) {
  return Boolean(
    left
    && right
    && left.path === right.path
    && left.version === right.version
    && left.installStrategy === right.installStrategy
    && left.byteLength === right.byteLength
    && left.sha256 === right.sha256,
  )
}

function safeInstallMessage(message, fallback) {
  if (typeof message !== 'string') return fallback
  const trimmed = message.trim()
  if (trimmed === '' || trimmed.length > MAX_INSTALL_MESSAGE_LENGTH || UNSAFE_MESSAGE_RE.test(trimmed)) return fallback
  return trimmed
}

// Only downloadable strategies take an installer, keyed by the strategy it declares.
function registerInstallers(value, downloader, requestRestart) {
  const installers = new Map()
  if (value === undefined || value === null) return installers
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('installers must be an object')
  for (const [strategy, installer] of Object.entries(value)) {
    if (installer === undefined) continue
    if (!DOWNLOADABLE_STRATEGIES.has(strategy)) throw new TypeError(`no installer can be registered for ${strategy}`)
    if (
      !installer
      || installer.strategy !== strategy
      || typeof installer.feasibility !== 'function'
      || typeof installer.prepare !== 'function'
      || (installer.cleanup !== undefined && typeof installer.cleanup !== 'function')
    ) {
      throw new TypeError(`installer for ${strategy} is invalid`)
    }
    installers.set(strategy, installer)
  }
  if (installers.size > 0) {
    if (downloader === null || typeof downloader.openVerified !== 'function') {
      throw new TypeError('installers need a downloader that can open verified artifacts')
    }
    if (typeof requestRestart !== 'function') throw new TypeError('installers need requestRestart')
  }
  return installers
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
  if (options.isSetupRunning !== undefined && typeof options.isSetupRunning !== 'function') {
    throw new TypeError('isSetupRunning must be a function')
  }
  if (options.isQuitting !== undefined && typeof options.isQuitting !== 'function') {
    throw new TypeError('isQuitting must be a function')
  }
  if (options.isInstallPermitted !== undefined && typeof options.isInstallPermitted !== 'function') {
    throw new TypeError('isInstallPermitted must be a function')
  }
  const attemptStore = options.attemptStore ?? null
  if (attemptStore !== null && ['begin', 'abandon', 'take'].some((name) => typeof attemptStore[name] !== 'function')) {
    throw new TypeError('attemptStore adapter is invalid')
  }
  const notifyInstallFailure = typeof options.notifyInstallFailure === 'function' ? options.notifyInstallFailure : null

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
  const requestRestart = options.requestRestart
  const installers = registerInstallers(options.installers, downloader, requestRestart)
  const isSetupRunning = typeof options.isSetupRunning === 'function' ? options.isSetupRunning : () => false
  const isQuitting = typeof options.isQuitting === 'function' ? options.isQuitting : () => false
  const isInstallPermitted = typeof options.isInstallPermitted === 'function' ? options.isInstallPermitted : () => true

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
  // An install claims the controller from its first synchronous step until it
  // settles; once commit() resolves, nothing else may run until the app quits.
  let installOperation = null
  let installCommitted = false
  // A previous attempt that left this app on its old version: { version, text }.
  // It rides on every published state until that release stops being offered
  // or a new install starts.
  let installNotice = null
  // The install-failed state on screen is main's refusal of a window it has not
  // bound (refuseInstall), not an install that failed. Once main lets the window
  // install again, the verified download is offered as before (#216).
  let windowRefusal = false

  // Whether main would let its window install this offer now (#216), so
  // Settings never offers an install main would refuse.
  function installPermittedFor(available) {
    if (available.installable !== true) return false
    try {
      return isInstallPermitted() === true
    } catch {
      return false
    }
  }

  function publish(next) {
    if (next.status !== 'install-failed') windowRefusal = false
    const available = next.available
      ? Object.freeze({
          ...next.available,
          installPermitted: installPermittedFor(next.available),
          target: Object.freeze({ ...next.available.target }),
        })
      : undefined
    const download = next.download ? Object.freeze({ ...next.download }) : undefined
    const { available: _available, download: _download, installNotice: _installNotice, ...rest } = next
    state = Object.freeze({
      ...rest,
      ...(available ? { available } : {}),
      ...(download ? { download } : {}),
      ...(installNotice !== null ? { installNotice: installNotice.text } : {}),
    })
    emit(state)
    return state
  }

  function installBusy() {
    return installOperation !== null || installCommitted
  }

  // A verified file is kept while the download is verified and across a failed
  // or refused install, so Try again can reuse it.
  function holdsVerifiedFile() {
    return (state.status === 'verified' || state.status === 'install-failed') && verifiedArtifact !== null
  }

  function prune(pruneOptions) {
    if (downloader === null || installBusy()) return
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

  function installState(status, available, message) {
    return {
      status,
      currentVersion,
      automaticChecks: state.automaticChecks,
      checkedAt: state.checkedAt,
      message,
      available,
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
        installable: available.installable === true,
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
            installable: false,
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

  // Never rejects: an installer that throws or answers malformed is "not here".
  async function feasibilityFor(installer, target) {
    try {
      const result = await installer.feasibility(Object.freeze({
        version: target.version,
        ...(target.minimumSystemVersion !== undefined ? { minimumSystemVersion: target.minimumSystemVersion } : {}),
      }))
      if (result?.ok === true) return { ok: true }
      return { ok: false, message: safeInstallMessage(result?.message, INSTALL_MESSAGES.notHere) }
    } catch {
      return { ok: false, message: INSTALL_MESSAGES.notHere }
    }
  }

  // With an installer registered, an offer downloads only when that installer
  // can install it here; otherwise it is notify-only and says why.
  async function evaluateOffer(checked) {
    if (checked.state.status !== 'available') return checked
    const installer = checked.artifact === null ? undefined : installers.get(checked.artifact.installStrategy)
    if (installer === undefined) return checked
    const feasible = await feasibilityFor(installer, checked.artifact)
    if (feasible.ok) {
      checked.state.available.installable = true
      return checked
    }
    return {
      artifact: null,
      state: {
        ...checked.state,
        message: feasible.message,
        available: { ...checked.state.available, downloadable: false, installable: false, reason: feasible.message },
      },
    }
  }

  // A re-check that confirms the exact verified artifact keeps it; anything
  // else (a newer release, no release, a notify-only target) discards it.
  // `stale` is not evidence about a download: release information below the
  // high-water mark comes only from a serving path that is behind (#148), so,
  // like a failed check, it never prunes or forgets the offer, and a verified
  // file stays on screen with only its check time refreshed.
  function settleCheck(checked) {
    const next = checked.state
    const keepVerified = holdsVerifiedFile()
    if (next.status === 'stale') {
      if (!keepVerified) return publish(next)
      return publish({ ...state, automaticChecks: next.automaticChecks, checkedAt: next.checkedAt })
    }
    // The explanation stays with the release it is about.
    if (
      installNotice !== null
      && (next.status === 'current' || (next.status === 'available' && next.available.version !== installNotice.version))
    ) {
      installNotice = null
    }
    if (keepVerified && next.status === 'available' && sameArtifact(artifact, checked.artifact)) {
      return publish({ ...state, automaticChecks: next.automaticChecks, checkedAt: next.checkedAt })
    }
    verifiedArtifact = null
    artifact = checked.artifact
    prune({ keep: next.status === 'available' ? artifact : null, currentVersion })
    return publish(next)
  }

  function runCheck(mode) {
    // The running download already belongs to a release verified moments ago,
    // and an install owns the controller until the app quits.
    if (state.status === 'downloading' || installBusy()) return Promise.resolve(state)
    if (inFlight !== null) {
      if (mode === 'scheduled') inFlight.scheduledRequested = true
      return inFlight.promise
    }

    const operation = { scheduledRequested: mode === 'scheduled', promise: null }
    operation.promise = (async () => {
      let prefs
      // A verified download stays on screen while it is re-confirmed.
      const quiet = holdsVerifiedFile()
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
        const checked = await evaluateOffer(safeCheckerState(candidate, latestPreferences.automaticChecks))
        if (checked.state.status === 'available' && operation.scheduledRequested && latestPreferences.automaticChecks) {
          await notifyAvailable(checked.state.available, latestPreferences)
        }
        return settleCheck(checked)
      } catch {
        if (quiet && holdsVerifiedFile()) return state
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
      || installBusy()
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

  // The installer and verified file behind an installable download on screen.
  function installTarget() {
    if (!holdsVerifiedFile() || state.available?.installable !== true) return null
    const installer = installers.get(verifiedArtifact.installStrategy)
    if (installer === undefined || state.available.version !== verifiedArtifact.version) return null
    return { installer, record: verifiedArtifact, available: state.available }
  }

  // Another app process sharing userData may have raised the mark since the offer.
  async function highWaterMark() {
    let mark = highestVerifiedVersion
    if (trustState !== null) {
      try {
        const stored = (await trustState.read()).highestVerifiedVersion
        if (typeof stored === 'string' && VERSION_RE.test(stored) && (mark === null || isNewerVersion(stored, mark))) {
          mark = stored
        }
      } catch {
        // An unreadable file leaves this session's mark in force.
      }
    }
    return mark
  }

  function setupRunning() {
    try {
      return Boolean(isSetupRunning())
    } catch {
      return true
    }
  }

  // Once the app has begun to quit, no new install starts (#205's beginAppQuit()).
  function appQuitting() {
    try {
      return Boolean(isQuitting())
    } catch {
      return true
    }
  }

  async function runInstall(operation, installer, record, available) {
    const { signal } = operation.controller
    let prepared = null
    let dropDownload = false
    const refuse = (message) => publish(installState('install-failed', available, message))
    try {
      if (inFlight !== null) return refuse(INSTALL_MESSAGES.checking)
      if (setupRunning()) return refuse(INSTALL_MESSAGES.setup)
      if (!isNewerVersion(record.version, currentVersion)) return refuse(INSTALL_MESSAGES.notNewer)
      const mark = await highWaterMark()
      if (mark !== null && isNewerVersion(mark, record.version)) return refuse(INSTALL_MESSAGES.stale)
      const feasible = await feasibilityFor(installer, record)
      if (!feasible.ok) return refuse(feasible.message)
      if (signal.aborted) return refuse(INSTALL_MESSAGES.cancelled)

      installNotice = null
      publish(installState('installing', available, `Installing version ${available.version}. Agent Inbox will restart when it is ready.`))
      let opened
      try {
        opened = await downloader.openVerified(record)
      } catch (error) {
        dropDownload = true
        throw error
      }
      try {
        if (!sameRecord(opened?.record, record)) {
          dropDownload = true
          throw new Error('reopened artifact does not match the verified download')
        }
        const { handle } = opened
        // Positioned reads only: the installer can neither close nor write the handle.
        const source = Object.freeze({
          record: opened.record,
          handle: Object.freeze({
            read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
            stat: () => handle.stat(),
          }),
        })
        prepared = await installer.prepare(source, { signal })
      } catch (error) {
        if (error?.code === 'not-verified') dropDownload = true
        throw error
      } finally {
        await Promise.resolve().then(() => opened?.close()).catch(() => {})
      }
      if (signal.aborted) throw new Error('install cancelled')
      // Recorded before the hand-off, so the next start can say what happened;
      // an install that cannot be recorded is not handed off.
      const attempt = attemptStore === null
        ? null
        : await attemptStore.begin({ from: currentVersion, to: record.version, strategy: record.installStrategy })
      // A quit while the record was being written still stops the install.
      if (signal.aborted) {
        if (attempt !== null) await Promise.resolve().then(() => attemptStore.abandon()).catch(() => {})
        throw new Error('install cancelled')
      }
      operation.committing = true
      try {
        await prepared.commit(attempt === null ? undefined : { resultPath: attempt.resultPath })
      } catch (error) {
        if (attempt !== null) await Promise.resolve().then(() => attemptStore.abandon()).catch(() => {})
        throw error
      }
      installCommitted = true
      try {
        requestRestart()
      } catch {
        // The helper still waits for this process to exit.
      }
      return state
    } catch {
      if (prepared !== null && !installCommitted) {
        await Promise.resolve().then(() => prepared.discard()).catch(() => {})
      }
      if (dropDownload) {
        verifiedArtifact = null
        return publish({
          ...downloadState('download-failed', available, 0, record.byteLength),
          message: INSTALL_MESSAGES.changed,
        })
      }
      return refuse(signal.aborted ? INSTALL_MESSAGES.cancelled : INSTALL_MESSAGES.failed)
    } finally {
      if (installOperation === operation) installOperation = null
      if (dropDownload) prune({ keep: null, currentVersion })
    }
  }

  // User-initiated; never rejects. Claims the controller synchronously so no
  // check, download or second install can interleave with it.
  function installNow() {
    if (disposed || appQuitting() || installBusy() || downloadOperation !== null) return Promise.resolve(state)
    const target = installTarget()
    if (target === null) return Promise.resolve(state)
    // Whatever this attempt publishes is about the install, not main's refusal.
    windowRefusal = false
    const operation = { controller: new AbortController(), committing: false, promise: null }
    installOperation = operation
    operation.promise = runInstall(operation, target.installer, target.record, target.available)
      .catch(() => state)
    return operation.promise
  }

  // Reads and deletes the previous attempt once, and only in an instance that
  // can install (another instance sharing userData must not consume it). An app
  // still older than the release it tried to install says so, unless the helper
  // reported success (this copy was restored by hand, or is a second copy).
  async function reportPreviousAttempt() {
    if (attemptStore === null || installers.size === 0) return
    let outcome = null
    try {
      outcome = await attemptStore.take()
    } catch {
      return
    }
    if (!outcome || typeof outcome.to !== 'string' || !VERSION_RE.test(outcome.to)) return
    if (outcome.exitCode === 0 || !isNewerVersion(outcome.to, currentVersion)) return
    const text = attemptNotice(outcome, currentVersion)
    installNotice = { version: outcome.to, text }
    publish({ ...state, message: text })
    if (notifyInstallFailure === null) return
    try {
      await notifyInstallFailure({ version: outcome.to, currentVersion, message: text })
    } catch {
      // Notification delivery is best-effort; Settings → Updates still says it.
    }
  }

  return Object.freeze({
    getState() {
      return state
    },
    async rendererReady() {
      if (disposed) return state
      rendererIsReady = true
      if (!startupPruned && !installBusy()) {
        startupPruned = true
        // Before any cleanup, so nothing about the last attempt is lost.
        await reportPreviousAttempt()
        prune({ currentVersion })
        for (const installer of installers.values()) {
          if (typeof installer.cleanup !== 'function') continue
          Promise.resolve()
            .then(() => installer.cleanup())
            .catch(() => {})
        }
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
      if (installBusy()) return state
      if (downloadOperation !== null && downloader !== null) await downloader.cancel()
      return state
    },
    installNow,
    // Aborts an install that has not reached commit() and resolves once it has
    // settled; a commit that already started is left to finish.
    async cancelInstall() {
      const operation = installOperation
      if (operation === null) return state
      if (!operation.committing) operation.controller.abort()
      await operation.promise
      return state
    },
    // Main's own refusal (an unauthorized window) as a clear state that keeps the download.
    refuseInstall(message) {
      if (disposed || installBusy() || installTarget() === null) return state
      const refused = publish(installState('install-failed', state.available, safeInstallMessage(message, INSTALL_MESSAGES.failed)))
      windowRefusal = true
      return refused
    },
    // Main's window gained or lost its install grant (#216): republish the offer
    // when that changes what Settings may show. A window main refused that may
    // install again gets the verified download back, not a stale refusal.
    refreshInstallPermission() {
      if (disposed || !state.available) return state
      const permitted = installPermittedFor(state.available)
      if (windowRefusal && permitted && holdsVerifiedFile()) {
        const { byteLength } = verifiedArtifact
        return publish(downloadState('verified', state.available, byteLength, byteLength))
      }
      if (state.available.installPermitted === permitted) return state
      return publish({ ...state })
    },
    isInstalling() {
      return installBusy()
    },
    // The install steps' seam: the verified file behind a 'verified' state,
    // kept across a failed or refused install.
    getVerifiedArtifact() {
      return holdsVerifiedFile() ? verifiedArtifact : null
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
      // Never touches a committed install: its helper is waiting for this process to exit.
      if (installOperation !== null && !installOperation.committing) installOperation.controller.abort()
    },
  })
}

module.exports = {
  MANUAL_RELEASES_URL,
  createUpdateController,
}
