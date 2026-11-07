---
paths:
  - "src/mesh-config.ts"
  - "src/meshctl.ts"
  - "src/unslop-client.ts"
  - "public/agents-home.js"
  - "packages/mesh/src/*.ts"
applyTo: "src/mesh-config.ts,src/meshctl.ts,src/unslop-client.ts,public/agents-home.js,packages/mesh/src/*.ts"
---

# Agent mesh (M1)

The opt-in mesh: `mesh.json` and `meshctl` (#397); the Agents view, which began as mesh M1 and is always on since #454; and `packages/mesh`, where the mesh's agents are built (#483).

Moved out of `CLAUDE.md` and `.github/copilot-instructions.md` by #379, nearly verbatim. Claude Code and Copilot CLI load this file automatically when they read or edit a file matching the `paths`/`applyTo` globs above (through the symlinks in `.claude/rules/` and `.github/instructions/`); anyone else should read it before changing those files.

## In brief

- **The Agents view is always on (#454).** Design:
  [`docs/superpowers/specs/2026-11-04-agents-home-design.md`](../../docs/superpowers/specs/2026-11-04-agents-home-design.md)
  §4, which amends the mesh design's §2.2 (its M1 row), §2.4 (b) and §10.2. `app.js`
  imports `public/agents-home.js` statically; `mesh.json` no longer gates it, the viewer
  no longer watches the file, `/api/version` never carries a `mesh` key, and Settings →
  Mesh is gone. The viewer's watch returns with the first phase that needs it (M3).
- **Opt-in mesh (M2 and later, #397):** `mesh.json` (absolute `AGENT_INBOX_MESH_DIR`,
  else beside `AGENT_INBOX_DB`, else `~/.agent-inbox`) stays the one switch for the
  later phases; only `src/meshctl.ts` writes it (dry run first, `--apply` with backup,
  unknown keys kept; refuses symlinks, non-regular files, bad JSON and newer schemas).
  `src/mesh-config.ts` is the Node-core reader. The one piece read from it is the unslop
  agent's `agents.unslop` key (#483, `enable --unslop`, below); `enable --agents-view`
  writes nothing and says the view is always on, `status` says the same, and an
  `agentsView` key in an existing file is kept like any other.
- **The Agents view** (`public/agents-home.js`, now the Agents home, #454; see
  `viewer-dashboard-and-shell.md`) is the Dashboard's one home for sessions (#454 retired
  the Sessions | Agents lens with the lanes): one card per session from `public/sessions.js`.
  It reads `liveInLens()`, this app's launches (switch on only), the plans the working
  sessions link and the frame's attention entries; it never feeds attention, a badge, count,
  tab, rail or the dock, and fetches nothing. No mesh module enters the stdio MCP graph, the hub
  schema is untouched, and `test/fixtures/app-dependencies.txt` pins the dependency
  set. Nothing puts the meshctl bin on PATH: document `npm run meshctl -- …`.

## Invariants in detail

- **The mesh is opt-in, and off means off (Mesh M2 and later, #397).** Design:
  [`docs/superpowers/specs/2026-10-29-agent-mesh-design.md`](../../docs/superpowers/specs/2026-10-29-agent-mesh-design.md)
  §2. `mesh.json` (in an absolute `AGENT_INBOX_MESH_DIR`, else beside
  `AGENT_INBOX_DB`, else `~/.agent-inbox`) is the one switch, and only `src/meshctl.ts`
  (`agent-inbox-meshctl`, `npm run meshctl`) writes it: dry run by default, `--apply`
  keeps a timestamped `mesh.json.bak-*` of any file it replaces or removes, keeps keys it
  does not own, and refuses a symlink, a non-regular file, unreadable JSON or a newer
  `schema`, naming the reason in fixed words (never a parser's message). `disable --apply`
  is a list of steps that today only deletes the file (with a backup); M4 puts its pause
  and `@mesh` archive steps before that one. `enable --unslop` and `disable --unslop`
  (#483) change only the `agents.unslop` key and the unslop agent's own files; see
  "Turning unslop on and off" below. Since #454, `enable --agents-view` (with or
  without `--apply`) writes nothing and prints "The Agents view is always on; mesh.json no
  longer controls it", and `status` prints the same line before the file's state. A later
  phase that adds a piece brings back an `enable` writer (temp file, atomic rename) with
  it. `src/mesh-config.ts` holds the one reading rule (a regular file ≤ 64 KiB, a JSON
  object, `schema` 1; anything else is off) and `readMesh()`, which meshctl and its unslop
  client (`src/unslop-client.ts`) both use. All three are Node core only and never import
  `store.ts`, and no mesh module may enter the stdio MCP graph (`test/prstate.test.ts`).
  The viewer reads nothing of the mesh today: no stat watch, no `createViewer` option, no
  `/api/version` key. The phase that first needs the viewer to know (M3) restores a watch
  under the same rules the mesh design's §2.1 sets.
- **The Agents view is always on (#454).** `app.js` imports `public/agents-home.js`
  statically and calls `installAgentsHome(...)` at load, so `dead-exports` reaches it like
  any module. Since #454 PR 4 it is the Dashboard's one home for sessions (the lens and
  the lanes are retired): `renderDashboard` mounts `agentsHome.element()` once in the grid,
  and `renderDashboardAmbient` paints it (so both render entries, no third) with
  `liveInLens()`. Since #454 PR 2 it draws one card per session
  (`public/sessions.js`), grouped by project, with "last call" from `last_call_at` (never
  `updated_at`) and asks READ from the frame's `waitingEntries` by session or linked
  plan; `viewer-dashboard-and-shell.md` has the detail. Nothing it draws reaches
  `public/attention.js`, a badge, count, tab or the dock; it fetches nothing,
  runs no timer, and rebuilds a card's part only when what it shows changed. Its state
  is in `frameInputs()`, so a filter, grouping or fold change is never reused across
  frames. `test/mesh.test.ts` and `test/dom/agents-home.test.ts` hold it, including the
  boot's unchanged requests and identical attention surfaces with the Agents home drawn.
  `package-lock.json` records meshctl's root `bin` entry (npm lockfile v3); the dependency
  set does not change, and `test/fixtures/app-dependencies.txt` pins it (package.json's
  dependency and devDependency names and every lockfile package path), so a new package
  fails `test/mesh.test.ts`. A deliberate dependency change outside the mesh refreshes the
  pin with
  `AGENT_INBOX_UPDATE_DEPENDENCY_FIXTURE=1 npx vitest run test/mesh.test.ts -t "dependency set"`.

## packages/mesh (M2a, #483)

`packages/mesh/` holds the mesh pieces that need dependencies the app does not ship:
first the unslop agent (design:
[`docs/superpowers/specs/2026-11-06-unslop-a2a-agent-design.md`](../../docs/superpowers/specs/2026-11-06-unslop-a2a-agent-design.md)),
later the wrappers, the bridge and the bench (mesh design §2.3).

- **It never ships.** It is a separate, non-workspace package with its own
  `package.json` and `package-lock.json`; the root has no `workspaces` key, so its graph
  never reaches the root lockfile or `test/fixtures/app-dependencies.txt`. The root
  `tsconfig.json`, `vitest.config.ts` and `test/dead-exports.test.ts` do not reach it, no
  staging, pruning or packaging script copies it, and no release workflow builds it. The
  only workflow that does is the `mesh-package` job in `.github/workflows/ci.yml`
  (ubuntu, Node 24: `npm ci`, typecheck, tests).
- **U1 (pure modules, no network, no writes):** `fidelity.ts` (§6.1-§6.2: output
  sentences are aligned to input sentences by their words; protected values keep their
  order inside an aligned sentence, and one that crossed sentences must keep its own
  neighbours better than any other value's, ties failing. Negations count per clause
  whatever their form (`not`, `no`, `never`, `n't`, `without`, `none`, …), so "does not
  add any" → "adds no" passes; pattern 9 ("not just X but Y", "not just X — it's Y") is
  removed before counting. Negations and conditions are hard on any drop, on a move to
  another clause (its clause lost the context words on both sides of it, or another
  input clause matches it better; a new subject alone is no move), and on an addition
  unless the same clause dropped a negative word such as "fails". A text with more than 500 sentences or
  values is not compared and reports `tooComplex`), `screen.ts` (§5: text is NFKC
  normalised, zero-width characters removed and `>` quote markers stripped before any
  check; refusal classes are named without the matched value; the `--kind` list),
  `rules.ts` (§3.2: `rules.md` and its SHA-256, re-read on a size or mtime change, the
  last good rules kept and marked stale) and `mesh-config.ts`. Both checks have timing
  tests on hostile 12 KiB inputs.
- **U2a (one task as a function, no listener):** `backend.ts` (§7.1, §8.2: one POST to
  `<base URL>/v1/chat/completions`, the base URL `https://` or `http://` on a loopback
  address literal; `node:http`, so no redirects, no proxy and a 10 s connect limit; the
  profile's model, default `chat-long`, temperature 0.2, top_p 0.9, presence_penalty 0,
  thinking off with `chat_template_kwargs.enable_thinking: false`, never `tools`;
  `max_tokens` = min(1.3 × UTF-8 bytes / 3 + 256, 6144). Any 5xx is busy; a truncated,
  empty, reasoning-only or tool-call answer keeps the original), `prompt.ts` (§8.1: the
  preamble, `rules.md`, the text between `TEXT <nonce> BEGIN`/`END` lines; a retry's
  values to keep sit in their own nonce block, since they come from the text; one
  wrapping code fence removed; an answer with the nonce, or over twice the input plus
  1 KiB, keeps the original) and `unslop.ts` (`runUnslop`: kind, size, control bytes and
  the screen refuse before any network; one retry only when the time left covers its
  output limit at the box's reported speed, else 44 tok/s; a §6.3 result with an exit
  class 0/10/11/12/13; a log callback that gets sizes, timings, classes and check
  results, never text or a matched value; clock, random and transport injectable).
- **U2b (the agent process):** `a2a.ts`, `agent.ts`, `files.ts` and the `wrap.ts` entry.
  Build with `npm ci && npm run build` (Node 24) in `packages/mesh`, then run
  `node packages/mesh/dist/wrap.js --agent openai-compatible --profile unslop` (the
  package's `agent-inbox-wrap` bin). Exit 0 when it stops, 1 when it refuses to start,
  4 on a usage error; it prints only this package's own fixed messages (`ConfigError`),
  and anything else as "internal error", so no file content or key reaches its output.
  `meshctl enable --unslop` (U3a, below) writes its switch and files, and
  `meshctl unslop` (U3b, below) starts it on demand; nothing else starts it (not
  install, build, Electron startup or Setup).
  - **The gate (design §4.5 (e)).** It refuses to start unless `<mesh dir>/mesh.json`
    (the reading rule above) has `agents.unslop.endpoint` equal to
    `http://127.0.0.1:<port>` (not port 80: clients drop `:80` from `Host`); it binds that port on `127.0.0.1` and nothing else
    (`startServer` refuses any other host). It re-reads `mesh.json` and the caller token once a minute and
    exits when the key goes, the endpoint changes, or the token file changes or goes
    (a quick `disable`/`enable` writes a new token this process would otherwise refuse
    until it stopped), and after 30 minutes with no task and no authenticated request.
  - **The files it reads,** all under `<mesh dir>/mesh/`, each a regular file (never a
    symlink) owned by the user with no group or other bits: `wrappers/unslop.json` (the
    profile: `skill` folder, `baseUrl`, `apiKey` as `{ "env": NAME }`, `{ "file": absolute path }`
    or `{ "command": [absolute path, ...args] }` run without a shell, optional `model`,
    `sampling`, `terms`, `allowEmails`, `customerPaths`; other keys are ignored),
    `tokens/unslop` (at least 32 printable characters) and `unslop-deny.txt` (optional,
    re-read for every task). The rules come from the profile's skill folder through
    `rules.ts`. It writes `unslop-budget.json` (today's task count and model time, 0600)
    and `logs/unslop-YYYY-MM-DD.log` (0600, one JSON line per task: id, sizes, timings,
    kind, model, `rulesSha256`, check results and refusal classes; never text, a matched
    value, the token or the API key).
  - **A2A (design §7.3, §8.3).** A hand-rolled JSON-RPC subset of A2A 1.0 on `node:http`
    (no `@a2a-js/sdk`: its server adapters need Express and carry push-notification and
    database surfaces this agent would have to disable). `GET /.well-known/agent-card.json`
    needs no token; `POST /` takes `SendMessage`, `SendStreamingMessage`, `GetTask` and
    `CancelTask` with `A2A-Version: 1.0` and `Authorization: Bearer <token>`
    (`timingSafeEqual` after a length check). Any `Origin` header, a `Host` other than
    `127.0.0.1:<port>`, a push-notification config, a message that continues a task, a
    body over 64 KiB and a request not received within 10 s are refused. The message is
    one text part; `metadata["urn:agent-inbox:ext:unslop:v1"]` carries `kind` and
    `timeoutMs` (default 280000). Streaming sends status only (`waiting`, `editing`,
    `checking`, `retrying`); the text arrives once, in an artifact sent with `COMPLETED`
    (a text part and a data part with §6.3's report). A task belongs to the token that
    created it; the last 64 finished tasks stay readable. A stream that disconnects does
    not cancel its task: the CLI falls back to `GetTask` (§7.3), so the task runs on and
    only `CancelTask`, the task limit or the agent stopping ends it early. A task always
    reaches a final state: a budget write that fails refuses the task (`take`) or is
    reported on stderr (`spend`), and any other failure inside the server ends it
    `FAILED` "internal". Stopping the agent logs each task that never started.
  - **Queue and budget (design §7.2).** One task runs and one waits; a third, or one whose
    estimated wait plus its own estimate (`max_tokens` at 44 tok/s) exceeds its
    `timeoutMs`, is `REJECTED` as busy (12) with `retryAfterMs`. A task gets at most
    270 s from its start, and never more than what queueing left of its `timeoutMs`. After 200
    tasks or 180 model-minutes in a local day, tasks are `REJECTED` "daily-budget" (11).
- **Turning unslop on and off (U3a, unslop design §4.2-§4.3).** From a checkout, build
  `packages/mesh` (`npm ci && npm run build` there, Node 24), then run
  `npm run meshctl -- enable --unslop [--port <n>] [--checkout <path>]`: a dry run that
  prints every file it would write; add `--apply` to write them. `--checkout` defaults to
  the checkout this meshctl runs from, and `enable` refuses when its
  `packages/mesh/dist/wrap.js` is missing. The port defaults to 4420; the endpoint is
  always `http://127.0.0.1:<port>`, and port 80 or one outside 1-65535 is refused. With
  `--apply`, in this order (so the switch is the last thing written):
  1. the caller token `<mesh dir>/mesh/tokens/unslop` (0600, 32 random bytes in
     base64url), only when absent;
  2. the profile template `<mesh dir>/mesh/wrappers/unslop.json` (0600), only when
     absent and never overwritten. Its `skill`, `baseUrl` and `apiKey.env` are
     `FILL IN: …` placeholders the agent refuses (not absolute, not a URL, no such
     variable). Fill in the skill folder (the one holding `rules.md`), the backend's
     base URL and the key source (`{ "env": NAME }`, `{ "file": "/absolute/path" }` (0600)
     or `{ "command": ["/absolute/path", ...] }`), or remove `apiKey` when the backend
     needs none. `model` and `sampling` hold the agent's defaults; `terms`,
     `allowEmails` and `customerPaths` start empty. `start` is the agent's command as
     absolute paths: the Node binary running meshctl (`process.execPath`) and the
     checkout's `wrap.js`. When the profile is present, `enable` keeps it and prints the
     `start` it would have written: if Node or the checkout moved, edit `start` by hand;
  3. the shim `<mesh dir>/bin/unslop` (0755, rewritten each time), holding its mesh dir
     (exported as `AGENT_INBOX_MESH_DIR`, so the caller's environment cannot move it) and
     the absolute paths of that Node binary and the built `meshctl.js` (`dist/meshctl.js`, so run
     `npm run build` at the root first). When either is gone it discards piped input
     (never a terminal), prints "run meshctl enable --unslop again" and exits 14;
     otherwise it runs `meshctl unslop` (below);
  4. `agents.unslop` = `{ "endpoint": "http://127.0.0.1:<port>", "profile": "unslop" }` in
     `mesh.json` (created with `schema` 1 when absent), every other key kept, written
     through a temporary file and a rename after a timestamped backup.
  New folders are 0700. The deny list `<mesh dir>/mesh/unslop-deny.txt` is Shariq's to
  write; no backend URL, key or deny list is written by meshctl or put in `mesh.json`.
  `disable --unslop [--purge] [--apply]` removes the key (deleting `mesh.json`, with a
  backup, when nothing else is left in it), the shim and the token, and keeps the
  profile, logs, budget and deny list unless `--purge`, which also removes those and
  `logs/unslop-*`. Plain `disable --apply` still deletes the whole file. `status` adds an
  `Unslop:` line: on and its endpoint, or off, and whether the profile, token and shim
  exist. `test/mesh.test.ts` holds off test (g) (enable then disable leaves the tree as it
  was, but backups and the profile), the modes, the refusals, the stale shim, and the
  template run through the agent itself; off test (e) is the agent's own gate, tested in
  `packages/mesh/test/a2a.test.ts`.
- **Calling unslop: `meshctl unslop` (U3b, unslop design §4.3-§4.5, §6.3, §7.3).** The
  shim runs `meshctl unslop --kind <kind> [--report <file>] [--timeout <s>] [--in <file>] < draft`;
  the client is `src/unslop-client.ts`, Node core plus `mesh-config.ts`, imported only by
  meshctl (its entry awaits it, since `runMeshctl` stays synchronous). User page with the
  callers' `SKILL.md` text: [`docs/unslop.md`](../unslop.md). In order:
  1. **Locally, before the switch is read:** arguments (else 4); the kind (`pr`, `issue`,
     `release-notes`, `docs`, `blog`, else 11); a `--report` path that is a symlink or not a
     regular file (4); a terminal on stdin (4: it never reads `/dev/tty` and never prompts,
     because an assistant's shell may have a pseudo-terminal); the draft, at most 12 KiB of
     valid UTF-8 and not blank (else 11).
  2. **Off (§4.5 (f)):** no `agents.unslop` by the reading rule, or an endpoint other than
     `http://127.0.0.1:<port>`, exits 14 before any spawn or connection.
  3. **Discovery (§4.4):** `GET /.well-known/agent-card.json` with the exact `Host`. When
     the connection is refused it starts the profile's `start` argv (no shell; only from a
     user-owned 0600 regular profile; detached, unref'd, cwd and `AGENT_INBOX_MESH_DIR` the
     mesh dir, stdout and stderr appended to `<mesh dir>/mesh/logs/unslop-agent.log`, 0600)
     and polls the card for up to 10 s, giving up early once the child has exited and the
     card still does not answer (a second caller's agent that lost the port race exits, and
     the first one's card answers). Anything else answering, or a card without the `unslop`
     skill, a JSON-RPC interface with `protocolVersion` `1.0`, or the
     `urn:agent-inbox:ext:unslop:v1` extension with `api: 1`, is 14 with "rebuild
     packages/mesh". A missing or non-private token is 14; so is HTTP 403, and HTTP 401, which means a
     running agent still holds an older token (it stops at its next minute tick, so the
     message says to run the command again shortly).
  4. **The call (§7.3):** one `SendStreamingMessage` with the kind and `timeoutMs` (the
     `--timeout`, default 280 s, at most 600) in the extension's metadata. Status texts go
     to stderr as `unslop: <state>`. Every stderr line has C0 control bytes (but tab and
     newline), DEL and C1 controls removed: agent-supplied text (status, reason, classes,
     warnings) lands in an assistant's shell output and must not carry terminal escapes. If the stream ends before a final state it says so and
     calls `GetTask` every 5 s (`pollMs` in tests) until a final state, a JSON-RPC error,
     three failed polls in a row or the deadline. At the deadline it sends `CancelTask`
     (best effort, 2 s) and exits 13. No push notifications.
  5. **The result (§6.3):** `COMPLETED` with code 0 prints the artifact's text to stdout
     and a one-line summary (status, model, attempts, the first 12 hex of `rulesSha256`,
     each warning) to stderr; code 10 is "kept the original" (10); `REJECTED` is 12 when
     its data says busy (with "try again in about N s") and 11 otherwise (the refusal and
     screen classes, never a value); `FAILED`, `CANCELED`, an unknown state or a lost agent
     is 13. `--report` writes the final data part (the §6.3 JSON: `code`, `status`,
     `reason`, `screen`, `failures`, `rulesSha256`, `model`, `attempts`, `hard`, `warnings`,
     `ms`, `skillStale`) through `O_NOFOLLOW`, mode 0600, for every final state that has
     one; a report it cannot write makes the exit 13. **On every exit but 0 stdout is
     empty**, and callers edit the original in-session without retrying.
  `test/unslop-client.test.ts` holds (f) (a counting listener and a spawn spy over a
  missing file, no key, a newer schema, a symlink and non-loopback endpoints), the card
  check, the terminal rule (an `isTTY` stdin, and the real CLI under `script`), and end to
  end runs against the agent's source (through tsx, so the root suite needs no
  `packages/mesh` build) and a fake backend: the on-demand start and its reuse, 0 with a
  0600 report, 10, 11, 12, a stream cut by a proxy that falls back to `GetTask`, and a
  deadline whose `CancelTask` aborts the backend call. Off tests (a)-(d): the import graph
  test lists the client, `test/mesh.test.ts` pins its imports and checks that no viewer,
  `public/` or `electron/` file names it, and the dependency and snapshot-trigger fixtures
  are unchanged.
- **One `mesh.json` rule, held twice.** The package cannot import `src/mesh-config.ts`,
  so it carries a reader with the same rule and the same `meshDir()` order. The cases in
  `test/fixtures/mesh-json/cases.json` run in both suites: `test/mesh-json-parity.test.ts`
  (through `meshctl status`) and `packages/mesh/test/mesh-config.test.ts`. Change the rule
  in both places and add a case there.
- **Run its tests:** `cd packages/mesh && fnm exec --using=24 npm ci && npm run typecheck && npm test`.
- **Bench S11 (U4, unslop design §9.1, §9.3).** `packages/mesh/bench/s11/`, compiled by
  `tsconfig.bench.json` into `dist/bench/` and run as `npm run bench -- run|score`; Node
  core plus the package's own `files.ts` and `mesh-config.ts`, never built by the
  package's `build` or any workflow. `fixtures.ts` generates the texts from a seed
  (default 1100: the bench changes only between phases): each edit's traps are literal
  fragments that must share a sentence, checked by `score.ts` independently of
  `fidelity.ts`. `run.ts` refuses a run folder inside the checkout, writes 0700 folders
  and 0600 files through `writePrivate`, calls the client per fixture with `--report`,
  and adds the fictional `Acme Widgets` to `unslop-deny.txt` only while private fixtures
  run (restoring the file after, also on SIGINT and SIGTERM). The sampling comparison is a
  second agent in its own mesh dir with the box's default sampling in its profile, not a
  switch in the agent. How to run it and read `summary.md`: [`docs/unslop.md`](../unslop.md).
  Tests: `packages/mesh/test/bench-s11.test.ts` (recorded runs, no network).
