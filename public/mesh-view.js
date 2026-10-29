// The Agents view (Mesh M1, #397; design docs/superpowers/specs/
// 2026-10-29-agent-mesh-design.md §10.1–10.2). Loaded ONLY by app.js's
// `import('/mesh-view.js')`, and only after /api/version says
// `mesh.agentsView`, so with the mesh off the page never requests this file.
//
// It adds a Sessions | Agents lens above the Dashboard lanes and a Settings →
// Mesh section. The Agents lens groups the same /api/activity presence Live and
// the lanes read by inferred agent kind, then project and branch. Nothing here
// is new data: liveness is the lanes' `isWorking` and Live's `isDormant`, "last
// call" is `last_call_at` (never the `updated_at` heartbeat), the call trace is
// the lanes' `callTrace`, and "Asking you" READS the frame's attention entries.
// It never feeds attention, a badge, a count, a tab, the rail or the dock.
// No fetch, no timer, no animation. Agent text reaches the DOM only through
// textContent.
import { callTrace, isWorking, tracePath, TRACE_MINUTES } from './lanes.js'
import { activitySynopsis, isDormant } from './livebar.js'
import { relMs } from './rowview.js'
import { sortRail } from './attention.js'

const STATE_RANK = { working: 0, idle: 1, dormant: 2 }

// The kind that raised an ask: an item's own agent, a plan row's asker (#217's
// `action_agent`), else the plan's last writer.
const askAgent = (entry) => entry.kind === 'item'
  ? entry.item?.agent
  : entry.row?.action_agent || entry.board?.agent

const sessionState = (row, nowMs) => isWorking(row, nowMs) ? 'working' : isDormant(row, nowMs) ? 'dormant' : 'idle'

/**
 * The Agents lens model. Pure: the clock is `nowMs`.
 * @param {{activity: any[], attention: any[], closed?: Iterable<string>, nowMs: number}} input
 *   `activity` is what the lanes read (the lens-filtered /api/activity rows);
 *   `attention` is the frame's attention entries for the same lens.
 */
export function agentGroups({ activity, attention, closed = [], nowMs }) {
  const shut = new Set(closed)
  const byAgent = new Map()
  for (const row of activity ?? []) {
    if (!row?.project || shut.has(row.project)) continue
    const agent = typeof row.agent === 'string' && row.agent ? row.agent : 'unknown'
    const group = byAgent.get(agent) ?? { agent, sessions: [], working: 0, trace: new Array(TRACE_MINUTES).fill(0), asks: [] }
    byAgent.set(agent, group)
    const state = sessionState(row, nowMs)
    const synopsis = activitySynopsis(row)
    const callAt = Date.parse(row.last_call_at ?? '')
    const startAt = Date.parse(row.started_at ?? '')
    const since = Number.isFinite(callAt) ? callAt : startAt
    group.sessions.push({
      session: String(row.session ?? ''),
      project: String(row.project),
      branch: typeof row.stream === 'string' ? row.stream : '',
      state,
      text: synopsis.text,
      historical: synopsis.historical || state !== 'working',
      called: Number.isFinite(callAt),
      sinceMs: Number.isFinite(since) ? Math.max(0, nowMs - since) : null,
    })
    if (state === 'working') group.working += 1
    callTrace(row, nowMs).forEach((count, index) => { group.trace[index] += count })
  }
  for (const entry of attention ?? []) {
    const group = byAgent.get(askAgent(entry))
    if (group) group.asks.push(entry)
  }
  const groups = [...byAgent.values()]
  for (const group of groups) {
    group.sessions.sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state]
      || a.project.localeCompare(b.project) || a.branch.localeCompare(b.branch) || (a.session < b.session ? -1 : 1))
    group.asks = sortRail(group.asks, nowMs)
  }
  return groups.sort((a, b) => b.working - a.working || b.sessions.length - a.sessions.length || a.agent.localeCompare(b.agent))
}

// What a session row says about time, from the last real call.
export function sessionRecency(session) {
  if (session.sinceMs == null) return ''
  const since = relMs(session.sinceMs)
  if (session.state === 'working') {
    if (!session.called) return 'no call yet'
    return since === 'moments' ? 'last call just now' : `last call ${since} ago`
  }
  return since === 'moments' ? 'idle <1m' : `idle ${since}`
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * @param {{ doc?: Document, jumpToAsk: (entry: any) => void }} options
 *   `jumpToAsk` is the lanes' own: it opens an ask on the rail or in the Inbox.
 */
export function installMeshView({ doc = globalThis.document, jumpToAsk }) {
  // Window-local, like the lanes' quick filters: a fresh window opens on Sessions.
  let lens = 'sessions'
  let last = null
  let drawnKey = null
  let firstAsks = new Map()

  const make = (tag, className, text) => {
    const el = doc.createElement(tag)
    if (className) el.className = className
    if (text !== undefined) el.textContent = text
    return el
  }

  function lensEl() {
    const bar = make('div', 'mesh-lens')
    bar.setAttribute('role', 'group')
    bar.setAttribute('aria-label', 'Dashboard lens')
    for (const [value, label] of [['sessions', 'Sessions'], ['agents', 'Agents']]) {
      const button = make('button', 'mesh-lens-option', label)
      button.type = 'button'
      button.dataset.meshLens = value
      button.dataset.dashboardFocusKey = `mesh:lens:${value}`
      button.addEventListener('click', () => {
        if (lens === value) return
        lens = value
        if (last) paint(last.host, last.input)
      })
      bar.appendChild(button)
    }
    return bar
  }

  function agentsEl() {
    const section = make('section', 'dashboard-card mesh-agents')
    section.setAttribute('aria-labelledby', 'meshAgentsTitle')
    const head = make('div', 'dashboard-card-head')
    const title = make('h2', '', 'Agents')
    title.id = 'meshAgentsTitle'
    head.append(title, make('small', 'mesh-agents-note', 'From this computer’s Live presence. No registry, no network request.'))
    const list = make('div', 'mesh-agent-list')
    list.setAttribute('role', 'list')
    const empty = make('p', 'mesh-agents-empty', 'No agent connections.')
    empty.hidden = true
    section.append(head, list, empty)
    return section
  }

  function cardEl(group) {
    const card = make('article', 'mesh-agent')
    card.setAttribute('role', 'listitem')
    card.dataset.meshAgent = group.agent
    const top = make('div', 'mesh-agent-top')
    top.append(
      make('h3', 'mesh-agent-name', group.agent),
      make('span', 'mesh-chip tone-agent', plural(group.sessions.length, 'session')),
      make('span', 'mesh-chip', `${group.working} working`),
    )
    const sessions = make('div', 'mesh-sessions')
    for (const session of group.sessions) {
      const line = make('div', `mesh-session ${session.state}`)
      line.dataset.meshSession = session.session
      const dot = make('span', 'mesh-dot')
      dot.setAttribute('aria-hidden', 'true')
      const where = make('span', 'mesh-where')
      where.append(make('strong', 'mesh-project', session.project))
      if (session.branch) where.append(make('span', 'mesh-branch', session.branch))
      const doing = make('span', 'mesh-doing', session.historical && session.text !== 'No task reported yet' ? `was: ${session.text}` : session.text)
      doing.title = doing.textContent
      line.append(dot, where, doing, make('span', 'mesh-recency', sessionRecency(session)), make('span', 'mesh-chip mesh-state', session.state))
      sessions.appendChild(line)
    }
    const foot = make('div', 'mesh-agent-foot')
    if (group.asks.length) {
      const ask = make('button', 'mesh-asking')
      ask.type = 'button'
      ask.dataset.dashboardFocusKey = `mesh:ask:${group.agent}`
      ask.append(make('span', '', 'Asking you: '), make('strong', 'mesh-ask-count', String(group.asks.length)), make('span', '', ' →'))
      ask.title = 'Open this agent’s oldest-ranked ask'
      ask.addEventListener('click', () => jumpToAsk?.(firstAsks.get(group.agent)))
      foot.appendChild(ask)
    }
    const calls = group.trace.reduce((sum, count) => sum + count, 0)
    if (calls) {
      const trace = make('span', 'mesh-trace')
      trace.append(make('span', '', 'MCP calls, 30 min'))
      const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('class', 'mesh-spark')
      svg.setAttribute('viewBox', '0 0 60 12')
      svg.setAttribute('preserveAspectRatio', 'none')
      svg.setAttribute('role', 'img')
      svg.setAttribute('aria-label', `${plural(calls, 'MCP call')} in the last 30 minutes`)
      const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', tracePath(group.trace))
      svg.appendChild(path)
      trace.append(svg, make('span', 'mesh-trace-count', String(calls)))
      foot.appendChild(trace)
    }
    card.append(top, sessions)
    if (foot.childNodes.length) card.append(foot)
    return card
  }

  /**
   * Painted from app.js's renderDashboardAmbient, so from both render entries.
   * @param {Element} host `#dashboard .dashboard`, once its grid is mounted
   */
  function paint(host, input) {
    last = { host, input }
    const grid = host?.querySelector('.dashboard-grid')
    const lanes = grid?.querySelector('.dash-lanes')
    if (!grid || !lanes) return
    let bar = host.querySelector('.mesh-lens')
    if (!bar) {
      bar = lensEl()
      host.insertBefore(bar, grid)
    }
    for (const button of bar.querySelectorAll('[data-mesh-lens]')) {
      const pressed = String(button.dataset.meshLens === lens)
      if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed)
    }
    let section = grid.querySelector('.mesh-agents')
    if (!section) {
      section = agentsEl()
      lanes.after(section)
      drawnKey = null
    }
    const agents = lens === 'agents'
    if (lanes.hidden !== agents) lanes.hidden = agents
    if (section.hidden !== !agents) section.hidden = !agents
    if (!agents) return
    const groups = agentGroups(input)
    firstAsks = new Map(groups.filter((group) => group.asks.length).map((group) => [group.agent, group.asks[0]]))
    // Rebuilt only when what it shows changed, so an unchanged paint keeps its
    // nodes (and any selection or focus in them).
    const key = JSON.stringify(groups.map((group) => [group.agent, group.working, group.asks.length, group.trace,
      group.sessions.map((session) => [session.session, session.project, session.branch, session.state, session.text, session.historical, sessionRecency(session)])]))
    const empty = section.querySelector('.mesh-agents-empty')
    if (empty.hidden !== groups.length > 0) empty.hidden = groups.length > 0
    if (key === drawnKey) return
    drawnKey = key
    const list = section.querySelector('.mesh-agent-list')
    const focusKey = list.contains(doc.activeElement) ? doc.activeElement?.dataset?.dashboardFocusKey : null
    list.replaceChildren(...groups.map(cardEl))
    if (focusKey && doc.hasFocus?.()) {
      list.querySelector(`[data-dashboard-focus-key="${globalThis.CSS?.escape?.(focusKey) ?? focusKey}"]`)?.focus({ preventScroll: true })
    }
  }

  /** Settings → Mesh: what is on, and the exact command that turns it off. */
  function renderSettings(host) {
    if (!host || host.querySelector('.mesh-settings')) return
    const section = make('section', 'setup-block mesh-settings')
    section.id = 'mesh-settings'
    const off = 'agent-inbox-meshctl disable --apply'
    const command = make('pre', 'mesh-off-command', off)
    section.append(
      make('h3', '', 'Mesh'),
      make('p', 'setup-hint', 'Agents view: on. The Dashboard offers a Sessions | Agents lens that groups Live sessions by agent. It reads nothing new and sends nothing anywhere.'),
      make('p', 'setup-hint', 'mesh.json turns it on, and this page reads it when it loads. To turn it off, run this, then reload the window:'),
      command,
      make('p', 'setup-hint', 'From a source checkout: npm run meshctl -- disable --apply'),
    )
    const after = host.querySelector('#link-settings')
    if (after) after.after(section)
    else host.appendChild(section)
  }

  return { paint, renderSettings }
}
