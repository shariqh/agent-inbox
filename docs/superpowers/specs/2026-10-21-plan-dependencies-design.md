# Design: plan dependencies and opt-in grouping (issue #103, slice 2)

**Date:** 2026-10-21 (revision 1)
**Status:** Draft for review. Four decisions are open (§14).
**Milestone:** v1.5. Part of #103.
**Scope of this PR:** this document only. Zero source or test changes.
**Builds on:** the slice-1 design,
[`2026-10-19-plans-sub-issues-design.md`](2026-10-19-plans-sub-issues-design.md), cited below as
"S1 §n". Slice 1 shipped in v1.4.0 (#229, #230, #234, #239). Every rule it set still holds unless
this document says otherwise.

---

## §0 — Summary

1. **Two dependency sources, both explicit.** GitHub's native "blocked by" / "blocking"
   relationships, read by the viewer's existing issue poller, and a new agent-written row field,
   `waits_on`, naming other rows of the same plan by label. Nothing else creates an edge:
   not `impact`, `next_after`, `outcome`, notes, titles, labels or checklists.
2. **The UI says "waits on" and "unblocks"** (S1 Q2). It never says "Blocked". A row that waits
   on another row or issue is `tracked` or `partial`; `blocked` still means only "the human must
   act".
3. **Ingestion costs nothing extra in calls.** The dependency fields join the existing one-call,
   ten-issue GraphQL document. Measured today on the #117 family: still 1 point per batch,
   7.6 KB → 12.6 KB (§2).
4. **Storage is one new column bound to the snapshot it was fetched with**, the `closing_refs`
   pattern. A v1.4 viewer that refreshes the same issue unbinds it instead of erasing it, so
   mixed versions lose freshness, never correctness.
5. **The pure graph gains `blocks` edges** under S1 §4.6's reconciliation, inside
   `/api/issues` version 1 (additive). `issue_rel` gains `waits_on_issues` and `unblocks`. The MCP
   process still only runs pure code over the cache.
6. **Plans** show neutral "waits on" chips on rows and plans, and a "Dependencies on GitHub"
   section in the source block. **Plan flow** shows, per step, what it waits on and what it
   unblocks, as buttons that move focus to the other step. It keeps the agent's row order.
7. **Opt-in grouping** gathers active plans under their shared GitHub parent issue, keyed by
   `(project, parent)` (S1 Q3). It is off by default, never hides a plan, and falls back to the
   flat list whenever relationship data is missing, stale beyond 7 days or unavailable.
8. **Attention is untouched.** `public/attention.js`, `relay.js`, `reply-watch.cjs` and the
   `?scope=attention` projection stay byte-identical. Tests pin badge, title, tab counts,
   Needs-you and the dock projection identical with and without dependency data.
9. **Six PRs** (§13): GitHub ingestion, graph and `issue_rel`, the `waits_on` row field, Plans
   chips, Plan flow, grouping. Grouping and `waits_on` are independent of GitHub ingestion and
   can land in parallel.
10. **Deferred:** sibling context, search by issue key and title, row-level deep-link hashes
    (S1 §12.4), and any mutation of GitHub (S1 Q4: never).

---

## §1 — What exists today (v1.4)

- **Snapshots.** `issue_snapshots` holds one validated v1 JSON answer per requested
  `owner/name#number`, written only by `completeIssueRefresh` under the attempt rule
  (S1 §4.4). It has no dependency data.
- **Poller.** `src/issue-poller.ts` makes at most one `gh api graphql` call per 60-second tick
  for up to 10 issues, issues first, under a 120-point hourly bucket and a 500-point floor, with
  60-second leases and a fair queue (S1 §5).
- **Graph.** `buildIssueGraph` in `src/issue-graph.ts` is pure and emits only `contains` edges.
  `issueRelations` derives `issue_rel` for a titled `board_get` from the same graph.
- **Viewer.** `public/issues.js` (`buildIssueView`) is rebuilt once per frame in `paintAmbient`.
  It already skips any edge whose `kind` is not `contains`, and the `/api/issues` validator in
  `public/snapshots.js` checks only that each edge has string `from` and `to`. A new edge kind is
  therefore invisible to v1.4 code.
- **Plan flow.** `buildMission(board)` in `public/mission.js` is pure and plan-scoped. Each path
  is one non-`na` row plus its `outcome` or `next_after` text. `renderMission()` in
  `public/app.js` draws it into `#missionbox` and reads no issue data today.
- **Plans.** `renderBoards()` pages active plans with `paginateWithPending`, then lingering
  completed plans, then the archived fold. Plans render in server order.
- **Rows** have stable labels (their identity), a `revision` CAS token and an optional explicit
  issue link (`issue_repo`, `issue_number`). They have no field that names another row.

---

## §2 — GitHub's dependency API (re-verified 2026-10-21)

S1 §2 verified the API on 2026-10-19. Re-checked today with `gh` 2.102.0, read-only:

| Check | Result |
|---|---|
| `Issue.blockedBy`, `Issue.blocking` | `IssueConnection`, arguments `orderBy, after, before, first, last`. `orderBy` takes `CREATED_AT`, `UPDATED_AT` or `COMMENTS`, none of which is a meaningful sequence |
| `Issue.issueDependenciesSummary` | `blockedBy` "Count of issues this issue is blocked by", `totalBlockedBy` "… (open and closed)", and the same pair for `blocking`. So lists can hold closed issues, and the summary separates open from total |
| Limits | 50 issues per relationship type (changelog 2025-08-21), so `first: 50` returns the whole list. `pageInfo.hasNextPage` is still read and treated as truncation |
| #117 family, live | #119 blocks #118 and #120–#125; #120 blocks #121; #121 is blocked by #119 and #120. Both directions agree |
| Cost, 10 roots, live | The shipped document: 1 point, 7,615 bytes. With `issueDependenciesSummary` and both lists (`first: 50`, `...Node`): **1 point, 12,644 bytes** |
| Agents | `gh issue edit --add-blocked-by / --add-blocking / --remove-*` and `gh issue view --json blockedBy,blocking` (GitHub Docs, "Creating issue dependencies") |
| Webhooks | `issue_dependencies` exists but needs a public endpoint. Polling stays the only option (S1 §2.8) |

Not verified live: no issue in this repository has a closed blocker, so "a closed blocker stays
listed" rests on the summary field descriptions. The design does not depend on it: a closed
blocker, listed or not, never counts as something to wait on (§5.3).

---

## §3 — What "dependency" means here

### 3.1 Two sources

| | GitHub dependency | Agent-declared step dependency |
|---|---|---|
| Meaning | Issue A blocks issue B on GitHub | Row B of a plan waits on row A of the same plan |
| Written by | Anyone on GitHub (agents use `gh issue edit`) | The agent, through `board_upsert` / `board_row` `waits_on` |
| Scope | Any two issues, any repositories | One plan |
| Needs an issue link | Yes, on at least one end | No |
| Freshness | Ages with its snapshot (S1 §5.8) | Local, always current |
| Shown as | "waits on #119" (GitHub) | "waits on step AHP adapter" |

Both are needed. GitHub dependencies cover issue-linked work and cross-plan or cross-repository
sequencing, and they are already the source of truth for the #117 family. Many rows have no
issue, though: a rollout checklist, a release's "build", "sign", "publish" steps. For those the
only honest source is the agent saying so. Decision D1 (§14) asks whether to ship both.

### 3.2 What never creates an edge

`impact`, `next_after`, `outcome`, `note`, `context`, titles, labels, issue bodies and
checklists, branch names, PR links, row order, and parent-child containment. A `next_after` of
"after #119 lands" draws no edge, as today. Sub-issue containment is a separate edge kind and is
never read as sequencing.

### 3.3 A dependency is never `blocked`

S1 §8 still holds and now covers both sources:

| Situation | Status the agent sets | What the viewer shows |
|---|---|---|
| The row waits on an open issue or an unfinished step; nothing started | `tracked` | "waits on …" |
| Work started and paused on it | `partial` | "waits on …" |
| The row also needs an independent human action | `blocked` with the action fields | The blocked mark and "waits on …" |
| `blocked` used only because of a dependency | Contract violation; the viewer cannot tell | Both, so the mistake is visible |

The contract sentence from PR2 ("Waiting on another GitHub issue (GitHub's 'blocked by') is
tracked or partial, never blocked.") becomes "Waiting on another GitHub issue (GitHub's 'blocked
by') or on another step (`waits_on`) is tracked or partial, never blocked." It is updated in the
three board tool descriptions, the `status` field's `.describe()` and
`docs/reporting-snippet.md`.

The viewer never derives, suggests or overrides a status from either source. A step whose
blockers are all done does not turn green; its agent changes its status.

---

## §4 — Agent-declared step dependencies (`waits_on`)

### 4.1 Contract

- `board_upsert({ rows: [{ label, …, waits_on?: string[] }] })` and
  `board_row({ …, waits_on?: string[] })`. Each string is the label of another row of the same
  plan.
- **Omission keeps** the stored value; **`[]` clears** it. This is the rule for every
  agent-owned row field (CLAUDE.md "Omission is not deletion — for FIELDS").
- `board_advance` neither accepts nor clears it. It archives the action, not the plan's
  structure, exactly as it keeps the row's issue link.
- A move into `blocked` keeps it.
- A change bumps the row `revision` and `updated_at`, like any content change.
- Titled `board_get` echoes `waits_on` on rows that have one. `pending()` and the title-less
  summary do not carry it.

### 4.2 Validation (refused with an error that says why)

Checked in `src/mcp.ts` for shape and in `src/store.ts` for meaning, inside the same
`.immediate()` transaction that writes:

- At most 20 labels per row, each a non-empty string. Duplicates
  collapse; order is not meaningful and is stored sorted.
- A row may not name itself.
- **Every label written in this call must exist in the plan after the write.** For
  `board_upsert` that is the payload's label set. For `board_row` it is the stored plan read
  inside the transaction.
- **No cycles.** After the write, the plan's resolved `waits_on` edges must be acyclic. The
  error names one cycle (`A → B → A`).

Labels stored earlier are not re-validated on later writes. If a later upsert removes a row,
other rows keep naming it: the reference is **dangling**, it draws nothing, and it revives if a
row with that label returns. This avoids two worse options: refusing routine upserts because an
untouched row names a removed one, or silently rewriting other rows' agent-owned fields (and
their revisions). A revived reference is re-checked for cycles by the write that revives it.

As built (PR C), "written in this call" means **named for the first time**: a label already
stored on that row is not re-checked, so re-sending a dangling label exactly as `board_get`
echoed it is accepted, while a newly named missing label is refused. The cycle rule is applied
the same way: a write is refused when an edge it adds or revives lies on a cycle, and the error
names the shortest cycle through the first such edge in row order. Strongly connected
components are computed once and the path search runs only for that edge, so the check stays
linear while it holds the write lock. Only a raw write can store a cycle (a v1.5 write refuses
one and v1.4 writes no `waits_on`, see §11), and an unrelated write is not refused for it.

### 4.3 Storage

```sql
-- ensureColumn(db, 'board_rows', 'waits_on', 'TEXT')   -- JSON array of labels, NULL = none
```

`BoardRow` gains `waits_on: string[] | null`, parsed and validated on read; an unreadable value
reads as `null` and never throws. `/api/boards` carries it like every other agent-authored row
field. It is not GitHub data, so S1's "`/api/boards` never carries GitHub data" still holds.

### 4.4 Why labels, not row ids

Labels are the row identity agents already keep stable, and the only one they write. A row id
would also break when a row is removed and re-added, and agents would have to read ids back
before naming them.

---

## §5 — GitHub dependencies: ingestion and storage

### 5.1 The query

The `Root` fragment in `src/issue-poller.ts` gains three fields:

```graphql
issueDependenciesSummary { blockedBy totalBlockedBy blocking totalBlocking }
blockedBy(first: 50) { totalCount pageInfo { hasNextPage } nodes { ...Node } }
blocking(first: 50) { totalCount pageInfo { hasNextPage } nodes { ...Node } }
```

Nothing else changes: one document per batch size, aliases from indices, `-f` for strings,
`-F` for validated integers, `--hostname github.com`, the same timeout, buffer, budget, floor,
lease and tick deadlines (S1 §5.2–§5.6). The response grows by about 0.5 KB per root.

### 5.2 Parsing (`parseIssueBatch`, still pure)

- GitHub marks these fields non-null, so an error under them nulls the issue they were asked on.
  They are therefore asked on an alias of their own per issue, `dN` (#264), as the sub-issues
  are on `hN` (#267). Any error under `dN`, or a null or missing `dN.issue`, makes that root's
  **dependencies** `unavailable` and leaves the issue and its hierarchy alone, the same
  per-section rule S1 §5.7 uses for the hierarchy.
- Every listed node is validated like a child (slug, number, state, reason, title clip). An
  invalid node is dropped and the list is marked truncated, so it is never read as evidence of
  absence (S1 §5.7).
- A root listing itself is dropped. Duplicates collapse. Lists cap at 50.
- `truncated` is `pageInfo.hasNextPage` or a dropped node.

### 5.3 The stored section, bound to its snapshot

```sql
-- ensureColumn(db, 'issue_snapshots', 'dependencies', 'TEXT')
```

```json
{
  "v": 1,
  "fetched_at": "2026-10-21T21:00:00.000Z",
  "status": "ok",
  "blocked_by": { "open": 2, "total": 2, "truncated": false,
                  "list": [ { "repo": "shariqh/agent-inbox", "number": 119, "title": "…",
                              "state": "OPEN", "state_reason": null } ] },
  "blocking":   { "open": 0, "total": 0, "truncated": false, "list": [] }
}
```

- `open` and `total` come from `issueDependenciesSummary`; `list` holds the visible issues in key
  order (GitHub's order means nothing here, §2).
- `status: "unavailable"` carries no lists and yields no observations.
- **Binding.** The section is valid only while its `fetched_at` equals the row's `fetched_at`.
  `upsertIssueSnapshot` gains an optional `dependencies` argument and writes it in the same
  statement as the snapshot. Then:

| Writer | Effect on `dependencies` |
|---|---|
| v1.5 success | Written and bound |
| v1.5 or v1.4 hard failure | `snapshot` and `fetched_at` cleared in one statement, so the section is unbound. v1.5 also clears the column |
| Soft failure, any version | `fetched_at` kept, so the section stays bound and ages with the snapshot |
| v1.4 success | Moves `fetched_at` without touching the column, so the section is unbound: "unknown", never "no dependencies" |

- The attempt rule, validation on write and on read, and the 30-day prune are unchanged. The
  v1 hierarchy snapshot keeps its shape, so a v1.4 viewer still reads every row.
- `listIssueSnapshots` returns `dependencies` only when it is valid and bound; otherwise `null`.

Rejected: bumping the snapshot to `v: 2`. A v1.4 viewer would read every v2 row as "no snapshot"
and draw plain chips, and each v1.4 refresh would erase the dependency data rather than unbind it.

### 5.4 The queue

S1 §5.4's order gains one tier and one nudge:

- **Upgrade tier.** A key whose snapshot is readable but whose dependency section is missing or
  unbound is due now, after never-fetched keys and before nudged ones. After an upgrade every
  v1.4 snapshot is in this tier; at 10 per minute a hub with 100 linked issues catches up in
  about 10 minutes.
- **Nudge.** A key is also nudged when a PR whose `certain` closing issue is one of its open
  blockers turns `MERGED` or `CLOSED` after the key's `checked_at`. A dependent then learns its
  blocker closed on the next tick rather than within 10 minutes.
- **Two viewers of different versions** sharing one hub can alternate: the v1.4 viewer's refresh
  unbinds, the v1.5 viewer refetches. Leases stop concurrent fetches, the bucket bounds the cost
  (120 points an hour per viewer), and the UI shows "Dependencies: checking…" for at most one
  tick per key. This goes away once both run v1.5.

### 5.5 Freshness

Dependency data ages with the snapshot it is bound to: fresh under 30 minutes, dimmed with "as
of …" until 7 days, hidden after (S1 §5.8). A hard failure on either end removes the pair at once
(S1 §4.5 rule 6). Agent-declared `waits_on` is local and never ages.

---

## §6 — The graph (pure, `src/issue-graph.ts`)

### 6.1 Reconciliation (S1 §4.6, now specified fully)

- **Observations are about a pair** "A blocks B", keyed `(canonical A, canonical B)`.
  - B's bound, `ok` section lists A in `blocked_by` → positive at B's `t`.
  - A's bound, `ok` section lists B in `blocking` → positive at A's `t`.
  - B's `blocked_by` list is **complete** (not truncated) and omits a known A → negative at
    B's `t`. Likewise for A's complete `blocking` list. "Known" means any issue in any
    observation in this build.
- **Decision.** The newest observation of the pair decides. At equal `t` a negative wins: a
  missing chip degrades to today's view, a false one misleads.
- **Hard failures** (S1 rule 6) drop every observation of a pair whose end failed at a time
  `≥` the observation's `t`.
- **Self-pairs** are dropped. Aliases fold to canonical keys first (S1 rule 8).
- **Cycles are data.** GitHub may allow them. Each strongly connected component of size two or
  more is kept and its edges carry `cycle: true`. Nothing orders by them (§9.2).
- **Facts** from dependency lists are a `LISTED` source under S1 rule 7: an issue's own root
  still wins at equal `t`.
- **Counts** (`open`, `total`) are read only from the issue's own bound section. They are never
  inferred from other roots' lists.
- **Scope.** As in S1 rule 9, only display roots' snapshots are read.

Worked examples (#117 family; t20 newer than t10):

| Observations about "#119 blocks #121" | Result |
|---|---|
| t20 #121 lists #119 in `blocked_by` | Edge |
| t20 #121's complete `blocked_by` omits #119 · t10 #119 lists #121 in `blocking` | No edge: removed since |
| t20 #119 lists #121 · t20 #121's complete list omits #119 | No edge: negative wins at equal `t` |
| t20 #121's list is truncated and omits #119 · t10 #119 lists #121 | Edge: a truncated list is not evidence of absence |
| t20 #121's section is unbound (a v1.4 refresh) · t10 #119 lists #121 | Edge, as of t10 |
| #119 hard-failed at t15 · t10 #121 lists #119 | No edge; #119 unavailable |

*As built (PR B):* `test/issue-graph.test.ts` runs each row of this table. Five details the
rules above leave open:

- A negative needs a positive to matter, so "known" never has to be listed: every pair with a
  positive names two known issues, and a pair with only negatives draws nothing.
- Like a parent's own list (S1 rule 6), the section of a root that failed at or after its `t`
  records no observation and no counts, and its root reports `dependencies: "unknown"`, so
  `issue_rel` omits both fields (review of #271, F1: before, it read "known, none"). The issues
  it lists still keep their facts, as a refused parent's children do.
- Aliases fold the observing root to GitHub's canonical key, as S1 does for a snapshot's own
  issue. Listed issues are already GitHub's canonical answers and are not folded again.
- The section is read whatever the hierarchy's status: GitHub asks for the two on separate
  aliases (`hN`, `dN`), so one failing says nothing about the other.
- Strongly connected components use an iterative, linear Tarjan, a local copy of PR C's
  `waitsOnComponents` in `store.ts`: `issue-graph.ts` imports no value but `issueKey`, and a
  shared module would add a new module to the stdio MCP graph, which §6.4 rules out.

### 6.2 `/api/issues`, still version 1

All additions are optional fields or a new edge kind, which v1.4 code ignores (§1):

```json
{ "kind": "blocks", "from": "shariqh/agent-inbox#119", "to": "shariqh/agent-inbox#121",
  "observed_at": "2026-10-21T21:00:00.000Z" }
```

- Edges gain `kind: "blocks"` (blocker → dependent), with `cycle: true` where §6.1 says so.
  `blocks` edges carry no `position`.
- Nodes gain `deps: { blocked_by_open, blocked_by_total, blocking_open, blocking_total }` only
  when their own bound section is `ok`.
- Roots gain `dependencies: "ok" | "unavailable" | "unknown" | null` (`unknown` = readable
  snapshot, missing or unbound section) and `dependencies_omitted`.
- `truncated` gains `dependencies` (neighbour nodes the cap cut).

*As built (PR B):* edges are `contains` first, in S1's order, then `blocks` by `(from, to)`.
`dependencies_omitted` is a number on every root (0 when nothing was cut), and `truncated.edges`
counts omitted edges of both kinds. `public/snapshots.js` accepts the body unchanged (it checks
only that each edge has string ends and that a root's `hierarchy` is known), and
`public/issues.js` read `contains` edges only, so until PR D the page drew what it drew before,
apart from fresher facts: dependency lists are a new rule 7 source, so a fresher list can update
an issue's title or state and, at the cap, a root's rank. `test/snapshots.test.ts`,
`test/issues.test.ts` and `test/dom/issue-relations.test.ts` pin that the page ignores `blocks`
edges and the new fields.

### 6.3 The node cap

S1 §6's cap stays at 2,000 units and its order is unchanged: rank roots, keep whole roots, fill
children round-robin. Then **fill dependency neighbours** round-robin across kept roots in rank
order, each root's `blocked_by` before its `blocking`, by key. A `blocks` edge is emitted only
when both of its nodes are emitted. Edges are capped at 4,000 (twice the node budget) in the
same deterministic order, and every omission is counted in `truncated`. A root whose neighbours
were cut reports `dependencies_omitted`, and its list says "+N not shown". A full graph at the
cap, with 2,000 nodes carrying 301-character titles, 60-character slugs and counts, all 4,000
edge slots used and 2,000 root entries, is about 2.8 MB (`main` sends 1.66 MB for the same rows).
Longer slugs or alias entries add to that; with this repository's slug and 60-character titles
the same graph is about 1.75 MB (`main`: 0.92 MB). A body is sent only when it changes.
*(Corrected in review of #271: the first draft estimated 1.5 MB.)*

The graph's bytes still depend on the database alone, so `/api/issues` remains a store-token
conditional snapshot (CLAUDE.md "Conditional snapshots must remain authoritative").

*As built (PR B):* the 4,000 bounds every edge of a response, both kinds. `contains` edges come
first and are never cut by it: each node has at most one, so they never take more than half.
`blocks` edges then fill what is left, round-robin across the kept roots in rank order (each
root's blockers, then its dependents, by key), and finally any other edge between two emitted
nodes, by key: an omitted root's node can still be emitted as a kept root's neighbour or child,
and its edges to other emitted nodes count too. A root's `dependencies_omitted` counts its
entries (edges) not emitted, whether a neighbour was cut or the edge budget ran out.

The cap bounds the response, not the work. The build reads every display root's own dependency
section before anything is cut, so its cost grows with the total number of dependency entries
across display roots, about half a microsecond each on a 2024 laptop. Build plus
`JSON.stringify`, best of several runs, for N display roots that each list K issues per direction
(review of #271, F2; titles 301 characters, slugs about 60):

| N × K | `main` (reads no dependencies) | First PR B head | As fixed |
|---|---|---|---|
| 100 × 5 | 0.4 ms | 2.0 ms | 0.7 ms |
| 500 × 5 | 1.4 ms | 11.8 ms | 3.9 ms |
| 2,000 × 5 | 5.7 ms | 52.5 ms | 17.5 ms |
| 2,000 × 50 | 7.1 ms | about 540 ms | about 110 ms |

The fix keeps every per-entry step to a few hash lookups: positives live in maps by their two
ends rather than in concatenated pair ids, nothing sorts them (only the edges the round-robin
leaves, and those emitted, are sorted), accepted pairs are records that nothing re-splits, facts
keep the freshest observation as it arrives, and `issueKey` runs once per repository and number.
The output is byte-identical to the first head's on 55,000 random graphs. Keep it that way: the
viewer rebuilds `/api/issues` after any database write, on Electron's main thread in the
packaged app.

### 6.4 `issue_rel` (agent reads)

`issueRelations` adds two fields when the key's own section is bound, `ok` and not older than 7
days:

```json
{ "key": "shariqh/agent-inbox#121", "parent": "shariqh/agent-inbox#117",
  "children": { "total": 0, "done": 0 },
  "waits_on_issues": ["shariqh/agent-inbox#119", "shariqh/agent-inbox#120"],
  "unblocks": 0,
  "checked_at": "2026-10-21T21:00:00.000Z", "stale": false, "unavailable": false }
```

- `waits_on_issues`: keys of **open** blockers that reconciled to an edge, sorted, at most 50.
  Keys only, never titles (#42's payload diet). Named apart from the row's own `waits_on` (PR C),
  which a titled read echoes on the same row object: these are read-only GitHub issue keys, never
  step labels to copy into `waits_on`, and never a reason to mark a row `blocked` (revision
  history, PR B).
- `unblocks`: the count of open dependents in the reconciled graph.
- Both are omitted when nothing is known, so an agent never reads "no dependencies" from missing
  data. The `board_get` description gains the two names.

The MCP process gains no new module: it already imports `issue-graph.ts` and `issue-key.js`, and
`test/issue-graph.test.ts` keeps pinning the stdio import graph.

*As built (PR B):*

- `issueRelations` reads the whole reconciled graph, with no node cap: a summary is not a
  response, and a cap could otherwise shorten `waits_on_issues` into a list that looks complete.
  A board's keys bound its size.
- The dependency fields follow the dependency section alone, and only while rule 6 has left it
  standing (§6.1). An issue whose hierarchy GitHub could not return still reports them, beside
  `unavailable: true`, which keeps meaning "no parent or sub-issues to draw".
- `issueRelations` reconciles over the board's own keys only, as it has since PR2, so it can
  differ from the viewer's graph until the key's next refresh: another display root's newer list
  can decide a pair the board's keys never observed.
- `[]` and `0` mean known and none; absent means unknown.
- The `board_get` description names both fields and says they are GitHub issue keys, read-only,
  distinct from the row's own writable `waits_on` step labels, and never a reason to mark a row
  `blocked`.

---

## §7 — Opt-in grouping

### 7.1 What a group is

- A group is a set of **two or more active plans in one Agent Inbox project that share a GitHub
  parent issue**. The key is `(project, parent key)` (S1 Q3). Plans in different projects never
  merge, even in the all-projects view.
- A plan's issue is its `certain` effective issue (`issueKeyFor`: pin, then a single closing
  issue, then branch). Its group parent is that issue's parent in the reconciled graph.
- **The umbrella.** A plan whose own issue *is* the group's parent (for example a plan pinned to
  #117) joins the group as its first member.
- A group needs at least two members. A plan alone under its parent stays flat.
- Rows are never regrouped across plans. Inside a plan, when linked rows span two or more parents,
  thin "Part of #117" sub-headers mark the runs; row order is unchanged.

### 7.2 Order

- A group takes the position of its first member in today's order.
- Inside a group: the umbrella, then members in GitHub's child order of their issues, then the
  rest in today's order.
- `paginateWithPending` pages the flattened list. A group that spans pages repeats its header
  with "(continued)".
- Lingering completed plans and the archived fold are not grouped.

### 7.3 Turning it on

Off by default. Decision D2 (§14) chooses between a saved Settings preference (like Default sort
order, #221, because grouping never hides anything) and a window-local toggle that resets at each
launch. Either way the Plans header gets a "Group by parent issue" switch, and changing it repaints
at once through `forceRender()` as an explicit human action.

### 7.4 Degradation

A plan joins a group only while its issue's relation is `fresh` or `stale` (S1 §5.8). When the
relation is `hidden`, `unavailable`, `no-hierarchy`, uncertain, omitted by the node cap, or
`/api/issues` failed, the plan renders flat in its normal place. A group whose members are all
stale shows its header dimmed with "as of …". With grouping on and no graph at all, the page is
exactly today's flat list. No plan is ever hidden by grouping.

### 7.5 Header

The header is an `<h3>` (not a control): the parent chip through `chipHtml()`, its escaped title,
"N of M sub-issues done" from GitHub's counts when known, and "K plans". It does not collapse in
this slice, so it adds no new expansion state.

---

## §8 — Data and process boundaries

| Process | Reads | Writes | Network |
|---|---|---|---|
| Viewer: `src/issue-poller.ts` | `listIssueEntities`, `listSourceLinks`, `listIssueSnapshots` | `claimIssueRefresh`, `completeIssueRefresh` (now with `dependencies`) | One `gh api graphql` per tick, unchanged |
| Viewer: `/api/issues` | `listIssueSnapshots`, key sets | none | none |
| MCP server | `listIssueSnapshots` for a titled `board_get`; boards and rows | `upsertBoard`, `updateBoardRow` (now with `waits_on`) | **none** |
| Browser | `/api/issues`, `/api/boards` in the existing eight-read tick | none new | none |

- All SQL stays in `store.ts`. `waits_on` validation (labels, cycles) runs there, inside the
  writing transaction.
- No new viewer route, no new write route, no new IPC, no new poll read.
- `src/issue-poller.ts` stays out of the stdio import graph; the boundary test in
  `test/prstate.test.ts` is unchanged.

---

## §9 — Presentation

All new chips are built in `public/source.js`, so every href still comes from `chipHtml()` →
`safeHttpUrl()` → `esc()`. Every GitHub title goes through `esc()` or `textContent`. Chips use
`tone-issue` or `tone-stale` only, never the `bad` tone, the blocked mark or the word "Blocked".
`public/issues.js` builds the view model, `public/mission.js` the flow model; both stay pure.

### 9.1 Plans

- **Row chips.** A row whose linked issue has open blockers shows "waits on #119" (one) or
  "waits on 3" (several) after its issue chip in the matrix note cell and the row card. A row with
  `waits_on` shows "waits on step Build" or "waits on 2 steps". The tooltip lists each target.
  When every blocker is closed or done, no chip.
- **Plan chip.** A plan whose own issue has open blockers shows the same chip beside its issue
  chip.
- **Source block.** Below "Sub-issues on GitHub", a **"Dependencies on GitHub"** section: "Waits
  on" and "Unblocks" lists with state marks, titles, the S1 §7.3 Agent Inbox activity label for
  each issue, "+N not visible to your GitHub account" (`total` minus visible), "+N more on GitHub"
  (truncated) and "+N not shown" (node cap). A cycle adds "Circular dependency on GitHub".
- **Row detail** (`rowPanelEl`) gains a "Waits on" block listing both kinds, each with its source
  ("step in this plan" / "GitHub"). A pair present in both shows once, labelled with both.

*As built (PR D):* `buildIssueView` gives each drawn relation `dependencies` and adds
`planWaits`/`rowWaits`; `public/source.js` draws them. Four details the bullets leave open:

- **One chip per row.** A row's steps and its issue's blockers share one chip: "waits on step
  Build" or "waits on #119" for one target, "waits on 2 steps" when every target is a step,
  "waits on 3" otherwise. A step whose linked issue is also a GitHub blocker is one entry, so
  the count never double-counts it. A step that is `done` or `na` (it will not happen, so it
  holds nothing up; Plan flow drops `na` rows too) draws nothing even when its issue is still
  open on GitHub; that issue then appears as a GitHub entry.
- **The "+N" counts are of OPEN issues.** The lists show open issues only, so "+N not visible
  to your GitHub account" counts open issues (`open`, not `total`) the list lacks; `total` would
  count closed issues the list deliberately omits. GitHub's page is the first 50 dependencies of
  the direction, closed ones included, so when `total` exceeds 50 an unlisted open issue may
  simply sit beyond it: then all `open` minus listed is "+N more on GitHub", and "not visible"
  is used only when the page was complete (`total` ≤ 50). The two cannot be told apart beyond
  the page, and permissions are never blamed for it. "+N not shown" (`dependencies_omitted`)
  covers both directions, so it is one line under the section rather than one per list, and it
  is taken out of the other two counts so no issue is counted twice.
- **The row detail** names a step as "step Build" and a GitHub issue by chip and title, each
  with its source ("step in this plan", "GitHub" or both). It carries no activity labels: the
  steps are this plan's own rows.
- **Unknown versus unavailable.** `dependencies: "unknown"`, `null` or a missing field draw no
  chip and no list. `unavailable` draws no chip and one line, "Dependencies unavailable —
  GitHub returned this issue but not its dependencies", in the source block.

### 9.2 Plan flow

`buildMission(board, deps)` stays pure. `deps` is built in the render from the frame's
`issueView` and the plan's rows; nothing fetches.

- **Order.** The agent's row order, unchanged. Decision D3 (§14) asks whether to sort
  topologically instead.
- **Per step**, below the existing summary:
  - "Waits on: Build · AHP adapter (#119)": each in-plan target is a `<button>` that moves focus
    to that step's node (explicit navigation, so it may reveal the target by scrolling the flow,
    per CLAUDE.md "Explicit keyboard traversal reveals its target"). Accessible name: "Waits on
    step AHP adapter (#119)".
  - "Unblocks: Import requests" with the same buttons.
  - An issue that no row of this plan links is an external chip (GitHub link) plus its activity
    label, which opens the other plan or row through the existing `focusItem(id, { rowId })`
    path after closing the flow. Never a cross-plan edge.
- **Containment.** A step whose issue's parent differs from the plan's own issue shows a thin
  "Part of #117" rail (`.mission-edge-contains`). Waits-on entries use `.mission-edge-waits`
  (dashed accent). The two never share a style.
- **"Not in this plan."** Children of the plan's issue that no row links appear in a fold at the
  foot, with their activity labels.
- A cycle (GitHub, or a local one written by an older process) shows "Circular dependency" on
  each member and changes no order.
- `result` stays `outcome` or `next_after` text only.

*As built (PR E):* `buildMission(board, { issues, links })` reads D's `rowWaits` and
relations, so the flow and the Plans chips cannot disagree. Details the bullets leave open:

- **Both lists follow the agent's row order**, not the stored (sorted) `waits_on` order the
  chip tooltip uses, so the flow reads top to bottom. In-plan entries come first, then
  external issues.
- **"Unblocks" is the exact inverse of every step's "Waits on"**, and a GitHub edge counts from
  either end: a row's own open blockers, or (for a row whose issue is open) its relation's open
  dependents. An edge known only from one side still draws on both steps.
- **What is a step.** A GitHub issue is an in-plan step when a drawn (not `na`) row links it,
  even a `done` one: the button takes you there, where D's chip lists it as "GitHub". An issue
  linked only by an `na` row is drawn as an external chip. "Not in this plan" excludes every
  row's link, whatever its status.
- **A local cycle** is found over the raw `waits_on` labels, satisfied ones included, because
  it is a contract violation the store refuses whatever the targets' status.
- **The containment rail is text** ("Part of #200", the parent's title on hover), not a link:
  it is a quiet rail, and the parent is one click away in Plans.
- The explicit reveal reuses the dialog Tab path's `revealControl`, moved unchanged to a
  module-level export of `public/keyboard-ui.js`.

### 9.3 Accessibility

- Text, not colour, carries meaning: "waits on", "unblocks", "circular", "as of …".
- Lists are `<ul>`; group headers are headings; flow targets are real buttons with names.
- Chips in Plans list rows keep #30's `tabbable` rule (out of the roving order).
- Focus moves only on explicit activation; passive polls restore focus as today and never move it.

### 9.4 Render-path rules

- No render path fetches, and there is no new render entry: Plans and the flow repaint through
  `renderIfIdle` and `forceRender` only. `issueView` is still rebuilt in `paintAmbient`.
- A poll that changes dependencies or grouping keeps drafts, focus, expanded rows and open
  Background disclosures, and respects the press and scroll guards. A plan that moves into or out
  of a group does so on the next frame the gate allows, never under a held pointer.

---

## §10 — Attention

- `public/attention.js`, `public/relay.js`, `electron/reply-watch.cjs` and
  `/api/items?scope=attention` stay byte-identical.
- No dependency or grouping value is passed to an attention function, badge, count, title or
  notification. Activity labels read the frame's `attentionEntries` and feed nothing back
  (S1 §9).
- A row that waits on something is not attention. A `blocked` row is attention exactly as today,
  whatever it waits on.
- Tests (§12): a source pin that `public/attention.js` names no `waits_on`, `blocks`, `deps` or
  group field; `test/dom/issue-attention.test.ts` extended so badge, title, tab counts,
  Needs-you and the dock projection are identical with and without dependencies, `waits_on` and
  grouping on.

---

## §11 — Mixed-version safety and migrations

- **Migrations** are two additive `ensureColumn` calls (`issue_snapshots.dependencies`,
  `board_rows.waits_on`). No backfill, no table rebuild.
- **v1.4 viewer + v1.5 viewer on one hub:** §5.3's binding table and §5.4's alternation. v1.4
  never reads the new column; v1.5 never trusts an unbound one.
- **v1.4 MCP server + v1.5 rows:** its `upsertBoard` / `updateBoardRow` / `advanceBoardRow` name
  columns explicitly and never touch `waits_on`, so a v1.4 full upsert keeps it on surviving rows
  (pinned with frozen v1.4.0 statements in `test/mixed-version.test.ts`, as PR2 did for issue
  links). A v1.4 upsert can delete a row and so leave a dangling reference, which draws nothing
  (§4.2), or re-add one and so close a cycle unchecked, which renders as "Circular" (§9.2).
  *As built (PR C):* the second case cannot happen. A v1.4 insert writes no `waits_on`, so a
  re-added row can only be waited on, and the references it revives cannot close a cycle;
  `test/mixed-version.test.ts` pins both halves. "Circular" stays a defensive rendering.
- **v1.5 MCP server reading v1.4 snapshots:** `issue_rel` omits `waits_on_issues`/`unblocks` until the
  viewer refreshes.
- **Older browser code** is never served by a newer viewer (one process serves both), and v1.4's
  `issues.js` already ignores unknown edge kinds and fields.
- **Rollback to v1.4:** the new columns are ignored. Nothing is lost.

---

## §12 — Test plan

No test makes a network call. GitHub fixtures are trimmed copies of the §2 responses. Store
tests use real SQLite through `openDb()`; scratch directories come from `scratchDir()`.

| File | Covers |
|---|---|
| `test/issue-poller.test.ts` | The document for sizes 1 and 10 contains the dependency fields; `parseIssueBatch` for the #117 fixture; field errors under each dependency field mark only that section unavailable; invalid neighbour dropped and list marked truncated; self-pair, duplicates, 50 cap, `hasNextPage`; upgrade tier and the blocker-closed nudge in `issueQueue` |
| `test/issue-store.test.ts` | `dependencies` written with the snapshot; bound vs unbound reads; hard failure clears; soft keeps; invalid JSON reads as null; leases unchanged (`test/issue-claims.test.ts`) |
| `test/store.test.ts` | `waits_on` omission keeps, `[]` clears, unknown label refused, self refused, cycle refused (one statement, `.immediate()`), dangling kept and revived, revision and `updated_at` bump, `board_advance` keeps |
| `test/mixed-version.test.ts` | Frozen v1.4.0 `upsertIssueSnapshot` unbinds; frozen v1.4.0 hard failure unbinds; frozen v1.4.0 board statements keep `waits_on` |
| `test/issue-graph.test.ts` | Every §6.1 worked example; aliases; hard-failure suppression of both ends; cycles marked; counts from own section only; node cap fill order and exact `truncated`; edges only between emitted nodes; byte-identical output for identical input; `issueRelations` `waits_on_issues`/`unblocks` present, omitted when unknown, open only; stdio import graph unchanged |
| `test/mcp.integration.test.ts` | `waits_on` round trip over real stdio; refusals reach the agent as tool errors; titled `board_get` echoes `waits_on` and `issue_rel.waits_on_issues`; the `status` field description carries the new sentence |
| `test/issues.test.ts` | Waits-on and unblocks view model, freshness ages, closed blockers excluded, "+N" counts, grouping keys (umbrella, two-member minimum, cross-project separation, degradation states) |
| `test/mission.test.ts` (extended) | `buildMission` with both sources: merge of agreeing pairs, external issues, containment rail, "Not in this plan", cycles, dangling labels ignored, row order unchanged, `next_after` text creates no edge |
| `test/source.test.ts` | Hostile titles in chips, tooltips and headers; constructed hrefs only; tones; "Blocked" never appears |
| `test/dom/issue-relations.test.ts` | Plans chips and source block from fixtures; 404 and stale fallbacks; a draft, focus and expanded row survive a poll that changes dependencies |
| `test/dom/mission-map.test.ts`, `test/dom/mission-focus.test.ts` (extended) | Waits-on buttons move focus to the target step; external label opens the other plan through `focusItem`; poll keeps the flow's focus |
| `test/dom/plan-grouping.test.ts` (new) | Off by default; toggle repaints; grouping falls back to flat without a graph; continued headers across pages; no plan hidden; group changes wait for a released pointer |
| `test/dom/issue-attention.test.ts` | §10's identical-attention assertions with dependencies, `waits_on` and grouping on |
| `test/dead-exports.test.ts` | Stays green |

---

## §13 — Slicing

Every PR: `npm run typecheck` clean, dead-export guard green, CLAUDE.md and
`.github/copilot-instructions.md` updated for the invariants it adds, attention pin re-run for any
PR that renders.

| PR | Scope | Depends on | Size (prod / test lines, estimate) |
|---|---|---|---|
| **A. Ingest GitHub dependencies** | Query fields, `parseIssueBatch`, `issue_snapshots.dependencies` with binding, `completeIssueRefresh` plumbing, upgrade tier, blocker nudge. No UI | — | 250 / 400 |
| **B. Graph and `issue_rel`** | §6 reconciliation, `blocks` edges, node-cap fill, root and node fields, `issue_rel.waits_on_issues`/`unblocks`, `board_get` description | A | 250 / 450 |
| **C. `waits_on` row field** | Column, store validation and cycle check, MCP schemas and echo, contract sentence in three tool descriptions, `status` describe and the reporting snippet, mixed-version pins | — | 200 / 350 |
| **D. Plans chips** | Row and plan "waits on" chips, "Dependencies on GitHub" section, row-detail "Waits on" block, view model in `issues.js` | B, C | 300 / 400 |
| **E. Plan flow** | `buildMission(board, deps)`, waits-on / unblocks buttons, containment rail, "Not in this plan", cycles, CSS | B, C | 300 / 400 |
| **F. Opt-in grouping** | Group keys in `issues.js`, Plans header switch (and Settings preference if D2 picks it), grouped `renderBoards`, in-plan sub-headers, continued headers | slice 1 only | 250 / 350 |

C and F can start at once, in parallel with A. Each PR ships something whole: A and B change no
UI but make `issue_rel` useful to agents; C is useful to agents before any UI draws it.

**Later (not v1.5 unless D4 says so):** sibling context ("3rd of 10", sibling lists), search by
issue key and GitHub title, row-level deep-link hashes (S1 §12.4).

**Never:** writing GitHub relationships (S1 Q4), deriving status from dependencies, creating plans
or rows from issues.

---

## §14 — Decisions for Shariq

**Decided 2026-10-21:** Shariq approved the recommended answer to every question below: both dependency sources ship, grouping is off by default as a saved preference with a Plans header switch, Plan flow keeps the agent's row order with "waits on"/"unblocks" buttons, and v1.5 is PRs A–F.

**D1. Which dependency sources ship?**

1. **Both: GitHub "blocked by" read by the poller, and an agent-written `waits_on` row field for
   steps in the same plan.** (Recommended.) Covers issue-linked and unlinked work; two clearly
   labelled sources.
2. GitHub only. One source of truth, no new agent field; rows without an issue never show
   sequencing.
3. Agent-declared only. No poller change; GitHub's existing relationships stay invisible and
   agents must restate them.

**D2. How is grouping turned on?**

1. **Off by default; a saved Settings preference plus a Plans header switch for the current
   view, like Default sort order (#221).** (Recommended: grouping hides nothing, the same reason
   sort order is the one saved display preference.)
2. A window-local switch only, off at every launch (the S1 §12.1 sketch).
3. On by default.

**D3. How does Plan flow order steps that wait on each other?**

1. **Keep the agent's row order and show "waits on" / "unblocks" buttons per step.**
   (Recommended: agents order rows on purpose, and a dependency arriving on a poll would
   otherwise reshuffle the flow under the reader.)
2. A stable topological order (Kahn, ties by row position; cycles keep plan order), as S1 §12.3
   sketched.

**D4. What is in v1.5?**

1. **PRs A–F: GitHub dependencies, `issue_rel`, `waits_on`, Plans chips, Plan flow and
   grouping. Sibling context, search and deep-link hashes stay later.** (Recommended.)
2. A–F plus sibling context, search by issue key and title, and row-level deep-link hashes.
3. A, B, D and E only: GitHub dependencies in Plans and Plan flow. `waits_on` and grouping move
   to v1.6.

---

## §15 — Alternatives considered

- **Infer edges from `next_after`, `impact` or row order.** Rejected by #103 and S1: prose is
  display text, and a wrong edge is worse than none.
- **One combined source** (copy GitHub edges into `waits_on`, or write `waits_on` to GitHub).
  Rejected: Agent Inbox never edits GitHub (S1 Q4), and copying GitHub data into agent-owned
  fields would go stale and fight the agent's own writes.
- **`waits_on` naming row ids.** Rejected in §4.4.
- **Cross-plan `waits_on`.** Rejected for now: a label is only unique within a plan, and
  cross-plan sequencing already has a source (GitHub). Can be added later with a plan-qualified
  form.
- **Pruning dangling `waits_on` labels when a row is removed.** Rejected: it rewrites other rows'
  agent-owned fields and revisions as a side effect, and v1.4 writers would not do it anyway.
- **Snapshot `v: 2`.** Rejected in §5.3.
- **A normalized `issue_edges` table.** Still deferred (S1 §17): it needs per-root ownership and
  the same reconciliation.
- **REST dependency endpoints.** Several requests per issue; rejected as in S1 §2.9.
- **Drawn connector lines (SVG) in Plan flow.** Deferred: hard to make accessible and to keep
  stable across polls. Buttons with names carry the same information.
- **Grouping by Agent Inbox project or by stream.** Not what #103 asks; project is already a
  rail filter.
- **Collapsible group headers.** Deferred: a new expansion state to preserve across rebuilds, for
  little gain while groups are opt-in.
- **A "dependencies done" signal** that suggests a status change when all blockers close.
  Rejected: status is the agent's, and a suggestion would read as attention.

---

## §16 — Risks

1. **Agents mark `blocked` for a dependency.** The contract sentence and the visible "waits on"
   chip next to the blocked mark make it obvious; the viewer cannot prevent it.
2. **Two sources disagree.** A step that waits locally but not on GitHub (or the reverse) shows
   one entry with its source. No reconciliation between sources is attempted.
3. **Stale dependencies read as current.** Same ageing and dimming as S1, plus the blocker-closed
   nudge.
4. **Mixed v1.4/v1.5 viewers spend extra budget** refetching unbound keys (§5.4). Bounded by the
   bucket and leases; ends when both upgrade.
5. **Payload growth.** About 0.5 KB per root per fetch; `/api/issues` capped as in §6.3.
6. **Grouping moves plans.** A plan can change groups between frames when GitHub data changes.
   The press and scroll guards hold the frame while the human acts, and open state is keyed by id.

---

## §17 — Verification log

Run on 2026-10-21 with `gh` 2.102.0, read-only:

- `__type(name: "Issue")` introspection: `blockedBy` and `blocking` (`IssueConnection`,
  `orderBy/after/before/first/last`), `issueDependenciesSummary`, `parent`, `subIssues`,
  `subIssuesSummary`.
- `__type(name: "IssueDependenciesSummary")` field descriptions, quoted in §2.
- `__type(name: "IssueOrderField")`: `CREATED_AT, UPDATED_AT, COMMENTS`.
- `#121`: `blockedBy` #120 and #119 (both open), `blocking` none, summary `2/2/0/0`, cost 1.
- The shipped `relationsQuery(10)` for #117–#126, with and without the §5.1 fields: cost 1 and
  1; 7,615 and 12,644 bytes. The dependency lists matched §2's family table.
- `gh issue list --json number,state,blockedBy` over this repository: seven issues have
  blockers, all open.
- GitHub Docs, "Creating issue dependencies": the `gh` flags and `--json blockedBy,blocking`.

---

## §18 — Revision history

- **Revision 1 (2026-10-21):** first draft for slice 2.
- **PR C notes (2026-10-21):** §4.2 now says how "written in this call" and the cycle rule
  were built (only what a write adds is checked, in linear time under the write lock), and §11
  notes that a v1.4 re-add cannot close a cycle.
- **PR B notes (2026-10-21):** `issue_rel.waits_on` is renamed `issue_rel.waits_on_issues`
  (§0, §6.4, §11, §12, §13). The PR C review advised it and Shariq approved: a titled
  `board_get` row would otherwise carry two `waits_on` fields, its own writable step labels and
  the read-only GitHub issue keys inside `issue_rel`, and an agent could paste issue keys into the
  row field or think GitHub dependencies were writable. No name is built on "blocked", which
  means the human here. §6.1 to §6.4 gain "as built" notes: the edge budget bounds both edge
  kinds, `dependencies_omitted` counts edges, a refused root's own section records nothing,
  listed keys are not alias-folded, and `issue_rel` reads the uncapped graph.
- **Review of #271 (2026-10-21):** a model-based review over random hubs agreed with
  reconciliation, the cap fill, `issue_rel` and the five departures above, and found: a section
  rule 6 dropped still read as `ok` on its root, so `issue_rel` said "known, none" (fixed, §6.1);
  a build cost that grew with every display root's dependency entries, not with the cap (fixed
  without changing a byte, §6.3); a payload estimate that was too low (corrected, §6.3); four
  mutations the tests missed (now pinned); and wording that overstated "identical with and
  without dependencies", since dependency lists are a new rule 7 fact source (§6.2).
- **PR D notes (2026-10-22):** §9.1 gains an "as built" note: one chip per row for both
  sources, "+N" counts of open issues (`open`, not `total`, since closed ones are never
  listed), one "+N not shown" line per section (the omitted count is not split by direction),
  and no activity labels in the row detail. Review of #274: open issues missing from a page of
  50 that mixes closed ones are "more on GitHub", never "not visible" (only a complete page
  proves that), and a `waits_on` target whose row is `na` counts as satisfied, like `done`.
