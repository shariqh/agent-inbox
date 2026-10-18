const { contextBridge, ipcRenderer } = require('electron')

const THEME_SOURCE_VALUES = new Set(['light', 'dark', 'system'])
const UPDATE_STATE_VALUES = new Set([
  'idle',
  'checking',
  'current',
  'available',
  'stale',
  'unverified',
  'unsupported',
  'downloading',
  'verified',
  'download-failed',
  'installing',
  'install-failed',
])
// `stale` carries no offer: it stays out of both sets below.
const OFFERED_UPDATE_STATES = new Set(['available', 'downloading', 'verified', 'download-failed', 'installing', 'install-failed'])
const DOWNLOAD_STATES = new Set(['downloading', 'verified', 'download-failed'])
// An install exists only for an installable offer and carries no byte progress.
const INSTALL_STATES = new Set(['installing', 'install-failed'])
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

function isByteCount(value) {
  return Number.isSafeInteger(value) && value >= 0
}

// installable implies downloadable; a reason explains only a notify-only offer.
function isOffer(available, status) {
  return (
    typeof available === 'object' &&
    available !== null &&
    typeof available.version === 'string' &&
    typeof available.tag === 'string' &&
    typeof available.releaseUrl === 'string' &&
    typeof available.downloadable === 'boolean' &&
    typeof available.installable === 'boolean' &&
    (!available.installable || available.downloadable) &&
    (available.reason === undefined || (
      typeof available.reason === 'string' &&
      !available.installable &&
      !available.downloadable
    )) &&
    (!INSTALL_STATES.has(status) || available.installable) &&
    typeof available.target === 'object' &&
    available.target !== null &&
    typeof available.target.packageType === 'string' &&
    typeof available.target.installStrategy === 'string'
  )
}

function isUpdateState(value) {
  const available = value?.available
  const download = value?.download
  return Boolean(
    value &&
    typeof value === 'object' &&
    UPDATE_STATE_VALUES.has(value.status) &&
    typeof value.currentVersion === 'string' &&
    typeof value.automaticChecks === 'boolean' &&
    (value.checkedAt === null || typeof value.checkedAt === 'string') &&
    typeof value.message === 'string' &&
    (OFFERED_UPDATE_STATES.has(value.status)
      ? isOffer(available, value.status)
      : available === undefined) &&
    (DOWNLOAD_STATES.has(value.status)
      ? (
          typeof download === 'object' &&
          download !== null &&
          isByteCount(download.receivedBytes) &&
          isByteCount(download.totalBytes) &&
          download.totalBytes > 0 &&
          download.receivedBytes <= download.totalBytes
        )
      : download === undefined)
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
    download(...args) {
      if (args.length !== 0) return false
      return invokeUpdateState('agent-inbox:update-download')
    },
    cancelDownload(...args) {
      if (args.length !== 0) return false
      return invokeUpdateState('agent-inbox:update-download-cancel')
    },
    install(...args) {
      if (args.length !== 0) return false
      return invokeUpdateState('agent-inbox:update-install')
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
