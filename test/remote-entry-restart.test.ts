// The hub's remote-entry controller across restarts (#617, PR 2e; design
// docs/superpowers/specs/2026-11-17-remote-inbox-design.md §3.2 "Changes made behind the app's
// back", §3.5 "Coming back by itself"). electron/remote-entry.cjs keeps a small state across
// restarts through a `stateStore` (electron/remote-entry-state.cjs, userData
// `remote-entry-state.json`): the digest of the last remote.json state it wrote or accepted, so a
// change made while the app was closed is flagged at the next start, and `wanted`, the owner's
// intent, so an entry the watch switched off (Tailscale not up yet after a restart) comes back by
// itself, but only on exactly the file it switched off and only with the same identity.
//
// Every file lives in a scratch folder; Tailscale is the fixtures' fake. No test runs the real
// `tailscale`. Values are synthetic: `hub.example.ts.net`, `owner@example.com`, `laptop`.
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import fsPromises from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import remoteEntry from '../electron/remote-entry.cjs'
import remoteEntryState from '../electron/remote-entry-state.cjs'
import type { RemoteEntryStateStore, RemoteEntryStoredState } from '../electron/remote-entry-state.cjs'
import { removeScratchDirs, scratchDir } from './scratch.js'
import { device, newSecret, setting, writeSetting } from './remote-fixtures.js'
import { ALLOWED_ARGS, HOST, LOGIN, USER_ID, cliExists, fakeTailscale, goodServe, selfStatus, taggedStatus, tailscaleCalls } from './remote-entry-fixtures.js'

const { createRemoteEntry } = remoteEntry
const { createRemoteEntryState } = remoteEntryState

const START = Date.parse('2026-11-20T09:00:00.000Z')
const TOKEN = 'owner-token-for-the-test-0123456789'
const CODE = '7K3QX-9M2PD'
const CODE_ID = 'c0de0000000000a1'
const A = 'aaaaaaaaaaaaaaaa'
const B = 'bbbbbbbbbbbbbbbb'
const OTHER_HOST = 'other.example.ts.net'
const OTHER_LOGIN = 'second@example.com'

afterEach(() => removeScratchDirs())

// every Tailscale call in this file used one of the allowed lists, and none ran under remote.json's lock
const lockViolations: string[] = []
afterAll(() => {
  expect(tailscaleCalls.length).toBeGreaterThan(20)
  for (const call of tailscaleCalls) expect(ALLOWED_ARGS, call.args.join(' ')).toContainEqual(call.args)
  expect(lockViolations).toEqual([])
})

const starting = () => selfStatus({ BackendState: 'Starting' })
const fileJson = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
const deviceIds = (file: string) => (fileJson(file).devices as Array<{ id: string }>).map((d) => d.id)

function statusBody(paired: Array<{ device: string; codeId: string }> = []) {
  return {
    on: true, listening: true, port: 4320, host: HOST, error: null, codePending: false, paired,
    refused: { host: 0, funnel: 0, login: 0, path: 0, origin: 0, device: 0, route: 0, pair: 0 },
  }
}

/** One hub's folder: remote.json beside a scratch database, the state file in a scratch userData. Survives a "restart". */
function place() {
  const dir = scratchDir('remote-restart-')
  return {
    dir,
    file: join(dir, 'remote.json'),
    stateFile: join(dir, 'userData', 'remote-entry-state.json'),
    clock: { now: START },
    // what Tailscale answers now; tests change it between ticks
    ts: { self: selfStatus() as unknown, serve: goodServe(4320) as unknown, cli: true },
  }
}
type Place = ReturnType<typeof place>

/** One run of the app on `p`: a new controller, as after a restart. `store: null` gives none. */
function open(p: Place, opts: {
  store?: RemoteEntryStateStore | null; onBeforeServe?: () => void; serveGate?: () => Promise<void>; beforeOpen?: () => void
} = {}) {
  const events = {
    stopped: [] as Array<{ reason: string; off: boolean; willResume: boolean }>,
    outside: 0,
    resumed: 0,
    paired: [] as string[],
  }
  const tailscale = fakeTailscale({
    self: () => p.ts.self,
    serve: () => {
      opts.onBeforeServe?.()
      return p.ts.serve
    },
  })
  const execFile = Object.assign((file_: string, args: readonly string[], options: Record<string, unknown>, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    if (existsSync(`${p.file}.lock`)) lockViolations.push(args.join(' '))
    // a Serve read that waits for the test to do something first
    if (opts.serveGate && args.join(' ') === 'serve status --json') {
      void opts.serveGate().then(() => tailscale(file_, args, options, callback))
      return
    }
    tailscale(file_, args, options, callback)
  }, { calls: tailscale.calls })
  const viewer = { status: statusBody() as unknown, codes: [] as string[] }
  const fetch = async (url: string): Promise<Response> => {
    if (existsSync(`${p.file}.lock`)) lockViolations.push(`fetch ${url}`)
    if (url.endsWith('/api/remote-entry/code')) {
      const codeId = viewer.codes.shift()
      return codeId ? Response.json({ code: CODE, expiresAt: new Date(p.clock.now + 600_000).toISOString(), codeId }) : new Response('', { status: 500 })
    }
    if (url.endsWith('/api/remote-entry')) return Response.json(viewer.status)
    throw new TypeError('fetch failed')
  }
  const store = opts.store === undefined ? createRemoteEntryState({ filePath: p.stateFile }) : opts.store
  const c = createRemoteEntry({
    isPackaged: true,
    env: { AGENT_INBOX_DB: join(p.dir, 'inbox.db') },
    ownerToken: TOKEN,
    execFile,
    exists: (path: string) => p.ts.cli && cliExists(path),
    fetch,
    now: () => p.clock.now,
    sleep: async (ms: number) => { p.clock.now += ms },
    setInterval: () => 0,
    clearInterval: () => {},
    ...(store ? { stateStore: store } : {}),
    // every open of remote.json can run a step of the test first
    ...(opts.beforeOpen ? {
      fsImpl: {
        ...fsPromises,
        open: async (...args: Parameters<typeof fsPromises.open>) => {
          if (args[0] === p.file) opts.beforeOpen?.()
          return fsPromises.open(...args)
        },
      } as never,
    } : {}),
    onStopped: (reason: string, info: { off: boolean; willResume: boolean }) => { events.stopped.push({ reason, off: info.off, willResume: info.willResume }) },
    onPaired: (label: string) => { events.paired.push(label) },
    onOutsideChange: () => { events.outside += 1 },
    onResumed: () => { events.resumed += 1 },
  })
  const selfCalls = () => tailscale.calls.filter((call) => call.args.join(' ') === 'status --json --peers=false').length
  return { c, events, tailscale, viewer, selfCalls }
}

/**
 * A hub whose state already holds remote.json with device A: the first run, with no state kept and a
 * device in the file, flags it; the owner acknowledges it; then (unless `on: false`) switches on.
 */
async function seeded(p: Place, opts: { on?: boolean; devices?: unknown[] } = {}) {
  writeSetting(p.dir, setting(4320, opts.devices ?? [device(newSecret(), A)], { enabled: false }))
  const s = open(p)
  await s.c.tick()
  const flagged = await s.c.state()
  expect(flagged.flag).toBe(true)
  expect(await s.c.acknowledge(flagged.flagDigest)).toEqual({ ok: true })
  if (opts.on !== false) expect((await s.c.turnOn()).ok).toBe(true)
  s.c.stop()
  return s
}

/** Seeded, on, restarted with Tailscale starting: paused, waiting to resume. */
async function paused(p: Place, opts: Parameters<typeof open>[1] = {}) {
  await seeded(p)
  p.ts.self = starting()
  const s = open(p, opts)
  s.c.start()
  await s.c.tick()
  expect(fileJson(p.file).enabled).toBe(false)
  expect(s.events.stopped).toHaveLength(1)
  return s
}

/** Advance the clock by `ms` and tick. */
async function after(p: Place, s: ReturnType<typeof open>, ms: number) {
  p.clock.now += ms
  await s.c.tick()
}

function appendDevice(file: string, id: string, label = 'laptop') {
  const doc = fileJson(file) as { devices: unknown[] }
  doc.devices.push(device(newSecret(), id, label))
  writeFileSync(file, JSON.stringify(doc, null, 2), { mode: 0o600 })
}
function edit(file: string, change: (doc: Record<string, unknown>) => void) {
  const doc = fileJson(file)
  change(doc)
  writeFileSync(file, JSON.stringify(doc, null, 2), { mode: 0o600 })
}

/** A store held in memory, whose read and write can be made to fail. */
function memoryStore(initial: RemoteEntryStoredState | null = null) {
  const m = { value: initial, readFails: false, writeFails: false, writes: [] as RemoteEntryStoredState[] }
  const store: RemoteEntryStateStore = {
    read: async () => {
      if (m.readFails) throw new Error('read broke')
      return m.value && { ...m.value }
    },
    write: async (state) => {
      if (m.writeFails) throw new Error('write broke')
      m.writes.push({ ...state })
      m.value = { ...state }
    },
  }
  return { m, store }
}

// ── the state file ─────────────────────────────────────────────────────────

describe('createRemoteEntryState: userData remote-entry-state.json', () => {
  it('writes { schema: 1, digest, wanted } 0600 under userData, and reads it back', async () => {
    const dir = scratchDir('remote-restart-')
    const store = createRemoteEntryState({ app: { getPath: () => dir } })
    expect(await store.read()).toBe(null)
    await store.write({ digest: 'a'.repeat(64), wanted: true })
    const file = join(dir, 'remote-entry-state.json')
    expect(fileJson(file)).toEqual({ schema: 1, digest: 'a'.repeat(64), wanted: true })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(await store.read()).toEqual({ digest: 'a'.repeat(64), wanted: true })
    await store.write({ digest: null, wanted: false })
    expect(await store.read()).toEqual({ digest: null, wanted: false })
  })

  it('keeps unknown fields', async () => {
    const dir = scratchDir('remote-restart-')
    const file = join(dir, 'state.json')
    writeFileSync(file, JSON.stringify({ schema: 1, digest: null, wanted: false, later: { x: 1 } }))
    const store = createRemoteEntryState({ filePath: file })
    await store.write({ digest: 'b'.repeat(64), wanted: true })
    expect(fileJson(file)).toEqual({ schema: 1, digest: 'b'.repeat(64), wanted: true, later: { x: 1 } })
  })

  it('reads a newer schema as no state and never overwrites it', async () => {
    const dir = scratchDir('remote-restart-')
    const file = join(dir, 'state.json')
    const text = JSON.stringify({ schema: 2, digest: 'c'.repeat(64), wanted: true })
    writeFileSync(file, text)
    const store = createRemoteEntryState({ filePath: file })
    expect(await store.read()).toBe(null)
    await expect(store.write({ digest: 'd'.repeat(64), wanted: false })).rejects.toThrow()
    expect(readFileSync(file, 'utf8')).toBe(text)
  })

  it.each([
    ['not JSON', '{"schema":1,'],
    ['an array', '[]'],
    ['no schema', JSON.stringify({ digest: null, wanted: true })],
    ['schema 0', JSON.stringify({ schema: 0, digest: null, wanted: true })],
    ['a digest that is not 64 hex', JSON.stringify({ schema: 1, digest: 'abc', wanted: true })],
    ['a digest in capitals', JSON.stringify({ schema: 1, digest: 'A'.repeat(64), wanted: true })],
    ['wanted not a boolean', JSON.stringify({ schema: 1, digest: null, wanted: 'yes' })],
    ['no wanted', JSON.stringify({ schema: 1, digest: null })],
  ])('reads %s as no state, and a write replaces it', async (_name, text) => {
    const dir = scratchDir('remote-restart-')
    const file = join(dir, 'state.json')
    writeFileSync(file, text)
    const store = createRemoteEntryState({ filePath: file })
    expect(await store.read()).toBe(null)
    await store.write({ digest: null, wanted: false })
    expect(await store.read()).toEqual({ digest: null, wanted: false })
  })

  it('refuses to write a state that is not one', async () => {
    const dir = scratchDir('remote-restart-')
    const store = createRemoteEntryState({ filePath: join(dir, 'state.json') })
    await expect(store.write({ digest: 'x', wanted: true })).rejects.toThrow()
    await expect(store.write({ digest: null, wanted: 'yes' as never })).rejects.toThrow()
    expect(existsSync(join(dir, 'state.json'))).toBe(false)
  })
})

// ── gap 1: a change made while the app was closed ──────────────────────────

describe('a change made while the app was closed is flagged at the next start', () => {
  it('a device planted while closed: flagged, onOutsideChange once, never reverted', async () => {
    const p = place()
    await seeded(p)
    appendDevice(p.file, B)
    const planted = readFileSync(p.file, 'utf8')
    const s = open(p)
    s.c.start()
    await s.c.tick()
    await after(p, s, 5_000)
    expect(s.events.outside).toBe(1)
    const state = await s.c.state()
    expect(state.flag).toBe(true)
    expect(state.flagDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(readFileSync(p.file, 'utf8')).toBe(planted)
  })

  it.each([
    ['enabled flipped on', { on: false }, (doc: Record<string, unknown>) => { doc.enabled = true }],
    ['a login added', {}, (doc: Record<string, unknown>) => { doc.logins = [LOGIN, OTHER_LOGIN] }],
    ['a hash swapped', {}, (doc: Record<string, unknown>) => { (doc.devices as Array<Record<string, unknown>>)[0]!.secretSha256 = 'f'.repeat(64) }],
    ['an unreadable entry added', {}, (doc: Record<string, unknown>) => { (doc.devices as unknown[]).push({ id: B, label: 'bad‮label', secretSha256: 'e'.repeat(64) }) }],
  ] as Array<[string, { on?: boolean }, (doc: Record<string, unknown>) => void]>)('%s while closed: flagged once at start', async (_name, opts, change) => {
    const p = place()
    await seeded(p, opts)
    edit(p.file, change)
    const s = open(p)
    s.c.start()
    await s.c.tick()
    await after(p, s, 5_000)
    expect(s.events.outside).toBe(1)
    expect((await s.c.state()).flag).toBe(true)
  })

  it('a rename that keeps a device readable while closed is not a change', async () => {
    const p = place()
    await seeded(p)
    edit(p.file, (doc) => { (doc.devices as Array<Record<string, unknown>>)[0]!.label = 'renamed' })
    const s = open(p)
    s.c.start()
    await s.c.tick()
    expect(s.events.outside).toBe(0)
    expect((await s.c.state()).flag).toBe(false)
  })

  it('an unchanged file at the next start is quiet', async () => {
    const p = place()
    await seeded(p)
    const s = open(p)
    s.c.start()
    await s.c.tick()
    await after(p, s, 60_000)
    expect(s.events.outside).toBe(0)
    expect((await s.c.state()).flag).toBe(false)
  })

  it.each([
    ['an enabled file', () => setting(4320, [])],
    ['an off file holding a device', () => setting(4320, [device(newSecret(), A)], { enabled: false })],
    ['an off file holding only an unreadable entry', () => setting(4320, [{ id: 'short', label: 'x', secretSha256: 'y' }], { enabled: false })],
  ] as Array<[string, () => unknown]>)('no state kept and %s: flagged', async (_name, value) => {
    const p = place()
    writeSetting(p.dir, value())
    const s = open(p)
    s.c.start()
    await s.c.tick()
    await after(p, s, 5_000)
    expect(s.events.outside).toBe(1)
    expect((await s.c.state()).flag).toBe(true)
  })

  it.each([
    ['an absent file', null],
    ['an off file with no devices', setting(4320, [], { enabled: false })],
    ['an off file with an empty device list', setting(4320, [], { enabled: false, devices: [] })],
  ] as Array<[string, unknown]>)('no state kept and %s: the baseline, silently, and kept for the next start', async (_name, value) => {
    const p = place()
    if (value !== null) writeSetting(p.dir, value)
    const s = open(p)
    s.c.start()
    await s.c.tick()
    expect(s.events.outside).toBe(0)
    expect((await s.c.state()).flag).toBe(false)
    s.c.stop()
    // the baseline was kept: a change before the next start is flagged there, even one the
    // no-state rule would take quietly (off, no devices)
    writeSetting(p.dir, setting(4320, [], { enabled: false, logins: [OTHER_LOGIN] }))
    const next = open(p)
    next.c.start()
    await next.c.tick()
    expect(next.events.outside).toBe(1)
  })

  it('acknowledge, then a restart: quiet', async () => {
    const p = place()
    await seeded(p)
    appendDevice(p.file, B)
    const s = open(p)
    s.c.start()
    await s.c.tick()
    expect(await s.c.acknowledge((await s.c.state()).flagDigest)).toEqual({ ok: true })
    s.c.stop()
    const next = open(p)
    next.c.start()
    await next.c.tick()
    expect(next.events.outside).toBe(0)
    expect((await next.c.state()).flag).toBe(false)
  })

  it('a pairing recorded as expected, then a restart: quiet', async () => {
    const p = place()
    await seeded(p)
    const s = open(p)
    s.c.start()
    await s.c.tick()
    s.viewer.codes.push(CODE_ID)
    expect((await s.c.requestCode()).ok).toBe(true)
    appendDevice(p.file, B)
    s.viewer.status = statusBody([{ device: B, codeId: CODE_ID }])
    await after(p, s, 5_000)
    expect(s.events.paired).toEqual(['laptop'])
    expect(s.events.outside).toBe(0)
    s.c.stop()
    const next = open(p)
    next.c.start()
    await next.c.tick()
    expect(next.events.outside).toBe(0)
    expect(deviceIds(p.file)).toEqual([A, B])
  })

  it.each([
    ['lost', (file: string) => unlinkSync(file)],
    ['corrupt', (file: string) => writeFileSync(file, '{"schema":1,"dig')],
    ['a newer schema', (file: string) => writeFileSync(file, JSON.stringify({ schema: 2, digest: 'a'.repeat(64), wanted: true }))],
  ] as Array<[string, (file: string) => void]>)('a state file that is %s, with devices in remote.json: flagged at start', async (name, spoil) => {
    const p = place()
    await seeded(p)
    spoil(p.stateFile)
    const kept = existsSync(p.stateFile) ? readFileSync(p.stateFile, 'utf8') : null
    const s = open(p)
    s.c.start()
    await s.c.tick()
    expect(s.events.outside).toBe(1)
    expect((await s.c.state()).flag).toBe(true)
    if (name === 'a newer schema') {
      // never overwritten, and the panel is told the state was not saved
      expect(await s.c.acknowledge((await s.c.state()).flagDigest)).toEqual({ ok: true })
      expect(readFileSync(p.stateFile, 'utf8')).toBe(kept)
      expect((await s.c.state()).stateSaved).toBe(false)
    }
  })

  it('a state store that fails to read counts as none kept', async () => {
    const p = place()
    writeSetting(p.dir, setting(4320, [device(newSecret(), A)], { enabled: false }))
    const { m, store } = memoryStore({ digest: 'a'.repeat(64), wanted: true })
    m.readFails = true
    const s = open(p, { store })
    s.c.start()
    await s.c.tick()
    expect(s.events.outside).toBe(1)
    expect((await s.c.state()).wanted).toBe(false)
  })

  it('a state store whose write throws never breaks the operation; state() says it was not saved, until a write lands', async () => {
    const p = place()
    const { m, store } = memoryStore()
    m.writeFails = true
    const s = open(p, { store })
    s.c.start()
    await s.c.tick()
    const on = await s.c.turnOn()
    expect(on.ok).toBe(true)
    expect(fileJson(p.file).enabled).toBe(true)
    expect((await s.c.state()).stateSaved).toBe(false)
    expect((await s.c.turnOff()).ok).toBe(true)
    expect((await s.c.removeDevice(A)).ok).toBe(true)
    expect((await s.c.state()).stateSaved).toBe(false)
    m.writeFails = false
    expect((await s.c.turnOn()).ok).toBe(true)
    expect((await s.c.state()).stateSaved).toBe(true)
    expect(m.value).toMatchObject({ wanted: true })
  })

  it('the baseline stays the kept digest across two edits, and across a restart before acknowledge', async () => {
    const p = place()
    await seeded(p)
    edit(p.file, (doc) => { doc.logins = [LOGIN, OTHER_LOGIN] })
    const s = open(p)
    s.c.start()
    await s.c.tick()
    expect(s.events.outside).toBe(1)
    const first = (await s.c.state()).flagDigest
    // a second edit is a new state: announced again
    edit(p.file, (doc) => { doc.logins = [OTHER_LOGIN] })
    await after(p, s, 5_000)
    expect(s.events.outside).toBe(2)
    const second = (await s.c.state()).flagDigest
    expect(second).not.toBe(first)
    // putting the first edit back is not the baseline either
    edit(p.file, (doc) => { doc.logins = [LOGIN, OTHER_LOGIN] })
    await after(p, s, 5_000)
    expect((await s.c.state()).flag).toBe(true)
    s.c.stop()
    // a restart before the owner acknowledged: flagged again
    const next = open(p)
    next.c.start()
    await next.c.tick()
    expect(next.events.outside).toBe(1)
  })

  it('main\'s own write while flagged does not hide the flag across a restart', async () => {
    const p = place()
    await seeded(p)
    appendDevice(p.file, B)
    const s = open(p)
    s.c.start()
    await s.c.tick()
    expect(s.events.outside).toBe(1)
    expect((await s.c.removeDevice(A)).ok).toBe(true)
    expect((await s.c.turnOff()).ok).toBe(true)
    s.c.stop()
    const next = open(p)
    next.c.start()
    await next.c.tick()
    expect(next.events.outside).toBe(1)
    expect((await next.c.state()).flag).toBe(true)
  })

  it('with no state store, the first read is still the baseline (as before)', async () => {
    const p = place()
    writeSetting(p.dir, setting(4320, [device(newSecret(), A)]))
    const s = open(p, { store: null })
    s.c.start()
    await s.c.tick()
    expect(s.events.outside).toBe(0)
    expect((await s.c.state()).stateSaved).toBe(null)
  })
})

// ── gap 2: coming back by itself ───────────────────────────────────────────

describe('after a restart, an entry the watch switched off comes back by itself', () => {
  it('Tailscale starting at the first check: paused (willResume), then on again 5 seconds later, devices untouched', async () => {
    const p = place()
    await seeded(p)
    const before = fileJson(p.file)
    p.ts.self = starting()
    const s = open(p)
    s.c.start()
    await s.c.tick()
    expect(fileJson(p.file).enabled).toBe(false)
    expect(s.events.stopped).toEqual([{ reason: 'not_running', off: true, willResume: true }])
    expect((await s.c.state()).resume).toEqual({ waiting: 'tailscale_not_running' })
    p.ts.self = selfStatus()
    await after(p, s, 5_000)
    expect(fileJson(p.file)).toEqual(before)
    expect(s.events.resumed).toBe(1)
    const state = await s.c.state()
    expect(state).toMatchObject({ resume: null, stopped: null, flag: false, needsOwner: null })
    expect(state.view.enabled).toBe(true)
    await after(p, s, 5_000)
    await after(p, s, 60_000)
    expect(s.events.resumed).toBe(1)
    expect(s.events.outside).toBe(0)
  })

  it('the command line missing at first: one retry, paused, then on again when it appears', async () => {
    const p = place()
    await seeded(p)
    p.ts.cli = false
    const s = open(p)
    s.c.start()
    await s.c.tick()
    expect(fileJson(p.file).enabled).toBe(true)
    await after(p, s, 5_000)
    expect(fileJson(p.file).enabled).toBe(false)
    expect(s.events.stopped).toEqual([{ reason: 'no_cli', off: true, willResume: true }])
    expect((await s.c.state()).resume).toEqual({ waiting: 'tailscale_unreadable' })
    await after(p, s, 5_000)
    expect(fileJson(p.file).enabled).toBe(false)
    p.ts.cli = true
    await after(p, s, 5_000)
    expect(fileJson(p.file).enabled).toBe(true)
    expect(s.events.resumed).toBe(1)
  })

  it('the restart while already paused: resumes at the first tick once all is ok', async () => {
    const p = place()
    await seeded(p)
    p.ts.self = starting()
    const first = open(p)
    first.c.start()
    await first.c.tick()
    expect(fileJson(p.file).enabled).toBe(false)
    first.c.stop()
    p.ts.self = selfStatus()
    const s = open(p)
    s.c.start()
    await s.c.tick()
    expect(fileJson(p.file).enabled).toBe(true)
    expect(s.events.resumed).toBe(1)
    expect(s.events.outside).toBe(0)
  })

  it.each([
    ['another host', () => selfStatus({}, { DNSName: `${OTHER_HOST}.` })],
    ['another login', () => selfStatus({ User: { [String(USER_ID)]: { LoginName: OTHER_LOGIN } } })],
  ] as Array<[string, () => unknown]>)('%s at the resume: nothing written, no device removed, the owner must switch it on', async (_name, self) => {
    const p = place()
    const s = await paused(p)
    const text = readFileSync(p.file, 'utf8')
    p.ts.self = self()
    for (let i = 0; i < 30; i += 1) await after(p, s, 5_000)
    expect(readFileSync(p.file, 'utf8')).toBe(text)
    expect(deviceIds(p.file)).toEqual([A])
    expect(s.events.resumed).toBe(0)
    const state = await s.c.state()
    expect(state.needsOwner).toBe('identity_changed')
    expect(state.resume).toEqual({ waiting: 'needs_owner' })
    // even when the identity comes back, only the owner's switch turns it on again
    p.ts.self = selfStatus()
    for (let i = 0; i < 15; i += 1) await after(p, s, 5_000)
    expect(readFileSync(p.file, 'utf8')).toBe(text)
    expect((await s.c.state()).resume).toEqual({ waiting: 'needs_owner' })
    // the owner's switch: devices kept, since the identity is the stored one
    expect(await s.c.turnOn()).toMatchObject({ ok: true, devicesRemoved: 0 })
    expect((await s.c.state()).needsOwner).toBe(null)
  })

  it('a stop for a changed identity is not a pause: willResume false, and needsOwner', async () => {
    const p = place()
    await seeded(p)
    p.ts.self = selfStatus({}, { DNSName: `${OTHER_HOST}.` })
    const s = open(p)
    s.c.start()
    await s.c.tick()
    expect(s.events.stopped).toEqual([{ reason: 'identity_changed', off: true, willResume: false }])
    expect((await s.c.state()).needsOwner).toBe('identity_changed')
  })

  it('Serve not ok: no write, the reason in state()', async () => {
    const p = place()
    const s = await paused(p)
    p.ts.self = selfStatus()
    p.ts.serve = {}
    await after(p, s, 5_000)
    expect(fileJson(p.file).enabled).toBe(false)
    expect((await s.c.state()).resume).toEqual({ waiting: 'serve_not_ok:no_handler' })
    p.ts.serve = { ...goodServe(4320), AllowFunnel: { [`${HOST}:443`]: true } }
    await after(p, s, 5_000)
    expect((await s.c.state()).resume).toEqual({ waiting: 'serve_not_ok:funnel' })
    expect(s.events.resumed).toBe(0)
    p.ts.serve = goodServe(4320)
    await after(p, s, 5_000)
    expect(s.events.resumed).toBe(1)
  })

  it.each([
    ['a login edited', (doc: Record<string, unknown>) => { doc.logins = [LOGIN, OTHER_LOGIN] }],
    ['a device added', (doc: Record<string, unknown>) => { (doc.devices as unknown[]).push(device(newSecret(), B)) }],
    ['the port moved', (doc: Record<string, unknown>) => { doc.port = 4400 }],
  ] as Array<[string, (doc: Record<string, unknown>) => void]>)('%s while paused: flagged, never resumed', async (_name, change) => {
    const p = place()
    const s = await paused(p)
    edit(p.file, change)
    const text = readFileSync(p.file, 'utf8')
    p.ts.self = selfStatus()
    for (let i = 0; i < 30; i += 1) await after(p, s, 5_000)
    expect(readFileSync(p.file, 'utf8')).toBe(text)
    expect(s.events.resumed).toBe(0)
    expect(s.events.outside).toBe(1)
    expect((await s.c.state()).resume).toEqual({ waiting: 'flagged' })
  })

  it('a file switched off by hand while the app runs: flagged, never resumed, even after acknowledge', async () => {
    const p = place()
    await seeded(p)
    const s = open(p)
    s.c.start()
    await s.c.tick()
    edit(p.file, (doc) => { doc.enabled = false })
    await after(p, s, 5_000)
    expect(s.events.outside).toBe(1)
    for (let i = 0; i < 5; i += 1) await after(p, s, 5_000)
    expect(fileJson(p.file).enabled).toBe(false)
    expect((await s.c.state()).resume).toEqual({ waiting: 'flagged' })
    // the owner accepts the off file: it stays off, here and after a restart
    expect(await s.c.acknowledge((await s.c.state()).flagDigest)).toEqual({ ok: true })
    for (let i = 0; i < 30; i += 1) await after(p, s, 5_000)
    expect(fileJson(p.file).enabled).toBe(false)
    expect(s.events.resumed).toBe(0)
    expect((await s.c.state()).wanted).toBe(false)
    s.c.stop()
    const next = open(p)
    next.c.start()
    await next.c.tick()
    await after(p, next, 5_000)
    expect(fileJson(p.file).enabled).toBe(false)
    expect(next.events.resumed).toBe(0)
  })

  it('a file switched off by hand while the app was closed: flagged at start, never resumed', async () => {
    const p = place()
    await seeded(p)
    edit(p.file, (doc) => { doc.enabled = false })
    const s = open(p)
    s.c.start()
    for (let i = 0; i < 30; i += 1) await after(p, s, 5_000)
    expect(fileJson(p.file).enabled).toBe(false)
    expect(s.events.resumed).toBe(0)
    expect(s.events.outside).toBe(1)
  })

  it('an unknown field added while paused changes nothing watched: resumed, the field kept', async () => {
    const p = place()
    const s = await paused(p)
    edit(p.file, (doc) => { doc.note = 'kept' })
    p.ts.self = selfStatus()
    await after(p, s, 5_000)
    expect(fileJson(p.file)).toMatchObject({ enabled: true, note: 'kept' })
    expect(s.events.resumed).toBe(1)
  })

  it('wanted false (never switched on by the owner here): never resumed', async () => {
    const p = place()
    await seeded(p, { on: false })
    const s = open(p)
    s.c.start()
    for (let i = 0; i < 30; i += 1) await after(p, s, 5_000)
    expect(fileJson(p.file).enabled).toBe(false)
    expect(s.events.resumed).toBe(0)
    expect((await s.c.state()).resume).toBe(null)
  })

  it('the owner\'s turnOff: never resumed, here or after a restart', async () => {
    const p = place()
    const s = await paused(p)
    expect((await s.c.turnOff()).ok).toBe(true)
    p.ts.self = selfStatus()
    for (let i = 0; i < 30; i += 1) await after(p, s, 5_000)
    expect(fileJson(p.file).enabled).toBe(false)
    expect(s.events.resumed).toBe(0)
    expect((await s.c.state()).resume).toBe(null)
    s.c.stop()
    const next = open(p)
    next.c.start()
    await next.c.tick()
    await after(p, next, 5_000)
    expect(fileJson(p.file).enabled).toBe(false)
    expect((await next.c.state()).wanted).toBe(false)
  })

  it('the owner\'s turnOff while the entry is on: wanted false, and a later stop is not a pause', async () => {
    const p = place()
    await seeded(p)
    const s = open(p)
    s.c.start()
    await s.c.tick()
    expect((await s.c.turnOff()).ok).toBe(true)
    expect((await s.c.state()).wanted).toBe(false)
  })

  it('repairPermissions: never resumed', async () => {
    const p = place()
    const s = await paused(p)
    chmodSync(p.file, 0o644)
    await after(p, s, 5_000)
    expect(s.events.outside).toBe(1)
    expect(await s.c.repairPermissions()).toMatchObject({ ok: true, devicesRemoved: 1 })
    p.ts.self = selfStatus()
    for (let i = 0; i < 30; i += 1) await after(p, s, 5_000)
    expect(fileJson(p.file).enabled).toBe(false)
    expect(s.events.resumed).toBe(0)
    expect((await s.c.state()).wanted).toBe(false)
  })

  it('repairPermissions clears wanted even when there was nothing to repair', async () => {
    const p = place()
    await seeded(p)
    const s = open(p)
    expect((await s.c.repairPermissions()).ok).toBe(false)
    expect((await s.c.state()).wanted).toBe(false)
  })

  it.each([
    ['a newer schema', (file: string) => writeFileSync(file, JSON.stringify(setting(4320, [], { schema: 2, enabled: false })), { mode: 0o600 })],
    ['not JSON', (file: string) => writeFileSync(file, '{"schema":1,', { mode: 0o600 })],
    ['a bad host', (file: string) => edit(file, (doc) => { doc.host = '127.0.0.1' })],
  ] as Array<[string, (file: string) => void]>)('remote.json made %s while paused: never resumed', async (_name, spoil) => {
    const p = place()
    const s = await paused(p)
    spoil(p.file)
    const text = readFileSync(p.file, 'utf8')
    p.ts.self = selfStatus()
    for (let i = 0; i < 30; i += 1) await after(p, s, 5_000)
    expect(readFileSync(p.file, 'utf8')).toBe(text)
    expect(s.events.resumed).toBe(0)
  })

  it('under the lock: a file changed between the checks and the write is not written', async () => {
    const p = place()
    let change: (() => void) | null = null
    const s = await paused(p, { onBeforeServe: () => { change?.(); change = null } })
    p.ts.self = selfStatus()
    // only an unknown field changes, so nothing the watch compares: only the re-check under the lock sees it
    change = () => edit(p.file, (doc) => { doc.note = 'late' })
    await after(p, s, 5_000)
    expect(fileJson(p.file)).toMatchObject({ enabled: false, note: 'late' })
    expect(s.events.resumed).toBe(0)
    expect((await s.c.state()).resume).toEqual({ waiting: 'changed_outside' })
    // a later attempt checks the file as it now is
    await after(p, s, 5_000)
    expect(fileJson(p.file)).toMatchObject({ enabled: true, note: 'late' })
    expect(s.events.resumed).toBe(1)
  })

  it('under the lock: a watched change between the checks and the write is flagged, not written', async () => {
    const p = place()
    let change: (() => void) | null = null
    const s = await paused(p, { onBeforeServe: () => { change?.(); change = null } })
    p.ts.self = selfStatus()
    change = () => edit(p.file, (doc) => { (doc.devices as unknown[]).push(device(newSecret(), B)) })
    await after(p, s, 5_000)
    expect(fileJson(p.file).enabled).toBe(false)
    expect(s.events.resumed).toBe(0)
    expect(s.events.outside).toBe(1)
  })

  it('under the lock: the owner\'s turnOff during the checks wins', async () => {
    const p = place()
    let race: (() => void) | null = null
    const s = await paused(p, { onBeforeServe: () => { race?.(); race = null } })
    p.ts.self = selfStatus()
    let off: Promise<unknown> = Promise.resolve()
    race = () => { off = s.c.turnOff() }
    await after(p, s, 5_000)
    await off
    expect(fileJson(p.file).enabled).toBe(false)
    expect(s.events.resumed).toBe(0)
    expect((await s.c.state()).wanted).toBe(false)
  })

  it('tries every 5 seconds for the first 2 minutes after start, then every 60 seconds', async () => {
    const p = place()
    // a pause kept from an earlier run
    await paused(p)
    const s = open(p)
    s.c.start()
    const at: number[] = []
    for (let t = 0; t <= 300_000; t += 5_000) {
      const before = s.selfCalls()
      p.clock.now = START + t
      await s.c.tick()
      if (s.selfCalls() > before) at.push(t / 1000)
    }
    expect(at).toEqual([...Array.from({ length: 25 }, (_, i) => i * 5), 180, 240, 300])
    expect((await s.c.state()).resume).toEqual({ waiting: 'tailscale_not_running' })
  })

  it('tries every 5 seconds for the first 2 minutes after its own stop, then every 60 seconds', async () => {
    const p = place()
    await seeded(p)
    const s = open(p)
    s.c.start()
    await s.c.tick()
    expect(fileJson(p.file).enabled).toBe(true)
    // the stop comes at the next 60-second check
    p.ts.self = starting()
    const stoppedAt = 60_000
    const at: number[] = []
    for (let t = stoppedAt; t <= stoppedAt + 300_000; t += 5_000) {
      const before = s.selfCalls()
      p.clock.now = START + t
      await s.c.tick()
      if (s.selfCalls() > before) at.push((t - stoppedAt) / 1000)
    }
    expect(s.events.stopped).toEqual([{ reason: 'not_running', off: true, willResume: true }])
    // 0 is the check that stopped it; then every 5 seconds to 120, then every 60
    expect(at).toEqual([...Array.from({ length: 25 }, (_, i) => i * 5), 180, 240, 300])
  })

  it('a stop within 60 seconds of a resume: the next resume waits at least 60 seconds', async () => {
    const p = place()
    const s = await paused(p)
    p.ts.self = selfStatus()
    await after(p, s, 5_000)
    expect(s.events.resumed).toBe(1)
    const resumedAt = p.clock.now
    // the next check, at the next tick, is not ok: stopped again, and noticed
    p.ts.serve = {}
    await after(p, s, 5_000)
    expect(fileJson(p.file).enabled).toBe(false)
    expect(s.events.stopped).toHaveLength(2)
    expect(s.events.stopped[1]).toEqual({ reason: 'no_handler', off: true, willResume: true })
    const stoppedAt = p.clock.now
    p.ts.serve = goodServe(4320)
    while (p.clock.now < stoppedAt + 55_000) await after(p, s, 5_000)
    expect(fileJson(p.file).enabled).toBe(false)
    expect(s.events.resumed).toBe(1)
    await after(p, s, 5_000)
    expect(p.clock.now - stoppedAt).toBe(60_000)
    expect(fileJson(p.file).enabled).toBe(true)
    expect(s.events.resumed).toBe(2)
    expect(p.clock.now - resumedAt).toBeGreaterThanOrEqual(60_000)
  })

  it('a stop more than 60 seconds after a resume: tried again 5 seconds later', async () => {
    const p = place()
    const s = await paused(p)
    p.ts.self = selfStatus()
    await after(p, s, 5_000)
    expect(s.events.resumed).toBe(1)
    await after(p, s, 5_000)
    await after(p, s, 60_000)
    p.ts.serve = {}
    await after(p, s, 60_000)
    expect(s.events.stopped).toHaveLength(2)
    p.ts.serve = goodServe(4320)
    await after(p, s, 5_000)
    expect(s.events.resumed).toBe(2)
  })

  it('no state store: no resume, and onStopped says so', async () => {
    const p = place()
    writeSetting(p.dir, setting(4320, [device(newSecret(), A)]))
    p.ts.self = starting()
    const s = open(p, { store: null })
    s.c.start()
    await s.c.tick()
    expect(s.events.stopped).toEqual([{ reason: 'not_running', off: true, willResume: false }])
    p.ts.self = selfStatus()
    for (let i = 0; i < 30; i += 1) await after(p, s, 5_000)
    expect(fileJson(p.file).enabled).toBe(false)
    expect(s.events.resumed).toBe(0)
    expect((await s.c.state()).resume).toBe(null)
  })

  it('a flag set when the watch stops it: willResume false', async () => {
    const p = place()
    await seeded(p)
    appendDevice(p.file, B)
    p.ts.self = starting()
    const s = open(p)
    s.c.start()
    await s.c.tick()
    expect(s.events.outside).toBe(1)
    expect(s.events.stopped).toEqual([{ reason: 'not_running', off: true, willResume: false }])
  })

  it('wanted survives a restart', async () => {
    const p = place()
    await seeded(p)
    expect((await open(p).c.state()).wanted).toBe(true)
    expect(fileJson(p.stateFile)).toMatchObject({ schema: 1, wanted: true })
    const s = open(p)
    expect((await s.c.turnOff()).ok).toBe(true)
    expect((await open(p).c.state()).wanted).toBe(false)
  })

  it('turnOn after an identity change still removes every device, as before', async () => {
    const p = place()
    const s = await paused(p)
    p.ts.self = selfStatus({}, { DNSName: `${OTHER_HOST}.` })
    p.ts.serve = goodServe(4320, OTHER_HOST)
    await after(p, s, 5_000)
    expect((await s.c.state()).needsOwner).toBe('identity_changed')
    expect(deviceIds(p.file)).toEqual([A])
    expect(await s.c.turnOn()).toMatchObject({ ok: true, devicesRemoved: 1 })
    expect(fileJson(p.file)).toMatchObject({ enabled: true, host: OTHER_HOST, devices: [] })
    expect((await s.c.state()).wanted).toBe(true)
  })

  it('no state or callback carries a login, a hash (other than flagDigest), the token or a code', async () => {
    const p = place()
    const s = await paused(p)
    p.ts.self = selfStatus()
    await after(p, s, 5_000)
    const state = await s.c.state()
    const text = JSON.stringify({ ...state, view: undefined, flagDigest: undefined }) + JSON.stringify(s.events)
    for (const secret of [LOGIN, TOKEN, CODE, CODE_ID]) expect(text).not.toContain(secret)
    expect(text).not.toMatch(/[0-9a-f]{64}/)
  })
})

describe('each condition of the resume, alone', () => {
  it('a flag still set after the file was put back exactly: never resumed, and state() says flagged', async () => {
    const p = place()
    const s = await paused(p)
    const original = readFileSync(p.file, 'utf8')
    edit(p.file, (doc) => { doc.logins = [LOGIN, OTHER_LOGIN] })
    await after(p, s, 5_000)
    expect(s.events.outside).toBe(1)
    writeFileSync(p.file, original, { mode: 0o600 })
    p.ts.self = selfStatus()
    for (let i = 0; i < 5; i += 1) await after(p, s, 5_000)
    expect(fileJson(p.file).enabled).toBe(false)
    expect(s.events.resumed).toBe(0)
    expect((await s.c.state()).resume).toEqual({ waiting: 'flagged' })
  })

  it('under the lock: a flag raised during the checks, with the file put back before the write, still stops it', async () => {
    const p = place()
    let gate: (() => Promise<void>) | null = null
    const s = await paused(p, { serveGate: async () => { const g = gate; gate = null; await g?.() } })
    p.ts.self = selfStatus()
    const original = readFileSync(p.file, 'utf8')
    gate = async () => {
      edit(p.file, (doc) => { doc.logins = [LOGIN, OTHER_LOGIN] })
      // main's own operation reads the file under the lock and flags the edit; it writes nothing
      expect((await s.c.removeDevice('0000000000000000')).ok).toBe(true)
      writeFileSync(p.file, original, { mode: 0o600 })
    }
    await after(p, s, 5_000)
    expect(s.events.outside).toBe(1)
    expect(readFileSync(p.file, 'utf8')).toBe(original)
    expect(s.events.resumed).toBe(0)
  })

  it('a file changed after the tick\'s file check: refused before any Tailscale read', async () => {
    const p = place()
    let opens = 0
    let armed = false
    const s = await paused(p, {
      beforeOpen: () => {
        if (!armed) return
        opens += 1
        // the tick reads remote.json three times: the file check, the Serve check, the resume
        if (opens === 3) edit(p.file, (doc) => { (doc.devices as unknown[]).push(device(newSecret(), B)) })
      },
    })
    p.ts.self = selfStatus()
    const calls = s.selfCalls()
    armed = true
    await after(p, s, 5_000)
    armed = false
    expect(opens).toBe(3)
    expect(s.selfCalls()).toBe(calls)
    expect((await s.c.state()).resume).toEqual({ waiting: 'changed_outside' })
    for (let i = 0; i < 5; i += 1) await after(p, s, 5_000)
    expect(fileJson(p.file).enabled).toBe(false)
    expect(s.events.outside).toBe(1)
    expect(s.events.resumed).toBe(0)
  })

  it('under the lock: an owner\'s turnOn that failed during the checks still cancels this resume', async () => {
    const p = place()
    let gate: (() => Promise<void>) | null = null
    const s = await paused(p, { serveGate: async () => { const g = gate; gate = null; await g?.() } })
    p.ts.self = selfStatus()
    gate = async () => {
      p.ts.serve = {}
      expect(await s.c.turnOn()).toMatchObject({ ok: false, step: 'serve' })
      p.ts.serve = goodServe(4320)
    }
    await after(p, s, 5_000)
    expect(fileJson(p.file).enabled).toBe(false)
    expect(s.events.resumed).toBe(0)
    expect((await s.c.state()).resume).toEqual({ waiting: 'changed_outside' })
    // the next attempt, checked after it, goes ahead
    await after(p, s, 5_000)
    expect(s.events.resumed).toBe(1)
  })

  it('no state kept and a file open to others: flagged (it cannot be read to tell)', async () => {
    const p = place()
    writeSetting(p.dir, setting(4320, [], { enabled: false }), 0o644)
    const s = open(p)
    s.c.start()
    await s.c.tick()
    expect(s.events.outside).toBe(1)
  })

  it('every check passed but the write did not land: write_failed, and tried again', async () => {
    const p = place()
    const s = await paused(p)
    p.ts.self = selfStatus()
    // remote.json's folder cannot take the lock file
    chmodSync(p.dir, 0o500)
    try {
      await after(p, s, 5_000)
      expect(fileJson(p.file).enabled).toBe(false)
      expect((await s.c.state()).resume).toEqual({ waiting: 'write_failed' })
    } finally {
      chmodSync(p.dir, 0o700)
    }
    await after(p, s, 5_000)
    expect(s.events.resumed).toBe(1)
  })

  it('a stop exactly 60 seconds after a resume still waits a minute', async () => {
    const p = place()
    const s = await paused(p)
    p.ts.self = selfStatus()
    await after(p, s, 5_000)
    expect(s.events.resumed).toBe(1)
    const resumedAt = p.clock.now
    await after(p, s, 5_000)
    p.clock.now = resumedAt + 60_000
    p.ts.serve = {}
    await s.c.refresh()
    expect(s.events.stopped).toHaveLength(2)
    p.ts.serve = goodServe(4320)
    while (p.clock.now < resumedAt + 115_000) await after(p, s, 5_000)
    expect(s.events.resumed).toBe(1)
    await after(p, s, 5_000)
    expect(s.events.resumed).toBe(2)
  })

  it('a file accepted for another port: the stop is not a pause, and it is never resumed', async () => {
    const p = place()
    await seeded(p)
    const s = open(p)
    s.c.start()
    await s.c.tick()
    edit(p.file, (doc) => { doc.port = 4400 })
    await after(p, s, 5_000)
    expect(await s.c.acknowledge((await s.c.state()).flagDigest)).toEqual({ ok: true })
    expect((await s.c.state()).wanted).toBe(true)
    // Serve proxies to 4320, not 4400: the next check stops it
    await after(p, s, 60_000)
    expect(s.events.stopped).toEqual([{ reason: 'wrong_target', off: true, willResume: false }])
    p.ts.serve = goodServe(4400)
    for (let i = 0; i < 30; i += 1) await after(p, s, 5_000)
    expect(fileJson(p.file).enabled).toBe(false)
    expect(s.events.resumed).toBe(0)
    expect((await s.c.state()).resume).toEqual({ waiting: 'needs_owner' })
  })

  it('two logins accepted: the stop is not a pause, and it is never resumed (turnOn would write one)', async () => {
    const p = place()
    await seeded(p)
    const s = open(p)
    s.c.start()
    await s.c.tick()
    edit(p.file, (doc) => { doc.logins = [LOGIN, OTHER_LOGIN] })
    await after(p, s, 5_000)
    expect(await s.c.acknowledge((await s.c.state()).flagDigest)).toEqual({ ok: true })
    p.ts.self = starting()
    await after(p, s, 60_000)
    expect(s.events.stopped).toEqual([{ reason: 'not_running', off: true, willResume: false }])
    p.ts.self = selfStatus()
    for (let i = 0; i < 30; i += 1) await after(p, s, 5_000)
    expect(fileJson(p.file).enabled).toBe(false)
    expect(s.events.resumed).toBe(0)
  })

  it('a tagged node at the resume: nothing written, the owner must switch it on', async () => {
    const p = place()
    const s = await paused(p)
    const text = readFileSync(p.file, 'utf8')
    p.ts.self = taggedStatus()
    await after(p, s, 5_000)
    expect(await s.c.state()).toMatchObject({ needsOwner: 'identity_changed', resume: { waiting: 'needs_owner' } })
    p.ts.self = selfStatus()
    for (let i = 0; i < 30; i += 1) await after(p, s, 5_000)
    expect(readFileSync(p.file, 'utf8')).toBe(text)
  })

  it('a login that differs only in case is the stored one: resumed', async () => {
    const p = place()
    const s = await paused(p)
    p.ts.self = selfStatus({ User: { [String(USER_ID)]: { LoginName: 'Owner@Example.com' } } })
    await after(p, s, 5_000)
    expect(s.events.resumed).toBe(1)
    expect(fileJson(p.file).logins).toEqual([LOGIN])
  })

  it('a kept digest and a file switched off with its devices removed while closed: flagged', async () => {
    const p = place()
    await seeded(p)
    edit(p.file, (doc) => { doc.enabled = false; doc.devices = [] })
    const s = open(p)
    s.c.start()
    await s.c.tick()
    expect(s.events.outside).toBe(1)
  })

  it('flagged at start, then put back to the kept state: no second notice (the kept digest is the baseline)', async () => {
    const p = place()
    await seeded(p)
    const original = readFileSync(p.file, 'utf8')
    appendDevice(p.file, B)
    const s = open(p)
    s.c.start()
    await s.c.tick()
    expect(s.events.outside).toBe(1)
    writeFileSync(p.file, original, { mode: 0o600 })
    await after(p, s, 5_000)
    expect(s.events.outside).toBe(1)
    expect((await s.c.state()).flag).toBe(true)
  })

  it('a stop while wanted is false is not a pause: a first run that accepted an enabled file', async () => {
    const p = place()
    writeSetting(p.dir, setting(4320, [device(newSecret(), A)]))
    const s = open(p)
    s.c.start()
    await s.c.tick()
    expect(await s.c.acknowledge((await s.c.state()).flagDigest)).toEqual({ ok: true })
    expect((await s.c.state()).wanted).toBe(false)
    p.ts.self = starting()
    await after(p, s, 60_000)
    expect(s.events.stopped).toEqual([{ reason: 'not_running', off: true, willResume: false }])
    p.ts.self = selfStatus()
    for (let i = 0; i < 30; i += 1) await after(p, s, 5_000)
    expect(fileJson(p.file).enabled).toBe(false)
  })

  it('a watch that was never started (or was stopped) does not resume, and its stop is not a pause', async () => {
    const p = place()
    await seeded(p)
    p.ts.self = starting()
    const s = open(p)
    await s.c.tick()
    expect(s.events.stopped).toEqual([{ reason: 'not_running', off: true, willResume: false }])
    p.ts.self = selfStatus()
    for (let i = 0; i < 30; i += 1) await after(p, s, 5_000)
    expect(fileJson(p.file).enabled).toBe(false)
    s.c.start()
    s.c.stop()
    for (let i = 0; i < 30; i += 1) await after(p, s, 5_000)
    expect(fileJson(p.file).enabled).toBe(false)
    expect(s.events.resumed).toBe(0)
  })

  it.each([
    ['a digest that is not hex', { digest: 'x'.repeat(64), wanted: true }],
    ['wanted not a boolean', { digest: null, wanted: 'yes' }],
    ['not an object', 'state'],
  ] as Array<[string, unknown]>)('a store that answers %s: none kept', async (_name, value) => {
    const p = place()
    writeSetting(p.dir, setting(4320, [device(newSecret(), A)], { enabled: false }))
    const { store } = memoryStore()
    store.read = async () => value as never
    const s = open(p, { store })
    s.c.start()
    await s.c.tick()
    expect(s.events.outside).toBe(1)
    expect((await s.c.state()).wanted).toBe(false)
  })
})

describe('the state file is the userData one, never remote.json\'s folder', () => {
  it('createRemoteEntryState with app names userData/remote-entry-state.json', async () => {
    const dir = scratchDir('remote-restart-')
    mkdirSync(join(dir, 'ud'))
    const store = createRemoteEntryState({ app: { getPath: (name: string) => (name === 'userData' ? join(dir, 'ud') : '') } })
    await store.write({ digest: null, wanted: false })
    expect(existsSync(join(dir, 'ud', 'remote-entry-state.json'))).toBe(true)
  })
})
