'use strict'

const fs = require('node:fs')
const path = require('node:path')
const {
  verifyManifest,
  verifyManifestV2,
} = require('./update-manifest.cjs')

// Apps from 1.7.0 on read update-manifest-v2.json (#343). update-manifest.json, the file
// apps from 1.2 to 1.6 read, is read only for the Intel fallback below.
const MANIFEST_URL = 'https://github.com/shariqh/agent-inbox/releases/latest/download/update-manifest.json'
const SIGNATURE_URL = 'https://github.com/shariqh/agent-inbox/releases/latest/download/update-manifest.json.sig'
const MANIFEST_V2_URL = 'https://github.com/shariqh/agent-inbox/releases/latest/download/update-manifest-v2.json'
const SIGNATURE_V2_URL = 'https://github.com/shariqh/agent-inbox/releases/latest/download/update-manifest-v2.json.sig'
const MANIFEST_MAX_BYTES = 256 * 1024
const SIGNATURE_MAX_BYTES = 16 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_REDIRECTS = 5
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const GITHUB_RELEASE_PATH_RE = /^\/shariqh\/agent-inbox\/releases\/(?:latest\/download|download\/v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\/(update-manifest(?:-v2)?\.json(?:\.sig)?)$/
const GITHUB_CONTENT_PATH_RE = /^\/github-production-release-asset(?:-\d+)?\//

class UpdateFetchError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UpdateFetchError'
  }
}

function fail(message) {
  throw new UpdateFetchError(message)
}

function validateFetchUrl(value, expectedAsset) {
  let url
  try {
    url = new URL(value)
  } catch {
    return fail('update endpoint is not a valid URL')
  }
  if (url.protocol !== 'https:') fail('update endpoint must use HTTPS')
  if (url.username !== '' || url.password !== '') fail('update endpoint must not contain credentials')
  if (url.hash !== '') fail('update endpoint must not contain a fragment')

  if (url.hostname === 'github.com') {
    if (url.port !== '' || url.search !== '') fail('GitHub update endpoint is not canonical')
    const match = GITHUB_RELEASE_PATH_RE.exec(url.pathname)
    if (!match || match[1] !== expectedAsset) fail('GitHub update endpoint is outside the expected release path')
    return url
  }

  const isGithubContent = (
    url.hostname.endsWith('.githubusercontent.com')
    && url.hostname.length > '.githubusercontent.com'.length
  )
  if (!isGithubContent || url.port !== '' || !GITHUB_CONTENT_PATH_RE.test(url.pathname)) {
    fail('update endpoint is outside the trusted release asset hosts')
  }
  return url
}

function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

function contentLength(response, cap) {
  const raw = response.headers?.get?.('content-length')
  if (raw === null || raw === undefined) return
  if (!/^(0|[1-9]\d*)$/.test(raw)) fail('update response has an invalid Content-Length')
  const length = Number(raw)
  if (!Number.isSafeInteger(length) || length > cap) fail('update response exceeds its size limit')
}

function cancelBody(body) {
  if (!body || typeof body.cancel !== 'function') return
  try {
    Promise.resolve(body.cancel()).catch(() => {})
  } catch {
    // Fetch may have already torn down the response after its signal aborted.
  }
}

function withAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(new UpdateFetchError('update request timed out'))
  return new Promise((resolve, reject) => {
    const abort = () => reject(new UpdateFetchError('update request timed out'))
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

async function readCappedBody(response, cap, signal) {
  try {
    contentLength(response, cap)
  } catch (error) {
    cancelBody(response.body)
    throw error
  }
  if (!response.body) return Buffer.alloc(0)

  const chunks = []
  let total = 0
  const append = (value) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    total += chunk.length
    if (total > cap) fail('update response exceeds its streaming size limit')
    chunks.push(chunk)
  }

  if (typeof response.body.getReader === 'function') {
    const reader = response.body.getReader()
    let complete = false
    try {
      while (true) {
        const { done, value } = await withAbort(reader.read(), signal)
        if (done) {
          complete = true
          break
        }
        if (value !== undefined) append(value)
      }
    } finally {
      if (!complete || signal.aborted) {
        try {
          reader.cancel?.().catch?.(() => {})
        } catch {
          // The response may already have been cancelled by fetch's signal.
        }
      }
      try {
        reader.releaseLock?.()
      } catch {
        // A cancelled implementation may retain its lock until cancellation settles.
      }
    }
  } else if (typeof response.body[Symbol.asyncIterator] === 'function') {
    const iterator = response.body[Symbol.asyncIterator]()
    let complete = false
    try {
      while (true) {
        const { done, value } = await withAbort(iterator.next(), signal)
        if (done) {
          complete = true
          break
        }
        append(value)
      }
    } finally {
      if (!complete || signal.aborted) {
        try {
          Promise.resolve(iterator.return?.()).catch(() => {})
        } catch {
          // The iterator may already have been closed by fetch's signal.
        }
      }
    }
  } else {
    cancelBody(response.body)
    fail('update response body is not stream-readable')
  }
  return Buffer.concat(chunks, total)
}

async function fetchAsset({ fetchImpl, initialUrl, expectedAsset, cap, signal }) {
  let current = validateFetchUrl(initialUrl, expectedAsset)
  let redirects = 0

  while (true) {
    let response
    try {
      response = await fetchImpl(current.href, {
        redirect: 'manual',
        signal,
        headers: { 'cache-control': 'no-cache' },
      })
    } catch (error) {
      if (signal.aborted) fail('update request timed out')
      fail('update request failed')
    }

    if (isRedirect(response.status)) {
      cancelBody(response.body)
      if (redirects >= MAX_REDIRECTS) fail('update request exceeded its redirect limit')
      const location = response.headers?.get?.('location')
      if (!location) fail('update redirect is missing a Location header')
      let next
      try {
        next = new URL(location, current)
      } catch {
        fail('update redirect Location is invalid')
      }
      current = validateFetchUrl(next, expectedAsset)
      redirects += 1
      continue
    }

    if (response.status < 200 || response.status >= 300) {
      cancelBody(response.body)
      fail('update endpoint did not return a successful response')
    }
    return readCappedBody(response, cap, signal)
  }
}

function versionParts(version, label) {
  const match = VERSION_RE.exec(version)
  if (!match) fail(`${label} must be an exact stable X.Y.Z version`)
  return [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])]
}

function compareVersions(left, right) {
  const a = versionParts(left, 'version')
  const b = versionParts(right, 'currentVersion')
  for (let index = 0; index < 3; index += 1) {
    if (a[index] > b[index]) return 1
    if (a[index] < b[index]) return -1
  }
  return 0
}

function canonicalAbsolute(value) {
  return typeof value === 'string' && value !== '' && path.isAbsolute(value) && path.resolve(value) === value
    ? value
    : null
}

// What the AppImage proof reads from this machine; tests inject their own.
const SYSTEM_PROBE = Object.freeze({
  lstat: (target) => fs.lstatSync(target, { bigint: true }),
  mountInfo: () => fs.readFileSync('/proc/self/mountinfo', 'utf8'),
})

// /proc/self/mountinfo escapes space, tab, newline and backslash as \ooo.
function mountInfoField(value) {
  return value.replace(/\\([0-7]{3})/g, (_escape, octal) => String.fromCharCode(Number.parseInt(octal, 8)))
}

// The type and source of the mount visible at `mountPoint`: the last one listed,
// since a later mount at the same point hides the earlier ones.
function mountAt(mountInfo, mountPoint) {
  let visible = null
  for (const line of mountInfo.split('\n')) {
    const fields = line.split(' ')
    // ID, parent, dev, root, mount point, options, optional fields…, '-', type, source, super options
    const separator = fields.indexOf('-', 6)
    if (separator === -1 || separator + 2 >= fields.length) continue
    if (mountInfoField(fields[4]) !== mountPoint) continue
    visible = { type: mountInfoField(fields[separator + 1]), source: mountInfoField(fields[separator + 2]) }
  }
  return visible
}

// APPDIR must be the pinned type2-runtime's FUSE mount of the file APPIMAGE
// names. A mount point has another device than its parent, so an extracted
// squashfs-root (or an extract-and-run folder) fails here. The runtime passes
// no fsname or subtype, so libfuse names the mount after the image's real file
// name: type fuse.<name>, source <name>, as a mount by hand of a different
// image would not be.
function mountsImage(image, mount, probe) {
  try {
    const mounted = probe.lstat(mount)
    if (!mounted.isDirectory() || mounted.dev === probe.lstat(path.dirname(mount)).dev) return false
    const visible = mountAt(probe.mountInfo(), mount)
    const name = path.basename(image)
    return visible !== null && visible.type === `fuse.${name}` && visible.source === name
  } catch {
    return false
  }
}

// A Linux app runs from its AppImage only when APPIMAGE names an image, the
// executable sits inside APPDIR, and APPDIR is that image's runtime mount. A .deb
// install started from inside another AppImage inherits both variables but runs
// from /opt, and an extracted squashfs-root started there gets a plain-folder
// APPDIR from our AppRun, so both keep the deb target. The AppImage installer
// and its registration in main apply this same proof.
function runsFromAppImage({ appImagePath, appDir, execPath, appImageProbe = SYSTEM_PROBE } = {}) {
  const image = canonicalAbsolute(appImagePath)
  const mount = canonicalAbsolute(appDir)
  const executable = canonicalAbsolute(execPath)
  if (image === null || mount === null || executable === null || mount === path.parse(mount).root) return false
  const relative = path.relative(mount, executable)
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false
  return mountsImage(image, mount, appImageProbe)
}

function findTarget(manifest, platform, architecture, packageType) {
  return manifest.targets.find((target) => (
    target.platform === platform
    && target.architecture === architecture
    && target.packageType === packageType
  )) ?? null
}

// On macOS an arm64 process takes the arm64 DMG when the manifest lists one, and any
// process takes the universal DMG next. A manifest that lists only an arm64 DMG yields it
// whatever the process, and checkForUpdate never offers it to a process that isn't arm64.
function selectTarget(manifest, options) {
  const packaged = options.isPackaged === true
  const supportedArch = options.arch === 'x64' || options.arch === 'arm64'
  if (!packaged || !supportedArch) return null
  if (options.platform === 'darwin') {
    return (options.arch === 'arm64' ? findTarget(manifest, 'darwin', 'arm64', 'dmg') : null)
      ?? findTarget(manifest, 'darwin', 'universal', 'dmg')
      ?? findTarget(manifest, 'darwin', 'arm64', 'dmg')
  }
  if (options.platform === 'linux') {
    return findTarget(manifest, 'linux', options.arch, runsFromAppImage(options) ? 'appimage' : 'deb')
  }
  return null
}

function baseState(status, options, checkedAt, message) {
  return {
    status,
    currentVersion: options.currentVersion,
    automaticChecks: options.automaticChecks === true,
    checkedAt,
    message,
  }
}

// Rollback high-water marks (#148), one per manifest (#343): record the just-verified
// version in its manifest's mark and read back the mark the stale decision uses, in one
// step: the v1 mark for update-manifest.json, the higher of both marks for v2.
async function recordHighWater(options, verifiedVersion, manifest) {
  if (typeof options.recordVerifiedVersion !== 'function') return null
  const highWater = await options.recordVerifiedVersion(verifiedVersion, manifest)
  if (highWater === null || highWater === undefined) return null
  versionParts(highWater, 'high-water mark')
  return highWater
}

const MANIFESTS = Object.freeze({
  v1: Object.freeze({ url: MANIFEST_URL, signatureUrl: SIGNATURE_URL, name: 'update-manifest.json', verify: verifyManifest }),
  v2: Object.freeze({ url: MANIFEST_V2_URL, signatureUrl: SIGNATURE_V2_URL, name: 'update-manifest-v2.json', verify: verifyManifestV2 }),
})

// Fetches one manifest pair from the latest release and verifies it: any failure throws.
async function readManifest(options, which, signal, now) {
  const manifest = MANIFESTS[which]
  const manifestBytes = await fetchAsset({
    fetchImpl: options.fetchImpl,
    initialUrl: manifest.url,
    expectedAsset: manifest.name,
    cap: MANIFEST_MAX_BYTES,
    signal,
  })
  const signatureBytes = await fetchAsset({
    fetchImpl: options.fetchImpl,
    initialUrl: manifest.signatureUrl,
    expectedAsset: `${manifest.name}.sig`,
    cap: SIGNATURE_MAX_BYTES,
    signal,
  })
  return manifest.verify({ manifestBytes, envelope: signatureBytes, registry: options.registry, now })
}

function staleState(options, checkedAt) {
  return baseState('stale', options, checkedAt, 'Update information is older than a release this app already verified.')
}

// An offer of `target`, remembering which manifest it came from (#343): the controller
// checks an install against that manifest's mark.
function offerState(options, checkedAt, manifest, verified, target) {
  return {
    ...baseState('available', options, checkedAt, 'A verified update is available.'),
    manifest,
    available: {
      version: verified.version,
      tag: verified.tag,
      releaseUrl: verified.releaseUrl,
      target: {
        packageType: target.packageType,
        installStrategy: target.installStrategy,
      },
    },
    // Main-process only: the downloader needs the signed URL, length and digest,
    // which the renderer-facing state deliberately never carries.
    ...(options.includeArtifact === true
      ? { artifact: Object.freeze({ version: verified.version, tag: verified.tag, ...target }) }
      : {}),
  }
}

// The v2 manifest offers only an arm64 DMG, and this process is not arm64: an Intel Mac,
// or an Apple silicon Mac running the app under Rosetta (design §6.2). update-manifest.json
// names the newest universal release, which this Mac can install when it is newer. When it
// isn't, the offer is blocked, with no artifact. A v1 read that fails throws and a stale one
// returns stale, so a verified download already on screen is never dropped.
async function intelFallback(options, signal, now, checkedAt, v2) {
  const v1 = await readManifest(options, 'v1', signal, now)
  const highWater = await recordHighWater(options, v1.version, 'v1')
  if (highWater !== null && compareVersions(v1.version, highWater) < 0) return staleState(options, checkedAt)
  if (compareVersions(v1.version, options.currentVersion) > 0) {
    return offerState(options, checkedAt, 'v1', v1, findTarget(v1, 'darwin', 'universal', 'dmg'))
  }
  return {
    ...baseState('available', options, checkedAt, 'A verified update is available.'),
    manifest: 'v2',
    available: {
      version: v2.version,
      tag: v2.tag,
      releaseUrl: v2.releaseUrl,
      target: { packageType: 'dmg', installStrategy: 'macos-dmg' },
      // `translated` (app.runningUnderARM64Translation) only chooses the copy.
      blocked: options.translated === true ? 'rosetta' : 'apple-silicon',
    },
  }
}

async function checkForUpdate(options) {
  if (!options || typeof options.fetchImpl !== 'function') fail('fetchImpl is required')
  versionParts(options.currentVersion, 'currentVersion')
  const now = typeof options.now === 'function' ? options.now() : new Date()
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail('now must return a valid Date')
  const checkedAt = now.toISOString()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail('timeoutMs must be positive')
  const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout
  const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout
  const controller = new AbortController()
  const deadline = setTimeoutImpl(() => controller.abort(), timeoutMs)
  deadline?.unref?.()

  try {
    const manifest = await readManifest(options, 'v2', controller.signal, now)
    const highWater = await recordHighWater(options, manifest.version, 'v2')
    if (highWater !== null && compareVersions(manifest.version, highWater) < 0) return staleState(options, checkedAt)
    const target = selectTarget(manifest, options)
    if (!target) {
      return baseState(
        'unsupported',
        options,
        checkedAt,
        'Automatic updates are not supported for this installation.',
      )
    }
    if (compareVersions(manifest.version, options.currentVersion) <= 0) {
      return baseState('current', options, checkedAt, 'Agent Inbox is up to date.')
    }
    if (target.platform === 'darwin' && target.architecture === 'arm64' && options.arch !== 'arm64') {
      return await intelFallback(options, controller.signal, now, checkedAt, manifest)
    }
    return offerState(options, checkedAt, 'v2', manifest, target)
  } catch (error) {
    controller.abort()
    throw error
  } finally {
    clearTimeoutImpl(deadline)
  }
}

module.exports = {
  MANIFEST_URL,
  SIGNATURE_URL,
  MANIFEST_V2_URL,
  SIGNATURE_V2_URL,
  checkForUpdate,
  runsFromAppImage,
}
