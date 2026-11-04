// @vitest-environment jsdom
// The Agents view (Mesh M1, #397), always on since #454 (design
// docs/superpowers/specs/2026-11-04-agents-home-design.md §4): app.js imports it
// statically, the Dashboard opens on its Agents lens, and Settings → Mesh is
// gone. It reads nothing new (the page makes exactly the requests it made
// before) and never feeds attention: the human's attention surfaces read the
// same with the Agents lens drawn.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, recordActivityCall, upsertActivity, upsertBoard } from '../../src/store.js'
import { advanceClock, badgeCount, bootApp, click, freshDb, pollTick, rows, settle, showInbox, tabCount, useDomTest } from './harness.js'

useDomTest()
let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

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

async function surfaces() {
  return {
    title: document.title,
    badge: badgeCount(),
    tabs: ['needsYou', 'notes', 'boards', 'done'].map(tabCount),
    rail: [...document.querySelectorAll('#dashRail [data-rail-card] .dash-rail-title')].map((el) => el.textContent),
    needsYou: await (async () => { await showInbox(); return rows().map((el) => el.querySelector('.nrow-title')?.textContent) })(),
  }
}

// What every boot of seed() makes and shows, as it did before the view existed
// (each test checks itself against these, so any one runs alone with -t). The
// boot reads, then one poll tick's nine reads.
const POLL = ['/api/items', '/api/boards', '/api/boards/archived/summary', '/api/activity',
  '/api/activity/history?since_ms=1781949600000', '/api/projects/closed', '/api/links', '/api/issues', '/api/messages']
const BOOT_REQUESTS = ['/api/version', '/api/setup', ...POLL, ...POLL]
const SURFACES = {
  title: '(3) Agent Inbox',
  badge: 3,
  tabs: ['3', '1', '1', ''],
  rail: ['Approve it.', 'Ship the search ranking?', 'Retry 4xx?'],
  needsYou: ['Approve it.', 'Ship the search ranking?', 'Retry 4xx?'],
}

describe('the Agents view, always on (#454)', () => {
  it('opens on the Agents lens, reads nothing new and leaves every attention surface alone', async () => {
    db = freshDb()
    seed(db)
    const requests: string[] = []
    await bootApp(db, { interceptFetch: async (input, _init, next) => { requests.push(route(input)); return next() } })
    await pollTick()
    await settle()
    expect(requests).toEqual(BOOT_REQUESTS)
    expect(document.getElementById('mesh-settings')).toBeNull()

    const lens = [...document.querySelectorAll<HTMLButtonElement>('.mesh-lens [data-mesh-lens]')]
    expect(lens.map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([['Sessions', 'false'], ['Agents', 'true']])
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

    // the Sessions lens brings the lanes back, window-local
    click(lens[0])
    expect(document.querySelector<HTMLElement>('.dash-lanes')?.hidden).toBe(false)
    expect(document.querySelector<HTMLElement>('.mesh-agents')?.hidden).toBe(true)
    click(lens[1])
    expect(document.querySelector<HTMLElement>('.dash-lanes')?.hidden).toBe(true)

    // with the Agents lens drawn, the human's attention reads as it always did
    expect(await surfaces()).toEqual(SURFACES)
  })

  it('a session line’s Message button opens the Live drawer with that session’s composer, focused (#411)', async () => {
    db = freshDb()
    seed(db)
    upsertActivity(db, { session: 'k2', agent: 'claude-code', project: 'demo', stream: 'main', doing: 'open', idle: true, claim: false, receives_messages: true })
    await bootApp(db)
    await pollTick()
    await settle()
    const line = [...document.querySelectorAll<HTMLElement>('.mesh-session')].find((el) => el.dataset.meshSession === 'k2')
    click(line?.querySelector('.mesh-message'))
    await settle()
    const drawer = document.getElementById('liveDrawer')!
    expect(drawer.hidden).toBe(false)
    // an idle session's composer sits in the idle fold, which opens for it
    expect(drawer.querySelector<HTMLDetailsElement>('.idle-fold')?.open).toBe(true)
    const composer = drawer.querySelector<HTMLElement>('.msg-composer')
    expect(composer?.dataset.msgSession).toBe('k2')
    expect(document.activeElement).toBe(composer?.querySelector('textarea'))
    expect(composer?.querySelector('label')?.textContent).toBe('Message to claude-code · demo · main')
    drawer.hidden = true // leaves later boots' drawer listeners idle
  })
})
