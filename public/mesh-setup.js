// Agent setup in the app, step 2b: the Agent cards tab's Marketplace and Model servers sections,
// the set-up pages that open in the tab in place of an agent's page (add a server, make an agent's
// own settings a server, set up an agent, add an agent by its card address), and the foot of an
// agent's page (Change server, Turn off; Remove for an added agent). Everything runs through the local window's mesh bridge (`agentInboxMesh`, step 2a), a dry
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
// the second kind of model server: Claude Code on this Mac, with no address and no key. The bridge
// names each row's kind (and a check's, when the command does); any other row is a server at an address.
const CLAUDE = 'claude-code'
const CLAUDE_FACTS = 'Claude Code on this Mac · sends text to Anthropic'
const CLAUDE_HINT = 'Uses the Claude Code you are signed in to. No key to enter.'
// a Claude Code server's models, in the page's own order whatever order its check answers
const CLAUDE_MODELS = ['haiku', 'sonnet', 'opus']
// Add a server's "What kind" choice, in its order; an address server is chosen when the page opens
const SERVER_KINDS = [[CLAUDE, 'Claude Code on this Mac'], ['http', 'A server at an address']]
// D6: the bridge's failure words; a cancel says nothing, every other reason names itself
const REASONS = {
  'not-installed': 'The mesh command is not installed on this Mac. Run Setup first.',
  outdated: 'The installed mesh command is older than this app. Run Setup again.',
  stale: 'The installed mesh command points at files that are gone. Run Setup again.',
  unsafe: 'The installed mesh command is not as Setup wrote it. Run Setup again.',
  unrecognized: 'The installed mesh command is not as Setup wrote it. Run Setup again.',
  handle: 'The chosen file is no longer held. Choose it again.',
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
// a Claude Code server's: the program, its sign-in (the command reports any failure of its sign-in
// question so, a program that cannot start under the app's short PATH included), and its own timeout
const CLAUDE_CHECKS = {
  'no-program': 'Claude Code was not found on this Mac.',
  'signed-out': 'Claude Code is not signed in, or could not start from the app. Run claude in a terminal and sign in.',
  timeout: 'Claude Code did not answer in time.',
}
// a key the app could not read, by where it comes from. The app runs the command with a short fixed
// environment, never the shell's: a variable is not there, and a command that needs one gives nothing.
const KEY_CHECKS = {
  command: 'The command gave no key. The app runs it without your terminal’s settings (docs/model-servers.md).',
  env: 'The app cannot see your terminal’s variables, so it cannot read this key (docs/model-servers.md).',
  file: 'The key file could not be read: it is missing, empty or not a private file of yours.',
}
// Add an agent by its card address (add step 2, D4). Card text is untrusted: it is shown only as
// text inside these quote marks, and nothing else is made from it.
const LOOPBACK = 'http://127.0.0.1:'
const ADDRESS_WORDS = 'Enter the card’s address, starting with https:// (or http://127.0.0.1: for an agent on this Mac).'
const INVALID_ADDRESS = 'This address cannot be added here. Use https:// on a name, or http://127.0.0.1 with a port, with no query or fragment.'
const TOKEN_HINT = 'An agent on this Mac needs its token file.'
const FOR_TERMINAL = 'That option is for a terminal. Add this agent there instead.'
const CARD_NOTE = 'Text in quotes comes from the card and is unverified.'
const NOT_GIVEN = 'Not given'
const REACH_WORDS = {
  loopback: 'On this Mac. What you send it stays on this Mac.',
  tailnet: 'On your tailnet. What you send it stays on your own machines.',
  public: 'On the internet. What you send it leaves this Mac.',
}
const quoted = (text) => `“${text}”`
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

/**
 * A check that ran and found the server unusable. The bridge answers it `ok: false` with the
 * `failure` and no `reason`: it is the check's result, not a step that did not work.
 */
const failedCheck = (answer) => Boolean(answer) && typeof answer === 'object' && answer.ok !== true && typeof answer.reason !== 'string'
  && !answer.refused && typeof answer.failure === 'string' && (Object.hasOwn(CHECKS, answer.failure) || Object.hasOwn(CLAUDE_CHECKS, answer.failure))

/** Whether a check is of a Claude Code server: by the kind its answer names, else by the page's row for it. */
function claudeCheck(answer, server) {
  const named = answer && typeof answer === 'object' ? answer.kind : undefined
  return named === CLAUDE || (named !== 'http' && server?.kind === CLAUDE)
}

/**
 * A check's result in words. `server`: the page's row for it, for its kind when the answer names
 * none and for where its key comes from when the key could not be read.
 */
function checkText(answer, server) {
  const claude = claudeCheck(answer, server)
  if (!failedCheck(answer)) {
    const words = problem(answer)
    if (words !== null) return words
    if (answer.reachable === true) return `${claude ? 'ready · signed in' : 'reachable'} · ${plural(strings(answer.models).length, 'model')}`
  }
  const failure = answer.failure
  if (claude && Object.hasOwn(CLAUDE_CHECKS, failure)) return CLAUDE_CHECKS[failure]
  const keyKind = server?.key
  if (failure === 'key' && typeof keyKind === 'string' && Object.hasOwn(KEY_CHECKS, keyKind)) return KEY_CHECKS[keyKind]
  if (Object.hasOwn(CHECKS, failure)) return CHECKS[failure]
  return Object.hasOwn(CLAUDE_CHECKS, failure) ? CLAUDE_CHECKS[failure] : CHECKS.unreachable
}

function httpAddress(text) {
  try {
    const url = new URL(text)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

// What a check's card says it is, in the page's own words: [label, text] rows, card text quoted
function cardFacts(card) {
  const text = (value) => (typeof value === 'string' && value ? quoted(value) : NOT_GIVEN)
  const skills = (Array.isArray(card.skills) ? card.skills : []).map((skill) => quoted(typeof skill?.name === 'string' ? skill.name : String(skill?.id ?? '')))
  const signed = card.signed !== true ? 'Not signed. Allowed only for an agent on this Mac or your tailnet.'
    : card.keysNew === true ? 'Signed by its publisher. Trusted from now on if you add it.'
      : card.keysNew === false ? 'Signed by its publisher, with a key this Mac already trusts.' : 'Signed by its publisher.'
  return [
    ['What it does', text(card.description)],
    ['Publisher', text(card.publisher)],
    ['Where it runs', REACH_WORDS[card.reach] ?? ''],
    ['Card', signed],
    ['Skills', skills.length ? skills.join(', ') : 'None listed'],
    ['Name here', String(card.id)],
  ]
}

/**
 * @param {{doc?: Document, bridge: () => any, local: () => Promise<boolean>,
 *   home: () => HTMLElement | null, setupPage: () => HTMLElement | null, agentPage: () => HTMLElement | null,
 *   panel: () => HTMLElement | null, heading: () => HTMLElement | null, active: () => boolean,
 *   changed: () => void, reload: () => void, turnedOn: (name: string) => void, turnedOff: () => void,
 *   added: (id: string) => void, check: (name: string) => void, toTop: () => void}} deps
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
  const foot = { agent: null, added: false, asking: false, message: '' }
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

  // Focus once an operation's last repaint is done: onto `want` when focus went nowhere (Chrome drops
  // it to the body from a control a repaint disabled, such as the foot's while the servers are read)
  // or still sits where it was `parked`; a person who moved it meanwhile keeps it.
  function landAfter(want, parked) {
    const el = typeof want === 'function' ? want() : want
    const active = doc.activeElement
    if (!el?.isConnected || active === el) return
    if (!active || active === doc.body || !active.isConnected || active === parked) el.focus({ preventScroll: true })
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
    const add = button('ms-add-agent', 'Add by address')
    add.addEventListener('click', () => openAddress({ opener: () => market?.querySelector('.ms-add-agent') ?? null }))
    head.append(title, make('span', 'ah-spacer'), add)
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
    const add = section.querySelector('.ms-add-agent')
    setHidden(add, !usable())
    setDisabled(add, busy())
    const grid = section.querySelector('.ma-grid')
    setHidden(grid, !offers.length)
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
        // a "still use this server" line is out of date once the list says no agent uses the server
        if (!agents.length && usedNotes.has(name)) {
          if (notes.get(name) === usedNotes.get(name)) notes.delete(name)
          usedNotes.delete(name)
        }
        const used = agents.length ? `used by ${agents.join(', ')}` : ''
        const facts = server.kind === CLAUDE ? [CLAUDE_FACTS, used] : [typeof server.baseUrl === 'string' ? server.baseUrl : '', KEYS[server.key] ?? '', used]
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

  // a server's row in the list the page last read: its kind, and where its key comes from
  const serverOf = (name) => (servers?.list ?? []).find((server) => server.name === name)

  async function checkRow(name, { focus = true } = {}) {
    await act(`check:${name}`, async () => {
      notes.set(name, checkText(await call('check-server', { name }), serverOf(name)))
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
      // Add an agent: what its Check checked, which its Add adds exactly
      checked: null,
      // `kind`: Add a server's "What kind" choice, not the page's own kind
      values: { name: '', kind: 'http', baseUrl: '', key: 'none', server: '', model: '', endpoint: '', address: '' },
      model: { server: '', state: 'idle', models: [], why: '' },
      ...extra,
    }
  }

  function openAdd({ opener = null, back = null } = {}) {
    if (busy()) return
    page = blank('add', { opener, back })
    show()
  }

  // Add an agent by its card address (D4)
  function openAddress({ opener = null } = {}) {
    if (busy() || !usable()) return
    page = blank('address', { opener })
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

  // While an operation runs the page stays (its back control is disabled), so the operation's result
  // lands on the page that started it; true even then, so Escape is still the page's and goes no further.
  function back() {
    if (!page) return false
    if (busy()) return true
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

  // A fieldset of radios, its choice kept in the page's values: a repaint never rebuilds it
  function radios(legend, name, key, options) {
    const choice = make('fieldset', 'ms-choice')
    choice.append(make('legend', 'ms-label', legend))
    for (const [value, text] of options) {
      const option = make('label', 'ms-radio')
      const radio = make('input')
      radio.type = 'radio'
      radio.name = name
      radio.value = value
      radio.checked = page.values[key] === value
      radio.addEventListener('change', () => {
        if (!page || !radio.checked) return
        page.values[key] = value
        // a message about the other kind's fields is out of date once they hide
        if (key === 'kind') page.message = ''
        changed()
      })
      option.append(radio, doc.createTextNode(` ${text}`))
      choice.append(option)
    }
    return choice
  }

  const pageTitle = () => (page.kind === 'add' ? 'Add a model server' : page.kind === 'adopt' ? 'Make it a server' : page.kind === 'address' ? 'Add an agent' : page.agent)

  function build(root) {
    const title = pageTitle()
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
    const refs = { root, form, first: null, server: null, address: null, key: null, claudeHint: null, cardAddress: null, token: null }
    const fields = make('div', 'ms-fields')
    const actions = make('div', 'ms-actions')
    if (page.kind === 'add' || page.kind === 'adopt') {
      if (page.kind === 'adopt') fields.append(make('p', 'ms-hint', `Saves ${page.agent}’s own address and key as a server.`))
      if (page.kind === 'add') fields.append(radios('What kind', 'msKind', 'kind', SERVER_KINDS))
      const name = input('name', page.values.name)
      fields.append(field('Name', name, 'Lower-case letters, digits and hyphens.'))
      refs.first = name
      if (page.kind === 'add') {
        // Claude Code needs only the name: the address and the key hide (and are not checked) while it is chosen
        refs.claudeHint = make('p', 'ms-hint', CLAUDE_HINT)
        refs.claudeHint.id = 'meshClaudeHint'
        refs.address = field('Address', input('baseUrl', page.values.baseUrl))
        refs.key = radios('Key', 'msKey', 'key', [['none', 'No key'], ['file', 'Key file']])
        refs.key.append(chooser('key'))
        fields.append(refs.claudeHint, refs.address, refs.key)
      }
      actions.append(button('ms-save ms-primary', 'Save'))
      actions.firstChild.addEventListener('click', () => save())
    } else if (page.kind === 'address') {
      const address = input('address', page.values.address)
      // the token field shows or hides as the address is typed: a repaint, never a rebuild
      address.addEventListener('input', () => changed())
      fields.append(field('Card address', address))
      refs.token = make('div', 'ms-field ms-token')
      refs.token.append(make('span', 'ms-label', 'Token file'), chooser('token'), make('span', 'ms-hint', TOKEN_HINT))
      fields.append(refs.token)
      refs.first = address
      refs.cardAddress = address
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
    const adding = page.kind === 'address'
    if (page.kind === 'agent' || adding) {
      actions.append(button('ms-try ms-primary', 'Check'))
      actions.firstChild.addEventListener('click', () => (adding ? checkAddress() : tryAgent()))
    }
    const review = make('div', 'ms-review')
    const reviewActions = make('div', 'ms-actions')
    const apply = button('ms-apply ms-primary', adding ? 'Add' : page.change ? 'Change server' : 'Turn on')
    const reviewBack = button('ms-review-back', 'Back')
    reviewActions.append(apply, reviewBack)
    // the page's own short summary, a quiet line, the buttons, and the command's own lines closed under them
    const exact = make('details', 'ms-exact')
    exact.append(make('summary', '', 'Exact steps'), make('ul', 'ms-exact-steps'))
    // Add an agent's summary is what the checked card says it is, in place of a list of what turning it on does
    const head = adding ? [cardBox()] : [make('h3', 'ms-review-title', page.change ? 'Changing the server will' : 'Turning it on will'), make('ul', 'ms-steps')]
    const forTerminal = adding ? [make('p', 'ms-hint ms-for-terminal', FOR_TERMINAL)] : []
    review.append(...head, make('p', 'ms-refused'), ...forTerminal, make('p', 'ms-hint ms-nothing', 'Nothing has changed yet.'), reviewActions, exact)
    apply.addEventListener('click', () => (adding ? addChecked() : applyAgent()))
    reviewBack.addEventListener('click', () => {
      if (!page || busy()) return
      page.review = null
      page.checked = null
      changed()
      settleFocus(() => els?.root.querySelector('.ms-try'))
    })
    const message = make('p', 'ms-message')
    message.setAttribute('role', 'status')
    form.append(fields, message, actions, review)
    root.replaceChildren(backButton, form)
    return refs
  }

  // The checked card's summary box: its title, its labelled rows and the quiet line, filled by paintCard
  const cardKeys = new WeakMap()
  function cardBox() {
    const box = make('div', 'ms-card')
    box.append(make('p', 'ms-card-title'), make('dl', 'ms-facts'), make('p', 'ms-hint ms-card-note', CARD_NOTE))
    return box
  }

  function paintCard(box, card) {
    setHidden(box, !card)
    if (!card) return
    setText(box.querySelector('.ms-card-title'), typeof card.name === 'string' && card.name ? quoted(card.name) : 'No name given')
    const rows = cardFacts(card)
    const list = box.querySelector('.ms-facts')
    // the rows' last key is kept here, never in an attribute: no attribute is made from card text
    const key = JSON.stringify(rows)
    if (cardKeys.get(list) === key) return
    cardKeys.set(list, key)
    list.replaceChildren(...rows.flatMap(([term, text]) => [make('dt', '', term), make('dd', '', text)]))
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
    setDisabled(root.querySelector('.map-back'), busy())
    for (const el of els.form.querySelectorAll('input, select')) if (!el.classList.contains('ms-model-list')) setDisabled(el, disabled)
    const message = els.form.querySelector('.ms-message')
    setText(message, page.message)
    setHidden(message, !page.message)
    // the token file is asked only for an agent on this Mac; a file chosen before is kept, unsent, while it hides
    if (els.token) setHidden(els.token, !page.values.address.trim().startsWith(LOOPBACK))
    if (els.address) {
      const claude = page.values.kind === CLAUDE
      setHidden(els.claudeHint, !claude)
      setHidden(els.address, claude)
      setHidden(els.key, claude)
      // the quiet line describes the Name field while it shows
      if (claude && els.first.getAttribute('aria-describedby') !== els.claudeHint.id) els.first.setAttribute('aria-describedby', els.claudeHint.id)
      else if (!claude && els.first.hasAttribute('aria-describedby')) els.first.removeAttribute('aria-describedby')
    }
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
      const adding = page.kind === 'address'
      if (adding) {
        paintCard(review.querySelector('.ms-card'), refused ? null : page.review.card)
        // a refusal that names an option the page does not have (`--id`, `--move`) is a terminal's
        setHidden(review.querySelector('.ms-for-terminal'), !refused.includes('--'))
      } else setHidden(review.querySelector('.ms-review-title'), Boolean(refused))
      for (const [selector, lines] of [['.ms-steps', refused || adding ? [] : summary()], ['.ms-exact-steps', refused ? [] : [...page.review.steps, ...page.review.notes]]]) {
        const list = review.querySelector(selector)
        if (!list || list.dataset.key === JSON.stringify(lines)) continue
        list.dataset.key = JSON.stringify(lines)
        list.replaceChildren(...lines.map((line) => make('li', '', line)))
      }
      if (!adding) setHidden(review.querySelector('.ms-steps'), Boolean(refused))
      setHidden(review.querySelector('.ms-nothing'), Boolean(refused))
      setHidden(review.querySelector('.ms-exact'), Boolean(refused))
      const words = review.querySelector('.ms-refused')
      setText(words, refused)
      setHidden(words, !refused)
      const apply = review.querySelector('.ms-apply')
      setHidden(apply, Boolean(refused))
      setText(apply, adding ? label('apply', 'Add', 'Adding…') : label('apply', page.change ? 'Change server' : 'Turn on', page.change ? 'Changing…' : 'Turning on…'))
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
    // the field shows the model the page holds: a server change resets it, and a person typing keeps theirs
    if (typed.value !== page.values.model && doc.activeElement !== typed) typed.value = page.values.model
    // why the server could not be asked: beside the typed field, or under a Claude Code server's fixed list
    setText(why, model.why)
    setHidden(why, !model.why)
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
  // A Claude Code server's list is the page's own three, also when its check fails, with the check's
  // words under it. `focus`: the person chose the server, so focus goes on to the model; else it stays.
  function askModels(name, { focus }) {
    const mine = page
    const ask = async () => {
      if (page !== mine || page.values.server !== name) return
      page.model = { server: name, state: 'asking', models: [], why: '' }
      await act('models', async () => {
        const answer = await call('check-server', { name })
        const said = checkText(answer, serverOf(name))
        notes.set(name, said)
        if (page !== mine || page.values.server !== name) return
        const reached = !failedCheck(answer) && problem(answer) === null && answer.reachable === true
        if (claudeCheck(answer, serverOf(name))) {
          page.model = { server: name, state: 'list', models: CLAUDE_MODELS, why: reached ? '' : said }
          return
        }
        const models = reached ? strings(answer.models) : []
        if (models.length) {
          page.model = { server: name, state: 'list', models, why: '' }
          if (models.length === 1) page.values.model = models[0]
        } else {
          page.model = { server: name, state: 'typed', models: [], why: reached ? 'The server lists no models.' : said }
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
    // back on the agent's page: Change server's own control, or the new agent page's back control
    const want = () => (mine.change ? mine.opener?.() ?? deps.heading() : deps.agentPage()?.querySelector('.map-back') ?? deps.heading())
    if (mine.change) {
      changed()
      settleFocus(want)
    } else deps.turnedOn(mine.agent)
    const parked = doc.activeElement
    deps.reload()
    // reading the servers disables the foot's controls, which drops focus from Change server
    await listServers()
    landAfter(want, parked)
  }

  // Check: add's dry run for the address, which fetches the card once and writes nothing (D4)
  async function checkAddress() {
    if (!page || busy()) return
    const address = page.values.address.trim()
    const loopback = address.startsWith(LOOPBACK)
    const before = !address.startsWith('https://') && !loopback ? ADDRESS_WORDS : loopback && !page.file ? 'Choose the token file.' : ''
    if (before) {
      page.message = before
      changed()
      if (before === ADDRESS_WORDS) settleFocus(() => els?.cardAddress ?? null)
      return
    }
    const values = loopback ? { address, token: page.file.handle } : { address }
    const mine = page
    page.message = ''
    let invalid = false
    await act('try', async () => {
      const answer = await call('check-agent', values)
      if (page !== mine) return
      // the bridge would not take the address: it is about what the person typed, so it goes under the field
      if (answer?.ok === false && answer.reason === 'invalid') {
        page.message = INVALID_ADDRESS
        invalid = true
        return
      }
      const words = problem(answer)
      if (words === '') return
      const card = answer?.card
      if (words !== null || !card || typeof card.id !== 'string') {
        page.review = { refused: words ?? reasonText('output') }
        return
      }
      const steps = strings(answer.steps)
      const notes = strings(answer.notes)
      // already added: at this very address (nothing to do), or elsewhere (a signed move, a terminal's job)
      if (!steps.length) page.review = { refused: `This agent is already added as ${card.id}.` }
      else if (notes.length) page.review = { refused: `This agent is already added as ${card.id}. Moving it to a new address is done in a terminal.` }
      else {
        page.review = { card, steps, notes }
        page.checked = { address, token: values.token, id: card.id, pin: card.pin }
      }
    })
    if (page !== mine) return
    if (invalid) settleFocus(() => els?.cardAddress ?? null)
    else settleFocus(() => els?.form.querySelector(page.review?.refused !== undefined ? '.ms-review-back' : '.ms-apply'))
  }

  // Add: exactly the checked card, once; the command refuses a card whose pin changed since the check
  async function addChecked() {
    if (!page?.review?.card || !page.checked || busy()) return
    const { address, token, id, pin } = page.checked
    const mine = page
    let done = false
    await act('apply', async () => {
      const words = problem(await call('add-agent', { address, ...(token === undefined ? {} : { token }), id, pin, apply: true }))
      if (page !== mine) return
      if (words === null) done = true
      else if (words) page.review = { refused: words }
    })
    if (!done) {
      if (page === mine) settleFocus(() => els?.form.querySelector('.ms-review-back'))
      return
    }
    page = null
    els = null
    // the app never checks an added agent: its page says it was added until the tab's next read names it
    deps.added(id)
    deps.reload()
  }

  async function save() {
    if (!page || busy()) return
    const name = page.values.name.trim()
    const address = page.kind === 'add' && page.values.kind !== CLAUDE
    const words = !SERVER_NAME.test(name) ? 'Use lower-case letters, digits and hyphens for the name.'
      : address && !httpAddress(page.values.baseUrl.trim()) ? 'Enter the address, starting with http:// or https://.'
        : address && page.values.key === 'file' && !page.file ? 'Choose the key file.' : ''
    if (words) {
      page.message = words
      changed()
      return
    }
    const mine = page
    const values = address ? ['add-server', { name, baseUrl: page.values.baseUrl.trim(), key: page.values.key === 'file' ? page.file.handle : 'none' }]
      : page.kind === 'add' ? ['add-claude-server', { name }]
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
    const land = () => landAfter(() => rowEls.get(name)?.querySelector('.ms-check') ?? serverSection?.querySelector('.ms-add'), parked)
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
    actions.append(button('ms-change', 'Change server'), button('ms-off', 'Turn off'), button('ms-remove-agent', 'Remove'))
    const ask = make('div', 'ms-ask')
    ask.append(make('span', 'ms-ask-text'), button('ms-off-confirm', 'Turn off'), button('ms-off-cancel', 'Cancel'))
    footEl.append(actions, ask, make('p', 'ms-message'))
    footEl.addEventListener('click', (event) => {
      const control = event.target instanceof doc.defaultView.Element ? event.target.closest('button') : null
      if (!control || control.disabled || !foot.agent) return
      // the question's own Cancel goes back to the button that asked it: Turn off, or an added agent's Remove
      const asker = foot.added ? '.ms-remove-agent' : '.ms-off'
      if (control.classList.contains('ms-change')) openAgent(foot.agent, { change: true, opener: () => footEl.querySelector('.ms-change') })
      else if (control.classList.contains('ms-off') || control.classList.contains('ms-remove-agent')) {
        foot.asking = true
        foot.message = ''
        changed()
        settleFocus(() => footEl.querySelector('.ms-off-cancel'))
      } else if (control.classList.contains('ms-off-cancel')) {
        foot.asking = false
        changed()
        settleFocus(() => footEl.querySelector(asker))
      } else if (control.classList.contains('ms-off-confirm')) {
        if (foot.added) removeAgent(foot.agent)
        else turnOff(foot.agent)
      }
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

  // An added agent's Remove (D5): remove's dry run, then the real one; an id no longer there counts as removed
  async function removeAgent(id) {
    let done = false
    await act('remove-agent', async () => {
      for (const apply of [false, true]) {
        const words = problem(await call('remove-agent', { id, apply }))
        if (words === null) continue
        foot.asking = false
        foot.message = words
        return
      }
      done = true
    })
    if (!done) {
      settleFocus(() => footEl?.querySelector('.ms-remove-agent'))
      return
    }
    foot.asking = false
    foot.message = ''
    deps.turnedOff()
    deps.reload()
  }

  function paintFoot(agentPage, agent) {
    const el = footElement()
    const added = agent?.added === true
    const name = agent && (added || OFFERS.has(agent.name)) ? agent.name : null
    if (foot.agent !== name || foot.added !== added) {
      foot.agent = name
      foot.added = added
      foot.asking = false
      foot.message = ''
    }
    // only with the bridge, and only for a built-in agent that is on or an agent added by its address
    if (!usable() || !name) {
      el.remove()
      return
    }
    if (el.parentNode !== agentPage || agentPage.lastElementChild !== el) agentPage.append(el)
    const change = el.querySelector('.ms-change')
    setHidden(change, added || !MODEL_AGENTS.has(name))
    // while the question is open its own buttons answer it: the foot's buttons stay where they are, disabled
    setDisabled(change, busy() || foot.asking)
    const off = el.querySelector('.ms-off')
    setHidden(off, added)
    setDisabled(off, busy() || foot.asking)
    const remove = el.querySelector('.ms-remove-agent')
    setHidden(remove, !added)
    setDisabled(remove, busy() || foot.asking)
    setHidden(el.querySelector('.ms-ask'), !foot.asking)
    setText(el.querySelector('.ms-ask-text'), added ? `Remove ${name}? Its run records go too.` : `Turn off ${name}? Its settings and run records are kept.`)
    const confirm = el.querySelector('.ms-off-confirm')
    setText(confirm, added ? label('remove-agent', 'Remove', 'Removing…') : label('off', 'Turn off', 'Turning off…'))
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
    title: () => (page ? pageTitle() : null),
    /** Back from the open set-up page (← and Escape); false when none is open; nothing while an operation runs. */
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
        // after "Yours", in this order: the Marketplace while a drawn built-in is off or (with the bridge)
        // for Add by address, then the servers with the bridge
        const offers = body && Array.isArray(body.available) && body.available.some((offer) => OFFERS.has(offer?.name))
        const marketWanted = offers || (body && usable())
        const wanted = [...(marketWanted ? [marketEl()] : []), ...(body && usable() ? [serversEl()] : [])]
        for (const section of [market, serverSection]) if (section && !wanted.includes(section)) section.remove()
        const tail = [...home.children].slice(-wanted.length)
        if (wanted.some((section, index) => tail[index] !== section)) home.append(...wanted)
        if (marketWanted) paintMarket(market, body.available)
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
