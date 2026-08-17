# The backstop hooks (issues #10 and #21)

Two deterministic, no-AI Claude Code hooks that close the two holes an
agent-driven inbox has by construction:

- **#10 — the forgotten flag.** A session is blocked at a permission prompt and
  the agent never called `flag`. Nothing reaches the inbox, and the human only
  finds out by looking at that terminal.
- **#21 — the idle-agent polling gap.** The human answers a question in the
  inbox, but the agent is sitting at the prompt and never calls `pending()`, so
  the answer stays at "waiting for pickup" forever.

Everything here is **opt-in**. Nothing runs from `npm install`, `npm run build`
or the Electron app. One command installs it, one removes it.

```sh
npm run install:hooks                     # dry run — prints what it WOULD write
npm run install:hooks -- --apply          # write it (timestamped backup first)
npm run install:hooks -- --apply --migrate    # also retire the legacy .sh Stop hooks
npm run install:hooks -- --apply --uninstall  # remove every agent-inbox entry
```

From a source checkout this installer uses `jq`. A portable release runtime instead
uses its bundled Node 24 plus `scripts/runtime-config.mjs`, so install, upgrade, and
uninstall work on a clean Mac with no ambient Node or `jq`. Packaged hook changes share
the agent setup kernel lock and replace/remove only hook entries whose command and
entrypoint canonicalize to the same valid manifest-owned runtime directory.

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
| `Stop` | `stop` | 10s | clears this session's backstop; bounces the agent back to work if an answer is unpicked | one JSON object |
| `Stop` (asyncRewake) | `watch` | 1800s | polls until the human answers, then exits **2** to wake the model | *(empty; stderr carries the payload)* |
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
   `selftest` is read-only, and `watch` is the second hook in the same `Stop`
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
  spaces never join: an MCP-authored item carries a `randomUUID()`, so a hook
  can never tell whether *this* Claude Code session produced items. The
  per-session form of that check is unimplementable, so it is not shipped.
- **`idle_prompt` is off by default.** It fires whenever the human walks away
  from a legitimately finished turn — pure badge noise. Opt in with
  `AGENT_INBOX_HOOK_NOTIFY_TYPES` if you want it.

## Environment variables

| var | default | meaning |
|---|---|---|
| `AGENT_INBOX_HOOKS` | *(unset)* | set to `0` to make every subcommand a silent no-op |
| `AGENT_INBOX_DB` | `~/.agent-inbox/inbox.db` | the hub. Marker state, the watcher lock and `hook.log` all live beside it, which is what makes the runtime hermetic under test |
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
   a clear message if that fails. Nothing is written to `settings.json` first;
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
replace both, and take their lock under
`$(dirname $AGENT_INBOX_DB)/hook-state/` instead, so the two cannot see each
other's locks: **run `--migrate` before trusting the new watcher**, or you will
briefly have two watchers on one project. `--migrate` rewrites only the
`settings.json` entries and leaves the `.sh` files on disk, so rolling back is
an edit away.
