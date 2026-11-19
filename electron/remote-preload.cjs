'use strict'
// The ONLY preload of the hub view (#617, PR 3b): the page there comes from another Mac, so it
// gets one object, `agentInboxDesk`, and nothing else of this app. It runs sandboxed and requires
// nothing but `electron`. Every answer is rebuilt field by field from what main sends, so an
// unexpected field never crosses. Main answers only this view's top frame on the hub's origin (or
// the offline file), checked on every call (electron/hub-view.cjs, registerHubIpc).
const { contextBridge, ipcRenderer } = require('electron')

const STATES = new Set(['online', 'retrying', 'refused'])
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
// #617 PR 4b: Open desk. The session ids a page may name (electron/desk-open.cjs SESSION), and the
// fixed words a refusal may carry back; anything else main answers reads as `failed`.
const SESSION = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const DESK_REASONS = new Set([
  'unavailable', 'bad_request', 'no_gesture', 'busy', 'no_command', 'unreachable', 'not_found', 'no_desk', 'not_on_hub', 'failed', 'terminal_failed',
])
const BAD_REQUEST = Object.freeze({ ok: false, reason: 'bad_request' })

const text = (value, max) => typeof value === 'string' && value.length >= 1 && Array.from(value).length <= max && !CONTROL.test(value)

/** `{ mode: 'hub', label, state, version }` from main's answer, or null. */
function connectionOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  if (value.mode !== 'hub' || !STATES.has(value.state)) return null
  return {
    mode: 'hub',
    label: text(value.label, 40) ? value.label : '',
    state: value.state,
    version: text(value.version, 64) ? value.version : null,
  }
}

const ask = () => ipcRenderer.invoke('agent-inbox:desk-connection').then(connectionOf, () => null)

/** The session from exactly one plain object with exactly the key `session`, a session id; else null. */
function deskSession(args) {
  if (args.length !== 1) return null
  const given = args[0]
  if (given === null || typeof given !== 'object' || Array.isArray(given)) return null
  const keys = Object.keys(given)
  if (keys.length !== 1 || keys[0] !== 'session') return null
  return typeof given.session === 'string' && SESSION.test(given.session) ? given.session : null
}

/** `{ ok: true, notice? }` or `{ ok: false, reason }` with a fixed word, from main's answer; nothing else crosses. */
function openOf(value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (value.ok === true) return text(value.notice, 200) ? { ok: true, notice: value.notice } : { ok: true }
    if (value.ok === false && DESK_REASONS.has(value.reason)) return { ok: false, reason: value.reason }
  }
  return { ok: false, reason: 'failed' }
}

contextBridge.exposeInMainWorld('agentInboxDesk', {
  // #617 PR 4b: whether Open desk may show here; main says yes only on the hub's own page, on macOS,
  // with an Open desk command saved on this Mac
  available(...args) {
    if (args.length !== 0) return Promise.resolve({ open: false })
    return ipcRenderer.invoke('agent-inbox:desk-available').then(
      (value) => ({ open: value !== null && typeof value === 'object' && value.open === true }),
      () => ({ open: false }),
    )
  },
  // #617 PR 4b: { session } and nothing else, sent as a fresh copy; main finds the desk itself
  open(...args) {
    const session = deskSession(args)
    if (session === null) return Promise.resolve({ ...BAD_REQUEST })
    return ipcRenderer.invoke('agent-inbox:desk-open', { session }).then(openOf, () => ({ ok: false, reason: 'failed' }))
  },
  connection(...args) {
    if (args.length !== 0) return Promise.resolve(null)
    return ask()
  },
  // the change message carries nothing: each change asks main again, through the checked channel
  onConnection(callback) {
    if (typeof callback !== 'function') return () => {}
    const listener = () => {
      ask().then((value) => {
        if (value === null) return
        try {
          callback(value)
        } catch {
          // the page's own error
        }
      })
    }
    ipcRenderer.on('agent-inbox:desk-changed', listener)
    return () => ipcRenderer.removeListener('agent-inbox:desk-changed', listener)
  },
  // main takes it only from the offline file
  retry(...args) {
    if (args.length !== 0) return Promise.resolve({ ok: false })
    return ipcRenderer.invoke('agent-inbox:desk-retry').then((value) => ({ ok: value !== null && typeof value === 'object' && value.ok === true }), () => ({ ok: false }))
  },
})
