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
// in the document at all. Main shows the hub only while this page is the one the app owns
// (hub-view.cjs, mayShow), the only page that hears agentInboxConnect.
//
// While it shows, this Mac's page is hidden under the other Mac's view, so it acts only through the
// strip: everything else on the page is `inert`, and every key aimed outside the strip is stopped
// before any of the page's own handlers (Tab moves to This Mac). Both end the moment it goes.
//
// An answer that is not `available: true` (the preload turns every failed call into one) says
// nothing about what is on top: the strip stays as it is and reads again, backing off, until main
// answers. This Mac is never disabled: it asks main, over this Mac's own IPC, which works whether or
// not the other Mac can be reached. The label is set with textContent.
import { stateWord } from '/connect-settings.js'

/** CSS pixels; electron/hub-view.cjs's HUB_STRIP_HEIGHT, pinned equal by test/dom/hub-strip.test.ts. */
export const HUB_STRIP_HEIGHT = 36

// the waits before reading again after an answer that did not answer, in milliseconds
const BACK_OFF = [1000, 2000, 4000, 8000, 15000, 30000]
const KEY_EVENTS = ['keydown', 'keypress', 'keyup']

export function installHubStrip({
  connect = () => globalThis.agentInboxConnect,
  desk = () => globalThis.agentInboxDesk,
  documentRef = globalThis.document,
  setTimeout: later = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: cancel = (handle) => globalThis.clearTimeout(handle),
} = {}) {
  const api = connect()
  if (!api || typeof api.view !== 'function' || typeof api.show !== 'function') return null
  const win = documentRef.defaultView
  let strip = null
  let title = null
  let word = null
  let back = null
  let reads = 0
  let retry = null
  let misses = 0
  let stopped = false
  // the elements this strip made inert, and only those, so what was inert before stays inert
  const madeInert = new Set()
  let watcher = null

  const shown = () => strip !== null && strip.isConnected

  // ── this Mac's hidden page acts only through the strip ─────────────────
  function guardKey(event) {
    if (!shown()) return
    // wherever the key is aimed: with the triage deck open the page's handler acts on a digit even
    // when a button has focus, so `1` pressed on This Mac answered a hidden question
    event.stopImmediatePropagation()
    // inside the strip the browser's own action stays: Enter and Space press This Mac
    if (strip.contains(event.target)) return
    event.preventDefault()
    if (event.type === 'keydown' && event.key === 'Tab') back.focus({ preventScroll: true })
  }

  function makeInert(element) {
    if (element === strip || element.nodeType !== 1 || element.hasAttribute('inert')) return
    element.setAttribute('inert', '')
    madeInert.add(element)
  }

  function cover() {
    for (const child of [...documentRef.body.children]) makeInert(child)
    if (watcher === null && typeof win?.MutationObserver === 'function') {
      watcher = new win.MutationObserver((records) => {
        if (!shown()) return
        for (const record of records) for (const node of record.addedNodes) makeInert(node)
      })
      watcher.observe(documentRef.body, { childList: true })
    }
  }

  function uncover() {
    watcher?.disconnect()
    watcher = null
    for (const element of madeInert) element.removeAttribute('inert')
    madeInert.clear()
  }

  // ── the strip ──────────────────────────────────────────────────────────
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
    back = documentRef.createElement('button')
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
    const hub = view.hub
    const showing = hub && typeof view.showing === 'string' && view.showing === hub.id ? hub : null
    if (showing === null) {
      if (strip !== null) strip.remove()
      uncover()
      return
    }
    if (strip === null) build()
    title.textContent = `Showing ${showing.label}’s Inbox`
    word.textContent = stateWord(showing)
    if (documentRef.body.firstElementChild !== strip) documentRef.body.prepend(strip)
    cover()
  }

  function readAgain() {
    if (retry !== null || stopped) return
    const wait = BACK_OFF[Math.min(misses, BACK_OFF.length - 1)]
    misses += 1
    retry = later(() => {
      retry = null
      void refresh()
    }, wait)
  }

  async function refresh() {
    const mine = ++reads
    let view = null
    try {
      view = await api.view()
    } catch {
      view = null
    }
    if (mine !== reads || stopped) return
    // not main's answer: nothing on screen changes, and the strip asks again
    if (view === null || typeof view !== 'object' || view.available !== true) {
      readAgain()
      return
    }
    misses = 0
    if (retry !== null) {
      cancel(retry)
      retry = null
    }
    paint(view)
  }

  function stop() {
    stopped = true
    for (const type of KEY_EVENTS) win?.removeEventListener(type, guardKey, true)
    if (retry !== null) cancel(retry)
    retry = null
    uncover()
    strip?.remove()
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
    if (!local || stopped) return
    // on the window, in the capture phase: before every handler the page has on its document
    for (const type of KEY_EVENTS) win?.addEventListener(type, guardKey, true)
    if (typeof api.onChange === 'function') api.onChange(() => { void refresh() })
    await refresh()
  })()
  return { refresh, stop }
}
