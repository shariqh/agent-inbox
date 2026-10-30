# Open backlog and the seams already in place

Work not yet shipped, each with its GitHub issue, and the seams it must build on.

Moved out of `CLAUDE.md` and `.github/copilot-instructions.md` by #379, nearly verbatim. Read on demand; it is not loaded automatically.

## Items

- **Remote / hosted mode** *(#8)* — run on a server, tunnel-exposed for phone + cloud-agent reach.
  Swap stdio for **streamable-HTTP** and add **auth** (bearer token in MCP client headers + a gate
  on the viewer). `register` is the identity seam: a remote server can't see the client's `cwd`, so
  agents declare scope via `register` instead of auto-inference. `AGENT_INBOX_DB`/`AGENT_INBOX_PORT`
  env overrides are already in place. Design (three blocking decisions, three verified wiring traps):
  [`docs/superpowers/specs/2026-07-26-remote-hosted-mode-design.md`](../../docs/superpowers/specs/2026-07-26-remote-hosted-mode-design.md).
- **Plans that model GitHub sub-issues** *(#103, v1.4)* — PR1a shipped the `issue_snapshots`
  cache, issue keys and key sets, the pure graph builder and `GET /api/issues`; PR1b the
  viewer poller (fair queue, leases, rate-limit budget, `closing_refs`; see the invariants
  in `github-and-issues.md`); PR2 explicit plan pins and row links with the titled `board_get` `issue_rel`
  summary (see the invariant in `github-and-issues.md`); PR3 breadcrumbs, child progress and Agent Inbox
  activity in the UI (see the invariant in `plans-issue-ui.md`). That completes the first slice. Slice 2 (v1.5,
  [`2026-10-21-plan-dependencies-design.md`](../../docs/superpowers/specs/2026-10-21-plan-dependencies-design.md))
  adds dependencies and opt-in grouping in six PRs: A ingests GitHub's issue dependencies, B
  reconciles them into `blocks` edges and `issue_rel` (`waits_on_issues`, `unblocks`), C adds
  the agent-written `waits_on` row field, D draws dependencies in Plans, E in Plan flow, and F
  adds opt-in grouping by parent issue (see the invariants in `github-and-issues.md` and
  `plans-issue-ui.md`). Sibling context stays later: #403.
- **Agent mesh** *(M1 #397 shipped: the opt-in Agents view and `meshctl`; see the invariant
  in `mesh.md`)* — M2–M9 per [`2026-10-29-agent-mesh-design.md`](../../docs/superpowers/specs/2026-10-29-agent-mesh-design.md)
  §11 (tracked in #404), each behind its own `mesh.json` key and each with its own "off" tests (§2.4).
Keep all of these additive and behind the existing seams — don't break v1's local,
zero-config, no-auth path.

Boards-specific follow-ups (unseen-by-agent markers, row context field, archive safety,
row escalation) are GitHub issues #1–#6; original review context in
[`docs/boards-backlog.md`](../../docs/boards-backlog.md).
