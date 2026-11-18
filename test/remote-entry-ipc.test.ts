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
import * as words from '../public/remote-words.js'

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
    wanted: true, stateSaved: false, resume: { waiting: 'serve_not_ok:funnel', nextAt: 200, codeId: CODE_ID }, needsOwner: null, ...leak,
  }
  const c = {
    port: 4320,
    calls,
    raw: state,
    review: vi.fn(async () => { calls.push('review'); return { view, digest: DIGEST, flag: true, ...leak } }),
    turnOn: vi.fn(async () => { calls.push('turnOn'); return { ok: true, view, voidedCode: true, devicesRemoved: 2, droppedEntries: 1, ...leak } }),
    turnOff: vi.fn(async () => { calls.push('turnOff'); return { ok: true, view, voidedCode: false, ...leak } }),
    removeDevice: vi.fn(async (id: unknown) => { calls.push(`removeDevice ${String(id)}`); return { ok: true, view, voidedCode: true, droppedEntries: 0, ...leak } }),
    clearUnreadable: vi.fn(async () => { calls.push('clearUnreadable'); return { ok: true, view, voidedCode: false, removed: 1, ...leak } }),
    repairPermissions: vi.fn(async () => { calls.push('repairPermissions'); return { ok: true, view, voidedCode: false, devicesRemoved: 3, ...leak } }),
    acknowledge: vi.fn(async (digest: unknown) => { calls.push(`acknowledge ${String(digest)}`); return { ok: false, reason: 'changed', ...leak } }),
    selfTest: vi.fn(async () => { calls.push('selfTest'); return { ok: false, reason: 'no_device_count', rose: 'login', ...leak } }),
    requestCode: vi.fn(async () => { calls.push('requestCode'); return { ok: true, code: CODE, expiresAt: '2026-11-20T09:10:00.000Z', ...leak } }),
    stop: vi.fn(() => { calls.push('stop') }),
    settled: vi.fn(async () => { calls.push('settled') }),
    ...over,
    state: vi.fn(async () => { calls.push('state'); return state }),
  } as Json & { calls: string[] }
  return c
}

const loginItem = (available: boolean, openAtLogin = false) => ({
  read: vi.fn(() => ({ available, openAtLogin })),
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
  it('builds every field from one review() and state(), and nothing else', async () => {
    const { panel, c } = panelOf()
    const view = await panel.get()
    expect(c.calls).toEqual(['review', 'state'])
    expect(view).toEqual({
      available: true, enabled: true, host: HOST, port: 4320,
      devices: [{ id: A, label: 'laptop', pairedAt: '2026-11-20T09:00:00.000Z' }], unreadableDevices: 1, problem: null,
      flag: true, digest: DIGEST, wanted: true, stopped: { reason: 'funnel', willResume: false }, resume: { waiting: 'serve_not_ok:funnel', nextAt: 200 },
      needsOwner: null, stateSaved: false, serve: { ok: false, reason: 'no_handler' }, removalHint: 'tailscale serve --https=443 off',
      command: 'tailscale serve --bg 4320', loginItem: { available: true, openAtLogin: true },
    })
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
    expect(await panel.turnOn()).toEqual({ ok: true, voidedCode: true, devicesRemoved: 2, droppedEntries: 1 })
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
      'review', 'state', 'turnOn', 'turnOff', `removeDevice ${A}`, 'clearUnreadable', 'repairPermissions', `acknowledge ${DIGEST}`, 'selfTest', 'requestCode',
    ])
  })
})

describe('notifications', () => {
  function notifier(start = 1_000_000) {
    const shown: Array<{ title: string; body: string }> = []
    const changed = vi.fn()
    const clock = { now: start }
    const n = ipc.createRemoteNotifier({ show: (note: { title: string; body: string }) => { shown.push(note) }, now: () => clock.now, words, changed })
    return { n, shown, changed, clock }
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('says paused, stopped, resumed, paired and changed outside, as plain text', async () => {
    const { n, shown, changed } = notifier()
    n.onStopped('not_running', { off: true, willResume: true })
    n.onStopped('funnel', { off: true, willResume: false })
    n.onResumed()
    n.onPaired('<b>laptop</b>')
    n.onOutsideChange()
    await flush()
    expect(shown).toEqual([
      { title: 'Agent Inbox paused sharing with your other devices', body: 'It comes back by itself when Tailscale is ready.' },
      { title: 'Agent Inbox stopped sharing with your other devices', body: 'Tailscale Serve is not set up as expected.' },
      { title: 'Agent Inbox is sharing with your other devices again.', body: '' },
      { title: '<b>laptop</b> can now use this Inbox.', body: '' },
      { title: 'Agent Inbox’s sharing settings were changed outside the app', body: 'Open Settings to review.' },
    ])
    expect(changed).toHaveBeenCalledTimes(5)
  })

  it('has a sentence for every stop reason the controller can give, one per family', async () => {
    const types = read('electron/remote-entry.d.cts')
    const pick = (name: string) => {
      const at = types.indexOf(`export type ${name} =`)
      return [...types.slice(at, types.indexOf('\n\n', at)).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!)
    }
    const reasons = [...pick('SelfReason'), ...pick('ServeReason'), ...pick('StopReason')]
    expect(reasons).toContain('identity_changed')
    expect(reasons).toContain('not_wanted')
    const bodies = new Set<string>()
    for (const reason of reasons) {
      const { n, shown } = notifier()
      n.onStopped(reason, { off: true, willResume: false })
      await flush()
      expect(shown, reason).toHaveLength(1)
      expect(shown[0]!.body, reason).toBe(words.stopNotice(reason))
      bodies.add(shown[0]!.body)
    }
    expect(bodies.size).toBe(4)
  })

  it('shows at most one of each kind in 10 minutes; later ones only update the panel', async () => {
    const { n, shown, changed, clock } = notifier()
    n.onStopped('not_running', { off: true, willResume: true })
    clock.now += 9 * 60_000
    n.onStopped('not_running', { off: true, willResume: true })
    n.onPaired('laptop')
    n.onPaired('desk')
    n.onOutsideChange()
    n.onOutsideChange()
    n.onResumed()
    n.onResumed()
    n.onStopped('funnel', { off: true, willResume: false })
    n.onStopped('tagged', { off: true, willResume: false })
    await flush()
    expect(shown.map((note) => note.title)).toEqual([
      'Agent Inbox paused sharing with your other devices', 'laptop can now use this Inbox.', 'Agent Inbox’s sharing settings were changed outside the app',
      'Agent Inbox is sharing with your other devices again.', 'Agent Inbox stopped sharing with your other devices',
    ])
    expect(changed).toHaveBeenCalledTimes(10)
    clock.now += 60_000
    n.onStopped('not_running', { off: true, willResume: true })
    await flush()
    expect(shown).toHaveLength(6)
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
    expect(item.read()).toEqual({ available: false, openAtLogin: false })
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
    expect(item.read()).toEqual({ available: true, openAtLogin: false })
    expect(item.set(true)).toEqual({ ok: true, openAtLogin: true })
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true })
    expect(item.set('yes' as unknown as boolean)).toEqual({ ok: false, reason: 'unavailable' })
    expect(app.setLoginItemSettings).toHaveBeenCalledOnce()
    app.setLoginItemSettings.mockImplementation(() => { throw new Error('denied') })
    expect(item.set(false)).toEqual({ ok: false, reason: 'failed' })
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
})

// ── main.cjs's block, run against fakes ─────────────────────────────────────

describe('main wires one controller, only on macOS for the viewer it owns', () => {
  const main = read('electron/main.cjs')
  const start = main.indexOf('// ── sharing this Inbox with your other Macs (#617, PR 2d)')
  const end = main.indexOf('// ── end of sharing this Inbox with your other Macs')

  function world({ platform = 'darwin', owned = true, isPackaged = true } = {}) {
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const made: Json[] = []
    const controller = controllerStub()
    const handlers = new Map<string, unknown>()
    const sent: string[] = []
    const app = { isPackaged, getPath: () => '/scratch/userData', quit: vi.fn(), getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })), setLoginItemSettings: vi.fn() }
    const modules: Record<string, unknown> = {
      './remote-entry.cjs': { createRemoteEntry: (options: Json) => { made.push(options); return { ...controller, start: vi.fn(() => { controller.calls.push('start') }) } } },
      './remote-entry-state.cjs': { createRemoteEntryState: (options: Json) => ({ store: options }) },
      './remote-entry-ipc.cjs': { ...ipc, registerRemoteEntryIpc: (options: Json) => { handlers.set('options', options) }, watchRemoteEntry: () => ({ stop: vi.fn() }) },
    }
    const linkWindow = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (channel: string) => { sent.push(channel) } } }
    const scope = new Function(
      'require', 'process', 'app', 'ipcMain', 'Notification', 'notificationRetainer', 'linkSender', 'linkFilesPermitted', 'installBinding', 'OWNER_TOKEN',
      'REPO_ROOT', 'path', 'pathToFileURL', 'linkWindow', 'viewerOwnedNow',
      `let viewerOwned = viewerOwnedNow\n${main.slice(start, end)}\nreturn { startRemoteEntry, quitRemoteEntry, remoteEntryChanged }`,
    )(
      (id: string) => { if (!(id in modules)) throw new Error(`unexpected require ${id}`); return modules[id] },
      { platform }, app, { handle: () => {} }, Object.assign(function Notification() {}, { isSupported: () => false }), { show: () => {} },
      () => true, () => true, { settled: async () => {} }, TOKEN, REPO, { join }, (p: string) => new URL(`file://${p}`), linkWindow, owned,
    ) as { startRemoteEntry(): void; quitRemoteEntry(event: { preventDefault(): void }): boolean; remoteEntryChanged(): void }
    return { scope, made, controller, handlers, app, sent }
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
    const registered = w.handlers.get('options') as Json
    expect(registered.platform).toBe('darwin')
    expect((registered.panel as () => unknown)()).not.toBeNull()
  })

  it('makes none on another platform, or for a viewer it did not start', () => {
    for (const w of [world({ platform: 'linux' }), world({ owned: false })]) {
      w.scope.startRemoteEntry()
      expect(w.made).toEqual([])
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
  command: 'tailscale serve --bg 4320', loginItem: { available: true, openAtLogin: true },
}

describe('the agentInboxRemoteEntry bridge', () => {
  it('has exactly its members, each sending its channel and checked arguments only', async () => {
    const { bridge, invoke } = loadPreload(() => ({ ok: true }))
    expect(Object.keys(bridge).sort()).toEqual([
      'acknowledge', 'addDevice', 'clearUnreadable', 'get', 'onChange', 'removeDevice', 'repairPermissions', 'setOpenAtLogin', 'test', 'turnOff', 'turnOn',
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
    expect(invoke.mock.calls).toEqual([
      ['agent-inbox:remote-entry'], ['agent-inbox:remote-entry-turn-on'], ['agent-inbox:remote-entry-turn-off'], ['agent-inbox:remote-entry-remove-device', A],
      ['agent-inbox:remote-entry-clear-unreadable'], ['agent-inbox:remote-entry-repair'], ['agent-inbox:remote-entry-acknowledge', DIGEST],
      ['agent-inbox:remote-entry-test'], ['agent-inbox:remote-entry-add-device'], ['agent-inbox:remote-entry-open-at-login', true],
    ])
  })

  it.each([
    ['get', ['x']], ['turnOn', [true]], ['turnOff', [1]], ['removeDevice', []], ['removeDevice', ['laptop']], ['removeDevice', [A, 'x']],
    ['clearUnreadable', [1]], ['repairPermissions', ['x']], ['acknowledge', ['abc']], ['acknowledge', []], ['test', [1]], ['addDevice', ['laptop']],
    ['setOpenAtLogin', ['yes']], ['setOpenAtLogin', []],
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
    }
    const { bridge } = loadPreload(() => hostile)
    const answer = await bridge.get!()
    expect(answer).toEqual(GOOD)
    expect(secrets(answer)).toEqual([])
  })

  it('refuses an answer whose fields are the wrong shape', async () => {
    const bad: unknown[] = [
      { ...GOOD, host: 'evil host' }, { ...GOOD, port: 80 }, { ...GOOD, devices: [{ id: 'x', label: 'a', pairedAt: null }] },
      { ...GOOD, devices: [{ id: A, label: 7, pairedAt: null }] }, { ...GOOD, digest: 'xyz' }, { ...GOOD, command: 'rm -rf /' },
      { ...GOOD, removalHint: 'curl evil' }, { ...GOOD, stopped: { reason: '<b>', willResume: false } }, { ...GOOD, enabled: 'yes' },
      { ...GOOD, resume: { waiting: 'x y', nextAt: 1 } }, { ...GOOD, loginItem: null }, { ...GOOD, unreadableDevices: -1 },
      { ...GOOD, devices: Array.from({ length: 17 }, () => GOOD.devices[0]) }, null, 'on',
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
