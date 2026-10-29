// @vitest-environment jsdom
// Mesh M1 (#397): the opt-in Agents view. Off means off (design §2.4b): with no
// mesh.json the page makes exactly the requests it made before, every poll read
// and /api/version keep their bytes and ETags, no Settings → Mesh section is
// drawn and /mesh-view.js is never requested. On, the view adds a Sessions |
// Agents lens and Settings → Mesh, and the human's attention surfaces stay
// exactly as they are with it off.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, recordActivityCall, upsertActivity, upsertBoard } from '../../src/store.js'
import { createViewer } from '../../src/viewer.js'
import type { ViewerOpts } from '../../src/viewer.js'
import { meshFile, watchMeshConfig } from '../../src/mesh-config.js'
import { scratchDir } from '../scratch.js'
import { advanceClock, badgeCount, bootApp, click, freshDb, pollTick, rows, settle, showInbox, tabCount, useDomTest } from './harness.js'

useDomTest()
let db: Database.Database | null = null
let stopWatch: (() => void) | null = null
afterEach(() => { db?.close(); db = null; stopWatch?.(); stopWatch = null })

const route = (input: RequestInfo | URL): string => String(input)

function seed(d: Database.Database): void {
  insertItem(d, { project: 'agent-inbox', stream: 'feat/412', agent: 'copilot', kind: 'question', title: 'Ship the search ranking?' })
  advanceClock()
  insertItem(d, { project: 'demo', stream: 'main', agent: 'claude-code', kind: 'question', title: 'Retry 4xx?' })
  advanceClock()
  insertItem(d, { project: 'demo', stream: 'main', agent: 'claude-code', kind: 'note', title: 'Flaky test noted' })
  advanceClock()
  upsertBoard(d, {
    project: 'agent-inbox', stream: 'spec', agent: 'claude-code', title: 'Mesh metrics',
    rows: [{ label: 'Approve the metric set', status: 'blocked', note: 'Drafted.', next_step: 'Approve it.', action_owner: 'approval',
      impact: 'Unblocks M2.', options: [{ label: 'Approve', recommended: true }, { label: 'Hold' }] }],
  })
  for (const [session, agent, project, stream, doing] of [
    ['c1', 'copilot', 'agent-inbox', 'feat/412', 'Writing jsdom tests'],
    ['c2', 'copilot', 'demo', 'main', 'Reviewing PR #57'],
    ['k1', 'claude-code', 'agent-inbox', 'spec', 'Drafting the metrics section'],
  ] as const) {
    upsertActivity(d, { session, agent, project, stream, doing })
    recordActivityCall(d, session)
    advanceClock()
  }
  upsertActivity(d, { session: 'k2', agent: 'claude-code', project: 'demo', stream: 'main', doing: 'open', idle: true, claim: false })
}

// A viewer exactly as viewer-server.ts builds it, its mesh folder holding no mesh.json.
function meshOff(): ViewerOpts {
  const watch = watchMeshConfig(meshFile(scratchDir('mesh-off-')))
  stopWatch = watch.stop
  return { meshAgentsView: () => watch.current()?.agentsView === true }
}

async function surfaces() {
  return {
    title: document.title,
    badge: badgeCount(),
    tabs: ['needsYou', 'notes', 'boards', 'done'].map(tabCount),
    rail: [...document.querySelectorAll('#dashRail [data-rail-card] .dash-rail-title')].map((el) => el.textContent),
    needsYou: await (async () => { await showInbox(); return rows().map((el) => el.querySelector('.nrow-title')?.textContent) })(),
  }
}

// What the mesh view's module load looks like to the page: counted, never stubbed.
function countMeshLoads(): { count: number } {
  const loads = { count: 0 }
  vi.doMock('/mesh-view.js', async (importOriginal) => {
    loads.count += 1
    return await importOriginal()
  })
  return loads
}

// What every boot of seed() makes and shows, the same with the mesh off or on
// (each test checks itself against these, so any one runs alone with -t). The
// boot reads, then one poll tick's eight reads.
const POLL = ['/api/items', '/api/boards', '/api/boards/archived/summary', '/api/activity',
  '/api/activity/history?since_ms=1781949600000', '/api/projects/closed', '/api/links', '/api/issues']
const BOOT_REQUESTS = ['/api/version', '/api/setup', ...POLL, ...POLL]
const SURFACES = {
  title: '(3) Agent Inbox',
  badge: 3,
  tabs: ['3', '1', '1', ''],
  rail: ['Approve it.', 'Ship the search ranking?', 'Retry 4xx?'],
  needsYou: ['Approve it.', 'Ship the search ranking?', 'Retry 4xx?'],
}

describe('Agents view off (§2.4b)', () => {
  it('baseline: a build with no mesh option', async () => {
    db = freshDb()
    seed(db)
    const requests: string[] = []
    await bootApp(db, { interceptFetch: async (input, _init, next) => { requests.push(route(input)); return next() } })
    await pollTick()
    await settle()
    expect(requests).toEqual(BOOT_REQUESTS)
    expect(await surfaces()).toEqual(SURFACES)
  })

  it('no mesh.json: the same requests, the same bytes and ETags, no Mesh section, no /mesh-view.js', async () => {
    db = freshDb()
    seed(db)
    const loads = countMeshLoads()
    const opts = meshOff()
    const requests: string[] = []
    await bootApp(db, { viewer: opts, interceptFetch: async (input, _init, next) => { requests.push(route(input)); return next() } })
    await pollTick()
    await settle()
    expect(requests).toEqual(BOOT_REQUESTS)
    expect(requests.some((url) => url.includes('mesh'))).toBe(false)
    expect(loads.count).toBe(0)
    expect(document.getElementById('mesh-settings')).toBeNull()
    expect(document.querySelector('.mesh-lens, .mesh-agents')).toBeNull()
    expect(document.querySelector('.dash-lanes')?.hasAttribute('hidden')).toBe(false)

    // every read the page made, and /api/version, against a viewer with no mesh option at all
    const home = scratchDir('mesh-home-')
    const withMesh = createViewer(db, { agentHome: home, ...opts })
    const without = createViewer(db, { agentHome: home })
    const urls = [...new Set([...requests, '/api/version'])]
    expect(urls.length).toBeGreaterThanOrEqual(9)
    for (const url of urls) {
      const [a, b] = [await withMesh.request(url), await without.request(url)]
      expect([a.status, a.headers.get('etag'), await a.text()], url).toEqual([b.status, b.headers.get('etag'), await b.text()])
    }
    expect(await surfaces()).toEqual(SURFACES)
  })
})

describe('Agents view on', () => {
  it('loads the view once, draws the lens and Settings → Mesh, and leaves every attention surface alone', async () => {
    db = freshDb()
    seed(db)
    const loads = countMeshLoads()
    const requests: string[] = []
    await bootApp(db, {
      viewer: { meshAgentsView: () => true },
      interceptFetch: async (input, _init, next) => { requests.push(route(input)); return next() },
    })
    await pollTick()
    await settle()
    expect(loads.count).toBe(1)
    // the dynamic import lands outside the fake clock
    await vi.waitFor(() => expect(document.getElementById('mesh-settings')).not.toBeNull())
    await pollTick()
    await settle()
    // the module itself fetches nothing: the page reads what the baseline reads
    expect([...new Set(requests)].sort()).toEqual([...new Set(BOOT_REQUESTS)].sort())

    const settings = document.getElementById('mesh-settings')
    expect(settings?.querySelector('h3')?.textContent).toBe('Mesh')
    expect([...settings!.querySelectorAll('pre')].map((el) => el.textContent)).toEqual([
      'npm run meshctl -- disable --apply',
      '~/.agent-inbox/runtime/<runtime-id>/bin/node ~/.agent-inbox/runtime/<runtime-id>/dist/meshctl.js disable --apply',
    ])
    expect(settings?.textContent).toContain('Or delete mesh.json from its folder')
    expect(settings?.previousElementSibling?.id).toBe('link-settings')

    const lens = [...document.querySelectorAll<HTMLButtonElement>('.mesh-lens [data-mesh-lens]')]
    expect(lens.map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([['Sessions', 'true'], ['Agents', 'false']])
    expect(document.querySelector<HTMLElement>('.mesh-agents')?.hidden).toBe(true)
    expect(document.querySelector<HTMLElement>('.dash-lanes')?.hidden).toBe(false)

    click(lens[1])
    expect(document.querySelector<HTMLElement>('.dash-lanes')?.hidden).toBe(true)
    expect(document.querySelector<HTMLElement>('.mesh-agents')?.hidden).toBe(false)
    const cards = [...document.querySelectorAll<HTMLElement>('.mesh-agent')]
    expect(cards.map((card) => card.dataset.meshAgent)).toEqual(['copilot', 'claude-code'])
    const [copilot, claude] = cards
    expect([...copilot!.querySelectorAll('.mesh-project')].map((el) => el.textContent)).toEqual(['agent-inbox', 'demo'])
    expect(copilot!.querySelector('.mesh-ask-count')?.textContent).toBe('1')
    expect(claude!.querySelector('.mesh-ask-count')?.textContent).toBe('2')
    expect([...claude!.querySelectorAll('.mesh-session')].map((el) => el.className)).toEqual(['mesh-session working', 'mesh-session idle'])
    expect(copilot!.querySelector('.mesh-trace-count')?.textContent).toBe('2')
    expect(document.querySelector('.mesh-agents')?.textContent).toContain('Reviewing PR #57')

    // an unchanged poll keeps the nodes; agent text is text, never markup
    const before = document.querySelector('.mesh-agent')
    await pollTick()
    await settle()
    expect(document.querySelector('.mesh-agent')).toBe(before)
    expect(document.querySelectorAll('.mesh-agents script, .mesh-agents img')).toHaveLength(0)

    // with the Agents lens drawn, the human's attention reads as it does with the mesh off
    expect(await surfaces()).toEqual(SURFACES)
  })

  it('the poll bodies and the dock projection are the same with the view on and off', async () => {
    db = freshDb()
    seed(db)
    const home = scratchDir('mesh-home-')
    const on = createViewer(db, { agentHome: home, meshAgentsView: () => true })
    const off = createViewer(db, { agentHome: home })
    for (const url of ['/api/items', '/api/items?scope=attention', '/api/items/history', '/api/boards', '/api/boards?scope=attention',
      '/api/boards/archived', '/api/boards/archived/summary', '/api/activity', '/api/links', '/api/issues', '/api/projects/closed']) {
      const [a, b] = [await on.request(url), await off.request(url)]
      expect([a.status, a.headers.get('etag'), await a.text()], url).toEqual([b.status, b.headers.get('etag'), await b.text()])
    }
  })
})
