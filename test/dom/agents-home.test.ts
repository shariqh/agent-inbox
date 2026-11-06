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

// The two questions name no session: each is an ask-only card, "No session" (#454 A.1).
const ids = { ship: '', retry: '' }
function seed(d: Database.Database): void {
  ids.ship = insertItem(d, { project: 'agent-inbox', stream: 'feat/412', agent: 'copilot', kind: 'question', title: 'Ship the search ranking?' })
  advanceClock()
  ids.retry = insertItem(d, { project: 'demo', stream: 'main', agent: 'claude-code', kind: 'question', title: 'Retry 4xx?' })
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

    // the lanes and their lens are gone (#454): the Agents home is the Dashboard's one list of sessions
    expect(document.querySelector('.dash-lanes, .mesh-lens')).toBeNull()
    expect(document.querySelector<HTMLElement>('.agents-home')?.hidden).toBe(false)
    // grouped by project; Needs you first, then the newest call. k1's ask is a row of its linked plan;
    // each question naming no session has an ask-only card, so every ask is on one card (#454 A.1)
    expect(groups()).toEqual([
      ['agent-inbox', ['session:k1', `ask:item:${ids.ship}`, 'session:c1']],
      ['demo', [`ask:item:${ids.retry}`, 'session:c2', 'session:k2']],
    ])
    expect(document.querySelector('.agents-home .ah-count')?.textContent).toBe('6 sessions')
    // Needs you counts what the badge does
    expect([...document.querySelectorAll('.agents-home [data-ah-filter]')].map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
      ['All6', 'true'], ['Needs you3', 'false'], ['Working2', 'false'], ['Quiet1', 'false'], ['Parked or stopped0', 'false'],
    ])
    const orphan = card(`ask:item:${ids.retry}`)!
    expect(orphan.classList.contains('sc-ask-only')).toBe(true)
    expect([orphan.querySelector('.sc-state')?.textContent, orphan.querySelector('.sc-agent')?.textContent, orphan.querySelector('.sc-ask-title')?.textContent])
      .toEqual(['No session', 'Claude Code', 'Retry 4xx?'])
    expect([...orphan.querySelectorAll('[data-ah-action]')].map((el) => el.textContent)).toEqual(['Open in Inbox', 'Answer'])
    const ask = card('session:k1')!
    expect(ask.querySelector('.sc-state')?.textContent).toBe('Needs you')
    // V1 (#454 A.3): the agent kind is plain text in the meta line, its origin in the title
    expect([ask.querySelector('.sc-agent')?.textContent, ask.querySelector<HTMLElement>('.sc-agent')?.title]).toEqual(['Claude Code', 'Claude Code · terminal'])
    expect(ask.querySelector('.sc-ask-title')?.textContent).toBe('Approve the metric set')
    const working = card('session:c2')!
    expect([working.querySelector('.sc-state')?.textContent, working.querySelector('.sc-doing')?.textContent, working.querySelector('.sc-branch')?.textContent])
      .toEqual(['Working', 'Reviewing PR #57', 'main'])
    expect(working.querySelector('.sc-spark')?.getAttribute('aria-label')).toBe('1 MCP call in the last 30 minutes')
    expect(card('session:k2')?.querySelector('.sc-state')?.textContent).toBe('Quiet')

    // an unchanged poll keeps the nodes; agent text is text, never markup
    const before = card('session:c1')
    const parts = [...before!.querySelectorAll('.sc-chips > *, .sc-foot > *, .sc-where > *')]
    await pollTick()
    await settle()
    expect(card('session:c1')).toBe(before)
    expect([...before!.querySelectorAll('.sc-chips > *, .sc-foot > *, .sc-where > *')]).toEqual(parts)
    expect(document.querySelectorAll('.agents-home script, .agents-home img')).toHaveLength(0)

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
    expect(groups()).toEqual([['Claude Code', ['session:k1', `ask:item:${ids.retry}`, 'session:k2']], ['Copilot', [`ask:item:${ids.ship}`, 'session:c2', 'session:c1']]])
  })

  it('Review opens the session panel at the card’s asks, which agree with its count; a click toggles the panel', async () => {
    db = freshDb()
    seed(db)
    await bootApp(db)
    await pollTick()
    await settle()
    const aside = document.querySelector<HTMLElement>('#dashboard .dash-focus')!
    click(card('session:k1')?.querySelector('[data-ah-action="review"]'))
    expect(aside.hidden).toBe(false)
    expect(aside.dataset.session).toBe('k1')
    // the panel lists exactly the card's asks, each answered in place (#454 A.2), and lands on the ask, never an option
    const asks = [...aside.querySelectorAll('.dash-focus-asks .sp-ask-title')].map((el) => el.textContent)
    expect(asks).toEqual(['Approve it.'])
    expect(document.activeElement).toBe(aside.querySelector('.dash-focus-asks [data-panel-ask]'))
    expect(card('session:k1')?.classList.contains('sel')).toBe(true)
    expect([...aside.querySelectorAll('.dash-focus-asks .opt-pill')].map((el) => el.textContent)).toEqual(['★Approverecommended', 'Hold'])
    click(card('session:c1')?.querySelector('.sc-doing'))
    expect(aside.hidden).toBe(false)
    expect(aside.dataset.session).toBe('c1')
    expect(aside.querySelector('.sp-state')?.textContent).toBe('Working')
    expect(aside.querySelector('#dashFocusTitle')?.textContent).toBe('agent-inbox · feat/412')
    // a terminal session's panel has no action bar or transcript (§3.3)
    expect(aside.querySelector<HTMLElement>('.sp-actions')?.hidden).toBe(true)
    expect(aside.querySelector<HTMLElement>('.sp-transcript')?.hidden).toBe(true)
    // a second click on the same card closes it, as a lane's does
    click(card('session:c1')?.querySelector('.sc-doing'))
    expect(aside.hidden).toBe(true)
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
    // 9 h on, their claims have gone cold: idle; k1 still takes its plan's ask by the join (#454 A.1 step 2)
    expect(groups().flatMap(([, list]) => list)).toEqual(['session:k1', `ask:item:${ids.ship}`, 'session:c1'])
    expect(card('session:k1')?.querySelector('.sc-state')?.textContent).toBe('Needs you')
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

  it('a card’s Message opens the session panel with that session’s composer, focused (#411)', async () => {
    db = freshDb()
    seed(db)
    upsertActivity(db, { session: 'k2', agent: 'claude-code', project: 'demo', stream: 'main', doing: 'open', idle: true, claim: false, receives_messages: true })
    await bootApp(db)
    await pollTick()
    await settle()
    expect(card('session:k2')?.querySelector('.sc-meta')?.textContent).toBe('It sees a message when it next checks')
    click(card('session:k2')?.querySelector('[data-ah-action="message"]'))
    await settle()
    const aside = document.querySelector<HTMLElement>('#dashboard .dash-focus')!
    expect(aside.hidden).toBe(false)
    const composer = aside.querySelector<HTMLElement>('.dash-focus-message .msg-composer')
    expect(composer?.dataset.msgSession).toBe('k2')
    expect(document.activeElement).toBe(composer?.querySelector('textarea'))
    expect(composer?.querySelector('label')?.textContent).toBe('Message to claude-code · demo · main')
    expect(document.getElementById('liveDrawer')).toBeNull()
  })

})
