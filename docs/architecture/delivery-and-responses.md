---
paths:
  - "src/store.ts"
  - "src/mcp.ts"
  - "src/viewer.ts"
  - "docs/reporting-snippet.md"
  - "docs/instructions/**"
  - "public/action.js"
  - "public/card.js"
  - "public/rowview.js"
applyTo: "src/store.ts,src/mcp.ts,src/viewer.ts,docs/reporting-snippet.md,docs/instructions/**,public/action.js,public/card.js,public/rowview.js"
---

# Delivery, responses and boards

How human answers, annotations and handled marks reach agents, and the revision rules that keep them exact.

Moved out of `CLAUDE.md` and `.github/copilot-instructions.md` by #379, nearly verbatim. Claude Code and Copilot CLI load this file automatically when they read or edit a file matching the `paths`/`applyTo` globs above (through the symlinks in `.claude/rules/` and `.github/instructions/`); anyone else should read it before changing those files.

## In brief

- Viewer JSON write routes parse with `.catch(() => null)` and type-check every
  field before any store call. Invalid input is `400 { ok: false, error }`; a
  store refusal of a valid request stays `200 { ok: false }` because `postJSON()`
  treats any non-2xx as "the write never happened". An explicit `''` still clears.
- Inbox answers have precedence over chat-recorded answers. `answerItem()` must
  refuse to overwrite an unread inbox answer; this is intentionally not
  timestamp-based last-write-wins. A human reply that carries `expect_answer`
  (#321) is written only while the question still holds that answer.
- Item response and annotation snapshots use monotonic `response_revision`, not
  timestamps alone. MCP resolution after response history requires the exact
  `expected_response_revision` handled by that caller. Question reply/annotation
  pickup is atomic; another reader's pickup cannot authorize a stale resolution.
- Informational annotations enter MCP `pending` until picked up, without adding
  attention or closing the item. `pending({item_id})` recovers current open-item
  feedback and clear state afterward. Keep hook/backstop reads question-only by
  default, retain first-pickup receipts, and refuse annotation writes to closed items.
- Boards are idempotent by `(project, title)` and rows by stable `label`.
  A full `board_upsert` deletes rows omitted from the payload, but omitting a
  row's `note`, `next_step`, `impact`, `next_after`, `action_owner`, `options`,
  `context`, or `outcome` preserves the stored value; explicit empty values
  (`''`, `options: []`) clear them.
  Never overwrite or reset human-owned annotation, handled, or delivery fields
  during routine upserts.
- `blocked` is the only row status that means the human must act. A failing
  test, missing build, another PR, or other non-human dependency is `partial` or
  `tracked`. A blocked row remains pending until an agent changes its status;
  delivery stamps are not acknowledgements.
- Human blockers are action-first data, not prose conventions. Item `detail` and
  row `note` are one-sentence TL;DRs; `next_step` is one concrete human action.
  `action_owner` identifies decision/task/approval, `impact` says why now, and
  `next_after` says what follows. decision/approval carries 2-4 `options`; task
  omits them so the viewer offers "I've done my part." Long history belongs in
  collapsed `context`.
- Every existing-row agent mutation and every human/browser/native row action is
  pinned to row `revision`; never weaken those writes back to row-id-only updates.
  A move alone bumps only the board revision, never the row `revision` or
  `updated_at`; otherwise native notifications re-announce unchanged asks (#158).
- Item/row `updated_at` is for content changes only. Delivery stamp writes must
  never bump it or the New/changed filter becomes a polling firehose.

- Session messages (#411) are the human's instructions to ONE MCP session, in
  their own table, `session_messages`. `pending()` returns only the caller's
  own session's open messages (no tool takes a session argument), re-delivered
  until `ack_message`; the first-delivery stamp never moves and is not an
  acknowledgement. Only the addressed session can ack; the human withdraws by
  revision. A send needs a listed session whose presence carries
  `receives_messages`, and an exact replay of an id always succeeds.

## Invariants in detail

- **Boards: the human's annotations are sacred.** A board is idempotent by
  `(project, title)` (UNIQUE); rows match by `label`, positions come from array order.
  `upsertBoard` deliberately never touches `board_rows.annotation` — human per-row notes
  must survive a full re-upsert. But rows *absent* from an upsert are deleted (annotations
  with them), so agents must keep labels stable. There is no FK enforcement between
  `boards` and `board_rows` — deletes are handled explicitly in `store.ts`. The same
  protection covers `annotated_at`/`annotation_seen_at`/`annotation_seen_by`: a re-upsert
  that reset delivery would re-attribute the note to whoever polls next and reset the
  "delivered 3h ago" age the human reads as evidence. **Issue #36's `handled_at` (plus its
  `handled_seen_at`/`handled_seen_by`) is sacred on the same terms** — it is the human's
  "I did my part" on a blocked TASK row, and the prescribed agent flow is a full-table
  re-send, so an upsert that dropped it would wipe their action on every routine refresh.
  Exactly ONE thing clears it, in `resetHandledOnReblock`: a status transition INTO
  `blocked` from something else, i.e. a genuinely new ask. Re-sending a row that is already
  blocked is not an acknowledgement and must never reset it.
- **Actionability is stored, never inferred from prose.** Item `detail` and board-row `note`
  are one-sentence TL;DRs; `next_step` is the ONE concrete human action; `action_owner`
  (`decision|task|approval`) says who acts; `impact` says why now; `next_after` says what
  follows. MCP requires the action fields on every question/blocked row. decision/approval
  carries 2-4 `options`; task omits options and gets "I've done my part." Long history belongs
  in collapsed `context`. These are additive agent-owned fields: full-board upserts preserve
  omitted values, explicit empty values clear them, and legacy rows use note/detail fallbacks.
- **Row chaining is versioned and atomic.** `board_advance` uses row `revision` as its CAS
  token; `action_version` is only the human-step number. `advanceBoardRow(...).immediate`
  archives the current action/response/outcome into JSON `history`, clears every
  human/delivery/snooze/outcome field, increments both counters,
  and installs the next blocked action in one write transaction. Ordinary nonblocked→blocked
  transitions use the same archive/reset path. Agent reads get only `history_count`; the
  viewer alone receives full history. *(#217)* The watch stop and the action's asker are
  reset by the `reset_row_action_watch_state` trigger instead, whenever `action_version`
  moves, so an older server sharing the file cannot carry them into its new action.
- **Every row action is version-pinned.** MCP `board_upsert` existing rows carry row
  `revision`; `board_row` carries `expected_revision`; browser/native annotate, snooze and
  handled writes carry row revision plus board revision. A stale notification or sibling
  therefore cannot answer or complete the newer action that reused the stable row id.
  A move alone is not a row change (#158): a reorder bumps the board revision, which still
  refuses a pre-move full-table snapshot, but never the row `revision` or `updated_at`.
  Native notifications key rows by revision (`attentionNotification` in
  `electron/reply-watch.cjs`), so an unchanged ask is not re-announced and its earlier
  buttons still apply through the board-token refresh.
- **Viewer write bodies are validated before the store sees them** *(issue #163)*. Every
  JSON write route in `src/viewer.ts` parses with `.catch(() => null)` and type-checks each
  field it uses: `text` a string; when present, `context` a string, `kind` a response kind
  and `handled` a boolean; `pinned` a boolean, always required (#247); `defer` a boolean when
  present (#247, the stop-waiting routes); `until` a parseable
  date (stored as UTC ISO, because the store compares `snoozed_until` as text) or null;
  revisions integers. Invalid
  input is `400 { ok:false, error }` with no store call: never a 500 from a parse or `trim()`
  throw, and never a coerced default that silently overwrites state with a 200. The split is
  `postJSON()`'s contract (a non-2xx means "the write never happened"), so a store REFUSAL of
  a valid request stays `200 { ok:false }`. An explicit `''` is still a clear.
- **`updated_at` means content changed.** Item/row human or agent content writes bump it;
  delivery stamps (`markReplySeen`, `markAnnotationDelivered`, `markHandledDelivered`) never
  do. The viewer's New/changed filter depends on this distinction just as Live depends on
  `last_call_at` rather than liveness heartbeats.
- **Delivery is not acknowledgement (issue #37).** `board_rows.annotation_seen_at` records
  ONE fact — this text was handed to some agent — and it silences nothing: not the human's
  screen, and (since F1) not the agent's queue either. The row stays `blocked` and stays in
  BOTH places until an agent flips its status, which IS the acknowledgement.
  Three consequences that must not be "simplified" away. (1) `annotation_unseen` derives from
  the PER-ROW stamp only — `boards.last_read_at` still gets written by `markBoardRead` but
  is pure decoration (its only real use is the one-shot migration backfill); a second input
  would disagree invisibly, since nothing renders it. (2) The attention predicate
  (`public/attention.js`) reads what the HUMAN did, never the delivery state:
  `isBlockedRowAttention = status === 'blocked' && !humanActedOnRow(row)`, where
  `humanActedOnRow` is the one place that knows a row can be answered in words
  (`annotation`) OR by going and doing it (`handled_at`, #36). The rows it drops are
  RELABELED into `awaitingAgentRows()` — same module, rendered in the Needs-you foot — not
  deleted. Removing the alarm without relabeling it is the worse bug, not the fix.
  (3) **`listPendingRows` gates on the ACKNOWLEDGEMENT, not on the stamp:** still pending
  while `status = 'blocked'`, or while either half (annotation, `handled_at`) is
  undelivered. Gating on the stamp made rows
  at-most-once while items are at-least-once (`listPending` is gated on `status='open'`), so
  in a fan-out a sibling's routine poll ate the answer, the session that RAISED the row never
  got it, and the human's card then claimed "delivered to claude-code". A blocked row is
  therefore re-delivered on every poll until the status flips — the same window the human is
  still staring at it — and the payload carries the stamp so a re-delivery is self-labelling.
  A non-blocked row has nothing to acknowledge and stays at-most-once; without that half a
  months-old aside would be a permanent firehose.
- **Every mark-seen write pins the version it read.** MCP supplies the item's monotonic
  `response_revision` to `markReplySeen` and the row/board revisions to
  `markAnnotationDelivered` and `markHandledDelivered`, as well as the exact
  timestamp the read returned (`... AND replied_at IS ?` /
  `AND annotated_at IS ?` / `AND handled_at IS ?`, `IS` because legacy rows
  carry NULL). The viewer writes answers from its own OS process, so an unconditional stamp
  marks text the human just replaced as picked up. Never SELECT-then-UPDATE with a gap;
  `annotateBoardRow`, `replyItem` and `markRowHandled` reset the stamp in the SAME statement
  that writes the new value. The delivery functions' boolean means ONLY "the text you read is still
  there, safe to hand over" — never "you were first" (re-delivery is normal now), and its
  `COALESCE` is what keeps the two apart: the stamp records the FIRST delivery and never
  moves, because its AGE is the human's evidence that an agent has sat on the answer.
  `pending()`'s `.filter()` consuming that boolean is what drops replaced text — pinned at
  the MCP level in `test/mcp.integration.test.ts` and `test/response-safety.test.ts`.
  Same-millisecond corrections are distinct revisions; the item trigger also versions
  response writes from an older process. A question's reply and annotation receipts
  are stamped atomically against one response revision: withholding a changed
  snapshot must not leave either half falsely marked picked up.
  `board_get` retries a whole changed snapshot
  and fails explicitly if it cannot obtain one; never omit a stale row from a board
  read, because a subsequent full upsert would delete that row.
- **Agent resolution acknowledges an exact response, not another reader's pickup.**
  After an item has any response history, including a cleared reply or annotation,
  MCP `resolve` requires `expected_response_revision` from the response the caller
  handled. `pending` and successful `answer` return that revision. Missing or stale
  revisions are refused; another sibling reading newer text cannot authorize an older
  response. Items with no response history retain ordinary resolution; explicit
  human and hook closure paths remain separate. `pending({item_id})` recovers the
  current open item's text or clear state and revision after ordinary delivery ends.
  Reply and clear writes require an open question, so stale notifications cannot
  rewrite closed history. Clients using the older answer-then-resolve contract must
  adopt the revision argument rather than silently bypassing this guard.
- **Informational-item annotations are feedback, not another attention alarm.**
  MCP opts into open note/milestone annotations through `listPending`; its default
  remains question-only for hooks and backstops. Informational feedback, including a
  clear, leaves the ordinary poll after pickup without closing the item. Targeted
  `pending({item_id, project?})` recovers only that current open item in the selected
  project, without delivering other items or board rows. `annotated_at`,
  `annotation_seen_at` and `annotation_seen_by` keep edit and first-pickup state
  distinct; legacy text has unknown edit time and no fabricated pickup.
  Version-pinned delivery never bumps content `updated_at`; annotation writes reset
  pickup even from an older writer. Annotations require an open item, and callers
  must check the JSON `ok` rather than infer success from HTTP 200. Neither pickup
  nor the reader's client label proves that the intended session acted; no new
  informational host-wake guarantee or human-attention entry is implied.
  Item reply and annotation timelines are independent: neither may borrow the
  other's timestamps to claim pickup. The Note prompt retires an attempt only on
  JSON `ok:true`; refused or transport-unconfirmed text, including a clear intent,
  stays in the existing recovery surface (kept in this profile's storage since #279
  and restored as unconfirmed, never resent) and protects automatic
  restart. Retry requires explicit review, closed targets cannot retry, and local
  recovery Clear never changes the stored annotation. Do not claim crash-durable
  persistence or that a transport error proves the write never committed.
- **Two answer channels, ONE precedence rule: the inbox always wins.** A question can be
  answered on the card (`replyItem`, source `'inbox'`) or out loud in chat and recorded by
  the agent (`answerItem`, source `'agent'`). It is deliberately NOT wall-clock
  last-write-wins — a skewed clock or a delayed flush would let a stale chat answer clobber
  a fresh inbox one. `answerItem` is ONE conditioned UPDATE that only writes while nothing
  unread is waiting (`reply IS NULL OR reply = '' OR reply_seen_at IS NOT NULL`) and
  otherwise returns `{ok:false, reason:'unread_inbox_answer'}` with the waiting answer;
  `replyItem` overwrites an open question's answer and resets pickup (or, when the page
  sends the answer it expects to replace, only while that answer still stands, #321). Never SELECT-then-UPDATE and
  never two UPDATEs here: the viewer writes from its own OS process and would land between
  them, leaving the human's newest answer flagged "✓ picked up" and un-clearable. An agent
  may overwrite an answer it has already picked up, but may never blank one.
- **Omission is not deletion — for FIELDS (issue #42).** `board_upsert` leaves a row's
  `context` alone when the field is absent and clears it only on an explicit `''`, because
  the prescribed flow is `board_get` → `board_upsert` and MCP reads no longer carry the
  text: omitting what you were never handed would wipe it. This does NOT weaken the rule
  that a ROW absent from an upsert is deleted — that one stands. The same omission rule
  covers every agent-owned row field: an omitted `note`, `next_step`, `impact`,
  `next_after`, `action_owner`, `options`, `context` or `outcome` keeps its stored value
  (`upsertBoard`: `note: r.note ?? prev.note`), and only an explicit `''` (or
  `options: []`) clears it. Do not "fix" `note` to clear on omission: agents re-send
  full tables, and that would wipe every row's TL;DR.

- **Session messages are delivered only to their session, until acknowledged (issue #411).**
  Design: [`docs/superpowers/specs/2026-10-30-session-messages-design.md`](../superpowers/specs/2026-10-30-session-messages-design.md).
  A message addresses one MCP server's `sessionId` (one CLI process, its subagents
  included), follows that session whatever project it registers, and is never
  re-addressed: a restart is a new id, and the old id's open messages stay undelivered.
  It lives in `session_messages`, not `items`, so nothing that reads items (history
  paging, links, issues, search, the dock, `public/attention.js`) sees it. Four writes,
  each one statement or one `.immediate()` transaction. (1) `sendSessionMessage`
  (viewer, `POST /api/sessions/:session/messages` with a page-generated lowercase UUID
  and 1–4000 characters) answers an exact replay of an id (same session and text) with
  `ok` BEFORE any other check, so a retry of an unconfirmed send succeeds even past the
  caps or after the session ended; any other reuse is `id_conflict`. Every other send
  first prunes the hub's closed messages over 30 days past `closed_at` and open ones over
  30 days past `created_at` (only sends prune; nothing runs on a timer), so month-old open
  messages never count toward the caps. Then the session must be listed (not ended, refreshed within 15 minutes) and its presence must
  carry `activity.receives_messages = 1`, which only this build's presence writes set
  (an omitted value keeps it, like `server_version`; older servers never name it, so a
  send to one is `session_cannot_receive`), and the session may hold at most 20 open
  messages and 8000 UTF-16 units of open text. (2) `markMessageDelivered` stamps `delivered_at`/`delivered_by` with
  `COALESCE`, conditioned on `id`, `session` and `status = 'open'`; true means the
  message is still open, so it is safe to hand over. (3) `ackMessage` closes it with a
  1–240 character outcome, conditioned on the same three. (4) `withdrawSessionMessage`
  (viewer, `POST /api/messages/:id/withdraw`) is pinned to `revision`. The text never
  changes, so the status is the only pin delivery needs, and another session's message
  reads as `not_found`. `pending()` stamps each of its own session's open messages, reads
  them back (so `delivered_at` is the first delivery and a message withdrawn in between
  is dropped) and returns `messages: [{ id, text, sent_at, delivered_at, project }]`,
  always present, `[]` for a targeted `pending({item_id})`, and ignoring the `project`
  argument. It is re-delivered on every poll until `ack_message`, like a blocked row
  (#37), and never trimmed (it is human text). Subagents share the server, so a
  subagent's poll receives and stamps them: the contract tells it to return them to its
  parent verbatim and never act on or ack them, and the Claude hooks count OPEN messages,
  never undelivered ones (`hooks-and-watcher.md`). `ack_message` is its own tool, not
  `resolve` or `answer`, whose version-pinned item contracts stay byte for byte.
  Until the viewer's composer ships (#411 part 2), a message can be sent by hand, with the
  session id from `/api/activity` and the Origin every unsafe request needs:
  `curl -s -X POST -H 'Origin: http://127.0.0.1:4319' -H 'content-type: application/json'
  -d "{\"id\":\"$(uuidgen | tr A-Z a-z)\",\"text\":\"…\"}"
  http://127.0.0.1:4319/api/sessions/<session>/messages`.

## History (shipped since v1)

These landed after v1 and still hold invariants; the release history itself is in `CHANGELOG.md`.

- **Answer-back** *(#7)* — `pending` MCP tool + the viewer reply box. Answers carry an optional
  `reply_context`, and `reply_seen_at` records agent pickup.
- **`done`/milestone bucket** *(#9)* — `flag({ kind:'done' })`, surfaced in the viewer's Done section.
- **Dual-channel answer sync** *(#29)* — the `answer` MCP tool plus `answerItem`/`reply_source`.
  Agent-mediated by design: this repo has no hook into any chat client, so the AGENT is the
  bridge. Convergence is order-independent (inbox precedence, no clock comparison) rather than
  the issue's original "timestamp-based last write wins". Chat-recorded answers remain visible
  with their provenance and pickup receipt; while the question is open, the answer surface is
  prefilled for a non-destructive correction. Sending that correction through `replyItem` makes
  it the authoritative inbox answer and resets pickup without first blanking stored state.
- **Board-annotation delivery** *(#37)* — `pending()` returns `{items, rows}`: the human's per-row
  board notes ride the one poll every agent already makes, project-scoped like items, and a
  `blocked` row keeps arriving until an agent acknowledges it by flipping the status. See the
  delivery-is-not-acknowledgement invariant above; `docs/reporting-snippet.md` and the `pending`/
  `board_row` tool descriptions all say that the STATUS FLIP is the acknowledgement.
- **The human's "I did my part" mark on a blocked row** *(#36)* — `board_rows.handled_at` plus
  `handled_seen_at`/`handled_seen_by`. It exists for task-shaped blockers ("create the Paddle
  account", "record the hero demo"): a task wants DONE, and with the asking session over nobody
  was ever going to flip the status. Decision-shaped blockers now carry direct response options,
  store the choice as an annotation, and do not render this task control. Four things are
  load-bearing. (1) **It is not the `done`
  STATUS** — that is the agent's assertion about the row's work and only agents write it; the
  labels say so (`I've done my part` / `Not done after all`, and "You marked your part done" on
  the card). (2) **`upsertBoard` can never clear it**, and exactly one thing can: a status
  transition INTO `blocked` from something else (`resetHandledOnReblock`) — see the sacred-fields
  invariant above. (3) **The row does not vanish**: `isBlockedRowAttention` drops it via
  `humanActedOnRow`, and `awaitingAgentRows` picks it straight back up into the same
  awaiting-pickup foot an annotated row lands in. (4) **The undo is real or absent** — the store
  refuses a clear once `handled_seen_at` is set (one guarded statement, no TOCTOU), and the
  viewer does not draw the button when its own snapshot already shows a delivery. That is the
  rule the row ✕ removed in #38 broke: never draw a control that lies.
- **`blocked` now says WHO it waits on** *(#44)* — the six stored values are unchanged: no
  `needs-you` alias, no rename. The ambiguity was purely agent-facing (the viewer's 🚧 + Needs-you
  reads unambiguously), and the mistake is *choosing* `blocked` for work no person can unblock — a
  row went into the human's banner because a release candidate did not exist yet — so an alias
  would have added a seventh-looking status without removing the trap, and a rename would migrate
  every DB, the CSS and `attention.js` to fix a sentence. The fix is the text agents read: both
  board tool descriptions AND a zod `.describe()` on the `status` FIELD (the text a model reads
  while filling in an enum), each carrying the NEGATIVE example — stuck on a failing test, a
  missing build or another PR is `partial`, never `blocked`. `docs/reporting-snippet.md` gained
  one sentence of the same. A blocked row is also the ask itself: **one ask, one surface**.
  When a board row already owns the dependency, agents must set that row to `blocked` and must
  not create a separate question item for it; question flags are only for asks with no owning
  board row. Pinned over a real `tools/list` in `test/mcp.integration.test.ts`,
  which is also the only proof the field description survives `.optional()` and array-items.
- **The agent-emit contract** — `docs/reporting-snippet.md`'s end-of-turn rule now tests "am I about
  to stop and wait on the human?", so recommendations and "say the word" moments get flagged
  instead of buried. It now also defines ownership/impact/next-after, snooze semantics,
  answer|clarify|decline handling, required outcomes, and `board_advance` for chained work.
  Mirrored in MCP schemas/descriptions so malformed blockers are rejected at the call site.
- **Human action lifecycle** — blockers carry ownership, impact and next-after; the viewer
  offers snooze/wake, clarification and decline without changing agent-owned row status;
  answered work shows pickup/outcome/history and ages into a follow-up-due chip outside badge
  attention; board decisions and question items both expose native Electron response actions.
  Inbox can filter Decisions, To do and Updates since the previous visit. Review queue is the
  existing shared-attention deck: progress, action mix, ownership, always-visible option
  tradeoffs, and the same underlying card/write paths. Handoffs is a read-only projection of
  those same entities into Waiting on you → With the agent → Outcome; clicking a card routes
  back to its existing action/receipt/plan. Plan flow is plan-scoped and draws only
  plan → row → explicit `next_after`/`outcome` paths, plus (#103 slice 2 PR E) recorded
  `waits_on` steps and GitHub dependencies; `impact`/`next_after` prose never creates a
  dependency edge. Clicking a flow row opens a nested detail/action lightbox and keeps the graph mounted;
  leaving for Plans requires the explicit button.
