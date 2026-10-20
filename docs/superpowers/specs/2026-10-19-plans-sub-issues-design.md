# Design: Plans that model GitHub sub-issues and dependencies (issue #103)

**Date:** 2026-10-19 (revision 4)
**Status:** Approved for implementation. The owner chose the smaller first slice and decided all
eight questions (§15). Revision 2 resolved the six blocking review findings; revision 3 makes the
node cap deterministic and clarifies queue capacity and child counts (§19). PR1a is implemented;
revision 4 records the refinements it made (§19).
**Milestone:** v1.4. Part of #103.
**Scope of this PR:** this document only. Zero source or test changes.

---

## §0 — Summary

1. GitHub natively models **sub-issues** (one parent, up to 100 ordered children, up to 8
   levels) and **issue dependencies** (up to 50 per direction). Both are generally available in
   GraphQL, REST and `gh` 2.94.0+, verified live (§2).
2. **The first slice is the hierarchy only**, in four PRs (§13): PR1a storage, identity, a pure
   hierarchy graph and `/api/issues`; PR1b the poller; PR2 explicit plan and row links; PR3
   breadcrumbs and child progress. Opt-in grouping, dependencies with "waits on" chips, Plan Flow
   edges and sibling context come later.
3. Only the viewer process calls GitHub: at most one `gh api graphql` call per poller tick, for
   up to 10 issues. Each batch size has its own document, and spending follows the cost GitHub
   reports with each response.
4. Every candidate issue waits in one queue, oldest check first, with no cap; §5.4 states its
   capacity and what the UI shows beyond it. An atomic, expiring claim in `store.ts` stops two
   viewers fetching the same issues.
5. Snapshots are cached per repo-qualified issue (`owner/name#123`) in `issue_snapshots`, behind
   `store.ts`.
6. A pure reconciliation builds one graph. A complete child list is also a negative observation,
   so a moved, detached or removed child loses its old parent at the next refresh of either side.
   Ties and cycles resolve deterministically and fail closed.
7. **Soft failures** (offline, rate limit, no `gh`, logged out) keep the last known data, aged and
   dimmed. **Hard failures** (not found, forbidden, answered with another issue) delete that
   issue's relationships and cached titles at once.
8. `GET /api/issues` is its own conditional snapshot, built from explicit refresh and display key
   sets, and it reports any truncation exactly. `/api/items` and `/api/boards` never carry GitHub
   data.
9. Agents link plans and rows explicitly. Links survive `board_advance`, and a PR that closes
   several issues is never guessed. Titled `board_get` gains a short summary; `pending()` is
   unchanged.
10. Nothing touches attention: `public/attention.js` is unchanged, and a dependency (when it
    arrives) is `tracked` or `partial`, never `blocked`. Agent Inbox never edits GitHub.

---

## §1 — What exists today

### 1.1 How an entity names an issue

| Entity | Columns | Written by | Notes |
|---|---|---|---|
| Item | `items.repo`, `items.issue_ref`, `items.head_repo` | `flag` in `src/mcp.ts` | `issue_ref = scope.issueFor(branch)`: `register({ issue })`, else `inferIssueRef(branch)` in `src/infer.ts` (conservative: `30-x`, `feat/30-x`, `issue-30`, `gh-30`) |
| Plan (board) | `boards.repo`, `boards.issue_ref`, `boards.head_repo` | `upsertBoard` / `updateBoardRow` in `src/store.ts` | **Restamped from the writing session on every write** (`boardChanged`), so a plan links to whatever branch its last writer was on |
| Plan row | none | n/a | Rows have no issue identity today |
| PR | `source_links_by_head.issue_number`, `issue_url` | `parsePrPayload` in `src/prstate.ts` | Keeps only the first `closingIssuesReferences` entry, and `issueRef()` (`public/source.js:65-80`) shows it, so a PR that closes several issues shows an arbitrary one |

Rendering goes through one path: `sourceChipsHtml()` and `sourceBlockHtml()` call `chipHtml()`,
which calls `anchorHtml()`, which calls `safeHttpUrl()`, all in `public/source.js`. Issue titles
are always null today because `gh pr list` does not return them, so the chip reads `#30`.

### 1.2 Plans and Plan Flow

- `renderBoards()` and `boardEl()` in `public/app.js` render each plan as a card. Source chips
  sit outside `<summary>` so a chip click cannot also toggle the card (#30).
- `buildMission(board)` in `public/mission.js` returns a root (the plan) plus one path per
  non-`na` row, whose result is the row's `outcome` or `next_after` text only. CLAUDE.md: "Plan
  flow is plan-scoped and draws only plan → row → explicit `next_after`/`outcome` paths; `impact`
  prose never creates a dependency edge."

### 1.3 The live poller

`src/prstate.ts` (VIEWER PROCESS ONLY) is started by `startPrPoller(db)` in
`src/viewer-server.ts`. It ticks every 60 s (`POLL_INTERVAL_MS`), first at 2 s, behind a `busy`
guard. `dueTargets()` is the pure TTL policy (open PR 5 min, no PR 15 min, settled 60 min, soft
error 10 min, hard error 60 min). Each tick takes at most `MAX_PER_TICK` = 4 targets;
`listLinkTargets()` caps targets at 50 and skips closed projects (#32); `pruneSourceLinks()`
drops rows unchecked for 30 days; `refreshOnce` never rejects.

Within a tick, `refreshOnce` (`src/prstate.ts:341-366`) works through its targets one after
another: `gh pr list`, then for an open PR the deployment lookup, the status reads (in parallel)
and a verification re-read. Each call is bounded by the 10-second `GH_TIMEOUT_MS`, so a busy tick
can run for minutes, and the `busy` guard skips ticks meanwhile. Anything queued behind it in the
same tick waits that long too (§5.2).

### 1.4 A real family in this repository

Issue #117 "Integrate Agent Inbox with Agent Host Protocol" has ten sub-issues, #118 to #127.
#119 blocks seven of its siblings (#118 and #120 to #125), and #120 blocks #121 (§18). Agent
Inbox shows none of this today: a plan or question for #120 says `#120` and nothing more. The
examples below use this family.

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
as the parent", which the 2025-09-11 changelog superseded. Nothing here depends on which is true,
because issue identity is always repo-qualified.

### 2.2 GraphQL (introspected on the `Issue` type)

| Field | Type | Arguments | Notes |
|---|---|---|---|
| `parent` | `Issue` | none | `null` when there is no parent |
| `subIssues` | `IssueConnection` | `first/last/after/before`, **no `orderBy`** | Returned in the parent's own order, which `reprioritizeSubIssue` changes |
| `subIssuesSummary` | `{ total, completed, percentCompleted }` | none | An object, so it adds no connection cost |
| `blockedBy`, `blocking` | `IssueConnection` | `orderBy`, `first/last/after/before` | |
| `issueDependenciesSummary` | `{ blockedBy, blocking, totalBlockedBy, totalBlocking }` | none | The field descriptions contrast `blockedBy` with `totalBlockedBy` ("open and closed"), so `blockedBy` counts open blockers |
| `issueType` | `IssueType { name, color, … }` | none | Not used |

The mutations are `addSubIssue`, `removeSubIssue`, `reprioritizeSubIssue`, `addBlockedBy`,
`removeBlockedBy` and `updateIssueIssueType`. This design uses none of them (Q4).

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
  OAuth token needs `repo` for private repositories; any token reads public ones. The local `gh`
  token here has `repo, read:org, gist, user, admin:public_key`. Agent Inbox never handles the
  token; `gh` owns authentication.
- **Write** needs "Issues: write". This design never writes.
- **Private:** GitHub answers only what the token can see. A repository or issue the token cannot
  see is `NOT_FOUND`, exactly like one that does not exist (§2.6).
- **SSO:** an organization enforcing SAML returns `FORBIDDEN` with
  `extensions.saml_failure: true` until the token is authorized (observed for `github/roadmap`).
- **Hidden children:** whether a child the token cannot see still counts in totals is not
  documented. The design compares GitHub's count with the visible list and reports the
  difference rather than relying on either (§4.5, rule 4).

### 2.5 Pagination, ordering, depth and validation

- GitHub's caps equal the page sizes used here: `subIssues(first: 100)` (and later
  `blockedBy/blocking(first: 50)`) always return the whole list, so **no pagination is needed**.
  If `pageInfo.hasNextPage` is ever true, the list is marked truncated and the UI says "+N more
  on GitHub" instead of paging.
- Children keep GitHub's order. Dependency lists (later) have no meaningful order and are sorted
  by key.
- Ancestors come from nested `parent { parent { … } }` objects. Eight levels cost nothing extra
  (objects are not connections) and cover GitHub's 8-level limit.
- **Validation is all-or-nothing.** GitHub validates every declared variable before running a
  query. A document that declares ten non-null variable sets fails as a whole when only three
  are supplied ("Variable $o3 of type String! was provided invalid value", and no `data` at all).
  Each batch size therefore needs its own document (§5.6).

### 2.6 Failure shapes and identity (observed)

- **Partial batch:** `gh api graphql` exits 1, still prints the full `{ data, errors }` JSON on
  stdout and the first message on stderr. Each error carries a `type` and a `path` whose first
  element is the alias.
- Unknown repository: `NOT_FOUND`, path `["r1"]`, "Could not resolve to a Repository with the
  name 'shariqh/no-such-repo-xyz'." Unknown issue: `NOT_FOUND`, path `["r0","issue"]`.
- **A pull request number:** `issue(number: 215)` is `NOT_FOUND`, while `issueOrPullRequest`
  reports `PullRequest`. A branch heuristic or `register({ issue })` can name a PR, so this is a
  real case.
- SSO: `FORBIDDEN` with `saml_failure`, `data.r1 = null`, the other aliases intact.
- REST `GET …/parent` for a top-level issue: HTTP 404 "No parent issue found", which looks the
  same as "no access".
- **Repository redirects are followed.** `repository(owner: "twitter", name: "bootstrap")`
  answers as `twbs/bootstrap`, and `issue(number: 2)` under the old name returns
  `twbs/bootstrap#2` (legacy node id `MDU6SXNzdWUxNDQ2Mzk4`).
- **Issue transfers were not verifiable read-only.** A repo-scoped `issue(number:)` lookup is
  therefore not assumed to follow an issue that moved to another repository (§4.1).

### 2.7 Cost (measured)

| Request | GraphQL points | Time | Bytes |
|---|---|---|---|
| First-slice document (§5.6), 1 / 3 / 10 roots | 1 / 1 / 1 | | 2,542 / 3,668 / 7,615 raw; **5,927 merged** for 10 (11 nodes, 10 edges) |
| Same plus the later dependency and sibling fragments, 10 roots (dry run) | 1 | | |
| Revision 1 document with dependencies, 10 roots | 1 | 0.8–0.9 s | 18,550 raw |
| Revision 1 document, 25 / 40 / 50 roots (dry run) | 1 / 2 / 2 | | |
| `gh pr list` (the existing poller's call) | about 1 (noisy reading) | 0.4–0.6 s | |

These numbers follow GitHub's published formula today, which is not a stable contract. The
poller therefore budgets from the `rateLimit { cost remaining resetAt }` that each response
reports (§5.3).

Primary limits are 5,000 points per hour per user, or 10,000 for GitHub Enterprise Cloud members
(this account reports 10,000 for GraphQL and 15,000 for REST). Secondary limits allow at most
2,000 points per minute on the GraphQL endpoint (one query counts as 1 point) and 100 concurrent
requests, with a 10-second server timeout per request.

### 2.8 Webhooks

`sub_issues` (`parent_issue_added`, `parent_issue_removed`, `sub_issue_added`,
`sub_issue_removed`) and `issue_dependencies` (`blocked_by_added`, `blocked_by_removed`,
`blocking_added`, `blocking_removed`) exist. Both need a public HTTPS endpoint or a GitHub App.
The viewer binds `127.0.0.1` only (`src/viewer-network.ts`), so **polling is the only option**.
Hosted mode (#8) is the seam where a webhook receiver could later replace polling.

### 2.9 Decision

Read relationships with GraphQL through `gh api graphql`, read-only:

- For a batch of up to 10 issues (this design's batch size), one call fetches each issue, its
  ancestors and its ordered children for 1 point at today's formula. The later dependency
  fragment did not raise the dry-run cost (§2.7).
- Field-level errors let one section fail without the others.
- Every node carries an explicit `repository { nameWithOwner }`, and no URL path is built from
  data.

Rejected: `gh issue view --json` per issue (one subprocess per issue; its child nodes carry a URL
but no repository) and REST (several requests per issue, full issue objects, the 404 ambiguity).

---

## §3 — What the human sees in the first slice

All examples use the #117 family.

1. **A child shows its parent.** An agent flags a question on branch `120-ahp-input-requests`.
   Today its chip reads `#120`; now it reads `#117 › #120`. Hovering shows "Parent: #117
   Integrate Agent Inbox with Agent Host Protocol (0 of 10 done) · checked 3m ago". Both numbers
   open GitHub in a new tab. The question stays in Needs you because it is a question.
2. **A parent shows its children.** The agent pins its umbrella plan "AHP integration" to #117.
   The plan's source block lists "Sub-issues on GitHub · 0 of 10 done": #118 to #127 in GitHub's
   order, each with an open or closed mark, its title and its **Agent Inbox activity** ("Active ·
   claude-code · AHP adapter", "Waiting on you", "None here"). Clicking an activity entry opens
   that plan, row or item here.
3. **Rows can name their own issue.** A row the agent linked to #119 shows `#117 › #119` beside
   the row, not the plan's chip.
4. **Closing a child moves the rollup.** When #119's PR merges, the PR poller notices on its next
   check of that PR (every 5 minutes for an open PR) and nudges #119 and #117. The next tick,
   about a minute later, refreshes them, and #117 reads "1 of 10 done". A child closed without a
   linked PR shows within the 10-minute TTL.
5. **Moving, detaching or removing a child is reflected once.** At the next refresh of either the
   child or its old parent, the old breadcrumb disappears. The new parent appears once either side
   reports it. A child is never shown under two parents; no plan is created or deleted, and no
   note changes.
6. **Soft failures age gracefully.** If `gh` is missing, logged out, offline or rate-limited,
   chips keep the last known state labelled "as of 2h ago", dim after 30 minutes and disappear
   after 7 days. The plain `#120` chip and the plan never disappear.
7. **Hard failures end at once.** When GitHub says the issue does not exist (or is a PR), refuses
   access, or answers with a different issue, its relationships and cached titles disappear
   immediately and the chip says "unavailable". A renamed repository keeps working because GitHub
   redirects it.
8. **A PR that closes several issues is not guessed.** The plan or item falls back to its pin or
   branch issue, and the PR tooltip lists every issue the PR closes.
9. **Attention does not change.** The badge, title count, Needs you, dock badge and notifications
   are exactly as before.

**Later (not in this slice):** opt-in grouping of plans by parent, "waits on" / "unblocks"
chips, Plan Flow edges, and sibling context (§12, §13).

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
  storage, the graph, DOM `data-issue-key` attributes and search.
- **Repository redirects become aliases.** Each batch alias reads `nameWithOwner` of the
  repository GitHub resolved. When that differs from the requested slug, and the returned issue
  has the requested number and belongs to that resolved repository, the requested key is an
  alias of the canonical key. This is GitHub's own repository redirect (§2.6).
- **Any other mismatch is `moved`, a hard failure:** a different number, or an issue whose
  repository differs from the resolved one. Issue transfers are not followed. Refreshing by
  GraphQL node id would follow them with proof, and is deferred (§17).

### 4.2 Local links, precedence and certainty

| Entity | Link source | Added in | Precedence |
|---|---|---|---|
| Item | Closing issue of its branch PR, **only when that PR closes exactly one issue** | existing, narrowed (PR1a/PR1b) | 1 |
| Item | `register({ issue })` or `inferIssueRef(branch)`, in `items.repo` | existing | 2 |
| Plan | Explicit pin: `board_upsert({ issue })` → `boards.issue_pin_repo`, `issue_pin_number` | PR2 | 1 |
| Plan | Closing issue of its branch PR, only when exactly one | existing, narrowed | 2 |
| Plan | Branch-inferred `issue_ref`, restamped on every write | existing | 3 |
| Row | Explicit link: `rows[].issue` or `board_row({ issue })` → `board_rows.issue_repo`, `issue_number` | PR2 | only source |

One pure helper, `issueKeyFor(entity, link)` in a new `public/issue-key.js`, decides this for the
chips and the poller alike, the way `linkKey` is shared today. It returns
`{ key, source, certain }`; `issueRef()` in `public/source.js` delegates to it. Only `certain`
identities get relationships (breadcrumbs, progress, activity, later grouping).

**Closing references.** PR1b records every closing reference in a new
`source_links_by_head.closing_refs` column, bound to the row's `fetched_at` (§4.3). A link's PR
identity is then decided as follows:

| `closing_refs` | PR-derived identity |
|---|---|
| Valid, one reference | That issue, `certain` |
| Valid, several references | None: ambiguous. The entity falls back to its pin or branch issue, and the PR tooltip lists every reference |
| Valid, none | None, as today |
| Absent or unbound (written before PR1b, or rewritten since by an older process) | The chip still shows `issue_number` as #30 does, but `certain` is false, so no relationships are drawn |

The ambiguous row is a deliberate change from #30, which showed the first reference. Repository
names come from each reference's `repository { name, owner { login } }`.

**Why the plan pin is needed.** Plans are restamped from the writing session, so an umbrella
plan maintained from branch `119-ahp-adapter` is linked to #119, not #117. The only workaround
today, `register({ issue: 117 })`, would also relink every item that session flags. The pin does
**not** replace `boards.repo` or `issue_ref`, which still drive the PR lookup in
`listLinkTargets()`.

**Never** used as a link source: labels, titles, notes, `impact`, `next_after`, `context`,
comments, checklists, branch names beyond today's `inferIssueRef`, or PR links.

### 4.3 Schema (additive)

All changes use the existing additive pattern in `runMigrations()` (`CREATE TABLE IF NOT EXISTS`
and `ensureColumn`). Nothing is backfilled.

```sql
-- PR1a
CREATE TABLE IF NOT EXISTS issue_snapshots (
  repo TEXT NOT NULL COLLATE NOCASE,   -- requested owner/name; NOCASE folds ASCII, enough for slugs
  number INTEGER NOT NULL,             -- requested issue number
  provider TEXT NOT NULL DEFAULT 'github',
  snapshot TEXT,                       -- JSON below; NULL before the first success and after a hard failure
  fetched_at TEXT,                     -- start time of the attempt that produced `snapshot`
  checked_at TEXT NOT NULL,            -- start time of the latest applied attempt, whatever its outcome
  error TEXT,                          -- NULL | offline | rate-limit | gh-failed | no-gh | auth | not-found | forbidden | moved
  revision INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (repo, number)
);

-- PR1b
CREATE TABLE IF NOT EXISTS issue_refresh_claims (
  repo TEXT NOT NULL COLLATE NOCASE,
  number INTEGER NOT NULL,
  owner TEXT NOT NULL,                 -- random id of one viewer process
  lease_until TEXT NOT NULL,
  PRIMARY KEY (repo, number)
);
-- ensureColumn(db, 'source_links_by_head', 'closing_refs', 'TEXT')
--   JSON { "fetched_at": <the row's fetched_at>, "refs": [{ "repo": "owner/name", "number": 211 }] }

-- PR2
-- ensureColumn(db, 'boards', 'issue_pin_repo', 'TEXT')
-- ensureColumn(db, 'boards', 'issue_pin_number', 'INTEGER')
-- ensureColumn(db, 'board_rows', 'issue_repo', 'TEXT')
-- ensureColumn(db, 'board_rows', 'issue_number', 'INTEGER')
```

`closing_refs` is valid only while its `fetched_at` equals the row's. An older process's
`upsertSourceLink` moves `fetched_at` without touching `closing_refs`, which unbinds it. Failure
and preview writes keep `fetched_at`, so they leave it bound.

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
  "ancestors_end": "top",
  "hierarchy": { "status": "ok", "total": 0, "completed": 0, "truncated": false, "children": [] }
}
```

- `ancestors_end` is `top` when the walk reached an issue with no parent, and `limit` when the
  eighth level still had one (deeper than GitHub allows today).
- Only `ancestors[0]` (the immediate parent) carries `children_total` and `children_completed`;
  higher ancestors carry title and state only (§5.6).
- `hierarchy.status` is `ok` or `unavailable`; an unavailable section yields no observations.
- A later version adds `dependencies` and the sibling list (§12) under a new `v`.
- **Why one JSON snapshot per issue:** it mirrors `source_links_by_head` (one cached answer per
  key) and is replaced atomically. The GraphQL shape can grow without a migration, and `store.ts`
  validates it on write and read, as it does for `options` and `history`. The `/api/issues`
  shape (§4.7) hides the storage choice.

### 4.4 `store.ts` API (still the only door)

| PR | Function | Behavior |
|---|---|---|
| 1a | `upsertIssueSnapshot(db, { repo, number, snapshot, startedAt })` | Validates the v1 shape; applies only when `startedAt` is later than the stored `checked_at` (the **attempt rule**: the most recently started attempt wins, so a late answer from an older attempt is ignored); sets `snapshot`, `fetched_at`, `checked_at`, clears `error`, bumps `revision`, then prunes |
| 1a | `recordIssueFailure(db, { repo, number, error, startedAt })` | Same attempt rule. A soft error keeps the last answer: `snapshot` and `fetched_at`, or a stored hard error's code, so it only advances `checked_at`; a hard error clears both **in the same statement** |
| 1a | `listIssueSnapshots(db)` | Every row, parsed; invalid JSON or shape counts as "no snapshot" and never throws |
| 1a | `listIssueEntities(db)` | Link fields of open items, active and archived plans and (from PR2, when rows gain a link) their rows, with each one's project and whether that project is closed |
| 1a | `pruneIssueSnapshots(db, { nowMs })` | Deletes rows unchecked for 30 days, like `pruneSourceLinks()` |
| 1b | `claimIssueRefresh(db, …)`, `completeIssueRefresh(db, …)` | The lease protocol in §5.5, each one `.immediate()` transaction |
| 1b | `upsertSourceLink` | Also writes `closing_refs`, bound to the `fetched_at` it writes |
| 2 | `upsertBoard`, `updateBoardRow`, `advanceBoardRow` | Pin and row link with the omission rule; `advanceBoardRow` and status changes keep links; human annotation, handled and delivery columns untouched |

### 4.5 Hierarchy reconciliation: `buildIssueGraph(snapshots, keySets)` (pure, `src/issue-graph.ts`)

**Observations.** A snapshot of root R fetched at `t` yields the following. `t` is the start time
of its batch, which every root in that batch shares.

- *Pointer:* `parent(X) = Y` or `parent(X) = none`, for R and for every ancestor whose own
  `parent` field was read (all of them, except the last one when `ancestors_end` is `limit`).
- *Membership:* `parent(C) = R` for each child C in R's list.
- *Absence:* when R's list is complete (hierarchy `ok`, `truncated` false), `parent(Z) ≠ R` for
  every known issue Z that the list does not contain. GitHub never lists an issue the token
  cannot see, and the same token cannot fetch such an issue either, so absence is evidence only
  about issues GitHub shows us.
- *Facts:* title, state and state reason for R, every ancestor read and every child. Child
  counts (`total`, `completed`) exist only for R, its immediate parent and each of its children,
  because §5.6 requests `subIssuesSummary` at exactly those levels. Higher ancestors carry no
  counts.

**Rules.**

1. **Order.** All observations about C's parent are sorted newest first. At equal `t`, pointers
   (rank 0) come before absences (rank 1), and absences before memberships (rank 2).
2. **Decision.** The first pointer or membership in that order is the candidate. It is accepted
   unless an absence sorted before it names the same parent; then C's parent is unknown.
   Observations after the candidate are never consulted, so an older claim cannot return once a
   newer one has been refuted.
3. **Contradictory equals.** If a membership (or, within one batch, a pointer) with the
   candidate's `t` and rank names a different parent, C's parent is unknown and C is marked
   `conflict`.
4. **Children.** P's children are the issues whose accepted parent is P. They take the order of
   P's own freshest list (GitHub's order); accepted children missing from that list follow, by
   key. Counts come from the freshest observation that has them (at equal `t`, in rule 7's
   order): P's own snapshot, a snapshot whose immediate parent is P, or a snapshot listing P as a
   child. When P appears only higher up an ancestor walk, it has no counts and none are shown.
   The UI reports `total − visible` as "not visible to your GitHub account".
5. **Cycles.** GitHub forbids cycles, so a cycle among accepted parents means an observation is
   stale. In each cycle the decision with the oldest deciding `t` is dropped (all of them when
   several share that `t`), and the cycle's issues are marked `conflict`. Ancestor walks stop
   after eight levels or at the first repeated issue.
6. **Hard failures.** A hard failure for K at attempt time `tF` has already deleted K's snapshot
   (§4.4). Every other observation about K with `t ≤ tF` is dropped (facts, K as a child, K as a
   parent), and K is reported unavailable. An observation newer than `tF` counts normally. Every
   cached hard failure counts, displayed or not. A pointer or membership that names K as the
   parent is not dropped but becomes "parent unknown" at its `t` and rank, so an older claim about
   that child cannot return. A later soft failure keeps K's hard error (§4.4) and moves `tF` to
   that attempt, which only ever hides more.
7. **Facts.** The freshest observation of an issue's facts wins. At equal `t`, the issue's own
   root snapshot beats a parent's list, which beats an ancestor walk. Facts never decide
   parentage.
8. **Redirects.** Observations are filed under canonical keys; aliases map requested keys to them
   (§4.1).
9. **Scope.** Only snapshots of roots in the display set are read. The graph emits those roots,
   their accepted ancestors and their accepted children, up to the node cap (§6). Other cached
   rows are inert until pruned.
10. **Time.** The builder applies no expiry, so its bytes depend on the database alone (§6). The
    browser dims and hides by age (§5.8).

**Worked examples** (observations about C, newest first):

| Observations | Result |
|---|---|
| t20 P's complete list omits C · t10 P lists C | Unknown: C left P, and its new parent is not known yet |
| t20 C points to Q · t10 P lists C | Q: C moved |
| t20 C points to none · t10 P lists C | None: C was detached |
| t20 P lists C · t10 C points to none | P: C was added after C's own last refresh |
| t20 P lists C and Q lists C (one batch), nothing from C | Unknown, `conflict` |
| t20 C points to P and P's complete list omits C (one batch) | P: at equal time a pointer outranks an absence |
| t30 B points to A · t20 A points to B | A cycle: the older decision (A → B) is dropped, B's parent is A, and both are `conflict` |

### 4.6 Dependency reconciliation (for the later dependency PR)

Defined now so that the later PR inherits it:

- Observations are about a pair "A blocks B". B's root contributes `blocked_by`; A's root
  contributes `blocking`. A listed pair is positive; a complete list without it is negative.
- The freshest observation of the pair decides. At equal `t` a negative wins: a missing "waits
  on" chip degrades to today's view, while a false one misleads.
- Rule 6 (hard failures) applies to both ends.
- A `blocks` cycle is kept as data, because GitHub may allow one. Its strongly connected
  component is marked `cycle`, and any ordering falls back to plan order, then key.

### 4.7 The merged graph (`GET /api/issues`, version 1)

```json
{
  "version": 1,
  "nodes": [
    { "key": "shariqh/agent-inbox#117", "repo": "shariqh/agent-inbox", "number": 117,
      "title": "Integrate Agent Inbox with Agent Host Protocol", "state": "OPEN", "state_reason": null,
      "children_total": 10, "children_completed": 0, "observed_at": "2026-10-19T22:30:00.000Z" }
  ],
  "edges": [
    { "kind": "contains", "from": "shariqh/agent-inbox#117", "to": "shariqh/agent-inbox#120",
      "position": 2, "observed_at": "2026-10-19T22:30:00.000Z" }
  ],
  "roots": [
    { "key": "shariqh/agent-inbox#120", "refresh": true, "fetched_at": "2026-10-19T22:30:00.000Z",
      "checked_at": "2026-10-19T22:30:00.000Z", "error": null, "failure": null, "children_omitted": 0 }
  ],
  "aliases": { "twitter/bootstrap#2": "twbs/bootstrap#2" },
  "truncated": { "roots": 0, "ancestors": 0, "children": 0, "edges": 0 }
}
```

- `failure` is `null`, `soft` or `hard`. A hard-failed root has no node.
- `refresh: false` marks a root that is displayed but no longer refreshed (a closed project, an
  archived plan).
- Nodes carry `conflict: true` when rule 3 or 5 applied. `children_total` and
  `children_completed` are omitted when no observation carries them (rule 4).
- `truncated` counts exactly what the node cap removed, and `children_omitted` says where
  children were cut (§6). A root the cap omitted is not listed at all.
- There are no URLs: the browser builds `https://github.com/<repo>/issues/<number>` from
  validated parts (§11).

---

## §5 — Ingestion in the viewer process (PR1b)

### 5.1 Module and process boundary

A new `src/issue-poller.ts` opens with "VIEWER PROCESS ONLY" and follows `src/prstate.ts`:

- `execFile` with piped streams;
- the same quieting environment (`GH_PAGER=cat`, `NO_COLOR=1`, `GH_NO_UPDATE_NOTIFIER=1`);
- writes only through `store.ts`, and the refresh never rejects.

It imports `store.ts`, `src/issue-graph.ts`, `public/issue-key.js` and the shared `gh` helpers of
`src/prstate.ts` (`resolveGh`, `classifyError`, `GH_TIMEOUT_MS`, `GH_MAX_BUFFER`). The boundary
test in `test/prstate.test.ts` ("the poller runs in the viewer process only") extends to it: no
file of the stdio server graph (`src/mcp.ts`, `mcp-server.ts`, `store.ts`, `scope.ts`,
`infer.ts`, `group.ts`, `hook.ts`, `hook-cli.ts`, `shape.ts`) may import it.

### 5.2 One tick, two classes, explicit deadlines

```text
every POLL_INTERVAL_MS (60 s), one busy guard:
  t0 = now
  1. issue class: claim and fetch at most one batch (≤ 10 issues). Skipped when nothing is due,
                  when the budget says wait (§5.3), or after t0 + 15 s. The gh call itself is
                  bounded by GH_TIMEOUT_MS (10 s).
  2. PR class:    refreshOnce(db, { deadlineMs: t0 + 45 s }). Each target's work is unchanged,
                  but no new target starts after the deadline.
```

- **Issues go first** because their class is one bounded call. The PR class can no longer push
  it out of a tick (§1.3), and still has at least 30 s to start its targets.
- Rotating the order was considered and is unnecessary for the same reason.
- A tick now ends at most one target's in-flight calls after 45 s; before this change it had no
  end bound.
- **Merge nudges:** a merge the PR class notices in one tick reaches the issue class in the next.
- The `startPrPoller(db)` source pin in `test/prstate.test.ts` moves with this wiring.

### 5.3 Budget from the reported cost

- Every response's `rateLimit { cost remaining resetAt }` is recorded.
- **Token bucket:** `ISSUE_POINTS_PER_HOUR` = 120 per viewer process, refilled continuously. A
  call starts only when the bucket holds at least the last reported cost (1 to begin with). A
  call that fails without reporting is charged the last reported cost.
- **Floor:** when `remaining` falls below `RATE_FLOOR` = 500, the issue class waits until
  `resetAt`. That counts as a soft `rate-limit` failure, so cached data stays and ages.
- The measured 1 point per batch (§2.7) is never assumed; a costlier formula just means fewer
  calls. The bound is 120 points per hour per viewer (2.4% of a 5,000-point budget). One call per
  tick already caps it at 60 calls an hour.

### 5.4 Candidates, TTLs and the fair queue

- **Candidates** are the refresh key set (§6): the `certain` effective issues of open items,
  active plans and (from PR2) their rows, in projects that are not closed. **There is no cap:**
  revision 1's "50 most recently updated" cut would have starved the 51st issue forever.
- **When a candidate is due:**

| State | Due again after |
|---|---|
| Never fetched | Now |
| Nudged: a PR whose `certain` closing issue is this key, or one of this key's listed children, turned `MERGED` or `CLOSED` after this key's `checked_at` | Now |
| Open issue | 10 min |
| Closed issue | 60 min |
| Soft failure: `offline`, `rate-limit`, `gh-failed` | 10 min |
| Soft failure: `no-gh`, `auth` | 60 min |
| Hard failure: `not-found`, `forbidden`, `moved` | 60 min |

- **Queue order:** never fetched, then nudged, then oldest `checked_at`, then key. Every attempt
  advances `checked_at`, moving the key behind every key that has waited longer.
- **Capacity.** One batch of 10 per issue-class run is at most 10 refreshes a minute (600 an
  hour) per viewer, and fewer while the budget waits (§5.3). The queue is recomputed each run
  from `listIssueEntities`, `listSourceLinks` and `listIssueSnapshots`.
- **No key starves only while arrivals stay below that capacity.** "Arrivals" means keys that
  jump the queue: new links and nudges. Below capacity, every due key is served:
  - with no arrivals, N due candidates are all served within ⌈N/10⌉ runs;
  - arrivals take their share of each batch first, so older keys wait longer, but they still
    advance.

  If new links or nudges keep coming faster than 10 per run, they take every slot, and older
  keys can wait until the burst ends. Bursts are bounded in practice: a nudge needs a PR to
  merge or close, and a new key needs a new link. A steady state above about 100 open candidates
  (10-minute TTL) also exceeds capacity; then every key is still served in turn, but less often
  than its TTL.
- **What the UI shows when the queue is over capacity.** Nothing new, and nothing that pretends
  to be fresh. Chips show their real age ("checked 25m ago", "as of 2h ago"), dim after 30
  minutes and hide their relationships after 7 days, exactly as for a soft failure (§5.8). Plain
  issue chips, plans, attention and Live are unaffected.

### 5.5 Claims and leases (two viewers, one hub)

The attempt rule (§4.4) only orders writes; it does not stop two viewers fetching the same batch.
Both a checkout viewer and the packaged app can poll one hub, so PR1b adds a lease:

- **`claimIssueRefresh(db, { owner, queue, limit: 10, leaseMs: 60_000, nowMs })`** runs as one
  `.immediate()` transaction:
  1. delete expired leases;
  2. walk the caller's queue in order;
  3. skip a key that holds a live lease;
  4. skip a key whose stored `checked_at` no longer equals the value the caller saw, because
     another viewer refreshed it since;
  5. insert a lease for up to `limit` keys and return them.
- The poller fetches only the keys it claimed.
- **`completeIssueRefresh(db, { owner, results })`** runs as one `.immediate()` transaction: it
  applies each result under the attempt rule and deletes this owner's leases for those keys.
- `owner` is a random id per viewer process. A crashed viewer's lease expires after 60 s, which
  exceeds `GH_TIMEOUT_MS` plus parsing and writing.
- Leases never appear in `/api/issues`, so they do not change its bytes. Like any write, they
  move `data_version`.
- The PR refresh does not dedupe across viewers today; this design leaves that unchanged.

### 5.6 Query documents

There is one deterministic document per batch size, 1 to 10. A pure `relationsQuery(n)` builds
it from fixed fragments, with aliases `r0`…`r(n-1)` taken from indices and never from data. This
is the verified first-slice document for one root:

```graphql
query Relations1($o0: String!, $n0: String!, $k0: Int!) {
  r0: repository(owner: $o0, name: $n0) { nameWithOwner issue(number: $k0) { ...Root } }
  rateLimit { cost remaining resetAt }
}

fragment Node on Issue { number title state stateReason repository { nameWithOwner } }

fragment Root on Issue {
  ...Node
  subIssuesSummary { total completed }
  parent {
    ...Node
    subIssuesSummary { total completed }
    parent { ...Node parent { ...Node parent { ...Node parent { ...Node
      parent { ...Node parent { ...Node parent { ...Node } } } } } } }
  }
  subIssues(first: 100) { totalCount pageInfo { hasNextPage } nodes { ...Node subIssuesSummary { total completed } } }
}
```

```text
gh api --hostname github.com graphql -f query=<document for n> \
  -f o0=<owner> -f n0=<name> -F k0=<number> …
```

- A single ten-slot document fails validation for any smaller batch (§2.5). `@include`
  directives with placeholder values would work, but every request would then carry ten slots of
  meaningless values; per-size documents are simpler to read and to test.
- Owner and name go only through `-f` (raw strings): `-F` converts types and reads a file when a
  value starts with `@`. Numbers go through `-F` after integer validation.
- `--hostname github.com` stops `GH_HOST` from redirecting the call; `parseRepoSlug` only ever
  produces github.com slugs.
- The later dependency and sibling fragments slot into `Root` without changing this structure
  (§12).

### 5.7 Parsing and identity checks: `parseIssueBatch(stdout, claimed)` (pure)

- Accepts stdout from a success **and** from a non-zero exit (partial errors).
- **Whole-request failures** are soft failures for every claimed key, classified by
  `classifyError` and GraphQL `RATE_LIMITED`. They cover unparseable output, a validation error
  with no `data`, and a process error.
- **Per alias,** an error at `[rN]` or `[rN, "issue"]`:

| GraphQL error | Failure |
|---|---|
| `NOT_FOUND` | `not-found` (hard) |
| `FORBIDDEN`, including `saml_failure` | `forbidden` (hard) |
| `RATE_LIMITED` | `rate-limit` (soft) |
| Anything else | `gh-failed` (soft) |

- A field error under `[rN, "issue", "parent" | "subIssues"]` makes that root's hierarchy
  `unavailable` (no observations) without failing the root.
- Identity is checked as in §4.1: an accepted redirect becomes an alias; anything else is `moved`.
- Every node is validated: slug, integer number, `state` in `{OPEN, CLOSED}`, `state_reason` in
  `{COMPLETED, NOT_PLANNED, DUPLICATE, REOPENED}` or null, and a title clipped to 300 characters
  (like `TITLE_MAX`). An invalid neighbour is dropped, never coerced.
- Self-links (a root listing itself, or an ancestor equal to the root) are dropped. Duplicate
  children collapse, lists cap at 100, and `truncated` follows `hasNextPage`.

### 5.8 Failure classes and freshness

| Class | Codes | Cached data | Retry |
|---|---|---|---|
| **Soft:** we could not ask | `offline`, `rate-limit`, `gh-failed`, `no-gh`, `auth` | Kept and shown with its age | 10 min, or 60 min for `no-gh` and `auth` |
| **Hard:** GitHub answered no | `not-found` (deleted, never existed, a PR number, or invisible to the token), `forbidden` (including SSO), `moved` | **Deleted at once:** relationships and cached titles disappear and the chip says "unavailable" | 60 min |

Soft failures and successful snapshots age the same way:

| Time since the last successful fetch | What renders |
|---|---|
| Under 30 min | Normal; the tooltip says "checked Xm ago" |
| 30 min to 7 days | Stale: dimmed chips, "as of 2h ago", and the reason when there is one ("gh is not logged in — showing what it last saw", reusing `ERROR_LABEL`'s wording) |
| Over 7 days | Hidden: the plain `#120` chip only; the source block says "Relationships unavailable — last seen 9d ago" |
| Unchecked for 30 days | The row is pruned |

The issue chip, plan, row, item and any approval request are never hidden by this policy.

---

## §6 — Viewer API, key sets, conditional snapshots and payload

- **Key sets.** `issueKeySets(entities, links)` (pure, `public/issue-key.js`) returns two sets.
  The route computes them from store reads, and the poller uses the first:
  - the **refresh set:** the `certain` effective issues of open items, active plans and their
    rows, in projects that are not closed;
  - the **display set:** the refresh set, plus the same entities in **closed projects** (kept on
    purpose, so a peek still shows the last known state, as #32 does for PR chips), plus
    archived plans and their rows. History (closed items) keeps today's plain chip and is not in
    either set.
- **Route.** `GET /api/issues` is registered through `conditionalSnapshot(db, 'issues', …)` in
  `src/viewer.ts`. It calls `buildIssueGraph(listIssueSnapshots(db), issueKeySets(…))`. Its bytes
  depend only on the database, the precondition for the store-token cache. CLAUDE.md's list of
  retained representations grows from five to six.
- **Existing snapshots stay byte-stable.** `/api/items`, `/api/items?scope=attention`,
  `/api/items/history`, `/api/boards` and `/api/boards/archived` carry no GitHub data, so
  snapshot and lease writes never change their bytes and clients keep receiving 304. They do
  move `data_version`, so each retained representation is rebuilt once on its next read, as PR
  poller writes already cause. The only new `/api/boards` fields are PR2's agent-authored links.
- **Frontend (PR3).** `public/snapshots.js` gains a `/api/issues` validator (version 1; arrays of
  string-keyed nodes, edges and roots). `load()` adds it as an eighth concurrent read with the
  `/api/links` fallback: any failure, including a 404 from an older viewer, yields an empty graph
  and the page renders exactly as before.
- **Size.** The ten-issue #117 family measured 5.9 KB merged (§2.7). `MAX_GRAPH_NODES` = 2,000
  bounds every response, whatever the hub holds: at most 2,000 nodes, as many edges, one root
  entry and one alias per kept root. That is about 1 MB in the worst case. A body is transferred
  only when it changes.

### The node cap

The builder spends a budget of 2,000 **units**: one per emitted node, plus one per hard-failed
root, whose `roots` entry has no node. Each emitted node has at most one `contains` edge to its
parent, so edges stay within the same bound. Display roots and their ancestors are uncapped, so
the mandatory set alone can exceed the budget, and the builder resolves that deterministically.

1. **Rank** the display roots that have a cached row, by a stable key:
   1. refresh set before display-only (closed projects, archived plans);
   2. open on GitHub, then closed, then unavailable (hard-failed, so without facts);
   3. most recent local activity: the newest `updated_at` among the items, plans and rows that
      link the key;
   4. the key itself, ascending.
2. **Keep whole roots, in rank order.** A root's unit is everything it needs that is not already
   kept: its node (or its entry, when it has no node) and every accepted ancestor. That is at
   most nine units. Roots are kept while their units fit. The first root whose unit does not fit
   is omitted **together with every lower-ranked root**. The cut is always a prefix of the
   ranking, and a chain is never cut partway. At least 222 roots always fit (⌊2,000 / 9⌋), and
   more when ancestors are shared.
3. **Fill children** of the kept roots with what remains: round-robin across them in rank order,
   each root's children in GitHub order, until the budget is spent.

The ranking reads only the database (local `updated_at` and cached GitHub facts), so the cut is
the same on every identical read, and the conditional snapshot stays valid.

The response reports the omissions exactly in `truncated`:

| Field | Counts |
|---|---|
| `roots` | Display roots with cached data that were omitted |
| `ancestors` | Distinct ancestors omitted because only omitted roots needed them |
| `children` | Distinct children omitted |
| `edges` | `contains` edges omitted |

Each omitted node is counted once: an omitted root's own node is that root (`roots`); otherwise
an ancestor some omitted root needed (`ancestors`); otherwise a child (`children`).

A kept root whose children were cut reports `children_omitted`, and its list says "+N not shown".

**Fallback.** An omitted root is not listed in `roots`, so the plans, rows and items that link it
render today's plain chip, exactly like an issue with no data. Nothing else on the page changes.

---

## §7 — Presentation (PR3)

New chip builders live inside `public/source.js`, so every href still comes from `chipHtml()`. A
new pure `public/issues.js` holds the view model: indexes, breadcrumbs, child lists, activity and
freshness.

### 7.1 Chips

`sourceChipsHtml()` renders the parent chip, then the issue chip (existing), then the PR chip and
Preview (existing).

| Case | Compact rendering |
|---|---|
| Child | `#117 › #120`; the parent is its own anchor; only the nearest parent here |
| Parent with children | `#117 · 0/10` |
| Stale | The same chips with `tone-stale` (dimmed); the tooltip says "as of …" |
| Unavailable (hard failure) | The issue chip alone; the tooltip says why ("GitHub says this issue does not exist or is not visible", "GitHub denied access (SSO?)", "GitHub answered with another issue — update the link") |
| Expired, no data, or not `certain` | Today's chip only |

The tooltip is plain text escaped into `title=`. The `tabbable` rule from #30 is unchanged: chips
in list rows stay out of the roving tab order. A row with its own link (PR2) shows its issue's
chip in the row's note cell and card instead of the plan's.

### 7.2 Source block

`sourceBlockHtml()` adds:

- the full parent trail, up to eight levels, with titles and states (for example
  `cli/cli#14563 › #14529 › #14523`); only the immediate parent shows progress;
- for an issue with children, **"Sub-issues on GitHub · N of M done"**: GitHub's order, a state
  mark (● open, ✓ completed, ⊘ not planned, ⧉ duplicate), the title, its Agent Inbox activity
  (§7.3), and "+N not visible to your GitHub account", "+N more on GitHub" or "+N not shown"
  where they apply;
- a freshness or failure line.

GitHub's child progress stays separate from the plan's own progress bar, which still measures the
agent's rows.

### 7.3 Agent Inbox activity (Q7)

For each child, the label summarizes local entities whose `certain` key is that child: rows that
link it, plans whose effective issue it is, and open items.

| Label | Meaning |
|---|---|
| "Waiting on you" | One of them is in the `attentionEntries()` result the render already computes |
| "Active · claude-code · AHP adapter" | The most recently updated open item, active plan or not-done row |
| "Done here" | Every linked row is `done` or `na`, with no open item |
| "None here" | Nothing local links this child |

Clicking a label opens that plan, row or item through the existing `focusItem(id, { rowId })`
path, preserving its poll, draft and focus rules. The label reads attention and never feeds
anything back.

### 7.4 Navigation in this slice

In-app navigation from the new surfaces lands on the exact plan and row. Searching by issue key
or GitHub title, and row-level deep-link hashes, come with sibling context (§12.4).

---

## §8 — Row status: a dependency is never `blocked`

The viewer never derives, overrides or suggests a row status from GitHub. PR2 adds this contract
sentence to the `board_upsert`, `board_row` and `board_advance` descriptions, to the `status`
field's `.describe()` and to `docs/reporting-snippet.md`: "Waiting on another GitHub issue
(GitHub's 'blocked by') is tracked or partial, never blocked." Agents can see GitHub
dependencies through `gh` even before Agent Inbox displays them.

| Situation | Status the agent sets | What the viewer shows (once dependencies ship) |
|---|---|---|
| The row's issue waits on an open issue; no work has started | `tracked` | A neutral "waits on #119" |
| Work started and is paused on the dependency | `partial` | A neutral "waits on #119" |
| The row also needs an independent human action | `blocked`, with `note`, `next_step`, `action_owner` and `impact` | The blocked mark and "waits on #119" |
| An agent marks `blocked` only because of a dependency | A contract violation the viewer cannot detect | The blocked mark and "waits on #119", so the mistake is visible |

---

## §9 — Attention invariants

- `public/attention.js`, `public/relay.js`, `electron/reply-watch.cjs` and the
  `/api/items?scope=attention` projection stay byte-unchanged.
- Relationship data is passed to no attention function. It can neither add an entry nor remove
  one.
- Agent Inbox activity labels **read** the attention set the render already computed and never
  feed back into counts.
- Relationship chips use neutral tones, never the `bad` tone, the blocked status mark or the word
  "Blocked".
- Closed projects (#32) are not refreshed; their cached relationships still render on a peek.

---

## §10 — Agent-facing contract (PR2)

### Writes

- `board_upsert({ title, issue?, rows: [{ …, issue? }] })`: the top-level `issue` pins the plan,
  and `rows[].issue` links a row. `board_row({ …, issue? })` links that row.
- **Accepted forms:**
  - `owner/name#123`;
  - `#123` or `123`, resolved at write time against the session's `repo` and refused when the
    session has none;
  - `https://github.com/owner/name/issues/123`.

  Anything else is refused with an error that lists the accepted forms. The stored value is
  normalized.
- **Safeguards (Q1):**
  - Omission preserves the stored link and `''` clears it, as for every agent-owned field.
  - `board_advance` keeps the row's link (it archives the action, not the link).
  - A move into `blocked` keeps the link.
  - A PR that closes several issues is never guessed (§4.2); the agent can pin explicitly.
- A link change is row content: it bumps the row `revision` and `updated_at`. A pin change bumps
  the board revision.

### Reads (Q5)

- Plans and rows echo `issue` as the normalized string.
- A **titled** `board_get` adds a short `issue_rel` for the plan and each linked row. It is read
  from the cache through `store.ts` and built by the pure `src/issue-graph.ts`; the MCP process
  stays network-free. It holds keys and counts only, never titles or bodies (#42's payload diet),
  and is omitted when nothing is cached:

```json
{ "key": "shariqh/agent-inbox#120", "parent": "shariqh/agent-inbox#117",
  "children": { "total": 0, "done": 0 }, "checked_at": "2026-10-19T22:30:00.000Z",
  "stale": false, "unavailable": false }
```

- `pending()` and the title-less `board_get` summary are unchanged.

### Mutation (Q4)

None. Agents use `gh issue edit --parent`, `--add-sub-issue` and so on, and the viewer shows the
result on the next refresh.

---

## §11 — Security

- **Text.** Titles are third-party text: a parent or child can live in a public repository whose
  issue author controls the title. Every title goes through `esc()` or `textContent`; tooltips go
  through an escaped `title=`.
- **URLs.** Hrefs are built from a validated slug and an integer as
  `https://github.com/<repo>/issues/<n>`, then pass through `chipHtml()` → `anchorHtml()` →
  `safeHttpUrl()` → `esc()`. GitHub's `url` fields are never requested, and the one-href-path rule
  from #30 holds.
- **Attributes and selectors.** `data-issue-key` goes through `esc()`; selectors use
  `CSS.escape`.
- **Subprocess.** `execFile` without a shell, a deterministic document, values only as variables,
  `-f` for strings, `-F` only for validated integers, `--hostname github.com`, piped streams, a
  timeout and a buffer cap.
- **Surface.** No new write route and no token handling. The MCP process gains only pure modules
  (`src/issue-graph.ts`, `public/issue-key.js`).
- **Privacy.** Private issue titles are cached in the local hub, as PR titles already are. A hard
  failure deletes them at once. Hosted mode (#8) must treat them as sensitive.

---

## §12 — Later work: design notes (not scheduled)

### 12.1 Opt-in grouping (Q3)

- Ships only after breadcrumbs are proven, behind a Plans toggle that is off by default and
  stored per window like other view state.
- The group key is **`(project, parent issue key)`**. In the all-projects view, plans from
  different Agent Inbox projects never merge, even under one GitHub parent; the header names
  both.
- Groups keep the position of their first member in today's order. Inside a group, the umbrella
  plan comes first, then GitHub's child order, then today's order.
- `paginateWithPending` pages the flattened list, and a group that spans pages repeats its header
  with "(continued)".
- Inside a plan, thin parent sub-headers appear only when its rows span two or more parents.

### 12.2 Dependencies with "waits on" chips (Q2, Q8)

- Starts after the hierarchy is proven. It adds `issueDependenciesSummary`,
  `blockedBy(first: 50)` and `blocking(first: 50)` to `Root`; the dry-run cost was still 1 for 10
  roots.
- It also adds a `dependencies` snapshot section and the §4.6 reconciliation.
- Chips read "waits on #119" (or "waits on 3") and "unblocks"; tooltips may say "GitHub: blocked
  by #119".
- It adds `waits_on` to `issue_rel` and follows §8 and §9.

### 12.3 Plan Flow edges

`buildMission(board, graph)` stays pure and plan-scoped. Containment and sequencing render
differently:

| | Containment | Sequencing |
|---|---|---|
| Visual | Solid left rail, "Part of #117" | Dashed accent link chip, "Waits on: AHP adapter (#119)" |
| Class | `.mission-edge-contains` | `.mission-edge-waits` |
| Accessible name | "Sub-issue #120 of #117" | "Waits on step AHP adapter (#119)" |
| Activation | None | Moves focus to the blocking step inside the flow |

- Rows keep a stable topological order (Kahn's algorithm, ties by row position). A cycle keeps
  plan order.
- Children of the plan's issue that no row links appear in a "Not in this plan" fold.
- `result` stays `outcome` or `next_after` text only, so a `next_after` of "after #119" creates
  no edge.
- Issues in other plans are external chips, never cross-plan edges.

### 12.4 Sibling context

- Adds the parent's child identities to each child's query (`parent.subIssues`, identities only,
  included in the 1-point dry run). The UI can then show "3rd of 10" and a sibling list, and each
  complete sibling list adds membership and absence observations.
- Ships with search by issue key and GitHub title (fields carry `issueKey`, and a hit lands on the
  exact plan, row and chip).
- Also adds row-level deep-link hashes: `#item/<id>/row/<rowId>/issue/<key>`, each segment
  `encodeURIComponent`-encoded. A plain `#item/<id>` keeps working, and an older build ignores the
  longer form.

---

## §13 — Delivery: the first slice

**Rules for every PR:**

- No test makes a network call; GitHub fixtures are trimmed copies of the §18 responses.
- Tests use real SQLite through `openDb()` and never mock the store.
- `npm run typecheck` stays strict-clean and `test/dead-exports.test.ts` stays green.
- Each PR updates CLAUDE.md and `.github/copilot-instructions.md` for the invariants it adds.
- Any PR that renders something re-runs the attention non-regression pin.

### PR1a — Schema, identity, pure hierarchy graph, `/api/issues`

**Scope.**

- The `issue_snapshots` table and its store functions (§4.4).
- `public/issue-key.js`: canonical keys, validation, `issueKeyFor` with certainty, and
  `issueKeySets`.
- `src/issue-graph.ts`: §4.5 reconciliation, aliases, scoping and the node cap.
- The `GET /api/issues` conditional snapshot.
- No poller and no UI: the graph stays empty until PR1b. About 450 production and 550 test lines.

**Acceptance criteria.**

1. A database created by v1.3.1 migrates additively, and a v1.3.1 process can keep reading and
   writing it at the same time.
2. Keys are repo-qualified and case-insensitive; `a/x#5` and `b/y#5` never merge.
3. Every row of the §4.5 worked-example table produces the stated result, including same-batch
   ties, `conflict` and cycle breaking.
4. A soft failure keeps the snapshot. A hard failure deletes it in the same statement and
   suppresses that issue everywhere (rule 6). A late answer from an older attempt never
   overwrites a newer one.
5. A PR that closes several issues yields no `certain` identity, and a legacy row stays
   display-only.
6. `/api/issues` answers 304 when nothing changed. Snapshot writes leave the bytes and ETags of
   `/api/items` and `/api/boards` unchanged.
7. The display set includes closed-project entities and archived plans, and the refresh set
   excludes them.
8. When the display roots and their ancestors alone exceed the node cap, roots are kept whole in
   rank order and the cut is a prefix of the ranking (§6). No chain is ever cut partway. The
   omitted root, ancestor, child and edge counts are exact, and omitted roots are absent from
   `roots`.
9. Child counts appear only where §5.6 requests them; a higher ancestor shows none.

**Tests.**

- `test/issue-store.test.ts`:
  - migration from a v1.3.1-shaped database;
  - NOCASE key deduplication;
  - v1 validation on write and read (corrupt JSON reads as "no snapshot" without throwing);
  - the attempt rule for successes and failures;
  - soft failures keep data, hard failures delete it;
  - pruning at 30 days;
  - `listIssueEntities` flags.
- `test/issue-key.test.ts`: canonical keys and slug validation; `issueKeyFor` precedence and
  certainty (one reference, several, none, unbound or legacy); both key sets.
- `test/issue-graph.test.ts`:
  - the worked-example table, row by row;
  - two- and three-issue cycles, including a tie;
  - the depth bound;
  - rule 6 suppression and later revival;
  - redirect aliases;
  - display scoping;
  - the node cap:
    - 2,001 single-node roots;
    - roots with distinct eight-level chains, where 222 always fit;
    - shared ancestors;
    - each ranking tier;
    - the prefix cut, with no partial chain;
    - exact `truncated` counts;
    - children round-robin with `children_omitted`;
    - identical output on repeated reads;
  - counts only on the root, its immediate parent and its children;
  - cross-repository equal numbers.
- `test/viewer.test.ts` and `test/viewer-snapshot-cache.test.ts`: `/api/issues` 200 then 304,
  invalidation after a write, existing ETags unchanged.
- `test/mixed-version.test.ts` (new): frozen v1.3.1 DDL and write statements run on a second
  connection against a hub the new code migrated, interleaved with new writes. New columns
  survive, old reads still work, and old writes succeed.

### PR1b — Poller: fair queue, lease, rate-limit budgeting, failure handling

**Scope.**

- `src/issue-poller.ts`, as specified in §5.
- The `issue_refresh_claims` table with `claimIssueRefresh` and `completeIssueRefresh`.
- The issues-first tick, and a `deadlineMs` option on `refreshOnce`.
- `closing_refs` recording in `parsePrPayload` and `upsertSourceLink`.
- Wiring in `src/viewer-server.ts`, and the boundary test.
- About 400 production and 500 test lines.

**Acceptance criteria.**

1. With 120 due candidates and no new arrivals, every one is fetched within 12 issue-class runs.
   While new links or nudges arrive faster than 10 per run, older keys wait and their ages keep
   growing, and they are served once the burst ends (§5.4).
2. Two viewers on one hub never fetch the same key at the same time, and a crashed viewer's lease
   expires after 60 s.
3. The issue class runs first in every tick, and the PR class starts no target after 45 s.
4. Batches of 1 to 10 each use a valid document of their own size.
5. Spending follows the reported cost within the bucket; below the floor the class waits until
   `resetAt`.
6. Soft failures keep data and hard failures suppress it at once. Partial batches are classified
   per alias, and a field error affects only its section.
7. A merged PR nudges its `certain` closing issue and every candidate whose cached list contains
   that issue.
8. A PR that closes several issues records every reference and never produces a `certain`
   identity.
9. No file of the stdio MCP graph imports the poller.

**Tests.**

- `test/issue-poller.test.ts`:
  - fairness with 120 candidates on an injected clock;
  - an over-capacity run: older keys wait while arrivals exceed 10 per run, then resume;
  - queue order and the TTL table;
  - nudges;
  - document snapshots for n = 1 and n = 10, with recorded argv (`-f`, `-F`, `--hostname`);
  - parse fixtures: success, `NOT_FOUND` per alias and per issue, a PR number, SAML
    `FORBIDDEN`, `RATE_LIMITED`, a field error, a validation error with no `data`, unparseable
    output;
  - redirect versus `moved`;
  - the budget at cost 1 and cost 3, and the floor with `resetAt`;
  - the refresh never rejects.
- `test/issue-claims.test.ts`: two connections racing claims (`.immediate()`), a stale
  `checked_at` refused, lease expiry, completion releasing leases, and a late completion under the
  attempt rule.
- `test/prstate.test.ts`: the deadline stops new targets; a multi-closing PR stores every
  reference; the boundary list includes `issue-poller`; the `startPrPoller` source pin is updated.
- `test/mixed-version.test.ts`: a frozen v1.3.1 `upsertSourceLink` unbinds `closing_refs`.

### PR2 — Explicit plan and row links

**Scope.**

- The pin and link columns.
- The MCP fields, accepted forms, errors and descriptions (§10), including the §8 contract
  sentence.
- Store support, including `advanceBoardRow`.
- The titled `board_get` summary.
- Updates to `docs/reporting-snippet.md`, the host instructions and CLAUDE.md.
- About 250 production and 350 test lines.

**Acceptance criteria.**

1. Every accepted form normalizes to `owner/name#N`; anything else, including `#N` without a
   session repository, is refused with the accepted forms listed.
2. A full `board_upsert` that omits `issue` keeps the stored link, and `''` clears it.
3. `board_advance` and a move into `blocked` keep the link; the human annotation, handled and
   delivery fields are untouched.
4. The plan pin outranks the PR issue and the branch issue. `boards.repo`, `issue_ref` and the PR
   lookup are unchanged.
5. Titled `board_get` shows `issue_rel` only when cached data exists. `pending()` output and the
   title-less summary are byte-identical for the same rows.
6. A v1.3.1 process writing boards and rows on a migrated hub never clears links.

**Tests.**

- `test/mcp.integration.test.ts` (real stdio round trip):
  - every form and every refusal;
  - omission and clearing;
  - `tools/list` carries the link and dependency sentences;
  - `pending()` is unchanged.
- `test/store.test.ts`: `advanceBoardRow` keeps links; a reblock keeps them; revision and
  `updated_at` bump on a link change; annotations and handled marks survive.
- `test/shape.test.ts`: `issue_rel` appears on titled reads only, with keys and counts and no
  titles.
- `test/mixed-version.test.ts`: frozen v1.3.1 `upsertBoard` and `updateBoardRow` statements keep
  links.

### PR3 — Breadcrumbs and child progress

**Scope.**

- The `load()` read and the `/api/issues` validator.
- `public/issues.js`.
- Chips and source-block sections in `public/source.js`, and row link chips.
- Agent Inbox activity, and navigation from the new surfaces.
- CSS.
- About 350 production and 450 test lines.

**Acceptance criteria.**

1. A parent renders its children in GitHub's order with open/closed progress, and a child renders
   its exact parent (#103 criterion 1).
2. With no `gh`, no data, a 404 from `/api/issues`, or a root the node cap omitted, every surface
   renders exactly as today.
3. Soft failures show their age, dim after 30 minutes and hide after 7 days. Hard failures show
   "unavailable" with no cached title.
4. Hostile titles render as text, and every href is constructed and passes through `chipHtml`.
5. The badge, title, tab counts, Needs you and the dock projection are identical with and without
   relationship data.
6. A poll that changes relationship data never discards a draft, the focus or an expanded row.
7. Activity labels read attention and never change it. Each label opens the exact plan, row or
   item.

**Tests.**

- `test/issues.test.ts`: breadcrumb trails, child order, progress, activity labels, freshness
  thresholds, unavailable states and aliases.
- `test/source.test.ts`: hostile titles and quotes inside `title=`; constructed hrefs only;
  tones; the word "Blocked" never appears.
- `test/snapshots.test.ts`: the `/api/issues` validator.
- `test/dom/issue-relations.test.ts`:
  - rendering from fixtures;
  - the 404 fallback;
  - a draft and the focus survive a poll that changes relationships;
  - navigation to the exact plan and row.
- `test/dom/issue-attention.test.ts`: attention surfaces are identical with and without a graph,
  and a source pin checks that `public/attention.js` names no issue field.

### Later (not scheduled; designs in §12)

- **Opt-in grouping** by `(project, parent issue)`, after breadcrumbs are proven.
- **Dependencies with "waits on" chips**, after hierarchy ingestion and reconciliation are proven.
- **Plan Flow edges**, after dependencies.
- **Sibling context**, together with search by issue key and title and row-level deep-link
  hashes.

### Coverage of #103's acceptance criteria

| #103 criterion | First slice | Later |
|---|---|---|
| 1. Child ordering, progress, exact parent | PR3 | |
| 2. Repo-qualified identities | PR1a | |
| 3. Cycles, self-links, duplicates, stale and unavailable targets fail closed | PR1a, PR1b (hierarchy) | Dependencies |
| 4. Sequencing distinct from containment | | Dependencies, Plan Flow edges |
| 5. Attention unchanged | PR3 (pinned) | Re-pinned by every later PR |
| 6. Rollups refresh without duplicate plans or lost notes | PR1a, PR1b, PR3 | Opt-in grouping |
| 7. Search and deep links reach the exact target | PR3: in-app navigation to the exact plan and row | Sibling context: search and hashes |
| 8. Failures never hide the issue, approval or plan | PR1b, PR3 | |
| 9. Tests | Each PR | Each PR |
| 10. Documentation | This document, plus PR1a and PR2 docs | |

---

## §14 — Revision 1 phasing (superseded)

Revision 1 proposed six PRs, with dependencies ingested in PR1 and automatic grouping. The owner
chose the smaller first slice instead (§15). Every unit of revision 1 maps onto §13 or §12, so
nothing was lost.

---

## §15 — Decisions (recorded 2026-10-19)

| | Question | Decision | Applied in |
|---|---|---|---|
| Phasing | Original six PRs or a smaller first slice? | **Smaller first slice:** PR1a, PR1b, PR2, PR3, then the later list | §13 |
| Q1 | How do plans and rows link to issues? | **Explicit plan pin and row link,** with safeguards: links survive `board_advance` and omitted fields, and a PR that closes several issues is ambiguous and never guessed | §4.2, §10, PR2 |
| Q2 | What does the UI call a dependency? | **"waits on" / "unblocks"** | §12.2 |
| Q3 | Group plans by GitHub parent? | **Deferred until breadcrumbs are proven, then opt-in,** keyed by `(project, parent)` | §12.1 |
| Q4 | Edit GitHub relationships from Agent Inbox? | **Never** | §10 |
| Q5 | Agent-facing summaries? | **`pending()` unchanged; short summaries on titled `board_get` only** | §10, PR2 |
| Q6 | Freshness and budget? | **Open issues every 10 min, closed every 60, dim after 30 min, hide after 7 days,** plus the fair queue, leases, tick deadlines, reported-cost budget and immediate hard-failure suppression | §5, PR1b |
| Q7 | What is "current ownership"? | **"Agent Inbox activity",** local only, not GitHub assignees | §7.3, PR3 |
| Q8 | When do dependencies arrive? | **Deferred, ingestion and display alike, until the hierarchy is proven** | §12.2 |

---

## §16 — Risks

1. **Stale rollups read as current.** Age labels, dimming, the 7-day hide and merge nudges reduce
   this, but a 25-minute-old count can still be acted on.
2. **GitHub API drift** (renamed fields, new limits). The parser fails closed and sections are
   independent; at worst relationships disappear and nothing else changes.
3. **Large hubs and bursts.** The queue's capacity is 10 refreshes a minute per viewer. Above
   about 100 open candidates, or during a sustained burst of new links and nudges, refreshes fall
   behind their TTLs and older keys wait (§5.4). Ages and dimming show this honestly, and
   `ISSUE_BATCH` or the per-tick call count can be tuned. Above the node cap, whole roots fall
   back to plain chips in rank order (§6).
4. **Rate limits.** Bounded by the token bucket (120 points per hour per viewer) and the floor.
5. **Lease correctness across processes.** Claims rely on `.immediate()` transactions on one
   SQLite file; PR1b tests races on two connections.
6. **Mixed-version processes.** Old processes ignore the new columns and leave them untouched;
   `closing_refs` unbinds itself; frozen-statement tests pin both directions.
7. **Repository rename versus issue transfer.** Renames keep working through redirect aliases.
   Transferred issues show "unavailable" until relinked (node-id refresh is deferred).
8. **The #30 display change.** A PR that closes several issues no longer shows its first one.
   This is deliberate, and the PR tooltip lists every reference.
9. **Later dependency misuse.** Agents may still mark `blocked` for a dependency. The contract
   sentence ships in PR2, and "waits on" chips will make the mistake visible.
10. **Privacy.** Private titles are cached locally, as PR titles are, and hard failures delete
    them.

---

## §17 — Rejected and deferred alternatives

- **REST per family:** several requests per issue, full issue objects, and a 404 that cannot
  tell "no parent" from "no access".
- **`gh issue view --json` per issue:** one subprocess per issue, and children carry no
  repository.
- **Extending `gh pr list`:** it has no relationship fields.
- **Webhooks or `gh webhook forward`:** both need a public endpoint or repository admin, plus a
  long-lived process.
- **One constant ten-slot document:** it fails validation for any smaller batch (verified).
  `@include` with placeholder values: valid, but every request carries ten slots.
- **A cap of the 50 most recently updated candidates:** it starves the rest. Replaced by the fair
  queue.
- **A separate timer for issue refresh:** it would allow two `gh` processes at once and still
  need its own deadline. Replaced by issues-first in the shared tick.
- **Rotating the class order each tick:** unnecessary, because the issue class is one bounded
  call.
- **Deferred: refresh by GraphQL node id.** It would follow issue transfers with proof, but adds
  a second document shape and legacy-id handling (`MDU6…` ids still exist).
- **Deferred: a normalized `issue_edges` table.** It needs per-root edge ownership and the same
  reconciliation anyway.
- **Joining relationships into `/api/items` or `/api/boards`:** every refresh would change their
  bytes.
- **Deriving row status from dependencies,** parsing labels or tasklists, and **creating plans or
  rows from children:** all ruled out by #103 and the attention invariants.
- **Automatic grouping:** deferred by Q3.

---

## §18 — Verification log and sources

Everything marked "verified" or "observed" above was run on 2026-10-19 with `gh` 2.102.0, read-only:

- `gh issue view --json` and `gh issue list --json` list `blockedBy`, `blocking`, `parent`,
  `subIssues`, `subIssuesSummary` and `issueType`. `GH_DEBUG=api gh issue view` queries
  `subIssues(first:100)`, `blockedBy(first:50)`, `blocking(first:50)` and `parent{…}`; its child
  nodes carry `id`, `number`, `state`, `title` and `url`, with no repository.
- GraphQL introspection: the `Issue` fields in §2.2 with their descriptions;
  `SubIssuesSummary { completed, percentCompleted, total }`;
  `IssueDependenciesSummary { blockedBy, blocking, totalBlockedBy, totalBlocking }`;
  `IssueStateReason` is `REOPENED, NOT_PLANNED, COMPLETED, DUPLICATE`; `subIssues` takes no
  `orderBy`.
- REST:
  - `GET repos/cli/cli/issues/14529/sub_issues?per_page=2` returned 200, with
    `Link: <…/repositories/212613049/issues/14529/sub_issues?per_page=2&page=2>; rel="next"` and
    objects carrying `parent_issue_url`, `sub_issues_summary` and `issue_dependencies_summary`
    (35 top-level keys);
  - `GET repos/cli/cli/issues/14528/parent` returned #14529;
  - `GET repos/cli/cli/issues/14563/parent` returned 404 "No parent issue found";
  - `GET repos/microsoft/vscode/issues/332085/dependencies/blocking` returned
    `Vivswan/litellm-vscode-chat#443`.
- `shariqh/agent-inbox`: #117 contains #118 to #127; #119 blocks #118 and #120 to #125; #120
  blocks #121; #103 has no relationships; there are no issue types (user-owned repository).
- `cli/cli`: #14563 contains #14529, which contains #14523 to #14528 (three levels, all closed).
  The ancestor walk cost 1 point.
- Partial errors: exit 1 with the full JSON on stdout; `NOT_FOUND` paths as in §2.6; `FORBIDDEN`
  with `saml_failure` for `github/roadmap`. `issue(number: 215)` is `NOT_FOUND` (a PR).
- **Partial batches:** the ten-slot document with three roots exited 1, with errors starting
  "Variable $o3 of type String! was provided invalid value" and no `data`. The three-slot
  document succeeded at cost 1 and returned `rateLimit { cost remaining resetAt }`.
- **Redirects:** `repository(owner: "twitter", name: "bootstrap")` returned `nameWithOwner`
  `twbs/bootstrap`. `issue(number: 2)` under the old name returned `twbs/bootstrap#2` with id
  `MDU6SXNzdWUxNDQ2Mzk4`.
- `closingIssuesReferences` from `gh pr list` (PRs #213 and #210) carries `id`, `number`,
  `repository { id, name, owner { id, login } }` and `url`.
- **Cost and size:**
  - the first-slice document cost 1 point for 1, 3 and 10 roots (2,542, 3,668 and 7,615 bytes),
    and 5,927 bytes merged for 10;
  - with the dependency and sibling fragments, a 10-root dry run cost 1;
  - the revision 1 document cost 1 point for 3 roots (5,735 bytes); 10 roots took 0.8–0.9 s and
    18,550 bytes; dry runs cost 1 for 10 and 25 roots and 2 for 40 and 50.
- This account's limits: REST core 15,000 per hour, GraphQL 10,000 per hour, search 30 per minute.
- Not verified: how `issue(number:)` behaves for an issue transferred to another repository (§4.1).

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
- Changelog 2025-04-09, sub-issues and issue types GA:
  https://github.blog/changelog/2025-04-09-evolving-github-issues-and-projects/
- Changelog 2025-08-21, issue dependencies GA, 50 per type:
  https://github.blog/changelog/2025-08-21-dependencies-on-issues/
- Changelog 2025-09-11, cross-organization sub-issues and the parent endpoint:
  https://github.blog/changelog/2025-09-11-a-rest-api-for-github-projects-sub-issues-improvements-and-more/
- Changelog 2026-06-10, `gh` 2.94.0 hierarchy and dependency support:
  https://github.blog/changelog/2026-06-10-manage-sub-issues-types-and-dependencies-from-github-cli/
- Changelog 2025-02-18, tasklist retirement on 2025-04-30:
  https://github.blog/changelog/2025-02-18-github-issues-projects-february-18th-update/

---

## §19 — Revision history

- **Revision 1 (2026-10-19):** initial design with eight open questions and a six-PR plan.
- **Revision 2 (2026-10-19):** the review fixes and the owner's decisions.
  - **Reconciliation** gains negative observations, equal-time ranks, conflicts, deterministic
    cycle breaking, and hard failures as suppressing observations (§4.5, §4.6).
  - **Scheduling:** a fair queue with no cap, atomic expiring leases, and an issues-first tick
    with per-class deadlines (§5.2, §5.4, §5.5).
  - **Failures:** hard failures delete data at once and soft failures age. Repository redirects
    are aliased; transfers are not assumed (§4.1, §5.8).
  - **Queries:** one document per batch size, with budgeting from the reported
    `rateLimit { cost remaining resetAt }` (§5.3, §5.6).
  - **Key sets:** explicit refresh and display sets, closed projects kept on purpose, and exact
    truncation counts (§6).
  - **Grouping** is keyed by `(project, parent)`, opt-in and later (§12.1).
  - **Adopted from review:**
    - PR1 split into 1a and 1b;
    - `board_advance` and mixed-version tests;
    - multi-closing PRs never guessed (`closing_refs`);
    - §2.9 matched to the 10-issue batch;
    - sibling context deferred.
  - **Decisions recorded** (§15); **phasing** reduced to the first slice plus a later list, with
    acceptance criteria and tests for each PR (§13).
- **Revision 3 (2026-10-19):** the delta-review fix and clarifications.
  - **Node cap (§6):** roots are ranked by a stable key and kept whole, with their ancestor
    chains, as a prefix of the ranking. The response reports exact omitted root, ancestor, child
    and edge counts, and omitted roots fall back to plain chips. PR1a gains matching acceptance
    criteria and tests.
  - **Queue capacity (§5.4):** "no key starves" now holds only while arrivals stay below 10 per
    run, and the section says what the UI shows when the queue is over capacity.
  - **Child counts (§4.5):** counts are claimed only for the root, its immediate parent and its
    children, matching the query in §5.6.
- **Revision 4 (2026-10-19):** refinements made while implementing PR1a.
  - **Soft after hard (§4.4):** a soft failure keeps a stored hard error, as it keeps a snapshot.
    Otherwise the next offline attempt would erase the evidence rule 6 needs, and titles GitHub
    refused would return from other issues' older lists.
  - **Rule 6 (§4.5):** every cached hard failure counts, displayed or not, and a claim naming a
    refused parent becomes "parent unknown" instead of vanishing, so an older claim cannot return
    from a display-only list nobody refreshes.
  - **Rule 3 (§4.5):** two pointers of one batch that disagree are contradictory equals too.
  - **Rule 4 (§4.5):** counts observed at equal `t` follow rule 7's source order, so the choice
    never depends on input order.
  - **Truncation (§6):** each omitted node is counted in exactly one of `roots`, `ancestors` and
    `children`.
  - **Entities (§4.4):** rows join `listIssueEntities` in PR2, when they gain a link.
