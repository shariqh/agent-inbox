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
  `archiveBoard`/`annotateBoardRow`/`markAnnotationDelivered`/`markRowHandled`/
  `clearRowHandled`/`markHandledDelivered`/`listPendingRows`;
  projects: `closeProject`/`reopenProject`/`listClosedProjects`/`closedProjects` — plus `openDb`. No raw SQL anywhere else. To change
  storage, reimplement this module; nothing else touches SQLite.
- **Boards: the human's annotations are sacred.** A board is idempotent by
  `(project, title)` (UNIQUE); rows match by `label`, positions come from array order.
  `upsertBoard` deliberately never touches `board_rows.annotation` — human per-row notes
  must survive a full re-upsert. But rows *absent* from an upsert are deleted (annotations
  with them), so agents must keep labels stable. There is no FK enforcement between
  `boards` and `board_rows` — deletes are handled explicitly in `store.ts`. The same
  protection covers `annotated_at`/`annotation_seen_at`/`annotation_seen_by`: a re-upsert
  that reset delivery would re-attribute the note to whoever polls next and reset the
  "delivered 3h ago" age the human reads as evidence. **Issue #36's `handled_at` (plus its
  `handled_seen_at`/`handled_seen_by`) is sacred on the same terms** — it is the human's
  "I did my part" on a blocked TASK row, and the prescribed agent flow is a full-table
  re-send, so an upsert that dropped it would wipe their action on every routine refresh.
  Exactly ONE thing clears it, in `resetHandledOnReblock`: a status transition INTO
  `blocked` from something else, i.e. a genuinely new ask. Re-sending a row that is already
  blocked is not an acknowledgement and must never reset it.
- **Delivery is not acknowledgement (issue #37).** `board_rows.annotation_seen_at` records
  ONE fact — this text was handed to some agent — and it silences nothing: not the human's
  screen, and (since F1) not the agent's queue either. The row stays `blocked` and stays in
  BOTH places until an agent flips its status, which IS the acknowledgement.
  Three consequences that must not be "simplified" away. (1) `annotation_unseen` derives from
  the PER-ROW stamp only — `boards.last_read_at` still gets written by `markBoardRead` but
  is pure decoration (its only real use is the one-shot migration backfill); a second input
  would disagree invisibly, since nothing renders it. (2) The attention predicate
  (`public/attention.js`) reads what the HUMAN did, never the delivery state:
  `isBlockedRowAttention = status === 'blocked' && !humanActedOnRow(row)`, where
  `humanActedOnRow` is the one place that knows a row can be answered in words
  (`annotation`) OR by going and doing it (`handled_at`, #36). The rows it drops are
  RELABELED into `awaitingAgentRows()` — same module, rendered in the Needs-you foot — not
  deleted. Removing the alarm without relabeling it is the worse bug, not the fix.
  (3) **`listPendingRows` gates on the ACKNOWLEDGEMENT, not on the stamp:** still pending
  while `status = 'blocked'`, or while either half (annotation, `handled_at`) is
  undelivered. Gating on the stamp made rows
  at-most-once while items are at-least-once (`listPending` is gated on `status='open'`), so
  in a fan-out a sibling's routine poll ate the answer, the session that RAISED the row never
  got it, and the human's card then claimed "delivered to claude-code". A blocked row is
  therefore re-delivered on every poll until the status flips — the same window the human is
  still staring at it — and the payload carries the stamp so a re-delivery is self-labelling.
  A non-blocked row has nothing to acknowledge and stays at-most-once; without that half a
  months-old aside would be a permanent firehose.
- **Every mark-seen write pins the version it read.** `markReplySeen(id, repliedAt)`,
  `markAnnotationDelivered(rowId, annotatedAt, by)` and `markHandledDelivered(rowId,
  handledAt, by)` bind the exact version stamp the read returned (`... AND replied_at IS ?` /
  `AND annotated_at IS ?` / `AND handled_at IS ?`, `IS` because legacy rows
  carry NULL). The viewer writes answers from its own OS process, so an unconditional stamp
  marks text the human just replaced as picked up. Never SELECT-then-UPDATE with a gap;
  `annotateBoardRow`, `replyItem` and `markRowHandled` reset the stamp in the SAME statement
  that writes the new value. `markAnnotationDelivered`'s boolean means ONLY "the text you read is still
  there, safe to hand over" — never "you were first" (re-delivery is normal now), and its
  `COALESCE` is what keeps the two apart: the stamp records the FIRST delivery and never
  moves, because its AGE is the human's evidence that an agent has sat on the answer.
  `pending()`'s `.filter()` consuming that boolean is what drops replaced text — pinned at
  the MCP level in `test/mcp.integration.test.ts` with a SQLite trigger, the only way to
  schedule the human's hand between the handler's SELECT and its stamp.
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
- **One process per CLI (stdio), one shared file.** A server is spawned per *client process*, not
  per agent session — a subagent's calls are served by its parent CLI's long-lived server
  (measured: servers observed running 4+ days), so a fan-out shares one process, one `sessionId`
  and one in-memory ledger. All instances write to the same `~/.agent-inbox/inbox.db`. Concurrency
  is handled by **WAL + `busy_timeout=5000`** set in `openDb` — keep both. Writes are single tiny
  inserts; this is WAL's happy path.
- **Two activity stamps, and only one of them means work** *(issue #45)*. `activity.updated_at` is
  LIVENESS: the 5-minute `touchActivity` timer bumps it whether or not the agent has done
  anything, so `listActivity`'s 15-minute cutoff can only ever catch a **crashed** process and is
  not evidence of activity — that is why a row was observed advertising a 2-day-old effort.
  `activity.last_call_at` is written by `recordActivityCall` ONLY, called from `heartbeat()` in
  `src/mcp.ts`, i.e. by real MCP calls; **the timer must never call it**, and that one line is the
  whole distinction — which is why the timer's body is the named export `livenessTick` rather than
  an anonymous callback: inline it was unreachable, and a `recordActivityCall` added beside it
  reinstated the whole bug with the suite green. `test/live-tick.test.ts` pins both halves (what
  the tick does over 12 modelled hours of silence, and that the interval calls nothing else).
  A `doing` claim is live while that stamp is within `CLAIM_COLD_MS` (30 min)
  and otherwise decays to `doing:'open', idle:true, children:[]`. **The decay is in two places on
  purpose.** It is derived on every read in `listActivity` (a session that goes quiet forever needs
  no further write to stop lying) *and* cleared by `recordActivityCall` when the call it is
  stamping lands after a cold gap — read-side alone would let a routine `pending()` poll resurrect
  a two-day-old claim, which is exactly what the observed rows were doing. Both comparisons share
  `CLAIM_COLD_MS`/`claimCutoff` and both fall back to `started_at` when `last_call_at` is NULL, so
  a just-registered session is never born cold and a legacy row always is. **The row itself is
  never dropped for being idle:** `public/attention.js` calls an item `waiting` iff its session id
  is in `/api/activity`, so expiring a quiet-but-live session would silently demote a genuine
  blocker to `parked` (and the same list sizes Electron's dock badge). Long-idle sessions sink to
  the bottom of the fold and render `dormant` instead — sorted, dimmed, never removed.
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
- **`src/shape.ts` is AGENT-SIDE ONLY (issue #42).** `context` is written for the human
  and rendered collapsed, so agents write it generously — and every agent read used to pay
  for all of it. `shape.ts` is where the MCP read payloads are trimmed (`context` →
  `context_chars`, `full: true` to fetch); `store.ts` still returns whole rows and
  `src/viewer.ts` must never import it, so `/api/boards` and `/api/items` stay
  byte-identical for the human. **Only agent-authored `context` is ever trimmed** — the
  human's `annotation`/`reply`/`reply_context` is never omitted on any path, under any
  option. **The "handed over once" ledger is per-PROCESS, and that is all it can be.** Not
  per session and not per agent: the stdio server is long-lived, and a Claude Code
  subagent's MCP calls are served by the PARENT CLI's process — so a fan-out SHARES one
  ledger and the first sibling to poll consumes the delivery. (The persisted stamp is no
  better: `annotation_seen_by` is a CLIENT NAME every sibling shares.) MCP exposes no
  subagent identity to key on, so the ledger is **an optimisation, never a guarantee** —
  what makes that safe is that a trimmed context is ALWAYS recoverable on demand:
  `pending({full:true})` for items and rows, `board_get({title, full:true})` for a board.
  Keep both hatches, and keep them named in the tool descriptions. Do not re-assert
  "one process = one session"; it was measured and it is false.
- **Omission is not deletion — for FIELDS (issue #42).** `board_upsert` leaves a row's
  `context` alone when the field is absent and clears it only on an explicit `''`, because
  the prescribed flow is `board_get` → `board_upsert` and MCP reads no longer carry the
  text: omitting what you were never handed would wipe it. This does NOT weaken the rule
  that a ROW absent from an upsert is deleted — that one stands. `note` still clears on
  omission, deliberately: reads do hand `note` back, so leaving it out is a real choice.
- **`store.ts`/`mcp.ts`/`viewer.ts` inverse round-trip:** the store's `Item` and
  `BoardWithRows` shapes are the contract shared by MCP writes/reads and viewer reads.
  Change them in `store.ts` and update both consumers (+ `group.ts` for items;
  `public/app.js` renders both).
- **`load()` is the poll's; `reloadAndPaint()` is the human's (issue #38).** `load()` ends in
  `renderIfIdle()` — the spec §10 gate — and **that gate is GLOBAL**: `suspendState()` reports
  ANY expanded card plus EVERY draft anywhere in the app. So a handler that ends a successful
  POST with a bare `load()` is asking the gate for permission to show the human the result of
  their own click, and one unrelated card left open on another tab refuses it *indefinitely*.
  Every human-initiated write therefore ends in `reloadAndPaint()` (`await load()` then
  `forceRender()`); the ONLY un-painted callers are the boot call and `setInterval(load, 3000)`.
  There are exactly **two entries into `render()`** — `renderIfIdle` (gated) and `forceRender`
  (not) — because `forceRender` is also the only thing that clears `renderDirty` and refreshes
  `#pauseHint`; a direct `render()` leaves that hint claiming "paused" over data already on
  screen. Pinned in `test/shell.test.ts` + `test/issue-31-followups.test.ts`; the behavioural
  half (including the anti-regression that the poll still suspends) is `test/dom/silent-send.test.ts`.
- **A held pointer defers the rebuild, and it is NOT a suspension (#38 / D2).** The 3s render
  detaches the node under the cursor, so `pointerdown`/`pointerup` share no ancestor and the
  browser dispatches **no click at all** (measured in Chrome: ~1 in 24 at human hold times, on
  every surface). `initPressGuard` records `pressedAt`; `shouldDeferRender` (in `public/poll.js`)
  ORs it with the §10 suspension. Keep `pressedAt` **out of** `suspendState()`/`suspendReason()`
  — a press loses nothing, so lighting `#pauseHint` for it would be a new lie — and keep it a
  **timestamp**, never a flag: bounded by `PRESS_GRACE_MS`, it self-heals when a release event
  is missed. Never gate the render on `openRows` instead: it is unbounded, never pruned, and
  would resurrect the C1 freeze on the tab the badge counts. That last sentence is the design's
  explicitly rejected option and the easiest thing in the file to "clean up", so it is pinned
  twice: a source pin on `suspendState()` in `test/shell.test.ts`, and the freeze itself —
  expand one matrix row, watch the list, badge and `#pauseHint` stop — in
  `test/dom/press-guard.test.ts`.

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
- **Session presence** *(#28, corrected by #45)* — every MCP session is a Live row; `status()`
  upgrades it, process exit ends it, and a row that stops being heartbeated expires after ~15 min.
  That expiry only ever fires for a **crashed** process: a live one heartbeats itself, so what
  decays for an idle-but-running session is its `doing` CLAIM, not its row (see the two-stamps
  invariant above). `status({doing})` re-asserts instantly; agents never need to keep one alive.
- **Dual-channel answer sync** *(#29)* — the `answer` MCP tool plus `answerItem`/`reply_source`.
  Agent-mediated by design: this repo has no hook into any chat client, so the AGENT is the
  bridge. Convergence is order-independent (inbox precedence, no clock comparison) rather than
  the issue's original "timestamp-based last write wins". Known limitation, worth a follow-up:
  once a chat answer lands, `reply_seen_at` is set, so the card's "Change answer" (a
  blank-clear) is refused and the human cannot re-answer that item from the viewer.
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
- **Board-annotation delivery** *(#37)* — `pending()` returns `{items, rows}`: the human's per-row
  board notes ride the one poll every agent already makes, project-scoped like items, and a
  `blocked` row keeps arriving until an agent acknowledges it by flipping the status. See the
  delivery-is-not-acknowledgement invariant above; `docs/reporting-snippet.md` and the `pending`/
  `board_row` tool descriptions all say that the STATUS FLIP is the acknowledgement.
- **The human's "I did my part" mark on a blocked row** *(#36)* — `board_rows.handled_at` plus
  `handled_seen_at`/`handled_seen_by`. It exists because every `blocked` row in the wild is a
  TASK ("create the Paddle account", "record the hero demo"), not a question, and the viewer
  only offered a free-text box: a task wants DONE, and with the asking session over nobody was
  ever going to flip the status. Four things are load-bearing. (1) **It is not the `done`
  STATUS** — that is the agent's assertion about the row's work and only agents write it; the
  labels say so (`I've done my part` / `Not done after all`, and "You marked your part done" on
  the card). (2) **`upsertBoard` can never clear it**, and exactly one thing can: a status
  transition INTO `blocked` from something else (`resetHandledOnReblock`) — see the sacred-fields
  invariant above. (3) **The row does not vanish**: `isBlockedRowAttention` drops it via
  `humanActedOnRow`, and `awaitingAgentRows` picks it straight back up into the same
  awaiting-pickup foot an annotated row lands in. (4) **The undo is real or absent** — the store
  refuses a clear once `handled_seen_at` is set (one guarded statement, no TOCTOU), and the
  viewer does not draw the button when its own snapshot already shows a delivery. That is the
  rule the row ✕ removed in #38 broke: never draw a control that lies.
- **`blocked` now says WHO it waits on** *(#44)* — the six stored values are unchanged: no
  `needs-you` alias, no rename. The ambiguity was purely agent-facing (the viewer's 🚧 + Needs-you
  reads unambiguously), and the mistake is *choosing* `blocked` for work no person can unblock — a
  row went into the human's banner because a release candidate did not exist yet — so an alias
  would have added a seventh-looking status without removing the trap, and a rename would migrate
  every DB, the CSS and `attention.js` to fix a sentence. The fix is the text agents read: both
  board tool descriptions AND a zod `.describe()` on the `status` FIELD (the text a model reads
  while filling in an enum), each carrying the NEGATIVE example — stuck on a failing test, a
  missing build or another PR is `partial`, never `blocked`. `docs/reporting-snippet.md` gained
  one sentence of the same. Pinned over a real `tools/list` in `test/mcp.integration.test.ts`,
  which is also the only proof the field description survives `.optional()` and array-items.
- **Agent-read payload diet** *(#42)* — `src/shape.ts`. MCP reads omit agent-authored `context` and
  report `context_chars` instead; `board_get()` with no title is a summary; and a given context is
  handed over ONCE per server process (the human's words still come back on every poll — #37 is
  untouched). Two escape hatches, both named in the tool descriptions: `pending({full:true})` for
  items and rows, `board_get({title, full:true})` for a board. Measured against a copy of the live
  db (`JSON length / 3.6`, the issue's method): `board_get()` 11,493 → 2,604 tok (agent-inbox),
  14,818 → 3,955 (oris); the biggest single board 4,361 → 1,551, unchanged under `full:true`; and,
  with the project's 14 heavy rows synthetically blocked, 20 polls 136,791 → 52,568. It costs +477
  tok of tool definitions once per session. `docs/reporting-snippet.md` is deliberately unchanged —
  agents should keep writing generous `context` for the human; the tool descriptions carry the
  payload contract.
- **The agent-emit contract** — `docs/reporting-snippet.md`'s end-of-turn rule now tests "am I about
  to stop and wait on the human?", so recommendations and "say the word" moments get flagged
  instead of buried. Mirrored in the `flag` tool description so agents get it at the call site.
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

## Open backlog — and the seams already in place

- **Remote / hosted mode** *(#8)* — run on a server, tunnel-exposed for phone + cloud-agent reach.
  Swap stdio for **streamable-HTTP** and add **auth** (bearer token in MCP client headers + a gate
  on the viewer). `register` is the identity seam: a remote server can't see the client's `cwd`, so
  agents declare scope via `register` instead of auto-inference. `AGENT_INBOX_DB`/`AGENT_INBOX_PORT`
  env overrides are already in place. Design (three blocking decisions, three verified wiring traps):
  [`docs/superpowers/specs/2026-07-26-remote-hosted-mode-design.md`](docs/superpowers/specs/2026-07-26-remote-hosted-mode-design.md).
- **The human's exit from an UNANNOTATED blocked row** *(#36, remaining half)* — #37 fixed the
  annotated case: writing a note now clears the row from the badge with no agent round-trip. A
  blocked row the human has NOT answered still has no lever they can pull (there is no route to
  change a row's status and no per-row dismiss). Needs `POST /api/boards/:id/rows/:rowId/status`
  or a lighter "acknowledge"; the live DB has one such row today. Until then the Needs-you ✕
  does not render on a board row at all (`needsRowEl`'s `dismissBit`, pinned in
  `test/dom/row-dismiss.test.ts`) — it used to draw, advertise the `x` key and do nothing.
  Draw it back in only together with the route behind it.
- **Item-annotation delivery** *(not yet filed — #37 with a different noun)* — the viewer's Note
  button renders on EVERY open item (`card.js`'s `showActions: !done`, no kind check), but
  `listPending` filters `kind='question' AND status='open'`, so a human's note on a `note` item, a
  `done` milestone or a resolved question reaches no agent, ever — and items have no
  `annotation_seen_at`, so the viewer cannot even show that it was not delivered. The fix mirrors
  #37 exactly: `items.annotation_seen_at`/`annotation_seen_by`, the same CAS, and open items of any
  kind carrying an annotation in `pending()`'s payload. Deliberately NOT bundled into #37 — it is a
  different noun with its own viewer surface — but the column shape is decided, so it is additive.

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
