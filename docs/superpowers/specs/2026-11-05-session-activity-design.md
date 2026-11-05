# Session activity: show what a session is doing when it isn't calling Agent Inbox

Status: proposal, 2026-11-05. Issue: #466. Builds on #45 (liveness versus work), #253 (hook
link by host process), #412 (driven sessions) and #454 (the Agents home).

## 1. Problem

A terminal session spent about 45 minutes working: it read code, ran `gh` and shell commands, and
filed issues. It made no Agent Inbox MCP call in that time, and it had called `status({ done: true })`
before it started. Its card said **Idle**, "idle 40m". The human asked why a working session looked
idle and called it confusing.

Agent Inbox learns about a terminal session only through that session's MCP server. Every signal it
has comes from an Agent Inbox tool call or from the server process staying alive. A session busy with
other tools therefore looks the same as a session waiting at its prompt. The card says more than the
evidence supports: "Idle" means "no Agent Inbox call", not "doing nothing".

Driven sessions (started from the app over ACP by `agent-inbox-driver`) do not have this problem. The
driver sees every turn, tool call and approval (`driven`, `driven_turn`).

## 2. Signals today

| Signal | Column(s) | Written by | What it proves | Read as |
|---|---|---|---|---|
| Presence | `updated_at` | registration, every call, `livenessTick` every **5 min** | the MCP process is alive | the 15-minute expiry only catches a crash |
| Work | `last_call_at`, `call_minute`/`call_counts` | `recordActivityCall`, which runs on any Agent Inbox tool call | the agent talked to Agent Inbox | `isWorking`, "last call 2m ago", the trace |
| Claim | `doing`, `detail`, `children`, `idle`; `last_doing` | `status()` | what the agent says it is doing | live for 30 min after the last call (`CLAIM_COLD_MS`) |
| Driven | `driven`, `driven_launch`, `driven_turn` | driver leases in `hook_watch_claims` | the driver sees turns and approvals | launch cards |
| Host link | `host_pid`, `server_pid` | presence and status writes | which host process started the server | Claude hooks (#253), `wakes` (#411) |

A card is **Working** when `isWorking` is true: the claim is not idle and the last call came within
30 minutes. A card is **Dormant** after 8 hours with no call, and **Idle** otherwise. In the reported
case, `done: true` cleared the claim, so the card read Idle from that point on, and "idle 40m" counted
from the last call.

## 3. What the hosts offer (official docs)

Both hosts can run a local command at turn and tool boundaries and pass it a JSON payload on stdin.
Neither needs a network connection or a model call to do it.

**Claude Code** ([hooks reference](https://code.claude.com/docs/en/hooks)):
- Configured in `~/.claude/settings.json`, where the agent-inbox installer already writes its hooks.
  Every payload carries `session_id`, `transcript_path`, `cwd` and `hook_event_name`.
- `UserPromptSubmit` fires before Claude processes a prompt. It also fires on turns Claude Code starts
  on its own. `Stop` fires when the main agent finishes responding, but **not after a user interrupt**.
  `StopFailure` fires when a turn ends on an API error. `Notification` with `idle_prompt` fires about
  60 seconds after a response if the user has not typed since.
- `PreToolUse` and `PostToolUse` fire on every tool call, including tool calls inside subagents.
  `PostToolBatch` fires once per batch of parallel calls.
- A command hook with `"async": true` runs in the background and never blocks Claude. The default
  timeout is 600 s (30 s on `UserPromptSubmit`).
- The hooks agent-inbox installs today are `Notification`, `SessionStart` (startup and resume),
  `SessionEnd`, `UserPromptSubmit` and `Stop` (`stop` and `watch`) (`hooksSettingsBlock` in
  `src/hook.ts`). Adding an event is a change to that block plus the installer's one-set rules
  (#218). The installer already keeps another tool's entries on the same event
  (`scripts/install-hooks.sh`).
- `type: "mcp_tool"` hooks (Claude Code 2.1.118,
  [changelog](https://code.claude.com/docs/en/changelog)) can call a tool on a configured MCP server.
  They cannot be async, and they skip the `SessionStart` that fires at launch.

**GitHub Copilot CLI** ([hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference),
[concepts](https://docs.github.com/en/copilot/concepts/agents/hooks)):
- Hooks are loaded from policy files, `.github/hooks/*.json` in the repository,
  **`~/.copilot/hooks/*.json`** (the user level), inline `hooks` in `~/.copilot/settings.json` or the
  repository's `.github/copilot/settings*.json`, the repository's `.claude/settings*.json`, and
  plugins. Sources combine, so one user-level file of our own reaches every session.
- Events: `sessionStart`, `sessionEnd`, `userPromptSubmitted`, `preToolUse`, `postToolUse`,
  `postToolUseFailure`, `agentStop` (the main agent finishes a turn), `subagentStart`/`subagentStop`,
  `errorOccurred`, `preCompact`, `permissionRequest` and `notification`. PascalCase names select
  Claude-compatible payloads.
- Payloads carry `sessionId`, `timestamp` and `cwd`, plus `toolName`, `toolArgs` and `toolResult` on
  tool events. A subagent's hooks also carry `agentId`.
- Command hooks support exec form (`exec` + `args`, with no shell). The default timeout is 30 s
  (`timeoutSec`). A timeout fails open on every event. A non-zero exit fails open everywhere
  **except `preToolUse`, which fails closed** and denies the tool call. Only `notification` is
  fire-and-forget; every other event runs synchronously.
- When the session sandbox is enabled, user-level hooks run inside it, so a hook writing
  `~/.agent-inbox/inbox.db` needs that path granted.
- The [CLI changelog](https://github.com/github/copilot-cli/blob/main/changelog.md) first mentions
  hooks in 0.0.396 (2026-01-27). Personal hooks in `~/.copilot/hooks` arrived in 0.0.422, and
  settings-file hooks in 1.0.8.
- Observed on macOS with Copilot CLI 1.0.106: the agent-inbox MCP server and the shell tool's
  commands are both **direct children of the `copilot` process**. The docs do not say what parent
  an exec-form hook gets. **That needs checking**; see §6.

**The join.** The MCP server records `host_pid = process.ppid`. A hook's own `process.ppid` is the
same host process: #253 proved this for Claude exec-form hooks, and Copilot still needs a check. That
match is how a hook finds its session's presence row, and `listHostSessions` with `running(server_pid)`
already does it. Neither host's `session_id`/`sessionId` is a sound key. Claude's survives `/clear`
in the server but not in the host. The Copilot server never learns its host's session ID. One Copilot
process can also host several sessions that share one server, so a stamp describes the process, which
is also what the card describes.

## 4. Options

**A. Honest labels (viewer only).** "Idle" should mean the session is known to be idle. With no host
evidence, a card that is not working reads **Quiet**: "no Agent Inbox call for 40m", never "no
work". `last_doing` shows as "Last reported: Fixing X · 52m ago". Cost: copy changes in
`public/sessions.js` and `livebar.js` (the Sessions line). Fixes: the false statement. Does not fix:
a busy session still is not shown as working.

**B. Host turn and tool stamps (hooks).** Hooks write timestamps only, to three new nullable
`activity` columns:

| Column | Claude Code | Copilot CLI |
|---|---|---|
| `host_turn_at` (turn started) | `UserPromptSubmit`: the existing `prompt-submit` | `userPromptSubmitted` |
| `host_idle_at` (turn ended) | `Stop` (existing `stop`), `StopFailure`, `Notification` `idle_prompt` (existing `notification`) | `agentStop`, `errorOccurred` |
| `host_tool_at` (tool ran) | `PreToolUse` + `PostToolUse`, `async: true` | `postToolUse` (synchronous, `timeoutSec: 2`) |

A new store function, `recordHostEvent(db, sessions, kind)`, is one conditioned `UPDATE … WHERE
session IN (…) AND ended_at IS NULL`. It finds rows the way #253 does: `listHostSessions(ppid)`
filtered by `running(server_pid)`. It never touches `updated_at` (liveness), `last_call_at`, the call
trace, claims or spans. #45 holds: host evidence is a third stamp, and the liveness tick still calls
only `touchActivity`.

Tool stamps are throttled. A per-host marker file (`<state>/host-<pid>.tool`) is checked by `stat`
first, so a busy host writes at most once every 30 s and never opens the database in between. Turn
stamps are not throttled. The stdin payload is read under the existing cap and then discarded: no
tool name, argument, result, prompt or host session ID is stored.

The viewer derives a host state:
- **busy**: `host_turn_at` is newer than `host_idle_at`, and the newest host stamp is under 60
  minutes old. The cap covers an interrupted Claude turn, which fires no `Stop`.
- **waiting**: `host_idle_at` is at or after `host_turn_at`.
- **unknown**: there are no host stamps.

**C. Instruction level.** The reporting snippet and the `status` tool description should say that
`done: true` means "going idle", and that a new multi-step task needs a new claim. That is cheap, but
it relies on the agent remembering; in the reported case, the agent did not. We reject an automatic
claim built from the prompt hook: it would store the human's prompt and put words in the agent's mouth.

**Rejected.**
- Claude `mcp_tool` hooks calling Agent Inbox. They give an exact join, but they are synchronous,
  Claude-only, and either add a tool the model can see or overload an existing one (`whoami` would
  record a call and pollute the trace).
- HTTP hooks to the viewer. They lose every event while the viewer is closed, they add a write route to
  the loopback viewer, and Copilot needs `COPILOT_HOOK_ALLOW_LOCALHOST=1` for them.
- Letting host activity keep a claim warm. A decayed "Fixing X" would revive over unrelated work,
  which is the #45 bug again.

## 5. Recommendation: A, then B for both hosts, plus the small part of C

Card states (`sessionCards`) after B. `isWorking` keeps its meaning (claim + call) for plan joins and
`attributeAsks`. A new `isBusy(row)` = `isWorking(row) || hostState(row) === 'busy'` drives the cards
and the Sessions line.

| Evidence | State / label | Text | Recency |
|---|---|---|---|
| Live claim | Working | the claim | the freshest of "last call" or "last tool" |
| No live claim, host busy | Working | "Task not reported" + "Last reported: X · 52m ago" | "turn running 45m · last tool 20s ago" |
| Host waiting | Idle | historical `last_doing` | "waiting for you · 12m" |
| No host stamps, no claim | Quiet (filter key `idle`) | "Not reporting to Agent Inbox" | "no Agent Inbox call for 40m" |
| No stamp of any kind for 8 h | Dormant | unchanged | unchanged |

Dormancy and sort order (`activeAt`) take the newest of `last_call_at`, `started_at` and the host
stamps. The Sessions line counts busy sessions as working ("3 working · 5 connected"). A driven card
keeps its driver-derived state, because the driver's evidence is stronger.

**Invariants.**
- Nothing here enters `public/attention.js`, badges, Needs you, notifications or the dock count.
  `/api/activity` stays a bare array, and every row stays listed (#45).
- MCP stdout is untouched; the MCP server gains no timer and no network access.
- The hook writes zero bytes to stdout on every host and always exits 0. That matters on Copilot,
  where stdout is parsed as a decision. The hook never registers on Copilot's fail-closed
  `preToolUse`.
- Fail-open: no link, a dead server, `SQLITE_BUSY`, a sandbox refusal or a missing database all mean
  "no stamp". The existing `AGENT_INBOX_HOOKS=0` switch disables it.
- `activityFrameKey` repaints on a stamp. With the 30-second throttle that is at most one repaint per
  busy session every 30 s, and an idle tick still paints nothing (#298).

**Cost.** One Node start (about 40 ms for `hook-cli` on an Apple-silicon Mac) per hooked event. On Claude, tool
hooks are async and cost the agent nothing. On Copilot, `postToolUse` adds about 40–60 ms to each
tool call, and the 2 s timeout fails open. Copilot tool stamps could be left out: the turn and idle
stamps alone mark a session busy, though they cannot show "last tool".

**Mixed versions.** The columns are additive and nullable. `openDb` migrates them, and an older
server's statements never name them. Each mismatch degrades to option A:
- an older viewer ignores the columns;
- a newer viewer with old hooks, no hooks, or a row with no `host_pid` sees "unknown";
- a newer hook on a row whose server predates #253 finds no link.

## 6. PR split

| PR | Scope | Size (production / tests) |
|---|---|---|
| 1. Honest labels | `public/sessions.js` (Quiet, "Last reported…", recency copy), `livebar.js` Sessions line, `status` description and `docs/reporting-snippet.md` wording (C) | S: ~80 / ~120 |
| 2. Store + Claude stamps | migration (3 columns), `recordHostEvent`, `listActivity` serves them; `prompt-submit`/`stop`/`notification` stamp; new `activity` subcommand on `PreToolUse`/`PostToolUse` async in `hooksSettingsBlock` + installer; viewer `hostState`/`isBusy`; `docs/hooks.md`, `activity-and-live.md` | M: ~180 / ~250 |
| 3. Copilot hooks | an opt-in installer for one owned file, `~/.copilot/hooks/agent-inbox.json` (exec form; `userPromptSubmitted`, `agentStop`, `errorOccurred`, `postToolUse`), dry run first, under the setup lock, reported in Setup; **first verify the exec-form hook's parent pid** | M: ~200 / ~200 |

PR 1 can ship in a 2.4.x patch. PRs 2 and 3 each add an install surface, so the circuit breaker keeps
them separate.

## 7. Test plan

- **Store** (`test/store.test.ts`, real temp SQLite):
  - `recordHostEvent` stamps only live rows of the given sessions;
  - it never moves `updated_at`, `last_call_at`, the call trace, claims or spans;
  - an ended row is untouched;
  - `listActivity` serves the columns.
  - Extend the `test/live-tick.test.ts` AST pin so `livenessTick` cannot call `recordHostEvent`.
- **Hook** (`test/hook.test.ts`):
  - `activity` writes zero stdout bytes and exits 0 for any stdin, with no database, with no link,
    and under `AGENT_INBOX_HOOKS=0`;
  - the throttle writes once inside 30 s;
  - reserved projects write nothing;
  - `prompt-submit`/`stop` output stays byte-identical;
  - `hooksSettingsBlock` and the installer's `jq` version still agree.
- **Viewer** (`test/sessions.test.ts`): every row of the §5 table, including:
  - an interrupted turn older than the cap falls back;
  - a driven row ignores host stamps;
  - a busy session counts in the Sessions line;
  - Quiet never says "no work";
  - attention and badge counts are unchanged (an existing attention test, re-run).
- **Manual**:
  - Claude: run a 5-minute shell-only task after `status({done:true})`. The card shows Working,
    "Task not reported", "last tool <1m"; after `Stop`, Idle "waiting for you".
  - Copilot: the same after PR 3, plus a `ps` check that the hook's parent is the `copilot` process.

## 8. Decisions (owner, 2026-11-05)

The owner approved all four recommendations:

1. **Unreported work counts as Working** (in the filter and the Sessions line), with "Task not reported" text. There is no separate Busy state.
2. **Copilot CLI gets an opt-in hooks file** (`~/.copilot/hooks/agent-inbox.json`), installed like Claude's hooks.
3. **Copilot records tool stamps** (`postToolUse`), at most one write every 30 s, with a switch to turn them off.
4. **PR 1 (honest labels) ships first**, in 2.4.x, before any hook work.
