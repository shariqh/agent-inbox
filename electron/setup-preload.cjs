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

// Issue #300: the one method the viewer opens links through. It passes on a
// fresh copy of a well-formed request and a checked copy of the answer; main
// re-validates the sender and everything in the request, and alone decides
// what may open (electron/link-open.cjs). filesAvailable() only reads whether
// this page may open local files: main says yes only while the window shows the
// viewer this app started and proved it owns, and refuses file requests
// otherwise, whatever the page asks.
const LINK_REASONS = new Set([
  'folder', 'app', 'blocked', 'executable', 'special', 'type', 'requested', 'rule',
  'invalid', 'missing', 'inaccessible', 'failed', 'unavailable', 'unowned', 'app-missing', 'app-refused',
])

function linkRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null
  if (request.kind === 'web' && typeof request.url === 'string') return { kind: 'web', url: request.url }
  if (request.kind === 'file' && typeof request.path === 'string' && typeof request.reveal === 'boolean') {
    return { kind: 'file', path: request.path, reveal: request.reveal }
  }
  return null
}

function linkResult(value) {
  if (value && typeof value === 'object') {
    if (value.ok === true && value.action === 'opened') return { ok: true, action: 'opened' }
    if (value.ok === true && value.action === 'revealed' && LINK_REASONS.has(value.reason)) {
      return { ok: true, action: 'revealed', reason: value.reason }
    }
    if (value.ok === false && LINK_REASONS.has(value.reason)) return { ok: false, reason: value.reason }
  }
  return { ok: false, reason: 'failed' }
}

contextBridge.exposeInMainWorld('agentInboxLinks', {
  open(...args) {
    const request = args.length === 1 ? linkRequest(args[0]) : null
    if (!request) return Promise.resolve({ ok: false, reason: 'invalid' })
    return ipcRenderer.invoke('agent-inbox:open-link', request).then(linkResult, () => ({ ok: false, reason: 'failed' }))
  },
  filesAvailable(...args) {
    if (args.length !== 0) return Promise.resolve(false)
    return ipcRenderer.invoke('agent-inbox:link-files-available').then((value) => value === true, () => false)
  },
})

// Issue #300 part 2: Settings → Links. Main keeps the rules; the renderer names
// a rule and a handler, never an app path, because an app comes only from
// main's own native picker. Each call answers with a checked copy of the view.
const SETTINGS_HANDLERS = new Set(['default', 'quicklook', 'reveal', 'app'])
const SETTINGS_ERRORS = new Set(['invalid', 'covered', 'blocked', 'exists', 'full', 'not-an-app', 'runs-code', 'newer', 'failed', 'unowned'])

function settingsView(value) {
  if (!value || typeof value !== 'object' || typeof value.available !== 'boolean' || !Array.isArray(value.rules)) return null
  const rules = []
  for (const rule of value.rules) {
    if (
      !rule || typeof rule !== 'object' ||
      typeof rule.id !== 'string' || typeof rule.label !== 'string' ||
      (rule.kind !== 'web' && rule.kind !== 'file') || !SETTINGS_HANDLERS.has(rule.handler) ||
      !(rule.appName === null || typeof rule.appName === 'string') || typeof rule.removable !== 'boolean' ||
      typeof rule.systemDefault !== 'boolean'
    ) return null
    rules.push({
      id: rule.id, label: rule.label, kind: rule.kind, handler: rule.handler, appName: rule.appName,
      removable: rule.removable, systemDefault: rule.systemDefault,
    })
  }
  const view = { available: value.available, rules }
  if (SETTINGS_ERRORS.has(value.error)) view.error = value.error
  return view
}

const failedSettings = (error) => ({ available: false, rules: [], error })

function settingsCall(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args).then(
    (value) => settingsView(value) ?? failedSettings('failed'),
    () => failedSettings('failed'),
  )
}

const isText = (value) => typeof value === 'string' && value.length <= 64

contextBridge.exposeInMainWorld('agentInboxLinkSettings', {
  get(...args) {
    if (args.length !== 0) return Promise.resolve(failedSettings('invalid'))
    return settingsCall('agent-inbox:link-settings')
  },
  setHandler(...args) {
    if (args.length !== 2 || !isText(args[0]) || !isText(args[1])) return Promise.resolve(failedSettings('invalid'))
    return settingsCall('agent-inbox:link-settings-set', args[0], args[1])
  },
  chooseApp(...args) {
    if (args.length !== 1 || !isText(args[0])) return Promise.resolve(failedSettings('invalid'))
    return settingsCall('agent-inbox:link-settings-choose-app', args[0])
  },
  addType(...args) {
    if (args.length !== 1 || !isText(args[0])) return Promise.resolve(failedSettings('invalid'))
    return settingsCall('agent-inbox:link-settings-add-type', args[0])
  },
  removeType(...args) {
    if (args.length !== 1 || !isText(args[0])) return Promise.resolve(failedSettings('invalid'))
    return settingsCall('agent-inbox:link-settings-remove-type', args[0])
  },
})

function isByteCount(value) {
  return Number.isSafeInteger(value) && value >= 0
}

// installable implies downloadable, and installPermitted (#216) implies installable;
// a reason explains only a notify-only offer.
const MAX_INSTALL_NOTICE_LENGTH = 400

function isOffer(available, status) {
  return (
    typeof available === 'object' &&
    available !== null &&
    typeof available.version === 'string' &&
    typeof available.tag === 'string' &&
    typeof available.releaseUrl === 'string' &&
    typeof available.downloadable === 'boolean' &&
    typeof available.installable === 'boolean' &&
    typeof available.installPermitted === 'boolean' &&
    (!available.installable || available.downloadable) &&
    (!available.installPermitted || available.installable) &&
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
    (value.installNotice === undefined || (
      typeof value.installNotice === 'string' &&
      value.installNotice.length <= MAX_INSTALL_NOTICE_LENGTH
    )) &&
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
    // Quits and reopens the app so a fresh window can install (#216); macOS only.
    restart(...args) {
      if (args.length !== 0) return false
      return ipcRenderer.invoke('agent-inbox:update-restart').then((restarting) => restarting === true)
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
