'use strict'
// The ONLY preload of the hub view (#617, PR 3b): the page there comes from another Mac, so it
// gets one object, `agentInboxDesk`, and nothing else of this app. It runs sandboxed and requires
// nothing but `electron`. Every answer is rebuilt field by field from what main sends, so an
// unexpected field never crosses. Main answers only this view's top frame on the hub's origin (or
// the offline file), checked on every call (electron/hub-view.cjs, registerHubIpc).
const { contextBridge, ipcRenderer } = require('electron')

const STATES = new Set(['online', 'retrying', 'refused'])
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

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

contextBridge.exposeInMainWorld('agentInboxDesk', {
  // the terminal action is a later PR; the member is here so the page can feature-detect it
  available() {
    return Promise.resolve({ open: false })
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
