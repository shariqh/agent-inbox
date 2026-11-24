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

describe('a late answer opens its chat row only where the row is drawn', () => {
  it('a refusal that lands after the person moved to Notes does not bring the chat row into Notes', async () => {
    let finish: (value: unknown) => void = () => {}
    const bridge = installBridge()
    bridge.resume.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    await boot({ seed: (d) => { insertItem(d, { ...ATLAS, kind: 'note', title: 'An atlas note' }) } })
    await openFindChats()
    click(slotOf(3))
    await settle()
    click(chip('notes'))
    await settle()
    const before = rowKeys()
    expect(before.some((k) => k?.startsWith('chat:'))).toBe(false)
    finish({ ok: false, reason: 'folder', error: 'Its folder no longer exists.' })
    await settle()
    await settle()
    expect(rowKeys()).toEqual(before)
    // back on the Chats chip the row is open and shows the note
    click(chip('chats'))
    await settle()
    expect(mainOf(3).getAttribute('aria-expanded')).toBe('true')
    expect(rowFor(3)!.querySelector('.chats-resume-note')?.textContent).toBe('Its folder no longer exists.')
  })

  it('a refusal that lands after the tool toggle hid the chat does not bring it back at the top', async () => {
    let finish: (value: unknown) => void = () => {}
    const bridge = installBridge()
    bridge.resume.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    await boot()
    await openFindChats()
    click(slotOf(3))
    await settle()
    click(line().querySelector('[data-chats-tool="copilot"]'))
    await settle()
    const before = rowKeys()
    expect(before).toEqual([chatKey(2, 'copilot')])
    finish({ ok: false, reason: 'folder', error: 'Its folder no longer exists.' })
    await settle()
    await settle()
    expect(rowKeys()).toEqual(before)
  })

  it('a refusal for a row that is drawn still opens it', async () => {
    const bridge = installBridge()
    bridge.resume.mockResolvedValue({ ok: false, reason: 'live', error: 'This chat is live in another process.' })
    await boot()
    await openFindChats()
    click(slotOf(3))
    await settle()
    await settle()
    expect(mainOf(3).getAttribute('aria-expanded')).toBe('true')
  })
})

describe('an open chat row is not paged away by a re-read', () => {
  it('Refresh with two newer chats keeps the open 20th row drawn, after the page', async () => {
    const many = Array.from({ length: 22 }, (_, i) => entry(i + 10))
    const { index } = await boot({ chats: many })
    await openFindChats()
    const open = `claude:${uuid(29)}`
    await openChatRow(open)
    expect(rowKeys().indexOf(`chat:${open}`)).toBe(19)
    index.chats = [...many, entry(1, { title: 'New A', lastActiveAt: ago(1) }), entry(2, { title: 'New B', lastActiveAt: ago(2) })]
    click(line().querySelector('.chats-refresh'))
    await settle()
    await settle()
    expect(chatRowFor(open)).not.toBeNull()
    expect(chatRowFor(open)!.querySelector(':scope > .find-row-body')).not.toBeNull()
  })

  it('an open note past the page stays drawn when a poll adds a note above it', async () => {
    await boot({
      chats: [],
      seed: (d) => {
        for (let i = 0; i < 22; i += 1) { advanceClock(); insertItem(d, { ...ATLAS, kind: 'note', title: `Note ${i}` }) }
      },
    })
    await openFindTab()
    click(chip('notes'))
    await settle()
    const keys = rowKeys()
    expect(keys).toHaveLength(20)
    const last = document.querySelector<HTMLElement>(`#findList > [data-find-key="${keys[19]}"] > .find-row-main`)!
    click(last)
    await settle()
    expect(last.getAttribute('aria-expanded')).toBe('true')
    advanceClock()
    insertItem(db!, { ...ATLAS, kind: 'note', title: 'Newest note' })
    await pollTick()
    await settle()
    expect(document.querySelector(`#findList > [data-find-key="${keys[19]}"]`)).not.toBeNull()
  })
})

describe('a chat that holds a note stays listed until the note is cleared', () => {
  for (const [reason, error, after] of [
    ['folder', 'Its folder no longer exists.', (c: ChatEntry) => [{ ...c, hidden: ['folder-gone'] as ChatEntry['hidden'] }]],
    ['missing', 'This chat is no longer on this Mac.', () => []],
  ] as const) {
    it(`Resume refused for ${reason}: the next read drops the chat, and its open row and note stay`, async () => {
      let index: { chats: ChatEntry[] } | null = null
      const bridge = installBridge()
      bridge.resume.mockImplementation(async () => {
        // what main found is what the next index read says
        index!.chats = index!.chats.flatMap((c) => (c.id === uuid(2) ? after(c) : [c]))
        return { ok: false, reason, error }
      })
      index = (await boot({ chats: [entry(1), entry(2), entry(3)] })).index
      await openFindChats()
      click(slotOf(2))
      await settle()
      await settle()
      await settle()
      expect(bridge.resume).toHaveBeenCalledTimes(1)
      expect(rowKeys()).toEqual([chatKey(1), chatKey(2), chatKey(3)])
      expect(mainOf(2).getAttribute('aria-expanded')).toBe('true')
      expect(rowFor(2)!.querySelector('.chats-resume-note')?.textContent).toBe(error)
    })
  }

  it('the row leaves once the note is cleared by the next read for another reason', async () => {
    let index: { chats: ChatEntry[] } | null = null
    const bridge = installBridge()
    bridge.resume.mockImplementation(async () => {
      index!.chats = index!.chats.filter((c) => c.id !== uuid(2))
      return { ok: false, reason: 'missing', error: 'This chat is no longer on this Mac.' }
    })
    index = (await boot({ chats: [entry(1), entry(2), entry(3)] })).index
    await openFindChats()
    click(slotOf(2))
    await settle()
    await settle()
    expect(rowKeys()).toContain(chatKey(2))
    click(line().querySelector('.chats-refresh'))
    await settle()
    await settle()
    expect(rowKeys()).toEqual([chatKey(1), chatKey(3)])
  })
})

describe('Find never claims "Nothing matches" or "Nothing here yet." over chats that are not counted', () => {
  it('under All with a query, a slow first chats read says nothing is matched yet, not "Nothing matches"', async () => {
    let release: (() => void) | null = null
    await boot({
      chats: [entry(1, { title: 'Zebra migration' })],
      intercept: async (input, _init, next) => {
        if (String(input).startsWith('/api/chats') && !release) await new Promise<void>((resolve) => { release = resolve })
        return await next()
      },
    })
    await openFindTab()
    await findFor('zebra')
    expect(statusText()).toBeNull()
    expect(document.getElementById('findChatsFoot')!.textContent).toContain('Loading chats…')
    expect(document.getElementById('findChatsFoot')!.querySelector<HTMLElement>('button')!.hidden).toBe(true)
    release!()
    await settle()
    await settle()
    expect(rowKeys()).toEqual([chatKey(1)])
    expect(statusText()).toBeNull()
  })

  it('under All with a query, a failed first chats read leaves the foot to speak, not "Nothing matches"', async () => {
    await boot({
      chats: [entry(1, { title: 'Zebra migration' })],
      intercept: async (input, _init, next) => (String(input).startsWith('/api/chats') ? new Response('x', { status: 500 }) : await next()),
    })
    await openFindTab()
    await findFor('zebra')
    expect(statusText()).toBeNull()
    const foot = document.getElementById('findChatsFoot')!
    expect(foot.hidden).toBe(false)
    expect(foot.textContent).toContain("Couldn't load chats (500).")
  })

  it('under All with a query that nothing matches once the chats are read, it still says so', async () => {
    await boot({ chats: [entry(1, { title: 'Zebra migration' })] })
    await openFindTab()
    await findFor('walrus')
    expect(statusText()).toBe('Nothing matches "walrus".')
  })

  for (const name of ['all', 'answers', 'notes', 'plans'] as const) {
    it(`${name} with chats and nothing else does not say "Nothing here yet."`, async () => {
      await boot({ chats: [entry(1)] })
      await openFindTab()
      click(chip(name))
      await settle()
      expect(statusText()).not.toBeNull()
      expect(statusText()).not.toBe('Nothing here yet.')
    })
  }

  it('with no chats and nothing else, All still says "Nothing here yet."', async () => {
    await boot({ chats: [] })
    await openFindTab()
    expect(statusText()).toBe('Nothing here yet.')
  })
})
