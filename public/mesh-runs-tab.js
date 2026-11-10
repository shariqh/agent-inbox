// The agent tab's Run history (cards view V5 design
// docs/superpowers/specs/2026-11-09-agent-cards-view-v5-design.md §5.8, V5d): the
// newest run records `/api/mesh/agents/runs` returns for the open agent, as a
// summary line, a table keyed by run `id` and sorted by end time, Show more, an
// empty state and a footer with the forget command the server sends as data.
// Records never change, so a new run inserts one row at its sorted place and no
// other row is rebuilt; the only text that changes in an old row is its Ended
// cell, through the label clock. Every value reaches the DOM through
// textContent: no markup, no href, no image. Nothing here is an ask.

const PAGE = 50
const DAY_MS = 24 * 60 * 60 * 1000
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
// the record's outcome words (src/mesh-runs.ts) in the page's words, in the summary's order
const OUTCOMES = {
  ok: 'ok', 'kept-original': 'kept original', 'sources-only': 'sources only', refused: 'refused', busy: 'busy',
  failed: 'failed', unknown: 'outcome unknown', unavailable: 'unavailable', conflict: 'conflict',
  'timed-out': 'timed out', interrupted: 'interrupted',
}
const AMBER = new Set(['failed', 'unknown', 'unavailable', 'timed-out', 'interrupted'])
const EMPTY = 'No runs yet. Calls through this agent appear here once they finish; calls made before this version were not recorded.'
const OLDER = 'Older runs in the kept period are not shown.'

const pad = (n) => String(n).padStart(2, '0')
const clock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
const date = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const midnight = (ms) => {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
// whole local days between the two dates, so a DST day still counts as one
const daysAgo = (ms, nowMs) => Math.round((midnight(nowMs) - midnight(ms)) / DAY_MS)

/** When a run ended: a clock time today, a weekday within the last 6 days (with the time when `withTime`), else the date. */
function ended(at, nowMs, withTime) {
  const ms = Date.parse(at)
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms)
  const days = daysAgo(ms, nowMs)
  if (days <= 0) return clock(d)
  if (days <= 6) return withTime ? `${WEEKDAYS[d.getDay()]} ${clock(d)}` : WEEKDAYS[d.getDay()]
  return date(d)
}

/** A duration as "0.2 s", "31 s", "4 min", "3 h 50 min". */
function took(ms) {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min`
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  return `${Math.floor(ms / 3_600_000)} h${minutes ? ` ${minutes} min` : ''}`
}

const outcomeWord = (outcome) => OUTCOMES[outcome] ?? String(outcome ?? '')

/** The card's last-run line from `/api/mesh/agents`'s `lastRun` (§2.1); empty for a body without the key. */
export function lastRunText(lastRun, nowMs) {
  if (lastRun === undefined) return ''
  if (!lastRun) return 'No runs yet'
  return ['Last run', [ended(lastRun.at, nowMs, false), outcomeWord(lastRun.outcome)].filter(Boolean).join(' · ')].join(' ')
}

// the Outcome cell: unslop's status or request-post's final phase on a clean end, else the outcome's words
function outcomeText(run) {
  if (run.outcome === 'ok') {
    if (run.agent === 'unslop' && (run.status === 'rewritten' || run.status === 'unchanged')) return run.status
    if (run.agent === 'request-post' && run.op === 'file') return run.created === false ? 'already filed' : 'filed'
    if (run.agent === 'request-post' && run.phase) return run.phase
  }
  return outcomeWord(run.outcome)
}

const list = (value) => (Array.isArray(value) ? value.filter((s) => typeof s === 'string') : [])
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`

// the Details cell's facts, joined with " · "
function detailsText(run, outcome) {
  const facts = []
  if (run.agent === 'unslop') {
    if (Number.isFinite(run.timing?.model)) facts.push(`model ${took(run.timing.model)}`)
    if (Number.isFinite(run.attempts)) facts.push(plural(run.attempts, 'attempt'))
    if (run.rules) facts.push(`rules ${run.rules}`)
    if (Number.isFinite(run.bytesIn)) facts.push(`${(run.bytesIn / 1000).toFixed(1)} KB`)
  }
  if (run.agent === 'request-post') {
    if (run.phase && run.phase !== outcome) facts.push(run.phase)
    if (list(run.channels).length) facts.push(list(run.channels).join(', '))
    if (run.brand) facts.push(run.brand)
    if (list(run.fields).length) facts.push(`fields: ${list(run.fields).join(', ')}`)
  }
  const classes = list(run.classes)
  if (classes.length) facts.push(`${run.reason ?? 'classes'}: ${classes.join(', ')}`)
  else if (run.reason) facts.push(run.reason)
  if (list(run.warnings).length) facts.push(`warnings: ${list(run.warnings).join(', ')}`)
  if (run.signal) facts.push(run.signal)
  return facts.join(' · ')
}

const stamp = (ms) => {
  const d = new Date(ms)
  return `${date(d)} ${clock(d)}:${pad(d.getSeconds())}`
}

/** One row's fixed cells (all but Ended, which follows the clock). */
function runRow(run) {
  const end = Date.parse(run.at)
  const outcome = outcomeText(run)
  return {
    title: Number.isFinite(end) ? `started ${stamp(end - (Number(run.ms) || 0))} · ended ${stamp(end)}` : '',
    what: run.op === 'wait' && run.throughGo === true ? 'wait (through go)' : String(run.op ?? ''),
    outcome,
    amber: AMBER.has(run.outcome),
    took: took(run.ms),
    details: detailsText(run, outcome),
  }
}

function summary(runs) {
  const counts = new Map()
  for (const run of runs) counts.set(run.outcome, (counts.get(run.outcome) ?? 0) + 1)
  const order = Object.keys(OUTCOMES)
  const parts = [...counts].sort(([a], [b]) => (order.indexOf(a) >>> 0) - (order.indexOf(b) >>> 0))
    .map(([outcome, n]) => `${n} ${outcomeWord(outcome)}`)
  const ms = runs.map((r) => r.ms).filter(Number.isFinite).sort((a, b) => a - b)
  const mid = ms.length >> 1
  if (ms.length) parts.push(`median ${took(ms.length % 2 ? ms[mid] : (ms[mid - 1] + ms[mid]) / 2)}`)
  return `Last ${plural(runs.length, 'run')}: ${parts.join(' · ')}`
}

/** @param {{doc: Document}} deps */
export function installRunsTab({ doc }) {
  // window-local: how many rows show; every open starts at one page
  let shown = PAGE
  let rowEls = new Map()
  let lastInput = null
  let lastPanel = null
  let lastNow = 0

  const make = (tag, className, text) => {
    const el = doc.createElement(tag)
    if (className) el.className = className
    if (text !== undefined) el.textContent = text
    return el
  }
  const setText = (el, text) => { if (el.textContent !== text) el.textContent = text }
  const setHidden = (el, hidden) => { if (el.hidden !== hidden) el.hidden = hidden }

  function build(panel) {
    if (panel.querySelector('.mar-summary')) return
    const table = make('table', 'mar-table')
    const head = make('tr')
    for (const label of ['Ended', 'What', 'Outcome', 'Took', 'Details']) {
      const th = make('th', '', label)
      th.scope = 'col'
      head.append(th)
    }
    table.append(make('thead'), make('tbody'))
    table.tHead.append(head)
    const more = make('button', 'mar-more', `Show ${PAGE} more`)
    more.type = 'button'
    more.addEventListener('click', () => {
      shown += PAGE
      // repaints only this region, from the last model
      if (lastPanel) paint(lastPanel, lastInput, lastNow)
    })
    const forget = make('p', 'mar-forget')
    const copy = make('button', 'mar-copy', 'Copy')
    copy.type = 'button'
    copy.addEventListener('click', async () => {
      const text = forget.querySelector('code').textContent
      try {
        await doc.defaultView.navigator.clipboard.writeText(text)
        copy.textContent = 'Copied'
      } catch {
        copy.textContent = 'Copy failed'
      }
      doc.defaultView.setTimeout(() => { copy.textContent = 'Copy' }, 1500)
    })
    forget.append('To forget them now: ', make('code', 'mar-command'), ' ', copy)
    panel.append(
      make('p', 'mar-stale'), make('p', 'mar-summary'), make('p', 'mar-empty', EMPTY), table, more, make('p', 'mar-older', OLDER),
      make('div', 'mar-foot'),
    )
    panel.querySelector('.mar-foot').append(make('p', 'mar-kept'), forget)
  }

  function rowEl(run, model) {
    const tr = make('tr')
    tr.dataset.runId = run.id
    const end = make('td', 'mar-ended')
    if (model.title) end.title = model.title
    const outcome = make('td', `mar-outcome${model.amber ? ' mar-amber' : ''}`, model.outcome)
    tr.append(end, make('td', 'mar-what', model.what), outcome, make('td', 'mar-took', model.took), make('td', 'mar-details', model.details))
    return tr
  }

  /**
   * Paints Run history from the last runs body for the open agent, or nothing read yet.
   * @param {HTMLElement} panel @param {{body: any, stale: boolean} | null} input @param {number} nowMs
   */
  function paint(panel, input, nowMs) {
    build(panel)
    lastPanel = panel
    lastInput = input
    lastNow = nowMs
    const body = input?.body?.on === true && Array.isArray(input.body.runs) ? input.body : null
    const runs = body ? body.runs.filter((r) => r && typeof r.id === 'string') : []
    const stale = panel.querySelector('.mar-stale')
    setText(stale, body ? 'could not read; showing what was last read' : 'could not read the run history')
    setHidden(stale, !input?.stale)
    const table = panel.querySelector('.mar-table')
    setHidden(panel.querySelector('.mar-empty'), !body || runs.length > 0)
    setHidden(table, !runs.length)
    const sum = panel.querySelector('.mar-summary')
    setText(sum, runs.length ? summary(runs) : '')
    setHidden(sum, !runs.length)
    const tbody = table.tBodies[0]
    const visible = runs.slice(0, shown)
    const keep = new Set(visible.map((r) => r.id))
    for (const [id, el] of rowEls) {
      if (keep.has(id)) continue
      el.remove()
      rowEls.delete(id)
    }
    visible.forEach((run, index) => {
      let el = rowEls.get(run.id)
      if (!el) rowEls.set(run.id, (el = rowEl(run, runRow(run))))
      // only the Ended text changes, and only when the clock moved it past midnight or a week
      setText(el.firstChild, ended(run.at, nowMs, true))
      if (tbody.children[index] !== el) tbody.insertBefore(el, tbody.children[index] ?? null)
    })
    setHidden(panel.querySelector('.mar-more'), runs.length <= shown)
    setHidden(panel.querySelector('.mar-older'), !body?.older)
    const foot = panel.querySelector('.mar-foot')
    setHidden(foot, !body)
    const days = Number.isInteger(body?.keptDays) ? body.keptDays : 30
    setText(foot.querySelector('.mar-kept'), `Runs from the last ${days} days are shown. Older records are deleted by this agent’s first run of a day, or the next time an agent is enabled or disabled. Never the text sent or returned.`)
    const forget = typeof body?.forget === 'string' ? body.forget : ''
    setText(foot.querySelector('.mar-command'), forget)
    setHidden(foot.querySelector('.mar-forget'), !forget)
  }

  return {
    paint,
    /** An agent opened: one page of rows; another agent's rows never show under this one's name. */
    reset(otherAgent) {
      shown = PAGE
      if (!otherAgent) return
      for (const el of rowEls.values()) el.remove()
      rowEls = new Map()
      lastInput = null
    },
    /** The window-local rows shown, for the page's state(). */
    state: () => String(shown),
  }
}
