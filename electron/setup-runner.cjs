const { existsSync, lstatSync, readFileSync, realpathSync } = require('node:fs')
const { isAbsolute, join, resolve, sep } = require('node:path')
const { runTrustedSetup } = require('./setup-core.cjs')
const { createSetupProcessRunner } = require('./setup-process.cjs')
const { POSIX_SETUP_RUNTIME_KEYS } = require('./runtime-targets.cjs')
const {
  EXPECTED_NODE_MAJOR,
  EXPECTED_NODE_MODULES_ABI,
  EXPECTED_PRODUCT,
  REQUIRED_ENTRYPOINTS,
  REQUIRED_FILES,
  verifyRuntimePayload,
} = require('./runtime-verify.cjs')

const TARGETS = new Set(['all', 'claude', 'copilot'])
const TARGET_NAMES = Object.freeze([...TARGETS])

// Setup is available only for the four targets handled by the fixed-purpose
// POSIX shell adapter. Selection is STRICT `${process.platform}-${process.arch}`
// only: never uname, cross-architecture fallback, or Windows execution.
const RUNTIME_KEYS = new Set(POSIX_SETUP_RUNTIME_KEYS)
const RELEASE_KEYS = POSIX_SETUP_RUNTIME_KEYS
const DIGEST_RE = /^(sha256:)?[0-9a-f]{64}$/i

function runtimeKey(platform, arch) {
  return `${platform}-${arch}`
}

/** Read setup-info.json fail-open — a missing or corrupt file is simply "no info". */
function readSetupInfo(appRoot) {
  const bakedPath = join(appRoot, 'setup-info.json')
  if (!existsSync(bakedPath)) return null
  try {
    const raw = JSON.parse(readFileSync(bakedPath, 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
  } catch {
    return null
  }
}

function normalizeDigest(digest) {
  if (typeof digest !== 'string' || !DIGEST_RE.test(digest)) return null
  return digest.replace(/^sha256:/i, '').toLowerCase()
}

function nodeMajor(version) {
  const match = typeof version === 'string' ? /^v?(\d+)\.\d+\.\d+(?:[-+].*)?$/.exec(version) : null
  return match ? Number(match[1]) : null
}

/**
 * Select and verify the EXACT runtime payload DIRECTORY for this host from a
 * release `setup-info.json` (issue #74). Every failure mode returns a
 * distinct `reason` instead of silently falling back to something else:
 *
 *   - 'no-release-payloads' — this is a dev/legacy bundle (no `runtimePayloads`
 *     map at all); callers should fall back to the dev-checkout path untouched.
 *   - 'unsupported-platform' — this host's `${platform}-${arch}` key is not
 *     one of the four POSIX Setup architectures. No `uname` or arch fallback.
 *   - 'missing-payload' — the map exists but has no entry for this key.
 *   - 'invalid-path' — the payload's `path` is absolute, empty, or contains a
 *     `..` traversal segment.
 *   - 'invalid-digest' — the payload's `digest` is not a well-formed SHA-256.
 *   - 'not-found' — nothing exists at the resolved path.
 *   - 'not-contained' — the resolved (or its REAL, symlink-followed) path
 *     escapes `appRoot` — including a symlinked payload directory used to
 *     point outside the app bundle.
 *   - 'symlinked-payload' — the payload directory entry itself (or its
 *     `runtime-manifest.json`) is a symlink. Rejected outright, regardless of
 *     where it resolves — a real directory is required, never a link to one.
 *   - 'not-a-directory' — the resolved path exists but is not a directory.
 *   - 'missing-manifest' — no `runtime-manifest.json` inside the directory.
 *   - 'invalid-manifest' — the manifest is not parseable JSON, or is missing
 *     the `platform`/`arch` fields this function needs to validate.
 *   - 'digest-mismatch' — the manifest file's actual SHA-256 does not match
 *     the digest baked into `setup-info.json`.
 *   - 'manifest-mismatch' — the manifest's own `platform`/`arch` do not match
 *     the `${platform}-${arch}` key it was selected under.
 *   - 'payload-integrity' — a manifested file is missing/tampered, its mode
 *     changed, an extra file or symlink exists, or the file list/digest/runtime
 *     identity cannot be re-derived exactly.
 *   - 'missing-installer' — the payload directory has no
 *     `scripts/install-agents.sh` to run.
 *
 * On success, `path` is the verified runtime payload DIRECTORY (never a single
 * file) — the same directory a release install both runs its installer from
 * and reports back to `electron/main.cjs` as the repoRoot/script root.
 */
function selectRuntimePayload({
  appRoot,
  platform = process.platform,
  arch = process.arch,
  info = readSetupInfo(appRoot),
} = {}) {
  const key = runtimeKey(platform, arch)
  const payloads = info && typeof info === 'object' ? info.runtimePayloads : null
  if (!payloads || typeof payloads !== 'object') {
    return { ok: false, reason: 'no-release-payloads', key }
  }
  if (!RUNTIME_KEYS.has(key)) {
    return { ok: false, reason: 'unsupported-platform', key }
  }
  const payload = payloads[key]
  if (!payload || typeof payload !== 'object') {
    return { ok: false, reason: 'missing-payload', key }
  }
  const packageVersion = typeof info.version === 'string' && info.version.trim() ? info.version : null
  if (!packageVersion) return { ok: false, reason: 'invalid-release-identity', key }

  const relPath = payload.path
  if (typeof relPath !== 'string' || !relPath || isAbsolute(relPath)) {
    return { ok: false, reason: 'invalid-path', key }
  }
  if (relPath.split(/[\\/]+/).some((segment) => segment === '..')) {
    return { ok: false, reason: 'invalid-path', key }
  }

  const digest = normalizeDigest(payload.digest)
  if (!digest) {
    return { ok: false, reason: 'invalid-digest', key }
  }

  let realRoot
  try {
    realRoot = realpathSync(appRoot)
  } catch {
    return { ok: false, reason: 'not-found', key }
  }
  const root = resolve(appRoot)
  const resolved = resolve(appRoot, relPath)
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    return { ok: false, reason: 'not-contained', key }
  }
  if (!existsSync(resolved)) {
    return { ok: false, reason: 'not-found', key }
  }
  // The payload directory ENTRY itself must not be a symlink — rejected
  // outright regardless of where it resolves, never merely trusted because
  // the pre-symlink join looked contained.
  let topStat
  try {
    topStat = lstatSync(resolved)
  } catch {
    return { ok: false, reason: 'not-found', key }
  }
  if (topStat.isSymbolicLink()) {
    return { ok: false, reason: 'symlinked-payload', key }
  }

  let realResolved
  try {
    realResolved = realpathSync(resolved)
  } catch {
    return { ok: false, reason: 'not-found', key }
  }
  // Containment is checked on the REAL path too — this is what catches an
  // ancestor symlink (not the payload entry itself) that escapes appRoot.
  if (realResolved !== realRoot && !realResolved.startsWith(realRoot + sep)) {
    return { ok: false, reason: 'not-contained', key }
  }
  let verified
  try {
    verified = verifyRuntimePayload({
      root: realResolved,
      expectedManifestDigest: `sha256:${digest}`,
      expectedPlatform: platform,
      expectedArch: arch,
      expectedProduct: EXPECTED_PRODUCT,
      expectedPackageVersion: packageVersion,
      expectedNodeMajor: EXPECTED_NODE_MAJOR,
      expectedNodeModulesAbi: EXPECTED_NODE_MODULES_ABI,
      requiredEntrypoints: REQUIRED_ENTRYPOINTS,
      requiredFiles: REQUIRED_FILES,
    })
  } catch (err) {
    return { ok: false, reason: err?.code ?? 'payload-integrity', key }
  }

  if (!existsSync(installerPath(realResolved))) {
    return { ok: false, reason: 'missing-installer', key }
  }

  return {
    ok: true,
    key,
    path: realResolved,
    relativePath: relPath,
    digest: `sha256:${digest}`,
    manifest: verified.manifest,
    packageVersion,
    product: EXPECTED_PRODUCT,
    nodeMajor: EXPECTED_NODE_MAJOR,
    nodeModulesAbi: EXPECTED_NODE_MODULES_ABI,
  }
}

function installerPath(repoRoot) {
  return join(repoRoot, 'scripts', 'install-agents.sh')
}

function installerRepoRoot(appRoot) {
  const bakedPath = join(appRoot, 'setup-info.json')
  if (existsSync(bakedPath)) {
    try {
      const root = JSON.parse(readFileSync(bakedPath, 'utf8')).repoRoot
      if (typeof root === 'string' && isAbsolute(root) && existsSync(installerPath(root))) {
        return resolve(root)
      }
    } catch {
      // Fall through to the development checkout.
    }
  }
  return existsSync(installerPath(appRoot)) ? resolve(appRoot) : null
}

function isTrustedSetupSender(senderUrl, viewerUrl) {
  try {
    return new URL(senderUrl).origin === new URL(viewerUrl).origin
  } catch {
    return false
  }
}

function canRunSetup(senderUrl, viewerUrl, senderId, authorizedWebContentsId) {
  return Number.isInteger(senderId) &&
    senderId === authorizedWebContentsId &&
    isTrustedSetupSender(senderUrl, viewerUrl)
}

function createReleaseSetupAdapter({
  repoRoot,
  processRunner,
}) {
  const host = Object.freeze({
    platform: process.platform,
    arch: process.arch,
    key: runtimeKey(process.platform, process.arch),
  })

  return Object.freeze({
    id: 'posix-shell-v1',
    host,
    releaseKeys: RELEASE_KEYS,
    targets: TARGET_NAMES,
    verify(request) {
      const { selection } = request
      if (realpathSync(selection.sourceRoot) !== realpathSync(repoRoot)) {
        throw new Error('runtime root mismatch')
      }
      const verified = verifyRuntimePayload({
        root: selection.sourceRoot,
        expectedManifestDigest: selection.manifestDigest,
        expectedPlatform: host.platform,
        expectedArch: host.arch,
        expectedProduct: EXPECTED_PRODUCT,
        expectedPackageVersion: selection.packageVersion,
        expectedNodeMajor: EXPECTED_NODE_MAJOR,
        expectedNodeModulesAbi: EXPECTED_NODE_MODULES_ABI,
        requiredEntrypoints: REQUIRED_ENTRYPOINTS,
        requiredFiles: REQUIRED_FILES,
      })
      const { manifest } = verified
      return {
        sourceRoot: selection.sourceRoot,
        manifestDigest: `sha256:${verified.manifestDigest}`,
        packageVersion: manifest.packageVersion,
        product: manifest.product,
        runtimeId: manifest.runtimeId,
        payloadDigest: manifest.payloadDigest,
        platform: manifest.platform,
        arch: manifest.arch,
        nodeMajor: nodeMajor(manifest.nodeVersion),
        nodeModulesAbi: manifest.nodeModulesAbi,
      }
    },
    start(operation, { onCancel }) {
      return processRunner.start({
        repoRoot,
        target: operation.target,
        runtime: {
          sourceRoot: operation.sourceRoot,
          manifestDigest: operation.manifestDigest,
        },
      }, { onCancel })
    },
  })
}

/**
 * The one Setup install in flight, and whether the app has begun to quit
 * (#205 review). Once any quit begins — Cmd+Q, the menu, logout, the last
 * window closing, or an update restart — no install may start: one started
 * then can be killed halfway by the exit, after it removed a registration it
 * was about to replace and before it added the new one. So every path that
 * ends the app calls `beginQuit()` first. It refuses every later install, for
 * good, and cancels the running one, returning a promise (never rejecting)
 * that settles once nothing runs; it may be called again, as `before-quit`
 * fires again, and cancels and waits again while anything still runs.
 */
function createInstallGate() {
  let quitting = false
  let current = null
  return Object.freeze({
    quitting() {
      return quitting
    },
    /** True from the moment an install starts until its promise settles, either way. */
    running() {
      return current !== null
    },
    /**
     * Start one install, `start(onCancel)`, or refuse: 'quitting' once a quit
     * has begun, 'running' while another install runs. A refusal never calls
     * `start`.
     */
    run(start) {
      if (quitting) return { refused: 'quitting' }
      if (current) return { refused: 'running' }
      const entry = { cancel: null, promise: null }
      current = entry
      let started
      try {
        started = Promise.resolve(start((cancel) => { entry.cancel = cancel }))
      } catch (err) {
        started = Promise.reject(err)
      }
      entry.promise = started.finally(() => {
        if (current === entry) current = null
      })
      return { promise: entry.promise }
    },
    beginQuit() {
      quitting = true
      if (!current) return null
      current.cancel?.()
      return current.promise.then(() => undefined, () => undefined)
    },
  })
}

/**
 * Which grants — agent Setup, update installs — one window holds (#216). The
 * window is bound at its first main-frame navigation, because startup has just
 * proven that the viewer is the one this app started (`waitForOwnership()`).
 * Every later main-frame navigation, a reload included, revokes both at once.
 * They come back only after that navigation commits to the viewer origin AND
 * `proveOwnership()` passes again. The proof starts after the commit, so it
 * covers the page the window has just loaded. A newer navigation, a renderer
 * crash or the window closing discards a proof still running; nothing binds
 * once the app has begun to quit (#205), and a closed window never binds again.
 *
 * `setupAllowed()` and `updateAllowed()` say what this app may grant at all;
 * when neither holds, nothing is probed. `apply({ setup, update })` sets the
 * window's grants in main. `settled()` waits out a proof still running, so a
 * question about the grants asked during a reload gets the settled answer.
 */
function createInstallBinding({ viewerUrl, setupAllowed, updateAllowed, isQuitting, proveOwnership, apply }) {
  let loaded = false
  let closed = false
  let navigation = 0
  let awaitingCommit = null
  let inFlight = null
  const grants = () => ({ setup: setupAllowed() === true, update: updateAllowed() === true })
  const mayBind = (url) => !closed && !isQuitting() && isTrustedSetupSender(url, viewerUrl)

  function revoke() {
    navigation += 1
    awaitingCommit = null
    apply({ setup: false, update: false })
  }

  async function rebind(url, proving) {
    let proven = false
    try {
      proven = (await proveOwnership()) === true
    } catch {
      proven = false
    }
    if (!proven || proving !== navigation || !mayBind(url)) return false
    apply(grants())
    return true
  }

  return Object.freeze({
    /** A new document started loading in the main frame (`did-start-navigation`). */
    navigationStarted(url) {
      if (!loaded) {
        loaded = true
        if (mayBind(url)) apply(grants())
        return
      }
      revoke()
      awaitingCommit = navigation
    },
    /**
     * The main frame committed a new document at `url` (`did-navigate`).
     * Resolves true once the window is bound again; a proof that fails or
     * throws resolves false.
     */
    navigationCommitted(url) {
      if (awaitingCommit === null || awaitingCommit !== navigation) return Promise.resolve(false)
      awaitingCommit = null
      const wanted = grants()
      if ((!wanted.setup && !wanted.update) || !mayBind(url)) return Promise.resolve(false)
      const proof = rebind(url, navigation)
      inFlight = proof
      const done = () => {
        if (inFlight === proof) inFlight = null
      }
      proof.then(done, done)
      return proof
    },
    /** Resolves once no proof is in flight, its grants (if any) applied. Never rejects. */
    settled() {
      return inFlight === null ? Promise.resolve() : inFlight.then(() => undefined, () => undefined)
    },
    /** The renderer crashed (`render-process-gone`); the window's next load may bind again. */
    rendererGone: revoke,
    /** The window closed: revoked for good. */
    closed() {
      closed = true
      revoke()
    },
  })
}

function runAgentInstall({
  repoRoot,
  target,
  runtimePayload = null,
  env,
  maxOutput,
  timeoutMs,
  spawnImpl,
  onCancel = () => {},
}) {
  const processRunner = createSetupProcessRunner({ env, maxOutput, timeoutMs, spawnImpl })
  if (!TARGETS.has(target)) {
    return Promise.resolve({
      ok: false,
      exitCode: null,
      output: `Invalid setup target: ${String(target)}`,
      target: String(target),
      timedOut: false,
      cancelled: false,
    })
  }
  const script = installerPath(repoRoot)
  if (!existsSync(script)) {
    return Promise.resolve({
      ok: false,
      exitCode: null,
      output: `Installer not found at ${script}`,
      target,
      timedOut: false,
      cancelled: false,
    })
  }

  if (runtimePayload === null) {
    return processRunner.start({
      repoRoot,
      target,
      runtime: null,
    }, { onCancel })
  }

  const digest = normalizeDigest(runtimePayload?.digest)
  const selection = {
    key: runtimePayload?.key,
    sourceRoot: runtimePayload?.path,
    manifestDigest: digest ? `sha256:${digest}` : runtimePayload?.digest,
    packageVersion: runtimePayload?.packageVersion,
  }
  const adapter = createReleaseSetupAdapter({
    repoRoot,
    processRunner,
  })
  return runTrustedSetup({
    request: { target, selection },
    adapter,
    onCancel,
  })
}

module.exports = {
  canRunSetup,
  createInstallBinding,
  createInstallGate,
  installerRepoRoot,
  isTrustedSetupSender,
  readSetupInfo,
  runAgentInstall,
  runtimeKey,
  selectRuntimePayload,
}
