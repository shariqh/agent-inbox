import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import navigation from '../electron/viewer-navigation.cjs'

const main = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8')
const URL_BASE = 'http://127.0.0.1:4319/'
const modes = ['initial load', 'failover reload'] as const

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function viewerWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    loadURL: vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined),
    webContents: {
      isDestroyed: vi.fn(() => false),
      reload: vi.fn(),
      executeJavaScript: vi.fn(),
      session: {
        clearCache: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
        clearStorageData: vi.fn(),
        clearData: vi.fn(),
        cookies: { remove: vi.fn() },
      },
    },
  }
}

function navigate(mode: typeof modes[number], win: ReturnType<typeof viewerWindow>) {
  return mode === 'initial load'
    ? navigation.loadViewer(win, URL_BASE)
    : navigation.reloadViewer(win)
}

describe.each(modes)('Electron %s HTTP cache', (mode) => {
  it('waits for HTTP-cache clearing before navigation and leaves browser storage alone', async () => {
    const win = viewerWindow()
    const cache = deferred()
    const session = win.webContents.session
    session.clearCache.mockReturnValue(cache.promise)

    const result = navigate(mode, win)
    expect(session.clearCache).toHaveBeenCalledExactlyOnceWith()
    await Promise.resolve()
    expect(win.loadURL).not.toHaveBeenCalled()
    expect(win.webContents.reload).not.toHaveBeenCalled()

    cache.resolve()
    await result
    if (mode === 'initial load') {
      expect(win.loadURL).toHaveBeenCalledExactlyOnceWith(URL_BASE)
      expect(win.webContents.reload).not.toHaveBeenCalled()
    } else {
      expect(win.webContents.reload).toHaveBeenCalledExactlyOnceWith()
      expect(win.loadURL).not.toHaveBeenCalled()
    }
    expect(session.clearStorageData).not.toHaveBeenCalled()
    expect(session.clearData).not.toHaveBeenCalled()
    expect(session.cookies.remove).not.toHaveBeenCalled()
    expect(win.webContents.executeJavaScript).not.toHaveBeenCalled()
  })

  it('propagates a cache-clear failure without navigating or retrying', async () => {
    const win = viewerWindow()
    const failure = new Error('HTTP cache could not be cleared')
    win.webContents.session.clearCache.mockRejectedValue(failure)

    await expect(navigate(mode, win)).rejects.toBe(failure)
    expect(win.webContents.session.clearCache).toHaveBeenCalledTimes(1)
    expect(win.loadURL).not.toHaveBeenCalled()
    expect(win.webContents.reload).not.toHaveBeenCalled()
  })

  it('propagates navigation errors after the cache has been cleared', async () => {
    const win = viewerWindow()
    const failure = new Error('navigation failed')
    win.loadURL.mockRejectedValue(failure)
    win.webContents.reload.mockImplementation(() => { throw failure })

    await expect(navigate(mode, win)).rejects.toBe(failure)
    expect(win.webContents.session.clearCache).toHaveBeenCalledExactlyOnceWith()
  })

  it('does not touch a window that has already closed', async () => {
    const win = viewerWindow()
    win.isDestroyed.mockReturnValue(true)

    await navigate(mode, win)
    expect(win.webContents.session.clearCache).not.toHaveBeenCalled()
    expect(win.loadURL).not.toHaveBeenCalled()
    expect(win.webContents.reload).not.toHaveBeenCalled()
  })

  it.each(['window', 'webContents'])('does not navigate when %s closes during cache clearing', async (target) => {
    const win = viewerWindow()
    const cache = deferred()
    win.webContents.session.clearCache.mockReturnValue(cache.promise)

    const result = navigate(mode, win)
    const closing = target === 'window' ? win : win.webContents
    closing.isDestroyed.mockReturnValue(true)
    cache.resolve()

    await result
    expect(win.loadURL).not.toHaveBeenCalled()
    expect(win.webContents.reload).not.toHaveBeenCalled()
  })
})

describe('Electron viewer cache wiring', () => {
  it('awaits the same cache-aware navigation boundary at startup and failover', () => {
    expect(main.includes("require('./viewer-navigation.cjs')")).toBe(true)
    expect(main).toContain('await loadViewer(win, URL_BASE)')
    expect(main).toContain('await reloadViewer(win)')
    expect(main).not.toContain('win.loadURL(')
    expect(main).not.toContain('win.webContents.reload(')
  })

  it('reports startup failures and quits through normal cleanup rather than continuing', () => {
    expect(
      /try \{\s*await loadViewer\(win, URL_BASE\)\s*\} catch \(err\) \{\s*console\.error\([^\n]+, err\)\s*app\.quit\(\)\s*return\s*\}/.test(main),
    ).toBe(true)
  })

  it('handles failover navigation rejection instead of leaving an unhandled async callback', () => {
    expect(
      /try \{\s*await reloadViewer\(win\)\s*\} catch \(err\) \{\s*console\.error\([^\n]+, err\)\s*\}/.test(main),
    ).toBe(true)
  })
})

// #279: unsent drafts live in the profile's localStorage, which Chromium may
// still hold in memory when the app quits. Every window has closed, and run
// its pagehide save, before will-quit, so that is where they are committed.
describe('Electron keeps browser storage through a quit', () => {
  const OPEN = "app.on('will-quit', () => {"
  const start = main.indexOf(OPEN)
  const willQuit = main.slice(start + OPEN.length, main.indexOf('\n})', start))

  function quit(ready: boolean) {
    const flushStorageData = vi.fn()
    const dispose = vi.fn()
    new Function('app', 'session', 'updateController', 'spawnedViewer', willQuit)(
      { isReady: () => ready },
      { defaultSession: { flushStorageData } },
      { dispose },
      null,
    )
    return { flushStorageData, dispose }
  }

  it('commits DOM storage to disk on every quit, update restarts included', () => {
    expect(start).toBeGreaterThan(-1)
    const { flushStorageData, dispose } = quit(true)
    expect(flushStorageData).toHaveBeenCalledExactlyOnceWith()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('never asks for the default session before the app is ready', () => {
    const { flushStorageData, dispose } = quit(false)
    expect(flushStorageData).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledOnce()
  })
})
