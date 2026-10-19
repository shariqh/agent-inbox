# Design: Plans that model GitHub sub-issues and dependencies (issue #103)

**Date:** 2026-10-19
**Status:** Design for review. Nothing here is implemented. §15 lists eight decisions for the
owner; each names the PR it gates, so implementation can start as soon as Q1, Q6 and Q8 (PR1's
gates) are answered.
**Milestone:** v1.4. Part of #103.
**Scope of this PR:** this document only. Zero source or test changes.

---

## §0 — The proposal in ten lines

1. GitHub already models what #103 asks for. Native **sub-issues** give one parent, up to 100
   ordered children and up to 8 levels. Native **issue dependencies** give "blocked by" and
   "blocking", up to 50 per type. Both are generally available in GraphQL, REST and `gh` 2.94.0+.
2. The **viewer process**, never the MCP server, reads them with at most **one batched
   `gh api graphql` call per poller tick**. A call covers up to 10 issues, uses a constant query
   whose values all travel as variables, and costs **1 GraphQL point** (measured, §2.7).
3. Results are cached per repo-qualified issue (`owner/name#123`) in a new `issue_snapshots`
   table behind `src/store.ts`. It uses the same fetched/checked/error split as
   `source_links_by_head`.
4. A pure merge turns the snapshots into one deduplicated graph with two typed edges:
   **`contains`** (parent → child) and **`blocks`** (blocker → dependent). The freshest
   observation wins, so an issue always has at most one parent and a stale snapshot cannot
   duplicate it.
5. `GET /api/issues` serves that graph as its own conditional snapshot. GitHub changes therefore
   never change the bytes of `/api/items` or `/api/boards`.
6. Plans, rows and items still link to issues **locally**: today's inferred `repo`/`issue_ref`
   stamps, the PR's closing issue, and two new explicit agent fields (a plan-level `issue` pin
   and a row-level `issue` link). Nothing is parsed from labels or prose.
7. The UI gains a parent breadcrumb (`#117 › #120`), child progress, "waits on"/"unblocks"
   chips, a GitHub-ordered sub-issue strip on parent plans, Plans grouped under their parent
   issue, and Plan Flow edges that look and behave differently for containment and sequencing.
8. Dependencies are ambient. They never set, suggest or reuse the `blocked` row status, and
   `public/attention.js` is untouched. A row waiting on another issue is `tracked` or `partial`.
9. Every failure falls back to today's plain issue chip and plan. Relationship data shows its
   age, dims after 30 minutes, disappears after 7 days and is pruned after 30 days.
10. Delivery is five read-only PRs plus one optional PR (§14). Agent Inbox never edits GitHub
    relationships; agents keep using `gh issue edit`.

---

## §1 — What exists today

### 1.1 How an entity names an issue

| Entity | Columns | Written by | Notes |
|---|---|---|---|
| Item | `items.repo`, `items.issue_ref`, `items.head_repo` | `flag` in `src/mcp.ts` | `issue_ref = scope.issueFor(branch)`: `register({ issue })`, else `inferIssueRef(branch)` in `src/infer.ts` (conservative: `30-x`, `feat/30-x`, `issue-30`, `gh-30`) |
| Plan (board) | `boards.repo`, `boards.issue_ref`, `boards.head_repo` | `upsertBoard` / `updateBoardRow` in `src/store.ts` | **Restamped from the writing session on every write** (`boardChanged`), so a plan links to whatever branch its last writer was on |
| Plan row | none | n/a | Rows have no issue identity today |
| PR | `source_links_by_head.issue_number`, `issue_url` | `parsePrPayload` in `src/prstate.ts` | First `closingIssuesReferences` entry only. `issueRef()` in `public/source.js` prefers it to the branch guess |

Rendering goes through one path. `sourceChipsHtml()` and `sourceBlockHtml()` call `chipHtml()`,
which calls `anchorHtml()`, which calls `safeHttpUrl()`, all in `public/source.js`. Issue titles
are always null today because `gh pr list` does not return them, so the chip reads `#30`.

### 1.2 Plans and Plan Flow

- `renderBoards()` and `boardEl()` in `public/app.js` render each plan as a card. Source chips
  sit outside `<summary>` so a chip click cannot also toggle the card (#30).
- `buildMission(board)` in `public/mission.js` returns a root (the plan) plus one path per
  non-`na` row. A path's result is the row's `outcome` or `next_after` text only. `openMission`,
  `renderMission` and `missionPathEl` in `public/app.js` render it. CLAUDE.md: "Plan flow is
  plan-scoped and draws only plan → row → explicit `next_after`/`outcome` paths; `impact` prose
  never creates a dependency edge."

### 1.3 The live poller

`src/prstate.ts` (VIEWER PROCESS ONLY) is started by `startPrPoller(db)` in
`src/viewer-server.ts`. It ticks every 60 s (`POLL_INTERVAL_MS`), first at 2 s, behind a `busy`
guard. `dueTargets()` is the pure TTL policy (open PR 5 min, no PR 15 min, settled 60 min, soft
error 10 min, hard error 60 min). Each tick makes at most `MAX_PER_TICK` = 4 `gh pr list` calls,
plus bounded preview reads. `listLinkTargets()` caps targets at 50, skips closed projects (#32),
and `pruneSourceLinks()` drops rows unchecked for 30 days. `refreshOnce` never rejects.

### 1.4 A real family in this repository

Issue #117 "Integrate Agent Inbox with Agent Host Protocol" has ten sub-issues, #118 to #127.
#119 blocks seven of its siblings (#118 and #120 to #125), and #120 blocks #121 (§18). Agent
Inbox shows none of this today: a plan or question for #120 says `#120` and nothing more. The
examples in this document use this family.

---

## §2 — GitHub's relationship APIs (verified live on 2026-10-19)

### 2.1 Features and status

| Feature | Status | Limits and rules | Source |
|---|---|---|---|
| Sub-issues | GA 2025-04-09 | One parent per issue; up to 100 sub-issues per parent; up to 8 levels; cross-repository; cross-organization since 2025-09-11 | Docs "Adding sub-issues"; changelogs 2025-04-09, 2025-09-11 |
| Issue dependencies | GA 2025-08-21 | Up to 50 issues per relationship type; cross-repository and cross-owner (observed: `microsoft/vscode#332085` blocks `Vivswan/litellm-vscode-chat#443`) | Changelog 2025-08-21 |
| Issue types | GA 2025-04-09 | Organization-level only; null in user-owned repositories such as this one | Changelog 2025-04-09 |
| Tasklists (`trackedIssues`, `trackedInIssues`) | Retired; not rendered after 2025-04-30 | Derived from body checklists | Not used: #103 forbids checklist inference |
| `gh` support | v2.94.0 (changelog 2026-06-10); installed here: 2.102.0 | `gh issue view/list --json parent,subIssues,subIssuesSummary,blockedBy,blocking,issueType`; `gh issue edit --parent / --add-sub-issue / --add-blocked-by / --add-blocking` and `--remove-*` variants | Changelog 2026-06-10; `gh issue edit --help` |

The REST "Add sub-issue" page still says a sub-issue "must belong to the same repository owner
as the parent", which the 2025-09-11 changelog superseded. Nothing in this design depends on
which is true, because issue identity is always repo-qualified.

### 2.2 GraphQL (introspected on the `Issue` type)

| Field | Type | Arguments | Notes |
|---|---|---|---|
| `parent` | `Issue` | none | `null` when there is no parent |
| `subIssues` | `IssueConnection` | `first/last/after/before`, **no `orderBy`** | Returned in the parent's own order, which `reprioritizeSubIssue` changes |
| `subIssuesSummary` | `{ total, completed, percentCompleted }` | none | An object, so it adds no connection cost |
| `blockedBy`, `blocking` | `IssueConnection` | `orderBy`, `first/last/after/before` | |
| `issueDependenciesSummary` | `{ blockedBy, blocking, totalBlockedBy, totalBlocking }` | none | The field descriptions contrast `blockedBy` with `totalBlockedBy` ("open and closed"), so `blockedBy` counts open blockers |
| `issueType` | `IssueType { name, color, … }` | none | Display only, if ever |

The mutations are `addSubIssue`, `removeSubIssue`, `reprioritizeSubIssue`, `addBlockedBy`,
`removeBlockedBy` and `updateIssueIssueType`. This design uses none of them (§11, Q4).

### 2.3 REST

| Endpoint | Purpose |
|---|---|
| `GET /repos/{o}/{r}/issues/{n}/sub_issues` | List children (`per_page` ≤ 100, `page`) |
| `GET /repos/{o}/{r}/issues/{n}/parent` | The parent. **404 "No parent issue found"** when there is none |
| `POST /repos/{o}/{r}/issues/{n}/sub_issues` `{ sub_issue_id, replace_parent }` | Add a child; takes the database id, not the number |
| `DELETE /repos/{o}/{r}/issues/{n}/sub_issue` `{ sub_issue_id }` | Remove a child |
| `PATCH /repos/{o}/{r}/issues/{n}/sub_issues/priority` `{ sub_issue_id, after_id \| before_id }` | Reorder |
| `GET /repos/{o}/{r}/issues/{n}/dependencies/blocked_by`, `…/blocking` | List dependencies (`per_page` ≤ 100) |
| `POST …/dependencies/blocked_by` `{ issue_id }`, `DELETE …/blocked_by/{issue_id}` | Edit dependencies |

Issue objects also carry `parent_issue_url`, `sub_issues_summary` and
`issue_dependencies_summary`. Every list returns full issue objects (35 top-level keys, with
user, labels, milestone and reactions; the parent endpoint adds a full repository object). The
docs now pin `X-GitHub-Api-Version: 2026-03-10`; unversioned `gh api` calls were served
`2022-11-28`.

### 2.4 Permissions, private and cross-repository issues

- **Read:** a fine-grained token needs the repository permission "Issues: read". A classic or
  OAuth token needs `repo` for private repositories; any token reads public ones. The local
  `gh` token here has `repo, read:org, gist, user, admin:public_key`. Agent Inbox never handles
  the token; `gh` owns authentication.
- **Write** needs "Issues: write". This design never writes.
- **Private:** GitHub answers only what the token can see. A repository or issue the token
  cannot see is `NOT_FOUND`, exactly like one that does not exist (§2.6).
- **SSO:** an organization enforcing SAML returns `FORBIDDEN` with
  `extensions.saml_failure: true` until the token is authorized (observed for `github/roadmap`).
- **Hidden children:** whether a child the token cannot see is omitted from `nodes` while still
  counted in totals is not documented. The design does not depend on it: it compares GitHub's
  counts with the visible list and says so when they differ (§4.5).

### 2.5 Pagination, ordering and depth

- GitHub's own caps equal the page sizes used here. `subIssues(first: 100)` and
  `blockedBy/blocking(first: 50)` always return the whole list, so **no pagination is needed**.
  If `pageInfo.hasNextPage` is ever true (GitHub raised a limit), the list is marked truncated
  and the UI says "+N more on GitHub" instead of paging.
- Children keep GitHub's order and are stored with their index as `position`. Dependency lists
  have no meaningful order, so they are sorted by key for deterministic rendering.
- Ancestors come from nested `parent { parent { … } }` objects. Seven levels above the parent
  cost nothing extra (objects are not connections) and cover GitHub's 8-level maximum.

### 2.6 Failure shapes (observed)

- **Partial batch:** `gh api graphql` exits 1, still prints the full `{ data, errors }` JSON on
  stdout and the first message on stderr. Each error carries a `type` and a `path` whose first
  element is the alias.
- Unknown repository: `NOT_FOUND`, path `["r1"]`, "Could not resolve to a Repository with the
  name 'shariqh/no-such-repo-xyz'."
- Unknown issue: `NOT_FOUND`, path `["r0","issue"]`.
- **A pull request number:** `issue(number: 215)` is `NOT_FOUND`, while `issueOrPullRequest`
  reports `PullRequest`. A branch heuristic or `register({ issue })` can name a PR, so this is a
  real case.
- SSO: `FORBIDDEN` with `saml_failure`, `data.r1 = null`, the other aliases intact.
- REST `GET …/parent` for a top-level issue: HTTP 404 "No parent issue found", which looks the
  same as "no access". This is one more reason to prefer GraphQL.

### 2.7 Cost (measured)

| Request | GraphQL points | Time | Bytes |
|---|---|---|---|
| The query in §5.5, 3 roots | 1 | not timed | 5,735 |
| Same, 10 roots (live) | 1 | 0.8–0.9 s | 18,550 raw GraphQL; **6,173 merged** (11 nodes, 18 edges) |
| Same, 25 roots (dry run) | 1 | | |
| Same, 40 and 50 roots (dry run) | 2 | | |
| `gh pr list` (the existing poller's call) | about 1 (noisy before/after reading) | 0.4–0.6 s | |

Primary limits: 5,000 points per hour per user, 10,000 for GitHub Enterprise Cloud members (this
account reports 10,000 GraphQL and 15,000 REST). Secondary limits: at most 2,000 points per minute
on the GraphQL endpoint, where one query counts as 1 point; at most 100 concurrent requests;
a 10-second server timeout per request.

### 2.8 Webhooks

`sub_issues` (`parent_issue_added`, `parent_issue_removed`, `sub_issue_added`,
`sub_issue_removed`) and `issue_dependencies` (`blocked_by_added`, `blocked_by_removed`,
`blocking_added`, `blocking_removed`) exist. Both need a public HTTPS endpoint or a GitHub App.
The viewer binds `127.0.0.1` only (`src/viewer-network.ts`), so **polling is the only option**.
Hosted mode (#8) is the seam where a webhook receiver could later replace polling.

### 2.9 Decision

Read relationships with GraphQL through `gh api graphql`, read-only:

- One call fetches each root issue, its ancestors, its ordered children and both dependency
  directions, for up to 25 issues, for 1 point.
- Field-level errors let the hierarchy survive a dependency failure, and the reverse.
- Every node carries an explicit `repository { nameWithOwner }`, and no URL path is built from
  data.

Rejected: `gh issue view --json` per issue (one subprocess per issue; its child nodes carry a URL
but no repository) and REST (three or four requests per issue, full issue objects, the 404
ambiguity above).

---

## §3 — What the human sees

All examples use the #117 family from §1.4.

1. **A child shows its parent.** An agent flags a question on branch `120-ahp-input-requests`.
   Today its chip reads `#120`. With this design it reads `#117 › #120`, followed by a quiet
   `waits on #119` chip. Hovering shows "Parent: #117 Integrate Agent Inbox with Agent Host
   Protocol (0 of 10 done) · Waits on: #119 Build the AHP adapter and persisted projection
   foundation (open) · checked 3m ago". Both numbers open GitHub in a new tab. The question
   stays in Needs you because it is a question, not because of #119.
2. **A parent plan shows its children.** The agent keeps an umbrella plan "AHP integration"
   pinned to #117. The plan card gains a strip, "Sub-issues on GitHub · 0 of 10 done", listing
   #118 to #127 in GitHub's order. Each child shows its open or closed mark, who is working on
   it here ("With claude-code · AHP adapter plan", "Waiting on you", "No local work") and any
   "waits on" hint. A row the agent linked to a child shows that child's state beside the row.
3. **Plans group under their parent.** Three PR-sized plans exist for #119, #120 and #122. In
   Plans they now appear under one header, "#117 Integrate Agent Inbox with Agent Host Protocol
   · 0 of 10 done", in GitHub's child order, instead of as three unrelated cards. Plans with no
   known parent stay where they were.
4. **Plan Flow shows two kinds of edge.** On the umbrella plan, each step linked to a child sits
   on a "Part of #117" rail (containment). Steps that wait on another step show a "Waits on: AHP
   adapter (#119)" link (sequencing). The two use different lines, words and screen-reader
   labels. `impact` and `next_after` stay plain text and never become edges.
5. **Closing a child moves the rollup.** When #119's PR merges, the PR poller notices `MERGED`
   on its next check of that PR (every 5 minutes for an open PR) and nudges #119 and every
   cached issue that mentions it. In the same tick #117 reads "1 of 10 done" and its siblings
   drop "waits on #119". A child closed without a linked PR shows up within the 10-minute TTL
   instead.
6. **Moving a child regroups it once.** If #126 moves from #117 to another parent, the next
   refresh regroups its plan under the new parent. It is never shown under both, no plan is
   created or deleted, and no row note changes.
7. **Failures never hide work.** If `gh` is missing, logged out, offline or rate-limited, the
   plan and the plain `#120` chip render exactly as today. Relationship chips keep the last
   known state, labelled "as of 2h ago" and dimmed after 30 minutes, and disappear after 7 days.
   An issue GitHub will not show (deleted, a PR number, private, SSO-protected) says
   "unavailable" in its tooltip and draws no relationships.
8. **A dependency is never "blocked".** A row whose issue waits on #119 is `tracked` before work
   starts and `partial` once started. Its glyph is whatever the agent set; the dependency only
   adds a neutral "waits on" chip. The badge, title count, Needs you, dock badge and
   notifications do not change.

---

## §4 — Data model

### 4.1 Issue identity

- An **issue key** is `{ repo: 'owner/name', number }`, serialized as `owner/name#number` with
  the repository lowercased. GitHub compares owner and name case-insensitively, as `headMatches`
  in `src/prstate.ts` already assumes. Display text keeps GitHub's casing from `nameWithOwner`.
- Slugs must match `parseRepoSlug`'s character class (`^[\w.-]+/[\w.-]+$`) with neither part
  `.` or `..`, the rule `resolvePreviewPayload` applies. Numbers are integers from 1 to
  2,147,483,647 (GraphQL `Int`).
- **A number is never compared without its repository.** `a/x#5` and `b/y#5` stay distinct in
  the storage key, the merged graph, DOM `data-issue-key` attributes, search keys and deep links.

### 4.2 Local links and their precedence

| Entity | Link source | New? | Precedence |
|---|---|---|---|
| Item | Closing issue of its branch PR | existing | 1 |
| Item | `register({ issue })` or `inferIssueRef(branch)`, in `items.repo` | existing | 2 |
| Plan | Explicit pin: `board_upsert({ issue })` → `boards.issue_pin_repo`, `boards.issue_pin_number` | **new** | 1 |
| Plan | Closing issue of its branch PR | existing | 2 |
| Plan | Branch-inferred `issue_ref`, restamped on every write | existing | 3 |
| Row | Explicit link: `rows[].issue` or `board_row({ issue })` → `board_rows.issue_repo`, `board_rows.issue_number` | **new** | only source |

- One pure helper, `issueKeyFor(entity, link)` in a new `public/issue-key.js`, decides the
  effective issue for the chips **and** for the poller, the way `linkKey` is shared today.
  `issueRef()` in `public/source.js` delegates to it.
- **Cross-repository closing issues** take their repository from `issue_url`, accepted only when
  it is exactly `https://github.com/<slug>/issues/<issue_number>`; otherwise the entity's `repo`
  is used, as today. No column is added to `source_links_by_head`: an older process sharing the
  database would leave such a column stale.
- **Never** used as a link source: labels, titles, notes, `impact`, `next_after`, `context`,
  comments, checklists, branch names beyond today's `inferIssueRef`, or PR links (#103 non-goal).

**Why the plan pin is needed.** Because boards are restamped from the writing session, an
umbrella plan maintained from branch `119-ahp-adapter` is linked to #119, not #117. The only
workaround today, `register({ issue: 117 })`, would also relink every item that session flags.
The pin is agent-owned and follows the omission rule (omitted preserves, `''` clears back to
inference). It does **not** replace `boards.repo` or `issue_ref`, which still drive the PR
lookup in `listLinkTargets()`.

### 4.3 Schema (additive)

All changes use the existing additive pattern in `runMigrations()`: `CREATE TABLE IF NOT EXISTS`
and `ensureColumn`. Nothing is backfilled; there is no correct backfill for links nobody declared.

```sql
CREATE TABLE IF NOT EXISTS issue_snapshots (
  repo TEXT NOT NULL COLLATE NOCASE,   -- requested owner/name; NOCASE folds ASCII, enough for slugs
  number INTEGER NOT NULL,             -- requested issue number
  provider TEXT NOT NULL DEFAULT 'github',
  snapshot TEXT,                       -- JSON (below); NULL until the first successful fetch
  fetched_at TEXT,                     -- start time of the last SUCCESSFUL fetch
  checked_at TEXT NOT NULL,            -- start time of the last attempt
  error TEXT,                          -- NULL | no-gh | auth | rate-limit | offline | gh-failed | not-found | forbidden
  revision INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (repo, number)
);
-- ensureColumn(db, 'boards', 'issue_pin_repo', 'TEXT')
-- ensureColumn(db, 'boards', 'issue_pin_number', 'INTEGER')
-- ensureColumn(db, 'board_rows', 'issue_repo', 'TEXT')
-- ensureColumn(db, 'board_rows', 'issue_number', 'INTEGER')
```

Snapshot JSON, version 1, for #120 as fetched on 2026-10-19:

```json
{
  "v": 1,
  "issue": { "repo": "shariqh/agent-inbox", "number": 120,
             "title": "Import unresolved AHP input requests into Needs you",
             "state": "OPEN", "state_reason": null },
  "ancestors": [
    { "repo": "shariqh/agent-inbox", "number": 117,
      "title": "Integrate Agent Inbox with Agent Host Protocol",
      "state": "OPEN", "state_reason": null, "children_total": 10, "children_completed": 0 }
  ],
  "position": 2,
  "hierarchy": { "status": "ok", "total": 0, "completed": 0, "truncated": false, "children": [] },
  "dependencies": {
    "status": "ok", "truncated": false,
    "blocked_by_open": 1, "blocked_by_total": 1, "blocking_open": 1, "blocking_total": 1,
    "blocked_by": [ { "repo": "shariqh/agent-inbox", "number": 119, "state": "OPEN", "state_reason": null,
                      "title": "Build the AHP adapter and persisted projection foundation" } ],
    "blocking":   [ { "repo": "shariqh/agent-inbox", "number": 121, "state": "OPEN", "state_reason": null,
                      "title": "Send Agent Inbox responses back to AHP input requests" } ]
  }
}
```

`hierarchy.status` and `dependencies.status` are independent (`ok` or `unavailable`), so a
dependency error never hides the hierarchy and the reverse (#103: parent-child must work
without dependency support).

**Why one JSON snapshot per issue rather than an edges table.** It mirrors
`source_links_by_head` (one cached answer per target key) and is replaced atomically in one
upsert. The GraphQL shape can grow under `v` without a migration. `store.ts` still validates it
on write and on read, as it does for `options` and `history`. Nothing needs SQL over edges,
because the merge (§4.5) runs in pure code either way. The `/api/issues` shape (§4.6) hides the
storage choice, so a normalized table remains possible later.

### 4.4 `store.ts` API (still the only door)

| Function | Behavior |
|---|---|
| `upsertIssueSnapshot(db, { repo, number, snapshot, startedAt })` | Validates the v1 shape, then writes it in one conditioned upsert that **refuses an attempt older than the stored success** (`… WHERE excluded.fetched_at > COALESCE(issue_snapshots.fetched_at, '')`). Two viewers can poll one hub, for example a checkout viewer and the packaged app. Bumps `revision`, then prunes. Returns whether it wrote. |
| `recordIssueFailure(db, { repo, number, error, startedAt })` | Insert-or-update of `checked_at` and `error` that keeps the last good `snapshot` and `fetched_at`, and is ignored when a newer success already landed. |
| `listIssueSnapshots(db)` | Every row, parsed. Invalid JSON or shape counts as "no snapshot" and never throws. |
| `listIssueEntities(db)` | Link fields of open items, active plans and their rows, outside closed projects (`closedProjects()`), newest first. |
| `pruneIssueSnapshots(db, { nowMs })` | Deletes rows unchecked for 30 days, like `pruneSourceLinks()`. |
| `upsertBoard`, `updateBoardRow` | Accept the plan pin and row link with the omission rule. `Board`, `BoardRow`, `ROW_COLUMNS` and `NewBoardRow` gain the fields; human annotation, handled and delivery columns are untouched. |

### 4.5 Merge rules: `buildIssueGraph(snapshots)` (pure, `src/issue-graph.ts`)

1. Each snapshot is a set of **observations** about its root, ancestors, children and
   dependency neighbours, all stamped with the snapshot's `fetched_at`. A section whose status
   is `unavailable` observes nothing: it neither adds nor removes an edge.
2. **Node facts** (title, state, counts): the freshest observation wins. The root's own record
   wins a tie.
3. **Parent of C:** taken from the freshest snapshot that observed C's parent, either C's own
   `ancestors[0]` or a root P that lists C among its children. An empty `ancestors` is an
   observation too ("no parent"). Every older claim is dropped. So every node has at most one
   parent, and a moved or detached child never appears under two parents (acceptance
   criterion 6).
4. **Child order:** from the parent's own snapshot (GitHub's order) when it is a root, else
   from the `position` recorded in the children's snapshots; ties sort by key.
5. **`blocks` edges:** A → B exists if the fresher of A's root snapshot (`blocking`) and B's
   root snapshot (`blocked_by`) contains it. When only one endpoint is a root, that snapshot
   decides.
6. **Self-links** are dropped and **duplicate edges** collapse onto one `kind|from|to` key.
7. **Cycles.** GitHub forbids `contains` cycles, but snapshots of different ages can still form
   one. The merge breaks it by dropping the older observation and marks the node `conflict`.
   Ancestor walks stop at depth 8 or at the first repeated node. A `blocks` cycle is kept as
   data, and its strongly connected component is marked `cycle: true` so ordering falls back to
   plan order (§7.5).
8. **Hidden and truncated children.** `hierarchy.total` (GitHub's count) is compared with the
   visible list. A difference renders "+N not visible to your GitHub account"; `truncated`
   renders "+N more on GitHub".
9. **Moved or renamed.** When GitHub answers with a different `nameWithOwner` or number than
   requested (a repository rename or an issue transfer), the store keeps the row under the
   requested key, and the merge files its facts under GitHub's canonical key with the requested
   key as an **alias**. Relationships follow GitHub's identity, never a guess, and the chip says
   "moved to `owner/name#n`".
10. **Expiry is not applied here.** The bytes must depend on the database alone (§6); the
    frontend hides observations older than 7 days.

### 4.6 The merged graph (`GET /api/issues`, version 1)

```json
{
  "version": 1,
  "nodes": [
    { "key": "shariqh/agent-inbox#117", "repo": "shariqh/agent-inbox", "number": 117,
      "title": "Integrate Agent Inbox with Agent Host Protocol", "state": "OPEN", "state_reason": null,
      "children_total": 10, "children_completed": 0, "observed_at": "2026-10-19T21:50:02.114Z" }
  ],
  "edges": [
    { "kind": "contains", "from": "shariqh/agent-inbox#117", "to": "shariqh/agent-inbox#120",
      "position": 2, "observed_at": "2026-10-19T21:50:02.114Z" },
    { "kind": "blocks", "from": "shariqh/agent-inbox#119", "to": "shariqh/agent-inbox#120",
      "observed_at": "2026-10-19T21:50:02.114Z" }
  ],
  "roots": [
    { "key": "shariqh/agent-inbox#120", "fetched_at": "2026-10-19T21:50:02.114Z",
      "checked_at": "2026-10-19T21:50:02.114Z", "error": null,
      "hierarchy": "ok", "dependencies": "ok" }
  ],
  "aliases": {}
}
```

The payload contains no URLs. The frontend builds `https://github.com/<repo>/issues/<number>`
from validated parts (§12).

---

## §5 — Ingestion in the viewer process

### 5.1 Module and process boundary

A new `src/issue-poller.ts` opens with "VIEWER PROCESS ONLY" and follows `src/prstate.ts`
exactly:

- `execFile` with piped streams, never `spawn` with inherited ones;
- `resolveGh()` reused, with the same quieting environment (`GH_PAGER=cat`, `NO_COLOR=1`,
  `GH_NO_UPDATE_NOTIFIER=1`), `GH_TIMEOUT_MS` and `GH_MAX_BUFFER`;
- writes only through `store.ts`, and the refresh never rejects.

It imports `store.ts`, `src/issue-graph.ts`, `public/issue-key.js` and the shared `gh` helpers
of `src/prstate.ts` (`resolveGh`, `classifyError`, the timeout and buffer limits), which is
itself viewer-only. The boundary test in
`test/prstate.test.ts` ("the poller runs in the viewer process only") extends to it: no file of
the stdio server graph (`src/mcp.ts`, `mcp-server.ts`, `store.ts`, `scope.ts`, `infer.ts`,
`group.ts`, `hook.ts`, `hook-cli.ts`, plus `shape.ts`) may import it.

### 5.2 One tick, two budgets

`src/viewer-server.ts` passes the issue refresh to the existing poller, which runs it **after**
`refreshOnce` inside the same `busy` window. For example `startPrPoller(db, { after:
refreshIssueRelations })`; the `startPrPoller(db)` source pin in `test/prstate.test.ts` moves
with it. As a result:

- this viewer never runs two `gh` processes at once;
- a slow tick delays both refreshes and never overlaps the next tick;
- the budgets are separate, so neither refresh can starve the other.

| Budget | PR refresh (unchanged) | Issue refresh (new) |
|---|---|---|
| Calls per tick | `MAX_PER_TICK` = 4 `gh pr list` | `MAX_ISSUE_CALLS_PER_TICK` = 1 `gh api graphql` |
| Targets per call | 1 branch | `ISSUE_BATCH` = 10 roots |
| Target cap | `MAX_LINK_TARGETS` = 50 | `MAX_ISSUE_TARGETS` = 50 |
| Worst-case GraphQL points per hour | about 240 | **60**, which is 1.2% of a 5,000-point hourly budget |

Typical use costs a few points per hour, because the TTLs below skip almost every tick.

**Relationships cannot come from the existing `gh pr list` call.** Its JSON exposes
`closingIssuesReferences` (`id`, `number`, `repository { name, owner { login } }`, `url`) but
nothing about those issues' parents, children or dependencies, and it runs once per branch. The
PR refresh keeps supplying the closing-issue identity; the new call supplies the relationships.

### 5.3 Targets

`wantedIssues(entities, links)` (pure) takes the effective issue (`issueKeyFor`) of every open
item, active plan and active plan row in a project that is not closed. It deduplicates by key
and keeps the 50 most recently updated. Archived plans and resolved items stop refreshing but
keep their cache, so a peek at a closed project still shows the last known state (as #32 does
for PR chips).

### 5.4 Due order (pure, mirrors `dueTargets`)

`dueIssueRoots(wanted, snapshots, links, nowMs)`:

- a key never fetched is due first;
- otherwise a key is due when its age reaches its TTL: open issue 10 min, closed issue 60 min,
  soft error (`offline`, `rate-limit`, `gh-failed`) 10 min, hard error (`no-gh`, `auth`,
  `forbidden`, `not-found`) 60 min;
- **merge nudge:** a key is due at once when a source link whose closing issue is that key, or
  appears in that key's snapshot, reached `MERGED` or `CLOSED` with `fetched_at` after the key's
  `checked_at`. Because the issue refresh runs right after the PR refresh, a merge the PR
  poller notices reaches the rollup in the same tick;
- order: never fetched, then nudged, then oldest `checked_at`; slice to `ISSUE_BATCH`.

### 5.5 The query

One constant document; aliases are generated from indices (`r0` to `r9`) and never from data.

```graphql
query Relations($o0: String!, $n0: String!, $k0: Int!) {   # … through $o9/$n9/$k9
  r0: repository(owner: $o0, name: $n0) { issue(number: $k0) { ...Root } }
}

fragment Node on Issue { number title state stateReason repository { nameWithOwner } }

fragment Root on Issue {
  ...Node
  subIssuesSummary { total completed }
  issueDependenciesSummary { blockedBy totalBlockedBy blocking totalBlocking }
  parent {
    ...Node
    subIssuesSummary { total completed }
    subIssues(first: 100) { nodes { number repository { nameWithOwner } } }  # position only
    parent { ...Node parent { ...Node parent { ...Node parent { ...Node parent { ...Node parent { ...Node } } } } } }
  }
  subIssues(first: 100) { totalCount pageInfo { hasNextPage } nodes { ...Node subIssuesSummary { total completed } } }
  blockedBy(first: 50) { totalCount pageInfo { hasNextPage } nodes { ...Node } }
  blocking(first: 50)  { totalCount pageInfo { hasNextPage } nodes { ...Node } }
}
```

```text
gh api --hostname github.com graphql -f query=<constant> \
  -f o0=<owner> -f n0=<name> -F k0=<number> …
```

- Owner and name go only through `-f` (raw strings). `-F` converts types and reads a file when
  a value starts with `@`.
- Numbers go through `-F` after integer validation.
- `--hostname github.com` stops `GH_HOST` from redirecting the call; `parseRepoSlug` only ever
  produces github.com slugs.
- The parent's child list is fetched with identities only, to compute `position`. It never
  becomes sibling edges, which keeps the graph to what is needed.

### 5.6 Parsing: `parseIssueBatch(stdout, requested)` (pure)

- Accepts stdout from a success **and** from a non-zero exit (partial errors). Unparseable
  output fails the whole batch through the existing `classifyError`.
- An error at `[rN]` or `[rN, "issue"]` fails that root only: `NOT_FOUND` → `not-found`,
  `FORBIDDEN` (including `saml_failure`) → `forbidden`, `RATE_LIMITED` → `rate-limit`, anything
  else → `gh-failed`.
- An error under `[rN, "issue", "subIssues" | "parent"]` makes only the hierarchy
  `unavailable`; one under `blockedBy`/`blocking` makes only the dependencies `unavailable`.
- Every node is validated: slug, integer number, `state` in `{OPEN, CLOSED}`, `state_reason` in
  `{COMPLETED, NOT_PLANNED, DUPLICATE, REOPENED}` or null. Titles are strings clipped to 300
  characters, like `TITLE_MAX`. An invalid neighbour is dropped, never coerced.
- Self-links are dropped and duplicates collapsed. Lists are capped at GitHub's limits (100
  children, 50 per dependency direction), with `truncated` set when `hasNextPage` is true.

### 5.7 Writes

Each root is written with `upsertIssueSnapshot` or `recordIssueFailure`, carrying the time the
`gh` call **started**. The store refuses a write from an attempt older than the stored success.

### 5.8 Freshness policy

| Time since the last successful fetch | What renders |
|---|---|
| Under 30 min | Normal. The tooltip says "checked Xm ago" (`checked_at`). |
| 30 min to 7 days | Stale: dimmed chips and edges, "as of 2h ago", plus the error reason when there is one ("gh is not logged in — showing what it last saw", reusing `ERROR_LABEL`'s wording). |
| Over 7 days | Hidden: the plain `#120` chip only. The expanded block says "Relationships unavailable — last seen 9d ago". |
| Unchecked for 30 days | The snapshot row is pruned. |

The issue chip, plan, row, item and any approval request are never hidden by this policy.

---

## §6 — Viewer API, conditional snapshots and payload size

- **Route.** `GET /api/issues` is registered through `conditionalSnapshot(db, 'issues', () =>
  buildIssueGraph(listIssueSnapshots(db)))` in `src/viewer.ts`. Its bytes depend only on the
  database, because expiry happens in the browser; that is the precondition for the store-token
  cache. CLAUDE.md's list of retained representations grows from five to six.
- **Existing snapshots stay byte-stable.** `/api/items`, `/api/items?scope=attention`,
  `/api/items/history`, `/api/boards` and `/api/boards/archived` carry no GitHub data, so a
  relationship refresh never changes their bytes and clients keep receiving 304. The only new
  fields in `/api/boards` are the agent-authored links (about 40 bytes per linked row).
- **Re-serialization.** Every poller write still moves `data_version`, so each retained
  representation is rebuilt once on its next read, as PR poller writes already cause. Its ETag
  is unchanged when its bytes are unchanged.
- **Frontend.** `public/snapshots.js` gains a `/api/issues` validator (version 1; arrays of
  string-keyed nodes, edges and roots). `load()` adds it as an eighth concurrent read with the
  `/api/links` fallback: any failure, including a 404 from an older viewer, yields an empty graph
  and the page renders exactly as before. The boot-marker and generation rules are unchanged.
- **Size.** The ten-issue #117 family measured 6.2 KB merged (18.5 KB raw GraphQL). The bound
  is 50 roots × (7 ancestors + 100 children + 100 dependencies), about 10,350 observations,
  which deduplication usually collapses to a few dozen nodes. To keep a pathological hub under
  about 500 KB, `MAX_GRAPH_NODES` = 2,000 trims deterministically: first dependency neighbours
  that are neither roots nor linked rows, then children beyond each root's first 50. It sets
  `trimmed: true`. A body is transferred only when a refresh changes it, at most once per
  poller tick.

---

## §7 — Presentation

New chip builders live **inside `public/source.js`**, so every href still comes from
`chipHtml()`. The pure view model (indexes, breadcrumbs, ownership, grouping, freshness) lives
in a new `public/issues.js`, and the Plan Flow model stays in `public/mission.js`.

### 7.1 Compact chips (rows, cards, plans)

`sourceChipsHtml()` renders, in order: the parent chip, the issue chip (existing), a parent's
progress, a waits-on chip, then the PR chip and Preview (existing).

| Case | Compact rendering |
|---|---|
| Child | `#117 › #120`; the parent is its own anchor; only the nearest parent here |
| Parent with children | `#117 · 0/10` |
| Waits on open issues | `waits on #119`, or `waits on 3` for several; closed blockers are not shown compactly |
| Stale | Same chips with `tone-stale` (dimmed); the tooltip says "as of …" |
| Expired, unavailable or unknown | Today's chip only |

The tooltip is plain text, escaped into `title=`: parent title and progress, waits-on titles,
the unblocks count, and a freshness or error line. The `tabbable` rule from #30 is unchanged:
chips in list rows stay out of the roving tab order.

### 7.2 Expanded SOURCE block

`sourceBlockHtml()` adds:

- the full parent trail, up to eight levels (`cli/cli#14563 › #14529 › #14523` in §18);
- **Sub-issues** in GitHub's order with a state mark (● open, ✓ completed, ⊘ not planned,
  ⧉ duplicate), title, local owner (§7.4), and "+N not visible" or "+N more on GitHub";
- **Waits on** and **Unblocks** lists with titles and states;
- a freshness line.

### 7.3 Plans grouped by parent issue

`renderBoards()` calls a pure `groupPlansByParent(boards, graph)`:

- A plan's group is the parent of its effective issue. A plan whose own issue is that parent
  (an umbrella plan) leads the group.
- Groups keep the position of their first member in today's order, so recency still decides
  the order between groups. Inside a group the umbrella comes first, then GitHub's child order,
  then today's order.
- `paginateWithPending` pages the flattened list. A group that spans pages repeats its header
  with "(continued)".
- Plans with no known parent stay ungrouped in place. Archived plans and lingering logic are
  unchanged.
- The header is a parent chip, the GitHub title and "0 of 10 done on GitHub". It is not a card:
  it has no expanded state and cannot hold a draft.

**Inside a plan,** when rows link issues under two or more different parents, the row table
gets thin parent sub-headers; otherwise nothing changes (Q3).

### 7.4 Sub-issue strip and current ownership

A plan whose effective issue has children gets a "Sub-issues on GitHub · N of M done" strip
under its source chips, outside `<summary>` for the same reason as #30. For each child:

- the chip and title link to GitHub;
- **current ownership** comes from local entities linked to that child (rows that link it,
  plans whose effective issue it is, open items). It reads the `attentionEntries()` result the
  render already computes and changes nothing. The labels are "Waiting on you" (a linked entry
  needs the human), "With claude-code · <plan>" (linked work is active), "Done here" (every
  linked row is `done` or `na`) and "No local work". Clicking an owner focuses that plan or
  item in the app (`focusItem`);
- GitHub assignees are not shown in v1 (Q7).

GitHub's child progress stays separate from the plan's own progress bar, which still measures
the agent's rows. A row with an issue link shows that issue's chip in the row's note cell and in
its card; the row card's source identity is the plan's, with the row's issue in place of the
plan's.

### 7.5 Plan Flow with typed edges

`buildMission(board, graph)` stays pure and plan-scoped. It additionally returns:

- `root.issue`: the plan's effective issue, its ancestors (a breadcrumb on the root card) and
  its child progress;
- per path: `issue` (the row's link), `contains: true` when that issue is a child of the plan's
  issue, and `waitsOn` / `unblocks` as path indexes, or keys for issues no row links;
- `ghosts`: children of the plan's issue that no row links, shown in a "Not in this plan" fold;
- `order`: a stable topological order over the plan's `blocks` edges (Kahn's algorithm, ties by
  row position). Rows in a cycle keep plan order and show "circular dependency on GitHub".

`missionPathEl` renders the two kinds differently:

| | Containment | Sequencing |
|---|---|---|
| Model | `contains: true` | `waitsOn` / `unblocks` |
| Visual | Solid left rail, "Part of #117" | Dashed accent link chip, "Waits on: AHP adapter (#119)" |
| Class | `.mission-edge-contains` | `.mission-edge-waits` |
| Accessible name | "Sub-issue #120 of #117" | "Waits on step AHP adapter (#119)" |
| Activation | None | Moves focus to the blocking step inside the flow; an issue with no step is a GitHub chip |

The lightbox rules hold: the graph stays mounted and leaving for Plans still needs the explicit
button. `result` remains `outcome` or `next_after` text only. A row whose `next_after` reads
"after #119" creates no edge, and a test pins that. Issues in other plans are external chips,
never cross-plan edges, so Plan Flow stays plan-scoped.

---

## §8 — Row status: a dependency is never `blocked`

The viewer never derives, overrides or suggests a row status from GitHub. The agent contract
(§11) maps dependency situations to statuses:

| Situation | Status the agent sets | Viewer shows | Attention |
|---|---|---|---|
| The row's issue waits on an open issue; no work has started | `tracked` | Neutral "waits on #119" | None |
| Work started and is paused on the dependency | `partial` | Neutral "waits on #119" | None |
| The blocker closes | Unchanged until the agent moves it | The waits-on chip disappears on refresh | None |
| The row also needs an independent human action, such as approving a design | `blocked`, with `note`, `next_step`, `action_owner` and `impact` | The blocked mark and "waits on #119" | The existing blocked-row rule only |
| An agent marks `blocked` only because of a dependency | A contract violation the viewer cannot detect | The blocked mark and "waits on #119", so the mistake is visible | As the agent declared it |

---

## §9 — Attention invariants

- `public/attention.js`, `public/relay.js`, `electron/reply-watch.cjs` and the
  `/api/items?scope=attention` projection stay byte-unchanged.
- Relationship data is passed to no attention function. It can neither add an entry (a row
  waiting on #119 never enters Needs you) nor remove one (a question about #120 stays).
- Ownership labels **read** the attention set the render already computed and never feed back
  into counts.
- Dependency chips use neutral tones, never the `bad` tone, never the blocked status mark, and
  never the word "Blocked" (Q2).
- The `board_upsert`, `board_row` and `board_advance` descriptions, the `status` field's
  `.describe()`, and `docs/reporting-snippet.md` gain one sentence: "Waiting on another GitHub
  issue (GitHub's 'blocked by') is tracked or partial, never blocked."
- Closed projects (#32) are skipped by the issue poller; cached relationships still render when
  the human peeks.

---

## §10 — Search and deep links

- **Index** (`public/search-index.js`): items and plans gain fields "Issue" (`owner/name#N` and
  `#N`), "Issue title" and "Parent issue" (key and title). Plans add "Sub-issue" for each child
  and rows add "Row issue". Each field records an `issueKey` and a role (`self`, `parent`,
  `child`, `waits-on`, `unblocks`) beside the existing `rowId`. GitHub titles are searched as
  text and highlighted with the existing text-node highlighter.
- **Navigation:** a result carries `{ targetId, rowId?, field, issueKey?, issueRole? }`.
  `focusItem` reuses `source.rowId` (`openRows`, `showDoneBoards`), and `findSearchJumpSource`
  selects `[data-issue-key="…"][data-issue-role="…"]` with `CSS.escape` inside the target, so a
  hit on "AHP adapter" lands on that plan's row and highlights its `waits on #119` chip, not
  another chip naming the same issue.
- **Hash grammar** (`public/badge.js`): `#item/<id>` is unchanged. Optional `/row/<rowId>` and
  `/issue/<role>/<key>` segments are each `encodeURIComponent`-encoded.
  `focusHashFor(id, { rowId, issueKey, issueRole })` writes them during in-app navigation, so a
  reload lands on the same row and chip. Electron's existing one-argument `focusHashFor(id)`
  calls are unaffected. An older build reading a new-form hash finds no item with that id and
  does nothing.
- **Preserved:** filter resets, `forceRender`, `pendingFocusId`, the press guard, draft
  protection and the #184 history retry.

---

## §11 — Agent-facing contract (MCP)

### Writes (PR3)

- `board_upsert({ title, issue?, rows: [{ …, issue? }] })`: the top-level `issue` pins the plan
  and `rows[].issue` links a row. `board_row({ …, issue? })` links that row.
- Accepted forms: `owner/name#123`; `#123` or `123`, resolved at write time against the
  session's `repo` and refused when the session has none; or
  `https://github.com/owner/name/issues/123`. Anything else is refused with an error that lists
  the accepted forms. The stored value is normalized.
- Omission preserves the stored link and `''` clears it, as for every other agent-owned field.
- Changing a row link is row content: it bumps the row `revision` and `updated_at`. Changing the
  plan pin bumps the board revision.
- Field description: "Links this plan or row to a GitHub issue for display only. Relationships
  come from GitHub, and Agent Inbox never edits them. Waiting on another issue is tracked or
  partial, never blocked."

### Reads

- PR3: plans and rows echo `issue` as the normalized string.
- PR6 (optional, Q5): titled `board_get` and `pending` rows add a compact `issue_rel`, read from
  the cache through `store.ts` and merged by `src/issue-graph.ts`. It contains keys and counts
  only, no titles or bodies (the #42 payload diet), and is omitted when unknown. The MCP process
  stays network-free: it reads what the viewer cached.

```json
{ "parent": "shariqh/agent-inbox#117", "children": { "total": 0, "done": 0 },
  "waits_on": ["shariqh/agent-inbox#119"], "checked_at": "2026-10-19T21:50:02.114Z", "stale": false }
```

### Mutation

None (Q4). Agents already have `gh issue edit --parent`, `--add-sub-issue` and
`--add-blocked-by`, and the viewer shows their changes on the next refresh. If a mutation is
ever added, it must live in the viewer process behind an explicit human action with a named
action, carry exact node ids, and re-read the current state immediately before writing, because
GitHub offers no revision precondition for relationships. It must never reorder, close or
unlink anything implicitly.

---

## §12 — Security

- **Text.** Titles are third-party text: a dependency can point at any public issue, and that
  issue's author controls its title. Every title goes through `esc()` or `textContent`; tooltips
  go through an escaped `title=`.
- **URLs.** Hrefs are built from a validated slug and an integer as
  `https://github.com/<repo>/issues/<n>`, then passed through `chipHtml()` → `anchorHtml()` →
  `safeHttpUrl()` → `esc()`. GitHub's `url` fields are never requested. The new builders sit in
  `public/source.js`, so the one-href-path rule from #30 still holds.
- **Attributes and selectors.** `data-issue-key` and `data-issue-role` go through `esc()`;
  selectors use `CSS.escape`.
- **Subprocess.** `execFile` without a shell, a constant query document, values only as
  variables, `-f` for strings, `-F` only for validated integers, `--hostname github.com`, piped
  streams, a timeout and a buffer cap.
- **Surface.** No new write route, no token handling (`gh` owns authentication), and nothing
  enters the MCP import graph that can reach the network.
- **Privacy.** Private issue titles are cached in the local hub, as PR titles already are. Hosted
  mode (#8) must treat them as sensitive.

---

## §13 — Test strategy

No test makes a network call. Fixtures are trimmed copies of the live responses in §18.

| Area | File | Covers |
|---|---|---|
| Store | `test/issue-store.test.ts` | Additive migration on a pre-#103 database; NOCASE key deduplication; v1 validation on write and read; an older attempt cannot overwrite a newer success, and its failure is ignored; a failure keeps the last good snapshot; prune at 30 days; `listIssueEntities` respects open, active and closed-project rules; omission preserves and `''` clears pins and links; annotations and handled marks survive |
| Parse and policy | `test/issue-poller.test.ts` | Success; `NOT_FOUND` per alias and per issue; a PR number; SAML `FORBIDDEN`; a dependency field error that keeps the hierarchy; unparseable stdout; invalid slugs, states and oversized titles dropped; self-links and duplicates; `hasNextPage` truncation; hidden-children counts; a moved issue becomes an alias; `dueIssueRoots` tables including the merge nudge and caps; never rejects; recorded argv (`-f`, `-F`, `--hostname`); the boundary test and header pin |
| Merge | `test/issue-graph.test.ts` | Freshest observation decides the parent; one parent after a move; child order; `blocks` freshness; a `contains` cycle across stale snapshots; a `blocks` cycle; depth bound of 8; `a/x#5` never merges with `b/y#5`; case-insensitive merge; trimming |
| Viewer | `test/viewer.test.ts` | `/api/issues` 200 then 304; invalidation after a poller write; `/api/items` and `/api/boards` ETags unchanged by a snapshot write |
| Pure presentation | `test/source.test.ts`, `test/issues.test.ts` | Hostile titles (`<img onerror>`, quotes inside `title=`); hrefs are always constructed; stale and expired states; tone never `bad`; copy never "Blocked"; `issueKeyFor` precedence (pin, then PR, then inferred); plan grouping and continued headers |
| Search and hashes | `test/search-index.test.ts`, `test/badge.test.ts` | Issue fields carry `issueKey` and role; cross-repo keys stay distinct; new hash segments round-trip and an old-form hash still parses |
| Plan Flow model | `test/mission.test.ts` | Typed edges; topological order; cycle fallback; `next_after` creates no edge; ghosts |
| DOM | `test/dom/issue-relations.test.ts` | Chips and breadcrumbs from fixtures; grouping with "(continued)" headers; strip ownership; Plan Flow classes and accessible names; a draft in an open row survives a poll that changes relationships; focus kept; `#item/<plan>/row/<row>/issue/<role>/<key>` opens the row and highlights the chip; a search hit on a child title lands on its plan; a 404 from `/api/issues` renders exactly as before |
| Attention | `test/dom/issue-attention.test.ts` plus a source pin | The same fixture with and without a graph gives identical badge, title, tab counts, Needs-you rows and dock projection; `public/attention.js` names no issue field |
| MCP | `test/mcp.integration.test.ts` | Every accepted `issue` form; refusals; omission and clearing; `tools/list` carries the dependency sentence; PR6's compact summary |
| Exports | `test/dead-exports.test.ts` | Every new export is reachable from production code |

---

## §14 — Delivery: phased PRs

Sizes are rough production / test lines. Every PR is read-only toward GitHub, and with no `gh`
or no relationships the UI renders exactly as today (pinned in PR2).

| PR | Scope | Prod | Tests | Needs |
|---|---|---|---|---|
| **PR1** Ingestion and store | `issue_snapshots` and its store API; `src/issue-poller.ts`; `src/issue-graph.ts`; `public/issue-key.js`; `/api/issues`; poller wiring; CLAUDE.md and copilot-instructions updates. No UI. Can split into 1a (store, merge, route) and 1b (poller). | ~650 | ~700 | Q1, Q6, Q8 |
| **PR2** Chips and breadcrumbs | `load()` read and validator; parent, progress and waits-on chips; SOURCE block sections; freshness labels; CSS | ~350 | ~450 | PR1, Q2 |
| **PR3** Explicit links | Plan pin and row link columns; MCP schemas and descriptions; reporting snippet and host instructions; row chips | ~250 | ~350 | PR1, Q1 |
| **PR4** Grouping, strip, search, deep links | `groupPlansByParent`; sub-issue strip with ownership; in-plan sub-headers; search fields; hash grammar | ~400 | ~450 | PR2, PR3, Q3, Q7 |
| **PR5** Plan Flow typed edges | `buildMission(board, graph)`; `missionPathEl` rendering; CSS | ~300 | ~350 | PR3 |
| **PR6** (optional) Agent summaries | Compact `issue_rel` on titled `board_get` and `pending` | ~120 | ~150 | PR1, PR3, Q5 |

This differs from #103's suggested sequence in one way: PR1 ingests dependencies together with
the hierarchy, because they come from the same call at no extra cost and their parse status is
independent (Q8). Dependency UI stays separable: its chips land in PR2 and its Plan Flow edges
in PR5, and either can be held back without touching the hierarchy.

---

## §15 — Open questions for the owner

Each has a recommendation; "Gates" names the first PR that needs the answer.

**Q1 — How do plans and rows link to issues?** Gates PR1 (precedence) and PR3.
*Recommended:* add the explicit plan-level `issue` pin and row-level `issue` link (§4.2, §11).
*Alternatives:* keep only today's inferred stamps, so rows can never link and umbrella plans
follow the last writer's branch; or parse labels such as "#118 …", which #103's no-inference
rule rejects.

**Q2 — What does the UI call a dependency?** Gates PR2.
*Recommended:* "waits on" and "unblocks", with GitHub's terms in tooltips ("GitHub: blocked by
#119"). In this product "Blocked" means "needs you".
*Alternative:* GitHub's own "blocked by" and "blocking", which are familiar but collide with
the Blocked row status.

**Q3 — How far does grouping go?** Gates PR4.
*Recommended:* group plans under their GitHub parent automatically, and add in-plan parent
sub-headers only when a plan's rows span two or more parents (§7.3).
*Alternatives:* a grouping toggle that defaults to off, or grouping only inside Plan Flow.

**Q4 — Should Agent Inbox ever edit GitHub relationships?** Gates nothing in this plan.
*Recommended:* no; agents use `gh issue edit`.
*Alternative:* a later, guarded viewer action under its own issue (§11).

**Q5 — Should agents see relationship summaries?** Gates PR6.
*Recommended:* yes, compact keys and counts on titled `board_get` and `pending` only (§11).
*Alternative:* none; agents run `gh issue view` themselves.

**Q6 — Freshness constants.** Gates PR1.
*Recommended:* open TTL 10 min, closed 60 min, errors 10 and 60 min, stale at 30 min, hidden
after 7 days, pruned after 30 days, 10 issues per call, one call per tick, 50 targets.

**Q7 — What does "current ownership" mean?** Gates PR4.
*Recommended:* Agent Inbox's local ownership only (§7.4).
*Alternative:* also show GitHub assignees, which adds GitHub-authored logins to the payload.

**Q8 — When are dependencies ingested?** Gates PR1.
*Recommended:* in PR1, alongside the hierarchy, with dependency chips in PR2 and Plan Flow
edges in PR5 (§14).
*Alternative:* follow #103's order literally and add dependency fields to the query in a later
PR.

---

## §16 — Risks

1. **Agents keep using `blocked` for dependencies.** It cannot be enforced. Tool descriptions,
   the reporting snippet and the visible "waits on" chip make the mistake obvious, not
   impossible.
2. **Stale rollups read as current.** Mitigated by age labels, dimming, the 7-day hide and the
   merge nudge, but a human can still act on a 25-minute-old count.
3. **GitHub API drift** (renamed fields, new limits). The parser fails closed and its sections
   are independent; the worst case is that relationships disappear and nothing else changes.
4. **Rate-limit pressure** for hubs with many projects. Bounded by 50 targets, 10 per call, one
   call per tick and the TTLs: at most 60 points per hour.
5. **Grouping changes the Plans order**, which may surprise. Recency still orders groups; Q3
   offers a toggle.
6. **Mixed-version processes share one hub.** Columns are additive; older processes ignore them
   and their updates leave them untouched; an older viewer never polls issues; the monotonic
   guard covers two new viewers.
7. **Private titles in the local hub,** the same exposure PR titles already have; flagged for
   hosted mode.
8. **Plan Flow scope creep.** The design keeps list-based typed edges and no graph layout
   engine; a request for a full DAG view should be a separate issue.
9. **Payload growth** in pathological hubs, bounded by `MAX_GRAPH_NODES` and the trim flag.
10. **New hash segments** do nothing in an older open tab until it reloads.

---

## §17 — Rejected alternatives

- **REST per family:** three or four requests per issue, full issue objects, and a 404 that
  cannot tell "no parent" from "no access".
- **`gh issue view --json` per issue:** one subprocess per issue; children carry no repository.
- **Extending `gh pr list`:** it has no relationship fields.
- **Webhooks or `gh webhook forward`:** need a public endpoint or repository admin, plus a new
  long-lived process.
- **A normalized `issue_edges` table now:** needs per-root edge ownership and transactional
  replacement, and the same freshest-observation merge anyway. The API shape keeps it open.
- **Joining relationships into `/api/items` or `/api/boards`:** every refresh would change their
  bytes and defeat their 304s.
- **Deriving row status from dependencies:** row status is agent-owned, and the attention
  invariants forbid it.
- **Parsing labels, notes or tasklists for issue numbers:** #103 non-goal.
- **Creating plans or rows from children:** agents own boards, and the rule that a full upsert
  deletes omitted rows would make generated rows fragile.

---

## §18 — Verification log and sources

Everything marked "verified" or "observed" above was executed on 2026-10-19 with `gh` 2.102.0,
read-only:

- `gh issue view --json` and `gh issue list --json` list `blockedBy`, `blocking`, `parent`,
  `subIssues`, `subIssuesSummary` and `issueType`. `GH_DEBUG=api gh issue view` queries
  `subIssues(first:100)`, `blockedBy(first:50)`, `blocking(first:50)` and `parent{…}`; its child
  nodes carry `id`, `number`, `state`, `title` and `url`, with no repository.
- GraphQL introspection: the `Issue` fields in §2.2, with descriptions;
  `SubIssuesSummary { completed, percentCompleted, total }`;
  `IssueDependenciesSummary { blockedBy, blocking, totalBlockedBy, totalBlocking }` ("open" vs
  "open and closed"); the mutation list in §2.2. `subIssues` takes no `orderBy`.
- REST: `GET repos/cli/cli/issues/14529/sub_issues?per_page=2` returned 200 with
  `Link: <…/repositories/212613049/issues/14529/sub_issues?per_page=2&page=2>; rel="next"`, and
  objects carrying `parent_issue_url`, `sub_issues_summary` and `issue_dependencies_summary`
  (35 top-level keys). `GET repos/cli/cli/issues/14528/parent` returned #14529;
  `GET repos/cli/cli/issues/14563/parent` returned 404 "No parent issue found".
  `GET repos/microsoft/vscode/issues/332085/dependencies/blocking` returned
  `Vivswan/litellm-vscode-chat#443`.
- `shariqh/agent-inbox`: #117 contains #118 to #127; #119 blocks #118 and #120 to #125; #120
  blocks #121; #103 has no relationships; no issue types (user-owned repository).
- `cli/cli`: #14563 contains #14529, which contains #14523 to #14528 (three levels, all closed).
- Partial errors: exit 1 with the full JSON on stdout; `NOT_FOUND` paths as in §2.6;
  `FORBIDDEN` with `saml_failure` for `github/roadmap`. `issue(number: 215)` is `NOT_FOUND`
  (a PR).
- `closingIssuesReferences` from `gh pr list` (PRs #213 and #210): `id`, `number`,
  `repository { id, name, owner { id, login } }`, `url`.
- Cost and size: the §5.5 query with 3 roots cost 1 point and returned 5,735 bytes; dry runs
  cost 1 for 10 and 25 roots and 2 for 40 and 50; 10 live roots took 0.8–0.9 s and returned
  18,550 bytes raw, 6,173 merged (11 nodes, 18 edges). The 7-level ancestor chain cost 1.
- This account's limits: REST core 15,000 per hour, GraphQL 10,000 per hour, search 30 per
  minute.

Sources:

- REST sub-issues: https://docs.github.com/en/rest/issues/sub-issues
- REST issue dependencies: https://docs.github.com/en/rest/issues/issue-dependencies
- Adding sub-issues (100 per parent, 8 levels):
  https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues
- Creating issue dependencies:
  https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies
- Fine-grained token permissions ("Issues"):
  https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens
- GraphQL rate and query limits:
  https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api
- Webhook events (`sub_issues`, `issue_dependencies`):
  https://docs.github.com/en/webhooks/webhook-events-and-payloads
- Changelog 2025-04-09, sub-issues, issue types and advanced search GA:
  https://github.blog/changelog/2025-04-09-evolving-github-issues-and-projects/
- Changelog 2025-08-21, issue dependencies GA, 50 per type:
  https://github.blog/changelog/2025-08-21-dependencies-on-issues/
- Changelog 2025-09-11, cross-organization sub-issues and the parent endpoint:
  https://github.blog/changelog/2025-09-11-a-rest-api-for-github-projects-sub-issues-improvements-and-more/
- Changelog 2026-06-10, `gh` 2.94.0 hierarchy and dependency support:
  https://github.blog/changelog/2026-06-10-manage-sub-issues-types-and-dependencies-from-github-cli/
- Changelog 2025-02-18, tasklist retirement:
  https://github.blog/changelog/2025-02-18-github-issues-projects-february-18th-update/
