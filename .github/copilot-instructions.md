# Copilot instructions for agent-inbox

`agent-inbox` is local infrastructure: a stdio MCP server, a shared SQLite store,
a Hono viewer, a plain-JavaScript frontend, and an Electron wrapper. There are no
model calls.

`CLAUDE.md` is the single source for commands, the architecture in one screen, the
invariants that break things when missed, conventions and gotchas. Copilot CLI and, on
GitHub.com, the cloud agent and code review load it as agent instructions, so this file
does not repeat it. Use Node 24 (`fnm use 24`) in every shell; `npm test` spawns the
MCP server under the active Node.

Exceptions, per GitHub's custom-instructions support table: VS Code Copilot Chat and
VS Code code review do not read `CLAUDE.md` (Chat does load the path-specific files
below; code review reads only this file). There, read `CLAUDE.md` and the matching
`docs/architecture/*.md` yourself before changing or reviewing code.

The detailed invariants, and the regressions that established them, live in
`docs/architecture/*.md`, one file per subsystem. Each is symlinked as
`.github/instructions/<name>.instructions.md` with an `applyTo` glob, so Copilot loads
it when you work on matching files (`/instructions` lists what loaded). Read the doc
named in `CLAUDE.md`'s "Where the detail lives" table before changing delivery, board,
activity, attention, polling, hook, setup, update or packaging behavior, even when no
glob matched.

## Lessons from past sessions

- **Every tool shell starts fresh, so pin Node 24 in each one.** Start each shell with
  `eval "$(fnm env)" && fnm use 24`, or run commands through `fnm exec --using=24`.
  Pass this on to subagents and reviewers too. Three errors mean the shell is on the
  wrong Node, not that the code is broken:
  - `NODE_MODULE_VERSION` mismatches from `better-sqlite3`;
  - `localStorage` undefined in the DOM harness;
  - a native rebuild during `npm ci`.
- **Full-suite flakes under load.** An `afterAll` or cleanup-hook timeout, or a
  timing failure, in a file this change didn't touch is usually load flakiness (#471,
  #238). Rerun just that file with `npx vitest run <file>`. If it passes alone, CI on
  the PR decides; don't change the test.
- **Merging parallel PRs.**
  - The required checks are "Node 24 / ubuntu-latest" and "Node 24 / macos-15", and
    branches must be up to date with `main` before they merge.
  - Bring a branch up to date with
    `gh api -X PUT repos/shariqh/agent-inbox/pulls/<n>/update-branch`, or merge
    `origin/main` into it. Never rebase or force-push a pushed branch.
  - Files that often conflict between parallel PRs:
    - the `paths`/`applyTo` frontmatter of `docs/architecture/*.md`;
    - the import pins in `test/mesh.test.ts`;
    - the route list in `src/viewer.ts`.
  - When the base of a stack is squash-merged, merge `origin/main` into the child
    branch and resolve the conflict there.
- **This checkout runs live.** Shariq's MCP servers, watchers, `meshctl` shims and mesh
  agents run from this checkout's `dist/` and `packages/mesh/dist/`. After merging:
  - **Rebuild:** run `npm run build` at the root and in `packages/mesh`.
    `packages/mesh` has its own lockfile; run `npm ci` there if its dependencies
    changed.
  - **Restart:** processes that are already running keep the old code. That covers an
    MCP server until a fresh CLI session, an idle unslop agent until it exits, and a
    watcher until it is re-armed.
  - **Reporting snippet:** a change only reaches the global instruction files after
    `npm run install:agents`, a dry run, then `-- --apply`.
- **Commands for Shariq.** Give each command as one line in a fenced block, with absolute
  paths and no `<placeholders>`: zsh reads `<x>` as a redirection. Never put
  explanation text on the command line. For a try-it, run the checkout build beside the
  installed app with `AGENT_INBOX_PORT=4392 npm run electron:side`; never ask him to
  quit the installed app.
- **Subagent limits.** Subagents can't write to `/tmp`, so they write scratch logs inside
  their worktree and delete them before committing. Never use `git stash` in a shared
  checkout or worktree.
