# Copilot instructions for agent-inbox

`agent-inbox` is local infrastructure: a stdio MCP server, a shared SQLite store,
a Hono viewer, a plain-JavaScript frontend, and an Electron wrapper. There are no
model calls.

`CLAUDE.md` is the single source for commands, the architecture in one screen, the
invariants that break things when missed, conventions and gotchas. Copilot CLI, the
cloud agent and code review load it as agent instructions, so this file does not repeat
it. Use Node 24 (`fnm use 24`) in every shell; `npm test` spawns the MCP server under
the active Node.

The detailed invariants, and the regressions that established them, live in
`docs/architecture/*.md`, one file per subsystem. Each is symlinked as
`.github/instructions/<name>.instructions.md` with an `applyTo` glob, so Copilot loads
it when you work on matching files (`/instructions` lists what loaded). Read the doc
named in `CLAUDE.md`'s "Where the detail lives" table before changing delivery, board,
activity, attention, polling, hook, setup, update or packaging behavior, even when no
glob matched.
