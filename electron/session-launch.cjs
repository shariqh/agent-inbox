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
//
// #432 adds one optional field, `worktreeRoot`: the absolute folder session
// worktrees go under, chosen in Settings through main's own folder dialog.
// Absent (or not an absolute path) means the default, `<hub dir>/worktrees`.
// Older builds keep it, as an unknown field. `maxDrivers` (1–8) is the human's
// cap on sessions at once (#432 §5); absent means the default, 4.
const fs = require('node:fs/promises')
const path = require('node:path')
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
    /** The worktree folder chosen in Settings, or null for the default; any read failure is the default. */
    async readWorktreeRoot() {
      await file.settled()
      try {
        const root = (await readLive()).record?.worktreeRoot
        return typeof root === 'string' && path.isAbsolute(root) && !root.includes('\0') ? root : null
      } catch {
        return null
      }
    },
    /** Saves the worktree folder (null: the default); { root } after the write, or { refused: 'newer' }. */
    setWorktreeRoot(root) {
      if (root !== null && (typeof root !== 'string' || !path.isAbsolute(root))) return Promise.reject(new TypeError('root must be an absolute path or null'))
      return file.mutate(async () => {
        const current = await readLive()
        if (!current.writable) return { root: null, refused: 'newer' }
        const { worktreeRoot: _old, ...rest } = current.record ?? {}
        await file.atomicWrite({ ...rest, schema: SCHEMA, enabled: current.enabled, ...(root === null ? {} : { worktreeRoot: root }) })
        return { root }
      })
    },
    /** The cap on sessions at once chosen in Settings, or null for the default; any read failure is the default. */
    async readMaxDrivers() {
      await file.settled()
      try {
        const cap = (await readLive()).record?.maxDrivers
        return Number.isSafeInteger(cap) && cap >= 1 && cap <= 8 ? cap : null
      } catch {
        return null
      }
    },
    /** Saves the cap (1–8); { maxDrivers } after the write, or { refused: 'newer' }. */
    setMaxDrivers(cap) {
      if (!Number.isSafeInteger(cap) || cap < 1 || cap > 8) return Promise.reject(new TypeError('the cap must be 1 to 8'))
      return file.mutate(async () => {
        const current = await readLive()
        if (!current.writable) return { maxDrivers: null, refused: 'newer' }
        await file.atomicWrite({ ...(current.record ?? {}), schema: SCHEMA, enabled: current.enabled, maxDrivers: cap })
        return { maxDrivers: cap }
      })
    },
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
