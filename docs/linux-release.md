# Native Linux release folders, AppImages, and DEBs

Issue #86's first delivery layer produces native, architecture-matched release
inputs for `linux-x64` and `linux-arm64`. The AppImage and DEB layers package
both verified folders as deterministic, architecture-matched artifacts. The
protected multi-platform release flow consumes those exact native artifacts,
combines them with the notarized universal macOS DMG, and publishes only after
the complete remote draft has been downloaded and rehashed.

## Pinned compatibility contract

`release/linux-inputs.json` is the source of truth for both architectures. It
pins official Node 24 archive names, roots, URLs, SHA-256 values, Node ABI 137,
Electron 43.1.1 ABI 148, and the exact Packager/Rebuild versions used by this
layer. It also pins Clang 15.0.7 for native addon compilation. GCC 11 cannot
parse Electron 43's deprecation-plus-visibility attribute ordering in the V8
headers; the build verifies both compiler commands, the exact compiler version,
and the native target tuple before rebuilding.

The portable Node pin is **24.18.1**, matching the
[macOS compatibility hold for #135](macos-release.md#node-24181-compatibility-hold-135).
Both architectures rebuild `better-sqlite3` against those verified archive headers
and run the allocation-driven SQLite cleanup gate before publication. The pin
avoids Node 24.19's header regression without dropping 24.18.1's security fixes;
Linux native runtime verification remains required, not inferred from macOS tests.

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
   manifest, Node ABI, `better-sqlite3`, hook, and allocation-driven SQLite self-tests;
4. rebuilds `better-sqlite3` for the pinned Electron ABI;
5. creates a thin Electron application folder containing only the matching
   Linux runtime key;
6. verifies ELF architecture, libc symbol floors, Electron/Node versions and
   ABIs, both native addons, schema-2 Setup metadata, and exact-host payload
   selection;
7. archives and restores the runtime and app folder, repeats verification,
   launches the restored app under Xvfb, and exercises runtime install/prune.

The workflow uploads short-lived Actions artifacts for review and protected
aggregation. It has read-only repository permissions, persists no checkout
credentials, uses no secrets, and cannot publish GitHub Release assets itself.

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
entry. appimagetool runs from an empty isolated working directory and HOME
through a dedicated child process with the canonical `022` umask, so an ambient
`.appimageignore` or caller umask cannot alter the output. CI builds the AppImage
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

## Build and install a DEB

`release/linux-deb.json` is the single exact DEB contract shared by both
architectures. It maps `linux-x64` to Debian `amd64` and `linux-arm64` to Debian
`arm64`; pins the Linux-input and icon digests, package metadata, dependencies,
layout, desktop entry, immutable Ubuntu container images, and `dpkg-deb` 1.21.1.
The package builder runs inside the matching digest-pinned Ubuntu image with the
matching bundled Node runtime. It uses native
`dpkg-deb --root-owner-group --uniform-compression -Zxz -z9`, not a separate
Electron packaging framework.

After producing the matching verified thin folder, build x64 with:

```sh
npm run package:linux-deb -- \
  --app "build/thin/linux-x64/Agent Inbox" \
  --inputs release/linux-inputs.json \
  --deb-inputs release/linux-deb.json \
  --output-dir build/deb
```

Build arm64 with:

```sh
npm run package:linux-deb:arm64 -- \
  --app "build/thin/linux-arm64/Agent Inbox" \
  --inputs release/linux-inputs.json \
  --deb-inputs release/linux-deb.json \
  --output-dir build/deb
```

The canonical outputs are:

- `agent-inbox_X.Y.Z_amd64.deb`
- `agent-inbox_X.Y.Z_amd64.deb.sha256`
- `agent-inbox_X.Y.Z_amd64.deb.report.json`
- `agent-inbox_X.Y.Z_arm64.deb`
- `agent-inbox_X.Y.Z_arm64.deb.sha256`
- `agent-inbox_X.Y.Z_arm64.deb.report.json`

Install through apt so declared desktop-library dependencies are resolved:

```sh
sudo apt install ./agent-inbox_X.Y.Z_amd64.deb
# or, on arm64:
sudo apt install ./agent-inbox_X.Y.Z_arm64.deb
```

Launch `Agent Inbox` from the desktop menu or run `agent-inbox`. The package
installs the application under `/usr/lib/agent-inbox`, the launcher under
`/usr/bin`, the desktop entry under `/usr/share/applications`, and the pinned
icon under the hicolor theme. `chrome-sandbox` is the sole privileged package
entry and is stored as root-owned mode `4755`; the DEB launcher never disables
Chromium's sandbox.

The clean launch gate checks the helper's stored ownership and mode separately
from live Chromium `/proc` evidence. The live evidence demonstrates a Chromium
child using a distinct user namespace, `NoNewPrivs`, and seccomp filtering on
the tested host; it does not claim the setuid helper was the mechanism Chromium
selected for that particular launch.

Verify downloaded bytes before installation:

```sh
sha256sum --check agent-inbox_X.Y.Z_amd64.deb.sha256
# use the arm64 sidecar with the arm64 package
```

The strict verifier checks the outer ar member order and metadata, exact control
fields, every control/data tar owner, group, mode, timestamp and symlink, the
complete allowed root layout, package notices, icon and launcher, and the sole
sandbox privilege directly from archive metadata. It then extracts with a
child-only zero umask and reruns the complete thin-folder ELF architecture,
Electron/Node ABI, native-addon, GLIBC/GLIBCXX, runtime-manifest, Setup-selection
and source-tree gates.

Upgrades and reinstalls replace only package-owned `/usr` files. The package has
no maintainer scripts, conffiles, `/etc` files, or package-owned home-directory
paths. Remove or purge with:

```sh
sudo apt remove agent-inbox
sudo apt purge agent-inbox
```

Both operations deliberately preserve `~/.agent-inbox`, including the inbox
database and any Setup runtime copied there. A runtime installed through the
in-app Setup panel remains usable after the DEB is removed because registration
points to that copied runtime, not `/usr/lib/agent-inbox`.

The `Linux x64 DEB` and `Linux arm64 DEB` workflows are independent, read-only,
secret-free native gates. Each builds twice under different ambient umasks,
requires byte-identical packages/checksums/reports, installs into its matching
digest-pinned clean Ubuntu image with no system Node, launches directly and
through the desktop entry, verifies the loopback boundary and live Chromium
sandbox evidence, exercises bundled Setup in an isolated HOME, relaunches
offline, reinstalls, removes and purges, proves user data and the copied runtime
survive, then downloads and rehashes its own uploaded Actions artifact.

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

## Protected multi-platform publication

One exact annotated `vX.Y.Z` tag drives the macOS and four Linux package jobs.
The unprivileged producer run must complete every native build, reproducibility,
launch/install, Setup, sandbox, persistence, and rehash gate. The trusted
default-branch `workflow_run` consumer then downloads each artifact by exact
run ID and requires its version, source commit/tree, architecture, package
report, native verification report, checksum sidecar, and pinned input-manifest
digests to agree before any protected job receives credentials.

The public allowlist is exactly:

- `Agent-Inbox-vX.Y.Z-universal.dmg`
- `Agent-Inbox-vX.Y.Z-linux-x86_64.AppImage`
- `Agent-Inbox-vX.Y.Z-linux-arm64.AppImage`
- `agent-inbox_X.Y.Z_amd64.deb`
- `agent-inbox_X.Y.Z_arm64.deb`
- `SHA256SUMS.txt`
- `update-manifest.json`
- `update-manifest.json.sig`

The checksum manifest contains the five binary-package names in ascending
bytewise filename order. Build reports and per-package checksum sidecars remain
retained Actions evidence; they are not duplicate public assets. Aggregate
evidence contains only canonical relative names, hashes, sizes, source and
manifest identities, and verification outcomes—never builder-local paths. The
deterministic update manifest repeats the exact five package names, byte lengths,
and SHA-256 values with platform/architecture/install-strategy metadata. Its
detached Ed25519 envelope covers the exact manifest bytes and carries a canonical
key-id-sorted signature array. Production emits one signature; future key rotation
can overlap old and new signatures without a schema change, and verification accepts
any valid signature from a pinned trusted key. Structurally valid entries for keys an
installed client does not yet pin are ignored; an unknown-only envelope still fails.
The current protected signer remains single-key, so routine rotation must wait for a
future dual-key signing extension rather than merely flipping the active key. Neither
manifest asset is added to the package-only checksum file.

Publication starts with a private draft carrying neutral staging metadata. The
write-scoped job uploads the exact allowlist, verifies the remote API inventory,
always downloads all eight assets into isolated storage, compares each file with
the protected handoff, rehashes all five packages through the downloaded
checksum manifest, and independently verifies the manifest signature and target
metadata. Only then does one API update install the final title/notes and make
the release public. Before signing, a separate read-only protected job proves
that this is the first manifest-bearing release or verifies the latest prior
manifest pair and signed key continuity. An exact already-public rerun is a
verified no-op; an existing draft or any conflicting tag, metadata, asset, byte,
checksum, or signature fails closed. Draft creation captures the numeric release
ID directly from the API response and writes a private ownership marker binding
the tag, source commit/tree, producer run ID/attempt, and inventory digest.
Cleanup GETs only that ID and deletes only while the complete marker, unique
title, draft state, tag, and source still match this run. A replaced or edited
draft is retained.
Once the final publication PATCH may have been attempted, cleanup never
auto-deletes; the ID/tag remain recovery evidence. Final public notes carry the
same identity in a non-rendering marker, so exact-public reruns can verify and
no-op while marker mismatches fail without mutation.

`.github/workflows/release-aggregate.yml` provides the PR/fork/manual validation
path. It invokes the same five secret-free package workflows and the same Linux
aggregation verifier, but its macOS artifact is explicitly ad-hoc/provisional
and its evidence says `publishable: false`; it has no release-write permission,
protected environment, Apple credential, or Release API mutation.

## Retained limitations

The release intentionally has no RPM, Snap, Flatpak, distro repository,
Linux signing/attestation provider, or Electron update client yet. The signed
manifest authenticates project-published bytes but does not by itself download
or install anything. SHA-256 verifies downloaded bytes against the protected
release transaction but is not an OS-wide Linux trust claim.
The native x64 and arm64 evidence supports the documented
Ubuntu/Debian-class glibc baseline only; it is not a claim of universal Linux
compatibility. If a future hosted runner cannot expose FUSE or unprivileged user
namespaces, that architecture's gate must fail or state the missing evidence;
it must not turn the unsupported path into a success-shaped result.
