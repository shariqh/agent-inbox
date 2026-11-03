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
// Older builds keep it, as an unknown field.
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
