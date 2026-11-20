// The Dashboard's Needs you lane (dashboard lanes design §3.2): one card per
// attention entry under the Dashboard's lens, in sortRail order, so with All
// projects it holds exactly what the Inbox badge counts, each entry once.
//
// It reads the frame's attention entries and feeds nothing back: no badge,
// count or alert reads it. A card never answers (owner decision 1,
// 2026-11-04): a click or Enter opens the ask in the Inbox's detail panel
// (deps.open), and no action card is mounted here, since DESIGN.md allows one
// per ask, under its Inbox row. Agent text reaches the DOM only through
// textContent, and an unchanged value is never rewritten, so a selection in a
// card survives a poll. Painted from app.js's renderDashboardAmbient, so from
// both render entries; it fetches nothing and runs no timer.
import { isOpenHandoff } from './attention.js'
import { actionPresentation } from './card.js'
import { pinLaneOrder } from './lanes.js'
import { currentAskAt, shortAge } from './rowview.js'
import { hostLabel } from './sessions.js'
import { isReservedProject } from './reserved-projects.js'

export const NEEDS_YOU_EMPTY = 'Nothing in this view is waiting on you.'

/** The ask's id: a plan row's, else the item's (app.js needsEntryId). */
export const laneAskId = (entry) => (entry.kind === 'row' ? entry.row.id : entry.item.id)

// As the Agents card's (#454 A.2): J/K and the arrows move between cards.
const MOVES = { j: 1, k: -1, ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }

/** @param {import('./needs-you-lane.js').NeedsYouLaneDeps} deps (needs-you-lane.d.ts) */
export function installNeedsYouLane(deps) {
  const doc = deps.doc ?? globalThis.document
  let mounted = null
  let order = [] // the ids in the order the last paint drew them
  let roving = null // the card Tab lands on
  let hovered = false
  const cardEls = new Map()
  const byId = new Map() // id → the entry its card opens

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
    const section = make('section', 'dashboard-card needs-you-lane')
    section.setAttribute('aria-labelledby', 'needsYouLaneTitle')
    const head = make('div', 'dashboard-card-head ny-head')
    const title = make('h2', '', 'Needs you')
    title.id = 'needsYouLaneTitle'
    title.tabIndex = -1
    const later = make('button', 'ny-later')
    later.type = 'button'
    later.hidden = true
    later.title = 'Open the Inbox’s Later section'
    later.dataset.dashboardFocusKey = 'ny:later'
    later.addEventListener('click', () => deps.openLater?.())
    const review = make('button', 'ny-review', 'Review queue')
    review.type = 'button'
    review.dataset.shortcutId = 'review'
    review.dataset.dashboardFocusKey = 'ny:review'
    review.addEventListener('click', () => deps.openReview?.())
    head.append(title, later, review)
    const cards = make('div', 'ny-cards')
    cards.setAttribute('role', 'list')
    cards.setAttribute('aria-label', 'Asks waiting on you')
    const empty = make('p', 'ny-empty', NEEDS_YOU_EMPTY)
    empty.hidden = true
    section.append(head, cards, empty)
    // A card under the pointer keeps its place (§2 anti-goals); the next paint after it leaves sorts.
    section.addEventListener('pointerenter', () => { hovered = true })
    section.addEventListener('pointerleave', () => { hovered = false })
    cards.addEventListener('click', onClick)
    section.addEventListener('keydown', onKey)
    return section
  }

  function onClick(event) {
    const target = event.target instanceof doc.defaultView.Element ? event.target : null
    const el = target?.closest('[data-ny-ask]')
    const entry = el ? byId.get(el.dataset.nyAsk) : null
    if (!entry) return
    // never a click that ends a text selection (copy-on-select) or lands on a link
    if (target.closest('button, a, select, summary, [data-link-kind]') || String(doc.getSelection?.() ?? '')) return
    deps.open(entry)
  }

  // §3.1: one roving tab stop; the event stops here, so the Inbox's own J/K and Enter never see it
  function onKey(event) {
    if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return
    const el = event.target instanceof doc.defaultView.Element ? event.target : null
    if (!el?.matches('[data-ny-ask]')) return
    const move = MOVES[event.key.length === 1 ? event.key.toLowerCase() : event.key]
    const entry = byId.get(el.dataset.nyAsk)
    if (!move && (event.key !== 'Enter' || !entry)) return
    event.preventDefault()
    event.stopPropagation()
    if (!move) {
      deps.open(entry)
      return
    }
    const cards = [...mounted.querySelectorAll('[data-ny-ask]')]
    const next = cards[cards.indexOf(el) + move]
    if (next) land(next, false)
  }

  // Moves the roving stop to a card and focuses it.
  function land(el, scroll) {
    roving = el.dataset.nyAsk
    for (const other of mounted.querySelectorAll('[data-ny-ask]')) other.tabIndex = other === el ? 0 : -1
    if (scroll) el.scrollIntoView?.({ block: 'nearest', behavior: scrollBehavior() })
    el.focus({ preventScroll: true })
  }

  function cardEl(id) {
    const el = make('article', 'ny-card')
    el.dataset.nyAsk = id
    el.dataset.dashboardFocusKey = `ny:${id}`
    el.setAttribute('role', 'listitem')
    el.tabIndex = -1
    const meta = make('div', 'ny-meta')
    const dot = make('i', 'ny-dot')
    dot.setAttribute('aria-hidden', 'true')
    meta.append(dot, make('span', 'ny-project'), make('span', 'ny-agent'), make('span', 'ny-branch'), make('span', 'ny-age'), make('span', 'ny-session'), make('b', 'ny-kind', 'Hand-off'), make('b', 'ny-draft', 'Draft'))
    el.append(meta, make('div', 'ny-title'), make('div', 'ny-next'), make('div', 'ny-plan'))
    return el
  }

  function updateCard(el, entry, nowMs) {
    const owner = entry.kind === 'row' ? entry.board : entry.item
    const entity = entry.kind === 'row' ? entry.row : entry.item
    const project = String(owner?.project ?? '')
    // the Inbox row's headline (§3.2): the requested action while it is unanswered, else the title
    const presentation = actionPresentation(entity ?? {})
    const title = String(presentation.headline ?? '')
    const agent = typeof owner?.agent === 'string' && owner.agent ? hostLabel(owner.agent) : ''
    const branch = typeof owner?.stream === 'string' ? owner.stream : ''
    const at = Date.parse(currentAskAt(entry) ?? '')
    const age = Number.isFinite(at) ? shortAge(Math.max(0, nowMs - at)) : ''
    const tag = deps.sessionTag?.(entry) ?? ''
    const step = typeof entity?.next_step === 'string' ? entity.next_step.trim() : ''
    const next = presentation.headlineField !== 'next-step' && step ? step : presentation.detail
    // a row led by its step keeps its label findable here
    const plan = entry.kind === 'row' ? `Plan · ${entry.board?.title ?? ''} · ${presentation.originalTitle}` : ''
    const draft = deps.hasDraft?.(laneAskId(entry)) === true
    const color = deps.projectColor?.(project) ?? ''
    // a custom property reads back as written, so an unchanged color is never rewritten
    if (el.style.getPropertyValue('--ny-project') !== color) {
      if (color) el.style.setProperty('--ny-project', color)
      else el.style.removeProperty('--ny-project')
    }
    for (const [cls, text] of [['.ny-project', project], ['.ny-agent', agent], ['.ny-branch', branch], ['.ny-age', age], ['.ny-session', tag]]) {
      const part = el.querySelector(cls)
      setText(part, text)
      setHidden(part, !text)
    }
    setHidden(el.querySelector('.ny-draft'), !draft)
    // issue #612: a done item the server stored as a hand-off; every other ask is a question or a plan step
    const handoff = entry.kind === 'item' && isOpenHandoff(entity)
    setHidden(el.querySelector('.ny-kind'), !handoff)
    const titleEl = el.querySelector('.ny-title')
    setText(titleEl, title)
    // as the Inbox row's: the title the agent wrote, under a headline that is its step
    if (titleEl.title !== presentation.originalTitle) titleEl.title = presentation.originalTitle
    // an app session's approval is a tool line (#412), while that line is the headline
    const mono = entry.kind === 'item' && isReservedProject(project) && presentation.headlineField === 'title'
    if (titleEl.classList.contains('mono') !== mono) titleEl.classList.toggle('mono', mono)
    const nextEl = el.querySelector('.ny-next')
    setText(nextEl, next)
    setHidden(nextEl, !next)
    const planEl = el.querySelector('.ny-plan')
    setText(planEl, plan)
    setHidden(planEl, !plan)
    const label = [handoff && 'Hand-off', title, [project, agent, branch].filter(Boolean).join(' · '), age && `asked ${age === 'now' ? 'just now' : `${age} ago`}`, tag, draft && 'unsent draft']
      .filter(Boolean)
      // a headline that is a step already ends in a period
      .reduce((text, part) => (text ? `${text}${/[.?!…]$/.test(text) ? ' ' : '. '}${part}` : part), '')
    setAttr(el, 'aria-label', label)
  }

  /** @param {{entries: any[], later: number, nowMs: number}} input */
  function paint({ entries, later = 0, nowMs }) {
    const section = mounted
    if (!section?.isConnected) return
    const active = doc.activeElement
    const focusInside = Boolean(active && section.contains(active))
    const hadFocus = focusInside && doc.hasFocus?.() === true
    byId.clear()
    for (const entry of entries) byId.set(laneAskId(entry), entry)
    // sortRail's order, held while the pointer or the keyboard is in the lane: known cards keep their place
    const ids = entries.map(laneAskId)
    order = (hovered || focusInside) && order.length ? pinLaneOrder(order, ids.map((id) => ({ session: id }))) : ids
    const list = section.querySelector('.ny-cards')
    const nodes = order.map((id) => {
      let el = cardEls.get(id)
      if (!el) {
        el = cardEl(id)
        cardEls.set(id, el)
      }
      updateCard(el, byId.get(id), nowMs)
      return el
    })
    const keep = new Set(nodes)
    for (const child of [...list.children]) if (!keep.has(child)) child.remove()
    // only a card out of place moves: a card in place, focused or under the pointer, stays put
    nodes.forEach((el, index) => {
      if (list.children[index] !== el) list.insertBefore(el, list.children[index] ?? null)
    })
    for (const id of [...cardEls.keys()]) if (!byId.has(id)) cardEls.delete(id)
    if (!byId.has(roving)) roving = order[0] ?? null
    for (const el of nodes) {
      const tab = el.dataset.nyAsk === roving ? 0 : -1
      if (el.tabIndex !== tab) el.tabIndex = tab
    }
    setHidden(section.querySelector('.ny-empty'), nodes.length > 0)
    const laterEl = section.querySelector('.ny-later')
    const n = Number(later) || 0
    setText(laterEl, n ? `Later ${n} ›` : '')
    setHidden(laterEl, !n)
    // a keyboard user whose card left lands on the heading, only in a window that has focus
    if (hadFocus && (!doc.activeElement || doc.activeElement === doc.body)) section.querySelector('#needsYouLaneTitle')?.focus({ preventScroll: true })
  }

  return {
    /** The lane, made once: renderDashboard mounts it above the Dashboard grid. */
    element: () => (mounted ??= laneEl()),
    paint,
    /** The Needs you chip (§3.1): scrolls the lane in and focuses its first card, else its heading. */
    focusFirst() {
      if (!mounted) return
      mounted.scrollIntoView?.({ block: 'start', behavior: scrollBehavior() })
      const first = mounted.querySelector('[data-ny-ask]')
      if (first) land(first, false)
      else mounted.querySelector('#needsYouLaneTitle')?.focus({ preventScroll: true })
    },
    /** Focuses one ask's card, moving the roving stop to it; false when the lane does not show it. */
    focusAsk(id, { scroll = true } = {}) {
      const el = mounted ? [...mounted.querySelectorAll('[data-ny-ask]')].find((card) => card.dataset.nyAsk === id) : null
      if (!el) return false
      land(el, scroll)
      return true
    },
  }
}
