// The Agents home's Mesh agents section (agent cards view design
// docs/superpowers/specs/2026-11-09-agent-cards-view-design.md §2, V3): one row
// per agent mesh.json configures, from the last `/api/mesh/agents` body app.js
// read. Global: no state filter or project lens narrows it. Card text is
// untrusted: it reaches the DOM only through textContent, never as markup, an
// href or an image. The page owns only the state labels; every reason and fix
// comes from the server. Pressing a row opens its agent tab (cards view V5c1,
// public/mesh-agent-page.js), which shows the card's lines and Card JSON.
// Nothing here is an ask: no state reaches public/attention.js, a badge, a
// count or a tab.
import { relMs } from './rowview.js'

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
const items = (list) => (Array.isArray(list?.items) ? list.items : [])
const count = (list) => items(list).length + (Number(list?.more) || 0)

function whereText(agent) {
  if (agent.where === 'local') return agent.endpoint ? `Local · ${agent.endpoint.replace(/^http:\/\//, '')}` : 'Local'
  if (agent.where === 'tailnet') return 'Remote · tailnet'
  if (agent.where === 'ssh-tunnel') return 'Remote · SSH tunnel'
  return agent.name === 'unslop' ? 'Local' : 'Remote'
}

// §2.2's usage line, unslop's counts only; no usage key (no file, or a refused one) is no line.
function usageText(usage) {
  if (!usage || typeof usage !== 'object' || !Number.isFinite(usage.tasks) || !Number.isFinite(usage.modelMs)) return ''
  return `Today: ${plural(usage.tasks, 'task')} · ${plural(Math.round(usage.modelMs / 60_000), 'model-minute')}`
}

/** The section's model from a `/api/mesh/agents` body: one row per agent, by name. */
export function meshRows(body, nowMs) {
  const agents = (Array.isArray(body?.agents) ? body.agents : []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)))
  const rows = agents.map((agent) => {
    const card = agent.card ?? agent.lastSeen?.card ?? null
    const label = agent.state === 'up' ? (agent.where === 'local' ? 'Running' : 'Reachable') : LABELS[agent.state] ?? 'Unknown state'
    const facts = [whereText(agent)]
    if (card?.version) facts.push(`${/^v\d/.test(card.version) ? '' : 'v'}${card.version}`)
    if (!agent.card && agent.lastSeen?.at) facts.push(`seen ${ago(nowMs - Date.parse(agent.lastSeen.at))}`)
    if (items(card?.interfaces).some((i) => i.protocolVersion === '1.0')) facts.push('A2A 1.0')
    if (card) facts.push(plural(count(card.skills), 'skill'))
    return {
      key: String(agent.key),
      name: String(agent.name),
      tone: agent.state === 'up' ? 'up' : NEUTRAL.has(agent.state) ? 'neutral' : 'amber',
      status: [label, agent.reason].filter(Boolean).join(' · '),
      fix: agent.fix ? `Fix: ${agent.fix}` : '',
      facts: facts.join(' · '),
      usage: usageText(agent.usage),
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

/** @param {{doc?: Document, onRefresh?: () => void, onChange?: () => void, onOpen?: (key: string, name: string) => void}} deps */
export function installMeshAgents(deps = {}) {
  const doc = deps.doc ?? globalThis.document
  // window-local, never persisted: the section opens by default
  let open = true
  const rowEls = new Map()
  let root = null

  const make = (tag, className, text) => {
    const el = doc.createElement(tag)
    if (className) el.className = className
    if (text !== undefined) el.textContent = text
    return el
  }
  const setText = (el, text) => { if (el.textContent !== text) el.textContent = text }
  const setHidden = (el, hidden) => { if (el.hidden !== hidden) el.hidden = hidden }
  const setAttr = (el, name, value) => { if (el.getAttribute(name) !== value) el.setAttribute(name, value) }

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
    const list = make('ul', 'ma-rows')
    body.append(make('p', 'ma-stale', 'could not read; showing what was last read'), list, make('p', 'ma-others'))
    root.append(head, body)
    toggle.addEventListener('click', () => { open = !open; deps.onChange?.() })
    refresh.addEventListener('click', () => deps.onRefresh?.())
    list.addEventListener('click', (event) => {
      const button = event.target instanceof doc.defaultView.Element ? event.target.closest('[data-mesh-open]') : null
      const row = button?.closest('[data-mesh-key]')
      if (row) deps.onOpen?.(row.dataset.meshKey, button.querySelector('.ma-name').textContent)
    })
    return root
  }

  function rowEl(key) {
    const el = make('li', 'ma-row')
    el.dataset.meshKey = key
    const toggle = make('button', 'ma-row-toggle')
    toggle.type = 'button'
    toggle.dataset.meshOpen = ''
    toggle.dataset.dashboardFocusKey = `ma:row:${key}`
    const dot = make('span', 'ma-dot')
    dot.setAttribute('aria-hidden', 'true')
    toggle.append(dot, make('span', 'ma-name'), make('span', 'ma-status'))
    el.append(toggle, make('div', 'ma-facts'), make('div', 'ma-usage'), make('div', 'ma-fix'))
    return el
  }

  function paintRow(el, row) {
    for (const name of [...el.classList]) if (name.startsWith('ma-tone-') && name !== `ma-tone-${row.tone}`) el.classList.remove(name)
    if (!el.classList.contains(`ma-tone-${row.tone}`)) el.classList.add(`ma-tone-${row.tone}`)
    setText(el.querySelector('.ma-name'), row.name)
    setText(el.querySelector('.ma-status'), row.status)
    setText(el.querySelector('.ma-facts'), row.facts)
    const usage = el.querySelector('.ma-usage')
    setText(usage, row.usage)
    setHidden(usage, !row.usage)
    const fix = el.querySelector('.ma-fix')
    setText(fix, row.fix)
    setHidden(fix, !row.fix)
  }

  /**
   * Mounts the section in `slot` while there is a body to show; with none (the mesh off) no section exists.
   * @param {Element} slot @param {{body: any, stale: boolean} | null} input @param {number} nowMs
   */
  function paint(slot, input, nowMs) {
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
    const list = section.querySelector('.ma-rows')
    const nodes = model.rows.map((row) => {
      let el = rowEls.get(row.key)
      if (!el) rowEls.set(row.key, (el = rowEl(row.key)))
      paintRow(el, row)
      return el
    })
    const keep = new Set(model.rows.map((row) => row.key))
    for (const [key, el] of rowEls) {
      if (keep.has(key)) continue
      el.remove()
      rowEls.delete(key)
    }
    nodes.forEach((el, index) => { if (list.children[index] !== el) list.insertBefore(el, list.children[index] ?? null) })
  }

  return {
    paint,
    /** The window-local open state, for frameInputs(). */
    state: () => String(open),
  }
}
