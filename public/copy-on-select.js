// Copy text when selected (issue #222): an opt-in viewer preference, off by
// default and saved in this profile's localStorage. While it is on, finishing a
// non-empty selection in the viewer writes it to the clipboard: when the primary
// mouse button is released, or once a keyboard selection change settles.
//
// The text is what the selection serializes to, which is what Cmd+C copies, and
// it goes through structured-copy's writeClipboard (the Clipboard API, then the
// selection-preserving fallback), so no IPC channel ever carries it.
//
// A gesture copies only a selection that changed while it ran: a click on a
// button, a scrollbar drag or a shortcut leaves the selection alone and copies
// nothing, and a poll rebuild that restores the same selection (#223) is not the
// human selecting. Text in a reply box, the search field or any other editor is
// never copied: selecting a draft to replace it must not overwrite the clipboard.
// Nothing here prevents a default action or stops an event, so clicks, the
// press guard and attention behave exactly as they did.
import { writeClipboard } from './structured-copy.js'
import { captureSelection, isRestoredSelection, sameSelection } from './selection.js'

const PREFERENCE_KEY = 'agent-inbox-copy-on-select'
const KEYBOARD_SETTLE_MS = 400
const STATUS_MS = 1600
const BINDING = Symbol.for('agent-inbox.copy-on-select')

function readPreference(storage) {
  try {
    return storage.getItem(PREFERENCE_KEY) === 'true'
  } catch {
    return false
  }
}

// A polite live region that is written only when its text changes, so a quick
// run of copies is announced once rather than on every repeat.
function statusRegion(documentRef) {
  const existing = documentRef.getElementById('selectionCopyStatus')
  if (existing) return existing
  const region = documentRef.createElement('div')
  region.id = 'selectionCopyStatus'
  region.className = 'selection-copy-status'
  region.setAttribute('role', 'status')
  region.setAttribute('aria-live', 'polite')
  region.setAttribute('aria-atomic', 'true')
  documentRef.body?.appendChild(region)
  return region
}

// One set of listeners per document; a later viewer boot in the same document
// replaces the handlers they forward to instead of stacking another set.
function bind(documentRef, handlers) {
  const existing = documentRef[BINDING]
  if (existing) {
    existing.handlers = handlers
    return
  }
  const binding = { handlers }
  const view = documentRef.defaultView
  view?.addEventListener('mousedown', (event) => binding.handlers.pointerDown(event), true)
  view?.addEventListener('mouseup', (event) => binding.handlers.pointerUp(event), true)
  view?.addEventListener('keydown', () => binding.handlers.keyDown(), true)
  view?.addEventListener('keyup', () => binding.handlers.keyUp(), true)
  view?.addEventListener('blur', () => binding.handlers.reset())
  documentRef.addEventListener('selectionchange', () => binding.handlers.selectionChange())
  documentRef[BINDING] = binding
}

export function createCopyOnSelect({ storage, documentRef = globalThis.document }) {
  let enabled = readPreference(storage)
  let pointer = null
  let keyboard = null
  let keyboardTimer = null
  let statusTimer = null
  const region = statusRegion(documentRef)

  function show(message, state) {
    if (region.textContent !== message) region.textContent = message
    region.dataset.state = state
    clearTimeout(statusTimer)
    statusTimer = setTimeout(() => {
      region.textContent = ''
      delete region.dataset.state
    }, STATUS_MS)
  }

  async function copy(text) {
    const copied = await writeClipboard(documentRef, text).catch(() => false)
    show(copied ? 'Copied' : 'Copy failed', copied ? 'success' : 'error')
  }

  // A gesture whose slot has moved on (a newer press, a reset, the setting
  // turned off) is superseded and copies nothing; the newer one decides.
  function finish(gesture) {
    if (pointer === gesture) pointer = null
    else if (keyboard === gesture) keyboard = null
    else return
    const current = captureSelection(documentRef)
    if (!current || (!gesture.changed && sameSelection(gesture.start, current))) return
    const text = String(documentRef.getSelection?.()?.toString() ?? '').replace(/\u00a0/g, ' ')
    if (text.trim() === '') return
    void copy(text)
  }

  const handlers = {
    pointerDown(event) {
      pointer = enabled && event.button === 0 ? { start: captureSelection(documentRef), changed: false } : null
    },
    // The browser finishes its own selection work after mouseup, so judge the
    // selection one task later.
    pointerUp(event) {
      if (!pointer || event.button !== 0) return
      const gesture = pointer
      setTimeout(() => finish(gesture), 0)
    },
    keyDown() {
      if (!enabled) return
      clearTimeout(keyboardTimer)
      keyboard ??= { start: captureSelection(documentRef), changed: false }
    },
    keyUp() {
      if (!keyboard) return
      const gesture = keyboard
      clearTimeout(keyboardTimer)
      keyboardTimer = setTimeout(() => finish(gesture), KEYBOARD_SETTLE_MS)
    },
    // A selectionchange during the gesture also catches the same range selected
    // again, which comparing before with after cannot see. The one a #223 restore
    // causes is not the human selecting.
    selectionChange() {
      if ((!pointer && !keyboard) || isRestoredSelection(documentRef)) return
      if (pointer) pointer.changed = true
      if (keyboard) keyboard.changed = true
    },
    reset() {
      pointer = null
      keyboard = null
      clearTimeout(keyboardTimer)
    },
  }
  bind(documentRef, handlers)

  return {
    get enabled() { return enabled },
    setEnabled(next) {
      enabled = next === true
      if (!enabled) handlers.reset()
      try {
        storage.setItem(PREFERENCE_KEY, String(enabled))
      } catch {
        // Unsaved storage still leaves the choice working for this window.
      }
    },
  }
}
