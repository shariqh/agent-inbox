// @vitest-environment jsdom
// A #cards/<key> link still waiting on /api/version never pulls the person off the tab they
// chose meanwhile. Its own file: the harness keeps every boot's window listeners, so a hash is
// answered by every app booted before it in a file.
import { afterEach, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { bootApp, click, freshDb, navigateToHash, settle, useDomTest } from './harness.js'
import { agent, fakeMesh } from './agent-cards-fake.js'

useDomTest()
let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
})
const activeTab = () => document.querySelector('#tabs .tab[aria-selected="true"]')?.getAttribute('data-tab')

it('a waiting deep link does not take the person off the tab they chose meanwhile', async () => {
  db = freshDb()
  const fake = fakeMesh([agent('unslop')])
  let release = () => {}
  const held = new Promise<void>((done) => { release = done })
  await bootApp(db, {
    viewer: { mesh: fake.mesh },
    interceptFetch: (input, _init, next) => (String(input) === '/api/version' ? held.then(next) : next()),
  })
  navigateToHash('#cards/mesh.json%3Aunslop')
  await settle()
  click(document.querySelector('.tab[data-tab="find"]'))
  await settle()
  release()
  await settle()
  await settle()
  expect(activeTab()).toBe('find')
  expect(document.getElementById('agentPage')!.hidden).toBe(true)
})
