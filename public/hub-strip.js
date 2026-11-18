// The strip that says whose Inbox is on screen (#617 PR 3c; design
// docs/superpowers/specs/2026-11-17-remote-inbox-design.md §3.3).
//
// While another Mac's Inbox is shown, its page fills a view laid over this window, and that page
// controls every pixel of it and chooses its own label. So what says whose Inbox is on screen is
// drawn by this Mac's own page, which keeps running underneath, in the inset electron/hub-view.cjs
// leaves free above the view: "Showing <label>'s Inbox", its status in a word, and This Mac.
//
// Drawn only on this Mac's own page (agentInboxConnect exists and agentInboxDesk says `local`), and
// only while `agentInboxConnect.view().showing` names the stored Mac. With nothing shown it is not
// in the document at all. It is the first element of the body, so it is the first stop for the
// keyboard. This Mac is never disabled: it asks main, over this Mac's own IPC, which works whether
// or not the other Mac can be reached. The label is set with textContent.

/** CSS pixels; electron/hub-view.cjs's HUB_STRIP_HEIGHT, pinned equal by test/dom/hub-strip.test.ts. */
export const HUB_STRIP_HEIGHT = 36

// a word for the strip; Settings → Use another Mac's Inbox says the reason in full
function stateWord(hub) {
  if (hub.state === 'online') return 'Online'
  if (hub.state === 'refused') return 'No longer paired'
  if (hub.state === 'retrying') return hub.reason === null || hub.reason === 'connecting' || hub.reason === 'stopped' ? 'Reconnecting…' : 'Can’t reach it'
  return 'Checking…'
}

export function installHubStrip({
  connect = () => globalThis.agentInboxConnect,
  desk = () => globalThis.agentInboxDesk,
  documentRef = globalThis.document,
} = {}) {
  const api = connect()
  if (!api || typeof api.view !== 'function' || typeof api.show !== 'function') return null
  let strip = null
  let title = null
  let word = null
  let reads = 0

  function build() {
    strip = documentRef.createElement('div')
    strip.id = 'hubStrip'
    strip.className = 'hub-strip'
    strip.setAttribute('role', 'region')
    strip.setAttribute('aria-label', 'Whose Inbox is on screen')
    strip.style.height = `${HUB_STRIP_HEIGHT}px`
    title = documentRef.createElement('span')
    title.className = 'hub-strip-title'
    word = documentRef.createElement('span')
    word.className = 'hub-strip-state'
    const back = documentRef.createElement('button')
    back.type = 'button'
    back.className = 'hub-strip-back'
    back.textContent = 'This Mac'
    back.addEventListener('click', () => {
      Promise.resolve()
        .then(() => api.show(null))
        .catch(() => null)
        .then(() => refresh())
    })
    strip.append(title, word, back)
  }

  function paint(view) {
    const hub = view !== null && typeof view === 'object' && view.available === true ? view.hub : null
    const showing = hub && typeof view.showing === 'string' && view.showing === hub.id ? hub : null
    if (showing === null) {
      strip?.remove()
      return
    }
    if (strip === null) build()
    title.textContent = `Showing ${showing.label}’s Inbox`
    word.textContent = stateWord(showing)
    if (documentRef.body.firstElementChild !== strip) documentRef.body.prepend(strip)
  }

  async function refresh() {
    const mine = ++reads
    let view
    try {
      view = await api.view()
    } catch {
      // a failed read says nothing about what is on top: the strip stays as it was
      return
    }
    if (mine === reads) paint(view)
  }

  void (async () => {
    const deskApi = desk()
    let local = false
    try {
      const answer = deskApi && typeof deskApi.connection === 'function' ? await deskApi.connection() : null
      local = answer !== null && typeof answer === 'object' && answer.mode === 'local'
    } catch {
      local = false
    }
    if (!local) return
    if (typeof api.onChange === 'function') api.onChange(() => { void refresh() })
    await refresh()
  })()
  return { refresh }
}
