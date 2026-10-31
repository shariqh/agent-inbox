// Issue #412, step 2 (PR 3): a running agent-inbox-driver pins the runtime it
// runs from, at <runtime root>/.pins/<runtime id>/<launch id>, OUTSIDE the
// runtime's own folder so it still verifies. Pins are decided in ONE place,
// scripts/runtime-pins.mjs (runtimePins, processIdentity): the installer's
// prune and rollback (`references`) and prune-runtimes.sh (`unused`) add them
// to "uses", and runtime-payload.mjs's prune reads them again once it has
// moved a runtime aside. A pin counts only while its driver runs (pid and
// start identity); a stale one is swept by each prune, at most 64 a pass.
import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { locateRuntime, pinRuntime, removePin, writePin } from '../src/driver-pin.js'
import { linuxIdentity, linuxProcessStart, processIdentities, processIdentity, runtimePins, sweepStalePins } from '../scripts/runtime-pins.mjs'
import { hooksHome, installRuntime, stageRuntime } from './hooks-runtime.js'
import type { HooksHome, StagedRuntime } from './hooks-runtime.js'
import { goneProcess, PIN_LAUNCH, startOf, writePinFile } from './runtime-uses.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

const REPO = resolve(import.meta.dirname, '..')
const CONFIG_CLI = join(REPO, 'scripts', 'runtime-config.mjs')
const PAYLOAD_CLI = join(REPO, 'scripts', 'runtime-payload.mjs')

type Identities = { ok: true; ids: Map<number, string> } | { ok: false; reason: string }
const payload = (await import(pathToFileURL(PAYLOAD_CLI).href)) as {
  verifyPayload(options: { root: string }): { runtimeId: string }
  pruneRuntime(options: { runtimeRoot: string; runtimeId: string; identities?: (pids: number[]) => Identities }):
    { pruned: boolean; kept?: boolean; reason?: string }
}
const config = (await import(pathToFileURL(CONFIG_CLI).href)) as {
  classifyRuntimeReference(options: { runtimeRoot: string; runtimeId: string; files: string[]; identities?: (pids: number[]) => Identities }): { status: string; matches: Array<{ file: string; label: string }> }
  findUnusedRuntimes(options: { runtimeRoot: string; home: string; processList?: () => { ok: true; processes: [] } }): { status: string; runtimes: Array<{ runtimeId: string; verdict: string }> }
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
    const pins = runtimePins({ runtimeRoot: h.runtimeRoot })
    if (pins.status !== 'ok') throw new Error(pins.reason)
    expect([...pins.live]).toEqual([[runtime.runtimeId, [{ launchId: PIN_LAUNCH, pid: process.pid }]]])
    expect(pins.stale.map((p) => [p.runtimeId, p.launchId]).sort()).toEqual([['gone-runtime', PIN_LAUNCH], [runtime.runtimeId, OTHER_LAUNCH]].sort())
  })

  it('records what the prunes compare: a driver\'s pin of its installed runtime reads as live, and is removed on exit', () => {
    const h = hooksHome()
    const runtime = installRuntime(h, OLD)
    const located = locateRuntime(join(runtime.dir, 'dist', 'driver-cli.js'), h.runtimeRoot)
    if (located.kind !== 'runtime') throw new Error(JSON.stringify(located))
    expect(located.runtime.runtimeId).toBe(runtime.runtimeId)
    // a checkout is outside the runtime root and pins nothing
    expect(locateRuntime(join(REPO, 'dist', 'driver-cli.js'), h.runtimeRoot)).toEqual({ kind: 'checkout' })
    const startedAt = processIdentity(process.pid)!
    expect(processIdentities([process.pid])).toEqual({ ok: true, ids: new Map([[process.pid, startedAt]]) })
    const path = pinRuntime(located.runtime, { launchId: PIN_LAUNCH, pid: process.pid, startedAt })
    expect(path).toBe(join(located.runtime.root, '.pins', runtime.runtimeId, PIN_LAUNCH))
    expect(readdirSync(join(h.runtimeRoot, '.pins', runtime.runtimeId))).toEqual([PIN_LAUNCH])
    const pins = runtimePins({ runtimeRoot: h.runtimeRoot })
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
    const failing = (): Identities => ({ ok: false, reason: 'ps failed (EPERM)' })
    expect(runtimePins({ runtimeRoot: h.runtimeRoot, identities: failing }))
      .toEqual({ status: 'unknown', reason: 'the drivers pinning runtimes cannot be checked: ps failed (EPERM)' })
    expect(config.classifyRuntimeReference({ runtimeRoot: h.runtimeRoot, runtimeId: runtime.runtimeId, files: [], identities: failing }).status).toBe('unknown')
    // no pin at all needs no ps
    const empty = hooksHome()
    expect(runtimePins({ runtimeRoot: empty.runtimeRoot, identities: failing })).toMatchObject({ status: 'ok' })
    if (process.getuid?.() === 0) return
    chmodSync(join(h.runtimeRoot, '.pins'), 0o000)
    try {
      expect(runtimePins({ runtimeRoot: h.runtimeRoot })).toEqual({ status: 'unknown', reason: `${join(h.runtimeRoot, '.pins')} is unreadable (EACCES)` })
      expect(sweepStalePins({ runtimeRoot: h.runtimeRoot })).toMatchObject({ status: 'unknown', removed: 0 })
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

// A pin's start identity must never move while its driver runs. On Linux,
// procps's `ps -o lstart=` adds the start tick count to the boot time, which
// moves when the wall clock is stepped, so Linux reads /proc/<pid>/stat
// (field 22, ticks since boot) with the boot id instead.
describe('a process\'s start identity (#412)', () => {
  // fields 3..21 of /proc/<pid>/stat, then starttime (field 22), then the rest
  const statLine = (pid: number, comm: string, state = 'S', starttime = '987654') =>
    `${pid} (${comm}) ${state} 1 ${pid} ${pid} 0 -1 4194560 120 0 0 0 3 1 0 0 20 0 1 0 ${starttime} 1024000 300 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0\n`
  const BOOT_A = '0f6c1a2e-1111-4222-8333-444455556666'
  const BOOT_B = '9a8b7c6d-1111-4222-8333-444455556666'
  function fakeProc(bootId: string, procs: Record<number, string>, btime = 1700000000): string {
    const root = scratchDir('pin-proc-')
    mkdirSync(join(root, 'sys', 'kernel', 'random'), { recursive: true })
    writeFileSync(join(root, 'sys', 'kernel', 'random', 'boot_id'), `${bootId}\n`)
    writeFileSync(join(root, 'stat'), `cpu 1 2 3\nbtime ${btime}\n`)
    for (const [pid, text] of Object.entries(procs)) {
      mkdirSync(join(root, pid), { recursive: true })
      writeFileSync(join(root, pid, 'stat'), text)
    }
    return root
  }
  const linux = (procRoot: string) => (pids: number[]) => processIdentities(pids, { platform: 'linux', procRoot })

  it('counts fields after the LAST paren, so a command name holding ") (" and spaces cannot shift them', () => {
    const text = statLine(4242, 'evil) (S 1 2 3', 'S', '555')
    expect(linuxProcessStart(text)).toEqual({ state: 'S', starttime: '555' })
    expect(linuxIdentity(text, BOOT_A)).toBe(`linux:${BOOT_A}:555`)
    expect(linuxProcessStart('4242 no parens here')).toBeNull()
    expect(linuxProcessStart('4242 (short) S 1 2')).toBeNull()
    // a zombie is no running driver
    expect(linuxIdentity(statLine(4242, 'driver', 'Z'), BOOT_A)).toBeNull()
  })

  it('reads /proc directly: a running pid has an identity, a gone one none, and a read it cannot make is unknown', () => {
    const procRoot = fakeProc(BOOT_A, { 4242: statLine(4242, 'node'), 4243: statLine(4243, 'node', 'Z') })
    expect(processIdentities([4242, 4243, 4244], { platform: 'linux', procRoot })).toEqual({ ok: true, ids: new Map([[4242, `linux:${BOOT_A}:987654`]]) })
    expect(processIdentities([4242], { platform: 'linux', procRoot: join(procRoot, 'missing') })).toMatchObject({ ok: false })
    writeFileSync(join(procRoot, '4242', 'stat'), 'garbage')
    expect(processIdentities([4242], { platform: 'linux', procRoot })).toMatchObject({ ok: false })
    // and on a platform it has no identity for, nothing is known
    expect(processIdentities([process.pid], { platform: 'win32' })).toEqual({ ok: false, reason: 'a process\'s identity cannot be read on win32' })
    expect(processIdentities([], { platform: 'win32' })).toEqual({ ok: true, ids: new Map() })
  })

  it('keeps a live pin live when the wall clock is stepped, and calls a pin from another boot stale', () => {
    const h = hooksHome()
    const runtime = installRuntime(h, OLD)
    const procRoot = fakeProc(BOOT_A, { 4242: statLine(4242, 'node') })
    const startedAt = processIdentity(4242, { platform: 'linux', procRoot })!
    writePinFile(h.runtimeRoot, runtime.runtimeId, { pid: 4242, startedAt })
    const live = () => {
      const pins = runtimePins({ runtimeRoot: h.runtimeRoot, identities: linux(procRoot) })
      return pins.status === 'ok' ? [...pins.live.keys()] : pins.reason
    }
    expect(live()).toEqual([runtime.runtimeId])
    // a clock step moves the boot time procps adds (btime); the identity never reads it
    writeFileSync(join(procRoot, 'stat'), 'cpu 1 2 3\nbtime 1700003600\n')
    expect(processIdentity(4242, { platform: 'linux', procRoot })).toBe(startedAt)
    expect(live()).toEqual([runtime.runtimeId])
    // after a reboot the same pid and tick count are another process
    writeFileSync(join(procRoot, 'sys', 'kernel', 'random', 'boot_id'), `${BOOT_B}\n`)
    expect(live()).toEqual([])
    const pins = runtimePins({ runtimeRoot: h.runtimeRoot, identities: linux(procRoot) })
    expect(pins.status === 'ok' && pins.stale.map((pin) => pin.pid)).toEqual([4242])
  })
})

describe('where the driver runs from, and pinning it (#412)', () => {
  const startedAt = () => processIdentity(process.pid)!

  it('a driver inside the runtime root pins only a runtime whose manifest names it, and refuses otherwise', () => {
    const h = hooksHome()
    const bare = join(h.runtimeRoot, 'agent-inbox-runtime-9.9.9-test')
    mkdirSync(join(bare, 'dist'), { recursive: true })
    writeFileSync(join(bare, 'dist', 'driver-cli.js'), '')
    expect(locateRuntime(join(bare, 'dist', 'driver-cli.js'), h.runtimeRoot))
      .toMatchObject({ kind: 'refuse', reason: expect.stringContaining('its runtime has no manifest') })
    writeFileSync(join(bare, 'runtime-manifest.json'), JSON.stringify({ product: 'agent-inbox-runtime', runtimeId: 'another' }))
    expect(locateRuntime(join(bare, 'dist', 'driver-cli.js'), h.runtimeRoot))
      .toMatchObject({ kind: 'refuse', reason: expect.stringContaining('does not name runtime') })
    if (process.getuid?.() !== 0) {
      chmodSync(join(bare, 'runtime-manifest.json'), 0o000)
      try {
        expect(locateRuntime(join(bare, 'dist', 'driver-cli.js'), h.runtimeRoot))
          .toMatchObject({ kind: 'refuse', reason: expect.stringContaining("its runtime's manifest cannot be read (EACCES)") })
      } finally {
        chmodSync(join(bare, 'runtime-manifest.json'), 0o600)
      }
    }
    // anywhere else under the root is no runtime's entry point
    const trashed = join(h.runtimeRoot, '.trash-x', 'agent-inbox-runtime-9.9.9-test', 'dist')
    mkdirSync(trashed, { recursive: true })
    writeFileSync(join(trashed, 'driver-cli.js'), '')
    expect(locateRuntime(join(trashed, 'driver-cli.js'), h.runtimeRoot)).toMatchObject({ kind: 'refuse' })
    // a root that is not there holds nothing
    expect(locateRuntime(join(bare, 'dist', 'driver-cli.js'), join(h.home, 'no-runtimes'))).toEqual({ kind: 'checkout' })
  })

  it('removes its pin and refuses when the runtime was moved aside after it pinned', () => {
    const h = hooksHome()
    const runtime = installRuntime(h, OLD)
    const located = locateRuntime(join(runtime.dir, 'dist', 'driver-cli.js'), h.runtimeRoot)
    if (located.kind !== 'runtime') throw new Error(JSON.stringify(located))
    const aside = join(h.runtimeRoot, '.trash-test')
    mkdirSync(aside)
    expect(() => pinRuntime(located.runtime, { launchId: PIN_LAUNCH, pid: process.pid, startedAt: startedAt() }, {
      afterWrite: () => renameSync(runtime.dir, join(aside, runtime.runtimeId)),
    })).toThrow(/is being removed \(its runtime has no manifest\)/)
    expect(existsSync(join(h.runtimeRoot, '.pins', runtime.runtimeId, PIN_LAUNCH))).toBe(false)
  })

  it('writes its pin when a sweep removes the empty pin folder under it, retrying once', () => {
    const h = hooksHome()
    const runtime = installRuntime(h, OLD)
    let swept = 0
    const path = writePin({ root: h.runtimeRoot, runtimeId: runtime.runtimeId }, { launchId: PIN_LAUNCH, pid: process.pid, startedAt: startedAt() }, {
      beforeOpen: (dir) => { swept += 1; rmdirSync(dir) },
    })
    expect(swept).toBe(1)
    expect(path).toBe(join(h.runtimeRoot, '.pins', runtime.runtimeId, PIN_LAUNCH))
    const pins = runtimePins({ runtimeRoot: h.runtimeRoot })
    expect(pins.status === 'ok' && [...pins.live.keys()]).toEqual([runtime.runtimeId])
  })
})

describe('a prune re-reads the pins once it has moved the runtime aside (#412)', () => {
  it('a pin written between the check and the rename keeps the runtime: it is put back and reported kept', () => {
    const h = hooksHome()
    const runtime = installRuntime(h, OLD)
    const driver = standIn()
    // the check: nothing uses it
    const before = config.findUnusedRuntimes({ runtimeRoot: h.runtimeRoot, home: h.home, processList: () => ({ ok: true, processes: [] }) })
    expect(before.runtimes).toEqual([expect.objectContaining({ runtimeId: runtime.runtimeId, verdict: 'unused' })])
    // a driver pins it before the prune moves it
    writePinFile(h.runtimeRoot, runtime.runtimeId, livePin(driver.pid!))
    const result = spawnSync(process.execPath, [PAYLOAD_CLI, 'prune', '--runtime-root', h.runtimeRoot, '--runtime-id', runtime.runtimeId], { encoding: 'utf8' })
    expect(result.status).toBe(4)
    expect(JSON.parse(result.stdout)).toMatchObject({ pruned: false, kept: true, runtimeId: runtime.runtimeId, reason: `a running agent-inbox-driver (pid ${driver.pid}) is pinned to it` })
    expect(spawnSync(process.execPath, [PAYLOAD_CLI, 'verify', '--root', runtime.dir, '--product', 'agent-inbox-runtime']).status).toBe(0)
    expect(readdirSync(h.runtimeRoot).filter((name) => name.startsWith('.trash-'))).toEqual([])
  })

  it('keeps it too when the pins cannot be checked, and removes it once nothing holds it', () => {
    const h = hooksHome()
    const runtime = installRuntime(h, OLD)
    writePinFile(h.runtimeRoot, runtime.runtimeId, { pid: goneProcess(), startedAt: 'x' })
    const failing = (): Identities => ({ ok: false, reason: 'ps failed (EPERM)' })
    expect(payload.pruneRuntime({ runtimeRoot: h.runtimeRoot, runtimeId: runtime.runtimeId, identities: failing }))
      .toMatchObject({ pruned: false, kept: true, reason: 'the drivers pinning runtimes cannot be checked: ps failed (EPERM)' })
    expect(existsSync(runtime.dir)).toBe(true)
    expect(payload.pruneRuntime({ runtimeRoot: h.runtimeRoot, runtimeId: runtime.runtimeId })).toMatchObject({ pruned: true })
    expect(existsSync(runtime.dir)).toBe(false)
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
    expect(sweepStalePins({ runtimeRoot: h.runtimeRoot, limit: 2 })).toEqual({ status: 'ok', removed: 2 })
    expect(sweepStalePins({ runtimeRoot: h.runtimeRoot })).toEqual({ status: 'ok', removed: 2 })
    expect(stale.every((path) => !existsSync(path))).toBe(true)
    expect(readdirSync(join(h.runtimeRoot, '.pins'))).toEqual([runtime.runtimeId])
    expect(readdirSync(join(h.runtimeRoot, '.pins', runtime.runtimeId))).toEqual([PIN_LAUNCH])
    expect(existsSync(live)).toBe(true)
    expect(sweepStalePins({ runtimeRoot: h.runtimeRoot })).toEqual({ status: 'ok', removed: 0 })
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
