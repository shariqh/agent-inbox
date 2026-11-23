// @vitest-environment jsdom
// Continue here… in the Chats tab (#586 phase 2, PR 6; design §3.5). The control, its dialog, Show
// session, "· here" and Copy resume's off state exist only in the window main grants launches, with
// the driven-sessions switch on; here a fake window.agentInboxLaunch stands in for main. The real
// routes run over a fake chat index and a real hub. Every fixture is synthetic, and nothing starts.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type Database from 'better-sqlite3'
import { createLaunch, endLaunch, parkLaunch, upsertActivity } from '../../src/store.js'
import type { ChatEntry, ChatIndex } from '../../src/chat-index.js'
import { bootApp, buttonLabelled, changedPollTick, click, freshDb, pollTick, settle, T0, type, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(async () => {
  control.failLaunches = false
  for (const dialog of document.querySelectorAll('dialog')) dialog.remove()
  await vi.advanceTimersByTimeAsync(300)
  db?.close()
  db = null
  Reflect.deleteProperty(window, 'agentInboxLaunch')
  Reflect.deleteProperty(window, 'agentInboxChats')
  Reflect.deleteProperty(navigator, 'clipboard')
})

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const LAUNCH = '11111111-2222-4333-8444-555555555555'
const ago = (minutes: number) => new Date(T0 - minutes * 60_000).toISOString()

function entry(n: number, over: Partial<ChatEntry> = {}): ChatEntry {
  return {
    id: uuid(n), tool: 'copilot', title: `Chat ${n}`, titleAuto: false, project: 'alpha',
    cwd: '/Users/tester/dev/alpha', branch: 'main', createdAt: ago(600), lastActiveAt: ago(n * 60),
    live: false, pr: null, hidden: [], ...over,
  }
}

// the list the phase 1 capture (test/fixtures/chats-phase1/) was drawn from: keep the two in step
function phase1Chats(): ChatEntry[] {
  return [
    entry(1, { title: 'Fix the parser' }),
    entry(2, { title: 'Live one', live: true }),
    entry(3, { tool: 'claude', title: 'A Claude chat' }),
    entry(4, { title: 'Said nothing', hidden: ['empty'] }),
  ]
}

function fixture(): ChatEntry[] {
  return [
    ...phase1Chats(),
    entry(5, { title: 'Gone', cwd: '/Users/tester/gone', hidden: ['folder-gone'] }),
    entry(6, { title: 'A one-shot', hidden: ['non-interactive'] }),
    entry(7, { title: 'Nowhere', cwd: null, hidden: ['folder-gone'] }),
  ]
}

// the page's start-progress listener, as main would call it (#432 PR 5)
let progress: ((phase: string, launch?: string, startId?: string) => void) | null = null

type State = { owned: boolean; enabled: boolean; available: boolean; canEnable: boolean }
function launchBridge(state: Partial<State> = {}) {
  const current: State = { owned: true, enabled: true, available: true, canEnable: true, ...state }
  const api = {
    current,
    available: vi.fn(async () => ({ ...current })),
    setEnabled: vi.fn(async (enabled: boolean) => ({ ok: true, enabled })),
    start: vi.fn(async (_request: unknown) => ({ ok: false, error: 'not in this test' })),
    stop: vi.fn(async (_id: string) => ({ ok: true, status: 'stopping' })),
    continueChat: vi.fn(async (_request: unknown): Promise<Record<string, unknown>> => ({ ok: false, cancelled: true, error: 'Not continued.' })),
    onStartProgress: vi.fn((listener: typeof progress) => { progress = listener; return true }),
  }
  Object.defineProperty(window, 'agentInboxLaunch', { configurable: true, value: api })
  return api
}

function chatsBridge() {
  const bridge = {
    resumeAvailable: vi.fn(async () => ({ available: true, terminal: 'terminal' })),
    resume: vi.fn(async () => ({ ok: true, terminal: 'terminal' })),
  }
  Object.defineProperty(window, 'agentInboxChats', { configurable: true, value: bridge })
  return bridge
}

function chatLaunch(d: Database.Database, n: number, id = LAUNCH): void {
  createLaunch(d, {
    id, host: 'copilot', project: 'alpha', stream: 'main', cwd: '/Users/tester/dev/alpha', mode: 'ask',
    budgetActiveMs: null, budgetToolCalls: null, prompt: 'Go on.', specVersion: 1, driverPid: 4242, chatId: uuid(n),
  })
}

// `tick`: one poll after the boot, which reads the launches once main has said the switch is on
// `failLaunches`: while true, every /api/launches read answers 500
const control = { failLaunches: false }
async function boot(chats = fixture(), setup: (d: Database.Database) => void = () => {}, { tick = true } = {}) {
  db = freshDb()
  setup(db)
  const index = { chats }
  const chatIndex: ChatIndex = {
    read: () => ({ chats: index.chats, truncated: false, work: { filesRead: 0, bytesRead: 0 } }),
    readCopilot: () => null,
    claudeDays: () => 30,
  }
  const reads: string[] = []
  await bootApp(db, {
    viewer: { chatIndex },
    interceptFetch: async (input, _init, next) => {
      reads.push(String(input))
      if (control.failLaunches && String(input).startsWith('/api/launches')) return new Response('down', { status: 500 })
      return await next()
    },
  })
  if (tick) await pollTick()
  return { reads, index }
}

const panel = () => document.getElementById('chats') as HTMLElement
const q = <T extends Element = HTMLElement>(sel: string) => panel().querySelector<T>(sel)
const rowFor = (n: number, tool = 'copilot') => q(`tr[data-chat-key="${tool}:${uuid(n)}"]`)
const inRow = <T extends Element = HTMLButtonElement>(n: number, sel: string, tool = 'copilot') => rowFor(n, tool)?.querySelector<T>(sel) ?? null
const continueFor = (n: number) => inRow(n, '.chats-continue')
const noteFor = (n: number) => inRow<HTMLElement>(n, '.chats-resume-note')
const actionsOf = (n: number, tool = 'copilot') => [...rowFor(n, tool)!.querySelector('.chats-actions')!.children].map((el) => el.className)
const dialog = () => document.querySelector<HTMLDialogElement>('dialog.launch-continue')
const message = () => dialog()!.querySelector('.launch-dialog-message')!.textContent
const promptBox = () => dialog()!.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]')!
const startButton = () => buttonLabelled('Continue', dialog()!)!
const submit = () => dialog()!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
const focusPanel = () => document.querySelector<HTMLElement>('#dashboard .dash-focus')!
const startTag = (api: ReturnType<typeof launchBridge>) => (api.continueChat.mock.calls.at(-1)![0] as { startId: string }).startId

async function openChats(all = true) {
  click(document.querySelector('.tab[data-tab="chats"]'))
  await settle()
  await settle()
  if (all && !q<HTMLInputElement>('.chats-all input')!.checked) {
    click(q('.chats-all input'))
    await settle()
    await settle()
  }
}

async function leaveAndReturn() {
  click(document.querySelector('.tab[data-tab="find"]'))
  await settle()
  click(document.querySelector('.tab[data-tab="chats"]'))
  await settle()
  await settle()
}

// opens the dialog on chat n and types its message
async function openDialog(n = 1, text = 'Carry on with the parser.') {
  click(continueFor(n))
  await settle()
  if (text) type(promptBox(), text)
}

describe('Continue here… is drawn only with the grant (§3.5)', () => {
  it.each([
    ['in a browser', null],
    ['with the switch off', { enabled: false, available: false }],
    ['in a window main does not own', { owned: false, available: false }],
    ['in a window without the launch grant', { available: false }],
  ])('%s, no row gets it, Show session or "· here"', async (_name, state) => {
    if (state) launchBridge(state)
    await boot(fixture(), (d) => chatLaunch(d, 1))
    await openChats()
    expect(panel().querySelectorAll('.chats-continue, .chats-show, .chats-here')).toHaveLength(0)
    expect(actionsOf(1)).toEqual(['chats-copy'])
  })

  it('with it, a Copilot row gets Continue here… after Resume and Copy resume, and a Claude row none', async () => {
    launchBridge()
    chatsBridge()
    await boot()
    await openChats()
    expect(actionsOf(1)).toEqual(['chats-resume', 'chats-copy', 'chats-continue', 'chats-resume-note'])
    expect(actionsOf(3, 'claude')).toEqual(['chats-resume', 'chats-copy', 'chats-resume-note'])
    const control = continueFor(1)!
    expect([control.textContent, control.title, control.type, control.getAttribute('aria-haspopup'), control.hasAttribute('aria-disabled')])
      .toEqual(['Continue here…', 'Continue this chat in Agent Inbox, as a session it drives', 'button', 'dialog', false])
  })

  it('without Resume in Terminal it still has the row’s note for main’s answer', async () => {
    launchBridge()
    await boot()
    await openChats()
    expect(actionsOf(1)).toEqual(['chats-copy', 'chats-continue', 'chats-resume-note'])
    expect(noteFor(1)!.getAttribute('role')).toBe('status')
  })

  it('is asked again on every entry into the tab', async () => {
    const api = launchBridge()
    await boot()
    await openChats()
    expect(continueFor(1)).not.toBeNull()
    const before = api.available.mock.calls.length
    Object.assign(api.current, { enabled: false, available: false })
    await leaveAndReturn()
    expect(api.available.mock.calls.length).toBeGreaterThan(before)
    expect(panel().querySelectorAll('.chats-continue, .chats-resume-note')).toHaveLength(0)
    Object.assign(api.current, { enabled: true, available: true })
    await leaveAndReturn()
    expect(continueFor(1)).not.toBeNull()
  })

  it.each([
    [2, 'This chat is live in another process, so it is not continued a second time.'],
    [5, 'Its folder no longer exists.'],
    [7, 'Its folder no longer exists.'],
    [4, 'Nothing was ever said in this chat.'],
    [6, 'This was not an interactive chat.'],
  ])('is off for chat %i, with its reason as the title, and opens nothing', async (n, title) => {
    const api = launchBridge()
    await boot()
    await openChats()
    const control = continueFor(n)!
    expect([control.getAttribute('aria-disabled'), control.title]).toEqual(['true', title])
    click(control)
    await settle()
    expect(dialog()).toBeNull()
    expect(api.continueChat).not.toHaveBeenCalled()
  })
})

describe('the dialog (§3.5)', () => {
  it('shows the chat, the two modes and a required message, and focuses the message', async () => {
    launchBridge()
    await boot()
    await openChats()
    await openDialog(1, '')
    const box = dialog()!
    expect(box.querySelector('h2')!.textContent).toBe('Continue in Agent Inbox')
    expect(box.getAttribute('aria-labelledby')).toBe(box.querySelector('h2')!.id)
    expect([...box.querySelectorAll('.launch-chat-facts dd')].map((dd) => dd.textContent)).toEqual(['Fix the parser', '/Users/tester/dev/alpha'])
    const modes = [...box.querySelectorAll<HTMLInputElement>('input[name="mode"]')]
    expect(modes.map((m) => [m.value, m.checked, m.closest('label')!.querySelector('strong')!.textContent])).toEqual([
      ['ask', true, 'Ask for everything'], ['read-only', false, 'Read-only'],
    ])
    expect(box.querySelector('fieldset legend')!.textContent).toBe('Mode')
    expect(promptBox().closest('label')!.textContent).toContain('Message')
    expect(promptBox().closest('label')!.textContent).toContain('Don’t paste secrets here: the message is stored with the session.')
    expect(promptBox().required).toBe(true)
    expect(document.activeElement).toBe(promptBox())
    // off until there is a message
    expect(startButton().disabled).toBe(true)
    type(promptBox(), '   ')
    expect(startButton().disabled).toBe(true)
    type(promptBox(), 'Go on.')
    expect(startButton().disabled).toBe(false)
  })

  it('sends main exactly the tool, the id, the mode, the message and its start tag', async () => {
    const api = launchBridge()
    await boot()
    await openChats()
    await openDialog(1, 'Carry on with the parser.')
    dialog()!.querySelector<HTMLInputElement>('input[value="read-only"]')!.checked = true
    submit()
    await settle()
    expect(api.continueChat).toHaveBeenCalledTimes(1)
    const request = api.continueChat.mock.calls[0]![0] as Record<string, unknown>
    expect(Object.keys(request).sort()).toEqual(['id', 'mode', 'prompt', 'startId', 'tool'])
    expect(request).toEqual({
      tool: 'copilot', id: uuid(1), mode: 'read-only', prompt: 'Carry on with the parser.', startId: expect.stringMatching(/^[0-9a-f]{32}$/),
    })
    expect(api.start).not.toHaveBeenCalled()
  })

  it('stays open after Continue, saying each phase main reports for its own start only', async () => {
    const api = launchBridge()
    let finish!: (result: Record<string, unknown>) => void
    api.continueChat.mockImplementationOnce(() => new Promise((done) => { finish = done }))
    await boot()
    await openChats()
    await openDialog()
    submit()
    await settle()
    expect(message()).toBe('Agent Inbox is asking you to confirm…')
    expect(startButton().disabled).toBe(true)
    expect(buttonLabelled('Stop starting', dialog()!)).not.toBeNull()
    // another start's phase never binds this dialog
    progress!('runtime', LAUNCH, 'a'.repeat(32))
    expect(message()).toBe('Agent Inbox is asking you to confirm…')
    for (const [phase, text] of [['environment', 'Reading your shell environment…'], ['runtime', 'Checking the runtime…'], ['copilot', 'Starting Copilot…']]) {
      progress!(phase!, LAUNCH, startTag(api))
      expect(message()).toBe(text)
    }
    // Escape does nothing while it starts
    dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(dialog()).not.toBeNull()
    finish({ ok: false, reason: 'outdated', error: 'This Agent Inbox runtime is older than the app. Update agents in Setup.' })
    await settle()
    expect(api.onStartProgress).toHaveBeenLastCalledWith(null)
    expect(message()).toBe('This Agent Inbox runtime is older than the app. Update agents in Setup.')
    expect([startButton().disabled, buttonLabelled('Cancel', dialog()!)!.disabled]).toEqual([false, false])
  })

  it.each([
    ['busy', 'This chat is already starting.', false],
    ['index', 'Agent Inbox could not read the chat list.', false],
    ['missing', 'This chat is no longer listed.', true],
    ['driven', 'This chat already has a session here: use Show session.', true],
    ['live', 'This chat is live in another process.', true],
    ['kind', 'Only interactive chats with something said can be continued here.', false],
    ['folder', 'Its folder no longer exists.', true],
    ['worktree', 'This chat’s folder is a worktree of another session here. Continue that session instead.', false],
    ['copilot_home', 'Your shell sets COPILOT_HOME to another folder, so Copilot would not find this chat.', false],
    ['outdated', 'This Agent Inbox runtime is older than the app. Update agents in Setup.', false],
    [undefined, 'Driven sessions are off. Turn them on in Settings.', false],
  ])('shows a %s refusal’s text in the dialog and the row’s note, reading the list again only where the row may be off', async (reason, error, refresh) => {
    const api = launchBridge()
    api.continueChat.mockResolvedValueOnce(reason ? { ok: false, reason, error } : { ok: false, error })
    const { reads } = await boot()
    await openChats()
    await openDialog()
    const before = reads.filter((u) => u.startsWith('/api/chats')).length
    submit()
    await settle()
    await settle()
    expect(message()).toBe(error)
    expect(noteFor(1)!.textContent).toBe(error)
    expect(reads.filter((u) => u.startsWith('/api/chats')).length - before).toBe(refresh ? 1 : 0)
    expect(promptBox().value).toBe('Carry on with the parser.')
    // the note stays once the dialog closes, until the next press
    click(buttonLabelled('Cancel', dialog()!))
    await settle()
    expect(noteFor(1)!.textContent).toBe(error)
    click(continueFor(1))
    await settle()
    expect(noteFor(1)!.textContent).toBe('')
  })

  it('a refusal puts focus on the message, not on the body', async () => {
    const api = launchBridge()
    api.continueChat.mockResolvedValueOnce({ ok: false, reason: 'live', error: 'This chat is live in another process.' })
    await boot()
    await openChats()
    await openDialog()
    startButton().focus()
    submit()
    await settle()
    await settle()
    expect(message()).toBe('This chat is live in another process.')
    expect(document.activeElement).toBe(promptBox())
  })

  it('a cancelled confirmation returns to the dialog with the message kept, saying nothing', async () => {
    const api = launchBridge()
    api.continueChat.mockResolvedValueOnce({ ok: false, cancelled: true, error: 'Not continued.' })
    await boot()
    await openChats()
    await openDialog()
    submit()
    await settle()
    expect(dialog()).not.toBeNull()
    expect([message(), promptBox().value, startButton().disabled, noteFor(1)!.textContent]).toEqual(['', 'Carry on with the parser.', false, ''])
    expect(document.activeElement).toBe(promptBox())
  })

  it('the typed message pauses the list while the dialog is open, and is kept for the next one after Cancel', async () => {
    launchBridge()
    await boot()
    await openChats()
    await openDialog(1, 'Half a thought')
    // a draft while the dialog is open, as New session's task is: a tick with new data waits for it
    await changedPollTick(db!)
    expect(document.getElementById('pauseHint')?.textContent ?? '').toMatch(/paused/)
    click(buttonLabelled('Cancel', dialog()!))
    await settle()
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(continueFor(1))
    click(continueFor(1))
    await settle()
    expect(promptBox().value).toBe('Half a thought')
  })

  it('Escape closes it and gives focus back to the control', async () => {
    launchBridge()
    await boot()
    await openChats()
    await openDialog()
    promptBox().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await settle()
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(continueFor(1))
  })

  it('once started, it closes and shows the session; the row then offers Show session', async () => {
    const api = launchBridge()
    api.continueChat.mockImplementationOnce(async () => {
      chatLaunch(db!, 1)
      return { ok: true, launch: LAUNCH }
    })
    await boot()
    await openChats()
    await openDialog()
    submit()
    await settle()
    await settle()
    expect(dialog()).toBeNull()
    expect(document.querySelector('.tab[data-tab="dashboard"]')!.getAttribute('aria-selected')).toBe('true')
    expect(focusPanel().hidden).toBe(false)
    expect(focusPanel().dataset.session).toBe(`launch:${LAUNCH}`)
    // the session panel's line, linked to the Chats tab
    const line = focusPanel().querySelector<HTMLElement>('.sp-chat')!
    expect([line.hidden, line.textContent]).toEqual([false, 'Continued from a Copilot chat (00000000)'])
    expect(line.querySelector('a')!.getAttribute('href')).toBe('#chats')
    click(line.querySelector('a'))
    await settle()
    await settle()
    expect(document.querySelector('.tab[data-tab="chats"]')!.getAttribute('aria-selected')).toBe('true')
    expect(continueFor(1)).toBeNull()
    expect(inRow(1, '.chats-show')).not.toBeNull()
  })

  it('keeps the chat’s text and main’s text as text', async () => {
    const api = launchBridge()
    const hostile = '<img src=x onerror="globalThis.pwned=1">'
    api.continueChat.mockResolvedValueOnce({ ok: false, reason: 'kind', error: `<b>${hostile}</b>` })
    await boot([entry(1, { title: hostile, cwd: '/Users/tester/<script>x</script>' })])
    await openChats()
    await openDialog()
    expect([...dialog()!.querySelectorAll('.launch-chat-facts dd')].map((dd) => dd.textContent)).toEqual([hostile, '/Users/tester/<script>x</script>'])
    submit()
    await settle()
    expect(message()).toBe(`<b>${hostile}</b>`)
    expect(noteFor(1)!.textContent).toBe(`<b>${hostile}</b>`)
    expect(document.querySelectorAll('dialog img, dialog b, dialog script, #chats img, #chats b, #chats script')).toHaveLength(0)
    expect((globalThis as { pwned?: number }).pwned).toBeUndefined()
  })
})

describe('a chat driven here (§3.5, §3.6)', () => {
  it('a running launch: Live · here, Show session opens launch:<id>, and Resume and Copy resume are off', async () => {
    launchBridge()
    const resume = chatsBridge()
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await boot(fixture(), (d) => chatLaunch(d, 1))
    await openChats()
    expect(actionsOf(1)).toEqual(['chats-resume', 'chats-copy', 'chats-show', 'chats-resume-note'])
    const live = rowFor(1)!.querySelector('td.chats-live')!
    expect([...live.children].map((el) => [el.className, el.textContent])).toEqual([['chip chats-live', 'Live'], ['chats-here', '· here']])
    const off = 'This chat has a session here: use Show session, then Take over.'
    const copy = inRow(1, '.chats-copy')!
    const resumeControl = inRow(1, '.chats-resume')!
    expect([copy.getAttribute('aria-disabled'), copy.title, resumeControl.getAttribute('aria-disabled'), resumeControl.title])
      .toEqual(['true', off, 'true', off])
    click(copy)
    click(resumeControl)
    await settle()
    expect(writeText).not.toHaveBeenCalled()
    expect(resume.resume).not.toHaveBeenCalled()
    // another chat's row is untouched
    expect(actionsOf(5)).toEqual(['chats-resume', 'chats-copy', 'chats-continue', 'chats-resume-note'])
    const show = inRow(1, '.chats-show')!
    expect([show.textContent, show.type, show.title]).toEqual(['Show session', 'button', 'Open the session Agent Inbox drives for this chat'])
    click(show)
    await settle()
    expect(document.querySelector('.tab[data-tab="dashboard"]')!.getAttribute('aria-selected')).toBe('true')
    expect(focusPanel().dataset.session).toBe(`launch:${LAUNCH}`)
  })

  it('a parked launch, or one stopped with its session: Show session without "· here"', async () => {
    launchBridge()
    await boot(fixture(), (d) => {
      chatLaunch(d, 1)
      parkLaunch(d, LAUNCH, { acpSession: uuid(1), activeMs: 0, toolCalls: 0 })
      chatLaunch(d, 5, '11111111-2222-4333-8444-666666666666')
      endLaunch(d, '11111111-2222-4333-8444-666666666666', { reason: 'stopped', acpSession: uuid(5) })
    })
    await openChats()
    for (const n of [1, 5]) {
      expect(inRow(n, '.chats-show')).not.toBeNull()
      expect(continueFor(n)).toBeNull()
      expect(rowFor(n)!.querySelector('.chats-here')).toBeNull()
    }
    // the folder-gone chat's Live cell stays empty: only a running launch is "here"
    expect(rowFor(5)!.querySelector('td.chats-live')!.children).toHaveLength(0)
  })

  it('an ended launch that cannot resume gives the row back its Continue here…', async () => {
    launchBridge()
    await boot(fixture(), (d) => {
      chatLaunch(d, 1)
      endLaunch(d, LAUNCH, { reason: 'error:load', detail: 'Copilot has no chat with this id.', forgetSession: true })
    })
    await openChats()
    expect(inRow(1, '.chats-show')).toBeNull()
    expect(continueFor(1)!.hasAttribute('aria-disabled')).toBe(false)
    expect(inRow(1, '.chats-copy')!.hasAttribute('aria-disabled')).toBe(false)
    expect(rowFor(1)!.querySelector('.chats-here')).toBeNull()
  })
})

describe('with the switch off, the tab draws and reads exactly what phase 1 did (§3.7, §6)', () => {
  const fixtureFile = (name: string) => readFileSync(resolve(process.cwd(), 'test/fixtures/chats-phase1', name), 'utf8')
  // the exact local time in Last active's title follows the machine's time zone
  const portable = (html: string) => html.replace(/(<td class="chats-active" title=")[^"]*(")/g, '$1…$2')

  it.each([
    ['in a browser', null, false],
    ['in a browser, with Resume in Terminal', null, true],
    ['in the app with the switch off', { enabled: false, available: false }, true],
    ['in a window main does not grant launches', { owned: false, available: false }, true],
  ])('%s', async (_name, state, withResume) => {
    if (state) launchBridge(state)
    if (withResume) chatsBridge()
    // a launch that would hold chat 1 with the switch on, so nothing is drawn only because nothing is read
    const { reads } = await boot(phase1Chats(), (d) => chatLaunch(d, 1), { tick: false })
    await openChats()
    expect(portable(document.querySelector('#chats .chats')!.innerHTML))
      .toBe(portable(fixtureFile(withResume ? 'with-resume.html' : 'browser.html')))
    expect(reads.filter((u) => !u.startsWith('/api/version'))).toEqual(JSON.parse(fixtureFile('reads.json')))
    expect(reads.filter((u) => u.includes('/api/launch'))).toEqual([])
    // and a later tick that paints the tab changes nothing either: no launch is read or drawn
    const before = reads.length
    await changedPollTick(db!)
    await settle()
    expect(portable(document.querySelector('#chats .chats')!.innerHTML))
      .toBe(portable(fixtureFile(withResume ? 'with-resume.html' : 'browser.html')))
    expect(reads.slice(before).filter((u) => u.includes('/api/launch') || u.startsWith('/api/chats'))).toEqual([])
  })
})

describe('the launch list behind Show session (review of PR 6)', () => {
  const checking = 'Checking for a session here…'
  const unread = 'Agent Inbox could not read its sessions, so Continue here… is not offered.'
  const offPair = (n: number, tool = 'copilot') => [inRow(n, '.chats-resume', tool)!, inRow(n, '.chats-copy', tool)!]
    .map((el) => [el.getAttribute('aria-disabled'), el.title])

  it('a failed read keeps the last list: Show session, Copy resume and Resume off, and focus where it was', async () => {
    launchBridge()
    chatsBridge()
    await boot(fixture(), (d) => chatLaunch(d, 1))
    await openChats()
    const off = 'This chat has a session here: use Show session, then Take over.'
    expect(offPair(1)).toEqual([['true', off], ['true', off]])
    inRow(1, '.chats-show')!.focus()
    const focused = document.activeElement
    control.failLaunches = true
    await changedPollTick(db!)
    await settle()
    expect(actionsOf(1)).toEqual(['chats-resume', 'chats-copy', 'chats-show', 'chats-resume-note'])
    expect(offPair(1)).toEqual([['true', off], ['true', off]])
    expect(document.activeElement).toBe(focused)
    expect((focused as HTMLElement).isConnected).toBe(true)
    // nothing is said: a list was read
    expect(q('.chats-sessions')).toBeNull()
  })

  it('before the first list, Copilot rows keep Copy resume and Resume off; Claude rows are untouched', async () => {
    launchBridge()
    chatsBridge()
    const { reads } = await boot(fixture(), () => {}, { tick: false })
    await openChats()
    expect(reads.filter((u) => u.startsWith('/api/launches'))).toEqual([])
    expect(offPair(1)).toEqual([['true', checking], ['true', checking]])
    expect(offPair(3, 'claude').map(([disabled]) => disabled)).toEqual([null, null])
    expect(continueFor(1)).toBeNull()
    // nothing failed yet, so nothing is said
    expect(q('.chats-sessions')).toBeNull()
    await pollTick()
    await settle()
    expect(offPair(1).map(([disabled]) => disabled)).toEqual([null, null])
    expect(inRow(1, '.chats-copy')!.title).toBe(`cd '/Users/tester/dev/alpha' && copilot --resume=${uuid(1)}`)
    expect(continueFor(1)).not.toBeNull()
  })

  it('says once above the table when no list could be read, and stops once one is', async () => {
    launchBridge()
    chatsBridge()
    control.failLaunches = true
    await boot()
    await openChats()
    const note = q('.chats-sessions')!
    expect([note.textContent, note.className, note.getAttribute('role')]).toEqual([unread, 'chats-note chats-sessions', 'status'])
    expect(panel().querySelectorAll('.chats-sessions')).toHaveLength(1)
    expect(note.nextElementSibling).toBe(q('.chats-count'))
    expect(offPair(1)).toEqual([['true', checking], ['true', checking]])
    await changedPollTick(db!)
    await settle()
    expect(panel().querySelectorAll('.chats-sessions')).toHaveLength(1)
    control.failLaunches = false
    await pollTick()
    await settle()
    expect(q('.chats-sessions')).toBeNull()
    expect(continueFor(1)).not.toBeNull()
  })

  it('with the switch off, none of it: no note, nothing off for a session here, and no launch read', async () => {
    launchBridge({ enabled: false, available: false })
    chatsBridge()
    control.failLaunches = true
    const { reads } = await boot(fixture(), (d) => chatLaunch(d, 1))
    await openChats()
    await changedPollTick(db!)
    await settle()
    expect(q('.chats-sessions')).toBeNull()
    expect(offPair(1).map(([disabled]) => disabled)).toEqual([null, null])
    expect(reads.filter((u) => u.includes('/api/launch'))).toEqual([])
  })
})

describe('the session panel’s chat line (review of PR 6)', () => {
  const OTHER = '11111111-2222-4333-8444-777777777777'

  it('has no link for a launch that continues no chat, and keeps none after showing one that does', async () => {
    launchBridge()
    await boot(fixture(), (d) => {
      chatLaunch(d, 1)
      createLaunch(d, {
        id: OTHER, host: 'copilot', project: 'alpha', stream: 'main', cwd: '/Users/tester/dev/alpha', mode: 'ask',
        budgetActiveMs: null, budgetToolCalls: null, prompt: 'Fresh.', specVersion: 1, driverPid: 4243,
      })
    })
    const line = () => focusPanel().querySelector<HTMLElement>('.sp-chat')!
    const open = async (id: string) => {
      click(document.querySelector(`[data-session-card="launch:${id}"] .sc-doing`))
      await settle()
    }
    await open(OTHER)
    expect(focusPanel().dataset.session).toBe(`launch:${OTHER}`)
    expect([line().hidden, line().childElementCount, line().querySelector('a')]).toEqual([true, 0, null])
    await open(LAUNCH)
    expect([line().hidden, line().querySelectorAll('a').length]).toEqual([false, 1])
    await open(OTHER)
    expect([line().hidden, line().childElementCount]).toEqual([true, 0])
  })

  it('has no link without the grant, for any session', async () => {
    await boot(fixture(), (d) => {
      chatLaunch(d, 1)
      upsertActivity(d, { session: 'mcp-1', project: 'alpha', stream: 'main', agent: 'copilot', doing: 'open', idle: true, claim: false })
    })
    await pollTick()
    click(document.querySelector('[data-session-card="session:mcp-1"] .sc-doing'))
    await settle()
    expect(focusPanel().hidden).toBe(false)
    const line = focusPanel().querySelector<HTMLElement>('.sp-chat')!
    expect([line.hidden, line.childElementCount]).toEqual([true, 0])
    expect(document.querySelectorAll('.sp-chat-link')).toHaveLength(0)
  })
})
