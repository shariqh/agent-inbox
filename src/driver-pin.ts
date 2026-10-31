// Issue #412, step 2 — a driver run from an installed runtime pins it, so no
// prune removes the runtime under a running session. Design:
// docs/superpowers/specs/2026-10-31-driven-sessions-design.md §7 (Runtime pins).
//
// The pin is <runtime root>/.pins/<runtime id>/<launch id>, OUTSIDE the
// runtime's folder (verification rejects any file the manifest does not list):
// {v: 1, launchId, pid, startedAt}, where startedAt is this process's start as
// `ps -o lstart=` prints it under TZ=UTC and LC_ALL=C, spaces collapsed, which
// is exactly what scripts/runtime-config.mjs (processStartTimes) compares when
// a prune decides whether the pin still counts. The driver writes it before it
// starts copilot and removes it on every exit it sees; a pin a crash leaves
// behind never counts, and the next prune sweeps it.
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync, constants } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const MANIFEST_FILE = 'runtime-manifest.json'
const PINS_DIR = '.pins'

export interface InstalledRuntime {
  root: string
  runtimeId: string
}

/**
 * The installed runtime `entryFile` (this process's `dist/driver-cli.js`) runs
 * from: its folder's manifest names it as an Agent Inbox runtime. Null for a
 * checkout, which pins nothing.
 */
export function installedRuntimeOf(entryFile: string): InstalledRuntime | null {
  const dir = dirname(dirname(entryFile))
  try {
    const manifest = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8')) as { product?: unknown; runtimeId?: unknown }
    if (manifest.product !== 'agent-inbox-runtime' || manifest.runtimeId !== basename(dir)) return null
    return { root: dirname(dir), runtimeId: basename(dir) }
  } catch {
    return null
  }
}

/** When `pid` started, as the prunes read it; null when ps cannot say. */
export function processStartedAt(pid: number): string | null {
  try {
    const ps = ['/bin/ps', '/usr/bin/ps'].find((path) => existsSync(path))
    if (!ps) return null
    const out = execFileSync(ps, ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: '/usr/bin:/bin', TZ: 'UTC', LC_ALL: 'C' },
      timeout: 10_000,
    }).trim().replace(/\s+/g, ' ')
    return out || null
  } catch {
    return null
  }
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

/** Writes the pin (temp file, fsync, rename) and returns its path. Throws when it cannot. */
export function writePin(runtime: InstalledRuntime, pin: { launchId: string; pid: number; startedAt: string }): string {
  const pins = join(runtime.root, PINS_DIR)
  ownFolder(pins)
  const dir = join(pins, runtime.runtimeId)
  ownFolder(dir)
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

/** Removes this launch's pin, when it is still a plain file naming the launch. Never throws. */
export function removePin(path: string, launchId: string): void {
  try {
    const st = lstatSync(path)
    if (!st.isFile()) return
    if ((JSON.parse(readFileSync(path, 'utf8')) as { launchId?: unknown }).launchId !== launchId) return
    unlinkSync(path)
  } catch { /* gone already: nothing to do */ }
}
