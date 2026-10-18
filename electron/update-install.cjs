'use strict'

// Electron-main-only install contract (#196). A PlatformInstaller turns the
// verified download into an installed build in two steps: prepare() stages and
// fully verifies the new build without touching the running installation, and
// the PreparedInstall's commit() is the only step that changes anything. The
// controller hands prepare() a read-only handle whose bytes the downloader just
// re-hashed, never a path, and installers must hash the bytes they actually
// consume from it (copyVerifiedSource does exactly that).

const { createHash } = require('node:crypto')
const fs = require('node:fs/promises')

const SHA256_RE = /^[0-9a-f]{64}$/
const MAX_ARTIFACT_BYTES = 2 * 1024 ** 3
const COPY_CHUNK_BYTES = 1024 * 1024

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

module.exports = {
  UpdateInstallError,
  copyVerifiedSource,
}
