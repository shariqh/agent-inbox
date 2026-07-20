// Electron main process for the agent-inbox viewer (GitHub issue #11).
//
// This file is CommonJS (.cjs) on purpose: the repo is "type":"module" (TS ESM),
// and keeping the Electron main process in CJS avoids ESM/Electron loader friction.
//
// Behavior:
//   1. If a viewer is already listening on http://localhost:<AGENT_INBOX_PORT|4319>,
//      reuse it (never start a second one, never kill it on quit).
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

const PORT = Number(process.env.AGENT_INBOX_PORT ?? 4319)
const URL_BASE = `http://localhost:${PORT}/`
const REPO_ROOT = path.resolve(__dirname, '..')

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
 * Attention watch (issue #19): poll the viewer API for the needs-input set —
 * unanswered questions + blocked board rows, the human's chosen trigger set —
 * badge the dock with the count, and fire ONE native notification per poll for
 * newly arrived items only. Nothing notifies on launch: what already needs you
 * is on screen. Runs in the main process so the shared frontend stays
 * browser-neutral.
 */
function startAttentionWatch(win) {
  let known = null // ids seen on the previous poll; null until the first one
  setInterval(async () => {
    try {
      const g = await (await fetch(`${URL_BASE}api/items`)).json()
      const boards = await (await fetch(`${URL_BASE}api/boards`)).json()
      const entries = [
        ...g.needsYou.flatMap((gr) => gr.items).filter((i) => !i.reply)
          .map((q) => ({ id: `q:${q.id}`, text: q.title })),
        ...boards.flatMap((b) => b.rows.filter((r) => r.status === 'blocked')
          .map((r) => ({ id: `r:${r.id}`, text: `🚧 ${b.title} · ${r.label}` }))),
      ]
      if (process.platform === 'darwin') app.dock.setBadge(entries.length ? String(entries.length) : '')
      const fresh = known === null ? [] : entries.filter((e) => !known.has(e.id))
      known = new Set(entries.map((e) => e.id))
      if (fresh.length && Notification.isSupported()) {
        console.log(`[agent-inbox] notifying: ${fresh.length} new (${fresh[0].text})`)
        const note = new Notification({
          title: fresh.length === 1 ? 'Agent Inbox — needs you' : `Agent Inbox — ${fresh.length} new need you`,
          body: fresh.slice(0, 3).map((f) => f.text).join('\n'),
        })
        note.on('click', () => {
          if (win.isMinimized()) win.restore()
          win.show()
          win.focus()
        })
        note.show()
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

app.whenReady().then(async () => {
  if (await probe()) {
    console.log(`[agent-inbox] reusing existing viewer on ${URL_BASE}`)
  } else {
    const entry = path.join(REPO_ROOT, 'dist', 'viewer-server.js')
    if (!existsSync(entry)) {
      console.error(
        `[agent-inbox] ${entry} not found — run \`npm run build\` first (Node 24: fnm exec --using=24 npm run build).`
      )
      app.exit(1)
      return
    }
    if (!(await startInProcess(entry))) {
      console.log(`[agent-inbox] spawning ${entry} under system node instead`)
      spawnedViewer = spawnViewer()
    }
  }

  if (!(await waitForServer())) {
    console.error(
      `[agent-inbox] viewer did not respond on ${URL_BASE} within 10s — ` +
        `check that \`node dist/viewer-server.js\` runs under Node 24 (better-sqlite3 fails on Node 26+).`
    )
    app.exit(1)
    return
  }

  startAttentionWatch(createWindow())
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
