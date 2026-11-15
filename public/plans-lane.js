// The Dashboard's Plans in progress lane (dashboard lanes design §3.5): one row
// per active plan with an open row under the Dashboard's lens, from the boards
// the frame already holds (buildDashboard's visibleBoards); it reads nothing new.
//
// The numbers are planBar's (lanes.js), the Working card's own: done and
// countable are the server's progress, and "need you" counts the attention
// predicate's rows, so an answered ask is never pink. The lane feeds nothing
// back into the badge, a count or an alert.
//
// A row is one link-like control: a click or Enter opens its plan in the Plans
// tab (deps.open, app.js focusItem), and it holds no button and answers
// nothing. Agent text reaches the DOM only through textContent, and an
// unchanged value is never rewritten, so a selection in a row survives a poll.
// Painted from app.js's renderDashboardAmbient, so from both render entries.
import { pinLaneOrder, planBar } from './lanes.js'
import { relMs } from './rowview.js'

export const PLANS_LANE_CAP = 6
export const PLANS_EMPTY = 'No plan in this view has open steps.'

/** A step still to do: anything but done or na. */
export const isOpenRow = (row) => row?.status !== 'done' && row?.status !== 'na'

const stampMs = (iso) => {
  const at = Date.parse(iso ?? '')
  return Number.isFinite(at) ? at : null
}

/**
 * Active plans with an open row, in lane order: any row waiting on you first,
 * then the newest change, then the id, so the order is the same on every paint.
 * An archived plan arrives only in lastData.archived, which the lane never reads;
 * the status check is a guard.
 */
export function plansInProgress(boards, nowMs) {
  const out = []
  for (const board of boards ?? []) {
    if (board?.status === 'archived' || !(board.rows ?? []).some(isOpenRow)) continue
    const bar = planBar(board, nowMs)
    const updatedMs = stampMs(board.updated_at)
    out.push({
      id: board.id,
      title: String(board.title ?? ''),
      project: String(board.project ?? ''),
      done: bar.done,
      countable: bar.countable,
      waiting: bar.segments.waiting,
      updatedAt: updatedMs === null ? null : board.updated_at,
      updatedMs,
    })
  }
  return out.sort((a, b) => Number(b.waiting > 0) - Number(a.waiting > 0)
    || (b.updatedMs ?? -Infinity) - (a.updatedMs ?? -Infinity)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** The first `cap` ids, and how many are left over for "All plans · N more ›". */
export function capPlans(order, cap = PLANS_LANE_CAP) {
  return { shown: order.slice(0, cap), more: Math.max(0, order.length - cap) }
}

// As the other lanes': J/K and the arrows move between rows.
const MOVES = { j: 1, k: -1, ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }

/** @param {import('./plans-lane.js').PlansLaneDeps} deps (plans-lane.d.ts) */
export function installPlansLane(deps) {
  const doc = deps.doc ?? globalThis.document
  let mounted = null
  let order = [] // every qualifying id, in the order the last paint held
  let roving = null // the row Tab lands on
  let hovered = false
  const rowEls = new Map()
  const known = new Set() // the ids the last paint showed

  const make = (tag, className, text) => {
    const el = doc.createElement(tag)
    if (className) el.className = className
    if (text !== undefined) el.textContent = text
    return el
  }
  const setText = (el, text) => { if (el.textContent !== text) el.textContent = text }
  const setHidden = (el, hidden) => { if (el.hidden !== hidden) el.hidden = hidden }
  const setAttr = (el, name, value) => { if (el.getAttribute(name) !== value) el.setAttribute(name, value) }
  const scrollBehavior = () => deps.scrollBehavior?.() ?? 'auto'

  function laneEl() {
    const section = make('section', 'dashboard-card plans-lane')
    section.setAttribute('aria-labelledby', 'plansLaneTitle')
    const head = make('div', 'dashboard-card-head')
    // §3.5: no count; the rows and "All plans · N more ›" say how many
    const title = make('h2', '', 'Plans in progress')
    title.id = 'plansLaneTitle'
    title.tabIndex = -1
    head.append(title)
    const rows = make('div', 'pl-rows')
    rows.setAttribute('role', 'list')
    rows.setAttribute('aria-label', 'Plans in progress')
    const empty = make('p', 'pl-empty', PLANS_EMPTY)
    empty.hidden = true
    const more = make('p', 'pl-more')
    more.hidden = true
    const all = make('button', 'pl-all')
    all.type = 'button'
    all.dataset.dashboardFocusKey = 'pl:all'
    all.addEventListener('click', () => deps.openAll())
    more.append(all)
    section.append(head, rows, empty, more)
    // a row under the pointer keeps its place (§2 anti-goals); the next paint after it leaves sorts
    section.addEventListener('pointerenter', () => { hovered = true })
    section.addEventListener('pointerleave', () => { hovered = false })
    rows.addEventListener('click', onClick)
    section.addEventListener('keydown', onKey)
    return section
  }

  function onClick(event) {
    const target = event.target instanceof doc.defaultView.Element ? event.target : null
    const el = target?.closest('[data-pl-plan]')
    if (!el || !known.has(el.dataset.plPlan)) return
    // never a click that ends a text selection (copy-on-select)
    if (String(doc.getSelection?.() ?? '')) return
    deps.open(el.dataset.plPlan)
  }

  // §3.1: one roving tab stop; the event stops here, so the Inbox's own J/K and Enter never see it
  function onKey(event) {
    if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return
    const el = event.target instanceof doc.defaultView.Element ? event.target : null
    if (!el?.matches('[data-pl-plan]')) return
    const move = MOVES[event.key.length === 1 ? event.key.toLowerCase() : event.key]
    if (!move && event.key !== 'Enter') return
    event.preventDefault()
    event.stopPropagation()
    if (!move) {
      deps.open(el.dataset.plPlan)
      return
    }
    const rows = [...mounted.querySelectorAll('[data-pl-plan]')]
    const next = rows[rows.indexOf(el) + move]
    // the lane sits below the fold, so a move reveals the row it lands on, as Working's and Quiet's do
    if (next) land(next, true)
  }

  function land(el, scroll) {
    roving = el.dataset.plPlan
    for (const other of mounted.querySelectorAll('[data-pl-plan]')) other.tabIndex = other === el ? 0 : -1
    if (scroll) el.scrollIntoView?.({ block: 'nearest', behavior: scrollBehavior() })
    el.focus({ preventScroll: true })
  }

  function rowEl(id) {
    const el = make('article', 'pl-row')
    el.dataset.plPlan = id
    el.dataset.dashboardFocusKey = `pl:${id}`
    el.setAttribute('role', 'listitem')
    el.tabIndex = -1
    const project = make('span', 'pl-project')
    const dot = make('i', 'pl-dot')
    dot.setAttribute('aria-hidden', 'true')
    project.append(dot, make('span', 'pl-project-name'))
    const progress = make('span', 'pl-progress')
    const bar = make('span', 'pl-bar')
    bar.setAttribute('aria-hidden', 'true')
    bar.append(make('i'))
    progress.append(bar, make('span', 'pl-count'))
    el.append(make('div', 'pl-title'), project, progress, make('span', 'pl-waiting'), make('time', 'pl-updated'))
    return el
  }

  function updateRow(el, plan, { showProject, nowMs }) {
    const color = deps.projectColor?.(plan.project) ?? ''
    // a custom property reads back as written, so an unchanged color is never rewritten
    if (el.style.getPropertyValue('--pl-project') !== color) {
      if (color) el.style.setProperty('--pl-project', color)
      else el.style.removeProperty('--pl-project')
    }
    const titleEl = el.querySelector('.pl-title')
    setText(titleEl, plan.title)
    // the title ellipsizes on one line; the tooltip holds the whole of it
    setAttr(titleEl, 'title', plan.title)
    const project = showProject ? plan.project : ''
    setText(el.querySelector('.pl-project-name'), project)
    setHidden(el.querySelector('.pl-project'), !project)
    // done of countable; a plan with nothing countable is 0/0 and an empty bar, never NaN
    const pct = plan.countable > 0 ? Math.round((Math.min(plan.done, plan.countable) / plan.countable) * 100) : 0
    const fill = el.querySelector('.pl-bar > i')
    if (fill.style.getPropertyValue('--pl-done') !== `${pct}%`) fill.style.setProperty('--pl-done', `${pct}%`)
    setText(el.querySelector('.pl-count'), `${plan.done}/${plan.countable}`)
    const waiting = plan.waiting > 0 ? `${plan.waiting} ${plan.waiting === 1 ? 'needs' : 'need'} you` : ''
    const waitingEl = el.querySelector('.pl-waiting')
    setText(waitingEl, waiting)
    setHidden(waitingEl, !waiting)
    const rel = plan.updatedMs === null ? '' : relMs(Math.max(0, nowMs - plan.updatedMs))
    const when = rel === 'moments' ? 'just now' : rel && `${rel} ago`
    const timeEl = el.querySelector('.pl-updated')
    setText(timeEl, when)
    setHidden(timeEl, !when)
    setAttr(timeEl, 'datetime', plan.updatedAt ?? '')
    setAttr(timeEl, 'title', plan.updatedAt ? new Date(plan.updatedAt).toLocaleString() : '')
    const label = [plan.title, project, `${plan.done} of ${plan.countable} steps done`, waiting, when && `Updated ${when}`]
      .filter(Boolean)
      // a title that already ends a sentence takes no second period
      .reduce((text, part) => (text ? `${text}${/[.?!…]$/.test(text) ? ' ' : '. '}${part}` : part), '')
    setAttr(el, 'aria-label', label)
  }

  /** @param {import('./plans-lane.js').PlansLaneInput} input */
  function paint({ plans, showProject, nowMs }) {
    const section = mounted
    if (!section?.isConnected) return
    const active = doc.activeElement
    const focusInside = Boolean(active && section.contains(active))
    const hadFocus = focusInside && doc.hasFocus?.() === true
    const byId = new Map(plans.map((plan) => [plan.id, plan]))
    // the model's order, held while the pointer or the keyboard is in the lane: known rows keep
    // their place and new ones join the end. The pin covers every qualifying plan before the cap,
    // so no row drops past six because of a re-sort while the lane is held.
    const ids = plans.map((plan) => plan.id)
    order = (hovered || focusInside) && order.length ? pinLaneOrder(order, ids.map((id) => ({ session: id }))) : ids
    const { shown, more } = capPlans(order)
    const list = section.querySelector('.pl-rows')
    const nodes = shown.map((id) => {
      let el = rowEls.get(id)
      if (!el) {
        el = rowEl(id)
        rowEls.set(id, el)
      }
      updateRow(el, byId.get(id), { showProject, nowMs })
      return el
    })
    const keep = new Set(nodes)
    for (const child of [...list.children]) if (!keep.has(child)) child.remove()
    // only a row out of place moves: a row in place, focused or under the pointer, stays put
    nodes.forEach((el, index) => {
      if (list.children[index] !== el) list.insertBefore(el, list.children[index] ?? null)
    })
    known.clear()
    for (const id of shown) known.add(id)
    for (const id of [...rowEls.keys()]) if (!known.has(id)) rowEls.delete(id)
    if (!known.has(roving)) roving = shown[0] ?? null
    for (const el of nodes) {
      const tab = el.dataset.plPlan === roving ? 0 : -1
      if (el.tabIndex !== tab) el.tabIndex = tab
    }
    setHidden(section.querySelector('.pl-empty'), nodes.length > 0)
    const all = section.querySelector('.pl-all')
    setText(all, more ? `All plans · ${more} more ›` : 'All plans ›')
    setHidden(section.querySelector('.pl-more'), nodes.length === 0)
    // a keyboard user whose row left lands on the heading, only in a window that has focus
    if (hadFocus && (!doc.activeElement || doc.activeElement === doc.body)) section.querySelector('#plansLaneTitle')?.focus({ preventScroll: true })
  }

  return {
    /** The lane, made once: renderDashboard mounts it in the grid after Working and Quiet. */
    element: () => (mounted ??= laneEl()),
    paint,
  }
}
