async function load() {
  try {
    const g = await (await fetch('/api/items')).json()
    const boards = await (await fetch('/api/boards')).json()
    liveCardIds = new Set()
    renderGroups('needsYou', g.needsYou)
    renderGroups('notes', g.notes)
    renderDone(g.done)
    renderBoards(boards)
    pruneCollapsedCards()
    document.getElementById('status').textContent = ''
  } catch {
    document.getElementById('status').textContent = 'disconnected'
  }
}

function renderGroups(sectionId, groups) {
  const host = document.querySelector(`#${sectionId} .groups`)
  host.innerHTML = groups.length ? '' : '<p class="empty">Nothing here.</p>'
  for (const grp of groups) {
    const box = document.createElement('div')
    box.className = 'project'
    box.innerHTML = `<h3>${esc(grp.project)}</h3>`
    for (const it of grp.items) box.appendChild(itemEl(it))
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

function boardEl(b) {
  const el = document.createElement('details')
  el.className = 'board'
  const pct = Math.round(b.progress.fraction * 100)
  const stream = b.stream ? ` · ${esc(b.stream)}` : ''
  el.innerHTML = `
    <summary class="card-summary">
      <div class="board-head">
        <div class="board-title"><span class="caret"></span>${esc(b.title)}</div>
        <div class="board-meta">${esc(b.project)}${stream}</div>
      </div>
      <div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>
      <div class="bar-label">${b.progress.done}/${b.progress.countable} done · ${pct}%</div>
    </summary>`
  cardify(el, b.id)
  const table = document.createElement('table')
  table.className = 'board-table'
  for (const r of b.rows) {
    const tr = document.createElement('tr')
    const context = r.context
      ? `<details class="row-context"${openContexts.has(r.id) ? ' open' : ''}><summary>context</summary><div>${esc(r.context)}</div></details>`
      : ''
    tr.innerHTML = `
      <td class="pill ${r.status}">${GLYPH[r.status] || ''}</td>
      <td class="row-label">${esc(r.label)}</td>
      <td class="row-note">${esc(r.note)}${context}${r.annotation ? `<div class="annotation">📝 ${esc(r.annotation)}${r.annotation_unseen ? '<span class="unseen" title="Not yet seen by the agent">●</span>' : ''}</div>` : ''}</td>`
    const ctxEl = tr.querySelector('.row-context')
    if (ctxEl) ctxEl.addEventListener('toggle', () => { ctxEl.open ? openContexts.add(r.id) : openContexts.delete(r.id) })
    const actionTd = document.createElement('td')
    actionTd.className = 'row-action'
    actionTd.appendChild(btn('📝', async () => {
      const text = prompt('Your note on this row:', r.annotation || '')
      if (text != null) { await fetch(`/api/boards/${b.id}/rows/${r.id}/annotate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }); load() }
    }))
    tr.appendChild(actionTd)
    table.appendChild(tr)
  }
  el.appendChild(table)
  const actions = document.createElement('div')
  actions.className = 'actions'
  actions.appendChild(btn('Archive', async () => { await fetch(`/api/boards/${b.id}/archive`, { method: 'POST' }); load() }))
  el.appendChild(actions)
  return el
}

function itemEl(it, done = false) {
  const el = document.createElement('details')
  el.className = `item ${it.kind}`
  const stream = it.stream ? ` · ${esc(it.stream)}` : ''
  el.innerHTML = `
    <summary class="card-summary">
      <div class="meta"><span class="caret"></span>${esc(it.agent)}${stream}</div>
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
