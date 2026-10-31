---
paths:
  - "src/driver.ts"
  - "src/driver-cli.ts"
  - "src/driver-link.ts"
  - "src/driver-policy.ts"
  - "src/acp-client.ts"
applyTo: "src/driver.ts,src/driver-cli.ts,src/driver-link.ts,src/driver-policy.ts,src/acp-client.ts"
---

# Driven sessions (#412)

`agent-inbox-driver`: a session Agent Inbox starts and drives over ACP, so the human's messages and
answers arrive as pushed turns. Design:
[`docs/superpowers/specs/2026-10-31-driven-sessions-design.md`](../superpowers/specs/2026-10-31-driven-sessions-design.md);
spike: [`2026-10-31-copilot-acp-spike.md`](../superpowers/specs/2026-10-31-copilot-acp-spike.md).

Claude Code and Copilot CLI load this file automatically when they read or edit a file matching the
`paths`/`applyTo` globs above; anyone else should read it before changing those files.

## In brief

- Step 2 (this build): `npm run driver -- copilot --cwd <dir> --mode ask|read-only --prompt-file <f>
  [--model <id>]`, in the FOREGROUND, approvals on its own terminal; `stop <launch id>` writes the
  Stop lease. Copilot only (Claude is #421). No detach, Electron, worktree, transcript UI or resume.
- The driver is a separate process and entry (`src/driver-cli.ts`). No driver module may enter the
  stdio MCP server's, the hooks', the watcher's or the viewer's import graph, and the driver binds no
  listener (`test/driver-cli.test.ts`). It reads and writes the hub only through `store.ts`.
- Nothing changes for anyone who never runs it: no table, column or trigger.

## Invariants in detail

- **One serialized state machine** (`src/driver.ts`, §4.1 Ordering). Every ACP frame read from the
  child and every human intent (a TTY answer, interrupt, stop), plus timer ticks and ancestry scans,
  goes through ONE queue drained on `setImmediate`, one event at a time in arrival order. An intent
  therefore lands behind every frame already read. `src/acp-client.ts` hands responses to the same
  queue as frames (no promises): a promise would resolve on a later microtask and let a response
  overtake an update read before it. Never add an `await` inside event handling.
- **The security state** is the current mode plus `allow_all`; its generation goes up on every
  `current_mode_update`, every `config_option_update` (even an unchanged one) and the driver's own
  `set_mode`/`set_config_option` results. Each ask records the generation; an approval answers
  `allow_once` only when the generation is unchanged and the state is valid for the phase. A moved
  generation answers `reject_once` ("Not applied: …"); an invalid state ends the launch
  (`error:mode_escalation`) with every open request answered `cancelled`.
- **Setup verifies before any prompt.** `session/new` (or step 3's `session/load`, whose replayed
  updates are ignored until it answers) → `session/set_mode` to the phase's mode (Copilot's URL ids;
  no `--mode` in the argv, ACP ignores it) → the result must show that mode. If `allow_all` is still
  on, the driver re-asserts it off ONCE with `session/set_config_option` and continues only when a
  `config_option_update` verifies off within `setupWaitMs`; otherwise the launch ends.
- **Phases** (`driver-policy.ts`): `executing` allows only `#agent`; Plan first starts in
  `awaiting_plan_approval` (only `#plan`), files "Approve the plan and continue?" when a turn ends in
  `#plan`, and on approval enters `switching`, sends exactly one `set_mode #agent`, accepts that one
  change, verifies `#agent` with `allow_all` off and sends the plan-approval control message. Step 2's
  CLI exposes only `ask` and `read-only`; step 3 adds the flag.
- **The option allow-list** (`filterOptions`): only `allow_once` and `reject_once`, matched by id AND
  kind. `allow_always`, bypass/auto options and unknown ids are dropped and logged. With no allow
  option left, the request is answered with the reject option (or `cancelled`) and no ask is filed.
- **Prompts are framed** (§4.1 rule 5, §5.3). Copilot runs a prompt whose first non-space character is
  `/` as a slash command (`/allow-all`, `/autopilot`), so every human text (the first prompt
  included) goes through `firstPrompt`/`messagesPrompt`, every driver-written prompt is a control
  message starting `Agent Inbox:` with agent text only inside quotes, and `sendPrompt` refuses
  anything `promptSafe` rejects.
- **One turn at a time** (§3.1). A second `session/prompt` mid-turn makes Copilot cancel the running
  turn, so messages queue. Interrupt and send (the terminal's `interrupt`) sends `session/cancel`,
  waits for the running prompt's own `cancelled` answer, answers open requests `cancelled`, resolves
  their asks "Interrupted", then sends the interrupt control message. Updates are attributed to the
  request in flight.
- **Approvals in step 2 are the terminal's** (§4.3). Each permission request files an alert in the
  reserved project `@sessions` (a `task` question, no options, under the driven agent's MCP
  `session`, stream `<project> · <branch>`, context with the tool kind, the input capped at 4 KB and
  "Declining stops the agent's current turn.") and prompts on the TTY. Only a TTY answer approves;
  the alert is resolved with the outcome. No inbox reply approves anything in step 2.
- **Linking by ancestry** (`driver-link.ts`, §5.1). One `ps -A -ww -o pid=,ppid=,lstart=,ucomm=,command=`
  every 2 s (argv only, captured, `LC_ALL=C`). The native host is the spawned child when its `ucomm`
  is `copilot`, else the loader's child that is an agent host. Rows come from
  `listHostSessions(db, nativeHost)` (rule 4, exact equality) and must have a live server whose
  parent is the host and which started at or after the child. A dead server counts as ended. The
  first prompt waits up to `linkWaitMs` for a link, so alerts carry the session.
- **Leases** (`store.ts`): `claimDriverSlot` (at most 2 drivers, counted from fresh `driver:` leases
  in one `.immediate()`; per-host caps come with #421), `holdDriverLeases` every 30 s and on every link
  change (exactly the linked sessions plus ended ones not yet re-addressed), `releaseDriverLeases` at
  the end. A lost `driver:` lease stops the driver.
- **Push once per launch** (§5.3). On a `PRAGMA data_version` change while idle, the driver re-reads
  the open messages of its live sessions (`listOpenMessagesWithText`) immediately before prompting,
  records the ids in `<hub dir>/drivers/<launch id>/pushed.json` (0600, temp file and rename) BEFORE
  sending, stamps them delivered by `agent-inbox-driver` and sends them as one turn. A pushed id is
  never pushed again, even while open; `pending()` still returns it until `ack_message`.
- **Answer pings** (`listAnsweredSessionAsks`): the session's own open questions and blocked rows of
  plans whose `boards.session` is the session, answered and not yet picked up, each pinged once per
  response revision with `Agent Inbox: The human answered '<title>'; call pending().` This is exactly
  the rule MCP uses to say `woken: "pushed"` for board writes.
- **Re-addressing** (§5.2) is the one exception to #411's "never re-addressed": an ended linked
  session's open messages move to the launch's newest live server through `readdressMessages`
  (conditioned in the store on both `driven:` leases carrying the launch id and `to` having the
  launch's host), and their pushed ids move in `pushed.json`.
- **Lifecycle** (§7). Budgets: active turn time (2 h), tool calls (500); 2 h idle ends the session (no
  park in step 2). Stop (Ctrl-C, `stop <launch id>`, or the end of any budget): open requests
  answered `cancelled`, asks resolved "Session stopped.", `session/cancel`, wait up to 10 s for the
  turn, close the child's stdin, SIGTERM its process group after 10 s more, release the leases. After
  30 s without a successful hub read the driver fails closed (`error:hub_unreachable`).
- **The child** (`driver-cli.ts`): `copilot` resolved on PATH to a real path owned by the user or
  root and not group/world-writable; spawned detached (its own process group, so the terminal's
  Ctrl-C reaches only the driver), argv only, `mcpServers: []`; its env is the terminal's through
  `childEnv` (no `ELECTRON_*`, `AGENT_INBOX_*`, `NODE_OPTIONS`, or `COPILOT_*` but `COPILOT_HOME` and
  `COPILOT_GITHUB_TOKEN`; then `AGENT_INBOX_HOOKS=0`, `COPILOT_AUTO_UPDATE=false`, and
  `AGENT_INBOX_DB` when the hub is not the default). Its stdout carries ACP only, its stderr goes to
  `<hub dir>/launches/<id>/copilot.stderr.log`, and the event log is
  `<hub dir>/launches/<id>/events.ndjson` (0600 in 0700, rotated at 20 MB). The `agent-inbox`
  registration must exist in `$COPILOT_HOME/mcp-config.json`, read without ever quoting the file.
- **Tests**: `test/driver.test.ts` drives the state machine against `test/acp-fake.ts`, a fake agent
  replaying the spike's recorded frames (`test/fixtures/acp/copilot-1.0.105/`);
  `test/driver-policy.test.ts` holds the pure rules and the recorded nested chain;
  `test/driver-cli.test.ts` the TTY refusal, the Stop lease and the graph pins.
