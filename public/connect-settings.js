// Settings → Use another Mac's Inbox (#617 PR 3c; design
// docs/superpowers/specs/2026-11-17-remote-inbox-design.md §3.3, architecture notes in
// docs/architecture/remote-inbox.md, "The connecting Mac's screens").
//
// On this Mac's own page only: drawn where window.agentInboxConnect exists and
// agentInboxDesk.connection() answers `{ mode: 'local' }`, never on the hub's page. Main owns
// everything (electron/remote-connect.cjs behind the bridge in electron/setup-preload.cjs); this
// section asks it, through `view()` and its `onChange`, and shows one state at a time:
//
// - not available: one sentence (not macOS, a viewer the app does not own, no Keychain);
// - no Mac connected: Address, Code and Connect, with one line of help;
// - connecting or disconnecting: every control disabled, and a line saying so;
// - a refusal: one sentence per reason, saying what to do next, with Replace it where that helps;
// - connected: "<label>'s Inbox", its address, its status, Show its Inbox and Disconnect.
//
// The label comes from the other Mac: text it chose, set with textContent, never proof of
// anything. Every string reaches the DOM as textContent.

// The hub's pairing-code rule, mirrored (src/remote-pair.ts, electron/remote-connect-rules.cjs);
// test/dom/settings-connect.test.ts compares the two over many inputs. A malformed code is never
// sent: on the hub it would use up one of the code's five tries.
const CODE_TYPED = /^[0-9A-Za-z -]{1,64}$/
const CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{10}$/

export function normaliseCode(text) {
  if (typeof text !== 'string' || !CODE_TYPED.test(text)) return null
  const plain = text.replace(/[ -]/g, '').toUpperCase().replace(/[IL]/g, '1').replace(/O/g, '0')
  return CODE_PATTERN.test(plain) ? plain : null
}

const HELP = 'On the other Mac: Settings → Other devices → Add a Mac shows the address and a code.'
const UNOWNED = 'This works only in Agent Inbox’s own window, not in a viewer it found already running. Quit that viewer and open Agent Inbox again.'
const NOT_MAC = 'Using another Mac’s Inbox works only on macOS.'
const NO_KEYCHAIN = 'The Keychain isn’t available on this Mac, so Agent Inbox can’t keep the other Mac’s key safe.'
const BAD_CODE = 'The code is 10 letters and digits. Check it on the other Mac and try again.'
const FALLBACK = 'Agent Inbox couldn’t connect. Try again.'
const PAIRED_ON_HUB = 'The other Mac now lists this Mac, but this Mac couldn’t save the connection. On the other Mac, remove this Mac under Settings → Other devices, then try again with a new code.'
const OWN_ACCOUNT = 'Use a Mac signed in to your own Tailscale account.'

// One sentence for every word connect() can answer (electron/remote-connect.d.cts, ConnectAnswer).
const REFUSALS = {
  unsupported: NOT_MAC,
  no_keychain: `${NO_KEYCHAIN} Unlock this Mac and try again.`,
  bad_address: 'That address isn’t right. Copy it from the other Mac: it looks like mac-name.your-tailnet.ts.net.',
  bad_code: BAD_CODE,
  newer_schema: 'A newer Agent Inbox saved this Mac’s connection. Update Agent Inbox on this Mac, then try again.',
  bad_file: 'This Mac’s saved connection can’t be used.',
  hub_exists: 'A Mac is already connected.',
  no_cli: 'Tailscale isn’t installed on this Mac. Install it, sign in, and try again.',
  failed: 'That didn’t work. Check that Tailscale is running on this Mac, then try again.',
  not_running: 'Tailscale isn’t running on this Mac, or it’s signed out. Open Tailscale, sign in, and try again.',
  tagged_self: 'This Mac is a tagged device in Tailscale. Sign this Mac in to your own Tailscale account, then try again.',
  not_in_tailnet: 'That address isn’t in your tailnet. Copy the address the other Mac shows.',
  not_found: 'None of your Tailscale devices has that address. Is the other Mac on and signed in to Tailscale?',
  duplicate_name: 'More than one device in your tailnet has that name. Rename one in Tailscale, then try again.',
  not_your_device: `That address isn’t one of your Tailscale devices. ${OWN_ACCOUNT}`,
  tagged_device: `That address is a tagged device in Tailscale. ${OWN_ACCOUNT}`,
  unreachable: 'Couldn’t reach that Mac. Is it awake, with Agent Inbox open?',
  bad_certificate: 'That Mac’s certificate isn’t valid, so nothing was sent. Check the address and try again.',
  not_agent_inbox: 'That address isn’t an Agent Inbox sharing its Inbox. Is sharing switched on there?',
  refused: 'The other Mac said no. The code may be wrong or used up, or its sharing may not allow your Tailscale account. Make a new code there and try again.',
  write_failed: 'This Mac couldn’t save the connection. Try again.',
  too_large: 'This Mac couldn’t save the connection: its saved file is too large.',
  forgotten: 'You disconnected while it was connecting, so nothing is connected.',
  changed: 'The connection changed while it was connecting. Check what is connected, then try again.',
}
// the refusals a replace can get past: a stored Mac, or a saved file that can't be used
const REPLACEABLE = new Set(['hub_exists', 'bad_file'])

// The saved file's problems (StoreProblem), said above the form while no Mac is connected.
const DAMAGED = 'This Mac’s saved connection is damaged. Connecting a Mac replaces it.'
const PROBLEMS = {
  unreadable: 'This Mac’s saved connection can’t be read. Connecting a Mac replaces it.',
  bad_file: 'This Mac’s saved connection file isn’t safe to use. Connecting a Mac replaces it.',
  too_large: DAMAGED,
  not_json: DAMAGED,
  bad_schema: DAMAGED,
  bad_entry: DAMAGED,
  newer_schema: 'A newer Agent Inbox saved this Mac’s connection. Update Agent Inbox on this Mac to change it.',
}

// The connected Mac's status, from view().hub.state and .reason (the controller's connection state).
const RETRYING = {
  connecting: () => 'Connecting…',
  unreachable: (name) => `Can’t reach ${name}. Trying again…`,
  bad_certificate: (name) => `${name}’s certificate isn’t valid. Trying again…`,
  not_agent_inbox: (name) => `${name} isn’t sharing its Inbox right now. Is sharing still on there?`,
  no_cli: () => 'Tailscale isn’t installed on this Mac. Trying again…',
  failed: () => 'Tailscale on this Mac can’t be read. Trying again…',
  not_running: () => 'Tailscale isn’t running on this Mac, or it’s signed out. Trying again…',
  no_keychain: () => 'The Keychain isn’t available on this Mac yet. Trying again…',
}
const REFUSED = {
  node_changed: (name) => `${name}’s address now belongs to another device: pair again.`,
  secret_unreadable: (name) => `This Mac can’t read its key for ${name}: pair again.`,
  not_found: (name) => `${name} is no longer in your tailnet: pair again.`,
  not_in_tailnet: (name) => `${name} is no longer in your tailnet: pair again.`,
  duplicate_name: (name) => `More than one device now has ${name}’s name: pair again.`,
  not_your_device: (name) => `${name} is no longer one of your Tailscale devices: pair again.`,
  tagged_device: (name) => `${name} is now a tagged device in Tailscale: pair again.`,
  tagged_self: () => 'This Mac is now a tagged device in Tailscale: pair again.',
}

function hubStatus(hub) {
  const name = hub.label
  const reason = typeof hub.reason === 'string' && Object.hasOwn(hub.state === 'refused' ? REFUSED : RETRYING, hub.reason) ? hub.reason : null
  if (hub.state === 'online') return 'Online'
  if (hub.state === 'retrying') return reason ? RETRYING[reason](name) : 'Reconnecting…'
  if (hub.state === 'refused') return reason ? REFUSED[reason](name) : `${name} no longer accepts this Mac: pair again.`
  return 'Checking…'
}

const SHOW_REFUSALS = {
  busy: (name) => `${name}’s Inbox closed itself several times. Try again in a minute.`,
  not_found: () => 'That Mac isn’t connected any more.',
}

const hostOf = (origin) => {
  try {
    return new URL(origin).host
  } catch {
    return ''
  }
}

let refreshShown = null
let stopShown = null

/** Asks main for the section again, as Settings does each time it opens. */
export function refreshConnectSettings() {
  return refreshShown ? refreshShown() : Promise.resolve(null)
}

export function renderConnectSettings(host, {
  connect = () => globalThis.agentInboxConnect,
  desk = () => globalThis.agentInboxDesk,
  documentRef = globalThis.document,
  platform = () => globalThis.navigator?.platform ?? '',
} = {}) {
  refreshShown = null
  stopShown?.()
  stopShown = null
  const api = connect()
  if (!api || typeof api.view !== 'function') return null
  const make = (tag, className, text) => {
    const el = documentRef.createElement(tag)
    if (className) el.className = className
    if (text !== undefined) el.textContent = text
    return el
  }
  const button = (id, label, className = '') => {
    const el = make('button', className, label)
    el.type = 'button'
    el.id = id
    return el
  }
  const field = (id, label, input) => {
    const wrap = make('div', 'connect-field')
    const name = make('label', '', label)
    name.htmlFor = id
    input.id = id
    input.type = 'text'
    input.autocomplete = 'off'
    input.spellcheck = false
    input.setAttribute('autocapitalize', 'off')
    wrap.append(name, input)
    return wrap
  }

  // drawn hidden until the desk says this is this Mac's own page
  const section = make('section', 'setup-block connect-settings')
  section.id = 'connect-settings'
  section.hidden = true
  const hint = make('p', 'setup-hint')
  hint.id = 'connect-hint'

  const address = make('input')
  address.placeholder = 'mac-name.your-tailnet.ts.net'
  address.maxLength = 300
  const code = make('input')
  code.placeholder = '10 letters and digits'
  code.maxLength = 64
  const submit = make('button', 'connect-primary', 'Connect')
  submit.type = 'submit'
  submit.id = 'connect-submit'
  const form = make('form', 'connect-form')
  form.id = 'connect-form'
  form.noValidate = true
  form.append(field('connect-address', 'Address', address), field('connect-code', 'Code', code), submit)

  const hubBlock = make('div', 'connect-hub')
  hubBlock.id = 'connect-hub'
  const hubName = make('p', 'connect-hub-name')
  hubName.id = 'connect-hub-name'
  const hubAddress = make('p', 'connect-hub-address')
  hubAddress.id = 'connect-hub-address'
  const hubStatusLine = make('p', 'connect-hub-status')
  hubStatusLine.id = 'connect-hub-status'
  const pairAgain = make('p', 'setup-hint')
  pairAgain.id = 'connect-pair-again'
  const show = button('connect-show', 'Show its Inbox', 'connect-primary')
  const disconnect = button('connect-disconnect', 'Disconnect')
  const hubActions = make('div', 'connect-actions')
  hubActions.append(show, disconnect)
  hubBlock.append(hubName, hubAddress, hubStatusLine, pairAgain, hubActions)

  const busyLine = make('p', 'connect-busy')
  busyLine.id = 'connect-busy'
  busyLine.setAttribute('role', 'status')
  busyLine.setAttribute('aria-live', 'polite')
  const message = make('p', 'connect-message')
  message.id = 'connect-message'
  message.setAttribute('role', 'status')
  message.setAttribute('aria-live', 'polite')
  const replace = button('connect-replace', 'Replace it')
  const offer = make('div', 'connect-actions')
  offer.id = 'connect-offer'
  offer.append(replace)
  const confirmText = make('p', 'connect-confirm-text')
  confirmText.id = 'connect-confirm-text'
  const confirmYes = button('connect-confirm-yes', 'Disconnect', 'connect-danger')
  const confirmNo = button('connect-confirm-no', 'Keep')
  const confirmBox = make('div', 'connect-confirm')
  confirmBox.id = 'connect-confirm'
  const confirmActions = make('div', 'connect-actions')
  confirmActions.append(confirmYes, confirmNo)
  confirmBox.append(confirmText, confirmActions)

  section.append(make('h3', '', 'Use another Mac’s Inbox'), hint, hubBlock, form, busyLine, message, offer, confirmBox)
  host.appendChild(section)

  // what is on screen beyond view(): one of these at a time
  let view = null
  let busy = null // null | 'connect' | 'forget'
  let said = '' // the last answer's sentence
  let offered = null // { reason, address, code, label } after a refusal Replace can get past
  let confirming = null // null | 'replace' | 'disconnect'
  let reads = 0

  const connected = () => Boolean(view && view.available === true && view.hub)

  function paint() {
    const available = Boolean(view && view.available === true)
    const keychain = available && view.keychain === true
    const hub = connected() ? view.hub : null
    const problem = available && typeof view.problem === 'string' ? view.problem : null
    const unsaved = problem === 'forget_not_saved'
    // a refusal Replace can get past keeps the form, whatever main stores meanwhile
    const showHub = hub !== null && busy !== 'connect' && offered === null
    const showForm = available && !showHub && (keychain || busy === 'connect') && problem !== 'newer_schema'
    // a question about something no longer on screen is no longer asked
    if ((confirming === 'disconnect' && !showHub) || (confirming === 'replace' && offered === null)) confirming = null

    if (!available) hint.textContent = /^Mac/.test(String(platform())) ? UNOWNED : NOT_MAC
    else if (!showHub && !keychain && busy !== 'connect') hint.textContent = `${NO_KEYCHAIN} Unlock this Mac and open Settings again.`
    else hint.textContent = showForm ? HELP : ''
    hint.hidden = hint.textContent === ''

    hubBlock.hidden = !showHub
    if (showHub) {
      hubName.textContent = `${hub.label}’s Inbox`
      hubAddress.textContent = hostOf(hub.origin)
      hubStatusLine.textContent = unsaved
        ? `This Mac stopped using ${hub.label}’s Inbox, but couldn’t save that. Press Disconnect to try again.`
        : hubStatus(hub)
      const refused = !unsaved && hub.state === 'refused'
      pairAgain.textContent = refused ? `To pair again: press Disconnect, then connect with a new code from ${hub.label}.` : ''
      pairAgain.hidden = !refused
      show.hidden = unsaved
    }
    form.hidden = !showForm

    busyLine.textContent = busy === 'connect' ? 'Connecting…' : busy === 'forget' ? 'Disconnecting…' : ''
    busyLine.hidden = busyLine.textContent === ''
    // a sentence from the last answer first; with none, the saved file's problem while no Mac is connected
    message.textContent = said !== '' ? said : !showHub && available && problem && !unsaved ? PROBLEMS[problem] ?? DAMAGED : ''
    message.hidden = message.textContent === ''
    offer.hidden = offered === null || confirming !== null
    confirmBox.hidden = confirming === null
    if (confirming === 'replace' && offered) {
      confirmText.textContent = offered.reason === 'hub_exists' && offered.label
        ? `This Mac stops using ${offered.label}’s Inbox and uses the new one. ${offered.label} keeps this Mac in its list until you remove it there.`
        : 'This replaces the saved connection on this Mac.'
      confirmYes.textContent = 'Replace'
    } else if (confirming === 'disconnect' && hub) {
      confirmText.textContent = `This Mac stops using ${hub.label}’s Inbox. ${hub.label} keeps this Mac in its list until you remove it there.`
      confirmYes.textContent = 'Disconnect'
    }
    for (const control of section.querySelectorAll('input, button')) control.disabled = busy !== null
  }

  // A focused control that the paint hid or disabled (focus may then fall to the body) leaves focus on
  // `fallback`; focus somewhere else on the page is left alone.
  function keepFocus(fallback) {
    const active = documentRef.activeElement
    if (active && active !== documentRef.body && !section.contains(active)) return
    if (active && section.contains(active) && !active.hidden && !active.closest('[hidden]') && !active.disabled) return
    fallback?.focus({ preventScroll: true })
  }

  async function refresh() {
    const mine = ++reads
    let next
    try {
      next = await api.view()
    } catch {
      next = { available: false }
    }
    if (mine !== reads) return view
    view = next !== null && typeof next === 'object' ? next : { available: false }
    if (offered !== null && offered.reason === 'hub_exists' && view.hub) offered.label = view.hub.label
    paint()
    return view
  }

  async function run(kind, call) {
    if (busy !== null) return null
    busy = kind
    said = ''
    confirming = null
    paint()
    let answer
    try {
      answer = await call()
    } catch {
      answer = null
    }
    busy = null
    await refresh()
    return answer
  }

  async function sendConnect(input) {
    const label = offered?.label ?? null
    const answer = await run('connect', () => api.connect(input))
    offered = null
    if (answer !== null && typeof answer === 'object' && answer.available === false) {
      said = ''
    } else if (answer !== null && typeof answer === 'object' && answer.ok === true) {
      said = answer.replacedHub === true && label ? `${label} still lists this Mac until you remove it there.` : ''
      address.value = ''
      code.value = ''
    } else {
      const reason = answer !== null && typeof answer === 'object' && typeof answer.reason === 'string' ? answer.reason : 'failed'
      if (answer?.pairedOnHub === true) said = PAIRED_ON_HUB
      else said = Object.hasOwn(REFUSALS, reason) ? REFUSALS[reason] : FALLBACK
      if (answer === null) said = FALLBACK
      if (answer?.pairedOnHub !== true && REPLACEABLE.has(reason)) {
        offered = { reason, address: input.address, code: input.code, label: reason === 'hub_exists' ? view?.hub?.label ?? null : null }
      }
    }
    paint()
    keepFocus(offered ? replace : connected() ? show : address)
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (busy !== null) return
    const typed = address.value.trim()
    const cleaned = normaliseCode(code.value)
    offered = null
    confirming = null
    if (typed === '') said = 'Enter the other Mac’s address.'
    else if (cleaned === null) said = BAD_CODE
    else {
      void sendConnect({ address: typed, code: cleaned, replace: false })
      return
    }
    paint()
  })

  replace.addEventListener('click', () => {
    if (offered === null) return
    confirming = 'replace'
    paint()
    confirmNo.focus({ preventScroll: true })
  })
  disconnect.addEventListener('click', () => {
    if (!connected()) return
    said = ''
    confirming = 'disconnect'
    paint()
    confirmNo.focus({ preventScroll: true })
  })
  confirmNo.addEventListener('click', () => {
    const was = confirming
    confirming = null
    if (was === 'replace') {
      offered = null
      said = ''
      // what is connected now, read again
      void refresh().then(() => keepFocus(connected() ? show : address))
    }
    paint()
    keepFocus(connected() ? (was === 'disconnect' ? disconnect : show) : address)
  })
  confirmYes.addEventListener('click', () => {
    if (confirming === 'replace' && offered) {
      void sendConnect({ address: offered.address, code: offered.code, replace: true })
    } else if (confirming === 'disconnect' && connected()) {
      const id = view.hub.id
      void run('forget', () => api.forget(id)).then((answer) => {
        said = answer !== null && typeof answer === 'object' && (answer.ok === true || answer.available === false) ? '' : 'Agent Inbox couldn’t disconnect. Try again.'
        paint()
        keepFocus(connected() ? disconnect : address)
      })
    }
  })
  show.addEventListener('click', async () => {
    if (!connected() || busy !== null) return
    const hub = view.hub
    let answer
    try {
      answer = await api.show(hub.id)
    } catch {
      answer = null
    }
    const reason = answer !== null && typeof answer === 'object' && answer.ok === false ? answer.reason : null
    said = answer !== null && typeof answer === 'object' && (answer.ok === true || answer.available === false) ? ''
      : Object.hasOwn(SHOW_REFUSALS, reason) ? SHOW_REFUSALS[reason](hub.label) : 'Agent Inbox couldn’t show it. Try again.'
    paint()
  })

  void (async () => {
    const deskApi = desk()
    let local = false
    try {
      const answer = deskApi && typeof deskApi.connection === 'function' ? await deskApi.connection() : null
      local = answer !== null && typeof answer === 'object' && answer.mode === 'local'
    } catch {
      local = false
    }
    // the hub's page, a refusing or missing desk: nothing is drawn and main is asked nothing
    if (!local) {
      section.remove()
      return
    }
    section.hidden = false
    if (typeof api.onChange === 'function') {
      const stop = api.onChange(() => { void refresh() })
      stopShown = typeof stop === 'function' ? stop : null
    }
    refreshShown = () => (section.isConnected ? refresh() : Promise.resolve(null))
    await refresh()
  })()
  return section
}
