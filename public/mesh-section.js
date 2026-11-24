// The Agent cards tab's "Yours" section (Agent cards step 1; agent cards view design
// docs/superpowers/specs/2026-11-09-agent-cards-view-design.md §2, amended): one card per agent
// mesh.json configures, built in or added with the add command, from the last
// `/api/mesh/agents` body app.js read, in a grid of three, two or one columns that follows its
// own container's width. Card text is untrusted: it reaches the DOM only through textContent and
// attributes, never as markup, an href or an image. The page owns only the state labels; every
// reason and fix comes from the server. Pressing a card opens that agent's page inside the tab
// (public/mesh-agent-page.js). The grid is one Tab stop: the arrows, Home and End rove between
// cards, kept by the server's `key`, so a repaint never moves focus. Nothing here is an ask: no
// state reaches public/attention.js, a badge, a count or a tab.
import { relMs } from './rowview.js'
import { lastRunText } from './mesh-runs-tab.js'

const LABELS = {
  unchecked: 'Not checked yet',
  checking: 'Checking…',
  'not-running': 'Not running',
  unreachable: 'Unreachable',
  'not-a-card': 'Not an agent card',
  mismatch: 'Card does not match this build',
  invalid: 'Endpoint not accepted',
  // an agent the add command wrote: the viewer never checks it, so it never says it is reachable (D6)
  added: 'Added',
}
const NEUTRAL = new Set(['unchecked', 'checking', 'not-running', 'added'])
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`
const ago = (ms) => (relMs(Math.max(0, ms)) === 'moments' ? 'just now' : `${relMs(Math.max(0, ms))} ago`)

// V5 §2.1's short form, never a host or port: the agent's page shows the endpoint
function whereText(agent) {
  if (agent.where === 'local') return 'Local'
  if (agent.where === 'tailnet') return 'Remote · tailnet'
  if (agent.where === 'ssh-tunnel') return 'Remote · SSH tunnel'
  if (agent.where === 'public') return 'Remote · public'
  return agent.name === 'unslop' ? 'Local' : 'Remote'
}

// §2.2's usage line, unslop's counts only; no usage key (no file, or a refused one) is no line.
function usageText(usage) {
  if (!usage || typeof usage !== 'object' || !Number.isFinite(usage.tasks) || !Number.isFinite(usage.modelMs)) return ''
  return `Today: ${plural(usage.tasks, 'task')} · ${plural(Math.round(usage.modelMs / 60_000), 'model-minute')}`
}

/** The section's model from a `/api/mesh/agents` body: one card per agent, by name. */
export function meshRows(body, nowMs) {
  const agents = (Array.isArray(body?.agents) ? body.agents : []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)))
  const rows = agents.map((agent) => {
    const card = agent.card ?? agent.lastSeen?.card ?? null
    const label = agent.state === 'up' ? (agent.where === 'local' ? 'Running' : 'Reachable') : LABELS[agent.state] ?? 'Unknown state'
    const facts = [whereText(agent)]
    if (card?.version) facts.push(`${/^v\d/.test(card.version) ? '' : 'v'}${card.version}`)
    if (!agent.card && agent.lastSeen?.at) facts.push(`seen ${ago(nowMs - Date.parse(agent.lastSeen.at))}`)
    const added = agent.kind === 'added'
    return {
      key: String(agent.key),
      name: String(agent.name),
      tone: agent.state === 'up' ? 'up' : NEUTRAL.has(agent.state) ? 'neutral' : 'amber',
      word: label,
      status: [label, agent.reason].filter(Boolean).join(' · '),
      // an added agent's line is the server's whole sentence ("Run … to show its card")
      fix: agent.fix ? (added ? String(agent.fix) : `Fix: ${agent.fix}`) : '',
      facts: facts.join(' · '),
      // the card's one description line, cut to two lines by CSS; a built-in agent's own line (the
      // server's) stands in only while no card text at all is known
      description: card ? (typeof card.description === 'string' ? card.description : '') : (typeof agent.blurb === 'string' ? agent.blurb : ''),
      // a missing card copy is no problem state: its line is quiet, not amber (D6)
      quiet: agent.fixQuiet === true,
      // an added agent's page says the app does not check it, in the server's words
      note: added && typeof agent.checkNote === 'string' ? agent.checkNote : '',
      added,
      tag: added ? 'Added by you' : 'Built in',
      usage: usageText(agent.usage),
      // V5 §2.1's last line: when the newest run ended, by the label clock, and how
      lastrun: lastRunText(agent.lastRun, nowMs),
    }
  })
  // the app checks the built-in agents only: the header's text speaks of them, and of nothing when there are none
  const builtIn = agents.filter((a) => a.kind !== 'added')
  const checked = builtIn.map((a) => Date.parse(a.checkedAt ?? '')).filter(Number.isFinite)
  const others = Number(body?.others) || 0
  return {
    title: 'Yours',
    count: String(rows.length),
    checked: !builtIn.length ? '' : checked.length ? `checked ${ago(nowMs - Math.min(...checked))}` : 'not checked yet',
    // D6: entries that are neither built in nor a valid added agent, with what to do
    // the fix names the command, so it comes from the server (design §3.4)
    others: others ? `${others === 1 ? '1 entry' : `${others} entries`} in mesh.json ${others === 1 ? 'is' : 'are'} not valid${body?.othersFix ? `: ${body.othersFix}` : ''}` : '',
    rows,
  }
}

// a grid a person expects: Left/Right step, Up/Down move a row, Home/End go to the ends;
// J/K stay the session cards' keys
const MOVES = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity }
// a card's lines below its title, in order, by class; ids come from a counter, never a name
const LINES = ['ma-description', 'ma-fix']
let ids = 0

/** @param {{doc?: Document, onRefresh?: () => void, onOpen?: (key: string, name: string) => void}} deps */
export function installMeshAgents(deps = {}) {
  const doc = deps.doc ?? globalThis.document
  // the card Tab lands on: the last one focused, else the first
  let roving = null
  const cardEls = new Map()
  let root = null

  const make = (tag, className, text) => {
    const el = doc.createElement(tag)
    if (className) el.className = className
    if (text !== undefined) el.textContent = text
    return el
  }
  const setText = (el, text) => { if (el.textContent !== text) el.textContent = text }
  const setHidden = (el, hidden) => { if (el.hidden !== hidden) el.hidden = hidden }
  const setAttr = (el, name, value) => {
    if (value === null) { if (el.hasAttribute(name)) el.removeAttribute(name) } else if (el.getAttribute(name) !== value) el.setAttribute(name, value)
  }
  const cardsIn = (grid) => [...grid.querySelectorAll(':scope > li > .ma-card')]
  function rove(grid) {
    const cards = cardsIn(grid)
    if (!cards.some((el) => el.parentElement.dataset.meshKey === roving)) roving = cards[0]?.parentElement.dataset.meshKey ?? null
    for (const el of cards) {
      const tab = el.parentElement.dataset.meshKey === roving ? 0 : -1
      if (el.tabIndex !== tab) el.tabIndex = tab
    }
  }
  // the columns the grid draws now, from where its cards sit; one with no layout to read
  function columns(cards) {
    const top = cards[0]?.getBoundingClientRect()
    if (!top || (!top.width && !top.height)) return 1
    const n = cards.filter((el) => el.getBoundingClientRect().top === top.top).length
    return Math.max(1, n)
  }

  function element() {
    if (root) return root
    root = make('section', 'mesh-agents')
    root.setAttribute('aria-labelledby', 'meshAgentsTitle')
    const head = make('div', 'ma-head')
    const title = make('h2', 'ma-title-text', 'Yours')
    title.id = 'meshAgentsTitle'
    const refresh = make('button', 'ma-refresh', 'Refresh')
    refresh.type = 'button'
    refresh.title = 'Check every agent’s card now'
    head.append(title, make('small', 'ma-count'), make('span', 'ah-spacer'), make('small', 'ma-checked'), refresh)
    // the explicit role keeps list semantics in WebKit under `list-style: none`
    const grid = make('ul', 'ma-grid')
    grid.setAttribute('role', 'list')
    grid.setAttribute('aria-labelledby', 'meshAgentsTitle')
    root.append(head, make('p', 'ma-stale', 'could not read; showing what was last read'), grid, make('p', 'ma-others'))
    refresh.addEventListener('click', () => deps.onRefresh?.())
    grid.addEventListener('click', (event) => {
      const card = event.target instanceof doc.defaultView.Element ? event.target.closest('.ma-card') : null
      if (card) deps.onOpen?.(card.parentElement.dataset.meshKey, card.querySelector('.ma-name').textContent)
    })
    grid.addEventListener('focusin', (event) => {
      const card = event.target instanceof doc.defaultView.Element ? event.target.closest('.ma-card') : null
      if (!card) return
      roving = card.parentElement.dataset.meshKey
      rove(grid)
    })
    grid.addEventListener('keydown', (event) => {
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      const card = event.target instanceof doc.defaultView.Element ? event.target.closest('.ma-card') : null
      const cards = cardsIn(grid)
      const vertical = event.key === 'ArrowUp' || event.key === 'ArrowDown'
      const across = vertical ? columns(cards) : 1
      const step = vertical ? (event.key === 'ArrowUp' ? -1 : 1) * across : MOVES[event.key]
      if (!step || !card) return
      event.preventDefault()
      const index = cards.indexOf(card)
      const at = index + step
      // a row step past the first or last row stays put, except Down from a card with a row below
      // but no card directly below it, which goes to the last card; Home and End go to the ends
      const past = Number.isFinite(step) && (at < 0 || at >= cards.length)
      const below = event.key === 'ArrowDown' && Math.floor(index / across) < Math.floor((cards.length - 1) / across)
      const next = past ? (below ? cards[cards.length - 1] : card) : cards[Math.max(0, Math.min(cards.length - 1, at))]
      if (!next || next === card) return
      next.focus({ preventScroll: true })
      // no `behavior`: focus moves without a scroll animation (V5 §2.2)
      next.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    })
    return root
  }

  function cardEl(key) {
    const el = make('li', 'ma-item')
    el.dataset.meshKey = key
    const card = make('button', 'ma-card')
    card.type = 'button'
    card.dataset.meshOpen = ''
    card.tabIndex = -1
    const dot = make('span', 'ma-dot')
    dot.setAttribute('aria-hidden', 'true')
    const top = make('span', 'ma-line ma-top')
    const state = make('span', 'ma-state')
    state.append(dot, make('span', 'ma-word'))
    top.append(make('span', 'ma-name'), state)
    const base = `ma-d${++ids}`
    const lines = LINES.map((name, index) => {
      const line = make('span', `ma-line ${name}`)
      line.id = `${base}-${index}`
      return line
    })
    const foot = make('span', 'ma-line ma-foot')
    const facts = make('span', 'ma-facts')
    facts.id = `${base}-facts`
    foot.append(facts, make('span', 'ma-badge'))
    card.append(top, ...lines, foot)
    el.append(card)
    return el
  }

  function paintCard(el, row, current) {
    const card = el.firstChild
    for (const name of [...card.classList]) if (name.startsWith('ma-tone-') && name !== `ma-tone-${row.tone}`) card.classList.remove(name)
    if (!card.classList.contains(`ma-tone-${row.tone}`)) card.classList.add(`ma-tone-${row.tone}`)
    setText(card.querySelector('.ma-name'), row.name)
    setText(card.querySelector('.ma-word'), row.word)
    const described = []
    for (const name of LINES) {
      const line = card.querySelector(`.${name}`)
      const text = row[name.slice(3)]
      setText(line, text)
      setHidden(line, !text)
      if (name === 'ma-fix') line.classList.toggle('ma-quiet', row.quiet)
      if (text) described.push(line.id)
    }
    const facts = card.querySelector('.ma-facts')
    setText(facts, row.facts)
    described.push(facts.id)
    setText(card.querySelector('.ma-badge'), row.tag)
    setAttr(card, 'aria-label', `${row.name}, ${row.word}, ${row.tag}`)
    setAttr(card, 'aria-describedby', described.join(' '))
    setAttr(card, 'aria-current', current ? 'true' : null)
  }

  /**
   * Mounts the section in `slot` while there is a body to show; with none (the mesh off) no section exists.
   * @param {Element} slot @param {{body: any, stale: boolean} | null} input @param {number} nowMs
   * @param {string | null} [openKey] the agent whose page is open, whose card carries aria-current
   */
  function paint(slot, input, nowMs, openKey = null) {
    if (!input) {
      root?.remove()
      return
    }
    const section = element()
    if (section.parentNode !== slot) slot.append(section)
    const model = meshRows(input.body, nowMs)
    setText(section.querySelector('.ma-count'), model.count)
    setText(section.querySelector('.ma-checked'), model.checked)
    setHidden(section.querySelector('.ma-checked'), !model.checked)
    setHidden(section.querySelector('.ma-stale'), !input.stale)
    const others = section.querySelector('.ma-others')
    setText(others, model.others)
    setHidden(others, !model.others)
    const grid = section.querySelector('.ma-grid')
    const nodes = model.rows.map((row) => {
      let el = cardEls.get(row.key)
      if (!el) cardEls.set(row.key, (el = cardEl(row.key)))
      paintCard(el, row, row.key === openKey)
      return el
    })
    const keep = new Set(model.rows.map((row) => row.key))
    for (const [key, el] of cardEls) {
      if (keep.has(key)) continue
      el.remove()
      cardEls.delete(key)
    }
    nodes.forEach((el, index) => { if (grid.children[index] !== el) grid.insertBefore(el, grid.children[index] ?? null) })
    rove(grid)
  }

  return {
    paint,
    /** The card button for `key` while it is in the page, else null: the agent page's way back gives it focus. */
    cardFor: (key) => {
      const card = cardEls.get(key)?.firstChild
      return card?.isConnected ? card : null
    },
  }
}
