---
paths:
  - "src/mcp.ts"
  - "src/version.ts"
  - "src/server-source.ts"
  - "public/livebar.js"
  - "test/live-tick.test.ts"
applyTo: "src/mcp.ts,src/version.ts,src/server-source.ts,public/livebar.js,test/live-tick.test.ts"
---

# Activity, presence and Live

Liveness versus work (#45), the call trace and plan lanes (#306), session presence and the session build shown in Live (#197).

Moved out of `CLAUDE.md` and `.github/copilot-instructions.md` by #379, nearly verbatim. Claude Code and Copilot CLI load this file automatically when they read or edit a file matching the `paths`/`applyTo` globs above (through the symlinks in `.claude/rules/` and `.github/instructions/`); anyone else should read it before changing those files.

## In brief

- Activity has two meanings: `updated_at` is process liveness and
  `last_call_at` is real MCP work. The periodic liveness tick must call only
  `touchActivity`; tool calls record work with `recordActivityCall`.
  `server_version`/`server_source` (#197) are display-only build identity carried
  by existing presence/status writes; an omitted value keeps the stored one, and
  neither is ever evidence of liveness, work or attention.
- The call trace (#306) is `activity.call_minute`/`call_counts`: 30 one-minute
  MCP call counts, written only by `recordActivityCall` (an `.immediate()` read
  then write), never by `touchActivity`, `livenessTick`, registration or claims.
  It rolls to now on each call (a clock moved back counts the stored minute as
  now), is served as `calls`/`calls_at` only while inside the window, stays
  within 150 bytes a session, and the browser rolls it to its own clock. The
  lane sparkline is one static SVG path updated by attribute; never animate it.
- `boards.session` (#306) is the writing MCP session's id, stamped by
  `board_upsert`/`board_row` (null/omitted keeps, `''` clears). A writer change
  alone moves neither `updated_at` nor the board revision; `board_advance`, human
  writes and older servers never touch it; this build's agent reads never carry
  it (an older server's titled `board_get` on a migrated hub passes it through,
  as with `repo_root`). Existing hubs keep the old `boards` update trigger
  beside the new one, so a boards UPDATE moves that version twice, harmlessly.
  The Dashboard puts a plan on its stamped session's lane first, then falls
  back to project + branch + agent, skipping plans another WORKING session
  stamped (an idle or gone session's stamp joins).
- `receives_messages` and `push_wake` (#411) are capability flags carried by the
  same presence writes, kept on omission and served only as `true`.
  `push_wake` says a message is pushed into the session at once: its Claude
  Code was launched with `--dangerously-load-development-channels
  server:agent-inbox` (read from the parent process's arguments, since Claude
  Code reports nothing). It is evidence, not proof: an org policy, a non-claude.ai
  login or a refused registration drops the push silently. A launch through a
  wrapper process, a session Claude Code hosts through its background daemon
  (parent `claude bg-spare … claim.sock`, whose arguments lack the user's flags)
  or one under another registration name reads as absent; and on macOS, where
  `ps` arguments are re-split on spaces, a quoted prompt holding the flag tokens
  can read as true. So absent means unknown, never "won't wake": the composer
  says "when it next checks", never "can't receive", which only a missing
  `receives_messages` means. Never liveness, work or attention; `/api/activity`
  stays a bare array.
- `wakes` (#411 PR 2) is the third: true while a message-capable Claude hook watch
  is armed for the session's Claude Code process, read by `listActivity` in its one
  query (a `LEFT JOIN` on `hook_watch_claims`' unique key `host:<host_pid>`, so it
  adds no row): the lease's token starts `m1:` and was claimed within 30 minutes
  (`WAKE_LEASE_MS`; the watch gives up at 29). Served only as `true`, like the
  other two. An older hook's lease (no `m1:`), an unlinked watcher's `session:`/
  `project:` key, a released lease or one older than 30 minutes reads as absent. It
  is evidence too: a watcher killed without releasing its lease reads as armed for
  up to 30 minutes. The composer's delivery state (`deliveryState` in
  `public/messages.js`) reads these three and nothing else: no `receives_messages`
  is "can't receive" (Send disabled); `driven`, `push_wake` or `wakes` is "arrives
  now"; anything else is "when it next checks Agent Inbox". `activityFrameKey`
  compares bytes, so a flip repaints.
- `driven` (#412) is the fourth: true while an Agent Inbox driver holds the
  session's `driven:<session>` lease in `hook_watch_claims`, claimed within the
  last 90 s (the driver refreshes it every 30 s), read by the same query through a
  second `LEFT JOIN` on the unique key. Served only as `true`. The lease's token is
  `<launch id>:<driver pid>:<nonce>`; a Claude hook's `host:` lease never reads as
  driven, and a `driven:` lease never as `wakes`. The composer says "Arrives now:
  Agent Inbox runs this session."

## Invariants in detail

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
- **The call trace counts work, never liveness (issue #306, D5).** `activity.call_minute` (the
  epoch minute the newest bucket counts) and `activity.call_counts` (comma-separated counts,
  oldest first, at most 30, no leading zeros, each capped at 999) are written by
  `recordActivityCall` ALONE, inside its `.immediate()` transaction (it reads the buckets
  before it writes them). `touchActivity`/`livenessTick`, registration and claims never name
  them; `test/live-tick.test.ts`'s AST pins plus `test/store.test.ts` hold that. A write rolls
  the window to now: a gap appends empty minutes, 30 or more starts over, and a stored minute
  ahead of the clock (it moved back) counts as now. `listActivity` serves them as `calls`
  (array) and `calls_at` only while `calls_at` is within 30 minutes of now, and omits both
  otherwise; at most 150 bytes a session (`test/viewer.test.ts` measures the saturated case).
  The browser rolls them to its own clock (`callTrace` in `public/lanes.js`), so
  `/api/activity`'s bytes move only with a call (which moves `last_call_at` anyway) and once
  at expiry; `activityFrameKey` needs nothing new. The lane's sparkline is one static SVG
  path (`tracePath`), written by attribute only when its bars change and never animated (the
  #304 rule); the 30-second clock repaint (#298) rolls it with no new read. `activity` is in
  no snapshot, so none of this rebuilds anything; older servers' statements never name the
  columns (their calls record no trace, and they never clear one).
- **`boards.session` puts a plan on its lane (issue #306, D4).** Additive, nullable: the
  writing MCP server's `sessionId` (the same id its presence row carries), stamped by
  `board_upsert` and `board_row` through `ensureBoard`. The plan follows its latest writer,
  like `stream` and `agent`: null or omitted keeps it, `''` clears it. A change of writer
  ALONE is not content: it moves neither `updated_at` nor the board revision, so a sibling's
  `board_version` stays valid; `/api/boards` still rebuilds, because the whole-table `boards`
  domain's trigger fires on the `ensureBoard` UPDATE (column domains do not read it;
  `REVIEWED_COLUMNS` says so). `board_advance` restamps no plan field, this one included, and
  neither do the human's writes or any older server's statements. This build's agent reads
  never carry it (`shapeBoard` strips it; `pending()` and the title-less summary never select
  it); an older server sharing a migrated hub (v1.8.0's `shapeBoard` spreads the row) passes
  it through on a titled `board_get`, as with #324's `repo_root`. The
  Dashboard's join (`linkedPlan` in `public/lanes.js`): a plan stamped with the lane's
  session wins (the newest such); otherwise D4's project + branch + agent join, leaving out
  plans stamped with another session that is WORKING (`isWorking`); a stamp naming a session
  that is idle or gone joins as before, so an idle CLI's plan never drops off every lane.
  Existing hubs keep v1.8.0's `boards` update trigger beside the new one that also watches
  `session`, so one boards UPDATE moves that domain's version twice: harmless, as #297 allows.

## History (shipped since v1)

These landed after v1 and still hold invariants; the release history itself is in `CHANGELOG.md`.

- **Session presence** *(#28, corrected by #45)* — every MCP session is a Live row; `status()`
  upgrades it, process exit ends it, and a row that stops being heartbeated expires after ~15 min.
  That expiry only ever fires for a **crashed** process: a live one heartbeats itself, so what
  decays for an idle-but-running session is its `doing` CLAIM, not its row (see the two-stamps
  invariant above). `status({doing})` re-asserts instantly; agents never need to keep one alive.
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
  runtime session's advice follows its host's registration (part 2, in `setup-and-installers.md`) in a release viewer; anything
  else, including a legacy row with no source, says only "older build (vY)". Unknown versions on either
  side render no hint. The drawer shows every label and the full hint (the collapsed idle fold counts older builds);
  the strip adds only an "older build" marker. Presence, not attention: no badge, Needs-you, count or
  notification. Part 1's "installed" was per machine, so a host Setup had not moved still restarted into
  its old runtime; part 2 (in `setup-and-installers.md`) narrows the runtime advice per host.
