import { paginate, paginateGroups } from '/search.js'
import { buildSearchResults } from '/search-index.js'
import {
  closedFoldLabel, closedRailEntries, filterRailEntries, railEntries, railProjects,
  shouldShowRailFilter, splitClosed, suppressedTotal,
} from '/rail.js'
import {
  attentionCount, attentionEntries, awaitingAgentRows, classifyLiveness, countsByProject,
  isAskingQuestion, isBlockedRowAttention, snoozedEntries, staleEntries,
} from '/attention.js'
import { DEFAULT_TAB, TAB_IDS, tabCounts } from '/tabs.js'
import { projectColor } from '/colors.js'
import {
  SCROLL_IDLE_MS, pressHeld, scrollActive, shouldDeferRender,
  suspendHint, pinOrder, reconcileOpenRow,
} from '/poll.js'
import { createStagedSend } from '/star.js'
import {
  ageChip, agentCounts, handledUndoRefusal, needsYouEntries, relMs, repliedEntries, rowModel,
  rowStarOption, stagedLabel, staleFoldLabel, streamCounts, undoRefusal, urgencyChip,
  ASK_SORT_OPTIONS, askTimeModel, sortNeedsYouByAsk,
} from '/rowview.js'
import { cardSections, optionOrder } from '/card.js'
import { keyAction, rovingIndex, ariaAnswerLabel, livenessGlyph, deckEntryAt } from '/keys.js'
import { partitionNotes, unreadNoteCount, ambientChips, seenWatermark, markSeenIds } from '/notes.js'
import { liveSummary, lastActivityAt, isDormant, activitySynopsis } from '/livebar.js'
import { esc } from '/esc.js'
import { initStructuredTextCopy } from '/structured-copy.js'
import { renderStructuredText } from '/structured-text.js'
import { boardRowsView, boardRowLine, progressLabel, hiddenDoneCount, lingeringBoards } from '/boards.js'
import { titleWithBadge, focusHashFor, parseFocusHash } from '/badge.js'
import { layoutMode, railLabel, NARROW_MAX, PROJECT_DISCLOSURE_MAX } from '/layout.js'
import { indexLinks, sourceChipsHtml, sourceBlockHtml } from '/source.js'
import { buildSummary } from '/buildstamp.js'
import { actionCategory, actionOwnerLabel, agentFollowupChip, changeKind, lifecycleReceipt, responseLabel } from '/action.js'
import { buildRelay } from '/relay.js'
import { buildMission } from '/mission.js'
import { buildActivitySeries, buildDashboard } from '/dashboard.js'
import { PANE_DEFAULTS, paneKeyValue, paneValueFromPointer, resolvePaneLayout } from '/panes.js'
import { createThemeController } from '/theme.js'

void paginateGroups // kept exported+tested (spec §15); the viewer no longer calls it

// typo-tolerant fuzzy filtering; the engine is a vendored browser global
const uf = new window.uFuzzy({ intraMode: 1 })
const fuzzySearch = (hay, needle) => {
  const [matches, info, order] = uf.search(hay, needle, 0, Number.POSITIVE_INFINITY)
  return info && order
    ? order.flatMap((infoIndex) => {
        const index = info.idx[infoIndex]
        return index === undefined ? [] : [{ index, ranges: info.ranges[infoIndex] ?? [] }]
      })
    : matches?.map((index) => ({ index, ranges: [] })) ?? null
}
let searchQuery = ''
let searchTimer = null
let searchIndexOpen = false
let searchActiveIndex = -1
let searchResultCache = []
let searchResultSignature = ''
let searchUpdating = false
let searchJumpSource = null

function nativeKeyOwner(event) {
  if (!(event.target instanceof Element)) return false
  const owner = event.target.closest('select, button, a[href], summary, [role="button"]')
  if (!owner) return false
  return owner.matches('select') || event.key !== 'Escape'
}

// per-section visible-card caps; `shown` grows as the user clicks "show more"
const PAGE = { needsYou: 10, notes: 5, done: 5, boards: 5, archived: 5 }
let shown = { ...PAGE }
function resetPaging() { shown = { ...PAGE } }

let lastData = null
let dashboardRangeMs = 24 * 60 * 60 * 1000
let renderedTheme = document.documentElement.dataset.theme ?? 'light'
function syncThemeChoices(preference) {
  for (const input of document.querySelectorAll('input[name="theme-preference"]')) {
    input.checked = input.value === preference
  }
}
const themeController = createThemeController({
  storage: localStorage,
  root: document.documentElement,
  media: window.matchMedia('(prefers-color-scheme: dark)'),
  onChange(preference, effective) {
    const changed = renderedTheme !== effective
    renderedTheme = effective
    window.agentInboxTheme?.setPreference?.(preference)
    syncThemeChoices(preference)
    // OS appearance changes are ambient. CSS updates immediately from data-theme;
    // inline project colors can wait for the poll gate so drafts and scroll stay put.
    if (changed && lastData) renderIfIdle()
  },
})
let authoritativeClosed = []
let loadGeneration = 0
let appliedLoadGeneration = 0
let appliedClosedGeneration = 0
let preparedFrame = null
// issue #30 — the (repo, branch) → cached PR state index, rebuilt once per
// render. A Map from the start, never null: the deep-link and setup paths can
// reach a renderer before the first /api/links response lands, and linkFor(null)
// would throw into load()'s catch and blank the whole page.
let linkIndex = new Map()
const HIDE_DONE_KEY = 'agent-inbox-hide-completed'
// The product is a cross-project attention inbox, so a cold launch must never
// reopen behind yesterday's project/agent lens while the global badge counts
// work the list is hiding. Retire the old persisted keys; filters remain useful
// for this window and explicit deep links still scope themselves below.
localStorage.removeItem('agent-inbox-agent-filter')
localStorage.removeItem('agent-inbox-project-filter')
let agentFilter = null
let projectFilter = null
let hideCompleted = localStorage.getItem(HIDE_DONE_KEY) !== 'false' // default ON

const NOTES_SEEN_KEY = 'agent-inbox-notes-seen'
const NOTES_SEEN_IDS_KEY = 'agent-inbox-notes-seen-ids'
const LAST_VISIT_KEY = 'agent-inbox-last-visit'
const lastVisitAt = localStorage.getItem(LAST_VISIT_KEY)
localStorage.setItem(LAST_VISIT_KEY, new Date().toISOString())
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

function sortDeferredEntries(entries) {
  return askSort === 'priority' ? entries : sortNeedsYouByAsk(entries, askSort)
}

let bootId = null

// ── poll suspension (spec §10) ──────────────────────────────────────────────
// The 3s rebuild holds for typed drafts and bounded active interactions. A
// merely expanded card keeps polling: open state survives settled rebuilds,
// order pinning appends new arrivals at the foot, and the press/scroll guards
// protect clicks and trackpad momentum.
let openRowId = null    // the single inline-expanded Needs-you row (§4)
let openRowScrollTop = 0 // the inspector's viewport survives the 3s DOM rebuild
let pendingFocusId = null // explicit deep link protected through filter + pagination reconciliation
let pagedFocusId = null // non-Inbox focused card protected only for the current rebuild
let lastInteractionScrollAt = null // bounded inspector/page scroll activity; never a suspension
let interactionScrollTimer = null
let renderDirty = false // fresh data arrived while an editable rebuild was deferred
let pinnedIds = []      // sort order pinned for this render session
let pressedAt = null    // pointerdown → pointerup, hard-bounded by PRESS_GRACE_MS (#38)

// What SUSPENDS the poll — deliberately not the same set as what DEFERS it.
// `pressedAt` is missing on purpose and must stay missing: showPauseHint() reads
// this, and a held button is not a pause (see initPressGuard).
function suspendState() {
  const drafts = {}
  for (const [id, value] of Object.entries(draftReplies)) drafts[`reply:${id}`] = value
  for (const [id, value] of Object.entries(draftReplyContexts)) drafts[`context:${id}`] = value
  for (const [id, value] of Object.entries(rowDrafts)) drafts[`row:${id}`] = value
  return {
    drafts,
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

function clearScrollActivity() {
  lastInteractionScrollAt = null
  if (interactionScrollTimer !== null) {
    clearTimeout(interactionScrollTimer)
    interactionScrollTimer = null
  }
}

// Rebuilding during wheel/trackpad movement kills inspector momentum and can
// fight the viewport's own scrolling. Defer only while events are arriving,
// then paint a held frame after 200ms of quiet instead of waiting for another
// 3-second tick.
function noteScrollActivity() {
  lastInteractionScrollAt = Date.now()
  if (interactionScrollTimer !== null) clearTimeout(interactionScrollTimer)
  interactionScrollTimer = setTimeout(() => {
    interactionScrollTimer = null
    if (!scrollActive(lastInteractionScrollAt, Date.now())) resumeRender()
  }, SCROLL_IDLE_MS)
}

function cardScrollHost(card) {
  return card?.querySelector('.nrow-card-scroll') ?? card
}

function noteInspectorScroll(id, card) {
  if (openRowId !== id) return
  openRowScrollTop = card.scrollTop
  noteScrollActivity()
}

function notePageScroll() {
  if (openRowId == null) return
  noteScrollActivity()
}

function initScrollGuard() {
  window.addEventListener('wheel', notePageScroll, { passive: true })
  window.addEventListener('scroll', notePageScroll, { passive: true })
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
  const now = Date.now()
  // A held press still protects EVERY surface. paintAmbient() may rebuild the rail,
  // so running it between pointerdown and click would reintroduce issue #38.
  if (pressHeld(pressedAt, now)) {
    renderDirty = true
    showPauseHint() // reads suspendState() only — a bare press prints nothing (#38)
    return
  }
  const frame = paintAmbient()
  // Drafts and active inspector/page scrolling protect only editable lists. Counts,
  // the badge, rail and Live strip above keep reporting fresh data.
  if (dashboardInteractionActive()
    || shouldDeferRender({ ...suspendState(), pressedAt, scrolledAt: lastInteractionScrollAt }, now)) {
    renderDirty = true
    showPauseHint()
    return
  }
  renderDirty = false
  showPauseHint()
  preparedFrame = frame
  render()
}

// called whenever a draft may have cleared (input emptied, reply sent), or
// bounded scroll activity has settled
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
// for — and the gate is GLOBAL, so it will: suspendState() reports EVERY draft
// anywhere in the app, so one half-typed note on another board silenced the
// human's own Send / Resolve / Archive indefinitely (issue #38). It also cannot serve
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
// refused whenever anything anywhere was half-typed. The write landed
// (POST 200, row in the DB) and the viewer sat on the stale frame across every
// subsequent poll tick. Awaits load() first so the frame paints the SERVER's
// state, not the pre-write snapshot.
//
// The invariant, in one line: `load()` is the poll's, `reloadAndPaint()` is the
// human's. Pinned as source text in test/shell.test.ts, because no runtime
// assertion can see which of the two a handler picked.
async function reloadAndPaint() {
  const loaded = await load()
  forceRender()
  return loaded
}

// the single writer of openRowId — Tasks 11/16/17 call this, never assign.
// `resume: false` is for the ONE caller that is already inside render()
// (render()'s own reconciliation, fix round 2 / C1): resuming from there would
// re-enter render(); the next poll tick renders instead, now unsuspended.
function setOpenRow(id, { resume = true } = {}) {
  if (openRowId !== id) {
    openRowScrollTop = 0
    clearScrollActivity()
  }
  openRowId = id
  if (resume) resumeRender()
  else showPauseHint()
}

// Existing rows keep their relative order for the session; genuinely new work
// appends at the foot. The press guard, not hover state, protects active clicks.
function orderedIds(ids) {
  pinnedIds = pinOrder(pinnedIds, ids)
  return pinnedIds
}

async function load() {
  const generation = ++loadGeneration
  try {
    const res = await fetch('/api/items')
    const boot = res.headers.get('x-inbox-boot')
    if (bootId && boot && bootId !== boot) { location.reload(); return false } // server restarted → pick up fresh frontend
    if (boot) bootId = boot
    const g = await res.json()
    const boards = await (await fetch('/api/boards')).json()
    const archived = await (await fetch('/api/boards/archived')).json()
    const activity = await (await fetch('/api/activity')).json()
    const historySinceMs = Date.now() - 30 * 24 * 60 * 60 * 1000
    const activityHistory = await fetch(`/api/activity/history?since_ms=${historySinceMs}`)
      .then(async (response) => {
        if (!response.ok) return { state: 'error', spans: [], message: `History unavailable (${response.status})` }
        const spans = await response.json()
        return Array.isArray(spans)
          ? { state: 'ready', spans, message: '' }
          : { state: 'error', spans: [], message: 'History returned an invalid payload' }
      })
      .catch((error) => ({
        state: 'error',
        spans: [],
        message: error instanceof Error ? `History unavailable: ${error.message}` : 'History unavailable',
      }))
    // Projects the human closed (issue #32). Defensive on purpose: a viewer that
    // predates this route answers 404 with HTML, a bare .json() would throw into
    // the catch below, and the WHOLE page would read 'disconnected'. An unknown
    // closed set must mean "suppress nothing", never a dead page.
    const closedSnapshot = await fetch('/api/projects/closed')
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
    // Cached PR state (issue #30), same defensive shape and for the same reason:
    // an empty links set must mean "render exactly as before this feature", never
    // a dead page. A viewer that predates this route answers 404 with HTML.
    const links = await fetch('/api/links').then((r) => (r.ok ? r.json() : [])).catch(() => [])
    if (generation < appliedLoadGeneration) return false
    appliedLoadGeneration = generation
    if (closedSnapshot !== null) {
      appliedClosedGeneration = generation
      authoritativeClosed = [...closedSnapshot]
      retireConfirmedProjectMutationIntents(generation)
    }
    lastData = {
      g: ageNotes(g, Date.now()),
      boards,
      archived,
      activity,
      activityHistory,
      closed: [...authoritativeClosed],
      links,
    }
    applyProjectMutationIntents()
    renderIfIdle()
    if (!bootFocusDone) { bootFocusDone = true; applyFocusHash() }
    document.getElementById('status').textContent = ''
    if (closedSnapshot !== null) resolveAuthoritativeRefreshWaiters(generation)
    return closedSnapshot !== null
  } catch (err) {
    // an exception thrown inside render() used to be swallowed here with no
    // console signal at all — a completely dead page with nothing to debug.
    // That is exactly the failure mode behind the "none of the buttons work"
    // incident (0 needs-you items → renderEmptyState threw → blank panel,
    // silently). Log it; keep the 'disconnected' status for genuine fetch failures.
    if (generation < appliedLoadGeneration) return false
    console.error(err)
    document.getElementById('status').textContent = 'disconnected'
    return false
  }
}

// fix round 1 (hardening): every write-path fetch used to await an unguarded request
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

const CARD_FOCUS_SELECTOR = 'button, input, textarea, select, a[href], summary, [tabindex]'

function cardFocusTargets(card) {
  return [...card.querySelectorAll(CARD_FOCUS_SELECTOR)]
}

function rowFocusTargets(card, rowId) {
  const selector = `[data-row-id="${CSS.escape(rowId)}"]`
  const seen = new Set()
  const targets = []
  for (const owner of card.querySelectorAll(selector)) {
    for (const target of cardFocusTargets(owner)) {
      if (seen.has(target)) continue
      seen.add(target)
      targets.push(target)
    }
  }
  return targets
}

function cardFocusKey(el) {
  const text = ['BUTTON', 'SUMMARY'].includes(el.tagName) ? el.textContent?.trim() ?? '' : ''
  return JSON.stringify([
    el.tagName,
    el.getAttribute('type') ?? '',
    el.getAttribute('name') ?? '',
    el.getAttribute('aria-label') ?? '',
    el.getAttribute('href') ?? '',
    typeof el.className === 'string' ? el.className : '',
    text,
  ])
}

function captureCardFocus(card, id) {
  const active = document.activeElement
  if (!active || (active !== card && !card.contains(active))) return null
  const targets = cardFocusTargets(card)
  if (active === card || !targets.includes(active)) return { id, key: null, ordinal: 0 }
  const key = cardFocusKey(active)
  return {
    id,
    key,
    ordinal: targets.filter((target) => cardFocusKey(target) === key).indexOf(active),
  }
}

function restoreCardFocus(bookmark) {
  if (!bookmark || bookmark.id !== openRowId) return false
  const card = needsYouRowEl(bookmark.id)?.querySelector('.nrow-card')
  if (!card) return false
  card.tabIndex = -1
  const matches = bookmark.key
    ? cardFocusTargets(card).filter((target) => cardFocusKey(target) === bookmark.key)
    : []
  const target = matches[bookmark.ordinal] ?? card
  target.focus({ preventScroll: true })
  if (document.activeElement !== target && target !== card) card.focus({ preventScroll: true })
  return document.activeElement === card || card.contains(document.activeElement)
}

function focusedAskedTimeId() {
  const active = document.activeElement
  if (!active?.matches?.('.nrow-asked')) return null
  return active.closest('.nrow[data-card-id]')?.dataset.cardId ?? null
}

function restoreAskedTimeFocus(id) {
  if (!id) return false
  const target = needsYouRowEl(id)?.querySelector('.nrow-asked')
  if (!target) return false
  target.focus({ preventScroll: true })
  return document.activeElement === target
}

function pagedCardFocusBookmark() {
  const active = document.activeElement
  const card = active?.closest?.('#notes [data-card-id], #done [data-card-id], #boards [data-card-id]')
  if (!card) return null
  const rowId = active.closest('[data-row-id]')?.dataset.rowId ?? null
  if (rowId) {
    const targets = rowFocusTargets(card, rowId)
    if (!targets.includes(active)) return null
    const key = cardFocusKey(active)
    return {
      id: card.dataset.cardId,
      section: card.closest('section')?.id ?? '',
      rowId,
      key,
      ordinal: targets.filter((target) => cardFocusKey(target) === key).indexOf(active),
    }
  }
  const bookmark = captureCardFocus(card, card.dataset.cardId)
  if (!bookmark) return null
  return { ...bookmark, section: card.closest('section')?.id ?? '', rowId: null }
}

function restorePagedCardFocus(bookmark) {
  if (!bookmark) return false
  const scope = bookmark.section ? document.getElementById(bookmark.section) : document
  const card = scope?.querySelector(`[data-card-id="${CSS.escape(bookmark.id)}"]`)
  if (!card) return false
  const targets = bookmark.rowId ? rowFocusTargets(card, bookmark.rowId) : cardFocusTargets(card)
  const matches = bookmark.key
    ? targets.filter((target) => cardFocusKey(target) === bookmark.key)
    : []
  const exact = matches[bookmark.ordinal] ?? (bookmark.rowId ? targets[0] : null)
  const fallback = card.querySelector(':scope > summary') ?? card
  for (const target of [exact, fallback]) {
    if (!target) continue
    revealDetailsAncestors(target)
    if (target.closest('[hidden], details:not([open])')) continue
    target.tabIndex = 0
    target.focus({ preventScroll: true })
    if (document.activeElement === target) return true
  }
  return false
}

// Which tab holds an item — a deep link must land on the right one.
function tabForItem(it) {
  if (lastData.g.notes.some((gr) => gr.items.some((x) => x.id === it.id))) return 'notes'
  if (lastData.g.done.some((x) => x.id === it.id)) return 'done'
  return 'needsYou'
}

// Notification click / URL hash entry point (spec §11): select the item's
// project, switch to its tab, expand it, scroll to it.
function focusItem(id, source = null) {
  if (!lastData) return
  const item = allItems(lastData.g).find((i) => i.id === id)
  const board = [...lastData.boards, ...lastData.archived].find((b) => b.id === id)
  const target = item ?? board
  if (!target) return
  const hasSearchSource = source && (
    typeof source.text === 'string'
    || Array.isArray(source.fragments)
    || typeof source.field === 'string'
  )
  if (hasSearchSource) searchJumpSource = { targetId: id, ...source }
  else if (searchJumpSource?.targetId !== id) searchJumpSource = null
  pendingFocusId = id
  if (source?.rowId) {
    openRows.add(source.rowId)
    if (board) showDoneBoards.add(board.id)
  }
  if (source?.field === 'context') {
    openContexts.add(source.rowId ? `row:${source.rowId}` : `item:${id}`)
  }
  projectFilter = target.project
  agentFilter = null
  actionFilter = 'all'
  changedOnly = false
  resetSearch()
  selectTab(board ? 'boards' : tabForItem(item)) // Task 8: sets activeTab AND shows the panel
  const hash = focusHashFor(id)
  if (location.hash !== hash) location.hash = hash // survives reload
  forceRender()
  // fix round 2 (C1): this used to call setOpenRow(id) for EVERY target. The
  // inspector is a Needs-you affordance — explicit collapse is reachable only
  // from a rendered `.nrow`. A board
  // id (electron/main.cjs deep-links a blocked row with focusHashFor(board.id),
  // one notification click away) or a notes/done item id has none, so
  // shouldSuspendRender() stayed true forever: load() kept updating lastData
  // while the DOM, all four tab counts and document.title froze, and Escape's
  // `collapse` intent no-op'd against a `.nrow` that never existed. Claim the
  // inspector only once the target has actually landed in the list — render()
  // above put it there — then render again so the card body mounts under it.
  const queueTarget = needsYouRowEl(id)
  if (queueTarget) {
    for (let node = queueTarget; node; node = node.parentElement) {
      if (node.tagName !== 'DETAILS') continue
      node.open = true
      if (node.classList.contains('snoozed-fold')) snoozedFoldOpen = true
      else if (node.classList.contains('stale-fold')) staleFoldOpen = true
    }
    selectRow(id)
  }
  if (queueTarget) setOpenRow(id)
  if (queueTarget) forceRender()
  requestAnimationFrame(() => {
    const el = document.querySelector(`[data-card-id="${CSS.escape(id)}"]`)
    if (!el) return
    pendingFocusId = null
    // Open every ancestor <details> fold on the way up, not just the target —
    // a deep link that lands on the right tab but leaves the target buried
    // inside a collapsed stale-fold/archived-fold LOOKS like it worked while
    // showing nothing, which is worse than doing nothing. Flip the matching
    // module flag too: the next 3s poll rebuilds these folds from
    // staleFoldOpen/showArchived, and a DOM-only open doesn't survive that
    // rebuild (the same persistence trap already fixed once for the stale
    // fold in isolation).
    const sourceEl = applySearchJumpHighlight()
    const scrollTarget = sourceEl ?? el
    revealDetailsAncestors(scrollTarget)
    scrollTarget.scrollIntoView({ behavior: 'smooth', block: 'center' })
    const contextSummary = sourceEl?.closest('.card-context')?.querySelector(':scope > summary')
    const focusTarget = contextSummary
      ?? (el.matches('details') ? el.querySelector(':scope > summary') : el)
    if (focusTarget) {
      focusTarget.tabIndex = 0
      focusTarget.focus({ preventScroll: true })
    }
  })
}

function searchElements() {
  return {
    dock: document.querySelector('.floating-search'),
    input: document.getElementById('search'),
    results: document.getElementById('searchResults'),
    status: document.getElementById('searchStatus'),
  }
}

function setSearchActive(index) {
  const { input, results } = searchElements()
  const options = [...(results?.querySelectorAll('[role="option"]') ?? [])]
  searchActiveIndex = options.length ? Math.max(0, Math.min(index, options.length - 1)) : -1
  for (const [optionIndex, option] of options.entries()) {
    const active = optionIndex === searchActiveIndex
    option.setAttribute('aria-selected', String(active))
    if (active) option.scrollIntoView({ block: 'nearest' })
  }
  const active = options[searchActiveIndex]
  if (input) {
    if (active) input.setAttribute('aria-activedescendant', active.id)
    else input.removeAttribute('aria-activedescendant')
  }
}

function clearSearchResultView() {
  const { input, results, status } = searchElements()
  searchIndexOpen = false
  searchUpdating = false
  searchActiveIndex = -1
  searchResultCache = []
  searchResultSignature = ''
  if (results) {
    results.hidden = true
    results.innerHTML = ''
    results.removeAttribute('aria-busy')
    delete results.dataset.updating
  }
  if (status) status.textContent = ''
  input?.setAttribute('aria-expanded', 'false')
  input?.removeAttribute('aria-activedescendant')
}

function beginSearchUpdate() {
  const { input, results } = searchElements()
  searchUpdating = true
  if (!results || results.hidden) return
  results.dataset.updating = 'true'
  results.setAttribute('aria-busy', 'true')
  for (const option of results.querySelectorAll('[role="option"]')) {
    option.setAttribute('aria-disabled', 'true')
  }
  input?.removeAttribute('aria-activedescendant')
}

function finishSearchUpdate() {
  const { results } = searchElements()
  searchUpdating = false
  if (!results) return
  results.removeAttribute('aria-busy')
  delete results.dataset.updating
  for (const option of results.querySelectorAll('[role="option"]')) {
    option.removeAttribute('aria-disabled')
  }
}

function closeSearchResults() {
  if (searchTimer) {
    clearTimeout(searchTimer)
    searchTimer = null
  }
  clearSearchResultView()
}

function resetSearch({ blur = false } = {}) {
  if (searchTimer) {
    clearTimeout(searchTimer)
    searchTimer = null
  }
  searchQuery = ''
  const { input } = searchElements()
  if (input) input.value = ''
  closeSearchResults()
  if (blur && input === document.activeElement) input.blur()
}

function activateSearchResult(index = searchActiveIndex) {
  if (searchUpdating || searchTimer) return
  const result = searchResultCache[index]
  if (!result) return
  const available = lastData && (
    allItems(lastData.g).some((item) => item.id === result.targetId)
    || [...lastData.boards, ...lastData.archived].some((board) => board.id === result.targetId)
  )
  if (!available) {
    renderSearchResults()
    return
  }
  focusItem(result.targetId, result.source)
}

function appendHighlightedText(element, text, ranges) {
  let cursor = 0
  for (let index = 0; index < ranges.length; index += 2) {
    const start = Math.max(cursor, Math.min(text.length, ranges[index] ?? 0))
    const end = Math.max(start, Math.min(text.length, ranges[index + 1] ?? start))
    if (start > cursor) element.append(document.createTextNode(text.slice(cursor, start)))
    if (end > start) {
      const mark = document.createElement('mark')
      mark.textContent = text.slice(start, end)
      element.append(mark)
    }
    cursor = end
  }
  if (cursor < text.length) element.append(document.createTextNode(text.slice(cursor)))
}

function searchResultContent(option, result) {
  option.replaceChildren()
  const title = document.createElement('span')
  title.className = 'search-result-main'
  appendHighlightedText(title, result.title, result.titleRanges)
  const kind = document.createElement('span')
  kind.className = 'search-result-kind'
  kind.textContent = result.kind
  const context = document.createElement('span')
  context.className = 'search-result-context'
  context.textContent = result.context
  option.append(title, kind)
  if (result.match) {
    const match = document.createElement('span')
    match.className = 'search-result-match'
    const source = document.createElement('span')
    source.className = 'search-result-match-source'
    source.textContent = result.match.label
    const value = document.createElement('span')
    value.className = 'search-result-match-value'
    appendHighlightedText(value, result.match.text, result.match.ranges)
    match.append(source, document.createTextNode(' · '), value)
    option.appendChild(match)
  }
  option.appendChild(context)
}

function sameSearchResultOrder(previous, next) {
  return previous.length === next.length && previous.every((result, index) => (
    result.key === next[index]?.key && result.section === next[index]?.section
  ))
}

function searchJumpRoot(source) {
  const card = document.querySelector(`[data-card-id="${CSS.escape(source.targetId)}"]`)
  if (!card) return null
  if (source.rowId) {
    if (source.field === 'label') {
      return card.querySelector(`.board-row[data-row-id="${CSS.escape(source.rowId)}"]`)
    }
    return card.querySelector(
      `.row-panel-row[data-row-id="${CSS.escape(source.rowId)}"] .row-panel`,
    ) ?? card.querySelector(`.board-row[data-row-id="${CSS.escape(source.rowId)}"]`)
  }
  if (source.field !== 'title' && card.classList.contains('nrow')) {
    return card.querySelector('.nrow-card') ?? card
  }
  return card
}

const SEARCH_SOURCE_SELECTORS = {
  title: '.nrow-title, .card-title, .board-title',
  label: '.row-label',
  detail: '.card-tldr-body',
  note: '.card-tldr-body, .note-line',
  'next-step': '.card-next-body',
  owner: '.action-owner',
  impact: '.card-impact',
  next: '.card-after',
  context: '.card-context-body',
  annotation: '.annotation',
  reply: '.reply-block',
  'reply-context': '.reply-context',
  outcome: '.outcome-block',
  option: '.option, .opt-pill',
  'option-detail': '.option',
  project: '.card-meta, .board-meta, .meta',
  stream: '.card-meta, .board-meta, .meta',
  agent: '.card-meta, .board-meta, .meta',
}

function normalizedSearchText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

function findSearchJumpSource(source) {
  const root = searchJumpRoot(source)
  if (!root) return null
  let candidates
  if (source.field === 'context') {
    const key = source.rowId ? `row:${source.rowId}` : `item:${source.targetId}`
    const details = root.querySelector(`.card-context[data-context-key="${CSS.escape(key)}"]`)
    candidates = details ? [...details.querySelectorAll('.card-context-body')] : []
  } else {
    const selector = SEARCH_SOURCE_SELECTORS[source.field]
    candidates = selector ? [...root.querySelectorAll(selector)] : []
  }
  const fullText = normalizedSearchText(source.text)
  const fragments = source.fragments.map(normalizedSearchText).filter(Boolean)
  return candidates
    .map((element) => {
      const text = normalizedSearchText(element.textContent)
      const exact = fullText && text === fullText
      const contains = fullText && text.includes(fullText)
      const matchedFragments = fragments.filter((fragment) => text.includes(fragment)).length
      return {
        element,
        score: exact ? 0 : contains ? 1 : matchedFragments === fragments.length && fragments.length ? 2 : matchedFragments ? 3 : 4,
        length: text.length,
      }
    })
    .filter((candidate) => candidate.score < 4)
    .sort((left, right) => left.score - right.score || left.length - right.length)[0]?.element ?? null
}

function escapeSearchRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function highlightSearchJumpSource(element, fragments) {
  const terms = [...new Set(fragments.map((fragment) => fragment.trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length)
  if (!terms.length) return
  const matcher = new RegExp(terms.map(escapeSearchRegExp).join('|'), 'giu')
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  const nodes = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest('.search-jump-highlight')) nodes.push(node)
  }
  for (const node of nodes) {
    const text = node.nodeValue ?? ''
    matcher.lastIndex = 0
    const matches = [...text.matchAll(matcher)]
    if (!matches.length) continue
    const replacement = document.createDocumentFragment()
    let cursor = 0
    for (const match of matches) {
      const start = match.index ?? 0
      if (start > cursor) replacement.append(document.createTextNode(text.slice(cursor, start)))
      const mark = document.createElement('mark')
      mark.className = 'search-jump-highlight'
      mark.textContent = match[0]
      replacement.appendChild(mark)
      cursor = start + match[0].length
    }
    if (cursor < text.length) replacement.append(document.createTextNode(text.slice(cursor)))
    node.replaceWith(replacement)
  }
}

function applySearchJumpHighlight() {
  if (!searchJumpSource) return null
  const source = findSearchJumpSource(searchJumpSource)
  if (!source) return null
  highlightSearchJumpSource(source, searchJumpSource.fragments)
  return source
}

function renderSearchResults() {
  const { input, results, status } = searchElements()
  if (!input || !results) return
  const query = searchQuery.trim()
  if (searchTimer) return
  if (!searchIndexOpen || !query) {
    closeSearchResults()
    return
  }
  if (!lastData) return
  const previousActiveKey = searchResultCache[searchActiveIndex]?.key
  const previousResults = searchResultCache
  const nextResults = buildSearchResults(lastData, query, fuzzySearch)
  const nextSignature = JSON.stringify([query, nextResults])
  if (!results.hidden && searchResultSignature === nextSignature) {
    searchResultCache = nextResults
    finishSearchUpdate()
    input.setAttribute('aria-expanded', 'true')
    return
  }
  const existingOptions = [...results.querySelectorAll('[role="option"]')]
  const reconcile = !results.hidden
    && nextResults.length > 0
    && sameSearchResultOrder(previousResults, nextResults)
    && existingOptions.length === nextResults.length
  searchResultCache = nextResults
  searchResultSignature = nextSignature
  results.hidden = false
  input.setAttribute('aria-expanded', 'true')

  if (!searchResultCache.length) {
    results.innerHTML = ''
    const empty = document.createElement('p')
    empty.className = 'search-results-empty'
    empty.textContent = `No results for “${query}”`
    results.appendChild(empty)
    if (status) status.textContent = `No results for ${query}`
    finishSearchUpdate()
    setSearchActive(-1)
    return
  }

  if (reconcile) {
    for (const [index, result] of searchResultCache.entries()) {
      searchResultContent(existingOptions[index], result)
    }
  } else {
    results.innerHTML = ''
    let group = null
    let currentSection = null
    for (const [index, result] of searchResultCache.entries()) {
      if (result.section !== currentSection) {
        currentSection = result.section
        const labelId = `search-result-group-${result.section}`
        group = document.createElement('div')
        group.className = 'search-result-group'
        group.setAttribute('role', 'group')
        group.setAttribute('aria-labelledby', labelId)
        const groupLabel = document.createElement('span')
        groupLabel.id = labelId
        groupLabel.className = 'search-result-group-label'
        groupLabel.textContent = result.sectionLabel
        group.appendChild(groupLabel)
        results.appendChild(group)
      }
      const option = document.createElement('div')
      option.id = `search-result-${index}`
      option.className = 'search-result'
      option.setAttribute('role', 'option')
      option.setAttribute('aria-selected', 'false')
      option.tabIndex = -1
      option.dataset.searchTarget = result.targetId
      searchResultContent(option, result)
      option.addEventListener('pointerdown', (event) => event.preventDefault())
      option.addEventListener('pointermove', () => setSearchActive(index))
      option.addEventListener('click', () => activateSearchResult(index))
      group?.appendChild(option)
    }
  }
  finishSearchUpdate()
  if (status) {
    status.textContent = `${searchResultCache.length} search result${searchResultCache.length === 1 ? '' : 's'}`
  }
  const preservedIndex = previousActiveKey
    ? searchResultCache.findIndex((result) => result.key === previousActiveKey)
    : -1
  setSearchActive(preservedIndex >= 0 ? preservedIndex : 0)
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
// Notes tab and the Done tab agree
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

function dashboardEntryEntity(entry) {
  return entry?.kind === 'row' ? entry.row : entry?.item
}

function dashboardEntryTitle(entry) {
  const entity = dashboardEntryEntity(entry)
  return entry?.kind === 'row' ? entity?.label : entity?.title
}

function dashboardEntryProject(entry) {
  return entry?.kind === 'row' ? entry.board?.project : entry?.item?.project
}

function dashboardTarget(target) {
  if (target === 'live') {
    document.getElementById('liveStrip')?.click()
    return
  }
  if (target === 'outcomes') {
    openRelay()
    return
  }
  selectTab(target)
}

function dashboardInteractionActive() {
  return activeTab === 'dashboard' && Boolean(document.activeElement?.closest?.('#dashboard'))
}

function dashboardFocusBookmark() {
  return document.activeElement?.closest?.('#dashboard [data-dashboard-focus-key]')?.dataset.dashboardFocusKey ?? null
}

function restoreDashboardFocus(key) {
  if (!key || activeTab !== 'dashboard') return false
  const target = document.querySelector(`#dashboard [data-dashboard-focus-key="${CSS.escape(key)}"]`)
  if (!target) return false
  target.focus({ preventScroll: true })
  return document.activeElement === target
}

function renderDashboardAmbient(model) {
  const values = {
    agents: model.signals.agents.working,
    waiting: model.signals.waiting,
    plans: model.signals.plans,
    outcomes: model.signals.outcomes,
  }
  for (const [name, value] of Object.entries(values)) {
    const el = document.querySelector(`[data-dashboard-signal="${name}"] .dashboard-value`)
    if (el) el.textContent = String(value)
  }
  const total = document.querySelector('[data-dashboard-signal="agents"] .dashboard-value-total')
  if (total) total.textContent = `/${model.signals.agents.total}`
  const dots = document.querySelector('[data-dashboard-signal="agents"] .dashboard-agent-dots')
  if (dots) {
    const fragment = document.createDocumentFragment()
    for (let index = 0; index < model.signals.agents.total; index += 1) {
      const dot = document.createElement('span')
      dot.className = `dashboard-agent-dot ${index < model.signals.agents.working ? 'active' : 'quiet'}`
      fragment.appendChild(dot)
    }
    dots.replaceChildren(fragment)
  }
  const childCount = model.signals.agents.reportedChildren
  const childContribution = childCount > 0
    ? `, including ${childCount} reported child agent${childCount === 1 ? '' : 's'}`
    : ''
  const labels = {
    agents: `Active agents: ${model.signals.agents.working} of ${model.signals.agents.total} present${childContribution}`,
    waiting: `Needs you: ${model.signals.waiting} open action${model.signals.waiting === 1 ? '' : 's'}`,
    plans: `Plans: ${model.signals.plans} across ${model.signals.projects} project${model.signals.projects === 1 ? '' : 's'}`,
    outcomes: `Recorded outcomes: ${model.signals.outcomes} across items and plan rows`,
  }
  for (const [name, label] of Object.entries(labels)) {
    const card = document.querySelector(`[data-dashboard-signal="${name}"]`)
    if (card) card.setAttribute('aria-label', label)
  }
}

const DASHBOARD_SIGNAL_ICONS = {
  agents: '<circle cx="8" cy="4" r="2"></circle><circle cx="4" cy="12" r="2"></circle><circle cx="12" cy="12" r="2"></circle><path d="M8 6v3M6.5 9.5 5 10.5M9.5 9.5l1.5 1"></path>',
  waiting: '<path d="M2 3h12v10H2zM2 9h3l1.5 2h3L11 9h3"></path>',
  plans: '<path d="M3 2h10v12H3zM5.5 5h5M5.5 8h5M5.5 11h3"></path>',
  outcomes: '<circle cx="8" cy="8" r="6"></circle><path d="m5 8 2 2 4-4"></path>',
}

function dashboardSignal({ name, label, value, total = null, target, tone, meter = false }) {
  const card = document.createElement('button')
  card.type = 'button'
  card.className = `dashboard-signal tone-${tone}`
  card.dataset.dashboardSignal = name
  card.dataset.dashboardTarget = target
  card.dataset.dashboardFocusKey = `signal:${name}`
  card.innerHTML = `
    <span class="dashboard-signal-head">
      <span class="dashboard-signal-label">${esc(label)}</span>
      <svg class="dashboard-signal-icon" viewBox="0 0 16 16" aria-hidden="true">${DASHBOARD_SIGNAL_ICONS[name] ?? ''}</svg>
    </span>
    <span class="dashboard-value-group">
      <span class="dashboard-value">${esc(String(value))}</span>
      ${total == null ? '' : `<span class="dashboard-value-total">/${esc(String(total))}</span>`}
    </span>
    ${meter ? '<span class="dashboard-agent-dots" aria-hidden="true"></span>' : ''}
    <span class="dashboard-signal-arrow" aria-hidden="true">→</span>`
  card.addEventListener('click', () => dashboardTarget(target))
  return card
}

function formatDuration(ms) {
  const totalMinutes = Math.round(ms / 60000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (!hours) return `${minutes}m`
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`
}

function renderDashboard(model) {
  const host = document.querySelector('#dashboard .dashboard')
  if (!host) return
  host.replaceChildren()

  const signals = document.createElement('div')
  signals.className = 'dashboard-signals'
  signals.append(
    dashboardSignal({
      name: 'agents',
      label: 'Active agents',
      value: model.signals.agents.working,
      total: model.signals.agents.total,
      target: 'live',
      tone: 'agent',
      meter: true,
    }),
    dashboardSignal({
      name: 'waiting',
      label: 'Needs you',
      value: model.signals.waiting,
      target: 'needsYou',
      tone: 'attention',
    }),
    dashboardSignal({
      name: 'plans',
      label: 'Plans',
      value: model.signals.plans,
      target: 'boards',
      tone: 'plan',
    }),
    dashboardSignal({
      name: 'outcomes',
      label: 'Recorded outcomes',
      value: model.signals.outcomes,
      target: 'outcomes',
      tone: 'outcome',
    }),
  )
  host.appendChild(signals)

  const grid = document.createElement('div')
  grid.className = 'dashboard-grid'

  const activityPanel = document.createElement('section')
  activityPanel.className = 'dashboard-card dashboard-activity'
  const activityHead = document.createElement('div')
  activityHead.className = 'dashboard-card-head'
  activityHead.innerHTML = '<h2>Agent activity</h2>'
  const range = document.createElement('select')
  range.className = 'dashboard-range'
  range.dataset.dashboardFocusKey = 'activity-range'
  range.setAttribute('aria-label', 'Dashboard activity range')
  for (const [label, value] of [['24 hours', 86400000], ['7 days', 604800000], ['30 days', 2592000000]]) {
    const option = document.createElement('option')
    option.textContent = label
    option.value = String(value)
    range.appendChild(option)
  }
  range.value = String(dashboardRangeMs)
  range.addEventListener('change', () => {
    dashboardRangeMs = Number(range.value)
    forceRender()
  })
  activityHead.appendChild(range)
  activityPanel.appendChild(activityHead)

  const endMs = Date.now()
  const bucketCount = dashboardRangeMs === 86400000 ? 24 : dashboardRangeMs === 604800000 ? 14 : 30
  const history = lastData.activityHistory ?? { state: 'ready', spans: [], message: '' }
  const historySpans = (history.spans ?? []).filter((span) =>
    !dashboardClosedSet().has(span.project)
    && (!projectFilter || span.project === projectFilter)
    && (!agentFilter || span.agent === agentFilter))
  const series = buildActivitySeries(historySpans, {
    startMs: endMs - dashboardRangeMs,
    endMs,
    bucketCount,
  })
  if (history.state === 'error') {
    activityPanel.classList.add('is-empty')
    const error = document.createElement('div')
    error.className = 'dashboard-history-empty dashboard-history-error'
    error.title = history.message
    error.innerHTML = '<strong>History unavailable</strong>'
    activityPanel.appendChild(error)
  } else if (!series.hasHistory) {
    activityPanel.classList.add('is-empty')
    const empty = document.createElement('div')
    empty.className = 'dashboard-history-empty'
    empty.setAttribute('role', 'img')
    empty.setAttribute('aria-label', 'No activity history yet')
    empty.title = 'No activity history yet'
    empty.innerHTML = '<svg class="dashboard-empty-icon" viewBox="0 0 32 20" aria-hidden="true"><path d="M1 15h5l3-9 5 12 4-8 3 5h10"></path></svg>'
    activityPanel.appendChild(empty)
  } else {
    const total = document.createElement('div')
    total.className = 'dashboard-activity-total'
    total.innerHTML = `<strong>${esc(formatDuration(series.totalActiveMs))}</strong>`
    activityPanel.appendChild(total)
    const max = Math.max(...series.buckets.map((bucket) => bucket.activeMs), 1)
    const bars = document.createElement('div')
    bars.className = 'dashboard-bars'
    bars.setAttribute('role', 'img')
    bars.setAttribute('aria-label', `${formatDuration(series.totalActiveMs)} of agent claim time`)
    for (const bucket of series.buckets) {
      const bar = document.createElement('span')
      bar.className = 'dashboard-bar'
      bar.style.height = `${Math.max(4, (bucket.activeMs / max) * 100)}%`
      bar.title = `${formatDuration(bucket.activeMs)} · ${bucket.sessions} session${bucket.sessions === 1 ? '' : 's'}`
      bars.appendChild(bar)
    }
    activityPanel.appendChild(bars)
  }
  grid.appendChild(activityPanel)

  const ownership = document.createElement('section')
  ownership.className = 'dashboard-card dashboard-ownership'
  ownership.innerHTML = `
    <div class="dashboard-card-head"><h2>Ownership flow</h2></div>
    <div class="dashboard-flow">
      <button type="button" data-flow-target="needsYou" data-dashboard-focus-key="flow:human" class="flow-human"><span>Waiting on you</span><strong>${esc(String(model.ownership.human))}</strong></button>
      <div class="dashboard-flow-line" aria-hidden="true"></div>
      <button type="button" data-flow-target="needsYou" data-dashboard-focus-key="flow:agent" class="flow-agent"><span>With agents</span><strong>${esc(String(model.ownership.agent))}</strong></button>
      <div class="dashboard-flow-line" aria-hidden="true"></div>
      <button type="button" data-flow-target="outcomes" data-dashboard-focus-key="flow:outcome" class="flow-outcome"><span>Outcome</span><strong>${esc(String(model.ownership.outcome))}</strong></button>
    </div>`
  for (const button of ownership.querySelectorAll('[data-flow-target]')) {
    button.addEventListener('click', () => dashboardTarget(button.dataset.flowTarget))
  }
  grid.appendChild(ownership)

  const live = document.createElement('section')
  live.className = 'dashboard-card dashboard-dispatch'
  live.innerHTML = '<div class="dashboard-card-head"><h2>Live dispatch</h2></div>'
  const sessionList = document.createElement('div')
  sessionList.className = 'dashboard-live-list'
  if (!model.sessions.length) {
    sessionList.innerHTML = '<div class="dashboard-empty" role="img" aria-label="No agent sessions" title="No agent sessions"><svg class="dashboard-empty-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v4M12 18v4M2 12h4M18 12h4"></path></svg></div>'
  } else {
    for (const session of model.sessions.slice(0, 4)) {
      const row = document.createElement('div')
      row.className = `dashboard-live-session${session.idle ? ' idle' : ''}`
      const identity = document.createElement('strong')
      identity.textContent = `${session.project} / ${session.agent}`
      const doing = document.createElement('span')
      doing.textContent = session.synopsis
      const state = document.createElement('small')
      state.textContent = session.idle ? 'quiet' : 'working'
      row.append(identity, doing, state)
      sessionList.appendChild(row)
    }
  }
  live.appendChild(sessionList)
  grid.appendChild(live)

  const outcomes = document.createElement('section')
  outcomes.className = 'dashboard-card dashboard-outcomes'
  outcomes.innerHTML = '<div class="dashboard-card-head"><h2>Recent outcomes</h2></div>'
  const outcomeList = document.createElement('div')
  outcomeList.className = 'dashboard-outcome-list'
  if (!model.recentOutcomes.length) {
    outcomeList.innerHTML = '<div class="dashboard-empty" role="img" aria-label="No recorded outcomes" title="No recorded outcomes"><svg class="dashboard-empty-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"></circle><path d="m8 12 2.5 2.5L16 9"></path></svg></div>'
  } else {
    for (const entry of model.recentOutcomes.slice(0, 4)) {
      const entity = dashboardEntryEntity(entry)
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'dashboard-outcome'
      row.dataset.dashboardFocusKey = `outcome:${entry.kind === 'item' ? entry.item.id : entry.row.id}`
      const title = document.createElement('strong')
      title.textContent = dashboardEntryTitle(entry) ?? 'Recorded outcome'
      const result = document.createElement('span')
      result.textContent = entity?.outcome ?? ''
      const meta = document.createElement('small')
      meta.textContent = dashboardEntryProject(entry) ?? ''
      row.append(title, result, meta)
      row.addEventListener('click', () => {
        if (entry.kind === 'item') focusItem(entry.item.id)
        else focusItem(entry.board.id, { rowId: entry.row.id })
      })
      outcomeList.appendChild(row)
    }
  }
  outcomes.appendChild(outcomeList)
  grid.appendChild(outcomes)

  host.appendChild(grid)
  renderDashboardAmbient(model)
}

function paintAmbient() {
  applyBadge()
  // issue #30 — rebuilt ONCE here, before any renderer runs, so the row chips,
  // the card blocks and the board chips all read the same snapshot. It feeds
  // nothing in applyBadge / attentionCount on purpose: PR state is ambient, and
  // a red CI must never move the badge (tenets 1 and 2).
  linkIndex = indexLinks(lastData.links ?? [])
  renderRail()
  // AFTER renderRail: renderRail is what reconciles a stale projectFilter, and
  // withoutClosed reads projectFilter to decide whether this is a peek.
  visibleData = withoutClosed(lastData)
  const agents = collectAgents(projectScoped(visibleData))
  if (agentFilter && !agents.includes(agentFilter)) agentFilter = null
  // prune collapse state against ALL cards, not the filtered view (nor the
  // closure-narrowed one), so switching tabs never drops state for cards the
  // filter is hiding
  liveCardIds = new Set([...allItems(lastData.g).map((i) => i.id), ...lastData.boards.map((b) => b.id), ...lastData.archived.map((b) => b.id)])
  const filtered = filterData(visibleData)
  const { g, boards, archived } = filtered
  const pillLive = (lastData.activity ?? []).filter((a) =>
    (!projectFilter || a.project === projectFilter) && (!agentFilter || a.agent === agentFilter))
  const live = pillLive
  const dashboard = buildDashboard({
    items: allItems(g),
    boards,
    archived,
    activity: live,
    nowMs: Date.now(),
    liveSessionIds: liveSessionIds(),
    closedProjects: dashboardClosedProjects(),
  })
  renderLiveBar(lastData.activity ?? [])    // collapsed strip — GLOBAL, never scoped (§7 filter-blindness, generalized)
  renderDashboardAmbient(dashboard)
  paintTabCounts(g, boards)
  return { agents, g, boards, archived, live, dashboard }
}

function paintTabCounts(g, boards) {
  // Needs-you counts the GLOBAL attention set; every other tab counts the
  // filtered view the user is actually looking at (spec §7).
  const counts = tabCounts({
    globalAttention: attentionCount(allItems(lastData.g), lastData.boards, Date.now(), liveSessionIds(), lastData.closed ?? []),
    unreadNotes: unreadNoteCount(g.notes.flatMap((gr) => gr.items), notesSeenAt, Date.now(), notesSeenIds),
    scoped: { boards, done: g.done },
  })
  for (const id of TAB_IDS) setCount(id, counts[id])
}

function paintEditableSurfaces({ agents, g, boards, archived, live, dashboard }) {
  renderSearchResults()
  renderClosedBanner()
  renderAgentSelect(agents)
  renderLive(live) // drawer's expanded list — stays FILTERED (rail-scoped, like every other tab)
  renderDashboard(dashboard)
  renderNeedsYou(g, boards, Date.now())
  renderGroups('notes', g.notes)
  renderDone(g.done)
  renderBoards(boards, archived)
  // renderGroups may have marked visible notes read. Recount only on a full
  // editable frame; a draft-gated ambient frame must never mark unseen notes.
  paintTabCounts(g, boards)
  pruneCollapsedCards()
  // The render that just happened is the authority on what remains collapsible.
  // A deep link or filter can name a board, a hidden item, or a paged-away row;
  // reconcile stale open state now so it cannot leak into a later render.
  const nextOpen = reconcileOpenRow(openRowId, allRowEls().map((el) => el.dataset.cardId))
  // still through setOpenRow — it stays the single writer of openRowId
  if (nextOpen !== openRowId) setOpenRow(nextOpen, { resume: false })
  renderTriage() // keep the open lightbox in sync with fresh data
  renderRelay() // same entities, projected into human → agent → outcome lanes
  renderMission() // selected board, projected through explicit row next/outcome edges
}

function render() {
  const frame = preparedFrame ?? paintAmbient()
  preparedFrame = null
  const missionFocus = captureMissionFocus()
  const dashboardFocus = dashboardFocusBookmark()
  const draftFocus = activeDraftFocusBookmark() ?? requestedDraftFocusBookmark
  const pagedFocus = pagedCardFocusBookmark()
  pagedFocusId = pagedFocus?.id ?? null
  if (document.activeElement?.closest?.('.stale-drafts-fold')) draftRecoveryFocusPending = true
  reconcileDraftOwners()
  requestedDraftFocusBookmark = null
  paintEditableSurfaces(frame)
  pagedFocusId = null
  if (missionFocus && missionBoardId) {
    restoreMissionFocus(missionFocus)
  } else if (!restoreDashboardFocus(dashboardFocus)
    && !restoreDraftRecoveryFocus() && !restoreDraftFocus(draftFocus)) {
    restorePagedCardFocus(pagedFocus)
  }
  applySearchJumpHighlight()
}

// one age vocabulary for every surface (§6): rows, chips, Live and tooltips all
// format through relMs()
function rel(iso) {
  return relMs(Date.now() - Date.parse(iso))
}

// ── triage mode: step through the needs-input set one card at a time ──
let triageDeck = null // { entries, index } while the lightbox is open
let triageReturnFocus = null
const rowDrafts = {}  // in-progress row annotations, surviving the poll rebuild
const rowDraftKinds = {} // row id → answer|clarify|decline, surviving accordion remounts
const rowDraftMeta = {} // row id → recovery labels/revision if its owner disappears
const rowDraftGenerations = {} // row id → monotonic edit token across duplicate editors
const rowSubmissionTokens = {} // row id → latest async submission allowed to retire its draft
const staleRowDrafts = {} // row-id + revision key → one refused action response
let requestedDraftFocusBookmark = null
let draftRecoveryFocusPending = false
let draftRecoveryTarget = null

function rowDraftRecoveryKey(rowId, revision) {
  return JSON.stringify([rowId, revision])
}

function bumpDraftGeneration(generations, id) {
  const next = (generations[id] ?? 0) + 1
  generations[id] = next
  return next
}

function clearRowRecoveryTarget(rowId, revision) {
  if (draftRecoveryTarget?.rowId === rowId && draftRecoveryTarget.revision === revision) {
    draftRecoveryTarget = null
  }
}

function recoverMismatchedRenderedRowDraft(b, r) {
  const text = rowDrafts[r.id]
  const meta = rowDraftMeta[r.id]
  if (!String(text ?? '').trim() || !meta || meta.revision === r.revision) return false
  const revision = meta.revision ?? -1
  staleRowDrafts[rowDraftRecoveryKey(r.id, revision)] = {
    rowId: r.id,
    revision,
    actionVersion: meta.actionVersion,
    text,
    kind: rowDraftKinds[r.id] ?? 'answer',
    boardTitle: meta.boardTitle ?? b.title,
    label: meta.label ?? r.label,
    context: meta.context ?? '',
  }
  bumpDraftGeneration(rowDraftGenerations, r.id)
  delete rowDrafts[r.id]
  delete rowDraftKinds[r.id]
  delete rowDraftMeta[r.id]
  requestAnimationFrame(() => {
    requestDraftRecovery(null)
    forceRender()
  })
  return true
}

function activeDraftFocusBookmark() {
  const active = document.activeElement
  const key = active?.dataset?.draftFocusKey
  if (!key) return null
  return { key, scopeId: active.closest('[id]')?.id ?? null }
}

function restoreDraftFocus(bookmark) {
  if (!bookmark) return false
  const scope = bookmark.scopeId ? document.getElementById(bookmark.scopeId) : document
  const input = scope?.querySelector(`[data-draft-focus-key="${CSS.escape(bookmark.key)}"]`)
  if (!input) return false
  input.focus({ preventScroll: true })
  input.setSelectionRange(input.value.length, input.value.length)
  return true
}

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

function captureTriageReturnFocus() {
  const active = document.activeElement
  if (!(active instanceof HTMLElement)) return { kind: 'triageButton' }
  const queueRow = active.closest('#needsYouList .nrow[data-card-id]')
  if (queueRow) {
    return {
      kind: 'queue',
      id: queueRow.dataset.cardId,
      control: active.matches('.nrow-asked') ? 'asked' : 'row',
    }
  }
  if (active.id) return { kind: 'id', id: active.id }
  const tab = active.closest('.tab[data-tab]')
  if (tab) return { kind: 'tab', id: tab.dataset.tab }
  if (active.closest('.triage-btn')) return { kind: 'triageButton' }
  return { kind: 'triageButton' }
}

function restoreTriageReturnFocus(bookmark) {
  let target = null
  if (bookmark?.kind === 'queue') {
    const queueRow = needsYouRowEl(bookmark.id)
    target = bookmark.control === 'asked' ? queueRow?.querySelector('.nrow-asked') : queueRow
  } else if (bookmark?.kind === 'id') {
    target = document.getElementById(bookmark.id)
  } else if (bookmark?.kind === 'tab') {
    target = document.querySelector(`.tab[data-tab="${CSS.escape(bookmark.id)}"]`)
  } else if (bookmark?.kind === 'triageButton') {
    target = document.querySelector('.triage-btn')
  }
  target ??= needsYouRowEl(selectedId) ?? document.querySelector('.triage-btn')
  target?.focus({ preventScroll: true })
}

function openTriage() {
  if (hasDraftRecovery()) {
    requestDraftRecovery()
    restoreDraftRecoveryFocus()
    return
  }
  triageReturnFocus = captureTriageReturnFocus()
  if (relayOpen) closeRelay()
  if (missionBoardId) closeMission({ restoreFocus: false })
  triageDeck = { entries: buildDeck(), index: 0 }
  renderTriage()
  document.querySelector('#lightbox .lb-panel')?.focus({ preventScroll: true })
}

function closeTriage({ restoreFocus = true } = {}) {
  const returnFocus = triageReturnFocus
  triageDeck = null
  triageReturnFocus = null
  document.getElementById('lightbox').hidden = true
  if (restoreFocus) restoreTriageReturnFocus(returnFocus)
}

function triageRemoveEntry(deck, entryKey) {
  if (triageDeck !== deck) return
  const focusBookmark = captureTriageFocus()
  const removedDisplayedEntry = triageEntryKey(
    deckEntryAt(triageDeck.entries, triageDeck.index),
  ) === entryKey
  const index = triageDeck.entries.findIndex((entry) => triageEntryKey(entry) === entryKey)
  if (index < 0) return
  triageDeck.entries.splice(index, 1)
  if (index < triageDeck.index) triageDeck.index--
  renderTriage({ focusBookmark, forcePanelFocus: removedDisplayedEntry })
}

function triageEntryKey(entry) {
  if (!entry) return ''
  return entry.type === 'q'
    ? `q:${entry.id}`
    : `row:${entry.boardId}:${entry.rowId}`
}

function captureTriageFocus() {
  if (!triageDeck) return null
  const card = document.querySelector('#lightbox .lb-card')
  const active = document.activeElement
  if (!card || !active || !card.contains(active)) return null
  const targets = cardFocusTargets(card)
  if (!targets.includes(active)) return null
  const key = cardFocusKey(active)
  return {
    entry: triageEntryKey(deckEntryAt(triageDeck.entries, triageDeck.index)),
    key,
    ordinal: targets.filter((target) => cardFocusKey(target) === key).indexOf(active),
  }
}

function restoreTriageFocus(bookmark) {
  if (!bookmark || !triageDeck) return false
  const card = document.querySelector('#lightbox .lb-card')
  const sameEntry = bookmark.entry === triageEntryKey(deckEntryAt(triageDeck.entries, triageDeck.index))
  if (card && sameEntry) {
    const targets = cardFocusTargets(card)
    const matches = targets.filter((target) => cardFocusKey(target) === bookmark.key)
    const target = matches[bookmark.ordinal]
    if (target && !target.closest('[hidden], details:not([open])')) {
      target.focus({ preventScroll: true })
      if (document.activeElement === target) return true
    }
  }
  const panel = document.querySelector('#lightbox .lb-panel')
  panel?.focus({ preventScroll: true })
  return document.activeElement === panel
}

function triageActionMix(entries) {
  let decisions = 0
  let tasks = 0
  for (const entry of entries) {
    const data = findEntryData(entry)
    if (!data) continue
    const entity = data.it ?? data.r
    if (actionCategory(entity) === 'task') tasks++
    else decisions++
  }
  const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`
  return `${plural(decisions, 'decision')} · ${plural(tasks, 'task')} remaining`
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
const openContexts = new Set()

// #36's labels, and the words are load-bearing. This is NOT the row's `done`
// STATUS — that is the AGENT's assertion about the row's work, and only agents
// write it. This is the human saying THEIR half is finished and the row is now
// waiting on somebody else. "I've done my part" / "Not done after all" says
// exactly that and nothing more; "Done" would say the other thing.
const HANDLED_LABEL = 'I’ve done my part'
const UNHANDLED_LABEL = 'Not done after all'

function dispositionEl(onResponse, onSnooze, key) {
  const menu = document.createElement('details')
  menu.className = 'disposition-menu'
  menu.open = openDispositionMenus.has(key)
  menu.addEventListener('toggle', () => {
    if (menu.open) openDispositionMenus.add(key)
    else openDispositionMenus.delete(key)
  })
  const summary = document.createElement('summary')
  summary.textContent = 'More responses'
  const wrap = document.createElement('div')
  wrap.className = 'disposition-actions'
  const snooze = (label, ms) => {
    const button = btn(label, () => onSnooze(new Date(Date.now() + ms).toISOString()))
    button.className = 'disposition-btn'
    wrap.appendChild(button)
  }
  snooze('Not now · 4h', 4 * 60 * 60_000)
  snooze('Tomorrow', 24 * 60 * 60_000)
  snooze('Next week', 7 * 24 * 60 * 60_000)
  const clarify = btn('Needs clarification', () => {
    onResponse('clarify', 'Please clarify the exact decision or task you need from me.')
  })
  clarify.className = 'disposition-btn'
  wrap.appendChild(clarify)
  const decline = btn('Decline', () => onResponse('decline', 'Declined'))
  decline.className = 'disposition-btn decline'
  wrap.appendChild(decline)
  menu.append(summary, wrap)
  return menu
}

// The human's own exit from a blocked row (#36) — the deed, beside the words.
//
// WHY IT EXISTS. The task-shaped blockers that motivated #36 ("create the
// Paddle account", "record the hero demo") do not want words, they want DONE.
// Decision-shaped blockers now carry direct options and do not render this
// control. Without a task completion lever, a row whose asking session ended
// was literally unclearable.
//
// `null` on any row where the control would be a lie: nothing is being asked of
// the human on a row that is not `blocked`, so there is nothing for them to
// finish. Three states beyond that, and the third one is the whole point of #38
// — never draw a control that cannot work:
//   · unmarked            → the lever
//   · marked, undelivered → the undo, which the store will honour
//   · marked, delivered   → NO undo, and the reason standing in its place
function rowHandledEl(b, r) {
  if (r.status !== 'blocked') return null
  // Decision-shaped blockers are answered by choosing an option. "I've done my
  // part" is the task-shaped control and would be ambiguous beside Merge/Hold.
  if (r.options?.length) return null
  const set = async (handled) => {
    const res = await postJSON(`/api/boards/${b.id}/rows/${r.id}/handled`, {
      handled,
      expected_revision: r.revision,
      expected_board_version: b.revision,
    })
    if (res === null) return // network failure — postJSON already signaled it
    if (!res.ok) {
      // REFUSED: an agent was handed the mark between the frame that drew this
      // button and the click. Our snapshot is by definition the stale one that
      // drew it, so approximate the stamp with now — the server has told us
      // definitively THAT a pickup happened, just not exactly when (≤3s stale).
      // Same shape, and the same reason, as changeAnswer's refusal path.
      showWriteError(
        r.id,
        res.reason === 'version_mismatch'
          ? 'This action changed before your click; refreshed without applying it.'
          : handledUndoRefusal({ ...r, handled_seen_at: r.handled_seen_at ?? new Date().toISOString() }, Date.now()),
      )
    } else {
      showWriteError(r.id, '')
    }
    // #38 — the human's own click gets its frame whatever the answer was. A bare
    // load() asks the global §10 gate for permission, and this control only ever
    // exists inside an expanded card or an open matrix row, so the gate is
    // CERTAIN to refuse: the mark would land in the DB and the screen would keep
    // showing the pre-click state until something unrelated collapsed.
    await reloadAndPaint()
  }
  if (!r.handled_at) {
    const mark = btn(HANDLED_LABEL, () => set(true))
    mark.className = 'handled-btn'
    mark.title = 'takes this row out of your attention — the agent still has to acknowledge it'
    return mark
  }
  // Undoable only while it is still the human's own business: store.ts's
  // clearRowHandled refuses once handled_seen_at is set, because un-marking
  // cannot un-tell an agent that already has it.
  const refusal = handledUndoRefusal(r, Date.now())
  if (!refusal) {
    const undo = btn(UNHANDLED_LABEL, () => set(false))
    undo.className = 'handled-btn undo-btn'
    return undo
  }
  const why = document.createElement('span')
  why.className = 'handled-refusal'
  why.textContent = refusal // never innerHTML; it is rendered beside agent-authored text
  return why
}

const REPLY_EDITOR_MAX_HEIGHT = 160

function resizeReplyEditor(editor) {
  editor.style.height = 'auto'
  const naturalHeight = editor.scrollHeight
  if (naturalHeight > 0) editor.style.height = `${Math.min(naturalHeight, REPLY_EDITOR_MAX_HEIGHT)}px`
  editor.style.overflowY = naturalHeight > REPLY_EDITOR_MAX_HEIGHT ? 'auto' : 'hidden'
}

function bindReplyEditor(editor, submit) {
  editor.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || (!event.ctrlKey && !event.metaKey)) return
    event.preventDefault()
    submit()
  })
  requestAnimationFrame(() => {
    if (editor.isConnected) resizeReplyEditor(editor)
  })
}

// The ONE write path for a row annotation — multiline editor, no window.prompt.
// Shared by the boards matrix and the triage card (spec §7).
//
// It also carries #36's lever, so all THREE surfaces that let a human act on a
// blocked row — the Needs-you accordion card, the triage deck (both via
// rowCardEl) and the boards matrix panel (rowPanelEl) — get it from one call
// site and cannot drift apart. They belong in one control row because they are
// the two answers to one question ("what do you want to tell the agent?"), and
// because the single `.write-error` slot below is then where a refusal on EITHER
// of them appears.
function rowAnswerEl(b, r, onSaved) {
  recoverMismatchedRenderedRowDraft(b, r)
  const wrap = document.createElement('div')
  wrap.className = 'row-answer'
  const row = document.createElement('div')
  row.className = 'reply-row'
  const input = document.createElement('textarea')
  input.className = 'reply-input'
  input.rows = 1
  input.setAttribute('aria-keyshortcuts', 'Control+Enter Meta+Enter')
  input.dataset.draftFocusKey = `row:${r.id}`
  input.placeholder = r.options?.length
    ? 'or answer in your own words…'
    : r.status === 'blocked' ? 'tell the agent how to proceed…' : 'your note on this row…'
  const recoveryKey = rowDraftRecoveryKey(r.id, r.revision)
  const staleDraft = staleRowDrafts[recoveryKey]
  const rowRecoveries = Object.values(staleRowDrafts)
    .filter((draft) => draft.rowId === r.id)
  if (staleDraft) input.dataset.recoveredDraft = '1'
  input.value = rowDrafts[r.id] ?? (staleDraft?.text ?? '')
  if (input.value && rowDrafts[r.id] === undefined) {
    bumpDraftGeneration(rowDraftGenerations, r.id)
    rowDrafts[r.id] = input.value
    rowDraftMeta[r.id] = {
      revision: r.revision,
      actionVersion: staleDraft?.actionVersion ?? r.action_version,
      boardTitle: b.title,
      label: r.label,
      context: staleDraft?.context ?? r.context ?? '',
    }
  }
  if (staleDraft?.revision === r.revision) rowDraftKinds[r.id] = staleDraft.kind
  let editorGeneration = rowDraftGenerations[r.id] ?? 0
  input.dataset.responseKind = rowDraftKinds[r.id] ?? 'answer'
  input.addEventListener('input', () => {
    editorGeneration = bumpDraftGeneration(rowDraftGenerations, r.id)
    rowDrafts[r.id] = input.value
    rowDraftKinds[r.id] = input.dataset.responseKind ?? rowDraftKinds[r.id] ?? 'answer'
    resizeReplyEditor(input)
    if (input.value.trim()) {
      rowDraftMeta[r.id] = {
        revision: r.revision,
        actionVersion: r.action_version,
        boardTitle: b.title,
        label: r.label,
        context: r.context ?? '',
      }
    } else {
      delete rowDraftMeta[r.id]
    }
    delete staleRowDrafts[recoveryKey]
    clearRowRecoveryTarget(r.id, r.revision)
    resumeRender()
  })
  const save = async () => {
    const typed = input.value
    if (!typed.trim()) return
    const kind = input.dataset.responseKind ?? 'answer'
    const submittedGeneration = editorGeneration
    const submissionToken = bumpDraftGeneration(rowSubmissionTokens, r.id)
    // fix round 2 (C3): the draft used to be dropped BEFORE the POST, so a
    // dropped request (viewer server restarted — routine for the Electron app)
    // erased the human's note with no trace. Clear only once it landed.
    const res = await postJSON(`/api/boards/${b.id}/rows/${r.id}/annotate`, {
      text: typed.trim(),
      kind,
      expected_revision: r.revision,
      expected_board_version: b.revision,
    })
    const ownsSubmission = (rowDraftGenerations[r.id] ?? 0) === submittedGeneration
      && rowSubmissionTokens[r.id] === submissionToken
    if (res === null) {
      if (ownsSubmission) {
        rowDrafts[r.id] = typed
        rowDraftMeta[r.id] = {
          revision: r.revision,
          actionVersion: r.action_version,
          boardTitle: b.title,
          label: r.label,
          context: r.context ?? '',
        }
        input.value = typed
      }
      showWriteError(r.id, WRITE_FAILED)
      resumeRender()
      return
    }
    if (!res.ok) {
      if (!ownsSubmission) {
        showWriteError(r.id, 'An earlier response was not applied; your newer draft is preserved.')
        resumeRender()
        return
      }
      staleRowDrafts[recoveryKey] = {
        rowId: r.id,
        revision: r.revision,
        actionVersion: r.action_version,
        text: typed,
        kind,
        boardTitle: b.title,
        label: r.label,
        context: r.context ?? '',
      }
      requestDraftRecovery({ rowId: r.id, revision: r.revision, project: b.project })
      bumpDraftGeneration(rowDraftGenerations, r.id)
      delete rowDrafts[r.id]
      delete rowDraftKinds[r.id]
      delete rowDraftMeta[r.id]
      showWriteError(r.id, 'This action changed before your response arrived; refreshed without applying it.')
      await reloadAndPaint()
      return
    }
    if (ownsSubmission) {
      bumpDraftGeneration(rowDraftGenerations, r.id)
      delete rowDrafts[r.id]
      delete rowDraftKinds[r.id]
      delete rowDraftMeta[r.id]
      delete staleRowDrafts[recoveryKey]
      clearRowRecoveryTarget(r.id, r.revision)
      delete input.dataset.responseKind
    }
    showWriteError(r.id, '')
    // the row stays blocked until the agent picks the note up — the human's part
    // is done, so the caller decides what to drop
    onSaved?.()
    // issue #38, the reported surface: a bare load() here was gated, and the gate
    // is global — one unrelated draft anywhere and this write showed the human
    // nothing at all, box still full, ready to send the same string twice.
    await reloadAndPaint()
  }
  const options = r.status === 'blocked' ? optionOrder(r.options) : []
  if (options.length) {
    const choices = document.createElement('div')
    choices.className = `options row-options${openRowCompares.has(r.id) ? ' comparing' : ''}`
    for (const option of options) {
      const box = document.createElement('div')
      box.className = 'option'
      const pill = document.createElement('button')
      pill.className = `opt-pill${option.recommended ? ' rec' : ''}`
      pill.innerHTML = `${esc(option.label)}${option.recommended ? '<span class="rec-tag">recommended</span>' : ''}`
      pill.addEventListener('click', () => {
        input.value = option.label
        input.dataset.responseKind = 'answer'
        rowDraftKinds[r.id] = 'answer'
        save()
      })
      box.appendChild(pill)
      if (option.detail) {
        const detail = document.createElement('div')
        detail.className = 'opt-detail'
        detail.innerHTML = renderStructuredText(option.detail)
        box.appendChild(detail)
      }
      choices.appendChild(box)
    }
    if (options.some((option) => option.detail)) {
      const compare = btn(openRowCompares.has(r.id) ? 'Hide option details' : 'Compare options', () => {
        if (openRowCompares.has(r.id)) openRowCompares.delete(r.id)
        else openRowCompares.add(r.id)
        forceRender()
      })
      compare.className = 'compare-toggle'
      wrap.appendChild(compare)
    }
    wrap.appendChild(choices)
  }
  if (r.status === 'blocked' && !r.annotation && !r.annotation_kind && !r.handled_at) {
    wrap.appendChild(dispositionEl(
      (kind, text) => {
        input.value = text
        input.dataset.responseKind = kind
        rowDraftKinds[r.id] = kind
        save()
      },
      async (until) => {
        const res = await postJSON(`/api/boards/${b.id}/rows/${r.id}/snooze`, {
          until,
          expected_revision: r.revision,
          expected_board_version: b.revision,
        })
        if (res === null) return
        if (!res.ok) { await reloadAndPaint(); return }
        onSaved?.()
        await reloadAndPaint()
      },
      `row:${r.id}`,
    ))
  }
  bindReplyEditor(input, save)
  row.appendChild(input)
  row.appendChild(btn('Send', save))
  const handled = rowHandledEl(b, r)
  if (handled) row.appendChild(handled)
  row.appendChild(writeErrorEl(r.id))
  wrap.appendChild(row)
  for (const recovery of rowRecoveries) {
    const warning = document.createElement('div')
    warning.className = 'write-error stale-draft'
    warning.textContent = recovery.revision === r.revision
      ? 'Not sent because the board changed. Review the preserved draft and send again.'
      : `Not sent because this action changed. Preserved ${recovery.kind}: ${recovery.text}`
    wrap.appendChild(warning)
  }
  return wrap
}

// The delivery marker for ONE thing the human left on a row (issue #37) — the
// rows-shaped twin of the item reply block's marker, and the same vocabulary.
//
// "delivered", not "read": the stamp records only that this was handed to an
// agent. The acknowledgement is the agent flipping the row's status, which is why
// an answered row stays on screen until it does.
//
// Parameterised over the pair of stamps rather than reading the row, because #36
// gave a row two INDEPENDENTLY delivered halves and the marker has to be able to
// disagree between them.
function pickupMarkHtml(seenAt, seenBy) {
  return seenAt
    ? `<span class="pickup picked">With ${seenBy ? esc(seenBy) : 'the agent'} · ${esc(rel(seenAt))} ago</span>`
    : '<span class="pickup awaiting">Waiting for the agent</span>'
}

// Everything the human has left on a row: their words (#37), their "I did my
// part" mark (#36), or both — each carrying its OWN delivery state, because a
// collected annotation sitting beside an uncollected mark must never read as
// "delivered". That half-delivered case is exactly the lie #37 exists to prevent.
//
// One function, so the matrix, the accordion card and the triage card cannot
// drift apart about what any of this means; and every branch is gated on the
// field it describes, so no marker can be printed for a fact that is not there.
function rowHumanStateHtml(r) {
  const parts = []
  if (r.annotation || r.annotation_kind) {
    const label = responseLabel(r) || 'You answered'
    parts.push(`<div class="annotation"><strong>${esc(label)}:</strong> ${esc(r.annotation ?? '')}${pickupMarkHtml(r.annotation_seen_at, r.annotation_seen_by)}</div>`)
  }
  if (r.handled_at) parts.push(`<div class="annotation handled-mark">✓ You marked your part done ${esc(rel(r.handled_at))} ago${pickupMarkHtml(r.handled_seen_at, r.handled_seen_by)}</div>`)
  return parts.join('')
}

function contextHtml(context, key) {
  if (!context) return ''
  return `<details class="card-context" data-context-key="${esc(key)}"${openContexts.has(key) ? ' open' : ''}><summary class="card-context-label">Background</summary><div class="card-context-body">${renderStructuredText(context)}</div></details>`
}

function bindContextDisclosures(root) {
  for (const details of root.querySelectorAll('.card-context[data-context-key]')) {
    details.addEventListener('toggle', () => {
      const key = details.dataset.contextKey
      if (!key) return
      details.open ? openContexts.add(key) : openContexts.delete(key)
    })
  }
}

function actionBlocksHtml(tldr, nextStep, actionOwner, impact, nextAfter, context, contextKey) {
  return `
    ${actionOwner ? `<div class="action-owner">${esc(actionOwnerLabel({ action_owner: actionOwner }))}</div>` : ''}
    ${nextStep ? `<div class="card-next"><div class="card-section-label">NEXT STEP</div><div class="card-next-body">${renderStructuredText(nextStep)}</div></div>` : ''}
    ${impact ? `<div class="card-impact"><div class="card-section-label">WHY NOW</div>${renderStructuredText(impact)}</div>` : ''}
    ${nextAfter ? `<div class="card-after"><div class="card-section-label">AFTER THIS</div>${renderStructuredText(nextAfter)}</div>` : ''}
    ${tldr ? `<div class="card-tldr"><div class="card-section-label">TL;DR</div><div class="card-tldr-body">${renderStructuredText(tldr)}</div></div>` : ''}
    ${contextHtml(context, contextKey)}`
}

function lifecycleHtml(entity, { includeAsked = true } = {}) {
  const steps = lifecycleReceipt(entity)
    .filter((step) => includeAsked || step.label !== 'Asked')
    .filter((step) => step.kind !== 'outcome')
  if (!steps.length) return ''
  return `<div class="lifecycle-receipt">${steps.map((step) => (
    `<div class="lifecycle-step">${renderStructuredText(step.label)}${step.at ? `<span class="lifecycle-age">· ${esc(rel(step.at))}</span>` : ''}</div>`
  )).join('<span class="lifecycle-arrow">→</span>')}</div>`
}

function outcomeHtml(outcome, at = null) {
  return outcome
    ? `<div class="outcome-block"><div class="outcome-label">Outcome${at ? `<span class="outcome-age">· ${esc(rel(at))}</span>` : ''}</div>${renderStructuredText(outcome)}</div>`
    : ''
}

function historyHtml(r) {
  if (!r.history?.length) return ''
  const entries = [...r.history].reverse().map((entry) => {
    const response = responseLabel({
      annotation_kind: entry.response_kind,
      annotation: entry.response,
      handled_at: entry.handled ? entry.response_at : null,
    })
    return `<div class="history-entry">
      <div class="history-title">Step ${esc(String(entry.version))} · ${esc(entry.note || entry.next_step || entry.status)}</div>
      ${response ? `<div>${esc(response)}${entry.response ? `: ${esc(entry.response)}` : ''}</div>` : ''}
      ${outcomeHtml(entry.outcome, entry.outcome_at)}
    </div>`
  }).join('')
  return `<details class="action-history"><summary>Prior steps (${r.history.length})</summary>${entries}</details>`
}

// the inline expansion under a matrix row: long context + existing annotation + answer
function rowPanelEl(b, r, readOnly = false) {
  const wrap = document.createElement('div')
  wrap.className = 'row-panel'
  wrap.innerHTML = `
    ${actionBlocksHtml(r.note, r.status === 'blocked' ? r.next_step : '', r.action_owner, r.impact, r.next_after, r.context, `row:${r.id}`)}
    ${rowHumanStateHtml(r)}
    ${outcomeHtml(r.outcome, r.outcome_at)}
    ${lifecycleHtml(r)}
    ${historyHtml(r)}`
  bindContextDisclosures(wrap)
  if (!readOnly) wrap.appendChild(rowAnswerEl(b, r))
  return wrap
}

// `rowCardEl` mounts in TWO places: the triage lightbox (where `triageDeck` is
// open) and, since Task 11, the inline Needs-you accordion (where it is `null`).
// Guard the onSaved callback here, at the definition, so neither call site has
// to know which context it is in — answering a blocked row from the list must
// not throw just because there is no deck to remove it from.
function rowCardEl(b, r, onSaved, { includeAsked = true } = {}) {
  const wrap = document.createElement('div')
  wrap.className = 'lb-row-card'
  wrap.innerHTML = `
    <div class="meta">Plan · ${esc(b.title)} <span class="board-id">#${esc(b.id.slice(0, 6))}</span></div>
    <div class="title">${esc(r.label)}</div>
    ${actionBlocksHtml(r.note, r.next_step, r.action_owner, r.impact, r.next_after, r.context, `row:${r.id}`)}
    ${rowHumanStateHtml(r)}
    ${outcomeHtml(r.outcome, r.outcome_at)}
    ${lifecycleHtml(r, { includeAsked })}
    ${historyHtml(r)}`
  bindContextDisclosures(wrap)
  wrap.appendChild(rowAnswerEl(b, r, onSaved))
  return wrap
}

function renderTriage({
  focusBookmark = captureTriageFocus(),
  forcePanelFocus = false,
} = {}) {
  if (!triageDeck) return
  if (reconcileDraftOwners()) {
    forceRender()
    return
  }
  const lb = document.getElementById('lightbox')
  // drop entries resolved elsewhere (or answered in a previous card)
  triageDeck.entries = triageDeck.entries.filter((e) => findEntryData(e))
  const n = triageDeck.entries.length
  triageDeck.index = Math.max(0, Math.min(triageDeck.index, n - 1))
  const card = lb.querySelector('.lb-card')
  const owner = lb.querySelector('.lb-owner')
  const progress = lb.querySelector('.lb-progress-fill')
  card.innerHTML = ''
  if (n === 0) {
    lb.querySelector('.lb-count').textContent = 'all clear'
    lb.querySelector('.lb-mix').textContent = 'Review complete'
    owner.textContent = ''
    progress.style.transform = 'scaleX(1)'
    card.innerHTML = '<div class="lb-clear">All clear. There is nothing left to review.</div>'
  } else {
    lb.querySelector('.lb-count').textContent = `${triageDeck.index + 1} of ${n}`
    lb.querySelector('.lb-mix').textContent = triageActionMix(triageDeck.entries)
    progress.style.transform = `scaleX(${(triageDeck.index + 1) / n})`
    const data = findEntryData(triageDeck.entries[triageDeck.index])
    const renderedDeck = triageDeck
    const renderedEntryKey = triageEntryKey(triageDeck.entries[triageDeck.index])
    owner.textContent = actionOwnerLabel(data.it ?? data.r)
    if (data.it) {
      card.appendChild(itemCardEl(data.it, {
        nowMs: Date.now(),
        liveness: classifyLiveness(data.it, Date.now(), liveSessionIds()),
      }))
    } else {
      card.appendChild(rowCardEl(
        data.b,
        data.r,
        () => triageRemoveEntry(renderedDeck, renderedEntryKey),
      ))
    }
  }
  lb.querySelector('.lb-prev').disabled = triageDeck.index <= 0
  lb.querySelector('.lb-next').disabled = triageDeck.index >= n - 1
  lb.hidden = false
  if (forcePanelFocus) lb.querySelector('.lb-panel')?.focus({ preventScroll: true })
  else restoreTriageFocus(focusBookmark)
}

function initTriage() {
  const lb = document.getElementById('lightbox')
  lb.querySelector('.lb-close').addEventListener('click', () => closeTriage())
  lb.querySelector('.lb-backdrop').addEventListener('click', () => closeTriage())
  lb.querySelector('.lb-prev').addEventListener('click', () => { triageDeck.index--; renderTriage() })
  lb.querySelector('.lb-next').addEventListener('click', () => { triageDeck.index++; renderTriage() })
  // keyboard (Esc/ArrowLeft/ArrowRight/t) is owned by initKeys (Task 17) —
  // one handler for the list AND the deck so the two can never drift apart
}

let relayOpen = false

function openRelay() {
  if (triageDeck) closeTriage()
  if (missionBoardId) closeMission({ restoreFocus: false })
  relayOpen = true
  renderRelay()
}

function closeRelay() {
  relayOpen = false
  document.getElementById('relaybox').hidden = true
}

function relayEntity(entry) {
  return entry.kind === 'row' ? entry.row : entry.item
}

function relayTitle(entry) {
  return entry.kind === 'row' ? entry.row.label : entry.item.title
}

function relayProject(entry) {
  return entry.kind === 'row' ? entry.board.project : entry.item.project
}

function relaySummaryText(entry) {
  const entity = relayEntity(entry)
  return entry.kind === 'row'
    ? (entity.note || entity.next_step || '')
    : (entity.detail || entity.next_step || '')
}

function relayPickupChip(entity) {
  const pickup = lifecycleReceipt(entity).find((step) => step.label === 'With the agent')
  if (!pickup?.at) return { text: 'Waiting for agent', tone: 'awaiting' }
  return agentFollowupChip({
    answered: true,
    pickedUp: true,
    pickedUpAt: pickup.at,
  }, Date.now()) ?? { text: 'With agent', tone: 'muted' }
}

function focusRelayEntry(entry, lane) {
  closeRelay()
  if (entry.kind === 'item') {
    focusItem(entry.item.id)
    return
  }
  if (lane === 'outcome') {
    focusItem(entry.board.id, { rowId: entry.row.id })
    return
  }
  jumpToCard('needsYou', entry.row.id)
}

function relayCardEl(entry, lane) {
  const entity = relayEntity(entry)
  const card = document.createElement('article')
  card.className = `relay-card relay-${lane}`
  let status
  if (lane === 'human') {
    status = { text: actionOwnerLabel(entity), tone: 'human' }
  } else if (lane === 'agent') {
    status = relayPickupChip(entity)
    if (status.tone === 'warm' || status.tone === 'hot') card.classList.add('overdue')
  } else {
    status = { text: 'Completed', tone: 'outcome' }
  }
  const summary = relaySummaryText(entry)
  const outcome = entity.outcome ?? ''
  card.innerHTML = `
    <div class="relay-meta"><span>${esc(relayProject(entry))}</span><span class="relay-owner">${esc(actionOwnerLabel(entity))}</span></div>
    <h3>${esc(relayTitle(entry))}</h3>
    ${summary ? `<div class="relay-summary-text">${renderStructuredText(summary)}</div>` : ''}
    ${outcome ? `<div class="relay-result">${renderStructuredText(outcome)}</div>` : ''}
    <div class="relay-state"><span class="relay-baton"></span><span class="relay-chip ${esc(status.tone)}">${esc(status.text)}</span></div>`
  const open = btn(lane === 'human' ? 'Open action' : lane === 'agent' ? 'Open receipt' : 'View outcome', () => {
    focusRelayEntry(entry, lane)
  })
  open.className = 'relay-open'
  card.appendChild(open)
  return card
}

function renderRelayLane(box, lane, entries) {
  const host = box.querySelector(`[data-relay-lane="${lane}"]`)
  host.querySelector('.relay-count').textContent = String(entries.length)
  const body = host.querySelector('.relay-body')
  body.replaceChildren()
  if (!entries.length) {
    const empty = document.createElement('div')
    empty.className = 'relay-empty'
    empty.textContent = lane === 'human'
      ? 'Nothing is waiting on you'
      : lane === 'agent' ? 'No handoffs are waiting' : 'No outcomes recorded yet'
    body.appendChild(empty)
    return
  }
  for (const entry of entries) body.appendChild(relayCardEl(entry, lane))
}

function renderRelay() {
  if (!relayOpen || !lastData || !visibleData) return
  const box = document.getElementById('relaybox')
  const scoped = filterData(visibleData)
  const relay = buildRelay(
    allItems(scoped.g),
    scoped.boards,
    scoped.archived,
    Date.now(),
    liveSessionIds(),
  )
  renderRelayLane(box, 'human', relay.human)
  renderRelayLane(box, 'agent', relay.agent)
  renderRelayLane(box, 'outcome', relay.outcomes)
  box.querySelector('.relay-summary').textContent =
    `${relay.human.length} waiting on you · ${relay.agent.length} with agent · ${relay.outcomes.length} outcomes`
  box.hidden = false
}

function initRelay() {
  const box = document.getElementById('relaybox')
  box.querySelector('.relay-close').addEventListener('click', closeRelay)
  box.querySelector('.relay-backdrop').addEventListener('click', closeRelay)
}

let missionBoardId = null
let missionDetailRowId = null
let missionReturnFocus = null
let missionDetailReturnFocus = null

function missionPanel() {
  return document.querySelector('#missionbox .mission-panel')
}

function missionDetailPanel() {
  return document.querySelector('#missionbox .mission-detail-panel')
}

function captureMissionFocus() {
  const active = document.activeElement
  if (!missionBoardId || !active?.closest?.('#missionbox')) return null
  const detail = active.closest('.mission-detail-panel')
  const surface = detail ? 'detail' : 'flow'
  const rowId = surface === 'detail'
    ? missionDetailRowId
    : active.closest('.mission-path[data-row-id]')?.dataset.rowId ?? null
  const scope = surface === 'detail'
    ? detail
    : (rowId ? active.closest('.mission-path[data-row-id]') : missionPanel())
  if (!scope) return null
  const targets = cardFocusTargets(scope)
  if (active === scope || !targets.includes(active)) {
    return { boardId: missionBoardId, surface, rowId, key: null, ordinal: 0 }
  }
  const key = cardFocusKey(active)
  return {
    boardId: missionBoardId,
    surface,
    rowId,
    key,
    ordinal: targets.filter((target) => cardFocusKey(target) === key).indexOf(active),
  }
}

function focusMissionPanel() {
  const panel = missionPanel()
  panel?.focus({ preventScroll: true })
  return document.activeElement === panel
}

function restoreMissionFocus(bookmark) {
  if (!bookmark || bookmark.boardId !== missionBoardId) return false
  if (bookmark.surface === 'detail' && bookmark.rowId !== missionDetailRowId) {
    return focusMissionPanel()
  }
  const scope = bookmark.surface === 'detail'
    ? missionDetailPanel()
    : (bookmark.rowId
        ? document.querySelector(`#missionbox .mission-path[data-row-id="${CSS.escape(bookmark.rowId)}"]`)
        : missionPanel())
  if (!scope || scope.closest('[hidden]')) return focusMissionPanel()
  const matches = bookmark.key
    ? cardFocusTargets(scope).filter((target) => cardFocusKey(target) === bookmark.key)
    : []
  const target = matches[bookmark.ordinal] ?? (bookmark.key ? null : scope)
  if (!target) return focusMissionPanel()
  target.focus({ preventScroll: true })
  return document.activeElement === target || focusMissionPanel()
}

function restoreMissionDetailReturnFocus(bookmark) {
  if (!bookmark || bookmark.boardId !== missionBoardId || !bookmark.rowId) {
    return focusMissionPanel()
  }
  const scope = document.querySelector(
    `#missionbox .mission-path[data-row-id="${CSS.escape(bookmark.rowId)}"]`,
  )
  if (!scope) return focusMissionPanel()
  const matches = bookmark.key
    ? cardFocusTargets(scope).filter((target) => cardFocusKey(target) === bookmark.key)
    : []
  const target = matches[bookmark.ordinal] ?? cardFocusTargets(scope)[0]
  if (!target) return focusMissionPanel()
  target.focus({ preventScroll: true })
  return document.activeElement === target || focusMissionPanel()
}

function openMission(board) {
  if (triageDeck) closeTriage()
  if (relayOpen) closeRelay()
  missionReturnFocus = pagedCardFocusBookmark()
  missionBoardId = board.id
  renderMission({ restoreFocus: false })
  focusMissionPanel()
}

function closeMission({ restoreFocus = true } = {}) {
  const returnFocus = missionReturnFocus
  missionBoardId = null
  missionDetailRowId = null
  missionReturnFocus = null
  missionDetailReturnFocus = null
  document.getElementById('missionbox').hidden = true
  if (restoreFocus && !restorePagedCardFocus(returnFocus)) {
    document.querySelector('.tab[data-tab="boards"]')?.focus({ preventScroll: true })
  }
}

function focusMissionRow(board, row) {
  closeMission({ restoreFocus: false })
  focusItem(board.id)
  openRows.add(row.id)
  forceRender()
  requestAnimationFrame(() => {
    const target = document.querySelector(`[data-row-id="${CSS.escape(row.id)}"]`)
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  })
}

function openMissionDetail(row) {
  const current = captureMissionFocus()
  missionDetailReturnFocus = current?.surface === 'flow' && current.rowId === row.id
    ? current
    : { boardId: missionBoardId, surface: 'flow', rowId: row.id, key: null, ordinal: 0 }
  missionDetailRowId = row.id
  renderMission({ restoreFocus: false })
  missionDetailPanel()?.focus({ preventScroll: true })
}

function closeMissionDetail({ restoreFocus = true } = {}) {
  const returnFocus = missionDetailReturnFocus
  missionDetailRowId = null
  missionDetailReturnFocus = null
  document.querySelector('#missionbox .mission-detail').hidden = true
  if (restoreFocus) restoreMissionDetailReturnFocus(returnFocus)
}

function missionPathEl(path, board) {
  const row = path.row
  const line = document.createElement('div')
  line.className = 'mission-path'
  line.dataset.rowId = row.id
  const action = document.createElement('article')
  action.className = `mission-node mission-${row.status}`
  const owner = row.action_owner ? actionOwnerLabel(row) : (STATUS_LABEL[row.status] ?? row.status)
  action.innerHTML = `
    <span class="mission-node-meta">${esc(owner)}</span>
    <strong>${esc(row.label)}</strong>
    ${row.note ? `<div class="mission-node-summary">${renderStructuredText(row.note)}</div>` : ''}
    ${row.impact ? `<div class="mission-node-impact"><span>Why now</span>${renderStructuredText(row.impact)}</div>` : ''}`
  action.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('a, button')) return
    openMissionDetail(row)
  })
  const open = btn('Open details', () => openMissionDetail(row))
  open.className = 'mission-node-open'
  action.appendChild(open)
  const arrow = document.createElement('span')
  arrow.className = 'mission-arrow'
  arrow.textContent = '→'
  const result = document.createElement('div')
  result.className = `mission-result${path.result ? ` ${path.result.kind}` : ' empty'}`
  if (path.result) {
    result.innerHTML = `<span>${path.result.kind === 'outcome' ? 'Outcome' : 'After this'}</span>${renderStructuredText(path.result.text)}`
  } else {
    result.textContent = 'No next step recorded'
  }
  line.append(action, arrow, result)
  return line
}

function renderMission({ restoreFocus = true } = {}) {
  if (!missionBoardId || !lastData) return
  const focusBookmark = restoreFocus ? captureMissionFocus() : null
  if (reconcileDraftOwners()) {
    forceRender()
    return
  }
  const board = [...lastData.boards, ...lastData.archived].find((candidate) => candidate.id === missionBoardId)
  if (!board) { closeMission(); return }
  const box = document.getElementById('missionbox')
  const mission = buildMission(board)
  box.querySelector('.mission-subtitle').textContent = `${mission.root.project} · ${mission.paths.length} steps`
  box.querySelector('.mission-root-project').textContent = mission.root.project
  box.querySelector('.mission-root-title').textContent = mission.root.title
  box.querySelector('.mission-root-progress').textContent = `${mission.root.progress} done`
  const paths = box.querySelector('.mission-paths')
  paths.replaceChildren()
  if (!mission.paths.length) {
    const empty = document.createElement('div')
    empty.className = 'mission-empty'
    empty.textContent = 'No active steps in this plan.'
    paths.appendChild(empty)
  } else {
    for (const path of mission.paths) paths.appendChild(missionPathEl(path, board))
  }
  box.querySelector('.mission-root-card').onclick = () => {
    closeMission({ restoreFocus: false })
    focusItem(board.id)
  }
  const detail = box.querySelector('.mission-detail')
  if (missionDetailRowId) {
    const row = board.rows.find((candidate) => candidate.id === missionDetailRowId)
    if (row) {
      detail.querySelector('.mission-detail-meta').textContent = `${STATUS_LABEL[row.status] ?? row.status} · ${actionOwnerLabel(row)}`
      detail.querySelector('.mission-detail-title').textContent = row.label
      const body = detail.querySelector('.mission-detail-body')
      body.replaceChildren(rowPanelEl(board, row, board.status === 'archived'))
      detail.querySelector('.mission-detail-board').onclick = () => focusMissionRow(board, row)
      detail.hidden = false
    } else {
      closeMissionDetail({ restoreFocus: false })
    }
  } else {
    detail.hidden = true
  }
  box.hidden = false
  if (restoreFocus) restoreMissionFocus(focusBookmark)
}

function initMission() {
  const box = document.getElementById('missionbox')
  box.querySelector('.mission-close').addEventListener('click', closeMission)
  box.querySelector('.mission-backdrop').addEventListener('click', closeMission)
  box.querySelector('.mission-detail-close').addEventListener('click', closeMissionDetail)
  box.querySelector('.mission-detail-backdrop').addEventListener('click', closeMissionDetail)
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

// Project and agent filters are window-local; every cold launch starts from the
// cross-project/cross-tool view. The active tab likewise always starts here.
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
  if (id === 'needsYou') restoreRowSelection(false)
}

function initTabs() {
  for (const t of document.querySelectorAll('#tabs .tab')) {
    t.addEventListener('click', () => selectTab(t.dataset.tab))
  }
  selectTab(activeTab)
  wireTablist(document.getElementById('tabs'), 'vertical')
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

const PAGE_META = {
  dashboard: { kicker: 'Monitor', title: 'Live Operations Desk' },
  needsYou: { kicker: 'Inbox', title: 'Your queue' },
  boards: { kicker: 'Workspace', title: 'Plans' },
  notes: { kicker: 'Workspace', title: 'Notes' },
  done: { kicker: 'Workspace', title: 'History' },
  setup: { kicker: 'Agent Inbox', title: 'Settings' },
}

const liveSessionIds = () => new Set((lastData.activity ?? []).map((a) => a.session))
// projects the human retired (issue #32) — server state, not localStorage, so the
// Electron dock badge (a different OS process) reads the very same set
const closedSet = () => new Set(lastData.closed ?? [])
// An explicitly selected closed project is a deliberate peek, not a suppressed
// default. Dashboard/history must mirror withoutClosed() and keep that project.
const dashboardClosedProjects = () => (lastData.closed ?? []).filter((project) => project !== projectFilter)
const dashboardClosedSet = () => new Set(dashboardClosedProjects())
const themeName = () => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'

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
let tabletClosedSnapshot = null
let tabletForcedOpenKey = ''
let tabletDismissedOpenKey = null
let restoringRailFocus = false
let projectFocusBookmark = null
let projectMutationGeneration = 0
const projectMutationIntents = new Map()
const confirmedProjectMutationIntents = new Map()
const projectMutationQueues = new Map()
const projectMutationVersions = new Map()
const authoritativeRefreshWaiters = new Set()
// lastData minus the closed projects — what the DEFAULT view may show. Set once
// per render(), read by every panel renderer that must agree with the badge.
let visibleData = null
// ── responsive (spec §14) ────────────────────────────────────────────────────
// Pure breakpoint check lives in layout.js; this is just the mode + the media
// query that keeps it live. renderRail reads `layout` to turn project slugs into
// readable compact-menu labels without changing their accessible names.
let layout = layoutMode(window.innerWidth)

const PANE_KEYS = {
  sidebar: 'agent-inbox-sidebar-width',
  inspector: 'agent-inbox-inspector-width',
}
const SIDEBAR_COLLAPSED_KEY = 'agent-inbox-sidebar-collapsed'
const SIDEBAR_COLLAPSED_WIDTH = 72
let sidebarCollapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true'
const panePreferences = {
  sidebar: savedPaneWidth('sidebar'),
  inspector: savedPaneWidth('inspector'),
}

function savedPaneWidth(kind) {
  const stored = Number(localStorage.getItem(PANE_KEYS[kind]))
  return Number.isFinite(stored) && stored > 0 ? stored : PANE_DEFAULTS[kind]
}

function updatePaneHandle(kind, pane) {
  const handle = document.getElementById(`${kind}Resize`)
  if (!handle) return
  handle.setAttribute('aria-valuemin', String(pane.min))
  handle.setAttribute('aria-valuemax', String(pane.max))
  handle.setAttribute('aria-valuenow', String(pane.value))
  handle.title = `Drag to resize; arrow keys adjust; double-click resets to ${PANE_DEFAULTS[kind]}px`
}

function applyPaneLayout() {
  const panes = resolvePaneLayout(window.innerWidth, panePreferences)
  const root = document.documentElement.style
  const collapsed = layout === 'wide' && sidebarCollapsed
  root.setProperty('--sidebar-width', `${collapsed ? SIDEBAR_COLLAPSED_WIDTH : panes.sidebar.value}px`)
  root.setProperty('--inspector-width', `${panes.inspector.value}px`)
  updatePaneHandle('sidebar', panes.sidebar)
  updatePaneHandle('inspector', panes.inspector)
  const sidebarHandle = document.getElementById('sidebarResize')
  if (sidebarHandle) {
    sidebarHandle.tabIndex = collapsed ? -1 : 0
    sidebarHandle.setAttribute('aria-hidden', String(collapsed))
  }
  return panes
}

function setPanePreference(kind, value) {
  panePreferences[kind] = Number(value)
  const panes = applyPaneLayout()
  const actual = panes[kind].value
  panePreferences[kind] = actual
  localStorage.setItem(PANE_KEYS[kind], String(actual))
}

function resetPanePreference(kind) {
  panePreferences[kind] = PANE_DEFAULTS[kind]
  localStorage.removeItem(PANE_KEYS[kind])
  applyPaneLayout()
}

function applySidebarCollapse({ focus = false } = {}) {
  const active = layout === 'wide' && sidebarCollapsed
  if (active && railQuery) {
    railQuery = ''
    if (lastData) renderRail()
  }
  document.body.classList.toggle('sidebar-collapsed', active)
  const button = document.getElementById('sidebarCollapse')
  if (button) {
    button.setAttribute('aria-expanded', String(!active))
    button.setAttribute('aria-label', active ? 'Expand sidebar' : 'Collapse sidebar')
    button.title = active ? 'Expand sidebar' : 'Collapse sidebar'
    if (focus) button.focus({ preventScroll: true })
  }
  applyPaneLayout()
}

function initSidebarCollapse() {
  const button = document.getElementById('sidebarCollapse')
  if (!button) return
  button.addEventListener('click', () => {
    sidebarCollapsed = !sidebarCollapsed
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(sidebarCollapsed))
    applySidebarCollapse({ focus: true })
  })
  applySidebarCollapse()
}

function initPaneResizers() {
  let active = null

  const finish = (event) => {
    if (!active || (event.pointerId != null && event.pointerId !== active.pointerId)) return
    active = null
    document.body.classList.remove('resizing-pane')
  }
  window.addEventListener('pointermove', (event) => {
    if (!active || event.pointerId !== active.pointerId) return
    setPanePreference(active.kind, paneValueFromPointer(active.kind, event.clientX, window.innerWidth))
  })
  window.addEventListener('pointerup', finish)
  window.addEventListener('pointercancel', finish)
  window.addEventListener('resize', applyPaneLayout)

  for (const kind of ['sidebar', 'inspector']) {
    const handle = document.getElementById(`${kind}Resize`)
    if (!handle) continue
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      active = { kind, pointerId: event.pointerId }
      document.body.classList.add('resizing-pane')
      handle.setPointerCapture?.(event.pointerId)
      event.preventDefault()
    })
    handle.addEventListener('keydown', (event) => {
      const pane = applyPaneLayout()[kind]
      const next = paneKeyValue(kind, event.key, pane.value, pane.min, pane.max, event.shiftKey)
      if (next == null) return
      event.preventDefault()
      event.stopPropagation()
      setPanePreference(kind, next)
    })
    handle.addEventListener('dblclick', () => resetPanePreference(kind))
  }

  applyPaneLayout()
}

function initResponsive() {
  const mq = window.matchMedia(`(max-width: ${NARROW_MAX}px)`)
  const apply = () => {
    const next = mq.matches ? 'narrow' : 'wide'
    if (next === layout) return
    layout = next
    applySidebarCollapse()
    if (lastData) forceRender() // the rail's visible labels change, so rebuild it
  }
  mq.addEventListener('change', apply)
  apply()
}

function compactMastheadWidth() {
  const shell = document.querySelector('.sidebar-shell')
  if (!(shell instanceof HTMLElement)) return window.innerWidth
  const style = getComputedStyle(shell)
  const padding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight)
  const inlineSize = shell.clientWidth || window.innerWidth
  // jsdom has no layout box; the real narrow masthead has 16px inline padding.
  const inlinePadding = padding || (shell.clientWidth ? 0 : 32)
  return inlineSize - inlinePadding
}

function tabletProjectsMode() {
  return layout === 'narrow' && compactMastheadWidth() > PROJECT_DISCLOSURE_MAX
}

function projectNavigationMode() {
  if (layout !== 'narrow') return 'desktop'
  return tabletProjectsMode() ? 'tablet' : 'phone'
}

function higherPriorityEscapeSurfaceOpen() {
  const liveDrawer = document.getElementById('liveDrawer')
  const visibleModal = [...document.querySelectorAll('[aria-modal="true"]')]
    .some((dialog) => !dialog.closest('[hidden]'))
  return !!(
    triageDeck
    || missionDetailRowId
    || missionBoardId
    || relayOpen
    || document.body.classList.contains('settings-open')
    || (liveDrawer && !liveDrawer.hidden)
    || visibleModal
  )
}

function setProjectDisclosure(open, { restoreFocus = false } = {}) {
  const disclosure = document.getElementById('projectDisclosure')
  const toggle = document.getElementById('projectDisclosureToggle')
  if (!disclosure || !toggle) return
  disclosure.dataset.open = String(!!open)
  toggle.setAttribute('aria-expanded', String(!!open))
  if (!open && restoreFocus) toggle.focus()
}

function updateProjectDisclosure(entry) {
  const toggle = document.getElementById('projectDisclosureToggle')
  const dot = document.getElementById('projectDisclosureDot')
  const name = document.getElementById('projectDisclosureName')
  const count = document.getElementById('projectDisclosureCount')
  if (!toggle || !dot || !name || !count || !entry) return

  const label = entry.key === '__all__' ? 'All projects' : railLabel(entry.label, 'narrow')
  name.textContent = label
  count.textContent = entry.total ? String(entry.total) : ''
  count.hidden = !entry.total
  dot.className = entry.key === '__all__' ? 'rail-dot all' : 'rail-dot'
  dot.style.background = ''
  if (entry.key !== '__all__' && !entry.unknown) dot.style.background = pcolor(entry.key).dot
  toggle.setAttribute('aria-label', `Choose project, current ${label}`)
  toggle.dataset.project = entry.key
}

function initProjectDisclosure() {
  const disclosure = document.getElementById('projectDisclosure')
  const toggle = document.getElementById('projectDisclosureToggle')
  if (!disclosure || !toggle) return

  toggle.addEventListener('click', () => {
    setProjectDisclosure(disclosure.dataset.open !== 'true')
  })
  for (const type of ['pointerdown', 'focusin']) document.addEventListener(type, (event) => {
    if (!disclosure.isConnected || document.getElementById('projectDisclosure') !== disclosure) return
    const target = event.target
    const focusState = projectFocusState(target)
    projectFocusBookmark = focusState
    const trigger = document.getElementById('closedProjectsTrigger')
    const popover = document.getElementById('closedProjectsPopover')
    const insideArchived = target instanceof Node
      && (trigger?.contains(target) || popover?.contains(target))
    if (!restoringRailFocus && tabletProjectsMode() && closedFoldOpen && !insideArchived) {
      setClosedProjectsOpen(false)
    }
    if (disclosure.dataset.open !== 'true' || disclosure.contains(event.target)) return
    setProjectDisclosure(false)
  })
  document.addEventListener('keydown', (event) => {
    if (!disclosure.isConnected || document.getElementById('projectDisclosure') !== disclosure) return
    if (event.defaultPrevented || nativeKeyOwner(event)) return
    if (
      event.key === 'Escape'
      && tabletProjectsMode()
      && closedFoldOpen
      && document.getElementById('closedProjectsTrigger')?.getAttribute('aria-expanded') === 'true'
      && document.getElementById('closedProjectsPopover')
      && !higherPriorityEscapeSurfaceOpen()
    ) {
      event.preventDefault()
      event.stopImmediatePropagation()
      setClosedProjectsOpen(false, { restoreFocus: true })
      return
    }
    if (event.key !== 'Escape' || disclosure.dataset.open !== 'true') return
    event.preventDefault()
    event.stopImmediatePropagation()
    setProjectDisclosure(false, { restoreFocus: true })
  })
  let projectMode = projectNavigationMode()
  const syncMode = () => {
    if (!disclosure.isConnected || document.getElementById('projectDisclosure') !== disclosure) return
    const next = projectNavigationMode()
    if (next === projectMode) return
    const activeFocusState = projectFocusState(document.activeElement)
    const focusState = activeFocusState
      ?? (document.activeElement === document.body ? projectFocusBookmark : null)
    projectMode = next
    setProjectDisclosure(false)
    setClosedProjectsOpen(false)
    const dismissedOpenKey = next === 'tablet' ? tabletDismissedOpenKey : null
    tabletForcedOpenKey = ''
    tabletDismissedOpenKey = dismissedOpenKey
    if (lastData) {
      forceRender()
      restoreProjectFocus(focusState)
    }
  }
  const shell = disclosure.closest('.sidebar-shell')
  if ('ResizeObserver' in window && shell) {
    new ResizeObserver(syncMode).observe(shell)
  } else {
    window.addEventListener('resize', syncMode)
  }
  window.matchMedia(`(max-width: ${NARROW_MAX}px)`).addEventListener('change', syncMode)
  setProjectDisclosure(false)
}

// The × / ↩ affordance on a rail row (issue #32).
//
// tabIndex = -1 is deliberate: §13 promises "exactly one project tab is
// tabbable", and N focusable close buttons in a rail of N projects would bury
// the tablist under tab stops. The keyboard path is Delete/Backspace on the
// focused tab instead — the convention every browser tab strip uses — wired in
// railRowEl below. Pointer and focus-within styling reveals the same × beside the
// owning project in every layout without adding a second tab stop per project.
function railActionEl(e, closed) {
  const a = document.createElement('button')
  a.type = 'button'
  a.tabIndex = -1
  a.className = closed ? 'rail-reopen' : 'rail-close'
  const glyph = document.createElement('span')
  glyph.className = 'rail-action-glyph'
  glyph.setAttribute('aria-hidden', 'true')
  glyph.textContent = closed ? '↩' : '×'
  const label = document.createElement('span')
  label.className = 'rail-action-label'
  label.textContent = closed ? 'Reopen' : 'Archive'
  a.append(glyph, label)
  // setAttribute escapes; a project name is agent-authored and must NEVER be
  // interpolated into innerHTML
  a.setAttribute('aria-label', `${closed ? 'Reopen' : 'Archive'} project ${e.label}`)
  a.title = closed
    ? 'Reopen — bring this project back into the rail and the badge'
    : `Archive ${e.label} — it comes back the moment an agent flags into it`
  a.addEventListener('click', () => {
    closed
      ? reopenProjectAction(e.key)
      : closeProjectAction(e.key, { focusArchived: tabletProjectsMode() })
  })
  return a
}

// ONE row builder for both the open rail and the closed fold, so the two can
// never drift apart.
//
// The tab and its action button are SIBLINGS inside a wrapper div, never nested:
// `.rail-tab` is itself a `<button role="tab">`, and a button may not contain
// interactive content (invalid HTML, and the roving-tabindex loop at the foot of
// renderRail only governs `.rail-tab`). The codebase's own precedent is
// `.nrow-dismiss` inside `div.nrow`.
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
  // The untouched name always stays reachable on title/aria-label. Compact mode
  // only turns slug separators into spaces, while the unknown hint wins here.
  b.title = e.unknown ? 'Project inference failed for these agents — a register() call fixes their scope.' : e.label
  b.setAttribute('aria-label', e.label)
  // selection is a soft wash of the project's own color; no stripe anywhere
  if (selected && color) b.style.background = color.wash
  const dot = document.createElement('span')
  dot.className = e.key === '__all__' ? 'rail-dot all' : 'rail-dot'
  if (color) dot.style.background = color.dot
  const name = document.createElement('span')
  name.className = 'rail-name'
  // The long-rail filter keeps canonical names so search results stay exact;
  // the compact project menu uses the readable label from layout.js.
  // textContent, never innerHTML — agent-authored project names.
  name.textContent = railLabel(e.label, withFilter ? 'wide' : layout)
  const badge = document.createElement('span')
  // a closed row is never escalated (closedRailEntries pins escalated: 0) —
  // red is an alarm, and a project the badge is ignoring must not alarm
  badge.className = e.escalated ? 'rail-badge escalated' : 'rail-badge'
  badge.textContent = e.total ? String(e.total) : ''
  badge.hidden = !e.total
  badge.title = e.escalated ? `${e.escalated} escalated` : `${e.total} waiting on you`
  b.append(dot, name, badge)
  b.addEventListener('click', () => {
    closeSettings()
    projectFilter = e.key === '__all__' ? null : e.key
    setProjectDisclosure(false, { restoreFocus: layout === 'narrow' })
    resetPaging()
    forceRender()
  })
  // the keyboard half of close/reopen, since the button itself is out of the tab
  // order. `ev` is the keyboard event; `e` is the rail entry — do not merge them.
  if (e.key !== '__all__') b.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Delete' && ev.key !== 'Backspace') return
    ev.preventDefault()
    closed
      ? reopenProjectAction(e.key)
      : closeProjectAction(e.key, { focusArchived: tabletProjectsMode() })
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
  fold.addEventListener('toggle', () => {
    if (!fold.isConnected || tabletProjectsMode()) return
    closedFoldOpen = fold.open
  })
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

function focusProjectControl(id, generation = null) {
  requestAnimationFrame(() => {
    if (generation !== null && generation !== projectMutationGeneration) return
    document.getElementById(id)?.focus()
  })
}

function projectTabIsOperable(target) {
  if (!(target instanceof HTMLElement) || target.closest('details:not([open])')) return false
  const disclosure = target.closest('#projectDisclosure')
  return !(
    disclosure instanceof HTMLElement
    && layout === 'narrow'
    && disclosure.dataset.open !== 'true'
  )
}

function visibleProjectTabs() {
  return [...document.querySelectorAll('#rail .rail-tab')].filter(projectTabIsOperable)
}

function projectControlIsOperable(target) {
  if (!(target instanceof HTMLElement) || !target.isConnected) return false
  if (target.classList.contains('rail-tab')) return projectTabIsOperable(target)
  if (target.classList.contains('rail-close') || target.classList.contains('rail-reopen')) {
    return projectTabIsOperable(target.closest('.rail-row')?.querySelector('.rail-tab'))
  }
  return true
}

function promoteProjectTab(selector) {
  const target = document.querySelector(selector)
  if (!projectTabIsOperable(target)) return false
  if (!target) return false
  for (const tab of document.querySelectorAll('#rail .rail-tab')) tab.tabIndex = -1
  target.tabIndex = 0
  target.focus()
  return true
}

function focusProjectTab(selector, generation = null) {
  requestAnimationFrame(() => {
    if (generation !== null && generation !== projectMutationGeneration) return
    promoteProjectTab(selector)
  })
}

function focusProjectFallback(project, { preferFold = false } = {}) {
  if (project && promoteProjectTab(`#rail .rail-tab[data-project="${CSS.escape(project)}"]`)) {
    return true
  }
  const disclosure = document.getElementById('projectDisclosure')
  if (layout === 'narrow' && disclosure?.dataset.open !== 'true') {
    document.getElementById('projectDisclosureToggle')?.focus()
    return true
  }
  const visibleTabs = visibleProjectTabs()
  const fallbackTab = visibleTabs.find((tab) => tab.tabIndex === 0) ?? visibleTabs[0]
  if (fallbackTab) {
    for (const tab of document.querySelectorAll('#rail .rail-tab')) tab.tabIndex = -1
    fallbackTab.tabIndex = 0
  }
  const summary = preferFold
    ? document.querySelector('#rail .closed-fold > summary')
    : null
  if (summary instanceof HTMLElement) {
    summary.focus()
    return true
  }
  fallbackTab?.focus()
  return !!fallbackTab
}

function focusArchivedProjectControl(project) {
  const escaped = CSS.escape(project)
  const peek = document.querySelector(
    `#closedProjectsPopover [data-project="${escaped}"] .closed-project-peek`,
  )
  if (peek instanceof HTMLElement) {
    peek.focus()
    return true
  }
  const trigger = document.getElementById('closedProjectsTrigger')
  if (trigger) {
    trigger.focus()
    return true
  }
  return false
}

function projectMutationOwnsFocus(selector, generation) {
  if (generation !== projectMutationGeneration) return false
  const active = document.activeElement
  return !active || active === document.body || active.matches(selector)
}

function projectFocusControl(target) {
  if (!(target instanceof Element)) return null
  return target.closest(
    '#projectDisclosureToggle, #closedProjectsTrigger, '
    + '.closed-project-reopen, .closed-project-peek, .rail-close, .rail-tab',
  )
}

function projectFocusState(target) {
  const control = projectFocusControl(target)
  if (!(control instanceof HTMLElement)) return null
  if (control.id === 'projectDisclosureToggle') {
    return { kind: 'disclosure', project: control.dataset.project ?? null }
  }
  if (control.id === 'closedProjectsTrigger') {
    return { kind: 'trigger', project: control.dataset.project ?? null }
  }
  const projectControl = control.closest('[data-project]')
    ?? control.closest('.rail-row')?.querySelector('[data-project]')
  const project = projectControl?.dataset.project
  if (!project) return null
  if (control.classList.contains('closed-project-reopen')) return { kind: 'reopen', project }
  if (control.classList.contains('closed-project-peek')) return { kind: 'peek', project }
  if (control.classList.contains('rail-close')) return { kind: 'archive', project }
  if (control.classList.contains('rail-tab')) return { kind: 'tab', project }
  return null
}

function restoreProjectFocus(state) {
  if (!state) return
  if (state.kind === 'disclosure') {
    const disclosure = document.getElementById('projectDisclosure')
    if (layout === 'narrow' && disclosure?.dataset.open !== 'true') {
      document.getElementById('projectDisclosureToggle')?.focus()
      return
    }
    focusProjectFallback(state.project === '__all__' ? null : state.project)
    return
  }
  if (state.kind === 'trigger') {
    const trigger = document.getElementById('closedProjectsTrigger')
    if (trigger) {
      trigger.focus()
      return
    }
    focusProjectFallback(state.project, {
      preferFold: !!state.project && closedSet().has(state.project),
    })
    return
  }
  const project = CSS.escape(state.project)
  const selector = {
    reopen: `#closedProjectsPopover [data-project="${project}"] .closed-project-reopen`,
    peek: `#closedProjectsPopover [data-project="${project}"] .closed-project-peek`,
    archive: `#rail [data-project="${project}"] + .rail-close`,
    tab: `#rail .rail-tab[data-project="${project}"]`,
  }[state.kind]
  let target = document.querySelector(selector)
  if (target && !projectControlIsOperable(target)) target = null
  if (state.kind === 'reopen' && !target) {
    target = document.querySelector(`#rail .rail-tab[data-project="${project}"]`)
  }
  if (state.kind === 'peek' && !target) {
    target = document.querySelector(`#rail .rail-tab[data-project="${project}"]`)
  }
  if (
    (state.kind === 'tab' || state.kind === 'archive' || state.kind === 'reopen' || state.kind === 'peek')
    && !target
    && tabletProjectsMode()
    && closedSet().has(state.project)
  ) {
    if (state.kind === 'archive') {
      const trigger = document.getElementById('closedProjectsTrigger')
      if (trigger) {
        trigger.focus()
        return
      }
    }
    if (!focusArchivedProjectControl(state.project)) focusProjectFallback(state.project)
    return
  }
  if ((state.kind === 'tab' || state.kind === 'reopen' || state.kind === 'peek')
    && target?.classList.contains('rail-tab')) {
    if (!promoteProjectTab(`#rail .rail-tab[data-project="${project}"]`)) {
      focusProjectFallback(state.project, { preferFold: closedSet().has(state.project) })
    }
    return
  }
  if ((state.kind === 'reopen' || state.kind === 'peek') && !target) {
    focusProjectFallback(state.project, { preferFold: closedSet().has(state.project) })
    return
  }
  if ((state.kind === 'tab' || state.kind === 'archive') && !target) {
    focusProjectFallback(state.project, { preferFold: closedSet().has(state.project) })
    return
  }
  target?.focus()
}

function setClosedProjectsOpen(open, { restoreFocus = false } = {}) {
  closedFoldOpen = !!open
  tabletDismissedOpenKey = open ? null : (tabletForcedOpenKey || null)
  const trigger = document.getElementById('closedProjectsTrigger')
  trigger?.setAttribute('aria-expanded', String(closedFoldOpen))
  document.getElementById('closedProjectsPopover')?.remove()
  if (closedFoldOpen && tabletClosedSnapshot) {
    document.getElementById('projectDisclosure')
      ?.appendChild(closedProjectsPopoverEl(tabletClosedSnapshot.entries, tabletClosedSnapshot.count))
  }
  if (restoreFocus) trigger?.focus()
}

function closedProjectEntryEl(entry) {
  const row = document.createElement('div')
  row.className = 'closed-project-entry'
  row.dataset.project = entry.key

  const peek = document.createElement('button')
  peek.type = 'button'
  peek.className = 'closed-project-peek'
  peek.setAttribute('aria-label', `View archived project ${entry.label}`)
  peek.setAttribute('aria-pressed', String(projectFilter === entry.key))

  const dot = document.createElement('span')
  dot.className = 'rail-dot'
  if (!entry.unknown) dot.style.background = pcolor(entry.key).dot
  const name = document.createElement('span')
  name.className = 'closed-project-name'
  name.textContent = railLabel(entry.label, 'narrow')
  name.title = entry.label
  const badge = document.createElement('span')
  badge.className = 'rail-badge'
  badge.textContent = entry.total ? String(entry.total) : ''
  badge.hidden = !entry.total
  badge.title = `${entry.total} waiting on you`
  peek.append(dot, name, badge)
  peek.addEventListener('click', () => {
    closeSettings()
    projectFilter = entry.key
    closedFoldOpen = true
    tabletDismissedOpenKey = null
    resetPaging()
    forceRender()
  })

  const reopen = document.createElement('button')
  reopen.type = 'button'
  reopen.className = 'closed-project-reopen'
  reopen.textContent = 'Reopen'
  reopen.setAttribute('aria-label', `Reopen project ${entry.label}`)
  reopen.addEventListener('click', () => reopenProjectAction(entry.key, { focusProject: true }))
  row.append(peek, reopen)
  return row
}

function closedProjectsPopoverEl(entries, count) {
  const popover = document.createElement('div')
  popover.id = 'closedProjectsPopover'
  popover.className = 'closed-projects-popover'
  popover.setAttribute('role', 'region')
  popover.setAttribute('aria-label', 'Archived projects')
  const heading = document.createElement('div')
  heading.className = 'closed-projects-heading'
  heading.textContent = `Archived projects · ${count}`
  popover.appendChild(heading)
  for (const entry of entries) popover.appendChild(closedProjectEntryEl(entry))
  return popover
}

function closedProjectsControl(count, suppressed, open, soleProject = null) {
  const trigger = document.createElement('button')
  trigger.id = 'closedProjectsTrigger'
  trigger.type = 'button'
  trigger.className = 'closed-projects-trigger'
  trigger.setAttribute('aria-expanded', String(open))
  trigger.setAttribute('aria-controls', 'closedProjectsPopover')
  if (soleProject) trigger.dataset.project = soleProject
  const label = document.createElement('span')
  label.textContent = `Archived (${count})`
  trigger.appendChild(label)
  trigger.title = suppressed
    ? `${count} archived project${count === 1 ? '' : 's'} · ${suppressed} item${suppressed === 1 ? '' : 's'} muted`
    : `${count} archived project${count === 1 ? '' : 's'}`
  trigger.addEventListener('click', () => setClosedProjectsOpen(!closedFoldOpen))
  return trigger
}

// The peek banner (issue #32). While you are looking at a closed project the
// list on screen deliberately holds rows no count includes — two numbers
// disagreeing with no explanation is exactly what tenets 2/3 forbid. So say it
// out loud, with the one-click reversal right there. Rendered in the editable frame
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
  text.textContent = `${name} is closed — these items are not included in your Inbox count or Review queue.`
  const reopen = btn('Reopen', () => reopenProjectAction(name))
  reopen.className = 'closed-reopen'
  bar.append(text, reopen)
  content.insertBefore(bar, content.querySelector('main'))
}

// Projects as vertical tabs: color dot · name · per-project attention badge.
// The badges are per-project by
// design; the dock badge and the Needs-you tab count stay global (spec §7
// filter-blindness).
function renderRail() {
  const host = document.getElementById('rail')
  if (!host) return
  const disclosure = document.getElementById('projectDisclosure')
  const tablet = tabletProjectsMode()
  disclosure?.classList.toggle('tablet-projects', tablet)
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
  const openEntries = railEntries(open, counts)
  const entries = filterRailEntries(openEntries, railQuery)
  const closedRows = closedRailEntries(closed, counts)
  const closedEntries = filterRailEntries(closedRows, railQuery)
  const closedSuppressed = suppressedTotal(closedRows)
  const selectedEntry = projectFilter
    ? [...openEntries, ...closedRows].find((entry) => entry.key === projectFilter)
    : openEntries[0]
  updateProjectDisclosure(selectedEntry)
  // The fold opens on demand or while a closed project is being peeked.
  const forcedOpenParts = []
  if (closed.includes(projectFilter)) forcedOpenParts.push(`project:${projectFilter}`)
  const forcedOpenKey = forcedOpenParts.join('\n')
  if (tablet) tabletForcedOpenKey = forcedOpenKey
  if (!closed.length) {
    closedFoldOpen = false
    tabletDismissedOpenKey = null
  }
  const foldOpen = !!closed.length && (
    closedFoldOpen
    || (!!forcedOpenKey && (!tablet || tabletDismissedOpenKey !== forcedOpenKey))
  )
  const th = themeName()
  const sig = JSON.stringify([closedEntries, tablet ? null : foldOpen,
    entries,
    projectFilter,
    th,
    withFilter,
    railQuery,
    layout,
    tablet,
    tablet ? forcedOpenKey : null,
    closed.length,
    closedSuppressed,
  ])
  if (host.dataset.sig === sig) return
  if (tablet) closedFoldOpen = foldOpen
  // rebuilding blows away focus; remember the caret so typing in the filter survives
  const active = document.activeElement
  const focusState = projectFocusState(active)
  const caret = active && active.classList.contains('rail-filter') ? active.selectionStart : null
  host.dataset.sig = sig
  document.getElementById('closedProjectsPopover')?.remove()
  host.innerHTML = ''
  let railFilter = null
  if (withFilter) {
    const f = document.createElement('input')
    f.type = 'search'
    f.className = 'rail-filter'
    f.placeholder = 'Filter projects'
    f.setAttribute('aria-label', 'Filter projects')
    f.value = railQuery
    f.addEventListener('input', () => { railQuery = f.value; renderRail() })
    host.appendChild(f)
    railFilter = f
  }
  for (const e of entries) host.appendChild(railRowEl(e, { withFilter }))
  if (closed.length) {
    if (tablet) {
      tabletClosedSnapshot = { entries: closedEntries, count: closed.length }
      host.appendChild(      closedProjectsControl(
        closed.length,
        closedSuppressed,
        foldOpen,
        closed.length === 1 ? closed[0] : null,
      ))
      if (foldOpen) disclosure?.appendChild(closedProjectsPopoverEl(closedEntries, closed.length))
    } else {
      tabletClosedSnapshot = null
      host.appendChild(closedFoldEl(
        closedEntries,
        closed.length,
        closedSuppressed,
        foldOpen,
        withFilter,
      ))
    }
  } else {
    tabletClosedSnapshot = null
  }
  // roving tablist (spec §13): exactly one project tab is tabbable
  const tabs = [...host.querySelectorAll('.rail-tab')]
  for (const b of tabs) {
    b.tabIndex = b.getAttribute('aria-selected') === 'true' ? 0 : -1
  }
  if (!tabs.some((tab) => tab.tabIndex === 0) && tabs[0]) {
    tabs[0].tabIndex = 0
  }
  wireTablist(host, 'vertical')
  if (caret !== null && railFilter) {
    restoringRailFocus = true
    try {
      railFilter.focus()
      railFilter.setSelectionRange(caret, caret)
    } finally {
      restoringRailFocus = false
    }
  } else {
    restoreProjectFocus(focusState)
  }
}

// the top bar's agent filter — a demoted dropdown scoped to the selected project.
// option text goes through textContent, never innerHTML: agent names are agent-authored.
function renderAgentSelect(agents) {
  const sel = document.getElementById('agentSelect')
  document.body.classList.toggle('agent-filtered', Boolean(agentFilter))
  const sig = JSON.stringify([agents, agentFilter])
  if (sel.dataset.sig === sig) return
  sel.dataset.sig = sig
  sel.innerHTML = ''
  for (const v of [null, ...agents]) {
    const o = document.createElement('option')
    o.value = v ?? ''
    o.textContent = v ?? 'All agents'
    if (v === agentFilter) o.selected = true
    sel.appendChild(o)
  }
}

function initAgentSelect() {
  document.getElementById('agentSelect').addEventListener('change', (e) => {
    agentFilter = e.target.value || null
    resetPaging()
    forceRender()
  })
}

// which content panel is visible; the tab strip drives this in Task 8
function showPanel(id) {
  for (const p of document.querySelectorAll('main > .panel')) p.hidden = p.id !== id
  for (const t of document.querySelectorAll('#tabs .tab')) t.setAttribute('aria-selected', String(t.dataset.tab === id))
  document.body.classList.toggle('settings-open', id === 'setup')
  const page = PAGE_META[id] ?? PAGE_META.needsYou
  document.getElementById('pageKicker').textContent = page.kicker
  document.getElementById('pageTitle').textContent = page.title
  const gear = document.getElementById('gear')
  gear.classList.toggle('active', id === 'setup')
  gear.setAttribute('aria-pressed', String(id === 'setup'))
}

function settingsOpen() {
  return !document.getElementById('setup').hidden
}

function closeSettings({ restoreFocus = false } = {}) {
  if (!settingsOpen()) return false
  selectTab(activeTab)
  if (restoreFocus) document.getElementById('gear').focus()
  return true
}

function toggleSettings() {
  if (!closeSettings()) showPanel('setup')
}

function openUpdates() {
  if (!settingsOpen()) showPanel('setup')
  const section = document.getElementById('updates-settings')
  if (!section) return
  section.scrollIntoView({ block: 'center' })
  section.focus()
  window.agentInboxUpdates?.check?.().catch(() => {})
}

function initGear() {
  document.getElementById('gear').addEventListener('click', toggleSettings)
  window.agentInboxSetup?.onToggleSettings?.(toggleSettings)
  window.agentInboxUpdates?.onOpenUpdates?.(openUpdates)
}

// live entries the user has expanded, by session id — survives the poll rebuild
const openLive = new Set()

function paintLiveProjectDot(dot, project, state) {
  const color = pcolor(project)
  dot.className = `live-dot project ${state}`
  dot.style.setProperty('--project-dot', color.dot)
  dot.style.setProperty('--project-wash', color.wash)
}

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
    const seen = lastActivityAt(a)
    const { tone: fresh } = ageChip(Date.now() - Date.parse(seen))
    const stream = a.stream ? ` · ${esc(a.stream)}` : ''
    const kids = a.children.length ? `<span class="live-kids">▸ ${a.children.length} agent${a.children.length > 1 ? 's' : ''}</span>` : ''
    el.innerHTML = `
      <summary class="card-summary live-summary">
        <span class="live-dot"></span>
        <span class="live-session-copy">
          <span class="live-session-heading">
            <span class="live-state-label working">Working</span>
            <span class="live-who">${esc(a.agent)} · ${esc(a.project)}${stream}</span>
          </span>
          <span class="live-doing">${esc(a.doing)}</span>
        </span>
        ${kids}
        <span class="live-age ${fresh}" title="started ${rel(a.started_at)} ago">last call ${rel(seen)}</span>
      </summary>
      ${a.detail ? `<div class="detail live-detail">${renderStructuredText(a.detail)}</div>` : ''}`
    const dot = el.querySelector('.live-dot')
    paintLiveProjectDot(dot, a.project, 'working')
    dot.title = `${a.project} · working · last call ${rel(seen)} ago`
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
    fold.innerHTML = `<summary>${idle.length} idle session${idle.length > 1 ? 's' : ''}</summary>`
    for (const a of idle) {
      const row = document.createElement('div')
      // #45: hours-quiet sessions keep their row (they ARE present, and their
      // questions still count as waiting) but read as background. listActivity
      // has already sorted them to the bottom of this fold.
      const dormant = isDormant(a, Date.now())
      row.className = dormant ? 'idle-row dormant' : 'idle-row'
      const stream = a.stream ? ` · ${esc(a.stream)}` : ''
      const seen = lastActivityAt(a)
      const { tone: fresh } = ageChip(Date.now() - Date.parse(seen))
      const synopsis = activitySynopsis(a)
      const age = dormant ? `quiet ${rel(seen)}` : `last call ${rel(seen)}`
      row.innerHTML = `
        <span class="live-dot"></span>
        <span class="live-session-copy">
          <span class="live-session-heading">
            <span class="live-state-label idle">Idle</span>
            <span class="live-who">${esc(a.agent)} · ${esc(a.project)}${stream}</span>
          </span>
          <span class="live-doing ${synopsis.historical ? 'historical' : 'empty-summary'}">${synopsis.historical ? 'Last activity: ' : ''}${esc(synopsis.text)}</span>
        </span>
        <span class="live-age ${fresh}" title="last call ${rel(seen)} ago">${age}</span>`
      const dot = row.querySelector('.live-dot')
      paintLiveProjectDot(dot, a.project, 'idle-session')
      dot.title = `${a.project} · idle · last call ${rel(seen)} ago`
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
  const projects = [...new Set(s.sessions.map((x) => x.project))]
  if (projects.length === 1) {
    paintLiveProjectDot(dot, projects[0], 'working')
  } else {
    dot.className = s.count ? 'live-dot aggregate-working' : 'live-dot idle'
    dot.style.removeProperty('--project-dot')
    dot.style.removeProperty('--project-wash')
  }
  dot.title = s.count
    ? `${s.count} working across ${projects.length} project${projects.length === 1 ? '' : 's'}`
    : `${s.idleCount} idle session${s.idleCount === 1 ? '' : 's'}`
  label.textContent = s.label
  list.replaceChildren()
  for (const x of s.sessions) {
    const el = document.createElement('span')
    el.className = `live-session ${x.tone}`
    const projectDot = document.createElement('span')
    paintLiveProjectDot(projectDot, x.project, 'working')
    projectDot.setAttribute('aria-hidden', 'true')
    const text = document.createElement('span')
    text.textContent = x.label
    el.append(projectDot, text)
    list.appendChild(el)
  }
}

let livePinned = false

function setLivePinned(pinned) {
  livePinned = pinned
  const drawer = document.getElementById('liveDrawer')
  const pin = document.getElementById('livePin')
  if (!drawer || !pin) return
  drawer.classList.toggle('pinned', pinned)
  pin.setAttribute('aria-pressed', String(pinned))
  const label = pinned ? 'Unpin Live sessions' : 'Pin Live sessions open'
  pin.setAttribute('aria-label', label)
  pin.title = label
}

function toggleLiveDrawer(open, { restoreFocus = false } = {}) {
  const strip = document.getElementById('liveStrip')
  const drawer = document.getElementById('liveDrawer')
  if (!strip || !drawer) return
  const next = open ?? drawer.hidden
  drawer.hidden = !next
  strip.setAttribute('aria-expanded', String(next))
  if (!next) {
    setLivePinned(false)
    if (restoreFocus) strip.focus()
  }
}

function initLiveBar() {
  const strip = document.getElementById('liveStrip')
  const drawer = document.getElementById('liveDrawer')
  const pin = document.getElementById('livePin')
  if (!strip || !drawer || !pin) return
  strip.addEventListener('click', () => toggleLiveDrawer())
  pin.addEventListener('click', () => setLivePinned(!livePinned))
  const outsideDrawer = (target) => target instanceof Node
    && !drawer.contains(target)
    && !strip.contains(target)
  document.addEventListener('pointerdown', (e) => {
    if (!drawer.hidden && !livePinned && outsideDrawer(e.target)) toggleLiveDrawer(false)
  }, true)
  document.addEventListener('focusin', (e) => {
    if (!drawer.hidden && !livePinned && outsideDrawer(e.target)) toggleLiveDrawer(false)
  })
  document.addEventListener('keydown', (e) => {
    if (nativeKeyOwner(e)) return
    if (e.key === 'Escape' && !drawer.hidden) {
      e.preventDefault()
      toggleLiveDrawer(false, { restoreFocus: true })
    }
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
  send: ({ id, label, context, generation, intent }) => {
    stagedStars.delete(id)
    invalidateItemDraftIntents(id)
    itemLatestIntents[id] = intent
    sendReply(id, label, context, 'answer', generation, intent, false)
  },
})

// a staged send must never be lost to a closing tab
function initStagedFlush() {
  const flushStaged = () => { starStage.flush(); dismissStage.flush() }
  window.addEventListener('beforeunload', flushStaged)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushStaged() })
}

// The Needs-you header: opt-in triage only (tenet 1) — a button, never a flow
// that opens itself. With the old #now strip gone this is the deck's only door.
let actionFilter = 'all'
let changedOnly = false
let askSort = 'priority'
let needsYouHeaderNode = null

function entryEntity(entry) {
  return entry.kind === 'row' ? entry.row : entry.item
}

function filterActionEntries(entries) {
  return entries.filter((entry) => {
    const entity = entryEntity(entry)
    if (actionFilter !== 'all' && actionCategory(entity) !== actionFilter) return false
    if (changedOnly && !changeKind(entity, lastVisitAt)) return false
    return true
  })
}

function syncNeedsYouHeader(bar) {
  for (const filter of bar.querySelectorAll('[data-action-filter]')) {
    filter.classList.toggle('active', filter.dataset.actionFilter === actionFilter)
  }
  const changed = bar.querySelector('[data-changed-filter]')
  changed.classList.toggle('active', changedOnly)
  changed.disabled = !lastVisitAt
  const sort = bar.querySelector('.queue-sort select')
  if (sort.value !== askSort) sort.value = askSort
}

function needsYouHeader() {
  if (needsYouHeaderNode) {
    syncNeedsYouHeader(needsYouHeaderNode)
    return needsYouHeaderNode
  }
  const bar = document.createElement('div')
  bar.className = 'tab-header'
  const filters = document.createElement('div')
  filters.className = 'queue-filter-group'
  for (const [value, label] of [['all', 'All'], ['decision', 'Decisions'], ['task', 'To do']]) {
    const filter = btn(label, () => {
      actionFilter = value
      renderIfIdle()
    })
    filter.className = 'header-toggle'
    filter.dataset.actionFilter = value
    filters.appendChild(filter)
  }
  const changed = btn('Updates', () => {
    changedOnly = !changedOnly
    renderIfIdle()
  })
  changed.className = 'header-toggle'
  changed.dataset.changedFilter = '1'
  filters.appendChild(changed)
  const tools = document.createElement('div')
  tools.className = 'queue-tool-group'
  const sortLabel = document.createElement('label')
  sortLabel.className = 'queue-sort'
  const sortText = document.createElement('span')
  sortText.textContent = 'Sort'
  const sort = document.createElement('select')
  sort.setAttribute('aria-label', 'Sort queue')
  for (const option of ASK_SORT_OPTIONS) {
    const el = document.createElement('option')
    el.value = option.value
    el.textContent = option.label
    sort.appendChild(el)
  }
  sort.value = askSort
  sort.addEventListener('change', () => {
    askSort = sort.value
    pinnedIds = []
    renderIfIdle()
  })
  sortLabel.append(sortText, sort)
  tools.appendChild(sortLabel)
  const relay = btn('Handoffs', openRelay)
  relay.className = 'relay-btn'
  tools.appendChild(relay)
  const tri = btn('Review queue', openTriage)
  tri.className = 'triage-btn'
  tools.appendChild(tri)
  bar.append(filters, tools)
  needsYouHeaderNode = bar
  syncNeedsYouHeader(bar)
  return bar
}

function needsEntryId(entry) {
  return entry.kind === 'row' ? entry.row.id : entry.item.id
}

function protectedNeedsYouIds() {
  const ids = new Set()
  if (pendingFocusId) ids.add(pendingFocusId)
  if (openRowId) ids.add(openRowId)
  if (selectedId) ids.add(selectedId)
  const focusedId = document.activeElement?.closest?.('#needsYouList .nrow[data-card-id]')?.dataset.cardId
  if (focusedId) ids.add(focusedId)
  for (const [id, draft] of Object.entries(rowDrafts)) if (draft) ids.add(id)
  for (const [id, draft] of Object.entries(draftReplies)) if (draft) ids.add(id)
  for (const [id, draft] of Object.entries(draftReplyContexts)) if (draft) ids.add(id)
  return ids
}

function paginateNeedsYou(entries, protectedIds) {
  let limit = shown.needsYou
  entries.forEach((entry, index) => {
    if (protectedIds.has(needsEntryId(entry))) limit = Math.max(limit, index + 1)
  })
  shown.needsYou = limit
  return paginate(entries, limit)
}

function paginateWithPending(entries, section) {
  const baseLimit = shown[section]
  let limit = baseLimit
  const protectedId = pendingFocusId ?? pagedFocusId
  const targetIndex = protectedId
    ? entries.findIndex((entry) => entry.id === protectedId)
    : -1
  if (targetIndex >= 0) limit = Math.max(limit, targetIndex + 1)
  const page = paginate(entries, limit)
  const viewed = targetIndex >= baseLimit
    ? [...page.visible.slice(0, baseLimit), entries[targetIndex]]
    : page.visible
  return { ...page, viewed: viewed.filter(Boolean) }
}

function replaceNeedsYouBody(host, header) {
  for (const child of [...host.children]) {
    if (child !== header) child.remove()
  }
  if (header.parentElement !== host) host.appendChild(header)
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
  panel.innerHTML = '<div class="calm-head">Your queue is clear</div>'
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
  const protectedIds = protectedNeedsYouIds()
  const openQueueRow = openRowId ? needsYouRowEl(openRowId) : null
  const openCard = openQueueRow?.querySelector('.nrow-card') ?? null
  const openRowViewportTop = openQueueRow?.getBoundingClientRect().top ?? null
  const cardFocus = openCard ? captureCardFocus(openCard, openRowId) : null
  const askedTimeFocusId = focusedAskedTimeId()
  if (openCard) openRowScrollTop = cardScrollHost(openCard).scrollTop
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
  const snoozed = sortDeferredEntries(
    filterActionEntries(snoozedEntries(items, boardsInView, nowMs, closedSet())),
  )
  const unordered = filterActionEntries(needsYouEntries(items, boardsInView, nowMs, live, [...replied, ...awaiting]))
  // §10: pin existing order BEFORE paginating. New arrivals append at the foot,
  // so they appear live without moving the row the human is reading.
  const entries = askSort === 'priority'
    ? (() => {
        const entryById = new Map(unordered.map((e) => [e.kind === 'row' ? e.row.id : e.item.id, e]))
        return orderedIds([...entryById.keys()]).map((id) => entryById.get(id)).filter(Boolean)
      })()
    : sortNeedsYouByAsk(unordered, askSort)
  const entities = [...items, ...boardsInView]
  const opts = {
    streams: streamCounts(entities),
    agents: agentCounts(entities),
    showProject: !projectFilter, // a single selected project needs no monogram (§2)
    lastVisitAt,
  }
  const { visible, remaining } = paginateNeedsYou(entries, protectedIds)
  const stale = sortDeferredEntries(filterActionEntries(staleEntries(items, nowMs, live)))
  const header = needsYouHeader()
  replaceNeedsYouBody(host, header)
  if (!entries.length) {
    // A demoted stale item is, by definition, not something that needs you.
    renderEmptyState(host)
  }
  for (const e of visible) host.appendChild(needsRowEl(rowModel(e, opts), e, nowMs))
  if (remaining > 0) host.appendChild(moreButton('needsYou', remaining))
  if (snoozed.length) host.appendChild(snoozedFoldEl(snoozed, opts, nowMs))
  if (stale.length) host.appendChild(staleFoldEl(stale, opts, nowMs))
  renderOrphanedDrafts(host)
  // fix round 2 (I3): the foot chip is fed the SAME scoped notes the Notes tab
  // count is computed from (render()'s `g.notes`). It used to read the GLOBAL
  // lastData.g.notes, so the chip and the badge disagreed under any rail filter.
  renderNeedsYouExtras(host, g.notes.flatMap((gr) => gr.items))
  const restoredRow = openRowId ? needsYouRowEl(openRowId) : null
  const restoredCard = restoredRow?.querySelector('.nrow-card') ?? null
  if (restoredCard && openRowScrollTop > 0) cardScrollHost(restoredCard).scrollTop = openRowScrollTop
  if (restoredRow && openRowViewportTop !== null) {
    const viewportDelta = restoredRow.getBoundingClientRect().top - openRowViewportTop
    if (Number.isFinite(viewportDelta) && Math.abs(viewportDelta) > 0.5) {
      window.scrollBy(0, viewportDelta)
    }
  }
  const restoredCardFocus = restoreCardFocus(cardFocus)
  const restoredAskedTimeFocus = restoreAskedTimeFocus(askedTimeFocusId)
  // §13: `selectedId` (Task 17) is module state, same pattern as openRowId/
  // staleFoldOpen — the DOM just rebuilt above has no idea a row was selected,
  // so reapply it. Neither selection nor an open card suspends polling. Restore
  // row focus only when focus was already inside the list and the open card did
  // not restore its own control; a poll must never yank focus from elsewhere.
  restoreRowSelection(hadListFocus && !restoredCardFocus && !restoredAskedTimeFocus)
}

function renderOrphanedDrafts(host) {
  const activeRows = new Map((lastData?.boards ?? [])
    .flatMap((board) => board.rows.map((row) => [row.id, row.revision])))
  const entries = [
    ...Object.entries(staleItemDrafts).map(([key, draft]) => ({
      id: key,
      draft,
      retry: () => retryItemDraft(key, draft),
      clear: () => deleteItemDraftRecovery(key, draft.owner),
      text: [
        draft.title,
        `${draft.kind}: ${draft.text}`,
        draft.context ? `context: ${draft.context}` : '',
      ].filter(Boolean).join(' · '),
    })),
    ...Object.entries(staleRowDrafts)
      .filter(([, draft]) =>
        activeRows.get(draft.rowId) !== draft.revision
        || !needsYouRowEl(draft.rowId)?.querySelector('.reply-input'))
      .map(([key, draft]) => ({
        id: key,
        draft,
        clear: () => {
          delete staleRowDrafts[key]
          clearRowRecoveryTarget(draft.rowId, draft.revision)
          return true
        },
        text: [
          draft.boardTitle,
          draft.label,
          `action ${draft.actionVersion ?? draft.revision}`,
          `${draft.kind}: ${draft.text}`,
          draft.context ? `context: ${draft.context}` : '',
        ].filter(Boolean).join(' · '),
      })),
  ]
  if (!entries.length) return
  const fold = document.createElement('details')
  fold.className = 'stale-fold stale-drafts-fold'
  fold.open = true
  const summary = document.createElement('summary')
  summary.tabIndex = 0
  summary.textContent = `unsent responses (${entries.length})`
  fold.appendChild(summary)
  for (const entry of entries) {
    const line = document.createElement('div')
    line.className = 'stale-draft-line'
    line.textContent = entry.text
    if (entry.retry) {
      const retry = btn('Retry', entry.retry)
      retry.className = 'undo-btn'
      line.appendChild(retry)
    }
    const clear = btn('Clear', () => {
      if (!entry.clear()) {
        forceRender()
        return
      }
      line.remove()
      const remaining = fold.querySelectorAll('.stale-draft-line').length
      if (remaining) summary.textContent = `unsent responses (${remaining})`
      else fold.remove()
      renderIfIdle()
    })
    clear.className = 'undo-btn'
    line.appendChild(clear)
    fold.appendChild(line)
  }
  host.appendChild(fold)
}

// the stale fold's open/closed state, outside the DOM the 3s poll rebuilds —
// same precedent as openLive/openContexts: without this the fold silently
// re-collapses under the user mid-read
let staleFoldOpen = false
let snoozedFoldOpen = false

function revealDetailsAncestors(target) {
  for (let node = target; node; node = node.parentElement) {
    if (node.tagName !== 'DETAILS') continue
    node.open = true
    if (node.dataset.cardId) setCardCollapsed(node.dataset.cardId, false)
    if (node.classList.contains('snoozed-fold')) snoozedFoldOpen = true
    else if (node.classList.contains('stale-fold')) staleFoldOpen = true
    if (node.classList.contains('archived-fold')) showArchived = true
  }
}

function snoozedFoldEl(entries, opts, nowMs) {
  const fold = document.createElement('details')
  fold.className = 'stale-fold snoozed-fold'
  if (snoozedFoldOpen) fold.open = true
  fold.addEventListener('toggle', () => {
    snoozedFoldOpen = fold.open
    restoreRowSelection(false)
  })
  const summary = document.createElement('summary')
  summary.textContent = `snoozed (${entries.length})`
  fold.appendChild(summary)
  for (const entry of entries) fold.appendChild(needsRowEl(rowModel(entry, opts), entry, nowMs))
  return fold
}

// nobody is listening and it is older than STALE_MS: out of the active list and
// out of every count, but one click away — never deleted (§6)
function staleFoldEl(entries, opts, nowMs) {
  const fold = document.createElement('details')
  fold.className = 'stale-fold'
  if (staleFoldOpen) fold.open = true
  fold.addEventListener('toggle', () => {
    staleFoldOpen = fold.open
    restoreRowSelection(false)
  })
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
  el.setAttribute('role', 'listitem')
  el.setAttribute('aria-current', 'false')
  el.setAttribute('aria-expanded', String(openRowId === m.id))
  el.tabIndex = -1
  const chip = urgencyChip(m, nowMs)
  el.setAttribute('aria-label', `${m.title}. ${m.ownerLabel}. ${chip.text}.`)
  const color = pcolor(m.project)
  const glyph = m.kind === 'row' ? `<button class="nrow-glyph" title="Open plan: ${esc(m.boardTitle ?? '')}">Plan</button>` : ''
  // Items only. Board rows deliberately have no line-level ✕: their expanded
  // card owns the truthful dispositions (snooze, clarify, decline, or do/answer).
  // The old ✕ advertised the x key and did nothing.
  const dismissBit = m.kind === 'item' ? '<button class="nrow-dismiss" title="Dismiss (x)" aria-label="Dismiss">✕</button>' : ''
  const wakeBit = m.snoozedUntil ? '<button class="nrow-wake" title="Return to Needs you now">Wake now</button>' : ''
  const projBit = m.projectLabel ? `<span class="nrow-proj" title="${esc(m.project)}">${esc(m.projectLabel)}</span>` : ''
  const agentBit = m.agent ? `<span class="nrow-agent">${esc(m.agent)}</span>` : ''
  const streamBit = m.stream ? `<span class="nrow-stream">${esc(m.stream)}</span>` : ''
  const ownerBit = `<span class="nrow-owner owner-${esc(m.actionCategory)}">${esc(m.ownerLabel)}</span>`
  const changeBit = m.changeKind ? `<span class="nrow-change">${esc(m.changeKind)}</span>` : ''
  const asked = askTimeModel(m.askedAt, nowMs)
  const askedBit = asked
    ? `<time class="nrow-asked" datetime="${esc(asked.datetime)}" data-exact="${esc(asked.exact)}" aria-label="${esc(asked.accessibleLabel)}" tabindex="0">${esc(asked.text)}</time>`
    : ''
  // omit line 2 entirely when it would be blank — no secondary text, no agent
  // chip, no stream — otherwise it leaves a padded empty line under the row.
  // Still built (with staged-dismiss's own content) when a dismiss is staged,
  // since the ✕ handler below replaces this div's children in place.
  const showL2 = m.secondary || agentBit || streamBit || stagedDismiss.has(m.id)
  const l2 = showL2 ? `<div class="nrow-l2"><span class="nrow-sec">${esc(m.secondary)}</span>${agentBit}${streamBit}</div>` : ''
  el.innerHTML = `
    <div class="nrow-l1">
      <div class="nrow-primary">
        <span class="pdot" style="background:${color.dot}" title="${esc(m.project)}"></span>
        ${projBit}
        ${glyph}
        <span class="nrow-title" title="${esc(m.title)}">${esc(m.title)}</span>
      </div>
      <div class="nrow-meta">
        ${ownerBit}
        ${changeBit}
        ${askedBit}
        <span class="chip chip-${chip.tone}"><span aria-hidden="true">${livenessGlyph(m.liveness).glyph}</span> ${esc(chip.text)}</span>
        <span class="nrow-src">${sourceChipsHtml(linkIndex, entry.kind === 'row' ? entry.board : entry.item, nowMs)}</span>
        <span class="nrow-star"></span>
        ${wakeBit}
        ${dismissBit}
        <span class="nrow-caret">▸</span>
      </div>
    </div>
    ${l2}`
  el.style.setProperty('--wash', color.wash)
  const boardBtn = el.querySelector('.nrow-glyph')
  if (boardBtn) boardBtn.addEventListener('click', (ev) => { ev.stopPropagation(); jumpToCard('boards', m.boardId) })
  const askedEl = el.querySelector('.nrow-asked')
  if (askedEl) {
    const selectAskedRow = () => {
      selectedId = m.id
      markSelectedRow(m.id)
    }
    askedEl.addEventListener('focus', selectAskedRow)
    askedEl.addEventListener('click', (ev) => {
      selectAskedRow()
      askedEl.focus({ preventScroll: true })
      ev.stopPropagation()
    })
    askedEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault()
        ev.stopPropagation()
      }
    })
  }
  const dismissBtn = el.querySelector('.nrow-dismiss')
  if (dismissBtn) dismissBtn.addEventListener('click', (ev) => {
    ev.stopPropagation()
    stageDismiss(m.id)
  })
  const wakeBtn = el.querySelector('.nrow-wake')
  if (wakeBtn) wakeBtn.addEventListener('click', async (ev) => {
    ev.stopPropagation()
    const url = entry.kind === 'row'
      ? `/api/boards/${entry.board.id}/rows/${entry.row.id}/snooze`
      : `/api/items/${entry.item.id}/snooze`
    const res = await postJSON(url, entry.kind === 'row'
      ? {
          until: null,
          expected_revision: entry.row.revision,
          expected_board_version: entry.board.revision,
        }
      : { until: null })
    if (res === null) return
    if (!res.ok) { await reloadAndPaint(); return }
    await reloadAndPaint()
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
      if (starStage.undo(`star:${m.id}`)) {
        cancelItemIntent(m.id, staged.intent, staged.previousIntent)
        stagedStars.delete(m.id)
        forceRender()
        return
      }
      const fresh = freshItem(m.id) ?? entry.item
      const refusal = undoRefusal(fresh, Date.now())
      if (refusal) { label.textContent = `${refusal} ` } else changeAnswer(fresh, label)
    })
    undo.className = 'undo-btn'
    slot.replaceChildren(label, undo)
  } else if (opt) {
    const star = btn('★', () => {
      const previousIntent = itemLatestIntents[m.id] ?? null
      const intent = claimItemIntent(m.id, { staged: true })
      stagedStars.set(m.id, { label: opt.label, intent, previousIntent })
      starStage.stage(`star:${m.id}`, {
        id: m.id,
        label: opt.label,
        context: draftReplyContexts[m.id] ?? '',
        generation: itemDraftGenerations[m.id] ?? 0,
        intent,
      })
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
  el.addEventListener('mousedown', (ev) => {
    if (openRowId !== m.id || ev.button !== 0) return
    if (rowInteractiveDescendant(ev.target, el)) return
    const card = el.querySelector('.nrow-card')
    if (!card?.contains(document.activeElement)) return
    ev.preventDefault()
  })
  el.addEventListener('click', (ev) => {
    if (rowInteractiveDescendant(ev.target, el)) return
    activateRow(el, m, entry, nowMs)
  })
  el.addEventListener('keydown', (ev) => {
    if (ev.target !== el) return
    if (ev.key === 'Enter') { ev.preventDefault(); activateRow(el, m, entry, nowMs) }
    if (ev.key === 'Escape' && openRowId === m.id) { ev.preventDefault(); collapseRow(m.id) }
  })
  // a full render (poll or user action) rebuilds the open row from openRowId
  if (openRowId === m.id) {
    el.dataset.open = '1'
    el.setAttribute('aria-expanded', 'true')
    el.appendChild(rowCardBodyEl(entry, m, nowMs))
  }
  return el
}

// the inline expanded body — one card component, mounted under the row (§4)
function rowCardBodyEl(entry, m, nowMs) {
  const body = document.createElement('div')
  body.className = 'nrow-card'
  body.tabIndex = -1
  body.addEventListener('click', (ev) => ev.stopPropagation()) // clicks in the card must not collapse it
  const head = document.createElement('div')
  head.className = 'nrow-card-head'
  const heading = document.createElement('div')
  const title = document.createElement('strong')
  title.textContent = m.title
  const meta = document.createElement('span')
  meta.textContent = [m.project, m.agent].filter(Boolean).join(' · ')
  heading.append(title, meta)
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'nrow-card-close'
  close.setAttribute('aria-label', 'Close action')
  close.title = 'Close action (Esc)'
  close.textContent = '×'
  close.addEventListener('click', (ev) => {
    ev.stopPropagation()
    collapseRow(m.id)
  })
  head.append(heading, close)

  const scroll = document.createElement('div')
  scroll.className = 'nrow-card-scroll'
  const trackScroll = () => noteInspectorScroll(m.id, scroll)
  scroll.addEventListener('wheel', trackScroll, { passive: true })
  scroll.addEventListener('scroll', trackScroll, { passive: true })
  // `entry` is a render-time closure and the §10 gate can hold a render for
  // minutes, so the snapshot inside it goes stale (issue #31.1, layer 2: a row
  // reopened after a Change answer would otherwise re-mount the OLD reply and
  // hide the answer surface again). Same freshItem() precedent as the star's
  // Undo fallback. Resolved in place: `entry.item` is undefined for board rows.
  const card = entry.kind === 'row'
    ? rowCardEl(entry.board, entry.row, undefined, { includeAsked: false })
    : itemCardEl(freshItem(entry.item.id) ?? entry.item, {
        nowMs,
        liveness: m.liveness,
        includeAsked: false,
      })
  const answer = card.querySelector(':scope > .row-answer, :scope > .options')
  scroll.appendChild(card)
  body.append(head, scroll)
  if (answer) {
    const compose = document.createElement('div')
    compose.className = 'nrow-card-compose'
    compose.appendChild(answer)
    body.appendChild(compose)
  }
  return body
}

const ROW_INTERACTIVE_SELECTOR = `${CARD_FOCUS_SELECTOR}, label, [role="button"], [contenteditable]:not([contenteditable="false"])`

function rowInteractiveDescendant(target, row) {
  if (!(target instanceof Element)) return false
  const owner = target.closest(ROW_INTERACTIVE_SELECTOR)
  return owner !== null && owner !== row
}

// The fixed desktop inspector is selection, while the compact inline card keeps
// its accordion toggle. `setOpenRow` remains the only writer of logical state.
function activateRow(el, m, entry, nowMs) {
  if (openRowId === m.id) {
    if (layout !== 'wide') {
      collapseRow(m.id)
      return
    }
    if (selectedId !== m.id) {
      selectedId = m.id
      markSelectedRow(m.id)
      const card = el.querySelector('.nrow-card')
      if (!card?.contains(document.activeElement)) el.focus({ preventScroll: true })
    }
    return
  }
  selectedId = m.id
  markSelectedRow(m.id)
  setOpenRow(m.id, { resume: false })
  for (const other of document.querySelectorAll('.nrow[data-open="1"]')) {
    other.removeAttribute('data-open')
    other.setAttribute('aria-expanded', 'false')
    const card = other.querySelector('.nrow-card')
    if (card) card.remove()
  }
  const liveEl = needsYouRowEl(m.id) ?? el
  liveEl.dataset.open = '1'
  liveEl.setAttribute('aria-expanded', 'true')
  liveEl.appendChild(rowCardBodyEl(entry, m, nowMs))
  resumeRender()
  requestAnimationFrame(() => {
    const card = needsYouRowEl(m.id)?.querySelector('.nrow-card')
    if (card && !card.contains(document.activeElement)) {
      card.tabIndex = -1
      card.focus({ preventScroll: true }) // focus moves into the card (spec §13)
    }
  })
}

// Explicit collapse is separate from activation so pointer/Enter re-selection is
// idempotent while Escape still closes and restores focus to the owning row.
function collapseRow(id) {
  if (openRowId !== id) return
  selectedId = id
  markSelectedRow(id)
  setOpenRow(null)
  const el = needsYouRowEl(id)
  el?.removeAttribute('data-open')
  el?.setAttribute('aria-expanded', 'false')
  el?.querySelector('.nrow-card')?.remove()
  renderIfIdle()
  requestAnimationFrame(() => selectRow(id))
}

// notes keep a card list, but flat: no project h3, no agent h4 (§15)
function renderGroups(sectionId, groups) {
  const host = document.querySelector(`#${sectionId} .groups`)
  const items = groups.flatMap((gr) => gr.items)
  const { visible, remaining, viewed } = paginateWithPending(items, sectionId)
  host.innerHTML = items.length ? '' : '<p class="empty">Nothing here.</p>'
  for (const it of visible) host.appendChild(itemEl(it))
  if (remaining > 0) host.appendChild(moreButton(sectionId, remaining))
  // fix round 2 (I3): mark seen only what was actually on screen. The hidden set
  // is the GLOBAL note list minus what rendered — a note behind the "Show N
  // more" pager and a note behind the rail's project filter were equally unseen,
  // and there is one watermark covering every scope.
  if (sectionId === 'notes' && activeTab === 'notes') {
    const shownIds = new Set(viewed.map((it) => it.id))
    const all = lastData.g.notes.flatMap((gr) => gr.items)
    markNotesSeen(viewed, all.filter((n) => !shownIds.has(n.id)), all)
  }
}

const openHistoryItems = new Set()

function historyItemEl(it) {
  const el = document.createElement('details')
  el.className = `history-row item ${it.kind}`
  el.dataset.cardId = it.id
  liveCardIds.add(it.id)
  el.open = openHistoryItems.has(it.id) || pendingFocusId === it.id || pagedFocusId === it.id
  el.addEventListener('toggle', () => {
    if (el.open) openHistoryItems.add(it.id)
    else openHistoryItems.delete(it.id)
  })

  const summary = document.createElement('summary')
  summary.className = 'history-summary'
  const color = pcolor(it.project)
  const dot = document.createElement('span')
  dot.className = 'history-dot'
  dot.style.background = color.dot
  dot.setAttribute('aria-hidden', 'true')
  const copy = document.createElement('span')
  copy.className = 'history-copy'
  const title = document.createElement('strong')
  title.textContent = it.title
  const outcome = document.createElement('span')
  outcome.className = 'history-outcome'
  outcome.textContent = it.outcome
    || (it.reply ? `You answered: ${it.reply}` : '')
    || it.detail
    || (it.status === 'dismissed' ? 'Dismissed' : 'Completed')
  copy.append(title, outcome)
  const meta = document.createElement('span')
  meta.className = 'history-meta'
  meta.textContent = `${it.project} · ${it.agent}`
  const stamp = it.outcome_at ?? it.resolved_at ?? it.updated_at ?? it.created_at
  const time = document.createElement('time')
  time.dateTime = stamp
  time.textContent = rel(stamp)
  meta.appendChild(time)
  const arrow = document.createElement('span')
  arrow.className = 'history-arrow'
  arrow.setAttribute('aria-hidden', 'true')
  arrow.textContent = '›'
  summary.append(dot, copy, meta, arrow)
  el.append(summary, itemCardEl(it, { done: it.status !== 'open', header: false }))
  return el
}

function renderDone(items) {
  const host = document.querySelector('#done .items')
  const { visible, remaining } = paginateWithPending(items, 'done')
  host.innerHTML = items.length ? '' : '<p class="empty">Nothing yet.</p>'
  for (const it of visible) host.appendChild(historyItemEl(it))
  if (remaining > 0) host.appendChild(moreButton('done', remaining))
}

const GLYPH = { done: '✓', partial: '◐', missing: '×', tracked: '→', na: '—', blocked: '!' }
const STATUS_LABEL = {
  done: 'Done',
  partial: 'In progress',
  missing: 'Missing',
  tracked: 'Tracked',
  na: 'Not applicable',
  blocked: 'Needs input',
}

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
  const t = btn(hideCompleted ? 'Show completed rows' : 'Hide completed rows', () => {
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
  const rest = archived.filter((b) => !lingerIds.has(b.id))
  if (!boards.length && !lingering.length && !rest.length) host.insertAdjacentHTML('beforeend', '<p class="empty">No plans yet.</p>')
  const { visible, remaining } = paginateWithPending(boards, 'boards')
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
    fold.innerHTML = `<summary>Archived plans (${rest.length})</summary>`
    const page = paginateWithPending(rest, 'archived')
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
      <div class="bar-label"><strong class="prog-primary">${p.primary}</strong> done <span class="prog-secondary">${p.secondary} weighted</span>${p.complete ? '<span class="complete-badge">✓ complete</span>' : ''}${lingering ? '<span class="linger-badge">completed — archived</span>' : ''}${hidden ? `<span class="hidden-hint" title="show this board's completed rows">· ${hidden} done hidden — show</span>` : ''}</div>
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
    tr.dataset.rowId = r.id
    // one-line note only; the long context lives behind the row click
    tr.innerHTML = `
      <td class="row-num">${num}</td>
      <td class="row-glyph ${r.status}" title="${esc(STATUS_LABEL[r.status] ?? r.status)}">${GLYPH[r.status] || ''}</td>
      <td class="row-label">${esc(r.label)}</td>
      <td class="row-note"><span class="note-line">${esc(boardRowLine(r))}</span>${r.context ? '<span class="more-dot" title="has background — click the row">…</span>' : ''}${r.annotation ? `<span class="annotation-dot" title="${esc(r.annotation)}">Note${r.annotation_unseen ? '<span class="unseen" title="not yet delivered to an agent">●</span>' : ''}</span>` : ''}${r.handled_at ? `<span class="handled-dot" title="you marked your part done">✓${r.handled_seen_at ? '' : '<span class="unseen" title="not yet delivered to an agent">●</span>'}</span>` : ''}</td>`
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
      ptr.dataset.rowId = r.id
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
  actions.appendChild(btn('Plan flow', () => openMission(b)))
  if (archived) {
    actions.appendChild(btn('Un-archive', async () => {
      const res = await postJSON(`/api/boards/${b.id}/unarchive`, { expected_version: b.revision })
      if (res === null) return // network failure — postJSON already signaled it
      await reloadAndPaint() // #38 — the human's own click gets its frame
    }))
  } else {
    actions.appendChild(archiveBtn(b))
  }
  el.appendChild(actions)
  return el
}

// two-step inline confirm: first click arms ("Really archive?"), second click within
// 4s archives; it disarms after 4s (and implicitly on re-render — the DOM is rebuilt)
function archiveBtn(board) {
  let timer = null
  const el = btn('Archive', async () => {
    if (el.classList.contains('confirm')) {
      clearTimeout(timer)
      // a board the HUMAN archives by hand must not linger — lingering is only
      // for the agent's own auto-archive at 100% (spec §9)
      sessionActiveBoards.delete(board.id)
      const res = await postJSON(`/api/boards/${board.id}/archive`, { expected_version: board.revision })
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
const openRowCompares = new Set() // blocked-row ids with option tradeoffs expanded
const openDispositionMenus = new Set() // item/row keys with secondary responses expanded
const draftReplies = {}          // item id → in-progress free-text answer
const draftReplyContexts = {}    // item id → optional context attached to the answer
const itemDraftMeta = {}         // item id → recovery labels if its answer surface disappears
const itemDraftGenerations = {}  // item id → monotonic edit token across duplicate editors
const itemSubmissionTokens = {}  // item id → latest async submission allowed to retire its draft
const itemLatestIntents = {}     // item id → latest non-cancelled human intent
const itemDraftRetryIntents = {} // item id → exact ambiguous intent while its draft generation is unchanged
const itemDraftSubmissions = {}  // item id → in-flight free-text intents keyed by draft generation
const staleItemDrafts = {}       // recovery key → refused/orphaned answer preserved outside the poll gate
const ITEM_REPLY_INTENT_SESSION_KEY = 'agent-inbox-reply-intent'

function effectiveReply(it) {
  return draftReplies[it.id] ?? (it.reply_source === 'agent' ? (it.reply ?? '') : '')
}

function effectiveReplyContext(it) {
  return draftReplyContexts[it.id] ?? (it.reply_source === 'agent' ? (it.reply_context ?? '') : '')
}

function isVerifiedReload() {
  const navigation = globalThis.performance?.getEntriesByType?.('navigation')?.[0]
  if (navigation?.type) return navigation.type === 'reload'
  return globalThis.performance?.navigation?.type === 1
}

const storedReplyIntent = (() => {
  if (isVerifiedReload()) {
    try {
      const parsed = JSON.parse(sessionStorage.getItem(ITEM_REPLY_INTENT_SESSION_KEY) ?? 'null')
      const clientId = typeof parsed?.clientId === 'string' ? parsed.clientId.trim() : ''
      if (
        clientId
        && clientId.length <= 128
        && Number.isSafeInteger(parsed.sequence)
        && parsed.sequence >= 0
        && parsed.sequence < Number.MAX_SAFE_INTEGER
      ) return { clientId, sequence: parsed.sequence }
    } catch {
      // Corrupt window-local state gets a new identity rather than blocking replies.
    }
  }
  const fresh = { clientId: globalThis.crypto.randomUUID(), sequence: 0 }
  sessionStorage.setItem(ITEM_REPLY_INTENT_SESSION_KEY, JSON.stringify(fresh))
  return fresh
})()

function claimItemIntent(id, { staged = false } = {}) {
  if (!staged) invalidateItemDraftIntents(id)
  const sequence = ++storedReplyIntent.sequence
  sessionStorage.setItem(ITEM_REPLY_INTENT_SESSION_KEY, JSON.stringify(storedReplyIntent))
  const intent = { sequence, actionId: globalThis.crypto.randomUUID() }
  if (!staged) itemLatestIntents[id] = intent
  if (!staged) cancelStagedItemIntent(id)
  return intent
}

function sameItemIntent(left, right) {
  return Boolean(left && right
    && left.sequence === right.sequence
    && left.actionId === right.actionId)
}

function rememberItemDraftSubmission(id, generation, intent) {
  const submissions = itemDraftSubmissions[id] ?? new Map()
  const submission = {
    intent: { ...intent },
    recoveryKey: null,
    recoveryOwner: null,
    retryable: true,
  }
  submissions.set(generation, submission)
  itemDraftSubmissions[id] = submissions
  return submission
}

function itemDraftSubmission(id, generation, intent = null) {
  const submission = itemDraftSubmissions[id]?.get(generation) ?? null
  if (intent && !sameItemIntent(submission?.intent, intent)) return null
  return submission
}

function retireItemDraftSubmission(id, generation, intent) {
  const submissions = itemDraftSubmissions[id]
  const submission = submissions?.get(generation)
  if (!submissions || !sameItemIntent(submission?.intent, intent)) return
  submissions.delete(generation)
  if (!submissions.size) delete itemDraftSubmissions[id]
}

function retireItemDraftSubmissionIntent(id, intent) {
  const submissions = itemDraftSubmissions[id]
  if (!submissions) return
  for (const [generation, submission] of submissions) {
    if (sameItemIntent(submission.intent, intent)) submissions.delete(generation)
  }
  if (!submissions.size) delete itemDraftSubmissions[id]
}

function invalidateItemDraftIntents(id) {
  delete itemDraftRetryIntents[id]
  for (const submission of itemDraftSubmissions[id]?.values() ?? []) {
    submission.retryable = false
  }
}

function cancelItemIntent(id, cancelled, previous) {
  if (!sameItemIntent(itemLatestIntents[id], cancelled)) return
  if (previous) itemLatestIntents[id] = previous
  else delete itemLatestIntents[id]
}

function cancelStagedItemIntent(id) {
  if (!starStage.undo(`star:${id}`)) return false
  const stagedIntent = stagedStars.get(id)
  if (stagedIntent) cancelItemIntent(id, stagedIntent.intent, stagedIntent.previousIntent)
  stagedStars.delete(id)
  const row = needsYouRowEl(id)
  row?.classList.remove('staged')
  row?.querySelector('.nrow-star')?.replaceChildren()
  return true
}

function postItemReply(id, body, intent) {
  return postJSON(`/api/items/${id}/reply`, {
    ...body,
    intent_client_id: storedReplyIntent.clientId,
    intent_sequence: intent.sequence,
    intent_action_id: intent.actionId,
  })
}

function itemDraftRecoveryKey(id, { intent, generation, kind }) {
  return intent
    ? `item:${id}:intent:${intent.actionId}`
    : `item:${id}:draft:${generation}:${kind}`
}

function itemDraftRecoveryOwner(intent, generation) {
  return {
    token: globalThis.crypto.randomUUID(),
    generation,
    sequence: intent?.sequence ?? null,
    actionId: intent?.actionId ?? null,
  }
}

function sameItemDraftRecoveryOwner(left, right) {
  return Boolean(left && right
    && left.token === right.token
    && left.generation === right.generation
    && left.sequence === right.sequence
    && left.actionId === right.actionId)
}

function deleteItemDraftRecovery(key, expectedOwner) {
  const current = staleItemDrafts[key]
  if (!current || !sameItemDraftRecoveryOwner(current.owner, expectedOwner)) return false
  delete staleItemDrafts[key]
  return true
}

function deleteMatchingItemDraftRecoveries(id, { text, context, kind }) {
  let removed = false
  for (const [key, draft] of Object.entries(staleItemDrafts)) {
    if (
      draft.itemId !== id
      || draft.kind !== kind
      || draft.text.trim() !== text.trim()
      || draft.context.trim() !== context.trim()
    ) continue
    removed = deleteItemDraftRecovery(key, draft.owner) || removed
  }
  return removed
}

function transferItemDraftRecovery(key, expectedOwner, intent, generation) {
  const current = staleItemDrafts[key]
  if (!current || !sameItemDraftRecoveryOwner(current.owner, expectedOwner)) return null
  const owner = itemDraftRecoveryOwner(intent, generation)
  staleItemDrafts[key] = {
    ...current,
    intent: { ...intent },
    owner,
  }
  return owner
}

function preserveItemDraftRecovery(id, {
  key = null,
  title,
  text,
  context,
  kind,
  intent = null,
  ownerIntent = intent,
  owner = null,
  expectedOwner = null,
  generation = itemDraftGenerations[id] ?? 0,
}) {
  const recoveryKey = key ?? itemDraftRecoveryKey(id, { intent, generation, kind })
  if (
    key
    && expectedOwner
    && !sameItemDraftRecoveryOwner(staleItemDrafts[key]?.owner, expectedOwner)
  ) return null
  staleItemDrafts[recoveryKey] = {
    itemId: id,
    title,
    text,
    context,
    kind,
    intent: intent ? { ...intent } : null,
    owner: owner ?? itemDraftRecoveryOwner(ownerIntent, generation),
  }
  return recoveryKey
}

function retryItemDraft(key, draft) {
  return sendReply(
    draft.itemId,
    draft.text,
    draft.context,
    draft.kind,
    itemDraftGenerations[draft.itemId] ?? 0,
    draft.intent ?? null,
    true,
    false,
    key,
    draft.owner,
  )
}

function reusableDraftIntent(id, generation) {
  const retry = itemDraftRetryIntents[id]
  if (!retry || retry.generation !== generation) return null
  return retry.intent
}

function hasDraftRecovery() {
  return Object.keys(staleItemDrafts).length > 0 || Object.keys(staleRowDrafts).length > 0
}

function requestDraftRecovery(target = draftRecoveryTarget) {
  draftRecoveryFocusPending = true
  if (target) {
    draftRecoveryTarget = target
    projectFilter = target.project
    agentFilter = null
    actionFilter = 'all'
    changedOnly = false
    resetSearch()
    setOpenRow(target.rowId)
    selectRow(target.rowId)
  }
  if (triageDeck) closeTriage({ restoreFocus: false })
  if (missionBoardId) closeMission({ restoreFocus: false })
  if (relayOpen) closeRelay()
  selectTab('needsYou')
}

function restoreDraftRecoveryFocus() {
  if (!draftRecoveryFocusPending) return false
  const inline = draftRecoveryTarget
    ? needsYouRowEl(draftRecoveryTarget.rowId)?.querySelector('.reply-input[data-recovered-draft="1"]')
    : null
  if (inline) revealDetailsAncestors(inline)
  const visibleInline = inline && !inline.closest('[hidden], details:not([open])') ? inline : null
  const target = visibleInline ?? document.querySelector('.stale-drafts-fold summary')
  if (!target) return false
  target.focus({ preventScroll: true })
  const restored = document.activeElement === target
  if (restored) draftRecoveryFocusPending = false
  return restored
}

function currentRow(id) {
  for (const board of lastData?.boards ?? []) {
    const row = board.rows.find((candidate) => candidate.id === id)
    if (row) return { board, row }
  }
  return null
}

function reconcileDraftOwners() {
  let recovered = false
  const itemIds = new Set([...Object.keys(draftReplies), ...Object.keys(draftReplyContexts)])
  for (const id of itemIds) {
    const text = draftReplies[id] ?? ''
    const context = draftReplyContexts[id] ?? ''
    if (!text.trim() && !context.trim()) continue
    const item = freshItem(id)
    if (item && cardSections(item).showAnswer) continue
    const generation = itemDraftGenerations[id] ?? 0
    const activeSubmission = itemDraftSubmission(id, generation)
    const intent = reusableDraftIntent(id, generation)
      ?? (activeSubmission?.retryable ? activeSubmission.intent : null)
    const recoveryOwner = itemDraftRecoveryOwner(
      activeSubmission?.intent ?? intent,
      generation,
    )
    const recoveryKey = preserveItemDraftRecovery(id, {
      title: itemDraftMeta[id]?.title ?? item?.title ?? 'Question',
      text,
      context,
      kind: 'answer',
      generation,
      intent,
      ownerIntent: activeSubmission?.intent ?? intent,
      owner: recoveryOwner,
    })
    if (activeSubmission && recoveryKey) {
      activeSubmission.recoveryKey = recoveryKey
      activeSubmission.recoveryOwner = recoveryOwner
    }
    bumpDraftGeneration(itemDraftGenerations, id)
    delete draftReplies[id]
    delete draftReplyContexts[id]
    delete itemDraftMeta[id]
    delete itemDraftRetryIntents[id]
    recovered = true
  }

  for (const [id, text] of Object.entries(rowDrafts)) {
    const meta = rowDraftMeta[id]
    if (!String(text).trim()) continue
    const owner = currentRow(id)
    if (owner && meta?.revision === owner.row.revision) continue
    const revision = meta?.revision ?? -1
    staleRowDrafts[rowDraftRecoveryKey(id, revision)] = {
      rowId: id,
      revision,
      actionVersion: meta?.actionVersion,
      text,
      kind: rowDraftKinds[id] ?? 'answer',
      boardTitle: meta?.boardTitle ?? 'Plan',
      label: meta?.label ?? 'Removed row',
      context: meta?.context ?? '',
    }
    bumpDraftGeneration(rowDraftGenerations, id)
    delete rowDrafts[id]
    delete rowDraftKinds[id]
    delete rowDraftMeta[id]
    recovered = true
  }
  if (recovered) requestDraftRecovery()
  return recovered
}

async function sendReply(
  id,
  text,
  context = '',
  kind = 'answer',
  submittedGeneration = itemDraftGenerations[id] ?? 0,
  intent = null,
  recoverUndraftedFailure = true,
  submissionUsesDraft = false,
  recoveryKey = null,
  recoveryOwner = null,
) {
  const reply = text.trim()
  if (!reply) return
  const hadDraft = draftReplies[id] !== undefined || draftReplyContexts[id] !== undefined
  if (recoveryKey) delete itemDraftRetryIntents[id]
  const replayingRecordedIntent = Boolean(recoveryKey && intent)
  intent ??= submissionUsesDraft ? reusableDraftIntent(id, submittedGeneration) : null
  if (intent) cancelStagedItemIntent(id)
  intent ??= claimItemIntent(id)
  if (!sameItemIntent(itemLatestIntents[id], intent) && !replayingRecordedIntent) return
  const submittedRecoveryOwner = recoveryKey
    ? transferItemDraftRecovery(
        recoveryKey,
        recoveryOwner,
        intent,
        submittedGeneration,
      )
    : null
  if (recoveryKey && !submittedRecoveryOwner) {
    forceRender()
    return
  }
  const submissionToken = bumpDraftGeneration(itemSubmissionTokens, id)
  if (submissionUsesDraft && hadDraft) {
    rememberItemDraftSubmission(id, submittedGeneration, intent)
  }
  // fix round 2 (C3): both drafts used to be deleted BEFORE the POST. When the
  // write failed (postJSON → null: server restarted, or now any non-2xx) the
  // human's typed answer was gone — the next render rebuilt an empty input and
  // #status's "disconnected" was wiped by the next successful poll ≤3s later.
  // Nothing is cleared until the server has it.
  const recoveryTitle = itemDraftMeta[id]?.title ?? freshItem(id)?.title ?? 'Question'
  const res = await postItemReply(id, {
    text: reply,
    context: context.trim() || undefined,
    kind,
  }, intent)
  const latestIntent = sameItemIntent(itemLatestIntents[id], intent)
  const ownsSubmission = latestIntent
    && (itemDraftGenerations[id] ?? 0) === submittedGeneration
    && itemSubmissionTokens[id] === submissionToken
  const trackedSubmission = itemDraftSubmission(id, submittedGeneration, intent)
  if (res === null) {
    if (!latestIntent) {
      retireItemDraftSubmission(id, submittedGeneration, intent)
      return
    }
    if (!submissionUsesDraft) {
      if (recoverUndraftedFailure) {
        preserveItemDraftRecovery(id, {
          key: recoveryKey,
          title: recoveryTitle,
          text,
          context,
          kind,
          intent,
          expectedOwner: submittedRecoveryOwner,
          generation: submittedGeneration,
        })
        requestDraftRecovery()
        showWriteError(id, '')
        await reloadAndPaint()
      } else {
        showWriteError(id, WRITE_FAILED)
        resumeRender()
      }
      return
    }
    if (trackedSubmission?.recoveryKey) {
      retireItemDraftSubmission(id, submittedGeneration, intent)
      showWriteError(id, WRITE_FAILED)
      resumeRender()
      return
    }
    // re-assert rather than merely leave in place, so a future edit that clears
    // early still cannot lose it. Only when the human HAD a draft: inventing one
    // for an option-pill/★ send would park text in an input nobody typed into
    // (and suspend the poll on it — the C2 failure mode).
    if (
      hadDraft
      && ownsSubmission
      && submissionUsesDraft
      && trackedSubmission?.retryable
    ) {
      draftReplies[id] = text
      draftReplyContexts[id] = context
      itemDraftRetryIntents[id] = {
        generation: submittedGeneration,
        intent: { ...intent },
      }
      retireItemDraftSubmission(id, submittedGeneration, intent)
    } else if (!hadDraft && ownsSubmission && recoverUndraftedFailure) {
      preserveItemDraftRecovery(id, {
        key: recoveryKey,
        title: recoveryTitle,
        text,
        context,
        kind,
        intent,
        expectedOwner: submittedRecoveryOwner,
        generation: submittedGeneration,
      })
      requestDraftRecovery()
      showWriteError(id, WRITE_FAILED)
      await reloadAndPaint()
      return
    }
    showWriteError(id, WRITE_FAILED)
    resumeRender()
    return
  }
  if (sameItemIntent(itemDraftRetryIntents[id]?.intent, intent)) {
    delete itemDraftRetryIntents[id]
  }
  if (!res.ok) {
    if (!latestIntent) {
      const rejectedRecoveryKeys = [
        [recoveryKey, submittedRecoveryOwner],
        [trackedSubmission?.recoveryKey, trackedSubmission?.recoveryOwner],
      ].filter(([key]) => Boolean(key))
      let removedRecovery = false
      for (const [key, owner] of rejectedRecoveryKeys) {
        removedRecovery = deleteItemDraftRecovery(key, owner) || removedRecovery
      }
      retireItemDraftSubmission(id, submittedGeneration, intent)
      if (removedRecovery) {
        showWriteError(id, '')
        await reloadAndPaint()
      }
      return
    }
    if (!submissionUsesDraft) {
      if (recoverUndraftedFailure) {
        const item = freshItem(id)
        preserveItemDraftRecovery(id, {
          key: recoveryKey,
          title: itemDraftMeta[id]?.title ?? item?.title ?? recoveryTitle,
          text,
          context,
          kind,
          intent,
          expectedOwner: submittedRecoveryOwner,
          generation: submittedGeneration,
        })
        requestDraftRecovery()
        showWriteError(id, '')
        await reloadAndPaint()
      } else {
        showWriteError(id, WRITE_FAILED)
        resumeRender()
      }
      return
    }
    if (trackedSubmission?.recoveryKey) {
      retireItemDraftSubmission(id, submittedGeneration, intent)
      showWriteError(id, WRITE_FAILED)
      resumeRender()
      return
    }
    if (!ownsSubmission) {
      showWriteError(id, 'An earlier response was not applied; your newer draft is preserved.')
      resumeRender()
      return
    }
    if (hadDraft && !trackedSubmission?.retryable) {
      showWriteError(id, 'An earlier response was not applied; your newer draft is preserved.')
      resumeRender()
      return
    }
    const item = freshItem(id)
    preserveItemDraftRecovery(id, {
      key: recoveryKey,
      title: itemDraftMeta[id]?.title ?? item?.title ?? recoveryTitle,
      text,
      context,
      kind,
      intent,
      expectedOwner: submittedRecoveryOwner,
      generation: submittedGeneration,
    })
    retireItemDraftSubmission(id, submittedGeneration, intent)
    requestDraftRecovery()
    bumpDraftGeneration(itemDraftGenerations, id)
    delete draftReplies[id]
    delete draftReplyContexts[id]
    delete itemDraftMeta[id]
    showWriteError(id, '')
    await reloadAndPaint()
    return
  }
  if (recoveryKey) deleteItemDraftRecovery(recoveryKey, submittedRecoveryOwner)
  if (trackedSubmission?.recoveryKey) {
    deleteItemDraftRecovery(
      trackedSubmission.recoveryKey,
      trackedSubmission.recoveryOwner,
    )
  }
  if (latestIntent) {
    deleteMatchingItemDraftRecoveries(id, { text, context, kind })
  }
  retireItemDraftSubmission(id, submittedGeneration, intent)
  if (recoveryKey) retireItemDraftSubmissionIntent(id, intent)
  if (!latestIntent) return
  if (ownsSubmission && !recoveryKey) {
    bumpDraftGeneration(itemDraftGenerations, id)
    delete draftReplies[id]
    delete draftReplyContexts[id]
    delete itemDraftMeta[id]
    delete itemDraftRetryIntents[id]
  }
  showWriteError(id, '')
  // issue #38, the reported surface. Also the entry for the option pills, the ★'s
  // staged send, the editor shortcut and the triage card — all of them were silent.
  await reloadAndPaint()
}

// the answer surface on an unanswered question: option pills (recommended
// first), a Compare toggle for the tradeoffs, and a free-text answer
function answerEl(it) {
  const wrap = document.createElement('div')
  wrap.className = `options${openCompares.has(it.id) ? ' comparing' : ''}`
  let editorGeneration = itemDraftGenerations[it.id] ?? 0
  const opts = optionOrder(it.options)
  for (const o of opts) {
    const box = document.createElement('div')
    box.className = 'option'
    const pill = document.createElement('button')
    pill.className = `opt-pill${o.recommended ? ' rec' : ''}`
    pill.innerHTML = `${esc(o.label)}${o.recommended ? '<span class="rec-tag">recommended</span>' : ''}`
    pill.addEventListener('click', () => sendReply(
      it.id, o.label, effectiveReplyContext(it), 'answer', editorGeneration,
    ))
    box.appendChild(pill)
    if (o.detail) {
      const d = document.createElement('div')
      d.className = 'opt-detail'
      d.innerHTML = renderStructuredText(o.detail)
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
  const input = document.createElement('textarea')
  input.className = 'reply-input'
  input.rows = 1
  input.setAttribute('aria-keyshortcuts', 'Control+Enter Meta+Enter')
  input.dataset.draftFocusKey = `${it.id}:answer`
  input.placeholder = opts.length ? 'or answer in your own words…' : 'answer…'
  input.value = effectiveReply(it)
  const rememberDraftOwner = () => {
    if (input.value.trim() || ctxInput.value.trim()) itemDraftMeta[it.id] = { title: it.title }
    else delete itemDraftMeta[it.id]
  }
  input.addEventListener('input', () => {
    invalidateItemDraftIntents(it.id)
    editorGeneration = bumpDraftGeneration(itemDraftGenerations, it.id)
    draftReplies[it.id] = input.value
    resizeReplyEditor(input)
    rememberDraftOwner()
    resumeRender()
  })
  const submit = () => sendReply(
    it.id, input.value, ctxInput.value, 'answer', editorGeneration, null, true, true,
  )
  bindReplyEditor(input, submit)
  row.appendChild(input)
  row.appendChild(btn('Send', submit))
  row.appendChild(writeErrorEl(it.id)) // persists a failed write's reason across the poll rebuild (C3)
  wrap.appendChild(row)
  const ctxRow = document.createElement('div')
  ctxRow.className = 'reply-row reply-context-row'
  const ctxInput = document.createElement('textarea')
  ctxInput.className = 'reply-input reply-context-input'
  ctxInput.rows = 1
  ctxInput.setAttribute('aria-keyshortcuts', 'Control+Enter Meta+Enter')
  ctxInput.dataset.draftFocusKey = `${it.id}:context`
  ctxInput.placeholder = 'optional context for the agent (applies to Send or option picks)…'
  ctxInput.value = effectiveReplyContext(it)
  ctxInput.addEventListener('input', () => {
    invalidateItemDraftIntents(it.id)
    editorGeneration = bumpDraftGeneration(itemDraftGenerations, it.id)
    draftReplyContexts[it.id] = ctxInput.value
    resizeReplyEditor(ctxInput)
    rememberDraftOwner()
    resumeRender()
  })
  bindReplyEditor(ctxInput, submit)
  ctxRow.appendChild(ctxInput)
  wrap.appendChild(ctxRow)
  wrap.appendChild(dispositionEl(
    (kind, text) => sendReply(
      it.id, text, effectiveReplyContext(it), kind, editorGeneration,
    ),
    async (until) => {
      const res = await postJSON(`/api/items/${it.id}/snooze`, { until })
      if (res === null) return
      await reloadAndPaint()
    },
    `item:${it.id}`,
  ))
  return wrap
}

// THE card (§4): meta → title → detail → labeled CONTEXT → options → answer →
// actions. Mounted inline by the Needs-you accordion and by the triage lightbox.
function itemCardEl(it, {
  done = false,
  nowMs = Date.now(),
  liveness = 'parked',
  header = true,
  includeAsked = true,
} = {}) {
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
  const nextStep = done && s.outcome ? null : s.nextStep
  el.innerHTML = `
    ${head}
    ${sourceBlockHtml(linkIndex, it, nowMs)}
    ${actionBlocksHtml(s.detail, nextStep, s.actionOwner, s.impact, s.nextAfter, s.context, `item:${it.id}`)}
    ${s.annotation ? `<div class="annotation"><strong>Note:</strong> ${esc(s.annotation)}</div>` : ''}
    ${s.recWarning ? `<div class="rec-warning">Review: ${esc(s.recWarning)}</div>` : ''}
    ${s.reply || it.reply_kind ? `<div class="reply-block"><strong>${esc(responseLabel(it) || 'You answered')}:</strong> ${esc(s.reply ?? '')}${it.reply_context ? `<div class="reply-context">Context: ${esc(it.reply_context)}</div>` : ''}${it.reply_source === 'agent' ? '<span class="reply-source">via chat</span>' : ''}${s.showPickup ? `<span class="pickup ${it.reply_seen_at ? 'picked' : 'awaiting'}">${it.reply_seen_at ? 'With the agent' : 'Waiting for the agent'}</span>` : ''}</div>` : ''}
    ${outcomeHtml(s.outcome, it.outcome_at)}
    ${lifecycleHtml(it, { includeAsked })}`
  bindContextDisclosures(el)
  if (s.showAnswer) el.appendChild(answerEl(it))
  if (s.showActions) {
    const actions = document.createElement('div')
    actions.className = 'actions'
    actions.appendChild(btn('Resolve', () => act(it.id, 'resolve')))
    actions.appendChild(btn('Dismiss', () => act(it.id, 'dismiss')))
    if (s.answered && !s.showAnswer) {
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
  const intent = claimItemIntent(it.id)
  const res = await postItemReply(it.id, { text: '' }, intent)
  if (res === null) return // network failure — postJSON already signaled it
  if (!sameItemIntent(itemLatestIntents[it.id], intent)) return
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
  bumpDraftGeneration(itemDraftGenerations, it.id)
  requestedDraftFocusBookmark = { key: `${it.id}:answer`, scopeId: 'needsYouList' }
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

function allRowEls() {
  return [...document.querySelectorAll('#needsYouList .nrow[data-card-id]')]
}

function rowEls() {
  return allRowEls().filter((el) => !el.closest('[hidden], details:not([open])'))
}

// class/attr/tabIndex only — no focus side effect, so it's safe to call from a
// passive rebuild (restoreRowSelection) as well as a deliberate user action
// (selectRow)
function markSelectedRow(id) {
  const operable = new Set(rowEls())
  for (const el of allRowEls()) {
    const on = operable.has(el) && el.dataset.cardId === id
    el.classList.toggle('selected', on)
    el.setAttribute('aria-current', String(on))
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
  const rows = rowEls()
  if (!rows.length && document.getElementById('needsYou')?.hidden) {
    markSelectedRow(null)
    return
  }
  if (!selectedId || !rows.some((el) => el.dataset.cardId === selectedId)) {
    selectedId = rows[0]?.dataset.cardId ?? null
  }
  markSelectedRow(selectedId)
  if (focusIt) {
    if (selectedId) rows.find((el) => el.dataset.cardId === selectedId)?.focus({ preventScroll: true })
  }
}

// The keyboard's reply target. `selectedId` is the LIST's selection — while the
// triage deck is open that is a different row than whatever the lightbox is
// showing, so a bare selected-id lookup would let '1'-'4' (and dismiss/resolve)
// answer the WRONG item. While the deck is open, the target is always the entry
// currently on screen in it. `deckEntryAt` (public/keys.js) is the guarded,
// unit-tested lookup — the deck's "all clear" state (entries: [] while
// triageDeck is still non-null) would otherwise make `triageDeck.entries[i]`
// undefined and findEntryData(undefined) throw, and initKeys evaluates this on
// every keydown the deck is open. Outside the deck, target only an operable
// queue row: actual focus first, then the roving selection, then a visible open
// inspector as a fallback. Hidden tabs and closed folds therefore cannot retain
// destructive shortcut ownership.
function keyTargetItem() {
  if (triageDeck) {
    const entry = deckEntryAt(triageDeck.entries, triageDeck.index)
    const data = entry ? findEntryData(entry) : null
    if (data?.it) return { kind: 'item', item: data.it, options: data.it.options }
    if (data?.r) return { kind: 'row', board: data.b, row: data.r, options: data.r.options }
    return null
  }
  const operable = rowEls()
  const focused = document.activeElement?.closest?.('#needsYouList .nrow[data-card-id]')
  const focusedId = focused && operable.includes(focused) ? focused.dataset.cardId : null
  const selectedIsOperable = operable.some((row) => row.dataset.cardId === selectedId)
  const openIsOperable = operable.some((row) => row.dataset.cardId === openRowId)
  const id = focusedId
    ?? (selectedIsOperable ? selectedId : null)
    ?? (openIsOperable ? openRowId : null)
  if (!id || !lastData) return null
  const item = allItems(lastData.g).find((candidate) => candidate.id === id)
  return item ? { kind: 'item', item, options: item.options } : null
}

function runIntent(intent) {
  const ids = rowEls().map((el) => el.dataset.cardId)
  const target = keyTargetItem()
  const it = target?.kind === 'item' ? target.item : null
  switch (intent.type) {
    case 'move': {
      if (!ids.length) return
      const at = ids.indexOf(selectedId)
      const from = at < 0 ? (intent.delta > 0 ? -1 : ids.length) : at
      selectRow(ids[Math.max(0, Math.min(ids.length - 1, from + intent.delta))])
      return
    }
    case 'expand': {
      // A real row click shares pointer activation and focus-into-card behavior.
      if (!selectedId) return
      rowEls().find((el) => el.dataset.cardId === selectedId)?.click()
      return
    }
    case 'collapse': {
      if (!openRowId) return
      collapseRow(openRowId)
      return
    }
    case 'exitPeek': {
      if (!projectFilter || !closedSet().has(projectFilter)) return
      projectFilter = null
      selectedId = null
      resetPaging()
      forceRender()
      const trigger = document.getElementById('closedProjectsTrigger')
      if (trigger) trigger.focus()
      else focusProjectFallback(null, { preferFold: true })
      return
    }
    case 'clearSelection':
      selectRow(null)
      return
    case 'option': {
      const entity = target?.kind === 'row' ? target.row : it
      const o = optionOrder(entity?.options)[intent.index]
      if (o && target?.kind === 'row') {
        document.querySelectorAll('#lightbox .lb-card .row-options .opt-pill')[intent.index]?.click()
      } else if (o && it) {
        sendReply(it.id, o.label, effectiveReplyContext(it))
      }
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
      focusSearch()
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

function focusSearch(selectText = false) {
  const search = document.getElementById('search')
  search.focus()
  if (selectText) search.select()
}

function initKeys() {
  document.addEventListener('keydown', (e) => {
    const t = e.target
    const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
    const triageOwnsKey = !!triageDeck
      && !typing
      && (e.key === 'Escape'
        || /^[1-4]$/.test(e.key)
        || ['j', 'k', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key))
    if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
      e.preventDefault()
      if (higherPriorityEscapeSurfaceOpen()) return
      focusSearch(true)
      return
    }
    if (!triageOwnsKey && nativeKeyOwner(e)) return
    if (e.key === ',' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
      e.preventDefault()
      toggleSettings()
      return
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === 'Escape' && missionDetailRowId) {
      e.preventDefault()
      closeMissionDetail()
      return
    }
    if (e.key === 'Escape' && missionBoardId) {
      e.preventDefault()
      closeMission()
      return
    }
    if (e.key === 'Escape' && relayOpen) {
      e.preventDefault()
      closeRelay()
      return
    }
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
    if (e.key === 'Escape' && !triageDeck && closeSettings({ restoreFocus: true })) {
      e.preventDefault()
      e.stopImmediatePropagation()
      return
    }
    // optionCount must come from the SAME target runIntent will answer — the
    // deck entry while it's open, the list selection otherwise — or a keyboard
    // '1'-'4' can validate against one item and answer another (see
    // keyTargetItem).
    const intent = keyAction(e.key, {
      typing,
      deckOpen: !!triageDeck,
      expanded: openRowId != null,
      peeking: !!projectFilter && closedSet().has(projectFilter),
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
function beginProjectMutation(name, closed) {
  const generation = ++projectMutationGeneration
  projectMutationVersions.set(name, generation)
  projectMutationIntents.set(name, { generation, closed, confirmedAfterLoad: null })
  applyProjectMutationIntents()
  return generation
}

function latestProjectMutation(name, generation) {
  return projectMutationVersions.get(name) === generation
}

function ownsProjectMutation(name, generation) {
  return projectMutationIntents.get(name)?.generation === generation
}

function finishProjectMutation(name, generation) {
  if (ownsProjectMutation(name, generation)) projectMutationIntents.delete(name)
  if (latestProjectMutation(name, generation)) projectMutationVersions.delete(name)
}

function confirmProjectMutation(name, generation, closed, confirmedAfterLoad) {
  const confirmed = confirmedProjectMutationIntents.get(name)
  if (!confirmed || generation > confirmed.generation) {
    confirmedProjectMutationIntents.set(name, {
      generation,
      closed,
      confirmedAfterLoad,
    })
  }
  const intent = projectMutationIntents.get(name)
  if (intent?.generation === generation) intent.confirmedAfterLoad = confirmedAfterLoad
}

function retireConfirmedProjectMutationIntents(completedLoadGeneration) {
  for (const [name, confirmed] of confirmedProjectMutationIntents) {
    if (completedLoadGeneration <= confirmed.confirmedAfterLoad) continue
    confirmedProjectMutationIntents.delete(name)
    const intent = projectMutationIntents.get(name)
    if (intent?.generation === confirmed.generation) projectMutationIntents.delete(name)
  }
}

function applyProjectMutationIntents() {
  if (!lastData) return
  const closed = new Set(authoritativeClosed)
  for (const [name, intent] of confirmedProjectMutationIntents) {
    if (intent.closed) closed.add(name)
    else closed.delete(name)
  }
  for (const [name, intent] of projectMutationIntents) {
    if (intent.closed) closed.add(name)
    else closed.delete(name)
  }
  lastData.closed = [...closed]
}

async function queueProjectMutation(name, write) {
  const previous = projectMutationQueues.get(name) ?? Promise.resolve()
  const current = previous.then(write, write)
  projectMutationQueues.set(name, current)
  try {
    return await current
  } finally {
    if (projectMutationQueues.get(name) === current) projectMutationQueues.delete(name)
  }
}

function resolveAuthoritativeRefreshWaiters(completedLoadGeneration) {
  for (const waiter of authoritativeRefreshWaiters) {
    if (completedLoadGeneration <= waiter.afterGeneration) continue
    authoritativeRefreshWaiters.delete(waiter)
    waiter.resolve()
  }
}

function waitForAuthoritativeRefresh(afterGeneration) {
  if (appliedClosedGeneration > afterGeneration) return Promise.resolve()
  return new Promise((resolve) => {
    authoritativeRefreshWaiters.add({ afterGeneration, resolve })
  })
}

async function refreshAuthoritativeProjectState(afterGeneration) {
  if (await reloadAndPaint()) return
  await waitForAuthoritativeRefresh(afterGeneration)
}

async function closeProjectAction(name, { focusArchived = false } = {}) {
  const generation = beginProjectMutation(name, true)
  closedFoldOpen = true // show the human where the tab went
  tabletDismissedOpenKey = null
  if (projectFilter === name) projectFilter = null
  resetPaging()
  forceRender()
  if (focusArchived) focusProjectControl('closedProjectsTrigger', generation)
  let restoreFocus = false
  const res = await queueProjectMutation(
    name,
    () => postJSON('/api/projects/close', { project: name }),
  )
  if (res !== null) {
    const confirmedAfterLoad = loadGeneration
    const current = ownsProjectMutation(name, generation)
      && latestProjectMutation(name, generation)
    restoreFocus = current
      && focusArchived
      && projectMutationOwnsFocus('#closedProjectsTrigger', generation)
    confirmProjectMutation(name, generation, true, confirmedAfterLoad)
    await refreshAuthoritativeProjectState(confirmedAfterLoad)
  }
  if (!latestProjectMutation(name, generation)) return
  if (res === null) {
    if (!ownsProjectMutation(name, generation)) return
    restoreFocus = focusArchived && projectMutationOwnsFocus('#closedProjectsTrigger', generation)
    finishProjectMutation(name, generation)
    applyProjectMutationIntents()
    forceRender()
    if (restoreFocus) {
      focusProjectTab(`#rail .rail-tab[data-project="${CSS.escape(name)}"]`, generation)
    }
    return
  }
  finishProjectMutation(name, generation)
  if (restoreFocus && projectMutationOwnsFocus('#closedProjectsTrigger', generation)) {
    focusProjectControl('closedProjectsTrigger', generation)
  }
}

async function reopenProjectAction(name, { focusProject = false } = {}) {
  const generation = beginProjectMutation(name, false)
  const projectSelector = `#rail .rail-tab[data-project="${CSS.escape(name)}"]`
  if (focusProject) closedFoldOpen = false
  forceRender()
  if (focusProject) {
    focusProjectTab(projectSelector, generation)
  }
  let restoreFocus = false
  const res = await queueProjectMutation(
    name,
    () => postJSON('/api/projects/reopen', { project: name }),
  )
  if (res !== null) {
    const confirmedAfterLoad = loadGeneration
    const current = ownsProjectMutation(name, generation)
      && latestProjectMutation(name, generation)
    restoreFocus = current
      && focusProject
      && projectMutationOwnsFocus(projectSelector, generation)
    confirmProjectMutation(name, generation, false, confirmedAfterLoad)
    await refreshAuthoritativeProjectState(confirmedAfterLoad)
  }
  if (!latestProjectMutation(name, generation)) return
  if (res === null) {
    if (!ownsProjectMutation(name, generation)) return
    restoreFocus = focusProject && projectMutationOwnsFocus(projectSelector, generation)
    finishProjectMutation(name, generation)
    applyProjectMutationIntents()
    forceRender()
    if (restoreFocus) focusProjectControl('closedProjectsTrigger', generation)
    return
  }
  finishProjectMutation(name, generation)
  if (restoreFocus && projectMutationOwnsFocus(projectSelector, generation)) {
    focusProjectTab(projectSelector, generation)
  }
}

// Search is a combobox over the loaded workspace index. It never mutates the
// queue or its badges; selection reuses the same deep-link path as notifications.
function initSearch() {
  const input = document.getElementById('search')
  const dock = input.closest('.floating-search')
  input.addEventListener('input', () => {
    if (searchTimer) {
      clearTimeout(searchTimer)
      searchTimer = null
    }
    const value = input.value
    if (!value.trim()) {
      resetSearch()
      return
    }
    const queryChanged = searchQuery.trim() !== value.trim()
    if (!queryChanged) {
      finishSearchUpdate()
      setSearchActive(searchActiveIndex)
      return
    }
    beginSearchUpdate()
    searchTimer = setTimeout(() => {
      searchTimer = null
      searchQuery = value
      searchIndexOpen = true
      searchActiveIndex = -1
      renderSearchResults()
    }, 120)
  })
  input.addEventListener('focus', () => {
    const value = input.value.trim()
    if (!value || searchIndexOpen) return
    searchQuery = input.value
    searchIndexOpen = true
    renderSearchResults()
  })
  input.addEventListener('keydown', (event) => {
    if (event.isComposing) {
      event.stopPropagation()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      resetSearch({ blur: true })
      return
    }
    if (!searchIndexOpen || searchUpdating || !searchResultCache.length) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      const start = searchActiveIndex < 0 ? (delta > 0 ? -1 : 0) : searchActiveIndex
      setSearchActive((start + delta + searchResultCache.length) % searchResultCache.length)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      activateSearchResult(searchActiveIndex < 0 ? 0 : searchActiveIndex)
    }
  })
  dock?.addEventListener('focusout', (event) => {
    if (event.relatedTarget instanceof Node && dock.contains(event.relatedTarget)) return
    closeSearchResults()
  })
  document.addEventListener('pointerdown', (event) => {
    if (!searchIndexOpen && !searchTimer) return
    if (event.target instanceof Node && dock?.contains(event.target)) return
    closeSearchResults()
    if (document.activeElement === input) input.blur()
  }, true)
}

function setupTargetLabel(target) {
  return {
    all: 'Claude Code + Copilot CLI',
    claude: 'Claude Code',
    copilot: 'Copilot CLI',
  }[target]
}

function setupMenu(s, host, canInstall) {
  const wrap = document.createElement('div')
  wrap.className = 'setup-menu'
  const title = document.createElement('h3')
  title.textContent = 'Set up MCP + agent instructions'
  const hint = document.createElement('p')
  hint.className = 'setup-hint'
  hint.textContent = 'Choose the hosts once, then install here or hand the exact command to an agent or terminal. Optional Claude wake hooks stay under Advanced setup.'

  const select = document.createElement('select')
  select.className = 'setup-target'
  select.setAttribute('aria-label', 'Agents to configure')
  for (const [value, label] of [
    ['all', 'Claude Code + Copilot CLI (recommended)'],
    ['claude', 'Claude Code only'],
    ['copilot', 'Copilot CLI only'],
  ]) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    select.appendChild(option)
  }

  const commands = {
    all: s.agentInstallCommand,
    claude: s.claudeInstallCommand,
    copilot: s.copilotInstallCommand,
  }
  const actions = document.createElement('div')
  actions.className = 'setup-menu-actions'
  const commandPreview = document.createElement('pre')
  commandPreview.className = 'setup-command-preview'
  const result = document.createElement('pre')
  result.className = 'setup-result'
  result.hidden = true

  const showResult = (text, success = false) => {
    result.textContent = text
    result.hidden = false
    result.classList.toggle('success', success)
    result.classList.toggle('failure', !success)
  }
  const copy = async (button, text) => {
    try {
      await navigator.clipboard.writeText(text)
      button.textContent = 'Copied ✓'
      setTimeout(() => updateLabels(), 1500)
    } catch {
      showResult('Clipboard access failed. Copy the command from Advanced setup below.')
    }
  }

  let run = null
  if (canInstall && window.agentInboxSetup?.install) {
    run = btn('', async () => {
      const target = select.value
      run.disabled = true
      select.disabled = true
      showResult(`Installing ${setupTargetLabel(target)}…`)
      try {
        const outcome = await window.agentInboxSetup.install(target)
        showResult(
          outcome.output || (outcome.ok ? 'Setup complete. Start fresh agent sessions to load it.' : 'Setup failed without output.'),
          outcome.ok,
        )
      } catch (err) {
        showResult(`Setup failed: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        run.disabled = false
        select.disabled = false
        updateLabels()
      }
    })
    run.className = 'setup-run-btn'
    actions.appendChild(run)
  } else {
    const note = document.createElement('p')
    note.className = 'setup-hint setup-app-note'
    note.textContent = 'Open this panel in the Electron app for one-click installation.'
    wrap.appendChild(note)
  }

  const agent = btn('Copy prompt for agent', () => {
    const command = commands[select.value]
    const prompt = `Run this setup command for me, verify it succeeds, and report any action I need to take:\n\n${command}`
    copy(agent, prompt)
  })
  agent.className = 'setup-agent-btn'
  actions.appendChild(agent)
  const terminal = btn('Copy terminal command', () => copy(terminal, commands[select.value]))
  terminal.className = 'setup-command-btn'
  actions.appendChild(terminal)

  const updateLabels = () => {
    if (run) run.textContent = `Install ${setupTargetLabel(select.value)} now`
    const command = commands[select.value]
    // A release build with no runtime installed yet has nothing real to copy
    // (issue #74) — say so plainly instead of handing over an empty command
    // that LOOKS like it worked.
    commandPreview.textContent = command || '(not available yet — no command to copy)'
    agent.disabled = !command
    terminal.disabled = !command
    if (agent.textContent.startsWith('Copied')) agent.textContent = 'Copy prompt for agent'
    if (terminal.textContent.startsWith('Copied')) terminal.textContent = 'Copy terminal command'
  }
  select.addEventListener('change', updateLabels)
  updateLabels()
  wrap.prepend(title, hint, select)
  wrap.append(commandPreview, actions, result)
  host.appendChild(wrap)
}

function renderThemeSettings(host) {
  const section = document.createElement('section')
  section.className = 'setup-block theme-picker'
  const title = document.createElement('h3')
  title.textContent = 'Appearance'
  const hint = document.createElement('p')
  hint.className = 'setup-hint'
  hint.textContent = 'Choose a theme for this browser or app profile.'
  const choices = document.createElement('fieldset')
  choices.setAttribute('aria-label', 'Appearance')

  for (const option of [
    { value: 'light', label: 'Light', detail: 'Always use the light editorial palette.' },
    { value: 'dark', label: 'Dark', detail: 'Always use the low-light editorial palette.' },
    { value: 'system', label: 'System', detail: 'Follow this device and update automatically.' },
  ]) {
    const choice = document.createElement('label')
    choice.className = 'theme-choice'
    const input = document.createElement('input')
    input.type = 'radio'
    input.name = 'theme-preference'
    input.value = option.value
    input.checked = themeController.preference === option.value
    input.addEventListener('change', () => {
      if (!input.checked) return
      try {
        themeController.setPreference(option.value)
      } catch (err) {
        syncThemeChoices(themeController.preference)
        console.error('Theme preference could not be saved', err)
        document.getElementById('status').textContent = 'theme preference not saved'
      }
    })
    const copy = document.createElement('span')
    copy.className = 'theme-choice-copy'
    const label = document.createElement('strong')
    label.textContent = option.label
    const detail = document.createElement('small')
    detail.textContent = option.detail
    copy.append(label, detail)
    choice.append(input, copy)
    choices.appendChild(choice)
  }

  section.append(title, hint, choices)
  host.appendChild(section)
}

let updateSettings = null
let updateSubscriptionStarted = false

function updateStateCopy(state) {
  switch (state.status) {
    case 'checking': return 'Checking GitHub for a signed release…'
    case 'current': return 'Agent Inbox is up to date.'
    case 'available': return `Agent Inbox ${state.available?.version ?? ''} is available.`
    case 'unverified': return 'Couldn’t check right now. You can review Releases manually.'
    case 'unsupported': return 'Updates are not available for this app build.'
    default: return 'Ready to check GitHub for a signed release.'
  }
}

function paintUpdateSettings(state) {
  if (!updateSettings) return
  const {
    appVersion,
    automatic,
    check,
    checked,
    releases,
    review,
    status,
  } = updateSettings
  appVersion.textContent = `Agent Inbox app ${state.currentVersion || 'version unavailable'}`
  status.textContent = updateStateCopy(state)
  status.dataset.state = state.status
  check.disabled = state.status === 'checking'
  check.textContent = state.status === 'checking' ? 'Checking…' : 'Check now'
  automatic.checked = Boolean(state.automaticChecks)
  checked.textContent = state.checkedAt
    ? `Last checked ${new Date(state.checkedAt).toLocaleString()}`
    : 'Not checked yet'
  review.hidden = state.status !== 'available'
  releases.hidden = state.status !== 'unverified'
}

function renderUpdateSettings(host) {
  const bridge = window.agentInboxUpdates
  if (!bridge || bridge.available !== true) return

  const section = document.createElement('section')
  section.id = 'updates-settings'
  section.className = 'setup-block updates-settings'
  section.tabIndex = -1

  const heading = document.createElement('div')
  heading.className = 'updates-heading'
  const title = document.createElement('h3')
  title.textContent = 'Updates'
  const appVersion = document.createElement('span')
  appVersion.className = 'updates-version'
  appVersion.textContent = 'Agent Inbox app'
  heading.append(title, appVersion)

  const status = document.createElement('p')
  status.className = 'updates-state'
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  status.textContent = 'Ready to check GitHub for a signed release.'

  const checked = document.createElement('p')
  checked.className = 'updates-checked'
  checked.textContent = 'Not checked yet'

  const actions = document.createElement('div')
  actions.className = 'updates-actions'
  const check = btn('Check now', () => bridge.check().catch(() => {}))
  check.className = 'updates-check'
  const review = btn('Review release', () => bridge.openRelease().catch(() => {}))
  review.className = 'updates-review'
  review.hidden = true
  const releases = btn('Open Releases', () => bridge.openRelease().catch(() => {}))
  releases.className = 'updates-releases'
  releases.hidden = true
  actions.append(check, review, releases)

  const preference = document.createElement('label')
  preference.className = 'updates-preference'
  const automatic = document.createElement('input')
  automatic.type = 'checkbox'
  automatic.className = 'updates-automatic'
  automatic.setAttribute('aria-describedby', 'updates-automatic-detail')
  const preferenceCopy = document.createElement('span')
  const preferenceLabel = document.createElement('strong')
  preferenceLabel.textContent = 'Check automatically'
  const preferenceDetail = document.createElement('small')
  preferenceDetail.id = 'updates-automatic-detail'
  preferenceDetail.textContent = 'Makes one plain GitHub request on schedule. No telemetry is sent.'
  preferenceCopy.append(preferenceLabel, preferenceDetail)
  preference.append(automatic, preferenceCopy)
  automatic.addEventListener('change', () => {
    const enabled = automatic.checked
    bridge.setAutomatic(enabled).catch(() => {
      automatic.checked = !enabled
      status.textContent = 'Automatic check preference could not be saved.'
      status.dataset.state = 'unverified'
    })
  })

  section.append(heading, status, checked, actions, preference)
  host.appendChild(section)
  updateSettings = { appVersion, automatic, check, checked, releases, review, status }

  if (!updateSubscriptionStarted) {
    updateSubscriptionStarted = true
    bridge.onState?.(paintUpdateSettings)
  }
  bridge.getState().then(paintUpdateSettings).catch(() => paintUpdateSettings({
    status: 'unverified',
    currentVersion: '',
    automaticChecks: false,
    checkedAt: null,
  }))
}

// Setup section: configure new agents or copy the exact setup command. Fetched
// once, not on the poll.
async function renderSetup() {
  const host = document.querySelector('#setup .setup-body')
  host.replaceChildren()
  renderThemeSettings(host)
  renderUpdateSettings(host)
  try {
    const s = await (await fetch('/api/setup')).json()
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
    // Which build is this (issue #40) — FIRST, because it is the question a
    // human opening this panel most often has, and before #40 it had no answer
    // anywhere in the product. `textContent` throughout: a commit and a path
    // read off disk are still text reaching the DOM, and never being innerHTML
    // is a stronger guarantee than remembering to esc() them.
    const build = buildSummary(s.build)
    if (build) {
      const line = document.createElement('p')
      line.className = 'setup-hint'
      line.textContent = build.text
      host.appendChild(line)
      if (build.command) {
        const cmd = document.createElement('pre')
        cmd.textContent = build.command
        host.appendChild(cmd)
      }
    }
    if (s.note) {
      const note = document.createElement('p')
      note.className = 'setup-hint'
      note.textContent = `⚠ ${s.note}`
      host.appendChild(note)
    }
    const canInstall = await window.agentInboxSetup?.available?.().catch(() => false) ?? false
    setupMenu(s, host, canInstall)
    // issue #74: a release build withholds these manual/direct commands
    // entirely (empty string) until a runtime matching this exact host's
    // verified payload is installed — render nothing rather than an empty
    // "fake" block with a header and no content.
    if (s.claudeCommand) {
      block('Advanced · Manual MCP registration — Claude Code', s.claudeCommand,
        'Use the installer above unless you intentionally manage configuration by hand.')
    }
    if (s.copilotConfig) {
      block('Advanced · Manual Copilot MCP config', s.copilotConfig)
    }
    block('Advanced · Manual shared instructions', s.snippet,
      'This snippet is the signal-quality lever: it tells agents when to raise questions/notes, attach options, poll for your replies, and keep boards. '
      + 'Claude Code can instead import docs/reporting-snippet.md with an @path line, which stays current by itself — the installer detects that and skips its inlined copy. Copilot CLI cannot import, so it always gets the text.')
    if (s.hooksSettings) {
      block('Advanced · Optional Claude backstop hooks', s.hooksSettings, s.hooksNote)
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
//   initTabs → initTriage → initRelay → initMission → initSearch →
//   initResponsive → initSidebarCollapse → initPaneResizers → initProjectDisclosure →
//   initKeys (Task 17) → initFocusHash (Task 17) → initStagedFlush →
//   initPressGuard (#38) → initScrollGuard → initAgentSelect →
//   initStructuredTextCopy → initGear → initLiveBar → renderSetup → load →
//   setInterval(load, 3000)
initTabs()
initTriage()
initRelay()
initMission()
initSearch()
initResponsive()
initSidebarCollapse()
initPaneResizers()
initProjectDisclosure()
initKeys()
initFocusHash()
initStagedFlush()
initPressGuard()
initScrollGuard()
initAgentSelect()
initStructuredTextCopy()
initGear()
initLiveBar()
renderSetup()
// The LAST two lines that may ever call the gated load() directly: the boot paint
// and the poll itself. Every other caller is a human action and goes through
// reloadAndPaint() — see the block above forceRender(), and issue #38.
load()
setInterval(load, 3000)
