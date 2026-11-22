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

1. Home
2. Plans
3. Notes
4. History
5. Chats

Home is the cold-launch view and the one place for asks: the focused action queue
(Needs you) comes first, the opened ask in front beside it, then the lanes that monitor
real current state and truthful local claim history. There is no separate Inbox page.
History is an outcome ledger that expands into audit detail.

At wide widths the project library can collapse to a 72px icon rail. The collapse
state is window-persistent, preserves the prior resizable width, and never changes
the compact masthead used below 1280px.

The ownership grammar is consistent everywhere:

**Waiting on you → With agents → Outcome**

## Home

Home is one page. The first viewport contains, top to bottom:

- **Needs you**, the list of asks: a quiet first line (the heading, the number still
  waiting on you under the current lens and filters, and a **Filter** toggle at its right
  end), then one row per ask, answered asks dimmed at the foot, Later and the other folds
  below;
- the **Working** lane: one card per session with live work, grouped by project, New
  session… at the right end of its heading;
- the **Quiet** lane: one table row per idle, quiet or parked session, with the folds at
  its end;
- the **Plans in progress** lane: one row per active plan with open steps;
- **Just landed**: recent outcomes;
- **Today**: the activity ribbon of local agent-claim history, with explicit empty and
  error states, last on the page.

The filters (All, Decisions, To do, Updates), Sort, Handoffs and Review queue rest out of
sight behind **Filter**; an active filter or a sort other than the saved default keeps them
shown, so nothing that narrows the list is ever out of sight. There are no lane chips, no
session filters and no group-by, and the lane headers carry no count.

**The ask in front** (1280px and wider). The open ask is the card fixed at the right, the
question, one line and its answers (UX slice 1), 640px wide by default. When nothing is
open, the first ask waiting on you comes to the front by itself at the first paint, moving
no focus and scrolling nothing; the person's ✕ or Esc keeps it closed until they open an
ask again, come back to Home, or a new ask arrives when none was waiting. After the ask in
front is resolved, dismissed, snoozed or pinned, the next one comes forward; an answered
ask stays. While an ask is in front, the list and every lane sit in a column beside it;
with nothing in front they use the full width. The ask and the session panel never show
together: opening one closes the other, and closing the panel brings the ask back at once.
While focus rests in the lanes the list keeps updating, and an ask waits to come forward
until that focus leaves, so the column never narrows under a control in use. Below 1280px
nothing opens by itself: Home is one column, the list with its inline card or phone sheet,
then the lanes.

**One look for Home's sections.** Needs you, Working, Quiet, Plans in progress, Just landed
and Today share one quiet heading and sit on the page itself, edge to edge; only what a
section holds (an ask's row, a session's card) is boxed. Projects with working sessions sit
side by side where there is room. When nothing waits, the list is one line, "Nothing needs
you", with no count chips.

A session card never shows an ask. A session that has asks carries a pink "Asking you · N"
chip, which puts its first waiting ask in front. An ask in the list names its session
("live · branch", or "session ended"). The session panel keeps its Asking you section, so
you can answer while reading that session's transcript.

Every live session is in exactly one place: Working, Quiet or a fold. **Working** holds the
sessions whose state is working (a running host turn included), under a project head (dot,
name, session count, at the group-head size). A card leads with one meta line (state dot,
agent, branch, time since its last call; a long time wraps under the agent and branch
instead of squeezing the branch), then what the session is doing at the lead size,
up to two lines, then its subagents and plan progress. Its first button is **Open**, the
session panel; **Message** follows it. **Quiet** is a compact table: state, session (project
and agent), branch, last caption, since, and the state's main action (Open and Message for an
idle session, Take over and Resume… for a parked one). Each row is one line, ending in an
ellipsis, and when a message reaches the session is in Message's tooltip. The Mesh agents
section follows the rows, then the folds: Ended (with Earlier sessions inside), Dormant,
Closed projects and Not delivered, shown only with something in them. A lane with nothing
keeps its header and says so in one quiet line; with no session at all, Working shows the
first-run message.

Inside a lane, order is pinned between forced paints, project groups included, and held
through a forced one while the pointer or keyboard focus is in the lane, so a card or row
under the pointer never moves. A session that starts or stops working changes lane on the
next paint.

**Plans in progress** holds every active plan under Home's lens that has an open
step (a row neither done nor na), from the plans already loaded. A row shows the plan's
title (on one line, the whole of it in its tooltip), its project's dot and name with All
projects, a bar of done out of countable steps with the numbers beside it ("7/15"), the
rows waiting on you in pink ("2 need you", only above 0), and when the plan last changed,
with the exact time in its tooltip. The numbers are the ones the Working card's plan bar
and the Plans tab show. Plans with a row waiting on you come first, then the newest change;
the order holds while the pointer or keyboard focus is in the lane, as the session lanes' does. Six
show, then one line, "All plans ›" ("All plans · N more ›" when more qualify), which opens
Plans under the same lens. A row is one link-like control: a click or Enter opens that plan
in Plans, as every other link to a plan does, and it holds no button and never answers. The
lane's header carries no count. Empty, it says "No plan in this view has open steps." and
keeps its place. **Just landed** and the **Today** ribbon follow it as full-width lanes,
their content unchanged.

Keyboard: Tab reaches the list of asks, then each lane in page order. In the list J/K and
the arrow keys move between asks and Enter opens one; in each lane, Plans in progress
included, they move between its cards or rows with one roving tab stop, never into the next
lane, and Enter opens the session panel or the plan. G D is Home; G I focuses the first ask.

The session panel: at 1280px and wider it opens beside Working and Quiet as a split. The
lanes take the left column and reflow to it: Working to the card columns that fit, each
Quiet row on two lines once the lanes are under 900px wide. The panel takes a 360–460px
right column, stays in view under the top bar with its own scroll, and covers nothing.
Opening or closing it keeps the card or row you opened where it was on screen, and closing
gives the lanes their full width back. Below 1280px it opens inline under its card or row.

Every summary is a working entry point into an existing view. Home's lane data never
enters the attention predicate, badge count, or alert system.

Dashboard composition is label-and-data first. Semantic icons, number relationships,
color roles, and chart form carry intent; explanatory subtitles are omitted. Longer
words remain only when they are the work itself (agent synopses and recorded outcomes),
an explicit error state, or assistive text in `aria-label`/tooltips.

## Action Surfaces

An ask at rest is its question, one line of why and its answers:

1. next step (the question);
2. TL;DR, then the links the ask names;
3. receipts, your own answer, and outcome;
4. **Details**: why now / after this, who acts, background, and history;
5. response controls.

The desktop inspector keeps one scrolling context body and a persistent response
footer. At phone widths the same `.nrow-card` remains under its owning row in the
DOM but becomes a full-viewport fixed surface. It has:

- a real close control;
- one primary scroll body;
- a bounded response footer;
- 2–4 direct options;
- one line of detail under each option, in full behind **Compare options**;
- secondary snooze/clarify/decline actions behind **More**.

A wide window's inspector is as tall as its content and grows to the window's
margin; when it does not fit, Details scrolls in place before the answers do.
Nothing enters or leaves an answer area on focus alone, so a press never moves
the control under the pointer.

No portal or duplicate action component is permitted.

## Chats

A row's Actions cell holds, in order: **Resume** (the desktop app only), **Copy resume**,
and on a Copilot row in the window that may start sessions, with the driven-sessions switch
on, **Continue here…**. The three are told apart by verb and title: Copy resume copies a
command, Resume opens your terminal, and Continue here… keeps the chat in this window; its
ellipsis says a dialog follows. Claude Code rows get no Continue here…, so a row never carries
a control that is always off. In the wide table the three stay on one line and a row is one
line tall; below 620px they wrap on the row's second line, spaced with `--sp-2`. A control
that cannot act is `aria-disabled` with the reason in its title, so the reason stays
reachable by focus. Main's answer, a refusal or a notice, goes in one quiet line under the
controls.

A chat a session of this app holds (running, parked, or stopped with its session) offers
**Show session** in place of Continue here…, which opens that session's panel on the
Dashboard; Copy resume and Resume are off beside it ("This chat has a session here: use Show
session, then Take over."). While that session runs, the Live cell reads "Live · here" in the
agent color. The session panel of a continued chat says "Continued from a Copilot chat
(1a2b3c4d)", linked to the Chats tab.

The **Continue in Agent Inbox** dialog is New session's dialog in miniature: the chat's title
and folder as plain text, the mode (Ask for everything, the default, or Read-only, with New
session's copy), and a required Message with the don't-paste-secrets hint. Continue stays off
until there is a message. After Continue the dialog stays, saying each step of the start, as
New session's does, and Cancel becomes Stop starting; main's own confirmation is the consent.
A refusal shows main's text in the dialog; Cancel in main's confirmation returns to the dialog
with the message kept. Escape and Cancel close it and return focus to the row's control.

## Responsive Contract

- **1280px and wider:** fixed project library; the ask in front at the right, resizable
  (640px by default), the list and the lanes beside it only while an ask is in front;
  with the session panel closed, Working cards three a row
  at 1440px and two at 1280px; an open session panel splits the lanes: lanes left,
  panel right, nothing covered, with one Working card a row beside it up to about
  1485px wide and two above, and each Quiet row on two lines. Plans in progress,
  Just landed and the Today ribbon span the page: a plan row on one line, Just
  landed four across.
- **900–1279px:** compact masthead, inline queue detail, nothing opens by itself;
  two Working cards a row, and the session panel inline under
  its card or Quiet row.
- **620–899px:** stacked regions, one Working card a row, reflowed metadata, and each Quiet row on two lines with no header
  (keyed on the lanes' own width, so also beside an open session panel);
  a plan row on two lines, Just landed two across.
- **Below 620px:** horizontally scrollable navigation preserves every tab and
  count; Home is single-column; a plan row stacks, Just landed is one across.
  The masthead uses three compact rows: identity/settings, tabs, then project
  and agent selectors side by side.
- **440px and below:** full-viewport action card. Verify at 320px, 375px, and
  430px. Project and agent selectors remain side by side rather than adding a
  fourth masthead row.
- **Every width:** the Today ribbon is Home's last lane, as wide as the lanes are (the column
  beside an ask in front on a wide window, the full width otherwise).

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

Terminal action labels keep the generic word ("Open in Terminal", "Take over in Terminal").
The chosen app (Settings → Terminal, #586) is named in the control's `title` and, when it is not
Terminal, its `aria-label`, and in main's own confirmation, so the truth reaches keyboard and
screen-reader users too.

## Anti-Patterns

- floating controls that cover working content;
- hiding ownership or counts at narrow widths;
- raw internal hashes/status values at title weight;
- full decision cards in History;
- activity presented as human attention;
- multiple competing overview surfaces;
- per-site opacity and `color-mix()` as the primary hierarchy system;
- decorative motion or page-load choreography.
