// @vitest-environment jsdom
// The Agents home (#454, design docs/superpowers/specs/2026-11-04-agents-home-design.md
// §3, §4), now the Working and Quiet lanes (dashboard lanes design §3.3, §3.4):
// one card or row per session, always on. It reads nothing new (the page makes
// exactly the requests it made before) and never feeds attention: the human's
// attention surfaces read the same with it drawn.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { getBoard, insertItem, recordActivityCall, setActivityPlace, touchActivity, upsertActivity, upsertBoard } from '../../src/store.js'
import { advanceClock, badgeCount, bootApp, click, freshDb, pollTick, rows, settle, showInbox, tabCount, useDomTest } from './harness.js'
import { closeProject } from '../../src/store.js'

useDomTest()
let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const route = (input: RequestInfo | URL): string => String(input)

// The two questions name no session: no card holds them; the Needs you lane
// shows them, "no session" (dashboard lanes design §6).
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
    tabs: ['dashboard', 'find', 'boards'].map(tabCount),
    needsYou: await (async () => { await showInbox(); return rows().map((el) => el.querySelector('.nrow-title')?.textContent) })(),
  }
}

// What every boot of seed() makes and shows, as it did before the view existed
// (each test checks itself against these, so any one runs alone with -t). The
// boot reads, then one poll tick's nine reads. The active plans are read as their
// tags (slow links, step 2): the first round then reads seed()'s one plan by id,
// after its nine reads have answered, and the next round, nothing having changed,
// reads no plan.
const POLL = ['/api/items', '/api/boards/tags', '/api/boards/archived/summary', '/api/activity',
  '/api/activity/history?since_ms=1781949600000', '/api/projects/closed', '/api/links', '/api/issues', '/api/messages']
const bootRequests = (d: Database.Database) =>
  ['/api/version', '/api/setup', ...POLL, `/api/boards/plans?ids=${getBoard(d, 'agent-inbox', 'Mesh metrics')!.id}`, ...POLL]
const SURFACES = {
  title: '(3) Agent Inbox',
  badge: 3,
  tabs: ['3', '1', '1'], // Home, Find (unread notes), Plans: History's total went with its page
  needsYou: ['Approve it.', 'Ship the search ranking?', 'Retry 4xx?'],
}

const card = (id: string) => [...document.querySelectorAll<HTMLElement>('[data-session-card]')].find((el) => el.dataset.sessionCard === id) ?? null
// Working's project groups, and Quiet's rows
const groups = () => [...document.querySelectorAll<HTMLElement>('.agents-home .working-lane .ah-groups > .ah-group')]
  .map((group) => [group.querySelector('.ah-group-name')?.textContent, [...group.querySelectorAll<HTMLElement>('[data-session-card]')].map((el) => el.dataset.sessionCard)])
const quietRows = () => [...document.querySelectorAll<HTMLElement>('.agents-home .quiet-lane .qt-rows [data-session-card]')].map((el) => el.dataset.sessionCard)

describe('the Agents home (#454)', () => {
  it('opens on Agents with one card per session, reads nothing new and leaves every attention surface alone', async () => {
    db = freshDb()
    seed(db)
    const requests: string[] = []
    await bootApp(db, { interceptFetch: async (input, _init, next) => { requests.push(route(input)); return next() } })
    await pollTick()
    await settle()
    expect(requests).toEqual(bootRequests(db))
    expect(document.getElementById('mesh-settings')).toBeNull()

    // the lanes and their lens are gone (#454): the Agents home is the Dashboard's one list of sessions
    expect(document.querySelector('.dash-lanes, .mesh-lens')).toBeNull()
    expect(document.querySelector<HTMLElement>('.agents-home')?.hidden).toBe(false)
    // Working grouped by project, the newest call first; the quiet one is a Quiet row.
    // Asks never move a card (lanes design §3.3)
    expect(groups()).toEqual([
      ['agent-inbox', ['session:k1', 'session:c1']],
      ['demo', ['session:c2']],
    ])
    expect(quietRows()).toEqual(['session:k2'])
    // no filter, group-by or count beside a heading
    expect([document.querySelectorAll('#dashboard .working-lane .ah-cards [data-session-card]').length, document.querySelectorAll('#dashboard .quiet-lane .qt-rows [data-session-card]').length]).toEqual([3, 1])
    expect(document.querySelector('.agents-home [data-ah-filter], .agents-home .ah-count, .agents-home .ah-group-by')).toBeNull()
    // a question naming no session is in Home's list only
    const orphan = document.querySelector<HTMLElement>(`#needsYouList .nrow[data-card-id="${ids.retry}"]`)!
    expect([orphan.querySelector('.nrow-session'), orphan.querySelector('.nrow-title')?.textContent]).toEqual([null, 'Retry 4xx?'])
    expect(document.querySelector('#dashboard [data-session-card^="ask:"]')).toBeNull()
    const ask = card('session:k1')!
    // k1's ask is a row of its linked plan: its card keeps its state and counts it
    expect(ask.querySelector('.sc-state')?.textContent).toBe('Working')
    expect(ask.querySelector('.sc-asking')?.textContent).toBe('Asking you · 1')
    // V1 (#454 A.3): the agent kind is plain text in the meta line, its origin in the title
    expect([ask.querySelector('.sc-agent')?.textContent, ask.querySelector<HTMLElement>('.sc-agent')?.title]).toEqual(['Claude Code', 'Claude Code · terminal'])
    expect(ask.textContent).not.toContain('Approve the metric set')
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

  it('groups Working by project with no filter or group-by, the agent kind on each card (lanes design §3.3)', async () => {
    db = freshDb()
    seed(db)
    await bootApp(db)
    await pollTick()
    await settle()
    // a group sits where its first card does: k1's call is the newest
    expect(groups()).toEqual([['agent-inbox', ['session:k1', 'session:c1']], ['demo', ['session:c2']]])
    expect(['session:k1', 'session:c1', 'session:c2'].map((id) => card(id)?.querySelector('.sc-agent')?.textContent)).toEqual(['Claude Code', 'Copilot', 'Copilot'])
    expect(card('session:k2')?.querySelector('.sc-agent')?.textContent).toBe('Claude Code')
    expect(document.querySelector('.agents-home .ah-none, .agents-home .ah-show-all, .agents-home select')).toBeNull()
  })

  it('a card’s click opens the session panel listing the card’s asks, which agree with its chip; a click toggles the panel', async () => {
    db = freshDb()
    seed(db)
    await bootApp(db)
    await pollTick()
    await settle()
    const aside = document.querySelector<HTMLElement>('#dashboard .dash-focus')!
    click(card('session:k1')?.querySelector('.sc-doing'))
    expect(aside.hidden).toBe(false)
    expect(aside.dataset.session).toBe('k1')
    // the panel lists exactly the card's asks, each answered in place (#454 A.2; the lanes design §6 keeps it)
    const asks = [...aside.querySelectorAll('.dash-focus-asks .sp-ask-title')].map((el) => el.textContent)
    expect(asks).toEqual(['Approve it.'])
    expect(card('session:k1')?.querySelector('.sc-asking')?.textContent).toBe(`Asking you · ${asks.length}`)
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
    // 9 h on, their claims have gone cold: idle, in Quiet; k1 still takes its plan's ask by the join (#454 A.1 step 2)
    expect(groups()).toEqual([])
    expect(quietRows()).toEqual(['session:c1', 'session:k1'])
    expect(card('session:k1')?.querySelector('.sc-asking')?.textContent).toBe('Asking you · 1')
    // opening the fold paints its cards at once, not at the next poll
    fold('closed').open = true
    fold('closed').dispatchEvent(new Event('toggle'))
    expect([...fold('closed').querySelectorAll<HTMLElement>('[data-session-card]')].map((el) => el.dataset.sessionCard)).toEqual(['session:c2', 'session:k2'])
  })

  it('with no session, says how one appears in the Working lane (§3.6, lanes design §3.3)', async () => {
    db = freshDb()
    await bootApp(db)
    await pollTick()
    await settle()
    const home = document.querySelector<HTMLElement>('.agents-home')!
    expect(home.querySelector<HTMLElement>('.ah-empty')?.hidden).toBe(false)
    expect(home.querySelector('.ah-empty-text')?.textContent).toBe('No sessions yet. A Claude Code or Copilot session appears here once Agent Inbox’s MCP server starts in it.')
    expect(home.querySelector('.working-lane .ah-empty')).not.toBeNull()
    // with the switch off (a browser), no New session either (it sits in the Working lane's head)
    expect(document.querySelector<HTMLElement>('#dashboard .working-lane > .ah-lane-head .ah-new')?.hidden).toBe(true)
  })

  it('a card’s Message opens the session panel with that session’s composer, focused (#411)', async () => {
    db = freshDb()
    seed(db)
    upsertActivity(db, { session: 'k2', agent: 'claude-code', project: 'demo', stream: 'main', doing: 'open', idle: true, claim: false, receives_messages: true })
    await bootApp(db)
    await pollTick()
    await settle()
    // a Quiet row's one line has no room for it: when a message reaches it is in Message's title
    expect(card('session:k2')?.querySelector<HTMLElement>('[data-ah-action="message"]')?.title).toBe('Message this session. It sees a message when it next checks')
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

// #617 PR 1: where a session runs. The card shows "machine · desk" in its second line; a row an older
// server wrote has none of the fields and draws exactly what it drew before.
describe('where a session runs, on the card (#617)', () => {
  const work = (d: Database.Database, session: string, place: { machine?: string; pane?: string } = {}) => {
    upsertActivity(d, { session, agent: 'claude-code', project: 'alpha', stream: 'main', doing: 'Painting', ...place })
    recordActivityCall(d, session)
  }
  const where = (id: string) => card(id)?.querySelector<HTMLElement>('.sc-where') ?? null

  it('shows the machine and desk on the card, and only the machine until a desk is known', async () => {
    db = freshDb()
    work(db, 'p', { machine: 'hub', pane: '%3' })
    work(db, 'm', { machine: 'hub' })
    setActivityPlace(db, 'p', { desk: 'api', remote_session: 'session_abc' })
    await bootApp(db)
    await pollTick()
    await settle()
    const place = card('session:p')!.querySelector<HTMLElement>('.sc-where .sc-place')!
    expect(place.textContent).toBe('hub · api')
    expect(place.title).toBe('hub · api')
    expect(where('session:p')!.hidden).toBe(false)
    expect(card('session:m')!.querySelector('.sc-where .sc-place')?.textContent).toBe('hub')
    // the card carries no link and no command: they are the panel's
    expect(card('session:p')!.querySelector('a, [data-focus-target]')).toBeNull()
    expect(card('session:p')!.textContent).not.toContain('claude.ai')
    expect(card('session:p')!.textContent).not.toContain('tmux attach')

    // a desk that appears later is drawn by the next poll, in the same node's place
    setActivityPlace(db, 'm', { desk: 'work', remote_session: null })
    await pollTick()
    await settle()
    expect(card('session:m')!.querySelector('.sc-place')?.textContent).toBe('hub · work')
    // …and one that goes away goes with it
    setActivityPlace(db, 'm', { desk: null, remote_session: null })
    await pollTick()
    await settle()
    expect(card('session:m')!.querySelector('.sc-place')?.textContent).toBe('hub')
  })

  it('a row with none of the fields draws exactly what it drew before: no place node, no second line, and the same card around it', async () => {
    db = freshDb()
    work(db, 'p', { machine: 'hub' })
    work(db, 'n')
    setActivityPlace(db, 'p', { desk: 'api', remote_session: null })
    await bootApp(db)
    await pollTick()
    await settle()
    const n = card('session:n')!
    expect(n.querySelector('.sc-place')).toBeNull()
    expect(where('session:n')!.hidden).toBe(true)
    expect(where('session:n')!.childElementCount).toBe(0)
    // the placed card is the unplaced one plus its place line: take it out and the two read alike
    const p = card('session:p')!
    p.querySelector('.sc-place')!.remove()
    expect(where('session:p')!.childElementCount).toBe(0)
    for (const part of ['.sc-top', '.sc-doing', '.sc-foot']) {
      expect(p.querySelector(part)!.innerHTML.replaceAll('session:p', 'session:n'), part).toBe(n.querySelector(part)!.innerHTML)
    }
  })

  it('gives the place line its full text as its title, so a clipped one can still be read', async () => {
    db = freshDb()
    work(db, 'p', { machine: 'a-long-machine-name' })
    setActivityPlace(db, 'p', { desk: 'a-long-desk-name', remote_session: null })
    await bootApp(db)
    await pollTick()
    await settle()
    const place = card('session:p')!.querySelector<HTMLElement>('.sc-place')!
    expect(place.textContent).toBe('a-long-machine-name · a-long-desk-name')
    expect(place.title).toBe('a-long-machine-name · a-long-desk-name')
  })

  describe('on a Quiet row', () => {
    const idle = (d: Database.Database, session: string, place: { machine?: string; pane?: string } = {}) => {
      upsertActivity(d, { session, agent: 'claude-code', project: 'alpha', stream: 'main', doing: 'open', idle: true, claim: false, ...place })
    }
    const caption = (id: string) => card(id)!.querySelector<HTMLElement>('.qt-caption')!

    it('shows the place in the caption cell, muted, and follows the session', async () => {
      db = freshDb()
      idle(db, 'q', { machine: 'hub' })
      setActivityPlace(db, 'q', { desk: 'api', remote_session: null })
      await bootApp(db)
      await pollTick()
      await settle()
      expect(quietRows()).toContain('session:q')
      const place = caption('session:q').querySelector<HTMLElement>('.sc-place')!
      expect([place.textContent, place.title]).toEqual(['hub · api', 'hub · api'])
      setActivityPlace(db, 'q', { desk: null, remote_session: null })
      await pollTick()
      await settle()
      expect(caption('session:q').querySelector('.sc-place')?.textContent).toBe('hub')
    })

    it('a Quiet row with no place draws exactly what it drew before: no place node, the same caption cell', async () => {
      db = freshDb()
      idle(db, 'q', { machine: 'hub' })
      idle(db, 'n')
      setActivityPlace(db, 'q', { desk: 'api', remote_session: null })
      await bootApp(db)
      await pollTick()
      await settle()
      const n = caption('session:n')
      expect(n.querySelector('.sc-place')).toBeNull()
      expect([...n.children].map((el) => el.classList[0])).toEqual(['sc-asking', 'sc-doing'])
      // the placed row is the plain one plus its place node
      const q = caption('session:q')
      q.querySelector('.sc-place')!.remove()
      expect(q.innerHTML.replaceAll('session:q', 'session:n')).toBe(n.innerHTML)
      expect(card('session:n')!.querySelector('.qt-session')!.innerHTML).toBe(card('session:q')!.querySelector('.qt-session')!.innerHTML)
    })
  })

  it('draws a name only by textContent, and shows nothing for a value that fails its pattern', async () => {
    db = freshDb()
    work(db, 'a', { machine: 'hub' })
    work(db, 'b', { machine: 'hub' })
    work(db, 'c')
    const raw = db.prepare(`UPDATE activity SET machine = ?, desk = ? WHERE session = ?`)
    raw.run('hub', '<img src=x onerror=alert(1)>', 'a')
    raw.run('<b>hub</b>', 'api', 'b')
    raw.run('hub', 'api', 'c')
    await bootApp(db)
    await pollTick()
    await settle()
    expect(card('session:a')!.querySelector('.sc-place')?.textContent).toBe('hub')
    expect(card('session:b')!.querySelector('.sc-place')).toBeNull()
    expect(card('session:c')!.querySelector('.sc-place')?.textContent).toBe('hub · api')
    expect(document.querySelector('[data-session-card] img, [data-session-card] b')).toBeNull()
  })
})

// #617 PR 4b: Open desk on a card and on a Quiet row, on the hub's page shown from another Mac, where
// agentInboxDesk.available() answers { open: true }; only for a session with a desk. Its click opens
// the desk and never the card's panel.
describe('Open desk on a card (#617 PR 4b)', () => {
  function hubDesk(open = true) {
    const desk = {
      available: vi.fn(async () => ({ open })),
      open: vi.fn(async (_request: { session: string }): Promise<unknown> => ({ ok: true })),
      connection: vi.fn(async () => ({ mode: 'hub', label: 'studio', state: 'online', version: '2.13.0' })),
      onConnection: vi.fn(() => () => {}),
    }
    Object.defineProperty(window, 'agentInboxDesk', { configurable: true, value: desk })
    return desk
  }
  afterEach(() => { Reflect.deleteProperty(window, 'agentInboxDesk') })
  const work = (d: Database.Database, session: string, place: { machine?: string } = {}) => {
    upsertActivity(d, { session, agent: 'claude-code', project: 'alpha', stream: 'main', doing: 'Painting', ...place })
    recordActivityCall(d, session)
  }
  const idle = (d: Database.Database, session: string, place: { machine?: string } = {}) => {
    upsertActivity(d, { session, agent: 'claude-code', project: 'alpha', stream: 'main', doing: 'open', idle: true, claim: false, ...place })
  }
  const deskButton = (id: string) => card(id)?.querySelector<HTMLButtonElement>('.desk-open-button') ?? null
  const panelOpen = () => document.querySelector<HTMLElement>('#dashboard .dash-focus')?.dataset.session ?? null

  it('shows Open desk beside the place for a session with a desk, and not for one without', async () => {
    db = freshDb()
    work(db, 'p', { machine: 'hub' })
    work(db, 'm', { machine: 'hub' })
    setActivityPlace(db, 'p', { desk: 'api', remote_session: null })
    hubDesk()
    await bootApp(db)
    await pollTick()
    await settle()
    const button = deskButton('session:p')!
    expect([button.textContent, button.type, button.tabIndex]).toEqual(['Open desk', 'button', 0])
    expect(button.closest('.sc-where')?.querySelector('.sc-place')?.textContent).toBe('hub · api')
    expect(deskButton('session:m')).toBeNull()
  })

  it('shows none where available() says no: This Mac’s page and a page with no command saved', async () => {
    db = freshDb()
    work(db, 'p', { machine: 'hub' })
    setActivityPlace(db, 'p', { desk: 'api', remote_session: null })
    hubDesk(false)
    await bootApp(db)
    await pollTick()
    await settle()
    expect(card('session:p')!.querySelector('.sc-place')?.textContent).toBe('hub · api')
    expect(card('session:p')!.querySelector('.desk-open')).toBeNull()
  })

  it('a click opens the desk with the row’s session and leaves the card’s panel closed; Enter on the button does the same', async () => {
    db = freshDb()
    work(db, 'p', { machine: 'hub' })
    setActivityPlace(db, 'p', { desk: 'api', remote_session: null })
    const desk = hubDesk()
    await bootApp(db)
    await pollTick()
    await settle()
    const before = panelOpen()
    click(deskButton('session:p'))
    await settle()
    expect(desk.open.mock.calls).toEqual([[{ session: 'p' }]])
    expect(panelOpen()).toBe(before)
    expect(deskButton('session:p')!.textContent).toBe('Opened')
    // the keyboard reaches it as any button: focus, then Enter (a button's Enter is its click)
    await vi.advanceTimersByTimeAsync(2_000)
    const button = deskButton('session:p')!
    button.focus()
    expect(document.activeElement).toBe(button)
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(panelOpen()).toBe(before)
  })

  it('on a Quiet row: the button follows the place, and its click opens no panel', async () => {
    db = freshDb()
    idle(db, 'q', { machine: 'hub' })
    setActivityPlace(db, 'q', { desk: 'api', remote_session: null })
    const desk = hubDesk()
    await bootApp(db)
    await pollTick()
    await settle()
    const caption = card('session:q')!.querySelector<HTMLElement>('.qt-caption')!
    expect([...caption.children].map((el) => el.classList[0])).toEqual(['sc-asking', 'sc-doing', 'sc-place', 'desk-open'])
    const before = panelOpen()
    click(caption.querySelector('.desk-open-button'))
    await settle()
    expect(desk.open.mock.calls).toEqual([[{ session: 'q' }]])
    expect(panelOpen()).toBe(before)
    // a desk that goes away takes its button with it
    setActivityPlace(db, 'q', { desk: null, remote_session: null })
    await pollTick()
    await settle()
    expect(card('session:q')!.querySelector('.desk-open')).toBeNull()
  })

  it('says a refusal beside the button, as text', async () => {
    db = freshDb()
    work(db, 'p', { machine: 'hub' })
    setActivityPlace(db, 'p', { desk: 'api', remote_session: null })
    const desk = hubDesk()
    desk.open.mockResolvedValue({ ok: false, reason: 'not_on_hub' })
    await bootApp(db)
    await pollTick()
    await settle()
    click(deskButton('session:p'))
    await settle()
    expect(card('session:p')!.querySelector('.desk-open-note')?.textContent).toBe('That session runs on a different machine.')
  })
})
