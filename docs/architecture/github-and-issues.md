---
paths:
  - "src/prstate.ts"
  - "src/issue-poller.ts"
  - "src/issue-graph.ts"
  - "public/issue-key.js"
  - "src/store.ts"
applyTo: "src/prstate.ts,src/issue-poller.ts,src/issue-graph.ts,public/issue-key.js,src/store.ts"
---

# GitHub data: PR state, issue snapshots and dependencies

The viewer-only `gh` pollers, the cached issue graph (#103), plan pins, row links and `waits_on`, and source + PR links (#30).

Moved out of `CLAUDE.md` and `.github/copilot-instructions.md` by #379, nearly verbatim. Claude Code and Copilot CLI load this file automatically when they read or edit a file matching the `paths`/`applyTo` globs above (through the symlinks in `.claude/rules/` and `.github/instructions/`); anyone else should read it before changing those files.

## In brief

- Plan pins and row issue links (#103 PR2) are agent-owned fields: omission keeps,
  MCP `""` clears, `board_advance` and a reblock keep them, and a pin outranks the
  PR and branch issue. MCP normalizes every accepted form to `owner/name#N` and
  refuses anything else; `pending()` and the title-less `board_get` never carry them.
- A row's `waits_on` (#103 slice 2) names other rows of the same plan by label, stored
  sorted as JSON. Omission keeps, `[]` clears, `board_advance` and a reblock keep it.
  `store.ts` checks it inside the writing `.immediate()` transaction, and only what the
  write adds: a newly named label must be a row of the plan, no row names itself, at most
  20, and no added or revived edge may close a cycle. That cycle check holds the write
  lock, so it stays linear: components once, then one path search for the edge the error
  names; never a search per edge. A label whose row was removed stays, never re-checked;
  never prune it. Only titled `board_get` echoes it, and it never makes a row `blocked` or
  enters attention.
- GitHub dependencies (#103 slice 2 PR B) become `blocks` edges (blocker → dependent) in the
  pure `buildIssueGraph`: positives from a root's own bound `ok` `blocked_by`/`blocking`,
  negatives only from a complete list that omits the other end, the newest wins and a negative
  wins ties, nothing at or before either end's hard failure counts, and cycles are kept with
  `cycle: true` (iterative SCC, no recursion, no new stdio module). A node's `deps` come only
  from its own section. The cap keeps S1's order, then fills dependency neighbours round-robin
  (blockers before dependents, by key); a `blocks` edge needs both nodes emitted, all edges stay
  within twice the node budget, and every omission is counted (a root's
  `dependencies_omitted`, and `dependencies_omitted_open` `{ blocked_by, blocking }` for
  those whose other end is OPEN by its freshest facts, #275). `snapshots.js` accepts the
  body unchanged and PR D draws it (`plans-issue-ui.md`). `issue_rel`
  adds `waits_on_issues` (open blocker keys, at most 50) and `unblocks` only while the key's own
  section is bound, `ok`, at most 7 days old and not dropped by rule 6 (that root reports
  `unknown`); never name them `waits_on` (a row's writable step labels) or anything built on
  "blocked". The cap bounds the response, not the work: the build reads every display root's
  dependency entries, so keep it linear, with no per-pair strings and no global sort.
- Issue snapshots (#103) are written only through `upsertIssueSnapshot` and
  `recordIssueFailure`. The attempt rule (apply only when the attempt started after
  the stored `checked_at`) is the `WHERE` of one upsert; a hard failure clears the
  snapshot and `fetched_at` in that same statement; a soft failure keeps the last
  answer, snapshot or hard failure, and only advances `checked_at`. Reads validate
  the v1 shape and treat anything else as "no snapshot", never an exception.
  The poller applies them only through `completeIssueRefresh`, after
  `claimIssueRefresh` leased the keys; both are one `.immediate()` transaction,
  a lease expires after 60 s, and a claim skips any key whose `checked_at` moved
  since the queue was read. `closing_refs` is bound to the `fetched_at` written
  beside it; an older process's success write unbinds it. Slice 2's
  `dependencies` column follows the same rule: written in the same statement as
  the snapshot, read only while its `fetched_at` equals the row's (else
  "unknown", never "no dependencies"); an older process's success or hard
  failure unbinds it, a soft failure keeps it bound. A success without a bound
  section is fetched again at once (the queue's `upgrade` tier) unless its
  `checked_at` is ahead of the clock; a failure keeps its own TTL. GitHub
  marks the dependency fields and `subIssues`/`subIssuesSummary` non-null, so
  each group is asked on an alias of its own per issue (`dN`, `hN`): an error
  there nulls only `dN.issue` or `hN.issue`, makes only that section
  unavailable, and leaves the issue and its parent chain in `rN` refreshing.

## Invariants in detail

- **`src/prstate.ts` is VIEWER-PROCESS-ONLY (issue #30).** It and `src/issue-poller.ts` (#103, below)
  are the only modules that shell out to a network tool (`gh`), so `src/mcp.ts`/`src/mcp-server.ts`
  must never import either, directly or transitively — a subprocess that inherited a stream, or gh's update notifier, would corrupt the MCP
  wire. It writes only through `store.ts` (`upsertSourceLink`/`recordLinkFailure`; the TTL *policy*,
  `dueTargets`, is a pure function over what the store returned) and it can never reject: an
  unhandled rejection from a background PR fetcher would take down the human's entire UI. **A failing
  CI check or a changes-requested review NEVER enters the attention set** — `public/attention.js` is
  untouched, no badge moves, no notification fires. A red CI is the agent's problem, not the human
  being blocked; this is the likeliest place for scope creep to damage tenet 2.
- **The sub-issue graph is cached GitHub data, reconciled purely (issue #103, PR1a).**
  Design: [`docs/superpowers/specs/2026-10-19-plans-sub-issues-design.md`](../../docs/superpowers/specs/2026-10-19-plans-sub-issues-design.md).
  `issue_snapshots` holds one validated v1 JSON answer per REQUESTED `owner/name#number`
  (`repo` is `COLLATE NOCASE`), written only through `upsertIssueSnapshot`/
  `recordIssueFailure`, whose production caller is `completeIssueRefresh` (the poller, below).
  Four rules hold there.
  (1) **The attempt rule** is the `WHERE` of ONE upsert: a write applies only when its
  attempt STARTED after the stored `checked_at`, so a late answer from an older attempt
  never lands; never turn it into a read followed by a write. (2) A hard failure
  (`not-found`/`forbidden`/`moved`) clears `snapshot` and `fetched_at` in that SAME
  statement. (3) A soft failure keeps the LAST ANSWER, whichever it was: the snapshot, or a
  hard failure's code, so it only advances `checked_at` (otherwise the next offline tick
  would erase the evidence rule 6 needs and refused titles would return). (4) Validation
  runs on write and read; an unreadable or unknown-version row reads as "no snapshot" and
  never throws. `src/issue-graph.ts` (`buildIssueGraph`) is PURE — no database, clock,
  network or I/O — so identical database contents give identical bytes, which is why
  `/api/issues` can be a store-token conditional snapshot. It applies §4.5's
  reconciliation (newest observation first; pointers, then absences, then memberships at
  equal time; contradictory equals and cycles fail closed as `conflict`; facts and counts
  never decide parentage) and §6's deterministic node cap (whole roots in rank order, a
  prefix cut, exact `truncated` counts). Rule 6 suppression reads EVERY cached hard failure,
  displayed or not, and a claim that names a refused parent becomes "unknown" rather than
  vanishing, so an older claim can never come back. `public/issue-key.js` owns keys (repo
  lowercased; a number is never compared without its repository), `issueKeyFor` certainty
  (a PR closing several issues is never guessed; a PR row without a bound `closing_refs`
  record is display-only) and the refresh/display key sets (closed projects and archived
  plans are displayed, never refreshed; closed items are History and in neither).
  `/api/items` and `/api/boards` never carry GitHub data, so snapshot writes leave their
  bytes and validators unchanged. Both modules are pure, which is the only reason PR2's titled
  `board_get` summary may admit them (and `public/source.js`/`esc.js`) into the stdio MCP
  graph; hook-cli and watch-cli still never reach them. `test/issue-graph.test.ts` pins the
  transitive graph, and `test/mixed-version.test.ts` runs frozen v1.3.1 statements against a
  migrated hub.
- **`src/issue-poller.ts` is VIEWER-PROCESS-ONLY too (issue #103, PR1b).** It is the second
  `gh` caller and keeps every prstate rule: `execFile` with argv only, piped stdio, the quieting
  env, `GH_TIMEOUT_MS`/`GH_MAX_BUFFER`, writes only through `store.ts`, never rejects, and never
  reaches attention, a badge or a notification. `test/prstate.test.ts` checks that no file of
  the stdio graph (its list must stay closed under relative imports, `../public/*.js` included)
  imports either poller, reading every specifier form: single- or double-quoted, side-effect,
  dynamic and `require`.
  (1) **One tick, issues first** (`startGithubPoller`, started by `viewer-server.ts`): the issue
  class makes at most ONE `gh api graphql` call (≤ 10 issues, one deterministic document per
  batch size, owner/name only through `-f`, numbers through `-F`, `--hostname github.com`),
  skipped after t0 + 15 s; then `refreshOnce(db, { deadlineMs: t0 + 45 s })` starts no new PR
  target after the deadline. One busy guard covers both, so there are never two `gh` processes.
  (2) **The queue is uncapped and fair** (`issueQueue`, pure): the refresh key set ordered never
  fetched, then upgrades (slice 2, below), then nudged, then oldest `checked_at`, then key. A
  nudge is a MERGED/CLOSED link whose CERTAIN closing issue is the key, one of its listed
  children or (slice 2) one of its open blockers, seen after the key's
  `checked_at`. TTLs: open 10 min, closed 60, soft 10 (`no-gh`/`auth` 60), and hard 10 — not the
  design's 60, because a soft failure after a hard one keeps the hard error while moving its time
  forward, which hides newer observations from other roots until the issue's own next success.
  (3) **Claims are leases** (`issue_refresh_claims`): `claimIssueRefresh` and
  `completeIssueRefresh` are each ONE `.immediate()` transaction; a claim skips keys with a live
  lease or whose `checked_at` moved since the caller read it, a crashed viewer's lease expires
  after 60 s, and completion releases only its own owner's leases. An invalid snapshot in a
  completion is recorded as a soft `gh-failed`, never thrown: one throw would roll back the batch
  and the same keys would be refetched every tick. The store reports each one to its caller
  (`onInvalid`), and the poller says so ONCE per process on stderr, by key, never by title
  (`invalidSnapshotNotice`); `store.ts` itself never logs, since it is in the stdio graph. (4) **Budget from the reported cost**
  (`IssueBudget`, per process): a 120-point hourly bucket spent by `rateLimit.cost`, the last
  reported cost when a call reports none; below `RATE_FLOOR` (500) the class waits for `resetAt`
  (capped at an hour) and records a soft `rate-limit` for the batch it would have fetched; a
  rate-limited call that reported nothing backs off ten minutes. (5) **Parsing fails closed**
  (`parseIssueBatch`): a whole failure is soft for every key; per alias `NOT_FOUND`/`FORBIDDEN`
  are hard only when no other error names that alias; a field error under `parent`, or any error
  on the issue's hierarchy alias `hN`, marks only that root's hierarchy unavailable (#267: GitHub
  marks `subIssues`/`subIssuesSummary` non-null, so an error under them nulls the issue they were
  asked on; on `hN`, beside `rN` with its variables, that is only `hN.issue`, and the issue's
  title, state and parent still refresh; `parent` is nullable and stays on `rN`, at the same
  1 point per ten issues); an unreadable immediate parent is never read as
  "no parent"; a list that lost an invalid child is marked truncated so it is no evidence of
  absence; a repository redirect becomes an alias and any other identity mismatch is `moved`.
  (6) **`closing_refs`**: `parsePrPayload` records every closing reference (one unreadable
  reference voids the list rather than shrinking it to a false single), and `upsertSourceLink`
  stores it bound to the `fetched_at` it writes. An older process's success write moves
  `fetched_at` and so unbinds it (pinned in `test/mixed-version.test.ts`); its failure write
  keeps it bound.
- **GitHub issue dependencies ride the same call, bound to their fetch (issue #103 slice 2, PR A).**
  Design: [`docs/superpowers/specs/2026-10-21-plan-dependencies-design.md`](../../docs/superpowers/specs/2026-10-21-plan-dependencies-design.md).
  A `Deps` fragment asks for `issueDependenciesSummary` and `blockedBy`/`blocking(first: 50)`
  (GitHub's own limit per type) on another alias per issue, `dN`, with `rN`'s variables, as the
  sub-issues are on `hN`. Still ONE call per batch, measured at 1 point and 12.8 KB for the
  ten-issue #117 family (`test/fixtures/issue-relations-10-deps.json`). The alias is what isolates
  the sections: GitHub marks the three fields, their `Int!` counts and `pageInfo` non-null, so an
  error in any of them nulls the whole issue it was asked on. Inside `rN` that would turn the issue
  into a soft `gh-failed` and stop its hierarchy refreshing; on `dN` it nulls only `dN.issue`.
  (1) **Parsing** (`parseIssueBatch`) fails closed per section: the issue and hierarchy are read
  from `rN` and `hN` as above, and the section only from `dN`, where any error, or a null or missing `dN.issue`, makes only that
  issue's dependencies `unavailable` (never the issue itself, whatever the error's type); each
  listed issue is validated like a child, and an invalid one is dropped and marks its list
  truncated; the root itself and repeats are dropped; lists cap at 50 and are kept in key order
  (GitHub's order means nothing). `open`/`total` come from the summary alone (an issue the token
  cannot see is no truncation), and an unreadable summary or list, or more open than total, makes
  the whole section unavailable: one half alone could read as "blocked by nothing". (2) **Storage:**
  `issue_snapshots.dependencies` (additive) holds `{ v: 1, fetched_at, status, blocked_by,
  blocking }`, written by `upsertIssueSnapshot` in the SAME statement as the snapshot (omitted:
  NULL) and validated on write and read. It counts only while BOUND, its `fetched_at` equal to the
  row's: a v1.4 success moves `fetched_at` without knowing the column, and a v1.4 hard failure
  clears it, so either one unbinds the section rather than erasing it; this build's hard failure
  also clears the column, and a soft failure keeps it bound. A leftover can never be re-bound,
  since every applied write starts after `checked_at`. `listIssueSnapshots` returns `dependencies`
  only when valid, bound and beside a readable snapshot, else null: "unknown", never "no
  dependencies". `completeIssueRefresh` records a refused section like a refused snapshot (a soft
  `gh-failed`, through `onInvalid`). Frozen v1.4.0 statements pin the binding in
  `test/mixed-version.test.ts`; the v1 snapshot keeps its shape, so a v1.4 viewer reads every row.
  (3) **Queue:** tiers are new, `upgrade`, nudged, due. `upgrade` is a SUCCESS (`error` null) with
  a readable snapshot but no bound section: fetched at once, so a hub catches up at 10 keys a
  tick after an upgrade, and a v1.4 viewer's refresh costs one refetch. A failed row keeps its own
  TTL, deliberately narrower than the design's §5.4: without `gh`, or offline, it would otherwise
  be retried every tick. So does a row whose `checked_at` is ahead of the clock (it moved back):
  the attempt rule would refuse every write, and the key would be fetched every tick. A settled
  PR also nudges each key whose bound section lists its certain closing issue as an OPEN blocker.
  (4) **Who reads it:** only `src/issue-graph.ts` (PR B, below), for `/api/issues` and
  `issue_rel`, and through it the Plans chips and lists (PR D, `plans-issue-ui.md`); attention never reads it.
- **GitHub dependencies are reconciled purely into `blocks` edges (issue #103 slice 2, PR B).**
  Design §6. `buildIssueGraph` reads each display root's own bound, `ok` section (rule 9) as
  observations about a pair "A blocks B": the dependent's `blocked_by` or the blocker's
  `blocking` naming the other is a positive at that fetch's `t`; a COMPLETE list of either end
  that omits the other is a negative. A truncated list says nothing about what it lacks, and a
  missing, unbound or unavailable section says nothing at all. Five rules hold. (1) **The newest
  decides, and a negative wins at equal `t`**: a missing "waits on" degrades to today's view, a
  false one misleads. (2) **Rule 6 on both ends:** nothing observed at or before either end's
  hard failure counts, so newer facts that bring a refused issue back never bring its older
  pairs; a refused root's own section records nothing, and that root reports `dependencies:
  "unknown"` (review of #271: it used to read "known, none"). (3) **Cycles are data:** every edge inside
  a strongly connected component carries `cycle: true`. The components come from an iterative,
  linear Tarjan, a local copy of `waitsOnComponents`, because `issue-graph.ts` imports no value
  but `issueKey` and the stdio graph gains no module. Self-pairs are dropped, and only the
  observing root is alias-folded (listed keys are GitHub's canonical answers). (4) **Counts and
  facts:** a node's `deps` come only from its own bound, `ok` section, never inferred from other
  lists; listed issues' facts are a `LISTED` source, so an issue's own root wins at equal `t`.
  (5) **The cap:** S1's 2,000 units and order, then dependency neighbours round-robin across the
  kept roots in rank order, blockers before dependents, by key. A `blocks` edge needs both nodes
  emitted, and every edge of a response, both kinds, stays within `2 × maxUnits`: containment
  first (at most one per node, so never cut), then `blocks` edges in the same round-robin, then
  any other between emitted nodes, by key. `truncated.dependencies`, `truncated.edges` (both
  kinds) and each root's `dependencies_omitted` (its entries not emitted) are exact, as is
  `dependencies_omitted_open` (#275: `{ blocked_by, blocking }`, those whose other end is OPEN
  by the same freshest facts its node would carry, split by direction; an unknown state is not
  open, and an entry rule 6 dropped is in neither count). Everything is additive within version 1
  (`blocks` edges, node `deps`, root `dependencies` `ok|unavailable|unknown|null`,
  `dependencies_omitted` and `dependencies_omitted_open`), and the bytes still depend on the
  database alone, so `/api/issues` stays a store-token conditional snapshot.
  `public/snapshots.js` accepts the body unchanged; PR D (`plans-issue-ui.md`) draws it, and
  `test/issues.test.ts` and `test/dom/issue-relations.test.ts` pin that breadcrumbs, child
  progress and grouping are the same with and without `blocks` edges and the new fields, and
  `test/dom/issue-attention.test.ts` pins attention. Dependency lists are still a rule 7 fact
  source, so a fresher list can update an issue's title or state and, at the cap, a root's rank. **`issue_rel` calls them
  `waits_on_issues` and `unblocks`, never `waits_on`:** a titled `board_get` row already
  carries its own writable `waits_on` step labels, while these are read-only GitHub issue keys
  (open blockers that reconciled to an edge, sorted, at most 50) and a count of open dependents,
  never a reason for `blocked`; no name here is built on "blocked". Both appear only while the
  key's own section is bound, `ok`, at most 7 days old and not dropped by rule 6 (absent is unknown; `[]` and `0` are
  none), whatever the hierarchy's `unavailable` says. `issueRelations` reads the uncapped graph,
  because a cut list would look complete; `pending()` and the title-less summary carry nothing new.
  **The cap bounds the response, not the work, so the build must stay linear and free of
  per-pair string work** (review of #271): every display root's dependency entries are read
  before anything is cut, and the viewer rebuilds `/api/issues` after any database write, on
  Electron's main thread in the packaged app. Positives live in maps by their two ends, nothing
  sorts them (only the edges the round-robin leaves, and those emitted), accepted pairs are
  records nothing re-splits, facts keep the freshest observation as it arrives, and `issueKey`
  runs once per repository and number. 2,000 roots listing 50 issues each way build in about
  110 ms (about 540 before), byte-identical.
- **Explicit plan pins and row links are agent-owned row content (issue #103, PR2).**
  `boards.issue_pin_repo`/`issue_pin_number` and `board_rows.issue_repo`/`issue_number` are
  additive columns written only by `upsertBoard` (`issuePin`, `rows[].issue`) and
  `updateBoardRow` (`issue`), validated and repository-lowercased in `store.ts`. They follow
  every other agent field's omission rule: undefined keeps, `null` (MCP `""`) clears. A link
  change bumps the row `revision` and `updated_at`; a pin change bumps the board revision.
  `beginNewRowAction`/`advanceBoardRow` and status moves never name the columns, so
  `board_advance` and a reblock keep the link, and no frozen v1.3.1 statement can clear them
  (`test/mixed-version.test.ts`). In `public/issue-key.js` a plan pin outranks the PR and
  branch issue and a row link is a row's only source; both are certain. `boards.repo`,
  `issue_ref` and the PR lookup are untouched. `listIssueEntities` adds linked rows of active
  and archived plans, so they join the poller's key sets. MCP (`normalizeIssue` in `mcp.ts`)
  accepts only `owner/name#N`, `#N`/`N` against the session's `repo` (refused when there is
  none) and `https://github.com/owner/name/issues/N`, and refuses anything else with that
  list. `shape.ts` replaces the raw columns with one `issue: "owner/name#N"` string on titled
  reads and adds `issue_rel` (`issueRelations` in `issue-graph.ts`: keys and counts, never
  titles, only when the cache holds an answer); `pending()` (`listPendingRows` selects named
  columns) and the title-less summary carry neither, byte for byte. The viewer's
  `/api/boards` simply gains the raw columns, as store rows always have. Because
  `dist/mcp.js` now imports `../public/issue-key.js` (and through it `source.js`/`esc.js`),
  `scripts/stage-runtime.mjs` stages exactly the `public/` modules `dist/` reaches into every
  runtime payload; a runtime without them could not even start its MCP server. Since
  `hook-cli selftest` reaches no `public/` module, `scripts/runtime-mcp-probe.mjs`
  (`probeRuntimeMcp`) starts the runtime's own `dist/mcp-server.js` with its own Node against
  a scratch database and requires initialize + tools/list to answer, bounded by a timeout
  and writing nothing to stdout. Then it closes the server's stdin and lets it exit,
  killing it only after a 2-second grace: on Windows a kill is TerminateProcess, which
  would orphan a git the server runs for its presence write, still open inside the
  runtime about to be renamed (#333). Staging and release assembly both run it beside the
  selftest.
- **`waits_on` is agent-owned row content: labels, checked where it is written (issue #103,
  slice 2 PR C).** Design: [`docs/superpowers/specs/2026-10-21-plan-dependencies-design.md`](../../docs/superpowers/specs/2026-10-21-plan-dependencies-design.md)
  §4. `board_rows.waits_on` is one additive column holding the sorted, de-duplicated JSON
  array of OTHER rows' labels in the same plan (NULL = none), written only by `upsertBoard`
  (`rows[].waits_on`) and `updateBoardRow` (`waits_on`). It follows the omission rule:
  undefined keeps, `[]` clears; a change bumps the row `revision` and `updated_at` (and the
  board revision). `beginNewRowAction`/`advanceBoardRow`, status moves, every human/browser
  write and every frozen v1.4.0 statement never name it, so `board_advance`, a reblock and an
  older server's writes keep it (`test/mixed-version.test.ts`). Five rules hold. (1) **Shape
  before anything is written** (`waitsOnLabels`): at most 20 raw entries, none empty, never
  the row's own label. MCP's zod schema refuses the same sizes and empty labels at the call
  site; only the store refuses a row naming itself. (2) **Meaning inside the writing
  `.immediate()` transaction, after its rows are written** (`checkWaitsOn`), so a refusal
  rolls the whole write back and a dependency committed while the write waited for the lock
  still counts. (3) **Only what the write adds is checked.** A label a row names for the
  first time must be a row of the plan after the write (for `board_upsert`, the payload); a
  label already stored is never re-checked. That is what keeps a label whose row was removed
  (a v1.5 upsert that omits it, or an older server's DELETE) **dangling**: kept, drawing
  nothing, re-sendable as `board_get` echoed it, and reviving when a row with that label
  returns. Never prune it: that would rewrite other rows' agent-owned fields and revisions.
  (4) **A write may not create a cycle**: every edge it adds or revives (a returning row
  brings back the labels naming it) is refused when its target already reaches its source,
  and the error names the shortest cycle through the first such edge in row order. **The
  check is linear and must stay so**, because it runs holding the hub's write lock: strongly
  connected components are computed once (`waitsOnComponents`, iterative Tarjan) and the
  path search (`waitsOnPath`) runs only for the first added edge whose ends share one,
  which is exactly the edge a search per edge would refuse, with the same message. A search
  per edge held the lock for 5 s on a 1000-row plan, long enough for another process's
  write to fail on `busy_timeout` (`test/store.test.ts` pins the time). A cycle already
  stored (only a raw write can make one: this build refuses it and older builds write no
  `waits_on`) is not an unrelated write's to fix. When no row of the write carries
  `waits_on`, nothing is checked: a returning row without one can be waited on, never
  wait. (5) **Reads never
  throw**: `parseWaitsOn` reads anything but a valid 1–20 label array as `null`, and an
  unreadable stored value counts as no stored labels for (3). `shape.ts` echoes it exactly
  as stored on titled `board_get` rows that have one (absent otherwise), so a read → re-send
  is a no-op; `pending()` and the title-less summary never carry it, and `/api/boards` simply
  gains the field. It is never `blocked`, never attention: `public/attention.js`,
  `relay.js` and `reply-watch.cjs` name no `waits_on` (pinned in
  `test/dom/issue-attention.test.ts`).

## History (shipped since v1)

These landed after v1 and still hold invariants; the release history itself is in `CHANGELOG.md`.

- **Source + PR links** *(#30)* — split along the network boundary. Link IDENTITY is inferred
  locally at write time by the stdio server (`inferRepo`/`inferIssueRef` in `src/infer.ts`, carried
  on the scope, stamped as `items.repo`/`items.issue_ref` and the same two on `boards`); live PR
  STATE is fetched only by the viewer process (`src/prstate.ts` → `gh pr list`), cached one row per
  `(repo, branch, head_repo)` in `source_links_by_head`, and served read-only at `GET /api/links`.
  `public/source.js` joins the two and renders an issue chip plus a PR chip with a native `title=`
  TL;DR. The branch→issue heuristic is deliberately CONSERVATIVE (`30-x`, `feat/30-x`, `issue-30`,
  `issues/30`, `gh-30` — never a trailing year, a segment starting with a complete date such as
  `2026-10-14-x`, or `release/2.1`), because a link to the wrong issue is worse than no link; `gh`'s
  `closingIssuesReferences` overrides it and `register({ issue })` is the manual escape hatch.
  Non-github remotes render NOTHING (the `provider` column + `parseRepoSlug`'s host check are the
  GitLab/GHE seam). **Head verification (#157):** `gh pr list --head` matches the branch NAME in
  every fork, so `repo` is only the BASE the PR is searched in. Flag/board writes also stamp
  `head_repo`, the github repository the branch is pushed to (`inferHeadRepo`: the push url —
  `git remote get-url --push`, so pushurl counts — of git's push remote for that branch, or the URL
  configured in its place as `gh pr checkout` and `git push -u <url>` write it, else origin's; local
  git only, independent of `register({ repo })`). The poller
  examines a small `PR_WINDOW` and accepts only a PR from that head repository (a same-repo
  expectation means `isCrossRepository: false`); a row with no `head_repo` expects a same-repo PR.
  No match, even a full window, is cached as no PR — no title, closing issue or preview — and the
  preview's head re-read applies the same rule. **Pull-ref checkouts (#183):** for a fork PR whose
  author did not allow maintainer edits, `gh pr checkout` tracks the base's `refs/pull/<n>/head`
  and names the BASE as remote and pushRemote (cli/cli `cmdsForMissingRemote`), so the push
  destination alone would let the base's own same-named branch PR verify. A branch whose upstream
  merge ref is a pull ref, and that pushes back to the remote it tracks (gh always writes
  pushRemote = remote; an unmapped upstream reports no tracking remote at all), is stamped with
  that ref as its `head_repo` instead: it names no repository, `listLinkTargets` skips it (no
  `gh` call, no cache row, no PR chip), and an older #157 viewer sharing the file can never match
  it either. Work stacked on a PR ref and pushed to another remote (`remote.pushDefault` = a
  fork) keeps its push destination and links as usual. The one `for-each-ref` also reports any
  upstream git maps, with its remote, so `git config --get-all branch.<b>.merge` runs only for a
  branch with a push remote but no mapped upstream; an ordinary write still costs two spawns.
  Items stamped before #183 keep the head they were written with (boards restamp on their next
  write). Linking the exact PR (`gh pr view <n>`) is a deliberate non-goal until reviewer
  checkouts are in scope, and it would need the FETCH repository recorded as well: `<n>` belongs
  to the repository of `branch.<b>.remote`, which can differ from `repo`, and the stored ref does
  not say which. The unverifiable pre-#157 `source_links` table is
  never read; it stays only for older processes sharing the file (rebuilding its primary key would
  break their `ON CONFLICT(repo, branch)` upserts). **Two honest limitations:** every item and
  board written before #30 shipped has `repo = NULL` and shows no chip at all — there is no
  backfill, and there cannot be a correct one; and `gh pr list` does not return the linked issue's
  TITLE, so `issue_title` is always null in v1 and the chip reads `#30`.
