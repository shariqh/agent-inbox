// Electron main process for the agent-inbox viewer (GitHub issue #11).
//
// This file is CommonJS (.cjs) on purpose: the repo is "type":"module" (TS ESM),
// and keeping the Electron main process in CJS avoids ESM/Electron loader friction.
//
// Behavior:
//   1. If a hardened viewer is already listening on
//      http://127.0.0.1:<AGENT_INBOX_PORT|4319>, reuse it (never start a second
//      one, never kill it on quit). We re-probe before committing (a dying viewer
//      can answer one probe then vanish), and once reusing we watch it and start
//      our own server if it disappears (#23).
//   2. Otherwise run dist/viewer-server.js IN THIS PROCESS (Electron's bundled
//      Node) — this is what makes the packaged .app self-contained. It requires
//      better-sqlite3 built for Electron's ABI (the package script does this).
//   3. Dev fallback: if the in-process import fails (repo node_modules are built
//      for system Node 24, not Electron), spawn `node dist/viewer-server.js` as
//      before and kill that child on quit — only because we own it.
//   4. Open a BrowserWindow on the viewer URL once the server responds.

const { app, BrowserWindow, dialog, ipcMain, Menu, Notification, nativeTheme, session, shell } = require('electron')
const { spawn } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const { existsSync } = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { classifyReuse, watchUpstream } = require('./reuse.cjs')
const { loadViewer, reloadViewer } = require('./viewer-navigation.cjs')
const { isTrustedLinkSender, isViewerUrl, openLinkRequest, openWebLink } = require('./link-open.cjs')
const { createLinkPreferences, createLinkSettings } = require('./link-preferences.cjs')
const { canRunSetup, createInstallBinding, createInstallGate, installerRepoRoot, runAgentInstall, runtimeKey, selectRuntimePayload } = require('./setup-runner.cjs')
const { MANUAL_RELEASES_URL, createUpdateController } = require('./update-controller.cjs')
const { createUpdateDownloader } = require('./update-download.cjs')
const { createInstallAttemptStore } = require('./update-install.cjs')
const { bundlePathFromExecPath, createMacInstaller } = require('./update-install-macos.cjs')
const { createAppImageInstaller } = require('./update-install-appimage.cjs')
const { checkForUpdate, runsFromAppImage } = require('./update-fetch.cjs')
const { createUpdatePreferences, createUpdateTrustState } = require('./update-preferences.cjs')
const { loadUpdateRegistry } = require('./update-trust.cjs')
const { createConditionalReader } = require('./conditional-read.cjs')
const { syncSpellcheckLanguages } = require('./spellcheck-languages.cjs')
const { quitWhenRestartManagerAsks, setWindowsAppIdentity } = require('./windows-app.cjs')
const {
  attentionNotification,
  cannedResponseActions,
  createNotificationRetainer,
  createResponseWatch,
  formatResponseReminder,
  freshAttentionNotifications,
  knownNotificationIds,
  refreshNotificationTarget,
  responseForNotificationAction,
  runWakeAdapter,
  submitNotificationResponse,
  wakeAdapterFromEnv,
  wakeAdapterPayload,
} = require('./reply-watch.cjs')

// Windows (#87): the per-user MSI's Start-menu shortcut carries this app's
// AppUserModelID and toast activator CLSID; claim them before any window or
// notification exists (windows-app.cjs).
try {
  setWindowsAppIdentity({ app, platform: process.platform })
} catch (err) {
  console.error(`[agent-inbox] could not set the Windows app identity: ${err.message}`)
}

const PORT = Number(process.env.AGENT_INBOX_PORT ?? 4319)
const VIEWER_HOST = '127.0.0.1'
const URL_BASE = `http://${VIEWER_HOST}:${PORT}/`
const BOUNDARY_HEADER = 'x-agent-inbox-local-boundary'
const BOUNDARY_VERSION = 'loopback-v1'
const OWNER_TOKEN = randomBytes(32).toString('hex')
const REPO_ROOT = path.resolve(__dirname, '..')
const updateKeyRegistry = loadUpdateRegistry({
  registryPath: path.join(REPO_ROOT, 'release', 'update-keys.json'),
})
const UPDATE_PLATFORMS = new Set(['darwin', 'linux'])
const UPDATE_ARCHITECTURES = new Set(['x64', 'arm64'])
const updateFeatureAvailable = (
  app.isPackaged &&
  updateKeyRegistry !== null &&
  UPDATE_PLATFORMS.has(process.platform) &&
  UPDATE_ARCHITECTURES.has(process.arch)
)
const responseWatch = createResponseWatch()
const notificationRetainer = createNotificationRetainer()
const wakeAdapter = wakeAdapterFromEnv(process.env)
const THEME_SOURCE_VALUES = new Set(['light', 'dark', 'system'])
const THEME_BACKGROUND_COLORS = {
  light: '#edf0f2',
  dark: '#090b0d',
}
let setupInstallEnabled = false
let setupInstallWebContentsId = null
// Grants the window Setup and update installs (#216); created with the window.
let installBinding = null
// The one Setup install in flight, and whether the app has begun to quit
// (#205 review): see beginAppQuit().
const installGate = createInstallGate()
// Issue #74: which exact runtime payload (if any) this release build selected
// for this host, computed once ownership of the viewer is proven. Stays at
// its unresolved default for a dev/legacy checkout — installerRepoRoot alone
// still gates that path, exactly as before.
let runtimeSelection = { ok: false, reason: 'unresolved', key: runtimeKey(process.platform, process.arch) }
let themeWindow = null
let themeWindowWebContentsId = null
// The one viewer window whose top frame may ask main to open a link (#300).
let linkWindow = null
// That window's id while it shows the viewer this app started and proved it
// owns (#300): only then may a link open, reveal or preview a local file. Held
// by the window's binding (#216), so a reload revokes it until the re-proof.
let fileLinkWebContentsId = null
let updateWindow = null
let updateController = null
// True only once waitForOwnership() proved the viewer is the one this app
// started; a reused or failed-over viewer never gets in-app update installs.
let viewerOwned = false
let updateInstallWebContentsId = null
let updateRestartRequested = false
let quitAfterUpdateInstall = false

function isTrustedThemeSender(senderUrl) {
  try {
    return new URL(senderUrl).origin === new URL(URL_BASE).origin
  } catch {
    return false
  }
}

function isTrustedUpdateSender(senderUrl, sender) {
  if (!updateFeatureAvailable || !updateWindow || updateWindow.isDestroyed()) return false
  if (updateWindow.webContents.isDestroyed() || sender !== updateWindow.webContents) return false
  try {
    return new URL(senderUrl).origin === new URL(URL_BASE).origin
  } catch {
    return false
  }
}

// Whether the install IPC would accept the update window right now (#216), so
// Settings never offers an Install and restart that main would refuse. The
// IPC handler still checks the binding itself.
function updateInstallPermitted() {
  return !installGate.quitting() &&
    updateWindow !== null &&
    !updateWindow.isDestroyed() &&
    !updateWindow.webContents.isDestroyed() &&
    updateInstallWebContentsId === updateWindow.webContents.id
}

function unavailableUpdateState() {
  return {
    status: 'unsupported',
    currentVersion: app.getVersion(),
    automaticChecks: false,
    checkedAt: null,
    message: 'Updates are not available for this app build.',
  }
}

function sendUpdateState(state) {
  if (!updateWindow || updateWindow.isDestroyed() || updateWindow.webContents.isDestroyed()) return
  updateWindow.webContents.send('agent-inbox:update-state-changed', state)
}

function validateReleaseUrl(value, version) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    return null
  }
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'github.com' ||
      url.port !== '' ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.pathname !== `/shariqh/agent-inbox/releases/tag/v${version}`
    ) {
      return null
    }
    return url.href
  } catch {
    return null
  }
}

function openUpdatesWindow(win) {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  win.webContents.send('agent-inbox:open-updates')
}

ipcMain.handle('agent-inbox:update-state', (event, ...args) => {
  if (args.length !== 0 || !isTrustedUpdateSender(event.senderFrame?.url ?? '', event.sender)) {
    return unavailableUpdateState()
  }
  return updateController?.getState() ?? unavailableUpdateState()
})

ipcMain.handle('agent-inbox:update-check', (event, ...args) => {
  if (args.length !== 0 || !isTrustedUpdateSender(event.senderFrame?.url ?? '', event.sender)) {
    return unavailableUpdateState()
  }
  return updateController?.checkNow() ?? unavailableUpdateState()
})

ipcMain.handle('agent-inbox:update-automatic', (event, enabled, ...args) => {
  if (
    args.length !== 0 ||
    typeof enabled !== 'boolean' ||
    !isTrustedUpdateSender(event.senderFrame?.url ?? '', event.sender)
  ) {
    return false
  }
  return updateController?.setAutomaticChecks(enabled) ?? false
})

// User-initiated only. The renderer names nothing: main downloads the artifact
// the signed manifest pinned, and progress arrives as state-changed events.
ipcMain.handle('agent-inbox:update-download', (event, ...args) => {
  if (args.length !== 0 || !isTrustedUpdateSender(event.senderFrame?.url ?? '', event.sender)) {
    return unavailableUpdateState()
  }
  if (!updateController) return unavailableUpdateState()
  updateController.downloadNow().catch(() => {})
  return updateController.getState()
})

ipcMain.handle('agent-inbox:update-download-cancel', (event, ...args) => {
  if (args.length !== 0 || !isTrustedUpdateSender(event.senderFrame?.url ?? '', event.sender)) {
    return unavailableUpdateState()
  }
  return updateController?.cancelDownload() ?? unavailableUpdateState()
})

// User-initiated only, and only from the window bound to a viewer this app
// started and owns: at its first navigation, or again once a later load has
// re-proven it (#216). The renderer names nothing: main installs the verified
// download behind the current offer, and progress arrives as state-changed
// events.
ipcMain.handle('agent-inbox:update-install', (event, ...args) => {
  const senderUrl = event.senderFrame?.url ?? ''
  if (args.length !== 0 || !isTrustedUpdateSender(senderUrl, event.sender)) {
    return unavailableUpdateState()
  }
  if (!updateController) return unavailableUpdateState()
  // Once the app has begun to quit, no update install starts (#205).
  if (installGate.quitting()) return updateController.getState()
  if (!canRunSetup(senderUrl, URL_BASE, event.sender.id, updateInstallWebContentsId)) {
    return updateController.refuseInstall('Restart Agent Inbox to install this update.')
  }
  updateController.installNow().catch(() => {})
  return updateController.getState()
})

// Settings offers Restart Agent Inbox only for a verified download this window
// may not install (#216), and main accepts the request only in exactly that
// state. No other state or page can quit the app or relaunch it in a loop
// through this, and it never cancels a running Setup (#205), which the update
// install path refuses too. macOS only: an AppImage relaunched by Electron would
// start from the image's mount, which is gone once the app exits, so there
// Settings asks to quit and reopen instead.
ipcMain.handle('agent-inbox:update-restart', (event, ...args) => {
  if (args.length !== 0 || !isTrustedUpdateSender(event.senderFrame?.url ?? '', event.sender)) return false
  if (process.platform !== 'darwin' || !viewerOwned || !updateController) return false
  if (installGate.quitting() || installGate.running() || updateController.isInstalling()) return false
  const state = updateController.getState()
  const offered = (state.status === 'verified' || state.status === 'install-failed') && state.available?.installable === true
  if (!offered || updateInstallPermitted()) return false
  restartToInstallUpdate()
  return true
})

ipcMain.handle('agent-inbox:update-open-release', async (event, ...args) => {
  if (args.length !== 0 || !isTrustedUpdateSender(event.senderFrame?.url ?? '', event.sender)) return false
  const state = updateController?.getState()
  const verifiedUrl = state?.available
    ? validateReleaseUrl(state.available.releaseUrl, state.available.version)
    : null
  const releaseUrl = verifiedUrl ?? MANUAL_RELEASES_URL
  await shell.openExternal(releaseUrl)
  return true
})

// Every path that ends the app calls this FIRST — `before-quit` below, and any
// other quit or restart path (an update restart included) — and waits for the
// promise it returns before the app exits. From then on Setup starts nothing:
// an install started mid-shutdown can be killed halfway through replacing a
// registration (#205 review). It takes Setup and update installs away from the
// window (the update controller also checks installGate.quitting()) and cancels
// the Setup install already running; the promise settles once nothing runs.
function beginAppQuit() {
  setupInstallWebContentsId = null
  updateInstallWebContentsId = null
  return installGate.beginQuit()
}

// Asked once per page load and again when Settings opens. A reload's re-proof
// may still be running (#216): answer once it has settled, so a reloaded window
// is not left with copy-only Setup.
ipcMain.handle('agent-inbox:install-available', async (event) => {
  await installBinding?.settled()
  return !installGate.quitting() &&
    setupInstallEnabled &&
    canRunSetup(event.senderFrame?.url ?? '', URL_BASE, event.sender.id, setupInstallWebContentsId)
})

ipcMain.handle('agent-inbox:install', async (event, target) => {
  if (installGate.quitting()) {
    return { ok: false, exitCode: null, output: 'Agent Inbox is quitting, so setup did not start.', target, timedOut: false, cancelled: true }
  }
  const senderUrl = event.senderFrame?.url ?? ''
  if (!setupInstallEnabled ||
      !canRunSetup(senderUrl, URL_BASE, event.sender.id, setupInstallWebContentsId)) {
    return { ok: false, exitCode: null, output: 'One-click setup is unavailable for this viewer.', target, timedOut: false }
  }
  // Issue #74: a release build's installer script lives INSIDE the exact,
  // digest-verified runtime payload DIRECTORY selectRuntimePayload resolved —
  // never installerRepoRoot(REPO_ROOT), which only ever finds a builder's own
  // checkout. A dev/legacy checkout (no runtimePayloads at all) is unaffected
  // and keeps looking for scripts/install-agents.sh via installerRepoRoot.
  const isReleaseBuild = runtimeSelection.reason !== 'no-release-payloads'
  const repoRoot = isReleaseBuild
    ? (runtimeSelection.ok ? runtimeSelection.path : null)
    : installerRepoRoot(REPO_ROOT)
  if (!repoRoot) {
    return { ok: false, exitCode: null, output: 'The agent-inbox checkout or installer could not be found.', target, timedOut: false }
  }
  // An app update and agent Setup never run together. Nothing awaits between
  // this check and installGate.run(), so neither can start in the gap.
  // `cancelled` stops a multi-host Setup run here, as a quit does, rather than
  // reporting every remaining host as refused.
  if (updateController?.isInstalling()) {
    return { ok: false, exitCode: null, output: 'An Agent Inbox update is being installed. Try again after it restarts.', target, timedOut: false, cancelled: true }
  }
  // Release builds (issue #74) pass the exact, digest-verified runtime payload
  // through so the installer stages a portable runtime instead of assuming a
  // source checkout; dev/legacy builds pass none and keep today's invocation.
  const started = installGate.run((onCancel) => runAgentInstall({
    repoRoot,
    target,
    runtimePayload: runtimeSelection.ok
      ? {
          key: runtimeSelection.key,
          path: runtimeSelection.path,
          digest: runtimeSelection.digest,
          packageVersion: runtimeSelection.packageVersion,
        }
      : null,
    onCancel,
  }))
  if (started.refused === 'quitting') {
    return { ok: false, exitCode: null, output: 'Agent Inbox is quitting, so setup did not start.', target, timedOut: false, cancelled: true }
  }
  if (started.refused) {
    return { ok: false, exitCode: null, output: 'Agent setup is already running.', target, timedOut: false }
  }
  return await started.promise
})

// Issue #300: the viewer asks, main decides. Only the viewer window's own top
// frame on the viewer origin may ask (see isTrustedLinkSender), with exactly one
// request; link-open.cjs re-validates it and opens a web link, opens a common
// document type with its default app or the app a Settings → Links rule names,
// or only reveals anything else. A local file is opened, revealed or previewed
// only while that window shows the viewer this app started and proved it owns
// (fileLinkWebContentsId, re-proved after every load as installs are), and only
// that viewer may read or change Settings → Links; a reused viewer's page can
// still open web links.
const linkSender = (event) => isTrustedLinkSender({ sender: event.sender, senderFrame: event.senderFrame, window: linkWindow, viewerUrl: URL_BASE })
const linkFilesPermitted = (event) => fileLinkWebContentsId !== null && event.sender.id === fileLinkWebContentsId
// Settings → Links (part 2): main's own file, read on each open, so a change
// applies to the next click. An unreadable file means the system defaults.
let linkPreferences = null
const linkPrefs = () => (linkPreferences ??= createLinkPreferences({ app }))
const linkRules = () => linkPrefs().read().catch(() => null)
const linkOpening = { platform: process.platform, spawnImpl: spawn }

ipcMain.handle('agent-inbox:open-link', async (event, request, ...args) => {
  if (args.length !== 0 || !linkSender(event)) return { ok: false, reason: 'unavailable' }
  return openLinkRequest(request, {
    shell, homeDir: app.getPath('home'), filesPermitted: linkFilesPermitted(event), rules: await linkRules(), ...linkOpening,
  })
})

// Whether this page may open local files, asked once per page load and again
// when Settings opens, as Setup's is: a reload's re-proof may still be running,
// so this answers once it has settled.
ipcMain.handle('agent-inbox:link-files-available', async (event, ...args) => {
  if (args.length !== 0) return false
  await installBinding?.settled()
  return linkSender(event) && linkFilesPermitted(event)
})

// The renderer names a rule and a handler, never an app: an app comes only from
// this native picker, limited to .app bundles, and is checked again before it
// is saved (link-preferences.cjs).
let linkSettings = null
const linkSettingsFor = () => (linkSettings ??= createLinkSettings({
  preferences: linkPrefs(),
  platform: process.platform,
  chooseApp: async () => {
    const options = {
      title: 'Choose an app', buttonLabel: 'Choose', defaultPath: '/Applications',
      properties: ['openFile'], filters: [{ name: 'Applications', extensions: ['app'] }],
    }
    const result = linkWindow && !linkWindow.isDestroyed()
      ? await dialog.showOpenDialog(linkWindow, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : result.filePaths
  },
}))

// Like local files, these rules are only for the viewer this app started and
// owns: any other page gets an empty view saying so, and changes nothing.
function handleLinkSettings(channel, arity, call) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (args.length !== arity) return { available: false, rules: [] }
    await installBinding?.settled()
    if (!linkSender(event)) return { available: false, rules: [] }
    if (!linkFilesPermitted(event)) return { available: false, rules: [], error: 'unowned' }
    return call(linkSettingsFor(), ...args)
  })
}
handleLinkSettings('agent-inbox:link-settings', 0, (settings) => settings.view())
handleLinkSettings('agent-inbox:link-settings-set', 2, (settings, ruleId, handler) => settings.setHandler(ruleId, handler))
handleLinkSettings('agent-inbox:link-settings-choose-app', 1, (settings, ruleId) => settings.chooseApp(ruleId))
handleLinkSettings('agent-inbox:link-settings-add-type', 1, (settings, extension) => settings.addType(extension))
handleLinkSettings('agent-inbox:link-settings-remove-type', 1, (settings, ruleId) => settings.removeType(ruleId))

ipcMain.handle('agent-inbox:set-theme-preference', (event, preference) => {
  const senderUrl = event.senderFrame?.url ?? ''
  if (!THEME_SOURCE_VALUES.has(preference) ||
      event.sender.id !== themeWindowWebContentsId ||
      !isTrustedThemeSender(senderUrl)) {
    return false
  }
  nativeTheme.themeSource = preference
  syncThemeChrome()
  if (themeWindow && !themeWindow.isDestroyed()) themeWindow.show()
  return true
})

// One attention predicate for the whole product (spec §7 / tenet 3): the dock
// badge imports the very module the viewer renders from. ESM from CJS →
// dynamic import, started once and awaited per poll.
const ATTENTION_PATH = path.join(REPO_ROOT, 'public', 'attention.js')
const BADGE_PATH = path.join(REPO_ROOT, 'public', 'badge.js')
const CARD_PATH = path.join(REPO_ROOT, 'public', 'card.js')

for (const p of [ATTENTION_PATH, BADGE_PATH, CARD_PATH]) {
  if (!existsSync(p)) {
    console.error(`[agent-inbox] FATAL: missing ${p}. The packaged app must stage public/ next to electron/ (scripts/package-app.sh) — dock badge will be disabled.`)
  }
}

let attentionModsFailed = false
const attentionMods = Promise.all([
  import(pathToFileURL(ATTENTION_PATH).href),
  import(pathToFileURL(BADGE_PATH).href),
  import(pathToFileURL(CARD_PATH).href),
]).then(([attention, badge, card]) => ({ ...attention, ...badge, ...card }))

attentionMods.catch((err) => {
  attentionModsFailed = true
  // LOUD, once: never let the badge stop updating in silence.
  console.error('[agent-inbox] FATAL: could not load attention UI modules — dock badge disabled', err)
  if (typeof app.setBadgeCount === 'function') app.setBadgeCount(0)
})

/** Gap between the two reuse probes — long enough for a dying viewer to vanish. */
const REUSE_CONFIRM_DELAY_MS = 500

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The viewer child process, ONLY if this app spawned it. Never set for a pre-existing server. */
let spawnedViewer = null

// The viewer child this app started (dev fallback) and stops in will-quit. The
// update helper waits for it as well, so the relaunched app never finds the old
// viewer still answering on the port. Null for an in-process or reused viewer.
function spawnedViewerPid() {
  return spawnedViewer &&
    spawnedViewer.exitCode === null &&
    spawnedViewer.signalCode === null &&
    Number.isSafeInteger(spawnedViewer.pid)
    ? spawnedViewer.pid
    : null
}

// The only quit path for an update: the committed helper is waiting for this
// process (and its viewer) to exit before it relaunches the app (on macOS it
// swaps the bundle first; an AppImage was already replaced by the commit).
// Like every quit path, it stops Setup first (#205).
function requestUpdateRestart() {
  updateRestartRequested = true
  beginAppQuit()
  app.quit()
}

// Settings' Restart Agent Inbox (#216, macOS only): a quit like any other, so
// Setup stops first (#205) and an uncommitted install would be cancelled, then
// the fresh app binds its new window and reuses the verified download.
function restartToInstallUpdate() {
  beginAppQuit()
  app.relaunch()
  app.quit()
}

function themeBackgroundColor() {
  return nativeTheme.shouldUseDarkColors ? THEME_BACKGROUND_COLORS.dark : THEME_BACKGROUND_COLORS.light
}

function syncThemeChrome(win = themeWindow) {
  if (!win || win.isDestroyed()) return
  win.setBackgroundColor(themeBackgroundColor())
}

function probeResponse(accept) {
  return new Promise((resolve) => {
    const req = http.get(URL_BASE, { timeout: 1000 }, (res) => {
      res.resume()
      resolve(accept(res))
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

/** Resolves true when anything occupies the canonical viewer port. */
function probeAny() {
  return probeResponse(() => true)
}

/** Resolves true only for a viewer that attests the hardened local boundary. */
function probe() {
  return probeResponse((res) => res.headers[BOUNDARY_HEADER] === BOUNDARY_VERSION)
}

/** Poll the viewer URL until it responds, or fail after ~timeoutMs. */
async function waitForServer(timeoutMs = 10_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe()) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return false
}

async function probeOwnership() {
  try {
    const response = await fetch(`${URL_BASE}api/owner`, { signal: AbortSignal.timeout(1000) })
    if (!response.ok) return false
    if (response.headers.get(BOUNDARY_HEADER) !== BOUNDARY_VERSION) return false
    const body = await response.json()
    return body?.token === OWNER_TOKEN
  } catch {
    return false
  }
}

async function waitForOwnership(timeoutMs = 10_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probeOwnership()) return true
    await sleep(intervalMs)
  }
  return false
}

// The startup proof again, after the window loaded a new page (#216). The
// viewer serves OWNER_TOKEN to any local client, so a viewer child this app
// spawned must also still be running: only then is the listener that answers
// the one that has held the port since startup, and that served the page.
async function reproveOwnership() {
  if (spawnedViewer !== null && spawnedViewerPid() === null) return false
  return waitForOwnership()
}

/**
 * Run the viewer server inside this process (Electron's Node). Returns true on
 * success. Fails cleanly (returns false) when better-sqlite3 was compiled for a
 * different ABI — the dev case — so the caller can fall back to spawning.
 */
async function startInProcess(entry) {
  const previousOwnerToken = process.env.AGENT_INBOX_OWNER_TOKEN
  try {
    // viewer-server serves static files from ./public relative to cwd
    process.chdir(REPO_ROOT)
    process.env.AGENT_INBOX_OWNER_TOKEN = OWNER_TOKEN
    await import(pathToFileURL(entry).href)
    console.log(`[agent-inbox] viewer running in-process on ${URL_BASE}`)
    return true
  } catch (err) {
    console.error(`[agent-inbox] in-process viewer failed (${err.message}); falling back to spawning node`)
    return false
  } finally {
    if (previousOwnerToken === undefined) delete process.env.AGENT_INBOX_OWNER_TOKEN
    else process.env.AGENT_INBOX_OWNER_TOKEN = previousOwnerToken
  }
}

/** Spawn the built viewer server; returns the child. Assumes dist/viewer-server.js exists. */
function spawnViewer() {
  const entry = path.join(REPO_ROOT, 'dist', 'viewer-server.js')
  // Prefer the Node binary that launched npm (Node 24 under `fnm exec --using=24 npm run electron`).
  // Bare `node` from PATH may be Node 26+, which cannot load better-sqlite3 — see CLAUDE.md.
  const nodeBin = process.env.npm_node_execpath || 'node'
  // cwd must be the repo root: viewer-server serves static files from ./public.
  const child = spawn(nodeBin, [entry], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, AGENT_INBOX_OWNER_TOKEN: OWNER_TOKEN },
  })
  child.on('error', (err) => {
    console.error(`[agent-inbox] failed to spawn viewer (${nodeBin}): ${err.message}`)
  })
  return child
}

/**
 * Attention watch (issue #19): poll the viewer API, badge the dock with the size
 * of the §7 attention set, and fire ONE native notification per poll for newly
 * arrived entries only. Nothing notifies on launch: what already needs you is on
 * screen. Runs in the main process so the shared frontend stays browser-neutral.
 *
 * WHAT counts as attention is not decided here and is not described here — that
 * is public/attention.js's job, and this file must never restate its rule even
 * in a comment. A restatement is a second predicate by another name: nothing
 * executes it, so it rots in silence, and it did — the text here used to spell
 * out a board-row rule that issue #37 had already replaced. Read the predicate.
 * test/badge.test.ts enforces this against the whole file, prose included.
 */
function startAttentionWatch(win) {
  let known = null // ids seen on the previous poll; null until the first one
  let polling = false
  // Issue #287: the two projections are conditional. Each read sends the
  // validator its last answer carried, and an unchanged one comes back as a
  // bodyless 304 the reader answers from what it parsed then.
  const read = createConditionalReader()
  const poll = async () => {
    if (attentionModsFailed) return // already logged once — don't spam every 3s
    let mods
    try {
      mods = await attentionMods
    } catch {
      return // the .catch above owns the (loud) reporting
    }
    const { attentionEntries, laterEntries, focusHashFor, optionOrder } = mods
    try {
      // The lean projections (issues #156 and #287): the same shapes without the
      // closed history and the plan rows this watcher never reads, which would
      // otherwise be built, sent and parsed in this process every 3 seconds. An
      // older reused viewer ignores the parameter and sends the full payload,
      // which the shared module reads the same way, with or without a validator;
      // test/reply-watch.test.ts pins that every one of them yields one result.
      const g = await read(`${URL_BASE}api/items?scope=attention`)
      const boards = await read(`${URL_BASE}api/boards?scope=attention`)
      const activity = await (await fetch(`${URL_BASE}api/activity`)).json()
      // Projects the human closed (issue #32). FAIL OPEN, deliberately: an older
      // standalone viewer from a different checkout has no such route, and
      // confirmReuse() will happily attach this app to it. An unknown closed set
      // must mean "suppress nothing" (a truthful over-count) — never a dark badge.
      const closed = await fetch(`${URL_BASE}api/projects/closed`)
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => [])
      const items = g.needsYou.flatMap((gr) => gr.items)
      const { newTargets, reminders } = responseWatch.scan(g, boards, Date.now())
      const dueByKey = new Map([...newTargets, ...reminders].map((target) => [target.key, target]))
      const due = [...dueByKey.values()]
      if (wakeAdapter && due.length) {
        await runWakeAdapter(wakeAdapter, wakeAdapterPayload(due)).catch((err) => {
          console.error(`[agent-inbox] wake adapter failed: ${err.message}`)
        })
      }
      if (reminders.length && Notification.isSupported()) {
        const note = new Notification(formatResponseReminder(reminders))
        const hash = reminders.length === 1 ? focusHashFor(reminders[0].focusId) : null
        note.on('click', () => {
          if (win.isMinimized()) win.restore()
          win.show()
          win.focus()
          if (hash) win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch((err) => {
            console.error('[agent-inbox] deep link failed', err)
          })
        })
        notificationRetainer.show(note)
      }
      const liveSessions = new Set(activity.map((a) => a.session))
      // THE §7 attention set — the exact same call the viewer's badge, rail,
      // tab count and triage deck all read from (spec §7 / tenet 3). No inline
      // re-derivation, and no local copy of the rule: whatever the shared module
      // includes or drops, the dock follows for free, which is the only way the
      // dock and the title badge can be guaranteed to agree.
      // `attn` is the VISIBLE set (closed projects suppressed): it sizes the dock
      // badge and fills the notification body. It is computed on every tick, 304s
      // or not (#287): what the shared module decides can change with the clock
      // alone, and over the lean reads it costs microseconds.
      const attn = attentionEntries(items, boards, Date.now(), liveSessions, closed)
      if (typeof app.setBadgeCount === 'function') app.setBadgeCount(attn.length)
      const entries = attn.map(attentionNotification)
      // …but `known` is maintained from the UNSUPPRESSED set. If it tracked only
      // what is visible, closing a project would drop its items from `known` and
      // reopening would re-announce every one of them as new — an OS notification
      // for items the human closed days ago. Reopen is the advertised happy path,
      // so that would fire routinely. `known` tracks what EXISTS; the badge and
      // the notification body track what is VISIBLE. It also keeps the asks the
      // human pinned for later (#247), so bringing one back announces nothing.
      const everything = attentionEntries(items, boards, Date.now(), liveSessions)
      const fresh = freshAttentionNotifications(known, entries)
      known = knownNotificationIds(everything, laterEntries(items, boards, Date.now()))
      // Per-item notifications stay (owner's call) — informational only.
      if (fresh.length && Notification.isSupported()) {
        console.log(`[agent-inbox] notifying: ${fresh.length} new (${fresh[0].text})`)
        const actionable = fresh.length === 1 ? fresh[0] : null
        const canned = cannedResponseActions(actionable ? optionOrder(actionable.item.options) : [])
        const note = new Notification({
          title: fresh.length === 1 ? 'Agent Inbox — needs you' : `Agent Inbox — ${fresh.length} new need you`,
          body: fresh.slice(0, 3).map((f) => f.text).join('\n'),
          ...(canned.actions.length ? { actions: canned.actions } : {}),
        })
        const hash = fresh.length === 1 ? focusHashFor(fresh[0].itemId) : null
        note.on('action', async (details, legacyActionIndex) => {
          const answer = responseForNotificationAction(canned.responses, details, legacyActionIndex)
          if (!answer || !actionable) return
          try {
            await submitNotificationResponse(URL_BASE, actionable.target, answer)
          } catch (firstError) {
            let saved = false
            if (actionable.target.source === 'row') {
              try {
                // The default representation, read fresh and unconditionally
                // (#287): a refused answer is rare, and its retry is pinned to
                // the row revision the notification showed.
                const latestBoards = await (await fetch(`${URL_BASE}api/boards`)).json()
                const refreshed = refreshNotificationTarget(latestBoards, actionable.target)
                if (refreshed) {
                  await submitNotificationResponse(URL_BASE, refreshed, answer)
                  saved = true
                }
              } catch { /* surface the original choice below */ }
            }
            if (saved) return
            console.error(`[agent-inbox] could not save notification response: ${firstError.message}`)
            if (Notification.isSupported()) {
              const failed = new Notification({
                title: 'Agent Inbox — Response not applied',
                body: `“${answer}” was preserved here because the action changed. Open Agent Inbox to review it.`,
              })
              failed.on('click', () => {
                if (win.isMinimized()) win.restore()
                win.show()
                win.focus()
                if (hash) win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch((err) => {
                  console.error('[agent-inbox] deep link failed', err)
                })
              })
              notificationRetainer.show(failed)
            }
          }
        })
        note.on('click', () => {
          if (win.isMinimized()) win.restore()
          win.show()
          win.focus()
          // Clicking only opens the app — and, for a single item, lands on it.
          if (hash) win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch((err) => {
            console.error('[agent-inbox] deep link failed', err)
          })
        })
        notificationRetainer.show(note)
      }
    } catch { /* viewer briefly unreachable — retry next tick */ }
  }
  setInterval(() => {
    if (polling) return
    polling = true
    poll().finally(() => { polling = false })
  }, 3000)
}

function refreshUpdatesAfterLoad() {
  if (!updateController) return
  updateController.rendererReady().then(sendUpdateState).catch(() => {
    console.error('[agent-inbox] update preferences unavailable; automatic checks disabled')
    sendUpdateState(updateController.getState())
  })
}

function createWindow() {
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 850,
    title: 'Agent Inbox',
    backgroundColor: themeBackgroundColor(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'setup-preload.cjs'),
      additionalArguments: updateFeatureAvailable ? ['--agent-inbox-updates=1'] : [],
    },
  })
  themeWindow = win
  updateWindow = win
  linkWindow = win
  // Windows (#87): an MSI upgrade, repair or uninstall asks a running app to close
  // through Restart Manager; quit through the normal path then (windows-app.cjs).
  quitWhenRestartManagerAsks({ window: win, app, platform: process.platform })
  const webContentsId = win.webContents.id
  themeWindowWebContentsId = webContentsId
  syncThemeChrome(win)
  // Keep our title; the page's <title> would otherwise overwrite it.
  win.on('page-title-updated', (e) => e.preventDefault())

  // Any target=_blank / window.open goes to the system browser, never a new
  // Electron window, and only when it is http(s) (#300): agent text can carry
  // any scheme, and the OS would hand file:, custom or app schemes to whatever
  // claims them.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openWebLink(url, shell, { readRules: linkRules, ...linkOpening })
    return { action: 'deny' }
  })
  // In-window navigation away from the local viewer goes to the system browser
  // the same way; anything else is dropped.
  win.webContents.on('will-navigate', (e, url) => {
    if (isViewerUrl(url, URL_BASE)) return
    e.preventDefault()
    openWebLink(url, shell, { readRules: linkRules, ...linkOpening })
  })
  win.webContents.on('did-finish-load', async () => {
    if (!win.isDestroyed() && !win.isVisible()) {
      try {
        const preference = await win.webContents.executeJavaScript(
          'document.documentElement.dataset.themePreference'
        )
        nativeTheme.themeSource = THEME_SOURCE_VALUES.has(preference) ? preference : 'dark'
        syncThemeChrome(win)
      } catch (err) {
        console.error('[agent-inbox] could not synchronize native theme before showing the window', err)
        nativeTheme.themeSource = 'dark'
        syncThemeChrome(win)
      }
      if (!win.isDestroyed()) win.show()
    }
    refreshUpdatesAfterLoad()
  })
  win.on('closed', () => {
    if (themeWindow === win) themeWindow = null
    if (themeWindowWebContentsId === webContentsId) themeWindowWebContentsId = null
    if (updateWindow === win) updateWindow = null
    if (linkWindow === win) linkWindow = null
  })

  return win
}

nativeTheme.on('updated', () => syncThemeChrome())

function installApplicationMenu(win) {
  const updates = {
    label: 'Check for Updates…',
    enabled: updateFeatureAvailable,
    click() {
      openUpdatesWindow(win)
    },
  }
  const settings = {
    label: 'Settings…',
    accelerator: 'CommandOrControl+,',
    click() {
      if (!win.isDestroyed()) win.webContents.send('agent-inbox:toggle-settings')
    },
  }
  const standardMenus = [{ role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]
  const template = process.platform === 'darwin'
    ? [{
        label: app.name,
        submenu: [
          { role: 'about' },
          updates,
          { type: 'separator' },
          settings,
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      }, ...standardMenus]
    : [{
        label: 'File',
        submenu: [updates, { type: 'separator' }, settings, { type: 'separator' }, { role: 'quit' }],
      }, ...standardMenus]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function initializeUpdateController() {
  if (!updateFeatureAvailable) return null
  const preferences = createUpdatePreferences({ app })
  return createUpdateController({
    currentVersion: app.getVersion(),
    preferences,
    trustState: createUpdateTrustState({ app }),
    checker: ({ currentVersion, automaticChecks, recordVerifiedVersion }) => checkForUpdate({
      fetchImpl: fetch,
      registry: updateKeyRegistry,
      currentVersion,
      automaticChecks,
      recordVerifiedVersion,
      platform: process.platform,
      arch: process.arch,
      isPackaged: app.isPackaged,
      appImagePath: process.env.APPIMAGE,
      appDir: process.env.APPDIR,
      execPath: process.execPath,
      includeArtifact: true,
    }),
    downloader: createUpdateDownloader({
      directory: path.join(app.getPath('userData'), 'update-downloads'),
      fetchImpl: fetch,
    }),
    installers: updateInstallers(),
    // Read once at startup, so an install that did not take effect is reported.
    attemptStore: createInstallAttemptStore({ directory: path.join(app.getPath('userData'), 'update-install') }),
    isSetupRunning: () => installGate.running(),
    isQuitting: () => installGate.quitting(),
    isInstallPermitted: updateInstallPermitted,
    requestRestart: requestUpdateRestart,
    notifyInstallFailure: ({ message }) => {
      if (!Notification.isSupported()) return
      const note = new Notification({
        title: 'Agent Inbox update was not installed',
        body: message,
      })
      note.on('click', () => {
        if (updateWindow) openUpdatesWindow(updateWindow)
      })
      notificationRetainer.show(note)
    },
    notifier: ({ version, downloadable, installable }) => {
      if (!Notification.isSupported()) return
      const note = new Notification({
        title: 'Agent Inbox update available',
        body: installable
          ? `Version ${version} is available. Download and install it from Settings → Updates.`
          : downloadable
            ? `Version ${version} is available. Download and verify it from Settings → Updates.`
            : `Version ${version} is ready to review on GitHub Releases.`,
      })
      note.on('click', () => {
        if (updateWindow) openUpdatesWindow(updateWindow)
      })
      notificationRetainer.show(note)
    },
    emit: sendUpdateState,
  })
}

// In-app install only on macOS or from a Linux AppImage, and only for a viewer
// this app started and owns; every other host (a .deb install, a reused viewer)
// keeps the download-and-verify flow with a manual install.
function updateInstallers() {
  if (process.platform === 'linux') return appImageInstallers()
  if (process.platform !== 'darwin' || !viewerOwned) return {}
  try {
    return {
      'macos-dmg': createMacInstaller({
        bundlePath: bundlePathFromExecPath(process.execPath),
        expectedBundleId: 'io.github.shariqh.agent-inbox',
        teamId: 'VVR2DKR923',
        systemVersion: process.getSystemVersion(),
        pid: process.pid,
        viewerPid: spawnedViewerPid,
        uid: process.getuid(),
        platform: process.platform,
        isPackaged: app.isPackaged,
        workDirectory: path.join(app.getPath('userData'), 'update-install'),
      }),
    }
  } catch {
    console.error('[agent-inbox] update installer unavailable; updates stay download-only')
    return {}
  }
}

// The AppImage replaces its own file, then a host /bin/sh helper starts the new
// file once this process and its viewer have exited. Electron's own relaunch
// cannot do it: its relauncher runs from this AppImage's mount, which goes away
// with the app. Registered under the proof that selects the AppImage target, so
// a .deb started from inside another AppImage (which inherits APPIMAGE) has no
// installer whose startup report could take that AppImage's attempt record.
function appImageInstallers() {
  const fromAppImage = runsFromAppImage({ appImagePath: process.env.APPIMAGE, appDir: process.env.APPDIR, execPath: process.execPath })
  if (!viewerOwned || !app.isPackaged || !fromAppImage) return {}
  try {
    return {
      'appimage-self-replace': createAppImageInstaller({
        env: process.env,
        execPath: process.execPath,
        uid: process.getuid(),
        platform: process.platform,
        isPackaged: app.isPackaged,
        pid: process.pid,
        argv: process.argv.slice(1),
        viewerPid: spawnedViewerPid,
        spawnImpl: spawn,
      }),
    }
  } catch {
    console.error('[agent-inbox] update installer unavailable; updates stay download-only')
    return {}
  }
}

/**
 * Start OUR OWN viewer server: in-process (packaged app, better-sqlite3 built
 * for Electron's ABI) or, if that import fails, spawned under system Node (dev).
 * Returns true if a server was started, false if dist/viewer-server.js is missing.
 */
async function startOwnServer() {
  const entry = path.join(REPO_ROOT, 'dist', 'viewer-server.js')
  if (!existsSync(entry)) {
    console.error(
      `[agent-inbox] ${entry} not found — run \`npm run build\` first (Node 24: fnm exec --using=24 npm run build).`
    )
    return false
  }
  if (!(await startInProcess(entry))) {
    console.log(`[agent-inbox] spawning ${entry} under system node instead`)
    spawnedViewer = spawnViewer()
  }
  return true
}

app.whenReady().then(async () => {
  // Re-probe before committing to reuse, while distinguishing a dying viewer
  // from a persistent pre-hardening listener that must not be trusted.
  const reuseState = await classifyReuse(probeAny, probe, sleep, REUSE_CONFIRM_DELAY_MS)
  const reusing = reuseState === 'reuse'
  if (reusing) {
    console.log(`[agent-inbox] reusing existing viewer on ${URL_BASE}`)
  } else if (reuseState === 'incompatible') {
    console.error(
      `[agent-inbox] port ${PORT} is occupied by an incompatible or pre-hardening viewer. ` +
      'Stop that viewer and restart Agent Inbox.'
    )
    app.exit(1)
    return
  } else if (!(await startOwnServer())) {
    app.exit(1)
    return
  } else if (await waitForOwnership()) {
    viewerOwned = true
    // Issue #74: for a release build (setup-info.json carries runtimePayloads
    // for this host's architecture), one-click setup is only ever enabled
    // when the EXACT selected payload is present and digest-verified — never
    // when it is missing, mismatched, or for an unsupported architecture.
    // A dev/legacy checkout (no runtimePayloads at all — `reason ===
    // 'no-release-payloads'`) keeps today's behavior unchanged.
    runtimeSelection = selectRuntimePayload({ appRoot: REPO_ROOT })
    const isReleaseBuild = runtimeSelection.reason !== 'no-release-payloads'
    setupInstallEnabled = isReleaseBuild ? runtimeSelection.ok : true
  } else {
    console.error('[agent-inbox] started viewer did not prove ownership; refusing to load it')
    app.exit(1)
    return
  }

  if (!(await waitForServer())) {
    console.error(
      `[agent-inbox] viewer did not respond on ${URL_BASE} within 10s — ` +
        `check that \`node dist/viewer-server.js\` runs under Node 24 (better-sqlite3 fails on Node 26+).`
    )
    app.exit(1)
    return
  }

  updateController = initializeUpdateController()
  // Only US and British English locales ship (#292), and Electron seeds a new
  // profile's spellchecker from the app locale, so on Linux and Windows switch
  // a profile with none of the system's first language to the system's
  // languages, before the first page loads.
  try {
    syncSpellcheckLanguages({ platform: process.platform, app, session: session.defaultSession })
  } catch (err) {
    console.error(`[agent-inbox] could not set the spellchecker's languages: ${err.message}`)
  }
  const win = createWindow()
  installApplicationMenu(win)
  const setupWindowWebContentsId = win.webContents.id
  // Setup and update installs belong to this window while it shows the viewer
  // this app started and owns (#216): bound at its first navigation, revoked
  // by every later one, and bound again once that load commits to the viewer
  // and ownership is proven again.
  installBinding = createInstallBinding({
    viewerUrl: URL_BASE,
    setupAllowed: () => setupInstallEnabled,
    // Update installs need only the owned viewer, not agent Setup's runtime payload.
    updateAllowed: () => viewerOwned,
    // So do local file links (#300); web links need no grant.
    filesAllowed: () => viewerOwned,
    isQuitting: () => installGate.quitting(),
    proveOwnership: reproveOwnership,
    apply({ setup, update, files }) {
      setupInstallWebContentsId = setup ? setupWindowWebContentsId : null
      updateInstallWebContentsId = update ? setupWindowWebContentsId : null
      fileLinkWebContentsId = files ? setupWindowWebContentsId : null
      updateController?.refreshInstallPermission()
    },
  })
  win.webContents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) installBinding.navigationStarted(url)
  })
  win.webContents.on('did-navigate', (_event, url) => {
    installBinding.navigationCommitted(url).catch(() => {})
  })
  win.webContents.on('render-process-gone', () => installBinding.rendererGone())
  win.on('closed', () => installBinding.closed())
  try {
    await loadViewer(win, URL_BASE)
  } catch (err) {
    console.error('[agent-inbox] could not load viewer with a fresh HTTP cache', err)
    app.quit()
    return
  }
  startAttentionWatch(win)

  // Self-heal (issue #23): while reusing a viewer we don't own, watch it — if it
  // disappears, start our own server on the same port and reload the dead page.
  if (reusing) {
    watchUpstream(probe, async () => {
      console.log(`[agent-inbox] reused viewer vanished — starting our own server`)
      if ((await startOwnServer()) && (await waitForOwnership())) {
        try {
          await reloadViewer(win)
        } catch (err) {
          console.error('[agent-inbox] could not reload viewer with a fresh HTTP cache after failover', err)
        }
      }
    })
  }
})

// This is a utility window, so quit when it closes — including on macOS,
// deliberately deviating from the mac convention of staying alive with no windows.
app.on('window-all-closed', () => {
  app.quit()
})

// Every time a quit fires: refuse new installs, and cancel and wait for any
// install still running before letting the app exit (#205 review).
app.on('before-quit', (event) => {
  const running = beginAppQuit()
  if (running) {
    event.preventDefault()
    running.then(() => app.quit())
    return
  }
  // The committed update helper is waiting for this process to exit.
  if (updateRestartRequested) return
  // Quitting mid-install stops it first, so nothing staged or mounted is left behind.
  if (updateController?.isInstalling() && !quitAfterUpdateInstall) {
    event.preventDefault()
    updateController.cancelInstall().finally(() => {
      quitAfterUpdateInstall = true
      app.quit()
    })
  }
})

// Kill the viewer only if we spawned it; a pre-existing server is left untouched.
app.on('will-quit', () => {
  // Unsent drafts live in this profile's localStorage (#279), and Chromium may
  // still hold the last ones in memory. Every window has closed, and run its
  // pagehide save, before will-quit, so commit them to disk here.
  if (app.isReady()) session.defaultSession.flushStorageData()
  updateController?.dispose()
  if (spawnedViewer && spawnedViewer.exitCode === null) {
    spawnedViewer.kill()
  }
})
