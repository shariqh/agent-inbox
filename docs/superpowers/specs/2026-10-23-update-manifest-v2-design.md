# Design: Update manifest v2 and the Intel hand-off (issue #295)

**Date:** 2026-10-23
**Status:** Proposal for review, revised after an independent review (§12). Eight decisions for
Shariq are in §10.
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
   on. It is signed with the same key, uses the same signature envelope and lasts at most 180
   days. Its schema allows an arm64 DMG. Readers skip target types they don't know, and ignore
   keys they don't know unless the manifest marks them critical, so a later target (Windows,
   #85 and #87) or field doesn't need a third manifest.
2. **`update-manifest.json` stays in every release.** While releases are universal it describes
   the release, with the same bytes as today. From 2.0.0 on it describes the last universal 1.x
   release (called **1.x-last** below). Each release re-signs that description with a fresh
   `publishedAt`, so it doesn't expire while releases continue. The rule is simple: the v1
   manifest always describes the newest universal release.
3. **1.7.0 and every later version read v2.** An arm64-only build is never downloaded or
   installed by an app running on an Intel Mac or under Rosetta. Such an app also reads v1, to
   find the newest universal release, and offers it if it is newer. Only when v1 verifies, isn't
   stale and isn't newer does it show plain copy saying the update needs a Mac with Apple silicon
   (or, under Rosetta, how to reopen without it). A v1 that is missing, expired or invalid fails
   the check instead, and a stale one reads as stale, so a verified download is never thrown
   away. Installer feasibility, `prepare()` and a check of the staged app's CPU types repeat the
   rule.
4. **Each manifest keeps its own rollback mark,** so the frozen v1 manifest never reads as
   stale, even after a downgrade.
5. **Whether a release is universal comes from the binary, not a label.** The release records
   the exact CPU types `lipo` reports for the shipped app's executable and its better-sqlite3
   addon; the DMG name, the labels and the manifests are derived from that set, and the trusted
   signer and the publish job both refuse any mismatch. Today the label is a constant, so #296
   must change this evidence contract, not only the build.
6. **The publisher derives the v1 manifest in trusted code:** from the v2 manifest in a
   universal release, or by re-signing the previous release's verified v1 manifest in an arm64
   release. New gates: v2 must be published before any arm64 release, no release may drop a
   manifest once it exists, a re-signed copy must match the files published for 1.x-last, and
   v1 must always carry a signature from the key 1.2 to 1.6 trust. The publish job re-checks the
   re-signed copy on its own, from GitHub. The protected workflow keeps its jobs, secret,
   permissions and draft-then-publish protocol.

Sequence: 1.7.0 ships the client half and starts the v2 manifest, still universal. Later 1.x
releases stay universal. Before tagging 2.0.0, 1.x-last's own updater is rehearsed on an Intel
Mac and under Rosetta, because the Intel path can't be patched afterwards. 2.0.0 ships the arm64
DMG and freezes v1 (#296). Apps from 1.2 to 1.6 reach 1.x-last and continue from there. Intel
Macs stay on 1.x-last with clear copy. Linux keeps updating; apps from 1.2 to 1.6 take one extra
hop through 1.x-last.

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
  review Releases manually." (`public/app.js:8544`). *Probed:* once the manifest has expired,
  the 1.5.0 app's check throws "manifest has expired".
- A notify-only offer carries `available.reason`, shown under the status line
  (`electron/update-controller.cjs:481-498`, `public/app.js:8575-8578`). The preload accepts a
  reason only on an offer that is neither downloadable nor installable
  (`electron/setup-preload.cjs:157-176`).
- Scheduled checks send one native notification per version, whether or not the offer can be
  installed (`electron/update-controller.cjs:340-358`, `:564-566`; copy in
  `electron/main.cjs:939-951`).
- How a check ends decides what happens to a verified download. An `available` result that
  doesn't carry the same artifact drops it and prunes the download folder
  (`electron/update-controller.cjs:520-526`). A `stale` result keeps it (`:500-512`), and so does
  a check that throws while a verified file is on screen (`:568-569`).
- Review release opens `state.available.releaseUrl` (`electron/main.cjs:269-278`), which is
  pinned to the offered tag (`electron/update-controller.cjs:394-395`). The button shows
  whenever there is an offer and no install is running (`public/app.js:8652`).

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
- **What says a release is universal.** The notarize job runs the release's own
  `verifyFinalDmg`, which copies the app out of the final DMG and requires `lipo -archs` to
  report exactly arm64 and x86_64 for the main executable and the better-sqlite3 addon
  (`scripts/macos-release-gates.mjs:715-719`). It records only `universalEnvelope: 'passed'`
  (`:767`), not the set. `buildFinalReleaseEvidence` requires the name
  `Agent-Inbox-<tag>-universal.dmg` and that flag (`:807-810`, `:824`), and
  `validatePublicationInputs` checks the flag again (`:906`). Aggregation then writes the name,
  `architecture: 'universal'` and `target: 'darwin-arm64+darwin-x64'` as constants
  (`scripts/release-aggregation.mjs:562`, `:591-596`). The trusted signer sees only those
  labels. The native Intel gate (`scripts/macos-release-gates.mjs:367-441`) proves that the
  x64 Setup runtime runs on a real Intel Mac. It is revalidated in the notarize job
  (`.github/workflows/macos-release-protected.yml:362-377`) but isn't carried into the final
  evidence.
- **Release notes** come from a fixed template in the notarize job that says "Apple silicon or
  Intel" and names the universal DMG (`.github/workflows/macos-release-protected.yml:445-477`).
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
6. What makes a release "universal" has to come from the binary. Today it is a constant that
   only the release's own gates connect to `lipo` (§1.6). If #296 relaxed those gates but kept the
   label, the trusted publisher would describe an arm64-only DMG to every Intel Mac on 1.3 to
   1.6. Those Macs would install an app that can't open; the helper reports success, and the
   old app is left in a hidden stage folder.
7. The Intel path can't be patched after 2.0.0. Release tags must increase (G1), and every 2.x
   build is arm64 only, so whatever 1.x-last does on an Intel Mac is final. It has to be
   rehearsed on real hardware before 2.0.0 is tagged.

---

## §2 — Requirements

- **R1.** An app that reads only v1 is never offered a macOS package that isn't universal.
- **R2.** Apps from 1.2 to 1.6 keep working through the change, on every platform. Their last
  hop is 1.x-last, never a 2.x file.
- **R3.** 1.7.0 and every later version read a new manifest that allows an arm64 DMG.
- **R4.** On an Intel Mac or under Rosetta, an arm64-only build is never downloaded or
  installed, whatever installer is registered. The offer stays notify-only, with plain copy, and
  nothing on screen points the user at the arm64 download.
- **R5.** Linux keeps updating normally throughout.
- **R6.** Expiry, rollback marks and key continuity keep their guarantees. Any exception is
  narrow, written down and tested.
- **R7.** The protected workflow changes as little as possible: no new job, secret,
  environment, permission or third-party action; the same draft-then-publish protocol; the
  private key still reaches exactly one process.
- **R8.** A later target, such as Windows, or a later field doesn't need another manifest
  transition.
- **R9.** Tests pin every rule, including tests that run the reader code 1.2 to 1.6 shipped.
  The Intel and Rosetta paths of 1.x-last are rehearsed on real hardware before 2.0.0 is tagged.
- **R10.** Whether a release is universal is derived from the CPU types measured in its shipped
  binary, and both trusted jobs refuse any name, label or manifest that disagrees.

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
- Intel Macs on 1.7.0 up to, not including, 1.x-last lose their way to 1.x-last at the same
  moment, because their fallback reads v1 (§6.2).

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
| Intel Macs on 1.7.0 to just before 1.x-last, after 2.0.0 | Offered 1.x-last while releases continue | The same cliff as the row above | The same cliff as the row above |
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
  higher of the two marks, both when it is checked and when it is installed (§5.6).
- **I7.** A release is universal exactly when the CPU types measured in its shipped app are
  arm64 and x86_64, and arm64 exactly when they are arm64 alone. The DMG name, every label and
  both manifests follow from that set (§7.1).
- **I8.** Every v1 manifest carries a signature from `ed25519-99927ba2f6af6482`, the only key
  1.2 to 1.6 trust.

### 4.3 Release sequence

| Release | macOS package | `update-manifest.json` describes | `update-manifest-v2.json` describes | What ships |
| --- | --- | --- | --- | --- |
| 1.6.0 (published) | universal | 1.6.0 | (none) | Today |
| 1.7.0 | universal | 1.7.0, same bytes as today's generator | 1.7.0: universal DMG and four Linux packages (the first v2) | Client half (§6), publisher half and the measured-kind evidence (§7) |
| Later 1.x | universal | Itself | Itself | Ordinary releases |
| 1.x-last | universal | Itself | Itself | Notes edited by hand to say it is the last version for Intel Macs |
| 2.0.0 | arm64 only (#296) | 1.x-last, re-stamped | 2.0.0: arm64 DMG and four Linux packages | Build for Apple silicon only; v1 freezes |
| 2.0.1 and later | arm64 only | 1.x-last, re-stamped | Itself | Ordinary releases |

Steps:

1. Before tagging 1.7.0, merge two PRs: the pinning PR (§8.1), which changes no behaviour, and
   one implementation PR with the client half, the publisher half, the measured-kind evidence
   and the workflow change together (§7.5 explains why together).
2. Tag 1.7.0. On real hardware, check that 1.7.0 reads v2 and says it is up to date (§8.5).
3. Ship 1.x releases as usual. Each one could turn out to be 1.x-last; nothing special is
   needed until #296 is ready.
4. Choose 1.x-last (decision 8). Its notes come from the workflow template and were written
   before anyone knew it would be the last, so edit its published notes by hand to say Intel
   Macs stay on it, keeping the `<!-- agent-inbox-release:… -->` marker line unchanged.
5. #296 switches the macOS build to arm64 only, and with it the evidence contract of §7.1. It
   changes the expected set in `release/macos-inputs.json` to `["arm64"]`, removes the Intel gate
   and the x64 runtime that only a universal kind needs, and makes the release-notes template
   name 1.x-last for Intel users. So #296 does touch the trust path. #295 has already moved
   today's hard-coded checks (`scripts/macos-release-gates.mjs:715-719`, `:807-810`, `:824`,
   `:906`) onto the expected and measured sets, so #296 needs no other change there and must
   not add any other way to set the kind. The manifest code and the publisher's lane logic don't
   change in #296.
6. Before tagging 2.0.0, run the rehearsal of §8.5 on an Intel Mac and under Rosetta. Its pass is
   a gate for the tag.
7. After 2.0.0 is published, check that: the v1 manifest at latest describes 1.x-last; a 1.6
   app on an Intel Mac is offered 1.x-last; 1.x-last on an Intel Mac shows the Apple silicon
   copy without Review release; 1.x-last on an Apple silicon Mac installs 2.0.0.

### 4.4 What each installed app does from 2.0.0 on

Before 2.0.0, every app is offered the newest 1.x, as today.

| Installed | Host | Reads | Offered |
| --- | --- | --- | --- |
| 1.2.x | Any | v1 | 1.x-last, notify only (as today) |
| 1.3 to 1.6 | Intel Mac | v1 | 1.x-last (universal); then as the 1.x-last row |
| 1.3 to 1.6 | Apple silicon Mac | v1 | 1.x-last, then 2.x through v2 (two hops) |
| 1.3 to 1.6 | Linux | v1 | 1.x-last, then 2.x through v2 (two hops) |
| 1.7.0 to 1.x-last | Apple silicon Mac, running natively | v2 | The newest 2.x arm64 DMG, directly |
| 1.7.0 to just before 1.x-last | Intel Mac, or Rosetta | v2, then v1 | 1.x-last (universal), installable |
| 1.x-last | Intel Mac | v2, then v1 | Nothing to install; copy says it needs a Mac with Apple silicon; no Review release, no notification |
| 1.x-last | Apple silicon Mac under Rosetta | v2, then v1 | Nothing to install; copy says to reopen without Rosetta; one notification per version |
| 1.7.0 and later | Linux | v2 | The newest release |
| 2.x | Apple silicon Mac | v2 | The newest 2.x |

### 4.5 The constraints, one by one

- **Signed manifests expire.** The publisher keeps writing a 180-day lifetime, and v2 readers
  accept any lifetime up to 180 days, so it can be shortened later without another transition.
  The re-stamp gives the frozen v1 manifest the new release's tag time, so it lives as long as
  v2 does: 180 days after the newest release. Example: 2.0.0 tagged 2027-01-18T12:00:00Z gives
  both manifests `expiresAt` 2027-07-17T12:00:00Z. A gap of more than 180 days between releases
  expires both, exactly as one manifest expires today. Every app then shows "Couldn't check right
  now", and nothing unsafe is offered.
- **The publisher won't sign a version that isn't newer.** Release tags must still increase,
  unchanged. The only exception is the v1 manifest inside an arm64 release, and only as an
  exact re-stamp of the previous release's verified v1 manifest (§5.3), which the publish job
  re-checks against GitHub on its own (§7.4). It can't roll anyone back: a v1 reader's mark is
  at most 1.x-last (I2, I6), and no app compares the v1 manifest with the v2 mark.
- **The rollback mark (#148).** With one shared mark, any app from 1.7.0 on that verified
  2.0.0 would make the frozen 1.9.0 manifest stale, which would block both the Intel fallback
  and a deliberate downgrade to 1.6 (*probed*, §1.4). Separate marks (§5.6) prevent that, and
  the #148 promise holds for each manifest: a deliberate downgrade is still offered the newest
  release at or above its mark.
- **How old apps find the manifest.** Through `releases/latest/download/update-manifest.json`
  only. So the re-stamped v1 manifest is a file in every arm64 release, published atomically
  with it, and the publish job sets `make_latest: "true"` explicitly instead of relying on
  GitHub's default. There is no separate channel (§3, comparison).
- **Key rotation overlap.** Apps from 1.2 to 1.6 trust only `ed25519-99927ba2f6af6482`, so
  every v1 manifest must carry that key's signature for as long as it is published (I8). A
  publisher gate enforces it (G10), so a later `signingKeyId` switch fails the release loudly
  instead of silently cutting those apps off; the multi-signature envelope already allows an
  old-and-new pair. v2 needs the same signature while any app that reads v2 trusts only that
  key. Intel Macs on 1.x-last trust only 1.x-last's registry, for good; adding a second offline
  public key before 1.x-last keeps them reachable (decision 7). Nothing in this design changes
  the single-key signer.
- **Linux keeps updating.** Linux selection is unchanged. Apps from 1.2 to 1.6 on Linux take
  one extra hop through 1.x-last after 2.0.0; apps from 1.7.0 on go straight to the newest
  release.
- **Notify-only fallbacks.** An arm64-only offer on an Intel Mac or under Rosetta is never
  downloadable, whether or not an installer is registered. The blocked copy appears only when
  the v1 read verified, isn't stale and isn't newer than the running app. A missing, expired or
  invalid v1 fails the check (`unverified`), and a stale one returns `stale`; both keep any
  verified download (§1.5). `deb-notify` and every existing feasibility reason are unchanged.
- **Intel users.** They end on 1.x-last, which keeps working, including Setup and its x64 Node
  runtime. Settings → Updates says why there is nothing to install and hides Review release,
  which would otherwise open the 2.x page. The 2.x release notes name 1.x-last for Intel Macs
  (#296). Because release tags must increase, there can be no 1.x fix after 2.0.0 (§9, risk 5),
  so the Intel path is rehearsed before 2.0.0 (§8.5).
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
- Its version is older than this release's, and the release it describes is the newest
  published stable release whose files include a `-universal.dmg` (I1).
- Each copied target's `byteLength` and `sha256` match the size and GitHub digest of that file
  in the release the manifest describes (the digest when GitHub reports one, as the history
  check already allows). The history check already lists every release with its assets
  (`.github/workflows/macos-release-protected.yml:619`), so this needs no extra request.

The publish job then repeats these checks with its own code, fetching the earlier pair from
GitHub itself (§7.4).

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

Top level: the same twelve required keys and rules as v1 (§1.2), with three differences:

| Rule | v1 | v2 |
| --- | --- | --- |
| `schema` | 1 | 2 |
| Lifetime | `expiresAt` exactly 180 days after `publishedAt` | More than 0 and at most 180 days after `publishedAt`. The publisher still writes 180 |
| Keys the reader doesn't know | The whole manifest is rejected | Ignored, unless the same object's optional `critical` array names them (below) |

`critical` is an optional array of key names, allowed at the top level and in a target of a
known type. A reader rejects the whole manifest when `critical` names a key it doesn't
implement. 1.7.0 implements none, so for 1.7.0 `critical` must be absent or empty. This lets a
later release add a field that older readers may safely ignore, or force them to refuse a
manifest whose new field they would misread. Freshness keeps the five-minute limit on a future
`publishedAt`.

Targets:

| Rule | v2 |
| --- | --- |
| Count | 1 to 32 |
| Order | Ascending by `platform/architecture/packageType`, as in v1 |
| Target type | `platform`, `architecture` and `packageType` are strings matching `^[a-z0-9][a-z0-9-]{0,31}$`; each combination appears at most once |
| A type the reader knows | Required keys and values exactly as in v1: the fixed filename, the canonical URL under this tag, a positive `byteLength`, a lowercase `sha256`, the fixed `installStrategy`, and `minimumSystemVersion` on a DMG. Other keys follow the `critical` rule above |
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

A known type's filename and required fields are fixed for schema 2. Renaming a package needs a
new schema and a transition like this one. Adding a type, or an optional field, doesn't.

Why readers skip unknown types: a reader never acts on them, so checking them protects
nothing, and the closed set is what turned a packaging change into a protocol break here. The
Windows installer record hit the same limit
(`docs/superpowers/specs/2026-10-23-windows-installer-decision.md`). The required fields of
known types stay strict (decision 5).

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
because `electron/update-manifest.cjs:460` uses the manifest's today. Every v1 envelope must
include a valid signature from `ed25519-99927ba2f6af6482` (I8, G10).

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
- The install-time stale check (`electron/update-controller.cjs:647-660`, `:689`) applies the
  same rule as the check: the higher of the two marks for an offer from v2, the v1 mark for an
  offer from v1.

### 5.7 Release evidence

- `release-evidence.json` (the notarize job's final evidence): the transported-app record
  replaces `universalEnvelope: 'passed'` with `architectures: { executable, betterSqlite3 }`,
  each the sorted output of `lipo -archs` on the app copied out of the final DMG, and
  `kind: 'universal' | 'arm64'` derived from them (§7.1). `finalDmgName` follows from `kind`. A
  universal release also records the native Intel gate's result.
- `release-aggregation-evidence.json`: `updateManifest` keeps its fields (name, size, SHA-256,
  registry digest) but now describes `update-manifest-v2.json`. Aggregation no longer writes the
  v1 file. The macOS asset's `name`, `architecture` and `target` are derived from the measured
  set, which is copied alongside as `architectures`.
- `update-signing-evidence.json` moves to `schema: 2` and records, for each manifest: its name,
  size and SHA-256; its signature's name, size and SHA-256; the version and tag it describes;
  how it was made (`release`, `projection` or `restamp`); and its history result (`bootstrap` or
  `continuity`, the earlier tag, whether the rotation override was used). For a re-stamp it
  also records the earlier manifest's SHA-256 and each copied target's size and SHA-256. The
  top level keeps `tag`, `sourceCommit`, `sourceTree`, `signingKeyId` and `trustedKeyIds`, and
  adds `macos: { kind, architectures }`, checked against the aggregate evidence.

---

## §6 — Client changes (1.7.0)

### 6.1 `electron/update-manifest.cjs`

- The v1 validator keeps its behaviour exactly. The publisher still produces v1 manifests, and
  the Intel fallback reads them.
- Add the v2 catalog and validator (§5.4: the lifetime range, `critical`, skipped types and
  keys) and a v2 entry point to `verifyManifest`. The trust order stays: digest, then
  signature, then schema, then freshness.
- Give the envelope its own schema constant (§5.5).

### 6.2 `electron/update-fetch.cjs`

- Add the two v2 URLs, and allow the two v2 names in the redirect check (`:16`, `:44`). The v1
  URLs stay, for the fallback only.
- New option `translated`: Electron's `app.runningUnderARM64Translation`, which the Electron
  43.8.0 docs describe for macOS and Windows. It only chooses the copy. The test for running as
  arm64 is `process.arch === 'arm64'`: an arm64 process proves the Mac runs arm64 code
  natively. Under Rosetta `process.arch` is `x64` (*probed*: the packaged 1.6.0 app reports
  `x64` and `sysctl.proc_translated` 1 under `arch -x86_64`).
- Selection on macOS:

```text
v2 = fetch and verify update-manifest-v2.json (schema 2)       any failure throws
record v2.version in the v2 mark
if v2.version is older than the higher of the two marks: stale
target = darwin/arm64/dmg if process.arch is arm64 and v2 lists it,
         otherwise darwin/universal/dmg if v2 lists it,
         otherwise darwin/arm64/dmg if v2 lists it (arm64-only)
if there is no target: unsupported
if v2.version is not newer than the running app: current
if target is arm64-only and process.arch is not arm64:
    v1 = fetch and verify update-manifest.json (schema 1)      any failure throws
    record v1.version in the v1 mark
    if v1.version is older than the v1 mark: stale
    if v1.version is newer than the running app:
        offer v1's darwin/universal/dmg target (an ordinary offer, from v1)
    otherwise: available, blocked = "rosetta" if translated, else "apple-silicon"; no artifact
otherwise: offer target (from v2)
```

- Why a failed v1 read throws instead of showing the blocked copy: a check that throws keeps a
  verified download on screen (`electron/update-controller.cjs:568-569`), and so does `stale`
  (`:500-512`), but an `available` result without that artifact prunes it (`:520-526`). An
  Intel Mac on 1.8.0 that already verified the 1.9.0 DMG would otherwise lose it to a
  publication race or a stale v1, and then claim it "stays on 1.8.0". The blocked state, which
  prunes, appears only when the app already runs the newest universal release, so there is
  nothing newer to keep.
- A failed v2 read fails the check as today (`unverified`). There is no general fallback to v1:
  every release from 1.7.0 on carries v2 (G4).
- Linux selection is unchanged.

### 6.3 What the user sees

The status line stays "Agent Inbox 2.0.0 is available." (`public/app.js:8535`), with one of two
reasons under it:

- **`apple-silicon` (Intel Mac):** "It needs a Mac with Apple silicon. This Mac has an Intel
  processor, so Agent Inbox stays on 1.9.0, which keeps working."
- **`rosetta`:** "It runs only natively on Apple silicon, and Agent Inbox is running under
  Rosetta. Quit Agent Inbox, turn off “Open using Rosetta” in its Get Info window in Finder,
  then reopen it to install."

The version is the running app's. Both lines are under 240 characters and contain no slash, so
they pass the controller's copy filter (`electron/update-controller.cjs:36-38`). Download and
Install don't appear.

- **Review release** is hidden for `apple-silicon`. It would open the 2.x page
  (`electron/main.cjs:269-278`) and invite the user to drag the arm64 build over a working
  1.x-last. Main's `update-open-release` handler also refuses in that state. Under `rosetta` it
  stays, because that Mac can run 2.x. (Opening 1.x-last's page instead was considered: it needs
  a second URL carried through the controller, preload and main, and gives an Intel user nothing
  to act on.)
- **Notifications** (decision 4): none for `apple-silicon`, since the user can't change the
  hardware. For `rosetta` the usual one per version, with the body "Version 2.0.0 is available.
  Reopen Agent Inbox without Rosetta to install it."

### 6.4 `electron/update-controller.cjs`

- `safeCheckerState` (`:377-433`) accepts `available.blocked` from a closed set and maps it to
  the fixed copy above: `downloadable: false`, `installable: false`, `reason` set, no artifact.
  The published state keeps `blocked`, so the renderer can hide Review release.
- `notifyAvailable` (`:340-358`) skips an `apple-silicon` offer and passes `blocked` to the
  notifier for a `rosetta` one. Other notify-only offers keep notifying as today.
- An offer remembers which manifest it came from. `recordVerifiedVersion` (`:436-462`) records
  into that manifest's mark, and `highWaterMark()` (`:647-660`) applies §5.6 at install time:
  the higher of the two marks for an offer from v2, the v1 mark for an offer from v1.
- `feasibilityFor` (`:466-477`) also passes the target's `architecture`.

### 6.5 Preload, renderer and main

- `electron/setup-preload.cjs:157-176`: accept `available.blocked` only as `apple-silicon` or
  `rosetta`, and only with a `reason` on an offer that is neither downloadable nor installable.
- `public/app.js:8652`: hide Review release when `available.blocked` is `apple-silicon`.
- `electron/main.cjs`: pass `translated: app.runningUnderARM64Translation === true` to the
  checker (`:903-916`) and `hostArch: process.arch` to `createMacInstaller` (`:966-977`); refuse
  `update-open-release` for an `apple-silicon` offer (`:269-278`); give the notifier its
  `rosetta` copy (`:939-951`).

### 6.6 `electron/update-install-macos.cjs`

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

### 6.7 `electron/update-download.cjs`

- `normalizeArtifact` and `locateVerified` (`:105-144`, `:688-727`) use the v2 catalog, and the
  verified record (`recordFor`, `:150-162`) carries `architecture`. The two DMG types have
  different filenames, so a recorded file still maps to exactly one type.

### 6.8 `electron/update-preferences.cjs`

- `createUpdateTrustState` reads and writes each mark separately (§5.6). The file stays at
  schema 1, so apps from 1.3 to 1.6 keep reading and raising their mark.

### 6.9 What doesn't change

Linux selection and the AppImage proof, `deb-notify`, the #216 install grants and restart
path, Setup, and attention: update state still never reaches `public/attention.js`, the badges
or Needs you.

---

## §7 — Publisher and workflow changes

### 7.1 One source of truth for the macOS kind

The kind of a release, universal or arm64, is measured, not labelled.

- **Expected set.** A committed release input, `macosArchitectures` in
  `release/macos-inputs.json`, says what the build should contain: `["arm64", "x86_64"]` today.
  The release gates read it instead of the hard-coded list
  (`scripts/macos-release-gates.mjs:715-719`). The signer reads it from the release commit, as
  it already reads `release/update-keys.json` (`.github/workflows/macos-release-protected.yml:584`).
  It keeps an accidental change to the build from quietly turning a 1.x release into an arm64
  one.
- **Measured set.** In the notarize job, `verifyFinalDmg` already runs `lipo -archs` on the app
  copied out of the final, stapled DMG. It now records the exact sorted output for the main
  executable (`Contents/MacOS/Agent Inbox`) and the better-sqlite3 addon
  (`Contents/Resources/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node`) in
  the final evidence (§5.7), in place of `universalEnvelope: 'passed'`.
- **Kind.** Both sets equal to each other and to the expected set, and then: `["arm64",
  "x86_64"]` is universal, `["arm64"]` is arm64. Anything else fails the release.
- **Everything else follows from the kind,** through one shared function that the release gates,
  aggregation, the signer and the publish job all use:

| Kind | DMG name | `architecture` | `target` | v2 macOS type | v1 manifest |
| --- | --- | --- | --- | --- | --- |
| universal | `Agent-Inbox-vX.Y.Z-universal.dmg` | `universal` | `darwin-arm64+darwin-x64` | `darwin/universal/dmg` | Projection of v2 |
| arm64 | `Agent-Inbox-vX.Y.Z-arm64.dmg` | `arm64` | `darwin-arm64` | `darwin/arm64/dmg` | Re-stamp |

- **Universal also needs the Intel gate.** The final evidence carries the native Intel gate's
  result, and a universal kind requires it to have passed. #296 removes that gate, so a
  universal label can't outlive it.
- **The chain.** Final evidence (notarize job) → aggregate evidence (verify-publication: copies
  the sets and derives the labels) → the signing handoff → signing evidence → publish. The
  signer and the publish job each recompute the kind from the sets and refuse any disagreement
  with the expected set, the DMG name, the aggregate's labels, the v2 macOS type or the way v1
  was made (G9).
- **What this catches.** A name, label or flag that disagrees with what `lipo` measured, which
  is exactly what #296 could introduce by relaxing the gates and keeping the label. It doesn't
  catch release code that misreports what `lipo` said: the sets are measured by the release's
  own code on the macOS runner, and the trusted jobs run on Linux without the app. That code is
  reviewed like the rest of the release path and must come from a tag on `main`'s first-parent
  history. Reading the executable's header out of the DMG inside the signing job was considered
  and not chosen, because it would parse an untrusted disk image in the job that later handles
  the key.
- **Who changes what.** #295 moves today's hard-coded checks
  (`scripts/macos-release-gates.mjs:715-719`, `:767`, `:807-810`, `:824`, `:906`, and
  `scripts/release-aggregation.mjs:562`, `:591-596`) onto the expected and measured sets, while
  releases are still universal. Every release from 1.7.0 to 1.x-last then runs the new chain
  for real before it matters. #296 changes the expected set to `["arm64"]`, removes the Intel
  gate and the x64 runtime, and makes the release-notes template
  (`.github/workflows/macos-release-protected.yml:445-477`) name 1.x-last for Intel Macs. So
  #296 touches the trust path, through the evidence contract rather than the manifest code, and
  it must not add any other way to set the kind.

### 7.2 `scripts/release-aggregation.mjs`

- The macOS asset's name, `architecture` and `target` are derived from the final evidence's
  sets (`:562`, `:591-596`), and the sets are copied into the aggregate evidence.
  `updateManifestAsset` (`:504-543`) accepts both kinds. The dry run (`:377-436`) follows the
  same function.
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
| G6 | The v1 manifest is the projection of this release's v2 manifest (universal), or the re-stamp of the latest earlier release's v1 manifest (arm64). Either way it describes the newest stable release whose files include a `-universal.dmg` (this release, when it is universal), and its targets match that release's listed sizes and digests | New |
| G7 | The v2 manifest describes this release, and its target set is exactly the set for this kind of release | New; replaces today's v1 identity check (workflow `:586-617`) |
| G8 | In a universal release, v1 and v2 carry the same data apart from `schema` | New; true by construction, checked anyway |
| G9 | The kind measured in §7.1 agrees with the expected set, the DMG name, the aggregate's labels, the v2 macOS type and the way v1 was made; a universal kind also needs the Intel gate's pass | New |
| G10 | The v1 envelope carries a valid signature from `ed25519-99927ba2f6af6482`, the only key 1.2 to 1.6 trust | New |

The check that the earlier manifest's tag equals the planned earlier tag (workflow `:692`)
splits in two. The earlier v2 manifest must describe the earlier release. The earlier v1
manifest must describe either the earlier release (if it was universal) or an older one (if it
was arm64).

G10 turns a future `signingKeyId` switch into a failed release instead of a silent cut-off for
1.2 to 1.6. With today's single-key signer it simply holds; a later rotation passes it only by
dual signing.

### 7.4 `.github/workflows/macos-release-protected.yml`

| Job or step | Change | Lines today |
| --- | --- | --- |
| `notarize-and-finalize` | `verify-final-dmg` records the measured sets against the expected set; `final-evidence` derives the kind and the DMG name and carries the Intel gate's result | `:362-377`, `:423-444` |
| `verify-publication` | Aggregation derives the macOS labels from the sets; the handoff still holds seven release files, the manifest among them now v2 | `:513-546` |
| `sign-update-manifest`: check | Check the unsigned v2 manifest against the release instead of v1, and run G9, reading the expected set from the release commit | `:584-617` |
| `sign-update-manifest`: history | One plan for both manifests; download the earlier v2 pair when it exists, with the same size and digest checks; authorize both | `:619-702` |
| `sign-update-manifest`: derive | Write the v1 manifest by projection or re-stamp, from verified inputs only, and check G6 | New, before signing |
| `sign-update-manifest`: sign | The one existing step signs both files in one process | `:703-715` |
| `sign-update-manifest`: bind | Verify both with the current time; G10; signing evidence schema 2; five handoff files and ten release files | `:716-771` |
| `publish`: names and kind | Ten names. The kind is recomputed from the measured sets in the signed handoff, and the DMG name (one of exactly two), the labels, the v2 macOS type and the way v1 was made must all match it | `:905-917`, `:1154-1160`, `:1290-1299`, `:1327-1337` |
| `publish`: manifests | v2 against the release; v1 against the release in a universal release; G10 | `:918-1117` |
| `publish`: independent re-stamp check | In an arm64 release, list the releases, fetch the earlier release's v1 pair by asset id, check its size and digest against the listing and verify it with the inline Ed25519 code already there; require the new v1 to differ from it only in the four re-stamped fields; check the copied targets against the sizes and digests GitHub lists for the release it describes; and check G6's newest-universal rule itself | New, beside `:918-1117` |
| `publish`: latest | Send `make_latest: "true"` in the final `PATCH`. Required: every release has to become latest for R2 to hold | `:1402-1410` |

What doesn't change: the job graph and its `needs`, the `authorize` and `verify-handoff` jobs,
the environments, secrets, permissions and pinned actions, the tag checks, the draft ownership
markers and cleanup, and the single write step. The private key still reaches one process. The
publish job's new calls are reads with the token it already has.

Where the logic lives: the signing job checks out trusted code, so planning, deriving and
authorizing move into `scripts/update-manifest.mjs` subcommands and the YAML only moves files.
The publish job keeps its own inline checks, because it has no checkout by design; that is what
makes its re-check of the re-stamp independent of the signer.

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
- `CLAUDE.md`: "Signed update-manifest trust contract" (ten files, two manifests, the re-stamp,
  the measured kind, G10); "Rollback high-water mark" (two marks, and the sentence that the
  publisher refuses to sign a version that isn't newer gains the re-stamp exception); "Verified
  update download" (the v2 catalog); "Verified update install on macOS" (the architecture rule,
  the slice check, Review release for Intel).
- `docs/macos-release.md` (steps 6 to 10, the evidence description, the allowlist, and
  "Download verification" at `:477-509`), `docs/linux-release.md` (the allowlist and its
  description, `:358-380`) and `electron/README.md` (the updater overview).
- #296 updates the README, `docs/INSTALL.md` and the website for Intel users.

### 7.7 Operating rules

- Never delete or edit the 1.x-last release's files: the v1 manifest points at them.
- Edit 1.x-last's published notes once, by hand, to say Intel Macs stay on it, keeping the
  `<!-- agent-inbox-release:… -->` marker line as it is. A later re-run of that release's publish
  job would then fail its exact-notes check without changing anything, which is acceptable.
- Publish a release at least every 150 days, or accept that both manifests expire, as the one
  manifest can today.
- Never publish a stable release by hand, or with `make_latest: false`.

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

- **`test/update-manifest.test.ts`:** one case per row of the v2 rules (§5.4): the lifetime
  range (180 days accepted, 181 and 0 refused); a key the reader doesn't know is ignored at the
  top level and in a known target, and a non-empty `critical` is refused; unknown types skipped
  but checked for name format, uniqueness and order; envelope schema 1 for v2. `projectV1`
  output is byte-identical to `generateManifest` for the same evidence. `restampV1` changes only
  the four fields of §5.3, and refuses a forged, schema-2 or not-older earlier manifest and a
  copied target that disagrees with the release listing. History: v2 starts only in a universal
  release; an arm64 release needs an earlier v2; no gaps; no half pairs in either manifest; the
  rotation override is still exact. G6: a v1 that describes an older universal release than the
  newest one is refused. G9: arm64-only evidence that carries the universal DMG name, or the
  `universal` label, is refused; so are sets that disagree between the executable and the addon,
  `x86_64` alone, sets that differ from the expected set, and a universal kind without the Intel
  gate's pass. G10: a v1 envelope without a valid signature from `ed25519-99927ba2f6af6482` is
  refused.
- **`test/macos-release-gates.test.ts` and `test/release-aggregation.test.ts`** (`:414`,
  `:502`): the final evidence records both sets from `lipo` output; the DMG name, `architecture`
  and `target` are derived from them, and the same arm64-only-but-universal-label cases are
  refused there too; the v2 output and the ten-file dry-run inventory.
- **`test/update-fetch.test.ts`:** the v2 URLs and redirect names (extends `:158`); the selection
  matrix, macOS `arm64`, `x64` and `x64` under Rosetta against "universal only", "arm64 only"
  and "both", with Linux unchanged (extends `:440-473`). The Intel fallback: v1 newer gives an
  ordinary offer from v1; v1 equal gives the blocked state; v1 stale gives `stale`; v1 missing,
  expired, invalid or mismatched with its signature throws. Stale rules with two marks; the
  existing #148 suite (`:581-906`) runs for each mark.
- **`test/update-controller.test.ts`:** a blocked offer is notify-only with the fixed copy and
  never downloadable. With a verified 1.9.0 download on screen, a check whose v1 read throws or
  is stale keeps the download; only a blocked result at the newest universal release prunes. No
  notification for `apple-silicon`; one per version for `rosetta`, with its own body. At install
  time a v2 offer below the higher of the two marks is refused, and a v1 offer is checked against
  the v1 mark only. The feasibility call shapes (`:887`, `:981`) gain `architecture`.
- **`test/update-install-macos.test.ts`:** feasibility refuses an arm64 target on `x64` and
  accepts it on `arm64`; `prepare()` refuses before any filesystem call; the slice check against
  header fixtures: fat with both CPU types, thin arm64, thin x86_64, a Java class file (also
  `0xcafebabe`, with a large count), a truncated file and a symbolic link.
- **`test/update-download.test.ts`:** the arm64 DMG round-trips through `normalizeArtifact`,
  `recordFor` and `locateVerified`; a universal filename claimed as arm64 is refused, and the
  reverse.
- **`test/electron-updates.test.ts`:** every new state passes the real preload validator
  (extends `:217`), and `blocked` is refused with any other value or on a downloadable offer;
  `main.cjs` passes `translated` and `hostArch` (source pins like `:688`), refuses
  `update-open-release` for an `apple-silicon` offer, and has the `rosetta` notification copy.
- **`test/dom/updates.test.ts`:** `apple-silicon` shows its copy with only Check now; `rosetta`
  shows its copy with Check now and Review release.
- **Shipped readers (§8.1 fixtures):** they accept every v1 manifest the new publisher can
  produce (projection and re-stamp), read a re-stamped manifest as up to date at its own
  version, reject every v2 manifest on `schema`, and keep `highestVerifiedVersionV2` when they
  raise their own mark.

### 8.3 End-to-end tests of the hand-off (`test/update-lanes.test.ts`)

A synthetic history, 1.6.0, 1.7.0, 1.8.0, 1.9.0, 2.0.0, 2.0.1, built only by the publisher
functions and served through a fake `latest`. After each release, the test runs the shipped
1.2.x and 1.6.0 readers and the new reader for each host (Intel Mac, Apple silicon Mac, Rosetta,
and Linux x64 and arm64 with AppImage and DEB). It installs whatever is offered and repeats
until nothing is. It asserts:

- the paths in §4.4, including an Intel Mac on 1.8.0 reaching 1.9.0 through the fallback;
- no v1 reader is ever offered a 2.x file;
- no app running as `x64` on macOS is ever offered a downloadable arm64 build;
- nothing reads as stale along the way;
- an Intel Mac on 1.8.0 holding a verified 1.9.0 download keeps it when the v1 read hits the
  publication race (a manifest from one release, a signature from the next) or a stale v1;
- 181 days after the last re-stamp, v1 readers show `unverified` and are offered nothing.

A downgrade test on one shared `update-trust-state.json`: run the new reader at 2.0.1 (on an
Apple silicon Mac and on an Intel Mac), then the pinned 1.6.0 reader on the same file. 1.6.0 is
offered 1.x-last and never reads `stale`, `highestVerifiedVersion` never holds a 2.x version, and
`highestVerifiedVersionV2` survives 1.6.0's write.

### 8.4 Workflow

- **`test/macos-release-workflow.test.ts`** already runs the real publish script
  (`extractPublisherScript`, `:23`) against a fake `gh`. It gets handoffs for a universal and an
  arm64 release, and must refuse: arm64-only measured sets with the universal name or label; a
  missing or extra pair; a v1 manifest that isn't the release (universal); in an arm64 release,
  a v1 manifest that differs from the earlier v1 pair it fetches by more than the four
  re-stamped fields, copied targets that don't match the sizes and digests in the fake release
  listing, and a described release that isn't the newest with a `-universal.dmg`; a v1 envelope
  without the original key's signature; a v2 manifest for another release.
- Source pins: the key appears only in the one signing step; no new job, secret, permission or
  action; the final `PATCH` sends `make_latest: "true"`.

### 8.5 Manual checks on hardware

- **After 1.7.0 is published:** Settings → Updates says it is up to date, through v2, on an
  Apple silicon Mac, an Intel Mac, under Rosetta, and on a Linux AppImage and DEB. A 1.6 app on
  each is offered 1.7.0 through v1 and installs it.
- **Before tagging 2.0.0, a rehearsal of 1.x-last's Intel path (a gate for the tag).** Run it on
  an Intel Mac and on an Apple silicon Mac under Rosetta, in test user accounts, because the
  relaunched app uses that account's `~/.agent-inbox`.
  - **Code under test:** 1.x-last's own updater modules, loaded from the installed app bundle
    and run by the bundle's own Electron in Node mode, with `arch -x86_64` in front for Rosetta:

    ```sh
    ELECTRON_RUN_AS_NODE=1 "/path/to/Agent Inbox.app/Contents/MacOS/Agent Inbox" rehearsal.cjs
    ```

    *Probed* on the installed 1.6.0 app: natively it reports `arm64` and Electron 43.8.0; under
    `arch -x86_64` it reports `x64` with `sysctl.proc_translated` 1. The packaging keeps
    Electron's Node-mode fuse on, because the SQLite check needs it
    (`scripts/electron-sqlite-check.mjs:35`, `:125-126`). No test hook enters the shipped app.
  - **Harness:** a committed script that isn't packaged (for example `test/rehearsal/`). It
    builds the controller the way `electron/main.cjs:896-956` does and injects only a scratch
    registry, a `fetch` that serves the scratch-signed manifest pairs for the four manifest URLs
    and passes every other request to the real `fetch`, `currentVersion`, `translated` from
    `sysctl.proc_translated`, and scratch `userData` folders.
  - **Manifests,** both signed with the scratch key: a v2 manifest listing only an arm64 DMG
    (plus the Linux packages), and a v1 manifest that re-stamps 1.x-last's real published one,
    so its target is the real, notarized 1.x-last DMG.
  - **Runs:** (1) `currentVersion` older than 1.x-last, with the installer's `bundlePath` on a
    scratch copy of an older app: the fallback offers 1.x-last; the real DMG downloads and
    verifies; `prepare()` passes codesign, Gatekeeper and the slice check; the helper swaps the
    app after the script exits; and the swapped app opens and reports 1.x-last. (2)
    `currentVersion` equal to 1.x-last: the blocked state with the right copy and `blocked`
    value, no artifact, and no request for the arm64 DMG. (3) A v1 pair that is missing, or
    whose manifest and signature come from different releases, ends `unverified` and keeps a
    verified download; a v1 older than the v1 mark ends `stale`.
  - main.cjs wiring and the renderer aren't in this harness; §8.2's source pins and DOM tests
    cover them.
- **After 2.0.0 is published:** the checks in §4.3, step 7.

---

## §9 — Risks

1. **Choosing 1.x-last wrongly.** Low. A universal release published after the intended 1.x-last
   becomes the v1 target by itself (I1); only its notes would need the hand edit instead.
2. **More than 180 days between releases.** Both manifests expire, as the one does today. Every
   app shows "Couldn't check right now" and nothing unsafe is offered. Mitigation: §7.7.
3. **Losing or retiring the original key.** Apps from 1.2 to 1.6 trust only
   `ed25519-99927ba2f6af6482`, and Intel Macs on 1.x-last trust only 1.x-last's registry, for
   good. Losing that key ends update checks for both groups. G10 makes a switch away from it
   fail loudly instead of silently. Mitigation: decision 7.
4. **A wrong re-stamp.** A copy that drifted would mislead old apps. The signer derives it from
   the verified earlier manifest and checks it against the published files of the release it
   describes; the publish job then fetches the earlier manifest itself and repeats every check,
   with its own code (§7.4).
5. **No fixes for Intel Macs after 1.x-last.** Release tags must increase, so a 1.x release
   after 2.0.0 is refused, and any defect in 1.x-last's Intel path is permanent. Mitigation: the
   rehearsal gate before 2.0.0 (§8.5). A security fix for Intel would need its own design.
6. **Rosetta users reopen once.** Someone who opened the app with "Open using Rosetta" must
   reopen it natively to install 2.x. They get one notification per version saying so
   (decisions 3 and 4).
7. **A race at publication.** An app can read a manifest from one release and its signature
   from the next. Verification fails, the check ends `unverified` and keeps any verified
   download, and the next daily check succeeds. This exists today.
8. **Two requests a day on Intel Macs.** The fallback reads v1 as well. Both files are small.
9. **Code that first runs at 2.0.0.** The arm64 branches of the publisher and the Intel copy
   first run for real at 2.0.0. The fixture runs in §8.3 and §8.4 and the hardware rehearsal in
   §8.5 cover them, and §4.3 step 7 checks them on the day.
10. **A skipped type or key.** A later manifest can carry a type or key an older reader skips.
    For that reader it means "no update for this host" or an ignored detail, never a wrong
    install; a field that must not be ignored goes in `critical`.
11. **Release code that misreports `lipo`.** The measured sets come from the release's own code
    on the macOS runner; the trusted jobs only check that every label agrees with them (§7.1).
    This is the same trust the release path already has in its own gates, and that code is
    reviewed and tagged from `main`'s first-parent history.
12. **An Intel user downloads 2.x by hand.** The releases page lists 2.x as latest, and dragging
    its app over a working 1.x-last breaks the install. The app never links there from the
    Intel state, the file name says `arm64`, and the 2.x notes, README and website say Intel Macs
    stay on 1.x-last (#296).

---

## §10 — Decisions for Shariq

**1. Which approach?**
- **A. A second manifest, with v1 frozen and re-stamped in every release (recommended).** Old
  apps keep being guided to 1.x-last while releases continue. It costs one narrow signing
  exception, which the publish job re-checks on its own.
- B. Copy 1.x-last's v1 pair forward unchanged. No signing exception, but 180 days after
  1.x-last's tag every app from 1.2 to 1.6 loses update checks, and Intel Macs on 1.7.0 to just
  before 1.x-last lose their way to 1.x-last at the same moment.
- C. Keep 1.x-last as GitHub's latest release. It needs a second way for new apps to find 2.x,
  and replacing files on a published release.

**2. What is the arm64 DMG called?** The measured kind decides which name a release uses
(§7.1); this only picks the arm64 one. Apps from 1.7.0 on check it, so it can't change later
without another transition.
- **A. `Agent-Inbox-vX.Y.Z-arm64.dmg` (recommended).** It matches `-universal.dmg` and the
  `arm64` in the Linux package names.
- B. `Agent-Inbox-vX.Y.Z-macos-arm64.dmg`. It names the platform, as the Linux AppImages do.
- C. `Agent-Inbox-vX.Y.Z-apple-silicon.dmg`. Plainest for people choosing a download, but not the
  architecture name used elsewhere.

**3. Under Rosetta, refuse the arm64 build or allow it?**
- **A. Refuse, with copy that says how to reopen without Rosetta (recommended, and what the
  issue asks for).** The rule rests on one fact the process can prove: it runs as arm64.
- B. Allow it when Electron reports translation. This can't be built as written: the staged-app
  check (§6.6) requires a slice for `process.arch`, which is x86_64 under Rosetta, so an
  arm64-only app fails it. Allowing would mean weakening that check too.

**4. Which blocked offers raise a notification?**
- **A. None for `apple-silicon`; for `rosetta`, the usual one per version, saying to reopen
  without Rosetta (recommended).** An Intel user can't do anything about it; a Rosetta user can.
- B. One notification per major version (2.0, 3.0) for both.
- C. None for either; Settings → Updates explains.

**5. How forgiving should v2 readers be?**
- **A. Skip unknown target types, ignore unknown keys unless `critical` names them, and accept
  any lifetime up to 180 days (recommended).** New packages, optional fields and shorter
  lifetimes then need no transition, while the required fields of known types stay strict and
  `critical` can still force old readers to refuse.
- B. A closed set and exact keys, as in v1. Anything beyond the six known types needs another
  transition.

**6. How long should releases keep re-stamping v1?**
- **A. In every release, with no end date (recommended).** A re-stamp costs nothing, and it is
  how apps from 1.2 to 1.6, and Intel Macs on 1.7.0 to just before 1.x-last, reach 1.x-last.
- B. Until a set date, for example 12 months after 2.0.0. 180 days after the last re-stamp,
  apps from 1.2 to 1.6 show "Couldn't check right now", and Intel Macs on 1.7.0 to just before
  1.x-last can no longer reach 1.x-last: their v1 read fails, which ends the check `unverified`.

**7. Should a backup public key be added before 1.x-last?**
- **A. Yes, in a small separate PR, ideally before 1.7.0 and at the latest before 1.x-last
  (recommended).** Generate a second Ed25519 key, keep its private half offline, and add only
  its public key to `release/update-keys.json`. The original key stays `signingKeyId`, and every
  later manifest lists both in `trustedKeyIds`, which also authorizes a later switch without the
  emergency override. Every app from the release that adds it, including Intel Macs that stay
  on 1.x-last for good, could then follow a rotation without dual signing. Apps from 1.2 to 1.6
  can't gain it either way, so G10 still requires the original key's signature on v1.
- B. No. A later rotation relies on dual signing for as long as those apps matter.

**8. Which release is 1.x-last, and what has to happen before 2.0.0?**
- **A. Whichever 1.x is the last one before #296 is ready (recommended).** Before tagging 2.0.0,
  require at least one published universal release that carries v2 (1.7.0 counts), the
  hardware checks of §8.5, and the rehearsal of 1.x-last's updater on an Intel Mac and under
  Rosetta through a real install of its real DMG (§8.5). Edit 1.x-last's notes by hand once it is
  chosen (§7.7).
- B. Pick a version now, for example 1.9.0, and hold #296 until it ships. The same gates apply.

---

## §11 — Not in scope

- The arm64 build itself, its signing and notarization, the switch of the release gates and
  notes template to the measured arm64 set (§4.3, step 5), and the README and website changes
  (#296).
- Windows update targets (#85, #87). v2 leaves room for them; nothing is added now.
- Fixes for Intel Macs after 1.x-last.
- Downloading Setup's runtime on demand (V5 in the efficiency audit).
- The dual-key signer itself.

---

## §12 — Revision history

- **2026-10-23, first draft.**
- **2026-10-23, after an independent review.** Whether a release is universal now comes from
  the CPU types measured in its shipped binary and is enforced by both trusted jobs (§7.1, G9,
  R10, I7); #296 changes that evidence contract. A missing, expired or invalid v1 read fails the
  check, and a stale one returns `stale`, so a verified download is never pruned by mistake
  (§6.2). The publish job re-checks the re-stamp from GitHub on its own (§7.4). Review release
  is hidden for Intel Macs (§6.3). A hardware rehearsal of 1.x-last's Intel path gates 2.0.0
  (§8.5). Install-time marks match check-time marks, and a downgrade test pins the trust-state
  file (§5.6, §8.3). Also: notifications split by reason, decision 3's option B marked as not
  buildable as written, decision 6's option B also strands some Intel Macs, G10 requires the
  original key on v1, v2 accepts unknown keys under a `critical` rule and lifetimes up to 180
  days, 1.x-last's notes get a hand edit, and `make_latest: "true"` is required.
