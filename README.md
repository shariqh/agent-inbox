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
| **Action-aware responses** | Recommended options, free-text answers, snooze, clarify, and decline controls |
| **Durable plans** | Tracking boards with stable rows, progress, next steps, outcomes, and human-owned actions |
| **Live sessions** | Ambient status for active agents and their current work without turning activity into alerts |
| **Dual-host setup** | Audited installers and instructions for GitHub Copilot CLI and Claude Code |
| **Local security boundary** | A loopback-only viewer with strict Host, Origin, Fetch Metadata, and anti-framing checks |

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
`electron/icon.icns`; `assets/icon-manifest.json` pins the source and generated
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
[`docs/hooks.md`](docs/hooks.md) for automatic idle-session pickup. Copilot questions
return an exact-item watcher command so the owning CLI session wakes when the answer
arrives.

## MCP tools

| Tool | Purpose |
|---|---|
| `flag` | Raise a question, non-blocking note, or completed milestone |
| `pending` | Read open questions and human responses on blocked board rows |
| `answer` | Record an answer the human gave in chat while preserving inbox precedence |
| `resolve` | Close an item after the agent acts on it |
| `status` | Publish ephemeral live work and child-agent presence |
| `board_upsert` | Create or refresh an entire tracking board |
| `board_row` | Update one stable board row |
| `board_advance` | Advance a row to its next human action without changing its label |
| `board_get` | Read board state and human annotations |
| `board_archive` | Archive a finished board |
| `register` | Override automatically inferred project, stream, repository, or issue scope |
| `whoami` | Report the current inferred scope |

The recommended agent behavior is defined in
[`docs/reporting-snippet.md`](docs/reporting-snippet.md). The installer adds that
contract plus the host-specific appendix under [`docs/instructions/`](docs/instructions/).

## PR preview links in approval context

When GitHub exposes a deployment preview for a PR head commit, Agent Inbox shows a
**Preview** chip next to the existing issue/PR source chips on merge-approval items
and blocked approval rows.

- Source: GitHub deployments for the exact `(repo, PR head SHA)`, using an active
  deployment status `environment_url`.
- Selection: ambiguous same-environment previews are omitted; otherwise the winner is
  deterministic (`success` before `in_progress`/`queued`/`pending`, then newest update).
- Safety: preview URLs are rendered only through `safeHttpUrl()` + `chipHtml()`, so
  non-`http(s)` schemes are dropped.
- Limitation: providers/check runs that do not expose a GitHub-associated deployment
  `environment_url` do not currently produce a Preview chip.

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

## Development

```sh
npm test
npm run typecheck
npm run build
```

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
