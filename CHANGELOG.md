# Changelog

Release notes for each version are on the [GitHub releases page](https://github.com/shariqh/agent-inbox/releases).
This file keeps the feature history that used to sit in `CLAUDE.md` as "Shipped since v1" (#379).
Each entry names where its invariants now live; read that doc before changing the feature.

## Shipped since v1

v1 was deliberately local + triage-only. These have since landed — don't re-plan them:

- **Answer-back** *(#7)* — see [`docs/architecture/delivery-and-responses.md`](docs/architecture/delivery-and-responses.md).
- **`done`/milestone bucket** *(#9)* — see [`docs/architecture/delivery-and-responses.md`](docs/architecture/delivery-and-responses.md).
- **Electron packaging** *(#11)* — see [`docs/architecture/packaging-and-release.md`](docs/architecture/packaging-and-release.md).
- **Portable release runtime** *(#74 Layer 1)* — see [`docs/architecture/packaging-and-release.md`](docs/architecture/packaging-and-release.md).
- **Signed update-manifest trust contract** *(#106 Layer 1)* — see [`docs/architecture/updates.md`](docs/architecture/updates.md).
- **Rollback high-water mark** *(#148, rollback half only)* — see [`docs/architecture/updates.md`](docs/architecture/updates.md).
- **Verified update download** *(#196 part 1)* — see [`docs/architecture/updates.md`](docs/architecture/updates.md).
- **Verified update install on macOS** *(#196 part 2)* — see [`docs/architecture/updates.md`](docs/architecture/updates.md).
- **Verified update install for AppImage** *(#196 part 3)* — see [`docs/architecture/updates.md`](docs/architecture/updates.md).
- **Install grants survive a reload of the owned viewer** *(#216)* — see [`docs/architecture/electron-app.md`](docs/architecture/electron-app.md).
- **Unsigned per-user Windows MSI** *(#87, PR 2b)* — see [`docs/architecture/packaging-and-release.md`](docs/architecture/packaging-and-release.md).
- **Session presence** *(#28, corrected by #45)* — see [`docs/architecture/activity-and-live.md`](docs/architecture/activity-and-live.md).
- **Dual-channel answer sync** *(#29)* — see [`docs/architecture/delivery-and-responses.md`](docs/architecture/delivery-and-responses.md).
- **Electron response watch + host adapter seam** — see [`docs/architecture/hooks-and-watcher.md`](docs/architecture/hooks-and-watcher.md).
- **Copilot exact-question wake** — see [`docs/architecture/hooks-and-watcher.md`](docs/architecture/hooks-and-watcher.md).
- **Watcher backoff and "I'll take a while"** *(#217)* — see [`docs/architecture/hooks-and-watcher.md`](docs/architecture/hooks-and-watcher.md).
- **Backstop hooks** *(#10 + #21)* — see [`docs/architecture/hooks-and-watcher.md`](docs/architecture/hooks-and-watcher.md).
- **Close / reopen a project** *(#32)* — see [`docs/architecture/attention-and-later.md`](docs/architecture/attention-and-later.md).
- **Source + PR links** *(#30)* — see [`docs/architecture/github-and-issues.md`](docs/architecture/github-and-issues.md).
- **Board-annotation delivery** *(#37)* — see [`docs/architecture/delivery-and-responses.md`](docs/architecture/delivery-and-responses.md).
- **The human's "I did my part" mark on a blocked row** *(#36)* — see [`docs/architecture/delivery-and-responses.md`](docs/architecture/delivery-and-responses.md).
- **`blocked` now says WHO it waits on** *(#44)* — see [`docs/architecture/delivery-and-responses.md`](docs/architecture/delivery-and-responses.md).
- **Agent-read payload diet** *(#42)* — see [`docs/architecture/mcp-server.md`](docs/architecture/mcp-server.md).
- **The agent-emit contract** — see [`docs/architecture/delivery-and-responses.md`](docs/architecture/delivery-and-responses.md).
- **Human action lifecycle** — see [`docs/architecture/delivery-and-responses.md`](docs/architecture/delivery-and-responses.md).
- **Editorial desk shell** — see [`docs/architecture/viewer-dashboard-and-shell.md`](docs/architecture/viewer-dashboard-and-shell.md).
- **Attention-first cold launch** — see [`docs/architecture/viewer-dashboard-and-shell.md`](docs/architecture/viewer-dashboard-and-shell.md).
- **Build stamp + staleness signal** *(#40)* — see [`docs/architecture/setup-and-installers.md`](docs/architecture/setup-and-installers.md).
- **Session build in Live** *(#197, part 1)* — see [`docs/architecture/activity-and-live.md`](docs/architecture/activity-and-live.md).
- **Agent registrations and "Update agents" / "Match agents"** *(#197, part 2)* — see [`docs/architecture/setup-and-installers.md`](docs/architecture/setup-and-installers.md).
- **Message a running agent session** *(#411)* — see [`docs/architecture/delivery-and-responses.md`](docs/architecture/delivery-and-responses.md) (store, `pending`, `ack_message`), [`docs/architecture/hooks-and-watcher.md`](docs/architecture/hooks-and-watcher.md) (Claude wake), [`docs/architecture/mcp-server.md`](docs/architecture/mcp-server.md) (channel push) and [`docs/architecture/viewer-frontend.md`](docs/architecture/viewer-frontend.md) (composer, delivery states, Not delivered).
