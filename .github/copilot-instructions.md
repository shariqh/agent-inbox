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
  values, denies framing, and emits the hardening marker Electron requires before
  reuse. Keep it out of the MCP graph and do not add a host-widening environment
  variable.
- **Strict process boundaries:** `src/prstate.ts` and `src/stamp.ts` are
  viewer-process concerns; they must not enter the MCP import graph.
  `src/shape.ts` trims agent-facing MCP read payloads and must not affect viewer
  API payloads. `src/hook.ts`/`hook-cli.ts` and `src/watch.ts`/`watch-cli.ts` are
  separate host adapters that still access data through `store.ts`.
- **Setup path:** `scripts/install-agents.sh` is the canonical dry-run-first
  installer for MCP registration and managed host instructions. Electron exposes
  only fixed setup targets through `electron/setup-preload.cjs` and invokes that
  same script through `electron/setup-runner.cjs`; there is no HTTP setup-write
  route or general-purpose shell bridge.
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
  `journal_mode=WAL` and `busy_timeout=5000`.
- Race-sensitive state changes must be atomic SQL statements or transactions.
  Do not replace conditioned/version-pinned updates with SELECT-then-UPDATE.
  Human replies, annotations, and handled marks can change from another process
  between reads and writes.
- Inbox answers have precedence over chat-recorded answers. `answerItem()` must
  refuse to overwrite an unread inbox answer; this is intentionally not
  timestamp-based last-write-wins.
- Boards are idempotent by `(project, title)` and rows by stable `label`.
  A full `board_upsert` deletes rows omitted from the payload, but omitting a
  row's `context`, `next_step`, or `options` preserves the stored value; explicit
  empty values clear them.
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
- Snoozed work leaves badge attention but remains in the explicit snoozed fold.
  Clarify/decline are response kinds, not outcomes. `board_advance` is the only
  same-row chain operation: it CAS-pins row `revision`, archives the prior step,
  and clears human/delivery state atomically. Agent reads get `history_count`, not
  full history.
- Every existing-row agent mutation and every human/browser/native row action is
  pinned to row `revision`; never weaken those writes back to row-id-only updates.
- Item/row `updated_at` is for content changes only. Delivery stamp writes must
  never bump it or the New/changed filter becomes a polling firehose.
- Activity has two meanings: `updated_at` is process liveness and
  `last_call_at` is real MCP work. The periodic liveness tick must call only
  `touchActivity`; tool calls record work with `recordActivityCall`.
- MCP stdout is the protocol channel. Never add `console.log` in the MCP server
  path or let subprocess stdout inherit it. Capture subprocess output. Viewer
  logging is allowed. Hook CLI stdout/stderr and exit codes are also protocol
  contracts; preserve the exact behavior documented in `docs/hooks.md`.
- The Copilot answer watcher is host-owned, exact-item, and read-only. The MCP
  server returns its launch contract but must never spawn it; only a host-owned
  detached command can wake the originating session. Preserve `process.execArgv`
  and the explicit database path so source and built execution behave alike.
- Keep network access out of the MCP process. Repository/branch identity is
  inferred locally; live PR state is fetched only by the viewer's `gh` poller.
  PR/check state is ambient information and must not enter the human-attention
  predicate.
- Treat `scripts/install-agents.sh` as transactional infrastructure. It owns only
  the named MCP registration and marker-delimited instruction block, preserves
  unrelated content and symlink targets, uses timestamped backups, and holds a
  user-scoped `lockf`/`flock` lock while applying or rolling back changes.
- All agent-authored text interpolated into HTML must pass through `esc()`.
  Supplied URLs additionally pass through `safeHttpUrl()` in
  `public/source.js`; build anchors through the existing `chipHtml()` path.
- The 3-second poll uses the gated `load()`/`renderIfIdle()` path. A successful
  human-initiated write must end in `reloadAndPaint()` so an unrelated draft
  cannot hide the result. A held pointer defers rendering but is not a
  suspension and must not appear in `suspendState()`.
- Every value export in `src/*.ts` and `public/*.js` must be reachable from
  production code. Tests are not consumers. `test/dead-exports.test.ts` enforces
  this; deliberate exceptions require the existing documented mechanisms.

## Test conventions

- Store and viewer tests use real temporary SQLite databases through
  `openDb()`; do not mock the store. `test/mcp.integration.test.ts` performs a
  real stdio client/server round trip.
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
  variables, silently dropped declarations, or the affected `font` shorthand.
  Cover those cases with pure-JS behavior or source-level assertions instead of
  treating computed style as evidence.
