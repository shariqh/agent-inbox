import { EventEmitter } from 'node:events'
import { chmodSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import links from '../electron/link-open.cjs'
import type { LinkRules } from '../electron/link-open.cjs'
import { removeScratchDirs, scratchDir } from './scratch.js'

const { blockedFileName, externalWebUrl, fileOpenPlan, isTrustedLinkSender, isViewerUrl, normalizeLocalPath, openLinkRequest, openWebLink } = links

const VIEWER = 'http://127.0.0.1:4319/'

afterEach(() => removeScratchDirs())

describe('web links: http and https only (issue #300)', () => {
  it.each([
    ['https://example.com/a?b=c#d', 'https://example.com/a?b=c#d'],
    ['http://localhost:3000/x', 'http://localhost:3000/x'],
    ['HTTPS://Example.COM/A', 'https://example.com/A'],
  ])('accepts %s as its normalized href', (url, href) => {
    expect(externalWebUrl(url)).toBe(href)
  })

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'file:///etc/passwd',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'mailto:a@example.com',
    'ssh://host',
    'smb://share/x',
    'x-apple.systempreferences:com.apple.preference.security',
    'vscode://file/Users/s/a.md',
    '//example.com/x',
    '/Users/s/a.md',
    'https://',
    '',
    `https://example.com/${'a'.repeat(9000)}`,
    42,
    null,
  ])('refuses %j', (url) => {
    expect(externalWebUrl(url)).toBeNull()
  })

  it('tells the viewer’s own pages from everything else by origin', () => {
    expect(isViewerUrl('http://127.0.0.1:4319/', VIEWER)).toBe(true)
    expect(isViewerUrl('http://127.0.0.1:4319/#item=x', VIEWER)).toBe(true)
    expect(isViewerUrl('http://127.0.0.1:4320/', VIEWER)).toBe(false)
    expect(isViewerUrl('http://127.0.0.1:4319@evil.example/', VIEWER)).toBe(false)
    expect(isViewerUrl('http://localhost:4319/', VIEWER)).toBe(false)
    expect(isViewerUrl('not a url', VIEWER)).toBe(false)
  })

  it('opens only a checked href, and never lets a rejection escape', async () => {
    const opened: string[] = []
    const shell = { openExternal: async (url: string) => { opened.push(url); throw new Error('no browser') } }
    expect(openWebLink('javascript:alert(1)', shell)).toBe(false)
    expect(openWebLink('file:///Users/s/a.md', shell)).toBe(false)
    expect(openWebLink('https://example.com/x', shell)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(opened).toEqual(['https://example.com/x'])
  })
})

describe('local paths (issue #300)', () => {
  it('expands ~/, normalizes, and refuses anything that is not a plain absolute path', () => {
    expect(normalizeLocalPath('~/a/../b.md', '/Users/s')).toBe('/Users/s/b.md')
    expect(normalizeLocalPath('/Users/s//x/./y.md', '/Users/s')).toBe('/Users/s/x/y.md')
    for (const bad of ['relative/a.md', '~', '~other/x', '/Users/s/a\u0000.md', '/Users/s/a\n.md', '/Users/s/\u001b[0m', '', `/${'a'.repeat(5000)}`, 7, null]) {
      expect(normalizeLocalPath(bad, '/Users/s'), String(bad)).toBeNull()
    }
    expect(normalizeLocalPath('~/a.md', 'relative-home')).toBeNull()
  })

  it.each([
    'Evil.app', 'run.command', 'tool.TOOL', 'x.terminal', 'a.sh', 'a.zsh', 'a.py', 'a.pkg', 'a.mpkg', 'a.dmg', 'a.jar',
    'a.scpt', 'a.workflow', 'a.prefPane', 'a.webloc', 'a.inetloc', 'a.fileloc', 'a.mobileconfig', 'a.desktop',
    'a.AppImage', 'a.deb', 'a.exe', 'a.bat', 'a.cmd', 'a.ps1', 'a.docm', 'a.vsix', 'a.cer',
  ])('treats %s as never openable', (name) => {
    expect(blockedFileName(`/Users/s/${name}`)).toBe(true)
  })

  it.each(['a.md', 'a.markdown', 'a.txt', 'a.pdf', 'a.png', 'a.json', 'a.ts', 'a.js', 'a.html', '.zshrc', 'Makefile', 'a.app.md'])(
    'lets %s open', (name) => {
      expect(blockedFileName(`/Users/s/${name}`)).toBe(false)
    },
  )
})

describe('fileOpenPlan judges the final target (issue #300)', () => {
  function tree() {
    const root = scratchDir('link-open-')
    const file = (name: string, mode = 0o644) => {
      const path = join(root, name)
      writeFileSync(path, 'x')
      chmodSync(path, mode)
      return path
    }
    mkdirSync(join(root, 'folder'))
    mkdirSync(join(root, 'Tool.app'))
    const doc = file('doc.md')
    const script = file('run.command')
    const binary = file('binary', 0o755)
    const groupExec = file('notes.txt', 0o650)
    symlinkSync(doc, join(root, 'doc-link.md'))
    symlinkSync(script, join(root, 'innocent.md'))
    symlinkSync(binary, join(root, 'also-innocent.md'))
    symlinkSync(doc, join(root, 'launcher.command'))
    symlinkSync(join(root, 'Tool.app'), join(root, 'app-link'))
    symlinkSync(join(root, 'gone.md'), join(root, 'dangling.md'))
    return { root, doc, groupExec }
  }

  it('opens a plain document, resolved', async () => {
    const { root, doc } = tree()
    expect(await fileOpenPlan(join(root, 'doc.md'), { homeDir: root })).toMatchObject({ ok: true, action: 'open' })
    const viaLink = await fileOpenPlan(join(root, 'doc-link.md'), { homeDir: root })
    expect(viaLink).toMatchObject({ ok: true, action: 'open' })
    expect(viaLink.ok && viaLink.path.endsWith('/doc.md')).toBe(true)
    expect(await fileOpenPlan('~/doc.md', { homeDir: root })).toMatchObject({ ok: true, action: 'open' })
    expect(doc).toBeTruthy()
  })

  it.each([
    ['folder', 'folder'],
    ['Tool.app', 'app'],
    ['app-link', 'app'],
    ['run.command', 'blocked'],
    ['innocent.md', 'blocked'],
    ['launcher.command', 'blocked'],
    ['binary', 'executable'],
    ['also-innocent.md', 'executable'],
    ['notes.txt', 'executable'],
  ])('only reveals %s (%s)', async (name, reason) => {
    const { root } = tree()
    expect(await fileOpenPlan(join(root, name), { homeDir: root })).toMatchObject({ ok: true, action: 'reveal', reason })
  })

  it('reports a missing file, a dangling link and a bad path without touching anything', async () => {
    const { root } = tree()
    expect(await fileOpenPlan(join(root, 'nope.md'), { homeDir: root })).toEqual({ ok: false, reason: 'missing' })
    expect(await fileOpenPlan(join(root, 'dangling.md'), { homeDir: root })).toEqual({ ok: false, reason: 'missing' })
    expect(await fileOpenPlan(join(root, 'doc.md', 'below'), { homeDir: root })).toEqual({ ok: false, reason: 'missing' })
    expect(await fileOpenPlan('relative.md', { homeDir: root })).toEqual({ ok: false, reason: 'invalid' })
  })
})

describe('openLinkRequest (issue #300)', () => {
  function fakeShell() {
    const calls: Array<[string, string]> = []
    return {
      calls,
      shell: {
        openExternal: async (url: string) => { calls.push(['openExternal', url]) },
        openPath: async (path: string) => { calls.push(['openPath', path]); return '' },
        showItemInFolder: (path: string) => { calls.push(['showItemInFolder', path]) },
      },
    }
  }

  it('sends a checked web link to the browser and refuses any other scheme', async () => {
    const { calls, shell } = fakeShell()
    expect(await openLinkRequest({ kind: 'web', url: 'https://example.com/x' }, { shell, homeDir: '/Users/s' })).toEqual({ ok: true, action: 'opened' })
    expect(await openLinkRequest({ kind: 'web', url: 'file:///etc/passwd' }, { shell, homeDir: '/Users/s' })).toEqual({ ok: false, reason: 'invalid' })
    expect(calls).toEqual([['openExternal', 'https://example.com/x']])
  })

  it('opens a document, reveals a script, and reveals on request', async () => {
    const root = scratchDir('link-open-req-')
    writeFileSync(join(root, 'a.md'), 'x')
    writeFileSync(join(root, 'a.sh'), 'x')
    const { calls, shell } = fakeShell()
    const deps = { shell, homeDir: root }
    expect(await openLinkRequest({ kind: 'file', path: '~/a.md', reveal: false }, deps)).toEqual({ ok: true, action: 'opened' })
    expect(await openLinkRequest({ kind: 'file', path: join(root, 'a.sh'), reveal: false }, deps)).toEqual({ ok: true, action: 'revealed', reason: 'blocked' })
    expect(await openLinkRequest({ kind: 'file', path: join(root, 'a.md'), reveal: true }, deps)).toEqual({ ok: true, action: 'revealed', reason: 'requested' })
    expect(await openLinkRequest({ kind: 'file', path: join(root, 'missing.md'), reveal: true }, deps)).toEqual({ ok: false, reason: 'missing' })
    expect(calls.map(([call]) => call)).toEqual(['openPath', 'showItemInFolder', 'showItemInFolder'])
    expect(calls.every(([, path]) => !path.includes('~'))).toBe(true)
  })

  it.each([
    null,
    'https://example.com',
    [],
    { kind: 'web' },
    { kind: 'web', url: 'https://example.com', extra: 1 },
    { kind: 'file', path: '/Users/s/a.md' },
    { kind: 'file', path: '/Users/s/a.md', reveal: 'yes' },
    { kind: 'file', path: 42, reveal: false },
    { kind: 'app', path: '/Applications/X.app', reveal: false },
  ])('refuses the malformed request %j', async (request) => {
    const { calls, shell } = fakeShell()
    expect(await openLinkRequest(request, { shell, homeDir: '/Users/s' })).toEqual({ ok: false, reason: 'invalid' })
    expect(calls).toEqual([])
  })

  it('reports a failed open instead of throwing', async () => {
    const root = scratchDir('link-open-fail-')
    writeFileSync(join(root, 'a.md'), 'x')
    const shell = {
      openExternal: async () => { throw new Error('nope') },
      openPath: async () => 'no app for this',
      showItemInFolder: () => { throw new Error('nope') },
    }
    expect(await openLinkRequest({ kind: 'web', url: 'https://example.com' }, { shell, homeDir: root })).toEqual({ ok: false, reason: 'failed' })
    expect(await openLinkRequest({ kind: 'file', path: join(root, 'a.md'), reveal: false }, { shell, homeDir: root })).toEqual({ ok: false, reason: 'failed' })
    expect(await openLinkRequest({ kind: 'file', path: join(root, 'a.md'), reveal: true }, { shell, homeDir: root })).toEqual({ ok: false, reason: 'failed' })
  })
})

describe('isTrustedLinkSender (issue #300)', () => {
  function windowWith(contents: object, { destroyed = false, contentsDestroyed = false } = {}) {
    return {
      isDestroyed: () => destroyed,
      webContents: Object.assign(contents, { isDestroyed: () => contentsDestroyed }),
    }
  }
  const mainFrame = (url: string) => ({ url, parent: null })

  it('accepts only the viewer window’s own top frame on the viewer origin', () => {
    const contents = {}
    const window = windowWith(contents)
    const ok = { sender: contents, senderFrame: mainFrame('http://127.0.0.1:4319/#x'), window, viewerUrl: VIEWER }
    expect(isTrustedLinkSender(ok)).toBe(true)
    expect(isTrustedLinkSender({ ...ok, sender: {} })).toBe(false)
    expect(isTrustedLinkSender({ ...ok, senderFrame: mainFrame('https://evil.example/') })).toBe(false)
    expect(isTrustedLinkSender({ ...ok, senderFrame: mainFrame('http://127.0.0.1:4320/') })).toBe(false)
    expect(isTrustedLinkSender({ ...ok, senderFrame: { url: 'http://127.0.0.1:4319/', parent: {} } })).toBe(false)
    expect(isTrustedLinkSender({ ...ok, senderFrame: null })).toBe(false)
    expect(isTrustedLinkSender({ ...ok, window: null })).toBe(false)
    expect(isTrustedLinkSender({ ...ok, window: windowWith(contents, { destroyed: true }) })).toBe(false)
    expect(isTrustedLinkSender({ ...ok, window: windowWith(contents, { contentsDestroyed: true }) })).toBe(false)
  })

  it('treats a frame Electron has already disposed as untrusted', () => {
    const contents = {}
    const senderFrame = { get url(): string { throw new Error('Render frame was disposed') }, parent: null }
    expect(isTrustedLinkSender({ sender: contents, senderFrame, window: windowWith(contents), viewerUrl: VIEWER })).toBe(false)
  })
})

describe('Settings → Links rules, applied after the safety policy (issue #300 part 2)', () => {
  const SPAWN_OPTIONS = { stdio: 'ignore', shell: false, detached: true, windowsHide: true }

  // A spawn that records argv and options and answers as a real child would.
  function fakeSpawn({ exitCode = 0, fail = false }: { exitCode?: number, fail?: boolean } = {}) {
    const calls: Array<{ command: string, args: string[], options: unknown }> = []
    const spawnImpl = (command: string, args: string[], options: unknown) => {
      calls.push({ command, args, options })
      const child = Object.assign(new EventEmitter(), { unref: () => {} })
      queueMicrotask(() => {
        if (fail) child.emit('error', new Error('spawn ENOENT'))
        else {
          child.emit('spawn')
          child.emit('exit', exitCode)
        }
      })
      return child
    }
    return { calls, spawnImpl }
  }

  function recordingShell() {
    const calls: Array<[string, string]> = []
    return {
      calls,
      shell: {
        openExternal: async (url: string) => { calls.push(['openExternal', url]) },
        openPath: async (target: string) => { calls.push(['openPath', target]); return '' },
        showItemInFolder: (target: string) => { calls.push(['showItemInFolder', target]) },
      },
    }
  }

  function files() {
    const root = scratchDir('link-rules-')
    const file = (name: string, mode = 0o644) => {
      writeFileSync(join(root, name), 'x')
      chmodSync(join(root, name), mode)
      return realpathSync(join(root, name))
    }
    mkdirSync(join(root, 'docs.md'))
    const app = bundle(root, 'QLMarkdown')
    return {
      root, app, realApp: realpathSync(app),
      doc: file('notes.md'), log: file('run.log'), script: file('run.sh'), tool: file('tool.md', 0o755),
    }
  }

  // An .app bundle as the native picker would have accepted it.
  function bundle(root: string, name: string): string {
    const app = join(root, `${name}.app`)
    mkdirSync(join(app, 'Contents'), { recursive: true })
    writeFileSync(join(app, 'Contents', 'Info.plist'), '<plist/>')
    return app
  }

  const rules = (over: Record<string, unknown> = {}) =>
    ({ web: { handler: 'default' }, markdown: { handler: 'default' }, types: [], ...over }) as unknown as LinkRules

  it('opens Markdown in the app chosen in main’s picker, argv only: open -a <app> -- <file>', async () => {
    const { root, app, realApp, doc } = files()
    const { calls, spawnImpl } = fakeSpawn()
    const { calls: shellCalls, shell } = recordingShell()
    const result = await openLinkRequest({ kind: 'file', path: doc, reveal: false }, {
      shell, homeDir: root, rules: rules({ markdown: { handler: 'app', app } }), platform: 'darwin', spawnImpl,
    })
    expect(result).toEqual({ ok: true, action: 'opened' })
    expect(calls).toEqual([{ command: '/usr/bin/open', args: ['-a', realApp, '--', doc], options: SPAWN_OPTIONS }])
    expect(shellCalls).toEqual([])
  })

  it('previews with Quick Look, reveals by rule, and follows an added type', async () => {
    const { root, doc, log } = files()
    const { calls, spawnImpl } = fakeSpawn()
    const { calls: shellCalls, shell } = recordingShell()
    const deps = { shell, homeDir: root, platform: 'darwin', spawnImpl, rules: rules({ markdown: { handler: 'quicklook' }, types: [{ extension: 'log', handler: 'reveal' }] }) }
    expect(await openLinkRequest({ kind: 'file', path: doc, reveal: false }, deps)).toEqual({ ok: true, action: 'opened' })
    expect(await openLinkRequest({ kind: 'file', path: log, reveal: false }, deps)).toEqual({ ok: true, action: 'revealed', reason: 'rule' })
    expect(calls).toEqual([{ command: '/usr/bin/qlmanage', args: ['-p', doc], options: SPAWN_OPTIONS }])
    expect(shellCalls).toEqual([['showItemInFolder', log]])
  })

  it('never lets a rule open what the policy only reveals', async () => {
    const { root, app, script, tool } = files()
    const { calls, spawnImpl } = fakeSpawn()
    const { calls: shellCalls, shell } = recordingShell()
    const deps = {
      shell, homeDir: root, platform: 'darwin', spawnImpl,
      rules: rules({ markdown: { handler: 'app', app }, types: [{ extension: 'sh', handler: 'app', app }] }),
    }
    expect(await openLinkRequest({ kind: 'file', path: script, reveal: false }, deps)).toEqual({ ok: true, action: 'revealed', reason: 'blocked' })
    expect(await openLinkRequest({ kind: 'file', path: tool, reveal: false }, deps)).toEqual({ ok: true, action: 'revealed', reason: 'executable' })
    expect(await openLinkRequest({ kind: 'file', path: join(root, 'docs.md'), reveal: false }, deps)).toMatchObject({ ok: true, action: 'revealed', reason: 'folder' })
    expect(calls).toEqual([])
    expect(shellCalls.map(([call]) => call)).toEqual(['showItemInFolder', 'showItemInFolder', 'showItemInFolder'])
  })

  it('reveals on request whatever the rule says', async () => {
    const { root, doc } = files()
    const { calls, spawnImpl } = fakeSpawn()
    const { calls: shellCalls, shell } = recordingShell()
    expect(await openLinkRequest({ kind: 'file', path: doc, reveal: true }, {
      shell, homeDir: root, platform: 'darwin', spawnImpl, rules: rules({ markdown: { handler: 'quicklook' } }),
    })).toEqual({ ok: true, action: 'revealed', reason: 'requested' })
    expect(calls).toEqual([])
    expect(shellCalls).toEqual([['showItemInFolder', doc]])
  })

  it('reports an app that has gone, a launch that fails and an app that refused', async () => {
    const { root, app, doc } = files()
    const { shell } = recordingShell()
    const markdownApp = rules({ markdown: { handler: 'app', app } })
    const failing = fakeSpawn({ fail: true })
    expect(await openLinkRequest({ kind: 'file', path: doc, reveal: false }, { shell, homeDir: root, platform: 'darwin', rules: markdownApp, spawnImpl: failing.spawnImpl }))
      .toEqual({ ok: false, reason: 'failed' })
    const refusing = fakeSpawn({ exitCode: 1 })
    expect(await openLinkRequest({ kind: 'file', path: doc, reveal: false }, { shell, homeDir: root, platform: 'darwin', rules: markdownApp, spawnImpl: refusing.spawnImpl }))
      .toEqual({ ok: false, reason: 'failed' })
    rmSync(app, { recursive: true })
    const gone = fakeSpawn()
    expect(await openLinkRequest({ kind: 'file', path: doc, reveal: false }, { shell, homeDir: root, platform: 'darwin', rules: markdownApp, spawnImpl: gone.spawnImpl }))
      .toEqual({ ok: false, reason: 'app-missing' })
    expect(gone.calls).toEqual([])
  })

  it('keeps the system defaults off macOS', async () => {
    const { root, app, doc } = files()
    const { calls, spawnImpl } = fakeSpawn()
    const { calls: shellCalls, shell } = recordingShell()
    expect(await openLinkRequest({ kind: 'file', path: doc, reveal: false }, {
      shell, homeDir: root, platform: 'linux', spawnImpl, rules: rules({ markdown: { handler: 'app', app } }),
    })).toEqual({ ok: true, action: 'opened' })
    expect(calls).toEqual([])
    expect(shellCalls).toEqual([['openPath', doc]])
  })

  it('opens web links in the chosen browser, from the preload method and the window’s own open path', async () => {
    const { root, app, realApp } = files()
    const { calls, spawnImpl } = fakeSpawn()
    const { calls: shellCalls, shell } = recordingShell()
    const webApp = rules({ web: { handler: 'app', app } })
    expect(await openLinkRequest({ kind: 'web', url: 'https://example.com/a' }, { shell, homeDir: root, platform: 'darwin', spawnImpl, rules: webApp }))
      .toEqual({ ok: true, action: 'opened' })
    expect(openWebLink('https://example.com/b', shell, { platform: 'darwin', spawnImpl, readRules: async () => webApp })).toBe(true)
    expect(openWebLink('https://example.com/c', shell, { platform: 'darwin', spawnImpl, readRules: async () => { throw new Error('unreadable') } })).toBe(true)
    expect(openWebLink('file:///etc/passwd', shell, { platform: 'darwin', spawnImpl, readRules: async () => webApp })).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(calls.map((call) => call.args)).toEqual([['-a', realApp, '--', 'https://example.com/a'], ['-a', realApp, '--', 'https://example.com/b']])
    expect(shellCalls).toEqual([['openExternal', 'https://example.com/c']])
  })

  it('falls back to the default browser on the window’s own path when the chosen one has gone, is refused or fails', async () => {
    const { root, app, realApp } = files()
    const runner = bundle(root, 'Terminal')
    const settle = () => new Promise((resolve) => setTimeout(resolve, 10))
    for (const [chosen, spawned, exitCode] of [
      ['/Volumes/Gone/Firefox.app', false, 0],
      [runner, false, 0],
      [app, true, 1],
    ] as Array<[string, boolean, number]>) {
      const { calls, spawnImpl } = fakeSpawn({ exitCode })
      const { calls: shellCalls, shell } = recordingShell()
      const webApp = rules({ web: { handler: 'app', app: chosen } })
      expect(openWebLink('https://example.com/pr/1', shell, { platform: 'darwin', spawnImpl, readRules: async () => webApp })).toBe(true)
      await settle()
      expect(calls.map((call) => call.args), chosen).toEqual(spawned ? [['-a', realApp, '--', 'https://example.com/pr/1']] : [])
      expect(shellCalls, chosen).toEqual([['openExternal', 'https://example.com/pr/1']])
    }
  })

  it('checks the chosen app again at launch: its real path, its Info.plist and what it runs', async () => {
    const { root, doc } = files()
    const { shell } = recordingShell()
    const outside = join(root, 'plain-folder')
    mkdirSync(outside)
    const launcher = bundle(root, 'Python Launcher')
    const hollow = bundle(root, 'Hollow')
    rmSync(join(hollow, 'Contents', 'Info.plist'))
    const odd = bundle(root, 'Odd')
    rmSync(join(odd, 'Contents', 'Info.plist'))
    mkdirSync(join(odd, 'Contents', 'Info.plist'))
    const viewer = bundle(join(root, 'real'), 'Viewer')
    const shaped = join(root, 'NotAnApp')
    mkdirSync(join(shaped, 'Contents'), { recursive: true })
    writeFileSync(join(shaped, 'Contents', 'Info.plist'), '<plist/>')
    const link = (name: string, target: string) => {
      symlinkSync(target, join(root, name))
      return join(root, name)
    }
    for (const [app, reason] of [
      [bundle(root, 'Terminal'), 'app-refused'],
      [link('Disguised.app', launcher), 'app-refused'],
      [link('iTerm.app', viewer), 'app-refused'],
      [link('Bin.app', '/bin'), 'app-missing'],
      [link('Folder.app', outside), 'app-missing'],
      [link('Shaped.app', shaped), 'app-missing'],
      [hollow, 'app-missing'],
      [odd, 'app-missing'],
    ] as Array<[string, string]>) {
      const { calls, spawnImpl } = fakeSpawn()
      expect(await openLinkRequest({ kind: 'file', path: doc, reveal: false }, {
        shell, homeDir: root, platform: 'darwin', spawnImpl, rules: rules({ markdown: { handler: 'app', app } }),
      }), app).toEqual({ ok: false, reason })
      expect(calls, app).toEqual([])
    }
    const { calls, spawnImpl } = fakeSpawn()
    expect(await openLinkRequest({ kind: 'file', path: doc, reveal: false }, {
      shell, homeDir: root, platform: 'darwin', spawnImpl, rules: rules({ markdown: { handler: 'app', app: link('Alias.app', viewer) } }),
    })).toEqual({ ok: true, action: 'opened' })
    expect(calls.map((call) => call.args)).toEqual([['-a', realpathSync(viewer), '--', doc]])
  })
})
