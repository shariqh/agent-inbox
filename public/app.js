let lastData = null
const FILTER_KEY = 'agent-inbox-agent-filter'
let agentFilter = localStorage.getItem(FILTER_KEY) || null

async function load() {
  try {
    const g = await (await fetch('/api/items')).json()
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

function render() {
  const agents = collectAgents(lastData)
  if (agentFilter && !agents.includes(agentFilter)) agentFilter = null
  renderAgentTabs(agents)
  // prune collapse state against ALL cards, not the filtered view, so
  // switching tabs never drops state for cards the filter is hiding
  liveCardIds = new Set([...allItems(lastData.g).map((i) => i.id), ...lastData.boards.map((b) => b.id), ...lastData.archived.map((b) => b.id)])
  const { g, boards, archived } = filterData(lastData)
  renderGroups('needsYou', g.needsYou)
  renderGroups('notes', g.notes)
  renderDone(g.done)
  renderBoards(boards)
  renderArchived(archived)
  pruneCollapsedCards()
}

function filterData({ g, boards, archived }) {
  if (!agentFilter) return { g, boards, archived }
  const only = (groups) => groups
    .map((gr) => ({ ...gr, items: gr.items.filter((i) => i.agent === agentFilter) }))
    .filter((gr) => gr.items.length > 0)
  return {
    g: { needsYou: only(g.needsYou), notes: only(g.notes), done: g.done.filter((i) => i.agent === agentFilter) },
    boards: boards.filter((b) => b.agent === agentFilter),
    archived: archived.filter((b) => b.agent === agentFilter),
  }
}

function renderAgentTabs(agents) {
  const host = document.getElementById('agentTabs')
  const sig = JSON.stringify([agents, agentFilter])
  if (host.dataset.sig === sig) return
  host.dataset.sig = sig
  host.innerHTML = ''
  if (agents.length < 2) return // tabs are noise with a single agent
  for (const a of [null, ...agents]) {
    const b = document.createElement('button')
    b.textContent = a ?? 'All'
    if (a === agentFilter) b.classList.add('active')
    b.addEventListener('click', () => {
      agentFilter = a
      if (a) localStorage.setItem(FILTER_KEY, a)
      else localStorage.removeItem(FILTER_KEY)
      render()
    })
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
  for (const it of items) host.appendChild(itemEl(it, true))
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
      <div class="bar-label">${b.progress.done}/${b.progress.countable} done · ${pct}%${complete ? '<span class="complete-badge">✓ complete</span>' : ''}</div>
    </summary>`
  cardify(el, b.id)
  const table = document.createElement('table')
  table.className = 'board-table'
  for (const [i, r] of b.rows.entries()) {
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

function itemEl(it, done = false, underAgentHead = false) {
  const el = document.createElement('details')
  el.className = `item ${it.kind}`
  const stream = it.stream ? ` · ${esc(it.stream)}` : ''
  // under an agent sub-header the agent name would be redundant on every card
  const meta = underAgentHead ? (it.stream ? esc(it.stream) : '') : `${esc(it.agent)}${stream}`
  el.innerHTML = `
    <summary class="card-summary">
      <div class="meta"><span class="caret"></span>${meta}</div>
      <div class="title">${esc(it.title)}</div>
    </summary>
    ${it.detail ? `<div class="detail">${esc(it.detail)}</div>` : ''}
    ${it.annotation ? `<div class="annotation">📝 ${esc(it.annotation)}</div>` : ''}`
  cardify(el, it.id)
  if (!done) {
    const actions = document.createElement('div')
    actions.className = 'actions'
    actions.appendChild(btn('Resolve', () => act(it.id, 'resolve')))
    actions.appendChild(btn('Dismiss', () => act(it.id, 'dismiss')))
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
