# Design: Update manifest v2 and the Intel hand-off (issue #295)

**Date:** 2026-10-23
**Status:** Proposal for review. Eight decisions for Shariq are in §10.
**Milestone:** v1.7. Refs #295. Prepares #296 (v2.0: a macOS build for Apple silicon only), which
follows the #281 decision that there is no Intel Mac release going forward.
**Scope of this PR:** this document only. No source, test or workflow changes.

---

## §0 — Summary

Every installed app from 1.2.0 to 1.6.0 reads one signed file, `update-manifest.json`, from
whichever release GitHub marks latest. It accepts that file only when it lists exactly today's
five targets, and the only macOS target is a universal DMG. A build without Intel support can't
be described in that file. Listing an arm64-only DMG under the universal name would install an
app that can't open on an Intel Mac. Any other target set makes these apps reject the whole
file, Linux included.

Recommended design:

1. **A second manifest, `update-manifest-v2.json`,** is published in every release from 1.7.0
   on. It is signed with the same key, uses the same signature envelope and lasts the same 180
   days. Its schema allows an arm64 DMG, and readers skip target types they don't know, so a
   later target (Windows, #85 and #87) doesn't need a third manifest.
2. **`update-manifest.json` stays in every release.** While releases are universal it describes
   the release, with the same bytes as today. From 2.0.0 on it describes the last universal 1.x
   release (called **1.x-last** below). Each release re-signs that description with a fresh
   `publishedAt`, so it doesn't expire while releases continue. The rule is simple: the v1
   manifest always describes the newest universal release.
3. **1.7.0 and every later version read v2.** An arm64-only build is never downloaded or
   installed by an app running on an Intel Mac or under Rosetta. Such an app also reads v1, to
   find the newest universal release: it offers that one if it is newer, and otherwise shows
   plain copy saying the update needs a Mac with Apple silicon. Installer feasibility,
   `prepare()` and a check of the staged app's CPU types repeat the rule.
4. **Each manifest keeps its own rollback mark,** so the frozen v1 manifest never reads as
   stale, even after a downgrade.
5. **The publisher derives the v1 manifest in trusted code:** from the v2 manifest in a
   universal release, or by re-signing the previous release's verified v1 manifest in an arm64
   release. Three new gates: v2 must be published before any arm64 release, no release may drop
   a manifest once it exists, and a re-signed copy must match the assets actually published for
   1.x-last. The protected workflow keeps its jobs, secret, permissions and draft-then-publish
   protocol.

Sequence: 1.7.0 ships the client half and starts the v2 manifest, still universal. Later 1.x
releases stay universal. 2.0.0 ships the arm64 DMG and freezes v1 (#296). Apps from 1.2 to 1.6
reach 1.x-last and continue from there. Intel Macs stay on 1.x-last with clear copy. Linux keeps
updating; apps from 1.2 to 1.6 take one extra hop through 1.x-last.

---

## §1 — Current state

Line numbers refer to `main` at `cd1da760`. Statements marked *probed* were checked on
2026-10-23. Manifest behaviour: a throwaway script, run under Node 24.18.0 with a scratch
signing key, built and signed manifests with `scripts/update-manifest.mjs` and called
`checkForUpdate` with a fake `fetch`; it was deleted afterwards. File facts: `git show
<tag>:<file>` with `shasum`, and a header read of the installed 1.x app.

### 1.1 Who reads the manifest, and from where

- Every app since 1.2.0 fetches
  `https://github.com/shariqh/agent-inbox/releases/latest/download/update-manifest.json`, then
  the same path with `.sig` (`electron/update-fetch.cjs:9-10`). A redirect may go only to a
  `github.com` path `/releases/latest/download/<name>` or `/releases/download/vX.Y.Z/<name>`,
  where `<name>` is the file being fetched, or to a GitHub release-asset host (`:16`,
  `:30-55`). Nothing ties the release a manifest was served from to the tag inside it.
  *Probed:* a signed 1.9.0 manifest served through
  `/releases/download/v2.0.0/update-manifest.json` is accepted, and a 1.5.0 app is offered
  `…/releases/download/v1.9.0/Agent-Inbox-v1.9.0-universal.dmg`.
- The publish job's final `PATCH` sends only the name, the notes and `draft: false`
  (`.github/workflows/macos-release-protected.yml:1402-1413`). GitHub's REST description gives
  `make_latest` a default of `true` for newly published releases, so every published release
  becomes latest. A file missing from the latest release fails the check for every app.
- Readers in the field (SHA-256 prefixes of the files at each tag, from `git show <tag>:<file>`):

| Installed | `update-manifest.cjs` | `update-fetch.cjs` | Rollback mark | Download and install |
| --- | --- | --- | --- | --- |
| 1.2.0–1.2.8 | `5ce1d675…` | `d31aeadc…` | no | notify only |
| 1.3.0–1.6.0 | `5ce1d675…` (same bytes) | `85d1195b…` | yes (#148) | verified download, then DMG or AppImage install (#196) |

`update-manifest.cjs` is byte-identical from v1.2.0 to `main`, and these are the only two
shipped versions of `update-fetch.cjs`.

### 1.2 What a v1 reader accepts

- `schema` must be 1, the top-level keys are exact, and `expiresAt` must be exactly 180 days
  after `publishedAt` (`electron/update-manifest.cjs:17-20`, `:327-349`).
- `targets` must hold exactly the five `TARGET_SPECS`, in order, each with a fixed filename and
  canonical URL (`:53-89`, `:257-306`, `:381-401`). The only macOS entry is
  `darwin/universal/dmg`, named `Agent-Inbox-<tag>-universal.dmg`.
- The envelope's `schema` is compared with the same constant as the manifest's (`:460`), so a
  v2 manifest can't simply raise that constant.
- Order of checks: the digest, then a signature from a pinned key (entries from unknown keys are
  skipped), then the schema, then freshness. A manifest is rejected at or after `expiresAt`, or
  when `publishedAt` is more than five minutes ahead (`:35`, `:528-578`).
- *Probed:* relabelling the macOS target `arm64` fails with "unrecognized
  platform/architecture/packageType combination". Adding a sixth target or dropping one fails
  with "must contain exactly 5 entries". `schema: 2` fails, and so does an envelope with
  `schema: 2`.

### 1.3 How a reader picks its target

- On macOS the reader always picks `darwin/universal/dmg`, whatever `process.arch` is
  (`electron/update-fetch.cjs:292-313`). Linux picks by architecture and the AppImage proof. No
  target for the host gives `unsupported` (`:379-387`).
- Nothing checks the architecture before an install. Feasibility checks the platform, the
  minimum macOS version, the bundle's location, owner and permissions
  (`electron/update-install-macos.cjs:503-543`). `prepare()` checks the staged copy's bundle
  identity, code signature and Gatekeeper assessment (`:392-416`, `:545-605`).
- On macOS the installer is registered only when the app started and owns its viewer
  (`electron/main.cjs:961-963`). Without an installer the controller leaves a verified offer
  downloadable (`electron/update-controller.cjs:418`, `:483-484`). So an architecture rule that
  lived only in installer feasibility would still let an Intel Mac download an arm64 DMG.

### 1.4 The rollback mark (#148)

- `checkForUpdate` records each verified version, then returns `stale` when the manifest is
  older than the stored mark (`electron/update-fetch.cjs:370-378`). The mark is
  `highestVerifiedVersion` in `userData/update-trust-state.json`. Readers ignore other fields
  and keep them when they raise the mark (`electron/update-preferences.cjs:66-81`, `:244-256`).
  An install re-reads the mark first (`electron/update-controller.cjs:647-660`, `:689`).
- *Probed:* a 1.5.0 app whose mark is 2.0.0 reads a valid 1.9.0 manifest as `stale`.

### 1.5 Failure and notify-only paths

- A missing file (`electron/update-fetch.cjs:204`) or an expired manifest
  (`electron/update-manifest.cjs:573`) makes the check throw, which ends in the `unverified`
  state (`electron/update-controller.cjs:568-570`), shown as "Couldn’t check right now. You can
  review Releases manually." (`public/app.js:8544`). *Probed:* once the
  manifest has expired, the 1.5.0 app's check throws "manifest has expired".
- A notify-only offer carries `available.reason`, shown under the status line
  (`electron/update-controller.cjs:481-498`, `public/app.js:8575-8578`). The preload accepts a
  reason only on an offer that is neither downloadable nor installable
  (`electron/setup-preload.cjs:157-176`).
- Scheduled checks send one native notification per version, whether or not the offer can be
  installed (`electron/update-controller.cjs:340-358`, `:564-566`; copy in
  `electron/main.cjs:939-951`).

### 1.6 The publisher

- **Aggregation** (an unprivileged job running the release's own code) builds
  `update-manifest.json` from the package evidence, the annotated tag's time and the release's
  key registry. Its macOS evidence must be universal (`scripts/release-aggregation.mjs:504-543`,
  `:624-644`).
- **`sign-update-manifest`** runs trusted default-branch code in the protected environment
  (`.github/workflows/macos-release-protected.yml:548-778`). It reads the registry from the
  release's commit (`:584`) and checks the unsigned manifest against the release: tag, version,
  source, `publishedAt` equal to the tag time, and key ids (`:586-617`). It lists every release
  (`:619`) and plans history (`scripts/update-manifest.mjs:372-445`). Every earlier stable
  release must be older than the new tag (`:398-400`), no release may carry half a pair
  (`:401-405`), and a first manifest ("bootstrap") is allowed only when no earlier release has
  either file (`:409-423`). It downloads the latest earlier pair by asset id and checks sizes
  and digests (`.github/workflows/macos-release-protected.yml:656-673`). `authorize-history`
  verifies that pair without the expiry check and requires the new signing key in its
  `trustedKeyIds`, or the exact rotation override (`scripts/update-manifest.mjs:447-476`). The
  earlier manifest's tag must equal the planned earlier tag (workflow `:692`). One process then
  signs one manifest (`:703-715`).
- So the rule "the publisher won't sign a version that isn't newer" is really two rules: tags
  must increase (history), and the manifest must describe this release (the sign and publish
  jobs). *Probed:* history refuses v1.9.0 when v2.0.0 is published.
- **`publish`** is the only job with write access, and it has no checkout. It lists the exact
  asset names in four places (`:905-917`, `:1154-1160`, `:1290-1299`, `:1327-1337`) and checks
  the manifest independently against the five expected targets (`:918-1117`). Then it creates a
  draft, uploads, downloads and compares, and publishes by clearing the draft flag
  (`:1366-1422`).
- **Keys:** one key, `ed25519-99927ba2f6af6482` (`release/update-keys.json`). The signer emits
  one signature, and routine rotation waits for protected dual-key signing
  (`docs/macos-release.md:365-372`).

### 1.7 What this means for #295

1. An app from 1.2 to 1.6 must only ever be offered a release whose macOS package is universal.
2. Every release becomes latest, so every release must carry a v1 manifest those apps accept.
   Without one they show "Couldn't check right now" for good.
3. A v1 manifest can only describe a universal release, so from 2.0.0 on it must describe an
   older release. That needs a narrow exception to "the manifest describes this release".
4. That older version must never look stale to an app that reads v1. One shared mark can't
   promise that (§1.4).
5. The architecture rule has to apply where the offer is built, not only in the installer (§1.3).

---

## §2 — Requirements

- **R1.** An app that reads only v1 is never offered a macOS package that isn't universal.
- **R2.** Apps from 1.2 to 1.6 keep working through the change, on every platform. Their last
  hop is 1.x-last, never a 2.x file.
- **R3.** 1.7.0 and every later version read a new manifest that allows an arm64 DMG.
- **R4.** On an Intel Mac or under Rosetta, an arm64-only build is never downloaded or
  installed, whatever installer is registered. The offer stays notify-only, with plain copy.
- **R5.** Linux keeps updating normally throughout.
- **R6.** Expiry, rollback marks and key continuity keep their guarantees. Any exception is
  narrow, written down and tested.
- **R7.** The protected workflow changes as little as possible: no new job, secret,
  environment, permission or third-party action; the same draft-then-publish protocol; the
  private key still reaches exactly one process.
- **R8.** A later target, such as Windows, doesn't need another manifest transition.
- **R9.** Tests pin every rule, including tests that run the reader code 1.2 to 1.6 shipped.

---

## §3 — Alternatives

### A. A second manifest, with a frozen v1 manifest re-signed in every release (recommended)

Every release from 1.7.0 carries both files. In a universal release both describe the release.
From the first arm64 release on, the v1 manifest describes 1.x-last: the signer copies the
previous release's verified v1 manifest and changes only `publishedAt`, `expiresAt`,
`signingKeyId` and `trustedKeyIds`. This document calls that a **re-stamp**.

- Apps from 1.2 to 1.6 are guided to 1.x-last for as long as a release ships at least every
  180 days.
- It needs one new signing rule: re-signing an older version's manifest, allowed only as an
  exact re-stamp.
- The v1 manifest needs a signature from the original key for as long as it is published
  (§9, risk 3; §10, decisions 6 and 7).

### B. A second manifest, with 1.x-last's v1 pair copied forward unchanged

Each arm64 release uploads 1.x-last's original `update-manifest.json` and `.sig`, byte for
byte.

- No new signing rule: the publisher only compares bytes and checks the original signature.
- The copy expires 180 days after 1.x-last's tag: 2027-07-03 if 1.x-last is tagged
  2027-01-04. From then on every app from 1.2 to 1.6 shows "Couldn't check right now". An Intel
  user who follows "review Releases" finds 2.x marked latest, and its DMG won't open on their
  Mac.

### C. Keep 1.x-last as GitHub's latest release

Publish 2.x with `make_latest: false`, so old apps keep reading 1.x-last's own files.

- 1.x-last's manifest still expires after 180 days, unless its files are replaced on a
  published release, which can't be done atomically.
- New apps need a second way to find 2.x: a channel release whose files are replaced each time,
  or a new host in the fetch allowlist.
- GitHub's Latest badge, `/releases/latest` and the README's links would show 1.x for good.

### Per-target versions in v2 (a variant of A, rejected)

v2 targets could each carry their own version, so a 2.x manifest would list 1.x-last's
universal DMG for Intel Macs and no app would need to read v1. Rejected: the rollback mark and
the install-time stale check compare one version per manifest
(`electron/update-controller.cjs:689`), so a 2.x mark would refuse a 1.x-last install. That
needs a new mark model, while the v1 manifest already says, signed, which release is the
newest universal one.

### Ruled out

- **An arm64-only DMG under the universal name.** It installs an app that can't open on an
  Intel Mac (R1).
- **A new target set in v1.** Every v1 reader rejects the whole manifest (§1.2).
- **A universal 2.x build.** It reverses the #281 decision.

### Comparison

| | A (recommended) | B | C |
| --- | --- | --- | --- |
| Apps from 1.2 to 1.6, after 2.0.0 | Offered 1.x-last while releases continue | Offered 1.x-last until 180 days after its tag, then "Couldn't check right now" | Offered 1.x-last until 180 days after its tag, unless published files are replaced |
| New signing rule | An exact re-stamp of the previous v1 manifest | None | None |
| A later key rotation | v1 needs the original key's signature while it is published | The copy stays signed by the original key | As A or B |
| GitHub's latest release and website links | Unchanged | Unchanged | Latest stays on 1.x |
| Publication protocol | Unchanged | Unchanged | Replaces files on a published release |
| Protected workflow change | Allowlists, evidence, one signing step for two files | The same, minus the re-stamp | The largest |

A separate long-lived channel for the v1 file doesn't help either. Old apps have one URL,
`releases/latest/download/update-manifest.json`, so any channel they can reach has to be the
release marked latest, which is option C.

---

## §4 — Recommended design

Below, **1.7.0** means the first release with the client half (planned for the v1.7
milestone), and **1.x-last** means the last universal 1.x release, whatever its number turns
out to be. Example numbers use 1.9.0 for 1.x-last.

### 4.1 Two manifests

| | v1 | v2 |
| --- | --- | --- |
| Files | `update-manifest.json`, `update-manifest.json.sig` | `update-manifest-v2.json`, `update-manifest-v2.json.sig` |
| Schema | 1 (unchanged) | 2 |
| Read by | 1.2.0 to 1.6.x; 1.7.0 and later only when the app isn't running as arm64 on a Mac and v2 offers only an arm64 DMG | 1.7.0 and later |
| Describes | The newest universal release | The newest release |
| Rollback mark | `highestVerifiedVersion` | `highestVerifiedVersionV2` |

### 4.2 Invariants

- **I1.** The v1 manifest in every release describes the newest published universal release.
  In a universal release that is the release itself. In an arm64 release it is a re-stamp of
  the previous release's v1 manifest.
- **I2.** The version in the v1 manifest never goes down, and never names an arm64-only
  release (the v1 schema can't express one).
- **I3.** The v2 manifest in every release describes that release.
- **I4.** Once a release carries a v2 manifest, every later release does. The first arm64
  release comes after at least one universal release that carries v2 and whose app reads it.
- **I5.** An arm64-only build can be downloaded or installed only by an app whose own process
  runs as arm64.
- **I6.** A v1 manifest is compared only with the v1 mark. A v2 manifest is compared with the
  higher of the two marks (§5.6).

### 4.3 Release sequence

| Release | macOS package | `update-manifest.json` describes | `update-manifest-v2.json` describes | What ships |
| --- | --- | --- | --- | --- |
| 1.6.0 (published) | universal | 1.6.0 | (none) | Today |
| 1.7.0 | universal | 1.7.0, same bytes as today's generator | 1.7.0: universal DMG and four Linux packages (the first v2) | Client half (§6) and publisher half (§7) |
| Later 1.x | universal | Itself | Itself | Ordinary releases |
| 1.x-last | universal | Itself | Itself | Its notes say it is the last version for Intel Macs |
| 2.0.0 | arm64 only (#296) | 1.x-last, re-stamped | 2.0.0: arm64 DMG and four Linux packages | Build for Apple silicon only; v1 freezes |
| 2.0.1 and later | arm64 only | 1.x-last, re-stamped | Itself | Ordinary releases |

Steps:

1. Before tagging 1.7.0, merge two PRs: the pinning PR (§8.1), which changes no behaviour, and
   one implementation PR with the client half, the publisher half and the workflow change
   together (§7.5 explains why together).
2. Tag 1.7.0. On real hardware, check that 1.7.0 reads v2 and says it is up to date (§8.5).
3. Ship 1.x releases as usual. Each one could turn out to be 1.x-last; nothing special is
   needed until #296 is ready.
4. Choose 1.x-last (decision 8) and say in its notes that Intel Macs stay on it.
5. #296 switches the macOS package to arm64 only. The first arm64 tag freezes v1 by itself
   (§7.3). #296 doesn't touch the update trust code.
6. After 2.0.0 is published, check that: the v1 manifest at latest describes 1.x-last; a 1.6
   app on an Intel Mac is offered 1.x-last; 1.x-last on an Intel Mac shows the Apple silicon
   copy; 1.x-last on an Apple silicon Mac installs 2.0.0.

### 4.4 What each installed app does from 2.0.0 on

Before 2.0.0, every app is offered the newest 1.x, as today.

| Installed | Host | Reads | Offered |
| --- | --- | --- | --- |
| 1.2.x | Any | v1 | 1.x-last, notify only (as today) |
| 1.3 to 1.6 | Intel Mac | v1 | 1.x-last (universal); then as the 1.x-last row |
| 1.3 to 1.6 | Apple silicon Mac | v1 | 1.x-last, then 2.x through v2 (two hops) |
| 1.3 to 1.6 | Linux | v1 | 1.x-last, then 2.x through v2 (two hops) |
| 1.7.0 to 1.x-last | Apple silicon Mac, running natively | v2 | The newest 2.x arm64 DMG, directly |
| 1.7.0 up to, not including, 1.x-last | Intel Mac, or Rosetta | v2, then v1 | 1.x-last (universal), installable |
| 1.x-last | Intel Mac | v2, then v1 | Nothing to install; copy says it needs a Mac with Apple silicon |
| 1.x-last | Apple silicon Mac under Rosetta | v2, then v1 | Nothing to install; copy says to reopen without Rosetta |
| 1.7.0 and later | Linux | v2 | The newest release |
| 2.x | Apple silicon Mac | v2 | The newest 2.x |

### 4.5 The constraints, one by one

- **Signed manifests expire.** Both manifests keep the 180-day lifetime. The re-stamp gives
  the frozen v1 manifest the new release's tag time, so it lives as long as v2 does: 180 days
  after the newest release. Example: 2.0.0 tagged 2027-01-18T12:00:00Z gives both manifests
  `expiresAt` 2027-07-17T12:00:00Z. A gap of more than 180 days between releases expires both,
  exactly as one manifest expires today. Every app then shows "Couldn't check right now", and
  nothing unsafe is offered.
- **The publisher won't sign a version that isn't newer.** Release tags must still increase,
  unchanged. The only exception is the v1 manifest inside an arm64 release, and only as an
  exact re-stamp of the previous release's verified v1 manifest (§5.3). It can't roll anyone
  back: a v1 reader's mark is at most 1.x-last (I2, I6), and no app compares the v1 manifest
  with the v2 mark.
- **The rollback mark (#148).** With one shared mark, any app from 1.7.0 on that verified
  2.0.0 would make the frozen 1.9.0 manifest stale, which would block both the Intel fallback
  and a deliberate downgrade to 1.6 (*probed*, §1.4). Separate marks (§5.6) prevent that, and
  the #148 promise holds for each manifest: a deliberate downgrade is still offered the newest
  release at or above its mark.
- **How old apps find the manifest.** Through `releases/latest/download/update-manifest.json`
  only. So the re-stamped v1 manifest is a file in every arm64 release, published atomically
  with it. There is no separate channel (§3, comparison).
- **Key rotation overlap.** Apps from 1.2 to 1.6 trust only `ed25519-99927ba2f6af6482`. A
  re-stamped v1 manifest therefore needs that key's signature for as long as it is published,
  which the multi-signature envelope already allows. Intel Macs on 1.x-last trust only
  1.x-last's registry, for good. If the original key must ever be retired, adding a second
  offline public key to the registry before 1.x-last keeps those Macs reachable (decision 7).
  Nothing in this design changes the single-key signer.
- **Linux keeps updating.** Linux selection is unchanged. Apps from 1.2 to 1.6 on Linux take
  one extra hop through 1.x-last after 2.0.0; apps from 1.7.0 on go straight to the newest
  release.
- **Notify-only fallbacks.** An arm64-only offer on an Intel Mac or under Rosetta is
  notify-only with fixed copy, whether or not an installer is registered. A failed or expired
  v1 read during the Intel fallback shows the same copy instead of an error. `deb-notify` and
  every existing feasibility reason are unchanged.
- **Intel users.** They end on 1.x-last, which keeps working, including Setup and its x64
  Node runtime. Its Settings → Updates says why there is nothing to install. Because release
  tags must increase, there can be no 1.x fix after 2.0.0 (§9, risk 5).
- **Tests:** §8. **Workflow:** §7.4.

---

## §5 — Manifests and files

### 5.1 Files and URLs

| File | Fetched by | URL |
| --- | --- | --- |
| `update-manifest.json` | 1.2.0 and later; 1.7.0 and later only for the Intel fallback | `https://github.com/shariqh/agent-inbox/releases/latest/download/update-manifest.json` |
| `update-manifest.json.sig` | As above | `https://github.com/shariqh/agent-inbox/releases/latest/download/update-manifest.json.sig` |
| `update-manifest-v2.json` | 1.7.0 and later | `https://github.com/shariqh/agent-inbox/releases/latest/download/update-manifest-v2.json` |
| `update-manifest-v2.json.sig` | 1.7.0 and later | `https://github.com/shariqh/agent-inbox/releases/latest/download/update-manifest-v2.json.sig` |
| `Agent-Inbox-vX.Y.Z-arm64.dmg` | The arm64 DMG, from 2.0.0 (name: decision 2) | `https://github.com/shariqh/agent-inbox/releases/download/vX.Y.Z/Agent-Inbox-vX.Y.Z-arm64.dmg` |

The size limits stay at 256 KiB for a manifest and 16 KiB for a signature
(`electron/update-fetch.cjs:11-12`). From 1.7.0 on, every release has exactly ten files: five
packages, `SHA256SUMS.txt` (still covering only the five packages) and the two manifest pairs.

### 5.2 The v1 manifest, as today

The format doesn't change: schema 1, the twelve top-level keys, exactly the five targets of
§1.2, serialized with `serializeManifest` (`scripts/update-manifest.mjs:209-212`): fixed key
order, two-space indentation, one trailing newline. In a universal release its bytes are
exactly what today's generator produces for the same evidence.

### 5.3 The frozen v1 manifest (re-stamp)

In an arm64 release the signer builds the v1 manifest from the previous release's v1
manifest, after verifying it:

| Field | Value |
| --- | --- |
| `schema`, `kind`, `repository` | Copied (1, `agent-inbox-update-manifest`, `shariqh/agent-inbox`) |
| `version`, `tag`, `source`, `releaseUrl`, `targets` | Copied unchanged from the previous release's v1 manifest |
| `publishedAt` | This release's annotated tag time, the same value as in its v2 manifest |
| `expiresAt` | `publishedAt` plus 180 days |
| `signingKeyId`, `trustedKeyIds` | From this release's key registry, as for any manifest |

Conditions, all checked in trusted code before anything is signed:

- The previous release's v1 pair verifies under this release's registry: digest, signature and
  schema, with no expiry check, exactly as `authorize-history` does today.
- Its version is older than this release's.
- Each copied target's `byteLength` and `sha256` match the size and GitHub digest of that file
  in the release the manifest describes (the digest when GitHub reports one, as the history
  check already allows). The history check already lists every release with its assets
  (`.github/workflows/macos-release-protected.yml:619`), so this needs no extra request.

Example: 2.0.0, tagged 2027-01-18T12:00:00Z, with 1.x-last = 1.9.0 (values illustrative):

```json
{
  "schema": 1,
  "kind": "agent-inbox-update-manifest",
  "repository": "shariqh/agent-inbox",
  "version": "1.9.0",
  "tag": "v1.9.0",
  "source": { "commit": "<1.9.0 commit>", "tree": "<1.9.0 tree>" },
  "publishedAt": "2027-01-18T12:00:00Z",
  "expiresAt": "2027-07-17T12:00:00Z",
  "releaseUrl": "https://github.com/shariqh/agent-inbox/releases/tag/v1.9.0",
  "signingKeyId": "ed25519-99927ba2f6af6482",
  "trustedKeyIds": ["ed25519-99927ba2f6af6482"],
  "targets": ["<the five 1.9.0 targets, copied unchanged>"]
}
```

*Probed* with today's reader code: a 1.5.0 app on an Intel Mac is offered
`Agent-Inbox-v1.9.0-universal.dmg`; a 1.9.0 app with a mark of 1.9.0 says it is up to date; a
1.5.0 Linux DEB app is offered `agent-inbox_1.9.0_amd64.deb`.

### 5.4 The v2 manifest

Top level: the same twelve keys and rules as v1 (§1.2), except that `schema` is `2`.

Targets:

| Rule | v2 |
| --- | --- |
| Count | 1 to 32 |
| Order | Ascending by `platform/architecture/packageType`, as in v1 |
| Target type | `platform`, `architecture` and `packageType` are strings matching `^[a-z0-9][a-z0-9-]{0,31}$`; each combination appears at most once |
| A type the reader knows | Exact keys and values, as in v1: the fixed filename, the canonical URL under this tag, a positive `byteLength`, a lowercase `sha256`, the fixed `installStrategy`, and `minimumSystemVersion` on a DMG |
| A type the reader doesn't know | Skipped. Nothing else about it is read |
| Required types | None in the reader. The publisher requires the full set for each release (§7.3) |

The types 1.7.0 knows:

| platform | architecture | packageType | filename | installStrategy |
| --- | --- | --- | --- | --- |
| `darwin` | `arm64` | `dmg` | `Agent-Inbox-vX.Y.Z-arm64.dmg` | `macos-dmg`, plus `minimumSystemVersion` |
| `darwin` | `universal` | `dmg` | `Agent-Inbox-vX.Y.Z-universal.dmg` | `macos-dmg`, plus `minimumSystemVersion` |
| `linux` | `arm64` | `appimage` | `Agent-Inbox-vX.Y.Z-linux-arm64.AppImage` | `appimage-self-replace` |
| `linux` | `arm64` | `deb` | `agent-inbox_X.Y.Z_arm64.deb` | `deb-notify` |
| `linux` | `x64` | `appimage` | `Agent-Inbox-vX.Y.Z-linux-x86_64.AppImage` | `appimage-self-replace` |
| `linux` | `x64` | `deb` | `agent-inbox_X.Y.Z_amd64.deb` | `deb-notify` |

A known type's filename and fields are fixed for schema 2. Renaming a package, or adding a
field to a known type, needs a new schema and a transition like this one. Adding a new type
doesn't.

Why readers skip unknown types: a reader never acts on them, so checking them protects
nothing, and the closed set is what turned a packaging change into a protocol break here. The
Windows installer record hit the same limit
(`docs/superpowers/specs/2026-10-23-windows-installer-decision.md`). Known types stay strict
(decision 5).

Example: 1.7.0, tagged 2026-11-16T12:00:00Z (values illustrative). Its v1 manifest is the same
data with `"schema": 1`.

```json
{
  "schema": 2,
  "kind": "agent-inbox-update-manifest",
  "repository": "shariqh/agent-inbox",
  "version": "1.7.0",
  "tag": "v1.7.0",
  "source": { "commit": "<40 lowercase hex>", "tree": "<40 lowercase hex>" },
  "publishedAt": "2026-11-16T12:00:00Z",
  "expiresAt": "2027-05-15T12:00:00Z",
  "releaseUrl": "https://github.com/shariqh/agent-inbox/releases/tag/v1.7.0",
  "signingKeyId": "ed25519-99927ba2f6af6482",
  "trustedKeyIds": ["ed25519-99927ba2f6af6482"],
  "targets": [
    { "platform": "darwin", "architecture": "universal", "packageType": "dmg", "filename": "Agent-Inbox-v1.7.0-universal.dmg", "url": "https://github.com/shariqh/agent-inbox/releases/download/v1.7.0/Agent-Inbox-v1.7.0-universal.dmg", "byteLength": 338700000, "sha256": "<64 lowercase hex>", "installStrategy": "macos-dmg", "minimumSystemVersion": "13.5" },
    { "platform": "linux", "architecture": "arm64", "packageType": "appimage", "filename": "Agent-Inbox-v1.7.0-linux-arm64.AppImage", "url": "https://github.com/shariqh/agent-inbox/releases/download/v1.7.0/Agent-Inbox-v1.7.0-linux-arm64.AppImage", "byteLength": 167500000, "sha256": "<64 lowercase hex>", "installStrategy": "appimage-self-replace" },
    { "platform": "linux", "architecture": "arm64", "packageType": "deb", "filename": "agent-inbox_1.7.0_arm64.deb", "url": "https://github.com/shariqh/agent-inbox/releases/download/v1.7.0/agent-inbox_1.7.0_arm64.deb", "byteLength": 121100000, "sha256": "<64 lowercase hex>", "installStrategy": "deb-notify" },
    { "platform": "linux", "architecture": "x64", "packageType": "appimage", "filename": "Agent-Inbox-v1.7.0-linux-x86_64.AppImage", "url": "https://github.com/shariqh/agent-inbox/releases/download/v1.7.0/Agent-Inbox-v1.7.0-linux-x86_64.AppImage", "byteLength": 168700000, "sha256": "<64 lowercase hex>", "installStrategy": "appimage-self-replace" },
    { "platform": "linux", "architecture": "x64", "packageType": "deb", "filename": "agent-inbox_1.7.0_amd64.deb", "url": "https://github.com/shariqh/agent-inbox/releases/download/v1.7.0/agent-inbox_1.7.0_amd64.deb", "byteLength": 127900000, "sha256": "<64 lowercase hex>", "installStrategy": "deb-notify" }
  ]
}
```

In 2.0.0 only the macOS target changes:

```json
{ "platform": "darwin", "architecture": "arm64", "packageType": "dmg", "filename": "Agent-Inbox-v2.0.0-arm64.dmg", "url": "https://github.com/shariqh/agent-inbox/releases/download/v2.0.0/Agent-Inbox-v2.0.0-arm64.dmg", "byteLength": 209000000, "sha256": "<64 lowercase hex>", "installStrategy": "macos-dmg", "minimumSystemVersion": "13.5" }
```

Both files are serialized like v1 (§5.2): the compact lines above are for reading only.

Neither reader can mistake the other's file. Each fetches only its own name, and each parser
requires its own `schema` inside the signed bytes, so a v2 file uploaded under the v1 name
fails on `schema` (*probed*), and the reverse fails the same way.

### 5.5 The signature envelope

Unchanged, `schema: 1`, for both manifests: `manifestSha256` plus a key-sorted array of Ed25519
signatures over the exact manifest bytes. In code the envelope's schema gets its own constant,
because `electron/update-manifest.cjs:460` uses the manifest's today.

### 5.6 Rollback marks

`userData/update-trust-state.json` stays at `schema: 1` and gains one optional field:

```json
{ "schema": 1, "highestVerifiedVersion": "1.9.0", "highestVerifiedVersionV2": "2.0.1" }
```

- `highestVerifiedVersion` is the v1 mark. Apps from 1.3 to 1.6 read and write only this
  field, and keep the other one when they write (`electron/update-preferences.cjs:244-256`).
- From 1.7.0 on, an app records a v2 manifest's version only in `highestVerifiedVersionV2`,
  and a v1 manifest's version (the Intel fallback) only in `highestVerifiedVersion`.
- A v1 manifest is stale below the v1 mark. A v2 manifest is stale below the higher of the two
  marks. That is safe because the v1 manifest never runs ahead of the v2 manifest (I1, I3).
- The install-time stale check (`electron/update-controller.cjs:689`) uses the mark of the
  manifest the offer came from.

### 5.7 Release evidence

- `release-aggregation-evidence.json`: `updateManifest` keeps its fields (name, size, SHA-256,
  registry digest) but now describes `update-manifest-v2.json`. Aggregation no longer writes the
  v1 file.
- `update-signing-evidence.json` moves to `schema: 2` and records, for each manifest: its name,
  size and SHA-256; its signature's name, size and SHA-256; the version and tag it describes;
  how it was made (`release`, `projection` or `restamp`); and its history result (`bootstrap` or
  `continuity`, the earlier tag, whether the rotation override was used). For a re-stamp it
  also records the earlier manifest's SHA-256 and each copied target's size and SHA-256. The
  top level keeps `tag`, `sourceCommit`, `sourceTree`, `signingKeyId` and `trustedKeyIds`, and
  adds `macos`: `universal` or `arm64`.

---

## §6 — Client changes (1.7.0)

### 6.1 `electron/update-manifest.cjs`

- The v1 validator keeps its behaviour exactly. The publisher still produces v1 manifests, and
  the Intel fallback reads them.
- Add the v2 catalog (§5.4), a v2 validator and a v2 entry point to `verifyManifest`. The trust
  order stays: digest, then signature, then schema, then freshness.
- Give the envelope its own schema constant (§5.5).

### 6.2 `electron/update-fetch.cjs`

- Add the two v2 URLs, and allow the two v2 names in the redirect check (`:16`, `:44`). The v1
  URLs stay, for the fallback only.
- New option `translated`: Electron's `app.runningUnderARM64Translation`, which the Electron
  43.8.0 docs describe for macOS and Windows. It only chooses the copy. The test for running as
  arm64 is `process.arch === 'arm64'`: an arm64 process proves the Mac runs arm64 code
  natively. Under Rosetta `process.arch` is `x64`.
- Selection on macOS:

```text
v2 = fetch and verify update-manifest-v2.json (schema 2)
record v2.version in the v2 mark
if v2.version is older than the higher of the two marks: stale
target = darwin/arm64/dmg if process.arch is arm64 and v2 lists it,
         otherwise darwin/universal/dmg if v2 lists it,
         otherwise darwin/arm64/dmg if v2 lists it (arm64-only)
if there is no target: unsupported
if v2.version is not newer than the running app: current
if target is arm64-only and process.arch is not arm64:
    v1 = fetch and verify update-manifest.json (schema 1); any failure means "no v1"
    record v1.version in the v1 mark
    if v1 is not stale against the v1 mark and v1.version is newer than the running app:
        offer v1's darwin/universal/dmg target (an ordinary, installable offer)
    otherwise: available, blocked = "rosetta" if translated, else "apple-silicon"; no artifact
otherwise: offer target
```

- A failed v1 read ends in the blocked state, not `unverified`, because the v2 check worked.
- A failed v2 read fails the check as today (`unverified`). There is no general fallback to v1:
  every release from 1.7.0 on carries v2 (G4).
- Linux selection is unchanged.

### 6.3 Copy

Shown under the existing status line, "Agent Inbox 2.0.0 is available."
(`public/app.js:8535`):

- **Intel Mac:** "It needs a Mac with Apple silicon. This Mac has an Intel processor, so Agent
  Inbox stays on 1.9.0, which keeps working."
- **Rosetta:** "It runs only natively on Apple silicon, and Agent Inbox is running under
  Rosetta. Quit Agent Inbox, turn off “Open using Rosetta” in its Get Info window in Finder,
  then reopen it to install."

The version is the running app's. Both lines are under 240 characters and contain no slash, so
they pass the controller's copy filter (`electron/update-controller.cjs:36-38`). Review release
stays; Download and Install don't appear.

### 6.4 `electron/update-controller.cjs`

- `safeCheckerState` (`:377-433`) accepts `available.blocked` from a closed set and maps it to
  the fixed copy above: `downloadable: false`, `installable: false`, `reason` set, no artifact.
  The preload's offer rules don't change.
- No native notification for a blocked offer (decision 4). Other notify-only offers still
  notify, because their reason is something the user can act on.
- An offer remembers which manifest it came from. `recordVerifiedVersion` and `highWaterMark()`
  (`:436-462`, `:647-660`) take that manifest's mark.
- `feasibilityFor` (`:466-477`) also passes the target's `architecture`.

### 6.5 `electron/update-install-macos.cjs`

- New option `hostArch`: `process.arch`.
- `feasibility()` (`:503-543`): right after the `unsupported` check, refuse an `arm64` target
  when `hostArch` isn't `arm64`, with the reason `architecture` and the Intel copy.
- `prepare()` (`:545-605`): refuse an arm64 record on such a host before touching anything.
- `verifyStaged()` (`:392-416`): read the Mach-O header of the staged
  `Contents/MacOS/Agent Inbox` (at most 4 KiB, opened read-only without following links).
  Accept a fat header (big-endian magic `0xcafebabe` or `0xcafebabf`, 1 to 8 entries) or a
  64-bit thin header (magic `0xfeedfacf`, little-endian), and require the CPU type of
  `process.arch`: `0x0100000c` for arm64, `0x01000007` for x86_64. *Probed:* the installed
  universal app's executable is a fat header with exactly those two CPU types. This checks the
  bytes that will run, not the manifest's label. No external tool: `/usr/bin/lipo` is the shared
  Xcode stub (it has the same hash as `/usr/bin/git` and `/usr/bin/clang`), so on a Mac without
  the Command Line Tools it would only prompt to install them.

The AppImage installer doesn't change.

### 6.6 `electron/update-download.cjs`

- `normalizeArtifact` and `locateVerified` (`:105-144`, `:688-727`) use the v2 catalog, and the
  verified record (`recordFor`, `:150-162`) carries `architecture`. The two DMG types have
  different filenames, so a recorded file still maps to exactly one type.

### 6.7 `electron/update-preferences.cjs`

- `createUpdateTrustState` reads and writes each mark separately (§5.6). The file stays at
  schema 1, so apps from 1.3 to 1.6 keep reading and raising their mark.

### 6.8 `electron/main.cjs`

- Pass `translated: app.runningUnderARM64Translation === true` to the checker (`:903-916`) and
  `hostArch: process.arch` to `createMacInstaller` (`:966-977`).

### 6.9 What doesn't change

Linux selection and the AppImage proof, `deb-notify`, the #216 install grants and restart
path, Setup, and attention: update state still never reaches `public/attention.js`, the badges
or Needs you.

---

## §7 — Publisher and workflow changes

### 7.1 Two kinds of release

The signer reads the kind from the aggregate evidence's macOS file and accepts exactly one of:

- **universal:** `Agent-Inbox-vX.Y.Z-universal.dmg`, architecture `universal`, target
  `darwin-arm64+darwin-x64` (today; `scripts/release-aggregation.mjs:505-520`);
- **arm64:** `Agent-Inbox-vX.Y.Z-arm64.dmg`, architecture `arm64`, target `darwin-arm64`
  (from #296).

Anything else is refused.

### 7.2 `scripts/release-aggregation.mjs`

- `updateManifestAsset` (`:504-543`) accepts both kinds.
- Aggregation writes only `update-manifest-v2.json`, so the unsigned handoff still holds seven
  release files. The v1 file is derived later, in trusted code (§7.3).
- The dry-run inventory (`:470-479`) lists the ten public files.

### 7.3 `scripts/update-manifest.mjs`

New functions, all pure and deterministic:

- `generateManifestV2`: from the evidence, with the publisher's strict set: universal → the
  universal DMG and the four Linux packages; arm64 → the arm64 DMG and the four Linux packages.
- `projectV1(v2)`: the v2 data with `schema: 1`, keeping only the five v1 types. It refuses
  unless all five are present, so it works only for a universal release. Its bytes equal
  today's `generateManifest` output for the same evidence.
- `restampV1(earlier, release, registry)`: §5.3.
- `planReleaseHistoryContinuity` and `authorizeReleaseContinuity` (`:372-476`) work per
  manifest, with the gates below.
- `sign` takes several `--manifest`/`--output` pairs, reads the key once and zeroes it
  afterwards, as it does now for one.

| Gate | Rule | Status |
| --- | --- | --- |
| G1 | Every earlier stable release is older than the new tag | Unchanged (`:398-400`) |
| G2 | No release carries half of either pair | Exists for v1 (`:401-405`); extended to v2 |
| G3 | The latest earlier release carries the v1 pair, which verifies; the new signing key is in its `trustedKeyIds`, or the exact override is set | Unchanged (`:409-423`, `:447-476`) |
| G4 | If any earlier release carries v2, the latest earlier release carries the v2 pair, which verifies under the same key rule. Otherwise this release starts v2, which only a universal release may do | New |
| G5 | An arm64 release needs the latest earlier release to carry the v2 pair | New |
| G6 | The v1 manifest is the projection of this release's v2 manifest (universal), or the re-stamp of the latest earlier release's v1 manifest (arm64) | New |
| G7 | The v2 manifest describes this release, and its target set is exactly the set for this kind of release | New; replaces today's v1 identity check (workflow `:586-617`) |
| G8 | In a universal release, v1 and v2 carry the same data apart from `schema` | New; true by construction, checked anyway |

The check that the earlier manifest's tag equals the planned earlier tag (workflow `:692`)
splits in two. The earlier v2 manifest must describe the earlier release. The earlier v1
manifest must describe either the earlier release (if it was universal) or an older one (if it
was arm64).

### 7.4 `.github/workflows/macos-release-protected.yml`

| Job or step | Change | Lines today |
| --- | --- | --- |
| `verify-publication` | The handoff still holds seven release files; the manifest among them is now v2 | `:540` |
| `sign-update-manifest`: check | Check the unsigned v2 manifest against the release instead of v1, and read the release's kind from evidence | `:586-617` |
| `sign-update-manifest`: history | One plan for both manifests; download the earlier v2 pair when it exists, with the same size and digest checks; authorize both | `:619-702` |
| `sign-update-manifest`: derive | Write the v1 manifest by projection or re-stamp, from verified inputs only | New, before signing |
| `sign-update-manifest`: sign | The one existing step signs both files in one process | `:703-715` |
| `sign-update-manifest`: bind | Verify both with the current time; signing evidence schema 2; five handoff files and ten release files | `:716-771` |
| `publish` | Ten names. The DMG name comes from verified evidence and must be one of exactly two. Check each manifest independently: v2 against the release; v1 against the release (universal) or against the re-stamp record in the signing evidence (arm64). Download and compare all ten | `:905-917`, `:918-1117`, `:1154-1160`, `:1290-1299`, `:1327-1337` |
| `publish`, optional | Send `make_latest: "true"` in the final `PATCH`, so the hand-off doesn't rest on GitHub's default | `:1402-1410` |

What doesn't change: the job graph and its `needs`, the `authorize` and `verify-handoff` jobs,
the environments, secrets, permissions and pinned actions, the tag checks, the draft ownership
markers and cleanup, and the single write step. The private key still reaches one process.

Where the logic lives: the signing job checks out trusted code, so planning, deriving and
authorizing move into `scripts/update-manifest.mjs` subcommands and the YAML only moves files.
The publish job keeps its own inline check, because it has no checkout by design.

### 7.5 Why one implementation PR

If the two halves land apart, two mismatches are possible:

- A release publishes v2 but its app doesn't read it. If that release became 1.x-last, Apple
  silicon Macs would stop there: v1 offers nothing newer, and the app can't read v2. G5 can't
  catch this, because it checks files, not the app.
- A release's app reads v2 but the release doesn't publish it. Those apps show "Couldn't check
  right now" until the next release.

One PR avoids both. A test pins that the file the client fetches is the file aggregation
writes, so neither half can later be removed alone.

### 7.6 Other files and docs

- `.github/workflows/macos-release.yml` and `.github/workflows/release-aggregate.yml` name no
  manifest file; their inventory comes from `scripts/release-aggregation.mjs`.
- `CLAUDE.md`: "Signed update-manifest trust contract" (ten files, two manifests, the
  re-stamp); "Rollback high-water mark" (two marks, and the sentence that the publisher refuses
  to sign a version that isn't newer gains the re-stamp exception); "Verified update download"
  (the v2 catalog); "Verified update install on macOS" (the architecture rule and slice check).
- `docs/macos-release.md` (steps 8 to 10, the allowlist, and "Download verification" at
  `:477-509`), `docs/linux-release.md` (the allowlist and its description, `:358-380`) and
  `electron/README.md` (the updater overview).
- #296 updates the README, `docs/INSTALL.md` and the website for Intel users.

### 7.7 Operating rules

- Never delete or edit the 1.x-last release or its files: the v1 manifest points at them.
- Publish a release at least every 150 days, or accept that both manifests expire, as the one
  manifest can today.
- Never publish a stable release with `make_latest: false`.

---

## §8 — Test plan

### 8.1 Pin the apps already shipped (a first PR, no behaviour change)

- Copy the shipped reader files byte for byte into `test/fixtures/shipped-updaters/`:
  `update-manifest.cjs` (`5ce1d675…`, the same for 1.2.0 to 1.6.0), both `update-fetch.cjs`
  versions (`d31aeadc…` for 1.2.x, `85d1195b…` for 1.3 to 1.6), and 1.6.0's
  `update-preferences.cjs` (`5d0edf70…`; its trust-state code is unchanged since 1.3.0, and
  1.6.0 only added exports). A test pins each file's full SHA-256. CI checks out without tags
  (`.github/workflows/ci.yml:25-27`), so tests can't use `git show <tag>:`.
- In this first PR, the shipped readers accept today's publisher output and pick the universal
  DMG on macOS `x64` and `arm64`. This is the baseline the implementation PR must keep.

### 8.2 Unit tests (implementation PR)

- **`test/update-manifest.test.ts`:** one case per row of the v2 rules (§5.4); known types
  strict; unknown types skipped but checked for name format, uniqueness and order; envelope
  schema 1 for v2. `projectV1` output is byte-identical to `generateManifest` for the same
  evidence. `restampV1` changes only the four fields of §5.3, and refuses a forged, schema-2 or
  not-older earlier manifest and a copied target that disagrees with the release listing.
  History: v2 starts only in a universal release; an arm64 release needs an earlier v2; no gaps;
  no half pairs in either manifest; the rotation override is still exact.
- **`test/update-fetch.test.ts`:** the v2 URLs and redirect names (extends `:158`); the selection
  matrix, macOS `arm64`, `x64` and `x64` under Rosetta against "universal only", "arm64 only"
  and "both", with Linux unchanged (extends `:440-473`). The Intel fallback: v1 newer gives an
  ordinary offer; v1 equal, stale, missing, expired or invalid gives the blocked state. Stale
  rules with two marks; the existing #148 suite (`:581-906`) runs for each mark.
- **`test/update-controller.test.ts`:** a blocked offer is notify-only with the fixed copy, is
  never downloadable and sends no notification; the install-time stale check uses the offer's
  own mark; the feasibility call shapes (`:887`, `:981`) gain `architecture`.
- **`test/update-install-macos.test.ts`:** feasibility refuses an arm64 target on `x64` and
  accepts it on `arm64`; `prepare()` refuses before any filesystem call; the slice check against
  header fixtures: fat with both CPU types, thin arm64, thin x86_64, a Java class file (also
  `0xcafebabe`, with a large count), a truncated file and a symbolic link.
- **`test/update-download.test.ts`:** the arm64 DMG round-trips through `normalizeArtifact`,
  `recordFor` and `locateVerified`; a universal filename claimed as arm64 is refused, and the
  reverse.
- **`test/electron-updates.test.ts`:** every new state passes the real preload validator
  (extends `:217`); `main.cjs` passes `translated` and `hostArch` (source pins like `:688`).
- **`test/dom/updates.test.ts`:** both lines of copy render, with only Check now and Review
  release.
- **Shipped readers (§8.1 fixtures):** they accept every v1 manifest the new publisher can
  produce (projection and re-stamp), read a re-stamped manifest as up to date at its own
  version, reject every v2 manifest on `schema`, and keep `highestVerifiedVersionV2` when they
  raise their own mark.

### 8.3 One end-to-end test of the hand-off (`test/update-lanes.test.ts`)

A synthetic history, 1.6.0, 1.7.0, 1.8.0, 1.9.0, 2.0.0, 2.0.1, built only by the publisher
functions and served through a fake `latest`. After each release, the test runs the shipped
1.2.x and 1.6.0 readers and the new reader for each host (Intel Mac, Apple silicon Mac, Rosetta,
and Linux x64 and arm64 with AppImage and DEB). It installs whatever is offered and repeats
until nothing is. It asserts:

- the paths in §4.4, including an Intel Mac on 1.8.0 reaching 1.9.0 through the fallback;
- no v1 reader is ever offered a 2.x file;
- no app running as `x64` on macOS is ever offered a downloadable arm64 build;
- nothing reads as stale along the way;
- 181 days after the last re-stamp, v1 readers show `unverified` and are offered nothing.

### 8.4 Workflow

- **`test/macos-release-workflow.test.ts`** already runs the real publish script
  (`extractPublisherScript`, `:23`). It gets handoffs for a universal and an arm64 release, and
  must refuse: a missing or extra pair; a v1 manifest that isn't the release (universal) or the
  recorded re-stamp (arm64); a v2 manifest for another release; an arm64 DMG name in a universal
  release and the reverse.
- Source pins: the key appears only in the one signing step; no new job, secret, permission or
  action; `make_latest` if adopted.
- **`test/release-aggregation.test.ts`** (`:414`, `:502`): the v2 output and the ten-file
  dry-run inventory.

### 8.5 Manual checks on hardware

- After 1.7.0 is published: Settings → Updates says it is up to date, through v2, on an Apple
  silicon Mac, an Intel Mac, under Rosetta, and on a Linux AppImage and DEB. A 1.6 app on each is
  offered 1.7.0 through v1 and installs it.
- After 2.0.0 is published: the checks in §4.3, step 6.

---

## §9 — Risks

1. **Choosing 1.x-last wrongly.** Low. A universal release published after the intended 1.x-last
   becomes the v1 target by itself (I1); only its release notes would be wrong.
2. **More than 180 days between releases.** Both manifests expire, as the one does today. Every
   app shows "Couldn't check right now" and nothing unsafe is offered. Mitigation: §7.7.
3. **Losing or retiring the original key.** Apps from 1.2 to 1.6 trust only
   `ed25519-99927ba2f6af6482`, and Intel Macs on 1.x-last trust only 1.x-last's registry, for
   good. Losing that key ends update checks for both groups. Mitigation: decision 7.
4. **A wrong re-stamp.** A copy that drifted would mislead old apps. It is derived from the
   verified earlier manifest in trusted code, cross-checked against the published files of the
   release it describes, and checked again by the publish job.
5. **No fixes for Intel Macs after 1.x-last.** Release tags must increase, so a 1.x release
   after 2.0.0 is refused. A security fix for Intel would need its own design.
6. **Rosetta users reopen once.** Someone who opened the app with "Open using Rosetta" must
   reopen it natively to install 2.x (decision 3).
7. **A race at publication.** An app can read a manifest from one release and its signature
   from the next; verification fails and the next daily check succeeds. This exists today.
8. **Two requests a day on Intel Macs.** The fallback reads v1 as well. Both files are small.
9. **Code that first runs at 2.0.0.** The arm64 branches of the publisher, and the Intel copy,
   first run for real at 2.0.0. The fixture runs in §8.3 and §8.4 cover them, and §4.3 step 6
   checks them on the day.
10. **A skipped type.** A later manifest can carry a type an older reader skips. For that reader
    it means "no update for this host" on a host that couldn't use the package anyway, never a
    wrong install.

---

## §10 — Decisions for Shariq

**1. Which approach?**
- **A. A second manifest, with v1 frozen and re-stamped in every release (recommended).** Old
  apps keep being guided to 1.x-last while releases continue. It costs one narrow signing
  exception.
- B. Copy 1.x-last's v1 pair forward unchanged. No signing exception, but every app from 1.2 to
  1.6 loses update checks 180 days after 1.x-last's tag, and Intel users then have to find
  1.x-last on their own.
- C. Keep 1.x-last as GitHub's latest release. It needs a second way for new apps to find 2.x,
  and replacing files on a published release.

**2. What is the arm64 DMG called?** Apps from 1.7.0 on check the name, so it can't change
later without another transition.
- **A. `Agent-Inbox-vX.Y.Z-arm64.dmg` (recommended).** It matches `-universal.dmg` and the
  `arm64` in the Linux package names.
- B. `Agent-Inbox-vX.Y.Z-macos-arm64.dmg`. It names the platform, as the Linux AppImages do.
- C. `Agent-Inbox-vX.Y.Z-apple-silicon.dmg`. Plainest for people choosing a download, but not the
  architecture name used elsewhere.

**3. Under Rosetta, refuse the arm64 build or allow it?**
- **A. Refuse, with copy that says how to reopen without Rosetta (recommended, and what the
  issue asks for).** The rule rests on one fact the process can prove: it runs as arm64.
- B. Allow it when Electron reports translation. The Mac can run the new build, but the rule then
  rests on the translation flag.

**4. Should an offer this Mac can't install raise a notification?**
- **A. No; Settings → Updates explains it (recommended).** There is nothing the user can do
  about it.
- B. One notification per major version (2.0, 3.0).

**5. What should v2 readers do with target types they don't know?**
- **A. Skip them (recommended).** Windows (#85, #87) and other packages can then be added
  without another transition. Known types stay strict.
- B. Refuse the whole manifest, as v1 does. Every new type needs another transition.

**6. How long should releases keep re-stamping v1?**
- **A. In every release, with no end date (recommended).** A re-stamp costs nothing, and it is
  the only way apps from 1.2 to 1.6 hear about 1.x-last.
- B. Until a set date, for example 12 months after 2.0.0. Those apps then show "Couldn't check
  right now" 180 days after the last re-stamp.

**7. Should a backup public key be added before 1.x-last?**
- **A. Yes, in a small separate PR, ideally before 1.7.0 and at the latest before 1.x-last
  (recommended).** Generate a second Ed25519 key, keep its private half offline, and add only
  its public key to `release/update-keys.json`. The original key stays `signingKeyId`, and every
  later manifest lists both in `trustedKeyIds`, which also authorizes a later switch without the
  emergency override. Every app from the release that adds it, including Intel Macs that stay
  on 1.x-last for good, could then follow a rotation without dual signing. Apps from 1.2 to 1.6
  can't gain it either way.
- B. No. A later rotation relies on dual signing for as long as those apps matter.

**8. Which release is 1.x-last, and how much soak before 2.0.0?**
- **A. Whichever 1.x is the last one before #296 is ready (recommended).** Before tagging 2.0.0,
  require at least one published universal release that carries v2 (1.7.0 counts) and the
  hardware checks of §8.5.
- B. Pick a version now, for example 1.9.0, and hold #296 until it ships.

---

## §11 — Not in scope

- The arm64 build, its signing, notarization and release gates, and the README and website
  changes (#296).
- Windows update targets (#85, #87). v2 leaves room for them; nothing is added now.
- Fixes for Intel Macs after 1.x-last.
- Downloading Setup's runtime on demand (V5 in the efficiency audit).
- The dual-key signer itself.
