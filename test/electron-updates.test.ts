import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function read(relPath: string): string {
  return readFileSync(join(import.meta.dirname, '..', relPath), 'utf8')
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
    expect(preload).not.toContain('child_process')
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
    expect(main).toContain('sender !== updateWindow.webContents')
    expect(main).toContain('isTrustedUpdateSender(event.senderFrame?.url')
    expect(main).not.toContain('updateWindowWebContentsId')
    expect(main).toContain("updateWindow.webContents.send('agent-inbox:update-state-changed'")
    expect(main).toContain("win.webContents.on('did-finish-load'")
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
    const controller = read('electron/update-controller.cjs')
    expect(controller).not.toContain('attention')
    expect(controller).not.toContain('setBadgeCount')
  })

  it('mounts Updates before the setup fetch and keeps the compact controls usable', () => {
    const app = read('public/app.js')
    const css = read('public/style.css')
    const renderSetup = app.slice(app.indexOf('async function renderSetup()'), app.indexOf('// ── init'))

    expect(renderSetup.indexOf('renderUpdateSettings(host)')).toBeLessThan(renderSetup.indexOf('try {'))
    expect(app).toContain('window.agentInboxUpdates?.onOpenUpdates?.(openUpdates)')
    expect(app).toContain("if (!settingsOpen()) showPanel('setup')")
    expect(css).toContain('.updates-actions button {\n  min-height: 44px;')
    expect(css).toContain('.updates-actions { display: grid; grid-template-columns: minmax(0, 1fr); }')
  })
})
