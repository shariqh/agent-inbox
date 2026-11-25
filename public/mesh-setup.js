// Agent setup in the app, step 2b: the Agent cards tab's Marketplace and Model servers sections,
// the set-up pages that open in the tab in place of an agent's page (add a server, make an agent's
// own settings a server, set up an agent), and the foot of an agent's page (Change server, Turn
// off). Everything runs through the local window's mesh bridge (`agentInboxMesh`, step 2a), a dry
// run first; another Mac's page and a browser have no bridge and see the Marketplace only.
//
// House rules: what came from the bridge, the command or a server is set as text, never markup. An
// open page, a row asking "Remove?", a chosen entry and a running operation are this module's state;
// a passive repaint only updates text, disabled states and option lists in place, so it never closes
// a page, clears a field, moves focus or starts an operation. One operation runs at a time: while it
// does every control that would start another is disabled and the pressed one says what is
// happening. Nothing here is an ask: no state reaches attention, a badge or a count.

// the built-ins the Marketplace draws; unslop's rules folder cannot be set from the app yet (D4)
const OFFERS = new Set(['unslop', 'unslop-code', 'request-post'])
const MODEL_AGENTS = new Set(['unslop', 'unslop-code'])
const NEEDS = { 'model-server': 'Needs a model server', 'address-and-token': 'Needs an address and a token' }
const TERMINAL = 'Set up in a terminal for now (docs/unslop.md).'
const ELSEWHERE = 'Set these up in the app on the Mac that runs your agents.'
const KEYS = { file: 'key file', command: 'key from a command', env: 'key from a variable', none: 'no key' }
// D6: the bridge's failure words; a cancel says nothing, every other reason names itself
const REASONS = {
  'not-installed': 'The mesh command is not installed on this Mac. Run Setup first.',
  outdated: 'The installed mesh command is older than this app. Run Setup again.',
  busy: 'Another setup step is still running.',
  setup: 'Setup is running. Try again when it is done.',
  updating: 'An update is installing.',
  timeout: 'The command did not answer in time.',
  cancelled: '',
}
// a server check's failure, in plain words
const CHECKS = {
  unreachable: 'The server did not answer.',
  unauthorized: 'The server refused the key.',
  'not-a-model-server': 'This address does not answer as a model server.',
  timeout: 'The server did not answer in time.',
  key: 'The key could not be read.',
}
const SERVER_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/
const MODEL_NAME = /^[A-Za-z0-9._:/-]{1,64}$/
// the server list's last entry; no server name can start with a space
const ADD = ' add'

const reasonText = (reason) => (Object.hasOwn(REASONS, reason) ? REASONS[reason] : `That did not work (${reason}).`)
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`
const strings = (list) => (Array.isArray(list) ? list.filter((item) => typeof item === 'string') : [])

/** A refusal's own words, a failure's sentence, '' for a cancel, or null when the answer is no problem. */
function problem(answer) {
  if (!answer || typeof answer !== 'object') return reasonText('failed')
  if (typeof answer.refused === 'string' && answer.refused) return answer.refused
  if (answer.ok === true) return null
  return reasonText(typeof answer.reason === 'string' ? answer.reason : 'failed')
}

function checkText(answer) {
  const words = problem(answer)
  if (words !== null) return words
  if (answer.reachable === true) return `reachable · ${plural(strings(answer.models).length, 'model')}`
  return CHECKS[answer.failure] ?? CHECKS.unreachable
}

function httpAddress(text) {
  try {
    const url = new URL(text)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * @param {{doc?: Document, bridge: () => any, local: () => Promise<boolean>,
 *   home: () => HTMLElement | null, setupPage: () => HTMLElement | null, agentPage: () => HTMLElement | null,
 *   panel: () => HTMLElement | null, heading: () => HTMLElement | null, active: () => boolean,
 *   changed: () => void, reload: () => void, turnedOn: (name: string) => void, turnedOff: () => void,
 *   check: (name: string) => void, toTop: () => void}} deps
 */
export function installMeshSetup(deps) {
  const doc = deps.doc ?? globalThis.document
  // the bridge is there and the page is this Mac's own; its last availability answer; whether it was asked yet
  let present = false
  let availability = null
  let known = false
  // the last `servers` answer: { list, inline }, or { problem } with its words; null before the first
  let servers = null
  // the running operation's control key, and one model list asked while another ran
  let running = null
  let queued = null
  // a server row's last check or refusal, by name (an inline agent's by `inline:<agent>`); the row asking "Remove?"
  const notes = new Map()
  // the "still use this server" line a Remove press wrote into a row's note, to take it away once no agent uses it
  const usedNotes = new Map()
  let removing = null
  // the open set-up page, or null; the agent page's foot
  let page = null
  const foot = { agent: null, asking: false, message: '' }
  // an agent just turned on (or given another server), until it shows in the tab's data and is checked once
  let fresh = null
  let version = 0
  // the open page's elements, rebuilt only when a page opens or comes back
  let els = null

  const make = (tag, className, text) => {
    const el = doc.createElement(tag)
    if (className) el.className = className
    if (text !== undefined) el.textContent = text
    return el
  }
  const button = (className, text) => {
    const el = make('button', `ms-btn ${className}`, text)
    el.type = 'button'
    return el
  }
  const setText = (el, text) => { if (el.textContent !== text) el.textContent = text }
  const setHidden = (el, hidden) => { if (el.hidden !== hidden) el.hidden = hidden }
  const setDisabled = (el, disabled) => { if (el.disabled !== disabled) el.disabled = disabled }
  const usable = () => present && availability?.available === true
  const busy = () => running !== null
  const label = (key, idle, doing) => (running === key ? doing : idle)
  const changed = () => {
    version += 1
    deps.changed()
  }

  // Focus after an operation: onto `want` when focus is still in the tab (often on a control that
  // was disabled meanwhile) or nowhere; a person who moved it elsewhere keeps it there. `lost`: only
  // when focus went nowhere (its control left the page).
  function settleFocus(want, { lost = false } = {}) {
    const el = typeof want === 'function' ? want() : want
    if (!el?.isConnected) return
    const active = doc.activeElement
    if (active === el) return
    const nowhere = !active || active === doc.body || !active.isConnected
    if (nowhere || (!lost && deps.panel()?.contains(active))) el.focus({ preventScroll: true })
  }

  async function call(operation, values) {
    try {
      return await deps.bridge().run(operation, values)
    } catch {
      return { ok: false, reason: 'failed' }
    }
  }

  // One operation at a time: false when another runs (a second press does nothing)
  async function act(key, work) {
    if (running !== null || !usable()) return false
    running = key
    changed()
    try {
      await work()
    } finally {
      running = null
      changed()
    }
    const next = queued
    queued = null
    if (next) await next()
    return true
  }

  async function listServers() {
    await act('servers', async () => {
      const answer = await call('servers', {})
      const words = problem(answer)
      if (words === null) {
        const list = (Array.isArray(answer.servers) ? answer.servers : []).filter((row) => row && typeof row.name === 'string')
        servers = { list, inline: strings(answer.inline) }
      } else servers = { problem: words }
    })
  }

  // true when it listed the servers (the bridge has just become available on the tab)
  async function refreshAvailable() {
    const bridge = deps.bridge()
    if (!bridge || typeof bridge.available !== 'function' || typeof bridge.run !== 'function' || !(await deps.local())) {
      if (present || !known) {
        present = false
        known = true
        changed()
      }
      return false
    }
    let answer = null
    try {
      answer = await bridge.available()
    } catch { /* no answer: not available */ }
    const was = usable()
    present = true
    known = true
    availability = answer?.available === true ? { available: true } : { available: false, reason: typeof answer?.reason === 'string' ? answer.reason : 'failed' }
    changed()
    if (was || !usable() || !deps.active()) return false
    await listServers()
    return true
  }

  // ── the home's two sections ────────────────────────────────────────────────

  let market = null
  let serverSection = null
  const offerEls = new Map()
  const rowEls = new Map()

  function marketEl() {
    if (market) return market
    market = make('section', 'ms-section ms-market')
    market.setAttribute('aria-labelledby', 'meshMarketTitle')
    const head = make('div', 'ma-head')
    const title = make('h2', 'ma-title-text', 'Marketplace')
    title.id = 'meshMarketTitle'
    head.append(title)
    const grid = make('ul', 'ma-grid')
    grid.setAttribute('role', 'list')
    grid.setAttribute('aria-labelledby', 'meshMarketTitle')
    market.append(head, make('p', 'ms-line'), grid)
    grid.addEventListener('click', (event) => {
      const card = event.target instanceof doc.defaultView.Element ? event.target.closest('.ms-offer') : null
      const name = card?.parentElement.dataset.offer
      if (!name || !card.classList.contains('ms-openable')) return
      openAgent(name, { opener: () => offerEls.get(name)?.querySelector('.ms-setup') ?? null })
    })
    return market
  }

  function offerEl(name) {
    const el = make('li', 'ma-item')
    el.dataset.offer = name
    const card = make('div', 'ma-card ms-offer')
    const top = make('span', 'ma-line ma-top')
    top.append(make('span', 'ma-name', name))
    const end = make('span', 'ma-line ma-foot')
    end.append(button('ms-setup', 'Set up'), make('span', 'ms-terminal', TERMINAL))
    end.querySelector('.ms-setup').setAttribute('aria-label', `Set up ${name}`)
    card.append(top, make('span', 'ma-line ma-description'), make('span', 'ma-line ms-needs'), end)
    el.append(card)
    return el
  }

  function paintMarket(section, available) {
    const offers = (Array.isArray(available) ? available : []).filter((offer) => offer && OFFERS.has(offer.name))
    const line = section.querySelector('.ms-line')
    // nothing until the bridge was asked; a bridge that is there but not available says why, when it can
    const words = !known ? '' : !present ? ELSEWHERE : usable() || !availability ? '' : REASONS[availability.reason] ?? ''
    setText(line, words)
    setHidden(line, !words)
    const grid = section.querySelector('.ma-grid')
    const keep = new Set()
    const nodes = offers.map((offer) => {
      const name = String(offer.name)
      keep.add(name)
      let el = offerEls.get(name)
      if (!el) offerEls.set(name, (el = offerEl(name)))
      const card = el.firstChild
      setText(card.querySelector('.ma-description'), typeof offer.blurb === 'string' ? offer.blurb : '')
      setText(card.querySelector('.ms-needs'), NEEDS[offer.needs] ?? '')
      const settable = usable() && name !== 'unslop'
      card.classList.toggle('ms-openable', settable)
      const setup = card.querySelector('.ms-setup')
      setHidden(setup, !settable)
      setDisabled(setup, busy())
      setHidden(card.querySelector('.ms-terminal'), !(usable() && name === 'unslop'))
      return el
    })
    for (const [name, el] of offerEls) {
      if (keep.has(name)) continue
      el.remove()
      offerEls.delete(name)
    }
    nodes.forEach((el, index) => { if (grid.children[index] !== el) grid.insertBefore(el, grid.children[index] ?? null) })
  }

  function serversEl() {
    if (serverSection) return serverSection
    serverSection = make('section', 'ms-section ms-servers')
    serverSection.setAttribute('aria-labelledby', 'meshServersTitle')
    const head = make('div', 'ma-head')
    const title = make('h2', 'ma-title-text', 'Model servers')
    title.id = 'meshServersTitle'
    head.append(title)
    const rows = make('ul', 'ms-rows')
    rows.setAttribute('role', 'list')
    rows.setAttribute('aria-labelledby', 'meshServersTitle')
    const add = button('ms-add', 'Add a server')
    serverSection.append(head, make('p', 'ms-line'), rows, add)
    add.addEventListener('click', () => openAdd({ opener: () => serverSection.querySelector('.ms-add') }))
    rows.addEventListener('click', (event) => {
      const control = event.target instanceof doc.defaultView.Element ? event.target.closest('button') : null
      const row = control?.closest('.ms-row')
      if (!row || control.disabled) return
      const name = row.dataset.server
      if (row.dataset.inline) {
        const agent = row.dataset.inline
        openAdopt(agent, { opener: () => rowEls.get(`inline:${agent}`)?.querySelector('.ms-adopt') ?? null })
      } else if (control.classList.contains('ms-check')) checkRow(name)
      else if (control.classList.contains('ms-remove')) {
        const users = strings(servers?.list?.find((server) => server.name === name)?.agents)
        if (users.length) {
          // agents still use it: nothing runs and nothing is asked; the row says what to do first
          const words = users.length === 1 ? `${users[0]} still uses this server. Change its server first.` : `${users.join(', ')} still use this server. Change their server first.`
          notes.set(name, words)
          usedNotes.set(name, words)
          changed()
          return
        }
        // an earlier "still use" line is out of date now
        if (usedNotes.has(name) && notes.get(name) === usedNotes.get(name)) notes.delete(name)
        usedNotes.delete(name)
        removing = name
        changed()
        settleFocus(() => rowEls.get(name)?.querySelector('.ms-cancel'))
      } else if (control.classList.contains('ms-cancel')) {
        removing = null
        changed()
        settleFocus(() => rowEls.get(name)?.querySelector('.ms-remove'))
      } else if (control.classList.contains('ms-confirm')) removeServer(name)
    })
    return serverSection
  }

  function serverRowEl(name) {
    const el = make('li', 'ms-row')
    el.dataset.server = name
    const main = make('div', 'ms-row-main')
    const text = make('span', 'ms-row-text')
    text.append(make('span', 'ms-row-name', name), make('span', 'ms-row-facts'))
    const actions = make('span', 'ms-row-actions')
    actions.append(button('ms-check', 'Check'), button('ms-remove', 'Remove'))
    actions.querySelector('.ms-check').setAttribute('aria-label', `Check ${name}`)
    actions.querySelector('.ms-remove').setAttribute('aria-label', `Remove ${name}`)
    main.append(text, actions)
    const ask = make('div', 'ms-ask')
    ask.append(make('span', 'ms-ask-text', `Remove ${name}?`), button('ms-confirm', 'Remove'), button('ms-cancel', 'Cancel'))
    el.append(main, make('p', 'ms-row-note'), ask)
    return el
  }

  function inlineRowEl(agent) {
    const el = make('li', 'ms-row')
    el.dataset.inline = agent
    const main = make('div', 'ms-row-main')
    const actions = make('span', 'ms-row-actions')
    actions.append(button('ms-adopt', 'Make it a server'))
    actions.firstChild.setAttribute('aria-label', `Make ${agent}’s settings a server`)
    main.append(make('span', 'ms-row-text', `${agent} has its own settings`), actions)
    el.append(main)
    return el
  }

  function paintServers(section) {
    const line = section.querySelector('.ms-line')
    const list = servers?.list ?? []
    const inline = servers?.inline ?? []
    const words = servers?.problem ?? (servers && !list.length && !inline.length ? 'No model server yet.' : '')
    setText(line, words)
    setHidden(line, !words)
    const rows = section.querySelector('.ms-rows')
    const keep = new Set()
    const nodes = [
      ...list.map((server) => {
        const name = String(server.name)
        keep.add(name)
        let el = rowEls.get(name)
        if (!el) rowEls.set(name, (el = serverRowEl(name)))
        const agents = strings(server.agents)
        const facts = [typeof server.baseUrl === 'string' ? server.baseUrl : '', KEYS[server.key] ?? '', agents.length ? `used by ${agents.join(', ')}` : '']
        setText(el.querySelector('.ms-row-facts'), facts.filter(Boolean).join(' · '))
        const note = el.querySelector('.ms-row-note')
        setText(note, notes.get(name) ?? '')
        setHidden(note, !note.textContent)
        const check = el.querySelector('.ms-check')
        setText(check, label(`check:${name}`, 'Check', 'Checking…'))
        setDisabled(check, busy())
        setDisabled(el.querySelector('.ms-remove'), busy())
        setHidden(el.querySelector('.ms-ask'), removing !== name)
        const confirm = el.querySelector('.ms-confirm')
        setText(confirm, label(`remove:${name}`, 'Remove', 'Removing…'))
        setDisabled(confirm, busy())
        setDisabled(el.querySelector('.ms-cancel'), busy())
        return el
      }),
      ...inline.map((agent) => {
        const key = `inline:${agent}`
        keep.add(key)
        let el = rowEls.get(key)
        if (!el) rowEls.set(key, (el = inlineRowEl(agent)))
        setDisabled(el.querySelector('.ms-adopt'), busy())
        return el
      }),
    ]
    for (const [key, el] of rowEls) {
      if (keep.has(key)) continue
      el.remove()
      rowEls.delete(key)
    }
    setHidden(rows, !nodes.length)
    nodes.forEach((el, index) => { if (rows.children[index] !== el) rows.insertBefore(el, rows.children[index] ?? null) })
    setDisabled(section.querySelector('.ms-add'), busy())
  }

  async function checkRow(name, { focus = true } = {}) {
    await act(`check:${name}`, async () => {
      notes.set(name, checkText(await call('check-server', { name })))
    })
    if (focus) settleFocus(() => rowEls.get(name)?.querySelector('.ms-check'))
  }

  async function removeServer(name) {
    let removed = false
    await act(`remove:${name}`, async () => {
      for (const apply of [false, true]) {
        const words = problem(await call('remove-server', { name, apply }))
        if (words === null) continue
        removing = null
        if (words) notes.set(name, words)
        return
      }
      removing = null
      notes.delete(name)
      removed = true
    })
    if (!removed) {
      settleFocus(() => rowEls.get(name)?.querySelector('.ms-remove'))
      return
    }
    deps.reload()
    await listServers()
    settleFocus(() => serverSection?.querySelector('.ms-add'))
  }

  // ── the set-up pages ───────────────────────────────────────────────────────

  function blank(kind, extra) {
    return {
      kind, opener: null, back: null, agent: null, change: false, message: '', review: null, file: null,
      values: { name: '', baseUrl: '', key: 'none', server: '', model: '', endpoint: '' },
      model: { server: '', state: 'idle', models: [], why: '' },
      ...extra,
    }
  }

  function openAdd({ opener = null, back = null } = {}) {
    if (busy()) return
    page = blank('add', { opener, back })
    show()
  }

  function openAdopt(agent, { opener = null } = {}) {
    if (busy()) return
    page = blank('adopt', { opener, agent })
    show()
  }

  function openAgent(name, { opener = null, change = false } = {}) {
    if (busy() || !usable()) return
    page = blank('agent', { opener, agent: name, change })
    // the server it uses now, else the only one there is, is chosen already
    const list = servers?.list ?? []
    const current = change ? list.find((server) => strings(server.agents).includes(name)) : undefined
    const chosen = current ?? (list.length === 1 ? list[0] : undefined)
    if (MODEL_AGENTS.has(name) && chosen) page.values.server = String(chosen.name)
    show()
    if (page.values.server) askModels(page.values.server, { focus: false })
  }

  // A page opens (or comes back): its elements are built once from its state, focus goes to its first field
  function show() {
    els = null
    changed()
    deps.toTop()
    els?.first?.focus({ preventScroll: true })
  }

  function back() {
    if (!page) return false
    const left = page
    page = left.back
    els = null
    changed()
    if (page) els?.server?.focus({ preventScroll: true })
    else settleFocus(() => left.opener?.() ?? deps.heading())
    return true
  }

  function field(labelText, control, hint) {
    const wrap = make('label', 'ms-field')
    wrap.append(make('span', 'ms-label', labelText), control)
    if (hint) wrap.append(make('span', 'ms-hint', hint))
    return wrap
  }

  function input(name, value) {
    const el = make('input', 'ms-input')
    el.type = 'text'
    el.name = name
    el.value = value
    el.autocomplete = 'off'
    el.spellcheck = false
    el.addEventListener('input', () => {
      if (page) page.values[name] = el.value
    })
    return el
  }

  // Choose file…: main's own picker; only the file's base name ever reaches the page
  function chooser(purpose) {
    const wrap = make('span', 'ms-file')
    const choose = button('ms-choose', 'Choose file…')
    wrap.append(choose, make('span', 'ms-file-name'))
    choose.addEventListener('click', async () => {
      const mine = page
      await act('file', async () => {
        let answer
        try {
          answer = await deps.bridge().chooseFile(purpose)
        } catch {
          answer = { ok: false, reason: 'failed' }
        }
        if (page !== mine) return
        if (answer?.ok === true && typeof answer.handle === 'string' && typeof answer.name === 'string') {
          page.file = { handle: answer.handle, name: answer.name }
          page.message = ''
        } else {
          const words = problem(answer)
          if (words) page.message = words
        }
      })
      settleFocus(() => els?.root.querySelector('.ms-choose'))
    })
    return wrap
  }

  function build(root) {
    const title = page.kind === 'add' ? 'Add a model server' : page.kind === 'adopt' ? 'Make it a server' : page.agent
    // it goes back to where the page came from: an agent's form, the agent's own page, or the grid
    const goesTo = page.back ? page.back.agent : page.change ? page.agent : null
    const backButton = make('button', 'map-back', goesTo ? `← ${goesTo}` : '← Agent cards')
    backButton.type = 'button'
    backButton.setAttribute('aria-label', goesTo ? `Back to ${goesTo}` : 'Back to Agent cards')
    backButton.addEventListener('click', () => back())
    const form = make('form', 'ms-form')
    form.noValidate = true
    form.setAttribute('aria-label', title)
    form.addEventListener('submit', (event) => event.preventDefault())
    const refs = { root, form, first: null, server: null }
    const fields = make('div', 'ms-fields')
    const actions = make('div', 'ms-actions')
    if (page.kind === 'add' || page.kind === 'adopt') {
      if (page.kind === 'adopt') fields.append(make('p', 'ms-hint', `Saves ${page.agent}’s own address and key as a server.`))
      const name = input('name', page.values.name)
      fields.append(field('Name', name, 'Lower-case letters, digits and hyphens.'))
      refs.first = name
      if (page.kind === 'add') {
        fields.append(field('Address', input('baseUrl', page.values.baseUrl)))
        const choice = make('fieldset', 'ms-choice')
        choice.append(make('legend', 'ms-label', 'Key'))
        for (const [value, text] of [['none', 'No key'], ['file', 'Key file']]) {
          const option = make('label', 'ms-radio')
          const radio = make('input')
          radio.type = 'radio'
          radio.name = 'msKey'
          radio.value = value
          radio.checked = page.values.key === value
          radio.addEventListener('change', () => {
            if (!page || !radio.checked) return
            page.values.key = value
            changed()
          })
          option.append(radio, doc.createTextNode(` ${text}`))
          choice.append(option)
        }
        choice.append(chooser('key'))
        fields.append(choice)
      }
      actions.append(button('ms-save ms-primary', 'Save'))
      actions.firstChild.addEventListener('click', () => save())
    } else if (MODEL_AGENTS.has(page.agent)) {
      const server = make('select', 'ms-select ms-server')
      server.name = 'server'
      server.addEventListener('change', () => {
        if (!page) return
        if (server.value === ADD) {
          server.value = page.values.server
          openAdd({ back: page })
          return
        }
        page.values.server = server.value
        page.values.model = ''
        page.model = { server: '', state: 'idle', models: [], why: '' }
        page.review = null
        changed()
        if (server.value) askModels(server.value, { focus: true })
      })
      fields.append(field('Model server', server))
      const list = make('select', 'ms-select ms-model-list')
      list.name = 'model'
      list.addEventListener('change', () => {
        if (page) page.values.model = list.value
      })
      list.id = 'meshModelList'
      const typed = input('model', page.values.model)
      typed.classList.add('ms-model-text')
      typed.id = 'meshModelText'
      // one label, for whichever of the two shows
      const model = make('div', 'ms-field ms-model')
      model.append(make('label', 'ms-label ms-model-label', 'Model'), list, typed, make('span', 'ms-hint ms-model-why'))
      fields.append(model)
      refs.first = server
      refs.server = server
    } else {
      const endpoint = input('endpoint', page.values.endpoint)
      fields.append(field('Service address', endpoint))
      const token = make('div', 'ms-field')
      token.append(make('span', 'ms-label', 'Token file'), chooser('token'))
      fields.append(token)
      refs.first = endpoint
    }
    if (page.kind === 'agent') {
      actions.append(button('ms-try ms-primary', 'Check'))
      actions.firstChild.addEventListener('click', () => tryAgent())
    }
    const review = make('div', 'ms-review')
    const heading = make('h3', 'ms-review-title', page.change ? 'Changing the server will' : 'Turning it on will')
    const reviewActions = make('div', 'ms-actions')
    const apply = button('ms-apply ms-primary', page.change ? 'Change server' : 'Turn on')
    const reviewBack = button('ms-review-back', 'Back')
    reviewActions.append(apply, reviewBack)
    // the page's own short summary, a quiet line, the buttons, and the command's own lines closed under them
    const exact = make('details', 'ms-exact')
    exact.append(make('summary', '', 'Exact steps'), make('ul', 'ms-exact-steps'))
    review.append(heading, make('ul', 'ms-steps'), make('p', 'ms-refused'), make('p', 'ms-hint ms-nothing', 'Nothing has changed yet.'), reviewActions, exact)
    apply.addEventListener('click', () => applyAgent())
    reviewBack.addEventListener('click', () => {
      if (!page || busy()) return
      page.review = null
      changed()
      settleFocus(() => els?.root.querySelector('.ms-try'))
    })
    const message = make('p', 'ms-message')
    message.setAttribute('role', 'status')
    form.append(fields, message, actions, review)
    root.replaceChildren(backButton, form)
    return refs
  }

  // What turning it on (or changing the server) does, in the page's own words, from what the person chose
  function summary() {
    const { agent, change, values } = page
    if (MODEL_AGENTS.has(agent)) {
      return change
        ? [`Point ${agent} at server ${values.server}, model ${values.model}.`, 'Keep a backup of its old settings.']
        : [`Save its settings: server ${values.server}, model ${values.model}.`, 'Add the command that you and your chats run.', `Add ${agent} to your agents.`]
    }
    return ['Keep a private copy of the token.', 'Add the command that you and your chats run.', `Add ${agent} to your agents.`]
  }

  function paintPage(root) {
    if (!els || els.root !== root || !root.contains(els.form)) els = build(root)
    const disabled = busy() || Boolean(page.review)
    for (const el of els.form.querySelectorAll('input, select')) if (!el.classList.contains('ms-model-list')) setDisabled(el, disabled)
    const message = els.form.querySelector('.ms-message')
    setText(message, page.message)
    setHidden(message, !page.message)
    const choose = els.form.querySelector('.ms-choose')
    if (choose) {
      setDisabled(choose, disabled)
      setHidden(choose, page.kind === 'add' && page.values.key !== 'file')
      const name = els.form.querySelector('.ms-file-name')
      setText(name, page.file?.name ?? '')
      setHidden(name, !page.file || choose.hidden)
    }
    const save = els.form.querySelector('.ms-save')
    if (save) {
      setText(save, label('save', 'Save', 'Saving…'))
      setDisabled(save, busy())
    }
    if (els.server) paintModel(disabled)
    const tryButton = els.form.querySelector('.ms-try')
    if (tryButton) {
      setText(tryButton, label('try', 'Check', 'Checking…'))
      setDisabled(tryButton, busy())
      setHidden(tryButton.parentElement, Boolean(page.review))
    }
    const review = els.form.querySelector('.ms-review')
    setHidden(review, !page.review)
    if (page.review) {
      const refused = page.review.refused ?? ''
      setHidden(review.querySelector('.ms-review-title'), Boolean(refused))
      for (const [selector, lines] of [['.ms-steps', refused ? [] : summary()], ['.ms-exact-steps', refused ? [] : [...page.review.steps, ...page.review.notes]]]) {
        const list = review.querySelector(selector)
        if (list.dataset.key === JSON.stringify(lines)) continue
        list.dataset.key = JSON.stringify(lines)
        list.replaceChildren(...lines.map((line) => make('li', '', line)))
      }
      setHidden(review.querySelector('.ms-steps'), Boolean(refused))
      setHidden(review.querySelector('.ms-nothing'), Boolean(refused))
      setHidden(review.querySelector('.ms-exact'), Boolean(refused))
      const words = review.querySelector('.ms-refused')
      setText(words, refused)
      setHidden(words, !refused)
      const apply = review.querySelector('.ms-apply')
      setHidden(apply, Boolean(refused))
      setText(apply, label('apply', page.change ? 'Change server' : 'Turn on', page.change ? 'Changing…' : 'Turning on…'))
      setDisabled(apply, busy())
      setDisabled(review.querySelector('.ms-review-back'), busy())
    }
  }

  // the server list and the model list (or field) in place; options change only when their names do
  function paintModel(disabled) {
    const server = els.server
    const names = (servers?.list ?? []).map((row) => String(row.name))
    const options = [['', 'Choose a server'], ...names.map((name) => [name, name]), [ADD, 'Add a server…']]
      .filter(([value]) => value !== '' || !names.includes(page.values.server) || !page.values.server)
    const key = JSON.stringify(options)
    if (server.dataset.key !== key) {
      server.dataset.key = key
      server.replaceChildren(...options.map(([value, text]) => {
        const option = make('option', '', text)
        option.value = value
        return option
      }))
    }
    if (server.value !== page.values.server && names.includes(page.values.server)) server.value = page.values.server
    const model = page.model
    const list = els.form.querySelector('.ms-model-list')
    const typed = els.form.querySelector('.ms-model-text')
    const why = els.form.querySelector('.ms-model-why')
    const typing = model.state === 'typed'
    els.form.querySelector('.ms-model-label').htmlFor = typing ? typed.id : list.id
    setHidden(list, typing)
    setHidden(typed, !typing)
    setText(why, typing ? model.why : '')
    setHidden(why, !typing || !model.why)
    const choices = model.state === 'asking' ? [['', 'asking the server…']]
      : model.state === 'list' ? [...(model.models.length > 1 ? [['', 'Choose a model']] : []), ...model.models.map((name) => [name, name])]
        : [['', page.values.server ? '' : 'Choose a server first']]
    const listKey = JSON.stringify(choices)
    if (list.dataset.key !== listKey) {
      list.dataset.key = listKey
      list.replaceChildren(...choices.map(([value, text]) => {
        const option = make('option', '', text)
        option.value = value
        return option
      }))
    }
    if (model.state === 'list' && list.value !== page.values.model) list.value = page.values.model
    setDisabled(list, disabled || model.state !== 'list')
  }

  // Model: the chosen server's list, asked by check-server; a field to type it in when it cannot be asked.
  // `focus`: the person chose the server, so focus goes on to the model; else it stays where it is.
  function askModels(name, { focus }) {
    const mine = page
    const ask = async () => {
      if (page !== mine || page.values.server !== name) return
      page.model = { server: name, state: 'asking', models: [], why: '' }
      await act('models', async () => {
        const answer = await call('check-server', { name })
        notes.set(name, checkText(answer))
        if (page !== mine || page.values.server !== name) return
        const words = problem(answer)
        const models = words === null && answer.reachable === true ? strings(answer.models) : []
        if (models.length) {
          page.model = { server: name, state: 'list', models, why: '' }
          if (models.length === 1) page.values.model = models[0]
        } else {
          page.model = { server: name, state: 'typed', models: [], why: words ?? (answer.reachable === true ? 'The server lists no models.' : CHECKS[answer.failure] ?? CHECKS.unreachable) }
        }
      })
      const model = () => (page === mine && els ? els.form.querySelector(page.model.state === 'typed' ? '.ms-model-text' : '.ms-model-list') : null)
      if (focus) settleFocus(model)
      else settleFocus(() => (page === mine ? els?.server ?? null : null), { lost: true })
    }
    if (busy()) {
      page.model = { server: name, state: 'asking', models: [], why: '' }
      queued = ask
      changed()
      return
    }
    ask()
  }

  function agentValues() {
    if (MODEL_AGENTS.has(page.agent)) {
      if (!page.values.server) return 'Choose a model server.'
      if (!MODEL_NAME.test(page.values.model)) return page.model.state === 'list' ? 'Choose a model.' : 'Type the model’s name.'
      return ['enable-model-agent', { agent: page.agent, server: page.values.server, model: page.values.model }]
    }
    if (!httpAddress(page.values.endpoint.trim())) return 'Enter the service’s address, starting with http:// or https://.'
    if (!page.file) return 'Choose the token file.'
    return ['enable-request-post', { endpoint: page.values.endpoint.trim(), token: page.file.handle }]
  }

  async function tryAgent() {
    if (!page || busy()) return
    const values = agentValues()
    if (typeof values === 'string') {
      page.message = values
      changed()
      return
    }
    const mine = page
    page.message = ''
    await act('try', async () => {
      const answer = await call(values[0], { ...values[1], apply: false })
      if (page !== mine) return
      const words = problem(answer)
      if (words === '') return
      page.review = words === null ? { steps: strings(answer.steps), notes: strings(answer.notes) } : { refused: words }
    })
    if (page === mine) settleFocus(() => els?.form.querySelector(page.review?.refused !== undefined ? '.ms-review-back' : '.ms-apply'))
  }

  async function applyAgent() {
    if (!page?.review || busy()) return
    const values = agentValues()
    if (typeof values === 'string') return
    const mine = page
    let done = false
    await act('apply', async () => {
      const words = problem(await call(values[0], { ...values[1], apply: true }))
      if (page !== mine) return
      if (words === null) done = true
      else if (words) page.review = { refused: words }
    })
    if (!done) {
      settleFocus(() => els?.form.querySelector('.ms-review-back'))
      return
    }
    page = null
    els = null
    fresh = mine.agent
    if (mine.change) {
      changed()
      settleFocus(() => mine.opener?.() ?? deps.heading())
    } else deps.turnedOn(mine.agent)
    deps.reload()
    await listServers()
  }

  async function save() {
    if (!page || busy()) return
    const name = page.values.name.trim()
    const words = !SERVER_NAME.test(name) ? 'Use lower-case letters, digits and hyphens for the name.'
      : page.kind === 'add' && !httpAddress(page.values.baseUrl.trim()) ? 'Enter the address, starting with http:// or https://.'
        : page.kind === 'add' && page.values.key === 'file' && !page.file ? 'Choose the key file.' : ''
    if (words) {
      page.message = words
      changed()
      return
    }
    const mine = page
    const values = page.kind === 'add'
      ? ['add-server', { name, baseUrl: page.values.baseUrl.trim(), key: page.values.key === 'file' ? page.file.handle : 'none' }]
      : ['adopt-server', { name, from: page.agent }]
    page.message = ''
    let done = false
    await act('save', async () => {
      for (const apply of [false, true]) {
        const refused = problem(await call(values[0], { ...values[1], apply }))
        if (page !== mine) return
        if (refused === null) continue
        page.message = refused
        return
      }
      done = true
    })
    if (!done) {
      settleFocus(() => els?.form.querySelector('.ms-save'))
      return
    }
    // back where the page was opened from; a page that came from an agent's form chooses the new server there
    const before = mine.back
    if (before) {
      before.values.server = name
      before.values.model = ''
      before.review = null
    }
    back()
    // where back() put focus; a repaint that disables a focused control drops it to the body
    const parked = doc.activeElement
    deps.reload()
    await listServers()
    if (before && page === before) {
      askModels(name, { focus: false })
      return
    }
    // Focus goes to the new server's row once it is painted, else to Add a server; a person who
    // moved it meanwhile keeps it. It lands again after the check, which disables the row's button.
    const land = () => {
      const el = rowEls.get(name)?.querySelector('.ms-check') ?? serverSection?.querySelector('.ms-add')
      const active = doc.activeElement
      if (!el?.isConnected || active === el) return
      if (!active || active === doc.body || !active.isConnected || active === parked) el.focus({ preventScroll: true })
    }
    land()
    await checkRow(name, { focus: false })
    land()
  }

  // ── the foot of an agent's page ────────────────────────────────────────────

  let footEl = null
  function footElement() {
    if (footEl) return footEl
    footEl = make('div', 'ms-foot')
    const actions = make('div', 'ms-actions')
    actions.append(button('ms-change', 'Change server'), button('ms-off', 'Turn off'))
    const ask = make('div', 'ms-ask')
    ask.append(make('span', 'ms-ask-text'), button('ms-off-confirm', 'Turn off'), button('ms-off-cancel', 'Cancel'))
    footEl.append(actions, ask, make('p', 'ms-message'))
    footEl.addEventListener('click', (event) => {
      const control = event.target instanceof doc.defaultView.Element ? event.target.closest('button') : null
      if (!control || control.disabled || !foot.agent) return
      if (control.classList.contains('ms-change')) openAgent(foot.agent, { change: true, opener: () => footEl.querySelector('.ms-change') })
      else if (control.classList.contains('ms-off')) {
        foot.asking = true
        foot.message = ''
        changed()
        settleFocus(() => footEl.querySelector('.ms-off-cancel'))
      } else if (control.classList.contains('ms-off-cancel')) {
        foot.asking = false
        changed()
        settleFocus(() => footEl.querySelector('.ms-off'))
      } else if (control.classList.contains('ms-off-confirm')) turnOff(foot.agent)
    })
    return footEl
  }

  async function turnOff(agent) {
    let done = false
    await act('off', async () => {
      for (const apply of [false, true]) {
        const words = problem(await call('disable', { agent, apply }))
        if (words === null) continue
        foot.asking = false
        foot.message = words
        return
      }
      done = true
    })
    if (!done) {
      settleFocus(() => footEl?.querySelector('.ms-off'))
      return
    }
    foot.asking = false
    foot.message = ''
    deps.turnedOff()
    deps.reload()
    await listServers()
  }

  function paintFoot(agentPage, agent) {
    const el = footElement()
    const name = agent && OFFERS.has(agent.name) ? agent.name : null
    if (foot.agent !== name) {
      foot.agent = name
      foot.asking = false
      foot.message = ''
    }
    // only with the bridge, and only for a built-in agent that is on
    if (!usable() || !name) {
      el.remove()
      return
    }
    if (el.parentNode !== agentPage || agentPage.lastElementChild !== el) agentPage.append(el)
    const change = el.querySelector('.ms-change')
    setHidden(change, !MODEL_AGENTS.has(name))
    setDisabled(change, busy())
    const off = el.querySelector('.ms-off')
    setDisabled(off, busy())
    setHidden(el.querySelector('.ms-ask'), !foot.asking)
    setText(el.querySelector('.ms-ask-text'), `Turn off ${name}? Its settings and run records are kept.`)
    const confirm = el.querySelector('.ms-off-confirm')
    setText(confirm, label('off', 'Turn off', 'Turning off…'))
    setDisabled(confirm, busy())
    setDisabled(el.querySelector('.ms-off-cancel'), busy())
    const message = el.querySelector('.ms-message')
    setText(message, foot.message)
    setHidden(message, !foot.message)
  }

  return {
    /** Whether the page can set agents up here: the bridge is there, the page is this Mac's, and it is available. */
    usable,
    /** Asks the bridge whether it is available (at start, after Setup); nothing without a bridge. */
    refreshAvailable,
    /** The tab was entered, or Refresh pressed: availability and the servers are asked again. */
    async entered() {
      if (!(await refreshAvailable()) && usable()) await listServers()
    },
    /** Whether a set-up page is open in the tab (and the bridge still available to run it). */
    open: () => page !== null && usable(),
    /** The open set-up page's title for the top bar, or null. */
    title: () => (!page ? null : page.kind === 'add' ? 'Add a model server' : page.kind === 'adopt' ? 'Make it a server' : page.agent),
    /** Back from the open set-up page (← and Escape); false when none is open. */
    back,
    /**
     * Paints the home's Marketplace and Model servers after "Yours" (null body: neither shows),
     * the open set-up page, and the foot of the open agent's page (`agent`: the agent in the body).
     * @param {{body: any, agent: {name: string} | null}} input
     */
    paint({ body, agent }) {
      // its first appearance in the data: one check of that agent, as opening its page asks for
      if (fresh && Array.isArray(body?.agents) && body.agents.some((row) => String(row?.name) === fresh)) {
        const name = fresh
        fresh = null
        deps.check(name)
      }
      const home = deps.home()
      if (home) {
        // after "Yours", in this order: the Marketplace while a drawn built-in is off, the servers with the bridge
        const offers = body && Array.isArray(body.available) && body.available.some((offer) => OFFERS.has(offer?.name))
        const wanted = [...(offers ? [marketEl()] : []), ...(body && usable() ? [serversEl()] : [])]
        for (const section of [market, serverSection]) if (section && !wanted.includes(section)) section.remove()
        const tail = [...home.children].slice(-wanted.length)
        if (wanted.some((section, index) => tail[index] !== section)) home.append(...wanted)
        if (offers) paintMarket(market, body.available)
        if (body && usable()) paintServers(serverSection)
      }
      const root = deps.setupPage()
      if (root) {
        if (page && usable()) paintPage(root)
        else if (root.firstChild) {
          root.replaceChildren()
          els = null
        }
      }
      const agentPage = deps.agentPage()
      if (agentPage) paintFoot(agentPage, agent)
    },
    /** The window-local state, for frameInputs(). */
    state: () => version,
  }
}
