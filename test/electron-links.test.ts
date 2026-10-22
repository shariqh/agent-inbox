import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

function read(relPath: string): string {
  return readFileSync(join(import.meta.dirname, '..', relPath), 'utf8')
}

type LinksBridge = { open(...args: unknown[]): Promise<unknown> }

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
      [{ ok: false, reason: 'missing' }, { ok: false, reason: 'missing' }],
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
    const handler = main.slice(main.indexOf("ipcMain.handle('agent-inbox:open-link'"), main.indexOf("ipcMain.handle('agent-inbox:set-theme-preference'"))
    expect(handler).toContain('isTrustedLinkSender({ sender: event.sender, senderFrame: event.senderFrame, window: linkWindow, viewerUrl: URL_BASE })')
    expect(handler).toContain("if (args.length !== 0 || !trusted) return { ok: false, reason: 'unavailable' }")
    expect(handler).toContain("return openLinkRequest(request, { shell, homeDir: app.getPath('home') })")
    expect(main).toContain('  linkWindow = win\n')
    expect(main).toContain('    if (linkWindow === win) linkWindow = null\n')
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
