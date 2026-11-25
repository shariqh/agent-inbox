import { paginate, paginateGroups } from '/search.js'
import { buildSearchResults } from '/search-index.js'
import { paletteResults } from '/palette.js'
import {
  closedFoldLabel, closedRailEntries, filterRailEntries, railEntries, railProjects,
  shouldShowRailFilter, splitClosed, suppressedTotal,
} from '/rail.js'
import {
  attentionCount, attentionEntries, awaitingAgentRows, classifyLiveness, countsByProject,
  humanActedOnRow, isAskingItem, isBlockedRowAttention, isOpenHandoff, laterEntries, laterReason, sortRail, staleEntries,
} from '/attention.js'
import { DEFAULT_TAB, TAB_IDS, tabCounts } from '/tabs.js'
import { projectColor } from '/colors.js'
import {
  PRESS_GRACE_MS, SCROLL_IDLE_MS, pressHeld, scrollActive, shouldDeferRender,
  suspendHint, pinOrder, reconcileOpenRow, pollMaySkipPaint, draftInUse, recentInput,
} from '/poll.js'
import { createStagedSend } from '/star.js'
import {
  agentCounts, handledUndoRefusal, laterBreakdown, needsYouEntries, relMs, repliedEntries, rowModel,
  rowPickup, rowStarOption, stagedLabel, staleFoldLabel, streamCounts, undoRefusal, urgencyChip,
  ASK_SORT_OPTIONS, askTimeModel, sortLaterEntries, sortNeedsYouByAsk,
} from '/rowview.js'
import { cardSections, optionOrder, actionPresentation } from '/card.js'
import { keyAction, rovingIndex, ariaAnswerLabel, livenessGlyph, deckEntryAt } from '/keys.js'
import { createKeyboardUI, revealControl } from '/keyboard-ui.js'
import { partitionNotes, unreadNoteCount, unreadNotes, seenWatermark, markSeenIds } from '/notes.js'
import { FIND_CHIPS, FIND_PAGE, buildFindRows, findAge, findRow } from '/find.js'
import { sessionBuild, sessionsSummary, activityFrameKey } from '/livebar.js'
import { agentsAction, hooksGuidance, hooksNextStep, hostLabel, hostLine, restartGuidance } from '/agents.js'
import { PROJECT_SCOPE_NOTE, RUNTIMES_LEAD, runtimeLines, runtimesAction, runtimesNote } from '/runtimes.js'
import { esc } from '/esc.js'
import { initStructuredTextCopy, writeClipboard } from '/structured-copy.js'
import {
  MESSAGE_MAX_TEXT, MESSAGE_SHARED, MESSAGE_UNCONFIRMED, composerLabel, deliveryState, messageStatus, refusalText,
  sessionMessages, snapshotHolds, undeliveredMessages, undeliveredReason,
} from '/messages.js'
import { captureSelection, restoreSelection } from '/selection.js'
import { installChatsView } from '/chats-view.js'
import { isChatsHash } from '/chats.js'
import { createCopyOnSelect } from '/copy-on-select.js'
import { renderStructuredText } from '/structured-text.js'
import { cardLinks } from '/link-strip.js'
import { fileLinksCopy, initLinkOpening, linkFileActions, refreshLinkPermission } from '/link-open.js'
import { refreshLinkSettings, renderLinkSettings, renderTerminalSettings } from '/link-settings.js'
import { createLaunchUi } from '/launch-ui.js'
import { installAgentsHome, moveKeepingFocus } from '/agents-home.js'
import { installPlansLane } from '/plans-lane.js'
import { installMeshAgentPage } from '/mesh-agent-page.js'
import { installMeshAgents } from '/mesh-section.js'
import { installMeshSetup } from '/mesh-setup.js'
import { SHELL_WARNING } from '/launches.js'
import { refreshLaunchSettings, renderLaunchSettings } from '/launch-settings.js'
// #617 PR 2d: Settings → Other devices, sharing this Inbox with the owner's other Macs
import { refreshRemoteSettings, renderRemoteSettings } from '/remote-settings.js'
// #617 PR 3c: another Mac's Inbox — the page shown from it, and this Mac's own screens for it
import { installHubMode } from '/hub-mode.js'
import { refreshConnectSettings, renderConnectSettings } from '/connect-settings.js'
import { installHubStrip } from '/hub-strip.js'
import {
  boardRowsView, boardRowLine, progressLabel, hiddenDoneCount, lingeringBoards, omittedOutcomes, planForm, planSections,
} from '/boards.js'
import { titleWithBadge, focusHashFor, parseFocusHash } from '/badge.js'
import { layoutMode, railLabel, NARROW_MAX, PROJECT_DISCLOSURE_MAX } from '/layout.js'
import {
  indexLinks, issueRelationsHtml, linkStripHtml, missionDepsHtml, missionOutsideHtml, planGroupHeadHtml, planWaitsChipHtml, PREVIEW_TTL_MS,
  previewRef, rowIssueChipsHtml, rowParentHeadHtml, rowWaitsChipHtml, rowWaitsHtml, sourceChipsHtml, sourceBlockHtml, textLinkHtml, textRepo,
} from '/source.js'
import { attachCommand, claudeSessionUrl, placeLine } from '/place.js'
import { OPEN_DESK, deskSession, installDeskOpen } from '/desk-open.js'
import { hubFileEntity, hubFileGroupHtml, hubFileLinkAttrs, installHubFiles } from '/hub-files.js'
import { buildIssueView, planGroups, rowParentRuns } from '/issues.js'
import { buildSummary } from '/buildstamp.js'
import { actionCategory, actionOwnerLabel, agentFollowupChip, changeKind, lifecycleReceipt, responseLabel } from '/action.js'
import { buildRelay, stamp } from '/relay.js'
import { buildMission } from '/mission.js'
import { buildDashboard } from '/dashboard.js'
import { buildRibbon, ribbonWait, sinceKeepsOn, sinceLastLooked, trustedInput } from '/ribbon.js'
import { isWorking, linkedPlan, planBarLabel, planSegments, planStepStates, sessionFocus } from '/lanes.js'
import { PANE_DEFAULTS, paneKeyValue, paneValueFromPointer, resolvePaneLayout } from '/panes.js'
import { createThemeController } from '/theme.js'
import { createMotionController } from '/motion.js'
import { isReservedProject } from '/reserved-projects.js'
import { activityHistoryUrl, createSnapshotReader } from '/snapshots.js'
import { knownOutcomes, mergeClosedHistory, olderHistory } from '/closed-history.js'
import { DRAFTS_KEY, draftEntry, draftExpired, draftKey, mergeDrafts, readDrafts } from '/drafts.js'

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
let keyboardUI = null

function nativeKeyOwner(event) {
  if (!(event.target instanceof Element)) return false
  const owner = event.target.closest('select, button, a[href], summary, [role="button"]')
  if (!owner) return false
  return owner.matches('select') || event.key !== 'Escape'
}

// per-section visible-card caps; `shown` grows as the user clicks "show more"
// UX pass, slice 3: Moving pages by 12; `boards` stays the grouped list's page (and its "(continued)" heads)
const PAGE = { needsYou: 10, boards: 5, moving: 12, archived: 5, find: FIND_PAGE }
let shown = { ...PAGE }
function resetPaging() { shown = { ...PAGE } }

let lastData = null
const readSnapshot = createSnapshotReader((url, init) => fetch(url, init))
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
// Motion (#302): the Settings choice and the hidden-page pause, published as
// root attributes before the first render. Layout only, like the default sort.
const motion = createMotionController({
  storage: localStorage,
  root: document.documentElement,
  media: window.matchMedia('(prefers-reduced-motion: reduce)'),
  doc: document,
})
let authoritativeClosed = []
let loadGeneration = 0
let appliedLoadGeneration = 0
let appliedClosedGeneration = 0
// Issue #184: /api/items carries open work plus the most recently touched closed
// items. Older closed history is read from /api/items/history only while some
// surface needs it (historyWanted); these record needs no rendered state shows.
let historyLookup = null // a deep link to an item the page omitted
let historyRequestedFor = -1 // the applied tick an early poll was requested for
let historyLoadScheduled = false // that early poll has not started yet
let historyPaintRequestedFor = -1 // the applied tick a human's history read-and-paint started for
// Issue #299: the poll carries archived plans in brief (/api/boards/archived/summary);
// the complete list is read from /api/boards/archived only while some surface
// needs it (archivedWanted), through the same early-poll requests as history.
let archivedLookup = null // a deep link to an archived plan the brief names
let searchAwaitingHistory = false // search waits on older history or archived plans
let preparedFrame = null
let editablePanesPainted = false
// issue #30 — the (repo, branch) → cached PR state index, rebuilt once per
// render. A Map from the start, never null: the deep-link and setup paths can
// reach a renderer before the first /api/links response lands, and linkFor(null)
// would throw into load()'s catch and blank the whole page.
let linkIndex = new Map()
// issue #103 PR3 — the sub-issue view, rebuilt beside linkIndex in every ambient
// frame. Empty until /api/issues answers, and whenever it cannot: plain chips.
let issueView = buildIssueView(null)
let previewExpiryTimer = null
const boundPreviewLinks = new WeakSet()
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
// Sort order is the one queue setting a launch restores (#221): it only orders
// the list and never hides work. Settings owns it; the queue's Sort menu changes
// the current view only.
const DEFAULT_SORT_KEY = 'agent-inbox-default-sort'

function savedAskSort() {
  const stored = localStorage.getItem(DEFAULT_SORT_KEY)
  return ASK_SORT_OPTIONS.some((option) => option.value === stored) ? stored : 'priority'
}

// The Later section (#247) is saved the same way and for the same reason: it
// only lays out the queue (pinned and snoozed asks in one section at its foot,
// or in separate snoozed and pinned folds) and never changes what counts. The
// dock badge is computed in Electron main, which cannot read this storage, so
// a preference that changed attention would make the two badges disagree. On
// by default; any value but 'false' reads as on.
const LATER_SECTION_KEY = 'agent-inbox-later-section'
const savedLaterSection = () => localStorage.getItem(LATER_SECTION_KEY) !== 'false'
let laterSection = savedLaterSection()

// Grouping plans by their GitHub parent (#103 slice 2 §7) is saved the same way
// and for the same reason: it reorders plans and never hides one. Off by
// default; the Plans header switch changes only the current view.
const GROUP_PLANS_KEY = 'agent-inbox-group-plans'
const savedGroupPlans = () => localStorage.getItem(GROUP_PLANS_KEY) === 'true'
let groupByParent = savedGroupPlans()

const NOTES_SEEN_KEY = 'agent-inbox-notes-seen'
const NOTES_SEEN_IDS_KEY = 'agent-inbox-notes-seen-ids'
const LAST_VISIT_KEY = 'agent-inbox-last-visit'
const lastVisitAt = localStorage.getItem(LAST_VISIT_KEY)
// #305: "Since you last looked" covers the previous visit up to this one.
const visitAt = Date.now()
localStorage.setItem(LAST_VISIT_KEY, new Date().toISOString())
let notesSeenAt = localStorage.getItem(NOTES_SEEN_KEY) || null
let notesSeenIds = new Set()
try { notesSeenIds = new Set(JSON.parse(localStorage.getItem(NOTES_SEEN_IDS_KEY)) || []) } catch { /* fresh start */ }
// Read-marking used to stamp `now()` unconditionally on every render while the
// Notes page was open (now Find's Notes chip) — marking read every note behind the "Show N more" pager
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
let refreshPending = false
let reloadRequested = false
let pendingWrites = 0

// #411: a message still sending, or a composer the human is in, holds a viewer
// restart's reload; neither pauses the list (they are not in suspendState). A
// draft in a closed composer does not: it is stored (#279) and comes back in its
// composer after the reload, so holding for it would protect nothing.
function hasUnsentResponses() {
  return Boolean(suspendHint({ drafts: typedDrafts() })) || hasDraftRecovery() || sendingMessages.size > 0 || composerInUse()
}

// Whether a textarea of this session's composers (drawer or focus panel) has focus.
function composerFocused(session) {
  const active = document.activeElement
  return [...composerEls.values()].some((el) => el.dataset.msgSession === session && el.querySelector('textarea') === active)
}

function composerInUse() {
  return Boolean(document.activeElement?.closest?.('.msg-composer'))
}

function shouldDeferBootReload() {
  const now = Date.now()
  return hasUnsentResponses() || pendingWrites > 0
    || stagedStars.size > 0 || stagedDismiss.size > 0 || launchUi?.held() === true
    || pressHeld(pressedAt, now) || scrollActive(lastInteractionScrollAt, now)
}

// An HTTP result is not settled until its caller has applied draft ownership or
// failure recovery. Keep undrafted option picks protected through that work too.
async function withPendingResponse(action) {
  pendingWrites += 1
  try {
    return await action()
  } finally {
    pendingWrites -= 1
    noteOutsideChange()
    showPauseHint()
  }
}

// ── poll suspension (spec §10) ──────────────────────────────────────────────
// The 3s rebuild holds for typed drafts and bounded active interactions. A
// merely expanded card keeps polling: open state survives settled rebuilds,
// order pinning appends new arrivals at the foot, and the press/scroll guards
// protect clicks and trackpad momentum.
let openRowId = null    // the single inline-expanded Needs-you row (§4)
// UX pass, slice 1: the item whose optional-context editor is showing because the
// human worked in its answer area (answerEl); forgotten when another ask opens.
let contextEditorFor = null
let openRowScrollTop = 0 // the inspector's viewport survives the 3s DOM rebuild
let openRowHeadScrollTop = 0
let openRowComposeScrollTop = 0
let pendingFocusId = null // explicit deep link protected through filter + pagination reconciliation
let pagedFocusId = null // non-Inbox focused card protected only for the current rebuild
let lastInteractionScrollAt = null // bounded inspector/page scroll activity; never a suspension
let interactionScrollTimer = null
let renderDirty = false // fresh data arrived while an editable rebuild was deferred
let paintedFrame = null // { inputs, at } of the last complete frame (#298)
let outsideChanges = 0  // human input and settled writes since boot (#298)
let pinnedIds = []      // sort order pinned for this render session
let pressedAt = null    // pointerdown → pointerup, hard-bounded by PRESS_GRACE_MS (#38)
let humanInputAt = null // the human's last pointerdown, click, key or input in this window (#563)
// True while the poll paints (renderIfIdle): a draft whose target moved is then
// set aside without navigating, and the navigation waits for a human frame (#563).
let pollPaint = false
let recoveryNavPending = false
let launchUi = null     // driven sessions (#412 step 3), made at boot; inert unless the app's switch is on

// Every typed draft anywhere in the app: what the viewer-restart hold protects.
function typedDrafts() {
  const drafts = {}
  for (const [id, value] of Object.entries(draftReplies)) drafts[`reply:${id}`] = value
  for (const [id, value] of Object.entries(draftReplyContexts)) drafts[`context:${id}`] = value
  for (const [id, value] of Object.entries(rowDrafts)) drafts[`row:${id}`] = value
  for (const [id, editor] of Object.entries(itemNoteEditors)) drafts[`note:${id}`] = editor.text
  // #412 step 3: a New session task while its dialog is open
  for (const [key, value] of launchUi?.drafts() ?? []) drafts[`launch:${key}`] = value
  return drafts
}

// Whether the drafts may hold the poll's rebuild now (#563, public/poll.js).
// A New session task counts as in use: it exists only while its dialog is open.
// A draft whose target moved does not: the poll's frame moves it to the unsent
// responses without navigating (reconcileDraftOwners).
function draftsInUse(nowMs) {
  return draftInUse({
    inputAt: humanInputAt,
    editorFocused: Boolean(activeFocusElement()?.closest?.('[data-draft-focus-key]')),
    dialogOpen: (launchUi?.drafts() ?? []).some(([, value]) => String(value ?? '').trim() !== ''),
  }, nowMs)
}

// What SUSPENDS the poll — deliberately not the same set as what DEFERS it.
// `pressedAt` is missing on purpose and must stay missing: showPauseHint() reads
// this, and a held button is not a pause (see initPressGuard). A draft nobody
// is using suspends nothing (#563): it is still unsent work (typedDrafts()).
function suspendState() {
  const drafts = typedDrafts()
  return {
    drafts: draftsInUse(Date.now()) ? drafts : {},
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
  if (card.classList.contains('nrow-card-head')) openRowHeadScrollTop = card.scrollTop
  else if (card.classList.contains('nrow-card-compose')) openRowComposeScrollTop = card.scrollTop
  else openRowScrollTop = card.scrollTop
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
  // Every draft change is followed by a hint refresh, so its save is queued here (#279).
  scheduleDraftSave()
  const el = document.getElementById('pauseHint')
  if (!el) return
  const hint = refreshPending && hasUnsentResponses()
    ? 'Viewer updated — finish or discard unsent responses to refresh.'
    : renderDirty ? suspendHint(suspendState()) : null
  el.setAttribute('role', 'status')
  if (el.textContent !== (hint ?? '')) el.textContent = hint ?? ''
  el.hidden = !hint
}

// the poll's ONLY entry into render(); also taken by a change nobody pressed for that lands
// outside the poll (a chats read on entering Find, UX pass slice 4 step B), so the same gate holds it
function renderIfIdle() {
  // #563: what this paints is the poll's (reconcileDraftOwners)
  pollPaint = true
  try {
    const now = Date.now()
    // A held press still protects EVERY surface. paintAmbient() may rebuild the panel's asks,
    // so running it between pointerdown and click would reintroduce issue #38.
    if (pressHeld(pressedAt, now)) {
      renderDirty = true
      showPauseHint() // reads suspendState() only — a bare press prints nothing (#38)
      return
    }
    // Ambient painters can rebuild under a selection too, so capture it first (#223).
    const textSelection = captureSelection()
    const frame = paintAmbient()
    frame.textSelection = textSelection
    // Drafts and active inspector/page scrolling protect only editable lists. Counts,
    // the badge, rail and Sessions line above keep reporting fresh data. Before the
    // first editable frame no editor exists to protect, so a draft restored at
    // boot (#279) cannot leave the lists blank.
    if (editablePanesPainted
      && shouldDeferRender({ ...suspendState(), pressedAt, scrolledAt: lastInteractionScrollAt }, now)) {
      renderDirty = true
      showPauseHint()
      restoreSelection(textSelection)
      return
    }
    renderDirty = false
    showPauseHint()
    preparedFrame = frame
    render()
  } finally {
    pollPaint = false
  }
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
    openRowHeadScrollTop = 0
    openRowComposeScrollTop = 0
    clearScrollActivity()
    contextEditorFor = null // each ask opens at rest (answerEl)
  }
  openRowId = id
  // only the frame that brought an ask to the front marks it so (bringAskToFront)
  frontAutoId = null
  if (id !== null) {
    // UX pass, slice 2: a row opened by any path is the ask in front again
    frontClosed = false
    // one thing in front on a wide window: the ask, never with a session panel
    if (layout === 'wide' && focusSession) closeSessionPanelQuietly()
  }
  syncAskFront()
  if (resume) resumeRender()
  else showPauseHint()
}

// ── the ask in front (UX pass, slice 2) ─────────────────────────────────────
// The person closed the open card on a wide window (its ✕ or Esc): no waiting
// ask comes to the front by itself until they open a row again, Home is
// entered from another tab, or a paint finds nothing waiting.
let frontClosed = false
// The row that came to the front by itself and has not been clicked since: the
// person's first click or Enter on it opens it as theirs, focus into its card.
let frontAutoId = null
// The model and entry each list row was drawn from, so a frame can draw the
// card of the ask it brings to the front (bringAskToFront).
const rowBuilds = new WeakMap()
// An ask is ready to come forward and only the lanes being in use holds it back:
// the poll paints again once they no longer are (frameInputs).
let frontWaitsOnLanes = false
const lanesHoldFocus = () => Boolean(activeFocusElement()?.closest?.('#dashboard'))
const lanesUnderPointer = () => Boolean(document.querySelector('#needsYou:hover, #dashboard:hover'))
const lanesInUse = () => lanesHoldFocus() || (pollPaint && editablePanesPainted && lanesUnderPointer())

// body.ask-front: exactly while the window is wide, Home is showing and a row is
// open and drawn in the list (not in a closed fold). The CSS keeps the list and
// the lanes clear of the fixed card only then.
function syncAskFront() {
  const row = openRowId ? needsYouRowEl(openRowId) : null
  const on = layout === 'wide' && activeTab === 'dashboard' && !settingsOpen()
    && Boolean(row) && !row.closest('[hidden], details:not([open])')
  document.body.classList.toggle('ask-front', on)
}

// From render(), after the list is painted and reconciled, so never while a
// frame is held and never from the ambient painter: on a wide window with Home
// showing and nothing in front (no open row, no session panel, no modal), the
// first row drawn outside a closed fold that still waits on the person opens,
// its card drawn in this frame. It moves no focus, scrolls nothing and writes
// nothing, except that a keyboard user already in the list lands on that row.
// While the page is in use it waits (lanesInUse: focus rests in the lanes, or the
// pointer is over the list or the lanes on a later poll's frame): an ask coming
// forward narrows them under whatever the person is using there. Two exceptions:
// `fromPanel`, the person just closed the session panel, focus is back on that
// session's card, and the ask they had in front returns now (closeSessionFocus);
// and `steady`, the ask in front left the list in this frame, so the next one
// takes its place without moving anything beside it.
function bringAskToFront({ fromPanel = false, steady = false } = {}) {
  frontWaitsOnLanes = false
  if (layout !== 'wide' || activeTab !== 'dashboard' || settingsOpen()) return
  const waiting = new Set(attentionEntries(allItems(lastData.g), lastData.boards, Date.now(), liveSessionIds(), lastData.closed ?? [])
    .map(needsEntryId))
  // the person's close holds until nothing waits anywhere: a lens or a filter that shows no
  // waiting ask must not bring back, on the way out of it, the ask they closed
  if (!waiting.size) frontClosed = false
  const first = rowEls().find((el) => waiting.has(el.dataset.cardId))
  if (!first) return
  if (openRowId !== null || focusSession || frontClosed) return
  // a native dialog (New session…) carries no aria-modal, so keyboardScope() does not see it
  if (triageDeck || relayOpen || missionBoardId || missionDetailRowId || keyboardScope() !== document
    || document.querySelector('dialog[open]')) return
  // The page is in use: focus rests in the lanes, or, on a poll's frame after the first, the
  // pointer is over the list or the lanes (an ask coming forward narrows both under the pointer
  // before a press). `steady`: an ask was in front when this frame began and left the list, so
  // the next one takes its place and nothing beside it moves.
  if (!fromPanel && !steady && lanesInUse()) {
    frontWaitsOnLanes = true
    return
  }
  const build = rowBuilds.get(first)
  if (!build) return
  const id = first.dataset.cardId
  const listFocus = Boolean(activeFocusElement()?.closest?.('#needsYouList .nrow[data-card-id]'))
  selectedId = id
  setOpenRow(id, { resume: false })
  frontAutoId = id
  first.dataset.open = '1'
  first.setAttribute('aria-expanded', 'true')
  first.appendChild(rowCardBodyEl(build.entry, build.m, build.nowMs))
  markSelectedRow(id)
  if (listFocus && document.activeElement !== first) first.focus({ preventScroll: true })
  syncAskFront()
}

// Opening a session panel on a wide window closes the ask in front; its drafts
// stay, as on any close.
function closeFrontAsk() {
  if (layout !== 'wide' || openRowId === null) return
  const row = needsYouRowEl(openRowId)
  setOpenRow(null, { resume: false })
  row?.removeAttribute('data-open')
  row?.setAttribute('aria-expanded', 'false')
  row?.querySelector('.nrow-card')?.remove()
}

// Existing rows keep their relative order for the session; genuinely new work
// appends at the foot. The press guard, not hover state, protects active clicks.
function orderedIds(ids) {
  pinnedIds = pinOrder(pinnedIds, ids)
  return pinnedIds
}

// Promise.allSettled keeps every concurrent read's rejection observed; the tick
// then reports failures in the order the reads used to run one after another.
function settledValue(result) {
  if (result.status === 'rejected') throw result.reason
  return result.value
}

// History keeps its own fallback: any failure renders "History unavailable"
// without failing the tick. Like the other snapshot bodies it is read only after
// the tick's boot decision, because a 304 resolves to cached spans (#185).
async function historyBody(read) {
  try {
    const response = settledValue(read)
    if (response.status !== 200 && response.status !== 304) {
      return { state: 'error', spans: [], message: `History unavailable (${response.status})` }
    }
    return { state: 'ready', spans: await response.json(), message: '' }
  } catch (error) {
    return {
      state: 'error',
      spans: [],
      message: error instanceof Error ? `History unavailable: ${error.message}` : 'History unavailable',
    }
  }
}

// Older closed history (#184) degrades like activity history: a failed read
// leaves this tick's page applied, and the surfaces waiting on it say so.
async function closedHistoryBody(read) {
  try {
    return { done: (await settledValue(read).json()).done, error: null }
  } catch {
    return { done: null, error: OLDER_HISTORY_UNAVAILABLE }
  }
}

// Archived plans in brief (#299), a read the tick needs like /api/boards. A
// viewer older than the route answers 404: null, and the tick reads the
// complete list in its place, as such a viewer's page always did.
async function archivedSummaryBody(read) {
  const response = settledValue(read)
  if (response.status === 404) return null
  return (await response.json()).plans
}

// The complete archived plans (#299) degrade like older history: a failed read
// leaves this tick's brief applied, and the surfaces waiting on it say so.
async function archivedBody(read) {
  try {
    return { plans: await settledValue(read).json(), error: null }
  } catch {
    return { plans: null, error: ARCHIVED_UNAVAILABLE }
  }
}

// The lingering plans (#373) degrade like the complete list. A viewer older
// than the route answers 404: `missing`, and the tick reads the complete list
// in their place, as such a viewer's page always did.
async function lingeringBody(read) {
  try {
    const response = settledValue(read)
    if (response.status === 404) return { plans: null, error: null, missing: true }
    return { plans: await response.json(), error: null }
  } catch {
    return { plans: null, error: ARCHIVED_UNAVAILABLE }
  }
}

// The sub-issue graph (#103) falls back like links: a 404 from an older viewer,
// a network error or a body its validator refuses means "no graph", and every
// surface renders its plain chips. Read after the boot decision, like every
// snapshot body, because a 304 resolves to the cached graph.
async function issuesBody(read) {
  try {
    return await settledValue(read).json()
  } catch {
    return null
  }
}

// Cached PR state (issue #30) is a conditional snapshot since #288, with the
// same defensive fallback it always had: a 404 from a viewer that predates the
// route, a network error or a body its validator refuses means no links, and
// every surface renders exactly as before the feature, never a dead page.
async function linksBody(read) {
  try {
    return await settledValue(read).json()
  } catch {
    return []
  }
}

// The human's messages to MCP sessions (#411) fall back like links: a 404 from
// a viewer older than the route, a network error or a body its validator
// refuses means no messages, never a failed tick.
async function messagesBody(read) {
  try {
    return await settledValue(read).json()
  } catch {
    return null
  }
}

// The Agent cards tab (Agent cards step 1; agent cards view design §4.5, amended):
// `/api/mesh/agents` is read only while the last /api/version carried `mesh`, the Agent cards
// is the current tab and the window is visible. A failed read keeps the last body, marked stale,
// and is never a failed tick; an `on: false` body hides the tab once the person leaves it and
// stops the read until /api/version carries `mesh` again.
let meshOff = false
const meshWanted = () => Boolean(liveVersion?.mesh) && !meshOff
// the tab shows while the mesh is on, or while this Mac's app can set an agent up (step 2b, D1), and
// stays while it is the current tab, so a passive read that turns the mesh off never takes the page
// from under the person
const meshShown = () => meshWanted() || meshSetup.usable()
const agentCardsShown = () => meshShown() || activeTab === 'cards'
const meshReadable = () => meshShown() && activeTab === 'cards' && document.visibilityState !== 'hidden'
async function meshBody(read) {
  try {
    return await settledValue(read).json()
  } catch {
    return undefined
  }
}
function meshNext(previous, fresh) {
  if (fresh === undefined) return previous.body && !previous.stale ? { ...previous, stale: true } : previous
  if (fresh.on === false) meshOff = true
  return fresh === previous.body && !previous.stale ? previous : { body: fresh, stale: false }
}
// Run history (cards view V5 §5.7): the open agent's runs, read only while the Agent cards tab
// is active with that agent's page open, its Run history shows, the document is visible and the
// last body still names the agent. The same fallback: a failed read keeps the last body marked
// stale, a skipped read keeps it as it was, and a body read for another agent is never shown
// under this one.
function meshRunsUrl() {
  const agent = meshAgentPage.current()
  if (!agent || !meshAgentPage.runsShowing() || !meshReadable()) return null
  const body = lastData?.mesh?.body
  if (body?.on !== true || !body.agents?.some((a) => String(a.key) === agent.key)) return null
  return `/api/mesh/agents/runs?name=${encodeURIComponent(agent.name)}`
}
function meshRunsNext(previous, fresh, key) {
  const last = previous?.key === key ? previous : { key, body: null, stale: false }
  if (fresh === undefined) return last.stale ? last : { ...last, stale: true }
  return fresh === last.body && !last.stale ? last : { key, body: fresh, stale: false }
}
const postMesh = (trigger, name) => fetch('/api/mesh/agents/refresh', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(name === undefined ? { trigger } : { trigger, name }),
})
// The open trigger (Agent cards step 1, D5): only entering the Agent cards tab from another tab
// calls it; never boot, Home, a poll or a card's press. Its checks' result paints through the
// next poll tick.
function meshOpen() {
  if (meshWanted()) postMesh('open').catch(() => {})
}
// Refresh, the human's press (the section's, or the agent page's for its agent): the result
// paints through the human path.
async function meshRefresh(name) {
  if (!meshShown()) return
  if (meshWanted()) await postMesh('refresh', name).catch(() => {})
  await reloadAndPaint()
}

// "Yours" (Agent cards step 1, D2) and an agent's page in the same tab (D3): one
// slot, replaced by the next agent opened, never counted and never persisted. Which agent is
// open is the page module's state, by key; a passive repaint never opens or closes it.
const meshAgents = installMeshAgents({
  // the section's Refresh asks the servers again too (step 2b, D2)
  onRefresh: () => {
    meshRefresh()
    meshSetup.entered()
  },
  onOpen: (key, name) => openMeshAgent(key, name, { focus: true }),
})
const meshAgentPage = installMeshAgentPage({
  page: () => document.getElementById('agentPage'),
  wireTablist,
  onRefresh: (name) => { meshRefresh(name) },
  onBack: () => closeMeshAgent(),
})
// Agent setup in the app, step 2b: the Marketplace and Model servers sections, the set-up pages in
// the tab and the foot of an agent's page, through the local window's mesh bridge only.
const meshSetup = installMeshSetup({
  bridge: () => window.agentInboxMesh ?? null,
  local: async () => {
    await hubMode.ready()
    return hubMode.local()
  },
  home: () => document.getElementById('agentCardsHome'),
  setupPage: () => document.getElementById('agentSetup'),
  agentPage: () => document.getElementById('agentPage'),
  panel: () => document.getElementById('cards'),
  heading: () => {
    const heading = document.getElementById('pageTitle')
    if (heading) heading.tabIndex = -1
    return heading
  },
  active: () => activeTab === 'cards',
  changed: () => paintAgentCards(),
  reload: () => {
    refreshLiveVersion()
    reloadAndPaint()
  },
  turnedOn: (name) => openMeshAgent(`mesh.json:${name}`, name, { focus: true, pending: true }),
  // an agent added by its card address: its page, saying it was added until the next read names it
  added: (id) => openMeshAgent(`mesh.json:${id}`, id, { focus: true, pending: 'added' }),
  // an agent just turned on is checked once, as the agent page's Refresh checks it
  check: (name) => { meshRefresh(name) },
  toTop: scrollPageToTop,
  turnedOff: () => {
    meshAgentPage.close()
    paintAgentCards()
    const heading = document.getElementById('pageTitle')
    if (heading) {
      heading.tabIndex = -1
      heading.focus({ preventScroll: true })
    }
  },
})

// The chats (#586), Find's Chats chip since UX pass, slice 4, step B: their own read on entering
// Find, Refresh and Show all, never the poll's. Find's frame draws them (renderFind).
const chatsView = installChatsView({
  doc: document,
  fetch: (url) => fetch(url),
  now: () => Date.now(),
  // #586 PR 3: Resume in Terminal, only where the desktop app's preload exposes it
  resume: () => window.agentInboxChats ?? null,
  // #586 phase 2: Continue here… and Show session, only in the window main grants launches, with
  // the driven-sessions switch on; with it off this asks nothing that reads, and draws nothing
  drive: () => (launchUi ? {
    available: async () => {
      await launchUi.refresh()
      return launchUi.granted()
    },
    granted: () => launchUi.granted(),
    launchesFailed: () => lastData?.launchesFailed === true,
    launches: () => (launchesOn() ? lastData?.launches ?? null : null),
    continueChat: (chat, hooks) => launchUi.openContinueChat(chat, hooks),
    showSession: (id) => openSessionFocus(`launch:${id}`),
  } : null),
  // Jump to session (#586): a live chat's own session card, in any window. A session that started
  // since the last poll is read once before the answer is no.
  jump: async (session) => jumpToSession(session) || (await reloadAndPaint(), jumpToSession(session)),
  rowEl: (key) => document.querySelector(`#findList > [data-find-key="${CSS.escape(`chat:${key}`)}"]`),
  changed: (change) => chatsChanged(change),
  // a note for an action pressed on a collapsed row opens it, after the person's own press
  // The row is open the next time it is listed; it is kept in place only when it is drawn now, so
  // an answer that lands after the person moved to another chip or filter never brings it in.
  reveal: (key) => {
    const rowKey = `chat:${key}`
    findOpen.add(rowKey)
    if (findRowsByKey.has(rowKey)) findKept.add(rowKey)
  },
})
// A page that opens in the Agent cards tab shows from its top, as a go-to destination does
// (focusKeyboardPanel): the page scrolls as a whole in the wide and the narrow layout alike, and
// the top bar sticks over what a kept scroll position would leave of it.
function scrollPageToTop() {
  if (window.scrollY !== 0) window.scrollTo(0, 0)
}
// The Agent cards tab's two views: the grid, or one agent's page in its place (D3).
function paintAgentCards() {
  const tab = document.querySelector('#tabs .tab[data-tab="cards"]')
  if (tab) setHidden(tab, !agentCardsShown())
  const home = document.getElementById('agentCardsHome')
  const page = document.getElementById('agentPage')
  if (!home || !page) return
  const setup = document.getElementById('agentSetup')
  // a set-up page (step 2b) covers both the grid and an agent's page, which it may go back to
  const setupOpen = Boolean(setup) && meshSetup.open()
  const open = !setupOpen && Boolean(meshAgentPage.current())
  setHidden(home, open || setupOpen)
  setHidden(page, !open)
  if (setup) setHidden(setup, !setupOpen)
  // with no agent on, an app that can set one up shows the home with "No agent is on yet." (D1, D2)
  const body = lastData?.mesh?.body
  const input = meshWanted() && body?.on === true ? lastData.mesh : meshSetup.usable() ? (body ? lastData.mesh : { body: { on: false, agents: [] }, stale: false }) : null
  meshAgents.paint(home, input, Date.now(), meshAgentPage.current()?.key ?? null)
  setHidden(document.getElementById('agentCardsOff'), meshShown())
  // the page, from the same body, whether or not mesh is still on (it then says the agent left)
  meshAgentPage.paint(lastData?.mesh ?? null, Date.now(), lastData?.runs ?? null)
  const current = meshAgentPage.current()
  const agent = current && body?.on === true && Array.isArray(body.agents) ? body.agents.find((a) => String(a.key) === current.key) : null
  // an added agent's foot offers Remove, a built-in's Change server and Turn off
  meshSetup.paint({ body: input?.body ?? null, agent: agent ? (agent.kind === 'added' ? { name: String(agent.name), added: true } : { name: String(agent.name) }) : null })
  if (activeTab === 'cards' && !document.getElementById('cards').hidden) paintPageHeading('cards')
}
// A card's press, a deep link: the agent's page in the Agent cards tab, painted at once from the
// last bodies; one reloadAndPaint() brings what the page reads without waiting for a tick. It
// posts no check (D5): entering the tab did. A press moves focus to the way back, so focus never
// stays on a card the page now covers.
function openMeshAgent(key, name, { focus = false, pending = false } = {}) {
  if (!agentCardsShown()) return
  meshAgentPage.open(key, name, { pending })
  if (activeTab !== 'cards') selectTab('cards')
  paintAgentCards()
  scrollPageToTop()
  if (focus) document.querySelector('#agentPage .map-back')?.focus({ preventScroll: true })
  reloadAndPaint()
}
// "← Agent cards" and Escape: back to the grid; focus, if it was in the page, goes to the
// agent's card, else the tab's heading, only in a focused window.
function closeMeshAgent() {
  const key = meshAgentPage.current()?.key
  if (!key) return
  const hadFocus = document.hasFocus() && Boolean(activeFocusElement()?.closest?.('#agentPage'))
  meshAgentPage.close()
  paintAgentCards()
  if (!hadFocus) return
  // the card, or (an agent that left mesh.json, a mesh turned off) the tab's heading, which
  // takes focus only when it may: an h1 holds none without a tabindex
  const heading = document.getElementById('pageTitle')
  if (heading) heading.tabIndex = -1
  ;(meshAgents.cardFor(key) ?? heading)?.focus({ preventScroll: true })
}
// #cards opens the tab, #cards/<key> an agent's page in it (the viewer never writes either).
// A link that lands before /api/version has said whether the mesh is on waits for that read.
// It never outlives the first version read, whether that worked or failed, and choosing a tab
// (selectTab) drops it: a link still waiting must not pull the person off the tab they chose.
let agentCardsLink = null
let versionSettled = false
function applyAgentCardsLink() {
  if (!agentCardsLink) return
  if (!liveVersion) {
    if (versionSettled) agentCardsLink = null
    return
  }
  const link = agentCardsLink
  agentCardsLink = null
  if (!meshShown()) return
  if (link.key) {
    const key = agentCardsKeyFor(link.key)
    openMeshAgent(key, key.slice(key.indexOf(':') + 1))
  } else selectTab('cards')
}
// A typed link may name the agent without the source prefix (`#cards/unslop`): the one
// configured agent of that name, by the last body read; with no body yet, mesh.json's.
function agentCardsKeyFor(text) {
  if (text.includes(':')) return text
  const agents = lastData?.mesh?.body?.on === true ? lastData.mesh.body.agents : null
  const named = Array.isArray(agents) ? agents.filter((a) => String(a.name) === text) : []
  return named.length === 1 ? String(named[0].key) : named.length > 1 ? text : `mesh.json:${text}`
}

// #412 step 3 (§9 b): the launches are read only in the viewer the app owns,
// with "Start sessions from Agent Inbox" on.
function launchesOn() {
  return launchUi?.on() === true
}

// #586 phase 2: a failed launches read is a frame input, so the Chats line can say it could not
// read them; a tick that read none (the switch off) is never one, so an idle tick stays idle
function launchesReadFailed(read, launches) {
  return read && !Array.isArray(launches)
}

async function load() {
  if (reloadRequested) return false
  const generation = ++loadGeneration
  // Issue #161: the reads are independent, so the tick starts them together and
  // lasts as long as the slowest one. Each still degrades exactly as it did when
  // they ran in sequence. Every response names its server instance (#165).
  const boots = []
  const marked = (response) => {
    boots.push(response.headers.get('x-inbox-boot'))
    return response
  }
  // Decided from the previous frame, before any read starts: a passive poll reads
  // closed history the page omitted (#184), or the complete archived plans the
  // brief stands in for (#299), only while a surface still needs them.
  const wantHistory = historyWanted()
  const wantArchived = archivedWanted()
  // ...and a plan lingering in Plans whole, on its own, while the complete
  // list is not wanted (#373).
  const lingerUrl = wantArchived ? null : lingeringUrl()
  const historyUrl = activityHistoryUrl(Date.now())
  const wantMesh = meshReadable()
  // #586 phase 2: decided once per tick, so a switch answered mid-tick is never taken for a failed read
  const wantLaunches = launchesOn()
  const runsUrl = meshRunsUrl()
  const runsKey = meshAgentPage.current()?.key ?? null
  try {
    const [
      items, boardsRead, summaryRead, activityRead, historyRead, closedRead, linksRead, issuesRead, closedHistoryRead,
      archivedRead, lingerSettled, messagesRead, launchesRead, meshRead, runsRead,
    ] = await Promise.allSettled([
      readSnapshot('/api/items').then(marked),
      readSnapshot('/api/boards').then(marked),
      // Archived plans in brief (#299): what every surface but the archived
      // ones reads. The complete list is the last read, while one needs it.
      readSnapshot('/api/boards/archived/summary').then(marked),
      fetch('/api/activity').then(marked),
      readSnapshot(historyUrl).then(marked),
      // Projects the human closed (issue #32). Defensive on purpose: a viewer that
      // predates this route answers 404 with HTML, a bare .json() would throw into
      // the catch below, and the WHOLE page would read 'disconnected'. An unknown
      // closed set must mean "suppress nothing", never a dead page.
      fetch('/api/projects/closed').then(marked)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      // Cached PR state (issue #30): a conditional snapshot (#288) whose body is
      // read after the boot decision, with its own fallback (linksBody).
      readSnapshot('/api/links').then(marked),
      // The sub-issue graph (#103), the eighth read: a conditional snapshot with
      // its own validator and the same fallback (issuesBody).
      readSnapshot('/api/issues').then(marked),
      wantHistory ? readSnapshot('/api/items/history').then(marked) : null,
      wantArchived ? readSnapshot('/api/boards/archived').then(marked) : null,
      lingerUrl ? readSnapshot(lingerUrl).then(marked) : null,
      // The human's messages to sessions (#411): a conditional snapshot with its
      // own validator and the links fallback (messagesBody).
      readSnapshot('/api/messages').then(marked),
      // Driven sessions (#412 step 3): read only in the viewer the app owns, with
      // its switch on (§9 b). Off, the tick makes exactly the reads it always made.
      wantLaunches ? readSnapshot('/api/launches').then(marked) : null,
      // The Agent cards tab's cards: only while it can show (meshReadable), with
      // the messages fallback. Off, the tick makes exactly the reads it made.
      wantMesh ? readSnapshot('/api/mesh/agents').then(marked) : null,
      // Run history: only while it shows (meshRunsUrl), with the same fallback.
      runsUrl ? readSnapshot(runsUrl).then(marked) : null,
    ])
    if (reloadRequested || generation < appliedLoadGeneration) return false
    const res = settledValue(items)
    // A restart between two reads of one tick would mix two instances' data, so
    // any disagreement is a restart, and that tick is never applied.
    const marks = new Set(boots.filter(Boolean))
    bootId ??= marks.size === 1 ? [...marks][0] : null
    if ([...marks].some((mark) => mark !== bootId)) refreshPending = true
    if (refreshPending && !shouldDeferBootReload()) {
      reloadRequested = true
      location.reload()
      return false
    }
    if (marks.size > 1) return false
    // Bodies only after the live boot decision: a 304 resolves to cached data.
    const body = (read) => (read.status === 'fulfilled' ? read.value.json() : Promise.reject(read.reason))
    const bodies = await Promise.allSettled([
      res.json(), body(boardsRead), archivedSummaryBody(summaryRead), body(activityRead), historyBody(historyRead),
      wantHistory ? closedHistoryBody(closedHistoryRead) : null, issuesBody(issuesRead), linksBody(linksRead),
      wantArchived ? archivedBody(archivedRead) : null, lingerUrl ? lingeringBody(lingerSettled) : null,
      messagesBody(messagesRead),
      wantLaunches ? messagesBody(launchesRead) : null,
      wantMesh ? meshBody(meshRead) : null,
      runsUrl ? meshBody(runsRead) : null,
    ])
    const [g, boards, brief, activity, activityHistory, firstOlder, issues, links, firstArchived, firstLinger, messages, launches, meshFresh, runsFresh] =
      bodies.map(settledValue)
    const closedSnapshot = settledValue(closedRead)
    if (reloadRequested || generation < appliedLoadGeneration) return false
    const nowMs = Date.now()
    const page = ageNotes(g, nowMs)
    let older = firstOlder
    let complete = firstArchived
    let linger = firstLinger
    let lingerReadUrl = lingerUrl
    // Issues #184 and #299: this tick's own data may need what the previous
    // frame did not: older history (a sweep moving the page's boundary past what
    // History shows, say) or the complete archived plans (a plan the human
    // watched, archived as it finished, lingers: its own read since #373). A
    // viewer older than #299 serves no brief, and one older than #373 no
    // lingering plans, so its complete list stands in. Read them inside the
    // same tick, under the same rules, rather than painting a frame without them.
    const view = { page, pageHistory: g.history ?? null, boards, archivedBrief: brief ?? [], activity }
    const lateHistory = !wantHistory && Boolean(lastData) && historyWanted(view)
    const lateArchived = !wantArchived && (brief === null || (Boolean(lastData) && archivedWanted(view)))
    const lateLingerUrl = wantArchived || lateArchived ? null : lingeringUrl(view)
    const lateLinger = lateLingerUrl !== null && lateLingerUrl !== lingerUrl
    // As on the main path: only markers that disagree within this tick are a
    // restart between its reads. A restart already being held for unsent work
    // keeps applying ticks, whose markers all name the new server.
    const readLate = async (reads) => {
      const settled = await Promise.allSettled(reads)
      if (reloadRequested || generation < appliedLoadGeneration) return null
      if (new Set(boots.filter(Boolean)).size > 1) {
        refreshPending = true
        return null
      }
      return settled
    }
    if (lateHistory || lateArchived || lateLinger) {
      const late = await readLate([
        lateHistory ? readSnapshot('/api/items/history').then(marked) : null,
        lateArchived ? readSnapshot('/api/boards/archived').then(marked) : null,
        lateLinger ? readSnapshot(lateLingerUrl).then(marked) : null,
      ])
      if (!late) return false
      const [historyLate, archivedLate, lingerLate] = late
      if (lateHistory) older = await closedHistoryBody(historyLate)
      if (lateArchived) complete = await archivedBody(archivedLate)
      if (lateLinger) {
        linger = await lingeringBody(lingerLate)
        lingerReadUrl = lateLingerUrl
      }
      if (reloadRequested || generation < appliedLoadGeneration) return false
    }
    if (linger?.missing && !complete) {
      const late = await readLate([readSnapshot('/api/boards/archived').then(marked)])
      if (!late) return false
      complete = await archivedBody(late[0])
      if (reloadRequested || generation < appliedLoadGeneration) return false
    }
    // Standing in for a brief, the complete list is a read the tick needs.
    if (brief === null && !complete?.plans) throw new Error(complete?.error ?? ARCHIVED_UNAVAILABLE)
    const archivedBrief = brief ?? complete.plans
    // a skipped read keeps the last body, so returning to the Dashboard paints it at once
    const mesh = wantMesh ? meshNext(lastData?.mesh ?? { body: null, stale: false }, meshFresh) : lastData?.mesh ?? { body: null, stale: false }
    const runs = runsUrl ? meshRunsNext(lastData?.runs ?? null, runsFresh, runsKey) : lastData?.runs ?? null
    appliedLoadGeneration = generation
    if (closedSnapshot !== null) {
      appliedClosedGeneration = generation
      authoritativeClosed = [...closedSnapshot]
      retireConfirmedProjectMutationIntents(generation)
    }
    lastData = {
      // Every surface reads `g`: the page, or the page merged with the complete
      // History list while one is loaded. `page` and `pageHistory` stay the page
      // alone, which is what decides whether older history is needed at all.
      g: older?.done ? ageNotes(mergeClosedHistory(g, older.done), nowMs) : page,
      page,
      pageHistory: g.history ?? null,
      // the summary of what `g` still omits; null once nothing is omitted
      older: older?.done ? null : g.history ?? null,
      // why a surface that needed older history this tick is still waiting
      olderError: older?.error ?? null,
      boards,
      // Issue #299: archived plans in brief, which alone decide whether the
      // complete list is needed; `archived` is what surfaces read: the complete
      // list while one is loaded, the brief until then. `archivedFull` is null
      // while the complete list is not loaded, and `archivedError` says why a
      // surface that needed it this tick is still waiting.
      archivedBrief,
      archived: complete?.plans ?? archivedBrief,
      archivedFull: complete?.plans ?? null,
      archivedError: complete?.error ?? null,
      // Issue #373: the plans lingering in Plans, whole, from their own read
      // (`lingerUrl`, the read this tick made, or null), and why it failed.
      // Surfaces draw them only where the complete list is not loaded.
      lingering: linger?.plans ?? null,
      lingerUrl: lingerReadUrl,
      lingerError: linger?.error ?? null,
      activity,
      activityHistory,
      closed: [...authoritativeClosed],
      links,
      issues,
      // #411: null when the read failed or the viewer predates the route
      messages,
      // #412 step 3: null with the switch off, or when the read failed
      launches: Array.isArray(launches) ? launches : null,
      // #586 phase 2: whether this tick read the launches and could not (never with the switch off)
      launchesFailed: launchesReadFailed(wantLaunches, launches),
      // the Agent cards tab's last body and whether the last read of it failed
      mesh,
      // Run history's last body, the agent it was read for, and whether the last read failed
      runs,
      // What this tick read, compared by identity (#298): a snapshot that
      // answered 304 resolves to the very representation it revalidated, and
      // the fresh reads compare by what they can show (activity without its
      // liveness heartbeat). Fallback bodies are new values every tick, so
      // they are reduced to what they mean.
      reads: [
        [...marks].join(' '), historyUrl, g, boards, archivedBrief, activityFrameKey(activity),
        activityHistory.state, activityHistory.message, activityHistory.state === 'ready' ? activityHistory.spans : null,
        links.length ? links : null, issues, older?.done ?? null, older?.error ?? null,
        complete?.plans ?? null, complete?.error ?? null, lingerReadUrl, linger?.plans ?? null, linger?.error ?? null,
        messages, launches ?? null, launchesReadFailed(wantLaunches, launches), mesh.body, mesh.stale, runs?.key ?? null, runs?.body ?? null, runs?.stale ?? null,
      ],
    }
    applyProjectMutationIntents()
    // #279: drafts restored at boot learn where they belong from the first data.
    placeRestoredDrafts()
    // An idle tick leaves the frame on screen alone (#298): nothing it shows
    // changed, nothing deferred is waiting, and the clock has not moved far
    // enough to age a label. Only the poll skips; every human path paints.
    if (!pollMaySkipPaint({ inputs: frameInputs(), painted: paintedFrame, renderDirty, nowMs: Date.now() })) renderIfIdle()
    if (!bootFocusDone) { bootFocusDone = true; applyFocusHash() }
    // A deep link waiting on older history lands once it has been read, unless
    // the human has navigated since. A held press keeps it waiting for the next
    // tick rather than rebuilding under the pointer (#38).
    if (historyLookup && historyLookup.view !== navigationKey()) historyLookup = null
    if (historyLookup && !omitsHistory() && !pressHeld(pressedAt, Date.now())) {
      const { id, source } = historyLookup
      historyLookup = null
      focusItem(id, source)
    }
    // Likewise a deep link waiting on the complete archived plans (#299).
    if (archivedLookup && archivedLookup.view !== navigationKey()) archivedLookup = null
    if (archivedLookup && !omitsArchived() && !pressHeld(pressedAt, Date.now())) {
      const { id, source } = archivedLookup
      archivedLookup = null
      focusItem(id, source)
    }
    // Search results sit outside the editable gate; refresh the waiting list.
    if (searchAwaitingHistory) renderSearchResults()
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
  } finally {
    invalidatePreviewLinks()
  }
}

// Invalidate rather than retarget a link inside a protected draft or held press.
// The next normal rebuild supplies the new link without replacing the editor.
function invalidatePreviewLinks(root = document) {
  clearTimeout(previewExpiryTimer)
  previewExpiryTimer = null
  const nowMs = Date.now()
  const closed = new Set(lastData?.closed ?? [])
  let nextExpiry = Infinity
  const links = Array.isArray(lastData?.links) ? lastData.links : []
  const current = new Map([...indexLinks(links)].map(([key, link]) => [encodeURIComponent(key), link]))
  for (const link of current.values()) {
    if (previewRef(link, nowMs)) nextExpiry = Math.min(nextExpiry, Date.parse(link.fetched_at) + PREVIEW_TTL_MS)
  }
  for (const anchor of root.querySelectorAll('a[data-preview-key][href]')) {
    const link = current.get(anchor.dataset.previewKey)
    const preview = previewRef(link, nowMs)
    if (preview && !closed.has(anchor.dataset.previewProject) && preview.url === anchor.getAttribute('href')
      && preview.headSha === anchor.dataset.previewHead
      && String(preview.deploymentId) === anchor.dataset.previewDeployment) {
      if (!boundPreviewLinks.has(anchor)) {
        for (const event of ['click', 'auxclick', 'contextmenu']) anchor.addEventListener(event, guardPreviewActivation, true)
        boundPreviewLinks.add(anchor)
      }
      continue
    }
    anchor.removeAttribute('href')
    anchor.setAttribute('aria-disabled', 'true')
    anchor.tabIndex = -1
    anchor.classList.add('tone-muted')
    anchor.textContent = 'Preview unavailable'
    anchor.title = 'The preview changed or could not be confirmed. Finish your response to refresh the card.'
  }
  if (Number.isFinite(nextExpiry)) {
    previewExpiryTimer = setTimeout(invalidatePreviewLinks, Math.max(1, nextExpiry - nowMs))
  }
}

function guardPreviewActivation(event) {
  const anchor = event.target.closest?.('a[data-preview-key]')
  if (!anchor) return
  invalidatePreviewLinks()
  if (!anchor.hasAttribute('href')) event.preventDefault()
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
  pendingWrites += 1
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
  } finally {
    pendingWrites -= 1
    noteOutsideChange()
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
  // announced when showWriteError() rewrites it in place, as #321's notice does
  el.setAttribute('role', 'status')
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
// an option click that got no answer, with text typed in the editor that it must not replace (#636)
const ROW_CHOICE_NOT_APPLIED = 'Your choice was not applied. Nothing was lost; choose again.'
// #412 step 3: an app launch's approval counts only from the app's own window
const LAUNCH_ASK_REFUSED = 'Not sent — approve this from Agent Inbox’s own window.'
// An app launch's approval (#412 step 3): only its driver closes it, after the
// app's own window answers, so the page draws no Resolve or Dismiss for it.
// The viewer's routes refuse those writes anyway; this only keeps from offering them.
const isLaunchAskItem = (it) => it?.project === '@sessions' && it?.action_owner === 'approval'

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

// A blurred tab or embedded webview retains activeElement. Remember focus only
// while this document owns it, before replacing any focused DOM.
function activeFocusElement() {
  return document.hasFocus() ? document.activeElement : null
}

function captureCardFocus(card, id) {
  const active = activeFocusElement()
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
  const active = activeFocusElement()
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
  const active = activeFocusElement()
  const card = active?.closest?.('#boards [data-card-id], #find [data-card-id]')
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

// Focus was on one of the Plans page's own controls and the list was rebuilt. When the
// control is gone, focus goes where the person was heading instead of to <body>: the
// Stalled fold's controls to the Archived plans summary (else View), Moving's "Show N
// more" to the first plan it revealed.
function restorePlansControlFocus(id) {
  const revealed = movingMoreReveals
  movingMoreReveals = null
  const same = document.getElementById(id)
  // a control the person cannot see counts as gone: a browser refuses focus inside a closed <details>
  if (same && (same.matches('details > summary') || !same.closest('[hidden], details:not([open])'))) {
    same.focus({ preventScroll: true })
    return
  }
  let next = null
  if (id === 'plans-stalled-summary' || id === 'plans-archive-stalled') {
    next = document.getElementById('plans-stalled-summary') ?? document.getElementById('plans-archived-summary')
      ?? document.getElementById('plans-view-toggle')
  } else if (id === 'plans-moving-more' && revealed) {
    next = document.querySelector(`#boards [data-card-id="${CSS.escape(revealed)}"] > summary`)
  }
  next?.focus({ preventScroll: true })
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
  const fallback = card.querySelector(':scope > summary, :scope > .find-row-main') ?? card
  for (const target of [exact, fallback]) {
    if (!target) continue
    // a passive restore never opens a closed plan (that would record the open as
    // the person's choice): a step control inside one falls back to its summary
    if (target !== fallback && target.closest('#boards details.board:not([open])')) continue
    // a summary shows while its own <details> is closed: restoring focus to a
    // closed plan's summary must not open the plan under the person
    const shownFrom = target.matches('details > summary') ? target.parentElement.parentElement : target
    if (shownFrom) revealDetailsAncestors(shownFrom)
    if (shownFrom?.closest('[hidden], details:not([open])')) continue
    target.tabIndex = 0
    target.focus({ preventScroll: true })
    if (document.activeElement === target) return true
  }
  return false
}

// Which tab holds an item — a deep link must land on the right one. An open ask
// is on Home, in its list of asks.
function tabForItem(it) {
  // UX pass, slice 4: notes and finished things are on Find
  if (lastData.g.notes.some((gr) => gr.items.some((x) => x.id === it.id))) return 'find'
  if (lastData.g.done.some((x) => x.id === it.id)) return 'find'
  return 'dashboard'
}

// A card by its item id, preferring the panel on screen: Find draws items Home and the
// hidden panes may hold too.
function cardNodeFor(id) {
  const selector = `[data-card-id="${CSS.escape(id)}"]`
  return document.querySelector(`main > .panel:not([hidden]) ${selector}`) ?? document.querySelector(selector)
}

// Notification click / URL hash entry point (spec §11): select the item's
// project, switch to its tab, expand it, scroll to it.
function focusItem(id, source = null) {
  if (!lastData) return
  historyLookup = null
  archivedLookup = null
  const item = allItems(lastData.g).find((i) => i.id === id)
  // an archived plan lands only once its complete rows are loaded (#299)
  const board = [...lastData.boards, ...wholeArchived()].find((b) => b.id === id)
  const target = item ?? board
  if (!target) {
    // Issue #299: an archived plan the brief names. load() retries the link
    // once the complete archived plans have been read.
    if (omitsArchived() && lastData.archivedBrief.some((plan) => plan.id === id)) {
      archivedLookup = { id, source, view: navigationKey() }
      requestHistory()
    } else if (omitsHistory()) {
      // Issue #184: the page may omit this closed item. load() retries the link
      // once the complete history has been read.
      historyLookup = { id, source, view: navigationKey() }
      requestHistory()
    }
    return
  }
  const hasSearchSource = source && (
    typeof source.text === 'string'
    || Array.isArray(source.fragments)
    || typeof source.field === 'string'
  )
  if (hasSearchSource) searchJumpSource = { targetId: id, ...source }
  else if (searchJumpSource?.targetId !== id) searchJumpSource = null
  pendingFocusId = id
  // a search hit on a plan itself (its title, project, stream or agent) draws the full
  // form, so the meta line holds the highlight in plain sight
  if (board && hasSearchSource && !source?.rowId) planOpen.set(board.id, true)
  if (source?.rowId) {
    openRows.add(source.rowId)
    if (board) visitRows.add(source.rowId)
    if (board) {
      showDoneBoards.add(board.id)
      // UX pass, slice 3: a way in that targets a step opens its plan in full, over an earlier close
      planOpen.set(board.id, true)
    }
  }
  // UX pass, slice 1: Why it matters, Then and who acts sit inside Details too
  if (['context', 'impact', 'next', 'owner'].includes(source?.field)) {
    openContexts.add(source.rowId ? `row:${source.rowId}` : `item:${id}`)
  }
  if (source?.field === 'option-detail') {
    if (source.rowId) openRowCompares.add(source.rowId)
    else openCompares.add(id)
  }
  const tab = board ? 'boards' : tabForItem(item)
  // `keepLens` (Home's "Plan" button): the filters, "Updates" and the search box stay as the person left them
  if (tab === 'find') {
    // UX pass, slice 4: a landing on Find changes the lens only when the target is outside it
    resetSearch()
    if (activeTab !== 'find') selectTab('find', { paint: false })
    prepareFindLanding(item)
  } else if (!source?.keepLens) {
    projectFilter = target.project
    agentFilter = null
    actionFilter = 'all'
    changedOnly = false
    resetSearch()
  }
  selectTab(tab, { paint: false }) // the explicit forceRender below paints the target
  const hash = focusHashFor(id)
  if (location.hash !== hash) {
    // the hashchange this write fires runs focusItem again with no source; a
    // kept lens must not be narrowed by it (applyFocusHash)
    keptLensHash = source?.keepLens ? hash : null
    location.hash = hash // survives reload
  }
  forceRender()
  requestHistoryPaint() // a History target the page alone cannot place (#184)
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
    revealDetailsAncestors(queueTarget)
    selectRow(id)
  }
  if (queueTarget) setOpenRow(id)
  if (queueTarget) forceRender()
  requestAnimationFrame(() => {
    const el = cardNodeFor(id)
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
    scrollTarget.scrollIntoView({ behavior: motion.scrollBehavior(), block: 'center' })
    const contextSummary = sourceEl?.closest('.card-context')?.querySelector(':scope > summary')
    const focusTarget = contextSummary
      ?? (el.matches('details') ? el.querySelector(':scope > summary')
        : el.matches('.find-row') ? el.querySelector(':scope > .find-row-main') : el)
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
  searchAwaitingHistory = false
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
  if (result.action) {
    runPaletteAction(result.action)
    return
  }
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
  if (result.later) {
    const tags = document.createElement('span')
    tags.className = 'search-result-tags'
    const chip = document.createElement('span')
    chip.className = 'search-result-later'
    chip.textContent = 'Later'
    tags.append(chip, kind)
    option.append(title, tags)
  } else {
    option.append(title, kind)
  }
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
  const card = cardNodeFor(source.targetId)
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
  title: '.card-original-title, .nrow-title, .card-title, .board-title',
  label: '.row-label',
  detail: '.card-tldr-body, .card-title, .card-original-title',
  note: '.card-tldr-body, .card-title, .card-original-title, .note-line',
  'next-step': '.card-next-body, .card-title, .card-original-title, .card-recorded-request',
  owner: '.action-owner',
  impact: '.card-impact, .card-tldr-body, .card-title, .card-original-title',
  next: '.card-after, .card-impact, .card-tldr-body, .card-title, .card-original-title',
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

function searchStatusText(results, query) {
  return results.length
    ? `${results.length} search result${results.length === 1 ? '' : 's'}`
    : `No results for ${query}`
}

// #247 §2.2: a question set aside in Later is still an open item, and search
// keeps finding it there; with the Later section on, its result says where it
// waits. Marked here, beside the clock, so the result signature changes when a
// snooze ends.
function markLaterResults(results) {
  if (!laterSection || !results.length) return results
  const later = new Set(laterEntries(allItems(lastData.g), [], Date.now(), closedSet()).map((entry) => entry.item.id))
  return results.map((result) => (
    result.section === 'open' && later.has(result.targetId) ? { ...result, later: true } : result
  ))
}

// ── ⌘K actions (#307) ──────────────────────────────────────────────────────
// "answer…", "open plan…" and "jump to session…" over every open project, not
// the lens: each one lands the way a deep link does. Answer reads the one
// attention set; an ask is answered in its session panel or its Inbox card,
// never in a new editor.
const paletteHaystack = (...parts) => parts.filter(Boolean).join(' ').toLowerCase()

function paletteAsks(nowMs = Date.now()) {
  return sortRail(attentionEntries(allItems(lastData.g), lastData.boards, nowMs, liveSessionIds(), lastData.closed ?? []), nowMs)
}

function paletteTargets() {
  const nowMs = Date.now()
  const closed = closedSet()
  const asks = paletteAsks(nowMs).map((entry) => {
    const entity = dashboardEntryEntity(entry)
    const project = dashboardEntryProject(entry)
    const agent = entry.kind === 'row' ? entry.board.agent : entry.item.agent
    const title = dashboardEntryTitle(entry) ?? ''
    return { key: needsEntryId(entry), title, context: [project, agent].filter(Boolean).join(' · '),
      haystack: paletteHaystack(title, project, agent, entity?.next_step), action: { type: 'answer', id: needsEntryId(entry) } }
  })
  const plans = lastData.boards.filter((board) => !closed.has(board.project)).map((board) => ({
    key: board.id, title: board.title, context: [board.project, board.agent].filter(Boolean).join(' · '),
    haystack: paletteHaystack(board.title, board.project, board.agent, board.stream), action: { type: 'plan', id: board.id },
  }))
  const sessions = (lastData.activity ?? []).filter((row) => isWorking(row, nowMs) && !closed.has(row.project)).map((row) => {
    const title = typeof row.doing === 'string' && row.doing.trim() && row.doing.trim() !== 'open' ? row.doing.trim() : 'No task reported yet'
    return { key: row.session, title, context: [row.agent, row.project, row.stream].filter(Boolean).join(' · '),
      haystack: paletteHaystack(title, row.agent, row.project, row.stream, row.detail), action: { type: 'session', id: row.session } }
  })
  return { asks, plans, sessions }
}

// With no targets a command lists nothing and a name's prefix suggests it.
const NO_PALETTE_TARGETS = { asks: [], plans: [], sessions: [] }
const commandShape = (query) => paletteResults(query, NO_PALETTE_TARGETS, fuzzySearch).length

// `field`: the field a command fills (Find's own, on Find)
function runPaletteAction(action, field = null) {
  if (action.type === 'command') {
    const input = field ?? searchElements().input
    input.value = action.fill
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.focus({ preventScroll: true })
    return
  }
  if (action.type === 'plan') {
    focusItem(action.id)
    return
  }
  if (action.type === 'session') {
    jumpToSession(action.id)
    return
  }
  const entry = paletteAsks().find((candidate) => needsEntryId(candidate) === action.id)
  if (!entry) {
    renderSearchResults()
    return
  }
  // the ask in front on Home, as a click on its row opens it
  resetSearch()
  openAskInInbox(entry)
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
  // Issues #184 and #299: results always cover all of History and every
  // archived plan. While the closed history the page omits, or the complete
  // archived plans, are still being read, keep any prior list busy rather than
  // listing an incomplete result set. The read itself belongs to the human's
  // entry points (typing, focusing) or the next poll — never to a render.
  if (omitsHistory() || omitsArchived()) {
    searchAwaitingHistory = true
    beginSearchUpdate()
    if (status) status.textContent = searchWaitText()
    return
  }
  searchAwaitingHistory = false
  const previousActiveKey = searchResultCache[searchActiveIndex]?.key
  const previousResults = searchResultCache
  const found = markLaterResults(buildSearchResults(lastData, query, fuzzySearch))
  // #307: ⌘K actions lead when a command is typed; a suggestion never pushes
  // the strongest Open-item match off the first place.
  const actions = paletteResults(searchQuery, paletteTargets(), fuzzySearch)
  const suggests = actions[0]?.action.type === 'command'
  const nextResults = suggests && found[0]?.section === 'open' ? [...found, ...actions] : [...actions, ...found]
  const nextSignature = JSON.stringify([query, nextResults])
  if (!results.hidden && searchResultSignature === nextSignature) {
    searchResultCache = nextResults
    finishSearchUpdate()
    input.setAttribute('aria-expanded', 'true')
    // the list is unchanged, but a busy wait may have replaced its status (#184)
    if (status) status.textContent = searchStatusText(nextResults, query)
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
    if (status) status.textContent = searchStatusText(searchResultCache, query)
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
    status.textContent = searchStatusText(searchResultCache, query)
  }
  const preservedIndex = previousActiveKey
    ? searchResultCache.findIndex((result) => result.key === previousActiveKey)
    : -1
  setSearchActive(preservedIndex >= 0 ? preservedIndex : 0)
}

let bootFocusDone = false
// the hash focusItem just wrote for a way in that keeps the person's lens (Home's "Plan" button)
let keptLensHash = null

function applyFocusHash() {
  const kept = keptLensHash
  keptLensHash = null
  // UX pass, slice 3: the landing already happened, with the lens left alone
  if (kept !== null && location.hash === kept) return
  // #586: #chats opens Find with the Chats chip (UX pass, slice 4, step B); the viewer never writes it
  if (isChatsHash(location.hash)) {
    openChatsInFind()
    return
  }
  // Agent cards step 1 (D3): #cards, or #cards/<agent key>, opens the tab, on that agent's page
  const linked = /^#cards(?:\/(.+))?$/.exec(location.hash)
  if (linked) {
    let key = linked[1] ?? null
    try { key = key === null ? null : decodeURIComponent(key) } catch { /* taken literally */ }
    agentCardsLink = { key }
    applyAgentCardsLink()
    return
  }
  const f = parseFocusHash(location.hash)
  if (f) focusItem(f.id)
}

function initFocusHash() {
  window.addEventListener('hashchange', applyFocusHash)
}

// notes age into the finished list after NOTE_AGE_MS (spec §8) — done at the door so the
// notes and the finished things on Find agree
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

// ── closed history (issue #184) ─────────────────────────────────────────────
// The lens every loaded item passes through: project/agent filters plus the
// suppressed (closed, not peeked) projects. Omitted history obeys it too.
function olderLens() {
  return { project: projectFilter, agent: agentFilter, hidden: dashboardClosedProjects() }
}

// Whether lastData.g still omits closed history anywhere.
function omitsHistory() {
  const summary = lastData?.older
  return Boolean(summary && summary.loaded < summary.total)
}

// Issue #299: whether surfaces still read archived plans in brief, the
// complete list not loaded while at least one plan is archived.
function omitsArchived() {
  return Boolean(lastData && !lastData.archivedFull && lastData.archivedBrief.length)
}

// The page alone, through the same suppression and filters as the view:
// archived plans in brief (#299), as the page carries them.
function pageView(view = lastData) {
  return filterData(withoutClosed({ g: view.page, boards: view.boards, archived: view.archivedBrief }))
}

// What the human is looking at. A deep link still waiting on older history
// lands only if this has not changed since it was followed (#184).
function navigationKey() {
  return JSON.stringify([activeTab, projectFilter, agentFilter, settingsOpen()])
}

// Search covers every project, all of History and every archived plan while it
// is in use: open results, a pending query, or a query focused in an active
// window. Text left in a closed box, or in a background window that still
// remembers focus on it (#233), waits for the human to return to it.
function searchInUse() {
  const input = document.getElementById('search')
  return Boolean(input?.value.trim() && (searchIndexOpen || searchTimer || activeFocusElement() === input))
}

// The Live sessions the project and agent filters show the Dashboard.
function lensActivity(view) {
  return (view.activity ?? []).filter((a) =>
    (!projectFilter || a.project === projectFilter) && (!agentFilter || a.agent === agentFilter))
}

// Which surfaces need the closed history the page omits. Judged on a PAGE
// (the applied one, or a tick's new one before it applies), never on merged
// data, which never needs it: that would drop the history it just loaded and
// fetch it again on the next tick.
function historyWanted(view = lastData) {
  const summary = view?.pageHistory
  if (!summary || summary.loaded >= summary.total) return false
  // A deep link may name any omitted item, and search covers all of History.
  if (historyLookup?.view === navigationKey()) return true
  if (searchInUse()) return true
  // UX pass, slice 4: a query on Find under a chip that lists history
  if (findInUse() && findNeeds().history) return true
  const older = olderHistory(summary, olderLens())
  if (relayOpen && older.outcomes > 0) return true
  if (activeTab === 'find' && older.items > 0 && (findHistoryPinned || findDrawsNothing(view, summary))) return true
  // Recent outcomes, and the ribbon at a range longer than the default (#392).
  if (activeTab === 'dashboard' && (older.outcomes > 0 || (older.items > 0 && ribbonReadsOlder()))) {
    const model = dashboardModel(pageView(view), summary, lensActivity(view))
    return model.recentOutcomesWait.history || ribbonRangeWait(model).history
  }
  return false
}

// UX pass, slice 4: Find with no query whose page can place no row of its chip would draw an
// empty list under a lone "Show more". As History read what its page could not place, Find
// reads the older history itself then, so the list is never blank. Judged on the PAGE.
function findDrawsNothing(view, summary) {
  if (findSettled.trim() || !findNeeds().history) return false
  const { rows } = buildFindRows(pageView(view), {
    chip: findChip, before: summary.before ?? null, nowMs: Date.now(), archivedWhole: false,
  })
  return rows.length === 0
}

// Issue #299: which surfaces need the complete archived plans the brief stands
// in for. Judged on the BRIEF (the applied one, or a tick's new one before it
// applies), as historyWanted is on a page, never on the complete list, whose
// plans omit nothing: that would drop the list it just loaded.
function archivedWanted(view = lastData) {
  const brief = view?.archivedBrief
  if (!brief?.length) return false
  // Restored row drafts waiting to learn whether an archived row holds them.
  if (restoredDrafts && [...restoredDrafts.values()].some(({ draft }) => awaitsArchivedRow(draft))) return true
  // A deep link to an archived plan, search, and Plan flow open on one.
  if (archivedLookup?.view === navigationKey()) return true
  if (searchInUse()) return true
  if (findInUse() && findNeeds().archived) return true
  if (missionBoardId && brief.some((plan) => plan.id === missionBoardId)) return true
  const lens = pageView(view)
  const omitted = omittedOutcomes(lens.archived).outcomes
  // Handoffs lists every recorded outcome.
  if (relayOpen && omitted > 0) return true
  // Plans draws archived plans whole: the archived fold while it is open, and
  // a plan holding keyboard focus that just moved into the fold, which the
  // focus follows. A plan lingering after its agent archived it (§9) is read
  // whole on its own (#373, lingeringUrl), unless too many linger for that.
  if (activeTab === 'boards') {
    const lingering = lingeringPlans(lens.boards, lens.archived)
    const ownRead = lingeringIds(view).length <= LINGERING_READ_LIMIT
    const lingers = new Set(ownRead ? lingering.map((plan) => plan.id) : [])
    const focused = activeFocusElement()?.closest?.('#boards [data-card-id]')?.dataset.cardId
    return (lingering.length > 0 && !ownRead) || (showArchived && lens.archived.length > lingering.length)
      || lens.archived.some((plan) => plan.id === focused && !lingers.has(plan.id))
  }
  if (activeTab === 'dashboard' && omitted > 0) {
    const model = dashboardModel(lens, view.pageHistory, lensActivity(view))
    return model.recentOutcomesWait.archived || ribbonRangeWait(model).archived
  }
  return false
}

// Plans that linger as "completed — archived" (§9): never one the person archived with
// Archive all, which lists with the archived plans like any other.
function lingeringPlans(boards, archived) {
  return lingeringBoards(sessionActiveBoards, boards, archived).filter((b) => !handArchived.has(b.id))
}

// Issue #373: a plan lingering in Plans (§9) is drawn whole from its own read
// while the complete list is not wanted; at most this many plans are read that
// way (the route's own limit), and more read the complete list.
const LINGERING_READ_LIMIT = 50

// Every plan lingering in Plans, across every project and agent, so a lens
// change asks for no new read. Judged on the brief, as archivedWanted is.
function lingeringIds(view = lastData) {
  if (!view?.archivedBrief?.length) return []
  return lingeringPlans(view.boards, view.archivedBrief).map((plan) => plan.id).sort()
}

// The read that draws them, one representation per set of plans, while Plans
// shows them. load() reads it only while the complete list is not wanted.
function lingeringUrl(view = lastData) {
  if (activeTab !== 'boards') return null
  const ids = lingeringIds(view)
  return ids.length && ids.length <= LINGERING_READ_LIMIT ? `/api/boards/archived/plans?ids=${ids.join(',')}` : null
}

// Lingering plans the applied tick did not read, and the complete list does
// not stand in for. A read that failed was read: the poll retries it.
function lingeringWanted() {
  const url = lingeringUrl()
  return Boolean(lastData && url && !lastData.archivedFull && url !== lastData.lingerUrl)
}

// Archived plans as they are drawn whole: the complete list while loaded, else
// the plans lingering in Plans, read on their own (#373).
function wholeArchived() {
  return lastData?.archivedFull ?? lastData?.lingering ?? []
}

// What the page omits that a surface wants: older closed history (#184), the
// complete archived plans (#299), or the plans lingering in Plans (#373). One
// early tick reads whatever is wanted.
function omittedWanted() {
  return (omitsHistory() && historyWanted()) || (omitsArchived() && archivedWanted()) || lingeringWanted()
}

// Only load() reads older history and the complete archived plans. A
// navigation or render that needs them may only ask for an early poll tick:
// that tick decides, reads and paints through the poll's own gate, so no such
// path ever forces a frame. One request per applied tick: a failed read is
// retried by the poll, never in a loop.
function requestHistory() {
  if (historyLoadScheduled || historyRequestedFor === appliedLoadGeneration || !omittedWanted()) return
  historyRequestedFor = appliedLoadGeneration
  historyLoadScheduled = true
  setTimeout(() => {
    historyLoadScheduled = false
    void load()
  }, 0)
}

// A human action that needs older history or archived plans has just painted
// what is known; this reads the rest and paints it outside the poll's gate,
// like every frame the human asks for (#38): an unrelated draft or a focused
// Dashboard control must not hide it. Called only from explicit entry points,
// never from forceRender, a render or the poll, so passive paths still never
// force a paint.
function requestHistoryPaint() {
  if (!lastData || historyPaintRequestedFor === appliedLoadGeneration || !omittedWanted()) return
  historyPaintRequestedFor = appliedLoadGeneration
  void reloadAndPaint()
}

// Shown where a surface waits on older history the last tick could not read.
const OLDER_HISTORY_UNAVAILABLE = 'Older history is unavailable right now.'
// ...or on the complete archived plans (#299).
const ARCHIVED_UNAVAILABLE = 'Archived plans are unavailable right now.'

function olderHistoryWaitText(loading) {
  return lastData?.olderError ? OLDER_HISTORY_UNAVAILABLE : loading
}

function archivedWaitText(loading, error = lastData?.archivedError) {
  return error ? ARCHIVED_UNAVAILABLE : loading
}

// A surface waiting on either says why when the read it waits on failed.
function omittedWaitText(loading, { history, archived }) {
  if (history && lastData?.olderError) return OLDER_HISTORY_UNAVAILABLE
  if (archived && lastData?.archivedError) return ARCHIVED_UNAVAILABLE
  return loading
}

function searchWaitText() {
  const history = omitsHistory()
  const archived = omitsArchived()
  const loading = history && archived ? 'Searching older history and archived plans…'
    : history ? 'Searching older history…' : 'Searching archived plans…'
  return omittedWaitText(loading, { history, archived })
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

function collectAgents({ g, boards }, olderAgents = []) {
  return [...new Set([...allItems(g).map((i) => i.agent), ...boards.map((b) => b.agent), ...olderAgents])].sort()
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

function dashboardFocusBookmark() {
  return activeFocusElement()?.closest?.('#dashboard [data-dashboard-focus-key]')?.dataset.dashboardFocusKey ?? null
}

function restoreDashboardFocus(key) {
  if (!key || activeTab !== 'dashboard') return false
  const target = document.querySelector(`#dashboard [data-dashboard-focus-key="${CSS.escape(key)}"]`)
  if (!target) return false
  if (document.activeElement !== target) target.focus({ preventScroll: true })
  return document.activeElement === target
}

function renderDashboardAmbient(model, { forced = false } = {}) {
  const host = document.querySelector('#dashboard .dashboard')
  if (!host?.querySelector('.dashboard-grid')) return
  lastDashModel = model
  renderDashSince(host.querySelector('.dash-since'), model)
  // the cards first: the session panel shows one of them (#454), and the lane's session tags read them
  agentsHome.paint(host, {
    activity: liveInLens(), boards: model.boards, attention: model.waitingEntries, closed: dashboardClosedProjects(),
    // #454 A.1: answers not picked up yet (shown in the panel, never counted)
    answered: model.agentEntries,
    // #412 step 3: this app's launches, only with its switch on (§9: otherwise none is read or drawn)
    launches: launchesOn() ? launchesInLens() : null,
    outside: launchesOn() ? launchesOutsideLens() : 0,
    nowMs: Date.now(), forced, selected: focusSession,
  })
  // §3.5: the lens's plans with open steps, each naming its project only under All projects
  plansLane.paint({ plans: model.plansInProgress, showProject: !projectFilter, nowMs: Date.now() })
  renderDashFocus(focusPanelEl, model, { forced })
  placeFocusPanel()
  renderDashRibbon(host.querySelector('.dashboard-activity'), model)
  renderDashboardOutcomes(host.querySelector('.dashboard-outcome-list'), model.recentOutcomes, model.recentOutcomesComplete,
    model.recentOutcomesWait, model.recentOutcomesHidden)
}

// Only a changed value is written, so an unchanged lane keeps its text nodes
// (and any selection in them) and its animations never restart.
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text
}

function setAttr(el, name, value) {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value)
}

function setHidden(el, hidden) {
  if (el.hidden !== hidden) el.hidden = hidden
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
// relMs says "moments" under a minute; a chip says "<1m".
const ageText = (ms) => relMs(ms) === 'moments' ? '<1m' : relMs(ms)

// ── the Working and Quiet lanes (#454 design §3, dashboard lanes design §3.3–3.4) ──
// The session panel's key, if open (#307, #454): a session id, or `launch:<id>` for a
// launch's card, which outlives its sessions. agentsHome.cardFor() resolves it.
let focusSession = null
let lastDashModel = null // the model the last paint drew, for a handler's own repaint
// Its folds are window-local.
// #617 PR 4b: Open desk, offered only where agentInboxDesk.available() says so (the hub's page shown
// from another Mac). Asked once now and on each connection change; a change repaints the cards and
// the session panel.
const deskOpen = installDeskOpen({
  onChange: () => {
    agentsHome.repaint()
    paintSessionFocus()
  },
})

// #634: a card's files opened as copies on this Mac, offered only where
// agentInboxDesk.filesAvailable() says so (the hub's page shown from another Mac). Asked once now
// and on each connection change; a change is a frame input, so the next poll repaints the strips.
const hubFiles = installHubFiles({ onChange: () => noteOutsideChange() })
// the item or row a Links strip's file belongs to, while files open here; else no hub actions
const hubFileOwner = (entity) => (hubFiles.available() ? (hubFileEntity(entity) ?? null) : null)
// linkStripHtml's hubFiles option: a file chip's group for the entity `ownerOf(link)` names, if any
const hubFileChips = (ownerOf) => (link, parts) => {
  const entity = ownerOf(link)
  return entity ? hubFileGroupHtml({ ...parts, link, entity }) : null
}

const agentsHome = installAgentsHome({
  deskOpen: () => deskOpen,
  // a card's or row's click toggles its panel; Enter and Open open it at its head, Message,
  // Transcript and Resume… at that part
  openSession: (key, part, ask) => (part ? openSessionFocus(key, part, ask) : toggleSessionFocus(key)),
  // "Asking you · N": that session's first waiting ask, opened in front on Home as a click on its row opens it
  showAsk: (id) => {
    const entry = id ? waitingAskEntry(id) : null
    if (!entry) return
    // already drawn in the list: open it where it is, as a click on its row does, changing
    // no lens (a deep link's narrowing to the ask's project would hide the other projects)
    const drawn = needsYouRowEl(id)
    if (drawn && !drawn.closest('[hidden], details:not([open])')) {
      selectRow(id)
      setOpenRow(id)
      forceRender()
      return
    }
    openAskInInbox(entry)
  },
  // a card's action that failed says why in the launch's panel
  launchAction: (id, action) => launchUi?.run(id, action).then((noted) => {
    if (noted && focusSession !== `launch:${id}`) openSessionFocus(`launch:${id}`)
  }),
  launches: () => (launchesOn() ? launchUi : null),
  hasDraft: (session) => messageDrafts.has(session),
  projectColor: (project) => pcolor(project).dot,
  scrollBehavior: () => motion.scrollBehavior(),
  pulse: (el) => { if (dashboardMotion()) playOnce(el, 'pulse', 'dash-lane-pulse') },
  paintUndelivered,
  // its own repaints (the folds) can remove the list the panel sits in (#463 review)
  afterRepaint: () => placeFocusPanel(),
  // "N sessions outside this filter · Show all": the lens cleared, as the rail's All does
  showAll: () => {
    projectFilter = null
    agentFilter = null
    resetPaging()
    forceRender()
    requestHistoryPaint()
  },
})

// ── the Plans in progress lane (dashboard lanes design §3.5) ─────────────────
// A row opens its plan the way every other link to a plan does (focusItem: its
// project as the lens, the Plans tab, the card focused); "All plans ›" opens
// Plans under the lens the Dashboard has.
const plansLane = installPlansLane({
  open: (id) => focusItem(id),
  openAll: () => selectTab('boards'),
  projectColor: (project) => pcolor(project).dot,
  scrollBehavior: () => motion.scrollBehavior(),
})


// One iteration of a CSS one-shot, restarted when it is still running and
// removed when it ends or is cancelled (Calm switched on, the Dashboard left
// mid-pulse), so nothing lingers to replay later. Never a loop (#304). A
// restart first drops the running one's handler: the cancel its removal fires
// would otherwise remove the class the restart just added.
const oneShots = new WeakMap() // element → Map(class → its end handler)
function playOnce(el, name, animation = `dash-lane-${name}`) {
  const handlers = oneShots.get(el) ?? new Map()
  oneShots.set(el, handlers)
  const previous = handlers.get(name)
  if (previous) {
    el.removeEventListener('animationend', previous)
    el.removeEventListener('animationcancel', previous)
  }
  if (el.classList.contains(name)) {
    el.classList.remove(name)
    void el.offsetWidth
  }
  el.classList.add(name)
  const done = (event) => {
    if (event.animationName !== animation) return
    el.classList.remove(name)
    el.removeEventListener('animationend', done)
    el.removeEventListener('animationcancel', done)
    handlers.delete(name)
  }
  handlers.set(name, done)
  el.addEventListener('animationend', done)
  el.addEventListener('animationcancel', done)
}

// Activity motion runs only where the human allows it and can see it.
const dashboardMotion = () => motion.activityMotion() && !document.getElementById('dashboard')?.hidden


// The ask still in the attention set by its id (unlensed): answered, snoozed,
// pinned or dismissed, it is not.
function waitingAskEntry(id) {
  if (!lastData) return null
  return attentionEntries(allItems(lastData.g), lastData.boards, Date.now(), liveSessionIds(), lastData.closed ?? [])
    .find((entry) => needsEntryId(entry) === id) ?? null
}


// #454 A.2: "Show on Agents ›" on an ask's card: the ask in its session's
// panel, at that ask; the lens widens to the ask's project when it hides it.
// An ask no card holds opens in front on Home instead.
function openAskInSession(entry) {
  if (!entry) return
  const id = needsEntryId(entry)
  let key = agentsHome.askKey(id)
  const owner = entry.kind === 'row' ? entry.board : entry.item
  if (!key && ((projectFilter && projectFilter !== owner.project) || (agentFilter && agentFilter !== owner.agent))) {
    // Scope to the ask's project only where its session lives too: an
    // @sessions approval (or an ask filed away from its session's project)
    // needs both in the lens, so the lens clears instead.
    const session = owner.session
    const home = session
      ? (lastData.activity ?? []).find((row) => row.session === session)?.project
        ?? (lastData.launches ?? []).find((launch) => Array.isArray(launch.sessions) && launch.sessions.includes(session))?.project
      : null
    if (projectFilter && projectFilter !== owner.project) {
      projectFilter = !isReservedProject(owner.project) && (!home || home === owner.project) ? owner.project : null
    }
    if (agentFilter && agentFilter !== owner.agent) agentFilter = null
    resetPaging()
    selectTab('dashboard', { paint: false, open: false })
    forceRender()
    key = agentsHome.askKey(id)
  }
  if (!key) {
    openAskInInbox(entry)
    return
  }
  openSessionFocus(key, entry.kind === 'item' && isLaunchAskItem(entry.item) ? 'approval' : 'asks', id)
}

// ── the session panel (#307 grown by #454, design §3.3) ─────────────────────
// One session, from its card (agentsHome.cardFor): its state and summary, the
// launch's action bar, an app session's approval answered in place (Q3, through
// sendReply's signed path), its other asks answered in
// place with the Inbox's own controls (#454 A.2, paintPanelAsks), the worktree, the transcript, the session's
// one composer (#411), or Resume and send for a parked launch, and the context
// #307 showed: detail, subagents, plan, recent outcomes, PR/CI chips and links.
// A terminal session's panel has no action bar or transcript. The ambient
// painter updates it in place: each part is rewritten only when its markup
// changes, the composer and the Resume text are each one node kept across
// paints, and the launch's parts are launch-ui.js's. It feeds no attention
// surface. Opening or closing it moves focus only in a
// window that has it, or to the part an explicit click asked for.
const focusTargets = new Map() // data-focus-* value → what its button opens
const focusPartHtml = new WeakMap()

// The one panel element, made once: under 1280px it moves into the cards' grid
// (placeFocusPanel), so it is always reached through this, never a selector.
let focusPanelEl = null
// The one split around the lanes and the panel (§3.6), made once by renderDashboard.
let splitEl = null

function dashFocusEl() {
  const aside = document.createElement('aside')
  focusPanelEl = aside
  aside.id = 'dashFocus'
  aside.className = 'dash-focus'
  aside.hidden = true
  aside.setAttribute('aria-labelledby', 'dashFocusTitle')
  aside.innerHTML = `
    <div class="sp-head">
      <div class="dash-focus-head">
        <span class="sp-state"></span>
        <h2 id="dashFocusTitle" tabindex="-1"></h2>
        <button type="button" class="dash-focus-close" aria-label="Close the session panel" title="Close (Esc)" data-dashboard-focus-key="focus:close">×</button>
      </div>
      <p class="dash-focus-meta"></p>
      <p class="sp-chat" hidden></p>
      <p class="sp-hint" hidden></p>
    </div>
    <div class="sp-actions" role="group" aria-label="Session actions" hidden></div>
    <p class="sp-note" role="status" hidden></p>
    <div class="sp-body">
      <p class="dash-focus-doing"></p>
      <p class="dash-focus-detail"></p>
      <p class="dash-focus-gone" hidden>This session is no longer listed, or is outside the current filters.</p>
      <section class="dash-focus-part sp-place" aria-label="Where it runs" hidden><div class="dash-focus-place"></div></section>
      <section class="dash-focus-part sp-approval" aria-label="Approval"><h3>Approval <span class="sp-approval-count"></span></h3><div class="dash-focus-approval"></div></section>
      <section class="dash-focus-part sp-asks" aria-label="Asking you"><h3>Asking you <span class="sp-asks-count"></span></h3><div class="dash-focus-asks"></div></section>
      <section class="dash-focus-part sp-worktree" aria-label="Worktree" hidden><h3>Worktree</h3><dl class="sp-worktree-box"></dl></section>
      <section class="dash-focus-part sp-transcript" aria-label="Transcript" hidden><h3>Transcript <small>newest at the bottom</small></h3>
        <div class="sp-transcript-box"><p class="sp-transcript-status"></p><ol class="sp-transcript-lines" aria-live="polite"></ol></div></section>
      <section class="dash-focus-part" aria-label="Subagents"><h3>Subagents</h3><div class="dash-focus-children"></div></section>
      <section class="dash-focus-part" aria-label="Plan"><h3>Plan</h3><div class="dash-focus-planbox"></div></section>
      <section class="dash-focus-part" aria-label="Recent outcomes"><h3>Recent outcomes</h3><div class="dash-focus-outcomes"></div></section>
      <section class="dash-focus-part" aria-label="Pull request"><h3>Pull request</h3><div class="dash-focus-source"></div></section>
      <section class="dash-focus-part" aria-label="Links"><div class="dash-focus-links"></div></section>
    </div>
    <section class="dash-focus-message" aria-label="Message" hidden><div class="dash-focus-composer"></div></section>
    <section class="sp-resume" aria-label="Resume and send" hidden>
      <h3>Resume and send</h3><div class="sp-resume-slot"></div>
      <div class="sp-resume-actions"><button type="button" class="launch-action primary" data-launch-action="resume">Resume and send</button></div>
    </section>`
  aside.addEventListener('click', (event) => {
    const control = event.target.closest?.('[data-focus-target], .dash-focus-close')
    if (!control || control.disabled || control.getAttribute('aria-disabled') === 'true') return
    if (control.matches('.dash-focus-close')) closeSessionFocus()
    else focusTargets.get(control.dataset.focusTarget)?.()
  })
  aside.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) {
      onPanelAskKey(event)
      return
    }
    event.preventDefault()
    event.stopPropagation()
    closeSessionFocus()
  })
  return aside
}

// #454 A.2: on an ask's block in the panel (never while typing), S snoozes and
// P pins; 1–4 and R are the global keys, scoped to the block
// (keyboardActionScope).
function onPanelAskKey(event) {
  if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return
  const target = event.target
  if (!(target instanceof Element) || target.closest('textarea, input, select, [contenteditable="true"]')) return
  const block = target.closest('[data-panel-ask]')
  if (!block) return
  const key = event.key.toLowerCase()
  const handled = key === 's' ? block.querySelector('[data-ask-action="snooze"]')
    : key === 'p' ? block.querySelector('[data-ask-action="pin"]') : null
  if (!handled) return
  event.preventDefault()
  event.stopPropagation()
  handled.click()
}

// Rewrite one part only when its markup changed, keeping a keyboard user on
// the same control (by its focus key) when the window has focus.
function setFocusPart(aside, el, html) {
  setHidden(el.closest('section'), !html)
  if (focusPartHtml.get(el) === html) return
  focusPartHtml.set(el, html)
  const key = activeFocusElement()?.closest?.('[data-dashboard-focus-key]')
  const focusKey = key && el.contains(key) ? key.dataset.dashboardFocusKey : null
  el.innerHTML = html
  bindContextDisclosures(el)
  if (!focusKey || !document.hasFocus()) return
  const next = el.querySelector(`[data-dashboard-focus-key="${CSS.escape(focusKey)}"]`)
  if (next && !next.disabled) next.focus({ preventScroll: true })
  if (next && document.activeElement === next) return
  // the control is gone or cannot take focus: the part's heading, else the panel's
  // title, so focus never falls out of the panel (and Esc still closes it)
  const heading = el.closest('section')?.querySelector('h3')
  if (heading && !heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1')
  ;(heading ?? aside.querySelector('#dashFocusTitle'))?.focus({ preventScroll: true })
  if (!aside.contains(document.activeElement)) aside.querySelector('#dashFocusTitle')?.focus({ preventScroll: true })
}

function focusButton(target, label, open, { className = '', attrs = '' } = {}) {
  focusTargets.set(target, open)
  return `<button type="button" class="dash-focus-go${className ? ` ${className}` : ''}" data-focus-target="${esc(target)}" ` +
    `data-dashboard-focus-key="focus:${esc(target)}"${attrs}>${esc(label)}</button>`
}

// Q3 (#454): an app session's approval, answered here with its own options
// only, through sendReply's signed path; no editor, so no draft. Outside the
// app's granted window it says where to answer and opens its Inbox card.
//
// Answering one approval removes its block, and the next one's options slide up
// under the pointer: so while an answer is in flight, and for a short calm after
// the repaint that follows it, every option is disabled and its click ignored.
const APPROVAL_CALM_MS = 700
let approvalSending = false
let approvalCalmUntil = 0
const approvalHeld = () => approvalSending || Date.now() < approvalCalmUntil

function answerInPanel(id, label) {
  if (approvalHeld()) return
  approvalSending = true
  paintSessionFocus()
  Promise.resolve(sendReply(id, label, null, 'answer')).finally(() => {
    approvalSending = false
    approvalCalmUntil = Date.now() + APPROVAL_CALM_MS
    paintSessionFocus()
    window.setTimeout(paintSessionFocus, APPROVAL_CALM_MS)
  })
}

function approvalHtml(entry, granted) {
  const it = entry.item
  const id = it.id
  const options = (Array.isArray(it.options) ? it.options : []).map((o) => String(o?.label ?? '')).filter(Boolean)
  // aria-disabled, not disabled: the held option keeps focus (#459 review), and
  // answerInPanel ignores it while approvalHeld()
  const held = approvalHeld() ? ' aria-disabled="true"' : ''
  const buttons = granted
    ? options.map((label, index) => focusButton(`approve:${id}:${index}`, label, () => answerInPanel(id, label),
      { className: index === 0 ? 'sp-option rec' : 'sp-option', attrs: held })).join('')
    : `<p class="dash-focus-none">Answer it from Agent Inbox’s own window.</p>` +
      focusButton(`item:${id}`, 'Open ask', () => openAskInInbox(entry))
  const error = writeErrors[id] ?? ''
  return `<div class="sp-appr" data-focus-approval="${esc(id)}"><strong class="sp-appr-title">${esc(it.title ?? '')}</strong>` +
    `<div class="sp-appr-options">${buttons}</div>` +
    `<span class="write-error" data-error-for="${esc(id)}" role="status"${error ? '' : ' hidden'}>${esc(error)}</span>` +
    `<p class="sp-appr-warn">${esc(SHELL_WARNING)}</p></div>`
}

// #454 A.2: the panel's Asking you section, the Dashboard's answer surface for
// every ask but an approval. Each ask is one block mounting the Inbox's own
// answerEl/rowAnswerEl (surface 'compact', #303's rail's before it), with Snooze 4h, Pin and
// Open in Inbox (snoozeAsk, pinAsk, openAskInInbox): one answering
// implementation, so drafts stay in draftReplies/rowDrafts and join
// suspendState(), recovery, durable drafts and the restart hold. #303's
// three draft rules hold here: a poll leaves the section alone while one of its
// asks holds a draft in use (or a background window remembers focus in it, for
// two minutes after the human's last input, #563), a frame
// the human asked for rebuilds it, and focus comes back only with the
// document's. Below, this session's answers not yet picked up, dimmed and
// never counted.
const panelAsksKey = new WeakMap() // the section → what it was built from

// Held per PANEL (focusSession), never per card: a card's id moves under an
// open panel (its session ends, or comes back under a launch's card), and that
// must not rebuild an editor being typed in. Only an explicit open, which moves
// focusSession, or a forced paint rebuilds it.
function panelAsksHeld(list, asks) {
  if (list.dataset.panel !== (focusSession ?? '')) return false
  const remembered = document.activeElement
  // #563: only while the human was here lately; a window left in the background
  // for longer shows current asks, and its remembered focus goes with the old ones
  const nowMs = Date.now()
  if (!document.hasFocus() && remembered && list.contains(remembered) && recentInput(humanInputAt, nowMs)) return true
  if (!draftsInUse(nowMs)) return false
  // an incoming ask holding a draft holds it too: building its editor from a
  // poll could run draft recovery, which switches tabs and moves focus
  return [...list.querySelectorAll('[data-panel-ask]')].some((el) => holdsDraft(el.dataset.panelAsk))
    || asks.some((entry) => holdsDraft(needsEntryId(entry)))
}

function paintPanelAsks(aside, card, { forced = false, asks = [], none = false } = {}) {
  const list = aside.querySelector('.dash-focus-asks')
  if (!list) return
  const cardId = card?.id ?? ''
  const panel = focusSession ?? ''
  const answered = card?.answered ?? []
  const nowMs = Date.now()
  if (!forced && panelAsksHeld(list, asks)) return
  const key = JSON.stringify([panel, cardId, laterSection, none,
    asks.map((entry) => [entry.liveness ?? '', entryEntity(entry), entry.board?.revision ?? null]), answered.map(entryEntity)])
  if (!forced && list.dataset.panel === panel && panelAsksKey.get(list) === key) {
    // nothing it shows changed but the clock: only the ages move, in place
    for (const el of list.querySelectorAll('time[data-asked]')) setText(el, askTimeModel(el.dataset.asked, nowMs)?.text ?? '')
    return
  }
  panelAsksKey.set(list, key)
  const focused = activeFocusElement()?.closest?.('[data-panel-ask]')
  const bookmark = focused && list.contains(focused) ? captureCardFocus(focused, focused.dataset.panelAsk) : null
  const index = bookmark ? [...list.querySelectorAll('[data-panel-ask]')].indexOf(focused) : -1
  list.dataset.panel = panel
  const blocks = asks.map((entry) => panelAskEl(entry, nowMs))
  const lines = answered.map((entry) => panelAnsweredEl(entry, nowMs))
  list.replaceChildren(...blocks, ...lines)
  if (card && !blocks.length && !lines.length && none) {
    const empty = document.createElement('p')
    empty.className = 'dash-focus-none'
    empty.textContent = 'Nothing waiting on you.'
    list.appendChild(empty)
  }
  const section = list.closest('section')
  setHidden(section, !list.childElementCount)
  setText(section.querySelector('.sp-asks-count'), blocks.length ? String(blocks.length) : '')
  if (!bookmark || !document.hasFocus()) return
  const all = [...list.querySelectorAll('[data-panel-ask]')]
  const block = all.find((el) => el.dataset.panelAsk === bookmark.id)
  if (!block) {
    // its ask is answered or gone: the next one, else the panel's title
    ;(all[Math.min(index, all.length - 1)] ?? aside.querySelector('#dashFocusTitle'))?.focus({ preventScroll: true })
    return
  }
  const matches = bookmark.key ? cardFocusTargets(block).filter((target) => cardFocusKey(target) === bookmark.key) : []
  const target = matches[bookmark.ordinal] ?? block
  target.focus({ preventScroll: true })
  if (target instanceof HTMLTextAreaElement) target.setSelectionRange(target.value.length, target.value.length)
}

function panelAskEl(entry, nowMs) {
  const id = needsEntryId(entry)
  const ask = entryEntity(entry)
  const owner = entry.kind === 'row' ? entry.board : entry.item
  const m = rowModel(entry, { lastVisitAt })
  const block = document.createElement('article')
  block.className = 'sp-ask'
  block.dataset.panelAsk = id
  block.tabIndex = -1
  block.setAttribute('aria-label', `${m.title}. ${m.ownerLabel}.`)
  const asked = askTimeModel(m.askedAt, nowMs)
  block.innerHTML = `
    <div class="sp-ask-meta">
      <span class="nrow-owner owner-${esc(m.actionCategory)}">${esc(m.ownerLabel)}</span>
      <span>${entry.kind === 'row' ? 'Plan step' : isOpenHandoff(entry.item) ? 'Hand-off' : 'Question'}</span>
      ${asked ? `<time data-asked="${esc(m.askedAt)}" datetime="${esc(asked.datetime)}" title="${esc(asked.exact)}">${esc(asked.text)}</time>` : ''}
      ${entry.liveness === 'waiting' ? '<span class="sp-ask-waiting" title="The agent that asked is live and waiting on your answer">the agent is waiting</span>' : ''}
    </div>
    <div class="sp-ask-title" title="${esc(m.originalTitle)}">${esc(m.title)}</div>
    ${m.secondary ? `<div class="sp-ask-tldr">${esc(m.secondary)}</div>` : ''}
    ${cardLinksHtml(ask, owner)}`
  bindContextDisclosures(block)
  if (entry.kind === 'item' && isOpenHandoff(entry.item)) {
    // issue #612: a hand-off has nothing to answer; Snooze, Pin and Open sit below
    const ack = document.createElement('div')
    ack.className = 'reply-row'
    ack.appendChild(btn('Acknowledge', () => act(entry.item.id, 'acknowledge')))
    block.appendChild(ack)
  } else {
    block.appendChild(entry.kind === 'row'
      ? rowAnswerEl(entry.board, entry.row, null, { surface: 'compact' })
      : answerEl(entry.item, { surface: 'compact' }))
  }
  const actions = document.createElement('div')
  actions.className = 'sp-ask-actions'
  actions.appendChild(askIconButton('snooze', 'Snooze 4h', 'Snooze for 4 hours',
    () => snoozeAsk(entry, new Date(Date.now() + ASK_SNOOZE_MS).toISOString())))
  if (pinOffered(ask, entry.kind)) {
    actions.appendChild(askIconButton('pin', 'Pin', 'Pin for later: it waits in Later until you bring it back', () => pinAsk(entry)))
  }
  actions.appendChild(askIconButton('open', 'Open ask', 'Open ask', () => openAskInInbox(entry)))
  block.appendChild(actions)
  return block
}

// An answer this session has not picked up yet: one dimmed line, never counted.
function panelAnsweredEl(entry, nowMs) {
  const ask = entryEntity(entry)
  const words = entry.kind === 'item'
    ? ask.reply || (ask.reply_kind === 'decline' ? 'Declined' : ask.reply_kind === 'clarify' ? 'Asked to clarify' : '')
    : ask.annotation || (ask.handled_at ? 'I’ve done my part' : '')
  const at = Date.parse((entry.kind === 'item' ? ask.replied_at : ask.annotated_at ?? ask.handled_at) ?? '')
  const line = document.createElement('p')
  line.className = 'sp-answered'
  line.dataset.panelAnswered = needsEntryId(entry)
  const tag = document.createElement('span')
  tag.className = 'sp-answered-tag'
  tag.textContent = 'Answered'
  const title = document.createElement('span')
  title.className = 'sp-answered-title'
  title.textContent = dashboardEntryTitle(entry) ?? ''
  const rest = document.createElement('span')
  rest.textContent = [words ? `“${words}”` : '', Number.isFinite(at) ? `${ageText(nowMs - at)} ago` : '', 'not picked up yet']
    .filter(Boolean).join(' · ')
  line.append(tag, title, rest)
  return line
}

// The panel follows a drafted ask only when its own card has VANISHED (its
// session ended, or its only ask moved) and another card holds that ask: the
// held section stays, rebuilding nothing, now under the key of the card that
// holds that ask. While the panel's card exists it never moves, whatever its
// asks do (two working sessions trade a joined plan's row on every call), and
// focus elsewhere in the panel (the composer) keeps it where it is.
function followHeldAsk(aside) {
  const list = aside.querySelector('.dash-focus-asks')
  if (!list || !focusSession || list.dataset.panel !== focusSession) return
  if (agentsHome.cardFor(focusSession)) return
  const blocks = [...list.querySelectorAll('[data-panel-ask]')].filter((el) => holdsDraft(el.dataset.panelAsk))
  if (!blocks.length) return
  const active = document.activeElement
  if (active && aside.contains(active) && !blocks.some((el) => el.contains(active))) return
  const key = blocks.map((el) => agentsHome.askKey(el.dataset.panelAsk)).find(Boolean)
  if (!key || key === focusSession) return
  focusSession = key
  list.dataset.panel = key
  const open = agentsHome.cardFor(key)?.id ?? null
  for (const el of document.querySelectorAll('#dashboard [data-session-card]')) el.classList.toggle('sel', el.dataset.sessionCard === open)
}

function renderDashFocus(aside, model, { forced = false } = {}) {
  if (!aside) return
  setHidden(aside, !focusSession)
  if (!focusSession) {
    launchUi?.paintPanel(aside, null, Date.now())
    // a closed panel keeps no editor; its drafts stay in draftReplies/rowDrafts
    paintPanelAsks(aside, null, { forced })
    return
  }
  if (!forced) followHeldAsk(aside)
  setAttr(aside, 'data-session', focusSession)
  const card = agentsHome.cardFor(focusSession)
  setAttr(aside, 'data-card', card?.id ?? '')
  // the launch's parts: action bar, worktree, transcript and Resume and send (none off, §9)
  launchUi?.paintPanel(aside, launchesOn() ? card?.launch?.id ?? null : null, Date.now())
  const resuming = !aside.querySelector('.sp-resume').hidden
  // #411: a listed session can be messaged whether or not it is working now
  paintFocusComposer(aside, resuming ? null : card?.session ?? (activityRow(focusSession) ? focusSession : null))
  setHidden(aside.querySelector('.dash-focus-gone'), Boolean(card))
  for (const el of aside.querySelectorAll('.dash-focus-meta, .dash-focus-doing, .sp-state')) setHidden(el, !card)
  focusTargets.clear()
  if (!card) {
    setHidden(aside.querySelector('.dash-focus-detail'), true)
    setText(aside.querySelector('#dashFocusTitle'), 'Session')
    setHidden(aside.querySelector('.sp-hint'), true)
    for (const el of aside.querySelectorAll('.dash-focus-part > div:not(.dash-focus-asks)')) setFocusPart(aside, el, '')
    paintPanelAsks(aside, null, { forced })
    return
  }
  const state = aside.querySelector('.sp-state')
  setAttr(state, 'class', `sp-state tone-${card.state}`)
  setText(state, card.label)
  setText(aside.querySelector('#dashFocusTitle'), [card.project, card.branch].filter(Boolean).join(' · '))
  const build = card.row ? sessionBuild(card.row, liveVersion) : null
  setText(aside.querySelector('.dash-focus-meta'), [`${card.host} · ${card.origin}`, placeLine(card.row),
    card.launch && launchesOn() ? launchUi.panelSummary(card.launch) : card.recency, build?.label ?? ''].filter(Boolean).join(' · '))
  paintPlace(aside, card.row)
  const hint = aside.querySelector('.sp-hint')
  setText(hint, build?.older || build?.newer ? build.hint : '')
  setHidden(hint, !(build?.older || build?.newer))
  const doing = card.line
  setText(aside.querySelector('.dash-focus-doing'), doing)
  const detail = typeof card.row?.detail === 'string' ? card.row.detail : ''
  setText(aside.querySelector('.dash-focus-detail'), detail)
  setHidden(aside.querySelector('.dash-focus-detail'), !detail)
  // the card's asks, each once (sessions.js gives each ask one card), so the panel and the card agree
  const approvals = card.asks.filter((entry) => entry.kind === 'item' && isLaunchAskItem(entry.item))
  const others = card.asks.filter((entry) => !approvals.includes(entry))
  const oldest = approvals.reduce((min, entry) => Math.min(min, Date.parse(entry.item.created_at ?? '') || Infinity), Infinity)
  setText(aside.querySelector('.sp-approval-count'), approvals.length
    ? `${approvals.length} open${Number.isFinite(oldest) ? ` · ${ageText(Date.now() - oldest)}` : ''}` : '')
  setFocusPart(aside, aside.querySelector('.dash-focus-approval'),
    approvals.map((entry) => approvalHtml(entry, launchUi?.granted() === true)).join(''))
  paintPanelAsks(aside, card, { forced, asks: others, none: !approvals.length })
  setFocusPart(aside, aside.querySelector('.dash-focus-children'), card.base === 'working' && card.children.length
    ? `<ul class="sp-children">${card.children.map((child) => `<li><strong>${esc(child.name)}</strong>${child.doing ? ` <span>${esc(child.doing)}</span>` : ''}` +
      `${child.state ? ` <small class="sp-child-state">${esc(child.state)}</small>` : ''}</li>`).join('')}</ul>`
    : '')
  // #307's context, read from the card's session and plan
  const focus = sessionFocus({ session: card.session ?? card.sessions[0] ?? '', plan: card.plan }, {
    items: allItems(visibleData.g), boards: visibleData.boards, outcomes: model.outcomeEntries,
  })
  const plan = card.plan
  setFocusPart(aside, aside.querySelector('.dash-focus-planbox'), plan
    ? `<div class="dash-focus-plan"><span class="dash-focus-plan-title">${esc(plan.title)}</span> <span class="dash-focus-plan-count">${plan.done}/${plan.countable} done</span></div>` +
      focusButton(`plan:${plan.id}`, 'Open plan', () => focusItem(plan.id), { className: 'dash-focus-plan-open' })
    : card.launch ? '' : '<p class="dash-focus-none">No plan linked to this session.</p>')
  setFocusPart(aside, aside.querySelector('.dash-focus-outcomes'), focus.outcomes.map((entry) => {
    const id = needsEntryId(entry)
    focusTargets.set(`outcome:${id}`, () => (entry.kind === 'item' ? focusItem(entry.item.id) : focusItem(entry.board.id, { rowId: entry.row.id })))
    return `<button type="button" class="dash-focus-outcome" data-focus-target="${esc(`outcome:${id}`)}" data-dashboard-focus-key="focus:outcome:${esc(id)}">` +
      `<strong>${esc(dashboardEntryTitle(entry) ?? 'Recorded outcome')}</strong><span>${esc(dashboardEntryEntity(entry)?.outcome ?? '')}</span></button>`
  }).join('') || (card.launch ? '' : '<p class="dash-focus-none">No recorded outcomes yet.</p>'))
  // PR and CI state is ambient (#30): drawn here, read by no attention surface.
  const source = focus.source
  setFocusPart(aside, aside.querySelector('.dash-focus-source'), source
    ? sourceChipsHtml(linkIndex, source, Date.now(), { ...sourceOptions(source, source), tabbable: true }) : '')
  const links = new Map()
  // #634: which item or row first linked each file, for Open a copy on this Mac in another Mac's Inbox
  const owners = new Map()
  const linked = [...card.asks.map((entry) => [dashboardEntryEntity(entry), entry.kind === 'row' ? entry.board : entry.item]),
    ...(focus.board ? [[focus.board, focus.board]] : [])]
  for (const [entity, identity] of linked) {
    for (const link of cardLinks(entity, identity, linkIndex)) {
      if (links.has(link.key)) continue
      links.set(link.key, link)
      owners.set(link.key, hubFileOwner(entity))
    }
  }
  const linksKey = `links:session:${card.id}`
  setFocusPart(aside, aside.querySelector('.dash-focus-links'), linkStripHtml([...links.values()], {
    key: linksKey, open: openContexts.has(linksKey), actions: linkFileActions(), copyFiles: fileLinksCopy(),
    hubFiles: hubFileChips((link) => owners.get(link.key) ?? null),
  }))
}

// #617: where the session runs. "Open in claude.ai" is an ordinary link, built by the one safe
// link builder from a pattern-checked Remote Control id, never from agent text. "Copy attach command"
// copies `tmux attach -t '=<desk>'`, built from a pattern-checked desk. A row with neither draws nothing.
// #617 PR 4b: "Open desk" before Copy attach command, only where the page offers it (the hub's page
// shown from another Mac), for a row with a desk; its sentence after a refusal sits beside it.
function paintPlace(aside, row) {
  const url = claudeSessionUrl(row)
  const command = attachCommand(row)
  const desk = deskOpen.available() ? deskSession(row) : ''
  setFocusPart(aside, aside.querySelector('.dash-focus-place'), [
    url ? textLinkHtml(url, 'Open in claude.ai', 'web') : '',
    desk ? focusButton('place:desk', OPEN_DESK, () => deskOpen.run(desk, aside.querySelector('.dash-focus-place-desk'), aside.querySelector('.dash-focus-place-desk-note')),
      { className: 'dash-focus-place-desk', attrs: ` title="${esc('Open this session’s tmux desk in your terminal')}" data-desk-session="${esc(desk)}"` }) : '',
    desk ? '<span class="dash-focus-place-desk-note desk-open-note" role="status" hidden></span>' : '',
    command ? focusButton('place:copy', 'Copy attach command', () => copyAttachCommand(aside, command), { className: 'dash-focus-place-copy' }) : '',
  ].join(''))
}

async function copyAttachCommand(aside, command) {
  const copied = await writeClipboard(document, command)
  const button = aside.querySelector('.dash-focus-place-copy')
  if (!button) return
  button.textContent = copied ? 'Copied ✓' : 'Copy failed'
  setTimeout(() => { if (button.isConnected) button.textContent = 'Copy attach command' }, 1500)
}

// The panel's message part: the session's composer and history, one node per
// session kept across paints, so a poll never replaces the text being typed.
function paintFocusComposer(aside, session) {
  const part = aside.querySelector('.dash-focus-message')
  const slot = part?.querySelector('.dash-focus-composer')
  if (!slot) return
  const listed = Boolean(session && activityRow(session))
  setHidden(part, !listed)
  if (!listed) return
  const el = composerEl('focus', session)
  if (slot.firstElementChild !== el) slot.replaceChildren(el)
  updateComposer(el)
}

function paintSessionFocus() {
  if (!lastDashModel) return
  renderDashFocus(focusPanelEl, lastDashModel)
  const open = agentsHome.cardFor(focusSession)?.id ?? null
  for (const el of document.querySelectorAll('#dashboard [data-session-card]')) el.classList.toggle('sel', el.dataset.sessionCard === open)
  placeFocusPanel()
}

// #454 A.3: under 1280px the panel opens after its card's row, spanning the
// cards' grid (one card a row below 900px, so inline under it), or after its
// Quiet row (dashboard lanes design §3.6); on a desktop, and with no card
// drawn, it sits in the split after the lanes, and at 1280px and wider an open
// one turns the split on, so it takes the column beside the lanes (syncSplit).
// An open panel never moves while it holds focus: moving a focused node drops
// the focus (the next paint after it leaves places it), unless the panel has
// been cut off (#463 review: a removed group took it along, or a fold hid it),
// when it goes home whatever held it.
const narrowPanel = window.matchMedia('(max-width: 1279px)')
const outOfSight = (el) => !el.isConnected || Boolean(el.parentElement?.closest('[hidden], details:not([open])'))
function placeFocusPanel(aside = focusPanelEl) {
  movePanel(aside)
  syncSplit(aside)
}
narrowPanel.addEventListener?.('change', () => placeFocusPanel())

// §3.6: the split is on only while the panel is shown, the window is 1280px or
// wider and the panel is the split's own (held inline by focus, it is not). The
// class flips here alone, and only a flip reads layout, so a poll or a switch
// between sessions reads none and moves nothing. A flip reflows the lanes to
// their new width, so the card the split is for is kept where it was on screen.
let splitCard = null // data-session-card of the card the open split is for: close's anchor
function syncSplit(aside) {
  if (!splitEl || !aside) return
  const open = !aside.hidden && !narrowPanel.matches && aside.parentElement === splitEl
  const shown = open ? agentsHome.cardFor(focusSession)?.id ?? null : null
  if (splitEl.classList.contains('open') === open) {
    if (open) splitCard = shown ?? splitCard
    return
  }
  const id = shown ?? splitCard
  const anchor = activeTab === 'dashboard' && id
    ? [...splitEl.querySelectorAll('.agents-home [data-session-card]')].find((el) => el.dataset.sessionCard === id && !outOfSight(el))
    : null
  keepOnScreen(anchor, () => splitEl.classList.toggle('open', open))
  splitCard = shown
}

// Run a change that reflows the page, then scroll by however far it moved el
// on screen, as restoreQueueView keeps the open Inbox row.
function keepOnScreen(el, change) {
  const before = el?.getBoundingClientRect().top
  change()
  if (before === undefined) return
  const delta = el.getBoundingClientRect().top - before
  if (Number.isFinite(delta) && Math.abs(delta) > 0.5) window.scrollBy(0, delta)
}

function movePanel(aside) {
  const home = document.querySelector('#dashboard .dash-split > .agents-home')
  if (!aside || !home) return
  const id = focusSession && narrowPanel.matches ? agentsHome.cardFor(focusSession)?.id ?? null : null
  const card = id ? [...home.querySelectorAll('[data-session-card]')].find((el) => el.dataset.sessionCard === id && !outOfSight(el)) : null
  const row = card ? [...card.parentElement.children].filter((el) => el.dataset.sessionCard && el.offsetTop === card.offsetTop) : []
  const anchor = row.at(-1) ?? home
  if (aside.previousElementSibling === anchor) return
  if (!outOfSight(aside) && !aside.hidden && aside.contains(document.activeElement)) return
  // a forced re-home keeps the focus (and caret) it held
  moveKeepingFocus(aside, () => anchor.after(aside))
}

// An element the human can see: no ancestor is hidden.
const isShown = (el) => Boolean(el) && !el.closest('[hidden]')

// Where an explicit open lands (#454): the part the human asked for.
function focusPanelPart(part, ask = null) {
  const aside = focusPanelEl
  if (!aside || aside.hidden) return
  if (part === 'message') {
    const input = aside.querySelector('.dash-focus-message:not([hidden]) textarea')
    if (input && !input.disabled) input.focus()
  } else if (part === 'resume') {
    const id = aside.querySelector('.sp-resume')?.dataset.launch
    if (id) launchUi?.focusResume(id)
  } else if (part === 'head') {
    document.getElementById('dashFocusTitle')?.focus({ preventScroll: true })
  } else if (part === 'approval') {
    // a landing spot, never an option: a stray Space or a held Enter must not answer it
    const heading = aside.querySelector('.sp-approval:not([hidden]) h3')
    heading?.setAttribute('tabindex', '-1')
    heading?.focus({ preventScroll: true })
  } else if (part === 'asks') {
    // the ask's block, a landing spot: never an option a stray Enter would press
    const blocks = [...aside.querySelectorAll('.dash-focus-asks [data-panel-ask]')]
    const block = blocks.find((el) => el.dataset.panelAsk === ask) ?? blocks[0]
    block?.scrollIntoView?.({ block: 'nearest' })
    block?.focus({ preventScroll: true })
  } else if (part === 'transcript') {
    const section = aside.querySelector('.sp-transcript:not([hidden])')
    section?.scrollIntoView?.({ block: 'nearest' })
    section?.querySelector('h3')?.setAttribute('tabindex', '-1')
    section?.querySelector('h3')?.focus({ preventScroll: true })
  }
}

function openSessionFocus(session, part = null, ask = null) {
  closeFrontAsk()
  focusSession = session
  // #197: the build hint follows an install made since
  refreshLiveVersion()
  // a launch outside the project and agent lens is scoped to its project, as jumpToSession does
  const scoped = session.startsWith('launch:') && scopeToLaunch(session.slice('launch:'.length))
  if (activeTab !== 'dashboard' || scoped) {
    selectTab('dashboard', { paint: false, open: false })
    forceRender()
  }
  paintSessionFocus()
  if (part) focusPanelPart(part, ask)
  else if (document.hasFocus()) document.getElementById('dashFocusTitle')?.focus({ preventScroll: true })
}

function closeSessionFocus() {
  const session = focusSession
  const card = agentsHome.cardFor(session)?.id
  // the heading of the lane its card is in, read before the panel lets go of it
  const title = agentsHome.laneTitle(session)
  const aside = focusPanelEl
  const owned = Boolean(aside?.contains(activeFocusElement()))
  focusSession = null
  paintSessionFocus()
  // "Message · draft" on the card the panel leaves
  agentsHome.repaint({ selected: null, forced: false, nowMs: Date.now() })
  // UX pass, slice 2: with the panel gone, the first waiting ask is in front again
  bringAskToFront({ fromPanel: true })
  if (!owned || !document.hasFocus()) return
  const own = [...document.querySelectorAll('#dashboard [data-session-card]')].find((el) => el.dataset.sessionCard === card)
  ;[own?.querySelector('[data-ah-action]'), title]
    .find(isShown)?.focus({ preventScroll: true })
}

// A trusted click outside the panel that is not on a card or a Quiet row (each
// toggles it itself) closes it, moving no focus. A click, never a pointerdown: it fires
// once the press has completed on one element, so nothing moves under the
// pointer mid-press. At 1280px and wider the panel is the split's sticky
// column (§3.6), so an outside click closes it, and syncSplit keeps the card
// it was for in place while the lanes widen back. Inline (static: the compact
// layout, or held inline by focus) it is part of the page, with its own close
// and Esc, so an outside click never closes it there: the cards below it would
// jump up under the press.
// A row opened on a wide window closes the session panel as closeSessionFocus
// does, moving no focus into the lanes (one thing in front).
function closeSessionPanelQuietly() {
  focusSession = null
  paintSessionFocus()
  agentsHome.repaint({ selected: null, forced: false, nowMs: Date.now() })
}

function closeSessionFocusOnClick(event) {
  if (!focusSession || !trustedInput(event) || !(event.target instanceof Element)) return
  if (event.target.closest('#dashboard .dash-focus, #dashboard [data-session-card]')) return
  const aside = focusPanelEl
  if (!aside || getComputedStyle(aside).position === 'static') return
  focusSession = null
  paintSessionFocus()
}
document.addEventListener('click', closeSessionFocusOnClick, true)

function toggleSessionFocus(session) {
  if (focusSession === session) closeSessionFocus()
  else openSessionFocus(session)
}

// "Jump to session…" (#307): the Dashboard, scoped to the session's project as
// a deep link scopes to its item's, with that session's panel open.
function jumpToSession(session) {
  const row = (lastData?.activity ?? []).find((candidate) => candidate.session === session)
  if (!row) return false
  projectFilter = row.project
  agentFilter = null
  closeFrontAsk()
  focusSession = session
  resetSearch()
  selectTab('dashboard', { paint: false, open: false })
  forceRender()
  // An explicit entry point (#184). Defensive: ⌘K lists results only once the
  // older history is read, so it finds nothing omitted on the path that exists.
  requestHistoryPaint()
  if (document.hasFocus()) document.getElementById('dashFocusTitle')?.focus({ preventScroll: true })
  return true
}

function formatDuration(ms) {
  const totalMinutes = Math.round(ms / 60000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (!hours) return `${minutes}m`
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`
}

// ── the Today ribbon (#305, proposal §4) ─────────────────────────────────────
// One thin swimlane per project over the range menu's span: work from
// /api/activity/history, a static striped tail for work happening now, ◆ where
// an agent asked you and ● where an outcome landed. The structure is mounted
// once; a lane's track is redrawn only when its geometry changes, and nothing
// in it animates (#304's rule: no infinite animation for activity).
const RIBBON_DEFAULT_MS = 86400000
const RIBBON_RANGES = new Map([
  [RIBBON_DEFAULT_MS, ['Today', '24h ago']],
  [604800000, ['Last 7 days', '7d ago']],
  [2592000000, ['Last 30 days', '30d ago']],
])

// Issue #392: only a range the human picked past the default reads what the
// page omits. At 24 hours the ribbon keeps #305's cut-off note and reads
// nothing more, as before.
function ribbonReadsOlder() {
  return dashboardRangeMs > RIBBON_DEFAULT_MS
}

function ribbonRangeWait(model) {
  return ribbonReadsOlder() ? ribbonWait(model.marks, Date.now() - dashboardRangeMs) : { history: false, archived: false }
}

function lensSpans(history) {
  return (history?.spans ?? []).filter((span) =>
    !dashboardClosedSet().has(span.project)
    && (!projectFilter || span.project === projectFilter)
    && (!agentFilter || span.agent === agentFilter))
}

function dashboardHistory() {
  return lastData.activityHistory ?? { state: 'ready', spans: [], message: '' }
}

const laterOf = (a, b) => (Date.parse(a) > Date.parse(b) || !b ? a : b) || null

function ribbonTime(iso) {
  const options = dashboardRangeMs > RIBBON_DEFAULT_MS
    ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { hour: 'numeric', minute: '2-digit' }
  return new Date(iso).toLocaleString(undefined, options)
}

function dashRibbonEl() {
  const panel = document.createElement('section')
  panel.className = 'dashboard-card dashboard-activity'
  panel.innerHTML = `
    <div class="dashboard-card-head"><h2 class="dash-ribbon-title"></h2></div>
    <div class="dashboard-activity-total"><strong></strong><span class="dash-ribbon-legend" aria-hidden="true"><span class="dash-ribbon-key now"></span>now <span class="dash-ribbon-key-ask">◆</span> asked you <span class="dash-ribbon-key-outcome">●</span> landed</span></div>
    <div class="dash-ribbon"></div>
    <div class="dash-ribbon-axis"><span class="dash-ribbon-from" aria-hidden="true"></span><span class="dash-ribbon-note"></span><span aria-hidden="true">now</span></div>
    <div class="dash-ribbon-more" hidden></div>`
  const range = document.createElement('select')
  range.className = 'dashboard-range'
  range.dataset.dashboardFocusKey = 'activity-range'
  range.setAttribute('aria-label', 'Home activity range')
  for (const [value, [label]] of RIBBON_RANGES) {
    const option = document.createElement('option')
    option.textContent = label === 'Today' ? '24 hours' : label.replace('Last ', '')
    option.value = String(value)
    range.appendChild(option)
  }
  range.value = String(dashboardRangeMs)
  range.addEventListener('change', () => {
    dashboardRangeMs = Number(range.value)
    forceRender()
    // The human's own change is the only path that reads what a longer range
    // needs (#392); the poll keeps it while historyWanted/archivedWanted say so.
    requestHistoryPaint()
  })
  panel.querySelector('.dashboard-card-head').appendChild(range)
  return panel
}

function renderDashRibbon(panel, model) {
  if (!panel) return
  const [title, from] = RIBBON_RANGES.get(dashboardRangeMs) ?? RIBBON_RANGES.get(RIBBON_DEFAULT_MS)
  setText(panel.querySelector('.dash-ribbon-title'), title)
  const history = dashboardHistory()
  const endMs = Date.now()
  const ribbon = buildRibbon({
    spans: history.state === 'ready' ? lensSpans(history) : [],
    asks: model.marks.asks,
    outcomes: model.marks.outcomes,
    startMs: endMs - dashboardRangeMs,
    endMs,
    marksAfter: laterOf(model.marks.asksAfter, model.marks.outcomesAfter),
  })
  const failed = history.state === 'error'
  const empty = !failed && !ribbon.lanes.length
  // The error and empty states hold no control, so they come and go whole.
  let notice = panel.querySelector('.dashboard-history-empty')
  const kind = failed ? 'error' : empty ? 'empty' : null
  if (notice && notice.dataset.kind !== kind) { notice.remove(); notice = null }
  if (kind && !notice) {
    notice = document.createElement('div')
    notice.dataset.kind = kind
    if (failed) {
      notice.className = 'dashboard-history-empty dashboard-history-error'
      notice.innerHTML = '<strong>History unavailable</strong>'
    } else {
      notice.className = 'dashboard-history-empty'
      notice.setAttribute('role', 'img')
      notice.setAttribute('aria-label', 'No activity history yet')
      notice.title = 'No activity history yet'
      notice.innerHTML = '<svg class="dashboard-empty-icon" viewBox="0 0 32 20" aria-hidden="true"><path d="M1 15h5l3-9 5 12 4-8 3 5h10"></path></svg>'
    }
    panel.querySelector('.dashboard-card-head').after(notice)
  }
  if (failed) setAttr(notice, 'title', history.message ?? '')
  panel.classList.toggle('is-empty', Boolean(kind))
  for (const part of ['.dashboard-activity-total', '.dash-ribbon', '.dash-ribbon-axis']) setHidden(panel.querySelector(part), Boolean(kind))
  setText(panel.querySelector('.dashboard-activity-total strong'), formatDuration(ribbon.totalMs))
  setText(panel.querySelector('.dash-ribbon-from'), from)
  // Read aloud too: the axis labels are hidden from assistive tech, the note is not.
  // A read the range waits on that failed says so beside the note (#392).
  const wait = ribbonRangeWait(model)
  const unavailable = [
    wait.history && lastData?.olderError ? OLDER_HISTORY_UNAVAILABLE : '',
    wait.archived && lastData?.archivedError ? ARCHIVED_UNAVAILABLE : '',
  ].filter(Boolean)
  setText(panel.querySelector('.dash-ribbon-note'), ribbon.marksFromAt == null ? ''
    : [`Asks and outcomes from ${ribbonTime(ribbon.marksFromAt)}`, ...unavailable].join(' · '))
  const more = panel.querySelector('.dash-ribbon-more')
  setText(more, ribbon.more > 0 ? `+${plural(ribbon.more, 'more project')}` : '')
  setHidden(more, Boolean(kind) || ribbon.more <= 0)
  const list = panel.querySelector('.dash-ribbon')
  const existing = new Map([...list.children].map((el) => [el.dataset.ribbonProject, el]))
  const nodes = (kind ? [] : ribbon.lanes).map((lane) => {
    let el = existing.get(lane.project)
    existing.delete(lane.project)
    if (!el) {
      el = document.createElement('div')
      el.className = 'dash-ribbon-lane'
      el.dataset.ribbonProject = lane.project
      el.setAttribute('role', 'img')
      el.innerHTML = '<span class="dash-ribbon-name"></span><span class="dash-ribbon-track"></span>'
    }
    updateRibbonLane(el, lane)
    return el
  })
  for (const el of existing.values()) el.remove()
  nodes.forEach((el, index) => {
    if (list.children[index] !== el) list.insertBefore(el, list.children[index] ?? null)
  })
}

function updateRibbonLane(el, lane) {
  const color = pcolor(lane.project).dot
  if (el.style.getPropertyValue('--lane-color') !== color) el.style.setProperty('--lane-color', color)
  setText(el.querySelector('.dash-ribbon-name'), lane.project)
  setAttr(el, 'aria-label', [
    `${lane.project}: ${formatDuration(lane.workMs)} of work`,
    lane.live ? 'working now' : '',
    lane.asks ? `${plural(lane.asks, 'ask')}${lane.openAsks ? ` (${lane.openAsks} open)` : ''}` : '',
    lane.outcomes ? plural(lane.outcomes, 'outcome') : '',
  ].filter(Boolean).join(', '))
  // The track is rebuilt only when its shape changes (bars, which are live,
  // which markers); positions and tooltips move in place, so a live bar that
  // grows with the clock keeps its node (#305 review).
  const track = el.querySelector('.dash-ribbon-track')
  const shape = JSON.stringify([lane.bars.map((bar) => bar.liveFrom != null), lane.marks.map((mark) => [mark.kind, mark.key, mark.open])])
  if (track.dataset.key !== shape) {
    track.dataset.key = shape
    track.innerHTML = [
      ...lane.bars.map((bar) => `<span class="dash-ribbon-bar${bar.liveFrom != null ? ' live' : ''}"></span>`),
      ...lane.marks.map((mark) => `<span class="dash-ribbon-mark ${mark.kind}${mark.open ? ' open' : ''}">${mark.kind === 'ask' ? '◆' : '●'}</span>`),
    ].join('')
  }
  const nodes = track.children
  lane.bars.forEach((bar, index) => {
    const live = bar.liveFrom != null
    setAttr(nodes[index], 'style', `left:${bar.left}%;width:${bar.width}%${live ? `;--live-from:${bar.liveFrom}%` : ''}`)
    setAttr(nodes[index], 'title', `${ribbonTime(bar.from)}–${live ? 'now (working)' : ribbonTime(bar.to)}`)
  })
  lane.marks.forEach((mark, index) => {
    const node = nodes[lane.bars.length + index]
    setAttr(node, 'style', `left:${mark.left}%`)
    setAttr(node, 'title', `${mark.kind === 'ask' ? (mark.open ? 'Asking you' : 'Asked you') : 'Landed'}: ${mark.title} · ${ribbonTime(mark.at)}`)
  })
}

// "Since you last looked" (#305, §14): one line about the time between the
// previous visit and this one, only after a gap.
function renderDashSince(el, model) {
  if (!el) return
  const history = dashboardHistory()
  const text = sinceLastLooked({
    sinceMs: Date.parse(lastVisitAt ?? ''),
    untilMs: visitAt,
    asks: model.marks.asks,
    outcomes: model.marks.outcomes,
    asksAfter: model.marks.asksAfter,
    outcomesAfter: model.marks.outcomesAfter,
    spans: history.state === 'ready' ? lensSpans(history) : null,
  })
  setText(el, text ? `Since you last looked: ${text}` : '')
  setAttr(el, 'title', lastVisitAt ? `Since ${new Date(lastVisitAt).toLocaleString()}` : '')
  setHidden(el, !text || sinceSeen)
}

// The line is about the time before this visit, so it goes once the human has
// looked: their first click or key press anywhere in the window while it shows
// on the Dashboard. Input only reaches a window the human is using, so a
// background window they never looked at keeps it. Only the human's own input
// counts (a scripted event is not them), and reading the line does not: a click
// on it, a shortcut such as ⌘C or ⌘-Tab, or any key while it is selected.
let sinceSeen = false
let sinceEl = null
function dismissSince(event) {
  const el = sinceEl
  if (sinceSeen || activeTab !== 'dashboard' || !el?.isConnected || el.hidden) return
  if (!trustedInput(event) || sinceKeepsOn(event, el, document.getSelection())) return
  sinceSeen = true
  el.hidden = true
}
document.addEventListener('pointerdown', dismissSince, true)
document.addEventListener('keydown', dismissSince, true)

// Just landed (#305): an outcome newer than anything drawn before gets one
// arrival highlight, under the same gate as the lanes' pulse. The first paint
// only seeds what is already there.
let landedSeen = null
let landedHigh = -Infinity

function markLanded(rows, entries) {
  const animate = dashboardMotion()
  const seen = landedSeen ?? new Set()
  let high = landedHigh
  entries.forEach((entry, index) => {
    const key = rows[index].dataset.dashboardFocusKey
    const at = stamp(entry.kind === 'item' ? entry.item : entry.row)
    if (landedSeen && animate && !seen.has(key) && at > landedHigh) playOnce(rows[index], 'arrived', 'dash-landed-arrive')
    seen.add(key)
    high = Math.max(high, at)
  })
  landedSeen = seen
  landedHigh = high
}

function renderDashboardOutcomes(list, entries, complete = true, wait = { history: true, archived: false }, hidden = 0) {
  // Issues #184 and #299: outcomes the page or the archived brief omits may
  // still outrank what is listed.
  if (complete) list.removeAttribute('aria-busy')
  else list.setAttribute('aria-busy', 'true')
  // #305: proven outcomes left out because their open PR still waits on you.
  const waiting = list.parentElement?.querySelector('.dash-landed-waiting')
  if (waiting) {
    setText(waiting, hidden ? `${hidden} on ${hidden === 1 ? 'a PR' : 'PRs'} still waiting on you` : '')
    setHidden(waiting, !hidden)
  }
  const existing = new Map([...list.querySelectorAll('.dashboard-outcome')]
    .map((row) => [row.dataset.dashboardFocusKey, row]))
  const active = activeFocusElement()?.closest?.('.dashboard-outcome')
  const focused = active && list.contains(active) ? active : null
  const focusedIndex = focused ? [...list.children].indexOf(focused) : -1
  const rows = entries.slice(0, 4).map((entry) => {
    const key = `outcome:${entry.kind === 'item' ? entry.item.id : entry.row.id}`
    let row = existing.get(key)
    if (!row) {
      row = document.createElement('button')
      row.type = 'button'
      row.className = 'dashboard-outcome'
      row.dataset.dashboardFocusKey = key
      row.append(document.createElement('strong'), document.createElement('span'), document.createElement('small'))
      row.addEventListener('click', () => {
        if (entry.kind === 'item') focusItem(entry.item.id)
        else focusItem(entry.board.id, { rowId: entry.row.id })
      })
    }
    row.querySelector('strong').textContent = dashboardEntryTitle(entry) ?? 'Recorded outcome'
    row.querySelector('span').textContent = dashboardEntryEntity(entry)?.outcome ?? ''
    row.querySelector('small').textContent = dashboardEntryProject(entry) ?? ''
    return row
  })
  markLanded(rows, entries.slice(0, 4))
  if (focused && rows.includes(focused)) {
    // Move the other rows around the focused button; detaching that button would
    // lose native keyboard ownership even if it were immediately reinserted.
    for (const child of [...list.children]) if (child !== focused) child.remove()
    const index = rows.indexOf(focused)
    focused.before(...rows.slice(0, index))
    focused.after(...rows.slice(index + 1))
  } else {
    list.replaceChildren(...rows)
    if (!rows.length && !(complete && hidden)) {
      list.innerHTML = complete
        ? '<div class="dashboard-empty" role="img" aria-label="No recorded outcomes" title="No recorded outcomes"><svg class="dashboard-empty-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"></circle><path d="m8 12 2.5 2.5L16 9"></path></svg></div>'
        : `<div class="dashboard-empty" role="status">${esc(omittedWaitText('Loading older outcomes…', wait))}</div>`
    }
    if (focused) {
      const next = rows[Math.min(focusedIndex, rows.length - 1)]
        ?? document.getElementById('dashLandedTitle')
      next?.focus({ preventScroll: true })
    }
  }
}

// #454 A.2: an Inbox row's session token, from the session the ask names (an
// item's, a plan's stamp): "live · <branch>" while it is listed, else "session
// ended". An ask naming no session has none.
function askSessionToken(entry) {
  const session = entry.kind === 'row' ? entry.board?.session : entry.item?.session
  if (!session) return null
  const row = activityRow(session)
  return row ? { live: true, text: ['live', row.stream].filter(Boolean).join(' · ') } : { live: false, text: 'session ended' }
}

// ── an ask's icons (#303's, the session panel's since #454) ─────────────────
const ASK_SNOOZE_MS = 4 * 60 * 60_000

const ASK_ICONS = {
  snooze: '<circle cx="8" cy="8" r="6"></circle><path d="M8 4.5V8l2.5 1.5"></path>',
  pin: '<path d="M6 2h4l-.5 4 2.5 2.5H4L6.5 6 6 2zM8 8.5V14"></path>',
  open: '<path d="M9 3h4v4M13 3 7 9M11 9.5V13H3V5h3.5"></path>',
}

function askIconButton(action, label, title, onClick) {
  const button = btn('', onClick)
  button.type = 'button'
  button.className = `ask-icon ask-icon-${action}`
  button.dataset.askAction = action
  button.title = title
  button.setAttribute('aria-label', title)
  button.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${ASK_ICONS[action]}</svg><span>${esc(label)}</span>`
  return button
}

// Open the ask's own card in the Inbox, as a deep link does.
function openAskInInbox(entry) {
  if (entry.kind === 'item') {
    focusItem(entry.item.id)
    return
  }
  const id = entry.row.id
  projectFilter = entry.board.project
  agentFilter = null
  actionFilter = 'all'
  changedOnly = false
  resetSearch()
  selectTab('dashboard', { paint: false })
  // a protected id, so the first page always holds it, however far down the list sorts it
  selectedId = id
  forceRender()
  const target = needsYouRowEl(id)
  if (!target) return
  revealDetailsAncestors(target)
  selectRow(id)
  setOpenRow(id)
  forceRender()
}

function renderDashboard(model) {
  const host = document.querySelector('#dashboard .dashboard')
  // Keep native controls mounted; ambient updates replace only their data regions.
  if (!host || host.querySelector('.dashboard-grid')) return

  const since = document.createElement('p')
  since.className = 'dash-since'
  since.hidden = true
  host.appendChild(since)
  sinceEl = since
  // New session… at the right end of the Working lane's head, its note directly after that head
  const start = agentsHome.newSessionElements()
  const workingHead = agentsHome.element().querySelector('.working-lane > .ah-lane-head')
  workingHead?.append(start.button)
  workingHead?.after(start.note)

  const grid = document.createElement('div')
  grid.className = 'dashboard-grid'
  // #454, dashboard lanes design §3.3–3.4, §3.6: the Working and Quiet lanes and
  // the session panel share one split, so the panel is never inside a card that
  // could hide it: beside the lanes on a desktop, after its card's row or its
  // Quiet row on a narrow screen (placeFocusPanel).
  const split = document.createElement('div')
  split.className = 'dash-split'
  split.append(agentsHome.element(), dashFocusEl())
  splitEl = split
  grid.appendChild(split)
  // §3.5: then Plans in progress, Just landed and Today, each a full-width lane, the ribbon
  // last; DOM order is the page's order, so Tab follows it with no CSS order
  grid.appendChild(plansLane.element())

  const outcomes = document.createElement('section')
  outcomes.className = 'dashboard-card dashboard-outcomes'
  outcomes.innerHTML = '<div class="dashboard-card-head"><h2 id="dashLandedTitle" tabindex="-1">Just landed</h2></div>'
  const outcomeList = document.createElement('div')
  outcomeList.className = 'dashboard-outcome-list'
  outcomes.appendChild(outcomeList)
  const waiting = document.createElement('p')
  waiting.className = 'dash-landed-waiting'
  waiting.hidden = true
  outcomes.appendChild(waiting)
  grid.appendChild(outcomes)
  grid.appendChild(dashRibbonEl())

  host.appendChild(grid)
  renderDashboardAmbient(model, { forced: true })
}

// True only while render() paints a frame the human asked for (forceRender):
// the session panel's asks rebuild then even while they hold a draft (#303, #454).
let forcedAmbient = false

function paintAmbient() {
  applyBadge()
  // issue #30 — rebuilt ONCE here, before any renderer runs, so the row chips,
  // the card blocks and the board chips all read the same snapshot. It feeds
  // nothing in applyBadge / attentionCount on purpose: PR state is ambient, and
  // a red CI must never move the badge (tenets 1 and 2).
  linkIndex = indexLinks(lastData.links ?? [])
  // issue #103 PR3 — the same frame's sub-issue view. Its activity labels READ
  // the attention set; nothing here reaches applyBadge, a count or the dock.
  issueView = buildIssueView(lastData.issues, {
    items: allItems(lastData.g),
    boards: lastData.boards,
    archived: lastData.archived,
    links: linkIndex,
    attention: attentionEntries(allItems(lastData.g), lastData.boards, Date.now(), liveSessionIds(), lastData.closed ?? []),
    nowMs: Date.now(),
  })
  renderRail()
  // AFTER renderRail: renderRail is what reconciles a stale projectFilter, and
  // withoutClosed reads projectFilter to decide whether this is a peek.
  visibleData = withoutClosed(lastData)
  // Agents whose only items are closed history the page omitted stay selectable.
  const agents = collectAgents(projectScoped(visibleData),
    olderHistory(lastData.older, { project: projectFilter, hidden: dashboardClosedProjects() }).agents)
  if (agentFilter && !agents.includes(agentFilter)) agentFilter = null
  const filtered = filterData(visibleData)
  const { g, boards, archived } = filtered
  const live = liveInLens()
  const dashboard = dashboardModel(filtered, lastData.older, live)
  renderSessionsIndicator(lastData.activity) // the sidebar's Sessions line — GLOBAL, never scoped (§7 filter-blindness, generalized)
  // #411: a message the snapshot now holds was sent; one whose session left
  // goes to the unsent responses. Then the Dashboard, whose panel holds a composer.
  reconcileMessageDrafts()
  renderDashboardAmbient(dashboard, { forced: forcedAmbient })
  // the Agent cards tab: its grid, or the open agent's page (global: no lens narrows it, and
  // nothing it draws reaches attention)
  paintAgentCards()
  paintTabCounts(g, boards)
  paintQueueCount(g, boards)
  paintLaterSectionHint()
  // #407: a poll held back by a draft, a press or a scroll still ends a stale
  // hold line; it writes in place and builds the deck only while held
  paintTriageHold()
  return { agents, g, boards, archived, live, dashboard }
}

// The Working and Quiet lanes' input (#397, #454): the sessions the
// rail's project and agent lens shows, never narrowed by closure (closed
// projects' sessions have a fold of their own).
function liveInLens() {
  return (lastData.activity ?? []).filter((a) =>
    (!projectFilter || a.project === projectFilter) && (!agentFilter || a.agent === agentFilter))
}

// This app's launches under the same lens: every one runs Copilot.
const launchInLens = (launch) => (!projectFilter || launch.project === projectFilter) && (!agentFilter || agentFilter === 'copilot')
function launchesInLens() {
  return (lastData?.launches ?? []).filter(launchInLens)
}

// The launches the lens hides that still run or can resume: the Working lane says so (#454).
function launchesOutsideLens() {
  return (lastData?.launches ?? []).filter((launch) => launch.status !== 'ended' && !launchInLens(launch)).length
}

// A launch outside the lens has no card to show it: scope the lens to its project,
// as jumpToSession does. Returns whether it changed the lens; the caller paints.
function scopeToLaunch(id) {
  const launch = (lastData?.launches ?? []).find((l) => l.id === id)
  if (!launch || launchInLens(launch)) return false
  projectFilter = launch.project
  agentFilter = null
  return true
}

// `summary` is what `view` omits from closed history (issue #184), and archived
// plans in brief carry what they omit themselves (#299): omitted outcomes still
// count, and listed recent outcomes are only those nothing omitted could outrank.
function dashboardModel({ g, boards, archived }, summary, activity) {
  return buildDashboard({
    items: allItems(g),
    boards,
    archived,
    activity,
    nowMs: Date.now(),
    liveSessionIds: liveSessionIds(),
    closedProjects: dashboardClosedProjects(),
    history: { older: olderHistory(summary, olderLens()), archived: omittedOutcomes(archived), before: summary?.before ?? null },
    links: linkIndex,
  })
}

function paintTabCounts(g, boards) {
  // Needs-you counts the GLOBAL attention set; every other tab counts the
  // filtered view the user is actually looking at (spec §7).
  const counts = tabCounts({
    globalAttention: attentionCount(allItems(lastData.g), lastData.boards, Date.now(), liveSessionIds(), lastData.closed ?? []),
    unreadNotes: unreadNoteCount(g.notes.flatMap((gr) => gr.items), notesSeenAt, Date.now(), notesSeenIds),
    scoped: { boards },
  })
  for (const id of TAB_IDS) setCount(id, counts[id])
}

function paintEditableSurfaces({ agents, g, boards, archived, dashboard, paintAllPanes }) {
  renderSearchResults()
  renderClosedBanner()
  renderAgentSelect(agents)
  renderDashboard(dashboard)
  // Keep the action/recovery queue and overlays current. Only inactive document
  // panes skip ordinary polls; boot and explicit human repaints remain complete.
  const restoreQueueView = renderNeedsYou(g, boards, Date.now())
  if (paintAllPanes || !document.getElementById('find').hidden) renderFind()
  for (const board of boards) sessionActiveBoards.add(board.id)
  if (paintAllPanes || !document.getElementById('boards').hidden) renderBoards(boards, archived)
  // renderFind may have marked visible notes read. Recount only on a full
  // editable frame; a draft-gated ambient frame must never mark unseen notes.
  paintTabCounts(g, boards)
  // The render that just happened is the authority on what remains collapsible.
  // A deep link or filter can name a board, a hidden item, or a paged-away row;
  // reconcile stale open state now so it cannot leak into a later render.
  const nextOpen = reconcileOpenRow(openRowId, allRowEls().map((el) => el.dataset.cardId))
  // still through setOpenRow — it stays the single writer of openRowId
  if (nextOpen !== openRowId) setOpenRow(nextOpen, { resume: false })
  renderTriage() // keep the open lightbox in sync with fresh data
  renderRelay() // same entities, projected into human → agent → outcome lanes
  renderMission() // selected board, projected through explicit row next/outcome edges
  return restoreQueueView
}

// Everything a frame is painted from besides the clock (#298): the tick's reads,
// the closed set after this window's own project intents, and the lens. A lens
// change always paints through its own handler; it is here so a frame can never
// be reused across one.
//
// Much of this window's own state (drafts, folds, filters, staged actions,
// write failures) is changed by the human and painted by its own handler, but
// not always at once: a handler may leave the frame to the next poll, as the
// press and scroll guards do. So any human input, and any write settling, also
// counts as a change, and the next tick paints exactly as it did before #298.
// The state answered outside the poll by other reads (the build advice, whether
// file links open here) is named below, since it lands after the input that
// asked for it. Only a window nobody is using skips its frames.
function frameInputs() {
  return [
    ...lastData.reads, JSON.stringify(lastData.closed), navigationKey(), openRowId,
    focusSession, outsideChanges, liveVersion, fileLinksCopy(), Boolean(linkFileActions()), hubFiles.available(),
    triageHeld,
    // an ask held back while the lanes were in use comes forward on the tick after they no longer are
    frontWaitsOnLanes && (lanesHoldFocus() || lanesUnderPointer()),
    agentsHome.state(),
    meshAgentPage.state(),
    meshSetup.state(),
    chatsView.state(),
    launchUi?.version() ?? null,
  ]
}

function noteOutsideChange() {
  outsideChanges += 1
}

// Capture phase on window, like the press guard, so nothing can stop it first.
// Hover and scrolling change nothing a frame shows: the scroll guards already
// mark a frame they hold back.
function initIdleFrame() {
  for (const type of ['pointerdown', 'click', 'keydown', 'input', 'change', 'focus', 'resize']) {
    window.addEventListener(type, noteOutsideChange, true)
  }
  document.addEventListener('visibilitychange', noteOutsideChange)
  // #563: what keeps a draft, or a background window's remembered focus, holding a rebuild
  for (const type of ['pointerdown', 'click', 'keydown', 'input']) {
    window.addEventListener(type, () => { humanInputAt = Date.now() }, true)
  }
}

function render() {
  // A frame that throws part way is not a frame the poll may keep (#298).
  paintedFrame = null
  // A prepared frame belongs to the poll; explicit forceRender enters without one.
  const paintAllPanes = preparedFrame === null || !editablePanesPainted
  // The rebuild below detaches the nodes a text selection lives in (#223).
  const textSelection = preparedFrame ? preparedFrame.textSelection : captureSelection()
  forcedAmbient = preparedFrame === null
  let frame
  try {
    frame = preparedFrame ?? paintAmbient()
  } finally {
    forcedAmbient = false
  }
  // The lens this frame's data was filtered through (#298).
  const frameLens = navigationKey()
  frame.paintAllPanes = paintAllPanes
  preparedFrame = null
  const ownsFocus = document.hasFocus()
  const missionFocus = captureMissionFocus()
  const dashboardFocus = dashboardFocusBookmark()
  const draftFocus = ownsFocus ? activeDraftFocusBookmark() ?? requestedDraftFocusBookmark : null
  const pagedFocus = pagedCardFocusBookmark()
  // the Plans header's controls and the Stalled fold's are rebuilt with the list; keep a keyboard user on them
  const plansHeaderFocusId = activeFocusElement()?.closest?.('#boards .tab-header [id], #boards .stalled-fold [id], #plans-moving-more')?.id ?? null
  pagedFocusId = pagedFocus?.id ?? null
  // a rebuilt unsent response keeps the control a keyboard user is on (#321)
  const recoveryControl = activeFocusElement()?.closest?.('.stale-draft-line[data-recovery-line] button')
    ?? (activeFocusElement()?.matches?.('.stale-draft-line[data-recovery-line]') ? activeFocusElement() : null)
  draftRecoveryFocusControl = recoveryControl
    ? {
        line: recoveryControl.closest('.stale-draft-line').dataset.recoveryLine,
        // null: the line itself, as the Review queue's hold line focuses it (#407)
        label: recoveryControl.matches('button') ? recoveryControl.textContent : null,
      }
    : null
  if (activeFocusElement()?.closest?.('.stale-drafts-fold')) draftRecoveryFocusPending = true
  reconcileDraftOwners()
  requestedDraftFocusBookmark = null
  const hadFront = document.body.classList.contains('ask-front')
  const restoreQueueView = paintEditableSurfaces(frame)
  bringAskToFront({ steady: hadFront })
  pagedFocusId = null
  if (ownsFocus) {
    if (missionFocus && missionBoardId) {
      restoreMissionFocus(missionFocus)
    } else if (!restoreDashboardFocus(dashboardFocus)
      // a poll's frame never takes focus out of the lanes (it used to be held while focus was there)
      && !(pollPaint && lanesHoldFocus())
      && !restoreDraftRecoveryFocus() && !restoreDraftFocus(draftFocus) && !restorePagedCardFocus(pagedFocus)
      && plansHeaderFocusId) {
      restorePlansControlFocus(plansHeaderFocusId)
    }
  }
  applySearchJumpHighlight()
  invalidatePreviewLinks()
  keyboardUI?.refresh()
  restoreQueueView()
  restoreSelection(textSelection)
  syncAskFront()
  editablePanesPainted = true
  // Draft recovery may move navigationKey() part way (reconcileDraftOwners →
  // requestDraftRecovery): the panes then show data filtered for the old tab,
  // project or agent, so the poll must not keep this frame as if it were drawn
  // for the new one. An open-row move alone is fine: setOpenRow runs before the
  // panes paint, so they already show it.
  paintedFrame = navigationKey() === frameLens ? { inputs: frameInputs(), at: Date.now() } : null
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
const unconfirmedRowSends = new Map() // row id → text whose annotate POST has had no answer (#279)
// row id → { actionVersion, word, choice }: a notice with no draft to carry it, as
// after an option click the row refused (#636). A draft carries its own, in its meta.
const rowAskNotices = new Map()
// What the row says when its ask moved under a response (#636), by what moved:
// `send` while text waits in the editor, `choose` after a refused option click.
const ROW_ASK_SENTENCES = {
  edited: {
    send: 'This ask was edited while you were typing. Read it again, then send.',
    choose: 'This ask was edited while you were typing. Read it again, then choose.',
  },
  answered: {
    send: 'The response on this step changed before yours was sent. Read it, then send yours.',
    choose: 'The response on this step changed before yours was sent. Read it, then choose again.',
  },
  updated: {
    send: 'This step was updated while you were typing. Read it again, then send.',
    choose: 'This step was updated while you were typing. Read it again, then choose.',
  },
}
const rowAskSentence = (word, choice = false) => ROW_ASK_SENTENCES[word]?.[choice ? 'choose' : 'send'] ?? ''
const isRowAskSentence = (text) => Object.values(ROW_ASK_SENTENCES).some((pair) => text === pair.send || text === pair.choose)
const ROW_KEPT_CHANGING = 'This step kept changing, so nothing was sent. Try again.'
let requestedDraftFocusBookmark = null
let draftRecoveryFocusPending = false
let draftRecoveryFocusControl = null // { line, label } of the unsent-response control focused at the last rebuild
let draftRecoveryTarget = null

function rowDraftRecoveryKey(rowId, revision) {
  return JSON.stringify([rowId, revision])
}

// An option click a closed step could not take (#636) is its own entry, so it
// never takes the place of text kept for the same revision.
function rowChoiceRecoveryKey(rowId, revision) {
  return JSON.stringify([rowId, revision, 'choice'])
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

// #636: what the person reads of a row's ask (its status, words, options and
// outcome: the Outcome block changes the card's headline too), as a short hash. A draft keeps
// the signature of the ask it was typed under, so a later revision of the same
// action tells an edit to those words (case 2) from a write that left them
// alone (case 1). Hashed so the stored draft (#279) does not carry the words twice.
function rowAskSignature(r) {
  return textHash(JSON.stringify([
    r.status, r.note ?? '', r.next_step ?? '', r.action_owner ?? null, r.impact ?? '', r.next_after ?? '',
    r.context ?? '', r.outcome ?? '',
    (r.options ?? []).map((option) => [option.label, option.detail ?? '', Boolean(option.recommended)]),
  ]))
}

// The response the row holds: the human's words, their kind and the done mark.
function rowResponseSignature(r) {
  return textHash(JSON.stringify([r.annotation ?? '', r.annotation_kind ?? null, r.handled_at ?? null]))
}

// A 53-bit string hash (cyrb53), in base 36. Not for secrets: it only tells
// two texts apart.
function textHash(text) {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

// What a row draft remembers of the row it was typed on.
function rowDraftMetaFor(b, r) {
  return {
    revision: r.revision,
    actionVersion: r.action_version,
    ask: rowAskSignature(r),
    response: rowResponseSignature(r),
    boardTitle: b.title,
    label: r.label,
    context: r.context ?? '',
    boardId: b.id,
    boardRevision: b.revision,
    // typed for a step that asked something of the person, or for a note on one that did not
    blocked: r.status === 'blocked',
  }
}

// #636: what became of the ask a row draft was typed for (`typedFor`: its
// revision, actionVersion, ask and response signatures, and whether the step
// was blocked), against the row now. `held` ({ text, kind }) is the draft's own
// text, when the caller has it.
//   same     the same revision, or the same blocked action with the same words
//            and the same response (a step that asked nothing: the same words and
//            status, and the same response)
//   edited   the same blocked action, but words the person reads changed
//   updated  a step that asked nothing and still asks nothing, but something the
//            person reads of it changed
//   answered the same words, but the response changed (another window, the done
//            mark, a response cleared, or an earlier send of this one)
//   landed   answered, and the row now holds exactly the draft's own text and
//            kind: the send went through, so there is nothing to send
//   changed  a new action: its action_version moved (or was never known)
//   closed   a blocked ask that asks nothing now (it left `blocked`)
//   asked    a note on a step that asked nothing, which now has an ask
//   removed  the row is not listed (deleted, or its plan finished or archived)
//   projectClosed  its project is closed
// A draft the released version stored has no hashes: once its row moved under
// the same action it is never `same`, but `answered` when the row now holds a
// response, and `edited` otherwise.
function rowAskFate(owner, typedFor, held = null) {
  if (!owner) return 'removed'
  const { row } = owner
  if (row.revision === typedFor.revision) return 'same'
  if (closedSet().has(owner.board.project)) return 'projectClosed'
  const waiting = typedFor.blocked !== false
  if (waiting) {
    if (row.status !== 'blocked') return 'closed'
    if (typedFor.actionVersion == null || row.action_version !== typedFor.actionVersion) return 'changed'
  } else if (row.status === 'blocked') {
    return 'asked'
  }
  const moved = waiting ? 'edited' : 'updated'
  let fate
  if (typedFor.ask == null || typedFor.response == null) fate = rowHasResponse(row) ? 'answered' : moved
  else if (typedFor.ask !== rowAskSignature(row)) fate = moved
  else fate = typedFor.response === rowResponseSignature(row) ? 'same' : 'answered'
  return fate === 'answered' && held && rowHoldsText(row, held) ? 'landed' : fate
}

// A response of any kind: the human's words, a clarification or decline, or the done mark.
const rowHasResponse = (row) => Boolean(row.annotation || row.annotation_kind || row.handled_at)

// Whether the row holds exactly this text and kind as its annotation.
function rowHoldsText(row, { text, kind }) {
  return (row.annotation ?? '') === text.trim() && (row.annotation_kind ?? 'answer') === kind
}

// Cases 1 and 2 (#636): the row still asks what the draft was typed for.
const sameRowAsk = (fate) => fate === 'same' || fate in ROW_ASK_SENTENCES

// The draft's text needs nowhere else to go: it stays in its editor, or the
// server already holds it.
const rowDraftStays = (fate) => sameRowAsk(fate) || fate === 'landed'

// Says beside the row's editor that its ask moved under the draft. The notice
// goes with the draft (its meta, so a reload keeps it) while text waits; with
// none, as after a refused option click, it is kept in memory.
function noteRowAskMoved(id, fate, owner, { choice = false } = {}) {
  if (!(fate in ROW_ASK_SENTENCES)) return
  const meta = rowDraftMeta[id]
  if (meta && String(rowDrafts[id] ?? '').trim()) {
    meta.notice = fate
    rowAskNotices.delete(id)
  } else {
    rowAskNotices.set(id, { actionVersion: owner.row.action_version, word: fate, choice })
  }
}

// Drops the notice a row carries, and the sentence that announced it.
function clearRowAskNotice(id) {
  rowAskNotices.delete(id)
  if (rowDraftMeta[id]) delete rowDraftMeta[id].notice
  if (isRowAskSentence(writeErrors[id])) showWriteError(id, '')
  for (const el of document.querySelectorAll(`.ask-edited[data-notice-for="${CSS.escape(id)}"]`)) el.remove()
}

// A draft the server already holds (its send went through) goes away: nothing
// is shown and nothing is sent again.
function retireRowDraft(id) {
  bumpDraftGeneration(rowDraftGenerations, id)
  delete rowDrafts[id]
  delete rowDraftKinds[id]
  delete rowDraftMeta[id]
  unconfirmedRowSends.delete(id)
  clearRowAskNotice(id)
  showWriteError(id, '')
  scheduleDraftSave()
}

// Follows a row draft to what became of its ask (#636 cases 1 and 2): while the
// row still asks what it was typed for, its meta moves to the current revision,
// so the next Send goes there, and a moved ask is marked on the draft for the
// row to say so. One the server already holds is retired. Returns the fate;
// anything else is for the caller to keep with its reason.
function followRowAsk(id, owner, meta, held = null) {
  const fate = rowAskFate(owner, meta, held)
  if (fate === 'landed') {
    retireRowDraft(id)
  } else if (sameRowAsk(fate)) {
    const notice = fate in ROW_ASK_SENTENCES ? fate : meta.notice
    Object.assign(meta, rowDraftMetaFor(owner.board, owner.row))
    if (notice) meta.notice = notice
  }
  return fate
}

// The sentence a row's kept text carries, by what became of its ask.
// `typedFor` is the draft's meta: one stored without knowing whether it was typed
// for a blocked step (the released version) cannot say the step "was closed".
function rowRecoveryReason(fate, unconfirmed = false, typedFor = null) {
  const cause = fate === 'closed' && typedFor && typedFor.blocked == null ? 'stepChanged' : {
    closed: 'stepClosed', removed: 'stepRemoved', projectClosed: 'projectClosed', asked: 'stepAsked',
  }[fate] ?? 'askChanged'
  return draftReason(cause, unconfirmed)
}

// What a kept row text says when it was stored without a reason (the released
// version stored in-session recoveries so): a text set aside before is told
// from one that was simply not sent.
const rowRecoveryWhy = (draft) => draft.reason
  || (draft.setAside ? 'Kept from before you set this aside.' : 'Your text was not sent.')

// A draft whose row moved is followed here, as reconcileDraftOwners follows it,
// because not every editor is drawn after that reconcile: the Dashboard's session
// panel paints its asks (paintAmbient) before render() reconciles, so its editor
// sees the newer row first, and without the follow every moved draft would be set
// aside. A draft that does not stay goes to the unsent responses.
function recoverMismatchedRenderedRowDraft(b, r) {
  const text = rowDrafts[r.id]
  const meta = rowDraftMeta[r.id]
  if (!String(text ?? '').trim() || !meta || meta.revision === r.revision) return false
  const fate = followRowAsk(r.id, { board: b, row: r }, meta, { text, kind: rowDraftKinds[r.id] ?? 'answer' })
  if (rowDraftStays(fate)) return false
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
    reason: rowRecoveryReason(fate, unconfirmedRowSends.get(r.id) === text, meta),
  }
  rowAskNotices.delete(r.id)
  bumpDraftGeneration(rowDraftGenerations, r.id)
  delete rowDrafts[r.id]
  delete rowDraftKinds[r.id]
  delete rowDraftMeta[r.id]
  if (pollPaint) {
    // #563: a poll never navigates; the next tick paints the unsent response
    recoveryNavPending = true
    renderDirty = true
    scheduleDraftSave()
    return true
  }
  requestAnimationFrame(() => {
    requestDraftRecovery(null)
    forceRender()
  })
  return true
}

function activeDraftFocusBookmark() {
  const active = activeFocusElement()
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
  // an editor in a hidden step or a closed plan takes no focus: say so, so the card's own restore runs
  return document.activeElement === input
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
    return it && isAskingItem(it) ? { it } : null
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
  // the Review queue button rests out of sight: show the tools before it takes focus
  focusQueueControl(target)
}

// Issue #407: the unsent responses that hold the Review queue back. The hold
// exists so an unsent response is never hidden behind a deck that asks for the
// same target (bbc3d886): the deck would offer a second editor for an ask whose
// earlier answer still waits in the unsent responses, and a row recovery on the
// row's current revision is even copied into the deck's own editor. Only an
// entry whose target the deck shows can do that: a question recovery or Note
// attempt whose open question is in the deck, and a row recovery whose row is
// in the deck on the same action (same revision, or same action_version when
// the entry recorded one). Entries for a closed, gone or since-changed target
// (most "this question is closed" / "this action changed" entries) never meet
// the deck, so they stay listed and the queue opens.
function heldDraftRecoveries(deck = buildDeck()) {
  const questions = new Set(deck.filter((entry) => entry.type === 'q').map((entry) => entry.id))
  const rows = new Map(deck.filter((entry) => entry.type === 'row')
    .map((entry) => [entry.rowId, currentRow(entry.rowId)]))
  const held = []
  for (const [key, draft] of Object.entries(staleItemDrafts)) {
    if (questions.has(draft.itemId)) held.push({ line: key })
  }
  for (const [key, draft] of Object.entries(staleRowDrafts)) {
    const owner = rows.get(draft.rowId)
    if (!owner || draft.choice) continue
    const inline = owner.row.revision === draft.revision
    const sameAction = draft.actionVersion != null && draft.actionVersion === owner.row.action_version
    if (inline || sameAction) {
      held.push({
        line: key,
        inline: inline ? { rowId: draft.rowId, revision: draft.revision, project: owner.board.project } : null,
      })
    }
  }
  for (const [id, draft] of Object.entries(itemNoteDrafts)) {
    if (!draft.pending && questions.has(id)) held.push({ line: `note:${id}` })
  }
  return held
}

// Set when the Review queue was held back, so the Inbox header says why; it
// lasts until the queue opens, the held entries are gone, or the human leaves
// the Inbox.
let triageHeld = false

function triageHoldText(count) {
  return count === 1
    ? 'Finish or discard the 1 unsent response first.'
    : `Finish or discard the ${count} unsent responses first.`
}

// Writes the hold line in the Needs-you header, which is never rebuilt, so a
// Discard can update it even while the list's own rebuild is held back.
function paintTriageHold() {
  const count = triageHeld ? heldDraftRecoveries().length : 0
  if (!count) triageHeld = false
  const hold = needsYouHeaderNode?.querySelector('.triage-hold')
  if (!hold) return
  const text = hold.querySelector('.triage-hold-text')
  const message = count ? triageHoldText(count) : ''
  if (text.textContent !== message) text.textContent = message
  const show = hold.querySelector('.triage-hold-show')
  const label = count === 1 ? 'Show it' : 'Show them'
  if (show.textContent !== label) show.textContent = label
  // hiding the focused Show would drop focus to <body>
  const hadFocus = !count && !show.hidden && document.activeElement === show && document.hasFocus()
  show.hidden = !count
  if (hadFocus) {
    const next = document.querySelector('.stale-drafts-fold summary') ?? document.querySelector('.triage-btn')
    focusQueueControl(next)
  }
  hold.classList.toggle('active', Boolean(count))
}

function holdTriage() {
  triageHeld = true
  // the person asked for the Review queue: its button (and the hold line's way back to it) in view
  showQueueTools()
  // nothing passive moves focus to the off-screen fold; the hold line does
  draftRecoveryFocusPending = false
  if (triageDeck) closeTriage({ restoreFocus: false })
  if (missionBoardId) closeMission({ restoreFocus: false })
  if (relayOpen) closeRelay()
  selectTab('dashboard', { paint: false })
  forceRender()
  paintTriageHold()
  const show = needsYouHeaderNode?.querySelector('.triage-hold-show')
  if (show && !show.hidden && document.hasFocus()) {
    show.focus({ preventScroll: true })
    show.closest('.triage-hold')?.scrollIntoView({ behavior: motion.scrollBehavior(), block: 'nearest' })
  }
}

// The hold line's control: an explicit navigation, so it reveals and focuses
// the first held response (#407), never through passive focus restoration.
function revealHeldDraft() {
  const first = heldDraftRecoveries()[0]
  if (!first) {
    paintTriageHold()
    focusQueueControl(document.querySelector('.triage-btn'))
    return
  }
  if (first.inline) {
    requestDraftRecovery(first.inline)
    draftRecoveryFocusPending = false
  }
  forceRender()
  const target = (first.inline
    ? needsYouRowEl(first.inline.rowId)?.querySelector('.reply-input[data-recovered-draft="1"]')
    : null)
    ?? document.querySelector(`.stale-drafts-fold .stale-draft-line[data-recovery-line="${CSS.escape(first.line)}"]`)
    // a row's kept text shows beside its editor while its card is open (#636), as the ask in front's is
    ?? document.querySelector(`#needsYouList .nrow-card .row-recovery[data-recovery-line="${CSS.escape(first.line)}"]`)
    ?? document.querySelector('.stale-drafts-fold summary')
  if (!target) return
  revealDetailsAncestors(target)
  revealControl(target, document.getElementById('needsYou'))
  ;(target.closest('.nrow') ?? target).scrollIntoView({ behavior: motion.scrollBehavior(), block: 'center' })
  target.focus({ preventScroll: true })
}

function openTriage() {
  const entries = buildDeck()
  if (heldDraftRecoveries(entries).length) {
    holdTriage()
    return
  }
  triageHeld = false
  paintTriageHold()
  triageReturnFocus = captureTriageReturnFocus()
  if (relayOpen) closeRelay()
  if (missionBoardId) closeMission({ restoreFocus: false })
  triageDeck = { entries, index: 0 }
  renderTriage()
  document.querySelector('#lightbox .lb-panel')?.focus({ preventScroll: true })
}

function closeTriage({ restoreFocus = true } = {}) {
  const returnFocus = triageReturnFocus
  const lightbox = document.getElementById('lightbox')
  // A draft edited in the deck may be newer than a held copy of its editor on
  // the page (the session panel, an Inbox card): repaint so none is stale.
  // Only on the human's own close; recovery closes from inside a render.
  const heldDraft = restoreFocus
    && [...lightbox.querySelectorAll('textarea.reply-input')].some((input) => input.value.trim() !== '')
  triageDeck = null
  triageReturnFocus = null
  lightbox.hidden = true
  if (heldDraft) forceRender()
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
  const active = activeFocusElement()
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

// `onPin` is passed only for an unanswered ask that is not pinned yet, and only
// while the Later section is on (#247): the pin is offered first, above the
// snooze choices it replaces.
// `label` names the menu: the compact surface (#303, #454) calls it "More…",
// since its host already shows Snooze and Pin.
function dispositionEl(onResponse, onSnooze, key, onPin = null, { label = 'More' } = {}) {
  const menu = document.createElement('details')
  menu.className = 'disposition-menu'
  menu.open = openDispositionMenus.has(key)
  menu.addEventListener('toggle', () => {
    if (menu.open) openDispositionMenus.add(key)
    else openDispositionMenus.delete(key)
  })
  const summary = document.createElement('summary')
  summary.textContent = label
  const wrap = document.createElement('div')
  wrap.className = 'disposition-actions'
  if (onPin) {
    const pin = btn('Pin for later', onPin)
    pin.className = 'disposition-btn'
    pin.title = 'Set this aside with no return time; it waits in Later until you bring it back.'
    wrap.appendChild(pin)
  }
  const snooze = (label, ms) => {
    const button = btn(label, () => onSnooze(new Date(Date.now() + ms).toISOString()))
    button.className = 'disposition-btn'
    wrap.appendChild(button)
  }
  snooze('Not now · 4h', 4 * 60 * 60_000)
  snooze('Tomorrow', 24 * 60 * 60_000)
  snooze('Next week', 7 * 24 * 60 * 60_000)
  // an ask answered only with its own options (#412 step 3) offers no other response
  if (onResponse) {
    const clarify = btn('Needs clarification', () => {
      onResponse('clarify', 'Please clarify the exact decision or task you need from me.')
    })
    clarify.className = 'disposition-btn'
    wrap.appendChild(clarify)
    const decline = btn('Decline', () => onResponse('decline', 'Declined'))
    decline.className = 'disposition-btn decline'
    wrap.appendChild(decline)
  }
  menu.append(summary, wrap)
  return menu
}

// The one write behind every deferral (#247): a snooze or a pin, of a question
// or a plan row, from any card. An ask that holds a draft keeps (or takes) the
// open card, and the fold that holds the open card always renders open
// (renderNeedsYou), so the draft that pauses the list stays in view. Without a
// draft the card closes (§2.1) and the ask waits in its closed fold.
async function deferAsk(entry, url, body, { refusal = '', onSaved = null } = {}) {
  const ask = entryEntity(entry)
  const res = await postJSON(url, body)
  if (res === null) return
  if (refusal) showWriteError(ask.id, res.ok ? '' : refusal)
  // A row snooze moves the revision but leaves the ask's words alone, so a draft
  // on it stays in its editor and follows the row (#636, which replaced #272's
  // move to the unsent responses).
  if (res.ok) {
    if (holdsDraft(ask.id)) keepDraftInView(entry)
    else if (openRowId === ask.id) setOpenRow(null, { resume: false })
    onSaved?.()
  }
  await reloadAndPaint()
}

// #247 §2.3: with the Later section on, "I'll take a while" also defers the ask
// in the same write: "Stop waiting" pins it and "Back in …" snoozes it to the
// same time. Through deferAsk, so a drafted ask stays in view.
function deferWaitStop(entry, url, until, pins, options) {
  return deferAsk(entry, url, { until, defer: true, ...pins }, options)
}

const ROW_CHANGED_REFUSAL = 'This step changed before your click, so nothing was applied. Check it and try again.'
const ITEM_CHANGED_REFUSAL = 'This question changed before your click, so nothing was applied. Check it and try again.'

// The snooze and pin writes for one ask, shared by every card that offers them:
// the Inbox and Review queue cards, the plan panel and the session panel (#454).
function snoozeAsk(entry, until, { onSaved = null } = {}) {
  if (entry.kind === 'item') return deferAsk(entry, `/api/items/${entry.item.id}/snooze`, { until })
  const { row: r, board: b } = entry
  return deferAsk(entry, `/api/boards/${b.id}/rows/${r.id}/snooze`,
    { until, expected_revision: r.revision, expected_board_version: b.revision }, { onSaved })
}

function pinAsk(entry, { onSaved = null } = {}) {
  if (entry.kind === 'item') {
    return deferAsk(entry, `/api/items/${entry.item.id}/later`, { pinned: true }, { refusal: ITEM_CHANGED_REFUSAL })
  }
  const { row: r, board: b } = entry
  return deferAsk(entry, `/api/boards/${b.id}/rows/${r.id}/later`,
    { pinned: true, expected_revision: r.revision, expected_board_version: b.revision },
    { onSaved, refusal: ROW_CHANGED_REFUSAL })
}

// Pin for later is offered on an unanswered ask that is not pinned yet, and only
// while the Later section is on (#247). A question's Note is feedback, not an
// answer, so only a row's annotation or handled mark counts.
function pinOffered(entity, kind) {
  if (!laterSection || entity.pinned_at) return false
  if (kind === 'item') return !entity.reply && !entity.reply_kind
  return !entity.annotation && !entity.annotation_kind && !entity.handled_at
}

// The test suspendState() applies: a draft is more than whitespace.
function holdsDraft(id) {
  return [draftReplies[id], draftReplyContexts[id], rowDrafts[id]]
    .some((text) => String(text ?? '').trim() !== '')
}

// Give the deferred ask the open card, as opening its row would; its fold then
// renders open. From the Review queue or a plan panel it was not the open card,
// and those ignore the list's filters, so widen any filter that would hide it.
// A Review queue opened with `t` on another tab would return there when it
// closes, so Home becomes the visible page and the queue returns to its
// Review queue button instead; nothing is focused now.
function keepDraftInView(entry) {
  if (triageDeck && activeTab !== 'dashboard') {
    selectTab('dashboard', { paint: false })
    triageReturnFocus = { kind: 'triageButton' }
    showQueueTools()
  }
  const ask = entryEntity(entry)
  if (openRowId === ask.id) return
  const owner = entry.kind === 'row' ? entry.board : entry.item
  if (projectFilter && projectFilter !== owner.project) projectFilter = owner.project
  if (agentFilter && agentFilter !== owner.agent) agentFilter = null
  if (!filterActionEntries([entry]).length) {
    actionFilter = 'all'
    changedOnly = false
  }
  selectedId = ask.id
  setOpenRow(ask.id, { resume: false })
}

// Issue #217 — "I'll take a while". Only a Copilot session runs the answer
// watcher this stops, and only one whose server records who raised the ask
// (`action_agent`) runs a watcher that honours it — so the control follows THIS
// ask's asker, never the board's last writer, and an unknown asker draws
// nothing rather than a guess. With the Later section off it never touches
// attention: the ask stays in Needs you unless the human also snoozes it. With
// it on (#247), the same write also defers the ask (deferWaitStop). A stop for
// good is final (the watcher has already exited), so it renders as a reminder,
// not a control, and the reminder outlives the answer until an agent has
// picked that answer up.
const WAIT_STOP_DEFERRALS = [
  ['Back in ~1 h', 60 * 60_000],
  ['Back in ~3 h', 3 * 60 * 60_000],
  ['Back tomorrow', 24 * 60 * 60_000],
]

function waitStopEl(ask, { answered = false, pickedUp = false, key = '', onStop = null } = {}) {
  if (ask.action_agent !== 'copilot') return null
  const note = (text) => {
    const el = document.createElement('div')
    el.className = 'wait-stop-note'
    el.textContent = text
    return el
  }
  if (ask.watch_stopped_at && !ask.watch_stopped_until) {
    if (!answered) return note(`Agent stopped waiting ${rel(ask.watch_stopped_at)} ago · message it after you answer`)
    return pickedUp ? null : note('Agent stopped waiting · message it so it picks up your answer')
  }
  // An answer ends the wait; there is nothing left to stop.
  if (answered) return null
  const wrap = document.createElement('div')
  wrap.className = 'wait-stop'
  const quietLeft = ask.watch_stopped_at ? Date.parse(ask.watch_stopped_until) - Date.now() : Number.NaN
  if (quietLeft > 0) wrap.appendChild(note(`Agent waits quietly · ${relMs(quietLeft)} left · answering still wakes it`))
  const menu = document.createElement('details')
  menu.className = 'disposition-menu wait-menu'
  menu.open = openDispositionMenus.has(key)
  menu.addEventListener('toggle', () => {
    if (menu.open) openDispositionMenus.add(key)
    else openDispositionMenus.delete(key)
  })
  const summary = document.createElement('summary')
  summary.textContent = 'I’ll take a while'
  const actions = document.createElement('div')
  actions.className = 'disposition-actions'
  const choice = (label, title, until) => {
    const button = btn(label, () => onStop(until()))
    button.className = 'disposition-btn'
    button.title = title
    actions.appendChild(button)
  }
  choice('Stop waiting', laterSection
    ? 'The agent stops waiting. The ask moves to Later until you bring it back.'
    : 'The agent stops waiting and won’t wake on its own; message it after you answer.', () => null)
  for (const [label, ms] of WAIT_STOP_DEFERRALS) {
    choice(label, laterSection
      ? 'The agent waits quietly and the ask waits in Later until then. Answering still wakes the agent.'
      : 'The agent waits quietly until then; answering still wakes it.', () => new Date(Date.now() + ms).toISOString())
  }
  menu.append(summary, actions)
  wrap.appendChild(menu)
  return wrap
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
          ? ROW_CHANGED_REFUSAL
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
    if (event.isComposing || event.keyCode === 229 || event.repeat || event.altKey) return
    if (event.key !== 'Enter' || (!event.ctrlKey && !event.metaKey)) return
    event.preventDefault()
    submit()
  })
  requestAnimationFrame(() => {
    // Queue restoration may have sized this editor already. A second auto-height
    // measurement would temporarily shrink and clamp its restored scroll parent.
    if (editor.isConnected && !editor.style.height) resizeReplyEditor(editor)
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
// `surface: 'compact'` is an ask in the session panel (#454 A.2, #303's rail
// before it): the same controls and writes, with ★ on the recommended option,
// its own disclosure and Compare state, and "I'll take a while" under More…
// (Snooze and Pin are on the
// host).
function rowAnswerEl(b, r, onSaved, { surface = null } = {}) {
  recoverMismatchedRenderedRowDraft(b, r)
  const wrap = document.createElement('div')
  wrap.className = 'row-answer'
  setHintOwner(wrap, r, b)
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
  const rowRecoveries = Object.entries(staleRowDrafts)
    .filter(([, draft]) => draft.rowId === r.id)
  if (staleDraft) input.dataset.recoveredDraft = '1'
  input.value = rowDrafts[r.id] ?? (staleDraft?.text ?? '')
  if (input.value && rowDrafts[r.id] === undefined) {
    bumpDraftGeneration(rowDraftGenerations, r.id)
    rowDrafts[r.id] = input.value
    rowDraftMeta[r.id] = {
      ...rowDraftMetaFor(b, r),
      actionVersion: staleDraft?.actionVersion ?? r.action_version,
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
      rowDraftMeta[r.id] = { ...rowDraftMetaFor(b, r), notice: rowDraftMeta[r.id]?.notice }
    } else {
      // the notice goes with the text it was about (#636), unless a refused click left its own
      const kept = rowAskNotices.get(r.id)
      delete rowDraftMeta[r.id]
      if (!kept) clearRowAskNotice(r.id)
    }
    delete staleRowDrafts[recoveryKey]
    clearRowRecoveryTarget(r.id, r.revision)
    resumeRender()
  })
  // `choice`: an option or a disposition ({ text, kind }), sent as it is; the
  // editor and its draft are left as they were until the server takes it.
  const save = (choice = null) => withPendingResponse(async () => {
    const typed = choice ? choice.text : input.value
    if (!typed.trim()) return
    const kind = choice ? choice.kind : input.dataset.responseKind ?? 'answer'
    const submittedGeneration = editorGeneration
    const submissionToken = bumpDraftGeneration(rowSubmissionTokens, r.id)
    const owns = () => (rowDraftGenerations[r.id] ?? 0) === submittedGeneration
      && rowSubmissionTokens[r.id] === submissionToken
    // #636: the ask as this editor shows it, so a refusal can say what became of it
    const typedFor = rowDraftMetaFor(b, r)
    let target = { board: b, row: r }
    let res = null
    let fate = 'same'
    // the re-read after a refusal got nothing (so the refusal cannot be read), or
    // the person typed again meanwhile (so nothing more is sent, and nothing is said)
    let unread = false
    let superseded = false
    for (let resent = false; ; resent = true) {
      // Until the server answers, this text may or may not have landed (#279).
      unconfirmedRowSends.set(r.id, typed)
      // fix round 2 (C3): the draft used to be dropped BEFORE the POST, so a
      // dropped request (viewer server restarted — routine for the Electron app)
      // erased the human's note with no trace. Clear only once it landed.
      res = await postJSON(`/api/boards/${b.id}/rows/${r.id}/annotate`, {
        text: typed.trim(),
        kind,
        expected_revision: target.row.revision,
        expected_board_version: target.board.revision,
      })
      if (res !== null && unconfirmedRowSends.get(r.id) === typed) unconfirmedRowSends.delete(r.id)
      if (res === null || res.ok || !owns()) break
      // #636: refused because the row or its plan moved. The server's guard
      // stands; the page reads what moved. Still the same ask, words and all
      // (case 1): sent once more, against the current revision.
      const before = lastData
      await load()
      if (!owns()) {
        superseded = true
        break
      }
      if (lastData === before) {
        unread = true
        break
      }
      const owner = currentRow(r.id)
      fate = rowAskFate(owner, typedFor, { text: typed, kind })
      if (fate !== 'same' || resent) break
      target = owner
    }
    const ownsSubmission = owns()
    if (res === null || unread) {
      // the answer never came, or the re-read did. Typed text is as it was, and a
      // click over it never replaces it. A click with nothing typed becomes the
      // editor's text, as before, so Send retries it and a pending viewer restart waits.
      const held = String(rowDrafts[r.id] ?? input.value).trim() !== ''
      if (ownsSubmission && (!choice || !held)) {
        rowDrafts[r.id] = typed
        rowDraftMeta[r.id] = { ...rowDraftMetaFor(b, r), notice: rowDraftMeta[r.id]?.notice }
        input.value = typed
      }
      showWriteError(r.id, choice && held ? ROW_CHOICE_NOT_APPLIED : WRITE_FAILED)
      // An option POST may outlive a poll rebuild; restore the current editor,
      // rather than leaving the response only on the detached captured input.
      if (ownsSubmission && !input.isConnected) forceRender()
      else resumeRender()
      return
    }
    if (!res.ok && fate !== 'landed') {
      if (!ownsSubmission) {
        if (!superseded) showWriteError(r.id, 'An earlier response was not applied; your newer draft is preserved.')
        resumeRender()
        return
      }
      if (sameRowAsk(fate)) {
        // The same ask (#636 cases 1 and 2): typed text stays in this row's
        // editor, now against the current revision, so the next Send goes
        // there. A choice is not applied, and the editor keeps what it held.
        const owner = currentRow(r.id)
        if (!choice) {
          rowDrafts[r.id] = typed
          rowDraftKinds[r.id] = kind
        }
        if (String(rowDrafts[r.id] ?? '').trim()) {
          rowDraftMeta[r.id] = { ...rowDraftMetaFor(owner.board, owner.row), notice: rowDraftMeta[r.id]?.notice }
        }
        noteRowAskMoved(r.id, fate, owner, { choice: Boolean(choice) })
        // said through the write-error slot, which is rewritten in place and so announced
        showWriteError(r.id, fate === 'same' ? ROW_KEPT_CHANGING : rowAskSentence(fate, Boolean(choice)))
        await reloadAndPaint()
        return
      }
      // A new ask, or none (#636 case 3). A choice was meant for the ask that
      // went, so it is not kept as text; typed text is, beside the row or in the
      // unsent responses, with what happened.
      rowAskNotices.delete(r.id)
      if (choice) {
        if (fate === 'closed' || fate === 'removed' || fate === 'projectClosed') {
          // the card left the queue with the step, or its project: one entry says the click did nothing
          staleRowDrafts[rowChoiceRecoveryKey(r.id, r.revision)] = {
            rowId: r.id,
            revision: r.revision,
            text: choice.text,
            kind,
            choice: true,
            boardTitle: b.title,
            label: r.label,
            context: r.context ?? '',
            reason: `Your choice "${choice.text}" was not applied: this ${fate === 'projectClosed' ? 'project' : 'step'} was closed first.`,
          }
          requestDraftRecovery(null)
          showWriteError(r.id, '')
        } else {
          showWriteError(r.id, ROW_CHANGED_REFUSAL)
        }
        await reloadAndPaint()
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
        reason: rowRecoveryReason(fate),
      }
      requestDraftRecovery({ rowId: r.id, revision: r.revision, project: b.project })
      bumpDraftGeneration(rowDraftGenerations, r.id)
      delete rowDrafts[r.id]
      delete rowDraftKinds[r.id]
      delete rowDraftMeta[r.id]
      showWriteError(r.id, '')
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
    rowAskNotices.delete(r.id)
    showWriteError(r.id, '')
    // the row stays blocked until the agent picks the note up — the human's part
    // is done, so the caller decides what to drop
    onSaved?.()
    // issue #38, the reported surface: a bare load() here was gated, and the gate
    // is global — one unrelated draft anywhere and this write showed the human
    // nothing at all, box still full, ready to send the same string twice.
    await reloadAndPaint()
  })
  const options = r.status === 'blocked' ? optionOrder(r.options) : []
  // the parts of the answer area, appended in one place below
  let choices = null
  let compare = null
  let notice = null
  const more = []
  if (options.length) {
    choices = document.createElement('div')
    choices.className = `options row-options${comparing(openRowCompares, r.id, surface) ? ' comparing' : ''}`
    for (const option of options) {
      const box = document.createElement('div')
      box.className = 'option'
      const pill = document.createElement('button')
      pill.className = `opt-pill${option.recommended ? ' rec' : ''}`
      pill.innerHTML = optionPillHtml(option, surface)
      pill.addEventListener('click', () => save({ text: option.label, kind: 'answer' }))
      box.appendChild(pill)
      if (option.detail) {
        const detail = document.createElement('div')
        detail.className = 'opt-detail'
        detail.innerHTML = renderStructuredText(option.detail, textContext(b, r))
        box.appendChild(detail)
      }
      choices.appendChild(box)
    }
    if (options.some((option) => option.detail)) {
      compare = btn(comparing(openRowCompares, r.id, surface) ? 'Hide option details' : 'Compare options', () => {
        toggleCompare(openRowCompares, r.id, surface)
        forceRender()
      })
      compare.className = 'compare-toggle'
    }
  }
  const keyPrefix = surface ? `${surface}:` : ''
  if (r.status === 'blocked' && !r.annotation && !r.annotation_kind && !r.handled_at) {
    const entry = { kind: 'row', row: r, board: b }
    const menu = dispositionEl(
      (kind, text) => save({ text, kind }),
      (until) => snoozeAsk(entry, until, { onSaved }),
      `${keyPrefix}row:${r.id}`,
      surface || !pinOffered(r, 'row') ? null : () => pinAsk(entry, { onSaved }),
      surface ? { label: 'More…' } : {},
    )
    more.push(menu)
    const waitStop = waitStopEl(r, {
      key: `${keyPrefix}wait:row:${r.id}`,
      onStop: async (until) => {
        const url = `/api/boards/${b.id}/rows/${r.id}/stop-waiting`
        const pins = { expected_revision: r.revision, expected_board_version: b.revision }
        const refusal = ROW_CHANGED_REFUSAL
        if (laterSection) {
          await deferWaitStop({ kind: 'row', row: r, board: b }, url, until, pins, { refusal, onSaved })
          return
        }
        const res = await postJSON(url, { until, ...pins })
        if (res === null) return
        showWriteError(r.id, res.ok ? '' : refusal)
        await reloadAndPaint()
      },
    })
    if (waitStop) {
      if (surface) menu.querySelector('.disposition-actions').appendChild(waitStop)
      else more.push(waitStop)
    }
  } else if (r.status === 'blocked') {
    const reminder = waitStopEl(r, { answered: true, pickedUp: rowPickup(r).pickedUp })
    if (reminder) more.push(reminder)
  }
  bindReplyEditor(input, () => save())
  // #636 case 2: this ask moved under its draft (until a send of it lands). A
  // notice with no draft ends with the ask it was about.
  const askNotice = rowAskNotices.get(r.id)
  if (askNotice && (askNotice.actionVersion !== r.action_version || r.status !== 'blocked')) rowAskNotices.delete(r.id)
  const draftNotice = String(rowDrafts[r.id] ?? '').trim() ? rowDraftMeta[r.id]?.notice : undefined
  const noticeWord = draftNotice ?? rowAskNotices.get(r.id)?.word
  const noticeText = rowAskSentence(noticeWord, !draftNotice && Boolean(rowAskNotices.get(r.id)?.choice))
  // what a Send or a click announced through the write-error slot outlives the ask it was about
  if (!noticeText && isRowAskSentence(writeErrors[r.id])) delete writeErrors[r.id]
  // drawn once: the slot already says it right after a Send or a click
  if (noticeText && !isRowAskSentence(writeErrors[r.id])) {
    notice = document.createElement('p')
    notice.className = 'ask-edited'
    notice.dataset.noticeFor = r.id
    notice.textContent = noticeText
  }
  // UX pass, slice 1: "I've done my part" is a task's main control, so it leads its
  // line; its Undo, and the reason it cannot be undone, stay after Send.
  const handled = rowHandledEl(b, r)
  const handledLeads = Boolean(handled?.matches('.handled-btn:not(.undo-btn)'))
  if (handledLeads) row.appendChild(handled)
  row.appendChild(input)
  row.appendChild(btn('Send', () => save(), 'submit'))
  if (handled && !handledLeads) row.appendChild(handled)
  row.appendChild(writeErrorEl(r.id))
  // what is kept from an earlier ask, or was not sent, reads directly under the editor it is about
  const kept = []
  for (const [key, recovery] of rowRecoveries) {
    if (recovery.revision !== r.revision) {
      kept.push(rowRecoveryEl(key, recovery))
      continue
    }
    const warning = document.createElement('div')
    warning.className = 'write-error stale-draft'
    warning.textContent = 'Not sent because the board changed. Review the preserved draft and send again.'
    kept.push(warning)
  }
  // UX pass, slice 1: built in the order a question's answer area is drawn (the
  // answers, Compare options, the editor, then More), so Tab follows what is seen.
  // The compact surface keeps the order it had.
  const parts = surface
    ? [compare, choices, ...more, notice, row, ...kept]
    : [choices, compare, notice, row, ...kept, ...more]
  for (const part of parts) if (part) wrap.appendChild(part)
  return wrap
}

// #636 case 3: text kept from an ask this row no longer holds, shown beside
// the row while the row is on screen (the unsent responses list it otherwise).
function rowRecoveryEl(key, draft) {
  const block = document.createElement('div')
  block.className = 'row-recovery stale-draft'
  block.dataset.recoveryLine = key
  block.tabIndex = -1 // where a refused Send leaves the keyboard
  const why = document.createElement('p')
  why.className = 'row-recovery-why'
  why.textContent = rowRecoveryWhy(draft)
  const text = document.createElement('p')
  text.className = 'row-recovery-text'
  text.textContent = draft.text
  const actions = document.createElement('div')
  actions.className = 'row-recovery-actions'
  // a click that was not applied has no text to use or copy: the sentence says it all
  if (!draft.choice && rowRecoveryUsable(currentRow(draft.rowId))) {
    actions.appendChild(btn('Use this text', (event) => useRowRecovery(key, draft, event.currentTarget)))
  }
  if (!draft.choice) actions.appendChild(btn('Copy', (event) => copyRecoveryText(draft.text, event.currentTarget)))
  actions.appendChild(btn('Discard', (event) => {
    const scopeId = event.currentTarget.closest('[id]')?.id ?? null
    discardRowRecovery(key, draft)
    forceRender()
    paintTriageHold()
    // the keyboard goes back to the row it was beside
    restoreDraftFocus({ key: `row:${draft.rowId}`, scopeId })
  }))
  for (const button of actions.children) button.className = 'undo-btn'
  if (draft.choice) block.append(why, actions)
  else block.append(why, text, actions)
  return block
}

// Whether kept text has an editor to go to: the row is still listed, blocked or
// not (its card in the Inbox, or its panel in Plans), and its project is open.
function rowRecoveryUsable(owner) {
  return Boolean(owner && !closedSet().has(owner.board.project))
}

function discardRowRecovery(key, draft) {
  if (staleRowDrafts[key] !== draft) return false
  delete staleRowDrafts[key]
  clearRowRecoveryTarget(draft.rowId, draft.revision)
  return true
}

// Opens a step's panel in Plans, widening a filter that would hide it, as a
// deep link opens it, but without moving the page's address.
function showPlanRow(owner) {
  openRows.add(owner.row.id)
  visitRows.add(owner.row.id)
  showDoneBoards.add(owner.board.id)
  planOpen.set(owner.board.id, true)
  if (projectFilter && projectFilter !== owner.board.project) projectFilter = owner.board.project
  if (agentFilter && agentFilter !== owner.board.agent) agentFilter = null
  selectTab('boards', { paint: false })
}

// Use this text (#636): the kept text goes to the editor of the row's current
// ask, after anything already typed there, and the keyboard goes with it.
// Nothing is sent. From the Inbox (beside the row, or the unsent responses) a
// blocked row's card opens, and a step that asks nothing opens in Plans, as a
// deep link opens it; elsewhere the editor beside the button takes it.
function useRowRecovery(key, draft, button) {
  const owner = currentRow(draft.rowId)
  if (staleRowDrafts[key] !== draft || draft.choice || !rowRecoveryUsable(owner)) {
    forceRender()
    return
  }
  const id = draft.rowId
  const held = String(rowDrafts[id] ?? '')
  if (!held.trim()) rowDraftKinds[id] = draft.kind
  bumpDraftGeneration(rowDraftGenerations, id)
  rowDrafts[id] = held.trim() ? `${held.trimEnd()}\n\n${draft.text}` : draft.text
  rowDraftMeta[id] = {
    ...rowDraftMetaFor(owner.board, owner.row),
    notice: held.trim() ? rowDraftMeta[id]?.notice : undefined,
  }
  discardRowRecovery(key, draft)
  const blocked = owner.row.status === 'blocked'
  const scopeId = button.closest('#needsYouList') ? null : button.closest('[id]')?.id ?? null
  if (!scopeId && blocked) keepDraftInView({ kind: 'row', row: owner.row, board: owner.board })
  // no card in the Inbox shows a step that asks nothing: its Plans panel does
  else if (!scopeId) showPlanRow(owner)
  forceRender()
  paintTriageHold()
  const focusEditor = () => {
    const editor = scopeId
      ? document.getElementById(scopeId)?.querySelector(`[data-draft-focus-key="${CSS.escape(`row:${id}`)}"]`)
      : blocked
        ? needsYouRowEl(id)?.querySelector('.reply-input:not(.reply-context-input)')
        : document.querySelector(`#boards [data-row-id="${CSS.escape(id)}"] + .row-panel-row .reply-input`)
    if (!editor) return
    // a step of a plan inside a Stalled fold the person closed: open the fold and the plan first
    if (editor.closest('#boards')) revealDetailsAncestors(editor)
    editor.focus({ preventScroll: true })
    editor.setSelectionRange(editor.value.length, editor.value.length)
    resizeReplyEditor(editor)
  }
  focusEditor()
}

async function copyRecoveryText(text, button) {
  try {
    await navigator.clipboard.writeText(text)
    button.textContent = 'Copied ✓'
  } catch {
    button.textContent = 'Copy failed'
  }
  setTimeout(() => { button.textContent = 'Copy' }, 1500)
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
function pickupMarkHtml(seenAt, seenBy, { clientLabel = false } = {}) {
  const recipient = seenBy ? `${esc(seenBy)}${clientLabel ? ' client' : ''}` : 'an agent'
  const explanation = clientLabel
    ? 'Client label, not a unique session. Delivery does not confirm the asking agent has resumed or acted.'
    : 'Delivery does not confirm the asking agent has resumed.'
  return seenAt
    ? `<span class="pickup picked" title="${esc(explanation)}">Delivered to ${recipient} · ${esc(rel(seenAt))} ago</span>`
    : '<span class="pickup awaiting">Saved · waiting for delivery</span>'
}

function itemAnnotationHtml(receipt) {
  if (!receipt) return ''
  const text = receipt.cleared ? '<strong>Note cleared</strong>' : `<strong>Note:</strong> ${esc(receipt.text)}`
  const pickup = receipt.state === 'waiting' || receipt.state === 'picked'
    ? pickupMarkHtml(receipt.seenAt, receipt.seenBy, { clientLabel: true })
    : `<span class="pickup">${receipt.state === 'closed' ? 'Saved · item closed' : 'Saved · delivery not recorded'}</span>`
  // Keep pickup text outside .annotation, the exact human-text search source.
  return `<div class="item-annotation" data-note-state="${esc(receipt.state)}"><div class="annotation">${text}</div>${pickup}</div>`
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

function sourceOptions(entity, identity = entity) {
  return {
    preview: entity.action_owner === 'approval' && (entity.status === 'open' || entity.status === 'blocked')
      && !(lastData?.closed ?? []).includes(identity.project),
    // issue #103: relationships for open items, plans and their rows; History
    // keeps its plain chip. A row drawn for its plan names its own issue link.
    issues: Array.isArray(identity.rows) || !identity.status || identity.status === 'open' ? issueView : null,
    row: entity === identity ? null : entity,
  }
}

// UX pass, slice 1: one "Details" holds everything but the question, its one
// line of why and its answers: Why it matters and Then first, then who acts and
// the PR, issue and waits chips, then the tracking record.
function cardDetailsHtml(entity, identity, key, presentation, { includeAsked = true } = {}) {
  const metadata = [identity.project, identity.agent, identity.stream].filter(Boolean)
  return `<details class="card-context" data-context-key="${esc(key)}"${openContexts.has(key) ? ' open' : ''}>
    <summary class="card-context-label">Details</summary>
    ${actionWhyHtml(presentation, textContext(identity, entity))}
    ${cardSourcesHtml(entity, identity)}
    <div class="card-tracking-label">Original ${entity.label === undefined ? 'title' : 'label'}</div>
    <div class="card-original-title">${esc(presentation.originalTitle)}</div>
    <div class="meta card-meta">${metadata.map(esc).join(' · ')}</div>
    ${identity.title && entity.label !== undefined ? `<div class="meta">Plan · ${esc(identity.title)} <span class="board-id">#${esc(identity.id.slice(0, 6))}</span></div>` : ''}
    ${entity.next_step && entity.next_step !== presentation.headline ? `<div class="card-recorded-request"><span class="card-tracking-label">Recorded request</span>${renderStructuredText(entity.next_step, textContext(identity, entity))}</div>` : ''}
    ${entity.context ? `<div class="card-context-body">${renderStructuredText(entity.context, textContext(identity, entity))}</div>` : ''}
    ${sourceBlockHtml(linkIndex, identity, Date.now(), sourceOptions(entity, identity))}
    ${lifecycleHtml(entity, { includeAsked })}
    ${historyHtml(entity)}
  </details>`
}

function bindContextDisclosures(root) {
  invalidatePreviewLinks(root)
  bindIssueActivity(root)
  for (const details of root.querySelectorAll('details[data-context-key]')) {
    details.addEventListener('toggle', () => {
      const key = details.dataset.contextKey
      if (!key) return
      details.open ? openContexts.add(key) : openContexts.delete(key)
    })
  }
}

// issue #103 PR3 — an Agent Inbox activity label opens that item, plan or row
// here, through the focusItem path search, deep links and outcomes already use.
function bindIssueActivity(root) {
  for (const button of root.querySelectorAll('button[data-issue-open]')) {
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      openIssueActivity(button.dataset.issueOpen, button.dataset.issueRow)
    })
  }
}

function openIssueActivity(id, rowId) {
  if (triageDeck) closeTriage({ restoreFocus: false })
  if (relayOpen) closeRelay()
  if (missionBoardId) closeMission({ restoreFocus: false })
  focusItem(id, rowId ? { rowId } : null)
}

// The TL;DR, the one line of why an ask shows at rest.
function actionBlocksHtml(presentation, ctx) {
  return presentation.detail ? `<div class="card-tldr"><div class="card-tldr-body">${renderStructuredText(presentation.detail, ctx)}</div></div>` : ''
}

// Why it matters and Then, the first blocks inside Details (cardDetailsHtml).
function actionWhyHtml(presentation, ctx) {
  return `
    ${presentation.impact ? `<div class="card-impact"><div class="card-section-label">Why it matters</div>${renderStructuredText(presentation.impact, ctx)}</div>` : ''}
    ${presentation.nextAfter ? `<div class="card-after"><div class="card-section-label">Then</div>${renderStructuredText(presentation.nextAfter, ctx)}</div>` : ''}`
}

function cardHeadingHtml(presentation, ctx) {
  return `<div class="card-title${presentation.headlineField === 'next-step' ? ' card-next-body' : ''}" role="heading" aria-level="2">${renderStructuredText(presentation.headline, ctx)}</div>`
}

// Issue #300: a bare #N in a card's text resolves against the repository of
// the item, or of the plan a row belongs to; #324: a repo-relative path,
// against the folder that item or plan recorded. #588: a plan row reads its #N
// against its own issue link first (textRepo, shared with the Links strip).
function textContext(identity, entity = identity) {
  // #645: in another Mac's Inbox, a listed file link in this item's or row's text opens its copy
  const owner = hubFileOwner(entity)
  return { ...textRepo(entity, identity), copyFiles: fileLinksCopy(), hubFile: owner ? (path) => hubFileLinkAttrs(path, owner) : null }
}

// Issue #300: the Links strip under the card's origin, listing every link its
// text shows; '' when there is nothing beyond the PR and issue chips above it.
// #634: in another Mac's Inbox, a click on a listed file's chip opens a copy on this Mac (public/hub-files.js).
function cardLinksHtml(entity, identity) {
  const key = `links:${entity.id}`
  const owner = hubFileOwner(entity)
  return linkStripHtml(cardLinks(entity, identity, linkIndex), {
    key, open: openContexts.has(key), actions: linkFileActions(), copyFiles: fileLinksCopy(), hubFiles: owner ? hubFileChips(() => owner) : null,
  })
}

// At rest the origin names the project (where the card shows one), a row's plan
// and the PR and issue chips, which say where an approval stands (and carry an
// approval's Preview); '' when it has none of them. Who acts and a row's waits
// chip are in Details.
function cardOriginHtml(entity, identity, { showProject = true } = {}) {
  const parts = [
    showProject ? `<span>${esc(identity.project)}</span>` : '',
    entity.label !== undefined ? `<span>Plan · ${esc(identity.title)}</span>` : '',
    sourceChipsHtml(linkIndex, identity, Date.now(), { ...sourceOptions(entity, identity), tabbable: true }),
  ].filter((part) => part.trim())
  return parts.length ? `<div class="card-origin">${parts.join('')}</div>` : ''
}

// Inside Details: who acts, and a row's waits chip.
function cardSourcesHtml(entity, identity) {
  const parts = [
    entity.action_owner ? `<span class="action-owner">${esc(actionOwnerLabel(entity))}</span>` : '',
    entity !== identity && Array.isArray(identity.rows) ? rowWaitsChipHtml(entity, identity, Date.now(), { issues: issueView, tabbable: true }) : '',
  ].filter((part) => part.trim())
  return parts.length ? `<div class="card-sources">${parts.join('')}</div>` : ''
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

function outcomeHtml(outcome, at = null, ctx = {}) {
  return outcome
    ? `<div class="outcome-block"><div class="outcome-label">Outcome${at ? `<span class="outcome-age">· ${esc(rel(at))}</span>` : ''}</div>${renderStructuredText(outcome, ctx)}</div>`
    : ''
}

function historyHtml(r) {
  if (!r.history?.length) return ''
  const key = `history:${r.id}`
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
  return `<details class="action-history" data-context-key="${esc(key)}"${openContexts.has(key) ? ' open' : ''}><summary>Prior steps (${r.history.length})</summary>${entries}</details>`
}

// the inline expansion under a matrix row: long context + existing annotation + answer
function rowPanelEl(b, r, readOnly = false) {
  const wrap = document.createElement('div')
  wrap.className = 'row-panel'
  setHintOwner(wrap, r, b)
  const presentation = actionPresentation(r, { done: readOnly })
  wrap.innerHTML = `
    ${cardHeadingHtml(presentation, textContext(b, r))}
    ${cardOriginHtml(r, b)}
    ${actionBlocksHtml(presentation, textContext(b, r))}
    ${cardLinksHtml(r, b)}
    ${rowHumanStateHtml(r)}
    ${outcomeHtml(r.outcome, r.outcome_at, textContext(b, r))}
    ${rowWaitsHtml(r, b, Date.now(), { issues: issueView })}
    ${cardDetailsHtml(r, b, `row:${r.id}`, presentation)}`
  bindContextDisclosures(wrap)
  if (!readOnly) wrap.appendChild(rowAnswerEl(b, r))
  return wrap
}

// `rowCardEl` mounts in TWO places: the triage lightbox (where `triageDeck` is
// open) and, since Task 11, the inline Needs-you accordion (where it is `null`).
// Guard the onSaved callback here, at the definition, so neither call site has
// to know which context it is in — answering a blocked row from the list must
// not throw just because there is no deck to remove it from.
function rowCardEl(b, r, onSaved, { includeAsked = true, header = true } = {}) {
  const wrap = document.createElement('div')
  wrap.className = 'lb-row-card'
  setHintOwner(wrap, r, b)
  const presentation = actionPresentation(r, { done: b.status === 'archived' })
  wrap.innerHTML = `
    ${header ? cardHeadingHtml(presentation, textContext(b, r)) : ''}
    ${cardOriginHtml(r, b, { showProject: header })}
    ${actionBlocksHtml(presentation, textContext(b, r))}
    ${cardLinksHtml(r, b)}
    ${rowHumanStateHtml(r)}
    ${outcomeHtml(r.outcome, r.outcome_at, textContext(b, r))}
    ${cardDetailsHtml(r, b, `row:${r.id}`, presentation, { includeAsked })}`
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
  requestHistoryPaint() // the outcome lane lists every recorded outcome (#184)
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
  const pickup = lifecycleReceipt(entity).find((step) => step.kind === 'pickup')
  if (!pickup?.at) return { text: 'Waiting for delivery', tone: 'awaiting' }
  return agentFollowupChip({
    answered: true,
    pickedUp: true,
    pickedUpAt: pickup.at,
  }, Date.now()) ?? { text: 'Delivered', tone: 'muted' }
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
  jumpToCard('dashboard', entry.row.id)
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

function renderRelayLane(box, lane, entries, {
  count = entries.length, loading = false, wait = { history: true, archived: false },
} = {}) {
  const host = box.querySelector(`[data-relay-lane="${lane}"]`)
  host.querySelector('.relay-count').textContent = String(count)
  const body = host.querySelector('.relay-body')
  body.replaceChildren()
  if (!entries.length && !loading) {
    const empty = document.createElement('div')
    empty.className = 'relay-empty'
    empty.textContent = lane === 'human'
      ? 'Nothing is waiting on you'
      : lane === 'agent' ? 'No handoffs are waiting' : 'No outcomes recorded yet'
    body.appendChild(empty)
    return
  }
  for (const entry of entries) body.appendChild(relayCardEl(entry, lane))
  if (loading) {
    const note = document.createElement('div')
    note.className = 'relay-empty'
    note.setAttribute('role', 'status')
    note.textContent = omittedWaitText('Loading older outcomes…', wait)
    body.appendChild(note)
  }
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
  // Issues #184 and #299: outcomes the page or the archived brief omits still
  // count; until they are read, list only the outcomes none of them could outrank.
  const older = olderHistory(lastData.older, olderLens())
  const archivedOlder = omittedOutcomes(scoped.archived)
  const omitted = older.outcomes + archivedOlder.outcomes
  const latest = [older, archivedOlder].reduce((newest, source) =>
    (source.outcomes > 0 && (newest === null || source.latest > newest) ? source.latest : newest), null)
  const outcomes = relay.outcomes.length + omitted
  renderRelayLane(box, 'outcome', omitted ? knownOutcomes(relay.outcomes, latest) : relay.outcomes,
    { count: outcomes, loading: omitted > 0, wait: { history: older.outcomes > 0, archived: archivedOlder.outcomes > 0 } })
  box.querySelector('.relay-summary').textContent =
    `${relay.human.length} waiting on you · ${relay.agent.length} with agent · ${outcomes} outcomes`
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
  const active = activeFocusElement()
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
  // the step itself is the target: its plan opens in full and a done step shows
  focusItem(board.id, { rowId: row.id })
  requestAnimationFrame(() => {
    const target = document.querySelector(`#boards [data-row-id="${CSS.escape(row.id)}"]`)
    target?.scrollIntoView({ behavior: motion.scrollBehavior(), block: 'center' })
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

// Slice 2 §9.2: a "Waits on"/"Unblocks" button is explicit navigation, so it
// moves focus to that step and may scroll the flow to reveal it. A poll's
// restoration never comes here.
function focusMissionStep(rowId) {
  const path = document.querySelector(`#missionbox .mission-path[data-row-id="${CSS.escape(rowId)}"]`)
  const target = path?.querySelector('.mission-node-open')
  if (!target) return
  target.focus({ preventScroll: true })
  revealControl(path.querySelector('.mission-node') ?? target, missionPanel())
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
    ${missionDepsHtml(path, board)}
    ${row.impact ? `<div class="mission-node-impact"><span>Why now</span>${renderStructuredText(row.impact)}</div>` : ''}`
  action.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('a, button')) return
    openMissionDetail(row)
  })
  for (const step of action.querySelectorAll('button[data-mission-step]')) {
    step.addEventListener('click', (event) => {
      event.stopPropagation()
      focusMissionStep(step.dataset.missionStep)
    })
  }
  bindIssueActivity(action)
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
  const board = [...lastData.boards, ...wholeArchived()].find((candidate) => candidate.id === missionBoardId)
  if (!board) {
    // An archived plan's flow stays as last drawn while its complete rows are
    // not loaded (#299): archivedWanted keeps reading them while it is open.
    if (omitsArchived() && lastData.archivedBrief.some((plan) => plan.id === missionBoardId)) return
    closeMission()
    return
  }
  const box = document.getElementById('missionbox')
  // the frame's issue view, as Plans draws it; nothing here fetches (§9.4)
  const mission = buildMission(board, { issues: issueView, links: linkIndex })
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
  const outsideKey = `mission-outside:${board.id}`
  const outside = missionOutsideHtml(mission.outside, board, { key: outsideKey, open: openContexts.has(outsideKey) })
  if (outside) {
    const foot = document.createElement('div')
    foot.className = 'mission-outside-foot'
    foot.innerHTML = outside
    // its open state and activity labels, as every Background disclosure's
    bindContextDisclosures(foot)
    paths.appendChild(foot)
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
  card.scrollIntoView({ behavior: motion.scrollBehavior(), block: 'start' })
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
function selectTab(id, { paint = true, open = true } = {}) {
  // the Agent cards tab exists only while it shows (agentCardsShown): a key, link or stale caller does nothing
  if (!TAB_IDS.includes(id) || (id === 'cards' && !agentCardsShown())) return
  const from = activeTab
  // Choosing a tab supersedes a deep link still waiting on older history or
  // archived plans, and leaving History releases the omitted target it was
  // keeping loaded (#184, #299).
  historyLookup = null
  archivedLookup = null
  agentCardsLink = null
  if (from === 'find' && id !== 'find') leaveFind()
  activeTab = id
  if (id === 'find' && from !== 'find') enterFind()
  // the Review queue's hold line is in Home's list header: leaving Home ends it
  if (id !== 'dashboard') triageHeld = false
  // entering Home from another tab brings the first waiting ask forward again
  if (id === 'dashboard' && from !== 'dashboard') frontClosed = false
  for (const t of document.querySelectorAll('#tabs .tab')) {
    t.setAttribute('aria-selected', String(t.dataset.tab === id))
    t.tabIndex = t.dataset.tab === id ? 0 : -1 // roving tabindex (spec §13)
  }
  // the narrow tab row scrolls sideways when its tabs do not fit: the chosen tab is brought into
  // it (only on a choice, never on a repaint)
  document.querySelector(`#tabs .tab[data-tab="${id}"]`)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  // Settings covers the active tab without changing it, so "entered" is the panel showing (#586):
  // entering Find reads the chats under their 60-second rule (step B)
  const findWasHidden = document.getElementById('find').hidden
  showPanel(id)
  if (id === 'find' && findWasHidden) chatsView.opened()
  if (paint) {
    forceRender()
    requestHistoryPaint()
  }
  if (id === 'dashboard') restoreRowSelection(false)
  // An open, from the last known /api/version (Agent cards step 1, D5): entering the Agent cards
  // from another tab, never re-selecting it. The first entry, with nothing read yet, reads now
  // instead of waiting for the next tick.
  if (open && id === 'cards' && from !== 'cards') {
    meshOpen()
    if (!lastData?.mesh?.body) reloadAndPaint()
    // step 2b (D2): the model servers are asked on entering, never on a timer
    meshSetup.entered()
  }
}

function initTabs() {
  for (const t of document.querySelectorAll('#tabs .tab')) {
    t.addEventListener('click', () => {
      const touch = findEntryTouch
      findEntryTouch = false
      selectTab(t.dataset.tab)
      // UX pass, slice 4: Find's field takes focus on every entry but one made by touch
      if (t.dataset.tab === 'find' && !touch) focusFindField()
    })
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

// An empty kicker draws nothing.
const PAGE_META = {
  dashboard: { kicker: '', title: 'Home' },
  boards: { kicker: '', title: 'Plans' },
  // the heading stays for structure and is visually hidden: Find's field is what shows first
  find: { kicker: '', title: 'Find' },
  // with an agent's page open, the kicker is the tab and the title the agent's name
  cards: { kicker: '', title: 'Agent cards' },
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
    // An ask that came to the front by itself and that the person has not touched (no click on
    // its row, no focus in it, no unsent answer) does not stay open as an inline card or a
    // phone sheet nobody asked for when the window turns narrow.
    if (next === 'narrow' && frontAutoId !== null && openRowId === frontAutoId && !holdsDraft(frontAutoId)
      && !needsYouRowEl(frontAutoId)?.contains(activeFocusElement())) setOpenRow(null, { resume: false })
    layout = next
    syncAskFront()
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
  const visibleModal = keyboardScope() !== document
  return !!(
    triageDeck
    || missionDetailRowId
    || missionBoardId
    || relayOpen
    || document.body.classList.contains('settings-open')
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
    const active = activeFocusElement()
    const activeFocusState = projectFocusState(active)
    const focusState = activeFocusState
      ?? (active === document.body ? projectFocusBookmark : null)
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
    requestHistoryPaint()
  })
  // the keyboard half of close/reopen, since the button itself is out of the tab
  // order. `ev` is the keyboard event; `e` is the rail entry — do not merge them.
  // #412: a reserved project (`@sessions`, `@mesh`) holds driven sessions'
  // approvals and can never be archived, so it gets no control and no key
  const archivable = e.key !== '__all__' && (closed || !isReservedProject(e.key))
  if (archivable) b.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Delete' && ev.key !== 'Backspace') return
    ev.preventDefault()
    closed
      ? reopenProjectAction(e.key)
      : closeProjectAction(e.key, { focusArchived: tabletProjectsMode() })
  })
  wrap.appendChild(b)
  // 'All' is not a project and cannot be retired
  if (archivable) wrap.appendChild(railActionEl(e, closed))
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
    requestHistoryPaint()
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
  text.textContent = `${name} is closed — these items are not included in your Needs you count or Review queue.`
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
    older: lastData.older?.older ?? [],
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
  const active = activeFocusElement()
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
    requestHistoryPaint()
  })
}

// The top bar's kicker and title for the panel showing; the Agent cards names an open agent.
function paintPageHeading(id) {
  const page = PAGE_META[id] ?? PAGE_META.dashboard
  // an open set-up page's title (step 2b), else the open agent's name
  const named = id === 'cards' ? (meshSetup.open() ? meshSetup.title() : meshAgentPage.current()?.name ?? null) : null
  const kicker = document.getElementById('pageKicker')
  setText(kicker, named ? page.title : page.kicker)
  setHidden(kicker, !kicker.textContent)
  setText(document.getElementById('pageTitle'), named ?? page.title)
}

// which content panel is visible; the tab strip drives this in Task 8
function showPanel(id) {
  if (id !== 'setup') {
    settingsFromHub = false
    settingsFocusWhenUncovered = null
  }
  const openingSettings = id === 'setup' && document.getElementById('setup').hidden
  const panel = id
  // Home is two panels, the list of asks and then the lanes, shown and hidden together
  const shows = (p) => p.id === panel || (panel === 'dashboard' && p.id === 'needsYou')
  for (const p of document.querySelectorAll('main > .panel')) p.hidden = !shows(p)
  for (const t of document.querySelectorAll('#tabs .tab')) t.setAttribute('aria-selected', String(t.dataset.tab === id))
  document.body.classList.toggle('settings-open', id === 'setup')
  paintPageHeading(id)
  // UX pass, slice 4: on Find its own field stands in for the top bar's search and its heading
  document.getElementById('pageTitle').classList.toggle('visually-hidden', id === 'find')
  const topSearch = document.querySelector('#topbar .floating-search')
  if (topSearch) topSearch.hidden = id === 'find'
  syncAskFront()
  const gear = document.getElementById('gear')
  gear.classList.toggle('active', id === 'setup')
  gear.setAttribute('aria-pressed', String(id === 'setup'))
  // #197: a terminal install or an update can change what each host runs while
  // the app is open, so Settings re-reads it whenever it opens; #216: so can
  // whether this window may run one-click Setup, after a reload, and (#300)
  // whether it may open local files
  if (openingSettings) {
    refreshAgents()
    refreshSetupAvailability()
    refreshLinkPermission()
    refreshLinkSettings()
    refreshLaunchSettings()
    refreshRemoteSettings()
    refreshConnectSettings()
  }
}

function settingsOpen() {
  return !document.getElementById('setup').hidden
}

// #617: Settings… was chosen while another Mac's Inbox was on top, so main brought This Mac's page
// forward to show them. Closing them (the shortcut, the gear, Escape) shows that Inbox again. Going
// anywhere else on this page, or that Inbox coming back on top by another way, forgets it.
let settingsFromHub = false
// What gets the keyboard once the strip no longer covers this page. When main's message arrives the
// page is still inert under the strip, and focus() on an inert element does nothing; the strip
// uncovers it a moment later, when main's answer to view() comes back (installHubStrip, onShowing).
let settingsFocusWhenUncovered = null

// no scroll: Settings left open underneath stay where the person had them
function focusForSettings(element) {
  element.tabIndex = -1
  element.focus({ preventScroll: true })
  settingsFocusWhenUncovered = element
}

async function showHubAgain() {
  const api = window.agentInboxConnect
  if (!api || typeof api.view !== 'function' || typeof api.show !== 'function') return
  try {
    const view = await api.view()
    const hub = view !== null && typeof view === 'object' && view.available === true ? view.hub : null
    if (hub !== null && typeof hub === 'object' && typeof hub.id === 'string') await api.show(hub.id)
  } catch {
    // This Mac stays on screen
  }
}

// `back`: this close is the person closing Settings, not a move to somewhere else on this page
function closeSettings({ restoreFocus = false, back = false } = {}) {
  if (!settingsOpen()) return false
  const toHub = back && settingsFromHub
  selectTab(activeTab)
  if (restoreFocus) document.getElementById('gear').focus()
  if (toHub) void showHubAgain()
  return true
}

// `fromHub` is exactly true only from main (electron/setup-preload.cjs); a click passes its event
function toggleSettings(fromHub) {
  if (fromHub === true) {
    // never a toggle: Settings left open under the other Mac's Inbox would close, and say nothing
    if (!settingsOpen()) showPanel('setup')
    settingsFromHub = true
    // the keyboard was in the other Mac's view: it comes to Settings
    focusForSettings(document.getElementById('setup'))
    return
  }
  if (!closeSettings({ back: true })) showPanel('setup')
}

// `fromHub` as for toggleSettings: Check for Updates… chosen while another Mac's Inbox was on top
function openUpdates(fromHub) {
  if (!settingsOpen()) showPanel('setup')
  if (fromHub === true) settingsFromHub = true
  const section = document.getElementById('updates-settings')
  if (!section) {
    if (fromHub === true) focusForSettings(document.getElementById('setup'))
    return
  }
  section.scrollIntoView({ block: 'center' })
  section.focus()
  // under the strip that focus() did nothing: again once the page is uncovered
  if (fromHub === true) settingsFocusWhenUncovered = section
  window.agentInboxUpdates?.check?.().catch(() => {})
}

function initGear() {
  document.getElementById('gear').addEventListener('click', toggleSettings)
  window.agentInboxSetup?.onToggleSettings?.(toggleSettings)
  window.agentInboxUpdates?.onOpenUpdates?.(openUpdates)
}

// Issue #197 — the /api/version body: the build a restarted session would load,
// the runtime state and what each host is registered to run, which together
// decide which advice the hint may give. Read at boot, whenever the session panel
// opens and after a Setup install, so the advice follows an install made since. It
// stays null when the viewer cannot say, and then no hint renders.
let liveVersion = null

function refreshLiveVersion() {
  return fetch('/api/version')
    .then((r) => (r.ok ? r.json() : null))
    .then((body) => {
      liveVersion = body && typeof body === 'object' ? body : null
      if (liveVersion?.mesh) meshOff = false
    })
    .catch(() => {})
    // step 2b (D1): whether this Mac's app can set an agent up decides the tab too, so it is known first
    .then(() => meshSetup.refreshAvailable())
    .catch(() => {})
    // the Agent cards tab follows the read at once; a deep link that waited on it lands now
    .then(() => {
      versionSettled = true
      paintAgentCards()
      applyAgentCardsLink()
    })
}

// ── messages to a running session (#411, design §5) ─────────────────────────
// One composer per session, in the Dashboard's session panel (#454: the Live
// drawer that also held one is retired). The composer is
// one node kept for the page's life and updated in place, so a rebuild around
// it never loses its text, caret or focus. Presence, not attention: nothing here
// reaches public/attention.js, a badge, a count, the rail or the dock.
const messageDrafts = new Map() // session → { text, project, agent, stream, intent: { id, text } | null }
const messageRecoveries = new Map() // session → { ...draft, reason }: in the unsent responses
const messageNotes = new Map() // session → what its composer's status slot says
const messageWriteNotes = new Map() // message id → why its Withdraw was refused
const composerEls = new Map() // `${where}:${session}` → its composer node
const sendingMessages = new Set() // sessions with a send in flight
const openMessageFolds = new Set() // "+N earlier" and "+M more" folds the human opened
let composerSeq = 0

function bumpMessages() {
  showPauseHint() // queues the draft save (#279)
}

function activityRow(session) {
  return (lastData?.activity ?? []).find((row) => row?.session === session) ?? null
}

function composerEl(where, session) {
  const key = `${where}:${session}`
  const held = composerEls.get(key)
  if (held) return held
  const el = document.createElement('div')
  el.className = 'msg-composer'
  el.dataset.msgSession = session
  el.dataset.msgHost = where
  const id = `msgInput${++composerSeq}`
  el.innerHTML = `
    <label class="msg-label" for="${id}"></label>
    <textarea id="${id}" class="msg-input" rows="3" maxlength="${MESSAGE_MAX_TEXT}" aria-describedby="${id}Delivery ${id}Shared"></textarea>
    <p class="msg-delivery" id="${id}Delivery"></p>
    <p class="msg-shared" id="${id}Shared"></p>
    <div class="msg-actions">
      <span class="msg-count"></span>
      <button type="button" class="msg-send" title="Send (${navigator.platform?.startsWith('Mac') ? '⌘' : 'Ctrl'}+Enter)">Send</button>
    </div>
    <p class="msg-status" role="status"></p>
    <div class="msg-history"></div>`
  const input = el.querySelector('textarea')
  input.value = messageDrafts.get(session)?.text ?? ''
  input.addEventListener('input', () => setMessageDraft(session, input.value, input))
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) {
      event.preventDefault()
      sendMessage(session)
    }
  })
  el.addEventListener('click', (event) => {
    const control = event.target instanceof Element ? event.target.closest('button') : null
    if (!control || !el.contains(control)) return
    if (control.matches('.msg-send')) sendMessage(session)
    else if (control.matches('.msg-interrupt')) interruptAndSend(session)
    else if (control.dataset.msgWithdraw) withdrawMessage(control.dataset.msgWithdraw, Number(control.dataset.msgRevision))
  })
  el.addEventListener('toggle', (event) => {
    const fold = event.target
    if (!(fold instanceof HTMLDetailsElement) || !fold.dataset.msgFold) return
    if (fold.open) openMessageFolds.add(fold.dataset.msgFold)
    else openMessageFolds.delete(fold.dataset.msgFold)
  }, true)
  composerEls.set(key, el)
  return el
}

// One session's history, newest first: the human's words, then a status line;
// an acknowledgement's outcome is agent text and renders as such.
function messageHistoryHtml(session) {
  const { shown, earlier } = sessionMessages(lastData?.messages, session)
  const line = (message) => {
    const status = messageStatus(message, (iso) => rel(iso))
    const note = messageWriteNotes.get(message.id)
    return `<div class="msg-item ${status.tone}" data-msg-id="${esc(message.id)}">` +
      `<p class="msg-text">${esc(message.text)}</p>` +
      `<p class="msg-state">${esc(status.text)}</p>` +
      (status.outcome !== null ? `<div class="msg-outcome">${renderStructuredText(status.outcome)}</div>` : '') +
      (note ? `<p class="msg-refused">${esc(note)}</p>` : '') +
      (status.withdrawable
        ? `<button type="button" class="msg-withdraw" data-msg-withdraw="${esc(message.id)}" data-msg-revision="${message.revision}">Withdraw</button>`
        : '') +
      '</div>'
  }
  if (!shown.length) return ''
  const foldKey = `earlier:${session}`
  return shown.map(line).join('') + (earlier.length
    ? `<details class="msg-earlier" data-msg-fold="${esc(foldKey)}"${openMessageFolds.has(foldKey) ? ' open' : ''}>` +
      `<summary>+${earlier.length} earlier</summary>${earlier.map(line).join('')}</details>`
    : '')
}

const composerHistoryHtml = new WeakMap()

function updateComposer(el) {
  const session = el.dataset.msgSession
  const row = activityRow(session)
  const draft = messageDrafts.get(session)
  const delivery = deliveryState(row, rel)
  const input = el.querySelector('textarea')
  const text = draft?.text ?? ''
  if (input.value !== text && document.activeElement !== input) input.value = text
  setText(el.querySelector('.msg-label'), composerLabel(row ?? draft ?? {}))
  const deliveryEl = el.querySelector('.msg-delivery')
  setText(deliveryEl, delivery.text)
  setAttr(deliveryEl, 'data-state', delivery.state)
  setText(el.querySelector('.msg-shared'), delivery.canSend ? MESSAGE_SHARED : '')
  const sending = sendingMessages.has(session)
  // written only on a change, so an unchanged paint writes nothing at all
  if (input.disabled !== !delivery.canSend) input.disabled = !delivery.canSend
  const length = input.value.length
  setText(el.querySelector('.msg-count'), `${length} / ${MESSAGE_MAX_TEXT}`)
  const send = el.querySelector('.msg-send')
  const blocked = !delivery.canSend || sending || !input.value.trim()
  if (send.disabled !== blocked) send.disabled = blocked
  setText(send, sending ? 'Sending…' : 'Send')
  paintInterrupt(el, session, row, delivery, blocked)
  setText(el.querySelector('.msg-status'), messageNotes.get(session) ?? '')
  const history = el.querySelector('.msg-history')
  const html = messageHistoryHtml(session)
  if (composerHistoryHtml.get(history) === html) return
  composerHistoryHtml.set(history, html)
  const focused = activeFocusElement()
  const withdrawFocus = focused && history.contains(focused) ? focused.dataset?.msgWithdraw ?? null : null
  history.innerHTML = html
  if (withdrawFocus && document.hasFocus()) {
    // matched by value, never through a selector built from the id
    ;([...history.querySelectorAll('[data-msg-withdraw]')].find((b) => b.dataset.msgWithdraw === withdrawFocus)
      ?? el.querySelector('textarea'))?.focus({ preventScroll: true })
  }
}

function setMessageDraft(session, text, source = null) {
  const row = activityRow(session)
  const draft = messageDrafts.get(session)
  if (!text.trim()) {
    // an emptied composer holds no draft, and nothing left to retry or explain
    if (draft) messageDrafts.delete(session)
    messageNotes.delete(session)
  } else {
    messageDrafts.set(session, {
      project: row?.project ?? draft?.project ?? '',
      agent: row?.agent ?? draft?.agent ?? '',
      stream: row?.stream ?? draft?.stream ?? '',
      intent: draft?.intent ?? null,
      text,
    })
  }
  // the session's other composer shows the same draft
  for (const [key, el] of composerEls) {
    if (!key.endsWith(`:${session}`) || el.dataset.msgSession !== session) continue
    const input = el.querySelector('textarea')
    if (input !== source && input.value !== text) input.value = text
    updateComposer(el)
  }
  bumpMessages()
}

// A draft that was sent leaves every composer of its session, the focused one too
// (updateComposer leaves a focused textarea alone, so typing is never overwritten).
function clearComposerText(session) {
  for (const el of composerEls.values()) {
    if (el.dataset.msgSession === session) el.querySelector('textarea').value = ''
  }
}

function updateSessionComposers(session) {
  for (const el of composerEls.values()) if (el.dataset.msgSession === session) updateComposer(el)
}

// Issue #412 step 3: driven sessions on the page. Made at boot; it asks main
// once (window.agentInboxLaunch), and only the viewer the app owns, with its
// switch on, gets anything: in a browser, a reused viewer or with the switch
// off it reads, draws and binds nothing (§9 b).
function initLaunches() {
  launchUi = createLaunchUi({
    fetchJson: (url) => fetch(url).then((r) => (r.ok ? r.json() : null)),
    postJSON,
    activity: () => lastData?.activity ?? [],
    launches: () => lastData?.launches ?? null,
    rel,
    sendTo: async (session, text) => {
      // the resumed session is new to this page: read it before sending
      await reloadAndPaint()
      setMessageDraft(session, text)
      return sendMessage(session)
    },
    changed: () => {
      noteOutsideChange()
      showPauseHint()
      // the session panel holds the launch's parts: its own region repaints
      paintSessionFocus()
      agentsHome.paintNewSession()
    },
    settled: () => reloadAndPaint(),
    // #478: a forgotten launch's panel has nothing left to show
    forgotten: (id) => { if (focusSession === `launch:${id}`) closeSessionFocus() },
    // a session started outside the lens would have no card: scope the lens to it
    started: (id) => { if (scopeToLaunch(id)) forceRender() },
    // #586 phase 2: a continued chat's session, once started, opens as Show session opens it
    showLaunch: (id) => openSessionFocus(`launch:${id}`),
    // the session panel's "Continued from a Copilot chat" line: Find with the Chats chip
    openChats: () => openChatsInFind(),
    pending: (action) => withPendingResponse(action),
  })
  // a changed answer is drawn by the next tick, which reads the launches once on
  launchUi.refresh()
}

function postMessage(session, intent) {
  return postJSON(`/api/sessions/${encodeURIComponent(session)}/messages`, { id: intent.id, text: intent.text })
}

// A send claims an id once and reuses it while its text is unchanged, so a
// retry after an unconfirmed send replays exactly and never sends twice.
function claimMessageIntent(draft) {
  if (!draft.intent || draft.intent.text !== draft.text) draft.intent = { id: globalThis.crypto.randomUUID(), text: draft.text }
  return draft.intent
}

const REFUSALS = new Set(['session_gone', 'session_cannot_receive', 'too_many_open', 'too_much_open', 'id_conflict'])

async function sendMessage(session) {
  const draft = messageDrafts.get(session)
  if (!draft?.text.trim() || sendingMessages.has(session) || !deliveryState(activityRow(session)).canSend) return false
  const intent = claimMessageIntent(draft)
  sendingMessages.add(session)
  messageNotes.delete(session)
  // stored before it goes, so a page that dies mid-send still knows its id
  saveDrafts()
  updateSessionComposers(session)
  bumpMessages()
  let result = null
  try {
    result = await withPendingResponse(() => postMessage(session, intent))
  } finally {
    sendingMessages.delete(session)
  }
  const current = messageDrafts.get(session)
  if (result?.ok === true) {
    // sent: the draft goes, unless the human typed something else meanwhile
    if (current?.text === intent.text) {
      messageDrafts.delete(session)
      clearComposerText(session)
    } else if (current) current.intent = null
  } else if (result?.ok === false && REFUSALS.has(result.reason)) {
    if (current?.intent?.id === intent.id) current.intent = null
    messageNotes.set(session, refusalText(result))
  } else {
    messageNotes.set(session, MESSAGE_UNCONFIRMED)
  }
  bumpMessages()
  await reloadAndPaint()
  return result?.ok === true
}

// #412 step 3 (§5.3): the running launch a driven session belongs to, while
// the switch is on; the composer offers Interrupt and send only for it.
function interruptibleLaunch(row) {
  if (!launchesOn() || typeof row?.driven_launch !== 'string') return null
  return (lastData?.launches ?? []).find((launch) => launch.id === row.driven_launch && launch.status === 'running' && !launch.stop_requested_at) ?? null
}

// Made only when it applies, so a page with the switch off adds no control.
function paintInterrupt(el, session, row, delivery, blocked) {
  let button = el.querySelector('.msg-interrupt')
  const launch = delivery.interrupt ? interruptibleLaunch(row) : null
  if (!launch) {
    button?.remove()
    return
  }
  if (!button) {
    button = document.createElement('button')
    button.type = 'button'
    button.className = 'msg-interrupt'
    button.textContent = 'Interrupt and send'
    button.title = 'Cancel what it is doing now, then send this'
    el.querySelector('.msg-send').after(button)
  }
  if (button.disabled !== blocked) button.disabled = blocked
}

// Interrupt and send: the message goes first, then the driver is asked to
// cancel the running turn; it sends the message framed with the interrupt notice.
async function interruptAndSend(session) {
  const launch = interruptibleLaunch(activityRow(session))
  if (!launch) return
  if (!(await sendMessage(session))) return
  const result = await withPendingResponse(() => postJSON(`/api/launches/${encodeURIComponent(launch.id)}/interrupt`))
  if (result?.ok !== true) {
    messageNotes.set(session, 'Sent, but the session could not be interrupted: it arrives when the turn ends.')
    bumpMessages()
    updateSessionComposers(session)
  }
}

async function withdrawMessage(id, revision) {
  if (!Number.isSafeInteger(revision)) return
  const result = await withPendingResponse(() => postJSON(`/api/messages/${encodeURIComponent(id)}/withdraw`, { revision }))
  if (result?.ok === true) messageWriteNotes.delete(id)
  else messageWriteNotes.set(id, result ? refusalText(result, 'withdraw') : 'Not withdrawn: the viewer did not answer.')
  bumpMessages()
  await reloadAndPaint()
}

// Every applied frame: a draft whose send the snapshot now holds was sent
// (an unconfirmed send that did land), and a draft whose session is no longer
// listed, or cannot receive, moves to the unsent responses with its reason.
function reconcileMessageDrafts() {
  const snapshot = lastData?.messages ?? null
  let changed = false
  const sent = (draft) => Boolean(snapshot && draft.intent && draft.intent.text === draft.text && snapshotHolds(snapshot, draft.intent.id))
  for (const [session, draft] of messageDrafts) {
    if (sendingMessages.has(session)) continue
    if (sent(draft)) {
      messageDrafts.delete(session)
      messageNotes.delete(session)
      clearComposerText(session)
      changed = true
      continue
    }
    const delivery = deliveryState(activityRow(session))
    // one in the unsent responses already: this one stays a draft, still stored
    // under its own key, rather than overwrite it
    if (delivery.canSend || messageRecoveries.has(session)) continue
    messageDrafts.delete(session)
    messageRecoveries.set(session, { ...draft, reason: messageRecoveryReason(delivery, draft) })
    changed = true
  }
  for (const [session, draft] of messageRecoveries) {
    if (sendingMessages.has(session)) continue
    if (sent(draft)) {
      messageRecoveries.delete(session)
      changed = true
      continue
    }
    // its session is listed and can receive again (it came back within the
    // presence window): the text goes back to its composer, unless one already
    // holds a draft, in which case both stay, each under its own stored key.
    // Never into a composer the human is typing in: updateComposer leaves a
    // focused textarea alone, so the next keystroke would replace the text unseen.
    if (messageDrafts.has(session) || composerFocused(session) || !deliveryState(activityRow(session)).canSend) continue
    const { reason: _reason, ...text } = draft
    messageRecoveries.delete(session)
    messageDrafts.set(session, text)
    if (text.intent?.text === text.text) messageNotes.set(session, MESSAGE_UNCONFIRMED)
    changed = true
  }
  // a composer whose session left is not kept once nothing shows it
  for (const [key, el] of composerEls) {
    if (!el.isConnected && !activityRow(el.dataset.msgSession)) composerEls.delete(key)
  }
  if (!changed) return
  for (const el of composerEls.values()) updateComposer(el)
  bumpMessages()
}

function messageRecoveryReason(delivery, draft) {
  const where = delivery.state === 'cannot' ? 'this session can’t receive messages' : 'this session is no longer running'
  return draft.intent && draft.intent.text === draft.text ? `Your send was not confirmed, and ${where}` : `Not sent: ${where}`
}

// An unsent message's Retry (design §5): the id it last claimed while its text
// is unchanged, so a send that did land replays and is not sent twice.
async function retryMessageRecovery(session) {
  const draft = messageRecoveries.get(session)
  if (!draft || sendingMessages.has(session)) return
  const intent = claimMessageIntent(draft)
  sendingMessages.add(session)
  saveDrafts()
  bumpMessages()
  let result = null
  try {
    result = await withPendingResponse(() => postMessage(session, intent))
  } finally {
    sendingMessages.delete(session)
  }
  if (result?.ok === true) messageRecoveries.delete(session)
  else if (result?.ok === false && REFUSALS.has(result.reason)) {
    draft.intent = null
    draft.reason = refusalText(result).replace(/\.$/, '')
  } else draft.reason = 'Your send was not confirmed'
  bumpMessages()
  await reloadAndPaint()
}

// The Quiet lane's "Not delivered" fold (#411, #454): every open message whose
// session /api/activity no longer lists, until the human withdraws it or a later
// send's 30-day prune deletes it. Global, like the Sessions line: a lens never
// hides an undelivered message. Rebuilt only when what it shows changes, keeping
// a keyboard user's control.
function paintUndelivered(slot) {
  const lost = undeliveredMessages(lastData?.messages, lastData?.activity)
  const key = JSON.stringify([[...lost.shown, ...lost.more].map((m) => [m.id, m.revision, messageWriteNotes.get(m.id) ?? '']),
    Math.floor(Date.now() / 60000)])
  if (slot.dataset.key === key) return
  slot.dataset.key = key
  const focused = activeFocusElement()
  const focusKey = focused && slot.contains(focused) ? focused.closest('[data-dashboard-focus-key]')?.dataset.dashboardFocusKey ?? null : null
  const fold = undeliveredFold((value) => `data-dashboard-focus-key="${esc(`ah:${value}`)}"`)
  slot.replaceChildren(...(fold ? [fold] : []))
  if (!focusKey || !document.hasFocus()) return
  ;[...slot.querySelectorAll('[data-dashboard-focus-key]')].find((el) => el.dataset.dashboardFocusKey === focusKey)?.focus({ preventScroll: true })
}

function undeliveredFold(focusAttr) {
  const lost = undeliveredMessages(lastData?.messages, lastData?.activity)
  if (!lost.total) return null
  const fold = document.createElement('details')
  fold.className = 'msg-undelivered'
  fold.dataset.msgFold = 'undelivered'
  fold.open = openMessageFolds.has('undelivered')
  const line = (message) => {
    const note = messageWriteNotes.get(message.id)
    return `<div class="msg-item msg-lost" data-msg-id="${esc(message.id)}">` +
      `<p class="msg-lost-who">${esc(composerLabel(message))}</p>` +
      `<p class="msg-text">${esc(message.text)}</p>` +
      `<p class="msg-state">${esc(undeliveredReason(message))} · sent ${esc(rel(message.created_at))} ago</p>` +
      (note ? `<p class="msg-refused">${esc(note)}</p>` : '') +
      `<span class="msg-lost-actions"><button type="button" data-msg-copy="${esc(message.id)}" ${focusAttr(`copy:${message.id}`)}>Copy text</button>` +
      `<button type="button" class="msg-withdraw" data-msg-withdraw="${esc(message.id)}" data-msg-revision="${message.revision}" ${focusAttr(`withdraw:${message.id}`)}>Withdraw</button></span>` +
      '</div>'
  }
  fold.innerHTML = `<summary ${focusAttr('undelivered')}>Not delivered (${lost.total})</summary>` + lost.shown.map(line).join('') + (lost.more.length
    ? `<details class="msg-earlier" data-msg-fold="undelivered-more"${openMessageFolds.has('undelivered-more') ? ' open' : ''}>` +
      `<summary ${focusAttr('undelivered-more')}>+${lost.more.length} more</summary>${lost.more.map(line).join('')}</details>`
    : '')
  fold.addEventListener('toggle', (event) => {
    const target = event.target
    if (!(target instanceof HTMLDetailsElement) || !target.dataset.msgFold) return
    if (target.open) openMessageFolds.add(target.dataset.msgFold)
    else openMessageFolds.delete(target.dataset.msgFold)
  }, true)
  fold.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('button') : null
    if (!button) return
    if (button.dataset.msgWithdraw) withdrawMessage(button.dataset.msgWithdraw, Number(button.dataset.msgRevision))
    else if (button.dataset.msgCopy) {
      const message = (lastData?.messages?.open ?? []).find((m) => m.id === button.dataset.msgCopy)
      if (message) writeClipboard(document, message.text)
    }
  })
  return fold
}

// ── the Sessions indicator (#454, design §3.5) ──────────────────────────────
// The sidebar's one session signal on every tab, where the Live strip was: a
// dot with the freshest working session's tone, "2 working · 5 connected" and
// "1 on an older build". Global (never lens- or closed-filtered), presence only:
// no attention tone, badge or "needs you" number. A click opens the Dashboard
// with its Working lane's heading focused. Ambient: it never steals focus.
function renderSessionsIndicator(activity) {
  const el = document.getElementById('sessionsIndicator')
  if (!el) return
  const s = sessionsSummary(activity, Date.now(), (row) => sessionBuild(row, liveVersion))
  setAttr(el, 'data-tone', s.tone)
  setText(el.querySelector('.si-v'), s.label)
  setText(el.querySelector('.si-s'), s.sub)
  const older = el.querySelector('.si-older')
  setText(older, s.older ? `${s.older} on an older build` : '')
  setHidden(older, !s.older)
  const title = ['Sessions', s.label, s.sub, older.textContent].filter(Boolean).join(' · ')
  setAttr(el, 'title', title)
  setAttr(el, 'aria-label', `${title}. Show the sessions on Home`)
}


// The indicator and G L: Home, its Working lane's heading focused.
// Each re-reads the build state (#197), as opening the Live drawer did; the next tick paints it.
function showAgentsHome() {
  refreshLiveVersion()
  if (activeTab !== 'dashboard') selectTab('dashboard')
  const title = document.getElementById('workingLaneTitle')
  title?.scrollIntoView?.({ block: 'nearest' })
  title?.focus({ preventScroll: true })
}

function initSessionsIndicator() {
  document.getElementById('sessionsIndicator')?.addEventListener('click', showAgentsHome)
  // #197: read outside the poll; the next paint shows the build hints. A failed
  // or older viewer leaves the build state unknown, which hides every hint.
  // Booting is never an open (Agent cards step 1, D5): only entering the Agent cards is.
  refreshLiveVersion()
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
  if (stagedDismiss.has(id) || isLaunchAskItem(freshItem(id))) return
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
    sendReply(id, label, context, 'answer', generation, intent)
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
let askSort = savedAskSort()
let needsYouHeaderNode = null
// UX pass, slice 2: the filters, Sort, Handoffs and Review queue rest out of
// sight behind the header's Filter toggle (in memory only). They show whatever
// the toggle says while a filter or a non-default sort is in force.
let queueToolsOpen = false
// the asks in the list that still wait on the person, under the lens and the
// filters (not the answered foot, not the folds); painted with the ambient frame
let queueWaitingCount = 0

function queueToolsForced() {
  return actionFilter !== 'all' || changedOnly || askSort !== savedAskSort()
}

// Show the tools before anything focuses one of their controls: a hidden
// control is never a focus target.
function showQueueTools() {
  if (queueToolsOpen) return
  queueToolsOpen = true
  if (needsYouHeaderNode) syncNeedsYouHeader(needsYouHeaderNode)
}

function focusQueueControl(el) {
  if (!el) return
  if (el.closest('.queue-tools')) showQueueTools()
  el.focus({ preventScroll: true })
}

// The ambient count (#needsYouTitle's): a poll held back by a draft or a press
// still keeps it current, as the badge and the tab count are.
function paintQueueCount(g, boardsInView) {
  const items = g.needsYou.flatMap((gr) => gr.items)
  queueWaitingCount = filterActionEntries(attentionEntries(items, boardsInView, Date.now(), liveSessionIds())).length
  const count = needsYouHeaderNode?.querySelector('.queue-count')
  if (!count) return
  setText(count, queueWaitingCount ? String(queueWaitingCount) : '')
  setHidden(count, !queueWaitingCount)
}

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
  const shown = queueToolsOpen || queueToolsForced()
  setHidden(bar.querySelector('.queue-tools'), !shown)
  setAttr(bar.querySelector('.queue-tools-toggle'), 'aria-expanded', String(shown))
  const count = bar.querySelector('.queue-count')
  setText(count, queueWaitingCount ? String(queueWaitingCount) : '')
  setHidden(count, !queueWaitingCount)
  for (const filter of bar.querySelectorAll('[data-action-filter]')) {
    filter.classList.toggle('active', filter.dataset.actionFilter === actionFilter)
  }
  const changed = bar.querySelector('[data-changed-filter]')
  changed.classList.toggle('active', changedOnly)
  changed.disabled = !lastVisitAt
  const sort = bar.querySelector('.queue-sort select')
  if (sort.value !== askSort) sort.value = askSort
  paintTriageHold()
}

function appendSortOptions(select) {
  for (const option of ASK_SORT_OPTIONS) {
    const el = document.createElement('option')
    el.value = option.value
    el.textContent = option.label
    select.appendChild(el)
  }
}

function needsYouHeader() {
  if (needsYouHeaderNode) {
    syncNeedsYouHeader(needsYouHeaderNode)
    return needsYouHeaderNode
  }
  const bar = document.createElement('div')
  bar.className = 'tab-header'
  // Home's list of asks has no tab of its own: this heading names it (the
  // region's label, and where G I's tile sits), then its count and the Filter
  // toggle at the right end of the line
  const head = document.createElement('div')
  head.className = 'queue-head'
  const title = document.createElement('h2')
  title.id = 'needsYouTitle'
  title.className = 'queue-title'
  title.tabIndex = -1
  title.textContent = 'Needs you'
  const count = document.createElement('b')
  count.className = 'queue-count'
  count.hidden = true
  const toggle = btn('Filter', () => {
    queueToolsOpen = !(queueToolsOpen || queueToolsForced())
    syncNeedsYouHeader(bar)
  })
  toggle.type = 'button'
  toggle.className = 'queue-tools-toggle'
  toggle.setAttribute('aria-controls', 'queueTools')
  toggle.setAttribute('aria-expanded', 'false')
  head.append(title, count, toggle)
  const filters = document.createElement('div')
  filters.className = 'queue-filter-group'
  for (const [value, label] of [['all', 'All'], ['decision', 'Decisions'], ['task', 'To do']]) {
    const filter = btn(label, () => {
      actionFilter = value
      // the tools stay in view under the hand that just used them
      queueToolsOpen = true
      renderIfIdle()
    })
    filter.className = 'header-toggle'
    filter.dataset.actionFilter = value
    filters.appendChild(filter)
  }
  const changed = btn('Updates', () => {
    changedOnly = !changedOnly
    queueToolsOpen = true
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
  appendSortOptions(sort)
  sort.value = askSort
  sort.addEventListener('change', () => {
    askSort = sort.value
    pinnedIds = []
    queueToolsOpen = true
    renderIfIdle()
  })
  sortLabel.append(sortText, sort)
  tools.appendChild(sortLabel)
  const relay = btn('Handoffs', openRelay)
  relay.className = 'relay-btn'
  tools.appendChild(relay)
  const tri = btn('Review queue', openTriage, 'review')
  tri.className = 'triage-btn'
  tools.appendChild(tri)
  // #407: why the Review queue did not open, in a polite live region that is
  // always in the document, so a new message is announced.
  const hold = document.createElement('div')
  hold.className = 'triage-hold'
  const holdText = document.createElement('span')
  holdText.className = 'triage-hold-text'
  holdText.setAttribute('role', 'status')
  const holdShow = btn('Show it', revealHeldDraft)
  holdShow.className = 'triage-hold-show'
  holdShow.hidden = true
  hold.append(holdText, holdShow)
  // out of sight at rest, one wrapper; the hold line stays outside it, always in the document
  const wrap = document.createElement('div')
  wrap.className = 'queue-tools'
  wrap.id = 'queueTools'
  wrap.hidden = true
  wrap.append(filters, tools)
  bar.append(head, wrap, hold)
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
  // UX pass, slice 4: Find with Notes selected and the query cleared
  const chip = btn(`${n} new note${n > 1 ? 's' : ''}`, () => openFind({ chip: 'notes', clearQuery: true }))
  chip.className = 'notes-chip'
  host.appendChild(chip)
}

// the calm state: no red, no call to action, ambient counts as discrete chips.
// With the Later section on (#247) it names what waits there, so nothing is out
// of view without a number on screen.
function renderEmptyState(host, laterCount = 0) {
  const panel = document.createElement('div')
  panel.className = 'calm-panel'
  const head = document.createElement('div')
  head.className = 'calm-head'
  head.textContent = laterCount ? `Nothing needs you · ${laterCount} in Later` : 'Nothing needs you'
  panel.appendChild(head)
  // One calm line and nothing else (UX pass, slice 2): the counts it used to carry (plans,
  // milestones, answers awaiting pickup) are on the page under it or on Find.
  host.appendChild(panel)
}

// flat, ranked, two-line rows — no project/agent heading levels (§3, §15)
function renderNeedsYou(g, boardsInView, nowMs) {
  const host = document.getElementById('needsYouList')
  const protectedIds = protectedNeedsYouIds()
  const scrollOwnerId = openRowId
  const openQueueRow = openRowId ? needsYouRowEl(openRowId) : null
  const openCard = openQueueRow?.querySelector('.nrow-card') ?? null
  const openRowViewportTop = openQueueRow?.getBoundingClientRect().top ?? null
  const cardFocus = openCard ? captureCardFocus(openCard, openRowId) : null
  const askedTimeFocusId = focusedAskedTimeId()
  if (openCard) {
    openRowScrollTop = cardScrollHost(openCard).scrollTop
    openRowHeadScrollTop = openCard.querySelector('.nrow-card-head')?.scrollTop ?? 0
    openRowComposeScrollTop = openCard.querySelector('.nrow-card-compose')?.scrollTop ?? 0
  }
  // §13: this rebuilds every row from scratch (poll tick or user action) — capture
  // this BEFORE the list gets cleared below, since clearing a focused element's
  // subtree shifts document.activeElement immediately (to <body>, typically).
  const hadListFocus = !!activeFocusElement()?.closest?.('#needsYouList .nrow[data-card-id]')
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
  // #247: deferred asks, in the Later section or, with it off, one fold per
  // reason (snoozed, then pinned). Either way they follow the current lens.
  const later = filterActionEntries(laterEntries(items, boardsInView, nowMs, closedSet()))
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
    renderEmptyState(host, laterSection ? later.length : 0)
  }
  for (const e of visible) host.appendChild(needsRowEl(rowModel(e, opts), e, nowMs))
  if (remaining > 0) host.appendChild(moreButton('needsYou', remaining))
  // #247: the fold (Later, snoozed, pinned or stale) that holds the open card
  // always renders open, whatever moved its ask there (a deferral, the Later
  // setting, another client, a native notification or the clock), so an open
  // card and its draft are never inside a closed fold. The human closing that
  // fold closes the card (closeCardIn).
  const holdsOpenCard = (entries) => Boolean(openRowId) && entries.some((entry) => needsEntryId(entry) === openRowId)
  // #279: a draft restored at boot is not left inside a closed fold either; it
  // is revealed once, like a deep link, and the human may close the fold again.
  const holdsRestored = (entries) => entries.some((entry) => revealDraftIds.has(needsEntryId(entry)))
  const reveals = (entries) => holdsOpenCard(entries) || holdsRestored(entries)
  if (laterSection) {
    if (reveals(later)) openDeferredFolds.add('later')
    if (later.length) host.appendChild(laterSectionEl(sortLaterEntries(later), opts, nowMs))
  } else {
    for (const reason of DEFERRED_FOLDS) {
      const deferred = sortDeferredEntries(later.filter((entry) => entry.later === reason))
      if (reveals(deferred)) openDeferredFolds.add(reason)
      if (deferred.length) host.appendChild(deferredFoldEl(reason, deferred, opts, nowMs))
    }
  }
  if (reveals(stale)) staleFoldOpen = true
  revealDraftIds.clear()
  if (stale.length) host.appendChild(staleFoldEl(stale, opts, nowMs))
  renderOrphanedDrafts(host)
  // fix round 2 (I3): the foot chip is fed the SAME scoped notes the Find tab
  // count is computed from (render()'s `g.notes`). It used to read the GLOBAL
  // lastData.g.notes, so the chip and the badge disagreed under any rail filter.
  renderNeedsYouExtras(host, g.notes.flatMap((gr) => gr.items))
  // Badges and editor sizing change the footer's scroll range. Restore against
  // their final geometry, otherwise the browser clamps a valid saved offset early.
  const restoreQueueView = () => {
    if (openRowId !== scrollOwnerId) return
    const restoredRow = openRowId ? needsYouRowEl(openRowId) : null
    const restoredCard = restoredRow?.querySelector('.nrow-card') ?? null
    if (restoredCard) {
      for (const editor of restoredCard.querySelectorAll('textarea.reply-input')) resizeReplyEditor(editor)
      cardScrollHost(restoredCard).scrollTop = openRowScrollTop
      const head = restoredCard.querySelector('.nrow-card-head')
      const compose = restoredCard.querySelector('.nrow-card-compose')
      if (head) head.scrollTop = openRowHeadScrollTop
      if (compose) compose.scrollTop = openRowComposeScrollTop
    }
    if (restoredRow && openRowViewportTop !== null) {
      const viewportDelta = restoredRow.getBoundingClientRect().top - openRowViewportTop
      if (Number.isFinite(viewportDelta) && Math.abs(viewportDelta) > 0.5) {
        window.scrollBy(0, viewportDelta)
      }
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
  return restoreQueueView
}

// The unsent responses' one line on their buttons, naming only the ones shown,
// each for what it works on: a question entry has Retry and Discard, a step's
// kept text Use this text, Copy and Discard, an unapplied click Discard alone.
function staleDraftsHelp(entries) {
  return [
    entries.some((entry) => entry.retry) && 'Retry sends a response again',
    entries.some((entry) => entry.use) && 'Use this text puts a step’s text in its editor',
    entries.some((entry) => entry.copy) && 'Copy copies a step’s text',
    'Discard removes an entry for good',
  ].filter(Boolean).join('; ') + '.'
}

function renderOrphanedDrafts(host) {
  const activeRows = new Map((lastData?.boards ?? [])
    .flatMap((board) => board.rows.map((row) => [row.id, row.revision])))
  const entries = [
    ...Object.entries(staleItemDrafts).map(([key, draft]) => {
      // what Retry does when it would send this over an answer (#321)
      const replaces = retryWouldReplace(draft)
      // a question this window no longer knows still guards its Retry
      const shown = draftAnswerOf(knownAnswer(draft.itemId)) ?? { at: null, source: null, kind: null, text: null }
      return {
        id: key,
        draft,
        retry: () => retryItemDraft(key, draft, shown),
        clear: () => deleteItemDraftRecovery(key, draft.owner),
        notice: replaces ? newerReplyNotice(draft.itemId, replaces, 'Retry') : '',
        noticeFor: key,
        text: [
          draft.title,
          draft.reason,
          `${draft.kind}: ${draft.text}`,
          draft.context ? `context: ${draft.context}` : '',
        ].filter(Boolean).join(' · '),
      }
    }),
    // #636: one the row's open card shows beside its editor is not listed twice
    ...Object.entries(staleRowDrafts)
      .filter(([key, draft]) => {
        const card = needsYouRowEl(draft.rowId)
        return activeRows.get(draft.rowId) === draft.revision
          ? !card?.querySelector('.reply-input')
          : !card?.querySelector(`.row-recovery[data-recovery-line="${CSS.escape(key)}"]`)
      })
      .map(([key, draft]) => ({
        id: key,
        draft,
        use: !draft.choice && rowRecoveryUsable(currentRow(draft.rowId))
          ? (event) => useRowRecovery(key, draft, event.currentTarget)
          : null,
        copy: draft.choice ? null : (event) => copyRecoveryText(draft.text, event.currentTarget),
        clear: () => discardRowRecovery(key, draft),
        text: draft.choice
          ? [draft.boardTitle, draft.label, rowRecoveryWhy(draft)].filter(Boolean).join(' · ')
          : [
              draft.boardTitle,
              draft.label,
              `action ${draft.actionVersion ?? draft.revision}`,
              rowRecoveryWhy(draft),
              `${draft.kind}: ${draft.text}`,
              draft.context ? `context: ${draft.context}` : '',
            ].filter(Boolean).join(' · '),
      })),
    ...[...messageRecoveries].map(([session, draft]) => ({
      id: `message:${session}`,
      draft,
      retry: () => retryMessageRecovery(session),
      clear: () => {
        if (sendingMessages.has(session)) return false
        messageRecoveries.delete(session)
        bumpMessages()
        return true
      },
      text: `${composerLabel(draft)} · ${draft.reason} · Message: ${draft.text}`,
      pending: sendingMessages.has(session),
    })),
    ...Object.entries(itemNoteDrafts)
      .filter(([, draft]) => !draft.pending || draft.error)
      .map(([id, draft]) => ({
        id: `note:${id}`,
        draft,
        retry: freshItem(id)?.status === 'open' ? () => reviewItemNoteRecovery(id, draft.title) : null,
        clear: () => {
          if (itemNoteDrafts[id] !== draft || draft.pending) return false
          delete itemNoteDrafts[id]
          return true
        },
        text: `${draft.title} · ${draft.pending ? 'Saving note…' : draft.error}\n${draft.text === '' ? 'Clear note' : `Note: ${draft.text}`}`,
        textClass: 'annotation',
        pending: draft.pending,
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
  // #407: what the buttons do, so Discard is not a guess; #636 adds a plan
  // row's Use this text and Copy, and names every entry's removal Discard
  const help = document.createElement('p')
  help.className = 'stale-drafts-help'
  help.textContent = staleDraftsHelp(entries)
  fold.appendChild(help)
  for (const entry of entries) {
    const line = document.createElement('div')
    line.className = 'stale-draft-line'
    line.dataset.recoveryLine = entry.id
    line.tabIndex = -1 // the Review queue's hold line can take the human here (#407)
    if (entry.textClass) {
      const text = document.createElement('span')
      text.className = entry.textClass
      text.textContent = entry.text
      line.appendChild(text)
    } else line.textContent = entry.text
    if (entry.noticeFor) {
      const notice = document.createElement('span')
      notice.className = 'replace-notice'
      notice.dataset.noticeFor = entry.noticeFor
      notice.setAttribute('role', 'status')
      notice.textContent = entry.notice
      notice.hidden = !entry.notice
      line.appendChild(notice)
    }
    if (entry.retry) {
      const retry = btn('Retry', entry.retry)
      retry.className = 'undo-btn'
      retry.disabled = Boolean(entry.pending)
      line.appendChild(retry)
    }
    for (const [label, run] of [['Use this text', entry.use], ['Copy', entry.copy]]) {
      if (!run) continue
      const button = btn(label, run)
      button.className = 'undo-btn'
      line.appendChild(button)
    }
    const clear = btn('Discard', () => {
      if (!entry.clear()) {
        forceRender()
        return
      }
      // a keyboard user keeps a place in the list rather than <body> (#407)
      const hadFocus = line.contains(document.activeElement) && document.hasFocus()
      let next = line.nextElementSibling
      while (next && !next.matches('.stale-draft-line')) next = next.nextElementSibling
      line.remove()
      const remaining = fold.querySelectorAll('.stale-draft-line').length
      if (remaining) summary.textContent = `unsent responses (${remaining})`
      else fold.remove()
      if (hadFocus) {
        const target = next ?? (fold.isConnected ? summary : null) ?? document.querySelector('.triage-btn')
        focusQueueControl(target)
      }
      paintTriageHold()
      renderIfIdle()
    })
    clear.className = 'undo-btn'
    clear.disabled = Boolean(entry.pending)
    line.appendChild(clear)
    fold.appendChild(line)
  }
  host.appendChild(fold)
}

// the stale fold's open/closed state, outside the DOM the 3s poll rebuilds —
// same precedent as openContexts: without this the fold silently
// re-collapses under the user mid-read
let staleFoldOpen = false
// The deferred folds under Needs you (#247), in render order, keyed by the
// reason laterEntries tags each entry with, and the ones that are open: opened
// by the human, a deep link, or because they hold the open card. The Later
// section, which replaces them while its setting is on, is the key 'later'.
const DEFERRED_FOLDS = ['snoozed', 'pinned']
const openDeferredFolds = new Set()

function revealDetailsAncestors(target) {
  for (let node = target; node; node = node.parentElement) {
    if (node.tagName !== 'DETAILS') continue
    const wasOpen = node.open
    node.open = true
    if (node.dataset.contextKey) openContexts.add(node.dataset.contextKey)
    // UX pass, slice 3: a plan or the Stalled fold this opens records the open, so
    // the next frame keeps it; one already open keeps the form it was drawn in
    if (node.matches('#boards details.board')) {
      if (!wasOpen) planOpen.set(node.dataset.cardId, true)
    }
    if (node.classList.contains('stalled-fold')) stalledOpen = true
    if (node.dataset.deferredFold) openDeferredFolds.add(node.dataset.deferredFold)
    else if (node.classList.contains('stale-fold')) staleFoldOpen = true
    if (node.classList.contains('archived-fold')) showArchived = true
  }
}

// A fold under the queue renders open while it holds the open card, so the
// human closing one closes that card too; otherwise the next frame would open
// the fold again under them. A draft in it is kept, as when any card is closed.
function closeCardIn(fold) {
  const row = openRowId ? needsYouRowEl(openRowId) : null
  if (!row || !fold.contains(row)) return
  setOpenRow(null, { resume: false })
  row.removeAttribute('data-open')
  row.setAttribute('aria-expanded', 'false')
  row.querySelector('.nrow-card')?.remove()
}

// Asks the human set aside: out of every count, but one click away, each with
// its own way back (Wake now, Back to inbox) on the row.
function deferredFoldEl(reason, entries, opts, nowMs) {
  const fold = document.createElement('details')
  fold.className = `stale-fold ${reason}-fold`
  fold.dataset.deferredFold = reason
  if (openDeferredFolds.has(reason)) fold.open = true
  fold.addEventListener('toggle', () => {
    if (fold.open) openDeferredFolds.add(reason)
    else {
      openDeferredFolds.delete(reason)
      closeCardIn(fold)
    }
    restoreRowSelection(false)
  })
  const summary = document.createElement('summary')
  summary.textContent = `${reason} (${entries.length})`
  fold.appendChild(summary)
  for (const entry of entries) fold.appendChild(needsRowEl(rowModel(entry, opts), entry, nowMs))
  return fold
}

// Issue #247 §2.2: every pinned and snoozed ask in one section at the foot of
// the queue, collapsed by default, with one count for the current lens and the
// reason each ask waits. Its rows are ordinary queue rows, so their cards,
// drafts, row-scoped writes and deep links work here unchanged.
function laterSectionEl(entries, opts, nowMs) {
  const section = document.createElement('details')
  section.className = 'later-section'
  section.dataset.deferredFold = 'later'
  if (openDeferredFolds.has('later')) section.open = true
  section.addEventListener('toggle', () => {
    if (section.open) openDeferredFolds.add('later')
    else {
      openDeferredFolds.delete('later')
      closeCardIn(section)
    }
    restoreRowSelection(false)
  })
  const summary = document.createElement('summary')
  const title = document.createElement('span')
  title.className = 'later-title'
  title.textContent = `Later · ${entries.length}`
  const breakdown = document.createElement('span')
  breakdown.className = 'later-breakdown'
  breakdown.textContent = laterBreakdown(entries, nowMs)
  summary.append(title, ' ', breakdown)
  section.appendChild(summary)
  for (const entry of entries) section.appendChild(needsRowEl(rowModel(entry, opts), entry, nowMs))
  return section
}

// nobody is listening and it is older than STALE_MS: out of the active list and
// out of every count, but one click away — never deleted (§6)
function staleFoldEl(entries, opts, nowMs) {
  const fold = document.createElement('details')
  fold.className = 'stale-fold'
  if (staleFoldOpen) fold.open = true
  fold.addEventListener('toggle', () => {
    staleFoldOpen = fold.open
    if (!fold.open) closeCardIn(fold)
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
  const sourceIdentity = entry.kind === 'row' ? entry.board : entry.item
  const sourceAction = entry.kind === 'row' ? entry.row : entry.item
  el.className = `nrow nrow-${m.kind}${m.answered ? ' answered' : ''}${stagedDismiss.has(m.id) ? ' staged' : ''}`
  el.dataset.cardId = m.id
  rowBuilds.set(el, { m, entry, nowMs })
  setHintOwner(el, entry.kind === 'row' ? entry.row : entry.item, entry.kind === 'row' ? entry.board : null)
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
  const dismissBit = m.kind === 'item' && !isLaunchAskItem(entry.item) ? '<button class="nrow-dismiss" title="Dismiss (x)" aria-label="Dismiss">✕</button>' : ''
  // The Later section calls both ways back "Back to inbox"; the separate
  // snoozed fold keeps its Wake now.
  const wakeBit = m.later
    ? `<button class="nrow-wake" title="Return to Needs you now">${m.later === 'pinned' || laterSection ? 'Back to inbox' : 'Wake now'}</button>`
    : ''
  const projBit = m.projectLabel ? `<span class="nrow-proj" title="${esc(m.project)}">${esc(m.projectLabel)}</span>` : ''
  const agentBit = m.agent ? `<span class="nrow-agent">${esc(m.agent)}</span>` : ''
  const ownerBit = `<span class="nrow-owner owner-${esc(m.actionCategory)}">${esc(m.ownerLabel)}</span>`
  const changeBit = m.changeKind ? `<span class="nrow-change">${esc(m.changeKind)}</span>` : ''
  const session = askSessionToken(entry)
  const sessionBit = session ? `<span class="nrow-session${session.live ? ' live' : ''}">${esc(session.text)}</span>` : ''
  const asked = askTimeModel(m.askedAt, nowMs)
  const askedBit = asked
    ? `<time class="nrow-asked" datetime="${esc(asked.datetime)}" data-exact="${esc(asked.exact)}" title="${esc(asked.text)}" aria-label="${esc(asked.accessibleLabel)}" tabindex="0">${esc(asked.short)}</time>`
    : ''
  // omit line 2 entirely when it would be blank — no secondary text, no agent
  // chip, no stream — otherwise it leaves a padded empty line under the row.
  // Still built (with staged-dismiss's own content) when a dismiss is staged,
  // since the ✕ handler below replaces this div's children in place.
  const showL2 = m.secondary || agentBit || stagedDismiss.has(m.id)
  const l2 = showL2 ? `<div class="nrow-l2"><span class="nrow-sec">${esc(m.secondary)}</span>${agentBit}</div>` : ''
  el.innerHTML = `
    <div class="nrow-l1">
      <div class="nrow-primary">
        <span class="pdot" style="background:${color.dot}" title="${esc(m.project)}"></span>
        ${projBit}
        ${glyph}
        <span class="nrow-title" title="${esc(m.originalTitle)}">${esc(m.title)}</span>
      </div>
      <div class="nrow-meta">
        ${ownerBit}
        ${changeBit}
        ${askedBit}
        ${sessionBit}
        <span class="chip chip-${chip.tone}${chip.rest ? ' chip-rest' : ''}"><span aria-hidden="true">${livenessGlyph(m.liveness).glyph}</span> ${esc(chip.text)}</span>
        <span class="nrow-src">${sourceChipsHtml(linkIndex, sourceIdentity, nowMs, sourceOptions(sourceAction, sourceIdentity))}</span>
        <span class="nrow-star"></span>
        ${wakeBit}
        ${dismissBit}
        <span class="nrow-caret">▸</span>
      </div>
    </div>
    ${l2}`
  el.style.setProperty('--wash', color.wash)
  const boardBtn = el.querySelector('.nrow-glyph')
  // the plan wherever it sits (past the page, closed, in the Stalled fold), this step open, the lens kept
  if (boardBtn) boardBtn.addEventListener('click', (ev) => { ev.stopPropagation(); focusItem(m.boardId, { rowId: m.id, keepLens: true }) })
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
  if (dismissBtn) dismissBtn.dataset.shortcutId = 'dismiss'
  if (dismissBtn) dismissBtn.addEventListener('click', (ev) => {
    ev.stopPropagation()
    stageDismiss(m.id)
  })
  const wakeBtn = el.querySelector('.nrow-wake')
  if (wakeBtn) wakeBtn.addEventListener('click', async (ev) => {
    ev.stopPropagation()
    // A pinned ask comes back by clearing the pin, a snoozed one by waking it.
    const [route, body] = m.later === 'pinned' ? ['later', { pinned: false }] : ['snooze', { until: null }]
    const url = entry.kind === 'row'
      ? `/api/boards/${entry.board.id}/rows/${entry.row.id}/${route}`
      : `/api/items/${entry.item.id}/${route}`
    const res = await postJSON(url, entry.kind === 'row'
      ? {
          ...body,
          expected_revision: entry.row.revision,
          expected_board_version: entry.board.revision,
        }
      : body)
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
    if (ev.key === 'Escape' && openRowId === m.id) { ev.preventDefault(); collapseRow(m.id, { explicit: true }) }
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
  const title = document.createElement('div')
  title.className = `card-title${m.headlineField === 'next-step' ? ' card-next-body' : ''}`
  title.setAttribute('role', 'heading')
  title.setAttribute('aria-level', '2')
  title.innerHTML = renderStructuredText(m.title, entry.kind === 'row' ? textContext(entry.board, entry.row) : textContext(entry.item))
  // UX pass, slice 1: the project only; the agent is in Details' meta line
  const meta = document.createElement('span')
  meta.textContent = m.project ?? ''
  heading.append(title, meta)
  // #454 A.2: the ask's session, and the way to its card on the Agents view,
  // offered only where a session card can open it (the lanes design §6)
  if (!m.later) {
    const session = askSessionToken(entry)
    const where = document.createElement('div')
    where.className = 'nrow-card-session'
    if (session) where.append(Object.assign(document.createElement('span'), { className: `nrow-session${session.live ? ' live' : ''}`, textContent: session.text }))
    if (agentsHome.askKey(m.id) !== null || session?.live) {
      const show = btn('Show on Agents ›', (ev) => {
        ev.stopPropagation()
        openAskInSession(entry)
      })
      show.type = 'button'
      show.className = 'nrow-show-agents'
      show.title = 'Open this ask in its session’s panel'
      where.append(show)
    }
    if (where.childElementCount) heading.append(where)
  }
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'nrow-card-close'
  close.setAttribute('aria-label', 'Close action')
  close.title = 'Close action (Esc)'
  close.textContent = '×'
  close.addEventListener('click', (ev) => {
    ev.stopPropagation()
    collapseRow(m.id, { explicit: true })
  })
  head.append(heading, close)

  const scroll = document.createElement('div')
  scroll.className = 'nrow-card-scroll'
  // `entry` is a render-time closure and the §10 gate can hold a render for
  // minutes, so the snapshot inside it goes stale (issue #31.1, layer 2: a row
  // reopened after a Change answer would otherwise re-mount the OLD reply and
  // hide the answer surface again). Same freshItem() precedent as the star's
  // Undo fallback. Resolved in place: `entry.item` is undefined for board rows.
  const card = entry.kind === 'row'
    ? rowCardEl(entry.board, entry.row, undefined, { includeAsked: false, header: false })
    : itemCardEl(freshItem(entry.item.id) ?? entry.item, {
        nowMs,
        liveness: m.liveness,
        includeAsked: false,
        header: false,
      })
  const answer = card.querySelector(':scope > .row-answer, :scope > .options')
  const actions = card.querySelector(':scope > .actions')
  scroll.appendChild(card)
  body.append(head, scroll)
  if (answer || actions) {
    const compose = document.createElement('div')
    compose.className = 'nrow-card-compose'
    if (answer) compose.appendChild(answer)
    if (actions) compose.appendChild(actions)
    // the Note editor opens beside the Note button, in the bar, not out of sight in the body
    const noteEditorEl = actions ? card.querySelector(':scope > .note-editor') : null
    if (noteEditorEl) compose.appendChild(noteEditorEl)
    body.appendChild(compose)
  }
  for (const host of body.children) {
    const trackScroll = () => noteInspectorScroll(m.id, host)
    host.addEventListener('wheel', trackScroll, { passive: true })
    host.addEventListener('scroll', trackScroll, { passive: true })
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
  if (openRowId === m.id && frontAutoId === m.id && layout === 'wide') {
    // the ask that came to the front by itself: this click opens it, as on any row
    frontAutoId = null
    selectedId = m.id
    markSelectedRow(m.id)
    focusOpenCard(m.id)
    return
  }
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
  focusOpenCard(m.id)
}

function focusOpenCard(id) {
  requestAnimationFrame(() => {
    const card = needsYouRowEl(id)?.querySelector('.nrow-card')
    if (card && !card.contains(document.activeElement)) {
      card.tabIndex = -1
      card.focus({ preventScroll: true }) // focus moves into the card (spec §13)
    }
  })
}

// Explicit collapse is separate from activation so pointer/Enter re-selection is
// idempotent while Escape still closes and restores focus to the owning row.
// `explicit`: the person closed the card (Esc or its ✕), never the narrow row toggle.
function collapseRow(id, { explicit = false } = {}) {
  if (openRowId !== id) return
  // closed by the person on a wide window: nothing comes to the front by itself
  const closesFront = explicit && layout === 'wide'
  selectedId = id
  markSelectedRow(id)
  setOpenRow(null)
  const el = needsYouRowEl(id)
  el?.removeAttribute('data-open')
  el?.setAttribute('aria-expanded', 'false')
  el?.querySelector('.nrow-card')?.remove()
  if (closesFront) frontClosed = true
  renderIfIdle()
  requestAnimationFrame(() => selectRow(id))
}

// notes keep a card list, but flat: no project h3, no agent h4 (§15)
// ── UX pass, slice 4: Find ─────────────────────────────────────────────────
// One list in place of Notes and History; public/find.js builds its rows from the
// data the page already holds. The field and the chips are static markup. Every
// open, armed and typed state lives here, and the list's rows are reconciled by
// key on each painted frame, so focus, a selection and an open card keep their
// nodes. A passive repaint never opens a row and never records a choice.
let findQuery = ''             // what the field holds
let findSettled = ''           // the query the list was last built from (after the debounce)
let findTimer = null
let findChip = 'all'
let findActiveKey = null       // the row Enter opens: painted only, kept by key
const findOpen = new Set()     // rows open in place
const findKept = new Set()     // rows the person acted on this visit: they stay where they are
let findLandingKey = null      // the row a way in landed on this visit: it stays listed
let findPainted = []           // keys in the order last painted on this visit
let findNewIds = null          // unread notes on entering Find, marked New until the person leaves
let findHistoryPinned = false  // "Show more" asked for the older history on this visit
let findWaiting = false        // a query waits on older history or archived plans
let findStale = false          // ...and the rows on screen are the previous list's: they do nothing
let findRowsByKey = new Map()  // the rows (and command rows) last painted, by key
let findRevealKey = null       // the first row "Show 20 more" reveals
const findDomIds = new Map()   // key → the stable id of its main button, kept only while the key is drawn
let findDomSeq = 0             // ids are never reused, so pruning the map cannot collide two rows
let findEntryTouch = false     // the last press on the tab strip was a touch
let findPointerIn = false      // the pointer rests on the list: a poll then keeps the painted order

const FIND_ICONS = {
  answer: '<circle cx="12" cy="12" r="9"></circle><path d="M9.6 9.6a2.4 2.4 0 1 1 3.6 2.1c-.8.5-1.2 1-1.2 1.9"></path><path d="M12 17h.01"></path>',
  note: '<circle cx="12" cy="12" r="9"></circle><path d="M12 11v5.5"></path><path d="M12 7.5h.01"></path>',
  plan: '<path d="M4 7h7"></path><path d="M14 7h6"></path><path d="M4 12h4"></path><path d="M11 12h9"></path><path d="M4 17h10"></path><path d="M17 17h3"></path>',
  finished: '<circle cx="12" cy="12" r="9"></circle><path d="M8.5 12.5l2.5 2.5 4.5-5"></path>',
  ask: '<circle cx="12" cy="12" r="9"></circle><path d="M12 7.5v5.5"></path><path d="M12 16.5h.01"></path>',
  action: '<path d="M5 12h14"></path><path d="M13 6l6 6-6 6"></path>',
  // step B: the picture's chat bubble, with a prompt for Claude Code and two eyes for Copilot
  'chat-claude': '<path d="M5 5.5h14v10.5h-8l-4 3.2V16H5z"></path><path d="M9 9.2l2 1.6-2 1.6"></path><path d="M12.6 12.4h2.6"></path>',
  'chat-copilot': '<path d="M5 5.5h14v10.5h-8l-4 3.2V16H5z"></path><path d="M9.6 10.8h.01"></path><path d="M14.4 10.8h.01"></path>',
}

// the Chats chip's empty texts are the Chats line's own (chats-view.js)
const FIND_EMPTY = { none: 'Nothing here yet.', all: 'No answers, notes or finished work yet.', answers: 'No answers yet.', notes: 'No notes.', plans: 'No plans.', chats: '' }

function windowActive() {
  return document.visibilityState !== 'hidden' && document.hasFocus()
}

// Find reads older history and archived plans for a query only while it is the page in
// use: the active tab, a query typed, and the window on screen. Unlike the top bar's dropdown,
// Find's results stay on screen when the person looks at another app, so focus is not asked
// for: letting the history go then would make the rows on screen stale.
function findInUse() {
  return activeTab === 'find' && !settingsOpen() && findQuery.trim() !== '' && document.visibilityState !== 'hidden'
}

// Which reads a chip needs: history for All, Answers and Notes; archived plans for All and Plans.
// Chats need neither: they are read on their own (chats-view.js).
const findNeeds = (chip = findChip) => ({ history: chip !== 'plans' && chip !== 'chats', archived: chip === 'all' || chip === 'plans' })

const findField = () => document.getElementById('findQuery')

function findLensData(query) {
  // the lens as Notes and History had it; a query under All projects also covers closed projects
  return query
    ? filterData({ g: lastData.g, boards: lastData.boards, archived: lastData.archived })
    : filterData(withoutClosed(lastData))
}

// What stays listed whatever the chip, the query or the page: rows the person acted on,
// rows whose Note editor holds text, and the row a way in landed on.
function findKeepKeys() {
  const keep = new Set(findKept)
  for (const [id, editor] of Object.entries(itemNoteEditors)) {
    if (editor.text.trim()) keep.add(`item:${id}`)
  }
  if (findLandingKey) keep.add(findLandingKey)
  return keep
}

const findRowHasText = (row) => Boolean(row?.entity && itemNoteEditors[row.id]?.text.trim())

// Save or Cancel ends a Note editor: a Find row open only because that editor held text
// (restored after a reload, or typed on Home) stays open, so the Note button, the saving
// state and any refusal stay in view.
function keepFindRowOpen(id) {
  const key = `item:${id}`
  if (!findRowHasText(findRowsByKey.get(key))) return
  findOpen.add(key)
  // the click on Save already says so; Cmd or Ctrl+Enter makes no click
  findKept.add(key)
}

// A deliberate change of chip or settled query ends the "stays in place" window: rows the
// person acted on and the row a way in landed on go back to their own place. Only a row
// whose Note editor holds text stays listed (findKeepKeys).
function endFindStay() {
  findKept.clear()
  findLandingKey = null
  findPainted = []
}

// ⌘K's commands typed in Find's field: their rows lead the list, as in the top bar.
function findCommandRows(query, rows) {
  const actions = paletteResults(query, paletteTargets(), fuzzySearch).map((result) => ({
    key: `action:${result.key}`, id: result.key, type: 'action', label: result.kind, action: 'run', title: result.title,
    project: '', stamp: null, open: false, entity: null, palette: result.action,
    extra: result.context ? { kind: 'text', text: result.context, full: result.context } : null,
  }))
  const suggests = actions[0]?.palette.type === 'command'
  const openLeads = rows[0]?.open && (rows[0].type === 'ask' || rows[0].type === 'answer')
  return suggests && openLeads ? { lead: [], tail: actions } : { lead: actions, tail: [] }
}

function findModel() {
  const query = findSettled.trim()
  const needs = findNeeds()
  const waiting = Boolean(query) && ((needs.history && omitsHistory()) || (needs.archived && omitsArchived()))
  const older = query || !needs.history ? 0 : olderHistory(lastData.older, olderLens()).items
  const data = findLensData(query)
  // while the pointer rests on the list, a poll keeps the painted order: a re-sort (plans move on
  // every write) must not put another row under the press. The order catches up when it leaves.
  const keep = findKeepKeys()
  if (pollPaint && findPointerIn) for (const key of findPainted) keep.add(key)
  const { rows, cut } = buildFindRows(data, {
    chip: findChip,
    query,
    searchFn: fuzzySearch,
    before: older ? lastData.older?.before ?? null : null,
    nowMs: Date.now(),
    archivedWhole: Boolean(lastData.archivedFull),
    keep,
    previous: findPainted,
    // step B: the chats as last read; the Chats line's tool toggle applies under the Chats chip only
    chats: chatsView.list(),
    chatTool: chatsView.tool(),
  })
  // a row whose Note editor holds text is never hidden by the lens (a closed project, another
  // project on the rail): the typed text stays in sight, first in the list
  const listedKeys = new Set(rows.map((row) => row.key))
  for (const [id, editor] of Object.entries(itemNoteEditors)) {
    if (!editor.text.trim() || listedKeys.has(`item:${id}`)) continue
    const entity = [...(lastData.g.needsYou ?? []).flatMap((group) => group.items ?? []), ...(lastData.g.notes ?? []).flatMap((group) => group.items ?? []), ...(lastData.g.done ?? [])].find((item) => item.id === id)
    if (entity) rows.unshift(findRow(entity, { nowMs: Date.now() }))
  }
  return { query, rows, cut, older, waiting, commands: query ? findCommandRows(query, rows) : { lead: [], tail: [] }, data }
}

function findWaitText() {
  const needs = findNeeds()
  const history = needs.history && omitsHistory()
  const archived = needs.archived && omitsArchived()
  const loading = history && archived ? 'Searching older history and archived plans…'
    : history ? 'Searching older history…' : 'Searching archived plans…'
  return omittedWaitText(loading, { history, archived })
}

// Whether the read a waiting query depends on has failed: its rows are then as they were.
function findWaitFailed() {
  const needs = findNeeds()
  return Boolean((needs.history && omitsHistory() && lastData?.olderError) || (needs.archived && omitsArchived() && lastData?.archivedError))
}

// The rows of the previous list while a query waits, as the top bar treats its options:
// busy, disabled, and out of the field's active descendant. Freed when the read ends.
function markFindStale(list, stale) {
  if ((list.dataset.updating === 'true') === stale) return
  if (stale) list.dataset.updating = 'true'
  else delete list.dataset.updating
  for (const main of list.querySelectorAll(':scope > .find-row > .find-row-main')) {
    if (stale) main.setAttribute('aria-disabled', 'true')
    else main.removeAttribute('aria-disabled')
  }
  // an open row's card too: a press there would be remembered and applied when the results land;
  // and a chat row's slot
  for (const body of list.querySelectorAll(':scope > .find-row > .find-row-body, :scope > .find-row > .find-slot')) body.inert = stale
  if (stale) findField()?.removeAttribute('aria-activedescendant')
  else paintFindActive()
}

function setFindStatus(text) {
  const status = document.getElementById('findStatus')
  if (!status) return
  if (status.textContent !== text) status.textContent = text
  status.hidden = !text
}

function syncFindControls() {
  for (const chip of document.querySelectorAll('#find [data-find-chip]')) {
    chip.setAttribute('aria-pressed', String(chip.dataset.findChip === findChip))
  }
  const input = findField()
  if (input && input.value !== findQuery && document.activeElement !== input) input.value = findQuery
}

function findDomId(key) {
  if (!findDomIds.has(key)) findDomIds.set(key, `find-row-${++findDomSeq}`)
  return findDomIds.get(key)
}

function findRowEl(key) {
  const el = document.createElement('div')
  el.className = 'find-row'
  el.setAttribute('role', 'listitem')
  el.dataset.findKey = key
  const main = document.createElement('button')
  main.type = 'button'
  main.className = 'find-row-main'
  main.id = findDomId(key)
  main.addEventListener('click', () => pressFindRow(key))
  el.appendChild(main)
  return el
}

function findExtraEl(extra) {
  const span = document.createElement('span')
  span.className = 'find-extra'
  if (!extra) return span
  span.dataset.extra = extra.kind
  if (extra.kind === 'bar') {
    span.innerHTML = planBarHtml(extra, extra.label)
    return span
  }
  span.textContent = extra.text
  // the full text, for an extra cut short here or by the narrow row's ellipsis
  if (extra.full || extra.text) span.title = extra.full || extra.text
  return span
}

// The row at rest: the type's icon, the title, the New mark (notes keep its space), the
// extra, the project and the age. Spans only, so step B can put one control beside it.
function fillFindMain(main, row, nowMs) {
  const chat = row.type === 'chat'
  const icon = document.createElement('span')
  icon.className = 'find-icon'
  icon.dataset.type = row.type
  icon.setAttribute('role', 'img')
  // a chat's icon tells Claude Code from Copilot, and says so
  icon.setAttribute('aria-label', chat ? `${row.label} chat` : row.label)
  const glyph = chat ? FIND_ICONS[row.tool === 'copilot' ? 'chat-copilot' : 'chat-claude'] : FIND_ICONS[row.type]
  icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${glyph ?? FIND_ICONS.finished}</svg>`
  const title = document.createElement('span')
  title.className = 'find-title'
  title.textContent = row.title
  // chat text is untrusted: textContent and attributes only. An automatic or missing title is quiet.
  title.title = row.titleNote ? `${row.title}\n${row.titleNote}` : row.title
  if (row.titleQuiet) title.classList.add('chats-quiet')
  const parts = [icon, title]
  if (row.type === 'note') {
    const mark = document.createElement('span')
    mark.className = 'find-new'
    mark.textContent = findNewIds?.has(row.id) ? 'New' : ''
    parts.push(mark)
  }
  if (chat && chatsView.live(row.id)) {
    const live = document.createElement('span')
    live.className = 'find-live'
    live.textContent = 'Live'
    parts.push(live)
  }
  parts.push(findExtraEl(row.extra))
  // a chat row's slot sits over this space, beside the main button: its width is reserved here,
  // so nothing moves when the slot's label changes
  if (chat) {
    const space = document.createElement('span')
    space.className = 'find-slot-space'
    space.setAttribute('aria-hidden', 'true')
    parts.push(space)
  }
  const project = document.createElement('span')
  project.className = 'find-project'
  if (row.project) {
    project.title = row.project
    const dot = document.createElement('span')
    dot.className = 'find-dot'
    dot.setAttribute('aria-hidden', 'true')
    dot.style.background = pcolor(row.project).dot
    const name = document.createElement('span')
    name.className = 'find-project-name'
    name.textContent = row.project
    project.append(dot, name)
  }
  const age = document.createElement('span')
  age.className = 'find-age'
  if (row.stamp) {
    const time = document.createElement('time')
    time.dateTime = new Date(row.stamp).toISOString()
    time.textContent = findAge(nowMs - row.stamp)
    age.appendChild(time)
  }
  parts.push(project, age)
  main.replaceChildren(...parts)
}

function findRowOpen(row) {
  return row.action === 'expand' && (findOpen.has(row.key) || findRowHasText(row))
}

// A read that failed falls back to a NEW empty array each tick: two empty reads are the same read.
const sameRead = (a, b) => a === b || (Array.isArray(a) && Array.isArray(b) && a.length === 0 && b.length === 0)

function updateFindRow(el, row, nowMs) {
  const main = el.querySelector(':scope > .find-row-main')
  const open = findRowOpen(row)
  const isNew = row.type === 'note' && Boolean(findNewIds?.has(row.id))
  const signature = JSON.stringify([row.type, row.label, row.title, row.extra, row.project,
    row.stamp ? findAge(nowMs - row.stamp) : '', isNew, row.project ? pcolor(row.project).dot : '',
    row.type === 'chat' ? [row.tool, row.titleQuiet, row.titleNote, chatsView.live(row.id)] : null])
  if (main.dataset.signature !== signature) {
    fillFindMain(main, row, nowMs)
    main.dataset.signature = signature
  }
  el.dataset.findType = row.type
  if (row.entity && row.type !== 'plan') el.dataset.cardId = row.id
  else delete el.dataset.cardId
  // step B: a chat row's one action slot, its own tab stop right after the main button
  let slot = el.querySelector(':scope > .find-slot')
  if (row.type === 'chat') {
    if (!slot) {
      slot = document.createElement('div')
      slot.className = 'find-slot'
      // twenty rows hold the same button: the group says whose it is
      slot.setAttribute('role', 'group')
      main.after(slot)
    }
    if (slot.getAttribute('aria-label') !== row.title) slot.setAttribute('aria-label', row.title)
    chatsView.paintSlot(slot, row.id)
  } else slot?.remove()
  let body = el.querySelector(':scope > .find-row-body')
  if (row.action === 'expand') {
    main.setAttribute('aria-expanded', String(open))
    main.setAttribute('aria-controls', `${main.id}-body`)
  } else {
    main.removeAttribute('aria-expanded')
    main.removeAttribute('aria-controls')
  }
  if (!open) {
    body?.remove()
    return
  }
  if (!body) {
    body = document.createElement('div')
    body.className = 'find-row-body'
    body.id = `${main.id}-body`
    el.appendChild(body)
  }
  if (row.type === 'chat') {
    // the Chats page's facts and controls, painted in place by the chats view
    chatsView.paintBody(body, row.id, nowMs)
    return
  }
  // the card is built only while the row is open, and rebuilt only when what it shows changed
  const it = row.entity
  const cardSignature = JSON.stringify([it, Boolean(itemNoteEditors[it.id]), itemNoteDrafts[it.id]?.pending ?? null,
    itemNoteDrafts[it.id]?.error ?? null, fileLinksCopy(), Boolean(linkFileActions()), hubFiles.available()])
  if (body.dataset.signature !== cardSignature || !sameRead(body.findLinks, lastData.links) || !sameRead(body.findIssues, lastData.issues)) {
    // agent and stream are no longer on the row: one quiet line above the card says them (agent text: textContent)
    const from = [it.agent, it.stream].filter(Boolean).join(' · ')
    const origin = document.createElement('p')
    origin.className = 'find-row-origin'
    origin.textContent = from
    origin.hidden = !from
    const parts = [origin, itemCardEl(it, { done: it.status !== 'open', header: false })]
    const problem = itemNoteDrafts[it.id]?.error
    if (problem) {
      // the text itself is kept on Home, under the unsent responses; here the row says what happened
      const line = document.createElement('p')
      line.className = 'find-row-problem'
      line.setAttribute('role', 'status')
      line.textContent = `${problem} Your text is kept on Home, under unsent responses.`
      parts.push(line)
    }
    body.replaceChildren(...parts)
    body.dataset.signature = cardSignature
    body.findLinks = lastData.links
    body.findIssues = lastData.issues
  }
}

function reconcileFindList(list, rows, nowMs) {
  // Moving a node that holds focus blurs it, and plan and command rows have no card focus
  // bookmark: note the focused row (by key) and whether focus was on its main button
  const focused = document.activeElement instanceof Element ? document.activeElement.closest('#findList > .find-row[data-find-key]') : null
  const focusKey = focused?.dataset.findKey ?? null
  const focusOnMain = Boolean(focused) && document.activeElement === focused.querySelector(':scope > .find-row-main')
  // a control inside a row (a chat's slot, a control in an open body) the move below would blur
  const focusedInside = focused && !focusOnMain ? document.activeElement : null
  const wanted = new Set(rows.map((row) => row.key))
  const existing = new Map()
  for (const child of [...list.children]) {
    // the rows that left go first, so none of the placements below moves a row past them
    if (child.dataset.findKey && wanted.has(child.dataset.findKey)) existing.set(child.dataset.findKey, child)
    else child.remove()
  }
  let previous = null
  for (const row of rows) {
    let el = existing.get(row.key)
    if (!el) el = findRowEl(row.key)
    updateFindRow(el, row, nowMs)
    const expected = previous ? previous.nextElementSibling : list.firstElementChild
    if (el !== expected) list.insertBefore(el, expected)
    previous = el
  }
  if (focusOnMain && (!document.activeElement || document.activeElement === document.body)) {
    list.querySelector(`:scope > [data-find-key="${CSS.escape(focusKey)}"] > .find-row-main`)?.focus({ preventScroll: true })
  } else if (focusedInside?.isConnected && (!document.activeElement || document.activeElement === document.body)) {
    // the row kept its control nodes, so the same node takes focus back
    focusedInside.focus({ preventScroll: true })
  }
}

// The highlight Enter opens: the first row unless the arrows moved it. Painted only.
function findActiveRow() {
  const keys = [...findRowsByKey.keys()]
  return keys.includes(findActiveKey) ? findActiveKey : keys[0] ?? null
}

function paintFindActive() {
  const active = findActiveRow()
  for (const el of document.querySelectorAll('#findList > .find-row')) {
    if (el.dataset.findKey === active) el.dataset.active = 'true'
    else delete el.dataset.active
  }
  const input = findField()
  if (!input) return
  if (active) input.setAttribute('aria-activedescendant', findDomId(active))
  else input.removeAttribute('aria-activedescendant')
}

function moveFindActive(delta) {
  const keys = [...findRowsByKey.keys()]
  if (!keys.length) return
  const at = keys.indexOf(findActiveRow())
  findActiveKey = keys[(at + delta + keys.length) % keys.length]
  paintFindActive()
  document.querySelector(`#findList > [data-find-key="${CSS.escape(findActiveKey)}"]`)?.scrollIntoView?.({ block: 'nearest' })
}

function renderFind() {
  const list = document.getElementById('findList')
  const foot = document.getElementById('findFoot')
  if (!list || !foot || !lastData) return
  syncFindControls()
  chatsView.beginPaint()
  const model = findModel()
  const waitFailed = model.waiting && findWaitFailed()
  if (model.waiting && !waitFailed) {
    // a query waits for the whole of what it searches: the rows on screen stay, busy and inert
    findWaiting = true
    findStale = true
    list.setAttribute('aria-busy', 'true')
    markFindStale(list, findStale)
    setFindStatus(findWaitText())
    foot.replaceChildren()
    foot.dataset.says = ''
    paintFindChatsLines(model)
    return
  }
  // when the read failed, the query is drawn over what is loaded, under the failure line
  findWaiting = false
  findStale = false
  list.removeAttribute('aria-busy')
  markFindStale(list, false)
  const nowMs = Date.now()
  const { rows } = model
  const page = rows.slice(0, shown.find)
  // kept rows, a landing target and a focused row stay in sight after the page
  const extra = findKeepKeys()
  const target = pendingFocusId ?? pagedFocusId
  if (target) extra.add(`item:${target}`)
  // an open row stays in sight when a re-read or a poll moves it past the page
  for (const row of rows.slice(shown.find)) if (findOpen.has(row.key)) extra.add(row.key)
  const beyond = rows.slice(shown.find).filter((row) => extra.has(row.key))
  const listed = [...page, ...beyond]
  const drawn = [...model.commands.lead, ...listed, ...model.commands.tail]
  findRowsByKey = new Map(drawn.map((row) => [row.key, row]))
  reconcileFindList(list, drawn, nowMs)
  for (const key of [...findDomIds.keys()]) if (!findRowsByKey.has(key)) findDomIds.delete(key)
  findPainted = listed.map((row) => row.key)
  paintFindActive()

  const rest = rows.length - listed.length
  const olderWaits = !model.query && findNeeds().history && (model.cut > 0 || model.older > 0)
  paintFindChatsLines(model)
  if (waitFailed) setFindStatus(findWaitText())
  // under the Chats chip the Chats line says what a short or empty list means
  else if (drawn.length || findChip === 'chats') setFindStatus('')
  // under All with a query the chats are searched too: unread (still loading, or failed) they are
  // not searched, so "Nothing matches" would be false; the foot's own line says why
  else if (model.query && findChip === 'all' && chatsView.list() === null && (chatsView.loading() || chatsView.failed())) setFindStatus('')
  else if (model.query) setFindStatus(`Nothing matches "${model.query}".`)
  else if (olderWaits) setFindStatus('')
  else {
    // "Nothing here yet." only when the lens holds nothing at all, plans and chats included
    const feed = buildFindRows(model.data, { chip: 'all', nowMs }).rows.length
    const plans = buildFindRows(model.data, { chip: 'plans', nowMs }).rows.length
    const chats = chatsView.list()?.filter((chat) => !chat.hidden?.length).length ?? 0
    setFindStatus(feed + plans + chats === 0 ? FIND_EMPTY.none : FIND_EMPTY[findChip])
  }
  // the first row "Show 20 more" reveals; the foot is rebuilt only when its KIND changes (more,
  // older, loading), and a changed number is written into the button in place, so a poll never
  // takes focus off it
  findRevealKey = rows.slice(shown.find).find((row) => !extra.has(row.key))?.key ?? null
  // an empty list reads the history on its own (findDrawsNothing), so it says so, not "Show more"
  const kind = rest > 0 ? 'more' : olderWaits ? (findHistoryPinned || !listed.length ? 'loading' : 'older') : ''
  const footText = kind === 'more' ? `Show ${Math.min(FIND_PAGE, rest)} more`
    : kind === 'loading' ? olderHistoryWaitText('Loading older history…') : kind === 'older' ? 'Show more' : ''
  if (foot.dataset.says !== kind) {
    foot.dataset.says = kind
    foot.replaceChildren()
    if (kind === 'more') {
      const more = btn(footText, showMoreInFind)
      more.className = 'show-more find-more'
      foot.appendChild(more)
    } else if (kind === 'loading') {
      const loading = document.createElement('p')
      loading.className = 'find-loading'
      loading.setAttribute('role', 'status')
      loading.textContent = footText
      foot.appendChild(loading)
    } else if (kind === 'older') {
      const older = btn(footText, showOlderInFind)
      older.className = 'show-more find-older'
      foot.appendChild(older)
    }
  } else if (kind && foot.firstElementChild && foot.firstElementChild.textContent !== footText) {
    foot.firstElementChild.textContent = footText
  }
  markFindNotesSeen(listed, model.query)
}

// Step B: the line under the chips while Chats is selected (the tool toggles, Show all, Refresh,
// the notes and the empty texts), and the foot after the list: one line when the chats could not
// be read for a query under All, and the retention note under the Chats chip.
function paintFindChatsLines(model) {
  const line = document.getElementById('findChats')
  if (line) {
    const onChats = findChip === 'chats'
    line.hidden = !onChats
    if (onChats) chatsView.paintBar(line, { shown: model.rows.filter((row) => row.type === 'chat').length })
  }
  const fail = document.getElementById('findChatsFoot')
  if (fail) chatsView.paintFoot(fail, findChip === 'all' && Boolean(model.query), { note: findChip === 'chats' })
}

// A chats change to draw. Every Find repaint goes through the page's render: one nobody pressed
// for (a read on entering Find, main's answer, a timer) through the poll's gate; the answer to the
// person's own press as their press's frame. Either waits for a press that is down to end, so a
// re-read never moves or removes the row under it (#38).
let chatsHeld = null   // the change a press holds: whether it was passive
let chatsHeldTimer = null
function chatsChanged({ passive = false, reset = false } = {}) {
  if (reset) {
    // a deliberate change of what the Chats chip lists, as a chip press is
    endFindStay()
    findActiveKey = null
    shown.find = FIND_PAGE
  }
  if (!lastData || document.getElementById('find').hidden) return
  if (pressHeld(pressedAt, Date.now())) {
    chatsHeld = chatsHeld === null ? passive : chatsHeld && passive
    if (chatsHeldTimer === null) chatsHeldTimer = setTimeout(flushChatsHeld, PRESS_GRACE_MS)
    return
  }
  if (passive) renderIfIdle()
  else forceRender()
}

function flushChatsHeld() {
  if (chatsHeldTimer !== null) clearTimeout(chatsHeldTimer)
  chatsHeldTimer = null
  if (chatsHeld === null) return
  const passive = chatsHeld
  chatsHeld = null
  chatsChanged({ passive })
}

// #chats, the session panel's "Continued from a Copilot chat" line: Find with the Chats chip
function openChatsInFind() {
  openFind({ chip: 'chats', clearQuery: true, focus: 'field' })
}

// "Show 20 more": the first row it reveals takes focus.
function showMoreInFind() {
  const reveal = findRevealKey
  shown.find += FIND_PAGE
  forceRender()
  if (reveal) document.querySelector(`#findList > [data-find-key="${CSS.escape(reveal)}"] > .find-row-main`)?.focus({ preventScroll: true })
}

// "Show more" past the cut: the complete history is read while the person stays on Find.
function showOlderInFind() {
  findHistoryPinned = true
  forceRender()
  document.getElementById('findList')?.focus({ preventScroll: true })
  requestHistoryPaint()
}

// A fresh note counts as read when its row is drawn under the Notes chip with no query,
// in a frame painted while the window is visible and focused. All does not mark notes.
function markFindNotesSeen(listed, query) {
  if (findChip !== 'notes' || query || document.getElementById('find').hidden || !windowActive()) return
  const all = lastData.g.notes.flatMap((gr) => gr.items)
  const fresh = new Set(all.map((n) => n.id))
  const viewed = listed.filter((row) => row.type === 'note' && fresh.has(row.id)).map((row) => row.entity)
  const shownIds = new Set(viewed.map((n) => n.id))
  markNotesSeen(viewed, all.filter((n) => !shownIds.has(n.id)), all)
}

function pressFindRow(key, { enter = false } = {}) {
  const row = findRowsByKey.get(key)
  if (!row || findStale) return
  findActiveKey = key
  if (row.action === 'run') {
    runPaletteAction(row.palette, findField())
    return
  }
  if (row.action === 'home') {
    focusItem(row.id, row.source ?? null)
    return
  }
  if (row.action === 'plans') {
    focusItem(row.id, { ...(row.source ?? {}), keepLens: true })
    return
  }
  if (findOpen.has(key) && !enter) {
    // unsent text in its Note editor keeps a row open: show the person where it is
    if (findRowHasText(row)) {
      focusItemNoteEditor(row.id, 'find')
      return
    }
    findOpen.delete(key)
  } else {
    findOpen.add(key)
  }
  forceRender()
}

function setFindQueryText(text) {
  if (findTimer) {
    clearTimeout(findTimer)
    findTimer = null
  }
  findQuery = text
  findSettled = text
  findActiveKey = null
  shown.find = FIND_PAGE
  endFindStay()
  const input = findField()
  if (input) input.value = text
}

function setFindChip(chip) {
  if (!FIND_CHIPS.includes(chip) || chip === findChip) return
  findChip = chip
  findActiveKey = null
  shown.find = FIND_PAGE
  endFindStay()
  // reaching the chats from inside Find is an entry into them: the 60-second rule and the
  // bridges' asks run as on entering Find (the tab's own entry already did when Find was hidden)
  if (chip === 'chats' && !document.getElementById('find').hidden) chatsView.opened()
  forceRender()
  requestHistoryPaint()
}

function focusFindField({ select = false } = {}) {
  const input = findField()
  if (!input || input.closest('[hidden]')) return
  input.focus({ preventScroll: true })
  if (select) input.select()
}

// Entering Find: the top bar's text moves into Find's empty field, and the unread notes are
// snapshotted so their New marks hold until the person leaves.
function enterFind() {
  const top = document.getElementById('search')
  if (top?.value.trim() && !findQuery.trim()) {
    setFindQueryText(top.value)
    resetSearch()
  } else closeSearchResults()
  endFindStay()
  findHistoryPinned = false
  // over every project, closed ones included, so a lens change on Find still shows the right marks
  findNewIds = lastData
    ? new Set(unreadNotes(lastData.g.notes.flatMap((gr) => gr.items), notesSeenAt, Date.now(), notesSeenIds)
      .map((note) => note.id))
    : new Set()
}

function leaveFind() {
  if (findTimer) {
    clearTimeout(findTimer)
    findTimer = null
    findSettled = findQuery
  }
  endFindStay()
  findNewIds = null
  findHistoryPinned = false
  findPointerIn = false
}

// G F, G N, G H and Home's notes chip. `focus`: the field, the list or nothing.
function openFind({ chip = null, clearQuery = false, focus = 'field' } = {}) {
  const wasShowing = !document.getElementById('find').hidden
  selectTab('find', { paint: false })
  if (activeTab !== 'find') return
  // a go-to destination starts at the top, as every tab's does (focusKeyboardPanel)
  if (window.scrollY !== 0) window.scrollTo(0, 0)
  if (clearQuery) setFindQueryText('')
  if (chip && chip !== findChip) {
    findChip = chip
    findActiveKey = null
    shown.find = FIND_PAGE
  }
  // G C, #chats and the "Continued from a Copilot chat" link from inside Find enter the chats
  // too (selectTab did when Find was hidden)
  if (wasShowing && findChip === 'chats') chatsView.opened()
  forceRender()
  requestHistoryPaint()
  if (focus === 'field') focusFindField()
  else if (focus === 'list') document.getElementById('findList')?.focus({ preventScroll: true })
}

// A way in that lands on Find (focusItem): the lens changes only when the target is outside
// it; the query and chip stay when the target is in the list, else the query clears and the
// narrowest chip that holds it is selected. The row opens.
function prepareFindLanding(item) {
  const closed = closedSet()
  const outside = (projectFilter && item.project !== projectFilter) || (agentFilter && item.agent !== agentFilter)
    || (!findSettled.trim() && closed.has(item.project) && projectFilter !== item.project)
  if (outside) {
    projectFilter = item.project
    agentFilter = null
  }
  const key = `item:${item.id}`
  const listed = buildFindRows(findLensData(findSettled.trim()), {
    chip: findChip, query: findSettled.trim(), searchFn: fuzzySearch, nowMs: Date.now(), archivedWhole: Boolean(lastData.archivedFull),
  }).rows.some((row) => row.key === key)
  if (!listed) {
    setFindQueryText('')
    const type = findRow(item).type
    findChip = type === 'note' ? 'notes' : type === 'answer' ? 'answers' : 'all'
    // outside the lens is decided again now the query is gone: the no-query list hides a
    // closed project, so it is peeked as for any landing
    if (closed.has(item.project) && projectFilter !== item.project) {
      projectFilter = item.project
      agentFilter = null
    }
  }
  findLandingKey = key
  findOpen.add(key)
  // a target only the complete history holds keeps it loaded while the person stays on Find
  if (!allItems(lastData.page).some((other) => other.id === item.id)) findHistoryPinned = true
}

function initFind() {
  const input = findField()
  const list = document.getElementById('findList')
  if (!input || !list) return
  for (const chip of document.querySelectorAll('#find [data-find-chip]')) {
    chip.addEventListener('click', () => setFindChip(chip.dataset.findChip))
  }
  input.addEventListener('input', () => {
    findQuery = input.value
    if (findTimer) clearTimeout(findTimer)
    findTimer = setTimeout(() => {
      findTimer = null
      // a stray key undone within the debounce settles on the same query: nothing moves
      const changed = findQuery.trim() !== findSettled.trim()
      findSettled = findQuery
      if (changed) {
        findActiveKey = null
        shown.find = FIND_PAGE
        endFindStay()
      }
      forceRender()
      // the person's own query asked for this frame: what it searches is read and painted
      // outside the poll's gate, as an unrelated draft must not hide it (#38)
      requestHistoryPaint()
    }, 120)
    // overlap reading what a query searches with the debounce, as the top bar does
    requestHistory()
  })
  input.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) {
      event.stopPropagation()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (input.value) {
        setFindQueryText('')
        forceRender()
      } else input.blur()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      moveFindActive(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      // never while the query is settling or its results are waiting
      if (findTimer || findWaiting || findSettled !== findQuery) return
      const key = findActiveRow()
      if (key) pressFindRow(key, { enter: true })
    }
  })
  // Escape on a row, or inside an open one, closes it and focuses its main button; it never
  // exits a project peek or clears a selection elsewhere
  list.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing) return
    const rowEl = event.target instanceof Element ? event.target.closest('.find-row[data-find-key]') : null
    if (!rowEl) return
    event.preventDefault()
    event.stopPropagation()
    const key = rowEl.dataset.findKey
    const itemId = key.startsWith('item:') ? key.slice(5) : null
    // an editor left empty goes with the row: it must not reappear wherever the item is drawn next
    if (itemId && itemNoteEditors[itemId] && !itemNoteEditors[itemId].text.trim()) delete itemNoteEditors[itemId]
    if (findOpen.has(key) && !findRowHasText(findRowsByKey.get(key))) {
      findOpen.delete(key)
      forceRender()
    }
    document.querySelector(`#findList > [data-find-key="${CSS.escape(key)}"] > .find-row-main`)?.focus({ preventScroll: true })
  })
  // a press inside an open row is the person acting on it: it stays where it is until they leave
  list.addEventListener('click', (event) => {
    const inBody = event.target instanceof Element ? event.target.closest('.find-row-body, .find-slot') : null
    if (findStale && inBody) {
      // the card belongs to the previous list: a press here must not be remembered for later
      event.stopPropagation()
      event.preventDefault()
      return
    }
    // a chat row's slot is the person acting on it too
    const control = event.target instanceof Element ? event.target.closest('.find-row-body button, .find-slot button') : null
    const key = control?.closest('.find-row[data-find-key]')?.dataset.findKey
    if (!key) return
    findKept.add(key)
  }, true)
  // back on screen with a query: read what it searches at once, not on the next tick
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden' && activeTab === 'find' && findQuery.trim()) requestHistoryPaint()
  })
  // a chats change held by a press is drawn once the press ends, after its click has landed
  const releaseChats = () => { if (chatsHeld !== null) setTimeout(flushChatsHeld, 0) }
  window.addEventListener('pointerup', releaseChats, true)
  window.addEventListener('pointercancel', releaseChats, true)
  list.addEventListener('pointerenter', () => { findPointerIn = true })
  list.addEventListener('pointerleave', () => { findPointerIn = false })
  document.getElementById('tabs')?.addEventListener('pointerdown', (event) => {
    findEntryTouch = event.pointerType === 'touch'
  }, true)
}

const STATUS_LABEL = {
  done: 'Done',
  partial: 'In progress',
  missing: 'Missing',
  tracked: 'Tracked',
  na: 'Not applicable',
  blocked: 'Needs input',
}

// UX pass, slice 3: a step's mark on the Plans page, in the bar's vocabulary
// (done, in progress, needs you, to do). Missing and not applicable keep their
// marks. A blocked step that does not need the person (answered, set aside,
// pinned) is a ring that says why; on an archived plan it is to do.
function stepMark(r, needs, archived) {
  if (r.status === 'blocked' && !archived) {
    if (needs) return { glyph: '●', state: 'needs', label: 'Needs you' }
    const later = laterReason(r)
    const why = later === 'pinned' ? 'Pinned for later'
      : later === 'snoozed' ? `Set aside until ${new Date(r.snoozed_until).toLocaleString()}`
        : 'Answered, waiting for the agent'
    const unseen = humanActedOnRow(r) && !rowPickup(r).pickedUp
    return { glyph: '◯', state: 'todo', label: `${why}${unseen ? ' · not yet delivered' : ''}` }
  }
  const marks = {
    done: { glyph: '✓', state: 'done', label: 'Done' },
    partial: { glyph: '◐', state: 'progress', label: 'In progress' },
    missing: { glyph: '×', state: 'todo', label: 'Missing' },
    na: { glyph: '—', state: 'na', label: 'Not applicable' },
  }
  return marks[r.status] ?? { glyph: '○', state: 'todo', label: 'To do' }
}

// boards where the human clicked "show" on hidden done rows, overriding the
// global hide-completed pill for that board only
const showDoneBoards = new Set()

let showArchived = false            // session-only: the archived fold is not persisted
const sessionActiveBoards = new Set() // board ids seen active at some point this session (§9)

// ── UX pass, slice 3: Plans as bars ──
// Every open or armed state lives here: the list is rebuilt on every painted frame.
const PLAN_BAR_STEPS = 24 // one segment per step up to this many counted steps, then runs
// The person's own choice for a plan, from a click on its summary or a way in
// that targets it: true is the full plan, false the summary alone (session only).
// A default form is never written here.
const planOpen = new Map()
let stalledOpen // the Stalled fold: undefined (no choice), true or false
// A plan the person writes to from Plans keeps its section for the visit, and
// the order pin keeps its slot, so nothing moves under the hand.
const planHold = new Map()
// Steps the person opened or wrote to from Plans this visit: they stay in hand, shown with
// their mark, after their panel closes.
const visitRows = new Set()
let plansPin = { needs: [], moving: [], stalled: [] }
let plansVisit = null // navigationKey() of the Plans visit the pin, hold and notice belong to
let plansViewOpen = false // the header's View: Group by parent issue and Hide completed rows
// what the last paint drew, active plans only: id -> { section, board }. Replaced, never mutated:
// Archive all reads the frame the person clicked.
let plansDrawn = new Map()
let stalledArm = null // { ids, lens, timer } while "Really archive N plans?" waits for its confirm
const ARM_CONFIRM_GAP_MS = 400 // a confirm sooner than this after arming is the same gesture
let stalledArchiving = null // { n } while Archive all runs
const handArchived = new Set() // plans Archive all archived: they never linger as "completed — archived"
let plansNotice = null // { text, lens }: Archive all's report
let movingMoreReveals = null // the first plan Moving's "Show N more" reveals, until the next frame has restored focus

// A new visit (Plans entered, or a lens change) drops the pin, the holds, the
// notice and an armed Archive all, as Home's list drops its own on a lens change.
function syncPlansVisit() {
  const key = activeTab === 'boards' ? navigationKey() : null
  if (key !== null && key === plansVisit) return
  plansVisit = key
  plansPin = { needs: [], moving: [], stalled: [] }
  planHold.clear()
  visitRows.clear()
  disarmArchive()
  plansNotice = null
  disarmStalled()
}

// The plans a working session's Home card shows: never Stalled.
function workingPlanIds(nowMs) {
  const activity = lastData.activity ?? []
  const working = new Set(activity.filter((row) => isWorking(row, nowMs)).map((row) => row.session))
  const ids = new Set()
  for (const row of activity) {
    if (!isWorking(row, nowMs)) continue
    const plan = linkedPlan(row, lastData.boards, working)
    if (plan) ids.add(plan.id)
  }
  return ids
}

// A step the person has in hand: it waits on them, is open, was opened or written to this
// visit, or holds their unsent words.
function keptRowIds(b, archived, { asks = !archived } = {}) {
  const ids = new Set()
  for (const { row: r, needsAnswer } of boardRowsView(b, { hideCompleted, showDone: showDoneBoards.has(b.id) })) {
    if ((needsAnswer && asks) || openRows.has(r.id) || visitRows.has(r.id) || String(rowDrafts[r.id] ?? '').trim()
      || Object.values(staleRowDrafts).some((draft) => draft?.rowId === r.id)) ids.add(r.id)
  }
  return ids
}

// Closing a plan (or the Stalled fold) by hand closes its open steps; their drafts stay stored.
function closePlanSteps(plans) {
  for (const b of plans) {
    for (const r of b.rows ?? []) {
      openRows.delete(r.id)
      visitRows.delete(r.id)
    }
  }
}

// The order of a section for this visit: drawn plans keep their places, new ones join the foot.
function pinnedSection(name, plans) {
  if (activeTab !== 'boards') return plans
  plansPin[name] = pinOrder(plansPin[name], plans.map((b) => b.id))
  const byId = new Map(plans.map((b) => [b.id, b]))
  return plansPin[name].map((id) => byId.get(id))
}

// Whether a plan is Stalled on its own, as the sections would say with no hold applied: a
// hold may keep a plan drawn in the fold, but Archive all archives only plans that qualify.
function meetsStalledRule(board) {
  const nowMs = Date.now()
  return planSections([board], { nowMs, liveSessions: liveSessionIds(), workingPlanIds: workingPlanIds(nowMs) }).stalled.length === 1
}

const plansWord = (n) => (n === 1 ? '1 plan' : `${n} plans`)

function planSectionHead(name, count) {
  const head = document.createElement('h3')
  head.className = 'plan-section-head'
  head.dataset.section = name
  head.textContent = name === 'needs' ? 'Needs you' : 'Moving'
  if (count) {
    const n = document.createElement('span')
    n.className = 'plan-section-count'
    n.textContent = String(count)
    // a screen reader hears what is counted; the visible text is the number alone
    const noun = document.createElement('span')
    noun.className = 'visually-hidden'
    noun.textContent = count === 1 ? ' plan' : ' plans'
    head.append(' ', n, noun)
  }
  return head
}

// the Plans header: the list's first heading and View on one line, the tools
// under View (out of sight until used, forced open while grouping), then the
// notice Archive all leaves. Built on every paint; the shell ships an empty panel.
function boardsHeader(firstHead) {
  const bar = document.createElement('div')
  bar.className = 'tab-header plans-header'
  const line = document.createElement('div')
  line.className = 'plans-head'
  if (firstHead) line.appendChild(firstHead)
  const shown = () => plansViewOpen || groupByParent
  const tools = document.createElement('div')
  tools.className = 'plans-tools'
  tools.id = 'plansTools'
  tools.hidden = !shown()
  const view = btn('View', () => {
    // forced open while grouping is on: there is nothing for View to do
    if (groupByParent) return
    plansViewOpen = !shown()
    tools.hidden = !shown()
    view.setAttribute('aria-expanded', String(shown()))
  })
  view.type = 'button'
  view.id = 'plans-view-toggle'
  view.className = 'plans-view-toggle'
  view.setAttribute('aria-controls', 'plansTools')
  view.setAttribute('aria-expanded', String(shown()))
  if (groupByParent) {
    view.setAttribute('aria-disabled', 'true')
    view.title = 'Shown while grouping is on'
  }
  line.appendChild(view)
  const t = btn(hideCompleted ? 'Show completed rows' : 'Hide completed rows', () => {
    hideCompleted = !hideCompleted
    plansViewOpen = true
    localStorage.setItem(HIDE_DONE_KEY, String(hideCompleted))
    forceRender()
  })
  t.className = `header-toggle${hideCompleted ? ' active' : ''}`
  t.id = 'plans-hide-done'
  const group = document.createElement('label')
  group.className = 'header-switch'
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.id = 'group-plans-switch'
  input.setAttribute('role', 'switch')
  input.checked = groupByParent
  input.addEventListener('change', () => {
    groupByParent = input.checked
    plansViewOpen = true
    forceRender()
  })
  group.append(input, document.createTextNode('Group by parent issue'))
  tools.append(group, t)
  bar.append(line, tools)
  if (plansNotice && plansNotice.lens === plansVisit) bar.appendChild(plansNoticeEl())
  return bar
}

function plansNoticeEl() {
  const notice = document.createElement('p')
  notice.className = 'plans-notice'
  notice.setAttribute('role', 'status')
  const text = document.createElement('span')
  text.textContent = plansNotice.text
  const dismiss = btn('Dismiss', () => {
    const hadFocus = notice.contains(document.activeElement)
    plansNotice = null
    notice.remove()
    if (hadFocus) document.getElementById('plans-view-toggle')?.focus({ preventScroll: true })
  })
  dismiss.type = 'button'
  dismiss.id = 'plans-notice-dismiss' // stable, so the header's focus restore keeps it
  dismiss.className = 'plans-notice-dismiss'
  notice.append(text, ' ', dismiss)
  return notice
}

function renderBoards(boards, archived) {
  const host = document.querySelector('#boards .boards')
  host.innerHTML = ''
  syncPlansVisit()
  const nowMs = Date.now()
  const live = new Set(boards.map((b) => b.id))
  for (const id of [...planHold.keys()]) if (!live.has(id)) planHold.delete(id)
  // a board that reaches 100% is archived by its agent seconds later; it lingers
  // here as a "completed — archived" card so finished work never blinks out (§9).
  // A plan the person archived with Archive all never does.
  const lingering = lingeringPlans(boards, archived)
  const lingerIds = new Set(lingering.map((b) => b.id))
  const rest = archived.filter((b) => !lingerIds.has(b.id))
  // Issue #299: archived plans are drawn whole only from the complete list, or
  // a lingering one from its own read (#373). The brief already knows which
  // plans linger and how many are archived, so both keep their places and
  // counts while they load.
  const whole = Boolean(lastData.archivedFull)
  const lingerWhole = new Map(wholeArchived().map((plan) => [plan.id, plan]))
  const drawn = lingering.flatMap((b) => lingerWhole.get(b.id) ?? [])
  const sections = planSections(boards, {
    nowMs, liveSessions: liveSessionIds(), workingPlanIds: workingPlanIds(nowMs), held: planHold,
  })
  const sectionOf = new Map()
  for (const name of ['needs', 'moving', 'stalled']) for (const b of sections[name]) sectionOf.set(b.id, name)
  const frame = new Map()
  const planEl = (b) => {
    frame.set(b.id, { section: sectionOf.get(b.id), board: b })
    return boardEl(b, false, false, sectionOf.get(b.id))
  }
  // Grouping only reorders active plans; lingering and archived ones stay flat (§7.2).
  // With it on the page keeps its grouped order, headings and paging: no sections.
  const grouping = groupByParent ? planGroups(boards, issueView, linkIndex) : null
  const needs = grouping ? [] : pinnedSection('needs', sections.needs)
  const moving = grouping ? [] : pinnedSection('moving', sections.moving)
  const stalled = grouping ? [] : pinnedSection('stalled', sections.stalled)
  const asking = needs.filter((b) => (b.rows ?? []).some((r) => isBlockedRowAttention(r, nowMs))).length
  const heads = []
  if (needs.length) heads.push(planSectionHead('needs', asking))
  if (moving.length) heads.push(planSectionHead('moving', 0))
  // the first heading sits in the header's line, beside View: no almost-empty row above it
  host.appendChild(boardsHeader(heads[0] ?? null))
  if (!boards.length && !lingering.length && !rest.length) host.insertAdjacentHTML('beforeend', '<p class="empty">No plans yet.</p>')
  if (grouping) {
    const page = paginateWithPending(grouping.plans, 'boards')
    // the page also holds any plan with a step in hand (an open step, a restored draft), as Moving's does
    const onPage = new Set(page.visible.map((b) => b.id))
    const visible = grouping.plans.filter((b) => onPage.has(b.id) || keptRowIds(b, false, { asks: false }).size > 0)
    const remaining = grouping.plans.length - visible.length
    visible.forEach((b, i) => {
      const group = grouping.groupOf.get(b.id)
      const previous = i > 0 ? grouping.groupOf.get(visible[i - 1].id) : undefined
      // each "Show more" page that opens inside a group repeats its header
      const continued = group !== undefined && group === previous && i % PAGE.boards === 0
      if (group && (group !== previous || continued)) {
        host.insertAdjacentHTML('beforeend', planGroupHeadHtml(group, Date.now(), { continued }))
      }
      const el = planEl(b)
      if (group) el.classList.add('in-group')
      host.appendChild(el)
    })
    if (remaining > 0) host.appendChild(moreButton('boards', remaining))
  } else {
    // Needs you is never paged
    for (const b of needs) host.appendChild(planEl(b))
    if (moving.length) {
      if (needs.length) host.appendChild(heads[1])
      // Moving's first page always holds a deep-link target and any plan with a step in hand
      const page = paginateWithPending(moving, 'moving')
      const onPage = new Set(page.visible.map((b) => b.id))
      const listed = moving.filter((b) => onPage.has(b.id) || keptRowIds(b, false).size > 0)
      for (const b of listed) host.appendChild(planEl(b))
      if (moving.length > listed.length) {
        const more = moreButton('moving', moving.length - listed.length)
        const firstHidden = moving.find((b) => !listed.includes(b))?.id
        more.id = 'plans-moving-more'
        more.addEventListener('click', () => { movingMoreReveals = firstHidden ?? null }, true)
        host.appendChild(more)
      }
    }
    if (stalled.length) host.appendChild(stalledFoldEl(stalled, planEl))
  }
  plansDrawn = frame
  for (const b of drawn) host.appendChild(boardEl(b, true, true))
  if (drawn.length < lingering.length) host.appendChild(archivedWaitEl(lastData.archivedError ?? lastData.lingerError))
  if (rest.length) {
    // un-archive is the only undo for Archive, so archived boards fold in here —
    // they must never become unreachable (spec §9)
    const fold = document.createElement('details')
    fold.className = 'archived-fold'
    fold.open = showArchived
    // Opening the fold is a human entry point: it reads the complete archived
    // plans it shows (#299). A fold rebuilt open asks for nothing.
    fold.addEventListener('toggle', () => {
      const opened = fold.open && !showArchived
      showArchived = fold.open
      if (opened) requestHistoryPaint()
    })
    fold.innerHTML = `<summary id="plans-archived-summary">Archived plans (${rest.length})</summary>`
    if (whole) {
      const page = paginateWithPending(rest, 'archived')
      for (const b of page.visible) fold.appendChild(boardEl(b, true))
      if (page.remaining > 0) fold.appendChild(moreButton('archived', page.remaining))
    } else {
      fold.appendChild(archivedWaitEl())
    }
    host.appendChild(fold)
  }
}

// The Stalled fold: plans a week without a step, with nothing waiting on the
// person and nothing an agent has yet to pick up. Its plans are built inside it,
// open or closed, as the archived fold's are.
function stalledFoldEl(plans, planEl) {
  const fold = document.createElement('details')
  fold.className = 'stalled-fold'
  fold.open = stalledOpen ?? plans.some((b) => keptRowIds(b, false).size > 0)
  const summary = document.createElement('summary')
  summary.id = 'plans-stalled-summary'
  const title = document.createElement('h3')
  title.className = 'stalled-title'
  title.textContent = 'Stalled'
  const count = document.createElement('span')
  count.className = 'stalled-count'
  count.textContent = `${plansWord(plans.length)}, a week without a step`
  summary.append(title, count)
  // the person's own click is the only writer of its open state (as a plan's summary is)
  summary.addEventListener('click', (e) => {
    if (e.defaultPrevented) return
    e.preventDefault()
    stalledOpen = !fold.open
    if (!stalledOpen) closePlanSteps(plans)
    forceRender()
  })
  const actions = document.createElement('div')
  actions.className = 'stalled-actions'
  const archive = document.createElement('button')
  archive.type = 'button'
  archive.id = 'plans-archive-stalled'
  ignoreKeyRepeat(archive)
  archive.className = 'archive-stalled'
  const qualifying = plans.filter(meetsStalledRule).length
  labelArchiveStalled(archive, qualifying)
  archive.addEventListener('click', (event) => archiveStalled(archive, event))
  actions.appendChild(archive)
  // plans only a hold keeps here are Stalled no longer: with none left, there is nothing to archive
  fold.append(summary)
  if (qualifying) fold.append(actions)
  for (const b of plans) fold.appendChild(planEl(b))
  return fold
}

// One label at a time, all three sharing one width: "Archive all N plans",
// armed "Really archive N plans?", in flight "Archiving N plans…".
function labelArchiveStalled(button, drawnCount) {
  const text = stalledArchiving ? `Archiving ${plansWord(stalledArchiving.n)}…`
    : stalledArm ? `Really archive ${plansWord(stalledArm.ids.length)}?`
      : `Archive all ${plansWord(drawnCount)}`
  if (button.textContent !== text) button.textContent = text
  button.classList.toggle('confirm', Boolean(stalledArm) && !stalledArchiving)
  if (stalledArchiving) button.setAttribute('aria-disabled', 'true')
  else button.removeAttribute('aria-disabled')
}

function relabelArchiveStalled() {
  const button = document.getElementById('plans-archive-stalled')
  if (!button) return
  labelArchiveStalled(button, [...plansDrawn.values()].filter((d) => d.section === 'stalled' && meetsStalledRule(d.board)).length)
}

function disarmStalled() {
  if (!stalledArm) return
  clearTimeout(stalledArm.timer)
  stalledArm = null
  relabelArchiveStalled()
}

// Arming and disarming change module state and the label in place, never the
// node, so the confirm click lands on the button the first click armed.
async function archiveStalled(button, event) {
  if (stalledArchiving) return
  // one gesture never arms and confirms: a double click, or a press right after arming, does nothing
  if (event?.detail > 1) return
  const lens = navigationKey()
  if (!stalledArm || stalledArm.lens !== lens) {
    disarmStalled()
    disarmArchive() // one armed button at a time
    // only plans that are Stalled on their own: a hold may keep another drawn in the fold
    const ids = [...plansDrawn].filter(([, d]) => d.section === 'stalled' && meetsStalledRule(d.board)).map(([id]) => id)
    if (!ids.length) return
    const timer = setTimeout(() => {
      stalledArm = null
      relabelArchiveStalled()
    }, 4000)
    // the notice stays: taking it away would move the armed button up under the pointer
    stalledArm = { ids, lens, timer, at: Date.now() }
    labelArchiveStalled(button, ids.length)
    return
  }
  if (Date.now() - stalledArm.at < ARM_CONFIRM_GAP_MS) return
  clearTimeout(stalledArm.timer)
  const armed = stalledArm.ids
  stalledArm = null
  // the confirm press starts: the new report replaces the old notice
  plansNotice = null
  document.querySelector('#boards .plans-notice')?.remove()
  // the list is taken ONCE, from the frame the person clicked: the plans it still
  // drew as stalled, at the revisions it drew, minus any holding unsent text
  const frame = plansDrawn
  const list = []
  let changed = 0
  let kept = 0
  for (const id of armed) {
    const drawn = frame.get(id)
    if (drawn?.section !== 'stalled' || !meetsStalledRule(drawn.board)) changed += 1
    else if ((drawn.board.rows ?? []).some((r) => String(rowDrafts[r.id] ?? '').trim()
      || Object.values(staleRowDrafts).some((draft) => draft?.rowId === r.id))) kept += 1
    else list.push({ id, revision: drawn.board.revision })
  }
  const hadFocus = document.activeElement === button
  stalledArchiving = { n: armed.length }
  labelArchiveStalled(button, armed.length)
  let done = 0
  let failed = 0
  try {
    for (const { id, revision } of list) {
      const res = await postJSON(`/api/boards/${id}/archive`, { expected_version: revision })
      if (res === null) failed += 1 // network failure — postJSON already signaled it
      else if (res.ok) {
        done += 1
        handArchived.add(id)
        sessionActiveBoards.delete(id) // after the request, never before: it must not linger as "completed — archived"

      } else changed += 1
    }
    plansNotice = { lens, text: archiveReport(armed.length, done, changed, kept, failed) }
    await reloadAndPaint() // #38 — the human's own click gets its frame
  } finally {
    stalledArchiving = null
    relabelArchiveStalled()
    // only when focus was lost with the button: the person may have moved it meanwhile
    if (hadFocus && !document.getElementById('plans-archive-stalled')
      && (!document.activeElement || document.activeElement === document.body)) {
      ;(document.getElementById('plans-archived-summary') ?? document.getElementById('plans-view-toggle'))?.focus({ preventScroll: true })
    }
  }
}

// A plan the person writes to from Plans (an answer, an option, "I've done my
// part", set aside or stop waiting, "Not done after all", a note) is held in
// the section it was drawn in before the write leaves, so its own repaint and
// the next polls keep it under the hand. Every such write starts inside a
// step's panel, by a click or Mod+Enter, so the panel row is where to listen.
function initPlansHold() {
  const hold = (event) => {
    const target = event.target instanceof Element ? event.target : null
    const panelRow = target?.closest('#boards tr.row-panel-row')
    if (!panelRow) return
    if (panelRow.dataset.rowId) visitRows.add(panelRow.dataset.rowId)
    const id = target.closest('#boards [data-card-id]')?.dataset.cardId
    const drawn = id ? plansDrawn.get(id) : null
    if (drawn && !planHold.has(id)) planHold.set(id, drawn.section)
  }
  const panel = document.getElementById('boards')
  panel?.addEventListener('click', hold, true)
  panel?.addEventListener('keydown', (event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) hold(event) }, true)
}

function archiveReport(n, done, changed, kept, failed) {
  if (done === n) return `Archived ${plansWord(n)}.`
  const parts = [`Archived ${done} of ${plansWord(n)}.`]
  if (changed) parts.push(changed === 1 ? '1 had changed since you looked and was left as it is.' : `${changed} had changed since you looked and were left as they are.`)
  if (kept) parts.push(kept === 1 ? '1 has text you have not sent and was kept.' : `${kept} have text you have not sent and were kept.`)
  if (failed) parts.push(failed === 1 ? '1 was not sent; try again.' : `${failed} were not sent; try again.`)
  return parts.join(' ')
}

// Where archived plans are drawn whole while the complete list is not loaded
// (#299), or a lingering plan's own read (#373): still loading, or unavailable
// when the last read it waits on failed.
function archivedWaitEl(error = lastData?.archivedError) {
  const wait = document.createElement('p')
  wait.className = 'empty archived-loading'
  wait.setAttribute('role', 'status')
  wait.textContent = archivedWaitText('Loading archived plans…', error)
  return wait
}

// The segmented bar: one segment per step, or runs of equal states past the limit.
function planBarHtml({ runs, segments }, label) {
  const parts = segments.map(({ state, grow }) =>
    `<span class="plan-seg" data-state="${state}"${grow > 1 ? ` style="flex-grow:${grow}"` : ''}></span>`)
  return `<span class="plan-bar${runs ? ' runs' : ''}" role="img" aria-label="${esc(label)}">${parts.join('')}</span>`
}

// A plan is one line (its summary) and, below it, one of three forms (planForm):
// closed, brief (only the steps in hand) or full (the meta line, chips, every
// step and the actions). Its steps are built in every form.
function boardEl(b, archived = false, lingering = false, section = null) {
  const el = document.createElement('details')
  const p = progressLabel(b.progress)
  el.className = `board${p.complete ? ' complete' : ''}${archived ? ' archived' : ''}${lingering ? ' lingering' : ''}`
  el.dataset.cardId = b.id
  const kept = keptRowIds(b, archived)
  const form = planForm({ choice: planOpen.get(b.id), section, kept: kept.size > 0 })
  el.dataset.form = form
  if (section) el.dataset.section = section
  el.open = form !== 'closed'
  const brief = form === 'brief'
  const stream = b.stream ? ` · ${esc(b.stream)}` : ''
  const c = pcolor(b.project)
  const hidden = hiddenDoneCount(b, { hideCompleted, showDone: showDoneBoards.has(b.id) })
  const { states, counts } = planStepStates(b, Date.now())
  el.innerHTML = `<summary class="card-summary plan-line"><span class="proj-dot" style="background:${c.dot}" aria-hidden="true"></span><span class="board-title" title="${esc(b.title)}">${esc(b.title)}</span>${planBarHtml(planSegments(states, PLAN_BAR_STEPS), planBarLabel(counts))}<span class="plan-count" aria-hidden="true">${b.progress.done} of ${b.progress.countable}</span>${p.complete ? '<span class="complete-badge">✓ complete</span>' : ''}${lingering ? '<span class="linger-badge">completed — archived</span>' : ''}<span class="plan-chevron" aria-hidden="true"></span></summary>`
  // The person's own click is the only writer of a plan's choice; the native
  // toggle never is (every programmatic open fires it). A full plan collapses (to
  // brief or closed, by the rule in planForm) and closes its open steps; any other
  // plan expands. The page redraws the plan in its new form.
  el.querySelector(':scope > summary').addEventListener('click', (e) => {
    if (e.defaultPrevented) return
    e.preventDefault()
    if (form === 'full') {
      planOpen.set(b.id, false)
      closePlanSteps([b])
    } else planOpen.set(b.id, true)
    forceRender()
  })
  // What the summary carried before: one quiet line at the top of the full plan
  const meta = document.createElement('div')
  meta.className = 'board-meta'
  meta.hidden = brief
  meta.innerHTML = `<span class="board-id" title="board id">#${esc(b.id.slice(0, 6))}</span> · <span>${esc(b.project)}${stream} · ${esc(b.agent)}</span> · <span class="prog-secondary">${p.secondary} weighted</span>`
  if (hidden) {
    const hint = btn(`${hidden} done hidden — show`, () => {
      showDoneBoards.has(b.id) ? showDoneBoards.delete(b.id) : showDoneBoards.add(b.id)
      forceRender()
    })
    hint.type = 'button'
    hint.className = 'hidden-hint'
    hint.title = "show this plan's completed steps"
    meta.append(' · ', hint)
  }
  el.appendChild(meta)
  // issue #30 — deliberately OUTSIDE the <summary>: a summary's activation
  // behaviour toggles its parent <details>, so a chip inside it would navigate
  // AND collapse the card. preventDefault is not reusable here — on an anchor it
  // kills the navigation we want.
  const srcHtml = sourceChipsHtml(linkIndex, b, Date.now(), { tabbable: true, issues: issueView })
    + planWaitsChipHtml(b, Date.now(), { tabbable: true, issues: issueView })
  if (srcHtml) {
    const src = document.createElement('div')
    src.className = 'board-source'
    src.hidden = brief
    src.innerHTML = srcHtml
    el.appendChild(src)
  }
  // issue #103 — the pinned issue's parent trail and sub-issues, also outside <summary>
  const relHtml = issueRelationsHtml(linkIndex, b, Date.now(), { issues: issueView })
  if (relHtml) {
    const rel = document.createElement('div')
    rel.className = 'board-issues'
    rel.hidden = brief
    rel.innerHTML = relHtml
    bindIssueActivity(rel)
    el.appendChild(rel)
  }
  const table = document.createElement('table')
  table.className = 'board-table matrix'
  // A fixed-layout table sizes its columns from these, never from its first
  // row, which may be a full-width "Part of #N" header (#103 slice 2).
  table.innerHTML = '<colgroup><col class="col-num"><col class="col-glyph"><col class="col-label"><col class="col-4"><col class="col-5"></colgroup>'
  const shownRows = boardRowsView(b, { hideCompleted, showDone: showDoneBoards.has(b.id) })
  const runs = groupByParent && !archived ? rowParentRuns(shownRows.map(({ row }) => row), issueView) : null
  let runHead = null
  for (const { row: r, num, needsAnswer } of shownRows) {
    const runParent = runs?.get(r.id)
    if (runParent) {
      runHead = document.createElement('tr')
      runHead.className = 'row-parent-run'
      runHead.innerHTML = rowParentHeadHtml(runParent, b)
      // in the brief form a run's heading shows only above a step that shows
      runHead.hidden = brief
      table.appendChild(runHead)
    }
    // the tint, the bold label and Answer belong to a step that waits on the person now
    const needs = needsAnswer && !archived
    const away = brief && !kept.has(r.id)
    if (runHead && !away) runHead.hidden = false
    const tr = document.createElement('tr')
    tr.className = `board-row${needs ? ' needs-answer' : ''}${openRows.has(r.id) ? ' open' : ''}`
    tr.dataset.rowId = r.id
    tr.hidden = away
    const mark = stepMark(r, needs, archived)
    // one-line note only; the long context lives behind the row click. A row
    // linked to its own issue (#103) names it first, where a long note cannot hide it.
    // slice 2 §9.1: what the row waits on, after its issue chip
    const rowSrc = rowIssueChipsHtml(r, b, Date.now(), { issues: issueView }) + rowWaitsChipHtml(r, b, Date.now(), { issues: issueView })
    tr.innerHTML = `
      <td class="row-num">${num}</td>
      <td class="row-glyph ${r.status} step-${mark.state}"><span class="step-mark" role="img" aria-label="${esc(mark.label)}" title="${esc(mark.label)}">${mark.glyph}</span></td>
      <td class="row-label">${esc(r.label)}</td>
      <td class="row-note">${rowSrc ? `<span class="row-src">${rowSrc}</span>` : ''}<span class="note-line">${esc(boardRowLine(r))}</span>${r.context ? '<span class="more-dot" title="has background — click the row">…</span>' : ''}${r.annotation ? `<span class="annotation-dot" title="${esc(r.annotation)}">Note${r.annotation_unseen ? '<span class="unseen" title="not yet delivered to an agent">●</span>' : ''}</span>` : ''}${r.handled_at ? `<span class="handled-dot" title="you marked your part done">✓${r.handled_seen_at ? '' : '<span class="unseen" title="not yet delivered to an agent">●</span>'}</span>` : ''}</td>`
    const actionTd = document.createElement('td')
    actionTd.className = 'row-action'
    const toggle = () => {
      // any press counts as a touch this visit, so the row stays on screen when its panel closes,
      // also for a step left open from an earlier visit
      visitRows.add(r.id)
      if (openRows.has(r.id)) openRows.delete(r.id)
      else openRows.add(r.id)
      forceRender()
    }
    if (needs) {
      const a = btn('Answer', toggle)
      a.className = 'answer-btn'
      actionTd.appendChild(a)
    } else if (r.context || !archived) {
      const a = btn(openRows.has(r.id) ? '▾' : '▸', toggle)
      a.className = 'row-expand'
      actionTd.appendChild(a)
    }
    tr.appendChild(actionTd)
    tr.addEventListener('click', (e) => { if (!e.target.closest('button, input, a')) toggle() })
    table.appendChild(tr)
    if (openRows.has(r.id)) {
      const ptr = document.createElement('tr')
      ptr.className = 'row-panel-row'
      ptr.dataset.rowId = r.id
      ptr.hidden = away
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
  actions.hidden = brief
  actions.appendChild(btn('Plan flow', () => openMission(b)))
  if (archived) {
    actions.appendChild(btn('Un-archive', async () => {
      const res = await postJSON(`/api/boards/${b.id}/unarchive`, { expected_version: b.revision })
      if (res === null) return // network failure — postJSON already signaled it
      handArchived.delete(b.id) // back among the active plans, it may linger again when its agent finishes it
      await reloadAndPaint() // #38 — the human's own click gets its frame
    }))
  } else {
    actions.appendChild(archiveBtn(b))
  }
  el.appendChild(actions)
  return el
}

// two-step inline confirm: first click arms ("Really archive?"), second click within
// 4s archives. The armed state lives in module state (the list is rebuilt on every
// painted frame, and a rebuilt button is drawn from it): arming and the 4 second
// disarm rewrite the label in place and never render.
let archiveArm = null // { id, until, timer } for the one plan whose Archive is armed
const ARCHIVE_ARM_MS = 4000

function paintArchiveButton(el, armed) {
  el.classList.toggle('confirm', armed)
  const text = armed ? 'Really archive?' : 'Archive'
  if (el.textContent !== text) el.textContent = text
}

// A held Enter clicks a focused button once per repeat: the first arms and a later one would confirm.
// Only a fresh key press may activate an archive button.
function ignoreKeyRepeat(button) {
  button.addEventListener('keydown', (e) => { if (e.repeat && (e.key === 'Enter' || e.key === ' ')) e.preventDefault() })
}

function disarmArchive() {
  if (!archiveArm) return
  clearTimeout(archiveArm.timer)
  const { id } = archiveArm
  archiveArm = null
  const el = document.getElementById(`plan-archive-${id}`)
  if (el) paintArchiveButton(el, false)
}

function archiveBtn(board) {
  // armed only while the plan is the one the person armed: a change to it (a new ask, say) shows
  // "Archive" again, so they see the new state before they can confirm
  const armed = () => archiveArm?.id === board.id && archiveArm.revision === board.revision && Date.now() < archiveArm.until
  const el = btn('Archive', async () => {
    if (armed()) {
      disarmArchive()
      // a board the HUMAN archives by hand must not linger — lingering is only
      // for the agent's own auto-archive at 100% (spec §9)
      sessionActiveBoards.delete(board.id)
      const res = await postJSON(`/api/boards/${board.id}/archive`, { expected_version: board.revision })
      if (res === null) return // network failure — postJSON already signaled it
      await reloadAndPaint() // #38 — the human's own click gets its frame
      return
    }
    disarmArchive()
    disarmStalled() // one armed button at a time
    const timer = setTimeout(() => {
      if (archiveArm?.id === board.id) disarmArchive()
    }, ARCHIVE_ARM_MS)
    archiveArm = { id: board.id, revision: board.revision, until: Date.now() + ARCHIVE_ARM_MS, timer }
    paintArchiveButton(el, true)
  })
  ignoreKeyRepeat(el)
  el.id = `plan-archive-${board.id}` // the in-place disarm finds the button by it
  paintArchiveButton(el, armed())
  return el
}

// answer-back UI state that must survive the 3s poll rebuild
// UX pass, slice 1: every ask opens with each option's detail cut to one line;
// Compare shows them in full, per ask, until the human hides them again.
const openCompares = new Set()
const openRowCompares = new Set()
// The compact surface (the session panel, #454 A.2) opens with the options
// alone; Compare stacks each option's tradeoff under it.
const compactCompares = new Set()
const comparing = (open, id, surface) => (surface ? compactCompares : open).has(id)
function toggleCompare(open, id, surface) {
  const set = surface ? compactCompares : open
  if (set.has(id)) set.delete(id)
  else set.add(id)
}
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
const itemNoteDrafts = {}        // item id → pending or unconfirmed Note save
// UX pass, slice 4, step 0: item id → { title, text } of its open Note editor. A typed
// draft like an answer's: it holds the poll's rebuild while in use and survives a reload.
const itemNoteEditors = {}
const NOTE_REFUSED = 'Note was not saved — this item is closed or no longer available.'
const NOTE_UNCONFIRMED = 'Note save was not confirmed — review the stored note before retrying.'
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
  // The claiming window's identity and the answer this send is made against
  // travel with the intent: a stored draft retried from another window replays
  // this exact intent, and only while that answer still stands (savedIntentRule).
  // The answer is the newest this window knows, which the rule compares it with.
  const intent = {
    sequence,
    actionId: globalThis.crypto.randomUUID(),
    clientId: storedReplyIntent.clientId,
    pin: draftAnswerOf(knownAnswer(id)),
  }
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

// Every reply response reports the answer it left (#322); it is the newest
// this window knows until the next poll applies (#321).
function postItemReply(id, body, intent) {
  return postJSON(`/api/items/${id}/reply`, {
    ...body,
    intent_client_id: intent.clientId ?? storedReplyIntent.clientId,
    intent_sequence: intent.sequence,
    intent_action_id: intent.actionId,
  }).then((res) => {
    noteReportedAnswer(id, res?.answer)
    return res
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
  reason = '',
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
    // why a restored draft is here (#279); a retry that fails again keeps it
    reason: reason || staleItemDrafts[recoveryKey]?.reason || '',
  }
  return recoveryKey
}

// `shown`: the answer the entry's line was drawn with (#321).
function retryItemDraft(key, draft, shown) {
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
    shown,
  )
}

function reusableDraftIntent(id, generation) {
  const retry = itemDraftRetryIntents[id]
  if (!retry || retry.generation !== generation) return null
  return retry.intent
}

function hasDraftRecovery() {
  return Object.keys(staleItemDrafts).length > 0 || Object.keys(staleRowDrafts).length > 0
    || Object.values(itemNoteDrafts).some((draft) => !draft.pending) || messageRecoveries.size > 0
}

function requestDraftRecovery(target = draftRecoveryTarget) {
  draftRecoveryFocusPending = true
  if (target === null) draftRecoveryTarget = null
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
  selectTab('dashboard', { paint: false })
}

function restoreDraftRecoveryFocus() {
  if (!draftRecoveryFocusPending) return false
  const card = draftRecoveryTarget ? needsYouRowEl(draftRecoveryTarget.rowId) : null
  // the preserved draft in the row's editor, or (#636) the text kept beside it
  const inline = card?.querySelector('.reply-input[data-recovered-draft="1"]')
    ?? card?.querySelector(`.row-recovery[data-recovery-line="${
      CSS.escape(rowDraftRecoveryKey(draftRecoveryTarget.rowId, draftRecoveryTarget.revision))}"]`)
    ?? null
  if (inline) revealDetailsAncestors(inline)
  const visibleInline = inline && !inline.closest('[hidden], details:not([open])') ? inline : null
  // the same control of the same entry when it is still there, as after a
  // Retry that kept its text; otherwise the list's own summary
  const control = draftRecoveryFocusControl
  draftRecoveryFocusControl = null
  const line = control
    ? document.querySelector(`.stale-drafts-fold .stale-draft-line[data-recovery-line="${CSS.escape(control.line)}"]`)
    : null
  const sameControl = line && control.label === null
    ? line
    : line
      ? [...line.querySelectorAll('button')].find((button) => button.textContent === control.label && !button.disabled) ?? null
      : null
  const target = visibleInline ?? sameControl ?? document.querySelector('.stale-drafts-fold summary')
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

// Whether a typed draft still belongs to the editor it was typed in. One that
// does not moves to the unsent responses in the next frame (reconcileDraftOwners);
// a row draft stays while its row still asks what it was typed for
// (followRowAsk, #636).
function itemDraftOwned(item) {
  return Boolean(item && cardSections(item).showAnswer)
}

// Moves every draft whose target moved to the unsent responses. A frame the
// human asked for then switches to the Inbox and focuses it; the poll's frame
// only sets it aside (still durable, listed in the unsent responses) and leaves
// the navigation to the next human frame, so a poll never switches tabs, closes
// the Review queue or moves focus (#563). Returns whether the caller must repaint.
function reconcileDraftOwners() {
  let recovered = false
  const itemIds = new Set([...Object.keys(draftReplies), ...Object.keys(draftReplyContexts)])
  for (const id of itemIds) {
    const text = draftReplies[id] ?? ''
    const context = draftReplyContexts[id] ?? ''
    if (!text.trim() && !context.trim()) continue
    const item = freshItem(id)
    if (itemDraftOwned(item)) continue
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
    const fate = meta ? followRowAsk(id, owner, meta, { text, kind: rowDraftKinds[id] ?? 'answer' }) : 'changed'
    if (meta && rowDraftStays(fate)) continue
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
      reason: rowRecoveryReason(fate, unconfirmedRowSends.get(id) === text, meta),
    }
    rowAskNotices.delete(id)
    bumpDraftGeneration(rowDraftGenerations, id)
    delete rowDrafts[id]
    delete rowDraftKinds[id]
    delete rowDraftMeta[id]
    recovered = true
  }
  // UX pass, slice 4, step 0: an open Note editor whose item closed or left keeps its text
  // in the unsent responses, as a refused save would
  for (const [id, editor] of Object.entries(itemNoteEditors)) {
    if (freshItem(id)?.status === 'open') continue
    delete itemNoteEditors[id]
    if (!editor.text.trim() || itemNoteDrafts[id]?.pending) continue
    itemNoteDrafts[id] = { title: editor.title, text: editor.text, pending: false, error: NOTE_REFUSED }
    recovered = true
  }
  if (recovered && pollPaint) {
    recoveryNavPending = true
    scheduleDraftSave()
    return false
  }
  if (!recovered && !recoveryNavPending) return false
  recoveryNavPending = false
  requestDraftRecovery()
  return true
}

// ── durable drafts (#279) ───────────────────────────────────────────────────
// Every unsent response this window holds (answers and their context, plan-row
// notes, Note attempts and the unsent responses list) is mirrored into this
// profile's localStorage through public/drafts.js: within DRAFT_SAVE_MS of a
// change, and again as the page goes away. Never to the server, and nothing
// here sends anything. The window's memory stays the source of truth: a save
// writes what changed since this window last loaded or wrote it, so emptying
// an editor, a successful send and Discard delete the stored copy too.
const DRAFT_SAVE_MS = 300
// Why a restored draft waits in the unsent responses. Once a send of it was
// tried and never answered, it may have landed, so it is "not confirmed",
// never "not sent".
const DRAFT_REASONS = {
  questionChanged: ['The question changed before your text was sent.', 'Your send was not confirmed, and this question has changed since.'],
  questionClosed: [
    'This question was closed or removed before your text was sent.',
    'Your send was not confirmed, and this question is closed or no longer available.',
  ],
  projectClosed: ['Kept because this project is closed.', 'Your send was not confirmed, and this project is closed.'],
  // #636: a plan row's kept text says what became of the ask it was typed for
  askChanged: ['The ask changed before your text was sent.', 'Your send was not confirmed, and the ask has changed since.'],
  stepClosed: ['This step was closed before your text was sent.', 'Your send was not confirmed, and this step has been closed since.'],
  // a draft stored without knowing whether its step was waiting: true whichever way it was typed
  stepChanged: ['This step changed before your text was sent.', 'Your send was not confirmed, and this step has changed since.'],
  stepAsked: ['This step now has an ask. Your note was not sent.', 'Your send was not confirmed, and this step has an ask now.'],
  // a row this window no longer lists: its plan may be finished or archived, or the row deleted
  stepRemoved: [
    'This step was closed or removed before your text was sent.',
    'Your send was not confirmed, and this step has been closed or removed since.',
  ],
  // #412 step 3: an app launch's approval takes only its own options, so typed text never goes back to it
  launchAsk: [
    'Not sent: this approval takes only its own options.',
    'Your send was not confirmed, and this approval takes only its own options.',
  ],
}
const draftReason = (cause, unconfirmed) => DRAFT_REASONS[cause][unconfirmed ? 1 : 0]
// Issue #322: the server answered a replay from its record of the earlier send,
// which did land, and reports an answer that is no longer this response.
const REPLY_REPLACED = 'Your send went through, but this question\'s answer has changed since.'
// An item recovery's in-memory key repeats across page loads; its stored key
// carries this load's id so a later load's recovery can never overwrite it.
const draftPageId = globalThis.crypto.randomUUID()
// key → { savedAt, json } of each entry this window loaded or last wrote. Only
// these may be deleted, and only while storage still holds that very copy.
const knownDrafts = new Map()
// What the boot read, until the first data places it (placeRestoredDrafts).
let restoredDrafts = (() => {
  let raw = null
  try {
    raw = localStorage.getItem(DRAFTS_KEY)
  } catch {
    // storage unavailable: nothing to restore, and every later save fails quietly
  }
  const loaded = readDrafts(raw, Date.now())
  for (const [key, { savedAt, draft }] of loaded) knownDrafts.set(key, { savedAt, json: JSON.stringify(draft) })
  return loaded
})()
// Restored drafts the next queue render must not leave inside a closed fold.
const revealDraftIds = new Set()
let draftSaveTimer = null

// What a question draft, and each reply intent, is pinned to: the question's
// answer, whoever wrote it. replied_at moves on every reply, clear and chat
// answer, and the text makes the pin exact; the human's own Note, which also
// moves response_revision, leaves it alone.
function draftAnswerOf(item) {
  return item
    ? { at: item.replied_at ?? null, source: item.reply_source ?? null, kind: item.reply_kind ?? null, text: item.reply ?? null }
    : null
}

function sameAnswer(left, right) {
  return Boolean(left && right && left.at === right.at && left.source === right.source
    && left.kind === right.kind && left.text === right.text)
}

function storedIntent(intent) {
  return intent
    ? {
        clientId: intent.clientId ?? storedReplyIntent.clientId,
        sequence: intent.sequence,
        actionId: intent.actionId,
        pin: intent.pin ?? null,
      }
    : null
}

function collectDrafts() {
  const drafts = new Map()
  const add = (raw, key = null) => {
    const draft = draftEntry(raw)
    if (draft) drafts.set(key ?? draftKey(draft), draft)
  }
  for (const [key, { draft }] of restoredDrafts ?? []) drafts.set(key, draft)
  for (const id of new Set([...Object.keys(draftReplies), ...Object.keys(draftReplyContexts)])) {
    const generation = itemDraftGenerations[id] ?? 0
    const submission = itemDraftSubmission(id, generation)
    add({
      type: 'reply',
      itemId: id,
      title: itemDraftMeta[id]?.title ?? freshItem(id)?.title ?? 'Question',
      text: draftReplies[id] ?? '',
      context: draftReplyContexts[id] ?? '',
      answer: itemDraftMeta[id]?.answer ?? draftAnswerOf(freshItem(id)),
      intent: storedIntent(reusableDraftIntent(id, generation) ?? (submission?.retryable ? submission.intent : null)),
    })
  }
  for (const [key, draft] of Object.entries(staleItemDrafts)) {
    add({
      type: 'item-recovery',
      itemId: draft.itemId,
      title: draft.title,
      text: draft.text,
      context: draft.context ?? '',
      kind: draft.kind,
      intent: storedIntent(draft.intent),
      reason: draft.reason ?? '',
    }, key.startsWith('item-recovery:') ? key : `item-recovery:${draftPageId}:${key}`)
  }
  for (const [id, text] of Object.entries(rowDrafts)) {
    const meta = rowDraftMeta[id]
    if (!meta) continue
    add({
      type: 'row',
      rowId: id,
      boardId: meta.boardId,
      boardRevision: meta.boardRevision,
      revision: meta.revision,
      actionVersion: meta.actionVersion ?? null,
      ask: meta.ask ?? null,
      response: meta.response ?? null,
      blocked: meta.blocked ?? null,
      notice: meta.notice ?? null,
      text,
      kind: rowDraftKinds[id] ?? 'answer',
      boardTitle: meta.boardTitle,
      label: meta.label,
      context: meta.context ?? '',
      unconfirmed: unconfirmedRowSends.get(id) === text,
    })
  }
  for (const draft of Object.values(staleRowDrafts)) {
    add({
      type: 'row-recovery',
      rowId: draft.rowId,
      revision: draft.revision,
      actionVersion: draft.actionVersion ?? null,
      text: draft.text,
      kind: draft.kind,
      boardTitle: draft.boardTitle,
      label: draft.label,
      context: draft.context ?? '',
      choice: draft.choice === true,
      setAside: draft.setAside === true,
      reason: draft.reason ?? '',
    })
  }
  for (const [id, draft] of Object.entries(itemNoteDrafts)) {
    add({ type: 'note', itemId: id, title: draft.title, text: draft.text, error: draft.error ?? '', pending: Boolean(draft.pending) })
  }
  for (const [id, editor] of Object.entries(itemNoteEditors)) {
    add({ type: 'note-edit', itemId: id, title: editor.title ?? '', text: editor.text })
  }
  // #411: one per session, in its composer or in the unsent responses
  for (const [session, draft] of [...messageRecoveries, ...messageDrafts]) {
    add({
      type: 'message', session, project: draft.project, agent: draft.agent, stream: draft.stream ?? '', text: draft.text,
      intent: draft.intent ?? null, reason: draft.reason ?? '',
    })
  }
  return drafts
}

// A refused write (a full profile) is tried once more within a tighter budget,
// then left to the next change; the drafts stay in this window's memory.
// Returns what was written, or null.
function writeDrafts(changes, nowMs) {
  for (const limits of [undefined, { maxChars: 50_000 }]) {
    try {
      const value = mergeDrafts(localStorage.getItem(DRAFTS_KEY), changes, nowMs, limits)
      localStorage.setItem(DRAFTS_KEY, value)
      return value
    } catch {
      // QuotaExceededError, or storage turned off: say nothing alarming
    }
  }
  return null
}

// `leaving`: the page is going away or out of sight. Then every draft this
// window still holds whose key storage no longer has is written too: another
// window sent or cleared that draft, no newer copy exists, and this window's
// text would otherwise be lost with it. A routine save leaves that delete
// alone, and a draft whose own last write has expired is let go.
function saveDrafts({ leaving = false } = {}) {
  clearTimeout(draftSaveTimer)
  draftSaveTimer = null
  const current = collectDrafts()
  const nowMs = Date.now()
  let present = null
  if (leaving) {
    try {
      present = readDrafts(localStorage.getItem(DRAFTS_KEY), nowMs)
    } catch {
      // storage unavailable: the write below fails quietly too
    }
  }
  const upserts = new Map()
  const deletes = new Map()
  const json = new Map()
  for (const [key, draft] of current) {
    json.set(key, JSON.stringify(draft))
    // an entry still waiting to be placed is the profile's copy, not this window's text
    const gone = present !== null && !present.has(key) && !restoredDrafts?.has(key)
      && !draftExpired(knownDrafts.get(key)?.savedAt ?? nowMs, nowMs)
    if (gone || knownDrafts.get(key)?.json !== json.get(key)) upserts.set(key, draft)
  }
  for (const [key, known] of knownDrafts) {
    if (!current.has(key)) deletes.set(key, known.savedAt)
  }
  if (!upserts.size && !deletes.size) return
  const written = writeDrafts({ upserts, deletes }, nowMs)
  if (written === null) return
  for (const key of deletes.keys()) knownDrafts.delete(key)
  // Known is what storage now holds exactly as this window holds it, under the
  // stamp it holds it: an upsert the bounds evicted is tried again, and a copy
  // the merge re-stamped keeps its compare-and-delete identity.
  for (const [key, { savedAt, draft }] of readDrafts(written, nowMs)) {
    const mine = json.get(key)
    if (mine !== undefined && JSON.stringify(draft) === mine) knownDrafts.set(key, { savedAt, json: mine })
  }
}

// At most DRAFT_SAVE_MS after the first unsaved change, however fast the typing.
function scheduleDraftSave() {
  if (draftSaveTimer === null) draftSaveTimer = setTimeout(saveDrafts, DRAFT_SAVE_MS)
}

function initDraftPersistence() {
  const leave = () => saveDrafts({ leaving: true })
  window.addEventListener('pagehide', leave)
  window.addEventListener('beforeunload', leave)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') leave() })
}

// The server already holds exactly this response, whoever sent it: nothing is unsent.
function itemHolds(item, { text, context = '', kind = 'answer' }) {
  return Boolean(item && text.trim() && (item.reply ?? '') === text.trim()
    && (item.reply_context ?? '') === context.trim() && (item.reply_kind ?? 'answer') === kind)
}

// The one rule for reusing a saved reply intent (#279): an unsent response's
// Retry, an editor's Send after an unconfirmed send, and so every intent a
// restart brings back. A send whose answer was lost may still have landed.
// When the server holds exactly this response it was delivered; once the
// question's answer moved since the intent was claimed (its pin), a replay
// would be answered from the server's record without writing anything, so
// the send must be fresh; otherwise the exact replay keeps it idempotent.
function savedIntentRule(id, intent, response) {
  const item = knownAnswer(id)
  if (itemHolds(item, response)) return 'delivered'
  return sameAnswer(intent.pin, draftAnswerOf(item)) ? 'replay' : 'fresh'
}

// Issue #321: the newest answer this window knows for a question, in the
// item's field names. A reply's response reports the answer it left (#322),
// which is newer than the last poll until a poll that started after it has
// applied. Derived view state: the poll's snapshot itself is never changed.
const reportedAnswers = {} // item id → { answer, before: the last load started when it arrived }

function noteReportedAnswer(id, answer) {
  if (answer && typeof answer === 'object') reportedAnswers[id] = { answer, before: loadGeneration }
}

function knownAnswer(id) {
  const report = reportedAnswers[id]
  if (report && appliedLoadGeneration <= report.before) return report.answer
  delete reportedAnswers[id]
  return freshItem(id)
}

// Something a send would replace: a reply or a response kind, not an
// unanswered or cleared question.
function isAnswer(pin) {
  return Boolean(pin && (pin.text || pin.kind))
}

// The last responses this window sent for each question. When the server holds
// one of them, that answer is the human's own text, perhaps from a send whose
// answer was lost, not a newer reply. Only the notice's wording reads them.
const sentReplies = {} // item id → [{ text, context, kind }], newest last

function noteSentReply(id, response) {
  sentReplies[id] = [...(sentReplies[id] ?? []), response].slice(-5)
}

// "A newer reply was sent: “Later Y”. Send replaces it.", or, when that answer
// is one this window sent, "Your earlier send went through: …". The answer
// goes through textContent only.
function newerReplyNotice(id, answer, action) {
  const pin = draftAnswerOf(answer)
  const text = pin.kind && pin.kind !== 'answer' ? `${pin.kind}: ${pin.text ?? ''}` : (pin.text ?? '')
  const own = pin.source === 'inbox' && (sentReplies[id] ?? []).some((sent) => itemHolds(answer, sent))
  return `${own ? 'Your earlier send went through' : 'A newer reply was sent'}: “${text}”. ${action} replaces it.`
}

// The newer reply each send surface has named in a notice beyond what it was
// drawn with: `item:<id>` for an answer editor, `recovery:<key>` for an
// unsent response. Seeing it there is seeing it.
const noticedAnswers = {}

// A send from an editor or an unsent response replaces an open question's
// answer. It goes ahead only while that answer is one the surface has shown:
// drawn with it, or named in its notice. Anything newer is shown first (#321).
// A closed question replaces nothing: its refusal says so.
function replacesUnseen(id, known, shown, surface, response) {
  const current = draftAnswerOf(known)
  return (freshItem(id)?.status ?? 'open') === 'open' && isAnswer(current) && !itemHolds(known, response)
    && !sameAnswer(current, shown) && !sameAnswer(current, noticedAnswers[surface])
}

// What an unsent response's Retry would replace, as this window knows it: an
// open question's answer that this text would be sent over afresh. A replay
// was written against that answer, and a delivered one replaces nothing.
function retryWouldReplace(draft) {
  const item = freshItem(draft.itemId)
  const known = knownAnswer(draft.itemId)
  if ((item && item.status !== 'open') || !isAnswer(draftAnswerOf(known)) || itemHolds(known, draft)) return null
  if (draft.intent && savedIntentRule(draft.itemId, draft.intent, draft) !== 'fresh') return null
  return known
}

// The answer a send expects to replace, in the route's field names (#321).
function expectedAnswerOf(answer) {
  return {
    replied_at: answer.replied_at ?? null,
    reply_source: answer.reply_source ?? null,
    reply_kind: answer.reply_kind ?? null,
    reply: answer.reply ?? null,
  }
}

// Names the newer reply beside the control the human pressed, in place, so
// neither the text nor the focus moves; the surface has now shown it.
function showNewerReply(id, surface, answer, recoveryKey) {
  noticedAnswers[surface] = draftAnswerOf(answer)
  if (!recoveryKey) {
    showWriteError(id, newerReplyNotice(id, answer, 'Send'))
    return
  }
  for (const el of document.querySelectorAll(`.replace-notice[data-notice-for="${CSS.escape(recoveryKey)}"]`)) {
    el.textContent = newerReplyNotice(id, answer, 'Retry')
    el.hidden = false
  }
}

// Issue #322: the rule can only read the last poll, so within one poll of
// another writer it replays a send the server already applied. The server
// answers that from its record without writing, and says so (`replayed`, not
// `wrote`) with the answer that stands, in the item's own field names. When
// that answer is not this response, a newer one replaced it after it landed.
// A server from before #322 says only `ok`, which keeps the old reading.
function replacedSinceItLanded(res, response) {
  return res.replayed === true && res.wrote === false && Boolean(res.answer)
    && !itemHolds(res.answer, response)
}

// Two windows that restored the same draft may each have kept it; one copy is enough.
function recoveryHolds(itemId, { text, context = '', kind = 'answer' }) {
  return Object.values(staleItemDrafts).some((draft) => draft.itemId === itemId && draft.kind === kind
    && draft.text.trim() === text.trim() && (draft.context ?? '').trim() === context.trim())
}

function rowHolds(rowId, { text, kind }) {
  // an archived plan's rows hold their notes only when it is read whole (#299)
  const row = [...(lastData?.boards ?? []), ...wholeArchived()]
    .flatMap((board) => board.rows).find((candidate) => candidate.id === rowId)
  return Boolean(row && (row.annotation ?? '') === text.trim() && (row.annotation_kind ?? 'answer') === kind)
}

// Back to its editor while its target is unchanged and its project open; to the
// unsent responses, with the reason, otherwise; nowhere once the server holds
// exactly that text. A reply intent comes back as it was stored: Send and
// Retry reuse it only as savedIntentRule allows. Returns where an editor
// draft went back to.
function placeRestoredDraft(key, draft) {
  switch (draft.type) {
    case 'reply': {
      const id = draft.itemId
      const item = freshItem(id)
      if (itemHolds(item, draft)) return null
      const unchanged = Boolean(item) && cardSections(item).showAnswer && sameAnswer(draft.answer, draftAnswerOf(item))
      const projectClosed = Boolean(item) && closedSet().has(item.project)
      // an app launch's approval has no editor to put it back in (#412 step 3)
      const launchAsk = isLaunchAskItem(item)
      const inPlace = unchanged && !projectClosed && !launchAsk
        && draftReplies[id] === undefined && draftReplyContexts[id] === undefined
      if (!inPlace && recoveryHolds(id, draft)) return null
      const generation = bumpDraftGeneration(itemDraftGenerations, id)
      const intent = draft.intent
      // the restored intent is this window's latest for the question, so a
      // refused retry keeps its text rather than counting as superseded
      if (intent) itemLatestIntents[id] = { ...intent }
      if (inPlace) {
        draftReplies[id] = draft.text
        draftReplyContexts[id] = draft.context
        itemDraftMeta[id] = { title: draft.title, answer: draft.answer }
        if (intent) itemDraftRetryIntents[id] = { generation, intent: { ...intent } }
        return { id, queue: true }
      }
      const cause = item?.status !== 'open' ? 'questionClosed' : unchanged && projectClosed ? 'projectClosed'
        : unchanged && launchAsk ? 'launchAsk' : 'questionChanged'
      preserveItemDraftRecovery(id, {
        title: draft.title,
        text: draft.text,
        context: draft.context,
        kind: 'answer',
        intent,
        generation,
        reason: draftReason(cause, Boolean(intent)),
      })
      return null
    }
    case 'item-recovery': {
      const item = freshItem(draft.itemId)
      if (itemHolds(item, draft) || recoveryHolds(draft.itemId, draft)) return null
      const intent = draft.intent
      if (intent) itemLatestIntents[draft.itemId] = { ...intent }
      const cause = item?.status === 'open' ? 'questionChanged' : 'questionClosed'
      staleItemDrafts[key] = {
        itemId: draft.itemId,
        title: draft.title,
        text: draft.text,
        context: draft.context,
        kind: draft.kind,
        intent: intent ? { ...intent } : null,
        owner: itemDraftRecoveryOwner(intent, itemDraftGenerations[draft.itemId] ?? 0),
        // its Retry will send afresh: say that the earlier send may have landed
        reason: intent && savedIntentRule(draft.itemId, intent, draft) === 'fresh'
          ? draftReason(cause, true)
          : draft.reason,
      }
      return null
    }
    case 'row': {
      const id = draft.rowId
      if (rowHolds(id, draft)) return null
      const owner = currentRow(id)
      const projectClosed = Boolean(owner) && closedSet().has(owner.board.project)
      const meta = {
        revision: draft.revision,
        actionVersion: draft.actionVersion ?? undefined,
        ask: draft.ask ?? undefined,
        response: draft.response ?? undefined,
        blocked: draft.blocked ?? undefined,
        notice: draft.notice ?? undefined,
        boardTitle: draft.boardTitle,
        label: draft.label,
        context: draft.context,
        boardId: draft.boardId,
        boardRevision: draft.boardRevision,
      }
      // #636: what became of its ask; the same ask, its words edited or not,
      // takes the draft back at the current revision (followRowAsk)
      const fate = projectClosed || rowDrafts[id] !== undefined ? rowAskFate(owner, meta) : followRowAsk(id, owner, meta)
      if (!projectClosed && rowDrafts[id] === undefined && sameRowAsk(fate)) {
        rowDrafts[id] = draft.text
        rowDraftKinds[id] = draft.kind
        rowDraftMeta[id] = meta
        if (draft.unconfirmed) unconfirmedRowSends.set(id, draft.text)
        bumpDraftGeneration(rowDraftGenerations, id)
        // a row the queue does not show keeps its text in its Plans panel,
        // opened as a deep link opens it
        if (owner.row.status !== 'blocked') {
          openRows.add(id)
          if (owner.row.status === 'done') showDoneBoards.add(owner.board.id)
          planOpen.set(owner.board.id, true)
        }
        return { id, queue: owner.row.status === 'blocked' }
      }
      staleRowDrafts[rowDraftRecoveryKey(id, draft.revision)] = {
        rowId: id,
        revision: draft.revision,
        actionVersion: draft.actionVersion ?? undefined,
        text: draft.text,
        kind: draft.kind,
        boardTitle: draft.boardTitle,
        label: draft.label,
        context: draft.context,
        setAside: draft.setAside,
        reason: rowRecoveryReason(projectClosed ? 'projectClosed' : fate, draft.unconfirmed, meta),
      }
      return null
    }
    case 'row-recovery':
      if (rowHolds(draft.rowId, draft)) return null
      staleRowDrafts[draft.choice ? rowChoiceRecoveryKey(draft.rowId, draft.revision) : rowDraftRecoveryKey(draft.rowId, draft.revision)] = {
        rowId: draft.rowId,
        revision: draft.revision,
        actionVersion: draft.actionVersion ?? undefined,
        choice: draft.choice || undefined,
        text: draft.text,
        kind: draft.kind,
        boardTitle: draft.boardTitle,
        label: draft.label,
        context: draft.context,
        setAside: draft.setAside,
        reason: draft.reason,
      }
      return null
    case 'message': {
      // #411: a send the snapshot holds went through; a listed session that
      // can receive gets its text back in its composer, nothing opened or
      // focused; anything else waits in the unsent responses
      const session = draft.session
      const restored = {
        project: draft.project, agent: draft.agent, stream: draft.stream, text: draft.text,
        intent: draft.intent ? { ...draft.intent } : null,
      }
      if (restored.intent?.text === restored.text && snapshotHolds(lastData.messages, restored.intent.id)) return null
      const delivery = deliveryState(activityRow(session))
      const recovery = { ...restored, reason: draft.reason || messageRecoveryReason(delivery, restored) }
      // A waiting one stays waiting here; reconcileMessageDrafts gives it back to
      // its composer once nothing else holds that, so a draft restored beside it
      // keeps the composer whichever entry is placed first.
      if (!draft.reason && delivery.canSend && !messageDrafts.has(session)) {
        messageDrafts.set(session, restored)
        if (restored.intent?.text === restored.text) messageNotes.set(session, MESSAGE_UNCONFIRMED)
      } else if (!messageRecoveries.has(session)) messageRecoveries.set(session, recovery)
      // one already waits in the unsent responses: this one stays a draft, stored
      // under its own key, as reconcileMessageDrafts keeps it
      else if (!messageDrafts.has(session)) messageDrafts.set(session, restored)
      else messageRecoveries.set(session, recovery)
      return null
    }
    case 'note': {
      const item = freshItem(draft.itemId)
      if (item && (item.annotation ?? '') === draft.text) return null
      itemNoteDrafts[draft.itemId] = {
        title: draft.title,
        text: draft.text,
        pending: false,
        // a save still in flight when the page went away was never confirmed
        error: draft.pending || !draft.error ? NOTE_UNCONFIRMED : draft.error,
      }
      return null
    }
    case 'note-edit': {
      // back in its editor; one the server already holds is done (reconcileDraftOwners
      // moves one whose item closed to the unsent responses)
      const item = freshItem(draft.itemId)
      if (item && (item.annotation ?? '') === draft.text) return null
      itemNoteEditors[draft.itemId] = { title: draft.title, text: draft.text }
      return null
    }
    default:
      return null
  }
}

// Issue #299: a restored row draft whose row no active plan holds may be an
// archived plan's, and only the complete archived list says whether the server
// already holds its text (rowHolds). While that list is paged out, and its last
// read has not failed, the draft waits for it.
function awaitsArchivedRow(draft) {
  return (draft.type === 'row' || draft.type === 'row-recovery')
    && omitsArchived() && !lastData.archivedError && !currentRow(draft.rowId)
}

// Once, with the first data and before the first render reads a draft. It
// sends nothing, focuses nothing and opens no tab; it reopens the card of the
// newest restored queue draft unless a card is already open, and the next
// queue render opens any fold holding a restored draft. A row draft that
// awaits the archived plans (#299) stays restored, still the profile's copy,
// and is placed the same way by the first tick that read them, or failed to.
function placeRestoredDrafts() {
  if (!restoredDrafts) return
  const restored = [...restoredDrafts].sort(([, left], [, right]) => left.savedAt - right.savedAt)
  const held = new Map(restored.filter(([, { draft }]) => awaitsArchivedRow(draft)))
  restoredDrafts = held.size ? held : null
  let reopenId = null
  for (const [key, { draft }] of restored) {
    if (held.has(key)) continue
    const placed = placeRestoredDraft(key, draft)
    if (!placed) continue
    revealDraftIds.add(placed.id)
    if (placed.queue) reopenId = placed.id
  }
  if (reopenId !== null && openRowId === null) {
    selectedId = reopenId
    setOpenRow(reopenId, { resume: false })
  }
  // where a draft went is drawn by the next frame, whatever else it reads (#298)
  if (held.size < restored.length) noteOutsideChange()
  // an early tick reads the complete list the held drafts wait on
  if (held.size) requestHistory()
}

function sendReply(...args) {
  // #412 step 3 (§4.3): in the app's own window, a launch's approval is
  // answered by main, which signs the choice; anywhere else the route refuses it.
  const it = freshItem(args[0])
  if (isLaunchAskItem(it) && launchUi?.granted()) return withPendingResponse(() => approveLaunchAsk(it, args[1], args[3]))
  return withPendingResponse(() => submitItemReply(...args))
}

async function approveLaunchAsk(it, label, kind = 'answer') {
  const error = kind && kind !== 'answer'
    ? 'Choose Allow once or Deny: only the app can answer this approval, and only with one of its options.'
    : await launchUi.approve(it, String(label ?? '').trim())
  showWriteError(it.id, error ?? '')
  if (error) {
    resumeRender()
    return
  }
  // answered: no text typed on this card waits any longer (a draft would keep the list paused)
  bumpDraftGeneration(itemDraftGenerations, it.id)
  delete draftReplies[it.id]
  delete draftReplyContexts[it.id]
  delete itemDraftMeta[it.id]
  delete itemDraftRetryIntents[it.id]
  await reloadAndPaint()
}

// savedIntentRule found exactly this response on the server: a send of it
// landed, so nothing is written and the draft or entry retires as delivered.
function retireDeliveredReply(id, { recoveryKey, savedIntent, text, context, kind }) {
  if (!recoveryKey) {
    bumpDraftGeneration(itemDraftGenerations, id)
    delete draftReplies[id]
    delete draftReplyContexts[id]
    delete itemDraftMeta[id]
    delete itemDraftRetryIntents[id]
  }
  retireItemDraftSubmissionIntent(id, savedIntent)
  // every unsent copy of this response was delivered, a Retry's own entry too
  deleteMatchingItemDraftRecoveries(id, { text, context, kind })
  showWriteError(id, '')
}

// Issue #322: a replay wrote nothing and a newer answer stands, so the text
// stays, as an unsent response saying so: in the entry its Retry came from, in
// the one its editor's draft moved to while the send was in flight, or out of
// the editor it was sent from. An editor typed in since keeps that newer text
// instead. The replayed intent is spent, so a Retry claims a fresh one.
// Returns whether an entry holds the text.
function keepReplacedReply(id, {
  title, text, context, kind, generation, intent, recoveryKey, recoveryOwner, submission, ownsDraft,
}) {
  const kept = { title, text, context, kind, intent: null, generation, reason: REPLY_REPLACED }
  let key = null
  if (recoveryKey) {
    key = preserveItemDraftRecovery(id, { ...kept, key: recoveryKey, expectedOwner: recoveryOwner })
  } else if (submission?.recoveryKey) {
    key = preserveItemDraftRecovery(id, { ...kept, key: submission.recoveryKey, expectedOwner: submission.recoveryOwner })
  } else if (ownsDraft) {
    key = preserveItemDraftRecovery(id, kept)
    bumpDraftGeneration(itemDraftGenerations, id)
    delete draftReplies[id]
    delete draftReplyContexts[id]
    delete itemDraftMeta[id]
    delete itemDraftRetryIntents[id]
  }
  retireItemDraftSubmission(id, generation, intent)
  if (recoveryKey) retireItemDraftSubmissionIntent(id, intent)
  return key !== null
}

async function submitItemReply(
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
  shown = null,
) {
  const reply = text.trim()
  if (!reply) return
  const hadDraft = draftReplies[id] !== undefined || draftReplyContexts[id] !== undefined
  // A Retry of an entry already taken by an earlier click does nothing.
  if (recoveryKey && !sameItemDraftRecoveryOwner(staleItemDrafts[recoveryKey]?.owner, recoveryOwner)) {
    forceRender()
    return
  }
  if (recoveryKey) delete itemDraftRetryIntents[id]
  // A Retry reuses its entry's intent, and an editor's Send the one its last
  // unconfirmed send left; savedIntentRule decides whether either is reused.
  const savedIntent = recoveryKey
    ? intent
    : !intent && submissionUsesDraft ? reusableDraftIntent(id, submittedGeneration) : null
  const fate = savedIntent ? savedIntentRule(id, savedIntent, { text, context, kind }) : null
  if (fate === 'delivered') {
    retireDeliveredReply(id, { recoveryKey, savedIntent, text, context, kind })
    await reloadAndPaint()
    return
  }
  // #321: an answer editor's Send and an unsent response's Retry (`shown`: the
  // answer the surface was drawn with) replace the question's answer. One the
  // surface has not shown is named beside the control instead, and only a
  // further click sends; the send then expects that answer, so the server
  // refuses it if a newer one landed since.
  const surface = shown ? (recoveryKey ? `recovery:${recoveryKey}` : `item:${id}`) : null
  const known = surface ? knownAnswer(id) : null
  if (surface && replacesUnseen(id, known, shown, surface, { text, context, kind })) {
    showNewerReply(id, surface, known, recoveryKey)
    return
  }
  if (savedIntent) intent = fate === 'replay' ? savedIntent : null
  const replayingRecordedIntent = Boolean(recoveryKey && intent)
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
  noteSentReply(id, { text, context, kind })
  const res = await postItemReply(id, {
    text: reply,
    context: context.trim() || undefined,
    kind,
    expect_answer: known ? expectedAnswerOf(known) : undefined,
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
  // #412 step 3: the reply route refuses an app launch's approval, which only
  // the app's own window can answer. Nothing was written; any typed text stays
  // where it is, and the card says where to answer instead.
  if (res.ok === false && res.reason === 'launch_ask') {
    retireItemDraftSubmission(id, submittedGeneration, intent)
    showWriteError(id, LAUNCH_ASK_REFUSED)
    resumeRender()
    return
  }
  // #321: refused only because the answer that stands is exactly this response
  // (a double click's first send, or another send of the same text): it went
  // through, so it retires below as a success would, with no notice.
  const deliveredMeanwhile = res.ok === false && res.reason === 'answer_changed'
    && itemHolds(res.answer, { text, context, kind })
  // #321: a newer answer landed after this surface showed the one it expected,
  // so nothing was written. The text stays where it is with that reply named,
  // and only another click sends; the refused intent is spent.
  if (surface && latestIntent && res.ok === false && res.reason === 'answer_changed' && res.answer
    && !deliveredMeanwhile) {
    retireItemDraftSubmission(id, submittedGeneration, intent)
    const keptKey = recoveryKey ?? trackedSubmission?.recoveryKey ?? null
    if (!keptKey) {
      showNewerReply(id, surface, res.answer, null)
      resumeRender()
      return
    }
    preserveItemDraftRecovery(id, {
      key: keptKey,
      expectedOwner: recoveryKey ? submittedRecoveryOwner : trackedSubmission.recoveryOwner,
      title: recoveryTitle,
      text,
      context,
      kind,
      intent: null,
      generation: submittedGeneration,
    })
    if (recoveryKey) retireItemDraftSubmissionIntent(id, intent)
    requestDraftRecovery()
    showWriteError(id, '')
    await reloadAndPaint()
    return
  }
  if ((res.ok || deliveredMeanwhile) && surface) delete noticedAnswers[surface]
  if (!res.ok && !deliveredMeanwhile) {
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
  if (replacedSinceItLanded(res, { text, context, kind })) {
    const kept = keepReplacedReply(id, {
      title: recoveryTitle,
      text,
      context,
      kind,
      generation: submittedGeneration,
      intent,
      recoveryKey,
      recoveryOwner: submittedRecoveryOwner,
      submission: trackedSubmission,
      ownsDraft: hadDraft && submissionUsesDraft && ownsSubmission,
    })
    if (kept) requestDraftRecovery()
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

// One option's pill. The compact surface (the session panel's asks, #454)
// marks the recommendation with ★ and keeps the word for assistive technology.
function optionPillHtml(option, surface = null) {
  if (!option.recommended) return esc(option.label)
  return surface
    ? `<span class="rec-star" aria-hidden="true">★</span>${esc(option.label)}<span class="rec-tag visually-hidden">recommended</span>`
    : `${esc(option.label)}<span class="rec-tag">recommended</span>`
}

// the answer surface on an unanswered question: option pills (recommended
// first), a Compare toggle for the tradeoffs, and a free-text answer
// `surface: 'compact'`: the session panel's ask (#454); see rowAnswerEl.
function answerEl(it, { surface = null } = {}) {
  const wrap = document.createElement('div')
  wrap.className = `options${comparing(openCompares, it.id, surface) ? ' comparing' : ''}`
  setHintOwner(wrap, it)
  let editorGeneration = itemDraftGenerations[it.id] ?? 0
  const opts = optionOrder(it.options)
  for (const o of opts) {
    const box = document.createElement('div')
    box.className = 'option'
    const pill = document.createElement('button')
    pill.className = `opt-pill${o.recommended ? ' rec' : ''}`
    pill.innerHTML = optionPillHtml(o, surface)
    pill.addEventListener('click', () => sendReply(
      it.id, o.label, effectiveReplyContext(it), 'answer', editorGeneration,
    ))
    box.appendChild(pill)
    if (o.detail) {
      const d = document.createElement('div')
      d.className = 'opt-detail'
      d.innerHTML = renderStructuredText(o.detail, textContext(it))
      box.appendChild(d)
    }
    wrap.appendChild(box)
  }
  // #412 step 3: an app launch's approval is answered only with one of its own
  // options, which main signs; it has no answer or context box to type into
  const launchAsk = isLaunchAskItem(it)
  const row = document.createElement('div')
  row.className = 'reply-row'
  if (opts.some((o) => o.detail)) {
    const cmp = btn(comparing(openCompares, it.id, surface) ? 'Hide option details' : 'Compare options', () => {
      toggleCompare(openCompares, it.id, surface)
      forceRender()
    })
    cmp.className = 'compare-toggle'
    row.appendChild(cmp)
  }
  if (launchAsk) {
    row.appendChild(writeErrorEl(it.id))
    wrap.appendChild(row)
    const entry = { kind: 'item', item: it }
    const keyPrefix = surface ? `${surface}:` : ''
    wrap.appendChild(dispositionEl(
      null,
      (until) => snoozeAsk(entry, until),
      `${keyPrefix}item:${it.id}`,
      surface || !pinOffered(it, 'item') ? null : () => pinAsk(entry),
      surface ? { label: 'More…' } : {},
    ))
    return wrap
  }
  const input = document.createElement('textarea')
  input.className = 'reply-input'
  input.rows = 1
  input.setAttribute('aria-keyshortcuts', 'Control+Enter Meta+Enter')
  input.dataset.draftFocusKey = `${it.id}:answer`
  input.placeholder = opts.length ? 'or answer in your own words…' : 'answer…'
  input.value = effectiveReply(it)
  // The draft is pinned to the answer it was written against; a restored draft
  // goes back only while that answer is unchanged (#279).
  const rememberDraftOwner = () => {
    if (input.value.trim() || ctxInput.value.trim()) {
      itemDraftMeta[it.id] = { title: it.title, answer: draftAnswerOf(it) }
    } else delete itemDraftMeta[it.id]
  }
  input.addEventListener('input', () => {
    invalidateItemDraftIntents(it.id)
    editorGeneration = bumpDraftGeneration(itemDraftGenerations, it.id)
    draftReplies[it.id] = input.value
    resizeReplyEditor(input)
    rememberDraftOwner()
    resumeRender()
  })
  // the answer this editor is drawn with: Send replaces only that unasked (#321)
  const submit = () => sendReply(
    it.id, input.value, ctxInput.value, 'answer', editorGeneration, null, true, true, null, null, draftAnswerOf(it),
  )
  bindReplyEditor(input, submit)
  row.appendChild(input)
  row.appendChild(btn('Send', submit, 'submit'))
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
  // UX pass, slice 1: the context editor is out of sight (style.css) until the human
  // works in this answer area or it holds text, and then stays while the ask is open.
  // It comes in after a click or on keyboard focus, never on a press and never on
  // focus alone: a row that enters or leaves the layout between a press and its
  // release moves the control under the pointer, and the click is lost.
  const showContextEditor = () => {
    contextEditorFor = it.id
    ctxRow.classList.add('shown')
  }
  if (contextEditorFor === it.id) ctxRow.classList.add('shown')
  // on the way down, so a control that repaints (Compare options) draws it shown
  wrap.addEventListener('click', showContextEditor, true)
  wrap.addEventListener('focusin', () => { if (!pressHeld(pressedAt, Date.now())) showContextEditor() })
  // Change answer's prefill was not typed here: pin it to the question it is shown against.
  if (itemDraftMeta[it.id]?.answer === undefined
    && (draftReplies[it.id] !== undefined || draftReplyContexts[it.id] !== undefined)) rememberDraftOwner()
  const keyPrefix = surface ? `${surface}:` : ''
  const entry = { kind: 'item', item: it }
  const menu = dispositionEl(
    (kind, text) => sendReply(
      it.id, text, effectiveReplyContext(it), kind, editorGeneration,
    ),
    (until) => snoozeAsk(entry, until),
    `${keyPrefix}item:${it.id}`,
    surface || !pinOffered(it, 'item') ? null : () => pinAsk(entry),
    surface ? { label: 'More…' } : {},
  )
  wrap.appendChild(menu)
  const waitStop = waitStopEl(it, {
    // A chat-recorded answer reuses this surface as a correction form, but the
    // agent recorded it itself: nothing is waiting, so nothing can be stopped.
    answered: Boolean(it.reply || it.reply_kind),
    pickedUp: Boolean(it.reply_seen_at),
    key: `${keyPrefix}wait:item:${it.id}`,
    onStop: async (until) => {
      const url = `/api/items/${it.id}/stop-waiting`
      const refusal = ITEM_CHANGED_REFUSAL
      if (laterSection) {
        await deferWaitStop({ kind: 'item', item: it }, url, until, {}, { refusal })
        return
      }
      const res = await postJSON(url, { until })
      if (res === null) return
      showWriteError(it.id, res.ok ? '' : refusal)
      await reloadAndPaint()
    },
  })
  if (waitStop) (surface ? menu.querySelector('.disposition-actions') : wrap).appendChild(waitStop)
  return wrap
}

// UX pass, slice 4, step 0: Note opens an editor in place, on the press only. The
// native prompt() it used throws in the desktop app's own window, and dialogs are off
// in another Mac's Inbox, so it never worked there.
function itemNoteAction(it) {
  const pending = Boolean(itemNoteDrafts[it.id]?.pending)
  const action = btn(pending ? 'Saving note…' : 'Note', (event) => openItemNoteEditor(it, event.currentTarget))
  action.dataset.noteItem = it.id
  action.disabled = pending
  action.title = 'Add or edit feedback for agents; leave it blank to clear.'
  action.setAttribute('aria-expanded', String(Boolean(itemNoteEditors[it.id])))
  return action
}

// `from`: the control pressed, whose container is where the rebuilt editor takes focus.
function openItemNoteEditor(it, from = null) {
  if (itemNoteDrafts[it.id]?.pending) return
  if (!itemNoteEditors[it.id]) {
    const current = freshItem(it.id) ?? it
    // a kept, unsent attempt comes back for review before anything is sent again
    itemNoteEditors[it.id] = { title: current.title, text: itemNoteDrafts[it.id]?.text ?? current.annotation ?? '' }
  }
  const scopeId = from?.closest?.('[id]')?.id ?? null
  forceRender()
  focusItemNoteEditor(it.id, scopeId)
}

function focusItemNoteEditor(id, scopeId = null) {
  const key = CSS.escape(`note:${id}`)
  const scopes = [scopeId && document.getElementById(scopeId), document.querySelector('main > .panel:not([hidden])'), document]
  for (const scope of scopes) {
    const input = scope?.querySelector?.(`[data-draft-focus-key="${key}"]`)
    if (!input) continue
    input.focus({ preventScroll: true })
    input.setSelectionRange(input.value.length, input.value.length)
    if (document.activeElement === input) return true
  }
  return false
}

// Retry on a kept Note attempt: the item's own editor holds the text for review, and
// nothing is sent until Save.
function reviewItemNoteRecovery(id, title) {
  openItemNoteEditor({ id, title })
  focusItem(id)
  requestAnimationFrame(() => focusItemNoteEditor(id))
}

function itemNoteEditorEl(it) {
  const editor = itemNoteEditors[it.id]
  const wrap = document.createElement('div')
  wrap.className = 'note-editor'
  const input = document.createElement('textarea')
  input.className = 'reply-input note-editor-input'
  input.rows = 2
  input.value = editor.text
  input.dataset.draftFocusKey = `note:${it.id}`
  input.setAttribute('aria-label', 'Your note for agents; leave it blank to clear')
  input.setAttribute('aria-keyshortcuts', 'Control+Enter Meta+Enter')
  input.placeholder = 'your note for agents…'
  input.addEventListener('input', () => {
    if (itemNoteEditors[it.id]) itemNoteEditors[it.id].text = input.value
    resizeReplyEditor(input)
    resumeRender()
  })
  const actions = document.createElement('div')
  actions.className = 'note-editor-actions'
  const save = () => saveItemNote(it)
  bindReplyEditor(input, save)
  actions.appendChild(btn('Save', save))
  actions.appendChild(btn('Cancel', (event) => {
    // the surface the press was made in (Home, Find, the Review queue), found again after the rebuild
    const scopeId = event.currentTarget?.closest?.('[id]')?.id ?? null
    keepFindRowOpen(it.id)
    delete itemNoteEditors[it.id]
    forceRender()
    const sel = `[data-note-item="${CSS.escape(it.id)}"]`
    const scopes = [scopeId && document.getElementById(scopeId), document.querySelector('main > .panel:not([hidden])')]
    for (const scope of scopes) {
      const note = scope?.querySelector?.(sel)
      if (!note) continue
      note.focus({ preventScroll: true })
      if (document.activeElement === note) break
    }
  }))
  wrap.append(input, actions)
  return wrap
}

function saveItemNote(it) {
  if (itemNoteDrafts[it.id]?.pending) return
  const editor = itemNoteEditors[it.id]
  if (!editor) return
  keepFindRowOpen(it.id)
  delete itemNoteEditors[it.id]
  return withPendingResponse(async () => {
    const prior = itemNoteDrafts[it.id]
    const current = freshItem(it.id) ?? it
    const text = editor.text
    const draft = { title: current.title ?? editor.title, text, pending: true, error: prior?.error ?? '' }
    itemNoteDrafts[it.id] = draft
    forceRender()
    const result = await postJSON(`/api/items/${it.id}/annotate`, { text })
    if (itemNoteDrafts[it.id] !== draft) return
    if (result?.ok === true) {
      delete itemNoteDrafts[it.id]
    } else {
      draft.pending = false
      draft.error = result?.ok === false ? (result.reason === 'launch_ask' ? LAUNCH_ASK_REFUSED : NOTE_REFUSED) : NOTE_UNCONFIRMED
      requestDraftRecovery(null)
    }
    await reloadAndPaint()
  })
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
  setHintOwner(el, it)
  const s = cardSections(it, { done })
  const presentation = actionPresentation(it, { done })
  el.innerHTML = `
    ${header ? cardHeadingHtml(presentation, textContext(it)) : ''}
    ${cardOriginHtml(it, it, { showProject: header })}
    ${s.handoff && it.title && it.title !== presentation.headline ? '<div class="card-finished"></div>' : ''}
    ${actionBlocksHtml(presentation, textContext(it))}
    ${cardLinksHtml(it, it)}
    ${itemAnnotationHtml(s.annotationReceipt)}
    ${s.recWarning ? `<div class="rec-warning">Review: ${esc(s.recWarning)}</div>` : ''}
    ${s.reply || it.reply_kind ? `<div class="reply-block"><strong>${esc(responseLabel(it) || 'You answered')}:</strong> ${esc(s.reply ?? '')}${it.reply_context ? `<div class="reply-context">Context: ${esc(it.reply_context)}</div>` : ''}${it.reply_source === 'agent' ? '<span class="reply-source">via chat</span>' : ''}${s.showPickup ? `<span class="pickup ${it.reply_seen_at ? 'picked' : 'awaiting'}"${it.reply_seen_at ? ' title="Delivery does not confirm the asking agent has resumed."' : ''}>${it.reply_seen_at ? 'Delivered to an agent' : 'Saved · waiting for delivery'}</span>` : ''}</div>` : ''}
    ${outcomeHtml(s.outcome, it.outcome_at, textContext(it))}
    ${cardDetailsHtml(it, it, `item:${it.id}`, presentation, { includeAsked })}`
  // issue #612: a hand-off's title names the finished work; agent text, so textContent only
  const finished = el.querySelector(':scope > .card-finished')
  if (finished) finished.textContent = it.title
  bindContextDisclosures(el)
  if (s.showAnswer) el.appendChild(answerEl(it))
  else if (s.answered) {
    const reminder = waitStopEl(it, { answered: true, pickedUp: Boolean(it.reply_seen_at) })
    if (reminder) el.appendChild(reminder)
  }
  if (s.showActions && s.handoff) {
    // issue #612: nothing to answer. Acknowledge ends it; Snooze and Pin set it aside.
    const actions = document.createElement('div')
    actions.className = 'actions'
    actions.appendChild(btn('Acknowledge', () => act(it.id, 'acknowledge')))
    const entry = { kind: 'item', item: it }
    actions.appendChild(dispositionEl(
      null,
      (until) => snoozeAsk(entry, until),
      `item:${it.id}`,
      pinOffered(it, 'item') ? () => pinAsk(entry) : null,
      { label: 'Snooze or pin' },
    ))
    el.appendChild(actions)
  } else if (s.showActions) {
    const actions = document.createElement('div')
    actions.className = 'actions'
    if (!isLaunchAskItem(it)) {
      actions.appendChild(btn('Resolve', () => act(it.id, 'resolve'), 'resolve'))
      actions.appendChild(btn('Dismiss', () => act(it.id, 'dismiss')))
    }
    if (s.answered && !s.showAnswer) {
      // fix round 1 (hardening): a small inline slot beside the button for the
      // refusal message changeAnswer() surfaces when the server refuses (spec req #2)
      const msg = document.createElement('span')
      msg.className = 'refusal-msg'
      actions.appendChild(btn('Change answer', () => changeAnswer(it, msg)))
      actions.appendChild(msg)
    }
    actions.appendChild(itemNoteAction(it))
    el.appendChild(actions)
    if (itemNoteEditors[it.id]) el.appendChild(itemNoteEditorEl(it))
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
  // a notice naming the answer just cleared no longer says what Send does (#321)
  delete noticedAnswers[`item:${it.id}`]
  showWriteError(it.id, '')
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
  // Home shows the list and the lanes together (UX pass, slice 2): while focus is in the
  // lanes or the session panel, a key never reaches across to the list's selected ask.
  if (lanesHoldFocus()) return null
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
      // the lanes own their keys: J, K and Enter from there never move or open the list's ask
      if (!ids.length || lanesHoldFocus()) return
      const at = ids.indexOf(selectedId)
      const from = at < 0 ? (intent.delta > 0 ? -1 : ids.length) : at
      selectRow(ids[Math.max(0, Math.min(ids.length - 1, from + intent.delta))])
      return
    }
    case 'expand': {
      // A real row click shares pointer activation and focus-into-card behavior.
      if (!selectedId || lanesHoldFocus()) return
      rowEls().find((el) => el.dataset.cardId === selectedId)?.click()
      return
    }
    case 'collapse': {
      if (!openRowId) return
      collapseRow(openRowId, { explicit: true })
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
      if (it && !isLaunchAskItem(it)) act(it.id, 'resolve') // deck-aware target — never a bare selectedId
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
  // on Find the top bar's search is not drawn: ⌘K and / focus Find's own field
  if (activeTab === 'find' && !settingsOpen()) {
    focusFindField({ select: selectText })
    return
  }
  const search = document.getElementById('search')
  search.focus()
  if (selectText) search.select()
}

function keyboardScope() {
  const dialogs = [...document.querySelectorAll('[aria-modal="true"]')]
    .filter((dialog) => !dialog.closest('[hidden], [inert]'))
  const dialog = dialogs.at(-1)
  if (dialog) return dialog
  if (layout === 'narrow' && openRowId) {
    const card = needsYouRowEl(openRowId)?.querySelector('.nrow-card')
    if (card && !card.closest('[hidden]') && getComputedStyle(card).position === 'fixed') return card
  }
  return document
}

function keyboardActionScope() {
  const scope = keyboardScope()
  if (scope !== document) return scope
  const focused = document.activeElement?.closest?.(
    '#needsYouList .nrow[data-card-id], .row-panel-row, .board-row, details.item, #find .find-row, #dashFocus [data-panel-ask]',
  )
  if (focused && !focused.closest('[hidden]')) return focused
  // in the lanes the scope is the focused panel ask above or nothing: never the list's row
  if (lanesHoldFocus()) return null
  const rows = rowEls()
  return rows.find((element) => element.dataset.cardId === selectedId)
    ?? rows.find((element) => element.dataset.cardId === openRowId)
    ?? null
}

function focusKeyboardPanel(id) {
  if (window.scrollY !== 0) window.scrollTo(0, 0)
  // G I: Home's list of asks, its first operable row focused
  const firstRow = id === 'needsYou' ? rowEls()[0] : null
  if (firstRow) { firstRow.focus(); return }
  const panel = document.getElementById(id)
  panel.tabIndex = -1
  panel.focus({ preventScroll: true })
}

function navigateKeyboard(destination) {
  if (destination === 'setup') {
    showPanel('setup')
    focusKeyboardPanel('setup')
  } else if (destination === 'agents') {
    document.getElementById('agentSelect').focus()
  } else if (destination === 'projects') {
    if (layout === 'narrow') setProjectDisclosure(true)
    focusProjectFallback(projectFilter)
  } else if (destination === 'sessions') {
    showAgentsHome()
  } else if (destination === 'needsYou') {
    // G I: the asks on Home, no longer a tab of their own
    selectTab('dashboard')
    if (activeTab === 'dashboard') focusKeyboardPanel('needsYou')
  } else if (destination === 'find') {
    openFind({ focus: 'field' })
  } else if (destination === 'findNotes') {
    openFind({ chip: 'notes', clearQuery: true, focus: 'list' })
  } else if (destination === 'findAll') {
    openFind({ chip: 'all', clearQuery: true, focus: 'list' })
  } else if (destination === 'findChats') {
    // G C (step B): Find: Chats, the field focused as Find's own way in does
    openFind({ chip: 'chats', clearQuery: true, focus: 'field' })
  } else if (TAB_IDS.includes(destination)) {
    selectTab(destination)
    // selectTab refuses the Agent cards while the mesh is off (G M); focus stays where it was
    if (activeTab === destination) focusKeyboardPanel(destination)
  }
}

function initKeys() {
  keyboardUI = createKeyboardUI({
    getScope: keyboardScope,
    getActionScope: keyboardActionScope,
    navigate: navigateKeyboard,
  })
  document.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return
    // a held Settings shortcut acts once: each repeat is cancelled, wherever it is aimed, or the
    // app menu's Settings… would act on it and close what the first press opened
    if (e.repeat && e.key === ',' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
      e.preventDefault()
      return
    }
    if (e.repeat && !['j', 'k', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return
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
      if (keyboardScope() !== document) return
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
    const activeScope = keyboardScope()
    if (!triageDeck && activeScope !== document && e.key !== 'Escape') {
      const currentCardAction = activeScope.matches('.nrow-card')
        && activeScope.contains(e.target) && ['e', 'x'].includes(e.key)
      if (!currentCardAction) return
    }
    // The row's own keydown listener (needsRowEl) already handles Enter/Escape
    // when the row itself has focus and calls preventDefault() — don't run the
    // action twice.
    if (e.defaultPrevented) return
    // Esc precedence, explicit (topmost/innermost first): the triage deck (an
    // actual lightbox) wins via keyAction's own ladder below (deckOpen is
    // checked first, ahead of 'expanded'/clearSelection). The session panel is
    // its own Esc consumer (its keydown stops propagation).
    if (e.key === 'Escape' && !triageDeck && closeSettings({ restoreFocus: true, back: true })) {
      e.preventDefault()
      e.stopImmediatePropagation()
      return
    }
    // Agent cards step 1 (D3): Escape on an agent's page goes back to the grid, unless focus is in a field
    if (e.key === 'Escape' && !typing && !triageDeck && activeTab === 'cards' && (meshSetup.open() || meshAgentPage.current()) && activeScope === document) {
      e.preventDefault()
      // a set-up page goes back where it came from (step 2b, D3)
      if (!(meshSetup.open() && meshSetup.back())) closeMeshAgent()
      return
    }
    // optionCount must come from the SAME target runIntent will answer — the
    // deck entry while it's open, the list selection otherwise — or a keyboard
    // '1'-'4' can validate against one item and answer another (see
    // keyTargetItem).
    const intent = keyAction(e.key, {
      typing,
      deckOpen: !!triageDeck,
      // from the lanes or the session panel, Esc never closes the list's ask in front (keyTargetItem)
      expanded: openRowId != null && !lanesHoldFocus(),
      peeking: !!projectFilter && closedSet().has(projectFilter),
      optionCount: optionOrder(keyTargetItem()?.options).length,
    })
    if (!intent) return
    // only Home has rows to move through and an ask to close: elsewhere the arrows scroll the page
    // and Escape is left alone
    if ((intent.type === 'move' || intent.type === 'collapse') && activeTab !== 'dashboard') return
    // UX pass, slice 4: printable shortcuts that act elsewhere (Home's, the Review queue's) do
    // nothing on Find, and Escape inside Find leaves the peek and the selection alone
    if (activeTab === 'find' && !triageDeck && keyboardScope() === document && intent.type !== 'search' && intent.type !== 'blur') {
      if (!['exitPeek', 'clearSelection'].includes(intent.type) || document.activeElement?.closest?.('#find')) return
    }
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
    // The Agent cards tab (Agent cards step 1) is `hidden` while the mesh is off: skipped the same way.
    const tabs = [...host.querySelectorAll('[role="tab"]')].filter((t) => !t.hidden && !t.closest('details:not([open])'))
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

function setHintOwner(element, entity, board = null) {
  element.dataset.keyHintOwner = `${board ? 'row' : 'item'}:${entity.id}`
  element.dataset.keyHintVersion = board ? `${board.revision}:${entity.revision}` : entity.updated_at
}

function btn(label, onClick, shortcut = null) {
  const b = document.createElement('button')
  b.textContent = label
  if (shortcut) b.dataset.shortcutId = shortcut
  b.addEventListener('click', onClick)
  return b
}

// the pager at the foot of a capped section — reveals PAGE[section] more cards
function moreButton(section, remaining) {
  const n = Math.min(PAGE[section], remaining)
  const b = btn(`Show ${n} more (${remaining} hidden)`, () => {
    shown[section] += PAGE[section]
    forceRender()
    requestHistoryPaint()
  })
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
  if (res.ok === false && res.reason === 'launch_ask') {
    showWriteError(id, LAUNCH_ASK_REFUSED)
    return
  }
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
  let res = await queueProjectMutation(
    name,
    () => postJSON('/api/projects/close', { project: name }),
  )
  // a 200 `{ ok: false }` is the store refusing (#412: a reserved project):
  // nothing was archived, so it unwinds exactly like a failed write
  if (res !== null && res.ok === false) {
    document.getElementById('status').textContent = res.reason === 'reserved_project'
      ? `${name} can’t be archived: it holds sessions’ approvals`
      : `${name} was not archived`
    res = null
  }
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
    // a trailing space turns a command's name into the command (#307): only
    // that edit counts among trim-equivalent ones
    const queryChanged = searchQuery.trim() !== value.trim() || commandShape(searchQuery) !== commandShape(value)
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
    // Issue #184: overlap reading the closed history the page omits with the debounce.
    requestHistory()
  })
  input.addEventListener('focus', () => {
    const value = input.value.trim()
    if (!value || searchIndexOpen) return
    searchQuery = input.value
    searchIndexOpen = true
    renderSearchResults()
    requestHistory()
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

// ── Agents (#197 part 2) ────────────────────────────────────────────────────
// Which build each host's agents are registered to run, and ONE explicit
// action for the Setup-managed hosts whose runtime differs from this app's:
// "Update agents" when they are behind, "Match agents to vX" when one is ahead
// after an app downgrade (public/agents.js agentsAction). It runs the existing
// fixed-target install (claude, copilot or all, through the same Electron
// bridge as the menu below) for exactly those hosts, and since #206 the fixed
// `hooks` target for Claude's Setup-managed hooks: no new command, nothing at
// startup, and a checkout or custom registration is reported, never switched.
// The installers refuse to replace a registration they do not own, and this
// never asks them to force one. Paths come from host config files, so every
// string here is textContent.
let agentsBlock = null

function renderAgents(host, s, canInstall) {
  agentsBlock = null
  if (!s?.agents || typeof s.agents !== 'object') return
  const section = document.createElement('section')
  section.className = 'setup-block agents-status'
  const title = document.createElement('h3')
  title.textContent = 'Agents'
  const list = document.createElement('ul')
  list.className = 'agents-hosts'
  // #540: the command-line shim the agent installer writes, apart from the host list
  const cli = document.createElement('div')
  cli.className = 'agents-cli'
  const actions = document.createElement('div')
  actions.className = 'agents-actions'
  const result = document.createElement('pre')
  result.className = 'agents-result'
  result.hidden = true
  const restart = document.createElement('div')
  restart.className = 'agents-restart'
  restart.setAttribute('role', 'status')
  restart.hidden = true
  section.append(title, list, cli, actions, result, restart)
  host.appendChild(section)
  agentsBlock = { list, cli, actions, result, restart, canInstall, running: false }
  paintAgents(s.agents)
}

function agentsHint(text) {
  const p = document.createElement('p')
  p.className = 'setup-hint'
  p.textContent = text
  agentsBlock.actions.appendChild(p)
}

function paintAgents(agents) {
  const block = agentsBlock
  if (!block) return
  block.list.replaceChildren()
  block.actions.replaceChildren()
  const current = typeof agents.current === 'string' ? agents.current : null
  const lines = ['claude', 'copilot', 'hooks'].map((h) => hostLine(h, agents[h], current))
  for (const line of lines) {
    const item = document.createElement('li')
    item.dataset.host = line.host
    item.classList.toggle('outdated', line.drift === 'older')
    item.classList.toggle('newer', line.drift === 'newer')
    const name = document.createElement('strong')
    name.textContent = `${line.label}:`
    item.append(name, ` ${line.text}`)
    block.list.appendChild(item)
  }
  const action = agentsAction(agents)
  const canRun = block.canInstall && Boolean(window.agentInboxSetup?.install)
  if (action) {
    if (canRun) {
      agentsHint(action.hint)
      const run = btn(action.label, () => updateAgents(action, current, run))
      run.className = 'agents-update-btn'
      run.disabled = block.running
      block.actions.appendChild(run)
    } else {
      agentsHint(action.elsewhere)
    }
  }
  if (lines.some((line) => line.kind === 'checkout')) {
    agentsHint('Setup does not update a source checkout: run git pull and npm run build in it, then restart its sessions.')
  }
  // Claude's hooks on another Setup runtime (#206): the action moves them when
  // it can; otherwise say how, promising only what Setup can do here, and never
  // leave that line without a next step (#278).
  const hooks = hooksNextStep(agents, canRun)
  if (hooks) {
    agentsHint(hooks.text)
    if (hooks.command) agentsCommand(hooks.command)
  }
  paintCli(agents.cli)
}

// The shim's line and, while it works, the PATH line to copy: words the viewer
// built (src/agent-hosts.ts), shown as text.
function paintCli(shim) {
  const box = agentsBlock.cli
  box.replaceChildren()
  const text = (value) => (typeof value === 'string' && value !== '' ? value : null)
  if (!shim || typeof shim !== 'object' || !text(shim.name) || !text(shim.text)) return
  const line = document.createElement('p')
  line.className = 'setup-hint'
  const name = document.createElement('strong')
  name.textContent = `${shim.name}:`
  line.append(name, ` ${shim.text}`)
  box.appendChild(line)
  if (text(shim.hint)) {
    const p = document.createElement('p')
    p.className = 'setup-hint'
    p.textContent = shim.hint
    box.appendChild(p)
  }
  if (text(shim.command)) agentsCommand(shim.command, box, 'agents-cli-command')
}

// A command the viewer built and quoted, shown as text with a Copy button.
function agentsCommand(text, into = agentsBlock.actions, className = 'agents-hooks-command') {
  const command = document.createElement('pre')
  command.className = className
  command.textContent = text
  const copy = btn('Copy', async () => {
    try {
      await navigator.clipboard.writeText(text)
      copy.textContent = 'Copied ✓'
    } catch {
      copy.textContent = 'Copy failed'
    }
    setTimeout(() => { copy.textContent = 'Copy' }, 1500)
  })
  copy.className = 'copy-btn'
  into.append(command, copy)
}

// /api/setup as JSON, or null when it cannot be read.
function readSetup() {
  // #617 PR 3c: the hub's remote entry refuses /api/setup
  if (!hubMode.local()) return Promise.resolve(null)
  return fetch('/api/setup').then((r) => (r.ok ? r.json() : null)).catch(() => null)
}

// Re-read what each host is registered to run, after any install, and the
// runtimes beside it (#294). Resolves to the agents it painted, or null when
// the read failed.
function refreshAgents() {
  if (!agentsBlock && !runtimesBlock) return Promise.resolve(null)
  return readSetup().then((s) => {
    if (s?.runtimes && typeof s.runtimes === 'object') paintRuntimes(s.runtimes)
    if (!s?.agents || typeof s.agents !== 'object') return null // keep the status already shown
    paintAgents(s.agents)
    return s.agents
  })
}

// One fixed install target per host, one after another: a host whose CLI is
// gone fails on its own and never holds the other back, which `--target all`
// would (the installer stops before changing anything). But a step that was
// cancelled (Agent Inbox is quitting), timed out, or could not run at all ENDS
// the run: starting the next host then could have it killed halfway through
// replacing a registration (#205 review). Each host's outcome is reported as
// it is, including the hosts that never started.
async function updateAgents(action, current, button) {
  const block = agentsBlock
  if (!block || block.running) return
  block.running = true
  button.disabled = true
  block.restart.hidden = true
  block.restart.replaceChildren()
  const show = (text, state) => {
    block.result.textContent = text
    block.result.hidden = false
    block.result.classList.toggle('success', state === 'ok')
    block.result.classList.toggle('failure', state === 'failed')
  }
  const several = action.steps.length > 1
  const reports = []
  const moved = []
  try {
    for (const [index, step] of action.steps.entries()) {
      show([...reports, step.progress].join('\n\n'), 'running')
      // Claude's hooks (#206) move only if they still run another Setup
      // runtime once the agent steps are done: the human may have changed them
      // since this panel was drawn. This re-read is for the message; the
      // installer's --move-only refuses under the setup lock all the same.
      if (step.host === 'hooks') {
        const fresh = await refreshAgents()
        if (hooksGuidance(fresh, current).moved) {
          // already where the human asked for them, moved some other way meanwhile
          reports.push(`${hostLabel('hooks')}: already run v${current}, so there was nothing to move.`)
          moved.push('hooks')
          continue
        }
        if (!hostLine('hooks', fresh?.hooks, current).drift) {
          reports.push(fresh
            ? `${hostLabel('hooks')}: not started, because they changed since Setup read them; the list above shows them now.`
            : `${hostLabel('hooks')}: not started, because Setup could not re-read Claude's settings.`)
          continue
        }
      }
      let text
      let stopped = null
      try {
        const outcome = await window.agentInboxSetup.install(step.host)
        const ok = outcome?.ok === true
        if (ok) moved.push(step.host)
        else if (outcome?.cancelled === true) stopped = 'was cancelled'
        else if (outcome?.timedOut === true) stopped = 'timed out'
        text = outcome?.output || (ok ? step.done : 'Setup failed without output.')
      } catch (err) {
        stopped = 'could not run'
        text = `Setup failed: ${err instanceof Error ? err.message : String(err)}`
      }
      reports.push(several ? `${hostLabel(step.host)}: ${text}` : text)
      if (stopped) {
        for (const skipped of action.steps.slice(index + 1)) {
          reports.push(`${hostLabel(skipped.host)}: not started, because Setup stopped after ${hostLabel(step.host)} ${stopped}.`)
        }
        break
      }
    }
  } finally {
    block.running = false
  }
  const [fresh] = await Promise.all([refreshAgents(), refreshLiveVersion()])
  // Claude's hooks count as moved only once the re-read shows them on this
  // app's runtime (#206); the agents' installer results stand as reported.
  const hooks = moved.includes('hooks') ? hooksGuidance(fresh, current) : null
  const agentMoves = moved.filter((host) => host !== 'hooks')
  const confirmed = agentMoves.length + (hooks?.moved ? 1 : 0)
  show(reports.join('\n\n'), confirmed === action.steps.length ? 'ok' : 'failed')
  if (!agentMoves.length && !hooks) return
  // A running session keeps the MCP server it started with: say which ones
  // still run another build than their host now loads, and how to restart
  // them, rather than imply anything reloaded. A successful fixed install
  // registers exactly this app's verified runtime, so that is `current`.
  const items = restartGuidance(lastData?.activity ?? [], agentMoves.map((host) => ({ host, version: current })))
  if (hooks) items.push(hooks.text)
  const list = document.createElement('ul')
  for (const text of items) {
    const item = document.createElement('li')
    item.textContent = text
    list.appendChild(item)
  }
  if (agentMoves.length) {
    const lead = document.createElement('p')
    lead.className = 'setup-hint'
    lead.textContent = 'Running sessions keep the build they started with until you restart them.'
    block.restart.replaceChildren(lead, list)
  } else {
    block.restart.replaceChildren(list)
  }
  block.restart.hidden = false
}

// ── Runtimes (#294) ─────────────────────────────────────────────────────────
// Each runtime folder Setup installed, its size and what uses it, and ONE
// explicit action that removes the unused ones through the existing bridge's
// fixed `prune-runtimes` target. The renderer names the target and nothing
// else: the script checks again under the setup lock, and keeps anything still
// in use. Just before it runs, the panel re-reads the list and runs only if
// the button still names what it would remove. Nothing runs at startup. Folder
// names come from disk, so every string here is textContent.
let runtimesBlock = null

function renderRuntimes(host, s, canInstall) {
  runtimesBlock = null
  if (!s?.runtimes || typeof s.runtimes !== 'object') return
  const section = document.createElement('section')
  section.className = 'setup-block runtimes-status'
  const title = document.createElement('h3')
  title.textContent = 'Runtimes'
  const lead = document.createElement('p')
  lead.className = 'setup-hint'
  lead.textContent = RUNTIMES_LEAD
  const list = document.createElement('ul')
  list.className = 'runtimes-list'
  const actions = document.createElement('div')
  actions.className = 'runtimes-actions'
  const result = document.createElement('pre')
  result.className = 'runtimes-result'
  result.hidden = true
  section.append(title, lead, list, actions, result)
  host.appendChild(section)
  runtimesBlock = { section, list, actions, result, canInstall, running: false }
  paintRuntimes(s.runtimes)
}

function paintRuntimes(runtimes) {
  const block = runtimesBlock
  if (!block) return
  const lines = runtimeLines(runtimes, lastData?.activity ?? [])
  block.section.hidden = lines.length === 0
  block.list.replaceChildren(...lines.map((line) => {
    const item = document.createElement('li')
    item.dataset.status = line.status
    item.textContent = line.text
    return item
  }))
  block.actions.replaceChildren()
  const hint = (text) => {
    const p = document.createElement('p')
    p.className = 'setup-hint'
    p.textContent = text
    block.actions.appendChild(p)
  }
  const action = runtimesAction(runtimes)
  const canRun = block.canInstall && Boolean(window.agentInboxSetup?.install)
  if (action && canRun) {
    hint(action.hint)
    const run = btn(action.label, () => removeRuntimes(action, run))
    run.className = 'runtimes-remove-btn'
    run.disabled = block.running
    block.actions.appendChild(run)
  }
  const note = runtimesNote(runtimes, canRun)
  if (note) hint(note)
  if (action) hint(PROJECT_SCOPE_NOTE)
}

async function removeRuntimes(action, button) {
  const block = runtimesBlock
  if (!block || block.running) return
  block.running = true
  button.disabled = true
  const show = (text, state) => {
    block.result.textContent = text
    block.result.hidden = false
    block.result.classList.toggle('success', state === 'ok')
    block.result.classList.toggle('failure', state === 'failed')
  }
  try {
    // the button names what it removes: run only if that is still the list
    const fresh = await readSetup()
    const now = runtimesAction(fresh?.runtimes)
    const same = now !== null && now.ids.length === action.ids.length && now.ids.every((id) => action.ids.includes(id))
    if (!same) {
      show(fresh
        ? 'The runtimes changed since Setup listed them, so it removed nothing. Check the list and try again.'
        : 'Setup could not read the runtimes again, so it removed nothing.', 'failed')
      return
    }
    show(`${action.label.replace(/^Remove/, 'Removing').replace(/ \([^)]*\)$/, '')}…`, 'running')
    try {
      const outcome = await window.agentInboxSetup.install('prune-runtimes')
      show(outcome?.output || (outcome?.ok ? 'Done.' : 'Setup failed without output.'), outcome?.ok === true ? 'ok' : 'failed')
    } catch (err) {
      show(`Setup failed: ${err instanceof Error ? err.message : String(err)}`, 'failed')
    }
  } finally {
    block.running = false
    await refreshAgents()
  }
}

function setupTargetLabel(target) {
  return {
    all: 'Claude Code + Copilot CLI',
    claude: 'Claude Code',
    copilot: 'Copilot CLI',
  }[target]
}

function setupMenu(s, canInstall) {
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
        // #197: an install changes what Live's older-build hints may advise,
        // and what each host is registered to run
        refreshLiveVersion()
        refreshAgents()
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
  return wrap
}

// What the Setup panel was built with: the setup info, whether this window
// could run one-click Setup then, and its menu.
let setupShown = null

// A reloaded window gets one-click Setup back only once main has proven it again
// (#216), which can finish after this panel was built, so Settings asks again
// when it opens. A window loses Setup only to a new page or a quit, so this only
// ever adds the one-click install, never takes away a menu that may be running.
async function refreshSetupAvailability() {
  const shown = setupShown
  if (!shown || shown.canInstall || !window.agentInboxSetup?.available) return
  const canInstall = await window.agentInboxSetup.available().catch(() => false)
  if (canInstall !== true || shown !== setupShown || shown.canInstall) return
  shown.canInstall = true
  const menu = setupMenu(shown.info, true)
  shown.menu.replaceWith(menu)
  shown.menu = menu
  if (agentsBlock) agentsBlock.canInstall = true
  if (runtimesBlock) runtimesBlock.canInstall = true
  await refreshAgents()
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

function renderSortSettings(host) {
  const section = document.createElement('section')
  section.className = 'setup-block sort-settings'
  const title = document.createElement('h3')
  title.textContent = 'Default sort order'
  const hint = document.createElement('p')
  hint.className = 'setup-hint'
  hint.id = 'default-sort-hint'
  hint.textContent = 'Used each time Agent Inbox opens in this browser or app profile. The Sort menu above the queue changes only the current view.'
  const select = document.createElement('select')
  select.setAttribute('aria-label', 'Default sort order')
  select.setAttribute('aria-describedby', hint.id)
  appendSortOptions(select)
  select.value = savedAskSort()
  select.addEventListener('change', () => {
    try {
      localStorage.setItem(DEFAULT_SORT_KEY, select.value)
    } catch (err) {
      select.value = savedAskSort()
      console.error('Default sort order could not be saved', err)
      document.getElementById('status').textContent = 'default sort order not saved'
      return
    }
    askSort = select.value
    pinnedIds = []
    // The human's own choice: renderIfIdle() would hold it behind any open draft.
    forceRender()
  })
  section.append(title, hint, select)
  host.appendChild(section)
}

function renderMotionSettings(host) {
  const section = document.createElement('section')
  section.className = 'setup-block motion-settings'
  const title = document.createElement('h3')
  title.textContent = 'Motion'
  const hint = document.createElement('p')
  hint.className = 'setup-hint'
  hint.id = 'motion-hint'
  hint.textContent = 'Full shows live activity with gentle movement. Calm keeps everything still and only fades things in. Reduce motion in your system settings turns movement off either way.'
  const select = document.createElement('select')
  select.setAttribute('aria-label', 'Motion')
  select.setAttribute('aria-describedby', hint.id)
  for (const [value, label] of [['full', 'Full'], ['calm', 'Calm']]) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    select.appendChild(option)
  }
  select.value = motion.level
  select.addEventListener('change', () => {
    try {
      motion.setLevel(select.value)
    } catch (err) {
      select.value = motion.level
      console.error('Motion setting could not be saved', err)
      document.getElementById('status').textContent = 'motion setting not saved'
      return
    }
    // The human's own choice: renderIfIdle() would hold it behind any open draft.
    forceRender()
  })
  section.append(title, hint, select)
  host.appendChild(section)
}

function renderLaterSettings(host) {
  const section = document.createElement('section')
  section.className = 'setup-block later-settings'
  const title = document.createElement('h3')
  title.textContent = 'Inbox'
  const preference = document.createElement('label')
  preference.className = 'settings-toggle'
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.className = 'later-section-toggle'
  input.checked = laterSection
  input.setAttribute('aria-describedby', 'later-section-detail later-section-hint')
  input.addEventListener('change', () => {
    try {
      localStorage.setItem(LATER_SECTION_KEY, String(input.checked))
    } catch (err) {
      input.checked = laterSection
      console.error('Later section setting could not be saved', err)
      document.getElementById('status').textContent = 'later section setting not saved'
      return
    }
    laterSection = input.checked
    // The human's own choice: renderIfIdle() would hold it behind any open draft.
    forceRender()
  })
  const preferenceCopy = document.createElement('span')
  const label = document.createElement('strong')
  label.textContent = 'Later section'
  const detail = document.createElement('small')
  detail.id = 'later-section-detail'
  detail.textContent = 'Move pinned and snoozed asks to a Later section at the foot of the inbox. Used each time Agent Inbox opens in this browser or app profile.'
  preferenceCopy.append(label, detail)
  preference.append(input, preferenceCopy)
  const hint = document.createElement('p')
  hint.className = 'setup-hint later-section-hint'
  hint.id = 'later-section-hint'
  hint.hidden = true
  section.append(title, preference, hint)
  host.appendChild(section)
  paintLaterSectionHint()
}

// With the Later section off, pins that already exist stay in the pinned fold
// (#247 §2.4); say so under the switch, so turning it off never hides an ask
// without a word. Ambient: painted with every frame, never a render gate.
function paintLaterSectionHint() {
  const hint = document.getElementById('later-section-hint')
  if (!hint || !lastData) return
  const pinned = laterSection ? 0 : laterEntries(allItems(lastData.g), lastData.boards, Date.now(), closedSet())
    .filter((entry) => entry.later === 'pinned').length
  const text = !pinned ? ''
    : pinned === 1 ? '1 ask is still pinned. It stays in a pinned fold until you bring it back.'
      : `${pinned} asks are still pinned. They stay in a pinned fold until you bring them back.`
  if (hint.textContent !== text) hint.textContent = text
  hint.hidden = !text
}

function renderPlanSettings(host) {
  const section = document.createElement('section')
  section.className = 'setup-block plan-settings'
  const title = document.createElement('h3')
  title.textContent = 'Plans'
  const preference = document.createElement('label')
  preference.className = 'settings-toggle'
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.checked = savedGroupPlans()
  input.setAttribute('aria-describedby', 'group-plans-detail')
  input.addEventListener('change', () => {
    try {
      localStorage.setItem(GROUP_PLANS_KEY, String(input.checked))
    } catch (err) {
      input.checked = savedGroupPlans()
      console.error('Plan grouping could not be saved', err)
      document.getElementById('status').textContent = 'plan grouping not saved'
      return
    }
    groupByParent = input.checked
    // The human's own choice: renderIfIdle() would hold it behind any open draft.
    forceRender()
  })
  const preferenceCopy = document.createElement('span')
  const label = document.createElement('strong')
  label.textContent = 'Group plans by parent issue'
  const detail = document.createElement('small')
  detail.id = 'group-plans-detail'
  detail.textContent = 'Gathers the active plans of one project that share a GitHub parent issue under a heading for it. No plan is hidden. Used each time Agent Inbox opens; the switch under View on the Plans page changes only the current view.'
  preferenceCopy.append(label, detail)
  preference.append(input, preferenceCopy)
  section.append(title, preference)
  host.appendChild(section)
}

// Issue #222: off by default; the controller owns the stored preference.
let copyOnSelect = null

function initCopyOnSelect() {
  copyOnSelect = createCopyOnSelect({ storage: localStorage })
}

function renderCopySettings(host) {
  if (!copyOnSelect) return
  const section = document.createElement('section')
  section.className = 'setup-block copy-settings'
  const title = document.createElement('h3')
  title.textContent = 'Copying'
  const preference = document.createElement('label')
  preference.className = 'settings-toggle'
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.className = 'copy-on-select-toggle'
  input.checked = copyOnSelect.enabled
  input.setAttribute('aria-describedby', 'copy-on-select-detail')
  input.addEventListener('change', () => copyOnSelect.setEnabled(input.checked))
  const preferenceCopy = document.createElement('span')
  const label = document.createElement('strong')
  label.textContent = 'Copy text when selected'
  const detail = document.createElement('small')
  detail.id = 'copy-on-select-detail'
  detail.textContent = 'Copies text to the clipboard as soon as you finish selecting it. Text you select in a reply box or other field is never copied this way.'
  preferenceCopy.append(label, detail)
  preference.append(input, preferenceCopy)
  section.append(title, preference)
  host.appendChild(section)
}

let updateSettings = null
let updateSubscriptionStarted = false

function updateStateCopy(state) {
  const version = state.available?.version ?? ''
  switch (state.status) {
    case 'checking': return 'Checking GitHub for a signed release…'
    case 'current': return 'Agent Inbox is up to date.'
    case 'available': return `Agent Inbox ${version} is available.`
    case 'stale': return state.automaticChecks
      ? 'Release information was out of date. Agent Inbox will check again automatically.'
      : 'Release information was out of date. Check again later.'
    case 'downloading': return `Downloading Agent Inbox ${version}…`
    case 'verified': return `Agent Inbox ${version} is downloaded and verified.`
    case 'download-failed': return `Agent Inbox ${version} couldn’t be downloaded and verified.`
    case 'installing': return `Installing version ${version}. Agent Inbox will restart when it’s ready.`
    case 'install-failed': return `Agent Inbox ${version} couldn’t be installed.`
    case 'unverified': return 'Couldn’t check right now. You can review Releases manually.'
    case 'unsupported': return 'Updates are not available for this app build.'
    default: return 'Ready to check GitHub for a signed release.'
  }
}

function formatMegabytes(bytes) {
  const megabytes = bytes / (1024 * 1024)
  return `${megabytes >= 100 ? Math.round(megabytes) : megabytes.toFixed(1)} MB`
}

// Main installs only from the window it bound to the viewer this app started
// and owns (#216). After a reload or crash it could not re-prove, installing
// takes a fresh start, which reuses the verified download.
function needsRestartToInstall(state) {
  return state.available?.installable === true && state.available.installPermitted !== true
}

// Only macOS restarts itself from here; an AppImage is quit and reopened by hand.
function restartsItself(state) {
  return state.available?.target?.installStrategy === 'macos-dmg'
}

function restartToInstallCopy(state) {
  return restartsItself(state)
    ? 'Restart Agent Inbox to install this update.'
    : 'Quit and reopen Agent Inbox to install this update.'
}

// Main registers no installer for a window that opened on a viewer this app did
// not start (#216), and says so with a fixed code (#465).
function installWithheldCopy(state) {
  return state.available?.installWithheld === 'unowned-viewer'
    ? 'Agent Inbox opened on a viewer that another copy started, so it can’t install updates from here. To install this update, quit Agent Inbox and any other copy of it, then reopen Agent Inbox.'
    : ''
}

function updateDetailCopy(state) {
  const download = state.download
  switch (state.status) {
    case 'available':
      // Main's plain reason this installation cannot download or install the offer.
      return typeof state.available?.reason === 'string' ? state.available.reason : installWithheldCopy(state)
    case 'downloading':
      return download ? `${formatMegabytes(download.receivedBytes)} of ${formatMegabytes(download.totalBytes)}` : ''
    case 'verified':
      if (needsRestartToInstall(state)) return restartToInstallCopy(state)
      if (state.available?.installable === true) {
        return 'Its size and SHA-256 match the signed release. Agent Inbox will install it and restart.'
      }
      return `Its size and SHA-256 match the signed release. ${installWithheldCopy(state)
        || 'Agent Inbox can’t install it from the app here, so use Review release to install it yourself.'}`
    case 'download-failed':
      // Main says why (for example, a verified file that changed on disk).
      return typeof state.message === 'string' && state.message !== ''
        ? state.message
        : 'Nothing unverified was kept. Try again, or review the release on GitHub.'
    case 'install-failed':
      if (needsRestartToInstall(state)) return restartToInstallCopy(state)
      return typeof state.message === 'string' && state.message !== ''
        ? state.message
        : 'Nothing was changed. Try again, or review the release on GitHub.'
    default:
      return ''
  }
}

function paintUpdateSettings(state) {
  if (!updateSettings) return
  const {
    appVersion,
    automatic,
    cancel,
    check,
    checked,
    detail,
    download,
    install,
    notice,
    progress,
    releases,
    restart,
    review,
    section,
    status,
  } = updateSettings
  const focused = document.activeElement
  const downloadable = state.available?.downloadable === true
  const installable = state.available?.installable === true
  const downloading = state.status === 'downloading'
  const installing = state.status === 'installing'
  const installOffered = installable && (state.status === 'verified' || state.status === 'install-failed')
  appVersion.textContent = `Agent Inbox app ${state.currentVersion || 'version unavailable'}`
  status.textContent = updateStateCopy(state)
  status.dataset.state = state.status
  check.disabled = state.status === 'checking' || downloading || installing
  check.textContent = state.status === 'checking' ? 'Checking…' : 'Check now'
  download.hidden = !(downloadable && (state.status === 'available' || state.status === 'download-failed'))
  download.textContent = state.status === 'download-failed' ? 'Try again' : 'Download update'
  install.hidden = !(installOffered && !needsRestartToInstall(state))
  install.textContent = state.status === 'install-failed' ? 'Try again' : 'Install and restart'
  restart.hidden = !(installOffered && needsRestartToInstall(state) && restartsItself(state))
  cancel.hidden = !downloading
  progress.hidden = !downloading
  if (downloading && state.download) {
    progress.max = state.download.totalBytes
    progress.value = state.download.receivedBytes
  }
  detail.textContent = updateDetailCopy(state)
  detail.hidden = detail.textContent === ''
  // An earlier install that did not take effect, reported by main after the restart.
  notice.textContent = typeof state.installNotice === 'string' ? state.installNotice : ''
  notice.hidden = notice.textContent === ''
  automatic.checked = Boolean(state.automaticChecks)
  checked.textContent = state.checkedAt
    ? `Last checked ${new Date(state.checkedAt).toLocaleString()}`
    : 'Not checked yet'
  // Nothing competes with an install that is already under way, and an Intel Mac is never
  // pointed at a release it can't run (#343); under Rosetta the release still helps.
  review.hidden = !state.available || installing || state.available.blocked === 'apple-silicon'
  // The download, install or restart is the primary action while it is offered or running.
  review.classList.toggle('updates-secondary', !download.hidden || !cancel.hidden || !install.hidden || !restart.hidden)
  releases.hidden = state.status !== 'unverified' && state.status !== 'stale' && !(notice.textContent !== '' && !state.available)
  // A pressed action can hide itself (Download → Cancel, Install → installing);
  // keep keyboard focus inside Updates instead of dropping it to the document,
  // but never take focus while the window is in the background.
  if (focused instanceof HTMLElement && focused.hidden && section.contains(focused) && document.hasFocus()) {
    const next = [cancel, install, restart, download, review, releases, check].find((button) => !button.hidden && !button.disabled)
    ;(next ?? section).focus()
  }
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

  const notice = document.createElement('p')
  notice.className = 'updates-notice'
  notice.hidden = true

  const checked = document.createElement('p')
  checked.className = 'updates-checked'
  checked.textContent = 'Not checked yet'

  const progress = document.createElement('progress')
  progress.className = 'updates-progress'
  progress.setAttribute('aria-label', 'Update download progress')
  progress.hidden = true

  const detail = document.createElement('p')
  detail.className = 'updates-detail'
  detail.hidden = true

  const actions = document.createElement('div')
  actions.className = 'updates-actions'
  const check = btn('Check now', () => bridge.check().catch(() => {}))
  check.className = 'updates-check'
  const download = btn('Download update', () => bridge.download().catch(() => {}))
  download.className = 'updates-download'
  download.hidden = true
  const install = btn('Install and restart', () => bridge.install().catch(() => {}))
  install.className = 'updates-install'
  install.hidden = true
  const restart = btn('Restart Agent Inbox', () => {
    // Main restarts only in the state that offers this button. When it refuses
    // anyway, usually because agent setup is running, say so: a button that
    // silently did nothing would lie.
    bridge.restart().then((restarting) => {
      if (restarting === true) return
      detail.textContent = 'Agent Inbox didn’t restart. If agent setup is running, try again when it finishes.'
      detail.hidden = false
    }).catch(() => {})
  })
  restart.className = 'updates-restart'
  restart.hidden = true
  const cancel = btn('Cancel download', () => bridge.cancelDownload().catch(() => {}))
  cancel.className = 'updates-cancel'
  cancel.hidden = true
  const review = btn('Review release', () => bridge.openRelease().catch(() => {}))
  review.className = 'updates-review'
  review.hidden = true
  const releases = btn('Open Releases', () => bridge.openRelease().catch(() => {}))
  releases.className = 'updates-releases'
  releases.hidden = true
  actions.append(check, download, install, restart, cancel, review, releases)

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

  section.append(heading, status, notice, progress, detail, checked, actions, preference)
  host.appendChild(section)
  updateSettings = {
    appVersion,
    automatic,
    cancel,
    check,
    checked,
    detail,
    download,
    install,
    notice,
    progress,
    releases,
    restart,
    review,
    section,
    status,
  }

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
  renderSortSettings(host)
  renderMotionSettings(host)
  renderLaterSettings(host)
  renderPlanSettings(host)
  renderCopySettings(host)
  // #617 PR 3c: shown from another Mac, Settings ends here, with one line in place of the rest
  if (!hubMode.local()) {
    await hubMode.ready()
    if (!hubMode.local()) {
      hubMode.renderSettingsNote(host)
      return
    }
  }
  renderLinkSettings(host)
  // #586: which terminal Open in Terminal and Take over use; the buttons' titles follow at once
  renderTerminalSettings(host, { onChange: () => launchUi?.refresh() })
  renderLaunchSettings(host, { onChange: (state) => launchUi?.setState(state) })
  // #617 PR 2d: drawn only in the desktop app, after the sections above
  renderRemoteSettings(host)
  // #617 PR 3c: Settings → Use another Mac's Inbox, on this Mac's own page only
  renderConnectSettings(host)
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
    renderAgents(host, s, canInstall)
    renderRuntimes(host, s, canInstall)
    const menu = setupMenu(s, canInstall)
    host.appendChild(menu)
    setupShown = { info: s, canInstall, menu }
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

// ── #617 PR 3c: another Mac's Inbox ────────────────────────────────────────
// The page the hub serves runs in the connecting Mac's hub view too; there it is in hub mode
// (public/hub-mode.js) and calls no route the hub's remote entry refuses. Made before renderSetup.
const hubMode = installHubMode()
// This Mac's own page draws whose Inbox is on screen while another Mac's is shown over it.
installHubStrip({
  onShowing: (id) => {
    const waiting = settingsFocusWhenUncovered
    settingsFocusWhenUncovered = null
    if (id !== null) {
      // the other Mac's Inbox is on top again by another way: closing Settings no longer goes back
      settingsFromHub = false
      return
    }
    // once: later answers leave the keyboard where the person has put it
    if (waiting !== null && waiting.isConnected && settingsOpen()) waiting.focus({ preventScroll: true })
  },
})

// ── init ────────────────────────────────────────────────────────────────────
// Canonical order for the finished app; later tasks add their one line at the
// slot named here and never rewrite this block:
//   initTabs → initTriage → initRelay → initMission → initSearch →
//   initResponsive → initSidebarCollapse → initPaneResizers → initProjectDisclosure →
//   initKeys (Task 17) → initFocusHash (Task 17) → initStagedFlush →
//   initDraftPersistence (#279) → initPressGuard (#38) → initScrollGuard → initIdleFrame (#298) → initAgentSelect →
//   initStructuredTextCopy → initLinkOpening → initCopyOnSelect → initGear → initSessionsIndicator →
//   initLaunches (#412 step 3) → renderSetup → load →
//   setInterval(load, 3000)
initTabs()
initTriage()
initRelay()
initMission()
initSearch()
initFind()
initResponsive()
initSidebarCollapse()
initPaneResizers()
initProjectDisclosure()
initKeys()
initFocusHash()
initStagedFlush()
initDraftPersistence()
initPressGuard()
initScrollGuard()
initIdleFrame()
initPlansHold()
initAgentSelect()
initStructuredTextCopy()
initLinkOpening({ hubFiles })
initCopyOnSelect()
initGear()
initSessionsIndicator()
initLaunches()
renderSetup()
// The LAST two lines that may ever call the gated load() directly: the boot paint
// and the poll itself. Every other caller is a human action and goes through
// reloadAndPaint() — see the block above forceRender(), and issue #38.
load()
setInterval(load, 3000)
