// The page when another Mac shows it (#617 PR 3c; design
// docs/superpowers/specs/2026-11-17-remote-inbox-design.md §3.3).
//
// The hub serves this same page, and the connecting Mac shows it in a sealed-off view whose only
// bridge is `agentInboxDesk` (electron/remote-preload.cjs). There `connection()` answers
// `{ mode: 'hub', label, state, version }`, or null when main refuses; in this app's own window it
// answers `{ mode: 'local' }`; in a browser or an older app there is no `agentInboxDesk` at all, and
// the page is exactly as it was. Every member is feature-detected.
//
// The mode is read once at start and again on `onConnection`. Only an explicit `local` makes the
// page local: any other answer, a refusal or a throw from a present bridge is hub mode, and hub mode
// never turns back into local. In hub mode the page calls no route the hub's remote entry refuses
// (app.js asks `local()` before it does), the sidebar names the other Mac's Inbox, Settings says
// where its settings are changed, and a line says when the connection is being retried.
//
// The label is the other Mac's own choice: display text only, always set with textContent, and
// nothing here depends on it being true.

const OTHER_MAC = 'the other Mac'

export function installHubMode({ desk = () => globalThis.agentInboxDesk, documentRef = globalThis.document } = {}) {
  const bridge = desk()
  const present = Boolean(bridge) && typeof bridge.connection === 'function'
  // 'local' with no bridge; 'pending' until a present bridge answers; then 'local' or 'hub'
  let mode = present ? 'pending' : 'local'
  let label = ''
  let state = null
  let note = null
  let line = null

  const name = () => (label !== '' ? label : OTHER_MAC)

  function paint() {
    if (mode !== 'hub') return
    const brand = documentRef.querySelector('.brand-copy small')
    if (brand) brand.textContent = label !== '' ? `${label}’s Inbox` : 'Another Mac’s Inbox'
    if (note) note.textContent = `Settings for this Inbox are changed on ${name()} itself.`
    const retrying = state === 'retrying'
    if (!line && retrying) {
      line = documentRef.createElement('span')
      line.id = 'hubReconnecting'
      line.className = 'hub-reconnecting'
      line.setAttribute('role', 'status')
      documentRef.querySelector('.topbar-notices')?.prepend(line)
    }
    if (line) {
      line.textContent = retrying ? `Reconnecting to ${name()}…` : ''
      line.hidden = !retrying
    }
    // the line says what is happening; the page's own "disconnected" would say it twice
    documentRef.body?.classList.toggle('hub-reconnecting', retrying)
  }

  function apply(answer) {
    if (mode === 'pending' && answer !== null && typeof answer === 'object' && answer.mode === 'local') {
      mode = 'local'
      return
    }
    if (mode === 'local') return
    mode = 'hub'
    label = answer !== null && typeof answer === 'object' && typeof answer.label === 'string' ? answer.label : ''
    state = answer !== null && typeof answer === 'object' && typeof answer.state === 'string' ? answer.state : null
    paint()
  }

  let ready = Promise.resolve()
  if (present) {
    let first
    try {
      first = Promise.resolve(bridge.connection())
    } catch {
      first = Promise.resolve(null)
    }
    ready = first.then(apply, () => apply(null))
    if (typeof bridge.onConnection === 'function') {
      try {
        bridge.onConnection((answer) => {
          // a change that lands before the first answer waits for it, so the first answer decides the mode
          ready = ready.then(() => apply(answer))
        })
      } catch {
        // no change messages: the first answer stands
      }
    }
  }

  return {
    /** Resolves once the mode is known. */
    ready: () => ready,
    /** True only when the page may call this Mac's own routes: no bridge, or the bridge said local. */
    local: () => mode === 'local',
    /** Settings in hub mode: the one line in place of every block that needs this app or a refused route. */
    renderSettingsNote(host) {
      note = documentRef.createElement('p')
      note.id = 'hub-settings-note'
      note.className = 'setup-hint hub-settings-note'
      host.appendChild(note)
      paint()
      return note
    },
  }
}
