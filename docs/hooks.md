# The backstop hooks (issues #10 and #21)

Two deterministic, no-AI Claude Code hooks that close the two holes an
agent-driven inbox has by construction:

- **#10 — the forgotten flag.** A session is blocked at a permission prompt and
  the agent never called `flag`. Nothing reaches the inbox, and the human only
  finds out by looking at that terminal.
- **#21 — the idle-agent polling gap.** The human answers a question in the
  inbox, but the agent is sitting at the prompt and never calls `pending()`, so
  the answer stays at "waiting for pickup" forever.

Everything here is **opt-in**. Nothing runs from `npm install` or `npm run build`,
and the Electron app only moves hooks a Setup runtime already installed, when you ask
it to ([Moving hooks from Setup](#moving-hooks-from-setup)). One command installs it,
one removes it.

```sh
npm run install:hooks                     # dry run — prints what it WOULD write
npm run install:hooks -- --apply          # write it (timestamped backup first)
npm run install:hooks -- --apply --migrate    # also retire the legacy .sh Stop hooks
npm run install:hooks -- --apply --replace-existing  # replace another Agent Inbox install's hooks
npm run install:hooks -- --apply --uninstall  # remove this install's hooks
```

From a source checkout this installer uses `jq`. A portable release runtime instead
uses its bundled Node 24 plus `scripts/runtime-config.mjs`, so install, upgrade, and
uninstall work on a clean Mac with no ambient Node or `jq`. Hook and agent setup
source the same adjacent `scripts/setup-lock.sh`, so their mutating Bash process
owns one fd-9 kernel lease across the full transaction. Darwin prefers
descriptor-mode `/usr/bin/lockf` and falls back to same-domain `flock`; Linux uses
`flock` only. Packaged hook changes replace/remove only entries whose command and
entrypoint canonicalize to the same valid manifest-owned runtime directory under the
runtime root (or to the runtime's own folder, when it runs from outside the root),
plus, with `--replace-existing`, another Agent Inbox install's entries and ones that
can no longer run (see
[One set of hooks](#one-set-of-hooks-switching-between-a-setup-runtime-and-a-checkout)).

The dry run writes nothing anywhere: its Node selftest runs against a throwaway
database, so a preview never creates or migrates the hub. `--apply` writes
*through* a symlinked `~/.claude/settings.json` (a dotfiles checkout, say): the
timestamped backup, the staged copy and the rename all happen beside the link's
target, so the link survives and the target is what changes. A dangling link, or
a settings path that is not a regular file, is refused before anything is read or
written, and a read-only (or immutable) one before anything is staged. A blank
settings file reads as `{}`, in both checkout and packaged modes. Every write step
is checked: a failure exits non-zero, leaves the file unchanged and removes the
staged copy, and nothing reports success before the final rename lands.

## One set of hooks: switching between a Setup runtime and a checkout

Claude Code runs every hook entry in `~/.claude/settings.json`, so two installs'
sets would run each hook twice: two nudges and two answer watchers per turn
(issue #218). An install therefore never adds its set beside another Agent Inbox
install's. Both install modes sort every entry shaped like ours (`{command, args:
[entry, subcommand]}` with one of the subcommands below) by one rule, the same one
Setup's Agents panel uses to report Claude hooks:

- **a Setup runtime**: the command and entry both resolve into one verified runtime
  under `~/.agent-inbox/runtime/` (or `AGENT_INBOX_RUNTIME_ROOT`, when set);
- **a runtime outside that folder**: the command and entry both resolve into one
  runtime folder elsewhere that verifies against its manifest, for example one
  copied or extracted to `~/Downloads`, or installed while `AGENT_INBOX_RUNTIME_ROOT`
  named another folder. It is another Agent Inbox install, but not Setup's;
- **a source checkout**: the entry is `<checkout>/dist/hook-cli.js`, beside a
  `package.json` named `agent-inbox`;
- **an install that can no longer run**: a `…/dist/hook-cli.js` entry, or the Node
  it names, no longer exists (a moved or deleted checkout, an uninstalled Node).
  A path counts as gone only when the operating system cannot find it either;
- **unverifiable**: a `…/dist/hook-cli.js` that runs but cannot be verified, such
  as a runtime whose files changed, a runtime folder outside Setup's whose hooks
  run another Node, or a path that only resolves when a symlinked folder is
  followed before the `..` after it (`<symlinked folder>/../bin/node`);
- **anything else**, such as another tool's hook that only looks like ours, is
  never removed. A `<folder>/dist/hook-cli.js` whose folder holds a
  `runtime-manifest.json` never counts as another tool's: it is a runtime outside
  Setup's folder, or unverifiable.

When another install's hooks, or ones that can no longer run, are there, the
installer exits 1 and writes nothing; the dry run refuses the same way. The
message names them (a runtime by its version and folder, a checkout or a dead
install by its folder) and prints the recommended fix first: the one command that
replaces them all with this install's set. After it, as an alternative, it prints
each other install's own `--apply --uninstall`, but only when that command can
succeed as things stand. A runtime's uninstall refuses while hooks of a checkout
are there, so it is never offered then, and neither is the uninstall of a runtime
outside Setup's folder (see below).

**From a Setup runtime to a checkout**, run this from the checkout:

```sh
npm run install:hooks -- --apply --replace-existing
```

or, when no other Agent Inbox hooks are there, in two steps:

```sh
bash ~/.agent-inbox/runtime/<runtime-id>/scripts/install-hooks.sh --apply --uninstall
npm run install:hooks -- --apply
```

**From a checkout to a Setup runtime**, when the runtime is version 1.3.2 or later:

```sh
bash ~/.agent-inbox/runtime/<runtime-id>/scripts/install-hooks.sh --apply --replace-existing
```

A runtime's folder is named `agent-inbox-runtime-<version>-…`, for example
`agent-inbox-runtime-1.3.2-darwin-arm64-…`. Runtimes older than 1.3.2 do not know
`--replace-existing`: their installer exits 2 with `unknown flag`. With one of those
(or with any runtime, as an alternative), use two steps:

```sh
npm run install:hooks -- --apply --uninstall    # in the checkout
bash ~/.agent-inbox/runtime/<runtime-id>/scripts/install-hooks.sh --apply
```

If both sets are already there, the one-step command fixes it from the checkout's
side, or from a 1.3.2 or later runtime's. Moving between two checkouts works like the
first case. Moving between two Setup runtimes needs no flag: a runtime's installer
already replaces any Setup runtime's hooks.

**A runtime outside Setup's folder** (copied or extracted elsewhere, or installed
while `AGENT_INBOX_RUNTIME_ROOT` named another folder) is another install too. The
installer of a checkout, or of a runtime newer than 1.3.2, refuses beside its hooks,
naming it as `the v1.2.4 runtime at <folder>, outside Setup's runtime folder`, and
`--replace-existing` replaces them. Such a runtime's own installer, when newer than
1.3.2, also re-installs and removes its own hooks there as usual. Setup's Agents
panel reports these hooks as not verified, since it does not manage them.

Runtimes of 1.3.2 and older take those hooks for another tool's: their
`--replace-existing` leaves them in place and adds a second set, and their own
`--apply --uninstall` refuses them, so a refusal never offers it. To install the
hooks of a 1.3.2 or older runtime beside such a set, clear the set first, then run
the older runtime's `install-hooks.sh --apply`. Remove the set from `settings.json`
by hand, or replace it from a checkout and then remove the checkout's set:

```sh
npm run install:hooks -- --apply --replace-existing
npm run install:hooks -- --apply --uninstall
```

A newer Setup runtime's `install-hooks.sh --apply --replace-existing` clears it too;
the older runtime's `--apply` then replaces that set, as it does any Setup runtime's.

`--replace-existing` removes this install's own hooks, every other install's, and
every one that can no longer run, then installs exactly one set; without `--apply`
it prints that single set and writes nothing. It cannot be combined with
`--uninstall`. It never removes another tool's hook. Unverifiable entries are
refused with or without the flag, because they might be a working second set:
remove them by hand. When the cause is a runtime folder that does not verify, the
refusal also gives the verifier's reason, such as
`unmanifested file present in payload: .DS_Store` (macOS Finder adds those to
folders you open). Delete what was added, or reinstall that runtime, and run the
installer again; then nothing needs editing by hand. A checkout install never
refuses because of another tool's hook. A runtime's installer still refuses beside
one unless given the flag, which then leaves it in place.

`--force` and `--uninstall` keep their meaning: `--force` replaces only this
install's own hooks, and `--uninstall` removes only this install's hooks (from a
runtime, any Setup runtime's, plus its own folder's when that is outside the
runtime root). A runtime's uninstall still refuses while other hooks shaped like
ours are there; its message names them and gives their own installer's uninstall
command and the one-step `--replace-existing`.

## Moving hooks from Setup

After an app update, Setup's **Update agents** (or **Match agents to vX** after a
downgrade) also moves Claude's hooks when a Setup runtime installed them and that
runtime's version differs from the app's (issue #206). It runs the command Setup used
to show for a terminal, as a step of its own after Claude Code and Copilot CLI, with
one more flag:

```sh
bash ~/.agent-inbox/runtime/<this app's runtime-id>/scripts/install-hooks.sh --apply --move-only
```

`--move-only` makes the installer exit 1 and write nothing when no Setup runtime's
hooks are there to replace. It checks while it holds the setup lock, so Setup never
installs hooks afresh, even for a set you removed a moment before. Without `--apply`
it is a dry run of that move: it prints the settings the move would write, or exits 1
when there is nothing to move. Outside a packaged runtime the flag is refused, and
`--move-only` with `--uninstall` or `--force` is a usage error; both exit 2 before the
installer takes the setup lock or reads your settings.

It runs from the installed copy of the app's runtime, never from the app bundle, so the
hooks keep working after the app moves or updates. Setup checks that copy against the
app's signed runtime manifest first and runs nothing if it is missing or has changed.
The installer works as above: the shared setup lock, a timestamped backup, and only
Setup runtimes' hooks replaced. Setup never passes `--force` or `--replace-existing`,
and never offers the step for hooks from a checkout, custom hooks, or hooks it cannot
verify. If no agent needs moving, it offers the step once the app's runtime is
installed. Afterwards Setup reads `~/.claude/settings.json` again and says the hooks
moved only if they now run the app's runtime.

Where no Setup step can move them and the app's runtime is not installed (issue #278),
Setup promises to move them later only when it could install that runtime itself, for
an agent that is not registered or runs a Setup runtime. One known limit: Setup reads
only configuration files, so a host whose CLI is not installed also counts as not
registered, and with Claude Code on a custom or unverifiable registration and no
Copilot CLI it still makes that promise, although neither install can keep it (the
Copilot CLI one stops at `'copilot' CLI is not installed`, and the Claude Code one
refuses a registration it does not own); move the hooks from a checkout or a terminal
instead, with the commands below. When Claude Code runs from a source checkout, Setup
never switches it, so it shows that checkout's own command instead, to run in a
terminal with Node 24:

```sh
cd <checkout> && npm run install:hooks -- --apply --replace-existing
```

Otherwise it says it cannot move them, and the commands in
[One set of hooks](#one-set-of-hooks-switching-between-a-setup-runtime-and-a-checkout)
apply.

New Claude Code sessions read the new hooks when they start. Claude Code's
documentation says its settings file watcher normally applies hook changes to running
sessions too. Setup cannot see whether a session picked the change up, so restart a
session (exit it, then `claude --resume`) to be sure.

## Events → subcommands

One binary, `dist/hook-cli.js`, dispatches every event. `src/hook.ts` holds the
runtime; `src/hook-cli.ts` is the thin entry that owns stdin and the exit code.

| Claude Code event | subcommand | timeout | what it does | stdout |
|---|---|---|---|---|
| `Notification` (no matcher) | `notification` | 5s | arms the #10 backstop for this session — writes **nothing** yet | *(empty)* |
| *(internal, not an event)* | `notification-commit` | — | the deferred half: after the grace window, inserts the backstop item if the session is still stuck | *(empty)* |
| `SessionStart` (`startup\|resume`) | `session-start` | 5s | clears this session's backstop; nudges if an answer is unpicked | plain text |
| `SessionEnd` | `session-end` | 5s | clears this session's backstop | *(empty)* |
| `UserPromptSubmit` | `prompt-submit` | 10s | clears this session's backstop; nudges if an answer is unpicked | one JSON object |
| `Stop` | `stop` | 10s | clears this session's backstop; bounces the agent back to work if an answer is unpicked, or once per new message to this session | one JSON object |
| `Stop` (asyncRewake) | `watch` | 1800s | polls until the human answers one of this session's requests or messages it, then exits **2** to wake the model | *(empty; stderr carries the payload)* |
| *(manual/cron)* | `sweep` | — | runs the 24h janitor over orphaned backstop items | *(empty)* |
| *(installer only)* | `selftest` | — | proves the resolved Node can load `better-sqlite3`. The ONE subcommand allowed to exit non-zero on failure | one line |

### The stdout contract is exact

`notification`, `notification-commit`, `session-end`, `sweep` and `watch` emit
**zero bytes** on stdout. `prompt-submit` emits exactly:

```json
{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"…"},"suppressOutput":true}
```

`additionalContext` **must** be nested inside `hookSpecificOutput`. A top-level
copy is not silently ignored — the CLI detects it and prints
`Hook JSON output had unrecognized keys (ignored)` in the human's terminal, on
every nudge.

`stop` emits `{"decision":"block","reason":"…"}` — and never does so when the
incoming payload has `stop_hook_active: true`. That loop guard is
non-negotiable: blocking twice in a row traps the human in a session they
cannot exit.

`watch` writes its payload to **stderr** and exits 2, which is what
`asyncRewake` turns into a model wake-up. Any wrapper around the CLI must
therefore leave *both* streams alone — `hooks/agent-inbox-hook.sh` redirects
neither. It does **not** forward the status blindly, though; see below.

## The stdin payloads

Verified against `code.claude.com/docs/en/hooks` and
`code.claude.com/docs/en/hooks-guide` (fetched 2026-07-26). Every field is read
defensively — `parseEvent` returns `null` for anything that is not a JSON
object, drops wrong-typed fields rather than coercing them, and no field is
ever assumed present.

```jsonc
// Notification
{ "session_id": "…", "transcript_path": "…", "cwd": "…",
  "hook_event_name": "Notification", "notification_type": "permission_prompt",
  "message": "Claude needs your permission to use Bash" }
// Stop / SessionEnd / UserPromptSubmit / SessionStart carry session_id, cwd,
// hook_event_name plus stop_hook_active | reason | prompt | source.
```

`notification_type` is documented as
`permission_prompt | idle_prompt | auth_success | elicitation_dialog` (the
shipped binary also carries `elicitation_complete`, `elicitation_response`,
`agent_needs_input`, `agent_completed`). **The exact string the installed CLI
emits was not observed at runtime**, so the runtime is defensive about it:

- the `Notification` hook is registered with **no matcher** — the CLI's
  `Notification` matcher matches `notification_type`, so a matcher would stop
  the hook from ever running for other types and make both of the following
  unreachable;
- every received `notification_type` is written to `~/.agent-inbox/hook.log`,
  so the first real firing documents the true enumeration;
- when `notification_type` is absent (older CLI) the gate falls back to matching
  `message` against `/permission|approve this|waiting for your input/i`.

## #21: which answers reach a session (issue #253)

`session-start`, `prompt-submit`, `stop` and `watch` look for answers in the
projects this Claude Code session uses. That is the project inferred from the
hook's `cwd`, as before, plus, when the hook can see this session's Agent Inbox
server:

- the project that server is scoped to now, including one the session chose with
  `register` (which changes the project inside the server only);
- the project of every question that server raised and that is still open, so a
  project the session registered earlier stays covered after it moves on.

**How a hook sees its session's server.** Claude Code starts both directly. Its
hooks reference says an exec-form hook (`command` plus `args`, which is what the
installer writes) is spawned "directly with `args` as the argument vector", with
no shell. A stdio MCP server registered as a command (what `install:agents`
registers) runs as its direct child too. Each server records the pid of the
process that started it (`host_pid`) and its own pid on its presence row; a hook
links to the rows whose host is its own parent, still refreshed by their
heartbeat, not ended, and whose server process still runs. Checked on 2026-10-21
with Claude Code 2.1.296: in each of two running sessions, the `claude` process
was the parent of both the Agent Inbox server and the running `watch` hook.
`CLAUDE_CODE_SESSION_ID` is not used: Claude Code documents that a server keeps
the id it was spawned with across `/clear` (and possibly `--continue`), and one
of those two sessions already showed a server id different from its hooks'.

**Without that link, the hooks look at the cwd project alone, and the watcher's
set stays the one it captured when it armed.** Two things differ from earlier
builds even then: a newer watcher for the same session and cwd project replaces
the older one instead of standing down beside it (see below), and a watcher
stops once the process that started it is gone. That covers a server from an
older build, which records no host; a hook started through
`hooks/agent-inbox-hook.sh`, or any other process that stays between Claude Code
and the hook or the server (a server started through `npx` or `tsx`, say); and
any error while looking, which is logged to `hook.log`.

**What the watcher waits on.** When it arms, it captures every question and
blocked row in those projects that is still unanswered. That stays project-wide,
so two sessions in one repository both wake for those. While the link holds, it
also waits on every question this session's servers raise later, in any project,
but never on a later request from another session. Answers that are waiting
unread when it arms wake it at once, except on a `stop_hook_active` continuation,
and that wake leaves any older watcher alone, still waiting on its own requests;
a request that was already answered at arming never wakes it. A blocked row
raised after it armed is not watched, because rows do not record which session
raised them: the next Stop's `stop` and `watch` pick it up.

**One watcher at a time.** With the link, a watcher stays armed for its whole
window (`AGENT_INBOX_WATCH_SECS`) even when nothing is waiting, since the session
may still flag a question from a background subagent. Without it, it stands down
as before once nothing it watches is still waiting. Each watcher that starts
waiting holds a lease in the hub: one per Claude Code process with the link (so
the first Stop after a `/clear` takes over too), and one per harness session and
cwd project without it, like the lock earlier builds kept. The next Stop's
watcher takes the lease. At its next poll the older one looks at its own requests
once more, because the newer one counts anything answered before it armed as
already answered: it wakes if one of them was answered since its last poll, and
otherwise exits 0, silently. A watcher also stops at its next poll once the
process that started it is gone, since nothing is left to wake.

The nudge names every project that has responses and the `pending({project:"…"})`
call that reads each one without changing the session's scope.

## #411: messages the human sends this session

The human can message one Agent Inbox session from the viewer. Only a hook linked to
its servers (above) can tell which messages are this session's, so an unlinked hook
ignores them; that session sees them at its next `pending()`.

- `session-start` and `prompt-submit` remind about every open message to the linked
  servers, on every event, inside their existing output.
- `stop` bounces the agent back once per message: it records the ids it blocked for
  in `host-<pid>.nudged.json` beside the session markers, keyed by the Claude Code
  process, so neither a notification hook nor a `/clear` makes it block again. It
  never blocks on `stop_hook_active`.
- `watch` wakes (exit 2, payload on stderr) for a message that arrives after it armed,
  including one sent to a server that restarted under the same Claude Code process.
  Messages already open when it armed are `stop`'s.
- A message counts while it is open (not yet acknowledged with `ack_message`), even
  after another reader of the same server, such as a subagent, picked it up.
- The hooks read message ids only; they never print the text.

A message that arrives during a `stop_hook_active` continuation, or after the watch
window (`AGENT_INBOX_WATCH_SECS`) ends, waits for the next prompt or ordinary Stop.

## #10: how a backstop item behaves

It is an ordinary `items` row — `kind: "question"`, `agent: "hook"`,
`session:` the **Claude Code harness** session id. It enters the §7 attention
set through the same predicate as everything else; `public/attention.js` is not
modified and no second predicate exists anywhere in this runtime.

It **never classifies as `waiting`**: `activity.session` only ever holds a
`randomUUID()` minted by the MCP server, so a harness id can never be in
`liveSessionIds` and the join always misses. `classifyLiveness` therefore
returns `parked` for it, and `stale` once it is older than `STALE_MS` (72h) —
never `parked` indefinitely. Both are non-escalating, so the conclusion is
stronger than "parked forever", not weaker: a backstop **cannot escalate a rail
badge to red**, however old it gets.

**It is self-clearing, and that is the load-bearing part.** A backstop that
cannot stop nagging is exactly what the viewer rebuild was designed against
(tenet 2, the badge must stay trustworthy):

1. **A grace window.** The `Notification` hook writes nothing. It records
   `pendingPromptAt` in the session marker and re-launches itself detached; the
   item is inserted only if, `AGENT_INBOX_HOOK_GRACE_MS` later (default 90s),
   the session is *still* stuck. A prompt you answer in twenty seconds costs
   nothing — no row, and no un-withdrawable desktop notification from the
   packaged app.
2. **The transcript check.** If `transcript_path` grew during the grace window
   the agent carried on working, so the committer stands down.
3. **One open backstop per session.** A second permission prompt while the
   first item is still open inserts nothing *and leaves the first item alone* —
   a flag the human has not seen yet is never resolved out from under them.
4. **No double-ping.** If a real agent raised an unanswered question in this
   project inside `AGENT_INBOX_HOOK_RECENT_MS` (30m), the backstop stays quiet.
   This is deliberately **project-wide**, not session-scoped: `listPending` is
   project-scoped, and two sessions in one repo is this project's normal case.
   The tradeoff is real — session B's ordinary flag silences #10 for session A
   during that window — and it is chosen on purpose over double-pinging.
5. **Exponential backoff and a hard cap.** Successive inserts wait
   `2^(n-1) × AGENT_INBOX_HOOK_COOLDOWN_MS` (capped at 4h), and stop entirely
   after `AGENT_INBOX_HOOK_MAX_PER_SESSION` (3).
6. **It resolves itself the moment the session moves on.** `session-start`,
   `session-end`, `prompt-submit` and `stop` each resolve *this session's* open
   backstop first. Another session's backstop and any agent-authored question
   are never touched.
7. **A 24h janitor.** `AGENT_INBOX_HOOK_MAX_AGE_MS` (24h) sweeps orphans left by
   a session that died without another event. It runs from every subcommand that
   opens the database for session work — `notification`, `notification-commit`,
   `stop`, `session-start`, `session-end`, `prompt-submit` — plus the standalone
   `sweep`. It does **not** run from `watch` or `selftest`, and neither needs it:
   `selftest` writes no items (though opening the hub creates and migrates it —
   see the Node 24 rule below), and `watch` is the second hook in the same `Stop`
   group as `stop`, which has already swept by the time it starts. The cutoff is
   inclusive (`age >= maxAge`), so
   `AGENT_INBOX_HOOK_MAX_AGE_MS=0` deterministically means "clear every
   backstop" instead of racing the millisecond the row was written.

## Non-goals, recorded on purpose

- **No `activity` row is written by the hook.** The `activity` table is
  one-row-per-MCP-session; a hook row keyed by the harness session id would show
  **two** Live entries for one Claude Code session, and would let backstops
  escalate to red after an hour. Blocked terminals stay non-escalating
  (`parked`, then `stale` past 72h).
- **No SessionEnd "you ended with nothing flagged" note.** The two session-id
  spaces never join: an MCP-authored item carries a `randomUUID()`, and the
  harness id never reaches the server reliably. The link through the shared
  Claude Code process (#253, above) holds only while the session's server runs
  and the hook is started directly, which is too weak a basis for telling the
  human what a session did not do, so the note is still not shipped.
- **`idle_prompt` is off by default.** It fires whenever the human walks away
  from a legitimately finished turn — pure badge noise. Opt in with
  `AGENT_INBOX_HOOK_NOTIFY_TYPES` if you want it.

## Environment variables

| var | default | meaning |
|---|---|---|
| `AGENT_INBOX_HOOKS` | *(unset)* | set to `0` to make every subcommand a silent no-op |
| `AGENT_INBOX_DB` | `~/.agent-inbox/inbox.db` | the hub. The watcher's lease lives in it, and marker state and `hook.log` live beside it, which is what makes the runtime hermetic under test |
| `AGENT_INBOX_HOOK_NOTIFY_TYPES` | `permission_prompt` | comma-separated `notification_type` gate |
| `AGENT_INBOX_HOOK_GRACE_MS` | `90000` | how long a permission prompt may sit before it earns an item |
| `AGENT_INBOX_HOOK_RECENT_MS` | `1800000` | a real agent question this fresh suppresses the backstop |
| `AGENT_INBOX_HOOK_COOLDOWN_MS` | `600000` | base of the exponential backoff |
| `AGENT_INBOX_HOOK_MAX_PER_SESSION` | `3` | hard cap on backstop inserts per session |
| `AGENT_INBOX_HOOK_MAX_AGE_MS` | `86400000` | the janitor's cutoff |
| `AGENT_INBOX_WATCH_SECS` | `1740` | `watch` budget, just under the 1800s hook timeout |
| `AGENT_INBOX_WATCH_POLL_MS` | `2000` | `watch` poll interval |
| `AGENT_INBOX_HOOK_ENTRY` | *(set by the CLI)* | absolute path to `dist/hook-cli.js`. The runtime needs it to re-launch itself for the deferred commit; the installer accepts it as an override |
| `AGENT_INBOX_NODE` | *(unset)* | absolute Node 24 binary the installer and the shell wrapper should use |

## Fail-open discipline

A hook that throws prints in the human's terminal; a hook that hangs stalls
their prompt. So:

- `runHook` never throws, for any subcommand and any stdin. Diagnostics go to
  `~/.agent-inbox/hook.log` (truncated past 1 MB) — never stdout, never stderr.
- stdin is capped at 256 KB and 3s, with an unref'd timer, so a stdin that never
  closes cannot hold the prompt open.
- `hook-cli.ts` also registers `unhandledRejection`/`uncaughtException` handlers
  that exit 0.
- The runtime returns immediately, before any `git` call, if the hub database
  does not exist yet.
- `hooks/agent-inbox-hook.sh` uses `set -u` only — never `set -e`.
- **The wrapper forwards only deliberate exit statuses.** Per the hooks
  reference's *Exit code 2 behavior per event* table, `2` is the one status with
  session-affecting semantics: on `Stop` it "prevents Claude from stopping"
  (exactly what `watch` wants), but on `UserPromptSubmit` it "blocks prompt
  processing and **erases the prompt**". A blanket `exit $?` would hand the
  harness a `126` from a non-executable Node, a `127` from a missing one, a
  `137` from an OOM kill, or a future stray `process.exit(2)`. So the wrapper
  passes `2` through **only for `watch`**, passes any status through for
  `selftest` (not a hook event — it is the installer's proof), and exits `0` for
  everything else. A broken install is invisible, never a per-prompt
  `<hook name> hook error` notice and never a blocked session.
- **The wrapper's Node guard tests `-x`, not just `-n`.** bash's `command -v`
  reports the first PATH entry matching by *name* and does not require the
  execute bit, so a mode-644 `node` on PATH comes back as a non-empty path;
  executing it costs `Permission denied` and status 126 on every hook event.
- The one door to the database is still `src/store.ts`. This runtime is a
  **second OS process** writing to the same file, and it goes through the same
  exported functions: no CLI shell-out, no raw SQL. `test/hook.test.ts` pins it.

## The Node 24 rule

`better-sqlite3`'s binding is ABI-pinned. A hook registered with bare `node` on
a Node 26 box dies on **every** invocation, silently, forever — and fail-open
means you will not notice. So the installer:

1. resolves Node (`$AGENT_INBOX_NODE` → `fnm exec --using=$(cat .node-version)
   -- sh -c 'command -v node'` → the `~/.local/share/fnm/node-versions/v24.*`
   glob → `command -v node`), then resolves that through `pwd -P` — inside an
   fnm shell a PATH lookup hands back an **ephemeral**
   `fnm_multishells/<pid>_<ts>/bin/node` path that vanishes with the shell.
   (There is no `fnm which`; fnm answers `unrecognized subcommand 'which'`, so
   an earlier draft's version pin was a dead branch.) **`hooks/agent-inbox-hook.sh`
   deliberately has no `pwd -P` step** — it re-resolves Node on every invocation
   and execs it immediately, so it never persists a path that could rot. Only a
   path written into `settings.json` needs to be stable;
2. **proves it** by running `"$NODE" dist/hook-cli.js selftest` and aborts with
   a clear message if that fails. Nothing is written to `settings.json` first.
   Opening a database creates and migrates it, so the dry run points the
   selftest at a throwaway database instead of the hub;
3. bakes the absolute path into exec-form `args`, so no shell parser ever sees
   a path containing a quote, `$` or a backtick.

The viewer's Setup panel offers the same block for hand-merging, but it can
only bake the Node the viewer itself is running under and cannot run the
selftest — so prefer `npm run install:hooks`.

## Migrating off the legacy shell hooks

Two hand-written scripts predate this: `~/.claude/hooks/agent-inbox-pending.sh`
and `agent-inbox-watch.sh`. They shell out to a database CLI with hand-escaped
SQL — a direct violation of the store-is-the-only-door invariant — and they
take their watcher lock in `$TMPDIR`. The ported `stop` and `watch` subcommands
replace both, and keep their watcher's lease in the hub instead, so the two
cannot see each other: **run `--migrate` before trusting the new watcher**, or
you will briefly have two watchers on one project. `--migrate` rewrites only the
`settings.json` entries and leaves the `.sh` files on disk, so rolling back is
an edit away. (Builds before #253 kept a lock file under
`$(dirname $AGENT_INBOX_DB)/hook-state/`; a watcher one of them armed runs out
its own window beside a newer one, once.)
