# CLAUDE.md

Guidance for Claude Code (and any coding agent) working in this repo.

## What this is

`agent-inbox` — a local, cross-project, cross-tool attention inbox for coding agents. A
stdio **MCP server** lets agents `flag` open questions and non-blocking notes; everything
lands in one SQLite hub (`~/.agent-inbox/inbox.db`); a local **Hono viewer** renders the
cross-project inbox. No LLM/model calls anywhere — this is dumb infra (store + viewer +
thin MCP server). See [`README.md`](README.md) for the full picture and
[`docs/superpowers/specs/2026-07-12-agent-inbox-design.md`](docs/superpowers/specs/2026-07-12-agent-inbox-design.md)
for the design.

## Commands

```sh
npm test            # vitest run — full suite (one shot)
npm run test:watch  # vitest watch
npm run typecheck   # tsc --noEmit (strict; noUncheckedIndexedAccess)
npm run build       # tsc -p tsconfig.build.json → dist/ (entry: dist/mcp-server.js)
npm run mcp         # run the MCP stdio server via tsx (local iteration)
npm run view        # run the viewer on localhost:4319 via tsx
npx vitest run test/mcp.integration.test.ts   # single file
```

**Node 24 only.** `better-sqlite3`'s native binding does not build/load under Node 26+. The
repo pins `.node-version` to 24 — run `fnm use 24` before anything. This bites twice:
(1) the integration test **spawns** `npx tsx src/mcp-server.ts` as a child, which inherits
your shell's PATH, so Node 24 must be active when you run `npm test`; (2) when registering
the server with a CLI, pin the **absolute Node 24 binary path**, never bare `node`.

## Architecture & invariants

- **`src/store.ts` is the only door to the database.** Every read/write goes through its
  exported functions (`openDb`, `insertItem`, `resolveItem`, `dismissItem`, `annotateItem`,
  `listItems`). No raw SQL anywhere else. To change storage, reimplement this module;
  nothing else touches SQLite.
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
  (title, detail, annotation, project, stream, agent) through `esc()` before `innerHTML`.
  Keep it — flags are attacker-influenced text.
- **`store.ts`/`mcp.ts`/`viewer.ts` inverse round-trip:** the store's `Item` shape is the
  contract shared by MCP writes and viewer reads. Change it in `store.ts` and update both
  consumers + `group.ts`.

## Conventions

- Node 24, TS **ESM** (`"type":"module"`); **imports use `.js` specifiers** even for `.ts`
  sources (NodeNext). Keep this on new imports.
- Strict tsc, `noUncheckedIndexedAccess: true` — array access is `T | undefined`; use `!`/
  guards, keep `npm run typecheck` clean.
- **TDD.** Every change: failing test → red → implement → green. Tests use **real** temp
  SQLite DBs (`AGENT_INBOX_DB`/`mkdtempSync`), never mock the store. The MCP test is a real
  spawn-the-server round-trip.
- `zod` is a **direct** dependency (used by `mcp.ts` for tool schemas) — keep it in
  `package.json`, don't rely on it resolving transitively via the SDK.
- Build emits via **`tsconfig.build.json`** (rootDir `src`, src-only) so `dist/mcp-server.js`
  is flat. The base `tsconfig.json` (src + test) is for typecheck only. Don't point `build`
  at the base config — it re-nests output under `dist/src/`.

## v2 backlog — and the seams already in place

v1 is deliberately local + triage-only. The next work, with the hooks left for it:

1. **Answer-back** — reply to an agent from the viewer. Add a `pending({ stream }) → items`
   MCP tool the agent polls for the human's reply, and a viewer reply box that writes the
   reply onto the item. `register`/session scope already identify which session to route to.
2. **Remote / hosted mode** — run on a server (e.g. ubi-prod), tunnel-exposed for phone +
   cloud-agent reach. Swap stdio for **streamable-HTTP** transport and add **auth** (bearer
   token in MCP client headers + a gate on the viewer). `register` is the identity seam: a
   remote server can't see the client's `cwd`, so agents declare scope via `register` instead
   of auto-inference. `AGENT_INBOX_DB`/`AGENT_INBOX_PORT` env overrides are already in place.
3. **`done`/milestone bucket** — an opt-in third kind (e.g. `flag({ kind:'done' })`) surfaced
   in the viewer's Done section. Kept out of v1 to preserve signal; `group.ts` already has a
   `done` bucket for closed items to slot into.
4. **Status backstop via Claude Code hooks** — deterministic (no-AI) `agent_needs_input` /
   `agent_completed` hooks → POST an event, so status shows even when an agent forgets to
   flag. Pure shell→HTTP; needs the remote HTTP endpoint from (2), or a local one.
5. **Electron packaging** — wrap the existing `public/` viewer in an Electron window (it's
   plain HTML/CSS/JS with no build step precisely so this is a lift-and-drop).

Keep all of these additive and behind the existing seams — don't break v1's local,
zero-config, no-auth path.

## Gotchas recap

- Node 26 default → `better-sqlite3` fails; use Node 24.
- Register the MCP server with the absolute Node 24 path, not bare `node`.
- New MCP-server registration is picked up only on a **fresh** CLI session.
- The **reporting snippet** (`docs/reporting-snippet.md`) is what makes agents flag at all —
  code shipping ≠ agents using it; the snippet must be in the user's global instructions.
