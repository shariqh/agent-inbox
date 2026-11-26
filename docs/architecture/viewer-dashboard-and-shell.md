---
paths:
  - "public/dashboard.js"
  - "public/ribbon.js"
  - "public/lanes.js"
  - "public/plans-lane.js"
  - "public/motion.js"
  - "public/style.css"
  - "public/layout.js"
  - "public/panes.js"
  - "public/tabs.js"
  - "public/search.js"
  - "public/search-index.js"
  - "public/index.html"
  - "public/theme.js"
  - "public/theme-bootstrap.js"
applyTo: "public/dashboard.js,public/ribbon.js,public/lanes.js,public/plans-lane.js,public/motion.js,public/style.css,public/layout.js,public/panes.js,public/tabs.js,public/search.js,public/search-index.js,public/index.html,public/theme.js,public/theme-bootstrap.js"
---

# Viewer dashboard, Agents home and shell

Home (UX pass, slice 2: the Inbox page folded into the Dashboard), the Dashboard 2.0 surfaces (#302–#307), the Agents home (#454, since the dashboard lanes PR 4 the Working and Quiet lanes), the editorial desk shell, layout and search, and the attention-first cold launch.

Moved out of `CLAUDE.md` and `.github/copilot-instructions.md` by #379, nearly verbatim. Claude Code and Copilot CLI load this file automatically when they read or edit a file matching the `paths`/`applyTo` globs above (through the symlinks in `.claude/rules/` and `.github/instructions/`); anyone else should read it before changing those files.

## In brief

- Type and spacing come from the `--fs-*`, `--sp-*` and `--lane-gap` tokens in `:root` (table in
  `DESIGN.md` Typography); new CSS takes a token, not a literal size. The Dashboard's region
  headers (`.dashboard-card h2`) are `--fs-lane` at weight 650 and the grid's regions are
  `--lane-gap` apart; the `operations-desk` container under 900px sets `--fs-lane: 24px` and
  `--lane-gap: 40px` on `.dashboard-grid`. Pinned in `test/dashboard-tokens.test.ts`.
- **Home** (UX pass, slice 2) is one page: the tab `dashboard`, named Home with a house
  icon and the filter-blind attention count the Inbox tab carried (`tabCounts().dashboard`).
  There is no Inbox tab: `TAB_IDS` has no `needsYou`. Home shows two `main > .panel`
  sections together, `#needsYou` (the list of asks, `role="region"` labelled by
  `#needsYouTitle`) and then `#dashboard` (the lanes); DOM order is reading and Tab order,
  the asks first. `showPanel('dashboard')` shows both; every other tab and Settings hide
  both. The list stays outside `#dashboard`: the fixed card must stay out of the
  `operations-desk` size container, and the lanes' own focus bookkeeping
  (`dashboardFocusBookmark`) never sees a row. The internal names stay (`dashboard`, `needsYou`,
  `needsYouList`, `g.needsYou`). `PAGE_META.dashboard` is `{ kicker: '', title: 'Home' }`
  (an empty kicker is hidden) and is the fallback for an unknown id. Every way into the old
  Inbox tab lands on Home: `tabForItem`'s default, `openAskInInbox`, `holdTriage`,
  `requestDraftRecovery`, `keepDraftInView` (from a Review queue opened on another tab),
  `jumpToCard('dashboard', …)` for a relay row, and so a deep link, a notification, a search
  result, a relay link and a plan link to an open ask. `G D` reads Home; `G I` (command id
  `needsYou`, label Needs you, its tile on `#needsYouTitle`) selects Home, scrolls to the top
  and focuses the first operable row. The Needs you lane, its lane chips and the way back
  from an ask to the Dashboard (`jumpToAsk`, `dashReturn`) are gone: a session card's "Asking
  you · N" chip and ⌘K's "answer …" open the ask in front through `openAskInInbox`. New
  session… sits at the right end of the Working lane's head, its note (`p.ah-note`) right
  after that head; `.dash-since` is the first child of `.dashboard`.
- **The list's header is quiet** (slice 2). Its first line is `h2#needsYouTitle` "Needs you",
  `b.queue-count` (the asks in the list that still wait on the person under the lens and the
  filters, not the answered foot and not the folds; painted from `paintAmbient`, so it stays
  current while a frame is held; hidden at zero) and `button.queue-tools-toggle` "Filter"
  (`aria-expanded`, `aria-controls="queueTools"`). The filters, Sort, Handoffs and Review
  queue sit in one `div#queueTools.queue-tools` (`display: contents` while shown), hidden at
  rest: the toggle flips `queueToolsOpen` (in memory, false at start), and they show whatever
  the toggle says while `actionFilter !== 'all'`, `changedOnly` or `askSort !==
  savedAskSort()`. Using a filter or the Sort menu sets `queueToolsOpen`, so the tools never
  leave under the hand that used them. `.triage-hold` stays outside the wrapper. A hidden
  control is never a focus target: every path that focuses `.triage-btn`
  (`restoreTriageReturnFocus`, the hold line's fallbacks, a discarded recovery line) goes
  through `focusQueueControl`, and `holdTriage` and `keepDraftInView` call
  `showQueueTools()`. The calm line reads "Nothing needs you" (or "Nothing needs you · N in
  Later") and is one line on the page: it carries no count chips (`ambientChips` is gone; the
  plans, milestones and answered asks it counted are on the page under it or on Find).
- **Home's sections look alike** (slice 2). Needs you, Working, Quiet, Plans in progress,
  Just landed and Today share one quiet heading (`--fs-body`, soft text) and sit on the page
  itself, edge to edge with the list: `.dashboard .dashboard-card` has no border, padding or
  background, and `#dashboard` has no side padding. A project's sessions keep one small label
  line (`.ah-group-head`), and the projects sit side by side where there is room: `.ah-groups`
  is a wrapping flex row, each `.ah-group` takes an equal share of at least 340px, and its
  cards fill that share at every width (`.ah-cards` auto-fill, restated after the narrow
  block's two fixed columns). A wide overview shows three projects across, one busy project
  still spreads over the row, and the column beside an ask shows one. The gap between
  sections is `--lane-gap` set to `--sp-6` on `.dashboard-grid`, so the narrow window's
  session panel, which is placed against that variable, follows. The new-notes chip is as wide as its words.
- **The ask in front** (slice 2, wide windows only). `body.ask-front` is set exactly while
  `layout === 'wide'`, Home is showing (not under Settings) and a row is open and drawn in the
  list outside a closed fold; `syncAskFront()` keeps it, called from `setOpenRow` (the single
  writer of `openRowId`), `showPanel`, the layout change and the end of `render()`. Only with
  it do `#needsYouList` and `#dashboard` keep clear of the fixed card (`padding-right:
  calc(var(--inspector-width) + 28px)`) and does `#inspectorResize` show; without it the
  list and the lanes use the full width. Every lane stays drawn in the column beside the
  ask: the lanes' own container queries (`operations-desk`, `dash-lanes`) give them their
  narrow layouts there. The card's default width is 640px (`PANE_DEFAULTS.inspector`). One thing in
  front: opening a session panel (`openSessionFocus`, `jumpToSession`) closes the open row
  (`closeFrontAsk`), and opening a row by any path closes the session panel
  (`closeSessionPanelQuietly`, moving no focus); under 1280px both stay inline. Inside
  `render()`, after the list is painted and `reconcileOpenRow` has run, `bringAskToFront()`
  opens the first row drawn outside a closed fold whose ask is in `attentionEntries`, when
  the window is wide, Home is showing, no row and no session panel is open, no modal is (the
  Review queue, Handoffs, the plan flow and its step dialog, Settings, any visible
  `aria-modal` dialog) and the person has not closed the front: `selectedId` becomes that
  ask, `setOpenRow(id, { resume: false })`, and its card is mounted in the same frame from the
  model its row was drawn from (`rowBuilds`). It moves no focus (except that a keyboard user
  already in the list or the card lands on that row), scrolls nothing and writes nothing; it
  never runs while a frame is held, and never from the ambient painter. While the page is in
  use it waits (`lanesInUse`: focus rests inside `#dashboard`, or, on a poll's frame after the
  first, the pointer is over `#needsYou` or `#dashboard`), because an ask coming forward
  narrows the list and the lanes under whatever the person is using there:
  `frontWaitsOnLanes` joins `frameInputs()`, so the tick after they stop being in use paints
  and brings the ask forward even when it reads nothing new. Two exceptions: closing the
  session panel (`closeSessionFocus`), where the first waiting ask returns to the front at
  once with focus back on that session's card; and `steady`, where an ask was in front when
  the frame began and left the list, so the next one takes its place and nothing beside it
  moves. An open
  native `<dialog>` (New session…) counts as a modal here, although it carries no
  `aria-modal`. `frontClosed` turns
  true when the person closes the card on a wide window (its ✕ or Esc, `collapseRow(id, {
  explicit: true })`) and false when a row opens by any path (`setOpenRow` with an id), when
  Home is entered from another tab, and whenever a paint finds that nothing waits anywhere
  (the unlensed attention set is empty), so the next ask to arrive comes to the front. A lens
  or a filter that merely shows no waiting ask does not reset it: the ask the person closed
  does not come back on the way out of that lens.
- **Keys stay on their side of Home** (slice 2). The list and the lanes share the page, so
  while focus is inside `#dashboard` (a lane, a heading, the session panel) no key reaches
  the list's selected ask: `keyTargetItem()` answers nothing there, `keyboardActionScope()`
  is the focused `[data-panel-ask]` or nothing, and `runIntent`'s `move` and `expand` do
  nothing, and Esc does not count the ask in front as open (`expanded` is false there), so it
  neither closes it nor pulls focus and the page up to the list. So 1–4, E, X, J, K, Enter
  and Esc in the session panel act on the panel's own ask or on nothing, as they did when the
  list was on another page. A poll's frame also never moves
  focus out of the lanes (the draft and recovery focus restores are skipped there).
  `test/dom/ux-home-panel-keys.test.ts` pins this. When the ask in front leaves the list (resolved, dismissed,
  snoozed, pinned), the same `render()` brings the next one forward, so 1–4, R, E and X act on
  it; an answered ask keeps its row and its open card. The first click or Enter on an ask that
  came to the front by itself (`frontAutoId`) moves focus into its card, as opening any row
  does. When the window turns narrow, such an ask closes if the person has not touched it
  (no focus in its row, no unsent answer), so nobody gets an inline card or a phone sheet
  they did not open. `test/dom/ux-home.test.ts` and `test/dom/ux-home-keys.test.ts` pin Home.
- The Plans in progress lane (dashboard lanes PR 6, §3.5; `public/plans-lane.js`) follows Working
  and Quiet in the grid, then Just landed and the Today ribbon, each a full-width lane
  (`grid-column: 1 / -1` in one rule), the ribbon last. DOM order is page order, so Tab follows
  it; `test/dom/plans-lane.test.ts` pins the six regions' order. Its rows are
  `buildDashboard().plansInProgress`: `plansInProgress(visibleBoards)`, the lens's active plans
  (closed projects left out) with an open row (`isOpenRow`: neither done nor na). It reads
  nothing new. The numbers are `planBar`'s, the Working card's: done and countable are the
  server's `progress`, and "N need you" counts `isBlockedRowAttention` rows, so an answered ask
  is never pink. Plans with a waiting row come first, then the newest `updated_at`, then the
  id; while the pointer or keyboard focus is in the lane `pinLaneOrder` holds the order over
  every qualifying plan before `capPlans` shows six, as Needs you's does. A row is one
  `role="listitem"` with a roving tab stop and no control: a click or Enter calls `focusItem`
  (the plan's project as the lens, Plans, the card focused), and "All plans ›" calls
  `selectTab('boards')`, keeping the lens. It is painted from `renderDashboardAmbient`, so
  from both render entries; agent text is set with `textContent`, and only when it changed.
- Motion (#302, Dashboard 2.0 proposal §10) is CSS-only: keyframes animate only
  `transform` and `opacity`, transitions take `--motion-*` tokens, at most 12
  infinite animations are on screen (none for activity, which is one-shot per event, #304), and motion never moves focus, scrolls or
  reorders under the pointer. Every infinite-animation selector is listed with
  `animation: none !important` in the `@media (prefers-reduced-motion: reduce)`
  block (which also makes one-shots instant) and under
  `:root[data-motion="calm"]`; `test/motion-css.test.ts` checks both lists.
  `public/motion.js` sets `data-motion` (Settings → Motion: Full or Calm) and
  `data-page-hidden` (CSS pauses animations), and gives `scrollIntoView` its
  behaviour. The setting is layout only and never reaches attention.
- The session panel's Asking you section (#454 A.2) is the Dashboard's one answer surface;
  #454's PR 6 retired the Needs you rail (#303) that was before it, and the Working and
  Quiet lanes span the grid. A session card holds at most one copy of each ask (`sessions.js`)
  and only counts it ("Asking you · N"); the asks themselves are in Home's list.
  The panel lists the card's asks and mounts `answerEl`/`rowAnswerEl` (`surface: 'compact'`) and the shared
  `snoozeAsk`/`pinAsk`, so drafts join `suspendState()`, recovery, durable drafts and
  the restart hold, and `expect_answer` is unchanged. It paints in the ambient painter:
  a poll leaves the section alone while one of its asks holds a draft in use or a background
  window remembers focus in it within two minutes of the human's last input (#563), and `render()`'s `forcedAmbient` makes a human's
  `reloadAndPaint()` rebuild it anyway. It restores its own focus only while the
  document has focus.
- `buildLanes` in `public/lanes.js` (#304) reads only what the poll already makes: a
  session is working when its claim is not idle and its `last_call_at ?? started_at` is
  within 30 minutes (`isWorking`; `updated_at` is never read). #454 retired the lanes it
  once drew (and the Live footer strip and drawer), and the lanes PR 3 the Now strip it fed:
  sessions are the Working and Quiet lanes' cards and rows (the lane chips that counted them
  went with slice 2 of the UX pass). Activity motion is one-shot per real event, a pulse when
  `last_call_at` moves forward on a poll, never on first paint, an unchanged poll or a
  forced repaint, and only when `motion.activityMotion()` allows it (Full, no OS reduced
  motion, page visible); nothing infinite (a loop measured +5.6 pp renderer, +34 pp GPU
  CPU). Nothing reaches attention. A cancelled one-shot (`animationcancel`) drops its
  class like a finished one (#305).
- The Agents home (#454, design `docs/superpowers/specs/2026-11-04-agents-home-design.md`),
  since the dashboard lanes PR 4 (§3.3, §3.4) the **Working and Quiet lanes**, is the
  Dashboard's one home for sessions: `public/agents-home.js` paints both lanes into one
  `.agents-home` wrapper mounted once in the grid (`agentsHome.element()`), first in it
  and before Plans in progress, Just landed and the ribbon; the session panel sits after the
  wrapper, both inside `.dash-split` (dashboard lanes design §3.6).
  `laneOf`/`splitLanes` (`sessions.js`) put every main card in exactly one lane: Working when
  its base state is working (`isWorking`, or a running host turn, `isBusy`), Quiet otherwise;
  a card in a fold is in neither. Working groups its cards by project under a head (dot, name,
  "N sessions"; no group-by); a card's first button is **Open** (`openSession(key, 'head')`,
  routed before any launch action, launch cards included), then Message. Quiet is a
  `role="list"` table of `div.qt-row` rows with an `aria-hidden` header row (`.qt-head`): a
  list, so the narrow session panel can sit between rows; each row's `aria-label` names every
  column. Rows reuse the card's part classes (`sc-state`, `sc-agent`, `sc-branch`, `sc-doing`,
  `sc-when`, `sc-asking`, `sc-actions`) and `tone-*`, and keep each state's actions (an idle
  row Open and Message, with `messageHint` in Message's title; a parked one Take over and
  Resume…); fold cards keep theirs, with no Open. Cards and rows live in separate node maps,
  so a session that changes lane gets a node of its new lane's shape. Each lane pins its own
  order (`pinLaneOrder`, Working's project groups too) between forced paints, and holds it
  through a forced paint while the pointer (`pointerenter`/`pointerleave` on the lane) or
  focus is in it; a move between lanes is never held. Each lane has one roving tab stop; J/K
  and the arrows never leave the lane. A focused card or row that leaves hands focus to its
  lane's heading (`#workingLaneTitle`, `#quietLaneTitle`); `agentsHome.laneTitle(key)` gives
  the heading of a key's lane (Quiet for a row or a fold's card), which the panel's close
  uses. An empty lane keeps its header and shows one `.ah-lane-empty` line; with no session
  at all, Working shows the first-run `.ah-empty`, and before the first read it says
  "Reading sessions…". The state filters, group-by and the session count beside the old
  heading are gone. `public/sessions.js` (pure) builds one card per session from
  the frame's reads: each launch (switch on only, §9) joined with its live driven rows
  (`launchSessions`), and every other `/api/activity` row under the sidebar's project and
  agent lens (`liveInLens()`, never narrowed by closure). A card's asks (read from
  `waitingEntries`; each goes to at most one card: an item to the card of the session it
  names, a plan row to the card of the session that stamped the plan, else to the newest
  working card `linkedPlan`'s project + branch + agent join links, else to the newest idle
  or dormant card the same join matches; anything left is on no card) never change its
  state or place (lanes design §3.3): the card or row carries an "Asking you · N" chip
  (`.sc-asking`) that opens its first waiting ask in front on Home. There are no ask-only cards. States: Didn't start / Not responding, Starting… / Stopping…, Working (`isWorking`), Idle or Quiet, Parked
  (parked, or stopped with its session kept, labelled Stopped, #478; both are Quiet rows), In Terminal, Ended, Dormant (`isDormant`).
  Quiet (#466) is the idle state's label when nothing can tell: a terminal session reports
  only through Agent Inbox calls, so one busy with `gh`, a shell or another server reads
  exactly like one waiting at its prompt. Only a driven row or a running launch whose
  driver reports no running turn (no `driven_turn`), or a session whose Claude Code hooks
  stamped its turn ended (#466 PR 2, "turn ended 12m ago"), says Idle; a hook-stamped
  running turn with no claim is Working, "Task not reported" (`isBusy`, `hostState`). A quiet card's time says "no Agent Inbox call for
  40m" ("last Agent Inbox call just now", or "connected 3m · no Agent Inbox call yet"),
  never "idle 40m", on a line of its own under the head (`.sc.quiet`) on a fold's card; its state key stays `idle`. A claim
  that is no longer live reads "Last reported: <claim> · 52m ago", dated by the last call
  (`card.line`, shared by the card and the panel); a launch's own status text keeps
  "was:". The ages follow the existing 30-second clock, like the card's recency.
  Sorted by state then newest call, order pinned per lane as above. Working cards carry the
  plan bar, subagents and call trace; the folds, at Quiet's end, hold Ended (the newest five plus kept worktrees, with Earlier sessions
  inside; its summary counts the worktrees ended launches still keep), Dormant, In closed
  projects and the global Not delivered. Cards update in place keyed by id, each part
  rebuilt only when its own key changes (the foot's facts and buttons apart, so a new call
  never replaces a focused button), and classes change through `classList`, never
  `className`, so a running pulse survives; a closed fold paints no cards, and the folds'
  row shows only with something in it. The open folds are window-local and in
  `frameInputs()` (`agentsHome.state()`). A
  working card pulses once on a new call (`.sc.pulse`, in the Calm and reduced-motion
  lists). Card actions reuse the launch UI's own handlers (`launchUi.run`), Remove
  worktree… included on an ended launch whose worktree is kept, and Forget… (#478) on an
  ended launch with none left (main checks and asks, as in the panel; only with the launch
  grant; a forgotten card goes on the next read, and its open panel closes); one that fails opens the launch's panel,
  where its note shows. A card's or row's click toggles its panel and Enter opens it; a
  trusted click on a row is not an outside click (`closeSessionFocusOnClick` tests
  `[data-session-card]`). Launches the project and agent lens hides that are not ended are
  named in one quiet line under Working's heading ("N sessions outside this filter · Show
  all", which clears the lens), and a session started, or a
  `launch:` panel opened, outside the lens scopes the lens to its project first, as Jump
  to session does, so no launch is ever unreachable. Subagents carry `status()`'s
  optional `state` into the panel's list and the card's tooltip. Nothing it draws
  reaches attention.
- The Agents home holds no agent cards since Agent cards step 1 (D4): they are in the
  **Agent cards** tab (below).
- **Find** (UX pass, slice 4, step A) replaces Notes and History: `data-tab="find"` after
  Plans in `#tabs`, `'find'` in `TAB_IDS`, panel `#find`, its tab counting unread notes (the
  History total went with its page). The panel's field `#findQuery` and its chips (All,
  Answers, Notes, Plans; `button[aria-pressed]` in a `role="group"` labelled "Show") are static
  markup; `public/find.js` builds the rows from the data the page already holds (no route of its
  own) and `renderFind()` in `paintEditableSurfaces` reconciles them by `data-find-key`, so focus,
  a selection and an open card keep their nodes. A row is `div.find-row` holding one
  `button.find-row-main` of spans (icon and label, title, New mark on note rows, one extra,
  project, age) and, while open, `div.find-row-body` with the shared card. A closed item or an
  open note, milestone or aged note opens in place; an open ask goes to Home; a plan to Plans
  keeping the lens. Order with no query is newest first by each row's own stamp (Notes: open
  first); a closed item whose own stamp is not later than the page's `history.before` is below
  the cut, and Show more reads the complete history (`findHistoryPinned`). With a query, rows
  keep search's order with the chip applied inside each section and no limit; history and
  archived plans load only for the chips that list them (`findInUse`). 20 rows, then Show 20
  more. Rows the person acted on, or whose Note editor holds text, stay in their painted place
  until they leave Find. Only the Notes chip with no query, in a visible focused window, marks
  notes read; the New marks are a snapshot taken on entering. On Find the top bar's search is
  not drawn and ⌘K and `/` focus `#findQuery`; `G F` opens Find on the field, `G N` and `G H`
  open it with Notes or All, the query cleared and the list focused. `tabForItem` returns
  `find` for notes and closed items; a landing keeps the query and chip when the target is
  listed, else clears the query and selects the narrowest chip, changes the lens only when the
  target is outside it, and opens and focuses the row. Printable keys that act on Home or the
  Review queue do nothing on Find.
- The **chats** (#586) are Find's fifth chip since UX pass slice 4, step B: there is no Chats tab
  or `#chats` panel. `G C` is "Find: Chats" (the query cleared, the field focused) and `#chats`
  opens the same. Entering Find reads `/api/chats` under its 60-second rule (never from the
  poll); `chats.md` has the rules.
- The **Agent cards** tab (Agent cards step 1; agent cards view design
  `docs/superpowers/specs/2026-11-09-agent-cards-view-design.md` §2, §4.5, amended, and cards
  view V5 §3, §4) is `data-tab="cards"` after Find in `#tabs`, `'cards'` last in `TAB_IDS`,
  with a storefront icon and no count slot (`tabCounts()` has no `cards` key). Its panel
  `#cards` holds `#agentCardsHome` ("Yours", `public/mesh-section.js`) and `#agentPage`
  (one agent's page, `public/mesh-agent-page.js`), one shown at a time, both painted by
  `paintAgentCards()` in `public/app.js` from `paintAmbient()` (so from `load()` and
  `reloadAndPaint()` only) and when a `/api/version` read lands. The tab is `hidden`
  (`.tab[hidden]` beats `.tab`'s `display`) unless the last `/api/version` carried `mesh` and no
  `on: false` body came since (`meshWanted()`), or the local window's mesh bridge says it is
  available on this Mac's own page (`meshSetup.usable()`, step 2b), or it is the current tab, so a passive read that
  turns the mesh off never takes the page from under the person: the grid goes, "The mesh is off
  on this Mac." shows, and the tab hides once they leave. `selectTab('cards')` returns without
  effect while it is hidden, so `G M` (in the keys table and the keyboard help), `#cards` and a
  stale caller do nothing with the mesh off; `wireTablist` skips the hidden tab.
  **Yours** is a section with a header row (the title, the count, "checked 1m ago" for
  the built-in agents only, absent when there are none, and **Refresh**: posts `refresh`, then
  repaints through `reloadAndPaint()`) and a
  `<ul class="ma-grid" role="list">`, one `<li>` per agent by name, keyed by the server's `key`,
  each holding one native `<button class="ma-card">` updated in place (never rebuilt), so focus
  and a selection survive polls and no card moves under a press. The grid has three columns,
  then two at a 700px column, then one at 460px, through `@container agent-cards` on `.agent-cards` (no
  `@media`, no CSS `order`). A card shows the name; the state dot and word; one description line
  from the card (two lines at most, then an ellipsis; a built-in agent's own `blurb`, sent by
  the server, stands in only while no card text at all, not even a last-seen card, is known); the
  `fix` in amber (an added agent's line as the server sends it; with `fixQuiet`, a missing card
  copy, in the muted text colour instead); a foot with where it runs (Local, Remote · tailnet, Remote · SSH
  tunnel, Remote · public, never a host or port), the version and "seen 2h ago" for the last good
  card; and a tag, "Built in" or "Added by you". Its accessible name is "name, state word, tag";
  the description, fix and foot are its `aria-describedby`, ids from a counter, never a name. The
  open agent's card carries `aria-current="true"`. The grid is one Tab stop (the last focused
  card, else the first): Left/Right step, Up/Down move by the columns the grid draws (read from
  the cards' positions; one with no layout; Down from a card with a row below but no card
  directly below goes to the last card), Home/End go to the ends, each with
  `scrollIntoView({ block: 'nearest', inline: 'nearest' })` and no `behavior`; Enter and Space
  are the button's own; J and K stay the session cards' keys. The words: Not checked yet,
  Checking…, Running for unslop and unslop-code / Reachable for request-post, Not running, Unreachable, Not an
  agent card, Card does not match this build, Endpoint not accepted, and Added for an agent the
  add command wrote; quiet green for up, neutral grey for unchecked, checking, not running and
  added, amber (`--app-warning`, never the attention colour) for the rest. Below the grid, "1
  entry in mesh.json is not valid: …" with the server's `othersFix`.
  **An agent's page**: pressing a card opens it in the tab in the grid's place (one slot, replaced
  by the next agent), moves focus to **← Agent cards** and calls `reloadAndPaint()` once; it
  posts no check. **← Agent cards**, or Escape when focus is not in a field, goes back to the
  grid and, if focus was in the page in a focused window, focuses the agent's card, or the top
  bar's heading (`#pageTitle`, given `tabIndex = -1` then) when the agent left `mesh.json` or the
  mesh went off. `#cards/<key>`, or `#cards/<name>` for the one configured agent of that name,
  opens the tab on that agent (it waits for the first `/api/version` read, and is dropped once
  that read settled, failed or not, or when the person chooses a tab; the viewer never writes the
  hash). With a page open the kicker is "Agent cards" and the title the agent's name. The
  status row holds the state dot, the state word with the server's `reason`, the tag, "checked …"
  and **Refresh** (`{trigger:'refresh', name}`, then `reloadAndPaint()`); the name is the page
  title above it, not repeated. For an added agent the row has no "checked" text and no Refresh
  (the app never checks it), and one line, the server's `checkNote`, stands under it; Details has
  no "Checked" line. Under it the `fix`,
  the usage line of a local agent (unslop or unslop-code) and the last run ("Last run 14:02 · ok", "No runs yet"), each in full and
  only when there is one. Its inner tablist (`wireTablist(…, 'horizontal')`) holds **Run
  history** (V5d, `public/mesh-runs-tab.js`), the default on every open (the chosen inner tab is
  kept while the page stays open), and **Details**: the card's labelled lines and a nested Card
  JSON whose `<pre>` is rewritten only when `cardJson` changes, so a selection in it survives
  polls.
  **Reads and checks.** `app.js` reads `GET /api/mesh/agents` (a conditional snapshot) only while
  `meshWanted()`, the Agent cards is the current tab and the document is visible; a skipped read
  keeps the last body, a failed read keeps it marked stale (never a failed tick), and an
  `on: false` body hides the section and stops the read until `/api/version` carries `mesh`
  again. The open trigger (`meshOpen()`, `{trigger:'open'}`) fires only when the Agent cards is
  entered from another tab (the first entry, with nothing read yet, also reads at once through
  `reloadAndPaint()`); never on boot, on Home, from a poll or a card's press. Its result paints
  through the next poll tick under the normal gates. Run history reads
  `GET /api/mesh/agents/runs?name=` (a conditional snapshot, `?name=` a `QUERY_ROUTES`
  representation) in the poll tick only while the tab is current with that agent's page open,
  Run history shows, the document is visible and the last body still names the agent
  (`meshRunsUrl()`); a skipped read keeps the last body, a failed one keeps it marked stale, and
  a body read for another agent never shows under this one (`lastData.runs.key`). It shows a
  summary ("Last 48 runs: 44 ok · 3 refused · median 8.2 s"), a `<table>` (Ended, What, Outcome,
  Took, Details; `<th scope="col">`) with rows keyed by run `id` and sorted by end time as the
  route sends them, so a new run inserts one row and no other row is rebuilt; the only text that
  changes in an old row is its Ended cell (clock time today, weekday and time within 6 days, else
  the date; the full start and end in `title`), rewritten by the label clock only when it
  changes. Amber only for failed, outcome unknown, unavailable, timed out and interrupted. 50
  rows, then **Show 50 more** up to the 200 returned (a count in the page's `state()`), "Older
  runs in the kept period are not shown." with `older`, an empty state, and a footer whose forget
  command is the route's `forget` text in a `<code>` with a Copy button, so no `public/` file
  names the command. An agent that leaves `mesh.json`, or a body with `on: false`, keeps its page
  and its last lines under "This agent is not in mesh.json any more". Card and record text
  reaches the DOM only through `textContent` and attribute values: no `img`, no `href`, no
  request to a card's URL. The open agent, inner tab, Card JSON state and rows shown are
  window-local, never persisted (a reload starts with no page open), and join `frameInputs()`
  through `meshAgentPage.state()`. Nothing in the tab reaches attention, and with no `mesh` and no
  bridge the page's requests are unchanged.
  **Set-up screens** (agent setup in the app, step 2b; `public/mesh-setup.js`, painted by
  `paintAgentCards()`). `GET /api/mesh/agents` also carries `available: [{ name, blurb, needs }]`,
  the drawn built-ins `mesh.json` does not name (from `mesh.json` alone, on and off), and the read
  runs while the bridge is usable even with the mesh off, so with no agent on **Yours** says "No
  agent is on yet." in place of the grid. After Yours come **Marketplace** (while a drawn
  built-in is off, and with the bridge always, even with every built-in on: **Add by address** at
  its head, then the same `ma-grid` cards, a `<div class="ma-card ms-offer">` each, with its
  `blurb`, what it needs and **Set up**, or unslop's line that it is set up in a terminal, the grid
  hidden when none is offered; without the bridge no button and one line, "Set these up in the app
  on the Mac that runs your agents.")
  and, with the bridge only, **Model servers**: one row per server from `run('servers', {})` (asked
  on entering the tab, on Yours's Refresh and after every operation that changed something, never
  by a poll) with **Check** and **Remove** (asked in place, the row grows), a row per inline agent
  with **Make it a server**, and **Add a server**. A set-up page opens in `#agentSetup` in place of
  the grid or an agent's page (the top bar's title names it; **←** and Escape outside a field go
  back to where it was opened, focus on the control that opened it): adding a server
  (`add-server`), making an agent's settings a server (`adopt-server`), and an agent's form
  (`enable-model-agent` with a server list ending in "Add a server…" and a model list from
  `check-server`, a text field when the server cannot be asked; `enable-request-post` with an
  address and a token file), and **Add an agent** (add step 2: a card address, and a token file
  only for an `http://127.0.0.1:` address; **Check** runs `check-agent`, which fetches the card once
  and writes nothing, and shows a summary of the card in which all card text is quoted plain text,
  then **Add** runs `add-agent` with the checked id and pin, so a card that changed in between is
  refused; an agent already added, at this address or another, is said so with Back only; after
  Add the new agent's page opens and says it was added). Every writing operation runs with
  `apply: false` first; the form's **Check** shows the dry run's steps as text under "Turning it
  on will", then **Turn on**; a refusal's own words replace them. An agent's page that is on has a
  foot with **Turn off** (asked in place, then `disable`) and, for unslop and unslop-code, **Change
  server**; an added agent's page has a foot with **Remove** only (asked in place, then
  `remove-agent` dry and applied, its run records going too). Files are
  picked by `chooseFile()`, which answers a handle and a base name; the handle goes back to main and
  is never drawn. The bridge's failure reasons have fixed sentences in the module. The open page,
  its values, the row asking "Remove?" and the running operation are the module's state, joined to
  `frameInputs()` by `meshSetup.state()`; a repaint updates text, disabled states and option lists
  in place, so it never closes a page, clears a field or moves focus. One operation runs at a time:
  every control that starts one is disabled meanwhile and the pressed one says what it is doing.
- The sidebar's Sessions line (`#sessionsIndicator`, #454, where the Live footer strip
  was) is the one session signal on every tab: `sessionsSummary` (`public/livebar.js`)
  over the GLOBAL `lastData.activity`, never the lens or closure ("N working · M
  connected", "N on an older build"; with none working, "M connected" over "all quiet",
  never "no task reported", #466). It and G L open Home with the Working lane's
  heading focused (its label ends "Show the sessions on Home"), and each re-reads `/api/version`.
  Under 1280px the compact masthead keeps the tabs alone on its first row (scrolling in
  their own cell when they do not fit) and puts the line on the selectors' row as a chip
  ("● 2 working", its G L tile kept) beside Settings, with a CSS-only shade at the tab
  row's end while more tabs wait past it; under 620px the chip and Settings
  share the brand's row, and under 440px the chip is its dot. It never covers a tab.
- The Today ribbon, Just landed and "Since you last looked" (#305) replaced the
  activity bar chart and Recent outcomes with no new read. `buildRibbon`
  (`public/ribbon.js`, pure): one lane per project (12 most recently active, drawn by
  name), history spans clipped to the range with a STATIC striped tail for a live span
  (nothing in the ribbon animates or transitions; `test/motion-css.test.ts` pins it),
  ◆ asks (open only through `attentionEntries`/`laterEntries`), ● outcomes, ≤ 200 bars,
  and no marker before what the page proves complete (#184's `before`, #299's newest
  omitted outcome), past 120 markers the floor rises to the newest cut, and the
  "Asks and outcomes from …" note is audible. Lanes are keyed and a track is rebuilt
  only when its shape changes; geometry and tooltips update in place. The range
  `<select>` keeps identity, value and focus. Just landed proves the newest four exactly
  as before (reads byte-identical to main), then leaves out only proven rows whose OPEN
  PR (`linkIndex`) is an open ask's open PR, named as "N on PRs still waiting on you";
  a branch with no open PR hides nothing. It highlights a new outcome once under
  `motion.activityMotion()` with the Dashboard visible. "Since you last looked" covers
  `lastVisitAt` to this page load after a 30-minute gap, with "N+" where omitted history
  could add more, until the human's first trusted click or key press on the
  Dashboard that is not reading it (a press on the line, ⌘/Ctrl shortcuts, keys
  with the line selected).
- Where a session runs (#617, PR 1; `activity-and-live.md` has the fields and their patterns): a card's
  second line (`.sc-where`) starts with "machine · desk" (`.sc-place`, from `placeLine` in the pure
  `public/place.js`; it shrinks with an ellipsis and its title is the full text), a Quiet row shows it
  after its caption in the muted meta style, and the session panel's meta line says it too. The panel adds a section
  (`.sp-place`) with "Open in claude.ai", an ordinary `target="_blank"` link made by `textLinkHtml`
  from `claudeSessionUrl`, and "Copy attach command", which copies `tmux attach -t '=<desk>'` through
  `writeClipboard`. Each control exists only for a value that passes its pattern again on the page; a
  row an older server wrote has none of the fields and draws exactly what it drew before.
- Command-center polish (#307) adds no read and no answer surface. The keyboard help's "Home" group is
  help-only (`legacy`) entries in `public/keys.js`; keep them legacy. The session
  panel (`.dash-focus`, from a card or ⌘K; since #454 mounted in the Dashboard grid
  itself, never inside a card or fold that can be hidden; since the lanes PR 5 in
  `.dash-split` with the lanes: at 1280px and wider beside them in `.dash-split.open`
  (`syncSplit`), sticky under the top bar; under 1280px static after its card's row (`placeFocusPanel`), closed by a trusted
  outside `click` that is not on a card, never a `pointerdown`, and never while it is in
  flow; closing returns focus to the card's first action, else the Agents heading) shows one card (`agentsHome.cardFor`, keyed by a session or a launch's
  card id): its state and summary, the launch's action bar, worktree, transcript and
  Resume and send (launch-ui.js's `paintPanel`, §9: none off), an app session's
  approval answered in place with its own options through `sendReply`'s signed path
  (#454 Q3), every other ask of the card answered in place in
  Asking you (#454 A.2, the list's own `answerEl`/`rowAnswerEl`), the session's
  message composer (#411, `viewer-frontend.md`), its plan and
  outcomes open through `focusItem`, its PR/CI chips are ambient `sourceChipsHtml`
  and its links are #300's `cardLinks`/`linkStripHtml`. Parts are rewritten only when
  their markup changes; opening and closing move focus only in a focused window. Its
  handlers repaint their own region from `lastDashModel`, never a new render entry,
  and `focusSession` is in `frameInputs()`. ⌘K actions
  (`public/palette.js`): only the full names "answer ", "open plan ", "jump to
  session " (with the space) are commands and list targets first; a prefix of a
  name or hint only suggests the command and never
  outranks the top Open-item match. Answer opens the ask in front on Home (`openAskInInbox`).

## Invariants in detail

- **Dashboard focus must not freeze monitoring detail, or the list of asks.** Mount the
  structural frame and native range selector once, then refresh session cards, recent
  outcomes, history and the list's count through the ambient painter. Focus resting inside
  `#dashboard` (a lane control, the range, the session panel) holds no frame: the list of
  asks shares the page and keeps repainting under the ordinary rules (a held press, an
  unsent answer, a scroll in progress). Only bringing an ask to the front waits for that
  focus to leave. Preserve the
  range control's identity, value and focus across polls and history error/recovery.
  Reuse a focused outcome button while its result remains present; move focus to an
  adjacent control only when that result actually leaves and the viewer owns focus.
  This must not bypass the global held-pointer guard, create a third render entry,
  or pull keyboard ownership back from a background viewer.
- **Every ask shows once, in Home's list; the session panel answers in place (slice 2 of
  the UX pass retired the dashboard lanes design's Needs you lane, §3.2, which had replaced
  #454 amendment A.1's ask-only cards).** A session card's "Asking you · N" chip (a click on
  `.sc-asking`, checked before the card's actions, so a launch card never runs a launch
  action for it) opens that session's first waiting ask in front through
  `openAskInInbox`. The
  session panel's Asking you section is unchanged: `paintPanelAsks` mounts, per ask of the
  card, the list's own `answerEl`/`rowAnswerEl` with `surface: 'compact'` (★, More…
  with Clarify, Decline and "I'll take a while", disclosure keys of its own, and Compare
  closed by default: it stacks each option over its tradeoff, `compactCompares`) plus Snooze 4h, Pin and Open ask (`snoozeAsk`, `pinAsk`,
  `openAskInInbox`), the "the agent is waiting" meta, and this session's answers not yet
  picked up (`agentEntries`), dimmed and never counted; an `@sessions` approval keeps the
  Approval block (#459). Three draft rules hold for the section: a poll leaves
  it alone while one of its asks holds a draft in use (`draftInUse`, #563) or a background
  window remembers focus in it within two minutes of the human's last input in it (past
  that it shows current asks, never taking focus, so a window left beside a terminal
  cannot keep an advanced row as an answered line) (and skips an unchanged one, moving only its ages); the hold is the panel's
  (`focusSession`), never its card's, because a card can go under an open panel (its
  session ends: the panel keeps the editor and says the session left; `followHeldAsk`
  moves the panel to another card that now holds the drafted ask without rebuilding it,
  but only once the panel's own card has gone and focus is not elsewhere in the panel:
  while that card exists the panel never moves, though two working sessions trade a joined
  plan's row on every call); a forced paint rebuilds it; it
  restores focus (`captureCardFocus`, and `restoreDraftFocus` scoped to `#dashFocus`) only
  with the document's. Closing the panel drops its editors and keeps the drafts in
  `draftReplies`/`rowDrafts`. A notification still lands on the ask's card on Home. Keys
  (help-only `legacy` entries in `public/keys.js`): on a session card itself, J/K and the
  arrows move between cards (one tabbable, `roving`) and Enter opens its panel;
  on an ask's block in the panel, 1–4 and R are the global keys scoped to the block
  (`keyboardActionScope`), S snoozes and P pins (`onPanelAskKey`); Esc closes the panel.
  The list names each ask's session ("live · branch" while its session is listed,
  "session ended" when it names one that is not; `askSessionToken`) and its open card
  offers **Show on Agents ›** (titled "Open this ask in its session's panel";
  `openAskInSession`: the panel at the ask, widening the lens where its session lives, which
  closes the ask in front on a wide window) only where a session card holds the ask or its
  session is live.
  Cards (A.3, V1–V5): one quiet meta line (state
  word, agent kind as text, an outlined "A" for started here, branch, time), what the
  session is doing leading, a secondary line (worktree, a working session's plan bar, or
  when a message reaches it), the "Asking you · N" chip, and the state's one
  action as a text button; build hints are the panel's and the Sessions line's; pink only
  for asks and green only for the working dot; group heads are small caps with a session
  count; Ended, Dormant and Not delivered share one footer line. Under 1280px
  two columns, in a desk under 900px one, and the panel sits after its card's row
  spanning the cards' grid, so inline under its card at one column; it never moves while
  it is open and holds focus, unless it was cut off: the panel is the one `focusPanelEl`,
  never found by a selector; agents-home moves it out (`release`) before it removes a
  group or closes a fold, its own repaints call back into `placeFocusPanel`
  (`afterRepaint`), and a panel left disconnected or inside a hidden or closed ancestor
  always goes home (#463 review). Every such move goes through `moveKeepingFocus`
  (`agents-home.js`), which gives back the focus and a text control's selection the panel
  held, in a focused window only, and agents-home sends focus to its heading only when it
  was really lost. `test/dom/agents-asks.test.ts` and `test/dom/ux-home.test.ts` pin the DOM half.
- **`sortRail` only reorders, and the Dashboard reads only the one predicate (#303, D2,
  D3, D8; the rail it fed retired by #454's PR 6).** `buildDashboard`'s `waitingEntries`
  IS `attentionEntries` under the Dashboard's lens (`relay.human`), so the session cards,
  the badge, the tabs and the dock cannot disagree (the model's `needsYou` and `later` are
  read by nothing since the lane went). `sortRail` (`public/attention.js`) orders a card's
  asks and ⌘K's answer targets: an
  item whose session is live (`classifyLiveness` → `waiting`) comes first, the rest keep
  `sortNeedsYou` order; never filter or add an entry there. A deferral of an ask
  holding a draft gives it the open card on Home (`keepDraftInView`; from a Review queue
  opened on another tab it selects Home first), since no lane shows a deferred ask. Never put `data-dashboard-focus-key` on an ask's block, or
  `restoreDashboardFocus` would move focus off its control onto it.
- **The session cards and their chips read one model, updated in place (#304, Dashboard
  2.0 phase 2, decisions D2, D4; the lanes it drew retired by #454, the Now strip by the
  lanes PR 3).** `buildLanes`
  (`public/lanes.js`, pure, called by `buildDashboard`) reads only the reads the poll
  already makes: working is the claim and `last_call_at` alone (`isWorking`: not `idle`,
  and `last_call_at ?? started_at` within the 30-minute `CLAIM_COLD_MS`, re-checked against
  the clock because a snapshot ages); `updated_at` is never read there, so a session that
  only heartbeats is idle. A plan is drawn as done / in progress / waiting on you / to do
  over the Plans tab's own `countable`, where "waiting on you" is only rows
  `isBlockedRowAttention` counts. Working holds the main-list cards whose base state is
  working, a running host turn included, and Quiet the other main-list cards; no lane
  heading carries a number. The lanes keep cards and rows keyed by id and write only changed text and
  attributes, so an unchanged card keeps its nodes and selection; a rail draft never stops
  it, and a held pointer stops it with the rest of `paintAmbient`. A focused card control
  that leaves hands focus to its lane's heading only when the document had focus before the
  update: removing the focused node can itself make `hasFocus()` false. A background
  window's remembered focus is never moved. Order is pinned per lane (`pinLaneOrder`): a card
  keeps its place, new ones append, and only a forced paint (`forcedAmbient`) re-sorts, and
  not while the pointer or focus is in that lane. **Session
  activity uses no infinite animation; motion is one-shot per real event.** Measured A/B
  against main with four working sessions, the lanes' first loops (pulses and a top-edge
  sweep) cost +5.6 pp of renderer and +34 pp of GPU CPU just for being on screen, undoing
  #298, and even one loop cost ~+4.7 pp. So a working card's dot is static, and a card
  whose `last_call_at` moved forward since the last paint pulses once (`playOnce`: a class
  whose one-iteration CSS animation takes the motion tokens and is removed on
  `animationend` or, since #305, `animationcancel`, so one cancelled by Calm or by leaving
  the Dashboard never replays). Nothing starts on first paint, for a card that just
  appeared, on an unchanged poll or a forced repaint, for a card that is not drawn, or
  while the Dashboard pane is hidden; and nothing starts unless `motion.activityMotion()`
  allows it: Full only, never under the OS reduced-motion setting or a hidden page. Calm
  stops the pulse too, with a CSS backstop in both lists. Presence, not attention: nothing
  here reaches `public/attention.js`, a badge, a tab or the dock
  (`test/dom/dashboard-cards.test.ts`).
- **The Today ribbon, Just landed and "Since you last looked" read only what the poll
  already reads (#305, Dashboard 2.0 phase 3, D8).** The ribbon replaced the Agent activity
  bar chart; the range menu is the same native `<select>`, mounted once in the panel head,
  so polls, ribbon changes and history errors keep its identity, value and focus.
  `buildRibbon` (`public/ribbon.js`, pure) draws one thin lane per project over the range:
  `/api/activity/history` spans clipped to it (a span with neither `ended_at` nor
  `effective_ended_at` is live and its bar gets a striped tail from where it started), ◆ for
  every question raised and every ask an active plan's row has made (its current action
  when blocked or once answered, owned or handled, and each earlier action in its `history`
  with an owner or a response; an earlier step closed with neither, which only a
  pre-action-field writer makes, is not counted), ● for every recorded outcome. A ◆ is drawn open
  only when its entry is in `attentionEntries` or `laterEntries` (`buildDashboard`'s
  `marks`), so the ribbon never shows an ask the badge does not know. Budgets: the 12 most
  recently active projects (drawn by name so a lane keeps its place; the rest "+N more
  projects"), at most 200 bars (touching spans merge, then the merge gap doubles until they
  fit) and 120 markers. Markers older than what the page proves complete are not drawn:
  items created after the page's `before` are all on it (#184) and outcomes stamped after
  the newest omitted one are all loaded (#299), so `marks.asksAfter`/`outcomesAfter` set a
  floor. Past 120 markers the floor rises to the newest one cut (ties at that instant are
  cut too), so what is drawn is always every marker after the floor, never a silent
  subset. Either way the axis says "Asks and outcomes from …" (`marksFromAt`), and that
  note is outside the `aria-hidden` axis labels so it is heard. The ribbon never asks for
  older history itself (a follow-up may read it when the human changes the range). **Nothing in the ribbon animates**: #304's rule, so the "now" stripes are a
  static `repeating-linear-gradient` on `.dash-ribbon-bar.live::after`, and
  `test/motion-css.test.ts` refuses any animation or transition on a ribbon rule. Lanes are
  keyed by project; a lane's track is rebuilt only when its SHAPE changes (how many bars,
  which are live, which markers), never for its geometry: positions, `--live-from` and
  tooltips are written in place with `setAttr`, so a live bar growing with the clock keeps
  its node and an unchanged poll writes nothing. Just landed is the former Recent outcomes
  list: the newest four are proven EXACTLY as before #305 (`listed`, `keepsUnproven`,
  `recentOutcomesComplete` and so `historyWanted`/`archivedWanted` over the unfiltered
  outcomes, so its reads are byte-identical to main's), and only then are the proven rows
  whose OPEN PR in the frame's `linkIndex` (`linkFor`, `pr_state` OPEN) is also the open PR
  of an open or deferred ask left out: that PR has not landed. A branch with no open PR
  (`main`, a merged PR) hides nothing, which the review of #391 found the hard way: matching
  by branch alone let one open ask on `main` empty the list and read older history on every
  tick. The rows left out still count and are named, "N on PRs still waiting on you"
  (`recentOutcomesHidden`), instead of the empty state. It holds four 60px rows. A new outcome (unseen key, stamped after
  everything drawn before) gets one `arrived` highlight through `playOnce`, only when
  `dashboardMotion()` allows it (Full, no OS reduced motion, visible page, Dashboard on
  screen); the first paint, a poll, a tab switch and older history arriving start nothing,
  and an outcome that arrives while motion is off is marked seen. "Since you last looked"
  (`sinceLastLooked`, §14) is one line at the top of the Dashboard part of Home for the time between
  `lastVisitAt` (the previous page load) and this page load (`visitAt`), shown only after
  a 30-minute gap, until the human has looked: their first pointerdown or keydown anywhere
  in the window while it shows on Home dismisses it for the page's life (a click on an ask included). Reading
  it does not (`sinceKeepsOn`): a press on the line, a ⌘/Ctrl shortcut (⌘C, ⌘-Tab) or any
  key while the selection is in it. Only trusted input counts (`trustedInput`); jsdom can
  dispatch only untrusted events, so `test/dom/dashboard-ribbon.test.ts` mocks that one
  seam and `test/dom/dashboard.test.ts` keeps the real check. Input only reaches a window being used, so a
  background window nobody looked at keeps it however many polls pass; the listener holds
  its own element (`sinceEl`), so an older module instance cannot hide a newer one's. It
  shows when something happened: outcomes landed, new asks, and sessions
  whose last span ended in the window and that are not live now (left out when history
  failed). A count omitted history could add to reads "3+", and one it could wholly hold
  is left out rather than "0". None of it reaches attention, a badge, a tab or the dock,
  and the poll gains no read (`test/dom/dashboard-ribbon.test.ts`, which also counts the
  worst case: 30 days of 40 projects with 14 session cards and a full rail is ~730 Dashboard
  elements against the 1,500 budget).
- **Command-center polish reads nothing new (#307, Dashboard 2.0 phase 5, D2).** Three parts (#307's lane quick filters retired with the lanes, #454). (2) **Keyboard help** lists the
  lanes' keys as help-only (`legacy`) commands in `public/keys.js`, group "Home":
  J/K and Enter on a session card or a plan row (`onKey` in `agents-home.js` and
  `plans-lane.js`, only on a card or row), the panel's 1–4, S, P and R, and Esc for the
  panel. Never make them non-legacy: the global handler would then take
  S and P everywhere. (3) **The session focus panel** (`.dash-focus`, mounted once in the
  Dashboard grid (#454), inside `.dash-split` with the lanes (dashboard lanes design §3.6):
  at 1280px and wider beside the lanes in `.dash-split.open` (`syncSplit`), sticky under the
  top bar; below 1280px static, in flow after its card's row, never fixed over the masthead;
  `test/editorial-shell.test.ts` pins both, since jsdom cannot evaluate `@media`): a click on a session card that is not
  a control or a text selection opens it, and a second click on the same card closes it.
  It answers an app session's approval (#454 Q3) and, since #454 A.2, every other ask of
  its card in Asking you (the bullet above); its message composer (#411) shows while the
  session is listed in `/api/activity`, working or not; the plan and each recent outcome open through `focusItem`. `sessionFocus`
  (`public/lanes.js`, pure) picks the plan, the session's newest item (the source of its
  PR/CI chips when it has no plan) and its last three outcomes from `outcomeEntries`. PR and
  CI chips are `sourceChipsHtml`'s, ambient: nothing there reaches attention
  (`test/dom/dashboard-focus.test.ts` compares badge, title, tabs, rail, the list's count and both
  dock projections with and without `/api/links`). Links are #300's `cardLinks` of the asks
  and the plan, drawn by `linkStripHtml`, so `link-open.js` and main's checks own every
  click. The ambient painter updates it in place: each part is rewritten only when its
  markup changes (`setFocusPart`; Asking you by `paintPanelAsks`), so an unchanged poll writes nothing and a keyboard user
  keeps the same control by its focus key. Opening focuses the panel heading and closing
  (×, Esc in the panel) returns focus to the card's first action (else the Agents heading)
  only when the window has focus and focus was in the panel. A trusted `click`
  (`trustedInput`) outside the panel that is not on a card closes it and moves no focus,
  and only while it sits beside the lanes (sticky): never a `pointerdown` (closing mid-press moved what was under the
  pointer), and never in the compact layout, where the panel is in flow (`position:
  static`) above the cards below it and closing it would lift them under the press. A session that stops working keeps
  the panel open on its card; one whose card leaves keeps it open with one line saying so. Its one-shot entrance
  (`dash-focus-in`) takes the motion tokens, is instant under reduced motion and listed
  under Calm. The split (§3.6) is on only while the panel is shown, the window is 1280px or
  wider and the panel is the split's own; its `open` class flips in `syncSplit` alone, and
  only a flip reads layout: `keepOnScreen` scrolls by however far the lanes' reflow moved the
  card the panel was opened for, so a poll or a switch between sessions reads none and moves
  nothing. A panel held inline by focus across a resize stays inline, with no split, until
  focus leaves. `focusSession` is in `frameInputs()`; its handlers repaint only their own
  region from `lastDashModel` (the model the last paint drew), never through a new render
  entry, so the cards never re-sort under the pointer. (4) **⌘K
  actions** (`public/palette.js`, pure): only the FULL names "answer ", "open plan " and
  "jump to session " (with the space) are commands, so a search such as "plan flow
  rollout" stays a search; they list their
  targets over every open project (the attention set in rail order, active plans, working
  sessions) ahead of ordinary results; a two-letter-or-longer prefix of a name or of a
  hint ("plan", "session") only suggests the command (it fills the box), placed after the results when the first is an
  Open item, so the strongest Open-item match keeps first place. Among trim-equivalent
  edits only the one that turns a name into its command re-runs search (`commandShape`).
  Answer opens the ask in front on Home (`openAskInInbox`, from any tab); open plan is
  `focusItem`; jump to session is Home, scoped to the session's project as a deep
  link scopes to its item's, with that panel open. No action opens a new editor.
- **Motion is CSS-only, compositor-only and always switchable off (#302, Dashboard 2.0
  phase 0).** Design: [`2026-10-22-dashboard-2-proposal.md`](../../docs/superpowers/specs/2026-10-22-dashboard-2-proposal.md)
  §10. Rules every later phase follows: (1) Keyframes animate only `transform` and
  `opacity` (stripes move on a transformed pseudo-element, never `background-position`), and
  no JS animation loop, canvas or chart library. (2) Durations and easings come from the
  `--motion-*` tokens on `:root`; every `transition` uses them. (3) Every selector with an
  infinite animation is listed twice with `animation: none !important`: in the
  `@media (prefers-reduced-motion: reduce)` block and as `:root[data-motion="calm"] <selector>`.
  That block also makes every one-shot instant (`*` durations and delays 0s, iteration
  count 1, `scroll-behavior: auto`). (4) At most 12 infinite animations on screen, and none at all for
  activity: #304 measured a single loop at ~+4.7 pp of renderer CPU, so motion that marks
  activity is one-shot per real event (see the session cards above). (5) Motion
  never moves focus, scrolls or reorders under the pointer, and updates are keyed rather than
  rebuilt, so the held-pointer guard keeps working and there is no third render entry.
  `public/motion.js` (`createMotionController`, created at app.js top level before the first
  render) publishes `data-motion="full|calm"` (Settings → Motion, `agent-inbox-motion` in
  localStorage, Full by default, unknown values read as Full) and `data-page-hidden` while
  `document.hidden`, under which CSS pauses every animation; a visible but unfocused window
  keeps its motion. Calm turns infinite animations off and keeps one-shots; the OS setting
  turns both off whatever the choice. JS-driven motion goes through the controller too:
  `scrollIntoView` takes `motion.scrollBehavior()` (instant under the OS setting), never a
  literal `'smooth'`. The setting is layout only, like the default sort (#221): a change
  repaints through `forceRender()` and never reaches attention, a badge, a count or the
  dock. jsdom cannot evaluate the media block, so `test/motion-css.test.ts` pins the CSS
  (its checker is also run on synthetic sheets) and `test/dom/motion.test.ts` the setting,
  the hidden-page attribute and the scroll behaviour.

## History (shipped since v1)

These landed after v1 and still hold invariants; the release history itself is in `CHANGELOG.md`.

- **Editorial desk shell** — user-facing navigation is Home / Plans / Find (Notes and History until slice 4 of the UX pass) (and Chats, #586;
  Home since slice 2 of the UX pass folded the Inbox page into the Dashboard), while
  stored ids and API vocabulary remain `needsYou` / `boards` / `done` / `blocked`. The app is
  light-first with a warm canvas, white surfaces, deep rose accent, Segoe UI/Aptos typography,
  restrained borders and no gradients or glow. At 1280px+ `.nrow-card` is CSS-positioned as a
  fixed inspector but MUST remain a descendant of its `.nrow`; moving it into a portal breaks
  row-scoped writes, draft persistence, focus, deep links and the poll gate. `public/panes.js` is
  the pure source of truth for adjustable widths: library 220px default / 180–320px, inspector
  (the ask in front) 640px default / 360–720px, with at least 400px left for the queue. Preferences persist under
  `agent-inbox-sidebar-width` and `agent-inbox-inspector-width`; mouse drag, separator keyboard
  controls, viewport reclamping and double-click reset must update CSS and ARIA together. Inside
  the single EOF width block, `@media (max-width: 1279px)`, the splitters hide, the item card returns
  to static inline layout, and the library becomes a compact masthead. At desktop width the
  agent picker belongs at the bottom of the library sidebar above Settings. In the broad masthead
  it sits immediately right of the project selector; at 900px those controls share a second row,
  at 620px the complete four-tab library gets its own row above them, and at 440px the two
  selectors stack. The project selector opens the existing rail as a vertically scrollable,
  contained menu with inline counts and project-owned archive/reopen actions. The menu closes on
  project selection, outside pointer/focus, Escape (with focus restoration), or a breakpoint
  transition. Disclosure state is window-local and non-persistent. Workspace search lives in
  the sticky topbar. While its results are open, raise that parent stacking context above
  the desktop inspector and resize handles, but below phone action cards and modal
  owners; raising only the child dropdown cannot escape a lower parent context. Closing
  results restores the normal header layer. It is a combobox index over the open asks, Notes, finished things,
  and active/archived Plans; it never filters the queue, project rail, tab badges, or the
  Sessions line. Results use one visible lifecycle hierarchy — Open items, Active plans, Notes,
  Finished (History until UX pass slice 4), Archived plans — with relevant matches ranked inside each section, so past work never
  outranks current action. Every result explains its match: visible title characters are rendered
  through safe `<mark>` nodes, while hidden-field matches get a bounded, source-labelled snippet
  with ranges adjusted into snippet coordinates. Agent text still enters the DOM only through
  `textContent`/text nodes; never turn match highlighting into authored `innerHTML`. The initially
  highlighted first option is the strongest Open-item match when one exists. Results navigate
  through the existing deep-link path, carrying the exact matched field and plan-row identity:
  hidden Background sources open on arrival and the matched text is safely highlighted in the
  destination through poll rebuilds. Arrow keys/Enter operate the listbox without moving focus,
  Escape cancels the debounce, clears, closes, and blurs, and leaving the dock closes the list
  without discarding the query. While a changed query debounces, the prior list remains mounted
  but `aria-busy` and non-activatable; once ready, unchanged result identities update their
  highlights in place. Poll refreshes preserve the active result by identity and do not rebuild
  an unchanged list under the pointer.
  Multi-term searches use `createBoundedMatcher` to match ordered terms separately
  over the complete text; uFuzzy remains the finite-edit, single-term matcher.
  Never send an entire plan's concatenated background through the old multi-term
  regexp: ordinary repeated release prose caused seconds of cross-term backtracking.
  Preserve quoted/excluded terms, typo support, full distant-text coverage, source
  identity and useful ranges; do not substitute context truncation or a larger debounce.
  The per-build cache must not outlive its data snapshot. `test/search-bounded.test.ts`
  exercises long positive, negative and wrong-order cases with independent process
  deadlines so a performance regression cannot hang the test runner itself.
  Command/Ctrl+K focuses and selects its query even from the agent select; `/` remains the
  unmodified keyboard shortcut. The queue itself is an
  inline-size container: filter/tool groups reflow rather than scroll beneath the inspector, and
  below 620px each row gives its title a full primary line before wrapping status metadata.
  Above 620px the title and its metadata share a line only while the title keeps 18rem; a row
  whose metadata is wider moves it to a line of its own, right-aligned, rather than squeezing the
  title to a letter per line (#590).
  `test/editorial-shell.test.ts`, `test/panes.test.ts`, `test/layout.test.ts`,
  `test/dom/search-index.test.ts`, `test/dom/boot.test.ts`, and
  `test/dom/project-disclosure.test.ts` pin the contract; jsdom still
  cannot validate the responsive media layer or CSS vars.
- **Attention-first cold launch** — every fresh viewer opens Home with All projects,
  all agents and All action types; on a wide window the first waiting ask is in front from
  the first paint with data (slice 2), and nothing else is expanded. Project/agent filters are
  window-local; the boot path removes the two legacy localStorage keys so an older build
  cannot strand a new build behind a stale lens. Explicit notification/hash deep links are
  the exception: they scope to and open their target. A draft restored at boot (#279) is
  a second exception, without a tab switch or focus: the newest restored queue draft
  reopens its card, and a fold holding a restored draft opens once. This keeps the global badge and the
  first visible list honest about the same cross-project workload. Sort order is a saved
  queue display preference *(#221)*, because ordering never hides anything: Settings →
  Default sort order (`agent-inbox-default-sort`; an unknown value reads as Priority) seeds
  the queue's Sort menu on every load, and a change there repaints at once through
  `forceRender()`. The queue's own Sort menu changes only the current view, never that default.
  The Later section *(#247)* is the other one, for the same reason: Settings → Inbox → Later
  section (`agent-inbox-later-section`, on unless it reads `'false'`) only chooses where
  pinned and snoozed asks are drawn, and repaints at once through `forceRender()`.
  Settings → Motion *(#302)* (`agent-inbox-motion`, Full unless it reads `'calm'`) is saved
  and repainted the same way, and is equally layout only.
