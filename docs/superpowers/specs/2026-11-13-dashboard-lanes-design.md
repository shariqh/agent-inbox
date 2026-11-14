# Design: the Dashboard as attention lanes

Status: direction picked by the owner on 2026-11-13 (mockup A, "Attention lanes"). Nothing is
built yet. Mockups were shared with the owner separately and are not committed.

## §0 Summary

With a dozen sessions open, the Dashboard is hard to read. The owner said the sections sit too
close together, the headers are too small, and it is hard to tell what is going on. This design
rebuilds the Dashboard as stacked **lanes**, read top to bottom:

1. **Needs you**: one card per ask, the same asks as the Inbox. A click opens the ask in the
   Inbox's detail panel.
2. **Working**: one card per session with live work, grouped by project.
3. **Quiet**: one row per idle or parked session, in a compact table, with the folds for ended,
   dormant and closed sessions at its end.
4. **Plans in progress**: plans with open rows, with progress.
5. **Just landed**: recent outcomes, as today.
6. **Today**: the activity ribbon, as today, moved to the bottom.

Lane headers are about twice body size, lanes are separated by real space, and type and spacing
come from a small set of tokens. A new desktop window opens wide enough for the wide layout.

It reads nothing new. The attention set, the Inbox's detail panel, the session panel, the driver
and the §9 switch-off contract do not change.

## §1 What is wrong today

From a read of the code at 7d6f2b4:

- **Asks don't rise.** A session that starts asking keeps its place, because the Agents card pins
  card order between forced paints (`agents-home.js:518-522`, `pinLaneOrder` in `lanes.js`). The
  pin exists so cards don't move under the pointer; the cost is that an ask can sit below the
  fold.
- **Headers are body size.** The Dashboard card `h2` is 14px (`style.css:1782`), group heads are
  11px, and the Now strip's labels are 12px. `style.css` has no type tokens: `font-size` appears
  386 times with about 24 distinct values, many of them half pixels.
- **No spacing tiers.** The grid gap is 14px, card padding is 17px and head margins are 14px, so
  regions run together. The only spacing token is `--gap: 16px`.
- **The wide layout never shows by default.** The desktop window opens at 1100 × 850
  (`electron/main.cjs:1016`), below the 1280px breakpoint, and no size is remembered.
- **The Agents header is crowded.** It holds the title, a count, five filters, Later, Review
  queue, group-by and New session in one row.
- **Three count surfaces.** The sidebar, the Now strip and the Agents filters each count
  sessions or asks, with different meanings.
- **The session panel covers the cards.** At 1280px and wider it is an absolute sheet over the
  grid.

## §2 Goals, non-goals

Goals:

1. One glance answers what needs me, what is running and what is quiet, in that order.
2. A session or ask shows in the lane that matches its state on the next paint.
3. Clear hierarchy: lane headers well above body size, and real space between lanes.
4. A new window shows the wide layout.

Non-goals:

- No change to the attention predicate, the badge or alerts. Dashboard data still never enters
  them.
- No new reads or server APIs.
- No change to the Inbox's detail panel or its response controls.
- The other views (Inbox, Plans, Notes, History) adopt the tokens later, in their own PRs.
- Resuming old chats (a chat directory) is a separate design. The Quiet lane leaves it room.

Anti-goals: a second place that answers an ask; cards that move while the pointer is on them;
counts that disappear at narrow widths.

## §3 The lanes

### 3.1 Page head

The Dashboard's title, then one row of lane chips: **Needs you N**, **Working N**, **Quiet N**.
A chip is a button that scrolls to its lane and moves focus to its first card; it does not
filter. The chips replace the Now strip, so each lane is counted once on the Dashboard. A lane's
chip shows 0 when it is empty. **New session** moves here, at the right end. The project and agent
lens and the sidebar counts stay as they are.

Keyboard: Tab reaches the chips, then each lane. Inside a lane, J/K and the arrow keys move
between cards with one roving tab stop, as the Agents card does today, and Enter opens the card.
G I still opens the Inbox.

### 3.2 Needs you

- **Entries.** `waitingEntries` (the dashboard model's name for `attentionEntries`, the Inbox's
  set) under the Dashboard's lens, in `sortRail` order: asks whose agent is waiting come first,
  oldest first. With All projects the count equals the Inbox badge. The
  11-04 amendment's invariant, that every attention entry shows exactly once, moves from the
  session cards to this lane.
- **Card.** Project dot and name, agent kind, branch, age, the ask's title at 17px, and its
  `next_step`. A blocked plan row also names its plan. Option labels are not buttons: the card
  does not answer in one click (owner decision 1, 2026-11-04).
- **Click or Enter** switches to the Inbox tab with that ask open in its detail panel
  (`openAskInInbox`), exactly as a click on an Inbox row opens it. The owner asked for this. The
  panel is not mounted on the Dashboard: DESIGN.md allows one action card per ask, under its
  Inbox row. When the panel was opened from the Dashboard, Esc or its close control switches back
  to the Dashboard, scrolled where it was and with focus on the card. Answering leaves you in the
  Inbox.
- **Header.** "Later N ›" (shown only when N > 0, as today) and "Review queue" move here from the
  Agents header. Both stay in the header when the lane is empty and wrap under the title below
  620px.
- **Empty.** "Nothing in this view is waiting on you." The lane stays, so the layout doesn't jump.

### 3.3 Working

- **Entries.** Session cards whose base state is working (`isWorking`, or the host-turn path
  `isBusy`), from `sessionCards` as today.
- **Grouping.** By project, with a project head (dot, name, count). Group-by goes; the agent kind
  is on each card.
- **Order.** Within a project, `pinLaneOrder` keeps cards still between forced paints. A move
  between lanes is never held back, so a session that starts or stops working changes lane on
  the next paint. Held pointers and drafts still defer the rebuild, as the 10-22 constraints
  require.
- **Card.** What the session is doing at 15px, up to two lines; one meta line with the state
  dot, agent, branch and time since its last call; subagents and plan progress when present. If
  the session also has open asks, a pink "Asking you · N" chip scrolls to them in Needs you. The
  main action is **Open** (the session panel); **Message** stays where it is today.
- **Columns.** Three at 1440px, two at 1280px, one below 900px, as the 11-04 V4 cleanup set.

### 3.4 Quiet

- **Entries.** Every other live card in the main place: idle, quiet and parked sessions. A
  session with open asks carries the same "Asking you · N" chip as in Working. The ask itself
  shows only in Needs you.
- **Table.** Columns: state, session (project and agent), branch, last caption, since, and the
  state's main action (Open in Terminal, Resume, or Open). Under 620px each row becomes two
  lines.
- **Folds** at its end, unchanged in rule: Ended (N) with Earlier sessions inside, Dormant (N),
  Closed projects (N) and Not delivered (N).
- **Ask-only cards go.** Their asks are in Needs you, which is where the 11-04 amendment wanted
  them to be visible.

### 3.5 Plans in progress, Just landed, Today

- **Plans in progress.** One row per active plan with open rows in the lens: title, a progress
  bar (done of countable), blocked count in pink, and the last update. Up to six, then "All
  plans ›", which opens Plans. It reads `lastData.boards`, already loaded.
- **Just landed.** Unchanged except for the header and spacing tokens.
- **Today.** The activity ribbon, unchanged, last on the page.

### 3.6 The session panel

At 1280px and wider the panel opens beside the lanes as a split, so the lanes narrow instead of
being covered. Below 1280px it opens inline under its card, as today. Its contents do not change.

## §4 Type and spacing tokens

Added to `:root` in `style.css`. The Dashboard uses them first; other views move to them in later
PRs. Values come from mockup A.

| Token | Value | Use |
|---|---|---|
| `--fs-meta` | 12px | meta lines, table headers |
| `--fs-body` | 13px | body text, table rows |
| `--fs-lead` | 15px | what a session is doing, plan titles |
| `--fs-title` | 17px | an ask's title, group heads |
| `--fs-lane` | 28px (24px compact) | lane headers |
| `--sp-1` … `--sp-7` | 4, 8, 12, 16, 20, 28, 56px | gaps and padding |

| `--lane-gap` | 56px (40px under 900px) | space between lanes |

Lane headers use `--fs-lane` at weight 650, `--sp-5` above their cards. Cards in a lane are
`--sp-3` apart.

## §5 Window

The desktop window opens at 1440 × 900, clamped to the display's work area, so the wide layout
shows on most screens. Remembering the size and position is out of scope.

## §6 What this replaces from earlier designs

| Earlier decision | Now |
|---|---|
| 11-04 amendment: no Dashboard rail; every ask on a session card | Asks are a lane again; session cards carry only a chip |
| 11-04 A.2: the card's ask strip opens the session panel at the ask; `jumpToAsk` opens the panel | Asks open the Inbox's detail panel; `jumpToAsk` calls `openAskInInbox` |
| 11-04 ask-only cards (Session ended, No session) | Gone; those asks show in Needs you with "session ended" or "no session" in the meta line |
| 11-04 §3.1 one Agents card with filters and group-by | Working and Quiet lanes; no filters or group-by |
| Now strip (Working, Waiting on you, Plan steps, Recorded outcomes) | Lane chips in the page head |
| 10-22 §10 pinned order across the whole Agents card | Pinned within a lane only |

The session panel's Asking you section stays, so you can answer while reading that session's
transcript. It mounts the Inbox's `answerEl` and `rowAnswerEl`, so there is still one answering
implementation; the Needs you lane itself never answers.

## §7 Build order

Each PR leaves the app working. Public merges are approved by the owner. `DESIGN.md` changes
land with the PR that builds them, so it never describes a layout that doesn't exist yet.

| PR | Content |
|---|---|
| 1 | This spec |
| 2 | §4 tokens, applied to the Dashboard's existing headers and gaps; §5 window size; `DESIGN.md` typography |
| 3 | Needs you lane (§3.2) and the page head chips (§3.1); `jumpToAsk` to the Inbox panel; Esc returns |
| 4 | Working and Quiet lanes (§3.3, §3.4) from the Agents card; Now strip, filters, group-by and ask-only cards removed; `DESIGN.md` Dashboard and responsive sections |
| 5 | Session panel as a split at 1280px and wider (§3.6) |
| 6 | Plans in progress (§3.5); ribbon moved last |

## §8 Tests

- **Kept as invariants.** With All projects, Needs you's count equals the Inbox badge, each entry
  once (port the parity fixtures in `test/sessions.test.ts` to the lane). Every live card is in
  exactly one of Working, Quiet or a fold. Held pointers, drafts and text selections survive a
  poll. Two render entries. With the §9 switch off, reads are byte-identical.
- **Changed.** `test/dom/agents-home.test.ts` (filters, group-by), `test/dom/agents-asks.test.ts`
  (counts and opening move to the lane; answering from the session panel stays),
  `test/dom/dashboard.test.ts` (Now strip), `test/dom/dashboard-cards.test.ts` (pinned order per
  lane), `test/dom/dashboard-focus.test.ts` (split at 1280px), `test/editorial-shell.test.ts`
  (CSS source checks for `.dash-focus` and `.ah-cards`), `test/motion-css.test.ts` (selectors).
- **New.** A session that starts asking gains its chip and its ask appears in Needs you on the
  next paint. A click on a Needs you card opens the Inbox panel at that ask, and Esc returns to
  the Dashboard. The window's default bounds clamp to a small work area.
- **Docs.** `docs/architecture/viewer-dashboard-and-shell.md`, `attention-and-later.md` (Later's
  entry point), `electron-app.md` (window size) and `CHANGELOG.md`.
