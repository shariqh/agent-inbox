// The Agents home's Mesh agents section (agent cards view design
// docs/superpowers/specs/2026-11-09-agent-cards-view-design.md §2, V3): one card
// per agent mesh.json configures, from the last `/api/mesh/agents` body app.js
// read, in a horizontal strip of fixed-width cards (cards view V5 §2, V5c2).
// Global: no state filter or project lens narrows it. Card text is untrusted: it
// reaches the DOM only through textContent and attributes, never as markup, an
// href or an image. The page owns only the state labels; every reason and fix
// comes from the server. Pressing a card opens its agent tab (cards view V5c1,
// public/mesh-agent-page.js), which shows the card's lines and Card JSON. The
// strip is one Tab stop: Left/Right/Home/End rove between cards, kept by the
// server's `key`, so a repaint never moves focus. Nothing here is an ask: no
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
}
const NEUTRAL = new Set(['unchecked', 'checking', 'not-running'])
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`
const ago = (ms) => (relMs(Math.max(0, ms)) === 'moments' ? 'just now' : `${relMs(Math.max(0, ms))} ago`)

// V5 §2.1's short form, never a host or port: Details shows the endpoint
function whereText(agent) {
  if (agent.where === 'local') return 'Local'
  if (agent.where === 'tailnet') return 'Remote · tailnet'
  if (agent.where === 'ssh-tunnel') return 'Remote · SSH tunnel'
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
    return {
      key: String(agent.key),
      name: String(agent.name),
      tone: agent.state === 'up' ? 'up' : NEUTRAL.has(agent.state) ? 'neutral' : 'amber',
      word: label,
      status: [label, agent.reason].filter(Boolean).join(' · '),
      fix: agent.fix ? `Fix: ${agent.fix}` : '',
      facts: facts.join(' · '),
      usage: usageText(agent.usage),
      // V5 §2.1's last line: when the newest run ended, by the label clock, and how
      lastrun: lastRunText(agent.lastRun, nowMs),
    }
  })
  const checked = agents.map((a) => Date.parse(a.checkedAt ?? '')).filter(Number.isFinite)
  const others = Number(body?.others) || 0
  return {
    title: `Mesh agents (${rows.length})`,
    checked: checked.length ? `checked ${ago(nowMs - Math.min(...checked))}` : 'not checked yet',
    others: others ? `${plural(others, 'other agent')} in mesh.json ${others === 1 ? 'is' : 'are'} not shown by this build` : '',
    rows,
  }
}


// V5 §2.2: Left/Right step, Home/End go to the ends; J/K stay the session cards' keys
const MOVES = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity }
// a card's description lines, in order, by class; ids come from a counter, never a name
const LINES = ['ma-status', 'ma-fix', 'ma-facts', 'ma-usage', 'ma-lastrun']
let ids = 0

/** @param {{doc?: Document, onRefresh?: () => void, onChange?: () => void, onOpen?: (key: string, name: string) => void}} deps */
export function installMeshAgents(deps = {}) {
  const doc = deps.doc ?? globalThis.document
  // window-local, never persisted: the section opens by default
  let open = true
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
  const cardsIn = (strip) => [...strip.querySelectorAll(':scope > li > .ma-card')]
  function rove(strip) {
    const cards = cardsIn(strip)
    if (!cards.some((el) => el.parentElement.dataset.meshKey === roving)) roving = cards[0]?.parentElement.dataset.meshKey ?? null
    for (const el of cards) {
      const tab = el.parentElement.dataset.meshKey === roving ? 0 : -1
      if (el.tabIndex !== tab) el.tabIndex = tab
    }
  }

  function element() {
    if (root) return root
    root = make('section', 'mesh-agents')
    root.setAttribute('aria-label', 'Mesh agents')
    const head = make('div', 'ma-head')
    const toggle = make('button', 'ma-toggle')
    toggle.type = 'button'
    toggle.dataset.dashboardFocusKey = 'ma:section'
    toggle.setAttribute('aria-controls', 'meshAgentsBody')
    // Refresh is the toggle's sibling, never inside it, so a press never folds the section
    const refresh = make('button', 'ma-refresh', 'Refresh')
    refresh.type = 'button'
    refresh.dataset.dashboardFocusKey = 'ma:refresh'
    refresh.title = 'Check every mesh agent’s card now'
    head.append(toggle, make('span', 'ah-spacer'), make('small', 'ma-checked'), refresh)
    const body = make('div', 'ma-body')
    body.id = 'meshAgentsBody'
    // the explicit role keeps list semantics in WebKit under `list-style: none`
    const strip = make('ul', 'ma-strip')
    strip.setAttribute('role', 'list')
    body.append(make('p', 'ma-stale', 'could not read; showing what was last read'), strip, make('p', 'ma-others'))
    root.append(head, body)
    toggle.addEventListener('click', () => { open = !open; deps.onChange?.() })
    refresh.addEventListener('click', () => deps.onRefresh?.())
    strip.addEventListener('click', (event) => {
      const card = event.target instanceof doc.defaultView.Element ? event.target.closest('.ma-card') : null
      if (card) deps.onOpen?.(card.parentElement.dataset.meshKey, card.querySelector('.ma-name').textContent)
    })
    strip.addEventListener('focusin', (event) => {
      const card = event.target instanceof doc.defaultView.Element ? event.target.closest('.ma-card') : null
      if (!card) return
      roving = card.parentElement.dataset.meshKey
      rove(strip)
    })
    strip.addEventListener('keydown', (event) => {
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      const move = MOVES[event.key]
      const card = event.target instanceof doc.defaultView.Element ? event.target.closest('.ma-card') : null
      if (!move || !card) return
      event.preventDefault()
      const cards = cardsIn(strip)
      const next = cards[Math.max(0, Math.min(cards.length - 1, cards.indexOf(card) + move))]
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
    card.dataset.dashboardFocusKey = `ma:card:${key}`
    card.tabIndex = -1
    const dot = make('span', 'ma-dot')
    dot.setAttribute('aria-hidden', 'true')
    const title = make('span', 'ma-line ma-title')
    title.append(dot, make('span', 'ma-name'))
    const base = `ma-d${++ids}`
    card.append(title, ...LINES.map((name, index) => {
      const line = make('span', `ma-line ${name}`)
      line.id = `${base}-${index}`
      return line
    }))
    el.append(card)
    return el
  }

  function paintCard(el, row, current) {
    const card = el.firstChild
    for (const name of [...card.classList]) if (name.startsWith('ma-tone-') && name !== `ma-tone-${row.tone}`) card.classList.remove(name)
    if (!card.classList.contains(`ma-tone-${row.tone}`)) card.classList.add(`ma-tone-${row.tone}`)
    setText(card.querySelector('.ma-name'), row.name)
    const described = []
    for (const name of LINES) {
      const line = card.querySelector(`.${name}`)
      const text = row[name.slice(3)]
      setText(line, text)
      setHidden(line, !text)
      if (text) described.push(line.id)
    }
    setAttr(card, 'aria-label', `${row.name}, ${row.word}`)
    setAttr(card, 'aria-describedby', described.join(' '))
    setAttr(card, 'aria-current', current ? 'true' : null)
  }

  /**
   * Mounts the section in `slot` while there is a body to show; with none (the mesh off) no section exists.
   * @param {Element} slot @param {{body: any, stale: boolean} | null} input @param {number} nowMs
   * @param {string | null} [openKey] the agent the agent tab holds, whose card carries aria-current
   */
  function paint(slot, input, nowMs, openKey = null) {
    if (!input) {
      root?.remove()
      return
    }
    const section = element()
    if (section.parentNode !== slot) slot.append(section)
    const model = meshRows(input.body, nowMs)
    const toggle = section.querySelector('.ma-toggle')
    setText(toggle, model.title)
    setAttr(toggle, 'aria-expanded', String(open))
    setText(section.querySelector('.ma-checked'), model.checked)
    setHidden(section.querySelector('.ma-body'), !open)
    setHidden(section.querySelector('.ma-stale'), !input.stale)
    const others = section.querySelector('.ma-others')
    setText(others, model.others)
    setHidden(others, !model.others)
    const strip = section.querySelector('.ma-strip')
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
    nodes.forEach((el, index) => { if (strip.children[index] !== el) strip.insertBefore(el, strip.children[index] ?? null) })
    rove(strip)
  }

  return {
    paint,
    /** The window-local open state, for frameInputs(). */
    state: () => String(open),
  }
}
