# Design: catalog v0, a signed static list of agents meshctl can read

**Date:** 2026-11-11 (facts checked on 2026-11-10, Appendix A)
**Status:** Proposed. Nothing here is accepted or built. §13 holds the questions for Shariq.
**Issue:** #542 (milestone "Mesh: catalog v0"). The issues that build it: #543 (export), #544 (the
public catalog repository), #545 (`meshctl catalog`), #546 (the Agents home's Catalog view), #547
(the first listings).
**Builds on:** the publishable-agent design
([`2026-11-10-publishable-agent-design.md`](2026-11-10-publishable-agent-design.md), "the listing
design" in #542), whose slices C1–C4 and C6–C8 have merged, and the agent kit (#539, merged). The
mesh design ([`2026-10-29-agent-mesh-design.md`](2026-10-29-agent-mesh-design.md)) §1, §6.7, §8.8,
§9.5, §10, §11 and §14 (D13–D24).
**Related:** #531 (card accept, slice C5, open), #534 (public `https://` endpoints, open), #540
(meshctl distribution, undecided), #541 (`meshctl login`, open); [`docs/mesh-call.md`](../../mesh-call.md),
[`docs/agent-kit.md`](../../agent-kit.md); `src/agent-card.ts`, `src/card-signature.ts`,
`src/mesh-add.ts`, `src/mesh-check.ts`, `src/meshctl.ts`, `src/mesh-agents.ts`.
**Scope of this PR:** this document. The mesh design is not edited here; §14 holds the amendment
text, applied when this design is accepted. No source, test or workflow change.
**Facts** about AI Catalog, ARD, A2A, TUF and the other signing schemes were checked on 2026-11-10
against the sources in Appendix A. A2A v1.0.1 is a release; A2A `dev-1.1` (tag `v1.1.0-rc`, no
release), AI Catalog (no tags) and ARD v0.91 ("Proposal") are not, and nothing here depends on them.

## §0 — Summary

1. **A catalog is one JSON file** in a format of our own, `https://shariqh.github.io/agent-inbox/catalog/v0`:
   who publishes it, a `sequence`, an `issuedAt` and an `expiresAt`, its signing keys, and a list
   of at most 200 listings. The whole file is at most 256 KiB (§3).
2. **Two kinds of listing.** A *hosted* listing names a running agent: its card URL, the card pin
   and the card's key thumbprints. A *self-hosted* listing names an agent you run yourself: its
   source (repository, tag, commit), a guide, and a *template pin*, the card pin without the
   signing keys, so every copy with its own key matches. Before #534 every public listing is
   self-hosted, because a hosted agent on a public name cannot be added yet (§3.2).
3. **Signed like a card.** The `signatures` array holds A2A §8.4-shaped JWS entries (ES256) over the
   raw JCS form of the catalog without `signatures`, with `typ: "agent-catalog+jws"` so a card
   signature can never pass as a catalog's. The verifier is `src/card-signature.ts`'s, with the
   `typ` as a parameter (§3.4).
4. **Trust on first use, with an optional thumbprint.** `meshctl catalog add` shows the catalog's
   keys and pins them; `--key-thumbprint` refuses any other. A later catalog must be signed by a
   trusted key; a new key is trusted when a trusted key signs the catalog that lists it. Unsigned
   catalogs are accepted only from a file, loopback or this Mac's tailnet, as unsigned cards are (§3.5).
5. **Freshness from TUF, cut down.** meshctl refuses a catalog whose `sequence` is lower than the
   last one it accepted (rollback), one with the same `sequence` and different bytes, and one past
   `expiresAt` (freeze). The public catalog is re-signed weekly and expires after 30 days (§3.6).
6. **`meshctl catalog install <listing>` is `meshctl add` with the listing's expectations filled in**:
   the same fetch, endpoint rule, card rule, signature check, summary and `--apply`, plus "the card's
   id, pin (or template pin) and keys match the listing". A card that no longer matches is refused
   (exit 18). meshctl never downloads or runs an agent's code (§4).
7. **The public catalog is a separate repository** with one file per listing, CI that runs
   `meshctl check --strict` on every listed card, a signing job that sees only the built index, and
   a static browse page on GitHub Pages. Anyone may propose a listing by pull request; Shariq
   merges (§5).
8. **`ai-catalog.json` is an export only**: `meshctl catalog export` maps each listing to an AI
   Catalog entry (`urn:air:` identifier, `application/a2a-agent-card+json`, the card URL) and leaves
   it unsigned, since AI Catalog's one signer profile is `did:web` (§6).
9. **The Agents home's Catalog view reads meshctl's verified cache**, not the network: no new fetch
   in the viewer, none in the MCP process, nothing installed from the app. Each listing has a
   **Copy install command** button (§7).
10. **First listings:** web search and the agent kit's echo example, both self-hosted; a third-party
    agent when its publisher agrees. Request-post and unslop are not listed publicly (§8).
11. **Nine slices** (K1–K9). #545 is three of them; the public repository (#544) is built outside
    this repository; nothing waits on #540 or #534 (§9, §10). The mesh design gains D25–D31 (§14).

## §1 — Goal, non-goals and terms

**Goal.** A human who wants an agent can find one in a list someone curated, see what it does,
what it contacts and who publishes it, and add it with the same checks as `meshctl add`. They
start from expectations the curator signed instead of from nothing. No server is needed: a catalog
is a static file.

**Non-goals.**

- No registry and no dependence on any catalog. Adding, calling and checking agents work with no
  catalog. Removing every catalog changes no added agent (§14 amends the mesh design's §1).
- No code download or execution. meshctl never fetches an agent's source, builds it or starts it.
- No install from the viewer. The viewer copies a command; installing from the app is a separate
  decision under D4's first-hop rules (#546).
- No search service, ranking, ratings or usage statistics.
- No sign-in to catalogs in v0 (§3.8).
- No enforcement of declared egress or residency (the publishable design's non-goal stands).

**Terms.**

| Term | Meaning |
|---|---|
| Catalog | One signed JSON file in the catalog v0 format (§3). |
| Listing | One entry in a catalog: an agent id and what the curator expects of its card. |
| Hosted listing | A listing for an agent someone runs at a fixed card URL. |
| Self-hosted listing | A listing for an agent the human runs themselves from a pinned source. |
| Card pin | `cardSha256`, unchanged: SHA-256 of the card's JCS form without `signatures` and every `supportedInterfaces[].url` (`canonicalCard()`). |
| Template pin | `templateSha256`, new: the card pin's input with the profile extension's `params.keys` removed too (§3.3). |
| Catalog record | A `catalogs.<name>` entry in `mesh.json` that `meshctl catalog add` writes (§4.1). |
| Catalog cache | `<mesh dir>/mesh/catalogs/<name>.json`: the last catalog meshctl verified, with its trusted keys (§4.1). |
| Curator | Whoever signs a catalog. For the public catalog, Shariq (§5). |

## §2 — What exists today

- **`meshctl add <card-url>`** (#529, C1, C3) fetches a card (one GET, no redirect, 64 KiB, 5 s),
  applies `checkAddedCard()` and §8.8's endpoint rule (loopback, or `https://` on this Mac's
  tailnet), verifies signatures (`signatureVerdict()`), shows the labelled summary (`addSummary()`),
  and with `--apply` writes `agents.<id>` with `card`, `endpoint`, `cardSha256`, `tokenFile`,
  `agentId` and `keyThumbprints`. `--key-thumbprint` refuses a card not signed by that key. A card
  whose `agentId` an entry holds, signed by a key that entry pinned, is a move.
- **`meshctl check <card-url>`** (C2) runs the publishable design's §5 tests and prints
  `{ level, ok, tests }` with `--json`; it accepts a public `https://` name, since it sends no
  token there. It needs a fetchable URL; it cannot check a card from a file.
- **`src/card-signature.ts`** verifies A2A §8.4 JWS over raw JCS: ES256, ES384 and EdDSA, `kid` a
  thumbprint of a listed key, `crit`, `b64` and `x5c` refused, `typ` `JOSE`, caps on depth (32),
  size (64 KiB), signatures (4) and header size (2 KiB) before anything is canonicalised.
- **Signing:** `packages/mesh`'s `card-signing.ts` signs with one `0600` key per agent
  (`meshctl key create|show|rotate|retire`); the agent kit's `servedCard()` signs at start.
- **Conformant cards:** web search (C7) and request-post's fixture (C8) are signed and carry the
  profile; the echo example (#539) passes `meshctl check --strict` in CI. Unslop waits for C9.
- **The viewer** reads `mesh.json` lazily in `src/mesh-agents.ts` and fetches the built-in agents'
  cards only from their configured endpoints, on a trigger. It shows no added agents yet.
- **Pages** serves `docs/ext/*` at `https://shariqh.github.io/agent-inbox/ext/<name>/v<N>`
  (`scripts/pages-site.mjs`, `.github/workflows/pages.yml`).
- **Nothing reads a catalog.** `meshctl` is not on `PATH` (#540); docs use `npm run meshctl -- …`.

Two facts shape this design:

- **Every copy of a self-run agent has its own key.** The publishable design gives each copy its
  own key (§3.10, D21), and the key list is inside the card pin. So the card pin of a web search
  copy on one Mac never equals another copy's. A listing for such an agent cannot pin the card;
  it pins the card without its keys (§3.3).
- **Public names wait for #534.** `add` refuses a public `https://` name today. A hosted listing on
  one is not installable until #534 lands, so a public catalog built now holds self-hosted listings.

## §3 — Decision 1: the catalog file

### 3.1 One file in a format of our own

| Option | For | Against |
|---|---|---|
| **A. Our format, mapped to AI Catalog by an exporter (chosen)** | Stable while AI Catalog and ARD change; carries what meshctl checks (pins, thumbprints, egress, freshness); reuses the card verifier. | One more format; an AI Catalog client reads only the export. |
| B. An AI Catalog document, our fields in `entries[].extensions`, signed with a custom signer profile | One file for both. | D24 makes AI Catalog an export format only; it has no tags, and its only signer profile is `did:web`, so our signature would be a non-standard profile anyway; it has no rollback field. |
| C. ARD's `ard.json` | Where ARD v0.91 says consumers must look. | A proposal; it defines no document signature at all. |

The format is named by a URI, `https://shariqh.github.io/agent-inbox/catalog/v0`, served by Pages
from `docs/catalog/catalog-v0.md` (slice K2), as the profile extension is. "v0" says what it is: a
first version we may break, with a new URI, before anyone else depends on it.

### 3.2 Two kinds of listing

| Option | For | Against |
|---|---|---|
| **A. Hosted and self-hosted (chosen)** | Lists what can be installed today (agents you run yourself, #547's web search and echo) and, after #534, agents others run; one format for both. | Two install paths to explain and test. |
| B. Hosted only | One install path. | Nothing in a public catalog is installable until #534 and someone runs a public agent; web search is meant to run against your own search engine. |
| C. Self-hosted only | Simplest now. | A format change when #534 lands; private catalogs of tailnet agents (request-post) have nothing to use. |

A **hosted** listing pins a card URL, its card pin and its key thumbprints. Its card URL must be
`https://`. In the public catalog it must be a public name; a private catalog (a file, or one on
the tailnet) may list agents on this Mac's tailnet, which install today.

A **self-hosted** listing pins the source (repository, tag, 40-hex commit), a guide (an `https://`
page telling the human how to build and run it) and the template pin. The human runs their own
copy, then installs it by its local card URL.

### 3.3 The template pin

`templateSha256` is SHA-256 of the JCS form of the card with `signatures`, every
`supportedInterfaces[].url` and the profile extension's `params.keys` removed. It is the card pin
with one more exclusion, and it is computed by the same function with a flag (`canonicalCard(card,
{ withoutKeys: true })`).

It says "this card says what the listed agent says": same id, name, version, skills, auth, provider,
egress and residency. It says nothing about who signed the copy: the human made that key. It is
only meaningful for agents whose card has nothing per copy except the URLs and keys, which D10 and
the web search design's §4.1 already require. A card with a per-start field (unslop's `loadedAt`,
#512) cannot be self-hosted-listed; CI notices, because its sample card's template pin changes.

| Option | For | Against |
|---|---|---|
| **A. A template pin (chosen)** | One hash; the same JCS code; a copy with any key matches. | A new hash rule to document. |
| B. Compare the summary fields only (id, skills, egress, residency) | No new hash. | Misses auth, provider and descriptions; a field added to the card later is silently unchecked. |
| C. Ship the publisher's key to every copy | The card pin would match. | Copies a private key to strangers; D21 rules it out. |

### 3.4 The format

```json
{
  "format": "https://shariqh.github.io/agent-inbox/catalog/v0",
  "id": "shariqh.github.io/agent-catalog",
  "name": "agent-inbox catalog",
  "publisher": { "organization": "agent-inbox", "url": "https://github.com/shariqh/agent-catalog" },
  "sequence": 1794700800,
  "issuedAt": "2026-11-15T00:00:00Z",
  "expiresAt": "2026-12-15T00:00:00Z",
  "keys": [ { "kty": "EC", "crv": "P-256", "x": "<base64url>", "y": "<base64url>" } ],
  "listings": [
    { "id": "shariqh.github.io/agent-inbox/web-search",
      "kind": "self-hosted",
      "name": "web-search",
      "version": "<semver>",
      "description": "Answers one question from the public web with numbered sources, or returns the sources alone.",
      "publisher": { "organization": "agent-inbox", "url": "https://github.com/shariqh/agent-inbox" },
      "skills": [ { "id": "web-search", "name": "web-search", "tags": ["search", "web"],
                    "egress": [ { "purpose": "search", "hosts": "operator", "sends": "input" },
                                { "purpose": "model", "hosts": "operator", "sends": "input" } ],
                    "residency": "caller-mesh" } ],
      "source": { "repository": "https://github.com/shariqh/agent-inbox", "ref": "v<x.y.z>",
                  "commit": "<40 hex>" },
      "guide": "https://shariqh.github.io/agent-inbox/guides/web-search",
      "templateSha256": "<64 hex>",
      "listedAt": "2026-11-15T00:00:00Z",
      "checkedAt": "2026-11-15T00:00:00Z",
      "state": "ok" },
    { "id": "example.org/notes-search",
      "kind": "hosted",
      "…": "the same summary members",
      "card": "https://notes.example.org/.well-known/agent-card.json",
      "cardSha256": "<64 hex>",
      "keyThumbprints": [ "<43 base64url>" ],
      "state": "ok" } ],
  "signatures": [ { "protected": "<base64url>", "signature": "<base64url>" } ]
}
```

**Top level.**

| Member | Rule |
|---|---|
| `format` | Exactly the v0 URI. Anything else is refused ("a catalog format meshctl does not read"). |
| `id` | The catalog's id, with the agent id's syntax (D19): `<domain>[/<path>]/<name>`. A claim, shown; the key is what meshctl remembers. |
| `name` | ≤ 80 characters; a claim. |
| `publisher` | `organization` (≤ 80) and an `https://` `url`; claims. |
| `sequence` | An integer, 1 to 2^53 − 1, that grows with every signed issue, including a re-sign with no listing change. Ours is the signing time in Unix seconds, so CI needs no counter. |
| `issuedAt`, `expiresAt` | RFC 3339 UTC. `expiresAt` after `issuedAt`, and at most 90 days after it. |
| `keys` | 1–4 public JWKs, as the profile's (`kty`, `crv`, `x`, `y` for P-256 and P-384; `kty`, `crv`, `x` for Ed25519; no other member). Required when the catalog is signed. |
| `listings` | 0–200 listings, ids unique. |
| `signatures` | 1–4 `{ protected, signature }` entries, or absent for an unsigned catalog (§3.5). |

**Every listing.**

| Member | Rule |
|---|---|
| `id` | The card's profile id (D19). Unique in the catalog. |
| `kind` | `hosted` or `self-hosted`. |
| `name`, `version`, `description` | The card's, ≤ 80, SemVer ≤ 80, ≤ 500. CI checks they equal the card's. |
| `publisher` | The card's `provider` (`organization`, `url`). |
| `skills` | 1–16 entries: the card skill's `id`, `name` (≤ 80), `tags` (≤ 8, each ≤ 32), and the profile's `egress` and `residency` for it, in the profile's syntax (§3.8–3.9 of the publishable design). CI checks they equal the card's. |
| `listedAt`, `checkedAt` | RFC 3339 UTC: first merged, and the last time CI's checks passed. |
| `state` | `ok`, `changed` (the live card no longer matches) or `unavailable` (the card could not be fetched). Set by CI (§5.3). Self-hosted listings are always `ok`. |

**Hosted only:** `card` (an `https://` URL), `cardSha256` (64 hex), `keyThumbprints` (1–4 RFC 7638
thumbprints, exactly the card's keys).
**Self-hosted only:** `source` (`repository`, an `https://` URL; `ref`, a tag ≤ 100; `commit`, 40
lower-case hex), `guide` (an `https://` URL), `templateSha256` (64 hex).

Why the summary members repeat the card: `catalog list`, the browse page and the viewer show a
listing without fetching any card, and the summary is inside the catalog's signature. CI keeps them
equal to the card, and `install` compares the pin, so a stale summary cannot get past install.

**Caps, checked before anything is canonicalised or verified:** the file at most 256 KiB, nesting
at most 16 deep, at most 200 listings and 4 signatures, each protected header at most 2 KiB
decoded. Strings are cleaned and capped as `add`'s summary does when shown (§4 of the publishable
design); a string over its cap refuses the catalog rather than being cut, because the curator's CI
should never sign one.

### 3.5 The signature and the keys

**Format.** As a card's (A2A v1.0.1 §8.4): each entry of `signatures` is a JWS (RFC 7515) with a
protected header and a signature, over the base64url of the RFC 8785 (JCS) form of the catalog
without `signatures`. The header holds `alg`, `kid` (the RFC 7638 thumbprint of one of `keys`) and
`typ: "agent-catalog+jws"`. `crit`, `b64` and `x5c` are refused; `jwk`, `jku` and `x5u` are ignored
and never fetched. ES256 to sign; ES256, ES384 and EdDSA to verify.

**Why a distinct `typ`.** Explicit typing (RFC 8725 §3.11) stops a signature made for one kind of
object from being accepted as another. A card signature has `typ: "JOSE"`; a catalog verifier
requires `agent-catalog+jws`, and the card verifier requires `JOSE`. With separate keys as well,
neither can stand in for the other.

**Raw JCS, no normalisation.** The publishable design needed "canonical-stable" cards because other
A2A signers drop empty values. No one else signs our catalogs, so the catalog verifier has no such
rule, and an empty `listings` array is allowed.

| Option | For | Against |
|---|---|---|
| **A. An embedded `signatures` array, JWS over JCS (chosen)** | One file; `src/card-signature.ts` verifies it with the `typ` as a parameter; matches the card. | The file must be parsed before it is verified (the caps come first). |
| B. A detached signature file (`catalog.json.jws`, or JWS detached content, RFC 7515 Appendix F) | Verifies the exact bytes before parsing. | Two fetches that can disagree; a second fetch rule. |
| C. minisign (Ed25519, a trusted comment) | Small, well understood. | A new key and signature format beside JWS; not in Node core's JOSE habits; nothing else here uses it. |
| D. Sigstore (`cosign sign-blob`, a bundle) | Keyless signing from CI identity; a transparency log. | Verification needs Sigstore's trust root and, for keyless, its online services; far beyond Node core. |

**Key trust.** As cards (D21), trust on first use with an optional known thumbprint:

- `meshctl catalog add <source>` shows the catalog's keys (thumbprints) and, with `--apply`, records
  them in the catalog record. `--key-thumbprint <t>` refuses a catalog not signed by that key.
- The public catalog's thumbprint is published in two places: the catalog repository's README and
  this repository's `docs/catalogs.md` (slice K3), so a forger needs both repositories.
- A later catalog must carry a valid signature by a *trusted* key: one the last accepted catalog
  listed (the cache's `trustedKeys`), or, with no cache, one the catalog record pinned. When it
  verifies, the keys it lists become the trusted set. This is the card's "lighter accept" (#531):
  a key change endorsed by a trusted key is accepted with one stderr line ("catalog signing keys
  changed, endorsed by a trusted key").
- Rotation: the curator lists the old and new keys, signs with both for at least 30 days, then
  drops the old one. A catalog signed only by a key never trusted is refused (exit 19) until the
  human runs `catalog add <source> --replace --apply`, which is trust on first use again.

**Unsigned catalogs** are accepted only from a file, from loopback, or from `https://` on this
Mac's tailnet, the places an unsigned card is accepted (D21). From any other `https://` name a
catalog must be signed. An unsigned catalog still has `sequence` and `expiresAt`, but nothing
protects them, and `list` says "unsigned (a file you chose)".

### 3.6 Freshness and rollback

| Threat (TUF's names) | Rule |
|---|---|
| Rollback: an older, validly signed catalog served again | Refused if its `sequence` is lower than the cache's. |
| Equivocation: two different catalogs with one `sequence` | Refused if its `sequence` equals the cache's and its signed payload differs. |
| Freeze: one old catalog served forever | Refused at or after `expiresAt`. `install` from an expired cache is refused (exit 19); `list` shows "expired". |
| A catalog from the future | Refused if `issuedAt` is more than 5 minutes ahead of this Mac's clock. |
| Endless validity | `expiresAt` at most 90 days after `issuedAt` (format rule). |

TUF separates an offline key for content from an online key that only re-signs a timestamp; this
design keeps one key per catalog for v0 and makes that split a question (§13 Q3). Expiry stops a
catalog being trusted forever; it does not touch agents already installed, which never consult the
catalog again (§4.3).

### 3.7 Where catalogs come from

`meshctl catalog add` takes:

- a file path: opened `O_NOFOLLOW`, a regular file, at most 256 KiB; the record keeps the
  absolute path, and `refresh` reads it again;
- `http://127.0.0.1:<port>/…` or `https://<name>.<tailnet>.ts.net/…` on this Mac's tailnet, as
  `add` allows for cards;
- `https://` on a public DNS name, before #534, because a catalog fetch sends no token (as
  `meshctl check` does). The name must not resolve to a loopback, link-local or private address
  (the SSRF rule #534 brings), and TLS is always verified.

Every fetch is one GET, no redirect, no proxy, no cookie, no token, at most 256 KiB, one 5 s deadline.

### 3.8 No sign-in in v0

#542 asked for "optional sign-in through `meshctl login`". This design leaves it out.

| Option | For | Against |
|---|---|---|
| **A. No sign-in in v0; a private catalog is a file or lives on the tailnet (chosen)** | A catalog holds no secret (listings are public cards or public source); the tailnet already limits who can read one; no dependency on #541. | A private catalog on the public internet is not possible. |
| B. `meshctl login` for catalogs | Private catalogs anywhere. | #541 is designed per agent (a token bound to one resource, RFC 8707); a catalog would need its own resource, client and refresh rules before #541 exists. |

The format reserves nothing for it; a later version adds a member if needed.

## §4 — Decision 2: `meshctl catalog`

```sh
meshctl catalog add <url-or-file> [--name <name>] [--key-thumbprint <t>] [--replace] [--apply]
meshctl catalog refresh [<name>]
meshctl catalog list [<name>] [--json]
meshctl catalog install <listing-id> [--catalog <name>] [--id <id>] [--card-url <url>]
                        [--token-file <path>] [--apply]
meshctl catalog remove <name> [--apply]
meshctl catalog sign <file> --key-file <path> --sequence <n> --expires-in <days> --out <file>
meshctl catalog export [--out <dir>] [--apply]
```

### 4.1 What they keep

`mesh.json` gains a `catalogs` key, written only by `catalog add --apply` and `catalog remove
--apply` (dry run first, a timestamped backup, other keys kept, as `add`):

```json
{ "catalogs": { "agent-catalog": {
    "source": "https://shariqh.github.io/agent-catalog/catalog.json",
    "catalogId": "shariqh.github.io/agent-catalog",
    "keyThumbprints": [ "<43 base64url>" ] } } }
```

`<name>` is the human's local name, `[a-z0-9-]{1,40}`, by default the catalog id's last segment. At
most 8 catalogs.

The **cache**, `<mesh dir>/mesh/catalogs/<name>.json`, `0600`, written by temp file and rename,
holds `{ fetchedAt, trustedKeys, catalog }`, where `catalog` is the last catalog that passed every
rule in §3. `refresh` writes it without `--apply`, as `call` writes run records: it is verified
state, not configuration. `remove --apply` deletes the record and the cache; it does not touch any
agent installed from the catalog.

### 4.2 add, refresh, list, remove

- **`add`** fetches or reads the catalog, applies §3's caps, format and signature rules, and prints
  a dry run: the fixed untrusted header, the catalog's id, name and publisher as claims, signed or
  not (key thumbprints, "new to this Mac"), `sequence`, `issuedAt`, `expiresAt`, and the number of
  listings of each kind. `--apply` writes the record and the cache. It refuses a name or source
  already recorded; `--replace` re-adds one (trust on first use again).
- **`refresh`** fetches every recorded catalog (or one) and replaces its cache when §3.5 and §3.6
  pass. A refusal keeps the old cache and says why in fixed words; the exit is 19 if any catalog
  was refused.
- **`list`** reads the caches only (no network): per listing, its id, kind, name and version as
  claims, publisher, each skill's egress and residency in `add`'s fixed phrases, its catalog(s),
  `state`, and whether it is installed (an `agents.<id>` entry with that `agentId`) and with the
  listed pin. A listing in two catalogs with the same pins is shown once with both names; with
  different pins, once per catalog with "catalogs disagree". An expired catalog's listings are
  shown as expired. `--json` prints the same as one object.
- **`remove`** deletes the record and the cache.
- **`status`** gains one line per catalog: name, signed or not, `sequence`, expiry, listings.

### 4.3 install

`install` is `add` with expectations. It runs `add`'s code path (one function, not a copy) and adds
the listing's checks before the summary.

1. Find the listing in the caches. Refused (exit 19) when its catalog is expired; refused (1) when
   it is in two catalogs that disagree and `--catalog` is not given.
2. **Hosted:** the card URL is the listing's `card`. **Self-hosted:** `--card-url` is required and
   names the human's own running copy; without it the dry run prints the listing's source
   (repository, tag, commit) and guide URL as text, says "run your own copy as the guide says, then
   run this command again with --card-url", and exits 0 having fetched nothing.
3. Fetch the card and apply `add`'s rules: the endpoint rule (for a hosted public name, #534's
   rule once it lands, refused before), the card rule, `signatureVerdict()`.
4. The listing's checks, each a fixed reason:
   - the card's profile id equals the listing id;
   - hosted: `cardSha256` equals the listing's, and the card is signed by a key in
     `keyThumbprints` (the listing acts as `--key-thumbprint`);
   - self-hosted: `templateSha256` equals the listing's, and the card is signed by a key it lists
     (the human's own key, trusted on first use or by `--key-thumbprint`).
5. The dry run is `add`'s summary plus one line:

   ```text
   Listing    shariqh.github.io/agent-inbox/web-search in catalog agent-catalog (signed; sequence 1794700800; expires 2026-12-15): the card matches it
   ```

6. `--apply` writes the same `agents.<id>` entry as `add`, plus `listing: { catalog, id, sequence }`
   for provenance. Nothing reads `listing` to decide anything: `call` checks the pin as for any
   added agent, and the catalog is never consulted again.

The local id defaults as in `add` (from the card name); a built-in name (`web-search`) needs
`--id`. An agent already added with the same `agentId` is refused with "already added as
`<local-id>`".

**When the card no longer matches the listing** (exit 18, nothing written):

| Option | For | Against |
|---|---|---|
| **A. Refuse, name what differs among the listing's summary fields, and point at `meshctl add <card-url>` (chosen)** | The listing is the expectation; a mismatch means the curator has not seen this card. The human can still add it on their own judgement, without the catalog's backing. | One more step when a publisher released before the catalog caught up. |
| B. Warn and continue | Fewer steps. | The catalog's check means nothing if a mismatch passes. |

What differs is computed from the listing's summary members against the card (skills added or
removed, egress, residency, version, auth), never by printing card text. A difference outside those
members is "another field of the card".

**When the listing changes after install** (a new version is listed), `list` shows "listed version
differs from yours". Accepting it is `catalog install <id> --update`, which is #531's `add
--accept-card` with the listing's pin as the expected one. It waits for #531 (slice K9).

### 4.4 sign (for curators)

`catalog sign` reads an unsigned catalog, sets `sequence`, `issuedAt` (now) and `expiresAt`, checks
it with the same parser, and signs it with an ES256 key file (`0600`, `O_NOFOLLOW`, at most 4 KiB,
the format of `meshctl key`'s files). It is Node core and lives in `src/`, so the catalog
repository's CI and a curator's Mac use the same code. It refuses a key whose public half the
catalog's `keys` does not list.

### 4.5 Exit codes

`catalog` keeps meshctl's general table (0 done, 1 refused or failed, 2 usage) and adds two:

| Exit | Meaning |
|---|---|
| 18 | The listing and the card do not match (id, pin, template pin or keys). |
| 19 | No current catalog: expired, rolled back, two catalogs under one sequence, a bad signature, or a signing key never trusted. |

They follow `call`'s 11–16 and `check`'s 17, so a script can tell "the card drifted" and "the
catalog is stale" from every other refusal.

## §5 — Decision 3: the public catalog repository (#544)

### 5.1 Where

| Option | For | Against |
|---|---|---|
| **A. A separate repository, `shariqh/agent-catalog`, served at `https://shariqh.github.io/agent-catalog/` (recommended, §13 Q1)** | Listing pull requests, reviewers and CI stay out of the app's repository; its own permissions; a second repository for the key's thumbprint. | One more repository to keep. |
| B. A `catalog/` directory here, served at `https://shariqh.github.io/agent-inbox/catalog/` | No new repository. | Third-party pull requests and their CI in the app's repository; the signing secret beside release secrets. |
| C. A new GitHub organisation | Neutral name. | A new owner to secure; nothing else here lives there; ids already use `shariqh.github.io`. |

Pages limits (1 GB site, 100 GB a month soft bandwidth) are far above a catalog's needs.

### 5.2 Layout

```text
listings/<publisher-domain>/<path…>/<name>.json        one listing, unsigned, in the §3.4 listing shape
                                                     (state, listedAt and checkedAt filled by CI)
listings/<…>/<name>.sample-card.json                   self-hosted only: a card the publisher's copy
                                                     served, signed with a throwaway key
catalog.base.json                                     the top-level members except the signed ones
scripts/build.mjs                                     Node core: validate, check, build catalog.json
site/                                                 the browse page's template and stylesheet
CONTRIBUTING.md                                       how to propose a listing
REVIEWING.md                                          the review bar (§5.5)
.github/CODEOWNERS                                    * @shariqh
.github/workflows/check.yml, publish.yml
```

The path is the listing id, so ids are unique by construction, and CI checks that the file's `id`
equals its path.

### 5.3 CI

**On every pull request (`check.yml`):** `pull_request` (never `pull_request_target`),
`permissions: contents: read`, no secrets, no signing key.

1. Validate each changed listing against the format (§3.4), with the catalog parser.
2. Hosted: `meshctl check <card> --strict --json` must pass at the publishable level; the fetched
   card's pin, keys and summary members must equal the listing's. The card URL must be a public
   name (no `*.ts.net`, no loopback).
3. Self-hosted: `meshctl check --card-file <sample> --strict --json` must pass (the static tests;
   `card.fetch`, `endpoint.rule` and live tests are `skip`, slice K4); the sample's template pin and
   summary must equal the listing's; `git ls-remote <repository> <ref>` must name `<commit>`.
   CI never builds or runs the publisher's code.
4. Build the unsigned `catalog.json` and the browse page as artifacts for the reviewer.

**On push to `main`, weekly, and by hand (`publish.yml`):**

1. A `build` job re-runs step 2 for every hosted listing. A failure does not fail the job: it sets
   `state` to `changed` or `unavailable` and opens or updates one issue per listing. A listing back
   to its pin is `ok` again. Then it builds the unsigned catalog (`checkedAt` from this run).
2. A `sign` job, in a protected environment `catalog-signing` that only `main` may use, receives
   only the built `catalog.json` and the `sequence` of the catalog Pages serves now, writes the key
   secret to a `0600` file, and runs `meshctl catalog sign` with `--sequence` the current Unix time,
   or one more than the served `sequence` if that is higher, and `--expires-in 30`. It runs no
   script from a listing.
3. A `deploy` job publishes `catalog.json`, the browse page and `keys.json` (the public keys) to
   Pages.

`meshctl` comes from a checkout of this repository at a pinned release tag (`npm ci`, `npm run
meshctl --`) until #540 ships a package (§9).

GitHub disables a public repository's scheduled workflows after 60 days without activity. The
catalog then stops being re-signed and expires within 30 days: it fails closed, and the weekly drift
issue stops too. REVIEWING.md says to re-enable the schedule.

### 5.4 The browse page

Static HTML built by `scripts/build.mjs`, no framework, a `<meta>` Content Security Policy of
`default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'` and one small script for
copy buttons. One section per listing, anchored by id: name and description as quoted claims, id,
kind ("Run your own" or "Hosted"), publisher, version, each skill's egress and residency in
meshctl's fixed phrases (the table is copied into the build script, with a test that it matches
`src/mesh-add.ts`'s), `state`, and the install command. Every value from a listing is HTML-escaped;
only `publisher.url`, `guide` and `source.repository` become links, and only when they are
`https://`, with `rel="noopener noreferrer nofollow"`. The top of the page shows the catalog key's
thumbprint and the `meshctl catalog add` command with `--key-thumbprint`.

### 5.5 Who may propose, who merges, the review bar

Anyone may open a pull request adding or changing a listing. Shariq merges (§13 Q2): CODEOWNERS
names him for every path and branch protection requires his review and green CI.

The bar, in REVIEWING.md:

- CI passes: `check --strict` at the publishable level, the pins and summary equal the card.
- The publisher agrees. A pull request from someone other than the publisher links the publisher's
  written agreement (an issue comment by the account that owns the source repository or the id's
  domain). The id's domain is a claim; the reviewer checks it against the source repository or
  the publisher's site, and nothing in v0 verifies domain control.
- Self-hosted: the source is public and licensed; the guide works from a clean machine; the
  reviewer has read the code paths that send the caller's input anywhere and the declared egress
  is consistent with them. This is a reading, not an audit, and the page says so.
- No private host names anywhere; descriptions are factual and short.
- One listing per agent id; a new version is a pull request that updates the pins.

## §6 — Decision 4: `ai-catalog.json` export (#543)

`meshctl catalog export` writes, with `--apply`, into `--out` (default `<mesh dir>/mesh/export/`):

- `catalog.json`: this machine's agents (built-in and added) whose cards pass `meshctl check` at
  the local level, as a catalog v0 file with hosted listings, unsigned (`catalog sign` can sign it);
- `ai-catalog.json`: the same agents in the AI Catalog shape.

| Ours | AI Catalog entry | Note |
|---|---|---|
| listing `id` `example.org/x/y` | `identifier` `urn:air:example.org:x:y` | D19's mapping, one way. |
| — | `type` `application/a2a-agent-card+json` | The provisional A2A `dev-1.1` media type AI Catalog and ARD examples use. |
| hosted `card` | `url` | Never `data`: the card is the source of truth. |
| `name`, `description`, `version` | `displayName`, `description`, `version` | Cleaned and capped. |
| skills' `tags` | `tags` | The union, at most 16. |
| `publisher` | `publisher` `{ identifier, displayName, identityType: "dns" }` | `identifier` is the id's domain, `displayName` the organisation: a claim, as everywhere. |
| `cardSha256`, `keyThumbprints`, egress, residency | `extensions["https://shariqh.github.io/agent-inbox/catalog/v0"]` | AI Catalog says consumers ignore unknown extension keys. |
| — | `digest` | Omitted: AI Catalog's digest is of the exact bytes served, and our agents sign at every start with ECDSA, whose signatures differ each time. |
| catalog `name` | top-level `host.displayName` | `specVersion: "1.0"`. |
| `signatures` | — | Not mapped. AI Catalog's catalog signature (`signature.jws`, `typ: ai-catalog+jws`) defines only a `did:web` profile, which we do not run. The export is unsigned. |

Rules: no token, token path, key path or run record in either file; the files contain this Mac's
endpoint URLs (loopback and tailnet names), so `export` prints "for this Mac's mesh, not for
publishing", and `--public` keeps only listings whose card URL is a public name (none before #534).
`ard.json` is not written in v0: ARD v0.91 is a proposal, defines no document signature, and says
consumers may read `ai-catalog.json`. A later slice can add it when M3's registry serves either.

## §7 — Decision 5: the Agents home's Catalog view (#546)

### 7.1 How the viewer gets listings

| Option | For | Against |
|---|---|---|
| **A. Read meshctl's verified caches (chosen)** | No new outbound fetch in the viewer and none in the MCP process; no verifier in the viewer; the view shows exactly what `install` will use. | Shows the last `refresh`, not live state. |
| B. The viewer fetches catalogs itself | Always current. | A new class of outbound request from the viewer to URLs from `mesh.json`, a second copy of the freshness rules, and §8.8's "the viewer calls only configured endpoints" widened. |
| C. The viewer runs meshctl | Reuses everything. | The viewer spawning a mesh tool is a new process boundary. |

A viewer-only module, `src/mesh-catalogs.ts`, reads `mesh.json`'s `catalogs` names (through the
read `mesh-agents.ts` already does) and each cache file: `O_NOFOLLOW`, a regular file the user owns,
at most 320 KiB, parsed and capped by the catalog parser (no signature check: meshctl did it, and a
same-user process that can write the cache can write `mesh.json` too, which §3 of the mesh design
does not defend against). It `lstat`s at most once every 5 s, re-reads a file only when its
identity, size or times change, and serves `GET /api/mesh/catalogs`, built fresh per read with an
ETag. `/api/version`'s `mesh` member gains `catalogs: n` only when a record exists; otherwise its
bytes are unchanged. No timer, no `fs.watch`, no network. `test/prstate.test.ts` adds the module to
the stdio graph's forbidden list.

### 7.2 What it shows

A **Catalog** fold in the Mesh agents section, after the strip, closed by default, a list (not a
strip of cards). Per listing: name (quoted claim) and version, id, kind ("Run your own" or
"Hosted"), publisher, each skill with its egress and residency phrases, the catalog name(s),
whether it is installed, and the state: "Card changed since listed", "Card unavailable",
"Catalog expired", "Catalogs disagree", "Listed version differs from yours". The fold's header
says when the caches were last refreshed and offers **Copy refresh command**.

Each listing has **Copy install command**, which copies
`npm run meshctl -- catalog install <id>` (plus `--catalog <name>` when catalogs disagree), until
#540 puts `meshctl` on `PATH`. The command comes from a fixed template; `<id>` and `<name>` are
inserted only after passing their syntax checks, and a listing whose id fails has no button. It
never includes `--apply`, so pasting it runs a dry run. For a self-hosted listing that dry run
prints the guide and the full command. The button is disabled, with the reason, for an expired
catalog or a listing whose card changed.

Empty state: "No catalogs. `meshctl catalog add <url>` adds one." with a copy button.

### 7.3 Rules it keeps

- Every listing string through `esc()`; no autolinking of descriptions. `publisher.url` and
  `guide` are links only through `chipHtml()` and `safeHttpUrl()`, opened by Electron main
  (`docs/architecture/links.md`).
- Never attention, a badge, a count or the dock. An idle poll paints nothing: the catalog body's
  ETag joins `frameInputs()`. Rows are kept nodes keyed by listing id and catalog, so focus and
  selection survive polls.
- No install, no `--apply`, nothing written under the mesh directory.

## §8 — Decision 6: the first listings (#547)

| Agent | Public catalog | Why |
|---|---|---|
| Web search | **Yes, self-hosted** | Anyone can run it against their own search engine and model host; its card is signed, conformant and the same on every copy. |
| Echo (the agent kit's example) | **Yes, self-hosted** | The smallest working example for agent authors; `check --strict` already runs on it in CI. |
| An agent written outside this repository | **Yes, when its publisher agrees** | Proves the format and the review bar work for someone else. Self-hosted unless #534 has landed. |
| Request-post | No | A personal agent on a private service; its card's tailnet host is not public. It can sit in a private catalog file. |
| Unslop | No | Runs against one person's model box (#547); its card changes before #512 and C9. |

**Before web search can be listed:**

- Its front door answers the identity proof label `a2a-mesh/v1`, which `meshctl call` and `check
  --token-file` prove. Today it answers `web-search/v1` only, so a copy installed with `catalog
  install` fails `call`'s identity check on loopback. Its own client (W5b) has not shipped, so
  switching the label costs nothing now.
- A self-hosting guide page (on this repository's Pages), and a tagged release to pin, since its
  card's `version` is the package's.

**Echo** needs its guide (`docs/agent-kit.md` already is one) and a tag to pin.

## §9 — Dependencies

| On | What waits | What does not |
|---|---|---|
| #540 (meshctl distribution) | The copied command's short form; the catalog repository's CI using a package instead of a pinned checkout; installing on a second machine without a checkout. | Nothing in v0: `meshctl catalog` ships in this repository, CI pins a release tag of it, and #547's second machine uses a checkout. |
| #534 (public `https://` endpoints) | Installing a hosted listing on a public name; the public catalog's first hosted listing. | The format (hosted listings are defined now); hosted listings on this Mac's tailnet in private catalogs; every self-hosted listing. |
| #531 (card accept, C5) | `catalog install --update` (K9). | Everything else. |
| #541 (`meshctl login`) | Nothing: no sign-in in v0 (§3.8). An agent that declares OAuth installs once #541 lands, like any added agent. | — |
| Web search's identity label | #547's web search listing. | The rest. |
| C9 (unslop's card) | Nothing: unslop is not listed. | — |

## §10 — Slices

Each slice is one PR, mergeable alone in dependency order. Sizes are production lines / test lines.

| Slice | Issue | Ships | Size | Depends on |
|---|---|---|---|---|
| K1 | #542 | This design; on acceptance, the mesh design amendments of §14 | docs | — |
| K2 | #545 | `src/catalog.ts`: the parser with every cap and member rule; `templateSha256` (`canonicalCard`'s flag); the catalog verifier (`card-signature.ts` with `typ` as a parameter); the freshness rules as pure functions; `meshctl catalog sign`; `docs/catalog/catalog-v0.md` served at the format URI by `scripts/pages-site.mjs` | ~260 / ~380 | K1 accepted |
| K3 | #545 | `catalog add`, `refresh`, `list`, `remove` and `status`'s line; the `catalogs` record and the cache; exits 18 and 19 in `docs/mesh-call.md`; `docs/catalogs.md` with the public thumbprint | ~280 / ~400 | K2 |
| K4 | #545 | `catalog install` for both kinds through `add`'s code path; the `listing` provenance member; `meshctl check --card-file` (static tests only) | ~200 / ~320 | K3 |
| K5 | #543 | `catalog export`: both files, `--public` | ~120 / ~180 | K4 (shares the listing builder) |
| K6 | #544 | The `agent-catalog` repository: layout, `build.mjs`, both workflows, the signing environment, the browse page, CONTRIBUTING and REVIEWING | ~400 / ~250, outside this repo | K2, K4; §13 Q1–Q3 |
| K7 | #546 | `src/mesh-catalogs.ts`, `GET /api/mesh/catalogs`, the Catalog fold, docs in `viewer-dashboard-and-shell.md` and `mesh.md` | ~220 / ~300 | K3 |
| K8 | #547 | Web search answers `a2a-mesh/v1`; its guide, served by Pages (`pages-site.mjs` learns `docs/guides/`); the web search and echo listings; the third-party listing when agreed | ~40 / ~60 here, listings there | K6; §13 Q4 |
| K9 | #545 (follow-up) | `catalog install --update` through `add --accept-card` | ~60 / ~100 | K4, #531 |

**Tests** (real loopback servers and temp directories, `scratchDir()`, no mocks of the rules):

- **K2:** each top-level and listing rule, pass and fail (bad `format`, an id with uppercase, 201
  listings, a 257 KiB file, nesting 17 deep, a hosted listing with `templateSha256`, a skill count of
  17, a string over its cap); a good signature; a tampered listing; `typ: "JOSE"` refused for a
  catalog and `agent-catalog+jws` refused for a card; `alg: none`, `HS256`, a header `jwk` ignored;
  `kid` naming no listed key; the template pin equal for two copies of one card with different
  keys and different for a changed skill; `sign` refuses a key the catalog does not list;
  freshness: lower `sequence` refused, equal `sequence` with other bytes refused, equal and same
  accepted as no change, expired refused, `issuedAt` 6 minutes ahead refused, 91-day validity refused.
- **K3:** a good catalog added (dry run writes nothing; `--apply` writes the record, the cache
  `0600` and a backup); a bad signature; `--key-thumbprint` mismatch; a changed key not endorsed
  (exit 19) and one endorsed by a trusted key (accepted, one stderr line); a rollback and a stale
  catalog on refresh keep the old cache; an unsigned catalog from a file accepted and from a public
  name refused; a redirect and a private-address answer refused with zero further requests; `list`
  with two catalogs agreeing and disagreeing; `remove` leaves installed agents alone. Off tests
  still pass, and `disable --apply` removes `catalogs` with the file.
- **K4:** hosted install matching (dry run, then `--apply` writes the entry with `listing`); a
  drifted card (exit 18, what differs named, nothing written); a card signed by an unlisted key;
  an id mismatch; self-hosted without `--card-url` (exit 0, nothing fetched); self-hosted matching
  with the human's own key; self-hosted with a changed skill (18); an expired catalog (19); two
  disagreeing catalogs without `--catalog`; a built-in name without `--id`; install, then `call`,
  then `remove`; `check --card-file` passes the echo sample and skips `card.fetch`, `endpoint.rule`
  and the live tests.
- **K5:** the export validates against the catalog parser; the AI Catalog file has the mapped
  members and no `digest`; no token, token path or key path appears in either file; an agent that
  fails `check` is left out; `--public` with only local agents writes empty `entries`.
- **K7 (jsdom):** the empty state; one catalog; two catalogs with the same agent (once, both
  names) and disagreeing (twice); a listing whose card changed (button disabled, reason shown); an
  expired catalog; a hostile name and description render as text; the copied command for an id that
  fails syntax is absent; an idle poll paints nothing; `/api/version` bytes unchanged with no record.
- **K6 (in its repository):** the build script on fixture listings; the page escapes a hostile
  listing; the phrase table matches meshctl's; a PR fixture with a drifted hosted listing fails.

## §11 — Risks

| Risk | Mitigation |
|---|---|
| The catalog's signing key leaks from CI | A protected environment only `main` can use; the signing job runs no listing code. A stolen key signs valid catalogs until it is rotated out, so rotate on any doubt (§3.5). §13 Q3 offers an offline key instead. |
| The first fetch of a catalog is forged | `--key-thumbprint`, with the thumbprint in two repositories (§3.5). |
| A curator lists a harmful agent | `install` still shows every claim and asks for `--apply`; the catalog vouches for the card and the source reference, not for the agent's behaviour, and the page says so. |
| A self-hosted copy is built from other code than the listed commit | Not detectable: meshctl checks the card the copy serves, not its code. The guide pins the commit; the template pin catches a different card. |
| The weekly schedule is disabled after 60 quiet days | The catalog expires and fails closed; REVIEWING.md says how to re-enable it. |
| AI Catalog or ARD changes shape | Only the exporter changes. |
| `sequence` from the clock goes backwards | The publish job signs with one more than the served `sequence` when the clock is behind it (§5.3), so a slow runner clock cannot roll the catalog back. |

## §12 — Alternatives considered

- **No catalog; a README of card URLs.** No signature, no pins, nothing `install` can check.
- **A catalog server with search.** Contradicts "no server needed"; M3's registry is the place for
  a live index.
- **Listing only a card URL and a pin.** The list and browse page would fetch every card to show
  anything, and the viewer would need network access.
- **Verifying the catalog in the viewer too.** Protects nothing against the threat model's
  same-user process, which can write `mesh.json` as easily as a cache.
- **Auto-delisting drifted agents in CI.** CI then edits the catalog's content without review; a
  `state` flag says "do not trust this listing" without removing anything.

## §13 — Questions for Shariq

1. **Where does the public catalog live (#544)?**
   - **A. A separate repository, `shariqh/agent-catalog`, on Pages at `https://shariqh.github.io/agent-catalog/` (recommended).** Keeps third-party pull requests, their CI and the signing secret out of the app's repository.
   - B. A `catalog/` directory in this repository, at `https://shariqh.github.io/agent-inbox/catalog/`. No new repository, but listing traffic and a signing secret beside the app.
   - C. A new GitHub organisation. A neutral name, but a new owner to secure.
2. **Who may merge listings?**
   - **A. Only Shariq, enforced by CODEOWNERS and branch protection (recommended).** One curator matches one signing key and a small catalog.
   - B. Shariq and up to two named maintainers. Faster review; each maintainer can change what the catalog vouches for.
3. **Who holds the catalog's signing key?**
   - **A. CI, in a protected `catalog-signing` environment; re-signed weekly, valid 30 days (recommended).** Freshness without Shariq's weekly attention; a leak is as bad as a repository takeover.
   - B. Shariq signs on his Mac and commits the signed file; valid 180 days. The key never leaves the Mac, but freeze protection weakens to six months and every listing change waits for him.
   - C. Two keys (TUF's split): Shariq's offline key signs the listings, a CI key re-signs only the freshness wrapper. Strongest, but a second signed object and more code in v0.
4. **What does the public catalog list first, and is v0 done without a third-party agent?**
   - **A. Web search and echo as soon as K6 lands; a third-party agent joins when its publisher agrees, and #547 closes without it if none has by the milestone's end (recommended).** Ships what we control.
   - B. Hold the catalog until a third-party publisher agrees. Proves the outside path first, with an open-ended wait.
   - C. Web search only. The smallest catalog, without the example authors start from.
5. **Allow self-hosted listings?**
   - **A. Yes: two kinds, hosted and self-hosted, with the template pin (recommended).** Everything public is installable now; hosted public listings follow #534 with no format change.
   - B. Hosted only. One install path, but the public catalog has nothing installable until #534 and someone runs a public agent.
6. **Catalogs behind sign-in?**
   - **A. Not in v0; a private catalog is a file or lives on the tailnet (recommended).** No secret in a catalog, and no dependency on #541.
   - B. Design catalog sign-in with #541 now. Private catalogs on the public internet, with a resource and token rules of their own.

## §14 — Amendments to the mesh design

Proposed text, applied to [`2026-10-29-agent-mesh-design.md`](2026-10-29-agent-mesh-design.md) when
this design is accepted. All of it planned, none shipped. **The D-numbers are provisional:** if
#534's or #541's amendments merge first and take D25 onwards, these move up at merge.

**Header note**, after #533's:

> **Amended 2026-11-11 by #542** ([`2026-11-11-catalog-v0-design.md`](2026-11-11-catalog-v0-design.md)):
> catalog v0, a signed static list of agents meshctl can read (D25–D31): its format, trust and
> freshness rules, `meshctl catalog` with `install` as `add` with the listing's expectations, a
> public catalog repository, an `ai-catalog.json` export, and a read-only Catalog view in the
> Agents home. All of it is planned, none shipped (milestone "Mesh: catalog v0"). It touches §1,
> §6.7, §8.8, §9.5, §10.1, §11 (M9) and §14.1.

**§1, non-goals**, after "No dependence on `a2a-lib`, AGNTCY, the MCP Registry or a cloud registry
(decision 2).":

> The mesh may read catalogs the human records with `meshctl catalog add` (#542, D25), but depends
> on none: adding, calling and checking agents work with no catalog, removing every catalog changes
> no added agent, and nothing downloads or runs an agent's code.

**§6.7**, a row in the entry's field table:

> | `listing` | Planned (#545, D27): `{ catalog, id, sequence }`, written by `meshctl catalog install`
> to record which listing the agent came from. Shown, never used to decide anything: `call` checks
> the pin as for any entry, and the catalog is not consulted again. |

and a paragraph after "Signed cards":

> **Catalogs (#542, D25–D29; planned, #545).** A catalog is one signed JSON file of listings. A
> hosted listing pins a card URL, its pin and its keys; a self-hosted listing pins a source
> commit, a guide and a template pin (the pin without the profile's keys), so every copy with its
> own key matches. `meshctl catalog install <listing>` runs `add` with the listing's expectations
> and refuses a card that does not match (exit 18); the human still approves with `--apply`
> ([`2026-11-11-catalog-v0-design.md`](2026-11-11-catalog-v0-design.md) §3, §4).

**§8.8**, a bullet after "Publishable cards":

> - **Catalogs (#542, D25 and D29; planned).** Only meshctl fetches a catalog: from a file,
>   loopback, this Mac's tailnet, or a public `https://` name that resolves to no loopback,
>   link-local or private address; one GET, no redirect, no proxy, no token, 256 KiB, 5 s, TLS
>   verified. A catalog from a public name must be signed. Only `catalog install` fetches a
>   listing's card, by `add`'s rules; a listing's guide and source are never fetched. The viewer
>   never fetches a catalog or a listed card: it reads the cache meshctl verified.

**§9.5**, appended:

> *Amended 2026-11-11 by #542 (D25, D30, D31; planned).* The catalog file is catalog v0, signed by
> its curator's key (JWS over JCS, `typ` `agent-catalog+jws`), trusted on first use or by
> thumbprint, with a sequence and an expiry. AI Catalog is written by `meshctl catalog export`,
> unsigned; ARD is not written in v0. A public catalog lives in its own repository with CI and a
> browse page.

**§10.1**, appended:

> *Amended 2026-11-11 by #542 (D29; planned, #546).* The Agents home's Mesh agents section gains a
> read-only Catalog fold: listings from meshctl's verified caches, with a Copy install command
> button. The viewer installs nothing and fetches nothing for it.

**§11, M9**, appended to the amendment sentence:

> *Amended 2026-11-11 by #542 (D25):* the catalog itself (format, `meshctl catalog`, a public
> catalog repository and the AI Catalog export) is the milestone "Mesh: catalog v0" (#543–#547).

**§14.1**, rows after D24:

| Date | Decision | Source |
|---|---|---|
| 2026-11-11 | **D25.** Catalog v0: one JSON file in our own format (`https://shariqh.github.io/agent-inbox/catalog/v0`) with an id, publisher, `sequence`, `issuedAt`, `expiresAt`, signing keys and at most 200 listings, at most 256 KiB; AI Catalog and ARD are export formats only. The mesh reads catalogs it is told about and depends on none. Why: stable while the proposals move, and it carries what meshctl checks. Planned: #545 | Shariq (#542) |
| 2026-11-11 | **D26.** Catalogs are signed like cards (A2A §8.4-shaped JWS, ES256, raw JCS) with `typ: "agent-catalog+jws"`; keys are trusted on first use or by `--key-thumbprint`, and a new key when a trusted key signs the catalog listing it; a lower `sequence`, a reused `sequence` with other bytes, and an expired catalog are refused; validity at most 90 days. Unsigned catalogs only from a file, loopback or this Mac's tailnet. Why: one verifier; TUF's rollback and freeze protection without its roles. Planned: #545 | Shariq (#542) |
| 2026-11-11 | **D27.** Two kinds of listing: hosted (card URL, card pin, key thumbprints) and self-hosted (source commit, guide, template pin: the card pin without the profile's keys). `meshctl catalog install` is `add` with the listing's expectations, refuses a card that does not match (exit 18) or an expired catalog (exit 19), and never downloads or runs code; the human approves with `--apply`. Why: lists what is installable before #534, and the catalog backs first contact. Planned: #545 | Shariq (#542) |
| 2026-11-11 | **D28.** No sign-in to catalogs in v0; a private catalog is a file or lives on the tailnet. Why: a catalog holds no secret, and #541 is per agent. | Shariq (#542) |
| 2026-11-11 | **D29.** The viewer shows catalogs from meshctl's verified cache only: no fetch, no verification, no install; a Copy install command button without `--apply`. Why: no new outbound request from the viewer, and the stdio MCP process stays network-free (D3). Planned: #546 | Shariq (#542) |
| 2026-11-11 | **D30.** The public catalog: its home, merge rights and key custody as §13 Q1–Q3 of the catalog design decide; CI runs `meshctl check --strict` on every listed card, never runs a publisher's code, and signs in a job that sees only the built index; a static browse page on Pages. Planned: #544 | Shariq (#542) |
| 2026-11-11 | **D31.** `meshctl catalog export` writes this Mac's conformant agents as an unsigned catalog v0 file and an unsigned `ai-catalog.json` (`urn:air:` identifiers, `application/a2a-agent-card+json`, the card URL, our pins under our extension key, no `digest`). Planned: #543 | Shariq (#542) |

## Appendix A — Verification log (2026-11-10)

| Fact | Result | Source |
|---|---|---|
| AI Catalog status | Repository "Working repository for common AI Card standard"; editor's draft at ai-catalog.io; no tags or releases. Head `8abd4b16` (2026-11-09); `specification/ai-catalog.md` last changed in `d7c10d48` (2026-10-07). | `Agent-Card/ai-catalog` |
| AI Catalog shape | Media type `application/ai-catalog+json`; top level `specVersion` and `entries` (MUST), `host`, `extensions`, `signature` (OPTIONAL). Entry: `identifier`, `type`, one of `url` or `data` (MUST); `displayName`, `description`, `tags`, `version`, `updatedAt`, `extensions`, `publisher`, `digest`, `trustManifests` (OPTIONAL). Publisher: `identifier`, `displayName` (MUST), `identityType` (OPTIONAL). `identifier` RECOMMENDED as `urn:air:{publisher}:{namespace}:{name}`. Well-known path `/.well-known/ai-catalog.json`, OPTIONAL. | same, `specification/ai-catalog.md` |
| AI Catalog signing and freshness | `signature` with `signer`, `profile`, `issuedAt`, `jws` (MUST) and `expiresAt` (OPTIONAL); `jws` a detached compact JWS over the JCS form without `signature.jws`; `typ` `ai-catalog+jws`; `b64` forbidden; one profile, `did:web` with ES256. No version counter or rollback rule. No size limit or pagination: consumers set their own ceilings. `digest` hashes the exact retrieved bytes. Extension keys are URLs or reverse-DNS; unknown keys are ignored. | same |
| ARD | v0.91, "Proposal", dated 2026-08-26; head `f073b1ea` (2026-10-25); no tags. Consumers MUST read `/.well-known/ard.json` and MAY read `ai-catalog.json`. Entry: `identifier`, `displayName`, `type`, one of `url` or `data`. `urn:air:<publisher>:[<namespace>:]<agent-name>`. No document-level signature; `trustManifest` per entry. | `ards-project/ard-spec` `spec/ard.md` §4.2, §4.5.2, §5.1 |
| A2A release | v1.0.1 (2026-05-28) is the latest release. Tag `v1.1.0-rc` (2026-10-29) has no release. | `gh api repos/a2aproject/A2A/releases`, `/tags` |
| A2A discovery, v1.0.1 | §8.2: well-known URI, registries and catalogs, direct configuration. `docs/topics/agent-discovery.md`: "does not prescribe a standard API for curated registries". | `docs/specification.md`, `docs/topics/agent-discovery.md` at `v1.0.1` |
| A2A discovery, `dev-1.1` | PR #2240 (merged 2026-10-21) makes AI Catalog at `/.well-known/ai-catalog.json` "Preferred" for public agents; §14.1.2 registers `application/a2a-agent-card+json` provisionally (IANA registration not done). | `dev-1.1` at `78e1d6a1` (2026-10-29) |
| TUF | Spec 1.0.37 (2026-10-08): roles root, targets, snapshot, timestamp; every role file has `version` and `expires`; the client workflow's "Check for a rollback attack" (a lower version is discarded) and "Check for a freeze attack" (expired metadata is discarded). | theupdateframework.github.io/specification/latest |
| minisign | Ed25519; a signature file of an untrusted comment, the signature (algorithm, 8-byte key id, signature), a trusted comment and a global signature over the signature and trusted comment. Release 0.12 (2025-01-15). | jedisct1.github.io/minisign |
| Sigstore | `cosign sign-blob --bundle` writes a bundle with the signature, certificate and transparency-log proof; keyless signing needs its online services. cosign v3.1.4 (2026-10-20). | docs.sigstore.dev |
| Go checksum database | Signed tree heads in the signed-note format: text, a blank line, then `— <name> <base64(key hash ‖ signature)>`; verifier keys `<name>+<hash>+<keydata>`. | go.dev/design/25530-sumdb; pkg.go.dev/golang.org/x/mod/sumdb/note |
| MCP Registry | "Preview"; namespace ownership checked at publish (GitHub OAuth for `io.github.*`, domain proof for others); no signature over `server.json` or the index found in its docs. | `modelcontextprotocol/registry` `docs/` at `fae187ab` (2026-11-10) |
| RFCs | RFC 7515 JWS (Appendix F, detached content); RFC 7797 unencoded payload (`b64` requires `crit`); RFC 7638 JWK thumbprint; RFC 8725 JWT best practices (§3.11, explicit typing); RFC 8785 JCS. | rfc-editor.org |
| GitHub Pages | `github.io` sites are served over HTTPS; published site ≤ 1 GB; 100 GB a month soft bandwidth. | docs.github.com, "GitHub Pages limits", "Securing your GitHub Pages site with HTTPS" |
| GitHub Actions schedules | In a public repository, scheduled workflows are disabled after 60 days without repository activity. | docs.github.com, "Events that trigger workflows" |
| This repository | `add`, `check`, the verifier and signer, the profile, the echo example and web search's signed card are on `main` at `f64e5a5c`. Web search's front door answers the proof label `web-search/v1`; the kit's default is `a2a-mesh/v1`. | `src/`, `packages/mesh/src/web-search/front-door.ts`, `packages/mesh/src/kit/identity.ts` |
