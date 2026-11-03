# Design: start sessions from the release app when agents run from a checkout (#435)

**Date:** 2026-11-02
**Status:** Design only; nothing here is built. The questions for Shariq are in §6.
**Scope of this PR:** this document. No source, test or workflow changes.
**Related:** #412 and its design ([`2026-10-31-driven-sessions-design.md`](2026-10-31-driven-sessions-design.md))
§2, §7, §8, §9 and §10; `docs/architecture/driven-sessions.md`, `setup-and-installers.md`,
`packaging-and-release.md` and `updates.md`. Facts checked against `origin/main` at 2aba15c9 (v2.3.0)
and the installed v2.3.0 app (Appendix A).

---

## §0 — Summary

1. **The cause.** The release app runs the driver only from the installed copy of its own runtime.
   Setup installs that copy only while it registers a host, and it refuses to touch a checkout
   registration. So a user whose agents run from a checkout can never get the runtime from the app.
2. **Recommendation: run the driver from the app's own verified payload when this app's runtime is
   not installed** (Option 2, macOS only). The installed runtime stays first. An experiment shows
   that a driver started from the payload keeps running after the bundle is renamed aside and
   deleted, as the macOS update does (§2).
3. **Phasing.** PR 1 corrects the refusal text (about 10 lines). PR 2 adds the fallback (about
   40 production lines). Neither changes an installer, a host config or a prune. A runtime install
   for sessions only (Option 1, without a marker) waits until Linux launches are turned on, because
   an AppImage cannot run a detached driver from its own mount (§3.2).

## §1 — The problem, as the code has it

- `launchDriverRuntime()` in `electron/main.cjs` has two paths. A checkout build (`no-release-payloads`)
  runs `npm_node_execpath` with the checkout's `dist/driver-cli.js`. A release build calls
  `installedDriverRuntime()` (`electron/setup-runner.cjs`). That function re-verifies
  `<runtime root>/<runtime id>` against the signed digest with `DRIVER_REQUIRED_FILES`. If the copy
  is missing, it says "use Update agents in Settings → Setup first". Start and Resume both use it.
- `install-agents.sh` in runtime mode publishes the runtime first. It then checks each host
  registration and calls `rollback_transaction` on any registration it does not own ("refusing to
  replace or remove the … registration because it is checkout"). `rollback_runtime` then removes the
  runtime it just published, because nothing uses it. Nothing else publishes a runtime.
- Setup's Agents block offers Update agents only for hosts registered to a Setup runtime
  (`public/agents.js`; checkout and custom hosts are reported and never switched). So the advice in
  the refusal points at a button the user never sees.

## §2 — What the installed runtime protects, and what it does not

Design §2 and §7 put the driver on the installed runtime so that a detached driver survives an app
quit and an app update, with pins keeping it through both prunes. For a driver started from the
bundle instead:

- **Prunes.** No prune touches the app bundle. `locateRuntime()` (`src/driver-pin.ts`) classifies the
  payload as `checkout`: its folder is `runtime/darwin-arm64`, but its manifest names
  `agent-inbox-runtime-2.3.0-darwin-arm64-…`. So the driver writes no pin, and it does not need one.
- **The macOS update** (`updates.md`, part 2): the helper waits for the app and viewer pids, but not
  for detached drivers. It then renames the old app aside into a `.agent-inbox-update-*` stage folder
  and renames the new app in. The next app's `cleanup()` deletes the stage folder after an hour. Both
  steps unlink or rename paths, and neither writes into a file a driver has open.
- **The experiment** (Appendix A, row 6): the v2.3.0 payload was copied into a scratch folder, and
  its own `bin/node` imported `dist/driver.js` and `dist/store.js` and opened a hub. The folder was
  then renamed and deleted. Afterwards the process wrote and read SQLite, opened a second database
  and ran `/bin/ps`. A late `import()` failed with `ERR_MODULE_NOT_FOUND`. better-sqlite3 loads
  `bindings` and its addon on the first `new Database()` (`lib/database.js:48`). Without a hub
  opened before the swap, the probe failed with `Cannot find module 'bindings'`. The driver opens
  the hub at start, so its whole graph and its addon are in memory before any turn.
- **The limit.** A late load in a renamed bundle fails (ENOENT); it never loads another version.
  The exception is a bundle replaced in place at the same path, such as a manual Finder Replace. A
  late load there would read the new version's file. The driver graph has no dynamic `import()`
  today (`src/driver*.ts`, `acp-client.ts`, `launch-*.ts`), and PR 2 adds a test that keeps it so.
- **Resume after an update** runs the new app's driver, with its own spec version, as it does today.
- **The printed stop line** (`driver-cli.ts`, step 2 terminal only) names `process.execPath`. The app
  stops drivers through hub rows, so a renamed bundle breaks nothing there.

## §3 — Options

### 3.1 Option 1: install the runtime for sessions only

A seventh fixed Setup target, `publish-runtime`, runs exactly `/bin/bash <payload>/scripts/publish-
runtime.sh --apply` (a new payload script and a Setup-required file). It runs from the verified
payload, the way `prune-runtimes` does. Under the fd 9 setup lock it verifies its own payload and
runs `runtime-payload.mjs install`. The exit-3 rule is `install-agents.sh`'s: an unverifiable path is
kept. It then runs the installed `hook-cli.js selftest`. On a selftest failure it removes only a
runtime it newly published, through `runtime-payload.mjs prune`, which honours pins. It reads no host
config, writes no instruction file and prunes no other runtime. The UI is one button in Settings →
Agent sessions, shown in a release window that `available()` grants, while the switch is on and
`/api/version` says `runtimeInstalled: false`. It calls the existing `install('publish-runtime')`,
so `createInstallGate`, the #216 binding and the exclusion with update installs all apply unchanged.

- **Is the "sessions use this runtime" marker needed? No.** This app's Remove (`prune-runtimes.sh`)
  always keeps `CURRENT`, the runtime it runs from, and `readRuntimes()` lists that runtime as
  `current`, never as removable. A runtime-mode installer keeps its own runtime and the newest
  previous one. Pins keep any runtime a driver runs from. An idle session runtime is removed only by
  another version's prune or by Uninstall, and both are right to remove it. The next Start then
  offers to publish it again.
  A marker (say `<runtime root>/.sessions/<runtime id>`, `{v: 1, runtimeId}`, written by main while
  the switch is on) would add a fourth source of "uses" to `scanRuntimeReferences`,
  `findUnusedRuntimes` and `readRuntimes`. That rule is held to one answer by `test/runtime-uses.ts`.
  Main would have to delete the marker when the switch goes off or an update changes the runtime id.
  If the user deletes the app, nobody deletes it, so the runtime would be kept forever. Older
  installers' `prune_old_runtimes` would ignore it, as they already ignore pins. It costs more than
  it keeps.
- **Not `install-agents.sh --target none`.** That would run the transactional installer's host and
  instruction loops over an empty `TARGETS`. Under `set -u`, macOS `/bin/bash` 3.2 fails on
  `"${TARGETS[@]}"` with "unbound variable" (Appendix A, row 7). It would also run
  `prune_old_runtimes`, which removes runtimes the user did not ask about.
- **Security and integrity:** the same verified payload and digest as every Setup target, and no argv
  from the renderer. **Installer invariants:** none touched. It adds a new script that takes the lock,
  the exit-3 rule and pin-aware removal (#211, #214, #294). It reads no config (#337), and a runtime
  outside the root stays out of scope (#232). **Mixed versions:** older builds never run the script;
  the runtime it publishes is an ordinary runtime to them.
- **Size:** about 150 production lines (script 70, runner and process 25, main 10, UI 45).
  **Tests:** publishes into a scratch root; is idempotent; refuses a collision; leaves every host
  config and instruction file byte-identical; removes no other runtime; exits 75 on lock contention;
  a failed selftest removes only what it published; a signal leaves nothing or a verified runtime;
  the argv pin; the button's DOM rules; staging ships the script.

### 3.2 Option 2: run the driver from the app bundle's verified payload (recommended)

`launchDriverRuntime()` tries `installedDriverRuntime()` first. Only on `not-found`, and only on
darwin, it falls back to `bundledDriverRuntime()`. That re-verifies `runtimeSelection.path` against
the signed digest with `DRIVER_REQUIRED_FILES`, as the installed copy is verified today (about
0.25 s), and refuses a translocated bundle (`/AppTranslocation/`, the check
`update-install-macos.cjs` already makes). A copy that is installed but fails verification still
refuses, as now, and never falls back.

- **Security and integrity:** the same argv shape, `[<payload>/bin/node, <payload>/dist/driver-cli.js,
  'run', <id>, <hub>]`, verified against the same signed digest just before spawn. The payload sits
  in a code-signed bundle, which macOS App Management protects. `~/.agent-inbox/runtime` is only
  user-writable. `bin/node` is signed with the hardened runtime and the Team ID (`signPortableRuntime`).
  Setup already runs it from inside the bundle (`install-agents.sh` `SOURCE_NODE`, `prune-runtimes.sh`),
  so signing, notarization and Gatekeeper are already exercised. The bundle's quarantine was assessed
  at the app's first launch. The threat model in design §8 is unchanged.
- **Installer invariants:** untouched. No installer, lock, config or prune changes.
- **Mixed versions:** none. Every build's prunes ignore the bundle, and old apps keep their path.
- **Platforms:** macOS only. On Linux, an AppImage serves its payload from a FUSE mount that its own
  runtime tears down when the app exits. A detached driver would then fail on its next page-in, so
  Option 2 must never run there. A deb update replaces files one by one at the same paths, so a late
  load could mix versions. Linux launches are refused today (§10), and this keeps it that way.
- **Size:** about 40 production lines (runner 25, main 5, copy 10). **Tests:** the selection order
  (installed → installed; `not-found` → bundle; `changed` → refuse; translocated → refuse; bundle
  fails verification → refuse; non-darwin → no fallback). The swap test (§5). A graph pin that no
  driver module uses `import(`. A `locateRuntime` case for the payload layout (no pin, no refusal).

### 3.3 Option 3: an accurate message only

`installedDriverRuntime()`'s `not-found` copy would say that Setup installs this runtime only while
it registers Claude Code or Copilot CLI to this app, and never over a checkout or custom
registration. It would add that agents run from a checkout can start sessions from that checkout's
build (`npm run build`, then `npm run electron`). About 10 lines, with the
`test/setup-runner.test.ts` and `test/launch-electron.test.ts` expectations updated. It meets
#435's second acceptance bullet and leaves the feature unusable for the owner.

### 3.4 Option 4: publish on demand inside Start

Main could publish the runtime itself, after the native confirmation. That would couple the launch
controller to the install gate and add an install to a dialog that promises a session. It is
rejected in favour of Option 1's explicit button if a published runtime is ever needed.

## §4 — Recommendation and phasing

- **PR 1, now (Option 3).** Correct the refusal text for both Start and Resume. Name the checkout
  workaround, and drop the Update agents advice where Setup cannot act. Update `driven-sessions.md`.
- **PR 2 (Option 2).** Add the macOS bundle fallback, its tests and amendments to design §2 and §7:
  "installed runtime first; this app's verified payload when none is installed; never on Linux".
  After PR 2, the PR 1 text appears only when the bundle fallback refuses too. Closes #435.
- **Later, with Linux launches (Option 1 without a marker).** File it as an issue when #435 closes.
  It is the only option that suits an AppImage.

## §5 — The swap test (PR 2)

In `test/driver-run.test.ts`, against the existing fake `copilot`:
1. Copy the built `dist/`, `scripts/` and `node_modules/` into a `scratchDir()`.
2. Start `run` from that copy.
3. After the status line, rename the copy aside and delete it.
4. Complete one turn, one signed approval and Stop.
5. Assert a clean `stopped` end and no pin anywhere under the runtime root.

## §6 — Questions for Shariq

1. **Run sessions from the app bundle when this app's runtime is not installed (Option 2)?**
   *Recommended: yes.* It is macOS only and the installed runtime stays first. It changes no
   installer, and the swap experiment supports it.
2. **When the installed copy exists but fails verification, fall back to the bundle?**
   *Recommended: no.* A changed runtime is worth seeing, and the refusal already says to run
   Update agents.
3. **Always run app-started drivers from the bundle on macOS, and drop the installed path for them?**
   *Recommended: not now.* Installed first keeps the tested, pinned behaviour for Setup users. Revisit
   if the bundle path proves itself across a release or two.
4. **Ship PR 1 on its own first?** *Recommended: yes*, in the next patch release, whether or not PR 2
   is ready.
5. **Linux: build Option 1 without a marker when Linux launches are turned on?**
   *Recommended: yes*, tracked as a new issue. Never use a marker.

## Appendix A — Verification log

| # | Fact | Source | Checked |
|---|---|---|---|
| 1 | Release launches use only the installed runtime; the not-found copy asks for Update agents | `electron/main.cjs` `launchDriverRuntime`; `electron/setup-runner.cjs` `installedDriverRuntime` | 2026-11-02 |
| 2 | Runtime mode publishes first, refuses a non-owned registration, rolls the runtime back | `scripts/install-agents.sh` (publish, refusal, `rollback_runtime`) | 2026-11-02 |
| 3 | This app's prune keeps its own runtime; the inventory marks it `current` | `scripts/prune-runtimes.sh` `CURRENT`; `src/runtime-inventory.ts` `readRuntimes` | 2026-11-02 |
| 4 | The bundled payload pins nothing (`checkout`); its folder name differs from its runtime id | `src/driver-pin.ts` `locateRuntime`; v2.3.0 app `runtime/darwin-arm64/runtime-manifest.json` | 2026-11-02 |
| 5 | Payload `bin/node`: hardened runtime, Team ID VVR2DKR923; payload 138 MB | `codesign -dv`, `du` on a scratch copy | 2026-11-02 |
| 6 | After rename and deletion: SQLite, a second open and `ps` work; a late `import()` fails; `bindings` loads lazily | probe run with the payload's own Node in a scratch folder | 2026-11-02 |
| 7 | macOS `/bin/bash` 3.2 with `set -u` fails on an empty array expansion | `/bin/bash -c 'set -u; T=(); for t in "${T[@]}"; do :; done'` | 2026-11-02 |
| 8 | The update renames the app aside; `cleanup()` deletes the stage folder after an hour | `docs/architecture/updates.md` (macOS install, parts 4 and 5) | 2026-11-02 |
