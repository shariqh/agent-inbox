// Settings → Agent sessions (issue #412 step 3, design §9): "Start sessions
// from Agent Inbox", off by default. Main owns the switch; this section only
// asks it through window.agentInboxLaunch, and only the viewer the Agent Inbox
// app started and owns gets an answer. Anywhere else (a browser, a viewer the
// app found already running, another platform) nothing is drawn: off means the
// page adds no control. Every string reaches the DOM as textContent.
//
// #432: with the switch on, it also shows where session worktrees go, with
// Choose… (main's own folder dialog) and Use default; the page names no folder.
// And "At most N sessions at once" (1–8), the cap main sends each driver.
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
  // made the first time main reports a cap: with the switch off, nothing is drawn
  let cap = null
  const capRow = () => {
    if (cap) return cap
    const row = make('label', 'launch-settings-worktree')
    row.id = 'launch-max-sessions'
    const select = make('select')
    select.name = 'maxSessions'
    for (let n = 1; n <= 8; n++) select.append(new Option(String(n), String(n)))
    row.append(make('span', 'launch-field-label', 'At most'), select, make('span', '', 'sessions at once'))
    select.addEventListener('change', async () => {
      select.disabled = true
      const result = await api.setMaxSessions(Number(select.value)).catch(() => ({ ok: false, error: 'Agent Inbox did not answer.' }))
      await read()
      if (!result?.ok) message.textContent = result?.error ?? 'That setting could not be changed.'
    })
    section.insertBefore(row, message)
    cap = { row, select }
    return cap
  }
  // made the first time main reports a worktree folder: with the switch off, nothing is drawn
  let worktree = null
  const worktreeRow = () => {
    if (worktree) return worktree
    const row = make('div', 'launch-settings-worktree')
    row.id = 'launch-worktree-root'
    const path = make('span', 'launch-settings-worktree-path')
    const choose = make('button', 'launch-action', 'Choose…')
    choose.type = 'button'
    const reset = make('button', 'launch-action', 'Use default')
    reset.type = 'button'
    row.append(make('span', 'launch-field-label', 'Worktree folder'), path, choose, reset)
    const act = async (call) => {
      choose.disabled = true
      reset.disabled = true
      const result = await call().catch(() => ({ ok: false, error: 'Agent Inbox did not answer.' }))
      await read()
      if (!result?.ok && !result?.cancelled) message.textContent = result?.error ?? 'That setting could not be changed.'
    }
    choose.addEventListener('click', () => act(() => api.chooseWorktreeRoot()))
    reset.addEventListener('click', () => act(() => api.resetWorktreeRoot()))
    section.insertBefore(row, message)
    worktree = { row, path, choose, reset }
    return worktree
  }

  const show = (state) => {
    // only the viewer this app owns: anywhere else the section stays out of sight
    section.hidden = !state?.owned
    input.checked = state?.enabled === true
    input.disabled = !state?.owned || (!state.enabled && !state.canEnable)
    message.textContent = state?.owned && !state.enabled && !state.canEnable ? 'Starting sessions from Agent Inbox is available on macOS.' : ''
    const most = state?.owned && state.enabled && Number.isSafeInteger(state.maxSessions) ? state.maxSessions : null
    if (most || cap) {
      const c = capRow()
      c.row.hidden = !most
      if (most) c.select.value = String(most)
      c.select.disabled = !most || typeof api.setMaxSessions !== 'function'
    }
    const root = state?.owned && state.enabled ? state.worktreeRoot : null
    if (root || worktree) {
      const w = worktreeRow()
      w.row.hidden = !root
      w.path.textContent = root ? `${root.path}${root.isDefault ? ' (default)' : ''}` : ''
      w.choose.disabled = !root || typeof api.chooseWorktreeRoot !== 'function'
      w.reset.disabled = !root || root.isDefault || typeof api.resetWorktreeRoot !== 'function'
    }
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
