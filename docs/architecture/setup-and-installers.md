---
paths:
  - "scripts/install-agents.sh"
  - "scripts/install-hooks.sh"
  - "scripts/setup-lock.sh"
  - "scripts/runtime-config.mjs"
  - "scripts/runtime-pins.mjs"
  - "scripts/runtime-payload.mjs"
  - "scripts/prune-runtimes.sh"
  - "scripts/run-isolated.mjs"
  - "scripts/setup-filesystem.cjs"
  - "scripts/write-setup-info.mjs"
  - "electron/setup-*.cjs"
  - "electron/runtime-verify.cjs"
  - "src/agent-hosts.ts"
  - "src/runtime-inventory.ts"
  - "src/stamp.ts"
  - "public/agents.js"
  - "public/runtimes.js"
  - "public/buildstamp.js"
  - "electron/runtime-targets.cjs"
applyTo: "scripts/install-agents.sh,scripts/install-hooks.sh,scripts/setup-lock.sh,scripts/runtime-config.mjs,scripts/runtime-pins.mjs,scripts/runtime-payload.mjs,scripts/prune-runtimes.sh,scripts/run-isolated.mjs,scripts/setup-filesystem.cjs,scripts/write-setup-info.mjs,electron/setup-*.cjs,electron/runtime-verify.cjs,src/agent-hosts.ts,src/runtime-inventory.ts,src/stamp.ts,public/agents.js,public/runtimes.js,public/buildstamp.js,electron/runtime-targets.cjs"
---

# Setup and installers

The dry-run-first installers, the setup lock, runtimes and their pruning, `setup-filesystem.cjs`, host registrations (#197) and the build stamp (#40).

Moved out of `CLAUDE.md` and `.github/copilot-instructions.md` by #379, nearly verbatim. Claude Code and Copilot CLI load this file automatically when they read or edit a file matching the `paths`/`applyTo` globs above (through the symlinks in `.claude/rules/` and `.github/instructions/`); anyone else should read it before changing those files.

## In brief

- **Setup path:** `scripts/install-agents.sh` is the canonical dry-run-first
  installer for MCP registration and managed host instructions. Electron exposes
  only fixed setup targets through `electron/setup-preload.cjs` and invokes that
  same script through `electron/setup-runner.cjs` and the fixed-purpose
  `electron/setup-process.cjs` boundary. The process boundary constructs only
  exact `/bin/bash` installer argv for macOS/Linux and fails closed before spawn
  on Windows or unknown platforms; it is not a general-purpose shell bridge and
  does not enable non-Darwin release Setup. There is no HTTP setup-write route.
  Setup's "Update agents" / "Match agents to vX" (#197) reuses the same
  `install(target)` once per Setup-managed host whose runtime differs from the
  app's (behind, or ahead after a downgrade), `claude` then `copilot`, then
  `hooks` for Claude's Setup-runtime hooks (#206), never `all` or `--force`;
  status is read by the viewer, so there is no status IPC or
  installer status mode. `hooks` runs exactly `/bin/bash <installed
  runtime>/scripts/install-hooks.sh --apply --move-only`, from the installed
  copy of the verified release runtime (re-verified against the signed manifest
  digest before spawn), never from the app bundle or a checkout; `--move-only`
  refuses under the setup lock where no Setup runtime's hooks exist to move.
  Where no Setup step can move outdated hooks (#278), the panel hands over the
  checkout's own `npm run install:hooks -- --apply --replace-existing` when
  Claude Code runs from a checkout (built and quoted by the viewer as `/api/setup`
  `checkoutHooksCommand`), promises a later move only while a Setup install
  could put the app's runtime in place, and otherwise says Setup cannot move them.
  That promise can still show where no install keeps it: `none` also covers a
  host whose CLI is not installed, which the viewer cannot see without running
  anything (custom or unverifiable Claude Code plus no Copilot CLI); docs/hooks.md gives the way out. Once any quit begins, nothing starts: every quit or
  restart path calls `beginAppQuit()` in `electron/main.cjs` first, which refuses
  later installs through `createInstallGate()`, revokes the window's Setup, and
  cancels and awaits the running install; the renderer stops its per-host loop
  at a step that was cancelled, timed out or could not run (a plain failure,
  such as a missing CLI, continues).
  Setup and update installs, and opening local files from links (#300), are
  granted to the window by `createInstallBinding()`
  (#216): bound at its first navigation, revoked by every later one, and granted
  again only after that load commits to the viewer origin and ownership is proven
  again (`reproveOwnership()`), never once a quit has begun. Settings shows
  `available.installPermitted`; a window that may not install gets the restart
  copy, with Electron's relaunch on macOS only (never for an AppImage). Main's
  restart IPC accepts only that exact state, never while Setup runs.
  `scripts/setup-filesystem.cjs` is the
  Node-core-only runtime identity/staging/publication/removal boundary used by
  the shipped Darwin install path and build-time runtime publisher. Its Win32
  policy is modeled, and native Windows folder CI exercises only immutable
  runtime create/publish/remove on NTFS; do not treat either as Windows Setup
  availability or as a stable-handle fix for the verify-to-execute TOCTOU. Runtime-payload install
  exit 3 means publication may have committed; the shell must exact-verify it
  before invoking ownership-safe rollback and must retain unverifiable paths.
  A prune renames the runtime into a `.trash-*` folder before deleting it, so an
  interrupted one leaves trash, never a half-deleted runtime id; installs and
  prunes remove leftover trash this user owns, and `.trash-*` is never a runtime.
  The fifth fixed target, `prune-runtimes` (#294), runs exactly `/bin/bash
  <app payload>/scripts/prune-runtimes.sh --apply` from the verified release
  payload (a checkout refuses it), through the same `agent-inbox:install`
  handler and gates; the script re-derives what to remove under the setup lock,
  so no runtime id or path becomes argv, and its dry run takes no lock and
  writes nothing. It keeps its own runtime, anything a host config uses,
  anything a running process names (`ps`; a failure refuses everything) and
  anything that no longer verifies against its manifest (`changed`, never
  attempted), and removes the rest only through `runtime-payload.mjs prune`. "Uses" is ONE
  rule in `scripts/runtime-config.mjs` (`scanRuntimeReferences`), shared with
  the installer's own prune and rollback: any value in `~/.claude.json` (every
  scope), `~/.claude/settings*.json`, `~/.copilot/mcp-config.json` or Claude
  Desktop's config naming the id as a whole name (unless at the end of a path to
  a folder that is not there), or a launcher path leading into it, compared by
  `(dev, ino)` and never as a string. A config that exists but cannot be read
  means nothing is removed. Project-scope configs are deliberately not read.
  A running `agent-inbox-driver` pins its runtime (#412, "Runtime pins" below), and a pin
  counts as a use in both prunes and in the mirror; `--uninstall` refuses while one runs.
  Setup's Runtimes block (#294 part B) lists the runtimes from `src/runtime-inventory.ts`, a
  viewer-only, read-only mirror of that rule held to agreement with the script
  by `test/runtime-inventory.test.ts`; it walks only unused runtimes, keeps
  answers per folder and config stamp, and its one Remove re-reads the list
  before it calls exactly `install('prune-runtimes')`.
- Treat `scripts/install-agents.sh`, `scripts/install-hooks.sh`, and their shared
  `scripts/setup-lock.sh` as transactional infrastructure. The mutating Bash
  process owns fd 9 across apply/rollback; Darwin prefers descriptor-mode
  `/usr/bin/lockf` and falls back to same-domain `flock`, while Linux uses
  `flock` only. Repeated acquisition must not reopen fd 9, non-regular lock paths
  fail before open, and only exit 75 is contention. Preserve the named MCP
  registration, marker-delimited instruction block, unrelated content,
  symlink targets, and timestamped backups. HUP, INT, QUIT, PIPE, ALRM, TERM,
  XCPU and XFSZ each roll an active install back and exit 128 + the signal;
  any exit mid-transaction keeps every MCP snapshot. Every Node step of that
  rollback (host CLI or runtime helper) runs through `scripts/run-isolated.mjs`
  in its own session, bounded to 30 s, with fd 9 but none of the installer's
  stdio, so repeat signals cannot stop it. A step that fails or times out must
  be reported and its report kept, never claimed as restored; one already
  running survives the installer's SIGKILL, still bounded by a detached
  guard, and holds the lease until it ends. Neither hook-install mode may add
  a second Agent Inbox hook set (#218): another install's set, or a dead one,
  is refused (the one-step `--replace-existing` printed first) or replaced
  entry-for-entry with that flag, and another tool's look-alike is never removed.
  A runtime folder outside the runtime root is never another tool's (#232), and
  a path is dead only when the OS cannot stat it as written either (#228).
  A host config that cannot be read or parsed is named by its path and a fixed
  kind (`is not valid JSON`, `is unreadable (EACCES)`), never by a parser's,
  jq's or fs error's message, which can quote a token from it (#337);
  `test/host-config-secrets.test.ts` runs every reader over such configs.

## Invariants in detail

- **A host config that cannot be read is named, never quoted** *(#337)*. `~/.claude.json`,
  `~/.copilot/mcp-config.json` and `~/.claude/settings.json` often hold other MCP servers'
  API tokens, and since Node 20 a `JSON.parse` error quotes the text around the failure, as
  jq does the value it fails on. So a reader that reports one it cannot read or parse
  (`runtime-config.mjs` `registration`, `references`, `unused`, `hooks`, `foreign-hooks` and
  `merge-json`, through `parseConfigFile`/`readConfigFile`; `prune-runtimes.sh`; the viewer's
  `runtime-inventory.ts`) says its path and a fixed kind, `is not valid JSON` or
  `is unreadable (EACCES)` (of a failed read only its error code), never a parser's, jq's or
  fs error's message. A source checkout's `install-hooks.sh` drops jq's stderr on the steps
  that read settings.json and names the file instead; `install-agents.sh`'s inline readers
  only ever exit with a status; `agent-hosts.ts` returns closed kinds and no text at all.
  `test/host-config-secrets.test.ts` runs every reader, the dry-run installers and
  `/api/setup` over configs that put a fake token where the parser quotes it: a new reader
  is one more row there. Unchanged on purpose: what each reader does with such a config.
- **Agent setup is explicit, dry-run-first, and owns only marked text.**
  `scripts/install-agents.sh` is the supported bridge between two configuration systems:
  MCP registration can store a server command but cannot inject a global prompt, so the
  installer performs both operations visibly. It defaults to a side-effect-free dry run;
  `--apply` verifies the pinned Node runtime through `hook-cli selftest` before managed
  runtime or host mutation (the user-scoped install lock is created/acquired first).
  Instruction content is fully rendered and staged before MCP changes, and it writes only between
  `<!-- agent-inbox:begin -->` / `<!-- agent-inbox:end -->` in
  `~/.claude/CLAUDE.md` or `~/.copilot/copilot-instructions.md`, with a timestamped backup
  before every change. Symlinked instruction files stay symlinks: the resolved target is
  updated atomically. Unmatched or duplicate markers are a hard refusal. Destructive MCP
  changes retain an exact snapshot of the host's user config until instruction writes commit,
  so a later failure restores the prior registration rather than reconstructing it. Claude receives
  `docs/instructions/claude-code.md`; Copilot receives
  `docs/instructions/copilot-cli.md`; both normally receive `docs/reporting-snippet.md` inlined.
  **The one exception is an import the human wrote themselves.** If the target file already
  carries a live `@…/docs/reporting-snippet.md` directive, the block cites that import instead
  of inlining a second copy: the inline would be ~2,300 duplicated tokens in every session AND a
  snapshot that goes stale on the next snippet edit — exactly the drift the import exists to
  prevent. The target appendix is still written, because the import does not carry it, and the
  dry run says on stderr that it detected the import and is skipping the inline. Four things are
  load-bearing. (1) **Detection is a directive, not a mention** — and the bar is what CLAUDE CODE
  WOULD RESOLVE, not what looks like a path. Shape: first non-blank character `@`, at most three
  leading spaces; four or more spaces (or a tab) is an indented code block and ``` / `~~~` open a
  fenced one, and an `@…` in either is inert text. Prose that names the file and a `@…` inside a
  code span start with some other character. (2) **The path must resolve to THIS repo's
  `docs/reporting-snippet.md`** — `~/` expands to `$HOME`, a relative path resolves against the
  directory of the file carrying the line (where Claude Code resolves it from), and identity is
  the same-FILE test (`-ef`), so symlinks, `..` and alternate spellings agree while a different
  file that merely ends in the same name does not. Anything unresolvable — a dangling path left
  by a moved checkout, a URL — fails toward INLINING. That direction is the whole point: the
  managed block's note asserts "this file already imports the snippet", so a false positive makes
  the block state something untrue *and* deletes the reporting contract, while a false negative
  only duplicates it. (3) **Only the region OUTSIDE BEGIN/END is consulted**, so the installer can
  never be fooled into thinning a block by its own output. (4) **It is gated on the HOST, not the file**
  (`host_resolves_imports`): Copilot CLI has no import mechanism, so an `@path` line in its
  instructions is inert text and skipping the inline there would silently delete the reporting
  contract instead of de-duplicating it. Copilot always inlines; that is why its instructions
  used to sit frozen while Claude's tracked every edit. Both transitions are covered — a file
  that gains an import sheds the inlined snippet on the next run, one that loses it gets the
  snippet back — and both modes are idempotent and `--uninstall`-reversible. `--force`
  replaces only the named MCP registration, and `--uninstall` removes only the managed
  registration/block. Nothing runs from install, build, package, or Electron startup.
  The Setup panel's direct action is deliberately Electron-only:
  `electron/setup-preload.cjs` exposes only `available()`/`install(target)`, with
  `contextIsolation:true` and `nodeIntegration:false`; `main.cjs` accepts only the
  five fixed targets (`all`, `claude`, `copilot` and, since #206, `hooks` and, since #294,
  `prune-runtimes`) and only
  while the app owns the exact local-viewer origin (the
  window binding update installs share, #216). A
  reused viewer never gets execution access, and there is no HTTP setup-write route.
  `electron/setup-core.cjs` is the dependency-free control plane. It trusts the POSIX
  adapter's frozen host identity derived from the real `process.platform`/`process.arch`
  and requires the selected key plus verified manifest platform/architecture to match it
  exactly. The core carries only values the current adapter consumes (the verified
  `runtimeId` locates the installed copy the `hooks` target runs); shell-internal
  self-tests, rollback and pruning are not self-certified policy fields.
  `electron/setup-runner.cjs` selects only the exact architecture-keyed runtime payload
  from release `setup-info.json`. Both its verified release path and checkout/dev fallback
  delegate execution to the fixed-purpose `electron/setup-process.cjs` boundary, which
  constructs only exact `/bin/bash scripts/install-agents.sh` argv, plus for `hooks`
  exactly `/bin/bash <installed runtime>/scripts/install-hooks.sh --apply --move-only`
  (never `--force` or another flag, and only from a directory carrying a runtime manifest),
  and for `prune-runtimes` exactly `/bin/bash <payload>/scripts/prune-runtimes.sh --apply`,
  bounds output/time,
  and preserves POSIX process-group cancellation. It accepts no executable or arbitrary
  argv from callers, permits exact-host macOS/Linux shell execution, and fails closed before
  spawn on Windows or unknown platforms. Release setup-info callers declare an exact key set
  from the shared runtime registry; current macOS callers remain Darwin-only.
  *(#206)* `hooks` exists only in release mode: a dev checkout refuses it. Its installer
  bakes ITS directory's `bin/node` and `dist/hook-cli.js` into Claude's settings, so it
  never runs from the app bundle (the next app update replaces that payload) but from the
  installed copy at `${AGENT_INBOX_RUNTIME_ROOT:-$HOME/.agent-inbox/runtime}/<runtimeId>`,
  the root the installers themselves use. After the core verifies the bundle's payload,
  that copy is verified again against the same signed manifest digest (with
  `scripts/install-hooks.sh` required) immediately before spawn; a missing copy, a
  changed or extra file, or a symlinked directory refuses without spawning. Main gates it
  exactly like the agent targets.
  *(#294)* `prune-runtimes` removes the runtimes nothing uses. It too exists only in
  release mode, and runs the app bundle's own payload (it bakes nothing into a host
  config), once the core has verified that payload against the signed digest with
  `scripts/prune-runtimes.sh` required; main's handler has no branch for it, so every gate
  above applies unchanged. The script takes `--apply` and nothing else: it re-derives what
  to remove itself, under the setup lock, so the renderer names the target and never a
  runtime id or path. Without `--apply` it is a dry run that takes no lock, cleans no trash
  and writes nothing. It always keeps its own runtime and anything that is not a real
  directory directly in the runtime root carrying a manifest that names it (never a
  symlink, never a `.`-name such as `.trash-*`, never outside the root), and removes each
  other runtime only through `runtime-payload.mjs prune` (#211/#214 trash semantics),
  after checking it again on its own. A runtime that no longer verifies against its
  manifest (a Finder `.DS_Store` is enough) is kept as `changed` and named, never
  attempted: `unused` runs the same full `verifyPayload` prune would (about 0.25 s per
  171 MB runtime with a warm cache), so `--apply` exits 0 whenever everything it tried was
  removed. Seconds still pass between the re-check and the
  rename (prune cleans trash and hashes the folder first), and a config written then is
  not seen. What "uses" means is ONE rule in `scripts/runtime-config.mjs`
  (`scanRuntimeReferences`), which the installer's own prune and rollback
  (`references --home --status`) share. Its candidates are a host config's
  string values (`~/.claude.json` in every scope, `~/.claude/settings.json`,
  `~/.claude/settings.local.json`, `~/.copilot/mcp-config.json`, Claude Desktop's config on
  macOS or Linux), each whole (a path with a space stays one path) and split into
  command-line and `KEY=value` pieces. Runtime R is used when (a) a candidate names R's id
  as a whole name (no runtime-id character on either side, as `runtimeIdInText`), unless
  the text up to and including the id is an absolute or `~/` path to a folder whose stat
  fails with ENOENT or ENOTDIR (so shell text glued to it, such as `cd <R>&&…`, a file R
  lacks and another root's copy of the same id all count); or (b) an absolute or `~/`
  candidate in a launcher (any object with a string `command`) resolves to R or into it,
  compared by `(dev, ino)` and never as a path string, so a symlinked shortcut, another
  case, the other Unicode form and a firmlink all count.
  Errors only ever keep: any other stat error counts under (a), and under (b) keeps every
  runtime when what resolves of the path lies in the runtime root. Against the verified
  `{command, args[0]}` pair the installer used to require it only keeps more: every pair
  with absolute paths it matched resolves into R, so (b) matches it (it also resolved a
  relative path against the installer's own working directory, which no host launches
  from). So the installer now also keeps runtimes that split pairs, `env` values, `sh -c`
  wrappers, later arguments and one-string hooks use. `references` names each file that
  uses a runtime (`{file, label}`), never what is in it. A config that exists but cannot
  be read (a symlink to nothing, itself or a folder above it; not a regular
  file; over 64 MB; not JSON) makes the answer unknown, and then nothing is removed; the
  installer's prune keeps everything and the install still succeeds. The prune also keeps
  any runtime a running process names (`ps -A -ww -o pid=,ppid=,command=`, its own
  ancestry excluded; a missing or failing `ps` refuses everything): a live MCP server
  survives the deletion, but every Copilot watcher it hands out runs its runtime's
  `dist/watch-cli.js`. That check is why the prune, unlike the installer, does not keep the
  newest previous runtime. Project-scope configs (`<project>/.mcp.json`,
  `<project>/.claude/settings*.json`) are deliberately not read; the process check still
  keeps a runtime a running session started from one uses.
  *(#294 part B)* Setup's Runtimes block lists what is there before anything runs.
  `src/runtime-inventory.ts` is VIEWER-PROCESS-ONLY and read-only (`node:fs`/`node:path`
  only, no process): it mirrors the rule above, and `test/runtime-inventory.test.ts` runs
  the script's own `unused` over every shared case in `test/runtime-uses.ts` and holds the
  two to one answer. It cannot see running processes; the panel only adds an advisory "N
  running sessions report vX" from Live's rows. Each folder's size is its manifest's
  recorded total, and the bounded walk (an lstat per file, about 40 ms for a 4,000-file
  runtime, on Electron main in the packaged app) runs only for an unused runtime, because
  only that one is offered for removal and the prune keeps a folder that no longer
  matches its manifest (`changed`). The prune's check also hashes each file, which the main
  thread cannot, so a file changed in place at the same size and mode shows as unused here
  and the prune keeps it and says why. The list's root is Setup's own: an absolute
  `AGENT_INBOX_RUNTIME_ROOT`, as `setupRuntimeRoot` in `electron/setup-runner.cjs` reads it,
  else `~/.agent-inbox/runtime`. `/api/setup` carries `runtimes {state, unreadable?,
  reason?, removable, entries}`, `reason` in the script's own words and never the JSON
  parser's message, which can quote a secret from the file. The viewer keeps each
  folder's answer per stamp of the folder and its manifest and the whole inventory per
  stamp of the host configs and runtime root (10-minute backstop), so a cold read with
  three runtimes costs about 60-160 ms and a warm one under 1 ms; a change deep inside a
  runtime moves no stamp and shows after the backstop. `removable` holds only in a release
  whose verified payload carries `scripts/prune-runtimes.sh`. The panel offers ONE Remove
  only in a window `available()` grants; it re-reads `/api/setup` just before running and
  runs only if the unused set is still the one its label names, then calls exactly
  `install('prune-runtimes')`: the renderer never sends an id, path or list.
  `electron/runtime-verify.cjs` is the externally anchored verifier: using the digest from
  signed-bundle `setup-info.json`, it synchronously verifies the complete manifest file
  list, hashes, modes, entrypoints and runtime identity at selection and immediately before
  process start. This full hashing blocks Electron main today. The payload's later
  Node/helper verification is self-attesting and catches corruption or argv/source
  mismatch before managed runtime/host mutation, but it cannot establish trust after a
  substitution. The verify-by-path then execute-by-path TOCTOU window remains until a
  later stable-handle/process adapter can provide a snapshot or identity-based handoff.
  `scripts/setup-filesystem.cjs` is the Node-core-only filesystem transaction boundary
  shared by the shipping runtime installer and build-time runtime publisher. It identifies
  plain files/directories with bigint device+inode values (canonical paths are diagnostic,
  never case-folded identity), rejects unusable/zero identity and link-like leaves, stages
  under the destination parent, rechecks identity at each transition, and verifies the
  published name. Immutable runtime install refuses replacement; `stage-runtime --force`
  uses a two-rename backup swap with a visibility gap and explicit recovery retention.
  *(#333)* A new tree is published with one checked rename; only the build-time publisher
  passes `retryBusyRename: true` (strictly a boolean), which makes `stageDirectory` use its
  own `renameWithRetry`: on win32 alone it retries a rename refused with EPERM, EACCES or
  EBUSY for about nine seconds of growing waits, re-running every transaction check itself
  before each attempt, so a substituted stage or a taken destination is still refused,
  never retried into. No caller function decides whether a check runs or a rename happens.
  The shipping installer keeps its single attempt; the Windows folder builder publishes
  its app folder through the same helper.
  This is point-in-time detection, not a stable handle: inode reuse and races after the
  last check remain. The modeled Win32 policy additionally rejects drive-relative,
  drive-less-rooted, device/extended-namespace and ADS-like paths plus junction/reparse
  entries exposed as links. Native Windows x64 folder CI proves only the existing
  immutable runtime create/publish/remove path on NTFS; it does not establish replacement,
  locking, host-mutation, or process-cancellation behavior. Setup therefore remains
  limited to exact Darwin/Linux x64/arm64 hosts.
  Recursive rollback/cleanup must re-identify both the private scratch directory and any
  prior-tree backup immediately before mutation. An identity mismatch refuses restore or
  deletion and retains the untrusted path for recovery; never “clean up” a path whose
  identity check just failed. The adapter creates the empty stage exclusively and captures
  its identity before producer code runs; cleanup also requires that same stage identity
  (or verified absence after publication), so a substituted child is never recursively
  removed merely because its parent scratch directory still matches.
  *(#211)* A runtime prune (`removeDirectory`) re-identifies the validated tree and its
  parent, renames it into a fresh `.trash-<name>-*` folder (`mkdtemp` in the same parent)
  and only then deletes that folder; recursive deletion removes links, never their
  targets. Once the rename commits, the runtime id is free: an interrupted, failed or
  `SIGKILL`ed prune leaves trash, never a half-deleted runtime that a later install of the
  same version would refuse as a collision. A failed trash deletion still counts as
  pruned. Each install and prune first tries to remove up to 16 leftover `.trash-*` entries that
  this uid owns, each pinned by identity and re-checked just before removal (a link is
  only unlinked); a folder whose contents failed the post-rename identity check carries
  a `.retained` marker and is kept for recovery. *(#214)* Only an entry it tries to
  remove counts toward the 16, a failed removal included, so trash it keeps (another
  user's, or marked `.retained`) can never hold back newer trash. Win32 has no owner to compare, so its
  model retains all trash. Nothing named `.trash-*` is ever a runtime: manifests,
  install and prune refuse that id, and `list` skips it.
  `runtime-payload.mjs install` reserves exit 3 for an error carrying
  `committed:true` (usage remains 2 and ordinary failure 1). The shell must treat
  that as “publication may have happened,” reverify a plain exact
  `runtimeRoot/runtimeId` against both the expected runtime ID and source-manifest
  digest, and only then mark a previously absent runtime for the existing
  reference-gated rollback. A substituted/unverified path is retained with an
  explicit unsafe/unknown diagnostic; host configuration remains unchanged and
  the overall install still fails.
  Graceful process termination lets the shell attempt rollback; forced `SIGKILL` can
  terminate without shell or adapter cleanup, so never claim rollback precedes every
  terminal result. *(#208)* `install-agents.sh` handles HUP, INT, QUIT, PIPE, ALRM,
  TERM, XCPU and XFSZ alike: an active transaction rolls back, reports into a
  work-directory log that is replayed to stderr afterwards (bash 3.2 leaks a failed
  write into the next command substitution), and exits 128 + the signal. The shell and
  its non-Node commands then ignore those signals. Node resets them at startup, so
  *(#211)* every Node step of the rollback (a host CLI's `mcp remove` and `mcp get`
  re-check, the runtime reference check and prune) runs through
  `scripts/run-isolated.mjs`, argv only, under the installer's pinned Node. The helper
  ignores HUP/INT/QUIT/ALRM/TERM/XCPU while it waits and hands the command to a guard
  (the same script) started detached in its own session; the guard starts the command
  detached too and owns the bound: after 30 s it signals the command's whole group
  (TERM, then KILL) and exits 124, reported as not finished in time. The guard
  survives the installer's `SIGKILL`, so that bound always applies. A helper killed
  while its own Node is still starting has started nothing and is rerun, at most three
  times. *(#214)* A command that ran and was then killed by one of those signals ends
  the helper with the same 128 + signal status, so the helper first creates a start
  marker (`--started-file`, in the work directory) once it ignores them and before it
  starts anything; it starts nothing when it cannot. Only a restart status with no
  marker is rerun; with the marker, the step is reported like any other failure.
  Neither the guard nor the command gets the installer's stdio (Setup still
  sees its pipes close when the installer dies), but both get fd 9, so the lease lasts
  as long as the step. Forward-path Node steps stay in the installer's group.
  Hosts refuse to remove a server a failed add never registered, so a failed undo
  counts as failed unless a re-check confirms it absent. An exit that neither committed
  nor finished the rollback keeps every MCP snapshot, and a kept snapshot or failed step
  keeps the log too. `SIGKILL` of the installer (Setup's forced stop 10 s after a
  cancel) cannot stop an isolated step that is already running: it still ends within
  its bound and holds the lease until then.
  A failed post-publication cleanup is a committed failure and retains
  its recovery path rather than deleting the only prior tree.
  Every applied agent or hook install sources the adjacent
  `scripts/setup-lock.sh` and holds one kernel-backed user-scoped lease on
  `~/.agent-inbox/install-agents.lock` across preflight, mutation, and rollback.
  The mutating Bash process opens fd 9 itself: Darwin prefers descriptor-mode
  `/usr/bin/lockf` and falls back to same-domain `flock`; Linux uses `flock`
  only. Repeated acquisition in one shell must never reopen fd 9. Every existing
  non-regular lock path is rejected before open, and only conflict exit 75 means
  another setup is running. The descriptor stays open for the whole process
  tree, so an in-flight child cannot outlive a helper-held lease; whole-group
  exit/crash releases ownership unless an isolated rollback step is still
  running (it keeps the lease until it ends, at most its bound), and an
  unexpectedly long-lived descendant can retain it too. File existence never
  implies ownership. The helper is part of the signed runtime manifest, but
  sourcing it by path extends the already retained verify-to-execute race
  rather than closing it.

## History (shipped since v1)

These landed after v1 and still hold invariants; the release history itself is in `CHANGELOG.md`.

- **Build stamp + staleness signal** *(#40)* — `scripts/write-setup-info.mjs` (called by the
  packager, and executable in a test the way `package-app.sh` never can be) bakes `commit` +
  `builtAt` beside the paths setup-info.json already carried; `src/stamp.ts` reads the checkout's
  live HEAD in the VIEWER process and `/api/setup` carries the verdict; `public/buildstamp.js` turns
  it into one line in the Setup panel. Four things are deliberate. (1) **Direction, not difference:**
  `merge-base --is-ancestor` splits a bare SHA mismatch into `stale` (the checkout moved on —
  repackage), `behind` (the CHECKOUT was moved back; the app is NEWER, so repackaging would
  downgrade it and no command is offered) and `diverged`. (2) **The dev path claims nothing** — no
  baked commit means `drift:'dev'`, which reports the live HEAD and never warns. (3) **Fail-open at
  every step**: `readBakedInfo` swallows a corrupt file (it used to throw straight out of the
  handler and empty the whole panel), a non-sha commit is never handed to git as argv, a missing
  repoRoot spawns nothing, `execGit` is timeout-bounded, and the `/api/setup` handler treats a
  throwing probe as "no stamp". (4) **It is NOT attention** — nothing reaches `public/attention.js`,
  `countsByProject` or the dock badge; pinned in `test/stamp.test.ts` (source) and
  `test/dom/build-stamp.test.ts` (the same fixture's badge/tabs/rows under `current` vs `stale`).
  Cadence: the git probe is **lazy and memoized for 60s** (`STAMP_TTL_MS`) — there is no poller, and
  `/api/setup` is fetched once per page load, not on the 3s poll. The #23 reuse path is covered for
  free: a fresh checkout that attaches to a stale packaged server renders that server's stamp.
- **Agent registrations and "Update agents" / "Match agents"** *(#197, part 2)* — what a restarted session loads is what
  its HOST is registered to run, not what is installed. `src/agent-hosts.ts` (VIEWER-PROCESS-ONLY and
  read-only: no process, network, lock or write) reads it from the files the installer manages and keeps
  only `mcpServers['agent-inbox']` from `~/.claude.json` and `~/.copilot/mcp-config.json`, plus the
  agent-inbox-shaped hook entries (`{command, args:[entry, subcommand]}`) in `~/.claude/settings.json`.
  Every other server, env value and secret is parsed in memory and dropped: never returned, logged or
  cached. It never asks the host CLIs (`claude mcp get` health-checks a server by starting it). Kinds are
  `none`, `runtime` (Setup's: runtime id + manifest version), `checkout` (`dist/` beside a `package.json`
  named agent-inbox and no runtime manifest: its root path), `other` and `unknown`. A runtime's layout
  outside the root is never Setup's: `other` for an MCP registration (the installer's `custom`), but
  `unknown` for hooks, which the hook installer refuses beside or replaces (#232). `runtime` is exactly
  the installer's ownership rule (`classifyRuntimeRegistration` in `scripts/runtime-config.mjs`): node and
  entry resolve, by real identity, into the SAME directory under the runtime root, which verifies as an
  intact runtime naming itself. That check uses the shared verifier with THIS app's expectations relaxed
  (version, platform, Node major/ABI, later required files): ownership is the question, and a stricter
  check would hide exactly the older runtimes an update must move. `test/agent-hosts.test.ts` runs the
  installer's helper over the same files and pins agreement (`owned` ⇔ `runtime`, `absent` ⇔ `none`), so
  Setup never offers to update a registration the installer would refuse. The viewer caches the result
  on the three files' link and target stamps plus the runtime root listing (every install changes one)
  with the same 10-minute backstop, hashes each registered runtime once per directory/manifest stamp, and
  reuses the release lookup's stricter verification for the current runtime. `/api/version` adds
  `hosts:{claude,copilot}` as `{kind, version?}` only — no path, id or config — and `updatable`, the one
  rule (`canUpdateAgents`) Setup's action and Live's "update agents" advice share: a release whose own
  runtime payload verifies here, installed or not. `/api/setup` adds `agents`:
  each host and Claude's hooks (a checkout's path included; the owner already sees paths there),
  `current`, `updatable` (a release whose runtime Setup can install here) and `hooksCommand`. The Setup
  panel's Agents block (rules in `public/agents.js` `agentsAction`; every string is textContent) offers ONE
  action only in an Electron window whose `available()` is true, only when `updatable`, and only for the
  Setup-managed hosts whose runtime differs from `current`, in EITHER direction: the installer replaces a
  registration it owns whichever way the version moves, so a downgraded app restores a matching runtime.
  Hosts that are only behind get **Update agents**; a host that is ahead (an app downgrade) gets **Match
  agents to vX**, which also names the one action when hosts differ both ways. Equal versions (build
  metadata ignored) get nothing. It calls the existing `install(target)` once per host, `claude` then
  `copilot`, never `all` and never `--force`: `--target all` stops before changing anything when one
  host's CLI is gone, which would hold the other host back too, so each host is moved and reported on its
  own. A step that was cancelled, timed out or could not run ends the run, and the later hosts are reported
  as not started: a quit cancels the running install, and starting the next host mid-shutdown could have
  the exit kill it halfway through replacing a registration. Main enforces the same thing on its side:
  `createInstallGate()` (`electron/setup-runner.cjs`) is its one record of the running install and of the
  quit, and `beginAppQuit()` in `main.cjs` is the ONE function every quit or restart path calls first
  (`before-quit` on every firing; an update-restart path must call it too). It refuses every later install
  for good, revokes the window's Setup (and #216's window binding never grants it again), cancels the running install and returns a never-rejecting promise
  the caller waits on before exiting. A checkout or custom registration is reported, never switched (the
  runtime-mode installer refuses a registration it does not own anyway). Afterwards it re-reads `/api/setup` and `/api/version` and
  lists, per host that moved, how many running sessions still run a build that differs from what that
  host now runs (older, newer or both) and how to restart them (`claude --resume` / `copilot --resume`);
  it never says a session reloaded. The block also re-reads whenever Settings opens, so a terminal install
  made meanwhile shows up. *(#206)* Claude's hooks move with the agents when they are
  Setup's (kind `runtime`) on another version than `current`, in either direction, and
  `updatable`: one more step, `hooks`, last in the action, so an agent step before it has
  installed this app's runtime; without one it is offered only once that runtime is installed
  (`hooksCommand` is set exactly then). A checkout's, a custom, an unverifiable or a
  version-unknown hook set is never moved. The step runs the installed runtime's own
  `install-hooks.sh --apply --move-only` under its shared lock, backup and manifest-owned
  replacement. `--move-only` (forwarded to `runtime-config.mjs hooks`) exits 1 and writes
  nothing when no Setup runtime's hooks are there to replace, checked under that lock, so
  neither a direct `install('hooks')` nor a set removed after the panel's re-read is ever
  installed afresh; the renderer's re-read before the step only words the message, and a set
  that reached `current` meanwhile is reported as already moved;
  a cancelled, timed-out or unrunnable step before it leaves it "not started". Afterwards the
  hooks count as moved only when the re-read shows them on exactly `current`
  (`hooksGuidance`); otherwise the result is marked failed and says Setup does not see the
  move. Running sessions: Claude Code reads hooks at session start, and its documentation
  says its settings file watcher normally applies a change to running sessions too, so the
  advice says that and names the restart that makes sure, never a reload it cannot see. A
  browser tab, or a window Setup is not granted to, gets the app hint plus
  `bash <runtime>/scripts/install-hooks.sh --apply` once the runtime is installed. *(#278)* A hooks
  line that differs from `current` never ends without a next step (`hooksNextStep`): with no hooks
  step and no `hooksCommand`, a Claude Code registered to a checkout gets that checkout's own
  `cd <path> && npm run install:hooks -- --apply --replace-existing`, built and quoted by the viewer
  (`/api/setup` `checkoutHooksCommand`, present only while Claude Code runs from a checkout whose
  hooks are not that checkout's); the "once this app's runtime is installed" promise stays only while
  `updatable` and an agent host is unregistered or on Setup's runtime, i.e. a Setup install could put
  that runtime in place (Setup never switches a checkout, and a failed install removes a runtime it
  just published). Known limit: `none` also covers a host whose CLI is not installed, which the
  viewer cannot tell apart without running anything, so with Claude Code `other`/`unknown` and no
  Copilot CLI the promise still shows although neither target can keep it (`install-agents.sh`
  stops at "'copilot' CLI is not installed"; `claude` refuses a registration it does not own);
  docs/hooks.md points to the checkout or terminal path instead. Otherwise the panel says Setup
  cannot move them and points at docs/hooks.md. No IPC
  channel, preload method or HTTP route was added for this, and nothing runs at startup. Live's
  `remedy()` maps a runtime session to its host by its inferred agent (`claude-code` → claude, `copilot`
  → copilot) and, for a session OLDER than the app, says "restart this session to load vX" only when that
  host is registered to Setup's runtime at vX or later, "update agents from Setup, then restart this
  session" only when it is an older Setup runtime and `updatable` (so never toward an action Setup does
  not show), and nothing otherwise (a missing `hosts` included). `sessionBuild()` keeps `older` (older
  than the app) separate from `newer`: a runtime session NEWER than the app whose host is now registered
  to exactly the app's build — after Match agents — gets a "newer build (vS) — restart this session to
  load vX" marker in the strip and drawer; one whose host still runs a newer build, or an older one, gets
  none, because a restart would not bring it to the app's build. Known limits: `inferAgent` folds every client named
  like "claude" into `claude-code`, so a Claude Desktop session is advised by Claude Code's registration;
  only user-scope registrations are read, not a project or local one that shadows it; and a checkout's
  version is not read, so its sessions keep the checkout advice.

## Runtime pins (#412)

- **Where and what.** `<runtime root>/.pins/<runtime id>/<launch id>`, written by a running
  `agent-inbox-driver` (`src/driver-pin.ts`): `{v: 1, launchId, pid, startedAt}`, `startedAt`
  being the driver's start identity. OUTSIDE the runtime's folder, because verification rejects
  any file the manifest does not list.
- **One module.** `scripts/runtime-pins.mjs` (Node core only, a payload script and a Setup
  required file) holds the whole rule: the start identity (`processIdentity`/`processIdentities`),
  reading pins, `runtimePins`, `sweepStalePins` and `pinHolds`. The driver writes with it,
  `runtime-config.mjs` adds live pins to "uses" for both prunes (`classifyRuntimeReference`, so
  the installer's prune and rollback, counts a pinned runtime as `referenced`; `findUnusedRuntimes`,
  prune-runtimes.sh's `unused`, as `used`, labelled `a running agent-inbox-driver (pid N)`), and
  `runtime-payload.mjs`'s prune reads it again after the move (below). `dist/` imports it as
  `../scripts/runtime-pins.mjs`, so staging refuses a `dist/` import of any script it does not ship.
- **Start identity.** It must not move while the process runs. Linux: `linux:<boot id>:<ticks>`,
  field 22 of `/proc/<pid>/stat` (counted after the LAST `)`, since the command name may hold
  spaces and parens) with `/proc/sys/kernel/random/boot_id`, read directly; never procps's
  `ps -o lstart=`, which adds the ticks to the boot time, and that moves when the wall clock is
  stepped (NTP, chrony, a VM's time sync), so a live pin would read as stale and its runtime be
  pruned. A zombie counts as gone. macOS: `darwin:` + `ps -o lstart=` under `TZ=UTC` and
  `LC_ALL=C`, spaces collapsed (the kernel's start time is fixed at fork). Anything else, or any
  read that fails: unknown.
- **The viewer mirror.** `src/runtime-inventory.ts` `scanPins` applies the same reading rules and
  checks the pid alone (`kill(pid, 0)`, which starts no process), so a pid reused after a crash
  reads as used there until a prune sweeps the stale pin: it errs toward keeping.
  `test/runtime-inventory.test.ts` holds the two to agreement over the shared `PIN_CASES` in
  `test/runtime-uses.ts`; the viewer's cache key includes the stamps of `.pins` and each
  `.pins/<id>/`, so a pin added or removed is seen at once.
- **What counts.** A real file (never a symlink) owned by this user, at most 1 KB, named by a
  lowercase UUID equal to its `launchId`, with a `startedAt` of 1 to 128 characters, in a real
  `.pins/<id>/` folder owned by this user, under a real `.pins` owned by this user, whose pid still
  has the recorded start identity. Anything else is ignored; a pin naming a runtime that is not
  there pins nothing.
- **Errors only keep.** A `.pins`, `.pins/<id>/` or pin that is there but cannot be read, or an
  identity that cannot be read, makes the answer unknown: the installer keeps the runtime,
  prune-runtimes.sh and the mirror remove and offer nothing. With no pin at all, nothing is read.
- **The gap between check and prune.** The driver pins without the setup lock, and every prune
  decides before it renames. So `pruneRuntime` passes `removeDirectory` a `keep` callback
  (`pinHolds`), asked once the runtime is in its `.trash-*` folder and before anything is
  deleted: a live pin, or pins that cannot be read, put it back (parent, trash and tree
  identity-checked, the name still free) and `prune` prints `{pruned: false, kept: true, reason}`
  and exits 4; install-agents.sh and prune-runtimes.sh report it as kept. A restore that cannot be
  made is `restore-failed` and retains the tree in its trash folder, marked for recovery. The
  driver, for its part, checks after pinning that its runtime's manifest is still there and
  names it, and otherwise removes its pin and refuses to start: a pin written after the prune's
  re-read finds the runtime gone.
- **Which runtime a driver pins.** It is an installed runtime when EITHER the folder above its
  `dist/` holds a runtime manifest naming that very folder (it is then pinned under that folder's
  parent, the root that installed it, wherever that is and whatever `AGENT_INBOX_RUNTIME_ROOT` the
  driver's own environment holds), OR its file sits under the configured root
  (`AGENT_INBOX_RUNTIME_ROOT` when absolute, else `~/.agent-inbox/runtime`, by real path), where it
  must be `<root>/<id>/dist/driver-cli.js` of a runtime whose manifest names `<id>`, or it refuses.
  A manifest beside `dist/` that cannot be read refuses too. Anything else (a checkout, an app's
  bundled payload, whose manifest names no folder of that name) pins nothing. So the command the
  installer prints needs no variable in front of it, even for a custom root.
- **Expiry.** The driver removes its own pin on every exit it sees. A pin whose driver is gone (or
  whose pid now runs another process) is stale and never counts; `sweepStalePins` removes up to 64
  a pass, then empty `.pins/<id>/` folders (`rmdir`, so only empty ones, owned by this user),
  never following a link and removing nothing when the answer is unknown. A driver whose folder a
  sweep removed between making it and opening its pin retries once. Each prune sweeps under the
  setup lock (`runtime-config.mjs sweep-pins`: prune-runtimes.sh with `--apply` only, and
  `prune_old_runtimes`); a dry run sweeps nothing.
- **`.pins` is never a runtime.** `runtime-payload.mjs` `list` skips it, and `install`/`prune` refuse
  it as a runtime id, as they do `.trash-*`; `findUnusedRuntimes` and the mirror skip every `.`-name.
- **Uninstall.** `install-agents.sh --uninstall` (dry run included) asks `runtime-config.mjs pins`
  before it changes anything and refuses while a driver runs, naming its runtime, launch and pid and
  its stop command (`<runtime>/bin/node <runtime>/dist/driver-cli.js stop <launch id>`). A stale pin
  never refuses; pins that cannot be checked refuse.
- **Mixed versions.** Older builds read no pins. An older `list` reports `.pins` as an invalid
  runtime, which an older installer's prune filters out (`valid` only); an older prune-runtimes skips
  every `.`-name and still keeps a runtime a running driver names on its command line (the `ps`
  rule). An older installer's own prune can remove a pinned runtime that no host config uses and that
  is not its newest previous one; the driver keeps running from memory, and the pins are honoured
  from this build on.
