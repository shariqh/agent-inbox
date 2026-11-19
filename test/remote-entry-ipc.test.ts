// Settings → Other devices, main's half (#617, PR 2d): electron/remote-entry-ipc.cjs gates the
// channels like Settings → Links, builds what the panel draws from the hub controller, shows the
// notifications, guards the login item and stops the controller on quit; electron/main.cjs wires
// it, and electron/setup-preload.cjs's agentInboxRemoteEntry rebuilds every answer. No Electron
// is started: the controller is a stub, and main's block runs against fakes.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import ipc from '../electron/remote-entry-ipc.cjs'
import remoteEntry from '../electron/remote-entry.cjs'
import * as words from '../public/remote-words.js'
import { removeScratchDirs, scratchDir } from './scratch.js'
import { cliExists, fakeTailscale, goodServe, selfStatus } from './remote-entry-fixtures.js'

const REPO = join(import.meta.dirname, '..')
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8')

const HOST = 'hub.example.ts.net'
const LOGIN = 'owner@example.com'
const HASH = 'f'.repeat(64)
const TOKEN = 'owner-token-0123456789abcdef'
const CODE_ID = 'c0de0000000000a1'
const DIGEST = 'a'.repeat(64)
const A = 'aaaaaaaaaaaaaaaa'
const CODE = '7K3QX-9M2PD'

type Json = Record<string, unknown>

// what review() says changed: labels and booleans only (review round 1, item 7)
const CHANGES = {
  unknown: false, missing: false, unreadable: false, switched: 'on', address: false, account: true, port: false,
  added: ['desk'], removed: [], keyChanged: ['laptop'], unreadableAdded: 0, unreadableRemoved: 1,
}

/** A controller stub whose every answer also carries what must never reach a page. */
function controllerStub(over: Json = {}) {
  const leak = { logins: [LOGIN], login: LOGIN, secretSha256: HASH, ownerToken: TOKEN, codeId: CODE_ID }
  const view = {
    available: true, enabled: true, host: HOST, port: 4320, viewerPort: 4319, logins: [LOGIN],
    devices: [{ id: A, label: 'laptop', pairedAt: '2026-11-20T09:00:00.000Z', secretSha256: HASH }], unreadableDevices: 1, problem: null,
  }
  const calls: string[] = []
  const state: Json = {
    view, serve: { answer: { ok: false, reason: 'no_handler', present: true, login: LOGIN }, at: 5 },
    self: { ok: true, host: HOST, loginAllowed: true, at: 5, login: LOGIN }, flag: false, flagDigest: 'b'.repeat(64),
    stopped: { reason: 'funnel', at: 100, off: true, willResume: false, login: LOGIN }, removalHint: 'tailscale serve --https=443 off',
    wanted: true, stateSaved: false, resume: { waiting: 'serve_not_ok:funnel', nextAt: 200, codeId: CODE_ID }, needsOwner: null, listening: true,
    listenError: null, ...leak,
  }
  const c = {
    port: 4320,
    calls,
    raw: state,
    review: vi.fn(async () => { calls.push('review'); return { view, digest: state.reviewDigest ?? DIGEST, flag: true, changes: { ...CHANGES, ...leak }, ...leak } }),
    turnOn: vi.fn(async (options?: unknown) => { calls.push(options ? `turnOn ${JSON.stringify(options)}` : 'turnOn'); return { ok: true, view, voidedCode: true, devicesRemoved: 2, droppedEntries: 1, listening: false, ...leak } }),
    // #617 PR 2d: get() reads the viewer's status first, so `listening` is fresh; never handed on
    entryStatus: vi.fn(async () => { calls.push('entryStatus'); return { ok: true, status: { on: true, listening: true, port: 4320, paired: [{ device: A, codeId: CODE_ID }] }, ...leak } }),
    turnOff: vi.fn(async () => { calls.push('turnOff'); return { ok: true, view, voidedCode: false, ...leak } }),
    removeDevice: vi.fn(async (id: unknown) => { calls.push(`removeDevice ${String(id)}`); return { ok: true, view, voidedCode: true, droppedEntries: 0, ...leak } }),
    clearUnreadable: vi.fn(async () => { calls.push('clearUnreadable'); return { ok: true, view, voidedCode: false, removed: 1, ...leak } }),
    repairPermissions: vi.fn(async () => { calls.push('repairPermissions'); return { ok: true, view, voidedCode: false, devicesRemoved: 3, ...leak } }),
    acknowledge: vi.fn(async (digest: unknown) => { calls.push(`acknowledge ${String(digest)}`); return { ok: false, reason: 'changed', ...leak } }),
    selfTest: vi.fn(async () => { calls.push('selfTest'); return { ok: false, reason: 'no_device_count', rose: 'login', ...leak } }),
    requestCode: vi.fn(async () => { calls.push('requestCode'); return { ok: true, code: CODE, expiresAt: '2026-11-20T09:10:00.000Z', ...leak } }),
    recheckHint: vi.fn(async () => { calls.push('recheckHint') }),
    stop: vi.fn(() => { calls.push('stop') }),
    settled: vi.fn(async () => { calls.push('settled') }),
    ...over,
    state: vi.fn(async () => { calls.push('state'); return state }),
  } as Json & { calls: string[] }
  return c
}

const loginItem = (available: boolean, openAtLogin = false) => ({
  read: vi.fn(() => ({ available, openAtLogin, needsApproval: false })),
  set: vi.fn((value: boolean) => (available ? { ok: true, openAtLogin: value } : { ok: false, reason: 'unavailable' })),
})

function panelOf(c = controllerStub(), opts: Json = {}) {
  const changed = vi.fn()
  const clock = { now: 50 }
  const panel = ipc.createRemoteEntryPanel({ controller: c, loginItem: (opts.loginItem as ReturnType<typeof loginItem> | undefined) ?? loginItem(true, true), changed, now: () => clock.now })
  return { panel, c, changed, clock }
}

const secrets = (value: unknown) => {
  const text = JSON.stringify(value)
  // keys as JSON writes them: `loginItem` is the panel's own field
  return [LOGIN, HASH, TOKEN, CODE_ID, '"secretSha256":', '"logins":', '"login":', '"codeId":', '"ownerToken":'].filter((needle) => text.includes(needle))
}

describe('what get() hands the panel', () => {
  it('builds every field from one status read, one review() and one state(), and nothing else', async () => {
    const { panel, c } = panelOf()
    const view = await panel.get()
    expect(c.calls).toEqual(['entryStatus', 'review', 'state'])
    expect(view).toEqual({
      available: true, enabled: true, host: HOST, port: 4320,
      devices: [{ id: A, label: 'laptop', pairedAt: '2026-11-20T09:00:00.000Z' }], unreadableDevices: 1, problem: null,
      flag: true, digest: DIGEST, wanted: true, stopped: { reason: 'funnel', willResume: false }, resume: { waiting: 'serve_not_ok:funnel', nextAt: 200 },
      needsOwner: null, stateSaved: false, serve: { ok: false, reason: 'no_handler' }, removalHint: 'tailscale serve --https=443 off',
      command: 'tailscale serve --bg 4320', loginItem: { available: true, openAtLogin: true, needsApproval: false }, listening: true,
      listenError: null, changes: CHANGES, refusal: null, inboxUnreachable: false,
    })
  })

  // review round 2, item 5
  it('says this Inbox is unreachable after three status reads in a row fail, and not before', async () => {
    let fails = 0
    const c = controllerStub({ entryStatus: vi.fn(async () => (fails > 0 ? (fails -= 1, { ok: false, reason: 'unreachable' }) : { ok: true, status: {} })) })
    const { panel } = panelOf(c)
    fails = 3
    expect((await panel.get()).inboxUnreachable).toBe(false)
    expect((await panel.get()).inboxUnreachable).toBe(false)
    expect((await panel.get()).inboxUnreachable).toBe(true)
    expect((await panel.get()).inboxUnreachable).toBe(false)
    const throwing = controllerStub({ entryStatus: vi.fn(async () => { throw new Error('x') }) })
    const other = panelOf(throwing)
    for (let i = 0; i < 2; i += 1) await other.panel.get()
    expect((await other.panel.get()).inboxUnreachable).toBe(true)
  })

  // review round 1, item 12: unknown reads as not listening
  it('is not listening, and names no bind failure, when the status read fails, whatever the controller kept', async () => {
    const c = controllerStub({ entryStatus: vi.fn(async () => ({ ok: false, reason: 'unreachable' })) })
    ;(c.raw as Json).listenError = 'port_in_use'
    const { panel } = panelOf(c)
    expect(await panel.get()).toMatchObject({ listening: false, listenError: null })
  })

  it('passes the viewer\'s bind failure as its word, and nothing else', async () => {
    const c = controllerStub()
    const { panel } = panelOf(c)
    for (const [value, expected] of [['port_in_use', 'port_in_use'], ['cannot_listen', 'cannot_listen'], ['EADDRINUSE', null], [null, null]] as const) {
      ;(c.raw as Json).listenError = value
      expect((await panel.get()).listenError, String(value)).toBe(expected)
    }
  })

  // review round 1, item 11: signed out and not installed are not "check that Tailscale is running"
  it('names what Tailscale said while a pause waits on a reading of it', async () => {
    const c = controllerStub()
    const raw = c.raw as Json
    raw.resume = { waiting: 'tailscale_unreadable', nextAt: 1 }
    raw.self = { ok: false, reason: 'no_login', at: 1 }
    const { panel } = panelOf(c)
    expect((await panel.get()).resume).toEqual({ waiting: 'self_not_ok:no_login', nextAt: 1 })
    raw.self = { ok: true, host: HOST, loginAllowed: true, at: 1 }
    expect((await panel.get()).resume).toEqual({ waiting: 'tailscale_unreadable', nextAt: 1 })
    raw.resume = { waiting: 'tailscale_not_running', nextAt: 1 }
    raw.self = { ok: false, reason: 'no_login', at: 1 }
    expect((await panel.get()).resume).toEqual({ waiting: 'tailscale_not_running', nextAt: 1 })
  })

  it('no changes while nothing is flagged', async () => {
    const c = controllerStub({ review: vi.fn(async () => ({ view: { ...(c.raw as Json).view as Json }, digest: DIGEST, flag: false, changes: null })) })
    const { panel } = panelOf(c)
    expect((await panel.get()).changes).toBeNull()
  })

  it('says listening only when the last status read said so', async () => {
    const c = controllerStub()
    const { panel } = panelOf(c)
    for (const [value, expected] of [[true, true], [false, false], [null, false], ['yes', false]] as const) {
      ;(c.raw as Json).listening = value
      expect((await panel.get()).listening, String(value)).toBe(expected)
    }
  })

  it('never holds a login, a hash, the owner token or a code id, from any answer the controller gives', async () => {
    const { panel } = panelOf()
    expect(secrets(await panel.get())).toEqual([])
    for (const name of ['turnOn', 'turnOff', 'clearUnreadable', 'repairPermissions', 'test', 'addDevice']) {
      expect(secrets(await (panel as unknown as Record<string, () => Promise<unknown>>)[name]!()), name).toEqual([])
    }
    expect(secrets(await panel.removeDevice(A))).toEqual([])
    expect(secrets(await panel.acknowledge(DIGEST))).toEqual([])
    expect(secrets(await panel.setOpenAtLogin(true))).toEqual([])
  })

  it('a Serve answer that is ok carries no reason; none read yet is null', async () => {
    const c = controllerStub()
    const s = c.raw as Json
    s.serve = { answer: { ok: true }, at: 1 }
    const { panel } = panelOf(c)
    expect((await panel.get()).serve).toEqual({ ok: true })
    s.serve = null
    expect((await panel.get()).serve).toBeNull()
  })

  it('forgets a stop once the owner switched sharing on or off after it', async () => {
    const { panel, clock } = panelOf()
    expect((await panel.get()).stopped).toEqual({ reason: 'funnel', willResume: false })
    clock.now = 150
    await panel.turnOff()
    expect((await panel.get()).stopped).toBeNull()
  })

  it('maps each operation\'s answer to its own few fields, and pings the page after each', async () => {
    const { panel, c, changed } = panelOf()
    expect(await panel.turnOn()).toEqual({ ok: true, voidedCode: true, devicesRemoved: 2, droppedEntries: 1, listening: false })
    expect(await panel.turnOff()).toEqual({ ok: true, voidedCode: false })
    expect(await panel.removeDevice(A)).toEqual({ ok: true, voidedCode: true })
    expect(await panel.clearUnreadable()).toEqual({ ok: true, voidedCode: false, removed: 1 })
    expect(await panel.repairPermissions()).toEqual({ ok: true, voidedCode: false, devicesRemoved: 3 })
    expect(await panel.acknowledge(DIGEST)).toEqual({ ok: false, reason: 'changed' })
    expect(await panel.test()).toEqual({ ok: false, reason: 'no_device_count', rose: 'login' })
    expect(await panel.addDevice()).toEqual({ ok: true, code: CODE, expiresAt: '2026-11-20T09:10:00.000Z' })
    expect(await panel.setOpenAtLogin(false)).toEqual({ ok: true, openAtLogin: false })
    expect(c.calls).toEqual(['turnOn', 'turnOff', `removeDevice ${A}`, 'clearUnreadable', 'repairPermissions', `acknowledge ${DIGEST}`, 'selfTest', 'requestCode'])
    expect(changed).toHaveBeenCalledTimes(9)
  })

  it('passes a refusal on as its reason and step', async () => {
    const c = controllerStub({ turnOn: vi.fn(async () => ({ ok: false, reason: 'no_handler', step: 'serve', login: LOGIN })) })
    const { panel } = panelOf(c)
    expect(await panel.turnOn()).toEqual({ ok: false, reason: 'no_handler', step: 'serve' })
  })

  // review round 1, item 4: the page keeps no refusal of its own; get() carries the last one
  it('get() carries the last refused switch-on until a later operation works or the state changes', async () => {
    const c = controllerStub({ turnOn: vi.fn(async () => ({ ok: false, reason: 'no_handler', step: 'serve' })) })
    const raw = c.raw as Json
    const { panel, clock } = panelOf(c)
    expect((await panel.get()).refusal).toBeNull()
    clock.now = 70
    await panel.turnOn()
    expect((await panel.get()).refusal).toEqual({ reason: 'no_handler', step: 'serve', devices: null, at: 70 })
    expect((await panel.get()).refusal).toEqual({ reason: 'no_handler', step: 'serve', devices: null, at: 70 })
    // a failed operation leaves it
    await panel.acknowledge(DIGEST)
    expect((await panel.get()).refusal).not.toBeNull()
    // the file changed: gone
    raw.reviewDigest = 'c'.repeat(64)
    expect((await panel.get()).refusal).toBeNull()
    await panel.turnOn()
    expect((await panel.get()).refusal).not.toBeNull()
    // a later operation that works: gone
    await panel.removeDevice(A)
    expect((await panel.get()).refusal).toBeNull()
  })

  // review round 2, item 1: anything the panel shows, and 2 minutes at the latest
  it('a refusal goes when anything the panel shows changes, not only the file, and after 2 minutes', async () => {
    const c = controllerStub({ turnOn: vi.fn(async () => ({ ok: false, reason: 'not_running', step: 'self' })) })
    const raw = c.raw as Json
    const { panel, clock } = panelOf(c)
    const changes: Array<[string, () => void]> = [
      ['a pause', () => { raw.resume = { waiting: 'tailscale_not_running', nextAt: 1 } }],
      ['listening', () => { raw.listening = false }],
      ['a stop', () => { raw.stopped = { reason: 'not_running', at: 9_000_000, off: true, willResume: true } }],
      ['needsOwner', () => { raw.needsOwner = 'identity_changed' }],
    ]
    for (const [name, change] of changes) {
      await panel.turnOn()
      expect((await panel.get()).refusal, name).not.toBeNull()
      change()
      expect((await panel.get()).refusal, name).toBeNull()
    }
    // nothing shown changes, as when Tailscale comes up while sharing is off: 2 minutes, then gone
    clock.now = 1_000
    await panel.turnOn()
    expect((await panel.get()).refusal).not.toBeNull()
    clock.now += 119_000
    expect((await panel.get()).refusal).not.toBeNull()
    clock.now += 2_000
    expect((await panel.get()).refusal).toBeNull()
    // and a pause's next try moving is not a change
    await panel.turnOn()
    await panel.get()
    raw.resume = { ...(raw.resume as Json), nextAt: 99 }
    expect((await panel.get()).refusal).not.toBeNull()
  })

  // the reviewer's V4, against the real controller: Tailscale comes up after a refused switch-on
  it('a switch-on refused while Tailscale was down does not stand in for the present 10 minutes later', async () => {
    const dir = scratchDir('remote-panel-')
    const clock = { now: Date.parse('2026-11-20T09:00:00.000Z') }
    let self: unknown = { ...selfStatus(), BackendState: 'Stopped' }
    const status = {
      on: false, listening: false, port: null, host: null, error: null, codePending: false, paired: [],
      refused: { host: 0, funnel: 0, login: 0, path: 0, origin: 0, device: 0, route: 0, pair: 0 },
    }
    const c = remoteEntry.createRemoteEntry({
      isPackaged: true, env: { AGENT_INBOX_DB: join(dir, 'inbox.db') }, ownerToken: 't'.repeat(40),
      execFile: fakeTailscale({ self: () => self, serve: goodServe(4320) }), exists: cliExists,
      fetch: async (url: string) => { if (url.endsWith('/api/remote-entry')) return Response.json(status); throw new TypeError('fetch failed') },
      now: () => clock.now, sleep: async (ms: number) => { clock.now += ms }, setInterval: () => 0, clearInterval: () => {},
    })
    const panel = ipc.createRemoteEntryPanel({ controller: c, loginItem: loginItem(false), now: () => clock.now })
    c.start()
    await c.tick()
    expect(await panel.turnOn()).toEqual({ ok: false, reason: 'not_running', step: 'self' })
    expect((await panel.get()).refusal).toMatchObject({ reason: 'not_running' })
    self = selfStatus()
    clock.now += 600_000
    await c.tick()
    expect((await panel.get()).refusal).toBeNull()
    c.stop()
    removeScratchDirs()
  })

  // review round 2, item 2
  it('tells the notifier when an owner\'s switch works, and only then', async () => {
    const switched = vi.fn()
    const failing = controllerStub({
      turnOn: vi.fn(async () => ({ ok: false, reason: 'no_handler', step: 'serve' })),
      turnOff: vi.fn(async () => ({ ok: false, reason: 'write_failed' })),
    })
    const bad = ipc.createRemoteEntryPanel({ controller: failing, loginItem: loginItem(true), switched })
    await bad.turnOn()
    await bad.turnOff()
    expect(switched).not.toHaveBeenCalled()
    const c = controllerStub()
    const panel = ipc.createRemoteEntryPanel({ controller: c, loginItem: loginItem(true), switched })
    await panel.removeDevice(A)
    await panel.test()
    await panel.addDevice()
    await panel.clearUnreadable()
    expect(switched).not.toHaveBeenCalled()
    await panel.turnOn()
    await panel.turnOnRemovingDevices()
    await panel.turnOff()
    await panel.repairPermissions()
    expect(switched).toHaveBeenCalledTimes(4)
  })

  it('a problem with the file that appears after a refusal clears it too', async () => {
    const c = controllerStub({ turnOn: vi.fn(async () => ({ ok: false, reason: 'no_handler', step: 'serve' })) })
    const { panel } = panelOf(c)
    await panel.turnOn()
    expect((await panel.get()).refusal).not.toBeNull()
    ;((c.raw as Json).view as Json).problem = 'open_to_others'
    expect((await panel.get()).refusal).toBeNull()
  })

  // review round 1, item 8
  it('a refusal that would remove paired Macs says how many; switching on anyway asks the controller to remove them', async () => {
    const c = controllerStub({
      turnOn: vi.fn(async (options?: unknown) => {
        c.calls.push(options ? `turnOn ${JSON.stringify(options)}` : 'turnOn')
        return options ? { ok: true, voidedCode: false, devicesRemoved: 2, droppedEntries: 0, listening: true } : { ok: false, reason: 'would_remove_devices', step: 'file', devices: 2 }
      }),
    })
    const { panel, clock } = panelOf(c)
    clock.now = 90
    expect(await panel.turnOn()).toEqual({ ok: false, reason: 'would_remove_devices', step: 'file', devices: 2 })
    expect((await panel.get()).refusal).toEqual({ reason: 'would_remove_devices', step: 'file', devices: 2, at: 90 })
    expect(await panel.turnOnRemovingDevices()).toEqual({ ok: true, voidedCode: false, devicesRemoved: 2, droppedEntries: 0, listening: true })
    expect(c.calls).toContain('turnOn {"removeDevices":true}')
    expect((await panel.get()).refusal).toBeNull()
  })

  // review round 1, item 6
  it('recheck reads Serve again for the removal hint, and pings', async () => {
    const { panel, c, changed } = panelOf()
    expect(await panel.recheck()).toEqual({ ok: true })
    expect(c.calls).toEqual(['recheckHint'])
    expect(changed).toHaveBeenCalledOnce()
  })
})

describe('the IPC channels', () => {
  const CHANNELS: Array<[string, unknown[], unknown[][]]> = [
    ['agent-inbox:remote-entry', [], [['x']]],
    ['agent-inbox:remote-entry-turn-on', [], [[true]]],
    ['agent-inbox:remote-entry-turn-off', [], [[1]]],
    ['agent-inbox:remote-entry-remove-device', [A], [[], ['laptop'], [7], [A, A], [A.toUpperCase()]]],
    ['agent-inbox:remote-entry-clear-unreadable', [], [['x']]],
    ['agent-inbox:remote-entry-repair', [], [[{}]]],
    ['agent-inbox:remote-entry-acknowledge', [DIGEST], [[], [7], ['abc'], [DIGEST, 'x'], [DIGEST.toUpperCase()]]],
    ['agent-inbox:remote-entry-test', [], [['now']]],
    ['agent-inbox:remote-entry-add-device', [], [['laptop']]],
    ['agent-inbox:remote-entry-open-at-login', [true], [[], ['true'], [1], [true, false]]],
    ['agent-inbox:remote-entry-turn-on-remove-devices', [], [[true]]],
    ['agent-inbox:remote-entry-recheck', [], [['x']]],
  ]

  function world({ platform = 'darwin', trusted = true, owned = true, panel = true, settled = Promise.resolve() as Promise<unknown> } = {}) {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const p = panelOf()
    const settle = vi.fn(() => settled)
    ipc.registerRemoteEntryIpc({
      ipcMain: { handle: (channel: string, fn: unknown) => handlers.set(channel, fn as (event: unknown, ...args: unknown[]) => unknown) },
      platform, panel: () => (panel ? p.panel : null), settled: settle, isTrusted: () => trusted, isOwned: () => owned,
    })
    const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: { id: 7 } }, ...args)
    return { handlers, call, p, settle }
  }

  it('registers exactly these channels', () => {
    expect([...world().handlers.keys()].sort()).toEqual(CHANNELS.map(([channel]) => channel).sort())
    expect(Object.values(ipc.CHANNELS).sort()).toEqual(CHANNELS.map(([channel]) => channel).sort())
    expect(ipc.CHANGED).toBe('agent-inbox:remote-entry-changed')
  })

  it('refuses a wrong argument count or type before anything else', async () => {
    for (const [channel, , bad] of CHANNELS) {
      for (const args of bad) {
        const w = world()
        expect(await w.call(channel, ...args), `${channel} ${JSON.stringify(args)}`).toEqual({ available: false })
        expect(w.settle).not.toHaveBeenCalled()
        expect(w.p.c.calls).toEqual([])
      }
    }
  })

  it('refuses an untrusted sender, after the re-proof in flight', async () => {
    for (const [channel, args] of CHANNELS) {
      const w = world({ trusted: false })
      expect(await w.call(channel, ...args), channel).toEqual({ available: false })
      expect(w.settle).toHaveBeenCalledOnce()
      expect(w.p.c.calls).toEqual([])
    }
  })

  it('says unsupported on any other platform, and unowned for a viewer this app did not start', async () => {
    for (const [channel, args] of CHANNELS) {
      const linux = world({ platform: 'linux' })
      expect(await linux.call(channel, ...args), channel).toEqual({ available: false, reason: 'unsupported' })
      for (const w of [world({ owned: false }), world({ panel: false })]) {
        expect(await w.call(channel, ...args), channel).toEqual({ available: false, reason: 'unowned' })
        expect(w.p.c.calls).toEqual([])
      }
    }
  })

  it('answers only once the re-proof has settled', async () => {
    let finish!: () => void
    const w = world({ settled: new Promise<void>((resolve) => { finish = resolve }) })
    let answered: unknown = 'pending'
    void Promise.resolve(w.call('agent-inbox:remote-entry')).then((value) => { answered = value })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(answered).toBe('pending')
    expect(w.p.c.calls).toEqual([])
    finish()
    await vi.waitFor(() => expect(answered).toMatchObject({ available: true }))
  })

  it('passes each checked argument through to the panel', async () => {
    const w = world()
    for (const [channel, args] of CHANNELS) await w.call(channel, ...args)
    expect(w.p.c.calls).toEqual([
      'entryStatus', 'review', 'state', 'turnOn', 'turnOff', `removeDevice ${A}`, 'clearUnreadable', 'repairPermissions', `acknowledge ${DIGEST}`, 'selfTest', 'requestCode',
      'turnOn {"removeDevices":true}', 'recheckHint',
    ])
  })
})

describe('notifications', () => {
  function notifier({ start = 1_000_000, started = false } = {}) {
    const shown: Array<{ title: string; body: string }> = []
    const changed = vi.fn()
    const clock = { now: start }
    const timers: Array<{ fn: () => void; at: number; cleared: boolean }> = []
    const n = ipc.createRemoteNotifier({
      show: (note: { title: string; body: string }) => { shown.push(note) }, now: () => clock.now, words, changed,
      setTimeout: (fn: () => void, ms: number) => { const timer = { fn, at: clock.now + ms, cleared: false }; timers.push(timer); return timer },
      clearTimeout: (timer: unknown) => { (timer as { cleared: boolean }).cleared = true },
    })
    if (started) n.started()
    /** moves the clock, firing the timers that come due */
    const advance = async (ms: number) => {
      clock.now += ms
      for (const timer of timers) if (!timer.cleared && timer.at <= clock.now) { timer.cleared = true; timer.fn() }
      await flush()
    }
    return { n, shown, changed, clock, advance }
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('says paused (with what to do), stopped, resumed, paired and changed outside, as plain text about your other Macs', async () => {
    const { n, shown, changed } = notifier()
    n.onStopped('funnel', { off: true, willResume: true })
    n.onStopped('identity_changed', { off: true, willResume: false })
    n.onResumed()
    n.onPaired('<b>laptop</b>')
    n.onOutsideChange()
    await flush()
    expect(shown).toEqual([
      { title: 'Agent Inbox paused sharing with your other Macs', body: 'Paused: Tailscale Funnel is on for this Mac. Open Settings → Other devices to see what to do.' },
      { title: 'Agent Inbox stopped sharing with your other Macs', body: 'This Mac’s Tailscale name or account changed. Open Settings → Other devices to see what to do.' },
      { title: 'Agent Inbox is sharing with your other Macs again', body: '' },
      { title: 'A Mac was paired', body: '<b>laptop</b> can now use this Inbox.' },
      { title: 'Agent Inbox’s sharing settings were changed outside the app', body: 'Open Settings → Other devices to review.' },
    ])
    expect(changed).toHaveBeenCalledTimes(5)
  })

  // review round 1, item 1: the reason is the family's, as on the panel, for every reason word
  it('words every pause and stop from the family the panel uses, never "when Tailscale is ready"', async () => {
    const types = read('electron/remote-entry.d.cts')
    const pick = (name: string) => {
      const at = types.indexOf(`export type ${name} =`)
      return [...types.slice(at, types.indexOf('\n\n', at)).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!)
    }
    const reasons = [...pick('SelfReason'), ...pick('ServeReason'), ...pick('StopReason')]
    expect(reasons).toContain('not_wanted')
    for (const reason of reasons) {
      for (const willResume of [true, false]) {
        const { n, shown } = notifier()
        n.onStopped(reason, { off: true, willResume })
        await flush()
        const why = words.familyWords(words.reasonFamily('stop', reason), { port: 4320 }).why
        expect(shown, reason).toHaveLength(1)
        expect(shown[0]!.body, reason).toBe(willResume
          ? `Paused: ${why}. Open Settings → Other devices to see what to do.`
          : `${why[0]!.toUpperCase()}${why.slice(1)}. Open Settings → Other devices to see what to do.`)
        expect(shown[0]!.body).not.toMatch(/when Tailscale is ready|your other devices/)
      }
    }
  })

  // review round 1, item 2
  it('quiets only a notice identical to the last one and under 10 minutes old; the opposite kind resets it', async () => {
    const { n, shown, clock } = notifier()
    n.onStopped('funnel', { off: true, willResume: true })
    clock.now += 60_000
    n.onResumed()
    clock.now += 60_000
    n.onStopped('funnel', { off: true, willResume: true })
    n.onStopped('funnel', { off: true, willResume: true })
    n.onStopped('not_running', { off: true, willResume: true })
    n.onStopped('not_running', { off: true, willResume: false })
    await flush()
    expect(shown.map((note) => note.title)).toEqual([
      'Agent Inbox paused sharing with your other Macs', 'Agent Inbox is sharing with your other Macs again',
      'Agent Inbox paused sharing with your other Macs', 'Agent Inbox paused sharing with your other Macs', 'Agent Inbox stopped sharing with your other Macs',
    ])
    clock.now += 10 * 60_000
    n.onStopped('not_running', { off: true, willResume: false })
    await flush()
    expect(shown).toHaveLength(6)
  })

  it('never quiets a pairing or an outside change', async () => {
    const { n, shown, changed } = notifier()
    n.onPaired('laptop')
    n.onPaired('desk')
    n.onOutsideChange()
    n.onOutsideChange()
    await flush()
    expect(shown.map((note) => note.body)).toEqual(['laptop can now use this Inbox.', 'desk can now use this Inbox.', 'Open Settings → Other devices to review.', 'Open Settings → Other devices to review.'])
    expect(changed).toHaveBeenCalledTimes(4)
  })

  it('at app start, a pause that resumes within 2 minutes notifies nothing at all', async () => {
    const { n, shown, advance } = notifier({ started: true })
    n.onStopped('not_running', { off: true, willResume: true })
    await advance(90_000)
    n.onResumed()
    await advance(120_000)
    expect(shown).toEqual([])
  })

  it('at app start, a pause still standing after 2 minutes is then notified; a stop at once', async () => {
    const { n, shown, advance } = notifier({ started: true })
    n.onStopped('not_running', { off: true, willResume: true })
    await advance(119_000)
    expect(shown).toEqual([])
    await advance(1_000)
    expect(shown.map((note) => note.body)).toEqual(['Paused: Tailscale is not running. Open Settings → Other devices to see what to do.'])
    const later = notifier({ started: true })
    later.n.onStopped('identity_changed', { off: true, willResume: false })
    await flush()
    expect(later.shown).toHaveLength(1)
    // after the first 2 minutes, a pause is notified at once
    await later.advance(121_000)
    later.n.onStopped('funnel', { off: true, willResume: true })
    await flush()
    expect(later.shown).toHaveLength(2)
  })

  // review round 2, item 2: the owner's own switch resets what the notifier holds and remembers
  it('a pause held at start is dropped when the owner switches on by hand, so it never fires while sharing is on', async () => {
    const { n, shown, advance } = notifier({ started: true })
    n.onStopped('not_running', { off: true, willResume: true })
    await advance(60_000)
    n.reset()
    await advance(120_000)
    expect(shown).toEqual([])
  })

  it('after the owner switches by hand, the same pause is news again', async () => {
    const { n, shown, clock } = notifier()
    n.onStopped('funnel', { off: true, willResume: true })
    clock.now += 60_000
    n.reset()
    clock.now += 5 * 60_000
    n.onStopped('funnel', { off: true, willResume: true })
    await flush()
    expect(shown.map((note) => note.title)).toEqual(['Agent Inbox paused sharing with your other Macs', 'Agent Inbox paused sharing with your other Macs'])
  })

  it('a notice that throws, or words that never load, stop nothing', async () => {
    const changed = vi.fn()
    const n = ipc.createRemoteNotifier({ show: () => { throw new Error('no notifications') }, words: Promise.reject(new Error('gone')), changed })
    n.onStopped('funnel', { off: true, willResume: false })
    n.onPaired('laptop')
    await flush()
    expect(changed).toHaveBeenCalledTimes(2)
  })
})

describe('Open Agent Inbox at login', () => {
  it('a checkout build answers unavailable and never reads or sets the login item', () => {
    const app = { isPackaged: false, getLoginItemSettings: vi.fn(() => ({ openAtLogin: true })), setLoginItemSettings: vi.fn() }
    const item = ipc.loginItemFor({ app, platform: 'darwin' })
    expect(item.read()).toEqual({ available: false, openAtLogin: false, needsApproval: false })
    expect(item.set(true)).toEqual({ ok: false, reason: 'unavailable' })
    expect(app.setLoginItemSettings).not.toHaveBeenCalled()
    expect(app.getLoginItemSettings).not.toHaveBeenCalled()
    const linux = { ...app, isPackaged: true }
    expect(ipc.loginItemFor({ app: linux, platform: 'linux' }).set(true)).toEqual({ ok: false, reason: 'unavailable' })
    expect(app.setLoginItemSettings).not.toHaveBeenCalled()
  })

  it('the packaged app on macOS reads and sets the app\'s own setting, and reads it back', () => {
    let on = false
    const app = {
      isPackaged: true,
      getLoginItemSettings: vi.fn(() => ({ openAtLogin: on, wasOpenedAtLogin: false })),
      setLoginItemSettings: vi.fn((settings: { openAtLogin: boolean }) => { on = settings.openAtLogin }),
    }
    const item = ipc.loginItemFor({ app, platform: 'darwin' })
    expect(item.read()).toEqual({ available: true, openAtLogin: false, needsApproval: false })
    expect(item.set(true)).toEqual({ ok: true, openAtLogin: true })
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true })
    expect(item.set('yes' as unknown as boolean)).toEqual({ ok: false, reason: 'unavailable' })
    expect(app.setLoginItemSettings).toHaveBeenCalledOnce()
    app.setLoginItemSettings.mockImplementation(() => { throw new Error('denied') })
    expect(item.set(false)).toEqual({ ok: false, reason: 'failed' })
  })

  // review round 1, item 12
  it('says when macOS wants the login item approved', () => {
    const app = { isPackaged: true, getLoginItemSettings: vi.fn(() => ({ openAtLogin: true, status: 'requires-approval' })), setLoginItemSettings: vi.fn() }
    expect(ipc.loginItemFor({ app, platform: 'darwin' }).read()).toEqual({ available: true, openAtLogin: true, needsApproval: true })
    app.getLoginItemSettings.mockReturnValue({ openAtLogin: true, status: 'enabled' })
    expect(ipc.loginItemFor({ app, platform: 'darwin' }).read()).toEqual({ available: true, openAtLogin: true, needsApproval: false })
  })
})

describe('quitting', () => {
  it('stops the watch, then waits for the state store, at most a bounded time', async () => {
    const c = controllerStub()
    await ipc.stopRemoteEntry(c)
    expect(c.calls).toEqual(['stop', 'settled'])
    const never = controllerStub({ settled: vi.fn(() => new Promise(() => {})) })
    const timers: Array<[() => void, number]> = []
    let done = false
    void ipc.stopRemoteEntry(never, { setTimeout: (fn: () => void, ms: number) => { timers.push([fn, ms]); return 0 } }).then(() => { done = true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(done).toBe(false)
    expect(timers.map(([, ms]) => ms)).toEqual([5000])
    timers[0]![0]()
    await vi.waitFor(() => expect(done).toBe(true))
    const throwing = controllerStub({ stop: vi.fn(() => { throw new Error('x') }), settled: vi.fn(async () => { throw new Error('y') }) })
    await expect(ipc.stopRemoteEntry(throwing)).resolves.toBeUndefined()
  })
})

describe('the watch\'s pings', () => {
  it('pings the page only when what get() shows changed', async () => {
    const ticks: Array<() => void> = []
    const views = [{ a: 1 }, { a: 1 }, { a: 2 }, { a: 2 }]
    const panel = { get: vi.fn(async () => views.shift() ?? { a: 2 }) }
    const changed = vi.fn()
    const watch = ipc.watchRemoteEntry({ panel, changed, setInterval: (fn: () => void) => { ticks.push(fn); return 1 }, clearInterval: vi.fn() })
    for (let i = 0; i < 4; i += 1) {
      ticks[0]!()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(panel.get).toHaveBeenCalledTimes(4)
    // the first read is the baseline: the page drew it itself
    expect(changed).toHaveBeenCalledTimes(1)
    watch.stop()
  })

  // #637: the same read tells main whether the update link reports; no second timer, no second read
  it('hands every view it reads to onView, changed or not, and a failing onView does not stop the watch', async () => {
    const ticks: Array<() => void> = []
    const views = [{ a: 1 }, { a: 1 }, { a: 2 }]
    const panel = { get: vi.fn(async () => views.shift()) }
    const seen: unknown[] = []
    const setIntervalFn = vi.fn((fn: () => void) => { ticks.push(fn); return 1 })
    ipc.watchRemoteEntry({ panel, changed: vi.fn(), onView: (view: unknown) => { seen.push(view); throw new Error('no') }, setInterval: setIntervalFn, clearInterval: vi.fn() })
    for (let i = 0; i < 3; i += 1) {
      ticks[0]!()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(setIntervalFn).toHaveBeenCalledOnce()
    expect(panel.get).toHaveBeenCalledTimes(3)
    expect(seen).toEqual([{ a: 1 }, { a: 1 }, { a: 2 }])
  })

  // review round 1, item 12: a pause's next try moves every 5 seconds; the page shows it to the minute
  it('does not ping for a next try that moved within the same minute', async () => {
    const ticks: Array<() => void> = []
    const at = Date.parse('2026-11-20T09:00:00.000Z')
    const views = [at + 5_000, at + 10_000, at + 30_000, at + 65_000].map((nextAt) => ({ resume: { waiting: 'tailscale_not_running', nextAt } }))
    const panel = { get: vi.fn(async () => views.shift()) }
    const changed = vi.fn()
    ipc.watchRemoteEntry({ panel, changed, setInterval: (fn: () => void) => { ticks.push(fn); return 1 }, clearInterval: vi.fn() })
    for (let i = 0; i < 4; i += 1) {
      ticks[0]!()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(changed).toHaveBeenCalledTimes(1)
  })
})

// ── main.cjs's block, run against fakes ─────────────────────────────────────

describe('main wires one controller, only on macOS for the viewer it owns', () => {
  const main = read('electron/main.cjs')
  const start = main.indexOf('// ── sharing this Inbox with your other Macs (#617, PR 2d)')
  const end = main.indexOf('// ── end of sharing this Inbox with your other Macs')

  function world({ platform = 'darwin', owned = true, isPackaged = true, notifications = false } = {}) {
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const made: Json[] = []
    // #637: the paired Macs' labels, for the update link's notice
    const controller = controllerStub({ view: vi.fn(async () => ({ devices: [{ id: A, label: 'laptop', pairedAt: null }] })) })
    const handlers = new Map<string, unknown>()
    const sent: string[] = []
    const app = { isPackaged, getVersion: () => '2.14.1', getPath: () => '/scratch/userData', quit: vi.fn(), getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })), setLoginItemSettings: vi.fn() }
    // #637: the update link, recorded; its own behaviour is test/remote-update-link.test.ts's
    const links: Array<{ options: Json; calls: string[] }> = []
    const watches: Json[] = []
    const opened: unknown[] = []
    const modules: Record<string, unknown> = {
      './remote-update.cjs': {
        createRemoteUpdateLink: (options: Json) => {
          const link = { options, calls: [] as string[] }
          links.push(link)
          return { start: () => link.calls.push('start'), stop: () => link.calls.push('stop'), changed: () => link.calls.push('changed') }
        },
      },
      './remote-entry.cjs': { createRemoteEntry: (options: Json) => { made.push(options); return { ...controller, start: vi.fn(() => { controller.calls.push('start') }) } } },
      './remote-entry-state.cjs': { createRemoteEntryState: (options: Json) => ({ store: options }) },
      './remote-entry-ipc.cjs': { ...ipc, registerRemoteEntryIpc: (options: Json) => { handlers.set('options', options) }, watchRemoteEntry: (options: Json) => { watches.push(options); return { stop: vi.fn() } } },
    }
    // a dynamic import() cannot load inside new Function here: the one import of the words is the real module
    const IMPORT = "import(pathToFileURL(path.join(REPO_ROOT, 'public', 'remote-words.js')).href)"
    expect(main.slice(start, end).split(IMPORT)).toHaveLength(2)
    const block = main.slice(start, end).replace(IMPORT, 'loadWords()')
    const windowEvents = new Map<string, () => void>()
    const notes: Array<{ title: string; body: string }> = []
    const clicks: Array<() => void> = []
    const NotificationFake = Object.assign(function Notification(this: { on(event: string, fn: () => void): void }, note: { title: string; body: string }) {
      notes.push(note)
      this.on = (_event, fn) => { clicks.push(fn) }
    }, { isSupported: () => notifications })
    const installGate = { running: vi.fn(() => false), quitting: vi.fn(() => false) }
    const updateController = { name: 'the update controller' }
    const updateWindow = { name: 'the update window' }
    const linkWindow = {
      isDestroyed: () => false, on: (event: string, fn: () => void) => { windowEvents.set(event, fn) },
      webContents: { isDestroyed: () => false, send: (channel: string) => { sent.push(channel) } },
    }
    const scope = new Function(
      'require', 'process', 'app', 'ipcMain', 'Notification', 'notificationRetainer', 'linkSender', 'linkFilesPermitted', 'installBinding', 'OWNER_TOKEN',
      'REPO_ROOT', 'path', 'pathToFileURL', 'linkWindow', 'viewerOwnedNow', 'loadWords', 'URL_BASE', 'installGate', 'updateController', 'updateWindow', 'openUpdatesWindow',
      `let viewerOwned = viewerOwnedNow\n${block}\nreturn { startRemoteEntry, quitRemoteEntry, remoteEntryChanged, showRemoteUpdateNotice, link: () => remoteUpdate }`,
    )(
      (id: string) => { if (!(id in modules)) throw new Error(`unexpected require ${id}`); return modules[id] },
      { platform }, app, { handle: () => {} }, NotificationFake, { show: () => {} },
      () => true, () => true, { settled: async () => {} }, TOKEN, REPO, { join }, (p: string) => new URL(`file://${p}`), linkWindow, owned,
      async () => words, 'http://127.0.0.1:4319/', installGate, updateController, updateWindow, (win: unknown) => opened.push(win),
    ) as {
      startRemoteEntry(): void; quitRemoteEntry(event: { preventDefault(): void }): boolean; remoteEntryChanged(): void
      showRemoteUpdateNotice(notice: { label: string | null; version: string }): void; link(): unknown
    }
    return { scope, made, controller, handlers, app, sent, windowEvents, notes, links, watches, installGate, updateController, clicks, opened, updateWindow }
  }

  it('makes one controller with the owner token, a state store and the four callbacks, and starts it', () => {
    const w = world()
    w.scope.startRemoteEntry()
    w.scope.startRemoteEntry()
    expect(w.made).toHaveLength(1)
    const options = w.made[0]!
    expect(Object.keys(options).sort()).toEqual(['isPackaged', 'onOutsideChange', 'onPaired', 'onResumed', 'onStopped', 'ownerToken', 'stateStore'])
    expect(options).toMatchObject({ isPackaged: true, ownerToken: TOKEN, stateStore: { store: { app: w.app } } })
    expect(w.controller.calls).toEqual(['start'])
    // review round 1, item 12: a panel drawn as unowned during start asks again
    expect(w.sent).toEqual(['agent-inbox:remote-entry-changed'])
    const registered = w.handlers.get('options') as Json
    expect(registered.platform).toBe('darwin')
    expect((registered.panel as () => unknown)()).not.toBeNull()
  })

  // #637
  it('makes one update link with the controller, the owner token, main\'s install gate and the paired Mac\'s label, and starts it', async () => {
    const w = world()
    w.scope.startRemoteEntry()
    w.scope.startRemoteEntry()
    expect(w.links).toHaveLength(1)
    const options = w.links[0]!.options as Record<string, unknown> & {
      controller(): unknown; setupRunning(): boolean; quitting(): boolean; deviceLabel(id: string): Promise<string | null>
    }
    expect(Object.keys(options).sort()).toEqual(['base', 'controller', 'deviceLabel', 'notify', 'ownerToken', 'quitting', 'setupRunning', 'shared', 'version'])
    expect(options).toMatchObject({ base: 'http://127.0.0.1:4319/', ownerToken: TOKEN, version: '2.14.1', notify: w.scope.showRemoteUpdateNotice })
    expect(options.controller()).toBe(w.updateController)
    options.setupRunning()
    options.quitting()
    expect(w.installGate.running).toHaveBeenCalledOnce()
    expect(w.installGate.quitting).toHaveBeenCalledOnce()
    expect(await options.deviceLabel(A)).toBe('laptop')
    expect(await options.deviceLabel('0a1b2c3d4e5f6071')).toBeNull()
    expect(w.links[0]!.calls).toEqual(['start'])
    // and it stops with the sharing controller when the app quits
    w.scope.quitRemoteEntry({ preventDefault: () => {} })
    expect(w.links[0]!.calls).toEqual(['start', 'stop'])
  })

  // #637 fix round: main reports the hub's update only while this Mac shares with a paired device
  it('reports the update only while the remote entry is on and has a paired device, read from the watch\'s own get()', () => {
    const w = world()
    w.scope.startRemoteEntry()
    const shared = (w.links[0]!.options as { shared(): boolean }).shared
    const view = (w.watches[0] as { onView(view: unknown): void }).onView
    const base = { available: true, enabled: true, devices: [{ id: A, label: 'laptop', pairedAt: null }] }
    // nothing read yet: not shared
    expect(shared()).toBe(false)
    expect(w.links[0]!.calls).toEqual(['start'])
    // turned on, no device: not shared
    view({ ...base, devices: [] })
    expect(shared()).toBe(false)
    // a device but off: not shared
    view({ ...base, enabled: false })
    expect(shared()).toBe(false)
    // on with a device: shared, and the link reports at once
    view(base)
    expect(shared()).toBe(true)
    expect(w.links[0]!.calls).toEqual(['start', 'changed'])
    // still shared: no extra report from here
    view(base)
    expect(w.links[0]!.calls).toEqual(['start', 'changed'])
    // turned off, or the device removed, or a view that is not a view: not shared; the viewer says not_ready by itself
    for (const gone of [{ ...base, enabled: false }, { ...base, devices: [] }, null, undefined, 'x', { ...base, devices: 'many' }]) {
      view(base)
      view(gone)
      expect(shared(), JSON.stringify(gone)).toBe(false)
    }
    // the watch is the one the sharing page already has: one watch
    expect(w.watches).toHaveLength(1)
  })

  it('tells the owner on the hub that a paired Mac started an update, naming it as text, and opens Updates on a click', () => {
    const w = world({ notifications: true })
    w.scope.showRemoteUpdateNotice({ label: 'laptop', version: '2.15.0' })
    w.scope.showRemoteUpdateNotice({ label: null, version: '2.15.0' })
    expect(w.notes).toEqual([
      { title: 'Agent Inbox is updating', body: 'laptop started the update to version 2.15.0. Agent Inbox restarts by itself when it is ready.' },
      { title: 'Agent Inbox is updating', body: 'A paired Mac started the update to version 2.15.0. Agent Inbox restarts by itself when it is ready.' },
    ])
    w.clicks[0]!()
    expect(w.opened).toEqual([w.updateWindow])
    const quiet = world({ notifications: false })
    quiet.scope.showRemoteUpdateNotice({ label: 'laptop', version: '2.15.0' })
    expect(quiet.notes).toEqual([])
  })

  it('makes none on another platform, or for a viewer it did not start', () => {
    for (const w of [world({ platform: 'linux' }), world({ owned: false })]) {
      w.scope.startRemoteEntry()
      expect(w.made).toEqual([])
      expect(w.links).toEqual([])
      expect(((w.handlers.get('options') as Json).panel as () => unknown)()).toBeNull()
    }
  })

  it('on quit, holds the quit once while it stops the controller and waits for its state, then quits', async () => {
    const w = world()
    const event = { preventDefault: vi.fn() }
    expect(w.scope.quitRemoteEntry(event)).toBe(false)
    w.scope.startRemoteEntry()
    expect(w.scope.quitRemoteEntry(event)).toBe(true)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(w.app.quit).toHaveBeenCalledOnce())
    expect(w.controller.calls).toEqual(['start', 'stop', 'settled'])
    expect(w.scope.quitRemoteEntry(event)).toBe(false)
  })

  // review round 1, item 2: main tells the notifier the app started, so a pause at start is held
  it('holds a pause in the first 2 minutes after start: nothing is shown at once', async () => {
    const w = world({ notifications: true })
    w.scope.startRemoteEntry()
    const options = w.made[0]! as { onStopped(reason: string, detail: { off: boolean; willResume: boolean }): void }
    options.onStopped('not_running', { off: true, willResume: true })
    options.onStopped('identity_changed', { off: true, willResume: false })
    await vi.waitFor(() => expect(w.notes).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(w.notes.map((note) => note.title)).toEqual(['Agent Inbox stopped sharing with your other Macs'])
  })

  // review round 2, item 2: main resets the notifier when the owner's switch works
  it('a pause held at start never fires after the owner switched on by hand', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const w = world({ notifications: true })
      w.scope.startRemoteEntry()
      const options = w.made[0]! as { onStopped(reason: string, detail: { off: boolean; willResume: boolean }): void }
      options.onStopped('not_running', { off: true, willResume: true })
      const panel = ((w.handlers.get('options') as Json).panel as () => { turnOn(): Promise<unknown> })()
      await panel.turnOn()
      await vi.advanceTimersByTimeAsync(130_000)
      expect(w.notes).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  // review round 1, item 6: the removal hint is read again when the window regains focus
  it('reads Serve again for the removal hint when the window regains focus, then pings', async () => {
    const w = world()
    w.scope.startRemoteEntry()
    w.sent.length = 0
    w.windowEvents.get('focus')!()
    await vi.waitFor(() => expect(w.sent).toEqual(['agent-inbox:remote-entry-changed']))
    expect(w.controller.calls).toContain('recheckHint')
  })

  it('pings the window it owns with a bare change', () => {
    const w = world()
    w.scope.remoteEntryChanged()
    expect(w.sent).toEqual(['agent-inbox:remote-entry-changed'])
  })

  it('is one block, started after the viewer is up, and stopped in before-quit', () => {
    expect(main.match(/startRemoteEntry\(\)/g)).toHaveLength(2)
    const ready = main.slice(main.indexOf('app.whenReady()'), main.indexOf("app.on('window-all-closed'"))
    expect(ready.indexOf('startRemoteEntry()')).toBeGreaterThan(ready.indexOf('await waitForServer()'))
    const beforeQuit = main.slice(main.indexOf("app.on('before-quit'"), main.indexOf("app.on('will-quit'"))
    expect(beforeQuit).toContain('if (quitRemoteEntry(event)) return')
    expect(beforeQuit.indexOf('if (quitRemoteEntry(event)) return')).toBeGreaterThan(beforeQuit.indexOf('const running = beginAppQuit()'))
    // a destructuring require, so test/dead-exports.test.ts sees it
    expect(main).toContain("const { createRemoteEntry } = require('./remote-entry.cjs')")
    expect(main).not.toMatch(/ipcMain\.handle\('agent-inbox:remote-entry/)
  })
})

// ── the preload bridge ──────────────────────────────────────────────────────

function loadPreload(answer: (channel: string, ...args: unknown[]) => unknown) {
  const exposed: Record<string, unknown> = {}
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => answer(channel, ...args))
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const electron = {
    contextBridge: { exposeInMainWorld: (name: string, api: unknown) => { exposed[name] = api } },
    ipcRenderer: {
      invoke,
      on: (channel: string, fn: (...args: unknown[]) => void) => { listeners.set(channel, [...(listeners.get(channel) ?? []), fn]) },
      removeListener: (channel: string, fn: (...args: unknown[]) => void) => { listeners.set(channel, (listeners.get(channel) ?? []).filter((f) => f !== fn)) },
    },
  }
  const factory = vm.runInThisContext(`(function (require, process) {\n${read('electron/setup-preload.cjs')}\n})`, { filename: 'setup-preload.cjs' }) as
    (require: (id: string) => unknown, process: { argv: string[] }) => void
  factory((id) => {
    if (id !== 'electron') throw new Error(`unexpected require ${id}`)
    return electron
  }, { argv: [] })
  const emit = (channel: string, ...args: unknown[]) => { for (const fn of listeners.get(channel) ?? []) fn({ sender: 'main' }, ...args) }
  return { bridge: exposed.agentInboxRemoteEntry as Record<string, (...args: unknown[]) => Promise<Json>>, invoke, emit, listeners }
}

const GOOD = {
  available: true, enabled: true, host: HOST, port: 4320,
  devices: [{ id: A, label: 'laptop', pairedAt: '2026-11-20T09:00:00.000Z' }], unreadableDevices: 1, problem: null,
  flag: true, digest: DIGEST, wanted: true, stopped: { reason: 'funnel', willResume: false }, resume: { waiting: 'serve_not_ok:funnel', nextAt: 200 },
  needsOwner: null, stateSaved: false, serve: { ok: false, reason: 'no_handler' }, removalHint: 'tailscale serve --https=443 off',
  command: 'tailscale serve --bg 4320', loginItem: { available: true, openAtLogin: true, needsApproval: false }, listening: true,
  listenError: null, changes: CHANGES, refusal: null, inboxUnreachable: false,
}

describe('the agentInboxRemoteEntry bridge', () => {
  it('has exactly its members, each sending its channel and checked arguments only', async () => {
    const { bridge, invoke } = loadPreload(() => ({ ok: true }))
    expect(Object.keys(bridge).sort()).toEqual([
      'acknowledge', 'addDevice', 'clearUnreadable', 'get', 'onChange', 'recheck', 'removeDevice', 'repairPermissions', 'setOpenAtLogin', 'test', 'turnOff', 'turnOn',
      'turnOnRemovingDevices',
    ])
    await bridge.get!()
    await bridge.turnOn!()
    await bridge.turnOff!()
    await bridge.removeDevice!(A)
    await bridge.clearUnreadable!()
    await bridge.repairPermissions!()
    await bridge.acknowledge!(DIGEST)
    await bridge.test!()
    await bridge.addDevice!()
    await bridge.setOpenAtLogin!(true)
    await bridge.turnOnRemovingDevices!()
    await bridge.recheck!()
    expect(invoke.mock.calls).toEqual([
      ['agent-inbox:remote-entry'], ['agent-inbox:remote-entry-turn-on'], ['agent-inbox:remote-entry-turn-off'], ['agent-inbox:remote-entry-remove-device', A],
      ['agent-inbox:remote-entry-clear-unreadable'], ['agent-inbox:remote-entry-repair'], ['agent-inbox:remote-entry-acknowledge', DIGEST],
      ['agent-inbox:remote-entry-test'], ['agent-inbox:remote-entry-add-device'], ['agent-inbox:remote-entry-open-at-login', true],
      ['agent-inbox:remote-entry-turn-on-remove-devices'], ['agent-inbox:remote-entry-recheck'],
    ])
  })

  it.each([
    ['get', ['x']], ['turnOn', [true]], ['turnOff', [1]], ['removeDevice', []], ['removeDevice', ['laptop']], ['removeDevice', [A, 'x']],
    ['clearUnreadable', [1]], ['repairPermissions', ['x']], ['acknowledge', ['abc']], ['acknowledge', []], ['test', [1]], ['addDevice', ['laptop']],
    ['setOpenAtLogin', ['yes']], ['setOpenAtLogin', []], ['turnOnRemovingDevices', [true]], ['recheck', ['x']],
  ] as const)('refuses %s(%j) without asking main', async (method, args) => {
    const { bridge, invoke } = loadPreload(() => GOOD)
    await expect(bridge[method]!(...args)).resolves.toEqual(method === 'get' ? { available: false, reason: 'invalid' } : { ok: false, reason: 'invalid' })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('rebuilds get() field by field: a hostile answer\'s extra fields never cross', async () => {
    const hostile = {
      ...GOOD, logins: [LOGIN], ownerToken: TOKEN,
      devices: [{ ...GOOD.devices[0], secretSha256: HASH, codeId: CODE_ID }],
      stopped: { ...GOOD.stopped, login: LOGIN }, resume: { ...GOOD.resume, codeId: CODE_ID }, serve: { ...GOOD.serve, present: true, login: LOGIN },
      loginItem: { ...GOOD.loginItem, path: '/Applications/x.app' },
      changes: { ...CHANGES, login: LOGIN, secretSha256: HASH },
      refusal: { reason: 'no_handler', step: 'serve', devices: null, at: 70, login: LOGIN },
    }
    const { bridge } = loadPreload(() => hostile)
    const answer = await bridge.get!()
    expect(answer).toEqual({ ...GOOD, refusal: { reason: 'no_handler', step: 'serve', devices: null, at: 70 } })
    expect(secrets(answer)).toEqual([])
  })

  // review round 1, item 9: one bad date never costs the panel
  it('a pairedAt that is not a real date becomes no date, and the rest of the view stays', async () => {
    for (const pairedAt of ['2026-13-01T00:00:00Z', '2026-12-01T23:60:00Z', '2026-99-99T00:00:00.000Z', 7, '']) {
      const { bridge } = loadPreload(() => ({ ...GOOD, devices: [{ ...GOOD.devices[0], pairedAt }] }))
      const answer = await bridge.get!()
      expect(answer, String(pairedAt)).toMatchObject({ available: true, devices: [{ id: A, label: 'laptop', pairedAt: null }] })
    }
  })

  it('rebuilds the facts of a change: labels, booleans and counts of the right shape only', async () => {
    const bad: unknown[] = [
      { ...CHANGES, switched: 'sideways' }, { ...CHANGES, added: ['x'.repeat(41)] }, { ...CHANGES, added: [7] }, { ...CHANGES, account: 'yes' },
      { ...CHANGES, unreadableAdded: -1 }, { ...CHANGES, keyChanged: Array(17).fill('a') }, 'changed',
    ]
    for (const changes of bad) {
      const { bridge } = loadPreload(() => ({ ...GOOD, changes }))
      await expect(bridge.get!(), JSON.stringify(changes)).resolves.toEqual({ available: false, reason: 'failed' })
    }
    for (const refusal of [{ reason: '<b>', step: 'serve', devices: null, at: 1 }, { reason: 'x', step: 'shell', devices: null, at: 1 }, { reason: 'x', step: null, devices: -2, at: 1 }, { reason: 'x', step: null, devices: null, at: 'now' }]) {
      const { bridge } = loadPreload(() => ({ ...GOOD, refusal }))
      await expect(bridge.get!(), JSON.stringify(refusal)).resolves.toEqual({ available: false, reason: 'failed' })
    }
    for (const inboxUnreachable of ['yes', undefined]) {
      const { bridge } = loadPreload(() => ({ ...GOOD, inboxUnreachable }))
      await expect(bridge.get!(), String(inboxUnreachable)).resolves.toEqual({ available: false, reason: 'failed' })
    }
    for (const listenError of ['EADDRINUSE', 7]) {
      const { bridge } = loadPreload(() => ({ ...GOOD, listenError }))
      await expect(bridge.get!(), String(listenError)).resolves.toEqual({ available: false, reason: 'failed' })
    }
    const { bridge } = loadPreload(() => ({ ...GOOD, listenError: 'port_in_use', loginItem: { available: true, openAtLogin: false, needsApproval: true } }))
    await expect(bridge.get!()).resolves.toMatchObject({ listenError: 'port_in_use', loginItem: { available: true, openAtLogin: false, needsApproval: true } })
  })

  it('refuses an answer whose fields are the wrong shape', async () => {
    const bad: unknown[] = [
      { ...GOOD, host: 'evil host' }, { ...GOOD, port: 80 }, { ...GOOD, devices: [{ id: 'x', label: 'a', pairedAt: null }] },
      { ...GOOD, devices: [{ id: A, label: 7, pairedAt: null }] }, { ...GOOD, digest: 'xyz' }, { ...GOOD, command: 'rm -rf /' },
      { ...GOOD, removalHint: 'curl evil' }, { ...GOOD, stopped: { reason: '<b>', willResume: false } }, { ...GOOD, enabled: 'yes' },
      { ...GOOD, resume: { waiting: 'x y', nextAt: 1 } }, { ...GOOD, loginItem: null }, { ...GOOD, unreadableDevices: -1 },
      { ...GOOD, devices: Array.from({ length: 17 }, () => GOOD.devices[0]) }, { ...GOOD, listening: 'yes' }, { ...GOOD, listening: undefined }, null, 'on',
    ]
    for (const answer of bad) {
      const { bridge } = loadPreload(() => answer)
      await expect(bridge.get!(), JSON.stringify(answer)).resolves.toEqual({ available: false, reason: 'failed' })
    }
    const { bridge } = loadPreload(() => { throw new Error('gone') })
    await expect(bridge.get!()).resolves.toEqual({ available: false, reason: 'failed' })
  })

  it('passes unavailable on with its reason word, and nothing else', async () => {
    for (const reason of ['unsupported', 'unowned']) {
      const { bridge } = loadPreload(() => ({ available: false, reason, extra: LOGIN }))
      await expect(bridge.get!()).resolves.toEqual({ available: false, reason })
      await expect(bridge.turnOn!()).resolves.toEqual({ available: false, reason })
    }
    const { bridge } = loadPreload(() => ({ available: false }))
    await expect(bridge.turnOff!()).resolves.toEqual({ available: false })
  })

  it('rebuilds each operation\'s answer: a code, its expiry, counts and reason words only', async () => {
    const cases: Array<[string, unknown[], unknown, unknown]> = [
      ['turnOn', [], { ok: true, voidedCode: true, devicesRemoved: 2, droppedEntries: 1, view: { logins: [LOGIN] } }, { ok: true, voidedCode: true, devicesRemoved: 2, droppedEntries: 1 }],
      ['turnOn', [], { ok: true, listening: true }, { ok: true, listening: true }],
      ['turnOn', [], { ok: true, listening: 'yes' }, { ok: true }],
      ['test', [], { ok: false, reason: 'no_backend', rose: null }, { ok: false, reason: 'no_backend', rose: null }],
      ['test', [], { ok: false, reason: 'not_listening', rose: null }, { ok: false, reason: 'not_listening', rose: null }],
      // review round 1, item 12: a rose that is not a word does not cross
      ['test', [], { ok: false, reason: 'no_device_count', rose: '<b>x</b>' }, { ok: false, reason: 'no_device_count' }],
      ['turnOn', [], { ok: false, reason: 'would_remove_devices', step: 'file', devices: 3 }, { ok: false, reason: 'would_remove_devices', step: 'file', devices: 3 }],
      ['turnOn', [], { ok: false, reason: 'would_remove_devices', step: 'file', devices: -3 }, { ok: false, reason: 'would_remove_devices', step: 'file' }],
      ['turnOn', [], { ok: false, reason: 'no_handler', step: 'serve', login: LOGIN }, { ok: false, reason: 'no_handler', step: 'serve' }],
      ['turnOn', [], { ok: false, reason: 'no handler', step: 'shell' }, { ok: false, reason: 'failed' }],
      ['addDevice', [], { ok: true, code: CODE, expiresAt: '2026-11-20T09:10:00.000Z', codeId: CODE_ID }, { ok: true, code: CODE, expiresAt: '2026-11-20T09:10:00.000Z' }],
      ['addDevice', [], { ok: true, code: '<img>', expiresAt: '2026-11-20T09:10:00.000Z' }, { ok: false, reason: 'failed' }],
      ['addDevice', [], { ok: true, code: CODE, expiresAt: 'soon' }, { ok: false, reason: 'failed' }],
      ['test', [], { ok: false, reason: 'no_device_count', rose: 'login', status: { secret: 1 } }, { ok: false, reason: 'no_device_count', rose: 'login' }],
      ['clearUnreadable', [], { ok: true, removed: 2, voidedCode: false }, { ok: true, removed: 2, voidedCode: false }],
      ['repairPermissions', [], { ok: true, devicesRemoved: 3, voidedCode: false }, { ok: true, devicesRemoved: 3, voidedCode: false }],
      ['setOpenAtLogin', [false], { ok: true, openAtLogin: false, path: '/x' }, { ok: true, openAtLogin: false }],
      ['acknowledge', [DIGEST], 'ok', { ok: false, reason: 'failed' }],
    ]
    for (const [method, args, answer, expected] of cases) {
      const { bridge } = loadPreload(() => answer)
      await expect(bridge[method]!(...args), `${method} ${JSON.stringify(answer)}`).resolves.toEqual(expected)
    }
  })

  it('onChange keeps one listener, calls it with nothing, and can be removed', () => {
    const { bridge, emit, listeners } = loadPreload(() => GOOD)
    const first = vi.fn()
    const second = vi.fn()
    expect(bridge.onChange!(first)).toBe(true)
    expect(bridge.onChange!(second)).toBe(true)
    expect(listeners.get('agent-inbox:remote-entry-changed')).toHaveLength(1)
    emit('agent-inbox:remote-entry-changed', { login: LOGIN })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith()
    expect(bridge.onChange!('x' as unknown as () => void)).toBe(false)
    expect(bridge.onChange!(null as unknown as () => void)).toBe(true)
    expect(listeners.get('agent-inbox:remote-entry-changed')).toHaveLength(0)
  })
})
