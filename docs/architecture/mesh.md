---
paths:
  - "src/mesh-config.ts"
  - "src/meshctl.ts"
  - "public/agents-home.js"
applyTo: "src/mesh-config.ts,src/meshctl.ts,public/agents-home.js"
---

# Agent mesh (M1)

The opt-in mesh: `mesh.json` and `meshctl` (#397); and the Agents view, which began as mesh M1 and is always on since #454.

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
- **The Agents view** (`public/agents-home.js`) adds a window-local Sessions | Agents
  lens above the Dashboard lanes, opening on Agents. It reads `liveInLens()`, the
  lanes' `isWorking`, Live's `isDormant`, `last_call_at` and the frame's attention
  entries; it never feeds attention, a badge, count, tab, rail or the dock, fetches
  nothing, and animates nothing. No mesh module enters the stdio MCP graph, the hub
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
  statically and calls `installAgentsHome({ jumpToAsk, openMessage })` at load, so
  `dead-exports` reaches it like any module. It adds a Sessions | Agents lens above the
  Dashboard lanes; the lens is window-local like the lane filters, and a fresh window
  opens on Agents. The Agents lens hides `.dash-lanes` and shows `.mesh-agents` in its grid
  place, drawn from `renderDashboardAmbient` (so both render entries, no third) with
  `liveInLens()`, the lanes' own input. It groups presence by `agent`, then project and
  branch, with the lanes' `isWorking` and Live's `isDormant` (working / idle / dormant),
  "last call" from `last_call_at` (never `updated_at`), the summed `callTrace`, and an
  "Asking you: N" READ from the frame's `waitingEntries` (the attention set), keyed by an
  item's `agent` or a row's `action_agent` (else its plan's agent). Nothing it draws
  reaches `public/attention.js`, a badge, count, tab, the rail or the dock; it fetches
  nothing, runs no timer and no animation, and rebuilds its cards only when what they
  show changed. Its lens is in `frameInputs()`, so a lens change is never reused across
  frames. `test/mesh.test.ts` and `test/dom/agents-home.test.ts` hold it, including the
  boot's unchanged requests and identical attention surfaces with the Agents lens drawn.
  `package-lock.json` records meshctl's root `bin` entry (npm lockfile v3); the dependency
  set does not change, and `test/fixtures/app-dependencies.txt` pins it (package.json's
  dependency and devDependency names and every lockfile package path), so a new package
  fails `test/mesh.test.ts`. A deliberate dependency change outside the mesh refreshes the
  pin with
  `AGENT_INBOX_UPDATE_DEPENDENCY_FIXTURE=1 npx vitest run test/mesh.test.ts -t "dependency set"`.
