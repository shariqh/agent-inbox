import { paginate, paginateGroups, searchMatches } from '/search.js'
import { filterRailEntries, railEntries, railProjects, shouldShowRailFilter } from '/rail.js'
import { attentionCount, classifyLiveness, countsByProject, staleEntries } from '/attention.js'
import { DEFAULT_TAB, TAB_IDS, tabCounts } from '/tabs.js'
import { projectColor, projectMonogram } from '/colors.js'
import { shouldSuspendRender, suspendHint, pinOrder, applyListUpdate } from '/poll.js'
import { canUndo, createStagedSend } from '/star.js'
import {
  ageChip, agentCounts, awaitingPickupEntries, needsYouEntries, relMs, rowModel, rowStarOption,
  stagedLabel, staleFoldLabel, streamCounts, undoRefusal, urgencyChip,
} from '/rowview.js'
import { cardSections, optionOrder } from '/card.js'
import { partitionNotes, unreadNoteCount, ambientChips } from '/notes.js'
import { liveSummary } from '/livebar.js'
import { esc } from '/esc.js'
import { boardRowsView, progressLabel, hiddenDoneCount, lingeringBoards } from '/boards.js'
import { liveEntity, tabMatchCounts, projectMatchCounts, otherTabMatches } from '/tabsearch.js'
import { titleWithBadge, focusHashFor, parseFocusHash } from '/badge.js'

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
const FILTER_KEY = 'agent-inbox-agent-filter'
const PROJECT_KEY = 'agent-inbox-project-filter'
const HIDE_DONE_KEY = 'agent-inbox-hide-completed'
let agentFilter = localStorage.getItem(FILTER_KEY) || null
let projectFilter = localStorage.getItem(PROJECT_KEY) || null
let hideCompleted = localStorage.getItem(HIDE_DONE_KEY) !== 'false' // default ON

const NOTES_SEEN_KEY = 'agent-inbox-notes-seen'
let notesSeenAt = localStorage.getItem(NOTES_SEEN_KEY) || null
function markNotesSeen() {
  notesSeenAt = new Date().toISOString()
  localStorage.setItem(NOTES_SEEN_KEY, notesSeenAt)
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

function suspendState() {
  return {
    expanded: openRowId ? [openRowId] : [],
    drafts: { ...draftReplies, ...draftReplyContexts, ...rowDrafts },
  }
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
  if (shouldSuspendRender(suspendState())) {
    renderDirty = true
    showPauseHint()
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

// the single writer of openRowId — Tasks 11/16/17 call this, never assign
function setOpenRow(id) {
  openRowId = id
  resumeRender()
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
      render()
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
    lastData = { g: ageNotes(g, Date.now()), boards, archived, activity }
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
      method: 'POST',
      ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    })
    return await res.json().catch(() => ({}))
  } catch (err) {
    console.error(`POST ${url} failed`, err)
    document.getElementById('status').textContent = 'disconnected'
    return null
  }
}

function allItems(g) {
  return [...g.needsYou.flatMap((x) => x.items), ...g.notes.flatMap((x) => x.items), ...g.done]
}

const BASE_TITLE = 'Agent Inbox'

// The document-title badge is GLOBAL — filters narrow the list, never the
// signal (spec §7). Zero attention ⇒ the bare title, so the badge can rest.
// This is the ONLY writer of document.title in the product.
function applyBadge() {
  const live = new Set((lastData.activity ?? []).map((a) => a.session))
  const n = attentionCount(allItems(lastData.g), lastData.boards, Date.now(), live)
  document.title = titleWithBadge(BASE_TITLE, n)
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
  setOpenRow(id)                                  // Task 9: single-open accordion
  const hash = focusHashFor(id)
  if (location.hash !== hash) location.hash = hash // survives reload
  render()
  requestAnimationFrame(() => {
    const el = document.querySelector(`[data-card-id="${CSS.escape(id)}"]`)
    if (!el) return
    if (el.tagName === 'DETAILS') el.open = true
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
  renderRail()
  const agents = collectAgents(projectScoped(lastData))
  if (agentFilter && !agents.includes(agentFilter)) agentFilter = null
  renderAgentSelect(agents)
  // prune collapse state against ALL cards, not the filtered view, so
  // switching tabs never drops state for cards the filter is hiding
  liveCardIds = new Set([...allItems(lastData.g).map((i) => i.id), ...lastData.boards.map((b) => b.id), ...lastData.archived.map((b) => b.id)])
  const filtered = filterData(lastData)
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
  // projectMatchCounts stays fed the GLOBAL lastData, unscoped by the rail
  // filter, on purpose: it's how the user discovers a match sitting behind a
  // DIFFERENT project pill than the one currently selected.
  const projMatches = projectMatchCounts(lastData, searchQuery, fuzzyFilter)
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
    globalAttention: attentionCount(allItems(lastData.g), lastData.boards, Date.now(), liveSessionIds()),
    unreadNotes: unreadNoteCount(g.notes.flatMap((gr) => gr.items), notesSeenAt, Date.now()),
    scoped: { boards, done: g.done },
  })
  for (const id of TAB_IDS) setCount(id, counts[id])
  pruneCollapsedCards()
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

function buildDeck() {
  const qs = lastData.g.needsYou
    .flatMap((gr) => gr.items)
    .filter((i) => !i.reply)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1)) // longest-waiting first
  const rows = lastData.boards.flatMap((b) => b.rows.filter((r) => r.status === 'blocked').map((r) => ({ b, r })))
  return [
    ...qs.map((q) => ({ type: 'q', id: q.id })),
    ...rows.map(({ b, r }) => ({ type: 'row', boardId: b.id, rowId: r.id })),
  ]
}

// resolve a deck entry against the LATEST data; null = no longer needs input
function findEntryData(e) {
  if (e.type === 'q') {
    const it = lastData.g.needsYou.flatMap((gr) => gr.items).find((i) => i.id === e.id)
    return it && !it.reply ? { it } : null
  }
  const b = lastData.boards.find((x) => x.id === e.boardId)
  const r = b?.rows.find((x) => x.id === e.rowId && x.status === 'blocked')
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
// the board DOM is rebuilt every poll, so open state lives out here
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
  const save = async () => {
    if (!input.value.trim()) return
    delete rowDrafts[r.id]
    if (rowFocusId === r.id) rowFocusId = null
    const res = await postJSON(`/api/boards/${b.id}/rows/${r.id}/annotate`, { text: input.value.trim() })
    if (res === null) return // network failure — postJSON already signaled it
    // the row stays blocked until the agent picks the note up — the human's part
    // is done, so the caller decides what to drop
    onSaved?.()
    load()
  }
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save() })
  row.appendChild(input)
  row.appendChild(btn('Send', save))
  if (rowFocusId === r.id) requestAnimationFrame(() => {
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
  })
  return row
}

// the inline expansion under a matrix row: long context + existing annotation + answer
function rowPanelEl(b, r, readOnly = false) {
  const wrap = document.createElement('div')
  wrap.className = 'row-panel'
  wrap.innerHTML = `
    ${r.context ? `<div class="row-context-body">${esc(r.context)}</div>` : ''}
    ${r.annotation ? `<div class="annotation">📝 ${esc(r.annotation)}${r.annotation_unseen ? '<span class="unseen" title="Not yet seen by the agent">●</span>' : ''}</div>` : ''}`
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
    ${r.annotation ? `<div class="annotation">📝 ${esc(r.annotation)}</div>` : ''}`
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
  document.addEventListener('keydown', (e) => {
    const typing = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA'
    // 't' opens the triage deck — the Now strip's button went with the strip
    if (!triageDeck && !typing && e.key === 't') { openTriage(); return }
    if (!triageDeck) return
    if (e.key === 'Escape') closeTriage()
    else if (!typing && e.key === 'ArrowLeft' && triageDeck.index > 0) { triageDeck.index--; renderTriage() }
    else if (!typing && e.key === 'ArrowRight' && triageDeck.index < triageDeck.entries.length - 1) { triageDeck.index++; renderTriage() }
  })
}

function jumpToCard(tabId, cardId) {
  selectTab(tabId)
  const card = document.querySelector(`[data-card-id="${CSS.escape(cardId)}"]`)
  if (!card) return
  if (card instanceof HTMLDetailsElement) card.open = true
  card.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function setCount(id, n) {
  if (n == null) return // Live carries a presence dot, not a number
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
  }
  showPanel(id)
}

function initTabs() {
  for (const t of document.querySelectorAll('#tabs .tab')) {
    t.addEventListener('click', () => selectTab(t.dataset.tab))
  }
  selectTab(activeTab)
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

// section empty-state text: search-aware, and never a BARE "no matches" — it
// always points at the tabs that do have hits (spec §12)
function emptyMsg(base) {
  const q = searchQuery.trim()
  if (!q) return base
  const elsewhere = otherTabMatches(matchCounts, activeTab)
  const where = elsewhere.map(({ tab, n }) => `${n} in ${TAB_LABEL[tab]}`).join(' · ')
  return `No matches for &ldquo;${esc(q)}&rdquo; here${where ? ` — <span class="match-elsewhere">${where}</span>` : ' or in any other tab'}`
}

const liveSessionIds = () => new Set((lastData.activity ?? []).map((a) => a.session))
const themeName = () => (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')

// spec §2: color persistence. Every caller that paints a project dot/wash goes
// through THIS, never projectColor() directly — passing localStorage is what
// lets assignedHue() persist a hue across reloads and nudge a collision once,
// instead of re-hashing (and potentially re-colliding) on every render.
const pcolor = (name) => projectColor(name, themeName(), localStorage)

// typed rail filter; only rendered when the rail is long enough to need it
let railQuery = ''

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
  if (projectFilter && !projects.includes(projectFilter)) {
    projectFilter = null
    localStorage.removeItem(PROJECT_KEY)
  }
  const counts = countsByProject(allItems(lastData.g), lastData.boards, Date.now(), liveSessionIds())
  const withFilter = shouldShowRailFilter(projects)
  if (!withFilter) railQuery = ''
  const entries = filterRailEntries(railEntries(projects, counts), railQuery)
  const th = themeName()
  const sig = JSON.stringify([entries, projectFilter, th, withFilter, railQuery])
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
  for (const e of entries) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'rail-tab'
    b.dataset.project = e.key // '__all__' for the unfiltered view
    b.setAttribute('role', 'tab')
    const selected = e.key === '__all__' ? !projectFilter : projectFilter === e.key
    b.setAttribute('aria-selected', String(selected))
    if (!e.total) b.classList.add('quiet')
    const color = e.key === '__all__' || e.unknown ? null : pcolor(e.key)
    if (e.unknown) {
      b.classList.add('unknown')
      b.title = 'Project inference failed for these agents — a register() call fixes their scope.'
    }
    // selection is a soft wash of the project's own color; no stripe anywhere
    if (selected && color) b.style.background = color.wash
    const dot = document.createElement('span')
    dot.className = e.key === '__all__' ? 'rail-dot all' : 'rail-dot'
    if (color) dot.style.background = color.dot
    const name = document.createElement('span')
    name.className = 'rail-name'
    name.textContent = e.label // agent-authored: textContent, never innerHTML
    name.title = e.label
    const badge = document.createElement('span')
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
      render()
    })
    host.appendChild(b)
  }
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
    render()
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
  render()
}

function undoDismiss(id) {
  if (!dismissStage.undo(`dismiss:${id}`)) return false
  stagedDismiss.delete(id)
  render()
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
function renderNeedsYouExtras(host) {
  const notes = lastData.g.notes.flatMap((gr) => gr.items)
  const n = unreadNoteCount(notes, notesSeenAt, Date.now())
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
  const chips = ambientChips(allItems(lastData.g), lastData.boards, Date.now(), notesSeenAt)
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
  const items = g.needsYou.flatMap((gr) => gr.items)
  const live = liveSessionIds()
  // §7: the LIST is scoped by the rail + search (boardsInView); the tab count is
  // computed from lastData by Task 8 and never sees this slice
  const unordered = needsYouEntries(items, boardsInView, nowMs, live, awaitingPickupEntries(items, nowMs, live))
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
  host.innerHTML = ''
  host.appendChild(needsYouHeader())
  if (!entries.length) {
    // a search that matched nothing still says so; an empty INBOX gets the calm panel
    if (searchQuery.trim()) host.insertAdjacentHTML('beforeend', `<p class="empty">${emptyMsg('Nothing needs you.')}</p>`)
    else renderEmptyState(host)
  }
  for (const e of visible) host.appendChild(needsRowEl(rowModel(e, opts), e, nowMs))
  if (remaining > 0) host.appendChild(moreButton('needsYou', remaining))
  const stale = staleEntries(items, nowMs, live)
  if (stale.length) host.appendChild(staleFoldEl(stale, opts, nowMs))
  renderNeedsYouExtras(host)
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
  const projBit = m.projectLabel ? `<span class="nrow-proj" title="${esc(m.project)}">${esc(m.projectLabel)}</span>` : ''
  const agentBit = m.agent ? `<span class="nrow-agent">${esc(m.agent)}</span>` : ''
  const streamBit = m.stream ? `<span class="nrow-stream">${esc(m.stream)}</span>` : ''
  el.innerHTML = `
    <div class="nrow-l1">
      <span class="pdot" style="background:${color.dot}" title="${esc(m.project)}"></span>
      ${projBit}
      ${glyph}
      <span class="nrow-title" title="${esc(m.title)}">${esc(m.title)}</span>
      <span class="chip chip-${chip.tone}">${esc(chip.text)}</span>
      <span class="nrow-star"></span>
      <button class="nrow-dismiss" title="Dismiss (x)" aria-label="Dismiss">✕</button>
      <span class="nrow-caret">▸</span>
    </div>
    <div class="nrow-l2"><span class="nrow-sec">${esc(m.secondary)}</span>${agentBit}${streamBit}</div>`
  el.style.setProperty('--wash', color.wash)
  const boardBtn = el.querySelector('.nrow-glyph')
  if (boardBtn) boardBtn.addEventListener('click', (ev) => { ev.stopPropagation(); jumpToCard('boards', m.boardId) })
  el.querySelector('.nrow-dismiss').addEventListener('click', (ev) => {
    ev.stopPropagation()
    if (m.kind === 'item') stageDismiss(m.id)
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
      if (starStage.undo(`star:${m.id}`)) { stagedStars.delete(m.id); render(); return }
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
      render()
    })
    star.className = 'star-btn'
    star.setAttribute('aria-label', `Answer: ${opt.label}`)
    star.title = `Answer: ${opt.label}`
    star.addEventListener('click', (ev) => ev.stopPropagation())
    slot.replaceChildren(star)
  } else if (m.answered && !canUndo(entry.item)) {
    const note = document.createElement('span')
    note.className = 'pickup picked'
    note.textContent = '✓ picked up'
    slot.replaceChildren(note)
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
  body.appendChild(entry.kind === 'row'
    ? rowCardEl(entry.board, entry.row)
    : itemCardEl(entry.item, { nowMs, liveness: m.liveness }))
  return body
}

// Single-open accordion. `setOpenRow` (Task 9) owns the flag and the poll gate;
// the DOM is patched in place because a re-render is exactly what the gate is
// there to suspend. Collapsing hands the poll its pending data back.
function toggleRow(el, m, entry, nowMs) {
  const wasOpen = openRowId === m.id
  setOpenRow(wasOpen ? null : m.id)
  for (const other of document.querySelectorAll('.nrow[data-open="1"]')) {
    other.removeAttribute('data-open')
    const card = other.querySelector('.nrow-card')
    if (card) card.remove()
  }
  if (wasOpen) { renderIfIdle(); return }
  el.dataset.open = '1'
  el.appendChild(rowCardBodyEl(entry, m, nowMs))
}

// notes keep a card list, but flat: no project h3, no agent h4 (§15)
function renderGroups(sectionId, groups) {
  const host = document.querySelector(`#${sectionId} .groups`)
  const items = groups.flatMap((gr) => gr.items)
  const { visible, remaining } = paginate(items, shown[sectionId])
  host.innerHTML = items.length ? '' : `<p class="empty">${emptyMsg('Nothing here.')}</p>`
  for (const it of visible) host.appendChild(itemEl(it))
  if (remaining > 0) host.appendChild(moreButton(sectionId, remaining))
  if (sectionId === 'notes' && activeTab === 'notes') markNotesSeen()
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
    render()
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
  if (!boards.length && !lingering.length) host.insertAdjacentHTML('beforeend', `<p class="empty">${emptyMsg('No boards.')}</p>`)
  const { visible, remaining } = paginate(boards, shown.boards)
  for (const b of visible) host.appendChild(boardEl(b))
  if (remaining > 0) host.appendChild(moreButton('boards', remaining))
  for (const b of lingering) host.appendChild(boardEl(b, true, true))
  const rest = archived.filter((b) => !lingerIds.has(b.id))
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
    render()
  })
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
      <td class="row-note"><span class="note-line">${esc(r.note)}</span>${r.context ? '<span class="more-dot" title="has context — click the row">…</span>' : ''}${r.annotation ? `<span class="annotation-dot" title="${esc(r.annotation)}">📝${r.annotation_unseen ? '<span class="unseen">●</span>' : ''}</span>` : ''}</td>`
    const actionTd = document.createElement('td')
    actionTd.className = 'row-action'
    const toggle = () => {
      openRows.has(r.id) ? openRows.delete(r.id) : openRows.add(r.id)
      render()
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
      load()
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
      load()
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
  delete draftReplies[id]
  delete draftReplyContexts[id]
  if (draftFocusKey?.startsWith(`${id}:`)) draftFocusKey = null
  const res = await postJSON(`/api/items/${id}/reply`, { text: reply, context: context.trim() || undefined })
  if (res === null) return // network failure — postJSON already signaled it
  load()
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
      render()
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
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendReply(it.id, input.value, ctxInput.value) })
  row.appendChild(input)
  row.appendChild(btn('Send', () => sendReply(it.id, input.value, ctxInput.value)))
  wrap.appendChild(row)
  const ctxRow = document.createElement('div')
  ctxRow.className = 'reply-row reply-context-row'
  const ctxInput = document.createElement('input')
  ctxInput.className = 'reply-input reply-context-input'
  ctxInput.placeholder = 'optional context for the agent (applies to Send or option picks)…'
  ctxInput.value = draftReplyContexts[it.id] ?? ''
  ctxInput.addEventListener('input', () => { draftReplyContexts[it.id] = ctxInput.value; resumeRender() })
  ctxInput.addEventListener('focus', () => { draftFocusKey = `${it.id}:context` })
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
      <span class="chip chip-${chip.tone}">${esc(chip.text)}</span>
    </div>
    <div class="card-title">${esc(it.title)}</div>` : ''
  el.innerHTML = `
    ${head}
    ${s.detail ? `<div class="detail card-detail">${esc(s.detail)}</div>` : ''}
    ${s.context ? `<div class="card-context"><div class="card-context-label">CONTEXT</div><div class="card-context-body">${esc(s.context)}</div></div>` : ''}
    ${s.annotation ? `<div class="annotation">📝 ${esc(s.annotation)}</div>` : ''}
    ${s.recWarning ? `<div class="rec-warning">⚠ ${esc(s.recWarning)}</div>` : ''}
    ${s.reply ? `<div class="reply-block">↩ ${esc(s.reply)}${it.reply_context ? `<div class="reply-context">context: ${esc(it.reply_context)}</div>` : ''}<span class="pickup ${it.reply_seen_at ? 'picked' : 'awaiting'}">${it.reply_seen_at ? '✓ picked up' : '● waiting for agent pickup'}</span></div>` : ''}`
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
      load()
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
  draftReplies[it.id] = it.reply
  draftReplyContexts[it.id] = it.reply_context ?? ''
  const res = await postJSON(`/api/items/${it.id}/reply`, { text: '' })
  if (res === null) return // network failure — postJSON already signaled it
  if (!res.ok) {
    const fresh = freshItem(it.id) ?? it
    const seenAt = fresh.reply_seen_at ?? new Date().toISOString()
    const refusal = undoRefusal({ ...fresh, reply_seen_at: seenAt }, Date.now())
    if (msgEl) msgEl.textContent = `${refusal} `
    return
  }
  load()
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

function btn(label, onClick) {
  const b = document.createElement('button')
  b.textContent = label
  b.addEventListener('click', onClick)
  return b
}

// the pager at the foot of a capped section — reveals PAGE[section] more cards
function moreButton(section, remaining) {
  const n = Math.min(PAGE[section], remaining)
  const b = btn(`Show ${n} more (${remaining} hidden)`, () => { shown[section] += PAGE[section]; render() })
  b.className = 'show-more'
  return b
}

async function act(id, action) {
  const res = await postJSON(`/api/items/${id}/${action}`)
  if (res === null) return // network failure — postJSON already signaled it
  load()
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
    t = setTimeout(() => { searchQuery = input.value; resetPaging(); render() }, 120)
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
    const db = document.createElement('p')
    db.className = 'setup-hint'
    db.textContent = `Everything lands in ${s.dbPath} — any viewer (browser tab, app) reads the same file.`
    host.appendChild(db)
  } catch { /* setup info unavailable — leave the section empty */ }
}

// ── init ────────────────────────────────────────────────────────────────────
// Canonical order for the finished app; later tasks add their one line at the
// slot named here and never rewrite this block:
//   initTabs → initTriage → initSearch → initAgentSelect → initGear →
//   initListStaging (Task 9) → initKeys (Task 17) → initFocusHash (Task 17) →
//   initResponsive (Task 18) → renderSetup → load → setInterval(load, 3000)
initTabs()
initTriage()
initSearch()
initFocusHash()
initStagedFlush()
initListStaging()
initAgentSelect()
initGear()
initLiveBar()
renderSetup()
load()
setInterval(load, 3000)
