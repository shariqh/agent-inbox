'use strict'

const {
  verifyManifest,
} = require('./update-manifest.cjs')

const MANIFEST_URL = 'https://github.com/shariqh/agent-inbox/releases/latest/download/update-manifest.json'
const SIGNATURE_URL = 'https://github.com/shariqh/agent-inbox/releases/latest/download/update-manifest.json.sig'
const MANIFEST_MAX_BYTES = 256 * 1024
const SIGNATURE_MAX_BYTES = 16 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_REDIRECTS = 5
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const GITHUB_RELEASE_PATH_RE = /^\/shariqh\/agent-inbox\/releases\/(?:latest\/download|download\/v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\/(update-manifest\.json(?:\.sig)?)$/
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
  contentLength(response, cap)
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
    try {
      while (true) {
        const { done, value } = await withAbort(reader.read(), signal)
        if (done) break
        if (value !== undefined) append(value)
      }
    } finally {
      if (signal.aborted) {
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
    try {
      while (true) {
        const { done, value } = await withAbort(iterator.next(), signal)
        if (done) break
        append(value)
      }
    } finally {
      if (signal.aborted) {
        try {
          iterator.return?.()
        } catch {
          // The iterator may already have been closed by fetch's signal.
        }
      }
    }
  } else {
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

function selectTarget(manifest, options) {
  const packaged = options.isPackaged === true
  const supportedArch = options.arch === 'x64' || options.arch === 'arm64'
  if (!packaged || !supportedArch) return null

  let architecture
  let packageType
  if (options.platform === 'darwin') {
    architecture = 'universal'
    packageType = 'dmg'
  } else if (options.platform === 'linux') {
    architecture = options.arch
    packageType = typeof options.appImagePath === 'string' && options.appImagePath !== ''
      ? 'appimage'
      : 'deb'
  } else {
    return null
  }
  return manifest.targets.find((target) => (
    target.platform === options.platform
    && target.architecture === architecture
    && target.packageType === packageType
  )) ?? null
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
    const manifestBytes = await fetchAsset({
      fetchImpl: options.fetchImpl,
      initialUrl: MANIFEST_URL,
      expectedAsset: 'update-manifest.json',
      cap: MANIFEST_MAX_BYTES,
      signal: controller.signal,
    })
    const signatureBytes = await fetchAsset({
      fetchImpl: options.fetchImpl,
      initialUrl: SIGNATURE_URL,
      expectedAsset: 'update-manifest.json.sig',
      cap: SIGNATURE_MAX_BYTES,
      signal: controller.signal,
    })
    const manifest = verifyManifest({
      manifestBytes,
      envelope: signatureBytes,
      registry: options.registry,
      now,
    })
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
    return {
      ...baseState('available', options, checkedAt, 'A verified update is available.'),
      available: {
        version: manifest.version,
        tag: manifest.tag,
        releaseUrl: manifest.releaseUrl,
        target: {
          packageType: target.packageType,
          installStrategy: target.installStrategy,
        },
      },
    }
  } finally {
    clearTimeoutImpl(deadline)
  }
}

module.exports = {
  MANIFEST_URL,
  SIGNATURE_URL,
  checkForUpdate,
}
