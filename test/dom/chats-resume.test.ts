// @vitest-environment jsdom
// Resume in Terminal (#586 PR 3), in a chat row's one slot on Find's Chats chip since UX pass,
// slice 4, step B. The control exists only where the desktop app's preload exposes
// window.agentInboxChats; it acts only once main says this window can resume. Here a fake bridge
// stands in for main. The real route runs over a fake chat index. Every fixture is synthetic, and
// nothing opens.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import type { ChatEntry, ChatIndex } from '../../src/chat-index.js'
import { RESUME_BUSY_LABEL, RESUME_LABEL, RESUME_UNAVAILABLE } from '../../public/chats.js'
import { bootApp, chatRowFor, click, findFor, freshDb, openChatRow, openFindChats, repaint, settle, T0, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
  Reflect.deleteProperty(window, 'agentInboxChats')
})

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ago = (minutes: number) => new Date(T0 - minutes * 60_000).toISOString()

function entry(n: number, over: Partial<ChatEntry> = {}): ChatEntry {
  return {
    id: uuid(n), tool: 'claude', title: `Chat ${n}`, titleAuto: false, project: 'alpha',
    cwd: '/Users/tester/dev/alpha', branch: 'main', createdAt: ago(600), lastActiveAt: ago(n * 60),
    live: false, pr: null, hidden: [], ...over,
  }
}

function fixture(): ChatEntry[] {
  return [
    entry(1, { title: 'Fix the parser' }),
    entry(2, { tool: 'copilot', title: 'Live one', live: true }),
    entry(3, { title: 'Gone', cwd: '/Users/tester/gone', hidden: ['folder-gone'] }),
    entry(4, { title: 'Nowhere', cwd: null, hidden: ['folder-gone'] }),
    entry(5, { tool: 'copilot', title: 'Copilot chat' }),
  ]
}

type Answer = unknown
interface Bridge {
  resumeAvailable: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
  state: { available: Answer; next: Answer | Promise<Answer> }
}

function installBridge(available: Answer = { available: true, terminal: 'terminal' }): Bridge {
  const state = { available, next: { ok: true, terminal: 'terminal' } as Answer | Promise<Answer> }
  const bridge = {
    resumeAvailable: vi.fn(async () => state.available),
    resume: vi.fn(async () => await state.next),
  }
  Object.defineProperty(window, 'agentInboxChats', { value: bridge, configurable: true })
  return { ...bridge, state }
}

async function boot(chats = fixture()) {
  db = freshDb()
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
      const url = String(input)
      if (url.startsWith('/api/chats')) reads.push(url)
      return await next()
    },
  })
  return { reads, index }
}

const panel = () => document.getElementById('find') as HTMLElement
const q = <T extends Element = HTMLElement>(sel: string) => document.getElementById('findChats')!.querySelector<T>(sel)
const rowFor = (n: number, tool = 'claude') => chatRowFor(`${tool}:${uuid(n)}`)
const resumeFor = (n: number, tool = 'claude') => rowFor(n, tool)?.querySelector<HTMLButtonElement>('.chats-resume') ?? null
const noteFor = (n: number, tool = 'claude') => rowFor(n, tool)?.querySelector<HTMLElement>('.chats-resume-note') ?? null
const openRow = (n: number, tool = 'claude') => openChatRow(`${tool}:${uuid(n)}`)
// the row's controls in order: its one slot beside the main button, then the open body's
const controlsOf = (n: number, tool = 'claude') => [
  ...rowFor(n, tool)!.querySelector(':scope > .find-slot')!.children,
  ...(rowFor(n, tool)!.querySelector('.find-row-body .chats-actions')?.children ?? []),
].map((el) => el.className)

async function openChats() {
  await openFindChats()
  await settle()
}

async function leaveAndReturn() {
  click(document.querySelector('.tab[data-tab="dashboard"]'))
  await settle()
  await openChats()
}

describe('Resume in Terminal (#586 PR 3)', () => {
  it('draws no Resume without the bridge, and leaves Copy resume as it was', async () => {
    await boot()
    await openChats()
    await openRow(1)
    expect(panel().querySelectorAll('.chats-resume, .chats-resume-note')).toHaveLength(0)
    // Copy resume holds the row's one slot
    expect(controlsOf(1)).toEqual(['chats-copy'])
  })

  it('draws Resume off, with main’s reason, when main says this window cannot resume', async () => {
    const bridge = installBridge({ available: false, terminal: 'terminal' })
    await boot()
    await openChats()
    await openRow(1)
    expect(bridge.resumeAvailable).toHaveBeenCalled()
    // step B: the slot is chosen by the bridge, never by main's answer, so it never swaps under a press
    expect([resumeFor(1)!.getAttribute('aria-disabled'), resumeFor(1)!.title]).toEqual(['true', RESUME_UNAVAILABLE])
    expect(controlsOf(1)).toEqual(['chats-resume', 'chats-copy', 'chats-resume-note'])
    click(resumeFor(1))
    await settle()
    expect(bridge.resume).not.toHaveBeenCalled()
  })

  it('draws Resume before Copy resume, titled with the app', async () => {
    installBridge()
    await boot()
    await openChats()
    await openRow(1)
    const control = resumeFor(1)!
    expect(controlsOf(1)).toEqual(['chats-resume', 'chats-copy', 'chats-resume-note'])
    expect([control.textContent, control.title, control.hasAttribute('aria-label'), control.hasAttribute('aria-disabled')])
      .toEqual([RESUME_LABEL, 'Resume in Terminal', false, false])
    expect(noteFor(1)!.getAttribute('role')).toBe('status')
  })

  it('names iTerm2 in the title and the accessible name, and follows a change of terminal on the next entry', async () => {
    const bridge = installBridge({ available: true, terminal: 'iterm2' })
    await boot()
    await openChats()
    expect([resumeFor(1)!.title, resumeFor(1)!.getAttribute('aria-label'), resumeFor(1)!.textContent])
      .toEqual(['Resume in iTerm2', 'Resume in iTerm2', 'Resume'])
    bridge.state.available = { available: true, terminal: 'terminal' }
    await leaveAndReturn()
    expect([resumeFor(1)!.title, resumeFor(1)!.hasAttribute('aria-label')]).toEqual(['Resume in Terminal', false])
    bridge.state.available = { available: false, terminal: 'terminal' }
    await leaveAndReturn()
    // step B: drawn off with main's reason, in the same slot
    expect([resumeFor(1)!.getAttribute('aria-disabled'), resumeFor(1)!.title]).toEqual(['true', RESUME_UNAVAILABLE])
    // asked on entering Find and again when the Chats chip is pressed there (the first visit), then
    // once on each return (the chip stays selected)
    expect(bridge.resumeAvailable).toHaveBeenCalledTimes(4)
  })

  it('is off, with the reason as its title, for a live chat or a folder that is gone or missing', async () => {
    const bridge = installBridge()
    await boot()
    await openChats()
    click(q<HTMLInputElement>('.chats-all input'))
    await settle()
    const cases: Array<[HTMLButtonElement, string]> = [
      [resumeFor(2, 'copilot')!, 'This chat is live in another process, so it is not resumed a second time.'],
      [resumeFor(3)!, "The chat's folder no longer exists, so it cannot be resumed there."],
      [resumeFor(4)!, "The chat's files name no folder to resume in."],
    ]
    for (const [control, title] of cases) {
      expect([control.getAttribute('aria-disabled'), control.title, control.hasAttribute('aria-label')]).toEqual(['true', title, false])
      click(control)
      await settle()
    }
    expect(bridge.resume).not.toHaveBeenCalled()
  })

  it('is busy while main works, through a repaint, and takes one press at a time', async () => {
    const bridge = installBridge()
    let answer: (value: unknown) => void = () => {}
    bridge.state.next = new Promise((resolve) => { answer = resolve })
    await boot()
    await openChats()
    click(resumeFor(1))
    await settle()
    expect([resumeFor(1)!.textContent, resumeFor(1)!.getAttribute('aria-disabled')]).toEqual([RESUME_BUSY_LABEL, 'true'])
    click(resumeFor(1))
    await findFor('parser')
    await findFor('')
    await repaint()
    expect(resumeFor(1)!.textContent).toBe(RESUME_BUSY_LABEL)
    expect(bridge.resume).toHaveBeenCalledTimes(1)
    answer({ ok: true, terminal: 'terminal' })
    await settle()
    expect(resumeFor(1)!.textContent).toBe('Opened in Terminal')
  })

  it('sends only the tool and id, and confirms with the app it opened', async () => {
    const bridge = installBridge({ available: true, terminal: 'iterm2' })
    bridge.state.next = { ok: true, terminal: 'iterm2' }
    const { reads } = await boot()
    await openChats()
    await openRow(5, 'copilot')
    const before = reads.length
    click(resumeFor(5, 'copilot'))
    await settle()
    expect(bridge.resume.mock.calls).toEqual([[{ tool: 'copilot', id: uuid(5) }]])
    const control = resumeFor(5, 'copilot')!
    expect([control.textContent, control.hasAttribute('aria-label'), control.hasAttribute('aria-disabled')]).toEqual(['Opened in iTerm2', false, false])
    expect(noteFor(5, 'copilot')!.textContent).toBe('')
    // a repaint does not cut the confirmation short
    await repaint()
    expect(resumeFor(5, 'copilot')!.textContent).toBe('Opened in iTerm2')
    await vi.advanceTimersByTimeAsync(1500)
    await settle()
    expect([resumeFor(5, 'copilot')!.textContent, resumeFor(5, 'copilot')!.getAttribute('aria-label')]).toEqual(['Resume', 'Resume in iTerm2'])
    expect(reads.length).toBe(before)
  })

  it('shows the fallback notice under the row', async () => {
    const bridge = installBridge({ available: true, terminal: 'iterm2' })
    const notice = 'iTerm2 could not be opened, so Terminal was opened instead.'
    bridge.state.next = { ok: true, terminal: 'terminal', notice }
    await boot()
    await openChats()
    click(resumeFor(1))
    await settle()
    expect([resumeFor(1)!.textContent, noteFor(1)!.textContent]).toEqual(['Opened in Terminal', notice])
    // the note stays after the confirmation, until the next press
    await vi.advanceTimersByTimeAsync(1500)
    await settle()
    expect(noteFor(1)!.textContent).toBe(notice)
    bridge.state.next = { ok: true, terminal: 'iterm2' }
    click(resumeFor(1))
    await settle()
    expect(noteFor(1)!.textContent).toBe('')
  })

  it.each([
    ['live', 'This chat is live in another process.', true],
    ['folder', 'Its folder no longer exists.', true],
    ['missing', 'This chat is no longer listed.', true],
    ['open', 'Could not open iTerm2.', false],
    ['busy', 'Another chat is opening. Try again in a moment.', false],
  ])('shows a %s refusal’s reason, and reads the list again only where the row may now be off', async (reason, error, refresh) => {
    const bridge = installBridge()
    bridge.state.next = { ok: false, reason, error }
    const { reads } = await boot()
    await openChats()
    const before = reads.length
    click(resumeFor(1))
    await settle()
    await settle()
    expect([resumeFor(1)!.textContent, noteFor(1)!.textContent]).toEqual(['Resume', error])
    expect(reads.length - before).toBe(refresh ? 1 : 0)
  })

  it('turns off a chat that went live, once the list is read again after main refused it', async () => {
    const bridge = installBridge()
    bridge.state.next = { ok: false, reason: 'live', error: 'This chat is live in another process.' }
    const { index } = await boot()
    await openChats()
    index.chats = index.chats.map((chat) => (chat.id === uuid(1) ? { ...chat, live: true } : chat))
    click(resumeFor(1))
    await settle()
    await settle()
    expect([resumeFor(1)!.getAttribute('aria-disabled'), resumeFor(1)!.title])
      .toEqual(['true', 'This chat is live in another process, so it is not resumed a second time.'])
    expect(noteFor(1)!.textContent).toBe('This chat is live in another process.')
  })

  it('says so when the bridge fails', async () => {
    const bridge = installBridge()
    bridge.resume.mockImplementation(async () => { throw new Error('gone') })
    await boot()
    await openChats()
    click(resumeFor(1))
    await settle()
    expect([resumeFor(1)!.textContent, noteFor(1)!.textContent]).toEqual(['Resume', 'Could not resume this chat.'])
  })
})
