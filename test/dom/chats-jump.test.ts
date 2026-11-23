// @vitest-environment jsdom
// Jump to session (#586), in an open chat row on Find's Chats chip since UX pass, slice 4, step B:
// a chat live in a terminal goes to its own session card.
// The real /api/chats route joins the fake index's live processes to presence rows in a real hub,
// and the real page opens the Dashboard's session panel. Every fixture is synthetic.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { createLaunch, endActivity, upsertActivity } from '../../src/store.js'
import type { ChatEntry, ChatIndex } from '../../src/chat-index.js'
import { JUMP_GONE_TEXT } from '../../public/chats.js'
import { bootApp, chatRowFor, click, freshDb, openChatRow, openFindChats, pollTick, settle, T0, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
  Reflect.deleteProperty(window, 'agentInboxLaunch')
})

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ago = (minutes: number) => new Date(T0 - minutes * 60_000).toISOString()
const CLAUDE_SESSION = 'aaaaaaaa-1111-4111-8111-111111111111'
const COPILOT_SESSION = 'bbbbbbbb-2222-4222-8222-222222222222'
const LAUNCH = '11111111-2222-4333-8444-555555555555'

function entry(n: number, over: Partial<ChatEntry> = {}): ChatEntry {
  return {
    id: uuid(n), tool: 'claude', title: `Chat ${n}`, titleAuto: false, project: 'alpha',
    cwd: '/Users/tester/dev/alpha', branch: 'main', createdAt: ago(600), lastActiveAt: ago(n * 60),
    live: false, pr: null, hidden: [], ...over,
  }
}

// 1 and 2 are live in a process that has a session card; 3 and 5 are live in one that has none; 4 is not live
function fixture(): ChatEntry[] {
  return [
    entry(1, { title: 'Live Claude', live: true }),
    entry(2, { tool: 'copilot', title: 'Live Copilot', project: 'beta', cwd: '/Users/tester/dev/beta', live: true }),
    entry(3, { title: 'Live, no card', live: true }),
    entry(4, { title: 'Idle' }),
    entry(5, { tool: 'copilot', title: 'Live Copilot, no card', live: true }),
  ]
}
const LIVE_PIDS = new Map([
  [`claude:${uuid(1)}`, [4001]], [`copilot:${uuid(2)}`, [5001]], [`claude:${uuid(3)}`, [4003]], [`copilot:${uuid(5)}`, [5005]],
])

// a presence row as the MCP server writes it: its host is the chat's process, and its server runs (this process)
function presence(d: Database.Database, session: string, hostPid: number, project = 'alpha', agent = 'claude-code'): void {
  upsertActivity(d, { session, project, stream: 'main', agent, doing: 'open', idle: true, claim: false, host_pid: hostPid, server_pid: process.pid })
}

function both(d: Database.Database): void {
  presence(d, CLAUDE_SESSION, 4001)
  presence(d, COPILOT_SESSION, 5001, 'beta', 'copilot')
}

async function boot(setup: (d: Database.Database) => void = both) {
  db = freshDb()
  setup(db)
  const chatIndex: ChatIndex = {
    read: () => ({ chats: fixture(), truncated: false, work: { filesRead: 0, bytesRead: 0 }, livePids: LIVE_PIDS }),
    readCopilot: () => null,
    claudeDays: () => 30,
  }
  const reads: string[] = []
  await bootApp(db, {
    viewer: { chatIndex },
    interceptFetch: async (input, _init, next) => {
      reads.push(String(input))
      return await next()
    },
  })
  return { reads, db }
}

// the desktop app's launch bridge with the driven-sessions switch on, as chats-continue.test.ts fakes it
function launchBridge() {
  const state = { owned: true, enabled: true, available: true, canEnable: true }
  Object.defineProperty(window, 'agentInboxLaunch', { configurable: true, value: {
    available: vi.fn(async () => ({ ...state })),
    setEnabled: vi.fn(async (enabled: boolean) => ({ ok: true, enabled })),
    start: vi.fn(async () => ({ ok: false, error: 'not in this test' })),
    stop: vi.fn(async () => ({ ok: true, status: 'stopping' })),
    continueChat: vi.fn(async () => ({ ok: false, cancelled: true, error: 'Not continued.' })),
    onStartProgress: vi.fn(() => true),
  } })
}

const panel = () => document.getElementById('find') as HTMLElement
const rowFor = (n: number, tool = 'claude') => chatRowFor(`${tool}:${uuid(n)}`)
const jumpFor = (n: number, tool = 'claude') => rowFor(n, tool)?.querySelector<HTMLButtonElement>('.chats-jump') ?? null
const noteFor = (n: number, tool = 'claude') => rowFor(n, tool)?.querySelector<HTMLElement>('.chats-resume-note') ?? null
// the row's controls in order: its one slot beside the main button, then the open body's
const actionsOf = (n: number, tool = 'claude') => [
  ...rowFor(n, tool)!.querySelector(':scope > .find-slot')!.children,
  ...(rowFor(n, tool)!.querySelector('.find-row-body .chats-actions')?.children ?? []),
].map((el) => el.className)
const tabSelected = (id: string) => document.querySelector(`.tab[data-tab="${id}"]`)!.getAttribute('aria-selected')
const focusPanel = () => document.getElementById('dashFocus') as HTMLElement
const chatReads = (reads: string[]) => reads.filter((url) => url.startsWith('/api/chats')).length

// Find with the Chats chip, every chat row open (Jump to session lives in the open row)
async function openChats() {
  await openFindChats()
  for (const row of [...document.querySelectorAll<HTMLElement>('#findList > .find-row[data-find-type="chat"]')]) {
    await openChatRow(row.dataset.findKey!.slice(5))
  }
}

describe('Chats tab: Jump to session (#586)', () => {
  it('is drawn after Copy resume on a live chat whose process has a session card, for either tool', async () => {
    await boot()
    await openChats()
    expect(jumpFor(1)?.textContent).toBe('Jump to session')
    expect(jumpFor(1)?.title).toBe('Open this chat’s session on Home')
    expect(jumpFor(1)?.type).toBe('button')
    expect(jumpFor(2, 'copilot')?.textContent).toBe('Jump to session')
    // the row's note is there, empty, before any jump, so a screen reader hears it when it is filled
    expect(actionsOf(1)).toEqual(['chats-copy', 'chats-jump', 'chats-resume-note'])
    expect(noteFor(1)?.textContent).toBe('')
    expect(noteFor(1)?.getAttribute('role')).toBe('status')
    // a live chat with no card, and a chat that is not live, get none: their rows are phase 1's
    expect(actionsOf(3)).toEqual(['chats-copy'])
    expect(actionsOf(4)).toEqual(['chats-copy'])
    expect(actionsOf(5, 'copilot')).toEqual(['chats-copy'])
    // the session id is a lookup key only: it is nowhere on Find
    expect(panel().innerHTML).not.toContain(CLAUDE_SESSION)
    expect(panel().innerHTML).not.toContain(COPILOT_SESSION)
  })

  it('opens that session’s panel on the Dashboard', async () => {
    await boot()
    await openChats()
    expect(focusPanel().hidden).toBe(true)
    click(jumpFor(1))
    await settle()
    expect(tabSelected('dashboard')).toBe('true')
    expect(focusPanel().hidden).toBe(false)
    expect(focusPanel().dataset.session).toBe(CLAUDE_SESSION)
    expect(focusPanel().querySelector('#dashFocusTitle')!.textContent).toContain('alpha')
    expect(document.querySelector(`[data-session-card="session:${CLAUDE_SESSION}"]`)!.classList.contains('sel')).toBe(true)
    // and the other tool's chat goes to its own card, in its own project
    await openChats()
    click(jumpFor(2, 'copilot'))
    await settle()
    expect(tabSelected('dashboard')).toBe('true')
    expect(focusPanel().dataset.session).toBe(COPILOT_SESSION)
    expect(focusPanel().querySelector('#dashFocusTitle')!.textContent).toContain('beta')
  })

  it('finds a session that started after the page last read its sessions', async () => {
    const { db: d } = await boot(() => {})
    // the server starts between two polls: the list names it, the page has not read it yet
    presence(d, CLAUDE_SESSION, 4001)
    await openChats()
    expect(jumpFor(1)).not.toBeNull()
    expect(document.querySelector(`[data-session-card="session:${CLAUDE_SESSION}"]`)).toBeNull()
    click(jumpFor(1))
    await settle()
    expect(tabSelected('dashboard')).toBe('true')
    expect(focusPanel().dataset.session).toBe(CLAUDE_SESSION)
    expect(focusPanel().hidden).toBe(false)
  })

  it('says the session is no longer listed, stays on Find and reads the list again when it has gone', async () => {
    const { reads, db: d } = await boot()
    await openChats()
    expect(jumpFor(1)).not.toBeNull()
    expect(noteFor(1)?.textContent).toBe('')
    endActivity(d, CLAUDE_SESSION)
    await pollTick()
    const before = chatReads(reads)
    jumpFor(1)!.focus()
    click(jumpFor(1))
    await settle()
    expect(tabSelected('find')).toBe('true')
    expect(document.querySelector('#find [data-find-chip="chats"]')!.getAttribute('aria-pressed')).toBe('true')
    expect(focusPanel().hidden).toBe(true)
    expect(chatReads(reads)).toBe(before + 1)
    // the list read again names no session for it, so the control is gone and the note says why
    expect(jumpFor(1)).toBeNull()
    expect(noteFor(1)?.textContent).toBe(JUMP_GONE_TEXT)
    expect(noteFor(1)?.getAttribute('role')).toBe('status')
    // focus was on the control that went: it moves to the row's Copy resume, never to nowhere
    expect(document.activeElement).toBe(rowFor(1)!.querySelector('.chats-copy'))
    // the other row is untouched
    expect(jumpFor(2, 'copilot')).not.toBeNull()
    expect(noteFor(2, 'copilot')?.textContent).toBe('')
  })

  it('drops that note at the next read of the list, so it never sits beside a session that came back', async () => {
    const { db: d } = await boot()
    await openChats()
    endActivity(d, CLAUDE_SESSION)
    await pollTick()
    click(jumpFor(1))
    await settle()
    expect(noteFor(1)?.textContent).toBe(JUMP_GONE_TEXT)
    // the tool restarts: a new presence row for the same process
    presence(d, 'cccccccc-3333-4333-8333-333333333333', 4001)
    click(document.querySelector('#findChats .chats-refresh'))
    await settle()
    expect(jumpFor(1)).not.toBeNull()
    expect(noteFor(1)?.textContent).toBe('')
  })

  it('keeps a failed jump’s note to its own row', async () => {
    const { db: d } = await boot()
    await openChats()
    endActivity(d, COPILOT_SESSION)
    await pollTick()
    // the page still lists the Claude session; only the Copilot one has gone
    click(jumpFor(2, 'copilot'))
    await settle()
    expect(noteFor(2, 'copilot')?.textContent).toBe(JUMP_GONE_TEXT)
    expect(noteFor(1)?.textContent).toBe('')
  })

  it('takes the place of an off Continue here… on a live Copilot row, with driven sessions on', async () => {
    launchBridge()
    await boot()
    await pollTick()
    await openChats()
    await settle()
    // live with a card: Jump to session, and no Continue here… that could only be off
    expect(actionsOf(2, 'copilot')).toEqual(['chats-copy', 'chats-jump', 'chats-resume-note'])
    // live with no card: Continue here… off, with its reason, as before
    const off = rowFor(5, 'copilot')!.querySelector<HTMLButtonElement>('.chats-continue')!
    expect(off.getAttribute('aria-disabled')).toBe('true')
    expect(off.title).toBe('This chat is live in another process, so it is not continued a second time.')
    expect(rowFor(5, 'copilot')!.querySelector('.chats-jump')).toBeNull()
  })

  it('leaves a chat a session here holds to Show session', async () => {
    launchBridge()
    await boot((d) => {
      both(d)
      createLaunch(d, {
        id: LAUNCH, host: 'copilot', project: 'beta', stream: 'main', cwd: '/Users/tester/dev/beta', mode: 'ask',
        budgetActiveMs: null, budgetToolCalls: null, prompt: 'Go on.', specVersion: 1, driverPid: 4242, chatId: uuid(2),
      })
    })
    await pollTick()
    await openChats()
    await settle()
    expect(rowFor(2, 'copilot')!.querySelector('.chats-show')).not.toBeNull()
    expect(jumpFor(2, 'copilot')).toBeNull()
    // the Claude chat beside it still jumps
    expect(jumpFor(1)).not.toBeNull()
  })

  it('draws none on a Copilot row until this window knows whether a session here holds the chat', async () => {
    launchBridge()
    await boot((d) => {
      both(d)
      createLaunch(d, {
        id: LAUNCH, host: 'copilot', project: 'beta', stream: 'main', cwd: '/Users/tester/dev/beta', mode: 'ask',
        budgetActiveMs: null, budgetToolCalls: null, prompt: 'Go on.', specVersion: 1, driverPid: 4242, chatId: uuid(2),
      })
    })
    // the tab is opened before the first poll has read the launches
    await openChats()
    expect(rowFor(2, 'copilot')!.querySelector('.chats-show')).toBeNull()
    expect(jumpFor(2, 'copilot')).toBeNull()
    // a Claude Code chat is never driven here, so it does not wait
    expect(jumpFor(1)).not.toBeNull()
    await pollTick()
    await settle()
    expect(rowFor(2, 'copilot')!.querySelector('.chats-show')).not.toBeNull()
    expect(jumpFor(2, 'copilot')).toBeNull()
  })
})
