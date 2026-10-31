---
paths:
  - "public/dashboard.js"
  - "public/ribbon.js"
  - "public/lanes.js"
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
applyTo: "public/dashboard.js,public/ribbon.js,public/lanes.js,public/motion.js,public/style.css,public/layout.js,public/panes.js,public/tabs.js,public/search.js,public/search-index.js,public/index.html,public/theme.js,public/theme-bootstrap.js"
---

# Viewer dashboard, lanes and shell

The Dashboard 2.0 surfaces (#302–#307), the editorial desk shell, layout and search, and the attention-first cold launch.

Moved out of `CLAUDE.md` and `.github/copilot-instructions.md` by #379, nearly verbatim. Claude Code and Copilot CLI load this file automatically when they read or edit a file matching the `paths`/`applyTo` globs above (through the symlinks in `.claude/rules/` and `.github/instructions/`); anyone else should read it before changing those files.

## In brief

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
- The Dashboard's Needs you rail (#303) replaced Ownership flow and is the only
  answer surface on the Dashboard. Its cards are `sortRail(attentionEntries)` (waiting
  asks first, ordering only) cut to three, with "+N more · N in Later"; the Now
  strip's "Waiting on you" owns the count. Cards reuse `answerEl`/`rowAnswerEl` (`surface: 'rail'`)
  and the shared `snoozeAsk`/`pinAsk`, so drafts join `suspendState()`, recovery,
  durable drafts and the restart hold, and `expect_answer` is unchanged. It paints in
  the ambient painter: a poll leaves it alone while one of its asks holds a draft or a
  background window remembers focus in it, and `render()`'s `forcedAmbient` makes a
  human's `reloadAndPaint()` rebuild it anyway. It restores its own focus only while
  the document has focus.
- Live lanes and the Now strip (#304) are one model, `buildLanes` in
  `public/lanes.js`, over reads the poll already makes. A lane is a session whose claim
  is not idle and whose `last_call_at ?? started_at` is within 30 minutes; `updated_at`
  is never read, so a heartbeat-only session folds into "+N idle connections". "quiet
  12m" after 5 minutes without a call. Its plan joins by project + branch + agent (most
  recently updated); its asks come from the attention set in rail order and jump to the
  rail card (D2). The Now strip's plan steps are the lanes' bars, each plan once. The
  ambient painter updates lanes in place, keyed by session, writing only changed text;
  order is pinned and only a forced paint re-sorts. Lanes use no infinite animation
  (a loop measured +5.6 pp renderer, +34 pp GPU CPU): a live lane is a static dot and
  "live", and activity motion is one-shot per real event, a pulse (and the sweep on the
  newest) when `last_call_at` moves forward on a poll, never on first paint, an unchanged
  poll or a forced repaint, and only when `motion.activityMotion()` allows it (Full, no OS
  reduced motion, page visible). Nothing reaches attention. A cancelled one-shot
  (`animationcancel`) drops its class like a finished one (#305).
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
- Command-center polish (#307) adds no read and no answer surface. Lane quick
  filters (project, agent) are window-local and narrow only the drawn lanes, after
  the order is pinned over every lane. The keyboard help's "Dashboard" group is
  help-only (`legacy`) entries in `public/keys.js`; keep them legacy. The session
  focus panel (`.dash-focus`, from a lane's title button, mounted inside the lanes
  card: over the lanes column on a desktop, static below the lanes under 1280px,
  closed by a trusted outside `click` that is not a lane, never a `pointerdown`, and
  never while it is in flow) answers nothing (D2): its one editor is the session's
  message composer (#411, `viewer-frontend.md`), and its
  asks come from the attention set and jump to the rail or Inbox card, its plan and
  outcomes open through `focusItem`, its PR/CI chips are ambient `sourceChipsHtml`
  and its links are #300's `cardLinks`/`linkStripHtml`. Parts are rewritten only when
  their markup changes; opening and closing move focus only in a focused window. Its
  handlers repaint their own region from `lastDashModel`, never a new render entry,
  and `focusSession`/`laneFilters` are in `frameInputs()`. ⌘K actions
  (`public/palette.js`): only the full names "answer ", "open plan ", "jump to
  session " (with the space) are commands and list targets first; a prefix of a
  name or hint only suggests the command and never
  outranks the top Open-item match. Answer lands on the rail card or the Inbox card,
  never a new editor.

## Invariants in detail

- **Dashboard focus must not freeze monitoring detail.** Mount the structural frame
  and native range selector once, then refresh the Now strip, live lanes, the Needs you
  rail, recent outcomes and history through the ambient painter. Preserve the
  range control's identity, value and focus across polls and history error/recovery.
  Reuse a focused outcome button while its result remains present; move focus to an
  adjacent control only when that result actually leaves and the viewer owns focus.
  This must not bypass the global held-pointer guard, create a third render entry,
  or pull keyboard ownership back from a background viewer.
- **The Dashboard's Needs you rail is the one answer surface there, and it reads only the
  one predicate (#303, Dashboard 2.0 phase 1, decisions D2, D3, D8).** It replaced Ownership
  flow. `buildDashboard`'s `rail` is `sortRail(relay.human)` (`public/attention.js`) cut to
  three cards, plus how many more and how many wait in Later (`laterEntries`): relay.human
  IS `attentionEntries` under the Dashboard's lens, so the rail, the badge, the tabs and the
  dock cannot disagree. `sortRail` only reorders: an item whose session is live
  (`classifyLiveness` → `waiting`) comes first with an "agent waiting" chip, the rest keep
  `sortNeedsYou` order; never filter or add an entry there. The Now strip's "Waiting on you"
  owns the count (#304); the rail head and its Open Review queue button carry no number. Each card
  mounts the Inbox's own `answerEl`/`rowAnswerEl` with `surface: 'rail'` (★ on the
  recommended option, More… holding Clarify, Decline and "I'll take a while", its own
  disclosure keys) plus Snooze (4 h), Pin and Open icons whose writes are the shared
  `snoozeAsk`/`pinAsk` (through `deferAsk`), so a rail draft lives in `draftReplies` /
  `rowDrafts` and joins `suspendState()`, durable drafts (#279), recovery and the
  viewer-restart hold like any editor; `expect_answer` (#321) is the Inbox editor's own.
  The editor shows only on an expanded card (CSS; a card holding a draft is always
  expanded), and the rail lives in `#dashRail` so `restoreDraftFocus` scopes to it. The
  rail paints in the ambient painter (`renderDashRail`), so it moves while the rest of the
  Dashboard holds focus, with three rules. (1) A poll leaves it untouched while one of its
  asks holds a draft (a rail draft pauses only the rail; the rest of the Dashboard keeps
  refreshing) or while a background window remembers focus inside it. (2) A frame the human
  asked for rebuilds it anyway: `render()` sets `forcedAmbient` around its own
  `paintAmbient()`, so every write still ends in `reloadAndPaint()` and shows its result;
  there is no third render entry. (3) It restores its own focused control
  (`captureCardFocus`) only while the document has focus, and never puts
  `data-dashboard-focus-key` on a card, or `restoreDashboardFocus` would move focus off the
  control onto it. A deferral from the Dashboard of an ask holding a draft switches to the
  Inbox (`keepDraftInView`), since the rail never shows a deferred ask. Keys on a card (never
  while typing): J/K move, 1–4 choose, S snooze, P pin, Enter expands.
  `test/dom/dashboard-rail.test.ts` pins all of it, including attention parity.
- **Live lanes and the Now strip are one model, updated in place (#304, Dashboard 2.0
  phase 2, decisions D2, D4).** They replaced Live dispatch and the four signal cards.
  `buildLanes` (`public/lanes.js`, pure, called by `buildDashboard`) reads only the reads
  the poll already makes: one lane per WORKING session, where working is the claim and
  `last_call_at` alone (`isWorking`: not `idle`, and `last_call_at ?? started_at` within
  the 30-minute `CLAIM_COLD_MS`, re-checked against the clock because a snapshot ages);
  `updated_at` is never read there, so a session that only heartbeats folds into "+N idle
  connections". A working lane with no call for `QUIET_MS` (5 minutes, where
  `freshnessTone` already says quiet; the proposal left N open) reads "quiet 12m". Its plan
  is the most recently updated active plan with the same project, branch (`stream`) and
  agent (D4; phase 4 may stamp it), drawn as done / in progress / waiting on you / to do
  over the Plans tab's own `countable`, where "waiting on you" is only rows
  `isBlockedRowAttention` counts. Its asks are the attention set in rail order (an item
  whose `session` is the lane's, or a row of its plan), so a lane can never draw an ask the
  badge does not count; "Asking you" jumps to the rail card (D2: the rail is the one answer
  surface) or, past the top three, opens the ask in the Inbox, and "waiting on you 2h"
  jumps to the oldest. The Now strip's numbers come from the same call: working lanes and
  their subagents, the attention set and its oldest age, and plan steps as the lanes' bars
  added up, each plan once; the card headings carry no numbers. `renderDashLanes` keeps
  lanes keyed by session and writes only changed text and attributes (`setText`/`setAttr`),
  so an unchanged lane keeps its nodes and selection; a rail draft never stops
  it, and a held pointer stops it with the rest of `paintAmbient`. A focused lane control
  that leaves (lane gone, ask strip hidden, moved by a re-sort) hands focus to the adjacent
  lane control or the lanes heading, the outcomes list's rule, and only when the document
  had focus before the update: removing the focused node can itself make `hasFocus()`
  false. A background window's remembered focus is never moved. Lanes carry `data-lane`,
  an identity attribute in `public/selection.js`.
  Order is pinned (`pinLaneOrder`): a session keeps its place, new ones append, and only a
  forced paint (`forcedAmbient`) re-sorts, newest call first. At most `MAX_LANES` (12) are
  drawn, the rest "+N more working". **Lanes use no infinite animation; activity motion is
  one-shot per real event.** Measured A/B against main with four working sessions, the
  first version's loops (lane and subagent pulses, a top-edge sweep) cost +5.6 pp of
  renderer and +34 pp of GPU CPU just for being on screen, undoing #298, and even one loop
  cost ~+4.7 pp. So a live lane is static, a solid dot and the word "live" in every mode,
  and `calledLanes` (pure) names the drawn lanes whose `last_call_at` moved forward since
  the last paint (`laneCalls`, refreshed for every model lane on every paint): each pulses
  once and the newest of them also sweeps once (`playOnce`: a class whose one-iteration
  CSS animation takes the motion tokens and is removed on `animationend` or, since #305,
  `animationcancel`, so one cancelled by Calm or by leaving the Dashboard never replays). Nothing starts
  on first paint, for a lane that just appeared, on an unchanged poll or a forced repaint,
  for a lane that is not drawn, or while the Dashboard pane is hidden; and nothing starts
  unless `motion.activityMotion()` allows it: Full only, never under the OS reduced-motion
  setting or a hidden page. Calm stops these pulses too (a pulse per call is motion a human
  may opt out of), with a CSS backstop in both lists. Presence, not attention: nothing here reaches `public/attention.js`, a
  badge, a tab or the dock (`test/dom/dashboard-lanes.test.ts`).
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
  (`sinceLastLooked`, §14) is one line under the Now strip for the time between
  `lastVisitAt` (the previous page load) and this page load (`visitAt`), shown only after
  a 30-minute gap, until the human has looked: their first pointerdown or keydown anywhere
  in the window while it shows on the Dashboard dismisses it for the page's life. Reading
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
  worst case: 30 days of 40 projects with 12 lanes and a full rail is ~590 Dashboard
  elements against the 1,500 budget).
- **Command-center polish reads nothing new and answers nowhere new (#307, Dashboard 2.0
  phase 5, D2).** Four parts. (1) **Quick filters on lanes:** a project and an agent
  `<select>` in the lanes head (`laneFilters`, window-local like the lens, never stored).
  `renderDashLanes` pins the order over EVERY lane first and filters what it draws after
  (`laneMatches`), so clearing a filter puts each lane back where it was; a chosen value no
  lane holds stays a choice (`laneFilterChoices`), and "No working session matches these
  filters" replaces the list. They narrow only the drawn lanes: the Now strip, the rail,
  the badge, the tabs and the dock never read them. (2) **Keyboard help** lists the
  Dashboard's keys as help-only (`legacy`) commands in `public/keys.js`, group "Dashboard":
  the rail's J/K, 1–4, S, P and Enter, which `onDashRailKey` handles only on a rail card,
  and Esc for the panel. Never make them non-legacy: the global handler would then take
  S and P everywhere. (3) **The session focus panel** (`.dash-focus`, mounted once inside
  the lanes card: on a desktop it overlays the right part of the lanes column, so the
  rail and the Now strip stay usable; below 1280px it is static, in flow below the lanes,
  never fixed over the masthead; `test/editorial-shell.test.ts` pins both, since jsdom
  cannot evaluate `@media`): a lane's title is a button (`.dash-lane-open`, `aria-expanded`), and a click
  elsewhere on the lane that is not a control or a text selection opens it too. It
  ANSWERS NOTHING (D2: the rail is the Dashboard's one answer surface; its one editor,
  since #411, is the session's message composer, shown while the session is listed in
  `/api/activity`, working or not): the lane's asks (from
  the attention set) each jump to the rail card or, past the top three, the Inbox card
  (`jumpToAsk`, which closes the panel without moving focus back to the lane whenever it
  lands on a rail card, from the panel, a lane's "Asking you" or ⌘K); the plan and each recent outcome open through `focusItem`. `sessionFocus`
  (`public/lanes.js`, pure) picks the plan, the session's newest item (the source of its
  PR/CI chips when it has no plan) and its last three outcomes from `outcomeEntries`. PR and
  CI chips are `sourceChipsHtml`'s, ambient: nothing there reaches attention
  (`test/dom/dashboard-focus.test.ts` compares badge, title, tabs, rail, Now strip and both
  dock projections with and without `/api/links`). Links are #300's `cardLinks` of the asks
  and the plan, drawn by `linkStripHtml`, so `link-open.js` and main's checks own every
  click. The ambient painter updates it in place: each part is rewritten only when its
  markup changes (`setFocusPart`), so an unchanged poll writes nothing and a keyboard user
  keeps the same control by its focus key. Opening focuses the panel heading and closing
  (×, Esc in the panel, Esc on its lane) returns focus to the lane only when the window
  has focus (and, for closing, focus was in the panel). A trusted `click` (`trustedInput`)
  outside the panel that is not on a lane closes it and moves no focus, and only while
  it overlays the lanes: never a `pointerdown` (closing mid-press moved what was under the
  pointer), and never in the compact layout, where the panel is in flow (`position:
  static`) above the rail and closing it would lift the rail under the press. A session that stops working (or
  leaves the filters) keeps the panel open with one line saying so. Its one-shot entrance
  (`dash-focus-in`) takes the motion tokens, is instant under reduced motion and listed
  under Calm. `focusSession` and `laneFilters` are in `frameInputs()`; their handlers
  repaint only their own region from `lastDashModel` (the model the last paint drew),
  never through a new render entry, so the lanes never re-sort under the pointer. (4) **⌘K
  actions** (`public/palette.js`, pure): only the FULL names "answer ", "open plan " and
  "jump to session " (with the space) are commands, so a search such as "plan flow
  rollout" stays a search; they list their
  targets over every open project (the attention set in rail order, active plans, working
  sessions) ahead of ordinary results; a two-letter-or-longer prefix of a name or of a
  hint ("plan", "session") only suggests the command (it fills the box), placed after the results when the first is an
  Open item, so the strongest Open-item match keeps first place. Among trim-equivalent
  edits only the one that turns a name into its command re-runs search (`commandShape`).
  Answer jumps to the rail card when the Dashboard shows it and otherwise opens the Inbox
  card (`openAskInInbox`, so `focusItem` and its hash for an item); open plan is
  `focusItem`; jump to session is the Dashboard, scoped to the session's project as a deep
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
  activity is one-shot per real event (see live lanes above). (5) Motion
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

- **Editorial desk shell** — user-facing navigation is Inbox / Plans / Notes / History, while
  stored ids and API vocabulary remain `needsYou` / `boards` / `done` / `blocked`. The app is
  light-first with a warm canvas, white surfaces, deep rose accent, Segoe UI/Aptos typography,
  restrained borders and no gradients or glow. At 1280px+ `.nrow-card` is CSS-positioned as a
  fixed inspector but MUST remain a descendant of its `.nrow`; moving it into a portal breaks
  row-scoped writes, draft persistence, focus, deep links and the poll gate. `public/panes.js` is
  the pure source of truth for adjustable widths: library 220px default / 180–320px, inspector
  520px default / 360–720px, with at least 400px left for the queue. Preferences persist under
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
  the desktop inspector and resize handles, but below Live, phone action cards and modal
  owners; raising only the child dropdown cannot escape a lower parent context. Closing
  results restores the normal header layer. It is a combobox index over Inbox, Notes, History,
  and active/archived Plans; it never filters the queue, project rail, tab badges, or Live
  sessions. Results use one visible lifecycle hierarchy — Open items, Active plans, Notes,
  History, Archived plans — with relevant matches ranked inside each section, so past work never
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
  `test/editorial-shell.test.ts`, `test/panes.test.ts`, `test/layout.test.ts`,
  `test/dom/search-index.test.ts`, `test/dom/boot.test.ts`, and
  `test/dom/project-disclosure.test.ts` pin the contract; jsdom still
  cannot validate the responsive media layer or CSS vars.
- **Attention-first cold launch** — every fresh viewer opens the Dashboard with All projects,
  all agents and All action types, and no expanded card. Project/agent filters are
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
