# Windows x64 release foundation

Windows delivery is intentionally split into dependency-ordered layers. The current
foundation builds a native, unsigned Electron folder on `windows-2022`; it is CI evidence
for later installer work, not a downloadable Windows release.

## What the native folder proves

- The official pinned Node 24 `win32-x64` ZIP is downloaded, hashed, inspected before
  extraction, staged with the Node-ABI dependency tree, and self-tested on Windows x64.
- The input contract pins Windows `10.0.17763` as the minimum OS version for later
  package acceptance; this layer's native evidence itself runs on Windows Server 2022.
- The Electron app is packaged natively with a separate Electron-ABI
  `better-sqlite3` rebuild.
- Every `.exe`, `.dll`, and `.node` in the restored folder is a plain AMD64 PE32+
  image. Native process probes require Electron ABI 148 and Node ABI 137 to load their
  respective addons.
- Original and restored application tree digests must match exactly. The separately
  restored runtime is reverified against the original manifest digest, source commit,
  `win32-x64`/Node/ABI identity, and native-addon selftest; setup metadata is rechecked
  for builder-path leakage before upload.
- The restored app launches with system Node removed from `PATH`, serves the hardened
  loopback boundary, and its bundled runtime selftests, installs, and prunes under a
  disposable user profile.

The folder and reports are short-lived CI artifacts only. They are unsigned and are not
added to release aggregation.

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

1. Choose a per-user installer whose executable/runtime root remains stable across
   upgrades, and prove unsigned deterministic packaging.
2. Implement the fixed-purpose Windows Setup and host adapters against that stable
   layout.
3. Select an eligible protected Authenticode provider, sign and timestamp nested PE
   files and the final installer in order, run clean Windows acceptance, and add Windows
   to all-or-nothing release publication.

Windows arm64, Microsoft Store/MSIX, and auto-update remain out of scope.
