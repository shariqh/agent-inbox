// @vitest-environment jsdom
// Agent setup in the app, step 2b: the Agent cards tab's set-up screens through the real viewer and
// app.js, with the local window's mesh bridge faked (test/dom/agent-setup-fake.ts). The tab shows
// with no agent on when the bridge is available on this Mac's own page (D1); its home has Yours,
// Marketplace and Model servers (D2); a server is added, adopted, checked and removed (D3); an agent
// is set up, changed and turned off with a dry run first (D4, D5); the bridge's failures have words
// (D6); and the house rules hold (D7): text only, state in the module, a repaint loses nothing, one
// press per operation, focus where the person expects it. Click-driven only: Escape is in
// test/dom/agent-setup-keys.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type Database from 'better-sqlite3'
import { bootApp, buttonLabelled, click, freshDb, pollTick, settle, type, useDomTest } from './harness.js'
import { agent, fakeMesh } from './agent-cards-fake.js'
import meshProcess from '../../electron/mesh-process.cjs'
import { heldIdRefusal } from '../../src/meshctl.js'
import { ALL_OFFERED, CARD, CHECK_STEPS, HANDLE, LOCAL_CARD, OFFERED, PIN, blurWhenDisabled, carded, checked, checkedClaude, claudeServer, fakeBridge, olderServer, planned, server } from './agent-setup-fake.js'

useDomTest()
let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
  Reflect.deleteProperty(window, 'agentInboxMesh')
  Reflect.deleteProperty(window, 'agentInboxDesk')
})

type Json = Record<string, unknown>
const BLURB: Record<string, string> = Object.fromEntries(ALL_OFFERED.map((offer) => [offer['name'], offer['blurb']])) as Record<string, string>
const on = (name: string, over: Json = {}) => agent(name, { blurb: BLURB[name], ...over })

async function boot({ agents = [] as Json[], available = ALL_OFFERED as Json[], bridge = {} as Parameters<typeof fakeBridge>[0] | null, hub = false } = {}) {
  db = freshDb()
  const mesh = fakeMesh(agents)
  if (!agents.length) mesh.s.version = undefined
  mesh.s.body = agents.length ? { on: true, agents, others: 0, available } : { on: false, agents: [], available }
  if (hub) {
    Object.defineProperty(window, 'agentInboxDesk', {
      configurable: true,
      value: { available: async () => ({ open: false }), connection: async () => ({ mode: 'hub', label: 'studio', state: 'online', version: '2.22.0' }), onConnection: () => () => {} },
    })
  }
  const fake = bridge === null ? null : fakeBridge(bridge)
  await bootApp(db, { viewer: { mesh: mesh.mesh } })
  await settle()
  return { mesh, bridge: fake! }
}
const tab = () => document.querySelector<HTMLElement>('.tab[data-tab="cards"]')!
async function enter() {
  click(tab())
  await settle()
  await pollTick()
}
const home = () => document.getElementById('agentCardsHome')!
const setup = () => document.getElementById('agentSetup')!
const agentPage = () => document.getElementById('agentPage')!
const title = () => document.getElementById('pageTitle')!
const shown = (el: Element | null | undefined) => Boolean(el) && !(el as HTMLElement).hidden && !(el as HTMLElement).closest('[hidden]')
const offer = (name: string) => document.querySelector<HTMLElement>(`.ms-market li[data-offer="${name}"]`)
const row = (name: string) => document.querySelector<HTMLElement>(`.ms-servers li[data-server="${name}"]`)
const inlineRow = (name: string) => document.querySelector<HTMLElement>(`.ms-servers li[data-inline="${name}"]`)
const field = (name: string) => setup().querySelector<HTMLInputElement>(`input[name="${name}"]`)
const select = (name: string) => setup().querySelector<HTMLSelectElement>(`select[name="${name}"]`)!
const message = () => setup().querySelector<HTMLElement>('.ms-message')!
function choose(el: HTMLSelectElement, value: string) {
  el.value = value
  el.dispatchEvent(new window.Event('change', { bubbles: true }))
}
const card = (name: string) => [...document.querySelectorAll<HTMLElement>('#cards .ma-grid .ma-card')].find((el) => el.querySelector('.ma-name')?.textContent === name)!

describe('when the tab shows (D1)', () => {
  it('shows with no agent on when the bridge is available on this Mac’s own page, never with a count', async () => {
    await boot()
    expect(tab().hidden).toBe(false)
    expect(tab().querySelector('.tab-count')?.textContent ?? '').toBe('')
    await enter()
    expect(document.getElementById('agentCardsOff')!.hidden).toBe(true)
    expect(home().querySelector('.ma-empty')?.textContent).toBe('No agent is on yet.')
    expect(shown(home().querySelector('.ma-empty'))).toBe(true)
  })

  it('stays hidden with no agent on in a browser', async () => {
    await boot({ bridge: null })
    expect(tab().hidden).toBe(true)
  })

  it('stays hidden with no agent on in another Mac’s page, which never asks the bridge anything', async () => {
    const { bridge } = await boot({ hub: true })
    expect(tab().hidden).toBe(true)
    expect(bridge.s.calls).toEqual([])
  })

  it('stays hidden with no agent on while the bridge is not available', async () => {
    const { bridge } = await boot({ bridge: { available: { available: false, reason: 'not-installed' } } })
    expect(tab().hidden).toBe(true)
    expect(bridge.s.calls).toEqual([])
  })
})

describe('the tab’s home (D2)', () => {
  it('with the bridge and no agent: Yours says so, the Marketplace offers the three, the servers list each row', async () => {
    const { bridge } = await boot({ bridge: { servers: [server('local', { key: 'file', agents: ['unslop'] }), server('lab', { key: 'command' })], inline: ['unslop-code'] } })
    await enter()
    const titles = [...home().querySelectorAll('h2')].map((h) => h.textContent)
    expect(titles).toEqual(['Yours', 'Marketplace', 'Model servers'])
    // Marketplace: name, what it does, what it needs; Set up, except unslop's terminal line
    for (const name of ['unslop-code', 'request-post']) {
      const el = offer(name)!
      expect(el.querySelector('.ma-name')?.textContent).toBe(name)
      expect(el.querySelector('.ma-description')?.textContent).toBe(BLURB[name])
      expect(shown(buttonLabelled('Set up', el))).toBe(true)
      expect(shown(el.querySelector('.ms-terminal'))).toBe(false)
    }
    expect(offer('unslop-code')!.querySelector('.ms-needs')?.textContent).toBe('Needs a model server')
    expect(offer('request-post')!.querySelector('.ms-needs')?.textContent).toBe('Needs an address and a token')
    expect(shown(buttonLabelled('Set up', offer('unslop')!))).toBe(false)
    expect(offer('unslop')!.querySelector('.ms-terminal')?.textContent).toBe('Set up in a terminal for now (docs/unslop.md).')
    expect(shown(offer('unslop')!.querySelector('.ms-terminal'))).toBe(true)
    expect(shown(document.querySelector('.ms-market .ms-line'))).toBe(false)
    // Model servers: name, address, key, users, Check and Remove; the inline agent; Add a server
    expect(row('lab')!.querySelector('.ms-row-facts')?.textContent).toBe('http://127.0.0.1:8080/lab · key from a command')
    expect(row('local')!.querySelector('.ms-row-facts')?.textContent).toBe('http://127.0.0.1:8080/local · key file · used by unslop')
    expect(shown(buttonLabelled('Check', row('local')!))).toBe(true)
    expect(shown(buttonLabelled('Remove', row('local')!))).toBe(true)
    expect(inlineRow('unslop-code')!.textContent).toContain('unslop-code has its own settings')
    expect(shown(buttonLabelled('Make it a server', inlineRow('unslop-code')!))).toBe(true)
    expect(shown(buttonLabelled('Add a server', home()))).toBe(true)
    // asked once, on entering; never by a poll
    expect(bridge.s.calls.map(([op]) => op)).toEqual(['servers'])
    await pollTick()
    await pollTick()
    expect(bridge.s.calls.map(([op]) => op)).toEqual(['servers'])
  })

  it('no server and no inline agent: one quiet line and Add a server; Refresh asks the servers again', async () => {
    const { bridge } = await boot()
    await enter()
    expect(document.querySelector('.ms-servers .ms-line')?.textContent).toBe('No model server yet.')
    expect(shown(document.querySelector('.ms-rows'))).toBe(false)
    bridge.s.servers = [server('local')]
    click(document.querySelector('#cards .ma-refresh'))
    await settle()
    expect(shown(row('local'))).toBe(true)
    expect(shown(document.querySelector('.ms-servers .ms-line'))).toBe(false)
    expect(bridge.s.calls.map(([op]) => op)).toEqual(['servers', 'servers'])
  })

  it('without the bridge an agent that is on still shows the Marketplace, without buttons, and no servers', async () => {
    await boot({ agents: [on('unslop')], available: [OFFERED['unslop-code']!, OFFERED['request-post']!], bridge: null })
    await enter()
    expect([...home().querySelectorAll('h2')].map((h) => h.textContent)).toEqual(['Yours', 'Marketplace'])
    expect(document.querySelector('.ms-market .ms-line')?.textContent).toBe('Set these up in the app on the Mac that runs your agents.')
    expect([...document.querySelectorAll('.ms-market li')].map((li) => (li as HTMLElement).dataset['offer'])).toEqual(['unslop-code', 'request-post'])
    expect([...document.querySelectorAll('.ms-market .ms-setup')].some((el) => shown(el))).toBe(false)
    expect(shown(document.querySelector('.ms-add-agent'))).toBe(false)
    expect(document.querySelector('.ms-servers')).toBeNull()
    expect(document.querySelector('.ms-foot')).toBeNull()
  })

  it('another Mac’s page shows the same line, and nothing that sets up', async () => {
    await boot({ agents: [on('unslop')], available: [OFFERED['request-post']!], hub: true })
    await enter()
    expect(document.querySelector('.ms-market .ms-line')?.textContent).toBe('Set these up in the app on the Mac that runs your agents.')
    expect(shown(buttonLabelled('Set up', offer('request-post')!))).toBe(false)
    expect(document.querySelector('.ms-servers')).toBeNull()
  })

  it('with every built-in on the Marketplace stays for Add by address, with no grid and no line; Yours is the grid as before', async () => {
    await boot({ agents: [on('unslop'), on('unslop-code'), on('request-post', { where: 'tailnet' })], available: [] })
    await enter()
    expect([...home().querySelectorAll('h2')].map((h) => h.textContent)).toEqual(['Yours', 'Marketplace', 'Model servers'])
    expect(shown(buttonLabelled('Add by address', document.querySelector('.ms-market .ma-head')!))).toBe(true)
    expect(shown(document.querySelector('.ms-market .ma-grid'))).toBe(false)
    expect(shown(document.querySelector('.ms-market .ms-line'))).toBe(false)
    expect(shown(home().querySelector('.ma-empty'))).toBe(false)
    expect(home().querySelector('.ma-count')?.textContent).toBe('3')
  })

  it('without the bridge and with every built-in on there is no Marketplace, as before', async () => {
    await boot({ agents: [on('unslop'), on('unslop-code'), on('request-post', { where: 'tailnet' })], available: [], bridge: null })
    await enter()
    expect([...home().querySelectorAll('h2')].map((h) => h.textContent)).toEqual(['Yours'])
  })

  it('Add by address sits at the Marketplace’s head after its title, pushed right, in the accent colour', async () => {
    await boot()
    await enter()
    const head = document.querySelector<HTMLElement>('.ms-market .ma-head')!
    const add = buttonLabelled('Add by address', head)!
    expect([...head.children].map((el) => el.className)).toEqual(['ma-title-text', 'ah-spacer', 'ms-btn ms-add-agent'])
    expect(add.disabled).toBe(false)
    const css = readFileSync(resolve(import.meta.dirname, '..', '..', 'public', 'style.css'), 'utf8')
    const mine = css.slice(css.indexOf('agent setup in the app (step 2b)'), css.indexOf('/* Run history (cards view V5d)'))
    // the selected tab's own accent token, for the outline and the text; no new colour
    expect(mine).toMatch(/\.ms-add-agent \{ border-color: var\(--app-accent\); color: var\(--app-accent\); \}/)
    expect(css).toMatch(/\.tab\[aria-selected="true"\] \{[^}]*var\(--app-accent\)/)
  })
})

describe('adding a server (D3)', () => {
  it('opens in the tab with focus on Name, runs a dry run then the real one, and checks the new server on its row', async () => {
    const { bridge } = await boot()
    await enter()
    click(buttonLabelled('Add a server', home()))
    await settle()
    expect(shown(setup())).toBe(true)
    expect(shown(home())).toBe(false)
    expect(title().textContent).toBe('Add a model server')
    expect(document.activeElement).toBe(field('name'))
    type(field('name'), 'local')
    type(field('baseUrl'), 'http://127.0.0.1:8080/v1')
    // Key file shows Choose file…, whose answer names the file only
    expect(shown(buttonLabelled('Choose file…', setup()))).toBe(false)
    const file = setup().querySelector<HTMLInputElement>('input[type="radio"][value="file"]')!
    file.checked = true
    file.dispatchEvent(new window.Event('change', { bubbles: true }))
    await settle()
    click(buttonLabelled('Choose file…', setup()))
    await settle()
    expect(bridge.s.picks).toEqual(['key'])
    expect(setup().querySelector('.ms-file-name')?.textContent).toBe('server.key')
    expect(document.body.innerHTML).not.toContain(HANDLE)
    bridge.s.servers = [server('local', { baseUrl: 'http://127.0.0.1:8080/v1', key: 'file' })]
    click(buttonLabelled('Save', setup()))
    await settle()
    expect(bridge.ops()).toEqual([
      ['add-server', { name: 'local', baseUrl: 'http://127.0.0.1:8080/v1', key: HANDLE, apply: false }],
      ['add-server', { name: 'local', baseUrl: 'http://127.0.0.1:8080/v1', key: HANDLE, apply: true }],
      ['check-server', { name: 'local' }],
    ])
    // back in the section, with the check's result on the new row
    expect(shown(setup())).toBe(false)
    expect(title().textContent).toBe('Agent cards')
    expect(row('local')!.querySelector('.ms-row-note')?.textContent).toBe('reachable · 2 models')
    expect(row('local')!.querySelector('.ms-row-facts')?.textContent).toBe('http://127.0.0.1:8080/v1 · key file')
    expect(document.activeElement).toBe(buttonLabelled('Check', row('local')!))
  })

  it('shows a refusal’s own words under the form as text, and never runs the real one', async () => {
    const { bridge } = await boot()
    await enter()
    click(buttonLabelled('Add a server', home()))
    await settle()
    type(field('name'), 'local')
    type(field('baseUrl'), 'http://127.0.0.1:8080')
    bridge.s.answers['add-server'] = () => ({ ok: false, applied: false, steps: [], refused: 'server <b>local</b> already exists' })
    click(buttonLabelled('Save', setup()))
    await settle()
    expect(message().textContent).toBe('server <b>local</b> already exists')
    expect(message().querySelector('b')).toBeNull()
    expect(bridge.ops()).toEqual([['add-server', { name: 'local', baseUrl: 'http://127.0.0.1:8080', key: 'none', apply: false }]])
    // the form stays as it was, and focus on Save
    expect(field('name')!.value).toBe('local')
    expect(document.activeElement).toBe(buttonLabelled('Save', setup()))
  })

  it('says what is wrong before running anything: the name, the address, a key file not chosen', async () => {
    const { bridge } = await boot()
    await enter()
    click(buttonLabelled('Add a server', home()))
    await settle()
    type(field('name'), 'Local Server')
    click(buttonLabelled('Save', setup()))
    await settle()
    expect(message().textContent).toBe('Use lower-case letters, digits and hyphens for the name.')
    type(field('name'), 'local')
    type(field('baseUrl'), 'ftp://example')
    click(buttonLabelled('Save', setup()))
    await settle()
    expect(message().textContent).toBe('Enter the address, starting with http:// or https://.')
    expect(bridge.ops()).toEqual([])
  })

  it('← Agent cards goes back with focus on Add a server, and nothing was run', async () => {
    const { bridge } = await boot()
    await enter()
    click(buttonLabelled('Add a server', home()))
    await settle()
    click(setup().querySelector('.map-back'))
    await settle()
    expect(shown(home())).toBe(true)
    expect(document.activeElement).toBe(buttonLabelled('Add a server', home()))
    expect(bridge.ops()).toEqual([])
  })
})

describe('adding a Claude Code server (Claude Code D3)', () => {
  const kindRadio = (value: string) => setup().querySelector<HTMLInputElement>(`input[type="radio"][name="msKind"][value="${value}"]`)!
  const pick = (radio: HTMLInputElement) => {
    radio.checked = true
    radio.dispatchEvent(new window.Event('change', { bubbles: true }))
  }
  const address = () => field('baseUrl')!.closest<HTMLElement>('.ms-field')!
  const keyChoice = () => setup().querySelector<HTMLInputElement>('input[name="msKey"]')!.closest<HTMLElement>('.ms-choice')!
  const quiet = () => [...setup().querySelectorAll<HTMLElement>('.ms-hint')].find((el) => el.textContent === 'Uses the Claude Code you are signed in to. No key to enter.')

  it('asks What kind above the Name, an address server chosen, and focus on Name as before', async () => {
    await boot()
    await enter()
    click(buttonLabelled('Add a server', home()))
    await settle()
    expect(document.activeElement).toBe(field('name'))
    const choice = kindRadio('http').closest<HTMLElement>('fieldset')!
    expect(choice.querySelector('legend')?.textContent).toBe('What kind')
    expect([...choice.querySelectorAll('label')].map((el) => el.textContent?.trim())).toEqual(['Claude Code on this Mac', 'A server at an address'])
    expect([kindRadio('claude-code').checked, kindRadio('http').checked]).toEqual([false, true])
    // the choice comes before the Name field
    expect(choice.compareDocumentPosition(field('name')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect([shown(address()), shown(keyChoice())]).toEqual([true, true])
    expect(quiet()).toBeDefined()
    expect(shown(quiet())).toBe(false)
  })

  it('Claude Code on this Mac: only the Name and one quiet line; Save runs add-claude-server dry, then applied, then checks the new row', async () => {
    const { bridge } = await boot()
    await enter()
    click(buttonLabelled('Add a server', home()))
    await settle()
    pick(kindRadio('claude-code'))
    await settle()
    expect([shown(address()), shown(keyChoice()), shown(buttonLabelled('Choose file…', setup()))]).toEqual([false, false, false])
    expect(shown(quiet())).toBe(true)
    // the quiet line sits under the Name
    expect(field('name')!.compareDocumentPosition(quiet()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    type(field('name'), 'claude')
    bridge.s.servers = [claudeServer('claude')]
    bridge.s.answers['check-server'] = () => checkedClaude()
    click(buttonLabelled('Save', setup()))
    await settle()
    expect(bridge.ops()).toEqual([
      ['add-claude-server', { name: 'claude', apply: false }],
      ['add-claude-server', { name: 'claude', apply: true }],
      ['check-server', { name: 'claude' }],
    ])
    expect(shown(setup())).toBe(false)
    expect(row('claude')!.querySelector('.ms-row-facts')?.textContent).toBe('Claude Code on this Mac · sends text to Anthropic')
    expect(row('claude')!.querySelector('.ms-row-note')?.textContent).toBe('ready · signed in · 3 models')
    expect(document.activeElement).toBe(buttonLabelled('Check', row('claude')!))
  })

  it('switching the kind back and forth loses nothing typed or chosen; the hidden fields are not checked; Save sends the kind shown', async () => {
    const { bridge } = await boot()
    await enter()
    click(buttonLabelled('Add a server', home()))
    await settle()
    type(field('name'), 'Not A Name')
    type(field('baseUrl'), 'ftp://not-an-address')
    pick(setup().querySelector<HTMLInputElement>('input[name="msKey"][value="file"]')!)
    await settle()
    click(buttonLabelled('Choose file…', setup()))
    await settle()
    pick(kindRadio('claude-code'))
    await settle()
    // the name is still checked, the address and the key are not
    click(buttonLabelled('Save', setup()))
    await settle()
    expect(message().textContent).toBe('Use lower-case letters, digits and hyphens for the name.')
    type(field('name'), 'claude')
    pick(kindRadio('http'))
    await settle()
    expect([field('name')!.value, field('baseUrl')!.value]).toEqual(['claude', 'ftp://not-an-address'])
    expect(setup().querySelector<HTMLInputElement>('input[name="msKey"][value="file"]')!.checked).toBe(true)
    expect(setup().querySelector('.ms-file-name')?.textContent).toBe('server.key')
    expect([shown(address()), shown(keyChoice()), shown(quiet())]).toEqual([true, true, false])
    click(buttonLabelled('Save', setup()))
    await settle()
    expect(message().textContent).toBe('Enter the address, starting with http:// or https://.')
    expect(bridge.ops()).toEqual([])
    pick(kindRadio('claude-code'))
    await settle()
    bridge.s.answers['add-claude-server'] = () => meshProcess.meshAnswer('plan', JSON.stringify({ applied: false, steps: [], refused: 'the server <b>claude</b> is already in servers.json' }), 1) as Json
    click(buttonLabelled('Save', setup()))
    await settle()
    expect(bridge.ops()).toEqual([['add-claude-server', { name: 'claude', apply: false }]])
    expect(message().textContent).toBe('the server <b>claude</b> is already in servers.json')
    expect(message().querySelector('b')).toBeNull()
    expect(document.activeElement).toBe(buttonLabelled('Save', setup()))
  })

  it('a repaint while Claude Code is chosen keeps the choice, the Name and focus', async () => {
    const { bridge, mesh } = await boot()
    await enter()
    click(buttonLabelled('Add a server', home()))
    await settle()
    pick(kindRadio('claude-code'))
    await settle()
    type(field('name'), 'claude')
    field('name')!.focus()
    const before = field('name')
    mesh.s.version = { agents: 1 }
    mesh.s.body = { on: true, agents: [on('unslop')], others: 0, available: [OFFERED['unslop-code']!, OFFERED['request-post']!] }
    await pollTick()
    await pollTick()
    expect(field('name')).toBe(before)
    expect(field('name')!.value).toBe('claude')
    expect(kindRadio('claude-code').checked).toBe(true)
    expect([shown(address()), shown(keyChoice()), shown(quiet())]).toEqual([false, false, true])
    expect(document.activeElement).toBe(before)
    expect(bridge.ops()).toEqual([])
  })

  it('the quiet line describes the Name field while it shows, and only then (U2)', async () => {
    await boot()
    await enter()
    click(buttonLabelled('Add a server', home()))
    await settle()
    expect(field('name')!.hasAttribute('aria-describedby')).toBe(false)
    pick(kindRadio('claude-code'))
    await settle()
    expect(quiet()!.id).not.toBe('')
    expect(field('name')!.getAttribute('aria-describedby')).toBe(quiet()!.id)
    expect(document.getElementById(quiet()!.id)).toBe(quiet())
    pick(kindRadio('http'))
    await settle()
    expect(field('name')!.hasAttribute('aria-describedby')).toBe(false)
  })

  it('changing What kind clears a message left under the form (U3)', async () => {
    const { bridge } = await boot()
    await enter()
    click(buttonLabelled('Add a server', home()))
    await settle()
    type(field('name'), 'claude')
    click(buttonLabelled('Save', setup()))
    await settle()
    expect(message().textContent).toBe('Enter the address, starting with http:// or https://.')
    pick(kindRadio('claude-code'))
    await settle()
    expect(message().textContent).toBe('')
    expect(shown(message())).toBe(false)
    expect(bridge.ops()).toEqual([])
  })

  it('a Save in flight disables both kind radios until it ends (U6)', async () => {
    const { bridge } = await boot()
    await enter()
    click(buttonLabelled('Add a server', home()))
    await settle()
    pick(kindRadio('claude-code'))
    await settle()
    type(field('name'), 'claude')
    const release = bridge.hold()
    click(buttonLabelled('Save', setup()))
    await settle()
    expect([kindRadio('claude-code').disabled, kindRadio('http').disabled]).toEqual([true, true])
    expect(buttonLabelled('Saving…', setup())!.disabled).toBe(true)
    release()
    await settle()
    expect(bridge.ops().map(([op]) => op)).toEqual(['add-claude-server', 'add-claude-server', 'check-server'])
  })

  it('switching to Claude Code and back to an address with a valid address, Save sends add-server (U6)', async () => {
    const { bridge } = await boot()
    await enter()
    click(buttonLabelled('Add a server', home()))
    await settle()
    type(field('name'), 'local')
    pick(kindRadio('claude-code'))
    await settle()
    pick(kindRadio('http'))
    await settle()
    type(field('baseUrl'), 'http://127.0.0.1:8080/v1')
    bridge.s.servers = [server('local', { kind: 'http', baseUrl: 'http://127.0.0.1:8080/v1' })]
    click(buttonLabelled('Save', setup()))
    await settle()
    expect(bridge.ops()).toEqual([
      ['add-server', { name: 'local', baseUrl: 'http://127.0.0.1:8080/v1', key: 'none', apply: false }],
      ['add-server', { name: 'local', baseUrl: 'http://127.0.0.1:8080/v1', key: 'none', apply: true }],
      ['check-server', { name: 'local' }],
    ])
  })

  it('the hidden Address and Key leave the layout: a rule hides a hidden field or choice, inside the set-up slice', () => {
    const css = readFileSync(resolve(import.meta.dirname, '..', '..', 'public', 'style.css'), 'utf8')
    const mine = css.slice(css.indexOf('agent setup in the app (step 2b)'), css.indexOf('/* Run history (cards view V5d)'))
    const hiding = /([^{}]*)\{\s*display:\s*none;\s*\}/g
    const selectors = [...mine.matchAll(hiding)].flatMap((m) => m[1]!.split(',').map((one) => one.trim()))
    expect(selectors).toEqual(expect.arrayContaining(['.ms-field[hidden]', '.ms-choice[hidden]']))
  })
})

describe('a page that opens shows from its top (F4)', () => {
  // the page scrolls as a whole in both layouts (nothing inside it has its own scrollbar), so the
  // page's own scroll position is what a page opened lower down would keep
  function scrolledDown() {
    const original = Object.getOwnPropertyDescriptor(window, 'scrollY')
    let offset = 300
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => offset })
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => { offset = 0 })
    return {
      scrollTo,
      down: () => { offset = 300 },
      restore: () => {
        if (original) Object.defineProperty(window, 'scrollY', original)
        else Reflect.deleteProperty(window, 'scrollY')
        scrollTo.mockRestore()
      },
    }
  }

  it('Add a server, Make it a server, Set up and Change server open at the top; going back does not scroll', async () => {
    const { bridge } = await boot({ agents: [on('unslop-code')], available: [OFFERED['request-post']!], bridge: { servers: [server('local', { agents: ['unslop-code'] })], inline: ['unslop'] } })
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await enter()
    const scroll = scrolledDown()
    try {
      const opens: Array<[string, () => void]> = [
        ['Add a model server', () => click(buttonLabelled('Add a server', home()))],
        ['Make it a server', () => click(buttonLabelled('Make it a server', inlineRow('unslop')!))],
        ['request-post', () => click(buttonLabelled('Set up', offer('request-post')!))],
      ]
      for (const [name, open] of opens) {
        scroll.down()
        scroll.scrollTo.mockClear()
        open()
        await settle()
        expect(title().textContent, name).toBe(name)
        expect(window.scrollY, name).toBe(0)
        scroll.scrollTo.mockClear()
        click(setup().querySelector('.map-back'))
        await settle()
        expect(scroll.scrollTo, `back from ${name}`).not.toHaveBeenCalled()
      }
      click(card('unslop-code'))
      await settle()
      scroll.down()
      click(buttonLabelled('Change server', agentPage().querySelector('.ms-foot')!))
      await settle()
      expect(title().textContent).toBe('unslop-code')
      expect(shown(setup())).toBe(true)
      expect(window.scrollY).toBe(0)
      expect(bridge.ops().some(([op]) => op !== 'check-server')).toBe(false)
    } finally {
      scroll.restore()
    }
  })

  it('the agent’s page that replaces the set-up page after Turn on opens at the top too', async () => {
    await boot({ bridge: { servers: [server('local')] } })
    await enter()
    click(buttonLabelled('Set up', offer('unslop-code')!))
    await settle()
    choose(select('model'), 'model-a')
    click(buttonLabelled('Check', setup()))
    await settle()
    const scroll = scrolledDown()
    try {
      scroll.scrollTo.mockClear()
      click(buttonLabelled('Turn on', setup()))
      await settle()
      expect(shown(agentPage())).toBe(true)
      expect(window.scrollY).toBe(0)
    } finally {
      scroll.restore()
    }
  })
})

describe('focus after Save (F1)', () => {
  // the real bridge answers after a command's time, and Chrome drops focus from a control a repaint disables
  async function saveSlowly(bridge: Awaited<ReturnType<typeof boot>>['bridge']) {
    bridge.s.delay = 8
    const stop = blurWhenDisabled()
    try {
      click(buttonLabelled('Save', setup()))
      await vi.advanceTimersByTimeAsync(400)
      await settle()
    } finally {
      stop()
    }
  }

  it('Add a model server: focus lands on the new row’s Check button once the row is painted', async () => {
    const { bridge } = await boot()
    await enter()
    click(buttonLabelled('Add a server', home()))
    await settle()
    type(field('name'), 'local')
    type(field('baseUrl'), 'http://127.0.0.1:8080/v1')
    bridge.s.servers = [server('local', { baseUrl: 'http://127.0.0.1:8080/v1' })]
    await saveSlowly(bridge)
    expect(shown(row('local'))).toBe(true)
    expect(row('local')!.querySelector('.ms-row-note')?.textContent).toBe('reachable · 2 models')
    expect(document.activeElement).toBe(buttonLabelled('Check', row('local')!))
  })

  it('Make it a server: focus lands on the new row’s Check button', async () => {
    const { bridge } = await boot({ bridge: { inline: ['unslop-code'] } })
    await enter()
    click(buttonLabelled('Make it a server', inlineRow('unslop-code')!))
    await settle()
    type(field('name'), 'coder')
    bridge.s.servers = [server('coder', { agents: ['unslop-code'] })]
    bridge.s.inline = []
    await saveSlowly(bridge)
    expect(inlineRow('unslop-code')).toBeNull()
    expect(document.activeElement).toBe(buttonLabelled('Check', row('coder')!))
  })

  it('a server list that cannot be read leaves focus on Add a server', async () => {
    const { bridge } = await boot()
    await enter()
    click(buttonLabelled('Add a server', home()))
    await settle()
    type(field('name'), 'local')
    type(field('baseUrl'), 'http://127.0.0.1:8080/v1')
    bridge.s.answers['servers'] = () => ({ ok: false, reason: 'timeout' })
    await saveSlowly(bridge)
    expect(row('local')).toBeNull()
    expect(document.activeElement).toBe(buttonLabelled('Add a server', home()))
  })
})

describe('focus after an applied change (U1)', () => {
  // as focus after Save: the real bridge answers after a command's time, and Chrome drops focus from a disabled control
  async function pressSlowly(bridge: Awaited<ReturnType<typeof boot>>['bridge'], control: HTMLElement) {
    bridge.s.delay = 8
    const stop = blurWhenDisabled()
    try {
      click(control)
      await vi.advanceTimersByTimeAsync(2000)
      await settle()
      await pollTick()
      await vi.advanceTimersByTimeAsync(2000)
      await settle()
    } finally {
      stop()
    }
  }

  it('Change server: focus lands back on the agent page’s Change server, never on the body', async () => {
    const { bridge } = await boot({ agents: [on('unslop-code')], available: [OFFERED['unslop']!], bridge: { servers: [server('local', { agents: ['unslop-code'] }), server('lab')] } })
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await enter()
    click(card('unslop-code'))
    await settle()
    const foot = () => agentPage().querySelector<HTMLElement>('.ms-foot')!
    click(buttonLabelled('Change server', foot()))
    await settle()
    choose(select('server'), 'lab')
    await settle()
    choose(select('model'), 'model-a')
    click(buttonLabelled('Check', setup()))
    await settle()
    await pressSlowly(bridge, buttonLabelled('Change server', setup())!)
    expect(bridge.ops().filter(([op, values]) => op === 'enable-model-agent' && values['apply'] === true)).toHaveLength(1)
    expect(shown(agentPage())).toBe(true)
    expect(document.activeElement).not.toBe(document.body)
    expect(document.activeElement).toBe(buttonLabelled('Change server', foot()))
  })

  it('Turn on from the Marketplace: focus lands on the agent’s page, never on the body', async () => {
    const { bridge, mesh } = await boot({ bridge: { servers: [server('local')] } })
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await enter()
    click(buttonLabelled('Set up', offer('unslop-code')!))
    await settle()
    choose(select('model'), 'model-a')
    click(buttonLabelled('Check', setup()))
    await settle()
    bridge.s.answers['enable-model-agent'] = (values) => values['apply'] === true
      ? (mesh.s.version = { agents: 1 }, mesh.s.body = { on: true, agents: [on('unslop-code', { state: 'unchecked', reason: 'press Refresh' })], others: 0, available: [OFFERED['unslop']!, OFFERED['request-post']!] }, planned(true))
      : planned(false)
    await pressSlowly(bridge, buttonLabelled('Turn on', setup())!)
    expect(shown(agentPage())).toBe(true)
    expect(document.activeElement).not.toBe(document.body)
    expect(agentPage().contains(document.activeElement)).toBe(true)
    expect(document.activeElement).toBe(agentPage().querySelector('.map-back'))
  })
})

describe('Make it a server (D3)', () => {
  it('asks only a name and runs adopt-server dry, then applied; the new server takes the inline row’s place', async () => {
    const { bridge } = await boot({ bridge: { inline: ['unslop-code'] } })
    await enter()
    click(buttonLabelled('Make it a server', inlineRow('unslop-code')!))
    await settle()
    expect(title().textContent).toBe('Make it a server')
    expect([...setup().querySelectorAll('input, select')].map((el) => (el as HTMLInputElement).name)).toEqual(['name'])
    expect(document.activeElement).toBe(field('name'))
    type(field('name'), 'coder')
    bridge.s.servers = [server('coder', { agents: ['unslop-code'] })]
    bridge.s.inline = []
    click(buttonLabelled('Save', setup()))
    await settle()
    expect(bridge.ops()).toEqual([
      ['adopt-server', { name: 'coder', from: 'unslop-code', apply: false }],
      ['adopt-server', { name: 'coder', from: 'unslop-code', apply: true }],
      ['check-server', { name: 'coder' }],
    ])
    expect(inlineRow('unslop-code')).toBeNull()
    expect(row('coder')!.querySelector('.ms-row-note')?.textContent).toBe('reachable · 2 models')
    // its opener left the page: focus is on the new row, never nowhere
    expect(document.activeElement).toBe(buttonLabelled('Check', row('coder')!))
  })
})

describe('Check and Remove on a server’s row (D3)', () => {
  it('Check shows the result in the row; a failed check says why in plain words', async () => {
    const { bridge } = await boot({ bridge: { servers: [server('local')] } })
    await enter()
    click(buttonLabelled('Check', row('local')!))
    await settle()
    expect(row('local')!.querySelector('.ms-row-note')?.textContent).toBe('reachable · 2 models')
    expect(document.activeElement).toBe(buttonLabelled('Check', row('local')!))
    bridge.s.answers['check-server'] = () => checked('unauthorized')
    click(buttonLabelled('Check', row('local')!))
    await settle()
    expect(row('local')!.querySelector('.ms-row-note')?.textContent).toBe('The server refused the key.')
  })

  it('every failed check has its own plain words, in the shape the app really answers', async () => {
    const { bridge } = await boot({ bridge: { servers: [server('local')] } })
    await enter()
    const WORDS: Record<string, string> = {
      unreachable: 'The server did not answer.',
      unauthorized: 'The server refused the key.',
      'not-a-model-server': 'This address does not answer as a model server.',
      timeout: 'The server did not answer in time.',
      key: 'The key could not be read.',
    }
    for (const [failure, words] of Object.entries(WORDS)) {
      const answer = checked(failure)
      // the app's answer for a check that ran and failed: not ok, the failure, and no reason
      expect(answer, failure).toEqual({ ok: false, reachable: false, failure, models: [], skipped: 0, kind: 'http' })
      bridge.s.answers['check-server'] = () => answer
      click(buttonLabelled('Check', row('local')!))
      await settle()
      expect(row('local')!.querySelector('.ms-row-note')?.textContent, failure).toBe(words)
    }
  })

  it('a key the app cannot read says why, by where the key comes from', async () => {
    const { bridge } = await boot({ bridge: { servers: [server('by-command', { key: 'command' }), server('by-variable', { key: 'env' }), server('by-file', { key: 'file' })] } })
    await enter()
    bridge.s.answers['check-server'] = () => checked('key')
    const WORDS: Record<string, string> = {
      'by-command': 'The command gave no key. The app runs it without your terminal’s settings (docs/model-servers.md).',
      'by-variable': 'The app cannot see your terminal’s variables, so it cannot read this key (docs/model-servers.md).',
      'by-file': 'The key file could not be read: it is missing, empty or not a private file of yours.',
    }
    for (const [name, words] of Object.entries(WORDS)) {
      click(buttonLabelled('Check', row(name)!))
      await settle()
      expect(row(name)!.querySelector('.ms-row-note')?.textContent, name).toBe(words)
    }
    // another failure on the same server keeps its own words
    bridge.s.answers['check-server'] = () => checked('unreachable')
    click(buttonLabelled('Check', row('by-command')!))
    await settle()
    expect(row('by-command')!.querySelector('.ms-row-note')?.textContent).toBe('The server did not answer.')
  })

  it('a check the command refused shows the refusal’s own words', async () => {
    const { bridge } = await boot({ bridge: { servers: [server('local')] } })
    await enter()
    const refused = meshProcess.meshAnswer('check', JSON.stringify({ server: 'local', refused: 'the server local is not in the list' }), 1) as Json
    expect(refused).toEqual({ ok: false, reachable: false, models: [], skipped: 0, refused: 'the server local is not in the list' })
    bridge.s.answers['check-server'] = () => refused
    click(buttonLabelled('Check', row('local')!))
    await settle()
    expect(row('local')!.querySelector('.ms-row-note')?.textContent).toBe('the server local is not in the list')
  })

  it('Remove asks in place, Cancel puts it back, and a refusal shows in the row', async () => {
    const { bridge } = await boot({ bridge: { servers: [server('local')] } })
    await enter()
    const ask = () => row('local')!.querySelector<HTMLElement>('.ms-ask')!
    expect(shown(ask())).toBe(false)
    click(buttonLabelled('Remove', row('local')!.querySelector('.ms-row-actions')!))
    await settle()
    expect(shown(ask())).toBe(true)
    expect(ask().querySelector('.ms-ask-text')?.textContent).toBe('Remove local?')
    expect(document.activeElement).toBe(buttonLabelled('Cancel', ask()))
    // a repaint keeps the question
    await pollTick()
    expect(shown(ask())).toBe(true)
    click(buttonLabelled('Cancel', ask()))
    await settle()
    expect(shown(ask())).toBe(false)
    expect(document.activeElement).toBe(buttonLabelled('Remove', row('local')!.querySelector('.ms-row-actions')!))
    expect(bridge.ops()).toEqual([])
    click(buttonLabelled('Remove', row('local')!.querySelector('.ms-row-actions')!))
    await settle()
    bridge.s.answers['remove-server'] = () => ({ ok: false, applied: false, steps: [], refused: 'unslop-code still uses local' })
    click(buttonLabelled('Remove', ask()))
    await settle()
    expect(bridge.ops()).toEqual([['remove-server', { name: 'local', apply: false }]])
    expect(row('local')!.querySelector('.ms-row-note')?.textContent).toBe('unslop-code still uses local')
    expect(shown(ask())).toBe(false)
  })

  it('a server an agent still uses is not removed: the row says to change their server first, and nothing runs (F6)', async () => {
    const { bridge } = await boot({ bridge: { servers: [server('main', { agents: ['unslop'] }), server('both', { agents: ['unslop', 'unslop-code'] }), server('free')] } })
    await enter()
    const note = (name: string) => row(name)!.querySelector<HTMLElement>('.ms-row-note')!
    const remove = (name: string) => buttonLabelled('Remove', row(name)!.querySelector('.ms-row-actions')!)!
    click(remove('main'))
    await settle()
    expect(note('main').textContent).toBe('unslop still uses this server. Change its server first.')
    expect(shown(note('main'))).toBe(true)
    expect(shown(row('main')!.querySelector('.ms-ask'))).toBe(false)
    click(remove('both'))
    await settle()
    expect(note('both').textContent).toBe('unslop, unslop-code still use this server. Change their server first.')
    expect(shown(row('both')!.querySelector('.ms-ask'))).toBe(false)
    expect(bridge.ops()).toEqual([])
    // a server no agent uses keeps the question
    click(remove('free'))
    await settle()
    expect(row('free')!.querySelector('.ms-ask-text')?.textContent).toBe('Remove free?')
    expect(shown(row('free')!.querySelector('.ms-ask'))).toBe(true)
  })

  it('the "still uses" line goes once no agent uses the server and Remove asks its question', async () => {
    const { bridge } = await boot({ bridge: { servers: [server('main', { agents: ['unslop'] })] } })
    await enter()
    const remove = () => buttonLabelled('Remove', row('main')!.querySelector('.ms-row-actions')!)!
    click(remove())
    await settle()
    expect(row('main')!.querySelector('.ms-row-note')?.textContent).toContain('still uses this server')
    bridge.s.servers = [server('main')]
    click(document.querySelector('#cards .ma-refresh'))
    await settle()
    // the line is out of date the moment the list says no agent uses the server, before any press
    expect(row('main')!.querySelector('.ms-row-note')?.textContent).toBe('')
    click(remove())
    await settle()
    expect(row('main')!.querySelector('.ms-row-note')?.textContent).toBe('')
    expect(shown(row('main')!.querySelector('.ms-ask'))).toBe(true)
  })

  it('a removal runs dry then applied, and the row leaves', async () => {
    const { bridge } = await boot({ bridge: { servers: [server('local'), server('old')] } })
    await enter()
    click(buttonLabelled('Remove', row('old')!.querySelector('.ms-row-actions')!))
    await settle()
    bridge.s.servers = [server('local')]
    click(buttonLabelled('Remove', row('old')!.querySelector('.ms-ask')!))
    await settle()
    expect(bridge.ops()).toEqual([['remove-server', { name: 'old', apply: false }], ['remove-server', { name: 'old', apply: true }]])
    expect(row('old')).toBeNull()
    expect(document.activeElement).toBe(buttonLabelled('Add a server', home()))
  })
})

describe('a Claude Code server in Model servers (Claude Code D2)', () => {
  const facts = (name: string) => row(name)!.querySelector('.ms-row-facts')?.textContent
  const note = (name: string) => row(name)!.querySelector<HTMLElement>('.ms-row-note')!

  it('its row says where it runs and that text goes to Anthropic, with who uses it; no address and no key words', async () => {
    await boot({ bridge: { servers: [claudeServer('claude', { agents: ['unslop-code'] }), claudeServer('spare'), server('lab', { key: 'command' })] } })
    await enter()
    expect(facts('claude')).toBe('Claude Code on this Mac · sends text to Anthropic · used by unslop-code')
    expect(facts('spare')).toBe('Claude Code on this Mac · sends text to Anthropic')
    expect(facts('lab')).toBe('http://127.0.0.1:8080/lab · key from a command')
    expect(row('claude')!.textContent).not.toContain('no key')
    expect(shown(buttonLabelled('Check', row('claude')!))).toBe(true)
    expect(shown(buttonLabelled('Remove', row('claude')!))).toBe(true)
  })

  it('a list from a command older than the Claude Code kind still shows, every row as an address server', async () => {
    const { bridge } = await boot({ bridge: { servers: [olderServer('local', { key: 'file', agents: ['unslop'] }), olderServer('lab')] } })
    await enter()
    // the rows carry no kind, as such a command prints them; the bridge's own shaper makes them address servers
    expect(bridge.s.servers.every((one) => !('kind' in one))).toBe(true)
    expect(facts('local')).toBe('http://127.0.0.1:8080/local · key file · used by unslop')
    expect(facts('lab')).toBe('http://127.0.0.1:8080/lab · no key')
  })

  it('Check: ready and signed in with its models; each failure in its own words; an address server keeps its own', async () => {
    const { bridge } = await boot({ bridge: { servers: [claudeServer('claude'), server('lab')] } })
    await enter()
    bridge.s.answers['check-server'] = () => checkedClaude()
    click(buttonLabelled('Check', row('claude')!))
    await settle()
    expect(note('claude').textContent).toBe('ready · signed in · 3 models')
    expect(document.activeElement).toBe(buttonLabelled('Check', row('claude')!))
    bridge.s.answers['check-server'] = () => checkedClaude(undefined, { models: ['sonnet'] })
    click(buttonLabelled('Check', row('claude')!))
    await settle()
    expect(note('claude').textContent).toBe('ready · signed in · 1 model')
    const WORDS: Record<string, string> = {
      'no-program': 'Claude Code was not found on this Mac.',
      'signed-out': 'Claude Code is not signed in, or could not start from the app. Run claude in a terminal and sign in.',
      timeout: 'Claude Code did not answer in time.',
    }
    for (const [failure, words] of Object.entries(WORDS)) {
      const answer = checkedClaude(failure)
      expect(answer, failure).toEqual({ ok: false, reachable: false, failure, models: [], skipped: 0, kind: 'claude-code' })
      bridge.s.answers['check-server'] = () => answer
      click(buttonLabelled('Check', row('claude')!))
      await settle()
      expect(note('claude').textContent, failure).toBe(words)
    }
    // the shared word keeps the address server's sentence on an address server
    bridge.s.answers['check-server'] = () => checked('timeout')
    click(buttonLabelled('Check', row('lab')!))
    await settle()
    expect(note('lab').textContent).toBe('The server did not answer in time.')
    bridge.s.answers['check-server'] = () => checked()
    click(buttonLabelled('Check', row('lab')!))
    await settle()
    expect(note('lab').textContent).toBe('reachable · 2 models')
  })

  it('a check that names http goes by its own kind, whatever the page’s row says (U6)', async () => {
    const { bridge } = await boot({ bridge: { servers: [claudeServer('claude'), server('lab')] } })
    await enter()
    // an address server's check, as the command prints it: kind http
    expect(checked()).toMatchObject({ kind: 'http' })
    bridge.s.answers['check-server'] = () => checked()
    click(buttonLabelled('Check', row('claude')!))
    await settle()
    expect(note('claude').textContent).toBe('reachable · 2 models')
    bridge.s.answers['check-server'] = () => checked('timeout')
    click(buttonLabelled('Check', row('claude')!))
    await settle()
    expect(note('claude').textContent).toBe('The server did not answer in time.')
  })

  it('a check that names no kind goes by the server list: Claude Code’s words on its row', async () => {
    const { bridge } = await boot({ bridge: { servers: [claudeServer('claude')] } })
    await enter()
    bridge.s.answers['check-server'] = () => checkedClaude(undefined, { kind: false })
    expect(bridge.s.answers['check-server']({})).not.toHaveProperty('kind')
    click(buttonLabelled('Check', row('claude')!))
    await settle()
    expect(note('claude').textContent).toBe('ready · signed in · 3 models')
    bridge.s.answers['check-server'] = () => checkedClaude('timeout', { kind: false })
    click(buttonLabelled('Check', row('claude')!))
    await settle()
    expect(note('claude').textContent).toBe('Claude Code did not answer in time.')
    // a refusal and a bridge reason keep their own words on this kind too
    bridge.s.answers['check-server'] = () => ({ ok: false, reason: 'busy' })
    click(buttonLabelled('Check', row('claude')!))
    await settle()
    expect(note('claude').textContent).toBe('Another setup step is still running.')
  })
})

describe('setting up an agent (D4)', () => {
  it('unslop-code: the one server is chosen already, the models come from it, and the steps show as text', async () => {
    const { bridge, mesh } = await boot({ bridge: { servers: [server('local')] } })
    await enter()
    click(buttonLabelled('Set up', offer('unslop-code')!))
    await settle()
    expect(title().textContent).toBe('unslop-code')
    expect(document.activeElement).toBe(select('server'))
    expect(select('server').value).toBe('local')
    expect([...select('server').options].map((o) => o.textContent)).toEqual(['local', 'Add a server…'])
    expect(bridge.ops()).toEqual([['check-server', { name: 'local' }]])
    expect([...select('model').options].map((o) => o.textContent)).toEqual(['Choose a model', 'model-a', 'model-b'])
    choose(select('model'), 'model-b')
    bridge.s.answers['enable-model-agent'] = (values) => values['apply'] === true
      ? (mesh.s.version = { agents: 1 }, mesh.s.body = { on: true, agents: [], others: 0, available: [] }, { ok: true, applied: true, steps: [] })
      : { ok: true, applied: false, steps: ['Add unslop-code to mesh.json', '<img src=x onerror=alert(1)>'], notes: ['Restart nothing'] }
    click(buttonLabelled('Check', setup()))
    await settle()
    const review = setup().querySelector<HTMLElement>('.ms-review')!
    expect(shown(review)).toBe(true)
    expect(review.querySelector('.ms-review-title')?.textContent).toBe('Turning it on will')
    expect([...review.querySelectorAll('.ms-steps li')].map((li) => li.textContent)).toEqual([
      'Save its settings: server local, model model-b.',
      'Add the command that you and your chats run.',
      'Add unslop-code to your agents.',
    ])
    expect(review.querySelector('.ms-nothing')?.textContent).toBe('Nothing has changed yet.')
    // the command's own lines are closed under the buttons, set as text
    const exact = review.querySelector<HTMLDetailsElement>('details.ms-exact')!
    expect(exact.querySelector('summary')?.textContent).toBe('Exact steps')
    expect(exact.open).toBe(false)
    expect([...exact.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Add unslop-code to mesh.json', '<img src=x onerror=alert(1)>', 'Restart nothing'])
    expect(review.lastElementChild).toBe(exact)
    expect(buttonLabelled('Turn on', review)!.compareDocumentPosition(exact) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(document.querySelector('#cards img')).toBeNull()
    expect(document.activeElement).toBe(buttonLabelled('Turn on', review))
    // the form waits under the check: its fields are not editable until Back
    expect(select('server').disabled).toBe(true)
    click(buttonLabelled('Turn on', review))
    await settle()
    expect(bridge.ops()).toEqual([
      ['check-server', { name: 'local' }],
      ['enable-model-agent', { agent: 'unslop-code', server: 'local', model: 'model-b', apply: false }],
      ['enable-model-agent', { agent: 'unslop-code', server: 'local', model: 'model-b', apply: true }],
    ])
    // its own page, saying it was just turned on until the next read names it
    expect(shown(setup())).toBe(false)
    expect(shown(agentPage())).toBe(true)
    expect(title().textContent).toBe('unslop-code')
    expect(agentPage().querySelector('.map-gone')?.textContent).toBe('Turned on. Its details show in a moment.')
    // not asked while the agent is not in the data yet
    expect(mesh.s.triggers.filter((t) => t.startsWith('refresh'))).toEqual([])
    expect(document.activeElement).toBe(agentPage().querySelector('.map-back'))
    mesh.s.body = { on: true, agents: [on('unslop-code', { state: 'unchecked', reason: 'press Refresh' })], others: 0, available: [OFFERED['unslop']!, OFFERED['request-post']!] }
    await pollTick()
    expect(shown(agentPage().querySelector('.map-gone'))).toBe(false)
    expect(agentPage().querySelector('.map-status')?.textContent).toBe('Not checked yet · press Refresh')
    // F3: once the agent shows in the data it is checked, once, without a press on Refresh
    await settle()
    expect(mesh.s.triggers.filter((t) => t === 'refresh unslop-code')).toEqual(['refresh unslop-code'])
    await pollTick()
    await pollTick()
    expect(mesh.s.triggers.filter((t) => t === 'refresh unslop-code')).toHaveLength(1)
    expect(shown(agentPage().querySelector('.ms-foot'))).toBe(true)
  })

  it('a server that cannot be asked gives a field to type the model in, with why', async () => {
    const { bridge } = await boot({ bridge: { servers: [server('local'), server('lab')] } })
    await enter()
    click(offer('unslop-code')!.querySelector('.ma-description'))
    await settle()
    // two servers: none is chosen for the person
    expect(select('server').value).toBe('')
    expect(bridge.ops()).toEqual([])
    bridge.s.answers['check-server'] = () => checked('unreachable')
    choose(select('server'), 'lab')
    await settle()
    expect(shown(select('model'))).toBe(false)
    expect(shown(field('model'))).toBe(true)
    expect(setup().querySelector('.ms-model-why')?.textContent).toBe('The server did not answer.')
    expect(document.activeElement).toBe(field('model'))
    type(field('model'), 'qwen3-coder:30b')
    click(buttonLabelled('Check', setup()))
    await settle()
    expect(bridge.ops().at(-1)).toEqual(['enable-model-agent', { agent: 'unslop-code', server: 'lab', model: 'qwen3-coder:30b', apply: false }])
  })

  it('a server whose key the app cannot read still sets up: the model is typed, and the line says why', async () => {
    const { bridge } = await boot({ bridge: { servers: [server('local'), server('lab', { key: 'command' })] } })
    await enter()
    click(offer('unslop-code')!.querySelector('.ma-description'))
    await settle()
    bridge.s.answers['check-server'] = () => checked('key')
    choose(select('server'), 'lab')
    await settle()
    expect(shown(select('model'))).toBe(false)
    expect(shown(field('model'))).toBe(true)
    expect(setup().querySelector('.ms-model-why')?.textContent).toBe('The command gave no key. The app runs it without your terminal’s settings (docs/model-servers.md).')
    expect(document.activeElement).toBe(field('model'))
    type(field('model'), 'coder-next')
    click(buttonLabelled('Check', setup()))
    await settle()
    expect(bridge.ops().at(-1)).toEqual(['enable-model-agent', { agent: 'unslop-code', server: 'lab', model: 'coder-next', apply: false }])
  })

  it('while the models are asked the list says so; a server with none lists none', async () => {
    const { bridge } = await boot({ bridge: { servers: [server('local')] } })
    await enter()
    const release = bridge.hold()
    click(buttonLabelled('Set up', offer('unslop-code')!))
    await settle()
    expect([...select('model').options].map((o) => o.textContent)).toEqual(['asking the server…'])
    expect(select('model').disabled).toBe(true)
    bridge.s.answers['check-server'] = () => checked(undefined, [])
    release()
    await settle()
    expect(shown(field('model'))).toBe(true)
    expect(setup().querySelector('.ms-model-why')?.textContent).toBe('The server lists no models.')
  })

  it('Add a server… in the list opens the server page and comes back with the new server chosen', async () => {
    const { bridge } = await boot()
    await enter()
    click(buttonLabelled('Set up', offer('unslop-code')!))
    await settle()
    expect([...select('server').options].map((o) => o.textContent)).toEqual(['Choose a server', 'Add a server…'])
    choose(select('server'), select('server').options[1]!.value)
    await settle()
    expect(title().textContent).toBe('Add a model server')
    expect(setup().querySelector('.map-back')?.textContent).toBe('← unslop-code')
    type(field('name'), 'local')
    type(field('baseUrl'), 'http://127.0.0.1:8080')
    bridge.s.servers = [server('local')]
    click(buttonLabelled('Save', setup()))
    await settle()
    expect(title().textContent).toBe('unslop-code')
    expect(select('server').value).toBe('local')
    expect([...select('model').options].map((o) => o.textContent)).toEqual(['Choose a model', 'model-a', 'model-b'])
    expect(bridge.ops().map(([op]) => op)).toEqual(['add-server', 'add-server', 'check-server'])
  })

  it('a refusal replaces the steps with its words and offers only Back, which returns to the form', async () => {
    const { bridge } = await boot({ bridge: { servers: [server('local')] } })
    await enter()
    click(buttonLabelled('Set up', offer('unslop-code')!))
    await settle()
    choose(select('model'), 'model-a')
    bridge.s.answers['enable-model-agent'] = () => ({ ok: false, applied: false, steps: ['never shown'], refused: 'unslop-code is already on' })
    click(buttonLabelled('Check', setup()))
    await settle()
    const review = setup().querySelector<HTMLElement>('.ms-review')!
    expect(review.querySelector('.ms-refused')?.textContent).toBe('unslop-code is already on')
    expect(shown(review.querySelector('.ms-steps'))).toBe(false)
    expect(shown(review.querySelector('.ms-nothing'))).toBe(false)
    expect(shown(review.querySelector('.ms-exact'))).toBe(false)
    expect(shown(review.querySelector('.ms-review-title'))).toBe(false)
    expect(shown(buttonLabelled('Turn on', review))).toBe(false)
    expect(document.activeElement).toBe(buttonLabelled('Back', review))
    click(buttonLabelled('Back', review))
    await settle()
    expect(shown(review)).toBe(false)
    expect(select('model').disabled).toBe(false)
    expect(document.activeElement).toBe(buttonLabelled('Check', setup()))
  })

  it('request-post: the service address and the token file, by its name only', async () => {
    const { bridge } = await boot()
    await enter()
    click(buttonLabelled('Set up', offer('request-post')!))
    await settle()
    expect(title().textContent).toBe('request-post')
    expect(document.activeElement).toBe(field('endpoint'))
    bridge.s.file = { ok: true, handle: HANDLE, name: 'publish.token' }
    click(buttonLabelled('Check', setup()))
    await settle()
    expect(message().textContent).toBe('Enter the service’s address, starting with http:// or https://.')
    type(field('endpoint'), 'https://publish.example.ts.net')
    click(buttonLabelled('Check', setup()))
    await settle()
    expect(message().textContent).toBe('Choose the token file.')
    click(buttonLabelled('Choose file…', setup()))
    await settle()
    expect(bridge.s.picks).toEqual(['token'])
    expect(setup().querySelector('.ms-file-name')?.textContent).toBe('publish.token')
    expect(document.body.innerHTML).not.toContain(HANDLE)
    click(buttonLabelled('Check', setup()))
    await settle()
    expect(setup().querySelector('.ms-review-title')?.textContent).toBe('Turning it on will')
    expect([...setup().querySelectorAll('.ms-steps li')].map((li) => li.textContent)).toEqual([
      'Keep a private copy of the token.',
      'Add the command that you and your chats run.',
      'Add request-post to your agents.',
    ])
    click(buttonLabelled('Turn on', setup()))
    await settle()
    expect(bridge.ops()).toEqual([
      ['enable-request-post', { endpoint: 'https://publish.example.ts.net', token: HANDLE, apply: false }],
      ['enable-request-post', { endpoint: 'https://publish.example.ts.net', token: HANDLE, apply: true }],
    ])
    expect(shown(agentPage())).toBe(true)
  })

  it('a cancelled file choice says nothing and keeps the form', async () => {
    const { bridge } = await boot()
    await enter()
    click(buttonLabelled('Set up', offer('request-post')!))
    await settle()
    type(field('endpoint'), 'https://publish.example.ts.net')
    bridge.s.file = { ok: false, reason: 'cancelled' }
    click(buttonLabelled('Choose file…', setup()))
    await settle()
    expect(shown(message())).toBe(false)
    expect(field('endpoint')!.value).toBe('https://publish.example.ts.net')
    expect(document.activeElement).toBe(buttonLabelled('Choose file…', setup()))
  })
})

describe('setting up an agent on a Claude Code server (Claude Code D4)', () => {
  const options = () => [...select('model').options].map((o) => o.textContent)
  const why = () => setup().querySelector<HTMLElement>('.ms-model-why')!

  it('the models are haiku, sonnet and opus in that order, whatever order the check answers', async () => {
    const { bridge } = await boot({ bridge: { servers: [claudeServer('claude')] } })
    bridge.s.answers['check-server'] = () => checkedClaude()
    await enter()
    click(buttonLabelled('Set up', offer('unslop-code')!))
    await settle()
    expect(select('server').value).toBe('claude')
    expect(bridge.ops()).toEqual([['check-server', { name: 'claude' }]])
    expect(options()).toEqual(['Choose a model', 'haiku', 'sonnet', 'opus'])
    expect([shown(select('model')), shown(field('model')), shown(why())]).toEqual([true, false, false])
    choose(select('model'), 'opus')
    click(buttonLabelled('Check', setup()))
    await settle()
    expect([...setup().querySelectorAll('.ms-steps li')].map((li) => li.textContent)[0]).toBe('Save its settings: server claude, model opus.')
    expect(bridge.ops().at(-1)).toEqual(['enable-model-agent', { agent: 'unslop-code', server: 'claude', model: 'opus', apply: false }])
  })

  it.each([
    ['no-program', () => checkedClaude('no-program'), 'Claude Code was not found on this Mac.'],
    ['signed-out', () => checkedClaude('signed-out'), 'Claude Code is not signed in, or could not start from the app. Run claude in a terminal and sign in.'],
    ['timeout', () => checkedClaude('timeout'), 'Claude Code did not answer in time.'],
    ['timeout with no kind named', () => checkedClaude('timeout', { kind: false }), 'Claude Code did not answer in time.'],
    ['a bridge reason', () => ({ ok: false, reason: 'timeout' }), 'The command did not answer in time.'],
    ['a refusal', () => meshProcess.meshAnswer('check', JSON.stringify({ server: 'claude', refused: 'the server claude is not in servers.json' }), 1) as Json, 'the server claude is not in servers.json'],
  ] as Array<[string, () => Json, string]>)('a check that fails (%s) still offers the three, with its own words under the list; the person picks one and goes on', async (_label, answer, words) => {
    const { bridge } = await boot({ bridge: { servers: [claudeServer('claude'), server('lab')] } })
    await enter()
    click(offer('unslop-code')!.querySelector('.ma-description'))
    await settle()
    bridge.s.answers['check-server'] = answer
    choose(select('server'), 'claude')
    await settle()
    expect(options()).toEqual(['Choose a model', 'haiku', 'sonnet', 'opus'])
    expect([shown(select('model')), shown(field('model'))]).toEqual([true, false])
    expect(why().textContent).toBe(words)
    expect(shown(why())).toBe(true)
    expect(select('model').disabled).toBe(false)
    expect(document.activeElement).toBe(select('model'))
    choose(select('model'), 'sonnet')
    click(buttonLabelled('Check', setup()))
    await settle()
    expect(bridge.ops().at(-1)).toEqual(['enable-model-agent', { agent: 'unslop-code', server: 'claude', model: 'sonnet', apply: false }])
    expect(shown(setup().querySelector('.ms-review'))).toBe(true)
    // the row says the same, back on the home
    click(buttonLabelled('Back', setup().querySelector('.ms-review')!))
    await settle()
    click(setup().querySelector('.map-back'))
    await settle()
    expect(row('claude')!.querySelector('.ms-row-note')?.textContent).toBe(words)
  })

  it('an address server’s failed check still gives the typed field: the fixed list is Claude Code’s only', async () => {
    const { bridge } = await boot({ bridge: { servers: [claudeServer('claude'), server('lab')] } })
    await enter()
    click(offer('unslop-code')!.querySelector('.ma-description'))
    await settle()
    bridge.s.answers['check-server'] = () => checked('timeout')
    choose(select('server'), 'lab')
    await settle()
    expect([shown(select('model')), shown(field('model'))]).toEqual([false, true])
    expect(why().textContent).toBe('The server did not answer in time.')
    // and a list from an address server keeps its own names, in its own order
    bridge.s.answers['check-server'] = () => checked(undefined, ['opus', 'haiku'])
    choose(select('server'), 'claude')
    await settle()
    bridge.s.answers['check-server'] = () => checked(undefined, ['zeta', 'alpha'])
    choose(select('server'), 'lab')
    await settle()
    expect(options()).toEqual(['Choose a model', 'zeta', 'alpha'])
    expect(shown(why())).toBe(false)
  })

  it('the typed model field follows a server change: an old typed name never shows under a new server (U4)', async () => {
    const { bridge } = await boot({ bridge: { servers: [claudeServer('claude'), server('lab')] } })
    await enter()
    click(offer('unslop-code')!.querySelector('.ma-description'))
    await settle()
    bridge.s.answers['check-server'] = () => checked('unreachable')
    choose(select('server'), 'lab')
    await settle()
    type(field('model'), 'foo')
    bridge.s.answers['check-server'] = () => checkedClaude()
    choose(select('server'), 'claude')
    await settle()
    bridge.s.answers['check-server'] = () => checked('unreachable')
    choose(select('server'), 'lab')
    await settle()
    expect(shown(field('model'))).toBe(true)
    expect(field('model')!.value).toBe('')
    click(buttonLabelled('Check', setup()))
    await settle()
    expect(message().textContent).toBe('Type the model’s name.')
  })

  it('Change server on an agent that uses a Claude Code server: its server chosen, the three models, and the change runs (U6)', async () => {
    const { bridge } = await boot({
      agents: [on('unslop-code', { model: 'sonnet' })], available: [OFFERED['unslop']!],
      bridge: { servers: [claudeServer('claude', { agents: ['unslop-code'] }), server('lab')] },
    })
    bridge.s.answers['check-server'] = () => checkedClaude()
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await enter()
    click(card('unslop-code'))
    await settle()
    click(buttonLabelled('Change server', agentPage().querySelector('.ms-foot')!))
    await settle()
    expect(select('server').value).toBe('claude')
    expect(options()).toEqual(['Choose a model', 'haiku', 'sonnet', 'opus'])
    expect(shown(why())).toBe(false)
    choose(select('model'), 'sonnet')
    click(buttonLabelled('Check', setup()))
    await settle()
    expect([...setup().querySelectorAll('.ms-steps li')].map((li) => li.textContent)).toEqual([
      'Point unslop-code at server claude, model sonnet.',
      'Keep a backup of its old settings.',
    ])
    click(buttonLabelled('Change server', setup()))
    await settle()
    expect(bridge.ops()).toEqual([
      ['check-server', { name: 'claude' }],
      ['enable-model-agent', { agent: 'unslop-code', server: 'claude', model: 'sonnet', apply: false }],
      ['enable-model-agent', { agent: 'unslop-code', server: 'claude', model: 'sonnet', apply: true }],
    ])
    expect(shown(agentPage())).toBe(true)
  })

  it('Add a server… from the form adds a Claude Code server and comes back with it chosen and its three models', async () => {
    const { bridge } = await boot()
    await enter()
    click(buttonLabelled('Set up', offer('unslop-code')!))
    await settle()
    choose(select('server'), select('server').options[1]!.value)
    await settle()
    const claude = setup().querySelector<HTMLInputElement>('input[name="msKind"][value="claude-code"]')!
    claude.checked = true
    claude.dispatchEvent(new window.Event('change', { bubbles: true }))
    await settle()
    type(field('name'), 'claude')
    bridge.s.servers = [claudeServer('claude')]
    bridge.s.answers['check-server'] = () => checkedClaude()
    click(buttonLabelled('Save', setup()))
    await settle()
    expect(title().textContent).toBe('unslop-code')
    expect(select('server').value).toBe('claude')
    expect(options()).toEqual(['Choose a model', 'haiku', 'sonnet', 'opus'])
    expect(bridge.ops().map(([op]) => op)).toEqual(['add-claude-server', 'add-claude-server', 'check-server'])
  })
})

describe('adding an agent by its card address (add step 2, D3 and D4)', () => {
  const ADDRESS = 'https://studio.tailnet-example.ts.net/pdf/.well-known/agent-card.json'
  const LOCAL = 'http://127.0.0.1:9000/.well-known/agent-card.json'
  const addButton = () => buttonLabelled('Add by address', document.querySelector('.ms-market .ma-head')!)!
  const summary = () => setup().querySelector<HTMLElement>('.ms-card')!
  const facts = () => [...summary().querySelectorAll('dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent])
  const tokenField = () => setup().querySelector<HTMLElement>('.ms-token')!
  async function openPage(over: Parameters<typeof boot>[0] = {}) {
    const booted = await boot(over)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await enter()
    click(addButton())
    await settle()
    return booted
  }
  async function check(address = ADDRESS) {
    type(field('address'), address)
    click(buttonLabelled('Check', setup()))
    await settle()
  }

  it('opens in the tab: its title, ← Agent cards, the Card address field with focus, and no token field for an https address', async () => {
    const { bridge } = await openPage()
    expect(shown(setup())).toBe(true)
    expect(title().textContent).toBe('Add an agent')
    expect(setup().querySelector('form')?.getAttribute('aria-label')).toBe('Add an agent')
    expect(setup().querySelector('.map-back')?.textContent).toBe('← Agent cards')
    expect(setup().querySelector('.ms-field .ms-label')?.textContent).toBe('Card address')
    expect(document.activeElement).toBe(field('address'))
    expect(shown(tokenField())).toBe(false)
    type(field('address'), ADDRESS)
    await settle()
    expect(shown(tokenField())).toBe(false)
    expect(shown(buttonLabelled('Check', setup()))).toBe(true)
    expect(bridge.ops()).toEqual([])
  })

  it('the token file shows while the address is on this Mac, and the field is not rebuilt while typing', async () => {
    await openPage()
    const address = field('address')!
    address.focus()
    type(address, 'http://127.0.0.1:9000/')
    await settle()
    expect(shown(tokenField())).toBe(true)
    expect(tokenField().querySelector('.ms-label')?.textContent).toBe('Token file')
    expect(tokenField().querySelector('.ms-hint')?.textContent).toBe('An agent on this Mac needs its token file.')
    expect(shown(buttonLabelled('Choose file…', tokenField()))).toBe(true)
    expect(field('address')).toBe(address)
    expect(document.activeElement).toBe(address)
    type(address, 'https://hub.example.ts.net/')
    await settle()
    expect(shown(tokenField())).toBe(false)
    expect(field('address')).toBe(address)
  })

  it('says what is wrong before running anything: an address that is neither https:// nor this Mac’s, a loopback address with no file', async () => {
    const { bridge } = await openPage()
    for (const address of ['', 'ftp://example.org/card', 'http://example.org/card', 'studio.tailnet-example.ts.net']) {
      type(field('address'), address)
      click(buttonLabelled('Check', setup()))
      await settle()
      expect(message().textContent, address).toBe('Enter the card’s address, starting with https:// (or http://127.0.0.1: for an agent on this Mac).')
      expect(document.activeElement).toBe(field('address'))
    }
    await check(LOCAL)
    expect(message().textContent).toBe('Choose the token file.')
    expect(bridge.ops()).toEqual([])
  })

  it('Check shows the card as the drawing does: quoted card text, the page’s own words, Nothing has changed yet, Add and Back, focus on Add', async () => {
    const { bridge } = await openPage()
    await check(`  ${ADDRESS} `)
    expect(bridge.ops()).toEqual([['check-agent', { address: ADDRESS }]])
    expect(shown(summary())).toBe(true)
    expect(summary().querySelector('.ms-card-title')?.textContent).toBe('“pdf-reader”')
    expect(facts()).toEqual([
      ['What it does', '“Reads a PDF and answers questions about it.”'],
      ['Publisher', '“Example Labs”'],
      ['Where it runs', 'On your tailnet. What you send it stays on your own machines.'],
      ['Card', 'Signed by its publisher. Trusted from now on if you add it.'],
      ['Skills', '“read”, “ask”'],
      ['Name here', 'pdf-reader'],
    ])
    expect(summary().querySelector('.ms-card-note')?.textContent).toBe('Text in quotes comes from the card and is unverified.')
    expect(shown(setup().querySelector('.ms-nothing'))).toBe(true)
    expect(setup().querySelector('.ms-nothing')?.textContent).toBe('Nothing has changed yet.')
    const review = setup().querySelector<HTMLElement>('.ms-review')!
    expect([...review.querySelectorAll<HTMLButtonElement>('.ms-actions button')].filter(shown).map((b) => b.textContent)).toEqual(['Add', 'Back'])
    expect(document.activeElement).toBe(buttonLabelled('Add', review))
    // the page's own summary only: no Turn on heading, no step list; the command's lines closed under it
    expect(review.querySelector('.ms-review-title')).toBeNull()
    expect(review.querySelector('.ms-steps')).toBeNull()
    const exact = review.querySelector<HTMLDetailsElement>('.ms-exact')!
    expect(shown(exact)).toBe(true)
    expect(exact.open).toBe(false)
    expect([...exact.querySelectorAll('li')].map((li) => li.textContent)).toEqual(CHECK_STEPS)
    // while the review shows, the address field is disabled; the version is never shown
    expect(field('address')!.disabled).toBe(true)
    expect(summary().textContent).not.toContain('1.0.0')
    expect(summary().textContent).not.toContain('studio.tailnet-example.ts.net')
  })

  it.each([
    ['public', true, true, 'On the internet. What you send it leaves this Mac.', 'Signed by its publisher. Trusted from now on if you add it.'],
    ['tailnet', true, false, 'On your tailnet. What you send it stays on your own machines.', 'Signed by its publisher, with a key this Mac already trusts.'],
    ['tailnet', true, undefined, 'On your tailnet. What you send it stays on your own machines.', 'Signed by its publisher.'],
    ['tailnet', false, undefined, 'On your tailnet. What you send it stays on your own machines.', 'Not signed. Allowed only for an agent on this Mac or your tailnet.'],
  ] as const)('where it runs (%s) and its card (signed %s, new key %s) in the page’s words', async (reach, signed, keysNew, where, cardWords) => {
    const { bridge } = await openPage()
    const endpoint = reach === 'public' ? 'https://agents.example.org/pdf/a2a' : CARD['endpoint']
    bridge.s.answers['check-agent'] = () => carded({ card: { ...CARD, reach, endpoint, signed, keysNew } })
    await check()
    expect(Object.fromEntries(facts())).toMatchObject({ 'Where it runs': where, Card: cardWords })
  })

  it('an agent on this Mac: its words, and the token file goes with the check and the add', async () => {
    const { bridge } = await openPage()
    bridge.s.file = { ok: true, handle: HANDLE, name: 'echo.token' }
    type(field('address'), LOCAL)
    await settle()
    click(buttonLabelled('Choose file…', setup()))
    await settle()
    expect(bridge.s.picks).toEqual(['token'])
    expect(setup().querySelector('.ms-file-name')?.textContent).toBe('echo.token')
    click(buttonLabelled('Check', setup()))
    await settle()
    expect(Object.fromEntries(facts())).toMatchObject({ 'Where it runs': 'On this Mac. What you send it stays on this Mac.', Card: 'Not signed. Allowed only for an agent on this Mac or your tailnet.' })
    expect(buttonLabelled('Choose file…', setup())!.disabled).toBe(true)
    click(buttonLabelled('Add', setup()))
    await settle()
    expect(bridge.ops()).toEqual([
      ['check-agent', { address: LOCAL, token: HANDLE }],
      ['add-agent', { address: LOCAL, token: HANDLE, id: 'pdf-reader', pin: PIN, apply: true }],
    ])
    expect(document.body.innerHTML).not.toContain(HANDLE)
  })

  it('missing card text has the page’s own words; a skill goes by its name, else its id', async () => {
    const { bridge } = await openPage()
    const { name: _n, description: _d, publisher: _p, ...bare } = CARD
    bridge.s.answers['check-agent'] = () => carded({ card: { ...bare, skills: [] } })
    await check()
    expect(summary().querySelector('.ms-card-title')?.textContent).toBe('No name given')
    expect(Object.fromEntries(facts())).toMatchObject({ 'What it does': 'Not given', Publisher: 'Not given', Skills: 'None listed', 'Name here': 'pdf-reader' })
    click(buttonLabelled('Back', setup()))
    await settle()
    bridge.s.answers['check-agent'] = () => carded({ card: { ...CARD, skills: [{ id: 'read' }, { id: 'ask', name: 'Ask a question' }] } })
    click(buttonLabelled('Check', setup()))
    await settle()
    expect(Object.fromEntries(facts())['Skills']).toBe('“read”, “Ask a question”')
  })

  it('Add runs add-agent once with the checked id and pin; the new agent’s page opens, says it was added, and the tab reads again', async () => {
    const { bridge, mesh } = await openPage()
    await check()
    const added = agent('pdf-reader', { kind: 'added', where: 'tailnet', endpoint: CARD['endpoint'], state: 'added', checkedAt: null })
    const reads = mesh.s.triggers.length
    click(buttonLabelled('Add', setup()))
    await settle()
    expect(bridge.ops()).toEqual([
      ['check-agent', { address: ADDRESS }],
      ['add-agent', { address: ADDRESS, id: 'pdf-reader', pin: PIN, apply: true }],
    ])
    expect(shown(setup())).toBe(false)
    expect(shown(agentPage())).toBe(true)
    expect(title().textContent).toBe('pdf-reader')
    expect(agentPage().querySelector('.map-gone')?.textContent).toBe('Added. Its details show in a moment.')
    expect(shown(agentPage().querySelector('.map-gone'))).toBe(true)
    expect(document.activeElement).toBe(agentPage().querySelector('.map-back'))
    // the app never checks an added agent: no refresh of it
    expect(mesh.s.triggers.slice(reads).filter((t) => t.startsWith('refresh'))).toEqual([])
    mesh.s.version = { agents: 1 }
    mesh.s.body = { on: true, agents: [added], others: 0, available: [] }
    await pollTick()
    await settle()
    expect(shown(agentPage().querySelector('.map-gone'))).toBe(false)
    expect(agentPage().querySelector('.map-badge')?.textContent).toBe('Added by you')
    expect(mesh.s.triggers.filter((t) => t.startsWith('refresh'))).toEqual([])
  })

  it('card text with markup, quote marks or 300 characters with no space shows as quoted text, makes no element, and wraps', async () => {
    const { bridge } = await openPage()
    const long = 'x'.repeat(300)
    bridge.s.answers['check-agent'] = () => carded({ card: {
      ...CARD, name: '<img src=x onerror=alert(1)>', description: `“quoted” "and" ${long}`, publisher: '<a href="https://example.org">Example</a>',
      skills: [{ id: 'read', name: '<script>alert(1)</script>' }, { id: long }],
    } })
    await check()
    expect(summary().querySelector('.ms-card-title')?.textContent).toBe('“<img src=x onerror=alert(1)>”')
    expect(Object.fromEntries(facts())).toMatchObject({
      'What it does': `““quoted” "and" ${long}”`,
      Publisher: '“<a href="https://example.org">Example</a>”',
      // the bridge cuts a skill's id to 162 units (the command's own cap is shorter still)
      Skills: `“<script>alert(1)</script>”, “${'x'.repeat(162)}”`,
    })
    expect(setup().querySelector('img, script, a, [href], [src], [style], [onerror]')).toBeNull()
    // no attribute anywhere under the summary is made from card text
    const texts = ['<img src=x onerror=alert(1)>', '“quoted” "and"', long, 'Example</a>', '<script>alert(1)</script>']
    for (const el of [summary(), ...summary().querySelectorAll('*')]) {
      for (const attr of el.attributes) for (const text of texts) expect(attr.value, `${el.tagName} ${attr.name}`).not.toContain(text)
    }
    const css = readFileSync(resolve(import.meta.dirname, '..', '..', 'public', 'style.css'), 'utf8')
    const mine = css.slice(css.indexOf('agent setup in the app (step 2b)'), css.indexOf('/* Run history (cards view V5d)'))
    // every part of the summary wraps anywhere: nothing scrolls sideways at 400 px
    expect(mine).toMatch(/\.ms-card \{[^}]*overflow-wrap: anywhere/)
    expect(mine).toMatch(/\.ms-facts dd \{[^}]*min-width: 0[^}]*overflow-wrap: anywhere/)
    expect(mine).toMatch(/\.ms-facts \{[^}]*grid-template-columns: minmax\(0, max-content\) minmax\(0, 1fr\)/)
  })

  it('a card that changed between Check and Add: the command’s words, nothing added, Back keeps the form, a new Check shows the new card', async () => {
    const { bridge } = await openPage({ bridge: {} })
    bridge.s.file = { ok: true, handle: HANDLE, name: 'echo.token' }
    type(field('address'), LOCAL)
    await settle()
    click(buttonLabelled('Choose file…', setup()))
    await settle()
    click(buttonLabelled('Check', setup()))
    await settle()
    const changed = 'the card is not the one that was checked (its pin differs): check it again. Nothing changed.'
    const newCard = { ...LOCAL_CARD, name: 'pdf-reader-2', description: 'Reads PDFs, now with tables.', pin: 'a'.repeat(64) }
    bridge.s.answers['add-agent'] = () => carded({ card: newCard, refused: changed })
    click(buttonLabelled('Add', setup()))
    await settle()
    const review = setup().querySelector<HTMLElement>('.ms-review')!
    expect(review.querySelector('.ms-refused')?.textContent).toBe(changed)
    expect(shown(summary())).toBe(false)
    expect(shown(review.querySelector('.ms-nothing'))).toBe(false)
    expect([...review.querySelectorAll<HTMLButtonElement>('.ms-actions button')].filter(shown).map((b) => b.textContent)).toEqual(['Back'])
    expect(document.activeElement).toBe(buttonLabelled('Back', review))
    expect(shown(setup().querySelector('.ms-for-terminal'))).toBe(false)
    expect(shown(agentPage())).toBe(false)
    click(buttonLabelled('Back', review))
    await settle()
    expect(field('address')!.value).toBe(LOCAL)
    expect(setup().querySelector('.ms-file-name')?.textContent).toBe('echo.token')
    expect(document.activeElement).toBe(buttonLabelled('Check', setup()))
    bridge.s.answers['check-agent'] = () => carded({ card: newCard })
    click(buttonLabelled('Check', setup()))
    await settle()
    expect(summary().querySelector('.ms-card-title')?.textContent).toBe('“pdf-reader-2”')
    expect(Object.fromEntries(facts())['What it does']).toBe('“Reads PDFs, now with tables.”')
    delete bridge.s.answers['add-agent']
    click(buttonLabelled('Add', setup()))
    await settle()
    expect(bridge.ops().map(([op, values]) => [op, values['pin']])).toEqual([
      ['check-agent', undefined], ['add-agent', PIN], ['check-agent', undefined], ['add-agent', 'a'.repeat(64)],
    ])
  })

  it('an agent already added says so in one sentence, in all three shapes: Back only, no summary, no Add, no terminal line, nothing runs', async () => {
    const { bridge } = await openPage()
    const cases: Array<[string, Json]> = [
      // (i) the same card at the address the entry already holds: nothing to do
      ['the same address', carded({ steps: [], notes: [`agents.pdf-reader is already at ${ADDRESS}. Nothing to do.`] })],
      // (ii) a signed card of an agent added at another address: the command plans a move
      ['a move', carded({ notes: ['Move       this is pdf-reader at a new endpoint (was https://hub.example.ts.net/a2a), signed by a key its pinned card lists.'] })],
      // (iii) the command's refusal for a card that declares an agent id an entry holds, as the command words it
      ['an unsigned card of an added agent', carded({ refused: `${heldIdRefusal('pdf-reader', false)}. Nothing changed.` })],
      ['a card signed by another key', carded({ refused: `${heldIdRefusal('pdf-reader', true)}. Nothing changed.` })],
    ]
    for (const [label, answer] of cases) {
      bridge.s.answers['check-agent'] = () => answer
      if (!field('address')!.value) type(field('address'), ADDRESS)
      click(buttonLabelled('Check', setup()))
      await settle()
      const review = setup().querySelector<HTMLElement>('.ms-review')!
      expect(review.querySelector('.ms-refused')?.textContent, label).toBe('This agent is already added as pdf-reader.')
      expect(shown(summary()), label).toBe(false)
      expect(shown(review.querySelector('.ms-for-terminal')), label).toBe(false)
      expect([...review.querySelectorAll<HTMLButtonElement>('.ms-actions button')].filter(shown).map((b) => b.textContent)).toEqual(['Back'])
      expect(document.activeElement).toBe(buttonLabelled('Back', review))
      // Add is hidden; even a forced press of it runs nothing
      buttonLabelled('Add', review)!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await settle()
      click(buttonLabelled('Back', review))
      await settle()
    }
    expect(bridge.ops().map(([op]) => op)).toEqual(['check-agent', 'check-agent', 'check-agent', 'check-agent'])
  })

  it('reads the holder from the command’s own sentence, built by the command’s own code', async () => {
    const { bridge } = await openPage()
    for (const holder of ['echo', 'a', 'my--agent', 'x'.repeat(40)]) {
      for (const signed of [false, true]) {
        bridge.s.answers['check-agent'] = () => carded({ refused: `${heldIdRefusal(holder, signed)}. Nothing changed.` })
        if (!field('address')!.value) type(field('address'), ADDRESS)
        click(buttonLabelled('Check', setup()))
        await settle()
        expect(setup().querySelector('.ms-refused')?.textContent, `${holder} ${signed}`).toBe(`This agent is already added as ${holder}.`)
        click(buttonLabelled('Back', setup().querySelector('.ms-review')!))
        await settle()
      }
    }
  })

  it('a refusal that only looks like it, or a taken derived id, shows the command’s words as they are', async () => {
    const { bridge } = await openPage()
    const verbatim = [
      'the id pdf-reader is already in ~/.agent-inbox/mesh.json, and add never replaces an entry. Nothing changed.',
      'the card declares the agent id that agents.Bad_ID holds, so it is that agent: to move it here, add --move it. Nothing changed.',
      'note: the card declares the agent id that agents.echo holds, so it is that agent. Nothing changed.',
    ]
    for (const words of verbatim) {
      bridge.s.answers['check-agent'] = () => carded({ refused: words })
      if (!field('address')!.value) type(field('address'), ADDRESS)
      click(buttonLabelled('Check', setup()))
      await settle()
      expect(setup().querySelector('.ms-refused')?.textContent).toBe(words)
      click(buttonLabelled('Back', setup().querySelector('.ms-review')!))
      await settle()
    }
  })

  it('the terminal line goes by where the words came from: never under the page’s own sentence, even for an id holding --', async () => {
    const { bridge } = await openPage()
    const terminalLine = () => setup().querySelector<HTMLElement>('.ms-for-terminal')!
    const cases: Array<[Json, string, boolean]> = [
      [carded({ card: { ...CARD, id: 'my--agent' }, steps: [], notes: ['Nothing to do.'] }), 'This agent is already added as my--agent.', false],
      [carded({ card: { ...CARD, id: 'my--agent' }, notes: ['Move       this is my--agent at a new endpoint.'] }), 'This agent is already added as my--agent.', false],
      [carded({ refused: `${heldIdRefusal('my--agent', false)}. Nothing changed.` }), 'This agent is already added as my--agent.', false],
      [carded({ card: { ...CARD, id: undefined }, refused: 'the card’s name makes no usable id: pass --id <id>. Nothing changed.' }), 'the card’s name makes no usable id: pass --id <id>. Nothing changed.', true],
    ]
    for (const [answer, words, terminal] of cases) {
      bridge.s.answers['check-agent'] = () => answer
      if (!field('address')!.value) type(field('address'), ADDRESS)
      click(buttonLabelled('Check', setup()))
      await settle()
      expect(setup().querySelector('.ms-refused')?.textContent).toBe(words)
      expect(shown(terminalLine()), words).toBe(terminal)
      click(buttonLabelled('Back', setup().querySelector('.ms-review')!))
      await settle()
    }
  })

  it('a refusal naming an option the page does not have gets one quiet line pointing to a terminal; no other refusal does', async () => {
    const { bridge } = await openPage()
    const terminalLine = () => setup().querySelector<HTMLElement>('.ms-for-terminal')!
    bridge.s.answers['check-agent'] = () => carded({ card: { ...CARD, id: undefined }, refused: 'the card’s name makes no usable id: pass --id <id>. Nothing changed.' })
    await check()
    expect(setup().querySelector('.ms-refused')?.textContent).toBe('the card’s name makes no usable id: pass --id <id>. Nothing changed.')
    expect(terminalLine().textContent).toBe('That option is for a terminal. Add this agent there instead.')
    expect(shown(terminalLine())).toBe(true)
    click(buttonLabelled('Back', setup().querySelector('.ms-review')!))
    await settle()
    bridge.s.answers['check-agent'] = () => carded({ card: null, refused: 'the card could not be fetched. Nothing changed.' })
    click(buttonLabelled('Check', setup()))
    await settle()
    expect(setup().querySelector('.ms-refused')?.textContent).toBe('the card could not be fetched. Nothing changed.')
    expect(shown(terminalLine())).toBe(false)
  })

  it('an address the bridge will not take says so under the field, with focus on it; every other problem is the review’s', async () => {
    const { bridge } = await openPage()
    bridge.s.answers['check-agent'] = () => ({ ok: false, reason: 'invalid' })
    await check('https://Studio.example.org/card?x=1')
    expect(message().textContent).toBe('This address cannot be added here. Use https:// on a name, or http://127.0.0.1 with a port, with no query or fragment.')
    expect(shown(setup().querySelector('.ms-review'))).toBe(false)
    expect(document.activeElement).toBe(field('address'))
    expect(field('address')!.disabled).toBe(false)
    bridge.s.answers['check-agent'] = () => ({ ok: false, reason: 'timeout' })
    click(buttonLabelled('Check', setup()))
    await settle()
    expect(shown(message())).toBe(false)
    expect(setup().querySelector('.ms-refused')?.textContent).toBe('The command did not answer in time.')
    expect(document.activeElement).toBe(buttonLabelled('Back', setup().querySelector('.ms-review')!))
    expect(bridge.ops()).toHaveLength(2)
  })

  it('a token file whose handle has expired is cleared: the form shows no file and asks for it again', async () => {
    const { bridge } = await openPage()
    bridge.s.file = { ok: true, handle: HANDLE, name: 'echo.token' }
    const fileName = () => setup().querySelector<HTMLElement>('.ms-file-name')!
    // at Check
    type(field('address'), LOCAL)
    await settle()
    click(buttonLabelled('Choose file…', setup()))
    await settle()
    bridge.s.answers['check-agent'] = () => ({ ok: false, reason: 'handle' })
    click(buttonLabelled('Check', setup()))
    await settle()
    expect(setup().querySelector('.ms-refused')?.textContent).toBe('The chosen file is no longer held. Choose it again.')
    click(buttonLabelled('Back', setup().querySelector('.ms-review')!))
    await settle()
    expect(shown(fileName())).toBe(false)
    expect(fileName().textContent).toBe('')
    click(buttonLabelled('Check', setup()))
    await settle()
    expect(message().textContent).toBe('Choose the token file.')
    expect(bridge.ops()).toHaveLength(1)
    // at Add, after a check that worked
    delete bridge.s.answers['check-agent']
    click(buttonLabelled('Choose file…', setup()))
    await settle()
    click(buttonLabelled('Check', setup()))
    await settle()
    bridge.s.answers['add-agent'] = () => ({ ok: false, reason: 'handle' })
    click(buttonLabelled('Add', setup()))
    await settle()
    expect(setup().querySelector('.ms-refused')?.textContent).toBe('The chosen file is no longer held. Choose it again.')
    click(buttonLabelled('Back', setup().querySelector('.ms-review')!))
    await settle()
    expect(shown(fileName())).toBe(false)
    click(buttonLabelled('Check', setup()))
    await settle()
    expect(message().textContent).toBe('Choose the token file.')
    expect(bridge.ops().map(([op]) => op)).toEqual(['check-agent', 'check-agent', 'add-agent'])
  })

  it('a token file chosen for an agent on this Mac is kept while the address is not, and never sent with it', async () => {
    const { bridge } = await openPage()
    type(field('address'), LOCAL)
    await settle()
    click(buttonLabelled('Choose file…', setup()))
    await settle()
    type(field('address'), ADDRESS)
    await settle()
    expect(shown(tokenField())).toBe(false)
    click(buttonLabelled('Check', setup()))
    await settle()
    click(buttonLabelled('Add', setup()))
    await settle()
    expect(bridge.ops()).toEqual([
      ['check-agent', { address: ADDRESS }],
      ['add-agent', { address: ADDRESS, id: 'pdf-reader', pin: PIN, apply: true }],
    ])
  })

  it('a second press while a Check or an Add runs does nothing; the pressed button says so; a repaint keeps the address, the file and focus', async () => {
    const { bridge, mesh } = await openPage()
    bridge.s.file = { ok: true, handle: HANDLE, name: 'echo.token' }
    type(field('address'), LOCAL)
    await settle()
    click(buttonLabelled('Choose file…', setup()))
    await settle()
    const release = bridge.hold()
    const checkButton = buttonLabelled('Check', setup())!
    click(checkButton)
    await settle()
    expect(checkButton.textContent).toBe('Checking…')
    expect(checkButton.disabled).toBe(true)
    expect(addButton().disabled).toBe(true)
    expect(field('address')!.disabled).toBe(true)
    expect(buttonLabelled('Choose file…', setup())!.disabled).toBe(true)
    checkButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    const focused = document.activeElement
    mesh.s.version = { agents: 1 }
    mesh.s.body = { on: true, agents: [on('unslop')], others: 0, available: [OFFERED['unslop-code']!] }
    await pollTick()
    await pollTick()
    expect(field('address')!.value).toBe(LOCAL)
    expect(setup().querySelector('.ms-file-name')?.textContent).toBe('echo.token')
    expect(document.activeElement).toBe(focused)
    release()
    await settle()
    expect(bridge.ops().map(([op]) => op)).toEqual(['check-agent'])
    const hold = bridge.hold()
    const add = buttonLabelled('Add', setup())!
    click(add)
    await settle()
    expect(add.textContent).toBe('Adding…')
    expect(add.disabled).toBe(true)
    expect(buttonLabelled('Back', setup().querySelector('.ms-review')!)!.disabled).toBe(true)
    expect(addButton().disabled).toBe(true)
    add.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
    hold()
    await settle()
    expect(bridge.ops().map(([op]) => op)).toEqual(['check-agent', 'add-agent'])
  })

  it('← Agent cards goes back with focus on Add by address, and nothing was run', async () => {
    const { bridge } = await openPage()
    type(field('address'), ADDRESS)
    click(setup().querySelector('.map-back'))
    await settle()
    expect(shown(home())).toBe(true)
    expect(document.activeElement).toBe(addButton())
    expect(bridge.ops()).toEqual([])
  })

  it('without the bridge being available there is no Add by address, and the page does not open', async () => {
    await boot({ agents: [on('unslop')], available: [OFFERED['unslop-code']!], bridge: { available: { available: false, reason: 'not-installed' } } })
    await enter()
    expect(shown(document.querySelector('.ms-add-agent'))).toBe(false)
  })
})

describe('an agent that is on (D5)', () => {
  async function openAgent(name: string, servers: Json[] = []) {
    const booted = await boot({ agents: [on('unslop-code'), on('request-post', { where: 'tailnet' })], available: [OFFERED['unslop']!], bridge: { servers } })
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await enter()
    click(card(name))
    await settle()
    return booted
  }
  const foot = () => agentPage().querySelector<HTMLElement>('.ms-foot')!

  it('Turn off asks in place, Cancel keeps it, and Turn off runs disable dry then applied', async () => {
    const { bridge, mesh } = await openAgent('request-post')
    expect(shown(foot())).toBe(true)
    expect(shown(buttonLabelled('Change server', foot()))).toBe(false)
    click(buttonLabelled('Turn off', foot().querySelector('.ms-actions')!))
    await settle()
    const ask = foot().querySelector<HTMLElement>('.ms-ask')!
    expect(ask.querySelector('.ms-ask-text')?.textContent).toBe('Turn off request-post? Its settings and run records are kept.')
    expect(document.activeElement).toBe(buttonLabelled('Cancel', ask))
    click(buttonLabelled('Cancel', ask))
    await settle()
    expect(shown(ask)).toBe(false)
    expect(document.activeElement).toBe(buttonLabelled('Turn off', foot().querySelector('.ms-actions')!))
    click(buttonLabelled('Turn off', foot().querySelector('.ms-actions')!))
    await settle()
    mesh.s.body = { on: true, agents: [on('unslop-code')], others: 0, available: [OFFERED['unslop']!, OFFERED['request-post']!] }
    click(buttonLabelled('Turn off', ask))
    await settle()
    expect(bridge.ops()).toEqual([['disable', { agent: 'request-post', apply: false }], ['disable', { agent: 'request-post', apply: true }]])
    expect(shown(agentPage())).toBe(false)
    expect(shown(home())).toBe(true)
    expect(document.activeElement).toBe(title())
    await pollTick()
    expect(offer('request-post')).not.toBeNull()
  })

  it('while the Turn off question is open the foot’s Turn off and Change server are disabled, and enabled again when it closes (F7)', async () => {
    await openAgent('unslop-code', [server('local', { agents: ['unslop-code'] })])
    const actions = () => foot().querySelector<HTMLElement>('.ms-actions')!
    const turnOff = () => buttonLabelled('Turn off', actions())!
    const change = () => buttonLabelled('Change server', actions())!
    expect([turnOff().disabled, change().disabled]).toEqual([false, false])
    const places = [turnOff().getBoundingClientRect().top, change().getBoundingClientRect().top]
    click(turnOff())
    await settle()
    const ask = foot().querySelector<HTMLElement>('.ms-ask')!
    expect(shown(ask)).toBe(true)
    expect([turnOff().disabled, change().disabled]).toEqual([true, true])
    expect(shown(actions())).toBe(true)
    expect([turnOff().getBoundingClientRect().top, change().getBoundingClientRect().top]).toEqual(places)
    expect(buttonLabelled('Turn off', ask)!.disabled).toBe(false)
    await pollTick()
    expect([turnOff().disabled, change().disabled]).toEqual([true, true])
    click(buttonLabelled('Cancel', ask))
    await settle()
    expect([turnOff().disabled, change().disabled]).toEqual([false, false])
    expect(document.activeElement).toBe(turnOff())
  })

  it('a refused Turn off shows its words in the foot and keeps the agent', async () => {
    const { bridge } = await openAgent('request-post')
    bridge.s.answers['disable'] = () => ({ ok: false, applied: false, steps: [], refused: 'request-post is not on' })
    click(buttonLabelled('Turn off', foot().querySelector('.ms-actions')!))
    await settle()
    click(buttonLabelled('Turn off', foot().querySelector('.ms-ask')!))
    await settle()
    expect(foot().querySelector('.ms-message')?.textContent).toBe('request-post is not on')
    expect(shown(agentPage())).toBe(true)
    expect(bridge.ops()).toEqual([['disable', { agent: 'request-post', apply: false }]])
  })

  it('Change server opens the set-up form with the server it uses chosen, and runs the same operation', async () => {
    const { bridge, mesh } = await openAgent('unslop-code', [server('local', { agents: ['unslop-code'] }), server('lab')])
    click(buttonLabelled('Change server', foot()))
    await settle()
    expect(shown(setup())).toBe(true)
    expect(title().textContent).toBe('unslop-code')
    expect(select('server').value).toBe('local')
    expect(document.activeElement).toBe(select('server'))
    choose(select('server'), 'lab')
    await settle()
    choose(select('model'), 'model-a')
    click(buttonLabelled('Check', setup()))
    await settle()
    expect(setup().querySelector('.ms-review-title')?.textContent).toBe('Changing the server will')
    expect([...setup().querySelectorAll('.ms-steps li')].map((li) => li.textContent)).toEqual([
      'Point unslop-code at server lab, model model-a.',
      'Keep a backup of its old settings.',
    ])
    click(buttonLabelled('Change server', setup()))
    await settle()
    expect(bridge.ops()).toEqual([
      ['check-server', { name: 'local' }],
      ['check-server', { name: 'lab' }],
      ['enable-model-agent', { agent: 'unslop-code', server: 'lab', model: 'model-a', apply: false }],
      ['enable-model-agent', { agent: 'unslop-code', server: 'lab', model: 'model-a', apply: true }],
    ])
    // back on the agent's page, focus on the control that opened the form
    expect(shown(setup())).toBe(false)
    expect(shown(agentPage())).toBe(true)
    expect(document.activeElement).toBe(buttonLabelled('Change server', foot()))
    // F3: the changed agent is checked once
    expect(mesh.s.triggers.filter((t) => t === 'refresh unslop-code')).toHaveLength(1)
    await pollTick()
    expect(mesh.s.triggers.filter((t) => t === 'refresh unslop-code')).toHaveLength(1)
  })

  it('the back control in the Change server form names the agent and goes back to its page', async () => {
    await openAgent('unslop-code', [server('local', { agents: ['unslop-code'] })])
    click(buttonLabelled('Change server', foot()))
    await settle()
    const back = setup().querySelector<HTMLElement>('.map-back')!
    expect(back.textContent).toBe('← unslop-code')
    expect(back.getAttribute('aria-label')).toBe('Back to unslop-code')
    click(back)
    await settle()
    expect(shown(setup())).toBe(false)
    expect(shown(agentPage())).toBe(true)
    expect(document.activeElement).toBe(buttonLabelled('Change server', foot()))
  })

})

describe('an added agent’s page: Remove (add step 2, D5)', () => {
  const added = (name = 'pdf-reader') => agent(name, { kind: 'added', where: 'tailnet', endpoint: 'https://studio.tailnet-example.ts.net/pdf/a2a', state: 'added', checkedAt: null })
  async function openAdded(bridge: Parameters<typeof fakeBridge>[0] | null = {}) {
    const booted = await boot({ agents: [added(), on('unslop-code')], available: [OFFERED['unslop']!], bridge })
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await enter()
    click(card('pdf-reader'))
    await settle()
    return booted
  }
  const foot = () => agentPage().querySelector<HTMLElement>('.ms-foot')!
  const actions = () => foot().querySelector<HTMLElement>('.ms-actions')!
  const ask = () => foot().querySelector<HTMLElement>('.ms-ask')!

  it('its foot holds only Remove, which asks in place with focus on Cancel; Cancel puts focus back on Remove', async () => {
    const { bridge } = await openAdded()
    expect(agentPage().querySelector('.map-badge')?.textContent).toBe('Added by you')
    expect([...actions().querySelectorAll('button')].filter(shown).map((b) => b.textContent)).toEqual(['Remove'])
    const remove = buttonLabelled('Remove', actions())!
    expect(remove.classList.contains('ms-remove-agent')).toBe(true)
    expect(shown(ask())).toBe(false)
    click(remove)
    await settle()
    expect(shown(ask())).toBe(true)
    expect(ask().querySelector('.ms-ask-text')?.textContent).toBe('Remove pdf-reader? Its run records go too.')
    expect([...ask().querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Remove', 'Cancel'])
    expect(document.activeElement).toBe(buttonLabelled('Cancel', ask()))
    expect(remove.disabled).toBe(true)
    await pollTick()
    expect(remove.disabled).toBe(true)
    click(buttonLabelled('Cancel', ask()))
    await settle()
    expect(shown(ask())).toBe(false)
    expect(remove.disabled).toBe(false)
    expect(document.activeElement).toBe(remove)
    expect(bridge.ops()).toEqual([])
  })

  it('Remove runs remove-agent dry then applied, then back to the grid with focus on the tab’s heading, and the tab reads again', async () => {
    const { bridge, mesh } = await openAdded()
    click(buttonLabelled('Remove', actions()))
    await settle()
    const release = bridge.hold()
    click(buttonLabelled('Remove', ask()))
    await settle()
    expect(buttonLabelled('Removing…', ask())!.disabled).toBe(true)
    expect(buttonLabelled('Cancel', ask())!.disabled).toBe(true)
    mesh.s.body = { on: true, agents: [on('unslop-code')], others: 0, available: [OFFERED['unslop']!] }
    release()
    await settle()
    expect(bridge.ops()).toEqual([['remove-agent', { id: 'pdf-reader', apply: false }], ['remove-agent', { id: 'pdf-reader', apply: true }]])
    expect(shown(agentPage())).toBe(false)
    expect(shown(home())).toBe(true)
    expect(document.activeElement).toBe(title())
    await pollTick()
    expect(card('pdf-reader')).toBeUndefined()
  })

  it('a refusal shows its words in the foot with focus on Remove, and the agent stays', async () => {
    const { bridge } = await openAdded()
    bridge.s.answers['remove-agent'] = () => meshProcess.meshAnswer('plan', JSON.stringify({ applied: false, steps: [], refused: 'agents.pdf-reader was not written by add. Nothing changed.' }), 1) as Json
    click(buttonLabelled('Remove', actions()))
    await settle()
    click(buttonLabelled('Remove', ask()))
    await settle()
    expect(foot().querySelector('.ms-message')?.textContent).toBe('agents.pdf-reader was not written by add. Nothing changed.')
    expect(shown(ask())).toBe(false)
    expect(shown(agentPage())).toBe(true)
    expect(document.activeElement).toBe(buttonLabelled('Remove', actions()))
    expect(bridge.ops()).toEqual([['remove-agent', { id: 'pdf-reader', apply: false }]])
  })

  it('an id the command no longer finds counts as removed', async () => {
    const { bridge } = await openAdded()
    bridge.s.answers['remove-agent'] = () => meshProcess.meshAnswer('plan', JSON.stringify({ applied: false, steps: [], notes: ['pdf-reader is not in mesh.json. Nothing to do.'] }), 0) as Json
    click(buttonLabelled('Remove', actions()))
    await settle()
    click(buttonLabelled('Remove', ask()))
    await settle()
    expect(bridge.ops().map(([op]) => op)).toEqual(['remove-agent', 'remove-agent'])
    expect(shown(agentPage())).toBe(false)
  })

  it('without the bridge an added agent has no foot, and a built-in’s foot is as before', async () => {
    await boot({ agents: [added()], available: [], bridge: null })
    await enter()
    click(card('pdf-reader'))
    await settle()
    expect(agentPage().querySelector('.ms-foot')).toBeNull()
  })

  it('a built-in agent’s foot has no Remove', async () => {
    await openAdded()
    click(agentPage().querySelector('.map-back'))
    await settle()
    click(card('unslop-code'))
    await settle()
    expect([...actions().querySelectorAll('button')].filter(shown).map((b) => b.textContent)).toEqual(['Change server', 'Turn off'])
  })
})

describe('the bridge’s failures in words (D6)', () => {
  const WORDS: Record<string, string> = {
    'not-installed': 'The mesh command is not installed on this Mac. Run Setup first.',
    outdated: 'The installed mesh command is older than this app. Run Setup again.',
    busy: 'Another setup step is still running.',
    setup: 'Setup is running. Try again when it is done.',
    updating: 'An update is installing.',
    timeout: 'The command did not answer in time.',
    stale: 'The installed mesh command points at files that are gone. Run Setup again.',
    unsafe: 'The installed mesh command is not as Setup wrote it. Run Setup again.',
    unrecognized: 'The installed mesh command is not as Setup wrote it. Run Setup again.',
    handle: 'The chosen file is no longer held. Choose it again.',
  }
  const REASONS = ['unavailable', 'invalid', 'handle', 'busy', 'setup', 'updating', 'quitting', 'unsupported', 'environment', 'not-installed', 'unsafe', 'unrecognized', 'stale', 'outdated', 'output', 'timeout', 'failed']

  it('each reason has its sentence; every other names itself; a cancel shows nothing', async () => {
    const { bridge } = await boot({ bridge: { servers: [server('local')] } })
    await enter()
    const note = () => row('local')!.querySelector<HTMLElement>('.ms-row-note')!
    for (const reason of REASONS) {
      bridge.s.answers['check-server'] = () => ({ ok: false, reason })
      click(buttonLabelled('Check', row('local')!))
      await settle()
      expect(note().textContent, reason).toBe(WORDS[reason] ?? `That did not work (${reason}).`)
    }
    bridge.s.answers['check-server'] = () => ({ ok: false, reason: 'cancelled' })
    click(buttonLabelled('Check', row('local')!))
    await settle()
    expect(note().textContent).toBe('')
    expect(shown(note())).toBe(false)
  })

  it.each(['stale', 'unsafe', 'unrecognized', 'not-installed'])('a mesh command that cannot be used (%s) says why under Marketplace, with an agent on', async (reason) => {
    await boot({ agents: [on('unslop')], available: [OFFERED['unslop-code']!], bridge: { available: { available: false, reason } } })
    await enter()
    const line = document.querySelector<HTMLElement>('.ms-market .ms-line')!
    expect(line.textContent).toBe(WORDS[reason])
    expect(shown(line)).toBe(true)
    expect(shown(buttonLabelled('Set up', offer('unslop-code')!))).toBe(false)
  })

  it('a failed server list says why in the section', async () => {
    const { bridge } = await boot()
    bridge.s.answers['servers'] = () => ({ ok: false, reason: 'not-installed' })
    await enter()
    expect(document.querySelector('.ms-servers .ms-line')?.textContent).toBe(WORDS['not-installed'])
  })

  it('“meshctl” appears nowhere under public/', () => {
    const dir = resolve(import.meta.dirname, '..', '..', 'public')
    for (const name of readdirSync(dir)) {
      if (!/\.(js|d\.ts|html|css)$/.test(name)) continue
      expect(readFileSync(join(dir, name), 'utf8'), name).not.toContain('meshctl')
    }
  })
})

describe('the house rules (D7)', () => {
  it('a repaint in the middle of a filled form loses nothing: values, the chosen key, the file, focus', async () => {
    const { bridge, mesh } = await boot()
    await enter()
    click(buttonLabelled('Add a server', home()))
    await settle()
    type(field('name'), 'local')
    const file = setup().querySelector<HTMLInputElement>('input[type="radio"][value="file"]')!
    file.checked = true
    file.dispatchEvent(new window.Event('change', { bubbles: true }))
    await settle()
    click(buttonLabelled('Choose file…', setup()))
    await settle()
    type(field('baseUrl'), 'http://127.0.0.1:80')
    field('baseUrl')!.focus()
    const before = field('baseUrl')
    // another tab's data, a changed body, two polls
    mesh.s.version = { agents: 1 }
    mesh.s.body = { on: true, agents: [on('unslop')], others: 0, available: [OFFERED['unslop-code']!, OFFERED['request-post']!] }
    await pollTick()
    await pollTick()
    expect(shown(setup())).toBe(true)
    expect(field('baseUrl')).toBe(before)
    expect([field('name')!.value, field('baseUrl')!.value]).toEqual(['local', 'http://127.0.0.1:80'])
    expect(setup().querySelector<HTMLInputElement>('input[type="radio"][value="file"]')!.checked).toBe(true)
    expect(setup().querySelector('.ms-file-name')?.textContent).toBe('server.key')
    expect(document.activeElement).toBe(before)
    expect(bridge.ops()).toEqual([])
  })

  it('a second press while an operation runs does nothing; the control says what is happening', async () => {
    const { bridge } = await boot({ bridge: { servers: [server('local'), server('lab')] } })
    await enter()
    const release = bridge.hold()
    click(buttonLabelled('Check', row('local')!))
    await settle()
    const running = row('local')!.querySelector<HTMLButtonElement>('.ms-check')!
    expect(running.textContent).toBe('Checking…')
    expect(running.disabled).toBe(true)
    // the other controls wait too
    expect(row('lab')!.querySelector<HTMLButtonElement>('.ms-check')!.disabled).toBe(true)
    expect(buttonLabelled('Add a server', home())!.disabled).toBe(true)
    running.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    row('lab')!.querySelector<HTMLButtonElement>('.ms-check')!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
    expect(bridge.ops()).toEqual([['check-server', { name: 'local' }]])
    release()
    await settle()
    expect(running.textContent).toBe('Check')
    expect(running.disabled).toBe(false)
  })

  it('Turn on says Turning on… while it runs, and a second press does nothing', async () => {
    const { bridge } = await boot({ bridge: { servers: [server('local')] } })
    await enter()
    click(buttonLabelled('Set up', offer('unslop-code')!))
    await settle()
    choose(select('model'), 'model-a')
    click(buttonLabelled('Check', setup()))
    await settle()
    const release = bridge.hold()
    const turnOn = buttonLabelled('Turn on', setup())!
    click(turnOn)
    await settle()
    expect(turnOn.textContent).toBe('Turning on…')
    expect(turnOn.disabled).toBe(true)
    turnOn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
    release()
    await settle()
    expect(bridge.ops().filter(([op, values]) => op === 'enable-model-agent' && values['apply'] === true)).toHaveLength(1)
  })

  it('every new style rule keeps the one width query and no CSS order', () => {
    const css = readFileSync(resolve(import.meta.dirname, '..', '..', 'public', 'style.css'), 'utf8')
    expect(css.match(/@media \(max-width: \d+px\)/g)).toHaveLength(1)
    const mine = css.slice(css.indexOf('agent setup in the app (step 2b)'), css.indexOf('/* Run history (cards view V5d)'))
    expect(mine.length).toBeGreaterThan(0)
    expect(mine).not.toMatch(/\border\s*:|:hover|:focus-within|@media/)
  })
})
