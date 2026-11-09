# Design: mesh agent cards strip, agent tabs and run history (cards view V5)

**Date:** 2026-11-09
**Status:** Proposed. Waiting for Shariq's decisions (§13).
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
   tab, and that view has its own tabs. Recommended: **one agent tab in the library's tab list**,
   shown only while an agent is open, named for the agent, replaced when another card is opened,
   closed by its Close button, never counted and never restored after a reload (§3, Q1, Q2).
4. **Inside the agent tab:** two tabs, **Run history** (the default each time an agent opens)
   and **Details** (exactly what V3's expanded row shows, Card JSON included, with the same
   selection rules) (§4).
5. **Run history needs a record the app does not keep today.** Recommended: each client CLI
   (`meshctl unslop`, `meshctl request-post`, later `meshctl web-search`) appends one JSON line per
   run to `<mesh dir>/mesh/runs/<agent>-<date>.jsonl` (0600, in a 0700 folder) when it exits.
   Each record has a closed set of fields: times, operation, exit code, outcome word, durations,
   and a few fixed-vocabulary facts. Never text, prompts, queries, answers, titles, URLs or tokens.
   Records are kept 30 days. The viewer only reads them, through a new conditional route, and
   only while an agent tab shows Run history (§5).
6. **Off still means off.** With no `mesh.json`, nothing changes: no strip, no tab, no reads, the
   same boot requests. A client whose agent is off writes no record (§7).
7. **Five slices,** each under about 300 production lines and mergeable alone; the fifth waits for
   web search's client (W5b) (§8).

---

## §1 — Goal, scope and non-goals

**Goal.** See each configured mesh agent at a glance as a card, open one agent into its own view,
and see what it has done recently: when it ran, what kind of call it was, how it ended and how
long it took.

**In scope.** The card strip; one agent tab with Run history and Details; a run record written by
the clients; a read route; a Forget control (if Q4 says so); and the matching amendments.

**Non-goals.**

- No calling an agent from the app (the cards design's §1 stands).
- No in-flight runs: a run shows once its client exits. A request-post `wait` that runs for hours
  shows when it ends.
- No search, filter or export in Run history. No charts.
- No caller identity in a record (which session or project called) unless Q5 says so.
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
   is a clock time today, a weekday this week, else a date. It follows the 30-second label clock,
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
| **A. One agent tab in the library's tab list** (recommended) | The literal reading of "open … as a tab". A whole page for Run history, which is a table. Leaving and coming back keeps it. Opening, closing and the page title follow the existing `selectTab`/`showPanel` path. | The tab list gains a tab that comes and goes. Tabs carry counts by convention, so this one must be pinned count-free. The compact masthead's tab row gets one more tab (it already scrolls with a shade). |
| B. A detail pane under the strip, with its own tab bar | Smallest change: everything stays in `mesh-section.js`, no routing. | Not a tab. The pane sits at the end of the Agents home, so a run table pushes the folds far down. The page is the Dashboard, so the Dashboard's poll gates and focus rules apply to a table. |
| C. The session panel's sheet, holding the agent | The same gesture as a session card: click opens a panel. | The panel's code is session-shaped (`focusSession`, `sessionFocus`, `cardFor`, placement after the card's row). Generalising it touches the riskiest part of the Dashboard (#463's review rounds). A sheet is narrow for a table. |

**Recommendation: A.** The details below assume it. If Shariq picks B, §4 and §5 are unchanged
and §3.3 shrinks to a pane inside the section.

### 3.3 The agent tab, exactly

- **One slot.** `#tabs` gains a sixth tab, `data-tab="agent"`, after History, hidden while no agent
  is open. Its icon is the agent's state dot and its name the agent's `mesh.json` name. Opening a
  card shows the tab with that agent and selects it. Opening another card replaces the agent in the
  same slot (Q2 weighs one tab per agent).
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
│ When        What   Outcome      Took    Details                              │
│ 14:02       docs   rewritten    8.4 s   model 7.0 s · 1 attempt · rules 3f9a1c0e7b22 │
│ 13:40       pr     refused      0.2 s   screen: email                        │
│ 11:15       blog   kept original 31 s   fidelity · 2 attempts                │
│ …                                                                            │
│ [Show 50 more]                                                               │
│ Kept on this Mac for 30 days. Never the text sent or returned.  [Forget history] │
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
| **A. Each client CLI appends one record per run** (recommended) | One writer per agent on this Mac, for all three agents, request-post included. Sees every exit, including those that never reached an agent. One versioned schema the viewer can validate. The client already holds every field (its exit, the result's data part, its own clock). | A new file family under the mesh dir. Several CLI processes may append at once (§5.5). |
| B. Derive history from the agents' logs | No new writer. | Nothing for request-post. Misses client-side failures. The viewer would read logs, which the cards design ruled out. Unbounded files. |
| C. The agents write a run file | Close to the work. | request-post's agent is remote, so it cannot write here. Misses client-side failures, the same as B. |

**Recommendation: A.**

### 5.3 What a run is

One run is one client process from the moment it has resolved its agent's `mesh.json` key (the
key passed its endpoint rule) to its exit. Earlier exits write nothing: a usage error (4), and
"off" (14 because the key is absent, or its endpoint fails `loopbackPort()` or
`requestPostEndpoint()`). So a client whose agent is off still writes
nothing, and enabling then disabling an agent leaves the tree as before.

| Agent | `op` | One run is |
|---|---|---|
| unslop | the `--kind` value (`pr`, `issue`, `release-notes`, `docs`, `blog`) | one `bin/unslop` call: one task, or no task when the card check or start failed |
| request-post | `file`, `status`, `wait` | one `bin/request-post` call; a `wait` is one run however many polls it made |
| web search (W5b on) | `answer`, `sources` | one `bin/web-search` call |

### 5.4 The record

One JSON object per line, written once when the client exits. Every field is optional except the
common ones. Strings are limited to closed vocabularies or tight patterns, so no field can carry
free text.

**Common to every agent**

| Field | Type and rule | Meaning |
|---|---|---|
| `v` | `1` | schema version; a reader skips other versions |
| `id` | 10 base32 characters, random | the run's own key for the page (never the task id) |
| `agent` | `unslop`, `request-post`, `web-search` | which agent |
| `op` | per agent, §5.3 | what kind of call |
| `at` | ISO 8601 UTC, when the client started | the run's time |
| `ms` | integer ≥ 0 | the client's wall-clock time to exit |
| `exit` | integer, one of the agent's documented exit codes | the client's exit code |
| `outcome` | one word from the table below | how it ended, for people |
| `reason` | `^[a-z][a-z0-9-]{0,39}$` | the agent's or client's fixed reason or class name, when it gives one |
| `classes` | up to 8 of `^[a-z][a-z0-9-]{0,23}$` | screen or refusal class names (never a matched value) |
| `task` | `^[A-Za-z0-9-]{1,64}$` | the agent's task id, for unslop and web search, to find the agent's own log line |

**Outcome words.** `ok`, `kept-original` (unslop 10), `sources-only` (web search 10),
`refused` (11), `busy` (12), `failed` (13), `unknown` (request-post 13: outcome unknown),
`unavailable` (14 with the key present: a card mismatch, an agent that would not start, a missing
token; and request-post 15), `conflict` (request-post 16), `timed-out` (request-post 124). The page
maps each to its own words (§5.8).

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
| `phase` | `^[a-z][a-z-]{0,23}$` (the service's phase words, such as `awaiting-go`, `ready-for-human`, `published`) | the data part |
| `created` | boolean, `file` only | `true` filed, `false` already filed |
| `throughGo` | boolean, `wait` only | the flag |
| `channels` | up to 4 of `blog`, `x-thread`, `x-standalone`, `linkedin`; **exit 0 only** | the caller's arguments, once the service accepted them |
| `brand` | `^[a-z0-9-]{1,40}$`; **exit 0 only** | the same; a refused brand might be a typo or a name, so it is never kept |
| `key` | the first 8 characters of the request key (Q3) | the derived or given key |
| `fields` | up to 8 field names from the client's argument list | which fields a refusal named, never their values |

**web search** (written by W5b's client, fixed here so it ships with the first version)

| Field | Rule | From |
|---|---|---|
| `fresh` | boolean | `--fresh` |
| `sources` | integer 0–10 | the number of sources returned |
| `provider` | `searxng`, `ollama`, `both`, `cache` | which provider answered |
| `timing` | `{ queued, search, model, check }`, integers | the data part |

A record is at most **512 bytes**. The builder caps every field so a full record fits. If a line
would still be longer, the client writes nothing.

### 5.5 What is never kept

These are the agents' own promises, carried into the record. A test writes a canary into each
input and searches every runs file and every route body byte by byte (§8).

- **unslop:** the draft, the result text, `failures` (its lost, added and moved fragments),
  warning `detail`, the profile, the backend URL, the API key and the token.
- **request-post:** the brief, the title, the slug, the source URL, the category, the page URL,
  the page id, the full request key (unless Q3 says otherwise), any `humanAction` or error text
  from the service, a brand or channel the service refused, and the token. The page URL is left
  out because Notion URLs carry the page title.
- **web search:** the query, the answer, every source URL, title and snippet, and the query's
  character and word counts. **`record: true`** (web search §12.2) is the agent's trial sample, in
  its own `0700` folder. The client neither reads nor writes that folder. The run record has no
  field that could hold a query or an answer. The viewer never reads the folder. A test runs a
  canary query with `record: true` on and finds it in no runs file and no response.
- **Everyone:** environment variables, the working directory, arguments other than those listed,
  and stdin. Caller identity is left out unless Q5 says otherwise.

### 5.6 Where, and how the clients write it

- **Path.** `<mesh dir>/mesh/runs/` (mode 0700), files `<agent>-<YYYY-MM-DD>.jsonl` (mode 0600),
  where the date is the client's local date at exit.
- **One module.** `src/mesh-runs.ts` holds the schema, the record builder and validator, the
  writer `appendRun()`, and (from V5b) the reader `readRuns()`. It imports only Node core. The
  clients import it, and so does `src/mesh-agents.ts`. No `src/viewer*.ts`, `public/*.js` or
  `electron/*` file imports it, and its name does not match the text guard's patterns.
- **Writing.** `lstat` the runs folder: create it 0700 if absent; if it is a symlink, not a
  directory, not owned by the user, or writable by group or others, write nothing. Open the day
  file with `O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_NONBLOCK`, mode 0600. `fstat` it: a
  regular file this user owns, else write nothing. If its size is already at the **day cap of
  256 KiB**, write nothing. Then **one `write()`** of the whole line, newline included.
- **Concurrency.** Several client processes may run at once: two sessions calling unslop, or a
  long `wait` beside a `file`. POSIX guarantees each `O_APPEND` write starts at the current end of
  file with no other change in between, so records never overwrite each other. A single small
  write is not split by local filesystems in practice. The reader still skips any line that does
  not parse, so a torn line could cost one record, never the file. No lock file and no rename are
  needed, and no process ever rewrites a file.
- **Retention.** When `fstat` shows the append has just created the day's file (size 0), the
  client also removes this agent's files whose date is more than 30 days ago (regular files only,
  `lstat` first; `ENOENT` from a concurrent removal is ignored). That runs at most once a day per
  agent, and only from the client that started the day. Day files cap each agent at
  30 × 256 KiB; in practice far less (unslop's agent allows 200 tasks a day, and a record is about
  250 bytes).
- **Best effort.** Writing a record never changes the client's exit code, stdout or stderr. A
  failure is silent, because both clients' stderr is read by calling agents as protocol text.
- **Purge.** `meshctl disable --unslop --purge` also removes `runs/unslop-*` and then the runs
  folder if it is empty. request-post's `disable` has no `--purge`; its records expire or are
  forgotten (§5.9).

### 5.7 How the viewer serves it

- **The reader.** `readRuns(dir, agent, now)` in `src/mesh-runs.ts`. It reads only the runs
  folder (`lstat`: a real directory, owned by the user, not group- or other-writable) and only
  file names matching `^(unslop|request-post|web-search)-\d{4}-\d{2}-\d{2}\.jsonl$` for that agent,
  dated within 30 days, newest first. Each file is opened with
  `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, `fstat`-checked (regular, this user's, no group or other
  write, at most 256 KiB + 512 bytes), and read in one bounded `readSync` from that descriptor.
  This is V4's budget-read pattern. A file that fails any check is skipped and counted.
- **Validation.** Each line goes through the same validator the writer uses. Unknown fields are
  dropped, wrong types or patterns skip the line, and a last line without a newline (a write in
  progress) is ignored silently. Skipped lines are counted, never shown.
- **Caching.** At most one `readdir` and `lstat` pass per agent every 5 seconds, the same rule as
  `mesh.json`. Each file's parsed records are cached under its device, inode, size and `mtimeMs`,
  so past days are parsed once.
- **`GET /api/mesh/agents/runs?name=<agent>`** answers:

  ```json
  { "on": true, "name": "unslop", "runs": [ { "v": 1, "id": "k3m9q2x7pa", "op": "docs", "...": "..." } ],
    "older": false, "skipped": 0, "keptDays": 30 }
  ```

  It returns the newest 200 runs, newest first, and sets `older` when more exist within 30 days.
  The body is built fresh per request with `Cache-Control: no-store` and an ETag over the bytes,
  answering 304 on a match, like `/api/mesh/agents`. It is not a retained snapshot: no
  `SNAPSHOT_SOURCES` entry and no trigger, and `test/fixtures/snapshot-triggers.txt` is
  unchanged. Without `opts.mesh`, or with the mesh off, it is `{ "on": false, "runs": [] }` and
  touches no file. A missing or unknown `name` is 400. A known name that `mesh.json` does not
  configure is 200 `{ "ok": false, "error": "not configured" }`. Reading never starts a card
  check.
- **`/api/mesh/agents` gains `lastRun`** per agent: `{ "at", "op", "outcome" }` from the newest
  valid record, or `null`. The body now changes when a run lands, which is a content change. With
  no new run the bytes are identical and the read is a 304, so an idle tick still paints nothing.
- **The page reads** `/api/mesh/agents/runs` as one more conditional read in the poll tick, only
  while the agent tab is active, its Run history tab shows and the document is visible. With the
  same fallback as `/api/mesh/agents`: a failed read keeps the last body marked stale ("could not
  read; showing what was last read"), never a failed tick. A skipped read keeps the last body.
  Opening another agent drops it.

### 5.8 The Run history tab

- **Summary line** over the runs returned: "Last 48 runs: 44 ok · 3 refused · 1 failed · median
  8.2 s".
- **A table** (`<table>`, `<th scope="col">`): When, What, Outcome, Took, Details.
  - When: a clock time today, else weekday and time this week, else the date; the full local time
    in `title`.
  - What: unslop's kind; request-post's `file`, `status`, `wait` or `wait (through go)`; web
    search's `answer` or `sources`.
  - Outcome: page words ("rewritten", "unchanged", "kept original", "sources only", "refused",
    "busy", "failed", "outcome unknown", "unavailable", "conflict", "timed out", or the final
    phase for a request-post `status` or `wait` that ended 0). Amber for failed, unknown,
    unavailable and timed out; the normal text colour for the rest. No green and no pink, keeping
    the Agents home's palette rule.
  - Took: `ms`, as "0.2 s", "31 s", "4 min", "3 h 50 min".
  - Details: the agent's facts joined with " · ". unslop: "model 7.0 s · 1 attempt · rules
    3f9a1c0e7b22 · 6.2 KB", "screen: email". request-post: "awaiting-go · blog, x-thread ·
    brand-a · key ab12cd34", "fields: channels". web search: "searxng · 5 sources · model 3.1 s".
  Every value goes through `textContent`.
- **50 rows first**, then **Show 50 more** up to the 200 the route returns. When `older` is set,
  a last line says "Older runs from the last 30 days are not shown." The shown count is in the
  page's `state()`.
- **Rows are keyed by `id` and never rewritten.** Records do not change, so a poll that brings a
  new run inserts one row at the top and touches no other node. A selection in a row survives.
  CSS scroll anchoring (`overflow-anchor`, on by default) keeps a scrolled table from jumping.
- **Empty:** "No runs yet. Calls through this agent appear here once they finish; calls made
  before this version were not recorded."
- **Footer:** "Kept on this Mac for 30 days. Never the text sent or returned." and, if Q4 says so,
  **Forget history**.
- No word here names the client modules or the command, so the text guard holds. Any wording
  that needs the command's name comes from `src/mesh-agents.ts` in a JSON body, as the cards
  design's §3.4 set up.

### 5.9 Forget history (if Q4 is A)

- A **Forget history** button in the Run history footer. The first press turns it into "Forget
  48 runs? [Forget] [Keep]" in place, with no modal and no change of focus beyond the pressed
  control. Forget posts `POST /api/mesh/agents/runs/forget` with `{ "name": "<agent>" }`, then
  repaints through `reloadAndPaint()`.
- The route validates the body first (400 on anything but one known name), then removes only the
  files the reader would read for that agent: a matching name, `lstat` a regular file this user
  owns, in a real runs folder. Symlinks and other files are left. It answers `{ "ok": true,
  "removed": n }`, or 200 `{ "ok": false, "error": "not configured" }`.
- This is the viewer's first write under the mesh dir. It never touches `mesh.json`, which
  `meshctl` alone still writes, and never any file outside `mesh/runs/`.

---

## §6 — Decision 5: security and privacy

- **Untrusted text.** Records are validated on both write and read against closed vocabularies
  and patterns, and the page renders every value with `textContent`. A run record can never
  carry markup, a link or an image. If Q3 adds a page link, it goes through `chipHtml()` and
  `safeHttpUrl()` and opens only through Electron main (`links.md`).
- **What a screenshot shows.** Cards show no remote host (as V3's rows). Run history shows no
  host, title or text. The request-post key prefix identifies a request only to someone who can
  already compute keys.
- **Files.** 0700 folder, 0600 files, `O_NOFOLLOW` on both write and read, owner and mode checks,
  bounded sizes and bounded reads. The reader never follows a name it did not build itself.
- **Secrets.** Unchanged: the viewer never opens `mesh/tokens/*` or `mesh/wrappers/*`, never reads
  the agents' logs, and never reads web search's sample folder.
- **Network.** No new request leaves the viewer. Run history is local files only.

---

## §7 — Invariants kept, and what stays unchanged

| Invariant | How it holds |
|---|---|
| Off means off | No `mesh.json`: no strip, no agent tab, no `/api/mesh/*` read, `/api/version` byte-identical, and `test/dom/agents-home.test.ts`'s `BOOT_REQUESTS` unchanged. A client whose key is off writes no record. |
| One attention predicate | Nothing here feeds `public/attention.js`. The agent tab has no count. The DOM test compares title, badge, tab counts, Needs you rows, rail and dock with and without the strip, the agent tab and run history. |
| Two render entries | The strip paints in `agentsHome.paint()`; the agent page paints in the render pass for the active tab, from `load()` (through `renderIfIdle()`) and `reloadAndPaint()` only. Inner tab switches, Show more and Forget's confirm repaint their own region from the last model. |
| An idle tick paints nothing (#298) | Both mesh reads join `lastData.reads` by identity, and a 304 resolves to the same object. The page's state joins `frameInputs()`. |
| A held pointer, scroll or selection is never a suspension | Cards are updated in place by `key`; run rows are inserted, never rewritten; Card JSON is rewritten only when it changes. |
| No network in the MCP process; no mesh module in the stdio graph | `src/mesh-runs.ts` joins `test/prstate.test.ts`'s `MESH` list and `test/mesh.test.ts`'s `MESH_FILES`. |
| The text guard | Unchanged in pattern and file list. No `src/viewer*.ts`, `public/*.js` or `electron/*` file names `unslop-client`, `request-post-client` or `meshctl`. |
| Viewer write routes validate bodies first | The refresh route's new `open` + `name` form and the forget route answer 400 on a bad body and 200 `{ok:false}` on an unconfigured name. |
| No raw SQL outside `store.ts`; no hub schema change | Nothing touches the database. |
| No new dependency | `test/fixtures/app-dependencies.txt` unchanged. |
| Dead exports | `appendRun` ships with its first callers (the clients, V5a); `readRuns` with `src/mesh-agents.ts` (V5b); the page module with `app.js` (V5c). |
| Motion | None. |

**Unchanged:** the cards design's lazy `mesh.json` read, card fetch rules, deadlines, state words,
reasons and fixes; the Refresh button's place; the Dashboard's open handlers; unslop's usage line;
the agents in `packages/mesh`; the publishing service; the clients' exit codes, stdout and stderr.

---

## §8 — Decision 6: slices and tests

Each slice is one PR, mergeable alone, with its docs. V5a and V5c can proceed in parallel; V5b
needs V5a; V5d needs V5b and V5c; V5e follows web search's W5b.

| Slice | Content | Production lines (est.) |
|---|---|---|
| **V5a. Run records** | `src/mesh-runs.ts` (schema v1, builder, validator, `appendRun`, retention); `src/unslop-client.ts` and `src/request-post-client.ts` call it at exit; `disable --unslop --purge` removes `runs/unslop-*`; the import pins and the `MESH` lists gain `mesh-runs`; `docs/unslop.md` and `docs/request-post.md` gain "What this Mac keeps"; `mesh.md` | ~200 |
| **V5b. The read side** | `readRuns` in `src/mesh-runs.ts`; `GET /api/mesh/agents/runs`; `lastRun` in `/api/mesh/agents`; the forget route (if Q4 is A); `mesh.md` | ~220 |
| **V5c. Cards and the agent tab** | `public/mesh-section.js` becomes the strip (cards, roving keys, shades); a new `public/mesh-agent-page.js` with the inner tablist and **Details** (V3's lines and Card JSON, moved); the `agent` tab in `index.html`, `tabs.js` and `app.js` (`selectTab`, `PAGE_META`, Close, the per-agent open trigger, the widened `/api/mesh/agents` gate); the refresh route accepts `name` with `open`; `style.css`; `viewer-dashboard-and-shell.md`, `attention-and-later.md`. Until V5d the page opens on Details | ~300 |
| **V5d. Run history tab** | The Run history tab as the default; the gated runs read in the poll with its fallback; summary, table, Show more, empty state, Forget's confirm (if Q4 is A); the card's last-run line | ~250 |
| **V5e. Web search joins** | After W5b: `agents.web-search` in `src/mesh-agents.ts` (loopback, 3 s, "Not running" like unslop), its `checkCard` branch, and W5b's client calling `appendRun` with §5.4's fields | ~150 |

**Tests.**

- **V5a, `test/mesh-runs.test.ts`** (real temp dirs from `scratchDir()`, no `fs` mocks):
  - one record per exit for both clients through their existing fake agents, with §5.4's fields;
  - **canaries:** a draft, a brief, a title, a source URL, a page URL, a `humanAction`, a
    `failures` fragment and a warning `detail` each carrying a unique string; none appears in any
    file under `mesh/runs/` (byte search);
  - a refused brand or channel is not kept; on exit 0 they are;
  - off (no key) writes nothing, and enable then disable leaves the tree as before;
  - a symlinked runs folder, a symlinked day file, a group-writable folder and a foreign-owned
    file each mean nothing is written, with exit, stdout and stderr unchanged;
  - a read-only runs folder leaves exit, stdout and stderr byte-identical;
  - **eight child processes appending 50 records each** leave 400 lines that all parse;
  - the day cap stops writing at 256 KiB; the largest possible record is at most 512 bytes;
  - retention removes this agent's files older than 30 days only when a new day file starts,
    and never another agent's file, a symlink or a non-matching name;
  - `disable --unslop --purge` removes `runs/unslop-*`.
- **V5b, `test/mesh-agents.test.ts` and `test/mesh-runs.test.ts`:** no `opts.mesh` or mesh off
  gives `{ on: false }` and no file access; a missing or unknown name is 400 and an unconfigured
  one `{ok:false}`; a torn last line is ignored; a line with an unknown field loses the field; a
  line with a bad pattern is skipped and counted; an oversized, symlinked or foreign file is
  skipped; the ETag gives 304 until a line is appended, then 200; one `readdir` pass per 5 s;
  `lastRun` follows the newest record; a run read never opens a connection (counting listener);
  forget removes only that agent's matching regular files and answers 400 and `{ok:false}` as
  specified.
- **V5c, `test/dom/mesh-agents.test.ts`** (rewritten from V3's rows, keeping every invariant
  case):
  - with no `mesh` key: `BOOT_REQUESTS` unchanged, no strip, no `agent` tab visible, and
    `selectTab('agent')` does nothing;
  - the strip draws one card per agent with §2.1's lines; one card is tabbable; Left, Right, Home
    and End move focus without moving the page's other focus keys; Enter opens;
  - a card click shows the agent tab with that name, selects it, posts exactly one
    `{trigger:'open', name}`, and calls `reloadAndPaint()` once; a second click within 60 s posts
    one (the server skips the check); selecting the active agent tab posts nothing; inner tab
    switches post nothing; closing selects the Dashboard (one Dashboard `open`) and returns focus
    to the card in a focused window;
  - the agent tab never shows a count; attention surfaces equal the run without mesh;
  - Details shows V3's lines; a selection in Card JSON survives a poll and a Refresh that changed
    only `checkedAt`; a hostile card still yields no `img`, no `a[href]` and no request to its
    URLs;
  - the strip is the same under each state filter and under a lens that hides every session, and
    shows in the empty state;
  - an idle tick (304) changes no node, on the Dashboard and on the agent tab;
  - a reload starts with no agent tab; the agent leaving `mesh.json` shows the one line and keeps
    the tab;
  - the existing text guard runs unchanged.
- **V5d:** the runs read happens only with the agent tab active, Run history showing and the
  document visible; Details showing or the Inbox active stops it and keeps the last body; a new
  run inserts one row and leaves the other row nodes identical (same objects); a selection in a
  row survives that poll; Show more is window-local and in `frameInputs()`; a failed read marks
  the table stale without a failed tick; the card's last-run line follows `lastRun`; Forget's
  first press changes only that control and posts nothing, and Keep restores it.
- **V5e:** W5b's client records with §5.4's web search fields; **with `record: true`, a canary
  query appears in no runs file and no `/api/mesh/*` body**; the web search card follows unslop's
  not-running rules.

Before each PR: `fnm use 24`, `npm run typecheck`, `npm test`, and `git diff | ask.sh review`.

---

## §9 — Amendments, exactly

Each lands with the slice named.

**The cards design** (V5c), a header line under "Amends":

> **Amended 2026-11-09 by cards view V5**
> ([`2026-11-09-agent-cards-view-v5-design.md`](2026-11-09-agent-cards-view-v5-design.md)): the
> section's rows become a strip of cards; a card opens the agent in an agent tab with Run history
> and Details; the clients keep a run record the viewer reads. It touches §1, §2.1–§2.3, §2.6,
> §3.2, §4.5, §4.7, §5.2, §6 and §7.

and in place:

- §1 non-goals: "No calling an agent from the app" stays. Add "Run history (V5) shows the
  clients' run records; it never calls an agent."
- §2.1: "One row per configured agent" becomes "one card per configured agent, in a horizontal
  strip (V5 §2)".
- §2.2 and §2.3: a note at each head: "Superseded by V5 §2.1 (the card) and §4 (Details, in the
  agent tab). The lines and words are unchanged; their place moved."
- §2.6: a note pointing to V5 §2.1 and §4's mocks.
- §3.2 "What it never reads": unchanged list; add "It reads `mesh/runs/` only through
  `src/mesh-runs.ts`'s reader (V5 §5.7)."
- §4.5: the handler list gains "4. Opening an agent tab (a card, or the agent tab from another
  tab) posts `{ trigger: 'open', name }` for that agent only"; the read rule's "the Dashboard is
  the current tab" becomes "the Dashboard or the agent tab is the current tab".
- §4.7: the body gains `lastRun`; "Between triggers the read is a 304" becomes "Between triggers
  and runs the read is a 304".
- §5.2: "Logs are not read" stays; add "Run records (`mesh/runs/`) are read; they hold no text
  (V5 §5.5)."
- §6: the "Two render entries" row adds the agent page; the "idle tick" row adds the runs read.
- §7: a note that V5 rewrites `test/dom/mesh-agents.test.ts` for cards and keeps every
  invariant case.

**`docs/architecture/mesh.md`** (V5a, V5b): `paths`/`applyTo` gain `src/mesh-runs.ts` and
`public/mesh-agent-page.js`. The viewer bullet in "Invariants in detail" gains:

> Run history (cards view V5): each client (`src/unslop-client.ts`, `src/request-post-client.ts`,
> later web search's) appends one record per run, at exit, through `src/mesh-runs.ts`'s
> `appendRun()` to `<mesh dir>/mesh/runs/<agent>-<date>.jsonl` (0700 folder, 0600 files,
> `O_APPEND`, one write of at most 512 bytes, 256 KiB a day, 30 days kept), only when the agent's
> key is on, best effort, never changing the exit, stdout or stderr. A record's fields are a
> closed schema with fixed vocabularies: never text, a prompt, a query, an answer, a title, a URL,
> a page id or a token. The viewer reads them only through `readRuns()` (`O_NOFOLLOW |
> O_NONBLOCK`, `fstat`, bounded read, the same validator) for `GET /api/mesh/agents/runs` and
> `lastRun`, and removes them only through the forget route. `disable --unslop --purge` removes
> `runs/unslop-*`.

The purge sentence in "Turning unslop on and off" gains "and its run records".

**`docs/architecture/viewer-dashboard-and-shell.md`** (V5c, V5d): the Mesh agents bullet's
"One row per agent … the expanded row shows the card's lines and a nested Card JSON" becomes the
strip (fixed-width cards, roving Left/Right/Home/End, both-edge CSS shades, thin scrollbar, no
motion) and the agent tab (one slot after History, hidden with no agent, never counted, never
persisted, Close in the page header, Run history default then Details with V3's lines and Card
JSON, rows keyed by run `id` and never rewritten). The read rule adds the agent tab and the runs
read's gate.

**`docs/architecture/attention-and-later.md`** (V5c): one line: "The agent tab (cards view V5)
never carries a count, and nothing in the strip or Run history reaches attention."

**`docs/architecture/overview.md`** (V5a): the list of modules kept out of the stdio graph gains
`src/mesh-runs.ts` (used by the clients and the viewer, never MCP).

**unslop design §4.2, request-post design §7, web search design §4.5** (V5a; web search with
V5e): one line each: "The client also appends a run record without text (cards view V5 §5.4,
§5.5)." Web search §12.2 gains: "The sample folder is never read by the client or the viewer, and
no run record field can hold a query or an answer."

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
7. Click request-post's card: the same tab now shows request-post. Its history is empty unless a
   request was filed since V5a.
8. Open `~/.agent-inbox/mesh/runs/`: one file per agent per day, every line without the draft
   text. `grep -r "quick check" ~/.agent-inbox/mesh/runs/` finds nothing.
9. Close the agent tab: the Dashboard comes back with focus on the card. Reload: no agent tab.
10. The installed app on port 4319 shows no badge or count change.

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
- **Write a "started" line too, to show runs in flight.** A crashed client leaves a run that never
  ends, and a `wait` would sit "running" for hours. Left out; a later slice can add it with a
  stale rule.
- **Rotate one file per agent by renaming at a size limit.** Two clients can rotate at once and
  lose a file; day files need neither a lock nor a rename.

---

## §12 — Risks

| Risk | Mitigation |
|---|---|
| A record leaks private text through a new field later | One schema, closed vocabularies, the same validator on write and read, canary tests over every input, and §9's `mesh.md` rule. |
| A dynamic tab breaks tab keyboard order or the compact masthead | One slot, hidden when unused, skipped by roving; the compact row already scrolls with a shade; the DOM test covers keys with the tab shown and hidden. |
| History fills the disk | 256 KiB a day per agent, 30 days, at most three agents. |
| Concurrent writers interleave | `O_APPEND` single writes of at most 512 bytes; the reader skips anything that does not parse; the eight-process test. |
| History and unslop's usage line disagree | They count different things (client runs vs. the agent's admitted tasks). The usage line keeps "tasks", the summary says "runs". |
| The forget route widens what the viewer may write | Only files the reader would read, by name and `lstat`; never `mesh.json`, tokens, wrappers or logs; tests pin symlinks and other names untouched. |

---

## §13 — Questions for Shariq

1. **Where does an opened agent live?**
   - **A. One agent tab in the library's tab list, after History** (recommended). A whole page
     for Run history, the literal "open as a tab"; never counted, never restored after a reload.
   - B. A pane under the strip in the Agents home, with its own Run history and Details tabs.
     Smallest change, but it sits under all the sessions and pushes the folds down.
   - C. The session panel's sheet. The same gesture as a session card, but a narrow sheet and
     the riskiest code on the Dashboard.
2. **One agent tab, or one per agent?**
   - **A. One tab; opening another card replaces it** (recommended). The tab list grows by at most
     one, which keeps the compact masthead usable.
   - B. One tab per opened agent (at most one per configured agent). Compare two agents by
     switching tabs, at the cost of up to three extra tabs and a close control on each.
3. **What may request-post's run history keep?**
   - **A. Outcome, phase, channels, brand (exit 0 only) and the first 8 characters of the request
     key** (recommended). Enough to tell runs apart and match them to the service's log, which
     also keeps a key prefix; no title or link.
   - B. A, plus the full key and the page id, with an "Open in Notion" link and a copyable
     `status --key` command. More useful; keeps an identifier of every request on disk.
   - C. Outcome and phase only.
4. **How is history forgotten?**
   - **A. A Forget history button in the Run history tab (two-step, in place), plus
     `disable --unslop --purge`, plus the 30-day expiry** (recommended). The viewer's first write
     under the mesh dir, limited to that agent's run files.
   - B. Only from the command line (`disable --unslop --purge`) and the 30-day expiry. The viewer
     stays read-only under the mesh dir; request-post's records can only expire.
   - C. Expiry only.
5. **Should a run record say which project called the agent?**
   - **A. No** (recommended). Nothing about the caller is kept; the record stays about the agent.
   - B. Yes: the project name the inbox would infer for the calling directory. Lets Run history
     say "agent-inbox · main", but adds the caller's project, which can be a customer's
     repository name, to a second store.
