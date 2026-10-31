// Issue #412, step 2 (PR 3): a running agent-inbox-driver pins the runtime it
// runs from, at <runtime root>/.pins/<runtime id>/<launch id>, OUTSIDE the
// runtime's own folder so it still verifies. Pins join "uses" in ONE place,
// scripts/runtime-config.mjs (runtimePins), beside scanRuntimeReferences:
// the installer's prune and rollback (`references`) and prune-runtimes.sh
// (`unused`) both read it. A pin counts only while its driver runs (pid and
// start time); a stale one is swept by each prune, at most 64 a pass.
import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installedRuntimeOf, processStartedAt, removePin, writePin } from '../src/driver-pin.js'
import { hooksHome, installRuntime, stageRuntime } from './hooks-runtime.js'
import type { HooksHome, StagedRuntime } from './hooks-runtime.js'
import { goneProcess, PIN_LAUNCH, startOf, writePinFile } from './runtime-uses.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

const REPO = resolve(import.meta.dirname, '..')
const CONFIG_CLI = join(REPO, 'scripts', 'runtime-config.mjs')
const PAYLOAD_CLI = join(REPO, 'scripts', 'runtime-payload.mjs')

type Starts = { ok: true; starts: Map<number, string> } | { ok: false; reason: string }
type Pins =
  | { status: 'ok'; live: Map<string, Array<{ launchId: string; pid: number }>>; stale: Array<{ runtimeId: string; launchId: string; path: string }> }
  | { status: 'unknown'; reason: string }
const payload = (await import(pathToFileURL(PAYLOAD_CLI).href)) as { verifyPayload(options: { root: string }): { runtimeId: string } }
const config = (await import(pathToFileURL(CONFIG_CLI).href)) as {
  runtimePins(options: { runtimeRoot: string; startTimes?: (pids: number[]) => Starts }): Pins
  sweepStalePins(options: { runtimeRoot: string; limit?: number; startTimes?: (pids: number[]) => Starts }): { status: string; removed: number }
  processStartTimes(pids: number[]): Starts
  classifyRuntimeReference(options: { runtimeRoot: string; runtimeId: string; files: string[]; startTimes?: (pids: number[]) => Starts }): { status: string; matches: Array<{ file: string; label: string }> }
}

// versions no other file stages: a runtime id is content-derived
const OLD = '1.2.2-pin412'
const APP = '1.7.0-pin412'
const OTHER_LAUNCH = '22222222-2222-4333-8444-555555555555'

const children = new Set<ChildProcess>()
afterEach(() => {
  for (const child of children) child.kill('SIGKILL')
  children.clear()
  removeScratchDirs()
})

/** A process that runs until the test ends, naming no runtime: only a pin can keep one for it. */
function standIn(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' })
  children.add(child)
  return child
}

const livePin = (pid = process.pid) => ({ pid, startedAt: startOf(pid) })

describe('what counts as a pin (#412)', () => {
  it('counts a running driver\'s pin, and calls one whose driver is gone, or whose pid now runs another process, stale', () => {
    const h = hooksHome()
    const runtime = installRuntime(h, OLD)
    writePinFile(h.runtimeRoot, runtime.runtimeId, livePin())
    writePinFile(h.runtimeRoot, runtime.runtimeId, { pid: goneProcess(), startedAt: 'Thu Jan 1 00:00:00 1970', launchId: OTHER_LAUNCH })
    writePinFile(h.runtimeRoot, 'gone-runtime', { pid: process.pid, startedAt: 'Thu Jan 1 00:00:00 1970' })
    const pins = config.runtimePins({ runtimeRoot: h.runtimeRoot })
    if (pins.status !== 'ok') throw new Error(pins.reason)
    expect([...pins.live]).toEqual([[runtime.runtimeId, [{ launchId: PIN_LAUNCH, pid: process.pid }]]])
    expect(pins.stale.map((p) => [p.runtimeId, p.launchId]).sort()).toEqual([['gone-runtime', PIN_LAUNCH], [runtime.runtimeId, OTHER_LAUNCH]].sort())
  })

  it('records what the prunes compare: a driver\'s pin of its installed runtime reads as live, and is removed on exit', () => {
    const h = hooksHome()
    const runtime = installRuntime(h, OLD)
    expect(installedRuntimeOf(join(runtime.dir, 'dist', 'driver-cli.js'))).toEqual({ root: h.runtimeRoot, runtimeId: runtime.runtimeId })
    // a checkout pins nothing
    expect(installedRuntimeOf(join(REPO, 'dist', 'driver-cli.js'))).toBeNull()
    const startedAt = processStartedAt(process.pid)!
    expect(config.processStartTimes([process.pid])).toEqual({ ok: true, starts: new Map([[process.pid, startedAt]]) })
    const path = writePin({ root: h.runtimeRoot, runtimeId: runtime.runtimeId }, { launchId: PIN_LAUNCH, pid: process.pid, startedAt })
    expect(path).toBe(join(h.runtimeRoot, '.pins', runtime.runtimeId, PIN_LAUNCH))
    expect(readdirSync(join(h.runtimeRoot, '.pins', runtime.runtimeId))).toEqual([PIN_LAUNCH])
    const pins = config.runtimePins({ runtimeRoot: h.runtimeRoot })
    expect(pins.status === 'ok' && [...pins.live.keys()]).toEqual([runtime.runtimeId])
    // the pin sits outside the runtime, which still verifies
    expect(spawnSync(process.execPath, [PAYLOAD_CLI, 'verify', '--root', runtime.dir, '--product', 'agent-inbox-runtime']).status).toBe(0)
    removePin(path, OTHER_LAUNCH) // another launch's removal leaves it
    expect(existsSync(path)).toBe(true)
    removePin(path, PIN_LAUNCH)
    removePin(path, PIN_LAUNCH)
    expect(existsSync(path)).toBe(false)
  })

  it('knows nothing when ps fails or the pins cannot be read, and the installer\'s gate then keeps the runtime', () => {
    const h = hooksHome()
    const runtime = installRuntime(h, OLD)
    writePinFile(h.runtimeRoot, runtime.runtimeId, { pid: goneProcess(), startedAt: 'x' })
    const failing = () => ({ ok: false as const, reason: 'ps failed (EPERM)' })
    expect(config.runtimePins({ runtimeRoot: h.runtimeRoot, startTimes: failing }))
      .toEqual({ status: 'unknown', reason: 'the drivers pinning runtimes cannot be checked: ps failed (EPERM)' })
    expect(config.classifyRuntimeReference({ runtimeRoot: h.runtimeRoot, runtimeId: runtime.runtimeId, files: [], startTimes: failing }).status).toBe('unknown')
    // no pin at all needs no ps
    const empty = hooksHome()
    expect(config.runtimePins({ runtimeRoot: empty.runtimeRoot, startTimes: failing })).toMatchObject({ status: 'ok' })
    if (process.getuid?.() === 0) return
    chmodSync(join(h.runtimeRoot, '.pins'), 0o000)
    try {
      expect(config.runtimePins({ runtimeRoot: h.runtimeRoot })).toEqual({ status: 'unknown', reason: `${join(h.runtimeRoot, '.pins')} is unreadable (EACCES)` })
      expect(config.sweepStalePins({ runtimeRoot: h.runtimeRoot })).toMatchObject({ status: 'unknown', removed: 0 })
    } finally {
      chmodSync(join(h.runtimeRoot, '.pins'), 0o700)
    }
  })

  it('the installer\'s gate names a running driver\'s pin as what references the runtime', () => {
    const h = hooksHome()
    const runtime = installRuntime(h, OLD)
    const path = writePinFile(h.runtimeRoot, runtime.runtimeId, livePin())
    expect(config.classifyRuntimeReference({ runtimeRoot: h.runtimeRoot, runtimeId: runtime.runtimeId, files: [] })).toMatchObject({
      status: 'referenced', matches: [{ file: path, label: `a running agent-inbox-driver (pid ${process.pid})` }],
    })
  })
})

describe('sweeping stale pins (#412)', () => {
  it('removes stale pins only, at most `limit` a pass, then empty pin folders; never a running driver\'s pin', () => {
    const h = hooksHome()
    const runtime = installRuntime(h, OLD)
    const live = writePinFile(h.runtimeRoot, runtime.runtimeId, livePin())
    const gone = goneProcess()
    const stale = Array.from({ length: 3 }, (_, i) =>
      writePinFile(h.runtimeRoot, `gone-${i}`, { pid: gone, startedAt: 'x', launchId: `3333333${i}-2222-4333-8444-555555555555` }))
    // a pin of a pid that runs another process now: stale too
    writePinFile(h.runtimeRoot, runtime.runtimeId, { pid: process.pid, startedAt: 'Thu Jan 1 00:00:00 1970', launchId: OTHER_LAUNCH })
    expect(config.sweepStalePins({ runtimeRoot: h.runtimeRoot, limit: 2 })).toEqual({ status: 'ok', removed: 2 })
    expect(config.sweepStalePins({ runtimeRoot: h.runtimeRoot })).toEqual({ status: 'ok', removed: 2 })
    expect(stale.every((path) => !existsSync(path))).toBe(true)
    expect(readdirSync(join(h.runtimeRoot, '.pins'))).toEqual([runtime.runtimeId])
    expect(readdirSync(join(h.runtimeRoot, '.pins', runtime.runtimeId))).toEqual([PIN_LAUNCH])
    expect(existsSync(live)).toBe(true)
    expect(config.sweepStalePins({ runtimeRoot: h.runtimeRoot })).toEqual({ status: 'ok', removed: 0 })
  })
})

describe('.pins is never a runtime (#412)', () => {
  it('list skips it, and install and prune refuse it as a runtime id', () => {
    const h = hooksHome()
    const runtime = installRuntime(h, OLD)
    writePinFile(h.runtimeRoot, runtime.runtimeId, livePin())
    const list = spawnSync(process.execPath, [PAYLOAD_CLI, 'list', '--runtime-root', h.runtimeRoot], { encoding: 'utf8' })
    expect((JSON.parse(list.stdout) as Array<{ runtimeId: string }>).map((r) => r.runtimeId)).toEqual([runtime.runtimeId])
    const prune = spawnSync(process.execPath, [PAYLOAD_CLI, 'prune', '--runtime-root', h.runtimeRoot, '--runtime-id', '.pins'], { encoding: 'utf8' })
    expect(prune.status).not.toBe(0)
    expect(prune.stderr).toContain('is where drivers pin runtimes')
    expect(existsSync(join(h.runtimeRoot, '.pins', runtime.runtimeId, PIN_LAUNCH))).toBe(true)
  })
})

describe('prune-runtimes.sh keeps a pinned runtime (#412)', () => {
  function fixture(): { h: HooksHome; app: StagedRuntime } {
    return { h: hooksHome(), app: stageRuntime(join(scratchDir('pin-app-'), 'payload'), APP) }
  }
  const prune = (f: { h: HooksHome; app: StagedRuntime }, args: string[] = []) =>
    spawnSync('/bin/bash', [join(f.app.dir, 'scripts', 'prune-runtimes.sh'), ...args], { encoding: 'utf8', env: f.h.env })

  it('keeps a runtime a running driver is pinned to, while it still verifies, and says which driver', () => {
    const f = fixture()
    const old = installRuntime(f.h, OLD)
    const driver = standIn()
    writePinFile(f.h.runtimeRoot, old.runtimeId, livePin(driver.pid!))
    const applied = prune(f, ['--apply'])
    expect(applied.status, applied.stderr).toBe(0)
    expect(applied.stdout).toContain(`Kept v${OLD} (${old.runtimeId}): used by a running agent-inbox-driver (pid ${driver.pid}).`)
    expect(existsSync(old.dir)).toBe(true)
    expect(spawnSync(process.execPath, [PAYLOAD_CLI, 'verify', '--root', old.dir, '--product', 'agent-inbox-runtime']).status).toBe(0)
  })

  it('removes the runtime once its driver is gone, and --apply sweeps the stale pin; a dry run sweeps nothing', () => {
    const f = fixture()
    const old = installRuntime(f.h, OLD)
    const pin = writePinFile(f.h.runtimeRoot, old.runtimeId, { pid: goneProcess(), startedAt: 'Thu Jan 1 00:00:00 1970' })
    const dry = prune(f)
    expect(dry.stdout).toContain(`Would remove v${OLD} (${old.runtimeId}).`)
    expect(existsSync(pin)).toBe(true)
    const applied = prune(f, ['--apply'])
    expect(applied.status, applied.stderr).toBe(0)
    expect(applied.stdout).toContain(`Removed v${OLD} (${old.runtimeId}).`)
    expect(existsSync(old.dir)).toBe(false)
    expect(existsSync(pin)).toBe(false)
    expect(readdirSync(join(f.h.runtimeRoot, '.pins'))).toEqual([])
  })

  it('removes nothing when the pins cannot be read', () => {
    if (process.getuid?.() === 0) return
    const f = fixture()
    const old = installRuntime(f.h, OLD)
    writePinFile(f.h.runtimeRoot, old.runtimeId, { pid: goneProcess(), startedAt: 'x' })
    chmodSync(join(f.h.runtimeRoot, '.pins', old.runtimeId), 0o000)
    try {
      const applied = prune(f, ['--apply'])
      expect(applied.status).toBe(1)
      expect(applied.stderr).toContain(`${join(f.h.runtimeRoot, '.pins', old.runtimeId)} is unreadable (EACCES). Nothing was removed.`)
      expect(existsSync(old.dir)).toBe(true)
    } finally {
      chmodSync(join(f.h.runtimeRoot, '.pins', old.runtimeId), 0o700)
    }
  })
})

// The pin and lease rules of older builds, frozen: what an older installer or
// prune does with a runtime root that holds `.pins` (#412 mixed-version).
describe('older installers sharing a runtime root with pins (#412)', () => {
  it('an older list reports .pins as no valid runtime, which an older installer\'s prune never touches', () => {
    // runtime-payload.mjs listRuntimes at v2.2.0, verbatim: it skipped trash only
    const olderListRuntimes = (runtimeRoot: string) => {
      const out: Array<{ runtimeId: string; path: string; valid: boolean }> = []
      for (const entry of readdirSync(runtimeRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.trash-')) continue
        const dir = join(runtimeRoot, entry.name)
        try {
          const manifest = payload.verifyPayload({ root: dir })
          out.push({ runtimeId: entry.name, path: dir, valid: manifest.runtimeId === entry.name })
        } catch {
          out.push({ runtimeId: entry.name, path: dir, valid: false })
        }
      }
      return out
    }
    const h = hooksHome()
    const runtime = installRuntime(h, OLD)
    writePinFile(h.runtimeRoot, runtime.runtimeId, livePin())
    const listed = olderListRuntimes(h.runtimeRoot)
    expect(listed.map((r) => [r.runtimeId, r.valid]).sort()).toEqual([['.pins', false], [runtime.runtimeId, true]])
    // install-agents.sh's prune (unchanged since #294) keeps only `.filter((x) => x.valid)` ids
    expect(listed.filter((r) => r.valid).map((r) => r.runtimeId)).toEqual([runtime.runtimeId])
  })

  it('an older prune-runtimes skips every .-name and keeps the runtime a running driver names on its command line', () => {
    // v2.2.0 findUnusedRuntimes: `if (name.startsWith('.') …) continue`, and the ps rule
    // keeps a runtime any running process names: a driver runs <runtime>/bin/node <runtime>/dist/driver-cli.js
    const f = { h: hooksHome() }
    const old = installRuntime(f.h, OLD)
    mkdirSync(join(f.h.runtimeRoot, '.pins'), { recursive: true })
    const driver = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)', join(old.dir, 'dist', 'driver-cli.js')], { stdio: 'ignore' })
    children.add(driver)
    const unused = spawnSync(process.execPath, [CONFIG_CLI, 'unused', '--runtime-root', f.h.runtimeRoot, '--home', f.h.home], { encoding: 'utf8', env: f.h.env })
    const result = JSON.parse(unused.stdout) as { runtimes: Array<{ runtimeId: string; verdict: string; pids: number[] }> }
    expect(result.runtimes).toEqual([expect.objectContaining({ runtimeId: old.runtimeId, verdict: 'in-use', pids: [driver.pid] })])
  })
})

describe('the pins CLI (#412)', () => {
  it('pins reports the running drivers and how many pins are stale; sweep-pins removes the stale ones', () => {
    const h = hooksHome()
    const runtime = installRuntime(h, OLD)
    writePinFile(h.runtimeRoot, runtime.runtimeId, livePin())
    writePinFile(h.runtimeRoot, runtime.runtimeId, { pid: goneProcess(), startedAt: 'x', launchId: OTHER_LAUNCH })
    const pins = spawnSync(process.execPath, [CONFIG_CLI, 'pins', '--runtime-root', h.runtimeRoot], { encoding: 'utf8' })
    expect(JSON.parse(pins.stdout)).toEqual({ status: 'ok', live: [{ runtimeId: runtime.runtimeId, launchId: PIN_LAUNCH, pid: process.pid }], stale: 1 })
    const sweep = spawnSync(process.execPath, [CONFIG_CLI, 'sweep-pins', '--runtime-root', h.runtimeRoot], { encoding: 'utf8' })
    expect(JSON.parse(sweep.stdout)).toEqual({ status: 'ok', removed: 1 })
    expect(spawnSync(process.execPath, [CONFIG_CLI, 'pins', '--runtime-root', 'relative']).status).toBe(2)
  })
})
