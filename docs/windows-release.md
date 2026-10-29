# Windows x64 release foundation

Windows delivery is intentionally split into dependency-ordered layers. The foundation
builds a native, unsigned Electron folder on `windows-2022`, and a per-user MSI is built
from that folder ([below](#per-user-msi-87-pr-2b)). Both are CI evidence and workflow
artifacts, not a downloadable Windows release.

## Pinned inputs

`release/windows-inputs.json` pins the same Node **24.22.1** and Electron **43.8.4** as the
macOS and Linux profiles
([where the #135 hold ended](macos-release.md#node-24220-ends-the-135-compatibility-hold));
a test keeps the three profiles' Node and Electron pins identical. The official Windows
ZIP carries neither Node's C/C++ headers nor `node.lib`, so the profile also pins the same
release's `node-v24.22.1-headers.tar.gz` and `win-x64/node.lib` by official URL and
SHA-256 (all copied from that release's signed `SHASUMS256.txt`). Native staging verifies
both, lists and checks the headers tarball before extracting it, and adds them to the
extracted distribution (`include/node` and `Release/node.lib`), so `better-sqlite3` is
rebuilt against verified headers of exactly the shipped Node, as on macOS and Linux, never
against headers node-gyp would download. Neither file enters the runtime payload. The
packaged Electron zip must match the hash in the lockfile-pinned `electron` package's
`checksums.json` ([Electron zips](macos-release.md#electron-zips-363)). The Electron-ABI
`better-sqlite3` is compiled against Electron's own headers tarball and linked against its
own `win-x64/node.lib`, both pinned in `electronHeaders` and placed in a private nodedir
(`include/node` and `Release/node.lib`), never ones node-gyp would download
([Electron headers](macos-release.md#electron-headers-369)).

## What the native folder proves

- The official pinned Node 24 `win32-x64` ZIP is downloaded, hashed, inspected before
  extraction, staged with the Node-ABI dependency tree, and self-tested on Windows x64:
  the hook selftest, the allocation-driven SQLite cleanup check (#135), and the MCP
  server probe (initialize + tools/list) all run before the manifest is written.
- Both `node_modules` copies, the app's and the runtime's, are pruned before they are
  tested or manifested ([What node_modules ships](macos-release.md#what-node_modules-ships-291)),
  and the folder gate refuses either if it still carries anything the prune removes. That
  takes better-sqlite3's MSBuild `obj` and `.tlog` files and `test_extension.node` out of
  the runtime, the folder's deepest paths and an unsigned PE the installer spike counted.
- The folder keeps only Electron's `locales/en-US.pak`, the locale Chromium falls back to
  when no pak matches the user's language, and `locales/en-GB.pak`, which British and
  Commonwealth English users get; the folder gate refuses a folder that lacks either,
  reaches either through a linked `locales` folder, or ships any other
  ([What Electron locales ship](macos-release.md#what-electron-locales-ship-292)). Electron
  would seed a new profile with the English locale's spellchecker, so at startup the app
  sets the user's languages on a profile that has none in their first language.
- The input contract pins Windows `10.0.17763` as the minimum OS version for later
  package acceptance; this layer's native evidence itself runs on Windows Server 2022.
- The Electron app is packaged natively with a separate Electron-ABI
  `better-sqlite3` rebuild, compiled from the lockfile-pinned source: the stage installs
  with `npm ci --ignore-scripts` and `@electron/rebuild` runs with `buildFromSource`, so no
  cached or downloaded prebuild can stand in for it (#315). The workflow restores no
  npm cache (no setup-node `cache` input, and `package-manager-cache: false`), and it
  sets `npm_config_build_from_source=true` once in its top-level `env`, so every npm
  install in it, including the checkout's own whose copy scripts and tests load, is
  compiled as well, against headers and `node.lib` node-gyp downloads for the runner's
  Node and checks against that release's `SHASUMS256.txt`. The packaged
  Electron runs the same allocation-driven SQLite
  check in Node mode against its own addon and `dist/store.js`, and the packaged update
  verifier, trust boundary and key registry must match the source byte for byte. The
  folder never checks for or installs updates: Electron enables the updater only on
  macOS and Linux.
- Every `.exe`, `.dll`, and `.node` in the restored folder is a plain AMD64 PE32+
  image. Native process probes require Electron ABI 148 and Node ABI 137 to load their
  respective addons.
- Original and restored application tree digests must match exactly. The separately
  restored runtime is reverified against the original manifest digest, source commit,
  `win32-x64`/Node/ABI identity, and native-addon selftest; setup metadata is rechecked
  for builder-path leakage before upload. Because Windows selection refuses before it reads
  a payload, the verifier itself requires the metadata to name exactly `runtime/win32-x64`
  with the embedded `runtime-manifest.json` digest, verified as Setup verifies a payload on
  macOS and Linux, and the round trip requires each folder's embedded runtime to be the
  archived one.
- The restored app launches with system Node removed from `PATH`, serves the hardened
  loopback boundary, and its bundled runtime selftests, installs, and prunes under a
  disposable user profile.

The build publishes the staged runtime and the packaged folder by renaming each into
place just after these checks have run executables from inside it, and Windows refuses
to rename a folder while anything in it is still open: a child's handles that have not
closed yet, or Defender scanning what just ran. So on Windows each of those two renames,
when refused with `EPERM`, `EACCES` or `EBUSY`, is tried again after growing waits for
about nine seconds, re-running its checks first; any other error still fails at once
(#333). The runtime installer that Setup runs keeps its single attempt.

The folder and reports are short-lived CI artifacts only. They are unsigned and are not
added to release aggregation.

## Per-user MSI (#87, PR 2b)

`.github/workflows/windows-msi.yml` builds `Agent-Inbox-vX.Y.Z-windows-x64.msi` from the
folder this workflow verified (it calls it) and writes `SHA256SUMS-windows.txt` beside it,
in the `sha256sum -c` form the macOS release uses. It runs on `workflow_dispatch` and on
pull requests that change the MSI's own files. The [installer decision
record](superpowers/specs/2026-10-23-windows-installer-decision.md) explains why an MSI
and records what the runner showed.

- **Per user, one folder.** The package is `Scope="perUser"`: it installs without
  elevation to `%LOCALAPPDATA%\Programs\Agent Inbox` for every version, and a major
  upgrade replaces the app in place and refuses a downgrade. An MSI version holds only
  `major.minor.patch`, so the build refuses any other version. Two builds of one version
  (two pull requests' artifacts, say) have their own ProductCodes, so
  `AllowSameVersionUpgrades` makes the later one replace the installed one too, rather
  than install beside it as a second product sharing every component; among builds of
  one version, the one installed last wins.
- **Shortcut identity.** The Start-menu shortcut, `Programs\Agent Inbox.lnk`, carries the
  AppUserModelID `io.github.shariqh.agent-inbox` (the release inputs' `bundleId`) and the
  toast activator CLSID `{08973E92-A6EF-47B2-9E91-A876F4B8F210}`, and the MSI owns that
  CLSID's `LocalServer32` registration, which Windows uses to start the app from a
  notification. In a packaged Windows build, `electron/windows-app.cjs` sets the same two
  values at startup, so the first notification keeps the shortcut's identity rather than
  writing Electron's own. A development run (`electron .`) keeps Electron's identity: it
  is the bare `electron.exe`, and with the installed app's identity its first
  notification would write a shortcut to `electron.exe` and point the installed app's
  toast activator registration at it. The UpgradeCode
  `{086C4AF7-CD48-4050-A328-CA911E7F7423}`, the ID and the CLSID must never change once an
  MSI has shipped; `.github/windows-msi/installer.json`, `release/windows-inputs.json` and
  the app hold them, and a test keeps them equal.
- **Restart Manager.** When Restart Manager asks the running app to close, the app logs
  that and calls `app.quit()` instead of letting Electron end the process at once, and
  logs again when the quit reaches `will-quit`. The lifecycle asks through Restart Manager
  and requires both lines, in order, plus `RmShutdown` 0, every process gone and the port
  released. That proves the quit took the normal path: the window closed through
  Electron, which runs the page's `beforeunload` (staged sends, drafts), and the
  `will-quit` handlers ran, including the one that asks Chromium to flush storage. It
  proves no more: the run has no unsent drafts to lose, and Electron still ends the
  process at once when a `before-quit` listener holds the quit, as `main.cjs`'s does while
  Setup or an update install runs. Neither runs on Windows yet, and a change to `main.cjs`
  re-runs this workflow. A silent upgrade does not ask, though: on the runner, Windows
  Installer's Restart Manager found nothing to close, the old app kept running on its
  moved-aside files, and the next launch ran the new version. Closing the app before an
  upgrade is left to the Windows update slice (the decision record's §9).
- **Uninstall** removes the app folder, the shortcut, the toast activator registration
  and the installed-apps entry, and keeps `%USERPROFILE%\.agent-inbox`, which the MSI
  never installs, and the Chromium profile the app creates in `%APPDATA%\agent-inbox`.
- **Repair.** A repair by product code (`msiexec /fomus`) needs the original `.msi`; after
  the download is gone, a fresh copy of the same version's `.msi` repairs or reinstalls it.
- **Minimum Windows.** A launch condition refuses a Windows build older than the release
  inputs' `minimumWindowsVersion` (`10.0.17763`), read from the registry because Windows
  Installer reports Windows 10 and 11 as 6.3. It never blocks a repair or an uninstall.
- **Managed machines.** Windows Server, and machines whose administrators set Windows
  Installer's `DisableMSI` policy, refuse an unelevated per-user install of an unmanaged
  package (1625). Windows 10 and 11 allow it by default; the lifecycle records the server
  refusal and then measures under the client default, restoring the policy afterwards.

The tools are pinned in `.github/windows-msi/installer.json` and checked before anything
runs them:

- **WiX 7.0.0**, the nuget.org `wix` package, by exact URL, nuget.org's SHA-512 package
  hash, its SHA-256 and the source commit its version reports. Its binaries come under the
  WiX Toolset's Open Source Maintenance Fee EULA v1.1, which the project owner accepted on
  2026-10-23 (no fee applies: the project has no revenue). The build passes that acceptance
  only as WiX's documented `-acceptEula wix7` switch, on the two commands that need it,
  and records no per-user acceptance on the runner.
- **.NET 10.0.13** (`Microsoft.NETCore.App`, supported until 2028-11-14), the official
  `win-x64` runtime zip by URL and the SHA-512 Microsoft's release metadata publishes,
  plus its SHA-256. WiX 7 asks for .NET 8, whose support ends on 2026-11-10, so the
  package is extracted and run through this runtime's own `dotnet exec --fx-version
  10.0.13`: no SDK, NuGet feed, tool store or runner .NET is involved, and the host's
  trace must name the pinned runtime.

Before anything is uploaded, the build reads the package back and refuses any change to
its identity, and ICE validation must pass with warnings as errors. Only four ICEs are
waived. ICE38, ICE64 and ICE91 hold a per-user package to a per-machine or roaming
layout: WiX documents that `Files` in a per-user package trips them, and the lifecycle
proves the uninstall they guard. ICE61 flags an upgrade that also removes its own
version, which `AllowSameVersionUpgrades` does on purpose, and the lifecycle proves that
replacement. Then a fresh, disposable standard user installs the MSI, launches it from
its shortcut, closes it through its own window, triggers a notification (with the
shortcut and without it), asks the running app to close through Restart Manager,
upgrades it while it runs to the same commit rebuilt one patch version later, launches
that, repairs it with and without its source and uninstalls it. It then installs the MSI
again and a same-version rebuild over it (the base folder with one file removed and one
added), which must leave one product holding exactly the rebuild's files, and uninstalls
that. Every installed tree is compared byte for byte with its folder. `summary.mjs`
turns that evidence into the job summary and fails the job unless every requirement
held; only then are the MSI and its checksum uploaded, as one seven-day artifact.

Nothing is signed, published or released, and the update manifest gains no Windows
target: installed apps accept exactly its five targets, so Windows targets wait for
manifest v2 (#343).

## Setup remains unavailable

Schema-2 setup metadata embeds the exact `win32-x64` runtime so its packaging shape is
representative, but Electron still selects Setup keys from the POSIX-only allow-list.
Windows selection must return `unsupported-platform`, the Setup IPC must remain
unavailable, and the POSIX process adapter must refuse Win32 before spawn.

This boundary is deliberate. Native Windows Setup still requires separately reviewed
host registration, instruction-file transactions, kernel-backed locking, atomic
replacement and recovery, reparse/ADS/UNC handling, and process-tree cancellation. The
folder foundation does not claim those semantics.

## Next layers

1. Implement the fixed-purpose Windows Setup and host adapters against the MSI's stable
   layout.
2. Select an eligible protected Authenticode provider, sign and timestamp nested PE
   files and then the MSI, in that order, run clean Windows 11 acceptance, and add
   Windows to all-or-nothing release publication and, once installed apps accept it, to
   the update manifest (#343).

Windows arm64, Microsoft Store/MSIX, and auto-update remain out of scope.
