// The Agents home (#454, design docs/superpowers/specs/2026-11-04-agents-home-design.md
// §3): one card per session, grouped by project (or by agent kind), with state
// filters, New session… and folds for the ended, the dormant, the closed
// projects' sessions and the messages not delivered. It began as mesh M1's
// Agents view (#397) and is always on.
//
// It reads what the frame already read (sessions.js builds the cards) and
// never feeds attention: "Needs you" and the asks READ the frame's attention
// entries, and nothing here reaches public/attention.js, a badge, a count, the
// rail or the dock. It fetches nothing and runs no timer; a working card
// pulses once on a new call, through the page's one-shot (#304). Agent text
// reaches the DOM only through textContent. Painted from app.js's
// renderDashboardAmbient, so from both render entries. The Mesh agents section
// (public/mesh-section.js) sits after the groups, outside every filter and lens.
import { FILTERS, cardMatches, filterCounts, groupCards, messageHint, sessionCards } from './sessions.js'
import { forgettable } from './launches.js'
import { pinLaneOrder, tracePath } from './lanes.js'
import { relMs } from './rowview.js'
import { installMeshAgents } from './mesh-section.js'

const SVG = 'http://www.w3.org/2000/svg'
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
// A launch's panel is keyed by the launch, which outlives its sessions, and an
// ask-only card's by its id; any other card by its session.
const panelKey = (card) => (card.launch || card.askOnly ? card.id : card.session)
const askId = (entry) => (entry?.kind === 'row' ? entry.row?.id : entry?.item?.id) ?? null
const EMPTY = 'No sessions yet. A Claude Code or Copilot session appears here once Agent Inbox’s MCP server starts in it.'

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
  // Window-local view state, never persisted and read by no attention surface:
  // a fresh window opens on all states, grouped by project.
  let filter = 'all'
  let groupBy = 'project'
  const folds = new Set()
  let order = []
  let last = null
  let roving = null // the card Tab lands on
  const cardEls = new Map()
  const groupEls = new Map()
  const calls = new Map() // card id → the last call a paint has seen, for the one-shot pulse
  const byId = new Map() // card id → the card its buttons act on
  // global: no filter or lens narrows it, and it shows under the empty state's text
  const mesh = installMeshAgents({ doc, onRefresh: () => deps.refreshMesh?.(), onChange: () => repaint() })

  const make = (tag, className, text) => {
    const el = doc.createElement(tag)
    if (className) el.className = className
    if (text !== undefined) el.textContent = text
    return el
  }
  const setText = (el, text) => { if (el.textContent !== text) el.textContent = text }
  const setHidden = (el, hidden) => { if (el.hidden !== hidden) el.hidden = hidden }
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
  // A narrow window's session panel sits in a group's or fold's card grid
  // (app.js placeFocusPanel): before that grid is removed or folded away, the
  // panel steps out after the section, so it is never cut off with it.
  const release = (el) => {
    for (const child of el.querySelectorAll('.ah-cards > :not([data-session-card])')) {
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

  function homeEl() {
    const section = make('section', 'dashboard-card agents-home')
    section.setAttribute('aria-labelledby', 'agentsHomeTitle')
    const head = make('div', 'dashboard-card-head ah-head')
    const title = make('h2', '', 'Agents')
    title.id = 'agentsHomeTitle'
    title.tabIndex = -1
    const filters = make('div', 'ah-filters')
    filters.setAttribute('role', 'group')
    filters.setAttribute('aria-label', 'Show sessions')
    for (const [key, label] of FILTERS) {
      const option = button('', `ah-filter${key === 'ask' ? ' att' : ''}`, `ah:filter:${key}`)
      option.dataset.ahFilter = key
      option.append(make('span', '', label), make('b', 'ah-filter-count', '0'))
      option.addEventListener('click', () => { filter = key; repaint() })
      filters.append(option)
    }
    const group = make('label', 'ah-group-by')
    const select = make('select')
    select.dataset.dashboardFocusKey = 'ah:group'
    select.setAttribute('aria-label', 'Group sessions by')
    select.append(new Option('Project', 'project'), new Option('Agent', 'agent'))
    select.addEventListener('change', () => { groupBy = select.value === 'agent' ? 'agent' : 'project'; repaint() })
    group.append(make('span', '', 'Group:'), select)
    const start = button('＋ New session…', 'ah-new', 'ah:new')
    start.hidden = true
    start.addEventListener('click', () => deps.launches?.()?.openNewSession())
    // #454 A.2: where the rail's "N in Later" and Open Review queue went
    const later = button('', 'ah-later', 'ah:later')
    later.hidden = true
    later.title = 'Open the Inbox’s Later section'
    later.addEventListener('click', () => deps.openLater?.())
    const review = button('Review queue', 'ah-review', 'ah:review')
    review.dataset.shortcutId = 'review'
    review.addEventListener('click', () => deps.openReview?.())
    head.append(title, make('small', 'ah-count'), filters, make('span', 'ah-spacer'), later, review, group, start)
    const note = make('p', 'ah-note')
    note.hidden = true
    // the launches the project and agent lens hides, so a session started elsewhere is never lost
    const outside = make('p', 'ah-outside')
    outside.hidden = true
    const showAll = button('Show all', 'ah-outside-all', 'ah:outside-all')
    showAll.addEventListener('click', () => deps.showAll?.())
    outside.append(make('span', 'ah-outside-text'), doc.createTextNode(' · '), showAll)
    const list = make('div', 'ah-groups')
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
    empty.append(icon, make('p', 'ah-empty-text', EMPTY))
    empty.hidden = true
    const none = make('div', 'ah-none')
    const all = button('Show all', 'ah-show-all', 'ah:show-all')
    all.addEventListener('click', () => { filter = 'all'; repaint() })
    none.append(make('p', '', 'No session matches these filters.'), all)
    none.hidden = true
    const foldRow = make('div', 'ah-folds')
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
    section.append(head, note, outside, list, empty, none, make('div', 'ah-mesh'), foldRow)
    section.addEventListener('click', onClick)
    section.addEventListener('keydown', onKey)
    return section
  }

  function onClick(event) {
    const target = event.target instanceof doc.defaultView.Element ? event.target : null
    const el = target?.closest('[data-session-card]')
    const card = el ? byId.get(el.dataset.sessionCard) : null
    if (!card) return
    const control = target.closest('[data-ah-action]')
    if (control) {
      if (control.disabled) return
      const action = control.dataset.ahAction
      // the session panel holds the ask, the composer, the transcript and Resume and send (§3.3)
      if (action === 'review') openAsk(card)
      else if (action === 'inbox') deps.openInInbox?.(card.asks[0])
      else if (action === 'message' || action === 'transcript' || action === 'resume') deps.openSession(panelKey(card), action)
      else if (card.launch) deps.launchAction?.(card.launch.id, action)
      return
    }
    // A click anywhere else on the card opens it, but never one that ends a
    // text selection or lands on a control.
    if (target.closest('button, a, select, summary, [data-link-kind]') || String(doc.getSelection?.() ?? '')) return
    // the ask strip opens the panel at that ask; it never answers (A.6)
    if (target.closest('.sc-ask') && card.asks.length) openAsk(card)
    else deps.openSession(panelKey(card))
  }

  // #454 A.2: on a card itself (never its controls), J/K and the arrows move
  // between cards, one tabbable at a time, and Enter opens its panel.
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
      if (card.asks.length) openAsk(card)
      else deps.openSession(panelKey(card), 'head')
      return
    }
    const cards = [...el.closest('.agents-home').querySelectorAll('[data-session-card]')]
    const next = cards[cards.indexOf(el) + move]
    if (!next) return
    roving = next.dataset.sessionCard
    for (const other of cards) other.tabIndex = other === next ? 0 : -1
    next.focus()
  }

  // An approval lands on its heading (#459); any other ask on its own block.
  function openAsk(card) {
    const first = card.asks[0]
    deps.openSession(panelKey(card), card.approval ? 'approval' : 'asks', card.approval ? null : askId(first))
  }

  // ── a card ────────────────────────────────────────────────────────────────
  function cardEl(id) {
    const el = make('article', 'sc')
    el.dataset.sessionCard = id
    el.setAttribute('role', 'listitem')
    const top = make('div', 'sc-top')
    const dot = make('span', 'sc-dot')
    dot.setAttribute('aria-hidden', 'true')
    top.append(dot, make('span', 'sc-state'), make('span', 'sc-chips'), make('span', 'sc-when'))
    const ask = make('div', 'sc-ask')
    ask.hidden = true
    // the foot's facts and its buttons are rebuilt apart, so a new call never replaces a focused button
    const foot = make('div', 'sc-foot')
    foot.append(make('div', 'sc-facts'), make('div', 'sc-actions'))
    el.append(top, make('div', 'sc-doing'), make('div', 'sc-where'), ask, foot)
    return el
  }

  function worktreeKept(card) {
    const launch = card.launch
    return launch?.status === 'ended' && typeof launch.worktree_path === 'string' && launch.worktree_path !== '' && !launch.worktree_removed_at
  }

  // V1 (#454 A.3): the agent kind as plain text, an outlined "A" for a session
  // started here, the branch; build hints are the panel's and the Sessions line's.
  function metaOf(card) {
    const parts = [['sc-agent', card.host, `${card.host} · ${card.origin}`]]
    if (card.origin === 'started here') parts.push(['sc-here', 'A', 'Started here, in Agent Inbox'])
    else if (card.origin === 'driven') parts.push(['sc-origin', 'driven', 'Driven by another app'])
    if (card.branch) parts.push(['sc-branch', card.branch, card.branch])
    return parts
  }

  // The ask strip's second line: each ask's kind and age, the first two.
  const askAge = (entry, nowMs) => {
    const at = Date.parse((entry.kind === 'row' ? entry.row?.action_started_at ?? entry.board?.updated_at : entry.item?.created_at) ?? '')
    if (!Number.isFinite(at)) return ''
    const ms = Math.max(0, nowMs - at)
    return relMs(ms) === 'moments' ? 'now' : relMs(ms)
  }
  const askKind = (entry) => (entry.kind === 'row' ? 'plan step' : entry.item?.project?.startsWith('@') ? 'approval' : 'question')
  function askLine(card, nowMs) {
    const [first] = card.asks
    if (card.asks.length === 1) return [askKind(first).replace(/^./, (c) => c.toUpperCase()), askAge(first, nowMs)].filter(Boolean).join(' · ')
    return [plural(card.asks.length, 'ask'), ...card.asks.slice(0, 2).map((entry) => `${askKind(entry)} ${askAge(entry, nowMs)}`.trim())].join(' · ')
  }

  // The state's main action (§2), and Message on a session that can take one.
  function actionsOf(card, granted) {
    const out = []
    const session = card.session
    const message = () => {
      if (!session) return
      const draft = deps.hasDraft?.(session) === true
      out.push(['message', draft ? 'Message · draft' : 'Message', draft ? 'Message this session: your unsent draft is kept' : 'Message this session'])
    }
    if (card.state === 'ask') {
      if (card.askOnly) out.push(['inbox', 'Open in Inbox', 'Open this ask’s card in the Inbox'])
      const draft = card.asks.some((entry) => deps.hasAskDraft?.(askId(entry)) === true)
      out.push(['review', draft ? 'Answer · draft' : 'Answer',
        draft ? 'Answer in the session panel: your unsent draft is kept' : card.approval ? 'Review this approval in the session panel' : 'Answer in the session panel', 'primary'])
      return out
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
        if (granted && has('takeover')) out.push(['take-over', 'Take over in Terminal', 'Go on with this session in Copilot in Terminal'])
        out.push(granted && has('resume') ? ['resume', 'Resume…', 'Resume this session with a message', 'primary'] : ['transcript', 'Transcript', ''])
        break
      case 'terminal': out.push(granted && has('terminal') ? ['take-over', 'Resume in Terminal', 'Open Terminal on this session again'] : ['transcript', 'Transcript', '']); break
      default:
        out.push(granted && card.launch.worktree_path && !card.launch.worktree_removed_at
          ? ['open-worktree', 'Open in Terminal', 'Open Terminal in this session’s worktree'] : ['transcript', 'Transcript', ''])
    }
    // an ended launch's kept worktree is removed from its card too: main checks it and asks first (#432)
    if (granted && worktreeKept(card)) out.push(['remove-worktree', 'Remove worktree…', 'Remove this session’s worktree: its branch is kept'])
    // #478: an ended launch with no worktree left, stopped ones that can resume included
    if (granted && forgettable(card.launch)) out.push(['forget', 'Forget…', 'Forget this session: its card, transcript and logs'])
    return out
  }

  function updateCard(el, card, granted) {
    // classList, never className: a running one-shot (.pulse) survives the paint
    for (const name of [...el.classList]) if (name.startsWith('tone-') && name !== `tone-${card.state}`) el.classList.remove(name)
    if (!el.classList.contains(`tone-${card.state}`)) el.classList.add(`tone-${card.state}`)
    const selected = Boolean(last?.input.selected) && cardFor(last.input.selected) === card
    if (el.classList.contains('sel') !== selected) el.classList.toggle('sel', selected)
    if (el.classList.contains('sc-ask-only') !== Boolean(card.askOnly)) el.classList.toggle('sc-ask-only', Boolean(card.askOnly))
    if (el.classList.contains('quiet') !== Boolean(card.quiet)) el.classList.toggle('quiet', Boolean(card.quiet))
    // written only on a change, so an unchanged paint writes nothing at all
    const label = `${card.label}: ${card.host} in ${card.project}${card.branch ? ` on ${card.branch}` : ''}`
    if (el.getAttribute('aria-label') !== label) el.setAttribute('aria-label', label)
    setText(el.querySelector('.sc-state'), card.label)
    setText(el.querySelector('.sc-when'), card.recency)
    const meta = metaOf(card)
    rebuild(el.querySelector('.sc-chips'), JSON.stringify(meta), () => meta.map(([cls, text, title]) => {
      const part = make('span', cls, text)
      if (title) part.title = title
      return part
    }))
    const doing = el.querySelector('.sc-doing')
    const text = card.line
    setText(doing, text)
    doing.classList.toggle('was', card.historical)
    if (doing.title !== text) doing.title = text
    // V2: a secondary line under what it is doing: the worktree and a working
    // session's plan bar, else when a message reaches it
    const busy = card.state === 'working'
    const hint = busy || card.state === 'ask' || card.launch ? null : messageHint(card.row)
    const where = el.querySelector('.sc-where')
    rebuild(where, JSON.stringify([card.worktree, busy && card.plan, hint]), () => {
      const parts = []
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
    const ask = el.querySelector('.sc-ask')
    setHidden(ask, !card.asks.length)
    const first = card.asks[0]
    const askTitle = first ? (first.kind === 'item' ? first.item?.title : first.row?.label) ?? '' : ''
    if (ask.title !== (first ? 'Open this ask in the session panel' : '')) ask.title = first ? 'Open this ask in the session panel' : ''
    const line = first ? askLine(card, last?.input.nowMs ?? Date.now()) : ''
    rebuild(ask, JSON.stringify([card.approval, askTitle, line]), () => {
      if (!first) return []
      const title = make('span', `sc-ask-title${card.approval ? ' mono' : ''}`, askTitle)
      title.title = askTitle
      return [title, make('span', 'sc-ask-line', line)]
    })
    const actions = actionsOf(card, granted)
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
    rebuild(buttons, JSON.stringify(actions), () => actions.map(([action, label, title, tone]) => {
      const control = button(label, `sc-action${tone ? ` ${tone}` : ''}`, `sc:${card.id}:${action}`)
      control.dataset.ahAction = action
      if (title) control.title = title
      return control
    }))
    setHidden(foot, !facts.childElementCount && !buttons.childElementCount)
  }

  function paintCards(container, cards, granted, { pulse = new Set() } = {}) {
    const nodes = cards.map((card) => {
      let el = cardEls.get(card.id)
      if (!el) {
        el = cardEl(card.id)
        cardEls.set(card.id, el)
      }
      updateCard(el, card, granted)
      if (pulse.has(card.id)) deps.pulse?.(el)
      return el
    })
    // the cards are ordered among themselves: another child (the session panel
    // placed under its card's row in a narrow window) keeps its place
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

  /**
   * @param {Element} host `#dashboard .dashboard`, once its grid is mounted
   * @param {{activity: any[], launches?: any[] | null, boards?: any[], attention?: any[], closed?: Iterable<string>, nowMs: number, forced?: boolean, lensProject?: string | null}} input
   */
  function paint(host, input) {
    last = { host, input }
    const section = host?.querySelector('.dashboard-grid .agents-home')
    if (!section) return
    // a keyboard user whose card leaves lands on the heading, only in a window that has focus
    const hadFocus = section.contains(doc.activeElement) && doc.hasFocus?.() === true
    const reading = !Array.isArray(input.activity)
    // the session panel reads these too (cardFor)
    const cards = reading ? [] : sessionCards(input)
    byId.clear()
    for (const card of cards) byId.set(card.id, card)
    section.classList.toggle('reading', reading)
    mesh.paint(section.querySelector('.ah-mesh'), input.mesh ?? null, input.nowMs)
    if (reading) {
      // before the first /api/activity read (§3.6)
      setText(section.querySelector('.ah-count'), 'Reading sessions…')
      return
    }
    const launchUi = deps.launches?.() ?? null
    const granted = launchUi?.granted() === true
    const main = cards.filter((card) => card.place === 'main')
    // §10 rule 5, as the lanes: a card keeps its place between forced paints
    order = pinLaneOrder(input.forced ? [] : order, main.map((card) => ({ session: card.id })))
    const rank = new Map(order.map((id, index) => [id, index]))
    main.sort((a, b) => rank.get(a.id) - rank.get(b.id))
    const counts = filterCounts(main)
    for (const option of section.querySelectorAll('[data-ah-filter]')) {
      const key = option.dataset.ahFilter
      setText(option.querySelector('.ah-filter-count'), String(counts[key] ?? 0))
      const pressed = String(key === filter)
      if (option.getAttribute('aria-pressed') !== pressed) option.setAttribute('aria-pressed', pressed)
    }
    const select = section.querySelector('[data-dashboard-focus-key="ah:group"]')
    if (select.value !== groupBy) select.value = groupBy
    setText(section.querySelector('.ah-count'), `${plural(main.length, 'session')}${input.lensProject ? ` in ${input.lensProject}` : ''}`)
    paintNewSession(section, launchUi)
    const hidden = Number(input.outside) || 0
    setText(section.querySelector('.ah-outside-text'), hidden ? `${plural(hidden, 'session')} outside this filter` : '')
    setHidden(section.querySelector('.ah-outside'), !hidden)
    const later = Number(input.later) || 0
    setText(section.querySelector('.ah-later'), later ? `Later ${later} ›` : '')
    setHidden(section.querySelector('.ah-later'), !later)

    // the one-shot pulse: a real call since the last paint, on a drawn working card
    const pulse = new Set()
    for (const card of main) {
      const seen = calls.get(card.id)
      if (card.base === 'working' && seen !== undefined && Date.parse(card.lastCallAt ?? '') > Date.parse(seen ?? '')) pulse.add(card.id)
    }
    calls.clear()
    for (const card of main) calls.set(card.id, card.lastCallAt)

    const shown = main.filter((card) => cardMatches(card, filter))
    const list = section.querySelector('.ah-groups')
    const groups = groupCards(shown, groupBy)
    const keep = new Set(groups.map((group) => `${groupBy}:${group.key}`))
    for (const [key, el] of groupEls) {
      if (!keep.has(key)) {
        release(el)
        el.remove()
        groupEls.delete(key)
      }
    }
    const groupNodes = groups.map((group) => {
      const key = `${groupBy}:${group.key}`
      let el = groupEls.get(key)
      if (!el) {
        el = make('div', 'ah-group')
        const head = make('div', 'ah-group-head')
        const dot = make('i')
        dot.setAttribute('aria-hidden', 'true')
        head.append(dot, make('span', 'ah-group-name'), make('small', 'ah-group-count'))
        const cardsEl = make('div', 'ah-cards')
        cardsEl.setAttribute('role', 'list')
        el.append(head, cardsEl)
        groupEls.set(key, el)
      }
      setText(el.querySelector('.ah-group-name'), group.label)
      const asks = group.cards.reduce((sum, card) => sum + card.asks.length, 0)
      setText(el.querySelector('.ah-group-count'), `${plural(group.cards.length, 'session')}${asks ? ` · ${plural(asks, 'ask')}` : ''}`)
      const color = groupBy === 'project' && deps.projectColor ? deps.projectColor(group.key) : ''
      if (el.style.getPropertyValue('--ah-group') !== color) {
        if (color) el.style.setProperty('--ah-group', color)
        else el.style.removeProperty('--ah-group')
      }
      paintCards(el.querySelector('.ah-cards'), group.cards, granted, { pulse })
      return el
    })
    groupNodes.forEach((el, index) => {
      if (list.children[index] !== el) list.insertBefore(el, list.children[index] ?? null)
    })
    setHidden(section.querySelector('.ah-empty'), cards.length > 0)
    // no session at all: the empty state says so, with no filter to choose (§3.6)
    section.classList.toggle('ah-is-empty', cards.length === 0)
    setHidden(section.querySelector('.ah-none'), !main.length || shown.length > 0)

    const ended = cards.filter((card) => card.place === 'ended')
    const earlier = cards.filter((card) => card.place === 'earlier')
    const dormant = cards.filter((card) => card.place === 'dormant')
    const closed = cards.filter((card) => card.place === 'closed')
    // the worktrees ended launches still keep, counted while the fold is closed
    const kept = [...ended, ...earlier].filter(worktreeKept).length
    const endedFold = paintFold(section, 'ended', ended, [
      [`Ended (${ended.length})`, true],
      ...(kept ? [[` · ${plural(kept, 'worktree')} kept`, false]] : []),
      ...(earlier.length ? [[` · Earlier sessions (${earlier.length})`, false]] : []),
    ], granted)
    setHidden(endedFold, !ended.length && !earlier.length)
    const earlierFold = paintFold(section, 'earlier', earlier, [[`Earlier sessions (${earlier.length})`, true]], granted)
    setHidden(earlierFold, !earlier.length)
    setHidden(paintFold(section, 'dormant', dormant, [[`Dormant (${dormant.length})`, true], [' · quiet 8 h or more', false]], granted), !dormant.length)
    setHidden(paintFold(section, 'closed', closed, [[`In closed projects (${closed.length})`, true]], granted), !closed.length)
    deps.paintUndelivered?.(section.querySelector('.ah-undelivered'))
    // roving tabindex: one card is tabbable, the last one a key moved to, else the first
    const shownCards = [...section.querySelectorAll('[data-session-card]')]
    if (!shownCards.some((el) => el.dataset.sessionCard === roving)) roving = shownCards[0]?.dataset.sessionCard ?? null
    for (const el of shownCards) {
      const tab = el.dataset.sessionCard === roving ? 0 : -1
      if (el.tabIndex !== tab) el.tabIndex = tab
    }
    // only focus that was lost (a removed card's control): focus the panel kept as it stepped out stays put
    const lost = !doc.activeElement || doc.activeElement === doc.body
    if (hadFocus && lost) section.querySelector('#agentsHomeTitle')?.focus({ preventScroll: true })
    for (const [id, el] of cardEls) if (!byId.has(id) || !el.isConnected) cardEls.delete(id)
  }

  /** New session…: hidden with the switch off, disabled while a start is in flight. */
  function paintNewSession(section, launchUi) {
    const start = section.querySelector('.ah-new')
    const newSession = launchUi?.newSession() ?? null
    setHidden(start, !newSession)
    if (newSession && start.disabled !== newSession.disabled) start.disabled = newSession.disabled
    const note = section.querySelector('.ah-note')
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

  return {
    /** The card, made once: renderDashboard mounts it in the Dashboard grid. */
    element: () => (mounted ??= homeEl()),
    paint,
    /** Repaints the cards from the last paint's input with `overrides`: a closed panel's draft shows on its card at once. */
    repaint,
    /** Repaints New session… alone, as a start begins or settles. */
    paintNewSession: () => { if (mounted) paintNewSession(mounted, deps.launches?.() ?? null) },
    cardFor,
    /** Shows one state filter and lands on the Agents heading (the Now strip's Waiting on you, #454 A.2). */
    showFilter: (key) => {
      filter = FILTERS.some(([name]) => name === key) ? key : 'all'
      repaint()
      if (doc.hasFocus?.()) mounted?.querySelector('#agentsHomeTitle')?.focus({ preventScroll: true })
    },
    /** The panel key of the card holding an ask, or null. */
    askKey: (id) => {
      const card = cardForAsk(id)
      return card ? panelKey(card) : null
    },
    /** The window-local view state, for frameInputs(). */
    state: () => [filter, groupBy, [...folds].sort().join(','), mesh.state()].join('|'),
  }
}
