# Design: mesh agent cards strip, agent tabs and run history (cards view V5)

**Date:** 2026-11-09
**Status:** Accepted by Shariq on 2026-11-09 (all six recommendations).
**Revised 2026-11-09 after review round 1:** §0, §1, §5.3–§5.9 (no request key by default, writes from
the meshctl entry and on signals, end-time order, cap and torn-line rules, retention on enable and
disable, `--purge` for every agent, forgetting through `meshctl`), §6–§13 (web search keeps only
the common fields; V5c split into V5c1 and V5c2; new tests; Q3, Q4 and Q6). Decisions recorded in
§13 the same day.
**Scope of this PR:** this document. No source, test or workflow changes.
**Refs:** #397 (the mesh), #507 (the agent cards view design), #509, #514, #516, #518 (V1–V4).
**Builds on:** the agent cards view
([`2026-11-09-agent-cards-view-design.md`](2026-11-09-agent-cards-view-design.md), called "the
cards design" below) §2, §4.5–§4.7, §5, §6; unslop
([`2026-11-06-unslop-a2a-agent-design.md`](2026-11-06-unslop-a2a-agent-design.md)) §4.2;
request-post ([`2026-11-07-request-post-a2a-agent-design.md`](2026-11-07-request-post-a2a-agent-design.md))
§5, §7; web search ([`2026-11-09-web-search-a2a-agent-design.md`](2026-11-09-web-search-a2a-agent-design.md))
§4.5, §12.2.
**Amends:** the cards design's §1, §2.1–§2.3, §2.6, §3.2, §4.5, §4.7, §5.2, §6 and §7;
`docs/architecture/mesh.md`, `viewer-dashboard-and-shell.md` and `attention-and-later.md`
(§9 lists the exact text).

---

## §0 — Summary

1. **Ask (Shariq, 2026-11-09, after trying V3):** "i'd like to see the mesh agents as literal
   cards that i can horizontally scroll. click them should open the stuff that it drops down right
   now as a tab. another tab should be a "run history" tab and that should be the default view."
2. **Cards.** The Mesh agents section keeps its place and header (disclosure, "checked 1m ago",
   Refresh) but its rows become a horizontal strip of fixed-width cards. Each card shows the
   state word, where the agent runs, its version, unslop's usage line and the last run. The strip
   is one Tab stop with arrow-key focus and a CSS-only edge shade, and it is still global and never
   attention (§2).
3. **Open as a tab.** I read the request as two tab levels: clicking a card opens the agent in a
   tab, and that view has its own tabs. Decided: **one agent tab in the library's tab list**,
   shown only while an agent is open, named for the agent, replaced when another card is opened,
   closed by its Close button, never counted and never restored after a reload (§3; decisions 1, 2).
4. **Inside the agent tab:** two tabs, **Run history** (the default each time an agent opens)
   and **Details** (exactly what V3's expanded row shows, Card JSON included, with the same
   selection rules) (§4).
5. **Run history needs a record the app does not keep today.** Decided: the `meshctl` entry
   that runs each client (`unslop`, `request-post`, later `web-search`) appends one JSON line per
   run to `<mesh dir>/mesh/runs/<agent>-<date>.jsonl` (0600, in a 0700 folder). It writes after a
   normal exit, after an internal error, and from a signal handler when the run is killed. Each
   record has a closed set of fields: end time, duration, operation, exit code, outcome word and a
   few fixed-vocabulary facts. Never text, prompts, queries, answers, titles, URLs, request keys or
   tokens. Records are kept 30 days (decision 6). The viewer only reads them, through a new conditional
   route, and only while an agent tab shows Run history. Forgetting is a `meshctl` command, so the
   viewer still writes nothing under the mesh dir (§5; decision 4).
6. **Off still means off.** With no `mesh.json`, nothing changes: no strip, no tab, no reads, the
   same boot requests. A client whose agent is off writes no record (§7).
7. **Six slices,** each under about 300 production lines and mergeable alone; the last waits for
   web search's client (W5b) (§8).

---

## §1 — Goal, scope and non-goals

**Goal.** See each configured mesh agent at a glance as a card, open one agent into its own view,
and see what it has done recently: when it ran, what kind of call it was, how it ended and how
long it took.

**In scope.** The card strip; one agent tab with Run history and Details; a run record written by
the `meshctl` entry for each client; a read route; `meshctl forget-runs` and `--purge` for every
agent; and the matching amendments.

**Non-goals.**

- No calling an agent from the app (the cards design's §1 stands).
- No in-flight runs: a run shows once its client ends. A request-post `wait` that runs for hours
  shows when it ends, at the top, because runs sort by end time.
- No search, filter or export in Run history. No charts.
- No caller identity in a record: not the session, not the project (decision 5).
- No change to the agents themselves (`packages/mesh`) or to the publishing service.
- No change to attention, the hub schema, the stdio MCP server or the dependency set.

---

## §2 — Decision 1: the card strip

### 2.1 Where and what

The section stays where the cards design put it: at the end of the Agents home, after the session
groups and before the Ended, Dormant and Closed folds, in the slot no filter or lens touches. The
header row is unchanged. The body becomes:

```
Mesh agents (2) ▾                                          checked 1m ago  [Refresh]
┌──────────────────────────┐ ┌──────────────────────────┐
│ ○ unslop                 │ │ ● request-post           │
│ Not running              │ │ Reachable                │
│ Local · v0.3.1           │ │ Remote · tailnet · v1.2.0│
│ Today: 12 tasks · 8 min  │ │                          │
│ Last run 14:02 · rewritten│ │ Last run Mon · filed     │
└──────────────────────────┘ └──────────────────────────┘
```

Each card, top to bottom:

1. The state dot and the `mesh.json` name, as today.
2. The state word from the cards design's §2.4 (page labels, server `reason`), on one line with
   an ellipsis when it does not fit. The `fix` line shows in amber under it when present.
3. Where it runs (short form: Local, Remote · tailnet, Remote · SSH tunnel; never the remote host)
   and the version, with "seen 2h ago" when the card is the last good one.
4. unslop only: the usage line from its budget file (cards design §4.6), unchanged.
5. The last run: "Last run 14:02 · rewritten", "Last run Mon · refused", or "No runs yet". The time
   is when the run ended: a clock time today, a weekday within the last 6 days, else a date. It follows the 30-second label clock,
   like "checked 1m ago". The value comes from the `/api/mesh/agents` body (§5.7), so the strip needs
   no extra read.

Cards no longer show the skill count, "A2A 1.0" or the description; those are in Details. A card
has a fixed width (232 px) and a fixed height, so the strip never changes height as text changes.
Every line clamps to one line with an ellipsis; the full text is in Details and in the card's
accessible description.

### 2.2 Markup and keyboard

- The strip is `<ul class="ma-strip" role="list">` (the explicit role keeps list semantics in
  WebKit with `list-style: none`). Each `<li>` holds one `<button type="button" class="ma-card">`.
  A card is one control. It opens the agent's tab (§3).
- **Accessible name and description.** The name is the agent's name and state word ("unslop, Not
  running"). The other lines are its description, through `aria-describedby` ids from a counter,
  never from a name. The card whose agent the agent tab holds carries `aria-current="true"` and a
  border in `--app-border-strong`.
- **Roving focus, like the session cards.** One card is tabbable: the last one focused, else the
  first. Left and Right move between cards, Home and End go to the ends, Enter and Space open
  (native button). Moving focus calls `scrollIntoView({ block: 'nearest', inline: 'nearest' })`
  with no `behavior`, so it never animates. J and K are the session cards' keys and are not
  reused here, so a key on a session card never jumps into the strip.
- The roving card is kept by `data-mesh-key` (the server's `key`), so a repaint never moves focus,
  and a card that leaves hands the tab stop to the first card.

### 2.3 Scrolling and the visible affordance

- `overflow-x: auto`, `scroll-snap-type: x proximity`, `scroll-snap-align: start` on cards, a
  10 px gap and `scroll-padding-inline: 2px` so a focused card's ring is not cut.
- **A visible affordance without JavaScript:** the compact tab row's background trick
  (`style.css`, the `#tabs` block under 1280 px). There is a shade at each edge while more cards
  wait past it, and none once scrolled to that end: a `local` cover scrolls with the cards and a
  `scroll` shade stays at the edge. Here it is used at both ends. The native scrollbar stays visible
  (`scrollbar-width: thin`, not `none`), so a mouse without a horizontal wheel can drag it.
- No previous and next buttons. They would need overflow measurement in script, which the jsdom
  harness cannot test, and the keyboard already reaches every card.
- **Reduced motion:** nothing animates. No smooth scrolling, no entrance and no pulse, the same as
  the cards design's "Motion: none".

### 2.4 One, two, many; narrow windows

- **One agent:** a single card at the start of the row, no shade (nothing overflows).
- **Two agents** (today) fit side by side in any Agents home wider than about 490 px.
- **Many** (three when web search lands, more with M3): the strip scrolls. Order is by name, as
  today. Grouping by host waits for M3, as the cards design's §9 says.
- **Under 620 px** a card is `min(232px, 78vw)` wide, so the next card always peeks past the
  edge.
- The section's disclosure still folds the whole strip, and its state is still window-local in
  `agentsHome.state()`.

### 2.5 Still global, still never attention

No state filter, project lens or agent lens narrows the strip, and it shows under the
zero-sessions empty text, as the cards design's §2.1 requires. Nothing on a card reaches
`public/attention.js`, a badge, a count, a tab count, the rail, the dock or a notification. Amber
is the warning colour, never the attention colour.

---

## §3 — Decision 2: where an opened agent lives

### 3.1 Reading the request

"click them should open the stuff that it drops down right now as a tab. another tab should be a
'run history' tab and that should be the default view."

The phrase "another tab" means the dropdown content becomes one tab and Run history another, with
Run history shown first. That fixes the inside of the opened view (§4). "Open ... as a tab" also
says the agent opens somewhere larger than a row. That place is the decision here.

Some facts about the app today:

- The library's tab list (`#tabs`, `public/tabs.js`) has five fixed tabs: Dashboard, Inbox, Plans,
  Notes, History. `TAB_IDS` is fixed, `selectTab()` is the single routing entry, the active tab is
  never persisted (`DEFAULT_TAB`), and tabs carry attention counts (`tabCounts`).
- A session card does not open a tab. It opens the **session panel** (`openSessionFocus`), a sheet
  over the Dashboard grid's right side on a desktop and in flow under 1280 px, with careful
  placement code (`placeFocusPanel`, `moveKeepingFocus`).
- Settings is a panel (`#setup`) shown without being one of the five tabs.

### 3.2 Options

| Option | For | Against |
|---|---|---|
| **A. One agent tab in the library's tab list** (chosen) | The literal reading of "open … as a tab". A whole page for Run history, which is a table. Leaving and coming back keeps it. Opening, closing and the page title follow the existing `selectTab`/`showPanel` path. | The tab list gains a tab that comes and goes. Tabs carry counts by convention, so this one must be pinned count-free. The compact masthead's tab row gets one more tab (it already scrolls with a shade). |
| B. A detail pane under the strip, with its own tab bar | Smallest change: everything stays in `mesh-section.js`, no routing. | Not a tab. The pane sits at the end of the Agents home, so a run table pushes the folds far down. The page is the Dashboard, so the Dashboard's poll gates and focus rules apply to a table. |
| C. The session panel's sheet, holding the agent | The same gesture as a session card: click opens a panel. | The panel's code is session-shaped (`focusSession`, `sessionFocus`, `cardFor`, placement after the card's row). Generalising it touches the riskiest part of the Dashboard (#463's review rounds). A sheet is narrow for a table. |

**Decision: A** (Shariq, 2026-11-09; §13 decision 1).

### 3.3 The agent tab, exactly

- **One slot.** `#tabs` gains a sixth tab, `data-tab="agent"`, after History, hidden while no agent
  is open. Its icon is the agent's state dot and its name the agent's `mesh.json` name. Opening a
  card shows the tab with that agent and selects it. Opening another card replaces the agent in the
  same slot (decision 2: one tab, not one per agent).
- **Routing.** `TAB_IDS` gains `'agent'`. `selectTab('agent')` returns without effect while no
  agent is open, so a key, a deep link or a stale caller can never land on an empty page.
  `wireTablist`'s keydown filter, which today skips only tabs inside a closed `<details>`, also skips a `hidden` tab, so arrow keys never land on it. `PAGE_META.agent` gives the kicker
  "Mesh agent" and the agent's name as the title.
- **Never counted.** `tabCounts()` returns no `agent` key, so `setCount('agent')` always hides
  its count. The attention test compares title, badge, tab counts, rail and dock with the agent
  tab open and closed.
- **Closing.** A **Close** button in the agent page's header (not inside the tab: a tablist owns
  only tabs) hides the tab and selects the Dashboard. If focus was in the page, it goes to the
  agent's card in the strip, else to the Agents heading, only in a focused window, as closing the
  session panel does. Esc does not close it; it is a tab, not a sheet.
- **Lifecycle.** The open agent is window-local and never persisted, like `activeTab`. A reload
  opens on the Dashboard with no agent tab. Leaving the agent tab for another tab keeps it in the
  list until it is closed or replaced.
- **When the agent goes away.** If `mesh.json` stops naming the agent, or the body says
  `on: false`, the page keeps its tab and shows one line, "This agent is not in mesh.json any
  more", and stops reading its runs. Nothing closes under the pointer.
- **The page** is `<section class="panel" id="agentPage" hidden>` in `main`. Its header has the
  state dot, name, state word, "checked 1m ago", **Refresh** and **Close**, then the inner tab bar
  (§4).

### 3.4 How the triggers map (cards design §4.5)

- **Opening an agent tab is an open for that agent only.** A card click, or selecting the existing
  agent tab from another tab, posts `{ "trigger": "open", "name": "<key>" }`. The route accepts
  `name` with `open` (today it accepts it only with `refresh`). The 60-second skip applies per
  agent, so clicking a card twice sends one check.
- Selecting the agent tab while it is already active posts nothing. Switching between Run history
  and Details posts nothing.
- The page's **Refresh** posts `{ "trigger": "refresh", "name": "<key>" }` and then repaints
  through `reloadAndPaint()`, as the section's Refresh does.
- The Dashboard's three open handlers are unchanged. Closing the agent tab selects the Dashboard
  through `selectTab('dashboard')` from another tab, which is an open for all agents, as today.
- **What paints.** The card click is a human navigation: the page paints at once from the last
  bodies, and the click calls `reloadAndPaint()` once so Run history is read without waiting for a
  tick. The open's check result still arrives through the next poll tick, as the cards design's
  §4.5 says.
- **The reads.** `/api/mesh/agents` is read while the last `/api/version` carried `mesh`, the
  document is visible, and the Dashboard **or the agent tab** is active. The run history read
  (§5.7) happens only while the agent tab is active, its Run history tab shows and the document is
  visible.

---

## §4 — Decision 3: the tabs inside the agent view

- A horizontal tablist with two tabs, **Run history** and **Details**, each with a `tabpanel`
  (`aria-labelledby`). It uses the roving `tabindex` and arrow keys of the app's other tablists
  (`wireTablist(host, 'horizontal')`), Home and End included.
- **Run history is the default** every time an agent is opened, including a re-open of the same
  agent from its card. While the tab stays open, the chosen inner tab is kept, so leaving for the
  Inbox and coming back keeps Details if that was showing. Window-local, never persisted.
- **Details** is exactly V3's expanded row: the labelled lines of the cards design's §2.3
  (Description, Card name, Where with the full endpoint, Protocol, Capabilities, Auth, Extensions,
  Skills, Modes, Checked) and the nested **Card JSON** `<details>`. The same rules apply: every
  card string through `textContent`, no `href`, no image, and the JSON `<pre>` rewritten only when
  `cardJson` changes, so a selection inside it survives polls. The code moves from
  `public/mesh-section.js`'s `details()` and `paintRow()` into the page module; the strings do not
  change. The full remote endpoint is still shown only here, never on a card.
- The page module's state (open agent key, inner tab, Card JSON open, rows shown) joins
  `frameInputs()` through its `state()`, as `agentsHome.state()` does.

```
┌ Mesh agent ──────────────────────────────────────────────────────────────────┐
│ ○ unslop  Not running · starts on its first call   checked 1m ago [Refresh] [Close] │
│ [ Run history ]  Details                                                     │
│                                                                              │
│ Last 48 runs: 44 ok · 3 refused · 1 failed · median 8.2 s                    │
│ Ended       What   Outcome      Took    Details                              │
│ 14:02       docs   rewritten    8.4 s   model 7.0 s · 1 attempt · rules 3f9a1c0e7b22 │
│ 13:40       pr     refused      0.2 s   screen: email                        │
│ 11:15       blog   kept original 31 s   fidelity · 2 attempts                │
│ …                                                                            │
│ [Show 50 more]                                                               │
│ Runs from the last 30 days are shown. Older records are deleted by this      │
│ agent's first run of a day, or the next time an agent is enabled or          │
│ disabled. Never the text sent or returned.                                   │
│ To forget them now: <the forget command> [Copy]                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## §5 — Decision 4: run history, the data

### 5.1 What exists today

| Agent | What already records a call | Why it is not enough |
|---|---|---|
| unslop | The agent appends `mesh/logs/unslop-<date>.log`, one JSON line per task (`taskId`, `kind`, `bytesIn`, outcome, status, reason, classes, attempts, timings). The budget file holds today's counts. | It misses every call that never reached the agent: a card mismatch, an agent that would not start, a timeout before submission. The format is a log, not a contract, and has no size cap. The cards design promised the viewer never reads logs. |
| request-post | Nothing on this Mac. The agent runs in the publishing service; the client writes only an optional `--report` the caller names. | No local record at all. |
| web search | The agent appends `mesh/logs/web-search-<date>.log` (`taskId`, query character and word counts, mode, outcome, ms). The client does not exist yet (W5b). | The same gaps as unslop's log. |

`--report` files belong to the caller, can hold result data (unslop's `failures` carry up to ten
80-character fragments of the text per class), and live wherever the caller puts them. They are not a
history.

### 5.2 Options for where the record comes from

| Option | For | Against |
|---|---|---|
| **A. Each client's `meshctl` process appends one record per run** (chosen) | One writer per agent on this Mac, for all three agents, request-post included. Sees every end, including runs that never reached an agent, internal errors and signals. One versioned schema the viewer can validate. The process already holds every field (its exit, the result's data part, its own clock). | A new file family under the mesh dir. Several processes may append at once (§5.6). |
| B. Derive history from the agents' logs | No new writer. | Nothing for request-post. Misses client-side failures. The viewer would read logs, which the cards design ruled out. Unbounded files. |
| C. The agents write a run file | Close to the work. | request-post's agent is remote, so it cannot write here. Misses client-side failures, the same as B. |

**Decision: A** (accepted with the design).

### 5.3 What a run is

One run is one client process, from the moment it has resolved its agent's `mesh.json` key (the
key passed `loopbackPort()` or `requestPostEndpoint()`) to its end. Earlier exits write nothing:
a usage error (4), and "off" (14 because the key is absent or its endpoint fails its rule). So a
client whose agent is off still writes nothing, and enabling then disabling an agent leaves the
tree as before.

| Agent | `op` | One run is |
|---|---|---|
| unslop | the `--kind` value (`pr`, `issue`, `release-notes`, `docs`, `blog`) | one `bin/unslop` call: one task, or no task when the card check or start failed |
| request-post | `file`, `status`, `wait` | one `bin/request-post` call; a `wait` is one run however many polls it made |
| web search (W5b on) | `answer`, `sources` | one `bin/web-search` call |

**Every end writes a record, not only a normal return.**

- **Who writes.** The record is written by the meshctl entry (`src/meshctl.ts`'s `isMain` block),
  not inside `runUnslop` or `runRequestPost`. The entry passes each run function a collector,
  `io.run`. The run function sets `armed` once the key passes its rule and fills in fields as it
  learns them (the op, the result's data part, the last phase a `wait` saw). After
  `await runX(…).catch(…)` returns the exit code, the entry builds the record from the collector and
  the code, and appends it. An internal error caught by the entry's `.catch(() => 13)` therefore
  writes `exit: 13, outcome: "failed", reason: "internal"`, with whatever fields were collected.
- **Signals.** Before calling the run function, the entry installs synchronous `process.once`
  handlers for `SIGTERM`, `SIGHUP` and `SIGINT`: a shell timeout, a session that ends, a detached
  `wait` that is killed, or Ctrl-C. If the collector is armed, the handler appends a record with
  `exit: null`, `signal: "<name>"` and `outcome: "interrupted"` through the same synchronous
  writer. In every case it then removes all three handlers and re-raises with
  `process.kill(process.pid, signal)`. The process still dies by that signal with the same exit
  status as today, and no asynchronous work (no `CancelTask`, no report) is added to the signal
  path. `SIGKILL` cannot be caught, so a `kill -9`'d run leaves no record; the design says so,
  and the page does not pretend otherwise.
- The usage and off exits leave the collector unarmed, so they write nothing on any path.

### 5.4 The record

One JSON object per line. Every field is optional except the common ones. Strings are limited to
closed vocabularies or tight patterns, so no field can carry free text.

**Common to every agent**

| Field | Type and rule | Meaning |
|---|---|---|
| `v` | `1` | schema version; a reader skips other versions |
| `id` | 10 base32 characters, random | the run's own key for the page (never the task id) |
| `agent` | `unslop`, `request-post`, `web-search` | which agent |
| `op` | per agent, §5.3 | what kind of call |
| `at` | ISO 8601 UTC, **when the run ended** | the one sort key, and the time the page shows |
| `ms` | integer ≥ 0 | the run's wall-clock duration; it started at `at − ms` |
| `exit` | integer, one of the agent's documented exit codes, or `null` when interrupted | the client's exit code |
| `signal` | `SIGTERM`, `SIGHUP`, `SIGINT`; only with `exit: null` | the signal that ended it |
| `outcome` | one word from the list below | how it ended, for people |
| `reason` | `^[a-z][a-z0-9-]{0,39}$` | the agent's or client's fixed reason or class name, when it gives one (`internal` for a caught error) |
| `classes` | up to 8 of `^[a-z][a-z0-9-]{0,23}$` | screen or refusal class names (never a matched value) |
| `task` | `^[A-Za-z0-9-]{1,64}$` | the agent's task id, for unslop and web search, to find the agent's own log line |

**Outcome words.** `ok`, `kept-original` (unslop 10), `sources-only` (web search 10),
`refused` (11), `busy` (12), `failed` (13, and internal errors), `unknown` (request-post 13:
outcome unknown), `unavailable` (14 with the key present: a card mismatch, an agent that would not
start, a missing token; and request-post 15), `conflict` (request-post 16), `timed-out`
(request-post 124), `interrupted` (a signal). The page maps each to its own words (§5.8).

**unslop**

| Field | Rule | From |
|---|---|---|
| `status` | `rewritten`, `unchanged`, `kept-original`, `rejected`, `busy`, `failed` | the result's `status` |
| `bytesIn` | integer | the draft's size in bytes, measured by the client |
| `attempts` | integer 0–9 | the result |
| `model` | `^[A-Za-z0-9._:/-]{1,64}$`, else omitted | the result's model name |
| `rules` | 12 lowercase hex | the first 12 of `rulesSha256`, as stderr prints it |
| `timing` | `{ queued, load, model, check }`, integers | the result's `ms` |
| `warnings` | up to 8 class names | the result's warning classes only, never `detail` |

**request-post**

| Field | Rule | From |
|---|---|---|
| `phase` | `^[a-z][a-z-]{0,23}$` (the service's phase words, such as `awaiting-go`, `ready-for-human`, `published`) | the data part; for an interrupted `wait`, the last phase it saw |
| `created` | boolean, `file` only | `true` filed, `false` already filed |
| `throughGo` | boolean, `wait` only | the flag |
| `channels` | up to 4 of `blog`, `x-thread`, `x-standalone`, `linkedin`; **exit 0 only** | the caller's arguments, once the service accepted them |
| `brand` | `^[a-z0-9-]{1,40}$`; **exit 0 only** | the same; a refused brand might be a typo or a name, so it is never kept |
| `fields` | up to 8 field names from the client's argument list | which fields a refusal named, never their values |

**Why no key (decision 3).** `--key` accepts any printable ASCII up to 128 characters
(`ID = /^[\x21-\x7e]{1,128}$/`), so a caller-chosen key such as `acme-launch-2026` would leave
`acme-lau` in a prefix. Keeping a key only in the derived form closes that. It does not close the
second leak: `requestKey()` is public code, a SHA-256 over brand, channels and the slug, source
URL or normalised title, and those are often guessable. Anyone who can read the runs file can test
a guessed title against a stored key or prefix. An 8-character prefix is 40 bits, plenty to confirm
a guess. So the record keeps no request key at all, derived or chosen. The run is still identified by its time,
op, phase, channels and brand.

**web search** (written by W5b's client; fixed here so it ships with the first version)

Only the common fields: `op` (`answer` or `sources`), `exit`, `outcome`, `reason`, `classes`,
`ms` and `task`. No other field. Web search's design promises that nothing about a query reaches
disk (§0 item 8). `--fresh` or a cache-hit marker would record that the same query ran within the
last 15 minutes, so neither is kept. The provider is not kept either: since #520 the trial runs on
SearXNG alone, so it would say nothing. Stage timings are not kept. The total `ms` is the one
duration the agent's own log already writes per task (`packages/mesh/src/web-search/agent.ts`), so
the record keeps no more than the log does. A very short run can still hint at a cache hit; §6 says
so.

A record is at most **512 bytes**, the optional torn-line `\n` (§5.6) included. The builder caps
every field so a full record fits. If a line would still be longer, nothing is written.

### 5.5 What is never kept

These are the agents' own promises, carried into the record. A test writes a canary into each
input and searches every runs file and every route body byte by byte (§8).

- **unslop:** the draft, the result text, `failures` (its lost, added and moved fragments),
  warning `detail`, the profile, the backend URL, the API key and the token.
- **request-post:** the brief, the title, the slug, the source URL, the category, the page URL,
  the page id, any request key (caller-chosen or derived), any
  `humanAction` or error text from the service, a brand or channel the service refused, and the
  token. The page URL is left out because Notion URLs carry the page title.
- **web search:** the query, the answer, every source URL, title and snippet, the query's
  character and word counts, `--fresh`, cache hits and the provider. **`record: true`** (web search
  §12.2) is the agent's trial sample, in its own `0700` folder. The client neither reads nor writes
  that folder. The run record has no field that could hold a query or an answer. The viewer never
  reads the folder. A test runs a canary query with `record: true` on and finds it in no runs file
  and no response.
- **Everyone:** environment variables, the working directory, arguments other than those listed,
  and stdin. Caller identity (session or project) is not kept (decision 5).

### 5.6 Where, and how the clients write it

- **Path.** `<mesh dir>/mesh/runs/` (mode 0700), files `<agent>-<YYYY-MM-DD>.jsonl` (mode 0600),
  where the date is the local date of `at` (the run's end).
- **One module.** `src/mesh-runs.ts` holds the schema, the record builder and validator, the
  writer `appendRun()`, retention, and (from V5b) the reader `readRuns()`. It imports only Node
  core. `src/meshctl.ts` imports it (the entry writes; `enable`, `disable` and `forget-runs`
  prune), and so does `src/mesh-agents.ts`. No `src/viewer*.ts`, `public/*.js` or `electron/*`
  file imports it, and its name does not match the text guard's patterns.
- **The folder.** `appendRun` creates only `runs/`, never its parents: if `<mesh dir>/mesh/` is
  missing, it writes nothing (an enabled agent always has it, for its token). It calls
  `mkdirSync(runs, { mode: 0o700 })` without `recursive`. On `EEXIST`, which happens when another
  client won the race, it goes on to the checks. Then it `lstat`s the folder: a symlink, a
  non-directory, another owner, or group or other write permission means nothing is written.
- **The file.** It opens the day file with `O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW |
  O_NONBLOCK`, mode 0600, and `fstat`s it: a regular file this user owns, else nothing is written.
- **The cap.** It writes nothing when `size + Buffer.byteLength(line) > 256 KiB`. Two clients can
  both pass that check and overshoot; the overshoot is at most one 512-byte line per concurrent
  writer. The reader allows for it (§5.7).
- **Torn-line repair.** Every write starts with `\n` (`\n<record>\n`), so a record that an
  earlier writer left without a newline cannot swallow this one; the reader ignores the empty
  lines this leaves. *Amended in V5a (#523):* the first version read the file's last byte and
  added the `\n` only when that byte was not one. On Linux that check races: a concurrent
  `O_APPEND` write grows the size page by page while it copies, and neither `fstat` nor a
  positioned read waits for it, so a writer saw another's record half-written and added a newline
  it never needed (CI, eight processes: 401 lines for 400 records). Writing the `\n` every time
  needs no read at all.
- **One write.** One `writeSync(fd, buffer)` of the whole line, newline included, with its return
  value checked. A short write is never retried, because a second write could land after another
  writer's line. The partial line fails to parse and the next writer's repair seals it. Never
  `appendFileSync`, which loops over partial writes.
- **Why this does not interleave, and why 512 bytes.** POSIX makes each `O_APPEND` write start at
  the current end of file with no other change in between, so records never overwrite each other.
  On a local volume (APFS on macOS; ext4 and similar on Linux), the kernel holds the file's vnode
  or inode lock for the whole write, so two small appends do not interleave. `PIPE_BUF` (512 bytes
  on macOS) is a guarantee about pipes and does not apply to files. The 512-byte limit here is a
  size bound, keeping every record one small write. The reader still skips any line that does not
  parse, so the worst case is one lost record, never the file. No lock file and no rename are
  needed, and no process ever rewrites a file.
- **Network mounts.** An `AGENT_INBOX_MESH_DIR` on NFS or SMB is unsupported for run history.
  Those filesystems do not make `O_APPEND` atomic across clients, so records may interleave or go
  missing. The reader's per-line validation keeps the damage to lost records.
- **Best effort.** Writing a record never changes the client's exit code, stdout or stderr. A
  failure is silent, because both clients' stderr is read by calling agents as protocol text.
- **Retention: 30 days (decision 6).** Files whose date is older than the period
  are deleted (regular files only, `lstat` first; `ENOENT` from a concurrent deletion is ignored)
  at three points:
  1. by `appendRun`, for its own agent, when the append has just created the day's file;
  2. by every `meshctl enable …` and `disable …` (with or without `--apply`, since deleting
     expired records is housekeeping, not a configuration change), for **every** agent;
  3. by `meshctl forget-runs` (§5.9).

  The reader never shows a file older than the period, whether or not it has been deleted yet. So
  a record outlives the period on disk only until that agent's first run of a later day or the next
  enable or disable, and the page's footer says exactly that.
- **Purge.** `disable --unslop --purge` also removes `runs/unslop-*`. `disable --request-post`
  gains `--purge`, which removes `runs/request-post-*` and nothing else (its token, key and shim
  are already removed by plain `disable --request-post`). W5a's `disable --web-search --purge`
  removes `runs/web-search-*` with its profile and deny list. Each purge then removes `runs/` if it
  is empty.

### 5.7 How the viewer serves it

- **The reader.** `readRuns(dir, agent, now)` in `src/mesh-runs.ts`. It reads only the runs
  folder (`lstat`: a real directory, owned by the user, not group- or other-writable) and only
  file names matching `^(unslop|request-post|web-search)-\d{4}-\d{2}-\d{2}\.jsonl$` for that agent,
  dated within the retention period, newest first. Each file is opened with
  `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` and `fstat`-checked (regular, this user's, no group or other
  write). This is V4's budget-read pattern. A file that fails a check is skipped and counted.
- **Size.** It reads at most the first **320 KiB** (the 256 KiB cap plus 64 KiB for concurrent
  overshoot) in one bounded `readSync` from the checked descriptor. A larger file is not skipped:
  its complete lines within the bound are used, and the body says `truncated: true`.
- **Validation.** Each line goes through the same validator the writer uses. Unknown fields are
  dropped, and a line with a wrong type or pattern is skipped and counted. A last line without a
  newline (a write in progress) and empty lines are ignored without a count.
- **Order.** Records are merged across files and sorted by `at` (the end time), newest first, with
  `id` breaking ties. A run that started long ago but just ended (a 4-hour `wait`) sorts by its end,
  so it appears at the top when it lands. Files named by the end date and lines appended at exit
  agree with that key; the sort makes the order hold even when they do not (two clients ending in
  the same millisecond, a clock change).
- **Caching.** At most one `readdir` and `lstat` pass per agent every 5 seconds, the same rule as
  `mesh.json`. Each file's parsed records are cached under its device, inode, size and `mtimeMs`,
  so past days are parsed once.
- **`GET /api/mesh/agents/runs?name=<agent>`** answers:

  ```json
  { "on": true, "name": "unslop", "runs": [ { "v": 1, "id": "k3m9q2x7pa", "op": "docs", "...": "..." } ],
    "older": false, "skipped": 0, "truncated": false, "keptDays": 30, "forget": "<the forget command>" }
  ```

  It returns the newest 200 runs and sets `older` when more exist within the period. `forget` is
  the exact forget command as text, built in `src/mesh-agents.ts`, so no page file names the
  command (§5.9). The body is built fresh per request with `Cache-Control: no-store` and an ETag
  over the bytes, answering 304 on a match, like `/api/mesh/agents`. It is not a retained snapshot:
  no `SNAPSHOT_SOURCES` entry and no trigger, and `test/fixtures/snapshot-triggers.txt` is
  unchanged. Without `opts.mesh`, or with the mesh off, it is `{ "on": false, "runs": [] }` and
  touches no file. A missing or unknown `name` is 400. A known name that `mesh.json` does not
  configure is 200 `{ "ok": false, "error": "not configured" }`. Reading never starts a card check
  and never writes or deletes anything.
- **`/api/mesh/agents` gains `lastRun`** per agent: `{ "at", "op", "outcome" }` from the newest
  valid record by `at`, or `null`. The body now changes when a run lands, which is a content
  change. With no new run the bytes are identical and the read is a 304, so an idle tick still
  paints nothing.
- **The page reads** `/api/mesh/agents/runs` as one more conditional read in the poll tick, only
  while the agent tab is active, its Run history tab shows and the document is visible. With the
  same fallback as `/api/mesh/agents`: a failed read keeps the last body marked stale ("could not
  read; showing what was last read"), never a failed tick. A skipped read keeps the last body.
  Opening another agent drops it.

### 5.8 The Run history tab

- **Summary line** over the runs returned: "Last 48 runs: 44 ok · 3 refused · 1 failed · median
  8.2 s".
- **A table** (`<table>`, `<th scope="col">`): Ended, What, Outcome, Took, Details.
  - Ended: the end time (`at`). A clock time today, else weekday and time within the last 6 days,
    else the date; the full local start and end times are in `title`.
  - What: unslop's kind; request-post's `file`, `status`, `wait` or `wait (through go)`; web
    search's `answer` or `sources`.
  - Outcome: page words ("rewritten", "unchanged", "kept original", "sources only", "refused",
    "busy", "failed", "outcome unknown", "unavailable", "conflict", "timed out", "interrupted",
    or the final phase for a request-post `status` or `wait` that ended 0). Amber for failed,
    unknown, unavailable, timed out and interrupted; the normal text colour for the rest. No green
    and no pink, keeping the Agents home's palette rule.
  - Took: `ms`, as "0.2 s", "31 s", "4 min", "3 h 50 min".
  - Details: the agent's facts joined with " · ". unslop: "model 7.0 s · 1 attempt · rules
    3f9a1c0e7b22 · 6.2 KB", "screen: email". request-post: "awaiting-go · blog, x-thread ·
    brand-a", "fields: channels". web search: the reason or classes, if any. An interrupted run
    adds "SIGTERM".
  Every value goes through `textContent`.
- **50 rows first**, then **Show 50 more** up to the 200 the route returns. When `older` is set,
  a last line says "Older runs in the kept period are not shown." The shown count is in the page's
  `state()`.
- **Rows are keyed by `id`.** Records never change, so a poll that brings a new run inserts one
  row at its sorted place, the top in practice (§5.7), and touches no other row. CSS scroll
  anchoring (`overflow-anchor`, on by default) keeps a scrolled table from jumping.
- **The one text that changes in an old row is Ended**, through the 30-second label clock: at
  midnight a time becomes a weekday, and after 6 days a weekday becomes a date. Only that cell's
  text node is rewritten, and only when its text changes, so a selection anywhere else survives. A
  selection inside an Ended cell can be lost at that moment, the same exception the cards design's
  "checked 1m ago" has.
- **Empty:** "No runs yet. Calls through this agent appear here once they finish; calls made
  before this version were not recorded."
- **Footer:** "Runs from the last 30 days are shown. Older records are deleted by this agent's
  first run of a day, or the next time an agent is enabled or disabled. Never the text sent or
  returned."
  Then "To forget them now:" and the route's `forget` text in a `<code>` element with a Copy
  control (§5.9).
- No word here names the client modules or the command, so the text guard holds: the command
  arrives as data in `forget`, built in `src/mesh-agents.ts`, as the cards design's §3.4 set up for
  `fix` strings.

### 5.9 Forgetting history (decision 4)

**A `meshctl` command, so `meshctl` stays the only writer under the mesh dir.**

```sh
npm run meshctl -- forget-runs (--unslop | --request-post | --web-search | --all) [--apply]
```

- Dry run by default, like every `meshctl` change: "Would delete 3 run files (48 runs) for
  unslop." `--apply` deletes them. It deletes only files the reader would read for that agent: a
  matching name, `lstat` a regular file this user owns, in a real runs folder. Symlinks and other
  files are left alone. It then removes `runs/` if it is empty, and also deletes expired files for
  every agent (§5.6).
- It works whether the agent is on or off, so a disabled agent's history can still be forgotten.
- The viewer stays read-only under the mesh dir: no write route, no grant, no new Electron
  surface. The cards design's "the view writes nothing" (its §4.7 and §8) still holds.

**Not chosen: a Forget history button in the viewer.** It would have reversed the invariant above,
giving the viewer its first delete route under the mesh dir, the folder that also holds `tokens/`
and `wrappers/`. Even with the same narrow file rule, a bug in that route would be a bug in a
process that can delete files next to the tokens.

---

## §6 — Decision 5: security and privacy

- **Untrusted text.** Records are validated on both write and read against closed vocabularies
  and patterns, and the page renders every value with `textContent`. A run record can never
  carry markup, a link or an image, and no field holds a URL.
- **Request keys, honestly.** A caller-chosen `--key` is never kept, in full or in part, because
  it is free text (§5.4). A derived key is a SHA-256 over inputs that are often guessable (brand,
  channels and a title or slug), computed by public code. Whoever can read the runs file can
  confirm a guessed title against a stored key, and an 8-character prefix (40 bits) is enough to do
  that. That is why the record keeps no request key at all (decision 3).
- **Web search durations.** A record keeps the run's total `ms`, the same duration the agent's
  own log already writes per task. A very short run can hint that the answer came from the
  15-minute cache, so that the same query ran shortly before. The record states no repeat
  (`fresh` and cache hits are not kept) and nothing about the query itself. The 30-day period limits
  how long even that hint stays on disk.
- **What a screenshot shows.** Cards show no remote host (as V3's rows). Run history shows no
  host, title, key or text.
- **Files.** 0700 folder, 0600 files, `O_NOFOLLOW` on both write and read, owner and mode checks,
  bounded sizes and bounded reads. The reader never follows a name it did not build itself.
- **Who writes under the mesh dir.** Still only `meshctl` and the processes it runs
  (the clients and the agents). The viewer reads `mesh.json`, unslop's budget and `runs/`, and
  writes nothing there.
- **Secrets.** Unchanged: the viewer never opens `mesh/tokens/*` or `mesh/wrappers/*`, never reads
  the agents' logs, and never reads web search's sample folder.
- **Network.** No new request leaves the viewer. Run history is local files only.

---

## §7 — Invariants kept, and what stays unchanged

| Invariant | How it holds |
|---|---|
| Off means off | No `mesh.json`: no strip, no agent tab, no `/api/mesh/*` read, `/api/version` byte-identical, and `test/dom/agents-home.test.ts`'s `BOOT_REQUESTS` unchanged. A client whose key is off writes no record. |
| The view writes nothing (cards design §4.7, §8) | Kept (decision 4): forgetting is `meshctl forget-runs`; every viewer route under `/api/mesh/` reads. |
| `meshctl` is the only writer of `mesh.json` | Unchanged. Run records never touch `mesh.json`. |
| One attention predicate | Nothing here feeds `public/attention.js`. The agent tab has no count. The DOM test compares title, badge, tab counts, Needs you rows, rail and dock with and without the strip, the agent tab and run history. |
| Two render entries | The strip paints in `agentsHome.paint()`; the agent page paints in the render pass for the active tab, from `load()` (through `renderIfIdle()`) and `reloadAndPaint()` only. Inner tab switches and Show more repaint their own region from the last model. |
| An idle tick paints nothing (#298) | Both mesh reads join `lastData.reads` by identity, and a 304 resolves to the same object. The page's state joins `frameInputs()`. |
| A held pointer, scroll or selection is never a suspension | Cards are updated in place by `key`; run rows are inserted, never rebuilt; only an Ended cell's text changes, by the label clock (§5.8); Card JSON is rewritten only when it changes. |
| No network in the MCP process; no mesh module in the stdio graph | `src/mesh-runs.ts` joins `test/prstate.test.ts`'s `MESH` list and `test/mesh.test.ts`'s `MESH_FILES`. |
| The text guard | Unchanged in pattern and file list. No `src/viewer*.ts`, `public/*.js` or `electron/*` file names `unslop-client`, `request-post-client` or `meshctl`; the forget command reaches the page as data built in `src/mesh-agents.ts`. |
| Viewer write routes validate bodies first | The refresh route's new `open` + `name` form answers 400 on a bad body and 200 `{ok:false}` on an unconfigured name. |
| The clients' contract | Exit codes, stdout and stderr unchanged on every path; a signal still ends the process by that signal. |
| No raw SQL outside `store.ts`; no hub schema change | Nothing touches the database. |
| No new dependency | `test/fixtures/app-dependencies.txt` unchanged. |
| Dead exports | `appendRun` and the retention helper ship with `src/meshctl.ts` (V5a); `readRuns` with `src/mesh-agents.ts` (V5b); the page module with `app.js` (V5c1). |
| Motion | None. |

**Unchanged:** the cards design's lazy `mesh.json` read, card fetch rules, deadlines, state words,
reasons and fixes; the Refresh button's place; the Dashboard's open handlers; unslop's usage line;
the agents in `packages/mesh`; the publishing service.

---

## §8 — Decision 6: slices and tests

Each slice is one PR, mergeable alone, with its docs. V5a, V5c1 and V5c2 can proceed in parallel;
V5b needs V5a; V5d needs V5b and V5c1; V5e follows web search's W5b.

| Slice | Content | Production lines (est.) |
|---|---|---|
| **V5a. Run records** | `src/mesh-runs.ts` (schema v1, builder, validator, `appendRun`, torn-line repair, retention); the `io.run` collector in both run functions; the meshctl entry writes after the catch and installs the signal handlers; retention on every `enable` and `disable`; `disable --unslop --purge` removes `runs/unslop-*`; new `disable --request-post --purge`; new `forget-runs`; the import pins and the `MESH` lists gain `mesh-runs`; `docs/unslop.md` and `docs/request-post.md` gain "What this Mac keeps"; `mesh.md` | ~280 |
| **V5b. The read side** | `readRuns` in `src/mesh-runs.ts` (bounded read, merge, sort by `at`); `GET /api/mesh/agents/runs` with its `forget` text; `lastRun` in `/api/mesh/agents`; `mesh.md` | ~200 |
| **V5c1. The agent tab** | A new `public/mesh-agent-page.js` with the inner tablist and **Details** (V3's lines and Card JSON, moved); the `agent` tab in `index.html`, `tabs.js` and `app.js` (`selectTab`, `PAGE_META`, Close, `wireTablist` skipping a hidden tab, the per-agent open trigger, the widened `/api/mesh/agents` gate); the refresh route accepts `name` with `open`; V3's rows stay, and pressing a row opens its agent tab instead of expanding in place; `style.css`; `viewer-dashboard-and-shell.md`, `attention-and-later.md`. Until V5d the page opens on Details | ~230 |
| **V5c2. The card strip** | `public/mesh-section.js` draws cards instead of rows (§2.1's lines without the last-run line, which V5d adds), roving Left/Right/Home/End, both-edge shades, `aria-current` on the open agent's card; `style.css`; `viewer-dashboard-and-shell.md`. A card does what V5c1's row does; before V5c1 lands, it expands the details below the strip, as V3's row does | ~160 |
| **V5d. Run history tab** | The Run history tab as the default; the gated runs read in the poll with its fallback; summary, table, Show more, empty state, footer with the forget text; the card's last-run line | ~250 |
| **V5e. Web search joins** | After W5b: `agents.web-search` in `src/mesh-agents.ts` (loopback, 3 s, "Not running" like unslop), its `checkCard` branch, W5b's run function filling `io.run` with §5.4's common fields only, and `disable --web-search --purge` removing `runs/web-search-*` | ~150 |

**Tests.**

- **V5a, `test/mesh-runs.test.ts`** (real temp dirs from `scratchDir()`, no `fs` mocks):
  - one record per exit for both clients through their existing fake agents, with §5.4's fields;
    `at` is the end time and `ms` the duration;
  - **canaries:** a draft, a brief, a title, a source URL, a page URL, a `humanAction`, a
    `failures` fragment and a warning `detail` each carrying a unique string; none appears in any
    file under `mesh/runs/` (byte search);
  - **caller-chosen keys:** `file --key acme-secret-x` and `status --key acme-secret-x` each leave
    no `acme` anywhere under `mesh/runs/`; a derived key leaves no 8-character run of
    it either;
  - a refused brand or channel is not kept; on exit 0 they are;
  - off (no key, or a key whose endpoint fails its rule) and usage errors write nothing, and enable
    then disable leaves the tree as before;
  - **an internal error** (an `io.out` that throws after the key is armed) gives exit 13 on the
    process and one record with `outcome: "failed"`, `reason: "internal"`;
  - **signals:** a child running the client against a fake agent that holds the task, sent
    `SIGTERM`, `SIGHUP` and `SIGINT` in turn: each child dies by that signal (the spawn result's
    `signal`), and each leaves one record with `exit: null`, that `signal` and
    `outcome: "interrupted"`; an interrupted `wait` records the last phase it saw; a signal before
    the key is armed leaves nothing;
  - a symlinked runs folder, a symlinked day file, a group-writable folder and a foreign-owned
    file each mean nothing is written, with exit, stdout and stderr unchanged; a read-only runs
    folder leaves exit, stdout and stderr byte-identical;
  - **eight child processes appending 50 records each, starting with no `runs/` folder** (the
    `mkdir` race, `EEXIST` then the checks): 400 lines that all parse;
  - **torn-line repair:** a day file seeded with a partial line (no newline): the next record
    parses, and the partial line is the only one skipped;
  - the cap uses `size + line`: a file 300 bytes under the cap refuses a 400-byte line; the largest
    possible record, repair newline included, is at most 512 bytes;
  - **retention:** a new day file deletes this agent's files older than the period, never another
    agent's file, a symlink or a non-matching name; **a 40-day-old file of each agent is deleted by
    `disable --request-post` (dry run and `--apply`) and by `enable --unslop`**;
  - `disable --unslop --purge` removes `runs/unslop-*`; `disable --request-post --purge` removes
    `runs/request-post-*` and nothing else; `forget-runs --unslop` lists without `--apply` and
    deletes with it, leaves a symlink named like a run file and another agent's files alone, and
    works with the agent off.
- **V5b, `test/mesh-agents.test.ts` and `test/mesh-runs.test.ts`:** no `opts.mesh` or mesh off
  gives `{ on: false }` and no file access; a missing or unknown name is 400 and an unconfigured
  one `{ok:false}`; a torn last line and empty lines are ignored; a line with an unknown field
  loses the field; a line with a bad pattern is skipped and counted; a symlinked or foreign file is
  skipped; **a 330 KiB file is read up to 320 KiB with `truncated: true`, not skipped**; a file
  older than the period is never shown, deleted or not; **a 4-hour run that ended last sorts
  first** even though it started before three shorter runs; the ETag gives 304 until a line is
  appended, then 200; one `readdir` pass per 5 s; `lastRun` follows the newest `at`; a run read
  never opens a connection (counting listener) and never writes or deletes (the folder's listing
  and times are unchanged).
- **V5c1, `test/dom/mesh-agents.test.ts`** (extended, keeping every V3 invariant case),
  **`test/tabs.test.ts`** (the `TAB_IDS` pin gains `'agent'`; `tabCounts()` has no `agent` key) and
  **`test/shell.test.ts`** (the tab markup test lists six tabs with `agent` last, `hidden`, and
  without a `tab-count` slot; "gives every tab a count slot" names the five counted tabs):
  - with no `mesh` key: `BOOT_REQUESTS` unchanged, no `agent` tab visible, and
    `selectTab('agent')` does nothing;
  - **no path lands on an empty agent tab:** with no agent open, `navigateKeyboard('agent')`
    (the G-key route through `TAB_IDS`), `applyFocusHash()` with an item hash, and restoring a
    focus bookmark captured while the agent tab was open and then closed each leave the active
    tab and focus where they were (or on the item's own tab for the hash);
  - pressing a row shows the agent tab with that name, selects it, posts exactly one
    `{trigger:'open', name}` and calls `reloadAndPaint()` once; a second press within 60 s posts one
    (the server skips the check); selecting the active agent tab posts nothing; inner tab switches
    post nothing; closing selects the Dashboard (one Dashboard `open`) and returns focus to the row
    in a focused window;
  - the agent tab never shows a count; attention surfaces equal the run without mesh;
  - Details shows V3's lines; a selection in Card JSON survives a poll and a Refresh that changed
    only `checkedAt`; a hostile card still yields no `img`, no `a[href]` and no request to its URLs;
  - an idle tick (304) changes no node on the agent tab;
  - a reload starts with no agent tab; the agent leaving `mesh.json` shows the one line and keeps
    the tab;
  - the existing text guard runs unchanged.
- **V5c2, `test/dom/mesh-agents.test.ts`:** the strip draws one card per agent with §2.1's lines;
  one card is tabbable; Left, Right, Home and End move focus and J/K do not reach the strip; Enter
  opens; the strip is the same under each state filter and under a lens that hides every session,
  and shows in the empty state; an idle tick changes no node; no `img` or `a[href]` from card data.
- **V5d:** the runs read happens only with the agent tab active, Run history showing and the
  document visible; Details showing or the Inbox active stops it and keeps the last body; a new
  run inserts one row and leaves the other row nodes identical (same objects); **a run that started
  before the newest shown run but ended after it is inserted at the top**; a selection in a row
  survives that poll, **the 30-second label clock's repaint, and the page's Refresh
  (`reloadAndPaint()`)**; **the midnight exception:** with the clock moved past midnight, only the
  Ended cells' text changes (time to weekday), and a selection inside another cell of the same row
  survives; Show more is window-local and in `frameInputs()`; a failed read marks the table stale
  without a failed tick; the card's last-run line follows `lastRun`; the footer shows the route's
  `forget` text inside `<code>`, and no `public/*.js` file contains the command's name.
- **V5e:** W5b's client records only the common fields (no `fresh`, provider or stage timing);
  **with `record: true`, a canary query appears in no runs file and no `/api/mesh/*` body**; two
  identical queries 1 minute apart, the second a cache hit, produce records that differ only in
  `id`, `at`, `ms` and `task`; the web search card follows unslop's not-running rules.

Before each PR: `fnm use 24`, `npm run typecheck`, `npm test`, and `git diff | ask.sh review`.

---

## §9 — Amendments, exactly

Each lands with the slice named.

**The cards design** (V5c1), a header line under "Amends":

> **Amended 2026-11-09 by cards view V5**
> ([`2026-11-09-agent-cards-view-v5-design.md`](2026-11-09-agent-cards-view-v5-design.md)): an
> agent opens in an agent tab with Run history and Details; the section's rows become a strip of
> cards; `meshctl` keeps a run record the viewer reads. It touches §1, §2.1–§2.3, §2.6, §3.2, §4.5,
> §4.7, §5.2, §6 and §7.

and in place:

- §1 non-goals: "No calling an agent from the app" stays. Add "Run history (V5) shows `meshctl`'s
  run records; it never calls an agent."
- §2.1 (V5c2): "One row per configured agent" becomes "one card per configured agent, in a
  horizontal strip (V5 §2)".
- §2.2 and §2.3: a note at each head: "Superseded by V5 §2.1 (the card, V5c2) and §4 (Details, in
  the agent tab, V5c1). The lines and words are unchanged; their place moved."
- §2.6: a note pointing to V5 §2.1 and §4's mocks.
- §3.2 "What it never reads": unchanged list; add "It reads `mesh/runs/` only through
  `src/mesh-runs.ts`'s reader (V5 §5.7)."
- §4.5: the handler list gains "4. Opening an agent tab (a card or row, or the agent tab from
  another tab) posts `{ trigger: 'open', name }` for that agent only"; the read rule's "the
  Dashboard is the current tab" becomes "the Dashboard or the agent tab is the current tab".
- §4.7: the body gains `lastRun` (V5b); "Between triggers the read is a 304" becomes "Between
  triggers and runs the read is a 304". "Nothing is written to the hub or to disk" stays true.
- §5.2: "Logs are not read" stays; add "Run records (`mesh/runs/`) are read, never written or
  deleted; they hold no text (V5 §5.5)."
- §6: the "Two render entries" row adds the agent page; the "idle tick" row adds the runs read.
- §7: a note that V5 extends `test/dom/mesh-agents.test.ts` and keeps every invariant case.

**`docs/architecture/mesh.md`** (V5a, V5b): `paths`/`applyTo` gain `src/mesh-runs.ts` and
`public/mesh-agent-page.js`. The viewer bullet in "Invariants in detail" gains:

> Run history (cards view V5): the meshctl entry that runs a client (`unslop`, `request-post`,
> later `web-search`) appends one record per run through `src/mesh-runs.ts`'s `appendRun()` to
> `<mesh dir>/mesh/runs/<agent>-<date>.jsonl`: after the run function returns, after its `.catch`
> turns an internal error into 13, and from synchronous `SIGTERM`/`SIGHUP`/`SIGINT` handlers that
> write `outcome: "interrupted"` and re-raise. Only once the agent's key has passed its rule; best
> effort; never changing the exit, the signal, stdout or stderr. The writer: a 0700 folder created
> without parents (`EEXIST` re-checked), 0600 files with `O_APPEND | O_NOFOLLOW`, one checked
> `writeSync` of at most 512 bytes (a size bound; local filesystems serialise `O_APPEND` writes;
> `PIPE_BUF` is about pipes), never retried, a leading `\n` when the file's last byte is not one,
> no write once `size + line` would pass 256 KiB. Network-mounted mesh dirs are unsupported for run
> history. A record is a closed schema with fixed vocabularies, `at` being the end time: never
> text, a prompt, a query, an answer, a title, a URL, a page id, a caller-chosen key or a token.
> Files older than the kept period are deleted by `appendRun` when it starts a day's file, by every
> `enable` and `disable`, and by `forget-runs`. `--purge` on `disable --unslop` and
> `disable --request-post` removes that agent's runs. The viewer reads them only through
> `readRuns()` (`O_NOFOLLOW | O_NONBLOCK`, `fstat`, at most 320 KiB per file, the same validator,
> sorted by `at`) for `GET /api/mesh/agents/runs` and `lastRun`, and never writes or deletes them.

The purge sentences in "Turning unslop on and off" and "Turning request-post on and off" gain
"and its run records", and the latter documents the new `--purge`. A new short "Forgetting run
history" paragraph documents `forget-runs`.

**`docs/architecture/viewer-dashboard-and-shell.md`** (V5c1, V5c2, V5d): the Mesh agents bullet's
"One row per agent … the expanded row shows the card's lines and a nested Card JSON" becomes the
strip (fixed-width cards, roving Left/Right/Home/End, both-edge CSS shades, thin scrollbar, no
motion) and the agent tab (one slot after History, hidden with no agent and skipped by roving,
never counted, never persisted, unreachable by G keys, hashes or bookmarks while empty, Close in
the page header, Run history default then Details with V3's lines and Card JSON, rows keyed by run
`id` and sorted by end time, only the Ended text changing). The read rule adds the agent tab and
the runs read's gate.

**`docs/architecture/attention-and-later.md`** (V5c1): one line: "The agent tab (cards view V5)
never carries a count, and nothing in the strip or Run history reaches attention."

**`docs/architecture/overview.md`** (V5a): the list of modules kept out of the stdio graph gains
`src/mesh-runs.ts` (used by `meshctl` and the viewer, never MCP).

**unslop design §4.2, request-post design §7** (V5a): one line each: "The meshctl entry appends a
run record without text for each call (cards view V5 §5.4, §5.5)." **Web search design §4.5**
(V5e): the same line, plus "only the common fields; no `--fresh`, cache or provider field, so the
record states nothing about a repeated query." Web search §12.2 gains: "The sample folder is never
read by the client or the viewer, and no run record field can hold a query or an answer." Web
search's promise that nothing about a query reaches disk is unchanged.

**`CLAUDE.md`:** no change. Its mesh line points to `mesh.md`, which carries the detail.

---

## §10 — Try it

With unslop and request-post on in your real `mesh.json`, in a checkout of V5d (or later) beside
the installed app:

1. `fnm use 24 && npm ci && npm run build`, then `AGENT_INBOX_PORT=4392 npm run electron:side`.
2. In a terminal: `echo "Draft text for a quick check." | ~/.agent-inbox/bin/unslop --kind docs`.
3. In the side window, the Agents home's Mesh agents strip shows two cards. unslop's says
   "Last run <time> · rewritten" (or "unchanged") within one poll.
4. Tab into the strip: one stop; Left and Right move between the cards. Narrow the window below
   620 px: the second card peeks past the edge with a shade.
5. Click unslop's card: an "unslop" tab appears after History and opens on **Run history** with
   one row. **Details** shows what V3's dropdown showed; select some Card JSON text and wait a
   few polls; it stays selected.
6. Run the command again: a second row appears on top; the first row keeps any selection.
7. Start the command a third time and press Ctrl-C before it finishes: a row says "interrupted ·
   SIGINT".
8. Click request-post's card: the same tab now shows request-post. Its history is empty unless a
   request was filed since V5a.
9. Open `~/.agent-inbox/mesh/runs/`: one file per agent per day, every line without the draft
   text. `grep -r "quick check" ~/.agent-inbox/mesh/runs/` finds nothing.
10. Run the footer's forget command without `--apply`: it lists unslop's files. With `--apply`, the
    table empties on the next poll.
11. Close the agent tab: the Dashboard comes back with focus on the card. Reload: no agent tab.
12. The installed app on port 4319 shows no badge or count change.

---

## §11 — Alternatives considered

- **Keep rows, add a Run history link per row.** Does not answer "literal cards".
- **Cards in a grid that wraps instead of scrolling.** Shariq asked for horizontal scrolling,
  and a wrapping grid grows the Agents home with every agent.
- **Move the strip to the top of the Agents home.** Sessions are still the main content; the
  section keeps the place the cards design chose. Easy to revisit; it is one mount point.
- **A run record in the hub.** A schema change and a write path from the clients into the
  inbox's database, for data the mesh owns. Rejected, as the cards design's §11 rejected hub
  records.
- **Write the record inside each run function.** Misses internal errors caught by the entry and
  every signal. The entry sees every end.
- **Sort by start time.** A 4-hour `wait` would land deep in the table, and new rows would not
  arrive at the top. End time matches how the files are named and appended.
- **Write a "started" line too, to show runs in flight.** A `kill -9` leaves a run that never
  ends, and a `wait` would sit "running" for hours. Left out; a later slice can add it with a
  stale rule.
- **Rotate one file per agent by renaming at a size limit.** Two clients can rotate at once and
  lose a file; day files need neither a lock nor a rename.
- **A keyed hash of the request key with a local secret.** It would hide the key from guessing,
  but it adds a secret to manage for little use. Keeping no key is simpler.

---

## §12 — Risks

| Risk | Mitigation |
|---|---|
| A record leaks private text through a new field later | One schema, closed vocabularies, the same validator on write and read, canary tests over every input (caller-chosen keys included), and §9's `mesh.md` rule. |
| A stored key confirms a guessed title | No request key is kept, derived or caller-chosen (decision 3). |
| A dynamic tab breaks tab keyboard order or the compact masthead | One slot, hidden when unused, skipped by roving, unreachable by G keys, hashes and bookmarks while empty; the compact row already scrolls with a shade; the tab tests pin it. |
| History fills the disk, or outlives its period | 256 KiB a day per agent (plus bounded overshoot), the 30-day period (decision 6), deletion on each new day file and on every enable and disable, `--purge` for every agent, `forget-runs`. |
| Concurrent writers interleave, or a write is torn | One checked `O_APPEND` write of at most 512 bytes on a local volume; never retried; torn-line repair; the reader skips anything that does not parse; the eight-process test from an empty folder. Network mounts are unsupported. |
| A killed run leaves no trace | Signal handlers write `interrupted`; only `SIGKILL` escapes, and the design says so. |
| The signal handlers change how a client dies | They write synchronously and re-raise the same signal; tests check the child's `signal`. |
| History and unslop's usage line disagree | They count different things (client runs vs. the agent's admitted tasks). The usage line keeps "tasks", the summary says "runs". |

---

## §13 — Decisions (Shariq, 2026-11-09)

Shariq accepted all six recommendations. The options are kept briefly for history.

1. **Where an opened agent lives: one agent tab in the library's tab list, after History.** Not
   chosen: a pane under the strip in the Agents home (smaller change, but under all the sessions),
   or the session panel's sheet (narrow, and the riskiest Dashboard code). §3.3 specifies it.
2. **One agent tab; opening another card replaces it.** Not chosen: one tab per opened agent, up
   to three extra tabs, each with its own close control.
3. **request-post's run history keeps outcome, phase, channels and brand (exit 0 only), and no
   request key.** Not chosen: an 8-character prefix of a derived key, or the full derived key with
   the page id and an "Open in Notion" link. Both would let anyone who can read the file confirm a
   guessed title (§6). A caller-chosen `--key` was never an option.
4. **Forgetting is `meshctl forget-runs (--unslop | --request-post | --web-search | --all)
   [--apply]`, shown as copyable text in the Run history footer, plus `--purge` on every agent's
   `disable` and the 30-day expiry.** The viewer stays read-only under the mesh dir. Not chosen: a
   Forget history button in the viewer (it would reverse "the view writes nothing"), or `--purge`
   and expiry only.
5. **No caller identity in a record.** Not chosen: the project name the inbox would infer for the
   calling directory, which can be a customer's repository name.
6. **Run records are kept 30 days.** Not chosen: 7 days, or today only.
