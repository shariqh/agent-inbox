# Design: Message a running agent session (issue #411)

**Date:** 2026-10-30
**Status:** Draft. Three questions for the owner are in §10.
**Milestone:** v2.2.0. Closes #411 when the second PR lands.
**Scope of this PR:** this document only. No source or test changes.

---

## §0 — Summary

1. The human writes a **message** to one listed MCP session from the Live drawer, the Agents
   view or a Dashboard lane. The message is an instruction, with the trust of typing in that
   session's terminal.
2. A message addresses the MCP server's `session` id, which is one CLI process with its
   subagents. It follows that session wherever it registers. It never goes to another session.
3. Messages live in a new table, `session_messages`, not in `items`. One whole-table snapshot
   domain covers it, and one new conditional snapshot, `GET /api/messages`, reads it.
4. `pending()` gains `messages`: the open messages addressed to the calling server's own
   session, oldest first. They come back on every poll until the agent acknowledges them.
5. A new MCP tool, `acknowledge({ id, outcome })`, closes a message with a one-line outcome.
   Only the addressed session can acknowledge it.
6. Pickup and acknowledgement are separate. The first delivery is stamped and never moves, and
   the stamp is not an acknowledgement.
7. **Claude wake:** the hooks already link to their own servers through `host_pid` (#253).
   `stop`, `prompt-submit`, `session-start` and `watch` also count unpicked messages for those
   servers. The protocol shapes and exit codes do not change.
8. **Copilot wake:** a standing per-session watcher (`watch-cli --session <id>`). `pending()`
   returns its launch contract only when no live watcher covers the session. The MCP server
   never spawns it.
9. The UI shows sent, picked up and acknowledged, with the outcome. It also says whether the
   session wakes now or sees the message at its next turn.
10. An unsent message is a durable draft (#279). Open messages also show in the Inbox's
    "with the agent" foot. Nothing reaches `public/attention.js`, a badge, a count or the dock.
11. Two PRs. PR 1 adds the store, API routes, MCP, the agent contract and the Claude wake. PR 2
    adds the UI, the Copilot watcher and the wake indicator.

---

## §1 — Addressing

**Target: the MCP server's `session`** (`sessionId` in `src/mcp.ts`, the `session` key of
`/api/activity`). It is a random UUID made once per server process.

- **One per CLI process.** Subagents share their parent CLI's server, so a message reaches the
  CLI session. It never reaches one subagent. Any subagent of that session may pick it up or
  acknowledge it. This is the same sharing as the context ledger, and it is stated in the UI copy.
- **Survives Claude `/clear`.** The server keeps its id across `/clear` (#253), so a queued
  message is still delivered after one. A message must therefore make sense on its own. The
  agent contract says so (§6).
- **Re-registering keeps the address.** A message follows its session. `pending()` returns the
  session's messages whatever the session's current project, and whatever `project` the call
  passes. The row stores the session's `project`, `stream` and `agent` as they were at send
  time. Those are for display and for the Inbox foot's project lens only. Delivery never reads
  them.
- **Restart means a new id.** `claude --resume`, `copilot --resume` or a server crash starts a
  new server with a new UUID. An open message to the old id can no longer be delivered. It is
  not re-addressed automatically: guessing a successor by project, branch and agent could deliver
  an instruction to the wrong session. The UI derives "This session is no longer running" (§5)
  and offers Withdraw and Copy text.
- **Who can be addressed.** Any session `/api/activity` lists: working, idle or dormant, and not
  ended or silent for 15 minutes. Idle and dormant sessions are the main use, such as a quiet
  terminal you want to redirect. The send route checks presence in the same transaction as the
  insert (§2), so an ended session is refused.
- **Capability gate.** Only servers that know `session_messages` can deliver messages. This
  build's presence writes (registration and `status`) set a new nullable column,
  `activity.receives_messages = 1`. Older servers never name it, and a write that omits it keeps
  it, like `server_version`. The store refuses a session without it with `reason:
  'session_cannot_receive'`. A flag is used, not a semver comparison: a checkout keeps reporting
  `2.1.0` until the release bump, and its sessions must still be able to receive during
  development. The UI shows the same rule before Send, as "Restart this session to load a build
  that receives messages (v2.2.0 or later)". `activity` has no snapshot domain, so the column
  costs nothing there.

## §2 — Storage

**A new table, not a new item kind.** Overloading `items` would put messages into
`listItemsPage`, `/api/items`, the dock's attention projection, History paging (#184), the
issue and links domains and search. Each of those would need a `kind` exclusion, and
`attention.js` would then have to know about a kind it must ignore. A separate table touches
none of them. It needs one domain and one snapshot, and older processes never see it.

```sql
CREATE TABLE IF NOT EXISTS session_messages (
  id TEXT PRIMARY KEY,                 -- client-generated UUID: an exact replay never duplicates
  session TEXT NOT NULL,               -- the address (§1)
  project TEXT NOT NULL,               -- session's project at send (display and lens only)
  stream TEXT NOT NULL DEFAULT '',
  agent TEXT NOT NULL DEFAULT 'unknown',
  text TEXT NOT NULL,                  -- the human's words, 1–4000 UTF-16 units, never trimmed
  created_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1, -- moves on acknowledge and withdraw only
  status TEXT NOT NULL DEFAULT 'open', -- open | acknowledged | withdrawn
  delivered_at TEXT,                   -- first delivery to the addressed session; never moves
  delivered_by TEXT,                   -- that reader's client name
  outcome TEXT NOT NULL DEFAULT '',    -- the agent's one-line result
  closed_at TEXT                       -- when it was acknowledged or withdrawn
);
CREATE INDEX IF NOT EXISTS idx_session_messages_session ON session_messages(session, status, created_at);
CREATE INDEX IF NOT EXISTS idx_session_messages_closed ON session_messages(status, closed_at);
```

**Migration.** The new table and its indexes go in `runMigrations`. `migrateSnapshotDomains`
stays last. A fresh hub and an upgraded hub get the same schema. Nothing older is altered.

**Domain and snapshot.** Add `session_messages: { table: 'session_messages', restamped:
['delivered_at', 'delivered_by'] }`. A whole-table domain gets its insert, delete and update
triggers from the existing generator. Those triggers are made last, from the live columns,
with double-quoted identifiers. The restamped columns get value-checked triggers, so
`pending()` re-delivering on every poll rebuilds nothing. Add `SNAPSHOT_SOURCES.messages =
['session_messages']`, served at `GET /api/messages` through `conditionalSnapshot`. Its body
is `{ open: Message[], closed: Message[] }`: every open message, oldest first, and the 100
newest closed messages by `closed_at`, then `id`. The body is built from the database alone, so
a store token can validate it. `test/fixtures/snapshot-triggers.txt` gains the new trigger
names, which is an addition, so no existing trigger changes. The table is read by a snapshot, so
it needs no `UNREAD` entry. It has no column domain, so it needs no `REVIEWED_COLUMNS` entry.
`test/snapshot-probe.ts` adds the route, and the generic domain test's fixture adds an open
message, a delivered one and a closed one.

**Writes. Each is one statement, or one `.immediate()` transaction, and none is a select
followed by an update.**

| Function | Who | Condition | Moves |
|---|---|---|---|
| `sendSessionMessage({id, session, text})` | viewer | `.immediate()`: reads the presence row (listed, not ended, `receives_messages = 1`), counts the session's open messages (≤ 20), then runs `INSERT … ON CONFLICT(id) DO NOTHING`. A conflicting id with the same session and text is a replay and returns `ok`. Any other conflict returns `id_conflict`. Also prunes closed messages more than 30 days old, and open messages more than 30 days old. | new row |
| `markMessageDelivered(id, session, reader)` | MCP `pending` | `UPDATE … SET delivered_at = COALESCE(delivered_at, now), delivered_by = COALESCE(delivered_by, ?) WHERE id = ? AND session = ? AND status = 'open'`. Returns true only when the message is still open, so it is safe to hand over. | nothing (restamped) |
| `acknowledgeMessage(id, session, outcome)` | MCP `acknowledge` | `… SET status = 'acknowledged', outcome = ?, closed_at = now, revision = revision + 1 WHERE id = ? AND session = ? AND status = 'open'` | revision |
| `withdrawSessionMessage(id, revision)` | viewer | `… SET status = 'withdrawn', closed_at = now, revision = revision + 1 WHERE id = ? AND status = 'open' AND revision = ?` | revision |

The text never changes after it is sent. To correct a message, withdraw it and send a new one.
So delivery needs no text pin. The status condition is the pin: a withdrawn message is never
handed over, and an acknowledged one cannot be withdrawn. The `session = ?` condition is
the delivery guarantee: no other server can stamp, read through `pending()`, or acknowledge a
message it was not sent. Every refusal returns a reason: `not_found`, `not_open` (with the
current status and outcome) or `revision_changed`.

**Mixed versions.** Older processes never name the table, so none of their statements can
change a message or move its domain. An older server receives no messages: its presence row
never carries `receives_messages`, so the capability gate (§1) refuses a send to it. An older
viewer sharing the hub shows no messages. Any process's activity housekeeping (`DELETE FROM
activity …` after a day) removes presence rows but never messages; a message whose session row
is gone reads as "no longer running" in this build's UI, which is true. `listActivity` serves
`receives_messages` as a boolean so the page can apply the gate. `test/mixed-version.test.ts`
gets two cases. First, frozen v2.1.0 presence, item and plan statements on a migrated hub move
no `session_messages` version and leave messages unchanged. Second, a session whose presence a
frozen v2.1.0 statement wrote is refused with `session_cannot_receive`.

## §3 — Delivery and acknowledgement

**`pending()` gains `messages`.** It is always present, and `[]` when there is nothing. It holds
the open messages where `session = this server's sessionId`, oldest first. Each entry is
`{ id, text, sent_at, delivered_at, project }`. Each entry passes `markMessageDelivered` first,
and one that returns false is dropped. That is the same filter shape as rows.

- **Re-delivered until acknowledged.** Messages follow blocked rows (#37): the agent may lose
  context (`/clear`, compaction or a subagent's poll), and an instruction delivered once can
  be lost silently. The bound is the 20-open limit, plus the agent contract: acknowledge as
  soon as you have acted on a message, including when you take it on as tracked work.
- **Never trimmed.** `text` is the human's words, so the #42 context rules do not apply and
  `full` changes nothing here. A message carries no agent context.
- **`pending({item_id})` returns `messages: []`.** A targeted read returns no board rows either.
- **Siblings never see it.** No MCP tool takes a session argument, so a server can only read and
  acknowledge messages to its own `sessionId`. That id is never accepted from the caller.

**`acknowledge({ id, outcome })`.** This is a new tool. `outcome` is required, 1 to 240
characters, and says what the agent did, declined or took on, and where. It returns
`{ ok: true }` or `{ ok: false, reason, status?, outcome? }`. When the human withdrew the
message, it returns `reason: 'not_open', status: 'withdrawn'`, and the agent should stop if it
has not finished.

Why a new tool rather than extending `resolve` or `answer`: `resolve` acknowledges an item
response and is pinned to `expected_response_revision`. `answer` records a chat answer and is
governed by the inbox-wins rule. Sharing either one's id space would put a type switch inside
a version-pinned path for no gain. One small, clearly named tool keeps the existing contracts
byte for byte. The cost is about 120 tokens of tool definition per session.

## §4 — Wake

### Claude Code: the hooks

`sessionScope` already gives each hook the linked servers (`scope.servers`). Add the store read
`listUndeliveredMessages(sessions)`: open, `delivered_at IS NULL`.

- `stop`, `prompt-submit` and `session-start` count those messages next to the unpicked
  responses. When there are any, the nudge adds one clause: "and the human sent this session
  N message(s): call `pending()` now, act on each, then `acknowledge` it with an outcome".
  The output shapes are unchanged: `stop`'s `{decision:'block'}` (never when
  `stop_hook_active`), `prompt-submit`'s nested `additionalContext`, and `session-start`'s
  one line of text.
- `watch`: an undelivered message at arming wakes it at once, unless `stop_hook_active`. Such
  a wake takes no lease. While it waits, any new undelivered message for `scope.servers` wakes
  it with exit 2, and the payload stays on stderr. A superseded watcher does not wake for
  messages, because the newer one covers the same session. An unlinked hook cannot know its
  servers, so it does not wake for messages. That case falls back to the next turn.
- **Limit:** the watcher lives `AGENT_INBOX_WATCH_SECS` (29 minutes) after each Stop. A Claude
  session idle for longer sees a message at its next turn (§10, question 1). The hook only reads.
  It never stamps delivery, so the agent's own `pending()` stays the pickup.
- `rewakeSummary` is unchanged ("your answer arrived"). It is part of `hooksSettingsBlock`,
  the installed shape that Setup and `install-hooks.sh` share, so changing it would make every
  existing install need re-applying for a label.

### Copilot: (a) a standing session watcher. Recommended.

| | (a) standing watcher | (b) next-poll only |
|---|---|---|
| Idle session | wakes within ~2 s | sees it only when the human next types in that terminal |
| Cost | one detached Node process per Copilot session (~40 MB), one indexed read every 2 s, a 60 s heartbeat; one turn a day to re-arm | none |
| Complexity | ~120 lines in `watch.ts`, one lease function, contract text | UI copy only |

(b) makes messaging an idle Copilot session pointless, and that is the main case. (a) reuses
the host-owned contract that question watchers already prove.

- **Contract.** `pending()` adds `session_watch` (the `copilotWatchLaunch` shape, with
  `shell_id: agent-inbox-session-<id>`, `timeout_seconds: 86400`, and argv `[node, …execArgv,
  watch-cli, --session, <id>, <db>]`). It is added only when `inferAgent` is `copilot`, no
  fresh lease covers this session, and this process has not offered one in the last 2
  minutes. The last condition is an in-process memo, so a concurrent subagent poll does not
  get a duplicate.
- **Lease.** The watcher uses `hook_watch_claims` with key `copilot-session:<id>`. It cannot
  collide with the hook's `host:`, `session:` and `project:` keys. The table is already
  `UNREAD`, so no snapshot moves. A new store function, `claimSessionWatch(key, token,
  staleMs)`, inserts the lease, or takes over one whose `claimed_at` is more than 3 minutes
  old. The watcher refreshes `claimed_at` every 60 s. If a fresh lease is held, a new watcher
  exits 3 at once ("another watcher covers this session; do not re-arm"). The first holder
  wins, so a duplicate never ends the running watcher. Release is compare-and-delete.
- **Exit codes.** 0: an undelivered message is waiting ("call `pending()` now; it returns a
  fresh `session_watch` to re-arm"). 3: do not re-arm, because the session ended (its presence
  row is ended or gone) or another watcher covers it. 124: 24 hours passed; call `pending()` for
  a fresh contract. Each prints one stdout line and no message text.

### The wake indicator (PR 2)

`listActivity` adds `wakes: boolean` to each row. It reads the lease table only, in the query
that already runs. It is true when a fresh lease covers that session: for Claude,
`host:<host_pid>` claimed within 30 minutes; for Copilot, `copilot-session:<session>` refreshed
within 3 minutes. `/api/activity` stays a bare array and is never retained. `activityFrameKey`
compares bytes, so a flip repaints. This is presence, not attention.

## §5 — UI (PR 2)

**One composer, two hosts, one draft per session.** `public/messages.js` is pure: entry
building, status text and the per-session view. `app.js` mounts `composerEl(session)` in two
places:

- **Live drawer.** Each working entry and each idle row gets a **Message** button. It opens the
  composer under that entry. Its open state is keyed by session, like `openLive`.
- **Dashboard session focus panel** (#307). It gets a **Message** part with the composer and
  this session's history. A lane's title already opens the panel, so this is the lane's way in.
- **Agents view** (only when `mesh-view.js` loaded). Each `.mesh-session` line gets a
  **Message** button that calls an injected `openMessage(session)`, the same seam as
  `jumpToAsk`. It opens the Live drawer with that session's composer open and focused. The
  Agents view itself still fetches nothing.

**Composer.** It has a labelled textarea ("Message to copilot · agent-inbox · feat-x") with a
4000-character counter, plus **Send** and **Cancel**. One line below says what happens next,
from `wakes`, `agent` and `receives_messages`: "It wakes for this now", "Claude Code sees
this at its next turn", "Copilot sees this at its next turn: it has no message watcher
running", or "Restart this session to load v2.2.0 or later". Send is disabled for a session
that cannot receive. The message id is generated when a send is first claimed, and a retry
reuses it, so a replay is exact (§2). A refusal keeps the text, with its reason in the
composer's `role="status"` slot.

**History and status.** Below the composer: this session's messages from `/api/messages`,
newest first, up to 5 shown, with "+N earlier". Each shows the human's text through `esc()` and
one status line: "Sent 2m ago · not picked up yet", "Picked up 1m ago · working on it",
"Acknowledged 30s ago: <outcome>" (agent text through `renderStructuredText`) or "Withdrawn".
An open message whose session is no longer listed reads "Not delivered: this session is no
longer running" or "Picked up, but the session ended before acknowledging". Open messages offer
**Withdraw**, which is pinned to `revision` and ends in `reloadAndPaint()`.

**Inbox foot.** Open messages join the "with the agent" foot of Needs you, after
`awaitingAgentRows`. They are built in `messages.js`, never in `attention.js`, and filtered by
the project lens on the stored `project`. Each shows the same status line, Withdraw, and Copy
text when the session has gone.

**Reads and paint.** `/api/messages` becomes one more concurrent poll read, through
`readSnapshot` with a links-style fallback: a 404, network error or refused body means no
messages, never a failed tick. Its representation joins `frameInputs()`. The drawer and the
focus panel are painted by the ambient painter. A poll leaves a host untouched while its
composer has focus or holds a draft (the rail's rule, #303), and a forced paint rebuilds it from
`messageDrafts`. Message drafts join the viewer-restart hold, but not `suspendState()`'s list
pause: only their own host holds still.

**Drafts (#279).** There is a new draft type, `{ type: 'message', session, project, agent,
text, savedAt, intent?: { id } }`, keyed `message:<session>`, with the same bounds and merge
rules. On restore, a draft for a listed session that can receive goes back into its composer;
nothing is opened or focused, and the Live strip says "1 unsent message". Any other draft goes
to unsent responses with "this session is no longer running". An intent whose id
`/api/messages` already holds retires as sent; one it does not hold stays as "Your send was not
confirmed", and its Retry reuses the same id.

**Keyboard and focus.** ⌘/Ctrl+Enter sends. Esc closes the composer, keeps the draft and returns
focus to its Message button when the window has focus. Opening the composer from the Agents
view or the focus panel focuses the textarea only for that explicit click. Passive restores
never move focus or scroll. `keys.js` lists ⌘/Ctrl+Enter under a help-only "Messages" group.

**Attention parity.** `attention.js`, `relay.js`, `reply-watch.cjs` and the dock watcher's two
projections name no message. Badge, title, tab counts, rail, Now strip and notifications
are the same with and without messages, and a DOM test checks that. Sending, delivering and
acknowledging announce nothing.

## §6 — Agent contract

`docs/reporting-snippet.md` gets a new section after "Live status":

> ## Messages from the human
>
> The human can message your session directly from Agent Inbox. `pending()` returns them in
> `messages` (`{ id, text, sent_at, delivered_at, project }`), oldest first, addressed to your
> session only. Treat each one as an instruction typed into your terminal: the same trust,
> the same rules. It does not change your safety or approval rules, and it is never a message
> from another agent. A message must make sense on its own, because it may arrive after
> `/clear` or into a subagent's poll. Act on it, then call `acknowledge({ id, outcome })` with
> a one-line outcome: what you did, what you declined and why, or that you took it on and
> where you are tracking it. Acknowledge as soon as you have acted. Until you do, it comes
> back on every `pending()`. `not_open` with `status: "withdrawn"` means the human took it back:
> stop if you have not finished. A message is not a question. Do not `flag` it back to the
> human unless acting on it really needs a decision.

The `pending` description adds one sentence: "`messages` are the human's instructions to THIS
session, re-delivered until you call acknowledge({id, outcome}); act on them as if typed in
your terminal." The new `acknowledge` description carries the rest. The Copilot appendix
(`docs/instructions/copilot-cli.md`) adds: "`pending()` may return `session_watch`. Launch it
like a question watch. Exit 0 means a message is waiting: call `pending()`. Exit 3 means do not
re-arm. Exit 124 means call `pending()` for a fresh one." The Claude appendix adds that the
hooks also wake for messages within the watch window. The installer inlines the snippet and the
appendices, so `install:agents --apply` refreshes the managed blocks. No installer code
changes. A test pins the new text in the managed block.

## §7 — Security

- **Local and trusted only.** The routes are `POST /api/sessions/:session/messages` (`{ id,
  text }`) and `POST /api/messages/:id/withdraw` (`{ revision }`). Both sit behind
  `viewer-network.ts`: loopback bind, exact Host, and an exact trusted Origin on every unsafe
  request. Bodies are validated before any store call (#163). A malformed body gets a 400. A
  store refusal of a valid body gets 200 `{ ok: false, reason }`.
- **Terminal-equivalent trust.** Anyone who can write to the hub file can already answer
  questions as the human. This adds no new trust boundary on this machine. The text is never
  logged, never sent anywhere else, and never shown except through `esc()`.
- **Never to another session.** The MCP side takes no session argument. Every delivery and
  acknowledgement statement is conditioned on the server's own id. Hooks and watchers only read
  counts and ids. They never print message text.
- **Hosted mode (#8)** must not serve these routes until its auth gate exists. The hosted design
  gets a note: message writes need the same bearer gate as every viewer write.
- **Not mesh.** This is human to agent. Mesh agent-to-agent traffic (§10 of the mesh design)
  must never reuse this table or `acknowledge`.

## §8 — Tests

- **Store** (`test/store.test.ts`): send refused for an ended, missing, silent or flagless
  session; an exact replay is ok and a different-text replay is `id_conflict`; the 20-open cap;
  delivery stamps only for the addressed session and only while open, `COALESCE` keeps the first
  stamp; acknowledge only by the addressed session and only while open; withdraw pinned to
  revision; pruning.
- **Snapshots** (`test/snapshot-domains.test.ts`, `test/viewer.test.ts`): the new domain and
  triggers; the fixture file; a re-delivery moves nothing; `/api/messages` bytes and 304s; other
  snapshots unmoved by message writes; route validation (400 versus 200 `ok:false`) and the
  Origin gate.
- **MCP integration** (acceptance): two real stdio servers in one project. A message to A
  reaches only A's `pending()`, comes back on every poll until `acknowledge`, B cannot
  acknowledge it, the outcome is recorded, and a withdrawn message is refused.
- **Hook** (acceptance): a linked `watch` exits 2 on a message to its own server and not on one
  to a sibling; `stop` blocks once and honours `stop_hook_active`; `prompt-submit` and
  `session-start` shapes; an unlinked hook ignores messages; stdout bytes unchanged.
- **Watcher** (`test/watch.test.ts`): `--session` exits 0 on a message; exits 3 on a fresh lease
  or an ended session; exits 124 on a forced timeout; heartbeat and takeover after 3 minutes;
  the contract is offered only to Copilot, only without a fresh lease, and once per 2 minutes.
- **Mixed version:** the cases in §2.
- **DOM** (`test/dom/session-messages.test.ts`): compose from the drawer, the focus panel and
  the Agents view; status transitions across polls; Withdraw; the capability gate and ended-session
  copy; a draft surviving polls, reload and an unconfirmed send; the 404 fallback; and attention
  parity across every surface (`test/dom/issue-attention.test.ts` style).
- `test/dead-exports.test.ts`, `test/prstate.test.ts` (no new stdio import) and
  `test/instructions-budget.test.ts` stay green.

## §9 — Phasing

**PR 1 — the agent side (`Part of #411`).** It adds the table, domain and snapshot, the store
functions, `/api/messages` and both write routes, `pending.messages`, `acknowledge`, the Claude
hook wake, the reporting snippet and the Claude appendix, and the architecture docs
(`delivery-and-responses.md`, `store-and-snapshots.md`, `hooks-and-watcher.md`,
`docs/hooks.md`). It is safe alone: no page sends, and the routes need a trusted Origin. It is
useful alone: sessions started on this build can receive, which can be checked with one
trusted-Origin `curl` (documented), and the protocol lands before the UI depends on it. Until
PR 2, a Copilot session gets messages at its next `pending()` only (option (b)).

**PR 2 — the human side and Copilot (`Closes #411`).** It adds `public/messages.js`, the
composer in the drawer, focus panel and Agents view, the Inbox foot, drafts, `wakes`, the
Copilot session watcher and its contract, the Copilot appendix line, and
`viewer-frontend.md`/`activity-and-live.md`. Every invariant of PR 1 holds unchanged.

**Non-goals.** No ⌘K "message" command, no editing a sent message, no re-addressing an
undelivered one, no native notification on acknowledgement, and no message search.

## §10 — Questions for the owner

1. **Claude's 29-minute watch window.** A Claude session idle for longer than its last Stop's
   window sees a message at its next turn. Raising it means a longer hook `timeout`, and every
   install would need `install:hooks --apply` again. **Recommend:** keep the window for v2.2.0
   and let the wake indicator say it honestly.
2. **One Copilot watcher per session for its whole life** (~40 MB, a read every 2 s, a re-arm
   turn per day). **Recommend:** yes. Without it, messaging an idle Copilot session does
   nothing until you type in its terminal.
3. **Where acknowledged outcomes live after the session ends.** v2.2.0 shows them only in the
   session's history while it is listed, and keeps them 30 days. **Recommend:** a follow-up
   issue to fold them into Just landed and History, if wanted.
