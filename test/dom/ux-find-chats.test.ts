// @vitest-environment jsdom
// UX pass, slice 4, step B: the Chats page folded into Find. A fifth chip, Chats; chat rows keyed
// `chat:<tool>:<id>` with one reserved action slot beside the main button; the Chats line under the
// chips; chats as a section of All with a query; the read on entering Find under the 60-second
// rule. Every press and key is a real event through the harness, which refuses a control a person
// cannot reach. The real /api/chats route runs over a fake chat index; every fixture is synthetic.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, resolveItem } from '../../src/store.js'
import type { ChatEntry, ChatIndex } from '../../src/chat-index.js'
import { RESUME_CHECKING, RESUME_UNAVAILABLE } from '../../public/chats.js'
import {
  advanceClock, bootApp, chatRowFor, click, findFor, freshDb, openChatRow, openFindChats, pollTick, settle, T0, unreachableReason, useDomTest,
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
    entry(1, { title: 'Backup job for ledger exports', project: 'ledger', cwd: '/Users/tester/dev/ledger', live: true }),
    entry(2, { tool: 'copilot', title: 'Restore test on staging', branch: 'feat/restore' }),
    entry(3, { title: 'Harbor tidy', project: 'harbor', cwd: '/Users/tester/dev/harbor' }),
    entry(4, { tool: 'copilot', title: 'Backup scratch', cwd: '/private/tmp/x', hidden: ['temp'] }),
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
const LEDGER = { project: 'ledger', stream: 'main', agent: 'copilot' } as const

const chip = (name: string) => document.querySelector<HTMLButtonElement>(`#find [data-find-chip="${name}"]`)!
const line = () => document.getElementById('findChats') as HTMLElement
const field = () => document.getElementById('findQuery') as HTMLInputElement
const rowKeys = () => [...document.querySelectorAll<HTMLElement>('#findList > .find-row')].map((el) => el.dataset.findKey)
const chatKey = (n: number, tool = 'claude') => `chat:${tool}:${uuid(n)}`
const rowFor = (n: number, tool = 'claude') => chatRowFor(`${tool}:${uuid(n)}`)
const slotOf = (n: number, tool = 'claude') => rowFor(n, tool)!.querySelector<HTMLButtonElement>(':scope > .find-slot > button')!

function installBridge(answer: Promise<unknown> | unknown = { available: true, terminal: 'terminal' }) {
  const bridge = {
    resumeAvailable: vi.fn(async () => await answer),
    resume: vi.fn(async (_request: unknown) => ({ ok: false, reason: 'folder', error: 'Its folder no longer exists.' }) as unknown),
  }
  Object.defineProperty(window, 'agentInboxChats', { value: bridge, configurable: true })
  return bridge
}

function key(target: EventTarget, keyName: string) {
  const event = new window.KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

async function openFindTab() {
  click(document.querySelector('.tab[data-tab="find"]'))
  await settle()
  await settle()
}

describe('B · the Chats chip', () => {
  it('is the fifth chip, after Plans; the Chats line shows only while it is selected', async () => {
    await boot()
    await openFindTab()
    expect([...document.querySelectorAll('#find [data-find-chip]')].map((el) => el.textContent)).toEqual(['All', 'Answers', 'Notes', 'Plans', 'Chats'])
    expect(line().hidden).toBe(true)
    click(chip('chats'))
    await settle()
    expect([line().hidden, chip('chats').getAttribute('aria-pressed')]).toEqual([false, 'true'])
    // the tool toggles, Show all and Refresh, each reachable
    for (const sel of ['[data-chats-tool="all"]', '[data-chats-tool="claude"]', '[data-chats-tool="copilot"]', '.chats-all input', '.chats-refresh']) {
      expect(unreachableReason(line().querySelector(sel)!), sel).toBeNull()
    }
    for (const name of ['all', 'answers', 'notes', 'plans']) {
      click(chip(name))
      await settle()
      expect(line().hidden, name).toBe(true)
      expect(rowKeys().some((k) => k?.startsWith('chat:')), name).toBe(false)
    }
  })

  it('lists every chat newest active first, ignoring the project rail and the Agent select', async () => {
    await boot({
      seed: (d) => {
        insertItem(d, { ...ATLAS, kind: 'note', title: 'An atlas note' })
        insertItem(d, { ...LEDGER, kind: 'note', title: 'A ledger note' })
      },
    })
    await openFindChats()
    const all = [chatKey(1), chatKey(2, 'copilot'), chatKey(3)]
    expect(rowKeys()).toEqual(all)
    // the Agent select narrows the notes, never the chats
    const agents = document.getElementById('agentSelect') as HTMLSelectElement
    agents.value = 'copilot'
    agents.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    expect(agents.value).toBe('copilot')
    expect(rowKeys()).toEqual(all)
    click(chip('notes'))
    await settle()
    expect([...document.querySelectorAll('#findList .find-title')].map((el) => el.textContent)).toEqual(['A ledger note'])
    // nor does the project rail
    click(document.querySelector('#rail [data-project="atlas"]'))
    await settle()
    click(chip('chats'))
    await settle()
    expect(rowKeys()).toEqual(all)
    click(chip('notes'))
    await settle()
    const titles = () => [...document.querySelectorAll('#findList .find-title')].map((el) => el.textContent)
    expect(titles()).not.toContain('A ledger note')
  })

  it('filters with the field by substring over title, project, branch and folder, never the id', async () => {
    await boot()
    await openFindChats()
    await findFor('restore')
    expect(rowKeys()).toEqual([chatKey(2, 'copilot')])
    await findFor('feat/rest')
    expect(rowKeys()).toEqual([chatKey(2, 'copilot')])
    await findFor('harbor')
    expect(rowKeys()).toEqual([chatKey(3)])
    await findFor('~/dev/ledger')
    expect(rowKeys()).toEqual([chatKey(1)])
    // substring, as the Chats page did: no fuzzy match
    await findFor('bkup')
    expect(rowKeys()).toEqual([])
    await findFor(uuid(3))
    expect(rowKeys()).toEqual([])
    expect(line().querySelector('.chats-state')?.textContent).toBe('No chats match the search and filters.')
  })

  it('says Loading chats… until the first read lands, and a failed read never blanks the rows on screen', async () => {
    let release: (() => void) | null = null
    let fail = false
    await boot({
      intercept: async (input, _init, next) => {
        if (!String(input).startsWith('/api/chats')) return await next()
        if (!release) await new Promise<void>((resolve) => { release = resolve })
        return fail ? new Response('down', { status: 503 }) : await next()
      },
    })
    await openFindChats()
    expect([line().querySelector('.chats-state')?.textContent, rowKeys()]).toEqual(['Loading chats…', []])
    release!()
    await settle()
    expect(rowKeys()).toHaveLength(3)
    expect(line().querySelector('.chats-state')?.hidden).toBe(true)
    fail = true
    click(line().querySelector('.chats-refresh'))
    await settle()
    expect(rowKeys()).toHaveLength(3)
    expect(line().querySelector('.chats-error span')?.textContent).toBe("Couldn't refresh chats (503). Showing the last list.")
  })
})

describe('B · chats under All', () => {
  it('leaves chats out with no query, and lists them after the notes and before finished things with one', async () => {
    let note = ''
    let done = ''
    await boot({
      seed: (d) => {
        done = insertItem(d, { ...ATLAS, kind: 'done', title: 'Backup drill shipped' })
        resolveItem(d, done, 'Shipped.')
        advanceClock()
        note = insertItem(d, { ...ATLAS, kind: 'note', title: 'Backup ran twice' })
      },
    })
    await openFindTab()
    expect(chip('all').getAttribute('aria-pressed')).toBe('true')
    expect(rowKeys().some((k) => k?.startsWith('chat:'))).toBe(false)
    await findFor('backup')
    // the default list only (the temp-folder chat is hidden), every tool
    expect(rowKeys()).toEqual([`item:${note}`, chatKey(1), `item:${done}`])
    // the Chats line is not drawn under All, so its tool toggle does not narrow All
    click(chip('chats'))
    await settle()
    click(line().querySelector('[data-chats-tool="copilot"]'))
    await settle()
    click(chip('all'))
    await settle()
    expect(rowKeys()).toEqual([`item:${note}`, chatKey(1), `item:${done}`])
  })

  it('says a failed chats read once at the list’s foot, with Retry', async () => {
    let fail = true
    await boot({
      intercept: async (input, _init, next) => (String(input).startsWith('/api/chats') && fail ? new Response('down', { status: 500 }) : await next()),
    })
    await openFindTab()
    const foot = document.getElementById('findChatsFoot')!
    expect(foot.hidden).toBe(true)
    await findFor('backup')
    expect([foot.hidden, foot.querySelector('span')?.textContent]).toEqual([false, "Couldn't load chats (500)."])
    expect(foot.querySelectorAll('.chats-error')).toHaveLength(1)
    fail = false
    click(foot.querySelector('.chats-retry'))
    await settle()
    expect(foot.hidden).toBe(true)
    expect(rowKeys()).toContain(chatKey(1))
    // the foot line is for All with a query only
    fail = true
    click(chip('chats'))
    await settle()
    click(line().querySelector('.chats-refresh'))
    await settle()
    expect(foot.hidden).toBe(true)
    expect(line().querySelector('.chats-error')?.hidden).toBe(false)
  })
})

describe('B · a chat row', () => {
  it('at rest: the tool’s icon, the title, Live, one slot beside the main button, the project and the age', async () => {
    await boot()
    await openFindChats()
    const row = rowFor(1)!
    expect(row.dataset.findKey).toBe(chatKey(1))
    expect(row.dataset.cardId).toBeUndefined()
    const main = row.querySelector<HTMLButtonElement>(':scope > .find-row-main')!
    const icon = main.querySelector('.find-icon')!
    expect([icon.getAttribute('role'), icon.getAttribute('aria-label')]).toEqual(['img', 'Claude Code chat'])
    expect(rowFor(2, 'copilot')!.querySelector('.find-icon')!.getAttribute('aria-label')).toBe('Copilot chat')
    // the two tools are told apart by the glyph too, not only by the label
    expect(icon.innerHTML).not.toBe(rowFor(2, 'copilot')!.querySelector('.find-icon')!.innerHTML)
    expect([...main.children].map((el) => el.className)).toEqual([
      'find-icon', 'find-title', 'find-live', 'find-extra', 'find-slot-space', 'find-project', 'find-age',
    ])
    expect(main.querySelector('.find-live')?.textContent).toBe('Live')
    expect(rowFor(3)!.querySelector('.find-live')).toBeNull()
    expect(main.querySelector('.find-project-name')?.textContent).toBe('ledger')
    expect(main.querySelector('.find-age')?.textContent).toBe('1h')
    // the slot is the main button's sibling, so its own tab stop, right after it
    expect([...row.children].map((el) => el.className)).toEqual(['find-row-main', 'find-slot'])
    expect(row.querySelectorAll(':scope > .find-slot > button')).toHaveLength(1)
    expect(main.getAttribute('aria-expanded')).toBe('false')
  })

  it('holds Copy resume without the desktop bridge, and Resume with it, off and saying Checking… until main answers', async () => {
    let answer!: (value: unknown) => void
    const bridge = installBridge(new Promise((resolve) => { answer = resolve }))
    await boot()
    await openFindChats()
    const slot = slotOf(3)
    expect([slot.className, slot.textContent, slot.getAttribute('aria-disabled'), slot.title]).toEqual(['chats-resume', 'Resume', 'true', RESUME_CHECKING])
    click(slot)
    await settle()
    expect(bridge.resume).not.toHaveBeenCalled()
    answer({ available: true, terminal: 'terminal' })
    await settle()
    // the same node: the slot never swaps under a press when main answers
    expect(slotOf(3)).toBe(slot)
    expect([slot.getAttribute('aria-disabled'), slot.title]).toEqual([null, 'Resume in Terminal'])
  })

  it('draws Resume off with main’s reason when this window cannot resume', async () => {
    installBridge({ available: false, terminal: 'terminal' })
    await boot()
    await openFindChats()
    expect([slotOf(3).className, slotOf(3).getAttribute('aria-disabled'), slotOf(3).title]).toEqual(['chats-resume', 'true', RESUME_UNAVAILABLE])
  })

  it('holds Copy resume in the slot when there is no bridge', async () => {
    await boot()
    await openFindChats()
    expect([slotOf(3).className, slotOf(3).textContent]).toEqual(['chats-copy', 'Copy resume'])
  })

  it('opens in place on a press of its main button or Enter in the field, and Escape closes it', async () => {
    await boot()
    await openFindChats()
    await findFor('harbor')
    key(field(), 'Enter')
    await settle()
    const main = rowFor(3)!.querySelector<HTMLButtonElement>(':scope > .find-row-main')!
    expect(main.getAttribute('aria-expanded')).toBe('true')
    const body = rowFor(3)!.querySelector(':scope > .find-row-body')!
    expect(main.getAttribute('aria-controls')).toBe(body.id)
    expect([...rowFor(3)!.children].map((el) => el.className)).toEqual(['find-row-main', 'find-slot', 'find-row-body'])
    expect(body.querySelector('.chats-folder')?.textContent).toBe('~/dev/harbor')
    key(body.querySelector('.chats-folder')!, 'Escape')
    await settle()
    expect(rowFor(3)!.querySelector(':scope > .find-row-body')).toBeNull()
    expect(document.activeElement).toBe(rowFor(3)!.querySelector(':scope > .find-row-main'))
    // and opens again on a press
    await openChatRow(`claude:${uuid(3)}`)
  })

  it('opens a collapsed row when the answer to a press of its slot brings a note, so the note is seen', async () => {
    const bridge = installBridge()
    await boot()
    await openFindChats()
    expect(rowFor(3)!.querySelector(':scope > .find-row-main')!.getAttribute('aria-expanded')).toBe('false')
    click(slotOf(3))
    await settle()
    await settle()
    expect(bridge.resume).toHaveBeenCalledTimes(1)
    expect(rowFor(3)!.querySelector(':scope > .find-row-main')!.getAttribute('aria-expanded')).toBe('true')
    const note = rowFor(3)!.querySelector('.find-row-body .chats-resume-note')!
    expect([note.textContent, unreachableReason(note)]).toEqual(['Its folder no longer exists.', null])
    // a plain success opens nothing
    bridge.resume.mockResolvedValueOnce({ ok: true, terminal: 'terminal' })
    click(slotOf(2, 'copilot'))
    await settle()
    expect(rowFor(2, 'copilot')!.querySelector(':scope > .find-row-main')!.getAttribute('aria-expanded')).toBe('false')
    expect(slotOf(2, 'copilot').textContent).toBe('Opened in Terminal')
  })
})

describe('B · the read', () => {
  it('is made on entering Find under the 60-second rule, whatever the chip, and never from the poll', async () => {
    const { reads } = await boot()
    await pollTick()
    expect(reads).toEqual([])
    await openFindTab()
    expect(reads).toEqual(['/api/chats'])
    await pollTick()
    await pollTick()
    expect(reads).toHaveLength(1)
    click(chip('chats'))
    await settle()
    expect(reads).toHaveLength(1)
  })

  it('waits for a press that is down before a passive read moves the rows', async () => {
    let release: (() => void) | null = null
    const { index } = await boot({
      intercept: async (input, _init, next) => {
        if (String(input).startsWith('/api/chats') && release === null) await new Promise<void>((resolve) => { release = resolve })
        return await next()
      },
    })
    await openFindChats()
    // a first list, then the person leaves and comes back after a minute
    release!()
    await settle()
    release = null
    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()
    advanceClock(61_000)
    index.chats = index.chats.map((c) => (c.id === uuid(3) ? { ...c, lastActiveAt: ago(1) } : c))
    click(document.querySelector('.tab[data-tab="find"]'))
    await settle()
    const before = rowKeys()
    expect(before).toEqual([chatKey(1), chatKey(2, 'copilot'), chatKey(3)])
    const main = rowFor(2, 'copilot')!.querySelector(':scope > .find-row-main')!
    main.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    release!()
    await settle()
    // the entry's read landed under the press: the rows stay where they are
    expect(rowKeys()).toEqual(before)
    main.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    await settle()
    expect(rowKeys()).toEqual([chatKey(3), chatKey(1), chatKey(2, 'copilot')])
  })
})
