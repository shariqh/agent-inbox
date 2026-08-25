const { contextBridge, ipcRenderer } = require('electron')

const THEME_SOURCE_VALUES = new Set(['light', 'dark', 'system'])
const UPDATE_STATE_VALUES = new Set(['idle', 'checking', 'current', 'available', 'unverified', 'unsupported'])
const updatesAvailable = process.argv.includes('--agent-inbox-updates=1')

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

function isUpdateState(value) {
  const available = value?.available
  return Boolean(
    value &&
    typeof value === 'object' &&
    UPDATE_STATE_VALUES.has(value.status) &&
    typeof value.currentVersion === 'string' &&
    typeof value.automaticChecks === 'boolean' &&
    (value.checkedAt === null || typeof value.checkedAt === 'string') &&
    typeof value.message === 'string' &&
    (value.status === 'available'
      ? (
          typeof available === 'object' &&
          typeof available.version === 'string' &&
          typeof available.tag === 'string' &&
          typeof available.releaseUrl === 'string' &&
          typeof available.target === 'object' &&
          typeof available.target.packageType === 'string' &&
          typeof available.target.installStrategy === 'string'
        )
      : available === undefined)
  )
}

async function invokeUpdateState(channel, ...args) {
  const state = await ipcRenderer.invoke(channel, ...args)
  if (!isUpdateState(state)) throw new TypeError('Invalid update state')
  return state
}

if (updatesAvailable) {
  contextBridge.exposeInMainWorld('agentInboxUpdates', {
    available: true,
    getState(...args) {
      if (args.length !== 0) return false
      return invokeUpdateState('agent-inbox:update-state')
    },
    check(...args) {
      if (args.length !== 0) return false
      return invokeUpdateState('agent-inbox:update-check')
    },
    setAutomatic(enabled) {
      if (typeof enabled !== 'boolean') return false
      return invokeUpdateState('agent-inbox:update-automatic', enabled)
    },
    openRelease(...args) {
      if (args.length !== 0) return false
      return ipcRenderer.invoke('agent-inbox:update-open-release').then((opened) => opened === true)
    },
    onState(callback) {
      if (typeof callback !== 'function') return () => {}
      const listener = (_event, state) => {
        if (isUpdateState(state)) callback(state)
      }
      ipcRenderer.on('agent-inbox:update-state-changed', listener)
      return () => ipcRenderer.removeListener('agent-inbox:update-state-changed', listener)
    },
    onOpenUpdates(callback) {
      if (typeof callback !== 'function') return () => {}
      const listener = () => callback()
      ipcRenderer.on('agent-inbox:open-updates', listener)
      return () => ipcRenderer.removeListener('agent-inbox:open-updates', listener)
    },
  })
}
