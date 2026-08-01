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
npm run install:agents                  # dry run: MCP + instructions for both hosts
npm run install:agents -- --apply       # apply with backups; user scope, every repo
npm run view                      # http://localhost:4319 — leave running
```

Or open the Electron app's **Setup** panel: choose both hosts, Claude only, or
Copilot only, then install directly or copy an exact prompt/command for an agent
or terminal. Direct execution is available only when the Electron app owns the
local viewer; a browser tab never receives command-execution access.

Optionally add the backstop hooks — `npm run install:hooks` (a dry run; `-- --apply` writes),
see [`docs/hooks.md`](docs/hooks.md).

The installer is the safe equivalent of binding instructions into `mcp add`: MCP
registration itself can only store a server command, not edit a host's global prompt. The
script performs both explicit operations, manages a marked block in each instruction file,
and preserves unrelated content. Full options and manual setup:
[`docs/INSTALL.md`](docs/INSTALL.md).

## Agent setup by host

<details>
<summary><strong>Claude Code</strong></summary>

```sh
npm run install:agents -- --apply --target claude
```

This registers the MCP server at Claude's user scope and installs the shared reporting
contract plus [`docs/instructions/claude-code.md`](docs/instructions/claude-code.md) in
`~/.claude/CLAUDE.md`. If that file already **imports** the snippet
(`@/abs/path/to/agent-inbox/docs/reporting-snippet.md`, which Claude Code resolves at load
time), the managed block skips the inlined copy and installs only the Claude appendix —
inlining beside a live import would double the tokens and freeze a snapshot that goes stale
on the next snippet edit. The dry run says when it detects one — and a line it cannot resolve
to *this* checkout's snippet (a stale path, one inside a code fence, someone else's file)
inlines instead of being trusted. Claude does **not** launch
the Copilot watcher. Its optional native wake path is the backstop-hook installer:

```sh
npm run install:hooks                  # dry run
npm run install:hooks -- --apply       # install with a timestamped backup
```

With hooks, `asyncRewake` resumes an idle Claude session when an Inbox answer arrives.
Without hooks, all MCP tools still work; Claude picks answers up through `pending()` on an
active or subsequent turn.

</details>

<details>
<summary><strong>GitHub Copilot CLI</strong></summary>

```sh
npm run install:agents -- --apply --target copilot
```

This registers the MCP server in `~/.copilot/mcp-config.json` and installs the shared
reporting contract plus
[`docs/instructions/copilot-cli.md`](docs/instructions/copilot-cli.md) in
`~/.copilot/copilot-instructions.md`. Copilot question flags return an exact-item `watch`
contract; the instructions make Copilot launch it as a detached background command. Its
completion notification wakes the session, which then calls `pending()`. No Claude hooks
are installed for Copilot. Copilot has no import mechanism, so the snippet is always
inlined here — re-run the installer to pick up snippet changes.

</details>

Both installers are dry-run by default, use the repo's pinned Node 24 binary, verify the
runtime before writing, and require a fresh agent session afterward. Use `--force` to
replace an existing Agent Inbox MCP registration or `--uninstall` to remove only the
managed MCP entry and instruction block. The Electron Setup action invokes the same
installer with a fixed target—there is no general-purpose shell or HTTP execution route.

## MCP tools

| tool | agent calls it to… |
|---|---|
| `flag({ kind, title, detail?, context?, options?, stream? })` → `{ id, watch? }` | raise a `question` (needs you) or `note` (non-blocking FYI). Copilot questions also return the detached watcher launch contract. |
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
  mcp-server.ts    stdio entry — spawned per client process (a subagent shares its parent's)
  shape.ts         AGENT-SIDE-ONLY payload shaping for MCP reads (#42) — trims agent-authored
                   `context` to `context_chars`; never the human's annotation or handled mark,
                   never the viewer
  group.ts         pure grouping (Needs-you / Notes / Done)
  viewer.ts        Hono API (items, boards, live activity, source links, close/reopen)
  prstate.ts       VIEWER-PROCESS-ONLY gh fetcher for live PR state (#30) — never imported by mcp.ts
  stamp.ts         VIEWER-PROCESS-ONLY build stamp (#40) — which build is running, and
                   whether the checkout it was packaged from has moved on
  viewer-server.ts node entry — serves API + public/ on localhost
  hook.ts          Claude Code hooks runtime (#10 backstop + #21 pickup nudges)
  hook-cli.ts      hook entry — one subcommand per event; fail-open, exit-code owner
  watch.ts         exact-question Copilot wake watcher + host launch contract
  watch-cli.ts     short-lived watcher entry launched by the Copilot host
public/            plain HTML/CSS/JS front-end (no bundler → wraps to Electron unchanged)
hooks/             portable shell wrapper for hand-edited hook registrations
scripts/install-agents.sh
                   dry-run-first MCP + managed-instructions installer for both hosts
docs/              INSTALL.md, hooks.md, reporting-snippet.md, superpowers/{specs,plans}/
```

## Answer pickup and host wake adapters

The Electron app watches for human responses that still need agent action. A newly
answered question produces an immediate local wake event; if it is still waiting after
one minute, Electron shows a native reminder and repeats it every 15 minutes. Board rows
remain eligible until the agent moves the row out of `blocked`. These reminders are
informational only and never change the human attention badge or mutate inbox state.

Claude Code uses the built-in hook flow in [`docs/hooks.md`](docs/hooks.md). Other hosts
can opt into the Electron wake event by launching the app with:

```sh
AGENT_INBOX_WAKE_COMMAND=/absolute/path/to/adapter \
AGENT_INBOX_WAKE_ARGS='["--host","copilot"]' \
npm run electron
```

The command must be an absolute executable path. Electron invokes it directly (never
through a shell), passes the optional JSON string-array arguments, and writes one JSON
event to stdin. The payload includes the project, agent, response, and originating
session ID when the data model has one. Adapter failures are logged and never affect the
viewer. Copilot still exposes no direct session-resume API, so question flags use a
host-launched workaround instead: a Copilot `flag(kind:"question")` response includes a
detached `agent-inbox-watch` command for that exact item. Its background-command completion
notification wakes the owning session, which then calls `pending()`. The MCP server never
spawns that process itself because only a host-owned completion can wake the conversation.

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
