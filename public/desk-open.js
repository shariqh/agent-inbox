// Open desk on the page (#617 PR 4b; design docs/superpowers/specs/2026-11-17-remote-inbox-design.md
// §3.4, architecture notes in docs/architecture/remote-inbox.md, "Open desk").
//
// The same page runs on This Mac and inside the view that shows another Mac's Inbox (the hub). It
// offers Open desk only where `window.agentInboxDesk.available()` answered `{ open: true }`: main
// says so only for the hub's own page, on macOS, with an Open desk command saved on the connecting
// Mac (electron/desk-open.cjs). This Mac's own bridge answers `{ open: false }`, and a browser has
// no bridge, so neither ever shows the button. The answer is asked once when the page loads and
// again on each `onConnection`, and cached; a change repaints through `onChange`.
//
// A button is drawn only for a row with a pattern-checked desk and a session id; a click sends
// `{ session }` and nothing else, since main reads the desk from the hub itself. Every word reaches
// the DOM as textContent.
import { PLACE_NAME } from './place.js'

// the session ids main accepts (electron/desk-open.cjs SESSION)
const SESSION = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
export const OPEN_DESK = 'Open desk'
const OPENED = 'Opened'
const OPENED_MS = 1500
const SAID_MS = 6000

/** One sentence per refusal main can answer, said beside the button; anything else is DESK_FALLBACK. */
export const DESK_REFUSALS = Object.freeze({
  no_gesture: 'Press Open desk again.',
  busy: 'One moment: a desk was just opened.',
  no_command: 'Set the Open desk command in Settings on this Mac first.',
  unreachable: 'That Mac’s Inbox could not be reached. Try again.',
  not_found: 'That session is no longer listed.',
  no_desk: 'That session is no longer in a tmux desk.',
  not_on_hub: 'That session runs on a different machine.',
  terminal_failed: 'The terminal did not open. Check Settings → Terminal on this Mac.',
})
export const DESK_FALLBACK = 'The desk could not be opened.'

/** The sentence for a refusal word. */
export function deskRefusal(reason) {
  return typeof reason === 'string' && Object.hasOwn(DESK_REFUSALS, reason) ? DESK_REFUSALS[reason] : DESK_FALLBACK
}

/** The row's session when it may show Open desk (a pattern-checked desk and a session id), else ''. */
export function deskSession(row) {
  if (row === null || typeof row !== 'object') return ''
  const { desk, session } = row
  return typeof desk === 'string' && PLACE_NAME.test(desk) && typeof session === 'string' && SESSION.test(session) ? session : ''
}

export function installDeskOpen({
  desk = () => globalThis.agentInboxDesk,
  onChange = () => {},
  setTimeout: later = (fn, ms) => globalThis.setTimeout(fn, ms),
} = {}) {
  let open = false
  let asks = 0
  let ready = Promise.resolve()
  const bridge = () => {
    try {
      const api = desk()
      return api && typeof api.available === 'function' && typeof api.open === 'function' ? api : null
    } catch {
      return null
    }
  }

  async function ask() {
    const mine = ++asks
    const api = bridge()
    let next = false
    try {
      const answer = api ? await api.available() : null
      next = answer !== null && typeof answer === 'object' && answer.open === true
    } catch {
      next = false
    }
    // a later ask decides; an unchanged answer repaints nothing
    if (mine !== asks || next === open) return
    open = next
    try {
      onChange()
    } catch {
      // the page's own error
    }
  }

  const first = bridge()
  if (first) {
    ready = ask()
    if (typeof first.onConnection === 'function') {
      try {
        first.onConnection(() => { ready = ask() })
      } catch {
        // no change messages: the first answer stands
      }
    }
  }

  // the last word each button showed, so a timer never clears a newer one
  const shown = new WeakMap()
  function show(button, note, label, sentence, ms) {
    const token = (shown.get(button) ?? 0) + 1
    shown.set(button, token)
    button.textContent = label
    note.textContent = sentence
    note.hidden = sentence === ''
    if (!ms) return
    later(() => {
      if (shown.get(button) !== token) return
      button.textContent = OPEN_DESK
      note.textContent = ''
      note.hidden = true
    }, ms)
  }

  /** One open: the button is disabled while it runs, then says Opened, or the refusal is said beside it. */
  async function run(session, button, note) {
    const api = bridge()
    if (!api || !button || !note || button.disabled || typeof session !== 'string' || !SESSION.test(session)) return null
    button.disabled = true
    show(button, note, OPEN_DESK, '', 0)
    let answer = null
    try {
      answer = await api.open({ session })
    } catch {
      answer = null
    }
    button.disabled = false
    const ok = answer !== null && typeof answer === 'object' && answer.ok === true
    if (ok) show(button, note, OPENED, typeof answer.notice === 'string' ? answer.notice : '', OPENED_MS)
    else show(button, note, OPEN_DESK, deskRefusal(answer?.reason), SAID_MS)
    return answer
  }

  /**
   * The button and its sentence for a card, or null when Open desk is not offered or the row has no
   * desk. Its click is its own: it never reaches the card, so the card and its panel stay as they are.
   */
  function control(doc, row) {
    const session = deskSession(row)
    if (!open || session === '') return null
    const wrap = doc.createElement('span')
    wrap.className = 'desk-open'
    wrap.dataset.deskSession = session
    const button = doc.createElement('button')
    button.type = 'button'
    button.className = 'desk-open-button'
    button.textContent = OPEN_DESK
    button.title = 'Open this session’s tmux desk in your terminal'
    const note = doc.createElement('span')
    note.className = 'desk-open-note'
    note.setAttribute('role', 'status')
    note.hidden = true
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      void run(session, button, note)
    })
    wrap.append(button, note)
    return wrap
  }

  return {
    /** Whether Open desk is offered on this page, from the last answer. */
    available: () => open,
    /** Resolves once the last ask has its answer. */
    ready: () => ready,
    run,
    control,
  }
}
