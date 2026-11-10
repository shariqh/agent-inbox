# Design: mesh agents and their cards in the Agents home

**Date:** 2026-11-09
**Status:** Proposed. Waiting for Shariq's decisions (§13).
**Scope of this PR:** this document. No source, test or workflow changes.
**Refs:** #397 (the mesh). Forward-compatible with #506 (declared auth, signed cards, stable IDs,
AI Catalog).
**Builds on:** the mesh design
([`2026-10-29-agent-mesh-design.md`](2026-10-29-agent-mesh-design.md)) §2.1, §2.4, §8.8, §10;
the Agents home ([`2026-11-04-agents-home-design.md`](2026-11-04-agents-home-design.md)) §3, §4;
unslop ([`2026-11-06-unslop-a2a-agent-design.md`](2026-11-06-unslop-a2a-agent-design.md)) §4.4,
§8.3; request-post ([`2026-11-07-request-post-a2a-agent-design.md`](2026-11-07-request-post-a2a-agent-design.md))
§3.1, §6.
**Amends:** the mesh design's §2.1, §2.2, §2.4 (b), §8.8 and §10.2; the rule in
[`docs/architecture/mesh.md`](../../architecture/mesh.md) that "the viewer reads nothing of the
mesh today"; and supersedes unslop §4.5 (b) and request-post §1's "no viewer change" non-goal
(§10 below).
**Revised 2026-11-09 after review round 1:** §2.2-§2.6, §3.4, §4.2-§4.7, §5.1, §7, §9, §10 and
§13 Q3 (now checks on open and Refresh only). Round 2: the open trigger's exact handlers (§4.5),
what paints after each trigger, and the `unchecked` state (§2.4).

---

## §0 — Summary

1. **Ask (Shariq, 2026-11-09):** "work on the UI view of the agent cards so they are exposed in
   the inbox." Two A2A agents are configured through `mesh.json` today: **unslop** (local, on
   loopback, started on demand, exits after 30 idle minutes) and **request-post** (remote, served
   by the publishing service over a tailnet). Each serves an A2A 1.0 Agent Card. The app shows
   none of it.
2. **Where:** a **Mesh agents** section at the end of the Agents home, above its folds. It is
   global: the state filters and the project and agent lens do not narrow it, and it shows in the
   zero-sessions empty state. One row per configured agent: state, name, where it runs, version,
   skill count. A row expands in place to the card's details and, one level deeper, the raw card
   JSON as inert text (§2).
3. **State words are honest.** unslop not running is normal: "Not running · starts on its first
   call", in a neutral tone. A card that fails the client's own checks says which check and how to
   fix it. Nothing in the section is ever an ask (§2.4).
4. **How the viewer learns the config:** lazily. When a page reads `/api/version` or the new
   `/api/mesh/agents`, the viewer `lstat`s `mesh.json` (at most once every 5 s) and re-reads it by
   `readMesh()`'s rule only when it changed. No timer, no `fs.watch`. `/api/version` carries a
   `mesh` key only when the file names an agent this build knows (§3).
5. **How cards are fetched:** a new viewer-only module, `src/mesh-agents.ts`, sends one
   `GET /.well-known/agent-card.json` per agent to the URL built from the configured endpoint,
   never a URL from a card. No token, no redirect, no proxy, a size cap and a total deadline
   (3 s on loopback for unslop, 5 s for every request-post check). It never starts or wakes an
   agent. Checks run only on an open (booting on the Dashboard, `showAgentsHome()`, or switching
   to the Dashboard tab; §4.5 lists the handlers) and when the human presses Refresh; there is no
   cadence (§4).
6. **The card rule is shared.** The two clients' card checks move into a pure module,
   `src/agent-card.ts`, so the view and the clients cannot disagree on "does this card match"
   (§4.4).
7. **Off means off.** With no `mesh.json`, the page makes exactly today's reads, `/api/version`
   is byte-identical, no section is drawn and no network request leaves the viewer (§3.3).
8. **Four slices**, each under about 300 production lines, with route, DOM and import-graph tests
   (§7), and a try-it in the checkout build beside the installed app (§8).

---

## §1 — Goal, scope and non-goals

**Goal.** See, in the app, which mesh agents are configured, whether each is usable right now, and
what each one says it does (its card), without a terminal and without `meshctl status`.

**In scope.** The two agents `meshctl` configures today (`agents.unslop`, `agents.request-post`),
their cards, a light usage line for unslop, and the plumbing the view needs (a lazy config read, a
card fetcher, one read route, one refresh route).

**Non-goals.**

- No calling an agent from the app. No "Start unslop", no test message, no task list.
- No turning agents on or off from the app. `meshctl` stays the only writer of `mesh.json`.
- No registry, no presence publishing, no `@mesh` asks. Those are M3 and M4.
- No change to the stdio MCP server, the hub schema or the dependency set.
- No attention: an agent that is down is not a question for the human.

---

## §2 — Decision 1: what the user sees

### 2.1 Where the agents live

| Option | For | Against |
|---|---|---|
| **A. A "Mesh agents" section at the end of the Agents home, above the folds** (recommended) | The Agents home is already "who is working for me". Agents and sessions sit on one screen. No new tab, no new render entry. | The Agents home grows. With many agents later (M3), the section needs its own fold. |
| B. Its own tab ("Agents" beside Inbox, Plans) | Room to grow for M3's cross-host view. | A tab is an attention surface by convention here: tabs carry counts. A tab for two rows is heavy. A new tab touches `public/tabs.js`, keys and help. |
| C. A Settings panel ("Mesh") | Close to configuration. | Settings is for switches. A card is state, not a setting, and Settings → Mesh was removed by #454 on purpose. |

**Recommendation: A.** The section is a `<section>` with its own header row: a disclosure button
("Mesh agents (2)", `aria-expanded`), the "checked 1m ago" text and a **Refresh** button. Refresh
sits in the header row, never inside a `<summary>` or the disclosure button, so pressing it never
toggles the section. The section is open by default and placed after the session groups and before
the Ended, Dormant and Closed folds. Its open state is window-local and joins `frameInputs()` (§6).

**The section is global.** The state filters (All, Needs you, Working, Quiet, Parked) and the
sidebar's project and agent lens do not narrow it: an agent belongs to no project and is never a
session. It also shows when there are no sessions at all, under the empty state's text. When M3
brings more agents, the same section gains grouping by host; a tab can be reconsidered then
(§13 Q1).

### 2.2 The collapsed row

One row per agent, sorted by name:

1. A state dot and label (§2.4).
2. The name: the `mesh.json` key (`unslop`, `request-post`), not the card's `name`. The card's
   name is shown in the details when it differs.
3. Where it runs: **Local** with `127.0.0.1:<port>` for unslop; **Remote · tailnet** for a
   request-post `https://` endpoint, without the host; **Remote · SSH tunnel** for request-post's
   `http://127.0.0.1:<port>` fallback, since the agent itself is still the remote service. The full
   remote endpoint is shown only in the expanded details, so a screenshot of the Dashboard does not
   show the tailnet name by default.
4. The card's version, its skill count and "A2A 1.0" when the interface matches. When the agent
   is not running and the viewer saw its card earlier, these come from that card and say so:
   "v0.3.1 · seen 2h ago".
5. For unslop only, a usage line from its own budget file (§4.6): "Today: 12 tasks ·
   8 model-minutes".

The section's header row says "Mesh agents (2)" and, at the right, "checked 1m ago" (the oldest
check) and the **Refresh** button.

### 2.3 The expanded row

Opening a row shows, as labelled lines:

| Line | From the card | Shown as |
|---|---|---|
| Description | `description` | Text, up to 500 characters, then "…" |
| Card name | `name` | Only when it differs from the `mesh.json` key |
| Where | the configured endpoint | `http://127.0.0.1:4420`, or the remote endpoint in full; for unslop also "profile: unslop" (the profile's name, never its content) |
| Protocol | `supportedInterfaces[]` | "A2A 1.0 · JSON-RPC" per interface; each interface's `url` as text |
| Capabilities | `capabilities.streaming`, `pushNotifications` | "streaming yes · push no" |
| Auth | `securitySchemes`, `securityRequirements` | "bearer (HTTP Bearer), required" and "token kept outside the app; not shown here" |
| Extensions | `capabilities.extensions[]` | URI, "required" or "optional", then its params as `key value` pairs: numbers and strings as text, arrays joined with ", " (first 8, then "+N"), nested objects as compact JSON text. For unslop: `api 1 · skillId unslop · rulesSha256 3f9a1c0e7b22… · bytes 6,204 · loadedAt 14:02` |
| Skills | `skills[]` | One line each: name (and id when different), description, tags as plain chips |
| Modes | `defaultInputModes`, `defaultOutputModes` | "in text/plain · out text/plain, application/json" |
| Checked | the viewer's own record | "checked 14:02 · card fetched 14:02" or "last good card 12:10" |

Under these, a nested **Card JSON** `<details>` shows the card as the viewer received it,
re-serialised with two-space indents into a `<pre>` through `textContent` (§5.1). It is selectable
for copying. No link, image or icon from the card is ever rendered (§5.1).

### 2.4 States and their words

The page owns only the state labels. Every `reason` and `fix` string comes from
`src/mesh-agents.ts` in the route's JSON and is rendered with `textContent` (§3.4 says why).

| State | When | Label (page) | `reason` and `fix` (server) | Tone |
|---|---|---|---|---|
| `unchecked` | No check has run for this record yet: a viewer that just started, a newly enabled agent, or a changed endpoint, with no trigger since | "Not checked yet" | reason "press Refresh" | neutral |
| `checking` | A check for this agent is running right now | "Checking…" | none | neutral |
| `up` | The card was fetched and passed the client's checks (§4.4) | unslop "Running"; request-post "Reachable" | none | quiet green |
| `not-running` | unslop only: the connection was refused | "Not running" | reason "starts on its first call" | neutral grey, **not** an error |
| `unreachable` | No answer within the deadline, a name that does not resolve, a refused TLS handshake, or HTTP 401 or 403 | "Unreachable" | reason, below | amber |
| `not-a-card` | Something answered, but not with a card: a non-200 status, a redirect, not a JSON object, over 64 KiB | "Not an agent card" | reason, below | amber |
| `mismatch` | A card that fails the client's checks | "Card does not match this build" | reason: the failed check; fix: unslop "rebuild packages/mesh", request-post "update agent-inbox or the service" | amber |
| `invalid` | The `agents.<name>` key is present but its endpoint fails its rule (`loopbackPort()`, `requestPostEndpoint()`) | "Endpoint not accepted" | fix: "run npm run meshctl -- status" | amber, no endpoint shown, nothing fetched |

Reasons are fixed words chosen by `src/mesh-agents.ts`, never a socket's or parser's message:
"does not resolve (is this Mac on the tailnet?)", "connection refused", "TLS handshake failed",
"no answer in 3 s" (unslop) or "no answer in 5 s" (request-post), "connection cut", "the service
refused this device (HTTP 403)", "HTTP 404", "redirect, not followed", "not JSON", "larger than
64 KiB", and the check names of §4.4.

For request-post, a refused connection is `unreachable`: it is a service, and it should be up.
For unslop, a refused connection is the normal idle state. For unslop, something other than a card
answering on its port is `not-a-card` ("something other than the unslop agent answers").

Amber is not attention. No state reaches `public/attention.js`, a badge, a count, a tab, the dock
or a notification (§6).

### 2.5 Mesh off, and keys this build does not know

- **No `mesh.json`, a refused file (symlink, too large, not JSON, newer schema), or no `agents`
  key this build knows:** no section, no read, no fetch. The mesh status command remains the place
  that explains a refused file.
- **An `agents.<name>` key this build does not know** (a later phase's agent): not fetched. The
  section's foot says "1 other agent in mesh.json is not shown by this build". The name is not
  shown.
- **`agentsView`:** ignored, as today.

### 2.6 Mock

Collapsed, inside the Agents home:

```
┌ Agents ─────────────────────── All · Needs you · Working · Quiet · Parked ┐
│ agent-inbox · main                                                        │
│   [session cards …]                                                       │
│                                                                           │
│ Mesh agents (2) ▾                                checked 1m ago  [Refresh]│
│   ○ unslop        Not running · starts on its first call                  │
│                   Local · 127.0.0.1:4420 · v0.3.1 · seen 2h ago · 1 skill │
│                   Today: 12 tasks · 8 model-minutes                       │
│   ● request-post  Reachable                                               │
│                   Remote · tailnet · v1.2.0 · A2A 1.0 · 2 skills          │
│                                                                           │
│ ▸ Ended (5)   ▸ Dormant (2)                                               │
└───────────────────────────────────────────────────────────────────────────┘
```

The header row is one line: the disclosure button on the left, the check time and **Refresh** on
the right, as siblings.

One row expanded:

```
│   ▾ ● request-post  Reachable                          checked 14:02      │
│       Files one publishing request in the queue and reads it back; …      │
│       Where        Remote · https://<name>.<tailnet>.ts.net               │
│       Protocol     A2A 1.0 · JSON-RPC                                     │
│       Capabilities streaming no · push no                                 │
│       Auth         bearer (HTTP Bearer), required                         │
│                    token kept outside the app; not shown here             │
│       Extension    urn:agent-inbox:ext:request-post:v1 · required         │
│                    api 1 · brands brand-a, brand-b                        │
│                    channels blog, x-thread, x-standalone, linkedin        │
│                    categories category-a, category-b · maxBriefBytes 8192 │
│       Skills       request-post: File one blog or social request …        │
│                    [publishing]                                           │
│                    request-post-status: Read one agent-filed request …    │
│       Modes        in text/plain · out text/plain, application/json       │
│       ▸ Card JSON                                                         │
```

---

## §3 — Decision 2: how the viewer learns the config

### 3.1 Options

| Option | Cost when off | Notes |
|---|---|---|
| A. §2.1's once-a-minute `stat` timer in the viewer process | One failed `stat` a minute, forever | The rule the mesh design accepted. A timer runs even when nobody looks. |
| B. `fs.watch` on the mesh dir | An open watch handle, platform quirks (macOS FSEvents coalescing, a missing folder) | Fast, but a watch on `~/.agent-inbox` sees every hub write. |
| **C. Lazy: `lstat` only when a request needs the config, at most once every 5 s** (recommended) | One failed `lstat` per `/api/version` read (at boot, `showAgentsHome()`, opening a session panel, after a Setup install) | No timer and no handle. `/api/mesh/agents` is read only while `/api/version` last carried `mesh`, the Dashboard is the current tab and the window is visible (§4.5), so a closed or hidden app does nothing. |

**Recommendation: C.** It is cheaper than §2.1's exception and needs no timer, which also keeps
`createViewer` timer-free for the route tests.

### 3.2 The rule

- **Who reads:** only `src/mesh-agents.ts`, in the viewer process. `viewer-server.ts` builds it
  with `meshDir()` and passes it to `createViewer` as `opts.mesh`. Without the option, as in every
  existing route test, `/api/version` carries no `mesh` key and `/api/mesh/agents` answers
  `{ "on": false, "agents": [] }` without touching the file system.
- **How:** `lstat(<mesh dir>/mesh.json)`. When the result's device, inode, size, `mtimeMs` and
  `ctimeMs` match the last one, the last reading stands. Otherwise `readMesh()` reads it by the one
  rule: a regular file, never a symlink, at most 64 KiB, a JSON object with `schema` 1. Anything
  else is off. A newer schema is off. `parseMesh` and `readMesh` are unchanged.
- **Cadence:** at most one `lstat` per 5 s, on demand: a read of `/api/version` or
  `/api/mesh/agents`, or a trigger on `POST /api/mesh/agents/refresh`. No timer, no `fs.watch`.
- **What it keeps:** for each known key, its endpoint (only when it passes its rule) and, for
  unslop, the profile name. Nothing else from the file reaches a response. A key whose endpoint
  changed starts a fresh record (`unchecked`), so a card from the old endpoint is never shown for
  the new one, and the row asks for Refresh instead of saying "Checking…" until a trigger comes.
- **What it never reads:** `mesh/tokens/*`, `mesh/wrappers/*` (the unslop profile holds the
  backend URL and key source), `unslop-deny.txt`, and the logs. The one other file it reads is
  unslop's budget (§4.6). It reads `mesh/runs/` only through `src/mesh-runs.ts`'s reader (V5 §5.7).

### 3.3 `/api/version`

`/api/version` gains `mesh: { "agents": <n> }` only when `opts.mesh` is set, the file reads
present by the rule, and `n` (the count of known agent keys, valid or not) is at least 1. In every
other case the body is byte-identical to today's. The page keeps reading `/api/version` exactly
where `refreshLiveVersion()` reads it today: at boot (from `initSessionsIndicator()`, on any tab),
in `showAgentsHome()`, in `openSessionFocus()` and after a Setup install. It adds no read of its
own. `selectTab('dashboard')` does not re-read it today and still does not: switching to the
Dashboard tab uses the last known `liveVersion.mesh`. So an agent enabled while the app is open
appears after the next of those reads (G L, the Sessions line, opening a session panel, a Setup
install or a reload).

This restores the mesh design's §2.4 (b) and §10.2 in a smaller form: there is no
`/mesh-view.js` import, because the section lives in `public/agents-home.js`, which is always
loaded. The key only tells the page that `/api/mesh/agents` is worth reading.

### 3.4 Process boundaries

- `src/mesh-agents.ts` and `src/agent-card.ts` join the mesh modules that must never enter the
  stdio MCP graph. `test/prstate.test.ts`'s `MESH` list names both explicitly (`mesh-agents` also
  matches its `/mesh/i` net; `agent-card` does not, so the explicit entry matters).
- `src/mesh-agents.ts` imports only Node core, `./mesh-config.js` and `./agent-card.js`.
  `src/agent-card.ts` imports nothing at all. Neither imports `store.ts`. `test/mesh.test.ts` pins
  these imports. `agent-card.ts` gets its own assertion that its import list is empty, outside the
  `MESH_FILES` loop, which expects at least one import per file.
- **The text guard stays as it is.** `test/mesh.test.ts`'s "no viewer, frontend or Electron file
  reaches the unslop or request-post client" matches the text `unslop-client`,
  `request-post-client` or `meshctl` anywhere in `src/viewer*.ts`, `public/*.js` and
  `electron/*`, comments included. So no user-facing phrase that names the command lives in those
  files. **Choice:** every `reason` and `fix` string is built in `src/mesh-agents.ts` (not a
  `viewer*` file, so not under the guard) and sent in the route's JSON; the page renders it with
  `textContent`. The page's own fixed words avoid the command's name ("token kept outside the app;
  not shown here", "the mesh status command"). The guard's file list and pattern do not change.
- No new package. `test/fixtures/app-dependencies.txt` is unchanged.

---

## §4 — Decision 3: how cards are fetched

### 4.1 Which process

The viewer server, in `src/mesh-agents.ts`, like `src/prstate.ts` and `src/issue-poller.ts`.
Never the frontend: the page reads only `/api/mesh/agents` on its own origin, so the CSP and the
loopback boundary are unchanged. Never the MCP server: it stays network-free. Never Electron main.

### 4.2 The wire, for both agents

- One `GET /.well-known/agent-card.json` with `node:http` or `node:https`, `agent: false` (no
  keep-alive, no environment proxy), `Host` exactly the endpoint's authority, the TLS name the
  endpoint's host, `Accept: application/json`, and no `Origin`, `Authorization`, cookie or
  `A2A-Version` header.
- The URL is built from the configured endpoint, which already passed its rule. **A URL from a
  card (`supportedInterfaces[].url`, `documentationUrl`, `iconUrl`, `provider.url`) is never
  called.**
- No redirect is followed: a 3xx is `not-a-card` ("redirect, not followed").
- The body is read up to 64 KiB, then the request is destroyed (`not-a-card`, "larger than
  64 KiB"). It must parse as a JSON object.
- **One total deadline per check**, wall clock, covering lookup, connect, TLS, headers and body:
  3 s for unslop (as `meshctl unslop` uses on loopback) and 5 s for every request-post check,
  whether its endpoint is the tailnet form or the SSH fallback. It is one `AbortSignal.timeout()`
  passed to the request (or one timer that destroys it), never per-phase socket timeouts, so a
  server that drips one byte every 500 ms still ends at the deadline ("no answer in 3 s" or
  "no answer in 5 s").
- TLS: Node's default verification. The `https://<name>.<tailnet>.ts.net` form is the only remote
  form `requestPostEndpoint()` accepts, so a remote card is fetched over TLS. The SSH fallback
  `http://127.0.0.1:<port>` is a local tunnel end, so it is plain HTTP on loopback.

### 4.3 Per agent

**unslop.** Its card is served only while the agent runs. The viewer **never starts or wakes it**:
a refused connection is `not-running`, with no spawn and no retry. A card `GET` carries no token,
so it does not count as activity: the agent still exits after 30 minutes with no task and no
authenticated request (unslop design §4.3). When the viewer has seen a good card earlier in its
own lifetime, the row shows that card, marked "seen 2h ago" (§13 Q2 weighs a disk copy).

**request-post.** The card is fetched with no token, as `meshctl request-post` fetches it, through
the publishing service. The service's `serve` front needs the device's app capability, which this
Mac has. From a machine without it, the row says "the service refused this device (HTTP 403)",
which is the same fact the client reports as exit 15. Because each check reaches the service, it
runs only on the two triggers of §4.5.

### 4.4 One card rule: `src/agent-card.ts`

The clients' checks move into one pure module, so the view's `mismatch` and a client's exit 14 or
15 always agree. The module grows in two steps, because `test/dead-exports.test.ts` never counts a
test as a consumer and every export needs a shipping caller when it lands:

- **V1:** `checkCard(agent, card)` only. It returns `undefined` or one fixed reason. unslop: the
  `unslop` skill, a `JSONRPC` interface with `protocolVersion` `1.0`, and
  `urn:agent-inbox:ext:unslop:v1` with `api: 1`. request-post: both skills, the same interface,
  and `urn:agent-inbox:ext:request-post:v1` with `api: 1`. These are exactly `cardMismatch()` in
  `src/unslop-client.ts` and the check in `src/request-post-client.ts`'s `send()` today; both
  clients call it from V1 on.
- **V2, with their first caller (`src/mesh-agents.ts`):**
  - `summarizeCard(card)` builds the bounded view the page gets (§2.3): strings cut to their caps
    (name 80, description 500, skill description 300, tag 40, extension param text 200), at most
    16 skills, 8 interfaces, 8 extensions and 8 tags per skill, each with a "+N more". It replaces
    with U+FFFD: C0 controls but tab and newline, DEL, C1 controls, the bidirectional marks
    U+200E, U+200F and U+061C, the overrides and isolates U+202A–U+202E and U+2066–U+2069, and the
    line and paragraph separators U+2028 and U+2029.
  - `cardJson(card)` is the raw view: `JSON.stringify(card, null, 2)` with every character of that
    list that JSON leaves raw (the bidirectional marks, overrides, isolates and U+2028/U+2029)
    written as a `\u` escape. JSON already escapes the C0 controls.

The clients import `checkCard` and keep their own wording around it; their exit codes and tests do
not change. The module is pure: no imports and no I/O.

### 4.5 When checks run

- **Two triggers only, for both agents:** an **open** and a **Refresh** press. There is no
  interval and no background cadence. Each card `GET` to request-post goes through the publishing
  service, so it should happen only when the human looks. unslop's local card follows the same
  rule, so "checked 1m ago" means the same thing on both rows.
- **What an open is, exactly.** One helper, `meshOpen()` in `public/app.js`, posts the `open`
  trigger, and only these handlers call it, each only when the last `/api/version` carried `mesh`:
  1. **Boot:** once, when the boot's `/api/version` read (`initSessionsIndicator()`'s
     `refreshLiveVersion()`) resolves with `mesh` and the active tab is the Dashboard. Booting on
     another tab posts nothing.
  2. **`showAgentsHome()`** (G L, the Sessions line, the Now strip's Working tile), after its
     `refreshLiveVersion()` resolves. When it switches tabs through `selectTab('dashboard')`, that
     call does not post a second time: one navigation, one open.
  3. **`selectTab('dashboard')` from another tab** (the tab strip, its key), using the last known
     `liveVersion.mesh`, since this path does not re-read `/api/version` (§3.3). Selecting the
     Dashboard while it is already the active tab posts nothing.

  An open never fires from a render, a paint, a poll tick, `load()`, `reloadAndPaint()`,
  `openSessionFocus()` or a Setup install.
- **The route.** `POST /api/mesh/agents/refresh` with `{ "trigger": "open" }`,
  `{ "trigger": "refresh" }` or `{ "trigger": "refresh", "name": "<key>" }`. It checks the agents,
  waits for the checks to finish (bounded by the deadlines of §4.2, one check per agent at a time)
  and answers `{ "ok": true }`. Any other body is 400; a name that is not configured is 200
  `{ "ok": false, "error": "not configured" }`. An `open` check skips an agent checked in the last
  60 s, so switching tabs back and forth sends nothing new; a `refresh` skips one checked in the
  last 5 s.
- **What follows each trigger.** Only a **Refresh press** ends in `reloadAndPaint()`, after its
  POST answers: the human asked, so the human path paints. An **open** paints nothing itself: when
  its checks finish, the next poll tick reads the new body (a 200 instead of a 304) and paints
  through `renderIfIdle()` under the normal gates (a held press or a draft defers it; a selection
  survives it, since only changed text is rewritten). A row shows
  `checking` while its check runs, if a tick lands meanwhile.
- **The read.** The page reads `GET /api/mesh/agents` only when the last `/api/version` carried
  `mesh`, the Dashboard is the current tab and the document is visible. Then it is one more read
  in the poll tick, a conditional one (§4.7). The read never starts a check; between triggers it
  is a 304.
- **The page's fallback**, like `messagesBody` for `/api/messages`:
  - a failed read (a network error, a 404 from an older viewer, a body that is not the expected
    shape) keeps the previous model and marks the section stale ("could not read; showing what
    was last read"). It is never a failed tick and never shows "disconnected";
  - when the read is skipped because the Dashboard is not showing or the document is hidden,
    `lastData.mesh` keeps the last body, not `null`, so returning to the Dashboard paints the last
    known state at once;
  - a body with `on: false` (the file went away or was refused) hides the section and stops the
    read until the next `/api/version` read carries `mesh` again.

### 4.6 unslop's usage line

The unslop agent writes `<mesh dir>/mesh/unslop-budget.json` (`date`, `tasks`, `modelMs`, 0600).
The viewer reads it when it checks unslop: `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, a regular file the
user owns, at most 4 KiB, three fields of the right types. A `date` other than today's local date
reads as zero. Anything else hides the line. Only counts are shown; the daily limits live in
`packages/mesh` and are not copied into the app. request-post's budget lives in the service and is
not shown: reading it would need an authenticated call.

### 4.7 The route and caching

`GET /api/mesh/agents` answers:

```json
{
  "on": true,
  "agents": [
    {
      "key": "mesh.json:unslop",
      "name": "unslop",
      "where": "local",
      "endpoint": "http://127.0.0.1:4420",
      "profile": "unslop",
      "state": "not-running",
      "reason": "starts on its first call",
      "fix": null,
      "checkedAt": "2026-11-09T22:02:11.000Z",
      "card": null,
      "cardJson": null,
      "lastSeen": { "at": "2026-11-09T20:01:02.000Z", "card": { "name": "unslop", "...": "..." } },
      "lastRun": { "at": "2026-11-09T21:58:40.112Z", "op": "docs", "outcome": "ok" },
      "usage": { "date": "2026-11-09", "tasks": 12, "modelMs": 480000 }
    }
  ],
  "others": 0
}
```

- **Built fresh per request** from the module's in-memory records, with `Cache-Control:
  no-store` and an ETag over the bytes, answering 304 on a match, as `/api/activity/history` does.
  It is not a retained snapshot: no `SNAPSHOT_SOURCES` entry, no `snapshot_domains` row, no
  trigger, and `test/fixtures/snapshot-triggers.txt` is unchanged.
- **A failure is never cached as success.** A check that fails after a good one sets the failure
  state; the good card moves to `lastSeen` with its time and is never reported as `card` again
  until a later check passes. A `mismatch` keeps the failing card in `card` and `cardJson` so the
  human can see what is wrong.
- `checkedAt` changes only when a trigger ran a check, and every trigger is a human navigation or
  press. Between triggers and runs the read is a 304, which resolves to the same object, so an idle tick
  paints nothing (#298). The "checked 1m ago" label follows the existing 30-second label clock.
- `lastRun` (cards view V5 §5.7, slice V5b) is `{ at, op, outcome }` from the newest valid run
  record by end time, or `null`. It changes only when a run lands, which is a content change.
- `where` is `local` (unslop), `tailnet` (request-post's `https://` form) or `ssh-tunnel`
  (request-post's `http://127.0.0.1:<port>` fallback). `reason` and `fix` are the server's fixed
  words of §2.4, or `null`.
- Nothing is written to the hub or to disk. A viewer restart starts every agent at `unchecked`
  until the next trigger. `state` is `checking` only while a check is actually running; a record
  is never left at `checking` without one.

---

## §5 — Decision 4: security and privacy

### 5.1 Card text is untrusted

- Every card string reaches the DOM through `textContent` or `esc()`. The raw JSON goes into a
  `<pre>` through `textContent`.
- **No `href` from a card.** `documentationUrl`, `provider.url` and interface URLs are shown as
  text. If a later change makes one a link, it goes through `chipHtml()` and `safeHttpUrl()` like
  every other link (`links.md`), and opens only through Electron main.
- **No remote image.** `iconUrl` is never rendered. The CSP allows images, so this is enforced in
  code and tested: the DOM test counts `img` elements and requests.
- Focus and open state are restored by comparing `dataset` values, never by a selector built from
  a name.
- The server cuts and cleans strings (§4.4) before the page sees them, so a hostile card cannot
  flood the DOM or reorder text with bidirectional controls.

### 5.2 Secrets

- The viewer never opens `mesh/tokens/*` or `mesh/wrappers/*`, never sends a token, and never
  shows one. The Auth line says the token is kept outside the app, not what it is.
- The viewer never reads the unslop profile, so the backend URL and API key source never reach it.
- Logs are not read. Run records (`mesh/runs/`) are read, never written or deleted; they hold no
  text (V5 §5.5).

### 5.3 Endpoints and the network

- The only hosts the viewer contacts for this view are `127.0.0.1` and the one remote endpoint
  that passed `requestPostEndpoint()`. Both come from `mesh.json`, which only `meshctl` writes.
- The remote host appears only in the expanded details. The collapsed row says "Remote · tailnet"
  or "Remote · SSH tunnel".
- No new Electron grant, no new IPC, no new window permission. The page's requests stay on its
  own origin.

---

## §6 — Decision 5: invariants kept

| Invariant | How it holds |
|---|---|
| One attention predicate; nothing mesh reaches a badge, count, tab, rail or dock | The section reads only `lastData.mesh`. It never touches `public/attention.js` inputs. The DOM test compares the attention surfaces with the section drawn against the same seed without it (the `surfaces()` check in `test/dom/agents-home.test.ts`). |
| Two render entries | The section paints inside `agentsHome.paint()`, which `renderDashboardAmbient` calls from both `load()` and `reloadAndPaint()`. Only a Refresh press ends in `reloadAndPaint()`; an open's result arrives on the next poll tick and paints through `renderIfIdle()` under the normal gates. Toggling a row repaints its own region from the last model, as the folds do. |
| An idle tick paints nothing (#298) | The read joins `lastData.reads` by identity; the section's open state, the open rows and the open JSON blocks join `agentsHome.state()`, which is in `frameInputs()`. No check runs without a human trigger, and a 304 resolves to the same object, so nothing paints. A skipped read keeps the last body, so leaving the Dashboard changes no read either. |
| A held pointer, scroll or selection is never a suspension | Rows update in place keyed by `key`, each part rewritten only when its own text changes. The JSON `<pre>` is rewritten only when `cardJson` changes, so a selection inside it survives polls. |
| The Agents view is always on | Unchanged. The section is part of it and is simply absent when the mesh is off. |
| Off means off (M2 and later) | No file: the page's request list and every body and ETag, `/api/version` included, are identical to today's. No `lstat` beyond one per `/api/version` read; no socket. |
| No network in the MCP process; no mesh module in the stdio graph | `src/mesh-agents.ts` and `src/agent-card.ts` join the forbidden list in `test/prstate.test.ts`. |
| No raw SQL outside `store.ts`; no hub schema change | The view touches no database. |
| Viewer write routes validate bodies first | The refresh route answers 400 on a bad body and 200 `{ok:false}` on an unknown name. |
| Dead exports | Tests never count as consumers, so each export lands with its first shipping caller: `checkCard` in V1 (the clients), `summarizeCard` and `cardJson` in V2 (`src/mesh-agents.ts`), the route module in V2 (`viewer-server.ts`, `viewer.ts`), the page module in V3 (`agents-home.js`). |
| The text guard on clients' names | Unchanged: no `src/viewer*.ts`, `public/*.js` or `electron/*` file contains `unslop-client`, `request-post-client` or `meshctl`; fix texts come from the server (§3.4). |
| No new dependency | `test/fixtures/app-dependencies.txt` unchanged. |
| Motion | None. No pulse, no animation. |

---

## §7 — Decision 6: slices and tests

Each slice is one PR, mergeable alone, with its docs.

| Slice | Content | Production lines (est.) |
|---|---|---|
| **V1. One card rule** | `src/agent-card.ts` with `checkCard` only; both clients call it; the pins: `test/mesh.test.ts`'s client import pins gain `./agent-card.js`, `agent-card.ts` gets its own "imports nothing" assertion, and `test/prstate.test.ts`'s `MESH` list names `src/agent-card.ts`; `mesh.md` notes the module | ~60 |
| **V2. The viewer side** | `summarizeCard` and `cardJson` in `src/agent-card.ts`; `src/mesh-agents.ts` (lazy config read, card fetch, records, triggers, fixed `reason`/`fix` words); `opts.mesh` in `createViewer`; `/api/version`'s `mesh` key; `GET /api/mesh/agents`; `POST /api/mesh/agents/refresh`; wiring in `viewer-server.ts`; `mesh-agents.ts` added to both pins; `mesh.md`, `overview.md`, `CLAUDE.md` and the mesh design's amendments (§10) | ~300 |
| **V3. The section** | `public/mesh-agents.js` (pure row model and painter), mounted by `public/agents-home.js` outside the filtered groups; the poll's gated read, its fallback and the open trigger in `public/app.js`; styles in `public/style.css`; `viewer-dashboard-and-shell.md` | ~280 |
| **V4. unslop usage** | The budget read (§4.6) and its line | ~60 |

V4 can be dropped without changing V1–V3.

**Tests.**

- **V1, `test/agent-card.test.ts`:** the R1 fixture card
  (`test/fixtures/a2a-request-post/card.json`) and unslop's card (built from the agent source, as
  `test/unslop-client.test.ts` does) pass `checkCard`; each mutation (a skill gone,
  `protocolVersion` 0.3, no extension, `api: 2`) fails with its fixed reason.
  `test/unslop-client.test.ts` and `test/request-post-client.test.ts` pass unchanged. The pin
  changes above land here, with the first import of `./agent-card.js`.
- **V2, `test/agent-card.test.ts`** gains `summarizeCard` and `cardJson`: caps and "+N more"; a
  description holding `<img src=x>`, NUL, ESC, U+200E, U+200F, U+061C, U+202E, U+2066, U+2028 and
  U+2029 comes back with each of them replaced and the markup intact as text; `cardJson` writes
  every listed character JSON leaves raw as a `\u` escape.
- **V2, `test/mesh-agents.test.ts`** (real temp dirs from `scratchDir()`, fake card servers on
  loopback, no mocks of `fs`): no file, a symlink, 64 KiB + 1, not JSON, schema 2, no known key and
  a bad endpoint each give no `mesh` key, a byte-identical `/api/version`, and zero connections on
  a counting listener; the `lstat` happens at most once per 5 s; unslop refused is `not-running`
  and a spy on every `node:child_process` entry point sees nothing; a running fake is `up`; a
  mismatch names its check and carries its `fix`; request-post through the SSH-tunnel form is `up`
  with `where: "ssh-tunnel"` and a 5 s deadline, and through an injected `lookup` that fails is
  `unreachable` "does not resolve"; a 302 is not followed; a 70 KiB body is cut; **a drip-feed
  server (1 byte every 500 ms, headers and body) ends at the 3 s or 5 s total deadline**, not
  later; the request carries no `Authorization`, `Origin` or cookie; one check per agent at a time;
  `GET /api/mesh/agents` alone never opens a connection; an `open` trigger skips an agent checked
  in the last 60 s and a `refresh` one checked in the last 5 s; refresh's 400 and `{ok:false}`; a
  good card then a failure gives `unreachable` with `lastSeen`, never `up`; a new viewer starts
  every agent `unchecked`; **a changed endpoint, followed by `GET /api/mesh/agents` reads and no
  trigger, stays `unchecked` (never `checking`)**; `checking` is reported only while a held fake
  server keeps a check open, and ends with the check. `test/mesh.test.ts`'s `/api/version` case
  becomes "carries `mesh` only with a known agent".
- **V3, `test/dom/mesh-agents.test.ts`** (`// @vitest-environment jsdom`, the harness):
  - with no `mesh` key, the boot and poll request lists equal `test/dom/agents-home.test.ts`'s
    `BOOT_REQUESTS`, no refresh is posted and no section exists (that file is unchanged and stays
    green);
  - with the key, the section draws both rows with the words of §2.4 and the server's `reason`
    and `fix`; the read happens only on the Dashboard with the document visible, and leaving the
    Dashboard stops it while keeping the last body;
  - **the open trigger, one per navigation:** booting on the Dashboard posts one `open` once the
    boot's `/api/version` carries `mesh`; booting on another tab posts none; `selectTab('dashboard')`
    from another tab posts one; `showAgentsHome()` from another tab posts exactly one (not a second
    from its `selectTab` call), and from the Dashboard posts one; selecting the Dashboard while it
    is active posts none; `reloadAndPaint()`, a poll tick, `openSessionFocus()` and a Setup install
    post none; with no `mesh` in the last `/api/version`, no navigation posts anything;
  - **an open paints through the poll:** after an `open` POST answers, no `reloadAndPaint()` runs;
    the next poll tick reads the new body (200) and the rows change through `renderIfIdle()`; a
    held press defers that paint as for any other tick, and a selection in the section survives it
    (the tick paints, rewriting only text that changed);
  - **the section is global:** it shows the same rows under each state filter (Needs you, Working)
    and under a project and agent lens that hides every session; and it shows in the zero-sessions
    empty state, under the empty text;
  - a failed read (a 500, a 404, a body of the wrong shape) keeps the previous rows, marks the
    section stale and leaves the tick applied (no "disconnected"); a body with `on: false` hides
    the section and stops the read until `/api/version` carries `mesh` again;
  - the attention surfaces (title, badge, tab counts, Needs you rows) equal the run without mesh;
  - a hostile card: no `img`, no `a[href]` from card data, no request to the card's URLs, the text
    shown literally;
  - an idle tick (a 304) changes no node; a selection inside an open Card JSON survives a Refresh
    whose result changed only `checkedAt`;
  - Refresh sits in the header row outside the disclosure button: pressing it does not toggle the
    section; it posts `refresh`, then (and only then) repaints through `reloadAndPaint()`;
  - toggles are window-local and in `frameInputs()`;
  - no `public/*.js` file contains the guarded names (the existing guard, run unchanged).
- **V4:** the usage line with today's date, zero for yesterday's, hidden for a symlink or a
  malformed file.

Before each PR: `fnm use 24`, `npm run typecheck`, `npm test`, and `git diff | ask.sh review`.

---

## §8 — Try it

Your real config already has unslop and request-post on in `~/.agent-inbox/mesh.json`. Keep the
installed app running; the checkout build runs beside it on port 4392.

1. In the checkout of the V3 (or V4) branch: `fnm use 24 && npm ci && npm run build`.
2. `AGENT_INBOX_PORT=4392 npm run electron:side`. The window opens on the Dashboard.
3. Scroll to the end of the Agents home. **Mesh agents (2)** shows unslop and request-post; the
   window's opening was the first trigger. unslop most likely says "Not running · starts on its
   first call" (no "seen" time yet, since this viewer just started). request-post says
   "Reachable" within 5 s.
4. In a terminal: `echo "Draft text for a quick check." | ~/.agent-inbox/bin/unslop --kind docs`.
   Then press **Refresh**: unslop says "Running" with its card. Nothing changes until you press
   it or reopen the Agents home; that is the design.
5. Open unslop's row: the `rulesSha256` prefix matches the one the command printed on stderr.
   Open **Card JSON** and select some text; it stays selected across polls.
6. Open request-post's row: the endpoint appears only here; the Auth line names the bearer scheme
   and says the token is kept outside the app.
7. Set the filter to Working, then pick a project in the sidebar lens: the Mesh agents section
   stays the same.
8. Check the installed app on port 4319: nothing changed there, and no badge or count changed in
   either window.
9. Optional: switch off Wi-Fi or Tailscale and press **Refresh**: request-post says
   "Unreachable · does not resolve (is this Mac on the tailnet?)", amber, not a question.
10. Close the side window. Nothing to undo: the view writes nothing.

---

## §9 — Forward compatibility (M3 and #506)

- **Keys.** Each record is keyed `"<source>:<name>"`. Today the only source is `mesh.json`
  (`mesh.json:unslop`). M3's registry would add `registry:<namespace>/<name>`; #506's AI Catalog
  would add `catalog:<id>`. When #506 gives agents stable URNs, the key becomes that URN whenever
  the card declares one, and `name` stays the label. The DOM, focus and open state use `key` only,
  so an agent that moves host or port keeps its row, and a key change closes an open row once at
  worst.
- **No source abstraction yet.** `src/mesh-agents.ts` reads `mesh.json` directly; it has no list
  of sources and no `stateSince` field. M3 adds what it needs (a registry source, grouping by host,
  state ages) when it lands. The route's shape (`agents[]` with `key`, `where`, `state`, `card`)
  is meant to survive that.
- **Declared auth (#506).** The Auth line already reads `securitySchemes` and
  `securityRequirements`. Both cards declare a bearer scheme today.
- **Signed cards (#506).** A record gains a `trust` field ("signed by <key id>", "unsigned",
  "signature does not verify") shown as one more line, and a failed signature becomes a
  `mismatch` reason. The check belongs in `checkCard`, so clients and view agree again.
- **Residency (#506).** Per-skill residency is an extension param, which the Extensions line
  already shows.

---

## §10 — Amendments, exactly

**`docs/architecture/mesh.md`, "Invariants in detail", first bullet.** Replace:

> The viewer reads nothing of the mesh today: no stat watch, no `createViewer` option, no
> `/api/version` key. The phase that first needs the viewer to know (M3) restores a watch under
> the same rules the mesh design's §2.1 sets.

with:

> The viewer reads the mesh only in `src/mesh-agents.ts` (the agent cards view, design
> `docs/superpowers/specs/2026-11-09-agent-cards-view-design.md`): `viewer-server.ts` passes it to
> `createViewer` as `opts.mesh`. It `lstat`s `mesh.json` only when a page reads `/api/version` or
> `/api/mesh/agents`, at most once every 5 s, and re-reads the file by `readMesh()`'s rule only when
> its identity, size or times changed; no timer and no `fs.watch`. `/api/version` carries
> `mesh: { agents: n }` only when the file reads present and names an agent this build knows. It
> fetches each agent's card from the configured endpoint only (never a URL from a card), with no
> token, no redirect, no proxy, a 64 KiB cap and one total deadline (3 s for unslop, 5 s for every
> request-post check), only on the open trigger (boot on the Dashboard, `showAgentsHome()`,
> `selectTab('dashboard')` from another tab) or a Refresh press; reading
> `/api/mesh/agents` never starts a check. It never starts an agent and never opens `mesh/tokens`
> or `mesh/wrappers`. Its user-facing `reason` and `fix` words live in `src/mesh-agents.ts`, so the
> text guard on `src/viewer*.ts`, `public/*.js` and `electron/*` stays as it is.
> `src/agent-card.ts` holds the one card rule both clients and the view use.

The "In brief" bullet "The viewer's watch returns with the first phase that needs it (M3)" becomes
"The viewer reads `mesh.json` lazily for the agent cards view (below)". The Agents view bullet's
"fetches nothing" becomes "reads `/api/mesh/agents` only for its Mesh agents section, and only when
`/api/version` carries `mesh`". `paths`/`applyTo` gain `src/mesh-agents.ts`, `src/agent-card.ts`
and `public/mesh-agents.js`. (V3 note: the page module ships as `public/mesh-section.js`, because
`test/dead-exports.test.ts` requires module basenames unique across `public/` and `src/`, and
`src/mesh-agents.ts` holds the name. Also V3: a held press defers the open's poll paint, and a
selection in the section is never a suspension: the tick paints, rewriting only changed text, so the
selection survives, as `docs/architecture/viewer-frontend.md` requires; §4.5 and §7 say so.)

**`CLAUDE.md`, the mesh invariant line.** From:

> Mesh is opt-in: off means off from M2 on; the Agents view is always on (#454). → mesh

to:

> Mesh is opt-in: off means off from M2 on; the Agents view is always on (#454). The viewer
> reads mesh state only in `src/mesh-agents.ts`: lazily, never starting an agent or sending a
> token, never feeding attention. → mesh

and "No network in the MCP process; `prstate`/`issue-poller` stay viewer-only" gains
`mesh-agents`. `test/instructions-budget.test.ts` decides whether the line fits; if not, the
second sentence moves to `mesh.md` only.

**`docs/architecture/overview.md`.** The viewer-only list gains `src/mesh-agents.ts`.

**The mesh design.** A header note "Amended 2026-11-09 by the agent cards view" and:

- §2.1: the stat exception becomes "the viewer `lstat`s `mesh.json` only when a page reads
  `/api/version` or `/api/mesh/agents`, at most once every 5 s; no timer".
- §2.2: a new table row:

  | Piece | Runs where | Switched on by | Off means |
  |---|---|---|---|
  | Mesh agents section (agent cards view) | viewer process (`src/mesh-agents.ts`) and the Agents home | `agents.unslop` or `agents.request-post` in `mesh.json` | No section, no `/api/mesh/agents` read, no socket |

- §2.4 (b): the `mesh` key returns in `/api/version` as `{ agents: n }`, and the no-file test
  asserts the unchanged request list and bodies.
- §8.8: "The viewer calls only the registry URL in `mesh.json`" adds "and each configured agent's
  card URL, built from an endpoint that passed its rule; never a URL from a card".
- §10.2: `/mesh-view.js` is replaced by the section in `agents-home.js` reading
  `/api/mesh/agents`.

**Superseded non-goals.** Each gets a one-line note pointing here:

- **unslop design §4.5 (b)**, "M2a touches nothing under `public/`, `src/viewer*.ts` or
  `electron/`": it held for M2a. The agent cards view now adds a viewer module, a route and a
  page section for the configured agents. The client itself is still not reachable from any of
  those files, and the text guard that tests it is unchanged.
- **request-post design §1**, non-goal "A viewer change in Agent Inbox": superseded the same way.
  §10's "no viewer, `public/` or `electron/` file names it" still holds.

**`docs/architecture/viewer-dashboard-and-shell.md`.** The Agents home bullet gains the section,
its states, that it is global (no filter or lens narrows it, and it shows with no sessions), its
window-local open state in `frameInputs()`, and "nothing it draws reaches attention".

---

## §11 — Alternatives considered

- **Read cards in the page with `fetch()`.** Rejected: the page would contact the tailnet, the
  CSP would have to widen `connect-src` later, and the unslop agent refuses any request with an
  `Origin` header.
- **Have the clients write a card cache to disk, and the view read only that.** No new network
  code in the viewer, but the view would show only what the last call saw, and request-post's
  state would be stale for days. Kept as an option for unslop's "seen" card (§13 Q2).
- **Compute unslop's card from its profile and rules without starting it.** Rejected: it means
  reading the profile (backend URL, key source) and duplicating the agent's card code in the app.
- **Start unslop to read its card.** Rejected: the view must not start processes or spend the
  agent's idle budget, and the shim is the only sanctioned starter.
- **Store records in the hub.** Rejected: a schema change for observation state, against §2.4 (d).

---

## §12 — Risks

| Risk | Mitigation |
|---|---|
| The view and a client disagree on a card | One rule in `src/agent-card.ts`, tested against the R1 fixture and the agent's own card. |
| A hostile or broken card hurts the page | Caps, control and bidirectional cleaning on the server, `textContent` on the page, no links or images; the hostile-card DOM test. |
| Checks cost the service or the box | Only on Agents home open (skipping an agent checked in the last 60 s) and on Refresh; one at a time; no token; reading the section never checks. |
| The remote host leaks through a screenshot | Collapsed rows say "Remote · tailnet" or "Remote · SSH tunnel"; the host is in the expanded details only. |
| The section looks stale between triggers | "checked 1m ago" is always shown beside Refresh; reopening the Agents home checks again. |
| `/api/version` changes for existing users | Only when `mesh.json` names a known agent, which means `meshctl enable --unslop` or `--request-post` was applied. |

---

## §13 — Questions for Shariq

1. **Where should the agents live?**
   - **A. A Mesh agents section at the end of the Agents home** (recommended). One screen for
     sessions and agents, no new tab or render entry.
   - B. Its own tab. More room for M3, but heavy for two rows, and tabs carry counts.
   - C. Settings → Mesh. Close to config, but #454 removed that panel, and a card is state.
2. **What does unslop's row show when it is not running?**
   - **A. The last card this viewer saw, marked "seen 2h ago"; after a restart, the configured
     facts only until its next call** (recommended). No disk writes, nothing new in the clients.
   - B. Have `meshctl unslop` write the card it checked to `<mesh dir>/mesh/cards/unslop.json`
     (0600), and the view read that. Survives restarts, but adds a write to the client and a file
     to `disable --purge`.
   - C. Configured facts only. Simplest, but the row says little most of the time.
3. **When may the viewer check the cards?** (Each request-post check reaches the publishing
   service.)
   - A. Every 5 minutes while the Dashboard is visible, plus Refresh. Notices a service that went
     down; about 12 requests an hour while you look.
   - **B. Only when the Agents home opens and on Refresh, for both agents** (recommended, and what
     this design specifies). Fewest requests and no background traffic to the service; the row
     can be as old as your last look, and says so ("checked 40m ago").
   - C. Every 60 s while visible. Fastest; 60 requests an hour.
