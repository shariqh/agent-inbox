---
paths:
  - "scripts/package-app.sh"
  - "scripts/package-app-stage.mjs"
  - "scripts/prune-node-modules.mjs"
  - "scripts/prune-electron-locales.mjs"
  - "scripts/build-*.mjs"
  - "scripts/stage-*.mjs"
  - "scripts/app-dependencies.mjs"
  - "scripts/macos-*.mjs"
  - "scripts/*windows*.mjs"
  - "scripts/*linux*.mjs"
  - "scripts/assemble-macos-release.mjs"
  - "scripts/release-*.mjs"
  - "scripts/runtime-*.mjs"
  - "scripts/tree-*.mjs"
  - ".github/workflows/**"
  - ".github/windows-msi/**"
  - "electron/windows-app.cjs"
  - "electron/spellcheck-languages.cjs"
  - "release/**"
  - "scripts/notarize-macos.sh"
  - "scripts/import-apple-signing.sh"
  - "scripts/native-runtime-adapter.mjs"
applyTo: "scripts/package-app.sh,scripts/package-app-stage.mjs,scripts/prune-node-modules.mjs,scripts/prune-electron-locales.mjs,scripts/build-*.mjs,scripts/stage-*.mjs,scripts/app-dependencies.mjs,scripts/macos-*.mjs,scripts/*windows*.mjs,scripts/*linux*.mjs,scripts/assemble-macos-release.mjs,scripts/release-*.mjs,scripts/runtime-*.mjs,scripts/tree-*.mjs,.github/workflows/**,.github/windows-msi/**,electron/windows-app.cjs,electron/spellcheck-languages.cjs,release/**,scripts/notarize-macos.sh,scripts/import-apple-signing.sh,scripts/native-runtime-adapter.mjs"
---

# Packaging and release

Electron packaging (#11), the portable runtime and its pruning (#74, #291, #292), and the Windows MSI (#87).

Moved out of `CLAUDE.md` and `.github/copilot-instructions.md` by #379, nearly verbatim. Claude Code and Copilot CLI load this file automatically when they read or edit a file matching the `paths`/`applyTo` globs above (through the symlinks in `.claude/rules/` and `.github/instructions/`); anyone else should read it before changing those files.

## In brief

- **Windows MSI path (#87 PR 2b):** `.github/workflows/windows-msi.yml` builds the
  unsigned per-user MSI (`Agent-Inbox-vX.Y.Z-windows-x64.msi`, installed to
  `%LOCALAPPDATA%\Programs\Agent Inbox`) and `SHA256SUMS-windows.txt` from the
  verified Windows folder, proves it as a fresh standard user, and uploads both as
  a workflow artifact only when every requirement held: never a release asset, and
  no update-manifest target (#343). WiX 7.0.0 and the .NET 10.0.13 runtime it runs
  on (`dotnet exec --fx-version`, never the runner's .NET) are pinned by URL and
  digest in `.github/windows-msi/installer.json`. The owner accepted the WiX OSMF
  EULA on 2026-10-23; `-acceptEula wix7` on the WiX commands that need it is the
  only acceptance allowed. The UpgradeCode, AppUserModelID and toast activator
  CLSID are permanent and must stay equal across `installer.json`,
  `release/windows-inputs.json` and `electron/windows-app.cjs`, which sets the
  ID and CLSID at startup only in a packaged Windows build (never `electron .`)
  and on Windows quits through `app.quit()` when Restart Manager asks
  (`session-end` with `close-app`), logging again at `will-quit`, which the
  lifecycle requires because a held `before-quit` lets Electron end the process
  at once. A silent MSI upgrade never asks, so closing the app before an upgrade
  is still open (decision record §9). `AllowSameVersionUpgrades` makes a
  same-version rebuild replace the installed build (ICE61 waived). Windows
  Setup stays unavailable.

## History (shipped since v1)

These landed after v1 and still hold invariants; the release history itself is in `CHANGELOG.md`.

- **Electron packaging** *(#11)* — `electron/` wraps the `public/` viewer; `scripts/package-app.sh`
  stages `dist` + `public` + `electron` and rebuilds `better-sqlite3` for Electron's ABI.
  *(#139)* The development path stages through the release `copyRequiredTree()`, so it ships
  the checked-in `package.json` + `package-lock.json` pair. `npm ci --omit=dev
  --ignore-scripts` (with `--prefix "$STAGE"`) installs that graph, the checkout's
  lockfile-pinned `electron-rebuild` compiles the addon `--build-from-source` inside the
  stage (*#315:* the release thin-app builders do the same through
  `scripts/app-dependencies.mjs`, because prebuild-install unpacks a cached or downloaded
  prebuild, JavaScript included, without checking a digest), and
  `scripts/package-app-stage.mjs verify` refuses to package unless the stage and the
  packaged app hold exactly the lockfile's production versions and integrities. Never
  stage without the lockfile or install with
  `npm install` there: either re-resolves ranges. The script works on physical paths
  (`pwd -P`) and treats a missing staged manifest or an unconfirmed graph check as failure:
  a step that silently did nothing could otherwise let `npm ci` walk up and strip the
  checkout's devDependencies. *(#315)* Every workflow but `ci.yml` builds, signs or
  verifies a release, so none restores an npm cache (no setup-node `cache` input of any
  kind, and `package-manager-cache: false` on each setup-node step), and each sets
  `npm_config_build_from_source=true` once, in its top-level `env`, which no job or step
  may name again: nothing from the checkout's install ships, but scripts and tests load
  its addon in jobs that build the release or hold signing and notary secrets, and a
  workflow-wide value reaches every npm spelling (`npm --prefix . ci`, `clean-install`,
  `ic`). `test/release-pipeline.test.ts` pins all of it, `macos-package.yml` runs
  `test/app-dependencies.test.ts` under the release Node, and `ci.yml` keeps its
  prebuilds.
  *(#369)* The thin-app builders compile it only against the Electron headers tarball
  (and Windows `node.lib`) pinned by SHA-256 in each profile's `electronHeaders`, unpacked
  by `scripts/app-dependencies.mjs` into a private nodedir, with node-gyp's dist-url at an
  unresolvable host and header overrides in the environment refused; the validators tie
  the pin's URLs to `electron.version`, so every Electron bump moves it too.
- **Portable release runtime** *(#74 Layer 1)* — the app may additionally embed a Node 24
  payload staged outside the Electron dependency tree: `darwin-arm64` alone since #296,
  which builds the macOS app for Apple silicon only (`darwin-x64` too through 1.x-last).
  Each payload has a content-derived `runtime-manifest.json`; Electron selects only
  `process.platform`/`process.arch`, and Setup atomically installs it under
  `~/.agent-inbox/runtime/<runtime-id>/`. Packaged upgrades/uninstalls touch only exact
  manifest-owned registrations/hooks, share one kernel lock, and retain every runtime
  a host config still uses (the #294 rule: its id named anywhere, or a launcher path
  resolving into it). Release signing order
  is fixed: nested runtime Mach-O files, manifests, setup-info, outer app without
  `--deep`, then strict verification; nested bytes never change afterward.
  *(#291)* Every shipped `node_modules` copy, the app's and each runtime's, is pruned by
  `scripts/prune-node-modules.mjs` before anything tests, manifests or signs it:
  better-sqlite3 keeps only `package.json`, `lib/` and `build/Release/better_sqlite3.node`
  (what it and `bindings` load), and every package loses `*.d.ts`/`*.d.mts`/`*.d.cts`,
  source maps and markdown. A license, notice, copying, copyright, authors, contributors or
  patents file, or anything in a folder named like one, is never removed, and a package
  with no license file keeps its root markdown. The prune refuses, before removing anything, a better-sqlite3 whose entry
  points leave `lib/` or whose addon is missing. Staging prunes right after
  `node_modules` normalization, so the probes, hook selftest, SQLite check and MCP probe
  run on what ships; the thin-app builders (`pruneAppNodeModules`) prune after the
  Electron rebuild and before packaging; `package:app` prunes before its graph check,
  which stays exact because no package is removed. The Linux, Windows and macOS thin-app
  gates refuse an unpruned app or runtime (`assertPrunedNodeModules`), and
  `signPortableRuntime` signs exactly `RUNTIME_MACHO_FILES` (`bin/node` and the addon),
  refusing any other Mach-O before signing a byte.
  *(#378)* `scripts/tree-modes.mjs` refuses any group- or other-writable entry and any
  setuid, setgid or sticky bit, never following or judging a symlink: in
  `verifyLinuxThinApp` before anything else (so the DEB and AppImage verifiers check their
  extracted inner apps too, passing `extractedPackage: true`, the only context where
  `chrome-sandbox` may be exactly `04755`), and on macOS in the thin build, after assembly's
  `codesign --verify` and in the final DMG gate.
  *(#292)* The UI is English-only, so `scripts/prune-electron-locales.mjs` keeps only US
  and British English: `en.lproj` and `en_GB.lproj` (and `Base.lproj`, if Electron ever
  ships one) wherever a `.lproj` sits in a macOS bundle outside `Contents/Resources/app`
  (Electron Framework's 220 locale folders and the app's 55 empty ones), and only
  `locales/en-US.pak` and `en-GB.pak` on Linux and Windows, about 47 MB a package.
  macOS takes the app's language from the app's own `.lproj` folders and Chromium follows
  it (`OverrideLocaleWithCocoaLocale`); Linux and Windows map Commonwealth English to
  `en-GB` and fall back to `en-US` when no pak matches. Chromium's locale is also the
  default for the app's dates, so British and Commonwealth users keep `en-GB` and their
  date formats, while every other language gets `en-US`: Chromium's pak strings, AppKit's
  own strings and the two default-locale dates (the update check's "Last checked" and the
  asked-at tooltip) in US English. Each thin-app builder prunes once, right after
  `@electron/packager` and before anything checks, hashes or publishes the app; the prune
  refuses an app without either English locale before removing anything. The macOS thin
  build, the Linux and Windows folder gates (and so every DEB/AppImage build and
  verification), the macOS assembly before signing and
  the final DMG gate refuse an app that lacks one or ships another
  (`assertEnglishOnlyElectronLocales`). Every folder on the way to an English locale must
  be a real one: `lstat` follows a link anywhere but in a path's last part, so a linked
  `locales/` or `Resources` would vouch for whatever it points at while the walk, which
  never follows links, removes nothing there. `package:app` prunes the bundle before its
  ad-hoc seal. Electron's prebuilt framework seals no resources, so release signing
  creates its `_CodeSignature` after the prune. The provisional macOS DMG is launched in
  French and in British English and must give its renderers `--lang=en-US` and
  `--lang=en-GB`, with `scripts/launch-locale-probe.mjs` reading the page's dates over
  DevTools; the AppImage FUSE gates run in French (`en-US`) and the extraction gates in
  British English (`en-GB`). Electron seeds a new profile's spellchecker languages from
  Chromium's locale, so on Linux and Windows `electron/spellcheck-languages.cjs` points it
  at `app.getPreferredSystemLanguages()` at startup, before the first window, but only
  when none of the profile's languages shares a base language with the system's first
  one (exact code, else a later entry of the same language, else the base language; one
  per language, at most three, written only when it differs and never to none). Never
  widen that: Chromium seeds `en-GB` for New Zealand, Indian and other Commonwealth
  English users, has no dictionary for their variants, and maps bare `en` to the US
  dictionary. macOS keeps the system's own `NSSpellChecker`, which Chromium consults
  directly and Electron's `setSpellCheckerLanguages` cannot change.
- **Unsigned per-user Windows MSI** *(#87, PR 2b)* — `.github/workflows/windows-msi.yml` builds
  `Agent-Inbox-vX.Y.Z-windows-x64.msi` and `SHA256SUMS-windows.txt` from the verified folder
  workflow it calls, proves the MSI as a fresh standard user (`.github/windows-msi/`), and
  uploads both as one seven-day workflow artifact only when every requirement in
  `summary.mjs` held. It is never a release asset, and the update manifest gains no Windows
  target: installed apps accept exactly its five (#343). Four things are load-bearing.
  (1) **Pins, checked before anything runs:** WiX 7.0.0 by URL, nuget.org's SHA-512 package
  hash, SHA-256 and source commit, extracted rather than `dotnet tool install`ed (no SDK,
  feed or tool store), and run through `dotnet exec --fx-version` on a pinned .NET 10.0.13
  runtime zip, never the runner's .NET: WiX asks for .NET 8, whose support ends 2026-11-10.
  The host's trace must name the pinned runtime. (2) **The EULA:** the project owner
  accepted the WiX OSMF EULA v1.1 on 2026-10-23, and `-acceptEula wix7`, WiX's documented
  switch for CI, on `build` and `msi validate`, is the only acceptance anywhere;
  `test/windows-msi.test.ts` refuses any other form (`wix eula accept` writes a per-user
  file). (3) **Identity is permanent:** the UpgradeCode, the AppUserModelID (the release
  inputs' `bundleId`) and the toast activator CLSID live in `installer.json`,
  `release/windows-inputs.json` and `electron/windows-app.cjs`; a test keeps them equal and
  `build-msi.ps1` reads the package back and refuses any difference. Never change one once
  an MSI ships: a new UpgradeCode installs beside the old product, and a new ID or CLSID
  orphans the shortcut's notifications. (4) **Electron main, Windows only, two calls:**
  `setWindowsAppIdentity` at module load, before any window or notification (without it,
  Electron's first notification rewrites `Programs\Agent Inbox.lnk` to its default
  `electron.app.Agent Inbox`, or invents a CLSID when there is no shortcut), in a packaged
  build only: a development run (`electron .`) is the bare `electron.exe`, and with the
  installed app's identity its first notification would write a shortcut to `electron.exe`
  and repoint the installed app's `LocalServer32`. And
  `quitWhenRestartManagerAsks` on the window: a `session-end` whose reasons include
  `close-app`, Restart Manager's request to close an app holding files an installer needs,
  calls `app.quit()`. Electron 43 otherwise ends the process at once on `WM_ENDSESSION`
  unless a quit has begun, skipping `beforeunload` (staged sends, drafts) and `will-quit`'s
  storage flush; a shutdown or log-off keeps that immediate exit. A `before-quit` listener
  that prevents the quit (`main.cjs`'s, while Setup or an update install runs) leaves that
  immediate exit in place, with exit code 0, so the app logs a second line once the quit
  reaches `will-quit` and the lifecycle requires it; exiting cleanly proves nothing alone.
  `main.cjs` is in the MSI workflow's trigger paths for that reason. Do not claim an upgrade
  sends it: on the runner, a silent MSI upgrade's Restart Manager found nothing to close,
  the old app ran on and the next launch ran the new version, so closing the app before an
  upgrade belongs to the Windows update slice (decision record §9). The lifecycle closes
  the app through the window titled `Agent Inbox`, never `Process.CloseMainWindow`, which
  can pick an untitled Chromium window above it. The MSI installs per user to
  `%LOCALAPPDATA%\Programs\Agent Inbox`, one folder for every version; its uninstall keeps
  `~/.agent-inbox`; `AllowSameVersionUpgrades` makes a second build of one version (another
  pull request's artifact) replace the installed one rather than become a second product
  sharing every component, which the lifecycle proves with a rebuild that drops one file and
  adds another; ICE validation waives only ICE38, ICE64 and ICE91 (per-user `Files`) and
  ICE61 (that same-version upgrade); and a launch condition refuses Windows builds below the
  release inputs' 17763. Windows Setup stays unavailable. The installer spike (PR 2a) is
  retired; its MSI harness moved here.
