# Native Linux release folders and AppImages

Issue #86's first delivery layer produces native, architecture-matched release
inputs for `linux-x64` and `linux-arm64`. The AppImage layers package both
verified folders as deterministic, architecture-matched images. DEB packages
and GitHub Release publication remain later units.

## Pinned compatibility contract

`release/linux-inputs.json` is the source of truth for both architectures. It
pins official Node 24 archive names, roots, URLs, SHA-256 values, Node ABI 137,
Electron 43.1.1 ABI 148, and the exact Packager/Rebuild versions used by this
layer. It also pins Clang 15.0.7 for native addon compilation. GCC 11 cannot
parse Electron 43's deprecation-plus-visibility attribute ordering in the V8
headers; the build verifies both compiler commands, the exact compiler version,
and the native target tuple before rebuilding.

`release/linux-appimage-x64.json` and `release/linux-appimage-arm64.json` are
separate exact package contracts. Each pins its architecture-matched
appimagetool 1.9.1 and AppImage type-2 runtime release `20251108` to immutable
tagged URLs, source commits, byte sizes, and SHA-256 values; pins the complete
Linux-input manifest and icon by SHA-256; and fixes zstd compression, the
AppDir layout, and desktop metadata. The x64 contract uses upstream `x86_64`
assets; the arm64 contract uses upstream `aarch64` assets while the product
artifact name remains `linux-arm64`. The build passes the verified runtime through
appimagetool's `--runtime-file`, so appimagetool never fetches its mutable
`continuous` runtime. The build verifies this contract before downloading or
executing appimagetool. Downloaded bytes remain untrusted until their
plain-file identity, exact size, and SHA-256 have passed; the tool additionally
requires executable mode before use.

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

## Build an AppImage

On a native Linux host using Node 24, first produce the verified thin folder for
that host architecture as described above. Final verification also requires
`/usr/bin/unsquashfs` 4.5; the Ubuntu 22.04 workflows install the exact
`squashfs-tools` package version `1:4.5-3build1`.

For x64, run:

```sh
npm run package:linux-appimage -- \
  --app "build/thin/linux-x64/Agent Inbox" \
  --inputs release/linux-inputs.json \
  --appimage-inputs release/linux-appimage-x64.json \
  --output-dir build/appimage
```

For arm64, run:

```sh
npm run package:linux-appimage:arm64 -- \
  --app "build/thin/linux-arm64/Agent Inbox" \
  --inputs release/linux-inputs.json \
  --output-dir build/appimage
```

The command derives the version and source timestamp from the exact checkout,
validates the input manifest and thin folder, SHA-verifies the pinned packaging
tool before execution, and emits:

- `Agent-Inbox-vX.Y.Z-linux-x86_64.AppImage`
- `Agent-Inbox-vX.Y.Z-linux-x86_64.AppImage.sha256`
- `Agent-Inbox-vX.Y.Z-linux-x86_64.AppImage.report.json`
- `Agent-Inbox-vX.Y.Z-linux-arm64.AppImage`
- `Agent-Inbox-vX.Y.Z-linux-arm64.AppImage.sha256`
- `Agent-Inbox-vX.Y.Z-linux-arm64.AppImage.report.json`

The final verifier checks the outer type-2 AppImage marker, executable mode,
architecture-matched ELF identity and libc floor; parses the runtime ELF section table,
normalizes only appimagetool's reserved 16-byte `.digest_md5` mutation, and
requires the resulting prefix SHA-256 to equal the exact pinned runtime;
the outer libc-symbol scan is bounded to that exact runtime prefix so compressed
SquashFS payload bytes cannot be misclassified as runtime requirements;
extracts the image without FUSE; requires the exact AppDir root; validates the
launcher, desktop version/name metadata, icon digest, and Chromium sandbox mode;
then reruns the complete thin-folder ELF, ABI, addon, runtime, Setup-selection,
source-commit, and single matching `linux-x64` or `linux-arm64` payload gates. The extracted inner
application tree and version must exactly match the already-verified source
folder; the sole permission transformation is the standard AppImage
`chrome-sandbox` mode from the Electron archive's exact `0755` to the packaged
setuid-root `4755`; the builder rejects privileged mode bits on every source
entry, and the final verifier requires the sandbox to be the sole privileged
entry. appimagetool runs from an empty isolated working directory and HOME, so
an ambient `.appimageignore` cannot alter the output. CI builds the AppImage
twice from the same inputs and requires byte-identical artifacts, checksums, and
reports. The builder normalizes every AppDir directory to `0755`, pins AppRun
and the outer artifact to `0755`, pins desktop/icon/checksum/report metadata to
`0644`, and the final verifier reads every stored directory mode plus the
AppRun, desktop, icon, and sole privileged sandbox modes directly from numeric
SquashFS metadata before extraction. It rejects every other privileged entry
and requires the extracted directory count to match that metadata. Content
extraction runs in a dedicated child process with a zero umask so extracted
file modes retain their stored values for exact inner-tree identity without
changing the verifier process's ambient umask. The package therefore does not
inherit the builder's umask.

The `Linux x64 AppImage` and `Linux arm64 AppImage` workflows run independently
on native `ubuntu-22.04` and `ubuntu-22.04-arm` runners. Each builds twice from
the same exact inputs and requires byte-identical images, checksum sidecars, and
reports. The arm64 workflow sets ambient `umask 077` before both builds to prove
that the package contract, rather than the runner's defaults, controls modes.

## Launch requirements and no-FUSE fallback

The tested baseline is native x64 and arm64 Ubuntu 22.04 with glibc 2.34 and the
desktop runtime libraries installed explicitly by the two AppImage workflows:
GTK 3, NSS, ALSA, ATK bridge, CUPS, DRM/GBM, X11
composition/damage/fix/randr/xss, xkbcommon, CA certificates, and an X server.
Normal AppImage mounting additionally requires FUSE. Both launch paths require
unprivileged user namespaces. The AppRun launcher passes
Chromium's `--disable-setuid-sandbox` because FUSE mounts do not honor setuid
and an unprivileged extract-and-run cannot preserve root ownership; this leaves
Chromium's user-namespace and seccomp sandboxes enabled and never adds
`--no-sandbox`.

Run normally:

```sh
./Agent-Inbox-vX.Y.Z-linux-x86_64.AppImage
# or, on arm64:
./Agent-Inbox-vX.Y.Z-linux-arm64.AppImage
```

When `/dev/fuse` is unavailable, use the AppImage runtime's supported
extract-and-run path:

```sh
APPIMAGE_TMPDIR="$(mktemp -d)"
chmod 0700 "$APPIMAGE_TMPDIR"
trap 'rm -rf -- "$APPIMAGE_TMPDIR"' EXIT
TMPDIR="$APPIMAGE_TMPDIR" APPIMAGE_EXTRACT_AND_RUN=1 \
  ./Agent-Inbox-vX.Y.Z-linux-x86_64.AppImage
# Use Agent-Inbox-vX.Y.Z-linux-arm64.AppImage on arm64.
```

This fallback extracts to a temporary directory for each launch. It is not a
desktop installation flow and does not install or remove host launchers,
icons, or user data. Keep the unique mode-`0700` `TMPDIR`: the pinned AppImage
runtime uses a predictable child name while extracting, so a shared `/tmp`
base would let another local user prepopulate files before launch.

Each architecture's CI acceptance gate runs both paths as an unprivileged user,
with the user-namespace sandbox and without `--no-sandbox`, in an
architecture-specific digest-pinned clean Ubuntu 22.04 container on a native
runner. Each container receives only the final artifact and the smoke harness,
has no repository checkout or system Node, isolates HOME, XDG
configuration/cache/data/state, the inbox database, and a private mode-`0700`
scratch tree, then requires the packaged in-process viewer to answer on
`127.0.0.1` with the hardened
`x-agent-inbox-local-boundary: loopback-v1` marker. The no-FUSE container has no
`/dev/fuse`; the normal container receives the FUSE device explicitly.
Because neither container has a `node` executable, that response cannot come
from Electron's development-only host-Node fallback.
Docker's outer AppArmor and seccomp profiles are disabled for both containers
because their default namespace restrictions do not model a desktop host; the
gate first proves the unprivileged user-namespace prerequisite with `unshare`,
then requires a live Chromium child to have entered a distinct user namespace
with `NoNewPrivs: 1` and seccomp filter mode 2. This `/proc` evidence proves
those kernel mechanisms are active for at least one Chromium child; it does not
instrument Chromium's internal sandbox policy or claim that every child uses
the same isolation layers.

## Retained limitations

This layer intentionally has no DEB, RPM, Snap, Flatpak, host-level desktop
install/uninstall flow, aggregated release checksum file, signing/attestation,
or GitHub Release publication. Those belong to later issue #86 delivery units.
The native x64 and arm64 evidence supports the documented
Ubuntu/Debian-class glibc baseline only; it is not a claim of universal Linux
compatibility. If a future hosted runner cannot expose FUSE or unprivileged user
namespaces, that architecture's gate must fail or state the missing evidence;
it must not turn the unsupported path into a success-shaped result.
