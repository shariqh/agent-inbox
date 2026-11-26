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
  // The callback hears whether Settings… was chosen while another Mac's Inbox was on top (#617):
  // exactly `true` from main says so, anything else is false.
  onToggleSettings(callback) {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, fromHub) => callback(fromHub === true)
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
// otherwise, whatever the page asks. A repo-relative file (#324) also names the
// folder its card recorded, which main joins it to.
const LINK_REASONS = new Set([
  'folder', 'app', 'blocked', 'executable', 'special', 'type', 'requested', 'rule',
  'invalid', 'missing', 'outside', 'inaccessible', 'failed', 'unavailable', 'unowned', 'app-missing', 'app-refused',
])

const MAX_FOLDER_NAME = 255

function linkRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null
  if (request.kind === 'web' && typeof request.url === 'string') return { kind: 'web', url: request.url }
  if (request.kind === 'file' && typeof request.path === 'string' && typeof request.reveal === 'boolean') {
    if (request.root === undefined) return { kind: 'file', path: request.path, reveal: request.reveal }
    if (typeof request.root === 'string') return { kind: 'file', path: request.path, root: request.root, reveal: request.reveal }
  }
  return null
}

function linkResult(value) {
  if (value && typeof value === 'object') {
    if (value.ok === true && value.action === 'opened') return { ok: true, action: 'opened' }
    // a missing file's nearest folder was shown instead: its name, never a path
    if (value.ok === true && value.action === 'revealed' && value.reason === 'missing') {
      const folder = typeof value.folder === 'string' && value.folder.length <= MAX_FOLDER_NAME ? value.folder : ''
      return { ok: true, action: 'revealed', reason: 'missing', folder }
    }
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

// #586: the terminal setting. Main answers with its own view; only these fields get through.
const TERMINAL_IDS = new Set(['terminal', 'iterm2'])

function terminalView(value) {
  if (!value || typeof value !== 'object' || typeof value.available !== 'boolean') return null
  const view = { available: value.available }
  if (value.available) {
    if (!TERMINAL_IDS.has(value.terminal)) return null
    view.terminal = value.terminal
  }
  if (SETTINGS_ERRORS.has(value.error)) view.error = value.error
  return view
}

function terminalSettingCall(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args).then(
    (value) => terminalView(value) ?? { available: false, error: 'failed' },
    () => ({ available: false, error: 'failed' }),
  )
}

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
  getTerminal(...args) {
    if (args.length !== 0) return Promise.resolve({ available: false, error: 'invalid' })
    return terminalSettingCall('agent-inbox:terminal-setting')
  },
  setTerminal(...args) {
    if (args.length !== 1 || !isText(args[0])) return Promise.resolve({ available: false, error: 'invalid' })
    return terminalSettingCall('agent-inbox:terminal-setting-set', args[0])
  },
})

// Issue #412 step 3: driven sessions. Each method takes exactly its arguments,
// passes them on as plain data, and hands back a checked answer. Main decides
// everything: the switch, the grant, the folder, the native confirmation. The
// renderer names a known repository folder (or none, for main's own dialog),
// never a path of its own, an executable, argv or env.
const LAUNCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function launchResult(value) {
  if (!value || typeof value !== 'object' || typeof value.ok !== 'boolean') return { ok: false, error: 'Agent Inbox did not answer.' }
  const out = { ok: value.ok }
  if (typeof value.error === 'string') out.error = value.error.slice(0, 500)
  // #586: a launch that worked in Terminal because the chosen app could not be opened
  if (typeof value.notice === 'string') out.notice = value.notice.slice(0, 500)
  if (typeof value.launch === 'string' && LAUNCH_ID.test(value.launch)) out.launch = value.launch
  if (value.cancelled === true) out.cancelled = true
  if (typeof value.status === 'string') out.status = value.status
  if (typeof value.enabled === 'boolean') out.enabled = value.enabled
  if (typeof value.killed === 'boolean') out.killed = value.killed
  if (value.reason === 'environment') out.reason = 'environment'
  const root = worktreeRootOf(value.worktreeRoot)
  if (root) out.worktreeRoot = root
  if (isSessionCap(value.maxSessions)) out.maxSessions = value.maxSessions
  // #432: the folder main's own dialog chose, and whether it is a repository's top
  if (typeof value.folder === 'string' && value.folder.startsWith('/') && value.folder.length <= 4096) out.folder = value.folder
  if (typeof value.project === 'string') out.project = value.project.slice(0, 256)
  if (typeof value.repository === 'boolean') out.repository = value.repository
  return out
}

function launchAvailability(value) {
  const off = { owned: false, enabled: false, available: false, canEnable: false }
  if (!value || typeof value !== 'object') return off
  const out = {
    owned: value.owned === true,
    enabled: value.enabled === true,
    available: value.available === true && value.enabled === true && value.owned === true,
    canEnable: value.canEnable === true,
  }
  if (typeof value.error === 'string') out.error = value.error.slice(0, 500)
  const root = worktreeRootOf(value.worktreeRoot)
  if (out.available && root) out.worktreeRoot = root
  if (out.available && isSessionCap(value.maxSessions)) out.maxSessions = value.maxSessions
  // #586: which terminal the Terminal buttons open, for their titles
  if (out.available && TERMINAL_IDS.has(value.terminal)) out.terminal = value.terminal
  return out
}

// #432 §5: the cap on sessions at once
function isSessionCap(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 8
}

// #432: the folder session worktrees go under, as main reports it
function worktreeRootOf(value) {
  if (!value || typeof value !== 'object' || typeof value.path !== 'string' || !value.path.startsWith('/') || value.path.length > 4096) return null
  return { path: value.path, isDefault: value.isDefault === true }
}

// #432 PR 5: the start phases main reports, and the one listener the page has for them
const START_PHASES = new Set(['environment', 'runtime', 'worktree', 'copilot'])
const isStartId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(value)
let startProgress = null

const failedLaunch = () => ({ ok: false, error: 'Agent Inbox did not answer.' })
const launchCall = (channel, arg) => ipcRenderer.invoke(channel, arg).then(launchResult, failedLaunch)
const isLaunchId = (value) => typeof value === 'string' && LAUNCH_ID.test(value)
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// #586 phase 2: Continue here…'s request, exactly the tool, the chat id, a mode, the message and an
// optional start tag, rebuilt as a fresh object; anything else is refused before main is asked
const CONTINUE_KEYS = new Set(['tool', 'id', 'mode', 'prompt', 'startId'])
const CONTINUE_MODES = new Set(['ask', 'read-only'])
const CONTINUE_REASONS = new Set([
  'invalid', 'busy', 'index', 'missing', 'driven', 'live', 'kind', 'folder', 'sessions', 'worktree', 'environment', 'copilot_home', 'outdated',
])

function continueRequest(value) {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !CONTINUE_KEYS.has(key))) return null
  const { tool, id, mode, prompt, startId } = value
  if (tool !== 'claude' && tool !== 'copilot') return null
  if (typeof id !== 'string' || !LAUNCH_ID.test(id) || !CONTINUE_MODES.has(mode)) return null
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 65536) return null
  if (startId !== undefined && !isStartId(startId)) return null
  return { tool, id, mode, prompt, ...(startId === undefined ? {} : { startId }) }
}

// the checked answer: whether it started, its launch, a cancel, and a refusal's text and reason,
// so the page knows when to read the list again; nothing else main might send
function continueResult(value) {
  if (!isPlainObject(value) || typeof value.ok !== 'boolean') return failedLaunch()
  const out = { ok: value.ok }
  if (typeof value.error === 'string') out.error = value.error.slice(0, 500)
  if (typeof value.launch === 'string' && LAUNCH_ID.test(value.launch)) out.launch = value.launch
  if (value.cancelled === true) out.cancelled = true
  if (CONTINUE_REASONS.has(value.reason)) out.reason = value.reason
  return out
}

contextBridge.exposeInMainWorld('agentInboxLaunch', {
  available(...args) {
    if (args.length !== 0) return Promise.resolve(launchAvailability(null))
    return ipcRenderer.invoke('agent-inbox:launch-available').then(launchAvailability, () => launchAvailability(null))
  },
  setEnabled(...args) {
    if (args.length !== 1 || typeof args[0] !== 'boolean') return Promise.resolve({ ok: false, error: 'invalid' })
    return launchCall('agent-inbox:launch-set-enabled', args[0])
  },
  start(...args) {
    if (args.length !== 1 || !isPlainObject(args[0])) return Promise.resolve({ ok: false, error: 'invalid' })
    return launchCall('agent-inbox:launch-start', args[0])
  },
  stop(...args) {
    if (args.length !== 1 || !isLaunchId(args[0])) return Promise.resolve({ ok: false, error: 'invalid' })
    return launchCall('agent-inbox:launch-stop', args[0])
  },
  close(...args) {
    if (args.length !== 1 || !isLaunchId(args[0])) return Promise.resolve({ ok: false, error: 'invalid' })
    return launchCall('agent-inbox:launch-close', args[0])
  },
  resume(...args) {
    if (args.length !== 1 || !isLaunchId(args[0])) return Promise.resolve({ ok: false, error: 'invalid' })
    return launchCall('agent-inbox:launch-resume', args[0])
  },
  // #451: Resume with more budget…; main confirms the allowance in its own dialog
  resumeWithBudget(...args) {
    if (args.length !== 1 || !isPlainObject(args[0])) return Promise.resolve({ ok: false, error: 'invalid' })
    return launchCall('agent-inbox:launch-resume-with-budget', args[0])
  },
  approve(...args) {
    if (args.length !== 1 || !isPlainObject(args[0])) return Promise.resolve({ ok: false, error: 'invalid' })
    return launchCall('agent-inbox:launch-approve', args[0])
  },
  setMaxSessions(...args) {
    if (args.length !== 1 || !isSessionCap(args[0])) return Promise.resolve({ ok: false, error: 'invalid' })
    return launchCall('agent-inbox:launch-set-max-sessions', args[0])
  },
  // #432 PR 5: what a start is doing now, for the New session dialog; one listener at a time, null removes it
  onStartProgress(...args) {
    if (args.length !== 1 || (args[0] !== null && typeof args[0] !== 'function')) return false
    if (startProgress) ipcRenderer.removeListener('agent-inbox:launch-progress', startProgress)
    startProgress = null
    const listener = args[0]
    if (listener) {
      // the phase, and the launch id main made for this start (its row exists from 'copilot' on)
      // and the tag the page gave that start, so a page reloaded mid-start can tell its own phases
      startProgress = (_event, phase, launch, startId) => {
        if (START_PHASES.has(phase)) listener(phase, isLaunchId(launch) ? launch : undefined, isStartId(startId) ? startId : undefined)
      }
      ipcRenderer.on('agent-inbox:launch-progress', startProgress)
    }
    return true
  },
  // #432: a launch id only; main reads the worktree's path from the hub
  removeWorktree(...args) {
    if (args.length !== 1 || !isLaunchId(args[0])) return Promise.resolve({ ok: false, error: 'invalid' })
    return launchCall('agent-inbox:launch-remove-worktree', args[0])
  },
  openWorktree(...args) {
    if (args.length !== 1 || !isLaunchId(args[0])) return Promise.resolve({ ok: false, error: 'invalid' })
    return launchCall('agent-inbox:launch-open-worktree', args[0])
  },
  // step 5: Take over in Terminal; a launch id only
  takeOver(...args) {
    if (args.length !== 1 || !isLaunchId(args[0])) return Promise.resolve({ ok: false, error: 'invalid' })
    return launchCall('agent-inbox:launch-take-over', args[0])
  },
  // #478: Forget an ended session; a launch id only
  forget(...args) {
    if (args.length !== 1 || !isLaunchId(args[0])) return Promise.resolve({ ok: false, error: 'invalid' })
    return launchCall('agent-inbox:launch-forget', args[0])
  },
  // #586 phase 2: Continue here… on a chat; a fresh object of the five allowed keys, which main checks again
  continueChat(...args) {
    const request = args.length === 1 ? continueRequest(args[0]) : null
    if (!request) return Promise.resolve({ ok: false, reason: 'invalid', error: 'This chat can’t be continued here.' })
    return ipcRenderer.invoke('agent-inbox:launch-continue-chat', request).then(continueResult, failedLaunch)
  },
  // #432: main's own folder dialogs choose these; the page names no folder
  chooseFolder(...args) {
    if (args.length !== 0) return Promise.resolve({ ok: false, error: 'invalid' })
    return launchCall('agent-inbox:launch-choose-folder')
  },
  chooseWorktreeRoot(...args) {
    if (args.length !== 0) return Promise.resolve({ ok: false, error: 'invalid' })
    return launchCall('agent-inbox:launch-choose-worktree-root')
  },
  resetWorktreeRoot(...args) {
    if (args.length !== 0) return Promise.resolve({ ok: false, error: 'invalid' })
    return launchCall('agent-inbox:launch-reset-worktree-root')
  },
})

// #586 PR 3: Resume a chat in Terminal. The page sends a fresh { tool, id } and nothing
// else; main reads the folder from the index, and alone decides whether anything opens.
const CHAT_TOOLS = new Set(['claude', 'copilot'])
// the index's id rule: a lowercase UUID
const CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const CHAT_RESUME_REASONS = new Set(['unavailable', 'invalid', 'quitting', 'busy', 'index', 'missing', 'driven', 'live', 'opened', 'folder', 'write', 'open'])
const chatNoAnswer = () => ({ ok: false, reason: 'unavailable', error: 'Agent Inbox did not answer.' })
const chatResumeOff = () => ({ available: false, terminal: 'terminal' })

function chatResumeResult(value) {
  if (!isPlainObject(value)) return chatNoAnswer()
  if (value.ok === true && TERMINAL_IDS.has(value.terminal)) {
    const out = { ok: true, terminal: value.terminal }
    if (typeof value.notice === 'string') out.notice = value.notice.slice(0, 500)
    return out
  }
  if (value.ok === false && CHAT_RESUME_REASONS.has(value.reason) && typeof value.error === 'string') {
    return { ok: false, reason: value.reason, error: value.error.slice(0, 500) }
  }
  return chatNoAnswer()
}

contextBridge.exposeInMainWorld('agentInboxChats', {
  resumeAvailable(...args) {
    if (args.length !== 0) return Promise.resolve(chatResumeOff())
    return ipcRenderer.invoke('agent-inbox:chat-resume-available').then(
      (value) => (isPlainObject(value) && value.available === true && TERMINAL_IDS.has(value.terminal)
        ? { available: true, terminal: value.terminal } : chatResumeOff()),
      chatResumeOff,
    )
  },
  resume(...args) {
    const request = args[0]
    if (args.length !== 1 || !isPlainObject(request) || !CHAT_TOOLS.has(request.tool) ||
        typeof request.id !== 'string' || !CHAT_ID.test(request.id)) {
      return Promise.resolve({ ok: false, reason: 'invalid', error: 'This chat can’t be resumed.' })
    }
    return ipcRenderer.invoke('agent-inbox:chat-resume', { tool: request.tool, id: request.id }).then(chatResumeResult, chatNoAnswer)
  },
})

// Agent setup in the app, step 2a: a fixed list of operations main runs with the person's own
// command line, as a dry run unless `apply` is true. The page names an operation and its values,
// never a command, a path or a secret: a key or token file is chosen in main's own picker and
// named here only by a handle and its base name. Main checks everything again; every answer is
// rebuilt here field by field, and anything else is the fixed failure `failed`.
const MESH_OPERATIONS = Object.freeze({
  servers: [],
  'check-server': ['name'],
  'add-server': ['name', 'baseUrl', 'key', 'apply'],
  'add-claude-server': ['name', 'apply'],
  'adopt-server': ['name', 'from', 'apply'],
  'set-server': ['name', 'baseUrl', 'key', 'apply'],
  'remove-server': ['name', 'apply'],
  'enable-model-agent': ['agent', 'server', 'model', 'apply'],
  'enable-request-post': ['endpoint', 'token', 'apply'],
  disable: ['agent', 'apply'],
  'check-agent': ['address', 'token'],
  'add-agent': ['address', 'id', 'pin', 'apply', 'token'],
  'remove-agent': ['id', 'apply'],
})
const MESH_REASONS = new Set([
  'unavailable', 'invalid', 'handle', 'busy', 'setup', 'updating', 'quitting',
  'unsupported', 'environment', 'not-installed', 'unsafe', 'unrecognized', 'stale',
  'outdated', 'output', 'timeout', 'failed', 'cancelled',
])
const MESH_KEYS = new Set(['file', 'command', 'env', 'none'])
const MESH_SERVER_KINDS = new Set(['http', 'claude-code'])
const MESH_CHECK_FAILURES = new Set(['unreachable', 'unauthorized', 'not-a-model-server', 'timeout', 'key', 'no-program', 'signed-out'])
const MESH_REACHES = new Set(['loopback', 'tailnet', 'public'])
const MESH_AGENT_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
const MESH_PIN = /^[0-9a-f]{64}$/
// card text holds no control or format character (Unicode Cf), as main requires
const MESH_CARD_UNSAFE = /[\x00-\x1f\x7f-\x9f\p{Cf}]/u
const MESH_HANDLE = /^[0-9a-f]{32}$/
const MESH_VALUE_MAX = 2048
const meshFailed = (reason = 'failed') => ({ ok: false, reason })
const meshCut = (text, max) => (text.length <= max ? text : text.slice(0, max).replace(/[\ud800-\udbff]$/, ''))
const meshStrings = (value, count, max) => (Array.isArray(value) && value.every((item) => typeof item === 'string')
  ? value.slice(0, count).map((item) => meshCut(item, max)) : null)

// a fresh object of exactly the operation's keys, each a short string or (apply) a boolean
function meshValues(operation, values) {
  if (typeof operation !== 'string' || !Object.hasOwn(MESH_OPERATIONS, operation) || !isPlainObject(values)) return null
  const allowed = MESH_OPERATIONS[operation]
  const out = {}
  for (const key of Object.keys(values)) {
    if (!allowed.includes(key)) return null
    const value = values[key]
    if (key === 'apply' ? typeof value !== 'boolean' : typeof value !== 'string' || value.length > MESH_VALUE_MAX) return null
    out[key] = value
  }
  return out
}

function meshPlan(value) {
  const steps = meshStrings(value.steps, 32, 4096)
  if (typeof value.ok !== 'boolean' || typeof value.applied !== 'boolean' || steps === null) return null
  const out = { ok: value.ok, applied: value.applied, steps }
  if (typeof value.refused === 'string') out.refused = meshCut(value.refused, 4096)
  const notes = meshStrings(value.notes, 32, 4096)
  if (notes !== null) out.notes = notes
  return out
}

function meshServer(row) {
  const agents = isPlainObject(row) ? meshStrings(row.agents, 8, 40) : null
  if (agents === null || typeof row.name !== 'string' || typeof row.baseUrl !== 'string' || !MESH_KEYS.has(row.key)) return null
  // no kind is an address server, as main says; any other kind fails the list
  if (row.kind !== undefined && !MESH_SERVER_KINDS.has(row.kind)) return null
  return { name: meshCut(row.name, 40), kind: row.kind ?? 'http', baseUrl: meshCut(row.baseUrl, 2048), key: row.key, agents }
}

function meshServers(value) {
  const inline = meshStrings(value.inline, 8, 40)
  if (typeof value.ok !== 'boolean' || !Array.isArray(value.servers) || inline === null) return null
  const servers = value.servers.slice(0, 32).map(meshServer)
  if (servers.includes(null)) return null
  const out = { ok: value.ok, servers, inline }
  if (typeof value.refused === 'string') out.refused = meshCut(value.refused, 4096)
  return out
}

function meshCheck(value) {
  const models = meshStrings(value.models, 50, 64)
  if (typeof value.ok !== 'boolean' || typeof value.reachable !== 'boolean' || models === null) return null
  const out = { ok: value.ok, reachable: value.reachable, models, skipped: Number.isSafeInteger(value.skipped) && value.skipped >= 0 ? value.skipped : 0 }
  if (MESH_CHECK_FAILURES.has(value.failure)) out.failure = value.failure
  if (typeof value.refused === 'string') out.refused = meshCut(value.refused, 4096)
  // kept only when main named one; any other kind fails the answer, as it does in main
  if (value.kind !== undefined) {
    if (!MESH_SERVER_KINDS.has(value.kind)) return null
    out.kind = value.kind
  }
  return out
}

// card text: a string cut to its cap; an absent field stays absent, anything else fails the card
function meshCardText(out, raw, key, max) {
  if (raw[key] === undefined) return true
  if (typeof raw[key] !== 'string' || MESH_CARD_UNSAFE.test(raw[key])) return false
  out[key] = meshCut(raw[key], max)
  return true
}

function meshSkill(raw) {
  if (!isPlainObject(raw) || typeof raw.id !== 'string' || MESH_CARD_UNSAFE.test(raw.id)) return null
  const out = { id: meshCut(raw.id, 162) }
  return meshCardText(out, raw, 'name', 162) && meshCardText(out, raw, 'description', 402) ? out : null
}

function meshCard(raw) {
  if (!isPlainObject(raw)) return null
  const out = {}
  if (raw.id !== undefined) {
    if (typeof raw.id !== 'string' || !MESH_AGENT_ID.test(raw.id)) return null
    out.id = raw.id
  }
  for (const [key, max] of [['name', 162], ['description', 602], ['version', 162], ['publisher', 162]]) if (!meshCardText(out, raw, key, max)) return null
  if (!MESH_REACHES.has(raw.reach) || typeof raw.endpoint !== 'string' || raw.endpoint.length > MESH_VALUE_MAX) return null
  if (typeof raw.signed !== 'boolean' || (raw.keysNew !== undefined && typeof raw.keysNew !== 'boolean')) return null
  if (!Array.isArray(raw.skills) || typeof raw.pin !== 'string' || !MESH_PIN.test(raw.pin)) return null
  const skills = raw.skills.slice(0, 16).map(meshSkill)
  if (skills.includes(null)) return null
  Object.assign(out, { reach: raw.reach, endpoint: raw.endpoint, signed: raw.signed })
  if (raw.keysNew !== undefined) out.keysNew = raw.keysNew
  return Object.assign(out, { skills, pin: raw.pin })
}

// an add's plan and its card: a plan with no refusal carries a card with an id
function meshAdd(value) {
  const plan = meshPlan(value)
  if (plan === null) return null
  if (value.card === undefined) return plan.refused === undefined ? null : plan
  const card = meshCard(value.card)
  if (card === null || (plan.refused === undefined && card.id === undefined)) return null
  plan.card = card
  return plan
}

const MESH_ANSWERS = { servers: meshServers, 'check-server': meshCheck, 'check-agent': meshAdd, 'add-agent': meshAdd }

function meshAnswer(operation, value) {
  if (!isPlainObject(value)) return meshFailed()
  if (value.ok === false && typeof value.reason === 'string') return meshFailed(MESH_REASONS.has(value.reason) ? value.reason : 'failed')
  const rebuilt = (Object.hasOwn(MESH_ANSWERS, operation) ? MESH_ANSWERS[operation] : meshPlan)(value)
  return rebuilt ?? meshFailed()
}

function meshChosen(value) {
  if (!isPlainObject(value)) return meshFailed()
  if (value.ok === true && typeof value.handle === 'string' && MESH_HANDLE.test(value.handle) && typeof value.name === 'string') {
    return { ok: true, handle: value.handle, name: meshCut(value.name, 80) }
  }
  return meshFailed(value.ok === false && MESH_REASONS.has(value.reason) ? value.reason : 'failed')
}

function meshAvailability(value) {
  if (isPlainObject(value) && value.available === true) return { available: true }
  return { available: false, reason: isPlainObject(value) && MESH_REASONS.has(value.reason) ? value.reason : 'failed' }
}

contextBridge.exposeInMainWorld('agentInboxMesh', {
  available(...args) {
    if (args.length !== 0) return Promise.resolve({ available: false, reason: 'invalid' })
    return ipcRenderer.invoke('agent-inbox:mesh-available').then(meshAvailability, () => meshAvailability(null))
  },
  run(...args) {
    const values = args.length === 2 ? meshValues(args[0], args[1]) : null
    if (!values) return Promise.resolve(meshFailed('invalid'))
    const operation = args[0]
    return ipcRenderer.invoke('agent-inbox:mesh-run', operation, values).then((value) => meshAnswer(operation, value), () => meshFailed())
  },
  chooseFile(...args) {
    if (args.length !== 1 || (args[0] !== 'key' && args[0] !== 'token')) return Promise.resolve(meshFailed('invalid'))
    return ipcRenderer.invoke('agent-inbox:mesh-choose-file', args[0]).then(meshChosen, () => meshFailed())
  },
})

// #617 PR 3b: the same `agentInboxDesk` the hub view has, answering for This Mac. No IPC: the
// local page is This Mac. #617 PR 4b: Open desk is offered only in the hub's page, so here
// `available()` stays `{ open: false }` and there is no `open`.
contextBridge.exposeInMainWorld('agentInboxDesk', {
  available() {
    return Promise.resolve({ open: false })
  },
  connection() {
    return Promise.resolve({ mode: 'local' })
  },
  onConnection() {
    return () => {}
  },
})

// #617 PR 3b: another Mac's Inbox, for the Settings form a later PR adds. Main answers only the
// viewer this app started and owns, and checks every argument again; each answer is rebuilt here
// field by field. The connection's secret, its encrypted copy, the device id and the node id are
// never in an answer.
const CONNECT_STATES = new Set(['online', 'retrying', 'refused'])
const CONNECT_WORD = /^[a-z_]{1,40}$/
const HUB_ID_TEXT = /^[0-9a-f]{8}$/
const connectOff = () => ({ available: false })
const wordOf = (value) => (typeof value === 'string' && CONNECT_WORD.test(value) ? value : null)
const hubIdOf = (value) => (typeof value === 'string' && HUB_ID_TEXT.test(value) ? value : null)
const shortTextOf = (value, max) => (typeof value === 'string' && value.length >= 1 && value.length <= max ? value : null)

function connectHub(value) {
  if (!isPlainObject(value) || hubIdOf(value.id) === null || shortTextOf(value.label, 40) === null) return null
  if (typeof value.origin !== 'string' || !value.origin.startsWith('https://') || value.origin.length > 300) return null
  return {
    id: value.id,
    label: value.label,
    origin: value.origin,
    machine: shortTextOf(value.machine, 64),
    state: CONNECT_STATES.has(value.state) ? value.state : null,
    reason: wordOf(value.reason),
    // #617 PR 4b: the saved Open desk command, shown in Settings on this Mac
    deskCommand: shortTextOf(value.deskCommand, 512),
  }
}

function connectView(value) {
  if (!isPlainObject(value) || value.available !== true) return connectOff()
  return { available: true, keychain: value.keychain === true, hub: connectHub(value.hub), problem: wordOf(value.problem), showing: hubIdOf(value.showing) }
}

function connectResult(value) {
  if (!isPlainObject(value)) return { ok: false, reason: 'failed' }
  if (value.ok === true) {
    const out = { ok: true }
    if (hubIdOf(value.id) !== null) out.id = value.id
    if (shortTextOf(value.label, 40) !== null) out.label = value.label
    if (CONNECT_STATES.has(value.state)) out.state = value.state
    if ('reason' in value) out.reason = wordOf(value.reason)
    if ('showing' in value) out.showing = hubIdOf(value.showing)
    if (value.replacedHub === true) out.replacedHub = true
    return out
  }
  if (value.ok === false) {
    const out = { ok: false, reason: wordOf(value.reason) ?? 'failed' }
    if (value.pairedOnHub === true) out.pairedOnHub = true
    return out
  }
  return value.available === false ? connectOff() : { ok: false, reason: 'failed' }
}

const connectCall = (rebuild, channel, ...args) => ipcRenderer.invoke(channel, ...args).then(rebuild, () => rebuild(undefined))

// #637: the hub's update as Settings shows it (electron/hub-update.cjs), rebuilt field by field
const HUB_UPDATE_PHASES = new Set(['idle', 'updating', 'restarting', 'done', 'failed', 'not_back', 'offline', 'old_hub', 'refused', 'unreadable'])
const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const releaseOf = (value) => (typeof value === 'string' && RELEASE_VERSION.test(value) ? value : null)

function hubUpdateView(value) {
  if (isPlainObject(value) && value.available === false) return connectOff()
  if (!isPlainObject(value) || value.ok !== true || !HUB_UPDATE_PHASES.has(value.phase)) return { ok: false, reason: isPlainObject(value) ? wordOf(value.reason) ?? 'failed' : 'failed' }
  return {
    ok: true,
    phase: value.phase,
    version: releaseOf(value.version),
    status: wordOf(value.status),
    newer: releaseOf(value.newer),
    canStart: value.canStart === true,
    reason: wordOf(value.reason),
  }
}
const hubIdArgument = (args) => args.length === 1 && hubIdOf(args[0]) !== null

contextBridge.exposeInMainWorld('agentInboxConnect', {
  view(...args) {
    if (args.length !== 0) return Promise.resolve(connectOff())
    return connectCall(connectView, 'agent-inbox:connect-view')
  },
  // { address, code, replace? }: a fresh object of exactly those, which main checks again
  connect(...args) {
    const given = args[0]
    if (args.length !== 1 || !isPlainObject(given) || typeof given.address !== 'string' || typeof given.code !== 'string' ||
        (given.replace !== undefined && typeof given.replace !== 'boolean')) return Promise.resolve(connectOff())
    return connectCall(connectResult, 'agent-inbox:connect-connect', { address: given.address, code: given.code, replace: given.replace === true })
  },
  forget(...args) {
    if (args.length !== 1 || typeof args[0] !== 'string' || args[0].length > 64) return Promise.resolve(connectOff())
    return connectCall(connectResult, 'agent-inbox:connect-forget', args[0])
  },
  // #617 PR 4b: { id, command }, exactly, as a fresh copy. '' removes the command; any other text
  // main checks, then shows in a native dialog, and saves only when the owner presses Save there.
  setDeskCommand(...args) {
    const given = args[0]
    if (args.length !== 1 || !isPlainObject(given)) return Promise.resolve(connectOff())
    const keys = Object.keys(given)
    if (keys.length !== 2 || !keys.includes('id') || !keys.includes('command') ||
        typeof given.id !== 'string' || given.id.length > 64 || typeof given.command !== 'string' || given.command.length > 4096) return Promise.resolve(connectOff())
    return connectCall(connectResult, 'agent-inbox:connect-desk-command', { id: given.id, command: given.command })
  },
  // which view is on top: a hub's id, or null for This Mac
  show(...args) {
    if (args.length !== 1 || (args[0] !== null && (typeof args[0] !== 'string' || args[0].length > 64))) return Promise.resolve(connectOff())
    return connectCall(connectResult, 'agent-inbox:connect-show', args[0])
  },
  // #637: the connected hub's update, by its id: what it would be, and the one request that starts it.
  // The request names nothing else: the hub installs only the release its own controller verified.
  hubUpdate(...args) {
    if (!hubIdArgument(args)) return Promise.resolve(connectOff())
    return connectCall(hubUpdateView, 'agent-inbox:connect-hub-update', args[0])
  },
  updateHub(...args) {
    if (!hubIdArgument(args)) return Promise.resolve(connectOff())
    return connectCall(connectResult, 'agent-inbox:connect-hub-update-start', args[0])
  },
  // the change message carries nothing: the page asks view() again
  onChange(callback) {
    if (typeof callback !== 'function') return () => {}
    const listener = () => callback()
    ipcRenderer.on('agent-inbox:connect-changed', listener)
    return () => ipcRenderer.removeListener('agent-inbox:connect-changed', listener)
  },
})

function isByteCount(value) {
  return Number.isSafeInteger(value) && value >= 0
}

// installable implies downloadable, and installPermitted (#216) implies installable;
// a reason explains only a notify-only offer. A release this Mac can't run (#343) is
// only ever such an offer, still on `available`, with its reason. installWithheld
// (#465) explains only a download no installer was registered for.
const MAX_INSTALL_NOTICE_LENGTH = 400
const BLOCKED_REASONS = new Set(['apple-silicon', 'rosetta'])
const INSTALL_WITHHELD_REASONS = new Set(['unowned-viewer'])

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
    (available.blocked === undefined || (
      BLOCKED_REASONS.has(available.blocked) &&
      status === 'available' &&
      typeof available.reason === 'string'
    )) &&
    (available.installWithheld === undefined || (
      INSTALL_WITHHELD_REASONS.has(available.installWithheld) &&
      available.downloadable &&
      !available.installable
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
    // as onToggleSettings: the callback hears whether another Mac's Inbox was on top (#617)
    onOpenUpdates(callback) {
      if (typeof callback !== 'function') return () => {}
      const listener = (_event, fromHub) => callback(fromHub === true)
      ipcRenderer.on('agent-inbox:open-updates', listener)
      return () => ipcRenderer.removeListener('agent-inbox:open-updates', listener)
    },
  })
}

// ── #617 PR 2d: Settings → Other devices (sharing this Inbox with your other Macs) ──
// Main owns the hub's remote-entry controller; the page names a device id, a digest it was shown
// or a boolean, nothing else. Every answer is rebuilt here field by field, and an answer with a
// field of the wrong shape is refused whole: a login, a secret hash, the owner token or a code's
// id never reaches the page, whatever main sends. The pairing code does: the owner reads it off
// the screen.
const REMOTE_WORD = /^[a-z_]{1,40}(:[a-z_]{1,40})?$/
const REMOTE_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/
const REMOTE_DEVICE_ID = /^[0-9a-f]{16}$/
const REMOTE_DIGEST = /^[0-9a-f]{64}$/
const REMOTE_CODE = /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/
const REMOTE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
const REMOTE_REMOVAL_HINT = 'tailscale serve --https=443 off'
const REMOTE_UNAVAILABLE = new Set(['unsupported', 'unowned'])
const REMOTE_STEPS = new Set(['file', 'self', 'serve'])
const REMOTE_COUNTS = ['devicesRemoved', 'droppedEntries', 'removed']
const isRemoteWord = (value) => typeof value === 'string' && REMOTE_WORD.test(value)
const isRemoteCount = (value) => Number.isSafeInteger(value) && value >= 0
const isRemotePort = (value) => Number.isInteger(value) && value >= 1024 && value <= 65535
const isRemoteTime = (value) => typeof value === 'string' && REMOTE_TIME.test(value) && !Number.isNaN(Date.parse(value))
const remoteOr = (value, check) => (value === null ? true : check(value))

function remoteUnavailable(value) {
  return REMOTE_UNAVAILABLE.has(value.reason) ? { available: false, reason: value.reason } : { available: false }
}

const isRemoteLabel = (value) => typeof value === 'string' && Array.from(value).length >= 1 && Array.from(value).length <= 40

function remoteDevice(value) {
  if (!isPlainObject(value) || typeof value.id !== 'string' || !REMOTE_DEVICE_ID.test(value.id) || !isRemoteLabel(value.label)) return null
  // a date that is not a real one is no date: one bad field of one Mac never costs the panel
  return { id: value.id, label: value.label, pairedAt: isRemoteTime(value.pairedAt) ? value.pairedAt : null }
}

const isRemoteLabels = (value) => Array.isArray(value) && value.length <= 16 && value.every(isRemoteLabel)

// what changed outside the app: labels, booleans and counts only
function remoteChanges(value) {
  if (!isPlainObject(value)) return null
  const flags = ['unknown', 'missing', 'unreadable', 'address', 'account', 'port']
  if (!flags.every((key) => typeof value[key] === 'boolean') || !remoteOr(value.switched, (w) => w === 'on' || w === 'off')) return null
  if (![value.added, value.removed, value.keyChanged].every(isRemoteLabels)) return null
  if (!isRemoteCount(value.unreadableAdded) || !isRemoteCount(value.unreadableRemoved)) return null
  const out = { switched: value.switched }
  for (const key of flags) out[key] = value[key]
  return {
    ...out, added: [...value.added], removed: [...value.removed], keyChanged: [...value.keyChanged],
    unreadableAdded: value.unreadableAdded, unreadableRemoved: value.unreadableRemoved,
  }
}

function remoteRefusal(value) {
  if (!isPlainObject(value) || !isRemoteWord(value.reason) || !remoteOr(value.step, (s) => REMOTE_STEPS.has(s))) return null
  if (!remoteOr(value.devices, isRemoteCount) || !Number.isSafeInteger(value.at)) return null
  return { reason: value.reason, step: value.step, devices: value.devices, at: value.at }
}

function remoteView(value) {
  if (!isPlainObject(value)) return null
  if (value.available === false) return remoteUnavailable(value)
  if (value.available !== true) return null
  const {
    enabled, host, port, devices, unreadableDevices, problem, flag, digest, wanted, stopped, resume, needsOwner, stateSaved, serve, removalHint, command, loginItem,
    listening, listenError, changes, refusal, inboxUnreachable,
  } = value
  if (typeof enabled !== 'boolean' || typeof flag !== 'boolean' || typeof wanted !== 'boolean' || typeof listening !== 'boolean') return null
  if (!remoteOr(host, (h) => typeof h === 'string' && h.length <= 253 && REMOTE_HOST.test(h)) || !isRemotePort(port)) return null
  if (!Array.isArray(devices) || devices.length > 16 || !isRemoteCount(unreadableDevices) || unreadableDevices > 16) return null
  const listed = devices.map(remoteDevice)
  if (listed.includes(null)) return null
  if (!remoteOr(problem, isRemoteWord) || !remoteOr(digest, (d) => typeof d === 'string' && REMOTE_DIGEST.test(d))) return null
  if (!remoteOr(stopped, (s) => isPlainObject(s) && isRemoteWord(s.reason) && typeof s.willResume === 'boolean')) return null
  if (!remoteOr(resume, (r) => isPlainObject(r) && isRemoteWord(r.waiting) && remoteOr(r.nextAt, Number.isSafeInteger))) return null
  if (!remoteOr(needsOwner, (n) => n === 'identity_changed') || !remoteOr(stateSaved, (s) => typeof s === 'boolean')) return null
  if (!remoteOr(serve, (s) => isPlainObject(s) && (s.ok === true || (s.ok === false && remoteOr(s.reason, isRemoteWord))))) return null
  if (!remoteOr(removalHint, (h) => h === REMOTE_REMOVAL_HINT) || command !== `tailscale serve --bg ${port}`) return null
  if (!isPlainObject(loginItem) || typeof loginItem.available !== 'boolean' || typeof loginItem.openAtLogin !== 'boolean' || typeof loginItem.needsApproval !== 'boolean') return null
  if (!remoteOr(listenError, (w) => w === 'port_in_use' || w === 'cannot_listen') || typeof inboxUnreachable !== 'boolean') return null
  const changed = changes === null ? null : remoteChanges(changes)
  const refused = refusal === null ? null : remoteRefusal(refusal)
  if ((changes !== null && changed === null) || (refusal !== null && refused === null)) return null
  return {
    available: true, enabled, host, port, devices: listed, unreadableDevices, problem, flag, digest, wanted,
    stopped: stopped && { reason: stopped.reason, willResume: stopped.willResume },
    resume: resume && { waiting: resume.waiting, nextAt: resume.nextAt },
    needsOwner, stateSaved,
    serve: serve && (serve.ok ? { ok: true } : { ok: false, reason: serve.reason }),
    removalHint, command,
    loginItem: { available: loginItem.available, openAtLogin: loginItem.openAtLogin, needsApproval: loginItem.needsApproval },
    listening, listenError, changes: changed, refusal: refused, inboxUnreachable,
  }
}

const remoteFailed = () => ({ ok: false, reason: 'failed' })

function remoteResult(value) {
  if (!isPlainObject(value)) return remoteFailed()
  if (value.available === false) return remoteUnavailable(value)
  if (typeof value.ok !== 'boolean') return remoteFailed()
  if (!value.ok) {
    if (!isRemoteWord(value.reason)) return remoteFailed()
    const out = { ok: false, reason: value.reason }
    if (REMOTE_STEPS.has(value.step)) out.step = value.step
    if ('rose' in value && remoteOr(value.rose, isRemoteWord)) out.rose = value.rose
    if (isRemoteCount(value.devices)) out.devices = value.devices
    return out
  }
  const out = { ok: true }
  if (typeof value.voidedCode === 'boolean') out.voidedCode = value.voidedCode
  for (const field of REMOTE_COUNTS) if (isRemoteCount(value[field])) out[field] = value[field]
  if (typeof value.openAtLogin === 'boolean') out.openAtLogin = value.openAtLogin
  if (typeof value.listening === 'boolean') out.listening = value.listening
  if ('code' in value || 'expiresAt' in value) {
    if (typeof value.code !== 'string' || !REMOTE_CODE.test(value.code) || !isRemoteTime(value.expiresAt)) return remoteFailed()
    out.code = value.code
    out.expiresAt = value.expiresAt
  }
  return out
}

const remoteInvalid = () => Promise.resolve({ ok: false, reason: 'invalid' })
const remoteCall = (channel, ...args) => ipcRenderer.invoke(channel, ...args).then(remoteResult, remoteFailed)
let remoteChange = null

contextBridge.exposeInMainWorld('agentInboxRemoteEntry', {
  get(...args) {
    if (args.length !== 0) return Promise.resolve({ available: false, reason: 'invalid' })
    return ipcRenderer.invoke('agent-inbox:remote-entry').then(
      (value) => remoteView(value) ?? { available: false, reason: 'failed' },
      () => ({ available: false, reason: 'failed' }),
    )
  },
  turnOn(...args) {
    return args.length === 0 ? remoteCall('agent-inbox:remote-entry-turn-on') : remoteInvalid()
  },
  turnOff(...args) {
    return args.length === 0 ? remoteCall('agent-inbox:remote-entry-turn-off') : remoteInvalid()
  },
  removeDevice(...args) {
    if (args.length !== 1 || typeof args[0] !== 'string' || !REMOTE_DEVICE_ID.test(args[0])) return remoteInvalid()
    return remoteCall('agent-inbox:remote-entry-remove-device', args[0])
  },
  clearUnreadable(...args) {
    return args.length === 0 ? remoteCall('agent-inbox:remote-entry-clear-unreadable') : remoteInvalid()
  },
  repairPermissions(...args) {
    return args.length === 0 ? remoteCall('agent-inbox:remote-entry-repair') : remoteInvalid()
  },
  // the digest get() answered with, for exactly what the page showed
  acknowledge(...args) {
    if (args.length !== 1 || typeof args[0] !== 'string' || !REMOTE_DIGEST.test(args[0])) return remoteInvalid()
    return remoteCall('agent-inbox:remote-entry-acknowledge', args[0])
  },
  test(...args) {
    return args.length === 0 ? remoteCall('agent-inbox:remote-entry-test') : remoteInvalid()
  },
  addDevice(...args) {
    if (args.length !== 0) return remoteInvalid()
    return remoteCall('agent-inbox:remote-entry-add-device').then((result) => (result.ok && !result.code ? remoteFailed() : result))
  },
  setOpenAtLogin(...args) {
    if (args.length !== 1 || typeof args[0] !== 'boolean') return remoteInvalid()
    return remoteCall('agent-inbox:remote-entry-open-at-login', args[0])
  },
  // switching on that removes the paired Macs, after the owner agreed on the page
  turnOnRemovingDevices(...args) {
    return args.length === 0 ? remoteCall('agent-inbox:remote-entry-turn-on-remove-devices') : remoteInvalid()
  },
  // Settings opened: main reads Serve again for the removal hint
  recheck(...args) {
    return args.length === 0 ? remoteCall('agent-inbox:remote-entry-recheck') : remoteInvalid()
  },
  // one listener at a time, called with nothing; null removes it
  onChange(...args) {
    if (args.length !== 1 || (args[0] !== null && typeof args[0] !== 'function')) return false
    if (remoteChange) ipcRenderer.removeListener('agent-inbox:remote-entry-changed', remoteChange)
    remoteChange = null
    const listener = args[0]
    if (listener) {
      remoteChange = () => listener()
      ipcRenderer.on('agent-inbox:remote-entry-changed', remoteChange)
    }
    return true
  },
})
