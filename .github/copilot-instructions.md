# Copilot instructions for agent-inbox

`agent-inbox` is local infrastructure: a stdio MCP server, a shared SQLite store,
a Hono viewer, a plain-JavaScript frontend, and an Electron wrapper. There are no
model calls. Read `CLAUDE.md` before changing delivery, board, activity, attention,
polling, hook, or packaging behavior; it records the detailed invariants and the
regressions that established them.

## Runtime and commands

Use Node 24 for this checkout. `.node-version` pins it and the installed
`better-sqlite3` binding is compiled for that ABI. The MCP integration tests spawn
`npx tsx src/mcp-server.ts`, so Node 24 must be active in the shell running tests.

```sh
fnm use 24

npm test                              # full Vitest suite, one shot
npm run test:watch                    # Vitest watch mode
npx vitest run test/store.test.ts     # one test file
npx vitest run test/dom/              # all jsdom viewer tests
npx vitest run test/store.test.ts -t "test name"  # one named test

npm run typecheck                     # strict tsc over src/ and test/
npm run build                         # src-only build via tsconfig.build.json

npm run mcp                           # stdio MCP server from source
npm run view                          # viewer at http://127.0.0.1:4319
npm run electron                      # Electron wrapper in development
npm run package:app                   # build the self-contained macOS app

npm run install:agents                # dry-run MCP + host-instructions setup
npm run install:agents -- --apply     # install for Claude Code and Copilot CLI
npm run install:hooks                 # dry-run the Claude hook installer
npm run install:hooks -- --apply      # write the hook configuration
```

`npm run build` must continue to use `tsconfig.build.json`: its `rootDir: "src"`
keeps entries such as `dist/mcp-server.js` flat. The base `tsconfig.json` includes
tests for typechecking and would emit an unwanted `dist/src/` tree.
Run the build before `npm run electron`; the development shell starts the built
`dist/viewer-server.js`.

## Architecture

- **Shared data hub:** `src/store.ts` owns the schema, migrations, WAL connection,
  and every database read/write. The default database is
  `~/.agent-inbox/inbox.db`; `AGENT_INBOX_DB` overrides it.
- **Agent path:** `src/mcp-server.ts` opens the store and connects
  `buildMcpServer()` from `src/mcp.ts` over stdio. `src/scope.ts` and
  `src/infer.ts` lazily infer project, branch, client, GitHub repo, and issue
  identity. One long-lived server process represents a CLI process; parent and
  subagents may share its session id and context-delivery ledger.
- **Human path:** `src/viewer-server.ts` creates the Hono API in `src/viewer.ts`,
  starts the viewer-only PR poller, and serves `public/`. The frontend is native
  browser ESM with no bundler. Electron stages `dist/`, `public/`, and `electron/`
  and rebuilds `better-sqlite3` for Electron's ABI.
- **Local network boundary:** `src/viewer-network.ts` wraps the viewer/static app
  before routing, binds only `127.0.0.1`, validates exact loopback Host/Origin
  values, requires a trusted Origin for every mutation, denies framing, and emits
  the hardening marker Electron requires before reuse. `localhost` is an exact
  browser alias, not a wider bind. Keep it out of the MCP graph and do not add a
  host-widening environment variable.
- **Strict process boundaries:** `src/prstate.ts`, `src/issue-poller.ts` (#103)
  and `src/stamp.ts` are viewer-process concerns; they must not enter the MCP
  import graph. The two `gh` pollers share one tick (issues first, then PRs
  with a 45-second start deadline) and one busy guard.
  `src/shape.ts` trims agent-facing MCP read payloads and must not affect viewer
  API payloads. `src/hook.ts`/`hook-cli.ts` and `src/watch.ts`/`watch-cli.ts` are
  separate host adapters that still access data through `store.ts`.
  `src/agent-hosts.ts` (#197) is viewer-process-only and read-only: it keeps only
  the `agent-inbox` entry of each host config (and agent-inbox hook entries), never
  returns or logs anything else, and never spawns a process — not even a host CLI.
  Its runtime rule must stay the installer's ownership rule; a test pins agreement.
  `src/issue-graph.ts` and `public/issue-key.js` (#103) are pure; the MCP server
  admits them (with `public/source.js`/`esc.js`) only for the titled `board_get`
  `issue_rel` summary, and a test pins the transitive stdio MCP import graph.
  `scripts/stage-runtime.mjs` stages the `public/` modules `dist/` reaches, so a
  runtime payload can load them. Every shipped `node_modules` copy is pruned by
  `scripts/prune-node-modules.mjs` before it is tested, manifested or signed
  (#291): better-sqlite3 keeps only `package.json`, `lib/` and its addon, every
  package loses typings, source maps and markdown, and license and notice files
  always stay. The thin-app gates refuse an unpruned copy, and the macOS runtime
  signing list is exactly `bin/node` and the addon. Every package ships only US and
  British English Electron locales (#292): `scripts/prune-electron-locales.mjs` keeps
  `en.lproj` and `en_GB.lproj` on macOS and `locales/en-US.pak` and `en-GB.pak` on Linux
  and Windows, once, right after `@electron/packager` and before anything checks, hashes
  or signs the app; the thin-app, universal and final-DMG gates refuse an app with any
  other locale, without either of those, or reaching either through a linked folder.
  Electron seeds a new profile's spellchecker from that locale, so on Linux and Windows
  `electron/spellcheck-languages.cjs` sets the system's languages at startup on a profile
  with none in the system's first language (a seeded `en-GB` for Commonwealth English
  users stays); macOS keeps its own `NSSpellChecker`.
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
  Setup's Runtimes block (#294 part B) lists the runtimes from `src/runtime-inventory.ts`, a
  viewer-only, read-only mirror of that rule held to agreement with the script
  by `test/runtime-inventory.test.ts`; it walks only unused runtimes, keeps
  answers per folder and config stamp, and its one Remove re-reads the list
  before it calls exactly `install('prune-runtimes')`.
- **Shared presentation rules:** `public/attention.js` is the single attention
  predicate used by the viewer and Electron dock badge. Pure modules under
  `public/` hold grouping, ordering, search, badge, polling, and rendering rules;
  `public/app.js` coordinates DOM and API effects.

## Codebase-specific conventions

- TypeScript is strict NodeNext ESM. Source imports use `.js` specifiers even
  when the imported file is `.ts`. `noUncheckedIndexedAccess` is enabled, so
  guard array and map lookups rather than weakening types.
- Keep `zod` as a direct dependency: `src/mcp.ts` uses it for MCP tool schemas.
- Do not issue raw SQL outside `src/store.ts`. The viewer, MCP server, hooks,
  watcher, and PR poller all share one database across OS processes. Preserve
  `journal_mode=WAL` and `busy_timeout=5000`, and make any transaction that
  reads before it may write `.immediate()`: SQLite never waits when a deferred
  reader is promoted to the writer.
- Conditional viewer snapshots retain only items, the dock watcher's
  `/api/items?scope=attention` and `/api/boards?scope=attention` projections (#156,
  #287; each its own validator, never the default representation's),
  `/api/items/history` (likewise its own), active/archived boards,
  the `/api/issues` sub-issue graph (#103, likewise its own; its builder is pure,
  so its bytes depend on the database alone) and the `/api/links` PR state (#288,
  likewise its own; the PR poller writes it through `store.ts` and its previews
  follow open items and active plans, so its bytes depend on the database alone too,
  and a 404, network error or refused body still means no links). `/api/items` and
  `/api/boards` never carry GitHub data, so issue snapshot writes leave their bytes
  and validators unchanged.
  The dock watcher reads its two projections conditionally through
  `electron/conditional-read.cjs` and still runs the shared predicate every tick,
  because the clock alone changes what it decides.
  Invalidate on same/other-connection writes, schema changes and pickup stamps;
  never cache an uncommitted snapshot. Keep dynamic routes fresh, no-store and
  the boot marker intact, and never turn a read failure into cached success.
  Activity history changes with time alone, so it is conditional only on a hash
  of its freshly computed bytes plus the window and project that selected them;
  never validate it with store tokens or cache it server-side (#185).
- `/api/items` pages closed history (#184): every open item, the 50 most recently
  touched closed items, the 4 newest outcome-bearing ones of open projects and a
  `history` summary that keeps every count exact. Only `load()` reads
  `/api/items/history`, while `historyWanted()` says a surface needs older items,
  judged on a page alone (`lastData.page` or the tick's new one), never on merged
  data. Explicit human entry points use `requestHistoryPaint()` (ends in
  `reloadAndPaint()`, #38); search and waiting deep links use `requestHistory()`,
  which only schedules that `load()`; `forceRender`, renders and the poll use
  neither. A failed read degrades: the page still applies and waiting surfaces
  say older history is unavailable.
- Plan pins and row issue links (#103 PR2) are agent-owned fields: omission keeps,
  MCP `""` clears, `board_advance` and a reblock keep them, and a pin outranks the
  PR and branch issue. MCP normalizes every accepted form to `owner/name#N` and
  refuses anything else; `pending()` and the title-less `board_get` never carry them.
- A row's `waits_on` (#103 slice 2) names other rows of the same plan by label, stored
  sorted as JSON. Omission keeps, `[]` clears, `board_advance` and a reblock keep it.
  `store.ts` checks it inside the writing `.immediate()` transaction, and only what the
  write adds: a newly named label must be a row of the plan, no row names itself, at most
  20, and no added or revived edge may close a cycle. That cycle check holds the write
  lock, so it stays linear: components once, then one path search for the edge the error
  names; never a search per edge. A label whose row was removed stays, never re-checked;
  never prune it. Only titled `board_get` echoes it, and it never makes a row `blocked` or
  enters attention.
- GitHub dependencies (#103 slice 2 PR B) become `blocks` edges (blocker → dependent) in the
  pure `buildIssueGraph`: positives from a root's own bound `ok` `blocked_by`/`blocking`,
  negatives only from a complete list that omits the other end, the newest wins and a negative
  wins ties, nothing at or before either end's hard failure counts, and cycles are kept with
  `cycle: true` (iterative SCC, no recursion, no new stdio module). A node's `deps` come only
  from its own section. The cap keeps S1's order, then fills dependency neighbours round-robin
  (blockers before dependents, by key); a `blocks` edge needs both nodes emitted, all edges stay
  within twice the node budget, and every omission is counted (a root's
  `dependencies_omitted`, and `dependencies_omitted_open` `{ blocked_by, blocking }` for
  those whose other end is OPEN by its freshest facts, #275). `snapshots.js` accepts the
  body unchanged and PR D draws it (below). `issue_rel`
  adds `waits_on_issues` (open blocker keys, at most 50) and `unblocks` only while the key's own
  section is bound, `ok`, at most 7 days old and not dropped by rule 6 (that root reports
  `unknown`); never name them `waits_on` (a row's writable step labels) or anything built on
  "blocked". The cap bounds the response, not the work: the build reads every display root's
  dependency entries, so keep it linear, with no per-pair strings and no global sort.
- Breadcrumbs and child progress (#103 PR3) are ambient. `/api/issues` is the
  poll's eighth read, through its own snapshot validator and a links-style
  fallback: a 404, network error or refused body means no graph and today's plain
  chips, never a failed tick. `public/issues.js` (`buildIssueView`, pure) is
  rebuilt in `paintAmbient` beside `linkIndex`; it ages relationships (dim after
  30 min, hide after 7 days, "unavailable" with no title after a hard failure),
  draws an issue whose own root says `hierarchy: 'unavailable'` as the plain chip
  with one "Relationships unavailable" line (`issueRelations` reads the same
  root field, so the agent's `issue_rel` agrees), and its activity labels READ the
  frame's `attentionEntries` and never feed a badge or count. `public/source.js`
  draws it: `issueRef` delegates to `issueKeyFor`, a linked row names its own
  issue, every relationship link is built from a validated slug and number while
  the issue chip keeps #30's URL rules (filtered by `safeHttpUrl()`), every href
  comes from `chipHtml()`, and the word "Blocked" never appears. History keeps its
  plain chip, and labels open their target only through `focusItem`.
- "Waits on" in Plans (#103 slice 2 PR D) is ambient. `buildIssueView` gives a drawn
  relation `dependencies` only when its root says `dependencies: "ok"` (open blockers and
  dependents, activity labels read from `attentionEntries`, `cycle`, and +N counts of open
  ones beyond the page (any unlisted open one when the direction's total exceeds GitHub's
  50-entry page, which includes closed issues), hidden from the account (only when the page
  was complete) or cut by the cap: "+N not shown" counts only the open ones the cap cut,
  `dependencies_omitted_open`, and each direction is taken only from its own lines, #275), `{status:'unavailable'}`
  for a refused section, and `null` otherwise: never "no dependencies". `planWaits` and
  `rowWaits` merge a row's unfinished `waits_on` steps (local, drawn with no graph; dangling
  labels and `done` or `na` targets draw nothing) with its issue's open blockers, one entry per pair.
  Chips and lists are built only in `public/source.js` (`esc()`, `chipHtml()`, a link only
  from a validated slug and number, `tone-issue`/`tone-stale`, never the word "Blocked");
  matrix chips stay out of the roving order. No dependency or `waits_on` value reaches
  attention, a badge, a count or the dock.
- Plan flow (#103 slice 2 PR E) reuses D's view: `buildMission(board, { issues, links })`
  is pure, keeps the agent's row order, and adds per-step `waitsOn`/`unblocks` (in-plan
  steps merged across both sources, `unblocks` the exact inverse; local `waits_on` to
  `done`/`na` steps are satisfied, while GitHub edges follow the open issue, so a `done`
  row whose issue is still open can still be waited on), external issues with their activity label (never a cross-plan edge), a
  `partOf` rail where the parent differs from the plan's issue, `circular`, and the
  "Not in this plan" fold. Prose never creates an edge. `public/source.js` draws it;
  only a step button's click calls `focusMissionStep` (focus with `preventScroll`, then
  `revealControl` inside the flow); passive restores never reveal, and nothing reaches
  attention.
- Grouping plans by parent issue (#103 slice 2) is opt-in and only reorders.
  `agent-inbox-group-plans` is a saved preference seeded on every load (like
  #221's sort order); the Plans header switch changes only the current view, and
  both repaint through `forceRender()`. `planGroups` (pure, `public/issues.js`)
  keys a group by `(project, parent)`, needs two active plans, and admits a plan
  only through a certain identity whose relation is `fresh` or `stale`; anything
  else stays flat in its place, and no plan is ever hidden. Lingering and archived
  plans are not grouped. Headers are built in `public/source.js` and no grouping
  value reaches attention, a badge, a count or the dock.
- Issue snapshots (#103) are written only through `upsertIssueSnapshot` and
  `recordIssueFailure`. The attempt rule (apply only when the attempt started after
  the stored `checked_at`) is the `WHERE` of one upsert; a hard failure clears the
  snapshot and `fetched_at` in that same statement; a soft failure keeps the last
  answer, snapshot or hard failure, and only advances `checked_at`. Reads validate
  the v1 shape and treat anything else as "no snapshot", never an exception.
  The poller applies them only through `completeIssueRefresh`, after
  `claimIssueRefresh` leased the keys; both are one `.immediate()` transaction,
  a lease expires after 60 s, and a claim skips any key whose `checked_at` moved
  since the queue was read. `closing_refs` is bound to the `fetched_at` written
  beside it; an older process's success write unbinds it. Slice 2's
  `dependencies` column follows the same rule: written in the same statement as
  the snapshot, read only while its `fetched_at` equals the row's (else
  "unknown", never "no dependencies"); an older process's success or hard
  failure unbinds it, a soft failure keeps it bound. A success without a bound
  section is fetched again at once (the queue's `upgrade` tier) unless its
  `checked_at` is ahead of the clock; a failure keeps its own TTL. GitHub
  marks the dependency fields and `subIssues`/`subIssuesSummary` non-null, so
  each group is asked on an alias of its own per issue (`dN`, `hN`): an error
  there nulls only `dN.issue` or `hN.issue`, makes only that section
  unavailable, and leaves the issue and its parent chain in `rN` refreshing.
- Race-sensitive state changes must be atomic SQL statements or transactions.
  Do not replace conditioned/version-pinned updates with SELECT-then-UPDATE.
  Human replies, annotations, and handled marks can change from another process
  between reads and writes.
- Viewer JSON write routes parse with `.catch(() => null)` and type-check every
  field before any store call. Invalid input is `400 { ok: false, error }`; a
  store refusal of a valid request stays `200 { ok: false }` because `postJSON()`
  treats any non-2xx as "the write never happened". An explicit `''` still clears.
- Inbox answers have precedence over chat-recorded answers. `answerItem()` must
  refuse to overwrite an unread inbox answer; this is intentionally not
  timestamp-based last-write-wins. A human reply that carries `expect_answer`
  (#321) is written only while the question still holds that answer.
- Item response and annotation snapshots use monotonic `response_revision`, not
  timestamps alone. MCP resolution after response history requires the exact
  `expected_response_revision` handled by that caller. Question reply/annotation
  pickup is atomic; another reader's pickup cannot authorize a stale resolution.
- Informational annotations enter MCP `pending` until picked up, without adding
  attention or closing the item. `pending({item_id})` recovers current open-item
  feedback and clear state afterward. Keep hook/backstop reads question-only by
  default, retain first-pickup receipts, and refuse annotation writes to closed items.
- Boards are idempotent by `(project, title)` and rows by stable `label`.
  A full `board_upsert` deletes rows omitted from the payload, but omitting a
  row's `note`, `next_step`, `impact`, `next_after`, `action_owner`, `options`,
  `context`, or `outcome` preserves the stored value; explicit empty values
  (`''`, `options: []`) clear them.
  Never overwrite or reset human-owned annotation, handled, or delivery fields
  during routine upserts.
- `blocked` is the only row status that means the human must act. A failing
  test, missing build, another PR, or other non-human dependency is `partial` or
  `tracked`. A blocked row remains pending until an agent changes its status;
  delivery stamps are not acknowledgements.
- Human blockers are action-first data, not prose conventions. Item `detail` and
  row `note` are one-sentence TL;DRs; `next_step` is one concrete human action.
  `action_owner` identifies decision/task/approval, `impact` says why now, and
  `next_after` says what follows. decision/approval carries 2-4 `options`; task
  omits them so the viewer offers "I've done my part." Long history belongs in
  collapsed `context`.
- Snoozed and pinned work (#247) leaves badge attention but remains on screen
  (`laterEntries`, tagged by reason; a pin wins): in one Later section at the foot
  of the queue while `agent-inbox-later-section` is on (the default; any value
  but `'false'`), otherwise in separate snoozed and pinned folds with the Pin
  control hidden. That setting is layout only, like #221's sort order: it never
  reaches attention, a badge, a count or the dock, which cannot read it. One
  render-time rule keeps cards visible: the fold under the queue (Later,
  snoozed, pinned or stale) that holds the open card always renders open,
  whatever moved its ask there (the clock included), and the human closing that
  fold closes the card (keeping its draft).
  Every deferral goes through `deferAsk`: an ask that holds a draft keeps or
  takes the open card (switching to the Inbox when the Review queue was opened
  on another tab), and one without a draft closes it, so only the human's own
  close can put a draft that pauses the list out of sight.
  Clarify/decline are response kinds, not outcomes. `board_advance` is the only
  same-row chain operation: it CAS-pins row `revision`, archives the prior step,
  and clears human/delivery state atomically. Agent reads get `history_count`, not
  full history.
- Every existing-row agent mutation and every human/browser/native row action is
  pinned to row `revision`; never weaken those writes back to row-id-only updates.
  A move alone bumps only the board revision, never the row `revision` or
  `updated_at`; otherwise native notifications re-announce unchanged asks (#158).
- Item/row `updated_at` is for content changes only. Delivery stamp writes must
  never bump it or the New/changed filter becomes a polling firehose.
- Activity has two meanings: `updated_at` is process liveness and
  `last_call_at` is real MCP work. The periodic liveness tick must call only
  `touchActivity`; tool calls record work with `recordActivityCall`.
  `server_version`/`server_source` (#197) are display-only build identity carried
  by existing presence/status writes; an omitted value keeps the stored one, and
  neither is ever evidence of liveness, work or attention.
- MCP stdout is the protocol channel. Never add `console.log` in the MCP server
  path or let subprocess stdout inherit it. Capture subprocess output. Viewer
  logging is allowed. Hook CLI stdout/stderr and exit codes are also protocol
  contracts; preserve the exact behavior documented in `docs/hooks.md`.
- The Copilot answer watcher is host-owned, exact-item, and read-only. The MCP
  server returns its launch contract but must never spawn it; only a host-owned
  detached command can wake the originating session. Preserve `process.execArgv`
  and the explicit database path so source and built execution behave alike.
  Its wait backs off statelessly from the ask's age through one function
  (`watchTimeoutMs`) that both the contract and the watcher evaluate (#217).
- The human's watch stop (`watch_stopped_at`/`watch_stopped_until`, #217) is
  human-owned, version-pinned and not content: upserts never touch it, a stop
  for good is final, and its writes bump neither revision nor `updated_at`.
  A new action clears it through the `reset_row_action_watch_state` trigger, so
  an older server's re-block cannot carry it over. The control follows the
  ask's own `action_agent` (never `boards.agent`); an unknown asker draws
  nothing. It never changes attention by itself, and Claude's hook watch
  ignores it because that watch never wakes on a timeout. With the Later
  section on, the stop-waiting routes get `defer: true` (#247): ONE `.immediate()`
  transaction applies the stop and, against the same revisions, a pin (stop for
  good) or the ordinary snooze (until a time), or neither.
- The human's pin for later (`pinned_at`, #247) is human-owned, version-pinned
  and not content, like the watch stop: its writes bump neither revision nor
  `updated_at`, and no agent write names it. The triggers
  `clear_row_pin_when_ask_ends` and `clear_item_pin_when_ask_ends` clear it when
  the ask is answered, closed or unblocked, or a new action starts, so an older
  server's writes cannot carry it over. A pin and a snooze with a time replace
  each other. The attention predicate drops a pinned ask, and Electron's
  notification `known` set keeps pinned asks (`knownNotificationIds`), so
  bringing one back is never announced as new.
- Keep network access out of the MCP process. Repository/branch identity is
  inferred locally; live PR and issue state is fetched only by the viewer's `gh`
  pollers (`src/prstate.ts`, `src/issue-poller.ts`).
  PR/check state is ambient information and must not enter the human-attention
  predicate.
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
- All agent-authored text interpolated into HTML must pass through `esc()`.
  Supplied URLs additionally pass through `safeHttpUrl()` in
  `public/source.js`; build anchors through the existing `chipHtml()` path.
- Links in agent text (#300) are found only by `public/links.js` (GitHub
  references and local paths; URLs stay in `structured-text.js`, which must
  stay under 350 lines) and drawn only by `public/source.js`. Detection is
  conservative: ordinals, counters, colours, routes such as `/api/items`,
  globs and paths with spaces stay plain. A local file is never an href: it
  carries its path in an escaped `data-link-path`. `public/link-strip.js`
  lists a card's links by collecting what `renderStructuredText` renders, so
  the strip never shows a link from a fence or quarantined markup, and nothing
  about links reaches attention, a badge or a count. Only Electron main opens
  anything: `public/link-open.js` calls the one preload method
  `agentInboxLinks.open`, and `electron/link-open.cjs` re-checks the sender
  (the viewer window's top frame on its origin; a local file also needs the
  binding's `files` grant, so only the viewer this app started and owns opens
  or reveals files, a reused one copies the path and main refuses it as
  `unowned`; `agentInboxLinks.filesAvailable()` reads the grant), the request's exact shape,
  http(s) only, and a file's final target: folders, apps, denied types
  (launchers, installers, disk images, executables, macro documents, …) and
  any execute bit are only revealed. Opening is an allow-list of common
  document types; anything else is revealed, and on macOS so is an alias or a
  file with its own Open With (checked through `/usr/bin/xattr`, argv only,
  failing closed). `setWindowOpenHandler` and `will-navigate` share the same
  http(s) check. A browser copies a file's path instead.
- Settings → Links (#300 part 2, macOS only) lives in main:
  `electron/link-preferences.cjs` keeps per-type rules in userData
  `link-preferences.json` (schema 1, `createLockedFile`, tolerant reader that
  never overwrites a newer schema). The renderer names a rule and a handler,
  never an app path; an app comes only from main's own `dialog.showOpenDialog`
  limited to `.app` bundles, and `launchableApp` re-checks it at every launch
  (real path, `Contents/Info.plist`, never an app that runs what it opens or
  hands it to its default app, such as Finder).
  A rule is read only after folders, bundles, denied types and execute bits
  are revealed, and the alias and Open With checks run before it opens
  anything. An app or Quick Look rule may open a type off the allow-list (a
  code file in an editor); System default never does. Launches use argv only
  (`/usr/bin/open -a <app> -- <target>`, `/usr/bin/qlmanage -p <file>`), no
  shell, stdio ignored. On the window's own open path, a chosen browser that
  fails falls back to the default one. Rules, Quick Look and Reveal are file
  requests, so they share the owned-viewer `files` grant, and so do the
  Settings → Links channels (a reused viewer gets `error: 'unowned'`).
- Repo-relative paths (#324) link only in a card whose item or plan recorded
  `repo_root` (additive, nullable columns on `items` and `boards`): the MCP
  server's `git rev-parse --show-toplevel`, read live by `scope.rootFor()` on
  writes only (never in `get()`, never memoized, fail open to null). A board
  write that finds none keeps the stored folder (`COALESCE`); `board_advance`
  and older servers never touch it. Agent reads never return it
  (`agentItem`/`shapeBoard` in `src/shape.ts`). `public/links.js` detects them
  conservatively (a folder and a name, an extension or a file-like name with
  `:line`, no dotted first folder, no `.`/`..`/`...` segment), reading at most
  255 characters a segment and 1024 in all (longer links nothing), with no
  pattern that can backtrack over agent text: the render runs on every
  3-second poll, so a quadratic regex there freezes the viewer. They carry
  the folder in an escaped `data-link-root`, never an href. Main joins a plain
  relative path to the folder (`joinRepoPath`), refuses it as `outside` when
  its real path leaves the folder's real path, and then applies the same
  policy and grant as any file. A missing one copies its path instead.
- The 3-second poll uses the gated `load()`/`renderIfIdle()` path. Its reads
  run concurrently, but a tick applies only after all settle, and only if no newer
  tick has applied and every boot marker agrees. A successful
  human-initiated write must end in `reloadAndPaint()` so an unrelated draft
  cannot hide the result. A held pointer defers rendering but is not a
  suspension and must not appear in `suspendState()`.
- A text selection is captured before and restored after each rebuild by both
  render entries (`public/selection.js`, #223). It never defers or suspends a
  frame, never focuses or scrolls, and is dropped when its text changed.
  Copy text when selected (#222) is an opt-in setting that copies only a
  selection changed by the gesture, outside editors, through structured-copy's
  `writeClipboard`; it never stops or prevents an event.
- Browser snapshot reuse is window-local and immutable; a 304 belongs to the
  representation that request sent, and its live boot header still controls safe
  refresh. Passive polls may retain inactive document panes, but navigation and
  human writes must paint current data without hiding ambient or recovery state.
- Unsent drafts (#279) are mirrored into this profile's `localStorage`
  (`agent-inbox-drafts-v1`) through the pure `public/drafts.js`, never to the
  server, the hub database or an agent. The window's memory stays authoritative:
  a save writes only what changed, so a successful send, Clear or an emptied
  editor deletes the stored copy and a refused send keeps it. Restoring happens
  once in the first applied `load()`: an unchanged target in an open project gets
  its draft back in its editor; anything else goes to the unsent responses with a
  reason, "not confirmed" once a send of it was tried and its target moved.
  Nothing is ever sent, focused or switched for the human. Question drafts pin the
  question's answer, not `response_revision`; each reply intent carries its own
  pin. One rule, `savedIntentRule`, decides every reuse of a saved intent (Retry,
  an editor's Send after an unconfirmed send): the server holds exactly that
  response, so it retires unsent; the answer moved since the pin, so the send is
  fresh; otherwise the exact replay. Never move a pin while keeping its intent. The
  rule reads the last poll, so the reply route also says, additively, whether a
  request `wrote`, whether it `replayed` a recorded intent, and the `answer` it left
  (#322); `ok` keeps its meaning. A replay that wrote nothing under someone else's
  answer keeps the text as an unsent response, with its spent intent dropped. An
  editor's Send and an unsent response's Retry never replace an answer the surface
  has not shown (#321): the first click names it in place ("A newer reply was sent:
  …"), only a further click sends, and the send carries `expect_answer`, which
  `replyItem` checks in the same conditioned UPDATE, refusing with `reason:
  'answer_changed'` and the answer that stands. A question with no answer accepts
  any expectation, and a refusal naming exactly the sent response retires it as
  sent. Never send to get past a notice. A
  window deletes only the copy it loaded or last wrote, and its leaving save
  writes back a draft another window deleted; the viewer-restart hold stays.
- Every value export in `src/*.ts` and `public/*.js` must be reachable from
  production code. Tests are not consumers. `test/dead-exports.test.ts` enforces
  this; deliberate exceptions require the existing documented mechanisms.
- Workspace hygiene: the session that merges a PR or publishes a release removes
  its worktree (`git worktree remove`), local and remote branch, reviewer `/tmp`
  trees, release downloads and old `build/` outputs before reporting completion,
  and only after the checks in `docs/workspace-hygiene.md` pass. Never touch the
  live checkout's `dist/`/`node_modules`, `~/.agent-inbox` data, referenced
  runtimes, session state, or other sessions' work; keep and report instead.

## Test conventions

- Store and viewer tests use real temporary SQLite databases through
  `openDb()`; do not mock the store. `test/mcp.integration.test.ts` performs a
  real stdio client/server round trip.
- Make scratch directories with `scratchDir()` from `test/scratch.ts`, never a
  bare `mkdtempSync` under `tmpdir()`, so repeated runs do not fill `$TMPDIR`
  (#240, #245). The `test/scratch-setup.ts` setupFile removes a file's leftovers
  when it ends; call `removeScratchDirs()` from `afterEach` as well when no
  directory is made in `beforeAll` or at module level. The one exception,
  `test/hook.test.ts`'s module-level project repository, is removed by that
  file's own `afterAll`.
- Node is the default Vitest environment. DOM tests opt in per file with
  `// @vitest-environment jsdom`; keep `test/dom/harness.ts` outside the
  `*.test.ts` naming pattern.
- The DOM harness imports the unmodified `public/app.js` module graph and bridges
  `fetch` to the real Hono app. Keep `publicDir: false` and the absolute-module
  alias in `vitest.config.ts`.
- In DOM fixtures, fake timers freeze `Date`; call `advanceClock()` between
  writes when ordering or timestamps matter. Assert rendered state rather than
  listener invocation counts because window/document listeners accumulate
  across repeated boots in one test file.
- jsdom cannot validate this project's media-query layer, unresolved CSS
  variables, silently dropped declarations, the affected `font` shorthand, or
  which of two competing rules wins when one is a selector list.
  Cover those cases with pure-JS behavior or source-level assertions instead of
  treating computed style as evidence.
