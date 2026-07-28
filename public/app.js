import { paginate, paginateGroups, searchMatches } from '/search.js'
import {
  closedFoldLabel, closedRailEntries, filterRailEntries, railEntries, railProjects,
  shouldShowRailFilter, splitClosed, suppressedTotal,
} from '/rail.js'
import {
  attentionCount, attentionEntries, awaitingAgentRows, classifyLiveness, countsByProject,
  isAskingQuestion, isBlockedRowAttention, staleEntries,
} from '/attention.js'
import { DEFAULT_TAB, TAB_IDS, tabCounts } from '/tabs.js'
import { projectColor } from '/colors.js'
import { shouldDeferRender, suspendHint, pinOrder, applyListUpdate, reconcileOpenRow } from '/poll.js'
import { createStagedSend } from '/star.js'
import {
  ageChip, agentCounts, needsYouEntries, relMs, repliedEntries, rowModel, rowStarOption,
  stagedLabel, staleFoldLabel, streamCounts, undoRefusal, urgencyChip,
} from '/rowview.js'
import { cardSections, optionOrder } from '/card.js'
import { keyAction, rovingIndex, ariaAnswerLabel, livenessGlyph, deckEntryAt } from '/keys.js'
import { partitionNotes, unreadNoteCount, ambientChips, seenWatermark, markSeenIds } from '/notes.js'
import { liveSummary } from '/livebar.js'
import { esc } from '/esc.js'
import { boardRowsView, progressLabel, hiddenDoneCount, lingeringBoards } from '/boards.js'
import { liveEntity, tabMatchCounts, projectMatchCounts, elsewhereLabel } from '/tabsearch.js'
import { titleWithBadge, focusHashFor, parseFocusHash } from '/badge.js'
import { layoutMode, railLabel, NARROW_MAX } from '/layout.js'
import { indexLinks, sourceChipsHtml, sourceBlockHtml } from '/source.js'

void paginateGroups // kept exported+tested (spec §15); the viewer no longer calls it

// typo-tolerant fuzzy filtering; the engine is a vendored browser global
const uf = new window.uFuzzy({ intraMode: 1 })
const fuzzyFilter = (hay, needle) => uf.filter(hay, needle)
let searchQuery = ''

// per-section visible-card caps; `shown` grows as the user clicks "show more"
const PAGE = { needsYou: 10, notes: 5, done: 5, boards: 5, archived: 5 }
let shown = { ...PAGE }
function resetPaging() { shown = { ...PAGE } }

let lastData = null
// issue #30 — the (repo, branch) → cached PR state index, rebuilt once per
// render. A Map from the start, never null: the deep-link and setup paths can
// reach a renderer before the first /api/links response lands, and linkFor(null)
// would throw into load()'s catch and blank the whole page.
let linkIndex = new Map()
const FILTER_KEY = 'agent-inbox-agent-filter'
const PROJECT_KEY = 'agent-inbox-project-filter'
const HIDE_DONE_KEY = 'agent-inbox-hide-completed'
let agentFilter = localStorage.getItem(FILTER_KEY) || null
let projectFilter = localStorage.getItem(PROJECT_KEY) || null
let hideCompleted = localStorage.getItem(HIDE_DONE_KEY) !== 'false' // default ON

const NOTES_SEEN_KEY = 'agent-inbox-notes-seen'
const NOTES_SEEN_IDS_KEY = 'agent-inbox-notes-seen-ids'
let notesSeenAt = localStorage.getItem(NOTES_SEEN_KEY) || null
let notesSeenIds = new Set()
try { notesSeenIds = new Set(JSON.parse(localStorage.getItem(NOTES_SEEN_IDS_KEY)) || []) } catch { /* fresh start */ }
// Read-marking used to stamp `now()` unconditionally on every render while the
// Notes tab was open — marking read every note behind the "Show N more" pager
// and every note the rail filter was hiding, none of which the human ever saw.
// notes.js's seenWatermark advances at most to a point below everything that
// stayed hidden, and never backwards.
//
// Issue #31.2 added the second half. The watermark is ONE stamp, so whenever the
// pager hides the oldest note it cannot move at all — six fresh notes with
// PAGE.notes = 5 pinned the tab count at six until they aged out seven days
// later. §8 says the count means "new since you last looked" and tenet 2 forbids
// a count that can only grow, so the per-id set records what was literally on
// screen. The two marks are INDEPENDENT: the id write must NOT sit behind the
// watermark's early return, because "the watermark could not advance" is exactly
// the case the id set exists for. `live` is the GLOBAL note list — it is the
// prune input that keeps the stored set bounded by the 7-day window.
function markNotesSeen(rendered, hidden, live) {
  const next = seenWatermark(rendered, hidden, notesSeenAt)
  if (next && next !== notesSeenAt) {
    notesSeenAt = next
    localStorage.setItem(NOTES_SEEN_KEY, notesSeenAt)
  }
  const ids = markSeenIds(notesSeenIds, rendered, live)
  if (ids.length !== notesSeenIds.size || ids.some((id) => !notesSeenIds.has(id))) {
    notesSeenIds = new Set(ids)
    localStorage.setItem(NOTES_SEEN_IDS_KEY, JSON.stringify(ids))
  }
}

let bootId = null

// ── poll suspension (spec §10) ──────────────────────────────────────────────
// The 3s rebuild is the enemy of every in-progress interaction. It holds while
// a card is open or a draft has content, and lands the moment the user is done.
let openRowId = null    // the single inline-expanded Needs-you row (§4)
let renderDirty = false // fresh data arrived while suspended
let listHover = false   // pointer is over the Needs-you list
let pinnedIds = []      // sort order pinned for this render session
let stagedIds = null    // list membership waiting for mouse-leave
let pressedAt = null    // pointerdown → pointerup, hard-bounded by PRESS_GRACE_MS (#38)

// What SUSPENDS the poll — deliberately not the same set as what DEFERS it.
// `pressedAt` is missing on purpose and must stay missing: showPauseHint() reads
// this, and a held button is not a pause (see initPressGuard).
function suspendState() {
  return {
    expanded: openRowId ? [openRowId] : [],
    drafts: { ...draftReplies, ...draftReplyContexts, ...rowDrafts },
  }
}

// issue #38 (D2). Measured in real Chrome: the 3s rebuild detaches the node the
// human is pressing on, so pointerdown and pointerup share no ancestor and the
// browser dispatches NO click at all — ~1 in 24 at human hold times, on every
// surface. Defer the rebuild for the length of the press and the click lands.
//
// Capture phase, on window, so nothing can stop it before we see it. No resume()
// on release, on purpose: Chrome dispatches pointerup → mouseup → click, so
// rendering from the release handler would rebuild the DOM before `click` and eat
// the very click this exists to protect. The deferred frame lands on the app's own
// next tick (≤3s), which is the cadence the human already sees.
function initPressGuard() {
  window.addEventListener('pointerdown', () => { pressedAt = Date.now() }, true)
  const release = () => { pressedAt = null }
  window.addEventListener('pointerup', release, true)
  window.addEventListener('pointercancel', release, true)
}

// #pauseHint is emitted by the shell (Task 6); this is the only writer
function showPauseHint() {
  const el = document.getElementById('pauseHint')
  if (!el) return
  const hint = renderDirty ? suspendHint(suspendState()) : null
  el.textContent = hint ?? ''
  el.hidden = !hint
}

// the poll's ONLY entry into render()
function renderIfIdle() {
  if (shouldDeferRender({ ...suspendState(), pressedAt }, Date.now())) {
    renderDirty = true
    showPauseHint() // reads suspendState() only — a bare press prints nothing (#38)
    return
  }
  renderDirty = false
  showPauseHint()
  render()
}

// called whenever a suspending condition may have cleared (collapse, draft
// emptied, reply sent)
function resumeRender() {
  if (renderDirty) renderIfIdle()
  else showPauseHint()
}

// USER-INITIATED repaints only, and deliberately OUTSIDE the §10 gate. Together
// with renderIfIdle these are the ONLY two entries into render(): the poll's and
// the human's.
//
// The gate protects the human from the 3s POLL rebuilding the DOM under the
// cursor. It must not also swallow the frame the human's own click just asked
// for — and the gate is GLOBAL, so it will: suspendState() reports ANY expanded
// card and EVERY draft anywhere in the app, so one unrelated question card left
// open, or one half-typed note on another board, silenced the human's own Send /
// Resolve / Archive indefinitely (issue #38). It also cannot serve
// changeAnswer's accepted path at all: that stages a draft, and a draft is itself
// a suspend reason, so renderIfIdle() is GUARANTEED to skip the render that would
// build the input the draft lives in (issue #31.1).
//
// Clearing renderDirty here is not bookkeeping: load() updates `lastData` on every
// tick whether or not it renders, so the frame we just painted IS the newest data
// and #pauseHint must stop claiming otherwise. A direct render() that skips this
// leaves the hint lying in the other direction (#38 / D3).
//
// renderIfIdle() stays the poll's only entry. If this is ever wired into load(),
// the 3s interval or renderIfIdle itself, the gate is gone.
// Naming note: the obvious "render immediately" name belongs to the deleted #now
// strip's render function, and test/shell.test.ts + test/notes.test.ts both
// forbid that identifier as a substring of this file. Hence `forceRender`.
function forceRender() {
  // nine-plus callers now, and a click can beat the first successful load(): a
  // render with no data throws out of applyBadge, OUTSIDE load()'s catch, as an
  // unhandled rejection with no status line.
  if (!lastData) return
  renderDirty = false
  render()
  showPauseHint()
}

// The human's own write ends HERE. The POLL still ends in load()/renderIfIdle().
//
// That one distinction is the whole of issue #38: eight handlers ended a
// successful POST with a bare `load()`, which asks the §10 gate for permission to
// show the human the result of their own click — and the gate, being global,
// refused whenever anything anywhere was expanded or half-typed. The write landed
// (POST 200, row in the DB) and the viewer sat on the stale frame across every
// subsequent poll tick. Awaits load() first so the frame paints the SERVER's
// state, not the pre-write snapshot.
//
// The invariant, in one line: `load()` is the poll's, `reloadAndPaint()` is the
// human's. Pinned as source text in test/shell.test.ts, because no runtime
// assertion can see which of the two a handler picked.
async function reloadAndPaint() {
  await load()
  forceRender()
}

// the single writer of openRowId — Tasks 11/16/17 call this, never assign.
// `resume: false` is for the ONE caller that is already inside render()
// (render()'s own reconciliation, fix round 2 / C1): resuming from there would
// re-enter render(); the next poll tick renders instead, now unsuspended.
function setOpenRow(id, { resume = true } = {}) {
  openRowId = id
  if (resume) resumeRender()
  else showPauseHint()
}

// render() runs its Needs-you entry ids through this: order pins for the
// session, membership stages while the pointer is over the list
function orderedIds(ids) {
  const r = applyListUpdate({ current: pinnedIds, incoming: ids, hovering: listHover })
  pinnedIds = r.ids
  stagedIds = r.staged
  return r.ids
}

function initListStaging() {
  showPauseHint()
  const list = document.getElementById('needsYouList')
  if (!list) return
  list.addEventListener('mouseenter', () => { listHover = true })
  list.addEventListener('mouseleave', () => {
    listHover = false
    if (stagedIds) {
      pinnedIds = pinOrder(pinnedIds, stagedIds)
      stagedIds = null
      forceRender()
    } else {
      resumeRender()
    }
  })
}

async function load() {
  try {
    const res = await fetch('/api/items')
    const boot = res.headers.get('x-inbox-boot')
    if (bootId && boot && bootId !== boot) { location.reload(); return } // server restarted → pick up fresh frontend
    if (boot) bootId = boot
    const g = await res.json()
    const boards = await (await fetch('/api/boards')).json()
    const archived = await (await fetch('/api/boards/archived')).json()
    const activity = await (await fetch('/api/activity')).json()
    // Projects the human closed (issue #32). Defensive on purpose: a viewer that
    // predates this route answers 404 with HTML, a bare .json() would throw into
    // the catch below, and the WHOLE page would read 'disconnected'. An unknown
    // closed set must mean "suppress nothing", never a dead page.
    const closed = await fetch('/api/projects/closed').then((r) => (r.ok ? r.json() : [])).catch(() => [])
    // Cached PR state (issue #30), same defensive shape and for the same reason:
    // an empty links set must mean "render exactly as before this feature", never
    // a dead page. A viewer that predates this route answers 404 with HTML.
    const links = await fetch('/api/links').then((r) => (r.ok ? r.json() : [])).catch(() => [])
    lastData = { g: ageNotes(g, Date.now()), boards, archived, activity, closed, links }
    renderIfIdle()
    if (!bootFocusDone) { bootFocusDone = true; applyFocusHash() }
    document.getElementById('status').textContent = ''
  } catch (err) {
    // an exception thrown inside render() used to be swallowed here with no
    // console signal at all — a completely dead page with nothing to debug.
    // That is exactly the failure mode behind the "none of the buttons work"
    // incident (0 needs-you items → renderEmptyState threw → blank panel,
    // silently). Log it; keep the 'disconnected' status for genuine fetch failures.
    console.error(err)
    document.getElementById('status').textContent = 'disconnected'
  }
}

// fix round 1 (hardening): every write-path fetch used to be a bare `await fetch(...)`
// with no try/catch — a dropped request (offline, server restart mid-click) became an
// unhandled promise rejection: no console signal, no user feedback, and the optimistic
// UI may already have updated as if it worked. That is worse than a visible failure for
// an app whose whole job is not losing the human's action. Mirrors load()'s existing
// catch → console.error + 'disconnected' status pattern; one helper instead of six
// bespoke handlers. Returns the parsed JSON body on success, or null on network failure
// (callers must treat null as "nothing happened, already signaled" and bail out).
async function postJSON(url, body) {
  try {
    const res = await fetch(url, {
      // fix round 2 (I5): a staged ★ is flushed from `beforeunload`, where a
      // plain fetch is routinely cancelled during teardown — the row said
      // "Sent: <label>" and nothing was ever written, leaving the agent blocked.
      // keepalive lets the request outlive the page (spec §5's "fires
      // immediately on tab blur/close").
      keepalive: true,
      method: 'POST',
      ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    })
    // fix round 2 (C4): nothing checked the STATUS. A 500 returns a text body,
    // res.json() throws, the .catch below hands the caller `{}` — and every
    // caller reads that as success and calls load(). A server-side throw on
    // reply/resolve/dismiss/annotate/archive was completely silent. Note this
    // keys on the Response, never on the parsed body: a 200 carrying
    // `{ ok: false }` is the store's legitimate reply refusal (changeAnswer
    // reads that itself) and must NOT be swallowed here.
    if (!res.ok) {
      console.error(`POST ${url} failed: HTTP ${res.status}`)
      document.getElementById('status').textContent = `write failed (${res.status})`
      return null
    }
    return await res.json().catch(() => ({}))
  } catch (err) {
    console.error(`POST ${url} failed`, err)
    document.getElementById('status').textContent = 'disconnected'
    return null
  }
}

// fix round 2 (C3): a failed write used to silently discard what the human
// typed — the draft was deleted BEFORE the POST, and #status's "disconnected"
// is wiped by the next successful poll ≤3s later, so the typed answer vanished
// with no trace at all. The draft now outlives the failure and the REASON parks
// here, beside Send, until the next attempt: a persistent inline slot, never
// the auto-clearing status line.
const writeErrors = {} // item/row id → last write failure, shown beside its Send

function writeErrorEl(id) {
  const el = document.createElement('span')
  el.className = 'write-error'
  el.dataset.errorFor = id
  el.textContent = writeErrors[id] ?? '' // never innerHTML — this text is rendered beside agent-authored content
  el.hidden = !writeErrors[id]
  return el
}

// Also paints into the slot already on screen: a restored draft suspends the
// poll (spec §10), so waiting for the next render would show the human nothing.
function showWriteError(id, msg) {
  if (msg) writeErrors[id] = msg
  else delete writeErrors[id]
  for (const el of document.querySelectorAll(`.write-error[data-error-for="${CSS.escape(id)}"]`)) {
    el.textContent = msg
    el.hidden = !msg
  }
}

const WRITE_FAILED = 'Not sent — nothing was lost; press Send to retry.'

function allItems(g) {
  return [...g.needsYou.flatMap((x) => x.items), ...g.notes.flatMap((x) => x.items), ...g.done]
}

const BASE_TITLE = 'Agent Inbox'

// The document-title badge is GLOBAL — filters narrow the list, never the
// signal (spec §7). Zero attention ⇒ the bare title, so the badge can rest.
// This is the ONLY writer of document.title in the product.
//
// The closed set (issue #32) is NOT a filter and does not violate that: a filter
// is a temporary lens the human is looking through, while a close is the human
// retiring a project outright. It is passed to the ONE predicate rather than
// subtracted here, so the dock badge, the rail's All row, the Needs-you count
// and the triage deck cannot disagree about it (tenet 3).
function applyBadge() {
  const live = new Set((lastData.activity ?? []).map((a) => a.session))
  const n = attentionCount(allItems(lastData.g), lastData.boards, Date.now(), live, lastData.closed ?? [])
  document.title = titleWithBadge(BASE_TITLE, n)
}

// The rendered Needs-you row for an id, or null. `openRowId` may only ever name
// something this returns — see focusItem and render()'s reconciliation (C1).
function needsYouRowEl(id) {
  return document.querySelector(`#needsYouList .nrow[data-card-id="${CSS.escape(id)}"]`)
}

// Which tab holds an item — a deep link must land on the right one.
function tabForItem(it) {
  if (lastData.g.notes.some((gr) => gr.items.some((x) => x.id === it.id))) return 'notes'
  if (lastData.g.done.some((x) => x.id === it.id)) return 'done'
  return 'needsYou'
}

// Notification click / URL hash entry point (spec §11): select the item's
// project, switch to its tab, expand it, scroll to it.
function focusItem(id) {
  if (!lastData) return
  const item = allItems(lastData.g).find((i) => i.id === id)
  const board = [...lastData.boards, ...lastData.archived].find((b) => b.id === id)
  const target = item ?? board
  if (!target) return
  projectFilter = target.project
  localStorage.setItem(PROJECT_KEY, target.project)
  agentFilter = null
  localStorage.removeItem(FILTER_KEY)
  selectTab(board ? 'boards' : tabForItem(item)) // Task 8: sets activeTab AND shows the panel
  const hash = focusHashFor(id)
  if (location.hash !== hash) location.hash = hash // survives reload
  forceRender()
  // fix round 2 (C1): this used to call setOpenRow(id) for EVERY target. The
  // accordion is a Needs-you affordance — `toggleRow` is the only thing that
  // clears openRowId and it is reachable only from a rendered `.nrow`. A board
  // id (electron/main.cjs deep-links a blocked row with focusHashFor(board.id),
  // one notification click away) or a notes/done item id has none, so
  // shouldSuspendRender() stayed true forever: load() kept updating lastData
  // while the DOM, all four tab counts and document.title froze, and Escape's
  // `collapse` intent no-op'd against a `.nrow` that never existed. Claim the
  // accordion only once the target has actually landed in the list — render()
  // above put it there — then render again so the card body mounts under it.
  if (needsYouRowEl(id)) { setOpenRow(id); forceRender() }
  requestAnimationFrame(() => {
    const el = document.querySelector(`[data-card-id="${CSS.escape(id)}"]`)
    if (!el) return
    // Open every ancestor <details> fold on the way up, not just the target —
    // a deep link that lands on the right tab but leaves the target buried
    // inside a collapsed stale-fold/archived-fold LOOKS like it worked while
    // showing nothing, which is worse than doing nothing. Flip the matching
    // module flag too: the next 3s poll rebuilds these folds from
    // staleFoldOpen/showArchived, and a DOM-only open doesn't survive that
    // rebuild (the same persistence trap already fixed once for the stale
    // fold in isolation).
    for (let node = el; node; node = node.parentElement) {
      if (node.tagName !== 'DETAILS') continue
      node.open = true
      if (node.classList.contains('stale-fold')) staleFoldOpen = true
      if (node.classList.contains('archived-fold')) showArchived = true
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    if (typeof el.focus === 'function') el.focus({ preventScroll: true })
  })
}

let bootFocusDone = false

function applyFocusHash() {
  const f = parseFocusHash(location.hash)
  if (f) focusItem(f.id)
}

function initFocusHash() {
  window.addEventListener('hashchange', applyFocusHash)
}

// notes age into Done after NOTE_AGE_MS (spec §8) — done at the door so the
// Notes tab, the Done tab and search all agree
function ageNotes(g, nowMs) {
  const aged = []
  const notes = g.notes
    .map((gr) => {
      const part = partitionNotes(gr.items, nowMs)
      aged.push(...part.aged)
      return { ...gr, items: part.fresh }
    })
    .filter((gr) => gr.items.length > 0)
  return { ...g, notes, done: [...g.done, ...aged] }
}

// the CURRENT server state for an item, not a row's closed-over render-time snapshot.
// fix round 1: the star Undo fallback must decide canUndo/undoRefusal off fresh data —
// a row that hasn't re-rendered since staging still reads reply_seen_at as null even
// after the agent has picked the reply up, which would otherwise fall through to
// changeAnswer() and silently revert an already-seen answer. (src/store.ts's replyItem
// is the authoritative guard against that; this is what makes the refusal visible in
// the common case instead of relying on the server round-trip alone.)
function freshItem(id) {
  return lastData ? allItems(lastData.g).find((i) => i.id === id) : undefined
}

function collectAgents({ g, boards }) {
  return [...new Set([...allItems(g).map((i) => i.agent), ...boards.map((b) => b.agent)])].sort()
}

// Closed projects drop out of the DEFAULT view — UNLESS the human has explicitly
// selected one from the rail's closed fold. An explicit ask is not "the default
// view", so peeking must never require reopening first (issue #32); the banner
// renderClosedBanner() puts above the panel is what keeps that peek honest about
// the badge deliberately not counting what is on screen.
//
// Mirrors filterData's shape: whole project GROUPS leave needsYou/notes, while
// g.done/boards/archived are flat lists filtered by x.project.
function withoutClosed({ g, boards, archived }) {
  const closed = closedSet()
  if (!closed.size) return { g, boards, archived }
  const hide = (p) => closed.has(p) && p !== projectFilter
  const keep = (x) => !hide(x.project)
  return {
    g: {
      needsYou: g.needsYou.filter((gr) => !hide(gr.project)),
      notes: g.notes.filter((gr) => !hide(gr.project)),
      done: g.done.filter(keep),
    },
    boards: boards.filter(keep),
    archived: archived.filter(keep),
  }
}

// the slice of the data matching only the project filter — agent tabs derive
// from this, so switching project shows just that project's agents
function projectScoped({ g, boards, archived }) {
  if (!projectFilter) return { g, boards, archived }
  const keep = (x) => x.project === projectFilter
  return {
    g: { needsYou: g.needsYou.filter(keep), notes: g.notes.filter(keep), done: g.done.filter(keep) },
    boards: boards.filter(keep),
    archived: archived.filter(keep),
  }
}

function render() {
  applyBadge()
  // issue #30 — rebuilt ONCE here, before any renderer runs, so the row chips,
  // the card blocks and the board chips all read the same snapshot. It feeds
  // nothing in applyBadge / attentionCount on purpose: PR state is ambient, and
  // a red CI must never move the badge (tenets 1 and 2).
  linkIndex = indexLinks(lastData.links ?? [])
  // projectMatchCounts stays fed the GLOBAL lastData, unscoped by the rail
  // filter, on purpose: it's how the user discovers a match sitting behind a
  // DIFFERENT project pill than the one currently selected — including one
  // behind a CLOSED project, which is what the fold's auto-open rule keys on.
  //
  // Hoisted out of render() to the module binding (issue #32) so renderRail can
  // read it. It is an ASSIGNMENT, never a `const`: a function-scoped declaration
  // here is legal JS that silently shadows the module binding, leaving renderRail
  // reading an empty Map forever and §12's confident false negative sealed inside
  // a collapsed fold. It must be computed BEFORE renderRail for the same reason.
  projMatches = projectMatchCounts(lastData, searchQuery, fuzzyFilter)
  renderRail()
  // AFTER renderRail: renderRail is what reconciles a stale projectFilter, and
  // withoutClosed reads projectFilter to decide whether this is a peek.
  visibleData = withoutClosed(lastData)
  renderClosedBanner()
  const agents = collectAgents(projectScoped(visibleData))
  if (agentFilter && !agents.includes(agentFilter)) agentFilter = null
  renderAgentSelect(agents)
  // prune collapse state against ALL cards, not the filtered view (nor the
  // closure-narrowed one), so switching tabs never drops state for cards the
  // filter is hiding
  liveCardIds = new Set([...allItems(lastData.g).map((i) => i.id), ...lastData.boards.map((b) => b.id), ...lastData.archived.map((b) => b.id)])
  const filtered = filterData(visibleData)
  const { g, boards, archived } = applySearch(filtered)
  const pillLive = (lastData.activity ?? []).filter((a) =>
    (!projectFilter || a.project === projectFilter) && (!agentFilter || a.agent === agentFilter))
  // fix round 1: counts feed off the project/agent-SCOPED data (`filtered` +
  // `pillLive`), matching what render() actually shows — NOT raw `lastData`.
  // Feeding raw data let a match hidden behind the active rail filter still
  // count as "reachable" (its tab badge lit up, and its absence elsewhere
  // silenced the "elsewhere" pointer), which is the same confident-false-
  // negative spec §12 exists to kill, just reached through the project axis
  // instead of the tab axis. Still deliberately NOT search-scoped (a tab
  // count can't depend on itself) and NOT tab-scoped (the whole point).
  const scopedForCounts = { g: filtered.g, boards: filtered.boards, archived: filtered.archived, activity: pillLive }
  matchCounts = tabMatchCounts(scopedForCounts, searchQuery, fuzzyFilter)
  for (const [tab, n] of Object.entries(matchCounts)) setTabMatch(tab, n)
  // setRailMatch must stay AFTER renderRail: renderRail does host.innerHTML = '',
  // so painting match counts before it would wipe every one of them.
  const railProjectKeys = railProjects({
    items: allItems(lastData.g), boards: lastData.boards, archived: lastData.archived, activity: lastData.activity,
  })
  for (const p of railProjectKeys) setRailMatch(p, projMatches.get(p) ?? 0)
  // search filters Live too: match a session on what it's doing (+ its children),
  // reusing searchMatches by mapping each session onto a haystack-shaped entity
  const liveMatched = searchMatches(pillLive.map(liveEntity), searchQuery, fuzzyFilter)
  const live = liveMatched ? pillLive.filter((a) => liveMatched.has(a.session)) : pillLive
  renderLive(live)                          // drawer's expanded list — stays FILTERED (rail-scoped, like every other tab)
  renderLiveBar(lastData.activity ?? [])    // collapsed strip — GLOBAL, never scoped (§7 filter-blindness, generalized)
  renderNeedsYou(g, boards, Date.now())
  renderGroups('notes', g.notes)
  renderDone(g.done)
  renderBoards(boards, archived)
  // Needs-you counts the GLOBAL attention set; every other tab counts the
  // filtered view the user is actually looking at (spec §7)
  const counts = tabCounts({
    globalAttention: attentionCount(allItems(lastData.g), lastData.boards, Date.now(), liveSessionIds(), lastData.closed ?? []),
    unreadNotes: unreadNoteCount(g.notes.flatMap((gr) => gr.items), notesSeenAt, Date.now(), notesSeenIds),
    scoped: { boards, done: g.done },
  })
  for (const id of TAB_IDS) setCount(id, counts[id])
  pruneCollapsedCards()
  // fix round 2 (C1, layer 2 — the one that closes the bug class). openRowId
  // feeds shouldSuspendRender(), but its only clearing path is toggleRow, a DOM
  // affordance that exists only for rows this render actually produced. Any
  // writer that names something else (a deep-linked board id, a row the rail
  // filter or the pager just removed) would otherwise suspend the poll
  // permanently. The render that just happened is the authority on what is
  // still collapsible; reconcileOpenRow (poll.js, unit-tested) is the rule.
  const nextOpen = reconcileOpenRow(openRowId, rowEls().map((el) => el.dataset.cardId))
  // still through setOpenRow — it stays the single writer of openRowId
  if (nextOpen !== openRowId) setOpenRow(nextOpen, { resume: false })
  renderTriage() // keep the open lightbox in sync with fresh data
}

// one age vocabulary for every surface (§6): rows, chips, Live and tooltips all
// format through relMs()
function rel(iso) {
  return relMs(Date.now() - Date.parse(iso))
}

// ── triage mode: step through the needs-input set one card at a time ──
let triageDeck = null // { entries, index } while the lightbox is open
const rowDrafts = {}  // in-progress row annotations, surviving the poll rebuild
let rowFocusId = null

// fix round 2 (I1): the deck used to run a SECOND attention predicate of its own
// (`!i.reply` for questions, `status === 'blocked'` for rows), so it included
// stale items and blocked rows the human had already annotated and the agent had
// already seen — badge 0, calm panel saying "Nothing needs you", then a deck
// reading "1 of 5". Spec §7 tenet 3 names the deck explicitly: the dock badge,
// the rail badges, the Needs-you tab count AND the deck all derive from ONE
// predicate. This was the last place that was untrue. Ordering (longest-waiting
// questions first, blocked rows after) is presentation, not a predicate.
// issue #32: the same suppressed set the badge reads. Tenet 3 names the deck
// explicitly, so a closed project's items must not resurface here either.
function buildDeck() {
  const entries = attentionEntries(allItems(lastData.g), lastData.boards, Date.now(), liveSessionIds(), lastData.closed ?? [])
  const qs = entries.filter((e) => e.kind === 'item')
    .sort((a, b) => (a.item.created_at < b.item.created_at ? -1 : 1))
  const rows = entries.filter((e) => e.kind === 'row')
  return [
    ...qs.map((e) => ({ type: 'q', id: e.item.id })),
    ...rows.map((e) => ({ type: 'row', boardId: e.board.id, rowId: e.row.id })),
  ]
}

// resolve a deck entry against the LATEST data; null = no longer needs input.
// Re-validated through the SAME shared predicates the deck was built from, so
// an entry drops out exactly when it stops needing the human — answered,
// resolved, dismissed, or (for a row) annotated and picked up.
function findEntryData(e) {
  if (e.type === 'q') {
    const it = allItems(lastData.g).find((i) => i.id === e.id)
    return it && isAskingQuestion(it) ? { it } : null
  }
  const b = lastData.boards.find((x) => x.id === e.boardId)
  const r = b?.rows.find((x) => x.id === e.rowId && isBlockedRowAttention(x))
  return r ? { b, r } : null
}

function openTriage() {
  triageDeck = { entries: buildDeck(), index: 0 }
  renderTriage()
}

function closeTriage() {
  triageDeck = null
  document.getElementById('lightbox').hidden = true
}

function triageRemoveCurrent() {
  triageDeck.entries.splice(triageDeck.index, 1)
  renderTriage()
}

// rows the user expanded in the matrix (context + answer panel), by row id —
// the board DOM is rebuilt every poll, so open state lives out here.
//
// It is NEVER pruned, and it must never be fed to the §10 gate (issue #38). A
// stale id here renders nothing and costs nothing; a stale id in suspendState()
// freezes the whole viewer forever, which is exactly the C1 bug reconcileOpenRow
// exists to close. Unlike openRowId this is an unbounded, multi-open Set with no
// single-open discipline and no reconciliation, strandable by board pagination,
// the archived fold, the rail filter, hideCompleted and any agent board_upsert
// that drops a row — so it is the LAST state in the app that should gate a
// render. What the boards panel actually needed is the press guard (initPressGuard).
const openRows = new Set()

// The ONE write path for a row annotation — single-line input, no window.prompt.
// Shared by the boards matrix and the triage card (spec §7).
function rowAnswerEl(b, r, onSaved) {
  const row = document.createElement('div')
  row.className = 'reply-row'
  const input = document.createElement('input')
  input.className = 'reply-input'
  input.placeholder = r.status === 'blocked' ? 'tell the agent how to proceed…' : 'your note on this row…'
  input.value = rowDrafts[r.id] ?? ''
  input.addEventListener('input', () => { rowDrafts[r.id] = input.value; resumeRender() })
  input.addEventListener('focus', () => { rowFocusId = r.id })
  // The focus token is STICKY — set on focus, cleared only by a successful send —
  // and every rebuild re-focuses from it. That already stole the caret back on any
  // unsuspended poll tick; issue #38's forced frames make it reachable while
  // suspended too (Send on one card would yank the cursor into a board-row input
  // the human touched minutes ago). Release it when the human leaves an EMPTY box:
  // a real draft still gets its cursor back, which is what the token is for.
  input.addEventListener('blur', () => { if (rowFocusId === r.id && !input.value) rowFocusId = null })
  const save = async () => {
    const typed = input.value
    if (!typed.trim()) return
    // fix round 2 (C3): the draft used to be dropped BEFORE the POST, so a
    // dropped request (viewer server restarted — routine for the Electron app)
    // erased the human's note with no trace. Clear only once it landed.
    const res = await postJSON(`/api/boards/${b.id}/rows/${r.id}/annotate`, { text: typed.trim() })
    if (res === null) {
      rowDrafts[r.id] = typed
      showWriteError(r.id, WRITE_FAILED)
      resumeRender()
      return
    }
    delete rowDrafts[r.id]
    if (rowFocusId === r.id) rowFocusId = null
    showWriteError(r.id, '')
    // the row stays blocked until the agent picks the note up — the human's part
    // is done, so the caller decides what to drop
    onSaved?.()
    // issue #38, the reported surface: a bare load() here was gated, and the gate
    // is global — one unrelated card expanded anywhere and this write showed the
    // human nothing at all, box still full, ready to send the same string twice.
    await reloadAndPaint()
  }
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save() })
  row.appendChild(input)
  row.appendChild(btn('Send', save))
  row.appendChild(writeErrorEl(r.id))
  if (rowFocusId === r.id) requestAnimationFrame(() => {
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
  })
  return row
}

// The human's answer on a row, plus whether anyone collected it (issue #37) —
// the rows-shaped twin of the item reply block's pickup marker, and the same
// vocabulary. It lives in ONE function so the marker can never be printed for a
// row that has no annotation to show, and so the matrix, the accordion card and
// the triage card cannot drift apart about what "delivered" means.
//
// "delivered", not "read": the stamp records only that the text was handed to an
// agent. The acknowledgement is the agent flipping the row's status, which is
// why an annotated row stays on screen until it does.
function rowAnnotationHtml(r) {
  if (!r.annotation) return ''
  const mark = r.annotation_seen_at
    ? `<span class="pickup picked">✓ delivered${r.annotation_seen_by ? ` to ${esc(r.annotation_seen_by)}` : ''} ${esc(rel(r.annotation_seen_at))} ago</span>`
    : '<span class="pickup awaiting">● waiting for agent pickup</span>'
  return `<div class="annotation">📝 ${esc(r.annotation)}${mark}</div>`
}

// the inline expansion under a matrix row: long context + existing annotation + answer
function rowPanelEl(b, r, readOnly = false) {
  const wrap = document.createElement('div')
  wrap.className = 'row-panel'
  wrap.innerHTML = `
    ${r.context ? `<div class="row-context-body">${esc(r.context)}</div>` : ''}
    ${rowAnnotationHtml(r)}`
  if (!readOnly) wrap.appendChild(rowAnswerEl(b, r))
  return wrap
}

// `rowCardEl` mounts in TWO places: the triage lightbox (where `triageDeck` is
// open) and, since Task 11, the inline Needs-you accordion (where it is `null`).
// Guard the onSaved callback here, at the definition, so neither call site has
// to know which context it is in — answering a blocked row from the list must
// not throw just because there is no deck to remove it from.
function rowCardEl(b, r) {
  const wrap = document.createElement('div')
  wrap.className = 'lb-row-card'
  wrap.innerHTML = `
    <div class="meta">🚧 blocked row · ${esc(b.title)} <span class="board-id">#${esc(b.id.slice(0, 6))}</span></div>
    <div class="title">${esc(r.label)}</div>
    ${r.note ? `<div class="detail">${esc(r.note)}</div>` : ''}
    ${r.context ? `<div class="detail lb-context">${esc(r.context)}</div>` : ''}
    ${rowAnnotationHtml(r)}`
  wrap.appendChild(rowAnswerEl(b, r, () => { if (triageDeck) triageRemoveCurrent() }))
  return wrap
}

function renderTriage() {
  if (!triageDeck) return
  const lb = document.getElementById('lightbox')
  // drop entries resolved elsewhere (or answered in a previous card)
  triageDeck.entries = triageDeck.entries.filter((e) => findEntryData(e))
  const n = triageDeck.entries.length
  triageDeck.index = Math.max(0, Math.min(triageDeck.index, n - 1))
  const card = lb.querySelector('.lb-card')
  card.innerHTML = ''
  if (n === 0) {
    lb.querySelector('.lb-count').textContent = 'all clear'
    card.innerHTML = '<div class="lb-clear">✓ All clear — nothing needs you.</div>'
  } else {
    lb.querySelector('.lb-count').textContent = `${triageDeck.index + 1} of ${n}`
    const data = findEntryData(triageDeck.entries[triageDeck.index])
    if (data.it) {
      card.appendChild(itemCardEl(data.it, {
        nowMs: Date.now(),
        liveness: classifyLiveness(data.it, Date.now(), liveSessionIds()),
      }))
    } else {
      card.appendChild(rowCardEl(data.b, data.r))
    }
  }
  lb.querySelector('.lb-prev').disabled = triageDeck.index <= 0
  lb.querySelector('.lb-next').disabled = triageDeck.index >= n - 1
  lb.hidden = false
}

function initTriage() {
  const lb = document.getElementById('lightbox')
  lb.querySelector('.lb-close').addEventListener('click', closeTriage)
  lb.querySelector('.lb-backdrop').addEventListener('click', closeTriage)
  lb.querySelector('.lb-prev').addEventListener('click', () => { triageDeck.index--; renderTriage() })
  lb.querySelector('.lb-next').addEventListener('click', () => { triageDeck.index++; renderTriage() })
  // keyboard (Esc/ArrowLeft/ArrowRight/t) is owned by initKeys (Task 17) —
  // one handler for the list AND the deck so the two can never drift apart
}

function jumpToCard(tabId, cardId) {
  selectTab(tabId)
  const card = document.querySelector(`[data-card-id="${CSS.escape(cardId)}"]`)
  if (!card) return
  if (card instanceof HTMLDetailsElement) card.open = true
  card.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function setCount(id, n) {
  if (n == null) return
  const el = document.querySelector(`.tab[data-tab="${id}"] .tab-count`)
  if (!el) return
  el.textContent = n ? String(n) : ''
  el.hidden = !n
}

// the whole-dataset per-tab match tally (spec §12) — read by emptyMsg so a tab
// can point at where a search's hits actually are
let matchCounts = { needsYou: null, boards: null, live: null, notes: null, done: null }

// a small "N" beside a tab label — how many matches hide behind THAT tab
function setTabMatch(tab, n) {
  const el = document.querySelector(`#tabs .tab[data-tab="${tab}"]`)
  if (!el) return
  let badge = el.querySelector('.match-count')
  if (n === null || n === 0) { badge?.remove(); return }
  if (!badge) {
    badge = document.createElement('span')
    badge.className = 'match-count'
    el.appendChild(badge)
  }
  badge.textContent = String(n)
}

// the rail row already ships an empty <span class="rail-match"> (Task 7) — this
// only fills it in, so the rail's own markup stays the single source of truth
function setRailMatch(project, n) {
  const el = document.querySelector(`#rail button.rail-tab[data-project="${CSS.escape(project)}"] .rail-match`)
  if (!el) return
  el.textContent = n ? String(n) : ''
  el.hidden = !n
}

// project selection persists (Task 7); the active tab deliberately does not
let activeTab = DEFAULT_TAB

// single routing entry point: state + DOM together, so no caller can set one
// without the other
function selectTab(id) {
  if (!TAB_IDS.includes(id)) return
  activeTab = id
  for (const t of document.querySelectorAll('#tabs .tab')) {
    t.setAttribute('aria-selected', String(t.dataset.tab === id))
    t.tabIndex = t.dataset.tab === id ? 0 : -1 // roving tabindex (spec §13)
  }
  showPanel(id)
}

function initTabs() {
  for (const t of document.querySelectorAll('#tabs .tab')) {
    t.addEventListener('click', () => selectTab(t.dataset.tab))
  }
  selectTab(activeTab)
  wireTablist(document.getElementById('tabs'), 'horizontal')
}

function filterData({ g, boards, archived }) {
  const pf = projectFilter
  const af = agentFilter
  if (!pf && !af) return { g, boards, archived }
  const keepItem = (i) => (!pf || i.project === pf) && (!af || i.agent === af)
  const keepBoard = (b) => (!pf || b.project === pf) && (!af || b.agent === af)
  const only = (groups) => groups
    .filter((gr) => !pf || gr.project === pf)
    .map((gr) => ({ ...gr, items: gr.items.filter((i) => !af || i.agent === af) }))
    .filter((gr) => gr.items.length > 0)
  return {
    g: { needsYou: only(g.needsYou), notes: only(g.notes), done: g.done.filter(keepItem) },
    boards: boards.filter(keepBoard),
    archived: archived.filter(keepBoard),
  }
}

// narrow the pill-filtered data to the fuzzy-search matches (composes AND with
// the project/agent pills). No query → returned unchanged.
function applySearch({ g, boards, archived }) {
  const matches = searchMatches([...allItems(g), ...boards, ...archived], searchQuery, fuzzyFilter)
  if (!matches) return { g, boards, archived }
  const keep = (x) => matches.has(x.id)
  const only = (groups) => groups
    .map((gr) => ({ ...gr, items: gr.items.filter(keep) }))
    .filter((gr) => gr.items.length > 0)
  return {
    g: { needsYou: only(g.needsYou), notes: only(g.notes), done: g.done.filter(keep) },
    boards: boards.filter(keep),
    archived: archived.filter(keep),
  }
}

const TAB_LABEL = { needsYou: 'Needs you', boards: 'Boards', live: 'Live', notes: 'Notes', done: 'Done' }

// the §12 pointer on its own: "<span>2 in Boards · 1 in Notes</span>", or ''.
// Interpolates ONLY the fixed TAB_LABEL strings and integers — never agent text
// — which is what makes it safe to hand straight to innerHTML. tabsearch.js's
// elsewhereLabel is the unit-tested builder both callers share.
function elsewhereMsg() {
  const where = elsewhereLabel(matchCounts, activeTab, TAB_LABEL)
  return where ? `<span class="match-elsewhere">${where}</span>` : ''
}

// section empty-state text: search-aware, and never a BARE "no matches" — it
// always points at the tabs that do have hits (spec §12)
function emptyMsg(base) {
  const q = searchQuery.trim()
  if (!q) return base
  const where = elsewhereMsg()
  return `No matches for &ldquo;${esc(q)}&rdquo; here${where ? ` — ${where}` : ' or in any other tab'}`
}

const liveSessionIds = () => new Set((lastData.activity ?? []).map((a) => a.session))
// projects the human retired (issue #32) — server state, not localStorage, so the
// Electron dock badge (a different OS process) reads the very same set
const closedSet = () => new Set(lastData.closed ?? [])
const themeName = () => (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')

// spec §2: color persistence. Every caller that paints a project dot/wash goes
// through THIS, never projectColor() directly — passing localStorage is what
// lets assignedHue() persist a hue across reloads and nudge a collision once,
// instead of re-hashing (and potentially re-colliding) on every render.
const pcolor = (name) => projectColor(name, themeName(), localStorage)

// typed rail filter; only rendered when the rail is long enough to need it
let railQuery = ''

// ── closed projects (issue #32) ─────────────────────────────────────────────
// The fold's open state lives out here for the same reason staleFoldOpen does:
// the 3s poll rebuilds the rail, and a DOM-only <details open> would silently
// re-collapse under the human mid-read.
let closedFoldOpen = false
// lastData minus the closed projects — what the DEFAULT view may show. Set once
// per render(), read by every panel renderer that must agree with the badge.
let visibleData = null
// Hoisted out of render() so renderRail's fold-open rule can consult it. See the
// long note at its assignment: making this a local `const` again is a silent
// break, not a loud one.
let projMatches = new Map()

// ── responsive (spec §14) ────────────────────────────────────────────────────
// Pure breakpoint check lives in layout.js; this is just the mode + the media
// query that keeps it live. renderRail reads `layout` to decide whether the
// rail shows full project names or collapses to monogram dots.
let layout = layoutMode(window.innerWidth)

function initResponsive() {
  const mq = window.matchMedia(`(max-width: ${NARROW_MAX}px)`)
  const apply = () => {
    const next = mq.matches ? 'narrow' : 'wide'
    if (next === layout) return
    layout = next
    if (lastData) forceRender() // the rail's labels change shape, so rebuild it
  }
  mq.addEventListener('change', apply)
  apply()
}

// The × / ↩ affordance on a rail row (issue #32).
//
// tabIndex = -1 is deliberate: §13 promises "exactly one project tab is
// tabbable", and N focusable close buttons in a rail of N projects would bury
// the tablist under tab stops. The keyboard path is Delete/Backspace on the
// focused tab instead — the convention every browser tab strip uses — wired in
// railRowEl below. Both buttons are hidden under 900px (see the @media block);
// implicit reopen-on-new-activity works at every width, so nothing an agent
// needs ever becomes unreachable.
function railActionEl(e, closed) {
  const a = document.createElement('button')
  a.type = 'button'
  a.tabIndex = -1
  a.className = closed ? 'rail-reopen' : 'rail-close'
  a.textContent = closed ? '↩' : '×'
  // setAttribute escapes; a project name is agent-authored and must NEVER be
  // interpolated into innerHTML
  a.setAttribute('aria-label', `${closed ? 'Reopen' : 'Close'} project ${e.label}`)
  a.title = closed
    ? 'Reopen — bring this project back into the rail and the badge'
    : 'Close — it comes back the moment an agent flags into it'
  a.addEventListener('click', () => { closed ? reopenProjectAction(e.key) : closeProjectAction(e.key) })
  return a
}

// ONE row builder for both the open rail and the closed fold, so the two can
// never drift apart.
//
// The tab and its action button are SIBLINGS inside a wrapper div, never nested:
// `.rail-tab` is itself a `<button role="tab">`, and a button may not contain
// interactive content (invalid HTML, and the roving-tabindex loop at the foot of
// renderRail only governs `.rail-tab`). The codebase's own precedent is
// `.nrow-dismiss` inside `div.nrow`. setRailMatch's
// `#rail button.rail-tab[data-project=…] .rail-match` selector is a descendant
// selector, so it keeps working through the wrapper and into the fold for free.
function railRowEl(e, { withFilter, closed = false }) {
  const wrap = document.createElement('div')
  wrap.className = 'rail-row'
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'rail-tab'
  b.dataset.project = e.key // '__all__' for the unfiltered view
  b.setAttribute('role', 'tab')
  const selected = e.key === '__all__' ? !projectFilter : projectFilter === e.key
  b.setAttribute('aria-selected', String(selected))
  if (!e.total) b.classList.add('quiet')
  const color = e.key === '__all__' || e.unknown ? null : pcolor(e.key)
  if (e.unknown) b.classList.add('unknown')
  // the full name always stays reachable on title/aria-label — the unknown
  // hint wins there, everyone else gets their project name — so the tab is
  // still identifiable even once the narrow rail shrinks its visible text
  // down to a monogram (§2: colour is never the only carrier).
  b.title = e.unknown ? 'Project inference failed for these agents — a register() call fixes their scope.' : e.label
  b.setAttribute('aria-label', e.label)
  // selection is a soft wash of the project's own color; no stripe anywhere
  if (selected && color) b.style.background = color.wash
  const dot = document.createElement('span')
  dot.className = e.key === '__all__' ? 'rail-dot all' : 'rail-dot'
  if (color) dot.style.background = color.dot
  const name = document.createElement('span')
  name.className = 'rail-name'
  // narrow rail collapses to the monogram — UNLESS the type-to-narrow filter
  // is showing (>12 projects, RAIL_FILTER_THRESHOLD in rail.js): the CSS
  // widens #rail back out and restores row layout for exactly that case
  // (see the #rail:has(.rail-filter) block in style.css), so keep full
  // names here too — a column of monograms next to a search box you can't
  // read the results of would defeat the point of un-hiding the filter.
  // textContent, never innerHTML — agent-authored project names.
  name.textContent = railLabel(e.label, withFilter ? 'wide' : layout)
  const badge = document.createElement('span')
  // a closed row is never escalated (closedRailEntries pins escalated: 0) —
  // red is an alarm, and a project the badge is ignoring must not alarm
  badge.className = e.escalated ? 'rail-badge escalated' : 'rail-badge'
  badge.textContent = e.total ? String(e.total) : ''
  badge.hidden = !e.total
  badge.title = e.escalated ? `${e.escalated} escalated` : `${e.total} waiting on you`
  // always present, always empty here — Task 15's search paints match counts in
  const match = document.createElement('span')
  match.className = 'rail-match'
  b.append(dot, name, badge, match)
  b.addEventListener('click', () => {
    projectFilter = e.key === '__all__' ? null : e.key
    if (projectFilter) localStorage.setItem(PROJECT_KEY, projectFilter)
    else localStorage.removeItem(PROJECT_KEY)
    resetPaging()
    forceRender()
  })
  // the keyboard half of close/reopen, since the button itself is out of the tab
  // order. `ev` is the keyboard event; `e` is the rail entry — do not merge them.
  if (e.key !== '__all__') b.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Delete' && ev.key !== 'Backspace') return
    ev.preventDefault()
    closed ? reopenProjectAction(e.key) : closeProjectAction(e.key)
  })
  wrap.appendChild(b)
  // 'All' is not a project and cannot be retired
  if (e.key !== '__all__') wrap.appendChild(railActionEl(e, closed))
  return wrap
}

// The closed fold: retired projects, still one click from coming back.
//
// `count` and `suppressed` are BOTH computed from the unfiltered closed list —
// feeding one a rail-query-narrowed list and the other not would print two
// numbers drawn from different populations, and that muted number is the entire
// honesty valve the badge-suppression decision rests on.
function closedFoldEl(entries, count, suppressed, open, withFilter) {
  const fold = document.createElement('details')
  fold.className = 'closed-fold'
  fold.setAttribute('role', 'group')
  fold.setAttribute('aria-label', 'Closed projects')
  fold.open = open
  fold.addEventListener('toggle', () => { closedFoldOpen = fold.open })
  const summary = document.createElement('summary')
  const label = closedFoldLabel(count, suppressed, withFilter ? 'wide' : layout)
  summary.textContent = label.text // textContent, never innerHTML
  summary.title = label.hint
  if (label.muted) {
    const m = document.createElement('span')
    m.className = 'closed-muted'
    m.textContent = label.muted
    summary.appendChild(m)
  }
  fold.appendChild(summary)
  for (const e of entries) fold.appendChild(railRowEl(e, { withFilter, closed: true }))
  return fold
}

// The peek banner (issue #32). While you are looking at a closed project the
// list on screen deliberately holds rows no count includes — two numbers
// disagreeing with no explanation is exactly what tenets 2/3 forbid. So say it
// out loud, with the one-click reversal right there. Rendered from render()
// above the panel host rather than inside renderNeedsYou, so Boards, Notes and
// Done explain themselves too.
function renderClosedBanner() {
  const content = document.querySelector('.content')
  if (!content) return
  content.querySelector('.closed-banner')?.remove()
  if (!projectFilter || !closedSet().has(projectFilter)) return
  const name = projectFilter // captured: a later render may have moved it on
  const bar = document.createElement('div')
  bar.className = 'closed-banner'
  const text = document.createElement('span')
  // textContent — project names are agent-authored
  text.textContent = `${name} is closed — these items are not counted in your badge or triage deck.`
  const reopen = btn('Reopen', () => reopenProjectAction(name))
  reopen.className = 'closed-reopen'
  bar.append(text, reopen)
  content.insertBefore(bar, content.querySelector('main'))
}

// Projects as vertical tabs: color dot · name · per-project attention badge ·
// an empty match slot the search fills in later. The badges are per-project by
// design; the dock badge and the Needs-you tab count stay global (spec §7
// filter-blindness).
function renderRail() {
  const host = document.getElementById('rail')
  if (!host) return
  const projects = railProjects({
    items: allItems(lastData.g),
    boards: lastData.boards,
    archived: lastData.archived,
    activity: lastData.activity ?? [],
  })
  // Reconciled against the FULL list, open AND closed: selecting a closed
  // project IS legal — that is the peek — so this must never read `open`, or the
  // very first render after a peek click would evict it again.
  if (projectFilter && !projects.includes(projectFilter)) {
    projectFilter = null
    localStorage.removeItem(PROJECT_KEY)
  }
  // unsuppressed on purpose (see countsByProject in attention.js): the fold
  // relocates a closed project's number, it never destroys it
  const counts = countsByProject(allItems(lastData.g), lastData.boards, Date.now(), liveSessionIds())
  const { open, closed } = splitClosed(projects, closedSet())
  // shouldShowRailFilter reads the OPEN list, so closing projects can drop the
  // count back under RAIL_FILTER_THRESHOLD and remove the input from the DOM.
  // Clearing railQuery with it is what stops the rail from permanently hiding
  // every project that fails a query the human can no longer see or edit — a
  // dead end otherwise reachable by this feature's own primary action.
  const withFilter = shouldShowRailFilter(open)
  if (!withFilter) railQuery = ''
  const entries = filterRailEntries(railEntries(open, counts), railQuery)
  const closedRows = closedRailEntries(closed, counts)
  const closedEntries = filterRailEntries(closedRows, railQuery)
  // The fold opens on demand, whenever a closed project is being peeked, and
  // whenever a search's only hit is behind it — otherwise §12's confident false
  // negative comes back through a sealed fold instead of through a missing tab.
  const foldOpen = closedFoldOpen || closed.includes(projectFilter)
    || (!!searchQuery.trim() && closedEntries.some((e) => (projMatches.get(e.key) ?? 0) > 0))
  const th = themeName()
  const sig = JSON.stringify([entries, closedEntries, foldOpen, projectFilter, th, withFilter, railQuery, layout])
  if (host.dataset.sig === sig) return
  // rebuilding blows away focus; remember the caret so typing in the filter survives
  const active = document.activeElement
  const caret = active && active.classList.contains('rail-filter') ? active.selectionStart : null
  host.dataset.sig = sig
  host.innerHTML = ''
  if (withFilter) {
    const f = document.createElement('input')
    f.type = 'search'
    f.className = 'rail-filter'
    f.placeholder = 'Filter projects'
    f.setAttribute('aria-label', 'Filter projects')
    f.value = railQuery
    f.addEventListener('input', () => { railQuery = f.value; renderRail() })
    host.appendChild(f)
    if (caret !== null) { f.focus(); f.setSelectionRange(caret, caret) }
  }
  for (const e of entries) host.appendChild(railRowEl(e, { withFilter }))
  if (closed.length) host.appendChild(closedFoldEl(closedEntries, closed.length, suppressedTotal(closedRows), foldOpen, withFilter))
  // roving tablist (spec §13): exactly one project tab is tabbable
  for (const b of host.querySelectorAll('.rail-tab')) {
    b.tabIndex = b.getAttribute('aria-selected') === 'true' ? 0 : -1
  }
  wireTablist(host, 'vertical')
}

// the top bar's agent filter — a demoted dropdown scoped to the selected project.
// option text goes through textContent, never innerHTML: agent names are agent-authored.
function renderAgentSelect(agents) {
  const sel = document.getElementById('agentSelect')
  const sig = JSON.stringify([agents, agentFilter])
  if (sel.dataset.sig === sig) return
  sel.dataset.sig = sig
  sel.innerHTML = ''
  for (const v of [null, ...agents]) {
    const o = document.createElement('option')
    o.value = v ?? ''
    o.textContent = v ?? 'all'
    if (v === agentFilter) o.selected = true
    sel.appendChild(o)
  }
}

function initAgentSelect() {
  document.getElementById('agentSelect').addEventListener('change', (e) => {
    agentFilter = e.target.value || null
    if (agentFilter) localStorage.setItem(FILTER_KEY, agentFilter)
    else localStorage.removeItem(FILTER_KEY)
    resetPaging()
    forceRender()
  })
}

// which content panel is visible; the tab strip drives this in Task 8
function showPanel(id) {
  for (const p of document.querySelectorAll('main > .panel')) p.hidden = p.id !== id
  for (const t of document.querySelectorAll('#tabs .tab')) t.setAttribute('aria-selected', String(t.dataset.tab === id))
  document.getElementById('gear').classList.toggle('active', id === 'setup')
}

function initGear() {
  document.getElementById('gear').addEventListener('click', () => showPanel('setup'))
}

// live entries the user has expanded, by session id — survives the poll rebuild
const openLive = new Set()

function renderLive(entries) {
  const host = document.querySelector('#liveDrawer .live-list')
  const active = entries.filter((a) => !a.idle)
  const idle = entries.filter((a) => a.idle)
  host.innerHTML = entries.length ? '' : '<p class="empty">No sessions.</p>'
  for (const a of active) {
    const el = document.createElement('details')
    el.className = 'live-entry'
    if (openLive.has(a.session)) el.open = true
    el.addEventListener('toggle', () => { el.open ? openLive.add(a.session) : openLive.delete(a.session) })
    const { tone: fresh } = ageChip(Date.now() - Date.parse(a.updated_at))
    const stream = a.stream ? ` · ${esc(a.stream)}` : ''
    const kids = a.children.length ? `<span class="live-kids">▸ ${a.children.length} agent${a.children.length > 1 ? 's' : ''}</span>` : ''
    el.innerHTML = `
      <summary class="card-summary live-summary">
        <span class="live-dot ${fresh}" title="last update ${rel(a.updated_at)} ago"></span>
        <span class="live-who">${esc(a.agent)} · ${esc(a.project)}${stream}</span>
        <span class="live-doing">${esc(a.doing)}</span>
        ${kids}
        <span class="live-age" title="started ${rel(a.started_at)} ago">${rel(a.started_at)}</span>
      </summary>
      ${a.detail ? `<div class="detail live-detail">${esc(a.detail)}</div>` : ''}`
    if (a.children.length) {
      const table = document.createElement('table')
      table.className = 'board-table live-children'
      for (const c of a.children) {
        const tr = document.createElement('tr')
        tr.innerHTML = `
          <td class="row-label">${esc(c.name)}</td>
          <td class="row-note">${esc(c.doing)}</td>
          <td class="live-state">${c.state ? esc(c.state) : ''}</td>`
        table.appendChild(tr)
      }
      el.appendChild(table)
    }
    host.appendChild(el)
  }
  if (idle.length) {
    // idle sessions are the parents of everything — present but quiet,
    // collapsed until you want them (they expand into full entries the
    // moment they report real work)
    const fold = document.createElement('details')
    fold.className = 'idle-fold'
    if (openLive.has('__idle__')) fold.open = true
    fold.addEventListener('toggle', () => { fold.open ? openLive.add('__idle__') : openLive.delete('__idle__') })
    fold.innerHTML = `<summary>${idle.length} open session${idle.length > 1 ? 's' : ''}</summary>`
    for (const a of idle) {
      const row = document.createElement('div')
      row.className = 'idle-row'
      const stream = a.stream ? ` · ${esc(a.stream)}` : ''
      // a green dot means the session touched the inbox in the last minute —
      // open-but-conversing, not asleep
      const { tone: fresh } = ageChip(Date.now() - Date.parse(a.updated_at))
      row.innerHTML = `<span class="live-dot ${fresh}" title="last activity ${rel(a.updated_at)} ago"></span><span class="live-who">${esc(a.agent)} · ${esc(a.project)}${stream}</span><span class="live-age" title="last activity ${rel(a.updated_at)} ago">alive ${rel(a.started_at)}</span>`
      fold.appendChild(row)
    }
    host.appendChild(fold)
  }
}

// The always-visible footer strip (spec §16). Ambient only: never steals focus,
// never auto-expands, and its number never reads as a to-do.
function renderLiveBar(entries) {
  const s = liveSummary(entries, Date.now())
  const dot = document.getElementById('liveStripDot')
  const label = document.getElementById('liveStripLabel')
  const list = document.getElementById('liveStripSessions')
  if (!dot || !label || !list) return
  dot.className = `live-dot ${s.tone}`
  label.textContent = s.label
  list.replaceChildren()
  for (const x of s.sessions) {
    const el = document.createElement('span')
    el.className = `live-session ${x.tone}`
    el.textContent = x.label // agent-authored: textContent, never innerHTML
    list.appendChild(el)
  }
}

function toggleLiveDrawer(open) {
  const strip = document.getElementById('liveStrip')
  const drawer = document.getElementById('liveDrawer')
  if (!strip || !drawer) return
  const next = open ?? drawer.hidden
  drawer.hidden = !next
  strip.setAttribute('aria-expanded', String(next))
  if (!next) strip.focus() // return focus on collapse (spec §13)
}

function initLiveBar() {
  const strip = document.getElementById('liveStrip')
  if (!strip) return
  strip.addEventListener('click', () => toggleLiveDrawer())
  document.addEventListener('keydown', (e) => {
    const drawer = document.getElementById('liveDrawer')
    if (e.key === 'Escape' && drawer && !drawer.hidden) { toggleLiveDrawer(false) }
  })
}

// dismissing noise must not cost an expansion: staged 5s, undoable, flushed on blur
const stagedDismiss = new Set() // item ids inside their undo window — survives the poll rebuild
const dismissStage = createStagedSend({
  delayMs: 5000,
  setTimeoutFn: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeoutFn: (h) => window.clearTimeout(h),
  send: ({ id }) => { stagedDismiss.delete(id); act(id, 'dismiss') },
})

// the one staged-dismiss entry point: the row ✕ and Task 17's `x` key both call
// this, so mouse and keyboard share one undo window
function stageDismiss(id) {
  if (stagedDismiss.has(id)) return
  stagedDismiss.add(id)
  dismissStage.stage(`dismiss:${id}`, { id })
  forceRender()
}

function undoDismiss(id) {
  if (!dismissStage.undo(`dismiss:${id}`)) return false
  stagedDismiss.delete(id)
  forceRender()
  return true
}

const REPLY_DELAY_MS = 5000
const stagedStars = new Map() // item id → { label } inside its undo window
const starStage = createStagedSend({
  delayMs: REPLY_DELAY_MS,
  setTimeoutFn: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeoutFn: (h) => window.clearTimeout(h),
  // exactly the call the option pill makes today (app.js `answerEl`) — no new endpoint
  send: ({ id, label, context }) => { stagedStars.delete(id); sendReply(id, label, context) },
})

// a staged send must never be lost to a closing tab
function initStagedFlush() {
  const flushStaged = () => { starStage.flush(); dismissStage.flush() }
  window.addEventListener('beforeunload', flushStaged)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushStaged() })
}

// The Needs-you header: opt-in triage only (tenet 1) — a button, never a flow
// that opens itself. With the old #now strip gone this is the deck's only door.
function needsYouHeader() {
  const bar = document.createElement('div')
  bar.className = 'tab-header'
  const tri = btn('Triage →', openTriage)
  tri.className = 'triage-btn'
  bar.appendChild(tri)
  return bar
}

// one quiet chip at the very foot of the Needs-you list — notes are seen in the
// flow the user actually opens, without entering the attention set (spec §8)
function renderNeedsYouExtras(host, notes) {
  const n = unreadNoteCount(notes, notesSeenAt, Date.now(), notesSeenIds)
  if (!n) return
  const chip = btn(`${n} new note${n > 1 ? 's' : ''}`, () => selectTab('notes'))
  chip.className = 'notes-chip'
  host.appendChild(chip)
}

// the calm state: no red, no call to action, ambient counts as discrete chips
function renderEmptyState(host) {
  const panel = document.createElement('div')
  panel.className = 'calm-panel'
  panel.innerHTML = '<div class="calm-head">Nothing needs you</div>'
  // the unread-note count already has its own actionable footer button
  // (renderNeedsYouExtras' .notes-chip) — an inert duplicate here is one
  // number shown twice for the same fact.
  // Honest note: because that filter drops the ONLY chip `notesSeenIds` can
  // change, passing it here is inert TODAY. It is passed anyway so that dropping
  // the filter can never resurrect a chip that disagrees with the tab count —
  // the two note numbers disagreeing is precisely fix round 2's I3.
  // issue #32: read visibleData, so the calm panel's chips agree with the
  // suppressed badge. The existing justification above holds verbatim for a
  // closed project too — a project the human retired is, by definition, not
  // something that needs them, so the claim stays true.
  const chips = ambientChips(allItems(visibleData.g), visibleData.boards, Date.now(), notesSeenAt, notesSeenIds)
    .filter((c) => c.key !== 'notes')
  if (chips.length) {
    const row = document.createElement('div')
    row.className = 'calm-chips'
    for (const c of chips) {
      const s = document.createElement('span')
      s.className = `calm-chip chip-${c.key}`
      s.textContent = c.label // ambient labels are agent-derived counts — textContent, never innerHTML
      row.appendChild(s)
    }
    panel.appendChild(row)
  }
  host.appendChild(panel)
}

// flat, ranked, two-line rows — no project/agent heading levels (§3, §15)
function renderNeedsYou(g, boardsInView, nowMs) {
  const host = document.getElementById('needsYouList')
  // §13: this rebuilds every row from scratch (poll tick or user action) — capture
  // this BEFORE the list gets cleared below, since clearing a focused element's
  // subtree shifts document.activeElement immediately (to <body>, typically).
  const hadListFocus = !!document.activeElement?.closest?.('#needsYouList .nrow[data-card-id]')
  const items = g.needsYou.flatMap((gr) => gr.items)
  const live = liveSessionIds()
  // §7: the LIST is scoped by the rail + search (boardsInView); the tab count is
  // computed from lastData by Task 8 and never sees this slice
  // fix round 2 (I4): repliedEntries, not the strict awaiting-pickup subset —
  // between reply_seen_at and the agent's (possibly never) resolve, an answered
  // open question was rendered by NO tab while search still counted it here.
  // issue #37 adds the rows-shaped twin: a blocked row the human has ANSWERED
  // leaves the attention set (their part is done) but must not vanish, or an
  // answer nobody ever collected rots with nothing anywhere saying so. Both
  // land in sortNeedsYou's bucket 3 — the same dimmed foot, one ordering rule.
  const replied = repliedEntries(items, nowMs, live)
  const awaiting = awaitingAgentRows(boardsInView, closedSet())
  const unordered = needsYouEntries(items, boardsInView, nowMs, live, [...replied, ...awaiting])
  // §10: run every entry through Task 9's poll-suspension pin BEFORE paginating —
  // this is what stops a freshly-arrived row from jumping into the visible slice
  // while the pointer is over the list. orderedIds() only ever returns ids that
  // were already pinned or that hovering:false let through, so entries that got
  // staged simply do not appear in `ordered` until the pointer leaves.
  const entryById = new Map(unordered.map((e) => [e.kind === 'row' ? e.row.id : e.item.id, e]))
  const entries = orderedIds([...entryById.keys()]).map((id) => entryById.get(id)).filter(Boolean)
  const entities = [...items, ...boardsInView]
  const opts = {
    streams: streamCounts(entities),
    agents: agentCounts(entities),
    showProject: !projectFilter, // a single selected project needs no monogram (§2)
  }
  const { visible, remaining } = paginate(entries, shown.needsYou)
  // fix round 2 (I2): the stale fold renders BELOW the empty state but its
  // contents are part of this tab's answer. Computed first so a query matching
  // only a stale item can't print "No matches … or in any other tab" directly
  // above the fold holding that exact match (while its tab badge reads 1).
  const stale = staleEntries(items, nowMs, live)
  host.innerHTML = ''
  host.appendChild(needsYouHeader())
  if (!entries.length) {
    // a search that matched nothing still says so; an empty INBOX gets the calm panel
    if (searchQuery.trim()) {
      // only claim "no matches" when the fold below holds none either
      if (!stale.length) host.insertAdjacentHTML('beforeend', `<p class="empty">${emptyMsg('Nothing needs you.')}</p>`)
      // issue #31.3: suppressing the FALSE "no matches" claim also swallowed the
      // §12 pointer, leaving a search that hit only a collapsed stale item with a
      // blank tab. The claim is what was wrong, not the pointer — print it alone.
      else {
        const where = elsewhereMsg()
        if (where) host.insertAdjacentHTML('beforeend', `<p class="empty">Only stale matches here — ${where}</p>`)
      }
    } else {
      // an empty INBOX still gets the calm panel: a demoted stale item is, by
      // definition, not something that needs you — the claim stays true.
      renderEmptyState(host)
    }
  }
  for (const e of visible) host.appendChild(needsRowEl(rowModel(e, opts), e, nowMs))
  if (remaining > 0) host.appendChild(moreButton('needsYou', remaining))
  if (stale.length) host.appendChild(staleFoldEl(stale, opts, nowMs))
  // fix round 2 (I3): the foot chip is fed the SAME scoped notes the Notes tab
  // count is computed from (render()'s `g.notes`). It used to read the GLOBAL
  // lastData.g.notes, so the chip and the badge disagreed under any rail filter.
  renderNeedsYouExtras(host, g.notes.flatMap((gr) => gr.items))
  // §13: `selectedId` (Task 17) is module state, same pattern as openRowId/
  // staleFoldOpen — the DOM just rebuilt above has no idea a row was selected,
  // so reapply it. Deliberately NOT suspended by suspendState() (unlike an open
  // card): freezing the poll on mere selection would stall ordinary keyboard
  // navigation, the opposite of what §10 wants. Only steals DOM focus back if
  // focus was already inside the list before the rebuild (hadListFocus) — a
  // poll tick must never yank focus out of the search box or a draft input.
  restoreRowSelection(hadListFocus)
}

// the stale fold's open/closed state, outside the DOM the 3s poll rebuilds —
// same precedent as openLive/openContexts: without this the fold silently
// re-collapses under the user mid-read
let staleFoldOpen = false

// nobody is listening and it is older than STALE_MS: out of the active list and
// out of every count, but one click away — never deleted (§6)
function staleFoldEl(entries, opts, nowMs) {
  const fold = document.createElement('details')
  fold.className = 'stale-fold'
  if (staleFoldOpen) fold.open = true
  fold.addEventListener('toggle', () => { staleFoldOpen = fold.open })
  const summary = document.createElement('summary')
  summary.textContent = staleFoldLabel(entries.length)
  fold.appendChild(summary)
  for (const e of entries) fold.appendChild(needsRowEl(rowModel(e, opts), e, nowMs))
  return fold
}

function needsRowEl(m, entry, nowMs) {
  const el = document.createElement('div')
  el.className = `nrow nrow-${m.kind}${m.answered ? ' answered' : ''}${stagedDismiss.has(m.id) ? ' staged' : ''}`
  el.dataset.cardId = m.id
  el.tabIndex = 0
  const chip = urgencyChip(m, nowMs)
  const color = pcolor(m.project)
  const glyph = m.kind === 'row' ? `<button class="nrow-glyph" title="open board: ${esc(m.boardTitle ?? '')}">🚧</button>` : ''
  // Items only. A board row has NO dismiss path — the human's exit from an
  // unannotated blocked row is issue #36's remaining half, and until it exists
  // this button rendered on every row, advertised the 'x' key, and did nothing.
  // An affordance that lies is worse than no affordance; do not draw it back in
  // before there is a route behind it.
  const dismissBit = m.kind === 'item' ? '<button class="nrow-dismiss" title="Dismiss (x)" aria-label="Dismiss">✕</button>' : ''
  const projBit = m.projectLabel ? `<span class="nrow-proj" title="${esc(m.project)}">${esc(m.projectLabel)}</span>` : ''
  const agentBit = m.agent ? `<span class="nrow-agent">${esc(m.agent)}</span>` : ''
  const streamBit = m.stream ? `<span class="nrow-stream">${esc(m.stream)}</span>` : ''
  // omit line 2 entirely when it would be blank — no secondary text, no agent
  // chip, no stream — otherwise it leaves a padded empty line under the row.
  // Still built (with staged-dismiss's own content) when a dismiss is staged,
  // since the ✕ handler below replaces this div's children in place.
  const showL2 = m.secondary || agentBit || streamBit || stagedDismiss.has(m.id)
  const l2 = showL2 ? `<div class="nrow-l2"><span class="nrow-sec">${esc(m.secondary)}</span>${agentBit}${streamBit}</div>` : ''
  el.innerHTML = `
    <div class="nrow-l1">
      <span class="pdot" style="background:${color.dot}" title="${esc(m.project)}"></span>
      ${projBit}
      ${glyph}
      <span class="nrow-title" title="${esc(m.title)}">${esc(m.title)}</span>
      <span class="chip chip-${chip.tone}"><span aria-hidden="true">${livenessGlyph(m.liveness).glyph}</span> ${esc(chip.text)}</span>
      <span class="nrow-src">${sourceChipsHtml(linkIndex, entry.kind === 'row' ? entry.board : entry.item, nowMs)}</span>
      <span class="nrow-star"></span>
      ${dismissBit}
      <span class="nrow-caret">▸</span>
    </div>
    ${l2}`
  el.style.setProperty('--wash', color.wash)
  const boardBtn = el.querySelector('.nrow-glyph')
  if (boardBtn) boardBtn.addEventListener('click', (ev) => { ev.stopPropagation(); jumpToCard('boards', m.boardId) })
  const dismissBtn = el.querySelector('.nrow-dismiss')
  if (dismissBtn) dismissBtn.addEventListener('click', (ev) => {
    ev.stopPropagation()
    stageDismiss(m.id)
  })
  const slot = el.querySelector('.nrow-star')
  const staged = stagedStars.get(m.id)
  const opt = m.kind === 'item' ? rowStarOption(m, entry.item) : null
  if (staged) {
    el.classList.add('staged')
    const label = document.createElement('span')
    label.className = 'sent-label'
    label.textContent = `${stagedLabel(staged)} — `
    const undo = btn('Undo', () => {
      if (starStage.undo(`star:${m.id}`)) { stagedStars.delete(m.id); forceRender(); return }
      const fresh = freshItem(m.id) ?? entry.item
      const refusal = undoRefusal(fresh, Date.now())
      if (refusal) { label.textContent = `${refusal} ` } else changeAnswer(fresh, label)
    })
    undo.className = 'undo-btn'
    slot.replaceChildren(label, undo)
  } else if (opt) {
    const star = btn('★', () => {
      stagedStars.set(m.id, { label: opt.label })
      starStage.stage(`star:${m.id}`, { id: m.id, label: opt.label, context: draftReplyContexts[m.id] ?? '' })
      forceRender()
    })
    star.className = 'star-btn'
    star.setAttribute('aria-label', ariaAnswerLabel(opt) ?? 'Answer')
    star.title = ariaAnswerLabel(opt) ?? 'Answer'
    star.addEventListener('click', (ev) => ev.stopPropagation())
    slot.replaceChildren(star)
  }
  if (stagedDismiss.has(m.id)) {
    const undo = btn('Undo dismiss', () => undoDismiss(m.id))
    undo.className = 'undo-btn'
    el.querySelector('.nrow-l2').replaceChildren(document.createTextNode('Dismissed — '), undo)
  }
  el.addEventListener('click', (ev) => {
    if (ev.target.closest('button, input, a')) return
    toggleRow(el, m, entry, nowMs)
  })
  el.addEventListener('keydown', (ev) => {
    if (ev.target !== el) return
    if (ev.key === 'Enter') { ev.preventDefault(); toggleRow(el, m, entry, nowMs) }
    if (ev.key === 'Escape' && openRowId === m.id) { ev.preventDefault(); toggleRow(el, m, entry, nowMs) }
  })
  // a full render (poll or user action) rebuilds the open row from openRowId
  if (openRowId === m.id) {
    el.dataset.open = '1'
    el.appendChild(rowCardBodyEl(entry, m, nowMs))
  }
  return el
}

// the inline expanded body — one card component, mounted under the row (§4)
function rowCardBodyEl(entry, m, nowMs) {
  const body = document.createElement('div')
  body.className = 'nrow-card'
  body.addEventListener('click', (ev) => ev.stopPropagation()) // clicks in the card must not collapse it
  // `entry` is a render-time closure and the §10 gate can hold a render for
  // minutes, so the snapshot inside it goes stale (issue #31.1, layer 2: a row
  // reopened after a Change answer would otherwise re-mount the OLD reply and
  // hide the answer surface again). Same freshItem() precedent as the star's
  // Undo fallback. Resolved in place: `entry.item` is undefined for board rows.
  body.appendChild(entry.kind === 'row'
    ? rowCardEl(entry.board, entry.row)
    : itemCardEl(freshItem(entry.item.id) ?? entry.item, { nowMs, liveness: m.liveness }))
  return body
}

// Single-open accordion. `setOpenRow` (Task 9) owns the flag and the poll gate;
// the DOM is patched in place because a re-render is exactly what the gate is
// there to suspend. Collapsing hands the poll its pending data back.
//
// This is the ONE function that opens/closes a row — a mouse click, the row's
// own Enter/Escape keydown handler below, and Task 17's keyboard 'expand'/
// 'collapse' intents (dispatched as a synthetic click on the row) all end up
// here — so focus management (spec §13: focus moves into the card on expand,
// returns to the row on collapse) lives in exactly one place instead of being
// duplicated per trigger.
function toggleRow(el, m, entry, nowMs) {
  const wasOpen = openRowId === m.id
  setOpenRow(wasOpen ? null : m.id)
  for (const other of document.querySelectorAll('.nrow[data-open="1"]')) {
    other.removeAttribute('data-open')
    const card = other.querySelector('.nrow-card')
    if (card) card.remove()
  }
  if (wasOpen) {
    renderIfIdle()
    requestAnimationFrame(() => selectRow(m.id)) // focus returns to the row (spec §13)
    return
  }
  el.dataset.open = '1'
  el.appendChild(rowCardBodyEl(entry, m, nowMs))
  requestAnimationFrame(() => {
    const card = el.querySelector('.nrow-card')
    if (card) { card.tabIndex = -1; card.focus({ preventScroll: true }) } // focus moves into the card (spec §13)
  })
}

// notes keep a card list, but flat: no project h3, no agent h4 (§15)
function renderGroups(sectionId, groups) {
  const host = document.querySelector(`#${sectionId} .groups`)
  const items = groups.flatMap((gr) => gr.items)
  const { visible, remaining } = paginate(items, shown[sectionId])
  host.innerHTML = items.length ? '' : `<p class="empty">${emptyMsg('Nothing here.')}</p>`
  for (const it of visible) host.appendChild(itemEl(it))
  if (remaining > 0) host.appendChild(moreButton(sectionId, remaining))
  // fix round 2 (I3): mark seen only what was actually on screen. The hidden set
  // is the GLOBAL note list minus what rendered — a note behind the "Show N
  // more" pager and a note behind the rail's project filter were equally unseen,
  // and there is one watermark covering every scope.
  if (sectionId === 'notes' && activeTab === 'notes') {
    const shownIds = new Set(visible.map((it) => it.id))
    const all = lastData.g.notes.flatMap((gr) => gr.items)
    markNotesSeen(visible, all.filter((n) => !shownIds.has(n.id)), all)
  }
}

function renderDone(items) {
  const host = document.querySelector('#done .items')
  const { visible, remaining } = paginate(items, shown.done)
  host.innerHTML = items.length ? '' : `<p class="empty">${emptyMsg('Nothing yet.')}</p>`
  for (const it of visible) host.appendChild(itemEl(it, it.status !== 'open'))
  if (remaining > 0) host.appendChild(moreButton('done', remaining))
}

const GLYPH = { done: '✅', partial: '⚠️', missing: '❌', tracked: '🔜', na: '➖', blocked: '🚧' }

// boards where the human clicked "show" on hidden done rows, overriding the
// global hide-completed pill for that board only
const showDoneBoards = new Set()

// collapsed cards (items + boards) by id — same rebuild problem, but also persisted
const CARDS_KEY = 'agent-inbox-cards-collapsed'
let collapsedCards = {}
try { collapsedCards = JSON.parse(localStorage.getItem(CARDS_KEY)) || {} } catch { /* fresh start */ }
let liveCardIds = new Set() // ids seen in the current render, for pruning stale keys

function setCardCollapsed(id, collapsed) {
  if (collapsed) collapsedCards[id] = true
  else delete collapsedCards[id]
  localStorage.setItem(CARDS_KEY, JSON.stringify(collapsedCards))
}

function pruneCollapsedCards() {
  let changed = false
  for (const id of Object.keys(collapsedCards)) {
    if (!liveCardIds.has(id)) { delete collapsedCards[id]; changed = true }
  }
  if (changed) localStorage.setItem(CARDS_KEY, JSON.stringify(collapsedCards))
}

function cardify(el, id) {
  el.dataset.cardId = id
  liveCardIds.add(id)
  if (!collapsedCards[id]) el.open = true
  el.addEventListener('toggle', () => setCardCollapsed(id, !el.open))
}

let showArchived = false            // session-only: the archived fold is not persisted
const sessionActiveBoards = new Set() // board ids seen active at some point this session (§9)

// the Boards tab header — this tab's only chrome, built here because the shell
// ships an empty panel (no #rowTabs, no .panel-tools)
function boardsHeader() {
  const bar = document.createElement('div')
  bar.className = 'tab-header'
  const t = btn('hide completed rows', () => {
    hideCompleted = !hideCompleted
    localStorage.setItem(HIDE_DONE_KEY, String(hideCompleted))
    forceRender()
  })
  t.className = `header-toggle${hideCompleted ? ' active' : ''}`
  bar.appendChild(t)
  return bar
}

function renderBoards(boards, archived) {
  const host = document.querySelector('#boards .boards')
  host.innerHTML = ''
  host.appendChild(boardsHeader())
  for (const b of boards) sessionActiveBoards.add(b.id)
  // a board that reaches 100% is archived by its agent seconds later; it lingers
  // here as a "completed — archived" card so finished work never blinks out (§9)
  const lingering = lingeringBoards(sessionActiveBoards, boards, archived)
  const lingerIds = new Set(lingering.map((b) => b.id))
  // fix round 2 (I2): the archived fold renders below this line and its contents
  // are part of the answer — `rest` is computed first so "No matches for X here
  // or in any other tab" can't print directly above a fold holding the match.
  const rest = archived.filter((b) => !lingerIds.has(b.id))
  if (!boards.length && !lingering.length && !rest.length) host.insertAdjacentHTML('beforeend', `<p class="empty">${emptyMsg('No boards.')}</p>`)
  const { visible, remaining } = paginate(boards, shown.boards)
  for (const b of visible) host.appendChild(boardEl(b))
  if (remaining > 0) host.appendChild(moreButton('boards', remaining))
  for (const b of lingering) host.appendChild(boardEl(b, true, true))
  if (rest.length) {
    // un-archive is the only undo for Archive, so archived boards fold in here —
    // they must never become unreachable (spec §9)
    const fold = document.createElement('details')
    fold.className = 'archived-fold'
    fold.open = showArchived
    fold.addEventListener('toggle', () => { showArchived = fold.open })
    fold.innerHTML = `<summary>show archived (${rest.length})</summary>`
    const page = paginate(rest, shown.archived)
    for (const b of page.visible) fold.appendChild(boardEl(b, true))
    if (page.remaining > 0) fold.appendChild(moreButton('archived', page.remaining))
    host.appendChild(fold)
  }
}

function boardEl(b, archived = false, lingering = false) {
  const el = document.createElement('details')
  const p = progressLabel(b.progress)
  el.className = `board${p.complete ? ' complete' : ''}${archived ? ' archived' : ''}${lingering ? ' lingering' : ''}`
  const stream = b.stream ? ` · ${esc(b.stream)}` : ''
  const c = pcolor(b.project)
  const hidden = hiddenDoneCount(b, { hideCompleted, showDone: showDoneBoards.has(b.id) })
  el.innerHTML = `
    <summary class="card-summary">
      <div class="board-head">
        <div class="board-title"><span class="caret"></span><span class="proj-dot" style="background:${c.dot}"></span>${esc(b.title)}<span class="board-id" title="board id">#${esc(b.id.slice(0, 6))}</span></div>
        <div class="board-meta">${esc(b.project)}${stream} · ${esc(b.agent)}</div>
      </div>
      <div class="bar"><div class="bar-fill" style="width:${p.secondary}"></div></div>
      <div class="bar-label"><strong class="prog-primary">${p.primary}</strong> done <span class="prog-secondary">${p.secondary}</span>${p.complete ? '<span class="complete-badge">✓ complete</span>' : ''}${lingering ? '<span class="linger-badge">completed — archived</span>' : ''}${hidden ? `<span class="hidden-hint" title="show this board's completed rows">· ${hidden} done hidden — show</span>` : ''}</div>
    </summary>`
  cardify(el, b.id)
  const hint = el.querySelector('.hidden-hint')
  if (hint) hint.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation() // don't toggle the surrounding <details>
    showDoneBoards.has(b.id) ? showDoneBoards.delete(b.id) : showDoneBoards.add(b.id)
    forceRender()
  })
  // issue #30 — deliberately OUTSIDE the <summary>: a summary's activation
  // behaviour toggles its parent <details>, so a chip inside .board-meta would
  // navigate AND collapse the card, writing a spurious collapsedCards entry that
  // outlives the session. preventDefault (the .hidden-hint precedent above) is
  // not reusable here — on an anchor it kills the navigation we want.
  const srcHtml = sourceChipsHtml(linkIndex, b, Date.now(), { tabbable: true })
  if (srcHtml) {
    const src = document.createElement('div')
    src.className = 'board-source'
    src.innerHTML = srcHtml
    el.appendChild(src)
  }
  const table = document.createElement('table')
  table.className = 'board-table matrix'
  for (const { row: r, num, needsAnswer } of boardRowsView(b, { hideCompleted, showDone: showDoneBoards.has(b.id) })) {
    const tr = document.createElement('tr')
    tr.className = `board-row${needsAnswer ? ' needs-answer' : ''}${openRows.has(r.id) ? ' open' : ''}`
    // one-line note only; the long context lives behind the row click
    tr.innerHTML = `
      <td class="row-num">${num}</td>
      <td class="row-glyph ${r.status}" title="${esc(r.status)}">${GLYPH[r.status] || ''}</td>
      <td class="row-label">${esc(r.label)}</td>
      <td class="row-note"><span class="note-line">${esc(r.note)}</span>${r.context ? '<span class="more-dot" title="has context — click the row">…</span>' : ''}${r.annotation ? `<span class="annotation-dot" title="${esc(r.annotation)}">📝${r.annotation_unseen ? '<span class="unseen" title="not yet delivered to an agent">●</span>' : ''}</span>` : ''}</td>`
    const actionTd = document.createElement('td')
    actionTd.className = 'row-action'
    const toggle = () => {
      openRows.has(r.id) ? openRows.delete(r.id) : openRows.add(r.id)
      forceRender()
    }
    if (needsAnswer && !archived) {
      const a = btn('Answer', toggle)
      a.className = 'answer-btn'
      actionTd.appendChild(a)
    } else if (r.context || !archived) {
      const a = btn(openRows.has(r.id) ? '▾' : '▸', toggle)
      a.className = 'row-expand'
      actionTd.appendChild(a)
    }
    tr.appendChild(actionTd)
    tr.addEventListener('click', (e) => { if (!e.target.closest('button, input')) toggle() })
    table.appendChild(tr)
    if (openRows.has(r.id)) {
      const ptr = document.createElement('tr')
      ptr.className = 'row-panel-row'
      const td = document.createElement('td')
      td.colSpan = 5
      td.appendChild(rowPanelEl(b, r, archived))
      ptr.appendChild(td)
      table.appendChild(ptr)
    }
  }
  el.appendChild(table)
  const actions = document.createElement('div')
  actions.className = 'actions'
  if (archived) {
    actions.appendChild(btn('Un-archive', async () => {
      const res = await postJSON(`/api/boards/${b.id}/unarchive`)
      if (res === null) return // network failure — postJSON already signaled it
      await reloadAndPaint() // #38 — the human's own click gets its frame
    }))
  } else {
    actions.appendChild(archiveBtn(b.id))
  }
  el.appendChild(actions)
  return el
}

// two-step inline confirm: first click arms ("Really archive?"), second click within
// 4s archives; it disarms after 4s (and implicitly on re-render — the DOM is rebuilt)
function archiveBtn(boardId) {
  let timer = null
  const el = btn('Archive', async () => {
    if (el.classList.contains('confirm')) {
      clearTimeout(timer)
      // a board the HUMAN archives by hand must not linger — lingering is only
      // for the agent's own auto-archive at 100% (spec §9)
      sessionActiveBoards.delete(boardId)
      const res = await postJSON(`/api/boards/${boardId}/archive`)
      if (res === null) return // network failure — postJSON already signaled it
      await reloadAndPaint() // #38 — the human's own click gets its frame
      return
    }
    el.classList.add('confirm')
    el.textContent = 'Really archive?'
    timer = setTimeout(() => {
      el.classList.remove('confirm')
      el.textContent = 'Archive'
    }, 4000)
  })
  return el
}

// answer-back UI state that must survive the 3s poll rebuild
const openCompares = new Set()   // item ids with the compare view expanded
const draftReplies = {}          // item id → in-progress free-text answer
const draftReplyContexts = {}    // item id → optional context attached to the answer
let draftFocusKey = null         // `${itemId}:answer` or `${itemId}:context`, to restore focus

async function sendReply(id, text, context = '') {
  const reply = text.trim()
  if (!reply) return
  // fix round 2 (C3): both drafts used to be deleted BEFORE the POST. When the
  // write failed (postJSON → null: server restarted, or now any non-2xx) the
  // human's typed answer was gone — the next render rebuilt an empty input and
  // #status's "disconnected" was wiped by the next successful poll ≤3s later.
  // Nothing is cleared until the server has it.
  const hadDraft = draftReplies[id] !== undefined || draftReplyContexts[id] !== undefined
  const res = await postJSON(`/api/items/${id}/reply`, { text: reply, context: context.trim() || undefined })
  if (res === null) {
    // re-assert rather than merely leave in place, so a future edit that clears
    // early still cannot lose it. Only when the human HAD a draft: inventing one
    // for an option-pill/★ send would park text in an input nobody typed into
    // (and suspend the poll on it — the C2 failure mode).
    if (hadDraft) { draftReplies[id] = text; draftReplyContexts[id] = context }
    showWriteError(id, WRITE_FAILED)
    resumeRender()
    return
  }
  delete draftReplies[id]
  delete draftReplyContexts[id]
  if (draftFocusKey?.startsWith(`${id}:`)) draftFocusKey = null
  showWriteError(id, '')
  // issue #38, the reported surface. Also the entry for the option pills, the ★'s
  // staged send, Enter in the input and the triage card — all of them were silent.
  await reloadAndPaint()
}

// the answer surface on an unanswered question: option pills (recommended
// first), a Compare toggle for the tradeoffs, and a free-text answer
function answerEl(it) {
  const wrap = document.createElement('div')
  wrap.className = `options${openCompares.has(it.id) ? ' comparing' : ''}`
  const opts = optionOrder(it.options)
  for (const o of opts) {
    const box = document.createElement('div')
    box.className = 'option'
    const pill = document.createElement('button')
    pill.className = `opt-pill${o.recommended ? ' rec' : ''}`
    pill.innerHTML = `${esc(o.label)}${o.recommended ? '<span class="rec-tag">recommended</span>' : ''}`
    pill.addEventListener('click', () => sendReply(it.id, o.label, draftReplyContexts[it.id] ?? ''))
    box.appendChild(pill)
    if (o.detail) {
      const d = document.createElement('div')
      d.className = 'opt-detail'
      d.textContent = o.detail
      box.appendChild(d)
    }
    wrap.appendChild(box)
  }
  const row = document.createElement('div')
  row.className = 'reply-row'
  if (opts.some((o) => o.detail)) {
    const cmp = btn(openCompares.has(it.id) ? 'Hide compare' : 'Compare', () => {
      openCompares.has(it.id) ? openCompares.delete(it.id) : openCompares.add(it.id)
      forceRender()
    })
    cmp.className = 'compare-toggle'
    row.appendChild(cmp)
  }
  const input = document.createElement('input')
  input.className = 'reply-input'
  input.placeholder = opts.length ? 'or answer in your own words…' : 'answer…'
  input.value = draftReplies[it.id] ?? ''
  input.addEventListener('input', () => { draftReplies[it.id] = input.value; resumeRender() })
  input.addEventListener('focus', () => { draftFocusKey = `${it.id}:answer` })
  input.addEventListener('blur', () => { if (draftFocusKey === `${it.id}:answer` && !input.value) draftFocusKey = null })
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendReply(it.id, input.value, ctxInput.value) })
  row.appendChild(input)
  row.appendChild(btn('Send', () => sendReply(it.id, input.value, ctxInput.value)))
  row.appendChild(writeErrorEl(it.id)) // persists a failed write's reason across the poll rebuild (C3)
  wrap.appendChild(row)
  const ctxRow = document.createElement('div')
  ctxRow.className = 'reply-row reply-context-row'
  const ctxInput = document.createElement('input')
  ctxInput.className = 'reply-input reply-context-input'
  ctxInput.placeholder = 'optional context for the agent (applies to Send or option picks)…'
  ctxInput.value = draftReplyContexts[it.id] ?? ''
  ctxInput.addEventListener('input', () => { draftReplyContexts[it.id] = ctxInput.value; resumeRender() })
  ctxInput.addEventListener('focus', () => { draftFocusKey = `${it.id}:context` })
  ctxInput.addEventListener('blur', () => { if (draftFocusKey === `${it.id}:context` && !ctxInput.value) draftFocusKey = null })
  ctxRow.appendChild(ctxInput)
  wrap.appendChild(ctxRow)
  if (draftFocusKey === `${it.id}:answer`) requestAnimationFrame(() => {
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
  })
  if (draftFocusKey === `${it.id}:context`) requestAnimationFrame(() => {
    ctxInput.focus()
    ctxInput.setSelectionRange(ctxInput.value.length, ctxInput.value.length)
  })
  return wrap
}

// THE card (§4): meta → title → detail → labeled CONTEXT → options → answer →
// actions. Mounted inline by the Needs-you accordion and by the triage lightbox.
function itemCardEl(it, { done = false, nowMs = Date.now(), liveness = 'parked', header = true } = {}) {
  const el = document.createElement('div')
  el.className = `card card-${it.kind}`
  const s = cardSections(it, { done })
  const color = pcolor(it.project)
  const chip = urgencyChip(
    { kind: 'item', liveness, created_at: it.created_at, answered: s.answered }, nowMs)
  const head = header ? `
    <div class="meta card-meta">
      <span class="pdot" style="background:${color.dot}"></span>
      <span>${esc(it.project)}</span> · <span>${esc(it.agent)}</span>${it.stream ? ` · <span>${esc(it.stream)}</span>` : ''}
      <span class="chip chip-${chip.tone}"><span aria-hidden="true">${livenessGlyph(liveness).glyph}</span> ${esc(chip.text)}</span>
    </div>
    <div class="card-title">${esc(it.title)}</div>` : ''
  el.innerHTML = `
    ${head}
    ${sourceBlockHtml(linkIndex, it, nowMs)}
    ${s.detail ? `<div class="detail card-detail">${esc(s.detail)}</div>` : ''}
    ${s.context ? `<div class="card-context"><div class="card-context-label">CONTEXT</div><div class="card-context-body">${esc(s.context)}</div></div>` : ''}
    ${s.annotation ? `<div class="annotation">📝 ${esc(s.annotation)}</div>` : ''}
    ${s.recWarning ? `<div class="rec-warning">⚠ ${esc(s.recWarning)}</div>` : ''}
    ${s.reply ? `<div class="reply-block">↩ ${esc(s.reply)}${it.reply_context ? `<div class="reply-context">context: ${esc(it.reply_context)}</div>` : ''}${it.reply_source === 'agent' ? '<span class="reply-source">via chat</span>' : ''}<span class="pickup ${it.reply_seen_at ? 'picked' : 'awaiting'}">${it.reply_seen_at ? '✓ picked up' : '● waiting for agent pickup'}</span></div>` : ''}`
  if (s.showAnswer) el.appendChild(answerEl(it))
  if (s.showActions) {
    const actions = document.createElement('div')
    actions.className = 'actions'
    actions.appendChild(btn('Resolve', () => act(it.id, 'resolve')))
    actions.appendChild(btn('Dismiss', () => act(it.id, 'dismiss')))
    if (s.answered) {
      // fix round 1 (hardening): a small inline slot beside the button for the
      // refusal message changeAnswer() surfaces when the server refuses (spec req #2)
      const msg = document.createElement('span')
      msg.className = 'refusal-msg'
      actions.appendChild(btn('Change answer', () => changeAnswer(it, msg)))
      actions.appendChild(msg)
    }
    actions.appendChild(btn('Note', async () => {
      const text = prompt('Your note:')
      if (text == null) return
      const res = await postJSON(`/api/items/${it.id}/annotate`, { text })
      if (res === null) return // network failure — postJSON already signaled it
      // #38: this button only exists INSIDE the expanded card, so openRowId is
      // set by construction — a bare load() here could never paint. Guaranteed
      // self-silencing, not merely unlucky.
      await reloadAndPaint()
    }))
    el.appendChild(actions)
  }
  return el
}

// fix round 1 (hardening): the server can refuse this (src/store.ts's replyItem
// guard — an already-picked-up reply cannot be silently blanked). It used to POST
// and throw away the response entirely: the human clicked, nothing happened, no
// explanation. Now it reads `{ ok }` and, on refusal, mirrors the SAME refusal copy
// the row Undo flow already produces (rowview.js's undoRefusal) into msgEl — the
// Undo call site passes its own `label`; the card's "Change answer" button passes
// the small slot created above. Approximate "now" for reply_seen_at when our local
// snapshot hasn't caught up yet (up to ~3s stale) — the server already told us
// definitively that a pickup happened, we just don't know exactly when.
async function changeAnswer(it, msgEl) {
  const res = await postJSON(`/api/items/${it.id}/reply`, { text: '' })
  if (res === null) return // network failure — postJSON already signaled it
  if (!res.ok) {
    const fresh = freshItem(it.id) ?? it
    const seenAt = fresh.reply_seen_at ?? new Date().toISOString()
    const refusal = undoRefusal({ ...fresh, reply_seen_at: seenAt }, Date.now())
    if (msgEl) msgEl.textContent = `${refusal} `
    return
  }
  // fix round 2 (C2): the prefill used to be written BEFORE the POST. On refusal
  // the item is still answered, so cardSections.showAnswer stays false and
  // answerEl is never built — the draft had no input to live in and NO ui could
  // clear it, so suspendReason() read 'draft' forever and the viewer froze
  // exactly like C1. It belongs on the accepted path only: the reply is blanked,
  // the answer surface comes back, and this is what it comes back holding.
  draftReplies[it.id] = it.reply
  draftReplyContexts[it.id] = it.reply_context ?? ''
  draftFocusKey = `${it.id}:answer`
  // issue #31.1. Two things have to be true for the human to SEE that draft, and
  // neither was:
  //  1. the row has to be expanded. This is reachable from a collapsed row —
  //     the star's Undo fallback lives on line 1 of `.nrow` — and a repaint of a
  //     collapsed row builds no answer surface at all. setOpenRow stays the
  //     single writer of openRowId (Task 9).
  //  2. a render has to happen. `load()`'s renderIfIdle() cannot do it: the
  //     draft written two lines up IS a suspend reason, so the gate is certain
  //     to skip. The human's own click is what asks for this frame — which is
  //     exactly what reloadAndPaint() is (#38 generalised this call site's fix to
  //     every other human-initiated write): reload first so the frame paints the
  //     server's post-blank-out state rather than the old reply, then paint
  //     unconditionally, outside the gate.
  setOpenRow(it.id)
  await reloadAndPaint()
}

// notes / done keep a collapsible card; the body is the same component
function itemEl(it, done = false) {
  const el = document.createElement('details')
  const answered = it.kind === 'question' && it.status === 'open' && it.reply
  el.className = `item ${it.kind}${answered ? ' answered' : ''}`
  const stream = it.stream ? ` · ${esc(it.stream)}` : ''
  el.innerHTML = `
    <summary class="card-summary">
      <div class="meta"><span class="caret"></span>${esc(it.agent)}${stream}</div>
      <div class="title">${esc(it.title)}</div>
    </summary>`
  cardify(el, it.id)
  el.appendChild(itemCardEl(it, { done, header: false }))
  return el
}

// ── keyboard (spec §13) ─────────────────────────────────────────────────────
// ONE handler for the list and the triage deck, so the deck's keys and the
// list's keys can never drift apart.
let selectedId = null // the row the keyboard is on

function rowEls() {
  return [...document.querySelectorAll('#needsYouList .nrow[data-card-id]')]
}

// class/attr/tabIndex only — no focus side effect, so it's safe to call from a
// passive rebuild (restoreRowSelection) as well as a deliberate user action
// (selectRow)
function markSelectedRow(id) {
  for (const el of rowEls()) {
    const on = el.dataset.cardId === id
    el.classList.toggle('selected', on)
    el.setAttribute('aria-selected', String(on))
    el.tabIndex = on ? 0 : -1
  }
}

function selectRow(id) {
  selectedId = id
  markSelectedRow(id)
  if (id) rowEls().find((el) => el.dataset.cardId === id)?.focus({ preventScroll: false })
}

// §13 fix round 1: `renderNeedsYou` rebuilds every `.nrow` from scratch on
// every render() — poll tick or user action — and has no idea a row was
// selected. Without this, `selectedId` (and j/k navigation) kept working in
// the module's closure, but the VISIBLE `.selected` class and the row's real
// DOM focus were destroyed every ~3s and only self-healed on the next
// keypress — for a screen-reader user that reads as random flakiness, not a
// clean failure. `focusIt` is true only when focus was already inside the
// list before the rebuild (see `hadListFocus` in renderNeedsYou) — otherwise
// this would steal focus from the search box or a draft input on every poll.
function restoreRowSelection(focusIt) {
  if (!selectedId) return
  markSelectedRow(selectedId)
  if (focusIt) rowEls().find((el) => el.dataset.cardId === selectedId)?.focus({ preventScroll: true })
}

function selectedItem() {
  if (!selectedId || !lastData) return null
  return allItems(lastData.g).find((i) => i.id === selectedId) ?? null
}

// The keyboard's reply target. `selectedId` is the LIST's selection — while the
// triage deck is open that is a different row than whatever the lightbox is
// showing, so a bare `selectedItem()` would let '1'-'4' (and dismiss/resolve)
// answer the WRONG item. While the deck is open, the target is always the entry
// currently on screen in it. `deckEntryAt` (public/keys.js) is the guarded,
// unit-tested lookup — the deck's "all clear" state (entries: [] while
// triageDeck is still non-null) would otherwise make `triageDeck.entries[i]`
// undefined and findEntryData(undefined) throw, and initKeys evaluates this on
// every keydown the deck is open.
function keyTargetItem() {
  if (triageDeck) {
    const entry = deckEntryAt(triageDeck.entries, triageDeck.index)
    return entry ? (findEntryData(entry)?.it ?? null) : null
  }
  return selectedItem()
}

function runIntent(intent) {
  const ids = rowEls().map((el) => el.dataset.cardId)
  const it = keyTargetItem()
  switch (intent.type) {
    case 'move': {
      if (!ids.length) return
      const at = ids.indexOf(selectedId)
      const from = at < 0 ? (intent.delta > 0 ? -1 : ids.length) : at
      selectRow(ids[Math.max(0, Math.min(ids.length - 1, from + intent.delta))])
      return
    }
    case 'expand': {
      // dispatched as a real click on the row — toggleRow is the single
      // open/close path and owns the focus-into-card behaviour (spec §13)
      if (!selectedId) return
      rowEls().find((el) => el.dataset.cardId === selectedId)?.click()
      return
    }
    case 'collapse': {
      // same trick in reverse: clicking the open row closes it and toggleRow
      // returns focus to the row (spec §13)
      if (!openRowId) return
      document.querySelector(`.nrow[data-card-id="${CSS.escape(openRowId)}"]`)?.click()
      return
    }
    case 'clearSelection':
      selectRow(null)
      return
    case 'option': {
      const o = optionOrder(it?.options)[intent.index]
      if (o && it) sendReply(it.id, o.label, draftReplyContexts[it.id] ?? '')
      return
    }
    case 'dismiss':
      // items only; the SAME staged 5s-undo path the ✕ button uses (Task 10) —
      // a keyboard dismiss must be exactly as reversible as a mouse dismiss.
      if (it) stageDismiss(it.id)
      return
    case 'resolve':
      if (it) act(it.id, 'resolve') // deck-aware target — never a bare selectedId
      return
    case 'search':
      document.getElementById('search').focus()
      return
    case 'blur':
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur()
      return
    case 'deckPrev':
      triageDeck.index = Math.max(0, triageDeck.index - 1)
      renderTriage()
      return
    case 'deckNext':
      triageDeck.index = Math.min(triageDeck.entries.length - 1, triageDeck.index + 1)
      renderTriage()
      return
    case 'closeDeck':
      closeTriage()
      return
    case 'openDeck':
      openTriage() // the Now strip's button is gone (Task 6) — 't' is the deck's door now
      return
  }
}

function initKeys() {
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    // The row's own keydown listener (needsRowEl) already handles Enter/Escape
    // when the row itself has focus and calls preventDefault() — don't run the
    // action twice.
    if (e.defaultPrevented) return
    // Esc precedence, explicit (topmost/innermost first): the triage deck (an
    // actual lightbox) wins via keyAction's own ladder below (deckOpen is
    // checked first, ahead of 'expanded'/clearSelection). The Live drawer is
    // its OWN Esc consumer (initLiveBar, Task 16) that already closes it and
    // returns focus to the strip — when the deck is closed but the drawer is
    // open, step aside instead of ALSO clearing the list selection underneath
    // it; the drawer's own listener (registered after this one) still runs.
    const liveDrawer = document.getElementById('liveDrawer')
    if (e.key === 'Escape' && !triageDeck && liveDrawer && !liveDrawer.hidden) return
    const t = e.target
    const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
    // optionCount must come from the SAME target runIntent will answer — the
    // deck entry while it's open, the list selection otherwise — or a keyboard
    // '1'-'4' can validate against one item and answer another (see
    // keyTargetItem).
    const intent = keyAction(e.key, {
      typing,
      deckOpen: !!triageDeck,
      expanded: openRowId != null,
      optionCount: optionOrder(keyTargetItem()?.options).length,
    })
    if (!intent) return
    e.preventDefault()
    runIntent(intent)
  })
}

// Rail (#rail, vertical) and top tabs (#tabs, horizontal) are real tablists
// with roving focus: exactly one [role="tab"] is tabbable, arrows move within
// the group (spec §13).
function wireTablist(host, orientation) {
  if (!host) return
  host.setAttribute('role', 'tablist')
  host.setAttribute('aria-orientation', orientation)
  if (host.dataset.tablist === '1') return // listener attaches once; rebuilds reuse it
  host.dataset.tablist = '1'
  host.addEventListener('keydown', (e) => {
    // issue #32: the rail's closed fold holds `[role="tab"]` rows that are
    // display:none while the <details> is shut. Arrow-keying into one sends
    // focus to an invisible element and it simply vanishes for the user.
    const tabs = [...host.querySelectorAll('[role="tab"]')].filter((t) => !t.closest('details:not([open])'))
    const i = tabs.indexOf(document.activeElement)
    if (i < 0) return
    const next = rovingIndex(i, e.key, tabs.length)
    if (next === i) return
    e.preventDefault()
    tabs[i].tabIndex = -1
    tabs[next].tabIndex = 0
    tabs[next].focus()
  })
}

function btn(label, onClick) {
  const b = document.createElement('button')
  b.textContent = label
  b.addEventListener('click', onClick)
  return b
}

// the pager at the foot of a capped section — reveals PAGE[section] more cards
function moreButton(section, remaining) {
  const n = Math.min(PAGE[section], remaining)
  const b = btn(`Show ${n} more (${remaining} hidden)`, () => { shown[section] += PAGE[section]; forceRender() })
  b.className = 'show-more'
  return b
}

// Resolve / Dismiss. The HIGHEST-severity #38 site: both buttons live inside the
// expanded card, so `openRowId` is set by construction and the bare load() here
// could NEVER paint. Worse, it stranded openRowId on a row that no longer exists —
// render() is what reconciles that (reconcileOpenRow), and the render never ran —
// so the poll stayed suspended, the row stayed on screen and the badge kept
// counting a resolved item. A badge that outlives its subject is a badge nobody
// trusts (tenet 2). Also reached by the 5s staged dismiss.
async function act(id, action) {
  const res = await postJSON(`/api/items/${id}/${action}`)
  if (res === null) return // network failure — postJSON already signaled it
  await reloadAndPaint()
}

// ── close / reopen a project (issue #32) ────────────────────────────────────
// The rail's only two mutations. Both are OPTIMISTIC: a poll suspended by an
// open card (§10) would otherwise leave the rail visibly stale for as long as
// the human keeps that card open, which reads as a broken button.
//
// Every revert works BY VALUE, never by index. load() replaces lastData wholesale
// every 3s, so a `splice(lastData.closed.indexOf(name), 1)` that lands after a
// poll would find -1 and delete the LAST element — silently un-closing an
// unrelated project. There is no scenario in which the index form is safe here.
//
// No staged undo: closing is one click to reverse, in the same place the tab
// just left.
async function closeProjectAction(name) {
  lastData.closed = [...(lastData.closed ?? []), name]
  closedFoldOpen = true // show the human where the tab went
  if (projectFilter === name) { projectFilter = null; localStorage.removeItem(PROJECT_KEY) }
  resetPaging()
  forceRender()
  const res = await postJSON('/api/projects/close', { project: name })
  if (res === null) { // postJSON already surfaced the reason — just put the tab back
    lastData.closed = (lastData.closed ?? []).filter((p) => p !== name)
    forceRender()
    return
  }
  // low stakes here — the optimistic frame above already showed the right thing —
  // but there is ONE rule for a human-initiated write, not two (#38).
  await reloadAndPaint()
}

async function reopenProjectAction(name) {
  lastData.closed = (lastData.closed ?? []).filter((p) => p !== name)
  forceRender()
  const res = await postJSON('/api/projects/reopen', { project: name })
  if (res === null) {
    if (!(lastData.closed ?? []).includes(name)) lastData.closed = [...(lastData.closed ?? []), name]
    forceRender()
    return
  }
  await reloadAndPaint()
}

// fix round 1: the query persists across tab and project changes for free —
// `searchQuery` is module state nothing else ever resets (selectTab and the
// rail's project handler don't touch it), and `#search`'s DOM node is never
// rebuilt after this one-time init, so its typed value survives on its own.
// (A prior `input.value = searchQuery` line here was dead: initSearch() runs
// once at boot, before searchQuery can be non-empty, and never runs again —
// it asserted a protection this line wasn't actually providing.)
function initSearch() {
  const input = document.getElementById('search')
  let t = null
  input.addEventListener('input', () => {
    clearTimeout(t)
    t = setTimeout(() => { searchQuery = input.value; resetPaging(); forceRender() }, 120)
  })
}

// Setup section: how to point new agents at this inbox. Static content —
// fetched once, not on the poll.
async function renderSetup() {
  try {
    const s = await (await fetch('/api/setup')).json()
    const host = document.querySelector('#setup .setup-body')
    const block = (title, text, hint) => {
      const wrap = document.createElement('div')
      wrap.className = 'setup-block'
      wrap.innerHTML = `<h3>${esc(title)}</h3>${hint ? `<p class="setup-hint">${esc(hint)}</p>` : ''}`
      const pre = document.createElement('pre')
      pre.textContent = text
      const copy = btn('Copy', async () => {
        await navigator.clipboard.writeText(text)
        copy.textContent = 'Copied ✓'
        setTimeout(() => { copy.textContent = 'Copy' }, 1500)
      })
      copy.className = 'copy-btn'
      wrap.appendChild(pre)
      wrap.appendChild(copy)
      host.appendChild(wrap)
    }
    if (s.note) {
      const note = document.createElement('p')
      note.className = 'setup-hint'
      note.textContent = `⚠ ${s.note}`
      host.appendChild(note)
    }
    block('1 · Register the MCP server — Claude Code', s.claudeCommand,
      'Run once; applies to every repo (user scope). New registrations are picked up on a fresh agent session.')
    block('1b · Copilot CLI — merge into ~/.copilot/mcp-config.json', s.copilotConfig)
    block('2 · Teach agents when to flag — paste into your global instructions (e.g. ~/.claude/CLAUDE.md)', s.snippet,
      'This snippet is the signal-quality lever: it tells agents when to raise questions/notes, attach options, poll for your replies, and keep boards.')
    if (s.hooksSettings) {
      block('3 · Optional: backstop hooks — merge into ~/.claude/settings.json', s.hooksSettings, s.hooksNote)
    }
    const db = document.createElement('p')
    db.className = 'setup-hint'
    db.textContent = `Everything lands in ${s.dbPath} — any viewer (browser tab, app) reads the same file.`
    host.appendChild(db)
  } catch { /* setup info unavailable — leave the section empty */ }
}

// ── init ────────────────────────────────────────────────────────────────────
// Canonical order for the finished app; later tasks add their one line at the
// slot named here and never rewrite this block:
//   initTabs → initTriage → initSearch → initResponsive (Task 18) →
//   initKeys (Task 17) → initFocusHash (Task 17) → initStagedFlush →
//   initListStaging (Task 9) → initPressGuard (#38) → initAgentSelect →
//   initGear → initLiveBar → renderSetup → load → setInterval(load, 3000)
initTabs()
initTriage()
initSearch()
initResponsive()
initKeys()
initFocusHash()
initStagedFlush()
initListStaging()
initPressGuard()
initAgentSelect()
initGear()
initLiveBar()
renderSetup()
// The LAST two lines that may ever call the gated load() directly: the boot paint
// and the poll itself. Every other caller is a human action and goes through
// reloadAndPaint() — see the block above forceRender(), and issue #38.
load()
setInterval(load, 3000)
