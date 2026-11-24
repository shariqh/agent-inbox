// @vitest-environment jsdom
// The spoken "Go to: …" list names M (Agent cards) only while the Agent cards tab is shown. One test
// in its own file: the harness keeps every boot's document listeners, so a second app would answer
// the same key.
import { afterEach, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { bootApp, click, freshDb, settle, useDomTest } from './harness.js'
import { agent, fakeMesh } from './agent-cards-fake.js'

useDomTest()
let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
})
const press = (key: string) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
const status = () => document.getElementById('keyboardStatus')!.textContent ?? ''

it('G announces M Agent cards while the tab is shown, and leaves it out once the mesh is off', async () => {
  db = freshDb()
  const fake = fakeMesh([agent('unslop')])
  await bootApp(db, { viewer: { mesh: fake.mesh } })
  await settle()
  press('g')
  expect(status()).toContain('L Sessions, M Agent cards. Esc cancels.')
  press('Escape')
  // the mesh goes off: the next version read hides the tab (Home is the current tab)
  fake.s.version = undefined
  click(document.getElementById('sessionsIndicator'))
  await settle()
  expect(document.querySelector<HTMLElement>('#tabs .tab[data-tab="cards"]')!.hidden).toBe(true)
  press('g')
  expect(status()).toContain('L Sessions. Esc cancels.')
  expect(status()).not.toContain('Agent cards')
})
