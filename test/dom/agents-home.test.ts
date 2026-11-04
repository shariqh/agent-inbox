// @vitest-environment jsdom
// The Agents home (#454, design docs/superpowers/specs/2026-11-04-agents-home-design.md
// §3, §4): one card per session, always on. It reads nothing new (the page
// makes exactly the requests it made before) and never feeds attention: the
// human's attention surfaces read the same with it drawn.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, recordActivityCall, touchActivity, upsertActivity, upsertBoard } from '../../src/store.js'
import { advanceClock, badgeCount, bootApp, click, freshDb, pollTick, rows, settle, showInbox, tabCount, useDomTest } from './harness.js'
import { closeProject } from '../../src/store.js'

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

const card = (id: string) => [...document.querySelectorAll<HTMLElement>('[data-session-card]')].find((el) => el.dataset.sessionCard === id) ?? null
const groups = () => [...document.querySelectorAll<HTMLElement>('.agents-home .ah-groups > .ah-group')]
  .map((group) => [group.querySelector('.ah-group-name')?.textContent, [...group.querySelectorAll<HTMLElement>('[data-session-card]')].map((el) => el.dataset.sessionCard)])
const filterButton = (key: string) => document.querySelector<HTMLButtonElement>(`.agents-home [data-ah-filter="${key}"]`)

describe('the Agents home (#454)', () => {
  it('opens on Agents with one card per session, reads nothing new and leaves every attention surface alone', async () => {
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
    expect(document.querySelector<HTMLElement>('.agents-home')?.hidden).toBe(false)
    // grouped by project; Needs you first, then the newest call. k1's ask is a row of its linked plan.
    expect(groups()).toEqual([
      ['agent-inbox', ['session:k1', 'session:c1']],
      ['demo', ['session:c2', 'session:k2']],
    ])
    expect(document.querySelector('.agents-home .ah-count')?.textContent).toBe('4 sessions')
    expect([...document.querySelectorAll('.agents-home [data-ah-filter]')].map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
      ['All4', 'true'], ['Needs you1', 'false'], ['Working2', 'false'], ['Idle1', 'false'], ['Parked0', 'false'],
    ])
    const ask = card('session:k1')!
    expect(ask.querySelector('.sc-state')?.textContent).toBe('Needs you')
    expect(ask.querySelector('.sc-chips')?.textContent).toBe('Claude Code · terminal')
    expect(ask.querySelector('.sc-ask-title')?.textContent).toBe('Approve the metric set')
    const working = card('session:c2')!
    expect([working.querySelector('.sc-state')?.textContent, working.querySelector('.sc-doing')?.textContent, working.querySelector('.sc-branch')?.textContent])
      .toEqual(['Working', 'Reviewing PR #57', 'main'])
    expect(working.querySelector('.sc-spark')?.getAttribute('aria-label')).toBe('1 MCP call in the last 30 minutes')
    expect(card('session:k2')?.querySelector('.sc-state')?.textContent).toBe('Idle')

    // an unchanged poll keeps the nodes; agent text is text, never markup
    const before = card('session:c1')
    const parts = [...before!.querySelectorAll('.sc-chips > *, .sc-foot > *, .sc-where > *')]
    await pollTick()
    await settle()
    expect(card('session:c1')).toBe(before)
    expect([...before!.querySelectorAll('.sc-chips > *, .sc-foot > *, .sc-where > *')]).toEqual(parts)
    expect(document.querySelectorAll('.agents-home script, .agents-home img')).toHaveLength(0)

    // the Sessions lens brings the lanes back, window-local
    click(lens[0])
    expect(document.querySelector<HTMLElement>('.dash-lanes')?.hidden).toBe(false)
    expect(document.querySelector<HTMLElement>('.agents-home')?.hidden).toBe(true)
    click(lens[1])
    expect(document.querySelector<HTMLElement>('.dash-lanes')?.hidden).toBe(true)

    // with the Agents home drawn, the human's attention reads as it always did
    expect(await surfaces()).toEqual(SURFACES)
  })

  it('filters by state, says when nothing matches, and groups by agent kind', async () => {
    db = freshDb()
    seed(db)
    await bootApp(db)
    await pollTick()
    await settle()
    click(filterButton('working'))
    // a group sits where its first shown card does: c2's call is newer than c1's
    expect(groups()).toEqual([['demo', ['session:c2']], ['agent-inbox', ['session:c1']]])
    click(filterButton('parked'))
    expect(groups()).toEqual([])
    const none = document.querySelector<HTMLElement>('.agents-home .ah-none')!
    expect([none.hidden, none.querySelector('p')?.textContent]).toEqual([false, 'No session matches these filters.'])
    click(none.querySelector('.ah-show-all'))
    expect(filterButton('all')?.getAttribute('aria-pressed')).toBe('true')
    expect(none.hidden).toBe(true)
    const select = document.querySelector<HTMLSelectElement>('.agents-home .ah-group-by select')!
    select.value = 'agent'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(groups()).toEqual([['Claude Code', ['session:k1', 'session:k2']], ['Copilot', ['session:c2', 'session:c1']]])
  })

  it('an ask’s Review opens it on the rail; a card’s click opens the session panel', async () => {
    db = freshDb()
    seed(db)
    await bootApp(db)
    await pollTick()
    await settle()
    click(card('session:k1')?.querySelector('[data-ah-action="review"]'))
    expect(document.activeElement?.closest('[data-rail-card]')?.querySelector('.dash-rail-title')?.textContent).toBe('Approve it.')
    click(card('session:c1')?.querySelector('.sc-doing'))
    expect(document.querySelector<HTMLElement>('#dashboard .dash-focus')?.hidden).toBe(false)
    // over the Agents list, not inside the hidden lanes
    expect(document.querySelector('.agents-home .dash-focus')).not.toBeNull()
    expect(document.querySelector('#dashboard .dash-focus')?.getAttribute('data-session')).toBe('c1')
    // a second click on the same card closes it, as a lane's does
    click(card('session:c1')?.querySelector('.sc-doing'))
    expect(document.querySelector<HTMLElement>('#dashboard .dash-focus')?.hidden).toBe(true)
  })

  it('folds the dormant and the closed projects’ sessions, painting their cards only while open', async () => {
    db = freshDb()
    seed(db)
    upsertActivity(db, { session: 'old', agent: 'copilot', project: 'agent-inbox', stream: 'main', doing: 'Long gone' })
    recordActivityCall(db, 'old')
    upsertActivity(db, { session: 'old', agent: 'copilot', project: 'agent-inbox', stream: 'main', doing: 'open', idle: true })
    advanceClock(9 * 60 * 60 * 1000)
    // the heartbeat keeps a quiet session present; only its calls stopped
    for (const session of ['c1', 'c2', 'k1']) recordActivityCall(db, session)
    for (const session of ['old', 'k2']) touchActivity(db, session)
    closeProject(db, 'demo')
    await bootApp(db)
    await pollTick()
    await settle()
    const fold = (key: string) => document.querySelector<HTMLDetailsElement>(`.agents-home [data-ah-fold="${key}"]`)!
    expect([fold('dormant').hidden, fold('dormant').querySelector('summary')?.textContent]).toEqual([false, 'Dormant (1) · quiet 8 h or more'])
    expect([fold('closed').hidden, fold('closed').querySelector('summary')?.textContent]).toEqual([false, 'In closed projects (2)'])
    expect(fold('ended').hidden).toBe(true)
    expect(fold('dormant').querySelectorAll('[data-session-card]')).toHaveLength(0)
    expect(groups().flatMap(([, ids]) => ids)).toEqual(['session:k1', 'session:c1'])
    // opening the fold paints its cards at once, not at the next poll
    fold('closed').open = true
    fold('closed').dispatchEvent(new Event('toggle'))
    expect([...fold('closed').querySelectorAll<HTMLElement>('[data-session-card]')].map((el) => el.dataset.sessionCard)).toEqual(['session:c2', 'session:k2'])
  })

  it('with no session, says how one appears and offers no filter (§3.6)', async () => {
    db = freshDb()
    await bootApp(db)
    await pollTick()
    await settle()
    const home = document.querySelector<HTMLElement>('.agents-home')!
    expect(home.querySelector<HTMLElement>('.ah-empty')?.hidden).toBe(false)
    expect(home.querySelector('.ah-empty-text')?.textContent).toBe('No sessions yet. A Claude Code or Copilot session appears here once Agent Inbox’s MCP server starts in it.')
    expect(home.classList.contains('ah-is-empty')).toBe(true)
    // with the switch off (a browser), no New session either
    expect(home.querySelector<HTMLElement>('.ah-new')?.hidden).toBe(true)
  })

  it('a card’s Message opens the Live drawer with that session’s composer, focused (#411)', async () => {
    db = freshDb()
    seed(db)
    upsertActivity(db, { session: 'k2', agent: 'claude-code', project: 'demo', stream: 'main', doing: 'open', idle: true, claim: false, receives_messages: true })
    await bootApp(db)
    await pollTick()
    await settle()
    expect(card('session:k2')?.querySelector('.sc-meta')?.textContent).toBe('It sees a message when it next checks')
    click(card('session:k2')?.querySelector('[data-ah-action="message"]'))
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
