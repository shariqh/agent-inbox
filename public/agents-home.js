// The Dashboard's Working and Quiet lanes (dashboard lanes design §3.3, §3.4),
// grown from the Agents home (#454, design
// docs/superpowers/specs/2026-11-04-agents-home-design.md §3): Working holds a
// card per session with live work, grouped by project; Quiet a compact table
// row per idle, quiet or parked session, with the folds for the ended, the
// dormant, the closed projects' sessions and the messages not delivered at its
// end. One module paints both: they share the cards' state, clicks, keys and
// folds. It also builds New session…, which the page head shows (§3.1).
//
// It reads what the frame already read (sessions.js builds the cards and
// splits the lanes) and never feeds attention: a card's "Asking you · N" chip
// READS the frame's attention entries (its asks show in the Needs you lane,
// §3.3), and nothing here reaches public/attention.js, a badge, a count, the
// rail or the dock. It fetches nothing and runs no timer; a working card pulses
// once on a new call, through the page's one-shot (#304). Agent text reaches
// the DOM only through textContent. Painted from app.js's
// renderDashboardAmbient, so from both render entries. The Mesh agents section
// (public/mesh-section.js) sits in Quiet after its rows, outside every lens.
import { groupCards, laneCounts, laneOf, messageHint, sessionCards, splitLanes } from './sessions.js'
import { forgettable } from './launches.js'
import { pinLaneOrder, tracePath } from './lanes.js'
import { placeLine } from './place.js'
import { installMeshAgents } from './mesh-section.js'

const SVG = 'http://www.w3.org/2000/svg'
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
// A launch's panel is keyed by the launch, which outlives its sessions; any
// other card by its session.
const panelKey = (card) => (card.launch ? card.id : card.session)
const askId = (entry) => (entry?.kind === 'row' ? entry.row?.id : entry?.item?.id) ?? null
export const SESSIONS_EMPTY = 'No sessions yet. A Claude Code or Copilot session appears here once Agent Inbox’s MCP server starts in it.'
export const WORKING_EMPTY = 'No session in this view is working.'
export const QUIET_EMPTY = 'No session in this view is quiet.'
export const READING = 'Reading sessions…'
const LANES = [['working', 'Working'], ['quiet', 'Quiet']]
// the Quiet table's columns (§3.4); the last is the row's actions
const COLUMNS = ['State', 'Session', 'Branch', 'Last caption', 'Since', '']

/** @param {import('./agents-home.js').AgentsHomeDeps} deps (agents-home.d.ts) */
/**
 * Moves a node with `move()`, keeping focus held inside it: moving a focused
 * node drops its focus, so the focused element (and a text control's caret
 * and selection) come back after, only in a window that has focus (#463 review).
 * @param {Element} node @param {() => void} move
 */
export function moveKeepingFocus(node, move) {
  const doc = node.ownerDocument
  const active = doc.activeElement
  const held = active && active !== node.ownerDocument.body && node.contains(active) ? active : null
  let range = null
  try {
    if (held && typeof held.selectionStart === 'number') range = [held.selectionStart, held.selectionEnd, held.selectionDirection]
  } catch { range = null }
  move()
  if (!held?.isConnected || doc.activeElement === held || !doc.hasFocus?.()) return
  held.focus({ preventScroll: true })
  if (range) held.setSelectionRange(...range)
}

export function installAgentsHome(deps) {
  const doc = deps.doc ?? globalThis.document
  // Window-local view state, never persisted and read by no attention surface.
  const folds = new Set()
  // §3.3 Order: each lane's own pinned order, and Working's project groups
  const order = { working: [], quiet: [], groups: [] }
  const hovered = { working: false, quiet: false }
  const roving = { working: null, quiet: null } // the card or row Tab lands on, per lane
  let last = null
  // Working's and the folds' cards, and Quiet's rows, apart: a session that
  // changes lane gets a node of its new lane's shape, never the old one
  const cardEls = new Map()
  const rowEls = new Map()
  const groupEls = new Map()
  const calls = new Map() // card id → the last call a paint has seen, for the one-shot pulse
  const byId = new Map() // card id → the card its buttons act on
  // global: no lens narrows it, and it shows in Quiet with no session at all
  const mesh = installMeshAgents({ doc, onRefresh: () => deps.refreshMesh?.(), onChange: () => repaint(), onOpen: (key, name) => deps.openMeshAgent?.(key, name) })

  const make = (tag, className, text) => {
    const el = doc.createElement(tag)
    if (className) el.className = className
    if (text !== undefined) el.textContent = text
    return el
  }
  const setText = (el, text) => { if (el.textContent !== text) el.textContent = text }
  const setHidden = (el, hidden) => { if (el.hidden !== hidden) el.hidden = hidden }
  const setAttr = (el, name, value) => { if (el.getAttribute(name) !== value) el.setAttribute(name, value) }
  const button = (text, className, focusKey) => {
    const el = make('button', className, text)
    el.type = 'button'
    if (focusKey) el.dataset.dashboardFocusKey = focusKey
    return el
  }
  const repaint = (overrides = {}) => {
    if (!last) return
    paint(last.host, { ...last.input, ...overrides })
    deps.afterRepaint?.()
  }
  const laneEl = (kind) => mounted?.querySelector(`[data-ah-lane="${kind}"]`) ?? null
  const titleOf = (kind) => laneEl(kind)?.querySelector('h2') ?? null
  // A narrow window's session panel sits in a lane's or fold's list, after its
  // card or row (app.js placeFocusPanel): before that list is removed, hidden
  // or folded away, the panel steps out after the lanes, into the split (§3.6),
  // so it is never cut off with it.
  const release = (el) => {
    for (const child of el.querySelectorAll('.ah-cards > :not([data-session-card]), .qt-rows > :not([data-session-card]):not(.qt-head)')) {
      if (mounted) moveKeepingFocus(child, () => mounted.after(child))
    }
  }
  const focusKeyIn = (el) => (el.contains(doc.activeElement) ? doc.activeElement?.closest?.('[data-dashboard-focus-key]')?.dataset.dashboardFocusKey ?? null : null)
  const refocus = (root, key) => {
    if (!key || !doc.hasFocus?.() || root.contains(doc.activeElement)) return
    // matched by value, never through a selector built from agent text
    ;[...root.querySelectorAll('[data-dashboard-focus-key]')].find((el) => el.dataset.dashboardFocusKey === key)?.focus({ preventScroll: true })
  }
  // Rebuild one part of a card only when what it shows changed, keeping a
  // keyboard user on the same control.
  const rebuild = (el, key, build) => {
    if (el.dataset.key === key) return
    el.dataset.key = key
    const focusKey = focusKeyIn(el)
    el.replaceChildren(...build())
    refocus(el, focusKey)
  }

  function emptyEl() {
    const empty = make('div', 'ah-empty')
    const icon = doc.createElementNS(SVG, 'svg')
    icon.setAttribute('class', 'dashboard-empty-icon')
    icon.setAttribute('viewBox', '0 0 24 24')
    icon.setAttribute('aria-hidden', 'true')
    for (const [tag, attrs] of [['circle', { cx: 12, cy: 12, r: 4 }], ['path', { d: 'M12 2v4M12 18v4M2 12h4M18 12h4' }]]) {
      const shape = doc.createElementNS(SVG, tag)
      for (const [name, value] of Object.entries(attrs)) shape.setAttribute(name, String(value))
      icon.append(shape)
    }
    empty.append(icon, make('p', 'ah-empty-text', SESSIONS_EMPTY))
    empty.hidden = true
    return empty
  }

  function foldsEl() {
    const foldRow = make('div', 'ah-folds')
    foldRow.hidden = true
    for (const [key, cls] of [['ended', 'ah-fold-ended'], ['dormant', 'ah-fold-dormant'], ['closed', 'ah-fold-closed']]) {
      const fold = make('details', `ah-fold ${cls}`)
      fold.dataset.ahFold = key
      fold.hidden = true
      const summary = make('summary')
      summary.dataset.dashboardFocusKey = `ah:fold:${key}`
      fold.append(summary, make('div', 'ah-cards'))
      if (key === 'ended') {
        const earlier = make('details', 'ah-fold ah-fold-earlier')
        earlier.dataset.ahFold = 'earlier'
        const more = make('summary')
        more.dataset.dashboardFocusKey = 'ah:fold:earlier'
        earlier.append(more, make('div', 'ah-cards'))
        fold.append(earlier)
      }
      foldRow.append(fold)
    }
    foldRow.append(make('div', 'ah-undelivered'))
    // A fold's open state is window-local; opening one paints the cards it holds
    foldRow.addEventListener('toggle', (event) => {
      const fold = event.target
      if (!(fold instanceof doc.defaultView.HTMLDetailsElement) || !fold.dataset.ahFold) return
      if (fold.open === folds.has(fold.dataset.ahFold)) return
      if (fold.open) folds.add(fold.dataset.ahFold)
      else folds.delete(fold.dataset.ahFold)
      repaint()
    }, true)
    return foldRow
  }

  function homeEl() {
    // the two lanes, after Needs you (§3.3, §3.4); the session panel sits after this wrapper, in the split (§3.6)
    const home = make('div', 'agents-home')
    for (const [kind, name] of LANES) {
      const section = make('section', `dashboard-card ah-lane ${kind}-lane`)
      section.dataset.ahLane = kind
      section.setAttribute('aria-labelledby', `${kind}LaneTitle`)
      const head = make('div', 'dashboard-card-head ah-lane-head')
      const title = make('h2', '', name)
      title.id = `${kind}LaneTitle`
      title.tabIndex = -1
      head.append(title)
      // a quiet line, and the header kept, so the page does not jump (§3.3, §3.4)
      const none = make('p', 'ah-lane-empty')
      none.hidden = true
      if (kind === 'working') {
        // the launches the project and agent lens hides, so a session started elsewhere is never lost
        const outside = make('p', 'ah-outside')
        outside.hidden = true
        const showAll = button('Show all', 'ah-outside-all', 'ah:outside-all')
        showAll.addEventListener('click', () => deps.showAll?.())
        outside.append(make('span', 'ah-outside-text'), doc.createTextNode(' · '), showAll)
        section.append(head, outside, make('div', 'ah-groups'), emptyEl(), none)
      } else {
        // a list, not a table: below 1280px the session panel opens between its rows (§3.4)
        const rows = make('div', 'qt-rows')
        rows.setAttribute('role', 'list')
        rows.setAttribute('aria-label', 'Quiet sessions')
        rows.hidden = true
        const columns = make('div', 'qt-head')
        columns.setAttribute('aria-hidden', 'true')
        columns.append(...COLUMNS.map((text) => make('span', '', text)))
        rows.append(columns)
        section.append(head, rows, none, make('div', 'ah-mesh'), foldsEl())
      }
      // a card or row under the pointer keeps its place in its lane (§2 anti-goals, §3.3 Order)
      section.addEventListener('pointerenter', () => { hovered[kind] = true })
      section.addEventListener('pointerleave', () => { hovered[kind] = false })
      home.append(section)
    }
    home.addEventListener('click', onClick)
    home.addEventListener('keydown', onKey)
    return home
  }

  function onClick(event) {
    const target = event.target instanceof doc.defaultView.Element ? event.target : null
    const el = target?.closest('[data-session-card]')
    const card = el ? byId.get(el.dataset.sessionCard) : null
    if (!card) return
    // "Asking you · N" goes to the session's first ask in Needs you (dashboard lanes design §3.3):
    // not a card action, so it never reaches a launch's
    if (target.closest('.sc-asking')) {
      deps.showAsk?.(askId(card.asks[0]))
      return
    }
    const control = target.closest('[data-ah-action]')
    if (control) {
      if (control.disabled) return
      const action = control.dataset.ahAction
      // Open, the lanes' main action (§3.3, §3.4), and the session panel's parts: the composer,
      // the transcript and Resume and send. Never a launch's own action, launch cards included.
      if (action === 'open') deps.openSession(panelKey(card), 'head')
      else if (action === 'message' || action === 'transcript' || action === 'resume') deps.openSession(panelKey(card), action)
      else if (card.launch) deps.launchAction?.(card.launch.id, action)
      return
    }
    // A click anywhere else on the card opens it, but never one that ends a
    // text selection or lands on a control.
    if (target.closest('button, a, select, summary, [data-link-kind]') || String(doc.getSelection?.() ?? '')) return
    deps.openSession(panelKey(card))
  }

  // #454 A.2, §3.1: on a card or row itself (never its controls), J/K and the
  // arrows move within its lane, one tabbable per lane, and Enter opens its panel.
  const MOVES = { j: 1, k: -1, ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }
  function onKey(event) {
    if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return
    const el = event.target instanceof doc.defaultView.Element ? event.target : null
    if (!el?.matches('[data-session-card]')) return
    const move = MOVES[event.key.length === 1 ? event.key.toLowerCase() : event.key]
    const card = byId.get(el.dataset.sessionCard)
    if (!move && (event.key !== 'Enter' || !card)) return
    event.preventDefault()
    event.stopPropagation()
    if (!move) {
      deps.openSession(panelKey(card), 'head')
      return
    }
    const lane = el.closest('[data-ah-lane]')
    const cards = [...lane.querySelectorAll('[data-session-card]')]
    const next = cards[cards.indexOf(el) + move]
    if (!next) return
    land(lane.dataset.ahLane, next)
    // a key move reveals the card it lands on, as a chip does and as the Needs you lane's keys do
    next.scrollIntoView?.({ block: 'nearest', behavior: deps.scrollBehavior?.() ?? 'auto' })
  }

  // Moves a lane's roving stop to one of its cards or rows and focuses it.
  function land(kind, el) {
    roving[kind] = el.dataset.sessionCard
    for (const other of laneEl(kind).querySelectorAll('[data-session-card]')) other.tabIndex = other === el ? 0 : -1
    el.focus({ preventScroll: true })
  }

  // ── a card ────────────────────────────────────────────────────────────────
  function cardEl(id) {
    const el = make('article', 'sc')
    el.dataset.sessionCard = id
    el.setAttribute('role', 'listitem')
    // focusable by a key or a chip, while Tab reaches only the lane's roving stop
    el.tabIndex = -1
    const top = make('div', 'sc-top')
    const dot = make('span', 'sc-dot')
    dot.setAttribute('aria-hidden', 'true')
    top.append(dot, make('span', 'sc-state'), make('span', 'sc-chips'), make('span', 'sc-when'))
    // "Asking you · N" (dashboard lanes design §3.3): the asks themselves are in Needs you
    const ask = askingEl()
    // the foot's facts and its buttons are rebuilt apart, so a new call never replaces a focused button
    const foot = make('div', 'sc-foot')
    foot.append(make('div', 'sc-facts'), make('div', 'sc-actions'))
    el.append(top, make('div', 'sc-doing'), make('div', 'sc-where'), ask, foot)
    return el
  }

  function askingEl() {
    const ask = button('', 'sc-asking')
    ask.title = 'Show in Needs you'
    ask.hidden = true
    return ask
  }

  function worktreeKept(card) {
    const launch = card.launch
    return launch?.status === 'ended' && typeof launch.worktree_path === 'string' && launch.worktree_path !== '' && !launch.worktree_removed_at
  }

  // V1 (#454 A.3): the agent kind as plain text, an outlined "A" for a session
  // started here, the branch; build hints are the panel's and the Sessions line's.
  function metaOf(card, { branch = true } = {}) {
    const parts = [['sc-agent', card.host, `${card.host} · ${card.origin}`]]
    if (card.origin === 'started here') parts.push(['sc-here', 'A', 'Started here, in Agent Inbox'])
    else if (card.origin === 'driven') parts.push(['sc-origin', 'driven', 'Driven by another app'])
    if (branch && card.branch) parts.push(['sc-branch', card.branch, card.branch])
    return parts
  }
  const partsOf = (meta) => meta.map(([cls, text, title]) => {
    const part = make('span', cls, text)
    if (title) part.title = title
    return part
  })

  // The state's main action (§2), and Message on a session that can take one.
  // In a lane, a working or idle session's main action is Open, its panel
  // (§3.3, §3.4); a fold's cards keep the actions they had. `hint` says when a
  // Message reaches the session, on a Quiet row, whose one line has no room for it.
  function actionsOf(card, granted, { open = false, hint = '' } = {}) {
    const out = []
    // #586: the Terminal buttons keep the generic word; the title and accessible name say which app opens
    const app = deps.launches?.()?.terminalName?.() ?? 'Terminal'
    const named = (label) => (app === 'Terminal' ? '' : `${label} (${app})`)
    const session = card.session
    if (open && (card.base === 'working' || card.base === 'idle')) out.push(['open', 'Open', 'Open this session’s panel'])
    const message = () => {
      if (!session) return
      const draft = deps.hasDraft?.(session) === true
      const title = draft ? 'Message this session: your unsent draft is kept' : 'Message this session'
      out.push(['message', draft ? 'Message · draft' : 'Message', hint ? `${title}. ${hint}` : title])
    }
    if (!card.launch) {
      message()
      return out
    }
    const has = (action) => card.status.actions.includes(action)
    switch (card.base) {
      case 'failed': out.push(['transcript', 'Details', 'Why it didn’t start: its transcript']); break
      case 'lost': out.push(granted && has('close') ? ['close', 'Close', 'Close this launch: its driver has stopped'] : ['transcript', 'Transcript', '']); break
      case 'starting': case 'stopping': out.push(['transcript', 'Transcript', '']); break
      case 'working': case 'idle': message(); break
      case 'parked':
        if (granted && has('takeover')) out.push(['take-over', 'Take over in Terminal', `Go on with this session in Copilot in ${app}`, '', named('Take over in Terminal')])
        out.push(granted && has('resume') ? ['resume', 'Resume…', 'Resume this session with a message', 'primary'] : ['transcript', 'Transcript', ''])
        break
      case 'terminal': out.push(granted && has('terminal') ? ['take-over', 'Resume in Terminal', `Open ${app} on this session again`, '', named('Resume in Terminal')] : ['transcript', 'Transcript', '']); break
      default:
        out.push(granted && card.launch.worktree_path && !card.launch.worktree_removed_at
          ? ['open-worktree', 'Open in Terminal', `Open ${app} in this session’s worktree`, '', named('Open in Terminal')] : ['transcript', 'Transcript', ''])
    }
    // an ended launch's kept worktree is removed from its card too: main checks it and asks first (#432)
    if (granted && worktreeKept(card)) out.push(['remove-worktree', 'Remove worktree…', 'Remove this session’s worktree: its branch is kept'])
    // #478: an ended launch with no worktree left, stopped ones that can resume included
    if (granted && forgettable(card.launch)) out.push(['forget', 'Forget…', 'Forget this session: its card, transcript and logs'])
    return out
  }

  function paintActions(el, card, actions) {
    rebuild(el, JSON.stringify(actions), () => actions.map(([action, label, title, tone, aria]) => {
      const control = button(label, `sc-action${tone ? ` ${tone}` : ''}`, `sc:${card.id}:${action}`)
      control.dataset.ahAction = action
      if (title) control.title = title
      if (aria) control.setAttribute('aria-label', aria)
      return control
    }))
  }

  // What a card and a row share: the state's tone, the panel's mark, the asks' chip.
  function updateShared(el, card) {
    // classList, never className: a running one-shot (.pulse) survives the paint
    for (const name of [...el.classList]) if (name.startsWith('tone-') && name !== `tone-${card.state}`) el.classList.remove(name)
    if (!el.classList.contains(`tone-${card.state}`)) el.classList.add(`tone-${card.state}`)
    const selected = Boolean(last?.input.selected) && cardFor(last.input.selected) === card
    if (el.classList.contains('sel') !== selected) el.classList.toggle('sel', selected)
    if (el.classList.contains('quiet') !== Boolean(card.quiet)) el.classList.toggle('quiet', Boolean(card.quiet))
    setText(el.querySelector('.sc-state'), card.label)
    setText(el.querySelector('.sc-when'), card.recency)
    const doing = el.querySelector('.sc-doing')
    setText(doing, card.line)
    const was = Boolean(card.historical)
    if (doing.classList.contains('was') !== was) doing.classList.toggle('was', was)
    if (doing.title !== card.line) doing.title = card.line
    const asking = el.querySelector('.sc-asking')
    setHidden(asking, !card.asks.length)
    setText(asking, card.asks.length ? `Asking you · ${card.asks.length}` : '')
    // a key of its own, so a focused chip comes back after a card rebuild
    if (asking.dataset.dashboardFocusKey !== `sc:${card.id}:asking`) asking.dataset.dashboardFocusKey = `sc:${card.id}:asking`
  }

  function updateCard(el, card, granted, { open = false } = {}) {
    updateShared(el, card)
    // written only on a change, so an unchanged paint writes nothing at all
    setAttr(el, 'aria-label', `${card.label}: ${card.host} in ${card.project}${card.branch ? ` on ${card.branch}` : ''}`)
    const meta = metaOf(card)
    rebuild(el.querySelector('.sc-chips'), JSON.stringify(meta), () => partsOf(meta))
    // V2: a secondary line under what it is doing: the worktree and a working
    // session's plan bar, else when a message reaches it
    const busy = card.state === 'working'
    const hint = busy || card.launch ? null : messageHint(card.row)
    const where = el.querySelector('.sc-where')
    // #617: where it runs ("machine · desk"), first; a row with none of the fields adds nothing, not even to the key
    const place = placeLine(card.row)
    rebuild(where, JSON.stringify(place ? [card.worktree, busy && card.plan, hint, place] : [card.worktree, busy && card.plan, hint]), () => {
      const parts = []
      if (place) {
        const mark = make('span', 'sc-place', place)
        mark.title = place
        parts.push(mark)
      }
      if (card.worktree) parts.push(make('span', 'sc-worktree', card.worktree))
      if (busy && card.plan) {
        const { segments, done, countable, title } = card.plan
        const plan = make('span', 'sc-meta sc-plan')
        const bar = make('span', 'sc-bar')
        bar.setAttribute('role', 'img')
        bar.setAttribute('aria-label', `${title}: ${done} done, ${segments.partial} in progress, ${segments.waiting} waiting on you, ${segments.todo} to do`)
        for (const [name, value] of Object.entries(segments)) {
          if (!value) continue
          const segment = make('span')
          segment.dataset.seg = name
          segment.style.flexGrow = String(value)
          bar.append(segment)
        }
        const planText = make('span', 'sc-plan-text', `${done}/${countable} ${title}`)
        planText.title = planText.textContent
        plan.append(bar, planText)
        parts.push(plan)
      }
      if (hint) {
        const words = make('span', 'sc-meta', hint)
        words.title = hint
        parts.push(words)
      }
      return parts
    })
    setHidden(where, !where.childElementCount)
    const actions = actionsOf(card, granted, { open })
    const foot = el.querySelector('.sc-foot')
    const trace = busy ? card.trace ?? [] : []
    const callCount = trace.reduce((sum, count) => sum + count, 0)
    const facts = foot.querySelector('.sc-facts')
    const buttons = foot.querySelector('.sc-actions')
    rebuild(facts, JSON.stringify([busy && card.children, trace]), () => {
      const parts = []
      if (busy && card.children.length) {
        const kids = make('span', 'sc-meta sc-kids', `▸ ${plural(card.children.length, 'subagent')}`)
        kids.title = card.children
          .map((child) => `${child.doing ? `${child.name}: ${child.doing}` : child.name}${child.state ? ` (${child.state})` : ''}`).join('\n')
        parts.push(kids)
      }
      if (callCount) {
        const svg = doc.createElementNS(SVG, 'svg')
        svg.setAttribute('class', 'sc-spark')
        svg.setAttribute('viewBox', '0 0 60 12')
        svg.setAttribute('preserveAspectRatio', 'none')
        svg.setAttribute('role', 'img')
        svg.setAttribute('aria-label', `${plural(callCount, 'MCP call')} in the last 30 minutes`)
        const path = doc.createElementNS(SVG, 'path')
        path.setAttribute('d', tracePath(trace))
        svg.append(path)
        parts.push(svg)
      }
      return parts
    })
    paintActions(buttons, card, actions)
    setHidden(foot, !facts.childElementCount && !buttons.childElementCount)
  }

  // ── a Quiet row (§3.4): state, session, branch, last caption, since, action ──
  function rowEl(id) {
    const el = make('div', 'qt-row')
    el.dataset.sessionCard = id
    el.setAttribute('role', 'listitem')
    el.tabIndex = -1
    const state = make('span', 'qt-state')
    const dot = make('span', 'sc-dot')
    dot.setAttribute('aria-hidden', 'true')
    state.append(dot, make('span', 'sc-state'))
    const caption = make('span', 'qt-caption')
    caption.append(askingEl(), make('span', 'sc-doing'))
    const since = make('span', 'qt-since')
    since.append(make('span', 'sc-when'))
    const act = make('span', 'qt-act')
    act.append(make('span', 'sc-actions'))
    el.append(state, make('span', 'qt-session'), make('span', 'qt-branch'), caption, since, act)
    return el
  }

  function updateRow(el, card, granted) {
    updateShared(el, card)
    const color = deps.projectColor?.(card.project) ?? ''
    // a custom property reads back as written, so an unchanged colour is never rewritten
    if (el.style.getPropertyValue('--ah-group') !== color) {
      if (color) el.style.setProperty('--ah-group', color)
      else el.style.removeProperty('--ah-group')
    }
    // every column, since the header row is hidden from assistive tech
    // (§3.4): the origin mark from Session and the worktree from Branch included
    const origin = card.origin === 'started here' || card.origin === 'driven' ? ` (${card.origin})` : ''
    const where = `${card.branch ? ` on ${card.branch}` : ''}${card.worktree ? ` (${card.worktree})` : ''}`
    setAttr(el, 'aria-label', [`${card.label}: ${card.host}${origin} in ${card.project}${where}`, card.line, card.recency].filter(Boolean).join('. '))
    const meta = metaOf(card, { branch: false })
    rebuild(el.querySelector('.qt-session'), JSON.stringify([card.project, meta]), () => {
      const dot = make('i', 'qt-dot')
      dot.setAttribute('aria-hidden', 'true')
      return [dot, make('span', 'qt-project', card.project), ...partsOf(meta)]
    })
    rebuild(el.querySelector('.qt-branch'), JSON.stringify([card.branch, card.worktree]), () => [
      ...(card.branch ? partsOf([['sc-branch', card.branch, card.branch]]) : []),
      ...(card.worktree ? [make('span', 'sc-worktree', card.worktree)] : []),
    ])
    // #617: where it runs, after the caption, muted; a row with none of the fields adds no node
    const caption = el.querySelector('.qt-caption')
    const place = placeLine(card.row)
    const mark = caption.querySelector('.sc-place')
    if (!place) mark?.remove()
    else if (!mark) {
      const added = make('span', 'sc-place', place)
      added.title = place
      caption.append(added)
    } else {
      setText(mark, place)
      if (mark.title !== place) mark.title = place
    }
    const hint = card.launch ? '' : messageHint(card.row)
    paintActions(el.querySelector('.sc-actions'), card, actionsOf(card, granted, { open: true, hint }))
  }

  function paintCards(container, cards, granted, { pulse = new Set(), rows = false, open = false } = {}) {
    const els = rows ? rowEls : cardEls
    const nodes = cards.map((card) => {
      let el = els.get(card.id)
      if (!el) {
        el = rows ? rowEl(card.id) : cardEl(card.id)
        els.set(card.id, el)
      }
      if (rows) updateRow(el, card, granted)
      else updateCard(el, card, granted, { open })
      if (pulse.has(card.id)) deps.pulse?.(el)
      return el
    })
    // the cards are ordered among themselves: another child (the session panel
    // placed under its card's row in a narrow window, the Quiet table's header) keeps its place
    const keep = new Set(nodes)
    for (const child of [...container.children]) if (child.dataset.sessionCard && !keep.has(child)) child.remove()
    let previous = null
    for (const el of nodes) {
      let next = previous ? previous.nextElementSibling : container.firstElementChild
      while (next && !next.dataset.sessionCard) next = next.nextElementSibling
      if (next !== el) container.insertBefore(el, next)
      previous = el
    }
  }

  function paintFold(section, key, cards, summary, granted) {
    const fold = section.querySelector(`[data-ah-fold="${key}"]`)
    const summaryEl = fold.querySelector(':scope > summary')
    rebuild(summaryEl, JSON.stringify(summary), () => summary.map(([text, strong]) => (strong ? make('b', '', text) : doc.createTextNode(text))))
    const open = folds.has(key)
    if (!open) release(fold)
    if (fold.open !== open) fold.open = open
    fold.classList.toggle('open', open)
    // a closed fold keeps no cards: nothing it hides is painted
    paintCards(fold.querySelector(':scope > .ah-cards'), open ? cards : [], granted)
    return fold
  }

  // §3.3 Order: a lane's cards keep their place between forced paints, and
  // through a forced one while the pointer or the keyboard is in that lane. A
  // card that changes lane simply leaves one list and joins the other.
  const pin = (previous, ids, held) => pinLaneOrder(held ? previous : [], ids.map((id) => ({ session: id })))
  const byRank = (ids) => {
    const rank = new Map(ids.map((id, index) => [id, index]))
    return (a, b) => rank.get(a) - rank.get(b)
  }

  /**
   * @param {Element} host `#dashboard .dashboard`, once its grid is mounted
   * @param {import('./agents-home.js').AgentsHomeInput} input
   */
  function paint(host, input) {
    last = { host, input }
    const home = host?.querySelector('.dashboard-grid .agents-home')
    if (!home) return
    const workingLane = home.querySelector('.working-lane')
    const quietLane = home.querySelector('.quiet-lane')
    // a keyboard user whose card leaves lands on its lane's heading, only in a window that has focus
    const focusLane = home.contains(doc.activeElement) ? doc.activeElement.closest('[data-ah-lane]')?.dataset.ahLane ?? null : null
    const hadFocus = Boolean(focusLane) && doc.hasFocus?.() === true
    const reading = !Array.isArray(input.activity)
    // the session panel reads these too (cardFor)
    const cards = reading ? [] : sessionCards(input)
    byId.clear()
    for (const card of cards) byId.set(card.id, card)
    home.classList.toggle('reading', reading)
    mesh.paint(quietLane.querySelector('.ah-mesh'), input.mesh ?? null, input.nowMs, input.meshOpen ?? null)
    const workingNone = workingLane.querySelector('.ah-lane-empty')
    const quietNone = quietLane.querySelector('.ah-lane-empty')
    if (reading) {
      // before the first /api/activity read (§3.6): the chips say "…"
      lanes = null
      setText(workingNone, READING)
      setHidden(workingNone, false)
      setHidden(quietNone, true)
      setHidden(workingLane.querySelector('.ah-empty'), true)
      return
    }
    const launchUi = deps.launches?.() ?? null
    const granted = launchUi?.granted() === true
    const { working, quiet } = splitLanes(cards)
    // one count per lane: the same split the lanes draw (§3.1)
    lanes = laneCounts(cards)
    paintNewSession(launchUi)
    const hidden = Number(input.outside) || 0
    setText(workingLane.querySelector('.ah-outside-text'), hidden ? `${plural(hidden, 'session')} outside this filter` : '')
    setHidden(workingLane.querySelector('.ah-outside'), !hidden)

    // the one-shot pulse: a real call since the last paint, on a drawn working card
    const main = [...working, ...quiet]
    const pulse = new Set()
    for (const card of working) {
      const seen = calls.get(card.id)
      if (seen !== undefined && Date.parse(card.lastCallAt ?? '') > Date.parse(seen ?? '')) pulse.add(card.id)
    }
    calls.clear()
    for (const card of main) calls.set(card.id, card.lastCallAt)

    const held = (kind) => !input.forced || hovered[kind] || focusLane === kind
    // Working: cards by their pinned order, in project groups whose order is pinned too,
    // so a card leaving never swaps the groups under the pointer
    order.working = pin(order.working, working.map((card) => card.id), held('working'))
    const cardRank = byRank(order.working)
    working.sort((a, b) => cardRank(a.id, b.id))
    const groups = groupCards(working)
    order.groups = pin(order.groups, groups.map((group) => group.key), held('working'))
    const groupRank = byRank(order.groups)
    groups.sort((a, b) => groupRank(a.key, b.key))
    const list = workingLane.querySelector('.ah-groups')
    const keep = new Set(groups.map((group) => group.key))
    for (const [key, el] of groupEls) {
      if (!keep.has(key)) {
        release(el)
        el.remove()
        groupEls.delete(key)
      }
    }
    const groupNodes = groups.map((group) => {
      let el = groupEls.get(group.key)
      if (!el) {
        el = make('div', 'ah-group')
        const head = make('div', 'ah-group-head')
        const dot = make('i')
        dot.setAttribute('aria-hidden', 'true')
        head.append(dot, make('span', 'ah-group-name'), make('small', 'ah-group-count'))
        const cardsEl = make('div', 'ah-cards')
        cardsEl.setAttribute('role', 'list')
        el.append(head, cardsEl)
        groupEls.set(group.key, el)
      }
      setText(el.querySelector('.ah-group-name'), group.label)
      // sessions only: the Needs you chip counts the asks, once (dashboard lanes design §3.1)
      setText(el.querySelector('.ah-group-count'), plural(group.cards.length, 'session'))
      const color = deps.projectColor ? deps.projectColor(group.key) : ''
      if (el.style.getPropertyValue('--ah-group') !== color) {
        if (color) el.style.setProperty('--ah-group', color)
        else el.style.removeProperty('--ah-group')
      }
      paintCards(el.querySelector('.ah-cards'), group.cards, granted, { pulse, open: true })
      return el
    })
    groupNodes.forEach((el, index) => {
      if (list.children[index] !== el) list.insertBefore(el, list.children[index] ?? null)
    })
    // no session at all: the first-run message, in Working (§3.6); else a quiet line
    setHidden(workingLane.querySelector('.ah-empty'), cards.length > 0)
    setText(workingNone, WORKING_EMPTY)
    setHidden(workingNone, cards.length === 0 || working.length > 0)

    // Quiet: one row per card, in its pinned order
    order.quiet = pin(order.quiet, quiet.map((card) => card.id), held('quiet'))
    const rowRank = byRank(order.quiet)
    quiet.sort((a, b) => rowRank(a.id, b.id))
    const rows = quietLane.querySelector('.qt-rows')
    if (!quiet.length) release(rows)
    paintCards(rows, quiet, granted, { rows: true })
    setHidden(rows, !quiet.length)
    setText(quietNone, QUIET_EMPTY)
    setHidden(quietNone, quiet.length > 0)

    const ended = cards.filter((card) => card.place === 'ended')
    const earlier = cards.filter((card) => card.place === 'earlier')
    const dormant = cards.filter((card) => card.place === 'dormant')
    const closed = cards.filter((card) => card.place === 'closed')
    // the worktrees ended launches still keep, counted while the fold is closed
    const kept = [...ended, ...earlier].filter(worktreeKept).length
    const endedFold = paintFold(quietLane, 'ended', ended, [
      [`Ended (${ended.length})`, true],
      ...(kept ? [[` · ${plural(kept, 'worktree')} kept`, false]] : []),
      ...(earlier.length ? [[` · Earlier sessions (${earlier.length})`, false]] : []),
    ], granted)
    setHidden(endedFold, !ended.length && !earlier.length)
    const earlierFold = paintFold(quietLane, 'earlier', earlier, [[`Earlier sessions (${earlier.length})`, true]], granted)
    setHidden(earlierFold, !earlier.length)
    setHidden(paintFold(quietLane, 'dormant', dormant, [[`Dormant (${dormant.length})`, true], [' · quiet 8 h or more', false]], granted), !dormant.length)
    setHidden(paintFold(quietLane, 'closed', closed, [[`In closed projects (${closed.length})`, true]], granted), !closed.length)
    const undelivered = quietLane.querySelector('.ah-undelivered')
    deps.paintUndelivered?.(undelivered)
    // the folds' row shows only with something in it (§3.4, item 7)
    const foldRow = quietLane.querySelector('.ah-folds')
    setHidden(foldRow, ![...foldRow.querySelectorAll(':scope > .ah-fold')].some((fold) => !fold.hidden) && !undelivered.childElementCount)

    // roving tabindex, per lane: one card or row is tabbable, the last one a key moved to, else the first
    for (const [kind, section] of [['working', workingLane], ['quiet', quietLane]]) {
      const shown = [...section.querySelectorAll('[data-session-card]')]
      if (!shown.some((el) => el.dataset.sessionCard === roving[kind])) roving[kind] = shown[0]?.dataset.sessionCard ?? null
      for (const el of shown) {
        const tab = el.dataset.sessionCard === roving[kind] ? 0 : -1
        if (el.tabIndex !== tab) el.tabIndex = tab
      }
    }
    // only focus that was lost (a removed card's control): focus the panel kept as it stepped out stays put
    const lost = !doc.activeElement || doc.activeElement === doc.body
    if (hadFocus && lost) titleOf(focusLane)?.focus({ preventScroll: true })
    for (const els of [cardEls, rowEls]) for (const [id, el] of els) if (!byId.has(id) || !el.isConnected) els.delete(id)
  }

  // New session… and its note, made once: the page head shows them (dashboard lanes design §3.1)
  let newSessionEls = null
  function newSessionElements() {
    if (newSessionEls) return newSessionEls
    const start = button('＋ New session…', 'ah-new', 'ah:new')
    start.hidden = true
    start.addEventListener('click', () => deps.launches?.()?.openNewSession())
    const note = make('p', 'ah-note')
    note.hidden = true
    newSessionEls = { button: start, note }
    return newSessionEls
  }

  /** New session…: hidden with the switch off, disabled while a start is in flight. */
  function paintNewSession(launchUi) {
    const { button: start, note } = newSessionElements()
    const newSession = launchUi?.newSession() ?? null
    setHidden(start, !newSession)
    if (newSession && start.disabled !== newSession.disabled) start.disabled = newSession.disabled
    setText(note, newSession?.note ?? '')
    setHidden(note, !newSession?.note)
  }

  /** The card holding an ask, by its id (every attention entry is on exactly one card). */
  function cardForAsk(id) {
    for (const card of byId.values()) if (card.asks.some((entry) => askId(entry) === id)) return card
    return null
  }

  /** The card a session panel key names: a card id, a live session, or a session a launch remembers. */
  function cardFor(key) {
    if (!key) return null
    const cards = [...byId.values()]
    return byId.get(key) ?? cards.find((card) => card.session === key) ?? cards.find((card) => card.sessions.includes(key)) ?? null
  }

  let mounted = null
  let lanes = null // the last paint's Working and Quiet counts, or null while reading

  // A chip's target (dashboard lanes design §3.1): its own lane scrolled in,
  // focus on the lane's first card or row (never a fold's), else its heading. It never filters.
  function focusFirst(kind) {
    const section = laneEl(kind)
    if (!section) return
    const behavior = deps.scrollBehavior?.() ?? 'auto'
    section.scrollIntoView?.({ block: 'start', behavior })
    const match = section.querySelector(kind === 'working' ? '.ah-groups [data-session-card]' : '.qt-rows [data-session-card]')
    if (!match) {
      titleOf(kind)?.focus({ preventScroll: true })
      return
    }
    land(kind, match)
    // a card deep in a long lane is revealed, not focused off-screen
    match.scrollIntoView?.({ block: 'nearest', behavior })
  }

  return {
    /** The two lanes, made once: renderDashboard mounts them in the Dashboard grid. */
    element: () => (mounted ??= homeEl()),
    paint,
    /** Repaints the cards from the last paint's input with `overrides`: a closed panel's draft shows on its card at once. */
    repaint,
    /** Repaints New session… alone, as a start begins or settles. */
    paintNewSession: () => paintNewSession(deps.launches?.() ?? null),
    /** New session… and its note, which the page head mounts. */
    newSessionElements,
    cardFor,
    /** The page head's Working and Quiet counts, or null before the first /api/activity read. */
    counts: () => lanes,
    focusFirst,
    /**
     * The heading of the lane a panel key's card is in: Quiet for a row or a
     * fold's card (the folds sit at Quiet's end), Working otherwise.
     */
    laneTitle: (key) => {
      const card = cardFor(key ?? null)
      return titleOf(card && laneOf(card) !== 'working' ? 'quiet' : 'working')
    },
    /** The panel key of the card holding an ask (at most one does), or null. */
    askKey: (id) => {
      const card = cardForAsk(id)
      return card ? panelKey(card) : null
    },
    /** The window-local view state, for frameInputs(). */
    state: () => [[...folds].sort().join(','), mesh.state()].join('|'),
  }
}
