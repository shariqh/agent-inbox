import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import links from '../electron/link-open.cjs'
import { removeScratchDirs, scratchDir } from './scratch.js'

function read(relPath: string): string {
  return readFileSync(join(import.meta.dirname, '..', relPath), 'utf8')
}

type LinksBridge = { open(...args: unknown[]): Promise<unknown>; filesAvailable(...args: unknown[]): Promise<unknown> }

afterEach(() => removeScratchDirs())

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
  return { links: exposed.agentInboxLinks as LinksBridge, invoke }
}

describe('the link bridge (issue #300)', () => {
  it('is one method that passes a fresh, well-formed request to one channel', async () => {
    const { links, invoke } = loadPreload(() => ({ ok: true, action: 'opened' }))
    // open() and a read of whether this page may open local files, nothing else
    expect(Object.keys(links)).toEqual(['open', 'filesAvailable'])
    await expect(links.open({ kind: 'file', path: '/Users/s/a.md', reveal: false, app: '/Applications/X.app' }))
      .resolves.toEqual({ ok: true, action: 'opened' })
    await links.open({ kind: 'web', url: 'https://example.com/x', extra: true })
    expect(invoke.mock.calls).toEqual([
      ['agent-inbox:open-link', { kind: 'file', path: '/Users/s/a.md' }],
      ['agent-inbox:open-link', { kind: 'web', url: 'https://example.com/x' }],
    ])
  })

  it.each([
    [[]],
    [[{ kind: 'web', url: 'https://example.com' }, 'second argument']],
    [[null]],
    [['https://example.com']],
    [[{ kind: 'file' }]],
    [[{ kind: 'file', path: 7 }]],
    [[{ kind: 'shell', command: 'open -a Calculator' }]],
  ])('refuses %j without asking main', async (args) => {
    const { links, invoke } = loadPreload(() => ({ ok: true, action: 'opened' }))
    await expect(links.open(...args)).resolves.toEqual({ ok: false, reason: 'invalid' })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('hands back only a well-formed answer', async () => {
    const request = { kind: 'file', path: '/Users/s/a.sh' }
    for (const [answer, expected] of [
      [{ ok: true, action: 'revealed', reason: 'blocked', path: '/private/x' }, { ok: true, action: 'revealed', reason: 'blocked' }],
      [{ ok: true, action: 'revealed', reason: 'type' }, { ok: true, action: 'revealed', reason: 'type' }],
      [{ ok: false, reason: 'missing' }, { ok: false, reason: 'missing' }],
      [{ ok: false, reason: 'unowned' }, { ok: false, reason: 'unowned' }],
      [{ ok: true, action: 'revealed', reason: 'requested' }, { ok: false, reason: 'failed' }],
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
    new Function(
      'ipcMain', 'isTrustedLinkSender', 'openLinkRequest', 'shell', 'app', 'URL_BASE', 'linkWindow', 'installBinding', 'granted',
      `let fileLinkWebContentsId = granted\n${main.slice(start, end)}`,
    )(
      { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, fn) },
      links.isTrustedLinkSender, links.openLinkRequest, shell, { getPath: () => '/Users/s' }, VIEWER,
      { isDestroyed: () => false, webContents: contents }, installBinding, granted,
    )
    const event = (sender: object = contents) => ({ sender, senderFrame: { url: `${VIEWER}#item=x`, parent: null } })
    return {
      open: (request: unknown, sender?: object) => handlers.get('agent-inbox:open-link')!(event(sender), request),
      available: (sender?: object, ...args: unknown[]) => handlers.get('agent-inbox:link-files-available')!(event(sender), ...args),
      calls, installBinding,
    }
  }

  it('opens a file for the window the binding granted, and refuses it, unread, anywhere else', async () => {
    const root = scratchDir('link-owned-')
    writeFileSync(join(root, 'spec.md'), '# spec')
    const file = { kind: 'file', path: join(root, 'spec.md') }
    const owned = world({ granted: 7 })
    expect(await owned.open(file)).toEqual({ ok: true, action: 'opened' })
    expect(owned.calls).toEqual([['openPath', realpathSync(join(root, 'spec.md'))]])

    for (const granted of [null, 8]) {
      const reused = world({ granted })
      expect(await reused.open(file), String(granted)).toEqual({ ok: false, reason: 'unowned' })
      expect(await reused.open({ kind: 'file', path: '/nowhere.md' })).toEqual({ ok: false, reason: 'unowned' })
      expect(reused.calls).toEqual([])
    }
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
    expect(main).toMatch(/setWindowOpenHandler\(\(\{ url \}\) => \{\s*openWebLink\(url, shell\)\s*return \{ action: 'deny' \}/)
    expect(main).toMatch(/'will-navigate', \(e, url\) => \{\s*if \(isViewerUrl\(url, URL_BASE\)\) return\s*e\.preventDefault\(\)\s*openWebLink\(url, shell\)/)
  })

  it('never opens a file any other way', () => {
    expect(main).not.toMatch(/shell\.(openPath|showItemInFolder)\(/)
    expect(read('electron/setup-preload.cjs')).not.toMatch(/require\('(?!electron')/)
  })
})
