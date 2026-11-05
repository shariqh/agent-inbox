# Design: the Agents view as the home for sessions; retire Live (#454)

Status: proposal for the owner, with mockups. Nothing is built yet.

## §0 Summary

Live (the bottom strip and its drawer) and the Dashboard's Agents view (mesh M1, #397) show the same
sessions twice, and the actions for app-started sessions (#412, #432) live only in the drawer. This
design makes the **Agents view the one place to see and act on every session**:

- one **session card** per session, whether a terminal Claude Code or Copilot session (presence
  only) or a session Agent Inbox started (a launch, with or without a live presence row);
- a **session panel** (today's Dashboard focus panel, #307, grown) with the transcript, the
  composer, the approval, the worktree and every action;
- **Live removed**: no `#liveBar`, no drawer. A small, global **Sessions indicator** in the sidebar
  keeps the at-a-glance health the strip gave on every tab;
- **always on**: `mesh.json` stops gating the view. Starting sessions keeps its own switch and the
  driven-sessions §9 off contract.

It reads nothing new: `/api/activity`, `/api/messages`, the attention set and (switch on only)
`/api/launches`, exactly what Live and the lanes read today. The driver, worktrees and approvals do
not change.

## §1 Inventory: what Live does today, and where it goes

| Live function today | Where it lands | Notes |
|---|---|---|
| Strip: dot and "N reporting work" (`liveSummary`), global, never lens-filtered | Sidebar **Sessions indicator** (§3.5) | Same freshest-tone rule; still global presence, never attention |
| Strip: per-session `project/agent` chips | Dropped | The Agents card lists them; the strip's chips were never actionable |
| Strip: "older build" marker | Indicator says "N on an older build"; card chip; full hint in panel | `sessionBuild()` unchanged |
| Drawer open, pin, outside-click and Esc close, `G L` | Dropped; `G L` becomes "Sessions" (focus the Agents card) | The panel has its own Esc (as #307's does) |
| Drawer: active entries with `doing`, `detail`, age, project dot | Session card (doing, recency); `detail` in the panel | Age keeps `last_call_at`, never `updated_at` |
| Drawer: children table ("▸ N reported agents") | Card line "2 subagents"; table in the panel | As the lanes draw them today |
| Drawer: idle fold ("N connections · no task reported") | Cards in the **Idle** state; dormant ones (8 h) in a **Dormant (N)** fold | `isDormant` unchanged; never removed, as #45 requires |
| Build label and hint per entry (#197) | Card chip only when older or newer; label and hint in the panel | `/api/version` read at boot, on panel open, after a Setup install |
| Message button and drawer composer (#411) | Card's **Message** opens the panel with its composer | One kept node per session (`composerEl('focus', …)`); the `drawer` host goes |
| Composer delivery states, Interrupt and send, history, Withdraw | Panel composer, unchanged | `deliveryState` is the one rule |
| "Not delivered (N)" fold, global | Fold at the end of the Agents card, still global | Copy text, Withdraw, ten shown, "+M more" |
| "Started from Agent Inbox" section and launch rows | One card per launch, merged with its driven session's presence row | `launchStatus` is the state rule |
| New session… | Agents card header (owned window, switch on) | Disabled with its note when not granted, as now |
| Stop, End, Close, Park now, Take over / Resume in Terminal | Panel action bar; the state's main action also on the card | Same bridge calls, same grant checks |
| Open in Terminal, Remove worktree… (#432) | Panel action bar and worktree box | Remove only once ended, as now |
| Worktree line and summary (`launchWorktreeLine`) | Card worktree line (short); panel worktree box (full) | Unchanged words |
| Resume and send (step 5) | Panel, in place of the composer, for parked or resumable sessions | Same 60 s wait for the session to come back |
| Transcript (modal `<dialog>`) | Panel **Transcript** section, not modal | Same 2 s timer, only while the panel shows it |
| Newest five ended launches; "Earlier sessions (N)" | **Ended (N)** fold, with "Earlier sessions (N)" inside | A kept worktree keeps its launch listed, as now |
| "Started here" tag and Stop on a lane | Card chip "Started here"; Stop in the panel | Lanes retire (Q1) |

**What already exists, and the overlap.** The Agents view groups `/api/activity` by agent kind,
then project and branch; it shows state (working / idle / dormant), last call, a summed call trace,
"Asking you: N" read from the attention set, and `driven`/`started here` chips. Its Message
button opens the Live drawer. The Dashboard lanes ("What's being worked on", #304) show only
*working* sessions, with plan bar, children, asks, trace and the focus panel (#307), whose composer
is the second composer host. So a working session appears in the lanes, in the Agents view and in
Live; an app launch appears in the Agents view and twice in Live (its launch row and its presence
row); an approval shows in the rail, while Live's composer only says a message waits behind it.

## §2 The model: one card per session

A new pure module, `public/sessions.js`, builds the cards from the frame's existing reads:

- each **launch** (switch on only) is one card, joined with its live driven presence rows
  (`launchSessions`), whatever its state, so a parked or ended launch keeps its card;
- each **other presence row** (terminal Claude Code, terminal Copilot, an older driver) is one card;
- **asks** are the lanes' rule: an item whose `session` is one of the card's sessions (the driver
  files `@sessions` approvals with the driven session's id), or a row of the card's linked plan
  (`linkedPlan`). Read from the frame's attention entries; nothing is fed back.

**States**, highest first. One label, one tone:

| State | When | Card's main action |
|---|---|---|
| Needs you (pink) | any ask attributed to the card | Review (opens the panel at the ask) |
| Didn't start / Not responding (red) | `launchStatus` `failed` / `lost` | Details / Close |
| Starting… / Stopping… | launch `starting` / `stopping` | Transcript |
| Working | `isWorking(row)` | Message |
| Idle | present, not working, not dormant (a running launch whose turn ended) | Message |
| Parked | launch parked, or stopped with its session kept (`resumable`) | Resume… |
| In Terminal | launch `handed_off` | Resume in Terminal |
| Ended | launch ended | Open in Terminal (worktree kept) or Transcript |
| Dormant | presence quiet ≥ 8 h (`isDormant`) | Message |

## §3 The Agents home

### 3.1 Layout

The Agents card takes the lanes' place in the Dashboard grid; the Needs-you rail, ribbon and Just
landed stay. The header holds the title, state filters with counts (All · Needs you · Working ·
Idle · Parked), **Group by** (Project, the default, or Agent) and **New session…**.

Grouping proposal (Q2): **project, then branch**, with the agent kind as a chip on each card.
App sessions run in per-branch worktrees, and you think in projects; grouping by agent kind (M1)
mostly yields two groups, `copilot` and `claude-code`. Within a group, cards sort by state rank,
then newest call. Order is pinned between forced paints, as the lanes' is (§10 rule 5). The end of
the card holds folds: **Ended (N)** (with Earlier sessions), **Dormant (N)**, **In closed projects
(N)** (presence is not attention, so closing a project must not hide a session completely now that
the drawer is gone), and **Not delivered (N)**.

### 3.2 Card anatomy

1. State dot and label; agent chip ("Copilot · started here" or "Claude Code · terminal"); recency
   ("last call 12s ago", "idle 47m", "parked 2h").
2. What it is doing: `activitySynopsis` (current claim, else "was: …"), or the launch summary
   (`launchSummary`) when no presence row exists.
3. Where: branch, and for a worktree the short summary ("2 ahead · 5 files · 1 uncommitted").
4. Working sessions only: plan bar and count (`planBar`), "2 subagents", the 30-minute call trace.
5. Asks: a pink strip with the first ask's title and "+N"; for an approval, its tool line.
6. The state's main action (§2) and, for sessions with a composer draft, "Message · draft".

A click anywhere on the card that does not end a selection opens the panel, as a lane does today.

### 3.3 The session panel

The panel is `.dash-focus` (#307) grown: a sheet over the right side of the Dashboard grid (about
620 px, covering the rail while open), in flow below the list under 1280 px. Sections, top down:

- **Head**: state, project · branch, agent, the launch summary (mode, model, tool calls, active
  time), build label and hint; **Close** (Esc).
- **Actions**: from `launchStatus(...).actions` and the grant, exactly as the drawer row today:
  Message, Park now, Stop/End, Close, Take over in Terminal / Resume in Terminal, Open in Terminal,
  Remove worktree…. A terminal session gets Message only.
- **Approval** (Q3): an open `@sessions` approval with its own option buttons and the shell
  warning, sent through the same `sendReply` → `agentInboxLaunch.approve` path; other asks list as
  today and jump to their rail or Inbox card.
- **Worktree**: path, branch, summary, removed state.
- **Transcript** (app sessions): `transcriptLines` in a scrolling list, newest at the bottom.
- **Composer**: the session's one composer with its delivery line, Interrupt and send, history and
  Withdraw; for a parked or resumable launch, **Resume and send** instead.
- **Context**: `detail`, children, plan, recent outcomes, PR chips and links (#307's parts).

A terminal session's panel has no transcript or action bar: its head, asks, composer and context.

### 3.4 Terminal sessions beside app sessions

Both get the same card and states. A terminal card's chip says "terminal"; it has no worktree line
(only its branch), and Message says when it arrives ("when it next checks Agent Inbox", or "arrives
now" with `push_wake`/`wakes`). An app card's chip says "started here", and its actions come from
the launch. A driven session another app or a CLI driver runs shows "driven" with Message only.

### 3.5 Replacing the strip: the Sessions indicator

A small block in the sidebar above Settings, on every tab: a dot with `liveSummary`'s
freshest-tone rule and the counts "2 working · 5 connected" (working by `isWorking`, so it agrees
with the Now strip and the cards), plus "1 on an older build" when one is. It is
**global** (never lens- or closed-filtered, like the strip), presence only (no attention tone, no
badge, no "needs you" number; the Inbox tab owns that), and a click opens the Dashboard with the
Agents card focused. On the Dashboard, the Now strip's **Working** tile now targets the Agents card
instead of opening Live. Collapsed sidebar: just the dot, with the label as its title.

### 3.6 Empty and loading states

- Before the first `/api/activity` read: card body "Reading sessions…"; indicator "Checking
  sessions…" (today's "Checking connections...").
- No sessions: "No sessions yet. A Claude Code or Copilot session appears here once Agent Inbox's
  MCP server starts in it." The header's **New session…** stays when the switch is on.
- Filters match nothing: "No session matches these filters", with **Show all**.
- A launch without its presence row yet: the card shows Starting… with `START_PHASES`' words.

## §4 Rules

- **Always on.** The Agents view no longer depends on `mesh.json`: `app.js` imports it statically,
  `/api/version` never carries `mesh`, `viewer-server.ts` stops its `mesh.json` stat watch (the
  §2.1 exception goes until M3 needs it), and Settings → Mesh goes. `meshctl` stays for later
  phases: `enable --agents-view` writes nothing and says "The Agents view is always on; mesh.json
  no longer controls it"; `status` says the same; `disable` is unchanged; an `agentsView` key in
  an existing file is kept, like any key it does not own. This amends the mesh design's §2.2 (its
  M1 row), §2.4 (b) and §10.2.
- **The §9 off contract still holds for starting sessions.** With "Start sessions from Agent
  Inbox" off, in a browser or in a viewer the app does not own, the page reads no `/api/launch*`,
  draws no launch card, New session, action bar, transcript or worktree box, and binds nothing
  for them. The DOM test that boots with the switch off keeps its byte-identical reads and ETags.
  Terminal cards and Message (#411) are not part of §9 and work everywhere.
- **One attention predicate.** "Needs you" and the asks read `waitingEntries`; nothing in the
  Agents home, the panel or the indicator reaches `public/attention.js`, a badge, a count, the
  rail order or the dock.
- **No new render entry.** The card and panel paint from `renderDashboardAmbient` (both entries,
  `load()` and `reloadAndPaint()`); the indicator paints from `paintAmbient`, where
  `renderLiveBar` did. Cards update in place keyed by session or launch id, as lanes do.
- **`frameInputs()`** gains the window-local state: filter, group-by, the open panel's id, open
  folds. `launchUi.version()` and the build info stay. An idle tick paints nothing (#298).
- **Drafts and `suspendState()`.** Message drafts stay durable and never pause the list; the
  composer is one kept node; Resume and send text and the New-session task keep their current
  rules (`launchUi.drafts()`, `held()`). An inline approval has no editor, so no draft.
- **Motion.** No infinite animation; a working card pulses once on a new call, as lanes do (#304).
- **Text.** Agent text through `textContent` or `esc()`; focus restored by value, never a selector
  built from agent text.

## §5 Migration and removal

Four PRs, each shippable; Live stays until the last, so nothing is lost on the way.

| PR | Content | Size (prod / tests) |
|---|---|---|
| 1. Ungate | Static import; Agents the default lens; viewer watch, `/api/version` `mesh`, Settings → Mesh removed; `meshctl` message; `mesh-view.js` → `agents-home.js`; `mesh.md` | S: ~120 / ~150, net deletion |
| 2. Session cards | `public/sessions.js` (cards, states, asks); card anatomy; folds; New session in the header; lanes' plan bar, children, trace on working cards | M: ~450 / ~400 |
| 3. Session panel | `.dash-focus` grows: action bar, approval (if Q3), worktree box, transcript section (dialog retired), composer host, Resume and send | L: ~500 / ~400 |
| 4. Retire Live and the lanes | Remove `#liveBar`, drawer, `renderLive*`, `liveDrawKey`, `openLive`, drawer composer, `paintDrawer`, `paintLane`, lanes card, `.live-*` CSS; add the indicator; `G L`, Now strip and Esc wiring; docs | M: ~150 added, ~1,400 removed |

**DOM tests.** Keep as they are: `driven-sessions` §9 off boot, `conditional-poll`, `idle-frame`
(plus new frame inputs), `closed-projects` ("presence is not attention"), `ask-sort`. Rewrite
for the new host: `session-messages` (drawer → panel; composer behaviour unchanged),
`driven-sessions` (drawer rows → cards and panel), `live-build` (card chip, panel hint, indicator
count), `live-decay` (Dormant fold), `dashboard-focus` (panel), `dashboard-lanes` (one-shot pulse
and trace on cards), `mesh-view` → `agents-home` (drops the mesh-off boot; keeps "reads nothing
new" and "never feeds attention"). Delete `live-drawer` after porting its focus and scroll rules.
Unit: `test/mesh.test.ts` loses the viewer watch and `/api/version` cases and gains the `meshctl`
message; `test/livebar.test.ts` keeps `liveSummary` (the indicator uses it); `shell`,
`editorial-shell` and `tabs` lose the footer.

**Dead exports.** `installMeshView`'s `ALLOWED` and `ENTRY_POINTS` entries go (the import is
static); `watchMeshConfig`, `MESH_STAT_INTERVAL_MS` and `meshState` go if nothing else reads them;
`launch-ui`'s `paintDrawer`/`paintLane`; `livebar.d.ts` follows.

**Docs.** `activity-and-live.md` (becomes "Activity, presence and the Agents home"),
`viewer-frontend.md` (composer hosts, `liveDrawKey`), `viewer-dashboard-and-shell.md` (lanes,
footer, indicator), `mesh.md` and `CLAUDE.md` ("Mesh is opt-in: off means off" now covers M2 and
later), `driven-sessions.md` (the page part), `attention-and-later.md` (the "Live presence" line),
`docs/reporting-snippet.md` ("your session appears in the human's Live view" → Agents view, which
reaches every installed host's instructions), `README.md`, `CHANGELOG.md`.

## §6 Questions for the owner

1. **Retire the lanes too?** The Agents card would carry the lanes' plan bar, children and trace,
   and the Sessions | Agents lens would go. *Recommended: yes*; otherwise working sessions still
   show twice on the Dashboard.
2. **Group by project, then branch** (agent kind as a chip, "Group by: Agent" one click away),
   instead of M1's agent kind first? *Recommended: project.*
3. **Answer app approvals inside the session panel?** This amends #303's D2 (the rail is the
   Dashboard's one answer surface) for `@sessions` approvals only: they take only their own options,
   no editor and no draft, through the same signed path; the rail still lists them.
   *Recommended: yes*, so you approve with the transcript in view.
4. **A Sessions indicator in the sidebar** in place of the strip, or nothing beyond the Dashboard's
   Now strip? *Recommended: the indicator*; it is the only session signal on the other tabs.
5. **Drop the viewer's `mesh.json` watch and Settings → Mesh until M3**, keeping `meshctl` for the
   later phases? *Recommended: yes*; nothing reads the file once the view is always on.

## Mockups

Static HTML mockups (synthetic data, built on `public/style.css` tokens) of the Agents home, the
session panel and the Dashboard header without Live are shared with the owner separately; they are
not committed.

## § Amendment: every ask in the Agents view, no Dashboard rail (2026-11-04)

After trying PRs 1–3 (#457, #458, #459), the owner asked why the Inbox showed different asks
than the Agents view. Every surface starts from `attentionEntries`, but `sessionCards` puts an ask
on a card only when its session still has one. An ask from a Claude Code session that has ended
therefore showed in the Inbox and the Dashboard rail, but not in the Agents view. His decision:
**the same asks in two layouts.** The Agents view shows every ask, grouped by session. The Inbox
stays the triage list, by ask. The Dashboard's Needs-you rail goes. The driver, approvals and the
attention predicate do not change.

### A.1 Every ask has a card

`attributeAsks` (`public/sessions.js`) keeps its order and gains two last steps:

1. An item goes to the card of its live session, then to a launch that remembers the session. A
   plan row goes to the card of the session that stamped its plan, then to the newest working card
   by the project + branch + agent join (`linkedPlan`).
2. **New:** an unowned plan row joins an idle or dormant card by the same join, so an idle
   session never looks ended.
3. **New:** anything still unowned gets an **ask-only card**. There is one per session id (an
   item's `session` or the plan's `boards.session`) and one per plan when the plan has no session.
   - It is labelled **Session ended** when the session id is known, else **No session**.
   - Its state is always `ask`, its place is the main list, and it sits in the ask's project.
   - It shows the agent kind (`item.agent` or `board.agent`), and "last heard 2h ago" from the
     newest item or stamped plan that session wrote. No activity row is needed.

The invariant this adds: **every attention entry is on exactly one card**, so the Needs you filter
equals `attentionEntries(...)` under the Dashboard's project and agent filter. With All projects,
it equals the Inbox badge. Snoozed, pinned, stale and closed-project asks stay out because
`attentionEntries` leaves them out; the Agents view never filters again. An ask-only card has no
composer, actions or transcript: it is the ask, its context and "Open in Inbox". It is not a
launch feature, so it draws with the §9 switch off. An `@sessions` approval keeps its rule: its
options show only in the app's own window.

### A.2 Where the rail's abilities go

The rail (#303) mounted the Inbox's own `answerEl`/`rowAnswerEl` with `surface: 'rail'`. The
session panel's **Asking you** section now mounts the same two functions, one block per ask, with
`surface: 'compact'` (the rail's surface, renamed). There is still one answering implementation.
The card's ask strip only opens the panel at that ask.

| Rail today | After |
|---|---|
| Option pills with ★, Compare, free text, More… (Clarify, Decline, I'll take a while) | Panel ask block, same `answerEl` |
| Blocked row: options, I've done my part, words | Panel ask block, same `rowAnswerEl` |
| Snooze 4 h, Pin, Open in Inbox | The same icons on each panel ask (`snoozeAsk`, `pinAsk`, `openAskInInbox`) |
| Top three, "+N more" | Gone: every ask is on a card, and the Needs you filter lists them |
| "N in Later" | "Later N ›" in the Agents header, opening the Inbox's Later section |
| Open Review queue | "Review queue" in the Agents header |
| "agent waiting" chip | Panel ask meta "the agent is waiting" (`liveness: 'waiting'`) |
| Draft rules: a draft pauses only the rail; a forced paint rebuilds it; focus restored only with document focus | The same three rules on the panel's ask section. Drafts stay in `draftReplies`/`rowDrafts` (`suspendState()`, durable drafts, restart hold); `restoreDraftFocus` is scoped to `#dashFocus` |
| A card with a draft stays expanded | A panel ask with a draft stays open. Closing the panel keeps the draft, and the card says "Answer · draft" |
| Deferring an ask that holds a draft switches to the Inbox (`keepDraftInView`) | Unchanged |
| Keys on a card: J/K, 1–4, S, P, Enter | J/K and the arrows move between cards (roving tabindex), and Enter opens the panel. In the panel: 1–4, S, P, R (reply), Esc |
| Stale fold, answered-awaiting-pickup foot | Never on the rail; they stay in the Inbox. The panel shows this session's answered-but-not-picked-up asks dimmed (`awaitingAgentRows`, `repliedEntries`), never counted |
| Now strip "Waiting on you" → the Inbox | Turns on the Needs you filter and focuses the Agents card; G I still opens the Inbox |
| `jumpToAsk` → rail card | Opens the ask's session panel at that ask |
| ⌘K "answer …" → rail or Inbox card | The session panel's ask |
| Notification click | Unchanged: it lands on the **Inbox** card (`location.hash` → `focusItem`), not the rail |

The Inbox gains one thing for consistency: each ask row says "live · branch" or "session
ended", and the open ask offers **Show on Agents ›** (the Dashboard, filtered to its project,
with that card's panel open). The card's "Open in Inbox" goes back.

### A.3 Visual cleanups

The owner called the PR 1–3 cards "pretty bad". These are the cheap fixes, shown in mockup (e):

- **V1 Fewer chips.** No "Copilot · started here" pill. The agent kind is plain text in the meta
  line, with a small outlined "A" for a session started here. Build hints move to the panel and
  the Sessions line.
- **V2 Hierarchy.** What the session is doing leads (13.5 px, up to two lines). One quiet meta line
  above it holds the state dot and word, the agent, the branch and the time. A secondary line holds
  the worktree summary or the delivery hint.
- **V3 Calmer colour.** Pink only for asks (the ask strip and the Needs you count). Green only for
  the working dot. State words, chips and folds are neutral. No tinted backgrounds except the ask
  strip.
- **V4 Density.** With the rail's column freed, the card spans the grid: three columns at 1440 px,
  two at 1280 px, one below 900 px. Group heads become small-caps labels with counts and a
  hairline. Ended, Dormant and Not delivered share one footer line.
- **V5 One visible action.** Each card shows its state's main action as a text button, plus
  "Open in Inbox" on ask-only cards. Everything else is in the panel.

Narrow windows: under 1280 px the panel opens directly after the selected card's row, spanning
the grid, instead of after the whole list. Below 900 px that is inline under the card (mockup (h)).

### A.4 Tests

- **Unit, `test/sessions.test.ts`.** Parity over mixed fixtures: live, ended and unknown
  sessions; stamped, joined and unstamped plans; closed projects; snoozed, pinned and stale asks;
  an `@sessions` approval with the switch off. Each fixture checks Σ `card.asks` =
  `attentionEntries(...)`, each entry exactly once. Also: one ask-only card per session id, the
  "Session ended" and "No session" labels, the idle-join fallback, and "last heard".
- **DOM, `test/dom/agents-asks.test.ts`** (ported from `dashboard-rail.test.ts`, then deleted):
  - the Needs you count equals attention under each lens;
  - answering a question or a row from the panel sends the Inbox's exact request;
  - More… (Clarify, Decline, I'll take a while), Snooze and Pin;
  - drafts join `suspendState()`, durable drafts and the restart hold;
  - a poll leaves a drafting ask alone, and a forced paint rebuilds it;
  - focus is restored only with document focus;
  - the keys work;
  - the Waiting on you tile sets the filter;
  - ⌘K "answer" lands in the panel;
  - a notification hash still lands on the Inbox card;
  - with the §9 switch off, the reads are byte-identical and ask-only cards still draw.
- **Touched:** `keyboard-first` (rail keys), `editorial-shell`, `css-cascade`, `dashboard`,
  `dead-exports` (the dashboard model's `rail`, `RAIL_CARDS`, the rail's CSS).
- **Docs:** the rail invariant in `viewer-dashboard-and-shell.md` becomes "the session panel's
  Asking you section is the Dashboard's answer surface". Also `viewer-frontend.md` (draft hosts),
  `attention-and-later.md` (Later's entry point) and `CHANGELOG.md`.

### A.5 PR split (after PR 4 merges)

| PR | Content | Size (prod / tests) |
|---|---|---|
| 5. Every ask on a card | Attribution steps 2–3, ask-only cards, the parity test; the ask strip opens the panel; the panel mounts `answerEl`/`rowAnswerEl` with the icons and answered lines, under the draft rules; `jumpToAsk` → panel. The rail stays one more PR, drawing the same entries through the same functions | M: ~300 / ~350 |
| 6. Retire the rail; cleaner cards | Remove `#dashRail`, `renderDashRail`, `dashRailCardEl`, the dashboard model's `rail`; full-width grid; header Later and Review queue; the Now tile, keys and ⌘K; V1–V5 CSS; the narrow panel position; the Inbox's session token and Show on Agents; docs; port and delete `dashboard-rail.test.ts` | M: ~250 added, ~450 removed / ~300 |

### A.6 Decisions (owner, 2026-11-04)

The owner approved the mockups and all four recommendations:

1. **The card does not answer in one click.** The ask strip opens the panel at that ask, which
   keeps one editor host and avoids a mis-click.
2. **A notification click lands on the Inbox card**, as today.
3. **Narrow windows:** the panel opens inline under its card.
4. **Inbox consistency:** each ask row carries the "live · branch" or "session ended" token, and
   the open ask offers **Show on Agents ›**.

Mockups (e)–(h), with numbered callouts, are shared with the owner separately and not committed.
