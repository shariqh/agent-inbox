import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

function read(relPath: string): string {
  return readFileSync(join(import.meta.dirname, '..', relPath), 'utf8')
}

type LinksBridge = { open(...args: unknown[]): Promise<unknown> }
type SettingsBridge = Record<'get' | 'setHandler' | 'chooseApp' | 'addType' | 'removeType', (...args: unknown[]) => Promise<unknown>>

// Runs the real preload against a fake `electron`, so its checks are exercised
// rather than pinned as text.
function loadPreload(answer: (channel: string, ...args: unknown[]) => unknown) {
  const exposed: Record<string, unknown> = {}
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => answer(channel, ...args))
  const electron = {
    contextBridge: { exposeInMainWorld: (name: string, api: unknown) => { exposed[name] = api } },
    ipcRenderer: { invoke, on: () => {}, removeListener: () => {} },
  }
  const factory = vm.runInThisContext(
    `(function (require, process) {\n${read('electron/setup-preload.cjs')}\n})`,
    { filename: 'setup-preload.cjs' },
  ) as (require: (id: string) => unknown, process: { argv: string[] }) => void
  factory((id) => {
    if (id !== 'electron') throw new Error(`unexpected require ${id}`)
    return electron
  }, { argv: [] })
  return { links: exposed.agentInboxLinks as LinksBridge, settings: exposed.agentInboxLinkSettings as SettingsBridge, invoke }
}

describe('the link bridge (issue #300)', () => {
  it('is one method that passes a fresh, well-formed request to one channel', async () => {
    const { links, invoke } = loadPreload(() => ({ ok: true, action: 'opened' }))
    expect(Object.keys(links)).toEqual(['open'])
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

  it('hands back only a well-formed answer', async () => {
    const request = { kind: 'file', path: '/Users/s/a.sh', reveal: false }
    for (const [answer, expected] of [
      [{ ok: true, action: 'revealed', reason: 'blocked', path: '/private/x' }, { ok: true, action: 'revealed', reason: 'blocked' }],
      [{ ok: true, action: 'revealed', reason: 'type' }, { ok: true, action: 'revealed', reason: 'type' }],
      [{ ok: true, action: 'revealed', reason: 'requested' }, { ok: true, action: 'revealed', reason: 'requested' }],
      [{ ok: false, reason: 'missing' }, { ok: false, reason: 'missing' }],
      [{ ok: false, reason: 'app-refused' }, { ok: false, reason: 'app-refused' }],
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

describe('main opens links only through electron/link-open.cjs (issue #300)', () => {
  const main = read('electron/main.cjs')

  it('registers one link channel behind the viewer-window sender check', () => {
    expect([...main.matchAll(/ipcMain\.handle\('(agent-inbox:open-link)'/g)]).toHaveLength(1)
    expect(main).toContain('const linkSender = (event) => isTrustedLinkSender({ sender: event.sender, senderFrame: event.senderFrame, window: linkWindow, viewerUrl: URL_BASE })')
    const handler = main.slice(main.indexOf("ipcMain.handle('agent-inbox:open-link'"), main.indexOf('let linkSettings = null'))
    expect(handler).toContain("if (args.length !== 0 || !linkSender(event)) return { ok: false, reason: 'unavailable' }")
    expect(handler).toContain("return openLinkRequest(request, { shell, homeDir: app.getPath('home'), rules: await linkRules(), ...linkOpening })")
    expect(main).toContain('const linkOpening = { platform: process.platform, spawnImpl: spawn }')
    expect(main).toContain('  linkWindow = win\n')
    expect(main).toContain('    if (linkWindow === win) linkWindow = null\n')
  })

  it('checks the scheme on the window’s own open and navigate paths', () => {
    // before #300 both handed ANY url to shell.openExternal
    expect(main).not.toContain('shell.openExternal(url)')
    expect([...main.matchAll(/shell\.openExternal\(([^)]*)\)/g)].map((m) => m[1])).toEqual(['releaseUrl'])
    expect(main).toMatch(/setWindowOpenHandler\(\(\{ url \}\) => \{\s*openWebLink\(url, shell, \{ readRules: linkRules, \.\.\.linkOpening \}\)\s*return \{ action: 'deny' \}/)
    expect(main).toMatch(/'will-navigate', \(e, url\) => \{\s*if \(isViewerUrl\(url, URL_BASE\)\) return\s*e\.preventDefault\(\)\s*openWebLink\(url, shell, \{ readRules: linkRules, \.\.\.linkOpening \}\)/)
  })

  it('takes an app only from its own native picker, limited to .app bundles, behind the same sender check', () => {
    const settings = main.slice(main.indexOf('let linkSettings = null'), main.indexOf("ipcMain.handle('agent-inbox:set-theme-preference'"))
    expect(settings).toContain("properties: ['openFile'], filters: [{ name: 'Applications', extensions: ['app'] }],")
    expect(settings).toContain('return result.canceled ? null : result.filePaths')
    expect(settings).toContain('if (args.length !== arity || !linkSender(event)) return { available: false, rules: [] }')
    expect([...settings.matchAll(/handleLinkSettings\('([^']+)', (\d)/g)].map((m) => [m[1], Number(m[2])])).toEqual([
      ['agent-inbox:link-settings', 0],
      ['agent-inbox:link-settings-set', 2],
      ['agent-inbox:link-settings-choose-app', 1],
      ['agent-inbox:link-settings-add-type', 1],
      ['agent-inbox:link-settings-remove-type', 1],
    ])
    // the only call that can store an app is chooseApp, which asks the picker itself
    expect(settings).toContain("(settings, ruleId) => settings.chooseApp(ruleId))")
    expect(main.match(/dialog\.showOpenDialog\(/g)).toHaveLength(2)
  })

  it('never opens a file any other way', () => {
    expect(main).not.toMatch(/shell\.(openPath|showItemInFolder)\(/)
    expect(read('electron/setup-preload.cjs')).not.toMatch(/require\('(?!electron')/)
  })
})

describe('the Settings → Links bridge (issue #300 part 2)', () => {
  const VIEW = {
    available: true,
    rules: [{ id: 'markdown', label: 'Markdown (.md, .markdown)', kind: 'file', handler: 'app', appName: 'QLMarkdown', removable: false, systemDefault: true }],
  }

  it('has exactly five methods, each sending a rule id and at most a handler or an extension', async () => {
    const { settings, invoke } = loadPreload(() => VIEW)
    expect(Object.keys(settings).sort()).toEqual(['addType', 'chooseApp', 'get', 'removeType', 'setHandler'])
    await settings.get()
    await settings.setHandler('markdown', 'quicklook')
    await settings.chooseApp('markdown')
    await settings.addType('.log')
    await settings.removeType('ext:log')
    expect(invoke.mock.calls).toEqual([
      ['agent-inbox:link-settings'],
      ['agent-inbox:link-settings-set', 'markdown', 'quicklook'],
      ['agent-inbox:link-settings-choose-app', 'markdown'],
      ['agent-inbox:link-settings-add-type', '.log'],
      ['agent-inbox:link-settings-remove-type', 'ext:log'],
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
