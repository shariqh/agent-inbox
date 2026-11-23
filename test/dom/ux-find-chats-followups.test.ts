// @vitest-environment jsdom
// UX pass, slice 4, step B, follow-ups from the review: reaching the Chats chip from inside Find
// reads under the 60-second rule; focus inside a chat row survives a poll that moves the row; a late
// note opens its row only where it is drawn; an open row is kept in sight past the page; a chat that
// holds a note stays listed until the note is cleared; "Loading chats…" and "Nothing here yet." never
// speak for a list the chats have not been read into. Every press is a real event through the
// harness. The real /api/chats route runs over a fake chat index; every fixture is synthetic.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, resolveItem } from '../../src/store.js'
import type { ChatEntry, ChatIndex } from '../../src/chat-index.js'
import {
  advanceClock, bootApp, chatRowFor, click, findFor, freshDb, openChatRow, openFindChats, pollTick, settle, T0, useDomTest,
} from './harness.js'
import type { BootOptions } from './harness.js'

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
    id: uuid(n), tool: 'claude', title: `Chat ${n}`, titleAuto: false, project: 'atlas',
    cwd: '/Users/tester/dev/atlas', branch: 'main', createdAt: ago(600), lastActiveAt: ago(n * 60),
    live: false, pr: null, hidden: [], ...over,
  }
}

function fixture(): ChatEntry[] {
  return [
    entry(1, { title: 'Backup job for ledger exports', project: 'ledger', cwd: '/Users/tester/dev/ledger' }),
    entry(2, { tool: 'copilot', title: 'Restore test on staging', branch: 'feat/restore' }),
    entry(3, { title: 'Harbor tidy', project: 'harbor', cwd: '/Users/tester/dev/harbor' }),
  ]
}

interface Setup { chats?: ChatEntry[]; intercept?: BootOptions['interceptFetch']; seed?: (d: Database.Database) => void }

async function boot({ chats = fixture(), intercept, seed }: Setup = {}) {
  db = freshDb()
  seed?.(db)
  const index = { chats }
  const chatIndex: ChatIndex = {
    read: () => ({ chats: index.chats, truncated: false, work: { filesRead: 0, bytesRead: 0 } }),
    readCopilot: () => null,
    claudeDays: () => 30,
  }
  const reads: string[] = []
  await bootApp(db, {
    viewer: { chatIndex },
    interceptFetch: async (input, init, next) => {
      if (String(input).startsWith('/api/chats')) reads.push(String(input))
      return intercept ? await intercept(input, init, next) : await next()
    },
  })
  return { reads, index }
}

const ATLAS = { project: 'atlas', stream: 'main', agent: 'claude-code' } as const

const chip = (name: string) => document.querySelector<HTMLButtonElement>(`#find [data-find-chip="${name}"]`)!
const line = () => document.getElementById('findChats') as HTMLElement
const status = () => document.getElementById('findStatus') as HTMLElement
const statusText = () => (status().hidden ? null : status().textContent)
const rowKeys = () => [...document.querySelectorAll<HTMLElement>('#findList > .find-row')].map((el) => el.dataset.findKey)
const chatKey = (n: number, tool = 'claude') => `chat:${tool}:${uuid(n)}`
const rowFor = (n: number, tool = 'claude') => chatRowFor(`${tool}:${uuid(n)}`)
const slotOf = (n: number, tool = 'claude') => rowFor(n, tool)!.querySelector<HTMLButtonElement>(':scope > .find-slot > button')!
const mainOf = (n: number, tool = 'claude') => rowFor(n, tool)!.querySelector<HTMLButtonElement>(':scope > .find-row-main')!

function installBridge() {
  const bridge = {
    resumeAvailable: vi.fn(async () => ({ available: true, terminal: 'terminal' })),
    resume: vi.fn(async (_request: unknown) => ({ ok: false, reason: 'folder', error: 'Its folder no longer exists.' }) as unknown),
  }
  Object.defineProperty(window, 'agentInboxChats', { value: bridge, configurable: true })
  return bridge
}

function key(target: EventTarget, keyName: string) {
  target.dispatchEvent(new window.KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true }))
}

async function openFindTab() {
  click(document.querySelector('.tab[data-tab="find"]'))
  await settle()
  await settle()
}

describe('reaching the chats from inside Find reads under the 60-second rule', () => {
  it('the Chats chip, pressed 61 s after the entry read, reads again and shows the new chat and Live', async () => {
    const { reads, index } = await boot()
    await openFindTab()
    expect(reads).toEqual(['/api/chats'])
    index.chats = [...index.chats.map((c) => (c.id === uuid(3) ? { ...c, live: true } : c)), entry(9, { title: 'Brand new chat', lastActiveAt: ago(0) })]
    advanceClock(61_000)
    await pollTick()
    click(chip('chats'))
    await settle()
    await settle()
    expect(reads).toEqual(['/api/chats', '/api/chats'])
    expect(Boolean(rowFor(9))).toBe(true)
    expect(Boolean(rowFor(3)?.querySelector('.find-live'))).toBe(true)
  })

  it('does not read again inside the 60 seconds', async () => {
    const { reads } = await boot()
    await openFindTab()
    advanceClock(20_000)
    click(chip('chats'))
    await settle()
    expect(reads).toEqual(['/api/chats'])
  })

  it('G C, pressed from Find: Notes after the list went stale, reads again', async () => {
    const { reads, index } = await boot()
    await openFindTab()
    click(chip('notes'))
    await settle()
    index.chats = [...index.chats, entry(9, { title: 'Brand new chat', lastActiveAt: ago(0) })]
    advanceClock(5 * 60_000)
    ;(document.activeElement as HTMLElement | null)?.blur()
    key(document.body, 'g')
    key(document.body, 'c')
    await settle()
    await settle()
    expect(chip('chats').getAttribute('aria-pressed')).toBe('true')
    expect(reads).toEqual(['/api/chats', '/api/chats'])
    expect(Boolean(rowFor(9))).toBe(true)
  })

  it('G C, pressed while the Chats chip is already showing, reads again when stale', async () => {
    const { reads } = await boot()
    await openFindChats()
    expect(reads).toEqual(['/api/chats'])
    advanceClock(5 * 60_000)
    ;(document.activeElement as HTMLElement | null)?.blur()
    key(document.body, 'g')
    key(document.body, 'c')
    await settle()
    await settle()
    expect(reads).toEqual(['/api/chats', '/api/chats'])
  })
})

describe('a chat row that a poll moves keeps the focus inside it', () => {
  it('a keyboard user on the slot button stays on it when a note resolves and moves the row', async () => {
    let note = ''
    await boot({ seed: (d) => { note = insertItem(d, { ...ATLAS, kind: 'note', title: 'Backup ran twice' }) } })
    await openFindTab()
    await findFor('backup')
    expect(rowKeys()).toEqual([`item:${note}`, chatKey(1)])
    const slot = slotOf(1)
    slot.focus()
    expect(document.activeElement).toBe(slot)
    resolveItem(db!, note, 'done')
    await pollTick()
    await settle()
    expect(rowKeys()).toEqual([chatKey(1), `item:${note}`])
    expect(document.activeElement).toBe(slotOf(1))
  })

  it('a keyboard user on a control in the open body stays on it', async () => {
    // with the desktop bridge the open body holds Copy resume beside the slot's Resume
    installBridge()
    let note = ''
    await boot({ seed: (d) => { note = insertItem(d, { ...ATLAS, kind: 'note', title: 'Backup ran twice' }) } })
    await openFindTab()
    await findFor('backup')
    await openChatRow(`claude:${uuid(1)}`)
    const control = rowFor(1)!.querySelector<HTMLButtonElement>('.find-row-body .chats-copy')!
    control.focus()
    expect(document.activeElement).toBe(control)
    resolveItem(db!, note, 'done')
    await pollTick()
    await settle()
    expect(rowKeys()[0]).toBe(chatKey(1))
    expect(document.activeElement).toBe(control)
  })
})

