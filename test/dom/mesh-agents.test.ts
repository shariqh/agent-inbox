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
    // each agent's run records, newest end first, as src/mesh-agents.ts answers them (V5d)
    runs: {} as Record<string, Json[]>,
    older: false,
    runsRead: [] as string[],
  }
  const mesh: MeshAgents = {
    version: () => s.version,
    body: () => s.body,
    runs: (name) => {
      s.runsRead.push(name)
      return { on: true, name, runs: s.runs[name] ?? [], older: s.older, skipped: 0, truncated: false, keptDays: 30, forget: `npm run meshctl -- forget-runs --${name}` }
    },
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
      // V5d: Run history, the agent tab's default, full of runs that went wrong
      if (fake) {
        fake.s.runs = {
          unslop: [
            { v: 1, id: 'faaaaaaaaa', agent: 'unslop', op: 'docs', at: at(60_000), ms: 900, exit: 13, outcome: 'failed', reason: 'internal' },
            { v: 1, id: 'iaaaaaaaaa', agent: 'unslop', op: 'pr', at: at(120_000), ms: 900, exit: null, signal: 'SIGINT', outcome: 'interrupted' },
          ],
        }
      }
      await boot({ mesh: fake, seed })
      await pollTick()
      await settle()
      expect(Boolean(section())).toBe(Boolean(mode))
      if (mode === 'tab') {
        await openAgent('unslop')
        await pollTick()
        expect(agentTab().hidden).toBe(false)
        expect(agentTab().querySelector('.tab-count')).toBeNull()
        expect(document.querySelectorAll('#agentPagePanel-runs tbody .mar-amber')).toHaveLength(2)
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
      // V5d: the page opens on Run history, then Details
      const inner = [...page().querySelectorAll<HTMLElement>('.map-tabs [role="tab"]')]
      expect(inner.map((t) => [t.textContent, t.getAttribute('aria-selected'), t.tabIndex])).toEqual([['Run history', 'true', 0], ['Details', 'false', -1]])
      for (const t of inner) expect(page().querySelector(`#${t.getAttribute('aria-controls')}`)?.getAttribute('aria-labelledby')).toBe(t.id)

      // an inner tab, the active agent tab and a poll post nothing
      click(inner[1])
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
      expect(getComputedStyle(un!).height).toBe('134px')
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

  describe('Run history (cards view V5d)', () => {
    const MIN = 60_000
    // a run record as src/mesh-runs.ts reads it: `at` is the end, `ms` the duration
    const run = (id: string, endedAgo: number, over: Json = {}): Json => ({
      v: 1, id: id.padEnd(10, 'a'), agent: 'unslop', op: 'docs', at: at(endedAgo), ms: 8400, exit: 0, outcome: 'ok',
      status: 'rewritten', attempts: 1, rules: '3f9a1c0e7b22', bytesIn: 6204, timing: { queued: 0, load: 0, model: 7000, check: 100 }, ...over,
    })
    const panel = () => page().querySelector<HTMLElement>('#agentPagePanel-runs')!
    const runRows = () => [...panel().querySelectorAll<HTMLTableRowElement>('tbody tr')]
    const ids = () => runRows().map((tr) => tr.dataset.runId)
    const cells = () => runRows().map((tr) => [...tr.cells].map((td) => td.textContent))
    const runsReads = (log: string[], name = 'unslop') => log.filter((entry) => entry === `GET /api/mesh/agents/runs?name=${name}`).length
    const innerTab = (label: string) => [...page().querySelectorAll<HTMLElement>('.map-tabs [role="tab"]')].find((t) => t.textContent === label)!
    const weekdayTime = (iso: string) => `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(iso).getDay()]} ${hhmm(iso)}`
    const select = (node: Node, start: number, end: number) => {
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, end)
      document.getSelection()!.removeAllRanges()
      document.getSelection()!.addRange(range)
      return String(document.getSelection())
    }

    it('opens on Run history and reads runs only while the agent tab is active, Run history shows and the document is visible', async () => {
      const fake = fakeMesh()
      fake.s.runs = { unslop: [run('b', 10 * MIN), run('a', 20 * MIN)], 'request-post': [] }
      const { log } = await boot({ mesh: fake })
      await pollTick()
      await pollTick()
      expect(log.some((entry) => entry.includes('/api/mesh/agents/runs'))).toBe(false)

      await openAgent('unslop')
      expect(innerTab('Run history').getAttribute('aria-selected')).toBe('true')
      expect([panel().hidden, page().querySelector<HTMLElement>('#agentPagePanel-details')?.hidden]).toEqual([false, true])
      // the click's reloadAndPaint() reads the runs without waiting for a tick
      expect(runsReads(log)).toBe(1)
      expect(ids()).toEqual(['baaaaaaaaa', 'aaaaaaaaaa'])
      await pollTick()
      expect(runsReads(log)).toBe(2)

      // Details showing stops the read and keeps the last body; switching back paints it at once
      const nodes = runRows()
      click(innerTab('Details'))
      await pollTick()
      await pollTick()
      expect(runsReads(log)).toBe(2)
      click(innerTab('Run history'))
      expect([panel().hidden, runRows()]).toEqual([false, nodes])
      await pollTick()
      expect(runsReads(log)).toBe(3)

      // another tab stops it too
      tab('needsYou')
      await settle()
      await pollTick()
      expect(runsReads(log)).toBe(3)
      tab('agent')
      await settle()
      expect(runRows()).toEqual(nodes)
      await pollTick()
      expect(runsReads(log)).toBe(4)

      // and a hidden document
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
      await pollTick()
      await pollTick()
      expect(runsReads(log)).toBe(4)
      delete (document as unknown as Record<string, unknown>).visibilityState
      await pollTick()
      expect(runsReads(log)).toBe(5)

      // Details is kept while the tab stays open; every open (a re-open of the same agent too) starts on Run history
      click(innerTab('Details'))
      tab('needsYou')
      await settle()
      tab('agent')
      await settle()
      expect(innerTab('Details').getAttribute('aria-selected')).toBe('true')
      tab('dashboard')
      await settle()
      await openAgent('unslop')
      expect(innerTab('Run history').getAttribute('aria-selected')).toBe('true')

      // opening another agent drops the last agent's rows at once, before its own read lands
      tab('dashboard')
      await settle()
      click(meshRow('request-post'))
      expect(runRows()).toEqual([])
      await settle()
      expect(runsReads(log, 'request-post')).toBe(1)
      expect([runRows(), panel().querySelector<HTMLElement>('.mar-empty')?.hidden]).toEqual([[], false])
    })

    it('shows the summary, the table in the page’s words, the empty state and the footer with the route’s forget text', async () => {
      const fake = fakeMesh()
      const runs = [
        run('a', 2 * MIN),
        run('b', 5 * MIN, { op: 'pr', exit: 11, outcome: 'refused', status: undefined, attempts: undefined, rules: undefined, bytesIn: 900, timing: undefined, ms: 200, reason: 'screen', classes: ['email'] }),
        run('c', 10 * MIN, { op: 'blog', exit: 10, outcome: 'kept-original', status: 'kept-original', attempts: 2, ms: 31_000, reason: 'fidelity', rules: undefined, bytesIn: undefined, timing: undefined }),
        run('d', 3 * 24 * 60 * MIN, { exit: null, signal: 'SIGTERM', outcome: 'interrupted', status: undefined, ms: 4 * MIN, attempts: undefined, rules: undefined, bytesIn: undefined, timing: undefined }),
        run('e', 10 * 24 * 60 * MIN, { exit: 14, outcome: 'unavailable', status: undefined, ms: 230 * MIN, attempts: undefined, rules: undefined, bytesIn: undefined, timing: undefined }),
      ]
      fake.s.runs = { unslop: runs, 'request-post': [] }
      await boot({ mesh: fake })
      await pollTick()
      await openAgent('unslop')
      expect(panel().querySelector('.mar-summary')?.textContent).toBe('Last 5 runs: 1 ok · 1 kept original · 1 refused · 1 unavailable · 1 interrupted · median 31 s')
      expect([...panel().querySelectorAll('thead th')].map((th) => [th.textContent, th.getAttribute('scope')]))
        .toEqual(['Ended', 'What', 'Outcome', 'Took', 'Details'].map((label) => [label, 'col']))
      const d = new Date(String(runs[4]!['at']))
      expect(cells()).toEqual([
        [hhmm(String(runs[0]!['at'])), 'docs', 'rewritten', '8.4 s', 'model 7.0 s · 1 attempt · rules 3f9a1c0e7b22 · 6.2 KB'],
        [hhmm(String(runs[1]!['at'])), 'pr', 'refused', '0.2 s', '0.9 KB · screen: email'],
        [hhmm(String(runs[2]!['at'])), 'blog', 'kept original', '31 s', '2 attempts · fidelity'],
        [weekdayTime(String(runs[3]!['at'])), 'docs', 'interrupted', '4 min', 'SIGTERM'],
        [`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, 'docs', 'unavailable', '3 h 50 min', ''],
      ])
      // amber only for the outcomes that went wrong
      expect(runRows().map((tr) => tr.querySelector('.mar-outcome')!.classList.contains('mar-amber'))).toEqual([false, false, false, true, true])
      // the full local start and end in the Ended cell's title
      expect(runRows()[0]!.cells[0]!.title).toMatch(/^started \d{4}-\d\d-\d\d \d\d:\d\d:\d\d · ended \d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/)
      expect(panel().querySelector<HTMLElement>('.mar-empty')?.hidden).toBe(true)
      expect(panel().querySelector<HTMLElement>('.mar-more')?.hidden).toBe(true)
      expect(panel().querySelector<HTMLElement>('.mar-older')?.hidden).toBe(true)
      // the footer: the kept period, then the forget command as the route sent it, inside <code>
      expect(panel().querySelector('.mar-kept')?.textContent).toBe('Runs from the last 30 days are shown. Older records are deleted by this agent’s first run of a day, or the next time an agent is enabled or disabled. Never the text sent or returned.')
      const code = panel().querySelector('.mar-forget code')!
      expect(code.textContent).toBe('npm run meshctl -- forget-runs --unslop')
      expect(panel().querySelector('.mar-forget')?.textContent).toBe('To forget them now: npm run meshctl -- forget-runs --unslop Copy')
      expect(panel().querySelectorAll('img, a, [href], [src]')).toHaveLength(0)

      // request-post's words: filed, the final phase, wait (through go), refused fields
      fake.s.runs['request-post'] = [
        run('p', 1 * MIN, { agent: 'request-post', op: 'file', status: undefined, attempts: undefined, rules: undefined, bytesIn: undefined, timing: undefined, created: true, phase: 'awaiting-go', channels: ['blog', 'x-thread'], brand: 'brand-a', ms: 1200 }),
        run('q', 2 * MIN, { agent: 'request-post', op: 'wait', status: undefined, attempts: undefined, rules: undefined, bytesIn: undefined, timing: undefined, throughGo: true, phase: 'published', ms: 50 * MIN }),
        run('r', 3 * MIN, { agent: 'request-post', op: 'status', exit: 11, outcome: 'refused', status: undefined, attempts: undefined, rules: undefined, bytesIn: undefined, timing: undefined, fields: ['channels'], ms: 300 }),
        run('s', 4 * MIN, { agent: 'request-post', op: 'wait', exit: 124, outcome: 'timed-out', status: undefined, attempts: undefined, rules: undefined, bytesIn: undefined, timing: undefined, phase: 'awaiting-go', ms: 60 * MIN }),
      ]
      tab('dashboard')
      await settle()
      await openAgent('request-post')
      expect(cells().map((row) => row.slice(1))).toEqual([
        ['file', 'filed', '1.2 s', 'awaiting-go · blog, x-thread · brand-a'],
        ['wait (through go)', 'published', '50 min', ''],
        ['status', 'refused', '0.3 s', 'fields: channels'],
        ['wait', 'timed out', '1 h', 'awaiting-go'],
      ])
      expect(panel().querySelector('.mar-forget code')?.textContent).toBe('npm run meshctl -- forget-runs --request-post')

      // the empty state
      fake.s.runs['request-post'] = []
      await pollTick()
      expect([panel().querySelector<HTMLElement>('.mar-empty')?.hidden, panel().querySelector<HTMLElement>('.mar-table')?.hidden, panel().querySelector<HTMLElement>('.mar-summary')?.hidden])
        .toEqual([false, true, true])
      expect(panel().querySelector('.mar-empty')?.textContent).toBe('No runs yet. Calls through this agent appear here once they finish; calls made before this version were not recorded.')
      expect(panel().querySelector<HTMLElement>('.mar-foot')?.hidden).toBe(false)
    })

    it('hostile-looking values from a record show literally, as text', async () => {
      const fake = fakeMesh()
      fake.s.runs = { unslop: [run('a', MIN, { op: '<img src=x onerror=alert(1)>', reason: '<a href="https://evil.example/">r</a>' })] }
      const { log } = await boot({ mesh: fake })
      await pollTick()
      await openAgent('unslop')
      expect(cells()[0]!.slice(1, 2)).toEqual(['<img src=x onerror=alert(1)>'])
      expect(panel().querySelectorAll('img, a, [href], [src], [onerror]')).toHaveLength(0)
      expect(log.some((entry) => entry.includes('evil.example'))).toBe(false)
    })

    it('Show more adds 50 rows up to the 200 returned, is window-local and joins frameInputs()', async () => {
      const fake = fakeMesh()
      fake.s.runs = { unslop: Array.from({ length: 120 }, (_, i) => run(`r${String(i).padStart(3, '0')}`, (i + 1) * 1000)) }
      fake.s.older = true
      const { log } = await boot({ mesh: fake })
      await pollTick()
      await openAgent('unslop')
      const more = panel().querySelector<HTMLButtonElement>('.mar-more')!
      expect([runRows().length, more.hidden, more.textContent]).toEqual([50, false, 'Show 50 more'])
      expect(panel().querySelector('.mar-summary')?.textContent).toMatch(/^Last 120 runs: 120 ok · median /)
      const first = runRows()
      const requests = log.length
      click(more)
      // the click repaints its own region at once, reads and posts nothing, and keeps the first rows
      expect(runRows().length).toBe(100)
      expect(runRows().slice(0, 50)).toEqual(first)
      expect(log.length).toBe(requests)
      click(more)
      expect([runRows().length, more.hidden]).toEqual([120, true])
      const older = panel().querySelector<HTMLElement>('.mar-older')!
      expect([older.hidden, older.textContent]).toEqual([false, 'Older runs in the kept period are not shown.'])
      await pollTick()
      expect(runRows().length).toBe(120)
      expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toMatch(/mesh|unslop|more/i)
      // a re-open starts at one page again
      click(page().querySelector('.map-close'))
      await settle()
      await openAgent('unslop')
      expect(runRows().length).toBe(50)
      // pinned as source: the shown count joins the page's state(), which frameInputs() reads
      const pageSrc = readFileSync(resolve(REPO, 'public', 'mesh-agent-page.js'), 'utf8')
      expect(pageSrc).toMatch(/state: \(\) => \[[^\n]*runs\.state\(\)/)
      expect(readFileSync(resolve(REPO, 'public', 'mesh-runs-tab.js'), 'utf8')).toContain('state: () => String(shown)')
    })

    it('a new run inserts one row in end order, touching no other row; a selection survives that poll, the label clock and Refresh; an idle tick changes nothing', async () => {
      const fake = fakeMesh()
      fake.s.runs = { unslop: [run('b', 10 * MIN, { ms: 2000 }), run('a', 20 * MIN)] }
      await boot({ mesh: fake })
      await pollTick()
      await openAgent('unslop')
      const [b, a] = runRows()
      const details = b!.querySelector('.mar-details')!.firstChild!
      const selected = select(details, 0, 9)
      expect(selected).toBe('model 7.0')

      // idle ticks (304s) change no node on the page
      const records: MutationRecord[] = []
      const observer = new MutationObserver((list) => records.push(...list))
      observer.observe(page(), { subtree: true, childList: true, characterData: true, attributes: true })
      await pollTick()
      await pollTick()
      expect(records).toEqual([])

      // a run that started 4 h ago, before both, but ended last sorts first: one row inserted, the others the same nodes
      fake.s.runs = { unslop: [run('c', MIN, { ms: 4 * 60 * MIN }), ...fake.s.runs['unslop']!] }
      await pollTick()
      expect(ids()).toEqual(['caaaaaaaaa', 'baaaaaaaaa', 'aaaaaaaaaa'])
      expect(runRows().slice(1)).toEqual([b, a])
      const inserted = records.filter((r) => r.type === 'childList' && r.target.nodeName === 'TBODY')
      expect(inserted.map((r) => [r.addedNodes.length, r.removedNodes.length])).toEqual([[1, 0]])
      expect(records.filter((r) => r.target.nodeName !== 'TBODY' && b!.contains(r.target))).toEqual([])
      expect([details.isConnected, String(document.getSelection())]).toEqual([true, selected])
      records.length = 0

      // the 30-second label clock repaints the frame; nothing in the rows changes
      await vi.advanceTimersByTimeAsync(31_000)
      expect(records.filter((r) => runRows().some((tr) => tr.contains(r.target)) || r.target.nodeName === 'TBODY')).toEqual([])
      expect([details.isConnected, String(document.getSelection())]).toEqual([true, selected])

      // the page's Refresh ends in reloadAndPaint(): the rows stay, the selection too
      click(page().querySelector('.map-refresh'))
      await settle()
      expect(fake.s.triggers.at(-1)).toBe('refresh unslop')
      expect(runRows().slice(1)).toEqual([b, a])
      expect([details.isConnected, String(document.getSelection())]).toEqual([true, selected])
      observer.disconnect()
    })

    it('past midnight only the Ended cells’ text changes (time to weekday); a selection in another cell of the row survives', async () => {
      const fake = fakeMesh()
      // ended a few minutes ago, so today wherever the test runs
      const runs = [run('b', 2 * MIN), run('a', 3 * MIN)]
      fake.s.runs = { unslop: runs }
      await boot({ mesh: fake })
      await pollTick()
      await openAgent('unslop')
      expect(cells().map((row) => row[0])).toEqual(runs.map((r) => hhmm(String(r['at']))))
      const [b] = runRows()
      const what = b!.querySelector('.mar-what')!.firstChild!
      const selected = select(what, 0, 4)
      const records: MutationRecord[] = []
      const observer = new MutationObserver((list) => records.push(...list))
      observer.observe(panel(), { subtree: true, childList: true, characterData: true, attributes: true })
      const next = new Date(Date.now())
      next.setHours(24, 5, 0, 0)
      vi.setSystemTime(next)
      await pollTick()
      expect(cells().map((row) => row[0])).toEqual(runs.map((r) => weekdayTime(String(r['at']))))
      expect(records.length).toBeGreaterThan(0)
      expect(records.every((r) => (r.target as Element).classList?.contains('mar-ended'))).toBe(true)
      expect([what.isConnected, String(document.getSelection())]).toEqual([true, selected])
      observer.disconnect()
    })

    it('a failed read keeps the last rows, marked stale, and never fails the tick', async () => {
      let failure: (() => Response) | null = null
      const fake = fakeMesh()
      fake.s.runs = { unslop: [run('a', MIN)] }
      await boot({ mesh: fake, intercept: (url) => (url.startsWith('/api/mesh/agents/runs') && failure ? Promise.resolve(failure()) : null) })
      await pollTick()
      await openAgent('unslop')
      const stale = () => panel().querySelector<HTMLElement>('.mar-stale')!
      expect(stale().hidden).toBe(true)
      const nodes = runRows()
      for (const make of [
        () => new Response('boom', { status: 500 }),
        () => new Response('<html>not found</html>', { status: 404 }),
        () => new Response(JSON.stringify({ ok: false, error: 'not configured' }), { status: 200, headers: { etag: '"x"' } }),
      ]) {
        failure = make
        await pollTick()
        expect([stale().hidden, stale().textContent]).toEqual([false, 'could not read; showing what was last read'])
        expect(runRows()).toEqual(nodes)
        expect(document.getElementById('status')?.textContent).not.toBe('disconnected')
      }
      failure = null
      await pollTick()
      expect([stale().hidden, runRows()]).toEqual([true, nodes])
    })

    it('the card’s last-run line follows lastRun by the label clock', async () => {
      const ended = at(5 * MIN)
      const { s } = await boot({ mesh: fakeMesh(body(unslop({ lastRun: { at: ended, op: 'docs', outcome: 'ok' } }), requestPost({ lastRun: null }))) })
      await pollTick()
      const line = (name: string) => meshRow(name)!.querySelector<HTMLElement>('.ma-lastrun')!
      expect([line('unslop').textContent, line('unslop').hidden]).toEqual([`Last run ${hhmm(ended)} · ok`, false])
      expect(line('request-post').textContent).toBe('No runs yet')
      // part of the card's description
      expect(meshRow('unslop')!.getAttribute('aria-describedby')).toContain(line('unslop').id)
      const older = at(2 * 24 * 60 * MIN)
      s.body = body(unslop({ lastRun: { at: ended, op: 'docs', outcome: 'ok' } }), requestPost({ lastRun: { at: older, op: 'file', outcome: 'refused' } }))
      await pollTick()
      expect(line('request-post').textContent).toBe(`Last run ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(older).getDay()]} · refused`)
      expect(line('request-post').classList.contains('ma-lastrun')).toBe(true)
    })
  })

  it('no public file names the clients or the command (the text guard, which test/mesh.test.ts runs unchanged)', () => {
    for (const file of ['mesh-section.js', 'mesh-agent-page.js', 'mesh-runs-tab.js', 'agents-home.js', 'app.js', 'snapshots.js']) {
      expect(readFileSync(resolve(REPO, 'public', file), 'utf8'), file).not.toMatch(/unslop-client|request-post-client|meshctl/)
    }
  })
})

