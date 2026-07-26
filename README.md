# agent-inbox

A durable, cross-project, cross-tool **"what needs my attention"** inbox for coding agents.

Your agents (Claude Code, Copilot CLI, any MCP client) write to it themselves over MCP —
one `flag` tool, called mid-work — so open questions and easily-missed notes stop
scrolling past in the CLI firehose. A local web viewer shows the whole cross-project inbox
grouped by *Needs you* / *Notes*. **No second AI**: the tool is a store + a viewer + a thin
MCP server. The only intelligence is the agent already running, which files a note as a
normal tool call.

## Why

Claude Code's native `claude agents` (Agent View) already does cross-project *status*
monitoring — but only for Claude Code, and only for what an agent is *blocked on*. This
tool covers the two gaps: it's **cross-tool** (Copilot CLI too), and it captures the
**non-blocking notes** — assumptions, caveats, workarounds, tech-debt flags — that Agent
View can't surface and that you can't extract from raw logs without a second AI.

## How it works — hub and spoke

```
  claude in ~/dev/project-a  ─┐
  copilot in ~/dev/project-b ─┼─►  ~/.agent-inbox/inbox.db  ──►  viewer (localhost:4319)
  claude in ~/dev/anything   ─┘        (the single hub)          all projects, one screen
```

The MCP server is registered **once, at user scope** and auto-attaches to every agent
session in every repo. Each session spawns the stdio server inheriting that repo's `cwd`,
which is used only to **auto-infer** attribution:

- **project** ← git remote basename → cwd basename → `unknown`
- **stream** ← current git branch → `''`
- **agent** ← MCP `clientInfo.name` (`claude-code` / `copilot` / …)

So an agent's core loop is: `flag(...)` when it needs attention, then poll `pending()` for
answers (including optional answer context). Attribution is inferred. Every flag lands in
one SQLite file; the viewer reads it and shows the cross-project inbox.

Since a **stream already *is* a branch**, the same inference also yields the **source link**:
the github.com `owner/name` from `origin`, plus the issue number the branch names when it names
one unambiguously (`30-x`, `feat/30-x`, `issue-30`, `gh-30` — never a trailing year). Those ride
on the item, so an issue chip appears with no `gh`, no network and no PR. Separately, the
**viewer process** (never the MCP server) polls the local `gh` CLI for the PR on that branch and
caches one row per `(repo, branch)`, adding a `PR 41 ✓ merged` chip whose hover shows the PR
title and the first line of its body. There is no model call anywhere in this. A failing CI
check never touches the badge — PR state is ambient information, not attention.

## Status

**v1 shipped and running locally.** Registered with Claude Code (user scope) and Copilot
CLI (`~/.copilot/mcp-config.json`); viewer served on `http://localhost:4319`.
Answer-back, the `done` bucket, tracking boards, session presence, Electron packaging, the
backstop hooks, source/PR links and project close/reopen have all since landed.
**Remote/hosted mode is the one big open item** — see [`CLAUDE.md`](CLAUDE.md) for the
backlog and the seams already in place.

## Quickstart

Requires **Node 24** (see the gotcha below). Full steps in [`docs/INSTALL.md`](docs/INSTALL.md).

```sh
npm install && npm run build
# register once (applies to every repo); pin Node 24 in the command:
claude mcp add --scope user agent-inbox -- /path/to/node24 /abs/path/to/agent-inbox/dist/mcp-server.js
npm run view                      # http://localhost:4319 — leave running
```

Optionally add the backstop hooks — `npm run install:hooks` (a dry run; `-- --apply` writes),
see [`docs/hooks.md`](docs/hooks.md).

Then paste [`docs/reporting-snippet.md`](docs/reporting-snippet.md) into your global agent
instructions (`~/.claude/CLAUDE.md` + Copilot's global instructions) so agents know *when*
to flag. That snippet is the single lever for signal quality — tune it as you watch your
dismiss rate.

## MCP tools

| tool | agent calls it to… |
|---|---|
| `flag({ kind, title, detail?, context?, options?, stream? })` → `{ id }` | raise a `question` (needs you) or `note` (non-blocking FYI). The workhorse. |
| `pending()` | poll open questions; each answered item includes `reply` plus optional `reply_context` for extra direction. |
| `answer({ id, text, context? })` → `{ ok, reason? }` | record an answer the human gave in **chat** onto an open question, so both channels converge. Refused with `reason: "unread_inbox_answer"` while an inbox answer is waiting unread — the inbox wins. |
| `resolve({ id })` | close its own item once it's moot (mostly you resolve from the viewer). |
| `register({ project?, stream?, repo?, issue? })` | override auto-inferred scope, including the source link (`repo` = `owner/name`, `issue` = a number) when the branch does not name it; also the identity seam for future remote mode. |
| `whoami()` | debug — report the session's current project/stream/agent. |

## Ownership

Agents **raise** and **self-resolve when moot**; you **triage** in the viewer
(`resolve` handled, `dismiss` don't-care, `annotate`). The agent is the source of truth for
*what happened*; the inbox is your surface for *clearing* it. Your **dismiss rate** is the
noise signal — high dismiss = tighten the reporting snippet.

## Project layout

```
src/
  store.ts         SQLite: schema, WAL, items + boards + activity + source links +
                   project closure — the only DB door
  infer.ts         project/stream/agent/repo/issue inference from cwd + clientInfo
  scope.ts         session-bound scope object (Solo-style: inferred, overridable)
  mcp.ts           MCP tool definitions (flag/pending/answer/resolve/register/whoami,
                   board_upsert/board_row/board_get/board_archive, status)
  mcp-server.ts    stdio entry — spawned per agent session
  group.ts         pure grouping (Needs-you / Notes / Done)
  viewer.ts        Hono API (items, boards, live activity, source links, close/reopen)
  prstate.ts       VIEWER-PROCESS-ONLY gh fetcher for live PR state (#30) — never imported by mcp.ts
  viewer-server.ts node entry — serves API + public/ on localhost
  hook.ts          Claude Code hooks runtime (#10 backstop + #21 pickup nudges)
  hook-cli.ts      hook entry — one subcommand per event; fail-open, exit-code owner
public/            plain HTML/CSS/JS front-end (no bundler → wraps to Electron unchanged)
hooks/             portable shell wrapper for hand-edited hook registrations
docs/              INSTALL.md, hooks.md, reporting-snippet.md, superpowers/{specs,plans}/
```

## Development

```sh
npm test            # vitest run — the whole suite, one shot (store, infer, scope, hooks,
                    # mcp round-trip, viewer, every public/ module, jsdom DOM harness)
npm run typecheck   # tsc --noEmit (strict, noUncheckedIndexedAccess)
npm run build       # tsc -p tsconfig.build.json → dist/ (flat; entry at dist/mcp-server.js)
npm run mcp         # run the MCP server via tsx (for local iteration)
npm run view        # run the viewer via tsx
```

> **Node 24 for this checkout.** `better-sqlite3` compiles one native binding per install,
> and this repo's is built for Node 24's ABI — `.node-version` pins it, so run `fnm use 24`
> before any command. (Since the v12 upgrade the library itself supports newer Node; the
> packaged Electron app rebuilds the binding for Electron's own ABI.) When registering the
> MCP server, use the **absolute path to the Node 24 binary**, not bare `node`, or agents
> will spawn it under your default Node and the binding will fail to load.

## Design docs

- Spec: [`docs/superpowers/specs/2026-07-12-agent-inbox-design.md`](docs/superpowers/specs/2026-07-12-agent-inbox-design.md)
  — one per feature since; the whole set is in [`docs/superpowers/specs/`](docs/superpowers/specs/)
- Plan: [`docs/superpowers/plans/2026-07-12-agent-inbox-v1.md`](docs/superpowers/plans/2026-07-12-agent-inbox-v1.md)
- Agent handoff / conventions / v2 backlog: [`CLAUDE.md`](CLAUDE.md)
