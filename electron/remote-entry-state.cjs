'use strict'
// What the hub's remote-entry controller keeps across restarts (#617, PR 2e): userData
// `remote-entry-state.json`, `{ schema: 1, digest, wanted, file, viewerPort }`.
// electron/remote-entry.cjs is the only module that requires this one; split from it for size only.
//
// `digest` is the SHA-256 of the remote.json state the controller last wrote or the owner accepted,
// so a change made while the app was closed is flagged at the next start; or PENDING, which no file
// has, while a review is due or a write is under way, so any start before the review flags again.
// `wanted` is the owner's intent: the switch was turned on and not turned off since. `file` (the
// SHA-256 of remote.json's absolute path) and `viewerPort` say what the state is for: the checkout
// build and the installed app share one userData folder, and a state kept for the other reads as
// none here.
//
// This is a tripwire against a silent change, not a boundary: a local process that can write
// remote.json can write this file too. Written as the update and link preferences are
// (createLockedFile: a cross-process lock, temp file and rename, mode 0600). Read as remote.json is:
// opened without following a symlink and without blocking, a regular file this user owns, at most
// 64 KiB; anything else, and a bad file, is no state. A newer schema is no state and is never
// written over. Unknown fields are kept.
const fs = require('node:fs/promises')
const { constants } = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { createLockedFile, resolveFilePath } = require('./update-preferences.cjs')

const FILENAME = 'remote-entry-state.json'
const SCHEMA = 1
const FILE_MAX = 64 * 1024
const DIGEST = /^[0-9a-f]{64}$/
// what `digest` holds while a review is due: no remote.json state has it
const PENDING = 'pending'
const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = constants

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isPort = (value) => Number.isInteger(value) && value >= 1 && value <= 65535

/** What a state names for remote.json: the SHA-256 of its absolute path. */
const fileId = (file) => crypto.createHash('sha256').update(path.resolve(file)).digest('hex')

/** `{ digest, wanted, file, viewerPort }` when each is the right shape, else null. Used on what any store returns. */
function storedState(value) {
  if (!isObject(value)) return null
  const { digest, wanted, file, viewerPort } = value
  if (!(digest === null || digest === PENDING || (typeof digest === 'string' && DIGEST.test(digest)))) return null
  if (typeof wanted !== 'boolean') return null
  if (typeof file !== 'string' || !DIGEST.test(file) || !isPort(viewerPort)) return null
  return { digest, wanted, file, viewerPort }
}

/** The file's bytes, or null for none: missing, a symlink, not a regular file, not this user's, too large. */
async function readBytes(file, fsImpl, uid) {
  let handle
  try {
    handle = await fsImpl.open(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch (error) {
    if (['ENOENT', 'ELOOP', 'EISDIR', 'ENXIO', 'ENOTDIR'].includes(error?.code)) return null
    throw error
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || (uid !== undefined && uid !== null && stat.uid !== uid) || stat.size > FILE_MAX) return null
    const buffer = Buffer.alloc(FILE_MAX + 1)
    let total = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null)
      if (bytesRead === 0) break
      total += bytesRead
      if (total === buffer.length) return null
    }
    return buffer.subarray(0, total)
  } finally {
    try {
      await handle.close()
    } catch {
      // nothing more to read
    }
  }
}

/** `{ state, record, writable }` from the file's bytes. */
function parseState(bytes) {
  const none = { state: null, record: null, writable: true }
  let value
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return none
  }
  if (!isObject(value) || !Number.isSafeInteger(value.schema) || value.schema < 1) return none
  // a newer build's file: read as no state, and never written over
  if (value.schema > SCHEMA) return { state: null, record: null, writable: false }
  return { state: storedState(value), record: value, writable: true }
}

function createRemoteEntryState(options = {}) {
  const fsImpl = options.fsImpl ?? fs
  const filePath = resolveFilePath(options, FILENAME)
  const uid = options.uid ?? process.getuid?.()
  const file = createLockedFile(filePath, fsImpl)

  async function readLive() {
    const bytes = await readBytes(filePath, fsImpl, uid)
    return bytes === null ? { state: null, record: null, writable: true } : parseState(bytes)
  }

  return Object.freeze({
    async read() {
      await file.settled()
      const { state } = await readLive()
      return state && { ...state }
    },
    /**
     * Writes `next` under the lock, after reading the stored state again. `wanted` is never raised
     * from false to true (or from none, or a state kept for another file or viewer) unless
     * `allowRaise` says the owner's own switch did it: a stale copy in another process can lower
     * it, never raise it. Answers `{ wanted }` as written.
     */
    async write(next, { allowRaise = false } = {}) {
      const state = storedState(next)
      if (!state) throw new TypeError('not a remote entry state')
      return file.mutate(async () => {
        const current = await readLive()
        if (!current.writable) throw new Error(`${FILENAME} has a newer schema`)
        const same = current.state !== null && current.state.file === state.file && current.state.viewerPort === state.viewerPort
        const wanted = state.wanted && (allowRaise || (same && current.state.wanted))
        await file.atomicWrite({ ...(current.record ?? {}), schema: SCHEMA, ...state, wanted })
        return { wanted }
      })
    },
  })
}

module.exports = { PENDING, createRemoteEntryState, fileId, storedState }
