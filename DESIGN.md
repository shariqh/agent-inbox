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

The shell stays cool black/graphite. The existing Agent Inbox icon supplies the
primary accent through its monogram pinks; semantic status colors remain restrained:

| Role | Dark | Light | Meaning |
|---|---|---|---|
| Canvas | `#090b0d` | `#edf0f2` | Workspace background |
| Surface | `#15181b` | `#ffffff` | Working panels |
| Human attention | `#eb84bb` | `#a63864` | A real decision or task waits on the user |
| Active agent | `#38d6c0` | `#087f72` | Ambient live work |
| Plan | `#e7c54b` | `#8c6f00` | Durable tracked work |
| Outcome | `#77d995` | `#1f743c` | Closed loops and success |

Project colors remain identity markers, never the only carrier of status.

### Typography

Use one compact workhorse UI family:
`ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI"`.
This is intentional for an Operate surface. Hierarchy comes from disciplined size,
weight, spacing, and tabular numerals—not a decorative display face.

#### Type and spacing tokens

`public/style.css` declares one scale in `:root`. The Dashboard uses it first; other views move
to it as they are reworked. **New CSS uses these tokens, not literal sizes**, and a size that no
token fits is a reason to change the scale, not to add a literal.

| Token | Value | Use |
|---|---|---|
| `--fs-meta` | 12px | meta lines, table headers |
| `--fs-body` | 13px | body text, table rows |
| `--fs-lead` | 15px | what a session is doing, plan titles |
| `--fs-title` | 17px | an ask's title, group heads |
| `--fs-lane` | 28px (24px when the Dashboard is under 900px wide) | Dashboard region headers, weight 650 |
| `--sp-1` … `--sp-7` | 4, 8, 12, 16, 20, 28, 56px | gaps and padding |
| `--lane-gap` | 56px (40px when the Dashboard is under 900px wide) | space between Dashboard regions |

Region headers sit `--sp-5` above their content, and cards in a region are `--sp-3` apart. The
older `--gap` (16px) stays for the layout it already serves.

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

At wide widths the project library can collapse to a 72px icon rail. The collapse
state is window-persistent, preserves the prior resizable width, and never changes
the compact masthead used below 1280px.

The ownership grammar is consistent everywhere:

**Waiting on you → With agents → Outcome**

## Dashboard

The first viewport contains, top to bottom:

- the page head: one row of lane chips, **Needs you N**, **Working N** and **Quiet N**,
  with New session… at its right end;
- the **Needs you** lane: one card per ask;
- the Agents card, one card per session;
- local agent-claim history with explicit empty/error states, and recent outcomes.

A lane chip is a button that scrolls to its lane and moves focus to its first card. It
never filters, and it shows 0 when its lane is empty. The Needs you count shows only on
its chip: no lane header, group head or session card repeats it. Working counts the live
session cards whose state is working; Quiet counts the other live cards in the main list.
Until the Working and Quiet lanes exist, both chips land on the Agents card, clearing an
Agents state filter that hides the cards they count, and that card keeps its state filters
with their own per-state counts: its Quiet filter counts idle cards only, while the Quiet
chip also counts parked and starting ones. PR 4 removes the filters.

The Needs you lane holds the Inbox's attention set under the Dashboard's lens, in rail
order (asks an agent is waiting on first, oldest first), so with All projects its count is
the Inbox badge and every ask shows exactly once. A card shows the project, agent kind,
branch, age, the ask's title and its next step, and a blocked plan row's plan. A card never
answers and holds no control: a click or Enter opens the ask in the Inbox's detail panel,
which is the one action card per ask. When it was opened from the lane, Esc or the card's
close returns to the Dashboard, scrolled where it was, with focus on the card; answering
stays in the Inbox. The lane's header holds "Later N ›" (only above 0) and Review queue.
Empty, it says "Nothing in this view is waiting on you." and keeps its place. A card under
the pointer, or holding keyboard focus, does not move.

A session card never shows an ask. A session that has asks carries a pink "Asking you · N"
chip, which scrolls to its first ask in Needs you. An ask no session card holds shows in the
lane with "session ended" or "no session" in its meta line. The session panel keeps its
Asking you section, so you can answer while reading that session's transcript.

Keyboard: Tab reaches the chips, then the lane. In the lane, J/K and the arrow keys move
between cards with one roving tab stop, and Enter opens the card. G I still opens the Inbox.

Every summary is a working entry point into an existing view. Dashboard data never
enters the attention predicate, badge count, or alert system.

Dashboard composition is label-and-data first. Semantic icons, number relationships,
color roles, and chart form carry intent; explanatory subtitles are omitted. Longer
words remain only when they are the work itself (agent synopses and recorded outcomes),
an explicit error state, or assistive text in `aria-label`/tooltips.

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
  the lane chips on one row.
- **900–1279px:** compact masthead, inline queue detail; the lane chips wrap
  before they shrink.
- **620–899px:** stacked dashboard regions, one Needs you card a row, and
  reflowed metadata.
- **Below 620px:** horizontally scrollable navigation preserves every tab and
  count; dashboard is single-column, and the Needs you lane's Later and Review
  queue wrap under its title. The masthead uses three compact rows:
  identity/settings, tabs, then project and agent selectors side by side.
- **440px and below:** full-viewport action card. Verify at 320px, 375px, and
  430px. Project and agent selectors remain side by side rather than adding a
  fourth masthead row.

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
