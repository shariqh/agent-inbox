# Universal macOS release pipeline

Layer 2 builds a universal `Agent Inbox.app` and a conventional drag-to-Applications
DMG. Its artifacts are **provisional**: they are not public release assets and do not
claim Gatekeeper trust or notarization.

## Pinned inputs

`release/macos-inputs.json` is the only source of Node archive URLs, hashes, roots,
runtime keys, Node ABI, and Electron packaging tool versions. Validate it with:

```sh
fnm exec --using=24 npm run release:inputs
```

The Node SHA-256 values are copied from the official
`https://nodejs.org/dist/v24.18.1/SHASUMS256.txt` distribution metadata. Runtime
staging rejects any hash, URL, archive root, platform, ABI, or architecture mismatch.

### Electron zips (#363)

Every thin-app build (macOS, Linux and Windows) gives `@electron/packager` the pinned
`electron.version` and the SHA-256 of each file in that Electron release, read from the
lockfile-pinned `electron` package's `checksums.json` once that package is proven to be
exactly `electron.version`. `@electron/get` then checks the zip it downloads, or finds in
its cache, against those hashes instead of fetching the release's live `SHASUMS256.txt`.
`@electron/get` also lets the environment choose the version it downloads and checks (it
checks nothing before 1.3.2) and the server and file it downloads. So before anything is
built, the build refuses to go on while any of these is set to a non-empty value, in any
case: `ELECTRON_CUSTOM_VERSION`, `ELECTRON_MIRROR`, `ELECTRON_NIGHTLY_MIRROR`,
`ELECTRON_CUSTOM_DIR`, `ELECTRON_CUSTOM_FILENAME`, or any `npm_config_electron_*` or
`npm_package_config_electron_*`. npm sets the last two for every `npm run` script from an
`.npmrc` or a `package.json` `config`. The error names the variables, never their values.
A zip that is not the one reviewed with the version bump therefore fails the build, even
if the release's own `SHASUMS256.txt` was replaced along with it. The hashes change only
with the lockfile: when bumping Electron, compare the new `checksums.json` with the
release's official `SHASUMS256.txt`.

### Node 24.18.1 compatibility hold (#135)

Portable runtimes use **Node 24.18.1**, including its security fixes over 24.18.0.
Node 24.19.0's `node::ObjectWrap` headers added cleanup hooks without the companion
runtime registry fix ([upstream #65446](https://github.com/nodejs/node/issues/65446)).
The resulting `better-sqlite3` statement destructor can abort during allocation-driven
GC, including MCP/watcher startup. ABI 137 compatibility and a passing hook selftest
do not prove safety.

Staging rebuilds the addon from source using the verified distribution's own headers
(`npm_config_nodedir`), then runs `scripts/runtime-sqlite-check.mjs` with the staged
Node against the staged `dist/store.js`. Its private in-memory store creates and
releases 300,000 statements under ordinary allocation pressure; explicit `global.gc()`
is deliberately not a substitute. A failure, signal, or timeout refuses publication.
The check has a 180-second ceiling: GitHub's Intel runners need roughly 25–30 seconds
for it, so the previous 30-second ceiling timed out about a quarter of their runs (#187).
An executable-only downgrade with a 24.19-built addon still reproduces the assertion:
**both the runtime and addon must be rebuilt**, never patched into a signed payload.

This is a release compatibility mitigation, not an upstream fix. Revisit the pin when
a corrected Node 24 release passes the same native GC and packaged MCP/watcher checks.
Each architecture still needs its own native release evidence; Apple-silicon or
emulated x64 results do not establish native Intel or Linux behavior.

#### Electron's embedded Node

The same header change reaches the app itself through the Node.js that Electron embeds.
Electron 43.5.0 bundles Node 24.19.0. A `better-sqlite3` rebuilt against its headers
imports `node::RemoveEnvironmentCleanupHook` and aborts in statement cleanup
(`hooks.cc:142`, `Assertion failed: (env) != nullptr`) both under `ELECTRON_RUN_AS_NODE`
and in Electron's main process. That main process is where the packaged app runs its viewer
and store. Electron 43.6.0 backported the runtime fix
([electron/electron#53393](https://github.com/electron/electron/pull/53393)). Node 24.22.0
then shipped the same fix upstream, so Electron 43.8.0 dropped those patches when it moved
to that Node ([electron/electron#55003](https://github.com/electron/electron/pull/55003)).
The pinned Electron 43.8.3 (Node 24.22.0) therefore needs no hold, but each build still
proves it:

- After the `lipo` check, each native thin-app build runs `scripts/runtime-sqlite-check.mjs`
  with the packaged `Contents/MacOS/Agent Inbox` in Node mode (`ELECTRON_RUN_AS_NODE=1`).
- The check runs against that app's own Electron-rebuilt `better_sqlite3.node` and packaged
  `dist/store.js`.
- The child's `HOME`, `TMPDIR`, XDG directories and `AGENT_INBOX_DB` point into a scratch
  directory. No other inherited variable reaches it, including `NODE_OPTIONS`.
- Electron must first report the pinned version in Node mode. The app does not flip Electron
  fuses, so `RunAsNode` remains enabled.
- The check has the same 180-second ceiling as runtime staging.
- A failure, signal or timeout fails the build.
- The thin report records `electronSqliteCheck: "passed"`, and universal assembly requires it.

**Requires macOS 13.5 (Ventura) or later.** Release builds support both Apple silicon and
Intel. Electron 43 itself supports macOS 12, but the bundled official Node 24 runtime
requires macOS 13.5, so the shipped product must use the stricter minimum. Revisit the
stated minimum before updating either pinned major.

## Architecture pipeline

`.github/workflows/macos-universal.yml` uses native macOS runners:

1. Stage, prune and self-test the arm64 and x64 Node runtime payloads independently
   ([What node_modules ships](#what-node_modules-ships-291)).
2. Restore both verified payloads into each native thin Electron build.
3. Compile `better-sqlite3` for Electron 43.8.3 on that architecture, prune the app's
   `node_modules`, then run the allocation-driven SQLite check under that packaged
   Electron ([Electron's embedded Node](#electrons-embedded-node)). The stage installs with
   `npm ci --ignore-scripts` and `@electron/rebuild` runs with `buildFromSource`
   (`scripts/app-dependencies.mjs`), so the addon is always built from the
   lockfile-pinned source: prebuild-install would otherwise unpack a cached or
   downloaded prebuild, JavaScript included, without checking a digest (#315). The
   packaged thin app keeps only the US and British English Electron locales
   ([What Electron locales ship](#what-electron-locales-ship-292)).
4. Preserve each thin app with a tar archive so framework symlinks and executable
   modes survive artifact transfer.
5. Merge the thin apps with `@electron/universal`. The two
   `Contents/Resources/app/runtime/darwin-*` trees are excluded from `lipo`; Electron,
   helpers, frameworks, and `better_sqlite3.node` must be universal.
6. Launch the provisional app from its DMG as a French user (`-AppleLanguages '(fr)'`)
   and then as a British one (`'(en-GB)'`), and require its hardened loopback marker,
   every renderer's `--lang` (`en-US`, then `en-GB`) and, read from the page over
   DevTools by `scripts/launch-locale-probe.mjs`, the dates the app formats in that
   locale.
7. Run a second, native Intel job against the finalized signed x64 runtime and
   publish its verification record beside the provisional universal artifact.

Set `SOURCE_DATE_EPOCH` to the source commit time for repeatable `setup-info.json`
metadata. No build script downloads an unpinned `latest` tool or Node archive.
Release, build and signing workflows restore no npm cache: no `actions/setup-node`
step sets any `cache` input, and each sets `package-manager-cache: false`, so a later
`packageManager` field in `package.json` cannot turn caching on. Each of these
workflows sets `npm_config_build_from_source=true` once, in its top-level `env`, and no
job or step sets it again (#315). So every npm install in them compiles better-sqlite3,
however the command is spelled. Nothing from the checkout's own install ships, but
scripts and tests load its better-sqlite3 in the jobs that build the release and in
those that hold the signing and notary secrets, and prebuild-install would otherwise
unpack a cached or downloaded prebuild, JavaScript included, and load it without
checking a digest.
node-gyp compiles it against headers it downloads for the runner's Node and checks
against that release's `SHASUMS256.txt`. The universal workflow also runs
`test/app-dependencies.test.ts` under the pinned release Node, so an npm that stopped
passing the variable to install scripts would fail the release run itself. `ci.yml`,
which holds no secret, keeps the prebuilds.
The app and each portable runtime carry the project MIT notice as
`LICENSE.agent-inbox`; the runtime keeps Node's separate upstream notice as `LICENSE`.
The signed app also preserves Electron's upstream `LICENSE.electron` and
`LICENSES.chromium.html` under `Contents/Resources`.

### What node_modules ships (#291)

Each `node_modules` copy, the app's and each runtime's, holds only what is loaded at
runtime. `scripts/prune-node-modules.mjs` removes:

- everything better-sqlite3 carries beyond `package.json`, `lib/` and
  `build/Release/better_sqlite3.node`, which is all it and `bindings` load: its C and
  C++ sources (`deps/`, `src/`, `binding.gyp`) and every compile leftover
  (`build/Release/obj`, `sqlite3.a`, `test_extension.node`, makefiles and a `config.gypi`
  that recorded builder paths);
- TypeScript declarations (`*.d.ts`, `*.d.mts`, `*.d.cts`) and source maps;
- markdown.

License, notice, copying, copyright, authors, contributors and patents files always stay,
as does anything in a folder named like one, and a package without a license file keeps
the markdown at its root. The prune refuses,
before removing anything, a better-sqlite3 whose entry points leave `lib/` or whose addon
is missing. Runtime staging prunes before its probes, hook selftest, SQLite check and MCP
probe, so the runtime manifest lists exactly the files those checks ran against. Each thin
app prunes its own copy after the Electron rebuild and before packaging, and refuses to
publish if the app or an embedded runtime still carries any of it.

### What Electron locales ship (#292)

The UI is English-only, so the app ships only US and British English. Electron brings
Chromium's UI strings in 55 languages: on macOS, 220 `.lproj` folders in `Electron
Framework.framework/Versions/A/Resources` (each language and three grammatical-gender
variants that desktop Chromium never loads, 48 MB), plus 55 empty `.lproj` folders in the
app's `Contents/Resources`, which only tell macOS which languages the app speaks; on Linux
and Windows, 55 `locales/*.pak` files (48 MB).
`scripts/prune-electron-locales.mjs` keeps `en.lproj` and `en_GB.lproj` (and `Base.lproj`,
should Electron ship one) wherever a `.lproj` sits in the bundle outside the app's own code,
and only `locales/en-US.pak` and `locales/en-GB.pak` on Linux and Windows. Chromium's locale
is also the default locale of the dates the app formats, so keeping British English (about
0.55 MB a package) keeps British and Commonwealth users' date formats.

- **Which locale a user gets.** On macOS, Chromium takes its locale from the languages the
  app's own `.lproj` folders declare (`l10n_util::OverrideLocaleWithCocoaLocale`): English
  (UK), Australia, India, New Zealand and Ireland get `en-GB`, US and Canadian English
  `en-US` (macOS matches `en-CA` to `en`), and every other language `en-US`. On Linux and
  Windows, Chromium tries the user's languages (`LANGUAGE`, `LC_ALL`, `LC_MESSAGES`,
  `LANG`; on Windows, the UI language), gives every English variant but US, Liberian and
  Philippine English `en-GB`, and falls back to `en-US` when no pak matches
  (`l10n_util.cc`). Launched with Electron 43.8.0 on macOS and Linux in each of those
  English variants and in French, German and Japanese, the pruned layouts give every English
  variant the same locale as the unpruned ones and every other language `en-US`, in
  `app.getLocale()`, `navigator.language`, every renderer's `--lang` and the page's dates.
- **What a non-English user sees.** The app's text and Electron's menu role labels were
  always English. Strings Chromium takes from its locale pak (such as form validation
  messages and some accessibility descriptions) are now English for everyone. On
  macOS, AppKit's own strings follow the app's language, which macOS resolves from the
  app's `.lproj` folders because the app does not set `CFBundleAllowMixedLocalizations`:
  the items AppKit adds to menus (such as Start Dictation and Emoji & Symbols), the About
  panel's version label and the open panel's buttons and sidebar are now English where
  they followed the user's language. **Users of every other language now get US-English
  date formats** in the two places the app formats dates with the default locale: the
  update check's "Last checked" time (`toLocaleString()`) and the asked-at tooltip
  (`Intl.DateTimeFormat(undefined, ...)`). A French user sees `10/23/2026, 2:05:06 PM` and
  `Oct 23, 2026, 2:05:06 PM UTC` where they saw `23/10/2026 14:05:06` and
  `23 oct. 2026, 14:05:06 UTC`; British and Commonwealth users keep `23/10/2026, 14:05:06`.
  Notifications carry the app's own title, body and action labels, and macOS draws the
  rest. `app.getPreferredSystemLanguages()` still reports the user's languages, while on
  macOS `app.getSystemLocale()` (`NSLocale.currentLocale`) follows the app's language; the
  app reads neither for its UI. Spellcheck still checks the user's language (below).
- **Spellcheck.** Electron seeds a new profile's spellchecker languages from Chromium's
  locale (`ElectronBrowserContext`), so a new French or German profile on Linux, and on
  Windows once it ships, would check the reply boxes against the English dictionary. On
  those two, `electron/spellcheck-languages.cjs` runs at startup, before the first page
  loads, and changes nothing while one of the profile's spellchecker languages shares a
  base language with the system's first language. That keeps an existing `fr` profile on
  a French system as it is, and the `en-GB` Chromium seeds for New Zealand, Indian, South
  African and other Commonwealth English users: Chromium gives them the `en-GB` locale but
  has no dictionary for their own variants, and its bare `en` is the US one. Otherwise,
  for a new French profile seeded with English or a system that changed language, it sets
  the system's languages: for each of `app.getPreferredSystemLanguages()` in order, the
  code in `session.availableSpellCheckerLanguages` it matches exactly, else that of a
  later entry of the same language (`en_NZ:en_GB` lists `en-GB` after `en-NZ`), else its
  base language, one per language and at most three (Chromium sets no limit), and only
  when that differs from what the profile holds and is not empty. A system language
  Chromium has no dictionary for, such as Japanese, leaves a new profile on US English,
  as before. In Docker, Electron 43 keeps `en-GB` under `LANG=en_NZ.UTF-8`, `en_IN` and
  `en_ZA`, gives a new profile under `LANG=fr_FR.UTF-8` the French dictionary (the US one
  without the sync), and moves an `en-GB` profile to `fr-FR` once the system is French.
  macOS is unchanged: its spellchecker is the system's own (`NSSpellChecker`). Chromium
  replaces the preference there with that checker's language, Electron's
  `setSpellCheckerLanguages` does nothing, and a launch with `-AppleLanguages '(fr)'`
  reports `fr` and accepts the same French words with or without the prune.
- **Where.** Each thin-app builder prunes the packaged app once, right after
  `@electron/packager` (the only step that adds Electron's files) and before anything
  checks, hashes or publishes it, so both macOS thin apps carry the same locale set into
  the universal merge. The prune refuses, before removing anything, an app without US or
  British English, or one that reaches either through a link (a linked `locales/` or
  `Resources` folder, which the walk never follows, could hide every other locale). The
  macOS thin build, the Linux and Windows folder gates (which every DEB and AppImage build
  and verification repeats on the folder it packages or extracted), the universal assembly
  before anything is signed, and the final DMG gate refuse an app that lacks either,
  reaches either through a link, or ships any other locale.
- **Launch evidence.** The provisional DMG's app is launched in French and in British
  English and must give its renderers `--lang=en-US` and `--lang=en-GB`; for each,
  `scripts/launch-locale-probe.mjs` reads over DevTools (the launch passes
  `--remote-debugging-port`) which locale the page runs in and how it formats both dates.
  The AppImage FUSE gates run as a French user and require `--lang=en-US`, the extraction
  gates as a British one and require `--lang=en-GB`.
- **Signing.** Electron's prebuilt app is only linker-signed: its framework has no
  `_CodeSignature` and seals no resources, and the prune removes no Mach-O, so nothing
  already signed changes. The framework's signature and its
  `_CodeSignature/CodeResources` are made by release signing, after the merge, and seal
  exactly the two English locales.

## Finalization order

`scripts/assemble-macos-release.mjs` enforces this order:

1. Finish the merged app layout and mark it provisional.
2. Sign every Mach-O in both portable runtime trees. Each must hold exactly two, `bin/node`
   and `better_sqlite3.node`; any other Mach-O, such as the `test_extension.node` releases
   before #291 signed, is refused before anything is signed.
3. Regenerate and fully verify both runtime manifests from the signed bytes.
4. Rewrite `setup-info.json` from those final manifests.
5. Snapshot every runtime file hash.
6. Sign Electron helpers, frameworks, native modules, and the outer app while
   explicitly excluding the already-finalized runtime trees.
7. Require every runtime hash to remain unchanged.
8. Verify signatures, universal/thin architectures, both manifests, current setup
   digests, native runtime selftests, the copied-app loopback boundary, and portable
   runtime install/removal.

There is no signing-time `codesign --deep`. Deep verification is allowed; a late deep
signature is not.

Package smoke exercises the shipped `scripts/setup-filesystem.cjs` through runtime
install/prune and the build-time publisher. It proves the same-parent identity/staging path
on native macOS, including full manifest and mode verification before publication. The
Win32 drive, namespace, ADS, case, junction, and rename-failure cases are injected policy
models only; they are not native Windows release evidence and do not widen the Darwin-only
release profile.

## DMG format

Layer 2's provisional DMG and Layer 3's final DMG (built from the stapled app) both come
from `createReleaseDmg()` in `scripts/macos-dmg.mjs`, so they share one layout and one
format: lzma-compressed `ULMO` (#289). The v1.5.0 DMG measured 338.7 MB as zlib `UDZO`
and 254.4 MB as `ULMO`, 25% less to download. `ULMO` needs macOS 10.15, below the app's
13.5 minimum. The in-app updater of every release since 1.3.0 attaches the DMG with the
same fixed `hdiutil attach -readonly -nobrowse -noautoopen` flags, which verify the image's
checksums and read `ULMO` as they read `UDZO`. The builder fails unless
`hdiutil imageinfo -format` reports `ULMO`, before anything signs or notarizes the image.

lzma costs time. Building the v1.5.0 app's DMG took about 15 seconds longer on an M1 Max,
and mounting it (which verifies every block's checksum) and copying the app out, as
Finder and the in-app updater do, took two to three times as long as with `UDZO`. The
release gate therefore allows 5 minutes for the attach and 10 for the copy instead of its
2-minute default, the same limits the in-app updater uses for those two steps.

## Signing modes

`adhoc` is the no-secret PR/local mode. It signs with `-`, disables secure timestamps,
labels metadata and filenames as ad-hoc/provisional, and never claims Gatekeeper trust.
Its report always sets `notaryEligible: false`: these outputs are validation evidence
only and **must never be submitted to Apple's notary service**. A local dirty working
tree is allowed only in this mode and is reported as `sourceDirty: true`.

`developer-id` is fail closed:

```sh
fnm exec --using=24 npm run package:macos -- \
  --mode developer-id \
  --identity "Developer ID Application: Example Corp (TEAMID1234)" \
  --keychain /absolute/path/to/ephemeral.keychain-db \
  --arm64-app /absolute/path/to/arm64/Agent\ Inbox.app \
  --x64-app /absolute/path/to/x64/Agent\ Inbox.app \
  --arm64-report /absolute/path/to/arm64-report.json \
  --x64-report /absolute/path/to/x64-report.json \
  --output /absolute/path/to/output
```

Both identity and keychain are mandatory. The script never falls back from
Developer ID to ad-hoc. It logs neither keychain passwords nor certificate material.
Layer 3 owns importing credentials into an ephemeral keychain. Developer ID mode also
requires both thin apps to have clean, matching commit provenance and refuses dirty
inputs. Only a successfully verified Developer ID output sets `notaryEligible: true`.

The reviewed entitlements grant only `com.apple.security.cs.allow-jit` to Electron
processes and the portable Node executables. Runtime libraries receive an empty
entitlement set. There is no App Sandbox, provisioning profile,
`allow-unsigned-executable-memory`, or disabled library validation.

## Layer 3 handoff

The output directory contains deterministic filenames for the universal app archive,
provisional DMG, verification report, metadata, the exact input manifest, and
checksums. The report records source commit, version, build mode, architecture proofs,
runtime digests, selftests, thin-app tree identities, source dirty state, and the
unchanged-runtime-hash gate. Each thin report is bound to the complete restored app
tree; swapping or modifying an app or report is rejected before merging.

CI additionally emits `macos-universal-x64-final-verification` and
`macos-layer3-reproducible-inputs`. The latter retains both mode/symlink-preserving
thin archives, their reports, the central input manifest, and checksums for inspection.
Pull-request artifacts expire and are validation evidence only; a release workflow
must rebuild the same thin inputs from the signed tag rather than assume PR artifacts
are available across workflows. The x64 verification record proves only the exact
**ad-hoc** runtime bytes produced by this workflow. Developer ID signing changes those
Mach-O bytes and regenerates their manifests, so that record is not final release
evidence.

When the Layer 2 report says `buildMode: adhoc`, Layer 3 must first rebuild the verified
thin apps from the signed tag, import credentials into an ephemeral keychain, and run
`package:macos --mode developer-id`. After that clean re-finalization verifies with
`notaryEligible: true`, Layer 3 may ZIP and submit the app, wait for acceptance, staple
and validate the app only after running a fresh native Intel manifest, selftest, and
signature verification against that exact Developer ID app. Layer 3 then rebuilds the
final DMG from the stapled app, notarizes/staples/validates the DMG, writes final
checksums, and publishes. It must not submit or publish Layer 2's ad-hoc app or
provisional DMG.

## Protected multi-platform GitHub Release

Layer 3 uses a two-workflow trust boundary:

- `.github/workflows/macos-release.yml` is the unprivileged
  `Multi-platform release inputs` producer that runs only for a `vX.Y.Z` tag push. It
  validates the tag, rebuilds both macOS native runtimes and thin apps, and calls all four
  native Linux package workflows with read-only repository permissions and no environment
  access. The run cannot succeed unless both AppImages and both DEBs pass their independent
  reproducibility, launch/install, Setup, sandbox, persistence, and rehash gates.
- `.github/workflows/macos-release-protected.yml` is a default-branch `workflow_run`
  consumer. GitHub resolves this workflow from the trusted default branch, not from the
  tag. It is the only workflow allowed to reference `macos-release`.

The producer immediately refuses:

- a lightweight or malformed tag;
- a tag version that differs from `package.json`, `package-lock.json`, or the lockfile
  root package;
- a checkout whose `HEAD`, `GITHUB_SHA`, and annotated-tag target differ; or
- tracked working-tree changes.

The producer does not reuse Layer 2 or pull-request artifacts. It rebuilds both pinned
Node runtimes and both thin Electron apps from the exact tagged commit. Only the
Developer ID signing, Apple notarization/finalization, and GitHub publication jobs
reference the protected `macos-release` environment.

Before any protected job starts, the default-branch consumer requires the upstream
workflow's exact trusted workflow ID, repository, event type, successful conclusion, and
run ID. Trusted code then checks that the artifact context, upstream `head_sha`, peeled
annotated tag, package versions, and source commit all agree. The tag commit must occur
on the **first-parent history** of the consumer's trusted `github.workflow_sha`; a tag
reachable only through a merged side branch is rejected. This lets an unrelated
default-branch commit land after the tag without creating a timing race, while preventing
second-parent or arbitrary-ancestor release tags.

Authorization runs from `github.workflow_sha`. After that trust proof succeeds, the
no-secret `verify-handoff` job checks out the validated tag commit and uses that commit's
Node version, release inputs, package code, and provenance checks. It downloads the
triggering run's thin archives by exact run ID, extracts them only through the trusted
archive validator, checks both reports against complete app tree identities and clean
source provenance, and publishes a new allowlisted handoff artifact inside the protected
run. Every source-dependent downstream job also checks out this validated source commit;
the newer trusted workflow SHA remains audit evidence only. Credentialed jobs consume only
the protected handoff. No artifact-provided script is sourced or executed during preflight.

The credentialed sequence is intentionally split:

1. Import the P12 into a generated, ephemeral keychain and validate exactly one
   configured Developer ID Application identity and its Team ID.
2. Re-run `package:macos --mode developer-id` from the freshly rebuilt thin inputs.
   Only the app archive and its verification report cross the job boundary; the
   provisional DMG is discarded.
3. On a native Intel runner, re-extract the exact archive and bind its SHA-256, complete
   app-tree identity, finalization report, signature identity, x64 runtime manifest, and
   x64 selftest into a verification record.
4. Revalidate that record before submitting a `ditto` ZIP of the app. Require an
   `Accepted` app ticket and matching notary log before stapling or validating the app.
5. Build the final DMG from that stapled app, sign the DMG, submit it separately, and
   require a distinct `Accepted` DMG ticket before stapling and validating the DMG. The
   DMG's name comes from the expected macOS kind (below), never from a constant.
6. Inspect the DMG's exact Developer ID authority and Team ID, mount the final post-staple
   DMG read-only, require its expected app/Applications-link shape, and copy the transported
   app with `ditto` into clean temporary storage. Verify the copied app's signature,
   authority/team, staple, Gatekeeper assessment, both runtime manifests and architectures,
   source/version/setup metadata, icon, notices, and that the app ships only the US and
   British English Electron locales. Measure the CPU types of its main executable and its
   better-sqlite3 addon with `lipo -archs` (see "The macOS release kind" below). Launch
   that copied app under a disposable `HOME`, require its hardened loopback marker, and
   exercise portable-runtime install and prune without touching production
   `~/.agent-inbox`. Detach the DMG even when any check fails.
7. Generate the macOS-only internal checksum only after mounted-copy acceptance and from
   the final post-staple DMG bytes. The final evidence (`release-evidence.json`) names the
   DMG from the measured kind and, for a universal release, carries the native Intel
   record from step 3, which must have passed for this source, version and identity.
8. In an unprivileged aggregation job, revalidate the four exact-run Linux package
   artifacts and reports, combine their final bytes with the notarized DMG, and generate
   the canonical `SHA256SUMS.txt` from all five binary packages in ascending bytewise
   filename order. Recompute the macOS kind from the final evidence's measured sets
   against the source commit's expected set, derive the DMG's name, `architecture` and
   `target` from it, and copy the sets into the aggregate evidence as `architectures`
   (with `nativeIntel: "passed"` for a universal release). Generate deterministic
   `update-manifest-v2.json` bytes (schema 2: this release's DMG and the four Linux
   packages) from that same package evidence, the annotated-tag timestamp, and the source
   commit's pinned update key registry. Aggregation writes only the v2 manifest; the
   trusted signer derives `update-manifest.json` from verified inputs (#343).
9. In a separate read-only protected job, trusted default-branch code checks and signs both
   manifests (see "Two update manifests" below); the YAML only moves files between
   subcommands of `scripts/update-manifest.mjs`. `check-release` re-hashes the five
   packages and requires the unsigned v2 manifest to be exactly what this release's
   evidence, keys and inputs give, for the authorized tag and commit, with the macOS kind
   recomputed against `release/macos-inputs.json` read at the release commit (G7, G9). One
   history plan covers both manifests across every published stable release before the new
   version (G1 to G5): the first of each pair may come only from a universal release, and
   once a release has published a pair, the latest prior release must carry it. Each
   earlier pair is downloaded by asset id, checked against GitHub's listed size and digest,
   and verified under this release's registry without an expiry check, and the new signing
   key must already be trusted there. `derive-v1` then writes `update-manifest.json`: the
   v2 data with schema 1 in a universal release (G8), or an exact re-stamp of the release
   before's v1 manifest in an arm64 release (G6). G10, that `update-manifest.json` will
   carry a signature from `ed25519-99927ba2f6af6482`, is checked before the key is
   touched. Only after that proof does one Node process receive the update private key,
   derive its public SPKI, require an exact registry/key-id match, and sign both manifests;
   that step runs nothing else. `bind` verifies both pairs at the current time, checks G10
   on the signed envelope, and writes signing evidence schema 2. Signature-envelope schema
   1 is an ordered array: production emits one entry today, while a future rotation
   release can carry both old- and new-key signatures without changing the schema.
10. Revalidate the complete aggregate/signing evidence and exact ten-file public
   allowlist. Immediately before draft creation, the sole write-token step re-reads the remote tag
   ref, requires an annotated tag object, peels it to a commit, and requires that commit
   to remain the authorized source commit. Publication starts as a private draft with
   neutral staging metadata. After upload it validates exact remote names, uniqueness,
   nonzero sizes, and API SHA-256 digests when present; it then always downloads all ten
   assets, compares every byte with the protected handoff, rehashes all five packages
   through the downloaded checksum manifest, and independently verifies both manifests:
   their signatures, the macOS kind recomputed from the measured sets, v2 and a universal
   release's v1 against the package evidence, an arm64 release's re-stamp against the
   release listing and the earlier pair it fetches itself by asset id, and G10. Only one
   final API update installs the public title/notes, clears the draft bit and makes the
   release latest (`make_latest: "true"`).

### The macOS release kind

Whether a release's macOS package is universal or arm64 is measured, never labelled
(#341; design §7.1 in
`docs/superpowers/specs/2026-10-23-update-manifest-v2-design.md`). The committed expected
set, `macosArchitectures` in `release/macos-inputs.json`, says what the build must
contain: `["arm64", "x86_64"]` today. `verify-final-dmg` records the sorted `lipo -archs`
output of the copied app's `Contents/MacOS/Agent Inbox` and of its
`better_sqlite3.node` as `architectures: { executable, betterSqlite3 }` in the
transported-app evidence, together with the `kind` they give, in place of the old
`universalEnvelope: "passed"` flag. Both sets must equal each other and the expected set,
and then one table in `scripts/macos-release-kind.mjs` gives everything else:

| Measured sets | Kind | DMG name | `architecture` | `target` | Native Intel gate | `update-manifest.json` |
| --- | --- | --- | --- | --- | --- | --- |
| `["arm64", "x86_64"]` | universal | `Agent-Inbox-vX.Y.Z-universal.dmg` | `universal` | `darwin-arm64+darwin-x64` | must have passed | This release: its v2 manifest with schema 1 |
| `["arm64"]` | arm64 | `Agent-Inbox-vX.Y.Z-arm64.dmg` | `arm64` | `darwin-arm64` | none | Re-stamp of the newest universal release's |

Any other set, `["x86_64"]` alone included, fails the release. The notarize job's
`expected-kind` step names the DMG it builds, notarizes, verifies and describes in the
release notes from the expected set; `final-evidence`, the publication check and
aggregation each recompute the kind from the measured sets and refuse a DMG name, label
or Intel result that disagrees. Changing `macosArchitectures` is the only way to change a
release's kind. The trusted signer recomputes it too, against the expected set it reads at
the release commit and records in the signing evidence, and the publish job recomputes it
once more from the measured sets in the signed handoff (G9): the DMG name, the labels, the
v2 manifest's macOS target and the way `update-manifest.json` was made must all agree.

### Two update manifests

Since #343 every release publishes two signed manifests, so a macOS build for Apple silicon
only (#296) can reach Apple silicon Macs without breaking the apps already installed
(design `docs/superpowers/specs/2026-10-23-update-manifest-v2-design.md`):

| File | Read by | Describes |
| --- | --- | --- |
| `update-manifest.json` (schema 1) | 1.2 to 1.6 for good; from 1.7.0 only an Intel Mac, or a Mac running the app under Rosetta, when v2 lists only an arm64 DMG | The newest release with a universal DMG |
| `update-manifest-v2.json` (schema 2) | 1.7.0 and later | This release: its own DMG and the four Linux packages |

In an arm64 release the v1 manifest is a re-stamp: the release before's v1 manifest, which
must verify, with only `publishedAt` (this release's tag time), `expiresAt`, `signingKeyId`
and `trustedKeyIds` changed. Its targets must still be the files GitHub lists for the
release they describe. Intel Macs therefore stay on the last universal release (1.x-last),
which keeps working; its Settings → Updates explains that newer versions need Apple silicon.

Operating rules:

- Never delete or edit 1.x-last's files: every later v1 manifest points at them.
- Once 1.x-last is chosen, edit its published notes by hand, once, to say Intel Macs stay on
  it, keeping the `<!-- agent-inbox-release:… -->` marker line unchanged. A later re-run of
  that release's publish job then fails its exact-notes check without changing anything.
- Publish a release at least every 150 days: both manifests expire 180 days after the
  latest release's tag.
- Never publish a stable release by hand, or with `make_latest: false`: apps read both
  manifests only through `/releases/latest`.

The public allowlist is exactly:

- `Agent-Inbox-vX.Y.Z-universal.dmg`, or `Agent-Inbox-vX.Y.Z-arm64.dmg` for an arm64 release
- `Agent-Inbox-vX.Y.Z-linux-x86_64.AppImage`
- `Agent-Inbox-vX.Y.Z-linux-arm64.AppImage`
- `agent-inbox_X.Y.Z_amd64.deb`
- `agent-inbox_X.Y.Z_arm64.deb`
- `SHA256SUMS.txt`
- `update-manifest.json`
- `update-manifest.json.sig`
- `update-manifest-v2.json`
- `update-manifest-v2.json.sig`

The protected workflow grants `contents: write` only to the final publication job.
Every earlier checkout sets `persist-credentials: false` and every earlier job has
`contents: read` and `actions: read`. The write job contains no third-party action or
checkout and exactly one trusted shell step; the write-scoped `github.token` exists only
in that step. `SHA256SUMS.txt` continues to cover only the five binary packages; the
manifests and signatures are independently bound by Ed25519 and SHA-256 evidence.

### One-time operator prerequisites

Before pushing a release tag, configure the repository's `macos-release` environment:

1. Require reviewer approval, prevent self-review, disable administrator bypass if the
   repository plan supports it, and allow only the protected default branch. The
   credentialed workflow is a default-branch `workflow_run`; the unprivileged producer,
   not the environment deployment, owns the `v*.*.*` tag trigger.
2. Add a repository ruleset for `refs/tags/v*` that restricts tag updates and deletions
   after creation. The publisher still peels the remote annotated tag immediately before
   draft creation and again immediately before undrafting, but immutable release tags
   close the remaining between-request race and protect published source links afterward.
3. Add these environment **secrets**:

   | Name | Format |
   | --- | --- |
   | `APPLE_DEVELOPER_ID_P12_BASE64` | Canonical base64 of a password-protected P12 containing the Developer ID Application certificate and private key |
   | `APPLE_DEVELOPER_ID_P12_PASSWORD` | P12 export password |
   | `APPLE_NOTARY_PRIVATE_KEY_BASE64` | Canonical base64 of the App Store Connect Team API `.p8` PEM |
   | `AGENT_INBOX_UPDATE_PRIVATE_KEY_BASE64` | Canonical base64 of the Ed25519 PKCS#8 PEM whose public SPKI matches the `signingKeyId` entry of `release/update-keys.json` |

4. Add these environment **variables**:

   | Name | Format |
   | --- | --- |
   | `APPLE_DEVELOPER_IDENTITY` | Exact `Developer ID Application: Name (TEAMID1234)` identity |
   | `APPLE_TEAM_ID` | Ten-character Apple Developer Team ID matching the identity |
   | `APPLE_NOTARY_KEY_ID` | App Store Connect Team API Key ID |
   | `APPLE_NOTARY_ISSUER_ID` | App Store Connect Team API Issuer UUID |
   | `AGENT_INBOX_UPDATE_KEY_ROTATION_OVERRIDE` | Normally unset; emergency rotation only: `ALLOW-UPDATE-KEY-ROTATION:vX.Y.Z:ed25519-<derived-id>`. It also waives G10 for that release, which cuts apps from 1.2 to 1.6 off (see "The backup update key" below) |

Signature-envelope schema 1 is ready for safe overlap rotation, but the current protected
signer intentionally accepts one secret and emits one signature. **Do not change
`signingKeyId` for routine rotation with this workflow.** A future rotation change must
first extend the protected signer to receive both keys without exposing either, publish
manifests signed by both old and new keys, and keep dual-signing every release while the
supported upgrade floor can still include clients that pin only the old key. Verification
then lets a client skip individual overlap builds and still authenticate a later
dual-signed release. Stop emitting the old signature and remove its public key only when
those clients are explicitly outside the supported direct-upgrade floor.

Apps from 1.2 to 1.6 trust only `ed25519-99927ba2f6af6482`, and they read
`update-manifest.json` for as long as it is published, which is for good. So every
`update-manifest.json` must carry a valid signature from that key (G10): the signer refuses
to touch the private key otherwise, and the publish job checks the signed envelope against
its own pinned copy of the key. A routine rotation therefore keeps the original key signing
`update-manifest.json`. Only the exact rotation override waives G10, for one release: the
signer records the waiver in the signing evidence, and the publish job requires that record
and the same override in the variable it receives.

Use the minimum App Store Connect role Apple documents for Developer ID notarization.
Do not paste, request, or store any P12, password, private key, or encoded credential in
the repository, an issue, workflow logs, or release assets. The environment does not
need to be created through the API; creating and reviewing it in repository Settings
keeps the protection policy explicit.

The workflow uses current `xcrun notarytool` Team API authentication (`--key`,
`--key-id`, and `--issuer`) and `--wait`. Each private key is decoded into a mode-0600
temporary directory for one submission and removed by a shell trap. Each P12 is deleted
immediately after import; the generated keychain is deleted in an `if: always()` step.
The update signer does not materialize its private key: one Node process decodes the
environment value, derives and checks the public key, signs, and clears mutable key buffers
on every path. No credential value is written to argv, logs, job output, or an artifact.

### The backup update key

`release/update-keys.json` lists two public keys (#342):

| Key | Role |
| --- | --- |
| `ed25519-99927ba2f6af6482` | The original key, and `signingKeyId`: it signs every release. Apps from 1.2 to 1.6 trust only this key |
| `ed25519-c8adddea0de080d6` | The backup key. It signs nothing. Its private half lives only in the owner's private 1Password vault, Document item "Agent Inbox backup update key" |

Every manifest from 1.7.0 on lists both ids in `trustedKeyIds` and carries one signature,
from the original key. Apps from 1.2 to 1.6 still verify it, because their readers never
compare `trustedKeyIds` with the keys they hold (`test/shipped-updaters.test.ts` runs
them). Every app from 1.7.0 on trusts both keys, including Intel Macs that stay on
1.x-last for good.

The backup key is for an emergency only: the original key is lost or compromised. A
routine rotation needs the dual-key signer (#148) instead, with the original key still
signing `update-manifest.json`.

**Emergency procedure,** for the release `vX.Y.Z` that switches to the backup key. Step 1
checks the key and step 4 the override before the tag exists: the sign job would otherwise
catch a wrong one only after notarization, when the tag is already spent.

1. Put the backup key into the `AGENT_INBOX_UPDATE_PRIVATE_KEY_BASE64` secret for this
   release. These lines read the key from 1Password once, never write it to disk, and
   upload it only if its key id is `c8adddea0de080d6`, because `gh secret set` would store
   even an empty value:

   ```sh
   KEY_B64="$(op document get "Agent Inbox backup update key" | base64 | tr -d '\n')"
   test "$(printf '%s' "$KEY_B64" | base64 -d | openssl pkey -pubout -outform DER | shasum -a 256 | cut -c1-16)" = c8adddea0de080d6 \
     && printf '%s' "$KEY_B64" | gh secret set AGENT_INBOX_UPDATE_PRIVATE_KEY_BASE64 --env macos-release --repo shariqh/agent-inbox \
     || echo 'NOT SET: wrong key, unreadable item, or LibreSSL openssl' >&2
   unset KEY_B64
   ```

   NOT SET leaves the secret as it was. The key was wrong, the item couldn't be read (a
   dismissed unlock prompt or an expired session gives nothing), or `openssl` can't read
   Ed25519 keys: macOS's own `/usr/bin/openssl` (LibreSSL) can't, so put OpenSSL 3 or
   later, such as Homebrew's, first on your `PATH` and run the lines again.

   If the 1Password CLI can't read the item, make a private folder for it instead:

   ```sh
   KEYDIR="$(mktemp -d)" && echo "$KEYDIR"
   ```

   Save the document from the 1Password app into that folder as `backup-update-key.pem`.
   Then run the same lines with only the first one changed, and delete the folder:

   ```sh
   KEY_B64="$(base64 < "$KEYDIR/backup-update-key.pem" | tr -d '\n')"
   test "$(printf '%s' "$KEY_B64" | base64 -d | openssl pkey -pubout -outform DER | shasum -a 256 | cut -c1-16)" = c8adddea0de080d6 \
     && printf '%s' "$KEY_B64" | gh secret set AGENT_INBOX_UPDATE_PRIVATE_KEY_BASE64 --env macos-release --repo shariqh/agent-inbox \
     || echo 'NOT SET: wrong key, unreadable item, or LibreSSL openssl' >&2
   unset KEY_B64
   rm -rf "$KEYDIR"
   ```

2. In the release commit, change `signingKeyId` in `release/update-keys.json` to
   `ed25519-c8adddea0de080d6`. Keep both keys listed: the signer verifies the release
   before's manifests, which the original key signed, under this release's keys. The same
   commit updates the tests that pin the signing key: `test/update-manifest.test.ts`,
   `test/update-trust.test.ts`, `test/release-aggregation.test.ts`,
   `test/release-pipeline.test.ts` and `test/linux-native-folder.test.ts`. Most only name
   the key, but some assertions invert: "passes G10 with the original key's signature
   alone" becomes an expected refusal unless the exact override is passed, and the tests
   that say the original key signs must say the backup key does. Other tests find the
   backup key by its id and keep passing.
3. In one shell for the rest of the procedure, set the tag once, then set the
   `macos-release` environment variable `AGENT_INBOX_UPDATE_KEY_ROTATION_OVERRIDE` from it.
   The sign job and the publish job both read it. A repository variable of the same name
   also works, but the environment's takes precedence. Keep the braces in `${TAG}`: zsh,
   macOS's default shell, reads `$TAG:e…` as a modifier and would store the wrong string.

   ```sh
   TAG=vX.Y.Z
   gh variable set AGENT_INBOX_UPDATE_KEY_ROTATION_OVERRIDE --env macos-release --repo shariqh/agent-inbox \
     --body "ALLOW-UPDATE-KEY-ROTATION:${TAG}:ed25519-c8adddea0de080d6"
   ```

4. Before tagging, check the variable against the exact string:

   ```sh
   test "$(gh variable get AGENT_INBOX_UPDATE_KEY_ROTATION_OVERRIDE --env macos-release --repo shariqh/agent-inbox)" \
     = "ALLOW-UPDATE-KEY-ROTATION:${TAG}:ed25519-c8adddea0de080d6" && echo 'override OK' || echo 'override WRONG' >&2
   ```

   Only after `override OK`, tag the release commit and push the tag with the same `$TAG`,
   in place of the release runbook's tag commands, so the override names exactly the tag
   that's pushed:

   ```sh
   git tag -a "${TAG}" -m "Agent Inbox ${TAG}"
   git push origin "${TAG}"
   ```

5. Once the release is published, delete the secret and the variable:

   ```sh
   gh secret delete AGENT_INBOX_UPDATE_PRIVATE_KEY_BASE64 --env macos-release --repo shariqh/agent-inbox
   gh variable delete AGENT_INBOX_UPDATE_KEY_ROTATION_OVERRIDE --env macos-release --repo shariqh/agent-inbox
   ```

What it cuts off: G10 is waived. `update-manifest.json` then carries no signature from the
original key, the only key apps from 1.2 to 1.6 trust, so those apps lose updates for good:
every check fails, and their users have to install a newer release by hand. Apps from 1.7.0
on keep updating through both manifests.

After the emergency release:

- Every later release is signed by the backup key too, so it repeats steps 1, 3, 4 and 5
  with its own tag: G10 can't pass again, and an override names one release. G10 then
  protects nobody, because apps from 1.2 to 1.6 can never verify an update again; retiring
  it in a reviewed change is the permanent alternative to an override on every later
  release.
- If the original key was compromised rather than lost, remove it from `keys` in the
  release after the emergency one, so the apps that release ships stop trusting it; apps
  installed before then still do. The emergency release itself must keep it (step 2).
- No backup is left. Add a new backup public key the same way before relying on this
  procedure again.

### Release runbook

1. Confirm the portable-runtime and universal-package prerequisite changes are merged,
   the default branch is green, and `package.json` plus both lockfile version fields are
   the intended `X.Y.Z`.
2. Run the no-secret gates locally:

   ```sh
   fnm exec --using=24 npm run package:smoke
   fnm exec --using=24 npm test
   fnm exec --using=24 npm run typecheck
   fnm exec --using=24 npm run build
   ```

3. Create an **annotated** tag on the reviewed release commit and push that exact tag:

   ```sh
   git tag -a vX.Y.Z -m "Agent Inbox vX.Y.Z"
   git push origin vX.Y.Z
   ```

4. Review the `macos-release` deployment when GitHub requests approval. Confirm the
   producer run ID, annotated tag, upstream `head_sha`, protected workflow SHA, and
   first-parent relationship before approving each protected stage.
5. Require all jobs to finish. Do not treat an uploaded Actions artifact, provisional
   package, or private draft release as published success.
6. CI already mounts the final DMG and validates a copied app, Setup runtime lifecycle,
   and loopback launch in disposable state. Separately, on a clean Apple-silicon Mac and
   a clean Intel Mac, download the public DMG in a browser so quarantine is present, copy
   the app to `/Applications` in Finder, launch it from Finder, run in-app Setup, and
   confirm a later offline launch. This clean-Mac browser/Finder/quarantine check cannot
   be replaced by CI; keep issue #74 open until both checks pass with real credentials.

### Failure recovery

- The immutable annotated `v1.0.0` tag remains at its original commit after the
  pre-publication signing failure. Recover only from the corrected source as `v1.0.1`;
  never move, replace, or delete `v1.0.0`.
- A failure before publication creates no GitHub Release.
- Draft creation uses the Releases API response directly; no second tag lookup is trusted
  to discover ownership. Its private machine marker binds schema, tag, source commit/tree,
  producer run ID/attempt, and the aggregate inventory digest. Cleanup GETs only that
  captured numeric ID and deletes it only while the ID, tag, draft state, unique staging
  title, complete marker, and current annotated-tag source still match this run. A missing,
  replaced, or edited draft is retained rather than deleting another operator's release.
- Immediately before the final publication PATCH, the job crosses an explicit
  publication-attempted boundary. After that point it never auto-deletes the release,
  including after a transport-ambiguous response; the numeric ID/tag are retained as
  recovery evidence for an exact-match rerun.
- Final public notes carry a non-rendering machine marker with the same source/run/inventory
  identity. An exact already-public rerun requires that marker, downloads and re-verifies
  the full inventory, and exits as a no-op. Any existing draft or conflicting public
  marker, asset, metadata, byte, or checksum fails closed without mutation.
- A signing, Intel, notarization, stapling, Gatekeeper, provenance, or checksum failure
  cannot reach publication because every downstream job has a hard `needs` dependency.
- Stapling starts only after Apple has accepted the submission, and only fetches and
  checks the ticket through Apple's CloudKit ticket service. Every `xcrun stapler` call in
  the Notarize job therefore runs through one retry helper, `runStapler()` in
  `scripts/macos-release-gates.mjs`: the app and DMG `staple`/`validate` in
  `scripts/notarize-macos.sh`, and the `stapler validate` checks in `build-dmg`,
  `verify-final-dmg` and `final-evidence`. Each call gets up to five attempts with 15,
  30, 60 and 120 second waits, but only when stapler's output shows a dropped connection
  to that service (`NSURLErrorDomain`, `network connection`,
  `CloudKit's response is inconsistent`) or a ticket Apple has not published yet
  (`Record not found`). Every attempt's output stays in the log. Any other stapler
  failure, or a fifth transient one, fails the step with stapler's own output and exit
  status. The protected jobs run the tagged commit's scripts, so a re-run of an older
  tag does not gain this retry.
- An incomplete prior manifest pair (either manifest), invalid previous signature, unknown
  signing key, missing signed `trustedKeyIds` authorization, a v2 manifest that is not what
  the release evidence gives, a measured macOS kind that disagrees with the expected set,
  a re-stamp that does not describe the newest universal release, or a v1 manifest that the
  original key would not sign (G10) fails before the new private key is exposed.
  Do not set the rotation override or change `signingKeyId` for routine releases with the
  current one-key signer. The override is an audited emergency action bound to one exact
  tag and derived key id; using it accepts that clients without the new pinned key may need
  a manual update. Routine rotation requires first implementing the dual-key signing
  extension and overlap sequence above. The emergency procedure is under "The backup update
  key" above.
- An unrelated default-branch advance after the tag is accepted when the tag remains on
  first-parent history. If trusted release tooling or pinned packaging inputs changed
  incompatibly before protected preflight, the handoff fails before credentials are
  available; increment the version and create a new annotated tag after reconciling the
  release inputs.
- Do not retry by hand-uploading an artifact or by using Layer 2's provisional DMG.
  Correct the source/configuration, increment the package version, and create a new
  annotated tag. Never move or replace a published release tag.
- Apple notary request IDs and the sanitized allowlisted receipt fields are retained in
  release evidence. Raw logs and API private keys remain temporary. Use the request ID
  in App Store Connect or rerun `notarytool log` from a secured operator machine when
  diagnosing an Apple rejection.

### Download verification

From a directory containing `SHA256SUMS.txt` and the selected asset, verify only that
asset's exact manifest entry (running the manifest wholesale requires downloading all
five packages):

```sh
ASSET=Agent-Inbox-vX.Y.Z-universal.dmg   # or Agent-Inbox-vX.Y.Z-arm64.dmg
grep -F "  $ASSET" SHA256SUMS.txt | shasum -a 256 -c -
xcrun stapler validate "$ASSET"
spctl --assess --type open --context context:primary-signature --verbose=4 \
  "$ASSET"
```

Each `.sig` authenticates the exact UTF-8 bytes of its manifest (`update-manifest.json` or
`update-manifest-v2.json`); reformatting or reserializing the JSON invalidates every
signature. Each reader fetches only its own file and requires its own `schema` inside the
signed bytes, so neither can take the other's manifest for its own.
Its canonical key-id-sorted signature array permits old+new overlap during key rotation;
verification structurally validates every entry, ignores cryptographic entries for keys
that this installed client does not pin, and succeeds only when at least one entry validates
under a pinned trusted key. An envelope containing only unknown keys still fails. This is
what lets an old-key client authenticate an old+new dual-signed release before it installs
the expanded registry.
`publishedAt` is the annotated tagger timestamp normalized to UTC whole seconds, never the
workflow clock; `expiresAt` is deterministically 180 days later. The signer refuses an
already-expired manifest, while previous-release continuity checks intentionally verify
historical structure/signatures without applying current-time expiry so expiry cannot
prevent a fix-forward release.
Agent Inbox 1.3 and later also persist the highest release version whose manifest they
verified and report any older signed manifest as stale instead of offering it; from 1.7.0
on they keep one mark per manifest, and a v2 manifest is stale below the higher of the two.
Marking an older release as GitHub's latest therefore cannot roll those clients back;
retract a bad release by publishing a newer fixed version.
Each signed manifest contains the SHA-256 values and byte lengths of the packages it lists,
but it does not replace the package-only `SHA256SUMS.txt` command above.

After mounting the DMG, the app must also pass:

```sh
codesign --verify --deep --strict --verbose=2 "/Volumes/Agent Inbox/Agent Inbox.app"
xcrun stapler validate "/Volumes/Agent Inbox/Agent Inbox.app"
spctl --assess --type execute --verbose=4 "/Volumes/Agent Inbox/Agent Inbox.app"
```

These commands follow Apple's current notarization/stapling flow, Electron's current
Developer ID and hardened-runtime guidance, and GitHub's protected-environment model.

## Dependency updates

Every third-party action in the release workflow is pinned to a reviewed full commit
SHA with its release version in a trailing comment. Dependabot checks the
`github-actions` ecosystem weekly; updates require reviewing the upstream action
release and retaining the full-SHA form. `actions/setup-node` receives its exact Node
version from the validated `release/macos-inputs.json` CLI output, never from a floating
major version in workflow YAML.
