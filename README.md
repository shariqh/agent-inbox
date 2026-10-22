# Agent Inbox

[![CI](https://github.com/shariqh/agent-inbox/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/shariqh/agent-inbox/actions/workflows/ci.yml)
[![Node 24](https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**A local command center for questions, plans, and live status from coding agents.**

Agent Inbox gives GitHub Copilot CLI and Claude Code one shared place to surface
decisions, handoffs, notes, milestones, and multi-step plans. You respond in the
Electron app; agents pick the response up through MCP and continue working.
Its default Live Operations Desk shows active claims, trustworthy attention,
ownership flow, plan movement, and recorded outcomes across every project.

![Agent Inbox showing a synthetic decision queue, plan row, response options, and live agents](docs/assets/agent-inbox-overview.png)

The app is local-first infrastructure, not another agent: its core data path has no
model calls, hosted service, or telemetry. A stdio MCP server and the desktop viewer
share one SQLite database on your machine.

## What it does

| Capability | What you get |
|---|---|
| **Live operations dashboard** | Real current state plus locally persisted agent-claim history, with every signal drilling into a working view |
| **Cross-project inbox** | Questions and handoffs from every active coding session in one prioritized queue |
| **Action-aware responses** | Recommended options, free-text answers, snooze, pin for later, clarify, and decline controls |
| **Durable plans** | Tracking boards with stable rows, progress, next steps, outcomes, and human-owned actions |
| **Live sessions** | Ambient status for active agents and their current work without turning activity into alerts |
| **Dual-host setup** | Audited installers and instructions for GitHub Copilot CLI and Claude Code |
| **Local security boundary** | A loopback-only viewer with strict Host, Origin, Fetch Metadata, and anti-framing checks |

Pending requests use the stated next step as their headline when one is available.
Cards keep explanations, warnings, and option tradeoffs visible, with response
controls close at hand. Open **Details & history** for the original tracking title,
branch, background, and delivery timeline.

## Quick start

### Requirements

- macOS 13.5 (Ventura) or later on Apple silicon or Intel for the notarized desktop app
- Linux x64 or arm64 with kernel 4.18+, glibc 2.34+, and GLIBCXX_3.4.29+ for AppImage/DEB packages
- **Node.js 24** for source builds, the MCP server, and the browser viewer
- macOS or Linux for the source-build path
- GitHub Copilot CLI and/or Claude Code

Agent Inbox is not published to npm. When a public release is available, download the
matching macOS DMG, Linux AppImage, or Debian package from
[GitHub Releases](https://github.com/shariqh/agent-inbox/releases).

### 1. Install a desktop package

On macOS, download the universal DMG from
[GitHub Releases](https://github.com/shariqh/agent-inbox/releases), drag **Agent Inbox**
to `/Applications`, and launch it. The universal app supports Apple silicon and Intel
and includes the Node 24 agent runtime, so it does not require a system Node installation.

On Linux, choose the filename matching the machine:

| Architecture | Portable | Debian/Ubuntu |
|---|---|---|
| x64 / amd64 | `Agent-Inbox-vX.Y.Z-linux-x86_64.AppImage` | `agent-inbox_X.Y.Z_amd64.deb` |
| arm64 | `Agent-Inbox-vX.Y.Z-linux-arm64.AppImage` | `agent-inbox_X.Y.Z_arm64.deb` |

Verify `SHA256SUMS.txt` before launch or installation. AppImages require `chmod +x`;
install DEBs with `sudo apt install ./agent-inbox_X.Y.Z_ARCH.deb`. The complete
no-FUSE AppImage fallback, supported distribution floor, package lifecycle, and macOS
trust checks are in the [installation guide](docs/INSTALL.md).

On first launch, open **Setup**, choose GitHub Copilot CLI, Claude Code, or both, and
select **Install now**. Setup verifies and installs the bundled runtime, registers the MCP
server, and adds the reporting instructions. Start a fresh agent session afterward.
After an app update, Setup's **Agents** section shows which build each host's agents
are registered to run; **Update agents** moves the ones Setup manages to the new
runtime (after a downgrade, **Match agents** moves them back to the app's runtime) and
says which running sessions still need a restart. See
[After an app update](docs/INSTALL.md#after-an-app-update).

If no public release is listed yet, or if you want to develop Agent Inbox, use the
source-build fallback:

```sh
git clone https://github.com/shariqh/agent-inbox.git
cd agent-inbox
npm ci
npm run build
```

### 2. Connect your coding agents from a source build

Preview the changes first, then install the MCP registration and global reporting
instructions:

```sh
npm run install:agents
npm run install:agents -- --apply
```

The installer supports both hosts by default. Use `--target claude` or
`--target copilot` to install only one. It verifies the Node 24 runtime, backs up
instruction files before changing them, and owns only its marked block.

Start a fresh agent session after installation.

### 3. Launch a source build

```sh
npm run electron
```

The Electron app starts or safely reuses the local viewer and opens the desktop
workspace. Its **Setup** panel can also run the same audited host installer.

To package a standalone local development app on an Apple silicon Mac:

```sh
npm run generate:icons
npm run package:app
open "out/Agent Inbox-darwin-arm64/Agent Inbox.app"
```

The protected release pipeline builds and verifies every native package, signs/notarizes
the universal macOS DMG, and publishes the DMG plus both AppImages and both DEBs only
after remote download and rehash. Release inputs, platform evidence, and the publication
runbook are documented in [`docs/macos-release.md`](docs/macos-release.md) and
[`docs/linux-release.md`](docs/linux-release.md).

`assets/icon.svg` is the editable full-color source of truth.
`assets/icon-mark.svg` is its deliberately simplified single-color derivative for
tiny in-product use. `npm run generate:icons` deterministically refreshes
`assets/icon-1024.png`, browser favicon/mark assets under `public/`, and
`electron/icon.icns`, and `electron/icon.ico`; `assets/icon-manifest.json` pins the source and generated
output hashes. `npm run generate:icons -- --check` validates that manifest,
dimensions, SVG copies, and the complete ICNS representation set without
rerasterizing. Generation requires `rsvg-convert`; generation and checking use
macOS `iconutil`.

Release packages carry separate `darwin-arm64` and `darwin-x64` Node 24 agent runtimes;
see [`electron/README.md`](electron/README.md#portable-agent-runtime-staging). Setup
installs the matching payload under `~/.agent-inbox/runtime/`, so registered agents do
not depend on the app bundle remaining in place.

### Browser viewer on macOS or Linux

Use the browser surface when Electron packaging is unavailable or when developing
the frontend:

```sh
npm run view
```

Open <http://127.0.0.1:4319>. `http://localhost:4319` is retained as an exact browser
alias.

See [the full installation guide](docs/INSTALL.md) for host-specific setup, manual
MCP registration, uninstall behavior, optional dependencies, and platform support.

## Where to start agent conversations

Clone Agent Inbox once to host the app and MCP runtime. Start Copilot CLI or Claude
Code **inside the repository you actually want the agent to work on**, not inside the
Agent Inbox checkout.

The global MCP registration points every agent session at this installation. Agent
Inbox infers project and branch identity from each session's working directory, then
reconciles all of those sessions through the shared local database.

## How the loop works

```mermaid
flowchart LR
    A[Copilot CLI or Claude Code<br/>in any project] -->|stdio MCP| B[Agent Inbox MCP server]
    B --> C[(~/.agent-inbox/inbox.db)]
    C --> D[Electron app]
    C --> E[Browser viewer]
    D -->|answer or complete action| C
    C -->|pending response| B
```

1. An agent calls `flag`, `status`, or a board tool.
2. The shared SQLite hub updates immediately.
3. You answer or complete the requested action in the Electron app.
4. The agent calls `pending`, receives the response, acknowledges it, and continues.

Claude Code can use the optional deterministic hooks in
[`docs/hooks.md`](docs/hooks.md) for idle-session pickup of question replies and
responses on blocked plan rows, including "I've done my part", clarification, and
decline. The hook checks for an answer before it starts waiting. An armed watcher
does not lose a later answer just because another agent received it first. A Stop
continuation does not wake repeatedly for the same unread response; it can still
wait for answers to requests that were unanswered when it started. It also watches
a project the session chose with `register`, and questions the session raises after
its turn ended; a newer turn's watcher replaces the older one.

Copilot questions and new blocked plan actions return host-owned watcher commands.
The agent must launch them in its CLI session; the MCP server never does so.
Each plan watcher follows one row action, not every future use of that row.
Routine plan edits do not create duplicate watchers. After a timeout or restart,
`board_get({title, watch:true})` returns watches for the plan's remaining blocked
actions. `pending({project:"..."})` retrieves answers for the original project
without changing the current session scope. Each re-arm of the same unanswered
request waits longer (30 minutes, then 1, 2 and 4 hours), so a long wait costs the
agent a few wakes instead of dozens. On a Copilot request you can also choose
**I'll take a while**: stop the agent waiting (it will not wake on its own, so
message it after you answer) or ask it to wait quietly for a few hours or until
tomorrow. With the Later section on (the default), the same choice also sets the
request aside: **Stop waiting** pins it in Later, and a quiet wait snoozes it there
until the same time. With the section off, the request stays in Needs you. A
snooze also keeps its watcher quiet, checking in at most once a day. The choice
appears only on requests raised by a Copilot session running this version, whose
watcher honours it.

**Saved, delivered, and acted on are different states.** Watchers only notify the
host; they never mark a response delivered or complete. An agent receives the
response through `pending`, then records the result by resolving the question or
changing the plan row's status. A delivery receipt is not proof that the intended
agent resumed. Hooks still select requests by project, but each host session keeps
its own watcher so one session cannot take away another's wake source. An
unavailable host connection cannot be repaired by a database watcher.

Live shows connected MCP processes and the work they report, not an authoritative
inventory of every agent or subagent. A connection with no task report is unknown
activity, not proof of inactivity. `register` updates its displayed project and
branch immediately; child-agent descriptions still come from the manager.
Each connection also shows the Agent Inbox build its MCP server runs. A session on
an older build gets a quiet hint whose advice fits where that session runs from: a
session on Setup's agent runtime is told to restart once its own host (Claude Code
or Copilot CLI) is registered to the new runtime, or to update agents from Setup
first, and a session running from a source checkout is told to update and rebuild
it. After Setup matches agents back to an older app, sessions still on the newer
build are marked too. A server too old to report its build shows nothing rather than
a guess.

## Setting requests aside

A request's **More responses** menu can set it aside. **Pin for later** keeps it
with no return time. **Not now · 4h**, **Tomorrow** and **Next week** snooze it
until then. A request you set aside leaves the title badge, the tab count and the
app icon badge, but it stays on screen.

Set-aside requests wait in the **Later** section at the foot of the Inbox. It is
collapsed under one count for the current filters, such as `Later · 3` and
`2 pinned · 1 snoozed, next back in 2h`. Snoozed requests come first, soonest
back first, then pinned requests, oldest first. Each row says why it waits, and
**Back to inbox** returns it at once. You can still answer, clarify or decline a
request inside Later. A snoozed request comes back by itself when its time
passes. A pinned request comes back when you return it, or when the agent ends
the request or starts a new one. When nothing else needs you, the queue says how
many requests wait in Later. Search still finds them: a question is listed under
Open items with a Later label, and a plan row under Active plans with its plan.

The Later section is on by default. Turn it off in **Settings → Inbox** to keep
the earlier layout: a snoozed fold, a pinned fold for requests you already
pinned, and no Pin for later choice. The setting is saved for each browser or
app profile and changes only the layout. Badges, counts and notifications are the
same either way.

## Keyboard controls

Press **F** (or choose **Show keys**) to place short letter codes on the visible
controls. Type a code to click a button, open a link or disclosure, or focus an
editor or native selector. Hints stay inside the active dialog; press **Esc** to
cancel. A changed action loses its old code instead of silently reusing it.

Common actions also have permanent key tiles. Press **?** for the full guide.
Letters do not run shortcuts while you are typing or using a select.

| Keys | Action |
|---|---|
| `G D` / `G I` / `G P` / `G N` / `G H` | Dashboard / Inbox / Plans / Notes / History |
| `G S` / `G O` / `G A` / `G L` | Settings / project picker / agent filter / Live |
| `Cmd/Ctrl K` or `/` | Focus search |
| `J` / `K`, then `Enter` | Move through the queue and expand an item |
| `R` / `1`-`4` | Focus the current reply / choose an answer |
| `Cmd/Ctrl Enter` | Send a multiline response; plain Enter adds a line |
| `E` / `X` | Resolve / dismiss the current item, with an undo window for dismiss |
| `T` | Open the review queue |
| `Tab` / `Shift Tab` | Move between native controls |

`G` starts a sequence: release it, then press the destination letter. `Esc`
cancels a sequence without closing the item underneath. Expanded cards scroll
with the page at intermediate widths; the desktop inspector and full-screen
phone card retain their own scrolling.

Selected text stays selected while the viewer refreshes, unless that text changes.
To copy it without pressing `Cmd/Ctrl C`, turn on **Copy text when selected** in
Settings. Finishing a selection with the mouse or keyboard then copies it, except
text you select in a reply box or other field.

## MCP tools

| Tool | Purpose |
|---|---|
| `flag` | Raise a question, non-blocking note, or completed milestone |
| `pending` | Read open questions, informational feedback, and plan responses; optionally re-read one open item |
| `answer` | Record an answer the human gave in chat while preserving inbox precedence |
| `resolve` | Close an item after the agent acts on it |
| `status` | Publish ephemeral live work and child-agent presence |
| `board_upsert` | Create or refresh an entire tracking board |
| `board_row` | Update one stable board row |
| `board_advance` | Advance a row to its next human action without changing its label |
| `board_get` | Read board state and human annotations; optionally re-arm Copilot row watches |
| `board_archive` | Archive a finished board |
| `register` | Override automatically inferred project, stream, repository, or issue scope |
| `whoami` | Report the current inferred scope |

The recommended agent behavior is defined in
[`docs/reporting-snippet.md`](docs/reporting-snippet.md). The installer adds that
contract plus the host-specific appendix under [`docs/instructions/`](docs/instructions/).

Item responses and annotations carry a monotonic `response_revision`. After handling a response,
call `resolve` with `expected_response_revision` from that exact `pending` item or
successful `answer` result. A missing or stale revision is refused: read and handle
the current response before retrying. Another agent's pickup does not authorize an
older response. Items without response history still support ordinary resolution.
Replies and annotations on closed items are refused rather than rewriting history.

Feedback on an open note or milestone reaches `pending()` until picked up; pickup
does not close the item or add human attention. `annotated_at`, `annotation_seen_at`,
and `annotation_seen_by` report saved/pickup state, not proof that the intended
session acted. Legacy annotations keep unknown timestamps rather than fabricated
receipts. Clearing feedback queues its empty, versioned state once. Use
`pending({item_id: id})` to recover the current open item after pickup or a clear,
and add `full: true` for its complete background. This adds no automatic host-wake
guarantee for informational feedback.

Summaries should say what changed, what remains, or what needs a decision in plain
language. For example, "The fix is ready for review, but has not shipped" is more
useful than a commit hash and a review transcript. Keep that evidence in the
expandable details, and do not label a prepared pull request as a shipped result.

## PR previews in approval cards

When GitHub reports a successful, explicitly non-production deployment for the
current PR commit, approval questions and blocked approval rows show a **Preview**
link beside their PR. Preview links use the existing source-chip controls and work
with the keyboard hints.

The viewer reads deployment `environment_url` values, never arbitrary check URLs
or links from agent prose. It rechecks the PR head before accepting a result.
Across environments it selects the newest successful status, then environment
name and deployment id as stable tie-breakers. Conflicting URLs for the same
environment, incomplete reads, and pending or inactive deployments produce no link.

Preview lookup is optional: ordinary PR state appears first, and a failure cannot
hide an approval request. Links expire after five minutes even if polling stops,
are withheld from closed projects (including shared branches), and are disabled rather than
silently retargeted if the PR changes while a reply draft protects the card.
Other PR history remains available when a refresh fails.

To bound background work, each branch lookup considers at most five deployments
and declines a larger result instead of choosing from a truncated page. Providers
that do not supply GitHub deployment URLs and explicit non-production metadata
are not supported. A Preview link reports GitHub's last observed deployment
state; it does not independently verify a provider's served content.

## Grouping plans by parent issue

Plans can gather active plans of one project whose GitHub issues share a parent
under a heading for that parent: its title, GitHub's "N of M sub-issues done" and
how many plans it holds. The plan pinned to the parent itself comes first, then the
others in GitHub's sub-issue order. Grouping is off by default. Turn it on in
**Settings → Plans** to use it every time Agent Inbox opens, or with the **Group by
parent issue** switch above Plans for the current view only.

Grouping only reorders. No plan is hidden, plans from different projects are never
merged, and a plan whose relationship data is missing, older than seven days or
unavailable stays in its usual place. Badges, counts and notifications do not change.

## Dependencies in Plans

When a plan's or a row's GitHub issue is blocked by open issues ("blocked by" on
GitHub), or a row says it waits on other steps of its plan, Plans shows a quiet
"waits on #119", "waits on 3" or "waits on step Build" chip; hover it for the list.
The plan card adds "Dependencies on GitHub" with what the issue waits on and what it
unblocks, and an expanded row lists everything it waits on and where that came from.
Only open issues and steps that are neither done nor marked not applicable count. A dependency is not a request for you:
it never marks a row blocked or changes a badge, count or notification. GitHub data
dims after 30 minutes without a refresh and disappears after seven days.

**Plan flow** shows the same dependencies on each step, in the agent's own order:
"Waits on" and "Unblocks" name the other steps as buttons that take you to them, and
an issue no step of the plan links shows as its GitHub chip with what Agent Inbox is
doing about it. A step filed under a different parent issue says "Part of #200",
sub-issues of the plan's issue that no step covers sit in a "Not in this plan" fold,
and a loop says "Circular dependency".

## Links in cards

Agent text links GitHub references (`#287`, `PR #284`, `owner/name#12`) and local
files written as absolute paths (`/Users/…/spec.md` or `~/notes.md`, optionally with
`:line`), as well as web addresses. Every open card lists its links in a **Links**
strip under its title: the item's own PR and issue first, then the rest in the order
they appear, each once. More than six fold into **+N more**.

Detection is cautious, so some things that could be links stay text: a single-digit
`#N` needs `issue`, `PR` or a word such as `Fixes` before it, and relative paths,
paths with spaces and routes such as `/api/items` never link.

In the desktop app a web link opens in your browser, and a common document (Markdown,
text, logs, JSON, YAML, TOML, CSV, XML, PDF, images, SVG, HTML, diffs, MOV and MP4)
opens in its default app. Anything else is only shown in Finder: folders, apps,
scripts and other code, installers, disk images, aliases, files set to open with a
particular app, and anything with an execute bit. Files open only in the viewer the
app started itself: if it is showing a viewer it found already running, and in a
browser tab, clicking a file link copies its path instead.

## Architecture

- **`src/store.ts`** owns schema, migrations, WAL configuration, and every database
  read/write, including the bounded local activity spans used by the dashboard.
- **`src/mcp-server.ts`** serves MCP over stdio. Its stdout is protocol-only and the
  process makes no network calls.
- **`src/viewer-server.ts`** serves the Hono API and static frontend through the
  loopback network boundary.
- **`public/`** is a plain JavaScript frontend with no bundler.
- **`electron/`** wraps the viewer, manages safe local-server reuse, notifications,
  setup, and packaging.

The default database is `~/.agent-inbox/inbox.db`. Set `AGENT_INBOX_DB` to use a
different file and `AGENT_INBOX_PORT` to change the viewer port.

## Local security model

The viewer binds one IPv4 listener to `127.0.0.1`, accepts only exact loopback
authorities, requires a trusted Origin for mutations, rejects cross-site Fetch
Metadata, and denies framing. Electron reuses only viewers carrying the expected
local-boundary marker.

This is an intentionally unauthenticated **single-user workstation** boundary.
Programs running as the same OS user can read the SQLite file directly. Do not expose
the viewer through a tunnel or run it on a shared host; authenticated hosted mode is
tracked in [issue #8](https://github.com/shariqh/agent-inbox/issues/8).

Live pull-request state is optional and viewer-owned through the local `gh` CLI. It
never enters the MCP server process or changes what counts as human attention.

Links in agent text are opened only by the desktop app's main process, which accepts
requests only from its own viewer window, opens only http and https addresses, and
only reveals a folder, app, script, installer or executable file. A file link carries
its path in a data attribute, never an `href`.

## Development

```sh
npm test
npm run typecheck
npm run build
```

For the local marketing site, run `npm run marketing` and open
`http://127.0.0.1:4320`. The single-file page at `marketing/index.html`
uses fictional demo data and does not connect to your inbox; only its hero
visual loads Three.js from a CDN.
See [Marketing preview](CONTRIBUTING.md#marketing-preview) for the port option.

The test suite uses real temporary SQLite databases and real stdio MCP integration
round trips. Node 24 is required because this checkout's `better-sqlite3` binding is
compiled for that ABI.

Before contributing, read [CONTRIBUTING.md](CONTRIBUTING.md) and the architectural
invariants in [CLAUDE.md](CLAUDE.md).

## Roadmap

- [Hosted mode with streamable HTTP and authentication](https://github.com/shariqh/agent-inbox/issues/8)
- [Remote answer to exact local-session wake and continuation](https://github.com/shariqh/agent-inbox/issues/51)

## Project links

- [Downloads](https://github.com/shariqh/agent-inbox/releases)
- [Installation](docs/INSTALL.md)
- [Claude hook integration](docs/hooks.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Issue tracker](https://github.com/shariqh/agent-inbox/issues)
- [MIT license](LICENSE)
