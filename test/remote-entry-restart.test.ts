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
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import fsPromises from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import remoteEntry from '../electron/remote-entry.cjs'
import remoteEntryState from '../electron/remote-entry-state.cjs'
import type { RemoteEntryStateStore, RemoteEntryStoredState } from '../electron/remote-entry-state.cjs'
import { removeScratchDirs, scratchDir } from './scratch.js'
import { waitUntil } from './wait.js'
import { device, newSecret, setting, writeSetting } from './remote-fixtures.js'
import { ALLOWED_ARGS, HOST, LOGIN, USER_ID, cliExists, fakeTailscale, goodServe, selfStatus, taggedStatus, tailscaleCalls } from './remote-entry-fixtures.js'

const { createRemoteEntry } = remoteEntry
const { PENDING, createRemoteEntryState } = remoteEntryState

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
/** What the state names for this place's remote.json. */
const fileIdOf = (p: Place) => createHash('sha256').update(p.file).digest('hex')

/** One run of the app on `p`: a new controller, as after a restart. `store: null` gives none. */
function open(p: Place, opts: {
  store?: RemoteEntryStateStore | null; onBeforeServe?: () => void; serveGate?: () => Promise<void>; beforeOpen?: () => void
  isPackaged?: boolean; viewerPort?: number; fs?: Partial<typeof fsPromises>
  setTimeout?: (fn: () => void, ms: number) => unknown; clearTimeout?: (handle: unknown) => void
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
    isPackaged: opts.isPackaged ?? true,
    ...(opts.viewerPort !== undefined ? { viewerPort: opts.viewerPort } : {}),
    ...(opts.setTimeout ? { setTimeout: opts.setTimeout, clearTimeout: opts.clearTimeout ?? (() => {}) } : {}),
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
    ...(opts.beforeOpen || opts.fs ? {
      fsImpl: {
        ...fsPromises,
        open: async (...args: Parameters<typeof fsPromises.open>) => {
          if (args[0] === p.file) opts.beforeOpen?.()
          return fsPromises.open(...args)
        },
        ...opts.fs,
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

/** What state().resume waits for, or null. */
async function waitingOf(s: ReturnType<typeof open>) {
  return (await s.c.state()).resume?.waiting ?? null
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
  // what a state names it is for: one remote.json and one viewer
  const ID = { file: 'f'.repeat(64), viewerPort: 4319 }
  const stored = (digest: string | null, wanted: boolean) => ({ digest, wanted, ...ID })

  it('writes { schema: 1, digest, wanted, file, viewerPort } 0600 under userData, and reads it back', async () => {
    const dir = scratchDir('remote-restart-')
    const store = createRemoteEntryState({ app: { getPath: () => dir } })
    expect(await store.read()).toBe(null)
    await store.write(stored('a'.repeat(64), true), { allowRaise: true })
    const file = join(dir, 'remote-entry-state.json')
    expect(fileJson(file)).toEqual({ schema: 1, ...stored('a'.repeat(64), true) })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(await store.read()).toEqual(stored('a'.repeat(64), true))
    await store.write(stored(null, false))
    expect(await store.read()).toEqual(stored(null, false))
    await store.write(stored(PENDING, false))
    expect(await store.read()).toEqual(stored(PENDING, false))
  })

  it('keeps unknown fields', async () => {
    const dir = scratchDir('remote-restart-')
    const file = join(dir, 'state.json')
    writeFileSync(file, JSON.stringify({ schema: 1, ...stored(null, false), later: { x: 1 } }), { mode: 0o600 })
    const store = createRemoteEntryState({ filePath: file })
    await store.write(stored('b'.repeat(64), true), { allowRaise: true })
    expect(fileJson(file)).toEqual({ schema: 1, ...stored('b'.repeat(64), true), later: { x: 1 } })
  })

  it('reads a newer schema as no state and never overwrites it', async () => {
    const dir = scratchDir('remote-restart-')
    const file = join(dir, 'state.json')
    const text = JSON.stringify({ schema: 2, ...stored('c'.repeat(64), true) })
    writeFileSync(file, text, { mode: 0o600 })
    const store = createRemoteEntryState({ filePath: file })
    expect(await store.read()).toBe(null)
    await expect(store.write(stored('d'.repeat(64), false))).rejects.toThrow()
    expect(readFileSync(file, 'utf8')).toBe(text)
  })

  it.each([
    ['not JSON', '{"schema":1,'],
    ['an array', '[]'],
    ['no schema', JSON.stringify({ ...stored(null, true) })],
    ['schema 0', JSON.stringify({ schema: 0, ...stored(null, true) })],
    ['a digest that is not 64 hex', JSON.stringify({ schema: 1, ...stored('abc', true) })],
    ['a digest in capitals', JSON.stringify({ schema: 1, ...stored('A'.repeat(64), true) })],
    ['wanted not a boolean', JSON.stringify({ schema: 1, ...stored(null, true), wanted: 'yes' })],
    ['no wanted', JSON.stringify({ schema: 1, digest: null, ...ID })],
    ['no file', JSON.stringify({ schema: 1, digest: null, wanted: true, viewerPort: 4319 })],
    ['no viewerPort', JSON.stringify({ schema: 1, digest: null, wanted: true, file: ID.file })],
    ['a viewerPort that is not a port', JSON.stringify({ schema: 1, ...stored(null, true), viewerPort: 70_000 })],
  ])('reads %s as no state, and a write replaces it', async (_name, text) => {
    const dir = scratchDir('remote-restart-')
    const file = join(dir, 'state.json')
    writeFileSync(file, text, { mode: 0o600 })
    const store = createRemoteEntryState({ filePath: file })
    expect(await store.read()).toBe(null)
    await store.write(stored(null, false))
    expect(await store.read()).toEqual(stored(null, false))
  })

  it('refuses to write a state that is not one', async () => {
    const dir = scratchDir('remote-restart-')
    const store = createRemoteEntryState({ filePath: join(dir, 'state.json') })
    await expect(store.write(stored('x', true))).rejects.toThrow()
    await expect(store.write({ ...stored(null, true), wanted: 'yes' as never })).rejects.toThrow()
    await expect(store.write({ digest: null, wanted: false } as never)).rejects.toThrow()
    expect(existsSync(join(dir, 'state.json'))).toBe(false)
  })

  it('reads a symlink, a FIFO, a folder or another user\'s file as no state, without blocking, and writes over it', async () => {
    const dir = scratchDir('remote-restart-')
    const file = join(dir, 'state.json')
    writeFileSync(join(dir, 'real.json'), JSON.stringify({ schema: 1, ...stored('a'.repeat(64), true) }), { mode: 0o600 })
    symlinkSync(join(dir, 'real.json'), file)
    const store = createRemoteEntryState({ filePath: file })
    expect(await store.read()).toBe(null)
    await store.write(stored(null, false))
    expect(lstatSync(file).isFile()).toBe(true)
    // the link's target is untouched
    expect(fileJson(join(dir, 'real.json')).wanted).toBe(true)
    unlinkSync(file)
    execFileSync('/usr/bin/mkfifo', [file])
    expect(await store.read()).toBe(null)
    unlinkSync(file)
    mkdirSync(file)
    expect(await store.read()).toBe(null)
    const other = join(dir, 'other.json')
    writeFileSync(other, JSON.stringify({ schema: 1, ...stored('a'.repeat(64), true) }), { mode: 0o600 })
    expect(await createRemoteEntryState({ filePath: other, uid: (process.getuid?.() ?? 0) + 1 }).read()).toBe(null)
    expect(await createRemoteEntryState({ filePath: other }).read()).toEqual(stored('a'.repeat(64), true))
  })

  it('never raises wanted from false to true unless the write says the owner switched it on', async () => {
    const dir = scratchDir('remote-restart-')
    const store = createRemoteEntryState({ filePath: join(dir, 'state.json') })
    // nothing stored: false
    expect(await store.write(stored('a'.repeat(64), true))).toEqual({ wanted: false })
    expect(await store.read()).toEqual(stored('a'.repeat(64), false))
    expect(await store.write(stored('a'.repeat(64), true), { allowRaise: true })).toEqual({ wanted: true })
    // stored true for the same remote.json and viewer: kept
    expect(await store.write(stored('b'.repeat(64), true))).toEqual({ wanted: true })
    // lowering is always allowed
    expect(await store.write(stored('b'.repeat(64), false))).toEqual({ wanted: false })
    expect(await store.write(stored('b'.repeat(64), true))).toEqual({ wanted: false })
    // stored true for another viewer: counts as false here
    await store.write({ ...stored('b'.repeat(64), true), viewerPort: 4392 }, { allowRaise: true })
    expect(await store.write(stored('b'.repeat(64), true))).toEqual({ wanted: false })
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

  // #617 PR 2d review round 1, item 7: the panel says it cannot tell what changed
  it('a change found at the first look after a start has nothing to compare with: review() says unknown', async () => {
    const p = place()
    writeSetting(p.dir, setting(4320, [device(newSecret(), A)], { enabled: false }))
    const { store } = memoryStore({ digest: 'a'.repeat(64), wanted: true, file: fileIdOf(p), viewerPort: 4319 })
    const s = open(p, { store })
    s.c.start()
    await s.c.tick()
    const review = await s.c.review()
    expect(review.flag).toBe(true)
    expect(review.changes).toMatchObject({ unknown: true })
  })

  it('a state store that fails to read counts as none kept', async () => {
    const p = place()
    writeSetting(p.dir, setting(4320, [device(newSecret(), A)], { enabled: false }))
    const { m, store } = memoryStore({ digest: 'a'.repeat(64), wanted: true, file: fileIdOf(p), viewerPort: 4319 })
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
    expect(await waitingOf(s)).toBe('tailscale_not_running')
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
    expect(await waitingOf(s)).toBe('tailscale_unreadable')
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
    // only the owner's switch turns it on again: wanted is cleared, so nothing is waiting
    expect(state.wanted).toBe(false)
    expect(state.resume).toBe(null)
    // even when the identity comes back, only the owner's switch turns it on again
    p.ts.self = selfStatus()
    for (let i = 0; i < 15; i += 1) await after(p, s, 5_000)
    expect(readFileSync(p.file, 'utf8')).toBe(text)
    expect(await waitingOf(s)).toBe(null)
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
    expect(await waitingOf(s)).toBe('serve_not_ok:no_handler')
    p.ts.serve = { ...goodServe(4320), AllowFunnel: { [`${HOST}:443`]: true } }
    await after(p, s, 5_000)
    expect(await waitingOf(s)).toBe('serve_not_ok:funnel')
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
    expect(await waitingOf(s)).toBe('flagged')
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
    expect(await waitingOf(s)).toBe('flagged')
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
    // switched on again by hand (an outside change), then the watch stops it: a stop, not a pause
    // (off means off: the owner's Off switches it off before any Tailscale check)
    edit(p.file, (doc) => { doc.enabled = true })
    p.ts.self = starting()
    await after(p, s, 60_000)
    expect(s.events.stopped).toEqual([{ reason: 'not_wanted', off: true, willResume: false }])
    expect(await waitingOf(s)).toBe(null)
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
    expect(await waitingOf(s)).toBe('changed_outside')
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
    expect(await waitingOf(s)).toBe('tailscale_not_running')
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

  it('a stop more than 10 minutes after a resume: tried again 5 seconds later', async () => {
    const p = place()
    const s = await paused(p)
    p.ts.self = selfStatus()
    await after(p, s, 5_000)
    expect(s.events.resumed).toBe(1)
    for (let i = 0; i < 10; i += 1) await after(p, s, 60_000)
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
    await s.c.settled()
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
    // review round 1, item 8: only once the owner agreed
    expect(await s.c.turnOn()).toEqual({ ok: false, reason: 'would_remove_devices', step: 'file', devices: 1 })
    expect(await s.c.turnOn({ removeDevices: true })).toMatchObject({ ok: true, devicesRemoved: 1 })
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
    expect(await waitingOf(s)).toBe('flagged')
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
    expect(await waitingOf(s)).toBe('changed_outside')
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
    expect(await waitingOf(s)).toBe('changed_outside')
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
      expect(await waitingOf(s)).toBe('write_failed')
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
    expect(await waitingOf(s)).toBe('needs_owner')
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
    expect(await s.c.state()).toMatchObject({ needsOwner: 'identity_changed', wanted: false, resume: null })
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
    ['a viewerPort that is not a port', { digest: null, wanted: true, viewerPort: 0 }],
    ['not an object', 'state'],
  ] as Array<[string, unknown]>)('a store that answers %s: none kept', async (_name, value) => {
    const p = place()
    writeSetting(p.dir, setting(4320, [device(newSecret(), A)], { enabled: false }))
    const { store } = memoryStore()
    // named for this remote.json and viewer, so only the shape check can refuse it
    store.read = async () => (typeof value === 'object' ? { file: fileIdOf(p), viewerPort: 4319, ...value } : value) as never
    const s = open(p, { store })
    s.c.start()
    await s.c.tick()
    expect(s.events.outside).toBe(1)
    expect((await s.c.state()).wanted).toBe(false)
  })
})

// ── review round 1 ─────────────────────────────────────────────────────────

/** The kept state on disk. */
const keptOnDisk = (p: Place) => fileJson(p.stateFile) as { digest: string | null; wanted: boolean; file: string; viewerPort: number }

/** Timers the test fires by hand: only the state store's 5-second limit is held back. */
function heldTimers() {
  const held: Array<() => void> = []
  return {
    held,
    setTimeout: (fn: () => void, ms: number) => {
      if (ms === 5_000) {
        held.push(fn)
        return held.length
      }
      return setTimeout(fn, ms)
    },
    clearTimeout: (handle: unknown) => { if (typeof handle !== 'number' || handle > 1_000_000) clearTimeout(handle as NodeJS.Timeout) },
    fire: () => { for (const fn of held.splice(0)) fn() },
  }
}

describe('review round 1: a change while flagged, put back while closed, is still flagged', () => {
  it('P2: paused, B planted and flagged, the owner removes A and B, remote.json alone put back: flagged, never resumed', async () => {
    const p = place()
    const s0 = await paused(p)
    s0.c.stop()
    const keptCopy = readFileSync(p.file, 'utf8')
    const s1 = open(p)
    s1.c.start()
    await s1.c.tick()
    appendDevice(p.file, B)
    await after(p, s1, 5_000)
    expect((await s1.c.state()).flag).toBe(true)
    // the state says a review is due as soon as the flag is raised
    expect(keptOnDisk(p).digest).toBe(PENDING)
    expect((await s1.c.removeDevice(A)).ok).toBe(true)
    expect((await s1.c.removeDevice(B)).ok).toBe(true)
    expect(keptOnDisk(p).digest).toBe(PENDING)
    s1.c.stop()
    writeFileSync(p.file, keptCopy, { mode: 0o600 })
    p.ts.self = selfStatus()
    const s2 = open(p)
    s2.c.start()
    await s2.c.tick()
    for (let i = 0; i < 30; i += 1) await after(p, s2, 5_000)
    expect(s2.events.outside).toBe(1)
    expect((await s2.c.state()).flag).toBe(true)
    expect(s2.events.resumed).toBe(0)
    expect(fileJson(p.file).enabled).toBe(false)
  })

  it('P12: on, B planted and flagged, the owner turns off and removes A, the old on file put back: flagged at start', async () => {
    const p = place()
    await seeded(p)
    const kept = readFileSync(p.file, 'utf8')
    const s = open(p)
    s.c.start()
    await s.c.tick()
    appendDevice(p.file, B)
    await after(p, s, 5_000)
    expect((await s.c.turnOff()).ok).toBe(true)
    expect((await s.c.removeDevice(A)).ok).toBe(true)
    await s.c.settled()
    s.c.stop()
    writeFileSync(p.file, kept, { mode: 0o600 })
    const s2 = open(p)
    s2.c.start()
    await s2.c.tick()
    expect(s2.events.outside).toBe(1)
    expect((await s2.c.state()).flag).toBe(true)
    expect(s2.events.resumed).toBe(0)
  })

  it('P3: first run flagged, turnOn without a review, an off empty file written while closed: flagged, never resumed', async () => {
    const p = place()
    writeSetting(p.dir, setting(4320, [device(newSecret(), A)]))
    const s1 = open(p)
    s1.c.start()
    await s1.c.tick()
    expect((await s1.c.state()).flag).toBe(true)
    expect((await s1.c.turnOn()).ok).toBe(true)
    // never "no digest" together with wanted true
    expect(keptOnDisk(p)).toMatchObject({ digest: PENDING, wanted: true })
    s1.c.stop()
    edit(p.file, (doc) => { doc.enabled = false; doc.devices = []; doc.note = 'written by someone else' })
    const s2 = open(p)
    s2.c.start()
    for (let i = 0; i < 30; i += 1) await after(p, s2, 5_000)
    expect(s2.events.outside).toBe(1)
    expect(s2.events.resumed).toBe(0)
    expect(fileJson(p.file).enabled).toBe(false)
  })

  it('a review clears what is pending: the kept digest is real again, and the next start is quiet', async () => {
    const p = place()
    await seeded(p)
    appendDevice(p.file, B)
    const s = open(p)
    s.c.start()
    await s.c.tick()
    expect(keptOnDisk(p).digest).toBe(PENDING)
    expect(await s.c.acknowledge((await s.c.state()).flagDigest)).toEqual({ ok: true })
    expect(keptOnDisk(p).digest).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('review round 1: a flag stays reviewable after main writes', () => {
  it('P1: flagged at start, the watch stops it, then the flag can be acknowledged', async () => {
    const p = place()
    await seeded(p)
    appendDevice(p.file, B)
    p.ts.self = starting()
    const s = open(p)
    s.c.start()
    await s.c.tick()
    const flagged = await s.c.state()
    expect(flagged.flag).toBe(true)
    expect(fileJson(p.file).enabled).toBe(false)
    expect(await s.c.acknowledge(flagged.flagDigest)).toEqual({ ok: true })
    expect((await s.c.state()).flag).toBe(false)
  })

  it('P16: a pairing seen across a viewer restart is flagged; the owner removes the device; the flag can be acknowledged', async () => {
    const p = place()
    await seeded(p)
    const s = open(p)
    s.c.start()
    await s.c.tick()
    s.viewer.codes.push(CODE_ID)
    expect((await s.c.requestCode()).ok).toBe(true)
    appendDevice(p.file, B)
    s.viewer.status = statusBody([])
    await after(p, s, 5_000)
    expect((await s.c.state()).flag).toBe(true)
    expect((await s.c.removeDevice(B)).ok).toBe(true)
    expect(await s.c.acknowledge((await s.c.state()).flagDigest)).toEqual({ ok: true })
    expect((await s.c.state()).flag).toBe(false)
  })

  it('without a state store too', async () => {
    const p = place()
    writeSetting(p.dir, setting(4320, [device(newSecret(), A)]))
    const s = open(p, { store: null })
    s.c.start()
    await s.c.tick()
    appendDevice(p.file, B)
    await after(p, s, 5_000)
    expect((await s.c.removeDevice(B)).ok).toBe(true)
    expect(await s.c.acknowledge((await s.c.state()).flagDigest)).toEqual({ ok: true })
  })
})

describe('review round 1: an identity stop needs the owner, across restarts too', () => {
  it.each([
    ['P6: another host', () => selfStatus({}, { DNSName: `${OTHER_HOST}.` })],
    ['P6b: a tagged node', () => taggedStatus()],
  ] as Array<[string, () => unknown]>)('%s, then a restart with the identity back: not resumed', async (_name, self) => {
    const p = place()
    await seeded(p)
    p.ts.self = self()
    const s = open(p)
    s.c.start()
    await s.c.tick()
    expect(s.events.stopped[0]).toMatchObject({ off: true, willResume: false })
    expect(await s.c.state()).toMatchObject({ needsOwner: 'identity_changed', wanted: false, resume: null })
    await s.c.settled()
    s.c.stop()
    p.ts.self = selfStatus()
    const s2 = open(p)
    s2.c.start()
    for (let i = 0; i < 30; i += 1) await after(p, s2, 5_000)
    expect(s2.events.resumed).toBe(0)
    expect(fileJson(p.file).enabled).toBe(false)
    expect((await s2.c.state()).wanted).toBe(false)
  })

  it('an identity change seen by the resume, then a restart with it back: not resumed', async () => {
    const p = place()
    const s = await paused(p)
    p.ts.self = selfStatus({}, { DNSName: `${OTHER_HOST}.` })
    await after(p, s, 5_000)
    await s.c.settled()
    s.c.stop()
    p.ts.self = selfStatus()
    const s2 = open(p)
    s2.c.start()
    for (let i = 0; i < 30; i += 1) await after(p, s2, 5_000)
    expect(s2.events.resumed).toBe(0)
  })

  it('turnOff clears needsOwner', async () => {
    const p = place()
    await seeded(p)
    p.ts.self = selfStatus({}, { DNSName: `${OTHER_HOST}.` })
    const s = open(p)
    s.c.start()
    await s.c.tick()
    expect((await s.c.state()).needsOwner).toBe('identity_changed')
    expect((await s.c.turnOff()).ok).toBe(true)
    expect((await s.c.state()).needsOwner).toBe(null)
  })
})

describe('review round 1: the state names its remote.json and viewer (two builds share userData)', () => {
  /** The state on disk, rewritten as if kept for something else. */
  function restamp(p: Place, change: Record<string, unknown>) {
    writeFileSync(p.stateFile, JSON.stringify({ ...fileJson(p.stateFile), ...change }), { mode: 0o600 })
  }

  it.each([
    ['another remote.json', { file: createHash('sha256').update('/elsewhere/remote.json').digest('hex') }],
    ['another viewer port', { viewerPort: 4392 }],
  ] as Array<[string, Record<string, unknown>]>)('a state kept for %s reads as none: flagged, not wanted', async (_name, change) => {
    const p = place()
    await seeded(p)
    restamp(p, change)
    const s = open(p)
    s.c.start()
    await s.c.tick()
    expect(s.events.outside).toBe(1)
    expect((await s.c.state()).wanted).toBe(false)
  })

  it('the state names this remote.json and viewer', async () => {
    const p = place()
    await seeded(p)
    expect(keptOnDisk(p)).toMatchObject({ file: fileIdOf(p), viewerPort: 4319 })
  })

  it('P9: the packaged app switched off; the checkout build writes the file; the packaged app restarts: flagged, not resumed', async () => {
    const p = place()
    await seeded(p, { devices: [device(newSecret(), A), device(newSecret(), B)] })
    const pk = open(p)
    expect((await pk.c.turnOff()).ok).toBe(true)
    await pk.c.settled()
    pk.c.stop()
    // as if the checkout build had saved wanted true earlier
    restamp(p, { wanted: true, viewerPort: 4392 })
    const co = open(p, { isPackaged: false })
    await co.c.tick()
    expect((await co.c.removeDevice(B)).ok).toBe(true)
    await co.c.settled()
    const pk2 = open(p)
    pk2.c.start()
    for (let i = 0; i < 30; i += 1) await after(p, pk2, 5_000)
    expect(pk2.events.resumed).toBe(0)
    expect(fileJson(p.file).enabled).toBe(false)
  })

  it('a stale copy never switches the owner\'s off back to on: wanted is not raised but by turnOn', async () => {
    const p = place()
    await seeded(p)
    // two controllers for the same file and viewer: the second switches off
    const x = open(p)
    await x.c.tick()
    expect((await x.c.state()).wanted).toBe(true)
    const y = open(p)
    expect((await y.c.turnOff()).ok).toBe(true)
    await y.c.settled()
    expect(keptOnDisk(p).wanted).toBe(false)
    // x still holds wanted true in memory; its next save may not raise it
    expect((await x.c.removeDevice(A)).ok).toBe(true)
    expect(keptOnDisk(p).wanted).toBe(false)
    expect((await x.c.state()).wanted).toBe(false)
    // x's own turnOn does
    expect((await x.c.turnOn()).ok).toBe(true)
    expect(keptOnDisk(p).wanted).toBe(true)
  })

  it('the resume checks the file is this viewer\'s: a kept state that matches another viewer\'s off file never resumes it', async () => {
    const p = place()
    await seeded(p)
    // the packaged app's watch paused it: off, for viewer 4319
    p.ts.self = starting()
    const pk = open(p)
    pk.c.start()
    await pk.c.tick()
    pk.c.stop()
    const digest = (await pk.c.review()).digest
    // a second packaged instance with another viewer port, whose kept state names this very file state
    const { store } = memoryStore({ digest, wanted: true, file: fileIdOf(p), viewerPort: 4329 })
    p.ts.self = selfStatus()
    const other = open(p, { store, viewerPort: 4329 })
    other.c.start()
    for (let i = 0; i < 30; i += 1) await after(p, other, 5_000)
    expect(other.events.outside).toBe(0)
    expect(other.events.resumed).toBe(0)
    expect(fileJson(p.file)).toMatchObject({ enabled: false, viewerPort: 4319 })
    expect(await waitingOf(other)).toBe('needs_owner')
  })
})

describe('review round 1: races with stop() and the owner\'s turnOff', () => {
  it('P4: stop() while a resume is in flight: nothing written', async () => {
    const p = place()
    let gate: (() => Promise<void>) | null = null
    const s = await paused(p, { serveGate: async () => { const g = gate; gate = null; await g?.() } })
    p.ts.self = selfStatus()
    gate = async () => { s.c.stop() }
    await after(p, s, 5_000)
    expect(fileJson(p.file).enabled).toBe(false)
    expect(s.events.resumed).toBe(0)
  })

  it('P5: turnOff called while the resume holds the lock: off at the end, onResumed never called', async () => {
    const p = place()
    let armed = false
    let off: Promise<unknown> | null = null
    let opens = 0
    let s: ReturnType<typeof open> | null = null
    s = await paused(p, {
      beforeOpen: () => {
        if (!armed) return
        opens += 1
        // the fourth read of the tick: the resume's read under the lock
        if (opens === 4 && off === null) off = s!.c.turnOff()
      },
    })
    p.ts.self = selfStatus()
    armed = true
    await after(p, s, 5_000)
    await off
    expect(off).not.toBe(null)
    expect(fileJson(p.file).enabled).toBe(false)
    expect(s.events.resumed).toBe(0)
    expect((await s.c.state()).wanted).toBe(false)
  })

  it('P5b: turnOff called right after the resume wrote the file: onResumed never called', async () => {
    const p = place()
    let armed = false
    let off: Promise<unknown> | null = null
    let s: ReturnType<typeof open> | null = null
    s = await paused(p, {
      fs: {
        rename: async (from: string, to: string) => {
          await fsPromises.rename(from, to)
          if (armed && to === p.file && off === null) {
            armed = false
            off = s!.c.turnOff()
          }
        },
      } as never,
    })
    p.ts.self = selfStatus()
    armed = true
    await after(p, s, 5_000)
    await off
    expect(off).not.toBe(null)
    expect(s.events.resumed).toBe(0)
    expect(fileJson(p.file).enabled).toBe(false)
  })

  it('P11: after stop(), state() reports no wait, and refresh() resumes nothing', async () => {
    const p = place()
    const s = await paused(p)
    expect(await waitingOf(s)).toBe('tailscale_not_running')
    s.c.stop()
    expect(await waitingOf(s)).toBe(null)
    p.ts.self = selfStatus()
    await s.c.refresh()
    expect(fileJson(p.file).enabled).toBe(false)
    expect(await waitingOf(s)).toBe(null)
  })
})

describe('review round 1: flapping backs off', () => {
  /** Serve answers as `serve` says (n counts Serve's reads), for two simulated hours: the resume times, in minutes since the start. */
  async function flap(serve: (n: number, at: number) => unknown) {
    const p = place()
    let n = 0
    let t0 = 0
    const s = await paused(p, {
      onBeforeServe: () => {
        n += 1
        if (t0 > 0) p.ts.serve = serve(n, p.clock.now - t0)
      },
    })
    p.ts.self = selfStatus()
    t0 = p.clock.now
    const resumes: number[] = []
    while (p.clock.now < t0 + 2 * 3_600_000) {
      const before = s.events.resumed
      await after(p, s, 5_000)
      if (s.events.resumed > before) resumes.push((p.clock.now - t0) / 60_000)
    }
    return { p, s, resumes }
  }
  const gaps = (times: number[]) => times.slice(1).map((t, i) => t - times[i]!)

  it('P7: Serve good and bad at alternate reads: the waits double to 30 minutes, and it keeps trying', async () => {
    const { s, resumes } = await flap((n) => (n % 2 ? goodServe(4320) : {}))
    expect(resumes.length).toBeGreaterThanOrEqual(6)
    expect(resumes.length).toBeLessThanOrEqual(10)
    expect(s.events.stopped.length - 1).toBe(resumes.length)
    const g = gaps(resumes)
    for (let i = 1; i < g.length; i += 1) expect(g[i]!).toBeGreaterThanOrEqual(Math.min(g[i - 1]!, 30))
    expect(Math.max(...g)).toBeLessThanOrEqual(31.5)
    expect(g.at(-1)!).toBeGreaterThanOrEqual(30)
    const state = await s.c.state()
    expect(state.resume?.nextAt).toBeGreaterThan(START)
  })

  it('P7b: Serve good for 62 seconds, bad for 8: a few resumes an hour, not fifty', async () => {
    const { resumes } = await flap((_n, at) => (at % 70_000 < 62_000 ? goodServe(4320) : {}))
    expect(resumes.length).toBeLessThanOrEqual(10)
    expect(resumes.length).toBeGreaterThanOrEqual(1)
  })

  it('the waits: 60 seconds, then 2, 4, 8, 16 and 30 minutes at most; state().resume.nextAt says when', async () => {
    const p = place()
    const s = await paused(p)
    p.ts.self = selfStatus()
    const waits: number[] = []
    for (let k = 0; k < 7; k += 1) {
      // resume, then a stop at the next check
      while (s.events.resumed === k) await after(p, s, 5_000)
      p.ts.serve = {}
      await after(p, s, 5_000)
      const stoppedAt = p.clock.now
      const nextAt = (await s.c.state()).resume?.nextAt ?? 0
      waits.push((nextAt - stoppedAt) / 1000)
      p.ts.serve = goodServe(4320)
    }
    expect(waits).toEqual([60, 120, 240, 480, 960, 1800, 1800])
  })

  it('after the entry stayed on for 10 minutes, the wait is back to 5 seconds', async () => {
    const p = place()
    const s = await paused(p)
    p.ts.self = selfStatus()
    for (let k = 0; k < 3; k += 1) {
      while (s.events.resumed === k) await after(p, s, 5_000)
      p.ts.serve = {}
      await after(p, s, 5_000)
      p.ts.serve = goodServe(4320)
    }
    while (s.events.resumed === 3) await after(p, s, 5_000)
    for (let i = 0; i < 10; i += 1) await after(p, s, 60_000)
    p.ts.serve = {}
    await after(p, s, 60_000)
    const stoppedAt = p.clock.now
    expect((await s.c.state()).resume?.nextAt).toBe(stoppedAt + 5_000)
  })
})

describe('review round 1: flapping, the edges', () => {
  it('a stop 9 minutes after a resume still backs off; after the wait, a failed try is retried a minute later', async () => {
    const p = place()
    const s = await paused(p)
    p.ts.self = selfStatus()
    await after(p, s, 5_000)
    expect(s.events.resumed).toBe(1)
    const resumedAt = p.clock.now
    while (p.clock.now < resumedAt + 9 * 60_000) await after(p, s, 60_000)
    p.ts.serve = {}
    await s.c.refresh()
    expect(s.events.stopped).toHaveLength(2)
    const stoppedAt = p.clock.now
    expect((await s.c.state()).resume?.nextAt).toBe(stoppedAt + 60_000)
    // the try at the end of the wait fails: the next is a minute later, not 5 seconds
    p.clock.now = stoppedAt + 60_000
    await s.c.tick()
    expect((await s.c.state()).resume?.nextAt).toBe(stoppedAt + 120_000)
  })
})

/** The real store for `p`, whose first read waits until `release()`. */
function heldStore(p: Place) {
  const real = createRemoteEntryState({ filePath: p.stateFile })
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  let first = true
  const store: RemoteEntryStateStore = {
    read: async () => {
      if (first) {
        first = false
        await gate
      }
      return real.read()
    },
    write: (state, how) => real.write(state, how),
  }
  return { store, release }
}

describe('review round 1: an owner\'s turnOff before the kept state is read', () => {
  it('a change made while closed is still flagged once the state is read', async () => {
    const p = place()
    await seeded(p)
    appendDevice(p.file, B)
    const { store, release } = heldStore(p)
    const s = open(p, { store })
    expect((await s.c.turnOff()).ok).toBe(true)
    expect(fileJson(p.file).enabled).toBe(false)
    expect(s.events.outside).toBe(0)
    release()
    await s.c.settled()
    expect(s.events.outside).toBe(1)
    expect((await s.c.state()).flag).toBe(true)
    // and Review accepts the file as main's switch-off left it
    expect(await s.c.acknowledge((await s.c.state()).flagDigest)).toEqual({ ok: true })
  })

  it('an unchanged file: quiet, and the switch-off is kept for the next start', async () => {
    const p = place()
    await seeded(p)
    const { store, release } = heldStore(p)
    const s = open(p, { store })
    expect((await s.c.turnOff()).ok).toBe(true)
    release()
    await s.c.settled()
    expect(s.events.outside).toBe(0)
    const next = open(p)
    next.c.start()
    await next.c.tick()
    expect(next.events.outside).toBe(0)
    expect((await next.c.state()).wanted).toBe(false)
  })
})

describe('review round 1: the state says a review is due before main writes', () => {
  it('a write: pending first, then the real digest', async () => {
    const p = place()
    const { m, store } = memoryStore()
    const s = open(p, { store })
    s.c.start()
    await s.c.tick()
    m.writes.length = 0
    expect((await s.c.turnOn()).ok).toBe(true)
    expect(m.writes[0]).toMatchObject({ digest: PENDING, wanted: true })
    expect(m.writes.at(-1)).toMatchObject({ digest: expect.stringMatching(/^[0-9a-f]{64}$/), wanted: true })
    m.writes.length = 0
    expect((await s.c.removeDevice('0000000000000000')).ok).toBe(true)
    expect(m.writes[0]!.digest).toBe(PENDING)
    expect(m.writes.at(-1)!.digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('P15: the save after a turnOff failed, the old on file put back while closed: flagged at the next start', async () => {
    const p = place()
    const { m, store } = memoryStore()
    const s0 = open(p, { store })
    s0.c.start()
    await s0.c.tick()
    expect((await s0.c.turnOn()).ok).toBe(true)
    const onCopy = readFileSync(p.file, 'utf8')
    // the pending save lands; every later one fails
    const write = store.write
    let calls = 0
    store.write = async (state, how) => {
      calls += 1
      if (calls > 1) throw new Error('write broke')
      return write(state, how)
    }
    expect((await s0.c.turnOff()).ok).toBe(true)
    await s0.c.settled()
    expect((await s0.c.state()).stateSaved).toBe(false)
    expect(m.value?.digest).toBe(PENDING)
    s0.c.stop()
    store.write = write
    writeFileSync(p.file, onCopy, { mode: 0o600 })
    const s1 = open(p, { store })
    s1.c.start()
    await s1.c.tick()
    expect(s1.events.outside).toBe(1)
  })

  it('stateSaved: null with no store, false when the first read failed, true once a write lands', async () => {
    const p = place()
    expect((await open(p, { store: null }).c.state()).stateSaved).toBe(null)
    const broken = open(p, { store: { read: async () => { throw new Error('read broke') }, write: async () => { throw new Error('write broke') } } })
    expect((await broken.c.state()).stateSaved).toBe(false)
    // a read that worked, before any write
    expect((await open(p, { store: memoryStore().store }).c.state()).stateSaved).toBe(true)
    const { m, store } = memoryStore()
    m.readFails = true
    const s = open(p, { store })
    expect((await s.c.state()).stateSaved).toBe(false)
    s.c.start()
    // the quiet baseline is saved at the first look
    await s.c.tick()
    expect((await s.c.state()).stateSaved).toBe(true)
  })
})

describe('review round 1: a state store that never answers', () => {
  it('P13: the owner\'s turnOff and the watch\'s stop write the file without waiting; the watch waits at most 5 seconds', async () => {
    const p = place()
    writeSetting(p.dir, setting(4320, [device(newSecret(), A)]))
    const timers = heldTimers()
    const store = { read: () => new Promise<never>(() => {}), write: () => new Promise<never>(() => {}) }
    const s = open(p, { store: store as never, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout })
    p.ts.serve = {}
    // the owner's switch: lands at once
    const off = await Promise.race([s.c.turnOff().then(() => 'settled'), new Promise((r) => setTimeout(() => r('hung'), 1_000))])
    expect(off).toBe('settled')
    expect(fileJson(p.file).enabled).toBe(false)
    // the watch: stops an entry switched on by hand, then gives up on the store after 5 seconds
    edit(p.file, (doc) => { doc.enabled = true })
    let done = false
    const ticking = s.c.tick().then(() => { done = true })
    await waitUntil(() => timers.held.length > 0, 'the state read to be waited on')
    expect(done).toBe(false)
    timers.fire()
    await waitUntil(() => { timers.fire(); return done }, 'the tick to end')
    await ticking
    expect(fileJson(p.file).enabled).toBe(false)
    expect((await Promise.race([s.c.state(), new Promise((r) => setTimeout(() => r('hung'), 1_000))]))).not.toBe('hung')
  })

  it('P14: a FIFO at the state path: turnOff lands at once, and the state reads as none', async () => {
    const p = place()
    writeSetting(p.dir, setting(4320, [device(newSecret(), A)]))
    mkdirSync(join(p.dir, 'userData'), { recursive: true })
    execFileSync('/usr/bin/mkfifo', [p.stateFile])
    const s = open(p)
    const off = await Promise.race([s.c.turnOff().then(() => 'settled'), new Promise((r) => setTimeout(() => r('hung'), 2_000))])
    expect(off).toBe('settled')
    expect(fileJson(p.file).enabled).toBe(false)
    await s.c.settled()
    expect(lstatSync(p.stateFile).isFile()).toBe(true)
  })
})

describe('review round 1: what a resume compares', () => {
  it.each([
    ['a relabel that stays readable', (doc: Record<string, unknown>) => { (doc.devices as Array<Record<string, unknown>>)[0]!.label = 'renamed' }, true],
    ['pairedAt', (doc: Record<string, unknown>) => { (doc.devices as Array<Record<string, unknown>>)[0]!.pairedAt = '2020-01-01T00:00:00Z' }, true],
    ['an unknown field in a device', (doc: Record<string, unknown>) => { (doc.devices as Array<Record<string, unknown>>)[0]!.extra = 'x' }, true],
    ['the host in capitals', (doc: Record<string, unknown>) => { doc.host = String(doc.host).toUpperCase() }, false],
    ['the login in capitals', (doc: Record<string, unknown>) => { doc.logins = [String((doc.logins as string[])[0]).toUpperCase()] }, false],
  ] as Array<[string, (doc: Record<string, unknown>) => void, boolean]>)('P8: %s while paused', async (_name, change, resumes) => {
    const p = place()
    const s = await paused(p)
    edit(p.file, change)
    p.ts.self = selfStatus()
    await after(p, s, 5_000)
    await after(p, s, 5_000)
    expect(s.events.resumed).toBe(resumes ? 1 : 0)
    expect(s.events.outside).toBe(resumes ? 0 : 1)
    expect(fileJson(p.file).enabled).toBe(resumes)
  })
})

describe('review round 1: review() shows the state Review accepts', () => {
  it('P10: one read gives the view and its digest; a file changed after it is not accepted', async () => {
    const p = place()
    await seeded(p)
    const s = open(p)
    s.c.start()
    await s.c.tick()
    appendDevice(p.file, B)
    await after(p, s, 5_000)
    const flagged = readFileSync(p.file, 'utf8')
    // the file changes as the panel reads it
    edit(p.file, (doc) => { (doc.devices as unknown[]).pop() })
    const shown = await s.c.review()
    expect(shown.flag).toBe(true)
    expect(shown.view.devices.map((d) => d.id)).toEqual([A])
    writeFileSync(p.file, flagged, { mode: 0o600 })
    // what was shown is not what is there: refused
    expect(await s.c.acknowledge(shown.digest)).toEqual({ ok: false, reason: 'changed' })
    const again = await s.c.review()
    expect(again.view.devices.map((d) => d.id)).toEqual([A, B])
    expect(await s.c.acknowledge(again.digest)).toEqual({ ok: true })
  })
})

describe('review round 1: state().resume', () => {
  it('a stop with willResume false reports no Tailscale wait', async () => {
    const p = place()
    await seeded(p)
    appendDevice(p.file, B)
    p.ts.self = starting()
    const s = open(p)
    s.c.start()
    await s.c.tick()
    expect(s.events.stopped[0]).toMatchObject({ willResume: false })
    expect(await waitingOf(s)).toBe('flagged')
  })
})

// ── review round 2: off means off ──────────────────────────────────────────

/** Seeded and on, then the owner switches it off: `wanted: false` kept for this file and viewer. The on file, as it was. */
async function switchedOff(p: Place) {
  await seeded(p)
  const onFile = readFileSync(p.file, 'utf8')
  const s = open(p)
  expect((await s.c.turnOff()).ok).toBe(true)
  await s.c.settled()
  s.c.stop()
  expect(keptOnDisk(p)).toMatchObject({ wanted: false, file: fileIdOf(p), viewerPort: 4319 })
  return onFile
}
const notWanted = (s: ReturnType<typeof open>) => s.events.stopped.filter((e) => e.reason === 'not_wanted')

describe('review round 2: the owner\'s Off is kept when the file says on', () => {
  it('the old on file put back while closed: switched off at start, before any Tailscale command, devices kept, flagged', async () => {
    const p = place()
    const onFile = await switchedOff(p)
    writeFileSync(p.file, onFile, { mode: 0o600 })
    // Tailscale cannot be read at all: the switch-off needs none of it
    p.ts.cli = false
    const s = open(p)
    s.c.start()
    await s.c.tick()
    expect(fileJson(p.file).enabled).toBe(false)
    expect(deviceIds(p.file)).toEqual([A])
    expect(s.tailscale.calls).toEqual([])
    expect(notWanted(s)).toEqual([{ reason: 'not_wanted', off: true, willResume: false }])
    const state = await s.c.state()
    expect(state.flag).toBe(true)
    expect(state.stopped).toMatchObject({ reason: 'not_wanted', off: true, willResume: false })
    expect(state.wanted).toBe(false)
    expect(s.events.outside).toBe(1)
    for (let i = 0; i < 5; i += 1) await after(p, s, 5_000)
    expect(notWanted(s)).toHaveLength(1)
    expect(s.events.resumed).toBe(0)
    // Review accepts the file as main left it
    expect(await s.c.acknowledge((await s.c.review()).digest)).toEqual({ ok: true })
  })

  it('the switch-off writes enabled: false and nothing else', async () => {
    const p = place()
    const onFile = await switchedOff(p)
    const doc = JSON.parse(onFile) as Record<string, unknown>
    const planted = { ...doc, note: { kept: true }, devices: [...(doc.devices as unknown[]), { id: 'short', label: 'x', secretSha256: 'y' }] }
    writeFileSync(p.file, JSON.stringify(planted), { mode: 0o600 })
    const s = open(p)
    s.c.start()
    await s.c.tick()
    expect(fileJson(p.file)).toEqual({ ...planted, enabled: false })
  })

  it('while running: enabled flipped on by hand after the owner\'s Off is off again at the next file check', async () => {
    const p = place()
    await seeded(p)
    const s = open(p)
    s.c.start()
    await s.c.tick()
    expect((await s.c.turnOff()).ok).toBe(true)
    edit(p.file, (doc) => { doc.enabled = true })
    p.ts.cli = false
    await after(p, s, 5_000)
    expect(fileJson(p.file).enabled).toBe(false)
    expect(notWanted(s)).toHaveLength(1)
    expect(s.events.outside).toBe(1)
    await after(p, s, 5_000)
    expect(notWanted(s)).toHaveLength(1)
    // a second occurrence is announced again
    edit(p.file, (doc) => { doc.enabled = true })
    await after(p, s, 5_000)
    expect(fileJson(p.file).enabled).toBe(false)
    expect(notWanted(s)).toHaveLength(2)
  })

  it('a switch-off that does not land is retried at every tick, announced once', async () => {
    const p = place()
    const onFile = await switchedOff(p)
    writeFileSync(p.file, onFile, { mode: 0o600 })
    chmodSync(p.dir, 0o500)
    const s = open(p)
    try {
      s.c.start()
      await s.c.tick()
      expect(fileJson(p.file).enabled).toBe(true)
      expect(notWanted(s)).toEqual([{ reason: 'not_wanted', off: false, willResume: false }])
      await after(p, s, 5_000)
      expect(fileJson(p.file).enabled).toBe(true)
    } finally {
      chmodSync(p.dir, 0o700)
    }
    await after(p, s, 5_000)
    expect(fileJson(p.file).enabled).toBe(false)
    expect(notWanted(s)).toHaveLength(1)
    expect((await s.c.state()).stopped).toMatchObject({ reason: 'not_wanted', off: true })
  })

  /** The owner's Off kept, the on file put back, then `spoil` before the next start: flag only, left on. */
  async function flagOnly(spoil: (p: Place) => Parameters<typeof open>[1] | void) {
    const p = place()
    const onFile = await switchedOff(p)
    writeFileSync(p.file, onFile, { mode: 0o600 })
    const opts = spoil(p) ?? {}
    const s = open(p, opts)
    s.c.start()
    await s.c.tick()
    return { p, s }
  }

  it.each([
    ['no state stored', (p: Place) => { unlinkSync(p.stateFile) }],
    ['a state for another viewer port', (p: Place) => { writeFileSync(p.stateFile, JSON.stringify({ ...fileJson(p.stateFile), viewerPort: 4392 }), { mode: 0o600 }) }],
    ['a state for another file', (p: Place) => { writeFileSync(p.stateFile, JSON.stringify({ ...fileJson(p.stateFile), file: 'e'.repeat(64) }), { mode: 0o600 }) }],
    ['a store whose read throws', () => ({ store: { read: async () => { throw new Error('read broke') }, write: async () => {} } })],
    ['no state store', () => ({ store: null })],
  ] as Array<[string, (p: Place) => Parameters<typeof open>[1] | void]>)('not enforced with %s: flagged only, left on', async (_name, spoil) => {
    const { p, s } = await flagOnly(spoil)
    expect(fileJson(p.file).enabled).toBe(true)
    expect(notWanted(s)).toEqual([])
    expect(s.events.outside).toBe(_name === 'no state store' ? 0 : 1)
  })

  it('not enforced with a store whose read never answers: flagged only, left on', async () => {
    const p = place()
    const onFile = await switchedOff(p)
    writeFileSync(p.file, onFile, { mode: 0o600 })
    const timers = heldTimers()
    const store = { read: () => new Promise<never>(() => {}), write: async () => {} }
    const s = open(p, { store: store as never, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout })
    s.c.start()
    let done = false
    const ticking = s.c.tick().then(() => { done = true })
    await waitUntil(() => { timers.fire(); return done }, 'the tick to end')
    await ticking
    expect(fileJson(p.file).enabled).toBe(true)
    expect(notWanted(s)).toEqual([])
    expect(s.events.outside).toBe(1)
  })

  it('not enforced while wanted is true (paused): a hand edit to on is flagged and left to the Serve check', async () => {
    const p = place()
    const s = await paused(p)
    edit(p.file, (doc) => { doc.enabled = true })
    p.ts.self = selfStatus()
    await after(p, s, 60_000)
    expect(s.events.outside).toBe(1)
    expect(notWanted(s)).toEqual([])
    expect(fileJson(p.file).enabled).toBe(true)
  })

  it('a file on for another viewer is left alone', async () => {
    const p = place()
    const onFile = await switchedOff(p)
    writeFileSync(p.file, JSON.stringify({ ...JSON.parse(onFile), viewerPort: 4392 }), { mode: 0o600 })
    const s = open(p)
    s.c.start()
    await s.c.tick()
    expect(fileJson(p.file).enabled).toBe(true)
    expect(notWanted(s)).toEqual([])
  })
})

describe('the state file is the userData one, never remote.json\'s folder', () => {
  it('createRemoteEntryState with app names userData/remote-entry-state.json', async () => {
    const dir = scratchDir('remote-restart-')
    mkdirSync(join(dir, 'ud'))
    const store = createRemoteEntryState({ app: { getPath: (name: string) => (name === 'userData' ? join(dir, 'ud') : '') } })
    await store.write({ digest: null, wanted: false, file: 'f'.repeat(64), viewerPort: 4319 })
    expect(existsSync(join(dir, 'ud', 'remote-entry-state.json'))).toBe(true)
  })
})
