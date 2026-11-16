# Design: requests, the work a person hands a session

Status: proposed on 2026-11-15, not built. The direction ("requests, opened by the hook") and four
defaults were picked by the owner: a review goes to Needs you and other finished work to Just
landed, open requests show on each session card first, a request shows its title, state and
latest line, and no prompt text is stored. §9 lists what the build must still settle.

## §0 Summary

A person hands one chat several pieces of work over a day. Each takes several steps, some in
subagents. Nothing records "this was asked" when it is asked, so work drops out of view, and the
person has to ask "what about that other thing?". This design adds a **request**: one record per
thing the person asked a session to do. In a Claude Code chat with the hooks, every prompt opens
one, **unfiled**. The agent files it with one call (new work, part of an open request, or only a
reply), keeps a one-line note on it, and closes it with an outcome. Closing it for review puts it
in Needs you until the person acknowledges it. Closing it done puts its outcome in Just landed
and History. If the agent forgets to file one, the Stop hook bounces it once. Open requests show
on the session's card.

A first, separate PR fixes hand-offs: a `done` flag with a real next step reaches Needs you.

What the code shows, before the design:

- **A milestone never reaches the person.** `groupItems` (`src/group.ts`) files every open
  `kind: 'done'` item under History, and `attentionEntries` (`public/attention.js`) counts only
  open questions and blocked rows.
- **`action_owner` is not a safe hand-off marker.** `flag` accepts it for every kind, and
  `insertItemRow` (`src/store.ts`) stores it for `done` items too (§3.1).
- **The prompt hook records nothing.** `prompt-submit` (`cmdSessionStep`, `src/hook.ts`) stamps a
  turn and may return `additionalContext`; `parseEvent` keeps no `prompt` or `prompt_id`.
- **The Stop hook already bounces once per id** for messages (`readNudged`, `writeNudged`,
  `host-<pid>.nudged.json`), never on `stop_hook_active`. Requests reuse it.
- **A hook knows its own servers** through `host_pid` (`sessionScope`, #253).
- **The server cannot tell a subagent from its parent**: both call under one session id.
- **Just landed proves its rows** against paged history (`buildDashboard`, `public/dashboard.js`),
  from items and rows with an `outcome` (`buildRelay`, `public/relay.js`). So finished requests
  reach it as outcome items (§3.6), not as a third source.

## §1 What is wrong today

- A request exists only if the agent remembers to make a plan row. Plans are voluntary
  (`board_upsert`), and a row has no owner, no steps and no link to what was asked.
- A hand-off filed as a milestone goes to History, so the person never sees it.
- After `status({ done: true })`, while a later turn runs the card reads "Task not reported ·
  last reported: <old task>", and between turns "was: <old task>" (`doingLine`,
  `public/sessions.js`). Both read as if the chat stopped using Agent Inbox.
- A subagent listed in `status.children` is not tied to any work, and nothing remembers it.

## §2 Goals, non-goals, anti-goals

Goals:

1. Every prompt typed into a hooked Claude Code chat becomes a record before the turn ends.
2. The agent's duty per prompt is one call, and forgetting it costs one bounce, not a lost item.
3. Anything that needs the person's acknowledgement reaches Needs you.
4. The session card says what the session is working on, even with no fresh `status` claim.
5. Nothing changes for a chat whose server or hooks predate this design.

Non-goals in this slice: automatic requests in Copilot CLI, whose hooks cannot add context
(its agents may still declare requests); a request opened by an Inbox message, which keeps its
own lifecycle; steps, checklists or subagent links inside a request; moving a request to another
session on purpose; requests in Plans (a request may carry an issue link, but draws no graph).

Anti-goals: storing, logging or hashing the prompt text; a hook that blocks twice for one id; a
request on its own in the attention set; any change for a host without the capability flag.

## §3 The design

### 3.1 The hand-off fix (PR 1)

**Rule.** The server decides when it writes. A `flag` with `kind: 'done'` whose `next_step`,
trimmed, is not empty and does not match `/^(no( further)? action|none|n\/a|nothing)\b/i` is
stored as a **hand-off**: the item gets `handoff = 1` and `action_owner = 'task'`. Anything else
is a milestone, as today. Nothing rewrites existing items. One real hub held 102 milestones over
four months: 66 began "No action", 21 predate the field, and 15 named a real next step, 12 of
them still open and the oldest months old. So the rule makes about one hand-off a week there,
and a rule applied when reading would have put those 12 old ones in Needs you at once.

**Marker.** A new column, `items.handoff INTEGER` (1 or NULL),
added by `ensureColumn`. Not `action_owner`, for the reason in §0. Not a new `kind`: an older
viewer's `groupItems` drops an open item of an unknown kind from every group, so it would vanish.
An older viewer shows a hand-off as a milestone in History, which is today's behaviour.

**Store.** `insertItem` dedupes a hand-off only against an open hand-off with the same project
and title, and a milestone only against an open milestone (`handoff IS NULL`).
`listOpenQuestions` becomes `listOpenAsks` (open questions and open hand-offs) for the dock's
`?scope=attention` projection (`src/viewer.ts`). `pinItem` also accepts an open hand-off
(`snoozeItem` already accepts any open item). A new `acknowledgeHandoff(db, id)`, one
`.immediate()` transaction, refuses anything but an open hand-off (`not_handoff`), resolves it
with outcome "Acknowledged", and from PR 2 also settles its request (§3.6).

**Grouping and attention.**

- `groupItems`: `needsYou` holds open questions and open hand-offs; `done` no longer holds open
  hand-offs.
- `public/attention.js`: a new `isOpenHandoff(item)` (open, `kind === 'done'`, `handoff`) is read
  by `attentionEntries`, `laterEntries` and `staleEntries` beside `isAskingQuestion`, with the
  same later rules, and a hand-off from a session gone for 72 hours moves to the stale fold as a
  question does.
- **A hand-off is never `waiting`.** No agent is blocked on it, so `classifyLiveness` answers
  `parked` for a hand-off whose session is live. It is therefore never escalated by
  `countsByProject`, and `sortNeedsYou` keeps it below the asks an agent is waiting on.
- `ambientChips` (`public/notes.js`) counts milestones without hand-offs.
- The dock and desktop notifications need no change: `startAttentionWatch` (`electron/main.cjs`)
  reads `?scope=attention` and calls `attentionEntries`, and `attentionNotification`
  (`electron/reply-watch.cjs`) handles any item.

**Viewer.** `POST /api/items/:id/acknowledge` calls `acknowledgeHandoff`, with the 400 and 200
rules of the other item routes. A hand-off card (`public/card.js`, `public/action.js`) shows the
title, the TL;DR, the next step and **Acknowledge**, plus Snooze and Pin for later, and no answer
box. The Needs you lane card (`public/needs-you-lane.js`) is labelled "Hand-off" and, like every
lane card, only opens the ask in the Inbox. Once acknowledged, it is a resolved item with an
outcome, so History and Just landed show it with no new code.

**Tool text.** The `kind="done"` sentence in `flag`'s description becomes: `kind="done" = a
finished milestone, used sparingly. If next_step is a real action for the human (review this,
try that), the item is a HAND-OFF: it goes to their Needs you until they acknowledge it, so use
it whenever you hand work back. Use next_step "No action" for a pure announcement; it goes to
History.` A hand-off's result is `{ id, handoff: true }`.

### 3.2 The record

```sql
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,                 -- lowercase UUID
  project TEXT NOT NULL, stream TEXT NOT NULL DEFAULT '', agent TEXT NOT NULL DEFAULT 'unknown',
  session TEXT NOT NULL,               -- the hub session it belongs to now
  chat TEXT,                           -- 'claude:<harness session_id>'; NULL when agent-declared
  turn TEXT,                           -- Claude Code's prompt_id at opening; NULL otherwise
  midturn INTEGER,                     -- 1 when it was sent while that turn already ran (§3.4)
  origin TEXT NOT NULL,                -- 'prompt' | 'agent'
  state TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',      -- agent-written, 1-120
  note TEXT NOT NULL DEFAULT '',       -- latest line, 0-240
  outcome TEXT NOT NULL DEFAULT '',    -- 0-240
  next_step TEXT NOT NULL DEFAULT '',  -- a review's action, 1-180
  parent TEXT,                         -- request id, for 'merged'
  issue_repo TEXT, issue_number INTEGER,
  item TEXT,                           -- the hand-off or outcome item (§3.6)
  revision INTEGER NOT NULL DEFAULT 1,
  opened_at TEXT NOT NULL, filed_at TEXT, updated_at TEXT NOT NULL,
  closed_at TEXT, acked_at TEXT, ack_delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_session ON requests(session, state, opened_at);
CREATE INDEX IF NOT EXISTS idx_requests_chat ON requests(chat, state);
CREATE INDEX IF NOT EXISTS idx_requests_closed ON requests(state, closed_at);
```

States:

| State | Meaning | Shown |
|---|---|---|
| `unfiled` | the hook opened it; the agent has not said what it is | card ("Not filed yet") |
| `open` | filed as new, or declared by the agent | card, panel |
| `review` | closed, and the person should look; its hand-off item is open | Needs you (through the item) |
| `done` | finished | Just landed and History (through its outcome item); panel for 24 hours |
| `dropped` | will not be done | panel for 24 hours |
| `reply` | only a reply to something already in hand | never |
| `merged` | part of `parent` | never on its own |

The issue is stored as two columns, like `board_rows.issue_repo` and `issue_number`. The tool
accepts the forms `normalizeIssue` accepts (`src/mcp.ts`) and echoes `owner/name#N`.

**Short id.** The first 8 characters of the id. A tool id is the full id or a prefix of at least
8 characters that is unique among the session's requests. Otherwise the call answers
`ambiguous_id` or `not_found`. The hooks print the full id when 8 characters are not unique.

**Snapshot domain.** `SNAPSHOT_DOMAINS.requests = { table: 'requests', restamped:
['ack_delivered_at'] }`, a whole-table domain like `session_messages`. `GET /api/requests` is a
`conditionalSnapshot` like `/api/messages`.

**Retention and caps** (`pruneRequests`, run at the start of every open, as messages prune on
send and launches on create):

- `done` and `dropped`: deleted 30 days after `closed_at`.
- `reply` and `merged`: deleted 1 day after `closed_at`.
- `unfiled` and `open`: deleted 30 days after `updated_at`, as open messages are.
- `review`: kept while its item is open, then pruned as `done`.
- At most 50 `unfiled` and `open` requests per session. Past that the hook opens nothing (it
  logs `request: cap`), and the tool's `open` answers `too_many_open`.

### 3.3 Capability gate and rollout

- A server that tracks requests writes `activity.tracks_requests = 1` with its presence, the way
  `receives_messages` is written: in `build` in `buildMcpServer`, kept on omission
  (`COALESCE`), and served by `/api/activity` only as `true`.
- `listHostSessions` also returns `tracks_requests` and `started_at`.
- The hooks act on requests only for a host with at least one live linked server carrying the
  flag. A chat on an older server sees no change at all: no request, no context line, no bounce.
- The hooks also do nothing about requests when `CLAUDE_CODE_ENTRYPOINT` is set to anything but
  `cli`, so SDK and `-p` runs are left alone. IDE entrypoints are left out of this slice too.
- **Decision: the flag is turned on in PR 4, not PR 2.** Until then the server writes no flag, so
  main is safe at every commit: with PRs 2 and 3 merged, no chat is bounced for requests that the
  app cannot show yet. Tests set the column directly.
- **Rollout.** PR 1 stands alone and may be released by itself. A checkout that agents and hooks
  run from is not rebuilt at PR 4 or later until a release that carries PR 4 is installed, since
  from PR 4 a new chat's server sets the flag and an older app cannot show its requests.

### 3.4 Opening: the `prompt-submit` hook

Facts from a spike on Claude Code 2.1.319 (interactive app under a pty):

1. `UserPromptSubmit` stdin has `session_id`, `transcript_path`, `cwd`, `prompt_id`,
   `permission_mode`, `hook_event_name`, `prompt` and `scratchpad_dir`, and no origin field.
2. It also fires for a turn a finished background task starts, with a new `prompt_id` and a
   `prompt` that begins with `<task-notification>`.
3. A message sent while a turn runs fires it once, at once, with the RUNNING turn's `prompt_id`.
   The turn may take the message in. If it runs as its own turn instead, no second
   `UserPromptSubmit` fires, and its `Stop` carries a `prompt_id` no `UserPromptSubmit` carried.
4. `/cost` and `/context` do not fire it. A custom command does, with `prompt: "/name"`.

5. A turn the answer watcher wakes fires it too: a real transcript shows a `UserPromptSubmit`
   hook result directly after the wake's `task-notification` entry. The comment in `cmdWatch`
   that says a wake fires none predates this version.
6. A process Claude Code starts has `CLAUDE_CODE_ENTRYPOINT=cli` in the interactive app (seen in
   a tool's environment; §9 checks a hook's).

Not tested: scheduled turns (`/loop`), background-subagent turns, a channel event's stdin, `!`
bash mode, an empty Enter, `/compact`, and whether `additionalContext` reaches the model for a
mid-turn message.

**Parsing.** `parseEvent` keeps `prompt_id` when it matches `/^[A-Za-z0-9_-]{1,64}$/`. It reads
`prompt` only to set one boolean, `system_turn`: true when the prompt, after leading whitespace,
starts with `<task-notification>` or with `<channel ` (an Agent Inbox channel event, which
announces an Inbox message and is not typed by the person). The text itself never leaves
`parseEvent`. It is not stored,
logged, hashed or copied into `HookEvent`.

**Order in `cmdSessionStep` for `prompt-submit`**, after today's sweep, reserved-project check,
`sessionScope` and turn stamp:

1. Gate (§3.3). The target is the newest live linked server with the flag (`started_at`).
   No target: go on exactly as today.
2. `adoptChatRequests(db, { chat, to: target })` (§3.8).
3. **Mid-turn.** The hook keeps the last `prompt_id` it saw for this host in the state folder
   (`host-<pid>.turn`, one line, written by `prompt-submit` alone, for system turns too). The
   call is mid-turn when its `prompt_id` equals the one on file (fact 3). Otherwise it writes the
   new one.
4. If `system_turn`, open nothing.
5. `openPromptRequest(db, { session: target, chat, turn, midturn })`: one `.immediate()` transaction
   that prunes, checks the cap, copies `project`, `stream` and `agent` from the target's
   presence row, and inserts an `unfiled` request with `origin: 'prompt'`. It returns
   `{ id, short }` or null. A `session_id` that fails `/^[A-Za-z0-9_-]{1,64}$/` opens nothing.
6. The answer is today's nudge text plus one line, in the same `hookSpecificOutput`
   (`additionalContext`, `suppressOutput: true`). With nothing to say, it stays `EMPTY`.

The line, with `<id>` the short id:

```text
agent-inbox: this prompt opened request <id>. Once you know what it asks, file it with the
agent-inbox request tool: {action:"file", id:"<id>", as:"new", title:"…"} for new work,
as:"part_of" with parent:"<open request id>" for more on an open request, or as:"reply" if it
asks for no new work.
```

Any error in steps 1 to 5 is logged as `request: <message>` and the hook goes on. A prompt never
waits on a request.

### 3.5 The bounce: the `stop` hook

In `cmdSessionStep` for `stop`:

1. `stop_hook_active` true: stamp idle and return `EMPTY`, as today. It never blocks twice.
2. Gate (§3.3). No target: today's behaviour.
3. `unfiled = listUnfiledRequests(db, flaggedServers)`: id, short id, `turn` and `opened_at`.
4. **Held:** a request with `midturn` whose `turn` equals this Stop's `prompt_id`. That is a
   message sent during this turn (fact 3), and the model may not have seen it yet. It waits for
   the next Stop, whose `prompt_id` differs. The flag, not the order of the rows, decides this,
   so a message sent during a turn that a background task started is held too.
5. `due` = `unfiled` minus held, minus ids already in the nudged file.
6. With no responses, no fresh messages and nothing `due`, stamp idle and return `EMPTY`.
7. Otherwise write the nudged file with every id it held that is still an open message or an
   unfiled request, plus the ids this block names, and block once with one combined reason.

`nudgeText(responses, messages, requests)` adds one clause:

```text
agent-inbox: 2 request(s) from the human are not filed yet: 1a2b3c4d, 5e6f7a8b. For each, call
the agent-inbox request tool with action "file": as "new" with a short title, as "part_of" with
the id of the open request it adds to, or as "reply" if it asked for no new work. If you have
not seen the message a request was opened for, leave it: it is filed when the message reaches
you. Then carry on.
```

The last sentence covers a version of Claude Code in which some turn starts with no
`UserPromptSubmit`: a message sent during it would not be marked `midturn`, and could be named
here before the model has read it.

With no requests the text is byte-identical to today's. A request the agent ignores is bounced
once and then shows as "Not filed yet" on the card. It is never bounced again.

### 3.6 The `request` tool and `pending()`

One tool, `request`, with `action`:

| Action | Input | From | To |
|---|---|---|---|
| `file` | `id`, `as: "new"\|"part_of"\|"reply"`, `title?`, `parent?`, `issue?`, `note?` | `unfiled` | `open`, `merged` or `reply` |
| `open` | `title`, `issue?`, `note?` | none | `open`, `origin: 'agent'` |
| `update` | `id`, `note?`, `title?`, `issue?` | `open` | `open` |
| `close` | `id`, `outcome`, `state?: "done"\|"dropped"`, `review?`, `next_step?`, `title?` | `open`, or `unfiled` with `title` | `done`, `dropped` or `review` |

Rules:

- Every write is scoped to this server's session. Another session's request reads `not_found`.
- `file` as `new` requires `title`. As `part_of` it requires `parent`, an `open` request of this
  session (`parent_not_open` otherwise); its `note`, if given, becomes the parent's note, and the
  parent's `updated_at` moves. As `reply` it closes at once.
- `file` on a request that is not `unfiled` answers `not_unfiled` with its state: a repeat is harmless.
- `close` on an `unfiled` request files it as new and closes it in one transaction, so work
  asked for and finished in one turn costs one call. It then requires `title`
  (`title_required`). On an `open` request `title` is optional and replaces the title.
- `close` with `review: true` requires `next_step` and refuses `state: "dropped"`. In one
  transaction it sets `review` and inserts the hand-off item: `kind: 'done'`, `handoff = 1`,
  `action_owner: 'task'`, title the request's title, detail the outcome, the next step, and the
  scope fields `flag` sets (`session`, `repo`, `issue_ref`, `head_repo`, `repo_root`). The item
  has no `outcome` while it is open, so it is not also listed in Just landed. `requests.item`
  names it.
- `close` as `done` inserts a resolved outcome item in the same transaction (`kind: 'done'`,
  `next_step: 'No action'`, `outcome` and `resolved_at` set, no dedupe). Just landed, History,
  the ribbon and "Since you last looked" then show it with no new code. `dropped` writes no item.
- `acknowledgeHandoff` (§3.1) sets a linked `review` request to `done` with `acked_at`, and
  sets the item's outcome to the request's outcome. `resolveItem` and `dismissItem` settle a
  linked `review` request to `done` without `acked_at`. `listRequests` reads a `review` request
  whose item is closed as `done`, which covers an older server resolving the item.
- No call takes a session or project argument.

The description, in full:

```text
Track what the human asked THIS session to do, so nothing they hand you is lost. One request is
one piece of work they asked for. With the Claude Code hooks, every prompt they submit opens an
UNFILED request, and the hook names its id. File each one as soon as you know what it is:
action "file" with as:"new" and a short title for new work, as:"part_of" with parent (an open
request's id) when it adds to work in hand, or as:"reply" when it asks for no new work (an
answer, a yes, a question about what you just did); a reply is never shown. Use action "open"
with a title for work they asked for where no hook opened a request, such as an Inbox message
you take on. Keep their view current with action "update" and a one-line note at real progress,
not at every step. When the work ends, action "close" with a one-line outcome: state "done"
(the default) or "dropped" (say why). Work finished in the same turn it was asked needs only
this one call: close the unfiled request with a title and an outcome. Set review:true with
next_step when they should look at or try the result: it goes to their Needs you until they
acknowledge it, and that IS the hand-off, so do not also flag a milestone for it. A done outcome
shows in their Just landed and History. An id is the full id or its first 8 characters. status says what
phase you are in now; request says what was asked and where it stands. A subagent never files,
updates or closes a request: it reports to its parent, which does. pending() returns this
session's unfiled and open requests in requests, and the reviews they acknowledged since your
last poll in requests_acknowledged, once. Returns {ok:true, request:{id, short, state, title,
note}} or {ok:false, reason}: not_found, ambiguous_id, not_unfiled (filed already; its state is
returned), not_open, parent_not_open, title_required, next_step_required, too_many_open.
```

The `status` description's opening changes from "NOT for tasks (use boards)" to "NOT for what
was asked (use request) or for plans (use boards)".

**`pending()`** gains two keys. A targeted `pending({ item_id })` carries neither, as it carries
no rows or messages.

- `requests`: this session's `unfiled` and `open` requests, oldest first, at most 20, with
  `requests_more: N` past that. Each is `{ id, short, state, title, note, issue?, origin,
  opened_at, updated_at }`. They come back on every poll until filed or closed.
- `requests_acknowledged`: `review` requests acknowledged since the last delivery, as
  `{ id, short, title, acked_at }`. Each is stamped `ack_delivered_at` (`COALESCE`) and handed
  over once. A subagent's poll can take one first. That is acceptable because it is
  informational, and `requests` stays at-least-once.

### 3.7 The viewer

- **Read.** `listRequests(db)` answers `{ open, closed }`: `unfiled`, `open` and `review` ones,
  oldest first, and `done` or `dropped` ones closed in the last 24 hours, newest first, at most
  100. `reply` and `merged` are never served, nor is `chat`. `public/snapshots.js` gains a
  `requests` validator. The poll in `public/app.js` reads `readSnapshot('/api/requests')` on
  every tick, with the `messagesBody` fallback, so an older viewer's 404 means no requests drawn.
- **Model.** A new pure `public/requests.js`: `requestsBySession`, `requestsLine`, `newestOpen`
  and `orphanRequests`. `public/sessions.js` puts each card's requests on `card.requests`.
- **Card.** Working cards get a Requests block (`.sc-requests`): a "Requests · 3" label, then
  up to three requests, one short line each, newest `updated_at` first: the title, then its state
  and age in the muted meta style ("Fix the login redirect · 12m", "Not filed yet · 2m",
  "Release notes · waiting on you"), and "+2 more" when there are more. A title is cut to one
  line with an ellipsis. `unfiled` reads "Not filed yet" and `review` reads "waiting on you".
  Quiet rows show only "Requests · N" in the caption cell. Agent text is set with `textContent`.
- **Caption.** When `doingLine` would answer "Task not reported…" (a turn runs with no live
  claim) and the card has an `open` request, it answers that request's title instead (the newest
  `updated_at`). Between turns the caption is unchanged; the Requests block says what is open.
- **Session panel.** A Requests section (`.dash-focus-requests`) in the panel built in
  `public/app.js`: each request with its state, note, issue chip and age. Done and dropped ones
  from the last 24 hours follow, with their outcomes. The section is read-only.
- **Needs you and Just landed** need nothing new: a review is a hand-off item (§3.1), and a done
  request is an outcome item (§3.6).
- **No chat left.** `unfiled` or `open` requests whose `session` is not in `/api/activity` are
  shown in a fold at the end of the Quiet lane (`public/agents-home.js`, beside `ah-undelivered`):
  "Open requests with no chat (N)". Each has **Close**, which posts
  `POST /api/requests/:id/close { revision }`. `dropOrphanRequest` sets `dropped` with outcome
  "Closed from Agent Inbox". It refuses `session_live`, `revision_changed` or `not_open`. The
  rule reads the session only: presence carries no harness chat id, and §3.8 moves a resumed
  chat's requests to its new session. Between a resume and the first adopting hook, a request
  can sit in the fold briefly.
- Requests are never attention items, badges or counts of their own. CSS uses the `:root`
  tokens, and `DESIGN.md` gains the Requests line and the fold.

### 3.8 Identity: chats, sessions and moves

- `chat` is `claude:` plus the hook's `session_id`. `session` is the hub session (the server's
  id), which the card and `pending()` key on.
- `/clear` gives the chat a new harness id under the same server. Its requests keep the old
  `chat`, stay on the same session and card, and still come back in `pending()`.
- `adoptChatRequests(db, { chat, to })` runs at `session-start` and at every `prompt-submit`. In
  one `.immediate()` transaction it moves the `unfiled` and `open` requests of `chat` whose
  session is not `to` and is not live (ended, older than the presence window, or with a dead
  server pid) to `to`. A live session's requests are never taken. This is the only re-address
  path. #411's rule for messages is unchanged.
- At `session-start` the new server may not have registered yet, in which case nothing is
  moved. The first prompt's hook adopts them instead.
- Whether `claude --resume` keeps the harness `session_id` was not checked (§9). If it does not,
  a resumed chat's old requests stay in the no-chat fold until someone closes them.

### 3.9 Safety and older builds

| Case | Result |
|---|---|
| Older server, new hooks | no flag: the hooks do nothing about requests |
| New server, older hooks | no automatic requests; `request open` still works; nothing bounces |
| Older viewer, new hub | `requests` is ignored; a hand-off shows as a milestone in History |
| New viewer, older server | no hand-offs; no requests; `/api/activity` carries no flag |
| Older server resolves a hand-off item | `listRequests` reads the request as `done` |
| An Inbox message | opens no request; its lifecycle is unchanged |
| A subagent calls `request` | allowed by the server (one session); forbidden by the tool text |

The prompt text is read only inside `parseEvent`; a test feeds a marker string as the prompt and
searches the hub file, `hook.log` and the state folder for it. The bounce keeps #411's rules (once
per id, never on `stop_hook_active`, ids only, written by `stop` alone). Reserved projects (#412)
are refused by `openPromptRequest` and, for the tool, by `agentScope`.

## §4 What this replaces

| Earlier rule | Now |
|---|---|
| Every open `done` item is a milestone in History | One with `handoff` is in Needs you until acknowledged |
| Attention is open questions and blocked rows | Plus open hand-offs, with the same later and stale rules |
| Nothing records what was asked | `request` does; `status` keeps the current phase |
| The Stop hook bounces for responses and messages | Also for unfiled requests, once each |
| "Task not reported" when no claim is live | The newest open request's title, when there is one |

## §5 Build order

Each PR lands alone, with its tests and docs: `docs/architecture/delivery-and-responses.md`,
`attention-and-later.md`, `hooks-and-watcher.md`, `docs/hooks.md`, `viewer-dashboard-and-shell.md`,
`docs/reporting-snippet.md` and one `CHANGELOG.md` bullet each. A new `docs/architecture/requests.md`
with its frontmatter, its two links and its row in `CLAUDE.md` comes with PR 2.

| PR | Content | Tests |
|---|---|---|
| 0 | This spec | none |
| 1 | Hand-offs: `items.handoff`; `insertItem`'s dedupe; `listOpenAsks`; `pinItem`; `acknowledgeHandoff`; `flag`'s rule and text (`src/mcp.ts`); `groupItems`; `isOpenHandoff` in `attentionEntries`, `laterEntries`, `staleEntries`; `classifyLiveness` answering `parked` for a hand-off; `ambientChips`; `POST /api/items/:id/acknowledge`; the hand-off card in `public/card.js`, `public/action.js`, `public/needs-you-lane.js` | `test/store.test.ts` (marker set only for a real next step; "No action", "no action needed", "None", "N/A", "Nothing", spaces; dedupe per kind; old rows untouched); `test/mcp.integration.test.ts` (result `handoff: true`); `test/group.test.ts`; `test/attention.test.ts` (in attention, later, stale; never waiting or escalated; a milestone with `action_owner: 'task'` and no marker stays out); `test/reply-watch.test.ts` (announced once); `test/notes.test.ts`; `test/dom/needs-you-lane.test.ts`, `test/dom/queue-actions.test.ts` (Acknowledge, no composer); `test/viewer.test.ts` (route refusals) |
| 2 | Requests in the store and the tool: the table, indexes and domain; `activity.tracks_requests` (column and `listHostSessions` only; not written); `openPromptRequest`, `openAgentRequest`, `fileRequest`, `updateRequest`, `closeRequest`, `resolveRequestId`, `listSessionRequests`, `markAcksDelivered`, `listUnfiledRequests`, `adoptChatRequests`, `listRequests`, `dropOrphanRequest`, `pruneRequests`; `resolveItem` and `dismissItem` settling a review; `acknowledgeHandoff` setting `acked_at`; the `request` tool and the `status` text; `pending()`'s two keys | `test/requests.test.ts` (every action's from/to, refusals, prefixes, caps, retention, the transaction that writes the item, cross-session `not_found`, adopt only from a session that is not live); `test/snapshot-domains.test.ts`; `test/mcp.integration.test.ts` (tool and `pending()` shapes; targeted read carries neither key; acknowledged handed over once); `test/mixed-version.test.ts` (an older server's statements leave requests alone) |
| 3 | Hooks: `parseEvent`'s `prompt_id` and `system_turn`; the gate; `prompt-submit` steps 1 to 6 and the `host-<pid>.turn` file; `session-start` adopt; `stop`'s held rule, nudged file and `nudgeText` clause | `test/hook.test.ts` (no flag: byte-identical output and no row; an entrypoint other than `cli`: nothing; a task notification or a channel event: nothing; one request per prompt with the line; a mid-turn request, also one sent during a background-task turn, held and bounced at the next Stop; one bounce per id; `stop_hook_active` never blocks; text unchanged with no requests; the prompt marker string found nowhere on disk) |
| 4 | Viewer, and the flag turned on: `build.tracks_requests` in `buildMcpServer`; `GET /api/requests`, `POST /api/requests/:id/close`; the validator and poll read; `public/requests.js`; card line, caption and Quiet chip; the panel section; the fold; CSS and `DESIGN.md` | `test/viewer.test.ts` (routes, 304s, 24-hour window, no `chat`, no replies); `test/snapshots.test.ts`; `test/sessions.test.ts` (line, caption override, orphan rule); `test/dom/working-quiet-lanes.test.ts`, `test/dom/agents-home.test.ts` (line, chip, fold, Close, focus kept through a poll); `test/dom/conditional-poll.test.ts` (an older viewer's 404 draws nothing and fails no tick) |

PR 1 may be released alone. A checkout that agents and hooks run from is not rebuilt at PR 4 or
later until a release that carries PR 4 is installed (§3.3).

## §6 Tests that hold across PRs

- With no flag on any server, every hook's stdout and every `/api/*` body but `/api/requests`
  are byte-identical to the build before PR 2.
- No prompt text reaches the hub, `hook.log`, the hook state folder or any response.
- No id is bounced twice; `stop_hook_active` never blocks; a request alone never enters
  `attentionEntries`.
- Fixtures are synthetic: no real prompts, titles, chat ids or paths.

## §7 Proof in a real chat

Besides the tests, PR 3 and PR 4 each run a real interactive Claude Code under a pty against a
scratch hub, never the real database (`AGENT_INBOX_DB` set; a scratch settings file names the
branch's hooks and MCP server, as the spike's `ptydrive.py` did), and record in `docs/hooks.md`:

1. A typed prompt opens one `unfiled` request; the agent files it; the card shows it.
2. A mid-turn message the turn takes in is held at that Stop and bounced later only if unfiled.
3. A mid-turn message that runs as its own turn is bounced at that turn's Stop.
4. A background-task turn opens nothing.
5. A Stop with an unfiled request blocks once, and the next Stop does not.
6. `/clear` keeps the requests on the card; after exit and `claude --resume`, did they move (§9)?
7. A chat on a server without the flag: nothing changes.
8. A `claude -p` run with the flag set opens nothing and is never bounced.

## §8 What is not in this design

- **Reading the transcript (later hardening).** At `Stop` the transcript holds the turn's `user`
  entry with `origin.kind` (`human` or `task-notification`), `promptSource` (`typed`, `queued`,
  `system`, `sdk`), `turnOrigin` and a `promptId` equal to Stop's `prompt_id`. Mid-turn messages
  are `attachment` entries of type `queued_command` (`commandMode: "prompt"`,
  `origin.kind: "human"`, `humanTurn: true`). A later PR could confirm each request's origin
  there, void one that a non-human turn opened, and bounce a mid-turn message in the turn that
  took it. Here an unknown kind of system turn costs the agent one `reply` filing.
- The §2 non-goals; a requests lane across all chats (the card comes first, by the owner's
  default); and Acknowledge as a notification button (a click opens the hand-off, as today).

## §9 What the build must settle

1. Does `claude --resume` keep the harness `session_id`? If not, §3.8's adopt never fires on a
   resume, and the no-chat fold is the only way out for those requests (checked in §7 step 6).
2. Does `additionalContext` from a mid-turn `UserPromptSubmit` reach the model? If not, the agent
   learns a mid-turn request's id only from `pending()` or the bounce. Nothing here depends on it.
3. Scheduled turns (`/loop`), background-subagent turns, `!` bash mode, an empty Enter and
   `/compact`: does any of them fire `UserPromptSubmit`, and with what `prompt`? Each one that
   does costs a `reply` filing per turn. A frequent one may need its own skip rule, which would
   need the owner's decision.
4. Is 50 open or unfiled requests per session the right cap, and 20 the right `pending()` page?
   Both are guesses.
5. Does a hook process see `CLAUDE_CODE_ENTRYPOINT`, and what is it for `-p`, SDK and IDE runs?
   If a hook does not see it, the gate needs another signal before PR 3 lands, because a bounce
   adds a forced turn to every scripted run (checked in §7 step 8).
