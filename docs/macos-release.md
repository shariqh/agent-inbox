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
`https://nodejs.org/dist/v24.19.0/SHASUMS256.txt` distribution metadata. Runtime
staging rejects any hash, URL, archive root, platform, ABI, or architecture mismatch.

## Architecture pipeline

`.github/workflows/macos-universal.yml` uses native macOS runners:

1. Stage and self-test the arm64 and x64 Node runtime payloads independently.
2. Restore both verified payloads into each native thin Electron build.
3. Rebuild `better-sqlite3` for Electron 43.1.1 on that architecture.
4. Preserve each thin app with a tar archive so framework symlinks and executable
   modes survive artifact transfer.
5. Merge the thin apps with `@electron/universal`. The two
   `Contents/Resources/app/runtime/darwin-*` trees are excluded from `lipo`; Electron,
   helpers, frameworks, and `better_sqlite3.node` must be universal.
6. Run a second, native Intel job against the finalized signed x64 runtime and
   publish its verification record beside the provisional universal artifact.

Set `SOURCE_DATE_EPOCH` to the source commit time for repeatable `setup-info.json`
metadata. No build script downloads an unpinned `latest` tool or Node archive.
The app and each portable runtime carry the project MIT notice as
`LICENSE.agent-inbox`; the runtime keeps Node's separate upstream notice as `LICENSE`.
The signed app also preserves Electron's upstream `LICENSE.electron` and
`LICENSES.chromium.html` under `Contents/Resources`.

## Finalization order

`scripts/assemble-macos-release.mjs` enforces this order:

1. Finish the merged app layout and mark it provisional.
2. Sign every Mach-O in both portable runtime trees.
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

## Dependency updates

Every third-party action in the release workflow is pinned to a reviewed full commit
SHA with its release version in a trailing comment. Dependabot checks the
`github-actions` ecosystem weekly; updates require reviewing the upstream action
release and retaining the full-SHA form. `actions/setup-node` receives its exact Node
version from the validated `release/macos-inputs.json` CLI output, never from a floating
major version in workflow YAML.
