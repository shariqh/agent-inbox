# Native Linux release folders

Issue #86's first delivery layer produces native, architecture-matched release
inputs for `linux-x64` and `linux-arm64`. It does not yet create an installable
Linux package.

## Pinned compatibility contract

`release/linux-inputs.json` is the source of truth for both architectures. It
pins official Node 24 archive names, roots, URLs, SHA-256 values, Node ABI 137,
Electron 43.1.1 ABI 148, and the exact Packager/Rebuild versions used by this
layer. It also pins Clang 15.0.7 for native addon compilation. GCC 11 cannot
parse Electron 43's deprecation-plus-visibility attribute ordering in the V8
headers; the build verifies both compiler commands, the exact compiler version,
and the native target tuple before rebuilding.

The final native folders set the product floor:

- Linux kernel 4.18 or newer
- glibc 2.34 or newer
- libstdc++ `GLIBCXX_3.4.29` (`libstdc++.so.6.0.29`) or newer
- representative vendor floors: Ubuntu 22.04, Debian 12, and RHEL 9

Node 24's official `BUILDING.md` support table supplies the kernel baseline and
its portable binary requires glibc 2.28. Electron 43.1.1's executable requires
glibc 2.25. The two native `better_sqlite3.node` builds produced on the pinned
Ubuntu 22.04/Clang toolchain raise the complete folder to glibc 2.34 and
`GLIBCXX_3.4.29`; the representative distribution floors are the first
supported releases in each listed family that satisfy those requirements. The
native-folder gate recursively enumerates every plain regular ELF in the
complete application folder without following symlinks, then verifies each
file's architecture and maximum GLIBC/GLIBCXX requirements. Its persisted
report lists the gated paths in deterministic relative-path order, with no
builder-local paths. The Electron executable, both addon builds, and the
selected Node binary remain explicit required files and native process/addon
probes, so the measured complete-folder floor cannot rise silently.

## Build and verification

The read-only `Native Linux release folders` workflow runs both targets on
native GitHub-hosted runners:

- `linux-x64` on `ubuntu-22.04`
- `linux-arm64` on `ubuntu-22.04-arm`

Each job:

1. validates the exact Linux release profile;
2. downloads and SHA-verifies the official Node archive;
3. stages the portable runtime with its own Node/npm and runs the runtime
   manifest, Node ABI, `better-sqlite3`, and hook self-tests;
4. rebuilds `better-sqlite3` for the pinned Electron ABI;
5. creates a thin Electron application folder containing only the matching
   Linux runtime key;
6. verifies ELF architecture, libc symbol floors, Electron/Node versions and
   ABIs, both native addons, schema-2 Setup metadata, and exact-host payload
   selection;
7. archives and restores the runtime and app folder, repeats verification,
   launches the restored app under Xvfb, and exercises runtime install/prune.

The workflow uploads short-lived Actions artifacts for review. It has
read-only repository permissions, persists no checkout credentials, uses no
secrets, and does not publish GitHub Release assets.

## Retained limitations

This layer intentionally has no AppImage, DEB, RPM, Snap, Flatpak, desktop
launcher, icon integration, checksums file, release publication, or
clean-machine package acceptance. Those belong to later issue #86 delivery
units.
