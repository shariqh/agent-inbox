// @vitest-environment jsdom
// Agent cards step 1 (D1, D3): #cards opens the tab, #cards/<agent key> an agent's page in it;
// G M goes to the tab. With the mesh off none of them does anything. The mesh-off case runs first:
// the harness keeps every boot's window listeners for the whole file, and an app with the mesh off
// never answers a later test's hash.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { bootApp, click, freshDb, navigateToHash, pollTick, settle, useDomTest } from './harness.js'
import type { ViewerBridge } from './harness.js'
import { agent, fakeMesh } from './agent-cards-fake.js'

useDomTest()
let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
})

const activeTab = () => document.querySelector('#tabs .tab[aria-selected="true"]')?.getAttribute('data-tab')
const page = () => document.getElementById('agentPage')!
const cards = () => document.querySelector<HTMLElement>('#tabs .tab[data-tab="cards"]')!
const press = (key: string) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
const posted = (bridge: ViewerBridge) => bridge.posts.filter((p) => p.url === '/api/mesh/agents/refresh').map((p) => JSON.parse(String(p.init?.body)) as unknown)

describe('ways into the Agent cards (Agent cards step 1)', () => {
  it('with the mesh off, G M, #cards and #cards/<key> do nothing, and nothing is read or posted', async () => {
    db = freshDb()
    const log: string[] = []
    const bridge = await bootApp(db, { interceptFetch: (input, _init, next) => { log.push(String(input)); return next() } })
    await pollTick()
    expect(cards().hidden).toBe(true)
    ;(document.activeElement as HTMLElement | null)?.blur()
    press('g')
    press('m')
    await settle()
    expect(activeTab()).toBe('dashboard')
    for (const hash of ['#cards', '#cards/mesh.json%3Aunslop']) {
      navigateToHash(hash)
      await settle()
      expect([activeTab(), page().hidden, document.getElementById('cards')?.hidden], hash).toEqual(['dashboard', true, true])
    }
    await pollTick()
    expect(log.some((url) => url.includes('/api/mesh/'))).toBe(false)
    expect(bridge.posts).toEqual([])
  })

  it('a deep link opens the agent’s page once /api/version says mesh; #cards opens the grid; an unknown agent says it is not there', async () => {
    db = freshDb()
    const fake = fakeMesh([agent('request-post', { where: 'tailnet' }), agent('unslop', { state: 'not-running', reason: 'starts on its first call' })])
    let release = () => {}
    const held = new Promise<void>((done) => { release = done })
    const bridge = await bootApp(db, {
      viewer: { mesh: fake.mesh },
      interceptFetch: (input, _init, next) => (String(input) === '/api/version' ? held.then(next) : next()),
    })
    navigateToHash('#cards/mesh.json%3Arequest-post')
    await settle()
    expect(activeTab()).toBe('dashboard')
    release()
    await settle()
    await settle()
    // the name before the first read, then the page from the body
    expect([activeTab(), page().hidden, document.getElementById('pageTitle')?.textContent]).toEqual(['cards', false, 'request-post'])
    expect(page().querySelector<HTMLElement>('.map-gone')?.hidden).toBe(true)
    await pollTick()
    expect(page().querySelector('.map-status')?.textContent).toBe('Reachable')
    expect(page().querySelector<HTMLElement>('.map-gone')?.hidden).toBe(true)
    // one open, for entering the tab; the deep link posts no check of its own
    expect(posted(bridge)).toEqual([{ trigger: 'open' }])
    // #cards alone: the tab, on the grid once the page is closed
    click(page().querySelector('.map-back'))
    await settle()
    navigateToHash('#cards')
    await settle()
    expect([activeTab(), page().hidden, document.getElementById('agentCardsHome')?.hidden]).toEqual(['cards', true, false])
    // an agent mesh.json does not name: its page says so
    navigateToHash('#cards/mesh.json%3Agone')
    await settle()
    await pollTick()
    expect([page().hidden, document.getElementById('pageTitle')?.textContent, page().querySelector<HTMLElement>('.map-gone')?.hidden]).toEqual([false, 'gone', false])
    // a typed link without the source prefix names the one configured agent of that name
    click(page().querySelector('.map-back'))
    await settle()
    navigateToHash('#cards/unslop')
    await settle()
    await pollTick()
    expect([page().hidden, document.getElementById('pageTitle')?.textContent, page().querySelector<HTMLElement>('.map-gone')?.hidden]).toEqual([false, 'unslop', true])
    expect(page().querySelector('.map-status')?.textContent).toBe('Not running · starts on its first call')
    // and a bare name nothing configures still says so
    click(page().querySelector('.map-back'))
    await settle()
    navigateToHash('#cards/nobody')
    await settle()
    await pollTick()
    expect([page().hidden, document.getElementById('pageTitle')?.textContent, page().querySelector<HTMLElement>('.map-gone')?.hidden]).toEqual([false, 'nobody', false])
    // G M from Home goes to the tab and focuses its panel
    click(page().querySelector('.map-back'))
    await settle()
    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()
    ;(document.activeElement as HTMLElement | null)?.blur()
    press('g')
    press('m')
    await settle()
    expect([activeTab(), document.activeElement?.id]).toEqual(['cards', 'cards'])
  })
})
