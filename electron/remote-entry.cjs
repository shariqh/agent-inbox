'use strict'
// The hub's remote-entry controller (#617, PR 2c): what the desktop app's main process uses to
// own `remote.json` and to check Tailscale. Logic only: no window, no IPC, no page (the next PR
// wires it to IPC, a preload bridge, notifications and the Settings panel).
//
// Design: docs/superpowers/specs/2026-11-17-remote-inbox-design.md §3.2 ("Writers", "Serve's
// shape, checked by main", "Changes made behind the app's back", "The hub's Settings");
// architecture notes in docs/architecture/remote-inbox.md.
//
// Agents on the hub may run commands without asking, and a message to a session is as good as
// running commands, so turning the entry on exposes the whole hub to whoever passes the gate in
// src/viewer-remote.ts. This module decides when the entry may be on. `turnOn()` writes
// `enabled: true` only after this node's identity and Serve's shape both read ok just then. While
// the entry is on, a check that fails, or that throws, turns it off: a failed read after one retry
// 5 seconds later, anything else at once, and a turn-off that does not land is retried at every
// 5-second tick until it does. It only ever READS Tailscale, with three fixed argument lists, and
// never changes Tailscale's configuration; that half lives in ./remote-tailscale.cjs, and this
// file runs nothing itself (test/serve-state.test.ts checks both sources). It logs nothing.
//
// No callback and no `state()` carries a login, a secret hash, the owner token or a pairing code;
// `view().logins` holds the file's logins for the panel. `tailnetSelf()` (which returns this node's
// login) and `entryStatus()` are results for main only and must never be handed to a page. The
// identity comparison ignores case, as the viewer's gate does.
//
// Across restarts (PR 2e), through `options.stateStore` (./remote-entry-state.cjs), named for this
// remote.json and this viewer (the checkout build and the installed app share userData):
// - The digest of the state main last wrote or the owner accepted is kept: the watched fields
//   (`enabled`, `host`, `port`, `viewerPort`, `logins`, and each device's id, hash and whether the
//   reader keeps it; not a label that stays readable, `pairedAt` or an unknown field). A change made
//   while the app was closed is flagged at the next start. While a change is flagged, and around
//   every write main makes, the kept digest is PENDING, which no file has, so any start before the
//   review flags again, even when remote.json alone was put back to an earlier state main wrote.
//   A process that can write both files defeats this: it is a tripwire against a silent change,
//   not a boundary against a local process.
// - `wanted`, the owner's intent, is kept, so an entry the watch switched off comes back by itself
//   (design §3.5), but only when the file's watched fields are exactly those main wrote when it
//   switched off, with no flag, the same host and login as stored, and Serve ok, all read just
//   then; it writes `enabled: true` and nothing else, and never takes turnOn's identity-change path.
//   A stop for this node's identity never comes back by itself; one for Serve's shape does (see
//   stopEntry). A stop soon after a resume backs off, up to 30 minutes.
// - The owner's turnOff, the watch's stop and the repair never wait on the state store, and no call
//   to it is waited for longer than STATE_TIMEOUT_MS.
// Without a state store, none of this happens: the first read after start() is the baseline, and
// an entry the watch switched off stays off until the owner switches it on.
const fsp = require('node:fs/promises')
const { constants } = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { createLockedFile } = require('./update-preferences.cjs')
const { viewerPort: viewerPortFor } = require('./reuse.cjs')
const { PENDING, fileId, storedState } = require('./remote-entry-state.cjs')
const {
  REMOVAL_HINT, TAILSCALE_ARGS, TAILSCALE_PATHS, isObject, parseServeStatus, parseTailnetSelf, plainText, runTailscale, tailscaleCli, validHost,
} = require('./remote-tailscale.cjs')

const REMOTE_FILE = 'remote.json'
const SCHEMA = 1
const FILE_MAX = 64 * 1024
const FETCH_TIMEOUT_MS = 5_000
const CHECK_EVERY_MS = 60_000
const RETRY_AFTER_MS = 5_000
const FILE_EVERY_MS = 5_000
const CODE_RETRY_MS = 1_000
const CODE_WAIT_MS = 6_000
const CODE_WINDOW_MS = 11 * 60_000
const CODE_LIFE_MS = 10 * 60_000
const CODES_KEPT = 4
// resuming: every 5 seconds for 2 minutes after start() or the watch's own stop, then every minute
const RESUME_FAST_MS = 5_000
const RESUME_FAST_FOR_MS = 2 * 60_000
const RESUME_SLOW_MS = 60_000
// a stop within 10 minutes of a resume doubles the wait before the next: 1, 2, 4, 8, 16, then 30 minutes
const FLAP_WINDOW_MS = 10 * 60_000
const BACKOFF_MAX_MS = 30 * 60_000
// the longest any call to the state store is waited for
const STATE_TIMEOUT_MS = 5_000
const PACKAGED_PORT = 4320
const CHECKOUT_PORT = 4393

// The viewer's reader rules (src/viewer-remote.ts readRemoteSetting), mirrored;
// test/remote-entry-settings.test.ts compares the two over many files so they cannot drift.
const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = constants
// A device label by the viewer's one rule (isDeviceLabel in src/remote-pair.ts): 1 to 40
// characters, none a control (Cc), format (Cf) or lone surrogate (Cs) character
const LABEL_FORBIDDEN = /[\p{Cc}\p{Cf}\p{Cs}]/u
const DEVICE_ID = /^[0-9a-f]{16}$/
const SHA256_HEX = /^[0-9a-f]{64}$/
const PAIRED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
const CODE_SHAPE = /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/
const CODE_ID = /^[0-9a-f]{16}$/
const COUNTERS = Object.freeze(['host', 'funnel', 'login', 'path', 'origin', 'device', 'route', 'pair'])

const isPort = (value) => Number.isInteger(value) && value >= 1 && value <= 65535
const validLabel = (label) => typeof label === 'string' && Array.from(label).length >= 1 && Array.from(label).length <= 40 && !LABEL_FORBIDDEN.test(label)
// past this depth a watched value is never one the reader accepts, so it is compared as a marker
const CANONICAL_DEPTH = 32

// ── where the file is ──────────────────────────────────────────────────────

/** remote.json beside the hub database: the folder of AGENT_INBOX_DB, else ~/.agent-inbox (remoteDir in src/viewer-remote.ts). */
function remoteFile(env = process.env, home = os.homedir()) {
  const db = env.AGENT_INBOX_DB
  return path.join(db ? path.dirname(path.resolve(db)) : path.join(home, '.agent-inbox'), REMOTE_FILE)
}

// ── remote.json ────────────────────────────────────────────────────────────

/** A device entry the viewer's reader keeps: a 16-hex id, a label by the label rule, a 64-hex hash. */
function validDevice(entry) {
  return isObject(entry) && typeof entry.id === 'string' && DEVICE_ID.test(entry.id) && validLabel(entry.label)
    && typeof entry.secretSha256 === 'string' && SHA256_HEX.test(entry.secretSha256)
}

/** The reader's field rules on a parsed document: the checked setting, or the fixed reason it is off. */
function parseSetting(doc) {
  const host = typeof doc.host === 'string' ? doc.host.toLowerCase() : ''
  if (!validHost(host)) return { ok: false, reason: 'bad_host' }
  const logins = doc.logins
  if (!Array.isArray(logins) || logins.length < 1 || logins.length > 16 || !logins.every((login) => plainText(login, 254))) {
    return { ok: false, reason: 'bad_logins' }
  }
  const { port, viewerPort } = doc
  if (!isPort(viewerPort) || !isPort(port) || port < 1024 || port === viewerPort) return { ok: false, reason: 'bad_port' }
  const listed = doc.devices === undefined ? [] : doc.devices
  if (!Array.isArray(listed) || listed.length > 16) return { ok: false, reason: 'bad_devices' }
  // a malformed device is dropped, never turning the rest off, but still counted
  const devices = listed.filter(validDevice).map(({ id, label, pairedAt }) => ({
    id, label, pairedAt: typeof pairedAt === 'string' && PAIRED_AT.test(pairedAt) ? pairedAt : null,
  }))
  return {
    ok: true,
    setting: {
      enabled: doc.enabled === true, viewerPort, port, host, logins: logins.map((login) => login.toLowerCase()), devices,
      unreadableDevices: listed.length - devices.length,
    },
  }
}

/**
 * Reads remote.json by the viewer's rules: opened without following a symlink, checked on the open
 * descriptor (a regular file this user owns, no group or other bits unless `allowOpen`, at most
 * 64 KiB), strict UTF-8, a JSON object with schema 1. Never throws. Gives `{ state: 'missing' }`,
 * `{ state: 'refused', reason }`, or `{ state: 'document', doc, setting, problem }`, where
 * `setting` is null and `problem` names the field when the reader would read it as off.
 */
async function readDocument(file, fsImpl, uid, allowOpen = false) {
  const refused = (reason) => ({ state: 'refused', reason })
  if (uid === undefined || uid === null) return refused('unsupported')
  let handle
  try {
    handle = await fsImpl.open(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'missing' }
    return refused(error?.code === 'ELOOP' ? 'not_regular' : 'unreadable')
  }
  let bytes
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) return refused('not_regular')
    if (stat.uid !== uid) return refused('not_owner')
    if ((stat.mode & 0o077) && !allowOpen) return refused('open_to_others')
    if (stat.size > FILE_MAX) return refused('too_large')
    const buffer = Buffer.alloc(FILE_MAX + 1)
    let total = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null)
      if (bytesRead === 0) break
      total += bytesRead
      if (total === buffer.length) break
    }
    if (total > FILE_MAX) return refused('too_large')
    bytes = buffer.subarray(0, total)
  } catch {
    return refused('unreadable')
  } finally {
    try {
      await handle.close()
    } catch {
      // a handle that will not close changes nothing that was read
    }
  }
  let value
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return refused('not_json')
  }
  if (!isObject(value)) return refused('not_object')
  if (!Number.isSafeInteger(value.schema) || value.schema < 1) return refused('no_schema')
  // a newer schema is never read as on, and never written over
  if (value.schema > SCHEMA) return refused('newer_schema')
  const parsed = parseSetting(value)
  return parsed.ok
    ? { state: 'document', doc: value, setting: parsed.setting, problem: null }
    : { state: 'document', doc: value, setting: null, problem: parsed.reason }
}

/**
 * JSON with every object's keys sorted, so equal values give equal text. Past CANONICAL_DEPTH a
 * value is written as one marker: no reader-accepted watched value is that deep, so two such values
 * are both dormant, and a change to or from one still differs from any accepted value.
 */
function canonical(value, depth = 0) {
  if (depth > CANONICAL_DEPTH) return '"\u0000too-deep"'
  if (Array.isArray(value)) return `[${value.map((child) => canonical(child, depth + 1)).join(',')}]`
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(',')}}`
  return JSON.stringify(value === undefined ? null : value)
}

/**
 * What the outside-change watch compares: the fields that decide who gets in, as they are in the
 * file, and for each device its id, its hash and whether the reader keeps it. A label decides that
 * last part (the reader drops a device with a bad label), so an edit that makes a dormant hash live,
 * or a live one dormant, is a change; a rename that keeps it readable is not.
 */
function watchedState(read) {
  if (read.state !== 'document') return { file: read.state === 'missing' ? 'missing' : read.reason }
  const doc = read.doc
  const pick = (key) => (doc[key] === undefined ? null : doc[key])
  return {
    file: 'document',
    enabled: pick('enabled'),
    host: pick('host'),
    port: pick('port'),
    viewerPort: pick('viewerPort'),
    logins: pick('logins'),
    devices: Array.isArray(doc.devices)
      ? doc.devices.map((entry) => (isObject(entry)
        ? { id: entry.id ?? null, secretSha256: entry.secretSha256 ?? null, readable: validDevice(entry) }
        : { entry, readable: false }))
      : pick('devices'),
  }
}

const digestOf = (state) => crypto.createHash('sha256').update(canonical(state)).digest('hex')

/** The devices added at the end of the list, when nothing else changed; else null. */
function addedDevices(before, after) {
  // no state to compare with: a baseline kept only as a digest, across a restart
  if (before === null || before.file !== 'document' || after.file !== 'document') return null
  for (const key of ['enabled', 'host', 'port', 'viewerPort', 'logins']) if (canonical(before[key]) !== canonical(after[key])) return null
  const was = before.devices === null ? [] : before.devices
  if (!Array.isArray(was) || !Array.isArray(after.devices) || after.devices.length <= was.length) return null
  for (let i = 0; i < was.length; i += 1) if (canonical(was[i]) !== canonical(after.devices[i])) return null
  return after.devices.slice(was.length)
}

/** The status route's answer, only when its shape is right, copied field by field. */
function checkStatus(body) {
  if (!isObject(body)) return null
  const { on, listening, port, host, error, codePending, paired, refused } = body
  if (typeof on !== 'boolean' || typeof listening !== 'boolean' || typeof codePending !== 'boolean') return null
  if (!(port === null || isPort(port)) || !(host === null || (typeof host === 'string' && host.length <= 253))) return null
  if (!(error === null || (typeof error === 'string' && error.length <= 500))) return null
  // each pairing names the device and the code it used, so main can tell its own code from another's
  if (!Array.isArray(paired) || paired.length > 16 || !paired.every((entry) => isObject(entry)
    && typeof entry.device === 'string' && DEVICE_ID.test(entry.device) && typeof entry.codeId === 'string' && CODE_ID.test(entry.codeId))) return null
  if (!isObject(refused) || !COUNTERS.every((key) => Number.isSafeInteger(refused[key]) && refused[key] >= 0)) return null
  return {
    on, listening, port, host, error, codePending, paired: paired.map(({ device, codeId }) => ({ device, codeId })),
    refused: Object.fromEntries(COUNTERS.map((key) => [key, refused[key]])),
  }
}

/**
 * The fields the reader knows, from primitives only, for the one write that must land when the
 * document cannot be written back (an unknown field nested too deep to serialise): turning off.
 */
function knownFields(doc) {
  const known = { schema: SCHEMA, enabled: false }
  if (typeof doc.host === 'string') known.host = doc.host
  if (isPort(doc.port)) known.port = doc.port
  if (isPort(doc.viewerPort)) known.viewerPort = doc.viewerPort
  if (Array.isArray(doc.logins) && doc.logins.every((login) => typeof login === 'string')) known.logins = [...doc.logins]
  known.devices = Array.isArray(doc.devices)
    ? doc.devices.filter(validDevice).map(({ id, label, secretSha256, pairedAt }) => (
      typeof pairedAt === 'string' ? { id, label, secretSha256, pairedAt } : { id, label, secretSha256 }))
    : []
  return known
}

/** The document as written, or null when it cannot be serialised. */
function serialise(doc) {
  try {
    return `${JSON.stringify(doc, null, 2)}\n`
  } catch {
    return null
  }
}

async function discard(response) {
  try {
    await response.body?.cancel()
  } catch {
    // nothing to read
  }
}

// a reading of this node that may come right by itself (Tailscale starting, a read that failed)
const SELF_NOT_YET = new Set(['no_cli', 'failed', 'not_json', 'unreadable', 'no_dns_name', 'bad_host', 'no_login'])
const IDENTITY_STOPS = new Set(['identity_changed', 'tagged'])

/** The word state().resume gives for why the entry is not back yet, from a stop's or a check's reason. */
function waitingFor(reason) {
  if (reason === 'not_running') return 'tailscale_not_running'
  if (IDENTITY_STOPS.has(reason)) return 'needs_owner'
  if (SELF_NOT_YET.has(reason)) return 'tailscale_unreadable'
  return `serve_not_ok:${reason}`
}

// ── the controller ─────────────────────────────────────────────────────────

/**
 * Everything main needs for the remote entry, in one object: the Tailscale reads, the settings
 * store (the only writer of remote.json besides the viewer's pairing write, under the same lock),
 * the pairing code and status requests to the app's own viewer, the self test, and the watch.
 */
function createRemoteEntry(options = {}) {
  const env = options.env ?? process.env
  const file = remoteFile(env, options.home ?? os.homedir())
  const viewerPort = options.viewerPort ?? viewerPortFor({ isPackaged: options.isPackaged === true, env })
  const port = options.port ?? (options.isPackaged === true ? PACKAGED_PORT : CHECKOUT_PORT)
  const fsImpl = options.fsImpl ?? fsp
  const uid = options.uid ?? process.getuid?.()
  const ownerToken = options.ownerToken
  const fetchImpl = options.fetch ?? globalThis.fetch
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const setIntervalFn = options.setInterval ?? setInterval
  const clearIntervalFn = options.clearInterval ?? clearInterval
  const deps = {
    execFile: options.execFile,
    exists: options.exists,
    setTimeout: options.setTimeout ?? setTimeout,
    clearTimeout: options.clearTimeout ?? clearTimeout,
  }
  const call = (callback, ...args) => {
    try {
      callback?.(...args)
    } catch {
      // a callback that throws never stops the watch
    }
  }
  const locked = createLockedFile(file, fsImpl)
  const read = (allowOpen = false) => readDocument(file, fsImpl, uid, allowOpen)

  // the watch's memory
  let recorded = null // { state, digest } main last wrote or accepted
  let flag = false
  const notified = new Set()
  // the codes main's own requestCode() received, newest last: { codeId, at }; the code itself is never kept
  const codes = []
  let lastServe = null
  let lastSelf = null
  let lastCheckAt = null
  let retryAt = null
  let hintRead = false
  let stopped = null
  // a turn-off that failed: retried at every tick until it lands
  let pendingStop = null
  let flagDigest = null
  // rises with each of main's own writes, so a file check that read before one is not compared after it
  let writes = 0
  let timer = null
  let ticking = null
  // kept across restarts through the state store (PR 2e); none of it is used without one
  const stateStore = options.stateStore ?? null
  // what the kept state is for: this remote.json and this viewer (the other build shares userData)
  const stateFor = { file: fileId(file), viewerPort }
  let loading = null // the first read of the store: never rejects, settles within STATE_TIMEOUT_MS
  let loadDone = false
  let firstSeen = null // the file as first seen, when main wrote before the kept state was read
  let keptDigest = null // the digest of the state main last wrote or accepted
  let wanted = false // the owner's intent
  let ownerSetWanted = false
  let stateSaved = null
  let stateDirty = false
  let saving = Promise.resolve()
  // rises with each of the owner's own operations, so a resume checked before one never writes after it
  let intent = 0
  // rises with each start() and stop(), so a resume checked in one run of the watch never writes in another
  let runs = 0
  let startedAt = null
  let resumeAt = null
  let fastUntil = 0
  let resumedAt = null
  let flaps = 0
  let waiting = null
  let needsOwner = null
  const NO_STATUS = Object.freeze({ ok: false, reason: 'unreachable' })
  const FALLBACK_VIEW = Object.freeze({
    available: false, enabled: false, host: null, port, viewerPort, logins: [], devices: [], unreadableDevices: 0, problem: 'unreadable',
  })

  async function tailnetSelf() {
    const run = await runTailscale('self', deps)
    return run.ok ? parseTailnetSelf(run.text) : { ok: false, reason: run.reason }
  }

  async function serveState(host, servePort) {
    const run = await runTailscale('serve', deps)
    if (!run.ok) return { ok: false, reason: 'unreadable', present: false }
    try {
      return parseServeStatus(run.text, host, servePort)
    } catch {
      return { ok: false, reason: 'unreadable', present: false }
    }
  }

  function viewOf(current) {
    const base = { available: true, enabled: false, host: null, port, viewerPort, logins: [], devices: [], unreadableDevices: 0, problem: null }
    if (current.state === 'missing') return base
    if (current.state === 'refused') return { ...base, available: false, problem: current.reason }
    if (!current.setting) return { ...base, problem: current.problem }
    const setting = current.setting
    const mine = setting.viewerPort === viewerPort
    return {
      available: true,
      enabled: setting.enabled && mine,
      host: setting.host,
      port: setting.port,
      viewerPort: setting.viewerPort,
      logins: [...setting.logins],
      // never a secretSha256, never anything else from the file
      devices: setting.devices.map(({ id, label, pairedAt }) => ({ id, label, pairedAt })),
      // entries the reader drops still count toward its limit of 16, so the panel says how many
      unreadableDevices: setting.unreadableDevices,
      problem: setting.enabled && !mine ? 'other_viewer' : null,
    }
  }

  async function view() {
    await locked.settled()
    return viewOf(await read())
  }

  function record(state) {
    recorded = { state, digest: digestOf(state) }
  }

  /** A store call, never longer than STATE_TIMEOUT_MS: a call that takes longer counts as failed. */
  function bounded(callStore) {
    return new Promise((resolve, reject) => {
      let guard = null
      const done = (settle) => (value) => {
        try {
          if (guard !== null) deps.clearTimeout(guard)
        } catch {
          // the guard fires into a settled promise, which changes nothing
        }
        settle(value)
      }
      try {
        guard = deps.setTimeout(() => reject(new Error('state store timed out')), STATE_TIMEOUT_MS)
        guard?.unref?.()
      } catch {
        guard = null
      }
      Promise.resolve().then(callStore).then(done(resolve), done(reject))
    })
  }

  /**
   * Reads the kept state once. A store that fails to read, times out or answers anything else, and a
   * state kept for another remote.json or viewer, is none kept.
   */
  function loadState() {
    if (loading === null) {
      if (!stateStore) {
        loadDone = true
        loading = Promise.resolve()
        return loading
      }
      loading = (async () => {
        let stored = null
        try {
          stored = storedState(await bounded(() => stateStore.read()))
          stateSaved = true
        } catch {
          stateSaved = false
        }
        if (stored && (stored.file !== stateFor.file || stored.viewerPort !== stateFor.viewerPort)) stored = null
        keptDigest = stored ? stored.digest : null
        if (stored && !ownerSetWanted) wanted = stored.wanted
        loadDone = true
        if (firstSeen !== null) judgeFirstSeen()
      })()
    }
    return loading
  }

  /**
   * Queues one write of the kept state, after the read. While a change is flagged, while no digest
   * is kept, and for `kind: 'pending'` (before main writes remote.json), it writes PENDING, which no
   * file has: any start before the review, a crash mid-write or a failed later save, flags. `wanted`
   * is the owner's intent, or what an operation will leave; only the owner's turnOn may raise it
   * (`allowRaise`), and a store that refuses to raise it is followed. A store that fails or takes
   * longer than STATE_TIMEOUT_MS never fails the operation: `stateSaved` says so.
   */
  function queueSave(kind = 'real', { allowRaise = false, leaving } = {}) {
    if (!stateStore) return Promise.resolve()
    stateDirty = false
    saving = saving.then(async () => {
      await loadState()
      const real = kind === 'real' && !flag && recorded !== null && keptDigest !== null && keptDigest !== PENDING
      const next = { digest: real ? keptDigest : PENDING, wanted: leaving ?? wanted, ...stateFor }
      try {
        const answer = await bounded(() => stateStore.write(next, { allowRaise }))
        stateSaved = true
        // another copy switched it off since: follow the store, never the stale copy
        if (next.wanted && isObject(answer) && answer.wanted === false) wanted = false
      } catch {
        stateSaved = false
      }
    })
    return saving
  }

  /** Main wrote or accepted this state: it is the kept baseline, and while a change is flagged, the one Review accepts. */
  function keep(digest) {
    if (flag) flagDigest = digest
    if (!stateStore) return
    keptDigest = digest
    stateDirty = true
  }

  function setWanted(value, byOwner = false) {
    if (!stateStore) return
    wanted = value
    if (byOwner) ownerSetWanted = true
    stateDirty = true
  }

  /** With no digest kept, a file that is absent, or off with no device entry at all, is a quiet baseline. */
  function quietWithoutState(current) {
    if (current.state === 'missing') return true
    if (current.state !== 'document') return false
    const { enabled, devices } = current.doc
    return enabled !== true && (devices === undefined || (Array.isArray(devices) && devices.length === 0))
  }

  const quietFirst = (current, digest) => digest === keptDigest || (keptDigest === null && quietWithoutState(current))

  /** The first look after this controller was made: compared with the kept digest when there is a store. */
  function firstLook(current, state, digest) {
    if (!stateStore || (loadDone && quietFirst(current, digest))) {
      recorded = { state, digest }
      keep(digest)
      return
    }
    if (!loadDone) {
      // the owner's switch-off, or the watch's stop, ran before the kept state was read: the file
      // as it was is judged once it is
      firstSeen = { current, digest }
      recorded = { state, digest }
      return
    }
    // changed while the app was closed (or no state kept, and the file is on or holds devices):
    // the baseline stays the kept digest until the owner acknowledges
    recorded = { state: null, digest: keptDigest }
    flagOutside(digest)
  }

  function judgeFirstSeen() {
    const seen = firstSeen
    firstSeen = null
    if (!quietFirst(seen.current, seen.digest)) {
      flagOutside(seen.digest)
      // main wrote since: Review accepts the file as it now is
      if (recorded.digest !== seen.digest) flagDigest = recorded.digest
    }
    keptDigest = recorded.digest
    stateDirty = true
  }

  function flagOutside(digest) {
    flag = true
    flagDigest = digest
    // saved at once: a review is due whatever the file holds at the next start
    stateDirty = true
    if (notified.has(digest)) return
    notified.add(digest)
    call(options.onOutsideChange)
  }

  /** The codes main received within `ms`, dropping older ones (a clock that went back drops them too). */
  function recentCodes(ms) {
    const t = now()
    while (codes.length > 0 && !(t - codes[0].at <= CODE_WINDOW_MS && t >= codes[0].at)) codes.shift()
    return codes.filter((entry) => t - entry.at <= ms)
  }

  /**
   * Compares the file as read with what main last wrote or accepted. Only devices added at the
   * end, each listed in the viewer's `paired` with the id of a code main's own requestCode()
   * received in the last 11 minutes (one code per device), is an expected pairing: announced, and
   * accepted. Anything else is flagged once per distinct state; a code any other local process
   * made proves nothing. Nothing is ever reverted. Synchronous: the viewer's status is read before,
   * by the caller, so this can run under the lock and two calls can never interleave.
   *
   * Known limit: the viewer's `paired` list carries no hash, so a hash swapped under a just-paired id
   * before the next check is announced as the expected pairing; the owner's device then fails to
   * connect. The viewer's list also starts empty when it restarts, so a pairing seen across a
   * restart is flagged (the safe side).
   */
  function observe(current, status) {
    const state = watchedState(current)
    const digest = digestOf(state)
    if (recorded === null) {
      firstLook(current, state, digest)
      return
    }
    if (digest === recorded.digest) return
    const added = addedDevices(recorded.state, state)
    if (added && current.setting && recentCodes(CODE_WINDOW_MS).length >= added.length) {
      const mine = new Set(recentCodes(CODE_WINDOW_MS).map((entry) => entry.codeId))
      const used = new Set()
      const labels = added.map((entry) => {
        const device = current.setting.devices.find((known) => isObject(entry) && known.id === entry.id)
        const pairing = status.ok ? status.status.paired.find((seen) => isObject(entry) && seen.device === entry.id) : undefined
        if (!device || !pairing || !mine.has(pairing.codeId) || used.has(pairing.codeId)) return null
        used.add(pairing.codeId)
        return device.label
      })
      if (labels.every((label) => label !== null)) {
        // each code pairs once: forget the ones used
        for (let i = codes.length - 1; i >= 0; i -= 1) if (used.has(codes[i].codeId)) codes.splice(i, 1)
        recorded = { state, digest }
        keep(digest)
        for (const label of labels) call(options.onPaired, label)
        return
      }
    }
    flagOutside(digest)
  }

  /** The viewer's status when a code main asked for could explain a change, read before any lock. */
  async function statusIfNeeded() {
    return recentCodes(CODE_WINDOW_MS).length > 0 ? entryStatus() : NO_STATUS
  }

  /** The watch's file check: the status first, then the file, then observe; skipped when main wrote meanwhile. */
  async function checkFile() {
    // the first look needs the kept digest: waited for at most STATE_TIMEOUT_MS
    await loadState()
    const status = await statusIfNeeded()
    const before = writes
    const current = await read()
    if (writes !== before) return
    observe(current, status)
    // saved without waiting here: the tick waits once Serve was checked
    if (stateDirty) queueSave()
  }

  /**
   * One write under the lock. `change(current)` returns `{ doc }` to write, `{ refuse }`, or `{}`
   * for nothing to do. The file as read under the lock is observed first, so a change made
   * outside the app is flagged and never hidden by main's own write.
   */
  async function write(change, { off = false, allowRaise = false, leaving } = {}) {
    // Nothing that waits on a process or the network runs under the lock: the viewer's pairing write
    // waits at most about 5 seconds for it. So the viewer's status is read first, and only when a
    // code main asked for could explain a change; under the lock it is only compared, synchronously.
    // A pairing that lands after that read is flagged.
    //
    // `off`: the owner's switch-off, the watch's stop and the repair never wait on the state store;
    // they write the file and leave the state to follow.
    const loaded = loadState()
    if (!off) await loaded
    const status = await statusIfNeeded()
    // before remote.json changes, the kept state says a review is due, with the `wanted` the
    // operation will leave; the real digest follows the write
    const before = queueSave('pending', { allowRaise, leaving })
    if (!off) await before
    let outcome
    try {
      outcome = await locked.mutate(async () => {
        const current = await read()
        observe(current, status)
        const decided = await change(current)
        if (decided.refuse) return { ok: false, reason: decided.refuse }
        if (!decided.doc) return { ok: true }
        let doc = decided.doc
        let text = serialise(doc)
        let unknownFieldsDropped = false
        // only turning off falls back to the known fields: that write must land
        if (text === null && decided.fallback) {
          doc = decided.fallback
          text = serialise(doc)
          unknownFieldsDropped = true
        }
        if (text === null) return { ok: false, reason: 'not_serialisable' }
        if (Buffer.byteLength(text) > FILE_MAX) return { ok: false, reason: 'too_large_to_write' }
        await locked.atomicWrite(doc)
        writes += 1
        record(watchedState({ state: 'document', doc }))
        keep(recorded.digest)
        // any write voids a pending code (the viewer ties a code to the file it was made under)
        const voided = recentCodes(CODE_LIFE_MS).length > 0
        codes.length = 0
        return { ok: true, voidedCode: voided, unknownFieldsDropped }
      })
    } catch {
      outcome = { ok: false, reason: 'write_failed' }
    }
    // after the lock: the state store has its own
    const after = queueSave('real', { allowRaise })
    if (!off) await after
    if (!outcome.ok) return outcome
    const result = { ok: true, view: await view(), voidedCode: outcome.voidedCode === true }
    return outcome.unknownFieldsDropped ? { ...result, unknownFieldsDropped: true } : result
  }

  async function turnOn() {
    intent += 1
    await loadState()
    if (!isPort(viewerPort) || !isPort(port) || port < 1024 || port === viewerPort) return { ok: false, reason: 'port_clash', step: 'file' }
    // both, checked now: this node's identity, then Serve's shape for it
    const self = await tailnetSelf()
    if (!self.ok) return { ok: false, reason: self.reason, step: 'self' }
    const serve = await serveState(self.host, port)
    if (!serve.ok) return { ok: false, reason: serve.reason, step: 'serve' }
    let removed = 0
    let dropped = 0
    const result = await write((current) => {
      if (current.state === 'refused') return { refuse: current.reason }
      const doc = current.state === 'missing' ? { schema: SCHEMA } : current.doc
      // never take the entry over from the other build's viewer while it is on there
      if (current.setting?.enabled && current.setting.viewerPort !== viewerPort) return { refuse: 'other_viewer' }
      const listed = doc.devices === undefined ? [] : doc.devices
      if (!Array.isArray(listed)) return { refuse: 'bad_devices' }
      // devices were paired under the stored identity: another host or account voids every one
      const sameHost = typeof doc.host === 'string' && doc.host.toLowerCase() === self.host
      const sameLogins = Array.isArray(doc.logins) && doc.logins.length === 1 && typeof doc.logins[0] === 'string'
        && doc.logins[0].toLowerCase() === self.login.toLowerCase()
      // entries the reader would drop are dropped here, the one place main does not keep what it does not understand
      const readable = listed.filter(validDevice)
      const devices = sameHost && sameLogins ? readable : []
      dropped = listed.length - readable.length
      removed = readable.length - devices.length
      const next = { ...doc, schema: SCHEMA, enabled: true, host: self.host, port, viewerPort, logins: [self.login], devices }
      // never a file the viewer's reader would refuse
      if (!parseSetting(next).ok) return { refuse: 'bad_file' }
      return { doc: next }
    }, { allowRaise: true, leaving: true })
    if (!result.ok) return { ...result, step: 'file' }
    // a new episode: the last stop is history, and the owner wants the entry on
    stopped = null
    pendingStop = null
    clearResume()
    setWanted(true, true)
    await queueSave('real', { allowRaise: true })
    return { ok: true, view: result.view, voidedCode: result.voidedCode, devicesRemoved: removed, droppedEntries: dropped }
  }

  /** What an owner's operation forgets: any resume in progress, and why it waited. */
  function clearResume() {
    needsOwner = null
    waiting = null
    resumedAt = null
    flaps = 0
  }

  /** `enabled: false` and nothing else. Never waits on the state store. */
  function writeOff() {
    return write((current) => {
      if (current.state === 'missing') return {}
      if (current.state === 'refused') return { refuse: current.reason }
      return { doc: { ...current.doc, enabled: false }, fallback: knownFields(current.doc) }
    }, { off: true })
  }

  /** The owner's switch: off, and not wanted, so nothing turns it back on by itself. Never waits on the state store. */
  async function turnOff() {
    intent += 1
    clearResume()
    setWanted(false, true)
    return writeOff()
  }

  /** Removes the device with this id (never by label: labels are not unique). An unknown id changes nothing. */
  async function removeDevice(id) {
    if (typeof id !== 'string' || !DEVICE_ID.test(id)) return { ok: false, reason: 'bad_id' }
    let dropped = 0
    const result = await write((current) => {
      if (current.state === 'missing') return {}
      if (current.state === 'refused') return { refuse: current.reason }
      const listed = current.doc.devices
      if (!Array.isArray(listed) || !listed.some((entry) => validDevice(entry) && entry.id === id)) return {}
      // the write also drops every entry the reader would drop
      const kept = listed.filter((entry) => validDevice(entry) && entry.id !== id)
      dropped = listed.length - 1 - kept.length
      return { doc: { ...current.doc, devices: kept } }
    })
    return result.ok ? { ...result, droppedEntries: dropped } : result
  }

  /**
   * The one repair: a file with group or other bits is rewritten 0600, turned off, and stripped of
   * its devices, since another user may have edited it and added one. The result says how many.
   */
  async function repairPermissions() {
    intent += 1
    // whatever the repair finds, the entry stays off until the owner switches it on
    clearResume()
    setWanted(false, true)
    let removed = 0
    const result = await write(async (current) => {
      if (current.state !== 'refused' || current.reason !== 'open_to_others') return { refuse: 'not_needed' }
      const again = await read(true)
      if (again.state !== 'document') return { refuse: again.state === 'missing' ? 'missing' : again.reason }
      removed = Array.isArray(again.doc.devices) ? again.doc.devices.length : 0
      return { doc: { ...again.doc, enabled: false, devices: [] } }
    }, { off: true })
    return result.ok ? { ...result, devicesRemoved: removed } : result
  }

  async function requestCode() {
    if (!(await view()).enabled) return { ok: false, reason: 'off' }
    if (typeof ownerToken !== 'string' || ownerToken === '') return { ok: false, reason: 'no_owner_token' }
    const base = `http://127.0.0.1:${viewerPort}`
    const started = now()
    for (;;) {
      let response
      try {
        response = await fetchImpl(`${base}/api/remote-entry/code`, {
          method: 'POST',
          headers: { Origin: base, 'X-Agent-Inbox-Owner': ownerToken },
          redirect: 'error',
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
      } catch {
        return { ok: false, reason: 'unreachable' }
      }
      if (response.status === 409) {
        // the listener is not up yet
        await discard(response)
        if (now() - started >= CODE_WAIT_MS) return { ok: false, reason: 'not_listening' }
        await sleep(CODE_RETRY_MS)
        continue
      }
      if (response.status !== 200) {
        await discard(response)
        return { ok: false, reason: response.status === 403 ? 'refused' : 'failed' }
      }
      let body
      try {
        body = await response.json()
      } catch {
        return { ok: false, reason: 'bad_answer' }
      }
      if (!isObject(body) || typeof body.code !== 'string' || !CODE_SHAPE.test(body.code)
        || typeof body.expiresAt !== 'string' || Number.isNaN(Date.parse(body.expiresAt))
        || typeof body.codeId !== 'string' || !CODE_ID.test(body.codeId)) {
        return { ok: false, reason: 'bad_answer' }
      }
      // the code's id stays here, for the expected-pairing rule; the caller gets the code to show
      codes.push({ codeId: body.codeId, at: now() })
      if (codes.length > CODES_KEPT) codes.splice(0, codes.length - CODES_KEPT)
      return { ok: true, code: body.code, expiresAt: body.expiresAt }
    }
  }

  async function entryStatus() {
    let response
    try {
      response = await fetchImpl(`http://127.0.0.1:${viewerPort}/api/remote-entry`, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch {
      return { ok: false, reason: 'unreachable' }
    }
    if (response.status !== 200) {
      await discard(response)
      return { ok: false, reason: 'bad_status' }
    }
    let body
    try {
      body = await response.json()
    } catch {
      return { ok: false, reason: 'bad_shape' }
    }
    const status = checkStatus(body)
    return status ? { ok: true, status } : { ok: false, reason: 'bad_shape' }
  }

  // Settled on 2026-11-17 (Tailscale 1.102.4, macOS; design §9 item 3): a request the hub makes to
  // its own Serve address arrives with the hub user's login, so this request with no secret is a 403
  // counted under `device`. Still, nothing else (not turnOn, not the watch) depends on it.
  async function selfTest() {
    const current = await view()
    if (!current.enabled || !current.host) return { ok: false, reason: 'off', rose: null }
    const before = await entryStatus()
    if (!before.ok) return { ok: false, reason: 'no_status', rose: null }
    let status = null
    try {
      const response = await fetchImpl(`https://${current.host}/api/version`, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      status = response.status
      await discard(response)
    } catch {
      status = null
    }
    const after = await entryStatus()
    if (!after.ok) return { ok: false, reason: 'no_status', rose: null }
    const rose = COUNTERS.find((key) => after.status.refused[key] > before.status.refused[key]) ?? null
    if (status === 403 && after.status.refused.device - before.status.refused.device === 1) return { ok: true }
    return { ok: false, reason: status === null ? 'unreachable' : status !== 403 ? 'not_refused' : 'no_device_count', rose }
  }

  const READ_FAILURES = new Set(['no_cli', 'failed', 'not_json', 'unreadable'])

  /** A setting a resume may switch back on: this viewer's, this build's port, and one login (as turnOn writes). */
  const resumableFile = (setting) => setting !== null && setting.viewerPort === viewerPort && setting.port === port && setting.logins.length === 1

  /** Only the owner's switch turns the entry on again: not wanted (kept across restarts), and needsOwner says why. */
  function identityChanged() {
    if (!stateStore) return
    needsOwner = 'identity_changed'
    setWanted(false)
  }

  /**
   * The watch's stop. It never waits on the state store. A stop for this node's identity (another
   * host or login, or a tagged node) clears `wanted`: turnOn would remove every device, so only the
   * owner's switch turns it on again, across restarts too. A stop for Serve's shape (Funnel, another
   * path, a TCP forward, a foreground session) or a Tailscale that is not up does not: the resume
   * switches the entry on only when the shape is again exactly the one the owner switched on under,
   * and the owner is usually not at this Mac, so an ad-hoc `tailscale serve` run in a terminal must
   * not cost them the Inbox until they are back at the keyboard.
   */
  async function stopEntry(reason, setting) {
    if (IDENTITY_STOPS.has(reason)) identityChanged()
    const result = await writeOff()
    const t = now()
    const willResume = stateStore !== null && startedAt !== null && wanted && !flag && needsOwner === null && resumableFile(setting)
    stopped = { reason, at: t, off: result.ok, willResume }
    // a turn-off that did not land is tried again at every tick (checkServe), never left for the
    // next check, and without calling this again: so each stop is announced once. An entry switched
    // back on (by turnOn or by hand) that fails again is a new stop, announced again.
    pendingStop = result.ok ? null : reason
    // Tried again 5 seconds later, then every 5 seconds for 2 minutes. A stop within 10 minutes of a
    // resume backs off instead: 1 minute, then 2, 4, 8, 16 and at most 30 minutes, and then every
    // minute; the wait is back to normal once the entry stayed on for 10 minutes. No lockout.
    flaps = resumedAt !== null && t - resumedAt <= FLAP_WINDOW_MS ? flaps + 1 : 0
    resumeAt = t + (flaps > 0 ? Math.min(RESUME_SLOW_MS * 2 ** (flaps - 1), BACKOFF_MAX_MS) : RESUME_FAST_MS)
    fastUntil = flaps > 0 ? t : t + RESUME_FAST_FOR_MS
    // never a Tailscale wait for a stop that will not resume
    if (stateStore) waiting = willResume ? waitingFor(reason) : flag ? 'flagged' : 'needs_owner'
    call(options.onStopped, reason, { off: result.ok, willResume })
  }

  /** The resume, when it is due (see the cadence in stopEntry); true when the entry is on again. */
  async function maybeResume(t) {
    if (!stateStore || startedAt === null || !wanted || !loadDone) return false
    if (resumeAt !== null && t < resumeAt) return false
    resumeAt = t + (t < fastUntil ? RESUME_FAST_MS : RESUME_SLOW_MS)
    waiting = await tryResume()
    return waiting === null
  }

  /**
   * Switches the entry back on, only when all of this holds now: no flag and no identity change
   * seen; the file passes the reader, is for this viewer and port, holds one login and is off; its
   * watched fields are exactly those main last wrote and kept (`enabled`, `host`, `port`,
   * `viewerPort`, `logins`, and each device's id, hash and whether the reader keeps it; not a label
   * that stays readable, `pairedAt` or an unknown field), so a file switched off or edited by
   * anything else is never resumed; this node reads the stored host and the one stored login
   * (ignoring case); and Serve is ok for them. It writes `enabled: true` and nothing else, under the
   * lock, after reading the file again and finding it equal to the one checked, while the watch is
   * still started and no owner operation ran. Never turnOn's path: no device is ever removed.
   */
  async function tryResume() {
    if (flag) return 'flagged'
    if (needsOwner !== null) return 'needs_owner'
    const epoch = intent
    const run = runs
    const before = writes
    const checked = await read()
    // the state main last wrote and kept (with no flag, main's in-memory baseline is the same digest)
    if (digestOf(watchedState(checked)) !== keptDigest) return 'changed_outside'
    const setting = checked.state === 'document' ? checked.setting : null
    if (!resumableFile(setting) || setting.enabled) return 'needs_owner'
    const self = await tailnetSelf()
    const at = now()
    if (!self.ok) {
      lastSelf = { ok: false, reason: self.reason, at }
      if (self.reason === 'tagged') identityChanged()
      return waitingFor(self.reason)
    }
    const sameLogin = setting.logins[0] === self.login.toLowerCase()
    lastSelf = { ok: true, host: self.host, loginAllowed: setting.logins.includes(self.login.toLowerCase()), at }
    if (self.host !== setting.host || !sameLogin) {
      identityChanged()
      return 'needs_owner'
    }
    const answer = await serveState(setting.host, setting.port)
    hintRead = true
    lastServe = { answer, at: now() }
    if (!answer.ok) return `serve_not_ok:${answer.reason}`
    const text = serialise(checked.doc)
    const result = await write((current) => {
      if (intent !== epoch || runs !== run || writes !== before || !wanted || flag || needsOwner !== null) return { refuse: 'changed_outside' }
      // the file as read under the lock, value for value and key for key the one checked, at any depth
      if (current.state !== 'document' || text === null || serialise(current.doc) !== text) return { refuse: 'changed_outside' }
      return { doc: { ...current.doc, enabled: true } }
    })
    if (!result.ok) return result.reason === 'changed_outside' ? 'changed_outside' : 'write_failed'
    // the owner switched off while it was written: their switch wins, and no resume is announced
    if (intent !== epoch) return 'changed_outside'
    resumedAt = now()
    // a new episode, watched at once: the next tick checks Serve and the identity again
    stopped = null
    pendingStop = null
    lastCheckAt = null
    retryAt = null
    call(options.onResumed)
    return null
  }

  /** Serve's shape and this node's identity while the entry is on; one reading for the removal hint while it is off. */
  async function checkServe(force) {
    const current = await read()
    const setting = current.state === 'document' ? current.setting : null
    const active = setting !== null && setting.enabled && setting.viewerPort === viewerPort
    if (pendingStop !== null) {
      if (active) {
        const result = await writeOff()
        if (!result.ok) return
      }
      pendingStop = null
      stopped = { ...stopped, off: true }
      return
    }
    const t = now()
    if (!active) {
      retryAt = null
      if (await maybeResume(t)) return
      if (setting && (force || !hintRead)) {
        hintRead = true
        lastServe = { answer: await serveState(setting.host, setting.port), at: now() }
      }
      if (force) {
        const self = await tailnetSelf()
        lastSelf = self.ok
          ? { ok: true, host: self.host, loginAllowed: setting !== null && setting.logins.includes(self.login.toLowerCase()), at: now() }
          : { ok: false, reason: self.reason, at: now() }
      }
      return
    }
    const retrying = retryAt !== null && t >= retryAt
    if (!(force || retrying || lastCheckAt === null || t - lastCheckAt >= CHECK_EVERY_MS)) return
    lastCheckAt = t
    let reason = null
    try {
      const self = await tailnetSelf()
      if (!self.ok) {
        lastSelf = { ok: false, reason: self.reason, at: now() }
        reason = self.reason
      } else {
        // the stored logins are lowercased by the reader, so case is ignored
        const loginAllowed = setting.logins.includes(self.login.toLowerCase())
        lastSelf = { ok: true, host: self.host, loginAllowed, at: now() }
        if (self.host !== setting.host || !loginAllowed) reason = 'identity_changed'
      }
      if (reason === null) {
        const answer = await serveState(setting.host, setting.port)
        hintRead = true
        lastServe = { answer, at: now() }
        if (!answer.ok) reason = answer.reason
      }
    } catch {
      // anything that throws here is a read that failed: one more try, then off
      reason = 'unreadable'
    }
    if (reason === null) {
      retryAt = null
      return
    }
    // a read that failed gets one more try, 5 seconds later, before it counts
    if (READ_FAILURES.has(reason) && !retrying) {
      retryAt = t + RETRY_AFTER_MS
      return
    }
    retryAt = null
    await stopEntry(reason, setting)
  }

  /** Wraps an operation so it never rejects: a throw answers `fallback`. */
  const safe = (operation, fallback) => async (...args) => {
    try {
      return await operation(...args)
    } catch {
      return typeof fallback === 'function' ? fallback() : fallback
    }
  }

  async function acknowledge(digest) {
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) return { ok: false, reason: 'bad_digest' }
    await loadState()
    const before = writes
    const current = await read()
    const state = watchedState(current)
    const now_ = digestOf(state)
    if (writes !== before) return { ok: false, reason: 'changed' }
    if (now_ !== digest) {
      // the owner saw another state: the flag stays, and a state not yet announced is announced
      if (recorded !== null && now_ !== recorded.digest) flagOutside(now_)
      return { ok: false, reason: 'changed' }
    }
    recorded = { state, digest: now_ }
    flag = false
    flagDigest = null
    notified.clear()
    keep(now_)
    // The owner accepted a file that is not on here (switched off or edited by something else):
    // it stays off until they switch it on, so a resume never follows a review.
    if (!(current.state === 'document' && current.setting?.enabled && current.setting.viewerPort === viewerPort)) {
      waiting = null
      setWanted(false)
    }
    await queueSave()
    return { ok: true }
  }

  /**
   * One read for the panel's review: the view, and the digest of that same file, which is what its
   * Review button passes to acknowledge(); so what the owner accepts is what they were shown.
   */
  async function review() {
    await locked.settled()
    const current = await read()
    return { view: viewOf(current), digest: digestOf(watchedState(current)), flag }
  }

  /** state()'s fields for the state kept across restarts. */
  const keptFields = (enabled) => ({
    wanted,
    stateSaved,
    // why the entry is not back yet, and when the next try is due, while the watch waits to resume it
    resume: stateStore && startedAt !== null && wanted && !enabled && waiting !== null ? { waiting, nextAt: resumeAt } : null,
    needsOwner,
  })

  async function state() {
    await loadState()
    const current = await view()
    const present = lastServe !== null && (lastServe.answer.ok || lastServe.answer.present === true)
    return {
      view: current,
      serve: lastServe && { answer: { ...lastServe.answer }, at: lastServe.at },
      self: lastSelf && { ...lastSelf },
      flag,
      // the digest of the flagged state, for acknowledge(): only that state is accepted
      flagDigest: flag ? flagDigest : null,
      stopped: stopped && { ...stopped },
      removalHint: !current.enabled && present ? REMOVAL_HINT : null,
      ...keptFields(current.enabled),
    }
  }

  function tick() {
    if (ticking) return ticking
    ticking = (async () => {
      try {
        await checkFile()
      } catch {
        // the next tick tries again
      }
      try {
        await checkServe(false)
      } catch {
        // the next tick tries again
      }
      // the state store last, after the stop: never longer than STATE_TIMEOUT_MS a write
      if (stateDirty) queueSave()
      await saving
    })().finally(() => {
      ticking = null
    })
    return ticking
  }

  const failed = { ok: false, reason: 'failed' }
  // No public operation rejects: each answers `{ ok: false, reason }` (or an unavailable view) instead.
  return Object.freeze({
    file,
    port,
    viewerPort,
    tailnetSelf: safe(tailnetSelf, { ok: false, reason: 'failed' }),
    serveState: safe(serveState, { ok: false, reason: 'unreadable', present: false }),
    view: safe(view, () => ({ ...FALLBACK_VIEW })),
    turnOn: safe(turnOn, { ok: false, reason: 'failed', step: 'file' }),
    turnOff: safe(turnOff, failed),
    removeDevice: safe(removeDevice, failed),
    repairPermissions: safe(repairPermissions, failed),
    requestCode: safe(requestCode, failed),
    entryStatus: safe(entryStatus, { ok: false, reason: 'unreachable' }),
    selfTest: safe(selfTest, { ok: false, reason: 'failed', rose: null }),
    start() {
      if (timer !== null) return
      runs += 1
      loadState()
      try {
        // resuming is tried at once, then every 5 seconds for 2 minutes, then every minute
        startedAt = now()
        fastUntil = startedAt + RESUME_FAST_FOR_MS
        resumeAt = startedAt
      } catch {
        startedAt = null
      }
      try {
        timer = setIntervalFn(() => { tick() }, FILE_EVERY_MS)
        timer?.unref?.()
      } catch {
        timer = null
      }
      tick()
    },
    stop() {
      try {
        if (timer !== null) clearIntervalFn(timer)
      } catch {
        // nothing more to stop
      }
      timer = null
      startedAt = null
      // a resume checked before this never writes after it
      runs += 1
    },
    tick: safe(tick, undefined),
    refresh: safe(async () => {
      await tick()
      await checkFile().catch(() => {})
      await checkServe(true).catch(() => {})
    }, undefined),
    state: safe(state, () => ({
      view: { ...FALLBACK_VIEW }, serve: null, self: null, flag, flagDigest: flag ? flagDigest : null, stopped: stopped && { ...stopped }, removalHint: null,
      ...keptFields(false),
    })),
    acknowledge: safe(acknowledge, failed),
    review: safe(review, () => ({ view: { ...FALLBACK_VIEW }, digest: null, flag })),
    /** Resolves once the state store has every write queued so far (each waited for at most STATE_TIMEOUT_MS). */
    settled: safe(() => saving, undefined),
  })
}

module.exports = {
  REMOVAL_HINT,
  TAILSCALE_ARGS,
  TAILSCALE_PATHS,
  createRemoteEntry,
  parseServeStatus,
  parseTailnetSelf,
  remoteFile,
  tailscaleCli,
}
