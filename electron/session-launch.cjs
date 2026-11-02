'use strict'
// Settings → Agent sessions → "Start sessions from Agent Inbox" (issue #412
// step 3, design §9): off by default, owned by main in userData
// `session-launch.json`, and changed only through main's own IPC for the
// viewer this app started (a browser cannot turn it on).
//
// Schema 1, written by temp file and rename under the same cross-process lock
// as the update and link preferences, and read tolerantly: a missing or
// corrupt file reads as off, and a file a newer build wrote with a newer schema
// reads as off and is never overwritten. Unknown top-level fields survive a write.
const fs = require('node:fs/promises')
const { createLockedFile, resolveFilePath } = require('./update-preferences.cjs')

const FILENAME = 'session-launch.json'
const SCHEMA = 1

function parseSessionLaunch(bytes) {
  const off = { enabled: false, record: null, writable: true }
  let value
  try {
    value = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes))
  } catch {
    return off
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isSafeInteger(value.schema) || value.schema < 1) return off
  if (value.schema !== SCHEMA) return { enabled: false, record: null, writable: false }
  return { enabled: value.enabled === true, record: value, writable: true }
}

function createSessionLaunchSettings(options = {}) {
  const file = createLockedFile(resolveFilePath(options, FILENAME), options.fsImpl ?? fs)

  async function readLive() {
    const bytes = await file.readBytes()
    return bytes === null ? { enabled: false, record: null, writable: true } : parseSessionLaunch(bytes)
  }

  return Object.freeze({
    /** Whether the switch is on; any read failure is off. */
    async read() {
      await file.settled()
      try {
        return { enabled: (await readLive()).enabled }
      } catch {
        return { enabled: false }
      }
    },
    /** { enabled } after the write, or { enabled, refused: 'newer' } when a newer build owns the file. */
    setEnabled(enabled) {
      if (typeof enabled !== 'boolean') return Promise.reject(new TypeError('enabled must be boolean'))
      return file.mutate(async () => {
        const current = await readLive()
        if (!current.writable) return { enabled: current.enabled, refused: 'newer' }
        await file.atomicWrite({ ...(current.record ?? {}), schema: SCHEMA, enabled })
        return { enabled }
      })
    },
  })
}

module.exports = { createSessionLaunchSettings, parseSessionLaunch }
