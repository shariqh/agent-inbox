# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Agent Inbox is for a solo software developer operating multiple GitHub Copilot CLI
and Claude Code sessions across projects on one workstation. The primary user is a
power user who needs to monitor concurrent agent work without staying inside every
terminal.

## Product Purpose

Agent Inbox is a local command center for questions, plans, handoffs, notes,
milestones, and live status from coding agents. It should make it immediately clear
what agents are doing, where work is waiting, and what needs the user's attention.

The dashboard's primary job is monitoring agents while they work. Success means the
user can understand the state of active work at a glance and move directly to the
right response, plan, project, or outcome.

## Positioning

Agent Inbox is not another agent and does not summarize work through a hosted model.
It is deterministic local infrastructure that gives multiple coding tools one shared,
durable human-attention and work-status surface.

## Operating Context

- The app runs as an Electron desktop wrapper or a loopback-only browser viewer.
- Copilot CLI and Claude Code sessions publish questions, plans, and live status
  through a local MCP server.
- The viewer and MCP processes coordinate through a shared local SQLite database.
- The user may have several projects and agent sessions active at once.
- The user moves between ambient monitoring, focused triage, plan review, and
  historical outcome review.

## Capabilities and Constraints

- Preserve Inbox, Plans, Notes, History, project filtering, agent filtering, global
  search, live sessions, handoffs, plan flow, and action-aware responses.
- The product is local-first, single-user, and has no telemetry or hosted service.
- The core data path has no model calls. Dashboard explanations and rollups must be
  derived from real stored state, not generated or fabricated.
- The dashboard may add locally stored historical metrics so trend views represent
  genuine activity over time.
- Human attention remains a strict product concept. Ambient health, activity, or
  failed automation must not be mislabeled as requiring human action.
- The frontend is plain browser ESM wrapped by Electron; the local viewer's security
  boundary and responsive behavior must remain intact.
- Live state must continue updating without a manual refresh. Poll-driven changes must
  not interrupt typing, focused controls, scrolling, held pointers, or in-progress
  responses.

## Brand Commitments

- Keep the Agent Inbox name and the product's command-center identity.
- The user supplied a dark, modular dashboard reference as a binding quality and
  composition benchmark. Future work should translate its disciplined grid, confident
  hierarchy, dense-but-calm surfaces, and restrained semantic accents into Agent Inbox
  rather than copying its CRM content.
- The existing Agent Inbox icon is the primary-accent authority: its monogram pinks
  replace generic orange branding on selection, focus, and human attention. The
  workspace itself stays cool black/graphite; cyan, yellow, and green remain limited
  to active-agent, plan, and outcome semantics.
- Professionalism should come from clarity, precision, and operational confidence,
  not decorative complexity or invented enterprise claims.

## Evidence on Hand

- The current production interface under `public/`.
- The current product overview screenshot at
  `docs/assets/agent-inbox-overview.png`.
- Existing real data for questions, board rows, plans, human responses, outcomes,
  projects, repositories, and live agent activity.
- A user-supplied Wise dashboard screenshot in the design conversation. It is a
  visual reference only; Agent Inbox has no CRM sales, lead, or invoice data.
- No user research, testimonials, usage benchmarks, or historical dashboard schema
  has been provided. Future work must not fabricate them.

## Product Principles

1. Attention must stay trustworthy: urgent-looking UI is reserved for real human
   action.
2. Monitoring should be glanceable first and explorable second.
3. Every metric and trend must be backed by local product data.
4. Dense operational information should feel calm, legible, and controllable.
5. The dashboard complements focused triage; it does not turn the Inbox into an
   analytics maze.
6. Responsive layouts reflow structure instead of hiding ownership, attention,
   actions, or outcomes.
7. New visual work must preserve the current app's trust guarantees: human attention
   remains exact, delivery is not acknowledgement, and the interface never presents
   ambient agent state as a human blocker.
8. Global signals and scoped views stay distinct: project or agent filters may narrow
   what the user is viewing, but they never make real attention disappear from the
   global badge.
9. Action comes before explanation. Show the next step and response controls first;
   progressively disclose rationale, background, and audit detail.
10. Human actions are reversible where truth permits and explicit where it does not.
    Snooze, clarify, decline, undo, pickup receipts, and outcomes must continue saying
    what happened after a decision.
11. Live presence is ambient context, not an alarm. Quiet, idle, and historical agent
    state remains available without competing with work that genuinely needs the user.
12. Navigation continuity is part of reliability. Search, deep links, keyboard
    movement, project lenses, focused controls, and open context must survive polling
    and visual restructuring.

## Accessibility & Inclusion

The dashboard must remain fully keyboard operable, support light and dark appearance
where the product does, preserve visible focus, and avoid encoding project, agent, or
status meaning through color alone.
