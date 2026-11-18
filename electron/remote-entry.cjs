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
// Known gaps, both closed by the next PR, not here:
// - A change made to remote.json while the app is closed takes effect at the next start with no
//   notification: the first read after start() is the baseline, so the device list is the only
//   record. The next PR keeps a baseline in main across restarts.
// - When Tailscale is not running or cannot be read at the first check after the app starts (the
//   app opened before Tailscale was up), the entry is switched off and stays off until the owner
//   switches it on again, against design §3.5 ("coming back by itself").
const fsp = require('node:fs/promises')
const { constants } = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { createLockedFile } = require('./update-preferences.cjs')
const { viewerPort: viewerPortFor } = require('./reuse.cjs')
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
  if (before.file !== 'document' || after.file !== 'document') return null
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

  function flagOutside(digest) {
    flag = true
    flagDigest = digest
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
      // the first look after start: nothing to compare with yet
      record(state)
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
    const status = await statusIfNeeded()
    const before = writes
    const current = await read()
    if (writes !== before) return
    observe(current, status)
  }

  /**
   * One write under the lock. `change(current)` returns `{ doc }` to write, `{ refuse }`, or `{}`
   * for nothing to do. The file as read under the lock is observed first, so a change made
   * outside the app is flagged and never hidden by main's own write.
   */
  async function write(change) {
    // Nothing that waits on a process or the network runs under the lock: the viewer's pairing write
    // waits at most about 5 seconds for it. So the viewer's status is read first, and only when a
    // code main asked for could explain a change; under the lock it is only compared, synchronously.
    // A pairing that lands after that read is flagged.
    const status = await statusIfNeeded()
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
        // any write voids a pending code (the viewer ties a code to the file it was made under)
        const voided = recentCodes(CODE_LIFE_MS).length > 0
        codes.length = 0
        return { ok: true, voidedCode: voided, unknownFieldsDropped }
      })
    } catch {
      return { ok: false, reason: 'write_failed' }
    }
    if (!outcome.ok) return outcome
    const result = { ok: true, view: await view(), voidedCode: outcome.voidedCode === true }
    return outcome.unknownFieldsDropped ? { ...result, unknownFieldsDropped: true } : result
  }

  async function turnOn() {
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
    })
    if (!result.ok) return { ...result, step: 'file' }
    // a new episode: the last stop is history
    stopped = null
    pendingStop = null
    return { ok: true, view: result.view, voidedCode: result.voidedCode, devicesRemoved: removed, droppedEntries: dropped }
  }

  function turnOff() {
    return write((current) => {
      if (current.state === 'missing') return {}
      if (current.state === 'refused') return { refuse: current.reason }
      return { doc: { ...current.doc, enabled: false }, fallback: knownFields(current.doc) }
    })
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
    let removed = 0
    const result = await write(async (current) => {
      if (current.state !== 'refused' || current.reason !== 'open_to_others') return { refuse: 'not_needed' }
      const again = await read(true)
      if (again.state !== 'document') return { refuse: again.state === 'missing' ? 'missing' : again.reason }
      removed = Array.isArray(again.doc.devices) ? again.doc.devices.length : 0
      return { doc: { ...again.doc, enabled: false, devices: [] } }
    })
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

  async function stopEntry(reason) {
    const result = await turnOff()
    stopped = { reason, at: now(), off: result.ok }
    // a turn-off that did not land is tried again at every tick (checkServe), never left for the
    // next check, and without calling this again: so each stop is announced once. An entry switched
    // back on (by turnOn or by hand) that fails again is a new stop, announced again.
    pendingStop = result.ok ? null : reason
    call(options.onStopped, reason, { off: result.ok })
  }

  /** Serve's shape and this node's identity while the entry is on; one reading for the removal hint while it is off. */
  async function checkServe(force) {
    const current = await read()
    const setting = current.state === 'document' ? current.setting : null
    const active = setting !== null && setting.enabled && setting.viewerPort === viewerPort
    if (pendingStop !== null) {
      if (active) {
        const result = await turnOff()
        if (!result.ok) return
      }
      pendingStop = null
      stopped = { ...stopped, off: true }
      return
    }
    const t = now()
    if (!active) {
      retryAt = null
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
    await stopEntry(reason)
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
    return { ok: true }
  }

  async function state() {
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
    },
    tick: safe(tick, undefined),
    refresh: safe(async () => {
      await tick()
      await checkFile().catch(() => {})
      await checkServe(true).catch(() => {})
    }, undefined),
    state: safe(state, () => ({
      view: { ...FALLBACK_VIEW }, serve: null, self: null, flag, flagDigest: flag ? flagDigest : null, stopped: stopped && { ...stopped }, removalHint: null,
    })),
    acknowledge: safe(acknowledge, failed),
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
