// Settings → Other devices (#617, PR 2d): whether the owner's other Macs may use this Mac's Inbox
// through Tailscale, the Macs paired with it, and a code to pair another.
//
// Electron main owns the hub's controller. This section only asks it, through the
// window.agentInboxRemoteEntry bridge, and names a paired Mac's id, a digest it was shown or a
// boolean. Every string reaches the DOM as textContent: a Mac's label is text that Mac chose. A
// paired Mac can read everything here and message sessions that may act without asking, so the
// section says so beside the switch, and shows one thing to do at a time: the owner is usually not
// at this Mac, so whatever needs him is the first thing he sees here. Without the bridge (a
// browser, or this page shown on another Mac) nothing is drawn. The words, including those of
// main's notifications, are in /remote-words.js.
import { FAMILY_WORDS, codeWords, reasonFamily, stopNotice, testWords } from '/remote-words.js'

const RISK = 'A paired Mac can read everything in this Inbox and send messages to your sessions, which may act without asking.'
const UNAVAILABLE = {
  unowned: 'Quit and reopen Agent Inbox to change this.',
  unsupported: 'Sharing this Inbox with your other Macs works on macOS.',
  failed: 'Agent Inbox couldn’t read the sharing settings. Open Settings again to try again.',
}
const CANCELLED = 'That code was cancelled. Make a new one.'
const EXPIRED = 'That code ran out. Make a new one.'
const CHANGED_AGAIN = 'It changed again; check the list.'
const NOT_SAVED = 'Agent Inbox could not save its record of these settings; the next start will ask you to review them.'

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
const unreadable = (n) => `${plural(n, 'entry', 'entries')} that can’t be read`
const clockTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const pairedDay = (iso) => new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })
const timeLeft = (ms) => {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `Time left: ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
const failedWords = (reason) => FAMILY_WORDS[reasonFamily('turnOn', reason, 'file')].refused

// Asks main again, as Settings does each time it opens.
let refreshShown = null
export function refreshRemoteSettings() {
  return refreshShown ? refreshShown() : Promise.resolve(null)
}

export function renderRemoteSettings(host, {
  bridge = () => globalThis.agentInboxRemoteEntry,
  documentRef = globalThis.document,
} = {}) {
  refreshShown = null
  const api = bridge()
  if (!api || typeof api.get !== 'function') return null
  const make = (tag, className, text) => {
    const el = documentRef.createElement(tag)
    if (className) el.className = className
    if (text !== undefined) el.textContent = text
    return el
  }
  const section = make('section', 'setup-block remote-settings')
  section.id = 'remote-settings'
  const heading = make('h3', '', 'Other devices')
  section.append(heading)
  host.appendChild(section)

  let view = null
  let busy = false
  // the last refusal to switch on, here: { step, reason }; gone once sharing is on or switched again
  let refusal = null
  let confirmId = null
  // the code on screen, with the digest and paired Macs it was made under
  let code = null
  let codeTimer = null
  let addMessage = ''
  let flagMessage = ''
  let testResult = ''
  let message = ''
  let focusKey = null

  const button = (label, key, onClick) => {
    const el = make('button', '', label)
    el.type = 'button'
    if (key) el.dataset.remoteFocus = key
    el.addEventListener('click', onClick)
    return el
  }
  const copyButton = (label, value, key) => {
    const el = button(label, key, async () => {
      try {
        await globalThis.navigator.clipboard.writeText(value)
        el.textContent = 'Copied ✓'
        setTimeout(() => { el.textContent = label }, 1500)
      } catch {
        // nothing copied; the text is on screen
      }
    })
    el.classList.add('copy-btn')
    return el
  }
  const checkbox = (id, label, checked, onChange) => {
    const row = make('div', 'remote-check')
    const input = make('input')
    input.type = 'checkbox'
    input.id = id
    input.checked = checked
    input.dataset.remoteFocus = id
    input.addEventListener('change', () => onChange(input.checked))
    const text = make('label', '', label)
    text.htmlFor = id
    row.append(input, text)
    return { row, input }
  }

  function clearCode() {
    code = null
    if (codeTimer !== null) clearInterval(codeTimer)
    codeTimer = null
  }

  /** The status line's kind (on, paused, needs, off), its words, and the family of what to do. */
  function statusOf(v) {
    const needs = (family) => ({ kind: 'needs', family, text: `Needs you: ${FAMILY_WORDS[family].why}` })
    if (v.enabled) return { kind: 'on', text: `On, at https://${v.host}` }
    if (refusal) return needs(reasonFamily('turnOn', refusal.reason, refusal.step))
    if (v.problem) return needs(reasonFamily('problem', v.problem))
    if (v.resume) {
      const waiting = v.resume.waiting
      if (waiting === 'needs_owner') return needs(v.needsOwner ? 'identity' : 'switch_again')
      if (waiting === 'flagged') return needs('changed')
      const family = reasonFamily('waiting', waiting)
      const next = v.resume.nextAt === null ? '' : `, next try at ${clockTime(v.resume.nextAt)}`
      return { kind: 'paused', family, text: `Paused: ${FAMILY_WORDS[family].why}${next}` }
    }
    // a stop made to keep sharing off is not news: the flag shows the change
    if (v.stopped && !v.stopped.willResume && v.stopped.reason !== 'not_wanted') {
      return { kind: 'needs', family: reasonFamily('stop', v.stopped.reason), text: `Needs you: ${stopNotice(v.stopped.reason)}` }
    }
    if (v.needsOwner) return needs('identity')
    return { kind: 'off', text: 'Off' }
  }

  async function read() {
    try {
      const next = await api.get()
      return next && typeof next === 'object' ? next : { available: false, reason: 'failed' }
    } catch {
      return { available: false, reason: 'failed' }
    }
  }

  function show(next) {
    if (next.available) {
      if (code) {
        const added = next.devices.filter((device) => !code.ids.has(device.id))
        if (added.length > 0) {
          clearCode()
          addMessage = `${added.map((device) => device.label).join(', ')} can now use this Inbox.`
        } else if (!next.enabled || next.digest !== code.digest) {
          clearCode()
          addMessage = CANCELLED
        }
      }
      if (next.enabled) refusal = null
      else testResult = ''
      if (!next.flag) flagMessage = ''
      if (confirmId && !next.devices.some((device) => device.id === confirmId)) confirmId = null
    }
    view = next
    paint()
  }

  async function refresh() {
    show(await read())
    return view
  }

  async function act(call, after = () => {}) {
    if (busy) return
    busy = true
    section.setAttribute('aria-busy', 'true')
    message = ''
    let result
    try {
      result = await call()
    } catch {
      result = null
    }
    if (!result || typeof result !== 'object') result = { ok: false, reason: 'failed' }
    if (result.voidedCode === true && code) {
      clearCode()
      addMessage = CANCELLED
    }
    after(result)
    busy = false
    section.removeAttribute('aria-busy')
    await refresh()
  }

  const turnOn = () => {
    refusal = null
    return act(() => api.turnOn(), (r) => {
      if (r.ok === false) refusal = { step: r.step, reason: r.reason }
      if (r.ok === true && r.devicesRemoved > 0) {
        message = `Switching on removed ${plural(r.devicesRemoved, 'paired Mac', 'paired Macs')}, because this Mac’s Tailscale name or account changed.`
      }
    })
  }
  const turnOff = () => {
    refusal = null
    return act(() => api.turnOff(), (r) => { if (r.ok === false) message = failedWords(r.reason) })
  }

  async function addDevice() {
    if (busy) return
    busy = true
    clearCode()
    addMessage = ''
    let result
    try {
      result = await api.addDevice()
    } catch {
      result = { ok: false, reason: 'failed' }
    }
    busy = false
    const next = await read()
    if (result?.ok === true && typeof result.code === 'string' && next.available && next.enabled) {
      code = { code: result.code, expiresAt: Date.parse(result.expiresAt), digest: next.digest, ids: new Set(next.devices.map((device) => device.id)) }
      codeTimer = setInterval(tickCode, 1000)
    } else if (result?.ok === false) {
      addMessage = codeWords(result.reason)
    }
    show(next)
  }

  function tickCode() {
    if (!code) return
    const left = code.expiresAt - Date.now()
    if (!(left > 0)) {
      clearCode()
      addMessage = EXPIRED
      paint()
      return
    }
    const line = section.querySelector('.remote-code-time')
    if (line) line.textContent = timeLeft(left)
  }

  // ── the parts, top to bottom; only those that apply ─────────────────────

  function flagPart(v) {
    const box = make('div', 'remote-flag')
    box.setAttribute('role', 'alert')
    const labels = v.devices.map((device) => device.label)
    box.append(
      make('p', 'remote-flag-title', 'The sharing settings were changed outside Agent Inbox.'),
      make('p', '', v.enabled ? `Sharing is now on, at https://${v.host}.` : 'Sharing is now off.'),
      make('p', '', labels.length > 0 ? `Paired Macs: ${labels.join(', ')}.` : 'No paired Macs.'),
    )
    if (v.unreadableDevices > 0) box.append(make('p', '', `${unreadable(v.unreadableDevices)}.`))
    // exactly what is shown: the digest get() gave with this view
    const shown = v.digest
    const ok = button('Looks right', 'flag-ok', () => act(() => api.acknowledge(shown), (r) => {
      if (r.ok === true) flagMessage = ''
      else if (r.reason === 'changed') flagMessage = CHANGED_AGAIN
      else flagMessage = FAMILY_WORDS.failed.refused
    }))
    ok.disabled = typeof shown !== 'string'
    box.append(ok)
    if (flagMessage) box.append(make('p', 'remote-flag-message', flagMessage))
    return box
  }

  function switchPart(v, status) {
    const { row, input } = checkbox('remote-switch', 'Let my other Macs use this Inbox', status.kind === 'on' || status.kind === 'paused', (on) => {
      void (on ? turnOn() : turnOff())
    })
    row.classList.add('remote-switch-row')
    input.setAttribute('role', 'switch')
    const line = make('span', 'remote-status', status.text)
    line.id = 'remote-status'
    line.setAttribute('role', 'status')
    row.append(line)
    if (status.kind === 'on') row.append(copyButton('Copy address', `https://${v.host}`, 'copy-address'))
    return row
  }

  function instructionPart(v, status) {
    if ((status.kind !== 'needs' && status.kind !== 'paused') || status.family === 'not_wanted') return null
    const words = FAMILY_WORDS[status.family]
    const box = make('div', 'remote-instruction')
    box.append(make('p', '', status.kind === 'paused' ? words.paused ?? words.refused : words.refused))
    if (words.command) box.append(make('pre', '', v.command), copyButton('Copy', v.command, 'copy-command'))
    if (words.repair) {
      box.append(button('Make it private', 'repair', () => act(() => api.repairPermissions(), (r) => {
        if (r.ok !== true) {
          message = failedWords(r.reason)
          return
        }
        const removed = r.devicesRemoved > 0 ? `, and ${plural(r.devicesRemoved, 'paired Mac was', 'paired Macs were')} removed` : ''
        message = `The sharing settings file is private again. Sharing is off${removed}.`
      })))
    }
    return box
  }

  function devicesPart(v) {
    if (v.devices.length === 0 && v.unreadableDevices === 0) return null
    const box = make('div', 'remote-devices')
    box.append(make('h4', '', 'Paired Macs'))
    const list = make('ul', 'remote-device-list')
    for (const device of v.devices) {
      const item = make('li', 'remote-device')
      item.dataset.device = device.id
      item.append(make('span', 'remote-device-label', device.label))
      if (device.pairedAt) item.append(make('span', 'remote-device-when', `Paired ${pairedDay(device.pairedAt)}`))
      if (confirmId === device.id) {
        const confirm = make('div', 'remote-confirm')
        confirm.append(
          make('p', '', `Remove ${device.label}?`),
          button('Remove', 'confirm-remove', () => {
            confirmId = null
            focusKey = 'add'
            void act(() => api.removeDevice(device.id), (r) => { if (r.ok === false) message = failedWords(r.reason) })
          }),
          button('Keep', 'confirm-keep', () => {
            confirmId = null
            focusKey = `remove-${device.id}`
            paint()
          }),
        )
        item.append(confirm)
      } else {
        const remove = button('Remove', `remove-${device.id}`, () => {
          confirmId = device.id
          focusKey = 'confirm-keep'
          paint()
        })
        remove.setAttribute('aria-label', `Remove ${device.label}`)
        item.append(remove)
      }
      list.append(item)
    }
    if (v.devices.length > 0) box.append(list)
    if (v.unreadableDevices > 0) {
      const line = make('p', 'remote-unreadable')
      line.append(make('span', '', unreadable(v.unreadableDevices)), button('Clear', 'clear', () => act(() => api.clearUnreadable(), (r) => {
        if (r.ok === false) message = failedWords(r.reason)
      })))
      box.append(line)
    }
    return box
  }

  function addPart(v) {
    const box = make('div', 'remote-add')
    const add = button('Add a Mac', 'add', () => { void addDevice() })
    add.id = 'remote-add'
    add.disabled = !v.enabled
    box.append(add)
    if (code && v.enabled) {
      box.append(
        make('p', 'remote-code', code.code),
        make('p', 'setup-hint remote-code-help', 'On the other Mac: Settings → Use another Mac’s Inbox, then enter this Mac’s address and this code. It works once, for 10 minutes.'),
        make('p', 'remote-code-address', `Address: https://${v.host}`),
        make('p', 'remote-code-time', timeLeft(code.expiresAt - Date.now())),
      )
    }
    if (addMessage) box.append(make('p', 'remote-add-message', addMessage))
    return box
  }

  function testPart(v) {
    if (!v.enabled) return null
    const box = make('div', 'remote-test')
    const run = button('Test', 'test', () => act(() => api.test(), (r) => { testResult = testWords(r, v.host) }))
    run.id = 'remote-test'
    box.append(run)
    if (testResult) box.append(make('p', 'remote-test-result', testResult))
    return box
  }

  function removalPart(v) {
    if (v.enabled || !v.removalHint) return null
    const box = make('div', 'remote-removal')
    box.append(make('p', '', 'Tailscale is still forwarding to this Mac. To stop it:'), make('pre', '', v.removalHint), copyButton('Copy', v.removalHint, 'copy-removal'))
    return box
  }

  function loginPart(v) {
    if (!v.loginItem.available) return null
    const { row } = checkbox('remote-login', 'Open Agent Inbox at login', v.loginItem.openAtLogin, (on) => {
      void act(() => api.setOpenAtLogin(on), (r) => { if (r.ok === false) message = FAMILY_WORDS.failed.refused })
    })
    const box = make('div', 'remote-login')
    box.append(row, make('p', 'setup-hint remote-login-hint', 'Needed for sharing to come back after this Mac restarts.'))
    return box
  }

  function parts(v) {
    if (!v.available) return [make('p', 'setup-hint remote-unavailable', UNAVAILABLE[v.reason] ?? UNAVAILABLE.failed)]
    const status = statusOf(v)
    return [
      v.flag ? flagPart(v) : null,
      switchPart(v, status),
      make('p', 'setup-hint remote-risk', RISK),
      instructionPart(v, status),
      devicesPart(v),
      addPart(v),
      testPart(v),
      removalPart(v),
      loginPart(v),
      v.stateSaved === false ? make('p', 'setup-hint remote-not-saved', NOT_SAVED) : null,
      message ? make('p', 'remote-message', message) : null,
    ].filter(Boolean)
  }

  function paint() {
    if (!view) return
    const active = documentRef.activeElement
    const kept = active && section.contains(active) ? active.dataset?.remoteFocus : undefined
    section.replaceChildren(heading, ...parts(view))
    const message_ = section.querySelector('.remote-message')
    message_?.setAttribute('role', 'status')
    const key = focusKey ?? kept
    focusKey = null
    if (key) section.querySelector(`[data-remote-focus="${key}"]`)?.focus({ preventScroll: true })
  }

  api.onChange?.(() => { void refresh() })
  refreshShown = () => (section.isConnected ? refresh() : Promise.resolve(null))
  void refresh()
  return section
}
