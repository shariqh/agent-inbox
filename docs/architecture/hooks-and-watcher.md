---
paths:
  - "src/hook.ts"
  - "src/hook-cli.ts"
  - "src/watch.ts"
  - "src/watch-cli.ts"
  - "scripts/install-hooks.sh"
  - "docs/hooks.md"
  - "electron/reply-watch.cjs"
applyTo: "src/hook.ts,src/hook-cli.ts,src/watch.ts,src/watch-cli.ts,scripts/install-hooks.sh,docs/hooks.md,electron/reply-watch.cjs"
---

# Hooks and the Copilot answer watcher

Claude Code's backstop hooks (#10, #21, #253), the Copilot exact-question watcher (#217) and Electron's response watch.

Moved out of `CLAUDE.md` and `.github/copilot-instructions.md` by #379, nearly verbatim. Claude Code and Copilot CLI load this file automatically when they read or edit a file matching the `paths`/`applyTo` globs above (through the symlinks in `.claude/rules/` and `.github/instructions/`); anyone else should read it before changing those files.

## In brief

- The Copilot answer watcher is host-owned, exact-item, and read-only. The MCP
  server returns its launch contract but must never spawn it; only a host-owned
  detached command can wake the originating session. Preserve `process.execArgv`
  and the explicit database path so source and built execution behave alike.
  Its wait backs off statelessly from the ask's age through one function
  (`watchTimeoutMs`) that both the contract and the watcher evaluate (#217).

## Invariants in detail

- **The hooks runtime is a SECOND OS process on the same db — and it still goes through
  `store.ts`.** `src/hook.ts` (+ the `src/hook-cli.ts` entry) is spawned by Claude Code, not
  by an MCP session, and writes backstop items with `insertItem`/`resolveItem` like everything
  else: **no CLI shell-out, no raw SQL** (the untracked shell hooks it replaces did exactly
  that; `test/hook.test.ts` now pins the absence). Its stdout rule is the inverse of the MCP
  server's: not "write nothing" but **"write EXACTLY the documented payload"** —
  `notification`/`session-end`/`sweep`/`watch` emit zero bytes, `prompt-submit` and `stop`
  exactly one JSON object, `session-start` one line of text. Two things are non-negotiable:
  `stop` must never block when `stop_hook_active` is true (a double block traps the human in
  an un-exitable session), and `watch`'s **exit code 2** must reach the harness — it is the
  only thing that wakes the model, and its payload rides on **stderr**, so no wrapper may
  redirect either stream. Backstop items carry the *harness* session id, so they classify
  `parked` and can never escalate a badge; `public/attention.js` is untouched. **Test trap:**
  `test/hook.test.ts`'s `freshEnv()` pins `AGENT_INBOX_HOOK_GRACE_MS=0` so the arm/commit pair can
  be driven synchronously — which makes BOTH grace comparisons (the in-flight-committer guard and
  the committer's own wait) unreachable, and each was invisible to the whole suite until a test
  raised the window on purpose. Two do now; anything else about the window must too, or it asserts
  nothing. *(#253)* The hook's projects are not just the cwd's: `register` changes a project only
  inside the MCP server, so the server records the process that started it (`activity.host_pid`,
  plus its own `server_pid`, on its existing presence/status writes; an omitted value keeps the
  stored one), and a hook links to the live servers whose host is its OWN parent. Claude Code starts
  exec-form hooks and stdio servers directly, so both are children of the one Claude Code process.
  `CLAUDE_CODE_SESSION_ID` is not the link: a server keeps the id it was spawned with across
  `/clear`. A linked hook counts the servers' current projects and the projects of their open
  questions; no link (an older server, a hook or server started through another process such as
  the shell wrapper or `npx`, a dead server pid, any read error) means the cwd project alone and
  the set fixed at arming, though takeover and the orphan exit below still apply. `watch` reads
  what it waits on before what already waits unread, so an answer landing between those reads is
  in one of them. It keeps the project-wide set of asks unanswered at arming, adds only questions
  the linked servers raise LATER (by `items.session`, never another session's new ask), and,
  linked, stays armed with nothing waiting. Waking at once for an answer already waiting takes NO
  lease: the older watcher keeps waiting on its own asks. A watcher that starts waiting takes the
  one lease per Claude Code process (per harness session AND cwd project when unlinked, like the
  old lock) in `hook_watch_claims`; the older watcher, at its next poll, wakes if one of its own
  asks was answered since its last poll (the newer one counts it as answered at arming) and
  otherwise exits silently. Release is compare-and-delete, so a watcher never drops a newer one's
  lease. A watcher whose parent exits stops at its next poll. Full contract:
  [`docs/hooks.md`](../../docs/hooks.md).
- **The Copilot answer watcher is host-owned, exact-item, and read-only.** Copilot has no
  supported session-resume API, but a detached background command's completion notification
  does wake the owning session. `flag(kind:'question')` therefore returns `watch` metadata
  only when `inferAgent` identifies Copilot; the agent launches `src/watch-cli.ts` (source)
  or `dist/watch-cli.js` (built) itself and calls `pending()` when it completes. The MCP
  server must never spawn this watcher: a child completion inside the stdio server cannot
  wake the host. `src/watch.ts` reads only through `getItem` in `store.ts`, watches the exact
  generated item id, emits no answer content, and exits on response, close, or a bounded
  timeout. A persisted `reply_seen_at` is NOT a reason to keep sleeping — a sibling process
  may have stamped pickup first while the asking session still needs its own wake. Preserve
  `process.execArgv` in the returned command so the same contract works under source `tsx`
  and built Node execution. The command also carries the resolved database path explicitly;
  the host shell does not inherit MCP-only `AGENT_INBOX_DB` configuration.
  *(#217)* A timeout is not an answer, so every one costs the agent a whole turn to re-arm.
  The wait is therefore `watchTimeoutMs`: 30 minutes plus the ask's age (item `created_at`,
  row `action_started_at`) in whole minutes, capped at 4 hours, so re-arms of an unchanged
  ask double (30 min → 1 h → 2 h → 4 h). It is stateless and evaluated twice by ONE
  function: the server sizes `timeout_seconds` with it, and the watcher re-derives its own
  deadline at launch, so re-running the identical question command backs off too (the
  argv carries no timeout; `AGENT_INBOX_WATCH_TIMEOUT_MS` only forces one for tests). The
  human's quiet time — a snooze, or an "I'll take a while" with a time — can only push the
  deadline out, and never more than 24 hours past the later of the watcher's launch and the
  moment the human chose that time (`watch_stopped_at`), so every offered "back in…" is kept
  in full and an orphaned watcher stops within a day. A snooze records no such moment: one
  longer than a day costs a recheck a day. Order is fixed: close, then answer, then a stop
  for good (exit 3, one stdout line telling the agent not to re-arm), then the deadline
  (exit 124, unchanged). `board_get({watch:true})` returns no watch for a row stopped for
  good: re-arming it would only cost another wake.

- **The hooks wake a linked session for the human's messages (issue #411).** Only a
  linked hook (#253) knows its servers, so only it counts messages; an unlinked one
  ignores them. It counts OPEN messages to those servers (`listOpenMessages`, ids
  only, never the text), never undelivered ones: a subagent's `pending()` stamps
  delivery for a message the top-level agent never saw. `prompt-submit` and
  `session-start` remind about every open message on each event. `stop` blocks for
  the open messages it has not yet blocked for, never on `stop_hook_active`, and
  records them in its OWN file, `<state>/host-<pid>.nudged.json`, keyed by the Claude
  Code process the link proved and written only by `stop` (temp file and rename),
  holding only ids still open. Not in the session marker: `readMarker` rebuilds a fixed
  shape, the notification hooks rewrite it whole (the commit after its grace window),
  and it is keyed by the harness session id, which `/clear` changes. So `stop` blocks
  once per message, and one the agent ignores or cannot ack never loops a Stop. `watch`
  baselines the messages open when it arms (`stop`, on the same event, owns those, as
  `answered` excludes answers), re-reads the live servers of its host on every poll (a
  server restarted under the same Claude Code process stays covered), and wakes with
  exit 2 for any other open message, unless superseded. Its lease keeps the key
  `host:<pid>`, so supersession is unchanged, and its token starts `m1:`: every hook
  since #253 claims the same key without waking for messages, so only a marked token may
  ever tell the human a message will wake the session. The nudge adds one clause per
  kind; with no messages it is byte-identical to before. A message that arrives during a
  `stop_hook_active` continuation, or after the watch window ends, waits for the next
  prompt or ordinary Stop, as does one sent in the milliseconds between `stop` reading the
  open messages and `watch` reading its baseline (separate processes on the same Stop).

## History (shipped since v1)

These landed after v1 and still hold invariants; the release history itself is in `CHANGELOG.md`.

- **Electron response watch + host adapter seam** — `electron/reply-watch.cjs` derives the
  work still waiting on an agent without changing `public/attention.js`: a question leaves
  the set when `pending()` stamps `reply_seen_at`, while a human-acted board row stays until
  its agent-owned status changes. New responses invoke an optional
  `AGENT_INBOX_WAKE_COMMAND` immediately; native reminders start after one minute and repeat
  every 15 minutes. The command is an absolute path, is spawned with `shell:false`, and
  receives one JSON event on stdin. This is an Electron-process integration seam, not an MCP
  capability: Claude's hook remains the supported automatic wake path, and Copilot has no
  built-in adapter until its host exposes a supported per-session resume API. Never fold
  these reminders into the attention predicate or badge — they represent work awaiting the
  agent, not work awaiting the human.
- **Copilot exact-question wake** — `src/watch.ts` + `src/watch-cli.ts` bridge the remaining
  host gap without pretending Copilot has a direct resume API. For Copilot questions only,
  `flag` returns a shell-safe detached-background launch contract. The host owns that process
  and therefore receives the completion notification; the resumed agent calls `pending()`.
  Claude gets no duplicate watcher because its hook already owns wakeup.
- **Watcher backoff and "I'll take a while"** *(#217)* — re-arming an unchanged ask waits
  longer each time (30 min → 1 h → 2 h → 4 h), and the human can stop a Copilot ask's
  watcher for good or ask it to wait quietly until a time. See the watcher invariant above and the watch-stop
  invariant in `attention-and-later.md`. A native-notification stop action was left out: notification buttons
  are answers today, and mixing in a non-answer needs its own design.
- **Backstop hooks** *(#10 + #21)* — `src/hook.ts` + `src/hook-cli.ts`, installed opt-in by
  `scripts/install-hooks.sh` (dry-run by default; *#206:* the app runs it only to move hooks a
  Setup runtime already installed, on the human's click, and `--move-only` makes the
  installer itself refuse, under the setup lock, where there are none). #10: a `Notification` hook arms a
  grace-windowed backstop item when a session is stuck at a permission prompt; it is
  self-clearing, rate-limited and janitored, so the badge stays trustworthy. #21: `stop`,
  `prompt-submit` and `session-start` nudge an idle agent to call `pending()`, and the
  `watch` subcommand (asyncRewake, exit 2) wakes it the moment you answer. The two legacy
  untracked `~/.claude/hooks/agent-inbox-*.sh` scripts are superseded — `--migrate` retires
  their settings entries. *(#155)* The installer's dry run stays side-effect free: its
  selftest gets a throwaway database, because opening the hub creates and migrates it.
  `--apply` writes through a symlinked `settings.json` (backup, staged copy and rename beside
  the target), refuses a dangling, non-regular or read-only target, and checks every write
  before it reports success. *(#218)* An install never adds its set beside another Agent
  Inbox install's: two sets run every hook twice. Both modes sort every agent-inbox-shaped
  entry with ONE rule, `sortHookEntries` in `runtime-config.mjs` (checkout mode calls it as
  `foreign-hooks` under the selftest-proven Node): own; replaceable (a verified Setup
  runtime's, a checkout's — `dist/hook-cli.js` beside a `package.json` named `agent-inbox`
  — or a dead `…/dist/hook-cli.js` whose entry or Node no longer resolves); unverifiable
  (a `…/dist/hook-cli.js` that runs but does not verify); or another tool's. Its launcher
  classification is `src/agent-hosts.ts`'s with Setup's `unknown` split into dead, elsewhere
  and unknown (`test/agent-hosts.test.ts` holds them to agreement). *(#232)* A
  `<dir>/dist/hook-cli.js` beside a runtime manifest is never another tool's: outside the
  runtime root it is `elsewhere` — replaceable, and own only to that folder's own
  installer — when `verifyPayload` passes (product `agent-inbox-runtime`) and the command
  is that folder's Node, else `unknown`; Setup reports both as `unknown`. Verification
  stays strict (a Finder `.DS_Store` fails it), so the refusal lists each unverifiable
  entry with its command and, for a runtime folder (under the root or not) that does not
  verify, the verifier's reason and the fix: delete what was added or reinstall it.
  *(#228)* A path
  is dead only when `statSync` on it as written fails too: `realpathSync` applies `..`
  before the symlink in front of it, so a working `<symlinked folder>/../bin/node` is
  `unknown`, never dead. Replaceable entries refuse
  (exit 1, nothing written) until `--replace-existing`, which strips exactly them by
  command + args plus the installer's own and adds one set; unverifiable ones always
  refuse; another tool's are never removed (checkout mode never refuses for them; packaged
  mode still does without the flag, as before). Every refusal is one `HookRefusal` whose
  FIRST printed command is the one-step `--replace-existing`; each other install's own
  `--apply --uninstall` follows only when it can succeed now — never a runtime's while
  anything else shaped like ours is present, because every runtime version's uninstall
  refuses then. Packaged `--uninstall` keeps that refusal and names the checkout. `--force`
  keeps its exact meaning, and `--replace-existing --uninstall` is a usage error (exit 2).
  *(#240)* So are `--move-only` with `--uninstall` or `--force`, refused by the shell in both
  modes before the lock or any preflight: a runtime never forwards `--force`, and a helper
  refusal reaches the caller as exit 1. `--move-only` without `--apply` is a dry run that
  exits 1 where there is nothing to move.
