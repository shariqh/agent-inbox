// Settings → Links (issue #300 part 2): which app opens web links and each
// type of file when they are opened from the Inbox, instead of the Mac's own
// defaults.
//
// Electron main owns the rules. This section only asks it, through the
// window.agentInboxLinkSettings bridge, and names a rule and a handler: an app
// comes only from main's own native picker ("Choose app…"), and what comes back
// names the app, never its path. Main's safety policy still runs before any
// rule, so apps, installers, aliases and anything executable are only ever
// revealed, and "System default" is offered only for the common document types
// main opens with the system's app (a rule's `systemDefault`). Per-type apps
// are macOS-only; elsewhere, and in a browser, the section says so. Every
// string reaches the DOM as textContent.
const FILE_HANDLERS = [['default', 'System default'], ['quicklook', 'Quick Look'], ['reveal', 'Reveal in Finder']]
const WEB_HANDLERS = [['default', 'Default browser']]
const ERRORS = {
  invalid: 'That setting couldn’t be changed.',
  covered: 'Markdown already covers .md and .markdown.',
  blocked: 'Agent Inbox never opens that type of file, so it can’t have a rule.',
  exists: 'That file type already has a rule.',
  full: 'You can add up to 20 file types.',
  'not-an-app': 'That isn’t an app. Choose one from Applications.',
  'runs-code': 'That app runs what it opens, so Agent Inbox won’t open links with it.',
  newer: 'A newer version of Agent Inbox saved these settings. Update it to change them.',
  failed: 'Agent Inbox couldn’t save that. Try again.',
}

function option(documentRef, value, text) {
  const el = documentRef.createElement('option')
  el.value = value
  el.textContent = text
  return el
}

// Main answers a page that is not the viewer this app started and owns with
// an empty view saying so ('unowned'), as it refuses that page's file links.
const HINTS = {
  rules: 'Links you open from the Inbox use these instead of your Mac’s defaults. To open a type Agent Inbox only shows in Finder, such as .py, add it and choose an app. Apps, installers, aliases and anything executable are never opened.',
  unowned: 'Choosing how links open works only in Agent Inbox’s own viewer, not in one it found already running.',
  elsewhere: 'Links open with your system’s default apps. Choosing an app for each type of file is available on macOS.',
}

// Asks main for the section again, as Settings does each time it opens: a
// reload's re-proof may have finished since the section was drawn.
let refreshShown = null
export function refreshLinkSettings() {
  return refreshShown ? refreshShown() : Promise.resolve(null)
}

export function renderLinkSettings(host, {
  bridge = () => globalThis.agentInboxLinkSettings,
  documentRef = globalThis.document,
} = {}) {
  const make = (tag, className, text) => {
    const el = documentRef.createElement(tag)
    if (className) el.className = className
    if (text !== undefined) el.textContent = text
    return el
  }
  const section = make('section', 'setup-block link-settings')
  section.id = 'link-settings'
  const hint = make('p', 'setup-hint')
  hint.id = 'link-settings-hint'
  const rules = make('div', 'link-rules')
  const message = make('p', 'link-settings-message')
  message.setAttribute('role', 'status')
  message.setAttribute('aria-live', 'polite')
  section.append(make('h3', '', 'Links'), hint, rules, message)
  host.appendChild(section)

  const api = bridge()
  if (!api || typeof api.get !== 'function') {
    refreshShown = null
    hint.textContent = 'In the Agent Inbox app on macOS, you can choose which app opens web links and each type of file.'
    return section
  }
  hint.textContent = HINTS.rules

  const form = make('form', 'link-add-type')
  const addLabel = make('label', '', 'Add a file type')
  addLabel.htmlFor = 'link-add-type-input'
  const input = make('input')
  input.id = 'link-add-type-input'
  input.type = 'text'
  input.placeholder = '.log'
  input.maxLength = 17
  input.autocomplete = 'off'
  input.spellcheck = false
  const add = make('button', '', 'Add')
  add.type = 'submit'
  form.append(addLabel, input, add)

  let busy = false
  const paint = (view, focusRule) => {
    const available = Boolean(view && view.available)
    const unowned = Boolean(view && view.error === 'unowned')
    message.textContent = view && view.error && !unowned ? ERRORS[view.error] ?? ERRORS.failed : ''
    if (!available) {
      hint.textContent = unowned ? HINTS.unowned : HINTS.elsewhere
      rules.replaceChildren()
      form.remove()
      return
    }
    hint.textContent = HINTS.rules
    rules.replaceChildren(...view.rules.map((rule, index) => ruleRow(rule, index)))
    section.appendChild(form)
    section.appendChild(message)
    if (focusRule) {
      const target = focusRule === 'add' ? input : rules.querySelector(`select[data-rule="${CSS.escape(focusRule)}"]`)
      target?.focus({ preventScroll: true })
    }
  }
  const run = async (call, focusRule) => {
    if (busy) return null
    busy = true
    section.setAttribute('aria-busy', 'true')
    let view
    try {
      view = await call()
    } catch {
      view = { available: true, rules: [], error: 'failed' }
    }
    busy = false
    section.removeAttribute('aria-busy')
    paint(view, focusRule)
    return view
  }
  const ruleRow = (rule, index) => {
    const row = make('div', 'link-rule')
    const label = make('label', 'link-rule-label', rule.label)
    const select = make('select')
    select.id = `link-rule-${index}`
    select.dataset.rule = rule.id
    label.htmlFor = select.id
    for (const [value, text] of rule.kind === 'web' ? WEB_HANDLERS : FILE_HANDLERS) {
      if (value === 'default' && rule.systemDefault === false) continue
      select.appendChild(option(documentRef, value, text))
    }
    if (rule.appName) select.appendChild(option(documentRef, 'app', rule.appName))
    select.appendChild(option(documentRef, 'choose', rule.appName ? 'Choose another app…' : 'Choose app…'))
    select.value = rule.handler === 'app' && !rule.appName ? 'default' : rule.handler
    select.addEventListener('change', () => {
      const value = select.value
      if (value === 'choose') void run(() => api.chooseApp(rule.id), rule.id)
      else if (value !== 'app') void run(() => api.setHandler(rule.id, value), rule.id)
    })
    row.append(label, select)
    if (rule.removable) {
      const remove = make('button', 'link-rule-remove', 'Remove')
      remove.type = 'button'
      remove.setAttribute('aria-label', `Remove ${rule.label}`)
      remove.addEventListener('click', () => { void run(() => api.removeType(rule.id), 'add') })
      row.appendChild(remove)
    }
    return row
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const view = await run(() => api.addType(input.value), 'add')
    if (view && !view.error) input.value = ''
  })

  refreshShown = () => (section.isConnected ? run(() => api.get()) : Promise.resolve(null))
  void run(() => api.get())
  return section
}
