# Design: driven sessions — start an agent session from Agent Inbox and push messages into it (#412)

**Date:** 2026-10-31
**Status:** Proposed. Design only; nothing here is built. Five questions for Shariq are in §13.
**Scope of this PR:** this document. No source, test or workflow changes.
**Related:** #411 and its design
([`2026-10-30-session-messages-design.md`](2026-10-30-session-messages-design.md), on
`feat-411-session-messages` until PR #417 merges); the mesh design
([`2026-10-29-agent-mesh-design.md`](2026-10-29-agent-mesh-design.md)) §2, §3 and §6; the
2026-10-30 research brief on pushing into a running session (kept outside the repo). External
facts were checked on 2026-10-30/31 (Appendix A).
**Built on:** Shariq chose **push-first** on 2026-10-30. A session Agent Inbox starts is
*driven* by Agent Inbox, so a human message (#411) arrives as a new turn pushed into the
session, with no watcher and no time window.

---

## §0 — Summary

1. **New session** starts Copilot CLI or Claude Code on a known project with a prompt, in the
   background (driven) or a terminal (not driven). The human picks the permission mode on
   every launch, never `--yolo` or `bypassPermissions`, and the choice is recorded.
2. **One `agent-inbox-driver` process per launch,** started detached by Electron main through
   a fixed-purpose boundary, `electron/driver-process.cjs` (exact argv, no shell). It runs from
   the installed runtime, survives an app quit and owns one agent child. No HTTP route starts
   anything (§2).
3. **ACP to both hosts:** `copilot --acp --stdio`, and Claude through the Apache-2.0
   `claude-agent-acp` adapter, which runs the Claude Agent SDK in streaming-input mode. The
   ACP client is a small Node-core module, so the app's dependency set does not change (§3).
4. **Pushed delivery.** Reading the hub only through `store.ts`, the driver sends each #411
   message to its session as the next `session/prompt` turn, and does the same for answers to
   the session's own asks. `pending()`/`ack_message` stay the bookkeeping. The composer says
   **Arrives now** (§5).
5. **Linking.** The driver supplies the session's `agent-inbox` MCP entry with
   `AGENT_INBOX_LAUNCH=<id>.<secret>` in that entry's env only. The server claims the launch
   with one conditioned write and tags its presence; it stays network-free and starts nothing.
6. **Permissions become approval questions** counted by the one attention predicate. Only an
   inbox answer from the human approves; an agent's `answer`, a closure or a crash never does
   (§4).
7. **Writing launches get a fresh worktree.** Every launch has hard budgets, Stop, an event log
   and a transcript panel (§7).
8. **Off means off** (§9): the Settings switch is off by default, and nothing changes for
   anyone who never starts a session.
9. **Phasing:** a spike, then four PRs, about 5½–6½ weeks of agent time; Copilot first, as the
   host with no wake path at all for a hand-started session today (§11).

## §1 — Goals and non-goals

**Goals.** (G1) Start a session on a known project without opening a terminal. (G2) Driven
sessions take human messages, answers and approvals as pushed turns. (G3) Their asks reach the
inbox, badge and dock through the existing predicate. (G4) Bounded cost, and a Stop that works.
(G5) Share launch code with the mesh wrapper without needing the mesh.

**Non-goals.** Driving sessions the human started by hand (#411's hooks and watcher cover
those). An autopilot loop: the driver prompts only with the first prompt, messages and answers.
Windows, remote launch (#8), agent-to-agent delegation (the mesh's), and Codex for now (§3.4).

## §2 — Where the driver runs

| | (a) Electron main | (b) `agent-inbox-driver`, one per launch (**recommended**) | (c) the mesh's `agent-inbox-wrap` |
|---|---|---|---|
| Survives app quit and update | No | Yes: detached, and runs from the installed runtime, not the bundle | Yes |
| New dependencies | The ACP and Claude SDKs in the app lockfile; the Claude SDK's darwin-arm64 binary is ~310 MB | None: a Node-core ACP client in `src/`; the user installs `claude-agent-acp` | `packages/mesh`, which the release pipeline never builds |
| Hub writes (asks, launches, delivery) | Through `store.ts` | Through `store.ts`, as `hook-cli.ts` does | Never: the wrapper and bridge don't write the hub (mesh §4.3) |
| UI-thread load | JSON-RPC streams on Electron main | None | None |
| Needs `mesh.json`, a listener and grants | No | No | Yes, which #412 must not need |

**Recommendation: (b).** The driver is a third host-adapter entry beside `hook-cli.ts` and
`watch-cli.ts`. Its code lives in `src/driver*.ts` and `src/acp-client.ts`, is staged into
every runtime payload, and runs on the runtime's own Node and `better-sqlite3`.

It is one process per launch, not a daemon. A daemon needs a control channel, and any local
socket or hub "launch queue" is a door a page could reach indirectly. One driver per launch
keeps a single rule: only Electron main starts a driver, and only after the click. Running
controls are hub rows written through `store.ts`: Stop, messages and answers. The driver
checks `PRAGMA data_version` once a second to see them. Graph tests pin that no driver module
enters the stdio MCP graph or the viewer graph, and the driver binds no listener.

The mesh wrapper (M2/M5) can reuse `acp-client.ts` and the host table in `driver-hosts.ts`,
which open no connection. Mesh §6.1 assumed `@agentclientprotocol/sdk`; this design avoids it
on purpose: it is 8.3 MB and needs `@modelcontextprotocol/server@^2`, while the app ships
`@modelcontextprotocol/sdk@1`.

## §3 — Hosts and modes

### 3.1 One protocol: ACP v1

`src/acp-client.ts` implements the client half of ACP v1 in Node core, in about 300 lines,
over NDJSON on the child's stdio. It calls `initialize`, `session/new`, `session/load` or
`session/resume` when advertised, `session/prompt` and `session/cancel`, and handles
`session/update` and `session/request_permission`. It declares no `fs` or `terminal`
capabilities, so the agent uses its own tools in its own working directory. One turn runs at a
time: a message that arrives mid-turn is sent when the turn ends, which is also how Claude's
SDK queues ("interrupt and send" is later work). The child's stdout is the protocol channel,
its stderr goes to the launch log, and the driver writes only protocol messages to its stdin.

### 3.2 Copilot (`copilot --acp --stdio`, public preview)

Argv is fixed per permission mode (§4): `copilot --acp --stdio --disable-mcp-server
agent-inbox [--allow-tool …] [--deny-tool …] [--model M] [--effort E]`. Copilot fixes tool
filters and effort when the server starts, which suits one server per launch.

The env sets `COPILOT_AUTO_UPDATE=false` and removes `COPILOT_ALLOW_ALL`. The user's
`agent-inbox` server is disabled by name, and the driver's own arrives in `session/new`'s
`mcpServers`. Everything else (other MCP servers, instructions, skills) loads as in a
terminal: this is the human's session, not a mesh delegate.

Auth is the Copilot login, or `COPILOT_GITHUB_TOKEN` from the Keychain (§8). GitHub's ACP
reference names custom frontends as a use case.

### 3.3 Claude (Agent SDK through `claude-agent-acp`)

`@agentclientprotocol/claude-agent-acp` v0.99.1 is built on the SDK's streaming input. It
supports permission requests, `session/cancel` (`interrupt()`), `session/load` and
`session/resume`, client MCP servers, and SDK options in `_meta.claudeCode.options`. The user
installs it (`npm i -g @agentclientprotocol/claude-agent-acp`). The app never vendors the SDK,
which is under Anthropic's Commercial Terms. The driver passes `permissionMode` (§4),
`maxBudgetUsd`, `maxTurns`, and `pathToClaudeCodeExecutable` set to the user's `claude`.
Settings load as in a terminal, minus the user's `agent-inbox` server, and
`AGENT_INBOX_HOOKS=0` silences Agent Inbox's hooks, whose Stop nudge and `watch` would
duplicate the push.

**Auth.** The SDK docs bar third parties from offering claude.ai login without approval. So,
as in mesh decision 1, the default is `ANTHROPIC_API_KEY` from the Keychain, and the
subscription is used only behind an explicit "personal" switch that published docs never offer
(§13 Q1). **Fallback:** if the spike finds the adapter cannot carry these options, PR B spawns
a thin SDK adapter from `packages/mesh` that serves the same ACP surface; the driver does not
change.

### 3.4 Codex later

`codex app-server` (`sendUserTurn`) follows the same pattern. It becomes a third row behind
the driver's `HostAdapter` interface (`start`, `prompt`, `cancel`, `load`, `events`,
`onPermission`) when it is needed. Track `openai/codex#15299`.

### 3.5 Background, terminal, and taking over

**Background** is driven, and it is the only mode with push.

**Terminal** is not driven. Main writes a `0700` `.command` script into the launch folder,
with every value validated and shell-quoted and the prompt in a `0600` file. It then runs
`/usr/bin/open -a Terminal -- <script>`. The script `cd`s into the working directory and runs
`claude "$(cat prompt.txt)"` or `copilot -i "$(cat prompt.txt)"`. That is a hand-started
session, so #411's hooks or watcher deliver its messages.

**Nothing can attach live to a driven session.** An ACP stdio server has exactly one client.
`claude attach` works only for `claude --bg` sessions, and SDK sessions are not those. No ACP
client UI can join our pipe.

**Take over in a terminal** (PR D) instead: the driver cancels any running turn, closes the
child and marks the launch `handed_off`, then main opens a terminal on `claude --resume <acp
id>` or `copilot --resume <id>` (the spike confirms Copilot persists ACP sessions). Two writers
never share a session; handing a session back to the driver is later work.

### 3.6 What the human sees

Each driver appends `<hub dir>/launches/<id>/events.ndjson`: agent text (coalesced) and plans;
tool calls (title, kind, status, input capped at 4 KB); permission requests and answers;
injected turns by message id; stop reasons and usage. It rotates at 20 MB and keeps two files.

The transcript panel (PR C) opens from a launch tag. It reads
`GET /api/launches/:id/events?after=<offset>`, at most 256 KiB at a time and only while the
panel is open, and shows the last 200 events with "load earlier". Agent text goes through
`renderStructuredText` and everything else through `esc()`. Lanes, Live and the Agents view
show only the launch tag and its state, from the launches snapshot; no transcript joins the
poll.

## §4 — Permissions

The human chooses a mode on every launch; nothing is preselected, and main refuses a launch
without one. The value, and the argv or options derived from it, are stored in the launch row
and shown on its tag.

| Mode (UI) | Claude `permissionMode` | Copilot flags | Writes |
|---|---|---|---|
| Ask for everything | `default` | none | a click each |
| Read-only | `dontAsk` + read tools: everything else is denied | `--deny-tool write` + the M2 read-only git allow-list; other shell asks (deny rules beat allow rules, so an exact "deny the rest" is a spike item) | impossible |
| Plan first | `plan` | `--mode plan` (spike) | a click each |
| Edits in the worktree allowed | `acceptEdits` | `--allow-tool 'write(<worktree>/**)'` (spike) | shell, network and push still ask |

**Never offered:** `bypassPermissions`; `auto` (a model classifier approving is still
auto-approval); `--yolo`, `--allow-all-tools` and `COPILOT_ALLOW_ALL`. v1 has no mid-session
mode change, and a later version may only tighten the mode.

**The mapping.** A `session/request_permission` becomes one question item through
`insertItem`. A Claude `AskUserQuestion` (however the adapter surfaces it) becomes the same kind
of item with Claude's own choices as options, and the human's inbox answer is passed back as the
answer; the allow rule below applies only to permission requests.
- **Item fields:** `kind: 'question'`, `action_owner: 'approval'`, the new `origin: 'driver'`
  (§6), the presence `session`, the project, the branch as `stream`, and the agent as both
  `agent` and `action_agent`.
- **Text:** the title "Allow copilot to run `git push origin ai/x`?"; `next_step` "Choose
  whether copilot may do this."; `impact` "The session is paused until you answer."; and in
  `context` the tool kind, its input (capped at 4 KB), the worktree and the launch id.
- **Options:** the agent's own, at most four (Allow once, Allow always with its stated scope,
  Deny, Deny always), and none recommended.
- **Attention.** The session is live, so the question is `waiting`. The badge, dock and
  notifications follow the one predicate, with `public/attention.js` unchanged. No board row
  is written for the ask: one ask, one surface.

**Answer authority.** Only an inbox reply (`reply_source = 'inbox'`, `reply_kind` answer)
whose text equals an allow option's label exactly approves. The driver then answers `selected`
with that option id and resolves the item ("Allowed once by you"), pinned to the handled
`response_revision`. Anything else (another label, free text, clarify, decline) is sent as
`reject_once`, or `cancelled` when the agent offered no reject option, and free text is queued
as the next turn. This build's MCP `answer` and `resolve` refuse `origin = 'driver'` items
(`reason: 'driver_ask'`); an older server could still record an answer, so the source check is
the backstop, and a closure without an inbox reply counts as Deny. Prompts never time out (SDK
docs): the ask waits until it is answered or the launch stops, when the driver resolves it
"Session stopped". A lost driver's asks are closed by the human's **Close** (§7).

## §5 — Identity, linking and pushed delivery

**The claim.**
1. Main makes the launch id and a 32-byte secret. The row stores only the secret's SHA-256.
2. The driver puts `AGENT_INBOX_LAUNCH=<id>.<secret>` in the env of the `agent-inbox` MCP
   server entry it supplies, never in the agent's own env. Tool shells and nested CLIs
   therefore cannot inherit it.
3. `src/mcp.ts` reads the variable once at startup and deletes it from `process.env`. On
   registration it calls `claimLaunchSession(id, secret, sessionId)`, one `.immediate()`
   transaction. It checks the hash, a `starting` or `running` status, and that no other live
   session holds the launch; sets `launches.session`; and moves the launch's open
   `session_messages` from its previous session, so a server restart or a resume loses none.
   That is proof by launch, not the guess #411 forbids.
4. The server writes `activity.launch_id`. A later write that omits it keeps it, as with
   `server_version`.

No variable, a bad one or a refused claim leaves the server exactly as it is today. The driver
learns the session only from `launches.session`, never from the agent or argv.

**The lease.** The driver refreshes `driver:<launchId>` in `hook_watch_claims` every 30 s.
That table is already unread by any snapshot, so the refresh rebuilds nothing.
`listActivity` serves `launch_id`, and `driven: true` while the lease is under 90 s old.

**Delivery.** When `data_version` moves, the driver calls `listOpenMessages([session])` (#411
PR 1). Each message id it has not injected yet (the injected ids are kept in
`launches/<id>/injected.json`) becomes one turn:

> Message from the human via Agent Inbox (id m-…). It is also in pending(); act on it once,
> then ack_message({ id, outcome }).
>
> <verbatim text>

Mid-turn, the message waits until the current turn ends. Once its turn is sent, the driver
calls `markMessageDelivered(id, session, 'agent-inbox-driver')`, and `delivered_by` lets the UI
say "pushed into the session". `pending()` still returns the message until `ack_message`, so
`/clear` and compaction lose nothing; #411's contract is unchanged.

**Answers to the session's own asks.** A new reply, annotation or handled mark on its
questions (`items.session`), or on rows of plans it wrote (`boards.session`, #306), gets one
turn: "The human answered '<title>'; call pending()". No answer text is copied into that turn.
A driven session therefore gets no `flag` watch contract and no #411 PR 3 `session_watch`; its
appendix says it is woken automatically.

**Composer states** (#411 PR 2), checked in this order:
1. **Arrives now** (`driven`): "Agent Inbox started this session and sends this straight in,
   after its current step if it is working."
2. **Wakes for it**: #411's Claude hook lease, within its 29-minute window.
3. **When it next checks**: the session can receive messages, but nothing wakes it.
4. **Can't receive**: no `receives_messages`.

## §6 — Storage

The changes are additive migrations with triggers made last, through `store.ts` only.

```sql
CREATE TABLE IF NOT EXISTS launches (
  id TEXT PRIMARY KEY,                     -- main-generated UUID
  project TEXT NOT NULL, repo_root TEXT NOT NULL, cwd TEXT NOT NULL,
  branch TEXT, base_ref TEXT, worktree INTEGER NOT NULL DEFAULT 0,
  host TEXT NOT NULL,                      -- copilot | claude
  mode TEXT NOT NULL,                      -- background | terminal
  permission_mode TEXT NOT NULL,           -- §4's ids
  host_config TEXT NOT NULL,               -- JSON: executable real path + version, argv, options
  auth TEXT NOT NULL,                      -- login | api-key | personal; never the secret
  prompt TEXT NOT NULL,                    -- the human's first prompt, 1–16000 units (§13 Q4)
  budget TEXT NOT NULL,                    -- JSON: wall_minutes, idle_minutes, tool_calls, usd?
  token_hash TEXT NOT NULL,                -- never served
  session TEXT, acp_session TEXT,          -- current MCP session; ACP id for resume/take-over
  status TEXT NOT NULL DEFAULT 'starting', -- starting|running|stopping|ended|failed|handed_off
  end_reason TEXT NOT NULL DEFAULT '',     -- stopped|budget:<which>|idle|exited|error:<code>
  usage TEXT NOT NULL DEFAULT '{}',        -- JSON: turns, tool_calls, usd?; written per turn
  stop_requested_at TEXT, driver_pid INTEGER,
  created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1
);
```

Two columns are added: `activity.launch_id TEXT`, which no snapshot reads, and `items.origin
TEXT` (`'driver'` or NULL), listed in `REVIEWED_COLUMNS` as read by no column domain. Each
write is one statement or one `.immediate()` transaction:

| Function | Caller | What it does |
|---|---|---|
| `createLaunch` | driver | Inserts its validated spec. |
| `claimLaunchDriver(id, pid)` | driver | Claims a `starting` launch with no live lease, so a re-run never double-drives. |
| `claimLaunchSession` | MCP server | The claim described in §5. |
| `updateLaunch(id, revision, patch)` | driver | Updates status and usage, pinned to `revision`. |
| `requestLaunchStop(id, revision)` | IPC, or a trusted-Origin route | Sets `stop_requested_at` and nothing else. It can only stop, so it is the one launch write an HTTP route may make. |
| `closeLostLaunch(id, revision)` | the human | Ends a lost launch and dismisses its open driver asks. |
| `pruneLaunches` | `createLaunch` | Deletes ended launches over 30 days old, with their folders. |

**Snapshot.** `launches` is a whole-table domain, with `SNAPSHOT_SOURCES.launches =
['launches']`. `GET /api/launches` serves every launch that has not ended plus the 50 newest
ended ones, without `token_hash`. `test/fixtures/snapshot-triggers.txt` only gains names. A
`running` launch whose lease is over 2 minutes stale reads as `lost`; that is derived on read,
never written.

**Mixed versions.** Older processes never name the new table or columns. An older runtime's
MCP server ignores the launch env, so it never claims; the driver reports "this runtime is too
old" and stops.

## §7 — Working directory, budgets and lifecycle

**Worktree.** A launch whose mode can write gets a fresh worktree: `git worktree add
<root>/<repo>/<branch> -b <branch> <base>`, run with `execFile`. Read-only and plan launches
may use the project's checkout. The root defaults to `~/.agent-inbox/worktrees` (changeable),
the base to `origin/<default>` after a fetch, and the branch to `ai/<slug>-<4 hex>` (editable,
checked with `git check-ref-format`). The driver never pushes: a push is the agent's own tool
call and asks like any other. **Remove worktree** is offered only when the worktree is clean
and has no unpushed commits; the branch is kept.

**Budgets.** Every launch has all four, and none moves mid-launch: wall clock (4 h default,
24 h at most); idle (2 h with no turn running); tool calls (500, counted by the driver from
`tool_call` updates for both hosts); and USD for Claude only, through SDK `maxBudgetUsd`, an
estimate set with headroom. Copilot reports no cost over ACP, so its tag says "premium requests
not tracked". When a budget runs out, the driver sends `session/cancel`, waits up to 10 s,
closes the child and ends the launch with `end_reason: 'budget:<which>'`.

**Stop.** Within a second of `stop_requested_at`, the driver sends `session/cancel`, answers
pending permission requests `cancelled`, resolves its asks "Session stopped", and closes the
child's stdin so the ACP server exits, with SIGTERM to the child's group after 10 s. Main
signals a driver only when its launch is `lost`, and only if `driver_pid`'s start time
(`ps -o lstart`) matches the one recorded by the lease.

**Logs** go to `<hub dir>/launches/<id>/` (`0700`): `events.ndjson` and `driver.log` (stderr,
capped at 5 MB). The folder sits under the hub directory, not Electron's userData, so the
viewer, the driver and a browser all find it. No log holds the env or a secret.

**App quit.** Drivers are detached (`setsid`, stdio to files, `unref`) and keep running.
`beginAppQuit()` refuses new launches through a `launchGate`, like `createInstallGate`. A
macOS update swaps the app bundle, not the runtime the driver runs from, and `prune-runtimes`
keeps any runtime that a running process names.

**Crash.** When a driver dies, its child's stdin closes and the ACP server exits (the spike
checks both hosts). The launch then reads as `lost`, and its asks stay parked until the human
chooses **Resume** or **Close**. Nothing restarts on its own.

**Resume** (PR D) needs a click. A new driver claims the launch and calls `session/load`, or
`session/resume` if that is what the agent advertises. The Claude adapter supports both; the
spike checks Copilot's `loadSession`. The new MCP server's claim moves open messages to it
(§5). An agent that cannot load says "This session can't be resumed; start a new one".

## §8 — The Electron boundary and security

**`electron/driver-process.cjs`** mirrors `setup-process.cjs`. It builds exactly
`[<runtime>/bin/node, <runtime>/dist/driver-cli.js, 'run', <launchId>, <hub db>]` from the
installed runtime, verified against the signed digest before spawn (#206's path), or from the
checkout's `dist/` in development. No shell, no caller-supplied argv, detached, with stdio to
files main opens. One extra pipe, fd 3, carries the spec in as one JSON line; the driver
answers `ready` or `error` within 10 s and closes it. Anything but darwin fails closed before
spawn.

**IPC and the grant.** The preload exposes `agentInboxLaunch.available()`, `start(spec)`,
`stop(id, revision)` and `takeOver(id)`, each with exact arity. They are served only to the
viewer window's top frame on the viewer origin.

`createInstallBinding()` gains a fourth grant, `launch`, under the same rule as `files`. The
window must show the viewer this app started and proved it owns, re-proved after every
navigation (#216). The Settings switch must also be on, and no quit begun. A reused or
failed-over viewer gets `{ available: false, error: 'unowned' }`. No HTTP route creates a
launch.

**What the renderer may send.** Main validates the spec `{ project, host, mode,
permissionMode, model?, effort?, worktree: { branch?, base? }, budget, auth, prompt }`.
`project` names a `repo_root` that main reads itself (`listRepoRoots()`, new), or a folder
from main's own `dialog.showOpenDialog`; either way it must be an absolute, uid-owned git top
level. Enums come from fixed tables, budgets have bounds, and the prompt (1–16,000 units)
never goes in argv. The renderer never sends a path, an executable, argv or env.

**Executables.** The driver resolves `copilot` or `claude-agent-acp` on a fixed search path:
`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, then `PATH`. The result must be a real
path, owned by the uid or root, not group- or world-writable, and at least a minimum
`--version`. The path and version are recorded in `host_config`.

**Env and secrets.** The child's env is an allow-list: `HOME`, `PATH`, `LANG`, `TERM=dumb`,
`AGENT_INBOX_HOOKS=0`, plus the host's auth variable when the human chose a key or token.
Secrets live in Electron `safeStorage` (the Keychain) and reach the driver on the fd-3 line.
They never appear in argv, a file, SQLite or a log. API-key auth is unavailable when
`safeStorage` has only its plain-text fallback. The agent's tool shells can read its env, as
in a terminal; that is inside the trust boundary.

**Threat model:** mesh §3's. The gates protect against a local web page (Origin checks, no
route that starts anything), an agent approving its own permissions (`origin`, the
reply-source check, fail-closed mapping) and runaway cost (hard budgets, Stop). They do not
protect against a same-user process with a shell, which can run `copilot --yolo` itself.
Injected prompts from repository or tool content remain the agent's normal risk. The
permission gate is the control, which is why no mode auto-approves shell, network or push.

## §9 — The opt-in contract

The switch is **Settings → Agent sessions → "Start sessions from Agent Inbox"**. It is off by
default. Main owns it in `userData/session-launch.json`, written by `createLockedFile` and
read tolerantly, like Links (#300). A browser cannot turn it on.

While it is off:
- **(a) MCP.** `tools/list` and every response are byte-identical. The server reads one absent
  variable, and refuses `answer`/`resolve` only for `origin = 'driver'` items, of which there
  are none.
- **(b) The page** asks `available()` at load and when Settings opens. Only `enabled: true`
  adds New session, the launches read and launch tags. A DOM test boots with the switch off and
  asserts the same requests, bodies and ETags.
- **(c) Dependencies.** `test/fixtures/app-dependencies.txt` is unchanged.
- **(d) The hub** gains an empty table and two nullable columns. The table's domain never moves
  without a launch, and existing snapshots stay byte-identical.
- **(e) Main** spawns nothing and resolves no host executable.

Switching it off refuses new launches. Running drivers keep running and can still be stopped.

## §10 — Platforms

macOS (arm64 releases, `darwin` in development) is first. Linux follows Setup's rules: the
boundary allows `linux` once Setup's Linux release path does, and terminal mode there needs a
chosen terminal app. Windows is refused before spawn, as Windows Setup is.

## §11 — Phasing

| Step | Ships | Effort |
|---|---|---|
| Spike | Recorded fixtures and a go/pivot note | 2–3 days |
| PR A | Driver core, Copilot, linking, pushed delivery, asks, budgets, Stop | 1.5–2 weeks |
| PR B | Claude | 1 week |
| PR C | Electron boundary and UI | 2 weeks |
| PR D | Resume, Take over, terminal mode (`Closes #412`) | 1 week |
| **Total** | | **≈ 5½–6½ weeks** |

**Spike.** Real runs of `copilot --acp` and `claude-agent-acp`, recorded as test fixtures.
For Copilot: `--allow-tool`, `--deny-tool`, `--mode plan` and `--disable-mcp-server` under
`--acp`, the read-only git syntax (shared with mesh M2), `loadSession`, `--resume` of an ACP
session, and exit on stdin close. For both: MCP env passing, and which `agent-inbox` entry
wins. For the adapter: its `_meta.claudeCode.options` keys, how `AskUserQuestion` surfaces,
and cost reporting. Pivots: an adapter that falls short moves PR B to `packages/mesh`; an
unstable Copilot ACP falls back to `copilot -p` with JSONL and no push.

**PR A** (`Part of #412`, after #411 PR 1) ships the launches table, `launch_id`, `origin` and
the claim; the ACP client, driver, host table and CLI; the Copilot host, asks, pushed messages
and answers, budgets, Stop, logs and `/api/launches`; and a human-run `npm run driver --
launch …`. It is useful alone (CLI-started Copilot sessions get pushed messages and inbox
permission asks) and safe alone (no page can start anything). Tests: a fake ACP agent
exercising every method; the claim race; an MCP integration test where the driven server
claims and an undriven one ignores; answer authority, including that an agent answer never
approves; budgets and Stop; mixed-version and graph tests.

**PR B** (`Part of #412`): the Claude host, API-key auth over fd 3, the personal switch, and
the adapter version check.

**PR C** (`Part of #412`): the boundary, the `launch` grant, IPC and preload, `launchGate` and
the Settings switch; New session (Dashboard lanes head, ⌘K "new session"); tags and Stop in
Live, lanes and the Agents view; the transcript panel, the Arrives now state and worktree
removal; §9's off tests and the DOM test that refuses a reused or unowned viewer; and
`docs/architecture/driven-sessions.md`.

**PR D:** Resume, Take over and terminal mode.

## §12 — Risks

- **Churn.** ACP is a preview on Copilot, and the adapter ships often (v0.99.1 came out the day
  this was written). Mitigations: a pinned minimum version, protocol v1 only, recorded
  fixtures, and a client small enough to follow the spec.
- **Unattended cost.** Four budgets are on by default, Stop is one click, and usage shows on
  the tag.
- **Permission fatigue.** The modes trade it off explicitly, and the "always" options are the
  agent's own scoped approvals.
- **Duplicate `agent-inbox` servers** if excluding the user's server fails. The claim ignores
  the unlaunched one, but presence shows two rows, so the spike blocks on this.
- **Claude auth policy** (§3.3, Q1).
- **ACP v1 has no mid-turn input.** A pushed message waits for the current turn to end, and the
  copy says so.
- **Hand-started sessions stay on #411's paths.** Claude `--channels` could push into them, but
  it is a research preview, interactive-only and ignored under the SDK. It is tracked, not
  built.

## §13 — Questions for Shariq

1. **Claude auth.** API key from the Keychain by default, and your subscription only behind a
   "personal" switch the docs never offer? *Recommend: yes, mirroring mesh decision 1.*
2. **App quit.** Do driven sessions keep running, bounded by their budgets, or stop with the
   app? *Recommend: keep running.*
3. **Host order.** Copilot first (PR A), then Claude (PR B)? *Recommend: yes.* Copilot has no
   wake path today, and driven Copilot sessions could shrink #411 PR 3's standing watcher to a
   fallback.
4. **First prompt.** Store it in the launch row and show it on the tag and in the transcript,
   pruned after 30 days? *Recommend: yes.*
5. **Default budgets.** 4 h wall clock, 2 h idle and 500 tool calls, with a USD cap required
   for API-key Claude launches? *Recommend: yes.*

## Appendix A — Verification log

| # | Fact | Source | Checked |
|---|---|---|---|
| 1 | Streaming input (`AsyncGenerator<SDKUserMessage>`), queued messages, a long-lived process | code.claude.com/docs/en/agent-sdk/streaming-input | 2026-10-31 |
| 2 | Permission order; modes `default`, `dontAsk`, `acceptEdits`, `bypassPermissions`, `plan`, `auto`; `canUseTool`; prompts never time out | …/agent-sdk/permissions; …/typescript (`CanUseTool`) | 2026-10-31 |
| 3 | `continue`, `resume` and fork; the session id on init and result messages | …/agent-sdk/sessions | 2026-10-31 |
| 4 | `maxBudgetUsd`, `maxTurns`, `settingSources`; `env` replaces the process env; `pathToClaudeCodeExecutable`; `interrupt()`; stdio MCP `env` | …/agent-sdk/typescript | 2026-10-31 |
| 5 | Commercial Terms; no claude.ai login for third parties without approval | …/agent-sdk/overview | 2026-10-31 |
| 6 | SDK 0.3.316 with optional per-platform binaries; the darwin-arm64 binary is ~310 MB unpacked | `npm view` | 2026-10-31 |
| 7 | One `claude` subprocess per session, over stdio | …/agent-sdk/hosting | 2026-10-31 |
| 8 | `copilot --acp`: one stdio client, exits when stdin closes; tool filters and effort fixed at start; `session/new` carries cwd and MCP servers | docs.github.com/…/copilot-cli-reference/acp-server | 2026-10-31 |
| 9 | Copilot 1.0.105: `--allow-tool`, `--deny-tool`, `--disable-mcp-server`, `--mode`, `--yolo`, `--session-id`, `COPILOT_HOME`, `COPILOT_ALLOW_ALL` | local `copilot --help`, `help environment`, `help permissions` | 2026-10-31 |
| 10 | Claude 2.1.312: `--bg` and `attach` apply only to background sessions; `--permission-prompts host` means the SDK host | local `claude --help` | 2026-10-31 |
| 11 | ACP `session/new`, `session/load` (`loadSession`), `session/resume`; MCP servers with `env` | agentclientprotocol.com/protocol/session-setup | 2026-10-31 |
| 12 | The prompt turn and stop reasons; `session/cancel` answers pending permissions `cancelled` | agentclientprotocol.com/protocol/prompt-turn | 2026-10-31 |
| 13 | `session/request_permission` and its option kinds; the agent owns remembered decisions | agentclientprotocol.com/protocol/tool-calls | 2026-10-31 |
| 14 | `@agentclientprotocol/sdk` 2.2.0: Apache-2.0, 8.3 MB, peer `@modelcontextprotocol/server@^2.4` | `npm view` | 2026-10-31 |
| 15 | `claude-agent-acp` 0.99.1: Apache-2.0, built on the Agent SDK; `_meta.claudeCode.options`; cancel, load and resume | `npm view`; repository README | 2026-10-31 |
| 16 | Channels are a research preview, interactive-only and ignored under the SDK; Copilot has no inbound push; Codex #15299 is open | research brief, 2026-10-30 | 2026-10-30 |
