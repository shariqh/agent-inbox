'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { randomBytes } = require('node:crypto')

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const DEFAULT_FILENAME = 'update-preferences.json'
// The rollback mark never lives in update-preferences.json: 1.2.x builds reset that file
// to defaults (automatic checks off) when it carries any key they do not know.
const TRUST_STATE_FILENAME = 'update-trust-state.json'
const TRUST_STATE_SCHEMA = 1
// One rollback mark per manifest (#343, design §5.6). Apps from 1.3 to 1.6 read and raise
// only the v1 mark, keeping every other field, so the file stays at schema 1.
const MARK_FIELDS = Object.freeze({ v1: 'highestVerifiedVersion', v2: 'highestVerifiedVersionV2' })
const LOCK_RETRY_MS = 25
const LOCK_TIMEOUT_MS = 5_000
const LOCK_STALE_MS = 5 * 60_000

function defaults() {
  return {
    schema: 1,
    automaticChecks: false,
    lastNotifiedVersion: null,
  }
}

function parsePreferences(bytes) {
  let value
  try {
    value = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes))
  } catch {
    return defaults()
  }
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== ['automaticChecks', 'lastNotifiedVersion', 'schema'].join('\0')
    || value.schema !== 1
    || typeof value.automaticChecks !== 'boolean'
    || !(
      value.lastNotifiedVersion === null
      || (typeof value.lastNotifiedVersion === 'string' && VERSION_RE.test(value.lastNotifiedVersion))
    )
  ) {
    return defaults()
  }
  return {
    schema: 1,
    automaticChecks: value.automaticChecks,
    lastNotifiedVersion: value.lastNotifiedVersion,
  }
}

function isVersion(value) {
  return typeof value === 'string' && VERSION_RE.test(value)
}

function isNewerVersion(candidate, current) {
  const left = VERSION_RE.exec(candidate).slice(1).map(BigInt)
  const right = VERSION_RE.exec(current).slice(1).map(BigInt)
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index]
  }
  return false
}

function noMarks() {
  return { highestVerifiedVersion: null, highestVerifiedVersionV2: null }
}

function parseTrustState(bytes) {
  const corrupt = { record: null, marks: noMarks(), writable: true }
  let value
  try {
    value = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes))
  } catch {
    return corrupt
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isSafeInteger(value.schema) || value.schema < 1) {
    return corrupt
  }
  return {
    record: value,
    marks: {
      highestVerifiedVersion: isVersion(value.highestVerifiedVersion) ? value.highestVerifiedVersion : null,
      highestVerifiedVersionV2: isVersion(value.highestVerifiedVersionV2) ? value.highestVerifiedVersionV2 : null,
    },
    writable: value.schema === TRUST_STATE_SCHEMA,
  }
}

function resolveFilePath(options, defaultFilename) {
  if (typeof options.filePath === 'string' && options.filePath !== '') return path.resolve(options.filePath)
  if (options.app && typeof options.app.getPath === 'function') {
    const userData = options.app.getPath('userData')
    if (typeof userData !== 'string' || userData === '') throw new TypeError('app.getPath("userData") must return a path')
    const filename = options.filename ?? defaultFilename
    if (typeof filename !== 'string' || filename === '' || path.basename(filename) !== filename) {
      throw new TypeError('filename must be a single path segment')
    }
    return path.join(userData, filename)
  }
  throw new TypeError('filePath or app.getPath adapter is required')
}

// One userData JSON file: writes are queued in-process, locked across processes by a
// sibling `.lock` file, and published by temp-file + rename. Each file has its own lock.
// Also the store for link-preferences.json (#300).
function createLockedFile(filePath, fsImpl) {
  const lockPath = `${filePath}.lock`
  let sequence = 0
  let mutations = Promise.resolve()

  async function readBytes() {
    try {
      return await fsImpl.readFile(filePath)
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }

  async function atomicWrite(value) {
    const directory = path.dirname(filePath)
    await fsImpl.mkdir(directory, { recursive: true })
    sequence += 1
    const tempPath = path.join(
      directory,
      `.${path.basename(filePath)}.${process.pid}.${sequence}.${randomBytes(8).toString('hex')}.tmp`,
    )
    try {
      await fsImpl.writeFile(
        tempPath,
        `${JSON.stringify(value, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600, flag: 'wx' },
      )
      await fsImpl.rename(tempPath, filePath)
    } catch (error) {
      try {
        await fsImpl.unlink(tempPath)
      } catch {
        // The temp may not have been created or may already have been renamed.
      }
      throw error
    }
  }

  async function acquireLock() {
    const deadline = Date.now() + LOCK_TIMEOUT_MS
    while (true) {
      try {
        return await fs.open(lockPath, 'wx', 0o600)
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        try {
          const stat = await fs.stat(lockPath)
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            await fs.unlink(lockPath)
            continue
          }
        } catch (statError) {
          if (statError?.code !== 'ENOENT') throw statError
          continue
        }
        if (Date.now() >= deadline) throw new Error(`${path.basename(filePath)} is busy in another process`)
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
      }
    }
  }

  async function withFileLock(operation) {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const handle = await acquireLock()
    try {
      return await operation()
    } finally {
      await handle.close()
      try {
        await fs.unlink(lockPath)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
  }

  function mutate(operation) {
    const queued = mutations.then(() => withFileLock(operation))
    mutations = queued.then(() => undefined, () => undefined)
    return queued
  }

  return Object.freeze({
    readBytes,
    atomicWrite,
    mutate,
    settled: () => mutations,
  })
}

function createUpdatePreferences(options = {}) {
  const file = createLockedFile(resolveFilePath(options, DEFAULT_FILENAME), options.fsImpl ?? fs)

  async function readLive() {
    const bytes = await file.readBytes()
    return bytes === null ? defaults() : parsePreferences(bytes)
  }

  function mutate(update) {
    return file.mutate(async () => {
      const next = update(await readLive())
      await file.atomicWrite(next)
      return { ...next }
    })
  }

  return Object.freeze({
    async read() {
      await file.settled()
      return { ...await readLive() }
    },
    setAutomatic(automaticChecks) {
      if (typeof automaticChecks !== 'boolean') {
        return Promise.reject(new TypeError('automaticChecks must be boolean'))
      }
      return mutate((current) => ({ ...current, automaticChecks }))
    },
    setLastNotifiedVersion(lastNotifiedVersion) {
      if (typeof lastNotifiedVersion !== 'string' || !VERSION_RE.test(lastNotifiedVersion)) {
        return Promise.reject(new TypeError('lastNotifiedVersion must be an exact stable X.Y.Z version'))
      }
      return mutate((current) => ({ ...current, lastNotifiedVersion }))
    },
  })
}

// Rollback high-water marks (#148), one per manifest (#343): a version verified in
// update-manifest.json raises only highestVerifiedVersion, one verified in
// update-manifest-v2.json only highestVerifiedVersionV2. Callers record only versions whose
// signed manifest verified. A newer build may extend this file: a valid mark is enforced
// whatever else the file holds, unknown fields survive a raise, and a newer schema is never
// overwritten.
function createUpdateTrustState(options = {}) {
  const file = createLockedFile(resolveFilePath(options, TRUST_STATE_FILENAME), options.fsImpl ?? fs)

  async function readLive() {
    const bytes = await file.readBytes()
    return bytes === null ? { record: null, marks: noMarks(), writable: true } : parseTrustState(bytes)
  }

  return Object.freeze({
    async read() {
      await file.settled()
      return { ...(await readLive()).marks }
    },
    recordVerifiedVersion(version, manifest) {
      if (!isVersion(version)) {
        return Promise.reject(new TypeError('verified version must be an exact stable X.Y.Z version'))
      }
      if (manifest !== 'v1' && manifest !== 'v2') {
        return Promise.reject(new TypeError('manifest must be "v1" or "v2"'))
      }
      const field = MARK_FIELDS[manifest]
      return file.mutate(async () => {
        const current = await readLive()
        const mark = current.marks[field]
        if (!current.writable || (mark !== null && !isNewerVersion(version, mark))) return { ...current.marks }
        await file.atomicWrite({ ...current.record, schema: TRUST_STATE_SCHEMA, [field]: version })
        return { ...current.marks, [field]: version }
      })
    },
  })
}

module.exports = {
  createLockedFile,
  createUpdatePreferences,
  createUpdateTrustState,
  resolveFilePath,
}
