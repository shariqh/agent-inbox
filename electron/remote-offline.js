// The hub view's offline page (#617, PR 3b). Its words come only through `agentInboxDesk`, the
// one object electron/remote-preload.cjs exposes; the hub's label is always set as text.
'use strict'
;(() => {
  const desk = window.agentInboxDesk
  const title = document.getElementById('title')
  const detail = document.getElementById('detail')
  const retry = document.getElementById('retry')

  function draw(connection) {
    const label = connection && typeof connection.label === 'string' && connection.label !== '' ? connection.label : 'the other Mac'
    if (connection && connection.state === 'refused') {
      title.textContent = `${label} no longer accepts this Mac`
      detail.textContent = 'To use its Inbox here again, pair this Mac again in Settings on This Mac (View → This Mac).'
      retry.hidden = true
      return
    }
    title.textContent = `Can’t reach ${label}`
    detail.textContent = 'Agent Inbox keeps trying, and shows its Inbox as soon as it answers.'
    retry.hidden = false
  }

  draw(null)
  if (!desk) return
  desk.connection().then(draw, () => draw(null))
  desk.onConnection(draw)
  retry.addEventListener('click', () => {
    retry.disabled = true
    desk.retry().finally(() => {
      retry.disabled = false
    })
  })
})()
