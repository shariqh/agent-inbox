---
target: Agent Inbox app
total_score: 23
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
timestamp: 2026-08-25T02-23-49Z
slug: public-index-html
---
Method: dual-agent (A: design-director · B: evidence-analyst)

# Agent Inbox design critique

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---:|---|
| 1 | Visibility of system status | 3/4 | Live state, counts, ages, and progress are strong; arrivals and failures lack a first-class presentation. |
| 2 | Match between system and real world | 3/4 | Ownership and handoff language is excellent; raw hashes, internal statuses, and runtime plumbing leak into the UI. |
| 3 | User control and freedom | 3/4 | Snooze, decline, clarify, and delivery-aware undo are thoughtful; Settings has no clear exit and answers have no undo. |
| 4 | Consistency and standards | 1/4 | Queue rows are non-semantic `div`s, three overview modals use different chrome, and two CSS systems visibly overlap. |
| 5 | Error prevention | 3/4 | Recommended choices and explicit response types help; the decision buttons are below the fold in both primary decision surfaces. |
| 6 | Recognition rather than recall | 2/4 | Field labels are good, but shortcuts are hidden and the narrow layout removes the ownership signal. |
| 7 | Flexibility and efficiency | 3/4 | Search, filters, keyboard commands, and resizable panes support experts; core rows remain unreachable by Tab. |
| 8 | Aesthetic and minimalist design | 1/4 | Duplicate content, full-card History entries, low-value labels, and competing overview surfaces overwhelm the useful information. |
| 9 | Error recovery | 2/4 | Errors collapse into one small red status span with no icon, diagnosis, or recovery action. |
| 10 | Help and documentation | 2/4 | Setup is comprehensive but presented as raw plumbing; the lifecycle model itself is never introduced. |
| **Total** |  | **23/40** | **Functional and conceptually strong, visually unfinished.** |

## Design Specificity Verdict

**The information architecture is authored for Agent Inbox; the visual system is category-interchangeable.**

The product-specific language is excellent: `Waiting on you → With the agent → Outcome`, the distinction between human completion and agent-owned `done`, and the inspector sequence from next action to background all encode a real operating model. Handoffs is the clearest expression of the product's thesis.

The shell around that model reads like a generic SaaS admin interface: narrow rail, count pills, kicker plus heading, filter-chip band, card list, inspector, and floating search. The rose palette is a tint rather than a semantic system, and the macOS type stack has no identity.

The strongest explanation for the user's "stale and unprofessional" reaction is accretion. `public/style.css` carries overlapping declarations and ad-hoc values: 16 font sizes, 13 radii, 189 `color-mix()` calls, and 21 raw opacity values. The eye reads the inconsistent rhythm and hierarchy as unfinished craft.

### Deterministic scan

The bundled detector returned exit 0 with zero findings for `public/index.html`. This is not evidence that the interface is clean: the scan did not flag dynamic DOM behavior, CSS accretion, content duplication, or the live responsive failures found during visual inspection.

### Visual inspection

Assessment A inspected the live app in a fresh CDP-driven browser tab at 1512×950 and 1120×900 across Inbox, an open inspector, Plans, Notes, History, Settings, search, dark mode, Review queue, Handoffs, and Plan flow. Assessment B had no browser automation or mutable injection path, so no reliable Impeccable overlay was created.

## Overall Impression

Agent Inbox has a better product model than its presentation suggests. It already knows the important truths—who owns the next move, whether an answer was picked up, and what outcome followed—but expresses them through dense, duplicated cards and a visual system with no governing scale.

The biggest opportunity is not "make it darker." It is to make the ownership-and-handoff model the entire composition: a dashboard for live monitoring, a focused Inbox for action, and a compressed History that communicates closure.

## What's Working

1. **The ownership model is original and trustworthy.** The app distinguishes state, action ownership, human completion, agent pickup, and final outcome instead of collapsing them into a generic task status.
2. **The system closes loops.** Receipts such as `You answered`, `With the agent`, and recorded outcomes create reassurance most agent tools lack.
3. **The information architecture survives real load.** Eight projects, sixteen plans, and hundreds of history items remain correctly classified; search also prevents old work from outranking current action.

## Priority Issues

### P1 — The decision surface buries the decision

**Why it matters:** The app's primary job is answering agent questions, yet both the inspector and Review queue push answer options below the visible area. Duplicate outcome and ownership content turns a yes/no decision into a dossier.

**Fix:** Keep the next step and response controls persistently visible. Collapse supporting rationale into one expandable block, render outcomes once, and reserve the full inspector for decisions that genuinely need depth.

**Suggested command:** `/impeccable distill public/index.html`

### P1 — Core queue interaction is inaccessible and loses meaning responsively

**Why it matters:** Queue rows are non-semantic `div`s with `tabIndex=-1`; keyboard and assistive-technology users cannot reach the primary control. Below 1280px the ownership chip disappears instead of reflowing.

**Fix:** Implement a semantic selectable-row pattern with roving focus, `aria-selected`, and `aria-expanded`. Preserve ownership as a second line at narrow widths.

**Suggested command:** `/impeccable audit public/index.html`

### P2 — The visual system is accumulated rather than directed

**Why it matters:** Continuous font sizes, radii, opacities, and per-site color mixing create inconsistent density and hierarchy. This is the mechanical source of the unprofessional impression.

**Fix:** Replace the overlapping CSS layers with a small type scale, spacing rhythm, three radii, named surface and semantic-color roles, and one elevation model. Apply it across navigation, cards, inspectors, modals, and forms.

**Suggested command:** `/impeccable typeset public/index.html`

### P2 — Completed work never looks finished

**Why it matters:** History renders hundreds of full decision cards, including next-step blocks. The archive therefore feels like unresolved work instead of proof that agents completed anything.

**Fix:** Make History a dense outcome ledger: title, human response, outcome summary, project, and time. Expand only on demand and suppress next-step content when an outcome exists.

**Suggested command:** `/impeccable distill public/index.html`

### P2 — Three overview surfaces compete without a true home

**Why it matters:** Review queue, Handoffs, and Plan flow all answer versions of "show me everything," but none is the default. Handoffs best expresses the product and is visually subordinate.

**Fix:** Establish one monitoring dashboard as the default home. Recast Handoffs as its ownership flow, keep Inbox as the focused action queue, and demote Review queue and Plan flow to context-specific tools.

**Suggested command:** `/impeccable shape dashboard`

## Persona Red Flags

**Solo operator managing concurrent projects**

- Seven toolbar controls outweigh a two-item queue.
- The best overview, Handoffs, is hidden behind a secondary button.
- There is no single surface showing active agents, waiting work, plan movement, and recent outcomes together.

**Operator returning after time away**

- New and changed work has little arrival emphasis.
- History looks like another open queue, so closure is difficult to perceive.
- Recency and ownership—the two most important triage signals—are among the smallest visual elements.

**Keyboard or screen-reader user**

- Queue rows cannot be reached by Tab.
- Important inactive and shortcut text falls below accessible contrast.
- Narrow layouts remove ownership instead of adapting its placement.

## Minor Observations

- `Ready after approval` appears repeatedly in one inspector and Review queue card.
- The shortcut footer advertises `1-4` even when only two options exist.
- Raw plan IDs and invariant `TRACKED` labels add noise.
- The search dock permanently overlaps content in several panels.
- Settings replaces the workspace and ends on implementation details.
- Dark mode is more coherent than light mode because the tinted palette reads more intentionally.

## Questions to Consider

1. What if simple approval items were answerable directly from the queue while only complex decisions opened the inspector?
2. What if `Waiting on you → With the agent → Outcome` became the dashboard's primary visual grammar?
3. Which current overview surface should disappear once the dashboard exists?
4. Should History behave as an audit ledger, a reassuring outcome digest, or support both through density controls?
