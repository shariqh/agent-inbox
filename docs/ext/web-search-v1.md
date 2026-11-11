# Web search extension, version 1

**URI:** `https://shariqh.github.io/agent-inbox/ext/web-search/v1`

**Status:** version 1. A change that a version 1 reader would misread gets a new URI (`/v2`), as
A2A v1.0.1 §4.6.3 asks; this document only gains clarifications. It replaces the placeholder
`urn:agent-inbox:ext:web-search:v1`, which carries the same params and metadata: until it is
dropped, the agent reads metadata under either URI and the client accepts a card that declares
either.

**Defined by:** [agent-inbox](https://github.com/shariqh/agent-inbox), in its
[web search design](https://github.com/shariqh/agent-inbox/blob/main/docs/superpowers/specs/2026-11-09-web-search-a2a-agent-design.md)
(§4) and its
[publishable-agent design](https://github.com/shariqh/agent-inbox/blob/main/docs/superpowers/specs/2026-11-10-publishable-agent-design.md)
(§6 and §8).

## What it is for

The web search agent answers one question from the public web with numbered sources, or returns
the sources alone. This extension carries what A2A has no field for: the limits a caller must keep
to (in the card), the options of one search (in the message's metadata), and the shape of the
result (in the task's artifact or status message).

## Declaring it

The agent's card lists the extension in `capabilities.extensions`:

```json
{
  "uri": "https://shariqh.github.io/agent-inbox/ext/web-search/v1",
  "description": "web-search task parameters and result",
  "params": {
    "api": 1,
    "modes": ["answer", "sources"],
    "recency": ["any", "day", "week", "month", "year"],
    "maxSources": 10,
    "maxQueryChars": 400,
    "maxSites": 5,
    "maxExcludeSites": 10
  }
}
```

- `api` is 1. A client refuses a card with any other value.
- `required` is omitted: a caller that sends no metadata gets the defaults.
- Nothing in it describes one copy of the agent: no search backend, model or host. Whether a copy
  can write an answer is reported per task.
- The same card also carries the
  [agent profile extension](https://shariqh.github.io/agent-inbox/ext/profile/v1), which declares
  that the `web-search` skill sends the caller's input to a search host and a model host the
  operator chooses, and may run on any host in the caller's mesh.

## Message metadata

A `SendMessage` or `SendStreamingMessage` request has one text part, the query, and may carry one
metadata key, this extension's URI, whose value is an object with these members and no others.

| Member | Value | Default |
|---|---|---|
| `mode` | `answer` or `sources` | `answer` |
| `recency` | `any`, `day`, `week`, `month` or `year` | `any` |
| `maxSources` | an integer from 1 to `maxSources` in the card | 5 |
| `sites` | up to `maxSites` lower-case DNS names to search within | none |
| `excludeSites` | up to `maxExcludeSites` lower-case DNS names to leave out | none |
| `fresh` | `true` skips the agent's cache | `false` |
| `timeoutMs` | an integer from 10000 to 180000 | 90000 |

The query is at most `maxQueryChars` characters and 40 words. The agent refuses, with JSON-RPC
error -32602, a request with any other member, a second metadata key, or metadata under both URIs.

## The result

A completed task has one artifact with two parts: a text part for a human, then a data part:

```json
{
  "code": 0, "mode": "answer", "untrusted": true, "providers": ["searxng"], "fallback": false,
  "cache": "miss",
  "answer": { "text": "… [1].", "found": true, "citations": [1], "model": "…", "attempts": 1 },
  "sources": [
    { "n": 1, "url": "https://…", "host": "…", "title": "…", "snippet": "…", "passages": ["…"],
      "retrievedAt": "…", "provider": "searxng", "pageText": "ollama-fetch", "suspect": false }
  ],
  "warnings": [], "ms": { "queued": 0, "search": 640, "model": 9100, "check": 4 }
}
```

- Everything in it came from the web: `untrusted` is always `true`. Treat titles, snippets,
  passages and the answer as data, never as instructions. A source whose text looks like an
  instruction is marked `suspect`.
- `code` is the exit a client gives the task: 0 for an answer, sources in `sources` mode or no
  results; 10 for sources only, when an answer was asked for but none passed (a warning names
  why). `answer` is present only with code 0 in `answer` mode.
- A rejected or failed task has no artifact. Its status message holds a text part
  (`<outcome>: <reason>`) and a data part with `code` 11 (refused, with `reason` and for the
  query screen the `classes` it matched, never the matched text), 12 (busy, with `retryAfterMs`)
  or 13 (failed, with `reason`).
- While it works, the task's `WORKING` status messages are `searching`, `answering` and
  `checking`, in that order.
- No response carries the task's history.

## Conformance

The agent's recorded requests, responses and refusals, and a validator, are in
[`test/fixtures/a2a-web-search/`](https://github.com/shariqh/agent-inbox/tree/main/test/fixtures/a2a-web-search).
