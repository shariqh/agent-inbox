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

**Requires macOS 13.5 (Ventura) or later.** Release builds support both Apple silicon and
Intel. Electron 43 itself supports macOS 12, but the bundled official Node 24 runtime
requires macOS 13.5, so the shipped product must use the stricter minimum. Revisit the
stated minimum before updating either pinned major.

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

Package smoke exercises the shipped `scripts/setup-filesystem.cjs` through runtime
install/prune and the build-time publisher. It proves the same-parent identity/staging path
on native macOS, including full manifest and mode verification before publication. The
Win32 drive, namespace, ADS, case, junction, and rename-failure cases are injected policy
models only; they are not native Windows release evidence and do not widen the Darwin-only
release profile.

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
   require a distinct `Accepted` DMG ticket before stapling and validating the DMG.
6. Inspect the DMG's exact Developer ID authority and Team ID, mount the final post-staple
   DMG read-only, require its expected app/Applications-link shape, and copy the transported
   app with `ditto` into clean temporary storage. Verify the copied app's signature,
   authority/team, staple, Gatekeeper assessment, universal executable/addon, both runtime
   manifests and architectures, source/version/setup metadata, icon, and notices. Launch
   that copied app under a disposable `HOME`, require its hardened loopback marker, and
   exercise portable-runtime install and prune without touching production
   `~/.agent-inbox`. Detach the DMG even when any check fails.
7. Generate the macOS-only internal checksum only after mounted-copy acceptance and from
   the final post-staple DMG bytes.
8. In an unprivileged aggregation job, revalidate the four exact-run Linux package
   artifacts and reports, combine their final bytes with the notarized DMG, and generate
   the canonical `SHA256SUMS.txt` from all five binary packages in ascending bytewise
   filename order.
9. Revalidate the complete aggregate evidence and exact six-file public allowlist.
   Immediately before draft creation, the sole write-token step re-reads the remote tag
   ref, requires an annotated tag object, peels it to a commit, and requires that commit
   to remain the authorized source commit. Publication starts as a private draft with
   neutral staging metadata. After upload it validates exact remote names, uniqueness,
   nonzero sizes, and API SHA-256 digests when present; it then always downloads all six
   assets, compares every byte with the protected handoff, and rehashes all five packages
   through the downloaded checksum manifest. Only one final API update installs the public
   title/notes and clears the draft bit.

The public allowlist is exactly:

- `Agent-Inbox-vX.Y.Z-universal.dmg`
- `Agent-Inbox-vX.Y.Z-linux-x86_64.AppImage`
- `Agent-Inbox-vX.Y.Z-linux-arm64.AppImage`
- `agent-inbox_X.Y.Z_amd64.deb`
- `agent-inbox_X.Y.Z_arm64.deb`
- `SHA256SUMS.txt`

The protected workflow grants `contents: write` only to the final publication job.
Every earlier checkout sets `persist-credentials: false` and every earlier job has
`contents: read` and `actions: read`. The write job contains no third-party action or
checkout and exactly one trusted shell step; the write-scoped `github.token` exists only
in that step.

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

4. Add these environment **variables**:

   | Name | Format |
   | --- | --- |
   | `APPLE_DEVELOPER_IDENTITY` | Exact `Developer ID Application: Name (TEAMID1234)` identity |
   | `APPLE_TEAM_ID` | Ten-character Apple Developer Team ID matching the identity |
   | `APPLE_NOTARY_KEY_ID` | App Store Connect Team API Key ID |
   | `APPLE_NOTARY_ISSUER_ID` | App Store Connect Team API Issuer UUID |

Use the minimum App Store Connect role Apple documents for Developer ID notarization.
Do not paste, request, or store any P12, password, private key, or encoded credential in
the repository, an issue, workflow logs, or release assets. The environment does not
need to be created through the API; creating and reviewing it in repository Settings
keeps the protection policy explicit.

The workflow uses current `xcrun notarytool` Team API authentication (`--key`,
`--key-id`, and `--issuer`) and `--wait`. Each private key is decoded into a mode-0600
temporary directory for one submission and removed by a shell trap. Each P12 is deleted
immediately after import; the generated keychain is deleted in an `if: always()` step.
No credential value is written to a job output or artifact.

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
- A publication upload or remote asset mismatch removes only the private draft created by
  that run, using its recorded numeric release ID, and leaves the annotated tag unchanged.
- Cleanup first re-reads the release state. It never deletes a release that may already
  have become public after a transport-ambiguous final API response. If state cannot be
  proven or draft deletion fails, the release is retained with its numeric ID in the failed
  run; subsequent reruns refuse that draft until an operator resolves it.
- An exact already-public rerun downloads and re-verifies the full inventory and exits as
  a no-op. Any existing draft or conflicting public asset, metadata, byte, or checksum
  fails closed without mutation.
- A signing, Intel, notarization, stapling, Gatekeeper, provenance, or checksum failure
  cannot reach publication because every downstream job has a hard `needs` dependency.
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
ASSET=Agent-Inbox-vX.Y.Z-universal.dmg
grep -F "  $ASSET" SHA256SUMS.txt | shasum -a 256 -c -
xcrun stapler validate "$ASSET"
spctl --assess --type open --context context:primary-signature --verbose=4 \
  "$ASSET"
```

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
