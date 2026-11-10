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

# Viewer dashboard, Agents home and shell

The Dashboard 2.0 surfaces (#302–#307), the Agents home (#454), the editorial desk shell, layout and search, and the attention-first cold launch.

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
- The session panel's Asking you section (#454 A.2) is the Dashboard's answer surface;
  #454's PR 6 retired the Needs you rail (#303) that was before it, and the Agents
  home spans the grid. Every ask is on one session card (`sessions.js`); the Now strip's
  "Waiting on you" owns the count and turns on the Needs you filter, and the Agents
  header holds "Later N ›" (the Inbox's Later section) and Review queue. The panel
  mounts `answerEl`/`rowAnswerEl` (`surface: 'compact'`) and the shared
  `snoozeAsk`/`pinAsk`, so drafts join `suspendState()`, recovery, durable drafts and
  the restart hold, and `expect_answer` is unchanged. It paints in the ambient painter:
  a poll leaves the section alone while one of its asks holds a draft or a background
  window remembers focus in it, and `render()`'s `forcedAmbient` makes a human's
  `reloadAndPaint()` rebuild it anyway. It restores its own focus only while the
  document has focus.
- The Now strip (#304) reads one model, `buildLanes` in `public/lanes.js`, over reads
  the poll already makes: a session is working when its claim is not idle and its
  `last_call_at ?? started_at` is within 30 minutes (`isWorking`; `updated_at` is never
  read). Its numbers are working sessions and their subagents, the attention set and its
  oldest age, and plan steps as the working sessions' plan bars, each plan once. #454
  retired the lanes it once drew (and the Live footer strip and drawer): sessions are
  the Agents home's cards. Activity motion is one-shot per real event, a pulse when
  `last_call_at` moves forward on a poll, never on first paint, an unchanged poll or a
  forced repaint, and only when `motion.activityMotion()` allows it (Full, no OS reduced
  motion, page visible); nothing infinite (a loop measured +5.6 pp renderer, +34 pp GPU
  CPU). Nothing reaches attention. A cancelled one-shot (`animationcancel`) drops its
  class like a finished one (#305).
- The Agents home (#454, design `docs/superpowers/specs/2026-11-04-agents-home-design.md`)
  is the Dashboard's one home for sessions, mounted once in the grid's main column
  (`agentsHome.element()`). `public/sessions.js` (pure) builds one card per session from
  the frame's reads: each launch (switch on only, §9) joined with its live driven rows
  (`launchSessions`), and every other `/api/activity` row under the sidebar's project and
  agent lens (`liveInLens()`, never narrowed by closure). States: Needs you (read from
  `waitingEntries`; each ask goes to exactly one card: an item to the card of the session
  it names, a plan row to the card of the session that stamped the plan, else to the
  newest working card `linkedPlan`'s project + branch + agent join links, else to the
  newest idle or dormant card the same join matches; anything left gets an ask-only card,
  #454 A.1; the filter counts asks, so it equals `attentionEntries` under the lens), Didn't
  start / Not responding, Starting… / Stopping…, Working (`isWorking`), Idle or Quiet, Parked
  (parked, or stopped with its session kept, labelled Stopped, #478; the filter reads "Parked or stopped"), In Terminal, Ended, Dormant (`isDormant`).
  Quiet (#466) is the idle state's label when nothing can tell: a terminal session reports
  only through Agent Inbox calls, so one busy with `gh`, a shell or another server reads
  exactly like one waiting at its prompt. Only a driven row or a running launch whose
  driver reports no running turn (no `driven_turn`), or a session whose Claude Code hooks
  stamped its turn ended (#466 PR 2, "turn ended 12m ago"), says Idle; a hook-stamped
  running turn with no claim is Working, "Task not reported" (`isBusy`, `hostState`). A quiet card's time says "no Agent Inbox call for
  40m" ("last Agent Inbox call just now", or "connected 3m · no Agent Inbox call yet"),
  never "idle 40m", on a line of its own under the head (`.sc.quiet`); the Idle filter is labelled Quiet and keeps its `idle` key. A claim
  that is no longer live reads "Last reported: <claim> · 52m ago", dated by the last call
  (`card.line`, shared by the card and the panel); a launch's own status text keeps
  "was:". The ages follow the existing 30-second clock, like the card's recency.
  Grouped by project (or agent kind), sorted by state then newest call, order pinned
  between forced paints (`pinLaneOrder`). Working cards carry the plan bar, subagents and
  call trace; folds hold Ended (the newest five plus kept worktrees, with Earlier sessions
  inside; its summary counts the worktrees ended launches still keep), Dormant, In closed
  projects and the global Not delivered. Cards update in place keyed by id, each part
  rebuilt only when its own key changes (the foot's facts and buttons apart, so a new call
  never replaces a focused button), and classes change through `classList`, never
  `className`, so a running pulse survives; a closed fold paints no cards. Filter,
  grouping and folds are window-local and in `frameInputs()` (`agentsHome.state()`). A
  working card pulses once on a new call (`.sc.pulse`, in the Calm and reduced-motion
  lists). Card actions reuse the launch UI's own handlers (`launchUi.run`), Remove
  worktree… included on an ended launch whose worktree is kept, and Forget… (#478) on an
  ended launch with none left (main checks and asks, as in the panel; only with the launch
  grant; a forgotten card goes on the next read, and its open panel closes); one that fails opens the launch's panel,
  where its note shows. Review opens the panel at the card's asks. Launches the project
  and agent lens hides that are not ended are named in one quiet line ("N sessions
  outside this filter · Show all", which clears the lens), and a session started, or a
  `launch:` panel opened, outside the lens scopes the lens to its project first, as Jump
  to session does, so no launch is ever unreachable. Subagents carry `status()`'s
  optional `state` into the panel's list and the card's tooltip. Nothing it draws
  reaches attention.
- The Agents home's **Mesh agents** section (agent cards view V3, design
  `docs/superpowers/specs/2026-11-09-agent-cards-view-design.md` §2, §4.5) is
  `public/mesh-section.js`, mounted by `agents-home.js` after the groups and before the folds,
  in a slot no filter or lens touches: the state filters and the project and agent lens never
  narrow it, and it shows under the empty state's text with no session. One row per agent by
  `mesh.json` name, keyed by the server's `key`: the page's state words (Not checked yet,
  Checking…, Running for unslop / Reachable for request-post, Not running, Unreachable, Not an
  agent card, Card does not match this build, Endpoint not accepted) with the server's `reason`
  and `fix`; quiet green for up, neutral grey for unchecked, checking and not running, amber
  (`--app-warning`, never the attention colour) for the rest. The row says Local with
  the loopback port, or Remote · tailnet / SSH tunnel without the host; pressing it opens the
  agent tab (below). Card text reaches the DOM only through
  `textContent`: no `img`, no `href`, no request to a card's URL. `app.js` reads
  `GET /api/mesh/agents` (a conditional snapshot) only while the last `/api/version` carried
  `mesh`, the Dashboard or an open agent tab is the tab and the document is visible; a skipped read keeps the last
  body, a failed read keeps it marked stale (never a failed tick), and an `on: false` body hides
  the section and stops the read until `/api/version` carries `mesh` again. The open trigger
  (`meshOpen()`) fires only on boot on the Dashboard once the boot's `/api/version` carries
  `mesh`, `showAgentsHome()` (once, after its version read; its `selectTab` passes
  `open: false`) and `selectTab('dashboard')` from another tab; its result paints through the
  next poll tick. Refresh, in the header row beside the disclosure button, posts `refresh` and
  then repaints through `reloadAndPaint()`. The section's open state is window-local and joins
  `agentsHome.state()`, so `frameInputs()`. With no `mesh` the page's requests are unchanged and
  no section exists. Nothing it draws reaches attention.
- The **agent tab** (cards view V5c1, design
  `docs/superpowers/specs/2026-11-09-agent-cards-view-v5-design.md` §3, §4) is one slot after
  History: `data-tab="agent"` in `#tabs`, `'agent'` last in `TAB_IDS`, its panel
  `#agentPage`, painted by `public/mesh-agent-page.js` from `paintAmbient()` (so from `load()`
  and `reloadAndPaint()` only). It is `hidden` while no agent is open (`.tab[hidden]` beats
  `.tab`'s `display`), and `wireTablist` skips a hidden tab as it skips one in a closed
  `<details>`. `selectTab('agent')` returns without effect with no agent open, so a G key, an
  item hash or a focus bookmark never lands on an empty page. Pressing a section row opens the
  agent (replacing any other in the same slot), selects the tab, which posts
  `{trigger:'open', name}` for that agent only, and calls `reloadAndPaint()` once; selecting the
  agent tab from another tab posts the same open, selecting it while active or switching inner
  tabs posts nothing. `PAGE_META.agent` gives the kicker "Mesh agent"; the title is the agent's
  name. The page header holds the state dot, name, state word, "checked …", **Refresh**
  (`{trigger:'refresh', name}` then `reloadAndPaint()`) and **Close**, which hides the tab,
  selects the Dashboard (an open for every agent) and, if focus was in the page in a focused
  window, focuses the agent's row, else the Agents heading. Esc does not close it. Its inner
  tablist (`wireTablist(…, 'horizontal')`) holds **Details**: the card's labelled lines and a
  nested Card JSON whose `<pre>` is rewritten only when `cardJson` changes, so a selection in it
  survives polls. Run history joins as the default in V5d; until then the page opens on Details.
  An agent that leaves `mesh.json`, or a body with `on: false`, keeps the tab and its last lines
  under "This agent is not in mesh.json any more". The open agent, inner tab and Card JSON state
  are window-local, never persisted (a reload has no agent tab), and join `frameInputs()` through
  `meshAgentPage.state()`. The tab never carries a count (`tabCounts()` has no `agent` key) and
  nothing on it reaches attention.
- The sidebar's Sessions line (`#sessionsIndicator`, #454, where the Live footer strip
  was) is the one session signal on every tab: `sessionsSummary` (`public/livebar.js`)
  over the GLOBAL `lastData.activity`, never the lens or closure ("N working · M
  connected", "N on an older build"; with none working, "M connected" over "all quiet",
  never "no task reported", #466). It, G L and the Now strip's Working tile open the
  Dashboard with the Agents home's heading focused, and each re-reads `/api/version`.
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
- Command-center polish (#307) adds no read and no answer surface. The keyboard help's "Dashboard" group is
  help-only (`legacy`) entries in `public/keys.js`; keep them legacy. The session
  panel (`.dash-focus`, from a card or ⌘K; since #454 mounted in the Dashboard grid
  itself, never inside a card or fold that can be hidden: a sheet over the grid's right
  side on a desktop; under 1280px static after its card's row (`placeFocusPanel`), closed by a trusted
  outside `click` that is not on a card, never a `pointerdown`, and never while it is in
  flow; closing returns focus to the card's first action, else the Agents heading) shows one card (`agentsHome.cardFor`, keyed by a session or a launch's
  card id): its state and summary, the launch's action bar, worktree, transcript and
  Resume and send (launch-ui.js's `paintPanel`, §9: none off), an app session's
  approval answered in place with its own options through `sendReply`'s signed path
  (#454 Q3), every other ask of the card answered in place in
  Asking you (#454 A.2, the Inbox's own `answerEl`/`rowAnswerEl`), the session's
  message composer (#411, `viewer-frontend.md`), its plan and
  outcomes open through `focusItem`, its PR/CI chips are ambient `sourceChipsHtml`
  and its links are #300's `cardLinks`/`linkStripHtml`. Parts are rewritten only when
  their markup changes; opening and closing move focus only in a focused window. Its
  handlers repaint their own region from `lastDashModel`, never a new render entry,
  and `focusSession` is in `frameInputs()`. ⌘K actions
  (`public/palette.js`): only the full names "answer ", "open plan ", "jump to
  session " (with the space) are commands and list targets first; a prefix of a
  name or hint only suggests the command and never
  outranks the top Open-item match. Answer opens the ask's session panel at that ask
  (`jumpToAsk`), or its Inbox card when no card holds it.

## Invariants in detail

- **Dashboard focus must not freeze monitoring detail.** Mount the structural frame
  and native range selector once, then refresh the Now strip, session cards, the Needs you
  rail, recent outcomes and history through the ambient painter. Preserve the
  range control's identity, value and focus across polls and history error/recovery.
  Reuse a focused outcome button while its result remains present; move focus to an
  adjacent control only when that result actually leaves and the viewer owns focus.
  This must not bypass the global held-pointer guard, create a third render entry,
  or pull keyboard ownership back from a background viewer.
- **Every ask is on exactly one session card, and the session panel's Asking you section
  is the Dashboard's answer surface (#454 amendment A.1–A.2, PR 5).** `attributeAsks`
  (`public/sessions.js`) gives each `waitingEntries` entry one card: the item's live
  session's (or a launch that remembers it), the plan's stamping session's, the newest
  working card the project + branch + agent join links, then (step 2) the newest idle or
  dormant card the same join matches; anything left (step 3) gets an **ask-only card**:
  one per session id (`item.session`, `boards.session`, "Session ended"), one per plan
  with no session and one per item with none ("No session"), state `ask`, in the main
  list and the ask's project, its agent kind from the ask, "last heard" from the newest
  item or stamped plan of that session. A card holding an ask is never folded. So the
  Needs you count equals `attentionEntries` under the Dashboard's project and agent lens
  (the badge with All projects); the Agents view never filters attention again
  (snoozed, pinned, stale and closed asks stay out because `attentionEntries` leaves them
  out). `test/sessions.test.ts` pins the parity over mixed fixtures. An ask-only card has
  no composer, actions or transcript; it is no launch feature, so it draws with the §9
  switch off. A card never answers in one click (A.6): its ask strip and Answer open the
  panel at that ask (focus on the ask's block, never an option), an ask-only card's Open
  in Inbox opens its Inbox card. The panel's Asking you section (`paintPanelAsks`) mounts,
  per ask, the Inbox's own `answerEl`/`rowAnswerEl` with `surface: 'compact'` (★, More…
  with Clarify, Decline and "I'll take a while", disclosure keys of its own, and Compare
  closed by default: it stacks each option over its tradeoff, `compactCompares`) plus Snooze 4h, Pin and Open in Inbox (`snoozeAsk`, `pinAsk`,
  `openAskInInbox`), the "the agent is waiting" meta, and this session's answers not yet
  picked up (`agentEntries`), dimmed and never counted; an `@sessions` approval keeps the
  Approval block (#459). Three draft rules hold for the section: a poll leaves
  it alone while one of its asks holds a draft or a background window remembers focus in
  it (and skips an unchanged one, moving only its ages); the hold is the panel's
  (`focusSession`), never its card's, because a card's id moves under an open panel (its
  session ends; an ask-only card's session comes back, when `followHeldAsk` moves the panel
  to the card now holding the drafted ask without rebuilding it, but only once the panel's
  own card has gone and focus is not elsewhere in the panel: while that card exists the
  panel never moves, though two working sessions trade a joined plan's row on every call);
  a forced paint rebuilds it; it
  restores focus (`captureCardFocus`, and `restoreDraftFocus` scoped to `#dashFocus`) only
  with the document's. Closing the panel drops its editors and keeps the drafts in
  `draftReplies`/`rowDrafts`; the card then says "Answer · draft". `jumpToAsk` and ⌘K
  "answer" open the panel at the ask (when the lens hides it, scoping to its project
  only where its session lives too, else clearing the lens: an `@sessions` approval's
  session is in the real project), the Inbox card when no card holds it; a notification still lands on the Inbox
  card. Keys (help-only `legacy` entries in `public/keys.js`): on a card itself, J/K and the
  arrows move between cards (one tabbable, `roving`) and Enter opens the panel at its ask;
  on an ask's block in the panel, 1–4 and R are the global keys scoped to the block
  (`keyboardActionScope`), S snoozes and P pins (`onPanelAskKey`); Esc closes the panel.
  The Inbox names each ask's session ("live · branch" while its session is listed,
  "session ended" when it names one that is not; `askSessionToken`) and its open card
  offers **Show on Agents ›** (`jumpToAsk`). Cards (A.3, V1–V5): one quiet meta line (state
  word, agent kind as text, an outlined "A" for started here, branch, time), what the
  session is doing leading, a secondary line (worktree, a working session's plan bar, or
  when a message reaches it), the ask strip (its kinds and ages), and the state's one
  action as a text button; build hints are the panel's and the Sessions line's; pink only
  for asks and green only for the working dot; group heads are small caps with session
  and ask counts; Ended, Dormant and Not delivered share one footer line. Under 1280px
  two columns, in a desk under 900px one, and the panel sits after its card's row
  spanning the cards' grid, so inline under its card at one column; it never moves while
  it is open and holds focus, unless it was cut off: the panel is the one `focusPanelEl`,
  never found by a selector; agents-home moves it out (`release`) before it removes a
  group or closes a fold, its own repaints call back into `placeFocusPanel`
  (`afterRepaint`), and a panel left disconnected or inside a hidden or closed ancestor
  always goes home (#463 review). Every such move goes through `moveKeepingFocus`
  (`agents-home.js`), which gives back the focus and a text control's selection the panel
  held, in a focused window only, and agents-home sends focus to its heading only when it
  was really lost. `test/dom/agents-asks.test.ts` pins the DOM half.
- **`sortRail` only reorders, and the Dashboard reads only the one predicate (#303, D2,
  D3, D8; the rail it fed retired by #454's PR 6).** `buildDashboard`'s `waitingEntries`
  IS `attentionEntries` under the Dashboard's lens (`relay.human`), so the session cards,
  the badge, the tabs and the dock cannot disagree, and `later` counts `laterEntries` for
  the header's "Later N ›". `sortRail` (`public/attention.js`) orders a card's asks: an
  item whose session is live (`classifyLiveness` → `waiting`) comes first, the rest keep
  `sortNeedsYou` order; never filter or add an entry there. A deferral from the Dashboard
  of an ask holding a draft switches to the Inbox (`keepDraftInView`), since no card shows
  a deferred ask. Never put `data-dashboard-focus-key` on an ask's block, or
  `restoreDashboardFocus` would move focus off its control onto it.
- **The Now strip and the session cards read one model, updated in place (#304, Dashboard
  2.0 phase 2, decisions D2, D4; the lanes it drew retired by #454).** `buildLanes`
  (`public/lanes.js`, pure, called by `buildDashboard`) reads only the reads the poll
  already makes: working is the claim and `last_call_at` alone (`isWorking`: not `idle`,
  and `last_call_at ?? started_at` within the 30-minute `CLAIM_COLD_MS`, re-checked against
  the clock because a snapshot ages); `updated_at` is never read there, so a session that
  only heartbeats is idle. A plan is drawn as done / in progress / waiting on you / to do
  over the Plans tab's own `countable`, where "waiting on you" is only rows
  `isBlockedRowAttention` counts. The Now strip's numbers come from the same call: working
  sessions and their subagents, the attention set and its oldest age, and plan steps as
  the working sessions' plan bars added up, each plan once; the card headings carry no
  numbers. The Agents home keeps cards keyed by id and writes only changed text and
  attributes, so an unchanged card keeps its nodes and selection; a rail draft never stops
  it, and a held pointer stops it with the rest of `paintAmbient`. A focused card control
  that leaves hands focus to the Agents heading only when the document had focus before the
  update: removing the focused node can itself make `hasFocus()` false. A background
  window's remembered focus is never moved. Order is pinned (`pinLaneOrder`): a card keeps
  its place, new ones append, and only a forced paint (`forcedAmbient`) re-sorts. **Session
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
  worst case: 30 days of 40 projects with 14 session cards and a full rail is ~730 Dashboard
  elements against the 1,500 budget).
- **Command-center polish reads nothing new (#307, Dashboard 2.0 phase 5, D2).** Three parts (#307's lane quick filters retired with the lanes, #454). (2) **Keyboard help** lists the
  Dashboard's keys as help-only (`legacy`) commands in `public/keys.js`, group "Dashboard":
  the session cards' J/K and Enter (`onKey` in `agents-home.js`, only on a card), the
  panel's 1–4, S, P and R, and Esc for the panel. Never make them non-legacy: the global handler would then take
  S and P everywhere. (3) **The session focus panel** (`.dash-focus`, mounted once in the
  Dashboard grid (#454): on a desktop a sheet over the grid's right side; below 1280px static, in flow
  after its card's row, never fixed over the masthead; `test/editorial-shell.test.ts`
  pins both, since jsdom cannot evaluate `@media`): a click on a session card that is not
  a control or a text selection opens it, and a second click on the same card closes it.
  It answers an app session's approval (#454 Q3) and, since #454 A.2, every other ask of
  its card in Asking you (the bullet above); its message composer (#411) shows while the
  session is listed in `/api/activity`, working or not; the plan and each recent outcome open through `focusItem`. `sessionFocus`
  (`public/lanes.js`, pure) picks the plan, the session's newest item (the source of its
  PR/CI chips when it has no plan) and its last three outcomes from `outcomeEntries`. PR and
  CI chips are `sourceChipsHtml`'s, ambient: nothing there reaches attention
  (`test/dom/dashboard-focus.test.ts` compares badge, title, tabs, rail, Now strip and both
  dock projections with and without `/api/links`). Links are #300's `cardLinks` of the asks
  and the plan, drawn by `linkStripHtml`, so `link-open.js` and main's checks own every
  click. The ambient painter updates it in place: each part is rewritten only when its
  markup changes (`setFocusPart`; Asking you by `paintPanelAsks`), so an unchanged poll writes nothing and a keyboard user
  keeps the same control by its focus key. Opening focuses the panel heading and closing
  (×, Esc in the panel) returns focus to the card's first action (else the Agents heading)
  only when the window has focus and focus was in the panel. A trusted `click`
  (`trustedInput`) outside the panel that is not on a card closes it and moves no focus,
  and only while it is a sheet: never a `pointerdown` (closing mid-press moved what was under the
  pointer), and never in the compact layout, where the panel is in flow (`position:
  static`) above the cards below it and closing it would lift them under the press. A session that stops working keeps
  the panel open on its card; one whose card leaves keeps it open with one line saying so. Its one-shot entrance
  (`dash-focus-in`) takes the motion tokens, is instant under reduced motion and listed
  under Calm. `focusSession` is in `frameInputs()`; its handlers repaint only their own
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
  Answer opens the ask's session panel at that ask (`jumpToAsk`, from any tab), and the
  Inbox card (`openAskInInbox`) only when no card holds it; open plan is
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
  the desktop inspector and resize handles, but below phone action cards and modal
  owners; raising only the child dropdown cannot escape a lower parent context. Closing
  results restores the normal header layer. It is a combobox index over Inbox, Notes, History,
  and active/archived Plans; it never filters the queue, project rail, tab badges, or the
  Sessions line. Results use one visible lifecycle hierarchy — Open items, Active plans, Notes,
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
