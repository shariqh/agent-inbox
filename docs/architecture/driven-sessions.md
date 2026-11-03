---
paths:
  - "src/driver.ts"
  - "src/driver-cli.ts"
  - "src/driver-link.ts"
  - "src/driver-policy.ts"
  - "src/driver-tty.ts"
  - "src/driver-pin.ts"
  - "src/acp-client.ts"
  - "src/driver-launch.ts"
  - "src/launch-spec.ts"
  - "src/launch-sign.ts"
  - "electron/session-launch.cjs"
  - "electron/launch-key.cjs"
  - "electron/shell-env.cjs"
  - "electron/driver-process.cjs"
  - "electron/launch-controller.cjs"
  - "electron/launch-ipc.cjs"
applyTo: "src/driver.ts,src/driver-cli.ts,src/driver-link.ts,src/driver-policy.ts,src/driver-tty.ts,src/driver-pin.ts,src/acp-client.ts,src/driver-launch.ts,src/launch-spec.ts,src/launch-sign.ts,electron/session-launch.cjs,electron/launch-key.cjs,electron/shell-env.cjs,electron/driver-process.cjs,electron/launch-controller.cjs,electron/launch-ipc.cjs"
---

# Driven sessions (#412)

`agent-inbox-driver`: a session Agent Inbox starts and drives over ACP, so the human's messages and
answers arrive as pushed turns. Design:
[`docs/superpowers/specs/2026-10-31-driven-sessions-design.md`](../superpowers/specs/2026-10-31-driven-sessions-design.md);
spike: [`2026-10-31-copilot-acp-spike.md`](../superpowers/specs/2026-10-31-copilot-acp-spike.md).

Claude Code and Copilot CLI load this file automatically when they read or edit a file matching the
`paths`/`applyTo` globs above; anyone else should read it before changing those files.

## In brief

- Step 2 (this build): `agent-inbox-driver copilot --cwd <dir> --mode ask|read-only --prompt-file <f>
  [--model <id>] [--reasoning-effort <level>]`, in the FOREGROUND, approvals on its own terminal;
  `stop <launch id>` writes the Stop lease. Copilot only (Claude is #421). No detach, Electron,
  worktree, transcript UI or resume.
- **Reasoning effort.** Copilot applies the user's own `~/.copilot/settings.json`, so an
  `effortLevel` there reaches a driven session. A model that takes no effort (for example
  `claude-haiku-4.5` in 1.0.105) then refuses `session/new`; the driver prints a hint, and
  `--reasoning-effort none` (passed through from Copilot's own list of levels only) fixes it.
- **The installed command.** Every runtime payload carries `dist/driver-cli.js` (a `bin` entry, so a
  manifest entrypoint). A human runs it from the installed runtime with that runtime's own Node:
  `~/.agent-inbox/runtime/<runtime id>/bin/node ~/.agent-inbox/runtime/<runtime id>/dist/driver-cli.js
  copilot …`. `install-agents.sh` prints that exact line at the end of an install whose runtime
  carries the driver; nothing puts it on PATH. From a checkout: `npm run driver -- copilot …`.
- The driver is a separate process and entry (`src/driver-cli.ts`). No driver module may enter the
  stdio MCP server's, the hooks', the watcher's or the viewer's import graph, and the driver binds no
  listener (`test/driver-cli.test.ts`). It reads and writes the hub only through `store.ts`.
- Step 3 (the Electron launch) is being built in parts. Part 1, on main: the `launches` and
  `launch_asks` tables, the read routes, and `driver-cli.js run <launch id> <hub db>`, the detached
  driver main will start. Nothing starts it yet, the page reads none of it, and a hub nobody launches
  from keeps an empty `launches` table (design §9).
- Nothing changes for anyone who never runs it: step 2 adds no table, column or trigger; step 3's
  tables stay empty and no other snapshot moves.

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
- **Setup deadline:** if setup has not reached ready within `setupDeadlineMs` (2 min), the driver
  gives up so a hung Copilot cannot hold a driver slot: a new launch ends with `error:setup`, and a
  resume ends with `error:load` and is parked again with its session and a `park_reason`, like any
  other failed load. A launch that reached ready is never ended by it.
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
  first prompt waits up to `linkWaitMs` (10 s) for a link, so alerts carry the session and pushes
  can start (design §14.5).
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
- **What the human reads is made visible** (`terminalSafe` in `driver-policy.ts`). A tool's title,
  command, kind and input, agent text and error messages are agent-controlled: ESC sequences could
  erase the real ask and print a fake one, OSC 52 could write the clipboard, and bidi or zero-width
  characters could reorder or hide text. C0 controls but `\n` (a tab becomes a space), DEL and C1
  become `\xNN`, and every Unicode format character (`\p{Cf}`: bidi marks, embeddings, overrides and
  isolates, zero-width characters, U+2060–U+2064, the Arabic letter mark U+061C, the BOM, tags) and
  the line and paragraph separators (U+2028, U+2029, which some renderers draw as line breaks) become
  `<U+XXXX>`. Main's `displaySafe` (`electron/launch-controller.cjs`) escapes exactly the same set, and
  a test compares the two over every code point.
  Every terminal write goes through `createTerminal` (`driver-tty.ts`), whose only raw bytes are the
  SGR reset (`ESC[0m`) before each ask; the `@sessions` alert's title and context are sanitized the
  same way. `test/driver-tty.test.ts` runs the terminal against a fake TTY that fails on any unsafe
  byte and pins the CLI's few direct writes.
- **The terminal** (`driver-tty.ts`): `y`/`n` answer the open approval (one at a time, in order);
  with none open, `interrupt` is Interrupt and send and `stop` is the Stop; anything else prints a
  one-line help (design §14.5). `installStopHandlers`: Ctrl-C, SIGHUP (the terminal closed), SIGTERM
  and the end of the terminal's input all run the ordered Stop. A second Ctrl-C, or a Stop that has
  not finished within 15 s, calls `Driver.forceStop()` before exiting: synchronous and idempotent, it
  answers open requests `cancelled`, resolves the asks "Session stopped." and releases the leases,
  so no alert stays as attention and no lease blocks a restart; and whether or not the driver had
  already finished, a child still running gets SIGTERM to its group, then the CLI's
  `reapProcessGroup` waits up to 2 s and sends SIGKILL.
- **A closed terminal never stops the cleanup.** Writing to a hung-up terminal fails with `EIO`,
  emitted as `'error'`; with no listener that throws and kills the driver before its Stop runs. The
  CLI listens for `'error'` on stdout, stderr and stdin and silences the terminal; the terminal
  writer also catches a throwing write and goes silent; SIGHUP silences it before the Stop and prints
  nothing; and no cleanup step depends on a write. `test/driver-pty.test.ts` proves it on a real
  pseudo-terminal (Python's `pty` module, a fake `copilot` on PATH, the master end closed while an
  approval is open): the alert is resolved and the lease released.
- **The child** (`driver-cli.ts`): `copilot` resolved on PATH to a real path owned by the user or
  root and not group/world-writable, or the driver refuses to start (design §14.5); spawned detached (its own process group, so the terminal's
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
- **Runtime pins** (`driver-pin.ts`, design §7). It runs from an installed runtime when the
  folder above its `dist/` holds a manifest naming that folder (pinned under that folder's parent,
  whatever root its own environment names), or when its file sits under the configured runtime
  root, where anything else refuses to start. It then writes
  `<runtime root>/.pins/<runtime id>/<launch id>` before it starts copilot: `{v: 1, launchId, pid,
  startedAt}`, 0600 in 0700 folders it owns (never through a symlink), by temp file and rename,
  retrying once if a sweep removed the empty folder under it. `startedAt` is its start identity
  from `scripts/runtime-pins.mjs` (`processIdentity`: `/proc/<pid>/stat` ticks and the boot id on
  Linux, `ps -o lstart=` on macOS), the one function the prunes compare it with, so a pin counts
  only while that very process runs. After pinning it checks its runtime's manifest is still
  there: a prune that moved the runtime aside first means the pin is removed and the driver
  refuses. If it cannot pin, it refuses to start. A `process.on('exit')` handler removes the pin
  on every exit path, forced or not; a SIGKILL leaves a stale pin, which never counts and which
  the next prune sweeps. A checkout, or an app bundle's payload (#435), pins nothing. The rules that read pins are in
  `setup-and-installers.md` ("Runtime pins").

## Step 3, part 1: storage and the detached `run` mode

- **The launch row** (`launches`, `store.ts`, design §6). The DRIVER writes it, from the fd-3 spec,
  after `claimDriverSlot` succeeds (`createLaunch`, status `running`), so a refused start leaves no
  row. It holds launch facts only (host, project, stream, cwd, mode, model, effort, budgets, prompt,
  spec version, status `running|parked|ended`, end reason) and the progress the driver reports
  (`recordLaunchProgress`: child pgid and start identity, native host pid, linked sessions, active
  time, tool calls). Nothing clock-derived: whether a running launch's driver is alive is
  `launchDriverAlive`, its fresh `driver:` lease. `/api/launches` (whole-table domain `launches`)
  serves `launchView`: no prompt, process ids or ACP session id; `GET /api/launches/:id` (fresh) adds
  `driver: running|lost|null`; `GET /api/launches/:id/prompt` serves the prompt per launch. Ended
  rows older than 30 days are pruned at `createLaunch`, with their log folders.
- **Stop** (`requestLaunchStop`) is idempotent and unpinned: `stop_requested_at` is set once
  (usage writes move `revision`); a parked launch has no driver, so it ends at once.
  `driverStopRequested` reads both step 2's lease and this column; `driver-cli.js stop <id>`
  writes both.
- **The spec** (`launch-spec.ts`) is versioned (`LAUNCH_SPEC_VERSION = 1`), at most 1 MiB, read
  from fd 3 to its end, and validated strictly: exact fields (any unknown one, such as an
  executable or argv, refuses), the launch id must equal argv's, `cwd` absolute, modes `ask`,
  `read-only` and `plan`, Copilot's own effort levels, bounded budgets (active time 1 min to 8 h,
  tool calls 1 to 2000), a 1 to 65536-character prompt, an env of name → string, and a 32-byte
  base64 launch key. A `resume` spec carries only the id, env and key: the facts come from the row.
  The driver reads fd 3 only after `fstat` shows a socket (Node's `'pipe'` stdio) or a real FIFO;
  anything else (no pipe passed, where Node's own kqueue holds fd 3 as a FIFO with no permission
  bits) refuses with exit 65 and the status line, without touching the descriptor. It closes fd 3 as
  soon as it has read it, before anything starts, so copilot and its tool shells never inherit the
  launch-key channel; main passes the spec over a pipe, never a file.
- **`run <launch id> <hub db>`** (`driver-cli.ts`): no TTY. It writes exactly one stdout line,
  `{"ok":true,"launch":<id>}` once the session is starting or `{"ok":false,"error":…}` (exit 65 for
  a bad spec, 75 at the driver cap, 1 otherwise), and everything else to the launch's logs and row.
  It pins its runtime like step 2, resolves `copilot` on the spec's PATH and, when that is a script,
  its `#!` interpreter on the same PATH with the same ownership checks (§8), requiring Node 22 or
  later for a `node` interpreter, and spawns `[interpreter, script, …copilotArgs]`. The child's env is
  the spec's env through `childEnv`, with `AGENT_INBOX_DB` set unless the hub is the spec's
  `$HOME/.agent-inbox/inbox.db`. SIGTERM or SIGHUP stops in order; a second signal forces.
- **Signed approvals** (`driver-launch.ts`, `launch-sign.ts`, §4.3). An app launch files each ask as
  an `approval` question in `@sessions` with its choices as options (`Allow once`/`Deny`, or
  `Approve the plan`/`Not yet`), and records in `launch_asks` (read by no snapshot) the launch, the
  response revision at filing and the option ids, in one transaction with the item
  (`fileLaunchAsk`). Main answers with `reply = <option id>` and `reply_context` = the hex
  HMAC-SHA256, under the launch key, of the length-prefixed parts
  `agent-inbox/launch-approval/v1 ‖ item ‖ filing revision ‖ option id`; the launch key is
  `HMAC-SHA256(masterKey, len ‖ 'agent-inbox/launch-key/v1' ‖ len ‖ launchId)` (§14.3). On a hub
  change the driver reads its asks' replies (`listLaunchAskReplies`) and queues only a verified one
  as an approval intent, behind every frame already read and re-validated like a TTY answer. Any
  other reply (the ordinary reply route, an older viewer, another key, another revision, item or
  option) is logged as `approval_refused` and ignored: the ask stays open and nothing is allowed or
  declined on its strength. `settleLaunchAsk` resolves the item and removes its mapping. So that a
  human never sees an answer recorded that nothing acts on, the viewer's ordinary reply and note
  routes refuse an item mapped in `launch_asks` (`isLaunchAsk`) with `200 {ok:false,
  reason:'launch_ask'}`, and the page says "Not sent — approve this from Agent Inbox's own window."
  and keeps any typed text. Resolve and Dismiss refuse it the same way, since a closed ask would
  strand its driver, and the page draws neither (nor the row's ✕) for an `@sessions` approval. As
  defence in depth, a mapped ask the driver finds closed or gone without a valid signed answer (an
  older viewer, a hand edit) is settled as a decline (`reject_once`, logged `ask_closed`; a plan ask
  stays in plan mode), never left waiting.
- **Park and minimal resume** (§7). In `run` mode, 2 h idle parks the launch (`parkLaunch`): the
  child is closed, the row keeps `acp_session` only when the task was sent (a never-prompted
  session cannot be loaded) and forgets the processes; a Stop that arrived meanwhile ends it
  instead. A `resume` spec claims the parked row (`resumeLaunch`, parked → running, once), loads the
  session (`session/load`, history ignored until it answers, then the mode and `allow_all` verified)
  without re-sending the task, or starts a fresh one and sends the stored task when there is none or
  the load answers `-32002` (never prompted, so never persisted). Any other load failure ends the
  driver with `error:load`, and the launch is parked again with its ACP session and a `park_reason`
  ("Copilot could not load the session: …", sanitized, at most 300 characters of Copilot's message)
  that the UI shows, so the human can retry; a later resume clears it.
  Budgets are per-launch totals: a resumed driver starts its counters from the row's `active_ms` and
  `tool_calls`, a launch that already used a budget ends (`budget:<which>`) before anything starts, and
  the store never moves usage backwards (`MAX` of stored and new). The row's earlier `sessions` prove "from" (§14.3): the new driver re-takes their `driven:` leases
  under the same launch id, so `readdressMessages` moves their open messages to the new server once
  it links, and `pushed.json` starts empty, so they are pushed again (§5.3).
- **Tests**: `test/launches.test.ts` (rows, Stop, liveness, pruning, asks, routes, §9 d),
  `test/launch-spec.test.ts` (the spec and the MAC against an independent implementation in
  `test/launch-fixtures.ts`), `test/driver.test.ts` (signed approvals, ordering, Plan first, the row,
  resume), `test/driver-run.test.ts` (`run` end to end against a fake `copilot`: status line, row,
  Stop, park, resume by load, a signed approval, refusals), `test/mixed-version.test.ts` (a v2.2.0
  viewer's reply never approves).

## Step 3, part 2: Electron main

Everything main does for a driven session is injected and tested without Electron
(`test/launch-electron.test.ts`); `main.cjs` only wires it.

- **The switch** (`session-launch.cjs`, §9): Settings → Agent sessions → "Start sessions from Agent
  Inbox", main-owned in userData `session-launch.json` (schema 1, `createLockedFile`, tolerant: a missing
  or corrupt file is off, a newer schema is off and never overwritten, unknown fields survive). Only the
  owned viewer (the `files` grant's window) may read or change it; main refuses to turn it off while any
  session it started runs, so Stop and Close stay reachable. While it is off, main captures no env,
  resolves no runtime, spawns nothing and does not touch safeStorage; the preload's `available()` says off.
- **The `launch` grant** (`createInstallBinding`, #216/#300): the fourth grant, the owned viewer with the
  switch on, on macOS, and no quit begun. Revoked by every main-frame navigation and re-granted only after
  the re-proof, like `files`; `refresh()` re-applies the grants to a still-bound window when the switch
  changes and never binds one that is not.
- **The IPC** (`launch-ipc.cjs`, `setup-preload.cjs` `agentInboxLaunch`): `available()`,
  `setEnabled(on)`, `start(request)`, `stop(id)`, `close(id)`, `resume(id)`, `approve({ item, revision,
  optionId })`, each with exact arity, answering only the viewer window's top frame, after any re-proof in
  flight. `takeOver` is step 5. The preload checks argument shapes and hands back checked answers.
- **What the renderer may send** (`launchRequest`, `approvalRequest` in `launch-controller.cjs`): exactly
  `{ root, mode, model?, reasoningEffort?, budgets, prompt }`, where `root` is one of the repository folders
  the hub recorded (`GET /api/launch-folders`) or `null` for main's own folder dialog; never a path of its
  own, an executable, argv or env. Bounds match the spec's.
- **The native confirmation** (`confirmation`): built by main from the checked facts (project, folder, mode
  and its plain copy, model and effort, budgets, the "once any shell command is allowed…" warning, and the
  task's first 300 characters, made visible by `displaySafe`). The project (which any agent can set
  through MCP `register`) and the folder go through `displayLine`: newlines too made visible, one line,
  at most 120 characters with an ellipsis, so they cannot add a fake folder or mode line; the bold
  message line is fixed text plus that project alone. Start spawns
  exactly what it showed. The login shell runs only after Start, so no rc file runs for a launch the human
  did not confirm. Resume and send needs no second confirmation (the click is the gesture, §7); main
  re-checks that the launch is parked, the grant and the switch.
- **The env capture** (`shell-env.cjs`, §8): `$SHELL -i -l -c` in the launch folder, stdin closed,
  detached, a 10 s bound (the group is killed on timeout), random markers around `/usr/bin/env -0`, only
  what lies between them read, names that are not variables dropped, kept in memory and sent only on fd 3.
  Main applies the driver's denylist too (`launchEnv`), and the driver applies it again. A timeout or a
  failure is reported once ("Try again"), never retried in a loop.
- **The key** (`launch-key.cjs`, §4.3, §14.3): a 32-byte master key in userData `launch-master-key`,
  only ever as safeStorage's ciphertext (0600, created once with a hard link so two processes agree), never
  in the renderer, SQLite, argv or a log. Each launch key is `HMAC-SHA256(master, frame('agent-inbox/
  launch-key/v1', launchId))`; an approval's MAC is the one `src/launch-sign.ts` verifies. No safeStorage
  encryption (or Linux's `basic_text`) means no launches; a key file that cannot be decrypted is never
  replaced, since running drivers hold keys derived from it.
- **The driver's start** (`driver-process.cjs`, §8, §10): exactly `[<runtime>/bin/node,
  <runtime>/dist/driver-cli.js, 'run', <launch id>, <hub db>]`, detached, no shell, `cwd: '/'`, stdin
  closed, stderr to `<hub dir>/launches/<id>/driver.log` (0600 in 0700), and the spec with the launch key
  written to a pipe (a socket pair) on fd 3, never a file. The runtime (`driverRuntime`,
  `setup-runner.cjs`) is the installed copy of this release's runtime first, re-verified against the
  signed digest with `dist/driver-cli.js` and `dist/launch-spec.js` required (`installedDriverRuntime`,
  #206); a checkout uses its own build. Setup installs that runtime only while it registers a host to
  this app, never over a checkout or custom registration, so a release app whose agents run from a
  checkout has none. **Then, on macOS only, this app's own payload (#435):** when the installed copy is
  not there at all (`not-found`), never when it is there and fails verification, main runs the payload
  inside the bundle (`bundledDriverRuntime`, the folder Setup runs its installers from:
  `runtimeSelection.path`), re-verified against the same signed digest with the same required files. It
  refuses a bundle under `/AppTranslocation/` (that mount goes when the app quits, and the driver with
  it), one whose real path is no longer the one startup resolved (moved, or a link), and one that
  fails verification; each refusal follows the not-installed copy, which names the checkout's own build
  (`npm run build`, then `npm run electron`) instead of Update agents, which Setup does not offer for
  checkout hosts. Never on Linux, where an AppImage's payload is a FUSE mount torn down at quit and a
  deb update replaces files in place. A driver run from the bundle pins nothing (`locateRuntime` calls
  it `checkout`: its manifest names a runtime id, not its `runtime/<platform>-<arch>` folder) and needs
  no pin, since no prune touches the bundle. It survives a macOS update, which renames the old app aside
  and deletes it an hour later, because the driver opens the hub at start, so its whole graph and its
  SQLite addon are loaded before any turn, and no driver module loads anything later (no `import(` or
  `require(`, pinned in `test/driver-cli.test.ts`); a late load would fail in a renamed bundle, or read
  another version's file from one replaced in place. `test/driver-run.test.ts` renames and deletes a
  payload copy mid-session. The controller resolves the runtime once before the confirmation, to refuse
  early, and again immediately before the spawn, which uses what that second check found. Main reads
  the driver's one status line and lets it run on. Any platform but macOS fails closed before spawning.
- **The hub, over the viewer's own routes.** Main cannot load the store in a development build, so in every
  build it reaches the hub as notification answers do, with the trusted Origin: `GET /api/launch-folders`,
  `GET /api/launches(/:id)`, `POST /api/launches/:id/stop`, `POST /api/launches/:id/close`
  (`closeLostLaunch` re-checks inside its `.immediate()` transaction that the driver lease is stale, then
  returns the child's process group and start only to its caller; main kills the group only while that
  process still has the recorded start), `GET /api/launch-asks/:id` and `POST /api/launch-asks/:id/answer`
  (exactly `{ revision, optionId, signature }`, the signature 64 lowercase hex characters, stored by
  `answerLaunchAsk`). None of them takes a path, argv or env, or starts anything. **A same-origin page could
  stop a session through them (low risk: the human's own capability), but it cannot forge an approval:**
  only main's signature counts, and the driver verifies it.
- **Quit** (§7): `beginAppQuit()` closes the launch gate (nothing starts once a quit has begun, even a
  start whose dialog was open: the gate is checked again after every await, before the login shell
  runs and immediately before the spawn) and drops the `launch` grant. With the switch on, the first
  quit asks once (`runningAtQuit`): it gives a start already past the gate up to 1.5 s to write its
  row (`settled()`), then always reads the running launches under their own 3 s bound, so a start
  still in progress (a dialog left open, a slow shell) never hides them; it lists the sessions whose
  driver runs: **Keep running** (the default) or **Stop all**. There is no Cancel,
  because the quit has already begun. An update restart does not ask; sessions survive it.

## Step 3, part 3: the page

Everything on the page lives in `public/launch-ui.js` (the drawer section, the dialogs, the lane tag and
Approve), `public/launches.js` (pure rules) and `public/launch-settings.js` (Settings → Agent sessions);
`app.js` only wires them. DOM coverage is `test/dom/driven-sessions.test.ts`.

- **Off is off (§9 b).** The page asks main once per load (`agentInboxLaunch.available()`) and again when
  Settings opens or the switch changes. In a browser, a viewer the app does not own, or with the switch
  off, `load()` makes exactly the reads it made before (no `/api/launch*`), no element is created and no
  listener is bound; the owned viewer draws only the Settings switch. `/api/launches` joins the tick only
  while the switch is on, as a conditional snapshot with its own validator and the messages fallback; its
  representation and `launchUi.version()` are in `frameInputs()` (#298).
- **The Live drawer's "Started from Agent Inbox" section** sits above the session list in its own
  container, painted by the ambient painter and updated in place (a row is rewritten only when its key
  changes, a focused control keeps its place). Each launch reads Starting…, Running (one of its sessions
  is in `/api/activity`), Not responding (running, no session, no update for 2 minutes: Close is offered),
  Stopping…, Parked (with the reason a resume failed, if any) or Ended (its reason in words). Stop, Close,
  New session… and Resume and send go to main through the bridge and appear only in the granted window;
  the transcript works wherever the section shows. The newest five ended launches stay listed.
- **New session** is a modal `<dialog>` outside the render tree: a project from
  `GET /api/launch-folders` or "Choose folder…" (`root: null`, main's own dialog), the agent fixed to
  Copilot, the three modes with their plain copy and the shell warning, an optional model and reasoning
  effort, budgets (default 2 h and 500 tool calls, bounds as main's), and the task with its no-secrets
  warning. `newSessionRequest` builds exactly the request main checks again; main's own confirmation is
  the one the human answers.
- **Drafts.** The dialog's task is a draft in `suspendState()` while the dialog is open (the dialog is
  modal, so the paused list is under it); a cancelled task is kept to fill the next dialog and holds
  nothing. A Resume and send text sits in the ambient drawer, which no draft pauses, so like a message
  composer's it only holds a viewer restart's reload (`launchUi.held()` in `shouldDeferBootReload`).
  Neither is written to browser storage.
- **Approve and Decline (§4.3).** In the granted window, an option chosen on an `@sessions` approval
  (pill, ★ or keyboard: all go through `sendReply`) goes to `agentInboxLaunch.approve({ item, revision,
  optionId })`, the option id read from `GET /api/launch-asks/:id` by its label; main signs it. The card
  draws only the ask's own options and the deferrals (no answer or context box, no Clarify or Decline),
  since main sends nothing else; an approval clears anything kept for the card, and text an earlier page
  kept for it goes to the unsent responses ("this approval takes only its own options"), never back into
  a hidden editor that would pause the list. Anywhere else the reply route's refusal shows "Not sent —
  approve this from Agent Inbox's own window."
- **The composer's delivery states (§5.3).** A driven session's row carries `driven_launch` and, while
  its driver's turn runs, `driven_turn { state, since }` (the driver's `driver-turn:` claim, written on a
  change only; `hook_watch_claims` is in no snapshot). `deliveryState(row, rel)` reads Arrives now, Queued
  mid-task (with how long) or Queued behind an approval. For a running launch the composer adds
  **Interrupt and send**, made only when it applies: the message is sent first, then
  `POST /api/launches/:id/interrupt` records a request the driver takes once on its next tick, cancels the
  turn and sends the queued messages with the interrupt notice.
- **Resume and send.** `resume(id)` (no second confirmation, §7), then the page polls `/api/activity` for
  up to 60 s for a driven session of that launch that receives messages, reads it in, and sends the text
  through the ordinary message path; otherwise the text stays with "The session didn't come back".
- **The transcript** is a `<dialog>` reading `GET /api/launches/:id/events?after=N` on its own 2 s timer
  only while open (whole lines, 256 KiB a read, `rotated` restarts it, at most 5000 events kept; `more`
  asks for the next read at once only when a read stopped at the cap, so an unfinished last line from a
  driver that died mid-write is re-read every 2 s, never in a loop). Agent
  text, tool calls, asks and answers are drawn as `textContent` lines only.
- **Lanes (#304).** A running launch's working session gets a "Started here" tag and, in the granted
  window, Stop. Nothing here reaches `public/attention.js`, a badge, a count, the rail or the dock.

## Step 3, part 4: Park now, Edits in the worktree, the Agents view

- **Park now (§7).** `POST /api/launches/:id/park` records a `driver-park:<launch>` request (running and
  not stopping only, like Interrupt and send; the human's own capability over a running launch, so no
  grant). The driver takes it once on its next tick (`takeLaunchPark`, logged `park_requested`) and parks
  at its next idle point, no turn running and no ask open, by ending with reason `park`, which
  `driver-cli.js run` handles exactly as `idle`: `parkLaunch` with the ACP session kept, exit 0. A turn
  that is waiting on an approval therefore parks once the approval is answered and the turn ends. The page
  offers **Park now** on a running launch in the granted window; the launch then offers Resume and send.
  `releaseDriverLeases` drops an untaken request with the driver.
- **Edits in the worktree (§4.1).** The fourth mode, `edits`, in the spec, the controller (its copy is the
  page's, a test holds the two equal) and the dialog. "The worktree" is the launch folder itself: no new
  git worktree is created (#432 tracks that). Copilot's argv gains `--allow-tool 'write(<folder>/**)'`
  and four `--deny-tool` patterns, `write(<folder>/.git)`, `write(<folder>/.git/**)`,
  `write(<folder>/**/.git)` and `write(<folder>/**/.git/**)`: a `.git` folder or file at the top or
  nested, and everything under one. Deny beats allow, so hooks, git config and a linked worktree's or
  submodule's `gitdir:` pointer file (which could point git at hooks of the agent's making) are never
  written unasked. Every other tool call asks, and the allowed mode set is `#agent` as for Ask for
  everything.
  `editsFolder` (`driver-policy.ts`) takes only the folder as the driver resolved it now (a resume whose
  folder resolves elsewhere does not start), absolute, not `/`, not the home folder or a folder above it
  (compared as written and as resolved), and with none of `( ) * ? [ ] { } , \` or a control character,
  which Copilot's patterns would read: such a folder is refused, never escaped. Checked against Copilot
  1.0.105 on 2026-11-02 with two real sessions (claude-haiku-4.5, effort none, scratch `COPILOT_HOME`
  and hub). In a plain repository: a file created inside the folder ran with no request, a file under its
  `.git` was refused by the deny rule, and a file outside the folder raised a permission request. In a
  linked worktree (its `.git` a file) holding a nested repository, with all four patterns: `notes.txt` ran
  with no request, an edit of the `.git` file was refused (`write(<folder>/.git)` matched; the file was
  unchanged), `sub/.git/x.txt` was refused (`write(<folder>/**/.git/**)` matched; nothing was created),
  and a file outside the folder raised a permission request. Repeated `--deny-tool` flags each count, and
  `**` matched the dot-folder `.git`. Reads are not limited by this mode.
- **The Agents view (#397).** A session line whose `/api/activity` row is `driven` gets a `driven` chip,
  and `started here` when it is a session of one of this app's launches (only with the switch on), drawn
  inside the project and branch column so the row's grid is unchanged.
- **Native notifications.** A new app launch's approval notifies like any ask but offers no buttons
  (`answerableByNotification` in `electron/reply-watch.cjs`): the hub refuses an ordinary reply to it, and
  only main's signed answer from the app's own window counts. A click opens its card, whose options main
  signs. A signing path from the notification itself would be a new approval surface and is not built.
