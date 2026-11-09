// The agent tab's page (cards view V5 design
// docs/superpowers/specs/2026-11-09-agent-cards-view-v5-design.md §3, §4, V5c1):
// one mesh agent opened from the Agents home's Mesh agents section, in the
// library's sixth tab. One slot: opening another agent replaces it; Close hides
// it; nothing is persisted, so a reload starts without it. The page owns its
// header (state dot, name, state word, checked, Refresh, Close) and an inner
// tablist. Details is exactly what V3's expanded row showed: the card's lines
// and a nested Card JSON whose <pre> is rewritten only when it changes. Run
// history joins the inner tablist, as the default, in V5d; until then the page
// opens on Details. Card text is untrusted: textContent only, no href, no image.
// Nothing here is an ask: the tab never carries a count.
import { relMs } from './rowview.js'
import { meshRows } from './mesh-section.js'

const AUTH = {
  httpAuthSecurityScheme: 'HTTP', apiKeySecurityScheme: 'API key', oauth2SecurityScheme: 'OAuth 2',
  openIdConnectSecurityScheme: 'OpenID Connect', mtlsSecurityScheme: 'mutual TLS',
}
// [id, label]; V5d puts ['runs', 'Run history'] first and makes it the default
const INNER = [['details', 'Details']]
const GONE = 'This agent is not in mesh.json any more'

const ago = (ms) => (relMs(Math.max(0, ms)) === 'moments' ? 'just now' : `${relMs(Math.max(0, ms))} ago`)
const clock = (at) => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const more = (list) => (list?.more ? [`+${list.more} more`] : [])
const items = (list) => (Array.isArray(list?.items) ? list.items : [])
const yes = (value) => (value === true ? 'yes' : value === false ? 'no' : 'not said')

// The cards design's §2.3 labelled lines, from the card the agent shows (its own, else the last good one).
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

/**
 * @param {{doc?: Document, tab: () => HTMLElement | null, page: () => HTMLElement | null,
 *   wireTablist?: (host: Element, orientation: string) => void,
 *   onRefresh?: (name: string) => void, onClose?: () => void}} deps
 */
export function installMeshAgentPage(deps) {
  const doc = deps.doc ?? globalThis.document
  // window-local, never persisted (§3.3): the open agent, its inner tab, and which agents' Card JSON is open
  let current = null
  let inner = INNER[0][0]
  const jsonOpen = new Set()

  const make = (tag, className, text) => {
    const el = doc.createElement(tag)
    if (className) el.className = className
    if (text !== undefined) el.textContent = text
    return el
  }
  const setText = (el, text) => { if (el.textContent !== text) el.textContent = text }
  const setHidden = (el, hidden) => { if (el.hidden !== hidden) el.hidden = hidden }
  const setAttr = (el, name, value) => { if (el.getAttribute(name) !== value) el.setAttribute(name, value) }
  const setTone = (el, tone) => {
    for (const name of [...el.classList]) if (name.startsWith('ma-tone-') && name !== `ma-tone-${tone}`) el.classList.remove(name)
    if (!el.classList.contains(`ma-tone-${tone}`)) el.classList.add(`ma-tone-${tone}`)
  }

  function build(page) {
    if (page.querySelector('.map-head')) return
    const head = make('div', 'map-head')
    const dot = make('span', 'ma-dot')
    dot.setAttribute('aria-hidden', 'true')
    const refresh = make('button', 'map-refresh', 'Refresh')
    refresh.type = 'button'
    refresh.title = 'Check this agent’s card now'
    const close = make('button', 'map-close', 'Close')
    close.type = 'button'
    close.title = 'Close this agent’s tab'
    head.append(dot, make('span', 'map-name'), make('span', 'map-status'), make('span', 'ah-spacer'), make('small', 'map-checked'), refresh, close)
    const tabs = make('div', 'map-tabs')
    tabs.setAttribute('aria-label', 'Agent views')
    const panels = INNER.map(([id, label]) => {
      const tab = make('button', 'map-tab', label)
      tab.type = 'button'
      tab.setAttribute('role', 'tab')
      tab.id = `agentPageTab-${id}`
      tab.dataset.mapTab = id
      tab.setAttribute('aria-controls', `agentPagePanel-${id}`)
      tabs.append(tab)
      const panel = make('div', 'map-panel')
      panel.id = `agentPagePanel-${id}`
      panel.setAttribute('role', 'tabpanel')
      panel.setAttribute('aria-labelledby', tab.id)
      return panel
    })
    const json = make('details', 'ma-json')
    json.append(make('summary', '', 'Card JSON'), make('pre', 'ma-json-text'))
    panels[INNER.findIndex(([id]) => id === 'details')].append(make('dl', 'ma-lines'), json)
    page.append(head, make('div', 'ma-fix'), make('p', 'map-gone', GONE), make('p', 'ma-stale', 'could not read; showing what was last read'), tabs, ...panels)
    deps.wireTablist?.(tabs, 'horizontal')
    refresh.addEventListener('click', () => { if (current) deps.onRefresh?.(current.name) })
    close.addEventListener('click', () => deps.onClose?.())
    // switching posts nothing and repaints only this region, from the last model
    tabs.addEventListener('click', (event) => {
      const tab = event.target instanceof doc.defaultView.Element ? event.target.closest('[data-map-tab]') : null
      if (!tab || tab.dataset.mapTab === inner) return
      inner = tab.dataset.mapTab
      paintInner(page)
    })
    json.addEventListener('toggle', () => {
      if (!current || json.open === jsonOpen.has(current.key)) return
      if (json.open) jsonOpen.add(current.key)
      else jsonOpen.delete(current.key)
      paintJson(page)
    })
  }

  function paintInner(page) {
    for (const tab of page.querySelectorAll('[data-map-tab]')) {
      const on = tab.dataset.mapTab === inner
      setAttr(tab, 'aria-selected', String(on))
      tab.tabIndex = on ? 0 : -1
    }
    for (const [id] of INNER) setHidden(page.querySelector(`#agentPagePanel-${id}`), id !== inner)
  }

  // rewritten only when the card's JSON changed, so a selection inside it survives polls
  let lastJson = null
  function paintJson(page) {
    const json = page.querySelector('.ma-json')
    setHidden(json, !lastJson)
    const shown = Boolean(current && jsonOpen.has(current.key))
    if (json.open !== shown) json.open = shown
    setText(json.querySelector('pre'), shown && lastJson ? lastJson : '')
  }

  function line(value) {
    if (typeof value === 'string') return make('div', '', value)
    const el = make('div', '', value.text)
    for (const tag of value.tags) el.append(doc.createTextNode(' '), make('span', 'ma-tag', tag))
    return el
  }

  /**
   * Paints the tab and, while an agent is open, its page from the last `/api/mesh/agents` body.
   * An agent the body no longer names keeps its tab and last lines, under one line saying so.
   * @param {{body: any, stale: boolean} | null} input @param {number} nowMs
   */
  function paint(input, nowMs) {
    const tab = deps.tab()
    const page = deps.page()
    if (!tab || !page) return
    setHidden(tab, !current)
    if (!current) return
    build(page)
    const body = input?.body
    const agent = body?.on === true && Array.isArray(body.agents) ? body.agents.find((a) => String(a.key) === current.key) : undefined
    setHidden(page.querySelector('.map-gone'), Boolean(agent))
    setHidden(page.querySelector('.ma-stale'), !(agent && input?.stale))
    setText(tab.querySelector('.tab-name'), current.name)
    setText(page.querySelector('.map-name'), current.name)
    paintInner(page)
    if (!agent) return
    const model = meshRows({ on: true, agents: [agent], others: 0 }, nowMs)
    const row = model.rows[0]
    setTone(tab, row.tone)
    setTone(page.querySelector('.map-head'), row.tone)
    setText(page.querySelector('.map-status'), row.status)
    setText(page.querySelector('.map-checked'), model.checked)
    const fix = page.querySelector('.ma-fix')
    setText(fix, row.fix)
    setHidden(fix, !row.fix)
    const lines = page.querySelector('.ma-lines')
    const linesData = details(agent, agent.card ?? agent.lastSeen?.card ?? null, nowMs)
    const linesKey = JSON.stringify(linesData)
    if (lines.dataset.key !== linesKey) {
      lines.dataset.key = linesKey
      lines.replaceChildren(...linesData.flatMap(([label, values]) => {
        const dd = make('dd')
        dd.append(...values.map(line))
        return [make('dt', '', label), dd]
      }))
    }
    lastJson = typeof agent.cardJson === 'string' ? agent.cardJson : null
    paintJson(page)
  }

  return {
    paint,
    /** Opens `key` in the one slot, replacing any other; each open starts on the default inner tab. */
    open(key, name) {
      if (current?.key !== key) {
        // another agent's lines never show under this one's name
        const lines = deps.page()?.querySelector('.ma-lines')
        if (lines) {
          lines.replaceChildren()
          lines.dataset.key = ''
        }
        lastJson = null
      }
      current = { key, name }
      inner = INNER[0][0]
    },
    close() { current = null },
    /** The open agent, or null. */
    current: () => current,
    /** The window-local page state, for frameInputs(). */
    state: () => [current?.key ?? '', inner, [...jsonOpen].sort().join(',')].join('|'),
  }
}
