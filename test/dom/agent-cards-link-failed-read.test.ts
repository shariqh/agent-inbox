// @vitest-environment jsdom
// A #cards/<key> link that met a failed first /api/version read is dropped, not kept for a later
// read (the sessions indicator, G L, a session card). Its own file: the harness keeps every boot's
// window listeners, so a hash is answered by every app booted before it in a file.
import { afterEach, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { bootApp, click, freshDb, navigateToHash, pollTick, settle, useDomTest } from './harness.js'
import { agent, fakeMesh } from './agent-cards-fake.js'

useDomTest()
let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
})
const activeTab = () => document.querySelector('#tabs .tab[aria-selected="true"]')?.getAttribute('data-tab')

it('a deep link that met a failed version read is dropped, not kept for a later read', async () => {
  db = freshDb()
  const fake = fakeMesh([agent('unslop')])
  let fail = true
  await bootApp(db, {
    viewer: { mesh: fake.mesh },
    interceptFetch: (input, _init, next) => {
      if (String(input) === '/api/version' && fail) return Promise.resolve(new Response('no', { status: 503 }))
      return next()
    },
  })
  navigateToHash('#cards/mesh.json%3Aunslop')
  await settle()
  await pollTick()
  fail = false
  click(document.getElementById('sessionsIndicator'))
  await settle()
  await settle()
  expect(activeTab()).toBe('dashboard')
  expect(document.getElementById('agentPage')!.hidden).toBe(true)
})
