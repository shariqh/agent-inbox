// @vitest-environment jsdom
// "← Agent cards" from the page of an agent that left mesh.json, or after the mesh went off while
// the page was open, keeps keyboard focus in the tab: the card is gone (or detached), so focus
// goes to the tab's own heading, which can take it.
import { afterEach, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { bootApp, click, freshDb, pollTick, settle, useDomTest } from './harness.js'
import { agent, fakeMesh } from './agent-cards-fake.js'

useDomTest()
let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
})

async function openPage(name: string, agents = [agent('request-post', { where: 'tailnet' }), agent('unslop')]) {
  db = freshDb()
  const fake = fakeMesh(agents)
  await bootApp(db, { viewer: { mesh: fake.mesh } })
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  click(document.querySelector('.tab[data-tab="cards"]'))
  await settle()
  await pollTick()
  const card = [...document.querySelectorAll<HTMLElement>('#cards .ma-card')].find((el) => el.querySelector('.ma-name')?.textContent === name)!
  click(card)
  await settle()
  const back = document.querySelector<HTMLElement>('#agentPage .map-back')!
  expect(document.activeElement).toBe(back)
  return { fake, back }
}
const title = () => document.getElementById('pageTitle')!

it('back from an agent that left mesh.json puts focus on the tab heading', async () => {
  const { fake, back } = await openPage('request-post')
  fake.s.body = { on: true, agents: [agent('unslop')], others: 0 }
  await pollTick()
  expect(document.querySelector<HTMLElement>('#agentPage .map-gone')!.hidden).toBe(false)
  click(back)
  await settle()
  expect(document.activeElement).toBe(title())
  expect(title().textContent).toBe('Agent cards')
})

it('back after the mesh went off puts focus on the tab heading, not on a detached card', async () => {
  const { fake, back } = await openPage('unslop')
  fake.s.body = { on: false, agents: [] }
  await pollTick()
  click(back)
  await settle()
  expect(document.activeElement).toBe(title())
  expect(document.activeElement?.isConnected).toBe(true)
})
