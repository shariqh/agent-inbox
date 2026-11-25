// @vitest-environment jsdom
// Agent setup in the app, step 2b (D3, D7): Escape on a set-up page goes back where it came from,
// unless focus is in a field: from adding a server opened by an agent's form to that form, then to
// the tab's home, focus each time on the control that opened the page. One test in its own file:
// the harness keeps every boot's document listeners for the whole file.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { bootApp, buttonLabelled, click, freshDb, pollTick, settle, useDomTest } from './harness.js'
import { fakeMesh } from './agent-cards-fake.js'
import { ALL_OFFERED, fakeBridge, server } from './agent-setup-fake.js'

useDomTest()
let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
  Reflect.deleteProperty(window, 'agentInboxMesh')
})

describe('a set-up page’s keys (step 2b)', () => {
  it('Escape goes back one page at a time, unless focus is in a field', async () => {
    db = freshDb()
    const mesh = fakeMesh([])
    mesh.s.version = undefined
    mesh.s.body = { on: false, agents: [], available: ALL_OFFERED }
    const bridge = fakeBridge({ servers: [server('local'), server('lab')] })
    await bootApp(db, { viewer: { mesh: mesh.mesh } })
    await settle()
    click(document.querySelector('.tab[data-tab="cards"]'))
    await settle()
    await pollTick()
    const setup = () => document.getElementById('agentSetup')!
    const title = () => document.getElementById('pageTitle')!.textContent
    const escape = (el: Element) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    const setUp = () => buttonLabelled('Set up', document.querySelector('.ms-market li[data-offer="unslop-code"]')!)!
    click(setUp())
    await settle()
    const serverList = () => setup().querySelector<HTMLSelectElement>('select[name="server"]')!
    serverList().value = serverList().options[serverList().options.length - 1]!.value
    serverList().dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    expect(title()).toBe('Add a model server')
    // in a field, Escape is the field's
    const name = setup().querySelector<HTMLInputElement>('input[name="name"]')!
    expect(document.activeElement).toBe(name)
    escape(name)
    await settle()
    expect(title()).toBe('Add a model server')
    // on the page, back to the agent's form, focus on its server list
    const back = setup().querySelector<HTMLElement>('.map-back')!
    back.focus()
    escape(back)
    await settle()
    expect(title()).toBe('unslop-code')
    expect(document.activeElement).toBe(serverList())
    // again: back to the home, focus on the Set up that opened the form
    const again = setup().querySelector<HTMLElement>('.map-back')!
    again.focus()
    escape(again)
    await settle()
    expect(setup().hidden).toBe(true)
    expect(document.getElementById('agentCardsHome')!.hidden).toBe(false)
    expect(title()).toBe('Agent cards')
    expect(document.activeElement).toBe(setUp())
    // Add an agent (add step 2, D4): Escape from the page goes back with focus on Add by address
    const addByAddress = () => buttonLabelled('Add by address', document.querySelector('.ms-market .ma-head')!)!
    click(addByAddress())
    await settle()
    expect(title()).toBe('Add an agent')
    const away = setup().querySelector<HTMLElement>('.map-back')!
    away.focus()
    escape(away)
    await settle()
    expect(title()).toBe('Agent cards')
    expect(document.activeElement).toBe(addByAddress())
    // nothing ran but the server list
    expect(bridge.ops()).toEqual([])
  })
})
