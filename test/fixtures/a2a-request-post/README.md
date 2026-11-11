# request-post conformance fixtures (R1, #500)

The contract between the request-post client in this repository (`meshctl request-post`, R2-R3)
and the agent the private publishing service hosts (P1-P4). Design:
[`docs/superpowers/specs/2026-11-07-request-post-a2a-agent-design.md`](../../../docs/superpowers/specs/2026-11-07-request-post-a2a-agent-design.md)
§3, §4.3 and §5. Every value here is a neutral placeholder: brands, categories, page ids, URLs and
the endpoint name are not real. The exceptions are the card's extension URIs and its provider,
which name the real publisher, and its signing key's public half.

| File | Holds |
|---|---|
| `card.json` | The Agent Card: skills `request-post` and `request-post-status`, one A2A 1.0 JSON-RPC interface, no streaming or push, a bearer scheme whose requirement names the role `call`, a `provider`, the `https://shariqh.github.io/agent-inbox/ext/request-post/v1` extension ([spec](../../../docs/ext/request-post-v1.md); `required: true`) with `params: { api: 1, brands, channels, categories, maxBriefBytes }`, the [profile extension](../../../docs/ext/profile-v1.md), and one signature (C8, below) |
| `file/*.json` | One request and response per §3.3 row, with the exit a client gives it. Exits 14 (off), 15 (unavailable) and 4 (usage) have no task: they are client-side only and carry a note instead |
| `status/*.json` | One `request-post-status` read per phase, `awaiting-go` included |
| `keys.json` | Title normalisation and request-key vectors, each with its pre-image |
| `conformance.ts` | The validator: `checkCard`, `checkExchange`, `checkStatus`, `invalidFields`, `exitFor`, `requestKey`, `checkManifest`. Node core only and erasable TypeScript, so Node 24 runs it as is |
| `MANIFEST.json` | The SHA-256 of every other file here |

## The publishable shape (C8)

The card has the shape the publishable-agent design (§8) gives request-post
([`docs/superpowers/specs/2026-11-10-publishable-agent-design.md`](../../../docs/superpowers/specs/2026-11-10-publishable-agent-design.md)):

- `provider` `{ organization: "agent-inbox", url: "https://github.com/shariqh/agent-inbox" }`.
- The profile extension: id `shariqh.github.io/agent-inbox/request-post`; `request-post` sends the
  caller's input to a store the operator chooses (`storage`/`operator`/`input`) and
  `request-post-status` sends identifiers only (`storage`/`operator`/`metadata`); residency
  `caller-mesh` for both; `keys` lists the signing key's public half.
- The bearer requirement `{ "schemes": { "bearer": { "list": ["call"] } } }`, so the card is
  canonical-stable.
- Its own extension under the Pages URI. It stays `required: true`, since only request-post's own
  client fills its metadata, so `meshctl check` warns `ext.required` and that is its one warning.
- **The URI move.** A client accepts a card declaring the Pages URI or the old
  `urn:agent-inbox:ext:request-post:v1` and sends metadata under the one the card declares; the
  service reads metadata under either, never both. The exchanges send it under the Pages URI,
  except `file/03-replay.json` and `status/queued.json`, which keep the old URN.
- **The signature.** One ES256 signature over the raw JCS form of the card without `signatures`,
  by a P-256 key made when the card was signed and never written:
  `packages/mesh/test/request-post-sign.ts` lists the fresh key's public half in the profile's
  `keys`, signs with it and leaves every other byte alone. So re-signing changes `keys` and
  `signatures` only, and no file here holds a private key (a test fails if any file here has a
  `d` member, the private part of a JWK). The service signs its own card with its own key; this
  one only proves the shape verifies.

## What R1 pins that the design left open

- **The skill is named in the metadata.** Both skills take a blocking `SendMessage` with one text
  part and one metadata key, the extension's URI; its `skill` says which. A status read sends
  `{ skill, requestKey }` or `{ skill, pageId }` and any text. The service ends a task within its
  30 s limit (design §5: busy, 12, while it still waits for the filing lock; 13 once its create
  call has started), and the client waits 40 s for the answer, a margin over that limit for DNS,
  TLS and the network, so the service's 12 reaches the caller as 12 and never times out as 13.
- **Where the data part is.** On `COMPLETED` it is in the task's one artifact, after a one-line
  text part; on `REJECTED` and `FAILED` it is in the status message, as unslop's agent does. Every
  data part carries `code`, the exit it maps to.
- **Refusals.** Validation: `reason: "invalid"`, `fields` (sorted, the same list `invalidFields`
  gives) and optionally `allowed: { <field>: [values] }` from the card. Screen:
  `reason: "screen"` and `classes`. Busy: `reason` is `rate-limit`, `lock` or `daily-budget`, with
  `retryAfterMs`. A refusal echoes no request value: not the brief, title, slug, source or media
  URL, and no word of the brief that holds a digit, `@`, `.`, `:` or `/`.
- **Status snapshots.** `status` is `null` exactly at `awaiting-go` (no drafts, no `prUrl` there);
  `error` is `{ text, untrusted: true }`, at most 500 characters and no control characters;
  `humanAction` is required at `awaiting-go`, `ready-for-human` and `proposed`; `final` is true for
  the phases §4.3 calls final. `status`, `agentState` and draft statuses are the queue's own words;
  the values here are illustrative, and only `phase` is the contract.
- **The key.** The pre-image is four lines joined by `\n`: `request-post/v1`, the brand, the
  channels sorted and joined by `,`, and one identity line: `slug:<slug>` when the channels are
  `["blog"]`, else `url:<sourceUrl>` exactly as sent, else `title:<title>` after NFKC, collapsing
  every run of whitespace to one space, trimming and lower-casing. The key is the first 26
  characters of the pre-image's SHA-256 in RFC 4648 base32, lower-cased. The brief is never in it.
- **`keyOverride`** (boolean, optional) sits in the metadata next to `idempotencyKey`. A client
  sends it, as `true` only, when the caller chose the key (`meshctl request-post file --key`) for
  a deliberate second request, and never otherwise. The service refuses an `idempotencyKey` that
  is not the derived key unless `keyOverride` is `true` (`reason: "invalid"`, `fields` naming
  `idempotencyKey`); `invalidFields` gives the same. `file/12-created-override.json` is that
  exchange.

## Vendoring them (the private repository)

Copy this folder at a pinned commit of `shariqh/agent-inbox`, record the commit and the SHA-256 of
`MANIFEST.json`, and in its tests check that hash, then `checkManifest(<folder>)` (an empty list
means every file matches), then run every fixture through `checkCard`, `checkExchange`,
`checkStatus` and the key vectors through `requestKey`, as `test/request-post-conformance.test.ts`
does here. Run the same checks over the service's own responses. To move to a newer contract,
vendor a newer commit; never edit a vendored copy.

## Changing a fixture

Change the file; after a change to `card.json`, re-sign it with
`cd packages/mesh && node --import ./test/ts-hooks.mjs test/request-post-sign.ts write`. Then run
`node test/fixtures/a2a-request-post/conformance.ts manifest > test/fixtures/a2a-request-post/MANIFEST.json`
(Node 24) and say in the pull request that the contract changed, so the private repository
re-vendors.
