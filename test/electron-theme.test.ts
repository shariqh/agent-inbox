import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function read(relPath: string): string {
  return readFileSync(join(import.meta.dirname, '..', relPath), 'utf8')
}

describe('Electron theme bridge wiring', () => {
  it('keeps the preload bridge narrow and validated', () => {
    const preload = read('electron/setup-preload.cjs')

    expect(preload).toContain("contextBridge.exposeInMainWorld('agentInboxTheme'")
    expect(preload).toContain("const THEME_SOURCE_VALUES = new Set(['light', 'dark', 'system'])")
    expect(preload).toContain('setPreference(preference)')
    expect(preload).toContain("if (!THEME_SOURCE_VALUES.has(preference)) return false")
    expect(preload).toContain("return ipcRenderer.invoke('agent-inbox:set-theme-preference', preference)")
    expect(preload).toContain("contextBridge.exposeInMainWorld('agentInboxSetup'")
  })

  it('pins theme IPC to the active viewer window and native chrome', () => {
    const main = read('electron/main.cjs')

    expect(main).toContain("const { app, BrowserWindow, ipcMain, Menu, Notification, nativeTheme, shell } = require('electron')")
    expect(main).toContain("const THEME_SOURCE_VALUES = new Set(['light', 'dark', 'system'])")
    expect(main).toMatch(/const THEME_BACKGROUND_COLORS = \{\s*light: '#f8f3f4',\s*dark: '#171113',\s*\}/)
    expect(main).toContain("ipcMain.handle('agent-inbox:set-theme-preference'")
    expect(main).toContain('event.sender.id !== themeWindowWebContentsId')
    expect(main).toContain('new URL(senderUrl).origin === new URL(URL_BASE).origin')
    expect(main).toContain('nativeTheme.themeSource = preference')
    expect(main).toContain("nativeTheme.on('updated', () => syncThemeChrome())")
    expect(main).toContain('function syncThemeChrome(win = themeWindow)')
    expect(main).toContain('win.setBackgroundColor(themeBackgroundColor())')
    expect(main).toContain('backgroundColor: themeBackgroundColor()')
    expect(main).toContain('show: false')
    expect(main).toContain('themeWindow.show()')
    expect(main).toContain("win.webContents.on('did-finish-load'")
    expect(main).toContain("'document.documentElement.dataset.themePreference'")
    expect(main).toContain("THEME_SOURCE_VALUES.has(preference) ? preference : 'light'")
    expect(main).toMatch(/catch \(err\) \{[\s\S]*nativeTheme\.themeSource = 'light'[\s\S]*syncThemeChrome\(win\)/)
    expect(main).toContain('themeWindow = win')
    expect(main).toContain('const webContentsId = win.webContents.id')
    expect(main).toContain('themeWindowWebContentsId = webContentsId')
    expect(main).toContain("contextIsolation: true")
    expect(main).toContain("nodeIntegration: false")
    expect(main).toContain("preload: path.join(__dirname, 'setup-preload.cjs')")
    expect(main).toContain('themeWindowWebContentsId === webContentsId')
  })
})
