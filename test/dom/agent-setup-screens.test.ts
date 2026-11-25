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
import { ALL_OFFERED, HANDLE, OFFERED, blurWhenDisabled, fakeBridge, server } from './agent-setup-fake.js'

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

  it('with every built-in on the Marketplace is gone, and Yours is the grid as before', async () => {
    await boot({ agents: [on('unslop'), on('unslop-code'), on('request-post', { where: 'tailnet' })], available: [] })
    await enter()
    expect([...home().querySelectorAll('h2')].map((h) => h.textContent)).toEqual(['Yours', 'Model servers'])
    expect(shown(home().querySelector('.ma-empty'))).toBe(false)
    expect(home().querySelector('.ma-count')?.textContent).toBe('3')
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
    bridge.s.answers['check-server'] = () => ({ ok: true, reachable: false, failure: 'unauthorized', models: [], skipped: 0 })
    click(buttonLabelled('Check', row('local')!))
    await settle()
    expect(row('local')!.querySelector('.ms-row-note')?.textContent).toBe('The server refused the key.')
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
    bridge.s.answers['check-server'] = () => ({ ok: true, reachable: false, failure: 'unreachable', models: [], skipped: 0 })
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

  it('while the models are asked the list says so; a server with none lists none', async () => {
    const { bridge } = await boot({ bridge: { servers: [server('local')] } })
    await enter()
    const release = bridge.hold()
    click(buttonLabelled('Set up', offer('unslop-code')!))
    await settle()
    expect([...select('model').options].map((o) => o.textContent)).toEqual(['asking the server…'])
    expect(select('model').disabled).toBe(true)
    bridge.s.answers['check-server'] = () => ({ ok: true, reachable: true, models: [], skipped: 0 })
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

  it('an added agent has no foot', async () => {
    await boot({ agents: [agent('echo', { kind: 'added', where: 'public', state: 'added', checkedAt: null })], available: [] })
    await enter()
    click(card('echo'))
    await settle()
    expect(agentPage().querySelector('.ms-foot')).toBeNull()
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
