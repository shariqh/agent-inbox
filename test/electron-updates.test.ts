import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

import updateController from '../electron/update-controller.cjs'
import type { UpdateArtifact, UpdateControllerState } from '../electron/update-controller.cjs'

function read(relPath: string): string {
  return readFileSync(join(import.meta.dirname, '..', relPath), 'utf8')
}

type UpdatesBridge = {
  download(...args: unknown[]): Promise<unknown> | false
  cancelDownload(...args: unknown[]): Promise<unknown> | false
  onState(callback: (state: unknown) => void): () => void
}

// Runs the real preload against a fake `electron`, so the validator is exercised
// rather than pinned as text.
function loadPreload(invoke: (channel: string, ...args: unknown[]) => unknown) {
  const exposed: Record<string, unknown> = {}
  const listeners = new Map<string, (event: unknown, payload: unknown) => void>()
  const electron = {
    contextBridge: { exposeInMainWorld: (name: string, api: unknown) => { exposed[name] = api } },
    ipcRenderer: {
      invoke: vi.fn(async (channel: string, ...args: unknown[]) => invoke(channel, ...args)),
      on: (channel: string, listener: (event: unknown, payload: unknown) => void) => { listeners.set(channel, listener) },
      removeListener: () => {},
    },
  }
  const factory = vm.runInThisContext(
    `(function (require, process) {\n${read('electron/setup-preload.cjs')}\n})`,
    { filename: 'setup-preload.cjs' },
  ) as (require: (id: string) => unknown, process: { argv: string[] }) => void
  factory((id) => {
    if (id !== 'electron') throw new Error(`unexpected require ${id}`)
    return electron
  }, { argv: ['--agent-inbox-updates=1'] })
  return {
    updates: exposed.agentInboxUpdates as UpdatesBridge,
    invoke: electron.ipcRenderer.invoke,
    deliver(state: unknown) { listeners.get('agent-inbox:update-state-changed')?.(null, state) },
  }
}

async function controllerStates(): Promise<UpdateControllerState[]> {
  const tag = 'v2.0.0'
  const filename = `Agent-Inbox-${tag}-universal.dmg`
  const artifact: UpdateArtifact = {
    version: '2.0.0',
    tag,
    platform: 'darwin',
    architecture: 'universal',
    packageType: 'dmg',
    installStrategy: 'macos-dmg',
    filename,
    url: `https://github.com/shariqh/agent-inbox/releases/download/${tag}/${filename}`,
    byteLength: 200,
    sha256: 'd'.repeat(64),
    minimumSystemVersion: '13.5',
  }
  const emitted: UpdateControllerState[] = []
  let progress: ((received: number) => void) | undefined
  let settle: { resolve(value: unknown): void; reject(error: unknown): void } | undefined
  const controller = updateController.createUpdateController({
    currentVersion: '1.0.0',
    preferences: {
      read: async () => ({ schema: 1, automaticChecks: false, lastNotifiedVersion: null }),
      setAutomatic: async () => ({ schema: 1, automaticChecks: false, lastNotifiedVersion: null }),
      setLastNotifiedVersion: async () => ({ schema: 1, automaticChecks: false, lastNotifiedVersion: null }),
    },
    checker: async () => ({
      status: 'available',
      currentVersion: '1.0.0',
      automaticChecks: false,
      checkedAt: '2026-02-01T00:00:00.000Z',
      message: 'A verified update is available.',
      available: {
        version: '2.0.0',
        tag,
        releaseUrl: `https://github.com/shariqh/agent-inbox/releases/tag/${tag}`,
        target: { packageType: 'dmg', installStrategy: 'macos-dmg' },
      },
      artifact,
    }),
    notifier: () => {},
    downloader: {
      normalize: (value) => value as UpdateArtifact,
      download: (_artifact, options) => new Promise((resolve, reject) => {
        progress = (received) => options?.onProgress?.(received, 200)
        settle = { resolve, reject }
      }),
      cancel: async () => {},
      prune: async () => {},
    },
    emit: (state) => emitted.push(state),
  })
  await controller.checkNow()
  const failed = controller.downloadNow()
  progress?.(50)
  settle?.reject(Object.assign(new Error('bad digest'), { code: 'hash-mismatch' }))
  await failed
  const verified = controller.downloadNow()
  progress?.(200)
  settle?.resolve({ path: '/private/x.dmg', version: '2.0.0', tag, filename, sha256: 'd'.repeat(64), byteLength: 200, packageType: 'dmg', installStrategy: 'macos-dmg' })
  await verified
  return emitted
}

describe('Electron updater integration', () => {
  it('exposes only the narrow validated preload bridge', () => {
    const preload = read('electron/setup-preload.cjs')

    expect(preload).toContain("contextBridge.exposeInMainWorld('agentInboxUpdates'")
    expect(preload).toContain('available: true')
    expect(preload).toContain("invokeUpdateState('agent-inbox:update-state')")
    expect(preload).toContain("invokeUpdateState('agent-inbox:update-check')")
    expect(preload).toContain("invokeUpdateState('agent-inbox:update-automatic', enabled)")
    expect(preload).toContain("ipcRenderer.invoke('agent-inbox:update-open-release')")
    expect(preload).toContain('openRelease(...args)')
    expect(preload).toContain('if (args.length !== 0) return false')
    expect(preload).toContain("ipcRenderer.on('agent-inbox:update-state-changed'")
    expect(preload).toContain("ipcRenderer.on('agent-inbox:open-updates'")
    expect(preload).toContain("invokeUpdateState('agent-inbox:update-download')")
    expect(preload).toContain("invokeUpdateState('agent-inbox:update-download-cancel')")
    expect(preload).not.toContain('child_process')
  })

  it('accepts every state the controller publishes through the real preload validator', async () => {
    const states = await controllerStates()
    expect(states.map((state) => state.status)).toEqual(expect.arrayContaining([
      'checking', 'available', 'downloading', 'download-failed', 'verified',
    ]))
    const { updates, deliver } = loadPreload(() => null)
    const received: unknown[] = []
    updates.onState((state) => received.push(state))
    for (const state of states) deliver(JSON.parse(JSON.stringify(state)))
    expect(received).toHaveLength(states.length)
  })

  it.each([
    ['a verified state without progress', { download: undefined }],
    ['progress beyond the signed length', { download: { receivedBytes: 201, totalBytes: 200 } }],
    ['an offer without its download capability', { available: { version: '2.0.0', tag: 'v2.0.0', releaseUrl: 'x', target: { packageType: 'dmg', installStrategy: 'macos-dmg' } } }],
    ['progress on a state that has no download', { status: 'current', available: undefined }],
  ])('rejects %s from main', async (_label, patch) => {
    const states = await controllerStates()
    const verified = states.find((state) => state.status === 'verified')!
    const malformed = JSON.parse(JSON.stringify({ ...verified, ...patch }))
    const { updates, invoke, deliver } = loadPreload(() => malformed)
    const received: unknown[] = []
    updates.onState((state) => received.push(state))
    deliver(malformed)
    expect(received).toEqual([])
    await expect(updates.download()).rejects.toThrow(TypeError)
    expect(updates.download('renderer-chosen-url')).toBe(false)
    expect(updates.cancelDownload('x')).toBe(false)
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('gates updates to packaged supported hosts and validates the live sender on every call', () => {
    const main = read('electron/main.cjs')

    expect(main).toContain('app.isPackaged')
    expect(main).toContain("new Set(['x64', 'arm64'])")
    expect(main).toContain("new Set(['darwin', 'linux'])")
    expect(main).toContain("ipcMain.handle('agent-inbox:update-state'")
    expect(main).toContain("ipcMain.handle('agent-inbox:update-check'")
    expect(main).toContain("ipcMain.handle('agent-inbox:update-automatic'")
    expect(main).toContain("ipcMain.handle('agent-inbox:update-open-release'")
    expect(main).toContain("ipcMain.handle('agent-inbox:update-download'")
    expect(main).toContain("ipcMain.handle('agent-inbox:update-download-cancel'")
    expect(main).toContain('sender !== updateWindow.webContents')
    expect(main).toContain('isTrustedUpdateSender(event.senderFrame?.url')
    expect(main).not.toContain('updateWindowWebContentsId')
    expect(main).toContain("updateWindow.webContents.send('agent-inbox:update-state-changed'")
    expect(main).toContain("win.webContents.on('did-finish-load'")
  })

  it('shows the core window before starting optional updater preference I/O', () => {
    const main = read('electron/main.cjs')
    const didFinishLoad = main.slice(
      main.indexOf("win.webContents.on('did-finish-load'"),
      main.indexOf("win.on('closed'"),
    )

    expect(didFinishLoad).not.toContain('await updateController.rendererReady()')
    expect(didFinishLoad.indexOf('win.show()')).toBeGreaterThan(-1)
    expect(didFinishLoad.indexOf('refreshUpdatesAfterLoad()')).toBeGreaterThan(didFinishLoad.indexOf('win.show()'))
    expect(main).toContain('updateController.rendererReady().then(sendUpdateState).catch(() => {')
  })

  it('uses a dedicated menu event and revalidates the main-owned release URL at openExternal', () => {
    const main = read('electron/main.cjs')
    const updateMenu = main.slice(
      main.indexOf("label: 'Check for Updates…'"),
      main.indexOf('const settings = {'),
    )

    expect(main).toContain("label: 'Check for Updates…'")
    expect(main).toContain("win.webContents.send('agent-inbox:open-updates')")
    expect(updateMenu).not.toContain('toggle-settings')
    expect(main).toContain('validateReleaseUrl(')
    expect(main).toContain('shell.openExternal(releaseUrl)')
    expect(main).toContain('MANUAL_RELEASES_URL')
    expect(main).not.toMatch(/update-open-release[\s\S]{0,100}\(event,\s*url\)/)
  })

  it('keeps update failures out of the attention and badge graph', () => {
    for (const file of ['electron/update-controller.cjs', 'electron/update-download.cjs']) {
      const source = read(file)
      expect(source).not.toContain('attention')
      expect(source).not.toContain('setBadgeCount')
    }
  })

  it('starts downloads only from a trusted, argument-free request and never awaits them over IPC', () => {
    const main = read('electron/main.cjs')
    const handler = (channel: string) => {
      const start = main.indexOf(`ipcMain.handle('${channel}'`)
      return main.slice(start, main.indexOf('\n})', start))
    }

    for (const channel of ['agent-inbox:update-download', 'agent-inbox:update-download-cancel']) {
      expect(handler(channel)).toContain('args.length !== 0 || !isTrustedUpdateSender(event.senderFrame?.url')
    }
    expect(handler('agent-inbox:update-download')).toContain('updateController.downloadNow().catch(() => {})')
    expect(handler('agent-inbox:update-download')).not.toContain('await')
    expect(main).toContain('includeArtifact: true')
    expect(main).toContain("directory: path.join(app.getPath('userData'), 'update-downloads')")
    expect(main).toMatch(/app\.on\('will-quit'[\s\S]*updateController\?\.dispose\(\)/)
  })

  it('keeps the downloader a pure fetch-and-verify module outside the MCP graph', () => {
    const downloader = read('electron/update-download.cjs')
    for (const forbidden of ['child_process', "require('electron')", 'shell', 'openPath', 'hdiutil', '0o755']) {
      expect(downloader, forbidden).not.toContain(forbidden)
    }
    for (const name of readdirSync(join(import.meta.dirname, '..', 'src')).filter((file) => file.endsWith('.ts'))) {
      expect(read(`src/${name}`), name).not.toContain('update-download')
    }
  })

  it('forwards the verified-version recorder and lets stale update states reach the renderer', () => {
    const main = read('electron/main.cjs')
    const initializer = main.slice(
      main.indexOf('function initializeUpdateController()'),
      main.indexOf('async function startOwnServer()'),
    )

    expect(main).toContain("const { createUpdatePreferences, createUpdateTrustState } = require('./update-preferences.cjs')")
    expect(initializer).toContain('trustState: createUpdateTrustState({ app }),')
    expect(initializer).toContain('checker: ({ currentVersion, automaticChecks, recordVerifiedVersion }) => checkForUpdate({')
    expect(initializer).toMatch(/checkForUpdate\(\{[^}]*\n\s+recordVerifiedVersion,\n/)
    expect(read('electron/setup-preload.cjs')).toMatch(/const UPDATE_STATE_VALUES = new Set\(\[[^\]]*'stale'/)
  })

  it('mounts Updates before the setup fetch and keeps the compact controls usable', () => {
    const app = read('public/app.js')
    const css = read('public/style.css')
    const renderSetup = app.slice(app.indexOf('async function renderSetup()'), app.indexOf('// ── init'))

    expect(renderSetup.indexOf('renderUpdateSettings(host)')).toBeLessThan(renderSetup.indexOf('try {'))
    expect(app).toContain('window.agentInboxUpdates?.onOpenUpdates?.(openUpdates)')
    expect(app).toContain("if (!settingsOpen()) showPanel('setup')")
    expect(app).toContain("section.scrollIntoView({ block: 'center' })")
    expect(app).not.toContain("section.scrollIntoView({ block: 'start' })")
    expect(css).toContain('.updates-actions button {\n  min-height: 44px;')
    expect(css).toContain('.updates-actions { display: grid; grid-template-columns: minmax(0, 1fr); }')
  })
})
