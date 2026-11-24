// @vitest-environment jsdom
// Agent cards step 1 (D3): Escape on an agent's page goes back to the grid when focus is not in a
// field. One test in its own file: the harness keeps every boot's document listeners for the whole
// file, so an earlier app's Escape (clearing its selection) would answer first.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { bootApp, click, freshDb, settle, useDomTest } from './harness.js'
import { agent, fakeMesh } from './agent-cards-fake.js'

useDomTest()
let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
})

describe('the Agent cards tab’s keys (Agent cards step 1, D3)', () => {
  it('Escape goes back to the grid, unless focus is in a field', async () => {
    db = freshDb()
    const fake = fakeMesh([agent('unslop', { state: 'not-running', reason: 'starts on its first call' })])
    await bootApp(db, { viewer: { mesh: fake.mesh } })
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    click(document.querySelector('.tab[data-tab="cards"]'))
    await settle()
    const card = () => document.querySelector<HTMLElement>('#cards .ma-card')!
    const page = () => document.getElementById('agentPage')!
    const escape = (el: Element) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    click(card())
    await settle()
    expect(page().hidden).toBe(false)
    // in a field (the top bar's search), Escape is the field's
    const search = document.getElementById('search') as HTMLInputElement
    search.focus()
    escape(search)
    await settle()
    expect(page().hidden).toBe(false)
    // on the page, Escape goes back, and focus lands on the agent's card
    const refresh = page().querySelector<HTMLElement>('.map-refresh')!
    refresh.focus()
    escape(refresh)
    await settle()
    expect([document.querySelector('#tabs .tab[aria-selected="true"]')?.getAttribute('data-tab'), page().hidden]).toEqual(['cards', true])
    expect(document.activeElement).toBe(card())
    // on the grid, Escape leaves the tab and the grid alone
    escape(card())
    await settle()
    expect([document.querySelector('#tabs .tab[aria-selected="true"]')?.getAttribute('data-tab'), page().hidden, document.getElementById('agentCardsHome')?.hidden]).toEqual(['cards', true, false])
    // Escape posted nothing; entering the tab posted the one open
    expect(fake.s.triggers).toEqual(['open'])
  })
})
