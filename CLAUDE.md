# CLAUDE.md

Guidance for Claude Code (and any coding agent) working in this repo.

## What this is

`agent-inbox` — a local, cross-project, cross-tool attention inbox for coding agents. A
stdio **MCP server** lets agents `flag` open questions and non-blocking notes and maintain
**tracking boards** (titled status tables); everything lands in one SQLite hub
(`~/.agent-inbox/inbox.db`); a local **Hono viewer** renders the cross-project inbox and
boards. No LLM/model calls anywhere — this is dumb infra (store + viewer + thin MCP
server). See [`README.md`](README.md) for the full picture and
[`docs/superpowers/specs/`](docs/superpowers/specs/) for the design docs (inbox v1 +
tracking boards).

MCP tools: `flag`, `pending`, `answer`, `resolve`, `register`, `whoami` (items/scope),
`board_upsert`, `board_row`, `board_get`, `board_archive` (boards) and `status` (live
presence) — all defined in `src/mcp.ts`.

## Commands

```sh
npm test            # vitest run — full suite (one shot)
npm run test:watch  # vitest watch
npm run typecheck   # tsc --noEmit (strict; noUncheckedIndexedAccess)
npm run build       # tsc -p tsconfig.build.json → dist/ (entry: dist/mcp-server.js)
npm run mcp         # run the MCP stdio server via tsx (local iteration)
npm run view        # run the viewer on localhost:4319 via tsx
npm run install:hooks           # DRY RUN of the opt-in backstop hooks installer (docs/hooks.md)
npm run install:hooks -- --apply    # …and actually write ~/.claude/settings.json
npx vitest run test/mcp.integration.test.ts   # single file
npx vitest run test/dom/                      # the jsdom viewer tests only
```

**Node 24 only (for this checkout).** `better-sqlite3` compiles one native binding per
install; this repo's is built for Node 24 and `.node-version` pins it — run `fnm use 24`
before anything (or prefix one-off commands with `fnm exec --using=24 …`). (Since the v12
upgrade the library itself supports newer Node — the packaged Electron app rebuilds it for
Electron's ABI in `build/stage` — but the checkout standardizes on 24.) This bites twice:
(1) the integration test **spawns** `npx tsx src/mcp-server.ts` as a child, which inherits
your shell's PATH, so Node 24 must be active when you run `npm test`; (2) when registering
the server with a CLI, pin the **absolute Node 24 binary path**, never bare `node`.

## Architecture & invariants

- **`src/store.ts` is the only door to the database.** Every read/write goes through its
  exported functions — items: `insertItem`/`resolveItem`/`dismissItem`/`annotateItem`/
  `replyItem`/`answerItem`/`listItems`; boards: `upsertBoard`/`updateBoardRow`/`getBoard`/`listBoards`/
  `archiveBoard`/`annotateBoardRow`; projects: `closeProject`/`reopenProject`/`listClosedProjects`/
  `closedProjects` — plus `openDb`. No raw SQL anywhere else. To change
  storage, reimplement this module; nothing else touches SQLite.
- **Boards: the human's annotations are sacred.** A board is idempotent by
  `(project, title)` (UNIQUE); rows match by `label`, positions come from array order.
  `upsertBoard` deliberately never touches `board_rows.annotation` — human per-row notes
  must survive a full re-upsert. But rows *absent* from an upsert are deleted (annotations
  with them), so agents must keep labels stable. There is no FK enforcement between
  `boards` and `board_rows` — deletes are handled explicitly in `store.ts`.
- **Two answer channels, ONE precedence rule: the inbox always wins.** A question can be
  answered on the card (`replyItem`, source `'inbox'`) or out loud in chat and recorded by
  the agent (`answerItem`, source `'agent'`). It is deliberately NOT wall-clock
  last-write-wins — a skewed clock or a delayed flush would let a stale chat answer clobber
  a fresh inbox one. `answerItem` is ONE conditioned UPDATE that only writes while nothing
  unread is waiting (`reply IS NULL OR reply = '' OR reply_seen_at IS NOT NULL`) and
  otherwise returns `{ok:false, reason:'unread_inbox_answer'}` with the waiting answer;
  `replyItem` overwrites unconditionally and resets pickup. Never SELECT-then-UPDATE and
  never two UPDATEs here: the viewer writes from its own OS process and would land between
  them, leaving the human's newest answer flagged "✓ picked up" and un-clearable. An agent
  may overwrite an answer it has already picked up, but may never blank one.
- **One process per agent session (stdio), one shared file.** The MCP server is spawned per
  session; all instances write to the same `~/.agent-inbox/inbox.db`. Concurrency is handled
  by **WAL + `busy_timeout=5000`** set in `openDb` — keep both. Writes are single tiny
  inserts; this is WAL's happy path.
- **Session scope is Solo-style** (`src/scope.ts`): inferred lazily per call, overridable via
  `register`. The client name for `inferAgent` **must be read lazily** inside handlers
  (`server.server.getClientVersion()?.name`) — it's only populated after the initialize
  handshake. Capturing it at build time yields `undefined`/`'unknown'`. Don't regress this.
- **stdio channel is sacred.** The server speaks MCP over stdout — never `console.log` to
  stdout from server code, and any subprocess (e.g. git in `infer.ts`) must **capture**
  stdout (`stdio: ['ignore','pipe','ignore']`), never inherit it. A handler throw is fine:
  the SDK wraps it into `{ isError: true }` and the process survives.
- **Fail-open / never lose a flag.** If inference fails, attribute to `unknown` and still
  insert. If a write fails, surface an MCP error — don't crash.
- **Viewer escapes all agent-authored text.** `public/app.js` runs every interpolated field
  (item title/detail/annotation/project/stream/agent, board title/meta, row label/note/
  annotation) through `esc()` before `innerHTML`. Keep it — flags and boards are
  attacker-influenced text. **`esc()` is not enough for a URL:** it does nothing about
  `javascript:`, and issue #30 introduced the first anchors this product builds from supplied
  text (PR titles are third-party network text). Every href is constructed in ONE place,
  `chipHtml()` in `public/source.js`, through `esc(safeHttpUrl(...))` — a URL that does not
  survive `safeHttpUrl` renders as a `<span>`. Do not build an anchor anywhere else.
- **`src/prstate.ts` is VIEWER-PROCESS-ONLY (issue #30).** It is the one module that shells out to a
  network tool (`gh`), so `src/mcp.ts`/`src/mcp-server.ts` must never import it, directly or
  transitively — a subprocess that inherited a stream, or gh's update notifier, would corrupt the MCP
  wire. It writes only through `store.ts` (`upsertSourceLink`/`recordLinkFailure`; the TTL *policy*,
  `dueTargets`, is a pure function over what the store returned) and it can never reject: an
  unhandled rejection from a background PR fetcher would take down the human's entire UI. **A failing
  CI check or a changes-requested review NEVER enters the attention set** — `public/attention.js` is
  untouched, no badge moves, no notification fires. A red CI is the agent's problem, not the human
  being blocked; this is the likeliest place for scope creep to damage tenet 2.
- **`store.ts`/`mcp.ts`/`viewer.ts` inverse round-trip:** the store's `Item` and
  `BoardWithRows` shapes are the contract shared by MCP writes/reads and viewer reads.
  Change them in `store.ts` and update both consumers (+ `group.ts` for items;
  `public/app.js` renders both).

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
  nothing. Full contract: [`docs/hooks.md`](docs/hooks.md).

### DOM harness — what it can and cannot see

`test/dom/` boots the **real** viewer frontend in jsdom: `test/dom/harness.ts` bridges
`globalThis.fetch` onto the real `createViewer(db)` Hono app over a real temp SQLite DB,
then imports `public/app.js` **unmodified** — top-level side effects and all.
`public/` and `src/` have a **zero-line diff** because of it; keep it that way.

- **jsdom cannot execute `<script type="module">`.** That is why the harness imports the
  module graph directly instead of mounting `public/index.html` and letting it run. Do not
  re-litigate this — it has already cost time twice.
- **`publicDir: false` in `vitest.config.ts` is mandatory.** Without it Vite claims
  `<root>/public` as its static publicDir and hard-errors on any import from it
  ("this file is in /public … can only be referenced via HTML tags"). The companion
  `resolve.alias` (`/^\/([\w.-]+\.js)$/` → `<repo>/public/$1`) is what makes the browser's
  absolute `/x.js` specifiers resolve. Neither touches a byte on disk: `public/` still has
  no build step, and the browser and Electron keep resolving `/x.js` from their own root.
- **Four globals must be stubbed or `render()` throws and `load()`'s catch swallows it** —
  which presents as "nothing rendered", not as an error: `window.uFuzzy` (vendored IIFE,
  constructed at app.js module top level, so it must exist BEFORE the import),
  `window.matchMedia` (2 call sites: `themeName`, `initResponsive`), `CSS.escape`
  (6 call sites, incl. `setRailMatch` on every render), `Element.prototype.scrollIntoView`.
  The harness's **console.error guard is load-bearing**, not cosmetic — it is the only
  thing that turns a swallowed render throw back into a visible failure.
- **`new URL('…', import.meta.url)` does not work in a jsdom test file.** jsdom files run in
  Vite's WEB transform mode, where the asset plugin rewrites that literal pattern into
  `http://localhost:3000/@fs/…` and `readFileSync` dies with "The URL must be of scheme
  file". The rest of `test/` uses that form happily because those files run in the NODE
  environment. Resolve through `node:path` instead (`harness.ts` does).
- **Fake timers freeze `Date`,** so every row seeded inside one test shares one
  `created_at` unless you call the harness's `advanceClock()` between writes. That silently
  breaks `listItems`' `ORDER BY created_at DESC`, `buildDeck`'s sort and — worst —
  `seenWatermark`, whose whole job is comparing stamps. Item timestamps cannot be
  backdated through `store.ts`, so a staleness fixture moves the CLOCK, never the row.
- **Window/document listeners accumulate across boots within one file.**
  `vi.resetModules()` gives a fresh module instance but jsdom's window/document live for
  the whole file, so each boot adds another `hashchange`/`keydown`/`beforeunload` handler.
  Harness rule: **assert rendered state only, never handler-invocation counts.**

CSS: `getComputedStyle` over an attached `public/style.css` genuinely resolves specificity,
source order, `!important`, `:has()` and `color-mix()` — that is what makes the
`.answer-btn` geometry test in `test/dom/css-cascade.test.ts` catch the real 13819d2
regression. **Four verified blind spots; only literal lengths and keywords are trustworthy:**

1. **`@media` never matches.** jsdom's media-list evaluation only answers `all`/`screen`,
   so style.css's single `@media (max-width: 900px)` block — the ENTIRE spec §14 responsive
   layer — never applies. Do not assert anything about it; cover the JS half instead
   (`setViewport('narrow')` + `railLabel` monograms, in `test/dom/boot.test.ts`).
2. **`var()` is returned unresolved.**
3. **An unparseable declaration is dropped SILENTLY — and therefore reads as "correct".**
   `border: 1px solid color-mix(…)` comes back as `borderStyle: 'none'` /
   `borderTopWidth: 'medium'`, so asserting the `.row-expand { border: none }` half of the
   13819d2 bug would pass VACUOUSLY on the buggy sheet. This is the dangerous one.
4. **The `font:` shorthand clobbers a later longhand.** `.answer-btn` declares
   `font: inherit; … font-weight: 600` and jsdom computes `normal`.

An overstated harness is worse than none. If an assertion falls in one of those four, it is
not evidence — delete it or move it to a source pin.

## Conventions

- Node 24, TS **ESM** (`"type":"module"`); **imports use `.js` specifiers** even for `.ts`
  sources (NodeNext). Keep this on new imports.
- Strict tsc, `noUncheckedIndexedAccess: true` — array access is `T | undefined`; use `!`/
  guards, keep `npm run typecheck` clean.
- **TDD.** Every change: failing test → red → implement → green. Tests use **real** temp
  SQLite DBs (`AGENT_INBOX_DB`/`mkdtempSync`), never mock the store. The MCP test is a real
  spawn-the-server round-trip.
- **Test environments are per-file.** There is no global `test.environment`: the node suite
  (store, mcp, infer) stays on node and a DOM file opts in with a
  `// @vitest-environment jsdom` docblock. `test/dom/harness.ts` is deliberately NOT named
  `*.test.ts` so the `test/**/*.test.ts` glob imports it without collecting it.
- `zod` is a **direct** dependency (used by `mcp.ts` for tool schemas) — keep it in
  `package.json`, don't rely on it resolving transitively via the SDK.
- Build emits via **`tsconfig.build.json`** (rootDir `src`, src-only) so `dist/mcp-server.js`
  is flat. The base `tsconfig.json` (src + test) is for typecheck only. Don't point `build`
  at the base config — it re-nests output under `dist/src/`.
- **Every value export in `public/*.js` AND `src/*.ts` must be reachable from code that
  ships.** Two ways, and nothing else counts: another production module IMPORTS it by name
  and uses that binding, or it is CALLED inside its own module and that module is itself
  imported (or is an entry point). A test is not a consumer: a helper only its own unit test
  calls looks load-bearing (typed, covered, named after a real concept) while shipping
  nothing. `test/dead-exports.test.ts` enforces it. The only deliberate exits are a
  `void X // why` marker at an importing call site (as `app.js` does for `paginateGroups`)
  or an entry in that file's `ALLOWED` map **with a written reason** — the map is the point:
  it turns a silent trap into a list someone has to justify.
  Four such helpers accumulated through the viewer rebuild; `listClosedProjects` (#32) was
  the fifth and got through because the guard's first draft asked only whether `\bNAME\b`
  occurred more than once across a concatenation of the consumer files — so any unrelated
  file containing the same word vouched for it, and `src/` was not scanned at all. **Keep
  the liveness test import-or-call.** Its discrimination is pinned on synthetic module trees
  in the same file (including the exact word-match hole), so a slide back into word-matching
  fails there rather than shipping a sixth. It is a scanner, not a tokenizer: cross-file
  liveness is import-only and airtight, but *within* the declaring file a bare occurrence
  counts however it got there (a local binding, an object key, template-literal text). That
  limit is written down at the `word()` helper — don't restate it more generously.

## Shipped since v1

v1 was deliberately local + triage-only. These have since landed — don't re-plan them:

- **Answer-back** *(#7)* — `pending` MCP tool + the viewer reply box. Answers carry an optional
  `reply_context`, and `reply_seen_at` records agent pickup.
- **`done`/milestone bucket** *(#9)* — `flag({ kind:'done' })`, surfaced in the viewer's Done section.
- **Electron packaging** *(#11)* — `electron/` wraps the `public/` viewer; `scripts/package-app.sh`
  stages `dist` + `public` + `electron` and rebuilds `better-sqlite3` for Electron's ABI.
- **Session presence** *(#28)* — every MCP session is a Live row; `status()` upgrades it, process
  exit ends it, and rows silently expire after ~15 min.
- **Dual-channel answer sync** *(#29)* — the `answer` MCP tool plus `answerItem`/`reply_source`.
  Agent-mediated by design: this repo has no hook into any chat client, so the AGENT is the
  bridge. Convergence is order-independent (inbox precedence, no clock comparison) rather than
  the issue's original "timestamp-based last write wins". Known limitation, worth a follow-up:
  once a chat answer lands, `reply_seen_at` is set, so the card's "Change answer" (a
  blank-clear) is refused and the human cannot re-answer that item from the viewer.
- **Backstop hooks** *(#10 + #21)* — `src/hook.ts` + `src/hook-cli.ts`, installed opt-in by
  `scripts/install-hooks.sh` (dry-run by default). #10: a `Notification` hook arms a
  grace-windowed backstop item when a session is stuck at a permission prompt; it is
  self-clearing, rate-limited and janitored, so the badge stays trustworthy. #21: `stop`,
  `prompt-submit` and `session-start` nudge an idle agent to call `pending()`, and the
  `watch` subcommand (asyncRewake, exit 2) wakes it the moment you answer. The two legacy
  untracked `~/.claude/hooks/agent-inbox-*.sh` scripts are superseded — `--migrate` retires
  their settings entries.
- **Close / reopen a project** *(#32)* — a sparse `projects(project, closed_at)` table; **reopen is
  DERIVED, never written** (a project un-closes the moment an item or board is CREATED in it after
  `closed_at`), so `insertItem` stays byte-identical and the un-close is atomic with the very insert
  that raises the question. A closed project leaves the §7 attention set **entirely** — badge, title,
  Needs-you count, triage deck — via a 5th `closedProjects` argument to `attentionEntries`, so there
  is still exactly ONE predicate; `countsByProject` deliberately stays unsuppressed because the
  rail's closed fold is where the number is RELOCATED, not destroyed. Live presence (footer strip and
  drawer) is untouched: presence is not attention. Clicking a closed project PEEKS (a banner above
  the panel says the badge excludes what you are looking at); only × / ↩ / a new flag mutate.
  Closing also retires the project from #30's PR poller (`listLinkTargets` filters through
  `closedProjects`, never the raw table, so a derived reopen resumes polling by itself) — a retired
  project must not keep spawning `gh` every 60s nor keep eating the shared `MAX_PER_TICK` budget.
  The reopen predicate is strict `>` **on purpose**: a close and a write can tie at the millisecond,
  and the tie goes to the human's explicit act — `>=` would mean closing a project in the same
  millisecond an item lands leaves it open, i.e. a × that visibly does nothing. Pinned on a frozen
  clock in `test/store.test.ts`.
  **Honest limitation:** an agent already blocked on a question raised *before* the close creates
  nothing new while it polls `pending()`, so closing that project mutes a genuinely-live blocker
  until fresh content arrives. "Nothing can be permanently muted" is true of everything except that
  case — do not restate it unqualified.
- **Source + PR links** *(#30)* — split along the network boundary. Link IDENTITY is inferred
  locally at write time by the stdio server (`inferRepo`/`inferIssueRef` in `src/infer.ts`, carried
  on the scope, stamped as `items.repo`/`items.issue_ref` and the same two on `boards`); live PR
  STATE is fetched only by the viewer process (`src/prstate.ts` → `gh pr list`), cached one row per
  `(repo, branch)` in `source_links`, and served read-only at `GET /api/links`. `public/source.js`
  joins the two and renders an issue chip plus a PR chip with a native `title=` TL;DR. The
  branch→issue heuristic is deliberately CONSERVATIVE (`30-x`, `feat/30-x`, `issue-30`, `issues/30`,
  `gh-30` — never a trailing year or `release/2.1`), because a link to the wrong issue is worse than
  no link; `gh`'s `closingIssuesReferences` overrides it and `register({ issue })` is the manual
  escape hatch. Non-github remotes render NOTHING (the `provider` column + `parseRepoSlug`'s host
  check are the GitLab/GHE seam). **Two honest limitations:** every item and board written before
  this shipped has `repo = NULL` and shows no chip at all — there is no backfill, and there cannot
  be a correct one; and `gh pr list` does not return the linked issue's TITLE, so `issue_title` is
  always null in v1 and the chip reads `#30`.

- **The agent-emit contract** — `docs/reporting-snippet.md`'s end-of-turn rule now tests "am I about
  to stop and wait on the human?", so recommendations and "say the word" moments get flagged
  instead of buried. Mirrored in the `flag` tool description so agents get it at the call site.

## Open backlog — and the seams already in place

- **Remote / hosted mode** *(#8)* — run on a server, tunnel-exposed for phone + cloud-agent reach.
  Swap stdio for **streamable-HTTP** and add **auth** (bearer token in MCP client headers + a gate
  on the viewer). `register` is the identity seam: a remote server can't see the client's `cwd`, so
  agents declare scope via `register` instead of auto-inference. `AGENT_INBOX_DB`/`AGENT_INBOX_PORT`
  env overrides are already in place. Design (three blocking decisions, three verified wiring traps):
  [`docs/superpowers/specs/2026-07-26-remote-hosted-mode-design.md`](docs/superpowers/specs/2026-07-26-remote-hosted-mode-design.md).

Keep all of these additive and behind the existing seams — don't break v1's local,
zero-config, no-auth path.

Boards-specific follow-ups (unseen-by-agent markers, row context field, archive safety,
row escalation) are GitHub issues #1–#6; original review context in
[`docs/boards-backlog.md`](docs/boards-backlog.md).

## Gotchas recap

- Node 26 default → this checkout's `better-sqlite3` binding was built for Node 24's ABI and
  fails to load; use Node 24.
- Register the MCP server with the absolute Node 24 path, not bare `node`.
- New MCP-server registration is picked up only on a **fresh** CLI session.
- The **reporting snippet** (`docs/reporting-snippet.md`) is what makes agents flag at all —
  code shipping ≠ agents using it; the snippet must be in the user's global instructions.
