# Design System

<!-- impeccable:design-system 1 -->

## Direction

Agent Inbox uses a **Live Operations Desk**: a dark-first, local command center
organized by ownership and handoff rather than generic productivity analytics.
It refuses equal-weight card grids, vanity metrics, fake AI summaries, decorative
glow, and controls that hide their real effect.

The physical scene is a developer monitoring several terminal agents for long
stretches, often beside dark editor windows. Dark is the first-run appearance;
Light and System remain complete, supported choices.

## Product Mode

**Operate.** The interface should disappear into monitoring, deciding, and
reviewing. Familiar controls, keyboard continuity, stable layout, and honest state
outrank novelty.

## Visual Foundations

### Color

The shell is neutral graphite. Color is semantic and restrained:

| Role | Dark | Light | Meaning |
|---|---|---|---|
| Canvas | `#090b0d` | `#edf0f2` | Workspace background |
| Surface | `#15181b` | `#ffffff` | Working panels |
| Human attention | `#ff7a59` | `#b03f26` | A real decision or task waits on the user |
| Active agent | `#38d6c0` | `#087f72` | Ambient live work |
| Plan | `#e7c54b` | `#8c6f00` | Durable tracked work |
| Outcome | `#77d995` | `#237c42` | Closed loops and success |

Project colors remain identity markers, never the only carrier of status.

### Typography

Use one compact workhorse UI family:
`ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI"`.
This is intentional for an Operate surface. Hierarchy comes from disciplined size,
weight, spacing, and tabular numerals—not a decorative display face.

### Geometry and Depth

- Prefer 7px controls and 10px panels; pills are reserved for short state/count
  tokens.
- Use precise 1px boundaries and flat neutral layers.
- Shadows carry a small vertical offset and blur. Never use colored halos.
- No gradients.

## Information Architecture

The primary navigation order is:

1. Dashboard
2. Inbox
3. Plans
4. Notes
5. History

Dashboard is the cold-launch view. It monitors real current state and truthful local
claim history. Inbox remains the focused action queue. History is an outcome ledger
that expands into audit detail.

The ownership grammar is consistent everywhere:

**Waiting on you → With agents → Outcome**

## Dashboard

The first viewport contains:

- truthful signals for active agents, human attention, plans, and recorded outcomes;
- local agent-claim history with explicit empty/error states;
- ownership flow;
- live dispatch;
- recent outcomes.

Every summary is a working entry point into an existing view. Dashboard data never
enters the attention predicate, badge count, or alert system.

## Action Surfaces

Action comes before explanation:

1. next step;
2. response controls;
3. why now / after this;
4. TL;DR and background;
5. receipts, history, and outcome.

The desktop inspector keeps one scrolling context body and a persistent response
footer. At phone widths the same `.nrow-card` remains under its owning row in the
DOM but becomes a full-viewport fixed surface. It has:

- a real close control;
- one primary scroll body;
- a bounded response footer;
- 2–4 direct options;
- optional comparison detail;
- secondary snooze/clarify/decline actions behind **More responses**.

No portal or duplicate action component is permitted.

## Responsive Contract

- **1280px and wider:** fixed project library, resizable queue/inspector split,
  four dashboard signals.
- **900–1279px:** compact masthead, two-column dashboard signals, inline queue
  detail.
- **620–899px:** stacked dashboard regions and reflowed metadata.
- **Below 620px:** horizontally scrollable navigation preserves every tab and
  count; dashboard is single-column.
- **440px and below:** full-viewport action card. Verify at 320px, 375px, and
  430px.

Responsive design reflows meaning. It never removes ownership, attention, actions,
outcomes, or global counts.

## Reactive Behavior

The existing two-entry render architecture is part of the design:

- polling enters through `renderIfIdle`;
- human writes enter through `reloadAndPaint` / `forceRender`;
- there is no third render path.

Ambient dashboard counts, badges, rail state, and Live presence may refresh while a
draft protects editable DOM. Drafts, focus, open context, inspector scroll, held
pointers, and trackpad momentum survive polling.

## Accessibility

- Queue rows expose listbox option, selection, and expanded state.
- Keyboard focus uses one roving tab stop.
- Color is always paired with text, glyph, position, or shape.
- Body and secondary text meet WCAG AA in both themes.
- Controls retain visible focus and truthful disabled/refusal states.
- Touch targets in the mobile action footer are at least 44px high.

## Copy and Data Truth

Use Agent Inbox language: ownership, pickup, response, outcome, and next step.
Avoid generic productivity framing.

Current snapshots and historical measures are labelled distinctly. Empty history
renders an honest empty state; it never draws a zero trend. Recorded outcomes include
both items and plan rows, so their total is intentionally broader than the History
item count.

## Anti-Patterns

- floating controls that cover working content;
- hiding ownership or counts at narrow widths;
- raw internal hashes/status values at title weight;
- full decision cards in History;
- activity presented as human attention;
- multiple competing overview surfaces;
- per-site opacity and `color-mix()` as the primary hierarchy system;
- decorative motion or page-load choreography.
