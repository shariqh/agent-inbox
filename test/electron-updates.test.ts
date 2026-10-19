import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

import updateController from '../electron/update-controller.cjs'
import type { UpdateArtifact, UpdateControllerState } from '../electron/update-controller.cjs'

const setupRunner = createRequire(import.meta.url)('../electron/setup-runner.cjs') as {
  createInstallGate(): {
    running(): boolean
    quitting(): boolean
    beginQuit(): Promise<void> | null
    run(start: (onCancel: (cancel: () => void) => void) => Promise<unknown>): { promise: Promise<unknown> } | { refused: string }
  }
}

function read(relPath: string): string {
  return readFileSync(join(import.meta.dirname, '..', relPath), 'utf8')
}

type UpdatesBridge = {
  download(...args: unknown[]): Promise<unknown> | false
  cancelDownload(...args: unknown[]): Promise<unknown> | false
  install(...args: unknown[]): Promise<unknown> | false
  restart(...args: unknown[]): Promise<boolean> | false
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
  let stale = true
  let feasible = false
  let setupRunning = true
  let reopenFails = true
  let permitted = true
  const record = {
    path: '/private/x.dmg', version: '2.0.0', tag, filename, sha256: 'd'.repeat(64), byteLength: 200,
    packageType: 'dmg' as const, installStrategy: 'macos-dmg' as const, minimumSystemVersion: '13.5',
  }
  const controller = updateController.createUpdateController({
    currentVersion: '1.0.0',
    preferences: {
      read: async () => ({ schema: 1, automaticChecks: false, lastNotifiedVersion: null }),
      setAutomatic: async () => ({ schema: 1, automaticChecks: false, lastNotifiedVersion: null }),
      setLastNotifiedVersion: async () => ({ schema: 1, automaticChecks: false, lastNotifiedVersion: null }),
    },
    checker: async () => (stale
      ? {
          status: 'stale',
          currentVersion: '1.0.0',
          automaticChecks: false,
          checkedAt: '2026-02-01T00:00:00.000Z',
          message: 'Update information is older than a release this app already verified.',
        }
      : {
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
      openVerified: async (value) => {
        if (reopenFails) {
          reopenFails = false
          throw Object.assign(new Error('changed on disk'), { code: 'not-verified' })
        }
        return {
          record: value,
          handle: {
            read: async () => ({ bytesRead: 0 }),
            stat: async () => ({ isFile: () => true, size: 200 }),
            write: async () => ({ bytesWritten: 0 }),
            sync: async () => {},
            close: async () => {},
          },
          close: async () => {},
        }
      },
    },
    installers: {
      'macos-dmg': {
        strategy: 'macos-dmg',
        feasibility: async () => (feasible
          ? { ok: true }
          : { ok: false, reason: 'translocated', message: 'Move Agent Inbox to your Applications folder to install updates from the app.' }),
        prepare: async () => ({ commit: async () => {}, discard: async () => {} }),
      },
    },
    isSetupRunning: () => setupRunning,
    isInstallPermitted: () => permitted,
    requestRestart: () => {},
    attemptStore: {
      begin: async () => ({ resultPath: '/private/update-install/last-attempt.result' }),
      abandon: async () => {},
      take: async () => ({ from: '1.0.0', to: '2.0.0', at: '2026-02-01T00:00:00.000Z', platform: 'darwin', strategy: 'macos-dmg', exitCode: 70 }),
    },
    emit: (state) => emitted.push(state),
  })
  await controller.rendererReady()
  const download = async (outcome: 'fail' | 'verify') => {
    const pending = controller.downloadNow()
    if (outcome === 'fail') {
      progress?.(50)
      settle?.reject(Object.assign(new Error('bad digest'), { code: 'hash-mismatch' }))
    } else {
      progress?.(200)
      settle?.resolve(record)
    }
    await pending
  }
  await controller.checkNow()
  stale = false
  await controller.checkNow()
  feasible = true
  await controller.checkNow()
  await download('fail')
  await download('verify')
  await controller.installNow()
  setupRunning = false
  await controller.installNow()
  await download('verify')
  // A window main no longer lets install (#216): the offer says so, and main's refusal keeps the download.
  permitted = false
  controller.refreshInstallPermission()
  controller.refuseInstall('Restart Agent Inbox to install this update.')
  permitted = true
  controller.refreshInstallPermission()
  await controller.installNow()
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
    expect(preload).toContain("invokeUpdateState('agent-inbox:update-install')")
    expect(preload).toContain("ipcRenderer.invoke('agent-inbox:update-restart')")
    expect(preload).toContain('restart(...args)')
    expect(preload).not.toContain('child_process')
  })

  it('accepts every state the controller publishes through the real preload validator', async () => {
    const states = await controllerStates()
    expect(states.map((state) => state.status)).toEqual(expect.arrayContaining([
      'checking', 'stale', 'available', 'downloading', 'download-failed', 'verified', 'installing', 'install-failed',
    ]))
    expect(states.some((state) => state.available?.reason !== undefined && state.available.installable === false)).toBe(true)
    expect(states.some((state) => state.status === 'verified' && state.available?.installable === true)).toBe(true)
    expect(states.filter((state) => state.status === 'download-failed').map((state) => state.download?.receivedBytes)).toEqual([50, 0])
    expect(states.some((state) => typeof state.installNotice === 'string' && state.status === 'idle')).toBe(true)
    expect(states.some((state) => typeof state.installNotice === 'string' && state.status === 'verified')).toBe(true)
    // #216: every offer says whether this window may install it, both ways.
    expect(states.every((state) => !state.available || typeof state.available.installPermitted === 'boolean')).toBe(true)
    for (const status of ['verified', 'install-failed'] as const) {
      expect(states.some((state) => state.status === status && state.available?.installable === true && !state.available.installPermitted)).toBe(true)
      expect(states.some((state) => state.status === status && state.available?.installPermitted === true)).toBe(true)
    }
    expect(states.at(-1)).toMatchObject({ status: 'installing' })
    expect(states.at(-1)).not.toHaveProperty('installNotice')
    expect(JSON.stringify(states)).not.toContain('/private/')
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
    expect(updates.install('renderer-chosen-path')).toBe(false)
    expect(invoke).toHaveBeenCalledOnce()
  })

  it.each([
    ['an install while the offer is not installable', 'installing', { available: { installable: false } }],
    ['an install state with download progress', 'install-failed', { download: { receivedBytes: 1, totalBytes: 200 } }],
    ['an offer without its install capability', 'verified', { available: { installable: undefined } }],
    ['a reason on an installable offer', 'verified', { available: { reason: 'Move it.' } }],
    ['a reason that is not text', 'available', { available: { installable: false, downloadable: false, reason: 5 } }],
    ['an installable offer that cannot download', 'verified', { available: { downloadable: false } }],
    ['an install notice that is not text', 'verified', { installNotice: 5 }],
    ['an overlong install notice', 'verified', { installNotice: 'x'.repeat(401) }],
    ['an offer without its install permission', 'verified', { available: { installPermitted: undefined } }],
    ['an install permission that is not a boolean', 'verified', { available: { installPermitted: 'yes' } }],
    ['a permitted install of an offer that cannot install', 'available', { available: { installPermitted: true } }],
  ] as const)('rejects %s from main', async (_label, status, patch) => {
    const states = await controllerStates()
    const base = states.find((state) => state.status === status)!
    const malformed = JSON.parse(JSON.stringify({
      ...base,
      ...patch,
      ...('available' in patch ? { available: { ...base.available, ...patch.available } } : {}),
    }))
    const { updates, invoke, deliver } = loadPreload(() => malformed)
    const received: unknown[] = []
    updates.onState((state) => received.push(state))
    deliver(malformed)
    expect(received).toEqual([])
    await expect(updates.install()).rejects.toThrow(TypeError)
    expect(invoke).toHaveBeenCalledWith('agent-inbox:update-install')
  })

  it('restarts only on an argument-free request and reports only a plain true', async () => {
    let answer: unknown = true
    const { updates, invoke } = loadPreload(() => answer)
    expect(updates.restart('renderer-chosen-argv')).toBe(false)
    expect(invoke).not.toHaveBeenCalled()
    await expect(updates.restart()).resolves.toBe(true)
    expect(invoke).toHaveBeenCalledWith('agent-inbox:update-restart')
    answer = 'yes'
    await expect(updates.restart()).resolves.toBe(false)
  })

  // #216: a window main no longer lets install gets Restart Agent Inbox on macOS.
  // main's own handler and restart function are evaluated against fakes.
  function restartHandler(platform: string, options: { quitting?: boolean; installing?: boolean } = {}) {
    const main = read('electron/main.cjs')
    const marker = "ipcMain.handle('agent-inbox:update-restart', "
    const start = main.indexOf(marker)
    expect(start).toBeGreaterThan(-1)
    const body = main.slice(start + marker.length, main.indexOf('\n})', start) + 2)
    const gate = setupRunner.createInstallGate()
    if (options.quitting) gate.beginQuit()
    const restartToInstallUpdate = vi.fn()
    const handler = new Function(
      'process', 'isTrustedUpdateSender', 'installGate', 'updateController', 'restartToInstallUpdate',
      `return ${body}`,
    )(
      { platform },
      (url: string) => url === 'http://127.0.0.1:4319/',
      gate,
      { isInstalling: () => options.installing === true },
      restartToInstallUpdate,
    ) as (event: unknown, ...args: unknown[]) => unknown
    const event = (url = 'http://127.0.0.1:4319/') => ({ senderFrame: { url }, sender: {} })
    return { handler, event, restartToInstallUpdate }
  }

  it('restarts on macOS only, for the trusted window, and never mid-install or once a quit has begun', () => {
    const mac = restartHandler('darwin')
    expect(mac.handler(mac.event(), 'x')).toBe(false)
    expect(mac.handler(mac.event('https://example.com/'))).toBe(false)
    expect(mac.restartToInstallUpdate).not.toHaveBeenCalled()
    expect(mac.handler(mac.event())).toBe(true)
    expect(mac.restartToInstallUpdate).toHaveBeenCalledOnce()

    // An AppImage relaunched by Electron would start from its mount, gone once the app exits.
    for (const refused of [
      restartHandler('linux'),
      restartHandler('darwin', { quitting: true }),
      restartHandler('darwin', { installing: true }),
    ]) {
      expect(refused.handler(refused.event())).toBe(false)
      expect(refused.restartToInstallUpdate).not.toHaveBeenCalled()
    }
  })

  it('restarts through the path every quit takes: beginAppQuit() first, then relaunch and quit', () => {
    const main = read('electron/main.cjs')
    const start = main.indexOf('function restartToInstallUpdate()')
    expect(start).toBeGreaterThan(-1)
    const source = main.slice(start, main.indexOf('\n}\n', start) + 2)
    const calls: string[] = []
    const app = { relaunch: () => calls.push('relaunch'), quit: () => calls.push('quit') }
    const restart = new Function('beginAppQuit', 'app', `${source}\nreturn restartToInstallUpdate`)(
      () => calls.push('beginAppQuit'),
      app,
    ) as () => void
    restart()
    expect(calls).toEqual(['beginAppQuit', 'relaunch', 'quit'])
    // Not the committed update's restart: there the helper reopens the app, not Electron.
    expect(source).not.toContain('updateRestartRequested')
    expect(main.match(/restartToInstallUpdate\(\)/g)).toHaveLength(2)
  })

  it('tells Settings whether the install IPC would accept its window right now', () => {
    const main = read('electron/main.cjs')
    expect(main).toContain('isInstallPermitted: updateInstallPermitted,')
    const start = main.indexOf('function updateInstallPermitted()')
    expect(start).toBeGreaterThan(-1)
    const source = main.slice(start, main.indexOf('\n}\n', start) + 2)
    const permitted = (bound: number | null, options: { quitting?: boolean; window?: 'none' | 'destroyed' | 'contents-destroyed' } = {}) => {
      const gate = setupRunner.createInstallGate()
      if (options.quitting) gate.beginQuit()
      const updateWindow = options.window === 'none' ? null : {
        isDestroyed: () => options.window === 'destroyed',
        webContents: { id: 7, isDestroyed: () => options.window === 'contents-destroyed' },
      }
      return new Function('installGate', 'updateWindow', 'updateInstallWebContentsId', `${source}\nreturn updateInstallPermitted()`)(
        gate, updateWindow, bound,
      ) as boolean
    }
    expect(permitted(7)).toBe(true)
    for (const refused of [
      permitted(null),
      permitted(8),
      permitted(7, { quitting: true }),
      permitted(7, { window: 'none' }),
      permitted(7, { window: 'destroyed' }),
      permitted(7, { window: 'contents-destroyed' }),
    ]) {
      expect(refused).toBe(false)
    }
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
    for (const file of [
      'electron/update-controller.cjs',
      'electron/update-download.cjs',
      'electron/update-install.cjs',
      'electron/update-install-macos.cjs',
      'electron/update-install-appimage.cjs',
    ]) {
      const source = read(file)
      expect(source).not.toContain('attention')
      expect(source).not.toContain('setBadgeCount')
    }
    // #216: whether a window may install is update state too, never attention.
    const attention = read('public/attention.js')
    for (const token of ['installPermitted', 'installable', 'agentInboxUpdates', 'update-restart']) {
      expect(attention, token).not.toContain(token)
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
      expect(read(`src/${name}`), name).not.toContain('update-install')
    }
  })

  it('runs install binaries only by absolute path with argv arrays, outside Electron and the MCP graph', () => {
    const contract = read('electron/update-install.cjs')
    const mac = read('electron/update-install-macos.cjs')
    const appImage = read('electron/update-install-appimage.cjs')
    for (const source of [contract, mac, appImage]) {
      expect(source).not.toContain("require('electron')")
      expect(source).not.toMatch(/shell:\s*true/)
      expect(source).not.toMatch(/\bexec(Sync)?\(/)
      expect(source).not.toContain('execSync')
      expect(source).not.toContain('spawnSync')
    }
    expect(contract).not.toContain('child_process')
    expect(mac).toContain("require('node:child_process')")
    // The AppImage installer starts its one helper only through the injected spawn.
    expect(appImage).not.toContain('child_process')
    expect(appImage).toContain("const HELPER_SHELL = '/bin/sh'")
  })

  it('registers the AppImage installer only for an owned viewer of a packaged app proven to run from its AppImage, never via app.relaunch', () => {
    const main = read('electron/main.cjs')
    const start = main.indexOf('function appImageInstallers()')
    const registration = main.slice(start, main.indexOf('\n}', start))

    expect(main).toContain("const { createAppImageInstaller } = require('./update-install-appimage.cjs')")
    expect(main).toContain("const { checkForUpdate, runsFromAppImage } = require('./update-fetch.cjs')")
    expect(main).toContain("if (process.platform === 'linux') return appImageInstallers()")
    // The same proof that selects the AppImage target: a bare inherited APPIMAGE registers nothing,
    // so no installer's startup report can take another AppImage copy's attempt record.
    expect(registration).toContain(
      'const fromAppImage = runsFromAppImage({ appImagePath: process.env.APPIMAGE, appDir: process.env.APPDIR, execPath: process.execPath })',
    )
    expect(registration).toContain('if (!viewerOwned || !app.isPackaged || !fromAppImage) return {}')
    expect(registration).not.toContain('!process.env.APPIMAGE')
    for (const line of [
      "'appimage-self-replace': createAppImageInstaller({",
      'env: process.env,',
      'execPath: process.execPath,',
      'uid: process.getuid(),',
      'platform: process.platform,',
      'isPackaged: app.isPackaged,',
      'pid: process.pid,',
      // What the user started the app with, as Electron's own relaunch would forward it.
      'argv: process.argv.slice(1),',
      'viewerPid: spawnedViewerPid,',
      'spawnImpl: spawn,',
    ]) {
      expect(registration, line).toContain(line)
    }
    // Electron's relaunch never restarts an AppImage: main's one relaunch is the macOS-only restart (#216).
    expect(read('electron/update-install-appimage.cjs')).not.toContain('app.relaunch(')
    expect(main.match(/app\.relaunch\(/g)).toHaveLength(1)
    expect(main.slice(main.indexOf('function restartToInstallUpdate()'), main.indexOf('\n}\n', main.indexOf('function restartToInstallUpdate()'))))
      .toContain('app.relaunch()')
    // One registration, into the one controller whose installs the #205 quit gate guards.
    expect(main.match(/createAppImageInstaller\(/g)).toHaveLength(1)
    expect(main.match(/appImageInstallers\(\)/g)).toHaveLength(2)
    expect(main.match(/installers: updateInstallers\(\),/g)).toHaveLength(1)
    expect(main.match(/\.installNow\(/g)).toHaveLength(1)
  })

  it('installs only for the window bound to a viewer this app started and proved it owns', () => {
    const main = read('electron/main.cjs')
    const start = main.indexOf("ipcMain.handle('agent-inbox:update-install'")
    const handler = main.slice(start, main.indexOf('\n})', start))

    expect(start).toBeGreaterThan(-1)
    expect(handler).toContain('args.length !== 0 || !isTrustedUpdateSender(senderUrl, event.sender)')
    expect(handler).toContain('canRunSetup(senderUrl, URL_BASE, event.sender.id, updateInstallWebContentsId)')
    expect(handler).toContain("updateController.refuseInstall('Restart Agent Inbox to install this update.')")
    expect(handler).toContain('updateController.installNow().catch(() => {})')
    expect(handler).not.toContain('await')
    expect(handler).not.toContain('setupInstallEnabled')
    expect(handler).not.toContain('runtimeSelection')
    // Ownership is proven once, in the branch that started this app's own viewer.
    expect(main.match(/viewerOwned = true/g)).toHaveLength(1)
    expect(main).toMatch(/\} else if \(await waitForOwnership\(\)\) \{\n\s+viewerOwned = true\n/)
    // The window binding (#216) grants update installs to the owned viewer alone.
    expect(main).toContain('updateAllowed: () => viewerOwned,')
    expect(main).toContain('updateInstallWebContentsId = update ? setupWindowWebContentsId : null')
    const failover = main.slice(main.indexOf('watchUpstream(probe'), main.indexOf("app.on('window-all-closed'"))
    expect(failover).not.toContain('viewerOwned')
  })

  it('stops a multi-host Setup run, like a quit, while an app update installs', () => {
    const main = read('electron/main.cjs')
    const setupStart = main.indexOf("ipcMain.handle('agent-inbox:install'")
    const setupHandler = main.slice(setupStart, main.indexOf('\n})', setupStart))
    const refusal = setupHandler.slice(setupHandler.indexOf('if (updateController?.isInstalling()) {'))
    const returned = refusal.slice(0, refusal.indexOf('\n  }'))

    // `cancelled` ends the renderer's host loop with "not started" lines instead
    // of reporting every remaining host as refused (public/app.js updateAgents).
    expect(returned).toContain("output: 'An Agent Inbox update is being installed. Try again after it restarts.'")
    expect(returned).toContain('cancelled: true')
    expect(read('public/app.js')).toContain("else if (outcome?.cancelled === true) stopped = 'was cancelled'")
  })

  it('keeps an app update and agent Setup mutually exclusive, and never blocks the update restart', () => {
    const main = read('electron/main.cjs')
    const setupStart = main.indexOf("ipcMain.handle('agent-inbox:install'")
    const setupHandler = main.slice(setupStart, main.indexOf('\n})', setupStart))
    const restart = main.slice(main.indexOf('function requestUpdateRestart()'), main.indexOf('\n}', main.indexOf('function requestUpdateRestart()')))
    const beforeQuit = main.slice(main.indexOf("app.on('before-quit'"), main.indexOf("app.on('will-quit'"))

    // Checked synchronously right before the gate starts Setup (#205): no await in between.
    const refusal = setupHandler.indexOf('if (updateController?.isInstalling())')
    const start = setupHandler.indexOf('const started = installGate.run(')
    expect(refusal).toBeGreaterThan(-1)
    expect(refusal).toBeLessThan(start)
    expect(setupHandler.slice(refusal, start)).not.toContain('await')
    expect(main).not.toContain('setupInstallRunning')
    expect(main).toContain('isSetupRunning: () => installGate.running(),')
    expect(main).toContain('requestRestart: requestUpdateRestart,')
    // The update restart is a quit path too: Setup stops before the app quits.
    expect(restart).toContain('updateRestartRequested = true')
    expect(restart.indexOf('beginAppQuit()')).toBeGreaterThan(-1)
    expect(restart.indexOf('beginAppQuit()')).toBeLessThan(restart.indexOf('app.quit()'))
    // before-quit runs beginAppQuit() every time, before the update restart's early return.
    expect(beforeQuit.indexOf('const running = beginAppQuit()')).toBeGreaterThan(-1)
    expect(beforeQuit.indexOf('const running = beginAppQuit()')).toBeLessThan(beforeQuit.indexOf('if (updateRestartRequested) return'))
    expect(beforeQuit.indexOf('if (updateRestartRequested) return')).toBeLessThan(beforeQuit.indexOf('updateController.cancelInstall()'))
  })

  it('starts no update install once the app has begun to quit', () => {
    const main = read('electron/main.cjs')
    const start = main.indexOf("ipcMain.handle('agent-inbox:update-install'")
    const handler = main.slice(start, main.indexOf('\n})', start))
    const beginAppQuit = main.slice(main.indexOf('function beginAppQuit()'), main.indexOf('\n}\n', main.indexOf('function beginAppQuit()')))

    // The quit takes the update install away from the window as well as Setup.
    expect(beginAppQuit).toContain('updateInstallWebContentsId = null')
    expect(beginAppQuit).toContain('setupInstallWebContentsId = null')
    expect(handler.indexOf('if (installGate.quitting())')).toBeGreaterThan(-1)
    expect(handler.indexOf('if (installGate.quitting())')).toBeLessThan(handler.indexOf('updateController.installNow()'))
    expect(main).toContain('isQuitting: () => installGate.quitting(),')
  })

  it('wires isQuitting to the real install gate', () => {
    const main = read('electron/main.cjs')
    const match = /isQuitting: (\(\) => [^,\n]+),\n/.exec(main)
    expect(match).not.toBeNull()
    const gate = setupRunner.createInstallGate()
    const isQuitting = new Function('installGate', `return ${match![1]}`)(gate) as () => boolean
    expect(isQuitting()).toBe(false)
    expect(gate.beginQuit()).toBeNull()
    expect(isQuitting()).toBe(true)
  })

  it('wires isSetupRunning to the real install gate', async () => {
    // Evaluates main's own expression against a real gate, so a reference to a
    // variable that no longer exists fails here instead of refusing every install.
    const main = read('electron/main.cjs')
    const match = /isSetupRunning: (\(\) => [^,\n]+),\n/.exec(main)
    expect(match).not.toBeNull()
    const { createInstallGate } = setupRunner
    const gate = createInstallGate()
    const isSetupRunning = new Function('installGate', `return ${match![1]}`)(gate) as () => boolean
    expect(isSetupRunning()).toBe(false)
    let finish!: (value: unknown) => void
    const started = gate.run(() => new Promise((resolve) => { finish = resolve })) as { promise: Promise<unknown> }
    expect(isSetupRunning()).toBe(true)
    finish({ ok: true })
    await started.promise
    expect(isSetupRunning()).toBe(false)
  })

  it('registers the macOS installer with the running bundle, its processes and constant identities', () => {
    const main = read('electron/main.cjs')
    const initializer = main.slice(
      main.indexOf('function initializeUpdateController()'),
      main.indexOf('async function startOwnServer()'),
    )

    expect(main).toContain("const { bundlePathFromExecPath, createMacInstaller } = require('./update-install-macos.cjs')")
    expect(initializer).toContain("if (process.platform !== 'darwin' || !viewerOwned) return {}")
    expect(initializer).toContain('installers: updateInstallers(),')
    expect(initializer).toContain('bundlePath: bundlePathFromExecPath(process.execPath),')
    expect(initializer).toContain("expectedBundleId: 'io.github.shariqh.agent-inbox',")
    expect(initializer).toContain("teamId: 'VVR2DKR923',")
    expect(initializer).toContain('systemVersion: process.getSystemVersion(),')
    expect(initializer).toContain('pid: process.pid,')
    expect(initializer).toContain('viewerPid: spawnedViewerPid,')
    expect(initializer).toContain('uid: process.getuid(),')
    expect(initializer).toContain('isPackaged: app.isPackaged,')
    expect(initializer).toContain("workDirectory: path.join(app.getPath('userData'), 'update-install'),")
    expect(initializer).toContain('`Version ${version} is available. Download and install it from Settings → Updates.`')
    expect(main).toContain("const { createInstallAttemptStore } = require('./update-install.cjs')")
    expect(initializer).toContain("attemptStore: createInstallAttemptStore({ directory: path.join(app.getPath('userData'), 'update-install') }),")
    expect(initializer).toContain('notifyInstallFailure: ({ message }) => {')
    expect(initializer).toContain("title: 'Agent Inbox update was not installed',")
    const viewerPid = main.slice(main.indexOf('function spawnedViewerPid()'), main.indexOf('\n}', main.indexOf('function spawnedViewerPid()')))
    expect(viewerPid).toContain('spawnedViewer.exitCode === null')
    expect(viewerPid).toContain('spawnedViewer.signalCode === null')
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
