# Windows x64 release foundation

Windows delivery is intentionally split into dependency-ordered layers. The current
foundation builds a native, unsigned Electron folder on `windows-2022`; it is CI evidence
for later installer work, not a downloadable Windows release.

## Pinned inputs

`release/windows-inputs.json` pins the same Node **24.18.1** and Electron **43.8.0** as the
macOS and Linux profiles, including the
[Node 24.18.1 compatibility hold for #135](macos-release.md#node-24181-compatibility-hold-135);
a test keeps the three profiles' Node and Electron pins identical. The official Windows
ZIP carries neither Node's C/C++ headers nor `node.lib`, so the profile also pins the same
release's `node-v24.18.1-headers.tar.gz` and `win-x64/node.lib` by official URL and
SHA-256 (all copied from that release's signed `SHASUMS256.txt`). Native staging verifies
both, lists and checks the headers tarball before extracting it, and adds them to the
extracted distribution (`include/node` and `Release/node.lib`), so `better-sqlite3` is
rebuilt against verified headers of exactly the shipped Node, as on macOS and Linux, never
against headers node-gyp would download. Neither file enters the runtime payload.

## What the native folder proves

- The official pinned Node 24 `win32-x64` ZIP is downloaded, hashed, inspected before
  extraction, staged with the Node-ABI dependency tree, and self-tested on Windows x64:
  the hook selftest, the allocation-driven SQLite cleanup check (#135), and the MCP
  server probe (initialize + tools/list) all run before the manifest is written.
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

The folder and reports are short-lived CI artifacts only. They are unsigned and are not
added to release aggregation.

## Installer spike (#87, PR 2a)

`.github/workflows/windows-installer-spike.yml` is CI-only evidence for choosing the
installer. It reuses this folder workflow (now also callable), rebuilds the same commit
with only its version bumped one patch, and builds a per-user MSI (WiX) and a
Squirrel.Windows installer (electron-winstaller) from both folders. Then a fresh,
disposable standard user installs, launches, upgrades and uninstalls each one (and
repairs the MSI), and every installed tree is compared byte for byte with its verified
folder. Because Windows Server refuses unelevated per-user MSI installs by default, the
MSI lifecycle records that refusal and then sets the `DisableMSI=0` policy that Windows
10 and 11 use. The tools are pinned in `.github/windows-installer-spike/`: WiX by exact
version, nuget.org package hash and SHA-256, installed from a private feed;
electron-winstaller by lockfile integrity, installed without lifecycle scripts. The
installers are unsigned, uploaded only as seven-day CI artifacts, and never published;
the update manifest has no Windows target. The measurements, recommendation and open
decisions are in [the installer decision
record](superpowers/specs/2026-10-23-windows-installer-decision.md).

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

1. Build the per-user MSI the installer decision record recommends, with pinned WiX, the
   Start-menu shortcut and the AppUserModelID the app must match, still unsigned, so its
   install folder stays the same across upgrades.
2. Implement the fixed-purpose Windows Setup and host adapters against that stable
   layout.
3. Select an eligible protected Authenticode provider, sign and timestamp nested PE
   files and the final installer in order, run clean Windows acceptance, and add Windows
   to all-or-nothing release publication.

Windows arm64, Microsoft Store/MSIX, and auto-update remain out of scope.
