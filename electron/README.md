# Electron shell

A desktop window around the existing viewer (`public/` + `dist/viewer-server.js`).
Two modes: a dev run from the repo, and a packaged self-contained `Agent Inbox.app`.

Packaged macOS and Linux apps expose signed release checks in
**Settings → Updates** and through **Check for Updates…** in the app menu. The checker
fetches and verifies the release manifest and signature against the key registry bundled
with the app before using release metadata. Automatic checks are explicit and off by
default. They make no telemetry requests and notify at most once per verified version.
For `macos-dmg` and `appimage-self-replace` targets, a user-initiated **Download update**
runs `update-download.cjs` in Electron main: it fetches only the manifest's canonical
release URL, follows at most five redirects to GitHub's release-asset hosts, streams into
a private `0700` staging directory under `userData/update-downloads`, enforces the signed
length as a hard cap, and renames the file into place only after its SHA-256 matches.
The renderer never sees the URL, digest or path. The downloader itself never mounts,
opens, replaces, or installs anything; `deb-notify` stays notify-only and the release
action opens the verified GitHub release page for a manual package update. Dev Electron
and browser viewers intentionally omit the feature.

Installing goes through the platform-neutral contract in `update-install.cjs`: a
`PlatformInstaller` answers `feasibility()` without side effects, `prepare()` stages and
fully verifies the new build without touching the running one, and the returned
`commit()` is the only step that changes the installation (`discard()` removes what was
staged). `update-controller.cjs` consults feasibility on every check, so an installation
that cannot install an offer gets a notify-only offer with the installer's plain reason.
A strategy with no registered installer stays download-only. On
**Install and restart** the controller re-checks the running version, the high-water mark
re-read from `update-trust-state.json`, agent Setup, any check in flight and feasibility,
then reopens the download through `downloader.openVerified()`, which re-hashes it through
the one read-only handle it hands to `prepare()`; installers hash the bytes they consume
from that handle again (`copyVerifiedSource`). Main accepts the argument-free
`agent-inbox:update-install` IPC only from the window bound at the first navigation of a
viewer this app started and proved it owns, refuses it while Setup runs (and Setup refuses
while an install runs), and quits through `requestRestart()` once `commit()` resolves.

On macOS, `update-install-macos.cjs` refuses a translocated, read-only, foreign-owned,
symlinked or unwritable bundle and a macOS below the signed minimum. `prepare()` copies
the handle into a private `0700` folder under `userData/update-install`, attaches that
copy read-only with `hdiutil` (`-nobrowse -noautoopen`, image checksums on, stdin closed),
requires exactly one real `Agent Inbox.app`, copies it with `ditto` into a `0700`
`.agent-inbox-update-*` folder beside the running app on the same volume, always detaches,
and then verifies the STAGED copy: `plutil` bundle identifier and version, `codesign
--verify --deep --strict` against a requirement built from the bundle id and Team ID
`VVR2DKR923`, and `spctl --assess --type execute`. Files Node writes carry no quarantine,
so that `spctl` call is the only Gatekeeper evaluation. `commit()` re-checks both bundle
identities and starts a constant `/bin/sh` helper, detached, with fixed argv and a
minimal environment. The helper waits until the app and any viewer process it started
have exited (giving up unchanged after about two minutes), renames the running app to
`Agent Inbox.app.previous` inside the stage folder, renames the staged app into place
(restoring the previous one if that fails) and reopens Agent Inbox. Startup cleanup
removes stage and work folders more than an hour old, by exact name, owner and without
following links, so the previous app stays restorable by hand for at least an hour.

A swap that fails after the app quit is reported, not repeated blindly. Just before
`commit()`, the controller writes `userData/update-install/last-attempt.json` (`{ schema:
1, from, to, at, platform, strategy }`, temp file + rename) through
`createInstallAttemptStore()`; an install it cannot record is not handed off, and a
rejected `commit()` removes the record. The helper's last argument is the store's
`last-attempt.result`, where it writes only its exit code (shared `INSTALL_HELPER_EXIT`:
0 installed, 64 bad arguments, 65 refused, 70/71 could not move the app aside/in, 75 timed
out) before every exit, and before it reopens the app. The first `rendererReady()` of an
instance that registered an installer takes both files before any cleanup; a record
without a result that is younger than 150 s may still be in flight and is left alone. If
the app is still older than the attempted release, every published state carries
`installNotice` with the cause, Settings shows it (with Open Releases when nothing is
offered), and one native notification fires; it stays on the next offer of that version.
An app now on that release, or one whose helper reported success, says nothing. Update
installs follow #205's quit contract: `beginAppQuit()` (called first by `before-quit` and
by the update restart) refuses new Setup and update installs and revokes both window
bindings, and a quit while the attempt record is written still stops the install.

A Linux AppImage registers `update-install-appimage.cjs` only for an owned viewer of a
packaged app with `APPIMAGE` set. Both the update check's target selection
(`runsFromAppImage()` in `update-fetch.cjs`) and the installer require proof that this
process runs from that image: `APPIMAGE` and `APPDIR` are canonical absolute paths and
the executable sits inside `APPDIR`, the image's mount. A `.deb` install that inherited
another AppImage's variables therefore keeps `deb-notify`. The installer records the
AppImage's device, inode, size and modification time when it is created and refuses
(`changed-since-launch`) once the file differs. It also refuses a symlink, a file owned
by another user, an unwritable file or folder, and a file without the ELF and `AI\x02`
type-2 magic, read through an `O_NOFOLLOW | O_NONBLOCK` handle bound to the inspected
inode. `prepare()` writes the handle with `copyVerifiedSource` into a hidden
`.<name>.update-<16 hex>` sibling (`O_EXCL | O_NOFOLLOW`, `0600`). It then seals the stage
through a read-only `O_NOFOLLOW` handle: same device as the AppImage, the signed size, the
type-2 magic in the staged bytes, `fchmod 0755` and fsync. `commit()` re-checks the
AppImage, its folder and the stage, and makes one atomic rename over the AppImage, which
is the commit point. The running app keeps its mount of the old inode. After the rename
`commit()` never rejects: it fsyncs the folder and starts a detached host `/bin/sh -c`
helper with constant text, argv `<app-pid> <viewer-pid|-> <polls> <target>`, `cwd '/'`
and `stdio: 'ignore'`, and resolves on its `spawn` event. The helper validates its
arguments (exit 64), polls `kill -0` every 0.2 s, gives up after about two minutes
(exit 75) and then execs the new AppImage. Its environment drops `APPDIR`, `APPIMAGE`,
`ARGV0`, `OWD`, `TARGET_APPIMAGE` and every path-list entry inside the old `APPDIR`.
Electron's own relaunch is never used: its relauncher runs from the old mount, which the
AppImage runtime tears down when the app exits. If the helper cannot start, the new file
is already installed, so the app only logs and the user opens it again. Startup cleanup
removes at most 16 stale stages per pass: exact name, owner uid, over an hour old, never
followed.

Checks also refuse to move backwards. After a manifest's signature, schema and expiry
verify, the app records that release version as a high-water mark in its own user-data
file, `update-trust-state.json` (`{ "schema": 1, "highestVerifiedVersion": "X.Y.Z" }`),
written under its own lock with the same temp-file + rename helper as
`update-preferences.json`; the mark only ever rises. `update-preferences.json` keeps its
1.2.x format because 1.2.x builds reset that file to defaults (automatic checks off) when
it carries a key they do not know. A later manifest below the mark is reported as stale
update information even when its signature and 180-day validity are intact: nothing is
offered or announced, the attention badge is untouched, and the next manual or
scheduled check tries again. An offer still requires a version newer than the running
app, so the effective floor is the higher of the mark and the running version, and an
app reinstalled at an older 1.3+ version is still offered the newest release at or above
the mark. The reader is tolerant of newer builds: a valid mark is enforced whatever else
the file holds, unknown fields survive a raise, and a file with a newer schema is
enforced but never overwritten. A missing or corrupt trust-state file counts as no mark
(the running version is the floor) and is replaced by the next verified check. If the
mark cannot be saved, the app keeps enforcing the last readable mark and the highest
version it verified during the current session instead of disabling updates, and the
next successful save records that session high. Builds before 1.3 neither read nor write
the mark, so a reinstalled 1.2.x build has no rollback protection until a 1.3+ build runs
again; the file survives that round trip. The mark cannot protect the first check after
install or after the user-data directory is reset, and it cannot reveal a newer release
that is withheld before this installation has verified it; the dual-signed key-rotation
transition tracked in issue #148 is not implemented yet.

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
Electron's bundled Node. `scripts/package-app.sh` stages the release thin app's inputs —
`dist/ + public/ + electron/ + release/` and the checked-in `package.json` +
`package-lock.json` pair — into `build/stage`, installs that lockfile's production graph
with `npm ci --omit=dev`, rebuilds better-sqlite3 against Electron's ABI with the
checkout's lockfile-pinned `electron-rebuild` (isolated — the repo's node_modules stays
built for Node 24), and packages with @electron/packager (`--no-asar`: the server chdirs
into the app dir and serves `./public` from the real filesystem). Packaging stops if the
stage is missing its manifest or lockfile, or if the staged or packaged dependency graph
differs from `package-lock.json` in any package version or integrity. Same launch rules as
dev: reuse a running 4319 viewer, else serve in-process; quitting frees the port only if
the app started the server.

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
