// Issue #412 — runtimes a running `agent-inbox-driver` is pinned to, and
// what a running process IS (its start identity). ONE module, read by every
// side that decides: the driver writes its pin with processIdentity
// (src/driver-pin.ts), runtime-config.mjs adds live pins to "uses" for the
// installer's prune and rollback (classifyRuntimeReference) and for
// prune-runtimes.sh (findUnusedRuntimes), runtime-payload.mjs's prune reads
// them again after it has moved a runtime aside (pinHolds), and
// src/runtime-inventory.ts mirrors the reading rules for Setup. Node core only.
//
// A pin is <runtime root>/.pins/<runtime id>/<launch id>, a small JSON file:
// {v: 1, launchId, pid, startedAt}, where startedAt is the driver's start
// identity (processIdentity). It sits OUTSIDE the runtime's own folder,
// because verification rejects any file the manifest does not list.
//
// A pin counts only while its driver runs: a real file (never a symlink),
// owned by this user, directly in a real `.pins/<id>/` folder owned by this
// user, under a real `.pins` folder owned by this user, whose pid still has
// the very start identity the pin recorded. Anything else is ignored (a
// malformed or foreign pin never keeps a runtime), and a valid pin whose
// driver is gone is stale: the driver removes its own pin on every exit it
// sees, and sweepStalePins (each prune under the setup lock) removes up to 64
// that a crash left behind. A `.pins` folder or a pin that exists but cannot
// be read, or an identity that cannot be read, makes the answer unknown:
// errors only ever keep.
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

export const PINS_DIR = '.pins'
const PIN_MAX_BYTES = 1024
const PIN_SWEEP_LIMIT = 64
const LAUNCH_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const PS_CANDIDATES = ['/bin/ps', '/usr/bin/ps']

const ownedByMe = (st) => typeof process.getuid !== 'function' || st.uid === process.getuid()
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const errorText = (err) => err?.code ?? err?.message ?? String(err)

function unreadable(err) {
  const code = err?.code
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code) ? `is unreadable (${code})` : 'is unreadable'
}

// ── what a running process is ─────────────────────────────────────────────
// A pid alone is not a process: pids are reused. So a pin records its
// driver's start identity, and a reader compares it with what the pid has
// now. It must never move while the process runs:
//   linux  — `linux:<boot id>:<starttime>`: field 22 of /proc/<pid>/stat, the
//            clock ticks since boot at which it started, read directly (no
//            ps), with /proc/sys/kernel/random/boot_id so a reboot that
//            reuses the pid never matches. procps's `ps -o lstart=` is NOT
//            used there: it adds that tick count to the boot time, which
//            moves whenever the wall clock is stepped (NTP, chrony, a VM's
//            time sync, `date -s`), and a live pin would read as stale.
//   darwin — `darwin:<lstart>`: `ps -o lstart=` under TZ=UTC and LC_ALL=C,
//            spaces collapsed; the kernel's p_starttime is fixed at fork.
// Any other platform, or any read that fails, is unknown.

/**
 * The state and start time (clock ticks since boot) in one /proc/<pid>/stat
 * line, or null when it is not one. The command name (field 2) is in parens
 * and may itself hold spaces and parens, so fields are counted after the
 * LAST ')'.
 */
export function linuxProcessStart(statText) {
  if (typeof statText !== 'string') return null
  const close = statText.lastIndexOf(')')
  if (close < 0) return null
  const fields = statText.slice(close + 1).trim().split(/\s+/)
  // fields[0] is field 3 (state), so field 22 (starttime) is fields[19]
  const state = fields[0]
  const starttime = fields[19]
  if (!state || !/^[A-Za-z]$/.test(state) || !starttime || !/^\d{1,20}$/.test(starttime)) return null
  return { state, starttime }
}

/** `linux:<boot id>:<starttime>` for one stat line, or null; a zombie is no running process. */
export function linuxIdentity(statText, bootId) {
  const start = linuxProcessStart(statText)
  if (!start || start.state === 'Z' || start.state === 'X' || start.state === 'x') return null
  return `linux:${bootId}:${start.starttime}`
}

const gone = (err) => err?.code === 'ENOENT' || err?.code === 'ESRCH' || err?.code === 'ENOTDIR'

function linuxIdentities(pids, procRoot) {
  let bootId
  try {
    bootId = readFileSync(join(procRoot, 'sys', 'kernel', 'random', 'boot_id'), 'utf8').trim()
  } catch (err) {
    return { ok: false, reason: `the boot id cannot be read (${errorText(err)})` }
  }
  if (!/^[0-9A-Za-z-]{1,64}$/.test(bootId)) return { ok: false, reason: 'the boot id is not one' }
  const ids = new Map()
  for (const pid of pids) {
    let text
    try {
      text = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8')
    } catch (err) {
      if (gone(err)) continue
      return { ok: false, reason: `process ${pid} cannot be read (${errorText(err)})` }
    }
    const start = linuxProcessStart(text)
    if (!start) return { ok: false, reason: `process ${pid} has a stat line this cannot read` }
    const identity = linuxIdentity(text, bootId)
    if (identity !== null) ids.set(pid, identity)
  }
  return { ok: true, ids }
}

function darwinIdentities(pids, psBin) {
  if (!psBin) return { ok: false, reason: 'ps was not found' }
  let output
  try {
    output = execFileSync(psBin, ['-o', 'pid=,lstart=', '-p', pids.join(',')], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: '/usr/bin:/bin', TZ: 'UTC', LC_ALL: 'C' },
      timeout: 15_000,
    })
  } catch (err) {
    // ps exits 1 when none of the pids is running, and says nothing
    if (err?.status === 1 && String(err.stdout ?? '').trim() === '') return { ok: true, ids: new Map() }
    return { ok: false, reason: `ps failed (${errorText(err)})` }
  }
  const ids = new Map()
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\S.*\S)\s*$/.exec(line)
    if (match) ids.set(Number(match[1]), `darwin:${match[2].replace(/\s+/g, ' ')}`)
  }
  return { ok: true, ids }
}

/**
 * The start identity of each of `pids` that is running. A pid that is not
 * running is absent from the map. Never throws: {ok:false, reason} when the
 * platform has no identity this reads, or a read fails.
 */
export function processIdentities(pids, {
  platform = process.platform,
  procRoot = '/proc',
  psBin = PS_CANDIDATES.find((path) => existsSync(path)),
} = {}) {
  const unique = [...new Set(pids)]
  if (unique.length === 0) return { ok: true, ids: new Map() }
  if (platform === 'linux') return linuxIdentities(unique, procRoot)
  if (platform === 'darwin') return darwinIdentities(unique, psBin)
  return { ok: false, reason: `a process's identity cannot be read on ${platform}` }
}

/** One running process's start identity, or null when it is not running or cannot be read. */
export function processIdentity(pid, options) {
  const read = processIdentities([pid], options)
  return read.ok ? read.ids.get(pid) ?? null : null
}

// ── pins ──────────────────────────────────────────────────────────────────

/**
 * Every well-formed pin under `runtimeRoot/.pins`. Never throws:
 * {status:'ok', pins:[{runtimeId, launchId, pid, startedAt, path}]} or
 * {status:'unknown', reason} when a folder or pin that is there cannot be read.
 */
export function readRuntimePins({ runtimeRoot }) {
  const pinsDir = join(runtimeRoot, PINS_DIR)
  const unknownBecause = (path, err) => ({ status: 'unknown', reason: `${path} ${unreadable(err)}` })
  let top
  try {
    top = lstatSync(pinsDir)
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { status: 'ok', pins: [] }
    return unknownBecause(pinsDir, err)
  }
  if (!top.isDirectory() || !ownedByMe(top)) return { status: 'ok', pins: [] }
  let ids
  try {
    ids = readdirSync(pinsDir).sort()
  } catch (err) {
    return unknownBecause(pinsDir, err)
  }
  const pins = []
  for (const runtimeId of ids) {
    if (runtimeId.startsWith('.')) continue
    const dir = join(pinsDir, runtimeId)
    let st
    try {
      st = lstatSync(dir)
    } catch (err) {
      if (err?.code === 'ENOENT') continue
      return unknownBecause(dir, err)
    }
    if (!st.isDirectory() || !ownedByMe(st)) continue
    let names
    try {
      names = readdirSync(dir).sort()
    } catch (err) {
      return unknownBecause(dir, err)
    }
    for (const launchId of names) {
      if (!LAUNCH_ID_RE.test(launchId)) continue
      const path = join(dir, launchId)
      let file
      try {
        file = lstatSync(path)
      } catch (err) {
        if (err?.code === 'ENOENT') continue
        return unknownBecause(path, err)
      }
      if (!file.isFile() || !ownedByMe(file) || file.size > PIN_MAX_BYTES) continue
      let raw
      try {
        raw = readFileSync(path, 'utf8')
      } catch (err) {
        if (err?.code === 'ENOENT') continue
        return unknownBecause(path, err)
      }
      let pin
      try {
        pin = JSON.parse(raw)
      } catch {
        continue
      }
      if (!isPlainObject(pin) || pin.v !== 1 || pin.launchId !== launchId || !Number.isSafeInteger(pin.pid) || pin.pid <= 0
        || typeof pin.startedAt !== 'string' || pin.startedAt.length === 0 || pin.startedAt.length > 128) continue
      pins.push({ runtimeId, launchId, pid: pin.pid, startedAt: pin.startedAt, path })
    }
  }
  return { status: 'ok', pins }
}

/**
 * Which runtimes a running driver is pinned to, and which pins are stale.
 * Never throws: {status:'ok', live: Map<runtimeId, [{launchId, pid}]>, stale}
 * or {status:'unknown', reason}. A runtime id that is not there pins nothing.
 */
export function runtimePins({ runtimeRoot, identities = processIdentities }) {
  const read = readRuntimePins({ runtimeRoot })
  if (read.status !== 'ok') return read
  const live = new Map()
  const stale = []
  if (read.pins.length === 0) return { status: 'ok', live, stale }
  const running = identities(read.pins.map((pin) => pin.pid))
  if (!running.ok) return { status: 'unknown', reason: `the drivers pinning runtimes cannot be checked: ${running.reason}` }
  for (const pin of read.pins) {
    if (running.ids.get(pin.pid) === pin.startedAt) {
      live.set(pin.runtimeId, [...(live.get(pin.runtimeId) ?? []), { launchId: pin.launchId, pid: pin.pid }])
    } else {
      stale.push(pin)
    }
  }
  return { status: 'ok', live, stale }
}

/** How a pinned runtime is named where a host config would be: "a running agent-inbox-driver (pid 4242)". */
export function pinLabel(pid) {
  return `a running agent-inbox-driver (pid ${pid})`
}

/**
 * Removes at most `limit` stale pins (their driver is gone), then any now
 * empty `.pins/<id>/` folder owned by this user. Never follows a link, never
 * removes a pin that still counts, and removes nothing at all when the answer
 * is unknown. Run by each prune under the setup lock. Never throws.
 */
export function sweepStalePins({ runtimeRoot, limit = PIN_SWEEP_LIMIT, identities = processIdentities }) {
  const pins = runtimePins({ runtimeRoot, identities })
  if (pins.status !== 'ok') return { status: 'unknown', reason: pins.reason, removed: 0 }
  let removed = 0
  for (const pin of pins.stale) {
    if (removed >= limit) break
    try {
      const st = lstatSync(pin.path)
      if (!st.isFile() || !ownedByMe(st)) continue
      unlinkSync(pin.path)
      removed += 1
    } catch { /* gone already, or not ours to remove */ }
  }
  const pinsDir = join(runtimeRoot, PINS_DIR)
  let ids = []
  try {
    ids = readdirSync(pinsDir)
  } catch { /* nothing to tidy */ }
  for (const runtimeId of ids) {
    const dir = join(pinsDir, runtimeId)
    try {
      const st = lstatSync(dir)
      if (st.isDirectory() && ownedByMe(st) && readdirSync(dir).length === 0) rmdirSync(dir)
    } catch { /* a folder that is not empty, or not ours, stays */ }
  }
  return { status: 'ok', removed }
}

/**
 * Why runtime `runtimeId` must stay, as a sentence, or null when no running
 * driver holds it. An answer that cannot be had keeps it. runtime-payload.mjs
 * asks this after it has moved a runtime aside and before it deletes it, so a
 * pin written after the prune decided still saves the runtime.
 */
export function pinHolds({ runtimeRoot, runtimeId, identities = processIdentities }) {
  const pins = runtimePins({ runtimeRoot, identities })
  if (pins.status !== 'ok') return pins.reason
  const live = pins.live.get(runtimeId) ?? []
  return live.length > 0 ? `${pinLabel(live[0].pid)} is pinned to it` : null
}
