const { contextBridge, ipcRenderer } = require('electron')

const THEME_SOURCE_VALUES = new Set(['light', 'dark', 'system'])

contextBridge.exposeInMainWorld('agentInboxSetup', {
  available() {
    return ipcRenderer.invoke('agent-inbox:install-available')
  },
  install(target) {
    return ipcRenderer.invoke('agent-inbox:install', target)
  },
  onToggleSettings(callback) {
    if (typeof callback !== 'function') return () => {}
    const listener = () => callback()
    ipcRenderer.on('agent-inbox:toggle-settings', listener)
    return () => ipcRenderer.removeListener('agent-inbox:toggle-settings', listener)
  },
})

contextBridge.exposeInMainWorld('agentInboxTheme', {
  setPreference(preference) {
    if (!THEME_SOURCE_VALUES.has(preference)) return false
    return ipcRenderer.invoke('agent-inbox:set-theme-preference', preference)
  },
})
