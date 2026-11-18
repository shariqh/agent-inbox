'use strict'
// Connect mode on the connecting Mac (#617, PR 3a): what the desktop app's main process on a
// laptop uses to reach another Mac's Inbox, the hub. Logic only: no window, no view, no IPC, no
// page (the next PR shows the hub's page in its own view and wires this module to it).
//
// Design: docs/superpowers/specs/2026-11-17-remote-inbox-design.md §3.3; architecture notes in
// docs/architecture/remote-inbox.md ("Connecting from another Mac").
//
// The device secret is a credential for the whole hub: agents there may run commands without
// asking, and a message to a session is as good as running commands. This module is the only
// thing on the laptop that holds it in plain text, and only in memory: on disk it is encrypted by
// `safeStorage` (Keychain-backed on macOS), with no plain-text fallback. It is sent only to the
// active hub's exact origin, only after this Mac's own Tailscale has shown that the hub's name
// still belongs to the node that was paired, one of this person's own untagged devices. When in
// doubt, it is not sent. Nothing here logs, and no result, error or callback carries the secret,
// the pairing code, a login or a response body.
//
// The pure rules (the address, the code and label rules mirrored from the hub, the tailnet rules
// mirrored from the mesh command line, the peer list, certificate errors, the stored file's field rules) live in
// ./remote-connect-rules.cjs, split from this file for size only. Tailscale is read only through
// ./remote-tailscale.cjs, with the full peer list (`status --json`), never changed.
const fsp = require('node:fs/promises')
const { constants } = require('node:fs')
const os = require('node:os')
const crypto = require('node:crypto')
const { createLockedFile, resolveFilePath } = require('./update-preferences.cjs')
const { isObject, runTailscale, validHost } = require('./remote-tailscale.cjs')
const {
  DEVICE_ID, HUB_ID, PLACE, SECRET, activeOf, certificateFailure, deviceLabelFor, discard, hubHref, hubLabelFor, inTailnet, isDeviceLabel, isRedirect,
  keychainReady, marked, normaliseCode, parseHubOrigin, parsePeers, readJson, suffixFrom, versionText, writeBase,
} = require('./remote-connect-rules.cjs')

const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = constants

const FILENAME = 'remote-connect.json'
const DEVICE_HEADER = 'X-Agent-Inbox-Device'

const SCHEMA = 1
const FILE_MAX = 64 * 1024
const FETCH_TIMEOUT_MS = 5_000
const PAIR_BODY_MAX = 1024
const FIRST_RETRY_MS = 2_000
const MAX_RETRY_MS = 60_000
const REFUSED_EVERY_MS = 60_000
const ONLINE_EVERY_MS = 60_000
const TICK_EVERY_MS = 1_000
const VERSION_BODY_MAX = 64 * 1024

// Tailscale could not be read: retried, and nothing is sent meanwhile
const TAILSCALE_UNREADABLE = new Set(['no_cli', 'failed', 'not_running'])

// ── the controller ─────────────────────────────────────────────────────────

/**
 * Connect mode for main: the store, pairing, the probe, the device header and the connection
 * state, in one object. Every dependency is an option (`fsImpl`, `execFile`, `exists`, `fetch`,
 * `safeStorage`, `hostname`, `now`, `randomBytes`, `setInterval`, `clearInterval`), so tests run no
 * command, open no socket, touch no Keychain and never sleep. No public operation rejects.
 */
function createRemoteConnect(options = {}) {
  const filePath = resolveFilePath(options, FILENAME)
  const fsImpl = options.fsImpl ?? fsp
  const uid = options.uid ?? process.getuid?.()
  const locked = createLockedFile(filePath, fsImpl)
  const safeStorage = options.safeStorage
  const platform = options.platform ?? process.platform
  const fetchImpl = options.fetch ?? ((url, init) => globalThis.fetch(url, init))
  const hostname = options.hostname ?? os.hostname
  const randomBytes = options.randomBytes ?? crypto.randomBytes
  const now = options.now ?? Date.now
  const setIntervalFn = options.setInterval ?? setInterval
  const clearIntervalFn = options.clearInterval ?? clearInterval
  const deps = {
    execFile: options.execFile,
    exists: options.exists,
    setTimeout: options.setTimeout ?? setTimeout,
    clearTimeout: options.clearTimeout ?? clearTimeout,
  }
  const LOCAL = Object.freeze({ mode: 'local' })

  // The active hub as last read: { id, origin, host, label, node, machine, device, blob }.
  let hub = null
  // The device secret in plain text: only here, only in memory, set once per connection state.
  let plain = null
  // Whether this connection state has seen the stored node behind the name. Nothing is sent without it.
  let verified = false
  // Rises whenever the connection state is replaced (connect, forget, a new active hub, stop), so
  // the result of an operation that started before is dropped.
  let epoch = 0
  let lastOnlineVersion = null
  let current = LOCAL
  let published = JSON.stringify(LOCAL)
  const listeners = new Set()
  // the schedule: start(), stop(), kick() and tick()
  let running = false
  let timer = null
  let ticking = null
  let kicked = false
  let dueAt = 0
  let failures = 0
  // after stop(), until start(): no probe, no header, nothing sent
  let stopped = false
  // Rises whenever anything distrusts the last node check (a kick, a failed probe, a dropped secret):
  // a check that began before it is stale and never sets `verified`.
  let checks = 0
  // forgets whose write did not land: retried at the next operation, and reported until then
  const unsaved = new Set()
  // hubs forgotten in this run: never loaded again, even when the file could not be written
  const forgotten = new Set()
  let queue = Promise.resolve()

  /** One operation at a time: connect, forget and every probe. So no two probes ever overlap. */
  function serial(operation) {
    const run = queue.then(operation, operation)
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  const no = (reason, extra) => ({ ok: false, reason, ...extra })
  const call = (callback, ...args) => {
    try {
      if (typeof callback === 'function') callback(...args)
    } catch {
      // a callback that throws stops nothing
    }
  }
  const clock = () => {
    try {
      const t = now()
      return Number.isFinite(t) ? t : 0
    } catch {
      return 0
    }
  }
  // The Keychain is asked only when a key must be written or read (a connect, a stored hub's
  // start), and by view() from then on. Never before: this Mac's own page reads view() at every
  // start, and asking macOS there would create the app's Keychain item, and could prompt, for
  // people who never use another Mac's Inbox.
  let keychainAsked = false
  const ready = () => {
    keychainAsked = true
    return keychainReady(safeStorage, platform)
  }

  function distrust() {
    verified = false
    checks += 1
  }

  function clearSecret() {
    plain = null
    distrust()
  }

  function newState() {
    clearSecret()
    epoch += 1
  }

  const hubConnection = (state, reason) => ({ mode: 'hub', id: hub.id, label: hub.label, state, reason, version: lastOnlineVersion })

  /** The connection answer; callbacks only when it changed. */
  function setConnection(next) {
    current = next
    const text = JSON.stringify(next)
    if (text === published) return
    published = text
    for (const listener of [...listeners]) call(listener, { ...next })
  }

  /**
   * The file's bytes, the hub reader's way: opened without following a symlink and without
   * blocking (a FIFO), checked on the open descriptor (a regular file this user owns, no group or
   * other bits, at most the cap), read from that descriptor. `{ missing }`, `{ problem }` or `{ raw }`.
   */
  async function readBytes() {
    let handle
    try {
      handle = await fsImpl.open(filePath, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    } catch (error) {
      if (error?.code === 'ENOENT') return { missing: true }
      return { problem: error?.code === 'ELOOP' ? 'bad_file' : 'unreadable' }
    }
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || uid === undefined || uid === null || stat.uid !== uid || (stat.mode & 0o077) !== 0) return { problem: 'bad_file' }
      if (stat.size > FILE_MAX) return { problem: 'too_large' }
      const buffer = Buffer.alloc(FILE_MAX + 1)
      let total = 0
      for (;;) {
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null)
        if (bytesRead === 0 || total + bytesRead === buffer.length) {
          total += bytesRead
          break
        }
        total += bytesRead
      }
      if (total > FILE_MAX) return { problem: 'too_large' }
      return { raw: buffer.subarray(0, total) }
    } catch {
      return { problem: 'unreadable' }
    } finally {
      try {
        await handle.close()
      } catch {
        // a handle that will not close changes nothing that was read
      }
    }
  }

  async function readStore() {
    const read = await readBytes()
    if (read.missing) return { state: 'missing' }
    if (read.problem) return { state: 'problem', problem: read.problem }
    const raw = read.raw
    let doc
    try {
      doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
    } catch {
      return { state: 'problem', problem: 'not_json' }
    }
    if (!isObject(doc)) return { state: 'problem', problem: 'not_json' }
    if (!Number.isSafeInteger(doc.schema) || doc.schema < 1) return { state: 'problem', problem: 'bad_schema' }
    if (doc.schema > SCHEMA) return { state: 'problem', problem: 'newer_schema' }
    const active = activeOf(doc)
    if (active === false) return { state: 'problem', problem: 'bad_entry', doc }
    return { state: 'ok', doc, active: active !== null && !forgotten.has(active.id) ? active : null }
  }

  /** The active hub from the file; a different one than in memory starts a new connection state. */
  async function loadActive() {
    const read = await readStore()
    const entry = read.state === 'ok' ? read.active : null
    if (entry === null) {
      if (hub !== null) {
        newState()
        hub = null
        lastOnlineVersion = null
      }
      setConnection(LOCAL)
      return null
    }
    const same = hub !== null && hub.id === entry.id && hub.origin === entry.origin && hub.node === entry.node
      && hub.device === entry.device && hub.blob === entry.secret
    if (!same) {
      newState()
      hub = { id: entry.id, origin: entry.origin, host: entry.origin.slice('https://'.length), label: entry.label, node: entry.node, machine: entry.machine, device: entry.device, blob: entry.secret }
      lastOnlineVersion = null
      setConnection(hubConnection('retrying', 'connecting'))
    } else {
      hub.label = entry.label
      hub.machine = entry.machine
    }
    return hub
  }

  async function findHub(host) {
    if (!validHost(host)) return { ok: false, reason: 'not_in_tailnet' }
    const run = await runTailscale('peers', deps)
    if (!run.ok) return { ok: false, reason: run.reason }
    return parsePeers(run.text, host)
  }

  /** The stored secret, decrypted: `{ ok, secret }`, or why not. */
  function openSecret(blob) {
    if (!ready()) return no('no_keychain')
    let text
    try {
      text = safeStorage.decryptString(Buffer.from(blob, 'base64'))
    } catch {
      return no('secret_unreadable')
    }
    return typeof text === 'string' && SECRET.test(text) ? { ok: true, secret: text } : no('secret_unreadable')
  }

  /**
   * Before anything is sent in a connection state: this Mac's Tailscale must show the stored node
   * behind the hub's name, still this person's untagged device. Tailscale that cannot be read is
   * `retrying`; any other answer is `refused`. Either way the secret is not sent.
   */
  async function verify(snapshot, at) {
    const mark = checks
    const found = await findHub(snapshot.host)
    // a kick, a stop, a forget or a failed probe since the read began: its answer may be old
    if (at !== epoch || mark !== checks) return { stale: true }
    if (!found.ok) {
      clearSecret()
      return { ok: false, state: TAILSCALE_UNREADABLE.has(found.reason) ? 'retrying' : 'refused', reason: found.reason }
    }
    if (found.node !== snapshot.node) {
      clearSecret()
      return { ok: false, state: 'refused', reason: 'node_changed' }
    }
    if (plain === null) {
      const opened = openSecret(snapshot.blob)
      if (!opened.ok) {
        distrust()
        return { ok: false, state: opened.reason === 'no_keychain' ? 'retrying' : 'refused', reason: opened.reason }
      }
      plain = opened.secret
    }
    verified = true
    return { ok: true }
  }

  /**
   * The decision for one request: `{ value, href }` when `url` is on the hub's origin and the header
   * may go, else null. A `URL`'s href is read once, the text is parsed once, and `href` is the
   * parsed value the decision was made on, so the request goes exactly there. Synchronous: no I/O.
   */
  function decide(url) {
    if (stopped || hub === null || !verified || plain === null) return null
    const href = hubHref(url, hub.origin)
    return href === null ? null : { value: plain, href }
  }

  function deviceHeaderFor(url) {
    const decided = decide(url)
    return decided === null ? null : decided.value
  }

  const refusal = (word) => Object.assign(new Error(word === 'redirect' ? 'the hub answered with a redirect' : 'not the hub origin'), { code: word })

  /** A fetch for main's own requests to the hub: its origin only, the device header, no redirect, a timeout. */
  function hubFetch() {
    return async (input, init = {}) => {
      const decided = decide(input)
      if (decided === null) throw refusal('not_hub_origin')
      const given = isObject(init) ? init : {}
      const headers = new Headers(given.headers)
      headers.set(DEVICE_HEADER, decided.value)
      const signals = [AbortSignal.timeout(FETCH_TIMEOUT_MS)]
      if (given.signal instanceof AbortSignal) signals.push(given.signal)
      const request = { method: typeof given.method === 'string' ? given.method : 'GET', headers, redirect: 'error', signal: AbortSignal.any(signals) }
      if (given.body !== undefined) request.body = given.body
      const response = await fetchImpl(decided.href, request)
      if (isRedirect(response)) {
        await discard(response)
        throw refusal('redirect')
      }
      return response
    }
  }

  /** GET /api/version with the device header: online, refused, unreachable or not_agent_inbox. */
  async function requestVersion(snapshot) {
    let response
    try {
      response = await hubFetch()(`${snapshot.origin}/api/version`, { method: 'GET' })
    } catch (error) {
      // held back since the node check (a kick, a stop, a forget): nothing was sent
      if (error?.code === 'not_hub_origin') return { state: 'held' }
      return { state: 'unreachable', reason: certificateFailure(error) ? 'bad_certificate' : 'unreachable' }
    }
    if (response.status === 403) {
      await discard(response)
      return { state: 'refused', reason: 'refused' }
    }
    if (response.status !== 200 || !marked(response)) {
      await discard(response)
      return { state: 'not_agent_inbox', reason: 'not_agent_inbox' }
    }
    const body = await readJson(response, VERSION_BODY_MAX)
    if (!isObject(body) || !versionText(body.current)) return { state: 'not_agent_inbox', reason: 'not_agent_inbox' }
    const machine = typeof body.machine === 'string' && PLACE.test(body.machine) ? body.machine : null
    return { state: 'online', reason: null, version: body.current, machine }
  }

  /**
   * Records a probe's outcome as the connection state and schedules the next: 60 seconds while
   * online or refused, else a backoff from 2 seconds doubling to 60. A version that differs from
   * the last online probe's calls onReload once.
   */
  function apply(outcome) {
    const t = clock()
    if (outcome.state === 'online') {
      failures = 0
      dueAt = t + ONLINE_EVERY_MS
      const changed = lastOnlineVersion !== null && outcome.version !== lastOnlineVersion
      lastOnlineVersion = outcome.version
      setConnection(hubConnection('online', null))
      if (changed) call(options.onReload)
    } else if (outcome.state === 'refused') {
      distrust()
      failures = 0
      dueAt = t + REFUSED_EVERY_MS
      setConnection(hubConnection('refused', outcome.reason))
    } else {
      // unreachable, not an Agent Inbox, or Tailscale unreadable: nothing is sent until the next check passes
      distrust()
      failures += 1
      dueAt = t + Math.min(FIRST_RETRY_MS * 2 ** (failures - 1), MAX_RETRY_MS)
      setConnection(hubConnection('retrying', outcome.reason))
    }
  }

  /** The first online probe after pairing stores the hub's machine and the label taken from it. */
  async function recordMachine(snapshot, machine, at) {
    try {
      await locked.mutate(async () => {
        const read = await readStore()
        if (read.state !== 'ok' || read.active === null || read.active.id !== snapshot.id || read.active.device !== snapshot.device || read.active.machine !== null) return
        const label = hubLabelFor(machine, snapshot.host)
        const entry = { ...read.doc.hubs[snapshot.id], machine, label }
        await locked.atomicWrite({ ...read.doc, hubs: { ...read.doc.hubs, [snapshot.id]: entry } })
        if (at === epoch && hub !== null && hub.id === snapshot.id) {
          hub.machine = machine
          hub.label = label
          if (current.mode === 'hub') setConnection({ ...current, label })
        }
      })
    } catch {
      // the next online probe tries again
    }
  }

  /** One probe of the active hub: the node check, every time, then GET /api/version. */
  async function probeActive() {
    if (stopped) return no('stopped')
    await saveForgets()
    if (stopped) return no('stopped')
    const snapshot = await loadActive()
    if (snapshot === null) {
      // nothing to probe: the file is read again in a minute (connect() starts at once)
      dueAt = clock() + ONLINE_EVERY_MS
      return no('no_hub')
    }
    const at = epoch
    const check = await verify(snapshot, at)
    if (check.stale || at !== epoch) return no('changed')
    if (!check.ok) {
      apply(check)
      return no(check.reason)
    }
    const result = await requestVersion(snapshot)
    if (at !== epoch || result.state === 'held') return no('changed')
    apply(result)
    if (result.state === 'online' && result.machine !== null && snapshot.machine === null) await recordMachine(snapshot, result.machine, at)
    return { ok: true, state: result.state, version: result.version ?? null, machine: result.machine ?? null }
  }

  /** POST /api/remote/pair: exactly { code, label }, its Origin and Content-Type, nothing else; `{ ok, device, secret }` or a fixed word. */
  async function pair(origin, code, label) {
    let response
    try {
      response = await fetchImpl(`${origin}/api/remote/pair`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, label }),
        redirect: 'error',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch (error) {
      return no(certificateFailure(error) ? 'bad_certificate' : 'unreachable')
    }
    // the hub answers the same bare 403 for a wrong or expired code and for a login it does not allow
    if (response.status === 403) {
      await discard(response)
      return no('refused')
    }
    if (response.status !== 200 || !marked(response)) {
      await discard(response)
      return no('not_agent_inbox')
    }
    const body = await readJson(response, PAIR_BODY_MAX)
    if (!isObject(body) || body.ok !== true || typeof body.device !== 'string' || !DEVICE_ID.test(body.device)
      || typeof body.secret !== 'string' || !SECRET.test(body.secret)) return no('not_agent_inbox')
    return { ok: true, device: body.device, secret: body.secret }
  }

  function thisMacLabel() {
    try {
      return deviceLabelFor(hostname())
    } catch {
      return 'Mac'
    }
  }

  async function connect(input) {
    if (platform !== 'darwin') return no('unsupported')
    if (!ready()) return no('no_keychain')
    const given = isObject(input) ? input : {}
    const parsed = parseHubOrigin(given.address)
    if (!parsed.ok) return parsed
    // a malformed code would use up one of the hub's five tries
    const code = normaliseCode(given.code)
    if (code === null) return no('bad_code')
    const replace = given.replace === true
    return serial(async () => {
      await saveForgets()
      // the file is checked before the code is spent, and again under the lock
      const before = writeBase(await readStore(), replace)
      if (before.refuse) return no(before.refuse)
      const found = await findHub(parsed.host)
      if (!found.ok) return no(found.reason)
      const paired = await pair(parsed.origin, code, thisMacLabel())
      if (!paired.ok) return paired
      let blob
      try {
        blob = Buffer.from(safeStorage.encryptString(paired.secret)).toString('base64')
      } catch {
        return no('no_keychain', { pairedOnHub: true })
      }
      const entry = { origin: parsed.origin, label: hubLabelFor(null, parsed.host), node: found.node, machine: null, device: paired.device, secret: blob }
      let id
      let replacedHub = false
      try {
        id = await locked.mutate(async () => {
          const base = writeBase(await readStore(), replace)
          if (base.refuse) return no(base.refuse)
          // this Mac stays paired on a hub it replaces, until the device is removed there
          replacedHub = isObject(base.base.hubs) && Object.keys(base.base.hubs).length > 0
          let fresh = randomBytes(4).toString('hex')
          while (isObject(base.base.hubs) && Object.hasOwn(base.base.hubs, fresh)) fresh = randomBytes(4).toString('hex')
          const doc = { ...base.base, schema: SCHEMA, active: fresh, hubs: { [fresh]: entry } }
          if (Buffer.byteLength(JSON.stringify(doc, null, 2)) > FILE_MAX) return no('too_large')
          await locked.atomicWrite(doc)
          return fresh
        })
      } catch {
        return no('write_failed', { pairedOnHub: true })
      }
      if (typeof id !== 'string') return { ...id, pairedOnHub: true }
      forgotten.delete(id)
      // a new connection state: the node was found just now, so the probe may go at once
      newState()
      failures = 0
      hub = { id, origin: entry.origin, host: parsed.host, label: entry.label, node: entry.node, machine: null, device: entry.device, blob }
      lastOnlineVersion = null
      const replaced = replacedHub ? { replacedHub: true } : {}
      if (stopped) {
        // stored, but nothing is probed or sent until start()
        setConnection(hubConnection('retrying', 'stopped'))
        return { ok: true, id, label: entry.label, state: 'retrying', reason: 'stopped', ...replaced }
      }
      setConnection(hubConnection('retrying', 'connecting'))
      const opened = openSecret(blob)
      if (opened.ok) {
        plain = opened.secret
        verified = true
      }
      await probeActive()
      if (forgotten.has(id)) return no('forgotten')
      if (current.mode !== 'hub' || current.id !== id) return no('changed')
      return { ok: true, id, label: current.label, state: current.state, reason: current.reason, ...replaced }
    })
  }

  async function forget(id) {
    if (typeof id !== 'string' || !HUB_ID.test(id)) return no('bad_id')
    // the owner asked to stop: memory first, whatever the file allows
    forgotten.add(id)
    if (hub !== null && hub.id === id) {
      newState()
      hub = null
      lastOnlineVersion = null
      setConnection(LOCAL)
    }
    return serial(async () => {
      await saveForgets()
      const result = await writeForget(id)
      if (result.ok || result.reason === 'not_found') unsaved.delete(id)
      else unsaved.add(id)
      return result
    })
  }

  /** Removes the hub's entry from the file, under the lock. */
  async function writeForget(id) {
    try {
      return await locked.mutate(async () => {
        const read = await readStore()
        if (read.state === 'missing') return { ok: true }
        if (read.state === 'problem' && read.problem !== 'bad_entry') return no(read.problem)
        const doc = read.doc
        const hubs = isObject(doc.hubs) ? { ...doc.hubs } : {}
        if (!Object.hasOwn(hubs, id)) return no('not_found')
        delete hubs[id]
        await locked.atomicWrite({ ...doc, hubs, active: doc.active === id ? null : (doc.active ?? null) })
        return { ok: true }
      })
    } catch {
      return no('write_failed')
    }
  }

  /** Writes the forgets that did not land before; the ones that land, or find nothing to remove, are done. */
  async function saveForgets() {
    for (const id of [...unsaved]) {
      const result = await writeForget(id)
      if (result.ok || result.reason === 'not_found') unsaved.delete(id)
    }
  }

  async function view() {
    await locked.settled()
    const read = await readStore()
    const entry = read.state === 'ok' ? read.active : null
    const live = entry !== null && current.mode === 'hub' && current.id === entry.id ? current : null
    return {
      available: platform === 'darwin',
      keychain: keychainAsked ? ready() : true,
      hub: entry === null ? null : {
        id: entry.id, label: entry.label, origin: entry.origin, machine: entry.machine, state: live ? live.state : null, reason: live ? live.reason : null,
      },
      // the file still holds a forgotten hub and its encrypted secret, which a restart would use
      problem: unsaved.size > 0 ? 'forget_not_saved' : read.state === 'problem' ? read.problem : null,
    }
  }

  /** The probes that are due, one after another, never two at once; a kick during one runs another after it. */
  function runTick() {
    if (ticking !== null) return ticking
    ticking = (async () => {
      for (let round = 0; round < 3 && running && (kicked || clock() >= dueAt); round += 1) {
        kicked = false
        await serial(probeActive)
      }
    })().catch(() => {}).finally(() => {
      ticking = null
    })
    return ticking
  }

  function start() {
    if (running) return ticking ?? Promise.resolve()
    running = true
    stopped = false
    distrust()
    failures = 0
    dueAt = 0
    try {
      timer = setIntervalFn(() => { runTick() }, TICK_EVERY_MS)
      timer?.unref?.()
    } catch {
      timer = null
    }
    return runTick()
  }

  const NOT_STARTED = Object.freeze({ ok: false, reason: 'not_started' })
  const STOPPED = Object.freeze({ ok: false, reason: 'stopped' })

  /** The due probes now: `{ ok: true }`, or `stopped` / `not_started`. */
  async function tick() {
    if (stopped) return { ...STOPPED }
    if (!running) return { ...NOT_STARTED }
    await runTick()
    return { ok: true }
  }

  function stop() {
    running = false
    stopped = true
    kicked = false
    try {
      if (timer !== null) clearIntervalFn(timer)
    } catch {
      // nothing more to stop
    }
    timer = null
    // a probe in flight is dropped, and the secret goes with the connection state
    newState()
    if (hub !== null) setConnection(hubConnection('retrying', 'stopped'))
  }

  /** On wake, unlock and when the network comes back: the backoff starts over and the node is checked before the next request, at once. */
  async function kick() {
    if (stopped) return { ...STOPPED }
    if (!running) return { ...NOT_STARTED }
    distrust()
    failures = 0
    kicked = true
    await runTick()
    return { ok: true }
  }

  function onConnection(callback) {
    if (typeof callback !== 'function') return () => {}
    listeners.add(callback)
    return () => {
      listeners.delete(callback)
    }
  }

  /** Wraps an operation so it never rejects. */
  const safe = (operation, fallback) => async (...args) => {
    try {
      return await operation(...args)
    } catch {
      return typeof fallback === 'function' ? fallback() : fallback
    }
  }
  const failed = { ok: false, reason: 'failed' }

  return Object.freeze({
    file: filePath,
    findHub: safe(findHub, failed),
    connect: safe(connect, failed),
    forget: safe(forget, failed),
    probeHub: safe(() => (stopped ? { ...STOPPED } : serial(probeActive)), failed),
    view: safe(view, () => ({ available: false, keychain: false, hub: null, problem: 'unreadable' })),
    connection: () => ({ ...current }),
    onConnection,
    start: safe(start, undefined),
    stop() {
      try {
        stop()
      } catch {
        // stopped as far as it could
      }
    },
    kick: safe(kick, failed),
    tick: safe(tick, failed),
    deviceHeaderFor(url) {
      try {
        return deviceHeaderFor(url)
      } catch {
        return null
      }
    },
    hubFetch,
  })
}

module.exports = {
  DEVICE_HEADER,
  certificateFailure,
  createRemoteConnect,
  deviceLabelFor,
  hubHref,
  hubLabelFor,
  inTailnet,
  isDeviceLabel,
  normaliseCode,
  parseHubOrigin,
  parsePeers,
  suffixFrom,
}
