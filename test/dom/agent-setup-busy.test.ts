// @vitest-environment jsdom
// Add step 2, G1: a set-up page cannot be left while its operation runs. Escape is consumed and does
// nothing, and the page's back control is disabled, so the operation's result always lands on the page
// that started it: a held Add that succeeds opens the new agent's page, a held Add that is refused shows
// its words with Back, and a held Turn on opens the agent's page. One test in its own file: the harness
// keeps every boot's document listeners for the whole file, and Escape is a document key.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { bootApp, buttonLabelled, click, freshDb, pollTick, settle, type, useDomTest } from './harness.js'
import { fakeMesh } from './agent-cards-fake.js'
import { ALL_OFFERED, carded, fakeBridge, server } from './agent-setup-fake.js'

useDomTest()
let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
  Reflect.deleteProperty(window, 'agentInboxMesh')
})

describe('leaving a set-up page while its operation runs (add step 2, G1)', () => {
  it('Escape and the back control do nothing while Add or Turn on runs; the result lands on its page', async () => {
    db = freshDb()
    const mesh = fakeMesh([])
    mesh.s.version = undefined
    mesh.s.body = { on: false, agents: [], available: ALL_OFFERED }
    const bridge = fakeBridge({ servers: [server('local')] })
    await bootApp(db, { viewer: { mesh: mesh.mesh } })
    await settle()
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    click(document.querySelector('.tab[data-tab="cards"]'))
    await settle()
    await pollTick()
    const setup = () => document.getElementById('agentSetup')!
    const agentPage = () => document.getElementById('agentPage')!
    const title = () => document.getElementById('pageTitle')!.textContent
    const shown = (el: Element | null | undefined) => Boolean(el) && !(el as HTMLElement).closest('[hidden]')
    const back = () => setup().querySelector<HTMLButtonElement>('.map-back')!
    const addByAddress = () => buttonLabelled('Add by address', document.querySelector('.ms-market .ma-head')!)!
    // a press that reaches the control's listener even while it is disabled
    const force = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const escape = () => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    async function tryToLeave(pageTitle: string) {
      expect(back().disabled).toBe(true)
      // consumed: the key goes no further, and the page stays
      expect(escape()).toBe(false)
      await settle()
      force(back())
      await settle()
      expect(title()).toBe(pageTitle)
      expect(shown(setup())).toBe(true)
    }
    async function checkAddress() {
      click(addByAddress())
      await settle()
      type(setup().querySelector<HTMLInputElement>('input[name="address"]'), 'https://studio.tailnet-example.ts.net/pdf/.well-known/agent-card.json')
      click(buttonLabelled('Check', setup()))
      await settle()
    }

    // a held Add that succeeds: the new agent's page opens when it answers
    await checkAddress()
    let release = bridge.hold()
    click(buttonLabelled('Add', setup()))
    await settle()
    await tryToLeave('Add an agent')
    release()
    await settle()
    expect(shown(agentPage())).toBe(true)
    expect(title()).toBe('pdf-reader')
    expect(agentPage().querySelector('.map-gone')?.textContent).toBe('Added. Its details show in a moment.')
    expect(document.activeElement).toBe(agentPage().querySelector('.map-back'))

    // a held Add that is refused: its words show with Back only
    click(agentPage().querySelector('.map-back'))
    await settle()
    await checkAddress()
    const changed = 'the card is not the one that was checked (its pin differs): check it again. Nothing changed.'
    bridge.s.answers['add-agent'] = () => carded({ refused: changed })
    release = bridge.hold()
    click(buttonLabelled('Add', setup()))
    await settle()
    await tryToLeave('Add an agent')
    release()
    await settle()
    const review = setup().querySelector<HTMLElement>('.ms-review')!
    expect(review.querySelector('.ms-refused')?.textContent).toBe(changed)
    expect([...review.querySelectorAll<HTMLButtonElement>('.ms-actions button')].filter(shown).map((b) => b.textContent)).toEqual(['Back'])
    expect(document.activeElement).toBe(buttonLabelled('Back', review))
    // once it has answered, the page can be left again
    expect(back().disabled).toBe(false)
    click(back())
    await settle()
    expect(title()).toBe('Agent cards')
    expect(document.activeElement).toBe(addByAddress())

    // a held Turn on: the agent's page opens when it answers
    click(buttonLabelled('Set up', document.querySelector('.ms-market li[data-offer="unslop-code"]')!))
    await settle()
    await settle()
    const model = setup().querySelector<HTMLSelectElement>('select[name="model"]')!
    model.value = 'model-a'
    model.dispatchEvent(new Event('change', { bubbles: true }))
    click(buttonLabelled('Check', setup()))
    await settle()
    release = bridge.hold()
    click(buttonLabelled('Turn on', setup()))
    await settle()
    await tryToLeave('unslop-code')
    release()
    await settle()
    expect(shown(setup())).toBe(false)
    expect(shown(agentPage())).toBe(true)
    expect(agentPage().querySelector('.map-gone')?.textContent).toBe('Turned on. Its details show in a moment.')
    expect(bridge.ops().filter(([op, values]) => values['apply'] === true).map(([op]) => op)).toEqual(['add-agent', 'add-agent', 'enable-model-agent'])
  })
})
