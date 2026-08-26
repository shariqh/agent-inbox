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

const { app, BrowserWindow, ipcMain, Menu, Notification, nativeTheme, shell } = require('electron')
const { spawn } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const { existsSync } = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { classifyReuse, watchUpstream } = require('./reuse.cjs')
const { canRunSetup, installerRepoRoot, runAgentInstall, runtimeKey, selectRuntimePayload } = require('./setup-runner.cjs')
const { MANUAL_RELEASES_URL, createUpdateController } = require('./update-controller.cjs')
const { checkForUpdate } = require('./update-fetch.cjs')
const { createUpdatePreferences } = require('./update-preferences.cjs')
const { loadUpdateRegistry } = require('./update-trust.cjs')
const {
  cannedResponseActions,
  createNotificationRetainer,
  createResponseWatch,
  formatResponseReminder,
  refreshNotificationTarget,
  responseForNotificationAction,
  runWakeAdapter,
  submitNotificationResponse,
  wakeAdapterFromEnv,
  wakeAdapterPayload,
} = require('./reply-watch.cjs')

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
let setupInstallRunning = false
let setupInstallEnabled = false
let setupInstallWebContentsId = null
let setupInstallPromise = null
let cancelSetupInstall = null
let quitAfterSetup = false
// Issue #74: which exact runtime payload (if any) this release build selected
// for this host, computed once ownership of the viewer is proven. Stays at
// its unresolved default for a dev/legacy checkout — installerRepoRoot alone
// still gates that path, exactly as before.
let runtimeSelection = { ok: false, reason: 'unresolved', key: runtimeKey(process.platform, process.arch) }
let themeWindow = null
let themeWindowWebContentsId = null
let updateWindow = null
let updateController = null

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

ipcMain.handle('agent-inbox:update-open-release', async (event, ...args) => {
  if (args.length !== 0 || !isTrustedUpdateSender(event.senderFrame?.url ?? '', event.sender)) return false
  const state = updateController?.getState()
  const verifiedUrl = state?.status === 'available'
    ? validateReleaseUrl(state.available?.releaseUrl, state.available?.version)
    : null
  const releaseUrl = verifiedUrl ?? MANUAL_RELEASES_URL
  await shell.openExternal(releaseUrl)
  return true
})

ipcMain.handle('agent-inbox:install-available', (event) =>
  setupInstallEnabled &&
  canRunSetup(event.senderFrame?.url ?? '', URL_BASE, event.sender.id, setupInstallWebContentsId))

ipcMain.handle('agent-inbox:install', async (event, target) => {
  const senderUrl = event.senderFrame?.url ?? ''
  if (!setupInstallEnabled ||
      !canRunSetup(senderUrl, URL_BASE, event.sender.id, setupInstallWebContentsId)) {
    return { ok: false, exitCode: null, output: 'One-click setup is unavailable for this viewer.', target, timedOut: false }
  }
  if (setupInstallRunning) {
    return { ok: false, exitCode: null, output: 'Agent setup is already running.', target, timedOut: false }
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
  setupInstallRunning = true
  // Release builds (issue #74) pass the exact, digest-verified runtime payload
  // through so the installer stages a portable runtime instead of assuming a
  // source checkout; dev/legacy builds pass none and keep today's invocation.
  const install = runAgentInstall({
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
    onCancel(cancel) { cancelSetupInstall = cancel },
  })
  setupInstallPromise = install
  try {
    return await install
  } finally {
    setupInstallRunning = false
    if (setupInstallPromise === install) setupInstallPromise = null
    cancelSetupInstall = null
  }
})

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
  const poll = async () => {
    if (attentionModsFailed) return // already logged once — don't spam every 3s
    let mods
    try {
      mods = await attentionMods
    } catch {
      return // the .catch above owns the (loud) reporting
    }
    const { attentionEntries, focusHashFor, optionOrder } = mods
    try {
      const g = await (await fetch(`${URL_BASE}api/items`)).json()
      const boards = await (await fetch(`${URL_BASE}api/boards`)).json()
      const activity = await (await fetch(`${URL_BASE}api/activity`)).json()
      // Projects the human closed (issue #32). FAIL OPEN, deliberately: an older
      // standalone viewer from a different checkout has no such route, and
      // confirmReuse() will happily attach this app to it. An unknown closed set
      // must mean "suppress nothing" (a truthful over-count) — never a dark badge.
      const closed = await fetch(`${URL_BASE}api/projects/closed`)
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => [])
      const items = [
        ...g.needsYou.flatMap((gr) => gr.items),
        ...g.notes.flatMap((gr) => gr.items),
        ...g.done,
      ]
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
      // badge and fills the notification body.
      const attn = attentionEntries(items, boards, Date.now(), liveSessions, closed)
      if (typeof app.setBadgeCount === 'function') app.setBadgeCount(attn.length)
      const idOf = (e) => e.kind === 'item'
        ? {
            id: `q:${e.item.id}`,
            itemId: e.item.id,
            text: e.item.title,
            item: e.item,
            target: { source: 'item', id: e.item.id },
          }
        : {
            id: `r:${e.row.id}:v${e.row.revision}`,
            itemId: e.board.id,
            text: `🚧 ${e.board.title} · ${e.row.label}`,
            item: e.row,
            target: {
              source: 'row',
              boardId: e.board.id,
              rowId: e.row.id,
              revision: e.row.revision,
              boardRevision: e.board.revision,
            },
          }
      const entries = attn.map(idOf)
      // …but `known` is maintained from the UNSUPPRESSED set. If it tracked only
      // what is visible, closing a project would drop its items from `known` and
      // reopening would re-announce every one of them as new — an OS notification
      // for items the human closed days ago. Reopen is the advertised happy path,
      // so that would fire routinely. `known` tracks what EXISTS; the badge and
      // the notification body track what is VISIBLE.
      const everything = attentionEntries(items, boards, Date.now(), liveSessions)
      const fresh = known === null ? [] : entries.filter((e) => !known.has(e.id))
      known = new Set(everything.map(idOf).map((e) => e.id))
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
  const webContentsId = win.webContents.id
  themeWindowWebContentsId = webContentsId
  syncThemeChrome(win)
  // Keep our title; the page's <title> would otherwise overwrite it.
  win.on('page-title-updated', (e) => e.preventDefault())

  // Any target=_blank / window.open goes to the system browser, never a new Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  // In-window navigation away from the local viewer also goes to the system browser.
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(URL_BASE)) {
      e.preventDefault()
      shell.openExternal(url)
    }
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
    checker: ({ currentVersion, automaticChecks }) => checkForUpdate({
      fetchImpl: fetch,
      registry: updateKeyRegistry,
      currentVersion,
      automaticChecks,
      platform: process.platform,
      arch: process.arch,
      isPackaged: app.isPackaged,
      appImagePath: process.env.APPIMAGE,
    }),
    notifier: ({ version }) => {
      if (!Notification.isSupported()) return
      const note = new Notification({
        title: 'Agent Inbox update available',
        body: `Version ${version} is ready to review on GitHub Releases.`,
      })
      note.on('click', () => {
        if (updateWindow) openUpdatesWindow(updateWindow)
      })
      notificationRetainer.show(note)
    },
    emit: sendUpdateState,
  })
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
  const win = createWindow()
  installApplicationMenu(win)
  const setupWindowWebContentsId = win.webContents.id
  const revokeSetup = () => {
    if (setupInstallWebContentsId === setupWindowWebContentsId) setupInstallWebContentsId = null
  }
  let firstMainNavigation = true
  win.webContents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
    if (!isMainFrame || isInPlace) return
    if (firstMainNavigation) {
      firstMainNavigation = false
      if (setupInstallEnabled && new URL(url).origin === new URL(URL_BASE).origin) {
        setupInstallWebContentsId = setupWindowWebContentsId
      }
      return
    }
    revokeSetup()
  })
  win.webContents.on('render-process-gone', revokeSetup)
  win.on('closed', revokeSetup)
  win.loadURL(URL_BASE)
  startAttentionWatch(win)

  // Self-heal (issue #23): while reusing a viewer we don't own, watch it — if it
  // disappears, start our own server on the same port and reload the dead page.
  if (reusing) {
    watchUpstream(probe, async () => {
      console.log(`[agent-inbox] reused viewer vanished — starting our own server`)
      if ((await startOwnServer()) && (await waitForOwnership())) {
        if (!win.isDestroyed()) win.webContents.reload()
      }
    })
  }
})

// This is a utility window, so quit when it closes — including on macOS,
// deliberately deviating from the mac convention of staying alive with no windows.
app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', (event) => {
  if (!setupInstallPromise || quitAfterSetup) return
  event.preventDefault()
  cancelSetupInstall?.()
  setupInstallPromise.finally(() => {
    quitAfterSetup = true
    app.quit()
  })
})

// Kill the viewer only if we spawned it; a pre-existing server is left untouched.
app.on('will-quit', () => {
  updateController?.dispose()
  if (spawnedViewer && spawnedViewer.exitCode === null) {
    spawnedViewer.kill()
  }
})
