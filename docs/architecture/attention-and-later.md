---
paths:
  - "public/attention.js"
  - "public/relay.js"
  - "public/badge.js"
  - "public/rail.js"
  - "electron/reply-watch.cjs"
  - "src/store.ts"
  - "src/viewer.ts"
  - "public/app.js"
  - "src/watch.ts"
applyTo: "public/attention.js,public/relay.js,public/badge.js,public/rail.js,electron/reply-watch.cjs,src/store.ts,src/viewer.ts,public/app.js,src/watch.ts"
---

# Attention, snooze, pin and the watch stop

The single attention predicate and the human-owned deferrals (snooze, pin for later #247, the watch stop #217, closed projects #32).

Moved out of `CLAUDE.md` and `.github/copilot-instructions.md` by #379, nearly verbatim. Claude Code and Copilot CLI load this file automatically when they read or edit a file matching the `paths`/`applyTo` globs above (through the symlinks in `.claude/rules/` and `.github/instructions/`); anyone else should read it before changing those files.

## In brief

- **Shared presentation rules:** `public/attention.js` is the single attention
  predicate used by the viewer and Electron dock badge. Pure modules under
  `public/` hold grouping, ordering, search, badge, polling, and rendering rules;
  `public/app.js` coordinates DOM and API effects.
- Snoozed and pinned work (#247) leaves badge attention but remains on screen
  (`laterEntries`, tagged by reason; a pin wins): in one Later section at the foot
  of the queue while `agent-inbox-later-section` is on (the default; any value
  but `'false'`), otherwise in separate snoozed and pinned folds with the Pin
  control hidden. That setting is layout only, like #221's sort order: it never
  reaches attention, a badge, a count or the dock, which cannot read it. One
  render-time rule keeps cards visible: the fold under the queue (Later,
  snoozed, pinned or stale) that holds the open card always renders open,
  whatever moved its ask there (the clock included), and the human closing that
  fold closes the card (keeping its draft).
  Every deferral goes through `deferAsk`: an ask that holds a draft keeps or
  takes the open card (switching to the Inbox when the Review queue was opened
  on another tab), and one without a draft closes it, so only the human's own
  close can put a draft that pauses the list out of sight.
  Clarify/decline are response kinds, not outcomes. `board_advance` is the only
  same-row chain operation: it CAS-pins row `revision`, archives the prior step,
  and clears human/delivery state atomically. Agent reads get `history_count`, not
  full history.
- The human's watch stop (`watch_stopped_at`/`watch_stopped_until`, #217) is
  human-owned, version-pinned and not content: upserts never touch it, a stop
  for good is final, and its writes bump neither revision nor `updated_at`.
  A new action clears it through the `reset_row_action_watch_state` trigger, so
  an older server's re-block cannot carry it over. The control follows the
  ask's own `action_agent` (never `boards.agent`); an unknown asker draws
  nothing. It never changes attention by itself, and Claude's hook watch
  ignores it because that watch never wakes on a timeout. With the Later
  section on, the stop-waiting routes get `defer: true` (#247): ONE `.immediate()`
  transaction applies the stop and, against the same revisions, a pin (stop for
  good) or the ordinary snooze (until a time), or neither.
- The human's pin for later (`pinned_at`, #247) is human-owned, version-pinned
  and not content, like the watch stop: its writes bump neither revision nor
  `updated_at`, and no agent write names it. The triggers
  `clear_row_pin_when_ask_ends` and `clear_item_pin_when_ask_ends` clear it when
  the ask is answered, closed or unblocked, or a new action starts, so an older
  server's writes cannot carry it over. A pin and a snooze with a time replace
  each other. The attention predicate drops a pinned ask, and Electron's
  notification `known` set keeps pinned asks (`knownNotificationIds`), so
  bringing one back is never announced as new.

## Invariants in detail

- **Snooze and pin are demotions, never disappearance.** `snoozed_until` (until due) and,
  since #247, `pinned_at` (no return time) exclude an unanswered item or row from
  `attentionEntries`/badge counts, but `laterEntries` hands them to the renderer tagged
  `later: 'snoozed' | 'pinned'` (a pin wins when both are set), drawn as one Later section at
  the foot of the queue while the Later setting is on (the default), or as a "snoozed" fold with
  Wake now and a "pinned" fold with Back to inbox while it is off. The predicates and `laterEntries` share one
  `laterReason`, so the complements stay exact: every blocked row is in attention ∪ Later ∪
  awaiting-agent, every open question in attention ∪ stale fold ∪ Later ∪ replied foot.
  Clarify/decline are response kinds and therefore human action; they move to awaiting-agent
  and never pretend to be an outcome.
- **The human's watch stop is human-owned, version-pinned and NOT content (#217).**
  `watch_stopped_at`/`watch_stopped_until` on items and rows record "I'll take a while":
  stopped for good (`until` NULL) or until a time. Like `annotation`/`handled_at`, no agent
  upsert or row edit touches them. The only reset is a new action, by ANY writer: the
  `reset_row_action_watch_state` trigger (`AFTER UPDATE OF action_version`) clears them,
  because an older server sharing the file runs its own `beginNewRowAction`, which knows
  nothing of these columns — exactly the `increment_item_response_revision` precedent. An
  item is its own ask: no writer, old or new, reopens or re-purposes one. A stop for good is
  final — the watcher has already exited, so the store refuses to revise it into a deferral
  nothing would honour, and the viewer renders a reminder instead of a control; that
  reminder stays on an answered card until an agent picks the answer up. Answered, handled,
  closed, archived or unblocked asks refuse a stop. Row writes are pinned to row AND board
  revision, but the write bumps neither revision nor `updated_at`: it changes nothing an
  agent writes, so an agent's `board_get` → `board_upsert` snapshot stays valid and native
  notifications (keyed by revision) are not re-announced. Viewer routes require `until`
  explicitly (date or null): a dropped field is a 400, never the final stop. The stop itself
  leaves attention untouched — the ask stays in Needs-you unless also snoozed or pinned; with
  the Later section on, #247's coupled `defer` write does exactly that in the same
  transaction (see the pin bullet below). **The control follows the
  ask's own asker, `action_agent`, never `boards.agent`** (the board's last writer, which a
  Copilot edit of another row flips and `board_advance` never restamps). Rows stamp it in
  the statement that starts each action, tagged with `action_agent_version`; the trigger
  keeps it only when that tag matches the new version, so an older server's new action has
  no asker. Items stamp it at insert. Older servers stamp nothing, and their watchers ignore
  a stop anyway, so an unknown asker draws no control: hide, never guess. Only `copilot`
  draws it, because only Copilot runs the watcher it stops; a chat-recorded answer draws
  nothing, since the agent recorded it itself. Claude's hook `watch` is deliberately
  unaffected: it never wakes on a timeout (it exits 0 and re-arms at the agent's own Stop),
  so a stop would only remove its answer wake and save nothing.
- **A pin for later is human-owned, version-pinned and NOT content (#247).**
  Design: [`docs/superpowers/specs/2026-10-21-pin-for-later-design.md`](../../docs/superpowers/specs/2026-10-21-pin-for-later-design.md).
  `items.pinned_at`/`board_rows.pinned_at` say "set this unanswered ask aside, with no return
  time". Only `pinItem`/`pinBoardRow` (the viewer's `POST …/later` routes, `{ pinned }`
  required) write it, on an unanswered open question or an unanswered, unhandled blocked row
  of an active plan; a re-pin keeps the first time. Like the #217 watch stop it bumps neither
  revision nor `updated_at`, so an agent's `board_get` → `board_upsert` snapshot stays valid
  and a native notification keyed by revision is not re-announced, yet row writes are still
  pinned to row AND board revision. In this server a pin clears `snoozed_until` and a snooze
  with a time clears `pinned_at` (waking does not); an older server's snooze leaves both set,
  which is harmless. No agent write names the column, so a full re-send keeps it. The resets
  are TRIGGERS, so an older server's writes obey them too: `clear_row_pin_when_ask_ends` (a new
  action, a move out of `blocked`, an answer, a response kind, a handled mark) and
  `clear_item_pin_when_ask_ends` (closed, answered, a response kind). Each inner UPDATE names
  only `pinned_at`, which no trigger listens to, so neither re-fires or moves `updated_at`,
  `revision` or `response_revision`. `beginNewRowAction`, an answering `replyItem` or
  `annotateBoardRow`, and `markRowHandled` also clear it in their own statement, exactly where
  the trigger would: a cleared note answers nothing and keeps the pin. Agents see `pinned_at`
  in `pending()` (a pinned blocked row arrives on every poll until its status flips, as a
  snoozed one does) and in `board_get`; the Copilot watcher ignores it. *(Slice 2)* The one
  predicate drops a pinned ask (`isPinnedForLater`, see "Snooze and pin are demotions"), so the
  title and dock badges, tab counts, rail, Review queue, Dashboard and Handoffs all follow.
  "Pin for later" is the first choice in More responses on an unanswered open
  question or an unanswered blocked row of an active plan, and is not drawn on one already
  pinned; it posts to the `later` route with the row and board revisions and ends in
  `reloadAndPaint()`, like every human write. Every deferral, pin or snooze, goes through
  `deferAsk`. When the ask holds a draft it keeps the open card (or, from the Review queue or
  a plan panel, takes it, widening a list filter that would hide it); without one the card
  closes (§2.1). **One render-time rule keeps the open card in view:** `renderNeedsYou` opens the
  fold under the queue (Later, snoozed, pinned or stale) that holds the open card, through
  `openDeferredFolds` or `staleFoldOpen`, so it always renders open, whatever moved the ask
  there: a deferral, the Later setting, another client, a native notification, or the clock
  for an ask that turns stale while open. A draft pauses the list by design, so nothing may carry it
  out of sight; fix a new case through this rule, never with a per-transition patch. The human
  closing that fold closes the card too (`closeCardIn`, keeping any draft as any closed card
  does), or the next frame would open the fold again under them. *(#272)* A row snooze moves
  the revision, so a drafted row's draft still goes to the unsent responses, never re-keyed.
  `deferAsk` marks the draft's `rowDraftMeta` with `setAside` only after its own write
  succeeds and clears it once its `reloadAndPaint()` ends; `reconcileDraftOwners` copies it into
  the recovery entry, so the row says "Kept from before you set this aside" instead of "Not
  sent because this action changed". The reason is fixed when the entry is made; a pin, which
  moves no revision, leaves no mark for a later agent edit to inherit. Deferred
  rows carry a reason chip instead of an urgency (`Pinned 2d ago`, `Back in 3h`,
  `… · agent waits quietly` while a Copilot asker's #217 deferral runs). Electron's `known`
  set is the unsuppressed attention set plus the `pinned` Later entries
  (`knownNotificationIds` in `electron/reply-watch.cjs`): a pin moves no revision, so Back to
  inbox announces nothing, while a snooze that ends and a new action are announced.
  *(Slice 3)* **The Later section and its setting.** Settings → Inbox → "Later section"
  (`agent-inbox-later-section` in localStorage, on by default, any value but `'false'` reads
  as on) is LAYOUT ONLY: Electron main computes the dock badge from the same predicate and
  cannot read this storage, so a setting that changed attention would make the two badges
  disagree. On: `laterSectionEl` draws one collapsed `<details class="later-section">` after
  Show more and before the stale fold, keyed `'later'` in `openDeferredFolds` (so its open
  state survives rebuilds and `revealDetailsAncestors` opens it for a deep link or draft
  recovery), headed `Later · N` with `laterBreakdown` (`2 pinned · 1 snoozed, next back in
  2h`). N follows the lens and the action filters, like every list surface, and never
  reaches the badge, a tab or the rail. Its order is `sortLaterEntries` (snoozed soonest back
  first, then pinned oldest first, ties by a stable key), never the Sort menu. Rows are
  ordinary `.nrow`s whose way back is always "Back to inbox"; only their lines are dimmed,
  never the section (nor the snoozed, pinned or stale fold, which dim their summary and row
  lines instead), because the desktop inspector is fixed inside its row and an ancestor's
  opacity would fade it and trap it in the fold's stacking context. Only the unsent-responses
  fold, which holds no rows, is dimmed whole. The empty state says `Nothing needs you now · N in Later`; search
  marks an Open items question in Later with a `Later` label (`markLaterResults`, with the
  closed set the section uses, beside the
  clock, so a snooze ending changes the result signature). Off: slice 2's snoozed and pinned
  folds, the Pin control is not drawn, and Settings shows how many pins still wait in the
  pinned fold (`paintLaterSectionHint`, ambient). **The coupled write (§5.4).** With the
  section on, "I'll take a while" posts `defer: true` through `deferAsk`, so a draft stays in
  view: `stopItemWatch`/`stopBoardRowWatch` then run ONE `.immediate()` transaction
  (`stopAndDefer`) that applies the #217 stop and, against the same revisions, `pinItem`/
  `pinBoardRow` (stop for good) or `snoozeItem`/`snoozeBoardRow` (until a time), nested as
  savepoints. A refused half throws a sentinel that rolls back both; any SQLite error rolls
  back both and propagates. The halves keep their own semantics: the stop moves nothing, the
  pin moves nothing, and the snooze moves the row and board revisions and `updated_at`
  exactly as a More-responses snooze does. The stop moves no revision, so the deferral checks
  exactly what the stop checked; do not reorder the halves. Nothing in the schema changed,
  and an older process's statements meet the existing triggers (`test/mixed-version.test.ts`
  pins its re-send keeping both halves and its new action ending both). A deferral from a
  Review queue opened on another tab with `t` switches to the Inbox (`selectTab(…, { paint:
  false })`, no focus move) only when the ask holds a draft and the write succeeded, and the
  queue then returns focus to the Inbox's Review queue button, not to the tab it left.

## History (shipped since v1)

These landed after v1 and still hold invariants; the release history itself is in `CHANGELOG.md`.

- **Close / reopen a project** *(#32)* — a sparse `projects(project, closed_at)` table; **reopen is
  DERIVED, never written** (a project un-closes the moment an item or board is CREATED in it after
  `closed_at`), so `insertItem` stays byte-identical and the un-close is atomic with the very insert
  that raises the question. A closed project leaves the §7 attention set **entirely** — badge, title,
  Needs-you count, triage deck — via a 5th `closedProjects` argument to `attentionEntries`, so there
  is still exactly ONE predicate; `countsByProject` deliberately stays unsuppressed because the
  rail's closed fold is where the number is RELOCATED, not destroyed. Live presence (footer strip and
  drawer) is untouched: presence is not attention. Clicking a closed project PEEKS (a banner above
  the panel says the badge excludes what you are looking at); only × / ↩ / a new flag mutate.
  Closing also retires the project from #30's PR poller (`listLinkTargets` filters through
  `closedProjects`, never the raw table, so a derived reopen resumes polling by itself) — a retired
  project must not keep spawning `gh` every 60s nor keep eating the shared `MAX_PER_TICK` budget.
  The reopen predicate is strict `>` **on purpose**: a close and a write can tie at the millisecond,
  and the tie goes to the human's explicit act — `>=` would mean closing a project in the same
  millisecond an item lands leaves it open, i.e. a × that visibly does nothing. Pinned on a frozen
  clock in `test/store.test.ts`.
  **Honest limitation:** an agent already blocked on a question raised *before* the close creates
  nothing new while it polls `pending()`, so closing that project mutes a genuinely-live blocker
  until fresh content arrives. "Nothing can be permanently muted" is true of everything except that
  case — do not restate it unqualified.
  *(#412)* The reserved projects `@sessions` and `@mesh` can never be closed: `closeProject`
  refuses one (the route answers 200 `{ ok: false, reason: 'reserved_project' }`) and
  `closedProjects()` leaves one out even when an older viewer wrote the row, because closing
  `@sessions` would mute every driven session's approvals.
