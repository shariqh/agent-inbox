// Electron main process for the agent-inbox viewer (GitHub issue #11).
//
// This file is CommonJS (.cjs) on purpose: the repo is "type":"module" (TS ESM),
// and keeping the Electron main process in CJS avoids ESM/Electron loader friction.
//
// Behavior:
//   1. If a viewer is already listening on http://localhost:<AGENT_INBOX_PORT|4319>,
//      reuse it (never start a second one, never kill it on quit). We re-probe
//      before committing (a dying viewer can answer one probe then vanish), and
//      once reusing we watch it and start our own server if it disappears (#23).
//   2. Otherwise run dist/viewer-server.js IN THIS PROCESS (Electron's bundled
//      Node) — this is what makes the packaged .app self-contained. It requires
//      better-sqlite3 built for Electron's ABI (the package script does this).
//   3. Dev fallback: if the in-process import fails (repo node_modules are built
//      for system Node 24, not Electron), spawn `node dist/viewer-server.js` as
//      before and kill that child on quit — only because we own it.
//   4. Open a BrowserWindow on the viewer URL once the server responds.

const { app, BrowserWindow, Notification, shell } = require('electron')
const { spawn } = require('node:child_process')
const { existsSync } = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { confirmReuse, watchUpstream } = require('./reuse.cjs')
const {
  cannedResponseActions,
  createNotificationRetainer,
  createResponseWatch,
  formatResponseReminder,
  responseForNotificationAction,
  runWakeAdapter,
  submitCannedResponse,
  wakeAdapterFromEnv,
  wakeAdapterPayload,
} = require('./reply-watch.cjs')

const PORT = Number(process.env.AGENT_INBOX_PORT ?? 4319)
const URL_BASE = `http://localhost:${PORT}/`
const REPO_ROOT = path.resolve(__dirname, '..')
const responseWatch = createResponseWatch()
const notificationRetainer = createNotificationRetainer()
const wakeAdapter = wakeAdapterFromEnv(process.env)

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

/** One HTTP probe: resolves true if anything answers on the viewer port. */
function probe() {
  return new Promise((resolve) => {
    const req = http.get(URL_BASE, { timeout: 1000 }, (res) => {
      res.resume()
      resolve(true)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
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

/**
 * Run the viewer server inside this process (Electron's Node). Returns true on
 * success. Fails cleanly (returns false) when better-sqlite3 was compiled for a
 * different ABI — the dev case — so the caller can fall back to spawning.
 */
async function startInProcess(entry) {
  try {
    // viewer-server serves static files from ./public relative to cwd
    process.chdir(REPO_ROOT)
    await import(pathToFileURL(entry).href)
    console.log(`[agent-inbox] viewer running in-process on ${URL_BASE}`)
    return true
  } catch (err) {
    console.error(`[agent-inbox] in-process viewer failed (${err.message}); falling back to spawning node`)
    return false
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
    env: process.env,
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
  setInterval(async () => {
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
        ? { id: `q:${e.item.id}`, itemId: e.item.id, text: e.item.title, item: e.item }
        : { id: `r:${e.row.id}`, itemId: e.board.id, text: `🚧 ${e.board.title} · ${e.row.label}`, item: null }
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
        const question = fresh.length === 1 ? fresh[0].item : null
        const canned = cannedResponseActions(question ? optionOrder(question.options) : [])
        const note = new Notification({
          title: fresh.length === 1 ? 'Agent Inbox — needs you' : `Agent Inbox — ${fresh.length} new need you`,
          body: fresh.slice(0, 3).map((f) => f.text).join('\n'),
          ...(canned.actions.length ? { actions: canned.actions } : {}),
        })
        const hash = fresh.length === 1 ? focusHashFor(fresh[0].itemId) : null
        note.on('action', (details, legacyActionIndex) => {
          const answer = responseForNotificationAction(canned.responses, details, legacyActionIndex)
          if (!answer || !question) return
          submitCannedResponse(URL_BASE, question.id, answer).catch((err) => {
            console.error(`[agent-inbox] could not save notification response: ${err.message}`)
          })
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
  }, 3000)
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 850,
    title: 'Agent Inbox',
  })
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

  win.loadURL(URL_BASE)
  return win
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
  // Re-probe before committing to reuse: a DYING standalone viewer can answer a
  // single probe and then vanish, stranding the app on a dead page (issue #23).
  const reusing = await confirmReuse(probe, sleep, REUSE_CONFIRM_DELAY_MS)
  if (reusing) {
    console.log(`[agent-inbox] reusing existing viewer on ${URL_BASE}`)
  } else if (!(await startOwnServer())) {
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

  const win = createWindow()
  startAttentionWatch(win)

  // Self-heal (issue #23): while reusing a viewer we don't own, watch it — if it
  // disappears, start our own server on the same port and reload the dead page.
  if (reusing) {
    watchUpstream(probe, async () => {
      console.log(`[agent-inbox] reused viewer vanished — starting our own server`)
      if ((await startOwnServer()) && (await waitForServer())) {
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

// Kill the viewer only if we spawned it; a pre-existing server is left untouched.
app.on('will-quit', () => {
  if (spawnedViewer && spawnedViewer.exitCode === null) {
    spawnedViewer.kill()
  }
})
