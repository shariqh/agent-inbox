// The remote entry's setting, remote.json beside the hub database, and the listener it
// opens and closes (#617, PR 2a; design docs/superpowers/specs/2026-11-17-remote-inbox-design.md §3.2).
// Anything but a regular private file this user owns, holding a schema-1 object with
// valid fields, means off.
import { once } from 'node:events'
import { mkdirSync, symlinkSync, writeFileSync, chmodSync, renameSync } from 'node:fs'
import { createServer, connect } from 'node:net'
import type { Socket } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { readRemoteSetting, remoteSettingCache, startRemoteEntry } from '../src/viewer-remote.js'
import type { RemoteEntry } from '../src/viewer-remote.js'
import { removeScratchDirs, scratchDir } from './scratch.js'
import { waitUntil } from './wait.js'
import {
  HOST, LOGIN, VIEWER_PORT, device, deviceHeaders, freePort, newSecret, rawRequest, secretSha256, setting, writeSetting,
} from './remote-fixtures.js'

const entries: RemoteEntry[] = []
afterEach(async () => {
  for (const entry of entries.splice(0)) await entry.close()
  vi.restoreAllMocks()
  removeScratchDirs()
})

function readValue(value: unknown, mode = 0o600) {
  const dir = scratchDir('remote-setting-')
  return readRemoteSetting(writeSetting(dir, value, mode))
}

describe('readRemoteSetting: the file', () => {
  it('reads a valid file', () => {
    const secret = newSecret()
    const read = readValue(setting(4320, [device(secret)]))
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.setting).toMatchObject({ enabled: true, viewerPort: VIEWER_PORT, port: 4320, host: HOST, logins: [LOGIN] })
    expect(read.setting.devices).toHaveLength(1)
    expect(read.setting.devices[0]!.id).toBe('3f9c0a1b2d4e5f60')
  })

  it('is off when the file is missing', () => {
    const dir = scratchDir('remote-setting-')
    expect(readRemoteSetting(join(dir, 'remote.json'))).toEqual({ ok: false, reason: 'missing' })
  })

  it('is off for a symlink, even to a valid private file', () => {
    const dir = scratchDir('remote-setting-')
    const real = join(dir, 'real.json')
    writeFileSync(real, JSON.stringify(setting(4320, [])), { mode: 0o600 })
    symlinkSync(real, join(dir, 'remote.json'))
    expect(readRemoteSetting(join(dir, 'remote.json'))).toEqual({ ok: false, reason: 'not-regular' })
  })

  it('is off for a folder', () => {
    const dir = scratchDir('remote-setting-')
    mkdirSync(join(dir, 'remote.json'), { mode: 0o700 })
    expect(readRemoteSetting(join(dir, 'remote.json'))).toEqual({ ok: false, reason: 'not-regular' })
  })

  it.each(['644', '640', '604', '620', '602', '610', '601'])('is off for mode %s (open to other users)', (mode) => {
    expect(readValue(setting(4320, []), parseInt(mode, 8))).toEqual({ ok: false, reason: 'open-to-others' })
  })

  it('accepts 0400 (owner read only)', () => {
    expect(readValue(setting(4320, []), 0o400).ok).toBe(true)
  })

  it('is off above 64 KiB, and reads 64 KiB exactly', () => {
    const base = JSON.stringify(setting(4320, []))
    const pad = (size: number) => `${base.slice(0, -1)},"pad":"${'x'.repeat(size - base.length - 9)}"}`
    expect(pad(64 * 1024).length).toBe(64 * 1024)
    expect(readValue(pad(64 * 1024)).ok).toBe(true)
    expect(readValue(pad(64 * 1024 + 1))).toEqual({ ok: false, reason: 'too-large' })
  })

  it.each([
    ['not JSON', '{"schema":1,'],
    ['an array', '[1]'],
    ['null', 'null'],
    ['a string', '"x"'],
  ])('is off for %s', (_name, text) => {
    expect(readValue(text)).toEqual({ ok: false, reason: expect.stringMatching(/^not-(json|object)$/) })
  })

  it.each([
    ['no schema', { schema: undefined }, 'no-schema'],
    ['schema 0', { schema: 0 }, 'no-schema'],
    ['schema "1"', { schema: '1' }, 'no-schema'],
    ['schema 1.5', { schema: 1.5 }, 'no-schema'],
    ['a newer schema', { schema: 2 }, 'newer-schema'],
  ])('is off with %s', (_name, extra, reason) => {
    expect(readValue(setting(4320, [], extra))).toEqual({ ok: false, reason })
  })

  it('keeps unknown fields out of the result and ignores them', () => {
    const read = readValue(setting(4320, [], { future: { on: true } }))
    expect(read.ok).toBe(true)
    if (read.ok) expect(Object.keys(read.setting).sort()).toEqual(['devices', 'enabled', 'host', 'logins', 'port', 'viewerPort'])
  })
})

describe('readRemoteSetting: the fields', () => {
  it('reads enabled only when it is exactly true', () => {
    for (const enabled of [false, 'true', 1, undefined]) {
      const read = readValue(setting(4320, [], { enabled }))
      expect(read.ok, String(enabled)).toBe(true)
      if (read.ok) expect(read.setting.enabled).toBe(false)
    }
  })

  it('lowercases host and refuses a malformed one', () => {
    const read = readValue(setting(4320, [], { host: 'HUB.Example.TS.net' }))
    expect(read.ok && read.setting.host).toBe(HOST)
    for (const host of ['hub', 'hub.example.ts.net.', 'hub..ts.net', 'hub.example.ts.net:443', 'https://hub.example.ts.net', 'hub_x.ts.net', '', 7, undefined]) {
      expect(readValue(setting(4320, [], { host })), String(host)).toEqual({ ok: false, reason: 'bad-host' })
    }
  })

  it('needs 1 to 16 logins of 1 to 254 characters without control characters, kept lowercased', () => {
    const read = readValue(setting(4320, [], { logins: ['Owner@Example.com', 'b@example.com'] }))
    expect(read.ok && read.setting.logins).toEqual([LOGIN, 'b@example.com'])
    expect(readValue(setting(4320, [], { logins: Array.from({ length: 16 }, (_, i) => `u${i}@example.com`) })).ok).toBe(true)
    expect(readValue(setting(4320, [], { logins: ['x'.repeat(254)] })).ok).toBe(true)
    for (const logins of [[], Array.from({ length: 17 }, (_, i) => `u${i}@example.com`), [''], ['x'.repeat(255)], ['a\nb@example.com'], ['a\u0000b'], ['a\u007fb'], [7], 'owner@example.com', undefined]) {
      expect(readValue(setting(4320, [], { logins })), JSON.stringify(logins)?.slice(0, 40)).toEqual({ ok: false, reason: 'bad-logins' })
    }
  })

  it('needs port 1024 to 65535, not the viewer port, and a viewer port', () => {
    expect(readValue(setting(1024, [])).ok).toBe(true)
    expect(readValue(setting(65535, [])).ok).toBe(true)
    for (const port of [1023, 65536, VIEWER_PORT, 4320.5, '4320', undefined, null]) {
      expect(readValue(setting(4320, [], { port })), String(port)).toEqual({ ok: false, reason: 'bad-port' })
    }
    for (const viewerPort of [0, 65536, 4319.5, '4319', undefined]) {
      expect(readValue(setting(4320, [], { viewerPort })), String(viewerPort)).toEqual({ ok: false, reason: 'bad-port' })
    }
  })

  it('drops a malformed device and keeps the rest', () => {
    const good = newSecret()
    const sha = secretSha256(newSecret())
    const bad = [
      { id: '3F9C0A1B2D4E5F60', label: 'upper id', secretSha256: sha },
      { id: '3f9c0a1b2d4e5f6', label: 'short id', secretSha256: sha },
      { id: '3f9c0a1b2d4e5f6g', label: 'not hex', secretSha256: sha },
      { id: '1111111111111111', label: '', secretSha256: sha },
      { id: '2222222222222222', label: 'x'.repeat(41), secretSha256: sha },
      { id: '3333333333333333', label: 'tab\there', secretSha256: sha },
      { id: '4444444444444444', label: 'short hash', secretSha256: sha.slice(1) },
      { id: '5555555555555555', label: 'upper hash', secretSha256: sha.toUpperCase() },
      { id: '6666666666666666', label: 'no hash' },
      { id: '7777777777777777', secretSha256: sha },
      'a string',
      null,
      [],
    ]
    const read = readValue(setting(4320, [...bad, device(good, 'aaaaaaaaaaaaaaaa', 'x'.repeat(40))]))
    expect(read.ok).toBe(true)
    if (read.ok) expect(read.setting.devices.map((d) => d.id)).toEqual(['aaaaaaaaaaaaaaaa'])
  })

  it('reads no devices as none, and is off for more than 16 or a non-list', () => {
    const none = readValue(setting(4320, [], { devices: undefined }))
    expect(none.ok && none.setting.devices).toEqual([])
    const sixteen = Array.from({ length: 16 }, (_, i) => device(newSecret(), i.toString(16).padStart(16, '0')))
    expect(readValue(setting(4320, sixteen)).ok).toBe(true)
    expect(readValue(setting(4320, [...sixteen, device(newSecret(), 'ffffffffffffffff')]))).toEqual({ ok: false, reason: 'bad-devices' })
    expect(readValue(setting(4320, [], { devices: {} }))).toEqual({ ok: false, reason: 'bad-devices' })
  })
})

describe('remoteSettingCache', () => {
  it('stats on every call and re-reads only when the file changed', () => {
    const dir = scratchDir('remote-setting-')
    const file = writeSetting(dir, setting(4320, []))
    const read = vi.fn(readRemoteSetting)
    const cache = remoteSettingCache(file, read)
    for (let i = 0; i < 5; i++) expect(cache.current().ok).toBe(true)
    expect(read).toHaveBeenCalledTimes(1)
    chmodSync(file, 0o644)
    expect(cache.current()).toEqual({ ok: false, reason: 'open-to-others' })
    expect(read).toHaveBeenCalledTimes(2)
    // a rename over the file (main's locked write) is a change too, same size or not
    writeSetting(join(dir), setting(4321, []))
    const next = join(dir, 'next.json')
    writeFileSync(next, JSON.stringify(setting(4322, [])), { mode: 0o600 })
    renameSync(next, file)
    const after = cache.current()
    expect(after.ok && after.setting.port).toBe(4322)
  })
})

// ── the listener ────────────────────────────────────────────────────────────

function okApp(): Hono {
  const app = new Hono()
  app.get('/api/items', (c) => c.json({ ok: true }))
  return app
}

async function start(dir: string, opts: { viewerPort?: number; intervalMs?: number } = {}): Promise<RemoteEntry> {
  const entry = startRemoteEntry({ app: okApp(), dir, viewerPort: opts.viewerPort ?? VIEWER_PORT, intervalMs: opts.intervalMs ?? 100 })
  entries.push(entry)
  return entry
}

async function refused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1')
    socket.once('connect', () => { socket.destroy(); resolve(false) })
    socket.once('error', () => resolve(true))
  })
}

describe('startRemoteEntry: the listener', () => {
  it('opens on 127.0.0.1 at the setting port when enabled for this viewer', async () => {
    const dir = scratchDir('remote-entry-')
    const port = await freePort()
    const secret = newSecret()
    writeSetting(dir, setting(port, [device(secret)]))
    const entry = await start(dir)
    await waitUntil(() => entry.status().listening, 'the remote entry to listen')
    expect(entry.status()).toMatchObject({ on: true, listening: true, port, host: HOST, error: null })
    expect(entry.address()).toEqual({ address: '127.0.0.1', family: 'IPv4', port })
    const ok = await rawRequest(port, { target: '/api/items', headers: deviceHeaders(secret) })
    expect(ok.status).toBe(200)
  })

  it('stays closed when the file is missing, off, a symlink or open to others', async () => {
    for (const make of [
      (_dir: string, _port: number) => {},
      (dir: string, port: number) => writeSetting(dir, setting(port, [], { enabled: false })),
      (dir: string, port: number) => writeSetting(dir, setting(port, []), 0o644),
      (dir: string, port: number) => {
        writeFileSync(join(dir, 'real.json'), JSON.stringify(setting(port, [])), { mode: 0o600 })
        symlinkSync(join(dir, 'real.json'), join(dir, 'remote.json'))
      },
      (dir: string, port: number) => writeSetting(dir, setting(port, [], { schema: 2 })),
    ]) {
      const dir = scratchDir('remote-entry-')
      const port = await freePort()
      make(dir, port)
      const entry = await start(dir)
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(entry.status().listening).toBe(false)
      expect(entry.status().on).toBe(false)
      expect(await refused(port)).toBe(true)
    }
  })

  it('stays closed when viewerPort is not this viewer\'s port (a checkout beside the installed app)', async () => {
    const dir = scratchDir('remote-entry-')
    const port = await freePort()
    writeSetting(dir, setting(port, []))
    const entry = await start(dir, { viewerPort: 4392 })
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(entry.status()).toMatchObject({ on: false, listening: false })
    expect(await refused(port)).toBe(true)
  })

  it('opens when the setting turns on, and closes every connection when it turns off', async () => {
    const dir = scratchDir('remote-entry-')
    const port = await freePort()
    const secret = newSecret()
    writeSetting(dir, setting(port, [device(secret)], { enabled: false }))
    const entry = await start(dir)
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(entry.status().listening).toBe(false)
    writeSetting(dir, setting(port, [device(secret)]))
    await waitUntil(() => entry.status().listening, 'the entry to open after the switch went on')

    // a kept-alive connection, idle between requests
    const socket: Socket = connect(port, '127.0.0.1')
    await once(socket, 'connect')
    let received = ''
    socket.on('data', (chunk) => { received += chunk.toString() })
    socket.write(`GET /api/items HTTP/1.1\r\nHost: ${HOST}\r\nTailscale-User-Login: ${LOGIN}\r\nX-Agent-Inbox-Device: ${secret}\r\n\r\n`)
    await waitUntil(() => received.includes('"ok":true'), 'the kept-alive answer')
    // half a second request: the connection is busy, so server.close() alone would leave it open
    socket.write(`GET /api/items HTTP/1.1\r\nHost: ${HOST}\r\n`)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const closed = once(socket, 'close')

    writeSetting(dir, setting(port, [device(secret)], { enabled: false }))
    // closeAllConnections ends it at once; without it Node lets the busy connection linger for seconds
    const outcome = await Promise.race([closed.then(() => 'closed'), new Promise((resolve) => setTimeout(resolve, 3000, 'open'))])
    expect(outcome).toBe('closed')
    await waitUntil(() => !entry.status().listening, 'the entry to close')
    expect(await refused(port)).toBe(true)
  })

  it('moves to a new port when the setting changes it', async () => {
    const dir = scratchDir('remote-entry-')
    const first = await freePort()
    writeSetting(dir, setting(first, []))
    const entry = await start(dir)
    await waitUntil(() => entry.status().listening, 'the first port')
    const second = await freePort()
    writeSetting(dir, setting(second, []))
    await waitUntil(() => (entry.address() as { port?: number } | null)?.port === second, 'the second port')
    expect(await refused(first)).toBe(true)
  })

  it('reports a bind failure, logs it once, and keeps the viewer running', async () => {
    const blocker = createServer()
    blocker.listen(0, '127.0.0.1')
    await once(blocker, 'listening')
    const port = (blocker.address() as { port: number }).port
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const dir = scratchDir('remote-entry-')
      writeSetting(dir, setting(port, []))
      const entry = await start(dir, { intervalMs: 50 })
      await waitUntil(() => entry.status().error, 'the bind error')
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(entry.status()).toMatchObject({ on: true, listening: false, port })
      expect(entry.status().error).toMatch(/EADDRINUSE/)
      expect(logged).toHaveBeenCalledTimes(1)
    } finally {
      blocker.close()
    }
  })

  it('the gate sees a removed device on the next request, without waiting for a poll', async () => {
    const dir = scratchDir('remote-entry-')
    const port = await freePort()
    const kept = newSecret()
    const removed = newSecret()
    writeSetting(dir, setting(port, [device(kept), device(removed, 'bbbbbbbbbbbbbbbb')]))
    // a poll an hour apart: only the per-request stat can see the change
    const entry = await start(dir, { intervalMs: 3_600_000 })
    await waitUntil(() => entry.status().listening, 'the entry to listen')
    expect((await rawRequest(port, { target: '/api/items', headers: deviceHeaders(removed) })).status).toBe(200)
    writeSetting(dir, setting(port, [device(kept)]))
    expect((await rawRequest(port, { target: '/api/items', headers: deviceHeaders(removed) })).status).toBe(403)
    expect(entry.status().refused.device).toBe(1)
    expect((await rawRequest(port, { target: '/api/items', headers: deviceHeaders(kept) })).status).toBe(200)
    // and a device added is seen the same way
    const added = newSecret()
    writeSetting(dir, setting(port, [device(kept), device(added, 'cccccccccccccccc')]))
    expect((await rawRequest(port, { target: '/api/items', headers: deviceHeaders(added) })).status).toBe(200)
  })

  it('the gate refuses at once when the setting turns off, before the listener closes', async () => {
    const dir = scratchDir('remote-entry-')
    const port = await freePort()
    const secret = newSecret()
    writeSetting(dir, setting(port, [device(secret)]))
    const entry = await start(dir, { intervalMs: 3_600_000 })
    await waitUntil(() => entry.status().listening, 'the entry to listen')
    const socket: Socket = connect(port, '127.0.0.1')
    await once(socket, 'connect')
    let received = ''
    socket.on('data', (chunk) => { received += chunk.toString() })
    writeSetting(dir, setting(port, [device(secret)]), 0o644)
    socket.write(`GET /api/items HTTP/1.1\r\nHost: ${HOST}\r\nTailscale-User-Login: ${LOGIN}\r\nX-Agent-Inbox-Device: ${secret}\r\n\r\n`)
    await waitUntil(() => received.length > 0 || socket.destroyed, 'an answer or a close')
    expect(received).not.toContain('"ok":true')
    await waitUntil(() => !entry.status().listening, 'the entry to close')
    socket.destroy()
  })

  it('the gate refuses at once when enabled turns false, before the listener closes', async () => {
    const dir = scratchDir('remote-entry-')
    const port = await freePort()
    const secret = newSecret()
    writeSetting(dir, setting(port, [device(secret)]))
    const entry = await start(dir, { intervalMs: 3_600_000 })
    await waitUntil(() => entry.status().listening, 'the entry to listen')
    const socket: Socket = connect(port, '127.0.0.1')
    await once(socket, 'connect')
    let received = ''
    socket.on('data', (chunk) => { received += chunk.toString() })
    writeSetting(dir, setting(port, [device(secret)], { enabled: false }))
    socket.write(`GET /api/items HTTP/1.1\r\nHost: ${HOST}\r\nTailscale-User-Login: ${LOGIN}\r\nX-Agent-Inbox-Device: ${secret}\r\n\r\n`)
    await waitUntil(() => received.length > 0 || socket.destroyed, 'an answer or a close')
    expect(received).not.toContain('"ok":true')
    socket.destroy()
  })

  it('a request still on the old port after the setting moved is refused', async () => {
    const dir = scratchDir('remote-entry-')
    const first = await freePort()
    const secret = newSecret()
    writeSetting(dir, setting(first, [device(secret)]))
    const entry = await start(dir, { intervalMs: 3_600_000 })
    await waitUntil(() => entry.status().listening, 'the entry to listen')
    const socket: Socket = connect(first, '127.0.0.1')
    await once(socket, 'connect')
    let received = ''
    socket.on('data', (chunk) => { received += chunk.toString() })
    writeSetting(dir, setting(await freePort(), [device(secret)]))
    socket.write(`GET /api/items HTTP/1.1\r\nHost: ${HOST}\r\nTailscale-User-Login: ${LOGIN}\r\nX-Agent-Inbox-Device: ${secret}\r\n\r\n`)
    await waitUntil(() => received.length > 0 || socket.destroyed, 'an answer or a close')
    expect(received).not.toContain('"ok":true')
    socket.destroy()
  })

  it('refuses a login with a comma, so a proxy that joined two headers can never match', async () => {
    const dir = scratchDir('remote-entry-')
    const port = await freePort()
    const secret = newSecret()
    const joined = `${LOGIN}, other@example.com`
    writeSetting(dir, setting(port, [device(secret)], { logins: [joined] }))
    const entry = await start(dir)
    await waitUntil(() => entry.status().listening, 'the entry to listen')
    const response = await rawRequest(port, { target: '/api/items', headers: [['Host', HOST], ['Tailscale-User-Login', joined], ['X-Agent-Inbox-Device', secret]] })
    expect(response.status).toBe(403)
    expect(entry.status().refused.login).toBe(1)
  })

  it('strips the loopback marker even if the app behind it set one', async () => {
    const dir = scratchDir('remote-entry-')
    const port = await freePort()
    const secret = newSecret()
    writeSetting(dir, setting(port, [device(secret)]))
    const app = new Hono()
    app.get('/api/items', (c) => {
      c.header('x-agent-inbox-local-boundary', 'loopback-v1')
      return c.json({ ok: true })
    })
    const entry = startRemoteEntry({ app, dir, viewerPort: VIEWER_PORT })
    entries.push(entry)
    await waitUntil(() => entry.status().listening, 'the entry to listen')
    const response = await rawRequest(port, { target: '/api/items', headers: deviceHeaders(secret) })
    expect(response.status).toBe(200)
    expect(response.headers['x-agent-inbox-local-boundary']).toBeUndefined()
    expect(response.headers['x-agent-inbox-remote-boundary']).toBe('tailnet-v1')
  })

  it('status says why the setting is off, in fixed words', async () => {
    const dir = scratchDir('remote-entry-')
    const port = await freePort()
    writeSetting(dir, setting(port, []), 0o644)
    const entry = await start(dir)
    expect(entry.status()).toEqual({
      on: false, listening: false, port: null, host: null,
      error: expect.stringContaining('other users'),
      refused: { host: 0, funnel: 0, login: 0, path: 0, origin: 0, device: 0, route: 0 },
    })
  })
})
