async function load() {
  try {
    const g = await (await fetch('/api/items')).json()
    renderGroups('needsYou', g.needsYou)
    renderGroups('notes', g.notes)
    renderDone(g.done)
    const boards = await (await fetch('/api/boards')).json()
    renderBoards(boards)
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
}

function renderDone(items) {
  const host = document.querySelector('#done .items')
  host.innerHTML = items.length ? '' : '<p class="empty">Nothing yet.</p>'
  for (const it of items) host.appendChild(itemEl(it, true))
}

const GLYPH = { done: '✅', partial: '⚠️', missing: '❌', tracked: '🔜', na: '➖' }

function renderBoards(boards) {
  const host = document.querySelector('#boards .boards')
  host.innerHTML = boards.length ? '' : '<p class="empty">No boards.</p>'
  for (const b of boards) host.appendChild(boardEl(b))
}

function boardEl(b) {
  const el = document.createElement('article')
  el.className = 'board'
  const pct = Math.round(b.progress.fraction * 100)
  const stream = b.stream ? ` · ${esc(b.stream)}` : ''
  el.innerHTML = `
    <div class="board-head">
      <div class="board-title">${esc(b.title)}</div>
      <div class="board-meta">${esc(b.project)}${stream}</div>
    </div>
    <div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>
    <div class="bar-label">${b.progress.done}/${b.progress.countable} done · ${pct}%</div>`
  const table = document.createElement('table')
  table.className = 'board-table'
  for (const r of b.rows) {
    const tr = document.createElement('tr')
    tr.innerHTML = `
      <td class="pill ${r.status}">${GLYPH[r.status] || ''}</td>
      <td class="row-label">${esc(r.label)}</td>
      <td class="row-note">${esc(r.note)}${r.annotation ? `<div class="annotation">📝 ${esc(r.annotation)}</div>` : ''}</td>`
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
  const el = document.createElement('article')
  el.className = `item ${it.kind}`
  const stream = it.stream ? ` · ${esc(it.stream)}` : ''
  el.innerHTML = `
    <div class="meta">${esc(it.agent)}${stream}</div>
    <div class="title">${esc(it.title)}</div>
    ${it.detail ? `<div class="detail">${esc(it.detail)}</div>` : ''}
    ${it.annotation ? `<div class="annotation">📝 ${esc(it.annotation)}</div>` : ''}`
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

load()
setInterval(load, 3000)
