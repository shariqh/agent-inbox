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
    requestRestart: () => {},
    emit: (state) => emitted.push(state),
  })
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
    ]) {
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
      expect(read(`src/${name}`), name).not.toContain('update-install')
    }
  })

  it('runs install binaries only by absolute path with argv arrays, outside Electron and the MCP graph', () => {
    const contract = read('electron/update-install.cjs')
    const mac = read('electron/update-install-macos.cjs')
    for (const source of [contract, mac]) {
      expect(source).not.toContain("require('electron')")
      expect(source).not.toMatch(/shell:\s*true/)
      expect(source).not.toMatch(/\bexec(Sync)?\(/)
      expect(source).not.toContain('execSync')
      expect(source).not.toContain('spawnSync')
    }
    expect(contract).not.toContain('child_process')
    expect(mac).toContain("require('node:child_process')")
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
    expect(main).toContain('if (viewerOwned && viewerOrigin) updateInstallWebContentsId = setupWindowWebContentsId')
    expect(main).toContain('if (updateInstallWebContentsId === setupWindowWebContentsId) updateInstallWebContentsId = null')
    const failover = main.slice(main.indexOf('watchUpstream(probe'), main.indexOf("app.on('window-all-closed'"))
    expect(failover).not.toContain('viewerOwned')
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
    expect(initializer).toContain('`Version ${version} is available. Install it from Settings → Updates.`')
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
