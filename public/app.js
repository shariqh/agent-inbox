let lastData = null
const FILTER_KEY = 'agent-inbox-agent-filter'
const PROJECT_KEY = 'agent-inbox-project-filter'
const HIDE_DONE_KEY = 'agent-inbox-hide-completed'
let agentFilter = localStorage.getItem(FILTER_KEY) || null
let projectFilter = localStorage.getItem(PROJECT_KEY) || null
let hideCompleted = localStorage.getItem(HIDE_DONE_KEY) !== 'false' // default ON

let bootId = null

async function load() {
  try {
    const res = await fetch('/api/items')
    const boot = res.headers.get('x-inbox-boot')
    if (bootId && boot && bootId !== boot) { location.reload(); return } // server restarted → pick up fresh frontend
    if (boot) bootId = boot
    const g = await res.json()
    const boards = await (await fetch('/api/boards')).json()
    const archived = await (await fetch('/api/boards/archived')).json()
    lastData = { g, boards, archived }
    render()
    document.getElementById('status').textContent = ''
  } catch {
    document.getElementById('status').textContent = 'disconnected'
  }
}

function allItems(g) {
  return [...g.needsYou.flatMap((x) => x.items), ...g.notes.flatMap((x) => x.items), ...g.done]
}

function collectAgents({ g, boards }) {
  return [...new Set([...allItems(g).map((i) => i.agent), ...boards.map((b) => b.agent)])].sort()
}

function collectProjects({ g, boards, archived }) {
  return [...new Set([
    ...allItems(g).map((i) => i.project),
    ...boards.map((b) => b.project),
    ...archived.map((b) => b.project),
  ])].sort()
}

// the slice of the data matching only the project filter — agent tabs derive
// from this, so switching project shows just that project's agents
function projectScoped({ g, boards, archived }) {
  if (!projectFilter) return { g, boards, archived }
  const keep = (x) => x.project === projectFilter
  return {
    g: { needsYou: g.needsYou.filter(keep), notes: g.notes.filter(keep), done: g.done.filter(keep) },
    boards: boards.filter(keep),
    archived: archived.filter(keep),
  }
}

function render() {
  const projects = collectProjects(lastData)
  if (projectFilter && !projects.includes(projectFilter)) projectFilter = null
  renderPills('projectTabs', 'project', projects, projectFilter, (v) => {
    projectFilter = v
    if (v) localStorage.setItem(PROJECT_KEY, v)
    else localStorage.removeItem(PROJECT_KEY)
    render()
  })
  const agents = collectAgents(projectScoped(lastData))
  if (agentFilter && !agents.includes(agentFilter)) agentFilter = null
  renderPills('agentTabs', 'agent', agents, agentFilter, (v) => {
    agentFilter = v
    if (v) localStorage.setItem(FILTER_KEY, v)
    else localStorage.removeItem(FILTER_KEY)
    render()
  })
  renderRowToggle()
  // prune collapse state against ALL cards, not the filtered view, so
  // switching tabs never drops state for cards the filter is hiding
  liveCardIds = new Set([...allItems(lastData.g).map((i) => i.id), ...lastData.boards.map((b) => b.id), ...lastData.archived.map((b) => b.id)])
  renderNow()
  const { g, boards, archived } = filterData(lastData)
  renderGroups('needsYou', g.needsYou)
  renderGroups('notes', g.notes)
  renderDone(g.done)
  renderBoards(boards)
  renderArchived(archived)
  setCount('needsYou', g.needsYou.reduce((n, gr) => n + gr.items.filter((i) => !i.reply).length, 0))
  setCount('notes', g.notes.reduce((n, gr) => n + gr.items.length, 0))
  setCount('done', g.done.length)
  setCount('boards', boards.length)
  setCount('archived', archived.length)
  pruneCollapsedCards()
}

// "waiting 2h" style relative age — the agent-blocked clock
function rel(iso) {
  const m = Math.floor((Date.now() - Date.parse(iso)) / 60000)
  if (m < 1) return 'moments'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

// the Now strip reflects GLOBAL state, ignoring filters: "do I need to do
// anything?" must never be hidden by a filter. State-driven only — an
// unanswered question stays loud however old it is.
function renderNow() {
  const host = document.getElementById('now')
  const allQs = lastData.g.needsYou.flatMap((gr) => gr.items)
  const qs = allQs.filter((i) => !i.reply) // answered questions are the agent's problem now
  const awaitingPickup = allQs.filter((i) => i.reply && !i.reply_seen_at).length
  const milestones = lastData.g.done.filter((i) => i.kind === 'done' && i.status === 'open').length
  const total = lastData.boards.length
  const complete = lastData.boards.filter((b) => b.progress.fraction === 1 && b.progress.countable > 0).length
  const rest = []
  if (awaitingPickup) rest.push(`${awaitingPickup} answered · awaiting agent`)
  if (milestones) rest.push(`${milestones} milestone${milestones > 1 ? 's' : ''}`)
  if (total) rest.push(`${total} board${total > 1 ? 's' : ''}${complete ? ` · ${complete} complete` : ''}`)
  const tail = rest.length ? ` &nbsp;·&nbsp; ${rest.join(' &nbsp;·&nbsp; ')}` : ''
  host.hidden = false
  if (qs.length) {
    // attention state carries ONLY what needs the human — ambient status
    // (boards, milestones) stays out of the red banner
    const oldest = qs.reduce((a, b) => (a.created_at < b.created_at ? a : b))
    host.className = 'attention'
    host.innerHTML = `<div><strong>${qs.length} question${qs.length > 1 ? 's' : ''} need${qs.length > 1 ? '' : 's'} you</strong> — oldest waiting ${rel(oldest.created_at)}</div>`
    // each waiting item is a link straight to its card
    const list = document.createElement('div')
    list.className = 'now-items'
    for (const q of qs) {
      const a = document.createElement('a')
      a.href = '#'
      a.textContent = `${q.project} · ${q.title}`
      a.title = q.title
      a.addEventListener('click', (e) => {
        e.preventDefault()
        jumpToCard('needsYou', q.id)
      })
      list.appendChild(a)
    }
    host.appendChild(list)
  } else {
    host.className = 'calm'
    host.innerHTML = `Nothing needs you${tail}`
  }
}

function jumpToCard(sectionId, cardId) {
  document.getElementById(sectionId).open = true
  const card = document.querySelector(`[data-card-id="${CSS.escape(cardId)}"]`)
  if (card) {
    card.open = true
    card.scrollIntoView({ behavior: 'smooth', block: 'start' })
  } else {
    // the card may be hidden by an active filter — clear filters and retry
    projectFilter = null
    agentFilter = null
    localStorage.removeItem(PROJECT_KEY)
    localStorage.removeItem(FILTER_KEY)
    render()
    const retry = document.querySelector(`[data-card-id="${CSS.escape(cardId)}"]`)
    if (retry) {
      retry.open = true
      retry.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }
}

function setCount(sectionId, n) {
  const link = document.querySelector(`#sidebar a[data-target="${sectionId}"]`)
  if (!link.dataset.base) link.dataset.base = link.textContent
  link.textContent = n ? `${link.dataset.base} (${n})` : link.dataset.base
  const h2 = document.querySelector(`#${sectionId} > summary h2`)
  if (!h2.dataset.base) h2.dataset.base = h2.textContent
  h2.textContent = n ? `${h2.dataset.base} (${n})` : h2.dataset.base
}

function filterData({ g, boards, archived }) {
  const pf = projectFilter
  const af = agentFilter
  if (!pf && !af) return { g, boards, archived }
  const keepItem = (i) => (!pf || i.project === pf) && (!af || i.agent === af)
  const keepBoard = (b) => (!pf || b.project === pf) && (!af || b.agent === af)
  const only = (groups) => groups
    .filter((gr) => !pf || gr.project === pf)
    .map((gr) => ({ ...gr, items: gr.items.filter((i) => !af || i.agent === af) }))
    .filter((gr) => gr.items.length > 0)
  return {
    g: { needsYou: only(g.needsYou), notes: only(g.notes), done: g.done.filter(keepItem) },
    boards: boards.filter(keepBoard),
    archived: archived.filter(keepBoard),
  }
}

function renderRowToggle() {
  const host = document.getElementById('rowTabs')
  const sig = String(hideCompleted)
  if (host.dataset.sig === sig) return
  host.dataset.sig = sig
  host.innerHTML = ''
  const tag = document.createElement('span')
  tag.className = 'tab-label'
  tag.textContent = 'rows'
  host.appendChild(tag)
  const b = document.createElement('button')
  b.textContent = 'hide completed'
  if (hideCompleted) b.classList.add('active')
  b.addEventListener('click', () => {
    hideCompleted = !hideCompleted
    localStorage.setItem(HIDE_DONE_KEY, String(hideCompleted))
    render()
  })
  host.appendChild(b)
}

function renderPills(hostId, label, values, current, onPick) {
  const host = document.getElementById(hostId)
  const sig = JSON.stringify([values, current])
  if (host.dataset.sig === sig) return
  host.dataset.sig = sig
  host.innerHTML = ''
  if (values.length === 0) return
  // always render when there is anything to show — even a single-option strip
  // tells you what you're looking at (and that the filter exists)
  const tag = document.createElement('span')
  tag.className = 'tab-label'
  tag.textContent = label
  host.appendChild(tag)
  for (const v of [null, ...values]) {
    const b = document.createElement('button')
    b.textContent = v ?? 'All'
    if (v === current) b.classList.add('active')
    b.addEventListener('click', () => onPick(v))
    host.appendChild(b)
  }
}

function renderGroups(sectionId, groups) {
  const host = document.querySelector(`#${sectionId} .groups`)
  host.innerHTML = groups.length ? '' : '<p class="empty">Nothing here.</p>'
  for (const grp of groups) {
    const box = document.createElement('div')
    box.className = 'project'
    box.innerHTML = `<h3>${esc(grp.project)}</h3>`
    const byAgent = new Map()
    for (const it of grp.items) {
      const arr = byAgent.get(it.agent) ?? []
      arr.push(it)
      byAgent.set(it.agent, arr)
    }
    if (byAgent.size > 1) {
      // multi-agent project: agent sub-headers carry the attribution
      for (const [agent, items] of byAgent) {
        const head = document.createElement('h4')
        head.className = 'agent-head'
        head.textContent = agent
        box.appendChild(head)
        for (const it of items) box.appendChild(itemEl(it, false, true))
      }
    } else {
      for (const it of grp.items) box.appendChild(itemEl(it))
    }
    host.appendChild(box)
  }
  renderSub(sectionId, groups.flatMap((g) => g.items.map((it) => ({ id: it.id, label: it.title }))))
}

function renderDone(items) {
  const host = document.querySelector('#done .items')
  host.innerHTML = items.length ? '' : '<p class="empty">Nothing yet.</p>'
  // closed items are action-less; OPEN milestones (kind=done) keep their
  // actions so the human can clear them
  for (const it of items) host.appendChild(itemEl(it, it.status !== 'open'))
  renderSub('done', items.map((it) => ({ id: it.id, label: it.title })))
}

const GLYPH = { done: '✅', partial: '⚠️', missing: '❌', tracked: '🔜', na: '➖' }

// row-context <details> the user has expanded, by row id — the whole board DOM is
// rebuilt on every poll, so open state must live outside it
const openContexts = new Set()

// collapsed cards (items + boards) by id — same rebuild problem, but also persisted
const CARDS_KEY = 'agent-inbox-cards-collapsed'
let collapsedCards = {}
try { collapsedCards = JSON.parse(localStorage.getItem(CARDS_KEY)) || {} } catch { /* fresh start */ }
let liveCardIds = new Set() // ids seen in the current render, for pruning stale keys

function setCardCollapsed(id, collapsed) {
  if (collapsed) collapsedCards[id] = true
  else delete collapsedCards[id]
  localStorage.setItem(CARDS_KEY, JSON.stringify(collapsedCards))
}

function pruneCollapsedCards() {
  let changed = false
  for (const id of Object.keys(collapsedCards)) {
    if (!liveCardIds.has(id)) { delete collapsedCards[id]; changed = true }
  }
  if (changed) localStorage.setItem(CARDS_KEY, JSON.stringify(collapsedCards))
}

function cardify(el, id) {
  el.dataset.cardId = id
  liveCardIds.add(id)
  if (!collapsedCards[id]) el.open = true
  el.addEventListener('toggle', () => setCardCollapsed(id, !el.open))
}

function renderSub(sectionId, entries) {
  const host = document.querySelector(`#sidebar .sub[data-sub="${sectionId}"]`)
  // skip the rebuild when nothing changed, so poll cycles don't yank links out
  // from under the cursor (or invalidate an in-flight click)
  const sig = JSON.stringify(entries)
  if (host.dataset.sig === sig) return
  host.dataset.sig = sig
  host.innerHTML = ''
  for (const { id, label } of entries) {
    const a = document.createElement('a')
    a.href = '#'
    a.textContent = label
    a.title = label
    a.addEventListener('click', (e) => {
      e.preventDefault()
      document.getElementById(sectionId).open = true
      const card = document.querySelector(`[data-card-id="${CSS.escape(id)}"]`)
      if (card) {
        card.open = true
        card.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    })
    host.appendChild(a)
  }
}

function renderBoards(boards) {
  const host = document.querySelector('#boards .boards')
  host.innerHTML = boards.length ? '' : '<p class="empty">No boards.</p>'
  for (const b of boards) host.appendChild(boardEl(b))
  renderSub('boards', boards.map((b) => ({ id: b.id, label: b.title })))
}

function renderArchived(boards) {
  const host = document.querySelector('#archived .boards')
  host.innerHTML = boards.length ? '' : '<p class="empty">Nothing archived.</p>'
  for (const b of boards) host.appendChild(boardEl(b, true))
  renderSub('archived', boards.map((b) => ({ id: b.id, label: b.title })))
}

function boardEl(b, archived = false) {
  const el = document.createElement('details')
  const complete = b.progress.fraction === 1 && b.progress.countable > 0
  el.className = `board${complete ? ' complete' : ''}`
  const pct = Math.round(b.progress.fraction * 100)
  const stream = b.stream ? ` · ${esc(b.stream)}` : ''
  el.innerHTML = `
    <summary class="card-summary">
      <div class="board-head">
        <div class="board-title"><span class="caret"></span>${esc(b.title)}<span class="board-id" title="board id">#${esc(b.id.slice(0, 6))}</span></div>
        <div class="board-meta">${esc(b.project)}${stream} · ${esc(b.agent)}</div>
      </div>
      <div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>
      <div class="bar-label">${b.progress.done}/${b.progress.countable} done · ${pct}%${complete ? '<span class="complete-badge">✓ complete</span>' : ''}${hideCompleted && b.progress.done > 0 ? `<span class="hidden-hint">· ${b.progress.done} hidden</span>` : ''}</div>
    </summary>`
  cardify(el, b.id)
  const table = document.createElement('table')
  table.className = 'board-table'
  for (const [i, r] of b.rows.entries()) {
    // hide-completed skips done rows; i stays the original index so the
    // visible row numbers keep matching "row N" references
    if (hideCompleted && r.status === 'done') continue
    const tr = document.createElement('tr')
    const context = r.context
      ? `<details class="row-context"${openContexts.has(r.id) ? ' open' : ''}><summary>context</summary><div>${esc(r.context)}</div></details>`
      : ''
    tr.innerHTML = `
      <td class="row-num">${i + 1}</td>
      <td class="pill ${r.status}">${GLYPH[r.status] || ''}</td>
      <td class="row-label">${esc(r.label)}</td>
      <td class="row-note">${esc(r.note)}${context}${r.annotation ? `<div class="annotation">📝 ${esc(r.annotation)}${r.annotation_unseen ? '<span class="unseen" title="Not yet seen by the agent">●</span>' : ''}</div>` : ''}</td>`
    const ctxEl = tr.querySelector('.row-context')
    if (ctxEl) ctxEl.addEventListener('toggle', () => { ctxEl.open ? openContexts.add(r.id) : openContexts.delete(r.id) })
    if (!archived) {
      const actionTd = document.createElement('td')
      actionTd.className = 'row-action'
      actionTd.appendChild(btn('📝', async () => {
        const text = prompt('Your note on this row:', r.annotation || '')
        if (text != null) { await fetch(`/api/boards/${b.id}/rows/${r.id}/annotate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }); load() }
      }))
      tr.appendChild(actionTd)
    }
    table.appendChild(tr)
  }
  el.appendChild(table)
  const actions = document.createElement('div')
  actions.className = 'actions'
  if (archived) {
    actions.appendChild(btn('Un-archive', async () => { await fetch(`/api/boards/${b.id}/unarchive`, { method: 'POST' }); load() }))
  } else {
    actions.appendChild(archiveBtn(b.id))
  }
  el.appendChild(actions)
  return el
}

// two-step inline confirm: first click arms ("Really archive?"), second click within
// 4s archives; it disarms after 4s (and implicitly on re-render — the DOM is rebuilt)
function archiveBtn(boardId) {
  let timer = null
  const el = btn('Archive', async () => {
    if (el.classList.contains('confirm')) {
      clearTimeout(timer)
      await fetch(`/api/boards/${boardId}/archive`, { method: 'POST' })
      load()
      return
    }
    el.classList.add('confirm')
    el.textContent = 'Really archive?'
    timer = setTimeout(() => {
      el.classList.remove('confirm')
      el.textContent = 'Archive'
    }, 4000)
  })
  return el
}

// answer-back UI state that must survive the 3s poll rebuild
const openCompares = new Set()   // item ids with the compare view expanded
const draftReplies = {}          // item id → in-progress free-text answer
let draftFocusId = null          // which draft input had focus, to restore it

async function sendReply(id, text) {
  if (!text.trim()) return
  delete draftReplies[id]
  if (draftFocusId === id) draftFocusId = null
  await fetch(`/api/items/${id}/reply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: text.trim() }) })
  load()
}

// the answer surface on an unanswered question: option pills (recommended
// first), a Compare toggle for the tradeoffs, and a free-text answer
function answerEl(it) {
  const wrap = document.createElement('div')
  wrap.className = `options${openCompares.has(it.id) ? ' comparing' : ''}`
  const opts = [...(it.options ?? [])].sort((a, b) => (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0))
  for (const o of opts) {
    const box = document.createElement('div')
    box.className = 'option'
    const pill = document.createElement('button')
    pill.className = `opt-pill${o.recommended ? ' rec' : ''}`
    pill.innerHTML = `${esc(o.label)}${o.recommended ? '<span class="rec-tag">recommended</span>' : ''}`
    pill.addEventListener('click', () => sendReply(it.id, o.label))
    box.appendChild(pill)
    if (o.detail) {
      const d = document.createElement('div')
      d.className = 'opt-detail'
      d.textContent = o.detail
      box.appendChild(d)
    }
    wrap.appendChild(box)
  }
  const row = document.createElement('div')
  row.className = 'reply-row'
  if (opts.some((o) => o.detail)) {
    const cmp = btn(openCompares.has(it.id) ? 'Hide compare' : 'Compare', () => {
      openCompares.has(it.id) ? openCompares.delete(it.id) : openCompares.add(it.id)
      render()
    })
    cmp.className = 'compare-toggle'
    row.appendChild(cmp)
  }
  const input = document.createElement('input')
  input.className = 'reply-input'
  input.placeholder = opts.length ? 'or answer in your own words…' : 'answer…'
  input.value = draftReplies[it.id] ?? ''
  input.addEventListener('input', () => { draftReplies[it.id] = input.value })
  input.addEventListener('focus', () => { draftFocusId = it.id })
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendReply(it.id, input.value) })
  row.appendChild(input)
  row.appendChild(btn('Send', () => sendReply(it.id, input.value)))
  wrap.appendChild(row)
  if (draftFocusId === it.id) requestAnimationFrame(() => {
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
  })
  return wrap
}

function itemEl(it, done = false, underAgentHead = false) {
  const el = document.createElement('details')
  const answered = it.kind === 'question' && it.status === 'open' && it.reply
  el.className = `item ${it.kind}${answered ? ' answered' : ''}`
  const stream = it.stream ? ` · ${esc(it.stream)}` : ''
  // under an agent sub-header the agent name would be redundant on every card
  const meta = underAgentHead ? (it.stream ? esc(it.stream) : '') : `${esc(it.agent)}${stream}`
  const waiting = it.kind === 'question' && it.status === 'open' && !it.reply ? `<span class="waiting">waiting ${rel(it.created_at)}</span>` : ''
  el.innerHTML = `
    <summary class="card-summary">
      <div class="meta"><span class="caret"></span>${meta}${waiting}</div>
      <div class="title">${esc(it.title)}</div>
    </summary>
    ${it.detail ? `<div class="detail">${esc(it.detail)}</div>` : ''}
    ${it.annotation ? `<div class="annotation">📝 ${esc(it.annotation)}</div>` : ''}
    ${answered ? `<div class="reply-block">↩ ${esc(it.reply)}<span class="pickup ${it.reply_seen_at ? 'picked' : 'awaiting'}">${it.reply_seen_at ? '✓ picked up' : '● waiting for agent pickup'}</span></div>` : ''}`
  cardify(el, it.id)
  if (!done && it.kind === 'question' && it.status === 'open' && !it.reply) el.appendChild(answerEl(it))
  if (!done) {
    const actions = document.createElement('div')
    actions.className = 'actions'
    actions.appendChild(btn('Resolve', () => act(it.id, 'resolve')))
    actions.appendChild(btn('Dismiss', () => act(it.id, 'dismiss')))
    if (answered) actions.appendChild(btn('Change answer', async () => {
      draftReplies[it.id] = it.reply
      await fetch(`/api/items/${it.id}/reply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '' }) })
      load()
    }))
    actions.appendChild(btn('Note', async () => {
      const text = prompt('Your note:')
      if (text != null) { await fetch(`/api/items/${it.id}/annotate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }); load() }
    }))
    el.appendChild(actions)
  }
  return el
}

function btn(label, onClick) {
  const b = document.createElement('button')
  b.textContent = label
  b.addEventListener('click', onClick)
  return b
}

async function act(id, action) {
  await fetch(`/api/items/${id}/${action}`, { method: 'POST' })
  load()
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

const COLLAPSE_KEY = 'agent-inbox-collapsed'

function initSections() {
  let collapsed = {}
  try { collapsed = JSON.parse(localStorage.getItem(COLLAPSE_KEY)) || {} } catch { /* fresh start */ }
  for (const sec of document.querySelectorAll('main > details.section')) {
    if (collapsed[sec.id] !== undefined) sec.open = !collapsed[sec.id]
    sec.addEventListener('toggle', () => {
      collapsed[sec.id] = !sec.open
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed))
    })
  }
  for (const link of document.querySelectorAll('#sidebar a')) {
    link.addEventListener('click', (e) => {
      e.preventDefault()
      const sec = document.getElementById(link.dataset.target)
      sec.open = true
      sec.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }
}

initSections()
load()
setInterval(load, 3000)
