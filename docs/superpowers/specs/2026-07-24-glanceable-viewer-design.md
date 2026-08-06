# Design: the glanceable viewer (Track B)

**Date:** 2026-07-24
**Status:** implemented; Direction A editorial refresh and adjustable panes implemented
**Predecessor:** [Track A — the agent-emit contract](2026-07-24-agent-emit-contract-design.md)
**Mockups:** `.superpowers/brainstorm/8044-1784928261/content/` (card, layout, shell, detail-card, final-beats)

## Problem

The inbox "is becoming a bunch of words" and losing the seeable / actionable / understandable
value it was built for. Track A fixed what agents *emit*. This fixes what the viewer *shows*.

Concretely, in today's viewer: seven stacked collapsible sections with "Needs you" third down;
three heading levels (section → project → agent) before you reach a card; cards that stack five
near-identical `opacity:.8` prose blocks; urgency encoded only in a 3px left stripe; and
`flag.context` double-collapsed where nobody finds it.

## Governing tenets

1. **Async and ignorable.** The app runs on the human's schedule. They may land on the
   decisions, glance, and walk away having done nothing. No forced triage, no flow that
   auto-opens, no state that punishes ignoring it. Guided one-at-a-time triage is **opt-in
   only** (a button), never a default view.
   *Refined by the owner:* being **told** is fine — being **forced to come back and act** is
   not. Per-item native notifications stay (see §11); nothing may *demand* a response.
2. **The badge must stay trustworthy.** It is the primary ambient signal. A count that can
   only grow, or that counts things nobody is waiting on, is worse than no count at all. This
   tenet outranks completeness: when in doubt, a thing does *not* enter the attention set.
3. **One attention set, defined once.** The dock badge, the rail per-project badges, the
   Needs-you tab count, and the triage deck all derive from a single predicate. Three
   counters that disagree destroy tenet 2.
4. **Ranked, not uniform.** Title dominant; everything explanatory demoted or hidden until
   asked for.

## Architecture: a pure front-end rewrite (plus one additive store column)

The audit confirmed the existing API already returns a **superset** of what the new shell
needs — `/api/items` exposes `options`, `context`, `created_at`, `reply`, `reply_seen_at`;
`/api/boards` exposes rows, statuses, `annotation_unseen`, and precomputed `progress`;
`/api/activity` exposes project + session. Per-project counts, project colors, age chips, the
star's reply call, and the boards matrix are all computable client-side.

**No new endpoints.** The only backend change is the additive `items.session` column required
by §6 (liveness).

## Editorial refresh

The post-implementation visual review selected **Direction A: Editorial desk**. It changes
presentation and vocabulary only; attention, storage, routes, statuses, polling, and write
semantics remain unchanged.

- Light-first warm canvas (`#f7f4ef`), white surfaces, deep rose accent, Segoe UI/Aptos-style
  typography, subtle borders, and minimal shadows. No gradients, glow, or AI-blue/purple visual
  language.
- Human navigation reads **Inbox · Plans · Notes · History**. Supporting workflows read
  **Review queue · Handoffs · Plan flow**. Stored/API terms remain `needsYou`, `boards`, `done`,
  `blocked`, triage, relay, and mission where those names are implementation contracts.
- Ownership reads **Decision · To do · Ready after approval**. A `blocked` row reads **Needs
  input** in the human UI; the stored status and agent-facing vocabulary do not change.
- The content tabs and project rail share one fixed library sidebar. The work area gets a quiet
  editorial heading and utility bar instead of a dashboard header.
- At 1280px and wider an expanded queue card is visually positioned as a 520px right-side
  inspector, but remains nested inside its `.nrow`. The 220px project library and item inspector
  are independently resizable; their widths persist per browser profile. Below 1280px the card
  returns inline and the splitters disappear. This preserves single-open state, deep links, focus
  movement, drafts, and the 3-second poll gate without a second renderer or DOM portal.

## 1. Shell

Replaces the 7-section stack and legacy outline sidebar.

- **Library sidebar.** Content navigation (`Inbox` · `Plans` · `Notes` · `History`) sits above
  projects in one fixed left library. Project tabs retain color dot · name · attention count.
  An **All** pseudo-project pins to the top; **`unknown`** pins to the bottom in neutral grey
  with a tooltip explaining inference failed and `register()` fixes it. Projects with zero
  attention dim. The rail scrolls independently; above ~12 projects it gets its own filter box.
  Selected project uses a restrained surface treatment; project color remains a small identity
  dot, never a page wash.
- **Live is NOT a tab — it is an always-visible footer strip** (revised 2026-07-24, see §16).
  Everything behind a tab is something you *act on*; Live is context you *glance at*. Behind a
  tab you would never see it — you would have to go looking, which defeats presence entirely.
  This finishes the thought the original design started when it gave Live a presence dot rather
  than a count: numbers are reserved for things that want you.
- **Work header.** Editorial page kicker/title · demoted `agent: all ▾` dropdown · global search.
  **Settings** lives at the foot of the library sidebar.
- **Cold-launch state.** Always land on **Inbox · All projects · all agents · All
  actions**, with no card expanded. Project and agent filters last only for the current
  window; persisting them across launches can make a global badge of five reopen onto a list
  of one, which contradicts the product's cross-project attention promise. An explicit
  notification/URL deep link still scopes to and opens its target.

## 2. Project colors

Derived deterministically from the project name (hash → palette), zero-config.

- Generated in **OKLCH at fixed lightness/chroma per theme**, so every hue is legible in light
  and dark.
- **The red/amber/orange band is excluded** — those hues are reserved for state (blocked,
  urgency). A project must never look like an alarm.
- **Color is never the only carrier.** In the All view each row shows a short project label
  beside the dot. Verified against deuteranopia.
- First-seen assignment persists in localStorage so a hash collision can be nudged, with a
  manual override.

## 3. The Needs-you list: two-line compact rows

Each row is **two lines**:

- **Line 1:** project color dot · title (ellipsized) · urgency chip (§6) · ★ button (§5) · chevron
- **Line 2:** dimmed, ellipsized — the item's one-line `detail` (or the recommended option's
  detail when present); `stream` appended when a project has more than one.

Line 2 exists because Track A specifically paid to make `detail` a single glanceable line, and
because it is the precondition that makes one-tap defensible (§5) — you accept what you just read.

**Sort order** (stable within a render session; no continuous re-sorting under the poll):
1. Blocked board rows
2. Unanswered questions — *waiting* (live agent) before *parked*, each oldest-first
3. Answered-awaiting-pickup, dimmed, at the foot
4. A single quiet **"N new notes"** chip at the very bottom (§8)

**Dismiss** is a hover/focus-revealed affordance on the row itself with the same staged-undo as
the star, plus keyboard `x` — dismissing noise must not cost an expansion. **Resolve stays
inside the card**: it implies you did something.

## 4. Click a row → the shared card

Single-open, dismissible, ephemeral (not persisted across reload, but **must survive the 3s poll
rebuild** — see §10). The card stays nested inside the row in the DOM. CSS presents it as the
right-side inspector on wide screens and inline beneath its row on narrow screens.

The expanded card is **the same component the triage lightbox renders** — one component, two
entry points. (This is already nearly true: the lightbox mounts `itemEl` today.) It contains:

meta line (project dot · agent · liveness/age) → big title → one-line detail → **a labeled
`CONTEXT` block** → all option pills (recommended first) → free-text answer + the optional
`reply_context` input → Resolve / Dismiss / Note.

**This is where `flag.context` finally lives** — implicit until you open the item, then
obvious. It is no longer a nested `<details>` inside a collapsed card.

## 5. The safe ★ (one-tap accept)

One tap on the row sends the agent's recommended option as the reply. It needs **no new
endpoint** — `POST /api/items/:id/reply` with the option label is exactly what the option pill
already does. Three hard gates make it defensible:

1. **Renders only when exactly one option has `recommended === true`.** Zero → no star. Two or
   more → no star, plus a small "2 recommended" warning inside the card (the store does not
   validate this). Absence of a star must read as neutral — it is a property of the flag, not a
   judgment about the item.
2. **The row shows what you're accepting** (line 2, §3). No star when that detail exceeds the
   one-line budget.
3. **Staged send with undo.** Tapping flips the row to `Sent: <label> — Undo` for **5 seconds**;
   the POST fires after the timer, or immediately on tab blur/close. Undo within the window
   cancels it outright. Once `reply_seen_at` is set, undo is **refused with an explanation**
   ("Picked up 2m ago — answering again will not un-do it"), because it cannot win that race.

A one-tap reply still attaches any drafted `reply_context`, matching `sendReply` today.

**Replying does not resolve.** An answered item leaves the active list and lands in the dimmed
*awaiting agent* group at the foot until the agent picks it up.

## 6. Liveness: "waiting" vs "parked" (the trustworthy badge)

**The problem this solves:** sessions expire after ~15 minutes of silence, so a three-day-old
question is almost always addressed to a dead process — yet a raw-age chip paints it maximum
red forever. A badge that screams about things nobody is waiting on stops meaning anything, and
that — not nagging — is the failure mode that kills this product.

**Store change (additive, TDD-able):** items record the **session id** that created them
(`ensureColumn`-style migration, mirroring existing additive columns). This is the only backend
work in Track B.

**Three states**, replacing the raw age ramp:

| State | Meaning | Treatment |
|---|---|---|
| **Waiting** | The asking session is still live (present in `/api/activity`) — an agent is blocked on you *right now* | The only genuinely "hot" state; warm→hot ramp by age; **counts** in the attention set |
| **Parked** | No live session — answer whenever; the reply lands when the agent next polls | Neutral chip, no color pressure; **counts**, but never escalates |
| **Stale** | No live session **and** created more than **72 hours** ago | Demoted into a collapsed *"stale — decide later"* fold; **does not count** toward the badge |

Age chips and the Live view's freshness dots must read as **one system**, not two competing
color-coded time scales.

## 7. The attention set (one predicate, used everywhere)

```
attention = (questions where !reply)  ∪  (board rows where blocked && !(annotation && !annotation_unseen))
          − (items in the stale fold)
```

Nothing else. **Not** notes, **not** milestones, **not** answered-awaiting-pickup.

**Bug fixed here:** today's predicate (`app.js:139`) counts *every* blocked row, including ones
the human already annotated — so the badge can never return to zero. That is precisely the nag
the owner is designing against.

**Blocked board rows appear in both places:** as compact rows in Needs-you (with a board glyph
and a link into the board) *and* tinted in the Boards tab. The count lives in one place.
Their "Answer" is **not** literally one-tap — board rows have no `options`, only free-text
annotation — so it expands inline into the same card with a single-line input (replacing the
`window.prompt` path).

**Filter-blindness invariant (written down so it stops getting lost):** the rail makes filtering
the primary navigation, which recreates the exact bug today's code fights with an explicit
comment (`app.js:130-132`) — attention hidden behind a filter. Therefore: **the dock badge and
the Needs-you tab count are always global**, with the rail-scoped count shown separately on each
rail tab. Selecting a project narrows the *list*, never the *global signal*.

**Rail badge color:** neutral/accent for a normal open count; **red reserved** for the escalated
subset — blocked rows, or *waiting* items (live agent blocked) older than **1 hour**. A rail of
all-red badges is a rail of no information.

## 8. Notes: read-state and expiry

Behind a tab, non-blocking notes would become write-only, and their count would grow forever —
poisoning the number vocabulary (tenet 2).

- Notes get a **read state**; the tab count means *"new since you last looked"*, not "all notes ever".
- Unread notes surface as **one quiet chip at the foot of the Needs-you list** — seen in the flow
  the user actually opens, without entering the attention set.
- Notes older than **7 days** auto-age into Done.

## 9. Boards tab

- Board card: color dot · title · progress bar with **`done/countable` primary, % secondary** · rows.
- Rows as a real matrix: **large status glyph in its own narrow column**, bold label column,
  one-line note column. Long note context only on row click.
- Blocked rows tint red and carry an **Answer** affordance (§7).
- **Archived boards** fold in behind a `show archived (N)` toggle — un-archive is the only undo
  for Archive and must not be lost.
- The "hide completed rows" flag survives; the global pill strip that set it does not — the
  toggle moves into the Boards tab header.
- Auto-archived (100%) boards linger as a "completed — archived" card for the session rather
  than vanishing.

## 10. The poll is a prerequisite, not a detail

`app.js` already carries ~11 separate pieces of module-level/localStorage state whose only job is
surviving the 3-second full-DOM rebuild. Inline expansion, staged sends, and per-tab paging on
top of that will eat someone's half-typed answer.

**Rule:** the re-render is **suspended** only while a draft input is non-empty, resuming when
the draft is cleared — with a quiet "paused — updating when you're done" hint. A merely expanded
card remains open across live refreshes, so it cannot hide newly arrived work. Sort order pins per
render session, genuinely new work appends at the foot, and the bounded pointer press guard
prevents a rebuild from eating a click. Hover alone never delays an arrival.

The existing techniques that must carry over: the `dataset.sig` no-op-rebuild trick, draft/focus
preservation, `x-inbox-boot` reload, and pruning open-state against **all** cards rather than the
filtered view (or switching projects nukes state).

## 11. Notifications and the badge

**Owner's call: per-item native notifications stay.** The Electron main process already fires
one per new item. This is compatible with tenet 1 as refined: being *told* is fine; being
*forced to act* is not. Notifications must therefore remain purely informational — no action
buttons that imply obligation, and clicking one only opens the app.

**The badge** (the primary ambient signal) is the §7 attention set, rendered as:
- Electron: dock badge count.
- Browser: `document.title` prefix (`(3) Agent Inbox`) — none of this exists today.

**Notification click → `focusItem(id)`:** selects that item's project, switches to the right tab,
expands the row, scrolls to it. A URL hash makes such links survive reload.

## 12. Search across tabs

With content behind tabs, scoped search produces **confident false negatives** — the worst
possible failure for a triage tool.

**Rule: never render a bare "no matches" while matches exist behind another tab.** A query shows
**per-tab match counts** on every tab and per-project counts on the rail. The query persists
across tab and project changes.

## 13. Keyboard and accessibility

- `j`/`k` move · `Enter` expand · `1`–`4` pick option N · `x` dismiss · `e` resolve · `/` search ·
  `Esc` collapse. **Accepting a recommendation by keyboard costs the same as reading it.**
- Rail and tabs are proper `tablist`/`tab` roles with roving focus; focus is managed on inline
  expand and returned on collapse.
- The two desktop pane handles are focusable vertical separators. Arrow keys resize in the
  visual direction, Shift increases the step, Home/End choose the minimum/maximum, and a
  double-click restores the default. ARIA min/max/current values track the effective width.
- The star's accessible name reads **"Answer: `<option label>`"**.
- Every color-coded state also carries a glyph or text. Contrast verified in both themes.

## 14. Responsive

At **1280px and wider**, the library, queue, and inspector form the desktop split view. Defaults
are 220px for the library and 520px for the inspector. `public/panes.js` clamps the library to
180–320px and the inspector to 360–720px while preserving at least 400px for the queue, including
after a window resize. Effective widths are exposed through CSS variables and separator ARIA;
preferences persist as `agent-inbox-sidebar-width` and `agent-inbox-inspector-width`.

Below 1280px the fixed library becomes a compact two-tier sticky masthead. Brand, library
navigation, and Settings share its first row; a labelled, horizontally scrollable project strip
uses readable slug labels, project colors, and inline counts on the second. Below 620px only the
library counts hide so all four destinations remain visible. The page heading and agent/search
tools share a fluid row until their preferred widths require a wrap. The expanded inspector
returns to a full-width inline card. Plan rows use fixed columns and ellipsized labels so their
action affordance cannot leave the viewport; the full note remains in the row panel. Lane- and
graph-shaped overlays retain horizontal touch scrolling rather than collapsing their meaning
into a different mobile component. The stylesheet keeps exactly one `@media` block at EOF so the
responsive layer wins the cascade predictably.

## 15. Preserved / dropped

**Preserved** (deliberately, because the audit flagged each as a real capability):
answered-awaiting-pickup handshake and its pickup marker · blocked-row escalation · filter-blind
global attention · global fuzzy search across everything · expand state surviving the poll ·
archived boards + un-archive · Setup · reply_context · item and board-row annotations with the
unseen marker · per-section counts · the triage deck and its keyboard nav · Live richness
(idle fold, subagent children, freshness dots) · connection status + boot-id auto-reload ·
pagination caps · multi-agent attribution (now a row-level chip, not an `h4` level).

**Dropped** (consciously): legacy outline-sidebar sub-links · section collapse persistence / user-composed
multi-section dashboard · project and agent heading levels · the kind-based left stripe ·
`jumpToCard`'s filter-clearing fallback (with a rail it would silently reset the user's project).

**Note:** `paginateGroups` stays exported and tested even though the viewer stops calling it —
`test/search.test.ts` imports it. Retiring it is a separate, deliberate decision.

## 16. The Live footer strip (revised 2026-07-24)

Replaces the Live tab. Added after the redesign went live and the tab proved to be the wrong
container: Live is ambient presence, and a tab is a place you must decide to visit.

**Collapsed — always visible, ~28px, pinned to the footer:** a freshness dot, a count, and the
running sessions as `project/agent`, e.g. `🟢 2 working · oris/claude-code · agent-inbox/claude-code`.
Freshness dots keep the existing thresholds (fresh <60s, aging <5m, quiet beyond) — the same
scale the rows use, per §6. One system, not two.

**Idle:** the strip **stays**, dimmed, reading `no agents running`. It never disappears — an
element that vanishes teaches you to wonder whether it broke, and a fixed location is what makes
a glance cheap.

**Expanded — click, or Enter/Space when focused:** a **drawer rises over** the bottom of the
content, which stays put behind it. Nothing reflows, so the list never moves under the cursor
(the §10 concern) and scroll position survives. Dismiss by clicking the strip again, or `Esc`.
Contents are today's Live richness, unchanged: per-session `doing`, the detail line, the nested
subagent `children` table, and the idle-sessions fold.

**Expansion state persists across the 3s poll** — reuse the existing `openLive` state rather
than inventing a second mechanism.

**It must never demand attention.** No count that reads as a to-do, no colour that reads as an
alarm, never steals focus, never auto-expands. It is glass, not a prompt (tenet 1).

**Accessibility:** the strip is a real `button` with `aria-expanded`, keyboard reachable, and the
drawer is focus-managed, returning focus to the strip on collapse (§13).

## 17. Non-goals

Menu-bar app · phone/remote (#8) · answer-in-place chat convergence (#29) · the forgotten-flag
hook backstop (#10) · close/reopen projects (#4 / C1 — the rail is designed to receive it, but it
is its own track) · diff-based rendering or SSE to replace polling (§10 suspends instead) ·
adding `options` to board rows (would touch mcp.ts, store.ts, and the snippet).

## Testing

- **Pure functions get real tests** (repo is strict TDD): the attention predicate (§7, including
  the annotated-blocked-row regression), the project color hash (determinism, red-band exclusion),
  liveness classification (§6), sort order (§3), and the star's gating rules (§5).
- **The store change** (items.session) gets store-level tests against a real temp SQLite DB, per
  repo convention, plus an MCP round-trip assertion that a flagged item records its session.
- **Staged-send/undo** logic is extracted pure (timer injected) and unit-tested, including
  "undo refused after `reply_seen_at`".
- DOM rendering stays verified by eye against the mockups; `npm run typecheck` and the full suite
  must stay green.

## Rollout

One track, landed behind no flag (v1 is local and single-user), but sequenced: attention
predicate + liveness (with its store column and tests) → shell (rail/tabs/top bar) → Needs-you
rows + inline card → safe star → boards matrix → notes/search/empty state → keyboard/a11y/responsive.
