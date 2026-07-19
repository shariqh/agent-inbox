# Electron shell

A minimal desktop window around the existing viewer (`public/` + `dist/viewer-server.js`).
Dev-run only — no packaging, no installers.

## Prerequisites

- **Node 24** (better-sqlite3 does not load under Node 26+): `fnm use 24`, or prefix
  commands with `fnm exec --using=24 `.
- `npm install` (downloads the Electron binary as a devDependency).
- `npm run build` — the shell spawns the **built** viewer, `dist/viewer-server.js`.

## Run

```sh
fnm exec --using=24 npm run electron
```

## Port / server reuse

- The shell probes `http://localhost:4319` (or `AGENT_INBOX_PORT` if set).
- If a viewer is **already running** there (e.g. `npm run view`), it is reused and is
  **not** killed when the app quits.
- Otherwise the shell spawns `node dist/viewer-server.js` itself and kills that child on
  quit. It spawns with the Node binary that launched npm (`npm_node_execpath`), so run
  via `fnm exec --using=24 npm run electron` — a bare PATH `node` may be Node 26+.
- If `dist/viewer-server.js` is missing you get a clear error telling you to
  `npm run build` first.

## Notes

- `electron/main.cjs` is CommonJS on purpose: the repo is TS ESM (`"type":"module"`),
  and a `.cjs` main process sidesteps Electron/ESM loader friction.
- External links (target=_blank or navigation off localhost) open in the system browser.
- The app quits when the window closes, including on macOS (utility-window behavior).
