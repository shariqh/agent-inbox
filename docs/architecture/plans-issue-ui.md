---
paths:
  - "public/issues.js"
  - "public/mission.js"
  - "public/source.js"
applyTo: "public/issues.js,public/mission.js,public/source.js"
---

# Plans UI: breadcrumbs, dependencies, Plan flow and grouping

How Plans and Plan flow draw the issue graph (#103 PR3, slice 2 PRs D–F), always as ambient information.

Moved out of `CLAUDE.md` and `.github/copilot-instructions.md` by #379, nearly verbatim. Claude Code and Copilot CLI load this file automatically when they read or edit a file matching the `paths`/`applyTo` globs above (through the symlinks in `.claude/rules/` and `.github/instructions/`); anyone else should read it before changing those files.

## In brief

- Breadcrumbs and child progress (#103 PR3) are ambient. `/api/issues` is the
  poll's eighth read, through its own snapshot validator and a links-style
  fallback: a 404, network error or refused body means no graph and today's plain
  chips, never a failed tick. `public/issues.js` (`buildIssueView`, pure) is
  rebuilt in `paintAmbient` beside `linkIndex`; it ages relationships (dim after
  30 min, hide after 7 days, "unavailable" with no title after a hard failure),
  draws an issue whose own root says `hierarchy: 'unavailable'` as the plain chip
  with one "Relationships unavailable" line (`issueRelations` reads the same
  root field, so the agent's `issue_rel` agrees), and its activity labels READ the
  frame's `attentionEntries` and never feed a badge or count. `public/source.js`
  draws it: `issueRef` delegates to `issueKeyFor`, a linked row names its own
  issue, every relationship link is built from a validated slug and number while
  the issue chip keeps #30's URL rules (filtered by `safeHttpUrl()`), every href
  comes from `chipHtml()`, and the word "Blocked" never appears. History keeps its
  plain chip, and labels open their target only through `focusItem`.
- "Waits on" in Plans (#103 slice 2 PR D) is ambient. `buildIssueView` gives a drawn
  relation `dependencies` only when its root says `dependencies: "ok"` (open blockers and
  dependents, activity labels read from `attentionEntries`, `cycle`, and +N counts of open
  ones beyond the page (any unlisted open one when the direction's total exceeds GitHub's
  50-entry page, which includes closed issues), hidden from the account (only when the page
  was complete) or cut by the cap: "+N not shown" counts only the open ones the cap cut,
  `dependencies_omitted_open`, and each direction is taken only from its own lines, #275), `{status:'unavailable'}`
  for a refused section, and `null` otherwise: never "no dependencies". `planWaits` and
  `rowWaits` merge a row's unfinished `waits_on` steps (local, drawn with no graph; dangling
  labels and `done` or `na` targets draw nothing) with its issue's open blockers, one entry per pair.
  Chips and lists are built only in `public/source.js` (`esc()`, `chipHtml()`, a link only
  from a validated slug and number, `tone-issue`/`tone-stale`, never the word "Blocked");
  matrix chips stay out of the roving order. No dependency or `waits_on` value reaches
  attention, a badge, a count or the dock.
- Plan flow (#103 slice 2 PR E) reuses D's view: `buildMission(board, { issues, links })`
  is pure, keeps the agent's row order, and adds per-step `waitsOn`/`unblocks` (in-plan
  steps merged across both sources, `unblocks` the exact inverse; local `waits_on` to
  `done`/`na` steps are satisfied, while GitHub edges follow the open issue, so a `done`
  row whose issue is still open can still be waited on), external issues with their activity label (never a cross-plan edge), a
  `partOf` rail where the parent differs from the plan's issue, `circular`, and the
  "Not in this plan" fold. Prose never creates an edge. `public/source.js` draws it;
  only a step button's click calls `focusMissionStep` (focus with `preventScroll`, then
  `revealControl` inside the flow); passive restores never reveal, and nothing reaches
  attention.
- Grouping plans by parent issue (#103 slice 2) is opt-in and only reorders.
  `agent-inbox-group-plans` is a saved preference seeded on every load (like
  #221's sort order); the Plans header switch changes only the current view, and
  both repaint through `forceRender()`. `planGroups` (pure, `public/issues.js`)
  keys a group by `(project, parent)`, needs two active plans, and admits a plan
  only through a certain identity whose relation is `fresh` or `stale`; anything
  else stays flat in its place, and no plan is ever hidden. Lingering and archived
  plans are not grouped. Headers are built in `public/source.js` and no grouping
  value reaches attention, a badge, a count or the dock.

## Invariants in detail

- **Breadcrumbs and child progress are ambient GitHub data (issue #103, PR3).** The page
  reads `/api/issues` as the poll's EIGHTH concurrent read, through `readSnapshot` with a
  validator of its own (`public/snapshots.js`: version 1, string-keyed nodes, edges and
  roots, record aliases; no query string) under the tick's boot-marker and
  `loadGeneration` rules. `issuesBody` gives it the `/api/links` fallback: a 404 from an
  older viewer, a network error or a body the validator refuses is `null`, "no graph",
  and never fails the tick. Four things are load-bearing. (1) **One view per frame, read
  only.** `paintAmbient` rebuilds `issueView` beside `linkIndex` with `buildIssueView`
  (`public/issues.js`, pure): relations keyed by the key each `/api/issues` root was
  requested under, nodes re-validated against their own key (an invalid one is dropped),
  the trail top first (eight levels), children in GitHub's order and the "+N not visible
  to your GitHub account / more on GitHub / not shown" counts. Its Agent Inbox activity
  labels READ the frame's `attentionEntries` and feed nothing back — Waiting on you, then
  Active (the newest open item, active plan or not-done row), then Done here, then None
  here, for certain keys only (an unlinked blocked row waits under its plan's issue).
  `public/attention.js`, `relay.js` and `reply-watch.cjs` name no issue field, and
  `test/dom/issue-attention.test.ts` pins badge, title, tab counts, Needs you and the dock
  projection identical with and without a graph. (2) **Freshness is the browser's.**
  Fresh until 30 minutes after `fetched_at`; stale to 7 days (`tone-stale`, "as of …",
  ERROR_LABEL's reason); hidden after (the plain chip; the block says "Relationships
  unavailable — last seen …"); a hard failure says "unavailable" and why, with no cached
  title. An issue GitHub returned without its parent or sub-issues (§5.7: the poller stores
  `hierarchy: { status: 'unavailable' }` as a success) draws like an expired one, whatever
  another issue's list says: the plain chip and "Relationships unavailable — GitHub
  returned this issue but not its parent or sub-issues", never "checked". Each
  `/api/issues` root carries that status as `hierarchy` (`'ok' | 'unavailable' | null`,
  null when no snapshot is readable; additive within version 1, an absent field reads as
  before), and `issueRelations` reads the same field, so the chips and the agent's
  `issue_rel` agree by construction (`test/issues.test.ts` checks every state). A soft
  failure before any success, an unreadable snapshot, a root the node cap omitted, an
  uncertain identity or History (`sourceOptions` passes no view for a closed item) draws
  #30's plain chip byte for byte. (3) **Identity before relationships.** `issueRef` now delegates to
  `issueKeyFor` (closing over `issue-key.js`, which imports `source.js` back; both only
  call each other inside functions): a plan's pin names its chip, a PR closing several
  issues names none (its tooltip and block list them as `closes …`), and an issue number
  with no usable repository keeps #30's unkeyed chip. `opts.row` makes a linked row name
  its own issue in its card and Needs-you line; `rowIssueChipsHtml` draws it first in the
  matrix note cell, whose row click ignores anchors; `issueRelationsHtml` draws a plan's
  trail and sub-issues in `.board-issues`, outside `<summary>`. (4) **Escaping stays in
  `source.js`.** Titles, agents and labels go through `esc()`, `data-issue-key`/
  `data-issue-open` too, and labels name the repository whenever it differs. Every
  relationship link (parent, trail, sub-issue) is built from a validated slug and number;
  the issue chip keeps #30's URL rules (a PR-derived issue may use the cached `issue_url`,
  and a number with no usable repository its constructed URL), each filtered by
  `safeHttpUrl()`. Every href still comes only from `chipHtml()`, relationship chips use
  only `tone-issue`/`tone-stale`, and the word "Blocked" never appears. An
  activity label opens its target only through `openIssueActivity` → `focusItem(id,
  { rowId })` (closing triage, relay and Plan flow first). No render path fetches, and the
  poll gate, press guard, scroll guards and focus rules are unchanged, so a
  relationship-changing poll keeps drafts, focus and expanded rows
  (`test/dom/issue-relations.test.ts`).
- **"Waits on" in Plans is ambient, open-only and never "blocked" (issue #103, slice 2 PR D).**
  Design §9.1. `buildIssueView` (`public/issues.js`, pure, still rebuilt only in
  `paintAmbient`) now also reads `blocks` edges: a drawn (`fresh`/`stale`) relation carries
  `dependencies`, which is `null` unless its own root says `dependencies: "ok"` (unknown,
  null, a missing field, hidden, no-hierarchy and unavailable relations all draw no list and
  never "no dependencies"), `{ status: 'unavailable' }` when GitHub refused the section (one
  "Dependencies unavailable" line), and otherwise the OPEN blockers ("waits on") and OPEN
  dependents ("unblocks") by repository and number, each with the slice-1 activity label
  READ from the frame's `attentionEntries`, `cycle` when a `cycle: true` edge touches the
  issue, and three counts of open ones it cannot show. GitHub's page holds the first 50
  dependencies of a direction, CLOSED ones included, so the unlisted open ones (`open` minus
  listed) are "more on GitHub" when that direction's `total` exceeds 50 and "not visible to
  your GitHub account" only when the page was complete (`total` ≤ 50): never blame
  permissions for what may sit beyond the page (review of #274). The node cap's cut of OPEN
  ones ("+N not shown": the sum of `dependencies_omitted_open`'s two directions, one line per
  section, #275) is taken out of those two counts, each direction only from its own list's
  lines, so a closed neighbour the cap cut never inflates it and a cut blocker is never called
  hidden. A graph without the field (an older viewer) falls back to `dependencies_omitted`,
  taken from both directions as before.
  Closed issues draw nothing and are never counted. The same view adds `planWaits` (plan
  id → its certain issue's open blockers) and `rowWaits` (row id → its `waits_on` steps that
  are neither `done` nor `na` (a step that will not happen holds nothing up), then its own link's open blockers). Steps are local and draw with no graph;
  a dangling label draws nothing; a step whose linked issue is one of those blockers is ONE
  entry labelled with both sources. `public/source.js` draws it all: `rowWaitsChipHtml`
  after a row's issue chip (matrix note cell, out of the roving order unless `tabbable`, and
  the row card), `planWaitsChipHtml` beside a plan's chip, "Dependencies on GitHub" below the
  sub-issues in `issueRelationsHtml` and the card source block, and `rowWaitsHtml` in
  `rowPanelEl`. A chip says "waits on #119", "waits on 3", "waits on step Build" or "waits
  on 2 steps"; only a single issue is a link, built from a validated slug and number through
  `chipHtml()`; an entry whose node is no valid slug and number loses its GitHub half (or
  vanishes). Tones are `tone-issue`/`tone-stale` only: a dependency is never the human's
  blocker, so never the bad tone, the blocked mark or the word, even on a `blocked` row.
  Nothing new reaches `public/attention.js`, `relay.js`, `reply-watch.cjs`, a badge, a count
  or the dock: `test/dom/issue-attention.test.ts` compares every attention surface with and
  without dependencies AND `waits_on`, grouping off and on. DOM behaviour (404 and stale
  fallbacks, a draft, focus and expanded row through a dependency-changing poll) is
  `test/dom/plan-dependencies.test.ts`.
- **Plan flow draws dependencies from Plans' own view model and never reorders (issue #103,
  slice 2 PR E).** Design §9.2. `buildMission(board, { issues, links })` (`public/mission.js`,
  pure) reads the frame's `issueView` (`rowWaits`, `relations`) and `linkIndex`; `renderMission`
  passes them and nothing fetches. Rows keep the agent's order (D3); there is no topological
  sort. Per step it adds `waitsOn`/`unblocks`: an in-plan step is the first non-`na` row
  linking an issue, a waits-on/unblocks pair is ONE entry carrying both sources, both lists
  follow row order, and `unblocks` is the exact inverse of every step's `waitsOn`, so the two
  can never disagree. GitHub edges come from either end: a row's own `rowWaits` (its issue's
  open blockers) and, for a row whose issue is OPEN, its relation's open dependents (an edge
  known only from the blocker's side still draws). Local `waits_on` to `done`/`na` steps are
  satisfied (`rowWaits` drops them); GitHub edges follow the OPEN issue, so a `done` row whose
  issue is still open can still be waited on, as a button to that step. An `na` row is never
  a node. An issue no drawn row links
  is `{ kind: 'issue' }` with its slice-1 activity label (`IssueWaitEntry.activity`, additive);
  it is never turned into an edge to another plan. `partOf` is the step's parent where it
  differs from the plan's certain issue; `outside` is the plan issue's children that no row
  (any status) links; `circular` is a GitHub `cycle` on the step's issue or membership of a
  raw `waits_on` cycle (refused by the store, renderable from an older writer). `result`
  stays `outcome`/`next_after` text: prose, `impact` and row order never create an edge.
  `public/source.js` draws it (`missionDepsHtml`, `missionOutsideHtml`): steps are real
  `<button class="mission-step-link" data-mission-step>` named "Waits on step AHP adapter
  (#119)" / "Unblocks step …"; external issues are `nodeChipHtml` chips plus `activityHtml`;
  `.mission-edge-waits` (dashed accent) and `.mission-edge-contains` (thin solid rail) never
  share a rule; no danger tone, blocked mark or the word. In `app.js` a step button's click
  is the ONLY caller of `focusMissionStep`, which focuses the target's Open details control
  with `preventScroll` and reveals its node through `revealControl` (hoisted, unchanged, from
  `keyboard-ui.js`) inside the flow panel only; passive restoration (`captureMissionFocus` /
  `restoreMissionFocus`) is unchanged and never reveals, and a background window restores
  nothing. An activity label goes through `bindIssueActivity` → `openIssueActivity`, which
  closes the flow before `focusItem`. The fold is `details[data-context-key="mission-outside:<plan>"]`,
  bound through `bindContextDisclosures`, so a poll keeps it open. Pinned by
  `test/mission.test.ts`, `test/source.test.ts`, `test/dom/mission-map.test.ts`,
  `test/dom/mission-focus.test.ts` and `test/dom/issue-attention.test.ts` (the flow open adds
  nothing to any attention surface).
- **Grouping plans by parent issue is opt-in and only reorders (issue #103, slice 2 §7).**
  Off by default. `agent-inbox-group-plans` in localStorage is a saved preference seeded
  on every load, like Default sort order (#221), because it never hides anything; Settings
  → Plans saves it, and the Plans header's "Group by parent issue" switch (a labelled
  `role="switch"` checkbox) changes only the current view. Both repaint through
  `forceRender()`; there is no third render entry. `planGroups` (`public/issues.js`, pure)
  reads the frame's `issueView` and `linkIndex`: a group is two or more ACTIVE plans keyed
  by `(project, parent key)`, so projects never merge even in the all-projects view; a
  plan's issue is its `certain` `issueKeyFor` identity and its parent the last trail
  node of a `fresh` or `stale` relation. Every other state (hidden, no-hierarchy,
  unavailable, uncertain, cut by the node cap, no `/api/issues`) leaves the plan flat in
  its place, so grouping with no graph is exactly today's list. A plan whose own issue is
  the parent leads as the umbrella; members follow GitHub's child order where the
  parent's own list was fetched, else today's order. The group sits at its first
  member's place; `paginateWithPending` pages the flattened list and a page that opens
  inside a group repeats its `<h3>` header with "(continued)". Lingering and archived
  plans are never grouped. While grouping is on, `rowParentRuns` marks runs of a plan's
  linked rows with "Part of #117" header rows when they span two parents, without
  reordering. Such a header can be a plan table's first row, and a compact
  (`table-layout: fixed`) table sizes its columns from its first row unless `<col>`s say
  otherwise, so the matrix carries a five-column `<colgroup>` and the compact widths live
  on it (pinned in `test/editorial-shell.test.ts`; jsdom cannot lay out tables). Header text goes through `planGroupHeadHtml`/`rowParentHeadHtml` in
  `public/source.js` (`esc()`, `chipHtml()`, `tone-issue`/`tone-stale` only). No grouping
  value reaches `public/attention.js`, `relay.js`, `reply-watch.cjs`, a badge, a count
  or the dock (`test/dom/issue-attention.test.ts` pins both); the DOM half, including
  the press guard and a draft surviving a grouping change, is
  `test/dom/plan-grouping.test.ts`.
