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
`board_upsert`, `board_row`, `board_advance`, `board_get`, `board_archive` (boards), `ack_message`
(session messages, #411) and `status` (live presence) — all defined in `src/mcp.ts`.

## Commands

```sh
fnm use 24                                    # always first (see below)
npm test            # vitest run — full suite (one shot)
npm run test:watch  # vitest watch
npm run typecheck   # tsc --noEmit (strict; noUncheckedIndexedAccess)
npm run build       # tsc -p tsconfig.build.json → dist/ (entry: dist/mcp-server.js)
npm run mcp         # run the MCP stdio server via tsx (local iteration)
npm run view        # run the viewer on http://127.0.0.1:4319 via tsx
npm run electron    # Electron wrapper in development (run the build first)
npm run package:app # build the self-contained macOS app
npm run install:agents [-- --apply]    # DRY RUN of MCP + host-instructions setup
npm run install:hooks           # DRY RUN of the opt-in backstop hooks installer (docs/hooks.md)
npm run install:hooks -- --apply    # …and actually write ~/.claude/settings.json
npm run meshctl -- status                         # Mesh M1 (#397): what mesh.json turns on
npm run meshctl -- enable --agents-view [--apply] # DRY RUN unless --apply; disable likewise
npx vitest run test/mcp.integration.test.ts   # single file
npx vitest run test/store.test.ts -t "test name"  # one named test
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

## Architecture in one screen

- **Store:** `src/store.ts` owns schema, migrations, the WAL connection and every query.
  The MCP server, viewer, hooks, watcher and pollers are separate OS processes on one file.
- **Agent path:** `src/mcp-server.ts` → `buildMcpServer()` in `src/mcp.ts` over stdio, one
  long-lived process per CLI (subagents share it); `src/scope.ts`/`src/infer.ts` infer scope.
- **Human path:** `src/viewer-server.ts` → Hono API in `src/viewer.ts` behind
  `src/viewer-network.ts`, serving `public/` (native ESM, no bundler); Electron wraps it.
- **Viewer-only:** the `gh` pollers (`src/prstate.ts`, `src/issue-poller.ts`), `src/stamp.ts`,
  `src/agent-hosts.ts`, `src/runtime-inventory.ts`. None may enter the stdio MCP import graph.
- **Host adapters:** `src/hook.ts` (Claude hooks), `src/watch.ts` (Copilot watcher).
- **Setup:** `scripts/install-agents.sh` / `install-hooks.sh`, dry-run first, under one lock.
- Full map of processes and import boundaries: `docs/architecture/overview.md`.

## Invariants that break things when missed

One line each; the detail, the reasons and the regressions behind them are in the doc named.

- No raw SQL outside `src/store.ts`; keep WAL + `busy_timeout=5000`; a transaction that reads
  then may write is `.immediate()` (#154). → store-and-snapshots
- Race-sensitive writes are one conditioned statement or transaction, never SELECT-then-UPDATE. → store-and-snapshots
- Conditional snapshots: never cache uncommitted data or turn a read failure into a cached
  success; the `snapshot_domains` triggers and rows are permanent (#297). → store-and-snapshots
- Closed history (#184) and archived plans (#299) are paged out of the poll; only `load()`
  reads the complete lists. → store-and-snapshots
- MCP stdout is the protocol channel: no `console.log`, subprocesses capture stdout. → mcp-server
- Fail-open, never lose a flag: failed inference attributes to `unknown` and still inserts. → mcp-server
- No network in the MCP process; `prstate`/`issue-poller` stay viewer-only. → overview, github-and-issues
- `src/shape.ts` trims agent reads only; the viewer never imports it (#42). → mcp-server
- Human annotations, handled marks and delivery stamps are sacred: upserts never reset them. → delivery-and-responses
- Delivery is not acknowledgement: a blocked row is re-delivered until an agent flips its status (#37). → delivery-and-responses
- Every row action and mark-seen write is version-pinned; resolve needs `expected_response_revision`. → delivery-and-responses
- Session messages reach only their own session (no tool takes a session id) and come back until `ack_message` (#411). → delivery-and-responses
- The Claude Code channel push (#411, research preview) is declared to Claude Code clients only and carries a message id, never text. → mcp-server
- The inbox answer always wins over a chat-recorded one; never last-write-wins. → delivery-and-responses
- `updated_at` means content changed; delivery stamps, moves, pins and watch stops never bump it. → delivery-and-responses
- Omitting a row field keeps it, `''` clears it; a ROW omitted from `board_upsert` is deleted. → delivery-and-responses
- `blocked` means only the human can act; non-human waits are `partial`/`tracked` (#44). → delivery-and-responses
- Viewer write routes validate bodies first: bad input 400, store refusal 200 `{ok:false}` (#163). → delivery-and-responses
- One attention predicate (`public/attention.js`); snooze and pin demote, never hide (#247). → attention-and-later
- PR/CI state, issue graphs, dependencies, `waits_on` and grouping never reach attention. → github-and-issues, plans-issue-ui
- `updated_at` is liveness, `last_call_at` is work; the liveness tick never records a call (#45). → activity-and-live
- Escape all agent text with `esc()`; every href comes from `chipHtml()` + `safeHttpUrl()`. → viewer-frontend, links
- Only Electron main opens links; local files need the owned-viewer `files` grant (#300, #324). → links
- `load()` is the poll's, `reloadAndPaint()` the human's; exactly two render entries. → viewer-frontend
- An idle tick paints nothing: new render-read state joins `frameInputs()` (#298). → viewer-frontend
- A held pointer, scroll or selection is never a suspension; drafts never auto-send (#279). → viewer-frontend
- The loopback boundary lives in `src/viewer-network.ts`; no host-widening variable. → viewer-network
- Hook and watcher stdout/stderr and exit codes are protocol contracts. → hooks-and-watcher, `docs/hooks.md`
- The MCP server returns the Copilot watcher's launch contract and never spawns it. → hooks-and-watcher
- Installers are transactional: fd 9 lock, rollback on signals, never quote a host config (#337). → setup-and-installers
- Installs are granted to the owned viewer window and revoked on navigation (#216). → electron-app
- Never edit `test/fixtures/shipped-updaters/`; never add a key to `update-preferences.json`. → updates
- Every shipped `node_modules` is pruned before it is tested, hashed or signed (#291); Electron
  locales are English-only (#292). → packaging-and-release
- Mesh is opt-in: off means off (#397). → mesh

## Conventions

- Node 24, TS **ESM** (`"type":"module"`); imports use `.js` specifiers even for `.ts`. → conventions
- Strict tsc with `noUncheckedIndexedAccess`; keep `npm run typecheck` clean. → conventions
- `npm run build` uses `tsconfig.build.json` (flat `dist/`); keep `zod` a direct dependency. → conventions
- **TDD** with real temp SQLite through `openDb()`; never mock the store. → testing
- Scratch directories come from `scratchDir()` in `test/scratch.ts`, never bare `mkdtempSync`. → testing
- DOM tests opt in with `// @vitest-environment jsdom`; mind the harness's CSS blind spots. → testing
- Every value export in `src/*.ts` and `public/*.js` must be reachable from shipping code
  (`test/dead-exports.test.ts`). → conventions
- Workspace hygiene: the session that merges or releases cleans up after
  `docs/workspace-hygiene.md`'s checks pass. → conventions

## Where the detail lives

Each `docs/architecture/<name>.md` carries `paths:`/`applyTo:` globs and is symlinked from
`.claude/rules/` and `.github/instructions/`, so Claude Code and Copilot CLI load it when you
read or edit a matching file. Read it yourself before changing these areas:

| Touching | Read `docs/architecture/…` |
|---|---|
| process boundaries, import graph, `mcp-server.ts`, `viewer-server.ts` | `overview.md` |
| `src/store.ts`, `src/viewer.ts` snapshots, `/api/*` caching, history paging | `store-and-snapshots.md` |
| items, boards, `pending`, `answer`, `resolve`, revisions, reporting snippet | `delivery-and-responses.md` |
| `public/attention.js`, badges, snooze, pin, watch stop, closed projects | `attention-and-later.md` |
| activity, presence, call trace, Live, session builds | `activity-and-live.md` |
| `src/mcp.ts`, `scope.ts`, `infer.ts`, `shape.ts` | `mcp-server.md` |
| `src/viewer-network.ts` | `viewer-network.md` |
| `public/app.js`, poll, render, drafts, focus, scroll, selection | `viewer-frontend.md` |
| Dashboard, lanes, ribbon, motion, layout, search, `style.css` | `viewer-dashboard-and-shell.md` |
| links in agent text, Settings → Links, repo-relative paths | `links.md` |
| `gh` pollers, issue snapshots, pins, `waits_on`, PR links | `github-and-issues.md` |
| breadcrumbs, dependency chips, Plan flow, grouping | `plans-issue-ui.md` |
| `src/hook*.ts`, `src/watch*.ts`, Electron response watch | `hooks-and-watcher.md` |
| installers, setup lock, runtimes, prune, Setup panel, host registrations | `setup-and-installers.md` |
| `electron/main.cjs` window grants | `electron-app.md` |
| update manifests, keys, download, install | `updates.md` |
| packaging, runtime staging, pruning, locales, MSI, workflows | `packaging-and-release.md` |
| mesh | `mesh.md` |
| tests and the DOM harness | `testing.md` |
| TS, build, dead exports, hygiene | `conventions.md` |

Release history: `CHANGELOG.md`. Open backlog (each item has a GitHub issue):
`docs/architecture/backlog.md`.

## Gotchas recap

- Node 26 default → this checkout's `better-sqlite3` binding was built for Node 24's ABI and
  fails to load; use Node 24.
- Register the MCP server with the absolute Node 24 path, not bare `node`.
- New MCP-server registration is picked up only on a **fresh** CLI session.
- The **reporting snippet** (`docs/reporting-snippet.md`) is what makes agents flag at all —
  code shipping ≠ agents using it; the snippet must be in the user's global instructions.
