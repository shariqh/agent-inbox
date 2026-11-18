'use strict'
// What the hub's remote-entry controller keeps across restarts (#617, PR 2e): userData
// `remote-entry-state.json`, `{ schema: 1, digest, wanted }`. electron/remote-entry.cjs is the only
// module that requires this one; split from it for size only.
//
// `digest` is the SHA-256 of the remote.json state the controller last wrote or the owner accepted,
// so a change made while the app was closed is flagged at the next start. `wanted` is the owner's
// intent: the switch was turned on and not turned off since, so an entry the watch switched off
// (Tailscale not up yet after a restart) may come back by itself.
//
// This is a tripwire against a silent change, not a boundary: a local process that can write
// remote.json can write this file too. Written as the update and link preferences are
// (createLockedFile: a cross-process lock, temp file and rename, mode 0600). Read tolerantly: a
// missing or bad file is no state; a newer schema is no state and is never overwritten; unknown
// fields are kept.
const fs = require('node:fs/promises')
const { createLockedFile, resolveFilePath } = require('./update-preferences.cjs')

const FILENAME = 'remote-entry-state.json'
const SCHEMA = 1
const DIGEST = /^[0-9a-f]{64}$/

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** `{ digest, wanted }` when both are the right shape, else null. Used on what any store returns. */
function storedState(value) {
  if (!isObject(value)) return null
  const { digest, wanted } = value
  if (!(digest === null || (typeof digest === 'string' && DIGEST.test(digest)))) return null
  if (typeof wanted !== 'boolean') return null
  return { digest, wanted }
}

/** `{ state, record, writable }` from the file's bytes. */
function parseState(bytes) {
  const none = { state: null, record: null, writable: true }
  let value
  try {
    value = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes))
  } catch {
    return none
  }
  if (!isObject(value) || !Number.isSafeInteger(value.schema) || value.schema < 1) return none
  // a newer build's file: read as no state, and never written over
  if (value.schema > SCHEMA) return { state: null, record: null, writable: false }
  return { state: storedState(value), record: value, writable: true }
}

function createRemoteEntryState(options = {}) {
  const file = createLockedFile(resolveFilePath(options, FILENAME), options.fsImpl ?? fs)

  async function readLive() {
    const bytes = await file.readBytes()
    return bytes === null ? { state: null, record: null, writable: true } : parseState(bytes)
  }

  return Object.freeze({
    async read() {
      await file.settled()
      const { state } = await readLive()
      return state && { ...state }
    },
    async write(next) {
      const state = storedState(next)
      if (!state) throw new TypeError('not a remote entry state')
      await file.mutate(async () => {
        const current = await readLive()
        if (!current.writable) throw new Error(`${FILENAME} has a newer schema`)
        await file.atomicWrite({ ...(current.record ?? {}), schema: SCHEMA, digest: state.digest, wanted: state.wanted })
      })
    },
  })
}

module.exports = { createRemoteEntryState, storedState }
