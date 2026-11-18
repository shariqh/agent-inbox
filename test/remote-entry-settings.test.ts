// The hub's remote-entry controller (#617, PR 2c; design
// docs/superpowers/specs/2026-11-17-remote-inbox-design.md §3.2 "Writers", "Changes made behind
// the app's back", "The hub's Settings"): electron/remote-entry.cjs owns remote.json for the
// desktop app's main, reads Tailscale, asks the app's own viewer for pairing codes and status, and
// watches the file and Serve. Every store operation runs against a real scratch folder. Tailscale
// and the viewer's routes are stubbed (the one exception: the shared-lock test runs the viewer's
// real pairing write). No test runs the real `tailscale`.
//
// Values are synthetic: `hub.example.ts.net`, `owner@example.com`, `laptop`. The `tailscale status
// --json` fields are as observed on a real machine (Tailscale 1.102); see
// test/remote-entry-fixtures.ts for which shapes come from documentation only.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import remoteEntry from '../electron/remote-entry.cjs'
import { openDb } from '../src/store.js'
import { createViewer } from '../src/viewer.js'
import { startLocalViewer } from '../src/viewer-network.js'
import { readRemoteSetting, remoteDir, startRemoteEntry } from '../src/viewer-remote.js'
import type { RemoteEntry } from '../src/viewer-remote.js'
import { remoteCodeRoute } from '../src/remote-pair.js'
import { removeScratchDirs, scratchDir } from './scratch.js'
import { waitUntil } from './wait.js'
import { device, freePort, newSecret, rawRequest, setting, writeSetting } from './remote-fixtures.js'
import { ALLOWED_ARGS, HOST, LOGIN, USER_ID, cliExists, fakeTailscale, goodServe, selfStatus, taggedStatus, tailscaleCalls } from './remote-entry-fixtures.js'

const { REMOVAL_HINT, createRemoteEntry, parseTailnetSelf, remoteFile } = remoteEntry

const START = Date.parse('2026-11-20T09:00:00.000Z')
const TOKEN = 'owner-token-for-the-test-0123456789'
const CODE = '7K3QX-9M2PD'
const CODE_ID = 'c0de0000000000a1'
const A = 'aaaaaaaaaaaaaaaa'
const B = 'bbbbbbbbbbbbbbbb'
const C = 'cccccccccccccccc'
const OTHER_HOST = 'other.example.ts.net'
const OTHER_LOGIN = 'second@example.com'

afterEach(() => removeScratchDirs())

// Every Tailscale call in this file used one of the two allowed lists, and none ran while
// remote.json's lock was held (a pairing write waits at most about 5 seconds for it).
const lockViolations: string[] = []
afterAll(() => {
  expect(tailscaleCalls.length).toBeGreaterThan(20)
  for (const call of tailscaleCalls) expect(ALLOWED_ARGS, call.args.join(' ')).toContainEqual(call.args)
  expect(lockViolations).toEqual([])
})

function statusBody(paired: Array<{ device: string; codeId: string }> = []) {
  return {
    on: true, listening: true, port: 4320, host: HOST, error: null, codePending: false, paired,
    refused: { host: 0, funnel: 0, login: 0, path: 0, origin: 0, device: 0, route: 0, pair: 0 },
  }
}

const codeAnswer = (codeId = CODE_ID) => () => Response.json({ code: CODE, expiresAt: new Date(START + 600_000).toISOString(), codeId })

/** The app's own viewer, stubbed: the code and status routes on 127.0.0.1:4319, and the hub's Serve address. */
function viewerStub(viewerPort = 4319) {
  const v = {
    status: statusBody() as unknown,
    codes: [] as Array<() => Response>,
    version: (() => new Response('Forbidden', { status: 403 })) as () => Response,
    calls: [] as Array<{ url: string; init: Record<string, unknown> }>,
  }
  const fetch = async (url: string, init: Record<string, unknown>): Promise<Response> => {
    v.calls.push({ url, init })
    if (url === `http://127.0.0.1:${viewerPort}/api/remote-entry/code`) return (v.codes.shift() ?? (() => new Response('', { status: 500 })))()
    if (url === `http://127.0.0.1:${viewerPort}/api/remote-entry`) return Response.json(v.status)
    if (url === `https://${HOST}/api/version`) return v.version()
    throw new TypeError('fetch failed')
  }
  return { v, fetch }
}

function hub(opts: {
  self?: unknown; serve?: unknown; isPackaged?: boolean; env?: Record<string, string>; uid?: number; ownerToken?: string | undefined
} = {}) {
  const dir = scratchDir('remote-entry-')
  const file = join(dir, 'remote.json')
  const clock = { now: START }
  const events = { stopped: [] as string[], paired: [] as string[], outside: 0 }
  const tailscale = fakeTailscale({ self: opts.self ?? selfStatus(), serve: opts.serve ?? goodServe(4320) })
  const execFile: typeof tailscale = Object.assign((file_: string, args: readonly string[], options: Record<string, unknown>, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    if (existsSync(`${file}.lock`)) lockViolations.push(args.join(' '))
    tailscale(file_, args, options, callback)
  }, { calls: tailscale.calls })
  const { v, fetch } = viewerStub()
  const c = createRemoteEntry({
    isPackaged: opts.isPackaged ?? true,
    env: { AGENT_INBOX_DB: join(dir, 'inbox.db'), ...opts.env },
    ...(opts.uid !== undefined ? { uid: opts.uid } : {}),
    ...('ownerToken' in opts ? (opts.ownerToken === undefined ? {} : { ownerToken: opts.ownerToken }) : { ownerToken: TOKEN }),
    execFile,
    exists: cliExists,
    fetch,
    now: () => clock.now,
    sleep: async (ms: number) => { clock.now += ms },
    setInterval: () => 0,
    clearInterval: () => {},
    onStopped: (reason: string) => { events.stopped.push(reason) },
    onPaired: (label: string) => { events.paired.push(label) },
    onOutsideChange: () => { events.outside += 1 },
  })
  return { dir, file, clock, events, tailscale, v, c }
}

const fileJson = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
const strays = (dir: string) => readdirSync(dir).filter((name) => name.endsWith('.tmp') || name.endsWith('.lock'))

// ── where the file is ──────────────────────────────────────────────────────

describe('remoteFile: the same file the viewer reads', () => {
  it('equals remoteDir() in src/viewer-remote.ts over several environments', () => {
    const envs: Array<Record<string, string>> = [
      {},
      { AGENT_INBOX_DB: '/x/hub3/inbox.db' },
      { AGENT_INBOX_DB: 'scratch/inbox.db' },
      { AGENT_INBOX_DB: '/x/hub3/../hub4/inbox.db' },
      { AGENT_INBOX_DB: '' },
      { AGENT_INBOX_MESH_DIR: '/x/hub2' },
      { AGENT_INBOX_DB: '/x/hub3/inbox.db', AGENT_INBOX_MESH_DIR: '/x/hub2' },
    ]
    for (const env of envs) expect(remoteFile(env, '/home/u'), JSON.stringify(env)).toBe(join(remoteDir(env, '/home/u'), 'remote.json'))
    expect(remoteFile({ AGENT_INBOX_MESH_DIR: '/x/hub2' }, '/home/u')).toBe('/home/u/.agent-inbox/remote.json')
  })

  it('is what the controller writes', () => {
    const { c, dir } = hub()
    expect(c.file).toBe(join(dir, 'remote.json'))
  })
})

// ── the reader's rules, mirrored ───────────────────────────────────────────

describe('the controller reads remote.json by the viewer\'s rules', () => {
  // Every file here is read by both readers; the problems match word for word ('-' as '_').
  const files: Array<[string, unknown, number?]> = [
    ['a valid file', setting(4320, [device(newSecret(), A)])],
    ['turned off', setting(4320, [], { enabled: false })],
    ['a newer schema', setting(4320, [], { schema: 2 })],
    ['schema 0', setting(4320, [], { schema: 0 })],
    ['no schema', { host: HOST }],
    ['an array', '[]'],
    ['not JSON', '{"schema":1,'],
    ['not UTF-8', Buffer.from([0x7b, 0xff, 0x7d])],
    ['an address for a host', setting(4320, [], { host: '127.0.0.1' })],
    ['a host in capitals', setting(4320, [], { host: 'HUB.Example.ts.net' })],
    ['no logins', setting(4320, [], { logins: [] })],
    ['17 logins', setting(4320, [], { logins: Array.from({ length: 17 }, (_, i) => `u${i}@example.com`) })],
    ['a login with a control character', setting(4320, [], { logins: ['owner\u0007@example.com'] })],
    ['port equal to viewerPort', setting(4319, [])],
    ['port 80', setting(80, [])],
    ['no viewerPort', { ...setting(4320, []), viewerPort: undefined }],
    ['17 devices', setting(4320, Array.from({ length: 17 }, (_, i) => device(newSecret(), i.toString(16).padStart(16, '0'))))],
    ['a bad device among good ones', setting(4320, [device(newSecret(), A), { id: 'nope', label: 'x', secretSha256: 'y' }, null, 7])],
    ['devices not a list', setting(4320, [], { devices: {} })],
    ['mode 0644', setting(4320, []), 0o644],
    ['mode 0640', setting(4320, []), 0o640],
    ['too large', { ...setting(4320, []), pad: 'x'.repeat(65 * 1024) }],
  ]
  it.each(files)('%s', async (_name, value, mode) => {
    const { c, dir, file } = hub()
    if (Buffer.isBuffer(value)) writeFileSync(file, value, { mode: 0o600 })
    else writeSetting(dir, value, mode ?? 0o600)
    const viewer = readRemoteSetting(file)
    const view = await c.view()
    if (viewer.ok) {
      expect(view.problem).toBe(null)
      expect(view.host).toBe(viewer.setting.host)
      expect(view.logins).toEqual(viewer.setting.logins)
      expect(view.port).toBe(viewer.setting.port)
      expect(view.viewerPort).toBe(viewer.setting.viewerPort)
      expect(view.devices.map((d) => d.id)).toEqual(viewer.setting.devices.map((d) => d.id))
      expect(view.enabled).toBe(viewer.setting.enabled)
    } else {
      expect(view.problem).toBe(viewer.reason.replace(/-/g, '_'))
      expect(view.enabled).toBe(false)
    }
  })

  it('reads a symlink, a folder and a missing file as the viewer does', async () => {
    const { c, dir, file } = hub()
    expect(readRemoteSetting(file)).toEqual({ ok: false, reason: 'missing' })
    expect((await c.view()).problem).toBe(null)
    writeFileSync(join(dir, 'real.json'), JSON.stringify(setting(4320, [])), { mode: 0o600 })
    symlinkSync(join(dir, 'real.json'), file)
    expect(readRemoteSetting(file)).toEqual({ ok: false, reason: 'not-regular' })
    expect(await c.view()).toMatchObject({ available: false, enabled: false, problem: 'not_regular' })
    unlinkSync(file)
    mkdirSync(file)
    expect(readRemoteSetting(file)).toEqual({ ok: false, reason: 'not-regular' })
    expect(await c.view()).toMatchObject({ available: false, problem: 'not_regular' })
  })
})

// ── view() ─────────────────────────────────────────────────────────────────

describe('view(): what the Settings page may be given', () => {
  it('with no file: off, this build\'s ports, nothing listed', async () => {
    const { c } = hub()
    expect(await c.view()).toEqual({
      available: true, enabled: false, host: null, port: 4320, viewerPort: 4319, logins: [], devices: [], unreadableDevices: 0, problem: null,
    })
    expect((await hub({ isPackaged: false }).c.view())).toMatchObject({ port: 4393, viewerPort: 4392 })
  })

  it('lists devices by id, label and pairedAt only: never a secret hash or anything else from the file', async () => {
    const { c, dir } = hub()
    const entries = [{ ...device(newSecret(), A), extra: 'kept' }, device(newSecret(), B, 'laptop')]
    writeSetting(dir, setting(4320, entries, { note: 'x' }))
    const view = await c.view()
    expect(view).toEqual({
      available: true, enabled: true, host: HOST, port: 4320, viewerPort: 4319, logins: [LOGIN], unreadableDevices: 0, problem: null,
      devices: [{ id: A, label: 'laptop', pairedAt: '2026-11-20T09:00:00.000Z' }, { id: B, label: 'laptop', pairedAt: '2026-11-20T09:00:00.000Z' }],
    })
    const text = JSON.stringify(view)
    for (const entry of entries) expect(text).not.toContain(entry.secretSha256)
    expect(text).not.toContain('secretSha256')
    expect(text).not.toContain('kept')
  })

  it('does not list a device whose label holds a Unicode format character, and counts every entry the reader drops', async () => {
    const { c, dir } = hub()
    writeSetting(dir, setting(4320, [
      device(newSecret(), A), device(newSecret(), B, 'lap‮top'), device(newSecret(), C, 'zero‍width'),
      { id: 'short', label: 'x', secretSha256: 'y' }, null, 'text',
    ]))
    const view = await c.view()
    expect(view.devices.map((d) => d.id)).toEqual([A])
    expect(view.unreadableDevices).toBe(5)
  })

  it('reads a file that is on for the other build\'s viewer as off here', async () => {
    const { c, dir } = hub()
    writeSetting(dir, setting(4320, [], { viewerPort: 4392 }))
    expect(await c.view()).toMatchObject({ available: true, enabled: false, problem: 'other_viewer' })
  })

  it('reads a newer schema as not available', async () => {
    const { c, dir } = hub()
    writeSetting(dir, setting(4320, [], { schema: 2 }))
    expect(await c.view()).toMatchObject({ available: false, enabled: false, problem: 'newer_schema' })
  })
})

// ── turnOn() ───────────────────────────────────────────────────────────────

describe('turnOn(): only when this node\'s identity and Serve\'s shape are both ok, checked then', () => {
  it('writes enabled, host, port, viewerPort and this node\'s login, 0600, with no stray file', async () => {
    const { c, dir, file } = hub()
    const result = await c.turnOn()
    expect(result).toMatchObject({ ok: true, devicesRemoved: 0, droppedEntries: 0, voidedCode: false })
    expect(fileJson(file)).toEqual({ schema: 1, enabled: true, host: HOST, port: 4320, viewerPort: 4319, logins: [LOGIN], devices: [] })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(strays(dir)).toEqual([])
    expect(readRemoteSetting(file).ok).toBe(true)
  })

  it('uses 4393 and 4392 for a checkout build', async () => {
    const { c, file } = hub({ isPackaged: false, serve: goodServe(4393) })
    expect((await c.turnOn()).ok).toBe(true)
    expect(fileJson(file)).toMatchObject({ port: 4393, viewerPort: 4392 })
  })

  it('keeps devices and every unknown field, at the top level and in each device, for the same identity', async () => {
    const { c, dir, file } = hub()
    const kept = { ...device(newSecret(), A), future: { x: 1 } }
    writeSetting(dir, setting(4320, [kept], { enabled: false, futureTop: [1, 2] }))
    expect(await c.turnOn()).toMatchObject({ ok: true, devicesRemoved: 0 })
    expect(fileJson(file)).toEqual({ ...setting(4320, [kept], { futureTop: [1, 2] }), enabled: true })
  })

  it.each([
    ['another host (the machine was renamed)', { host: OTHER_HOST }],
    ['another login (another account signed in)', { logins: [OTHER_LOGIN] }],
    ['a second login beside this one', { logins: [LOGIN, OTHER_LOGIN] }],
    ['no host stored', { host: undefined }],
  ] as Array<[string, Record<string, unknown>]>)('removes every device when the stored identity is %s, and says so', async (_name, stored) => {
    const { c, dir, file } = hub()
    writeSetting(dir, setting(4320, [device(newSecret(), A), device(newSecret(), B)], { enabled: false, ...stored }))
    const result = await c.turnOn()
    expect(result).toMatchObject({ ok: true, devicesRemoved: 2 })
    expect(fileJson(file)).toMatchObject({ host: HOST, logins: [LOGIN], devices: [], enabled: true })
  })

  it('drops the entries the reader would drop, and says how many', async () => {
    const { c, dir, file } = hub()
    writeSetting(dir, setting(4320, [device(newSecret(), A), { id: 'short' }, null], { enabled: false }))
    expect(await c.turnOn()).toMatchObject({ ok: true, devicesRemoved: 0, droppedEntries: 2 })
    expect((fileJson(file).devices as Array<{ id: string }>).map((d) => d.id)).toEqual([A])
  })

  it.each([
    ['Serve has a second path', { serve: { ...goodServe(4320), Web: { [`${HOST}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:4320' }, '/x': { Proxy: 'http://127.0.0.1:1' } } } } } }, 'serve', 'other_path'],
    ['Serve is not configured', { serve: {} }, 'serve', 'no_handler'],
    ['Serve cannot be read', { serve: { raw: 'nope' } }, 'serve', 'unreadable'],
    ['the node is tagged', { self: taggedStatus() }, 'self', 'tagged'],
    ['Tailscale is stopped', { self: selfStatus({ BackendState: 'Stopped' }) }, 'self', 'not_running'],
  ] as Array<[string, { self?: unknown; serve?: unknown }, string, string]>)('is refused, writing nothing, when %s', async (_name, answers, step, reason) => {
    const { c, dir, file } = hub(answers)
    writeSetting(dir, setting(4320, [], { enabled: false }))
    const before = readFileSync(file, 'utf8')
    expect(await c.turnOn()).toEqual({ ok: false, reason, step })
    expect(readFileSync(file, 'utf8')).toBe(before)
    const fresh = hub(answers)
    expect((await fresh.c.turnOn()).ok).toBe(false)
    expect(existsSync(fresh.file)).toBe(false)
  })

  it('checks Serve for this node\'s host and the entry\'s port, after the identity, and not at all when the identity fails', async () => {
    const good = hub()
    await good.c.turnOn()
    expect(good.tailscale.calls.map((call) => call.args.join(' '))).toEqual(['status --json', 'serve status --json'])
    const tagged = hub({ self: taggedStatus() })
    await tagged.c.turnOn()
    expect(tagged.tailscale.calls.map((call) => call.args.join(' '))).toEqual(['status --json'])
  })

  it('never writes a newer schema, a symlink, a file that is not JSON or not this user\'s', async () => {
    const newer = hub()
    writeSetting(newer.dir, setting(4320, [], { schema: 2, enabled: false }))
    const text = readFileSync(newer.file, 'utf8')
    expect(await newer.c.turnOn()).toEqual({ ok: false, reason: 'newer_schema', step: 'file' })
    expect(readFileSync(newer.file, 'utf8')).toBe(text)

    const link = hub()
    writeFileSync(join(link.dir, 'real.json'), '{"schema":1}', { mode: 0o600 })
    symlinkSync(join(link.dir, 'real.json'), link.file)
    expect(await link.c.turnOn()).toEqual({ ok: false, reason: 'not_regular', step: 'file' })
    expect(readFileSync(join(link.dir, 'real.json'), 'utf8')).toBe('{"schema":1}')

    const broken = hub()
    writeSetting(broken.dir, '{"schema":1,')
    expect(await broken.c.turnOn()).toEqual({ ok: false, reason: 'not_json', step: 'file' })
    expect(readFileSync(broken.file, 'utf8')).toBe('{"schema":1,')

    const other = hub({ uid: (process.getuid?.() ?? 0) + 1 })
    writeSetting(other.dir, setting(4320, [], { enabled: false }))
    expect(await other.c.turnOn()).toEqual({ ok: false, reason: 'not_owner', step: 'file' })
  })

  it('never takes the entry over from the other build\'s viewer while it is on there', async () => {
    const { c, dir, file } = hub()
    writeSetting(dir, setting(4320, [], { viewerPort: 4392 }))
    const text = readFileSync(file, 'utf8')
    expect(await c.turnOn()).toEqual({ ok: false, reason: 'other_viewer', step: 'file' })
    expect(readFileSync(file, 'utf8')).toBe(text)
  })

  it('refuses when the viewer\'s port would be the entry\'s', async () => {
    const { c } = hub({ env: { AGENT_INBOX_PORT: '4320' } })
    expect(await c.turnOn()).toEqual({ ok: false, reason: 'port_clash', step: 'file' })
  })
})

// ── turnOff(), removeDevice() ──────────────────────────────────────────────

describe('turnOff() and removeDevice()', () => {
  it('turnOff writes enabled: false and nothing else', async () => {
    const { c, dir, file } = hub()
    const before = setting(4320, [{ ...device(newSecret(), A), x: 1 }], { y: 2 })
    writeSetting(dir, before)
    expect(await c.turnOff()).toMatchObject({ ok: true, voidedCode: false })
    expect(fileJson(file)).toEqual({ ...before, enabled: false })
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('turnOff with no file creates none', async () => {
    const { c, file } = hub()
    expect((await c.turnOff()).ok).toBe(true)
    expect(existsSync(file)).toBe(false)
  })

  it('removeDevice removes by id (never by label), keeps the rest and unknown fields, and drops unreadable entries', async () => {
    const { c, dir, file } = hub()
    writeSetting(dir, setting(4320, [{ ...device(newSecret(), A, 'laptop'), x: 1 }, device(newSecret(), B, 'laptop'), { id: 'bad' }], { y: 2 }))
    const result = await c.removeDevice(B)
    expect(result).toMatchObject({ ok: true, droppedEntries: 1 })
    const after = fileJson(file) as { devices: Array<{ id: string; x?: number }>; y: number }
    expect(after.devices.map((d) => [d.id, d.x])).toEqual([[A, 1]])
    expect(after.y).toBe(2)
  })

  it('removeDevice with an unknown id is an ok no-op that does not touch the file; a malformed id is refused', async () => {
    const { c, dir, file } = hub()
    writeSetting(dir, setting(4320, [device(newSecret(), A)]))
    const text = readFileSync(file, 'utf8')
    const stamp = statSync(file).mtimeMs
    expect(await c.removeDevice(C)).toMatchObject({ ok: true })
    expect(readFileSync(file, 'utf8')).toBe(text)
    expect(statSync(file).mtimeMs).toBe(stamp)
    for (const bad of ['laptop', 'AAAAAAAAAAAAAAAA', '', null, 7]) expect(await c.removeDevice(bad)).toEqual({ ok: false, reason: 'bad_id' })
  })

  it('there is no operation that sets logins, host or port, or adds a device', () => {
    const { c } = hub()
    expect(Object.keys(c).sort()).toEqual([
      'acknowledge', 'entryStatus', 'file', 'port', 'refresh', 'removeDevice', 'repairPermissions', 'requestCode', 'selfTest',
      'serveState', 'start', 'state', 'stop', 'tailnetSelf', 'tick', 'turnOff', 'turnOn', 'view', 'viewerPort',
    ])
  })
})

// ── files the controller must not write ────────────────────────────────────

describe('a bad file never throws and is never written over', () => {
  it.each([
    ['not JSON', '{"schema":1,', 'not_json'],
    ['a newer schema', JSON.stringify(setting(4320, [device(newSecret(), A)], { schema: 2 })), 'newer_schema'],
    ['not an object', '[1]', 'not_object'],
  ])('%s', async (_name, text, reason) => {
    const { c, dir, file } = hub()
    writeSetting(dir, text)
    for (const operation of [() => c.turnOff(), () => c.removeDevice(A), () => c.repairPermissions()]) {
      const result = await operation()
      expect(result.ok).toBe(false)
    }
    expect(await c.turnOff()).toEqual({ ok: false, reason })
    expect(readFileSync(file, 'utf8')).toBe(text)
    await expect(c.view()).resolves.toMatchObject({ problem: reason })
  })

  it('a symlink: refused, and nothing written through it', async () => {
    const { c, dir, file } = hub()
    const real = join(dir, 'real.json')
    writeFileSync(real, JSON.stringify(setting(4320, [device(newSecret(), A)])), { mode: 0o600 })
    symlinkSync(real, file)
    const text = readFileSync(real, 'utf8')
    expect(await c.turnOff()).toEqual({ ok: false, reason: 'not_regular' })
    expect(await c.removeDevice(A)).toEqual({ ok: false, reason: 'not_regular' })
    expect(readFileSync(real, 'utf8')).toBe(text)
  })

  it('group or other bits: every operation refuses, until the one explicit repair rewrites it 0600 and off', async () => {
    const { c, dir, file } = hub()
    const value = setting(4320, [device(newSecret(), A)], { extra: 1 })
    writeSetting(dir, value, 0o644)
    expect(await c.view()).toMatchObject({ available: false, problem: 'open_to_others' })
    expect(await c.turnOff()).toEqual({ ok: false, reason: 'open_to_others' })
    expect(await c.removeDevice(A)).toEqual({ ok: false, reason: 'open_to_others' })
    expect(await c.turnOn()).toEqual({ ok: false, reason: 'open_to_others', step: 'file' })
    expect(statSync(file).mode & 0o777).toBe(0o644)
    expect(await c.repairPermissions()).toMatchObject({ ok: true })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(fileJson(file)).toEqual({ ...value, enabled: false })
    expect(await c.repairPermissions()).toEqual({ ok: false, reason: 'not_needed' })
  })
})

// ── the lock ───────────────────────────────────────────────────────────────

describe('writes go through remote.json\'s lock', () => {
  it('concurrent operations are serialised: none is lost', async () => {
    const { c, dir, file } = hub()
    // (turnOn is left out: it reads Tailscale before it queues, so it would reach the lock last)
    writeSetting(dir, setting(4320, [device(newSecret(), A), device(newSecret(), B), device(newSecret(), C)]))
    const results = await Promise.all([c.removeDevice(A), c.removeDevice(B), c.turnOff()])
    expect(results.every((result) => result.ok)).toBe(true)
    const after = fileJson(file) as { enabled: boolean; devices: Array<{ id: string }> }
    expect(after.enabled).toBe(false)
    expect(after.devices.map((d) => d.id)).toEqual([C])
    expect(strays(dir)).toEqual([])
  })

  it('waits while another process holds the lock', async () => {
    const { c, dir, file } = hub()
    writeSetting(dir, setting(4320, [device(newSecret(), A)]))
    const text = readFileSync(file, 'utf8')
    writeFileSync(`${file}.lock`, '', { flag: 'wx', mode: 0o600 })
    const pending = c.turnOff()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(readFileSync(file, 'utf8')).toBe(text)
    unlinkSync(`${file}.lock`)
    expect((await pending).ok).toBe(true)
    expect(fileJson(file).enabled).toBe(false)
  })

  it('shares the lock with the viewer\'s own pairing write, and loses neither change', async () => {
    const dir = scratchDir('remote-entry-live-')
    const db = openDb(join(dir, 'inbox.db'))
    const viewerOpts = { agentHome: dir, runtimeRoot: join(dir, 'runtime'), setupInfoPath: join(dir, 'setup-info.json'), stamp: async () => ({ commit: null, dirty: false }) as never }
    let entry: RemoteEntry | null = null
    const app = createViewer(db, { ...viewerOpts, ownerToken: TOKEN })
    app.post('/api/remote-entry/code', remoteCodeRoute({ makeCode: () => entry!.makeCode() }, TOKEN))
    const local = startLocalViewer(app, 0)
    try {
      await waitUntil(() => local.listening, 'the loopback viewer')
      const localPort = (local.address() as AddressInfo).port
      const port = await freePort()
      const c = createRemoteEntry({
        isPackaged: true, env: { AGENT_INBOX_DB: join(dir, 'inbox.db') }, viewerPort: localPort, port,
        execFile: fakeTailscale({ self: selfStatus(), serve: goodServe(port) }), exists: cliExists, setInterval: () => 0, clearInterval: () => {},
      })
      const file = join(dir, 'remote.json')
      writeSetting(dir, { ...setting(port, [device(newSecret(), A)], { enabled: false }), viewerPort: localPort })
      expect((await c.turnOn()).ok).toBe(true)
      entry = startRemoteEntry({ app: createViewer(db, viewerOpts), dir, viewerPort: localPort, intervalMs: 3_600_000 })
      await waitUntil(() => entry!.status().listening, 'the remote entry')
      // a code from the viewer's own route, as any local holder of the token can make one
      const made = await fetch(`http://127.0.0.1:${localPort}/api/remote-entry/code`, { method: 'POST', headers: { Origin: `http://127.0.0.1:${localPort}`, 'X-Agent-Inbox-Owner': TOKEN } })
      const { code } = await made.json() as { code: string }

      writeFileSync(`${file}.lock`, '', { flag: 'wx', mode: 0o600 })
      const text = readFileSync(file, 'utf8')
      const pairing = rawRequest(port, {
        method: 'POST', target: '/api/remote/pair', body: JSON.stringify({ code, label: 'laptop' }),
        headers: [['Host', HOST], ['Tailscale-User-Login', LOGIN], ['Origin', `https://${HOST}`]],
      })
      await waitUntil(() => !entry!.status().codePending, 'the pairing to reach the lock')
      const removal = c.removeDevice(A)
      await new Promise((resolve) => setTimeout(resolve, 150))
      // both wait on the one lock
      expect(readFileSync(file, 'utf8')).toBe(text)
      unlinkSync(`${file}.lock`)
      const [paired, removed] = await Promise.all([pairing, removal])
      expect(removed.ok).toBe(true)
      const ids = (fileJson(file).devices as Array<{ id: string }>).map((d) => d.id)
      // the removal always lands; the pairing lands too unless the viewer refused it (never half of either)
      expect(ids).not.toContain(A)
      if (paired.status === 200) expect(ids).toEqual([(JSON.parse(paired.body) as { device: string }).device])
      else expect(ids).toEqual([])
      expect(strays(dir)).toEqual([])
    } finally {
      await entry?.close()
      local.close()
      db.close()
    }
  })
})

// ── requestCode(), entryStatus() ───────────────────────────────────────────

describe('requestCode(): a pairing code from the app\'s own viewer', () => {
  async function enabled(opts: Parameters<typeof hub>[0] = {}) {
    const h = hub(opts)
    expect((await h.c.turnOn()).ok).toBe(true)
    return h
  }

  it('posts with the loopback Origin and the owner token, and returns the code but never the token or the code\'s id', async () => {
    const { c, v } = await enabled()
    v.codes.push(codeAnswer())
    const result = await c.requestCode()
    expect(result).toEqual({ ok: true, code: CODE, expiresAt: new Date(START + 600_000).toISOString() })
    expect(JSON.stringify(result)).not.toContain(TOKEN)
    expect(JSON.stringify(result)).not.toContain(CODE_ID)
    const sent = v.calls.find((call) => call.url.endsWith('/code'))!
    expect(sent.url).toBe('http://127.0.0.1:4319/api/remote-entry/code')
    expect(sent.init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Origin: 'http://127.0.0.1:4319', 'X-Agent-Inbox-Owner': TOKEN } })
  })

  it('retries a 409 every second while the listener comes up', async () => {
    const { c, v, clock } = await enabled()
    const t = clock.now
    v.codes.push(() => Response.json({ error: 'remote_entry_off' }, { status: 409 }), codeAnswer())
    expect(await c.requestCode()).toMatchObject({ ok: true, code: CODE })
    expect(clock.now - t).toBe(1_000)
  })

  it('gives up after 6 seconds of 409', async () => {
    const { c, v, clock } = await enabled()
    const t = clock.now
    for (let i = 0; i < 20; i += 1) v.codes.push(() => Response.json({ error: 'remote_entry_off' }, { status: 409 }))
    expect(await c.requestCode()).toEqual({ ok: false, reason: 'not_listening' })
    expect(clock.now - t).toBe(6_000)
    expect(v.calls.filter((call) => call.url.endsWith('/code'))).toHaveLength(7)
  })

  it.each([
    ['a code of the wrong shape', () => Response.json({ code: '7K3QX9M2PD', expiresAt: '2026-11-20T09:10:00.000Z', codeId: CODE_ID })],
    ['a code with a U', () => Response.json({ code: '7K3QX-9M2PU', expiresAt: '2026-11-20T09:10:00.000Z', codeId: CODE_ID })],
    ['no expiry', () => Response.json({ code: CODE, codeId: CODE_ID })],
    ['no code id', () => Response.json({ code: CODE, expiresAt: '2026-11-20T09:10:00.000Z' })],
    ['a bad code id', () => Response.json({ code: CODE, expiresAt: '2026-11-20T09:10:00.000Z', codeId: 'XYZ' })],
    ['not JSON', () => new Response('nope', { status: 200 })],
  ])('refuses %s', async (_name, answer) => {
    const { c, v } = await enabled()
    v.codes.push(answer)
    expect(await c.requestCode()).toEqual({ ok: false, reason: 'bad_answer' })
  })

  it('answers 403 and others with fixed words', async () => {
    const { c, v } = await enabled()
    v.codes.push(() => new Response('Forbidden', { status: 403 }), () => new Response('', { status: 500 }))
    expect(await c.requestCode()).toEqual({ ok: false, reason: 'refused' })
    expect(await c.requestCode()).toEqual({ ok: false, reason: 'failed' })
  })

  it('refuses without calling the viewer when the entry is not on, or there is no owner token', async () => {
    const off = hub()
    expect(await off.c.requestCode()).toEqual({ ok: false, reason: 'off' })
    expect(off.v.calls).toEqual([])
    const noToken = await enabled({ ownerToken: undefined })
    expect(await noToken.c.requestCode()).toEqual({ ok: false, reason: 'no_owner_token' })
    expect(noToken.v.calls).toEqual([])
  })

  it('a write after a code says the code was voided', async () => {
    const { c, v, dir } = await enabled()
    writeSetting(dir, setting(4320, [device(newSecret(), A)]))
    await c.acknowledge()
    v.codes.push(codeAnswer())
    await c.requestCode()
    expect(await c.removeDevice(A)).toMatchObject({ ok: true, voidedCode: true })
    expect(await c.turnOff()).toMatchObject({ ok: true, voidedCode: false })
  })
})

describe('entryStatus(): the viewer\'s status, only in its known shape', () => {
  it('copies the known fields and drops any other', async () => {
    const { c, v } = hub()
    v.status = { ...statusBody([{ device: A, codeId: CODE_ID }]), extra: 'x' }
    expect(await c.entryStatus()).toEqual({ ok: true, status: statusBody([{ device: A, codeId: CODE_ID }]) })
    expect(v.calls[0]).toMatchObject({ url: 'http://127.0.0.1:4319/api/remote-entry', init: { method: 'GET', redirect: 'error' } })
  })

  const base = statusBody()
  it.each([
    ['on as a string', { ...base, on: 'true' }],
    ['no listening', { ...base, listening: undefined }],
    ['a port as a string', { ...base, port: '4320' }],
    ['a host as a number', { ...base, host: 7 }],
    ['an error object', { ...base, error: {} }],
    ['paired as bare ids (the older shape)', { ...base, paired: [A] }],
    ['a pairing with a bad device id', { ...base, paired: [{ device: 'x', codeId: CODE_ID }] }],
    ['a pairing with no code id', { ...base, paired: [{ device: A }] }],
    ['17 pairings', { ...base, paired: Array.from({ length: 17 }, () => ({ device: A, codeId: CODE_ID })) }],
    ['a counter missing', { ...base, refused: { ...base.refused, pair: undefined } }],
    ['a negative counter', { ...base, refused: { ...base.refused, device: -1 } }],
    ['a fractional counter', { ...base, refused: { ...base.refused, device: 1.5 } }],
    ['an array', []],
  ])('refuses %s', async (_name, body) => {
    const { c, v } = hub()
    v.status = body
    expect(await c.entryStatus()).toEqual({ ok: false, reason: 'bad_shape' })
  })

  it('refuses a status that is not 200, and a viewer that does not answer', async () => {
    const { c } = hub()
    const broken = createRemoteEntry({ isPackaged: true, env: { AGENT_INBOX_DB: join(scratchDir('remote-entry-'), 'inbox.db') }, fetch: async () => new Response('', { status: 500 }) })
    expect(await broken.entryStatus()).toEqual({ ok: false, reason: 'bad_status' })
    const gone = createRemoteEntry({ isPackaged: true, env: { AGENT_INBOX_DB: join(scratchDir('remote-entry-'), 'inbox.db') }, fetch: async () => { throw new TypeError('fetch failed') } })
    expect(await gone.entryStatus()).toEqual({ ok: false, reason: 'unreachable' })
    expect(c).toBeTruthy()
  })
})

// ── tailnetSelf() ──────────────────────────────────────────────────────────

describe('tailnetSelf(): this node, from `tailscale status --json`', () => {
  it('gives the DNS name without its trailing dot, lowercased, and the login of User[String(Self.UserID)]', async () => {
    const { c } = hub({ self: selfStatus({}, { DNSName: 'HUB.Example.ts.net.' }) })
    expect(await c.tailnetSelf()).toEqual({ ok: true, host: HOST, login: LOGIN })
    // Self.UserID is a number; the User map's keys are strings
    expect(typeof (selfStatus().Self as { UserID: unknown }).UserID).toBe('number')
    expect(Object.keys(selfStatus().User as object)).toEqual([String(USER_ID)])
  })

  it('keeps every digit of a UserID past 2^53', () => {
    const text = JSON.stringify(selfStatus({ User: { '9007199254740993': { LoginName: LOGIN } } }, { UserID: 0 })).replace('"UserID":0', '"UserID":9007199254740993')
    expect(parseTailnetSelf(text)).toEqual({ ok: true, host: HOST, login: LOGIN })
  })

  it('a tagged node is "tagged" from Self.Tags, even though its UserID resolves to a placeholder user, whose login is never returned', async () => {
    const { c } = hub({ self: taggedStatus() })
    const result = await c.tailnetSelf()
    expect(result).toEqual({ ok: false, reason: 'tagged' })
    expect(JSON.stringify(result)).not.toContain('tagged-devices')
    expect(parseTailnetSelf(JSON.stringify(selfStatus({}, { Tags: 'tag:server' })))).toEqual({ ok: false, reason: 'tagged' })
    expect(parseTailnetSelf(JSON.stringify(selfStatus({}, { Tags: [] })))).toMatchObject({ ok: true })
  })

  it.each([
    ['a stopped backend', selfStatus({ BackendState: 'Stopped' }), 'not_running'],
    ['a backend that needs login', selfStatus({ BackendState: 'NeedsLogin' }), 'not_running'],
    ['no DNS name', selfStatus({}, { DNSName: '' }), 'no_dns_name'],
    ['a DNS name of one dot', selfStatus({}, { DNSName: '.' }), 'no_dns_name'],
    ['an address for a DNS name', selfStatus({}, { DNSName: '100.64.0.1.' }), 'bad_host'],
    ['no user entry', selfStatus({ User: {} }), 'no_login'],
    ['a login with a control character', selfStatus({ User: { [String(USER_ID)]: { LoginName: 'owner\u0000@example.com' } } }), 'no_login'],
    ['a login that is not text', selfStatus({ User: { [String(USER_ID)]: { LoginName: 7 } } }), 'no_login'],
    ['no Self', { BackendState: 'Running' }, 'not_json'],
  ] as Array<[string, unknown, string]>)('%s', async (_name, status, reason) => {
    const { c } = hub({ self: status })
    expect(await c.tailnetSelf()).toEqual({ ok: false, reason })
  })

  it('no command line, a failed run and output that is not JSON', async () => {
    const none = createRemoteEntry({ isPackaged: true, env: { AGENT_INBOX_DB: join(scratchDir('remote-entry-'), 'inbox.db') }, execFile: fakeTailscale({ self: selfStatus() }), exists: () => false })
    expect(await none.tailnetSelf()).toEqual({ ok: false, reason: 'no_cli' })
    expect(await hub({ self: { error: Object.assign(new Error('timed out'), { killed: true }) } }).c.tailnetSelf()).toEqual({ ok: false, reason: 'failed' })
    expect(await hub({ self: { raw: '<html>' } }).c.tailnetSelf()).toEqual({ ok: false, reason: 'not_json' })
  })
})

// ── the watch ──────────────────────────────────────────────────────────────

describe('the watch: Serve\'s shape and this node\'s identity while the entry is on', () => {
  it('turns the entry off and calls onStopped once when Serve goes bad, touching nothing else', async () => {
    let bad = false
    const h = hub({ serve: undefined })
    const serveAnswers = fakeTailscale({ self: selfStatus(), serve: () => (bad ? { ...goodServe(4320), AllowFunnel: { [`${HOST}:443`]: true } } : goodServe(4320)) })
    const c = createRemoteEntry({
      isPackaged: true, env: { AGENT_INBOX_DB: join(h.dir, 'inbox.db') }, execFile: serveAnswers, exists: cliExists,
      now: () => h.clock.now, setInterval: () => 0, clearInterval: () => {}, fetch: async () => new Response('', { status: 500 }),
      onStopped: (reason: string, detail: { off: boolean }) => { h.events.stopped.push(`${reason}:${detail.off}`) },
      onOutsideChange: () => { h.events.outside += 1 },
    })
    const before = setting(4320, [device(newSecret(), A)], { extra: 1 })
    writeSetting(h.dir, before)
    c.start()
    await c.tick()
    expect(h.events.stopped).toEqual([])
    bad = true
    h.clock.now += 30_000
    await c.tick()
    expect(fileJson(h.file).enabled).toBe(true)
    h.clock.now += 30_000
    await c.tick()
    expect(fileJson(h.file)).toEqual({ ...before, enabled: false })
    expect(h.events.stopped).toEqual(['funnel:true'])
    for (let i = 0; i < 5; i += 1) {
      h.clock.now += 60_000
      await c.tick()
    }
    expect(h.events.stopped).toEqual(['funnel:true'])
    expect(h.events.outside).toBe(0)
    const state = await c.state()
    expect(state.stopped).toMatchObject({ reason: 'funnel', off: true })
    expect(state.serve?.answer).toEqual({ ok: false, reason: 'funnel', present: true })
    expect(state.removalHint).toBe(REMOVAL_HINT)
    c.stop()
  })

  it('calls onStopped once even when the turn-off write fails, and says the entry is not off', async () => {
    const h = hub({ serve: {} })
    writeSetting(h.dir, setting(4320, []))
    chmodSync(h.dir, 0o500)
    try {
      h.c.start()
      await h.c.tick()
      for (let i = 0; i < 3; i += 1) {
        h.clock.now += 60_000
        await h.c.tick()
      }
      expect(h.events.stopped).toEqual(['no_handler'])
      expect((await h.c.state()).stopped).toMatchObject({ reason: 'no_handler', off: false })
      // the watch keeps trying to turn it off
      expect(h.tailscale.calls.filter((call) => call.args[0] === 'serve').length).toBe(4)
    } finally {
      chmodSync(h.dir, 0o700)
    }
    expect(fileJson(h.file).enabled).toBe(true)
  })

  it('turns the entry off when this node no longer has the stored host or a stored login', async () => {
    for (const self of [selfStatus({}, { DNSName: `${OTHER_HOST}.` }), selfStatus({ User: { [String(USER_ID)]: { LoginName: OTHER_LOGIN } } }), taggedStatus()]) {
      const h = hub({ self })
      writeSetting(h.dir, setting(4320, []))
      h.c.start()
      await h.c.tick()
      expect(fileJson(h.file).enabled).toBe(false)
      expect(h.events.stopped).toHaveLength(1)
      expect(['identity_changed', 'tagged']).toContain(h.events.stopped[0])
      const state = await h.c.state()
      expect(JSON.stringify(state)).not.toContain(OTHER_LOGIN)
      expect(JSON.stringify(state)).not.toContain('tagged-devices')
    }
  })

  it('never reads Serve while the entry is off, except once for the removal hint when the file names a host', async () => {
    const h = hub({ serve: { TCP: { '443': { HTTPS: true } }, Web: { [`${HOST}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:4320' } } } } } })
    writeSetting(h.dir, setting(4320, [], { enabled: false }))
    h.c.start()
    for (let i = 0; i < 5; i += 1) {
      await h.c.tick()
      h.clock.now += 60_000
    }
    expect(h.tailscale.calls.map((call) => call.args.join(' '))).toEqual(['serve status --json'])
    expect((await h.c.state()).removalHint).toBe(REMOVAL_HINT)
    const none = hub({ serve: {} })
    none.c.start()
    await none.c.tick()
    expect(none.tailscale.calls).toEqual([])
    expect((await none.c.state()).removalHint).toBe(null)
  })
})

describe('the watch: changes made outside the app', () => {
  /** An enabled hub whose watch has started, with a code asked for unless told otherwise. */
  async function watched(opts: { code?: boolean } = {}) {
    const h = hub()
    writeSetting(h.dir, setting(4320, [device(newSecret(), A)], { enabled: false }))
    expect((await h.c.turnOn()).ok).toBe(true)
    h.c.start()
    await h.c.tick()
    if (opts.code !== false) {
      h.v.codes.push(codeAnswer())
      expect((await h.c.requestCode()).ok).toBe(true)
    }
    return h
  }
  /** The viewer's pairing write, as it makes it: the device appended, the rest as read. */
  function addDevice(file: string, id: string, label = 'laptop') {
    const doc = fileJson(file) as { devices: unknown[] }
    doc.devices.push(device(newSecret(), id, label))
    writeFileSync(file, JSON.stringify(doc, null, 2), { mode: 0o600 })
  }

  it('main\'s own writes are never flagged', async () => {
    const h = await watched()
    await h.c.removeDevice(A)
    await h.c.turnOff()
    await h.c.tick()
    expect(h.events.outside).toBe(0)
    expect((await h.c.state()).flag).toBe(false)
  })

  it('an expected pairing: in the viewer\'s paired list with a code id this controller received, within 11 minutes', async () => {
    const h = await watched()
    h.clock.now += 10 * 60_000
    addDevice(h.file, B, 'laptop')
    h.v.status = statusBody([{ device: B, codeId: CODE_ID }])
    await h.c.tick()
    expect(h.events.paired).toEqual(['laptop'])
    expect(h.events.outside).toBe(0)
    expect((await h.c.state()).flag).toBe(false)
    await h.c.tick()
    expect(h.events.paired).toEqual(['laptop'])
  })

  it.each([
    ['no code asked for', { code: false }, (h: Awaited<ReturnType<typeof watched>>) => { h.v.status = statusBody([{ device: B, codeId: CODE_ID }]) }],
    ['the code asked for over 11 minutes ago', {}, (h: Awaited<ReturnType<typeof watched>>) => { h.clock.now += 11 * 60_000 + 1; h.v.status = statusBody([{ device: B, codeId: CODE_ID }]) }],
    ['the device not in the viewer\'s paired list (a viewer restart empties it)', {}, (h: Awaited<ReturnType<typeof watched>>) => { h.v.status = statusBody([]) }],
    ['the device paired with a code another process made', {}, (h: Awaited<ReturnType<typeof watched>>) => { h.v.status = statusBody([{ device: B, codeId: 'f00d000000000000' }]) }],
    ['main\'s code used by another device', {}, (h: Awaited<ReturnType<typeof watched>>) => { h.v.status = statusBody([{ device: C, codeId: CODE_ID }]) }],
    ['the viewer not answering', {}, (h: Awaited<ReturnType<typeof watched>>) => { h.v.status = { broken: true } }],
  ] as Array<[string, { code?: boolean }, (h: Awaited<ReturnType<typeof watched>>) => void]>)('a device added with %s is an outside change', async (_name, opts, arrange) => {
    const h = await watched(opts)
    arrange(h)
    addDevice(h.file, B)
    await h.c.tick()
    await h.c.tick()
    expect(h.events.paired).toEqual([])
    expect(h.events.outside).toBe(1)
    expect((await h.c.state()).flag).toBe(true)
    // never reverted
    expect((fileJson(h.file).devices as Array<{ id: string }>).map((d) => d.id)).toEqual([A, B])
  })

  it('one code pairs one device: a second device on the same code is an outside change', async () => {
    const h = await watched()
    addDevice(h.file, B)
    addDevice(h.file, C)
    h.v.status = statusBody([{ device: B, codeId: CODE_ID }, { device: C, codeId: CODE_ID }])
    await h.c.tick()
    expect(h.events.paired).toEqual([])
    expect(h.events.outside).toBe(1)
  })

  it('two codes asked for, but both devices claim the same one: an outside change', async () => {
    const h = await watched()
    h.v.codes.push(codeAnswer('c0de0000000000a2'))
    expect((await h.c.requestCode()).ok).toBe(true)
    addDevice(h.file, B)
    addDevice(h.file, C)
    h.v.status = statusBody([{ device: B, codeId: CODE_ID }, { device: C, codeId: CODE_ID }])
    await h.c.tick()
    expect(h.events.paired).toEqual([])
    expect(h.events.outside).toBe(1)
  })

  it('an expected device added together with any other change: an outside change, and no pairing announced', async () => {
    const h = await watched()
    addDevice(h.file, B)
    const doc = fileJson(h.file)
    writeFileSync(h.file, JSON.stringify({ ...doc, logins: [LOGIN, OTHER_LOGIN] }), { mode: 0o600 })
    h.v.status = statusBody([{ device: B, codeId: CODE_ID }])
    await h.c.tick()
    expect(h.events.paired).toEqual([])
    expect(h.events.outside).toBe(1)
  })

  it.each([
    ['a login changed by hand', (doc: Record<string, unknown>) => { doc.logins = [OTHER_LOGIN] }],
    ['enabled flipped by hand', (doc: Record<string, unknown>) => { doc.enabled = false }],
    ['a device\'s hash swapped', (doc: Record<string, unknown>) => { (doc.devices as Array<Record<string, unknown>>)[0]!.secretSha256 = 'f'.repeat(64) }],
    ['the port moved', (doc: Record<string, unknown>) => { doc.port = 4400 }],
    ['the viewer port moved', (doc: Record<string, unknown>) => { doc.viewerPort = 4392 }],
  ] as Array<[string, (doc: Record<string, unknown>) => void]>)('%s: onOutsideChange once and the flag, until acknowledge(); never reverted', async (_name, edit) => {
    const h = await watched({ code: false })
    const doc = fileJson(h.file)
    edit(doc)
    writeFileSync(h.file, JSON.stringify(doc), { mode: 0o600 })
    await h.c.tick()
    await h.c.tick()
    expect(h.events.outside).toBe(1)
    expect((await h.c.state()).flag).toBe(true)
    expect(fileJson(h.file)).toEqual(doc)
    await h.c.acknowledge()
    expect((await h.c.state()).flag).toBe(false)
    await h.c.tick()
    expect(h.events.outside).toBe(1)
    // a further change is a new state: called again
    writeFileSync(h.file, JSON.stringify({ ...doc, logins: ['third@example.com'] }), { mode: 0o600 })
    await h.c.tick()
    expect(h.events.outside).toBe(2)
  })

  it('a label changed by hand is not watched (labels name nothing the gate checks)', async () => {
    const h = await watched({ code: false })
    const doc = fileJson(h.file) as { devices: Array<Record<string, unknown>> }
    doc.devices[0]!.label = 'renamed'
    writeFileSync(h.file, JSON.stringify(doc), { mode: 0o600 })
    await h.c.tick()
    expect(h.events.outside).toBe(0)
  })

  it('the file made readable by others is an outside change', async () => {
    const h = await watched({ code: false })
    chmodSync(h.file, 0o644)
    await h.c.tick()
    expect(h.events.outside).toBe(1)
  })

  it('an outside change followed by main\'s own write is still flagged: the write never hides it', async () => {
    const h = await watched({ code: false })
    const doc = fileJson(h.file)
    writeFileSync(h.file, JSON.stringify({ ...doc, logins: [OTHER_LOGIN] }), { mode: 0o600 })
    expect((await h.c.turnOff()).ok).toBe(true)
    expect(h.events.outside).toBe(1)
    expect((await h.c.state()).flag).toBe(true)
  })

  it('no state or callback carries a login (other than view().logins), a hash, the token, a code or its id', async () => {
    const h = await watched()
    addDevice(h.file, B)
    h.v.status = statusBody([{ device: B, codeId: CODE_ID }])
    await h.c.tick()
    const text = JSON.stringify({ ...(await h.c.state()), view: undefined }) + JSON.stringify(h.events)
    for (const secret of [LOGIN, TOKEN, CODE, CODE_ID]) expect(text).not.toContain(secret)
    expect(text).not.toMatch(/[0-9a-f]{64}/)
  })
})

// ── selfTest() ─────────────────────────────────────────────────────────────

describe('selfTest(): a request from the hub to its own Serve address, with no device secret', () => {
  async function enabled() {
    const h = hub()
    expect((await h.c.turnOn()).ok).toBe(true)
    return h
  }

  it('passes on a 403 with the device count up by one', async () => {
    const h = await enabled()
    h.v.version = () => {
      (h.v.status as ReturnType<typeof statusBody>).refused.device += 1
      return new Response('Forbidden', { status: 403 })
    }
    expect(await h.c.selfTest()).toEqual({ ok: true })
    const sent = h.v.calls.find((call) => call.url.startsWith('https://'))!
    expect(sent.url).toBe(`https://${HOST}/api/version`)
    expect(sent.init).toMatchObject({ method: 'GET', redirect: 'error' })
    expect(JSON.stringify(sent.init)).not.toMatch(/device|owner/i)
  })

  it('names the counter that rose instead', async () => {
    const h = await enabled()
    h.v.version = () => {
      (h.v.status as ReturnType<typeof statusBody>).refused.login += 1
      return new Response('Forbidden', { status: 403 })
    }
    expect(await h.c.selfTest()).toEqual({ ok: false, reason: 'no_device_count', rose: 'login' })
  })

  it('says nothing reached the entry, or it was not refused, or Serve cannot be reached', async () => {
    const h = await enabled()
    expect(await h.c.selfTest()).toEqual({ ok: false, reason: 'no_device_count', rose: null })
    h.v.version = () => new Response('{}', { status: 200 })
    expect(await h.c.selfTest()).toEqual({ ok: false, reason: 'not_refused', rose: null })
    h.v.version = () => { throw new TypeError('fetch failed') }
    expect(await h.c.selfTest()).toEqual({ ok: false, reason: 'unreachable', rose: null })
  })

  it('does nothing while the entry is off', async () => {
    const h = hub()
    expect(await h.c.selfTest()).toEqual({ ok: false, reason: 'off', rose: null })
    expect(h.v.calls).toEqual([])
  })
})

describe('no Tailscale call runs while remote.json\'s lock is held', () => {
  it('turnOn and the watch read Tailscale before taking the lock', async () => {
    const h = hub()
    const before = lockViolations.length
    writeSetting(h.dir, setting(4320, [], { enabled: false }))
    await h.c.turnOn()
    h.c.start()
    await h.c.tick()
    h.clock.now += 60_000
    await h.c.refresh()
    expect(h.tailscale.calls.length).toBeGreaterThanOrEqual(4)
    expect(lockViolations.length).toBe(before)
  })
})
