# CLAUDE.md

Guidance for Claude Code (and any coding agent) working in this repo.

## What this is

`agent-inbox` — a local, cross-project, cross-tool attention inbox for coding agents. A
stdio **MCP server** lets agents `flag` open questions and non-blocking notes and maintain
**tracking boards** (titled status tables); everything lands in one SQLite hub
(`~/.agent-inbox/inbox.db`); a local **Hono viewer** renders the cross-project inbox and
boards. No LLM/model calls anywhere — this is dumb infra (store + viewer + thin MCP
server). See [`README.md`](README.md) for the full picture and
[`docs/superpowers/specs/`](docs/superpowers/specs/) for the design docs (inbox v1 +
tracking boards).

MCP tools: `flag`, `pending`, `answer`, `resolve`, `register`, `whoami` (items/scope),
`board_upsert`, `board_row`, `board_get`, `board_archive` (boards) and `status` (live
presence) — all defined in `src/mcp.ts`.

## Commands

```sh
npm test            # vitest run — full suite (one shot)
npm run test:watch  # vitest watch
npm run typecheck   # tsc --noEmit (strict; noUncheckedIndexedAccess)
npm run build       # tsc -p tsconfig.build.json → dist/ (entry: dist/mcp-server.js)
npm run mcp         # run the MCP stdio server via tsx (local iteration)
npm run view        # run the viewer on http://127.0.0.1:4319 via tsx
npm run install:hooks           # DRY RUN of the opt-in backstop hooks installer (docs/hooks.md)
npm run install:hooks -- --apply    # …and actually write ~/.claude/settings.json
npx vitest run test/mcp.integration.test.ts   # single file
npx vitest run test/dom/                      # the jsdom viewer tests only
```

**Node 24 only (for this checkout).** `better-sqlite3` compiles one native binding per
install; this repo's is built for Node 24 and `.node-version` pins it — run `fnm use 24`
before anything (or prefix one-off commands with `fnm exec --using=24 …`). (Since the v12
upgrade the library itself supports newer Node — the packaged Electron app rebuilds it for
Electron's ABI in `build/stage` — but the checkout standardizes on 24.) This bites twice:
(1) the integration test **spawns** `npx tsx src/mcp-server.ts` as a child, which inherits
your shell's PATH, so Node 24 must be active when you run `npm test`; (2) when registering
the server with a CLI, pin the **absolute Node 24 binary path**, never bare `node`.

## Architecture & invariants

- **The local viewer boundary lives in `src/viewer-network.ts`, never in
  `createViewer()`.** It composes an outer Hono app before the viewer/static routes,
  binds one listener to `127.0.0.1`, validates exact loopback Host/Origin values and
  emits the marker Electron requires before reuse. Every accepted response also carries
  CSP `frame-ancestors 'none'` plus `X-Frame-Options: DENY`; otherwise a hostile page can
  frame the viewer and turn a click into a trusted same-origin mutation. Every unsafe
  request requires an exact trusted Origin; Fetch Metadata is an independent rejection
  signal. `localhost` is an allowed browser authority but does not widen the
  `127.0.0.1` socket, and a rebinding hostname retains its rejected Host/Origin. There is
  no `::1` listener or host-widening environment variable. Keep this module
  viewer-process-only: hosted auth is a separate entry, and no network code may enter the
  stdio MCP import graph.
- **Conditional snapshots must remain authoritative.** Only `/api/items`,
  `/api/boards` and `/api/boards/archived` retain one serialized representation
  each per viewer, plus `/api/items?scope=attention` (issue #156): the Electron
  dock watcher's lean read, built from open questions alone and registered
  separately with its own validator so neither `/api/items` representation can
  revalidate the other, `/api/items/history` (issue #184, below), likewise its
  own registration and validator, and `/api/issues` (issue #103, below), the sixth.
  Any other query string keeps the default items response.
  Matching `If-None-Match` returns a bodyless 304; unconditional
  clients still receive full JSON. Keep `Cache-Control: no-store` and the current
  outer `x-inbox-boot` marker on 304 responses too. Store-only invalidation reads
  combine `data_version`, `total_changes()`, `schema_version` and transaction state:
  neither `updated_at` nor `data_version` alone observes every relevant write.
  Publish a cache entry only when matching before/after tokens prove it was read
  outside a transaction without intervening changes. Never cache uncommitted data,
  label an old body with a newer token, or fall back to cached success on a read
  failure. Activity and the other dynamic routes remain fresh; time passing
  without a database write still changes claim expiry. `/api/activity/history`
  (issue #185) is conditional on its bytes instead, because time alone changes
  them too: an open span gains its capped end once it goes cold. Its tag hashes
  the freshly computed body plus the parsed `since_ms` and project that selected
  it, so a 304 means identical bytes and no two windows share a validator. Never
  derive that tag from store tokens or cache the body server-side; the whole
  route costs under a millisecond on a #161-sized hub. The poll floors its 30-day
  `since_ms` to the hour (`activityHistoryUrl`), so successive ticks name one
  representation.
  This is bounded snapshot reuse, not a cross-endpoint synchronization protocol.
  The browser keeps its own window-local, deeply frozen representations. A 304
  reuses the exact representation that request revalidated, not a later overlapping
  load's cache entry; older completions cannot overwrite a newer validator/body.
  A query string selects one representation of its route; the reader retains only
  each route's newest one and reuses it only for the exact URL that fetched it.
  Only `/api/activity/history` takes a query in the reader: any other (such as the
  dock watcher's `?scope=attention`) is refused, so it can never share or evict
  the page's slot, and `/api/items/history` is a path of its own (#184).
  Read the live boot header before consuming cached data. Untagged servers retain
  full-fetch behavior, malformed replies fail explicitly, and no snapshot content
  is persisted to browser storage. Derive mutable view state rather than changing
  authoritative cached records. A poll tick starts its seven reads together (#161)
  and applies nothing until all settle: history, closed projects and links keep
  their fallbacks, any other failure still fails the whole tick (reported in the
  old serial order) without blanking the frame, and `loadGeneration` still
  discards an older tick that finishes late.
- **Closed history is paged out of the default items snapshot (issue #184).**
  `/api/items` carries every open item, the `RECENT_CLOSED_ITEMS` (50) most
  recently TOUCHED closed items (`listItemsPage`: the newest of every item stamp)
  and the `RECENT_OUTCOMES` (4) newest outcome-bearing closed items of open
  projects (plus ties), so closures without an outcome (Inbox resolve/dismiss,
  hook sweeps) can never push the Dashboard's default lens off the page. A
  `history` summary, read in the same snapshot, gives exact totals, `before` (the
  newest touch of any omitted item) and per project/agent counts of what it
  omitted with `latest`, the newest Dashboard stamp among their outcomes. A touch
  is never earlier than creation, so page entries created after `before` are a
  complete, correctly ordered History prefix; outcomes stamped after the lens's
  `latest` are a correct recent-outcome prefix (`public/closed-history.js`).
  Counts (History tab, Dashboard outcomes/projects, rail projects, agent picker)
  add the summary, so they never depend on the omitted bodies.
  `/api/items/history` returns exactly the unpaged `done` list, and ONLY `load()`
  reads it: as an extra read when the previous frame needs older history
  (`historyWanted`: a search in use — open results, a pending or focused query,
  not text left in a closed box — the Handoffs overlay, History paged past what
  the page proves, a History deep link, a pending deep link to an omitted item, or
  Dashboard recent outcomes the page cannot prove), or, within the same tick and
  under the same boot-marker and generation rules, when the tick's own new page
  needs it, so a sweep never paints a blank History frame. Decide on a PAGE
  (`lastData.page`, or the tick's new one), never on merged data, or loading
  history would end the need for it. Explicit human entry points (tab select, the
  History pager, rail project/agent picks, opening Handoffs, a deep link that
  found its target) call `requestHistoryPaint()`, which ends in `reloadAndPaint()`
  so an unrelated draft or a focused Dashboard control cannot hide the frame the
  click asked for (#38). Typing or focusing search, and a deep link waiting on an
  omitted item, only call `requestHistory()`: it schedules an early `load()` and
  paints nothing, because search renders its results directly and the deep-link
  retry paints through `focusItem`. `forceRender`, every render and the poll call
  neither, so passive paths never force a paint and render paths never fetch. An
  in-tick read rejects only markers that disagree within its tick, as the main
  path does, so ticks keep applying while a restart reload waits. A failed read
  degrades like activity history: the page still applies, and the surfaces waiting
  on older history say "Older history is unavailable right now." The page stays
  authoritative for every item it carries when the two are merged. Surfaces still
  waiting show known entries and a loading state, never an incomplete list as if
  complete: search stays busy, History and Handoffs say older items are loading.
  A deep link waiting on older history lands only if the human has not navigated
  since (`navigationKey`) and no pointer is held; otherwise it waits or is dropped.
- **`src/store.ts` is the only door to the database.** Every read/write goes through its
  exported functions — items: `insertItem`/`resolveItem`/`dismissItem`/`annotateItem`/
  `replyItem`/`answerItem`/`listItems`/`listItemsPage`; boards: `upsertBoard`/`updateBoardRow`/`getBoard`/`listBoards`/
  `archiveBoard`/`annotateBoardRow`/`markAnnotationDelivered`/`markRowHandled`/
  `clearRowHandled`/`markHandledDelivered`/`listPendingRows`; watch stops (#217):
  `stopItemWatch`/`stopBoardRowWatch`;
  projects: `closeProject`/`reopenProject`/`listClosedProjects`/`closedProjects`;
  issue snapshots (#103): `upsertIssueSnapshot`/`recordIssueFailure`/`listIssueSnapshots`/
  `listIssueEntities`/`pruneIssueSnapshots`/`claimIssueRefresh`/`completeIssueRefresh` — plus `openDb`. No raw SQL anywhere else. To change
  storage, reimplement this module; nothing else touches SQLite.
- **Boards: the human's annotations are sacred.** A board is idempotent by
  `(project, title)` (UNIQUE); rows match by `label`, positions come from array order.
  `upsertBoard` deliberately never touches `board_rows.annotation` — human per-row notes
  must survive a full re-upsert. But rows *absent* from an upsert are deleted (annotations
  with them), so agents must keep labels stable. There is no FK enforcement between
  `boards` and `board_rows` — deletes are handled explicitly in `store.ts`. The same
  protection covers `annotated_at`/`annotation_seen_at`/`annotation_seen_by`: a re-upsert
  that reset delivery would re-attribute the note to whoever polls next and reset the
  "delivered 3h ago" age the human reads as evidence. **Issue #36's `handled_at` (plus its
  `handled_seen_at`/`handled_seen_by`) is sacred on the same terms** — it is the human's
  "I did my part" on a blocked TASK row, and the prescribed agent flow is a full-table
  re-send, so an upsert that dropped it would wipe their action on every routine refresh.
  Exactly ONE thing clears it, in `resetHandledOnReblock`: a status transition INTO
  `blocked` from something else, i.e. a genuinely new ask. Re-sending a row that is already
  blocked is not an acknowledgement and must never reset it.
- **Actionability is stored, never inferred from prose.** Item `detail` and board-row `note`
  are one-sentence TL;DRs; `next_step` is the ONE concrete human action; `action_owner`
  (`decision|task|approval`) says who acts; `impact` says why now; `next_after` says what
  follows. MCP requires the action fields on every question/blocked row. decision/approval
  carries 2-4 `options`; task omits options and gets "I've done my part." Long history belongs
  in collapsed `context`. These are additive agent-owned fields: full-board upserts preserve
  omitted values, explicit empty values clear them, and legacy rows use note/detail fallbacks.
- **Snooze is a demotion, never disappearance.** `snoozed_until` excludes an unanswered item
  or row from `attentionEntries`/badge counts until due, but `snoozedEntries` renders it in a
  visible fold with Wake now. The three-way complement for blocked rows is attention ∪
  awaiting-agent ∪ snoozed. Clarify/decline are response kinds and therefore human action;
  they move to awaiting-agent and never pretend to be an outcome.
- **Row chaining is versioned and atomic.** `board_advance` uses row `revision` as its CAS
  token; `action_version` is only the human-step number. `advanceBoardRow(...).immediate`
  archives the current action/response/outcome into JSON `history`, clears every
  human/delivery/snooze/outcome field, increments both counters,
  and installs the next blocked action in one write transaction. Ordinary nonblocked→blocked
  transitions use the same archive/reset path. Agent reads get only `history_count`; the
  viewer alone receives full history. *(#217)* The watch stop and the action's asker are
  reset by the `reset_row_action_watch_state` trigger instead, whenever `action_version`
  moves, so an older server sharing the file cannot carry them into its new action.
- **Every row action is version-pinned.** MCP `board_upsert` existing rows carry row
  `revision`; `board_row` carries `expected_revision`; browser/native annotate, snooze and
  handled writes carry row revision plus board revision. A stale notification or sibling
  therefore cannot answer or complete the newer action that reused the stable row id.
  A move alone is not a row change (#158): a reorder bumps the board revision, which still
  refuses a pre-move full-table snapshot, but never the row `revision` or `updated_at`.
  Native notifications key rows by revision (`attentionNotification` in
  `electron/reply-watch.cjs`), so an unchanged ask is not re-announced and its earlier
  buttons still apply through the board-token refresh.
- **Viewer write bodies are validated before the store sees them** *(issue #163)*. Every
  JSON write route in `src/viewer.ts` parses with `.catch(() => null)` and type-checks each
  field it uses: `text` a string; when present, `context` a string, `kind` a response kind
  and `handled` a boolean; `until` a parseable date (stored as UTC ISO, because the store
  compares `snoozed_until` as text) or null; revisions integers. Invalid
  input is `400 { ok:false, error }` with no store call: never a 500 from a parse or `trim()`
  throw, and never a coerced default that silently overwrites state with a 200. The split is
  `postJSON()`'s contract (a non-2xx means "the write never happened"), so a store REFUSAL of
  a valid request stays `200 { ok:false }`. An explicit `''` is still a clear.
- **`updated_at` means content changed.** Item/row human or agent content writes bump it;
  delivery stamps (`markReplySeen`, `markAnnotationDelivered`, `markHandledDelivered`) never
  do. The viewer's New/changed filter depends on this distinction just as Live depends on
  `last_call_at` rather than liveness heartbeats.
- **Delivery is not acknowledgement (issue #37).** `board_rows.annotation_seen_at` records
  ONE fact — this text was handed to some agent — and it silences nothing: not the human's
  screen, and (since F1) not the agent's queue either. The row stays `blocked` and stays in
  BOTH places until an agent flips its status, which IS the acknowledgement.
  Three consequences that must not be "simplified" away. (1) `annotation_unseen` derives from
  the PER-ROW stamp only — `boards.last_read_at` still gets written by `markBoardRead` but
  is pure decoration (its only real use is the one-shot migration backfill); a second input
  would disagree invisibly, since nothing renders it. (2) The attention predicate
  (`public/attention.js`) reads what the HUMAN did, never the delivery state:
  `isBlockedRowAttention = status === 'blocked' && !humanActedOnRow(row)`, where
  `humanActedOnRow` is the one place that knows a row can be answered in words
  (`annotation`) OR by going and doing it (`handled_at`, #36). The rows it drops are
  RELABELED into `awaitingAgentRows()` — same module, rendered in the Needs-you foot — not
  deleted. Removing the alarm without relabeling it is the worse bug, not the fix.
  (3) **`listPendingRows` gates on the ACKNOWLEDGEMENT, not on the stamp:** still pending
  while `status = 'blocked'`, or while either half (annotation, `handled_at`) is
  undelivered. Gating on the stamp made rows
  at-most-once while items are at-least-once (`listPending` is gated on `status='open'`), so
  in a fan-out a sibling's routine poll ate the answer, the session that RAISED the row never
  got it, and the human's card then claimed "delivered to claude-code". A blocked row is
  therefore re-delivered on every poll until the status flips — the same window the human is
  still staring at it — and the payload carries the stamp so a re-delivery is self-labelling.
  A non-blocked row has nothing to acknowledge and stays at-most-once; without that half a
  months-old aside would be a permanent firehose.
- **Every mark-seen write pins the version it read.** MCP supplies the item's monotonic
  `response_revision` to `markReplySeen` and the row/board revisions to
  `markAnnotationDelivered` and `markHandledDelivered`, as well as the exact
  timestamp the read returned (`... AND replied_at IS ?` /
  `AND annotated_at IS ?` / `AND handled_at IS ?`, `IS` because legacy rows
  carry NULL). The viewer writes answers from its own OS process, so an unconditional stamp
  marks text the human just replaced as picked up. Never SELECT-then-UPDATE with a gap;
  `annotateBoardRow`, `replyItem` and `markRowHandled` reset the stamp in the SAME statement
  that writes the new value. The delivery functions' boolean means ONLY "the text you read is still
  there, safe to hand over" — never "you were first" (re-delivery is normal now), and its
  `COALESCE` is what keeps the two apart: the stamp records the FIRST delivery and never
  moves, because its AGE is the human's evidence that an agent has sat on the answer.
  `pending()`'s `.filter()` consuming that boolean is what drops replaced text — pinned at
  the MCP level in `test/mcp.integration.test.ts` and `test/response-safety.test.ts`.
  Same-millisecond corrections are distinct revisions; the item trigger also versions
  response writes from an older process. A question's reply and annotation receipts
  are stamped atomically against one response revision: withholding a changed
  snapshot must not leave either half falsely marked picked up.
  `board_get` retries a whole changed snapshot
  and fails explicitly if it cannot obtain one; never omit a stale row from a board
  read, because a subsequent full upsert would delete that row.
- **Agent resolution acknowledges an exact response, not another reader's pickup.**
  After an item has any response history, including a cleared reply or annotation,
  MCP `resolve` requires `expected_response_revision` from the response the caller
  handled. `pending` and successful `answer` return that revision. Missing or stale
  revisions are refused; another sibling reading newer text cannot authorize an older
  response. Items with no response history retain ordinary resolution; explicit
  human and hook closure paths remain separate. `pending({item_id})` recovers the
  current open item's text or clear state and revision after ordinary delivery ends.
  Reply and clear writes require an open question, so stale notifications cannot
  rewrite closed history. Clients using the older answer-then-resolve contract must
  adopt the revision argument rather than silently bypassing this guard.
- **Informational-item annotations are feedback, not another attention alarm.**
  MCP opts into open note/milestone annotations through `listPending`; its default
  remains question-only for hooks and backstops. Informational feedback, including a
  clear, leaves the ordinary poll after pickup without closing the item. Targeted
  `pending({item_id, project?})` recovers only that current open item in the selected
  project, without delivering other items or board rows. `annotated_at`,
  `annotation_seen_at` and `annotation_seen_by` keep edit and first-pickup state
  distinct; legacy text has unknown edit time and no fabricated pickup.
  Version-pinned delivery never bumps content `updated_at`; annotation writes reset
  pickup even from an older writer. Annotations require an open item, and callers
  must check the JSON `ok` rather than infer success from HTTP 200. Neither pickup
  nor the reader's client label proves that the intended session acted; no new
  informational host-wake guarantee or human-attention entry is implied.
  Item reply and annotation timelines are independent: neither may borrow the
  other's timestamps to claim pickup. The Note prompt retires an attempt only on
  JSON `ok:true`; refused or transport-unconfirmed text, including a clear intent,
  stays in the existing window-local recovery surface and protects automatic
  restart. Retry requires explicit review, closed targets cannot retry, and local
  recovery Clear never changes the stored annotation. Do not claim crash-durable
  persistence or that a transport error proves the write never committed.
- **Two answer channels, ONE precedence rule: the inbox always wins.** A question can be
  answered on the card (`replyItem`, source `'inbox'`) or out loud in chat and recorded by
  the agent (`answerItem`, source `'agent'`). It is deliberately NOT wall-clock
  last-write-wins — a skewed clock or a delayed flush would let a stale chat answer clobber
  a fresh inbox one. `answerItem` is ONE conditioned UPDATE that only writes while nothing
  unread is waiting (`reply IS NULL OR reply = '' OR reply_seen_at IS NOT NULL`) and
  otherwise returns `{ok:false, reason:'unread_inbox_answer'}` with the waiting answer;
  `replyItem` overwrites an open question's answer and resets pickup. Never SELECT-then-UPDATE and
  never two UPDATEs here: the viewer writes from its own OS process and would land between
  them, leaving the human's newest answer flagged "✓ picked up" and un-clearable. An agent
  may overwrite an answer it has already picked up, but may never blank one.
- **One process per CLI (stdio), one shared file.** A server is spawned per *client process*, not
  per agent session — a subagent's calls are served by its parent CLI's long-lived server
  (measured: servers observed running 4+ days), so a fan-out shares one process, one `sessionId`
  and one in-memory ledger. All instances write to the same `~/.agent-inbox/inbox.db`. Concurrency
  is handled by **WAL + `busy_timeout=5000`** set in `openDb` — keep both. Writes are single tiny
  inserts; this is WAL's happy path. `busy_timeout` never applies when a deferred transaction's
  read snapshot is promoted to the writer — that fails at once with `SQLITE_BUSY` or
  `SQLITE_BUSY_SNAPSHOT` — so any transaction that reads before it may write must be
  `.immediate()` (#154).
- **Two activity stamps, and only one of them means work** *(issue #45)*. `activity.updated_at` is
  LIVENESS: the 5-minute `touchActivity` timer bumps it whether or not the agent has done
  anything, so `listActivity`'s 15-minute cutoff can only ever catch a **crashed** process and is
  not evidence of activity — that is why a row was observed advertising a 2-day-old effort.
  `activity.last_call_at` is written by `recordActivityCall` ONLY, called from `heartbeat()` in
  `src/mcp.ts`, i.e. by real MCP calls; **the timer must never call it**, and that one line is the
  whole distinction — which is why the timer's body is the named export `livenessTick` rather than
  an anonymous callback: inline it was unreachable, and a `recordActivityCall` added beside it
  reinstated the whole bug with the suite green. `test/live-tick.test.ts` pins both halves (what
  the tick does over 12 modelled hours of silence, and that the interval calls nothing else).
  A `doing` claim is live while that stamp is within `CLAIM_COLD_MS` (30 min)
  and otherwise decays to `doing:'open', idle:true, children:[]`. **The decay is in two places on
  purpose.** It is derived on every read in `listActivity` (a session that goes quiet forever needs
  no further write to stop lying) *and* cleared by `recordActivityCall` when the call it is
  stamping lands after a cold gap — read-side alone would let a routine `pending()` poll resurrect
  a two-day-old claim, which is exactly what the observed rows were doing. Both comparisons share
  `CLAIM_COLD_MS`/`claimCutoff` and both fall back to `started_at` when `last_call_at` is NULL, so
  a just-registered session is never born cold and a legacy row always is. **The row itself is
  never dropped for being idle:** `public/attention.js` calls an item `waiting` iff its session id
  is in `/api/activity`, so expiring a quiet-but-live session would silently demote a genuine
  blocker to `parked` (and the same list sizes Electron's dock badge). Long-idle sessions sink to
  the bottom of the fold and render `dormant` instead — sorted, dimmed, never removed.
  `activity.last_doing` is a separate, historical caption for that idle UI. Only an explicit
  non-idle claim updates it; registration and both claim-decay paths preserve it; and it never
  participates in working/idle state, freshness, attention, or sorting. Its additive migration
  backfills atomically from a legacy non-`open` claim (or a preserved idle detail) so upgrading
  cannot erase the only synopsis a session reported.
- **Session scope is Solo-style** (`src/scope.ts`): inferred lazily per call, overridable via
  `register`. The one memo is a FOUND origin remote (#159): once `git remote get-url origin`
  succeeds, the server reuses it for both `project` and `repo` for the process's life (the
  accepted cost: a later `git remote set-url` is not followed). A missing origin is never
  cached — it is re-read on every call, because `src/hook.ts` infers the project live on every
  hook event and the two must keep agreeing (a mid-session `git remote add origin`, or one
  transient git failure, must not pin the folder name). The branch (and the issue parsed from
  it) is re-read on every call because worktrees and checkouts move mid-session, so never
  cache the whole scope. Head inference (`headFor`, #157) stays outside both `get()` and that
  memo: it runs only on flag/board writes and reads git's push destination (and, #183, the
  branch's upstream ref) live, because it needs origin's PUSH url, which the cached fetch url
  cannot answer.
  The client name for `inferAgent` **must be read lazily** inside handlers
  (`server.server.getClientVersion()?.name`) — it's only populated after the initialize
  handshake. Capturing it at build time yields `undefined`/`'unknown'`. Don't regress this.
- **stdio channel is sacred.** The server speaks MCP over stdout — never `console.log` to
  stdout from server code, and any subprocess (e.g. git in `infer.ts`) must **capture**
  stdout (`stdio: ['ignore','pipe','ignore']`), never inherit it. A handler throw is fine:
  the SDK wraps it into `{ isError: true }` and the process survives.
- **Fail-open / never lose a flag.** If inference fails, attribute to `unknown` and still
  insert. If a write fails, surface an MCP error — don't crash.
- **Viewer escapes all agent-authored text.** `public/app.js` runs every interpolated field
  (item title/detail/annotation/project/stream/agent, board title/meta, row label/note/
  annotation) through `esc()` before `innerHTML`. Keep it — flags and boards are
  attacker-influenced text. **`esc()` is not enough for a URL:** it does nothing about
  `javascript:`, and issue #30 introduced the first anchors this product builds from supplied
  text (PR titles are third-party network text). Every href is constructed in ONE place,
  `chipHtml()` in `public/source.js`, through `esc(safeHttpUrl(...))` — a URL that does not
  survive `safeHttpUrl` renders as a `<span>`. Do not build an anchor anywhere else.
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
  Design: [`docs/superpowers/specs/2026-10-19-plans-sub-issues-design.md`](docs/superpowers/specs/2026-10-19-plans-sub-issues-design.md).
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
  fetched, then nudged, then oldest `checked_at`, then key. A nudge is a MERGED/CLOSED link whose
  CERTAIN closing issue is the key or one of its listed children, seen after the key's
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
  are hard only when no other error names that alias; a field error under `parent`/`subIssues`
  marks only that root's hierarchy unavailable; an unreadable immediate parent is never read as
  "no parent"; a list that lost an invalid child is marked truncated so it is no evidence of
  absence; a repository redirect becomes an alias and any other identity mismatch is `moved`.
  (6) **`closing_refs`**: `parsePrPayload` records every closing reference (one unreadable
  reference voids the list rather than shrinking it to a false single), and `upsertSourceLink`
  stores it bound to the `fetched_at` it writes. An older process's success write moves
  `fetched_at` and so unbinds it (pinned in `test/mixed-version.test.ts`); its failure write
  keeps it bound.
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
  and writing nothing to stdout. Staging, release assembly and the Intel release gate all
  run it beside the selftest.
- **`src/shape.ts` is AGENT-SIDE ONLY (issue #42).** `context` is written for the human
  and rendered collapsed, so agents write it generously — and every agent read used to pay
  for all of it. `shape.ts` is where the MCP read payloads are trimmed (`context` →
  `context_chars`, `full: true` to fetch); `store.ts` still returns whole rows and
  `src/viewer.ts` must never import it, so `/api/boards` and `/api/items` stay
  byte-identical for the human. **Only agent-authored `context` is ever trimmed** — the
  human's `annotation`/`reply`/`reply_context` is never omitted on any path, under any
  option. **The "handed over once" ledger is per-PROCESS, and that is all it can be.** Not
  per session and not per agent: the stdio server is long-lived, and a Claude Code
  subagent's MCP calls are served by the PARENT CLI's process — so a fan-out SHARES one
  ledger and the first sibling to poll consumes the delivery. (The persisted stamp is no
  better: `annotation_seen_by` is a CLIENT NAME every sibling shares.) MCP exposes no
  subagent identity to key on, so the ledger is **an optimisation, never a guarantee** —
  what makes that safe is that a trimmed context is ALWAYS recoverable on demand:
  `pending({full:true})` for items and rows, `board_get({title, full:true})` for a board.
  Keep both hatches, and keep them named in the tool descriptions. Do not re-assert
  "one process = one session"; it was measured and it is false.
- **Omission is not deletion — for FIELDS (issue #42).** `board_upsert` leaves a row's
  `context` alone when the field is absent and clears it only on an explicit `''`, because
  the prescribed flow is `board_get` → `board_upsert` and MCP reads no longer carry the
  text: omitting what you were never handed would wipe it. This does NOT weaken the rule
  that a ROW absent from an upsert is deleted — that one stands. The same omission rule
  covers every agent-owned row field: an omitted `note`, `next_step`, `impact`,
  `next_after`, `action_owner`, `options`, `context` or `outcome` keeps its stored value
  (`upsertBoard`: `note: r.note ?? prev.note`), and only an explicit `''` (or
  `options: []`) clears it. Do not "fix" `note` to clear on omission: agents re-send
  full tables, and that would wipe every row's TL;DR.
- **`store.ts`/`mcp.ts`/`viewer.ts` inverse round-trip:** the store's `Item` and
  `BoardWithRows` shapes are the contract shared by MCP writes/reads and viewer reads.
  Change them in `store.ts` and update both consumers (+ `group.ts` for items;
  `public/app.js` renders both).
- **`load()` is the poll's; `reloadAndPaint()` is the human's (issues #38/#39).** `load()` ends in
  `renderIfIdle()` — the spec §10 gate. `suspendState()` reports every typed draft anywhere in the
  app, but NOT a merely expanded card. Expanded cards, the open inspector's scroll offset, and
  its focused control survive rebuilds; order pinning appends new work at the foot; the press
  guard protects clicks. A draft gates only the editable surfaces:
  `paintAmbient()` still refreshes the document-title badge, project rail, tab counts and global
  Live strip before `shouldDeferRender()` returns. A held press is different: `pressHeld()` runs
  before `paintAmbient()` because the rail itself can rebuild, so the press guard still defers
  every surface. A handler that ends a successful POST with a bare `load()` still asks the gate
  for permission to show the human the editable result of their own click, and one unrelated
  draft can refuse it indefinitely.
  Hover is never a gate either: existing order is pinned and new work appends at the foot, so
  leaving the pointer over Needs-you cannot hide an arrival.
  Every human-initiated write therefore ends in `reloadAndPaint()` (`await load()` then
  `forceRender()`); the ONLY un-painted callers are the boot call and `setInterval(load, 3000)`.
  There are exactly **two entries into `render()`** — `renderIfIdle` (with the ambient frame it
  already prepared) and `forceRender` (a full fresh frame) — because `forceRender` is also the
  only thing that clears `renderDirty` and refreshes `#pauseHint`; a direct `render()` leaves that
  hint claiming "paused" over data already on screen. Pinned in `test/shell.test.ts` +
  `test/issue-31-followups.test.ts`; the behavioural half (including both the protected draft and
  live ambient signals) is `test/dom/silent-send.test.ts`.
  Nested Background disclosures are keyed by item/row id in `openContexts`; a poll or forced
  rebuild must restore their `open` state instead of collapsing text under the reader.
  Passive polls retain inactive Notes, History and Plans DOM, but not their data:
  the action/recovery queue, ambient signals and visible overlays still refresh.
  Boot, library navigation and successful human writes use the existing complete
  forced paint. Keep active-board tracking outside the skipped Plans painter and
  mark notes read only when Notes is actually visible, not while Settings retains
  that tab identity. Deep-link and render-time recovery must preserve their
  explicit/deferred repaint ownership rather than recursively entering render.
- **A viewer restart must not discard unsent responses.** A changed `x-inbox-boot`
  schedules a coherent frontend reload, but `load()` defers it while drafts, recovery
  entries, response handlers, outstanding writes, staged undo actions, or bounded
  pointer/scroll activity remain. The existing frontend keeps polling and updating
  ambient attention during that hold. Once protected work clears, an ordinary poll
  reloads exactly once; drafts are never automatically sent to make refresh possible.
  Every response of a tick carries its server's marker; markers that disagree within
  one tick mean a restart landed between two reads, so that tick counts as a restart
  and is never applied, because it would mix two servers' data.
  The quiet status hint explains an unsent-work hold without labeling an in-flight
  write or pointer interaction as a human blocker. Failed staged choices use the same
  exact-intent recovery path as other replies. This is automatic-restart protection,
  not durable persistence across a manual reload, window close, or renderer crash.
  `test/dom/viewer-restart.test.ts` pins the draft, revision, in-flight, and undo boundaries.
- **Dashboard focus must not freeze monitoring detail.** Mount the structural frame
  and native range selector once, then refresh ownership, dispatch, recent outcomes
  and history through the ambient painter as well as headline signals. Preserve the
  range control's identity, value and focus across polls and history error/recovery.
  Reuse a focused outcome button while its result remains present; move focus to an
  adjacent control only when that result actually leaves and the viewer owns focus.
  This must not bypass the global held-pointer guard, create a third render entry,
  or pull keyboard ownership back from a background viewer.
- **Remembered DOM focus is not keyboard ownership.** A blurred tab or embedded viewer
  keeps its last `document.activeElement`. Passive polling must capture focus bookmarks
  only while `document.hasFocus()` is true, before replacing DOM; otherwise restoring a
  card, plan, or project control can steal focus from the host chat composer or another
  application. Background data/ambient updates still run. Explicit user navigation can
  focus its destination, and an active viewer must retain its logical focused control
  across rebuilds. `test/dom/background-focus.test.ts` covers the background and
  foreground halves. In jsdom, a control's `.blur()` also makes `hasFocus()` false;
  tests modeling CSS hiding a control in an active window must explicitly retain
  document focus rather than accidentally model a background webview.

- **A held pointer defers the rebuild, and it is NOT a suspension (#38 / D2).** The 3s render
  detaches the node under the cursor, so `pointerdown`/`pointerup` share no ancestor and the
  browser dispatches **no click at all** (measured in Chrome: ~1 in 24 at human hold times, on
  every surface). `initPressGuard` records `pressedAt`; `shouldDeferRender` (in `public/poll.js`)
  ORs it with the §10 suspension. Keep `pressedAt` **out of** `suspendState()`/`suspendReason()`
  — a press loses nothing, so lighting `#pauseHint` for it would be a new lie — and keep it a
  **timestamp**, never a flag: bounded by `PRESS_GRACE_MS`, it self-heals when a release event
  is missed. Never gate the render on `openRows` instead: it is unbounded, never pruned, and
  would resurrect the C1 freeze on the tab the badge counts. That last sentence is the design's
  explicitly rejected option and the easiest thing in the file to "clean up", so it is pinned
  twice: a source pin on `suspendState()` in `test/shell.test.ts`, and the freeze itself —
  expand one matrix row, watch the list, badge and `#pauseHint` stop — in
  `test/dom/press-guard.test.ts`.
- **Active inspector or page scrolling defers only the editable rebuild.** Restoring `scrollTop` after
  replacing `.nrow-card` preserves coordinates but still cancels Chromium's in-flight
  wheel/trackpad momentum, which presents as an intermittent freeze at the 3-second poll boundary.
  The card and window scroll guards update `lastInteractionScrollAt`, while the card also updates
  `openRowScrollTop`; `shouldDeferRender()` holds the editable frame for the bounded
  `SCROLL_IDLE_MS` window, while `paintAmbient()` still refreshes badges, counts, the rail, and
  Live. A resettable timer calls `resumeRender()` as soon as movement settles, so a deferred frame
  does not wait for another poll. Keep scroll activity out of `suspendState()`/`suspendHint()`:
  it is a brief interaction guard, not a user-visible pause, and it must reset when the open item
  changes. A settled rebuild anchors the open row's in-flow `.nrow` viewport position before and
  after replacement, then corrects only the measured delta; anchoring `.nrow-card` would be inert
  in the desktop fixed-inspector layout. Restore queue scroll geometry only after shortcut
  decoration and initial editor sizing: restoring sooner clamps the phone footer's saved
  offset to a temporarily smaller range and hides its focused action. The initial editor
  animation frame must not repeat an already-completed sizing pass and clamp it again.
  The deferred restoration belongs to the same open-row owner that captured it.
  `test/dom/inspector-scroll.test.ts` and
  `test/dom/page-scroll.test.ts` pin the momentum, viewport, position, and focus contracts.
  Independently scrolling inspectors, disclosures, drawers, and overlay bodies use
  `overscroll-behavior: contain` so exhausted wheel/trackpad input cannot chain to the page beneath.
  The compact project menu is a vertically contained popover at every narrow width, so its
  exhausted scroll cannot move the workspace behind it.
- **Explicit keyboard traversal reveals its target; passive restoration does not.**
  Tab/Shift+Tab inside an action card or dialog focuses with `preventScroll`, then
  reveals the target through intentional scrolling ancestors inside that scope.
  Do not scroll the phone card's overflow-hidden shell or background, and do not
  reuse this explicit-navigation behavior for passive poll focus restoration.
  `test/dom/explicit-tab-scroll.test.ts` covers the separation; real browser
  geometry is still required to confirm narrow-footer visibility across rebuilds.
- **A text selection is restored across rebuilds, never held (#223).** A rebuild
  detaches the nodes a selection lives in, and a live range collapses onto their
  parent, so the 3s poll used to erase every highlight within one tick. Both render
  entries capture a non-collapsed selection before anything repaints (`renderIfIdle`
  before `paintAmbient()`, carried on the prepared frame; `forceRender`'s `render()`
  before its own ambient frame) and restore it after `restoreQueueView()`, and on the
  deferred-frame branch after the ambient painters. `public/selection.js` records each
  boundary as a path from the nearest element with an `id` (or `<body>`); a step into
  an element carrying a data identity (`data-card-id`, `data-row-id`,
  `data-context-key`, …) matches that identity and ordinal, not its position, so rows
  leaving or arriving above keep it. The range is reapplied with `setBaseAndExtent`
  (direction kept) only when it spells the same DOM text; otherwise it is dropped with
  `removeAllRanges()`, so a half-rebuilt range is never left stretched over new text.
  An untouched selection is left alone. Restoring calls no `focus()` and never
  scrolls, so it cannot steal focus from a background viewer. It is NOT a render gate
  or a suspension: nothing reads it in `shouldDeferRender()`, `suspendState()` or
  `#pauseHint`, so a selection held for minutes cannot freeze anything (the C1
  lesson), and paintAmbient keeps running. Text in a reply box or other focused field
  is never captured: drafts and their focus bookmarks own it. For the same reason a
  restore leaves the selection alone when the repaint itself focused a text field
  (Change answer, draft recovery): Chromium moves the selection into a field on
  focus, and re-applying the old highlight would leave that field with no caret.
  `test/dom/text-selection.test.ts` pins survival, both drops, ambient refresh, the
  no-freeze run, focus/scroll neutrality and the focused reply box.
- **Copy text when selected is opt-in and owns no event (#222).** Off by default
  (`agent-inbox-copy-on-select` in localStorage; Settings → Copying).
  `public/copy-on-select.js` copies when a primary-button gesture ends (judged one
  task after mouseup) or a keyboard burst settles (400 ms after the last keyup), and
  only if the selection changed during it: `sameSelection()` compares bookmarks, not
  nodes, so a #223 restore is the same selection, and a `selectionchange` counts unless
  it is the restore's own (`isRestoredSelection()`), which also catches the same range
  dragged over again. A newer gesture, a window blur or turning the setting off
  supersedes an unfinished one, so a double-click copies once. The text is
  `getSelection().toString()` with NBSP written as a space (what Cmd+C puts on the
  clipboard), sent through structured-copy's `writeClipboard` (Clipboard API, then the
  selection-preserving fallback); no IPC channel carries it. Focused fields and
  editable content are excluded. Its status region rewrites only on a change, so
  repeats inside its 1.6 s window are not re-announced. Listeners bind once per
  document and never prevent a default or stop propagation: clicks, the press guard
  and attention are unchanged. `test/dom/copy-on-select.test.ts` pins each rule.

- **The hooks runtime is a SECOND OS process on the same db — and it still goes through
  `store.ts`.** `src/hook.ts` (+ the `src/hook-cli.ts` entry) is spawned by Claude Code, not
  by an MCP session, and writes backstop items with `insertItem`/`resolveItem` like everything
  else: **no CLI shell-out, no raw SQL** (the untracked shell hooks it replaces did exactly
  that; `test/hook.test.ts` now pins the absence). Its stdout rule is the inverse of the MCP
  server's: not "write nothing" but **"write EXACTLY the documented payload"** —
  `notification`/`session-end`/`sweep`/`watch` emit zero bytes, `prompt-submit` and `stop`
  exactly one JSON object, `session-start` one line of text. Two things are non-negotiable:
  `stop` must never block when `stop_hook_active` is true (a double block traps the human in
  an un-exitable session), and `watch`'s **exit code 2** must reach the harness — it is the
  only thing that wakes the model, and its payload rides on **stderr**, so no wrapper may
  redirect either stream. Backstop items carry the *harness* session id, so they classify
  `parked` and can never escalate a badge; `public/attention.js` is untouched. **Test trap:**
  `test/hook.test.ts`'s `freshEnv()` pins `AGENT_INBOX_HOOK_GRACE_MS=0` so the arm/commit pair can
  be driven synchronously — which makes BOTH grace comparisons (the in-flight-committer guard and
  the committer's own wait) unreachable, and each was invisible to the whole suite until a test
  raised the window on purpose. Two do now; anything else about the window must too, or it asserts
  nothing. Full contract: [`docs/hooks.md`](docs/hooks.md).

- **The Copilot answer watcher is host-owned, exact-item, and read-only.** Copilot has no
  supported session-resume API, but a detached background command's completion notification
  does wake the owning session. `flag(kind:'question')` therefore returns `watch` metadata
  only when `inferAgent` identifies Copilot; the agent launches `src/watch-cli.ts` (source)
  or `dist/watch-cli.js` (built) itself and calls `pending()` when it completes. The MCP
  server must never spawn this watcher: a child completion inside the stdio server cannot
  wake the host. `src/watch.ts` reads only through `getItem` in `store.ts`, watches the exact
  generated item id, emits no answer content, and exits on response, close, or a bounded
  timeout. A persisted `reply_seen_at` is NOT a reason to keep sleeping — a sibling process
  may have stamped pickup first while the asking session still needs its own wake. Preserve
  `process.execArgv` in the returned command so the same contract works under source `tsx`
  and built Node execution. The command also carries the resolved database path explicitly;
  the host shell does not inherit MCP-only `AGENT_INBOX_DB` configuration.
  *(#217)* A timeout is not an answer, so every one costs the agent a whole turn to re-arm.
  The wait is therefore `watchTimeoutMs`: 30 minutes plus the ask's age (item `created_at`,
  row `action_started_at`) in whole minutes, capped at 4 hours, so re-arms of an unchanged
  ask double (30 min → 1 h → 2 h → 4 h). It is stateless and evaluated twice by ONE
  function: the server sizes `timeout_seconds` with it, and the watcher re-derives its own
  deadline at launch, so re-running the identical question command backs off too (the
  argv carries no timeout; `AGENT_INBOX_WATCH_TIMEOUT_MS` only forces one for tests). The
  human's quiet time — a snooze, or an "I'll take a while" with a time — can only push the
  deadline out, and never more than 24 hours past the later of the watcher's launch and the
  moment the human chose that time (`watch_stopped_at`), so every offered "back in…" is kept
  in full and an orphaned watcher stops within a day. A snooze records no such moment: one
  longer than a day costs a recheck a day. Order is fixed: close, then answer, then a stop
  for good (exit 3, one stdout line telling the agent not to re-arm), then the deadline
  (exit 124, unchanged). `board_get({watch:true})` returns no watch for a row stopped for
  good: re-arming it would only cost another wake.
- **The human's watch stop is human-owned, version-pinned and NOT content (#217).**
  `watch_stopped_at`/`watch_stopped_until` on items and rows record "I'll take a while":
  stopped for good (`until` NULL) or until a time. Like `annotation`/`handled_at`, no agent
  upsert or row edit touches them. The only reset is a new action, by ANY writer: the
  `reset_row_action_watch_state` trigger (`AFTER UPDATE OF action_version`) clears them,
  because an older server sharing the file runs its own `beginNewRowAction`, which knows
  nothing of these columns — exactly the `increment_item_response_revision` precedent. An
  item is its own ask: no writer, old or new, reopens or re-purposes one. A stop for good is
  final — the watcher has already exited, so the store refuses to revise it into a deferral
  nothing would honour, and the viewer renders a reminder instead of a control; that
  reminder stays on an answered card until an agent picks the answer up. Answered, handled,
  closed, archived or unblocked asks refuse a stop. Row writes are pinned to row AND board
  revision, but the write bumps neither revision nor `updated_at`: it changes nothing an
  agent writes, so an agent's `board_get` → `board_upsert` snapshot stays valid and native
  notifications (keyed by revision) are not re-announced. Viewer routes require `until`
  explicitly (date or null): a dropped field is a 400, never the final stop. Attention is
  untouched — the ask stays in Needs-you unless also snoozed. **The control follows the
  ask's own asker, `action_agent`, never `boards.agent`** (the board's last writer, which a
  Copilot edit of another row flips and `board_advance` never restamps). Rows stamp it in
  the statement that starts each action, tagged with `action_agent_version`; the trigger
  keeps it only when that tag matches the new version, so an older server's new action has
  no asker. Items stamp it at insert. Older servers stamp nothing, and their watchers ignore
  a stop anyway, so an unknown asker draws no control: hide, never guess. Only `copilot`
  draws it, because only Copilot runs the watcher it stops; a chat-recorded answer draws
  nothing, since the agent recorded it itself. Claude's hook `watch` is deliberately
  unaffected: it never wakes on a timeout (it exits 0 and re-arms at the agent's own Stop),
  so a stop would only remove its answer wake and save nothing.

- **Agent setup is explicit, dry-run-first, and owns only marked text.**
  `scripts/install-agents.sh` is the supported bridge between two configuration systems:
  MCP registration can store a server command but cannot inject a global prompt, so the
  installer performs both operations visibly. It defaults to a side-effect-free dry run;
  `--apply` verifies the pinned Node runtime through `hook-cli selftest` before managed
  runtime or host mutation (the user-scoped install lock is created/acquired first).
  Instruction content is fully rendered and staged before MCP changes, and it writes only between
  `<!-- agent-inbox:begin -->` / `<!-- agent-inbox:end -->` in
  `~/.claude/CLAUDE.md` or `~/.copilot/copilot-instructions.md`, with a timestamped backup
  before every change. Symlinked instruction files stay symlinks: the resolved target is
  updated atomically. Unmatched or duplicate markers are a hard refusal. Destructive MCP
  changes retain an exact snapshot of the host's user config until instruction writes commit,
  so a later failure restores the prior registration rather than reconstructing it. Claude receives
  `docs/instructions/claude-code.md`; Copilot receives
  `docs/instructions/copilot-cli.md`; both normally receive `docs/reporting-snippet.md` inlined.
  **The one exception is an import the human wrote themselves.** If the target file already
  carries a live `@…/docs/reporting-snippet.md` directive, the block cites that import instead
  of inlining a second copy: the inline would be ~2,300 duplicated tokens in every session AND a
  snapshot that goes stale on the next snippet edit — exactly the drift the import exists to
  prevent. The target appendix is still written, because the import does not carry it, and the
  dry run says on stderr that it detected the import and is skipping the inline. Four things are
  load-bearing. (1) **Detection is a directive, not a mention** — and the bar is what CLAUDE CODE
  WOULD RESOLVE, not what looks like a path. Shape: first non-blank character `@`, at most three
  leading spaces; four or more spaces (or a tab) is an indented code block and ``` / `~~~` open a
  fenced one, and an `@…` in either is inert text. Prose that names the file and a `@…` inside a
  code span start with some other character. (2) **The path must resolve to THIS repo's
  `docs/reporting-snippet.md`** — `~/` expands to `$HOME`, a relative path resolves against the
  directory of the file carrying the line (where Claude Code resolves it from), and identity is
  the same-FILE test (`-ef`), so symlinks, `..` and alternate spellings agree while a different
  file that merely ends in the same name does not. Anything unresolvable — a dangling path left
  by a moved checkout, a URL — fails toward INLINING. That direction is the whole point: the
  managed block's note asserts "this file already imports the snippet", so a false positive makes
  the block state something untrue *and* deletes the reporting contract, while a false negative
  only duplicates it. (3) **Only the region OUTSIDE BEGIN/END is consulted**, so the installer can
  never be fooled into thinning a block by its own output. (4) **It is gated on the HOST, not the file**
  (`host_resolves_imports`): Copilot CLI has no import mechanism, so an `@path` line in its
  instructions is inert text and skipping the inline there would silently delete the reporting
  contract instead of de-duplicating it. Copilot always inlines; that is why its instructions
  used to sit frozen while Claude's tracked every edit. Both transitions are covered — a file
  that gains an import sheds the inlined snippet on the next run, one that loses it gets the
  snippet back — and both modes are idempotent and `--uninstall`-reversible. `--force`
  replaces only the named MCP registration, and `--uninstall` removes only the managed
  registration/block. Nothing runs from install, build, package, or Electron startup.
  The Setup panel's direct action is deliberately Electron-only:
  `electron/setup-preload.cjs` exposes only `available()`/`install(target)`, with
  `contextIsolation:true` and `nodeIntegration:false`; `main.cjs` accepts only the
  three fixed targets and only while the app owns the exact local-viewer origin (the
  window binding update installs share, #216). A
  reused viewer never gets execution access, and there is no HTTP setup-write route.
  `electron/setup-core.cjs` is the dependency-free control plane. It trusts the POSIX
  adapter's frozen host identity derived from the real `process.platform`/`process.arch`
  and requires the selected key plus verified manifest platform/architecture to match it
  exactly. The core carries only values the current adapter consumes; shell-internal
  self-tests, rollback and pruning are not self-certified policy fields.
  `electron/setup-runner.cjs` selects only the exact architecture-keyed runtime payload
  from release `setup-info.json`. Both its verified release path and checkout/dev fallback
  delegate execution to the fixed-purpose `electron/setup-process.cjs` boundary, which
  constructs only exact `/bin/bash scripts/install-agents.sh` argv, bounds output/time,
  and preserves POSIX process-group cancellation. It accepts no executable or arbitrary
  argv from callers, permits exact-host macOS/Linux shell execution, and fails closed before
  spawn on Windows or unknown platforms. Release setup-info callers declare an exact key set
  from the shared runtime registry; current macOS callers remain Darwin-only.
  `electron/runtime-verify.cjs` is the externally anchored verifier: using the digest from
  signed-bundle `setup-info.json`, it synchronously verifies the complete manifest file
  list, hashes, modes, entrypoints and runtime identity at selection and immediately before
  process start. This full hashing blocks Electron main today. The payload's later
  Node/helper verification is self-attesting and catches corruption or argv/source
  mismatch before managed runtime/host mutation, but it cannot establish trust after a
  substitution. The verify-by-path then execute-by-path TOCTOU window remains until a
  later stable-handle/process adapter can provide a snapshot or identity-based handoff.
  `scripts/setup-filesystem.cjs` is the Node-core-only filesystem transaction boundary
  shared by the shipping runtime installer and build-time runtime publisher. It identifies
  plain files/directories with bigint device+inode values (canonical paths are diagnostic,
  never case-folded identity), rejects unusable/zero identity and link-like leaves, stages
  under the destination parent, rechecks identity at each transition, and verifies the
  published name. Immutable runtime install refuses replacement; `stage-runtime --force`
  uses a two-rename backup swap with a visibility gap and explicit recovery retention.
  This is point-in-time detection, not a stable handle: inode reuse and races after the
  last check remain. The modeled Win32 policy additionally rejects drive-relative,
  drive-less-rooted, device/extended-namespace and ADS-like paths plus junction/reparse
  entries exposed as links. Those tests do not establish Windows support; Setup remains
  limited to exact Darwin/Linux x64/arm64 hosts until native Windows evidence exists.
  Recursive rollback/cleanup must re-identify both the private scratch directory and any
  prior-tree backup immediately before mutation. An identity mismatch refuses restore or
  deletion and retains the untrusted path for recovery; never “clean up” a path whose
  identity check just failed. The adapter creates the empty stage exclusively and captures
  its identity before producer code runs; cleanup also requires that same stage identity
  (or verified absence after publication), so a substituted child is never recursively
  removed merely because its parent scratch directory still matches.
  *(#211)* A runtime prune (`removeDirectory`) re-identifies the validated tree and its
  parent, renames it into a fresh `.trash-<name>-*` folder (`mkdtemp` in the same parent)
  and only then deletes that folder; recursive deletion removes links, never their
  targets. Once the rename commits, the runtime id is free: an interrupted, failed or
  `SIGKILL`ed prune leaves trash, never a half-deleted runtime that a later install of the
  same version would refuse as a collision. A failed trash deletion still counts as
  pruned. Each install and prune first removes up to 16 leftover `.trash-*` entries that
  this uid owns, each pinned by identity and re-checked just before removal (a link is
  only unlinked); a folder whose contents failed the post-rename identity check carries
  a `.retained` marker and is kept for recovery. Win32 has no owner to compare, so its
  model retains all trash. Nothing named `.trash-*` is ever a runtime: manifests,
  install and prune refuse that id, and `list` skips it.
  `runtime-payload.mjs install` reserves exit 3 for an error carrying
  `committed:true` (usage remains 2 and ordinary failure 1). The shell must treat
  that as “publication may have happened,” reverify a plain exact
  `runtimeRoot/runtimeId` against both the expected runtime ID and source-manifest
  digest, and only then mark a previously absent runtime for the existing
  reference-gated rollback. A substituted/unverified path is retained with an
  explicit unsafe/unknown diagnostic; host configuration remains unchanged and
  the overall install still fails.
  Graceful process termination lets the shell attempt rollback; forced `SIGKILL` can
  terminate without shell or adapter cleanup, so never claim rollback precedes every
  terminal result. *(#208)* `install-agents.sh` handles HUP, INT, QUIT, PIPE, ALRM,
  TERM, XCPU and XFSZ alike: an active transaction rolls back, reports into a
  work-directory log that is replayed to stderr afterwards (bash 3.2 leaks a failed
  write into the next command substitution), and exits 128 + the signal. The shell and
  its non-Node commands then ignore those signals. Node resets them at startup, so
  *(#211)* every Node step of the rollback (a host CLI's `mcp remove` and `mcp get`
  re-check, the runtime reference check and prune) runs through
  `scripts/run-isolated.mjs`, argv only, under the installer's pinned Node. The helper
  ignores HUP/INT/QUIT/ALRM/TERM/XCPU while it waits and hands the command to a guard
  (the same script) started detached in its own session; the guard starts the command
  detached too and owns the bound: after 30 s it signals the command's whole group
  (TERM, then KILL) and exits 124, reported as not finished in time. The guard
  survives the installer's `SIGKILL`, so that bound always applies. A helper killed
  while its own Node is still starting has started nothing and is rerun, at most three
  times. Neither the guard nor the command gets the installer's stdio (Setup still
  sees its pipes close when the installer dies), but both get fd 9, so the lease lasts
  as long as the step. Forward-path Node steps stay in the installer's group.
  Hosts refuse to remove a server a failed add never registered, so a failed undo
  counts as failed unless a re-check confirms it absent. An exit that neither committed
  nor finished the rollback keeps every MCP snapshot, and a kept snapshot or failed step
  keeps the log too. `SIGKILL` of the installer (Setup's forced stop 10 s after a
  cancel) cannot stop an isolated step that is already running: it still ends within
  its bound and holds the lease until then.
  A failed post-publication cleanup is a committed failure and retains
  its recovery path rather than deleting the only prior tree.
  Every applied agent or hook install sources the adjacent
  `scripts/setup-lock.sh` and holds one kernel-backed user-scoped lease on
  `~/.agent-inbox/install-agents.lock` across preflight, mutation, and rollback.
  The mutating Bash process opens fd 9 itself: Darwin prefers descriptor-mode
  `/usr/bin/lockf` and falls back to same-domain `flock`; Linux uses `flock`
  only. Repeated acquisition in one shell must never reopen fd 9. Every existing
  non-regular lock path is rejected before open, and only conflict exit 75 means
  another setup is running. The descriptor stays open for the whole process
  tree, so an in-flight child cannot outlive a helper-held lease; whole-group
  exit/crash releases ownership unless an isolated rollback step is still
  running (it keeps the lease until it ends, at most its bound), and an
  unexpectedly long-lived descendant can retain it too. File existence never
  implies ownership. The helper is part of the signed runtime manifest, but
  sourcing it by path extends the already retained verify-to-execute race
  rather than closing it.

### DOM harness — what it can and cannot see

`test/dom/` boots the **real** viewer frontend in jsdom: `test/dom/harness.ts` bridges
`globalThis.fetch` onto the real `createViewer(db)` Hono app over a real temp SQLite DB,
then imports `public/app.js` **unmodified** — top-level side effects and all.
`public/` and `src/` have a **zero-line diff** because of it; keep it that way.

- **jsdom cannot execute `<script type="module">`.** That is why the harness imports the
  module graph directly instead of mounting `public/index.html` and letting it run. Do not
  re-litigate this — it has already cost time twice.
- **`publicDir: false` in `vitest.config.ts` is mandatory.** Without it Vite claims
  `<root>/public` as its static publicDir and hard-errors on any import from it
  ("this file is in /public … can only be referenced via HTML tags"). The companion
  `resolve.alias` (`/^\/([\w.-]+\.js)$/` → `<repo>/public/$1`) is what makes the browser's
  absolute `/x.js` specifiers resolve. Neither touches a byte on disk: `public/` still has
  no build step, and the browser and Electron keep resolving `/x.js` from their own root.
- **Four globals must be stubbed or `render()` throws and `load()`'s catch swallows it** —
  which presents as "nothing rendered", not as an error: `window.uFuzzy` (vendored IIFE,
  constructed at app.js module top level, so it must exist BEFORE the import),
  `window.matchMedia` (3 call sites: `themeName`, `initResponsive`, `initProjectDisclosure`),
  `CSS.escape` (used throughout navigation and rendering), `Element.prototype.scrollIntoView`.
  The harness's **console.error guard is load-bearing**, not cosmetic — it is the only
  thing that turns a swallowed render throw back into a visible failure.
- **`new URL('…', import.meta.url)` does not work in a jsdom test file.** jsdom files run in
  Vite's WEB transform mode, where the asset plugin rewrites that literal pattern into
  `http://localhost:3000/@fs/…` and `readFileSync` dies with "The URL must be of scheme
  file". The rest of `test/` uses that form happily because those files run in the NODE
  environment. Resolve through `node:path` instead (`harness.ts` does).
- **Fake timers freeze `Date`,** so every row seeded inside one test shares one
  `created_at` unless you call the harness's `advanceClock()` between writes. That silently
  breaks `listItems`' `ORDER BY created_at DESC`, `buildDeck`'s sort and — worst —
  `seenWatermark`, whose whole job is comparing stamps. Item timestamps cannot be
  backdated through `store.ts`, so a staleness fixture moves the CLOCK, never the row.
- **Window/document listeners accumulate across boots within one file.**
  `vi.resetModules()` gives a fresh module instance but jsdom's window/document live for
  the whole file, so each boot adds another `hashchange`/`keydown`/`beforeunload` handler.
  Harness rule: **assert rendered state only, never handler-invocation counts.**

CSS: `getComputedStyle` over an attached `public/style.css` genuinely resolves specificity,
source order, `!important`, `:has()` and `color-mix()` — that is what makes the
`.answer-btn` geometry test in `test/dom/css-cascade.test.ts` catch the real 13819d2
regression. **Four verified blind spots; only literal lengths and keywords are trustworthy:**

1. **`@media` never matches.** jsdom's media-list evaluation only answers `all`/`screen`,
   so style.css's single `@media (max-width: 1279px)` block — the ENTIRE spec §14 responsive
   layer — never applies. Do not assert anything about it; cover the JS half instead
   (`setViewport('narrow')` + readable `railLabel` output, in `test/dom/boot.test.ts`) and
   source-pin compact geometry/container-query rules in `test/editorial-shell.test.ts`.
2. **`var()` is returned unresolved.**
3. **An unparseable declaration is dropped SILENTLY — and therefore reads as "correct".**
   `border: 1px solid color-mix(…)` comes back as `borderStyle: 'none'` /
   `borderTopWidth: 'medium'`, so asserting the `.row-expand { border: none }` half of the
   13819d2 bug would pass VACUOUSLY on the buggy sheet. This is the dangerous one.
4. **The `font:` shorthand clobbers a later longhand.** `.answer-btn` declares
   `font: inherit; … font-weight: 600` and jsdom computes `normal`.

An overstated harness is worse than none. If an assertion falls in one of those four, it is
not evidence — delete it or move it to a source pin.

## Conventions

- Node 24, TS **ESM** (`"type":"module"`); **imports use `.js` specifiers** even for `.ts`
  sources (NodeNext). Keep this on new imports.
- Strict tsc, `noUncheckedIndexedAccess: true` — array access is `T | undefined`; use `!`/
  guards, keep `npm run typecheck` clean.
- **TDD.** Every change: failing test → red → implement → green. Tests use **real** temp
  SQLite DBs (`AGENT_INBOX_DB`/`mkdtempSync`), never mock the store. The MCP test is a real
  spawn-the-server round-trip.
- **Test environments are per-file.** There is no global `test.environment`: the node suite
  (store, mcp, infer) stays on node and a DOM file opts in with a
  `// @vitest-environment jsdom` docblock. `test/dom/harness.ts` is deliberately NOT named
  `*.test.ts` so the `test/**/*.test.ts` glob imports it without collecting it.
- `zod` is a **direct** dependency (used by `mcp.ts` for tool schemas) — keep it in
  `package.json`, don't rely on it resolving transitively via the SDK.
- Build emits via **`tsconfig.build.json`** (rootDir `src`, src-only) so `dist/mcp-server.js`
  is flat. The base `tsconfig.json` (src + test) is for typecheck only. Don't point `build`
  at the base config — it re-nests output under `dist/src/`.
- **Every value export in `public/*.js` AND `src/*.ts` must be reachable from code that
  ships.** Two ways, and nothing else counts: another production module IMPORTS it by name
  and uses that binding, or it is CALLED inside its own module and that module is itself
  imported (or is an entry point). A test is not a consumer: a helper only its own unit test
  calls looks load-bearing (typed, covered, named after a real concept) while shipping
  nothing. `test/dead-exports.test.ts` enforces it. The only deliberate exits are a
  `void X // why` marker at an importing call site (as `app.js` does for `paginateGroups`)
  or an entry in that file's `ALLOWED` map **with a written reason** — the map is the point:
  it turns a silent trap into a list someone has to justify.
  Four such helpers accumulated through the viewer rebuild; `listClosedProjects` (#32) was
  the fifth and got through because the guard's first draft asked only whether `\bNAME\b`
  occurred more than once across a concatenation of the consumer files — so any unrelated
  file containing the same word vouched for it, and `src/` was not scanned at all. **Keep
  the liveness test import-or-call.** Its discrimination is pinned on synthetic module trees
  in the same file (including the exact word-match hole), so a slide back into word-matching
  fails there rather than shipping a sixth. It is a scanner, not a tokenizer: cross-file
  liveness is import-only and airtight, but *within* the declaring file a bare occurrence
  counts however it got there (a local binding, an object key, template-literal text). That
  limit is written down at the `word()` helper — don't restate it more generously.

## Shipped since v1

v1 was deliberately local + triage-only. These have since landed — don't re-plan them:

- **Answer-back** *(#7)* — `pending` MCP tool + the viewer reply box. Answers carry an optional
  `reply_context`, and `reply_seen_at` records agent pickup.
- **`done`/milestone bucket** *(#9)* — `flag({ kind:'done' })`, surfaced in the viewer's Done section.
- **Electron packaging** *(#11)* — `electron/` wraps the `public/` viewer; `scripts/package-app.sh`
  stages `dist` + `public` + `electron` and rebuilds `better-sqlite3` for Electron's ABI.
  *(#139)* The development path stages through the release `copyRequiredTree()`, so it ships
  the checked-in `package.json` + `package-lock.json` pair. `npm ci --omit=dev` (with
  `--prefix "$STAGE"`) installs that graph, the checkout's lockfile-pinned `electron-rebuild`
  rebuilds the addon from inside the stage, and `scripts/package-app-stage.mjs verify`
  refuses to package unless the stage and the packaged app hold exactly the lockfile's
  production versions and integrities. Never stage without the lockfile or install with
  `npm install` there: either re-resolves ranges. The script works on physical paths
  (`pwd -P`) and treats a missing staged manifest or an unconfirmed graph check as failure:
  a step that silently did nothing could otherwise let `npm ci` walk up and strip the
  checkout's devDependencies.
- **Portable release runtime** *(#74 Layer 1)* — the app may additionally embed
  `darwin-arm64` and `darwin-x64` Node 24 payloads staged outside the Electron dependency
  tree. Each payload has a content-derived `runtime-manifest.json`; Electron selects only
  `process.platform`/`process.arch`, and Setup atomically installs it under
  `~/.agent-inbox/runtime/<runtime-id>/`. Packaged upgrades/uninstalls touch only exact
  manifest-owned registrations/hooks, share one kernel lock, and retain every runtime
  whose canonical Node+entry pair is still structurally referenced. Release signing order
  is fixed: nested runtime Mach-O files, manifests, setup-info, outer app without
  `--deep`, then strict verification; nested bytes never change afterward.
- **Signed update-manifest trust contract** *(#106 Layer 1)* — protected releases contain
  five packages, package-only `SHA256SUMS.txt`, deterministic `update-manifest.json`, and
  `update-manifest.json.sig`. The exact manifest bytes are signed with Ed25519 after
  package aggregation; `electron/update-manifest.cjs` is the side-effect-free verifier
  staged with every app. `electron/update-trust.cjs` is the optional startup boundary:
  it catches only registry read/parse initialization failure, logs one generic
  updater-disabled error without file/key contents, and returns `null` so the core app
  continues. `scripts/update-manifest.mjs` owns build-time generation, history
  authorization, and signing. The committed `release/update-keys.json` labels keys
  only after deriving each id from SPKI DER. Signature-envelope schema 1 is a canonical
  sorted array so rotations can overlap old and new signatures; production currently emits
  one. Verification validates every entry's shape, ignores entries for keys absent from the
  installed registry, and requires at least one pinned-key signature to pass; rejecting an
  old+new envelope merely because the new key is unknown would brick skipped-version clients.
  The current protected signer is deliberately single-key: do not flip `signingKeyId` for
  routine rotation until a separate change adds protected dual-key signing and keeps overlap
  signatures through the supported direct-upgrade floor.
  Bootstrap requires proving no prior published stable release has either manifest asset.
  Later releases verify the latest prior pair and signed `trustedKeyIds` continuity before the one secret-bearing signing step. The sole write job still stages a private
  draft, independently verifies all eight remote bytes plus the five-entry checksum and
  signature, then exposes them atomically by undrafting. This layer adds no Electron
  fetching, scheduling, download, or install behavior.
- **Rollback high-water mark** *(#148, rollback half only)* — the packaged notify-only
  checker (`electron/update-fetch.cjs` + `update-controller.cjs`) persists the highest
  release version whose manifest passed signature, schema and expiry verification in its
  own Electron userData file, `update-trust-state.json` (`{ schema: 1,
  highestVerifiedVersion }`; `createUpdateTrustState` in `update-preferences.cjs`, with its
  own lock and the shared temp-file + rename helper). **Never add a key to
  `update-preferences.json`:** 1.2.0–1.2.8 accept that file only with exactly
  `schema`/`automaticChecks`/`lastNotifiedVersion` and otherwise read defaults, silently
  turning automatic checks off; its format and strict parser stay as 1.2.x shipped them.
  `checkForUpdate()` calls the controller-supplied `recordVerifiedVersion` exactly once,
  only after `verifyManifest()` succeeds. The controller saves the highest version verified
  in this process under the lock (no write when not higher, so a release whose own save
  failed is saved by the next successful one) and returns max(stored or still-readable
  mark, that session high), so the stale decision matches the stored mark and an
  unsaveable mark still holds for the session. A verified manifest below the mark returns
  `stale`: no offer, no notification, no attention/badge change, normal retry schedule.
  Offers still need a version above the running app, so the effective floor is max(mark,
  running version), and a deliberate downgrade is still offered the newest release at or
  above the mark. The trust-state reader is tolerant of newer builds: a valid mark counts
  whatever else the file holds, unknown fields survive a raise, and a newer `schema` is
  enforced but never overwritten, so later trust state (e.g. key rotation) can live there.
  A missing or corrupt file means no mark (floor = running version) and is replaced by the
  next verified check. 1.2.x builds ignore the file, so a reinstalled 1.2.x build enforces
  no mark until 1.3+ runs again. Not covered: the first check after install or a userData
  reset, a newer release withheld before this installation verified it, and the
  dual-signed key-rotation transition — the other half of #148 — so the single-key signer
  rule above still stands. The publisher already refuses to sign a version that is not
  newer than every prior stable release, so re-pointing GitHub's latest at an older
  release shows `stale` to every client that already verified the newer one; fix forward.
- **Verified update download** *(#196 part 1)* — on a packaged
  `macos-dmg` or `appimage-self-replace` host, Settings → Updates offers **Download
  update** for the release the signed manifest verified; it never starts on its own and
  `deb-notify` stays notify-only. `checkForUpdate({ includeArtifact: true })` hands the
  pinned target (URL, length, SHA-256) to Electron main only; the controller publishes
  `available.downloadable` and byte progress, never the URL, digest or path.
  `electron/update-download.cjs` re-validates the target against `TARGET_SPECS`, fetches
  only the canonical `github.com/shariqh/agent-inbox/releases/download/vX.Y.Z/<file>` URL
  with manual redirects (at most five, HTTPS, no credentials, `github.com` only to that
  exact URL, otherwise only `release-assets.githubusercontent.com` or the older
  `objects.githubusercontent.com` under `/github-production-release-asset…/`), and
  streams into a fresh `mkdtemp` `0700` staging directory under
  `userData/update-downloads`. The signed `byteLength` is a hard cap while streaming; the
  file is fsynced and renamed to `v<version>-<sha256>/<filename>` only after the exact
  length and digest match. Every failure — network, stall or total timeout, cancellation,
  disk, wrong length or hash — removes the staging directory, so nothing unverified ever
  sits at a verified path. A same-artifact request joins the in-flight download or reuses
  the file only after re-hashing it (`O_NOFOLLOW | O_NONBLOCK`, so a planted symlink is
  refused and a planted FIFO cannot block, inside a directory `lstat` proves is real);
  `verify()` applies the same checks. A different artifact supersedes it.
  Cleanup is bounded and pattern-only: it never follows symlinks, removes staging
  directories only after an hour without writes (two app processes can share
  `userData`), and drops downloads at or below the running version, superseded by a
  newer verified offer, or no longer offered. Checks and downloads never overlap (a
  download request is refused while a check is starting, and checks are skipped during
  a download); a
  re-check while verified is quiet and keeps the file unless a successful check offers
  something else. A `stale` result (#148) is no such offer: like a failed check it never
  prunes or forgets the offer, and a verified download stays on screen with only its
  check time refreshed, so a serving path that is behind cannot delete a verified
  newer download. The install steps
  consume `getVerifiedArtifact()` (`{ path, version, tag, filename, sha256, byteLength,
  packageType, installStrategy }`) only through `downloader.openVerified()` (part 2,
  below). The downloader itself never executes, mounts, opens or installs, and update
  state never enters `public/attention.js`, badges or Needs-you.
- **Verified update install on macOS** *(#196 part 2)* — **Install and restart** in
  Settings → Updates installs the verified DMG; an AppImage installs through its own
  installer (part 3, below), `deb-notify` stays notify-only. Load-bearing pieces:
  (1) **The install contract** (`electron/update-install.cjs`): `PlatformInstaller {
  strategy, feasibility, prepare, cleanup? }`; `prepare()` stages AND fully verifies
  without touching the running installation, and the returned `commit()` is the only
  step that changes it (`discard()` is idempotent and never rejects). Feasibility is
  side-effect free, consulted on every check (not ok ⇒ a notify-only offer with
  `available.reason`, `downloadable:false`) and again right before install; reasons that
  could carry a path are replaced by generic copy. (2) **fd hand-off, hash while
  consuming:** `openVerified()` applies `verify()`'s location/directory checks, opens the
  file once (`O_RDONLY|O_NOFOLLOW|O_NONBLOCK`) and re-hashes it through that handle,
  which the controller narrows to positioned `read`/`stat` for `prepare()`;
  `copyVerifiedSource()` hashes exactly the bytes it copies. A swapped file at the path
  never reaches the installer; a file that changed is dropped and the download offered
  again. (3) **Verify the STAGED copy, never the mount:** the DMG copy is attached
  read-only (`-nobrowse -noautoopen`, checksums on, stdin closed, always detached, `-force`
  retry, never recursing into a still-mounted volume); exactly one real `Agent Inbox.app`
  is `ditto`ed into a `0700` `.agent-inbox-update-*` folder beside the running app on the
  SAME volume; then `plutil` id + version, `codesign --verify --deep --strict` with a
  requirement built only from constants (`identifier` + Team ID `VVR2DKR923`), and
  `spctl --assess` — Node-written files carry no quarantine, so this is the only
  Gatekeeper evaluation. (4) **The helper** is constant `/bin/sh` text, spawned detached
  with fixed argv, `stdio:'ignore'` and a minimal `PATH`. It waits until BOTH the app PID
  and the viewer PID it started (`-` for an in-process or reused viewer) have exited —
  otherwise the relaunched app could find the dying viewer on the port and take the
  unowned reuse path — giving up unchanged after ~120 s; it refuses symlinks and an
  occupied backup path, renames the app aside, renames the staged app in with rollback,
  and relaunches with `open`. (5) **Retained backup:** `Agent Inbox.app.previous` stays in
  the stage folder; startup `cleanup()` removes stage/work folders only after an hour,
  by exact name, owner uid and without following links, bounded per pass. (6) **Controller
  ownership:** `installNow()` claims the controller synchronously; while installing and
  after commit no check, download, cancel, prune or cleanup runs, and `dispose()` never
  discards a committed install. It refuses (as `install-failed`, file kept) a version not
  newer than the running one, one below the high-water mark RE-READ from the trust file,
  a check in flight, Setup running, or a feasibility failure. (7) **Main gating:** the
  argument-free `agent-inbox:update-install` IPC needs a trusted update sender AND the
  window bound to a viewer this app started and proved it owns (`viewerOwned`, set only
  in the `waitForOwnership()` branch; bound at the first navigation and, since #216, again
  after a later load re-proves it — below) — not Setup's runtime
  payload; a reused or failed-over viewer never gets installs. Setup and an update
  install exclude each other in both directions: the controller's `isSetupRunning` is
  `installGate.running()` (#205's gate; a source pin evaluates that exact expression
  against a real gate), and the Setup handler checks `isInstalling()` synchronously right
  before `installGate.run()`. #205's `beginAppQuit()` also ends update installs: it clears
  `updateInstallWebContentsId`, the install IPC returns early once `installGate.quitting()`,
  and the controller's `isQuitting` refuses `installNow()`. `requestRestart()` (flag +
  `beginAppQuit()` + `app.quit()`) is the ONLY quit path for an update; `before-quit`
  calls `beginAppQuit()` first every time and never blocks the restart otherwise; a user
  quit during an uncommitted install cancels it first, and the abort is re-checked after
  the attempt record is written, before `commit()`. (8) **A failed swap is reported, not
  looped:** the controller writes `userData/update-install/last-attempt.json` (`{schema:1,
  from, to, at, platform, strategy}`, atomic) through `createInstallAttemptStore()` just
  before `commit()` and never commits an attempt it could not record; a rejected commit
  removes it. `commit({ resultPath })` hands the helper `last-attempt.result`, where it
  writes only its exit code (shared `INSTALL_HELPER_EXIT`) before every exit; its argv
  validation refuses relative, dot-segment and trailing-slash paths (a trailing slash
  would make its symlink checks test the link's target). The first `rendererReady()`
  takes both files BEFORE any cleanup (cleanup only matches `install-XXXXXX`, pinned), and
  only in an instance with a registered installer; a record without a result stamped
  within 150 s of now EITHER WAY (the helper's wait plus margin; `Math.abs`, so an NTP
  step back still counts as in flight) is left for the app the helper reopens, while a
  stamp far in the future is stale, so it cannot hold a notice. The helper
  writes its result BEFORE reopening the app. Exit 0 is never reported as a failure; an
  app still older than `to` publishes `installNotice` on every state until that release
  stops being offered or a new install starts, and notifies once. Part 3 reuses the store,
  the exit codes and `resultPath`. Update state still never enters
  `public/attention.js`, badges or Needs-you. Open: the real `/Applications` swap under
  macOS App Management needs the planned 1.3.0 → 1.3.1 end-to-end run.
- **Verified update install for AppImage** *(#196 part 3)* — `electron/update-install-appimage.cjs`
  replaces the running AppImage FILE in place (same name and path; the name may carry the
  old version) and restarts into it. (1) **One AppImage proof:** `runsFromAppImage()` in
  `update-fetch.cjs` decides both the offered target and the installer's
  `not-appimage`: APPIMAGE and APPDIR canonical absolute, APPDIR not `/`,
  `process.execPath` inside APPDIR, AND APPDIR the runtime's FUSE mount of that very
  file: a mount point (`lstat` dev differs from its parent's) whose LAST (visible)
  `/proc/self/mountinfo` entry has type `fuse.<name>` and source `<name>`, `<name>` =
  basename(APPIMAGE). The pinned type2-runtime passes no fsname/subtype, so libfuse's
  default subtype is the image's real file name (seen in a real Docker FUSE run; re-check
  on any runtime pin change). Paths alone were not enough (#210 review): our AppRun
  reassigns and exports `APPDIR=$(pwd -P)`, so an extracted `squashfs-root/AppRun` run
  from a shell another AppImage started had a plain-folder APPDIR holding execPath while
  APPIMAGE still named the OTHER app's file, and the commit renamed our update over it.
  The dev check stops that; the mountinfo binding also stops our image mounted by hand
  (`--appimage-mount`) under another image's APPIMAGE. Any lstat/mountinfo failure is
  false (notify-only). Tests inject `appImageProbe`; main and target selection use the
  system. A bare inherited APPIMAGE (a `.deb` or an extracted copy started from another
  AppImage) must never select the AppImage target or point the installer at someone
  else's file. Main registers the installer only under that same proof (plus
  `viewerOwned` and packaged): such a run registers nothing, so no startup report can
  take an attempt record another AppImage copy left in a shared userData.
  (2) **Bound to the launched file:** the installer snapshots the
  AppImage's dev, ino, size and `mtimeNs` when it is created at startup. Feasibility,
  `prepare()` and `commit()` refuse once the file at APPIMAGE differs
  (`changed-since-launch`), which also blocks a second install before a restart.
  Feasibility otherwise needs a regular file owned by the uid, W_OK on the file and
  W_OK|X_OK on a real folder, and the ELF + `AI\x02` magic read through
  `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` with the fstat bound to the lstat'd inode. Messages are
  plain, path-free and end "Use Review release instead." (3) **Stage beside the file:**
  `copyVerifiedSource` writes a hidden `.<name>.update-<16 hex>` sibling (`O_EXCL|O_NOFOLLOW`,
  `0600`; a planted name fails closed, with no retry). It is then sealed through a fresh
  read-only `O_NOFOLLOW` handle: same device as the AppImage (the commit is a rename),
  exactly the signed size, the type-2 magic in the STAGED bytes, `fchmod 0755`, fsync.
  Every failure removes the stage, identity-checked once its inode is known. (4) **Commit =
  rename:** re-lstat the AppImage (full snapshot), its folder and the stage (dev+ino),
  then one `rename(stage, APPIMAGE)`. After that `commit()` NEVER rejects, because the
  installation already changed: best-effort folder fsync, then the restart helper. A
  helper that cannot start only logs, and the user opens the new file. (5) **Restart
  helper, never `app.relaunch()`:** Electron's relauncher execs `/proc/self/exe` inside
  the AppImage's FUSE mount, which the runtime tears down when the app exits. Instead a
  detached host `/bin/sh -c` runs constant text with argv `<app-pid> <viewer-pid|->
  <polls> <target> <result|-> -- <app args…>`, `set -u`, arguments validated (exit 64;
  the `--` in sixth place is required), `cwd:'/'`,
  `stdio:'ignore'`, unref'd, and `commit()` resolves only on its `spawn` event. It polls
  `kill -0` for the app AND the viewer child (the same port race as macOS), exits 75
  after ~120 s without starting anything, then `exec "$target" "$@"`. The app args are
  `process.argv.slice(1)` captured when main creates the installer, minus ONE leading
  `--disable-setuid-sandbox`: our AppRun (`renderAppRun`) puts it in front of the user's
  args and the new AppRun adds it again, so forwarding it would add a copy per update; a
  copy the user typed is kept. It reuses #207's report
  seam: `commit({ resultPath })` (validated before the rename; none means `-`, no
  report), `<result>` checked first (invalid: 64, writes nowhere), and the shared
  `INSTALL_HELPER_EXIT` code written (temp + rename, a `umask 077` subshell the app never
  inherits) before every exit AND just before the exec: 0 right before it, 65 when the
  path no longer holds a regular executable non-symlink file (the closest code to a
  failed exec; an execve failure after that check still reads 0). Because the commit
  replaced the file first, the app opened next from that path is the new version, so the
  controller's next-start report is silent whatever the code. Its env is `process.env` minus APPDIR,
  APPIMAGE, ARGV0, OWD, TARGET_APPIMAGE and every `:`-entry resolving inside the old
  APPDIR; a list left with only empty entries is dropped whole, and so is a PATH naming no
  directory at all (an empty PATH left the helper without `sleep`/`mv`: exit 75 in
  milliseconds, no restart). Unset, `/bin/sh` uses its default search path. The module
  never imports `child_process` (`spawnImpl` is injected) or Electron.
  (6) **No rollback copy:** the rename frees the old inode at exit; going back means
  downloading the older AppImage. (7) **Cleanup:** at most 16 removals and 64 candidates
  per pass, exact stage names, regular files or symlinks (unlinked, never followed) owned
  by the uid and over an hour old, never this process's live stage, and only under the
  AppImage proof. (8) **Extract-and-run is notify-only:** its APPDIR is no mount, so the
  proof in (1) already fails; the installer also refuses it by name (`extract-and-run`),
  as defense in depth and for the commit-time re-check. The runtime
  extracts into the predictable `$TMPDIR/appimage_extracted_<md5>`, recreates it `0755`
  when missing and reuses existing right-size files, and the documented launcher's `trap`
  removes its private TMPDIR as the app exits, so a restart could run a planted `AppRun`
  as the user. Detected by ANY `APPIMAGE_EXTRACT_AND_RUN` (the runtime tests
  `getenv() != NULL`, and a restart inherits it) or an APPDIR basename starting
  `appimage_extracted_` (`--appimage-extract-and-run` sets no variable and is stripped
  from argv). Checked in `inspect()` (so feasibility and `prepare()`) and again before the
  rename in `commit()`, reading env live; an unreadable env counts as extracted. Cleanup,
  which needs the proof, does not run there. Install-then-quit was rejected: it needs a no-restart flag through the
  controller, preload, three Settings strings and the notifier, plus an attempt record
  with no helper result. Open: the real offer → install → FUSE teardown → relaunch needs
  the first signed 1.3.0 → 1.3.1 pair on a Linux desktop (manual plan in the PR).
- **Install grants survive a reload of the owned viewer** *(#216)* — Setup and update
  installs are granted to the one window, not to the app, and before #216 any later
  main-frame navigation revoked them for good: after View → Reload, Force Reload or a
  renderer crash, Settings kept showing an **Install and restart** that main always refused
  ("Restart Agent Inbox to install this update.") until the app restarted. Seen in the first
  real 1.3.0 → 1.3.1 run. `createInstallBinding()` (`electron/setup-runner.cjs`, beside
  #205's gate) now owns the grants. (1) The first main-frame navigation binds at once, as
  before: startup's `waitForOwnership()` proved ownership moments earlier. (2) Every later
  one (a reload, the viewer's own restart reload, failover's reload) revokes both at once,
  and they come back only when that navigation commits (`did-navigate`) to the viewer
  origin AND `reproveOwnership()` passes: the startup proof again, plus, for a dev viewer
  child this app spawned, that the child still runs. `/api/owner` hands `OWNER_TOKEN` to
  any local client, so the token alone proves nothing hours later; what does is a listener
  that has held the port since startup (a packaged app's in-process viewer cannot lose it
  while the app runs). That is also why the proof starts after the commit, never at the
  navigation's start: then the listener that answers is the one that served the page.
  (3) A newer navigation, a renderer crash or the window closing discards a proof still
  running; a crash revokes and the window's next load may re-bind under the same proof; a
  closed window never binds again; nothing binds once a quit has begun (#205). (4) Setup
  is granted only while `setupInstallEnabled`, update installs only while `viewerOwned`;
  with neither (a reused or failed-over viewer) nothing is probed. The UI is honest as well:
  the controller publishes `available.installPermitted` from main's
  `updateInstallPermitted()` (the binding the install IPC checks, and no quit), the preload
  requires a boolean that implies `installable`, and the binding's `apply` calls
  `refreshInstallPermission()`, which republishes only on a change. An installable
  verified (or install-failed) offer that is not permitted hides Install and restart and
  says "Restart Agent Inbox to install this update." with a **Restart Agent Inbox** button
  on macOS, or "Quit and reopen Agent Inbox to install this update." with no button on an
  AppImage, which Electron must never relaunch (part 3). (5) `agent-inbox:update-restart`
  accepts exactly the state that shows that button and nothing else: trusted sender,
  `darwin`, no quit begun, Setup NOT running (`installGate.running()`: the quit's
  `beginAppQuit()` would cancel it mid-registration, #205's hazard, and the update path
  refuses that too), `viewerOwned`, no update installing, an installable `verified` or
  `install-failed` offer, and `!updateInstallPermitted()`. Without all of them it returns
  false, so no other state or page (a reused viewer has no installers) can quit the app or
  relaunch it in a loop; after a relaunch the new window is bound and permitted, so the
  button is gone. When it is refused, Settings says "Agent Inbox didn't restart. If agent
  setup is running, try again when it finishes." rather than leave a dead button. It then
  calls `beginAppQuit()`, `app.relaunch()` and `app.quit()`; the next start reuses the
  verified download after re-hashing it. (6) `refuseInstall()` stays the backstop for a
  click that races a revoke; its `install-failed` is marked as main's refusal of the window,
  and once that window may install again `refreshInstallPermission()` publishes the
  `verified` download again instead of a stale "restart" beside a working Try again. An
  install's own failure keeps its reason. (7) Setup's renderer asks `available()` once per
  page and again when Settings opens: `agent-inbox:install-available` first awaits
  `installBinding.settled()` (a re-proof in flight, which resolves once its grants are
  applied), and Settings re-asks on open, adding the one-click install and Update agents
  when main now allows them (a window only loses Setup to a new page or a quit, so this
  never takes away a menu that may be running). A main-frame navigation that never commits
  leaves the window revoked until its next load, with the same honest copy. None of it
  enters `public/attention.js`, badges or Needs-you.
- **Session presence** *(#28, corrected by #45)* — every MCP session is a Live row; `status()`
  upgrades it, process exit ends it, and a row that stops being heartbeated expires after ~15 min.
  That expiry only ever fires for a **crashed** process: a live one heartbeats itself, so what
  decays for an idle-but-running session is its `doing` CLAIM, not its row (see the two-stamps
  invariant above). `status({doing})` re-asserts instantly; agents never need to keep one alive.
- **Dual-channel answer sync** *(#29)* — the `answer` MCP tool plus `answerItem`/`reply_source`.
  Agent-mediated by design: this repo has no hook into any chat client, so the AGENT is the
  bridge. Convergence is order-independent (inbox precedence, no clock comparison) rather than
  the issue's original "timestamp-based last write wins". Chat-recorded answers remain visible
  with their provenance and pickup receipt; while the question is open, the answer surface is
  prefilled for a non-destructive correction. Sending that correction through `replyItem` makes
  it the authoritative inbox answer and resets pickup without first blanking stored state.
- **Electron response watch + host adapter seam** — `electron/reply-watch.cjs` derives the
  work still waiting on an agent without changing `public/attention.js`: a question leaves
  the set when `pending()` stamps `reply_seen_at`, while a human-acted board row stays until
  its agent-owned status changes. New responses invoke an optional
  `AGENT_INBOX_WAKE_COMMAND` immediately; native reminders start after one minute and repeat
  every 15 minutes. The command is an absolute path, is spawned with `shell:false`, and
  receives one JSON event on stdin. This is an Electron-process integration seam, not an MCP
  capability: Claude's hook remains the supported automatic wake path, and Copilot has no
  built-in adapter until its host exposes a supported per-session resume API. Never fold
  these reminders into the attention predicate or badge — they represent work awaiting the
  agent, not work awaiting the human.
- **Copilot exact-question wake** — `src/watch.ts` + `src/watch-cli.ts` bridge the remaining
  host gap without pretending Copilot has a direct resume API. For Copilot questions only,
  `flag` returns a shell-safe detached-background launch contract. The host owns that process
  and therefore receives the completion notification; the resumed agent calls `pending()`.
  Claude gets no duplicate watcher because its hook already owns wakeup.
- **Watcher backoff and "I'll take a while"** *(#217)* — re-arming an unchanged ask waits
  longer each time (30 min → 1 h → 2 h → 4 h), and the human can stop a Copilot ask's
  watcher for good or ask it to wait quietly until a time. See the watcher and watch-stop
  invariants above. A native-notification stop action was left out: notification buttons
  are answers today, and mixing in a non-answer needs its own design.
- **Backstop hooks** *(#10 + #21)* — `src/hook.ts` + `src/hook-cli.ts`, installed opt-in by
  `scripts/install-hooks.sh` (dry-run by default). #10: a `Notification` hook arms a
  grace-windowed backstop item when a session is stuck at a permission prompt; it is
  self-clearing, rate-limited and janitored, so the badge stays trustworthy. #21: `stop`,
  `prompt-submit` and `session-start` nudge an idle agent to call `pending()`, and the
  `watch` subcommand (asyncRewake, exit 2) wakes it the moment you answer. The two legacy
  untracked `~/.claude/hooks/agent-inbox-*.sh` scripts are superseded — `--migrate` retires
  their settings entries. *(#155)* The installer's dry run stays side-effect free: its
  selftest gets a throwaway database, because opening the hub creates and migrates it.
  `--apply` writes through a symlinked `settings.json` (backup, staged copy and rename beside
  the target), refuses a dangling, non-regular or read-only target, and checks every write
  before it reports success. *(#218)* An install never adds its set beside another Agent
  Inbox install's: two sets run every hook twice. Both modes sort every agent-inbox-shaped
  entry with ONE rule, `sortHookEntries` in `runtime-config.mjs` (checkout mode calls it as
  `foreign-hooks` under the selftest-proven Node): own; replaceable (a verified Setup
  runtime's, a checkout's — `dist/hook-cli.js` beside a `package.json` named `agent-inbox`
  — or a dead `…/dist/hook-cli.js` whose entry or Node no longer resolves); unverifiable
  (a `…/dist/hook-cli.js` that runs but does not verify); or another tool's. Its launcher
  classification is `src/agent-hosts.ts`'s with Setup's `unknown` split into dead and
  unknown (`test/agent-hosts.test.ts` holds them to agreement). Replaceable entries refuse
  (exit 1, nothing written) until `--replace-existing`, which strips exactly them by
  command + args plus the installer's own and adds one set; unverifiable ones always
  refuse; another tool's are never removed (checkout mode never refuses for them; packaged
  mode still does without the flag, as before). Every refusal is one `HookRefusal` whose
  FIRST printed command is the one-step `--replace-existing`; each other install's own
  `--apply --uninstall` follows only when it can succeed now — never a runtime's while
  anything else shaped like ours is present, because every runtime version's uninstall
  refuses then. Packaged `--uninstall` keeps that refusal and names the checkout. `--force`
  keeps its exact meaning, and `--replace-existing --uninstall` is a usage error (exit 2).
- **Close / reopen a project** *(#32)* — a sparse `projects(project, closed_at)` table; **reopen is
  DERIVED, never written** (a project un-closes the moment an item or board is CREATED in it after
  `closed_at`), so `insertItem` stays byte-identical and the un-close is atomic with the very insert
  that raises the question. A closed project leaves the §7 attention set **entirely** — badge, title,
  Needs-you count, triage deck — via a 5th `closedProjects` argument to `attentionEntries`, so there
  is still exactly ONE predicate; `countsByProject` deliberately stays unsuppressed because the
  rail's closed fold is where the number is RELOCATED, not destroyed. Live presence (footer strip and
  drawer) is untouched: presence is not attention. Clicking a closed project PEEKS (a banner above
  the panel says the badge excludes what you are looking at); only × / ↩ / a new flag mutate.
  Closing also retires the project from #30's PR poller (`listLinkTargets` filters through
  `closedProjects`, never the raw table, so a derived reopen resumes polling by itself) — a retired
  project must not keep spawning `gh` every 60s nor keep eating the shared `MAX_PER_TICK` budget.
  The reopen predicate is strict `>` **on purpose**: a close and a write can tie at the millisecond,
  and the tie goes to the human's explicit act — `>=` would mean closing a project in the same
  millisecond an item lands leaves it open, i.e. a × that visibly does nothing. Pinned on a frozen
  clock in `test/store.test.ts`.
  **Honest limitation:** an agent already blocked on a question raised *before* the close creates
  nothing new while it polls `pending()`, so closing that project mutes a genuinely-live blocker
  until fresh content arrives. "Nothing can be permanently muted" is true of everything except that
  case — do not restate it unqualified.
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
- **Board-annotation delivery** *(#37)* — `pending()` returns `{items, rows}`: the human's per-row
  board notes ride the one poll every agent already makes, project-scoped like items, and a
  `blocked` row keeps arriving until an agent acknowledges it by flipping the status. See the
  delivery-is-not-acknowledgement invariant above; `docs/reporting-snippet.md` and the `pending`/
  `board_row` tool descriptions all say that the STATUS FLIP is the acknowledgement.
- **The human's "I did my part" mark on a blocked row** *(#36)* — `board_rows.handled_at` plus
  `handled_seen_at`/`handled_seen_by`. It exists for task-shaped blockers ("create the Paddle
  account", "record the hero demo"): a task wants DONE, and with the asking session over nobody
  was ever going to flip the status. Decision-shaped blockers now carry direct response options,
  store the choice as an annotation, and do not render this task control. Four things are
  load-bearing. (1) **It is not the `done`
  STATUS** — that is the agent's assertion about the row's work and only agents write it; the
  labels say so (`I've done my part` / `Not done after all`, and "You marked your part done" on
  the card). (2) **`upsertBoard` can never clear it**, and exactly one thing can: a status
  transition INTO `blocked` from something else (`resetHandledOnReblock`) — see the sacred-fields
  invariant above. (3) **The row does not vanish**: `isBlockedRowAttention` drops it via
  `humanActedOnRow`, and `awaitingAgentRows` picks it straight back up into the same
  awaiting-pickup foot an annotated row lands in. (4) **The undo is real or absent** — the store
  refuses a clear once `handled_seen_at` is set (one guarded statement, no TOCTOU), and the
  viewer does not draw the button when its own snapshot already shows a delivery. That is the
  rule the row ✕ removed in #38 broke: never draw a control that lies.
- **`blocked` now says WHO it waits on** *(#44)* — the six stored values are unchanged: no
  `needs-you` alias, no rename. The ambiguity was purely agent-facing (the viewer's 🚧 + Needs-you
  reads unambiguously), and the mistake is *choosing* `blocked` for work no person can unblock — a
  row went into the human's banner because a release candidate did not exist yet — so an alias
  would have added a seventh-looking status without removing the trap, and a rename would migrate
  every DB, the CSS and `attention.js` to fix a sentence. The fix is the text agents read: both
  board tool descriptions AND a zod `.describe()` on the `status` FIELD (the text a model reads
  while filling in an enum), each carrying the NEGATIVE example — stuck on a failing test, a
  missing build or another PR is `partial`, never `blocked`. `docs/reporting-snippet.md` gained
  one sentence of the same. A blocked row is also the ask itself: **one ask, one surface**.
  When a board row already owns the dependency, agents must set that row to `blocked` and must
  not create a separate question item for it; question flags are only for asks with no owning
  board row. Pinned over a real `tools/list` in `test/mcp.integration.test.ts`,
  which is also the only proof the field description survives `.optional()` and array-items.
- **Agent-read payload diet** *(#42)* — `src/shape.ts`. MCP reads omit agent-authored `context` and
  report `context_chars` instead; `board_get()` with no title is a summary; and a given context is
  handed over ONCE per server process (the human's words still come back on every poll — #37 is
  untouched). Two escape hatches, both named in the tool descriptions: `pending({full:true})` for
  items and rows, `board_get({title, full:true})` for a board. Measured against a copy of the live
  db (`JSON length / 3.6`, the issue's method): `board_get()` 11,493 → 2,604 tok (agent-inbox),
  14,818 → 3,955 (oris); the biggest single board 4,361 → 1,551, unchanged under `full:true`; and,
  with the project's 14 heavy rows synthetically blocked, 20 polls 136,791 → 52,568. It costs +477
  tok of tool definitions once per session. Agents still write generous `context` for the
  human; action-first TL;DR/next-step fields do not turn context into a terse status slot.
- **The agent-emit contract** — `docs/reporting-snippet.md`'s end-of-turn rule now tests "am I about
  to stop and wait on the human?", so recommendations and "say the word" moments get flagged
  instead of buried. It now also defines ownership/impact/next-after, snooze semantics,
  answer|clarify|decline handling, required outcomes, and `board_advance` for chained work.
  Mirrored in MCP schemas/descriptions so malformed blockers are rejected at the call site.
- **Human action lifecycle** — blockers carry ownership, impact and next-after; the viewer
  offers snooze/wake, clarification and decline without changing agent-owned row status;
  answered work shows pickup/outcome/history and ages into a follow-up-due chip outside badge
  attention; board decisions and question items both expose native Electron response actions.
  Inbox can filter Decisions, To do and Updates since the previous visit. Review queue is the
  existing shared-attention deck: progress, action mix, ownership, always-visible option
  tradeoffs, and the same underlying card/write paths. Handoffs is a read-only projection of
  those same entities into Waiting on you → With the agent → Outcome; clicking a card routes
  back to its existing action/receipt/plan. Plan flow is plan-scoped and draws only
  plan → row → explicit `next_after`/`outcome` paths; `impact` prose never creates a dependency
  edge. Clicking a flow row opens a nested detail/action lightbox and keeps the graph mounted;
  leaving for Plans requires the explicit button.
- **Editorial desk shell** — user-facing navigation is Inbox / Plans / Notes / History, while
  stored ids and API vocabulary remain `needsYou` / `boards` / `done` / `blocked`. The app is
  light-first with a warm canvas, white surfaces, deep rose accent, Segoe UI/Aptos typography,
  restrained borders and no gradients or glow. At 1280px+ `.nrow-card` is CSS-positioned as a
  fixed inspector but MUST remain a descendant of its `.nrow`; moving it into a portal breaks
  row-scoped writes, draft persistence, focus, deep links and the poll gate. `public/panes.js` is
  the pure source of truth for adjustable widths: library 220px default / 180–320px, inspector
  520px default / 360–720px, with at least 400px left for the queue. Preferences persist under
  `agent-inbox-sidebar-width` and `agent-inbox-inspector-width`; mouse drag, separator keyboard
  controls, viewport reclamping and double-click reset must update CSS and ARIA together. Inside
  the single EOF `@media (max-width: 1279px)` block the splitters hide, the item card returns
  to static inline layout, and the library becomes a compact masthead. At desktop width the
  agent picker belongs at the bottom of the library sidebar above Settings. In the broad masthead
  it sits immediately right of the project selector; at 900px those controls share a second row,
  at 620px the complete four-tab library gets its own row above them, and at 440px the two
  selectors stack. The project selector opens the existing rail as a vertically scrollable,
  contained menu with inline counts and project-owned archive/reopen actions. The menu closes on
  project selection, outside pointer/focus, Escape (with focus restoration), or a breakpoint
  transition. Disclosure state is window-local and non-persistent. Workspace search lives in
  the sticky topbar. While its results are open, raise that parent stacking context above
  the desktop inspector and resize handles, but below Live, phone action cards and modal
  owners; raising only the child dropdown cannot escape a lower parent context. Closing
  results restores the normal header layer. It is a combobox index over Inbox, Notes, History,
  and active/archived Plans; it never filters the queue, project rail, tab badges, or Live
  sessions. Results use one visible lifecycle hierarchy — Open items, Active plans, Notes,
  History, Archived plans — with relevant matches ranked inside each section, so past work never
  outranks current action. Every result explains its match: visible title characters are rendered
  through safe `<mark>` nodes, while hidden-field matches get a bounded, source-labelled snippet
  with ranges adjusted into snippet coordinates. Agent text still enters the DOM only through
  `textContent`/text nodes; never turn match highlighting into authored `innerHTML`. The initially
  highlighted first option is the strongest Open-item match when one exists. Results navigate
  through the existing deep-link path, carrying the exact matched field and plan-row identity:
  hidden Background sources open on arrival and the matched text is safely highlighted in the
  destination through poll rebuilds. Arrow keys/Enter operate the listbox without moving focus,
  Escape cancels the debounce, clears, closes, and blurs, and leaving the dock closes the list
  without discarding the query. While a changed query debounces, the prior list remains mounted
  but `aria-busy` and non-activatable; once ready, unchanged result identities update their
  highlights in place. Poll refreshes preserve the active result by identity and do not rebuild
  an unchanged list under the pointer.
  Multi-term searches use `createBoundedMatcher` to match ordered terms separately
  over the complete text; uFuzzy remains the finite-edit, single-term matcher.
  Never send an entire plan's concatenated background through the old multi-term
  regexp: ordinary repeated release prose caused seconds of cross-term backtracking.
  Preserve quoted/excluded terms, typo support, full distant-text coverage, source
  identity and useful ranges; do not substitute context truncation or a larger debounce.
  The per-build cache must not outlive its data snapshot. `test/search-bounded.test.ts`
  exercises long positive, negative and wrong-order cases with independent process
  deadlines so a performance regression cannot hang the test runner itself.
  Command/Ctrl+K focuses and selects its query even from the agent select; `/` remains the
  unmodified keyboard shortcut. The queue itself is an
  inline-size container: filter/tool groups reflow rather than scroll beneath the inspector, and
  below 620px each row gives its title a full primary line before wrapping status metadata.
  `test/editorial-shell.test.ts`, `test/panes.test.ts`, `test/layout.test.ts`,
  `test/dom/search-index.test.ts`, `test/dom/boot.test.ts`, and
  `test/dom/project-disclosure.test.ts` pin the contract; jsdom still
  cannot validate the responsive media layer or CSS vars.
- **Attention-first cold launch** — every fresh viewer opens the Dashboard with All projects,
  all agents and All action types, and no expanded card. Project/agent filters are
  window-local; the boot path removes the two legacy localStorage keys so an older build
  cannot strand a new build behind a stale lens. Explicit notification/hash deep links are
  the exception: they scope to and open their target. This keeps the global badge and the
  first visible list honest about the same cross-project workload. Sort order is the one
  saved queue display preference *(#221)*, because ordering never hides anything: Settings →
  Default sort order (`agent-inbox-default-sort`; an unknown value reads as Priority) seeds
  the queue's Sort menu on every load, and a change there repaints at once through
  `forceRender()`. The queue's own Sort menu changes only the current view, never that default.
- **Build stamp + staleness signal** *(#40)* — `scripts/write-setup-info.mjs` (called by the
  packager, and executable in a test the way `package-app.sh` never can be) bakes `commit` +
  `builtAt` beside the paths setup-info.json already carried; `src/stamp.ts` reads the checkout's
  live HEAD in the VIEWER process and `/api/setup` carries the verdict; `public/buildstamp.js` turns
  it into one line in the Setup panel. Four things are deliberate. (1) **Direction, not difference:**
  `merge-base --is-ancestor` splits a bare SHA mismatch into `stale` (the checkout moved on —
  repackage), `behind` (the CHECKOUT was moved back; the app is NEWER, so repackaging would
  downgrade it and no command is offered) and `diverged`. (2) **The dev path claims nothing** — no
  baked commit means `drift:'dev'`, which reports the live HEAD and never warns. (3) **Fail-open at
  every step**: `readBakedInfo` swallows a corrupt file (it used to throw straight out of the
  handler and empty the whole panel), a non-sha commit is never handed to git as argv, a missing
  repoRoot spawns nothing, `execGit` is timeout-bounded, and the `/api/setup` handler treats a
  throwing probe as "no stamp". (4) **It is NOT attention** — nothing reaches `public/attention.js`,
  `countsByProject` or the dock badge; pinned in `test/stamp.test.ts` (source) and
  `test/dom/build-stamp.test.ts` (the same fixture's badge/tabs/rows under `current` vs `stale`).
  Cadence: the git probe is **lazy and memoized for 60s** (`STAMP_TTL_MS`) — there is no poller, and
  `/api/setup` is fetched once per page load, not on the 3s poll. The #23 reuse path is covered for
  free: a fresh checkout that attaches to a stale packaged server renders that server's stamp.
- **Session build in Live** *(#197, part 1)* — `src/version.ts` is the one place the release version
  lives in code: `AGENT_INBOX_VERSION` is what the MCP handshake reports AND what presence records.
  A release bumps it beside package.json (`test/release-pipeline.test.ts` pins the pair). At startup
  the server also detects where it runs from (`src/server-source.ts`): `'runtime'` when
  `runtime-manifest.json` sits beside its `dist/` — the installer's own marker, true of Setup's
  `~/.agent-inbox/runtime/<id>/` and of a payload under the app's `runtime/<platform-arch>/` — and
  `'checkout'` otherwise. Registration and `status` write both to the additive
  `activity.server_version`/`server_source` columns; a write that omits either keeps the stored value,
  and legacy rows stay NULL. They ride on writes that already happen and are never evidence of
  liveness or work: `updated_at`, `last_call_at`, claims and spans are untouched. `/api/activity`
  rows carry both (still a bare array — electron/main.cjs reads it as one).
  `GET /api/version` answers `{current, mode, runtimeInstalled}`: a release's baked setup-info version
  with `mode:'release'` and whether THIS release's exact runtime is installed for this host (`true`),
  is not but Setup can install it because its source payload verifies (`false`), or neither (`null`);
  a checkout answers its own constant with `mode:'dev', runtimeInstalled:null`. `/api/setup` and
  `/api/version` share ONE cached verified lookup (`installedRuntime` + `resolveReleaseRuntimeSource`),
  because each hashes a whole runtime on the viewer thread — Electron main in the packaged app. Its
  key stamps (identity, size, mtime, ctime) the runtime root, each installed runtime directory and its
  manifest, and the source payload and its manifest, so an install, removal, atomic rename-over or
  manifest edit re-verifies on the next read; a 10-minute backstop covers edits deep inside a
  runtime. Live reads it at page load, when the drawer opens and after a Setup install — never on
  the poll. `sessionBuild()` in `public/livebar.js` compares strict semver only and **gives only the
  advice that backs THAT session**: a checkout session is told to update and rebuild its checkout; a
  runtime session's advice follows its host's registration (part 2, below) in a release viewer; anything
  else, including a legacy row with no source, says only "older build (vY)". Unknown versions on either
  side render no hint. The drawer shows every label and the full hint (the collapsed idle fold counts older builds);
  the strip adds only an "older build" marker. Presence, not attention: no badge, Needs-you, count or
  notification. Part 1's "installed" was per machine, so a host Setup had not moved still restarted into
  its old runtime; part 2 (below) narrows the runtime advice per host.
- **Agent registrations and "Update agents" / "Match agents"** *(#197, part 2)* — what a restarted session loads is what
  its HOST is registered to run, not what is installed. `src/agent-hosts.ts` (VIEWER-PROCESS-ONLY and
  read-only: no process, network, lock or write) reads it from the files the installer manages and keeps
  only `mcpServers['agent-inbox']` from `~/.claude.json` and `~/.copilot/mcp-config.json`, plus the
  agent-inbox-shaped hook entries (`{command, args:[entry, subcommand]}`) in `~/.claude/settings.json`.
  Every other server, env value and secret is parsed in memory and dropped: never returned, logged or
  cached. It never asks the host CLIs (`claude mcp get` health-checks a server by starting it). Kinds are
  `none`, `runtime` (Setup's: runtime id + manifest version), `checkout` (`dist/` beside a `package.json`
  named agent-inbox and no runtime manifest: its root path), `other` and `unknown`. `runtime` is exactly
  the installer's ownership rule (`classifyRuntimeRegistration` in `scripts/runtime-config.mjs`): node and
  entry resolve, by real identity, into the SAME directory under the runtime root, which verifies as an
  intact runtime naming itself. That check uses the shared verifier with THIS app's expectations relaxed
  (version, platform, Node major/ABI, later required files): ownership is the question, and a stricter
  check would hide exactly the older runtimes an update must move. `test/agent-hosts.test.ts` runs the
  installer's helper over the same files and pins agreement (`owned` ⇔ `runtime`, `absent` ⇔ `none`), so
  Setup never offers to update a registration the installer would refuse. The viewer caches the result
  on the three files' link and target stamps plus the runtime root listing (every install changes one)
  with the same 10-minute backstop, hashes each registered runtime once per directory/manifest stamp, and
  reuses the release lookup's stricter verification for the current runtime. `/api/version` adds
  `hosts:{claude,copilot}` as `{kind, version?}` only — no path, id or config — and `updatable`, the one
  rule (`canUpdateAgents`) Setup's action and Live's "update agents" advice share: a release whose own
  runtime payload verifies here, installed or not. `/api/setup` adds `agents`:
  each host and Claude's hooks (a checkout's path included; the owner already sees paths there),
  `current`, `updatable` (a release whose runtime Setup can install here) and `hooksCommand`. The Setup
  panel's Agents block (rules in `public/agents.js` `agentsAction`; every string is textContent) offers ONE
  action only in an Electron window whose `available()` is true, only when `updatable`, and only for the
  Setup-managed hosts whose runtime differs from `current`, in EITHER direction: the installer replaces a
  registration it owns whichever way the version moves, so a downgraded app restores a matching runtime.
  Hosts that are only behind get **Update agents**; a host that is ahead (an app downgrade) gets **Match
  agents to vX**, which also names the one action when hosts differ both ways. Equal versions (build
  metadata ignored) get nothing. It calls the existing `install(target)` once per host, `claude` then
  `copilot`, never `all` and never `--force`: `--target all` stops before changing anything when one
  host's CLI is gone, which would hold the other host back too, so each host is moved and reported on its
  own. A step that was cancelled, timed out or could not run ends the run, and the later hosts are reported
  as not started: a quit cancels the running install, and starting the next host mid-shutdown could have
  the exit kill it halfway through replacing a registration. Main enforces the same thing on its side:
  `createInstallGate()` (`electron/setup-runner.cjs`) is its one record of the running install and of the
  quit, and `beginAppQuit()` in `main.cjs` is the ONE function every quit or restart path calls first
  (`before-quit` on every firing; an update-restart path must call it too). It refuses every later install
  for good, revokes the window's Setup (and #216's window binding never grants it again), cancels the running install and returns a never-rejecting promise
  the caller waits on before exiting. A checkout or custom registration is reported, never switched (the
  runtime-mode installer refuses a registration it does not own anyway). Afterwards it re-reads `/api/setup` and `/api/version` and
  lists, per host that moved, how many running sessions still run a build that differs from what that
  host now runs (older, newer or both) and how to restart them (`claude --resume` / `copilot --resume`);
  it never says a session reloaded. The block also re-reads whenever Settings opens, so a terminal install
  made meanwhile shows up. It does not move Claude's hooks: once the current runtime is installed the
  panel hands over `bash <runtime>/scripts/install-hooks.sh --apply` (for hooks behind or ahead) to run in
  a terminal, and promises that command only when it can install that runtime (`updatable`). No IPC
  channel, preload method, argv shape or HTTP route was added, and nothing runs at startup. Live's
  `remedy()` maps a runtime session to its host by its inferred agent (`claude-code` → claude, `copilot`
  → copilot) and, for a session OLDER than the app, says "restart this session to load vX" only when that
  host is registered to Setup's runtime at vX or later, "update agents from Setup, then restart this
  session" only when it is an older Setup runtime and `updatable` (so never toward an action Setup does
  not show), and nothing otherwise (a missing `hosts` included). `sessionBuild()` keeps `older` (older
  than the app) separate from `newer`: a runtime session NEWER than the app whose host is now registered
  to exactly the app's build — after Match agents — gets a "newer build (vS) — restart this session to
  load vX" marker in the strip and drawer; one whose host still runs a newer build, or an older one, gets
  none, because a restart would not bring it to the app's build. Known limits: `inferAgent` folds every client named
  like "claude" into `claude-code`, so a Claude Desktop session is advised by Claude Code's registration;
  only user-scope registrations are read, not a project or local one that shadows it; and a checkout's
  version is not read, so its sessions keep the checkout advice.

## Open backlog — and the seams already in place

- **Remote / hosted mode** *(#8)* — run on a server, tunnel-exposed for phone + cloud-agent reach.
  Swap stdio for **streamable-HTTP** and add **auth** (bearer token in MCP client headers + a gate
  on the viewer). `register` is the identity seam: a remote server can't see the client's `cwd`, so
  agents declare scope via `register` instead of auto-inference. `AGENT_INBOX_DB`/`AGENT_INBOX_PORT`
  env overrides are already in place. Design (three blocking decisions, three verified wiring traps):
  [`docs/superpowers/specs/2026-07-26-remote-hosted-mode-design.md`](docs/superpowers/specs/2026-07-26-remote-hosted-mode-design.md).
- **Plans that model GitHub sub-issues** *(#103, v1.4)* — PR1a shipped the `issue_snapshots`
  cache, issue keys and key sets, the pure graph builder and `GET /api/issues`; PR1b the
  viewer poller (fair queue, leases, rate-limit budget, `closing_refs`; see the invariants
  above); PR2 explicit plan pins and row links with the titled `board_get` `issue_rel`
  summary (see the invariant above). Still to come, per the design's §13: PR3 breadcrumbs and
  child progress in the UI.
Keep all of these additive and behind the existing seams — don't break v1's local,
zero-config, no-auth path.

Boards-specific follow-ups (unseen-by-agent markers, row context field, archive safety,
row escalation) are GitHub issues #1–#6; original review context in
[`docs/boards-backlog.md`](docs/boards-backlog.md).

## Gotchas recap

- Node 26 default → this checkout's `better-sqlite3` binding was built for Node 24's ABI and
  fails to load; use Node 24.
- Register the MCP server with the absolute Node 24 path, not bare `node`.
- New MCP-server registration is picked up only on a **fresh** CLI session.
- The **reporting snippet** (`docs/reporting-snippet.md`) is what makes agents flag at all —
  code shipping ≠ agents using it; the snippet must be in the user's global instructions.
