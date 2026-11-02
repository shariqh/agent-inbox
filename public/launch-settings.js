// Settings → Agent sessions (issue #412 step 3, design §9): "Start sessions
// from Agent Inbox", off by default. Main owns the switch; this section only
// asks it through window.agentInboxLaunch, and only the viewer the Agent Inbox
// app started and owns gets an answer. Anywhere else (a browser, a viewer the
// app found already running, another platform) nothing is drawn: off means the
// page adds no control. Every string reaches the DOM as textContent.
let refreshShown = null

/** Asks main again, as Settings does each time it opens. */
export function refreshLaunchSettings() {
  return refreshShown ? refreshShown() : Promise.resolve(null)
}

export function renderLaunchSettings(host, {
  bridge = () => globalThis.agentInboxLaunch,
  documentRef = globalThis.document,
  onChange = () => {},
} = {}) {
  const api = bridge()
  refreshShown = null
  if (!api || typeof api.available !== 'function') return null
  const make = (tag, className, text) => {
    const el = documentRef.createElement(tag)
    if (className) el.className = className
    if (text !== undefined) el.textContent = text
    return el
  }
  const section = make('section', 'setup-block launch-settings')
  section.id = 'launch-settings'
  section.hidden = true
  const label = make('label', 'launch-switch')
  const input = make('input')
  input.type = 'checkbox'
  input.setAttribute('role', 'switch')
  input.id = 'launch-switch'
  label.append(input, make('span', '', 'Start sessions from Agent Inbox'))
  const hint = make('p', 'setup-hint', 'Start a Copilot session in one of your projects from Live sessions → New session…, and send it messages as new turns. Its approvals arrive in the inbox under @sessions, and only this app can answer them. Park now keeps a session to resume later; Stop ends it. Once any shell command is allowed, a session can run anything.')
  const keychain = make('p', 'setup-hint', 'The key that signs your approvals is protected by the macOS Keychain, so macOS may ask once to allow it.')
  const message = make('p', 'launch-settings-message')
  message.setAttribute('role', 'status')
  message.setAttribute('aria-live', 'polite')
  section.append(make('h3', '', 'Agent sessions'), label, hint, keychain, message)
  host.appendChild(section)

  const show = (state) => {
    // only the viewer this app owns: anywhere else the section stays out of sight
    section.hidden = !state?.owned
    input.checked = state?.enabled === true
    input.disabled = !state?.owned || (!state.enabled && !state.canEnable)
    message.textContent = state?.owned && !state.enabled && !state.canEnable ? 'Starting sessions from Agent Inbox is available on macOS.' : ''
    return state
  }
  const read = () => api.available().then(show, () => show(null))
  refreshShown = read
  input.addEventListener('change', async () => {
    const want = input.checked
    input.disabled = true
    const result = await api.setEnabled(want).catch(() => ({ ok: false, error: 'Agent Inbox did not answer.' }))
    const state = await read()
    if (!result?.ok) message.textContent = result?.error ?? 'That setting could not be changed.'
    onChange(state)
  })
  read().then(onChange)
  return section
}
