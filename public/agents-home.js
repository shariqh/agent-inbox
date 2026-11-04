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
// renderDashboardAmbient, so from both render entries.
import { FILTERS, cardMatches, filterCounts, groupCards, messageHint, sessionCards } from './sessions.js'
import { pinLaneOrder, tracePath } from './lanes.js'

const SVG = 'http://www.w3.org/2000/svg'
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
// A launch's panel is keyed by the launch, which outlives its sessions; any other card by its session.
const panelKey = (card) => (card.launch ? card.id : card.session)
const EMPTY = 'No sessions yet. A Claude Code or Copilot session appears here once Agent Inbox’s MCP server starts in it.'

/**
 * @param {{
 *   doc?: Document,
 *   openSession: (key: string, part?: 'approval' | 'asks' | 'message' | 'transcript' | 'resume' | null) => void,
 *   launchAction?: (id: string, action: string) => void,
 *   launches?: () => ({ granted: () => boolean, newSession: () => ({ disabled: boolean, note: string } | null), openNewSession: () => void } | null),
 *   hasDraft?: (session: string) => boolean,
 *   build?: (row: any) => ({ older: boolean, newer: boolean, hint: string } | null),
 *   projectColor?: (project: string) => string,
 *   pulse?: (el: Element) => void,
 *   paintUndelivered?: (slot: Element) => void,
 * }} deps
 */
export function installAgentsHome(deps) {
  const doc = deps.doc ?? globalThis.document
  // Window-local view state, never persisted and read by no attention surface:
  // a fresh window opens on all states, grouped by project.
  let filter = 'all'
  let groupBy = 'project'
  const folds = new Set()
  let order = []
  let last = null
  const cardEls = new Map()
  const groupEls = new Map()
  const calls = new Map() // card id → the last call a paint has seen, for the one-shot pulse
  const byId = new Map() // card id → the card its buttons act on

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
  const repaint = () => { if (last) paint(last.host, last.input) }
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
    head.append(title, make('small', 'ah-count'), make('span', 'ah-spacer'), filters, group, start)
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
    section.append(head, note, outside, list, empty, none, foldRow)
    section.addEventListener('click', onClick)
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
      if (action === 'review') deps.openSession(panelKey(card), card.approval ? 'approval' : 'asks')
      else if (action === 'message' || action === 'transcript' || action === 'resume') deps.openSession(panelKey(card), action)
      else if (card.launch) deps.launchAction?.(card.launch.id, action)
      return
    }
    // A click anywhere else on the card opens it, but never one that ends a
    // text selection or lands on a control.
    if (target.closest('button, a, select, summary, [data-link-kind]') || String(doc.getSelection?.() ?? '')) return
    deps.openSession(panelKey(card))
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

  function chipsOf(card) {
    const who = `${card.host} · ${card.origin}`
    const chips = [[who, card.origin === 'started here' ? 'sc-chip tone-agent' : 'sc-chip', who]]
    const build = card.row ? deps.build?.(card.row) : null
    if (build?.older) chips.push(['older build', 'sc-chip tone-warn', build.hint])
    else if (build?.newer) chips.push(['newer build', 'sc-chip tone-warn', build.hint])
    return chips
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
    if (card.state === 'ask') return out
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
    return out
  }

  function updateCard(el, card, granted) {
    // classList, never className: a running one-shot (.pulse) survives the paint
    for (const name of [...el.classList]) if (name.startsWith('tone-') && name !== `tone-${card.state}`) el.classList.remove(name)
    if (!el.classList.contains(`tone-${card.state}`)) el.classList.add(`tone-${card.state}`)
    const selected = Boolean(last?.input.selected) && cardFor(last.input.selected) === card
    if (el.classList.contains('sel') !== selected) el.classList.toggle('sel', selected)
    // written only on a change, so an unchanged paint writes nothing at all
    const label = `${card.label}: ${card.host} in ${card.project}${card.branch ? ` on ${card.branch}` : ''}`
    if (el.getAttribute('aria-label') !== label) el.setAttribute('aria-label', label)
    setText(el.querySelector('.sc-state'), card.label)
    setText(el.querySelector('.sc-when'), card.recency)
    const chips = chipsOf(card)
    rebuild(el.querySelector('.sc-chips'), JSON.stringify(chips), () => chips.map(([text, cls, title]) => {
      const chip = make('span', cls, text)
      if (title) chip.title = title
      return chip
    }))
    const doing = el.querySelector('.sc-doing')
    const text = card.historical && card.base !== 'working' && card.row && card.text !== 'No task reported yet' ? `was: ${card.text}` : card.text
    setText(doing, text)
    doing.classList.toggle('was', card.historical)
    if (doing.title !== text) doing.title = text
    const where = el.querySelector('.sc-where')
    rebuild(where, JSON.stringify([card.branch, card.worktree]), () => {
      const parts = []
      if (card.branch) {
        const glyph = make('span', 'sc-branch-glyph', '⑂')
        glyph.setAttribute('aria-hidden', 'true')
        parts.push(glyph, make('span', 'sc-branch', card.branch))
      }
      if (card.worktree) parts.push(make('span', 'sc-worktree', `${card.branch ? ' · ' : ''}${card.worktree}`))
      return parts
    })
    setHidden(where, !card.branch && !card.worktree)
    const ask = el.querySelector('.sc-ask')
    setHidden(ask, !card.asks.length)
    const first = card.asks[0]
    const askTitle = first ? (first.kind === 'item' ? first.item?.title : first.row?.label) ?? '' : ''
    rebuild(ask, JSON.stringify([card.asks.length, card.approval, askTitle]), () => {
      if (!first) return []
      const label = make('span', 'sc-ask-label', card.approval ? 'Approval' : 'Asking you')
      const title = make('span', `sc-ask-title${card.approval ? ' mono' : ''}`, askTitle)
      title.title = askTitle
      const parts = [label, title]
      if (card.asks.length > 1) parts.push(make('span', 'sc-ask-more', `+${card.asks.length - 1}`))
      const review = button('Review', 'sc-action primary', `sc:${card.id}:review`)
      review.dataset.ahAction = 'review'
      review.title = card.approval ? 'Review this approval on the rail' : 'Open this ask'
      parts.push(make('span', 'ah-spacer'), review)
      return parts
    })
    const actions = actionsOf(card, granted)
    const foot = el.querySelector('.sc-foot')
    // what a working session is doing shows on a working card; an ask's card shows its ask
    const busy = card.state === 'working'
    const trace = busy ? card.trace ?? [] : []
    const callCount = trace.reduce((sum, count) => sum + count, 0)
    const meta = busy || card.state === 'ask' || card.launch ? null : messageHint(card.row)
    const facts = foot.querySelector('.sc-facts')
    const buttons = foot.querySelector('.sc-actions')
    rebuild(facts, JSON.stringify([busy && card.plan, busy && card.children, trace, meta]), () => {
      const parts = []
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
      if (meta) {
        const hint = make('span', 'sc-meta', meta)
        hint.title = meta
        parts.push(hint)
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
    nodes.forEach((el, index) => {
      if (container.children[index] !== el) container.insertBefore(el, container.children[index] ?? null)
    })
    while (container.children.length > nodes.length) container.lastElementChild.remove()
  }

  function paintFold(section, key, cards, summary, granted) {
    const fold = section.querySelector(`[data-ah-fold="${key}"]`)
    const summaryEl = fold.querySelector(':scope > summary')
    rebuild(summaryEl, JSON.stringify(summary), () => summary.map(([text, strong]) => (strong ? make('b', '', text) : doc.createTextNode(text))))
    const open = folds.has(key)
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
      setText(el.querySelector('.ah-group-count'), plural(group.cards.length, 'session'))
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
    if (hadFocus && !section.contains(doc.activeElement)) section.querySelector('#agentsHomeTitle')?.focus({ preventScroll: true })
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
    /** Repaints New session… alone, as a start begins or settles. */
    paintNewSession: () => { if (mounted) paintNewSession(mounted, deps.launches?.() ?? null) },
    cardFor,
    /** The window-local view state, for frameInputs(). */
    state: () => [filter, groupBy, [...folds].sort().join(',')].join('|'),
  }
}
