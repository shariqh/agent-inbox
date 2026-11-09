---
paths:
  - "src/mesh-config.ts"
  - "src/meshctl.ts"
  - "src/unslop-client.ts"
  - "src/request-post-client.ts"
  - "src/agent-card.ts"
  - "src/mesh-agents.ts"
  - "public/agents-home.js"
  - "public/mesh-section.js"
  - "packages/mesh/src/**/*.ts"
applyTo: "src/mesh-config.ts,src/meshctl.ts,src/unslop-client.ts,src/request-post-client.ts,src/agent-card.ts,src/mesh-agents.ts,public/agents-home.js,public/mesh-section.js,packages/mesh/src/**/*.ts"
---

# Agent mesh (M1)

The opt-in mesh: `mesh.json` and `meshctl` (#397); the Agents view, which began as mesh M1 and is always on since #454; and `packages/mesh`, where the mesh's agents are built (#483).

Moved out of `CLAUDE.md` and `.github/copilot-instructions.md` by #379, nearly verbatim. Claude Code and Copilot CLI load this file automatically when they read or edit a file matching the `paths`/`applyTo` globs above (through the symlinks in `.claude/rules/` and `.github/instructions/`); anyone else should read it before changing those files.

## In brief

- **The Agents view is always on (#454).** Design:
  [`docs/superpowers/specs/2026-11-04-agents-home-design.md`](../../docs/superpowers/specs/2026-11-04-agents-home-design.md)
  §4, which amends the mesh design's §2.2 (its M1 row), §2.4 (b) and §10.2. `app.js`
  imports `public/agents-home.js` statically; `mesh.json` no longer gates it, and Settings →
  Mesh is gone. The viewer reads `mesh.json` lazily for the agent cards view (below).
- **Opt-in mesh (M2 and later, #397):** `mesh.json` (absolute `AGENT_INBOX_MESH_DIR`,
  else beside `AGENT_INBOX_DB`, else `~/.agent-inbox`) stays the one switch for the
  later phases; only `src/meshctl.ts` writes it (dry run first, `--apply` with backup,
  unknown keys kept; refuses symlinks, non-regular files, bad JSON and newer schemas).
  `src/mesh-config.ts` is the Node-core reader. The pieces read from it are the unslop
  agent's `agents.unslop` key (#483, `enable --unslop`, below) and the remote request-post
  agent's `agents.request-post` key (#500, `enable --request-post`, below); `enable --agents-view`
  writes nothing and says the view is always on, `status` says the same, and an
  `agentsView` key in an existing file is kept like any other.
- **The Agents view** (`public/agents-home.js`, now the Agents home, #454; see
  `viewer-dashboard-and-shell.md`) is the Dashboard's one home for sessions (#454 retired
  the Sessions | Agents lens with the lanes): one card per session from `public/sessions.js`.
  It reads `liveInLens()`, this app's launches (switch on only), the plans the working
  sessions link and the frame's attention entries; it never feeds attention, a badge, count,
  tab, rail or the dock, and reads `/api/mesh/agents` only for its Mesh agents section, and only
  when `/api/version` carries `mesh`. No mesh module enters the stdio MCP graph, the hub
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
  "Turning unslop on and off" below. `enable --request-post` and `disable --request-post`
  (#500) do the same for `agents.request-post`; see "Turning request-post on and off" below. Since #454, `enable --agents-view` (with or
  without `--apply`) writes nothing and prints "The Agents view is always on; mesh.json no
  longer controls it", and `status` prints the same line before the file's state. A later
  phase that adds a piece brings back an `enable` writer (temp file, atomic rename) with
  it. `src/mesh-config.ts` holds the one reading rule (a regular file ≤ 64 KiB, a JSON
  object, `schema` 1; anything else is off) and `readMesh()`, which meshctl and its unslop
  and request-post clients (`src/unslop-client.ts`, `src/request-post-client.ts`) use. All four are Node core only and never import
  `store.ts`, and no mesh module may enter the stdio MCP graph (`test/prstate.test.ts`).
  `src/agent-card.ts` holds the one A2A card rule, `checkCard(card, agent)`: the agent's
  skills, an A2A 1.0 JSON-RPC interface and its extension with `api: 1`, returning a fixed
  reason or undefined. Both clients call it and keep their own exit codes and words around it
  (agent cards view design §4.4, slice V1). It imports nothing at all (`test/mesh.test.ts`
  pins that), and `test/prstate.test.ts` names it in the stdio graph's forbidden list, since
  its name misses the `/mesh/i` net.
  The viewer reads the mesh only in `src/mesh-agents.ts` (the agent cards view, design
  `docs/superpowers/specs/2026-11-09-agent-cards-view-design.md`): `viewer-server.ts` passes it to
  `createViewer` as `opts.mesh`. It `lstat`s `mesh.json` only when a page reads `/api/version` or
  `/api/mesh/agents`, at most once every 5 s, and re-reads the file by `readMesh()`'s rule only when
  its identity, size or times changed; no timer and no `fs.watch`. `/api/version` carries
  `mesh: { agents: n }` only when the file reads present and names an agent this build knows;
  otherwise its bytes are unchanged. It fetches each agent's card from the configured endpoint only
  (never a URL from a card), with no token, no redirect, no proxy, a 64 KiB cap and one total
  deadline (3 s for unslop, 5 s for every request-post check), only on
  `POST /api/mesh/agents/refresh` with the open trigger (boot on the Dashboard,
  `showAgentsHome()`, `selectTab('dashboard')` from another tab: `meshOpen()` in `public/app.js`)
  or a Refresh press; reading
  `/api/mesh/agents` never starts a check, and one check per agent runs at a time. An `open`
  skips an agent checked in the last 60 s, a `refresh` one checked in the last 5 s. Records live
  in memory only (a viewer starts every agent `unchecked`; a changed endpoint starts a fresh
  record); a failure after a good card reports the failure, with the good card as `lastSeen`,
  never as `card`. `GET /api/mesh/agents` is built fresh per read with an ETag over its bytes
  (not a retained snapshot). It never starts an agent and never opens `mesh/tokens` or
  `mesh/wrappers`; `test/mesh.test.ts` pins its imports to `node:fs`, `node:http`, `node:https`,
  `node:net` (types), `./agent-card.js` and `./mesh-config.js`, so no `child_process`. Its
  user-facing `reason` and `fix` words live in `src/mesh-agents.ts`, so the text guard on
  `src/viewer*.ts`, `public/*.js` and `electron/*` stays as it is. `src/agent-card.ts` holds the
  one card rule both clients and the view use, and the view's `summarizeCard` (caps, "+N more",
  control, bidirectional and separator characters replaced) and `cardJson` (the raw card with
  those characters escaped). The view never reaches attention.
  The page side (slice V3) is `public/mesh-section.js` (named apart from `src/mesh-agents.ts`,
  since `test/dead-exports.test.ts` needs unique module basenames), mounted by
  `public/agents-home.js`; `viewer-dashboard-and-shell.md` has its rules.
- **The Agents view is always on (#454).** `app.js` imports `public/agents-home.js`
  statically and calls `installAgentsHome(...)` at load, so `dead-exports` reaches it like
  any module. Since #454 PR 4 it is the Dashboard's one home for sessions (the lens and
  the lanes are retired): `renderDashboard` mounts `agentsHome.element()` once in the grid,
  and `renderDashboardAmbient` paints it (so both render entries, no third) with
  `liveInLens()`. Since #454 PR 2 it draws one card per session
  (`public/sessions.js`), grouped by project, with "last call" from `last_call_at` (never
  `updated_at`) and asks READ from the frame's `waitingEntries` by session or linked
  plan; `viewer-dashboard-and-shell.md` has the detail. Nothing it draws reaches
  `public/attention.js`, a badge, count, tab or the dock; it fetches nothing but the
  Mesh agents section's `/api/mesh/agents` (only while `/api/version` carries `mesh`),
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
  (ubuntu, Node 24: `npm ci`, typecheck, tests). Its one runtime dependency,
  `@a2a-js/sdk` pinned to exactly 1.3.0 (which brings `jose`), is in that lockfile only.
- **U1 (pure modules, no network, no writes):** `fidelity.ts` (§6.1-§6.2: output
  sentences are aligned to input sentences by their words; protected values keep their
  order inside an aligned sentence, and one that crossed sentences must keep its own
  neighbours better than any other value's, ties failing. Negations count per clause
  whatever their form (`not`, `no`, `never`, `n't`, `without`, `none`, …), so "does not
  add any" → "adds no" passes; pattern 9 ("not just X but Y", "not just X — it's Y") and a
  short list of negated clichés the rules cut ("not all sunshine and rainbows", "no silver
  bullet", "not rocket science", …) are removed before counting. Negations and conditions are hard on any drop, on a move to
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
  Build with `npm ci && npm run build` (Node 24) in `packages/mesh`, re-run after a pull
  that changes its lockfile, then run
  `node packages/mesh/dist/wrap.js --agent openai-compatible --profile unslop` (the
  package's `agent-inbox-wrap` bin). `wrap.ts` loads each agent with `await import()` for
  its own `--agent`, so unslop's start never loads `@a2a-js/sdk`. Exit 0 when it stops, 1 when it refuses to start,
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
    (written before the package had `@a2a-js/sdk`; the SDK's Express adapters are not
    needed, but its core `./server` entry is, as web search's W1 below shows. Moving
    unslop onto it is web search's optional slice W8). `GET /.well-known/agent-card.json`
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
  the client is `src/unslop-client.ts`, Node core plus `mesh-config.ts` and `agent-card.ts`, imported only by
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
- **Web search W1: the SDK spike (#505, #498; web search design §3, §4.1, §13).** The
  third agent, `--agent web-search --profile web-search`, the first on `@a2a-js/sdk`.
  Nothing starts it yet (`meshctl enable --web-search` and `meshctl web-search` are W5),
  and it answers every query from one fixed result until the provider (W3) and the answer
  (W4) land.
  - `web-search/front-door.ts` is its own `node:http` front door (it shares no code with
    `a2a.ts`): `127.0.0.1` only, any `Origin` refused, `Host` exactly `127.0.0.1:<port>`,
    the bearer token compared with `timingSafeEqual` after a length check, `A2A-Version`
    `1.0` or `1.0.<n>` (else -32009; the SDK is always handed `1.0`: its core transport
    checks no version), a 16 KiB body, a 10 s read limit (Node checks it on a sweep, every
    second here rather than its default 30 s) and at most 16 open connections. It then **rebuilds** the
    JSON-RPC request from an allowlist in camelCase (`SendMessage` and
    `SendStreamingMessage`: one `ROLE_USER` text part, the extension's §4.2 fields,
    `returnImmediately: false` and `acceptedOutputModes`; `GetTask` and `CancelTask`:
    `id`). Any other key at any level, in either spelling (the SDK's decoders accept
    `task_id`, `reference_task_ids`, `return_immediately`, … and `params.tenant`), and every
    other method is refused with -32602 before the SDK. No Task response carries `history`
    (the query and every status message), since W2: the task store keeps none, and the
    rebuilt sends and `GetTask` also ask for none with one field of the front door's own,
    `historyLength: 0`.
    The rebuilt object goes to the SDK's
    `JsonRpcTransportHandler` over `DefaultRequestHandler`, with a task store owned per token
    that keeps the last 64 finished tasks (the SDK's `InMemoryTaskStore` cannot evict).
  - `web-search/agent.ts`: the card (§4.1: nothing per copy but the interface URL), the
    `mesh.json` gate (`agents.web-search.endpoint`), the token file
    `<mesh dir>/mesh/tokens/web-search`, the one-minute tick and 30-minute idle exit as
    unslop's, and a task log `logs/web-search-YYYY-MM-DD.log` (id, query length and word
    count, mode, outcome, time; never the query). The executor **never rejects**: the SDK
    would `console.error` the error and put its message in the `FAILED` status it returns,
    so a stage that throws ends the task `FAILED` "internal" here instead. At start every
    `console` method writes one fixed `sdk: <method>` line, `uncaughtException` and
    `unhandledRejection` write `agent: uncaught <built-in class>`, fail every open task and
    exit 1, and the default `warning` listener is replaced by `agent: warning <known name>`.
  - `a2a-client.ts`: `identityFetch`, the fetch the SDK client uses (over `node:http`: no
    redirects, no proxy; any 3xx, and any URL other than the configured endpoint's `/` and
    card path, is refused, so a card's interface URL cannot send the token elsewhere). The
    card request carries a fresh `A2A-Mesh-Challenge` nonce, and the token goes out only
    on a keep-alive connection whose answer matched: `A2A-Mesh-Proof` =
    HMAC-SHA256(token, `"web-search/v1\n" + nonce`). A request handed a new connection sends
    nothing on it, closes it and proves again first, so after the agent exits a squatter on
    its port gets neither the token nor the query, even from a long-lived client.
    `resolveCard` returns the checked card and `cardHash`: the SHA-256 of the SDK's JCS form
    of the card with every `supportedInterfaces[].url` removed.
  - Tests (`packages/mesh/test/web-search.test.ts`): the SDK's client through
    `identityFetch` and a Node-core client drive all four methods over loopback; every
    allowlist, Origin, Host, token and version refusal goes through the real server with a
    spy on `JsonRpcTransportHandler.handle`; squatter, redirect and foreign-URL cases never
    see the token; child processes (run from source through `test/ts-hooks.mjs`) prove
    unslop's start loads no SDK module and that a canary query reaches neither stderr nor a
    log when a stage throws, a provider error carries `?q=`, `console` is called, a warning
    is emitted, a timer callback throws or a rejection goes unhandled.
- **Web search W2: conformance fixtures (#505; design §11).** `test/fixtures/a2a-web-search/`
  ([README](../../test/fixtures/a2a-web-search/README.md)): the card and its hash, one exchange
  per §4.4 row, the refusals, provider shapes for W3, injected pages, `screen.json`,
  `grounding.json`, and a Node-core validator (`conformance.ts`) with a manifest. The card and
  exchanges are recorded from W1's server by `packages/mesh/test/web-search-record.ts`, with ids,
  timestamps and the port replaced by placeholders; `web-search-fixtures.test.ts` re-records in
  memory and fails on any difference, sends every refusal fixture through the real front door,
  and checks `screen.json` against unslop's five classes. `test/a2a-web-search-fixtures.test.ts`
  runs the validator over every file at the root.
- **Web search W3: providers (#505; design §5, §6, §7.1, §9).** Not wired into the executor
  yet (W4 adds the answer, W5 the profile and `meshctl`); `createSearch()` in
  `web-search/search.ts` is one search as a function.
  - `provider.ts`: §5.3's `SearchProvider`, `PageFetcher` and fixed `ProviderReason`s, and the
    one transport (`node:http(s)`, a fresh socket, no redirects: a 3xx is `bad-response`; no
    proxy environment). A failure is a fixed reason, never a URL (a `?q=` holds the query), a
    body or a key; adapters never read a rejection's message.
  - `searxng.ts`: `GET /search?q=…&format=json&categories=general&language=en` (+ `time_range`;
    `sites` as `site:` terms in `q`, exclusions filtered after)
    on an endpoint that must be `https://<name>.<tailnet>.ts.net[:<port>]` or
    `http://127.0.0.1:<port>` (request-post's rule, held again here); reads only
    `results[].url/title/content/engines/publishedDate`. `ollama.ts`: `web_search` and
    `web_fetch` on `https://ollama.com` with the bearer key, read through `key-source.ts`
    (unslop's `{ env }`, `{ file }`, `{ command }` resolver, moved there from `agent.ts`).
  - `search.ts`: shape (`query.ts`) and `screenQuery()` before any network; the memory cache
    (`cache.ts`: key over the normalised query, recency, maxSources, sorted sites, `pages`;
    a `sources` call may reuse an `answer` entry, `fresh` replaces; a hit spends nothing);
    SearXNG through `budget.ts`'s pacer (one at a time, 2 s apart, 5 s wait, else busy 12)
    and caps (SearXNG 30/h, 100/day; Ollama search and fetch together 30/h, 150/day; persisted,
    a cap is 11); Ollama's search when SearXNG has fewer than 3 usable results (`filter.ts`) or
    failed, merged by URL; an Ollama 429 is 12 with its `Retry-After`; `web_fetch` for at most
    the top 3 results without page text in `answer` mode with `fetch: "ollama"` (a failed fetch
    keeps the snippet and warns `fetch-failed`; a result with any warning is not cached); passages
    (`passages.ts`: navigation dropped, BM25, at most 3 chunks and 2,400 characters a source).
  - `screenQuery()` in `screen.ts` runs unslop's email, phone, secret, customer-path and
    deny-list classes (deny = `web-search-deny.txt` and `unslop-deny.txt`, read fresh) plus
    `private-name` (an address inside this Mac's interface subnets but the router list; a
    `.local`, `.internal` or `.ts.net` host with a specific first label; the tailnet's own
    name) and `home-path` (`/Users/<user>/`, `/home/<user>/` for this user).
  - Tests (`packages/mesh/test/web-search-providers.test.ts`) use counting fakes answering
    from `test/fixtures/a2a-web-search/providers/`, and loopback for the redirect case; the
    canary child also runs the real search with a transport whose error carries `?q=` and the key.
- **Bench S11 (U4, unslop design §9.1, §9.3).** `packages/mesh/bench/s11/`, compiled by
  `tsconfig.bench.json` into `dist/bench/` and run as `npm run bench -- run|score`; Node
  core plus the package's own `files.ts` and `mesh-config.ts`, never built by the
  package's `build` or any workflow. `fixtures.ts` generates the texts from a seed
  (default 1100: the bench changes only between phases): each edit's traps are literal
  fragments that must share a sentence, checked by `score.ts` independently of
  `fidelity.ts`. `run.ts` refuses a run folder inside the checkout, writes 0700 folders
  and 0600 files through `writePrivate`, calls the client per fixture with `--report`,
  and adds the fictional `Acme Widgets` to `unslop-deny.txt` only while private fixtures
  run (restoring the file after, also on SIGINT, SIGTERM and SIGHUP). It writes
  `unslop-deny.txt.s11-added` first, so a run killed before it could restore has its line
  removed by the next run. The blind sheet holds edits only; `--new-blind` merges into the
  existing key and answers. The sampling comparison is a
  second agent in its own mesh dir with the box's default sampling in its profile, not a
  switch in the agent. How to run it and read `summary.md`: [`docs/unslop.md`](../unslop.md).
  Tests: `packages/mesh/test/bench-s11.test.ts` (recorded runs, no network).

## request-post conformance fixtures (M2b R1, #500)

request-post is the mesh's second agent, hosted by the private publishing service (design:
[`docs/superpowers/specs/2026-11-07-request-post-a2a-agent-design.md`](../../docs/superpowers/specs/2026-11-07-request-post-a2a-agent-design.md)).
This repository ships its client (R2 and R3 below) and the contract both sides test against: `test/fixtures/a2a-request-post/` ([README](../../test/fixtures/a2a-request-post/README.md)).

- **What is there:** the card, one request and response per §3.3 row (14, 15 and 4 are
  client-side only, with a note and no task) plus one filed under an overridden key
  (`keyOverride: true`, added with R3), a `request-post-status` snapshot per phase,
  `awaiting-go` included, title and request-key vectors with their pre-images, and
  `conformance.ts`, the validator: Node core only and erasable TypeScript, so the private
  repository runs it on Node 24 without a build. The README lists what R1 pins that the
  design left open (the `skill` metadata field, where the data part sits, refusal and snapshot
  shapes, the key's exact pre-image and base32).
- **It lives under `test/`** because nothing that ships uses it yet, and
  `test/dead-exports.test.ts` counts no test as a consumer. R3's `src/request-post-client.ts`
  computes the key itself and runs `keys.json` against it; R3's fake server is built from these
  fixtures, never the service.
- **The private repository vendors the folder** at a pinned commit and records the SHA-256 of
  `MANIFEST.json`, which lists every other file's SHA-256; its tests check that hash and
  `checkManifest()`, then run the fixtures and its own responses through the validator. Never
  edit a vendored copy; a contract change here is a new commit to vendor.
- **Changing a fixture:** edit it, then regenerate the manifest with
  `node test/fixtures/a2a-request-post/conformance.ts manifest > test/fixtures/a2a-request-post/MANIFEST.json`
  (Node 24). `test/request-post-conformance.test.ts` checks every fixture, the mutations the
  validator must catch, the key vectors and the manifest.
- **Turning request-post on and off (R2, request-post design §6, §8).** It mirrors U3a for a
  remote agent: there is nothing to build, spawn or profile. The service's runbook gives each
  device a bearer token; save it in a file, then run
  `npm run meshctl -- enable --request-post --endpoint <url> --token-file <path>` (a dry run
  that prints every file it would write, never the token) and add `--apply`.
  - **The endpoint rule** is `requestPostEndpoint()` in `src/mesh-config.ts`, separate from
    unslop's `loopbackPort()`, which is unchanged: `https://<name>.<tailnet>.ts.net` (exactly
    two lower-case DNS labels before `ts.net`) with an optional port, or, for the SSH fallback
    only, `http://127.0.0.1:<port>`. No path, user, query, leading zero or written-out default
    port (`:443` on https, `:80` on the loopback form, since clients drop it from `Host`); one
    trailing `/` is dropped, and the rest is stored as given. Anything else (a public host, an IP
    literal other than that loopback, `http` to another host) is refused with one fixed message
    that never echoes the input, and an `agents.request-post` that breaks the rule reads as off.
  - **The token file** must be a regular file the user owns (opened `O_NOFOLLOW | O_NONBLOCK`,
    so a symlink, folder or FIFO is refused without hanging), at most 4 KiB, holding one run of at
    least 32 visible ASCII characters (one trailing newline allowed). Refusals name the rule,
    never the content.
  - With `--apply`, in this order (the switch last): 1. the token copied to
    `<mesh dir>/mesh/tokens/request-post` (0600, through an `O_EXCL | O_NOFOLLOW` temporary
    file and a rename; a newer token from the runbook replaces it); 2. the shim
    `<mesh dir>/bin/request-post` (0755), the unslop shim's text with the agent's name: it pins
    its mesh dir, and when its Node or `meshctl.js` is gone it discards piped input, prints "run
    meshctl enable --request-post again" and exits 14; otherwise it runs
    `meshctl request-post "$@"` (R3, below);
    3. `agents.request-post` = `{ "endpoint": <url> }` in `mesh.json`, every other key kept,
    written atomically after a timestamped backup. New folders are 0700.
  - `disable --request-post [--apply]` removes the key (deleting `mesh.json`, with a backup,
    when nothing else is left), the shim and the token, and the `bin`, `mesh/tokens` and
    `mesh` folders when they are then empty. There is no profile, so no `--purge`. Plain
    `disable --apply` is unchanged. `status` adds a `Request-post:` line: on and its endpoint,
    or off, and whether the token and shim exist; it prints an endpoint only when it passed the
    rule, and never the token.
  - `test/mesh.test.ts` holds the off test (enable then disable leaves the tree as before but
    backups), the dry run, every endpoint refusal, the token refusals and its 0600 copy, the
    stale shim, and that request-post and unslop never touch each other's key or files.
    User page: [`docs/request-post.md`](../request-post.md).

## Calling request-post (R3)

`meshctl request-post file | status | wait [--through-go]` is `src/request-post-client.ts`: Node
core plus `mesh-config.ts` and `agent-card.ts`, imported only by meshctl's async entry (`runMeshctl` alone answers
with the usage and 4). User page, exit table and the routing text: [`docs/request-post.md`](../request-post.md).
Its exit codes are its own (design §3.3: 0, 11-16, 124, 4); `docs/unslop.md` has unslop's, and
the two share numbers, not meanings.

- **Before any connection:** arguments (4); a `--report` that is a symlink or not a regular file
  (4); for `file`, a terminal on stdin (4: it never reads `/dev/tty`), then the brief, at most
  8 KiB of UTF-8, not blank, no control characters but tab and newline, CRLF read as LF (else 11,
  naming `brief`). Then off: no `agents.request-post` passing `requestPostEndpoint()`, or a device
  token that is not a 0600 regular file the user owns (opened `O_NOFOLLOW`), is 14.
- **The wire.** `node:http` or `node:https` with `agent: false` (no keep-alive and no environment
  proxy), `Host` exactly the endpoint's authority, the TLS name the endpoint's host, no `Origin`,
  and never the card's URL. Redirects are not followed: a 3xx on the card is 15, on the call 13.
  Each call first reads `GET /.well-known/agent-card.json` (no token) and checks both skills, a
  JSON-RPC interface with `protocolVersion` `1.0`, and `urn:agent-inbox:ext:request-post:v1` with
  `api: 1`; a mismatch is 15 with "update agent-inbox or the service" (design §3.3 lists a card
  mismatch under 15, and the R1 fixture `10-unavailable.json` says the same). Then one blocking
  `SendMessage` (40 s: a margin over the service's 30 s task limit, so the service's lock-wait 12 is
  never cut to 13) with `Authorization: Bearer <token>` and `A2A-Version: 1.0`: one text part
  (the brief, or `status`) and the metadata R1 pins (`skill` plus the §3.2 fields and
  `idempotencyKey`, or `requestKey` / `pageId`).
- **Sent or not.** A failure before the socket connected (TLS: before `secureConnect`), such as a
  tailnet name that does not resolve (the shared-tailnet case), a refused connection or a failed
  handshake, is 15: nothing reached the service. Once connected, a timeout, a cut body, an HTTP
  status other than 200, 401 and 403, a JSON-RPC error or an answer without a task is 13. HTTP 401
  and 403 are 15 (a revoked token, or a shared tailnet without the app capability).
- **The key** is `requestKey()`, R1's pre-image (four lines: `request-post/v1`, brand, sorted
  channels, then `slug:`, `url:` or the NFKC title) in lower-case RFC 4648 base32, 26 characters;
  the test runs every `keys.json` vector through it. `--key` replaces the sent `idempotencyKey`
  and adds `keyOverride: true` beside it, which R1's README defines: the service (P2a) refuses a
  key that is not the derived one without it. Without `--key`, `keyOverride` is never sent.
- **The answer:** the data part from the one artifact on `COMPLETED`, else the status message
  (R1); `COMPLETED` with code 0 is 0, `REJECTED` is 12 with code 12, 16 with `reason: conflict`,
  else 11; anything else is 13. stdout gets the data part as JSON only on 0, with C1 controls and
  U+2028/2029 escaped. stderr gets one line; every agent string in it has C0, DEL and C1 controls
  and line separators replaced by a space. `--report` writes the data part of every answer that
  has one (`O_NOFOLLOW`, 0600); a report it cannot write makes the exit 13. Every other exit after
  the argument checks (14, 15, 124, a local 11 or 4, an internal error's 13) writes `{ "code": <exit> }`
  the same way, so a stale report never survives.
- **`wait`** (design §4.3) reads at once, then every 2 minutes until 30 minutes from its start,
  then every 15. A final phase (with `--through-go`, not `awaiting-go`) exits 0. A busy answer
  (12) waits its `retryAfterMs`, between 2 and 15 minutes, and does not count as failure. 13 and
  15 (but a card mismatch) back off 30 s, 1, 2, 4, 8 and 15 minutes, the last wait shortened to
  land on the 30th minute of the streak, which exits 15; a good read ends the streak. 11, 14 and
  a card mismatch end it at once. At 4 hours from its start it exits 124. `now` and `sleep` are
  injectable, so the tests run it on a fake clock.
- **Tests:** `test/request-post-client.test.ts` runs the client end to end against a fake A2A
  server answering with R1's fixtures, checking each request it sends with `checkExchange` and
  `checkStatus`: every exit code, the key vectors, the override, the card checks, redirects, an
  unresolvable tailnet name (an injected `lookup`), a failed TLS handshake, a cut answer re-run
  with the same key, `wait`'s cadence, backoff, the 30-minute 15, 124 and `--through-go`, control
  bytes, the terminal rule (an `isTTY` stdin and the real CLI under `script`), off (a counting
  listener over every off case) and a spy on every `node:child_process` entry point around each
  run. Off tests (a)-(d): `test/prstate.test.ts` lists the client as a mesh module the stdio
  graph must not reach, `test/mesh.test.ts` pins its imports and checks that no viewer,
  `public/` or `electron/` file names it, and the dependency and snapshot-trigger fixtures are
  unchanged.
