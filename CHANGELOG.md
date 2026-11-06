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
- **Session build** *(#197, part 1; on the session cards since #454)* — see [`docs/architecture/activity-and-live.md`](docs/architecture/activity-and-live.md).
- **Agent registrations and "Update agents" / "Match agents"** *(#197, part 2)* — see [`docs/architecture/setup-and-installers.md`](docs/architecture/setup-and-installers.md).
- **Message a running agent session** *(#411)* — see [`docs/architecture/delivery-and-responses.md`](docs/architecture/delivery-and-responses.md) (store, `pending`, `ack_message`), [`docs/architecture/hooks-and-watcher.md`](docs/architecture/hooks-and-watcher.md) (Claude wake), [`docs/architecture/mcp-server.md`](docs/architecture/mcp-server.md) (channel push) and [`docs/architecture/viewer-frontend.md`](docs/architecture/viewer-frontend.md) (composer, delivery states, Not delivered).
- **The Agents home: one home for sessions** *(#454; retires the Live footer strip, its drawer and the Dashboard lanes)* — see [`docs/architecture/viewer-dashboard-and-shell.md`](docs/architecture/viewer-dashboard-and-shell.md) (cards, panel, Sessions line) and [`docs/architecture/driven-sessions.md`](docs/architecture/driven-sessions.md) (launch cards, Remove worktree).
- **Every ask on a session card** *(#454 PR 5: ask-only cards for asks whose session has ended or never existed, Needs you equal to the attention set, the session panel answering every ask with the Inbox's own controls, ⌘K "answer" opening the panel)* — see [`docs/architecture/viewer-dashboard-and-shell.md`](docs/architecture/viewer-dashboard-and-shell.md).
- **The Needs you rail retired; cleaner session cards** *(#454 PR 6: the Agents home spans the Dashboard, its header holds Later and Review queue, the Waiting on you tile turns on Needs you, card and panel keys, Compare in the panel, the panel under its card in a narrow window, the Inbox's session token and Show on Agents)* — see [`docs/architecture/viewer-dashboard-and-shell.md`](docs/architecture/viewer-dashboard-and-shell.md).
- **Quiet, not Idle, when a session hasn't reported** *(#466, PR 1)* — see [`docs/architecture/activity-and-live.md`](docs/architecture/activity-and-live.md) and [`docs/architecture/viewer-dashboard-and-shell.md`](docs/architecture/viewer-dashboard-and-shell.md).
- **Claude Code hooks stamp turns and tools** *(#466, PR 2: a session busy with other tools reads Working, "Task not reported")* — see [`docs/hooks.md`](docs/hooks.md) and [`docs/architecture/activity-and-live.md`](docs/architecture/activity-and-live.md).
- **Opt-in Copilot CLI hooks** *(#466, PR 3: `npm run install:copilot-hooks`, one owned file, turn and tool stamps for Copilot sessions)* — see [`docs/hooks.md`](docs/hooks.md) and [`docs/architecture/setup-and-installers.md`](docs/architecture/setup-and-installers.md).
- **Forget an ended session** *(#478: Forget… on an ended launch with no kept worktree, confirmed by main, deletes its record, transcript and logs; a stopped launch whose session is kept reads Stopped)* — see [`docs/architecture/driven-sessions.md`](docs/architecture/driven-sessions.md).
- **Copilot CLI sessions wake for messages** *(#477: `pending()` and `status({ done: true })` return a `message_watch` contract to Copilot clients; the session launches it detached, and its completion wakes the session)* — see [`docs/architecture/hooks-and-watcher.md`](docs/architecture/hooks-and-watcher.md) and [`docs/instructions/copilot-cli.md`](docs/instructions/copilot-cli.md).
- **Driven sessions: no budget by default; limits optional** *(#479: active time and tool calls have no limit unless New session sets one; an older driver refuses such a launch)* — see [`docs/architecture/driven-sessions.md`](docs/architecture/driven-sessions.md).
- **`packages/mesh`: the unslop agent's fidelity check, privacy screen and rules loader** *(#483, mesh M2a slice U1: pure modules in a separate package that never ships, its own CI job, and `mesh.json` fixtures shared with `src/mesh-config.ts`)* — see [`docs/architecture/mesh.md`](docs/architecture/mesh.md).
- **`packages/mesh`: the unslop agent's backend client and check pipeline** *(#483, mesh M2a slice U2a: one OpenAI-compatible call with pinned sampling and no tools, a nonce-delimited prompt, busy and kept-original classes, one time-bounded retry, and logs without text)* — see [`docs/architecture/mesh.md`](docs/architecture/mesh.md).
