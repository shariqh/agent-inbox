# request-post extension, version 1

**URI:** `https://shariqh.github.io/agent-inbox/ext/request-post/v1`

**Status:** version 1. A change that a version 1 reader would misread gets a new URI (`/v2`), as
A2A v1.0.1 §4.6.3 asks; this document only gains clarifications. It replaces the placeholder
`urn:agent-inbox:ext:request-post:v1`, which carries the same params and metadata: until it is
dropped, the agent reads metadata under either URI and the client accepts a card that declares
either.

**Defined by:** [agent-inbox](https://github.com/shariqh/agent-inbox), in its
[request-post design](https://github.com/shariqh/agent-inbox/blob/main/docs/superpowers/specs/2026-11-07-request-post-a2a-agent-design.md)
(§3 to §5) and its
[publishable-agent design](https://github.com/shariqh/agent-inbox/blob/main/docs/superpowers/specs/2026-11-10-publishable-agent-design.md)
(§6 and §8).

## What it is for

The request-post agent files one publishing request (a blog post, an X thread or post, a LinkedIn
post) in a publishing queue and reads it back, and reads the state of the requests it filed.
Nothing it files is published without a human's approval. This extension carries what A2A has no
field for: the values a request may use (in the card), the fields of one request or status read
(in the message's metadata), and the shape of the result (in the task's artifact or status
message).

## Declaring it

The agent's card lists the extension in `capabilities.extensions`:

```json
{
  "uri": "https://shariqh.github.io/agent-inbox/ext/request-post/v1",
  "description": "request-post parameters, results and status snapshots",
  "required": true,
  "params": {
    "api": 1,
    "brands": ["example-brand", "second-brand"],
    "channels": ["blog", "x-thread", "x-standalone", "linkedin"],
    "categories": ["example-category", "second-category"],
    "maxBriefBytes": 8192
  }
}
```

- `api` is 1. A client refuses a card with any other value.
- `brands`, `channels` and `categories` are the values a request may use; they come from the
  copy's own configuration. `maxBriefBytes` is at most 8192.
- `required` is `true`: every request names its skill in this extension's metadata, so a client
  that does not speak it cannot call the agent. `meshctl check` warns `ext.required` for that
  reason; request-post's own client (`meshctl request-post`) speaks it.
- The card has two skills, `request-post` and `request-post-status`, one A2A 1.0 JSON-RPC
  interface, no streaming and no push notifications.
- The same card also carries the
  [agent profile extension](https://shariqh.github.io/agent-inbox/ext/profile/v1), which declares
  that `request-post` sends the caller's input to a store the operator chooses, that
  `request-post-status` sends identifiers only, and that both may run on any host in the caller's
  mesh.

## Message metadata

Both skills take a blocking `SendMessage` with one text part and one metadata key, this
extension's URI (or the old URN, never both). Its `skill` member names the skill.

**`request-post`.** The text part is the brief: the request's context for whoever drafts it, at
most `maxBriefBytes` bytes of UTF-8, with no control character but tab and newline.

| Member | Value | Required |
|---|---|---|
| `skill` | `request-post` | yes |
| `brand` | one of the card's `brands`: where it is published, not what it is about | yes |
| `channels` | `["blog"]`, or a non-empty set of `x-thread`, `x-standalone` and `linkedin` | yes |
| `title` | at most 120 characters | yes |
| `idempotencyKey` | the request key (below), at most 128 characters | yes |
| `keyOverride` | `true` only, when the caller chose another key on purpose | no |
| `category` | blog only, and required there: one of the card's `categories` | blog |
| `slug` | blog only, and required there: `^[a-z0-9]+(-[a-z0-9]+)*$`, at most 80 characters | blog |
| `seo` | blog only | no |
| `sourceUrl` | social only: an `https://` URL | no |
| `media` | social only: at most four `https://` image URLs | no |

A pull request URL is refused in any field. The agent never fetches `sourceUrl` or `media`.

**The request key.** The first 26 characters, lower-cased, of the RFC 4648 base32 form of the
SHA-256 of four lines joined by `\n`: `request-post/v1`, the brand, the channels sorted and joined
by `,`, and one identity line: `slug:<slug>` for blog, else `url:<sourceUrl>` exactly as sent,
else `title:<title>` after NFKC, collapsing whitespace, trimming and lower-casing. The brief is
never part of it, so sending the same request again finds the same row. The agent refuses a key
other than the derived one unless `keyOverride` is `true`.

**`request-post-status`.** Members `skill` (`request-post-status`) and exactly one of
`requestKey` or `pageId`. The text part is ignored.

## The result

A completed task has one artifact with a one-line text part, then a data part. A rejected or
failed task has no artifact: its status message holds the text and the data part. Every data part
carries `code`, the exit a client gives the task.

**`request-post`:**

```json
{ "code": 0, "created": true, "pageId": "…", "url": "https://…", "requestKey": "…",
  "brand": "example-brand", "channels": ["blog"], "phase": "awaiting-go", "readBack": "ok" }
```

| Task | `code` | Data |
|---|---|---|
| Completed: filed and read back, or the key was already filed (`created: false`) | 0 | the row as above |
| Rejected: invalid | 11 | `reason: "invalid"`, `fields` (sorted) and optionally `allowed: { <field>: [values] }` |
| Rejected: the screen | 11 | `reason: "screen"` and the `classes` it matched |
| Rejected: busy | 12 | `reason` `rate-limit`, `lock` or `daily-budget`, and `retryAfterMs` |
| Failed: the outcome is unknown | 13 | `outcome: "unknown"`, and `pageId` when known |
| Rejected: another row covers this | 16 | `reason: "conflict"` and `conflict: { pageId, url, phase }` |

- A refusal names fields and classes, never a value from the request.
- A blog request is filed at `phase: "awaiting-go"`: a human gives the go before it is drafted.
- On 13 the caller sends the same request again, or reads its status by key; the key makes that
  safe.

**`request-post-status`:**

```json
{ "code": 0, "phase": "ready-for-human", "status": "…", "agentState": "…",
  "prUrl": "https://…", "drafts": [{ "pageId": "…", "url": "https://…", "channel": "x-thread", "status": "…" }],
  "error": { "text": "…", "untrusted": true }, "humanAction": "…", "final": true }
```

- `phase` is `awaiting-go`, `queued`, `drafting`, `in-review`, `ready-for-human`, `proposed`,
  `needs-fix`, `failed`, `rejected` or `published`, and it is the contract; `status`,
  `agentState` and the drafts' `status` are the queue's own words.
- `status` is `null` exactly at `awaiting-go`, where there are no drafts and no `prUrl`.
- `error` is at most 500 characters with no control characters, and always marked untrusted.
- `humanAction` says what the human does next, and is present at `awaiting-go`,
  `ready-for-human` and `proposed`. Ready is not approval: a caller reports it and stops.
- `final` is true at `awaiting-go`, `ready-for-human`, `proposed`, `needs-fix`, `failed`,
  `rejected` and `published`.

## Conformance

The contract's requests, responses and status reads, the request key vectors, and a validator
are in
[`test/fixtures/a2a-request-post/`](https://github.com/shariqh/agent-inbox/tree/main/test/fixtures/a2a-request-post).
