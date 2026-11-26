// An agent's page inside the Agent cards tab (Agent cards step 1, D3; cards view V5 design
// docs/superpowers/specs/2026-11-09-agent-cards-view-v5-design.md §3, §4, V5c1): one agent
// opened from a card in "Yours". One slot: opening another agent replaces it;
// "← Agent cards" (or Escape) goes back to the grid; nothing is persisted, so a reload starts
// without it. The page owns its way back, its header (state dot, name, state word and reason,
// Built in or Added by you, checked, Refresh), the fix, usage and last-run lines the card left
// out, and an inner tablist. Details is exactly what V3's expanded row showed: the card's lines
// and a nested Card JSON whose <pre> is rewritten only when it changes. Run history (V5d,
// public/mesh-runs-tab.js) is the inner tablist's first tab and the default on every open.
// Card text is untrusted: textContent only, no href, no image. Nothing here is an ask.
import { relMs } from './rowview.js'
import { meshRows } from './mesh-section.js'
import { installRunsTab } from './mesh-runs-tab.js'

const AUTH = {
  httpAuthSecurityScheme: 'HTTP', apiKeySecurityScheme: 'API key', oauth2SecurityScheme: 'OAuth 2',
  openIdConnectSecurityScheme: 'OpenID Connect', mtlsSecurityScheme: 'mutual TLS',
}
// [id, label]; the first is the default each time an agent opens (V5 §4)
const INNER = [['runs', 'Run history'], ['details', 'Details']]
const GONE = 'This agent is not in mesh.json any more'
// step 2b (D4): an agent the app has just turned on (or added by its card address), until the viewer's next read names it
const PENDING = 'Turned on. Its details show in a moment.'
const ADDED = 'Added. Its details show in a moment.'

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
  // a built-in agent's own line (the server's) stands in only while no card text at all is known
  const described = card ? card.description : agent.blurb
  if (described) lines.push(['Description', [described]])
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
  // the app never checks an added agent: no "Checked" line claims it (the page says so once, in the header)
  if (agent.kind === 'added') return lines
  const checked = agent.checkedAt ? `checked ${clock(agent.checkedAt)}` : 'not checked yet'
  const fetched = agent.card ? ` · card fetched ${clock(agent.checkedAt)}` : agent.lastSeen?.at ? ` · last good card ${clock(agent.lastSeen.at)} (${ago(nowMs - Date.parse(agent.lastSeen.at))})` : ''
  lines.push(['Checked', [checked + fetched]])
  return lines
}

/**
 * @param {{doc?: Document, page: () => HTMLElement | null,
 *   wireTablist?: (host: Element, orientation: string) => void,
 *   onRefresh?: (name: string) => void, onBack?: () => void}} deps
 */
export function installMeshAgentPage(deps) {
  const doc = deps.doc ?? globalThis.document
  // window-local, never persisted (§3.3): the open agent, its inner tab, and which agents' Card JSON is open
  let current = null
  let inner = INNER[0][0]
  const jsonOpen = new Set()
  const runs = installRunsTab({ doc })
  // the last runs input paint() was given, for an inner tab switch's repaint
  let lastRuns = null
  let lastNow = 0

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
    // the way back to the grid, first in the page's reading and Tab order
    const back = make('button', 'map-back', '← Agent cards')
    back.type = 'button'
    back.setAttribute('aria-label', 'Back to Agent cards')
    const head = make('div', 'map-head')
    const dot = make('span', 'ma-dot')
    dot.setAttribute('aria-hidden', 'true')
    const refresh = make('button', 'map-refresh', 'Refresh')
    refresh.type = 'button'
    refresh.title = 'Check this agent’s card now'
    // the agent's name is the page title above (the top bar's heading), not repeated here
    head.append(dot, make('span', 'map-status'), make('span', 'map-badge'), make('span', 'ah-spacer'), make('small', 'map-checked'), refresh)
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
    page.append(back, head, make('p', 'map-note'), make('div', 'ma-fix'), make('p', 'map-usage'), make('p', 'map-lastrun'), make('p', 'map-gone', GONE),
      make('p', 'ma-stale', 'could not read; showing what was last read'), tabs, ...panels)
    deps.wireTablist?.(tabs, 'horizontal')
    refresh.addEventListener('click', () => { if (current) deps.onRefresh?.(current.name) })
    back.addEventListener('click', () => deps.onBack?.())
    // switching posts nothing and repaints only this region, from the last model
    tabs.addEventListener('click', (event) => {
      const tab = event.target instanceof doc.defaultView.Element ? event.target.closest('[data-map-tab]') : null
      if (!tab || tab.dataset.mapTab === inner) return
      inner = tab.dataset.mapTab
      paintInner(page)
      if (inner === 'runs') paintRuns(page)
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

  // the runs body belongs to the agent it was read for; another agent's never shows
  function paintRuns(page) {
    if (!current) return
    runs.paint(page.querySelector('#agentPagePanel-runs'), lastRuns?.key === current.key ? lastRuns : null, lastNow)
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
   * Paints the open agent's page from the last `/api/mesh/agents` body. An agent the body no
   * longer names (or a body that says the mesh is off) keeps its last lines, under one line
   * saying so; before any body is read there is neither. Run history paints from `runsInput`,
   * the last `/api/mesh/agents/runs` body for `key`.
   * @param {{body: any, stale: boolean} | null} input @param {number} nowMs
   * @param {{key: string, body: any, stale: boolean} | null} [runsInput]
   */
  function paint(input, nowMs, runsInput = null) {
    const page = deps.page()
    if (!page || !current) return
    build(page)
    const body = input?.body
    const agent = body?.on === true && Array.isArray(body.agents) ? body.agents.find((a) => String(a.key) === current.key) : undefined
    // a deep link names its agent before the first read: the name shows, and no line says it left
    if (agent && current.name !== String(agent.name)) current = { ...current, name: String(agent.name) }
    if (agent && current.pending) current = { key: current.key, name: current.name }
    const gone = page.querySelector('.map-gone')
    setText(gone, current.pending === 'added' ? ADDED : current.pending ? PENDING : GONE)
    setHidden(gone, Boolean(agent) || (!body && !current.pending))
    setHidden(page.querySelector('.ma-stale'), !(agent && input?.stale))
    paintInner(page)
    lastRuns = runsInput
    lastNow = nowMs
    paintRuns(page)
    if (!agent) return
    const model = meshRows({ on: true, agents: [agent], others: 0 }, nowMs)
    const row = model.rows[0]
    setTone(page.querySelector('.map-head'), row.tone)
    setText(page.querySelector('.map-status'), row.status)
    setText(page.querySelector('.map-badge'), row.tag)
    // an added agent is never checked by the app: no "checked" text, no Refresh, the server's one line
    setText(page.querySelector('.map-checked'), row.added ? '' : model.checked)
    setHidden(page.querySelector('.map-checked'), row.added)
    setHidden(page.querySelector('.map-refresh'), row.added)
    setText(page.querySelector('.map-note'), row.note)
    setHidden(page.querySelector('.map-note'), !row.note)
    // the fix, a local agent's usage and the last run, each in full and only when there is one
    for (const [selector, text] of [['.ma-fix', row.fix], ['.map-usage', row.usage], ['.map-lastrun', row.lastrun]]) {
      const el = page.querySelector(selector)
      setText(el, text)
      setHidden(el, !text)
    }
    page.querySelector('.ma-fix').classList.toggle('ma-quiet', row.quiet)
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
    /**
     * Opens `key` in the one slot, replacing any other; each open starts on the default inner tab.
     * `pending`: the app has just turned it on (`'added'`: added it), so until a read names it the page says so, not that it left.
     */
    open(key, name, { pending = false } = {}) {
      runs.reset(current?.key !== key)
      if (current?.key !== key) {
        // another agent's lines never show under this one's name
        const lines = deps.page()?.querySelector('.ma-lines')
        if (lines) {
          lines.replaceChildren()
          lines.dataset.key = ''
        }
        lastJson = null
      }
      current = pending ? { key, name, pending: pending === 'added' ? 'added' : true } : { key, name }
      inner = INNER[0][0]
    },
    close() { current = null },
    /** The open agent, or null. */
    current: () => current,
    /** Whether Run history is the inner tab showing: the runs read's gate (V5 §5.7). */
    runsShowing: () => Boolean(current) && inner === 'runs',
    /** The window-local page state, for frameInputs(). */
    state: () => [current?.key ?? '', inner, [...jsonOpen].sort().join(','), runs.state()].join('|'),
  }
}
