'use strict'
// Updating the hub from the connecting Mac (#637), main's half on the connecting Mac. Settings →
// Use another Mac's Inbox shows the hub's version and, when the hub's own update controller has
// verified a newer release, offers to start it. Both requests go through the connection's hub fetch
// (electron/remote-connect.cjs): the hub's origin only, with the device header, no redirect and a
// timeout; the secret never leaves main. GET /api/remote/update reads what the hub reports; POST, with
// the hub's Origin and no body, asks it to update. The request names nothing: the hub installs only
// the release its own controller verified (electron/remote-update.cjs on the hub).
//
// After a start this Mac follows the update from what it already sees: the hub reports its download
// and install, its app quits and the connection retries, and it comes back on the new version, or
// it does not come back within a few minutes and has to be looked at. A hub older than this change
// has no such route and refuses it (403): it has to be updated once at that Mac.
//
// Architecture notes: docs/architecture/remote-inbox.md ("Updating the hub from another Mac").
const { discard, marked, readJson } = require('./remote-connect-rules.cjs')

const UPDATE_PATH = 'api/remote/update'
const BODY_MAX = 1024
// after a start: how long the hub may stay away before this Mac says it did not come back
const NOT_BACK_MS = 5 * 60_000
// how long the result of an update stays on screen
const KEEP_MS = 15 * 60_000
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const STATUSES = new Set(['current', 'checking', 'available', 'downloading', 'installing', 'failed'])
const REASONS = new Set(['setup_running', 'installing', 'not_here', 'nothing_newer', 'busy', 'not_ready'])
const WORD = /^[a-z_]{1,40}$/
const BUSY = new Set(['checking', 'downloading', 'installing'])
const KEYS = ['canStart', 'current', 'newer', 'reason', 'status'].join(',')

const isVersion = (value) => typeof value === 'string' && VERSION.test(value)

function isNewer(candidate, current) {
  if (!isVersion(candidate) || !isVersion(current)) return false
  const left = VERSION.exec(candidate).slice(1).map(BigInt)
  const right = VERSION.exec(current).slice(1).map(BigInt)
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index]
  }
  return false
}

/** The hub's report, exactly as its relay answers it (src/remote-update.ts), or null. */
function readSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== KEYS) return null
  const { current, status, newer, canStart, reason } = value
  if (!isVersion(current) || !STATUSES.has(status) || (newer !== null && !isVersion(newer))) return null
  if (canStart === true ? newer === null || reason !== null : canStart !== false || !REASONS.has(reason)) return null
  return { current, status, newer, canStart, reason }
}

/**
 * The hub's update for the connecting Mac's own Settings. `connect()` is the connection controller.
 * `state(id)` and `start(id)` answer for the active hub `id` only; neither rejects.
 */
function createHubUpdate(options) {
  const now = options.now ?? Date.now
  // the update this Mac started: { id, from, to, at, kicked }, kept while it is followed
  let run = null
  // the newer release the hub last offered, so a run can name it while the hub reports its steps
  let offered = null

  const answer = (phase, version, summary = null) => ({
    ok: true,
    phase,
    version: isVersion(version) ? version : null,
    status: summary?.status ?? null,
    newer: summary?.newer ?? null,
    canStart: summary?.canStart === true,
    reason: summary?.reason ?? null,
  })

  /** `{ summary }`, `{ old: true }` for a hub that refuses the route, or `{ away: true }` when it does not answer. */
  async function read(connect, base) {
    let response
    try {
      response = await connect.hubFetch()(`${base}${UPDATE_PATH}`, { method: 'GET' })
    } catch {
      return { away: true }
    }
    if (response.status === 403) {
      await discard(response)
      return { old: true }
    }
    if (response.status !== 200 || !marked(response)) {
      await discard(response)
      return { away: true }
    }
    return { summary: readSummary(await readJson(response, BODY_MAX)) }
  }

  async function state(id) {
    const connect = options.connect()
    const connection = connect?.connection()
    const base = connect?.hubBase(id) ?? null
    if (connection?.mode !== 'hub' || connection.id !== id || base === null) return { ok: false, reason: 'not_found' }
    if (run !== null && run.id !== id) run = null
    const elapsed = run === null ? 0 : now() - run.at
    if (connection.state !== 'online') {
      if (run === null) return answer('offline', connection.version)
      return answer(elapsed > NOT_BACK_MS ? 'not_back' : 'restarting', connection.version)
    }
    const got = await read(connect, base)
    if (got.away) {
      if (run === null) return answer('unreadable', connection.version)
      // the hub went away before the connection's next probe noticed: it checks now, once
      if (!run.kicked) {
        run.kicked = true
        Promise.resolve().then(() => connect.kick()).catch(() => {})
      }
      return answer(elapsed > NOT_BACK_MS ? 'not_back' : 'restarting', connection.version)
    }
    if (got.old) return answer('old_hub', connection.version)
    const summary = got.summary
    if (summary === null) return answer('unreadable', connection.version)
    if (run !== null && elapsed > KEEP_MS && !BUSY.has(summary.status)) run = null
    if (run === null) {
      offered = summary.newer
      return answer('idle', summary.current, summary)
    }
    if (isNewer(summary.current, run.from)) return answer('done', summary.current, summary)
    if (BUSY.has(summary.status)) return answer('updating', summary.current, { ...summary, newer: summary.newer ?? run.to })
    return answer('failed', summary.current, summary)
  }

  async function start(id) {
    const connect = options.connect()
    const connection = connect?.connection()
    const base = connect?.hubBase(id) ?? null
    if (connection?.mode !== 'hub' || connection.id !== id || base === null) return { ok: false, reason: 'not_found' }
    if (connection.state !== 'online' || !isVersion(connection.version)) return { ok: false, reason: 'offline' }
    let response
    try {
      // no body and no query: the hub decides what is installed
      response = await connect.hubFetch()(`${base}${UPDATE_PATH}`, { method: 'POST', headers: { Origin: base.slice(0, -1) } })
    } catch {
      return { ok: false, reason: 'unreachable' }
    }
    if (response.status === 403) {
      await discard(response)
      return { ok: false, reason: 'refused' }
    }
    const body = marked(response) ? await readJson(response, BODY_MAX) : (await discard(response), undefined)
    if (response.status === 202 && body?.ok === true) {
      run = { id, from: connection.version, to: offered, at: now(), kicked: false }
      return { ok: true }
    }
    if (response.status === 409 && body?.ok === false && typeof body.reason === 'string' && WORD.test(body.reason)) return { ok: false, reason: body.reason }
    return { ok: false, reason: 'failed' }
  }

  const safe = (operation, fallback) => async (...args) => {
    try {
      return await operation(...args)
    } catch {
      return fallback
    }
  }
  return Object.freeze({
    state: safe(state, { ok: false, reason: 'failed' }),
    start: safe(start, { ok: false, reason: 'failed' }),
  })
}

module.exports = {
  NOT_BACK_MS,
  createHubUpdate,
}
