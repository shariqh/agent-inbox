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
//
// What is drawn comes from main's get() alone (review round 1, item 4): a refused switch-on comes
// back in it, and goes when main drops it. While an operation runs every control is disabled and
// the status line says what is happening; the switch shows what the file says, never what was
// clicked (item 5). A message lasts until what it speaks of changes, and 2 minutes at most (item 10).
import { codeWords, familyWords, reasonFamily, testWords } from '/remote-words.js'

const RISK = 'A paired Mac can read everything in this Inbox and send messages to your sessions, which may act without asking.'
const UNAVAILABLE = {
  unowned: 'Another Agent Inbox viewer is running on this Mac, so this window can’t change sharing. Quit it, then reopen Agent Inbox.',
  unsupported: 'Sharing this Inbox with your other Macs works on macOS.',
  failed: 'Agent Inbox couldn’t read the sharing settings. Open Settings again to try again.',
}
const CANCELLED = 'That code was cancelled. Make a new one.'
const EXPIRED = 'That code ran out. Make a new one.'
const CHANGED_AGAIN = 'It changed again; check the list.'
const NOT_SAVED = 'Agent Inbox couldn’t save its record of these settings; the next start will ask you to review them.'
const IF_NOT_YOU = 'If you didn’t make this change, switch sharing off and remove the paired Macs.'
const BUSY = {
  turnOn: 'Switching on…', turnOff: 'Switching off…', remove: 'Removing…', addDevice: 'Making a code…', test: 'Testing…', other: 'Saving…',
}
const MESSAGE_MS = 2 * 60_000

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
const unreadable = (n) => `${plural(n, 'paired Mac', 'paired Macs')} that can’t be read (${n === 1 ? 'it' : 'they'} can no longer connect)`
const clockTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const pairedDay = (iso) => new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })
const timeLeft = (ms) => {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `Time left: ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
/** What a message is about: when any of this changes, the message goes. */
const keyOf = (v) => (v.available
  ? `${v.enabled}|${v.listening}|${v.digest}|${v.problem}|${v.flag}|${v.devices.map((device) => device.id).join(',')}`
  : 'unavailable')

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
  // the operation running now (a BUSY key), or null
  let busy = null
  let confirmId = null
  // a refusal to remove paired Macs the owner cancelled: its time, from get()
  let dismissed = null
  // the code on screen, with the digest and paired Macs it was made under
  let code = null
  let codeTimer = null
  // messages: { text, key, at }; `key` is the state it speaks of, set from the next get()
  const notes = { general: null, add: null, flag: null }
  let testResult = null
  let focusKey = null

  const note = (slot, text) => {
    notes[slot] = text ? { text, key: null, at: Date.now() } : null
    if (text) setTimeout(paint, MESSAGE_MS + 1)
  }
  const noteText = (slot) => {
    const n = notes[slot]
    return n && Date.now() - n.at <= MESSAGE_MS ? n.text : ''
  }
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
  const words = (family, v, count = 0) => familyWords(family, { port: v.port, count })

  function clearCode() {
    code = null
    if (codeTimer !== null) clearInterval(codeTimer)
    codeTimer = null
  }

  /** The status line's kind (on, paused, needs, off), its words, and the family of what to do. */
  function statusOf(v) {
    const needs = (family, count = 0) => ({ kind: 'needs', family, count, text: `Needs you: ${words(family, v, count).why}` })
    if (v.enabled && v.listenError) return needs(reasonFamily('listen', v.listenError))
    // the file is on, but the viewer has not opened the listener yet
    if (v.enabled && !v.listening) return { kind: 'on', starting: true, text: 'On, starting…' }
    if (v.enabled) return { kind: 'on', text: `On, at https://${v.host}` }
    if (v.refusal && v.refusal.at !== dismissed) {
      const family = reasonFamily('turnOn', v.refusal.reason, v.refusal.step)
      return { ...needs(family, v.refusal.devices ?? 0), confirm: family === 'would_remove' }
    }
    if (v.problem) return needs(reasonFamily('problem', v.problem))
    const stop = v.stopped && !v.stopped.willResume && v.stopped.reason !== 'not_wanted' ? reasonFamily('stop', v.stopped.reason) : null
    if (v.resume) {
      const waiting = v.resume.waiting
      // a stop that will not resume while he still wants sharing: its real reason
      if (waiting === 'needs_owner') return needs(v.needsOwner ? 'identity' : stop ?? 'switch_again')
      if (waiting === 'flagged') return needs('changed')
      const family = reasonFamily('waiting', waiting)
      const next = v.resume.nextAt === null ? '' : `, next try at ${clockTime(v.resume.nextAt)}`
      return { kind: 'paused', family, text: `Paused: ${words(family, v).why}${next}` }
    }
    // a stop made to keep sharing off is not news: the flag shows the change
    if (stop) return needs(stop)
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

  /** What a Test result is about: on, starting, paused or off, and at which address. */
  function stateKey(v) {
    if (!v.available) return 'unavailable'
    const status = statusOf(v)
    return `${status.kind}:${status.starting === true}:${v.host}`
  }

  function show(next) {
    if (next.available) {
      if (code) {
        const added = next.devices.filter((device) => !code.ids.has(device.id))
        if (added.length > 0) {
          clearCode()
          note('add', `${added.map((device) => device.label).join(', ')} can now use this Inbox.`)
        } else if (!next.enabled || next.digest !== code.digest) {
          clearCode()
          note('add', CANCELLED)
        }
      }
      if (confirmId && !next.devices.some((device) => device.id === confirmId)) confirmId = null
    }
    // each message lasts while what it speaks of stays as it was
    const key = keyOf(next)
    for (const slot of Object.keys(notes)) {
      const n = notes[slot]
      if (n === null) continue
      if (n.key === null) n.key = key
      else if (n.key !== key) notes[slot] = null
    }
    if (testResult && stateKey(next) !== testResult.key) testResult = null
    view = next
    paint()
  }

  async function refresh() {
    show(await read())
    return view
  }

  async function act(kind, call, after = () => {}) {
    if (busy !== null) return
    const active = documentRef.activeElement
    if (focusKey === null && active && section.contains(active)) focusKey = active.dataset?.remoteFocus ?? null
    busy = kind
    section.setAttribute('aria-busy', 'true')
    note('general', '')
    paint()
    let result
    try {
      result = await call()
    } catch {
      result = null
    }
    if (!result || typeof result !== 'object') result = { ok: false, reason: 'failed' }
    if (result.voidedCode === true && code) {
      clearCode()
      note('add', CANCELLED)
    }
    after(result)
    busy = null
    section.removeAttribute('aria-busy')
    await refresh()
  }

  const failedWords = (reason) => familyWords(reasonFamily('turnOn', reason, 'file')).refused
  const switchedOn = (r) => {
    if (r.ok === true && r.devicesRemoved > 0) {
      note('general', `Switching on removed ${plural(r.devicesRemoved, 'paired Mac', 'paired Macs')}. Pair them again with Add a Mac.`)
    }
  }
  const turnOn = () => {
    testResult = null
    return act('turnOn', () => api.turnOn(), switchedOn)
  }
  const turnOff = () => {
    testResult = null
    return act('turnOff', () => api.turnOff(), (r) => { if (r.ok === false) note('general', failedWords(r.reason)) })
  }

  function addDevice() {
    clearCode()
    note('add', '')
    return act('addDevice', () => api.addDevice(), (result) => {
      if (result.ok === true && typeof result.code === 'string' && view.available && view.enabled) {
        // the digest and the Macs it was made under, from the view on screen when it was asked for
        code = { code: result.code, expiresAt: Date.parse(result.expiresAt), digest: view.digest, ids: new Set(view.devices.map((device) => device.id)) }
        codeTimer = setInterval(tickCode, 1000)
      } else if (result.ok === false) {
        note('add', codeWords(result.reason))
      }
    })
  }

  function tickCode() {
    if (!code) return
    const left = code.expiresAt - Date.now()
    if (!(left > 0)) {
      clearCode()
      note('add', EXPIRED)
      notes.add.key = keyOf(view)
      paint()
      return
    }
    const line = section.querySelector('.remote-code-time')
    if (line) line.textContent = timeLeft(left)
  }

  // ── the parts, top to bottom; only those that apply ─────────────────────

  function nowLines(v, box) {
    const labels = v.devices.map((device) => device.label)
    box.append(
      make('p', '', v.enabled ? `Sharing is on, at https://${v.host}.` : 'Sharing is off.'),
      make('p', '', labels.length > 0 ? `Paired Macs: ${labels.join(', ')}.` : 'No paired Macs.'),
    )
    if (v.unreadableDevices > 0) box.append(make('p', '', `${unreadable(v.unreadableDevices)}.`))
  }

  /** What changed, as facts with no values: labels and counts only (review round 1, item 7). */
  function factLines(changes) {
    const facts = []
    if (changes.switched === 'on') facts.push('Sharing was switched on.')
    if (changes.switched === 'off') facts.push('Sharing was switched off.')
    if (changes.address) facts.push('The address changed.')
    if (changes.account) facts.push('The allowed Tailscale account changed.')
    if (changes.port) facts.push('The port changed.')
    for (const label of changes.added) facts.push(`Mac added: ${label}.`)
    for (const label of changes.removed) facts.push(`Mac removed: ${label}.`)
    for (const label of changes.keyChanged) facts.push(`The key of ${label} changed.`)
    const was = (n) => (n === 1 ? 'was' : 'were')
    if (changes.unreadableAdded > 0) facts.push(`${plural(changes.unreadableAdded, 'paired Mac', 'paired Macs')} that can’t be read ${was(changes.unreadableAdded)} added.`)
    if (changes.unreadableRemoved > 0) facts.push(`${plural(changes.unreadableRemoved, 'paired Mac', 'paired Macs')} that can’t be read ${was(changes.unreadableRemoved)} removed.`)
    return facts
  }

  function flagPart(v) {
    const box = make('div', 'remote-flag')
    box.setAttribute('role', 'alert')
    box.append(make('p', 'remote-flag-title', 'The sharing settings were changed outside Agent Inbox.'))
    const changes = v.changes
    // a file it can't read: no view of it, so nothing to accept
    const cannotRead = changes?.unreadable === true || (v.problem !== null && v.problem !== 'other_viewer')
    if (cannotRead) {
      box.append(make('p', '', 'Agent Inbox can’t read the sharing settings file, so it can’t show what is in it.'), make('p', '', IF_NOT_YOU))
      if (noteText('flag')) box.append(make('p', 'remote-flag-message', noteText('flag')))
      return box
    }
    if (!changes || changes.unknown) {
      box.append(make('p', '', 'Agent Inbox can’t tell what changed, because it happened while the app was closed. This is how the settings are now:'))
    } else {
      if (changes.missing) box.append(make('p', '', 'The sharing settings file was removed.'))
      const facts = factLines(changes)
      if (facts.length > 0) {
        const list = make('ul', 'remote-flag-facts')
        for (const fact of facts) list.append(make('li', '', fact))
        box.append(list)
      }
      box.append(make('p', '', 'This is how the settings are now:'))
    }
    nowLines(v, box)
    box.append(make('p', '', IF_NOT_YOU))
    // exactly what is shown: the digest get() gave with this view
    const shown = v.digest
    const ok = button('Looks right', 'flag-ok', () => act('other', () => api.acknowledge(shown), (r) => {
      if (r.ok === true) note('flag', '')
      else note('flag', r.reason === 'changed' ? CHANGED_AGAIN : familyWords('failed').refused)
    }))
    ok.disabled = typeof shown !== 'string'
    box.append(ok)
    if (noteText('flag')) box.append(make('p', 'remote-flag-message', noteText('flag')))
    return box
  }

  function switchPart(v, status) {
    // what the file says, never what was clicked
    const { row, input } = checkbox('remote-switch', 'Let my other Macs use this Inbox', v.enabled || status.kind === 'paused', (on) => {
      void (on ? turnOn() : turnOff())
    })
    row.classList.add('remote-switch-row')
    input.setAttribute('role', 'switch')
    const line = make('span', 'remote-status', busy ? BUSY[busy] : status.text)
    line.id = 'remote-status'
    line.setAttribute('role', 'status')
    row.append(line)
    if (status.kind === 'on' && !status.starting) row.append(copyButton('Copy address', `https://${v.host}`, 'copy-address'))
    return row
  }

  function instructionPart(v, status) {
    if ((status.kind !== 'needs' && status.kind !== 'paused') || status.family === 'not_wanted') return null
    const said = words(status.family, v, status.count)
    const box = make('div', 'remote-instruction')
    box.append(make('p', '', status.kind === 'paused' ? said.paused ?? said.refused : said.refused))
    if (said.command) {
      const command = said.command === true ? v.command : said.command
      box.append(make('pre', '', command), copyButton('Copy', command, 'copy-command'))
    }
    if (said.repair) {
      box.append(button('Make it private', 'repair', () => act('other', () => api.repairPermissions(), (r) => {
        if (r.ok !== true) {
          note('general', failedWords(r.reason))
          return
        }
        const removed = r.devicesRemoved > 0 ? `, and ${plural(r.devicesRemoved, 'paired Mac was', 'paired Macs were')} removed` : ''
        note('general', `The sharing settings file is private again. Sharing is off${removed}.`)
      })))
    }
    if (status.confirm) {
      const at = v.refusal.at
      box.append(
        button('Switch on and remove them', 'remove-all', () => act('turnOn', () => api.turnOnRemovingDevices(), switchedOn)),
        button('Cancel', 'cancel-remove', () => {
          dismissed = at
          focusKey = 'remote-switch'
          paint()
        }),
      )
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
            void act('remove', () => api.removeDevice(device.id), (r) => { if (r.ok === false) note('general', failedWords(r.reason)) })
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
      line.append(make('span', '', unreadable(v.unreadableDevices)), button('Clear', 'clear', () => act('other', () => api.clearUnreadable(), (r) => {
        if (r.ok === false) note('general', failedWords(r.reason))
      })))
      box.append(line)
    }
    return box
  }

  function addPart(v) {
    const box = make('div', 'remote-add')
    const add = button('Add a Mac', 'add', () => { void addDevice() })
    add.id = 'remote-add'
    // a code needs a listener: the viewer refuses one until it listens
    add.disabled = !v.enabled || !v.listening
    box.append(add)
    if (code && v.enabled) {
      box.append(
        make('p', 'remote-code', code.code),
        make('p', 'setup-hint remote-code-help', 'On the other Mac: Settings → Use another Mac’s Inbox, then enter this Mac’s address and this code. It works once, for 10 minutes.'),
        make('p', 'remote-code-address', `Address: https://${v.host}`),
        make('p', 'remote-code-time', timeLeft(code.expiresAt - Date.now())),
      )
    }
    if (noteText('add')) box.append(make('p', 'remote-add-message', noteText('add')))
    return box
  }

  function testPart(v) {
    if (!v.enabled) return null
    const box = make('div', 'remote-test')
    const run = button('Test', 'test', () => {
      // a new test: the last result is gone while it runs
      testResult = null
      void act('test', () => api.test(), (r) => {
        testResult = { text: testWords(r, v.host, v.port), key: stateKey(view) }
      })
    })
    run.id = 'remote-test'
    // a port another program holds: Test says so
    run.disabled = !v.listening && !v.listenError
    box.append(run)
    if (testResult) box.append(make('p', 'remote-test-result', testResult.text))
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
      void act('other', () => api.setOpenAtLogin(on), (r) => { if (r.ok === false) note('general', familyWords('failed').refused) })
    })
    const box = make('div', 'remote-login')
    box.append(row, make('p', 'setup-hint remote-login-hint', 'Needed for sharing to come back after this Mac restarts.'))
    if (v.loginItem.needsApproval) box.append(make('p', 'remote-login-approval', 'Allow Agent Inbox in System Settings → General → Login Items.'))
    return box
  }

  function parts(v) {
    if (!v.available) return [make('p', 'setup-hint remote-unavailable', UNAVAILABLE[v.reason] ?? UNAVAILABLE.failed)]
    const status = statusOf(v)
    const general = noteText('general')
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
      general ? make('p', 'remote-message', general) : null,
    ].filter(Boolean)
  }

  function paint() {
    if (!view) return
    const active = documentRef.activeElement
    const kept = active && section.contains(active) ? active.dataset?.remoteFocus : undefined
    section.replaceChildren(heading, ...parts(view))
    section.querySelector('.remote-message')?.setAttribute('role', 'status')
    // while an operation runs, nothing can be pressed
    if (busy !== null) for (const control of section.querySelectorAll('button, input')) control.disabled = true
    const key = busy === null ? focusKey ?? kept : null
    if (busy === null) focusKey = null
    if (key) section.querySelector(`[data-remote-focus="${key}"]`)?.focus({ preventScroll: true })
  }

  api.onChange?.(() => { void refresh() })
  // Settings opening: main reads Serve again for the removal hint, then the panel is asked for
  refreshShown = async () => {
    if (!section.isConnected) return null
    try {
      await api.recheck?.()
    } catch {
      // the hint stays as main last read it
    }
    return refresh()
  }
  void refresh()
  return section
}
