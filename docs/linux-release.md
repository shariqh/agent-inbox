# Native Linux release folders

Issue #86's first delivery layer produces native, architecture-matched release
inputs for `linux-x64` and `linux-arm64`. It does not yet create an installable
Linux package.

## Pinned compatibility contract

`release/linux-inputs.json` is the source of truth for both architectures. It
pins official Node 24 archive names, roots, URLs, SHA-256 values, Node ABI 137,
Electron 43.1.1 ABI 148, and the exact Packager/Rebuild versions used by this
layer.

The bundled Node 24.19.0 binaries set the product floor:

- Linux kernel 4.18 or newer
- glibc 2.28 or newer
- libstdc++ `GLIBCXX_3.4.25` (`libstdc++.so.6.0.25`) or newer
- representative vendor floors: Ubuntu 20.04, Debian 10, and RHEL 8

These values come from Node 24's official `BUILDING.md` support table. Electron
43.1.1's official Linux binaries are built on Ubuntu 22.04 and advertise no
newer glibc symbol requirement than the Node runtime. The native-folder gate
inspects the final Electron executable, both `better_sqlite3.node` builds, and
the selected Node binary so a native addon built on a newer runner cannot
silently raise the published floor.

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
