# web-search conformance fixtures (W2, #505)

The contract between the web-search agent (`packages/mesh/src/web-search/`, on `@a2a-js/sdk`) and
its clients: `meshctl web-search` (W5b, Node core), the S13 bench (W6) and any later copy on
another host. Design:
[`docs/superpowers/specs/2026-11-09-web-search-a2a-agent-design.md`](../../../docs/superpowers/specs/2026-11-09-web-search-a2a-agent-design.md)
§4, §6, §7.1, §8.1 and §11. Every value is a placeholder: names, hosts, addresses (documentation
ranges and loopback only), tokens and page text are not real.

| File | Holds |
|---|---|
| `card.json`, `card.sha256` | The card as W1 serves it, and its hash: SHA-256 of the JCS form of the card as received, with `signatures` and every `supportedInterfaces[].url` removed and no SDK normalisation (§4.1, amended by #556) |
| `exchanges/*.json` | One request and response (or stream of events) per §4.4 row, **recorded from W1's server**, with the exit a client gives it; GetTask; the identity challenge and proof. Exits 14 and 4 are client-side notes. `01-answer.json` is the accepted `returnImmediately: false` |
| `refusals/*.json` | Requests the front door refuses before the SDK, with the JSON-RPC error each gets |
| `providers/*.json` | Neutral shapes of SearXNG's `/search?format=json` and Ollama's `web_search` and `web_fetch` answers, their 429 and 5xx, for W3 |
| `pages/*.json` | Synthetic injected titles, snippets and passages (§8.1), each `suspect` |
| `screen.json` | Query screen cases (§7.1): each class refused, and the near misses that must pass |
| `grounding.json` | §6's containment check cases, passing and failing, each failure naming its rule |
| `conformance.ts` | The validator: `checkCard`, `cardHash`, `checkExchange`, `checkRefusal`, `checkResult`, `exitFor`, `checkManifest`. Node core only and erasable TypeScript |
| `MANIFEST.json` | The SHA-256 of every other file here |

## What W2 pins

- **No `history`.** No Task response carries the caller's message or the status messages, for
  any method, `CancelTask` included: the agent's task store keeps no history, and the front door
  also adds `historyLength: 0` to every send and to `GetTask`. A caller's own `historyLength` is
  refused.
- **Where the data part is.** On `COMPLETED` it is the second part of the one artifact, after a
  text part; on `REJECTED` and `FAILED` it is in the status message, after `<outcome>: <reason>`.
  Every data part carries `code`, the exit it maps to. A refusal names the class or reason, never
  a value, and no response echoes the query.
- **Streams.** The first event is the `SUBMITTED` task; `WORKING` messages are only `searching`,
  `answering` and `checking`; the artifact comes only immediately before `COMPLETED`.
- **Screen classes.** Unslop's `email-address`, `phone-number`, `secret`, `customer-path` and
  `deny-list`, plus `private-name` and `home-path` (§7.1); `shape` is the layer before them.

## Recording

The exchanges and the card are recorded, not written: `packages/mesh/test/web-search-record.ts`
starts W1's front door and executor on loopback, sends each request, and replaces ids,
timestamps and the port with placeholders. `packages/mesh/test/web-search-fixtures.test.ts`
re-records in memory and fails if a committed file differs, so a change in the SDK's or the front
door's output shows up as a fixture diff. To re-record (Node 24):

```sh
cd packages/mesh && node --import ./test/ts-hooks.mjs test/web-search-record.ts write
cd ../.. && node test/fixtures/a2a-web-search/conformance.ts manifest > test/fixtures/a2a-web-search/MANIFEST.json
```

Change any other file by hand, then rewrite the manifest the same way and say in the pull
request that the contract changed.
