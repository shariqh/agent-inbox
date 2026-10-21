# Design: Pin for later and the Later section (issue #247)

**Date:** 2026-10-21
**Status:** Draft. Four decisions for the owner are in §11.
**Milestone:** v1.5. Closes #247 when the last slice lands.
**Scope of this PR:** this document only. No source or test changes.

---

## §0 — Summary

1. A new human response, **Pin for later**, on open questions and blocked rows. It sets the
   ask aside with no return time.
2. A pin is stored as one human-owned column, `pinned_at`, on `items` and `board_rows`. Agent
   writes never touch it. A trigger clears it when the ask ends or a new action starts, so an
   older server sharing the database cannot carry a pin into a new ask.
3. A pin is a **demotion, like snooze**. The one predicate in `public/attention.js` drops
   pinned asks from the attention set, so the title badge, tab counts, rail, triage deck and
   the Electron dock badge all agree without any extra rule.
4. The **Later section** sits at the foot of the Inbox queue. It holds pinned and snoozed asks
   with one visible count. Snoozed asks return on their own when the snooze ends. Pinned asks
   return when the human says so, or when the ask ends or changes into a new action.
5. A **Settings toggle** (on by default) turns Later on or off. It is saved in localStorage
   like the default sort order (#221). It only changes layout and which writes the
   "I'll take a while" menu makes. It never changes attention, because the dock badge runs in
   Electron main and cannot read the renderer's localStorage.
6. With the toggle on, "I'll take a while" also defers the ask in the inbox, in one write:
   "Back in …" snoozes it to the same time, and "Stop waiting" pins it.
7. With the toggle off, today's layout stays: a "snoozed" fold, plus a "pinned" fold for any
   pins that already exist. The Pin control is hidden.
8. A pin write bumps neither `updated_at` nor any revision. It is pinned to the row and board
   revisions the human saw, like every row action.
9. Agents see `pinned_at` in `pending()` and titled `board_get`, as they see `snoozed_until`
   today. A pin does not change the Copilot answer watcher.
10. Three PRs: store and API; predicate, Pin control and pinned fold; Later section, setting
    and the "I'll take a while" coupling.

---

## §1 — What exists today

- **Snooze** (`snoozed_until`). `snoozeItem` / `snoozeBoardRow` set a time. `isSnoozed` in
  `attention.js` drops the ask from `isAskingQuestion` and `isBlockedRowAttention` until the
  time passes. `snoozedEntries` feeds a collapsed "snoozed (N)" fold under Needs you, and each
  row there has **Wake now** (snooze to `null`). A row snooze bumps `updated_at` and the row
  revision. A reply, an annotation, a handled mark and `beginNewRowAction` clear the snooze in
  the same statement.
- **"I'll take a while"** (#217, `watch_stopped_at` / `watch_stopped_until`). It only tells a
  Copilot answer watcher to stop, or to wait quietly until a time. The ask stays in Needs you
  and in the badge. The write bumps neither revision nor `updated_at`. The trigger
  `reset_row_action_watch_state` clears it when `action_version` moves.
- **The stale fold.** An unanswered question with no live session that is older than 72 h
  leaves attention and sits in its own fold.
- **Electron.** `electron/main.cjs` calls `attentionEntries` on `/api/items?scope=attention`
  and `/api/boards` every 3 s. It sizes the dock badge from the result and announces entries
  whose ids are not in `known`. Row ids include the revision (`r:<id>:v<revision>`), so an
  unchanged ask is not announced twice (#158).
- **Naming.** "Pin" already means two other things in the code: order pinning in the queue
  (`pinnedIds` in `app.js`) and plan issue pins (`boards.issue_pin_*`, #103). This design uses
  `pinned_at` on items and rows, and frontend names such as `laterPinned` / `isPinnedForLater`
  so the three stay distinct.

---

## §2 — What the human sees

### 2.1 The Pin for later response

- It appears in the card's **More responses** menu, first, above the snooze choices:
  "Pin for later". The same menu is used on desktop, in the inspector, and in the phone card
  footer.
- It is offered only on an **unanswered open question** or an **unanswered blocked row** on an
  active plan. It is not offered on notes, milestones, answered asks or non-blocked rows.
- It is hidden when the Later setting is off (§2.4).
- After the click the card closes and the ask moves to Later. The write ends in
  `reloadAndPaint()`, like every human write.

### 2.2 The Later section

- **Where.** At the foot of the Inbox queue, after the Needs-you entries and the "Show more"
  button, before the stale fold. It replaces the snoozed fold when the setting is on.
- **Shape.** A `<details>` disclosure, collapsed by default. Open or closed state is
  window-local and survives poll rebuilds, as `snoozedFoldOpen` does today. Rows inside are
  ordinary `.nrow` elements in the same list host, so the desktop inspector, row-scoped writes,
  drafts, deep links and the poll gate all work unchanged.
- **Header.** `Later · 3` and a short breakdown: `2 pinned · 1 snoozed, next back in 2 h`.
- **Count scope.** The count follows the current lens (project and agent filter), like the
  snoozed fold today. It never enters the badge, the tab count or the rail.
- **Empty queue.** When Needs you is empty and Later is not, the empty state says
  "Nothing needs you now · 3 in Later", so nothing is out of view without a number on screen.
- **Order.** Snoozed asks first, soonest return first. Then pinned asks, oldest pin first.
  Order is stable across polls.
- **Each row** shows a reason chip instead of the urgency chip: `Pinned 2 d ago`,
  `Back in 3 h`, or `Back in 3 h · agent waits quietly` when the ask also carries a #217
  deferral. A watch stopped for good still shows #217's reminder on the card.
- **Each row** has **Back to inbox**. For a pinned ask it clears the pin. For a snoozed ask it
  is today's Wake now. The full card still works inside Later, so the human can answer,
  clarify, decline or mark done without moving the ask back first. Answering moves it to the
  awaiting-agent foot, as today.
- **Phone widths.** Same section, full width, at the foot of the queue. Cards open inline as
  they do below 1280 px today. The breakdown line wraps under the header below 440 px.
- **Elsewhere.** Search still finds pinned asks under "Open items", with a `Later` chip. The
  Review queue and the Dashboard follow the attention set, so pinned asks drop out of them, as
  snoozed asks do now. Handoffs is unchanged.

### 2.3 "I'll take a while" with Later on

The menu keeps its four choices, and each also defers the ask in the inbox in the same write:

| Choice | Watcher (#217, unchanged) | Inbox |
| --- | --- | --- |
| Stop waiting | stops for good | pinned |
| Back in ~1 h / ~3 h / tomorrow | waits quietly until then | snoozed until the same time |

The button titles say so: "The agent stops waiting. The ask moves to Later until you bring it
back." Only Copilot asks with a known asker show this menu, as today.

### 2.4 The setting

- **Settings → Inbox → "Later section"**, a checkbox: "Move pinned and snoozed asks to a Later
  section at the foot of the inbox". Saved under `agent-inbox-later-section` in localStorage,
  per browser or app profile, like `agent-inbox-default-sort` (#221). A change repaints at once
  through `forceRender()`.
- **Default: on** (decision 1).
- **On:** §2.1 to §2.3.
- **Off:** today's layout. The snoozed fold stays. Pins that already exist render in a second
  fold, "pinned (N)", with Back to inbox on each row, so turning the setting off never hides
  anything. The Pin control is hidden. "I'll take a while" writes the watch stop only, as
  today. Turning the setting off while pins exist shows a hint under the checkbox:
  "2 asks are still pinned. They stay in a pinned fold until you bring them back."

The setting is layout only. A pinned ask is out of the badge in both modes (§4).

---

## §3 — Return rules

| Event | Result |
| --- | --- |
| Snooze time passes | Back in Needs you. No write: `isSnoozed` reads the clock. Re-announced natively, as today. |
| "Back in …" time passes (Later on) | Same as a snooze ending, because it is one. The watcher wakes per #217. |
| "Stop waiting" (Later on) | Pinned. Stays in Later until the human acts. |
| Explicit Pin for later | Stays in Later until the human acts. No expiry (decision 3). |
| Human clicks Back to inbox | Pin cleared. Back in Needs you. Not re-announced natively (§4.3). |
| Human answers from Later | Pin cleared. Moves to the awaiting-agent foot. |
| Agent `board_advance`, or a re-block after another status | New action. Trigger clears the pin. Appears in Needs you as a new ask with a new revision, and is announced. |
| Agent edits the same blocked row without a new action | Pin kept. The row shows the existing "changed" marker in Later. |
| Agent moves the row out of `blocked` | Trigger clears the pin. The row leaves the inbox as any unblocked row does. |
| Question resolved, dismissed or swept | Trigger clears the pin. Goes to History. |
| Agent records a chat answer (`answer`) | Trigger clears the pin. Moves to the replied foot. |
| Plan archived | Row leaves the inbox with the plan. On unarchive a still-pinned row returns to Later. |
| Project closed | Closed-project suppression wins: the ask leaves Later and its count, as snoozed asks do today. A derived reopen brings it back to Later. |
| No live session for 72 h | A pinned or snoozed question stays in Later, not the stale fold. |
| Viewer restart, app restart | Pins and snoozes are stored, so Later is unchanged. The setting is in localStorage, so it survives too. |
| Several windows | All read one database, so a pin in one window shows in the others on their next poll. The setting is per profile: windows on one profile share it, and the Electron app and a browser tab can differ. Either way the badge is the same, because the setting is layout only. |

Pin and snooze are mutually exclusive in the current server: a pin clears `snoozed_until`, and
a snooze with a time clears `pinned_at`, each in the same statement. An older server's snooze
does not clear a pin. Both set is harmless: the ask is in Later either way, and Back to inbox
clears the pin while the snooze ends on its own.

---

## §4 — Attention semantics

### 4.1 The predicate

A pin is a demotion, exactly like snooze. In `public/attention.js`:

```js
function isPinnedForLater(entity) {
  return Boolean(entity?.pinned_at)
}
// isAskingQuestion:      ... && !isSnoozed(item, nowMs) && !isPinnedForLater(item)
// isBlockedRowAttention: ... && !isSnoozed(row, nowMs) && !isPinnedForLater(row)
```

`snoozedEntries` becomes `laterEntries(items, boards, nowMs, closedProjects)`. It returns
every unanswered open question and every unanswered blocked row on an active plan in an open
project that is snoozed or pinned, each tagged `later: 'snoozed' | 'pinned'` (pinned wins when
both are set). The renderer draws one Later section, or splits by tag into the two folds when
the setting is off. `snoozedEntries` is removed, so `test/dead-exports.test.ts` stays honest.

The three-way complement stays exact. Every blocked row on an active plan in an open project
is in exactly one of: attention, Later, or `awaitingAgentRows`. Every open question is in
exactly one of: attention, the stale fold, Later, or the replied foot.

### 4.2 Badge, Needs you, rail, dock

All of them read `attentionEntries`, so a pinned ask leaves every count at once, in both
setting modes. Later has its own count (§2.2), so nothing leaves the screen without a number.

The setting must not change attention. Electron main computes the dock badge from the same
predicate but cannot read the renderer's localStorage. If the setting changed attention, the
dock and the title badge would disagree. That is the reason the setting is layout only.

A watch-stopped ask with no pin and no snooze stays in attention, as #217 decided. With Later on
it can only reach Later through the coupled write in §2.3.

### 4.3 Native notifications

- While pinned, an ask is outside attention, so it is never announced.
- `known` in `main.cjs` today is the unsuppressed attention set. It becomes that set plus the
  `later: 'pinned'` entries of `laterEntries`. A pinned ask therefore stays "known", and Back to
  inbox does not announce an ask the human just moved themselves. Row ids are keyed by revision
  and a pin does not bump it (§5.3), so the id is unchanged across the round trip.
- Snoozed entries stay out of `known`, so a snooze that ends is announced again, as today.
- A new action has a new revision, so it is announced as new.

### 4.4 `awaitingAgentRows` and the response watch

Unchanged. A pin only applies to unanswered asks, and the trigger clears it when the human
answers. `electron/reply-watch.cjs` watches answered work only, so pins never reach it.

---

## §5 — Data model

### 5.1 Columns (additive)

```
items.pinned_at        TEXT NULL   -- ISO time the human pinned this question
board_rows.pinned_at   TEXT NULL   -- ISO time the human pinned this row's current action
```

Added with `ensureColumn` in `migrate()`. NULL means not pinned, so there is no backfill. The
row column joins `ROW_COLUMNS`, so `/api/boards`, `getActiveBoardRow` and `listBoards` carry it.
Items use `SELECT *`, so `/api/items`, `?scope=attention` and `listPending` carry it already.

### 5.2 Ownership and reset

`pinned_at` is human-owned, like `annotation`, `handled_at` and the #217 watch stop.

- `upsertBoard`, `updateBoardRow`, `advanceBoardRow`, `insertItem` and every other agent path
  never name the column. A full-table re-send keeps it.
- Resets are triggers, not writer code, so an older server sharing the file obeys them
  (the `reset_row_action_watch_state` precedent):

```sql
CREATE TRIGGER IF NOT EXISTS clear_row_pin_when_ask_ends
  AFTER UPDATE OF action_version, status, annotation, annotation_kind, handled_at ON board_rows
  WHEN NEW.pinned_at IS NOT NULL AND (
        NEW.action_version IS NOT OLD.action_version
     OR NEW.status IS NOT 'blocked'
     OR COALESCE(NEW.annotation, '') <> ''
     OR NEW.annotation_kind IS NOT NULL
     OR NEW.handled_at IS NOT NULL)
  BEGIN
    UPDATE board_rows SET pinned_at = NULL WHERE id = NEW.id;
  END;

CREATE TRIGGER IF NOT EXISTS clear_item_pin_when_ask_ends
  AFTER UPDATE OF status, reply, reply_kind ON items
  WHEN NEW.pinned_at IS NOT NULL AND (
        NEW.status IS NOT 'open'
     OR COALESCE(NEW.reply, '') <> ''
     OR NEW.reply_kind IS NOT NULL)
  BEGIN
    UPDATE items SET pinned_at = NULL WHERE id = NEW.id;
  END;
```

The inner `UPDATE` names only `pinned_at`, so it does not fire either trigger again and does
not touch `updated_at`, `revision` or `response_revision`. `increment_item_response_revision`
fires only on its named reply and annotation columns, so a `pinned_at`-only update does not
move the response revision. A store test pins that.

The current server also clears `pinned_at` in `beginNewRowAction`, `replyItem`,
`annotateBoardRow`, `markRowHandled` and a snooze with a time. That is redundant with the
triggers but keeps each statement self-describing.

### 5.3 Writes

```ts
pinItem(db, id, pinned: boolean): boolean
pinBoardRow(db, rowId, pinned: boolean, expectedRevision: number, expectedBoardRevision: number): boolean
```

- **Pin** (`pinned: true`), one conditioned `UPDATE`:
  `SET pinned_at = COALESCE(pinned_at, @now), snoozed_until = NULL`.
  - Item: `kind = 'question' AND status = 'open' AND COALESCE(reply,'') = '' AND reply_kind IS NULL`.
  - Row: `status = 'blocked'`, unanswered and unhandled (the `snoozeBoardRow` conditions),
    `revision = @expected`, and the board active with `revision = @expectedBoard`.
  - Re-pinning keeps the first `pinned_at`, and returns true.
- **Unpin** (`pinned: false`): `SET pinned_at = NULL`, with the same row and board revision
  pins and `pinned_at IS NOT NULL`. Returns false when nothing was pinned.
- **Neither write bumps `updated_at`**, because a pin is not content: the New/changed filter
  must not light up for it (the issue's constraint, and CLAUDE.md "`updated_at` means content
  changed").
- **Neither write bumps the row or board revision.** This follows the #217 watch stop, not
  snooze. A pin changes nothing an agent writes, so an agent's `board_get` → `board_upsert`
  snapshot stays valid, and native notifications keyed by revision are not re-announced. The
  write is still pinned to both revisions, so a stale click cannot pin a newer ask that reused
  the stable row id.
- Rows use `.immediate()` only if the write grows a read. As specified it is one statement.
- Snapshot validity: every write changes `data_version` / `total_changes()`, so the conditional
  snapshots for `/api/items`, `?scope=attention` and `/api/boards` invalidate on their own.

### 5.4 The coupled "I'll take a while" write

`stopItemWatch` and `stopBoardRowWatch` gain an optional `defer: boolean`. With `defer`, one
`.immediate()` transaction checks the row and board revisions once and then applies both
writes: the watch stop, and either a pin (`until` null) or a snooze to `until`. If either part
is refused, nothing is applied. The snooze half keeps snooze's existing semantics, including
its revision and `updated_at` bump, so it is indistinguishable from a snooze made from the
More responses menu.

### 5.5 Mixed-version safety

| Older process does | Result |
| --- | --- |
| Full `board_upsert` re-send | Pin kept: the statement never names the column. |
| `board_advance` or a re-block | Pin cleared by the trigger. |
| Resolve, dismiss, reply, chat answer | Pin cleared by the trigger. |
| Snooze with a time | Pin kept, snooze set. Harmless (§3). |
| Older viewer or dock reads a pinned ask | It ignores `pinned_at`, so the ask shows in its Needs you and badge. That is an over-count, never a hidden ask. |

`test/mixed-version.test.ts` runs frozen v1.4 statements against a migrated hub to pin the
first three rows.

### 5.6 What agents see

- `pending()`: items already return every open question, so `pinned_at` rides along. Rows:
  `listPendingRows` adds `r.pinned_at` to its columns and `OR (r.pinned_at IS NOT NULL AND
  r.status = 'blocked')` to its first condition, mirroring how a snoozed row is delivered.
- Titled `board_get`: `RowSummary` in `shape.ts` gains `pinned_at` when set, beside
  `snoozed_until`.
- The `pending` tool description adds one clause: "pinned_at means they set it aside with no
  time: keep the ask open and do not re-ask; an answer still arrives through pending()."
- `pending()` remains free of human attention effects. A pin is not an answer, and it does not
  close or acknowledge anything.
- **The Copilot watcher ignores pins.** "Stop waiting" is the human's explicit control for
  that. A pin alone keeps #217's backoff (30 min, then 1, 2 and 4 h). `src/watch.ts` is
  unchanged.

---

## §6 — Viewer API

| Route | Body | 400 when | 200 `{ok:false}` when |
| --- | --- | --- | --- |
| `POST /api/items/:id/later` | `{ pinned: boolean }` | body unparseable, `pinned` not a boolean | `reason: 'not_pinnable'` (closed, answered, not a question, or nothing to unpin) |
| `POST /api/boards/:id/rows/:rowId/later` | `{ pinned, expected_revision, expected_board_version }` | as above, or a revision not an integer | `reason: 'version_mismatch'` when the caller's revisions are stale; otherwise `reason: 'not_pinnable'` (the `snooze` route's split, #160) |
| `POST /api/items/:id/stop-waiting` | adds optional `defer: boolean` | `defer` present and not a boolean | as today |
| `POST /api/boards/:id/rows/:rowId/stop-waiting` | adds optional `defer: boolean` | as above | as today |

All bodies parse with `.catch(() => null)` and are type-checked before any store call (#163).
Extra fields are ignored. No new GET route and no new conditional snapshot: the new column
appears in existing payloads, whose validators already cover any write. All routes sit behind
`viewer-network.ts`, which requires a trusted Origin for every mutation.

---

## §7 — Rendering notes

- `rowview.js` adds `pinnedAt` to the row model and a `later` liveness; `urgencyChip` returns
  the reason chips in §2.2.
- `app.js`: the Needs-you renderer calls `laterEntries` once, then draws either `laterSectionEl`
  (setting on) or `snoozedFoldEl` plus `pinnedFoldEl` (setting off). `revealDetailsAncestors`
  learns the new classes so deep links into Later open it.
- The Pin control lives in `dispositionEl` beside the snooze choices and posts to the `later`
  route with the row's revision and board revision.
- Nothing here adds a render entry, a suspension or a fetch from a render path.

---

## §8 — Alternatives considered

- **A snooze with a far-future time as the pin.** One mechanism, and older viewers would show it
  as snoozed. Rejected: `watch.ts` treats any snooze as quiet time and would hold the watcher
  for its 24 h ceiling, silently changing #217; the card would read "snoozed for 9,000 days";
  every snooze write bumps the row revision and `updated_at`; and "snooze ends, ask returns"
  would need a sentinel exception everywhere `snoozed_until` is read.
- **A filter instead of a section.** Filters are window-local and reset on cold launch
  (attention-first launch), and a filter hides its complement without a count. The owner asked
  for a section.
- **A fifth library tab, "Later".** It separates deferred asks from the queue they belong to,
  and the four-tab library is already tuned for the 620 px phone row. Rejected for v1.
- **A stored, server-side setting that changes attention**, so watch-stopped asks could leave
  the badge with the setting on. It needs a settings table, a route and a dock read, and it
  makes the badge depend on a preference. The coupled write in §2.3 gets the same result with
  stored per-ask state. Rejected.
- **A `later` row status.** Status is agent-owned. Rejected.
- **Bumping the row revision on pin**, as snooze does. It would refuse an agent's next
  snapshot-based upsert and re-key native notifications for a change the agent never made.
  Rejected; the #217 watch stop is the precedent.
- **Pins that expire.** See decision 3.

---

## §9 — Test plan

- **Store** (`test/store.test.ts` or a new `test/later.test.ts`): pin and unpin for items and
  rows; refusals for closed, answered, handled, non-blocked, archived and stale-revision
  targets; re-pin keeps the first time; pin clears snooze and snooze clears pin; `updated_at`,
  `revision`, board revision and `response_revision` unchanged by a pin; each trigger clears on
  every listed event and only those (an agent note edit keeps the pin); the coupled watch-stop
  write is all-or-nothing.
- **Mixed version** (`test/mixed-version.test.ts`): frozen v1.4 `upsertBoard` keeps a pin;
  frozen `board_advance`, re-block, resolve and reply clear it.
- **Viewer API** (`test/action-viewer.test.ts`): each 400 case makes no store call; the
  `version_mismatch` / `not_pinnable` split; `defer` validation; the new column appears in
  `/api/items`, `?scope=attention` and `/api/boards`, and a pin changes their ETags.
- **Attention** (`test/attention.test.ts`, `test/action-attention.test.ts`): pinned asks leave
  `attentionEntries`, `attentionCount`, `countsByProject` and `staleEntries`; `laterEntries`
  tags and closed-project suppression; the complement holds over a fixture with every state.
- **MCP** (`test/mcp.integration.test.ts`): `pending()` carries `pinned_at` for items and rows;
  titled `board_get` carries it; a pinned blocked row keeps arriving until its status flips.
- **Electron** (`test/reply-watch.test.ts`, `test/badge.test.ts`): `known` includes pinned
  entries, so unpin does not announce; a new action on a pinned row does; the dock count matches
  the title badge.
- **DOM** (`test/dom/`, jsdom harness): Pin from the More responses menu moves the row to Later
  and updates the header count; Back to inbox returns it; a snooze ending returns it with the
  clock advanced; setting off shows the snoozed and pinned folds and hides the control; the
  setting survives a reboot of the harness; answering from inside Later; a poll keeps Later's
  open state, the open card and its draft; the empty state names the Later count; badge, tab
  and Needs-you counts match with and without pins. Assert rendered state, never handler
  counts.

---

## §10 — Slicing

1. **PR1 — store and API.** Columns, triggers, `pinItem` / `pinBoardRow`, the two `later`
   routes, `pending()` and `board_get` exposure and the tool description. Store, mixed-version,
   viewer and MCP tests. No UI: nothing calls the routes yet, and the predicate is unchanged,
   so behavior is identical. Updates CLAUDE.md's invariants.
2. **PR2 — predicate and Pin control.** `isPinnedForLater`, `laterEntries`, the pinned fold
   beside the snoozed fold, the Pin for later button, the reason chips and the Electron `known`
   change. This is the setting-off layout, and it is complete on its own.
3. **PR3 — Later section and setting.** The Settings checkbox, the Later section, the empty
   state, the coupled `defer` write and its store and route support, and the README and docs.

Each PR ships independently. PR2 can follow PR1 the same day; PR3 depends on decisions 1, 2
and 4.

---

## §11 — Decisions for Shariq

**Decided 2026-10-21:** Shariq approved the recommended answer to every question below: the Later section is on by default, "I'll take a while" also defers the ask in the same write, pins don't expire, and with the setting off the Pin control is hidden while existing pins show in a "pinned" fold.

**1. Should the Later section be on by default?**
- **A. On (recommended).** Snoozed asks already leave Needs you today, so on is a small change
  for existing users, and it is what the issue asks for.
- B. Off. Nothing moves until the human opts in. The Pin control stays hidden until then.

**2. With Later on, what should "I'll take a while" do to the ask in the inbox?**
- **A. Defer it in the same write (recommended).** "Back in …" snoozes it to the same time;
  "Stop waiting" pins it. One click covers the watcher and the inbox, and the badge stays one
  rule.
- B. Nothing, as today. The ask stays in Needs you and in the badge; the human pins or snoozes
  it separately.
- C. Show watch-stopped asks in Later but keep them in the badge. The badge and the visible
  list would disagree.

**3. Should a pin expire?**
- **A. No (recommended).** It stays until the human brings it back or the ask ends. Later shows
  its count and each pin's age, so it cannot be forgotten silently.
- B. Yes, after 7 days it returns to Needs you on its own.
- C. No pins at all: offer a longer snooze ("Next month") instead.

**4. With the setting off, what happens to pins?**
- **A. Hide the Pin control; show existing pins in a "pinned" fold (recommended).** Nothing is
  hidden, and turning the setting off does not reshuffle asks the human already set aside.
- B. Keep the Pin control; pins show in the pinned fold. Off then only merges or splits the
  folds.
- C. Ignore pins: show them in Needs you and count them. This needs the setting stored on the
  server so the dock agrees, which §8 rejects.
