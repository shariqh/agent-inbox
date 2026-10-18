'use strict'

// Electron-main-only verified update download (#196, part 1). Given the target a
// signed manifest pinned for this host, it streams exactly those bytes from the
// canonical GitHub release URL into a private staging directory, hashing while
// it writes, and publishes the file under its final name only after the signed
// length and SHA-256 both match. It never executes, mounts, opens or installs
// anything: the install steps consume the returned VerifiedArtifact and must
// call verify() again immediately before acting on it.
//
// Layout under `directory` (0700):
//   .staging-XXXXXX/<filename>.part   one private directory per attempt
//   v<version>-<sha256>/<filename>    verified artifacts (file 0600)
// Failure at any point removes the attempt's staging directory, and the final
// name is reached only by rename after verification, so no failure can leave a
// file at a verified path.

const { createHash } = require('node:crypto')
const { constants } = require('node:fs')
const fs = require('node:fs/promises')
const path = require('node:path')
const { TARGET_SPECS, UPDATE_REPOSITORY } = require('./update-manifest.cjs')

const DOWNLOADABLE_STRATEGIES = new Set(['macos-dmg', 'appimage-self-replace'])
// GitHub answers the release URL with a 302 to a signed asset URL. Verified live
// (2026-10): release-assets.githubusercontent.com; objects.githubusercontent.com
// is the previous host. Exact names only: the signed digest is what makes the
// bytes trustworthy, and this list bounds where the app will connect.
const ASSET_HOSTS = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com'])
const ASSET_PATH_RE = /^\/github-production-release-asset(?:-[0-9a-f]{1,16})?\/[^/]/
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const SHA256_RE = /^[0-9a-f]{64}$/
const MACOS_VERSION_RE = /^\d+\.\d+(\.\d+)?$/
const DOWNLOAD_DIR_RE = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-[0-9a-f]{64}$/
const STAGING_PREFIX = '.staging-'
const STAGING_RE = /^\.staging-[A-Za-z0-9]{6}$/
const MAX_REDIRECTS = 5
// A sanity bound above any real package; the signed byteLength is the real cap.
const MAX_ARTIFACT_BYTES = 2 * 1024 ** 3
const MAX_PRUNE_REMOVALS = 16
const MAX_STAGING_ENTRIES_CHECKED = 8
const DEFAULT_STALL_TIMEOUT_MS = 60_000
const DEFAULT_TOTAL_TIMEOUT_MS = 2 * 60 * 60_000
const DEFAULT_STALE_AFTER_MS = 60 * 60_000
const READ_CHUNK_BYTES = 1024 * 1024
const OPEN_READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)

const MESSAGES = Object.freeze({
  'invalid-artifact': 'update artifact is not a verified release target',
  'unsupported-strategy': 'update artifact is notify-only',
  'redirect-rejected': 'update download was redirected outside the trusted release hosts',
  'too-many-redirects': 'update download exceeded its redirect limit',
  'http-status': 'update download did not return the release asset',
  network: 'update download failed',
  timeout: 'update download timed out',
  'too-large': 'update download exceeded the signed length',
  'too-short': 'update download ended before the signed length',
  'hash-mismatch': 'update download does not match the signed SHA-256',
  disk: 'update download could not be written',
  cancelled: 'update download was cancelled',
  superseded: 'update download was superseded by a newer release',
  'not-verified': 'update artifact no longer matches the signed manifest',
})

class UpdateDownloadError extends Error {
  constructor(code, message = MESSAGES[code] ?? MESSAGES.network) {
    super(message)
    this.name = 'UpdateDownloadError'
    this.code = code
  }
}

function fail(code) {
  throw new UpdateDownloadError(code)
}

function versionParts(version) {
  const match = VERSION_RE.exec(version)
  return [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])]
}

function compareVersions(left, right) {
  const a = versionParts(left)
  const b = versionParts(right)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] > b[index]) return 1
    if (a[index] < b[index]) return -1
  }
  return 0
}

function specFor(platform, architecture, packageType) {
  return TARGET_SPECS.find((spec) => (
    spec.platform === platform
    && spec.architecture === architecture
    && spec.packageType === packageType
  ))
}

// Re-derives everything the manifest validator enforced, so this boundary
// never trusts its caller for the URL, filename, length or digest.
function normalizeArtifact(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('invalid-artifact')
  const spec = specFor(value.platform, value.architecture, value.packageType)
  if (!spec || typeof value.version !== 'string' || !VERSION_RE.test(value.version)) fail('invalid-artifact')
  const tag = `v${value.version}`
  const filename = spec.filename(tag, value.version)
  if (
    value.tag !== tag
    || value.installStrategy !== spec.installStrategy
    || value.filename !== filename
    || value.url !== `https://github.com/${UPDATE_REPOSITORY}/releases/download/${tag}/${filename}`
    || !Number.isSafeInteger(value.byteLength)
    || value.byteLength <= 0
    || value.byteLength > MAX_ARTIFACT_BYTES
    || typeof value.sha256 !== 'string'
    || !SHA256_RE.test(value.sha256)
  ) {
    fail('invalid-artifact')
  }
  const isMac = spec.packageType === 'dmg'
  if (isMac
    ? typeof value.minimumSystemVersion !== 'string' || !MACOS_VERSION_RE.test(value.minimumSystemVersion)
    : value.minimumSystemVersion !== undefined) {
    fail('invalid-artifact')
  }
  if (!DOWNLOADABLE_STRATEGIES.has(spec.installStrategy)) return null
  return Object.freeze({
    version: value.version,
    tag,
    platform: spec.platform,
    architecture: spec.architecture,
    packageType: spec.packageType,
    installStrategy: spec.installStrategy,
    filename,
    url: value.url,
    byteLength: value.byteLength,
    sha256: value.sha256,
    ...(isMac ? { minimumSystemVersion: value.minimumSystemVersion } : {}),
  })
}

function keyFor(artifact) {
  return `${artifact.tag}-${artifact.sha256}`
}

function recordFor(artifact, filePath) {
  return Object.freeze({
    path: filePath,
    version: artifact.version,
    tag: artifact.tag,
    filename: artifact.filename,
    sha256: artifact.sha256,
    byteLength: artifact.byteLength,
    packageType: artifact.packageType,
    installStrategy: artifact.installStrategy,
    ...(artifact.minimumSystemVersion !== undefined ? { minimumSystemVersion: artifact.minimumSystemVersion } : {}),
  })
}

function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

function isAllowedHop(url, artifact) {
  if (
    url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || url.port !== ''
    || url.hash !== ''
  ) {
    return false
  }
  if (url.hostname === 'github.com') return url.href === artifact.url
  return ASSET_HOSTS.has(url.hostname) && ASSET_PATH_RE.test(url.pathname)
}

function header(response, name) {
  const value = response?.headers?.get?.(name)
  return typeof value === 'string' ? value : null
}

function cancelBody(body) {
  if (!body || typeof body.cancel !== 'function') return
  try {
    Promise.resolve(body.cancel()).catch(() => {})
  } catch {
    // The response may already be torn down by the aborted request.
  }
}

function withAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(new Error('aborted'))
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('aborted'))
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

function openReader(body) {
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader()
    return {
      read: () => reader.read(),
      cancel() {
        try {
          Promise.resolve(reader.cancel?.()).catch(() => {})
        } catch {
          // Already cancelled by the aborted request.
        }
      },
      release() {
        try {
          reader.releaseLock?.()
        } catch {
          // A pending read can keep the lock until cancellation settles.
        }
      },
    }
  }
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    const iterator = body[Symbol.asyncIterator]()
    return {
      read: () => iterator.next(),
      cancel() {
        try {
          Promise.resolve(iterator.return?.()).catch(() => {})
        } catch {
          // Already closed by the aborted request.
        }
      },
      release() {},
    }
  }
  if (body === null || body === undefined) {
    return { read: async () => ({ done: true }), cancel() {}, release() {} }
  }
  cancelBody(body)
  return fail('http-status')
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  return fail('network')
}

function createUpdateDownloader(options) {
  if (!options || typeof options.directory !== 'string' || !path.isAbsolute(options.directory)) {
    throw new TypeError('directory must be an absolute path')
  }
  if (typeof options.fetchImpl !== 'function') throw new TypeError('fetchImpl is required')
  const root = path.resolve(options.directory)
  const fetchImpl = options.fetchImpl
  const fsImpl = options.fsImpl ?? fs
  const stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
  for (const [name, value] of [['stallTimeoutMs', stallTimeoutMs], ['totalTimeoutMs', totalTimeoutMs], ['staleAfterMs', staleAfterMs]]) {
    if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be positive`)
  }
  const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout
  const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout
  const nowMs = options.nowMs ?? Date.now

  let inFlight = null

  async function disk(operation) {
    try {
      return await operation()
    } catch {
      return fail('disk')
    }
  }

  function abort(operation, reason) {
    if (operation.reason === null) operation.reason = reason
    operation.controller.abort()
  }

  function throwIfAborted(operation) {
    if (operation.reason !== null) fail(operation.reason)
  }

  function armStall(operation) {
    if (operation.stallTimer !== null) clearTimeoutImpl(operation.stallTimer)
    operation.stallTimer = setTimeoutImpl(() => abort(operation, 'timeout'), stallTimeoutMs)
    operation.stallTimer?.unref?.()
  }

  function emitProgress(operation, receivedBytes) {
    for (const listener of operation.listeners) {
      try {
        listener(receivedBytes, operation.artifact.byteLength)
      } catch {
        // A progress observer cannot affect the download.
      }
    }
  }

  async function ensureRoot() {
    await disk(() => fsImpl.mkdir(root, { recursive: true, mode: 0o700 }))
    const stat = await disk(() => fsImpl.lstat(root))
    if (!stat.isDirectory()) fail('disk')
    if ((stat.mode & 0o777) !== 0o700) await disk(() => fsImpl.chmod(root, 0o700))
  }

  async function removeEntry(target) {
    const stat = await fsImpl.lstat(target)
    if (stat.isDirectory()) await fsImpl.rm(target, { recursive: true, force: true })
    else await fsImpl.unlink(target)
  }

  async function hashFile(filePath, expected, signal) {
    let handle
    try {
      handle = await fsImpl.open(filePath, OPEN_READ_FLAGS)
    } catch {
      return fail('not-verified')
    }
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.size !== expected.byteLength) fail('not-verified')
      const hash = createHash('sha256')
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, expected.byteLength))
      let total = 0
      while (total < expected.byteLength) {
        if (signal?.aborted) fail('cancelled')
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, expected.byteLength - total), null)
        if (bytesRead === 0) break
        hash.update(buffer.subarray(0, bytesRead))
        total += bytesRead
      }
      const after = await handle.stat()
      if (total !== expected.byteLength || after.size !== expected.byteLength || hash.digest('hex') !== expected.sha256) {
        fail('not-verified')
      }
    } catch (error) {
      if (error instanceof UpdateDownloadError) throw error
      fail('not-verified')
    } finally {
      await handle.close().catch(() => {})
    }
  }

  // An existing verified directory is reused only after its file re-hashes to
  // the signed digest; anything else at that name is removed, never trusted.
  async function reuseVerified(operation, finalDir, finalPath) {
    let stat
    try {
      stat = await fsImpl.lstat(finalDir)
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      return fail('disk')
    }
    if (stat.isDirectory()) {
      try {
        await hashFile(finalPath, operation.artifact, operation.controller.signal)
        return recordFor(operation.artifact, finalPath)
      } catch {
        throwIfAborted(operation)
      }
    }
    await disk(() => removeEntry(finalDir))
    return null
  }

  async function request(operation) {
    const { artifact } = operation
    const signal = operation.controller.signal
    let current = new URL(artifact.url)
    let redirects = 0
    while (true) {
      armStall(operation)
      let response
      try {
        response = await withAbort(
          Promise.resolve().then(() => fetchImpl(current.href, {
            redirect: 'manual',
            signal,
            credentials: 'omit',
            headers: { 'cache-control': 'no-cache' },
          })),
          signal,
        )
      } catch {
        throwIfAborted(operation)
        return fail('network')
      }
      if (isRedirect(response?.status)) {
        cancelBody(response.body)
        if (redirects >= MAX_REDIRECTS) fail('too-many-redirects')
        const location = header(response, 'location')
        let next = null
        try {
          next = location ? new URL(location, current) : null
        } catch {
          next = null
        }
        if (next === null || !isAllowedHop(next, artifact)) fail('redirect-rejected')
        current = next
        redirects += 1
        continue
      }
      if (response?.status !== 200) {
        cancelBody(response?.body)
        fail('http-status')
      }
      return response
    }
  }

  function checkDeclaredLength(response, artifact) {
    const raw = header(response, 'content-length')
    if (raw === null) return
    if (!/^(0|[1-9]\d*)$/.test(raw)) {
      cancelBody(response.body)
      fail('http-status')
    }
    const encoding = header(response, 'content-encoding')
    const identity = encoding === null || encoding.trim().toLowerCase() === 'identity'
    if (identity && Number(raw) > artifact.byteLength) {
      cancelBody(response.body)
      fail('too-large')
    }
  }

  async function writeAll(handle, chunk) {
    let offset = 0
    while (offset < chunk.length) {
      const result = await disk(() => handle.write(chunk, offset, chunk.length - offset))
      if (!result || !Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0) fail('disk')
      offset += result.bytesWritten
    }
  }

  async function streamToFile(operation, response, handle) {
    const { artifact } = operation
    const signal = operation.controller.signal
    const hash = createHash('sha256')
    const reader = openReader(response.body)
    let received = 0
    let complete = false
    try {
      while (true) {
        let step
        try {
          step = await withAbort(reader.read(), signal)
        } catch {
          throwIfAborted(operation)
          return fail('network')
        }
        if (!step || step.done) {
          complete = true
          break
        }
        if (step.value === undefined) continue
        const chunk = toBuffer(step.value)
        if (chunk.length === 0) continue
        if (received + chunk.length > artifact.byteLength) fail('too-large')
        hash.update(chunk)
        await writeAll(handle, chunk)
        received += chunk.length
        armStall(operation)
        emitProgress(operation, received)
      }
    } finally {
      if (!complete) reader.cancel()
      reader.release()
    }
    return { received, digest: hash.digest('hex') }
  }

  async function syncDirectory(directory) {
    let handle = null
    try {
      handle = await fsImpl.open(directory, constants.O_RDONLY)
      await handle.sync()
    } catch {
      // Directory fsync is best-effort; the file itself was fsynced before rename.
    } finally {
      await handle?.close().catch(() => {})
    }
  }

  async function ensureFinalDirectory(finalDir) {
    try {
      await fsImpl.mkdir(finalDir, { mode: 0o700 })
      return true
    } catch (error) {
      if (error?.code !== 'EEXIST') fail('disk')
    }
    const stat = await disk(() => fsImpl.lstat(finalDir))
    if (!stat.isDirectory()) fail('disk')
    return false
  }

  async function runDownload(operation) {
    const { artifact } = operation
    const finalDir = path.join(root, operation.key)
    const finalPath = path.join(finalDir, artifact.filename)
    let staging = null
    let handle = null
    let createdFinalDir = false
    operation.totalTimer = setTimeoutImpl(() => abort(operation, 'timeout'), totalTimeoutMs)
    operation.totalTimer?.unref?.()
    try {
      await ensureRoot()
      throwIfAborted(operation)
      const reused = await reuseVerified(operation, finalDir, finalPath)
      if (reused) {
        emitProgress(operation, artifact.byteLength)
        return reused
      }
      throwIfAborted(operation)
      staging = await disk(() => fsImpl.mkdtemp(path.join(root, STAGING_PREFIX)))
      operation.stagingName = path.basename(staging)
      const partPath = path.join(staging, `${artifact.filename}.part`)
      handle = await disk(() => fsImpl.open(partPath, 'wx', 0o600))
      const response = await request(operation)
      checkDeclaredLength(response, artifact)
      const { received, digest } = await streamToFile(operation, response, handle)
      if (operation.stallTimer !== null) clearTimeoutImpl(operation.stallTimer)
      operation.stallTimer = null
      if (received !== artifact.byteLength) fail('too-short')
      if (digest !== artifact.sha256) fail('hash-mismatch')
      await disk(() => handle.sync())
      const written = handle
      handle = null
      await disk(() => written.close())
      throwIfAborted(operation)
      createdFinalDir = await ensureFinalDirectory(finalDir)
      throwIfAborted(operation)
      await disk(() => fsImpl.rename(partPath, finalPath))
      createdFinalDir = false
      await syncDirectory(finalDir)
      return recordFor(artifact, finalPath)
    } catch (error) {
      const failure = operation.reason !== null
        ? new UpdateDownloadError(operation.reason)
        : error instanceof UpdateDownloadError ? error : new UpdateDownloadError('disk')
      // Tear down any request still attached to this attempt.
      operation.controller.abort()
      if (createdFinalDir) await fsImpl.rmdir(finalDir).catch(() => {})
      throw failure
    } finally {
      clearTimeoutImpl(operation.totalTimer)
      if (operation.stallTimer !== null) clearTimeoutImpl(operation.stallTimer)
      if (handle !== null) await handle.close().catch(() => {})
      if (staging !== null) await fsImpl.rm(staging, { recursive: true, force: true }).catch(() => {})
    }
  }

  async function isAbandonedStaging(directory) {
    const stat = await fsImpl.lstat(directory)
    // mkdtemp only ever creates real directories; anything else was planted.
    if (!stat.isDirectory()) return true
    let newest = stat.mtimeMs
    const names = await fsImpl.readdir(directory)
    for (const name of names.slice(0, MAX_STAGING_ENTRIES_CHECKED)) {
      try {
        newest = Math.max(newest, (await fsImpl.lstat(path.join(directory, name))).mtimeMs)
      } catch {
        // Removed concurrently.
      }
    }
    return nowMs() - newest > staleAfterMs
  }

  async function prune(options = {}) {
    try {
      let keepKey
      if (options.keep !== undefined) {
        const keep = options.keep === null ? null : normalizeArtifact(options.keep)
        keepKey = keep === null ? null : keyFor(keep)
      }
      const currentVersion = typeof options.currentVersion === 'string' && VERSION_RE.test(options.currentVersion)
        ? options.currentVersion
        : null
      let names
      try {
        names = await fsImpl.readdir(root)
      } catch {
        return
      }
      let removals = 0
      for (const name of names) {
        if (removals >= MAX_PRUNE_REMOVALS) break
        const entry = path.join(root, name)
        let remove = false
        if (STAGING_RE.test(name)) {
          if (inFlight?.stagingName === name) continue
          try {
            remove = await isAbandonedStaging(entry)
          } catch {
            remove = false
          }
        } else {
          const match = DOWNLOAD_DIR_RE.exec(name)
          if (!match || inFlight?.key === name) continue
          remove = (keepKey !== undefined && name !== keepKey)
            || (currentVersion !== null && compareVersions(match[1], currentVersion) <= 0)
        }
        if (!remove) continue
        try {
          await removeEntry(entry)
          removals += 1
        } catch {
          // Best-effort: a later pass retries.
        }
      }
    } catch {
      // Cleanup never fails a caller.
    }
  }

  function download(artifact, downloadOptions = {}) {
    let normalized
    try {
      normalized = normalizeArtifact(artifact)
    } catch (error) {
      return Promise.reject(error)
    }
    if (normalized === null) return Promise.reject(new UpdateDownloadError('unsupported-strategy'))
    const onProgress = typeof downloadOptions?.onProgress === 'function' ? downloadOptions.onProgress : null
    const key = keyFor(normalized)
    if (inFlight !== null && inFlight.key === key && inFlight.reason === null) {
      if (onProgress) inFlight.listeners.add(onProgress)
      return inFlight.promise
    }
    const previous = inFlight
    if (previous !== null) abort(previous, 'superseded')
    const operation = {
      key,
      artifact: normalized,
      controller: new AbortController(),
      reason: null,
      listeners: new Set(onProgress ? [onProgress] : []),
      stagingName: null,
      stallTimer: null,
      totalTimer: null,
      promise: null,
    }
    inFlight = operation
    operation.promise = (async () => {
      try {
        if (previous !== null) await previous.promise.catch(() => {})
        throwIfAborted(operation)
        const record = await runDownload(operation)
        await prune({ keep: normalized })
        return record
      } finally {
        if (inFlight === operation) inFlight = null
      }
    })()
    return operation.promise
  }

  async function verify(record) {
    if (record === null || typeof record !== 'object' || typeof record.path !== 'string') fail('not-verified')
    const spec = typeof record.version === 'string' && VERSION_RE.test(record.version)
      ? TARGET_SPECS.find((candidate) => (
          candidate.packageType === record.packageType
          && candidate.installStrategy === record.installStrategy
          && candidate.filename(`v${record.version}`, record.version) === record.filename
        ))
      : undefined
    let artifact
    try {
      artifact = spec
        ? normalizeArtifact({
            version: record.version,
            tag: record.tag,
            platform: spec.platform,
            architecture: spec.architecture,
            packageType: spec.packageType,
            installStrategy: spec.installStrategy,
            filename: record.filename,
            url: `https://github.com/${UPDATE_REPOSITORY}/releases/download/${record.tag}/${record.filename}`,
            byteLength: record.byteLength,
            sha256: record.sha256,
            ...(record.minimumSystemVersion !== undefined ? { minimumSystemVersion: record.minimumSystemVersion } : {}),
          })
        : null
    } catch {
      artifact = null
    }
    if (artifact === null) fail('not-verified')
    const expectedPath = path.join(root, keyFor(artifact), artifact.filename)
    if (record.path !== expectedPath) fail('not-verified')
    await hashFile(expectedPath, artifact, null)
    return recordFor(artifact, expectedPath)
  }

  return Object.freeze({
    normalize: normalizeArtifact,
    download,
    cancel() {
      const operation = inFlight
      if (operation === null) return Promise.resolve()
      abort(operation, 'cancelled')
      return operation.promise.then(() => undefined, () => undefined)
    },
    verify,
    prune,
  })
}

module.exports = {
  UpdateDownloadError,
  createUpdateDownloader,
}
