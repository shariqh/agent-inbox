// @vitest-environment jsdom
// The Agent cards tab, step 1 (agent cards view design docs/superpowers/specs/2026-11-09-agent-cards-view-design.md
// §2, §4.5, §7, as amended by Agent cards step 1): "Yours", in a tab of its own that
// exists only while the last /api/version carried `mesh`. It reads `/api/mesh/agents` only while
// the Agent cards is the current tab and the window is visible; entering the tab from another tab
// posts one check (an open) and paints through the next poll tick, Refresh through
// reloadAndPaint(). Pressing a card opens that agent's page inside the tab; "← Agent cards" and
// Escape go back. It is global and never an ask. The viewer's real routes answer from a stand-in
// for src/mesh-agents.ts, so no socket opens. (Before step 1 this file pinned the Mesh agents strip
// on the Agents home and the hidden agent tab; every case reaches the same content through the
// Agent cards tab now.)
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
  if (location.hash) history.replaceState(null, '', location.pathname)
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
  key: 'mesh.json:unslop', name: 'unslop', kind: 'built-in', where: 'local', endpoint: 'http://127.0.0.1:4420', profile: 'unslop',
  state: 'not-running', reason: 'starts on its first call', fix: null, checkedAt: at(60_000),
  card: null, cardJson: null, lastSeen: { at: at(2 * 60 * 60 * 1000), card: summarizeCard(UNSLOP_CARD) }, ...over,
})
const requestPost = (over: Json = {}): Json => ({
  key: 'mesh.json:request-post', name: 'request-post', kind: 'built-in', where: 'tailnet', endpoint: 'https://request-post.tailnet-name.ts.net',
  profile: null, state: 'up', reason: null, fix: null, checkedAt: at(60_000),
  card: summarizeCard(RP_CARD), cardJson: cardJson(RP_CARD), lastSeen: null, ...over,
})
// an agent the add command wrote, as src/mesh-agents.ts answers it (D6)
const echo = (over: Json = {}): Json => ({
  key: 'mesh.json:echo', name: 'echo', kind: 'added', where: 'public', endpoint: 'https://agent.example.com/a2a', profile: null,
  state: 'added', reason: null, fix: null, checkedAt: null, card: summarizeCard({ ...UNSLOP_CARD, name: 'Echo Agent', description: 'Echoes one text.', version: '1.0.0' }),
  cardJson: null, lastSeen: null, lastRun: null, ...over,
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
// "Yours", in the Agent cards tab's panel
const section = () => document.querySelector<HTMLElement>('#cards .mesh-agents')
const meshRow = (name: string) => [...document.querySelectorAll<HTMLElement>('#cards .ma-card')]
  .find((el) => el.querySelector('.ma-name')?.textContent === name) ?? null
// a card's name, state word, foot and fix line (the reason is on the agent's page, in full)
const shown = () => [...document.querySelectorAll<HTMLElement>('#cards .ma-card')].map((el) => [
  el.querySelector('.ma-name')?.textContent, el.querySelector('.ma-word')?.textContent,
  el.querySelector('.ma-facts')?.textContent, el.querySelector<HTMLElement>('.ma-fix')?.hidden ? '' : el.querySelector('.ma-fix')?.textContent,
])
const tab = (id: string) => click(document.querySelector(`.tab[data-tab="${id}"]`))
const UP_ROWS = [
  ['request-post', 'Reachable', 'Remote · tailnet · v0.0.0-fixture', ''],
  ['unslop', 'Not running', 'Local · v0.3.1 · seen 2h ago', ''],
]
const cardsTab = () => document.querySelector<HTMLElement>('#tabs .tab[data-tab="cards"]')!
const page = () => document.getElementById('agentPage')!
const activeTab = () => document.querySelector('#tabs .tab[aria-selected="true"]')?.getAttribute('data-tab')
async function enter(): Promise<void> {
  tab('cards')
  await settle()
}
// pressing a card opens that agent's page in the tab; from another tab, enter it first
async function openAgent(name: string): Promise<void> {
  if (activeTab() !== 'cards') await enter()
  else if (!page().hidden) await back()
  click(meshRow(name))
  await settle()
}
async function back(): Promise<void> {
  click(page().querySelector('.map-back'))
  await settle()
}
function openJson(): void {
  const json = page().querySelector<HTMLDetailsElement>('.ma-json')!
  json.open = true
  json.dispatchEvent(new Event('toggle'))
}
const pageLines = () => [...page().querySelectorAll('.ma-lines dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent])
const pageStatus = () => page().querySelector('.map-status')?.textContent
function pointer(el: Element | null, type: 'pointerdown' | 'pointerup'): void {
  el!.dispatchEvent(new window.PointerEvent(type, { bubbles: true }))
}
const pressKey = (key: string) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))

// The boot reads, then one poll tick's nine reads (test/dom/agents-home.test.ts's BOOT_REQUESTS).
const POLL = ['/api/items', '/api/boards', '/api/boards/archived/summary', '/api/activity',
  '/api/activity/history?since_ms=1781949600000', '/api/projects/closed', '/api/links', '/api/issues', '/api/messages']
const BOOT_REQUESTS = ['/api/version', '/api/setup', ...POLL, ...POLL]

describe('the Agent cards tab: Yours (Agent cards step 1)', () => {
  it('with no mesh key, the page makes exactly its old reads, posts no check and has no Agent cards tab', async () => {
    const { bridge, log } = await boot({ mesh: null })
    await pollTick()
    await settle()
    expect(log.map((entry) => entry.replace(/^GET /, ''))).toEqual(BOOT_REQUESTS)
    expect(section()).toBeNull()
    expect(cardsTab().hidden).toBe(true)
    // no navigation posts anything without `mesh` in the last /api/version; G M does nothing
    tab('boards')
    await settle()
    tab('dashboard')
    await settle()
    click(document.getElementById('sessionsIndicator'))
    await settle()
    ;(document.activeElement as HTMLElement | null)?.blur()
    pressKey('g')
    pressKey('m')
    await settle()
    await pollTick()
    expect(activeTab()).toBe('dashboard')
    expect(triggers(bridge)).toEqual([])
    expect(bridge.posts).toEqual([])
    expect(log.some((entry) => entry.includes('/api/mesh/'))).toBe(false)
    expect(section()).toBeNull()

    // a viewer whose mesh shows nothing (no known agent) is the same
    const quiet = fakeMesh()
    quiet.s.version = undefined
    const again = await boot({ mesh: quiet })
    await pollTick()
    expect(cardsTab().hidden).toBe(true)
    expect(triggers(again.bridge)).toEqual([])
    expect(meshReads(again.log)).toBe(0)
  })

  it('draws both cards with the state words and the server’s fix, the reason on the page; read only on a visible Agent cards tab', async () => {
    const { log, s } = await boot()
    await pollTick()
    // the tab shows with the mesh on, with no count; nothing is read before it is entered
    expect([cardsTab().hidden, cardsTab().querySelector('.tab-count'), cardsTab().querySelector('.tab-name')?.textContent]).toEqual([false, null, 'Agent cards'])
    expect(meshReads(log)).toBe(0)
    await enter()
    expect(activeTab()).toBe('cards')
    expect(section()?.querySelector('.ma-title-text')?.textContent).toBe('Yours')
    expect(section()?.querySelector('.ma-count')?.textContent).toBe('2')
    expect(section()?.querySelector('.ma-checked')?.textContent).toBe('checked 1m ago')
    expect(shown()).toEqual(UP_ROWS)
    expect(meshRow('request-post')?.classList.contains('ma-tone-up')).toBe(true)
    expect(meshRow('unslop')?.classList.contains('ma-tone-neutral')).toBe(true)

    // a mismatch carries the server's fix, amber; the reason shows in full on the agent's page
    s.body = body(unslop({ state: 'mismatch', reason: 'no unslop skill', fix: 'rebuild packages/mesh', card: summarizeCard(UNSLOP_CARD), cardJson: cardJson(UNSLOP_CARD), lastSeen: null }),
      requestPost({ state: 'unreachable', reason: 'does not resolve (is this Mac on the tailnet?)', card: null, cardJson: null }))
    await pollTick()
    expect(shown()).toEqual([
      ['request-post', 'Unreachable', 'Remote · tailnet', ''],
      ['unslop', 'Card does not match this build', 'Local · v0.3.1', 'Fix: rebuild packages/mesh'],
    ])
    expect(meshRow('unslop')?.classList.contains('ma-tone-amber')).toBe(true)
    await openAgent('request-post')
    expect(pageStatus()).toBe('Unreachable · does not resolve (is this Mac on the tailnet?)')
    await openAgent('unslop')
    expect([pageStatus(), page().querySelector('.ma-fix')?.textContent]).toEqual(['Card does not match this build · no unslop skill', 'Fix: rebuild packages/mesh'])
    await back()

    // leaving the Agent cards stops the read and keeps the last body
    const reads = meshReads(log)
    tab('boards')
    await settle()
    s.body = body(unslop(), requestPost())
    await pollTick()
    await pollTick()
    expect(meshReads(log)).toBe(reads)
    await enter()
    expect(shown()[0]?.[1]).toBe('Unreachable')
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

  it('every state reads in the page’s words; invalid entries are counted, never named', () => {
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
    // D6: the others line counts the entries that are neither built in nor valid, with the server's fix
    expect(meshRows({ ...body(unslop()), others: 1, othersFix: 'run the status command' }, now).others).toBe('1 entry in mesh.json is not valid: run the status command')
    expect(meshRows({ ...body(unslop()), others: 2, othersFix: 'run the status command' }, now).others).toBe('2 entries in mesh.json are not valid: run the status command')
    expect(meshRows(body(unslop({ checkedAt: null }), requestPost({ checkedAt: null })), now).checked).toBe('not checked yet')
    // D6: an added agent is "Added", neutral, never said to be reachable; its tag and where
    const added = meshRows(body(echo({ fix: 'Run the check command to show its card', card: null })), now).rows[0]!
    expect([added.word, added.status, added.tone, added.tag, added.facts, added.fix]).toEqual(['Added', 'Added', 'neutral', 'Added by you', 'Remote · public', 'Run the check command to show its card'])
    expect(meshRows(body(unslop()), now).rows[0]!.tag).toBe('Built in')
    expect(meshRows(body(echo({ where: 'local' })), now).rows[0]!.facts).toBe('Local · v1.0.0')
    expect(meshRows(body(echo({ where: 'tailnet' })), now).rows[0]!.facts).toBe('Remote · tailnet · v1.0.0')
  })

  it('shows an added agent with its tag and the server’s one line, and an invalid entry only as a count', async () => {
    const { log } = await boot({ mesh: fakeMesh({ ...body(unslop(), echo({ card: null, fix: 'Run meshctl check echo to show its card' })), others: 1, othersFix: 'run meshctl status' }) })
    await enter()
    expect(shown()).toEqual([
      ['echo', 'Added', 'Remote · public', 'Run meshctl check echo to show its card'],
      ['unslop', 'Not running', 'Local · v0.3.1 · seen 2h ago', ''],
    ])
    expect([...document.querySelectorAll('#cards .ma-badge')].map((el) => el.textContent)).toEqual(['Added by you', 'Built in'])
    expect(meshRow('echo')?.classList.contains('ma-tone-neutral')).toBe(true)
    const others = section()!.querySelector<HTMLElement>('.ma-others')!
    expect([others.hidden, others.textContent]).toEqual([false, '1 entry in mesh.json is not valid: run meshctl status'])
    // its page: the same line in full, and no claim that it is reachable
    await openAgent('echo')
    expect([pageStatus(), page().querySelector('.ma-fix')?.textContent, page().querySelector('.map-badge')?.textContent])
      .toEqual(['Added', 'Run meshctl check echo to show its card', 'Added by you'])
    expect(log.some((entry) => entry.includes('agent.example.com'))).toBe(false)
  })

  describe('the open trigger: entering the Agent cards, and nothing else', () => {
    it('booting posts none; entering posts one; a poll tick, Refresh and re-selecting it post no open', async () => {
      const { bridge, s } = await boot()
      await pollTick()
      expect(triggers(bridge)).toEqual([])
      await enter()
      expect(triggers(bridge)).toEqual(['open'])
      expect(s.triggers).toEqual(['open'])
      // a poll tick, reloadAndPaint() (Refresh) and re-selecting the Agent cards post no open
      await pollTick()
      tab('cards')
      await settle()
      click(section()?.querySelector('.ma-refresh'))
      await settle()
      expect(triggers(bridge)).toEqual(['open', 'refresh'])
      // nor do Home and its own way in
      tab('dashboard')
      await settle()
      click(document.getElementById('sessionsIndicator'))
      await settle()
      expect(triggers(bridge)).toEqual(['open', 'refresh'])
    })

    it('waits for /api/version: the tab shows once it says mesh; entering from another tab posts one, and again while there none', async () => {
      let release = () => {}
      const held = new Promise<void>((done) => { release = done })
      const { bridge } = await boot({ intercept: (url, _init, next) => (url === '/api/version' ? held.then(next) : null) })
      expect(cardsTab().hidden).toBe(true)
      tab('boards')
      await settle()
      release()
      await settle()
      await pollTick()
      expect(cardsTab().hidden).toBe(false)
      expect(triggers(bridge)).toEqual([])
      await enter()
      expect(triggers(bridge)).toEqual(['open'])
      tab('cards')
      await settle()
      expect(triggers(bridge)).toEqual(['open'])
    })

    it('showAgentsHome() posts none, from another tab or from Home (D5)', async () => {
      const { bridge } = await boot()
      tab('boards')
      await settle()
      click(document.getElementById('sessionsIndicator'))
      await settle()
      expect(document.querySelector('.tab[data-tab="dashboard"]')?.getAttribute('aria-selected')).toBe('true')
      click(document.getElementById('sessionsIndicator'))
      await settle()
      expect(triggers(bridge)).toEqual([])
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
      click(document.querySelector('[data-session-card="session:k2"] .sc-doing'))
      await settle()
      expect(document.querySelector<HTMLElement>('#dashboard .dash-focus')?.hidden).toBe(false)
      click(document.querySelector('.setup-run-btn'))
      await settle()
      expect(install).toHaveBeenCalledTimes(1)
      expect(versions()).toBe(before + 2)
      expect(triggers(bridge)).toEqual([])
      // nor does a session panel opened from another tab (the Inbox's Show on Agents ›)
      await showInbox()
      click(rows()[0])
      await settle()
      click(document.querySelector('.nrow-show-agents'))
      await settle()
      expect(document.querySelector('.tab[data-tab="dashboard"]')?.getAttribute('aria-selected')).toBe('true')
      expect(document.querySelector<HTMLElement>('#dashboard .dash-focus')?.dataset.session).toBe('k2')
      expect(versions()).toBe(before + 3)
      expect(triggers(bridge)).toEqual([])
    })
  })

  it('an open paints through the next poll tick, never reloadAndPaint(); a held press defers that paint', async () => {
    const { bridge, log, s } = await boot()
    await enter()
    await pollTick()
    expect(shown()).toEqual(UP_ROWS)
    tab('boards')
    await settle()
    s.onTrigger = () => { s.body = body(unslop({ state: 'up', reason: null, card: summarizeCard(UNSLOP_CARD), cardJson: cardJson(UNSLOP_CARD), lastSeen: null, checkedAt: at(0) }), requestPost()) }
    const loads = () => log.filter((entry) => entry === 'GET /api/items').length
    // just before a tick, so the one after the open lands under a held press
    const ticks = loads()
    while (loads() === ticks) await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(2800)
    const before = loads()
    tab('cards')
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

  describe('the section is global, and Home no longer holds it (D4)', () => {
    function seed(d: Database.Database): void {
      insertItem(d, { project: 'agent-inbox', stream: 'main', agent: 'copilot', kind: 'question', title: 'Ship it?' })
      insertItem(d, { project: 'zeta', stream: 'main', agent: 'claude-code', kind: 'note', title: 'A note' })
      upsertActivity(d, { session: 'c1', agent: 'copilot', project: 'agent-inbox', stream: 'main', doing: 'Writing tests' })
      recordActivityCall(d, 'c1')
    }

    it('shows the same cards whatever the lanes hold, and under a lens that hides every session', async () => {
      await boot({ seed })
      await pollTick()
      expect(document.querySelector('#dashboard .mesh-agents, .agents-home .ah-mesh')).toBeNull()
      await enter()
      const expected = shown()
      expect(expected).toEqual(UP_ROWS)
      // the one session stops working: it moves to Quiet on Home; the cards stay the same
      upsertActivity(db!, { session: 'c1', agent: 'copilot', project: 'agent-inbox', stream: 'main', doing: 'open', idle: true })
      await pollTick()
      expect(document.querySelector('.agents-home .quiet-lane .qt-rows [data-session-card="session:c1"]')).not.toBeNull()
      expect(shown()).toEqual(expected)
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

    it('shows with no session at all; Home’s empty state has no agent section under it', async () => {
      await boot()
      await pollTick()
      const empty = document.querySelector<HTMLElement>('.agents-home .ah-empty')!
      expect(empty.hidden).toBe(false)
      expect(document.querySelector('.agents-home .mesh-agents')).toBeNull()
      await enter()
      expect(shown()).toEqual(UP_ROWS)
    })
  })

  it('a failed read keeps the cards, marked stale, and never fails the tick; an off body hides the tab once left, until /api/version says mesh again', async () => {
    let failure: (() => Response) | null = null
    const { bridge, log, s } = await boot({ intercept: (url) => (url === '/api/mesh/agents' && failure ? Promise.resolve(failure()) : null) })
    await enter()
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

    // off: the section goes and the reads stop; the tab stays while it is the current one, saying so
    s.body = { on: false, agents: [] }
    s.version = undefined
    await pollTick()
    expect(section()).toBeNull()
    expect([activeTab(), cardsTab().hidden, document.getElementById('agentCardsOff')?.hidden]).toEqual(['cards', false, false])
    const reads = meshReads(log)
    await pollTick()
    await pollTick()
    expect(meshReads(log)).toBe(reads)
    // once left, the tab is gone; a /api/version read without mesh changes nothing
    click(document.getElementById('sessionsIndicator'))
    await settle()
    await pollTick()
    expect([activeTab(), cardsTab().hidden]).toEqual(['dashboard', true])
    expect(meshReads(log)).toBe(reads)
    // one with it brings the tab back, and entering reads and shows the cards
    s.version = { agents: 2 }
    s.body = body(unslop(), requestPost())
    click(document.getElementById('sessionsIndicator'))
    await settle()
    expect(cardsTab().hidden).toBe(false)
    await enter()
    await pollTick()
    expect(meshReads(log)).toBeGreaterThan(reads)
    expect(shown()).toEqual(UP_ROWS)
    expect(document.getElementById('agentCardsOff')?.hidden).toBe(true)
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
        tabs: ['dashboard', 'find', 'boards', 'cards'].map(tabCount),
        needsYou: await (async () => { await showInbox(); return rows().map((el) => el.querySelector('.nrow-title')?.textContent) })(),
      }
    }
    const railCounts = () => [...document.querySelectorAll('#rail .rail-tab')].map((el) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '')
    let railOff: string[] = []
    it.each([['off', null], ['on, every row amber', 'amber'], ['on, an agent’s page open', 'page']] as const)('mesh %s', async (_label, mode) => {
      const fake = mode ? fakeMesh(body(unslop({ state: 'mismatch', reason: 'no unslop skill', fix: 'rebuild packages/mesh' }),
        requestPost({ state: 'unreachable', reason: 'connection refused', card: null, cardJson: null }))) : null
      // V5d: Run history, the page's default, full of runs that went wrong
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
      expect(cardsTab().hidden).toBe(!mode)
      if (mode) {
        await enter()
        expect(Boolean(section())).toBe(true)
      }
      if (mode === 'page') {
        await openAgent('unslop')
        await pollTick()
        expect(page().hidden).toBe(false)
        expect(cardsTab().querySelector('.tab-count')).toBeNull()
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
    await enter()
    // the card's description line is text too
    expect(meshRow('request-post')?.querySelector('.ma-description')?.textContent).toBe('<a href="https://evil.example/">click</a><script>alert(2)</script>')
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
    expect(cardsTab().querySelectorAll('img, a, [href], [src]')).toHaveLength(0)
    expect(document.querySelectorAll('img')).toHaveLength(images)
    await pollTick()
    expect(log.filter((entry) => !/^(GET|POST) \/api\//.test(entry))).toEqual([])
    expect(log.some((entry) => entry.includes('evil.example'))).toBe(false)
  })

  it('unslop\'s usage line (V4), on its page: the design\'s words as text, absent with no usage key, unchanged on an idle tick', async () => {
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
    const usage = () => page().querySelector<HTMLElement>('.map-usage')!
    await openAgent('request-post')
    expect([usage().hidden, usage().textContent]).toEqual([true, ''])
    await openAgent('unslop')
    expect(usage().hidden).toBe(false)
    expect(usage().textContent).toBe('Today: 12 tasks · 8 model-minutes')
    expect(usage().children).toHaveLength(0)
    expect(shown()).toEqual(UP_ROWS)

    await pollTick()
    const records: MutationRecord[] = []
    const observer = new MutationObserver((list) => records.push(...list))
    observer.observe(section()!, { subtree: true, childList: true, characterData: true, attributes: true })
    observer.observe(page(), { subtree: true, childList: true, characterData: true, attributes: true })
    await pollTick()
    expect(statuses.at(-1)).toBe(304)
    expect(records).toEqual([])
    observer.disconnect()

    s.body = body(unslop(), requestPost())
    await pollTick()
    expect(usage().hidden).toBe(true)
    expect(usage().textContent).toBe('')

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
    await openAgent('request-post')
    openJson()
    await pollTick()
    const records: MutationRecord[] = []
    const observer = new MutationObserver((list) => records.push(...list))
    observer.observe(section()!, { subtree: true, childList: true, characterData: true, attributes: true })
    observer.observe(page(), { subtree: true, childList: true, characterData: true, attributes: true })
    observer.observe(cardsTab(), { subtree: true, childList: true, characterData: true, attributes: true })
    await pollTick()
    await pollTick()
    // the open page keeps the read going, and a 304 paints nothing on it
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

  it('Refresh sits in the header row beside the title: it posts refresh, then (and only then) repaints through reloadAndPaint()', async () => {
    let release = () => {}
    let holding = false
    const { bridge, log, s } = await boot({
      intercept: (url, _init, next) => (url === '/api/mesh/agents/refresh' && holding ? new Promise<void>((done) => { release = done }).then(next) : null),
    })
    await enter()
    const title = section()!.querySelector('.ma-title-text')!
    const refresh = section()!.querySelector('.ma-refresh')!
    expect(title.contains(refresh)).toBe(false)
    expect(refresh.parentElement).toBe(title.parentElement)
    expect(section()!.querySelector('summary .ma-refresh')).toBeNull()

    holding = true
    s.onTrigger = () => { s.body = body(unslop({ state: 'checking', reason: null }), requestPost()) }
    const loads = () => log.filter((entry) => entry === 'GET /api/items').length
    const before = loads()
    click(refresh)
    await vi.advanceTimersByTimeAsync(0)
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

  it('the open page is window-local, repaints at once and is in frameInputs()', async () => {
    const { s } = await boot()
    await openAgent('unslop')
    expect(page().hidden).toBe(false)
    expect(document.getElementById('agentCardsHome')?.hidden).toBe(true)
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
    expect([activeTab(), document.getElementById('pageTitle')?.textContent]).toEqual(['cards', 'unslop'])
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toMatch(/mesh|unslop/i)
    // pinned as source: the page's state joins frameInputs()
    const app = readFileSync(resolve(REPO, 'public', 'app.js'), 'utf8')
    const frame = app.slice(app.indexOf('function frameInputs()'), app.indexOf('function noteOutsideChange'))
    expect(frame).toContain('agentsHome.state()')
    expect(frame).toContain('meshAgentPage.state()')
  })

  describe('an agent’s page in the Agent cards tab (D3; was the agent tab, cards view V5c1)', () => {
    const heading = () => [document.getElementById('pageKicker')?.textContent, document.getElementById('pageTitle')?.textContent]

    it('with no mesh key there is no Agent cards tab, and selecting it does nothing', async () => {
      const { bridge, log } = await boot({ mesh: null })
      await pollTick()
      await settle()
      expect(log.map((entry) => entry.replace(/^GET /, ''))).toEqual(BOOT_REQUESTS)
      expect([cardsTab().hidden, document.getElementById('cards')?.hidden, page().hidden]).toEqual([true, true, true])
      click(cardsTab())
      await settle()
      expect([activeTab(), document.getElementById('cards')?.hidden, cardsTab().hidden]).toEqual(['dashboard', true, true])
      // (a deep link and G M with the mesh off: test/dom/agent-cards-links.test.ts, whose app is the only one listening)
      expect(bridge.posts).toEqual([])
    })

    it('pressing a card opens the agent in the tab: no check, one reloadAndPaint(); ← Agent cards returns to its card', async () => {
      const { bridge, log, s } = await boot()
      await enter()
      await pollTick()
      const loads = () => log.filter((entry) => entry === 'GET /api/items').length
      const before = loads()
      vi.spyOn(document, 'hasFocus').mockReturnValue(true)
      await openAgent('unslop')
      expect([activeTab(), page().hidden, document.getElementById('agentCardsHome')?.hidden, document.getElementById('dashboard')?.hidden]).toEqual(['cards', false, true, true])
      expect(heading()).toEqual(['Agent cards', 'unslop'])
      expect(document.getElementById('pageTitle')?.textContent).toBe('unslop')
      expect(page().querySelector('.map-status')?.textContent).toBe('Not running · starts on its first call')
      expect(page().querySelector('.map-checked')?.textContent).toBe('checked 1m ago')
      expect(page().querySelector('.map-badge')?.textContent).toBe('Built in')
      // the press posts no check (D5: entering the tab did) and moves focus to the way back
      expect(posted(bridge)).toEqual([{ trigger: 'open' }])
      expect(s.triggers).toEqual(['open'])
      expect(loads()).toBe(before + 1)
      expect(document.activeElement).toBe(page().querySelector('.map-back'))
      expect(page().querySelector('.map-back')?.textContent).toBe('← Agent cards')
      // V5d: the page opens on Run history, then Details
      const inner = [...page().querySelectorAll<HTMLElement>('.map-tabs [role="tab"]')]
      expect(inner.map((t) => [t.textContent, t.getAttribute('aria-selected'), t.tabIndex])).toEqual([['Run history', 'true', 0], ['Details', 'false', -1]])
      for (const t of inner) expect(page().querySelector(`#${t.getAttribute('aria-controls')}`)?.getAttribute('aria-labelledby')).toBe(t.id)

      // an inner tab, the active Agent cards tab and a poll post nothing
      click(inner[1])
      click(inner[0])
      click(cardsTab())
      await settle()
      await pollTick()
      expect(posted(bridge)).toHaveLength(1)
      // the tab from another tab is an open for every agent; the page is still there
      tab('boards')
      await settle()
      expect(cardsTab().hidden).toBe(false)
      tab('cards')
      await settle()
      expect(posted(bridge).slice(1)).toEqual([{ trigger: 'open' }])
      expect([page().hidden, document.getElementById('pageTitle')?.textContent]).toEqual([false, 'unslop'])

      // ← Agent cards: the grid again, focus on the agent's card in a focused window
      page().querySelector<HTMLElement>('.map-back')!.focus()
      click(page().querySelector('.map-back'))
      await settle()
      expect([activeTab(), page().hidden, document.getElementById('agentCardsHome')?.hidden]).toEqual(['cards', true, false])
      expect(posted(bridge)).toHaveLength(2)
      expect(document.activeElement).toBe(meshRow('unslop'))
      expect(heading()).toEqual(['', 'Agent cards'])

      // another agent replaces it in the same slot
      await openAgent('request-post')
      // UX pass, slice 4: Home, Plans, Find and (step 1) the Agent cards
      expect(document.querySelectorAll('#tabs .tab:not([hidden])')).toHaveLength(4)
      expect([document.getElementById('pageTitle')?.textContent, heading()[1]]).toEqual(['request-post', 'request-post'])
      expect(pageLines()).toContainEqual(['Where', 'Remote · https://request-post.tailnet-name.ts.net'])
      expect(pageLines().find(([label]) => label === 'Where')).not.toContain('profile: unslop')
      expect(page().querySelector('.map-head')?.classList.contains('ma-tone-up')).toBe(true)
      expect(posted(bridge)).toHaveLength(2)
    })

    // Escape and the deep links live in test/dom/agent-cards-keys.test.ts and test/dom/agent-cards-links.test.ts:
    // window and document listeners accumulate across boots in one file (the harness's blind spot),
    // so an earlier test's app would answer the same key or hash first.

    it('a repaint keeps the open page, the focus on its control and the cards’ order', async () => {
      const { s } = await boot({ mesh: fakeMesh(body(unslop(), requestPost(), echo())) })
      vi.spyOn(document, 'hasFocus').mockReturnValue(true)
      await enter()
      const names = () => [...document.querySelectorAll('#cards .ma-card .ma-name')].map((el) => el.textContent)
      expect(names()).toEqual(['echo', 'request-post', 'unslop'])
      await openAgent('unslop')
      const refresh = page().querySelector<HTMLElement>('.map-refresh')!
      refresh.focus()
      // a poll whose body changed and lists the agents in another order
      s.body = body(requestPost({ checkedAt: at(0) }), unslop({ state: 'up', reason: null, card: summarizeCard(UNSLOP_CARD), cardJson: cardJson(UNSLOP_CARD), lastSeen: null }), echo())
      await pollTick()
      await pollTick()
      expect([page().hidden, document.getElementById('pageTitle')?.textContent, pageStatus()]).toEqual([false, 'unslop', 'Running'])
      expect(document.activeElement).toBe(refresh)
      await back()
      expect(names()).toEqual(['echo', 'request-post', 'unslop'])
      // and on the grid, a card keeps focus across a changed poll
      const card = meshRow('request-post')!
      card.focus()
      s.body = body(echo(), unslop(), requestPost({ checkedAt: at(1000) }))
      await pollTick()
      expect([document.activeElement, page().hidden, names()]).toEqual([card, true, ['echo', 'request-post', 'unslop']])
    })

    it('Settings opened over the Agent cards keeps its title through a forced paint and a changed poll', async () => {
      const { s } = await boot({ seed: (d) => { insertItem(d, { project: 'zeta', stream: 'main', agent: 'copilot', kind: 'note', title: 'A note' }) } })
      await openAgent('unslop')
      expect(heading()).toEqual(['Agent cards', 'unslop'])
      click(document.getElementById('gear'))
      await settle()
      expect(heading()).toEqual(['Agent Inbox', 'Settings'])
      s.body = body(unslop({ checkedAt: at(0) }), requestPost())
      await pollTick()
      // a lens change forces a paint
      const agent = document.getElementById('agentSelect') as HTMLSelectElement
      agent.value = 'copilot'
      agent.dispatchEvent(new Event('change', { bubbles: true }))
      await settle()
      expect(heading()).toEqual(['Agent Inbox', 'Settings'])
      click(document.getElementById('gear'))
      await settle()
      expect([activeTab(), heading()]).toEqual(['cards', ['Agent cards', 'unslop']])
    })

    it('every way in: the tablist’s roving, G M, other G keys, an item hash; focus kept on the page across a poll', async () => {
      let id = ''
      await boot({ seed: (d) => { id = insertItem(d, { project: 'demo', stream: 'main', agent: 'copilot', kind: 'question', title: 'Ship it?' }) } })
      await pollTick()
      vi.spyOn(document, 'hasFocus').mockReturnValue(true)
      // focus on the page's Refresh survives a poll, and going back lands on the card
      await openAgent('unslop')
      page().querySelector<HTMLElement>('.map-refresh')!.focus()
      await pollTick()
      expect(document.activeElement).toBe(page().querySelector('.map-refresh'))
      await back()
      await pollTick()
      expect([activeTab(), document.activeElement]).toEqual(['cards', meshRow('unslop')])

      // roving in the library's tablist reaches the Agent cards, the last tab shown
      const dashboardTab = document.querySelector<HTMLElement>('#tabs .tab[data-tab="dashboard"]')!
      tab('dashboard')
      await settle()
      dashboardTab.focus()
      dashboardTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
      expect(document.activeElement?.getAttribute('data-tab')).toBe('cards')
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
      expect(document.activeElement?.getAttribute('data-tab')).toBe('dashboard')

      // every other G destination: none is the Agent cards
      for (const key of ['d', 'i', 'p', 'n', 'h', 'c', 'l']) {
        ;(document.activeElement as HTMLElement | null)?.blur()
        pressKey('g')
        pressKey(key)
        await settle()
        expect(activeTab(), key).not.toBe('cards')
      }
      // G M: the Agent cards, its panel focused
      ;(document.activeElement as HTMLElement | null)?.blur()
      pressKey('g')
      pressKey('m')
      await settle()
      expect([activeTab(), document.activeElement?.id]).toEqual(['cards', 'cards'])
      // an item hash lands on the item's own tab
      navigateToHash(`#item/${id}`)
      await settle()
      expect(activeTab()).toBe('dashboard')
    })

    it('an agent leaving mesh.json keeps its page under one line; a reload starts with no page open', async () => {
      const { s } = await boot()
      await openAgent('request-post')
      const gone = page().querySelector<HTMLElement>('.map-gone')!
      expect(gone.hidden).toBe(true)
      const lines = pageLines()
      s.body = body(unslop())
      await pollTick()
      expect([activeTab(), page().hidden, gone.hidden, gone.textContent]).toEqual(['cards', false, false, 'This agent is not in mesh.json any more'])
      expect(pageLines()).toEqual(lines)
      s.body = body(unslop(), requestPost())
      await pollTick()
      expect(gone.hidden).toBe(true)
      // mesh off: the same line, the page and the tab kept while it is the current one
      s.body = { on: false, agents: [] }
      s.version = undefined
      await pollTick()
      expect([activeTab(), cardsTab().hidden, page().hidden, gone.hidden]).toEqual(['cards', false, false, false])

      expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toMatch(/request-post|agentPage/)
      db?.close()
      db = null
      // the markup a reload starts from: no page open, the tab hidden until /api/version says mesh
      await boot()
      await pollTick()
      expect([cardsTab().hidden, page().hidden, activeTab()]).toEqual([true, true, 'dashboard'])
    })
  })

  describe('the card grid (D2; was the card strip, cards view V5c2)', () => {
    const grid = () => section()!.querySelector<HTMLElement>('.ma-grid')!
    const cards = () => [...grid().querySelectorAll<HTMLElement>(':scope > li > .ma-card')]
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

    it('draws one card per agent, a native button named by agent, state and tag, its other lines its description', async () => {
      await boot({ mesh: fakeMesh(body(unslop({ usage: { date: '2026-11-09', tasks: 12, modelMs: 480000 } }), requestPost())) })
      await enter()
      expect([grid().tagName, grid().getAttribute('role')]).toEqual(['UL', 'list'])
      expect([...grid().children].map((li) => [li.tagName, li.children.length, (li as HTMLElement).dataset.meshKey]))
        .toEqual([['LI', 1, 'mesh.json:request-post'], ['LI', 1, 'mesh.json:unslop']])
      expect(cards().map((el) => [el.tagName, el.getAttribute('type')])).toEqual([['BUTTON', 'button'], ['BUTTON', 'button']])
      expect(shown()).toEqual(UP_ROWS)
      // D2: the name, the state, one description line, where and the version, the tag; no skill
      // count or protocol, and the usage and last-run lines live on the agent's page
      expect(section()!.textContent).not.toMatch(/A2A|skill|Today:|Last run|No runs/)
      const [rp, un] = cards()
      expect(un!.getAttribute('aria-label')).toBe('unslop, Not running, Built in')
      expect(rp!.getAttribute('aria-label')).toBe('request-post, Reachable, Built in')
      expect(described(un!)).toEqual(['Removes generic AI-writing patterns from prose.', 'Local · v0.3.1 · seen 2h ago'])
      expect(described(rp!)).toEqual([summarizeCard(RP_CARD).description, 'Remote · tailnet · v0.0.0-fixture'])
      // ids from a counter, never from a name
      expect(cards().flatMap((el) => (el.getAttribute('aria-describedby') ?? '').split(' ')).join(' ')).not.toMatch(/unslop|request/)
      expect(cards().some((el) => el.hasAttribute('aria-current'))).toBe(false)

      // the description clamps to two lines, the other lines to one
      attachStylesheet()
      expect(getComputedStyle(un!.querySelector('.ma-facts')!.parentElement!).whiteSpace).toBe('nowrap')
      // jsdom drops what it cannot parse (container queries, line clamps), so the rest is pinned as source
      const css = readFileSync(resolve(REPO, 'public', 'style.css'), 'utf8')
      const rule = (selector: string) => css.slice(css.indexOf(`${selector} {`), css.indexOf('}', css.indexOf(`${selector} {`)))
      expect(rule('.ma-grid')).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))')
      expect(rule('.agent-cards')).toContain('container: agent-cards / inline-size')
      expect(css).toMatch(/@container agent-cards \(max-width: 700px\) \{\s*\.ma-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/)
      expect(css).toMatch(/@container agent-cards \(max-width: 460px\) \{\s*\.ma-grid \{ grid-template-columns: minmax\(0, 1fr\);/)
      expect(rule('.ma-description')).toContain('-webkit-line-clamp: 2')
      expect(css).toContain('.ma-card[aria-current="true"] { border-color: var(--app-border-strong); }')
      // exactly one responsive width query in the file; the tab's rules use no CSS order and no motion
      expect(css.match(/@media\s*\((?:max|min)-width[^)]*\)/g)).toEqual(['@media (max-width: 1279px)'])
      const mesh = css.slice(css.indexOf('/* the Agent cards tab (Agent cards step 1)'), css.indexOf('.map-panel {'))
      expect(mesh).not.toMatch(/(^|[;{\s])order\s*:|@media/m)
      expect(mesh).not.toMatch(/transition|animation|scroll-behavior|:hover|:focus/)
    })

    it('Down from a card with a row below but no card directly below goes to the last card; Up and a last-row Down are unchanged', async () => {
      await boot({ mesh: fakeMesh(body(unslop(), requestPost(), webSearch(), echo())) })
      await enter()
      const [first, second, third, last] = cards()
      const rects = new Map(cards().map((el, i) => [el, { top: Math.floor(i / 3) * 140, left: (i % 3) * 300, width: 290, height: 132 }]))
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        const r = rects.get(this as HTMLElement) ?? { top: 0, left: 0, width: 0, height: 0 }
        return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON: () => r } as DOMRect
      })
      for (const from of [second!, third!]) {
        from.focus()
        expect(key(from, 'ArrowDown').defaultPrevented).toBe(true)
        expect(document.activeElement, from.querySelector('.ma-name')?.textContent).toBe(last)
      }
      // the last row stays put, and Up from the last card is what it was: one row up, same column
      key(last!, 'ArrowDown')
      expect(document.activeElement).toBe(last)
      key(last!, 'ArrowUp')
      expect(document.activeElement).toBe(first)
      // a card with a card directly below goes there
      key(first!, 'ArrowDown')
      expect(document.activeElement).toBe(last)
    })

    it('one card is tabbable; the arrows, Home and End move focus without animating; J and K never reach the grid', async () => {
      const { s } = await boot({
        mesh: fakeMesh(body(unslop(), requestPost(), webSearch(), echo())),
        seed: (d) => {
          for (const id of ['s1', 's2']) upsertActivity(d, { session: id, agent: 'copilot', project: 'demo', stream: 'main', doing: `Working ${id}` })
        },
      })
      await enter()
      // the harness installs its own scrollIntoView as it mounts, so the spy comes after
      const scrolls: unknown[] = []
      vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element, arg?: boolean | ScrollIntoViewOptions) { scrolls.push([this, arg]) })
      expect(names()).toEqual(['echo', 'request-post', 'unslop', 'web-search'])
      expect(tabbable()).toEqual(['echo'])
      const [first, second, third, last] = cards()
      first!.focus()
      expect(key(first!, 'ArrowRight').defaultPrevented).toBe(true)
      expect([document.activeElement, tabbable()]).toEqual([second, ['request-post']])
      expect(scrolls.at(-1)).toEqual([second, { block: 'nearest', inline: 'nearest' }])
      key(second!, 'End')
      expect(document.activeElement).toBe(last)
      key(last!, 'ArrowRight')
      expect(document.activeElement).toBe(last)
      key(last!, 'Home')
      expect(document.activeElement).toBe(first)
      key(first!, 'ArrowLeft')
      expect(document.activeElement).toBe(first)
      // with no layout to read (one column), Up and Down step one card
      key(first!, 'ArrowDown')
      expect(document.activeElement).toBe(second)
      key(second!, 'ArrowUp')
      expect(document.activeElement).toBe(first)
      // three columns: Down moves a row, and past the last row stays put
      const rects = new Map(cards().map((el, i) => [el, { top: Math.floor(i / 3) * 140, left: (i % 3) * 300, width: 290, height: 132 }]))
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        const r = rects.get(this as HTMLElement) ?? { top: 0, left: 0, width: 0, height: 0 }
        return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON: () => r } as DOMRect
      })
      key(first!, 'ArrowDown')
      expect(document.activeElement).toBe(last)
      key(last!, 'ArrowDown')
      expect(document.activeElement).toBe(last)
      key(last!, 'ArrowUp')
      expect(document.activeElement).toBe(first)
      key(first!, 'ArrowUp')
      expect(document.activeElement).toBe(first)
      third!.focus()
      key(third!, 'End')
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
      expect([activeTab(), page().hidden]).toEqual(['cards', true])

      // a card that leaves hands the tab stop to the first card
      s.body = body(unslop(), requestPost())
      await pollTick()
      expect([names(), tabbable()]).toEqual([['request-post', 'unslop'], ['request-post']])
      // Enter's activation is the button's click: it opens that agent
      click(cards()[1])
      await settle()
      expect([activeTab(), document.getElementById('pageTitle')?.textContent]).toEqual(['cards', 'unslop'])

      // and on Home, J and K stop at the session cards' own last and first card
      tab('dashboard')
      await settle()
      const sessions = [...document.querySelectorAll<HTMLElement>('.agents-home [data-session-card]')]
      expect(sessions).toHaveLength(2)
      sessions[0]!.focus()
      key(sessions[0]!, 'k')
      expect(document.activeElement).toBe(sessions[0])
      key(sessions[0]!, 'j')
      expect(document.activeElement).toBe(sessions[1])
      key(sessions[1]!, 'j')
      key(sessions[1]!, 'ArrowRight')
      expect(document.activeElement).toBe(sessions[1])
      expect(grid().contains(document.activeElement)).toBe(false)
    })

    it('the open agent’s card carries aria-current, the others none; ← Agent cards clears it', async () => {
      await boot()
      const current = () => cards().filter((el) => el.getAttribute('aria-current') === 'true').map((el) => el.querySelector('.ma-name')?.textContent)
      await openAgent('unslop')
      expect(current()).toEqual(['unslop'])
      expect(cards().filter((el) => el.hasAttribute('aria-current'))).toHaveLength(1)
      await openAgent('request-post')
      expect(current()).toEqual(['request-post'])
      await pollTick()
      expect(current()).toEqual(['request-post'])
      await back()
      expect(activeTab()).toBe('cards')
      expect(cards().some((el) => el.hasAttribute('aria-current'))).toBe(false)
    })

    it('a poll that changes a card’s text keeps the grid, its nodes and a selection', async () => {
      const { s } = await boot({ mesh: fakeMesh(body(unslop(), requestPost(), webSearch())) })
      await enter()
      const list = grid()
      const nodes = cards()
      list.scrollTop = 150
      const name = nodes[0]!.querySelector('.ma-name')!.firstChild!
      const range = document.createRange()
      range.setStart(name, 0)
      range.setEnd(name, 7)
      document.getSelection()!.removeAllRanges()
      document.getSelection()!.addRange(range)
      s.body = body(unslop({ state: 'up', reason: null, card: summarizeCard(UNSLOP_CARD), cardJson: cardJson(UNSLOP_CARD), lastSeen: null }), requestPost(), webSearch())
      await pollTick()
      expect(shown()[1]).toEqual(['unslop', 'Running', 'Local · v0.3.1', ''])
      expect(cards()[1]!.getAttribute('aria-label')).toBe('unslop, Running, Built in')
      expect([grid(), list.scrollTop, list.isConnected]).toEqual([list, 150, true])
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
      await enter()
      const [card] = cards()
      expect(shown()).toEqual([[evil, 'Card does not match this build', 'Remote · tailnet · v<b>9</b>', 'Fix: <script>alert(2)</script>']])
      expect(card!.getAttribute('aria-label')).toBe(`${evil}, Card does not match this build, Built in`)
      expect(section()!.querySelectorAll('img, a, script, b, [href], [src], [onerror]')).toHaveLength(0)
      click(card)
      await settle()
      expect(pageStatus()).toBe('Card does not match this build · <a href="https://evil.example/">r</a>')
      expect(page().querySelectorAll('img, a, script, b, [href], [src], [onerror]')).toHaveLength(0)
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

    it('opens on Run history and reads runs only while its page is open in the Agent cards, Run history shows and the document is visible', async () => {
      const fake = fakeMesh()
      fake.s.runs = { unslop: [run('b', 10 * MIN), run('a', 20 * MIN)], 'request-post': [] }
      const { log } = await boot({ mesh: fake })
      await enter()
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
      tab('boards')
      await settle()
      await pollTick()
      expect(runsReads(log)).toBe(3)
      tab('cards')
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

      // Details is kept while the page stays open; every open (a re-open of the same agent too) starts on Run history
      click(innerTab('Details'))
      tab('boards')
      await settle()
      tab('cards')
      await settle()
      expect(innerTab('Details').getAttribute('aria-selected')).toBe('true')
      await openAgent('unslop')
      expect(innerTab('Run history').getAttribute('aria-selected')).toBe('true')
      // the grid between pages reads no runs
      await back()
      const between = runsReads(log)
      await pollTick()
      expect(runsReads(log)).toBe(between)

      // opening another agent drops the last agent's rows at once, before its own read lands
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
      await back()
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

    it('the last-run line, on the agent’s page, follows lastRun by the label clock', async () => {
      const ended = at(5 * MIN)
      const { s } = await boot({ mesh: fakeMesh(body(unslop({ lastRun: { at: ended, op: 'docs', outcome: 'ok' } }), requestPost({ lastRun: null }))) })
      const line = () => page().querySelector<HTMLElement>('.map-lastrun')!
      await openAgent('unslop')
      expect([line().textContent, line().hidden]).toEqual([`Last run ${hhmm(ended)} · ok`, false])
      await openAgent('request-post')
      expect([line().textContent, line().hidden]).toEqual(['No runs yet', false])
      const older = at(2 * 24 * 60 * MIN)
      s.body = body(unslop({ lastRun: { at: ended, op: 'docs', outcome: 'ok' } }), requestPost({ lastRun: { at: older, op: 'file', outcome: 'refused' } }))
      await pollTick()
      expect(line().textContent).toBe(`Last run ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(older).getDay()]} · refused`)
      // not on the card: D2's card has no last-run line
      expect(meshRow('request-post')!.textContent).not.toContain('Last run')
    })
  })

  it('no public file names the clients or the command (the text guard, which test/mesh.test.ts runs unchanged)', () => {
    for (const file of ['mesh-section.js', 'mesh-agent-page.js', 'mesh-runs-tab.js', 'agents-home.js', 'app.js', 'snapshots.js']) {
      expect(readFileSync(resolve(REPO, 'public', file), 'utf8'), file).not.toMatch(/unslop-client|request-post-client|meshctl/)
    }
  })
})


// unslop-code (#652, step 3c) is drawn as unslop is: the same card, page and Run history, from the
// server's own words; only its run rows say `cleaned` and `nothing to remove` where unslop says
// `rewritten` and `kept original`.
describe('unslop-code in the Agent cards tab', () => {
  const CODE_CARD: Json = {
    name: 'unslop-code', description: 'Removes the comments an AI coding agent added that a maintainer would not write, from changed JavaScript and TypeScript files; returns a patch.', version: '0.3.1',
    supportedInterfaces: [{ url: 'http://127.0.0.1:4421/', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    capabilities: {
      streaming: true, pushNotifications: false,
      extensions: [{ uri: 'urn:agent-inbox:ext:unslop-code:v1', required: false, params: { api: 1, skillId: 'unslop-code' } }],
    },
    securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    defaultInputModes: ['application/json'], defaultOutputModes: ['text/x-diff', 'application/json'],
    skills: [{ id: 'unslop-code', name: 'unslop-code', description: 'Clean the comments a change added', tags: ['code'] }],
  }
  const BLURB = 'Removes the comments an AI coding agent adds to code.'
  const code = (over: Json = {}): Json => ({
    key: 'mesh.json:unslop-code', name: 'unslop-code', kind: 'built-in', blurb: BLURB, where: 'local', endpoint: 'http://127.0.0.1:4421', profile: 'unslop-code',
    state: 'not-running', reason: 'starts on its first call', fix: null, checkedAt: at(60_000), card: null, cardJson: null, lastSeen: null, lastRun: null, ...over,
  })
  const up = (over: Json = {}) => code({ state: 'up', reason: null, card: summarizeCard(CODE_CARD), cardJson: cardJson(CODE_CARD), ...over })
  const MIN = 60_000
  const heading = () => [document.getElementById('pageKicker')?.textContent, document.getElementById('pageTitle')?.textContent]
  const innerTab = (label: string) => [...page().querySelectorAll<HTMLElement>('.map-tabs [role="tab"]')].find((t) => t.textContent === label)!
  const panel = () => page().querySelector<HTMLElement>('#agentPagePanel-runs')!
  const cells = () => [...panel().querySelectorAll<HTMLTableRowElement>('tbody tr')].map((tr) => [...tr.cells].map((td) => td.textContent))
  const run = (id: string, endedAgo: number, over: Json = {}): Json => ({
    v: 1, id: id.padEnd(10, 'a'), agent: 'unslop-code', op: 'clean', at: at(endedAgo), ms: 1900, exit: 0, outcome: 'ok',
    status: 'cleaned', files: 3, bytesIn: 4096, removed: 12, suggestions: 2, model: 'coder-test', timing: { queued: 0, load: 0, model: 800 }, ...over,
  })

  it('its card sits under Yours beside unslop and request-post: name, state, where, the blurb while no card is known, Built in', async () => {
    await boot({ mesh: fakeMesh(body(code(), unslop(), requestPost())) })
    await enter()
    expect(shown()).toEqual([
      ['request-post', 'Reachable', 'Remote · tailnet · v0.0.0-fixture', ''],
      ['unslop', 'Not running', 'Local · v0.3.1 · seen 2h ago', ''],
      ['unslop-code', 'Not running', 'Local', ''],
    ])
    const card = meshRow('unslop-code')!
    expect(card.querySelector('.ma-description')?.textContent).toBe(BLURB)
    expect(card.querySelector('.ma-badge')?.textContent).toBe('Built in')
    expect(card.getAttribute('aria-label')).toBe('unslop-code, Not running, Built in')
    expect(card.classList.contains('ma-tone-neutral')).toBe(true)
    // the other two are drawn as they were
    expect(meshRow('unslop')!.getAttribute('aria-label')).toBe('unslop, Not running, Built in')
  })

  it('up says Running, with the card\'s own line and version; a mismatch is amber with its fix; a squatter is not an agent card', async () => {
    const fake = fakeMesh(body(up(), unslop()))
    await boot({ mesh: fake })
    await enter()
    expect(shown().find(([name]) => name === 'unslop-code')).toEqual(['unslop-code', 'Running', 'Local · v0.3.1', ''])
    expect(meshRow('unslop-code')!.querySelector('.ma-description')?.textContent).toBe(CODE_CARD['description'])
    fake.s.body = body(code({ state: 'mismatch', reason: 'unslop-code api is not 1', fix: 'rebuild packages/mesh', card: summarizeCard(CODE_CARD) }), unslop())
    await pollTick()
    expect(shown().find(([name]) => name === 'unslop-code')).toEqual(['unslop-code', 'Card does not match this build', 'Local · v0.3.1', 'Fix: rebuild packages/mesh'])
    expect(meshRow('unslop-code')!.classList.contains('ma-tone-amber')).toBe(true)
    fake.s.body = body(code({ state: 'not-a-card', reason: 'something other than the unslop-code agent answers (HTTP 404)' }), unslop())
    await pollTick()
    await openAgent('unslop-code')
    expect(pageStatus()).toBe('Not an agent card · something other than the unslop-code agent answers (HTTP 404)')
    // where an agent runs is the server's word, for every agent
    const where = (agent: Json) => meshRows(body(agent), Date.now()).rows[0]!.facts
    expect(where(code())).toBe('Local')
    expect(where(unslop({ lastSeen: null }))).toBe('Local')
    expect(where(code({ where: 'tailnet' }))).toBe('Remote · tailnet')
  })

  it('its page: status, the usage line from its own counts, the last run, and Details with its profile and extension', async () => {
    const ended = at(5 * MIN)
    await boot({ mesh: fakeMesh(body(up({ usage: { date: '2026-11-09', tasks: 3, modelMs: 150_000 }, lastRun: { at: ended, op: 'clean', outcome: 'ok' } }), unslop())) })
    await openAgent('unslop-code')
    expect(heading()).toEqual(['Agent cards', 'unslop-code'])
    expect([pageStatus(), page().querySelector('.map-badge')?.textContent]).toEqual(['Running', 'Built in'])
    expect(page().querySelector('.map-usage')?.textContent).toBe('Today: 3 tasks · 3 model-minutes')
    expect(page().querySelector('.map-lastrun')?.textContent).toBe(`Last run ${hhmm(ended)} · ok`)
    click(innerTab('Details'))
    const lines = pageLines()
    expect(lines).toContainEqual(['Where', 'Local · http://127.0.0.1:4421profile: unslop-code'])
    expect(lines).toContainEqual(['Extension', 'urn:agent-inbox:ext:unslop-code:v1 · optionalapi 1 · skillId unslop-code'])
    expect(lines.find(([label]) => label === 'Card name')).toBeUndefined()
    expect(page().querySelector<HTMLElement>('.ma-json')?.hidden).toBe(false)
    // no usage key: no line, as for unslop
    await openAgent('unslop')
    expect(page().querySelector<HTMLElement>('.map-usage')?.hidden).toBe(true)
  })

  it('its Run history says its outcomes in unslop\'s shape: cleaned, nothing to remove, refused, busy, failed, unavailable, interrupted', async () => {
    const fake = fakeMesh(body(up(), unslop()))
    fake.s.runs = {
      'unslop-code': [
        run('a', 1 * MIN),
        run('b', 2 * MIN, { status: 'unchanged', files: 1, removed: 0, suggestions: 0, bytesIn: 120 }),
        run('c', 3 * MIN, { exit: 11, outcome: 'refused', reason: 'malformed', status: undefined }),
        run('d', 4 * MIN, { exit: 12, outcome: 'busy', status: 'busy' }),
        run('e', 5 * MIN, { exit: 13, outcome: 'failed', status: 'failed', reason: 'timeout' }),
        run('f', 6 * MIN, { exit: 14, outcome: 'unavailable', status: undefined }),
        run('g', 7 * MIN, { exit: null, signal: 'SIGINT', outcome: 'interrupted', status: undefined }),
      ],
      unslop: [
        { v: 1, id: 'haaaaaaaaa', agent: 'unslop', op: 'docs', at: at(MIN), ms: 8400, exit: 0, outcome: 'ok', status: 'unchanged' },
        { v: 1, id: 'iaaaaaaaaa', agent: 'unslop', op: 'docs', at: at(2 * MIN), ms: 8400, exit: 10, outcome: 'kept-original', status: 'kept-original' },
      ],
    }
    await boot({ mesh: fake })
    await openAgent('unslop-code')
    const table = cells().map(([, what, outcome, took, details]) => [what, outcome, took, details])
    expect(table).toEqual([
      ['clean', 'cleaned', '1.9 s', '3 files · 12 lines removed · 2 suggestions · 4.1 KB · coder-test · model 0.8 s'],
      ['clean', 'nothing to remove', '1.9 s', '1 file · 0 lines removed · 0 suggestions · 0.1 KB · coder-test · model 0.8 s'],
      ['clean', 'refused', '1.9 s', '3 files · 12 lines removed · 2 suggestions · 4.1 KB · coder-test · model 0.8 s · malformed'],
      ['clean', 'busy', '1.9 s', '3 files · 12 lines removed · 2 suggestions · 4.1 KB · coder-test · model 0.8 s'],
      ['clean', 'failed', '1.9 s', '3 files · 12 lines removed · 2 suggestions · 4.1 KB · coder-test · model 0.8 s · timeout'],
      ['clean', 'unavailable', '1.9 s', '3 files · 12 lines removed · 2 suggestions · 4.1 KB · coder-test · model 0.8 s'],
      ['clean', 'interrupted', '1.9 s', '3 files · 12 lines removed · 2 suggestions · 4.1 KB · coder-test · model 0.8 s · SIGINT'],
    ])
    const amber = [...panel().querySelectorAll('tbody tr')].map((tr) => tr.querySelector('.mar-outcome')?.classList.contains('mar-amber'))
    expect(amber).toEqual([false, false, false, false, true, true, true])
    expect(panel().querySelector('.mar-summary')?.textContent).toMatch(/^Last 7 runs: 2 ok · 1 refused · 1 busy · 1 failed · 1 unavailable · 1 interrupted · median /)
    expect(panel().querySelector('.mar-command')?.textContent).toBe('npm run meshctl -- forget-runs --unslop-code')
    // unslop's own rows keep their words
    await openAgent('unslop')
    expect(cells().map(([, what, outcome]) => [what, outcome])).toEqual([['docs', 'unchanged'], ['docs', 'kept original']])
  })

  it('a long wait in the queue or a model load shows; a single file and line read in the singular; text only, never markup', async () => {
    const fake = fakeMesh(body(up()))
    fake.s.runs = {
      'unslop-code': [
        run('a', MIN, { files: 1, removed: 1, suggestions: 1, timing: { queued: 31_000, load: 4_000, model: 12_000 }, model: '<img src=x onerror=alert(1)>' }),
        run('b', 2 * MIN, { files: undefined, removed: undefined, suggestions: undefined, bytesIn: undefined, model: undefined, timing: undefined }),
      ],
    }
    const { log } = await boot({ mesh: fake })
    await openAgent('unslop-code')
    expect(cells().map((row) => row[4])).toEqual(['1 file · 1 line removed · 1 suggestion · 4.1 KB · <img src=x onerror=alert(1)> · model 12 s · load 4.0 s · queued 31 s', ''])
    expect(panel().querySelectorAll('img')).toHaveLength(0)
    expect(log.some((entry) => entry.includes('onerror'))).toBe(false)
  })

  it('the card\'s last run follows lastRun, and no public file says meshctl or names a client', () => {
    expect(meshRows(body(code({ lastRun: { at: at(5 * MIN), op: 'clean', outcome: 'refused' } })), Date.now()).rows[0]!.lastrun).toBe(`Last run ${hhmm(at(5 * MIN))} · refused`)
    for (const file of ['mesh-section.js', 'mesh-agent-page.js', 'mesh-runs-tab.js']) {
      expect(readFileSync(resolve(REPO, 'public', file), 'utf8'), file).not.toMatch(/unslop-client|unslop-code-client|request-post-client|meshctl/)
    }
  })
})
