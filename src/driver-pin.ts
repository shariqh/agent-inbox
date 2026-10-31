// Issue #412, step 2 — a driver run from an installed runtime pins it, so no
// prune removes the runtime under a running session. Design:
// docs/superpowers/specs/2026-10-31-driven-sessions-design.md §7 (Runtime pins).
//
// The pin is <runtime root>/.pins/<runtime id>/<launch id>, OUTSIDE the
// runtime's folder (verification rejects any file the manifest does not list):
// {v: 1, launchId, pid, startedAt}, where startedAt is this process's start
// identity from scripts/runtime-pins.mjs (processIdentity), the one function
// every prune compares it with. The driver writes it before it starts copilot
// and removes it on every exit it sees; a pin a crash leaves behind never
// counts, and the next prune sweeps it.
//
// Whether this is a runtime at all is decided by LOCATION, never by whether a
// manifest happens to be readable: a driver whose own file is inside the
// runtime root must be `<root>/<id>/dist/driver-cli.js` of a runtime whose
// manifest names it, or it refuses to start. Anything outside the root (a
// checkout, an app's bundled payload) is never pruned and pins nothing.
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { PINS_DIR } from '../scripts/runtime-pins.mjs'

const MANIFEST_FILE = 'runtime-manifest.json'
const ENTRY = ['dist', 'driver-cli.js']

export interface InstalledRuntime {
  root: string
  runtimeId: string
}

type Located = { kind: 'checkout' } | { kind: 'runtime'; runtime: InstalledRuntime } | { kind: 'refuse'; reason: string }

/** Where Setup's installers and prunes keep runtimes: an absolute AGENT_INBOX_RUNTIME_ROOT, else ~/.agent-inbox/runtime. */
export function runtimeRootFor(env: NodeJS.ProcessEnv): string {
  const configured = env['AGENT_INBOX_RUNTIME_ROOT']
  return configured && isAbsolute(configured) ? configured : resolve(homedir(), '.agent-inbox', 'runtime')
}

const real = (path: string): string | null => {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

// Why the runtime folder `dir` (named `runtimeId`) is not one whose manifest names it, or null when it is.
function manifestProblem(dir: string, runtimeId: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8')) as { product?: unknown; runtimeId?: unknown }
    if (manifest.product !== 'agent-inbox-runtime' || manifest.runtimeId !== runtimeId) return `its manifest does not name runtime ${runtimeId}`
    return null
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'ENOENT' ? 'its runtime has no manifest' : `its runtime's manifest cannot be read${code ? ` (${code})` : ''}`
  }
}

/**
 * Whether `entryFile` (this process's `dist/driver-cli.js`) runs from an
 * installed runtime under `runtimeRoot`, from somewhere else (a checkout),
 * or from inside the runtime root where it cannot be pinned (refuse).
 */
export function locateRuntime(entryFile: string, runtimeRoot: string): Located {
  const folder = real(dirname(entryFile))
  const entry = real(entryFile) ?? (folder === null ? resolve(entryFile) : join(folder, basename(entryFile)))
  const root = real(runtimeRoot)
  const inside = (base: string) => entry.startsWith(base.endsWith(sep) ? base : base + sep)
  if (root === null) {
    // a root that is not there holds nothing; one that cannot be resolved is judged as written
    return inside(resolve(runtimeRoot)) ? { kind: 'refuse', reason: `the runtime root ${runtimeRoot} cannot be resolved` } : { kind: 'checkout' }
  }
  if (!inside(root)) return { kind: 'checkout' }
  const parts = relative(root, entry).split(sep)
  const runtimeId = parts[0] ?? ''
  if (parts.length !== 3 || parts[1] !== ENTRY[0] || parts[2] !== ENTRY[1] || runtimeId === '' || runtimeId.startsWith('.')) {
    return { kind: 'refuse', reason: `it runs from inside the runtime root ${root} but not from a runtime's ${ENTRY.join('/')}` }
  }
  const problem = manifestProblem(join(root, runtimeId), runtimeId)
  if (problem) return { kind: 'refuse', reason: `it runs from the runtime root ${root}, but ${problem}` }
  return { kind: 'runtime', runtime: { root, runtimeId } }
}

// A folder this user owns, made 0700 when missing; never a symlink.
function ownFolder(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
  const st = lstatSync(path)
  if (!st.isDirectory() || (typeof process.getuid === 'function' && st.uid !== process.getuid())) {
    throw new Error(`${path} is not a folder of yours`)
  }
}

interface PinFields { launchId: string; pid: number; startedAt: string }

function writePinOnce(runtime: InstalledRuntime, pin: PinFields, beforeOpen?: (dir: string) => void): string {
  const pins = join(runtime.root, PINS_DIR)
  ownFolder(pins)
  const dir = join(pins, runtime.runtimeId)
  ownFolder(dir)
  beforeOpen?.(dir)
  const path = join(dir, pin.launchId)
  const temp = join(dir, `.${pin.launchId}.${process.pid}.tmp`)
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    writeSync(fd, JSON.stringify({ v: 1, launchId: pin.launchId, pid: pin.pid, startedAt: pin.startedAt }))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, path)
  return path
}

/**
 * Writes the pin (temp file, fsync, rename) and returns its path. A prune's
 * sweep removes an EMPTY `.pins/<id>` folder, which can happen between this
 * making the folder and opening the file in it, so an ENOENT is retried once.
 * Throws when it cannot.
 */
export function writePin(runtime: InstalledRuntime, pin: PinFields, hooks: { beforeOpen?: (dir: string) => void } = {}): string {
  try {
    return writePinOnce(runtime, pin, hooks.beforeOpen)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    return writePinOnce(runtime, pin)
  }
}

/**
 * Pins `runtime` for this launch, then checks the runtime is still there: a
 * prune that moved it aside before it could see the pin has taken its
 * manifest with it, so the pin is removed and this throws, and the driver
 * refuses to start. Returns the pin's path.
 */
export function pinRuntime(runtime: InstalledRuntime, pin: PinFields, hooks: { afterWrite?: () => void } = {}): string {
  const path = writePin(runtime, pin)
  hooks.afterWrite?.()
  const problem = manifestProblem(join(runtime.root, runtime.runtimeId), runtime.runtimeId)
  if (problem) {
    removePin(path, pin.launchId)
    throw new Error(`the runtime it runs from is being removed (${problem})`)
  }
  return path
}

/** Removes this launch's pin, when it is still a plain file naming the launch. Never throws. */
export function removePin(path: string, launchId: string): void {
  try {
    const st = lstatSync(path)
    if (!st.isFile()) return
    if ((JSON.parse(readFileSync(path, 'utf8')) as { launchId?: unknown }).launchId !== launchId) return
    unlinkSync(path)
  } catch { /* gone already: nothing to do */ }
}
