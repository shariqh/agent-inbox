async function load() {
  try {
    const g = await (await fetch('/api/items')).json()
    renderGroups('needsYou', g.needsYou)
    renderGroups('notes', g.notes)
    renderDone(g.done)
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
