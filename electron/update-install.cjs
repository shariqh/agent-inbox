'use strict'

// Electron-main-only install contract (#196). A PlatformInstaller turns the
// verified download into an installed build in two steps: prepare() stages and
// fully verifies the new build without touching the running installation, and
// the PreparedInstall's commit() is the only step that changes anything. The
// controller hands prepare() a read-only handle whose bytes the downloader just
// re-hashed, never a path, and installers must hash the bytes they actually
// consume from it (copyVerifiedSource does exactly that).

const { createHash, randomBytes } = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')

const SHA256_RE = /^[0-9a-f]{64}$/
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const PLATFORM_RE = /^[a-z0-9]{1,32}$/
const DOWNLOADABLE_STRATEGIES = new Set(['macos-dmg', 'appimage-self-replace'])
const MAX_ARTIFACT_BYTES = 2 * 1024 ** 3
const COPY_CHUNK_BYTES = 1024 * 1024
const ATTEMPT_RECORD = 'last-attempt.json'
const ATTEMPT_RESULT = 'last-attempt.result'
const MAX_RECORD_BYTES = 4096
const MAX_RESULT_BYTES = 16
const RESULT_RE = /^(\d{1,3})\n?$/
// The helpers give up after about two minutes; until then an attempt without a
// result may still be in flight, and belongs to the app the helper reopens.
const DEFAULT_IN_FLIGHT_MS = 150_000

// Every platform's swap helper reports one of these before it exits, so the
// app that starts next can say what happened without knowing the platform.
const INSTALL_HELPER_EXIT = Object.freeze({
  installed: 0,
  badArguments: 64,
  refused: 65,
  couldNotMoveAside: 70,
  couldNotMoveIn: 71,
  timedOut: 75,
})

const MESSAGES = Object.freeze({
  'not-feasible': 'update cannot be installed from the app on this installation',
  'not-verified': 'update file no longer matches the signed manifest',
  stale: 'update is older than a release this app already verified',
  busy: 'another update or setup operation is running',
  staging: 'update could not be prepared',
  'verification-failed': 'prepared update failed verification',
  'commit-failed': 'update could not be handed off for install',
})

class UpdateInstallError extends Error {
  constructor(code, message = MESSAGES[code] ?? MESSAGES.staging) {
    super(message)
    this.name = 'UpdateInstallError'
    this.code = code
  }
}

function fail(code, message) {
  throw new UpdateInstallError(code, message)
}

function validSource(source) {
  const record = source?.record
  return Boolean(
    record
    && typeof record === 'object'
    && Number.isSafeInteger(record.byteLength)
    && record.byteLength > 0
    && record.byteLength <= MAX_ARTIFACT_BYTES
    && typeof record.sha256 === 'string'
    && SHA256_RE.test(record.sha256)
    && typeof source.handle?.read === 'function'
    && typeof source.handle?.stat === 'function',
  )
}

async function writeAll(output, chunk) {
  let offset = 0
  while (offset < chunk.length) {
    let result
    try {
      result = await output.write(chunk, offset, chunk.length - offset)
    } catch {
      fail('staging')
    }
    if (!result || !Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0) fail('staging')
    offset += result.bytesWritten
  }
}

// Copies exactly record.byteLength bytes from the handle with positioned reads
// into a new file (`wx`), hashing the bytes as they are consumed. The copy is
// kept only when the consumed bytes have the signed length and SHA-256; every
// failure removes it, and a pre-existing file at `destination` is never touched.
async function copyVerifiedSource(source, destination, options = {}) {
  if (!validSource(source)) fail('not-verified')
  const fsImpl = options.fsImpl ?? fs
  const signal = options.signal
  const mode = options.mode ?? 0o600
  const { record, handle } = source
  let stat
  try {
    stat = await handle.stat()
  } catch {
    fail('not-verified')
  }
  if (!stat?.isFile?.() || stat.size !== record.byteLength) fail('not-verified')

  let output = null
  let created = false
  let complete = false
  try {
    try {
      output = await fsImpl.open(destination, 'wx', mode)
      created = true
    } catch {
      fail('staging')
    }
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(Math.min(COPY_CHUNK_BYTES, record.byteLength))
    let position = 0
    while (position < record.byteLength) {
      if (signal?.aborted) fail('staging', 'update install was cancelled')
      const length = Math.min(buffer.length, record.byteLength - position)
      let bytesRead
      try {
        ({ bytesRead } = await handle.read(buffer, 0, length, position))
      } catch {
        fail('not-verified')
      }
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > length) fail('not-verified')
      if (bytesRead === 0) break
      const chunk = buffer.subarray(0, bytesRead)
      hash.update(chunk)
      await writeAll(output, chunk)
      position += bytesRead
    }
    if (position !== record.byteLength || hash.digest('hex') !== record.sha256) fail('not-verified')
    try {
      await output.sync()
      const written = output
      output = null
      await written.close()
    } catch {
      fail('staging')
    }
    complete = true
  } finally {
    if (output !== null) await output.close().catch(() => {})
    if (created && !complete) await fsImpl.unlink(destination).catch(() => {})
  }
}

async function unlinkQuietly(fsImpl, target) {
  try {
    await fsImpl.unlink(target)
  } catch {
    // Already gone, or not ours to remove.
  }
}

// Reads a small regular file without following a link; null for anything else.
async function readSmallFile(fsImpl, target, maxBytes) {
  let stat
  try {
    stat = await fsImpl.lstat(target)
  } catch {
    return null
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return null
  try {
    return String(await fsImpl.readFile(target, 'utf8'))
  } catch {
    return null
  }
}

function parseRecord(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (
    !value
    || typeof value !== 'object'
    || value.schema !== 1
    || typeof value.from !== 'string'
    || !VERSION_RE.test(value.from)
    || typeof value.to !== 'string'
    || !VERSION_RE.test(value.to)
    || typeof value.at !== 'string'
    || !Number.isFinite(Date.parse(value.at))
    || typeof value.platform !== 'string'
    || !PLATFORM_RE.test(value.platform)
    || !DOWNLOADABLE_STRATEGIES.has(value.strategy)
  ) {
    return null
  }
  return { from: value.from, to: value.to, at: value.at, platform: value.platform, strategy: value.strategy }
}

// The attempt record survives the restart in `directory` (userData/update-install):
// last-attempt.json is written before commit(), and the platform helper writes
// its exit code to last-attempt.result before it exits. The next app start takes
// both, so a swap that failed is reported instead of silently offered again.
function createInstallAttemptStore(options = {}) {
  if (typeof options.directory !== 'string' || !path.isAbsolute(options.directory)) {
    throw new TypeError('directory must be an absolute path')
  }
  const directory = path.resolve(options.directory)
  const platform = options.platform ?? process.platform
  if (typeof platform !== 'string' || !PLATFORM_RE.test(platform)) throw new TypeError('platform is invalid')
  const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : null)
  const fsImpl = options.fsImpl ?? fs
  const now = options.now ?? (() => new Date())
  const inFlightMs = options.inFlightMs ?? DEFAULT_IN_FLIGHT_MS
  if (!Number.isFinite(inFlightMs) || inFlightMs < 0) throw new TypeError('inFlightMs must be a non-negative number')
  const recordPath = path.join(directory, ATTEMPT_RECORD)
  const resultPath = path.join(directory, ATTEMPT_RESULT)

  async function ensureDirectory() {
    await fsImpl.mkdir(directory, { recursive: true, mode: 0o700 })
    const stat = await fsImpl.lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== null && stat.uid !== uid)) {
      throw new Error('attempt directory is not a private directory')
    }
    if ((stat.mode & 0o777) !== 0o700) await fsImpl.chmod(directory, 0o700)
  }

  async function begin(attempt) {
    const from = attempt?.from
    const to = attempt?.to
    const strategy = attempt?.strategy
    if (typeof from !== 'string' || !VERSION_RE.test(from) || typeof to !== 'string' || !VERSION_RE.test(to)) {
      throw new TypeError('attempt versions must be exact X.Y.Z versions')
    }
    if (!DOWNLOADABLE_STRATEGIES.has(strategy)) throw new TypeError('attempt strategy is not installable')
    await ensureDirectory()
    // A result from an earlier helper must never be read as this attempt's.
    await unlinkQuietly(fsImpl, resultPath)
    const record = { schema: 1, from, to, at: now().toISOString(), platform, strategy }
    const temp = path.join(directory, `.${ATTEMPT_RECORD}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
    let handle = null
    try {
      handle = await fsImpl.open(temp, 'wx', 0o600)
      await handle.write(`${JSON.stringify(record)}\n`)
      await handle.sync()
      const written = handle
      handle = null
      await written.close()
      await fsImpl.rename(temp, recordPath)
    } catch (error) {
      if (handle !== null) await handle.close().catch(() => {})
      await unlinkQuietly(fsImpl, temp)
      throw error
    }
    return Object.freeze({ resultPath })
  }

  async function abandon() {
    await unlinkQuietly(fsImpl, recordPath)
    await unlinkQuietly(fsImpl, resultPath)
  }

  async function take() {
    try {
      const recordText = await readSmallFile(fsImpl, recordPath, MAX_RECORD_BYTES)
      const resultText = await readSmallFile(fsImpl, resultPath, MAX_RESULT_BYTES)
      const record = recordText === null ? null : parseRecord(recordText)
      // Another process sharing userData may start while the helper still waits
      // to swap: a young attempt without a result is left for the reopened app.
      if (record !== null && resultText === null && now().getTime() - Date.parse(record.at) < inFlightMs) return null
      await abandon()
      if (record === null) return null
      const match = resultText === null ? null : resultText.match(RESULT_RE)
      return Object.freeze({ ...record, exitCode: match ? Number(match[1]) : null })
    } catch {
      return null
    }
  }

  return Object.freeze({ begin, abandon, take })
}

module.exports = {
  INSTALL_HELPER_EXIT,
  UpdateInstallError,
  copyVerifiedSource,
  createInstallAttemptStore,
}
