---
paths:
  - "test/requests.test.ts"
applyTo: "test/requests.test.ts"
---

# Requests (#612)

A request is one record per thing the person asked a session to do. This is PR 2 of #612: the table, the store functions and the `request` tool. Design: [`docs/superpowers/specs/2026-11-15-requests-design.md`](../superpowers/specs/2026-11-15-requests-design.md). The hooks that open requests (PR 3) and the viewer (PR 4) are not built yet, so after this PR **nothing opens a request by itself**. An agent can only declare one with the tool.

Claude Code and Copilot CLI load this file when they read or edit a file matching the `paths`/`applyTo` globs above; anyone else should read it before changing request code in `src/store.ts` or `src/mcp.ts`. Later PRs add their files to the globs.

## In brief

- No prompt text is ever stored, logged or hashed. A request holds an agent-written title, note and outcome only.
- Every write of the `request` tool is scoped to the calling server's own session. Another session's request reads `not_found`. No call takes a session or project argument.
- `activity.tracks_requests` exists as a column, and `listHostSessions` returns it with `started_at`, but **nothing writes it**. PR 4 turns it on. Until then no hook may act on requests, and main is safe at every commit. Tests set the column directly.
- `closeRequest` writes the request's close and its item in one `.immediate()` transaction, so a close never leaves an item without its request being closed, or a closed request without its item. A `dropped` close writes no item. An item is not deleted with its request: retention prunes a request 30 days after it closed and leaves its item, which is an ordinary closed item.
- The item a close writes carries the **scope at close** (project, stream, agent, repo, issue, head repo and repo root, all read from the session's scope at that moment, as `flag` stamps its items). The request row keeps the project and stream it opened in, so after a `register` or a branch change the two can differ.
- A request is never an attention item, a badge or a count of its own. A review reaches Needs you through its hand-off item (`delivery-and-responses.md`), and a done request reaches Just landed and History through its outcome item.

## The table

`requests` (created by `CREATE TABLE IF NOT EXISTS` in `runMigrations`; older processes never name it): `id` (lowercase UUID), `project`, `stream`, `agent`, `session` (the hub session it belongs to now), `chat` (`claude:<harness session_id>`, NULL when agent-declared), `turn` (Claude Code's `prompt_id` at opening), `midturn` (1 when sent while that turn already ran; PR 3's hook writes it), `origin` (`prompt` or `agent`), `state`, `title` (1 to 120), `note` (0 to 240), `outcome` (0 to 240), `next_step` (a review's action, 1 to 180), `parent`, `issue_repo` and `issue_number` (as `board_rows`), `item`, `revision`, and the stamps `opened_at`, `filed_at`, `updated_at`, `closed_at`, `acked_at`, `ack_delivered_at`. Indexes: `idx_requests_session(session, state, opened_at)`, `idx_requests_chat(chat, state)`, `idx_requests_closed(state, closed_at)`.

| State | Meaning |
|---|---|
| `unfiled` | the hook opened it; the agent has not said what it is |
| `open` | filed as new, or declared by the agent |
| `review` | closed, and the person should look; its hand-off item is open |
| `done` | finished |
| `dropped` | will not be done |
| `reply` | only a reply to something already in hand; never shown |
| `merged` | part of `parent`; never shown on its own |

The snapshot domain is `requests = { table: 'requests', restamped: ['ack_delivered_at'] }`, a whole-table domain like `session_messages`. No snapshot reads it yet (`GET /api/requests` is PR 4), so `test/snapshot-domains.test.ts` lists it in `AWAITING_ROUTE` and a write to it rebuilds nothing.

## Ids

A tool id is the full id or a prefix of at least 8 characters of lowercase hex and dashes that is unique among the **session's own** requests, whatever their states (`resolveRequestId`). Otherwise the call answers `ambiguous_id` or `not_found`. The short id is the first 8 characters, or the **full id** when another request of the same session shares those 8 characters. Every `short` the store returns follows that rule (the open and change results, `pending()`, `listUnfiledRequests`, `listRequests`), so a short always resolves to its own request.

## Store functions (`src/store.ts`)

| Function | Does |
|---|---|
| `openPromptRequest` | the hook's door: prunes, checks the cap, copies project, stream and agent from the live presence row, inserts an `unfiled` request of origin `prompt`. Returns `{ ok: true, id, short }` or `{ ok: false, reason }` with `bad_chat`, `bad_turn`, `session_not_live`, `reserved_project` or `cap`, so the hook can log `request: cap` |
| `openAgentRequest` | the tool's `open`: an `open` request of origin `agent`, or `too_many_open`, or `title_required` for a blank title |
| `fileRequest` | `unfiled` to `open` (as new, needs a title), `merged` (as part_of; the note moves to the parent and the parent's `updated_at` moves) or `reply`. A request that is not `unfiled` answers `not_unfiled` with its state |
| `updateRequest` | `open` only: note, title, issue. A field left out is kept; `""` clears the note and `null` clears the issue |
| `closeRequest` | see below |
| `listSessionRequests` | this session's `unfiled` and `open` requests, oldest first, at most 20, and how many are past that |
| `markAcksDelivered` | the reviews acknowledged since the last delivery, each stamped `ack_delivered_at` (`COALESCE`) in the same statement |
| `listUnfiledRequests` | ids, turn and `midturn` of the unfiled requests of given sessions, for the Stop hook (PR 3). Never text |
| `adoptChatRequests` | the only re-address path: moves a chat's `unfiled` and `open` requests from a session that is not live to a live one |
| `listRequests` | the viewer's read (PR 4): `{ open, closed }`, never `chat`, `turn`, `midturn` or `ack_delivered_at` |
| `dropOrphanRequest` | the viewer's Close for a request whose session is gone (PR 4) |
| `pruneRequests` | retention, run at the start of every request open |

`adoptChatRequests` does **not** apply the cap of 50. A session that adopts a dead session's requests can hold more than 50, after which nothing new opens there (`cap`, `too_many_open`) until some close.

`adoptChatRequests` and `dropOrphanRequest` call a session live while its presence row is not ended, was refreshed inside the 15-minute window, and its `server_pid`, when it has one, still runs (`kill(pid, 0)`). `adoptChatRequests` also needs the target to be live, and never takes a live session's requests.

### Closing

`closeRequest` works from `open`, and from `unfiled` when a `title` is given (it files as new and closes in one transaction; without a title it answers `title_required`). `outcome` is required (1 to 240).

- `done` (the default) inserts a **resolved outcome item** with `insertItemRow`, never `insertItem`, so there is no dedupe: `kind: 'done'`, `next_step: 'No action'`, `outcome`, `resolved_at` and `outcome_at` set. Just landed, History, the ribbon and "Since you last looked" show it with no new code.
- `dropped` writes no item.
- `review: true` needs a next step that is a real action (`isHandoffInput`: "No action", "None" and the like answer `next_step_required`) and refuses `dropped`. It sets `review` and inserts an open **hand-off item** (`handoff = 1`, `action_owner: 'task'`, title the request's, detail the outcome, `next_step` the request's) in the same transaction.
- The item carries the scope at close: `project`, `stream`, `agent`, `repo`, `issue_ref`, `head_repo` and `repo_root` all come from the tool's scope at that moment, and `session` from the request. Without a scope the store falls back to the request's own project, stream and agent. `requests.item` names the item.

### Settling a review

A `review` request is settled by its hand-off item:

- `acknowledgeHandoff` sets the request `done` with `acked_at` and sets the item's outcome to the request's outcome (not "Acknowledged").
- `resolveItem` and `dismissItem` set it `done` without `acked_at`.
- Each settlement sets `closed_at` to the settlement time, so retention and the 24-hour window run from then.
- `listRequests` reads a `review` request whose item is no longer open as `done`, closed when the item was. That covers an older server resolving or dismissing the item, whose statements name no request.

## `pending()`

An untargeted `pending()` carries `requests` (the session's unfiled and open requests, on every poll until filed or closed), `requests_more` (only when more than 20), and `requests_acknowledged` (`{ id, short, title, acked_at }`, handed over once). `markAcksDelivered` can be taken by a subagent's poll first; that is acceptable because it is informational. A targeted `pending({ item_id })` carries none of them and consumes no acknowledgement.

## Limits

Title (1 to 120), note (0 to 240), outcome (1 to 240) and next step (1 to 180) are limited **after trimming**, so a title of 120 characters followed by a space is accepted. The tool schema sets no length on them for that reason; the store refuses an over-long one with an error. `issue` is bounded at 300 characters, like the other issue fields.

## Caps and retention

At most 50 `unfiled` and `open` requests per session. Past that the tool's `open` answers `too_many_open` and `openPromptRequest` returns null. `pruneRequests` deletes `done` and `dropped` 30 days after `closed_at`, `reply` and `merged` 1 day after, `unfiled` and `open` 30 days after `updated_at`, and a `review` 30 days after its item closed (never while the item is open).

## The tool

`request` takes `action` (`file`, `open`, `update`, `close`) and the fields in the table of the design (§3.6). It returns `{ ok: true, request: { id, short, state, title, note } }` or `{ ok: false, reason, state? }` with the reasons `not_found`, `ambiguous_id`, `not_unfiled`, `not_open`, `parent_not_open`, `title_required`, `next_step_required` and `too_many_open`. `open` with no title answers `title_required`, as `file` as new does. A call that lacks another input its action needs, an issue it cannot read, and a `dropped` close with `review: true` are tool errors, not reasons, so the reason list in the description stays as the design wrote it. `close` does not read `note` or `issue`. The description is pinned verbatim by `test/mcp.integration.test.ts`. `agentScope()` refuses a reserved project (`@sessions`, `@mesh`).

## Older processes

No statement an older server runs names `requests` or `activity.tracks_requests`, so its presence, call, item and answer writes change no request, clear no flag and move no domain (`test/mixed-version.test.ts`).
