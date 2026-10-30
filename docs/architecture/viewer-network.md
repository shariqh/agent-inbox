---
paths:
  - "src/viewer-network.ts"
  - "src/viewer-server.ts"
  - "electron/reuse.cjs"
applyTo: "src/viewer-network.ts,src/viewer-server.ts,electron/reuse.cjs"
---

# Viewer network boundary

The loopback-only listener, Host/Origin checks and framing denial in `src/viewer-network.ts`.

Moved out of `CLAUDE.md` and `.github/copilot-instructions.md` by #379, nearly verbatim. Claude Code and Copilot CLI load this file automatically when they read or edit a file matching the `paths`/`applyTo` globs above (through the symlinks in `.claude/rules/` and `.github/instructions/`); anyone else should read it before changing those files.

## In brief

- **Local network boundary:** `src/viewer-network.ts` wraps the viewer/static app
  before routing, binds only `127.0.0.1`, validates exact loopback Host/Origin
  values, requires a trusted Origin for every mutation, denies framing, and emits
  the hardening marker Electron requires before reuse. `localhost` is an exact
  browser alias, not a wider bind. Keep it out of the MCP graph and do not add a
  host-widening environment variable.

## Invariants in detail

- **The local viewer boundary lives in `src/viewer-network.ts`, never in
  `createViewer()`.** It composes an outer Hono app before the viewer/static routes,
  binds one listener to `127.0.0.1`, validates exact loopback Host/Origin values and
  emits the marker Electron requires before reuse. Every accepted response also carries
  CSP `frame-ancestors 'none'` plus `X-Frame-Options: DENY`; otherwise a hostile page can
  frame the viewer and turn a click into a trusted same-origin mutation. Every unsafe
  request requires an exact trusted Origin; Fetch Metadata is an independent rejection
  signal. `localhost` is an allowed browser authority but does not widen the
  `127.0.0.1` socket, and a rebinding hostname retains its rejected Host/Origin. There is
  no `::1` listener or host-widening environment variable. Keep this module
  viewer-process-only: hosted auth is a separate entry, and no network code may enter the
  stdio MCP import graph.
