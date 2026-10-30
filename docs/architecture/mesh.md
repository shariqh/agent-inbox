---
paths:
  - "src/mesh-config.ts"
  - "src/meshctl.ts"
  - "public/mesh-view.js"
applyTo: "src/mesh-config.ts,src/meshctl.ts,public/mesh-view.js"
---

# Agent mesh (M1)

The opt-in mesh: `mesh.json`, `meshctl` and the Agents view (#397).

Moved out of `CLAUDE.md` and `.github/copilot-instructions.md` by #379, nearly verbatim. Claude Code and Copilot CLI load this file automatically when they read or edit a file matching the `paths`/`applyTo` globs above (through the symlinks in `.claude/rules/` and `.github/instructions/`); anyone else should read it before changing those files.

## In brief

- **Opt-in mesh (Mesh M1, #397):** `mesh.json` (absolute `AGENT_INBOX_MESH_DIR`,
  else beside `AGENT_INBOX_DB`, else `~/.agent-inbox`) is the one switch; only
  `src/meshctl.ts` writes it (dry run first, `--apply` with backup and atomic rename,
  unknown keys kept; refuses symlinks, non-regular files, bad JSON and newer schemas).
  `src/mesh-config.ts` is the shared Node-core reader. `viewer-server.ts` stats the
  file at start and once a minute (unref'd) and reads it only when the stat changes;
  `/api/version` gains a trailing `mesh: { agentsView: true }` only while it is on and
  is otherwise byte-identical. Only the page's first `/api/version` read can trigger
  `import('/mesh-view.js')`, which adds a window-local Sessions | Agents lens and
  Settings → Mesh. The view reads `liveInLens()`, the lanes' `isWorking`, Live's
  `isDormant`, `last_call_at` and the frame's attention entries; it never feeds
  attention, a badge, count, tab, rail or the dock, fetches nothing, and animates
  nothing. No mesh module enters the stdio MCP graph, the hub schema is untouched,
  and the lockfile changes only by the root `bin` entry; `test/fixtures/app-dependencies.txt`
  pins the dependency set. Nothing puts the bin on PATH: document `npm run meshctl -- …`.

## Invariants in detail

- **The mesh is opt-in, and off means off (Mesh M1, #397).** Design:
  [`docs/superpowers/specs/2026-10-29-agent-mesh-design.md`](../../docs/superpowers/specs/2026-10-29-agent-mesh-design.md)
  §2, §10.1–10.2. `mesh.json` (in an absolute `AGENT_INBOX_MESH_DIR`, else beside
  `AGENT_INBOX_DB`, else `~/.agent-inbox`) is the one switch, and only `src/meshctl.ts`
  (`agent-inbox-meshctl`, `npm run meshctl`) writes it: dry run by default, `--apply` writes a
  temp file and renames it over the target with a timestamped `mesh.json.bak-*` of any file it
  replaces, keeps keys it does not own, and refuses a symlink, a non-regular file, unreadable
  JSON or a newer `schema`, naming the reason in fixed words (never a parser's message).
  `disable --apply` is a list of steps that today only deletes the file (with a backup); M4
  puts its pause and `@mesh` archive steps before that one. `src/mesh-config.ts` holds the one
  reading rule both sides share (a regular file ≤ 64 KiB, a JSON object, `schema` 1; anything
  else is off). Both are Node core only and never import `store.ts`. **The viewer's one stated
  exception** (§2.1): `viewer-server.ts` (never `createViewer`) starts `watchMeshConfig`, one
  `lstat` at start and one per minute on an unref'd interval, reading the file only when the
  stat changed; a missing file costs that failed stat and nothing else. `createViewer`'s
  `meshAgentsView` option is the only way the state reaches a route: `/api/version` appends
  `mesh: { agentsView: true }` as its LAST key while a valid file says so, and is otherwise
  byte-identical. No other route, poll read or snapshot changes, and no mesh module may enter
  the stdio MCP graph (`test/prstate.test.ts`). **The page:** only the FIRST `/api/version`
  read (`initLiveBar` → `loadMeshView`) can turn it on, so on or off takes a window reload;
  then, and only then, `app.js` runs `import('/mesh-view.js')` (an `ENTRY_POINTS` and
  `ALLOWED` entry in `test/dead-exports.test.ts`, since the scan reads static imports only).
  `public/mesh-view.js` adds a Sessions | Agents lens above the Dashboard lanes and Settings →
  Mesh (state, and the commands that really turn it off: `npm run meshctl -- disable --apply`
  from a checkout, the runtime's `bin/node … dist/meshctl.js`, or deleting `mesh.json`; the
  package is private and nothing puts the `agent-inbox-meshctl` bin on PATH short of `npm link`;
  the browser never writes `mesh.json`). The lens is window-local like the lane filters: a fresh window opens on
  Sessions. The Agents lens hides `.dash-lanes` and shows `.mesh-agents` in its grid place,
  drawn from `renderDashboardAmbient` (so both render entries, no third) with `liveInLens()`,
  the lanes' own input. It groups presence by `agent`, then project and branch, with the
  lanes' `isWorking` and Live's `isDormant` (working / idle / dormant), "last call" from
  `last_call_at` (never `updated_at`), the summed `callTrace`, and an "Asking you: N" READ from
  the frame's `waitingEntries` (the attention set), keyed by an item's `agent` or a row's
  `action_agent` (else its plan's agent). Nothing it draws reaches `public/attention.js`, a
  badge, count, tab, the rail or the dock; it fetches nothing, runs no timer and no animation,
  and rebuilds its cards only when what they show changed. `meshView` and its lens are in
  `frameInputs()`, so the tick after the module lands paints and a lens change is never
  reused across. `test/mesh.test.ts` and `test/dom/mesh-view.test.ts` hold all of it, including the
  off boot's identical requests, bytes and ETags and identical attention surfaces with the
  Agents lens on. `package-lock.json` changes only by the root entry's `bin` map (npm
  lockfile v3 records it); the dependency set does not change, and
  `test/fixtures/app-dependencies.txt` pins it (package.json's dependency and devDependency
  names and every lockfile package path), so a new package fails `test/mesh.test.ts`. A
  deliberate dependency change outside the mesh refreshes the pin with
  `AGENT_INBOX_UPDATE_DEPENDENCY_FIXTURE=1 npx vitest run test/mesh.test.ts -t "dependency set"`.
