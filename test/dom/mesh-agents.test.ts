// @vitest-environment jsdom
// The agent cards view V3 (design docs/superpowers/specs/2026-11-09-agent-cards-view-design.md
// §2, §4.5, §7): the Agents home's Mesh agents section. It reads `/api/mesh/agents` only while
// the last /api/version carried `mesh`, the Dashboard shows and the window is visible; an open
// (boot on the Dashboard, showAgentsHome(), selectTab('dashboard') from another tab) posts one
// check and paints through the next poll tick, Refresh through reloadAndPaint(). It is global
// and never an ask. The viewer's real routes answer from a stand-in for src/mesh-agents.ts, so
// no socket opens.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type Database from 'better-sqlite3'
import { insertItem, recordActivityCall, upsertActivity, upsertBoard } from '../../src/store.js'
import { cardJson, summarizeCard } from '../../src/agent-card.js'
import type { MeshAgents } from '../../src/mesh-agents.js'
import { meshRows } from '../../public/mesh-section.js'
import { advanceClock, attachStylesheet, badgeCount, bootApp, click, freshDb, navigateToHash, pollTick, rows, settle, showInbox, tabCount, useDomTest } from './harness.js'
import type { ViewerBridge } from './harness.js'

useDomTest()
let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
  delete (document as unknown as Record<string, unknown>).visibilityState
  delete (window as unknown as Record<string, unknown>).agentInboxSetup
})

type Json = Record<string, unknown>
const REPO = resolve(import.meta.dirname, '..', '..')
const RP_CARD = JSON.parse(readFileSync(resolve(REPO, 'test', 'fixtures', 'a2a-request-post', 'card.json'), 'utf8')) as Json
const UNSLOP_CARD: Json = {
  name: 'unslop', description: 'Removes generic AI-writing patterns from prose.', version: '0.3.1',
  supportedInterfaces: [{ url: 'http://127.0.0.1:4420/', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
  capabilities: {
    streaming: false, pushNotifications: false,
    extensions: [{ uri: 'urn:agent-inbox:ext:unslop:v1', required: true, params: { api: 1, skillId: 'unslop', rulesSha256: '3f9a1c0e7b22', bytes: 6204 } }],
  },
  securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
  securityRequirements: [{ schemes: { bearer: { list: [] } } }],
  defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
  skills: [{ id: 'unslop', name: 'unslop', description: 'Rewrites a draft without the generic patterns', tags: ['writing'] }],
}
const at = (ago: number) => new Date(Date.now() - ago).toISOString()
const hhmm = (iso: string) => {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const unslop = (over: Json = {}): Json => ({
  key: 'mesh.json:unslop', name: 'unslop', where: 'local', endpoint: 'http://127.0.0.1:4420', profile: 'unslop',
  state: 'not-running', reason: 'starts on its first call', fix: null, checkedAt: at(60_000),
  card: null, cardJson: null, lastSeen: { at: at(2 * 60 * 60 * 1000), card: summarizeCard(UNSLOP_CARD) }, ...over,
})
const requestPost = (over: Json = {}): Json => ({
  key: 'mesh.json:request-post', name: 'request-post', where: 'tailnet', endpoint: 'https://request-post.tailnet-name.ts.net',
  profile: null, state: 'up', reason: null, fix: null, checkedAt: at(60_000),
  card: summarizeCard(RP_CARD), cardJson: cardJson(RP_CARD), lastSeen: null, ...over,
})
const body = (...agents: Json[]) => ({ on: true, agents, others: 0 })

/** A stand-in for src/mesh-agents.ts behind the real routes: the test sets what it answers. */
function fakeMesh(first: Json = body(unslop(), requestPost())) {
  const s = {
    version: { agents: 2 } as { agents: number } | undefined,
    body: first,
    triggers: [] as string[],
    // runs as a check would, before the POST answers
    onTrigger: null as null | ((trigger: string) => void),
    hold: null as null | Promise<void>,
  }
  const mesh: MeshAgents = {
    version: () => s.version,
    body: () => s.body,
    runs: () => undefined,
    trigger: async (trigger, name) => {
      s.triggers.push(name === undefined ? trigger : `${trigger} ${name}`)
      if (s.hold) await s.hold
      s.onTrigger?.(trigger)
      return true
    },
  }
  return { s, mesh }
}

interface Booted { bridge: ViewerBridge; log: string[]; s: ReturnType<typeof fakeMesh>['s'] }
async function boot(opts: {
  mesh?: ReturnType<typeof fakeMesh> | null
  intercept?: (url: string, init: RequestInit | undefined, next: () => Promise<Response>) => Promise<Response | null> | null
  seed?: (d: Database.Database) => void
} = {}): Promise<Booted> {
  db = freshDb()
  opts.seed?.(db)
  const fake = opts.mesh === undefined ? fakeMesh() : opts.mesh
  const log: string[] = []
  const bridge = await bootApp(db, {
    viewer: fake ? { mesh: fake.mesh } : {},
    interceptFetch: async (input, init, next) => {
      const url = String(input)
      log.push(`${init?.method ?? 'GET'} ${url}`)
      return (await opts.intercept?.(url, init, next)) ?? next()
    },
  })
  return { bridge, log, s: fake?.s ?? fakeMesh().s }
}

const triggers = (bridge: ViewerBridge) => bridge.posts.filter((p) => p.url === '/api/mesh/agents/refresh')
  .map((p) => (JSON.parse(String(p.init?.body)) as { trigger: string }).trigger)
// the whole bodies, `name` included (cards view V5c1)
const posted = (bridge: ViewerBridge) => bridge.posts.filter((p) => p.url === '/api/mesh/agents/refresh')
  .map((p) => JSON.parse(String(p.init?.body)) as Json)
const meshReads = (log: string[]) => log.filter((entry) => entry === 'GET /api/mesh/agents').length
const section = () => document.querySelector<HTMLElement>('.agents-home .mesh-agents')
const meshRow = (name: string) => [...document.querySelectorAll<HTMLElement>('.mesh-agents .ma-card')]
  .find((el) => el.querySelector('.ma-name')?.textContent === name) ?? null
const shown = () => [...document.querySelectorAll<HTMLElement>('.mesh-agents .ma-card')].map((el) => [
  el.querySelector('.ma-name')?.textContent, el.querySelector('.ma-status')?.textContent,
  el.querySelector('.ma-facts')?.textContent, el.querySelector<HTMLElement>('.ma-fix')?.hidden ? '' : el.querySelector('.ma-fix')?.textContent,
])
const tab = (id: string) => click(document.querySelector(`.tab[data-tab="${id}"]`))
const UP_ROWS = [
  ['request-post', 'Reachable', 'Remote · tailnet · v0.0.0-fixture', ''],
  ['unslop', 'Not running · starts on its first call', 'Local · v0.3.1 · seen 2h ago', ''],
]
// cards view V5c1: pressing a card (V5c2) opens the agent tab; its page holds the details
const agentTab = () => document.querySelector<HTMLElement>('#tabs .tab[data-tab="agent"]')!
const page = () => document.getElementById('agentPage')!
const activeTab = () => document.querySelector('#tabs .tab[aria-selected="true"]')?.getAttribute('data-tab')
async function openAgent(name: string): Promise<void> {
  click(meshRow(name))
  await settle()
}
function openJson(): void {
  const json = page().querySelector<HTMLDetailsElement>('.ma-json')!
  json.open = true
  json.dispatchEvent(new Event('toggle'))
}
const pageLines = () => [...page().querySelectorAll('.ma-lines dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent])
function pointer(el: Element | null, type: 'pointerdown' | 'pointerup'): void {
  el!.dispatchEvent(new window.PointerEvent(type, { bubbles: true }))
}

// The boot reads, then one poll tick's nine reads (test/dom/agents-home.test.ts's BOOT_REQUESTS).
const POLL = ['/api/items', '/api/boards', '/api/boards/archived/summary', '/api/activity',
  '/api/activity/history?since_ms=1781949600000', '/api/projects/closed', '/api/links', '/api/issues', '/api/messages']
const BOOT_REQUESTS = ['/api/version', '/api/setup', ...POLL, ...POLL]

describe('the Mesh agents section (agent cards view V3)', () => {
  it('with no mesh key, the page makes exactly its old reads, posts no check and draws no section', async () => {
    const { bridge, log } = await boot({ mesh: null })
    await pollTick()
    await settle()
    expect(log.map((entry) => entry.replace(/^GET /, ''))).toEqual(BOOT_REQUESTS)
    expect(section()).toBeNull()
    // no navigation posts anything without `mesh` in the last /api/version
    tab('needsYou')
    await settle()
    tab('dashboard')
    await settle()
    click(document.getElementById('sessionsIndicator'))
    await settle()
    await pollTick()
    expect(triggers(bridge)).toEqual([])
    expect(bridge.posts).toEqual([])
    expect(log.some((entry) => entry.includes('/api/mesh/'))).toBe(false)
    expect(section()).toBeNull()

    // a viewer whose mesh shows nothing (no known agent) is the same
    const quiet = fakeMesh()
    quiet.s.version = undefined
    const again = await boot({ mesh: quiet })
    await pollTick()
    expect(triggers(again.bridge)).toEqual([])
    expect(meshReads(again.log)).toBe(0)
  })

  it('draws both cards with the state words and the server’s reason and fix, read only on a visible Dashboard', async () => {
    const { log, s } = await boot()
    await pollTick()
    await settle()
    expect(section()?.querySelector('.ma-toggle')?.textContent).toBe('Mesh agents (2)')
    expect(section()?.querySelector('.ma-toggle')?.getAttribute('aria-expanded')).toBe('true')
    expect(section()?.querySelector('.ma-checked')?.textContent).toBe('checked 1m ago')
    expect(shown()).toEqual(UP_ROWS)
    expect(meshRow('request-post')?.classList.contains('ma-tone-up')).toBe(true)
    expect(meshRow('unslop')?.classList.contains('ma-tone-neutral')).toBe(true)

    // a mismatch names its check and carries the server's fix, amber
    s.body = body(unslop({ state: 'mismatch', reason: 'no unslop skill', fix: 'rebuild packages/mesh', card: summarizeCard(UNSLOP_CARD), cardJson: cardJson(UNSLOP_CARD), lastSeen: null }),
      requestPost({ state: 'unreachable', reason: 'does not resolve (is this Mac on the tailnet?)', card: null, cardJson: null }))
    await pollTick()
    expect(shown()).toEqual([
      ['request-post', 'Unreachable · does not resolve (is this Mac on the tailnet?)', 'Remote · tailnet', ''],
      ['unslop', 'Card does not match this build · no unslop skill', 'Local · v0.3.1', 'Fix: rebuild packages/mesh'],
    ])
    expect(meshRow('unslop')?.classList.contains('ma-tone-amber')).toBe(true)

    // leaving the Dashboard stops the read and keeps the last body
    const reads = meshReads(log)
    tab('needsYou')
    await settle()
    s.body = body(unslop(), requestPost())
    await pollTick()
    await pollTick()
    expect(meshReads(log)).toBe(reads)
    tab('dashboard')
    await settle()
    expect(shown()[0]?.[1]).toBe('Unreachable · does not resolve (is this Mac on the tailnet?)')
    await pollTick()
    expect(meshReads(log)).toBe(reads + 1)
    expect(shown()).toEqual(UP_ROWS)

    // a hidden window reads nothing
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    await pollTick()
    await pollTick()
    expect(meshReads(log)).toBe(reads + 1)
    delete (document as unknown as Record<string, unknown>).visibilityState
    await pollTick()
    expect(meshReads(log)).toBe(reads + 2)
  })

  it('every state reads in the page’s words; unknown agents are counted, never named', () => {
    const now = Date.now()
    const words = (agent: Json) => meshRows(body(agent), now).rows[0]?.status
    expect(words(unslop({ state: 'unchecked', reason: 'press Refresh', checkedAt: null, lastSeen: null }))).toBe('Not checked yet · press Refresh')
    expect(words(unslop({ state: 'checking', reason: null }))).toBe('Checking…')
    expect(words(unslop({ state: 'up', reason: null }))).toBe('Running')
    expect(words(requestPost())).toBe('Reachable')
    expect(words(unslop({ state: 'not-a-card', reason: 'something other than the unslop agent answers (HTTP 404)' })))
      .toBe('Not an agent card · something other than the unslop agent answers (HTTP 404)')
    const invalid = meshRows(body(requestPost({ state: 'invalid', where: null, endpoint: null, card: null, fix: 'run the status command' })), now).rows[0]!
    expect([invalid.status, invalid.fix, invalid.facts, invalid.tone]).toEqual(['Endpoint not accepted', 'Fix: run the status command', 'Remote', 'amber'])
    expect(meshRows({ ...body(unslop()), others: 1 }, now).others).toBe('1 other agent in mesh.json is not shown by this build')
    expect(meshRows({ ...body(unslop()), others: 2 }, now).others).toBe('2 other agents in mesh.json are not shown by this build')
    expect(meshRows(body(unslop({ checkedAt: null }), requestPost({ checkedAt: null })), now).checked).toBe('not checked yet')
  })

  describe('the open trigger, one per navigation', () => {
    it('booting on the Dashboard posts one open once the boot’s /api/version carries mesh', async () => {
      const { bridge, s } = await boot()
      expect(triggers(bridge)).toEqual(['open'])
      expect(s.triggers).toEqual(['open'])
      // a poll tick, reloadAndPaint() (Refresh) and re-selecting the Dashboard post no open
      await pollTick()
      tab('dashboard')
      await settle()
      click(section()?.querySelector('.ma-refresh'))
      await settle()
      expect(triggers(bridge)).toEqual(['open', 'refresh'])
    })

    it('booting on another tab posts none; selecting the Dashboard from it posts one, and again while there none', async () => {
      let release = () => {}
      const held = new Promise<void>((done) => { release = done })
      const { bridge } = await boot({ intercept: (url, _init, next) => (url === '/api/version' ? held.then(next) : null) })
      tab('needsYou')
      await settle()
      release()
      await settle()
      await pollTick()
      expect(triggers(bridge)).toEqual([])
      tab('dashboard')
      await settle()
      expect(triggers(bridge)).toEqual(['open'])
      tab('dashboard')
      await settle()
      expect(triggers(bridge)).toEqual(['open'])
    })

    it('showAgentsHome() posts exactly one from another tab and one from the Dashboard', async () => {
      const { bridge } = await boot()
      expect(triggers(bridge)).toEqual(['open'])
      tab('boards')
      await settle()
      click(document.getElementById('sessionsIndicator'))
      await settle()
      expect(document.querySelector('.tab[data-tab="dashboard"]')?.getAttribute('aria-selected')).toBe('true')
      expect(triggers(bridge)).toEqual(['open', 'open'])
      click(document.getElementById('sessionsIndicator'))
      await settle()
      expect(triggers(bridge)).toEqual(['open', 'open', 'open'])
    })

    it('opening a session panel and a Setup install re-read /api/version and post nothing', async () => {
      const install = vi.fn(async (target: string) => ({ ok: true, exitCode: 0, target, timedOut: false, output: 'installed' }))
      Object.defineProperty(window, 'agentInboxSetup', { configurable: true, value: { available: async () => true, install } })
      const { bridge, log } = await boot({
        seed: (d) => {
          upsertActivity(d, { session: 'k2', agent: 'claude-code', project: 'demo', stream: 'main', doing: 'open', idle: true, claim: false, receives_messages: true })
          insertItem(d, { project: 'demo', stream: 'main', agent: 'claude-code', session: 'k2', kind: 'question', title: 'Retry 4xx?' })
        },
      })
      await pollTick()
      const versions = () => log.filter((entry) => entry === 'GET /api/version').length
      const before = versions()
      click(document.querySelector('[data-session-card="session:k2"] [data-ah-action="review"]'))
      await settle()
      expect(document.querySelector<HTMLElement>('#dashboard .dash-focus')?.hidden).toBe(false)
      click(document.querySelector('.setup-run-btn'))
      await settle()
      expect(install).toHaveBeenCalledTimes(1)
      expect(versions()).toBe(before + 2)
      expect(triggers(bridge)).toEqual(['open'])
      // nor does a session panel opened from another tab (the Inbox's Show on Agents ›)
      await showInbox()
      click(rows()[0])
      await settle()
      click(document.querySelector('.nrow-show-agents'))
      await settle()
      expect(document.querySelector('.tab[data-tab="dashboard"]')?.getAttribute('aria-selected')).toBe('true')
      expect(document.querySelector<HTMLElement>('#dashboard .dash-focus')?.dataset.session).toBe('k2')
      expect(versions()).toBe(before + 3)
      expect(triggers(bridge)).toEqual(['open'])
    })
  })

  it('an open paints through the next poll tick, never reloadAndPaint(); a held press defers that paint', async () => {
    const { bridge, log, s } = await boot()
    await pollTick()
    expect(shown()).toEqual(UP_ROWS)
    tab('needsYou')
    await settle()
    s.onTrigger = () => { s.body = body(unslop({ state: 'up', reason: null, card: summarizeCard(UNSLOP_CARD), cardJson: cardJson(UNSLOP_CARD), lastSeen: null, checkedAt: at(0) }), requestPost()) }
    const loads = () => log.filter((entry) => entry === 'GET /api/items').length
    // just before a tick, so the one after the open lands under a held press
    const ticks = loads()
    while (loads() === ticks) await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(2800)
    const before = loads()
    tab('dashboard')
    await settle()
    expect(triggers(bridge)).toEqual(['open', 'open'])
    // the POST answered with the new state; nothing loaded or painted for it
    expect(s.triggers).toEqual(['open', 'open'])
    expect(loads()).toBe(before)
    expect(shown()).toEqual(UP_ROWS)

    // a press held across that tick keeps the cards; the tick after it paints
    const pressed = meshRow('unslop')!
    pointer(pressed, 'pointerdown')
    await vi.advanceTimersByTimeAsync(300)
    expect(loads()).toBe(before + 1)
    expect(shown()).toEqual(UP_ROWS)
    pointer(pressed, 'pointerup')
    // a selection in the section is kept across the tick that paints, as for any other tick
    const name = meshRow('request-post')!.querySelector('.ma-name')!.firstChild!
    const range = document.createRange()
    range.setStart(name, 0)
    range.setEnd(name, 7)
    document.getSelection()!.removeAllRanges()
    document.getSelection()!.addRange(range)
    await pollTick()
    expect(shown()[1]).toEqual(['unslop', 'Running', 'Local · v0.3.1', ''])
    expect([name.isConnected, String(document.getSelection())]).toEqual([true, 'request'])
  })

  describe('the section is global', () => {
    function seed(d: Database.Database): void {
      insertItem(d, { project: 'agent-inbox', stream: 'main', agent: 'copilot', kind: 'question', title: 'Ship it?' })
      insertItem(d, { project: 'zeta', stream: 'main', agent: 'claude-code', kind: 'note', title: 'A note' })
      upsertActivity(d, { session: 'c1', agent: 'copilot', project: 'agent-inbox', stream: 'main', doing: 'Writing tests' })
      recordActivityCall(d, 'c1')
    }

    it('shows the same cards under every state filter and a project and agent lens that hides every session', async () => {
      await boot({ seed })
      await pollTick()
      const expected = shown()
      expect(expected).toEqual(UP_ROWS)
      for (const key of ['ask', 'working', 'parked']) {
        click(document.querySelector(`.agents-home [data-ah-filter="${key}"]`))
        expect(shown(), key).toEqual(expected)
      }
      click(document.querySelector('.agents-home [data-ah-filter="all"]'))
      click(document.querySelector('#rail button.rail-tab[data-project="zeta"]'))
      await settle()
      const agent = document.getElementById('agentSelect') as HTMLSelectElement
      agent.value = 'claude-code'
      agent.dispatchEvent(new Event('change', { bubbles: true }))
      await settle()
      expect(document.querySelectorAll('.agents-home [data-session-card]')).toHaveLength(0)
      expect(shown()).toEqual(expected)
      await pollTick()
      expect(shown()).toEqual(expected)
    })

    it('shows with no session at all, under the empty state’s text', async () => {
      await boot()
      await pollTick()
      const empty = document.querySelector<HTMLElement>('.agents-home .ah-empty')!
      expect(empty.hidden).toBe(false)
      expect(shown()).toEqual(UP_ROWS)
      expect(empty.compareDocumentPosition(section()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })
  })

  it('a failed read keeps the cards, marked stale, and never fails the tick; an off body hides the section until /api/version says mesh again', async () => {
    let failure: (() => Response) | null = null
    const { bridge, log, s } = await boot({ intercept: (url) => (url === '/api/mesh/agents' && failure ? Promise.resolve(failure()) : null) })
    await pollTick()
    const stale = () => section()!.querySelector<HTMLElement>('.ma-stale')!
    expect(stale().hidden).toBe(true)
    for (const make of [
      () => new Response('boom', { status: 500 }),
      () => new Response('<html>not found</html>', { status: 404 }),
      () => new Response(JSON.stringify({ on: true, agents: [{ name: 'unslop' }] }), { status: 200, headers: { etag: '"x"' } }),
    ]) {
      failure = make
      s.body = body(unslop({ state: 'up', reason: null }))
      await pollTick()
      expect(shown()).toEqual(UP_ROWS)
      expect([stale().hidden, stale().textContent]).toEqual([false, 'could not read; showing what was last read'])
      expect(document.getElementById('status')?.textContent).not.toBe('disconnected')
    }
    failure = null
    s.body = body(unslop(), requestPost())
    await pollTick()
    expect(stale().hidden).toBe(true)

    // off: the section goes and the reads stop
    s.body = { on: false, agents: [] }
    s.version = undefined
    await pollTick()
    expect(section()).toBeNull()
    const reads = meshReads(log)
    await pollTick()
    await pollTick()
    expect(meshReads(log)).toBe(reads)
    // a /api/version read without mesh changes nothing; one with it brings the section back
    click(document.getElementById('sessionsIndicator'))
    await settle()
    await pollTick()
    expect(meshReads(log)).toBe(reads)
    s.version = { agents: 2 }
    s.body = body(unslop(), requestPost())
    click(document.getElementById('sessionsIndicator'))
    await settle()
    await pollTick()
    expect(meshReads(log)).toBe(reads + 1)
    expect(shown()).toEqual(UP_ROWS)
    expect(triggers(bridge)).toEqual(['open', 'open'])
  })

  // The same seed with the mesh off and on: what the human's attention reads does not move.
  describe('the attention surfaces equal the run without mesh', () => {
    const SURFACES = { title: '(2) Agent Inbox', badge: 2, tabs: ['2', '1', '1', '', ''], needsYou: ['Approve it.', 'Ship it?'] }
    function seed(d: Database.Database): void {
      insertItem(d, { project: 'agent-inbox', stream: 'main', agent: 'copilot', kind: 'question', title: 'Ship it?' })
      advanceClock()
      insertItem(d, { project: 'demo', stream: 'main', agent: 'claude-code', kind: 'note', title: 'Flaky test noted' })
      advanceClock()
      upsertBoard(d, {
        project: 'agent-inbox', stream: 'spec', agent: 'claude-code', title: 'Mesh metrics',
        rows: [{ label: 'Approve the metric set', status: 'blocked', note: 'Drafted.', next_step: 'Approve it.', action_owner: 'approval',
          impact: 'Unblocks M2.', options: [{ label: 'Approve', recommended: true }, { label: 'Hold' }] }],
      })
    }
    async function surfaces() {
      return {
        title: document.title,
        badge: badgeCount(),
        tabs: ['needsYou', 'notes', 'boards', 'done', 'agent'].map(tabCount),
        needsYou: await (async () => { await showInbox(); return rows().map((el) => el.querySelector('.nrow-title')?.textContent) })(),
      }
    }
    const railCounts = () => [...document.querySelectorAll('#rail .rail-tab')].map((el) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '')
    let railOff: string[] = []
    it.each([['off', null], ['on, every row amber', 'amber'], ['on, the agent tab open', 'tab']] as const)('mesh %s', async (_label, mode) => {
      const fake = mode ? fakeMesh(body(unslop({ state: 'mismatch', reason: 'no unslop skill', fix: 'rebuild packages/mesh' }),
        requestPost({ state: 'unreachable', reason: 'connection refused', card: null, cardJson: null }))) : null
      await boot({ mesh: fake, seed })
      await pollTick()
      await settle()
      expect(Boolean(section())).toBe(Boolean(mode))
      if (mode === 'tab') {
        await openAgent('unslop')
        await pollTick()
        expect(agentTab().hidden).toBe(false)
        expect(agentTab().querySelector('.tab-count')).toBeNull()
      }
      // the rail as the run without mesh drew it (it.each runs in order)
      if (!mode) railOff = railCounts()
      expect(railCounts()).toEqual(railOff)
      expect(await surfaces()).toEqual(SURFACES)
    })
  })

  it('a hostile card: no img, no link from card data, no request to its URLs, the text shown literally', async () => {
    const hostile: Json = {
      ...RP_CARD,
      name: '<img src=x onerror="alert(1)">',
      description: '<a href="https://evil.example/">click</a><script>alert(2)</script>',
      iconUrl: 'https://evil.example/icon.png', documentationUrl: 'https://evil.example/docs', provider: { url: 'https://evil.example/' },
      supportedInterfaces: [{ url: 'https://evil.example/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
      skills: [{ id: 'request-post', name: '<b>bold</b>', description: 'x', tags: ['<i>tag</i>'] }],
    }
    const { log } = await boot({ mesh: fakeMesh(body(requestPost({ state: 'mismatch', reason: 'no request-post-status skill', fix: 'update agent-inbox or the service', card: summarizeCard(hostile), cardJson: cardJson(hostile) }))) })
    const images = document.querySelectorAll('img').length
    await pollTick()
    await openAgent('request-post')
    openJson()
    const row = page()
    const lines = [...row.querySelectorAll('.ma-lines dd')].map((dd) => dd.textContent)
    expect(lines).toContain('<a href="https://evil.example/">click</a><script>alert(2)</script>')
    expect(lines).toContain('<img src=x onerror="alert(1)">')
    expect(lines.some((line) => line?.includes('https://evil.example/a2a'))).toBe(true)
    expect([...row.querySelectorAll('.ma-tag')].map((el) => el.textContent)).toEqual(['<i>tag</i>'])
    expect(row.querySelector('.ma-json-text')?.textContent).toBe(cardJson(hostile))
    expect(section()!.querySelectorAll('img, a, script, b, i, [href], [src]')).toHaveLength(0)
    expect(page().querySelectorAll('img, a, script, b, i, [href], [src]')).toHaveLength(0)
    expect(agentTab().querySelectorAll('img, a, [href], [src]')).toHaveLength(0)
    expect(document.querySelectorAll('img')).toHaveLength(images)
    await pollTick()
    expect(log.filter((entry) => !/^(GET|POST) \/api\//.test(entry))).toEqual([])
    expect(log.some((entry) => entry.includes('evil.example'))).toBe(false)
  })

  it('unslop\'s usage line (V4): the design\'s words as text, absent with no usage key, unchanged on an idle tick', async () => {
    const statuses: number[] = []
    const { s } = await boot({
      mesh: fakeMesh(body(unslop({ usage: { date: '2026-11-09', tasks: 12, modelMs: 480000 } }), requestPost())),
      intercept: async (url, _init, next) => {
        if (url !== '/api/mesh/agents') return null
        const res = await next()
        statuses.push(res.status)
        return res
      },
    })
    await pollTick()
    const usage = (name: string) => meshRow(name)!.querySelector<HTMLElement>('.ma-usage')!
    expect(usage('unslop').hidden).toBe(false)
    expect(usage('unslop').textContent).toBe('Today: 12 tasks · 8 model-minutes')
    expect(usage('unslop').children).toHaveLength(0)
    expect(usage('request-post').hidden).toBe(true)
    expect(usage('request-post').textContent).toBe('')
    expect(shown()).toEqual(UP_ROWS)

    const records: MutationRecord[] = []
    const observer = new MutationObserver((list) => records.push(...list))
    observer.observe(section()!, { subtree: true, childList: true, characterData: true, attributes: true })
    await pollTick()
    expect(statuses.at(-1)).toBe(304)
    expect(records).toEqual([])
    observer.disconnect()

    s.body = body(unslop(), requestPost())
    await pollTick()
    expect(usage('unslop').hidden).toBe(true)
    expect(usage('unslop').textContent).toBe('')

    const words = (u: unknown) => meshRows(body(unslop({ usage: u })), Date.now()).rows[0]!.usage
    expect(words({ date: '2026-11-09', tasks: 1, modelMs: 60_000 })).toBe('Today: 1 task · 1 model-minute')
    expect(words({ date: '2026-11-09', tasks: 0, modelMs: 0 })).toBe('Today: 0 tasks · 0 model-minutes')
    expect(words({ tasks: '<b>12</b>', modelMs: 1 })).toBe('')
    expect(words(null)).toBe('')
  })

  it('an idle tick (a 304) changes no node; a selection in an open Card JSON survives a Refresh that moved only checkedAt', async () => {
    const statuses: number[] = []
    const { s } = await boot({
      intercept: async (url, _init, next) => {
        if (url !== '/api/mesh/agents') return null
        const res = await next()
        statuses.push(res.status)
        return res
      },
    })
    await pollTick()
    await openAgent('request-post')
    openJson()
    await pollTick()
    const records: MutationRecord[] = []
    const observer = new MutationObserver((list) => records.push(...list))
    observer.observe(section()!, { subtree: true, childList: true, characterData: true, attributes: true })
    observer.observe(page(), { subtree: true, childList: true, characterData: true, attributes: true })
    observer.observe(agentTab(), { subtree: true, childList: true, characterData: true, attributes: true })
    await pollTick()
    await pollTick()
    // the agent tab keeps the read going, and a 304 paints nothing on it
    expect(statuses.slice(-2)).toEqual([304, 304])
    expect(records).toEqual([])
    observer.disconnect()

    const pre = page().querySelector('.ma-json-text')!
    const text = pre.firstChild!
    const range = document.createRange()
    range.setStart(text, 2)
    range.setEnd(text, 40)
    document.getSelection()!.removeAllRanges()
    document.getSelection()!.addRange(range)
    const selected = String(document.getSelection())
    s.onTrigger = () => { s.body = body(unslop(), requestPost({ checkedAt: at(0) })) }
    click(page().querySelector('.map-refresh'))
    await settle()
    expect(s.triggers.at(-1)).toBe('refresh request-post')
    expect(page().querySelector('.map-checked')?.textContent).toBe('checked just now')
    expect([...page().querySelectorAll('.ma-lines dd')].at(-1)?.textContent).toBe(`checked ${hhmm(at(0))} · card fetched ${hhmm(at(0))}`)
    expect(pre.firstChild).toBe(text)
    expect(text.isConnected).toBe(true)
    expect(String(document.getSelection())).toBe(selected)

    // and a poll whose body moved only checkedAt
    s.body = body(unslop(), requestPost({ checkedAt: at(0) }))
    await pollTick()
    expect([pre.firstChild, text.isConnected, String(document.getSelection())]).toEqual([text, true, selected])
  })

  it('Refresh sits in the header row outside the disclosure: it posts refresh, then (and only then) repaints through reloadAndPaint()', async () => {
    let release = () => {}
    let holding = false
    const { bridge, log, s } = await boot({
      intercept: (url, _init, next) => (url === '/api/mesh/agents/refresh' && holding ? new Promise<void>((done) => { release = done }).then(next) : null),
    })
    await pollTick()
    const toggle = section()!.querySelector('.ma-toggle')!
    const refresh = section()!.querySelector('.ma-refresh')!
    expect(toggle.contains(refresh)).toBe(false)
    expect(refresh.parentElement).toBe(toggle.parentElement)
    expect(section()!.querySelector('summary .ma-refresh')).toBeNull()

    holding = true
    s.onTrigger = () => { s.body = body(unslop({ state: 'checking', reason: null }), requestPost()) }
    const loads = () => log.filter((entry) => entry === 'GET /api/items').length
    const before = loads()
    click(refresh)
    await vi.advanceTimersByTimeAsync(0)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(triggers(bridge)).toEqual(['open', 'refresh'])
    // nothing reloads while the checks run
    expect(loads()).toBe(before)
    release()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(loads()).toBe(before + 1)
    expect(log.lastIndexOf('POST /api/mesh/agents/refresh')).toBeLessThan(log.lastIndexOf('GET /api/items'))
    expect(shown()[1]?.[1]).toBe('Checking…')
  })

  it('the toggles are window-local, repaint at once and are in frameInputs()', async () => {
    const { s } = await boot()
    await pollTick()
    const toggle = () => section()!.querySelector('.ma-toggle')!
    click(toggle())
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(section()!.querySelector<HTMLElement>('.ma-body')?.hidden).toBe(true)
    click(toggle())
    await openAgent('unslop')
    expect(page().hidden).toBe(false)
    // the last good card's details, marked as such; Card JSON only for a card fetched now
    const lines = pageLines()
    expect(lines).toContainEqual(['Where', 'Local · http://127.0.0.1:4420profile: unslop'])
    expect(lines).toContainEqual(['Auth', 'bearer (HTTP Bearer), requiredtoken kept outside the app; not shown here'])
    expect(lines).toContainEqual(['Extension', 'urn:agent-inbox:ext:unslop:v1 · requiredapi 1 · skillId unslop · rulesSha256 3f9a1c0e7b22 · bytes 6204'])
    expect(lines).toContainEqual(['Modes', 'in text/plain · out text/plain'])
    expect(page().querySelector<HTMLElement>('.ma-json')?.hidden).toBe(true)
    // the open agent survives polls, a changed body included, and nothing is stored
    s.body = body(unslop({ checkedAt: at(0) }), requestPost())
    await pollTick()
    expect([activeTab(), page().querySelector('.map-name')?.textContent]).toEqual(['agent', 'unslop'])
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toMatch(/mesh|unslop/i)
    // pinned as source: the section's state joins agentsHome.state(), the page's its own, and both frameInputs()
    const app = readFileSync(resolve(REPO, 'public', 'app.js'), 'utf8')
    const frame = app.slice(app.indexOf('function frameInputs()'), app.indexOf('function noteOutsideChange'))
    expect(frame).toContain('agentsHome.state()')
    expect(frame).toContain('meshAgentPage.state()')
    expect(readFileSync(resolve(REPO, 'public', 'agents-home.js'), 'utf8')).toMatch(/state: \(\) => \[[^\n]*mesh\.state\(\)/)
  })

  describe('the agent tab (cards view V5c1)', () => {
    const pressKey = (key: string) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    const heading = () => [document.getElementById('pageKicker')?.textContent, document.getElementById('pageTitle')?.textContent]
    const rowButton = (name: string) => meshRow(name)

    it('with no mesh key there is no agent tab, and selecting it does nothing', async () => {
      const { bridge, log } = await boot({ mesh: null })
      await pollTick()
      await settle()
      expect(log.map((entry) => entry.replace(/^GET /, ''))).toEqual(BOOT_REQUESTS)
      expect([agentTab().hidden, page().hidden]).toEqual([true, true])
      click(agentTab())
      await settle()
      expect([activeTab(), page().hidden, agentTab().hidden]).toEqual(['dashboard', true, true])
      expect(bridge.posts).toEqual([])
    })

    it('pressing a card opens the agent in the one tab: one open for it, one reloadAndPaint(); Close returns to its card', async () => {
      const { bridge, log, s } = await boot()
      await pollTick()
      const loads = () => log.filter((entry) => entry === 'GET /api/items').length
      const before = loads()
      await openAgent('unslop')
      expect([agentTab().hidden, agentTab().querySelector('.tab-name')?.textContent, activeTab()]).toEqual([false, 'unslop', 'agent'])
      expect([page().hidden, document.getElementById('dashboard')?.hidden]).toEqual([false, true])
      expect(heading()).toEqual(['Mesh agent', 'unslop'])
      expect(page().querySelector('.map-status')?.textContent).toBe('Not running · starts on its first call')
      expect(page().querySelector('.map-checked')?.textContent).toBe('checked 1m ago')
      expect(posted(bridge)).toEqual([{ trigger: 'open' }, { trigger: 'open', name: 'unslop' }])
      expect(s.triggers).toEqual(['open', 'open unslop'])
      expect(loads()).toBe(before + 1)
      // until V5d the page opens on Details, its inner tablist's only tab
      const inner = [...page().querySelectorAll<HTMLElement>('.map-tabs [role="tab"]')]
      expect(inner.map((t) => [t.textContent, t.getAttribute('aria-selected'), t.tabIndex])).toEqual([['Details', 'true', 0]])
      expect(page().querySelector(`#${inner[0]!.getAttribute('aria-controls')}`)?.getAttribute('aria-labelledby')).toBe(inner[0]!.id)

      // an inner tab, the active agent tab and a poll post nothing
      click(inner[0])
      click(agentTab())
      await settle()
      await pollTick()
      expect(posted(bridge)).toHaveLength(2)
      // the agent tab from another tab is an open for that agent; it stays in the list meanwhile
      tab('needsYou')
      await settle()
      expect(agentTab().hidden).toBe(false)
      tab('agent')
      await settle()
      expect(posted(bridge).slice(2)).toEqual([{ trigger: 'open', name: 'unslop' }])

      // Close: the Dashboard (one open for every agent), focus on the agent's card in a focused window
      vi.spyOn(document, 'hasFocus').mockReturnValue(true)
      page().querySelector<HTMLElement>('.map-close')!.focus()
      click(page().querySelector('.map-close'))
      await settle()
      expect([activeTab(), agentTab().hidden, page().hidden]).toEqual(['dashboard', true, true])
      expect(posted(bridge).slice(3)).toEqual([{ trigger: 'open' }])
      expect(document.activeElement).toBe(rowButton('unslop'))
      expect(heading()).toEqual(['Monitor', 'Live Operations Desk'])

      // a second press within 60 s posts one open (the server skips the check)
      await openAgent('unslop')
      expect(posted(bridge).slice(4)).toEqual([{ trigger: 'open', name: 'unslop' }])
      // another agent replaces it in the same slot
      tab('dashboard')
      await settle()
      await openAgent('request-post')
      expect(document.querySelectorAll('#tabs .tab:not([hidden])')).toHaveLength(6)
      expect([agentTab().querySelector('.tab-name')?.textContent, page().querySelector('.map-name')?.textContent, heading()[1]])
        .toEqual(['request-post', 'request-post', 'request-post'])
      expect(pageLines()).toContainEqual(['Where', 'Remote · https://request-post.tailnet-name.ts.net'])
      expect(pageLines().find(([label]) => label === 'Where')).not.toContain('profile: unslop')
      expect(agentTab().classList.contains('ma-tone-up')).toBe(true)
      expect(posted(bridge).slice(6)).toEqual([{ trigger: 'open', name: 'request-post' }])
    })

    it('Settings opened over the agent tab keeps its title through a forced paint and a changed poll', async () => {
      const { s } = await boot()
      await pollTick()
      await openAgent('unslop')
      expect(heading()).toEqual(['Mesh agent', 'unslop'])
      click(document.getElementById('gear'))
      await settle()
      expect(heading()).toEqual(['Agent Inbox', 'Settings'])
      s.body = body(unslop({ checkedAt: at(0) }), requestPost())
      await pollTick()
      click(section()!.querySelector('.ma-toggle'))
      await settle()
      expect(heading()).toEqual(['Agent Inbox', 'Settings'])
      click(document.getElementById('gear'))
      await settle()
      expect([activeTab(), heading()]).toEqual(['agent', ['Mesh agent', 'unslop']])
    })

    it('no path lands on an empty agent tab: roving, G keys, a hash, a focus bookmark', async () => {
      let id = ''
      await boot({ seed: (d) => { id = insertItem(d, { project: 'demo', stream: 'main', agent: 'copilot', kind: 'question', title: 'Ship it?' }) } })
      await pollTick()
      vi.spyOn(document, 'hasFocus').mockReturnValue(true)
      // a bookmark captured while the tab was open, then the tab closed
      await openAgent('unslop')
      page().querySelector<HTMLElement>('.map-refresh')!.focus()
      await pollTick()
      expect(document.activeElement).toBe(page().querySelector('.map-refresh'))
      click(page().querySelector('.map-close'))
      await settle()
      await pollTick()
      expect([activeTab(), document.activeElement]).toEqual(['dashboard', rowButton('unslop')])

      // roving in the library's tablist skips the hidden tab: End lands on History
      const dashboardTab = document.querySelector<HTMLElement>('#tabs .tab[data-tab="dashboard"]')!
      dashboardTab.focus()
      dashboardTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
      expect(document.activeElement?.getAttribute('data-tab')).toBe('done')
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
      expect(document.activeElement?.getAttribute('data-tab')).toBe('dashboard')

      // every G destination: none is the agent tab
      for (const key of ['d', 'i', 'p', 'n', 'h', 'l']) {
        ;(document.activeElement as HTMLElement | null)?.blur()
        pressKey('g')
        pressKey(key)
        await settle()
        expect([activeTab(), agentTab().hidden, page().hidden], key).toEqual([activeTab(), true, true])
        expect(activeTab(), key).not.toBe('agent')
      }
      // an item hash lands on the item's own tab
      tab('dashboard')
      await settle()
      navigateToHash(`#item/${id}`)
      await settle()
      expect([activeTab(), page().hidden]).toEqual(['needsYou', true])
      // and the hidden tab's own click (selectTab('agent')) does nothing
      click(agentTab())
      await settle()
      expect(activeTab()).toBe('needsYou')
    })

    it('an agent leaving mesh.json keeps the tab under one line; a reload starts with no agent tab', async () => {
      const { s } = await boot()
      await pollTick()
      await openAgent('request-post')
      const gone = page().querySelector<HTMLElement>('.map-gone')!
      expect(gone.hidden).toBe(true)
      const lines = pageLines()
      s.body = body(unslop())
      await pollTick()
      expect([activeTab(), agentTab().hidden, gone.hidden, gone.textContent]).toEqual(['agent', false, false, 'This agent is not in mesh.json any more'])
      expect(pageLines()).toEqual(lines)
      s.body = body(unslop(), requestPost())
      await pollTick()
      expect(gone.hidden).toBe(true)
      // mesh off: the same line, the tab kept
      s.body = { on: false, agents: [] }
      s.version = undefined
      await pollTick()
      expect([activeTab(), agentTab().hidden, gone.hidden]).toEqual(['agent', false, false])

      expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toMatch(/request-post|agentPage/)
      db?.close()
      db = null
      await boot()
      await pollTick()
      expect([agentTab().hidden, page().hidden, activeTab()]).toEqual([true, true, 'dashboard'])
    })
  })

  describe('the card strip (cards view V5c2)', () => {
    const strip = () => section()!.querySelector<HTMLElement>('.ma-strip')!
    const cards = () => [...strip().querySelectorAll<HTMLElement>(':scope > li > .ma-card')]
    const names = () => cards().map((el) => el.querySelector('.ma-name')?.textContent)
    const tabbable = () => cards().filter((el) => el.tabIndex === 0).map((el) => el.querySelector('.ma-name')?.textContent)
    const key = (el: Element | null, k: string) => {
      const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })
      el!.dispatchEvent(event)
      return event
    }
    const described = (el: HTMLElement) => (el.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent)
    const webSearch = (over: Json = {}) => requestPost({ key: 'mesh.json:web-search', name: 'web-search', ...over })

    it('draws one fixed-size card per agent, a native button named by agent and state, the other lines its description', async () => {
      await boot({ mesh: fakeMesh(body(unslop({ usage: { date: '2026-11-09', tasks: 12, modelMs: 480000 } }), requestPost())) })
      await pollTick()
      expect([strip().tagName, strip().getAttribute('role')]).toEqual(['UL', 'list'])
      expect([...strip().children].map((li) => [li.tagName, li.children.length, (li as HTMLElement).dataset.meshKey]))
        .toEqual([['LI', 1, 'mesh.json:request-post'], ['LI', 1, 'mesh.json:unslop']])
      expect(cards().map((el) => [el.tagName, el.getAttribute('type')])).toEqual([['BUTTON', 'button'], ['BUTTON', 'button']])
      expect(shown()).toEqual(UP_ROWS)
      // V5 §2.1: no skill count, protocol or description on a card (Details has them)
      expect(section()!.textContent).not.toMatch(/A2A|skill|Removes generic/)
      const [rp, un] = cards()
      expect(un!.getAttribute('aria-label')).toBe('unslop, Not running')
      expect(rp!.getAttribute('aria-label')).toBe('request-post, Reachable')
      expect(described(un!)).toEqual(['Not running · starts on its first call', 'Local · v0.3.1 · seen 2h ago', 'Today: 12 tasks · 8 model-minutes'])
      expect(described(rp!)).toEqual(['Reachable', 'Remote · tailnet · v0.0.0-fixture'])
      // ids from a counter, never from a name
      expect(cards().flatMap((el) => described(el).length ? (el.getAttribute('aria-describedby') ?? '').split(' ') : []).join(' ')).not.toMatch(/unslop|request/)
      expect(cards().some((el) => el.hasAttribute('aria-current'))).toBe(false)

      // fixed width and height, every line one line; the strip scrolls sideways
      attachStylesheet()
      expect(getComputedStyle(un!).height).toBe('116px')
      expect(getComputedStyle(un!.querySelector('.ma-status')!).whiteSpace).toBe('nowrap')
      expect(getComputedStyle(strip()).overflowX).toBe('auto')
      // jsdom drops what it cannot parse (min(), gradients), so the rest is pinned as source
      const css = readFileSync(resolve(REPO, 'public', 'style.css'), 'utf8')
      const rule = css.slice(css.indexOf('.ma-strip {'), css.indexOf('}', css.indexOf('.ma-strip {')))
      expect(rule).toContain('scrollbar-width: thin')
      expect(rule).toContain('scroll-snap-type: x proximity')
      for (const edge of ['left', 'right']) {
        expect(rule).toMatch(new RegExp(`${edge} center / 28px 100% no-repeat local`))
        expect(rule).toMatch(new RegExp(`${edge} center / 14px 100% no-repeat scroll`))
      }
      expect(css.slice(css.indexOf('.ma-card {'), css.indexOf('}', css.indexOf('.ma-card {')))).toContain('width: min(232px, 78cqi);')
      expect(css).toContain('.ma-card[aria-current="true"] { border-color: var(--app-border-strong); }')
      const mesh = css.slice(css.indexOf('.ma-body[hidden]'), css.indexOf('.ma-lines {'))
      expect(mesh).not.toMatch(/transition|animation|scroll-behavior/)
    })

    it('one card is tabbable; Left, Right, Home and End move focus without animating; J and K never reach the strip', async () => {
      const { s } = await boot({
        mesh: fakeMesh(body(unslop(), requestPost(), webSearch())),
        seed: (d) => {
          for (const id of ['s1', 's2']) upsertActivity(d, { session: id, agent: 'copilot', project: 'demo', stream: 'main', doing: `Working ${id}` })
        },
      })
      await pollTick()
      // the harness installs its own scrollIntoView as it mounts, so the spy comes after
      const scrolls: unknown[] = []
      vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element, arg?: boolean | ScrollIntoViewOptions) { scrolls.push([this, arg]) })
      expect(names()).toEqual(['request-post', 'unslop', 'web-search'])
      expect(tabbable()).toEqual(['request-post'])
      const [first, middle, last] = cards()
      first!.focus()
      expect(key(first!, 'ArrowRight').defaultPrevented).toBe(true)
      expect([document.activeElement, tabbable()]).toEqual([middle, ['unslop']])
      expect(scrolls.at(-1)).toEqual([middle, { block: 'nearest', inline: 'nearest' }])
      key(middle!, 'End')
      expect(document.activeElement).toBe(last)
      key(last!, 'ArrowRight')
      expect(document.activeElement).toBe(last)
      key(last!, 'Home')
      expect(document.activeElement).toBe(first)
      key(first!, 'ArrowLeft')
      expect(document.activeElement).toBe(first)
      key(first!, 'End')
      expect(tabbable()).toEqual(['web-search'])

      // an idle tick changes no node and keeps the roving card and focus
      const records: MutationRecord[] = []
      const observer = new MutationObserver((list) => records.push(...list))
      observer.observe(section()!, { subtree: true, childList: true, characterData: true, attributes: true })
      await pollTick()
      expect(records).toEqual([])
      observer.disconnect()
      expect([document.activeElement, tabbable()]).toEqual([last, ['web-search']])

      // J and K on a card do nothing; Enter is left to the native button
      for (const k of ['j', 'k', 'J', 'K']) {
        expect(key(last!, k).defaultPrevented, k).toBe(false)
        expect(document.activeElement, k).toBe(last)
      }
      expect(key(last!, 'Enter').defaultPrevented).toBe(false)
      expect(activeTab()).toBe('dashboard')
      // and from the session cards, J and K stop at their own last and first card
      const sessions = [...document.querySelectorAll<HTMLElement>('.agents-home [data-session-card]')]
      expect(sessions).toHaveLength(2)
      sessions[0]!.focus()
      expect(document.activeElement).toBe(sessions[0])
      key(sessions[0]!, 'k')
      expect(document.activeElement).toBe(sessions[0])
      key(sessions[0]!, 'j')
      expect(document.activeElement).toBe(sessions[1])
      key(sessions[1]!, 'j')
      key(sessions[1]!, 'ArrowRight')
      expect(document.activeElement).toBe(sessions[1])
      expect(strip().contains(document.activeElement)).toBe(false)

      // a card that leaves hands the tab stop to the first card
      s.body = body(unslop(), requestPost())
      await pollTick()
      expect([names(), tabbable()]).toEqual([['request-post', 'unslop'], ['request-post']])
      // Enter's activation is the button's click: it opens that agent
      click(cards()[1])
      await settle()
      expect([activeTab(), agentTab().querySelector('.tab-name')?.textContent]).toEqual(['agent', 'unslop'])
    })

    it('the open agent’s card carries aria-current, the others none; Close clears it', async () => {
      await boot()
      await pollTick()
      const current = () => cards().filter((el) => el.getAttribute('aria-current') === 'true').map((el) => el.querySelector('.ma-name')?.textContent)
      await openAgent('unslop')
      tab('dashboard')
      await settle()
      expect(current()).toEqual(['unslop'])
      expect(cards().filter((el) => el.hasAttribute('aria-current'))).toHaveLength(1)
      await openAgent('request-post')
      tab('dashboard')
      await settle()
      expect(current()).toEqual(['request-post'])
      await pollTick()
      expect(current()).toEqual(['request-post'])
      tab('agent')
      await settle()
      click(page().querySelector('.map-close'))
      await settle()
      expect(activeTab()).toBe('dashboard')
      expect(cards().some((el) => el.hasAttribute('aria-current'))).toBe(false)
    })

    it('a poll that changes a card’s text keeps the strip’s scroll position, its nodes and a selection', async () => {
      const { s } = await boot({ mesh: fakeMesh(body(unslop(), requestPost(), webSearch())) })
      await pollTick()
      const list = strip()
      const nodes = cards()
      list.scrollLeft = 150
      const name = nodes[0]!.querySelector('.ma-name')!.firstChild!
      const range = document.createRange()
      range.setStart(name, 0)
      range.setEnd(name, 7)
      document.getSelection()!.removeAllRanges()
      document.getSelection()!.addRange(range)
      s.body = body(unslop({ state: 'up', reason: null, card: summarizeCard(UNSLOP_CARD), cardJson: cardJson(UNSLOP_CARD), lastSeen: null }), requestPost(), webSearch())
      await pollTick()
      expect(shown()[1]).toEqual(['unslop', 'Running', 'Local · v0.3.1', ''])
      expect(cards()[1]!.getAttribute('aria-label')).toBe('unslop, Running')
      expect([strip(), list.scrollLeft, list.isConnected]).toEqual([list, 150, true])
      expect(cards()).toEqual(nodes)
      expect(cards().every((el, i) => el === nodes[i])).toBe(true)
      expect([name.isConnected, String(document.getSelection())]).toEqual([true, 'request'])
    })

    it('hostile names, reasons and versions show literally, as text and in the accessible name, never as markup', async () => {
      const evil = '<img src=x onerror="alert(1)">'
      const { log } = await boot({
        mesh: fakeMesh(body(requestPost({
          name: evil, state: 'mismatch', reason: '<a href="https://evil.example/">r</a>', fix: '<script>alert(2)</script>',
          card: { ...summarizeCard(RP_CARD), version: '<b>9</b>' },
        }))),
      })
      const images = document.querySelectorAll('img').length
      await pollTick()
      const [card] = cards()
      expect(shown()).toEqual([[evil, 'Card does not match this build · <a href="https://evil.example/">r</a>', 'Remote · tailnet · v<b>9</b>', 'Fix: <script>alert(2)</script>']])
      expect(card!.getAttribute('aria-label')).toBe(`${evil}, Card does not match this build`)
      expect(section()!.querySelectorAll('img, a, script, b, [href], [src], [onerror]')).toHaveLength(0)
      expect(document.querySelectorAll('img')).toHaveLength(images)
      expect(log.some((entry) => entry.includes('evil.example'))).toBe(false)
    })
  })

  it('no public file names the clients or the command (the text guard, which test/mesh.test.ts runs unchanged)', () => {
    for (const file of ['mesh-section.js', 'mesh-agent-page.js', 'agents-home.js', 'app.js', 'snapshots.js']) {
      expect(readFileSync(resolve(REPO, 'public', file), 'utf8'), file).not.toMatch(/unslop-client|request-post-client|meshctl/)
    }
  })
})

