# Spike: driving Copilot CLI over ACP (#412, step 1)

**Date:** 2026-10-31
**Status:** Spike report for step 1 of
[`2026-10-31-driven-sessions-design.md`](2026-10-31-driven-sessions-design.md) (§11). Evidence
only; nothing here is built.
**Verdict: go for Copilot**, with the design changes listed at the end. Copilot's ACP server
takes a pushed `session/prompt` at any time with no polling, links cleanly by process ancestry,
and pre-allows the user's own `agent-inbox` registration. Five findings change the design: mode
ids, the `--mode` flag, a second escalation switch (`allow_all`), slash commands in prompt text,
and a second prompt interrupting the running turn.
**Fixtures:** [`test/fixtures/acp/copilot-1.0.105/`](../../../test/fixtures/acp/copilot-1.0.105/)
(15 recorded transcripts; their README gives the format).

## Setup

- **Agent:** GitHub Copilot CLI 1.0.105, npm install (`/opt/homebrew/bin/copilot` →
  `@github/copilot/npm-loader.js`), macOS arm64.
- **Client:** a throwaway Node-core ACP client (newline-delimited JSON-RPC over the child's stdio,
  `initialize` with `protocolVersion: 1`, no `fs` or `terminal` capabilities), recording every line
  in both directions.
- **Isolation:** every session ran in a scratch git repository, with `COPILOT_HOME` pointed at a
  scratch folder. The keychain login still worked there. The scratch `mcp-config.json` registered
  `agent-inbox` from a worktree build with `AGENT_INBOX_DB` set to a scratch hub. No real hub,
  Copilot config or repository was touched.
- **Child env:** the parent environment minus `COPILOT_*`, `AGENT_INBOX_*`, `ELECTRON_*` and
  `NODE_OPTIONS`, plus `COPILOT_AUTO_UPDATE=false`. Scenario 7 used a login-shell capture instead.
- **Argv:** `copilot --acp --stdio --disable-builtin-mcps --model claude-haiku-4.5`, plus each
  scenario's `--allow-tool`/`--deny-tool`.

## 1. ACP basics

| Call | Result |
|---|---|
| `initialize` | `protocolVersion: 1`; `agentCapabilities: { loadSession: true, mcpCapabilities: { http, sse }, promptCapabilities: { image, embeddedContext }, sessionCapabilities: { close, list } }`; one auth method, `copilot-login` (terminal auth). **No `session/resume`.** |
| `session/new` | `sessionId`, `modes`, `models`, and `configOptions` with four selects: `mode`, `model`, `reasoning_effort` and **`allow_all`** (`on`/`off`, category `permissions`). The agent then sends `available_commands_update`. |
| `session/prompt` | Updates stream as `session/update` notifications. The response is `{ stopReason, usage: { inputTokens, outputTokens, totalTokens, thoughtTokens, cachedReadTokens, cachedWriteTokens } }`. |
| End of turn | `stopReason: "end_turn"`, including after a Deny (below); `"cancelled"` after `session/cancel` or an interrupting prompt. |
| `session/cancel` | The open prompt returns `cancelled` 5–7 ms later. No update arrived in the 3 s after it. |
| `session/close`, `session/list` | Both work. `list` returns `{ sessionId, cwd, title, updatedAt }` per persisted session. |
| stdin close | The child exits with code 0 within 0.49–1.25 s (fifteen runs), and its MCP servers exit with it. |

**Update kinds seen:** `available_commands_update`, `session_info_update` (the title),
`usage_update` (`{ used, size }`, context tokens), `agent_thought_chunk`, `agent_message_chunk`,
`user_message_chunk` (load replay only), `tool_call`, `tool_call_update`, `current_mode_update`
and `config_option_update`.

**`session/request_permission`** (shell, from `permissions-and-set-mode.jsonl`):

```json
{"jsonrpc":"2.0","id":0,"method":"session/request_permission","params":{"sessionId":"c405c12d-…","toolCall":{"toolCallId":"toolu_01Uu…","title":"Run the requested echo command","kind":"execute","status":"pending","rawInput":{"command":"echo acp-perm-probe","commands":["echo acp-perm-probe"]}},"options":[{"optionId":"allow_once","kind":"allow_once","name":"Allow once"},{"optionId":"allow_always","kind":"allow_always","name":"Always allow"},{"optionId":"reject_once","kind":"reject_once","name":"Deny"}]}}
```

- **Every request had the same three options,** and each `optionId` equals its `kind`:
  `allow_once`, `allow_always`, `reject_once`. There was no `reject_always`, and no option ever
  named bypass, autopilot or allow-all. This held for every tool kind seen: `execute` (shell),
  `edit` (create file), `fetch` (URL) and `other` (an MCP tool).
- **An MCP tool's permission title is the bare tool name** (`"whoami"`), while its `tool_call`
  update says `agent-inbox-whoami`. Ask titles should use the `tool_call` title.
- **Deny ends the turn.** After `reject_once` the agent prints `Info: Operation cancelled by
  user` and the turn ends `end_turn`; it does not try another way.

## 2. A pushed turn while idle

The client simply sends `session/prompt` again. Nothing polls, and no update arrives while idle.

| Idle before the push | First update | First agent text | Turn done | Recording |
|---|---|---|---|---|
| 0 s (first prompt) | 1 ms | 1.19 s | 1.24 s | `prompt-idle-push-midturn-cancel.jsonl` |
| 30 s | 32 ms | 1.38 s | 1.39 s | same |
| 10 min | 31 ms | 3.08 s | 3.11 s | `push-after-long-idle.jsonl` (0 updates during the idle) |

The first update is Copilot's own `usage_update`, so the server sees the push at once. The rest
is model latency (claude-haiku-4.5).

## 3. A second prompt during a turn: it interrupts

Prompt A ("count to 40") was streaming when prompt B arrived (`prompt-idle-push-midturn-cancel.jsonl`, t in ms):

```
34003 c2a session/prompt id 5 (A: count to 40, then DONE-A)
35066 c2a session/prompt id 6 (B: reply SECOND-B)
35066 a2c agent_message_chunk "\n3\n4"   ← A's text, after B was sent
35066 a2c agent_message_chunk "\n5\n6"
35078 a2c id 5 result { stopReason: "cancelled" }   ← A ends 12 ms after B
36046 a2c agent_thought_chunk "The user is asking me to: 1. Count … 2. Reply with … SECOND-B"
37106 a2c agent_message_chunk "\n\nSECOND-B"
37141 a2c id 6 result { stopReason: "end_turn" }
```

- **Not queued and not rejected:** the running turn is cancelled, and B starts at once.
- **The interrupted request stays in the conversation.** B's turn did both: it counted 1–40, wrote
  DONE-A, then SECOND-B. After an explicit `session/cancel` the same happens: the next prompt
  ("pong") first finished the cancelled count to 300.
- **A's chunks can arrive after B was sent** but before A's response, so attributing updates by
  "the latest prompt" mislabels them.
- **A prompt sent while a permission request is unanswered** behaves the same way. A ended
  `cancelled` 5 ms after B was sent, B ran normally, and the late `cancelled` answer to A's request
  was accepted silently (`mcp-and-url-permissions-and-prompt-during-approval.jsonl`).
- **`session/cancel` while a permission request is unanswered** ends the prompt `cancelled` in
  7 ms, before the client answers the request (`cancel-during-approval.jsonl`).

So the design's copy holds: the driver must queue messages itself, and "Queued — it's mid-task"
is right. **Interrupt and send** needs no extra mechanism. The driver should still send
`session/cancel`, wait for the `cancelled` response, answer open requests `cancelled`, and only
then prompt, so the event log attributes every update to the right turn.

## 4. Modes, plan exit and load

**Mode ids are URLs.** They are not `interactive`/`plan`/`autopilot`:

| Mode | `modeId` | `allow_all` while in it |
|---|---|---|
| Agent (the CLI's "interactive") | `https://agentclientprotocol.com/protocol/session-modes#agent` | off |
| Plan | `…/session-modes#plan` | off |
| Autopilot | `…/session-modes#autopilot` | **on** ("enables allow-all") |

`session/set_mode` with `"interactive"` fails with `-32602 Invalid mode 'interactive'. Supported
values: …#agent, …#plan, …#autopilot.`

- **The driver can set and verify a mode.** `session/set_mode` returns `{}`, followed by a
  `current_mode_update` and a `config_option_update` holding all four config values. Switching to
  autopilot turns `allow_all` on; leaving autopilot turns it off.
- **`--mode plan` at server start is ignored by ACP.** With `--acp --stdio --mode plan --deny-tool
  write`, `session/new` returned `currentModeId …#agent` (`mode-flag-ignored-and-load-replay.jsonl`).
  The mode has to be set with `session/set_mode` after `session/new`.
- **`allow_all` is a second, independent switch.** `session/set_config_option { configId:
  "allow_all", value: "off" }` worked while in autopilot (mode stayed autopilot, allow-all off), so
  checking `currentModeId` alone does not prove "no allow-all".
- **Slash commands change both** (§4.1 below).
- **Plan exit cannot escape to autopilot,** because Copilot's ACP plan mode has no exit tool. Asked
  to "call your exit_plan_mode tool", the agent wrote `plan.md` into its own session-state folder
  (under `COPILOT_HOME`, with no permission request) and replied that "no exit_plan_mode tool"
  exists. No permission request was raised and no mode changed. Leaving plan mode is therefore
  always a client `session/set_mode`: the driver itself must switch "Plan first" to agent once
  the human approves the plan.
- **`session/load` restores the last mode, autopilot and allow-all included.** A session left in
  autopilot (with allow-all switched off by `set_config_option`) loaded in a new process as
  `currentModeId …#autopilot` with `allow_all: on` (`load-restores-autopilot.jsonl`). Re-asserting
  `…#agent` with `set_mode` brought both back (`agent`, `off`).
- **Load replays history before it answers.** Before the `session/load` response, the agent sends
  `user_message_chunk`, `tool_call`, `agent_message_chunk` and every past `current_mode_update`
  (plan, autopilot, agent), all within 1 ms. These are history, not live changes.
- **A session never prompted is not persisted.** Its `session/load` returns `-32002 Resource not
  found: Session … not found`.

## 4.1 Slash commands in prompt text

A prompt whose text is a slash command runs the command, without the model, over ACP. The
advertised commands include `allow-all`, `autopilot`, `plan`, `permissions`, `reset-allowed-tools`,
`sandbox`, `add-dir`, `model` and `mcp` (`slash-commands-change-permissions.jsonl`):

| Prompt text | Effect | Reported by |
|---|---|---|
| `/allow-all` | "All permissions are now enabled." | `config_option_update` (`allow_all: on`) |
| `/autopilot` | "Switched to autopilot mode." | `current_mode_update` |
| `/plan` | plan mode | `current_mode_update`, `config_option_update` |
| `/allow-all off` | "All permissions have been disabled." | **nothing** |
| ` /allow-all` (leading space) | allow-all on | `config_option_update` |
| `The human sent you 1 message via Agent Inbox.\n\n[m-1] /allow-all` | none: the model answered it as text | — |

So a human message, or the first prompt, that starts with `/` (after leading whitespace) is a
permission escalation. Every escalation here was reported, but de-escalation was not always
reported, so the agent's updates are not a complete record of its state. The design's framed
injected turn (§5.3) is safe as written.

## 5. The Agent Inbox MCP inside a driven session

(`registered-mcp-preallowed-and-client-mcp-rejected.jsonl`)

- **The registered `agent-inbox` server loads in ACP sessions.** It is read from
  `$COPILOT_HOME/mcp-config.json` and started during `session/new`, before any prompt; its presence
  row existed before the first prompt was sent.
- **`--allow-tool agent-inbox` pre-allows every tool of that server.** `whoami`, `pending` and
  `flag` ran with no permission request (the flag landed in the scratch hub). Without the flag,
  each MCP call asks (`kind: "other"`).
- **Client-supplied stdio servers are rejected.** `session/new` with `mcpServers: [{ name, command,
  args, env }]` returns no error, but the server never starts and its tools "do not exist". The
  only trace is Copilot's own log: `[rust:acp::mcp_servers] Rejecting non-http/sse MCP server
  "scratch-inbox" from client`. This matches `mcpCapabilities: { http, sse }` and confirms §3.2's
  choice of the user's own registration. It also means a per-session scratch hub is impossible
  through ACP; tests need a scratch `COPILOT_HOME`.
- **MCP servers inherit Copilot's whole environment,** with the registration's `env` on top. A
  probe server registered without `env` saw a marker variable from the driver's env, and saw
  `AGENT_INBOX_DB` from the driver's env (the registration's own `env` won where it set one). The
  user's real registration sets no `env`, so **the hub a driven session writes to is whatever
  `AGENT_INBOX_DB` the copilot child inherits.**
- **`--deny-tool write`** denied a file create with no request (`Permission to run this tool was
  denied due to the following rules: \`write\``).
- **`--allow-tool 'write(<dir>/**)'`** approved a create and an edit inside `<dir>` with no request
  (`write-glob-preallowed.jsonl`). A write outside `<dir>` was not tested.

### Process ancestry (raw `ps -o pid,ppid,comm,command`, paths shortened)

Driven session, during a prompt (`captured-env-npm-test-and-ssh.jsonl`):

```
  PID  PPID COMM             COMMAND
74776 74771 node             node s7-env.mjs                          ← the driver (spike client)
74861 74776 node             node /opt/homebrew/bin/copilot --acp --stdio …   ← spawned child: npm loader
74862 74861 /opt/homebrew/li …/@github/copilot-darwin-arm64/copilot --acp --stdio …   ← native host
74893 74862 <HOME>/…         <HOME>/.local/share/fnm/…/bin/node …/dist/mcp-server.js   ← agent-inbox
74894 74862 <HOME>/…         …/bin/node …/probe-mcp.mjs
```

The scratch hub's presence row for that session reads `host_pid 74862, server_pid 74893`.

Nested CLI started by the driven agent's shell tool (`nested-cli.jsonl`; the script ran `exec
copilot -p … --allow-tool agent-inbox`):

```
76679 76658 node             node /opt/homebrew/bin/copilot --acp --stdio …   ← driver's child (loader)
76681 76679 …/copilot-darwin-arm64/copilot --acp --stdio …                     ← driven host
76734 76681 …/node …/dist/mcp-server.js            hub row: host_pid 76681, server_pid 76734
76815 76681 node             node /opt/homebrew/bin/copilot -p …               ← nested loader
76817 76815 …/copilot-darwin-arm64/copilot -p …                                ← nested host
(76850)                                            hub row: host_pid 76817, server_pid 76850
```

- **`host_pid` is the native binary, not the process the driver spawned.** The npm loader
  (`#!/usr/bin/env node`) stays alive as the driver's child and starts
  `@github/copilot-darwin-arm64/copilot` as its own child. Every MCP server is a direct child of
  that native process.
- **§14.3's `comm` question.** On macOS, `ps -o comm=` prints `node` for the loader and the full
  executable path for the native host
  (`/opt/homebrew/lib/node_modules/@github/copilot/node_modules/@github/copilot-darwin-arm64/copilot`;
  `ucomm` is `copilot`). When `comm` is not the last column, `ps` cuts it to 16 characters
  (`/opt/homebrew/li`), so match on the basename of a last-column `comm`, or on `command`. Both
  loader and host contain `copilot` in argv: the loader as `/opt/homebrew/bin/copilot`, the host as
  `@github/copilot-darwin-arm64/copilot`.
- **Rule 4 as written fails for the driven server itself.** The walk "up from `host_pid`" starts
  at 76681, an agent host that is not the driver's child (76679). With the rule changed as below,
  the driven row links (76681's parent is 76679) and the nested row does not (76817 → 76815 → 76681,
  another host, before 76679).
- **Copilot also starts short-lived `git` and `gh` children** under the native host. They are not
  agent hosts.

## 6. Environment

**Login-shell capture** (`$SHELL -i -l -c`, a random start and end marker around `/usr/bin/env -0`,
stdin closed, a 10 s timeout). It started from a Finder-like env: `HOME`, `USER`, `LOGNAME`,
`SHELL`, `TMPDIR`, `SSH_AUTH_SOCK`, `LANG` and `PATH=/usr/bin:/bin:/usr/sbin:/sbin`.

| Case | Flags | Result |
|---|---|---|
| Real profile (fnm in `.zprofile`, Homebrew in both) | `-i -l -c` | ok in 1.9 s, 28 vars, fnm on PATH |
| same | `-l -c` | ok in 0.26 s, fnm on PATH |
| nvm-style `.zshrc` (scratch `ZDOTDIR`, rc prints a banner) | `-i -l -c` | ok, `NVM_DIR` set and its bin on PATH; the banner sat before the start marker and was ignored |
| same | `-l -c` | **not** on PATH, as §8 predicts |

nvm itself is not installed on this Mac (Shariq uses fnm). The `.zshrc` case used a stub `nvm.sh`
that prepends a version's `bin`, as `nvm use` does. It proves the zsh start-up rule the design
relies on, not nvm itself.

**A driven session on that capture** (`captured-env-npm-test-and-ssh.jsonl`; denylist applied,
`--allow-tool 'shell(npm:*)' 'shell(ssh:*)' 'shell(git:*)'`):

| Command in the session | Result |
|---|---|
| `npm test` | exit 0, `trivial test ok v26.12.1` |
| `which node` | `/opt/homebrew/bin/node` (asked once: `--allow-tool 'shell(which)'` matches only the bare command; `shell(which:*)` would have matched) |
| `ssh -o BatchMode=yes -T git@github.com` | exit 1, `Hi shariqh! You've successfully authenticated…` (the agent socket works) |
| `git ls-remote git@github.com:shariqh/agent-inbox.git HEAD` | exit 0, a SHA |

- **No push was made.** No throwaway SSH remote existed: localhost sshd refuses the key, and
  adding an `authorized_keys` entry was out of bounds. `ls-remote` uses the same SSH transport and
  agent as a push.
- **The capture is faithful to a login shell, and so is its Node version.** `.zshrc` re-runs
  `brew shellenv` after `.zprofile`'s fnm, so `node` is Homebrew's v26 even in a folder whose
  `.node-version` says 24 (`fnm current` there: v24.18.0). fnm's `--use-on-cd` hook never fires
  in the agent's shells. On this Mac, `npm test` in agent-inbox from a driven session would run
  the wrong Node.
- **The capture carried a secret.** `OP_SERVICE_ACCOUNT_TOKEN` is exported by an rc file, and
  the agent and every MCP server inherit it. A terminal session has the same exposure; §8 should
  say so.
- **The loader's shebang** (`#!/usr/bin/env node`) runs on the first `node` on the captured PATH,
  here Homebrew's v26. The native binary does not care.

## 7. Cost and auth

- **Auth:** the Copilot keychain login, which also worked with a scratch `COPILOT_HOME`. No token
  was put in the env.
- **Model:** every scenario used `--model claude-haiku-4.5` (0.33× premium requests per turn).
- **Spend:** 23 model turns (two of them interrupted), about 8 premium requests, plus one nested
  `copilot -p` turn. Seven slash-command prompts used no model.
- **Usage data:** `PromptResponse.usage` gives tokens per turn and `usage_update` gives context
  use. Neither carries premium requests or cost, so "premium requests not tracked" stands.

## §11 checklist

| §11 item | Answer |
|---|---|
| Option ids per host | Copilot: `allow_once`, `allow_always`, `reject_once`, id = kind, stable across shell, edit, fetch and MCP. Claude: deferred (#421). |
| Copilot's plan exit | No exit tool in ACP plan mode, so no escape to autopilot. Leaving plan is the client's `set_mode`. |
| `currentModeId` / `current_mode_update` on new, load, resume | new: always `#agent` (`--mode` ignored). load: the last mode, autopilot and allow-all included, after a history replay. resume: not offered. |
| `--allow-tool <name>` with the registered name | Works: `--allow-tool agent-inbox` pre-allows the server's tools. |
| `allowedTools: ['mcp__<name>__*']` | Claude only, deferred (#421). |
| nvm from `.zshrc` via `-i -l -c` | Captured with `-i`, missed without (stub nvm, real zsh); fnm from `.zprofile` captured either way. |
| `loadSession` | `true`; works for prompted sessions; history replay first. |
| Child exit on stdin close | Exit 0 in 0.49–1.25 s (fifteen runs); MCP servers exit too. |
| Ancestry: whose child is the MCP server | The native `copilot` binary, a child of the npm loader the driver spawned (§5). |
| `npm test` and SSH `git push` under the env rules | `npm test` ok; SSH auth and `git ls-remote` ok; push not run (§6). |
| Adapter options and `total_cost_usd` | Claude only, deferred (#421). |

## Design changes needed

1. **§3.2, §4.1 — mode ids and the `--mode` flag.** Use the URL mode ids (`…/session-modes#agent`,
   `#plan`, `#autopilot`); the table's Copilot column becomes `#agent` where it says interactive.
   Drop `[--mode M]` from the argv: ACP ignores it. Set the mode with `session/set_mode` right after
   `session/new` and verify the response's `current_mode_update`. Allowed sets: {`#agent`} for Ask,
   Read-only and Edits; {`#plan`, `#agent`} for Plan first.
2. **§4.1 — guard `allow_all` too.** The escalation guard must treat `config_option_update` with
   `allow_all: "on"`, as well as an out-of-set `current_mode_update`, as `error:mode_escalation`.
   It must check `configOptions.allow_all === "off"` beside `currentModeId` on new and load. Rule 4
   ("never calls `session/set_mode` except to re-assert") gains `session/set_config_option
   allow_all=off` as the only other permitted call. Add `allow_all` to the never-offered list.
3. **§4.1, §5.3 — slash commands.** The driver never sends a prompt whose first text block, after
   trimming whitespace, starts with `/`. Pushed messages are already framed (§5.3); the first
   prompt (step 2's `--prompt-file`, step 3's dialog) and answer pings must be framed the same way,
   or refused. A fake-agent test should send `/allow-all` and expect the guard to end the launch.
   Not every state change is reported (`/allow-all off` sent nothing), so updates are not a
   complete record of state.
4. **§4.1 Plan first — who leaves plan mode.** Copilot has no plan-exit request over ACP. "Plan
   first" needs a driver-side step: when the agent's turn ends in plan mode, file an ask ("Approve
   the plan and continue?") whose approval makes the driver `set_mode #agent` and prompt "Proceed
   with the plan". The guard's set stays {plan, agent}. Otherwise drop Plan first for Copilot in
   step 2.
5. **§4.1 — the option allow-list for Copilot.** The table is {`allow_once`, `reject_once`,
   `allow_always`}, matched by id and kind. Decide whether `allow_always` survives. It is a
   session-wide rule for that command or tool, and the shell case makes it the broad grant §4.1
   warns about. The recommendation is to offer it only for `other` (MCP) and `fetch`, and to drop
   it for `execute` and `edit` in step 2. Note in the ask copy that **Deny ends the agent's turn**,
   not just that action.
6. **§3.1, §5.3 — a second prompt interrupts.** Say that ACP v1 on Copilot cancels the running turn
   when a new `session/prompt` arrives, and that the cancelled request stays in the conversation.
   Interrupt and send is: `session/cancel`, await the `cancelled` response, answer open permission
   requests `cancelled` and resolve their `@sessions` asks ("Interrupted"), then prompt. Attribute
   updates to a turn by the request in flight, not the latest one sent: the old turn's chunks can
   arrive after the new prompt. The injected text should say the previous turn was interrupted,
   since the agent may otherwise resume it.
7. **§5.1 rule 4 — the host is the loader's child.** Record two pids for the launch: the spawned
   child (the npm loader, `comm` `node`) and its native child, the host, whose argv contains
   `@github/copilot` and whose `comm` basename is `copilot`. Rule 4 becomes: `host_pid` is the
   launch's host pid, or the walk from `host_pid`'s parent reaches the launch's child or host
   before any other agent host. An agent host is a process whose last-column `comm` basename is
   `copilot`, `claude` or `claude-agent-acp`, or whose `command` matches `@github/copilot`. This
   settles §14.3's first item for npm installs. A standalone (non-npm) Copilot was not tested.
8. **§3.2, §8 — the MCP server's hub follows the child's env.** The user's registration usually
   sets no `env`, so the agent-inbox server uses the `AGENT_INBOX_DB` the copilot child inherits.
   The denylist must not drop the driver's own hub path. Set `AGENT_INBOX_DB` in the child env to
   the exact hub the driver reads (or leave it unset only when the driver uses the default).
   Otherwise linking never succeeds. Also strip `COPILOT_*` variables inherited from a parent
   Copilot session (`COPILOT_AGENT_SESSION_ID`, `COPILOT_LOADER_PID`,
   `COPILOT_CLI_RESOLVED_DIST_DIR`, …). Keep only the deliberate ones (`COPILOT_HOME`,
   `COPILOT_GITHUB_TOKEN`). A driver run from inside a Copilot session inherits them, and their
   effect on the child was not tested.
9. **§3.2 — client `mcpServers` are rejected.** State that Copilot accepts only http/sse servers
   from the client and silently ignores stdio ones (logged, not returned as an error). The driver
   passes `mcpServers: []`. Tests isolate the hub through a scratch `COPILOT_HOME` whose
   `mcp-config.json` registers `agent-inbox` with a scratch `AGENT_INBOX_DB`.
10. **§3.1, §5.3 (step 3), §7 — load, not resume.** Copilot advertises `loadSession` only, so
    `session/resume` is not available. `session/load` replays history (mode updates included)
    before it responds. The guard ignores updates for the loading session until the response, then
    verifies `currentModeId` and `allow_all` and re-asserts with `set_mode` (and `set_config_option`).
    A session that was never prompted cannot be loaded, so a launch parked before its first turn
    must start fresh.
11. **§8 — environment capture.** Run the capture with cwd set to the launch folder, so per-folder
    version managers (fnm `--use-on-cd`, nvm auto-use, mise) choose that folder's version; their cd
    hooks never fire later. Say plainly that PATH order is the user's: on this Mac `node` stays
    Homebrew's v26 even then. Note that rc files can export secrets (`OP_SERVICE_ACCOUNT_TOKEN`
    here), which the agent and its MCP servers inherit exactly as in a terminal. Consider passing
    `--secret-env-vars` for secret-shaped names; it strips them from shell and MCP envs and redacts
    output, but would also hide them from an MCP server that needs one.
12. **§3.6, §4.2 — ask titles and context.** Use the `tool_call` update's title
    (`agent-inbox-whoami`), not the permission request's (`whoami`). For `edit`, `rawInput` holds a
    full diff, which the 4 KB cap needs.
13. **§11 step 2 tests.** Add fake-agent cases for: the `allow_all` update; a `/allow-all` first
    prompt refused; a mid-turn prompt cancelling the running turn; a load replay containing an
    autopilot `current_mode_update`; the loader/host pid split.

## Not tested

- An actual `git push` over SSH (§6).
- A write outside the `write(<dir>/**)` folder.
- Whether `allow_always` persists beyond the session (in `COPILOT_HOME`).
- A standalone or Homebrew-cask Copilot (not npm).
- Other models' plan-mode tool sets. The tool list is the CLI's, so the absence of an exit tool
  should not depend on the model.
- Effects of an inherited parent-Copilot `COPILOT_*` env; every spike run stripped them.
- Claude (`claude-agent-acp`): deferred to #421.
