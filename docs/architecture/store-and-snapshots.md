---
paths:
  - "src/store.ts"
  - "src/viewer.ts"
  - "public/snapshots.js"
  - "public/closed-history.js"
  - "public/boards.js"
  - "electron/conditional-read.cjs"
  - "test/fixtures/snapshot-triggers.txt"
applyTo: "src/store.ts,src/viewer.ts,public/snapshots.js,public/closed-history.js,public/boards.js,electron/conditional-read.cjs,test/fixtures/snapshot-triggers.txt"
---

# Store and conditional snapshots

The one database door (`src/store.ts`), WAL concurrency, and the conditional snapshots the viewer serves (#297, #184, #299).

Moved out of `CLAUDE.md` and `.github/copilot-instructions.md` by #379, nearly verbatim. Claude Code and Copilot CLI load this file automatically when they read or edit a file matching the `paths`/`applyTo` globs above (through the symlinks in `.claude/rules/` and `.github/instructions/`); anyone else should read it before changing those files.

## In brief

- Do not issue raw SQL outside `src/store.ts`. The viewer, MCP server, hooks,
  watcher, and PR poller all share one database across OS processes. Preserve
  `journal_mode=WAL` and `busy_timeout=5000`, and make any transaction that
  reads before it may write `.immediate()`: SQLite never waits when a deferred
  reader is promoted to the writer.
- Conditional viewer snapshots retain only items, the dock watcher's
  `/api/items?scope=attention` and `/api/boards?scope=attention` projections (#156,
  #287; each its own validator, never the default representation's),
  `/api/items/history` (likewise its own), active/archived boards, archived
  plans in brief (`/api/boards/archived/summary`, #299, likewise its own),
  the `/api/issues` sub-issue graph (#103, likewise its own; its builder is pure,
  so its bytes depend on the database alone) and the `/api/links` PR state (#288,
  likewise its own; the PR poller writes it through `store.ts` and its previews
  follow open items and active plans, so its bytes depend on the database alone too,
  and a 404, network error or refused body still means no links). `/api/items` and
  `/api/boards` never carry GitHub data, so issue snapshot writes leave their bytes
  and validators unchanged.
  The dock watcher reads its two projections conditionally through
  `electron/conditional-read.cjs` and still runs the shared predicate every tick,
  because the clock alone changes what it decides.
  Invalidate on same/other-connection writes, schema changes and pickup stamps;
  never cache an uncommitted snapshot. Keep dynamic routes fresh, no-store and
  the boot marker intact, and never turn a read failure into cached success.
  Activity history changes with time alone, so it is conditional only on a hash
  of its freshly computed bytes plus the window and project that selected them;
  never validate it with store tokens or cache it server-side (#185). The
  lingering plans' read `/api/boards/archived/plans?ids=…` (#373) is built the
  same way (fresh bytes, tag over bytes plus ids, never retained), and these two
  are the only routes whose query the browser reader accepts.
- A write rebuilds only the snapshots it can change (#297): each snapshot's token
  is the schema cookie plus the versions of the store domains its bytes are built
  from (`SNAPSHOT_SOURCES` in `src/viewer.ts` over `SNAPSHOT_DOMAINS` in
  `src/store.ts`). Triggers move those versions, so an older process's writes
  count too; tables no snapshot reads (presence, claim history, the hook and
  refresh leases, reply intents) have none, so activity and claim writes rebuild
  nothing. The `snapshot_domains` contract is permanent: never drop or redefine
  a snapshot trigger (its name hashes its text;
  `test/fixtures/snapshot-triggers.txt` pins the names), never drop, reset or
  rewrite `snapshot_domains` or its rows, never retire a domain, and make any
  future rebuild of a watched table re-create every `snapshot_` trigger it had,
  in the same transaction. Keep the triggers last in every migration (they name
  the live columns, double-quoted), give a new read every domain it needs, and
  classify a new column in `REVIEWED_COLUMNS` or a new table in `UNREAD`. A read
  inside a transaction is never published: a rollback takes a version back.
  Versions start at a random 48-bit value. When the schema cookie moves, a
  viewer checks its triggers: a domain missing one (or its version row) falls
  back to the pre-#297 commit token, rebuilt after any commit and a 304
  otherwise. Only an `openDb` that generates the same trigger text heals it.
- `/api/items` pages closed history (#184): every open item, the 50 most recently
  touched closed items, the 4 newest outcome-bearing ones of open projects and a
  `history` summary that keeps every count exact. Only `load()` reads
  `/api/items/history`, while `historyWanted()` says a surface needs older items,
  judged on a page alone (`lastData.page` or the tick's new one), never on merged
  data. The Today ribbon wants it only at a range past 24 hours that starts
  before the page's `before` (#392). Explicit human entry points (the ribbon's
  range menu included) use `requestHistoryPaint()` (ends in
  `reloadAndPaint()`, #38); search and waiting deep links use `requestHistory()`,
  which only schedules that `load()`; `forceRender`, renders and the poll use
  neither. A failed read degrades: the page still applies and waiting surfaces
  say older history is unavailable.
- The poll carries archived plans in brief (#299): `/api/boards/archived/summary`
  (`listArchivedSummary`) keeps every archived plan's fields and `progress`, only
  the rows that link an issue (identity and content times) or hold one of their
  project's 4 newest outcomes plus ties (with the outcome, its stamps and what a
  Handoffs outcome card shows: note, next step, owner, options), and per plan the
  outcomes it omits with their newest stamp, so counts, the rail, issue activity
  labels, the Dashboard's default lens and Handoffs' cards read as the complete
  list draws them; a surface that draws a row field from the brief needs it in the
  brief's select. Only `load()` reads the complete `/api/boards/archived`, while
  `archivedWanted()` says a surface needs it (the open archived fold, more than
  50 lingering plans, a focused plan just archived that does not linger, search,
  a waiting deep link, restored row drafts whose row no active plan holds,
  Handoffs or Plan flow on an archived plan, an unproven Dashboard lens, a
  ribbon range past 24 hours its omitted outcomes fall in), judged on the brief,
  never on the complete list. `requestHistory()`/`requestHistoryPaint()` ask for
  either source; a failed read degrades to "Archived plans are unavailable right
  now.", and an older viewer's 404 for the brief reads the complete list in its
  place. Every surface
  that draws an archived plan whole reads it through `wholeArchived()`
  (`lastData.archivedFull`, else the lingering read below), and a held row draft
  is placed by the first tick that read the complete list (or failed to). For a
  plan lingering in Plans (#373): while the complete list is not wanted, `load()`
  reads only the lingering plans, `/api/boards/archived/plans?ids=…`
  (`lingeringUrl`, every lingering plan's sorted ids across all lenses, Plans tab
  only, at most 50; `listArchivedPlans` serves the complete list's entries), into
  `lastData.lingering`, and lingering cards draw from `wholeArchived()` (the
  complete list while loaded, else those). A failed read degrades like #299's, a
  404 from an older viewer reads the complete list instead, and
  `lingeringWanted()` joins `omittedWanted()`, so returning to Plans reads it at
  once.
- Race-sensitive state changes must be atomic SQL statements or transactions.
  Do not replace conditioned/version-pinned updates with SELECT-then-UPDATE.
  Human replies, annotations, and handled marks can change from another process
  between reads and writes.
- Browser snapshot reuse is window-local and immutable; a 304 belongs to the
  representation that request sent, and its live boot header still controls safe
  refresh. Passive polls may retain inactive document panes, but navigation and
  human writes must paint current data without hiding ambient or recovery state.

## Invariants in detail

- **Conditional snapshots must remain authoritative.** Only `/api/items`,
  `/api/boards` and `/api/boards/archived` retain one serialized representation
  each per viewer, plus `/api/items?scope=attention` (issue #156): the Electron
  dock watcher's lean read, built from open questions alone and registered
  separately with its own validator so neither `/api/items` representation can
  revalidate the other, `/api/boards?scope=attention` (issue #287), the same
  watcher's plans read, likewise its own (`listBoardsWithBlockedRows`: the
  default's active plans that hold a blocked row, in its order, each narrowed to
  those rows, every plan field and `progress` otherwise the default's),
  `/api/items/history` (issue #184, below), likewise its own registration and
  validator, `/api/issues` (issue #103, `github-and-issues.md`), the seventh, `/api/links`
  (issue #288), the eighth: the cached PR state, whose bytes depend on the
  database alone because the PR poller writes them through `store.ts` and the
  previews it keeps follow open items and active plans, and
  `/api/boards/archived/summary` (issue #299, below), the ninth: archived plans
  in brief, a path of its own beside the complete archived list, and `/api/messages`
  (issue #411, `delivery-and-responses.md`), the tenth: every open session message and
  the 100 newest closed ones, over the whole-table `session_messages` domain, whose
  `delivered_at`/`delivered_by` are restamped columns, so `pending()` re-delivering a
  message on every poll rebuilds nothing. Any other query string
  keeps the default items or boards response. The dock watcher reads its two
  projections through `electron/conditional-read.cjs`: each read sends the
  validator its last 200 carried and reuses what it parsed on a 304, an untagged
  answer (an older viewer) is never held, and a failure drops what was held. An
  older reused viewer ignores the parameter and serves its full list, which the
  shared predicate reads the same way (`test/reply-watch.test.ts`). The predicate
  still runs every tick, 304s or not, because the clock alone changes what it
  decides, and a refused notification answer re-reads the default `/api/boards`.
  Matching `If-None-Match` returns a bodyless 304; unconditional
  clients still receive full JSON. Keep `Cache-Control: no-store` and the current
  outer `x-inbox-boot` marker on 304 responses too. A snapshot's token is the
  schema cookie, the versions of the store domains its bytes are built from and
  transaction state (issue #297, next bullet); `updated_at` alone never observes
  every relevant write.
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
  Only `/api/activity/history` and `/api/boards/archived/plans` (#373) take a query
  in the reader: any other (such as the dock watcher's `?scope=attention`) is
  refused, so it can never share or evict the page's slot, and
  `/api/items/history` is a path of its own (#184).
  Read the live boot header before consuming cached data. Untagged servers retain
  full-fetch behavior, malformed replies fail explicitly, and no snapshot content
  is persisted to browser storage (the human's unsent drafts, #279, are not snapshot
  content). Derive mutable view state rather than changing
  authoritative cached records. A poll tick starts its nine reads together (#161)
  and applies nothing until all settle: history, closed projects, links (read as a
  snapshot since #288, its body through `linksBody`, so a 404, a network error or
  a refused body is no links), the sub-issue graph (#103) and the session messages
  (#411, `messagesBody`: the same three mean no messages) keep their
  fallbacks, any other failure still fails the whole tick (reported in the old
  serial order) without blanking the frame, and `loadGeneration` still discards
  an older tick that finishes late. Since #299 the archived read among the nine
  is the brief; the complete archived list, like older closed history, is an
  extra read only while a surface needs it.
- **A write rebuilds only the snapshots it can change (issue #297).**
  `SNAPSHOT_SOURCES` in `src/viewer.ts` names, for each conditional snapshot, the
  store domains its bytes are built from; `SNAPSHOT_DOMAINS` in `src/store.ts`
  defines a domain as one table, read whole or through listed columns, with a
  version row in `snapshot_domains`. TRIGGERS move a version inside the writing
  statement's own transaction, never callers, because older servers and viewers
  share the file for days and run statements that know nothing of domains
  (`increment_item_response_revision`'s precedent). Every insert and delete moves
  each domain of its table. An update moves a whole-table domain whenever it sets
  one of its columns, and a column domain only when one of the domain's values
  changed. Tables no snapshot reads (`activity`, `activity_spans`,
  `hook_watch_claims`, `issue_refresh_claims`, `item_reply_intents`, the pre-#157
  `source_links`) carry no trigger, so `recordActivityCall` on every MCP call, the
  liveness tick, claims and the poller's leases rebuild nothing. The dock's
  waiting/parked split reads `/api/activity`, never a retained body, so the
  attention projection reads items alone. Six rules hold. (1) **The
  `snapshot_domains` contract is permanent.** Never drop or redefine a snapshot
  trigger; never drop, reset or rewrite `snapshot_domains` or any of its rows;
  never retire a domain, even one this build no longer reads, because an older
  process sharing the file may still read it. A trigger's name ends in a hash of
  its text, so a changed definition is a new trigger beside the old one, which
  keeps an older process exact (at worst it moves a version for nothing);
  `test/fixtures/snapshot-triggers.txt` pins every name a fresh hub gets, because
  even a layout change to the generated text would add a second set of triggers
  to every existing hub. A future rebuild of a watched table (create, copy, drop,
  rename) must re-create every `snapshot_` trigger the old table had, from its
  stored SQL, in the same transaction. Two guards back this up: a version starts
  at a random 48-bit value, so a row seeded again after a reset cannot climb back
  to a version an idle viewer cached; and whenever the schema cookie moves, a
  viewer compares `sqlite_master` with every trigger it would make. A domain
  missing one, or without a version row, falls back to the token every snapshot
  used before #297 (`data_version` and `total_changes()`, read in the same
  `SELECT` as the rest): rebuilt after any commit, a 304 otherwise. Only an
  `openDb` that generates the same trigger text heals it: one by this build, or
  by a later build whose generator did not change. A build whose generator
  changed makes its triggers under other names, so the fallback lasts until a
  process of this build opens the hub. (2) **The triggers are made last
  in every migration, from the live schema:** a whole-table domain's update
  triggers name every column its table has, so whichever build adds a column
  also adds a trigger that watches it. Every table, column and trigger name is a
  double-quoted identifier (quotes doubled), so a column a later build names
  with an SQL keyword (`order`, `group`) cannot make every `openDb` throw.
  Rowids are never written (VACUUM renumbers them but moves the schema cookie).
  (3) **Versions only grow and commit with the write,** so equal versions before
  and after a read prove that nothing it reads changed. A read inside a
  transaction is still never published: a rollback takes a version back, and a
  later commit can return it to the value the uncommitted read saw. For the same
  reason trust is never remembered from inside one, since a rollback takes the
  cookie back too. The schema cookie stays in every token. (4) **A new read
  needs its domains.** Give the snapshot every domain covering the tables and
  columns it reads. A column added to `items`, `boards`, `board_rows` or
  `source_links_by_head` fails `REVIEWED_COLUMNS` until someone decides whether
  each column domain of that table reads it; a new table needs a domain or a
  reason in `UNREAD`. (5) **The generic check is the proof.** It
  writes every column of every table, and inserts and deletes rows, then requires
  every snapshot whose token did not move to serve identical bytes. Its fixture
  makes the column dependencies observable (closed history past one page,
  previews, issue identities from pins, PRs, branches and rows); keep that true
  for a new read. (6) **Cost shapes the triggers.** SQLite compiles every trigger
  a statement may fire into that statement, and `store.ts` prepares per call: a
  WHEN over every column cost each prepared statement ~25 µs, so a whole-table
  domain's catch-all trigger has none and fires even for an unchanged value (an
  unchanged re-send). Only the delivery stamps `pending()` re-applies on every
  poll (#37), its `restamped` columns, get one value-checked trigger each, so a
  re-delivery rebuilds nothing.
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
  (`historyWanted`: a search in use — open results, a pending query or one
  focused in an active window, not text left in a closed box, even one a
  background window still reports as focused (#233) — the Handoffs overlay,
  History paged past what the page proves, a History deep link, a pending deep
  link to an omitted item,
  Dashboard recent outcomes the page cannot prove, or (#392) the Today ribbon at
  a range longer than 24 hours that starts before the page's `before`; at 24
  hours the ribbon keeps its cut-off note and reads nothing), or, within the same tick and
  under the same boot-marker and generation rules, when the tick's own new page
  needs it, so a sweep never paints a blank History frame. Decide on a PAGE
  (`lastData.page`, or the tick's new one), never on merged data, or loading
  history would end the need for it. Explicit human entry points (tab select, the
  History pager, rail project/agent picks, opening Handoffs, a deep link that
  found its target, the ribbon's range menu (#392), which is not saved, so boot
  always starts at 24 hours) call `requestHistoryPaint()`, which ends in `reloadAndPaint()`
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
- **Archived plans are paged out of the poll like closed history (issue #299).**
  The poll's archived read is `/api/boards/archived/summary`
  (`listArchivedSummary`, `SNAPSHOT_SOURCES['archived-summary']` = boards and
  board_rows): every archived plan in `listBoards`' order with every plan field and
  `progress` over all of its rows, but only the rows its surfaces read without the
  complete list, each with only the fields they read, as the complete list has
  them: every row that links an issue, with its identity and content times, so
  issue activity labels ("Done here", `public/issues.js`) read the same; and each
  project's `RECENT_OUTCOMES` (4) newest outcome-bearing rows plus ties, with the
  outcome, the stamps `public/relay.js` `stamp` orders it by and what a Handoffs
  outcome card shows of its action (`note`, `next_step`, `action_owner` and
  `options`, parsed as the complete list parses them), so the Dashboard's recent
  outcomes are proven for every lens without an agent filter, and Handoffs draws
  the same outcome cards from the brief as from the complete list (its outcome
  lane reads the complete list only while the lens omits an outcome). A surface
  that draws an archived row's field from the brief must find that field in the
  brief: add it to the brief's select and `test/archived-summary.test.ts`'s field
  lists, never draw a field the brief does not carry. Ties matter: one upsert stamps all its outcomes alike, and a cut tie could
  never be proven. Every other outcome, a linked row's included, is omitted: each
  plan's `omitted` gives how many and the newest stamp among them (never null
  while it omits any; the stamp falls back to the plan's `updated_at`), so every
  count stays exact (`omittedOutcomes` in `public/boards.js`). The rail, the
  fold's "Archived plans (N)", lingering decisions and the collapse-state pruning
  read the brief through the same code as the complete list.
  `lastData.archivedBrief` is the brief; `lastData.archived` is what surfaces
  read, the complete list while loaded and the brief otherwise;
  `lastData.archivedFull` is the complete list or null. Every surface that looks
  up an archived plan whole (the fold's cards, lingering cards, Plan flow, a deep
  link's landing, `rowHolds`) goes through `wholeArchived()`: the complete list
  while loaded, else the lingering read (#373, next paragraph), which holds only
  the lingering plans; the brief is never drawn whole. The complete
  `/api/boards/archived` is unchanged and ONLY `load()` reads it, while
  `archivedWanted()` says a surface needs it: a deep link to a plan the brief
  names (`archivedLookup`, waiting and dropped exactly as #184's),
  restored row drafts waiting on it (below), search in use (`searchInUse()`,
  #184's rule), Plan flow open on an archived plan, Handoffs with omitted archived
  outcomes, Plans with the archived fold open, more than 50 lingering plans or a
  focused plan its agent just archived that does not linger (the focus follows it
  into the fold), and a Dashboard
  lens whose recent outcomes only the archived plans can prove
  (`recentOutcomesWait.archived`; `.history` is #184's half), or (#392) a ribbon
  range past 24 hours that starts before the newest outcome the brief omits
  (`ribbonWait` in `public/ribbon.js`, over the model's `asksAfter` and
  `archivedAfter`; a failed read adds the unavailable line to the ribbon's
  cut-off note instead of blanking it). Judge on the BRIEF
  (the applied one, or the tick's new one for the in-tick read that lets a plan
  archived this tick linger at once), never on the complete list, whose plans
  omit nothing. The two sources share #184's early-tick requests:
  `requestHistory()`/`requestHistoryPaint()` act when `omittedWanted()` says either
  is wanted and still omitted, so one tick reads both, and opening the fold (a
  `toggle` that turns `showArchived` on, never one a rebuild fires) is an explicit
  entry point. A failed read degrades like older history: the brief still applies,
  the fold and lingering place say "Archived plans are unavailable right now.",
  search stays busy with that line, and the Dashboard and Handoffs name whichever
  source failed. An older viewer answers the brief with 404: the tick reads the
  complete list in its place, as such a viewer's page did, and fails only if that
  read fails too. Search is busy, never partial, while either source is omitted
  ("Searching archived plans…"). A restored row draft (#279) whose row no active
  plan holds may be an archived plan's, and only the complete list says whether
  the server already holds its text (`rowHolds`): while archived plans are paged
  out and their last read has not failed (`awaitsArchivedRow`),
  `placeRestoredDrafts` keeps it restored, still the profile's copy, asks for an
  early tick, and places it the same way on the first tick that read the complete
  list, or as before once that read failed. A draft for a row in an active plan
  comes back with the first data, as always. Archived plans never carry
  attention: `public/attention.js`, the dock and the badge read none of this.
  **A lingering plan reads only itself (issue #373).** A plan the human watched
  lingers in Plans for the session once its agent archives it (§9), and reading
  the complete list for its card on every Plans poll gave back #299's saving:
  after any plan write the server rebuilt and hashed the whole list on Electron
  main, and after any archived plan changed the page fetched, parsed and froze
  all of it again. While the complete list is not wanted,
  `load()` instead reads `/api/boards/archived/plans?ids=…` (`lingeringUrl`): the
  sorted ids of every plan lingering in the brief across all projects and agents
  (`lingeringIds`, so a lens change reads nothing new), only on the Plans tab, at
  most 50 (`LINGERING_READ_LIMIT`, the route's own limit; more fall back to the
  complete list through `archivedWanted()`). `listArchivedPlans` serves exactly
  the complete list's entries for those ids (archived plans only, unknown ids
  left out) in one read transaction. Like `/api/activity/history` it is never
  retained server-side and has no `SNAPSHOT_SOURCES` entry: its bytes are built
  fresh on each read (a few plans), depend on the
  database alone, and its tag hashes them with the ids, so a 304 means identical
  bytes and no two sets, nor the complete list or the brief, share a validator.
  Its ids are validated before any store call (1-50 comma-separated plan ids,
  else `400`). The reader keeps one representation per set, which changes only
  when a plan starts or stops lingering. `lastData.lingering` holds those plans,
  `lastData.lingerUrl` the read the tick made and `lastData.lingerError` why it
  failed; they join `lastData.reads` for #298. Lingering cards draw from
  `wholeArchived()`: the complete list while it is loaded (the fold is open,
  search…), else these plans; a plan in neither keeps its place with "Loading
  archived plans…", or the unavailable line after a failed read, exactly as
  #299's reads degrade. A plan archived this tick lingers at once through the
  same in-tick read the complete list used, and returning to Plans asks for an
  early tick through `requestHistoryPaint()` (`lingeringWanted()` joins
  `omittedWanted()`; a read that failed was read, so it never loops). A viewer
  older than #373 answers the route 404, and the tick reads the complete list in
  its place. No schema, trigger or snapshot-domain change, and nothing reaches
  attention.
- **`src/store.ts` is the only door to the database.** Every read/write goes through its
  exported functions — items: `insertItem`/`resolveItem`/`dismissItem`/`annotateItem`/
  `replyItem`/`answerItem`/`listItems`/`listItemsPage`; boards: `upsertBoard`/`updateBoardRow`/`getBoard`/`listBoards`/`listArchivedSummary`/`listArchivedPlans`/
  `archiveBoard`/`annotateBoardRow`/`markAnnotationDelivered`/`markRowHandled`/
  `clearRowHandled`/`markHandledDelivered`/`listPendingRows`; watch stops (#217):
  `stopItemWatch`/`stopBoardRowWatch`; pins for later (#247): `pinItem`/`pinBoardRow`;
  projects: `closeProject`/`reopenProject`/`listClosedProjects`/`closedProjects`;
  issue snapshots (#103): `upsertIssueSnapshot`/`recordIssueFailure`/`listIssueSnapshots`/
  `listIssueEntities`/`pruneIssueSnapshots`/`claimIssueRefresh`/`completeIssueRefresh`;
  driven sessions (#412): `isReservedProject`/`isDrivenSession` — plus `openDb`. No raw SQL anywhere else. To change
  storage, reimplement this module; nothing else touches SQLite.
- **Reserved projects are filtered in the store (issue #412).** `@sessions` and `@mesh`
  (exactly those, `isReservedProject`) hold a driver's approval alerts and the mesh's asks.
  `listPending`, `listPendingRows` and `listUnansweredBoardRows` return nothing for one,
  `listSessionQuestions` skips items filed in one, `closeProject` refuses one and
  `closedProjects()` never reports one. The viewer's reads (`listItems`, `listItemsPage`,
  `listBoards`, the snapshots) are unchanged, so the human sees them and attention counts
  them. No column, table or trigger was added: a driver's leases (`driven:<session>`,
  token `<launch id>:<driver pid>:<nonce>`, fresh for 90 s) live in `hook_watch_claims`,
  which no snapshot reads.
- **`store.ts`/`mcp.ts`/`viewer.ts` inverse round-trip:** the store's `Item` and
  `BoardWithRows` shapes are the contract shared by MCP writes/reads and viewer reads.
  Change them in `store.ts` and update both consumers (+ `group.ts` for items;
  `public/app.js` renders both).
