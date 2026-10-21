# Design: update signing-key rotation (issue #148)

**Date:** 2026-10-21
**Status:** Draft for review. Four decisions in §12 need the owner.
**Milestone:** v1.5. Completes #148. The rollback high-water mark, the other half of
#148, shipped in v1.3 (#198) and is not changed here.
**Scope of this PR:** this document only. Zero source, test or workflow changes.

## §0 — Summary

Today one Ed25519 key (`ed25519-99927ba2f6af6482`) signs every update manifest, and every
shipped client (1.2.0 and later) trusts exactly that key, baked into the app in
`release/update-keys.json`. There is no way to replace it without stranding clients.

This design adds three things:

1. **A key chain.** Each release publishes a new asset, `update-keychain.json`. It holds
   an append-only list of signed *keyset statements*. Statement *n* names the full set of
   trusted keys at sequence *n*. It is signed by at least one key from set *n − 1* and by
   every key it adds.
2. **Client adoption.** A 1.5+ client starts from its baked key set, walks the chain one
   link at a time, and stores the newest verified set in `update-trust-state.json` (never
   `update-preferences.json`). It then verifies the manifest with that set.
3. **Dual signing in the protected pipeline.** The single secret-bearing step loads up to
   two private keys from two fixed secret slots, signs the manifest with every key in the
   registry's signing set, and signs a new chain link when the registry's sequence moves.

A planned rotation is two releases: a **transition release** that adds the new key and
signs everything with old and new keys, and, at least 180 days later, a **retirement
release** that drops the old key. Clients on 1.2.x–1.4.x keep working through the overlap
because their old key still signs. They must update to a build that knows the new key
before retirement, or reinstall. Clients on 1.5+ recover on their own even if they skip
the whole overlap, as long as the old key was not compromised.

Manifest schema 1 and signature-envelope schema 1 do not change. Every shipped client
already ignores envelope entries for unknown keys, so a dual-signed manifest is valid for
all of them today.

## §1 — What exists today

**Trust anchor.** `release/update-keys.json` is registry schema 1:
`{ schema: 1, signingKeyId, keys: [{ keyId, algorithm, publicKeySpkiBase64 }] }`. The
packaged app reads it once at startup (`electron/update-trust.cjs`). A missing or invalid
file disables update checks with one generic log line.

**Manifest.** `update-manifest.json`, schema 1, parsed with exact keys. It carries
`signingKeyId` and a sorted `trustedKeyIds` list. Clients do not use either field for
verification; the publisher uses `trustedKeyIds` for continuity. Adding a field to the
manifest breaks every shipped client, because `validateManifest` rejects unknown keys.

**Envelope.** `update-manifest.json.sig`, schema 1:
`{ schema, manifestSha256, signatures: [{ algorithm, keyId, signature }] }`, sorted by
`keyId`, no duplicates. `verifyManifest` validates the shape of every entry, ignores
entries whose key is not in the registry, and passes when at least one known-key entry
verifies. This has been true since 1.2.0 (checked against `v1.2.0`, `v1.3.0`, `v1.4.0`).
An envelope with only unknown keys fails.

**Fetch.** Clients fetch only
`https://github.com/shariqh/agent-inbox/releases/latest/download/update-manifest.json`
and its `.sig`. `GITHUB_RELEASE_PATH_RE` in `electron/update-fetch.cjs` allows only those
two asset names.

**Rollback mark.** `update-trust-state.json` (`{ schema: 1, highestVerifiedVersion }`,
`createUpdateTrustState`). Its reader tolerates extra fields and a raise keeps them
(`{ ...current.record, schema: 1, highestVerifiedVersion }`). A file with a higher schema
is enforced but never written. 1.2.x builds do not read it.

**Publisher.** The `sign-update-manifest` job in `.github/workflows/macos-release-protected.yml`
runs in the `macos-release` environment (required reviewer). It:

1. checks that the unsigned manifest matches the registry at the release commit;
2. finds the newest prior stable release (`inspect-history`) and downloads its manifest
   pair;
3. runs `authorize-history`: the prior manifest must verify under the *new* registry
   (no expiry check), and the new `signingKeyId` must be in the prior `trustedKeyIds`,
   unless the environment variable `AGENT_INBOX_UPDATE_KEY_ROTATION_OVERRIDE` equals
   `ALLOW-UPDATE-KEY-ROTATION:<tag>:<keyId>`;
4. in one step, gives one Node process `AGENT_INBOX_UPDATE_PRIVATE_KEY_BASE64`, which must
   derive `registry.signingKeyId`, and writes a one-entry envelope;
5. re-verifies with `--now` and records evidence that the signer set is exactly
   `[registry.signingKeyId]`.

The publish job verifies eight remote assets (five packages, `SHA256SUMS.txt`, the
manifest and its signature) before undrafting.

## §2 — Threat model and goals

### 2.1 What rotation protects against

- **A retired key.** We want to stop using a key (age, hygiene, a change of custody)
  without stranding clients.
- **A suspected or confirmed compromise of the signing key.** An attacker with the key
  and control of what a client downloads can make that client accept a forged manifest.
  After rotation, clients that have adopted a key set without the compromised key reject
  anything signed only by it.
- **A key the publisher can no longer use** (secret lost). This design cannot keep clients
  on the update path in that case; it defines a clean re-anchor and says that clients need
  a manual reinstall (§4.4).

### 2.2 What it does not protect against

- **A client that trusts only a compromised key.** Anything that key signs, including a
  forged chain link, is valid for that client. No in-band scheme fixes this. Those clients
  are safe only if the attacker cannot also serve them content. Recovery is a manual
  reinstall from a trusted source.
- **Compromise of the protected pipeline itself** (environment secrets, reviewer
  approval, the default branch). Rotation assumes the pipeline is trusted at the moment it
  signs.
- **Local tampering** with the app bundle or `update-trust-state.json`. The local user can
  already replace the app.
- **Withholding.** A network attacker can always deny updates by serving nothing or stale
  bytes. The rollback mark already stops stale manifests from being *offered*; this design
  does not try to stop denial of service.
- **Platform signing.** Apple Developer ID, notarization and AppImage packaging are
  separate trust paths and out of scope.

### 2.3 Guarantees after this change

1. Every manifest is signed by every key in the registry's signing set. During an overlap
   that is the old and the new key.
2. A client verifies a manifest only with keys it trusts: its baked set, or a set it
   reached by walking verified chain links from its baked set. An unknown key never counts.
3. A 1.5+ client that has adopted a set without key K rejects a manifest signed only by K.
4. The adopted key-set sequence and the rollback mark never go down.
5. **Supported direct-upgrade floor.** This is the oldest installed build that still
   finds and verifies the newest release with no manual step. Before any rotation and
   during an overlap it is 1.2.0, because the old key still signs. After retirement it is
   1.5.0: a 1.5+ build recovers through the chain whenever it next checks. A 1.2.x–1.4.x
   install is still covered only if the user installed the transition release or a later
   build during the overlap. One that did not falls below the floor and needs a manual
   reinstall. Settings → Updates already sends it to the releases page.
6. A planned retirement cannot happen less than 180 days after the transition release
   unless an explicit, tag-bound override is set in the protected environment.

## §3 — Data formats

All new documents are strict: exact key sets, canonical JSON (2-space indent, trailing
newline), whole-second UTC timestamps, sorted key lists. They are parsed only after their
signature verifies, matching the existing trust order.

### 3.1 Registry schema 2 (`release/update-keys.json`, baked into the app)

```json
{
  "schema": 2,
  "sequence": 1,
  "signingKeyIds": ["ed25519-99927ba2f6af6482"],
  "keys": [
    { "keyId": "ed25519-99927ba2f6af6482", "algorithm": "ed25519",
      "publicKeySpkiBase64": "MCowBQYDK2VwAyEAshsgCvPUphCyxSv/sgvDCBvdde/Ws+CU0Fgdl62SU/k=" }
  ]
}
```

- `keys` is the trusted set at `sequence`. Key ids still derive from the SPKI bytes.
- `signingKeyIds` is sorted, non-empty, at most two entries, and a subset of `keys`.
- `parseRegistry` in 1.5 accepts schema 1 as `sequence: 1`,
  `signingKeyIds: [signingKeyId]`, so older material (prior tags, tests) still parses.
  The file in the repository moves to schema 2 in the first implementation PR.
- The manifest's schema-1 `signingKeyId` field is filled with the signing key that
  entered the trusted set most recently (by chain sequence). It is informational.
  `trustedKeyIds` stays `keys` sorted.

### 3.2 Keyset statement (the signed bytes of one chain link)

```json
{
  "schema": 1,
  "kind": "agent-inbox-update-keyset",
  "repository": "shariqh/agent-inbox",
  "sequence": 2,
  "issuedAt": "2027-01-15T12:00:00Z",
  "keys": [ { "keyId": "…", "algorithm": "ed25519", "publicKeySpkiBase64": "…" } ]
}
```

- `issuedAt` is the release's tag time, so a re-run signs identical bytes (Ed25519 is
  deterministic, so the signature is identical too).
- `kind` separates statements from manifests. A statement can never parse as a manifest
  and the reverse, so a signature on one cannot be replayed as the other.
- The statement is signed with the existing envelope schema 1 (its digest field keeps the
  name `manifestSha256`; it is the SHA-256 of the statement bytes).

**Link rule** (shared by client and publisher). Link *n* is valid against trusted set
*S(n − 1)* when:

1. `sequence` is exactly *n* (no gaps, no repeats);
2. the envelope digest matches the statement bytes;
3. at least one envelope entry by a key in *S(n − 1)* verifies (endorsement);
4. for every key in the statement that is not in *S(n − 1)*, an entry by that key verifies
   (proof the publisher holds it, and protection against a typo'd public key);
5. the statement parses strictly, `keys` is non-empty and every id derives from its SPKI.

Then *S(n)* = the statement's `keys`. Keys left out are no longer trusted.

### 3.3 Key chain asset (`update-keychain.json`, published with every release)

```json
{
  "schema": 1,
  "kind": "agent-inbox-update-keychain",
  "repository": "shariqh/agent-inbox",
  "genesis": { "sequence": 1, "keys": [ { "keyId": "ed25519-99927ba2f6af6482", "…": "…" } ] },
  "links": [
    { "statement": "<canonical base64 of the exact statement bytes>",
      "envelope": { "schema": 1, "manifestSha256": "…", "signatures": [ … ] } }
  ]
}
```

- The file itself is not signed. Each link carries its own signatures.
- `genesis` is for the publisher and tests. Clients ignore it and start from their baked
  registry. Genesis is pinned by a committed file, `release/update-keychain-genesis.json`,
  and by a test that names today's key id.
- Limits: 64 KiB, 32 links. Before the first rotation `links` is `[]`. 1.5.0 publishes
  that empty chain so the client fetch path is exercised from day one.

### 3.4 Client trust state (`update-trust-state.json`, schema stays 1)

```json
{
  "schema": 1,
  "highestVerifiedVersion": "1.5.3",
  "keyset": {
    "sequence": 2,
    "statementSha256": "…",
    "keys": [ { "keyId": "…", "algorithm": "ed25519", "publicKeySpkiBase64": "…" } ]
  }
}
```

The schema number stays 1 on purpose. A schema bump would make 1.3/1.4 treat the file as
read-only, and they would stop raising the rollback mark after a downgrade. With schema 1,
1.3/1.4 keep `keyset` intact when they raise the mark (they spread the record), and 1.5
keeps `highestVerifiedVersion` intact when it adopts a key set. Both writes go through the
existing lock and atomic rename. `update-preferences.json` is not touched: 1.2.x parses it
with an exact key set and would silently turn automatic checks off.

## §4 — Client side (1.5 and later)

### 4.1 One check

1. Fetch `releases/latest/download/update-keychain.json` (cap 64 KiB, same redirect and
   host rules as the manifest; `GITHUB_RELEASE_PATH_RE` gains this one name). A 404 or
   network error is not fatal; continue with the current set.
2. Compute the **current set**: the baked registry or the stored `keyset`, whichever has
   the higher sequence (§4.3).
3. Walk `links` in order. Skip links with `sequence` ≤ current. Apply the link rule to
   each next link. Stop at the first link that fails; never skip over it. A failing link
   is logged once, generically.
4. If the walk advanced, persist the new `keyset` under the lock: write only if its
   sequence is higher than the stored one, re-reading inside the lock as
   `recordVerifiedVersion` does.
5. Fetch the manifest and envelope and call `verifyManifest` with the current set
   (unchanged function; the registry argument becomes the effective set).
6. Record the rollback mark exactly as today. Adoption and the mark are independent. A
   transition release raises the mark like any other release, and adopting keys never
   resets or skips the mark.

The keychain is fetched before the manifest because a manifest signed only by a new key
cannot be verified until the link is adopted. The two fetches can straddle a release being
published. That causes at most one failed check; the next one succeeds.

### 4.2 Unknown keys

Unchanged: entries for unknown keys are ignored, at least one known-key entry must verify.
New: when the envelope has no entry from any trusted key and the walk did not help, the
status is a new calm state, `untrusted-key`: "This version can't verify new releases. Download
the latest version from the releases page." It is not an error loop, not attention, not a
badge, and it does not touch the rollback mark. Today the same case shows the generic
"could not be verified" message.

### 4.3 Baked registry vs adopted set

- Baked sequence higher than stored: use the baked set and replace the stored `keyset`
  with it on the next write. A fresh install of a newer build is authoritative.
- Stored sequence higher: use the stored set. This covers a 1.5+ build reinstalled after
  the chain moved on.
- Equal sequence, same keys: either.
- Equal sequence, different keys: this means a forged or broken record. Use the baked set,
  replace the stored record, log once. The code-signed app is the stronger anchor.
- A stored `keyset` that fails strict parsing is ignored (baked set used) and overwritten
  by the next adoption. The rollback mark in the same file is unaffected, as today.

### 4.4 After the old key is retired

A 1.5+ client that adopted sequence 3 (`{K2}`) no longer trusts K1, even though its baked
registry (sequence 1) still lists K1. A forged K1-only manifest fails. A 1.5+ client that
was offline for the whole overlap walks link 2 (signed by K1 and K2) and link 3 (signed by
K2) on its next check and continues.

### 4.5 Missed transition and reinstall recovery

| Client | Missed the overlap? | Result |
| --- | --- | --- |
| 1.2.x–1.4.x | No, installed the transition release or later | Baked set includes K2. Continues. |
| 1.2.x–1.4.x | Yes | `could not be verified`. Manual reinstall of the latest build. |
| 1.5+ | Yes | Walks the chain on the next check. Continues. |
| 1.5+, old key compromised | Either | Walks the chain too, but an attacker holding K1 and controlling the download can feed it a forged link 2. See §2.2. |
| Any, after deleting the settings folder | — | Starts from the baked set; a 1.5+ build re-walks the chain. The rollback mark resets, as documented today. |
| Reinstall of an older 1.5+ build | — | Stored set (higher sequence) wins; rollback mark still blocks older offers. |

### 4.6 Lost key (re-anchor)

If the publisher can no longer sign with any key in the current set, no valid link can be
made. The owner commits a new genesis (`release/update-keychain-genesis.json`) with the new
key at the next sequence number, and the release uses the existing tag-bound
`ALLOW-UPDATE-KEY-ROTATION` override. Clients cannot verify that link and stay at their last
set, showing `untrusted-key`. A reinstall gives them a baked registry at the new sequence,
after which the new chain verifies. This is the only path that strands 1.5+ clients, and it
needs both a reviewed PR and the protected override.

## §5 — Publisher side

### 5.1 Secrets and the single secret-bearing step

- Two fixed secret slots in the `macos-release` environment:
  `AGENT_INBOX_UPDATE_PRIVATE_KEY_BASE64` (slot A, today's secret, unchanged) and
  `AGENT_INBOX_UPDATE_PRIVATE_KEY_B_BASE64` (slot B, new). Slots are not tied to old or
  new. The next rotation reuses whichever slot is free.
- The existing "Sign exact deterministic update manifest" step stays the only step that
  receives secrets. It passes both slots to one `update-manifest.mjs sign` process.
- The CLI decodes each non-empty slot, derives its key id, and requires the set of loaded
  ids to equal `registry.signingKeyIds` exactly. A loaded key that is not in the signing
  set is an error, so a stale secret left after retirement blocks the release until it is
  deleted. Each slot gets the same canonical-base64 checks, buffer zeroing and env deletion
  as today. No key material reaches stdout, stderr or files.
- In the same process the CLI signs: (a) the manifest with every signing key, and (b) when
  the registry's sequence is one above the prior chain head, the new statement with every
  signing key that is in the old set or the new set (§3.2 rules 3 and 4). It writes the
  envelope and the extended chain.
- The bind step verifies both outputs with public material only and records in
  `update-signing-evidence.json`: the signer set, the chain head sequence and statement
  digest, and which overrides were used.

### 5.2 Authorizing a registry change

The registry changes only through a reviewed PR to the default branch. The protected job
reads the registry from the release commit, as now. `authorize-history` gains these rules
and runs before any secret is exposed:

1. **Prior chain.** Download the prior release's `update-keychain.json` (required once any
   prior stable release has published one; same anti-brick rule as the manifest pair).
   Verify it link by link from the committed genesis. Before the first 1.5 release there
   is no prior chain; start from genesis.
2. **Prior manifest.** Verify it against the prior chain head's key set, not the new
   registry. This lets a retirement release verify a prior manifest signed only by a key it
   just dropped. No expiry check, as today.
3. **Chain extension.** The new chain must equal the prior chain plus at most one new link,
   byte for byte. The head after extension must equal the registry: same sequence, same
   keys.
4. **Signing set.** Every key in `signingKeyIds` must be in the prior head set, or be added
   by this release's new link while at least one other signing key is in the prior head
   set. This replaces "new `signingKeyId` ∈ prior `trustedKeyIds`" and makes a planned
   rotation need no override.
5. **Retirement.** If the new link removes a key, every remaining signing key must have
   been trusted for at least 180 days, measured from the `issuedAt` of the link that added
   it, to the release's tag time. Otherwise the release needs
   `AGENT_INBOX_UPDATE_KEY_RETIREMENT_OVERRIDE` =
   `ALLOW-UPDATE-KEY-RETIREMENT:<tag>:<removedKeyId>` (a new environment variable,
   normally unset, same shape as the existing override).
6. **Re-anchor.** If the committed genesis changed, the release needs the existing
   `ALLOW-UPDATE-KEY-ROTATION:<tag>:<keyId>` override. The prior chain is then not
   extended, and the new chain starts from the new genesis.

`trustedKeyIds` in the manifest stays the sorted trusted set. Nothing on the client reads
it; it remains a published record of the set.

### 5.3 Publication

The publication allowlist grows from eight to nine assets: `update-keychain.json` is added.
It is not listed in `SHA256SUMS.txt`, like the manifest pair. The publish job verifies the
remote keychain bytes and re-runs the chain walk from genesis before undrafting.

### 5.4 Overlap length

Every release from the transition release until the retirement release is dual-signed. The
pipeline enforces a minimum of 180 days (§5.2 rule 5). 180 days equals the manifest
lifetime, so every K1-only manifest a client might still hold has expired before K1 stops
signing. There is no maximum. The owner decides when to retire (§11, question 1).

## §6 — Compatibility

- **1.2.x–1.4.x clients.** They fetch only the manifest pair, ignore the keychain, and
  verify the dual-signed envelope through the old key. Envelope size is about 400 bytes,
  well under the 16 KiB cap. After retirement they fail with their existing generic message.
  A 1.3/1.4 build sharing the settings folder with 1.5 keeps the `keyset` field when it
  raises the mark. 1.2.x never touches the trust-state file.
- **Mixed fleets.** All builds read the same `latest` assets; each verifies with what it
  knows. Nothing in the format depends on the client version.
- **Downgrade.** A 1.5+ build reinstalled at an older version uses the stored set if it is
  newer than its baked one. Downgrading to 1.2.x–1.4.x after retirement loses update checks
  (baked K1 only) until a 1.5+ build runs again. The stored state is not damaged.
- **Older tags and re-runs.** `parseRegistry` accepts schema 1, so verifying or re-running
  older material keeps working.
- **No manifest or envelope schema bump.** This is the main compatibility constraint and
  the reason the key material travels in a separate asset.

## §7 — Failure modes

| Failure | Behavior |
| --- | --- |
| Keychain 404, timeout, oversize, malformed | Ignored. Verify with the current set. |
| Link fails the link rule | Walk stops there. Earlier adopted links stay. Logged once. |
| Link sequence gap or repeat | Treated as a failing link. |
| Trust-state write fails | Use the walked set for this check only; retry adoption next check. |
| Stored keyset unreadable | Ignored; baked set used; next adoption overwrites it. |
| Manifest signed only by unknown keys | `untrusted-key` state. No mark change. |
| Publisher: secret slot holds a key outside the signing set | Sign step fails. Nothing published. |
| Publisher: signing set key missing from slots | Sign step fails. |
| Publisher: prior chain does not verify from genesis | Authorization fails before secrets. |
| Publisher: new chain is not prior + ≤ 1 link, or head ≠ registry | Authorization fails before secrets. |
| Publisher: retirement before 180 days without override | Authorization fails before secrets. |
| Publisher: override string for a different tag or key | Fails, as today. |
| Release run fails after signing | Draft is never undrafted. A re-run produces identical bytes. |

Every publisher check runs before the secret-bearing step, and every client check fails
closed to "keep the current set" or "do not offer".

## §8 — Alternatives considered

1. **Baked registry only, no runtime adoption.** Add K2 to the registry, dual-sign, and
   rely on users installing a build that knows K2. Simplest, but a client that checks and
   never installs is stranded at retirement. It does not meet #148's "persist the new key".
   Rejected, but it is exactly how 1.2.x–1.4.x behave, so this design keeps it working.
2. **Put the new public key in the manifest.** Breaks every shipped client: the manifest
   parser rejects unknown fields. Rejected.
3. **Manifest schema 2 published beside schema 1** (`update-manifest-v2.json`). Two
   manifests to generate, sign and keep consistent, and still a new asset. More work than a
   keychain for the same result. Rejected.
4. **Trust a key whose id appears in a verified manifest's `trustedKeyIds`, fetching the
   public key unauthenticated.** The id is 64 bits of SHA-256. A second preimage at that size
   is expensive but within reach of a well-funded attacker. Not a security binding. Rejected.
5. **Only the latest keyset statement, not a chain.** A 1.5+ client that missed a link can
   no longer verify the newest statement once the key that signed its known set has
   retired. The chain is small and fixes that. Rejected.
6. **A separate key-ceremony workflow** that signs links outside releases, with the result
   committed by PR. Clear separation, but a second secret-bearing workflow and a manual
   commit step between ceremony and release. Rejected for now; keeping one secret-bearing
   step was a stated constraint.
7. **Require every known-key entry in an envelope to verify** instead of at least one. No
   security gain: an attacker who can alter the bytes can already deny service. Adds a way
   to break clients. Rejected.
8. **Time-based key expiry in the registry.** Clients' clocks would decide when a key stops
   working, and a long-offline client would strand itself. Rejected in favor of explicit
   retirement links.

## §9 — Test plan

Everything runs with ephemeral keys generated in the test (`makeEphemeralKeypair`), real
temporary files, and `scratchDir()`/`removeScratchDirs()`. No real secrets, no network.

**Generation and verification (`test/update-manifest.test.ts`).**
- Registry schema 2 parse; schema 1 maps to sequence 1; `signingKeyIds` subset, sorted,
  ≤ 2, non-empty.
- Statement and chain parse strictly; base64 and size limits; genesis pinned to today's id.
- Link rule: valid endorsement; missing endorsement; added key without its own signature;
  sequence gap; repeat; wrong `kind`; manifest bytes presented as a statement and the
  reverse.
- `sign` with two slots: both ids match; extra loaded key fails; missing key fails; output
  envelope sorted with two entries; key material never in stdout/stderr; env deleted.
- Dual-signed envelope verifies under a registry with only the old key, only the new key,
  and both.

**Publisher continuity (`authorizeReleaseContinuity` and the CLI).**
- Planned transition passes without override; same with an added key not signing fails.
- Retirement at 179 days fails, at 180 passes, early retirement passes only with the exact
  override string.
- Prior manifest signed only by a key the new registry dropped still verifies via the prior
  chain head.
- Chain that is not prior + ≤ 1 link, or rewrites an earlier link, fails.
- Re-anchor requires the existing override and a changed genesis.
- Expired prior manifest and expired prior chain still authorize (keeps the #147 property).

**Client (`test/update-fetch.test.ts`, `test/update-controller.test.ts`,
`test/update-preferences.test.ts`).**
- Rotation: client with baked `{K1}` adopts link 2, persists it, verifies a K2-only
  manifest.
- Missed transition: client with baked `{K1}` and no stored set walks links 2 and 3 in one
  check, then rejects a K1-only manifest.
- Keychain 404/oversize/malformed: verification continues with the current set.
- Bad link in the middle: walk stops, earlier links kept, later ones not.
- Rollback/freeze: an older dual-signed manifest after adoption is still `stale`; a shorter
  keychain never lowers the stored sequence.
- Reinstall recovery: baked sequence higher replaces stored; stored higher survives an
  older build; equal-sequence conflict prefers baked.
- `untrusted-key` state for an envelope with only unknown keys; no mark change, no
  attention.

**Compatibility.**
- Frozen 1.3.x/1.4.x `createUpdateTrustState` and `verifyManifest` source (taken from the
  tags, as `test/mixed-version.test.ts` does for SQL) run against: a dual-signed envelope
  (verifies); a trust-state file with `keyset` (mark read and raised, `keyset` preserved).
- 1.5 writer preserves `highestVerifiedVersion` when adopting, under concurrent writers.
- `update-preferences.json` is byte-identical before and after adoption.

**Workflow source pins (`test/macos-release-workflow.test.ts`).**
- Only the signing step references either secret slot.
- Authorization (chain, retirement, overrides) runs before that step.
- Publication allowlist is exactly nine names; the publish job re-verifies the chain.

## §10 — Operational runbook (outline)

Detailed steps go into `docs/macos-release.md` in the publisher PR. Human approvals are
marked **[approve]**.

**Planned rotation (K1 → K2).**

1. Generate K2 offline on a trusted machine. Keep an offline encrypted backup. Never paste
   it anywhere but the environment secret form.
2. **[approve]** Add K2's private key to the free slot (`…_B_BASE64`) in the `macos-release`
   environment. Repository admin only.
3. PR: registry `sequence: 2`, `keys: [K1, K2]`, `signingKeyIds: [K1, K2]`. CI derives the
   id from the SPKI. **[approve]** Review and merge.
4. Tag the transition release. **[approve]** The environment reviewer approves the
   deployment. The job signs link 2 with K1 and K2 and dual-signs the manifest. Check
   `update-signing-evidence.json`: signer set `[K1, K2]`, chain head 2.
5. Keep releasing normally. Every release is dual-signed.
6. After at least 180 days, **[approve]** decide to retire. PR: `sequence: 3`,
   `keys: [K2]`, `signingKeyIds: [K2]`. Merge after review.
7. **[approve]** Delete K1 from its slot before tagging (the signer refuses a loaded key
   outside the signing set). Tag the retirement release; approve the deployment.
8. Destroy K1's offline backup after the retirement release has been live for one manifest
   lifetime.

**Suspected compromise of K1.** Same steps 1–4 at once. Then the retirement release as
soon as possible, with **[approve]** `AGENT_INBOX_UPDATE_KEY_RETIREMENT_OVERRIDE` set to the
exact tag and K1's id, and cleared right after. Announce that 1.2.x–1.4.x users and anyone
who may have been served forged content should reinstall from the releases page.

**Lost key.** §4.6: genesis PR, existing rotation override, announce a manual reinstall.

## §11 — Slicing

1. **Verifier core.** Registry schema 2 (accepting 1), statement and chain parsing, the
   link rule and chain walk, as pure functions in `electron/update-manifest.cjs`. Convert
   `release/update-keys.json` to schema 2, sequence 1, and add
   `release/update-keychain-genesis.json`. No behavior change.
2. **Client adoption.** Keychain fetch, effective set, `keyset` in
   `update-trust-state.json`, the `untrusted-key` state and its Settings copy, and the
   compatibility tests against frozen 1.3/1.4 code. Also update `docs/INSTALL.md` with the
   guarantee and the recovery path.
3. **Publisher.** Two-slot `sign`, link signing, new `authorize-history` rules, keychain
   asset generation, the nine-asset allowlist and publish verification, workflow pins and
   the `docs/macos-release.md` runbook. Ships in 1.5.0 with an empty chain.
4. **(Operational) Transition release.** After 1.5.0, per decision 2. Registry PR plus a
   normal release. No code.
5. **(Operational) Retirement release.** At least 180 days later. Registry PR plus release.

Slices 1–3 must all ship in 1.5.0. They can merge in order 1, 2, 3. Slice 2 alone is
safe because a missing keychain asset is not an error. Slice 3 alone would also be safe,
since older clients ignore the new asset, but it would publish a chain nobody reads yet.

## §12 — Decisions for Shariq

1. **How long should the overlap last before the old key is retired?**
   - **(Recommended) 180-day enforced minimum; retire when you decide, ideally soon after
     180 days.** Matches the manifest lifetime and keeps one secret in use most of the time.
   - 365-day minimum. More time for 1.2.x–1.4.x users to update; two live secrets for a year.
   - No retirement unless compromised. Old clients never strand; both secrets stay live
     indefinitely.

2. **Should we rotate the current key right after the mechanism ships?**
   - **(Recommended) Yes, as a drill: transition in the first patch after 1.5.0 (1.5.1),
     retire about 180 days later.** Proves the path end to end while the fleet is small, and
     replaces a key whose generation was never audited.
   - Rotate only on a trigger (compromise, custody change). Less work now; the first real
     rotation happens under pressure.
   - Rotate inside 1.5.0 itself. Fewer releases, but 1.2.x–1.4.x would get the new key only by
     installing 1.5.0 and the client code would be unproven when the transition lands.

3. **Is #147 (expired predecessor blocks publishing) in scope?**
   - **(Recommended) No new mechanism; close #147 as not reproducible.** `authorize-history`
     never applies expiry to the prior manifest; `test/update-manifest.test.ts` already pins
     "long-expired prior manifest still authorizes" (since #111, before #147 was filed). This
     design keeps that property for the prior chain too and adds a test for it.
   - Keep #147 open and add a workflow-level regression test as part of slice 3.
   - Fold a separate non-expiring continuity record into this design. Not needed given the
     above.

4. **Where should chain links be signed?**
   - **(Recommended) In the existing release signing step,** so there is one secret-bearing
     step and the published chain is the record.
   - In a separate protected key-ceremony workflow with links committed by PR. Clearer audit
     trail in git, but a second secret-bearing workflow and an extra manual step per
     rotation.
