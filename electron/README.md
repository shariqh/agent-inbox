# Electron shell

A desktop window around the existing viewer (`public/` + `dist/viewer-server.js`).
Two modes: a dev run from the repo, and a packaged self-contained `Agent Inbox.app`.

## Packaged app (self-contained)

```sh
npm run package:app
# → out/Agent Inbox-darwin-arm64/Agent Inbox.app  (drag to /Applications if you like)
```

The .app needs **no terminal and no system Node**: the viewer server runs inside
Electron's bundled Node. `scripts/package-app.sh` stages `dist/ + public/ + electron/`
into `build/stage`, installs production deps there, rebuilds better-sqlite3 against
Electron's ABI (isolated — the repo's node_modules stays built for Node 24), and packages
with @electron/packager (`--no-asar`: the server chdirs into the app dir and serves
`./public` from the real filesystem). Same launch rules as dev: reuse a running 4319
viewer, else serve in-process; quitting frees the port only if the app started the server.

## Dev run — prerequisites

- **Node 24** (the repo's better-sqlite3 binding is compiled for Node 24): `fnm use 24`,
  or prefix commands with `fnm exec --using=24 `.
- `npm install` (downloads the Electron binary as a devDependency).
- `npm run build` — the shell spawns the **built** viewer, `dist/viewer-server.js`.

## Run

```sh
fnm exec --using=24 npm run electron
```

## Port / server reuse

- The shell probes `http://127.0.0.1:4319` (or `AGENT_INBOX_PORT` if set). The
  viewer binds only to IPv4 loopback; `localhost` remains a browser alias.
- If a viewer is **already running** there (e.g. `npm run view`), it is reused and is
  **not** killed when the app quits, but only if it attests the hardened local boundary.
  A persistent pre-hardening viewer is refused with restart guidance rather than silently
  preserving LAN exposure. Reuse is confirmed with a **second probe** after a short delay
  — a viewer caught mid-shutdown can answer once and then vanish (issue #23), and a single
  probe would strand the app on a dead page. Once reusing, the shell keeps watching the
  upstream and **starts its own in-process server** if it disappears, reloading the window
  so it self-heals instead of sitting on the disconnected banner.
- Otherwise it tries to run the server **in-process** (works in the packaged app, where
  better-sqlite3 is built for Electron's ABI). In a dev run that import fails (repo
  modules are Node-24 ABI) and it falls back to spawning `node dist/viewer-server.js`,
  killing that child on quit. The spawn uses the Node that launched npm
  (`npm_node_execpath`), so run via `fnm exec --using=24 npm run electron`.
- If `dist/viewer-server.js` is missing you get a clear error telling you to
  `npm run build` first.

## Notes

- `electron/main.cjs` is CommonJS on purpose: the repo is TS ESM (`"type":"module"`),
  and a `.cjs` main process sidesteps Electron/ESM loader friction.
- External links (target=_blank or navigation away from the local viewer) open in the system browser.
- A notification for one new question exposes its canned responses as native macOS
  actions, with the recommended response first. Selecting one writes the reply without
  opening the window; the main-process request carries the canonical `127.0.0.1` Origin
  required by the viewer boundary, then the existing response watcher wakes the agent.
  Batched notifications remain open-only because one action list cannot identify multiple
  questions.
- The app quits when the window closes, including on macOS (utility-window behavior).
