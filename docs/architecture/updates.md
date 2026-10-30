---
paths:
  - "electron/update-*.cjs"
  - "scripts/update-manifest.mjs"
  - "scripts/package-update-trust.mjs"
  - "scripts/macos-release-kind.mjs"
  - "release/update-keys.json"
applyTo: "electron/update-*.cjs,scripts/update-manifest.mjs,scripts/package-update-trust.mjs,scripts/macos-release-kind.mjs,release/update-keys.json"
---

# Updates: signed manifests, download and install

The signed update manifests (#106, #343, #342), the rollback high-water mark (#148) and the verified download and installers (#196).

Moved out of `CLAUDE.md` and `.github/copilot-instructions.md` by #379, nearly verbatim. Claude Code and Copilot CLI load this file automatically when they read or edit a file matching the `paths`/`applyTo` globs above (through the symlinks in `.claude/rules/` and `.github/instructions/`); anyone else should read it before changing those files.

## History (shipped since v1)

These landed after v1 and still hold invariants; the release history itself is in `CHANGELOG.md`.

- **Signed update-manifest trust contract** *(#106 Layer 1)* — protected releases contain
  five packages, package-only `SHA256SUMS.txt`, deterministic `update-manifest.json`, and
  `update-manifest.json.sig`. The exact manifest bytes are signed with Ed25519 after
  package aggregation; `electron/update-manifest.cjs` is the side-effect-free verifier
  staged with every app. `electron/update-trust.cjs` is the optional startup boundary:
  it catches only registry read/parse initialization failure, logs one generic
  updater-disabled error without file/key contents, and returns `null` so the core app
  continues. `scripts/update-manifest.mjs` owns build-time generation, history
  authorization, and signing. The committed `release/update-keys.json` labels keys
  only after deriving each id from SPKI DER. Signature-envelope schema 1 is a canonical
  sorted array so rotations can overlap old and new signatures; production currently emits
  one. Verification validates every entry's shape, ignores entries for keys absent from the
  installed registry, and requires at least one pinned-key signature to pass; rejecting an
  old+new envelope merely because the new key is unknown would brick skipped-version clients.
  The current protected signer is deliberately single-key: do not flip `signingKeyId` for
  routine rotation until a separate change adds protected dual-key signing and keeps overlap
  signatures through the supported direct-upgrade floor.
  Bootstrap requires proving no prior published stable release has either manifest asset.
  Later releases verify the latest prior pair and signed `trustedKeyIds` continuity before the one secret-bearing signing step. The sole write job still stages a private
  draft, independently verifies every remote file (ten since #343) plus the five-entry
  checksum and the signatures, then exposes them atomically by undrafting. This layer adds no Electron
  fetching, scheduling, download, or install behavior. *(#340)* Installed apps keep the
  reader they shipped for good, so `test/fixtures/shipped-updaters/` holds it byte for
  byte: `v1.2.8/` (1.2.0–1.2.8) and `v1.6.0/` (1.3.0–1.6.0, with its trust-state writer),
  each folder with its own `update-manifest.cjs`. `test/shipped-updaters.test.ts` pins
  every file's SHA-256 and runs them against today's publisher; never edit or regenerate
  a fixture, and keep those tests passing through any manifest change (#295).
  *(#343, design `docs/superpowers/specs/2026-10-23-update-manifest-v2-design.md`)* Every
  release from 1.7.0 publishes ten files: five packages, `SHA256SUMS.txt` (still the
  packages only) and two manifest pairs. `update-manifest-v2.json` (schema 2, read from
  1.7.0 on) lists the release's own DMG, universal or, from 2.0.0, arm64, and the four Linux
  packages; its reader skips target types it does not know and ignores unknown keys, while
  the publisher stays strict about the set. `update-manifest.json` (schema 1, unchanged) is
  what 1.2 to 1.6 read for good: in a universal release it is the v2 data with schema 1,
  byte for byte what the v1-only generator wrote (G8); in an arm64 release it re-stamps the
  release before's v1 manifest, which must verify, changing only `publishedAt`, `expiresAt`,
  `signingKeyId` and `trustedKeyIds`, so it keeps describing the newest release with a
  universal DMG (G6). The macOS kind is measured, not labelled: the CPU types `lipo`
  reported for the shipped executable and better-sqlite3 addon must equal
  `macosArchitectures` in `release/macos-inputs.json`, and one table
  (`scripts/macos-release-kind.mjs`) gives the DMG name, its labels, the Intel gate and how
  v1 is made (G9). *(#296)* That set is `["arm64"]`: the macOS app is built for Apple silicon
  only, from one native thin app carrying the `darwin-arm64` runtime, with no
  `@electron/universal` merge, x64 runtime or native Intel gate, so a universal kind can no
  longer pass; the assembly also requires every Electron Mach-O to hold exactly that set
  (`verifyMachOArchitectures`). *(#383)* That sweep finds each Mach-O by its magic bytes,
  read in-process (never `file`, which reads fat64 as data and can fail or time out), and a
  file it cannot read fails the build. The notarize job re-checks the restored app against
  the sign job's Developer ID report (its fields, the app's tree identity, bundle version
  and signing identity) before zipping it for notarization (`verify-developer-id`).
  1.x-last is v1.8.0: every release from 2.0.0 re-stamps its
  `update-manifest.json`, and its notes name it for Intel Macs, found by `verify-handoff`'s
  `intel-release` in GitHub's listing with the G6 rule (`newestUniversalRelease`), never a
  constant. Aggregation writes only v2. The sign job's YAML only moves files between
  trusted subcommands of `scripts/update-manifest.mjs`: `check-release` (G7, G9: re-hashes
  the packages and binds the authorized tag and commit), `inspect-history --kind`,
  `history-assets`, `authorize-history` (both earlier pairs, fetched by asset id, verified
  under this release's keys without an expiry check; G1 to G5), `derive-v1`, one `sign`
  process for both files (the key's step runs nothing else) and `bind`, which writes
  signing evidence schema 2 (per-manifest records, the measured kind, both histories, a
  re-stamp's earlier digest and copied targets). G10: every v1 manifest carries a valid
  signature from `ed25519-99927ba2f6af6482`, the only key 1.2 to 1.6 trust, pinned as
  `ORIGINAL_UPDATE_KEY` and again in the publish job. Only the exact
  `ALLOW-UPDATE-KEY-ROTATION:<tag>:<signingKeyId>` override waives it: checked before the
  key is touched, recorded in the evidence, and required again in the publish job's own
  `macos-release` environment variable (a repository variable of the same name also works);
  using it knowingly cuts 1.2 to 1.6 off. The publish job, which has
  no checkout, recomputes the kind, verifies both envelopes, checks v2 and a universal v1
  against the release, re-checks an arm64 re-stamp on its own against the release listing
  and the earlier pair it fetches by asset id, and sends `make_latest: "true"`: apps read
  both manifests only through `/releases/latest`. Never delete or edit 1.x-last's files,
  and never publish a stable release by hand or with `make_latest: false`.
  *(#342, design §10 decision 7)* `release/update-keys.json` also lists a backup key,
  `ed25519-c8adddea0de080d6`, which signs nothing: `signingKeyId` stays the original,
  so every manifest from 1.7.0 lists both ids in `trustedKeyIds` (sorted) and carries one
  signature, the original key's. The 1.2 to 1.6 readers accept that, because they never
  compare `trustedKeyIds` with the keys they hold; `test/shipped-updaters.test.ts` pins it.
  The backup key exists for the emergency path alone (`docs/macos-release.md`, "The backup
  update key"): if the original key is lost or compromised, a release signed with the
  backup key under the exact override still reaches every app from 1.7.0 on, Intel Macs on
  1.x-last included, waives G10 and knowingly cuts 1.2 to 1.6 off. Every later release the
  backup key signs needs its own override, and the emergency release must keep the original
  key listed so the history still verifies. Its private half lives only in the owner's
  private 1Password vault. A routine rotation still needs the dual-key signer (#148).
  Tests find the backup key by its id, never as the key that doesn't sign, which an
  emergency switch would make the original.
- **Rollback high-water mark** *(#148, rollback half only)* — the packaged notify-only
  checker (`electron/update-fetch.cjs` + `update-controller.cjs`) persists the highest
  release version whose manifest passed signature, schema and expiry verification in its
  own Electron userData file, `update-trust-state.json` (`{ schema: 1,
  highestVerifiedVersion }`; `createUpdateTrustState` in `update-preferences.cjs`, with its
  own lock and the shared temp-file + rename helper). **Never add a key to
  `update-preferences.json`:** 1.2.0–1.2.8 accept that file only with exactly
  `schema`/`automaticChecks`/`lastNotifiedVersion` and otherwise read defaults, silently
  turning automatic checks off; its format and strict parser stay as 1.2.x shipped them.
  `checkForUpdate()` calls the controller-supplied `recordVerifiedVersion` exactly once,
  only after `verifyManifest()` succeeds. The controller saves the highest version verified
  in this process under the lock (no write when not higher, so a release whose own save
  failed is saved by the next successful one) and returns max(stored or still-readable
  mark, that session high), so the stale decision matches the stored mark and an
  unsaveable mark still holds for the session. A verified manifest below the mark returns
  `stale`: no offer, no notification, no attention/badge change, normal retry schedule.
  Offers still need a version above the running app, so the effective floor is max(mark,
  running version), and a deliberate downgrade is still offered the newest release at or
  above the mark. The trust-state reader is tolerant of newer builds: a valid mark counts
  whatever else the file holds, unknown fields survive a raise, and a newer `schema` is
  enforced but never overwritten, so later trust state (e.g. key rotation) can live there.
  A missing or corrupt file means no mark (floor = running version) and is replaced by the
  next verified check. 1.2.x builds ignore the file, so a reinstalled 1.2.x build enforces
  no mark until 1.3+ runs again. Not covered: the first check after install or a userData
  reset, a newer release withheld before this installation verified it, and the
  dual-signed key-rotation transition — the other half of #148 — so the single-key signer
  rule above still stands. The publisher already refuses to sign a version that is not
  newer than every prior stable release, so re-pointing GitHub's latest at an older
  release shows `stale` to every client that already verified the newer one; fix forward.
  *(#343)* Two marks share the file: `highestVerifiedVersion` stays the v1 mark (1.3 to 1.6
  read and write only it and keep the other field) and `highestVerifiedVersionV2` holds
  what `update-manifest-v2.json` verified. The checker calls
  `recordVerifiedVersion(version, manifest)` once per manifest it verifies: v2 on every
  check, v1 only in the Intel fallback. A v1 manifest is stale below the v1 mark and a v2
  manifest below the higher of both, at check time and again at install time, where the
  offer's manifest is the one of the latest check that confirmed the download (an Intel
  Mac's universal 1.9.0, offered by v2 before 2.0.0 and by v1 after it, must not be refused
  by v2's 2.0.0 mark). One shared mark would make the frozen v1 manifest stale for every
  app that has seen 2.x, blocking the Intel fallback and a deliberate downgrade to 1.6. The
  publisher's refusal to sign a version that is not newer has one exception: an arm64
  release's v1 manifest, an exact re-stamp of the earlier verified one, which no v1 reader
  can take for a rollback because its mark is at most 1.x-last.
- **Verified update download** *(#196 part 1)* — on a packaged
  `macos-dmg` or `appimage-self-replace` host, Settings → Updates offers **Download
  update** for the release the signed manifest verified; it never starts on its own and
  `deb-notify` stays notify-only. `checkForUpdate({ includeArtifact: true })` hands the
  pinned target (URL, length, SHA-256) to Electron main only; the controller publishes
  `available.downloadable` and byte progress, never the URL, digest or path.
  `electron/update-download.cjs` re-validates the target against `TARGET_SPECS_V2` (#343:
  `TARGET_SPECS` plus the arm64 DMG), fetches
  only the canonical `github.com/shariqh/agent-inbox/releases/download/vX.Y.Z/<file>` URL
  with manual redirects (at most five, HTTPS, no credentials, `github.com` only to that
  exact URL, otherwise only `release-assets.githubusercontent.com` or the older
  `objects.githubusercontent.com` under `/github-production-release-asset…/`), and
  streams into a fresh `mkdtemp` `0700` staging directory under
  `userData/update-downloads`. The signed `byteLength` is a hard cap while streaming; the
  file is fsynced and renamed to `v<version>-<sha256>/<filename>` only after the exact
  length and digest match. Every failure — network, stall or total timeout, cancellation,
  disk, wrong length or hash — removes the staging directory, so nothing unverified ever
  sits at a verified path. A same-artifact request joins the in-flight download or reuses
  the file only after re-hashing it (`O_NOFOLLOW | O_NONBLOCK`, so a planted symlink is
  refused and a planted FIFO cannot block, inside a directory `lstat` proves is real);
  `verify()` applies the same checks. A different artifact supersedes it.
  Cleanup is bounded and pattern-only: it never follows symlinks, removes staging
  directories only after an hour without writes (two app processes can share
  `userData`), and drops downloads at or below the running version, superseded by a
  newer verified offer, or no longer offered. Checks and downloads never overlap (a
  download request is refused while a check is starting, and checks are skipped during
  a download); a
  re-check while verified is quiet and keeps the file unless a successful check offers
  something else. A `stale` result (#148) is no such offer: like a failed check it never
  prunes or forgets the offer, and a verified download stays on screen with only its
  check time refreshed, so a serving path that is behind cannot delete a verified
  newer download. The install steps
  consume `getVerifiedArtifact()` (`{ path, version, tag, filename, sha256, byteLength,
  architecture, packageType, installStrategy }`) only through `downloader.openVerified()`
  (part 2, below). *(#343)* The verified record carries the target's `architecture`, and a
  file is reused only for the same one: a record an older build wrote is downloaded again. The downloader itself never executes, mounts, opens or installs, and update
  state never enters `public/attention.js`, badges or Needs-you.
- **Verified update install on macOS** *(#196 part 2)* — **Install and restart** in
  Settings → Updates installs the verified DMG; an AppImage installs through its own
  installer (part 3, below), `deb-notify` stays notify-only. Load-bearing pieces:
  (1) **The install contract** (`electron/update-install.cjs`): `PlatformInstaller {
  strategy, feasibility, prepare, cleanup? }`; `prepare()` stages AND fully verifies
  without touching the running installation, and the returned `commit()` is the only
  step that changes it (`discard()` is idempotent and never rejects). Feasibility is
  side-effect free, consulted on every check (not ok ⇒ a notify-only offer with
  `available.reason`, `downloadable:false`) and again right before install; reasons that
  could carry a path are replaced by generic copy. (2) **fd hand-off, hash while
  consuming:** `openVerified()` applies `verify()`'s location/directory checks, opens the
  file once (`O_RDONLY|O_NOFOLLOW|O_NONBLOCK`) and re-hashes it through that handle,
  which the controller narrows to positioned `read`/`stat` for `prepare()`;
  `copyVerifiedSource()` hashes exactly the bytes it copies. A swapped file at the path
  never reaches the installer; a file that changed is dropped and the download offered
  again. (3) **Verify the STAGED copy, never the mount:** the DMG copy is attached
  read-only (`-nobrowse -noautoopen`, checksums on, stdin closed, always detached, `-force`
  retry, never recursing into a still-mounted volume); exactly one real `Agent Inbox.app`
  is `ditto`ed into a `0700` `.agent-inbox-update-*` folder beside the running app on the
  SAME volume; then `plutil` id + version, `codesign --verify --deep --strict` with a
  requirement built only from constants (`identifier` + Team ID `VVR2DKR923`), and
  `spctl --assess` — Node-written files carry no quarantine, so this is the only
  Gatekeeper evaluation. Release DMGs are lzma `ULMO` images since #289
  (`scripts/macos-dmg.mjs`, which refuses any other format): these flags attach them as
  they attached `UDZO`, and every installer since 1.3.0 uses the same flags, so a later
  DMG format must stay attachable by them.
  (4) **The helper** is constant `/bin/sh` text, spawned detached
  with fixed argv, `stdio:'ignore'` and a minimal `PATH`. It waits until BOTH the app PID
  and the viewer PID it started (`-` for an in-process or reused viewer) have exited —
  otherwise the relaunched app could find the dying viewer on the port and take the
  unowned reuse path — giving up unchanged after ~120 s; it refuses symlinks and an
  occupied backup path, renames the app aside, renames the staged app in with rollback,
  and relaunches with `open`. (5) **Retained backup:** `Agent Inbox.app.previous` stays in
  the stage folder; startup `cleanup()` removes stage/work folders only after an hour,
  by exact name, owner uid and without following links, bounded per pass. (6) **Controller
  ownership:** `installNow()` claims the controller synchronously; while installing and
  after commit no check, download, cancel, prune or cleanup runs, and `dispose()` never
  discards a committed install. It refuses (as `install-failed`, file kept) a version not
  newer than the running one, one below the high-water mark RE-READ from the trust file,
  a check in flight, Setup running, or a feasibility failure. (7) **Main gating:** the
  argument-free `agent-inbox:update-install` IPC needs a trusted update sender AND the
  window bound to a viewer this app started and proved it owns (`viewerOwned`, set only
  in the `waitForOwnership()` branch; bound at the first navigation and, since #216, again
  after a later load re-proves it — `electron-app.md`) — not Setup's runtime
  payload; a reused or failed-over viewer never gets installs. Setup and an update
  install exclude each other in both directions: the controller's `isSetupRunning` is
  `installGate.running()` (#205's gate; a source pin evaluates that exact expression
  against a real gate), and the Setup handler checks `isInstalling()` synchronously right
  before `installGate.run()`. #205's `beginAppQuit()` also ends update installs: it clears
  `updateInstallWebContentsId`, the install IPC returns early once `installGate.quitting()`,
  and the controller's `isQuitting` refuses `installNow()`. `requestRestart()` (flag +
  `beginAppQuit()` + `app.quit()`) is the ONLY quit path for an update; `before-quit`
  calls `beginAppQuit()` first every time and never blocks the restart otherwise; a user
  quit during an uncommitted install cancels it first, and the abort is re-checked after
  the attempt record is written, before `commit()`. (8) **A failed swap is reported, not
  looped:** the controller writes `userData/update-install/last-attempt.json` (`{schema:1,
  from, to, at, platform, strategy}`, atomic) through `createInstallAttemptStore()` just
  before `commit()` and never commits an attempt it could not record; a rejected commit
  removes it. `commit({ resultPath })` hands the helper `last-attempt.result`, where it
  writes only its exit code (shared `INSTALL_HELPER_EXIT`) before every exit; its argv
  validation refuses relative, dot-segment and trailing-slash paths (a trailing slash
  would make its symlink checks test the link's target). The first `rendererReady()`
  takes both files BEFORE any cleanup (cleanup only matches `install-XXXXXX`, pinned), and
  only in an instance with a registered installer; a record without a result stamped
  within 150 s of now EITHER WAY (the helper's wait plus margin; `Math.abs`, so an NTP
  step back still counts as in flight) is left for the app the helper reopens, while a
  stamp far in the future is stale, so it cannot hold a notice. The helper
  writes its result BEFORE reopening the app. Exit 0 is never reported as a failure; an
  app still older than `to` publishes `installNotice` on every state until that release
  stops being offered or a new install starts, and notifies once. Part 3 reuses the store,
  the exit codes and `resultPath`. Update state still never enters
  `public/attention.js`, badges or Needs-you. Open: the real `/Applications` swap under
  macOS App Management needs the planned 1.3.0 → 1.3.1 end-to-end run.
  *(#343)* **This process's architecture.** The installer takes `hostArch`
  (`process.arch`, which is `x64` under Rosetta). Feasibility refuses an arm64 target
  unless it is `arm64` (reason `architecture`, with copy that names neither processor) and
  any other architecture, or an unknown host, as `error`; `prepare()` refuses an arm64
  record on such a host before any filesystem call. The plist check also requires
  `CFBundleExecutable` to be `Agent Inbox`, and then `verifyStaged` reads at most 4 KiB of
  `Contents/MacOS/Agent Inbox` through `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` and requires a fat
  header (`0xcafebabe`/`0xcafebabf`, 1 to 8 entries, all inside the bytes read; a Java
  class file shares the magic and fails on its count) or a thin little-endian 64-bit one
  (`0xfeedfacf`) naming this process's CPU type (`0x0100000c` arm64, `0x01000007` x86_64),
  before codesign: the bytes that will run, not the manifest's label. No `lipo`: without the
  Command Line Tools it is only an installer stub. A Mac that cannot run an arm64-only
  release gets a blocked, notify-only offer, never downloadable whatever installer is
  registered: `available.blocked` is `apple-silicon` on an Intel Mac (copy says it stays on
  its version; Settings hides Review release, main refuses `update-open-release`, no
  notification) or `rosetta` (copy says to reopen without Rosetta; Review release stays;
  one notification per version). It is blocked only when `update-manifest.json` verified,
  is not stale and is not newer than the running app; a newer v1 is an ordinary,
  installable offer of that universal release, and a v1 read that fails or is stale keeps
  any verified download. A blocked result keeps one too while it is a universal download of
  a release newer than the running app, exactly as `stale` does (only the check time moves,
  nothing is pruned, the download stays on screen): v1 always names the newest universal
  release, so a read that leaves this Mac blocked below the release it holds is behind. That
  covers a 1.x-last download verified through v2, which raised only the v2 mark; an arm64
  download, or one not newer than the running app, is still dropped.
- **Verified update install for AppImage** *(#196 part 3)* — `electron/update-install-appimage.cjs`
  replaces the running AppImage FILE in place (same name and path; the name may carry the
  old version) and restarts into it. (1) **One AppImage proof:** `runsFromAppImage()` in
  `update-fetch.cjs` decides both the offered target and the installer's
  `not-appimage`: APPIMAGE and APPDIR canonical absolute, APPDIR not `/`,
  `process.execPath` inside APPDIR, AND APPDIR the runtime's FUSE mount of that very
  file: a mount point (`lstat` dev differs from its parent's) whose LAST (visible)
  `/proc/self/mountinfo` entry has type `fuse.<name>` and source `<name>`, `<name>` =
  basename(APPIMAGE). The pinned type2-runtime passes no fsname/subtype, so libfuse's
  default subtype is the image's real file name (seen in a real Docker FUSE run; re-check
  on any runtime pin change). Paths alone were not enough (#210 review): our AppRun
  reassigns and exports `APPDIR=$(pwd -P)`, so an extracted `squashfs-root/AppRun` run
  from a shell another AppImage started had a plain-folder APPDIR holding execPath while
  APPIMAGE still named the OTHER app's file, and the commit renamed our update over it.
  The dev check stops that; the mountinfo binding also stops our image mounted by hand
  (`--appimage-mount`) under another image's APPIMAGE. Any lstat/mountinfo failure is
  false (notify-only). Tests inject `appImageProbe`; main and target selection use the
  system. A bare inherited APPIMAGE (a `.deb` or an extracted copy started from another
  AppImage) must never select the AppImage target or point the installer at someone
  else's file. Main registers the installer only under that same proof (plus
  `viewerOwned` and packaged): such a run registers nothing, so no startup report can
  take an attempt record another AppImage copy left in a shared userData.
  (2) **Bound to the launched file:** the installer snapshots the
  AppImage's dev, ino, size and `mtimeNs` when it is created at startup. Feasibility,
  `prepare()` and `commit()` refuse once the file at APPIMAGE differs
  (`changed-since-launch`), which also blocks a second install before a restart.
  Feasibility otherwise needs a regular file owned by the uid, W_OK on the file and
  W_OK|X_OK on a real folder, and the ELF + `AI\x02` magic read through
  `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` with the fstat bound to the lstat'd inode. Messages are
  plain, path-free and end "Use Review release instead." (3) **Stage beside the file:**
  `copyVerifiedSource` writes a hidden `.<name>.update-<16 hex>` sibling (`O_EXCL|O_NOFOLLOW`,
  `0600`; a planted name fails closed, with no retry). It is then sealed through a fresh
  read-only `O_NOFOLLOW` handle: same device as the AppImage (the commit is a rename),
  exactly the signed size, the type-2 magic in the STAGED bytes, `fchmod 0755`, fsync.
  Every failure removes the stage, identity-checked once its inode is known. (4) **Commit =
  rename:** re-lstat the AppImage (full snapshot), its folder and the stage (dev+ino),
  then one `rename(stage, APPIMAGE)`. After that `commit()` NEVER rejects, because the
  installation already changed: best-effort folder fsync, then the restart helper. A
  helper that cannot start only logs, and the user opens the new file. (5) **Restart
  helper, never `app.relaunch()`:** Electron's relauncher execs `/proc/self/exe` inside
  the AppImage's FUSE mount, which the runtime tears down when the app exits. Instead a
  detached host `/bin/sh -c` runs constant text with argv `<app-pid> <viewer-pid|->
  <polls> <target> <result|-> -- <app args…>`, `set -u`, arguments validated (exit 64;
  the `--` in sixth place is required), `cwd:'/'`,
  `stdio:'ignore'`, unref'd, and `commit()` resolves only on its `spawn` event. It polls
  `kill -0` for the app AND the viewer child (the same port race as macOS), exits 75
  after ~120 s without starting anything, then `exec "$target" "$@"`. The app args are
  `process.argv.slice(1)` captured when main creates the installer, minus ONE leading
  `--disable-setuid-sandbox`: our AppRun (`renderAppRun`) puts it in front of the user's
  args and the new AppRun adds it again, so forwarding it would add a copy per update; a
  copy the user typed is kept. It reuses #207's report
  seam: `commit({ resultPath })` (validated before the rename; none means `-`, no
  report), `<result>` checked first (invalid: 64, writes nowhere), and the shared
  `INSTALL_HELPER_EXIT` code written (temp + rename, a `umask 077` subshell the app never
  inherits) before every exit AND just before the exec: 0 right before it, 65 when the
  path no longer holds a regular executable non-symlink file (the closest code to a
  failed exec; an execve failure after that check still reads 0). Because the commit
  replaced the file first, the app opened next from that path is the new version, so the
  controller's next-start report is silent whatever the code. Its env is `process.env` minus APPDIR,
  APPIMAGE, ARGV0, OWD, TARGET_APPIMAGE and every `:`-entry resolving inside the old
  APPDIR; a list left with only empty entries is dropped whole, and so is a PATH naming no
  directory at all (an empty PATH left the helper without `sleep`/`mv`: exit 75 in
  milliseconds, no restart). Unset, `/bin/sh` uses its default search path. The module
  never imports `child_process` (`spawnImpl` is injected) or Electron.
  (6) **No rollback copy:** the rename frees the old inode at exit; going back means
  downloading the older AppImage. (7) **Cleanup:** at most 16 removals and 64 candidates
  per pass, exact stage names, regular files or symlinks (unlinked, never followed) owned
  by the uid and over an hour old, never this process's live stage, and only under the
  AppImage proof. (8) **Extract-and-run is notify-only:** its APPDIR is no mount, so the
  proof in (1) already fails; the installer also refuses it by name (`extract-and-run`),
  as defense in depth and for the commit-time re-check. The runtime
  extracts into the predictable `$TMPDIR/appimage_extracted_<md5>`, recreates it `0755`
  when missing and reuses existing right-size files, and the documented launcher's `trap`
  removes its private TMPDIR as the app exits, so a restart could run a planted `AppRun`
  as the user. Detected by ANY `APPIMAGE_EXTRACT_AND_RUN` (the runtime tests
  `getenv() != NULL`, and a restart inherits it) or an APPDIR basename starting
  `appimage_extracted_` (`--appimage-extract-and-run` sets no variable and is stripped
  from argv). Checked in `inspect()` (so feasibility and `prepare()`) and again before the
  rename in `commit()`, reading env live; an unreadable env counts as extracted. Cleanup,
  which needs the proof, does not run there. Install-then-quit was rejected: it needs a no-restart flag through the
  controller, preload, three Settings strings and the notifier, plus an attempt record
  with no helper result. Open: the real offer → install → FUSE teardown → relaunch needs
  the first signed 1.3.0 → 1.3.1 pair on a Linux desktop (manual plan in the PR).
