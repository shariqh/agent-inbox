# Design: driven sessions — start an agent session from Agent Inbox and push messages into it (#412)

**Date:** 2026-10-31 (revised the same day after an independent design review, §14)
**Status:** Approved by the independent design review after two rounds (§14). Design only; nothing
here is built. Shariq answered §13 on 2026-10-31: **Copilot only for now; driving Claude is
deferred to the backlog (#421)**, and Claude sessions get push through Claude Code channels
(#418). Open items for the implementation PRs are in §14.3. The Copilot ACP spike (step 1)
amended the design the same day (§14.4;
[`2026-10-31-copilot-acp-spike.md`](2026-10-31-copilot-acp-spike.md)).
**Scope of this PR:** this document. No source, test or workflow changes.
**Related:** #411 and its design
([`2026-10-30-session-messages-design.md`](2026-10-30-session-messages-design.md), on
main since PR #417); PR #418 (Claude channels spike); the mesh
design ([`2026-10-29-agent-mesh-design.md`](2026-10-29-agent-mesh-design.md)) §2, §3, §6, §8.2,
§8.4 and §10.3; the 2026-10-30 research brief on pushing into a running session (kept outside
the repo). External facts were checked on 2026-10-30/31 (Appendix A).
**Built on:** Shariq chose **push-first** on 2026-10-30. A session Agent Inbox starts is
*driven* by Agent Inbox, so a human message (#411) arrives as a new turn pushed into the
session, with no watcher and no time window.

---

## §0 — Summary

1. **A driver owns each driven session.** `agent-inbox-driver` runs one agent child over ACP
   and reads and writes the hub only through `store.ts`. It begins life as a foreground
   terminal command (step 2), and Electron main later starts it detached (step 3). No HTTP route
   ever starts it.
2. **One protocol for both hosts.** `copilot --acp --stdio`, and later Claude through the
   `claude-agent-acp` adapter, which runs the Claude Agent SDK in streaming-input mode. The ACP
   client is Node core, so the app's dependency set is unchanged.
3. **Linking is by process ancestry.** A presence row whose live server's parent is its
   `host_pid`, started after the child, and whose `host_pid` is exactly the launch's recorded
   Copilot host, belongs to the launch; a nested CLI is its own session. Fresh
   `driven:<session>` leases in `hook_watch_claims` make `listActivity` report `driven`, so
   #411's composer can say **Arrives now**. There is no secret, no env claim, and no new column
   in the first build.
4. **Delivery is pushed, re-checked and batched.**
   - Queued messages are re-read just before each `session/prompt` and sent as one turn.
   - A new answer to one of the session's own asks also gets a ping turn.
   - `pending()`/`ack_message` stay the bookkeeping.
   - `flag` and `pending` say "you are woken automatically" in their responses.
5. **Permissions cannot escalate or leak.**
   - Every mode is explicit and verified on `session/new` and `session/load`, and so is
     Copilot's `allow_all` switch.
   - Any mode change outside the launch's allowed set, or `allow_all` turning on, ends it
     (`error:mode_escalation`).
   - A driver-side allow-list drops every option that switches to bypass or auto.
   - Prompt text never starts with `/`, so no human text can run a slash command.
   - Asks live in the reserved project `@sessions`, which no agent, hook or older server reads.
6. **Only the human at the app approves.** In step 2 that is the driver's own terminal. From
   step 3, main signs `(item, response_revision, optionId)` with a per-launch key through
   owned-viewer IPC. Every launch from the app needs a native confirmation, and a
   `script-src 'self'` CSP lands first.
7. **Budgets count active turn time and tool calls,** with a required, driver-enforced dollar
   cap for API-key Claude. An idle launch is parked, not ended: a later send becomes **Resume
   and send**. The driver fails closed when it cannot read the hub.
8. **Off means off** (§9). Nothing changes for anyone who never runs a driver.
9. **Phasing** (§11): a spike, then Copilot from a terminal (about 1½ weeks), then the Electron
   launch, then Claude after channels, then Resume and Take over. Terminal mode can ship alone
   as a quick New session.

## §1 — Goals and non-goals

**Goals.**
- (G1) Start a session on a known project without opening a terminal.
- (G2) Driven sessions take human messages and answers as pushed turns.
- (G3) Their asks reach the badge and dock through the existing predicate, and no other session.
- (G4) Bounded cost, a working Stop, and no permission escalation.
- (G5) Share launch code with the mesh wrapper without needing the mesh.

**Non-goals.**
- Driving sessions the human started by hand. #411's hooks and watcher cover those, and
  Claude channels (#418) may later.
- Autopilot loops.
- Windows.
- Remote launch (#8).
- Agent-to-agent delegation.
- Codex, for now.

## §2 — Where the driver runs

| | (a) Electron main | (b) `agent-inbox-driver`, one per launch (**recommended**) | (c) the mesh's `agent-inbox-wrap` |
|---|---|---|---|
| Survives app quit and update | No | Yes: runs from the installed runtime, pinned against prune (§7) | Yes |
| New dependencies | ACP and Claude SDKs in the app lockfile; the Claude SDK's darwin-arm64 binary is ~310 MB | None: a Node-core ACP client in `src/`; the user installs `claude-agent-acp` | `packages/mesh`, never built by the release pipeline |
| Hub writes (asks, delivery, leases) | Through `store.ts` | Through `store.ts`, like `hook-cli.ts` | Never (mesh §4.3) |
| UI-thread load | JSON-RPC streams on Electron main | None | None |
| Needs `mesh.json`, a listener and grants | No | No | Yes, which #412 must not need |

**Recommendation: (b).** The driver is a third host-adapter entry beside `hook-cli.ts` and
`watch-cli.ts` (`src/driver*.ts`, `src/acp-client.ts`). It is staged into every runtime payload
and runs on the runtime's own Node and `better-sqlite3`. Each launch gets one process, not a
daemon: a daemon needs a control channel a page could reach indirectly. Only a human at a
terminal (step 2), or Electron main after a native confirmation (step 3), starts a driver.

Running controls are hub rows: Stop, messages and answers. The driver checks
`PRAGMA data_version` once a second. Graph tests pin that no driver module enters the stdio MCP
graph or the viewer graph, and the driver binds no listener.

The mesh wrapper can reuse `acp-client.ts`, the host table and the option allow-list (§4).
Mesh §6.1 assumed `@agentclientprotocol/sdk`; this design avoids it, because it is 8.3 MB and
its peer is `@modelcontextprotocol/server@^2` where the app ships `@modelcontextprotocol/sdk@1`.

## §3 — Hosts and modes

### 3.1 One protocol: ACP v1

`src/acp-client.ts` is Node core, about 300 lines, speaking NDJSON over the child's stdio.
- **Calls:** `initialize`, `session/new`, `session/load` when the agent advertises
  `loadSession`, `session/prompt`, `session/cancel`, `session/set_mode` and, for Copilot's
  `allow_all` only, `session/set_config_option` (§4.1). Copilot 1.0.105 advertises no
  `session/resume`, so a resume is always `session/load` (§7).
- **Handles:** `session/update`, including `current_mode_update` and `config_option_update`
  (§4), and `session/request_permission`.
- **Declares** no `fs` or `terminal` capabilities.
- **Turns:** one at a time. A message waits until the whole turn ends, and a turn blocked on an
  approval does not end until that approval is answered (§5). The driver must hold to this
  itself: a second `session/prompt` during a turn makes Copilot cancel the running turn
  (`stopReason: "cancelled"`, about 10 ms later) and start the new one at once. The cancelled
  request stays in the conversation, so the agent may finish it in the next turn.
- **Attribution:** updates belong to the request in flight. The old turn's chunks can arrive
  after a new `session/prompt` is sent and before the old response, so "the latest prompt" is
  the wrong key.
- **Prompt text** never starts with `/` (§4.1).
- **Streams:** the child's stderr goes to the launch log. The driver writes only protocol
  messages to the child's stdin.

### 3.2 Copilot (`copilot --acp --stdio`, public preview)

Argv is fixed per mode (§4): `copilot --acp --stdio --allow-tool <name> [--allow-tool …]
[--deny-tool …] [--model M] [--effort E]`. Tool filters and effort are fixed when the server
starts, which suits one server per launch. There is **no `--mode`** in the argv: ACP's
`session/new` ignores it and always starts in `…/session-modes#agent`. The mode is set with
`session/set_mode` and verified (§4.1).

The session uses the user's own `agent-inbox` MCP registration, as in a terminal, and its tools
are pre-allowed. Otherwise every `pending`, `flag` and `ack_message` would become an approval.
`<name>` is read from the host config: the entry the installer manages (`agent-hosts.ts`'s
rule), whatever it is called there. If none is found, the driver refuses to start.
The driver never supplies a server of its own, which removes the duplicate-server risk. It
could not anyway: Copilot ignores client-supplied stdio servers in `session/new` (no error;
only its own log says "Rejecting non-http/sse MCP server … from client"), so the driver sends
`mcpServers: []`.

That server inherits the copilot child's whole environment, with the registration's own `env`
on top, and the user's registration usually sets none. So the child env carries the driver's
own `AGENT_INBOX_DB` when the driver reads a non-default hub. Otherwise the session's presence
would land in a different hub and never link (§5.1). The child env also drops `COPILOT_ALLOW_ALL`,
drops every `COPILOT_*` variable inherited from a parent Copilot session (such as
`COPILOT_AGENT_SESSION_ID`, `COPILOT_LOADER_PID` and `COPILOT_CLI_RESOLVED_DIST_DIR`, there when
the driver is run from inside one), keeps only `COPILOT_HOME` and `COPILOT_GITHUB_TOKEN`, and
sets `COPILOT_AUTO_UPDATE=false` (§8). Auth is the Copilot login, or `COPILOT_GITHUB_TOKEN`
from the env. GitHub's ACP reference names custom frontends as a use case.

### 3.3 Claude (Agent SDK through `claude-agent-acp`) — deferred to #421

**Deferred (2026-10-31).** Shariq chose not to drive Claude for now. This section is kept as the
design for #421. Claude sessions get push through Claude Code channels (#418) instead.

**Gate.** PR #418's channels spike showed a real `claude` take a pushed turn and ack it. Claude
work starts only after that spike's go/pivot note.

**The adapter.** `@agentclientprotocol/claude-agent-acp` v0.99.1 (Apache-2.0) is built on the
SDK's streaming input. It supports permission requests, cancel (`interrupt()`), load and resume,
and SDK options in `_meta.claudeCode.options`. The user installs it. The app never vendors the
SDK, which is under Anthropic's Commercial Terms.

**Options passed on every `new`, `load` and `resume`:**
- an explicit `permissionMode` (§4);
- `allowedTools: ['mcp__<name>__*']`, with `<name>` read from the host config as for Copilot
  (§3.2);
- `maxBudgetUsd` and `maxTurns`;
- `pathToClaudeCodeExecutable`, the user's `claude`.

`AGENT_INBOX_HOOKS=0` silences Agent Inbox's hooks, whose Stop nudge and `watch` would
duplicate the push.

**Auth.** The SDK docs bar third parties from offering claude.ai login without approval, so the
default is `ANTHROPIC_API_KEY`. A "personal" subscription switch exists in checkout builds only,
and never in a release. If the adapter cannot carry these options, a thin SDK adapter in
`packages/mesh` serves the same ACP surface.

### 3.4 Codex later

`codex app-server` (`sendUserTurn`) becomes a third row behind the same `HostAdapter` interface
when it is needed. Track `openai/codex#15299`.

### 3.5 Background, terminal, and taking over

**Background** is driven, and is the only mode with push.

**Terminal** is not driven, and can ship alone as a quick New session with no ACP.
1. Main writes a `0700` `.command` script into the launch folder, every value validated and
   shell-quoted, with the prompt in a `0600` file.
2. Main runs `/usr/bin/open -a Terminal -- <script>`.
3. The script runs `claude "$(cat prompt.txt)"` or `copilot -i "$(cat prompt.txt)"` in the
   chosen folder.

Messages to it use #411's hooks or watcher.

**No live attach.** An ACP stdio server has one client, `claude attach` covers only
`claude --bg` sessions, and no ACP client UI can join the driver's pipe.

**Take over in a terminal** (step 5). The driver cancels the turn, closes the child and marks
the launch `handed_off`. Main then opens a terminal on `claude --resume <id>` or
`copilot --resume <id>`. Two writers never share a session.

### 3.6 What the human sees

**Event log.** Each driver appends `<hub dir>/launches/<id>/events.ndjson`. It holds:
- agent text and plans;
- tool calls (input capped at 4 KB);
- permission requests, offered and dropped options, and answers;
- mode updates;
- injected turns by message id;
- stop reasons and usage.

The log rotates at 20 MB.

**Transcript panel** (step 3). It reads `GET /api/launches/:id/events?after=<offset>`, at most
256 KiB at a time and only while the panel is open. Agent text goes through
`renderStructuredText`, and everything else through `esc()`. Lanes, Live and the Agents view
show only a tag and a state.

## §4 — Permissions

### 4.1 Modes, with escalation closed

The human chooses one per launch, with no preselection. Each mode has an **allowed set** of
mode ids the session may be in. Copilot's mode ids are URLs: `#agent` below is
`https://agentclientprotocol.com/protocol/session-modes#agent` (the CLI's "interactive"), and
likewise `#plan` and `#autopilot`. `session/set_mode` refuses any other id, `interactive`
included.

| Mode (UI) | Claude `permissionMode` → allowed set | Copilot → allowed set | What it really permits |
|---|---|---|---|
| Ask for everything | `default` → {default} | `set_mode #agent` → {#agent} | Each tool call asks, except your own settings' allow rules |
| Read-only | `dontAsk` + `disallowedTools: [Write, Edit, NotebookEdit]` → {dontAsk} | `--deny-tool write`, `set_mode #agent` → {#agent} | File-edit tools denied; shell commands follow your settings or are denied (Claude) / ask (Copilot) |
| Plan first | `plan` → {plan, default} | `set_mode #plan` → {#plan} until the plan is approved, then {#agent} (§4.1 phases) | Plan, then ask-for-everything |
| Edits in the worktree | `acceptEdits` → {acceptEdits} | `--allow-tool 'write(<worktree>/**)'`, `set_mode #agent` → {#agent} | Edits auto-approved; shell, network and push ask |

For Copilot every allowed set also requires `allow_all: "off"`. `allow_all` is a separate
session config option (`configOptions`, category `permissions`): `#autopilot` turns it on, and
so do `session/set_config_option` and the `/allow-all` slash command, in any mode. Checking
`currentModeId` alone therefore does not prove "no allow-all".

**Plan first on Copilot.** Copilot's ACP plan mode has no exit tool and no plan-exit permission
request: the agent writes its plan and the turn ends, still in `#plan`. So the driver leaves
plan mode itself, and the mode that is valid depends on the launch's **phase**:
1. **`awaiting_plan_approval`** (from launch until the human approves): only `#plan` is valid.
   When a turn ends in `#plan`, the driver files an ask ("Approve the plan and continue?").
   A decline keeps the session in this phase.
2. **`switching`** (after approval): the driver sends exactly one `session/set_mode #agent`.
   The only change accepted is that request's own result. Copilot sends the
   `current_mode_update` to `#agent` just before the response, and the `config_option_update`
   (mode `#agent`, `allow_all` off) just before or after it. The driver then verifies `#agent`
   with `allow_all` off and sends the plan-approval control message (§5.3).
3. **`executing`**: only `#agent` is valid.

Any other mode change ends the launch with `error:mode_escalation`: an unsolicited `#agent`
before approval, a return to `#plan`, or a second switch. Copilot's plan exit cannot escape to
autopilot, because the only way out is the driver's own call. The other three launch modes have
a single phase, `executing`, with the set in the table.

The UI says this plainly: **once any shell command is allowed, the session can run anything.**
For example, approving `npm test` with edits allowed is arbitrary code execution, since the
agent can edit what `npm test` runs. "Read-only" therefore promises only that edit tools are
denied; it does not claim "writes impossible". User and project settings (`permissions.allow`,
`defaultMode`) load as in a terminal, and that is exactly what they would allow there.

**The escalation guard.** The driver:
1. sets the explicit mode after every `session/new` and `session/load` with `session/set_mode`
   (Claude: passes it in the options), never through the argv;
2. checks the resulting `currentModeId` against the allowed set and, for Copilot, that
   `allow_all` is `off`, and refuses to prompt on a mismatch. A loaded session otherwise
   continues in its last mode: a Copilot session left in `#autopilot` loads as `#autopilot` with
   `allow_all: on`, and a resumed Claude session continues in the transcript's last mode
   (`resolveInitialPermissionMode`). If `allow_all` is `on` after `new` or `load`, the driver may
   re-assert it off once (`set_config_option allow_all=off`, or `set_mode #agent` out of
   autopilot). It continues only when the next `config_option_update` verifies `off`; otherwise
   the launch ends;
3. on any `current_mode_update` outside the phase's valid set, or any `config_option_update` with
   `allow_all: "on"` after that check, sends `session/cancel`, answers pending requests
   `cancelled`, and ends the launch with `error:mode_escalation`. Updates that a
   `session/load` replays before it answers are history, not live changes (§7);
4. never calls `session/set_mode` except to set or re-assert the launch's own mode or to leave
   `#plan` after an approved plan, and never calls `session/set_config_option` except to set
   `allow_all` off;
5. never sends prompt text whose first non-space character is `/`. Copilot runs a prompt like
   that as a slash command, without the model, even with leading whitespace. `/allow-all` turns
   `allow_all` on and `/autopilot` switches mode. Every human message, the first prompt
   included, therefore goes through the framed format, and every prompt the driver writes
   itself is a framed control message (§5.3).
   Not every state change is reported (`/allow-all off` sent no update), so updates are not a
   complete record of state.

**Ordering: one serialized state machine.** An approval must never be applied against a security
state the human did not see. So the driver has one state machine that consumes, one at a time and
in arrival order, both the ACP frames it reads from the child and the **approval intents**: a TTY
answer in step 2, or a signed inbox reply in step 3 (§4.3).
- An intent is queued behind every ACP frame already read, so an update that arrived first is
  always applied first.
- The **security state** is the current mode plus `allow_all`. Its **generation** goes up on
  every `current_mode_update` and every `config_option_update`, even one that changes neither
  value, and on the driver's own `set_mode` and `set_config_option` results.
- Each ask records the generation, mode and `allow_all` when it is filed.
- Immediately before answering a `session/request_permission`, the driver re-validates. The
  generation must equal the ask's, and the state must be valid for the launch's phase. Only then
  may an approval answer `allow_once`.
- If the generation moved, the driver answers `reject_once` and resolves the ask "Not applied:
  the session's permissions changed while you were answering". If the state is invalid, the
  escalation rule (3 above) applies and the launch ends with every open request answered
  `cancelled`. Neither path ever answers `allow_once`.

**The option allow-list.** A per-host table of permitted `optionId`s (and kinds), recorded in
the spike, is applied to every `session/request_permission`.
- **Copilot (1.0.105):** every request offers the same three options, and each `optionId`
  equals its kind: `allow_once` ("Allow once"), `allow_always` ("Always allow") and
  `reject_once` ("Deny"). This holds for shell (`execute`), file (`edit`), URL (`fetch`) and MCP
  (`other`) requests.
- **v1 never selects `allow_always`.** A human approval answers `allow_once`, and a decline
  answers `reject_once`. On Copilot, Deny ends the agent's whole turn (`Operation cancelled by
  user`, `stopReason: "end_turn"`), not only that action. The ask's copy says so: "Declining
  stops the agent's current turn."
- **Dropped:** any option that changes the mode to bypass, auto, or "clear context and bypass".
  Claude's exit-plan-mode request offers "bypass" and "auto" as allow options
  (`buildExitPlanModePermissionOptions`; `ALLOW_BYPASS = !IS_ROOT || IS_SANDBOX`), so these are
  real.
- **Unknown ids:** also dropped. If no allow option is left, the driver answers with a reject
  option, or `cancelled`.
- **Never offered:** `bypassPermissions`, `auto`, `#autopilot`, `allow_all: on`, `--yolo`,
  `--allow-all-tools` and `COPILOT_ALLOW_ALL`.

### 4.2 Where asks live: the reserved project `@sessions`

`listPending` reads by project (`store.ts`), and the Claude hooks read the whole project
(`hook.ts` cmdWatch and the stop/prompt readers). An ask filed in the session's own project
would therefore reach every session there, older servers included. They would wake on it, and
an older server's `resolve` would count as Deny.

So every driver ask is filed in the reserved project **`@sessions`**, using mesh §10.3's
mechanism. Exactly two names are reserved, `@sessions` and `@mesh`, not every `@…` project,
because a folder with no remote can legitimately be named with a leading `@`.
- `listPending`, `listPendingRows`, `listUnansweredBoardRows` and every hook reader return
  nothing for a reserved project.
- MCP `register` refuses one, and `pending`, `flag`, `answer`, `resolve` and `board_*` refuse any
  scope or item id in one.
- `closeProject` refuses the reserved projects, so approvals cannot be muted.

All of this ships in step 2 and serves the mesh too. The real project and branch go in the
item's `stream` (`agent-inbox · feat-x`), the title and `context`, and the viewer shows them.
Older servers lack the filters; an agent that registers `@sessions` on one could read the asks,
which §8's threat model accepts.

Each ask is a question item:
- **Fields:** `action_owner: 'approval'`, the agent's MCP `session` (so it classifies as
  `waiting`), and `agent`/`action_agent`.
- **Text:** title "Allow copilot to run `git push origin ai/x`?". The tool name comes from the
  `tool_call` update's title (`agent-inbox-whoami`), not the permission request's, which is the
  bare tool name (`whoami`).
- **Context:** the tool kind, the input (4 KB; an `edit` request's input is a whole diff), the
  cwd and the launch.
- **Options:** the surviving options, at most four, matched by `optionId` and never by label.
  None is marked recommended. On Copilot that is Allow once (`allow_once`) and Deny
  (`reject_once`), since v1 never offers `allow_always` (§4.1). The copy says that declining
  stops the agent's current turn.

A Claude `AskUserQuestion` becomes the same kind of item, with Claude's choices. The badge, dock
and notifications follow the one predicate, and `public/attention.js` is unchanged.

### 4.3 Who can approve

- **Step 2 (terminal driver).** The foreground driver refuses to start without a TTY on stdin.
  It prompts on that TTY, and only an answer there approves. The answer is an approval intent in
  the driver's state machine, re-validated before it is applied (§4.1, Ordering). The inbox item
  is an alert (`action_owner: 'task'`, "Answer in the terminal running the driver") with no
  options. The driver resolves it when the TTY answers. No inbox reply approves anything in
  step 2.
- **Step 3 (app launches).** An approval goes through owned-viewer IPC,
  `agentInboxLaunch.approve({ item, revision, optionId })`.
  1. Main checks the `launch` grant (§8).
  2. Main signs `HMAC-SHA256(launchKey, item ‖ response_revision ‖ optionId)`, where
     `launchKey = HMAC-SHA256(masterKey, launchId)`. `masterKey` is the console key of mesh §3,
     held only in Electron `safeStorage`. Main derives `launchKey` and sends it to the driver on
     fd 3, so a quit, update or crash loses nothing: the relaunched app derives the same key and
     can approve every running driver's asks. If `safeStorage` reports only its plain-text
     fallback, the app refuses launches entirely.
  3. Main writes the reply through `store.ts`: `reply = optionId`, `reply_context` = the
     signature.
  4. The driver accepts only a valid signature over its own item, at the revision it recorded
     when filing, for an option still on the allow-list. Anything else is a rejection.
  5. A valid reply becomes an approval intent in the driver's state machine, so it is re-validated
     against the security-state generation before it is answered (§4.1, Ordering).
- **Never approved by:** the viewer's ordinary reply route, a browser tab, a reused viewer,
  hosted mode, or an agent (which cannot reach `@sessions` at all). In those places the page
  shows "Approve in the Agent Inbox app".
- **No timeout.** Asks never time out. Stop resolves them "Session stopped".

## §5 — Linking and pushed delivery

### 5.1 Linking by ancestry

The driver knows its child's pid, process group and start time, and makes a **launch id** (a
UUID) when it starts. For an npm-installed Copilot the child is the npm loader (`node
…/bin/copilot`, `ucomm` `node`). The loader stays alive and starts the native host
`…/@github/copilot-darwin-arm64/copilot` as its own child, which is the parent of every MCP
server and so the `host_pid` they record. The driver therefore records **both pids** right after
spawn: the loader (its child) and the launch's **native host**. The native host is the loader's
child that is an agent host: its `ucomm` is `copilot`, `claude` or `claude-agent-acp`, or its
command line contains `@github/copilot`. When the executable is the native binary itself, the two
are one process. On macOS `ps -o comm` prints the full executable path, cut to 16 characters
unless it is the last column, so the driver reads `ucomm` (the basename: `copilot` for the native
host) and keeps `command` last. Every 2 s it reads `listActivity` and runs one `ps -o
pid=,ppid=,lstart=,ucomm=,command=`. A presence row joins the launch only if all of these hold:
1. its `server_pid` is alive now;
2. its current parent is its `host_pid`;
3. its start time is at or after the child's;
4. its `host_pid` **equals** the launch's recorded native host pid.

Rule 4 is an exact equality, with no walk. Classification starts at `host_pid`, which is the
server's own agent host. A walk that began at `host_pid`'s parent would over-link, as the
spike's recorded nested chain shows. A `copilot -p` started by the driven agent's shell runs as
nested loader 76815 → nested host 76817 → its server 76850 (`host_pid` 76817), under the driven
host 76681. Walking up from 76815 passes the nested loader, which is not an agent host, and
reaches 76681, so the nested server would join the launch. With equality, 76817 ≠ 76681 and it
stays unlinked.

Rule 4 means a `copilot` or `claude` the agent starts in its own shell is **its own session**,
not driven. Messages to it use #411's ordinary paths, so a push never lands in the parent's turn
for a session the parent cannot `ack_message` (#411 §1 holds). Rules 1–3 defeat PID reuse: a
crashed foreign session whose stale `host_pid` now belongs to a tool shell fails them. A row
whose `server_pid` is dead counts as ended, whatever its presence row says.

For each linked session the driver holds a lease `driven:<session>` in `hook_watch_claims`, plus
`driver:<pid>` for itself. Each token is `<launch id>:<driver pid>:<nonce>`, so its identity is
the launch, not the driver process. Both leases are refreshed every 30 s.
`hook_watch_claims` is already read by no snapshot, so the refreshes rebuild nothing.
`listActivity` serves `driven: true` while the session's lease is under 90 s old; that comes from
the `/api/activity` read, which is fresh on every request.

Every session in the launch gets pushed messages and answer pings, and no watch contracts. A
restarted MCP server is linked on the next scan: there is no claim to wait out and no secret to
rotate. A resumed launch (step 3) keeps its launch id, so its new driver's leases carry the same
identity.

### 5.2 Re-addressing: the one exception (#411 amendment)

#411 §1 says a message to an ended session "is not re-addressed". This design adds one exception,
to be written into #411's design doc when this lands (in #417 if it is still open, otherwise in
step 2's PR).

> **Proof by launch.** When a driver has proved by ancestry that an ended session and a live
> session belong to one launch, `readdressMessages(from, to, launchId)` moves the open
> messages from one to the other. `to` must be the server whose `host_pid` is the launch's own
> native host (§5.1), never a nested CLI. It is one `.immediate()` transaction, conditioned on
> `from` being ended (its presence ended, or its `server_pid` dead as the driver reports) and on
> both sessions' `driven:` leases carrying that launch id, whichever driver process wrote them.
> No other path re-addresses.

### 5.3 Delivery

The driver needs one new read, `listOpenMessagesWithText(sessions)`, because
`listOpenMessages` returns ids only. Each message is pushed **once per launch**. The driver keeps
the pushed ids per session in `<hub dir>/drivers/<launch id>/pushed.json` (`0600`, written by
temp file and rename), and moves them with `readdressMessages`. A message it already pushed is
never pushed again, even if it is still open: declined, forgotten or un-ackable. Otherwise
every `data_version` change, including other sessions' presence writes, would re-push it, at a
premium request each. It is re-pushed only after a Resume (step 3), since the new process may
not hold the old turn. It stays in `pending()` either way.

When `data_version` moves and the session is idle:
1. Re-read the status of each open message not yet pushed, immediately before prompting.
   Acked or withdrawn ones are dropped.
2. Send all that remain as **one** turn:
   > The human sent you N message(s) via Agent Inbox. Each is also in pending(); act on each
   > once, then ack_message({ id, outcome }).
   >
   > [m-1] <verbatim text> …
3. Record the ids in `pushed.json` before the prompt is sent, then call
   `markMessageDelivered(id, session, 'agent-inbox-driver')` for each.

**Every prompt is framed.** The driver sends prompt text of exactly two shapes, so no human
text and no stored title can start a prompt with `/` and run a slash command (§4.1 rule 5):
- **Human text**, in the message format above. The first prompt (step 2's `--prompt-file`,
  step 3's dialog) uses it too: "The human started this session via Agent Inbox with this
  task:", a blank line, then the verbatim text.
- **Control messages**, written by the driver. Each starts with the fixed prefix `Agent Inbox:`
  followed by fixed text, with any agent-authored value only inside quotes:
  - plan approval (§4.1): `Agent Inbox: The human approved your plan. Carry it out now; tool
    calls still ask for approval as before.`
  - answer ping (below): `Agent Inbox: The human answered '<title>'; call pending().`
  - interrupt notice (below): the line `Agent Inbox: The human interrupted your previous turn.`,
    a blank line, then the human-text message format.

Every prompt of either shape passes the same last check: if its first non-space character is
`/`, the driver refuses to send it.

While a turn runs, messages queue. #411's composer shows the state:
- "Queued — it's mid-task (12m)";
- "Queued — waiting on your approval" (with a link to the ask);
- **Interrupt and send**, an explicit choice. The driver sends `session/cancel` and waits for the
  running `session/prompt` to answer `cancelled`. It answers any open permission request
  `cancelled` and resolves its ask "Interrupted". Only then does it send the turn, framed with
  the interrupt notice control message (above). Copilot would cancel the running
  turn on a bare second prompt too (§3.1), but this order keeps every update attributed to the
  right request. The interrupted request stays in the conversation, so the agent may pick it up
  again.

`pending()` still returns each message until `ack_message`, so #411's contract is unchanged.

**Answer pings.** When the human answers one of the session's own questions (`items.session`)
or rows of plans it wrote (`boards.session`), the driver sends the answer-ping control message
(`Agent Inbox: The human answered '<title>'; call pending().`) with no answer text. Approvals
are excluded: they live in `@sessions` and are answered through §4.3.

**Woken automatically, said at runtime.** When the calling session holds a fresh `driven:`
lease, `flag` returns no `watch` contract and adds `woken: "pushed"`. `pending()` adds the same
field, so the agent learns it from the response, not from a static appendix.

**Composer states** (#411 PR 2), checked in this order:
1. **Arrives now**, or **Queued**, when the session is driven.
2. **Wakes for it**, with #411's Claude hook lease.
3. **When it next checks**.
4. **Can't receive**.

A **parked** launch (§7, step 3) shows **Resume and send**. That click starts a driver that
loads the ACP session (`session/load`, §7), waits up to 60 s for the new MCP server to link
(§5.1), re-addresses the parked session's open messages to it, and only then sends. It never
sends to the ended session, which #411 would refuse with `session_gone`. If nothing links in
time, the text stays a draft, with "The session didn't come back; try again or start a new
one".

## §6 — Storage

**Step 2 adds no table and no column.** It adds `store.ts` functions:
- the reserved-project filters and refusals (§4.2);
- `listOpenMessagesWithText`;
- `readdressMessages`;
- the `driven:`/`driver:` lease helpers over `hook_watch_claims`;
- a `driven` field in `listActivity`.

The Stop control in step 2 is Ctrl-C, or a stop lease, `driver-stop:<launch id>`, in
`hook_watch_claims`, written by the runtime's own CLI: `<runtime>/bin/node
<runtime>/dist/driver-cli.js stop <launch id>`, which the driver prints at start.

**Step 3 adds `launches`**, once Copilot ACP has been used through step 2. Changes from the first
draft:
- **No `token_hash`, `revision` pinning or derived `lost` in the snapshot.** `GET /api/launches`
  (whole-table domain) serves launch facts only: project, host, mode, budgets, status and
  end_reason, with no clock-derived state. Lease freshness (running or lost) comes from
  `/api/activity`'s fresh read, and from a fresh `GET /api/launches/:id`.
- **`prompt` is not in the list snapshot.** It is served per launch by
  `GET /api/launches/:id/prompt`, and the dialog warns not to paste secrets into it.
- **Stop is idempotent and not pinned.** `requestLaunchStop(id)` sets `stop_requested_at` once
  (`COALESCE`), because per-turn `usage` writes move `revision`.
- **`closeLostLaunch(id)` re-checks, inside its `.immediate()` transaction, that the driver
  lease is stale.** It then ends the launch, resolves its `@sessions` asks, and returns the
  child's pgid and start time for main to kill (§7).
- **Columns** add `child_pgid`, `child_started_at`, `parked_at`, `acp_session` and the active
  time used. `spec_version` records the fd-3 spec version.

Older processes never name the table. `snapshot-triggers.txt` only gains names.

## §7 — Budgets and lifecycle

**Budgets.**
- **Active turn time**, summed while a turn runs (default 2 h). Idle time does not count.
- **Tool calls:** 500, counted from `tool_call` updates.
- **USD:** required for API-key Claude. It is passed as `maxBudgetUsd`, and the driver also
  enforces it itself from the adapter's `total_cost_usd`, ending the launch at the cap.
  Copilot's tag says "premium requests not tracked".

When a budget runs out, the driver cancels, waits up to 10 s, closes the child and ends the
launch with `budget:<which>`.

**Park, not end (step 3).** After 2 h idle, the driver closes the child, keeps `acp_session` in
the launch row, marks the launch `parked` and exits. Sending to a parked launch is **Resume and
send** (§5.3): the click is the gesture main needs to start a driver. That driver runs
`session/load` (Copilot advertises `loadSession` and no `session/resume`, so a resume is always
a load), links, and then sends. A load replays the session's history before it answers:
`user_message_chunk`, `tool_call`, agent text and every past `current_mode_update`. The driver
ignores updates for that session until the `session/load` response, then sets and verifies the
mode and `allow_all` exactly as after `session/new` (§4.1). A session that was never prompted is
not persisted (`session/load` answers `-32002 Resource not found`), so a launch parked before its
first turn cannot be resumed; Resume and send starts a fresh session there. Step 3
ships this minimal resume. **Step 2 has no park or resume:** it has no launch row to hold
`acp_session`, so after 2 h idle the terminal driver ends the session cleanly and exits.

**Stop.** The driver answers pending permission requests `cancelled`, resolves its asks
"Session stopped", sends `session/cancel`, and closes the child's stdin. After 10 s it sends
SIGTERM to the recorded pgid. (Copilot answers the open prompt `cancelled` within about 10 ms of
`session/cancel`, even with a permission request still unanswered, and exits about 1 s after
stdin closes, its MCP servers with it.)

**Orphans.** The driver records the child's pgid and start time, and the native host's pid (§5.1)
(in its lease token, and from step 3 in `launches`). **Close** on a lost launch kills that group
only when the start time still matches.

**Fail closed** (mesh §8.4). After 30 s with no successful hub read, the driver cancels the
turn, denies every pending ask, and exits. It cannot see Stop, so it stops.

**Concurrency.** At most 2 Copilot drivers and 1 Claude driver per host, counted from fresh
`driver:` leases inside one `.immediate()` claim. A refused start says which sessions are
running.

**Runtime pins.** `install-agents.sh`'s own `prune_old_runtimes` has no running-process check,
so two installs or an Uninstall could delete a live driver's runtime. Pins must sit **outside
the payload**: verification rejects any unmanifested file (`runtime-payload.mjs` "unmanifested
file present in payload"; Electron's `runtime-verify.cjs` through `setup-runner.cjs`; the
driver's own check). A pin inside the runtime would make it read `changed`. So each driver
writes `<runtime root>/.pins/<runtime id>/<launch id>`, containing its pid and start time, and
removes it on exit.
- The runtime list (`runtime-payload.mjs list`, `runtime-inventory.ts` and the prune scripts)
  skips `.pins`, as it skips `.trash-*`, and `.pins` is never a runtime id.
- Both prunes (`prune-runtimes.sh` and `prune_old_runtimes`) key on the runtime id. They keep
  any runtime with a pin whose pid is alive with a matching start time, and share
  `prune-runtimes.sh`'s `ps` check. A stale pin is removed by the prune that finds it.
- Uninstall refuses while a pinned driver runs, naming it and its stop command.
- This ships in step 2.

**App quit** (step 3). Detached drivers keep running. Quit shows a native prompt listing them,
with Stop all or Keep running. `beginAppQuit()` refuses new launches through a `launchGate`.
After quit, approvals stall until the app is open again, since only the app signs (§4.3), and
messages need a viewer.

## §8 — The Electron boundary and security (step 3)

**A native confirmation for every launch.** Before spawning, main shows a `dialog.showMessageBox`
that it builds itself, never from page text. It lists the project and folder, the host, the
mode and what it permits (§4.1), the budgets, and the first 300 characters of the prompt.
Spawning needs **Start**, as mesh §8.2 binds a click to what the human saw. The spec it showed
is the spec it sends.

**CSP first.** A separate PR before the UI adds `script-src 'self'` (and `object-src 'none'`) to
the viewer's CSP, which today is only `frame-ancestors 'none'`. Without it, any injected script
in the owned viewer could call `start()` or `approve()`. The confirmation dialog and signed
approvals do not depend on it, but it narrows what a page can do.

**`electron/driver-process.cjs`** mirrors `setup-process.cjs`.
- **Argv:** exactly `[<runtime>/bin/node, <runtime>/dist/driver-cli.js, 'run', <launchId>,
  <hub db>]`, from the installed runtime verified against the signed digest (#206).
- **Spawn:** detached, no shell, stdio to files.
- **Spec:** fd 3 carries a versioned spec (`{ v: 1, … }`) and the launch key. Main first checks
  that the runtime's version understands that spec version, and asks to update agents if not.
- **Platform:** any platform but darwin fails closed.

**IPC and the grant.** The preload exposes `available()`, `start(spec)`, `stop(id)`,
`approve({ item, revision, optionId })`, `resume(id)` and `takeOver(id)`, each with exact arity.
They are served only to the viewer window's top frame, under a new fourth grant, `launch`,
issued by `createInstallBinding()`. The grant follows the `files` rule: an owned viewer,
re-proved after every navigation (#216), with the switch on and no quit begun.

**What the renderer may send.**
- A known `repo_root` (or a folder from main's own dialog), plus enums and bounded budgets.
- Never a path, executable, argv or env.

**Executables and the shebang.** The driver resolves the host executable on the captured PATH
(below) to a real path, owned by the uid or root and not group- or world-writable. If its first
line is `#!/usr/bin/env node` (or names any interpreter), the driver resolves that interpreter on
the same PATH. It spawns `[interpreter, script, …]` explicitly, records both, and checks
`--version` minimums. An npm-installed Copilot is exactly this case: `…/bin/copilot` is
`npm-loader.js` (`#!/usr/bin/env node`), which runs on the first `node` on the captured PATH and
starts the native host as its child (§5.1).

**Environment** (decided: a login-shell capture, then a denylist).
- **Capture.** A Finder-launched Electron has a minimal PATH, with no nvm, volta, mise or asdf.
  So for each launch main runs `$SHELL -i -l -c` once, **with cwd set to the launch folder**, a
  10 s timeout and stdin closed (about 2 s on the spike's Mac). **Refresh environment** re-runs it
  after a failure. The `-i` matters: zsh reads `.zshrc` only for interactive shells, and that is
  where nvm, volta and mise are usually set up. The cwd matters too: per-folder version managers
  (fnm `--use-on-cd`, nvm auto-use) choose a version when the shell starts in a folder, and their
  cd hooks never fire in the agent's own shells. The command prints a random start marker,
  `env -0`, and an end marker; main parses only what lies between them, so banners and rc output
  are ignored, as VS Code's shell-env resolver does. It keeps the result in memory and never
  writes it to disk.
- **Denylist.** From that env the driver removes `ELECTRON_*`, `AGENT_INBOX_*`, `NODE_OPTIONS`,
  `COPILOT_ALLOW_ALL`, and every other `COPILOT_*` variable except `COPILOT_HOME` and
  `COPILOT_GITHUB_TOKEN` (a parent Copilot session's `COPILOT_AGENT_SESSION_ID`,
  `COPILOT_LOADER_PID`, …). It then sets `AGENT_INBOX_HOOKS=0`, and `AGENT_INBOX_DB` to the hub
  it reads itself whenever that is not the default, because the session's agent-inbox server
  inherits the child's env (§3.2).
- **Kept on purpose:** `SSH_AUTH_SOCK`, `TMPDIR`, proxy variables, `NODE_EXTRA_CA_CERTS`,
  `COPILOT_HOME`, `CLAUDE_CONFIG_DIR` and `XDG_CONFIG_HOME`.
- **What the capture brings, as a terminal does.** The capture is exactly what a fresh login
  shell in that folder gets, including what the user's rc files export. On the spike's Mac that
  was a 1Password service-account token (`OP_SERVICE_ACCOUNT_TOKEN`), which the agent and every
  MCP server then inherit. It was also the wrong Node: `.zshrc` re-runs `brew shellenv` after
  fnm, so Homebrew's Node 26 wins on PATH even in a folder whose `.node-version` says 24. A
  terminal session started the same way has the same exposure and the same Node. Whether to pass
  Copilot's `--secret-env-vars` for secret-shaped names is open (§14.3).
- **Step 2** inherits the terminal's env through the same denylist.
- **The spike** ran `npm test` and SSH (`ssh -T git@github.com`, `git ls-remote` over SSH) in a
  session on a captured env, through the agent socket. No push was made; it uses the same
  transport.

**Secrets.** API keys live in `safeStorage` and travel on fd 3, never in argv, a file or SQLite.
The driver never writes env or auth values to its logs. The agent output it records can contain
anything the agent printed, including secrets the agent read, so the logs stay `0600` in a
`0700` folder and are pruned with the launch.

**Threat model** (mesh §3, stated plainly). A driven session is the human's agent with the
permissions the human chose.
- **What holds:** no local page or browser tab can start a session or approve an ask. No agent,
  hook or other session can read or answer an approval (`@sessions`, signatures). The mode
  cannot escalate past the launch's allowed set. Cost is capped.
- **What does not hold:** once any shell command is allowed, the agent can run anything, in its
  worktree and beyond. A same-user process with a shell can do all of this without Agent Inbox.
  Injected prompts from repository or tool content stay the agent's normal risk. The human's
  defence is to choose the mode and answer asks with that in mind, and the copy says so.

## §9 — The opt-in contract

**Step 2** is opt-in by its nature: nothing runs unless a human runs `agent-inbox-driver`.

**Step 3's app path** sits behind **Settings → Agent sessions → "Start sessions from Agent
Inbox"**. It is off by default, owned by main in `userData/session-launch.json` (read
tolerantly, like Links), and a browser cannot turn it on. While it is off:
- **(a) MCP.** `tools/list` and every response are byte-identical, apart from refusals for `@`
  projects, which no one uses.
- **(b) Page.** The page reads nothing new, adds no control, and its bodies and ETags are
  unchanged (DOM test).
- **(c) Dependencies.** `test/fixtures/app-dependencies.txt` is unchanged.
- **(d) Hub.** It has an empty `launches` table, and existing snapshots are byte-identical.
- **(e) Main** captures no env, spawns nothing and resolves no host executable.

## §10 — Platforms

- **macOS** first.
- **Linux** follows Setup's rules: the boundary allows `linux` once Setup's Linux release path
  does, and terminal mode needs a chosen terminal app.
- **Windows** is refused before spawn.

## §11 — Phasing

| Step | Ships | Effort |
|---|---|---|
| 1. Spike | Recorded fixtures and a go/pivot note | 2–3 days |
| 2. Copilot from a terminal | Foreground driver; ancestry linking; push-once; `@sessions`; runtime pins | ≈ 1½ weeks |
| 2b. Terminal mode (optional, any time) | New session that opens Terminal, no ACP | 2–3 days |
| CSP PR | `script-src 'self'` before any launch UI | 1–2 days |
| 3. Electron launch | Confirmation, detach, `launches`, signed approvals, UI, park and minimal resume | 2–2½ weeks |
| 4. Claude | After the #418 channels go/pivot | 1 week |
| 5. Resume and Take over | Full resume, handing off to a terminal | 1 week |

**1. Spike.** Real `copilot --acp` and `claude-agent-acp` runs, recorded as fixtures.
**Done for Copilot on 2026-10-31:** go, with the amendments in §14.4. Report:
[`2026-10-31-copilot-acp-spike.md`](2026-10-31-copilot-acp-spike.md); fixtures:
`test/fixtures/acp/copilot-1.0.105/`. The Claude items moved to #421 with the host.
- Option ids per host, Copilot's plan exit (can it escape to autopilot?), and `currentModeId`
  and `current_mode_update` behaviour on new, load and resume.
- `--allow-tool <name>` and `allowedTools: ['mcp__<name>__*']` with the registered name.
- nvm loaded from `.zshrc` only, found by the `-i -l -c` capture.
- `loadSession`.
- Child exit on stdin close.
- Ancestry: whose child is the MCP server.
- `npm test` and an SSH `git push` under the env rules.
- Adapter options and `total_cost_usd`.

**2. Copilot from a terminal** (`Part of #412`, after #411 PR 1):
`agent-inbox-driver copilot --cwd . --mode ask|read-only --prompt-file f`, run in the
foreground from the installed runtime.
- **Excluded:** detach, Electron, worktree, Keychain, transcript UI and Resume.
- **Stop:** Ctrl-C, or the runtime CLI's `stop <launch id>`.
- **Refuses to run** when stdin is not a TTY, since approvals happen on that TTY.
- **No park or resume:** 2 h idle ends the session (§7).
- **Budgets:** active time and tool calls.
- **Linking and delivery:** ancestry plus leases, re-checked and batched pushes, answer pings,
  and `woken` in `flag`/`pending`.
- **Asks:** TTY approvals with an `@sessions` alert, the escalation guard, and the option
  allow-list.
- **Infrastructure:** reserved-project filters in `listPending`, `listPendingRows` and the hook
  readers, MCP refusals, fail-closed, concurrency caps and runtime pins.
- **Schema:** no new table or column.
- **Tests:**
  - a fake ACP agent replaying the spike's fixtures: mode escalation, `allow_all` turning on,
    bypass options dropped, unknown ids dropped, `allow_always` never selected, a load replay
    holding an autopilot `current_mode_update`, the mid-turn cancel, and a first prompt starting
    with `/` refused;
  - Plan first: an unsolicited `current_mode_update` to `#agent` before the plan is approved ends
    the launch with `error:mode_escalation`; after approval, only the driver's own one
    `set_mode #agent` is accepted, and a later `#plan` ends the launch;
  - ordering, both directions: an escalation or config update that arrives just before an
    approval is applied first, so the approval answers `reject_once` (or the launch ends) and
    never `allow_once`; an approval intent that lands while an update is already queued waits
    behind it and is re-validated against the new generation;
  - control messages: the plan-approval, answer-ping and interrupt prompts start with
    `Agent Inbox:`, and any prompt text whose first non-space character is `/` is refused;
  - an MCP integration test that no session in any scope sees an `@sessions` ask;
  - hooks ignoring `@sessions`;
  - ancestry: a nested CLI stays unlinked, a reused stale `host_pid` is refused, a dead
    `server_pid` counts as ended, and an npm loader with its native host child links. The
    spike's recorded nested chain is an explicit case: driver child (loader) 76679 → launch host
    76681 → nested loader 76815 → nested host 76817 → nested server 76850 with `host_pid`
    76817. The nested server stays unlinked because 76817 ≠ 76681, and the launch's own server
    (`host_pid` 76681) links;
  - a message pushed once and never again while idle, with re-check before push;
  - pins outside the payload keeping a runtime through both prunes while it still verifies;
  - the TTY refusal;
  - mixed-version tests.

**3. Electron launch** (`Part of #412`):
- the CSP PR first;
- `driver-process.cjs`, the native confirmation, the `launch` grant and IPC;
- signed approvals;
- `launches` and its routes;
- the quit prompt and `launchGate`;
- the New session dialog (project, host, mode with its plain copy, budgets, worktree);
- tags, Stop and Close in Live, lanes and the Agents view;
- the transcript panel, Arrives now, Queued and Interrupt and send;
- park and Resume and send;
- the off tests and the reused-viewer refusal test;
- `docs/architecture/driven-sessions.md`.

**4. Claude** — deferred to #421, not part of #412 (2026-10-31):
- the host;
- API-key auth on fd 3;
- driver-enforced USD;
- the personal switch, in checkout builds only;
- the adapter version check.

**5. Resume and Take over** (`Closes #412`).

## §12 — Risks

- **Churn.** Copilot's ACP is a preview, and the adapter ships often. Mitigations: recorded
  fixtures, a minimum version, protocol v1, and the option allow-list failing closed on unknown
  ids. Step 2 proves the Copilot path before any permanent schema exists.
- **Shell means anything.** No mode makes shell access safe. The copy says so, and the
  confirmation dialog repeats it.
- **Approvals stall after quit** until the app reopens.
- **An older server registering `@sessions`** can read asks. This is accepted, as in mesh §10.3.
- **Ancestry needs `host_pid`** (from #253). Older servers can't receive messages anyway.
- **ACP v1 has no mid-turn input.** On Copilot a second prompt cancels the running turn instead
  (§3.1), so the driver queues. The copy shows Queued, and offers Interrupt and send.
- **Slash commands in prompt text** can change permissions (§4.1 rule 5). Framing every prompt
  closes it; the escalation guard is the backstop.
- **Login-shell capture** can be slow or fail. When it does, the feature says so and offers
  Refresh environment; there is no silent fallback to Finder's PATH.

## §13 — Questions for Shariq (with the reviewer's views)

1. **Claude auth.** Use an API key by default, with your subscription behind a "personal"
   switch? *Recommend and reviewer: yes, with the switch in checkout builds only, never in a
   release.*
2. **App quit.** Should driven sessions keep running? *Recommend and reviewer: yes, plus a quit
   prompt listing running sessions.* Approvals stall until the app reopens, and messages need a
   viewer (a browser viewer can send messages but never approve).
3. **Host order.** Copilot first? *Recommend and reviewer: yes; Claude after the #418 channels
   spike.*
4. **First prompt.** Store it? *Recommend and reviewer: yes, served per launch rather than in
   the list snapshot, and the dialog warns not to paste secrets into it.*
5. **Budgets.** Use active turn time (2 h), park after 2 h idle, 500 tool calls, and a required
   dollar cap enforced by the driver for API-key Claude? *Recommend and reviewer: yes.*


**Answered by Shariq, 2026-10-31:**
1. **Claude auth:** moot. Driving Claude is deferred to the backlog (#421). Claude push uses
   channels with his subscription (#418).
2. **App quit:** accepted. Driven sessions keep running, and a quit prompt lists them.
3. **Host order:** Copilot only for #412. Claude is in #421.
4. **First prompt:** accepted. Stored, served per launch, with a warning against pasting secrets.
5. **Budgets:** accepted: active turn time, park when idle, 500 tool calls. The dollar cap
   applies only if #421 is built.

## §14 — Changes after review (2026-10-31)

The reviewer's verdict was **build after changes**. They endorsed the driver-per-launch shape,
ACP, hub writes through `store.ts` only, and the opt-in contract.

- **High 1, mode escalation.** An explicit mode on new, load and resume; `currentModeId`
  verified; out-of-set updates end the launch (`error:mode_escalation`); an option allow-list
  that drops bypass and auto; "writes impossible" dropped; Copilot's plan exit added to the
  spike. (§4.1)
- **High 2, leaking asks.** Asks moved to the reserved `@sessions` project, with the filters and
  MCP refusals in the first PR. `items.origin` dropped. Approvals left out of answer pings.
  (§4.2, §5.3)
- **High 3, a weak grant.** A native confirmation per launch; the CSP PR first; approvals only
  through owned-viewer IPC with a per-launch HMAC, or the TTY in step 2; the threat model and
  mode copy rewritten. (§4.3, §8)
- **Medium 4.** The agent-inbox tools are pre-allowed. The user's own registration is used, so
  no duplicate server is added. Every descendant presence row is part of the launch. (§3.2, §5.1)
- **Medium 5.** The env claim and secret are replaced by ancestry linking: there is no claim to
  wait out and nothing to rotate. The #411 amendment is written out. (§5.1, §5.2)
- **Medium 6.** Runtime pins honoured by both prunes; Uninstall refuses while drivers run. (§7)
- **Medium 7.** No clock-derived state in snapshots; Stop idempotent and unpinned;
  `closeLostLaunch` re-checks inside its transaction; the prompt served per launch. (§6)
- **Medium 8.** Login-shell env capture with a denylist; explicit shebang resolution; the kept
  variables listed; `npm test` and SSH push added to the spike. (§8)
- **Medium 9.** Active-time budgets; park instead of end; Resume and send; minimal resume in
  step 3; the USD cap enforced by the driver too. (§7)
- **Medium 10.** Re-check before each prompt; batching; a read that returns the text; Queued
  copy; Interrupt and send. (§5.3)
- **Medium 11.** pgid and start time recorded; fail-closed after 30 s; concurrency caps. (§7)
- **Medium 12.** Claude gated on #418; the personal switch in checkout builds only. (§3.3)
- **Low.** No schema until step 3; a versioned fd-3 spec with a runtime check; `woken` in the
  responses; approvals matched by option id; the log wording fixed.
- **Phasing** restructured around the reviewer's smallest first slice. Terminal mode is noted
  as shippable alone. (§11)

**Round 2 (the last fix round).** The reviewer confirmed Highs 1–3 resolved, `@sessions` safe
with older servers, and step 2 schema-free.
- **Pins broke verification.** Pins moved outside the payload, to
  `<runtime root>/.pins/<runtime id>/<launch id>`. Runtime lists skip `.pins`, and both prunes key
  on the runtime id. (§7)
- **Ancestry over-linked.** A server is linked only while alive, parented by its `host_pid` and
  started after the child, and the walk stops at the first agent host, so nested CLIs are their
  own sessions. A dead `server_pid` counts as ended. `readdressMessages` targets only the
  child's own server. (§5.1, §5.2)
- **Repeated pushes.** Each message is pushed once per launch, recorded in `pushed.json`, and
  re-pushed only on Resume. (§5.3)
- **The approval key died with the app.** It is now `HMAC(masterKey, launchId)`, from the
  `safeStorage` console key, and launches are refused on the plaintext fallback. (§4.3)
- **nvm in `.zshrc`.** The env capture uses `$SHELL -i -l -c` with marker-bracketed `env -0`,
  and the spike gains an nvm-in-`.zshrc` case. (§8, §11)
- **Park and resume didn't connect.** Leases carry the launch id. Resume and send waits for the
  new session to link, re-addresses, then sends. Park and resume are dropped from step 2, where
  idle ends the session. (§5.1, §5.3, §7)
- **Low.**
  - Only `@sessions` and `@mesh` are reserved.
  - The MCP registration name is read from the host config, or the driver refuses to start.
  - Step 2's Stop uses the runtime CLI.
  - The terminal driver refuses to run without a TTY.

### 14.3 Open items for implementation (final check, 2026-10-31)

The final design check approved the design with no High findings and listed these for the
implementation PRs, which get their own reviews:
- **Nested-host test and npm-installed Copilot (Medium).** *Settled by the spike (§14.4):* the
  npm loader reads `node`, and the MCP servers' parent is the native host, whose `ucomm` is
  `copilot`. §5.1 now records both pids and matches hosts on `ucomm` or `@github/copilot` in the
  command line. The nested-CLI test still runs against a real npm install.
- **Re-addressing after a long park (Medium, step 3).** The `from` lease is pruned after a day, so
  prove `from` through the `launches` row, or keep the leases of parked launches.
- **Unambiguous signing input.** Length-prefix `item ‖ response_revision ‖ optionId`, and add a fixed
  label to the key derivation, since the master key is shared with the mesh console key.
- **`pushed.json` versus the database.** After a crash between `readdressMessages` and the file
  write, the database is the truth.
- **Interactive env capture can hang.** `-i` with stdin closed can block on rc prompts. A timeout is
  the visible "Refresh environment" failure, never a retry loop.
- **Secret-shaped variables in the captured env (from the spike).** Whether to pass Copilot's
  `--secret-env-vars` for names such as `*_TOKEN`, `*_SECRET`, `*_KEY` and `*_PASSWORD`. It strips
  them from the agent's shell and MCP environments and redacts them from output. That also hides
  them from an MCP server that needs one, and a terminal session has the same exposure today
  (§8).

### 14.4 Spike amendments (2026-10-31)

The Copilot ACP spike (step 1) recorded 15 transcripts against Copilot CLI 1.0.105 and reported
**go** ([`2026-10-31-copilot-acp-spike.md`](2026-10-31-copilot-acp-spike.md); fixtures in
`test/fixtures/acp/copilot-1.0.105/`). The coordinator's decisions on its findings, now folded
into the sections named:
- **(a) No `allow_always` in v1.** A human approval answers `allow_once` and a decline
  `reject_once`. The ask's copy says that declining stops the agent's current turn, because on
  Copilot it does. (§4.1, §4.2)
- **(b) `allow_all: on` is escalation.** It is checked after `session/new` and after
  `session/load`. Any `on` ends the launch, unless the driver re-asserts it off and verifies
  that. Later, any update to `on` ends it. (§0, §4.1)
- **(c) No prompt text starts with `/`.** Copilot runs it as a slash command (`/allow-all`,
  `/autopilot`), even after leading spaces. Every human message, the first prompt included, goes
  through the framed format. (§3.1, §4.1, §5.3, §12)
- **(d) Modes by `session/set_mode` with the URL ids, verified.** There is no `--mode` in the
  argv, because ACP's `session/new` ignores it. (§3.2, §4.1)
- **(e) Plan first.** Copilot's ACP plan mode has no exit tool, so it cannot escape to autopilot.
  After the human approves the plan, the driver switches the mode to `#agent` itself. (§4.1)
- **(f) Interrupt and send.** `session/cancel`, then wait for the turn's `cancelled` response,
  then `session/prompt`. A bare second prompt would cancel the running turn anyway. Updates are
  attributed by the request in flight. (§3.1, §5.3, §12)
- **(g) Two pids.** The driver records the npm loader (its child) and the native host (the MCP
  servers' parent). Hosts match on `ucomm` `copilot` or `@github/copilot` in the command line.
  (§5.1, §5.2, §7, §8)
- **(h) Env for the MCP server.** The driver passes its own `AGENT_INBOX_DB` through and strips
  `COPILOT_*` inherited from a parent Copilot session. Client-supplied stdio MCP servers are
  ignored by Copilot, so the driver sends `mcpServers: []`. (§3.2, §8)
- **(i) Resume is `session/load`.** Replayed updates are ignored until it answers, then the mode
  and `allow_all` are re-checked. A never-prompted session cannot be resumed. (§3.1, §5.3, §7)
- **(j) Env capture runs in the launch folder.** rc files can export secrets, and the wrong Node
  can win on PATH, exactly as in a terminal. `--secret-env-vars` is an open item. (§8, §14.3)

**Review amendments (2026-10-31, PR #423 review).** A review of the folded amendments found four
design gaps, fixed as follows:
- **(1) Nested sessions over-linked.** A walk that started at `host_pid`'s parent let a nested
  CLI's server pass its own host and reach the launch's host. The recorded chain is
  76815 → 76817 → server, under 76681. Rule 4 is now exact equality: `host_pid` = the launch's
  recorded native host pid. The recorded chain is a step 2 test. This supersedes (g)'s matching
  for linking; host matching now only finds the native host after spawn. (§0, §5.1, §11)
- **(2) Plan first let `#agent` in early.** A single allowed set {#plan, #agent} accepted an
  unsolicited `#agent` before approval. Mode validity is now per phase:
  `awaiting_plan_approval` allows only `#plan`. `switching` accepts exactly the result of the
  driver's own one `set_mode #agent`. `executing` allows only `#agent`. Anything else ends the
  launch. (§4.1, §11)
- **(3) No ordering between updates and approvals.** One serialized state machine now consumes
  ACP frames and approval intents in arrival order. Each ask records a security-state generation
  (mode plus `allow_all`, bumped on every mode or config update). Before answering, the driver
  re-validates: a moved generation answers `reject_once`, an invalid state ends the launch, and
  neither answers `allow_once`. Ordering is tested in both directions. (§4.1, §4.3, §11)
- **(4) Control messages are framed.** "Proceed with the plan" was a raw prompt. Plan approval,
  answer pings and the interrupt notice are now control messages with the fixed prefix
  `Agent Inbox:`, under the same leading-`/` check. (§4.1, §5.3, §11)

### 14.5 Build amendments (step 2, 2026-10-31)

Accepted by the coordinator while building step 2's driver (PR 2 of 3):
- **The first prompt waits for linking.** The driver holds the first prompt until the session's
  agent-inbox MCP server links by ancestry (§5.1), at most 10 s (`linkWaitMs`), then sends it either
  way. Copilot starts that server during `session/new`, so this normally costs a scan or two; it
  makes the first approval alert carry the driven session's MCP `session` (§4.2), so it classifies
  as waiting, and makes the first pushes possible. (§5.1, §5.3)
- **Terminal commands.** Besides `y`/`n` for an open approval, the step-2 terminal takes
  `interrupt` (Interrupt and send, §5.3, when a message is queued mid-turn) and `stop` (the same Stop
  as Ctrl-C or `stop <launch id>`, §7). Any other line prints a one-line help. (§4.3, §11)
- **A trusted `copilot`.** The step-2 driver resolves `copilot` on the terminal's PATH to a real path
  and refuses to start unless that file is owned by the user or root and is not writable by group or
  others, the check §8 sets for step 3's executables. (§8)

- **Pins, as built (PR 3).** A pin records the driver's pid and its start identity, which never
  moves while it runs: `/proc/<pid>/stat` start ticks with the boot id on Linux (not `ps -o
  lstart=`, which moves when the clock is stepped), `ps -o lstart=` on macOS. Anything that is not
  a real file owned by the user under real `.pins` folders is ignored. The driver removes its pin
  on every exit it sees; each prune sweeps up to 64 stale ones under the setup lock, and re-reads
  the pins after moving a runtime aside, putting it back if one now holds it; the driver checks
  its runtime is still there after pinning. Uninstall refuses on a running driver's pin, never on
  a stale one. The viewer's mirror checks the pid alone (it starts no process), so it errs toward
  keeping. The installed command is `<runtime>/bin/node <runtime>/dist/driver-cli.js copilot …`,
  which the installer prints; nothing is put on PATH. (§7, §11)

## Appendix A — Verification log

| # | Fact | Source | Checked |
|---|---|---|---|
| 1 | Streaming input, queued messages, a long-lived process | code.claude.com/docs/en/agent-sdk/streaming-input | 2026-10-31 |
| 2 | Permission order; modes incl. `dontAsk`, `plan`, `auto`, `bypassPermissions`; deny rules apply in every mode; prompts never time out | …/agent-sdk/permissions; …/typescript (`CanUseTool`) | 2026-10-31 |
| 3 | `maxBudgetUsd`, `maxTurns`, `allowedTools` with `mcp__<server>__*`, `settingSources`, `env`, `pathToClaudeCodeExecutable`, `interrupt()` | …/agent-sdk/typescript; …/permissions | 2026-10-31 |
| 4 | Commercial Terms; no claude.ai login for third parties without approval | …/agent-sdk/overview | 2026-10-31 |
| 5 | SDK 0.3.316; darwin-arm64 binary ~310 MB | `npm view` | 2026-10-31 |
| 6 | `copilot --acp`: one stdio client, exits on stdin close, tool filters fixed at start | docs.github.com/…/copilot-cli-reference/acp-server | 2026-10-31 |
| 7 | Copilot 1.0.105: `--allow-tool <server>`, `--deny-tool`, deny beats allow, `--mode interactive\|plan\|autopilot`, `--disable-mcp-server`, `COPILOT_ALLOW_ALL` | local `copilot --help`, `help permissions`, `help environment` | 2026-10-31 |
| 8 | ACP new, load, resume and modes; `current_mode_update`; prompt turn and cancel; `request_permission` option kinds | agentclientprotocol.com/protocol/{session-setup,session-modes,prompt-turn,tool-calls} | 2026-10-31 |
| 9 | `@agentclientprotocol/sdk` 2.2.0: 8.3 MB, peer `@modelcontextprotocol/server@^2.4` | `npm view` | 2026-10-31 |
| 10 | `claude-agent-acp` 0.99.1: `_meta.claudeCode.options`, cancel, load and resume; exit-plan-mode offers bypass and auto (`buildExitPlanModePermissionOptions`, `ALLOW_BYPASS`); resume keeps the last mode (`resolveInitialPermissionMode`) | `npm view`; README; reviewer's source citations | 2026-10-31 |
| 11 | `listPending` reads by project; `prune_old_runtimes` has no process check | `git show origin/main:src/store.ts`, `scripts/install-agents.sh` | 2026-10-31 |
| 12 | Channels: research preview, interactive-only; #418 spike open | research brief; `gh pr view 418` | 2026-10-31 |
| 13 | Copilot 1.0.105 over ACP: URL mode ids; `--mode` ignored by `session/new`; `allow_all` config option; slash commands in prompt text; a second prompt cancels the running turn; `loadSession` only, load restores autopilot; client stdio MCP servers rejected; option ids `allow_once`/`allow_always`/`reject_once`; loader and native host pids | the spike's recorded runs ([`2026-10-31-copilot-acp-spike.md`](2026-10-31-copilot-acp-spike.md)) | 2026-10-31 |
