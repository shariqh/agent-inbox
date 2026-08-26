# Electron shell

A desktop window around the existing viewer (`public/` + `dist/viewer-server.js`).
Two modes: a dev run from the repo, and a packaged self-contained `Agent Inbox.app`.

Packaged macOS and Linux apps expose signed, notify-only release checks in
**Settings → Updates** and through **Check for Updates…** in the app menu. The checker
fetches and verifies the release manifest and signature against the key registry bundled
with the app before using release metadata. Automatic checks are explicit and off by
default. They make no telemetry requests and notify at most once per verified version.
This layer does not download, replace, or install an app; the release action opens the
verified GitHub release page for a manual package update. Dev Electron and browser
viewers intentionally omit the feature.

## Packaged app (self-contained)

```sh
npm run package:app
# → out/Agent Inbox-darwin-arm64/Agent Inbox.app  (drag to /Applications if you like)
```

Packaging first runs `npm run generate:icons -- --check` and consumes the
checked-in `electron/icon.icns`. Regenerate it, the 1024px PNG, and browser icon
assets from `assets/icon.svg` with `npm run generate:icons` (macOS with
`rsvg-convert` and `iconutil`). The single-color `assets/icon-mark.svg` is the
documented optical derivative used in the viewer chrome.

The .app needs **no terminal and no system Node**: the viewer server runs inside
Electron's bundled Node. `scripts/package-app.sh` stages `dist/ + public/ + electron/`
into `build/stage`, installs production deps there, rebuilds better-sqlite3 against
Electron's ABI (isolated — the repo's node_modules stays built for Node 24), and packages
with @electron/packager (`--no-asar`: the server chdirs into the app dir and serves
`./public` from the real filesystem). Same launch rules as dev: reuse a running 4319
viewer, else serve in-process; quitting frees the port only if the app started the server.

### Portable agent runtime staging

Release packages carry separate Node 24 payloads for MCP, hooks, and watchers. Stage each
architecture from a full Node distribution; the staging command uses that distribution's
own Node/npm, installs the locked production dependencies, runs the native-addon selftest,
and writes `runtime-manifest.json`:

```sh
npm run build
npm run stage:runtime -- \
  --node-root /path/to/node-v24-darwin-arm64 \
  --platform darwin --arch arm64 \
  --output build/runtime/darwin-arm64
npm run stage:runtime -- \
  --node-root /path/to/node-v24-darwin-x64 \
  --platform darwin --arch x64 \
  --output build/runtime/darwin-x64

AGENT_INBOX_RUNTIME_DARWIN_ARM64="$PWD/build/runtime/darwin-arm64" \
AGENT_INBOX_RUNTIME_DARWIN_X64="$PWD/build/runtime/darwin-x64" \
  npm run package:app
```

Portable mode requires both payloads and writes architecture-keyed release metadata with
no builder checkout or Node path. Electron selects only its exact
`process.platform`/`process.arch` key; there is no `uname` or Rosetta fallback. Setup
atomically copies the selected payload to
`~/.agent-inbox/runtime/<content-derived-runtime-id>/`, then registers that installed
Node and MCP entrypoint. Moving or deleting the app afterward does not break agents.

`electron/setup-core.cjs` is the dependency-free Setup control plane in Electron main.
The Darwin release adapter owns a frozen host identity derived directly from
`process.platform` and `process.arch`; the selected setup-info key and verified manifest
must match that exact identity before execution can start. Both verified release Setup and
the checkout/dev fallback then use the fixed-purpose `electron/setup-process.cjs` boundary.
That boundary constructs only exact `/bin/bash scripts/install-agents.sh` argv on macOS and
Linux, and fails closed before spawn on Windows or an unknown platform. It accepts no
caller-provided executable, argv, or shell string. This does not enable Linux or Windows
release Setup. The core does not load the Node-ABI agent runtime or model shell-internal
self-test, rollback, or pruning work.

The externally anchored integrity check is `electron/runtime-verify.cjs`, using the
manifest digest from the signed app's `setup-info.json`. It hashes the full payload at
selection and synchronously again immediately before process start, which currently blocks
Electron main. The installer's later check under the payload's own Node is self-attesting:
it catches corruption and argv/source mismatch before managed runtime or host mutation, but
cannot rule out substitution after the app-side check. The current verify-by-path then
execute-by-path window remains open until a later filesystem/process adapter can hand off a
stable snapshot or filesystem identity.

The payload's `scripts/setup-filesystem.cjs` adapter now owns runtime filesystem identity,
same-parent staging, publication, build-time replacement, and exact prune removal. The
shipping install path records plain-entry device/inode identity, rejects links and unusable
identity, rechecks before each path mutation, and verifies the final published name. This is
point-in-time detection, not a handle held across verification or execution, so it does not
close the window above. Immutable runtime install never replaces an existing name:
byte-identical content remains a no-op and any collision is refused. Build-time `--force`
replacement is a two-rename backup swap with a visibility gap; failed restoration or
post-commit cleanup retains and reports recovery data. Restore and recursive cleanup
re-identify the scratch and prior-tree backup first; an identity mismatch refuses the
mutation rather than restoring or deleting a substituted path. The adapter creates and
identifies the empty stage before producer code runs, and cleanup requires that same stage
identity or verified post-publication absence.

The payload CLI distinguishes a committed install failure with exit 3 (ordinary failure
remains 1; usage remains 2). Before treating that runtime as newly installed, the Darwin
shell requires a plain exact destination, a full payload verification, the expected
content-derived runtime ID, and the exact source-manifest digest. Only a path absent before
the attempt and passing every check enters the existing reference-gated rollback. A
substituted or unverifiable destination is retained and reported as unsafe/unknown; host
configuration is never changed and Setup still fails.

Win32 policy tests model fully-qualified drive/UNC paths, separator normalization,
case-independent filesystem identity, junction/link refusal, and sharing failures. They
also reject drive-relative, drive-less-rooted, device/extended-namespace, and alternate-data-
stream-like paths. Those injected tests do not prove NTFS behavior or enable Windows Setup.

`electron/runtime-targets.cjs`, re-exported to ESM builders by
`scripts/runtime-targets.mjs`, is the single target vocabulary and source of official Node
artifact/layout facts. Release setup-info callers declare their exact required key set;
the macOS release profile remains exactly `darwin-arm64` plus `darwin-x64`. Packaged Setup
accepts only the exact process-derived Darwin/Linux x64/arm64 key and routes it through the
fixed-purpose POSIX installer adapter. A verified Win32 payload still cannot advertise or
run Setup. Windows arm64 remains outside the target set.

The mutating shell sources the verified adjacent `scripts/setup-lock.sh` and owns
fd 9 itself for the full transaction. Darwin uses descriptor-mode
`/usr/bin/lockf` when present and otherwise same-domain `flock`; Linux source
setup uses `flock` only. The helper is hashed with the runtime payload, but
sourcing it by path after the final app-side verification remains inside the
existing verify-to-execute window. Graceful termination attempts transactional
rollback, while forced `SIGKILL` escalation can end without shell or
filesystem-adapter cleanup; Setup retains that cancellation behavior.

Layer 1 leaves the portable app unsigned. The signing layer must finalize the layout,
sign every nested runtime Mach-O, regenerate both manifests from those signed bytes,
write `setup-info.json`, sign only the outer app without `--deep`, then strictly verify
outer/nested signatures and both manifests. Nothing nested may change afterward.

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
