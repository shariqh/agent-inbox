---
paths:
  - "src/mesh-config.ts"
  - "src/meshctl.ts"
  - "public/agents-home.js"
  - "packages/mesh/src/*.ts"
applyTo: "src/mesh-config.ts,src/meshctl.ts,public/agents-home.js,packages/mesh/src/*.ts"
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
  `src/mesh-config.ts` is the Node-core reader. Today no piece is read from it:
  `enable --agents-view` writes nothing and says the view is always on, `status` says
  the same, and an `agentsView` key in an existing file is kept like any other.
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
  and `@mesh` archive steps before that one. Since #454, `enable --agents-view` (with or
  without `--apply`) writes nothing and prints "The Agents view is always on; mesh.json no
  longer controls it", and `status` prints the same line before the file's state. A later
  phase that adds a piece brings back an `enable` writer (temp file, atomic rename) with
  it. `src/mesh-config.ts` holds the one reading rule (a regular file ≤ 64 KiB, a JSON
  object, `schema` 1; anything else is off). Both are Node core only and never import
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
  neighbours better than any other value's, ties failing. Negations and conditions are
  hard on any drop, on a move to another clause, and on an addition unless the same
  clause dropped a negative word such as "fails". A text with more than 500 sentences or
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
  results, never text or a matched value; clock, random and transport injectable). The
  A2A server, queue, token, `mesh.json` gate and daily budget are U2b; the CLI is U3.
- **One `mesh.json` rule, held twice.** The package cannot import `src/mesh-config.ts`,
  so it carries a reader with the same rule and the same `meshDir()` order. The cases in
  `test/fixtures/mesh-json/cases.json` run in both suites: `test/mesh-json-parity.test.ts`
  (through `meshctl status`) and `packages/mesh/test/mesh-config.test.ts`. Change the rule
  in both places and add a case there.
- **Run its tests:** `cd packages/mesh && fnm exec --using=24 npm ci && npm run typecheck && npm test`.
