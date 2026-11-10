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
import { advanceClock, badgeCount, bootApp, click, freshDb, pollTick, rows, settle, showInbox, tabCount, useDomTest } from './harness.js'
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
    trigger: async (trigger) => {
      s.triggers.push(trigger)
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
const meshReads = (log: string[]) => log.filter((entry) => entry === 'GET /api/mesh/agents').length
const section = () => document.querySelector<HTMLElement>('.agents-home .mesh-agents')
const meshRow = (name: string) => [...document.querySelectorAll<HTMLElement>('.mesh-agents .ma-row')]
  .find((el) => el.querySelector('.ma-name')?.textContent === name) ?? null
const shown = () => [...document.querySelectorAll<HTMLElement>('.mesh-agents .ma-row')].map((el) => [
  el.querySelector('.ma-name')?.textContent, el.querySelector('.ma-status')?.textContent,
  el.querySelector('.ma-facts')?.textContent, el.querySelector<HTMLElement>('.ma-fix')?.hidden ? '' : el.querySelector('.ma-fix')?.textContent,
])
const tab = (id: string) => click(document.querySelector(`.tab[data-tab="${id}"]`))
const UP_ROWS = [
  ['request-post', 'Reachable', 'Remote · tailnet · v0.0.0-fixture · A2A 1.0 · 2 skills', ''],
  ['unslop', 'Not running · starts on its first call', 'Local · 127.0.0.1:4420 · v0.3.1 · seen 2h ago · A2A 1.0 · 1 skill', ''],
]
function expand(name: string): void {
  click(meshRow(name)?.querySelector('.ma-row-toggle'))
}
function openJson(name: string): void {
  const json = meshRow(name)!.querySelector<HTMLDetailsElement>('.ma-json')!
  json.open = true
  json.dispatchEvent(new Event('toggle'))
}
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

  it('draws both rows with the state words and the server’s reason and fix, read only on a visible Dashboard', async () => {
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
      ['unslop', 'Card does not match this build · no unslop skill', 'Local · 127.0.0.1:4420 · v0.3.1 · A2A 1.0 · 1 skill', 'Fix: rebuild packages/mesh'],
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

    // a press held across that tick keeps the rows; the tick after it paints
    const pressed = meshRow('unslop')!.querySelector('.ma-row-toggle')!
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
    expect(shown()[1]).toEqual(['unslop', 'Running', 'Local · 127.0.0.1:4420 · v0.3.1 · A2A 1.0 · 1 skill', ''])
    expect([name.isConnected, String(document.getSelection())]).toEqual([true, 'request'])
  })

  describe('the section is global', () => {
    function seed(d: Database.Database): void {
      insertItem(d, { project: 'agent-inbox', stream: 'main', agent: 'copilot', kind: 'question', title: 'Ship it?' })
      insertItem(d, { project: 'zeta', stream: 'main', agent: 'claude-code', kind: 'note', title: 'A note' })
      upsertActivity(d, { session: 'c1', agent: 'copilot', project: 'agent-inbox', stream: 'main', doing: 'Writing tests' })
      recordActivityCall(d, 'c1')
    }

    it('shows the same rows under every state filter and a project and agent lens that hides every session', async () => {
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

  it('a failed read keeps the rows, marked stale, and never fails the tick; an off body hides the section until /api/version says mesh again', async () => {
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
    const SURFACES = { title: '(2) Agent Inbox', badge: 2, tabs: ['2', '1', '1', ''], needsYou: ['Approve it.', 'Ship it?'] }
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
        tabs: ['needsYou', 'notes', 'boards', 'done'].map(tabCount),
        needsYou: await (async () => { await showInbox(); return rows().map((el) => el.querySelector('.nrow-title')?.textContent) })(),
      }
    }
    it.each([['off', null], ['on, every row amber', 'amber']] as const)('mesh %s', async (_label, mode) => {
      const fake = mode ? fakeMesh(body(unslop({ state: 'mismatch', reason: 'no unslop skill', fix: 'rebuild packages/mesh' }),
        requestPost({ state: 'unreachable', reason: 'connection refused', card: null, cardJson: null }))) : null
      await boot({ mesh: fake, seed })
      await pollTick()
      await settle()
      expect(Boolean(section())).toBe(Boolean(mode))
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
    expand('request-post')
    openJson('request-post')
    const row = meshRow('request-post')!
    const lines = [...row.querySelectorAll('.ma-lines dd')].map((dd) => dd.textContent)
    expect(lines).toContain('<a href="https://evil.example/">click</a><script>alert(2)</script>')
    expect(lines).toContain('<img src=x onerror="alert(1)">')
    expect(lines.some((line) => line?.includes('https://evil.example/a2a'))).toBe(true)
    expect([...row.querySelectorAll('.ma-tag')].map((el) => el.textContent)).toEqual(['<i>tag</i>'])
    expect(row.querySelector('.ma-json-text')?.textContent).toBe(cardJson(hostile))
    expect(section()!.querySelectorAll('img, a, script, b, i, [href], [src]')).toHaveLength(0)
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
    expand('request-post')
    openJson('request-post')
    const records: MutationRecord[] = []
    const observer = new MutationObserver((list) => records.push(...list))
    observer.observe(section()!, { subtree: true, childList: true, characterData: true, attributes: true })
    await pollTick()
    await pollTick()
    expect(statuses.slice(-2)).toEqual([304, 304])
    expect(records).toEqual([])
    observer.disconnect()

    const pre = meshRow('request-post')!.querySelector('.ma-json-text')!
    const text = pre.firstChild!
    const range = document.createRange()
    range.setStart(text, 2)
    range.setEnd(text, 40)
    document.getSelection()!.removeAllRanges()
    document.getSelection()!.addRange(range)
    const selected = String(document.getSelection())
    s.onTrigger = () => { s.body = body(unslop(), requestPost({ checkedAt: at(0) })) }
    click(section()!.querySelector('.ma-refresh'))
    await settle()
    expect(section()!.querySelector('.ma-checked')?.textContent).toBe('checked 1m ago')
    expect([...meshRow('request-post')!.querySelectorAll('.ma-lines dd')].at(-1)?.textContent).toBe(`checked ${hhmm(at(0))} · card fetched ${hhmm(at(0))}`)
    expect(pre.firstChild).toBe(text)
    expect(text.isConnected).toBe(true)
    expect(String(document.getSelection())).toBe(selected)
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
    expand('unslop')
    expect(meshRow('unslop')?.querySelector('.ma-row-toggle')?.getAttribute('aria-expanded')).toBe('true')
    expect(meshRow('unslop')?.querySelector<HTMLElement>('.ma-details')?.hidden).toBe(false)
    // the last good card's details, marked as such; Card JSON only for a card fetched now
    const lines = [...meshRow('unslop')!.querySelectorAll('.ma-lines dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent])
    expect(lines).toContainEqual(['Where', 'Local · http://127.0.0.1:4420profile: unslop'])
    expect(lines).toContainEqual(['Auth', 'bearer (HTTP Bearer), requiredtoken kept outside the app; not shown here'])
    expect(lines).toContainEqual(['Extension', 'urn:agent-inbox:ext:unslop:v1 · requiredapi 1 · skillId unslop · rulesSha256 3f9a1c0e7b22 · bytes 6204'])
    expect(lines).toContainEqual(['Modes', 'in text/plain · out text/plain'])
    expect(meshRow('unslop')?.querySelector<HTMLElement>('.ma-json')?.hidden).toBe(true)
    // the open row survives polls, a changed body included, and nothing is stored
    s.body = body(unslop({ checkedAt: at(0) }), requestPost())
    await pollTick()
    expect(meshRow('unslop')?.querySelector('.ma-row-toggle')?.getAttribute('aria-expanded')).toBe('true')
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toMatch(/mesh/i)
    // pinned as source: the section's state joins agentsHome.state(), which joins frameInputs()
    const app = readFileSync(resolve(REPO, 'public', 'app.js'), 'utf8')
    const frame = app.slice(app.indexOf('function frameInputs()'), app.indexOf('function noteOutsideChange'))
    expect(frame).toContain('agentsHome.state()')
    expect(readFileSync(resolve(REPO, 'public', 'agents-home.js'), 'utf8')).toMatch(/state: \(\) => \[[^\n]*mesh\.state\(\)/)
  })

  it('no public file names the clients or the command (the text guard, which test/mesh.test.ts runs unchanged)', () => {
    for (const file of ['mesh-section.js', 'agents-home.js', 'app.js', 'snapshots.js']) {
      expect(readFileSync(resolve(REPO, 'public', file), 'utf8'), file).not.toMatch(/unslop-client|request-post-client|meshctl/)
    }
  })
})

