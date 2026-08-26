'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { randomBytes } = require('node:crypto')

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const DEFAULT_FILENAME = 'update-preferences.json'
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

function resolveFilePath(options) {
  if (typeof options.filePath === 'string' && options.filePath !== '') return path.resolve(options.filePath)
  if (options.app && typeof options.app.getPath === 'function') {
    const userData = options.app.getPath('userData')
    if (typeof userData !== 'string' || userData === '') throw new TypeError('app.getPath("userData") must return a path')
    const filename = options.filename ?? DEFAULT_FILENAME
    if (typeof filename !== 'string' || filename === '' || path.basename(filename) !== filename) {
      throw new TypeError('filename must be a single path segment')
    }
    return path.join(userData, filename)
  }
  throw new TypeError('filePath or app.getPath adapter is required')
}

function createUpdatePreferences(options = {}) {
  const filePath = resolveFilePath(options)
  const fsImpl = options.fsImpl ?? fs
  const lockPath = `${filePath}.lock`
  let sequence = 0
  let mutations = Promise.resolve()

  async function readLive() {
    try {
      return parsePreferences(await fsImpl.readFile(filePath))
    } catch (error) {
      if (error?.code === 'ENOENT') return defaults()
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
        if (Date.now() >= deadline) throw new Error('update preferences are busy in another process')
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

  function mutate(update) {
    const operation = mutations.then(() => withFileLock(async () => {
      const current = await readLive()
      const next = update(current)
      await atomicWrite(next)
      return { ...next }
    }))
    mutations = operation.then(() => undefined, () => undefined)
    return operation
  }

  return Object.freeze({
    async read() {
      await mutations
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

module.exports = {
  createUpdatePreferences,
}
