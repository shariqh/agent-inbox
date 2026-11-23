// UX pass, slice 4: Find. One list in place of Notes and History, built from data the
// page already holds (no route of its own). Pure: no DOM, no clock of its own, so
// the page and its tests share every rule. The page draws the rows (app.js), keeps
// what is open, paged and kept in module state, and reconciles rows by `key`.
//
// A row: a type (its icon and label), a title, one small extra, the project and a
// stamp the page turns into an age. What a press does is the row's `action`:
// `expand` opens it in place, `home` goes to the ask on Home, `plans` to the plan.
//
// Step B: chats (Claude Code and Copilot CLI conversations on this Mac) are rows too, keyed
// `chat:<tool>:<id>`, from the list chats-view.js read. They are matched on their metadata only
// (title, project, branch, folder) with the Chats page's substring rule; a chat's messages are
// never read, so never matched. They ignore the project rail and the Agent select, and they are
// never cut: they have no gap to wait on.
import { buildSearchResults } from './search-index.js'
import { planBarLabel, planSegments, planStepStates } from './lanes.js'
import { filterChats, inferHome, sortChats, titleView, toolLabel } from './chats.js'

export const FIND_CHIPS = ['all', 'answers', 'notes', 'plans', 'chats']
// rows per page, and per press of "Show 20 more"
export const FIND_PAGE = 20
// the plan bar's per-step limit in a row, as the Plans page's narrow bar
const BAR_STEPS = 12
const CHIP_WORDS = 4
const TEXT_WORDS = 12

const grouped = (groups = []) => groups.flatMap((group) => group.items ?? [])
const ms = (iso) => {
  const at = Date.parse(iso ?? '')
  return Number.isFinite(at) ? at : 0
}
const clean = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '')

// An age in the row's narrow column: now, 5m, 3h, 2d, 3w.
export function findAge(ageMs) {
  const m = Math.floor(Math.max(0, ageMs) / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d`
  return `${Math.floor(d / 7)}w`
}

// The first `count` words, with an ellipsis when there were more.
function firstWords(text, count) {
  const words = clean(text).split(' ').filter(Boolean)
  return words.length > count ? `${words.slice(0, count).join(' ')}…` : words.join(' ')
}

const answered = (item) => item.kind === 'question' && Boolean(clean(item.reply) || item.reply_kind)
const isHandoff = (item) => item.kind === 'done' && item.handoff === 1
const closedStamp = (item) => ms(item.outcome_at ?? item.resolved_at ?? item.updated_at ?? item.created_at)

// The answer as the row shows it: the option's label, or the first words of a typed answer.
function answerChip(item) {
  if (item.reply_kind === 'decline') return { kind: 'chip', text: 'Declined', full: clean(item.reply) || 'Declined' }
  if (item.reply_kind === 'clarify') return { kind: 'chip', text: 'Asked to clarify', full: clean(item.reply) || 'Asked to clarify' }
  const reply = clean(item.reply)
  const option = (item.options ?? []).find((o) => clean(o.label) === reply)
  return { kind: 'chip', text: option ? clean(option.label) : firstWords(reply, CHIP_WORDS), full: reply }
}

function finishedExtra(item) {
  const outcome = clean(item.outcome)
  if (outcome) return { kind: 'text', text: firstWords(outcome, TEXT_WORDS), full: outcome }
  return { kind: 'state', text: item.status === 'dismissed' ? 'Dismissed' : 'Completed', full: '' }
}

function noteExtra(item) {
  if (item.status !== 'open') {
    const text = item.status === 'dismissed' ? 'Dismissed' : 'Resolved'
    return { kind: 'state', text, full: '' }
  }
  const detail = clean(item.detail)
  if (!detail || detail === clean(item.title)) return null
  return { kind: 'text', text: firstWords(detail, TEXT_WORDS), full: detail }
}

// A plan's bar: from its steps, or from its progress counts while an archived plan's
// steps are not all loaded.
function planExtra(plan, { nowMs, fromCounts }) {
  let states
  if (fromCounts) {
    const progress = plan.progress ?? { done: 0, partial: 0, countable: 0 }
    const done = progress.done ?? 0
    const partial = progress.partial ?? 0
    const todo = Math.max(0, (progress.countable ?? 0) - done - partial)
    states = [...Array(done).fill('done'), ...Array(partial).fill('progress'), ...Array(todo).fill('todo')]
  } else {
    states = planStepStates(plan, nowMs).states
  }
  const counts = { done: 0, progress: 0, needs: 0, todo: 0 }
  for (const state of states) counts[state] += 1
  const { runs, segments } = planSegments(states, BAR_STEPS)
  return { kind: 'bar', runs, segments, label: planBarLabel(counts) }
}

/** One row for an item or a plan. `archived`: the plan is archived; `fromCounts`: its steps are not loaded. */
export function findRow(entity, { nowMs = Date.now(), archived = false, fromCounts = false } = {}) {
  const base = { id: entity.id, title: clean(entity.title), project: entity.project ?? '' }
  if (Array.isArray(entity.rows) || archived) {
    return {
      ...base, key: `board:${entity.id}`, type: 'plan', label: 'Plan', action: 'plans', open: !archived,
      cuttable: false, stamp: ms(entity.updated_at), extra: planExtra(entity, { nowMs, fromCounts }), entity,
    }
  }
  const open = entity.status === 'open'
  const row = { ...base, key: `item:${entity.id}`, open, cuttable: !open, entity }
  if (answered(entity)) {
    return { ...row, type: 'answer', label: 'Answer', action: open ? 'home' : 'expand',
      stamp: open ? ms(entity.replied_at ?? entity.updated_at ?? entity.created_at) : closedStamp(entity), extra: answerChip(entity) }
  }
  if (entity.kind === 'note') {
    return { ...row, type: 'note', label: 'Note', action: 'expand', stamp: ms(entity.created_at), extra: noteExtra(entity) }
  }
  if (open && (entity.kind === 'question' || isHandoff(entity))) {
    // an open ask Home owns: a query finds it, and a press goes there
    return { ...row, type: 'ask', label: isHandoff(entity) ? 'Hand-off' : 'Ask', action: 'home', stamp: ms(entity.created_at), extra: null }
  }
  return { ...row, type: 'finished', label: 'Finished', action: 'expand', stamp: closedStamp(entity), extra: finishedExtra(entity) }
}

/**
 * One row for a chat: the tool's icon, the title (quiet when automatic or missing), a Live
 * mark, the project and the age of its last activity. It opens in place.
 */
export function chatFindRow(chat) {
  const title = titleView(chat)
  return {
    key: `chat:${chat.tool}:${chat.id}`, id: `${chat.tool}:${chat.id}`, type: 'chat', label: toolLabel(chat.tool), tool: chat.tool,
    action: 'expand', title: title.text, titleQuiet: title.quiet, titleNote: title.title, project: chat.project ?? '',
    stamp: ms(chat.lastActiveAt), open: false, cuttable: false, live: chat.live === true, extra: null, entity: null, chat,
  }
}

// The chats a chip lists, newest active first. Under the Chats chip: the list as read (Show all's
// hidden chats included) through the tool toggle. Under All, where neither the toggle nor Show all
// is drawn: the default list, every tool.
function chatRows(chats, { query, tool, all }) {
  if (!Array.isArray(chats) || !chats.length) return []
  const home = inferHome(chats)
  const pool = all ? chats.filter((chat) => !chat.hidden?.length) : chats
  return filterChats(sortChats(pool), { query, tool: all ? 'all' : tool, project: null }, home).map(chatFindRow)
}

// What each chip holds, as a predicate over rows.
const CHIP_ROWS = {
  // with no query: no open asks, no asks closed without a reply, and no plans (each write
  // to a plan moves its stamp, so they would sit above everything: the Plans chip lists them)
  all: (row) => row.type !== 'ask' && row.type !== 'plan' && !(row.type === 'finished' && row.entity.kind === 'question'),
  answers: (row) => row.type === 'answer',
  notes: (row) => row.type === 'note',
  plans: (row) => row.type === 'plan',
  chats: (row) => row.type === 'chat',
}

// The same chip, applied inside each of search's sections (with a query, All also
// returns what has no chip: open asks and closed unanswered ones, and plan steps).
function chipData(data, chip) {
  const g = data.g ?? {}
  const needsYou = [{ items: grouped(g.needsYou) }]
  const notes = [{ items: grouped(g.notes) }]
  const done = g.done ?? []
  if (chip === 'answers') {
    return { g: { needsYou: [{ items: grouped(g.needsYou).filter(answered) }], notes: [], done: done.filter(answered) }, boards: [], archived: [] }
  }
  if (chip === 'notes') {
    return { g: { needsYou: [], notes, done: done.filter((item) => item.kind === 'note') }, boards: [], archived: [] }
  }
  if (chip === 'plans') return { g: { needsYou: [], notes: [], done: [] }, boards: data.boards ?? [], archived: data.archived ?? [] }
  return { g: { needsYou, notes, done }, boards: data.boards ?? [], archived: data.archived ?? [] }
}

function allRows(data, { nowMs, archivedWhole }) {
  const g = data.g ?? {}
  return [
    ...grouped(g.needsYou).map((item) => findRow(item, { nowMs })),
    ...grouped(g.notes).map((item) => findRow(item, { nowMs })),
    ...(g.done ?? []).map((item) => findRow(item, { nowMs })),
    ...(data.boards ?? []).map((plan) => findRow(plan, { nowMs })),
    ...(data.archived ?? []).map((plan) => findRow(plan, { nowMs, archived: true, fromCounts: !archivedWhole })),
  ]
}

const newestFirst = (a, b) => b.stamp - a.stamp || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)

// Rows the person acted on, or whose editor holds text, stay where they were painted:
// each goes back after the row that preceded it last time (the first row when none
// did). A kept row the list already holds, with no earlier place (a landing target), keeps
// its sorted place; one the list does not hold goes first, so it is in sight.
function keepInPlace(rows, keptRows, previous) {
  const inList = new Set(rows.map((row) => row.key))
  const moving = new Map([...keptRows].filter(([key]) => previous.includes(key) || !inList.has(key)))
  const list = rows.filter((row) => !moving.has(row.key))
  const placed = new Set(list.map((row) => row.key))
  const lead = []
  for (const [key, row] of moving) {
    const at = previous.indexOf(key)
    if (at < 0) {
      lead.push(row)
      continue
    }
    let anchor = -1
    for (let i = at - 1; i >= 0 && anchor < 0; i--) {
      if (placed.has(previous[i])) anchor = list.findIndex((other) => other.key === previous[i])
    }
    list.splice(anchor + 1, 0, row)
    placed.add(key)
  }
  return [...lead, ...list]
}

/**
 * The rows under a chip, in Find's order.
 *
 * No query: newest first by each row's own stamp (Notes: open notes first, then closed
 * ones), with asks closed without a reply, and plans, left out of All. While older history is not
 * loaded (`before` is its newest omitted touch), a closed item whose own stamp is not
 * later than `before` is below the cut: it is left out and counted in `cut`. Open
 * items and plans are never cut. With a query: search's order (current work first,
 * ranked inside each kind), the chip applied inside each section, no limit, no cut.
 *
 * Chats (`chats`, the list read; `chatTool`, the Chats line's tool toggle): under the Chats
 * chip, the field filters them by substring, newest active first, query or not. Under All with
 * a query they are a section after the notes and before the finished things; with no query
 * All leaves them out, as it leaves out plans. No other chip lists them.
 *
 * `keep`: keys that stay listed whatever the chip or the query (the person acted on
 * them, or their editor holds text), in their `previous` place.
 */
export function buildFindRows(data, {
  chip = 'all', query = '', searchFn = null, before = null, nowMs = Date.now(), archivedWhole = true,
  keep = [], previous = [], chats = null, chatTool = 'all',
} = {}) {
  const pick = CHIP_ROWS[chip] ?? CHIP_ROWS.all
  const every = allRows(data ?? {}, { nowMs, archivedWhole })
  const byKey = new Map(every.map((row) => [row.key, row]))
  for (const row of (Array.isArray(chats) ? chats : []).map(chatFindRow)) byKey.set(row.key, row)
  const needle = clean(query)
  let rows
  let cut = 0
  if (chip === 'chats') {
    rows = chatRows(chats, { query: needle, tool: chatTool, all: false })
  } else if (needle && searchFn) {
    const results = buildSearchResults(chipData(data ?? {}, chip), needle, searchFn, Infinity)
    rows = results
      .map((result) => {
        const row = byKey.get(result.key)
        return row ? { ...row, source: result.source, section: result.section } : null
      })
      .filter(Boolean)
    if (chip === 'all') {
      const found = chatRows(chats, { query: needle, tool: 'all', all: true })
      const at = rows.findIndex((row) => row.section === 'history' || row.section === 'archived')
      rows.splice(at < 0 ? rows.length : at, 0, ...found)
    }
    for (const row of rows) delete row.section
  } else {
    const cutAt = before == null ? null : ms(before)
    rows = every.filter(pick).filter((row) => {
      const below = cutAt !== null && row.cuttable && row.stamp <= cutAt
      if (below) cut += 1
      return !below
    })
    if (chip === 'notes') rows = [...rows.filter((row) => row.open).sort(newestFirst), ...rows.filter((row) => !row.open).sort(newestFirst)]
    else rows.sort(newestFirst)
  }
  const keptRows = new Map()
  for (const key of keep) {
    const row = rows.find((other) => other.key === key) ?? byKey.get(key)
    if (row) keptRows.set(key, row)
  }
  if (keptRows.size) rows = keepInPlace(rows, keptRows, previous)
  return { rows, cut }
}
