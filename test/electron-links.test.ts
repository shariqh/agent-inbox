import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import links from '../electron/link-open.cjs'
import { removeScratchDirs, scratchDir } from './scratch.js'

function read(relPath: string): string {
  return readFileSync(join(import.meta.dirname, '..', relPath), 'utf8')
}

type LinksBridge = { open(...args: unknown[]): Promise<unknown>; filesAvailable(...args: unknown[]): Promise<unknown> }
type SettingsBridge = Record<'get' | 'setHandler' | 'chooseApp' | 'addType' | 'removeType' | 'getTerminal' | 'setTerminal', (...args: unknown[]) => Promise<unknown>>

afterEach(() => removeScratchDirs())

// Runs the real preload against a fake `electron`, so its checks are exercised
// rather than pinned as text.
function loadPreload(answer: (channel: string, ...args: unknown[]) => unknown, argv: string[] = []) {
  const exposed: Record<string, unknown> = {}
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => answer(channel, ...args))
  const heard: Array<{ channel: string; listener: (...args: unknown[]) => void }> = []
  const electron = {
    contextBridge: { exposeInMainWorld: (name: string, api: unknown) => { exposed[name] = api } },
    ipcRenderer: {
      invoke,
      on: (channel: string, listener: (...args: unknown[]) => void) => { heard.push({ channel, listener }) },
      removeListener: (channel: string, listener: (...args: unknown[]) => void) => {
        const at = heard.findIndex((entry) => entry.channel === channel && entry.listener === listener)
        if (at !== -1) heard.splice(at, 1)
      },
    },
  }
  const factory = vm.runInThisContext(
    `(function (require, process) {\n${read('electron/setup-preload.cjs')}\n})`,
    { filename: 'setup-preload.cjs' },
  ) as (require: (id: string) => unknown, process: { argv: string[] }) => void
  factory((id) => {
    if (id !== 'electron') throw new Error(`unexpected require ${id}`)
    return electron
  }, { argv })
  return { links: exposed.agentInboxLinks as LinksBridge, settings: exposed.agentInboxLinkSettings as SettingsBridge, invoke, exposed, heard }
}

// #617: Settings… chosen while another Mac's Inbox was on top says so, as exactly `true`
describe('the Settings toggle from the app menu', () => {
  it('passes the page only whether the hub was on top, as a boolean', () => {
    const { exposed, heard } = loadPreload(() => null)
    const setup = exposed.agentInboxSetup as { onToggleSettings(callback: unknown): () => void }
    const got: unknown[][] = []
    const off = setup.onToggleSettings((...args: unknown[]) => { got.push(args) })
    const toggles = heard.filter((entry) => entry.channel === 'agent-inbox:toggle-settings')
    expect(toggles).toHaveLength(1)
    const send = (...args: unknown[]) => toggles[0]!.listener({ sender: 'event' }, ...args)
    send(true)
    send(false)
    send()
    send('true')
    send(1)
    send({ fromHub: true })
    send(true, 'extra')
    expect(got).toEqual([[true], [false], [false], [false], [false], [false], [true]])
    off()
    expect(heard.filter((entry) => entry.channel === 'agent-inbox:toggle-settings')).toHaveLength(0)
    expect(setup.onToggleSettings('not a function')()).toBeUndefined()
  })

  it('Check for Updates… passes the page the same boolean', () => {
    const { exposed, heard } = loadPreload(() => null, ['--agent-inbox-updates=1'])
    const updates = exposed.agentInboxUpdates as { onOpenUpdates(callback: unknown): () => void }
    const got: unknown[][] = []
    const off = updates.onOpenUpdates((...args: unknown[]) => { got.push(args) })
    const opens = heard.filter((entry) => entry.channel === 'agent-inbox:open-updates')
    expect(opens).toHaveLength(1)
    const send = (...args: unknown[]) => opens[0]!.listener({ sender: 'event' }, ...args)
    send(true)
    send(false)
    send()
    send('true')
    send({ fromHub: true })
    expect(got).toEqual([[true], [false], [false], [false], [false]])
    off()
    expect(heard.filter((entry) => entry.channel === 'agent-inbox:open-updates')).toHaveLength(0)
  })
})

describe('the link bridge (issue #300)', () => {
  it('is one method that passes a fresh, well-formed request to one channel', async () => {
    const { links, invoke } = loadPreload(() => ({ ok: true, action: 'opened' }))
    // open() and a read of whether this page may open local files, nothing else
    expect(Object.keys(links)).toEqual(['open', 'filesAvailable'])
    await expect(links.open({ kind: 'file', path: '/Users/s/a.md', reveal: false, app: '/Applications/X.app' }))
      .resolves.toEqual({ ok: true, action: 'opened' })
    await links.open({ kind: 'web', url: 'https://example.com/x', extra: true })
    expect(invoke.mock.calls).toEqual([
      ['agent-inbox:open-link', { kind: 'file', path: '/Users/s/a.md', reveal: false }],
      ['agent-inbox:open-link', { kind: 'web', url: 'https://example.com/x' }],
    ])
  })

  it.each([
    [[]],
    [[{ kind: 'web', url: 'https://example.com' }, 'second argument']],
    [[null]],
    [['https://example.com']],
    [[{ kind: 'file', path: '/Users/s/a.md' }]],
    [[{ kind: 'file', path: '/Users/s/a.md', reveal: 'yes' }]],
    [[{ kind: 'file', path: 7, reveal: false }]],
    [[{ kind: 'shell', command: 'open -a Calculator' }]],
  ])('refuses %j without asking main', async (args) => {
    const { links, invoke } = loadPreload(() => ({ ok: true, action: 'opened' }))
    await expect(links.open(...args)).resolves.toEqual({ ok: false, reason: 'invalid' })
    expect(invoke).not.toHaveBeenCalled()
  })

  // issue #324: a repo-relative file names the folder its card recorded
  it('passes a repo-relative request on with its folder, and refuses one whose folder is not text', async () => {
    const { links, invoke } = loadPreload(() => ({ ok: false, reason: 'outside' }))
    await expect(links.open({ kind: 'file', path: 'docs/a.md', root: '/Users/s/repo', reveal: false, app: '/Applications/X.app' }))
      .resolves.toEqual({ ok: false, reason: 'outside' })
    expect(invoke.mock.calls).toEqual([['agent-inbox:open-link', { kind: 'file', path: 'docs/a.md', root: '/Users/s/repo', reveal: false }]])
    for (const root of [7, null, { path: '/Users/s/repo' }, ['/Users/s/repo']]) {
      await expect(links.open({ kind: 'file', path: 'docs/a.md', root, reveal: false }), JSON.stringify(root)).resolves.toEqual({ ok: false, reason: 'invalid' })
    }
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('hands back only a well-formed answer', async () => {
    const request = { kind: 'file', path: '/Users/s/a.sh', reveal: false }
    for (const [answer, expected] of [
      [{ ok: true, action: 'revealed', reason: 'blocked', path: '/private/x' }, { ok: true, action: 'revealed', reason: 'blocked' }],
      [{ ok: true, action: 'revealed', reason: 'type' }, { ok: true, action: 'revealed', reason: 'type' }],
      [{ ok: true, action: 'revealed', reason: 'requested' }, { ok: true, action: 'revealed', reason: 'requested' }],
      [{ ok: false, reason: 'missing' }, { ok: false, reason: 'missing' }],
      // a missing file's nearest folder: its name only, never a path or anything long
      [{ ok: true, action: 'revealed', reason: 'missing', folder: 'docs', path: '/private/x' }, { ok: true, action: 'revealed', reason: 'missing', folder: 'docs' }],
      [{ ok: true, action: 'revealed', reason: 'missing', folder: 'x'.repeat(256) }, { ok: true, action: 'revealed', reason: 'missing', folder: '' }],
      [{ ok: true, action: 'revealed', reason: 'missing', folder: 7 }, { ok: true, action: 'revealed', reason: 'missing', folder: '' }],
      [{ ok: false, reason: 'app-refused' }, { ok: false, reason: 'app-refused' }],
      [{ ok: false, reason: 'unowned' }, { ok: false, reason: 'unowned' }],
      [{ ok: true, action: 'revealed', reason: '<script>' }, { ok: false, reason: 'failed' }],
      [{ ok: true, action: 'launched' }, { ok: false, reason: 'failed' }],
      ['opened', { ok: false, reason: 'failed' }],
    ] as const) {
      const { links } = loadPreload(() => answer)
      await expect(links.open(request)).resolves.toEqual(expected)
    }
    const { links } = loadPreload(() => { throw new Error('main went away') })
    await expect(links.open(request)).resolves.toEqual({ ok: false, reason: 'failed' })
  })
})

describe('whether this page may open local files (issue #300)', () => {
  it('asks main once, with no argument, and takes only a plain true', async () => {
    for (const [answer, expected] of [[true, true], [false, false], ['true', false], [1, false], [{ files: true }, false], [null, false]] as const) {
      const { links, invoke } = loadPreload(() => answer)
      await expect(links.filesAvailable()).resolves.toBe(expected)
      expect(invoke.mock.calls).toEqual([['agent-inbox:link-files-available']])
    }
    const { links } = loadPreload(() => { throw new Error('main went away') })
    await expect(links.filesAvailable()).resolves.toBe(false)
    const extra = loadPreload(() => true)
    await expect(extra.links.filesAvailable('please')).resolves.toBe(false)
    expect(extra.invoke).not.toHaveBeenCalled()
  })
})

// Main's own handlers, evaluated against the real policy module, so a wiring
// that skips the owned-viewer grant fails here rather than in a reused viewer.
describe('main opens local files only for the viewer it owns (issue #300)', () => {
  const VIEWER = 'http://127.0.0.1:4319/'
  const main = read('electron/main.cjs')

  function world({ granted, settled = Promise.resolve() }: { granted: number | null; settled?: Promise<void> }) {
    const start = main.indexOf('const linkSender = (event) =>')
    const end = main.indexOf("ipcMain.handle('agent-inbox:set-theme-preference'")
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const contents = { id: 7, isDestroyed: () => false }
    const calls: Array<[string, string]> = []
    const shell = {
      openExternal: async (url: string) => { calls.push(['openExternal', url]) },
      openPath: async (path: string) => { calls.push(['openPath', path]); return '' },
      showItemInFolder: (path: string) => { calls.push(['showItemInFolder', path]) },
    }
    const installBinding = { settled: vi.fn(() => settled) }
    // Settings → Links (part 2) as main builds it, recording what reaches it
    const settingsCalls: string[] = []
    const settings = Object.fromEntries(['view', 'setHandler', 'chooseApp', 'addType', 'removeType', 'terminal', 'setTerminal'].map((name) => [
      name, async () => { settingsCalls.push(name); return { available: true, rules: [] } },
    ]))
    new Function(
      'ipcMain', 'isTrustedLinkSender', 'openLinkRequest', 'shell', 'app', 'URL_BASE', 'linkWindow', 'installBinding', 'granted',
      'createLinkPreferences', 'createLinkSettings', 'dialog', 'spawn',
      `let fileLinkWebContentsId = granted\n${main.slice(start, end)}`,
    )(
      { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, fn) },
      links.isTrustedLinkSender, links.openLinkRequest, shell, { getPath: () => '/Users/s' }, VIEWER,
      { isDestroyed: () => false, webContents: contents }, installBinding, granted,
      () => ({ read: async () => null }), () => settings, { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      () => { throw new Error('nothing may launch here') },
    )
    const event = (sender: object = contents) => ({ sender, senderFrame: { url: `${VIEWER}#item=x`, parent: null } })
    return {
      open: (request: unknown, sender?: object) => handlers.get('agent-inbox:open-link')!(event(sender), request),
      available: (sender?: object, ...args: unknown[]) => handlers.get('agent-inbox:link-files-available')!(event(sender), ...args),
      settings: (channel: string, ...args: unknown[]) => handlers.get(channel)!(event(), ...args),
      calls, installBinding, settingsCalls,
    }
  }

  it('opens a file for the window the binding granted, and refuses it, unread, anywhere else', async () => {
    const root = scratchDir('link-owned-')
    writeFileSync(join(root, 'spec.md'), '# spec')
    const file = { kind: 'file', path: join(root, 'spec.md'), reveal: false }
    const owned = world({ granted: 7 })
    expect(await owned.open(file)).toEqual({ ok: true, action: 'opened' })
    expect(owned.calls).toEqual([['openPath', realpathSync(join(root, 'spec.md'))]])

    for (const granted of [null, 8]) {
      const reused = world({ granted })
      expect(await reused.open(file), String(granted)).toEqual({ ok: false, reason: 'unowned' })
      expect(await reused.open({ kind: 'file', path: '/nowhere.md', reveal: false })).toEqual({ ok: false, reason: 'unowned' })
      expect(await reused.open({ ...file, reveal: true })).toEqual({ ok: false, reason: 'unowned' })
      expect(reused.calls).toEqual([])
    }
  })

  it('opens a repo-relative file with its folder for the granted window, refuses an escape, and reads neither anywhere else (#324)', async () => {
    const base = scratchDir('link-owned-repo-')
    const root = join(base, 'repo')
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs', 'spec.md'), '# spec')
    writeFileSync(join(base, 'secret.md'), 'secret')
    symlinkSync(join(base, 'secret.md'), join(root, 'docs', 'escape.md'))
    const spec = { kind: 'file', path: 'docs/spec.md', root, reveal: false }
    const owned = world({ granted: 7 })
    expect(await owned.open(spec)).toEqual({ ok: true, action: 'opened' })
    expect(await owned.open({ ...spec, path: 'docs/escape.md' })).toEqual({ ok: false, reason: 'outside' })
    expect(owned.calls).toEqual([['openPath', realpathSync(join(root, 'docs', 'spec.md'))]])
    for (const granted of [null, 8]) {
      const reused = world({ granted })
      expect(await reused.open(spec), String(granted)).toEqual({ ok: false, reason: 'unowned' })
      expect(await reused.open({ ...spec, path: 'docs/escape.md', reveal: true })).toEqual({ ok: false, reason: 'unowned' })
      expect(reused.calls).toEqual([])
    }
  })

  it('gives Settings → Links only to the viewer it owns, after any re-proof in flight', async () => {
    const channels: Array<[string, unknown[]]> = [
      ['agent-inbox:link-settings', []],
      ['agent-inbox:link-settings-set', ['markdown', 'quicklook']],
      ['agent-inbox:link-settings-choose-app', ['markdown']],
      ['agent-inbox:link-settings-add-type', ['py']],
      ['agent-inbox:link-settings-remove-type', ['ext:py']],
      // #586: the terminal setting sits behind the same gate
      ['agent-inbox:terminal-setting', []],
      ['agent-inbox:terminal-setting-set', ['iterm2']],
    ]
    for (const granted of [null, 8]) {
      const reused = world({ granted })
      for (const [channel, args] of channels) {
        expect(await reused.settings(channel, ...args), channel).toEqual({ available: false, rules: [], error: 'unowned' })
      }
      expect(reused.settingsCalls).toEqual([])
      expect(reused.installBinding.settled).toHaveBeenCalledTimes(channels.length)
    }
    const owned = world({ granted: 7 })
    for (const [channel, args] of channels) expect(await owned.settings(channel, ...args), channel).toEqual({ available: true, rules: [] })
    expect(owned.settingsCalls).toEqual(['view', 'setHandler', 'chooseApp', 'addType', 'removeType', 'terminal', 'setTerminal'])
  })

  it('still opens web links in a viewer it does not own', async () => {
    const reused = world({ granted: null })
    expect(await reused.open({ kind: 'web', url: 'https://github.com/shariqh/agent-inbox/pull/312' })).toEqual({ ok: true, action: 'opened' })
    expect(reused.calls).toEqual([['openExternal', 'https://github.com/shariqh/agent-inbox/pull/312']])
    // a frame that is not the viewer window's own gets nothing at all
    expect(await reused.open({ kind: 'web', url: 'https://example.com/' }, { id: 7, isDestroyed: () => false })).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('says whether files may open here only once a re-proof in flight has settled', async () => {
    let finish!: () => void
    const proof = new Promise<void>((resolve) => { finish = resolve })
    const reloading = world({ granted: 7, settled: proof })
    let answered: unknown = 'pending'
    void Promise.resolve(reloading.available()).then((value) => { answered = value })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reloading.installBinding.settled).toHaveBeenCalledOnce()
    expect(answered).toBe('pending')
    finish()
    await vi.waitFor(() => expect(answered).toBe(true))

    expect(await world({ granted: null }).available()).toBe(false)
    expect(await world({ granted: 8 }).available()).toBe(false)
    expect(await world({ granted: 7 }).available({ id: 7, isDestroyed: () => false })).toBe(false)
    expect(await world({ granted: 7 }).available(undefined, 'extra')).toBe(false)
  })
})

describe('main opens links only through electron/link-open.cjs (issue #300)', () => {
  const main = read('electron/main.cjs')

  it('registers one link channel and one permission read behind the viewer-window sender check', () => {
    expect([...main.matchAll(/ipcMain\.handle\('(agent-inbox:open-link)'/g)]).toHaveLength(1)
    expect([...main.matchAll(/ipcMain\.handle\('(agent-inbox:link-files-available)'/g)]).toHaveLength(1)
    expect(main).toContain('const linkSender = (event) => isTrustedLinkSender({ sender: event.sender, senderFrame: event.senderFrame, window: linkWindow, viewerUrl: URL_BASE })')
    expect(main).toContain('const linkOpening = { platform: process.platform, spawnImpl: spawn }')
    expect(main).toContain('  linkWindow = win\n')
    expect(main).toContain('    if (linkWindow === win) linkWindow = null\n')
    // the file grant comes only from the window's binding, never set anywhere else
    expect(main).toContain('      fileLinkWebContentsId = files ? setupWindowWebContentsId : null\n')
    expect(main).toContain('    filesAllowed: () => viewerOwned,\n')
  })

  it('checks the scheme on the window’s own open and navigate paths', () => {
    // before #300 both handed ANY url to shell.openExternal
    expect(main).not.toContain('shell.openExternal(url)')
    expect([...main.matchAll(/shell\.openExternal\(([^)]*)\)/g)].map((m) => m[1])).toEqual(['releaseUrl'])
    expect(main).toMatch(/setWindowOpenHandler\(\(\{ url \}\) => \{\s*openWebLink\(url, shell, \{ readRules: linkRules, \.\.\.linkOpening \}\)\s*return \{ action: 'deny' \}/)
    expect(main).toMatch(/'will-navigate', \(e, url\) => \{\s*if \(isViewerUrl\(url, URL_BASE\)\) return\s*e\.preventDefault\(\)\s*installBinding\?\.navigationPrevented\(url\)\s*openWebLink\(url, shell, \{ readRules: linkRules, \.\.\.linkOpening \}\)/)
  })

  it('takes an app only from its own native picker, limited to .app bundles, behind the same sender check and grant', () => {
    const settings = main.slice(main.indexOf('let linkSettings = null'), main.indexOf("ipcMain.handle('agent-inbox:set-theme-preference'"))
    expect(settings).toContain("properties: ['openFile'], filters: [{ name: 'Applications', extensions: ['app'] }],")
    expect(settings).toContain('return result.canceled ? null : result.filePaths')
    expect(settings).toContain('if (args.length !== arity) return { available: false, rules: [] }')
    expect(settings).toContain('if (!linkSender(event)) return { available: false, rules: [] }')
    expect(settings).toContain("if (!linkFilesPermitted(event)) return { available: false, rules: [], error: 'unowned' }")
    expect([...settings.matchAll(/handleLinkSettings\('([^']+)', (\d)/g)].map((m) => [m[1], Number(m[2])])).toEqual([
      ['agent-inbox:link-settings', 0],
      ['agent-inbox:link-settings-set', 2],
      ['agent-inbox:link-settings-choose-app', 1],
      ['agent-inbox:link-settings-add-type', 1],
      ['agent-inbox:link-settings-remove-type', 1],
      ['agent-inbox:terminal-setting', 0],
      ['agent-inbox:terminal-setting-set', 1],
    ])
    // the only call that can store an app is chooseApp, which asks the picker itself
    expect(settings).toContain("(settings, ruleId) => settings.chooseApp(ruleId))")
    // and the only other pickers are driven sessions' folder choosers (#412 step 3, #432), which pick folders, never apps
    expect(main.match(/dialog\.showOpenDialog\(/g)).toHaveLength(6)
    const folders = main.slice(main.indexOf('chooseFolder: async () => {'), main.indexOf('driverRuntime: launchDriverRuntime,'))
    expect(folders).toContain("properties: ['openDirectory'] }")
    expect(folders).toContain("properties: ['openDirectory', 'createDirectory'] }")
    expect(folders).not.toMatch(/openFile|\.app\b/)
    expect(folders.match(/dialog\.showOpenDialog\(/g)).toHaveLength(4)
  })

  it('never opens a file any other way', () => {
    // #634: the one exception, by decision: a private copy of a hub's file that electron/hub-files.cjs
    // fetched, saved under hub-files/ with a listed document extension and checked again, opened with
    // its default app (test/hub-files.test.ts). Nothing the page names is opened through it.
    const hubCopy = 'openPath: (file) => shell.openPath(file),'
    expect(main.split(hubCopy)).toHaveLength(2)
    expect(main.slice(main.indexOf('const hubFilesFor = () =>'), main.indexOf('registerHubIpc({'))).toContain(hubCopy)
    expect(main.replace(hubCopy, '')).not.toMatch(/shell\.(openPath|showItemInFolder)\(/)
    expect(read('electron/setup-preload.cjs')).not.toMatch(/require\('(?!electron')/)
  })
})

describe('the Settings → Links bridge (issue #300 part 2)', () => {
  const VIEW = {
    available: true,
    rules: [{ id: 'markdown', label: 'Markdown (.md, .markdown)', kind: 'file', handler: 'app', appName: 'QLMarkdown', removable: false, systemDefault: true }],
  }

  it('has exactly seven methods, each sending a rule id and at most a handler, an extension or a terminal id', async () => {
    const { settings, invoke } = loadPreload(() => VIEW)
    expect(Object.keys(settings).sort()).toEqual(['addType', 'chooseApp', 'get', 'getTerminal', 'removeType', 'setHandler', 'setTerminal'])
    await settings.get()
    await settings.setHandler('markdown', 'quicklook')
    await settings.chooseApp('markdown')
    await settings.addType('.log')
    await settings.removeType('ext:log')
    await settings.getTerminal()
    await settings.setTerminal('iterm2')
    expect(invoke.mock.calls).toEqual([
      ['agent-inbox:link-settings'],
      ['agent-inbox:link-settings-set', 'markdown', 'quicklook'],
      ['agent-inbox:link-settings-choose-app', 'markdown'],
      ['agent-inbox:link-settings-add-type', '.log'],
      ['agent-inbox:link-settings-remove-type', 'ext:log'],
      ['agent-inbox:terminal-setting'],
      ['agent-inbox:terminal-setting-set', 'iterm2'],
    ])
  })

  it.each([
    ['get', ['extra']],
    ['setHandler', ['markdown']],
    ['setHandler', ['markdown', { app: '/Applications/Calculator.app' }]],
    ['setHandler', ['markdown', 'app', '/Applications/Calculator.app']],
    ['chooseApp', ['markdown', '/Applications/Calculator.app']],
    ['chooseApp', [{ path: '/Applications/Calculator.app' }]],
    ['addType', ['x'.repeat(65)]],
    ['removeType', []],
  ] as const)('refuses %s(%j) without asking main', async (method, args) => {
    const { settings, invoke } = loadPreload(() => VIEW)
    await expect(settings[method](...args)).resolves.toEqual({ available: false, rules: [], error: 'invalid' })
    expect(invoke).not.toHaveBeenCalled()
  })

  it.each([
    ['getTerminal', ['x']],
    ['setTerminal', []],
    ['setTerminal', [1]],
    ['setTerminal', [{ app: '/Applications/Calculator.app' }]],
    ['setTerminal', ['x'.repeat(65)]],
    ['setTerminal', ['iterm2', 'x']],
  ] as const)('refuses %s(%j) without asking main (#586)', async (method, args) => {
    const { settings, invoke } = loadPreload(() => ({ available: true, terminal: 'iterm2' }))
    await expect(settings[method](...args)).resolves.toEqual({ available: false, error: 'invalid' })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('hands back a checked terminal view with no rules, path or extra field (#586)', async () => {
    const cases: Array<[unknown, unknown]> = [
      [{ available: true, terminal: 'iterm2', extra: 1, path: '/Applications/iTerm.app', rules: [] }, { available: true, terminal: 'iterm2' }],
      [{ available: true, terminal: 'terminal', error: 'invalid' }, { available: true, terminal: 'terminal', error: 'invalid' }],
      [{ available: true, terminal: 'Hyper' }, { available: false, error: 'failed' }],
      [{ available: true }, { available: false, error: 'failed' }],
      [null, { available: false, error: 'failed' }],
      [{ available: 'yes' }, { available: false, error: 'failed' }],
      [{ available: false, rules: [], error: 'unowned' }, { available: false, error: 'unowned' }],
      [{ available: false, rules: [], error: 'nonsense' }, { available: false }],
    ]
    for (const [answer, expected] of cases) {
      const { settings } = loadPreload(() => answer)
      await expect(settings.getTerminal(), JSON.stringify(answer)).resolves.toEqual(expected)
      await expect(settings.setTerminal('iterm2'), JSON.stringify(answer)).resolves.toEqual(expected)
    }
    const { settings } = loadPreload(() => { throw new Error('gone') })
    await expect(settings.getTerminal()).resolves.toEqual({ available: false, error: 'failed' })
  })

  it('passes on main\'s word that this page is not the viewer the app owns', async () => {
    const unowned = { available: false, rules: [], error: 'unowned' }
    const { settings } = loadPreload(() => unowned)
    await expect(settings.get()).resolves.toEqual(unowned)
  })

  it('hands back a checked view that can name an app but never carry its path', async () => {
    const leaky = { ...VIEW, rules: [{ ...VIEW.rules[0], app: '/Applications/QLMarkdown.app' }], extra: true, error: 'runs-code' }
    const { settings } = loadPreload(() => leaky)
    await expect(settings.get()).resolves.toEqual({ ...VIEW, error: 'runs-code' })
    for (const bad of [
      null,
      { available: 'yes', rules: [] },
      { available: true, rules: [{ ...VIEW.rules[0], handler: 'shell' }] },
      { available: true, rules: [{ ...VIEW.rules[0], systemDefault: 'yes' }] },
    ]) {
      const { settings: s } = loadPreload(() => bad)
      await expect(s.get()).resolves.toEqual({ available: false, rules: [], error: 'failed' })
    }
  })
})
