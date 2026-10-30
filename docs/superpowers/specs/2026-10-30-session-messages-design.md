# Design: Message a running agent session (issue #411)

**Date:** 2026-10-30 (revised after design review, same day)
**Status:** Approved to build after changes. Three questions for the owner are in §11.
**Milestone:** v2.2.0. Closes #411 when the third PR lands.
**Scope of this PR:** this document only. No source or test changes.

---

## §0 — Summary

1. The human writes a **message** to one listed MCP session from the Live drawer, the Agents
   view or a Dashboard lane. It is an instruction, with the trust of typing in that session's
   terminal.
2. A message addresses the MCP server's `session` id: one CLI process and its subagents. It
   follows that session wherever it registers, and never goes to another session.
3. Messages live in a new table, `session_messages`, not in `items`. One whole-table snapshot
   domain covers it, and one new conditional snapshot, `GET /api/messages`, reads it.
4. `pending()` gains `messages`: the open messages addressed to the calling server's own
   session, oldest first, re-delivered until acknowledged. A new tool, `ack_message({ id,
   outcome })`, closes one; only the addressed session can.
5. Subagents share the server, so the contract tells a subagent to hand messages to its
   parent verbatim and never act on or ack them. The Claude wake counts **open** messages, not
   undelivered ones, so a subagent's pickup cannot hide one from the top-level agent.
6. **Claude wake:** the hooks already link to their servers through `host_pid` (#253). `stop`
   blocks once per message, `watch` wakes for messages that arrive after it arms, and
   `prompt-submit`/`session-start` remind. Output shapes and exit codes do not change. The
   watch lease's token carries a capability marker.
7. **Copilot wake:** a standing per-session watcher (`watch-cli --session <id> <db>`), launched
   by the top-level agent from a contract `pending()` returns. The MCP server never spawns it.
   It ships last, after two spikes.
8. The UI shows sent, picked up and acknowledged, with the outcome, and says honestly whether
   the session wakes for it or sees it when it next checks Agent Inbox.
9. An unsent message is a durable draft (#279). Nothing reaches `public/attention.js`, a badge,
   a count, the Inbox queue or the dock.
10. Three PRs: the agent side with the Claude wake; the UI; the Copilot watcher.

---

## §1 — Addressing

**Target: the MCP server's `session`** (`sessionId` in `src/mcp.ts`, the `session` key of
`/api/activity`), a random UUID made once per server process.

- **One per CLI process.** Subagents share their parent CLI's server, so a message reaches the
  CLI session, never one subagent. §3 and §6 say who acts on it.
- **Survives Claude `/clear`.** The server keeps its id across `/clear` (#253), so a queued
  message is still delivered after one. A message must make sense on its own (§6).
- **Re-registering keeps the address.** `pending()` returns the session's messages whatever its
  current project and whatever `project` the call passes. The row stores the session's
  `project`, `stream` and `agent` at send time for display only; delivery never reads them.
- **Restart means a new id.** `claude --resume`, `copilot --resume` or a crash starts a server
  with a new UUID. An open message to the old id can no longer be delivered, and it is not
  re-addressed: guessing a successor by project, branch and agent could hand an instruction to
  the wrong session. The UI says "This session is no longer running" (§5).
- **Who can be addressed.** Any session `/api/activity` lists: working, idle or dormant; not
  ended and not silent for 15 minutes. Idle and dormant sessions are the main use.
- **Capability gate.** This build's presence writes (registration and `status`) set a new
  nullable column, `activity.receives_messages = 1`. Older servers never name it; a write that
  omits it keeps it, like `server_version`. A send to a session without it is refused with
  `session_cannot_receive`. A flag rather than a semver comparison, because a checkout reports
  `2.1.0` until the release bump and must still receive in development. `listActivity` serves
  it as a boolean. `activity` has no snapshot domain, so the column costs nothing there.

## §2 — Storage

**A new table, not a new item kind.** As an item kind, messages would enter `listItemsPage`,
`/api/items`, the dock's attention projection, History paging (#184), the issue and links
domains and search, each needing an exclusion, and `attention.js` would have to know a kind it
must ignore. A separate table touches none of them, needs one domain and one snapshot, and is
invisible to older processes.

```sql
CREATE TABLE IF NOT EXISTS session_messages (
  id TEXT PRIMARY KEY,                 -- client-generated UUID: an exact replay never duplicates
  session TEXT NOT NULL,               -- the address (§1)
  project TEXT NOT NULL,               -- session's project at send (display only)
  stream TEXT NOT NULL DEFAULT '',
  agent TEXT NOT NULL DEFAULT 'unknown',
  text TEXT NOT NULL,                  -- the human's words, 1–4000 UTF-16 units, never trimmed
  created_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1, -- moves on ack and withdraw only
  status TEXT NOT NULL DEFAULT 'open', -- open | acknowledged | withdrawn
  delivered_at TEXT,                   -- first delivery to the addressed session; never moves
  delivered_by TEXT,                   -- that reader's client name
  outcome TEXT NOT NULL DEFAULT '',    -- the agent's one-line result
  closed_at TEXT                       -- when it was acknowledged or withdrawn
);
CREATE INDEX IF NOT EXISTS idx_session_messages_session ON session_messages(session, status, created_at);
CREATE INDEX IF NOT EXISTS idx_session_messages_closed ON session_messages(status, closed_at);
```

**Migration.** The table and indexes go in `runMigrations`, with `ensureColumn` for
`activity.receives_messages`; `migrateSnapshotDomains` stays last. Nothing older is altered.

**Domain and snapshot.** `session_messages: { table: 'session_messages', restamped:
['delivered_at', 'delivered_by'] }`. The existing generator makes its triggers last, from the
live columns, with double-quoted identifiers; the restamped columns get value-checked triggers,
so a re-delivery on every poll moves nothing. `SNAPSHOT_SOURCES.messages = ['session_messages']`,
served at `GET /api/messages` through `conditionalSnapshot`: `{ open: Message[], closed:
Message[] }`, every open message oldest first and the 100 newest closed ones by `closed_at`,
then `id`, built from the database alone. `test/fixtures/snapshot-triggers.txt` gains the new
names (additions only). The table is read by a snapshot, so no `UNREAD` entry; it has no column
domain, so no `REVIEWED_COLUMNS` entry. `test/snapshot-probe.ts` adds the route; the generic
test's fixture adds an open, a delivered and a closed message.

**Writes: one statement or one `.immediate()` transaction each, never a select then update.**

| Function | Who | Condition | Moves |
|---|---|---|---|
| `sendSessionMessage({id, session, text})` | viewer | `.immediate()`. First looks up `id`: same session and text is a replay and returns `ok` before any other check, so retrying the 20th message, or after the session ended, still succeeds; a different session or text is `id_conflict`. Otherwise: the presence row must be listed, not ended and carry `receives_messages`; the session's open messages must stay within 20 and 8000 UTF-16 units in total with this one; then `INSERT`. Prunes closed messages, and open ones, older than 30 days. | new row |
| `markMessageDelivered(id, session, reader)` | MCP `pending` | `SET delivered_at = COALESCE(delivered_at, now), delivered_by = COALESCE(delivered_by, ?) WHERE id = ? AND session = ? AND status = 'open'`; true only while still open | nothing (restamped) |
| `ackMessage(id, session, outcome)` | MCP `ack_message` | `SET status = 'acknowledged', outcome = ?, closed_at = now, revision = revision + 1 WHERE id = ? AND session = ? AND status = 'open'` | revision |
| `withdrawSessionMessage(id, revision)` | viewer | `SET status = 'withdrawn', closed_at = now, revision = revision + 1 WHERE id = ? AND status = 'open' AND revision = ?` | revision |

The text never changes once sent; to correct one, withdraw it and send another. So delivery
needs no text pin: the status condition is the pin, and `session = ?` is the isolation
guarantee. Refusals carry a reason: `not_found`, `not_open` (with status and outcome),
`revision_changed`, `session_gone`, `session_cannot_receive`, `too_many_open`, `too_much_open`,
`id_conflict`.

**Mixed versions.** Older processes never name the table, so none of their statements can
change a message or move its domain. Their presence rows never carry `receives_messages`, so a
send to an older server is refused. An older viewer shows no messages. Activity housekeeping
(`DELETE FROM activity …` after a day, in any build) removes presence rows, never messages.
`test/mixed-version.test.ts` adds: frozen v2.1.0 presence, item and plan statements move no
`session_messages` version and change no message; a session whose presence a frozen v2.1.0
statement wrote is refused with `session_cannot_receive`.

## §3 — Delivery and acknowledgement

**`pending()` gains `messages`**, always present (`[]` when none): the open messages where
`session = this server's sessionId`, oldest first, each `{ id, text, sent_at, delivered_at,
project }`. Each passes `markMessageDelivered` first and is dropped if it returns false, the
same filter shape as rows.

- **Re-delivered until acknowledged,** like blocked rows (#37): context is lost to `/clear`,
  compaction or a subagent's poll, and an instruction delivered once can vanish silently. The
  bounds are 20 messages and 8000 units of open text per session, plus the contract: ack as soon
  as you have acted, including when you take it on as tracked work.
- **Never trimmed.** `text` is the human's words; #42's context rules and `full` do not apply.
- **`pending({item_id})` returns `messages: []`**, as it returns no board rows.
- **Isolation.** No MCP tool takes a session argument, so a server reads and acks only messages
  to its own `sessionId`, which is never accepted from the caller.
- **Subagents.** A subagent's `pending()` is served by the same process and so receives, and
  stamps, the session's messages. `delivered_at` is therefore never treated as "the top-level
  agent has it": the Claude hooks count open messages (§4), and the contract (§6) tells a
  subagent to return messages to its parent verbatim and never act on or ack them. MCP exposes
  no subagent identity, so this is a contract, not an enforcement; the per-process ledger has
  the same limit.

**`ack_message({ id, outcome })`.** `outcome` is required, 1–240 characters: what the agent did,
declined and why, or took on and where it is tracked. Returns `{ ok: true }` or `{ ok: false,
reason, status?, outcome? }`; `not_open` with `status: 'withdrawn'` means the human took it
back. A new tool rather than `resolve` or `answer`, which are version-pinned item paths with
their own contracts; and not "acknowledge", which the snippet already uses for "resolve or a
status change". Cost: about 120 tokens of tool definition per session.

## §4 — Wake

### Claude Code: the hooks (PR 1)

New store read `listOpenMessages(sessions)`: `id`, `session` of open messages for those sessions.
All four subcommands use `sessionScope`'s linked servers; an unlinked hook cannot know its
servers and ignores messages (the session sees them when it next checks Agent Inbox).

- **`stop`** blocks for open messages whose ids it has not nudged for yet, then records those
  ids. So it blocks at most once per message, and an ignored message, or one the agent cannot
  ack (two Agent Inbox registrations, a denied tool), cannot loop. It never blocks on
  `stop_hook_active`. The nudged ids live in their own file beside the session markers,
  `host-<pid>.nudged.json`, keyed by the Claude Code process the link proved (the same key as the
  watch lease), written only by `stop` (temp file and rename) and pruned to ids still open. Not in
  `SessionMarker`: `readMarker` rebuilds a fixed shape, `cmdNotification` and
  `cmdNotificationCommit` write fresh objects (the commit writes back after its 90 s grace, over
  `stop`'s write), and the marker is keyed by the harness `session_id`, which `/clear` changes
  while the server id does not. A reused host pid inherits only ids of messages to servers it
  does not link, which it never counts.
- **`prompt-submit` and `session-start`** remind about every open message on each event, inside
  their existing shapes. Reminding a human-driven turn cannot loop.
- **`watch`** reads the open message ids at arming into a baseline, as `answered` is today
  (hook.ts:719–724, 745), and wakes (exit 2, payload on stderr) only for open messages whose ids
  are not in it. `stop`, running on the same event, covers the ones already open. It re-reads
  `listHostSessions` on every poll, so a server that restarts under the same Claude Code process
  stays covered. A superseded watcher does not wake for messages; the newer one covers the
  session.
- **Lease capability marker.** The watch lease keeps its key, `host:<pid>`, so supersession is
  unchanged, and its token becomes `m1:<pid>-<uuid>`. Older hooks (since #253) also claim
  `host:<pid>` but do not wake for messages; `wakes` (§4.3) requires the `m1:` prefix.
- **Nudge text** gains one clause: "the human sent this session N message(s): call `pending()`
  now, act on each, then `ack_message` it with an outcome".
- **Known gap.** A message that arrives during a `stop_hook_active` continuation is baselined by
  that Stop's `watch` and cannot block that `stop`; the next prompt or the next ordinary Stop
  carries it. A session idle longer than the watch window (`AGENT_INBOX_WATCH_SECS`, 29 min)
  also sees it only then (§11, question 1).
- `rewakeSummary` stays "your answer arrived": it is part of `hooksSettingsBlock`, the installed
  shape Setup and `install-hooks.sh` share, and changing a label should not make every install
  need re-applying. The hooks only read; they never stamp delivery or print message text.

### Copilot: a standing session watcher (PR 3)

| | (a) standing watcher (recommended) | (b) next check only |
|---|---|---|
| Idle session | wakes within ~5 s | sees it when the human next types in that terminal |
| Cost | one detached Node process per Copilot session (~40 MB), one indexed read every 5 s, a 60 s lease refresh, one re-arm turn a day | none |

(b) makes messaging an idle Copilot session pointless, which is the main case. (a) reuses the
host-owned contract question watchers already prove.

- **Contract.** `pending()` adds `session_watch` (the `copilotWatchLaunch` shape; `shell_id:
  agent-inbox-session-<id>`, `timeout_seconds: 86400`, argv `[node, …execArgv, watch-cli,
  --session, <id>, <db>]`) only when `inferAgent` is `copilot` and no lease row covers the
  session or its row is stale (a first arm, or a crash). An in-process memo stops a second offer
  within 2 minutes of one, until a lease has been claimed after it. The contract and appendix
  say only the top-level session launches it.
- **Lease.** In `hook_watch_claims` (already `UNREAD`), key `copilot-session:<id>`, which no hook
  key (`host:`, `session:`, `project:`) can collide with. `claimSessionWatch` is ONE conditioned
  upsert: insert, or take over a row whose `claimed_at` is over 3 minutes old or whose token
  starts `released:`. It never steals a fresh lease (not `claimHookWatch`'s newest-wins). A
  watcher that does not get it exits 3. Refresh is `UPDATE … SET claimed_at = now WHERE
  claim_key = ? AND token = ?` every 60 s; 0 rows means it was taken over, and it exits 3
  silently. **Every exit path releases in a `finally`**, token-conditioned: `UPDATE … SET token =
  'released:' || token WHERE claim_key = ? AND token = ?`. So a re-run after any exit (0, 3 or
  124) takes the lease at once instead of finding a fresh lease it does not own and exiting 3,
  and a watcher that lost its lease while asleep cannot release its successor's.
- **Exits.** It polls every 5 s.
  - **0**, an open message that was undelivered at launch or arrived after it (open messages
    already delivered at launch are its baseline, so one being worked on cannot loop it).
    Stdout: "Agent Inbox message waiting: call pending(), then re-run this same command." The
    argv is stable, so re-arming needs no new contract. The release keeps `claimed_at`, so
    `pending()` does not re-offer while the agent re-arms. If the agent never re-arms, the row
    goes stale after 3 minutes and `pending()` offers again.
  - **3**, do not re-arm: the session's presence row is ended, gone or silent for over 15
    minutes, or its `server_pid` is not running (`process.kill(pid, 0)`, as `hook.ts`
    `running()`), or another watcher holds the lease. One stdout line, no message text.
  - **124** after 24 hours, on stderr as `watch-cli.ts:44` does: re-run this same command.
- **Spikes before PR 3.** (1) Does a detached task launched by a Copilot subagent notify the
  parent session, or only the subagent? (2) Does a 24-hour detached task survive `/clear` and
  compaction and still notify? If either fails, PR 3 narrows to what holds, and the copy says so.

### The wake indicator (PR 2, Claude only until PR 3)

`listActivity` adds `wakes: boolean`, read from the lease table in its existing query: true for a
row whose `host:<host_pid>` lease has an `m1:` token claimed within 30 minutes. PR 3 adds a fresh,
non-released `copilot-session:<session>` lease. `/api/activity` stays a bare array, never
retained; `activityFrameKey` compares bytes, so a flip repaints. Presence, not attention.

## §5 — UI (PR 2)

**One composer, two hosts, one draft per session.** `public/messages.js` is pure (status text,
per-session view, the undelivered list); `app.js` mounts `composerEl(session)`:

- **Live drawer.** Each working entry and idle row gets a **Message** button that opens the
  composer under it, its open state keyed by session like `openLive`.
- **Dashboard session focus panel** (#307) gets a **Message** part: composer and this session's
  history. A lane's title opens the panel, so this is the lane's entry point.
- **Agents view** (only when `mesh-view.js` loaded): each `.mesh-session` line gets a **Message**
  button calling an injected `openMessage(session)` (the `jumpToAsk` seam). It opens the Live
  drawer with that session's composer open and focused; the Agents view still fetches nothing.

**Composer.** A labelled textarea ("Message to copilot · agent-inbox · feat-x"), a counter, and
**Send**/**Cancel**. One line says what happens next: "It wakes for this now" (`wakes`), "It sees
this when it next checks Agent Inbox", or "Restart this session to load v2.2.0 or later" (no
`receives_messages`, Send disabled). It also says that any agent of the session may pick it up
first. The id is generated when a send is first claimed and reused by retries, so a replay is
exact. A refusal keeps the text, with its reason in the composer's `role="status"` slot.

**History and status.** Below the composer, this session's messages from `/api/messages`, newest
first, 5 shown with "+N earlier": the human's text through `esc()` and one status line: "Sent 2m
ago · not picked up yet", "Picked up 1m ago · working on it", "Acknowledged 30s ago: <outcome>"
(agent text through `renderStructuredText`), "Withdrawn", or "Withdrawn after pickup: it may have
started". Open messages offer **Withdraw**, pinned to `revision`, ending in `reloadAndPaint()`.

**Undelivered messages.** Not in the Inbox: a third entry kind would touch `needsYouEntries`,
sorting, filters, pagination, keyboard order and the empty state, and would be attention without
a badge. Instead the Live drawer ends with one fold, "Not delivered (N)": every open message whose
session is no longer listed, until the human withdraws it, newest first, 10 shown with "+M more".
Each has Copy text and Withdraw and reads "Not delivered: this session is no longer running" or
"Picked up, but the session ended before acknowledging". There is no time window, so nothing
disappears on its own and the clock never changes the fold (no idle-frame repaint, #298). The
Live strip names nothing.

**Reads and paint.** `/api/messages` is one more concurrent poll read through `readSnapshot`,
with the links-style fallback (404, network error or refused body = no messages, never a failed
tick); its representation joins `frameInputs()`. The ambient painter paints the drawer and focus
panel; a poll leaves a host untouched while its composer has focus or holds a draft (the rail's
rule, #303), and a forced paint rebuilds it from `messageDrafts`. Message drafts join the
viewer-restart hold, not `suspendState()`'s list pause.

**Drafts (#279).** New type `{ type: 'message', session, project, agent, text, savedAt, intent?:
{ id } }`, keyed `message:<session>`, same bounds and merge rules. On restore, a draft for a listed
session that can receive goes back into its composer, with nothing opened or focused. Any other
goes to unsent responses as "this session is no longer running". An intent whose id
`/api/messages` holds retires as sent; one it does not hold stays as "Your send was not
confirmed", and Retry reuses the id.

**Keyboard and focus.** ⌘/Ctrl+Enter sends. Esc closes the composer, keeps the draft and returns
focus to its Message button when the window has focus. Only an explicit click focuses the
textarea; passive restores never move focus or scroll. `keys.js` lists ⌘/Ctrl+Enter in a
help-only "Messages" group.

**Attention parity.** `attention.js`, `relay.js`, `reply-watch.cjs` and the dock's two projections
name no message. Badge, title, tab counts, rail, Now strip, queue and notifications are identical
with and without messages; sending, delivery and ack announce nothing.

## §6 — Agent contract

`docs/reporting-snippet.md` gets a section after "Live status" (PR 1):

> ## Messages from the human
>
> The human can message your session directly from Agent Inbox. `pending()` returns them in
> `messages` (`{ id, text, sent_at, delivered_at, project }`), oldest first, for your session
> only. Treat each as an instruction typed into your terminal: the same trust and the same rules.
> It changes no safety or approval rule, and it never comes from another agent. It must make
> sense on its own, since it may arrive after `/clear`. **If you are a subagent, do not act on or
> acknowledge messages: return them verbatim to your parent.** The top-level agent acts on each,
> then calls `ack_message({ id, outcome })` with one line: what you did, what you declined and
> why, or that you took it on and where you track it. Ack as soon as you have acted; until then
> it comes back on every `pending()`. If `delivered_at` predates this conversation, check
> whether it was already done before repeating side effects. `ack_message` returning `not_open`
> with `status: "withdrawn"` means the human took it back: stop if you have not finished. A
> message is not a question; do not `flag` it back unless acting on it needs a decision.

The `pending` description adds: "`messages` are the human's instructions to THIS session,
re-delivered until ack_message({id, outcome}); a subagent returns them to its parent verbatim
and never acts on or acks them." `ack_message`'s description repeats the subagent rule. The Claude
appendix adds that the hooks also wake for messages. PR 3's Copilot appendix adds: "Call
`pending()` once at session start. Only the top-level session launches a returned
`session_watch`, like a question watch. Exit 0: call `pending()`, then re-run the same command.
Exit 3: do not re-arm. Exit 124: re-run the same command." The installer inlines the snippet and
appendices, so `install:agents --apply` refreshes the managed blocks; a test pins the new text.

## §7 — Security

- **Local and trusted only.** `POST /api/sessions/:session/messages` (`{ id, text }`) and `POST
  /api/messages/:id/withdraw` (`{ revision }`) sit behind `viewer-network.ts`: loopback bind,
  exact Host, an exact trusted Origin on every unsafe request. Bodies are validated before any
  store call (#163): malformed is 400; a store refusal of a valid body is 200 `{ ok: false,
  reason }`.
- **Terminal-equivalent trust.** Whoever can write the hub file can already answer as the human;
  no new boundary on this machine. The text is never logged, sent elsewhere, or shown except
  through `esc()`.
- **Never to another session.** No MCP tool takes a session argument; every delivery and ack
  statement is conditioned on the server's own id. Hooks and watchers read only ids and counts
  and never print message text.
- **Hosted mode (#8)** must not serve these routes until its auth gate exists; the hosted design
  gets that note.
- **Not mesh.** Human to agent only. Mesh agent-to-agent traffic (§10 of the mesh design) must
  never reuse this table or `ack_message`.

## §8 — Tests

- **Store:** send refused for an ended, missing, silent or flagless session; replay of the same
  id and text is ok even past the caps or after the session ended, other replays `id_conflict`;
  both caps; delivery only for the addressed session and only while open, first stamp kept; ack
  only by the addressed session while open; withdraw pinned to revision; pruning.
- **Snapshots and routes:** the domain, triggers and fixture; re-delivery moves nothing;
  `/api/messages` bytes and 304s; other snapshots unmoved; 400 versus 200 `ok:false`; the Origin
  gate.
- **MCP integration (acceptance):** two real stdio servers in one project. A message to A reaches
  only A's `pending()`, returns every poll until `ack_message`, B cannot ack it, the outcome is
  recorded, a withdrawn one is refused.
- **Hook (acceptance):** a linked `watch` exits 2 on a new message to its own server, not on one
  to a sibling, not on one open at arming, and after its server restarts under the same parent; a
  message delivered by another reader still counts; `stop` blocks once per id and never on
  `stop_hook_active`, and a notification hook between two Stops does not make it block again;
  reminder shapes; the `m1:` token and `host:` supersession; unlinked hooks ignore messages;
  stdout bytes unchanged.
- **Mixed version:** the cases in §2, plus an older hook's `host:` lease not counting as `wakes`.
- **DOM (PR 2):** compose from the drawer, focus panel and Agents view; status across polls;
  Withdraw and withdrawn-after-pickup copy; the capability gate; the "Not delivered" fold; drafts
  across polls, reload and an unconfirmed send; the 404 fallback; attention parity on every surface.
- **Watcher (PR 3):** exits 0, 3 and 124 with their streams; no steal of a fresh lease; takeover
  of a stale or released one; a 124 followed by a re-run takes the lease; a watcher that lost its
  lease releases nothing; refresh loss; dead `server_pid`; the offer rules and memo.
- `dead-exports`, `prstate` (no new stdio import) and `instructions-budget` stay green.

## §9 — Phasing

- **PR 1, the agent side (`Part of #411`):** table, domain, snapshot, both routes,
  `receives_messages`, `pending.messages`, `ack_message`, the Claude hook wake with the lease
  marker and baseline, the snippet, the Claude appendix, and `delivery-and-responses.md`,
  `store-and-snapshots.md`, `hooks-and-watcher.md`, `docs/hooks.md`. Safe alone: no page sends,
  and the routes need a trusted Origin. Useful alone: sessions on this build receive (checkable
  with one documented trusted-Origin `curl`), and Copilot sessions get messages at their next
  `pending()`.
- **PR 2, the UI (`Part of #411`):** `public/messages.js`, the composer in the drawer, focus panel
  and Agents view, history and status, the "Not delivered" fold, drafts, `wakes` (Claude's `m1:`
  lease only), `viewer-frontend.md` and `activity-and-live.md`.
- **PR 3, Copilot (`Closes #411`):** after both spikes, the session watcher, its lease and offer,
  the Copilot appendix, and `hooks-and-watcher.md`.

**Non-goals for v2.2.0:** a ⌘K command, editing or re-addressing a message, a notification on
ack, message search, and any Inbox queue entry.

## §10 — Future work

One watcher per Copilot session that also covers that session's own questions and rows, instead
of one per ask plus one per session.

## §11 — Questions for the owner

1. **Claude's 29-minute watch window.** Longer means a longer hook `timeout` and re-running
   `install:hooks --apply` everywhere. **Recommend:** keep it for v2.2.0; the copy is honest.
2. **One Copilot watcher per session for its life** (~40 MB, a read every 5 s, a re-arm turn a
   day). **Recommend:** yes, subject to the PR 3 spikes.
3. **Acknowledged outcomes after the session ends.** v2.2.0 shows them only in a listed session's
   history and keeps them 30 days. **Recommend:** a follow-up issue for Just landed and History.
