---
paths:
  - "public/app.js"
  - "public/poll.js"
  - "public/drafts.js"
  - "public/selection.js"
  - "public/copy-on-select.js"
  - "public/keyboard-ui.js"
  - "public/esc.js"
  - "public/structured-copy.js"
  - "public/messages.js"
applyTo: "public/app.js,public/poll.js,public/drafts.js,public/selection.js,public/copy-on-select.js,public/keyboard-ui.js,public/esc.js,public/structured-copy.js,public/messages.js"
---

# Viewer frontend: poll, render, drafts, focus and selection

The 3-second poll, the two render entries, the idle frame (#298), drafts (#279), and the focus, scroll and selection guards.

Moved out of `CLAUDE.md` and `.github/copilot-instructions.md` by #379, nearly verbatim. Claude Code and Copilot CLI load this file automatically when they read or edit a file matching the `paths`/`applyTo` globs above (through the symlinks in `.claude/rules/` and `.github/instructions/`); anyone else should read it before changing those files.

## In brief

- All agent-authored text interpolated into HTML must pass through `esc()`.
  Supplied URLs additionally pass through `safeHttpUrl()` in
  `public/source.js`; build anchors through the existing `chipHtml()` path.
- The 3-second poll uses the gated `load()`/`renderIfIdle()` path. Its reads
  run concurrently, but a tick applies only after all settle, and only if no newer
  tick has applied and every boot marker agrees. A successful
  human-initiated write must end in `reloadAndPaint()` so an unrelated draft
  cannot hide the result. A held pointer defers rendering but is not a
  suspension and must not appear in `suspendState()`.
- An idle tick paints nothing (#298): `load()` skips `renderIfIdle()` only when
  `pollMaySkipPaint` (`public/poll.js`) finds the frame on screen was painted
  from exactly this tick's `frameInputs()` (each snapshot's identical
  representation, the archived brief and, while read, the complete list or its
  error (#299), the fresh reads' displayed bytes, boot marker, history window, closed
  set, lens, human input and settled writes since, and the out-of-poll state
  render reads), nothing is deferred (`renderDirty`), and it is under 30 s old.
  Activity compares without its `updated_at` heartbeat (`activityFrameKey`),
  and a frame whose `navigationKey()` (tab, project, agent, Settings) moved
  while it painted is not recorded. The 30 s clock repaints every
  clock-derived label, so a visible window can lag the dock badge by up to
  ~33 s on clock-only changes; focusing the window repaints on the next tick
  (within 3 s), and a notification click at once only when it deep-links one
  item. Any state render reads that changes outside a paint must join
  `frameInputs()`.
- A text selection is captured before and restored after each rebuild by both
  render entries (`public/selection.js`, #223). It never defers or suspends a
  frame, never focuses or scrolls, and is dropped when its text changed.
  Copy text when selected (#222) is an opt-in setting that copies only a
  selection changed by the gesture, outside editors, through structured-copy's
  `writeClipboard`; it never stops or prevents an event.
- Unsent drafts (#279) are mirrored into this profile's `localStorage`
  (`agent-inbox-drafts-v1`) through the pure `public/drafts.js`, never to the
  server, the hub database or an agent. The window's memory stays authoritative:
  a save writes only what changed, so a successful send, Clear or an emptied
  editor deletes the stored copy and a refused send keeps it. Restoring happens
  once in the first applied `load()`: an unchanged target in an open project gets
  its draft back in its editor; anything else goes to the unsent responses with a
  reason, "not confirmed" once a send of it was tried and its target moved.
  Nothing is ever sent, focused or switched for the human. Question drafts pin the
  question's answer, not `response_revision`; each reply intent carries its own
  pin. One rule, `savedIntentRule`, decides every reuse of a saved intent (Retry,
  an editor's Send after an unconfirmed send): the server holds exactly that
  response, so it retires unsent; the answer moved since the pin, so the send is
  fresh; otherwise the exact replay. Never move a pin while keeping its intent. The
  rule reads the last poll, so the reply route also says, additively, whether a
  request `wrote`, whether it `replayed` a recorded intent, and the `answer` it left
  (#322); `ok` keeps its meaning. A replay that wrote nothing under someone else's
  answer keeps the text as an unsent response, with its spent intent dropped. An
  editor's Send and an unsent response's Retry never replace an answer the surface
  has not shown (#321): the first click names it in place ("A newer reply was sent:
  …"), only a further click sends, and the send carries `expect_answer`, which
  `replyItem` checks in the same conditioned UPDATE, refusing with `reason:
  'answer_changed'` and the answer that stands. A question with no answer accepts
  any expectation, and a refusal naming exactly the sent response retires it as
  sent. Never send to get past a notice. A
  window deletes only the copy it loaded or last wrote, and its leaving save
  writes back a draft another window deleted; the viewer-restart hold stays.
- Messages to a running session (#411 PR 2) are written in one composer per
  session, in the Live drawer and the Dashboard session focus panel, and read
  from `/api/messages`, the poll's ninth read (a 404, error or refused body is no
  messages). Each composer is one node kept for the page's life and updated in
  place; the drawer, now painted by the ambient painter, is left as it is while a
  composer in it holds focus. A send claims an id once and reuses it while its
  text is unchanged, so a retry never sends twice. Message drafts are durable
  (`type: 'message'`) and never pause the list; only a send in flight or a composer
  in use holds a viewer restart's reload. The drawer rebuilds on a poll only when
  what it draws changed (`liveDrawKey`).
  Nothing about messages reaches attention, a badge, a count or the dock.

## Invariants in detail

- **Messages to a running session are presence, written in one kept node (issue #411,
  PR 2).** Design: [`docs/superpowers/specs/2026-10-30-session-messages-design.md`](../superpowers/specs/2026-10-30-session-messages-design.md)
  §5 and §12. `public/messages.js` is pure: the delivery state (`deliveryState`, three
  states from the session's `/api/activity` flags, `activity-and-live.md`), each
  message's status line (sent, picked up, acknowledged with its outcome, withdrawn, or
  "Withdrawn after pickup: it may have started"), one session's history (newest
  first, five shown, "+N earlier") and the "Not delivered" list. `app.js` mounts
  `composerEl(where, session)`: a labelled textarea, a counter, Send (and, in the
  drawer, Cancel, which closes and keeps the text, like Esc), the delivery line, the
  sharing line ("Any agent of this session, a subagent included, may pick it up
  first."), a `role="status"` slot and the history. Each is ONE node per
  (`drawer`|`focus`, session) kept in `composerEls` and updated in place
  (`updateComposer`, written only on a change, so an unchanged paint writes nothing);
  the two hosts share one draft per session. The Live drawer moved from the editable
  surfaces to `paintAmbient()` (so a status moves under an unrelated draft); its
  rebuild re-attaches the same composer nodes. A poll rebuilds it only when what it
  draws changed: `liveDrawKey` (the rows as `activityFrameKey` compares them, the open
  entries and composers, `messageVersion`, the minute, `liveVersion` and the theme)
  or the identity of the messages snapshot; otherwise, and whenever focus is in a
  drawer composer (remembered focus in a background window counts), it only updates
  the composers, so an unrelated draft's ticks never disturb focus, hover or scroll
  in it. A rebuild, forced or not, keeps the drawer's `scrollTop`, and gives focus
  back, the composer's caret included, only when the window had focus before it (a
  detached node takes the focus with it): a composer node is refocused as itself,
  any other control by its `data-live-focus` identity, matched by value.
  `messageVersion` is deliberately not in `frameInputs()`: every message change comes
  from human input or a settled write (both already count), the first load's restore
  or `reconcileMessageDrafts` inside a paint. The focus panel's composer is its own section
  (`.dash-focus-message`), never rewritten by `setFocusPart`. A drawer entry's
  Message button (`data-msg-open`, read back through `dataset`, never a selector)
  opens its composer, opening the idle fold for an idle session; an explicit open
  focuses the textarea, nothing passive does. ⌘/Ctrl+Enter sends; Esc in the drawer
  closes the composer, keeps the draft and returns focus to its button when the
  window has focus; Esc in the focus panel closes the panel. The Agents view's
  Message button calls the injected `openMessage(session)`: the drawer, that
  composer open and focused. A send claims `{ id, text }` (`claimMessageIntent`),
  stored before the POST, and reuses the id while the text is unchanged, so a retry
  after an unconfirmed send replays exactly; a refusal (`session_gone`,
  `session_cannot_receive`, `too_many_open`, `too_much_open`, `id_conflict`) drops
  the intent and keeps the text with its reason; an unconfirmed send keeps both and
  says "Your send was not confirmed. Send again: it will not send twice." Every
  applied frame `reconcileMessageDrafts()` retires a draft whose intent the snapshot
  holds with the same text (it did land) and moves one whose session is no longer
  listed, or cannot receive, to the unsent responses (`messageRecoveries`), whose
  Retry reuses the id the same way. Withdraw posts the revision the history showed.
  Every write ends in `reloadAndPaint()`, and `messageVersion` is in `frameInputs()`.
  The "Not delivered (N)" fold ends the drawer: every open message whose session is
  no longer listed (global, not lens-filtered), newest first, ten shown and "+M
  more", each with Copy text and Withdraw, until withdrawn or a later send's 30-day
  prune deletes it; the clock never changes it and the Live strip names nothing.
  Drafts (#279): `type: 'message'`, key `message:<session>`, with `intent`; one in the
  unsent responses carries a `reason` and is stored as `message-recovery:<session>`,
  so a new draft to the same session never overwrites it. They share
  `agent-inbox-drafts-v1`, so a build older than #411 sharing the profile drops only
  the `message` entries on its next write (the exception `drafts.js` names). A
  restored draft for a listed session that can receive goes back to its composer,
  opening and focusing nothing (an unconfirmed intent says so); one the snapshot holds
  retires; any other goes to the unsent responses. A waiting one whose session is
  listed and can receive again goes back to its composer unless that holds a draft;
  then both stay, each under its key. A closed composer holding text marks its button
  "Message · draft". Only a send in flight or a composer in use (focus inside it)
  holds a viewer restart's reload (`hasUnsentResponses`); a stored draft does not, as
  it comes back after the reload. None of it is in `suspendState()`, so it never
  pauses the list. Agent and human text go through `esc()`/`textContent`; an outcome is
  agent text and goes through `renderStructuredText`. No animation. Nothing here
  reaches `public/attention.js`, `relay.js`, `reply-watch.cjs`, a badge, a count,
  the rail or the dock: `test/dom/session-messages.test.ts` compares every attention
  surface with and without messages, a draft, a send, a delivery and an ack.

- **Viewer escapes all agent-authored text.** `public/app.js` runs every interpolated field
  (item title/detail/annotation/project/stream/agent, board title/meta, row label/note/
  annotation) through `esc()` before `innerHTML`. Keep it — flags and boards are
  attacker-influenced text. **`esc()` is not enough for a URL:** it does nothing about
  `javascript:`, and issue #30 introduced the first anchors this product builds from supplied
  text (PR titles are third-party network text). Every href is constructed in ONE place,
  `chipHtml()` in `public/source.js`, through `esc(safeHttpUrl(...))` — a URL that does not
  survive `safeHttpUrl` renders as a `<span>`. Do not build an anchor anywhere else.
- **`load()` is the poll's; `reloadAndPaint()` is the human's (issues #38/#39).** `load()` ends in
  `renderIfIdle()` — the spec §10 gate. `suspendState()` reports every typed draft anywhere in the
  app, but NOT a merely expanded card. Expanded cards, the open inspector's scroll offset, and
  its focused control survive rebuilds; order pinning appends new work at the foot; the press
  guard protects clicks. A draft gates only the editable surfaces:
  `paintAmbient()` still refreshes the document-title badge, project rail, tab counts and global
  Live strip before `shouldDeferRender()` returns. A held press is different: `pressHeld()` runs
  before `paintAmbient()` because the rail itself can rebuild, so the press guard still defers
  every surface. A handler that ends a successful POST with a bare `load()` still asks the gate
  for permission to show the human the editable result of their own click, and one unrelated
  draft can refuse it indefinitely.
  Hover is never a gate either: existing order is pinned and new work appends at the foot, so
  leaving the pointer over Needs-you cannot hide an arrival.
  Every human-initiated write therefore ends in `reloadAndPaint()` (`await load()` then
  `forceRender()`); the ONLY un-painted callers are the boot call and `setInterval(load, 3000)`.
  There are exactly **two entries into `render()`** — `renderIfIdle` (with the ambient frame it
  already prepared) and `forceRender` (a full fresh frame) — because `forceRender` is also the
  only thing that clears `renderDirty` and refreshes `#pauseHint`; a direct `render()` leaves that
  hint claiming "paused" over data already on screen. Pinned in `test/shell.test.ts` +
  `test/issue-31-followups.test.ts`; the behavioural half (including both the protected draft and
  live ambient signals) is `test/dom/silent-send.test.ts`.
  Nested Background disclosures are keyed by item/row id in `openContexts`; a poll or forced
  rebuild must restore their `open` state instead of collapsing text under the reader.
  Passive polls retain inactive Notes, History and Plans DOM, but not their data:
  the action/recovery queue, ambient signals and visible overlays still refresh.
  Boot, library navigation and successful human writes use the existing complete
  forced paint. Keep active-board tracking outside the skipped Plans painter and
  mark notes read only when Notes is actually visible, not while Settings retains
  that tab identity. Deep-link and render-time recovery must preserve their
  explicit/deferred repaint ownership rather than recursively entering render.
- **A viewer restart must not discard unsent responses.** A changed `x-inbox-boot`
  schedules a coherent frontend reload, but `load()` defers it while drafts, recovery
  entries, response handlers, outstanding writes, staged undo actions, or bounded
  pointer/scroll activity remain. The existing frontend keeps polling and updating
  ambient attention during that hold. Once protected work clears, an ordinary poll
  reloads exactly once; drafts are never automatically sent to make refresh possible.
  Every response of a tick carries its server's marker; markers that disagree within
  one tick mean a restart landed between two reads, so that tick counts as a restart
  and is never applied, because it would mix two servers' data.
  The quiet status hint explains an unsent-work hold without labeling an in-flight
  write or pointer interaction as a human blocker. Failed staged choices use the same
  exact-intent recovery path as other replies. The hold stays although drafts are now
  durable (#279, next bullet): it also protects in-flight writes, staged undo actions
  and the editor under the human's cursor, which stored text alone cannot.
  `test/dom/viewer-restart.test.ts` pins the draft, revision, in-flight, and undo boundaries.
- **Unsent drafts survive a reload, a window close and an app restart (#279).** Every
  unsent response the window holds (question answers and their context, plan-row
  drafts, Note attempts and the unsent responses list) is mirrored into this
  profile's `localStorage` under `agent-inbox-drafts-v1`, never to the viewer server,
  the hub database or an agent. `public/drafts.js` is pure: it validates every entry
  (an unreadable or unknown one is dropped, never thrown) and merges one window's
  changes into what the profile holds. The window's memory stays the source of truth:
  `saveDrafts()` writes only what changed since this window last loaded or wrote each
  key, so an emptied editor, a successful send (JSON `ok:true`), Clear and every
  deliberate discard delete the stored copy, and a refused send keeps it as an unsent
  response. A save is queued from `showPauseHint()`, which every draft change reaches,
  and lands within 300 ms. The leaving saves (`pagehide`, `beforeunload`,
  `visibilitychange` to hidden) also write back every draft the window still holds
  whose key storage lost: another window sent or cleared it, no newer copy exists, and
  the text on this screen would otherwise go with it. A routine save leaves that
  delete alone, and a draft whose own last write has expired is let go. Each entry
  carries what it was written against: a question draft the question's answer as of
  the last edit (`replied_at`, source, kind and text, never `response_revision`, which
  the human's own Note also moves), a row draft its row and board ids and revisions,
  its action version and whether its send was still unanswered, and any reply intent
  its claiming client id and its pin, the answer as it stood when the intent was
  claimed. The pin travels on the intent, so nothing can move it while the intent is
  kept, and a fresh intent brings its own. The tab's
  reply identity itself stays in `sessionStorage`: shared, two windows would merge
  their counters and refuse each other's newer replies. Restoring happens once, in the
  first applied `load()` before its `renderIfIdle()` (`placeRestoredDrafts`; a row
  draft whose row no active plan holds may wait for the complete archived plans,
  #299 in `store-and-snapshots.md`), and sends
  nothing, focuses nothing and switches no tab. A draft whose target is unchanged and
  whose project is open goes back to its editor, the newest one in the queue reopens
  its card when none is open, a Plans-only row reopens its panel, and the next queue
  render opens any fold holding a restored draft once. Anything else goes to the
  unsent responses, which never pause the list and show in every project view, with a
  stored `reason`: "this question changed", "this question is closed or no longer
  available", "this action changed", "Kept because this project is closed", or #272's
  set-aside reason only when it was recorded. Once a send of the text was tried and
  never answered (a reply intent, or a row send still in flight), the reason says
  "Your send was not confirmed", never "not sent": the write may have landed. A draft
  whose exact text the server already holds is dropped. **One rule decides every reuse
  of a saved reply intent** (`savedIntentRule`, called by `submitItemReply` for an
  unsent response's Retry and for an editor's Send after an unconfirmed send, so for
  every intent a restart brings back too; the restore only uses it to word a reason):
  the server holds exactly that response (text, context and kind), so the entry or
  draft retires without a send; else the answer moved since the intent's pin, so a
  replay would be answered from the server's intent record without writing anything
  and the send is fresh, with a new intent and pin; else the exact replay, which keeps
  it idempotent. This deliberately reverses the older contract that a re-send after an
  ambiguous failure never overwrites a later answer: once the answer moved, the
  human's own Send or Retry writes, as any other Send would. The rule reads the last
  snapshot, so within one poll (3 s) of another writer it can still replay. *(#322)*
  The reply route therefore says what each request did, additively: `wrote` (this
  request changed the question), `replayed` (the store already held its intent, so
  it wrote nothing) and `answer`, the question's answer once it was done
  (`replied_at`, source, kind, text and context, in the item's field names; read
  inside the intent's `.immediate()` transaction, and just after the write without
  one). `ok` keeps its meaning, so an older page sees what it always did, and a page
  that finds no report keeps the old reading. When a replay wrote nothing and that
  answer is not the response it sent, the text was replaced after it landed: it is
  kept as an unsent response, "Your send went through, but this question's answer
  has changed since.", from the Retry's own entry, the entry its in-flight draft
  moved to, or the editor (an editor typed in since keeps its newer text), and the
  spent intent goes with it, so its Retry is fresh. `replyItem` stays the same
  conditioned statements; the report adds reads, never a write. *(#321)* A send from
  an answer editor or an unsent response replaces the question's answer, so it never
  replaces one the surface has not shown. Each surface knows the answer it was drawn
  with (`shown`: the editor's item, the line's answer at render) and the newest answer
  the window knows (`knownAnswer`: the last poll, or a reply response's report until a
  poll that started after it applies; derived state, the snapshot is never changed).
  When that answer is a reply or response kind (a cleared question has nothing to
  replace) that the surface has neither been drawn with nor named in a notice, the
  click sends nothing: it names it in place, "A newer reply was sent: “…”. Send (or
  Retry) replaces it.", in the editor's `.write-error` slot (now `role="status"`) or
  the line's `.replace-notice`, and only a further click sends. An unsent response's
  line names it as it is drawn whenever its Retry would be fresh over an answer, which
  is also how a restored "not confirmed" entry says what Retry does. When the answer
  is one this window sent (`sentReplies`, last five per question), the notice says
  "Your earlier send went through" instead. The send then carries `expect_answer`
  (`replied_at`, `reply_source`, `reply_kind`, `reply`), and `replyItem` writes only
  while the question still holds it, or holds no answer at all (a clear moves
  `replied_at`, yet leaves nothing to replace): one more condition in the same UPDATE,
  so a reply that landed after the window last looked refuses it with `reason:
  'answer_changed'` and the answer that stands (a 200, like every refusal), the
  refused intent recorded as not applied. The text stays where it is with that answer
  named (an entry keeps it, dropping the spent intent, and its line keeps focus on the
  same control across the rebuild); the editor never moves. A refusal whose standing
  answer is exactly this response (a double click's first send landed first) retires
  it as a success would, with no notice. A new intent pins `knownAnswer`, the answer
  `savedIntentRule` compares it with. A reply without `expect_answer` (an older
  page, an option pick, the star, a notification) stays unconditional. Never send on
  the human's behalf to get past a notice. A Retry
  of an entry an earlier click already took does nothing, so a double click claims no
  second intent. `renderIfIdle()` paints the first editable frame even with
  restored drafts, since no editor exists yet to protect; every later tick pauses
  exactly as for a typed draft. Bounds, applied on every read and write: 30 days since
  the last write, 100 entries and 200,000 characters, oldest evicted first; a refused
  write (a full profile) is retried once within 50,000 characters, then the drafts
  stay in memory without an alarm. A stamp from the future (the clock was set back)
  counts as now, and any write re-stamps it, so it can be overwritten and expires.
  Two windows on one profile: per key the latest write wins, a window deletes only the
  copy it loaded or last wrote (compare-and-delete on `savedAt`) and never an entry it
  was not told about, and after a write it knows only what storage then holds exactly
  as it holds it. There is no `storage`-event sync, so another window's newer draft
  appears on this window's next load, and two windows editing one target each keep
  their own text on screen. Electron commits DOM storage in `will-quit`
  (`session.defaultSession.flushStorageData()`), after every window has closed and
  run its `pagehide` save. Not covered: a crash within the 300 ms before a save or
  before Chromium commits it, another browser or profile, the viewer opened at its
  other address (`localhost` and `127.0.0.1` are separate origins), a private window,
  and clearing site data. `test/drafts.test.ts` and `test/dom/durable-drafts.test.ts`
  pin it; the DOM file removes a closed page's unload listeners itself, because jsdom
  keeps every boot's on one window.
- **An unsent response holds the Review queue back only when the deck would ask for
  the same thing, and says so (#407).** The hold (bbc3d886) keeps an unsent response
  from being hidden behind a deck that offers a second editor for its target; a row
  recovery on the row's current revision is even copied into the deck's own editor.
  `heldDraftRecoveries(deck)` is the one rule, read by `openTriage` over the deck it
  is about to open: a question recovery or an unconfirmed Note attempt whose question
  is in the deck, and a row recovery whose row is in the deck on the same action (the
  same revision, or the same `action_version` when the entry recorded one). Anything
  else (a closed, gone or since-advanced target) stays in the unsent responses and
  the queue opens over it. `hasDraftRecovery()` still guards the viewer-restart
  reload, which protects every entry. A held queue never moves focus to the
  off-screen fold: every door (the Dashboard rail's button, the Inbox toolbar's
  button and `t`) switches to the Inbox and writes "Finish or clear the N unsent
  response(s) first." into the Needs-you header's polite `role="status"` region,
  with a Show control that focuses it. That header node is never rebuilt, so
  `paintTriageHold()` writes it in place (Clear calls it too, even while the list's
  rebuild is held back); `triageHeld` is in `frameInputs()` and ends when the queue
  opens, the held entries are gone or the human leaves the Inbox. Show is an
  explicit navigation: it opens the row (`requestDraftRecovery(target)`) for an
  inline recovery, then `revealDetailsAncestors`, `revealControl` and a
  `motion.scrollBehavior()` scroll of the in-flow row or line, and focuses the
  editor or the line (`tabIndex = -1`, kept across rebuilds by the recovery focus
  bookmark). The fold says what its buttons do ("Retry sends a response again;
  Clear discards it for good.", or the Clear half when no entry can retry). Nothing
  here reaches attention, a badge or the dock. `test/dom/review-queue-hold.test.ts`
  and `review-queue-hold-key.test.ts` pin it.
- **An idle tick paints nothing, and the clock still moves (#298).** Rebuilding
  an unchanged page every 3 s cost about 1.3% renderer and 1.5% GPU CPU at idle.
  `load()` calls `renderIfIdle()` unless `pollMaySkipPaint` (`public/poll.js`)
  finds that the last COMPLETE frame (`paintedFrame`, written at the end of
  `render()` and cleared at its start, so a frame that threw is never reused)
  was painted from exactly this tick's `frameInputs()`, nothing is deferred
  (`renderDirty`) and the frame is under `CLOCK_REPAINT_MS` (30 s) old. Inputs
  compare by `Object.is`: a 304 resolves to the very representation it
  revalidated, so each snapshot is its identity, the closed set is its bytes,
  `/api/activity` is `activityFrameKey` (its bytes without `updated_at`, the
  liveness heartbeat nothing displays, kept only for a row with no other
  activity time), the archived brief and, while read, the complete list or its
  error are snapshots too (#299), fallback bodies are reduced to what they mean, and the
  boot markers, activity-history URL, lens (`navigationKey()`, `openRowId`) are
  values. This window's own state is covered by `outsideChanges`, bumped by any
  human input (pointerdown, click, keydown, input, change, focus, resize,
  visibility) and every settled write, so the next tick paints exactly as it did
  before; state answered by other reads after the input that asked for it
  (`liveVersion`, `fileLinksCopy()`, `linkFileActions()`) is named directly.
  **Adding render-read state that changes outside a paint means adding it to
  `frameInputs()`**, or it waits up to 30 s. The clock is fixed rather than
  computed per label: relative ages are minute-granular and every threshold
  (stale, snooze, follow-up, issue freshness, dormancy) is minutes or longer, so
  30 s bounds each one without enumerating them; a clock moved back repaints.
  A frame whose `navigationKey()` (tab, project, agent, Settings) moved while it
  painted, as draft recovery inside `render()` can do, is not recorded, so the
  next tick paints it again. A move of the open row alone is recorded: it is
  made by `setOpenRow` before the panes paint, so the frame already shows it.
  **The visible window can lag the dock badge by up to ~33 s** for clock-only
  changes (a snooze ending, the 72 h stale move): Electron main recomputes
  attention every 3 s, while the page waits for its clock. Focusing the window
  counts as input, so the next tick (within 3 s) repaints; a notification
  click repaints at once only when it deep-links one item and so changes the
  hash.
  The skip lives inside the poll path: no third render entry, `forceRender`,
  `reloadAndPaint()`, `resumeRender()` and direct `renderIfIdle()` callers paint
  as before, and restart detection, `loadGeneration` and the all-settle rule run
  before it. `test/dom/idle-frame.test.ts` pins it (one case per guard) and
  `pollMaySkipPaint` is unit-tested in `test/poll.test.ts`. A test of what a
  rebuild preserves or holds back must give the tick something to paint
  (the harness's `changedPollTick(db)`, or fresh data as press-guard and
  page-scroll insert), never rely on a `.focus()` counting as input.
- **Remembered DOM focus is not keyboard ownership.** A blurred tab or embedded viewer
  keeps its last `document.activeElement`. Passive polling must capture focus bookmarks
  only while `document.hasFocus()` is true, before replacing DOM; otherwise restoring a
  card, plan, or project control can steal focus from the host chat composer or another
  application. Remembered focus does not keep a search in use either: `historyWanted()`
  checks `activeFocusElement()`, so a query left in a background window's search box
  does not keep re-reading closed history (#233). Background data/ambient updates still
  run. Explicit user navigation can focus its destination, and an active viewer must
  retain its logical focused control across rebuilds.
  `test/dom/background-focus.test.ts` covers the background and
  foreground halves. In jsdom, a control's `.blur()` also makes `hasFocus()` false;
  tests modeling CSS hiding a control in an active window must explicitly retain
  document focus rather than accidentally model a background webview. Conversely, a
  test modeling a background window keeps `activeElement` by stubbing `hasFocus()` and
  dispatching `blur`/`focusout`, never by calling `.blur()` (#233).
- **A held pointer defers the rebuild, and it is NOT a suspension (#38 / D2).** The 3s render
  detaches the node under the cursor, so `pointerdown`/`pointerup` share no ancestor and the
  browser dispatches **no click at all** (measured in Chrome: ~1 in 24 at human hold times, on
  every surface). `initPressGuard` records `pressedAt`; `shouldDeferRender` (in `public/poll.js`)
  ORs it with the §10 suspension. Keep `pressedAt` **out of** `suspendState()`/`suspendReason()`
  — a press loses nothing, so lighting `#pauseHint` for it would be a new lie — and keep it a
  **timestamp**, never a flag: bounded by `PRESS_GRACE_MS`, it self-heals when a release event
  is missed. Never gate the render on `openRows` instead: it is unbounded, never pruned, and
  would resurrect the C1 freeze on the tab the badge counts. That last sentence is the design's
  explicitly rejected option and the easiest thing in the file to "clean up", so it is pinned
  twice: a source pin on `suspendState()` in `test/shell.test.ts`, and the freeze itself —
  expand one matrix row, watch the list, badge and `#pauseHint` stop — in
  `test/dom/press-guard.test.ts`.
- **Active inspector or page scrolling defers only the editable rebuild.** Restoring `scrollTop` after
  replacing `.nrow-card` preserves coordinates but still cancels Chromium's in-flight
  wheel/trackpad momentum, which presents as an intermittent freeze at the 3-second poll boundary.
  The card and window scroll guards update `lastInteractionScrollAt`, while the card also updates
  `openRowScrollTop`; `shouldDeferRender()` holds the editable frame for the bounded
  `SCROLL_IDLE_MS` window, while `paintAmbient()` still refreshes badges, counts, the rail, and
  Live. A resettable timer calls `resumeRender()` as soon as movement settles, so a deferred frame
  does not wait for another poll. Keep scroll activity out of `suspendState()`/`suspendHint()`:
  it is a brief interaction guard, not a user-visible pause, and it must reset when the open item
  changes. A settled rebuild anchors the open row's in-flow `.nrow` viewport position before and
  after replacement, then corrects only the measured delta; anchoring `.nrow-card` would be inert
  in the desktop fixed-inspector layout. Restore queue scroll geometry only after shortcut
  decoration and initial editor sizing: restoring sooner clamps the phone footer's saved
  offset to a temporarily smaller range and hides its focused action. The initial editor
  animation frame must not repeat an already-completed sizing pass and clamp it again.
  The deferred restoration belongs to the same open-row owner that captured it.
  `test/dom/inspector-scroll.test.ts` and
  `test/dom/page-scroll.test.ts` pin the momentum, viewport, position, and focus contracts.
  Independently scrolling inspectors, disclosures, drawers, and overlay bodies use
  `overscroll-behavior: contain` so exhausted wheel/trackpad input cannot chain to the page beneath.
  The compact project menu is a vertically contained popover at every narrow width, so its
  exhausted scroll cannot move the workspace behind it.
- **Explicit keyboard traversal reveals its target; passive restoration does not.**
  Tab/Shift+Tab inside an action card or dialog focuses with `preventScroll`, then
  reveals the target through intentional scrolling ancestors inside that scope.
  Do not scroll the phone card's overflow-hidden shell or background, and do not
  reuse this explicit-navigation behavior for passive poll focus restoration.
  `test/dom/explicit-tab-scroll.test.ts` covers the separation; real browser
  geometry is still required to confirm narrow-footer visibility across rebuilds.
- **A text selection is restored across rebuilds, never held (#223).** A rebuild
  detaches the nodes a selection lives in, and a live range collapses onto their
  parent, so the 3s poll used to erase every highlight within one tick. Both render
  entries capture a non-collapsed selection before anything repaints (`renderIfIdle`
  before `paintAmbient()`, carried on the prepared frame; `forceRender`'s `render()`
  before its own ambient frame) and restore it after `restoreQueueView()`, and on the
  deferred-frame branch after the ambient painters. `public/selection.js` records each
  boundary as a path from the nearest element with an `id` (or `<body>`); a step into
  an element carrying a data identity (`data-card-id`, `data-row-id`,
  `data-context-key`, …) matches that identity and ordinal, not its position, so rows
  leaving or arriving above keep it. The range is reapplied with `setBaseAndExtent`
  (direction kept) only when it spells the same DOM text; otherwise it is dropped with
  `removeAllRanges()`, so a half-rebuilt range is never left stretched over new text.
  An untouched selection is left alone. Restoring calls no `focus()` and never
  scrolls, so it cannot steal focus from a background viewer. It is NOT a render gate
  or a suspension: nothing reads it in `shouldDeferRender()`, `suspendState()` or
  `#pauseHint`, so a selection held for minutes cannot freeze anything (the C1
  lesson), and paintAmbient keeps running. Text in a reply box or other focused field
  is never captured: drafts and their focus bookmarks own it. For the same reason a
  restore leaves the selection alone when the repaint itself focused a text field
  (Change answer, draft recovery): Chromium moves the selection into a field on
  focus, and re-applying the old highlight would leave that field with no caret.
  `test/dom/text-selection.test.ts` pins survival, both drops, ambient refresh, the
  no-freeze run, focus/scroll neutrality and the focused reply box.
- **Copy text when selected is opt-in and owns no event (#222).** Off by default
  (`agent-inbox-copy-on-select` in localStorage; Settings → Copying).
  `public/copy-on-select.js` copies when a primary-button gesture ends (judged one
  task after mouseup) or a keyboard burst settles (400 ms after the last keyup), and
  only if the selection changed during it: `sameSelection()` compares bookmarks, not
  nodes, so a #223 restore is the same selection, and a `selectionchange` counts unless
  it is the restore's own (`isRestoredSelection()`), which also catches the same range
  dragged over again. A newer gesture, a window blur or turning the setting off
  supersedes an unfinished one, so a double-click copies once. The text is
  `getSelection().toString()` with NBSP written as a space (what Cmd+C puts on the
  clipboard), sent through structured-copy's `writeClipboard` (Clipboard API, then the
  selection-preserving fallback); no IPC channel carries it. Focused fields and
  editable content are excluded. Its status region rewrites only on a change, so
  repeats inside its 1.6 s window are not re-announced. Listeners bind once per
  document and never prevent a default or stop propagation: clicks, the press guard
  and attention are unchanged. `test/dom/copy-on-select.test.ts` pins each rule.
