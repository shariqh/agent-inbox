const { existsSync, lstatSync, readFileSync, realpathSync } = require('node:fs')
const { isAbsolute, join, resolve, sep } = require('node:path')
const { runTrustedSetup } = require('./setup-core.cjs')
const { createSetupProcessRunner } = require('./setup-process.cjs')
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

// The only two release-runtime keys issue #74 ships. Selection is STRICT —
// `${process.platform}-${process.arch}` only, never `uname`, never a Rosetta
// (x64-under-arm64) fallback. An unsupported host simply gets no payload.
const RUNTIME_KEYS = new Set(['darwin-arm64', 'darwin-x64'])
const RELEASE_KEYS = Object.freeze([...RUNTIME_KEYS])
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
 *     one of the two shipped architectures. No `uname`, no Rosetta fallback.
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
    id: 'darwin-shell-v1',
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
  installerRepoRoot,
  isTrustedSetupSender,
  readSetupInfo,
  runAgentInstall,
  runtimeKey,
  selectRuntimePayload,
}
