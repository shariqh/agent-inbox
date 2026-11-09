// The Agents home's Mesh agents section (agent cards view design
// docs/superpowers/specs/2026-11-09-agent-cards-view-design.md §2, V3): one row
// per agent mesh.json configures, from the last `/api/mesh/agents` body app.js
// read. Global: no state filter or project lens narrows it. Card text is
// untrusted: it reaches the DOM only through textContent, never as markup, an
// href or an image, and the raw card is a <pre>'s text. The page owns only the
// state labels; every reason and fix comes from the server. Nothing here is
// an ask: no state reaches public/attention.js, a badge, a count or a tab.
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
const AUTH = {
  httpAuthSecurityScheme: 'HTTP', apiKeySecurityScheme: 'API key', oauth2SecurityScheme: 'OAuth 2',
  openIdConnectSecurityScheme: 'OpenID Connect', mtlsSecurityScheme: 'mutual TLS',
}

const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`
const ago = (ms) => (relMs(Math.max(0, ms)) === 'moments' ? 'just now' : `${relMs(Math.max(0, ms))} ago`)
const clock = (at) => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const more = (list) => (list?.more ? [`+${list.more} more`] : [])
const items = (list) => (Array.isArray(list?.items) ? list.items : [])
const count = (list) => items(list).length + (Number(list?.more) || 0)
const yes = (value) => (value === true ? 'yes' : value === false ? 'no' : 'not said')

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

// §2.3's labelled lines, from the card the row shows (its own, else the last good one).
function details(agent, card, nowMs) {
  const lines = []
  if (card?.description) lines.push(['Description', [card.description]])
  if (card?.name && card.name !== agent.name) lines.push(['Card name', [card.name]])
  const where = [agent.where === 'local' ? 'Local' : 'Remote', agent.endpoint ?? 'endpoint not shown'].join(' · ')
  lines.push(['Where', [where, ...(agent.profile ? [`profile: ${agent.profile}`] : [])]])
  if (card) {
    lines.push(['Protocol', [...items(card.interfaces).flatMap((i) => [
      `A2A ${i.protocolVersion ?? '?'} · ${i.binding === 'JSONRPC' ? 'JSON-RPC' : i.binding ?? '?'}`, ...(i.url ? [i.url] : []),
    ]), ...more(card.interfaces)]])
    lines.push(['Capabilities', [`streaming ${yes(card.streaming)} · push ${yes(card.pushNotifications)}`]])
    const schemes = items(card.auth?.schemes)
    const required = card.auth?.required ? ', required' : ''
    lines.push(['Auth', schemes.length
      ? [...schemes.map((s) => `${s.name} (${[AUTH[s.type] ?? s.type, s.scheme].filter(Boolean).join(' ')})${required}`),
        'token kept outside the app; not shown here']
      : ['none declared']])
    for (const ext of items(card.extensions)) {
      const params = items(ext.params).map(([key, value]) => `${key} ${value}`)
      lines.push(['Extension', [`${ext.uri} · ${ext.required ? 'required' : 'optional'}`, ...(params.length ? [params.join(' · ')] : []), ...more(ext.params)]])
    }
    if (card.extensions?.more) lines.push(['Extension', more(card.extensions)])
    lines.push(['Skills', [...items(card.skills).map((s) => ({
      text: `${s.name ?? s.id}${s.id && s.name && s.id !== s.name ? ` (${s.id})` : ''}${s.description ? `: ${s.description}` : ''}`,
      tags: [...items(s.tags), ...more(s.tags)],
    })), ...more(card.skills)]])
    lines.push(['Modes', [`in ${[...items(card.inputModes), ...more(card.inputModes)].join(', ') || 'none'} · out ${[...items(card.outputModes), ...more(card.outputModes)].join(', ') || 'none'}`]])
  }
  const checked = agent.checkedAt ? `checked ${clock(agent.checkedAt)}` : 'not checked yet'
  const fetched = agent.card ? ` · card fetched ${clock(agent.checkedAt)}` : agent.lastSeen?.at ? ` · last good card ${clock(agent.lastSeen.at)} (${ago(nowMs - Date.parse(agent.lastSeen.at))})` : ''
  lines.push(['Checked', [checked + fetched]])
  return lines
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
      details: details(agent, card, nowMs),
      json: typeof agent.cardJson === 'string' ? agent.cardJson : null,
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

/** @param {{doc?: Document, onRefresh?: () => void, onChange?: () => void}} deps */
export function installMeshAgents(deps = {}) {
  const doc = deps.doc ?? globalThis.document
  // window-local, never persisted: the section opens by default, its rows and Card JSON closed
  let open = true
  const rowsOpen = new Set()
  const jsonOpen = new Set()
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
  const flip = (set, key) => { if (set.has(key)) set.delete(key); else set.add(key) }

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
      const button = event.target instanceof doc.defaultView.Element ? event.target.closest('[data-mesh-toggle]') : null
      if (!button) return
      flip(rowsOpen, button.closest('[data-mesh-key]').dataset.meshKey)
      deps.onChange?.()
    })
    list.addEventListener('toggle', (event) => {
      const json = event.target
      const key = json instanceof doc.defaultView.HTMLDetailsElement ? json.closest('[data-mesh-key]')?.dataset.meshKey : null
      if (!key || json.open === jsonOpen.has(key)) return
      flip(jsonOpen, key)
      deps.onChange?.()
    }, true)
    return root
  }

  function rowEl(key) {
    const el = make('li', 'ma-row')
    el.dataset.meshKey = key
    const toggle = make('button', 'ma-row-toggle')
    toggle.type = 'button'
    toggle.dataset.meshToggle = ''
    toggle.dataset.dashboardFocusKey = `ma:row:${key}`
    const dot = make('span', 'ma-dot')
    dot.setAttribute('aria-hidden', 'true')
    toggle.append(dot, make('span', 'ma-name'), make('span', 'ma-status'))
    const json = make('details', 'ma-json')
    json.append(make('summary', '', 'Card JSON'), make('pre', 'ma-json-text'))
    const more = make('div', 'ma-details')
    more.append(make('dl', 'ma-lines'), json)
    el.append(toggle, make('div', 'ma-facts'), make('div', 'ma-usage'), make('div', 'ma-fix'), more)
    return el
  }

  function line(value) {
    if (typeof value === 'string') return make('div', '', value)
    const el = make('div', '', value.text)
    for (const tag of value.tags) el.append(doc.createTextNode(' '), make('span', 'ma-tag', tag))
    return el
  }

  function paintRow(el, row) {
    for (const name of [...el.classList]) if (name.startsWith('ma-tone-') && name !== `ma-tone-${row.tone}`) el.classList.remove(name)
    if (!el.classList.contains(`ma-tone-${row.tone}`)) el.classList.add(`ma-tone-${row.tone}`)
    const expanded = rowsOpen.has(row.key)
    setAttr(el.querySelector('.ma-row-toggle'), 'aria-expanded', String(expanded))
    setText(el.querySelector('.ma-name'), row.name)
    setText(el.querySelector('.ma-status'), row.status)
    setText(el.querySelector('.ma-facts'), row.facts)
    const usage = el.querySelector('.ma-usage')
    setText(usage, row.usage)
    setHidden(usage, !row.usage)
    const fix = el.querySelector('.ma-fix')
    setText(fix, row.fix)
    setHidden(fix, !row.fix)
    const more = el.querySelector('.ma-details')
    setHidden(more, !expanded)
    // a closed row keeps no details, as a closed fold keeps no cards
    const lines = el.querySelector('.ma-lines')
    const linesKey = expanded ? JSON.stringify(row.details) : ''
    if (lines.dataset.key !== linesKey) {
      lines.dataset.key = linesKey
      lines.replaceChildren(...(expanded ? row.details.flatMap(([label, values]) => {
        const dd = make('dd')
        dd.append(...values.map(line))
        return [make('dt', '', label), dd]
      }) : []))
    }
    const json = el.querySelector('.ma-json')
    setHidden(json, !row.json)
    const jsonShown = jsonOpen.has(row.key)
    if (json.open !== jsonShown) json.open = jsonShown
    // rewritten only when the card's JSON changed, so a selection inside it survives polls
    setText(json.querySelector('pre'), expanded && jsonShown && row.json ? row.json : '')
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
    state: () => [open, [...rowsOpen].sort().join(','), [...jsonOpen].sort().join(',')].join('|'),
  }
}
