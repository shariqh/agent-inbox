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
  values, requires a trusted Origin for every mutation, denies framing, allows
  script only from this origin's files (#412), and emits
  the hardening marker Electron requires before reuse. `localhost` is an exact
  browser alias, not a wider bind. Keep it out of the MCP graph and do not add a
  host-widening environment variable.

## Invariants in detail

- **The local viewer boundary lives in `src/viewer-network.ts`, never in
  `createViewer()`.** It composes an outer Hono app before the viewer/static routes,
  binds one listener to `127.0.0.1`, validates exact loopback Host/Origin values and
  emits the marker Electron requires before reuse. Every accepted response also carries
  `X-Frame-Options: DENY` and the CSP `script-src 'self'; object-src 'none'; base-uri
  'none'; form-action 'none'; frame-ancestors 'none'`. Framing denial stops a hostile page
  from framing the viewer and turning a click into a trusted same-origin mutation.
  *(#412)* `script-src 'self'` stops an injected script (agent text that escaped `esc()`)
  from running in the owned viewer, where it could call privileged preload APIs: the page
  runs only `.js` files from its own origin, so no inline `<script>`, `on…=` attribute,
  `javascript:` URL, `eval`, `new Function`, string timer or `import()` of anything but a
  same-origin module path. `test/csp-source.test.ts` reads `public/` for those, because
  jsdom does not enforce CSP. `object-src`, `base-uri` and `form-action` are `'none'`
  because the frontend uses no plugin, `<base>` or form. Styles, images, fonts and
  `fetch` are deliberately left open (no `default-src`): generated markup carries inline
  `style=` attributes, which a `style-src` would block, and limiting them is not this
  policy's job. Electron's reuse and ownership probes compare only
  `x-agent-inbox-local-boundary: loopback-v1`, never the CSP, so an older app reuses a
  newer viewer and a newer app an older one; tighten the policy without bumping that
  marker. A reused viewer never gets a privileged grant, so the stronger policy always
  covers the owned viewer that does. Every unsafe
  request requires an exact trusted Origin; Fetch Metadata is an independent rejection
  signal. `localhost` is an allowed browser authority but does not widen the
  `127.0.0.1` socket, and a rebinding hostname retains its rejected Host/Origin. There is
  no `::1` listener or host-widening environment variable. Keep this module
  viewer-process-only: hosted auth is a separate entry, and no network code may enter the
  stdio MCP import graph.
