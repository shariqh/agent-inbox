// Every IPC channel electron/main.cjs registers, and what the hub view gets from each (#617, PR 3b;
// design §3.3 "The view" and §3.6). The hub view shows another Mac's page in this app's window, in
// its own webContents. It must get none of this app's privileges: every channel but the two
// agentInboxDesk ones must answer the hub view exactly as it answers a stranger, and call nothing.
//
// The real main.cjs runs here against a fake `electron` whose `app.whenReady()` never resolves:
// its top level registers every channel it has, with the real policy modules behind them, and no
// window, server, network or Keychain is touched. A direct `eval` closure appended to the source
// sets the window's grants the way createWindow and the install binding would, so the local
// window is trusted and the comparison means something.
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import hubViewModule from '../electron/hub-view.cjs'
import { scratchDir } from './scratch.js'

const { trustedDeskSender } = hubViewModule

const REPO = join(import.meta.dirname, '..')
const MAIN = join(REPO, 'electron', 'main.cjs')
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8')
const HUB_ORIGIN = 'https://hub.example.ts.net'
const OFFLINE_URL = pathToFileURL(join(REPO, 'electron', 'remote-offline.html')).href
const ID = '0123abcd'
const CHAT_ID = '0f1e2d3c-4b5a-4968-8776-655443322110'
const LAUNCH_ID = '11111111-2222-4333-8444-555555555555'

type Handler = (event: unknown, ...args: unknown[]) => unknown

// Each channel main registers: who may use it, and arguments that pass its own arity and type
// checks, so the sender check is what decides. A channel missing here fails the test below.
const CHANNELS: Record<string, { allows: 'local page only' | 'hub view'; args: unknown[] }> = {
  'agent-inbox:update-state': { allows: 'local page only', args: [] },
  'agent-inbox:update-check': { allows: 'local page only', args: [] },
  'agent-inbox:update-automatic': { allows: 'local page only', args: [true] },
  'agent-inbox:update-download': { allows: 'local page only', args: [] },
  'agent-inbox:update-download-cancel': { allows: 'local page only', args: [] },
  'agent-inbox:update-install': { allows: 'local page only', args: [] },
  'agent-inbox:update-restart': { allows: 'local page only', args: [] },
  'agent-inbox:update-open-release': { allows: 'local page only', args: [] },
  'agent-inbox:install-available': { allows: 'local page only', args: [] },
  'agent-inbox:install': { allows: 'local page only', args: ['claude'] },
  'agent-inbox:open-link': { allows: 'local page only', args: [{ kind: 'web', url: 'https://example.com/' }] },
  'agent-inbox:link-files-available': { allows: 'local page only', args: [] },
  'agent-inbox:link-settings': { allows: 'local page only', args: [] },
  'agent-inbox:link-settings-set': { allows: 'local page only', args: ['web', 'default'] },
  'agent-inbox:link-settings-choose-app': { allows: 'local page only', args: ['markdown'] },
  'agent-inbox:link-settings-add-type': { allows: 'local page only', args: ['txt'] },
  'agent-inbox:link-settings-remove-type': { allows: 'local page only', args: ['txt'] },
  'agent-inbox:terminal-setting': { allows: 'local page only', args: [] },
  'agent-inbox:terminal-setting-set': { allows: 'local page only', args: ['terminal'] },
  'agent-inbox:set-theme-preference': { allows: 'local page only', args: ['dark'] },
  'agent-inbox:launch-available': { allows: 'local page only', args: [] },
  'agent-inbox:launch-set-enabled': { allows: 'local page only', args: [false] },
  'agent-inbox:launch-choose-folder': { allows: 'local page only', args: [] },
  'agent-inbox:launch-choose-worktree-root': { allows: 'local page only', args: [] },
  'agent-inbox:launch-reset-worktree-root': { allows: 'local page only', args: [] },
  'agent-inbox:launch-start': { allows: 'local page only', args: [{ folder: '/tmp' }] },
  'agent-inbox:launch-stop': { allows: 'local page only', args: [LAUNCH_ID] },
  'agent-inbox:launch-close': { allows: 'local page only', args: [LAUNCH_ID] },
  'agent-inbox:launch-resume': { allows: 'local page only', args: [LAUNCH_ID] },
  'agent-inbox:launch-approve': { allows: 'local page only', args: [{ launch: LAUNCH_ID }] },
  'agent-inbox:launch-remove-worktree': { allows: 'local page only', args: [LAUNCH_ID] },
  'agent-inbox:launch-open-worktree': { allows: 'local page only', args: [LAUNCH_ID] },
  'agent-inbox:launch-take-over': { allows: 'local page only', args: [LAUNCH_ID] },
  'agent-inbox:launch-forget': { allows: 'local page only', args: [LAUNCH_ID] },
  'agent-inbox:launch-resume-with-budget': { allows: 'local page only', args: [{ id: LAUNCH_ID, add: 1 }] },
  'agent-inbox:launch-set-max-sessions': { allows: 'local page only', args: [2] },
  'agent-inbox:launch-continue-chat': { allows: 'local page only', args: [{ tool: 'claude', id: CHAT_ID, mode: 'ask', prompt: 'go' }] },
  'agent-inbox:chat-resume-available': { allows: 'local page only', args: [] },
  'agent-inbox:chat-resume': { allows: 'local page only', args: [{ tool: 'claude', id: CHAT_ID }] },
  // Settings → Other devices (#617, PR 2d): the hub controller's panel, for the owned local page only
  'agent-inbox:remote-entry': { allows: 'local page only', args: [] },
  'agent-inbox:remote-entry-turn-on': { allows: 'local page only', args: [] },
  'agent-inbox:remote-entry-turn-on-remove-devices': { allows: 'local page only', args: [] },
  'agent-inbox:remote-entry-turn-off': { allows: 'local page only', args: [] },
  'agent-inbox:remote-entry-remove-device': { allows: 'local page only', args: ['3f9c0a1b2d4e5f60'] },
  'agent-inbox:remote-entry-clear-unreadable': { allows: 'local page only', args: [] },
  'agent-inbox:remote-entry-repair': { allows: 'local page only', args: [] },
  'agent-inbox:remote-entry-acknowledge': { allows: 'local page only', args: ['a'.repeat(64)] },
  'agent-inbox:remote-entry-test': { allows: 'local page only', args: [] },
  'agent-inbox:remote-entry-add-device': { allows: 'local page only', args: [] },
  'agent-inbox:remote-entry-open-at-login': { allows: 'local page only', args: [true] },
  'agent-inbox:remote-entry-recheck': { allows: 'local page only', args: [] },
  'agent-inbox:connect-view': { allows: 'local page only', args: [] },
  'agent-inbox:connect-connect': { allows: 'local page only', args: [{ address: 'hub.example.ts.net', code: '7K3QX-9M2PD' }] },
  'agent-inbox:connect-forget': { allows: 'local page only', args: [ID] },
  'agent-inbox:connect-show': { allows: 'local page only', args: [ID] },
  // the only two the hub view may use: its connection (label, state, version) and Retry from the offline file
  'agent-inbox:desk-connection': { allows: 'hub view', args: [] },
  'agent-inbox:desk-retry': { allows: 'hub view', args: [] },
}

/** An object that records every method called on it and answers each with `answer`. */
function recorder(label: string, calls: string[], answer: unknown = { recorded: true }) {
  return new Proxy({}, {
    get: (_target, name) => (name === 'then' ? undefined : (..._args: unknown[]) => { calls.push(`${label}.${String(name)}`); return answer }),
  })
}

// what BrowserWindow.fromWebContents answers: the test sets it to the window, for the local page AND the hub view, so a handler that trusts "it is in my window" is caught
const windowFor: { value: unknown } = { value: null }

function loadMain() {
  const handlers = new Map<string, Handler>()
  const other: string[] = []
  const calls: string[] = []
  const scratch = scratchDir('main-ipc-')
  const shell = recorder('shell', calls, Promise.resolve(''))
  const dialog = recorder('dialog', calls, Promise.resolve({ canceled: true, filePaths: [], response: 1 }))
  const nativeTheme = { on: () => {}, themeSource: 'system', shouldUseDarkColors: false }
  const app = {
    isPackaged: true, name: 'Agent Inbox', runningUnderARM64Translation: false,
    getVersion: () => '2.12.0', getPath: (name: string) => join(scratch, name),
    whenReady: () => new Promise(() => {}), on: () => {}, setBadgeCount: () => {}, isReady: () => false,
    quit: () => calls.push('app.quit'), exit: () => calls.push('app.exit'), relaunch: () => calls.push('app.relaunch'),
  }
  const ipcMain = {
    handle: (channel: string, fn: Handler) => {
      if (handlers.has(channel)) throw new Error(`registered twice: ${channel}`)
      handlers.set(channel, fn)
    },
    handleOnce: (channel: string) => other.push(`handleOnce ${channel}`),
    on: (channel: string) => other.push(`on ${channel}`),
    once: (channel: string) => other.push(`once ${channel}`),
    addListener: (channel: string) => other.push(`addListener ${channel}`),
    prependListener: (channel: string) => other.push(`prependListener ${channel}`),
  }
  const electron = {
    app, ipcMain, shell, dialog, nativeTheme,
    BrowserWindow: { getAllWindows: () => [], fromWebContents: () => windowFor.value, getFocusedWindow: () => windowFor.value },
    WebContentsView: class {},
    Menu: { setApplicationMenu: () => {}, buildFromTemplate: (template: unknown) => template },
    Notification: { isSupported: () => false },
    net: { isOnline: () => true },
    powerMonitor: { on: () => {} },
    safeStorage: recorder('safeStorage', calls, false),
    screen: {},
    session: { defaultSession: recorder('defaultSession', calls), fromPartition: () => recorder('partition', calls) },
  }
  const realRequire = createRequire(MAIN)
  const fakeProcess = Object.create(process, { platform: { value: 'darwin' }, arch: { value: 'arm64' }, env: { value: { HOME: scratch } } })
  const source = readFileSync(MAIN, 'utf8')
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const run = new Function('require', 'process', '__dirname', '__filename', 'module', 'exports', `${source}\n;return (code) => eval(code)`) as
    (...args: unknown[]) => (code: string) => unknown
  const evaluate = run((id: string) => (id === 'electron' ? electron : realRequire(id)), fakeProcess, dirname(MAIN), MAIN, { exports: {} }, {})
  return { handlers, other, calls, evaluate, nativeTheme }
}

describe('electron/main.cjs: every IPC channel, and the hub view', () => {
  let main: ReturnType<typeof loadMain>
  let urlBase: string
  const local = { id: 7, isDestroyed: () => false, send: () => {} }
  const hubContents = { id: 8, isDestroyed: () => false }
  const stranger = { id: 99, isDestroyed: () => false }
  const shown: unknown[] = []
  const retried: unknown[] = []

  beforeAll(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    main = loadMain()
    urlBase = main.evaluate('URL_BASE') as string
    const win = { webContents: local, isDestroyed: () => false, show: () => {}, setBackgroundColor: () => {} }
    windowFor.value = win
    const harness = {
      win,
      installBinding: { settled: async () => {}, refresh: () => {} },
      update: recorder('updateController', main.calls, { status: 'idle', fake: true }),
      launch: recorder('launchController', main.calls, { available: true, enabled: true }),
      chat: recorder('chatResume', main.calls, { available: true, terminal: 'terminal' }),
      links: recorder('linkSettings', main.calls, { available: true, rules: [] }),
      connect: {
        view: async () => { main.calls.push('remoteConnect.view'); return { available: true, keychain: true, hub: null, problem: null } },
        connect: async () => { main.calls.push('remoteConnect.connect'); return { ok: false, reason: 'refused' } },
        forget: async () => { main.calls.push('remoteConnect.forget'); return { ok: true } },
        connection: () => ({ mode: 'hub', id: ID, label: 'studio', state: 'online', reason: null, version: '2.12.0' }),
      },
      hub: {
        trusts: (event: unknown) => trustedDeskSender(event, { webContents: hubContents }, HUB_ORIGIN, OFFLINE_URL),
        current: () => null,
        show: (id: unknown) => { shown.push(id); return { ok: true, showing: id } },
        retry: async () => { retried.push(1); return { ok: true } },
      },
    }
    ;(globalThis as Record<string, unknown>).__mainIpcHarness = harness
    // the window's grants as createWindow and the install binding set them for the owned viewer
    main.evaluate(`{
      const h = globalThis.__mainIpcHarness
      linkWindow = h.win; updateWindow = h.win; themeWindow = h.win; themeWindowWebContentsId = 7
      fileLinkWebContentsId = 7; setupInstallWebContentsId = 7; updateInstallWebContentsId = 7; launchWebContentsId = 7
      viewerOwned = true; setupInstallEnabled = true; launchEnabled = true
      installBinding = h.installBinding; updateController = h.update; launchController = h.launch; chatResume = h.chat
      linkSettings = h.links; remoteConnect = h.connect; hubView = h.hub
    }`)
  })

  afterAll(() => {
    delete (globalThis as Record<string, unknown>).__mainIpcHarness
    vi.restoreAllMocks()
  })

  const frame = (url: string, parent: unknown = null) => ({ url, parent })
  const events = () => ({
    local: { sender: local, senderFrame: frame(urlBase) },
    stranger: { sender: stranger, senderFrame: frame(urlBase) },
    hub: { sender: hubContents, senderFrame: frame(`${HUB_ORIGIN}/`) },
    // the hub view with a frame claiming the local viewer's URL: still the hub view
    hubAsLocal: { sender: hubContents, senderFrame: frame(urlBase) },
    hubOffline: { sender: hubContents, senderFrame: frame(OFFLINE_URL) },
    hubSubFrame: { sender: hubContents, senderFrame: frame(`${HUB_ORIGIN}/`, frame(`${HUB_ORIGIN}/`)) },
    localSubFrame: { sender: local, senderFrame: frame(`${HUB_ORIGIN}/`, frame(urlBase)) },
  })

  it('registers only ipcMain.handle channels, and every one of them is classified here', () => {
    expect(main.other).toEqual([])
    const registered = [...main.handlers.keys()].sort()
    const unclassified = registered.filter((channel) => !(channel in CHANNELS))
    expect(unclassified, 'classify each new channel in CHANNELS: local page only, or hub view').toEqual([])
    expect(registered).toEqual(Object.keys(CHANNELS).sort())
  })

  it('names in main.cjs only channels it registers at its top level, through one of four register functions or a literal', () => {
    const source = read('electron/main.cjs')
    // every use of ipcMain: the require, ipcMain.handle with a literal or handleLinkSettings' parameter, or a register call
    const uses = [...source.matchAll(/\bipcMain\b[^\n]*/g)].map((m) => m[0])
    for (const use of uses) {
      expect(use, use).toMatch(/^ipcMain(, Menu,|\.handle\('agent-inbox:[a-z-]+', |\.handle\(channel, async \(event, \.\.\.args\) => \{$|,$)/)
    }
    expect([...source.matchAll(/^(register\w+)\(\{\n {2}ipcMain,$/gm)].map((m) => m[1])).toEqual(['registerLaunchIpc', 'registerChatResumeIpc', 'registerRemoteEntryIpc', 'registerHubIpc'])
    expect(source.match(/\bipcMain,\n/g)).toHaveLength(4)
    // no channel is registered later, inside a function that runs after start-up
    const literals = [...source.matchAll(/ipcMain\.handle\('([a-z:-]+)'/g), ...source.matchAll(/handleLinkSettings\('([a-z:-]+)'/g)].map((m) => m[1])
    for (const channel of literals) expect(main.handlers.has(channel!), channel).toBe(true)
  })

  it.each(Object.entries(CHANNELS).filter(([, c]) => c.allows === 'local page only').map(([channel, c]) => [channel, c.args]))(
    '%s answers the hub view exactly as a stranger, and calls nothing',
    async (channel, args) => {
      const handler = main.handlers.get(channel)!
      const e = events()
      main.calls.length = 0
      const asStranger = await handler(e.stranger, ...args)
      const asHub = await handler(e.hub, ...args)
      const asHubLocalUrl = await handler(e.hubAsLocal, ...args)
      const asHubOffline = await handler(e.hubOffline, ...args)
      const asHubSubFrame = await handler(e.hubSubFrame, ...args)
      expect(asHub).toEqual(asStranger)
      expect(asHubLocalUrl).toEqual(asStranger)
      expect(asHubOffline).toEqual(asStranger)
      expect(asHubSubFrame).toEqual(asStranger)
      expect(main.calls, 'a refused sender reached something privileged').toEqual([])
      expect(shown).toEqual([])
    },
  )

  it.each([
    ['agent-inbox:link-files-available', []],
    ['agent-inbox:set-theme-preference', ['dark']],
    ['agent-inbox:install-available', []],
    ['agent-inbox:launch-available', []],
    ['agent-inbox:chat-resume-available', []],
    ['agent-inbox:connect-view', []],
    ['agent-inbox:connect-show', [null]],
    ['agent-inbox:remote-entry', []],
  ])('%s does answer the owned local page, so the comparison above is meaningful', async (channel, args) => {
    const handler = main.handlers.get(channel)!
    const e = events()
    const asStranger = await handler(e.stranger, ...args)
    const asLocal = await handler(e.local, ...args)
    expect(asLocal).not.toEqual(asStranger)
    expect(await handler(e.localSubFrame, ...args)).toEqual(asStranger)
  })

  it('agentInboxConnect answers a reused viewer (the window’s page with no file-link grant) { available: false } on every channel', async () => {
    const e = events()
    const shownBefore = shown.length
    main.evaluate('fileLinkWebContentsId = null')
    try {
      for (const channel of Object.keys(CHANNELS).filter((name) => name.startsWith('agent-inbox:connect-'))) {
        expect(await main.handlers.get(channel)!(e.local, ...CHANNELS[channel]!.args), channel).toEqual({ available: false })
      }
    } finally {
      main.evaluate('fileLinkWebContentsId = 7')
    }
    expect(shown).toHaveLength(shownBefore)
  })

  it('Check for Updates… and an update notification bring This Mac forward first (openUpdatesWindow)', () => {
    const calls: string[] = []
    const shownBefore = shown.length
    const target = { isDestroyed: () => false, isMinimized: () => false, show: () => calls.push('show'), focus: () => calls.push('focus'), webContents: { isDestroyed: () => false, send: (channel: string) => calls.push(channel) } }
    ;(globalThis as Record<string, unknown>).__updatesTarget = target
    main.evaluate('openUpdatesWindow(globalThis.__updatesTarget)')
    delete (globalThis as Record<string, unknown>).__updatesTarget
    expect(shown.slice(shownBefore)).toEqual([null])
    expect(calls).toEqual(['show', 'focus', 'agent-inbox:open-updates'])
    shown.length = shownBefore
  })

  it('agentInboxDesk answers the hub view’s top frame only, and retry only from the offline file', async () => {
    const e = events()
    const connection = main.handlers.get('agent-inbox:desk-connection')!
    expect(await connection(e.hub)).toEqual({ mode: 'hub', label: 'studio', state: 'online', version: '2.12.0' })
    expect(await connection(e.hubOffline)).toEqual({ mode: 'hub', label: 'studio', state: 'online', version: '2.12.0' })
    for (const refused of [e.local, e.stranger, e.hubAsLocal, e.hubSubFrame, e.localSubFrame]) expect(await connection(refused)).toEqual({ available: false })
    const retry = main.handlers.get('agent-inbox:desk-retry')!
    for (const refused of [e.local, e.stranger, e.hub, e.hubAsLocal, e.hubSubFrame]) expect(await retry(refused)).toEqual({ ok: false })
    expect(retried).toEqual([])
    expect(await retry(e.hubOffline)).toEqual({ ok: true })
    expect(retried).toEqual([1])
  })
})

describe('electron/main.cjs never hands the hub view a grant (source)', () => {
  const main = read('electron/main.cjs')

  it.each([
    ['linkWindow', ['win', 'null']],
    ['themeWindow', ['win', 'null']],
    ['updateWindow', ['win', 'null']],
    ['themeWindowWebContentsId', ['webContentsId', 'null']],
    ['fileLinkWebContentsId', ['files ? setupWindowWebContentsId : null', 'null']],
    ['setupInstallWebContentsId', ['setup ? setupWindowWebContentsId : null', 'null']],
    ['updateInstallWebContentsId', ['update ? setupWindowWebContentsId : null', 'null']],
    ['launchWebContentsId', ['launch ? setupWindowWebContentsId : null', 'null']],
    ['installBinding', ['createInstallBinding({', 'null']],
  ])('assigns %s only from the window or the binding', (name, allowed) => {
    const assigned = [...main.matchAll(new RegExp(`\\b${name} = (?!=)([^\\n]*)`, 'g'))].map((m) => m[1]!.trim())
    expect(assigned.length).toBeGreaterThan(0)
    for (const value of assigned) expect(allowed, `${name} = ${value}`).toContain(value)
  })

  it('binds the install binding and the grants to the window’s own webContents id', () => {
    expect(main).toContain('const setupWindowWebContentsId = win.webContents.id')
    expect(main.match(/createInstallBinding\(/g)).toHaveLength(1)
    expect(main).toMatch(/win\.webContents\.on\('did-start-navigation'[\s\S]{0,120}installBinding\.navigationStarted\(url\)/)
  })

  it('keeps the hub view’s module and preload free of every grant and privileged name', () => {
    const privileged = ['installBinding', 'linkWindow', 'themeWindow', 'updateWindow', 'fileLinkWebContentsId', 'launchWebContentsId', 'setupInstall', 'agentInboxSetup', 'agentInboxLinks', 'agentInboxLaunch', 'agentInboxChats', 'agentInboxUpdates', 'agentInboxTheme']
    // hub-view.cjs registers agentInboxConnect's channels for the local page; the preload must not know them
    for (const [file, names] of [['electron/hub-view.cjs', privileged], ['electron/remote-preload.cjs', [...privileged, 'agentInboxConnect', 'connect-']]] as const) {
      const text = read(file)
      for (const name of names) {
        expect(text.includes(name), `${file} names ${name}`).toBe(false)
      }
    }
  })
})

describe('no IPC handler is registered any other way (source)', () => {
  it('nothing in electron/ uses webContents.ipc or a frame’s ipc', () => {
    const dir = join(REPO, 'electron')
    for (const name of readdirSync(dir).filter((file) => file.endsWith('.cjs'))) {
      const text = readFileSync(join(dir, name), 'utf8')
      expect(text, name).not.toMatch(/\.ipc\s*\.\s*(handle|handleOnce|on|once|addListener|removeHandler)\b|\bipc\s*:/)
    }
  })
})

describe('electron/main.cjs wires the hub view (source)', () => {
  const main = read('electron/main.cjs')
  const startRemote = main.slice(main.indexOf('function startRemoteConnect(win)'), main.indexOf('\n}\n', main.indexOf('function startRemoteConnect(win)')))

  it('requires the two modules by destructuring, so the dead-module guard sees them', () => {
    expect(main).toContain("const { createRemoteConnect } = require('./remote-connect.cjs')")
    expect(main).toContain("const { CONNECT_CHANNELS, createHubView, hubMenuItems, registerHubIpc, watchOnline, windowTitle } = require('./hub-view.cjs')")
  })

  it('makes connect mode on macOS only, after the window exists, and starts it last', () => {
    expect(startRemote).toContain("if (process.platform !== 'darwin') return")
    expect(startRemote).toContain('remoteConnect = createRemoteConnect({ app, safeStorage, onReload: () => hubView?.reload() })')
    expect(startRemote).toContain("offlineFile: path.join(__dirname, 'remote-offline.html'),")
    expect(startRemote).toContain("preload: path.join(__dirname, 'remote-preload.cjs'),")
    // developer tools on the hub view are closed in a packaged app only
    expect(startRemote).toContain('isPackaged: app.isPackaged,')
    // the profile's Partitions folder, listed so start-up clears every hub partition but the stored hub's
    expect(startRemote).toContain("readPartitions: () => readdirSync(path.join(app.getPath('userData'), 'Partitions')),")
    expect(startRemote.trimEnd().endsWith('remoteConnect.start()')).toBe(true)
    expect(main.indexOf('startRemoteConnect(win)\n')).toBeGreaterThan(main.indexOf('const win = createWindow()'))
  })

  it('kicks the controller on wake, on unlock and when the network comes back', () => {
    expect(startRemote).toContain("powerMonitor.on('resume', kick)")
    expect(startRemote).toContain("powerMonitor.on('unlock-screen', kick)")
    expect(startRemote).toContain('watchOnline({ isOnline: () => net.isOnline(), onBack: kick })')
  })

  it('stops the controller before quitting, and writes the hub partition’s storage on quit', () => {
    const beforeQuit = main.slice(main.indexOf("app.on('before-quit'"), main.indexOf("app.on('will-quit'"))
    expect(beforeQuit.indexOf('remoteConnect?.stop()')).toBeGreaterThan(-1)
    expect(beforeQuit.indexOf('remoteConnect?.stop()')).toBeLessThan(beforeQuit.indexOf('const running = beginAppQuit()'))
    const willQuit = main.slice(main.indexOf("app.on('will-quit'"))
    expect(willQuit).toContain('hubView?.flush()')
  })

  it('shows This Mac before Settings… and Check for Updates…, and adds the hub pair to the View menu', () => {
    const menu = main.slice(main.indexOf('function installApplicationMenu(win)'), main.indexOf('function initializeUpdateController()'))
    const settingsClick = menu.slice(menu.indexOf("label: 'Settings…'"))
    expect(settingsClick.indexOf('hubView?.show(null)')).toBeGreaterThan(-1)
    expect(settingsClick.indexOf('hubView?.show(null)')).toBeLessThan(settingsClick.indexOf("win.webContents.send('agent-inbox:toggle-settings')"))
    // Check for Updates… goes through openUpdatesWindow, which shows This Mac first (tested above)
    const updatesClick = menu.slice(menu.indexOf("label: 'Check for Updates…'"), menu.indexOf('const settings = {'))
    expect(updatesClick).toContain('openUpdatesWindow(win)')
    expect(menu).toContain('hubMenuItems({ connection: remoteConnect?.connection(), showing: hubView?.current() ?? null, show: (id) => hubView?.show(id) })')
    expect(menu).toContain("{ role: 'viewMenu' }")
  })

  it('every attention notification click brings This Mac forward before it shows the window and sets its location', () => {
    const watch = main.slice(main.indexOf('function startAttentionWatch(win)'), main.indexOf('function refreshUpdatesAfterLoad()'))
    const clicks = [...watch.matchAll(/\.on\('click', \(\) => \{\n([\s\S]*?)\n\s*\}\)/g)].map((m) => m[1]!)
    expect(clicks).toHaveLength(3)
    for (const body of clicks) {
      expect(body.trim().startsWith('hubView?.show(null)'), body).toBe(true)
      expect(body).toContain('executeJavaScript(\`location.hash')
    }
    // the update notifications open Settings → Updates through openUpdatesWindow
    expect(main.match(/note\.on\('click', \(\) => \{\n\s*if \(updateWindow\) openUpdatesWindow\(updateWindow\)/g)).toHaveLength(2)
  })

  it('names the hub in the title while its view is on top, and tells only the owned local page of a change', () => {
    const changed = main.slice(main.indexOf('function hubChanged(win)'), main.indexOf('\n}\n', main.indexOf('function hubChanged(win)')))
    expect(changed).toContain('win.setTitle(windowTitle(remoteConnect?.connection(), hubView?.current() ?? null))')
    expect(changed).toContain('fileLinkWebContentsId === win.webContents.id')
    expect(changed).toContain('win.webContents.send(CONNECT_CHANNELS.changed)')
  })
})
