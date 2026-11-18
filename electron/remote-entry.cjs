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
// src/viewer-remote.ts. This module decides when the entry may be on, and every doubt leaves it
// off. It only ever READS Tailscale, with two fixed argument lists, and never changes Tailscale's
// configuration; that half lives in ./remote-tailscale.cjs, and this file runs nothing itself
// (test/serve-state.test.ts checks both sources). It logs nothing. No callback and no state it hands out carries a login (except
// view().logins), a secret hash, the owner token or a pairing code.
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
// Unicode format characters (general category Cf: bidi controls, zero-width joiners) in a label:
// the viewer's reader refuses them too once the pairing branch's tightened rule lands
const FORMAT = /\p{Cf}/u
const DEVICE_ID = /^[0-9a-f]{16}$/
const SHA256_HEX = /^[0-9a-f]{64}$/
const PAIRED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
const CODE_SHAPE = /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/
const CODE_ID = /^[0-9a-f]{16}$/
const COUNTERS = Object.freeze(['host', 'funnel', 'login', 'path', 'origin', 'device', 'route', 'pair'])

const isPort = (value) => Number.isInteger(value) && value >= 1 && value <= 65535
const validLabel = (label) => plainText(label, 40) && !FORMAT.test(label)

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
    await handle.close().catch(() => {})
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

/** JSON with every object's keys sorted, so equal values give equal text. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value === undefined ? null : value)
}

/** What the outside-change watch compares: the fields that decide who gets in, as they are in the file. */
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
      ? doc.devices.map((entry) => (isObject(entry) ? { id: entry.id ?? null, secretSha256: entry.secretSha256 ?? null } : entry))
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
  let stopNotified = false
  let timer = null
  let ticking = null
  let fileChecks = Promise.resolve()

  async function tailnetSelf() {
    const run = await runTailscale('self', deps)
    return run.ok ? parseTailnetSelf(run.text) : { ok: false, reason: run.reason }
  }

  async function serveState(host, servePort) {
    const run = await runTailscale('serve', deps)
    if (!run.ok) return { ok: false, reason: 'unreadable', present: false }
    return parseServeStatus(run.text, host, servePort)
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

  /** Runs `step` after every earlier observation, one at a time, so a pairing is never announced twice. */
  function serialized(step) {
    const run = fileChecks.then(step)
    fileChecks = run.catch(() => {})
    return run
  }

  /**
   * Compares the file as read with what main last wrote or accepted. Only devices added at the
   * end, each listed in the viewer's `paired` with the id of a code main's own requestCode()
   * received in the last 11 minutes (one code per device), is an expected pairing: announced, and
   * accepted. Anything else is flagged once per distinct state; a code any other local process
   * made proves nothing. Nothing is ever reverted.
   */
  async function observe(current, knownStatus) {
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
      const status = knownStatus ?? await entryStatus()
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

  /** The watch's file check: read, then observe. */
  function checkFile() {
    return serialized(async () => observe(await read()))
  }

  /**
   * One write under the lock. `change(current)` returns `{ doc }` to write, `{ refuse }`, or `{}`
   * for nothing to do. The file as read under the lock is observed first, so a change made
   * outside the app is flagged and never hidden by main's own write.
   */
  async function write(change) {
    // Nothing that waits on a process or the network runs under the lock: the viewer's pairing write
    // waits at most about 5 seconds for it. So the viewer's status is asked for first, and only when
    // a code main asked for could explain a change; a pairing that lands after it is flagged.
    const status = recentCodes(CODE_WINDOW_MS).length > 0 ? await entryStatus() : { ok: false, reason: 'unreachable' }
    let outcome
    try {
      outcome = await locked.mutate(async () => {
        const current = await read()
        await serialized(() => observe(current, status))
        const decided = await change(current)
        if (decided.refuse) return { ok: false, reason: decided.refuse }
        if (!decided.doc) return { ok: true }
        if (Buffer.byteLength(`${JSON.stringify(decided.doc, null, 2)}\n`) > FILE_MAX) return { ok: false, reason: 'too_large_to_write' }
        await locked.atomicWrite(decided.doc)
        record(watchedState({ state: 'document', doc: decided.doc }))
        // any write voids a pending code (the viewer ties a code to the file it was made under)
        const voided = recentCodes(CODE_LIFE_MS).length > 0
        codes.length = 0
        return { ok: true, voidedCode: voided }
      })
    } catch {
      return { ok: false, reason: 'write_failed' }
    }
    return outcome.ok ? { ok: true, view: await view(), voidedCode: outcome.voidedCode === true } : outcome
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
    stopNotified = false
    return { ok: true, view: result.view, voidedCode: result.voidedCode, devicesRemoved: removed, droppedEntries: dropped }
  }

  function turnOff() {
    return write((current) => {
      if (current.state === 'missing') return {}
      if (current.state === 'refused') return { refuse: current.reason }
      return { doc: { ...current.doc, enabled: false } }
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

  /** The one repair: a file with group or other bits is rewritten 0600 and turned off (another user may have edited it). */
  function repairPermissions() {
    return write(async (current) => {
      if (current.state !== 'refused' || current.reason !== 'open_to_others') return { refuse: 'not_needed' }
      const again = await read(true)
      if (again.state !== 'document') return { refuse: again.state === 'missing' ? 'missing' : again.reason }
      return { doc: { ...again.doc, enabled: false } }
    })
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

  // OPEN QUESTION (design §9 item 3): whether a request from the hub to its own Serve address
  // carries the hub user's login is not yet known on a real machine. If it does not, this test
  // sees `login` rise instead of `device`, and the panel should say to test from the other Mac.
  // So nothing else (not turnOn, not the watch) depends on it.
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
    if (!stopNotified) {
      stopNotified = true
      call(options.onStopped, reason, { off: result.ok })
    }
  }

  /** Serve's shape and this node's identity while the entry is on; one reading for the removal hint while it is off. */
  async function checkServe(force) {
    const current = await read()
    const setting = current.state === 'document' ? current.setting : null
    const active = setting !== null && setting.enabled && setting.viewerPort === viewerPort
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
    const self = await tailnetSelf()
    let reason = null
    if (!self.ok) {
      lastSelf = { ok: false, reason: self.reason, at: now() }
      reason = self.reason
    } else {
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
    if (reason === null) {
      retryAt = null
      stopNotified = false
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

  return Object.freeze({
    file,
    port,
    viewerPort,
    tailnetSelf,
    serveState,
    view,
    turnOn,
    turnOff,
    removeDevice,
    repairPermissions,
    requestCode,
    entryStatus,
    selfTest,
    start() {
      if (timer !== null) return
      timer = setIntervalFn(() => { tick() }, FILE_EVERY_MS)
      timer?.unref?.()
      tick()
    },
    stop() {
      if (timer !== null) clearIntervalFn(timer)
      timer = null
    },
    tick,
    async refresh() {
      await tick()
      await checkFile().catch(() => {})
      await checkServe(true).catch(() => {})
    },
    async state() {
      const current = await view()
      const present = lastServe !== null && (lastServe.answer.ok || lastServe.answer.present === true)
      return {
        view: current,
        serve: lastServe && { answer: { ...lastServe.answer }, at: lastServe.at },
        self: lastSelf && { ...lastSelf },
        flag,
        stopped: stopped && { ...stopped },
        removalHint: !current.enabled && present ? REMOVAL_HINT : null,
      }
    },
    async acknowledge() {
      await fileChecks
      record(watchedState(await read()))
      flag = false
      notified.clear()
    },
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
