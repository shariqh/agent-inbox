// @vitest-environment jsdom
// Issue #411, PR 2: the human's messages to a running session — the composer in
// the Live drawer and the Dashboard session focus panel, its delivery states,
// status across polls, Withdraw, the "Not delivered" fold, durable drafts, the
// 404 fallback, and attention parity on every surface.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import {
  ackMessage, claimHookWatch, endActivity, insertItem, listSessionMessages, markMessageDelivered, recordActivityCall,
  sendSessionMessage, upsertActivity, upsertBoard,
} from '../../src/store.js'
import type { BootOptions, ViewerBridge } from './harness.js'
import {
  advanceClock, badgeCount, bootApp, changedPollTick, click, expectConsoleError, freshDb, pollTick, rows, settle, showInbox,
  tabCount, type, useDomTest,
} from './harness.js'

useDomTest()

// As in durable-drafts.test.ts: a closed page takes its unload listeners with it.
const PAGE_EVENTS = new Set(['pagehide', 'beforeunload', 'visibilitychange'])
const pageListeners: Array<[EventTarget, string, EventListenerOrEventListenerObject]> = []
beforeEach(() => {
  for (const target of [window, document] as EventTarget[]) {
    const add = target.addEventListener.bind(target)
    vi.spyOn(target, 'addEventListener').mockImplementation((kind, listener, options) => {
      if (PAGE_EVENTS.has(kind) && listener) pageListeners.push([target, kind, listener])
      add(kind, listener, options)
    })
  }
})

function closePage(): void {
  for (const [target, kind, listener] of pageListeners.splice(0)) target.removeEventListener(kind, listener)
}

let db: Database.Database | null = null
afterEach(async () => {
  // jsdom keeps every boot's document listeners, and an earlier page's drawer
  // handlers read their own (now detached) drawer: leave it closed so they stay idle
  const drawerEl = document.getElementById('liveDrawer')
  if (drawerEl) drawerEl.hidden = true
  await vi.advanceTimersByTimeAsync(300)
  closePage()
  db?.close()
  db = null
})

const KEY = 'agent-inbox-drafts-v1'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const route = (input: RequestInfo | URL): string => String(input).split('?')[0]!

interface Session { session: string; project?: string; stream?: string; agent?: string; working?: boolean; receives?: boolean; push?: boolean; host?: number }

function present(d: Database.Database, s: Session): void {
  const working = s.working ?? true
  upsertActivity(d, {
    session: s.session, project: s.project ?? 'alpha', stream: s.stream ?? 'main', agent: s.agent ?? 'copilot',
    doing: working ? `Working in ${s.session}` : 'open', idle: !working, claim: working,
    ...(s.receives === false ? {} : { receives_messages: true }),
    ...(s.push ? { push_wake: true } : {}),
    ...(s.host ? { host_pid: s.host } : {}),
  })
  if (working) recordActivityCall(d, s.session)
}

const drawer = (): HTMLElement => document.getElementById('liveDrawer') as HTMLElement
const openDrawer = (): void => { if (drawer().hidden) click(document.getElementById('liveStrip')) }
const messageButton = (session: string): HTMLButtonElement | undefined =>
  [...drawer().querySelectorAll<HTMLButtonElement>('[data-msg-open]')].find((b) => b.dataset.msgOpen === session)
const composer = (session: string, scope: ParentNode = drawer()): HTMLElement | undefined =>
  [...scope.querySelectorAll<HTMLElement>('.msg-composer')].find((el) => el.dataset.msgSession === session)
const input = (session: string, scope?: ParentNode) => composer(session, scope)?.querySelector('textarea') ?? null
const historyLines = (session: string, scope?: ParentNode) =>
  [...(composer(session, scope)?.querySelectorAll('.msg-history > .msg-item') ?? [])]
    .map((el) => [el.querySelector('.msg-text')?.textContent, el.querySelector('.msg-state')?.textContent])
const messagePosts = (bridge: ViewerBridge) => bridge.posts.filter((p) => p.url.includes('/messages'))
  .map((p) => ({ url: p.url, body: JSON.parse(String(p.init?.body)) as Record<string, unknown> }))

function stored(): Record<string, { savedAt: number; draft: Record<string, unknown> }> {
  const raw = localStorage.getItem(KEY)
  return raw ? (JSON.parse(raw) as { entries: Record<string, { savedAt: number; draft: Record<string, unknown> }> }).entries : {}
}

async function reopen(d: Database.Database, opts?: BootOptions): Promise<ViewerBridge> {
  window.dispatchEvent(new Event('pagehide'))
  closePage()
  const now = Date.now()
  vi.clearAllTimers()
  vi.setSystemTime(now)
  vi.resetModules()
  return bootApp(d, opts)
}

async function openComposer(session: string): Promise<HTMLTextAreaElement> {
  openDrawer()
  click(messageButton(session))
  await settle()
  return input(session)!
}

describe('the drawer composer (#411)', () => {
  it('opens under its session, sends with Mod+Enter and walks sent, picked up and acknowledged across polls', async () => {
    db = freshDb()
    present(db, { session: 'mcp-a', stream: 'feat-x' })
    const bridge = await bootApp(db)
    const box = await openComposer('mcp-a')
    expect(document.activeElement).toBe(box)
    expect(messageButton('mcp-a')?.getAttribute('aria-expanded')).toBe('true')
    const el = composer('mcp-a')!
    expect(el.querySelector('label')?.textContent).toBe('Message to copilot · alpha · feat-x')
    expect(el.querySelector('label')?.htmlFor).toBe(box.id)
    expect(el.querySelector('.msg-delivery')?.textContent).toBe('It sees this when it next checks Agent Inbox.')
    expect(el.querySelector('.msg-shared')?.textContent).toBe('Any agent of this session, a subagent included, may pick it up first.')
    expect(el.querySelector<HTMLButtonElement>('.msg-send')?.disabled).toBe(true)

    type(box, 'Also run the DOM tests.')
    expect(el.querySelector('.msg-count')?.textContent).toBe('23 / 4000')
    box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }))
    await settle()
    const [post] = messagePosts(bridge)
    expect(post?.url).toBe('/api/sessions/mcp-a/messages')
    expect(post?.body).toEqual({ id: expect.stringMatching(UUID), text: 'Also run the DOM tests.' })
    expect(input('mcp-a')?.value).toBe('')
    expect(historyLines('mcp-a')).toEqual([['Also run the DOM tests.', 'Sent moments ago · not picked up yet']])
    expect(document.activeElement).toBe(input('mcp-a'))
    await vi.advanceTimersByTimeAsync(300)
    expect(Object.keys(stored())).toEqual([])

    const id = String(post!.body['id'])
    advanceClock(2 * 60_000)
    markMessageDelivered(db, id, 'mcp-a', 'copilot')
    await pollTick()
    expect(historyLines('mcp-a')).toEqual([['Also run the DOM tests.', 'Picked up moments ago · working on it']])
    advanceClock(60_000)
    ackMessage(db, { id, session: 'mcp-a', outcome: 'Ran them <b>all</b>: green.' })
    await pollTick()
    const [line] = composer('mcp-a')!.querySelectorAll('.msg-item')
    expect(line?.querySelector('.msg-state')?.textContent).toBe('Acknowledged moments ago:')
    // agent text, never markup
    expect(line?.querySelector('.msg-outcome')?.textContent?.trim()).toBe('Ran them <b>all</b>: green.')
    expect(line?.querySelector('.msg-outcome b')).toBeNull()
    expect(line?.querySelector('.msg-withdraw')).toBeNull()
  })

  it('withdraws pinned to the revision it showed, and says so honestly after pickup', async () => {
    db = freshDb()
    present(db, { session: 'mcp-a' })
    const one = '00000000-0000-4000-8000-000000000001'
    const two = '00000000-0000-4000-8000-000000000002'
    sendSessionMessage(db, { id: one, session: 'mcp-a', text: 'Stop after the build.' })
    advanceClock()
    sendSessionMessage(db, { id: two, session: 'mcp-a', text: 'Skip the docs.' })
    markMessageDelivered(db, one, 'mcp-a', 'copilot')
    const bridge = await bootApp(db)
    await openComposer('mcp-a')
    const withdraw = (id: string) => [...composer('mcp-a')!.querySelectorAll<HTMLButtonElement>('[data-msg-withdraw]')]
      .find((b) => b.dataset.msgWithdraw === id)
    click(withdraw(one))
    await settle()
    click(withdraw(two))
    await settle()
    expect(messagePosts(bridge).map((p) => [p.url, p.body])).toEqual([
      [`/api/messages/${one}/withdraw`, { revision: 1 }],
      [`/api/messages/${two}/withdraw`, { revision: 1 }],
    ])
    expect(historyLines('mcp-a')).toEqual([
      ['Skip the docs.', 'Withdrawn'],
      ['Stop after the build.', 'Withdrawn after pickup: it may have started'],
    ])
  })

  it('says which delivery state applies before sending, and disables Send for a session that cannot receive', async () => {
    db = freshDb()
    present(db, { session: 'pushed', push: true })
    present(db, { session: 'hooked', host: 4100 })
    present(db, { session: 'checks' })
    present(db, { session: 'older', receives: false })
    claimHookWatch(db, 'host:4100', 'm1:9001-abc')
    await bootApp(db)
    openDrawer()
    for (const session of ['pushed', 'hooked', 'checks', 'older']) click(messageButton(session))
    await settle()
    const state = (session: string) => [
      composer(session)?.querySelector('.msg-delivery')?.textContent,
      composer(session)?.querySelector('.msg-delivery')?.getAttribute('data-state'),
      input(session)?.disabled,
    ]
    expect(state('pushed')).toEqual(['Arrives now: Agent Inbox pushes it into this session.', 'now', false])
    expect(state('hooked')).toEqual(['Arrives now: this session wakes for it.', 'now', false])
    expect(state('checks')).toEqual(['It sees this when it next checks Agent Inbox.', 'next-check', false])
    expect(state('older')).toEqual(['Can’t receive: restart this session to load v2.2.0 or later.', 'cannot', true])
    expect(composer('older')?.querySelector<HTMLButtonElement>('.msg-send')?.disabled).toBe(true)
  })

  it('keeps a refused send’s text with its reason, and Esc closes the composer keeping the draft', async () => {
    db = freshDb()
    present(db, { session: 'mcp-a' })
    for (let n = 1; n <= 20; n++) sendSessionMessage(db, { id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, session: 'mcp-a', text: `m${n}` })
    await bootApp(db)
    const box = await openComposer('mcp-a')
    type(box, 'One more.')
    click(composer('mcp-a')!.querySelector('.msg-send'))
    await settle()
    expect(composer('mcp-a')!.querySelector('[role="status"]')?.textContent).toMatch(/^Not sent: this session already has 20 open messages/)
    expect(input('mcp-a')?.value).toBe('One more.')
    expect(composer('mcp-a')!.querySelectorAll('.msg-history > .msg-item')).toHaveLength(5)
    expect(composer('mcp-a')!.querySelector('.msg-earlier > summary')?.textContent).toBe('+15 earlier')

    input('mcp-a')!.focus()
    input('mcp-a')!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await settle()
    expect(drawer().hidden).toBe(false)
    expect(composer('mcp-a')).toBeUndefined()
    expect(document.activeElement).toBe(messageButton('mcp-a'))
    // a closed composer that holds text says so on its button
    expect(messageButton('mcp-a')?.textContent).toBe('Message · draft')
    await vi.advanceTimersByTimeAsync(300)
    expect(stored()['message:mcp-a']?.draft).toMatchObject({ type: 'message', session: 'mcp-a', text: 'One more.', intent: null })
    click(messageButton('mcp-a'))
    await settle()
    expect(input('mcp-a')?.value).toBe('One more.')
  })

  it('keeps a focused composer and its text through polls, and a draft never pauses the lists', async () => {
    db = freshDb()
    present(db, { session: 'mcp-a' })
    await bootApp(db)
    const box = await openComposer('mcp-a')
    type(box, 'Half a thought')
    box.setSelectionRange(2, 6)
    await changedPollTick(db)
    expect(input('mcp-a')).toBe(box)
    expect(document.activeElement).toBe(box)
    expect([box.selectionStart, box.selectionEnd]).toEqual([2, 6])
    // the Inbox keeps updating: a message draft is not a typed answer
    await showInbox()
    insertItem(db, { project: 'alpha', stream: 'main', agent: 'copilot', kind: 'question', title: 'A new question' })
    await pollTick()
    expect(rows().map((el) => el.querySelector('.nrow-title')?.textContent)).toEqual(['A new question'])
    expect(document.getElementById('pauseHint')?.hidden).toBe(true)
  })
})

describe('the drawer under an unrelated draft (#420 review)', () => {
  const ask = (d: Database.Database) => insertItem(d, { project: 'alpha', stream: 'main', agent: 'copilot', kind: 'question', title: 'Hold a draft' })
  async function withReplyDraft(asked: string): Promise<void> {
    await showInbox()
    click(rows().find((el) => el.dataset.cardId === asked))
    await settle()
    type(document.querySelector<HTMLTextAreaElement>('.nrow-card .reply-input:not(.reply-context-input)'), 'Half an answer')
  }

  it('rebuilds nothing in the drawer on ticks that change nothing it draws', async () => {
    db = freshDb()
    present(db, { session: 'mcp-a' })
    const asked = ask(db)
    await bootApp(db)
    await withReplyDraft(asked)
    openDrawer()
    await pollTick()
    const list = drawer().querySelector('.live-list')!
    const mutations: MutationRecord[] = []
    const observer = new MutationObserver((records) => mutations.push(...records))
    observer.observe(list, { subtree: true, childList: true, characterData: true, attributes: true })
    for (let n = 0; n < 3; n++) {
      advanceClock(1000)
      insertItem(db, { project: 'beta', stream: 'main', agent: 'claude', kind: 'note', title: `Unrelated ${n}` })
      await pollTick()
    }
    observer.disconnect()
    expect(document.getElementById('pauseHint')?.hidden).toBe(false)
    expect(mutations).toEqual([])
  })

  it('keeps keyboard focus on a Message button when a changed tick rebuilds the drawer', async () => {
    db = freshDb()
    present(db, { session: 'mcp-a' })
    const asked = ask(db)
    await bootApp(db)
    await withReplyDraft(asked)
    openDrawer()
    messageButton('mcp-a')!.focus()
    await changedPollTick(db) // a new idle session: the drawer is rebuilt
    expect(drawer().querySelectorAll('.idle-row').length).toBeGreaterThan(0)
    expect(document.activeElement).toBe(messageButton('mcp-a'))
    expect(document.activeElement?.isConnected).toBe(true)
  })
})

describe('the session focus panel’s composer (#411)', () => {
  it('shows the session’s composer and history, keeps its node across polls, and shares the drawer’s draft', async () => {
    db = freshDb()
    present(db, { session: 'mcp-a' })
    sendSessionMessage(db, { id: '00000000-0000-4000-8000-000000000001', session: 'mcp-a', text: 'Earlier note' })
    const bridge = await bootApp(db)
    click(document.querySelector('#dashboard .dash-lane[data-lane="mcp-a"] .dash-lane-open'))
    await settle()
    const aside = document.querySelector<HTMLElement>('#dashboard .dash-focus')!
    const box = input('mcp-a', aside)!
    expect(aside.querySelector('.dash-focus-message')?.hasAttribute('hidden')).toBe(false)
    expect(historyLines('mcp-a', aside)).toEqual([['Earlier note', 'Sent moments ago · not picked up yet']])
    box.focus()
    type(box, 'From the panel')
    await changedPollTick(db)
    expect(input('mcp-a', aside)).toBe(box)
    expect(document.activeElement).toBe(box)
    // the same draft opens in the drawer
    openDrawer()
    click(messageButton('mcp-a'))
    await settle()
    expect(input('mcp-a')?.value).toBe('From the panel')
    // sent from the panel with its textarea focused: the text leaves both
    input('mcp-a', aside)!.focus()
    click(composer('mcp-a', aside)!.querySelector('.msg-send'))
    await settle()
    expect(messagePosts(bridge).map((p) => p.body['text'])).toEqual(['From the panel'])
    expect(document.activeElement).toBe(input('mcp-a', aside))
    expect(input('mcp-a', aside)?.value).toBe('')
    expect(input('mcp-a')?.value).toBe('')
  })
})

describe('the Not delivered fold (#411)', () => {
  it('lists open messages whose session ended, ten at a time, with Copy text and Withdraw, until withdrawn', async () => {
    db = freshDb()
    present(db, { session: 'gone', project: 'beta' })
    present(db, { session: 'here' })
    for (let n = 1; n <= 12; n++) {
      sendSessionMessage(db, { id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, session: 'gone', text: `Message ${n}` })
      advanceClock()
    }
    markMessageDelivered(db, '00000000-0000-4000-8000-000000000012', 'gone', 'copilot')
    endActivity(db, 'gone')
    const writes: string[] = []
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => { writes.push(text) } }, configurable: true })
    const bridge = await bootApp(db)
    openDrawer()
    const fold = () => drawer().querySelector<HTMLDetailsElement>('.msg-undelivered')
    expect(fold()?.querySelector('summary')?.textContent).toBe('Not delivered (12)')
    expect(fold()?.parentElement?.lastElementChild).toBe(fold())
    const lines = [...fold()!.querySelectorAll(':scope > .msg-item')]
    expect(lines).toHaveLength(10)
    expect(lines.map((el) => el.querySelector('.msg-text')?.textContent).slice(0, 2)).toEqual(['Message 12', 'Message 11'])
    expect(lines[0]?.querySelector('.msg-state')?.textContent).toMatch(/^Picked up, but the session ended before acknowledging/)
    expect(lines[1]?.querySelector('.msg-state')?.textContent).toMatch(/^Not delivered: this session is no longer running/)
    expect(lines[0]?.querySelector('.msg-lost-who')?.textContent).toBe('Message to copilot · beta · main')
    expect(fold()?.querySelector('.msg-earlier > summary')?.textContent).toBe('+2 more')
    // nothing in the Live strip names it
    expect(document.getElementById('liveStrip')?.textContent ?? '').not.toContain('Not delivered')

    click(lines[1]!.querySelector('[data-msg-copy]'))
    await settle()
    expect(writes).toEqual(['Message 11'])
    click(fold()!.querySelector(':scope > .msg-item [data-msg-withdraw]'))
    await settle()
    expect(messagePosts(bridge).map((p) => p.url)).toEqual(['/api/messages/00000000-0000-4000-8000-000000000012/withdraw'])
    expect(fold()?.querySelector('summary')?.textContent).toBe('Not delivered (11)')
    // the clock alone never changes it
    advanceClock(40 * 24 * 60 * 60_000)
    await pollTick()
    expect(fold()?.querySelector('summary')?.textContent).toBe('Not delivered (11)')
  })
  it('shows a message at once when a session outside the project lens ends (#420 review)', async () => {
    db = freshDb()
    present(db, { session: 'mcp-a', project: 'alpha' })
    present(db, { session: 'mcp-b', project: 'beta' })
    sendSessionMessage(db, { id: '00000000-0000-4000-8000-000000000001', session: 'mcp-b', text: 'Lost in beta' })
    await bootApp(db)
    click(document.querySelector('#rail button.rail-tab[data-project="alpha"]'))
    await settle()
    openDrawer()
    expect(drawer().querySelector('.msg-undelivered')).toBeNull()
    endActivity(db, 'mcp-b')
    await pollTick()
    expect(drawer().querySelector('.msg-undelivered summary')?.textContent).toBe('Not delivered (1)')
  })
})

describe('durable message drafts (#411, #279)', () => {
  it('keeps both texts when a session drops out of Live and comes back (#420 review)', async () => {
    db = freshDb()
    present(db, { session: 'mcp-a' })
    await bootApp(db)
    type(await openComposer('mcp-a'), 'Written before it went quiet')
    input('mcp-a')!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await settle()
    // silent past the presence window: Live drops it, and the draft waits in the unsent responses
    advanceClock(16 * 60_000)
    await pollTick()
    await vi.advanceTimersByTimeAsync(300)
    expect(Object.keys(stored())).toEqual(['message-recovery:mcp-a'])
    await showInbox()
    expect(document.querySelector('.stale-draft-line[data-recovery-line="message:mcp-a"]')?.textContent)
      .toContain('Not sent: this session is no longer running · Message: Written before it went quiet')
    // it heartbeats again: the text goes back to its composer, and nothing is lost when it is edited
    present(db, { session: 'mcp-a' })
    await pollTick()
    await vi.advanceTimersByTimeAsync(300)
    expect(document.querySelector('.stale-draft-line[data-recovery-line="message:mcp-a"]')).toBeNull()
    expect(stored()['message:mcp-a']?.draft).toMatchObject({ text: 'Written before it went quiet', reason: '' })
    expect(stored()['message-recovery:mcp-a']).toBeUndefined()
    const box = await openComposer('mcp-a')
    expect(box.value).toBe('Written before it went quiet')
    type(box, 'Written before it went quiet, and more')
    await vi.advanceTimersByTimeAsync(300)
    expect(Object.values(stored()).map((entry) => entry.draft['text'])).toEqual(['Written before it went quiet, and more'])
  })

  describe('never returns waiting text into a composer the human is typing in (#420 review)', () => {
    const seedBoth = () => {
      const entry = (text: string, reason: string) => ({ savedAt: Date.now(), draft: {
        type: 'message', session: 'mcp-a', project: 'alpha', agent: 'copilot', stream: 'main', text, intent: null, reason,
      } })
      localStorage.setItem(KEY, JSON.stringify({ v: 1, entries: {
        'message-recovery:mcp-a': entry('First words', 'Not sent: this session is no longer running'),
        'message:mcp-a': entry('Second words', ''),
      } }))
    }
    const storedTexts = () => Object.fromEntries(Object.entries(stored()).map(([key, value]) => [key, value.draft['text']]))
    const waiting = () => document.querySelector('#needsYouList .stale-draft-line[data-recovery-line="message:mcp-a"]')

    it('in the focus panel, after a send that leaves focus in its textarea', async () => {
      db = freshDb()
      present(db, { session: 'mcp-a' })
      seedBoth()
      const bridge = await bootApp(db)
      click(document.querySelector('#dashboard .dash-lane[data-lane="mcp-a"] .dash-lane-open'))
      await settle()
      const box = input('mcp-a', document.querySelector('#dashboard .dash-focus')!)!
      expect(box.value).toBe('Second words')
      box.focus()
      box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }))
      await settle()
      await pollTick()
      expect(messagePosts(bridge).map((p) => p.body['text'])).toEqual(['Second words'])
      expect([box.value, document.activeElement === box]).toEqual(['', true])
      type(box, 'Hi')
      await vi.advanceTimersByTimeAsync(300)
      expect(storedTexts()).toEqual({ 'message-recovery:mcp-a': 'First words', 'message:mcp-a': 'Hi' })
      await showInbox()
      expect(waiting()?.textContent).toContain('First words')
    })

    it('in a drawer composer on a passive tick', async () => {
      db = freshDb()
      present(db, { session: 'mcp-a' })
      seedBoth()
      await bootApp(db)
      const box = await openComposer('mcp-a')
      expect([box.value, document.activeElement === box]).toEqual(['Second words', true])
      type(box, '')
      await changedPollTick(db)
      expect([box.value, document.activeElement === box]).toEqual(['', true])
      type(box, 'Hi')
      await vi.advanceTimersByTimeAsync(300)
      expect(storedTexts()).toEqual({ 'message-recovery:mcp-a': 'First words', 'message:mcp-a': 'Hi' })
    })
  })

  it('stores a draft and a waiting unsent message to one session under their own keys', async () => {
    db = freshDb()
    present(db, { session: 'mcp-a' })
    const entry = (text: string, reason: string) => ({ savedAt: Date.now(), draft: {
      type: 'message', session: 'mcp-a', project: 'alpha', agent: 'copilot', stream: 'main', text, intent: null, reason,
    } })
    localStorage.setItem(KEY, JSON.stringify({ v: 1, entries: {
      'message-recovery:mcp-a': entry('The older one', 'Not sent: this session is no longer running'),
      'message:mcp-a': entry('The newer one', ''),
    } }))
    await bootApp(db)
    openDrawer()
    click(messageButton('mcp-a'))
    await settle()
    expect(input('mcp-a')?.value).toBe('The newer one')
    await showInbox()
    expect(document.querySelector('.stale-draft-line[data-recovery-line="message:mcp-a"]')?.textContent).toContain('The older one')
    type(input('mcp-a'), 'The newer one, edited')
    await vi.advanceTimersByTimeAsync(300)
    expect(Object.fromEntries(Object.entries(stored()).map(([key, value]) => [key, value.draft['text']]))).toEqual({
      'message-recovery:mcp-a': 'The older one', 'message:mcp-a': 'The newer one, edited',
    })
  })

  it('brings a draft back into its composer after a reload, opening and focusing nothing', async () => {
    db = freshDb()
    present(db, { session: 'mcp-a' })
    await bootApp(db)
    type(await openComposer('mcp-a'), 'Remember me')
    await vi.advanceTimersByTimeAsync(300)
    expect(stored()['message:mcp-a']?.draft).toMatchObject({ text: 'Remember me', project: 'alpha', agent: 'copilot' })
    await reopen(db)
    expect(drawer().hidden).toBe(true)
    expect(document.querySelector('.msg-composer')).toBeNull()
    openDrawer()
    click(messageButton('mcp-a'))
    await settle()
    expect(input('mcp-a')?.value).toBe('Remember me')
  })

  it('retries an unconfirmed send with the same id, and retires the draft once the snapshot holds it', async () => {
    db = freshDb()
    present(db, { session: 'mcp-a' })
    expectConsoleError(/POST \/api\/sessions\/mcp-a\/messages failed/)
    let lose = true
    const bridge = await bootApp(db, {
      // the first send lands, but its answer never arrives
      interceptFetch: async (input, init, next) => {
        if (init?.method === 'POST' && lose) {
          lose = false
          await next()
          return new Response('gone', { status: 502 })
        }
        return next()
      },
    })
    const box = await openComposer('mcp-a')
    type(box, 'Only once, please')
    click(composer('mcp-a')!.querySelector('.msg-send'))
    await settle()
    // the reload after the send already shows it landed, so the draft retires as sent
    expect(input('mcp-a')?.value).toBe('')
    expect(historyLines('mcp-a')).toEqual([['Only once, please', 'Sent moments ago · not picked up yet']])
    expect(listSessionMessages(db).open).toHaveLength(1)
    expect(messagePosts(bridge)).toHaveLength(1)
  })

  it('keeps an unconfirmed send’s id across a reload, and its Retry replays exactly', async () => {
    db = freshDb()
    present(db, { session: 'mcp-a' })
    expectConsoleError(/POST \/api\/sessions\/mcp-a\/messages failed/)
    const first = await bootApp(db, {
      interceptFetch: async (input, init, next) => (init?.method === 'POST' ? new Response('down', { status: 503 }) : next()),
    })
    type(await openComposer('mcp-a'), 'Exactly once')
    click(composer('mcp-a')!.querySelector('.msg-send'))
    await settle()
    expect(composer('mcp-a')!.querySelector('[role="status"]')?.textContent).toBe('Your send was not confirmed. Send again: it will not send twice.')
    const [lost] = messagePosts(first)
    await reopen(db)
    openDrawer()
    click(messageButton('mcp-a'))
    await settle()
    expect(input('mcp-a')?.value).toBe('Exactly once')
    expect(composer('mcp-a')!.querySelector('[role="status"]')?.textContent).toBe('Your send was not confirmed. Send again: it will not send twice.')
    // the page that sent it died; this one retries with the same id
    const retried: Array<Record<string, unknown>> = []
    const realFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      if (init?.method === 'POST') retried.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      return realFetch(input, init)
    }
    click(composer('mcp-a')!.querySelector('.msg-send'))
    await settle()
    expect(retried).toEqual([lost!.body])
    expect(listSessionMessages(db).open.map((m) => m.text)).toEqual(['Exactly once'])
  })

  it('puts a draft for a session that ended into the unsent responses, whose Retry reuses its id', async () => {
    db = freshDb()
    present(db, { session: 'mcp-a' })
    const sent = '00000000-0000-4000-8000-0000000000aa'
    localStorage.setItem(KEY, JSON.stringify({ v: 1, entries: {
      'message:mcp-a': { savedAt: Date.now(), draft: { type: 'message', session: 'mcp-a', project: 'alpha', agent: 'copilot', stream: 'main', text: 'Did it land?', intent: { id: sent, text: 'Did it land?' }, reason: '' } },
      'message:mcp-old': { savedAt: Date.now(), draft: { type: 'message', session: 'mcp-old', project: 'alpha', agent: 'claude-code', stream: '', text: 'Too late', intent: null, reason: '' } },
    } }))
    sendSessionMessage(db, { id: sent, session: 'mcp-a', text: 'Did it land?' })
    endActivity(db, 'mcp-a')
    const bridge = await bootApp(db)
    await showInbox()
    const lines = [...document.querySelectorAll<HTMLElement>('#needsYouList .stale-drafts-fold .stale-draft-line')]
    expect(lines.map((el) => el.dataset.recoveryLine)).toEqual(['message:mcp-old'])
    expect(lines[0]?.textContent).toContain('Message to claude-code · alpha · Not sent: this session is no longer running · Message: Too late')
    // the one the snapshot holds went through: it is not unsent at all
    await vi.advanceTimersByTimeAsync(300)
    expect(stored()['message:mcp-a']).toBeUndefined()
    click([...lines[0]!.querySelectorAll('button')].find((b) => b.textContent === 'Retry'))
    await settle()
    expect(messagePosts(bridge).map((p) => p.body)).toEqual([{ id: expect.stringMatching(UUID), text: 'Too late' }])
    expect(document.querySelector('.stale-draft-line[data-recovery-line="message:mcp-old"]')?.textContent)
      .toContain('Not sent: this session is no longer running')
  })
})

describe('an older viewer and attention parity (#411)', () => {
  it('reads a 404 for /api/messages as no messages, never a failed tick', async () => {
    db = freshDb()
    present(db, { session: 'mcp-a' })
    sendSessionMessage(db, { id: '00000000-0000-4000-8000-000000000001', session: 'mcp-a', text: 'Hidden' })
    insertItem(db, { project: 'alpha', stream: 'main', agent: 'copilot', kind: 'question', title: 'Still here?' })
    await bootApp(db, {
      interceptFetch: async (input, _init, next) => (route(input) === '/api/messages' ? new Response('<!doctype html>', { status: 404 }) : next()),
    })
    await openComposer('mcp-a')
    expect(historyLines('mcp-a')).toEqual([])
    expect(document.getElementById('status')?.textContent).toBe('')
    expect(badgeCount()).toBe(1)
  })

  it('leaves the badge, title, tab counts, rail, Now strip, Inbox and the dock projections identical', async () => {
    db = freshDb()
    present(db, { session: 'mcp-a' })
    present(db, { session: 'gone' })
    insertItem(db, { project: 'alpha', stream: 'main', agent: 'copilot', kind: 'question', title: 'Which width?' })
    upsertBoard(db, {
      project: 'alpha', stream: 'main', agent: 'copilot', title: 'Plan',
      rows: [{ label: 'Approve', status: 'blocked', note: 'Drafted.', next_step: 'Approve it.', action_owner: 'approval', impact: 'Ships.', options: [{ label: 'Yes' }, { label: 'No' }] }],
    })
    const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`
    sendSessionMessage(db, { id: id(1), session: 'mcp-a', text: 'Sent' })
    sendSessionMessage(db, { id: id(2), session: 'mcp-a', text: 'Picked up' })
    markMessageDelivered(db, id(2), 'mcp-a', 'copilot')
    sendSessionMessage(db, { id: id(3), session: 'mcp-a', text: 'Acked' })
    ackMessage(db, { id: id(3), session: 'mcp-a', outcome: 'Done.' })
    sendSessionMessage(db, { id: id(4), session: 'gone', text: 'Undelivered' })
    endActivity(db, 'gone')
    let messages = false
    const bridge = await bootApp(db, {
      interceptFetch: async (input, _init, next) =>
        (!messages && route(input) === '/api/messages' ? new Response('<!doctype html>', { status: 404 }) : next()),
    })
    const surfaces = async () => {
      const items = await fetch('/api/items?scope=attention')
      const boards = await fetch('/api/boards?scope=attention')
      const dashboard = {
        rail: [...document.querySelectorAll('#dashRail [data-rail-card]')].map((el) => el.textContent),
        now: document.querySelector('#dashboard .dash-now')?.textContent,
        lanes: [...document.querySelectorAll('#dashboard .dash-lane')].map((el) => el.textContent),
      }
      const view = {
        title: document.title, badge: badgeCount(), tabs: ['needsYou', 'notes', 'boards', 'done'].map(tabCount), ...dashboard,
        dock: [items.headers.get('etag'), await items.text(), boards.headers.get('etag'), await boards.text()],
      }
      await showInbox()
      const inbox = rows().map((el) => el.querySelector('.nrow-title')?.textContent)
      click(document.querySelector('.tab[data-tab="dashboard"]'))
      await settle()
      return { ...view, inbox }
    }
    const before = await surfaces()
    expect(before.badge).toBe(2)
    messages = true
    await pollTick()
    openDrawer()
    click(messageButton('mcp-a'))
    await settle()
    expect(drawer().querySelector('.msg-undelivered summary')?.textContent).toBe('Not delivered (1)')
    expect(historyLines('mcp-a')).toHaveLength(3)
    type(input('mcp-a'), 'A draft')
    expect(await surfaces()).toEqual(before)
    // sending, delivery and an acknowledgement announce nothing either
    openDrawer()
    click(composer('mcp-a')!.querySelector('.msg-send'))
    await settle()
    const sent = String(messagePosts(bridge)[0]!.body['id'])
    markMessageDelivered(db, sent, 'mcp-a', 'copilot')
    ackMessage(db, { id: sent, session: 'mcp-a', outcome: 'On it.' })
    await pollTick()
    expect(await surfaces()).toEqual(before)
  })
})

describe('a viewer restart with message drafts (#420 review)', () => {
  let reload: ReturnType<typeof vi.fn>
  beforeEach(() => {
    reload = vi.fn()
    vi.stubGlobal('location', { hash: '', reload })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  async function bootWithRestart(d: Database.Database) {
    let boot = 'original-viewer'
    await bootApp(d, {
      interceptFetch: async (_input, _init, next) => {
        const response = await next()
        response.headers.set('x-inbox-boot', boot)
        return response
      },
    })
    return () => { boot = 'restarted-viewer' }
  }

  it('waits only while a composer is in use, never for a stored draft in a closed one', async () => {
    db = freshDb()
    present(db, { session: 'mcp-a' })
    const restart = await bootWithRestart(db)
    const box = await openComposer('mcp-a')
    type(box, 'Kept across the reload')
    restart()
    await pollTick()
    expect(reload).not.toHaveBeenCalled()
    expect(document.getElementById('pauseHint')?.textContent).toBe('Viewer updated — finish or clear unsent responses to refresh.')
    box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await settle()
    expect(messageButton('mcp-a')?.textContent).toBe('Message · draft')
    await pollTick()
    expect(reload).toHaveBeenCalledTimes(1)
    // the reload loses nothing: the draft was stored
    expect(stored()['message:mcp-a']?.draft).toMatchObject({ text: 'Kept across the reload' })
  })
})
