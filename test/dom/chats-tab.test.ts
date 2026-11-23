// @vitest-environment jsdom
// The chats (#586 PR 2), Find's Chats chip since UX pass, slice 4, step B: a list of Claude Code
// and Copilot CLI chats read from GET /api/chats only when Find is entered, on Refresh and on Show
// all. The real route runs over a fake chat index, so its hidden filter and ?all=1 are the server's
// own. Every press reaches its control as a person does, through Find. Every fixture is synthetic.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import type { ChatEntry, ChatIndex } from '../../src/chat-index.js'
import { insertItem } from '../../src/store.js'
import { TRUNCATED_TEXT } from '../../public/chats.js'
import {
  advanceClock, bootApp, changedPollTick, chatRowFor, click, findFor, freshDb, openChatRow, openFindChats, pollTick, repaint, settle, T0, useDomTest,
} from './harness.js'
import type { BootOptions } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
  Reflect.deleteProperty(navigator, 'clipboard')
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

// five in the default list, three hidden (one with no folder at all, which the index marks folder-gone)
function fixture(): ChatEntry[] {
  return [
    entry(4, { tool: 'copilot', title: 'Alpha notes', branch: 'docs' }),
    entry(1, { title: 'Fix the parser', lastActiveAt: ago(5), pr: { number: 7, repo: 'o/r', url: 'https://github.com/o/r/pull/7' } }),
    entry(2, { tool: 'copilot', title: 'how do I rename', titleAuto: true, project: 'beta', cwd: '/Users/tester/dev/beta', branch: 'feat/beta', live: true }),
    entry(3, { title: null, project: 'beta', cwd: '/Users/tester/dev/beta-docs', branch: null }),
    entry(5, { title: 'Gamma', project: 'gamma', cwd: '/Users/tester/dev/gamma' }),
    entry(6, { tool: 'copilot', title: 'Scratch', cwd: '/private/tmp/x', hidden: ['temp', 'empty'] }),
    entry(7, { title: 'Gone', cwd: '/Users/tester/gone', hidden: ['folder-gone', 'non-interactive'] }),
    entry(8, { title: 'Nowhere', cwd: null, hidden: ['folder-gone'] }),
  ]
}

interface Setup { chats?: ChatEntry[]; truncated?: boolean; intercept?: BootOptions['interceptFetch'] }

async function boot({ chats = fixture(), truncated = false, intercept }: Setup = {}) {
  db = freshDb()
  const index = { chats, truncated }
  const chatIndex: ChatIndex = {
    read: () => ({ chats: index.chats, truncated: index.truncated, work: { filesRead: 0, bytesRead: 0 } }),
    readCopilot: () => null,
    claudeDays: () => 21,
  }
  const reads: string[] = []
  await bootApp(db, {
    viewer: { chatIndex },
    interceptFetch: async (input, init, next) => {
      const url = String(input)
      if (url.startsWith('/api/chats')) reads.push(url)
      return intercept ? await intercept(input, init, next) : await next()
    },
  })
  return { reads, index }
}

const findPanel = () => document.getElementById('find') as HTMLElement
// the Chats line under the chips, drawn while the Chats chip is selected
const line = () => document.getElementById('findChats') as HTMLElement
const q = <T extends Element = HTMLElement>(sel: string) => line().querySelector<T>(sel)
const keys = () => [...document.querySelectorAll<HTMLElement>('#findList > .find-row[data-find-type="chat"]')].map((el) => el.dataset.findKey!.slice(5))
const rowFor = (n: number, tool = 'claude') => chatRowFor(`${tool}:${uuid(n)}`)
// a fact of an open row (tool, branch, folder, last active, live, reasons)
const cell = (n: number, name: string, tool = 'claude') => rowFor(n, tool)?.querySelector<HTMLElement>(`.find-row-body .chats-${name}`) ?? null
const openRow = (n: number, tool = 'claude') => openChatRow(`${tool}:${uuid(n)}`)
const titleOf = (n: number, tool = 'claude') => rowFor(n, tool)?.querySelector<HTMLElement>('.find-row-main .find-title') ?? null

async function openChats() {
  await openFindChats()
}
async function openTab(id: string) {
  click(document.querySelector(`.tab[data-tab="${id}"]`))
  await settle()
}

function press(key: string) {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

function stubClipboard() {
  const writeText = vi.fn(async (_text: string) => {})
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  return writeText
}

describe('Chats in Find (#586 PR 2; UX pass, slice 4, step B)', () => {
  it('has no tab of its own: G C opens Find with the Chats chip and the field focused', async () => {
    await boot()
    // step B: the Chats page folded into Find's fifth chip
    expect([...document.querySelectorAll<HTMLElement>('#tabs .tab')].map((t) => t.dataset.tab).slice(-2)).toEqual(['find', 'agent'])
    expect(document.querySelector('[data-tab="chats"], #chats')).toBeNull()
    // G C is "Find: Chats": no tile of its own, like G N and G H
    expect(document.querySelector('[data-shortcut="G C"]')).toBeNull()
    ;(document.activeElement as HTMLElement | null)?.blur()
    press('g')
    press('c')
    await settle()
    expect(findPanel().hidden).toBe(false)
    expect(document.getElementById('pageTitle')?.textContent).toBe('Find')
    expect(document.querySelector('[data-tab="find"]')!.getAttribute('aria-selected')).toBe('true')
    expect(document.querySelector('#find [data-find-chip="chats"]')!.getAttribute('aria-pressed')).toBe('true')
    expect(document.activeElement).toBe(document.getElementById('findQuery'))
    expect(line().hidden).toBe(false)
  })

  it('reads nothing until Find opens, and never from the poll', async () => {
    const { reads } = await boot()
    await pollTick()
    await pollTick()
    await pollTick()
    expect(reads).toEqual([])
    await openChats()
    expect(reads).toEqual(['/api/chats'])
    await pollTick()
    await pollTick()
    await pollTick()
    expect(reads).toHaveLength(1)
    // back within a minute: the list is kept
    await openTab('dashboard')
    await openTab('find')
    expect(reads).toHaveLength(1)
    // re-selecting the open tab reads nothing either
    await openTab('find')
    expect(reads).toHaveLength(1)
    advanceClock(61_000)
    await openTab('dashboard')
    await openTab('find')
    expect(reads).toHaveLength(2)
    click(q('.chats-refresh'))
    await settle()
    expect(reads).toHaveLength(3)
  })

  it('reads again when coming back from Settings after a minute', async () => {
    const { reads } = await boot()
    await openChats()
    click(document.getElementById('gear'))
    await settle()
    expect(findPanel().hidden).toBe(true)
    advanceClock(61_000)
    click(document.querySelector('.tab[data-tab="find"]'))
    await settle()
    expect(findPanel().hidden).toBe(false)
    expect(reads).toHaveLength(2)
  })

  it('sorts by last active and shows the facts in an open row', async () => {
    await boot()
    await openChats()
    expect(keys()).toEqual([`claude:${uuid(1)}`, `copilot:${uuid(2)}`, `claude:${uuid(3)}`, `copilot:${uuid(4)}`, `claude:${uuid(5)}`])
    // at rest: the title, the project and the age
    expect(titleOf(1)?.textContent).toBe('Fix the parser')
    expect(rowFor(1)!.querySelector('.find-project-name')?.textContent).toBe('alpha')
    expect(rowFor(1)!.querySelector('.find-age')?.textContent).toBe('5m')
    await openRow(1)
    await openRow(2, 'copilot')
    expect([...rowFor(1)!.querySelectorAll<HTMLElement>('.chats-facts dt')].filter((dt) => !dt.hidden).map((dt) => dt.textContent))
      .toEqual(['Tool', 'Branch', 'Folder', 'Last active'])
    expect(cell(1, 'tool')?.textContent).toBe('Claude Code')
    expect(cell(2, 'tool', 'copilot')?.textContent).toBe('Copilot')
    expect(cell(1, 'folder')?.textContent).toBe('~/dev/alpha')
    expect(cell(1, 'folder')?.title).toBe('/Users/tester/dev/alpha')
    // the exact local time, with how long ago as its title
    expect(cell(1, 'active')?.textContent).toBe(new Date(ago(5)).toLocaleString())
    expect(cell(1, 'active')?.title).toBe('5m ago')
    expect(cell(1, 'branch')?.querySelector('.chats-branch-text')?.textContent).toBe('main')
  })

  it('filters by the field and by tool, and keeps the field through a poll', async () => {
    const { reads } = await boot()
    await openChats()
    await findFor('BETA')
    expect(keys()).toEqual([`copilot:${uuid(2)}`, `claude:${uuid(3)}`])

    const copilot = q('[data-chats-tool="copilot"]')!
    click(copilot)
    await settle()
    expect(keys()).toEqual([`copilot:${uuid(2)}`])
    expect([copilot.getAttribute('aria-pressed'), copilot.classList.contains('active')]).toEqual(['true', true])
    const allTools = q('[data-chats-tool="all"]')!
    expect([allTools.getAttribute('aria-pressed'), allTools.classList.contains('active')]).toEqual(['false', false])
    expect(q('[role="group"]')?.getAttribute('aria-label')).toBe('Tool')

    // the project select is dropped on purpose: the field matches project names
    expect(line().querySelector('select')).toBeNull()
    await findFor('alpha')
    expect(keys()).toEqual([`copilot:${uuid(4)}`])

    // a poll that paints keeps the field, its value and its focus, and reads nothing
    const box = document.getElementById('findQuery') as HTMLInputElement
    box.focus()
    await findFor('notes')
    await changedPollTick(db!)
    expect(document.getElementById('findQuery')).toBe(box)
    expect([box.value, document.activeElement]).toEqual(['notes', box])
    expect(keys()).toEqual([`copilot:${uuid(4)}`])
    expect(reads).toHaveLength(1)
  })

  it('Show all reads ?all=1 and tags each hidden chat with its reasons', async () => {
    const { reads } = await boot()
    await openChats()
    expect(q('.chats-all-label')?.textContent).toBe('Show all (3 hidden)')
    expect(rowFor(7)).toBeNull()
    const toggle = q<HTMLInputElement>('.chats-all input[role="switch"]')!
    click(toggle)
    await settle()
    expect(reads.at(-1)).toBe('/api/chats?all=1')
    expect(keys()).toHaveLength(8)
    const reasons = async (n: number, tool = 'claude') => {
      await openRow(n, tool)
      return [...rowFor(n, tool)!.querySelectorAll('.chats-reason')].map((el) => el.textContent)
    }
    expect(await reasons(6, 'copilot')).toEqual(['Temp folder', 'Empty'])
    expect(await reasons(7)).toEqual(['Folder gone', 'Non-interactive'])
    expect(await reasons(8)).toEqual(['Folder gone'])
    expect(await reasons(1)).toEqual([])
    expect(rowFor(7)!.querySelector('.chats-reason')?.classList.contains('chip-neutral')).toBe(true)
    // the count stays visible with the switch on
    expect(q('.chats-all-label')?.textContent).toBe('Show all (3 hidden)')
    click(q('.chats-all input'))
    await settle()
    expect(reads.at(-1)).toBe('/api/chats')
    expect(keys()).toHaveLength(5)
  })

  it('copies the resume command, and disables Copy for a chat it cannot resume', async () => {
    const writeText = stubClipboard()
    await boot()
    await openChats()
    // with no desktop bridge, Copy resume is the row's one slot
    const claude = rowFor(1)!.querySelector<HTMLButtonElement>('.find-slot .chats-copy')!
    // the visible text is the accessible name, so the confirmation is announced
    expect([claude.textContent, claude.hasAttribute('aria-label')]).toEqual(['Copy resume', false])
    expect(claude.title).toBe(`cd '/Users/tester/dev/alpha' && claude --resume ${uuid(1)}`)
    click(claude)
    await settle()
    expect(writeText).toHaveBeenLastCalledWith(`cd '/Users/tester/dev/alpha' && claude --resume ${uuid(1)}`)
    expect(claude.textContent).toBe('Copied')
    // a repaint inside the confirmation, from render() or the list, does not cut it short
    await repaint()
    await findFor('parser')
    await findFor('')
    expect(claude.isConnected).toBe(true)
    expect(claude.textContent).toBe('Copied')
    await vi.advanceTimersByTimeAsync(1500)
    expect(claude.textContent).toBe('Copy resume')

    // a live chat still copies; its title's first line is exactly what is copied
    const live = rowFor(2, 'copilot')!.querySelector<HTMLButtonElement>('.chats-copy')!
    click(live)
    await settle()
    expect(writeText).toHaveBeenLastCalledWith(`cd '/Users/tester/dev/beta' && copilot --resume=${uuid(2)}`)
    expect(live.title.split('\n')).toEqual([writeText.mock.calls.at(-1)![0], 'This chat is live in another process; resuming it opens a second copy.'])

    click(q('.chats-all input'))
    await settle()
    const calls = writeText.mock.calls.length
    const gone = rowFor(7)!.querySelector<HTMLButtonElement>('.chats-copy')!
    expect([gone.getAttribute('aria-disabled'), gone.title]).toEqual(['true', "The chat's folder no longer exists, so it cannot be resumed there."])
    click(gone)
    await settle()
    const nowhere = rowFor(8)!.querySelector<HTMLButtonElement>('.chats-copy')!
    expect([nowhere.getAttribute('aria-disabled'), nowhere.title]).toEqual(['true', "The chat's files name no folder to resume in."])
    click(nowhere)
    await settle()
    expect(writeText).toHaveBeenCalledTimes(calls)
    expect([gone.textContent, nowhere.textContent]).toEqual(['Copy resume', 'Copy resume'])
    expect(claude.hasAttribute('aria-disabled')).toBe(false)
  })

  it('marks only the live chat Live', async () => {
    await boot()
    await openChats()
    expect([...document.querySelectorAll('#findList .find-live')].map((el) => el.closest<HTMLElement>('.find-row')?.dataset.findKey))
      .toEqual([`chat:copilot:${uuid(2)}`])
    await openRow(2, 'copilot')
    await openRow(1)
    expect(cell(2, 'live', 'copilot')?.textContent).toBe('Live')
    expect([...document.querySelectorAll('#findList .chip.chats-live')].map((el) => el.closest<HTMLElement>('.find-row')?.dataset.findKey))
      .toEqual([`chat:copilot:${uuid(2)}`])
    expect([cell(1, 'live')?.textContent, cell(1, 'live')?.hidden]).toEqual(['', true])
  })

  it('states the retention period, and says when the list is incomplete', async () => {
    const { index } = await boot()
    await openChats()
    // said once, after the list (the foot), not in the line under the chips
    expect(q('.chats-retention')).toBeNull()
    const foot = document.getElementById('findChatsFoot') as HTMLElement
    const retention = foot.querySelector<HTMLElement>('.chats-retention')
    expect(retention?.textContent).toBe('Claude Code deletes chats that have been untouched for 21 days. Agent Inbox does not copy them.')
    expect([foot.hidden, retention?.hidden]).toEqual([false, false])
    expect(foot.compareDocumentPosition(document.getElementById('findList')!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    expect(q('.chats-truncated')?.hidden).toBe(true)
    index.truncated = true
    click(q('.chats-refresh'))
    await settle()
    expect(q('.chats-truncated')?.hidden).toBe(false)
    expect(q('.chats-truncated')?.textContent).toBe(TRUNCATED_TEXT)
  })

  it('shows an automatic or missing title quietly, and a typed one plainly', async () => {
    await boot()
    await openChats()
    const auto = titleOf(2, 'copilot')!
    expect([auto.textContent, auto.classList.contains('chats-quiet'), auto.getAttribute('title')])
      .toEqual(['how do I rename', true, "how do I rename\nCopilot's automatic name: the opening of the chat's first prompt"])
    const typed = titleOf(1)!
    expect([typed.classList.contains('chats-quiet'), typed.getAttribute('title')]).toEqual([false, 'Fix the parser'])
    const untitled = titleOf(3)!
    expect([untitled.textContent, untitled.classList.contains('chats-quiet')]).toEqual(['Untitled', true])
  })

  it('shows loading, error with Retry, and the empty states', async () => {
    let fail = true
    let hold: (() => void) | null = null
    const { index } = await boot({
      intercept: async (input, _init, next) => {
        if (!String(input).startsWith('/api/chats')) return await next()
        if (hold === null && fail) await new Promise<void>((resolve) => { hold = resolve })
        return fail ? new Response('boom', { status: 500 }) : await next()
      },
    })
    await openChats()
    expect([q('.chats-state')?.hidden, q('.chats-state')?.textContent]).toEqual([false, 'Loading chats…'])
    expect([q('.chats-refresh')?.textContent, q('.chats-refresh')?.getAttribute('aria-disabled')]).toEqual(['Refreshing…', 'true'])
    hold!()
    await settle()
    expect(q('.chats-error')?.hidden).toBe(false)
    expect(q('.chats-error span')?.textContent).toBe("Couldn't load chats (500).")
    expect(keys()).toEqual([])
    expect(q('.chats-state')?.hidden).toBe(true)
    expect(q('.chats-refresh')?.hasAttribute('aria-disabled')).toBe(false)

    fail = false
    click(q('.chats-retry'))
    await settle()
    expect(q('.chats-error')?.hidden).toBe(true)
    expect(keys()).toHaveLength(5)

    // a failed refresh keeps the good list
    fail = true
    click(q('.chats-refresh'))
    await settle()
    expect(keys()).toHaveLength(5)
    expect(q('.chats-error span')?.textContent).toBe("Couldn't refresh chats (500). Showing the last list.")

    fail = false
    await findFor('no such chat')
    expect([q('.chats-state')?.textContent, keys()]).toEqual(['No chats match the search and filters.', []])

    await findFor('')
    index.chats = []
    click(q('.chats-refresh'))
    await settle()
    expect([q('.chats-state')?.textContent, q('.chats-state')?.hidden]).toEqual(['No chats found.', false])
  })

  it('says how many are hidden when the default list is empty', async () => {
    await boot({ chats: fixture().filter((c) => c.hidden.length) })
    await openChats()
    expect(q('.chats-state')?.textContent).toBe('No chats found. 3 hidden chats: turn on Show all.')
  })

  it('keeps chat text that looks like HTML as text', async () => {
    await boot({
      chats: [entry(1, {
        title: '<img src=x onerror="x()">', project: '<b>p</b>', branch: '<script>x()</script>', cwd: '/Users/tester/<i>dir</i>',
        pr: { number: 7, repo: 'o/r', url: 'https://github.com/o/r/pull/7' },
      }), entry(2, { pr: { number: 1, repo: 'o/r', url: 'javascript:alert(1)' } })],
    })
    await openChats()
    await openRow(1)
    await openRow(2)
    expect(titleOf(1)?.textContent).toBe('<img src=x onerror="x()">')
    expect(rowFor(1)!.querySelector('.find-project-name')?.textContent).toBe('<b>p</b>')
    expect(cell(1, 'branch')!.querySelector('.chats-branch-text')?.textContent).toBe('<script>x()</script>')
    expect(cell(1, 'folder')?.textContent).toBe('~/<i>dir</i>')
    for (const tag of ['img', 'b', 'script', 'i']) expect(findPanel().querySelector(tag), tag).toBeNull()
    const links = cell(1, 'branch')!.querySelectorAll<HTMLAnchorElement>('a')
    expect(links).toHaveLength(1)
    expect([links[0]!.className, links[0]!.dataset.linkKind, links[0]!.getAttribute('href'), links[0]!.textContent])
      .toEqual(['structured-link', 'pr', 'https://github.com/o/r/pull/7', '#7'])
    expect(cell(2, 'branch')!.querySelector('a')).toBeNull()
  })

  it('keeps the other rows and Home’s nodes when its own read settles', async () => {
    // a note and the chats share one All list for "alpha"; the first chats read fails, then Retry reads
    let failing = true
    const { reads } = await boot({
      intercept: async (input, _init, next) => (failing && String(input).startsWith('/api/chats') ? new Response('x', { status: 500 }) : await next()),
    })
    const noteId = insertItem(db!, { project: 'alpha', stream: 'main', agent: 'claude-code', kind: 'note', title: 'Alpha ran twice' })
    await changedPollTick(db!)
    await openTab('find')
    await findFor('alpha')
    const noteRow = () => document.querySelector(`#findList > [data-find-key="item:${noteId}"]`)
    const note = noteRow()
    const dashboard = document.querySelector('#dashboard .dashboard')!.firstElementChild
    expect(note).not.toBeNull()
    expect(dashboard).not.toBeNull()
    expect(document.querySelector('#findList > .find-row[data-find-type="chat"]')).toBeNull()
    failing = false
    click(document.querySelector('#findChatsFoot .chats-retry'))
    await settle()
    await settle()
    expect(reads).toHaveLength(2)
    // the read landed: chat rows are listed beside the note, and neither it nor Home was rebuilt
    expect(document.querySelectorAll('#findList > .find-row[data-find-type="chat"]').length).toBeGreaterThan(0)
    expect(noteRow()).toBe(note)
    expect(document.querySelector('#dashboard .dashboard')!.firstElementChild).toBe(dashboard)
  })

  it('applies only the newest read when Show all changes mid-read', async () => {
    const held: Array<() => void> = []
    await boot({
      intercept: async (input, _init, next) => {
        if (String(input) === '/api/chats') await new Promise<void>((resolve) => { held.push(resolve) })
        return await next()
      },
    })
    await openChats()
    click(q<HTMLInputElement>('.chats-all input'))
    await settle()
    expect(keys()).toHaveLength(8)
    held.forEach((release) => release())
    await settle()
    expect(keys()).toHaveLength(8)
    expect(q<HTMLInputElement>('.chats-all input')!.checked).toBe(true)
  })

  it('keeps a text selection in a row that a Refresh moves', async () => {
    const { index } = await boot()
    await openChats()
    const text = titleOf(4, 'copilot')!.firstChild!
    // a person selecting with the pointer takes focus out of Find's field, which owns the caret
    // while it is focused (selection.js); setBaseAndExtent alone does not
    ;(document.getElementById('findQuery') as HTMLInputElement).blur()
    const selection = document.getSelection()!
    selection.setBaseAndExtent(text, 0, text, 5)
    expect(selection.toString()).toBe('Alpha')
    // the selected chat becomes the newest, so its row moves to the top
    index.chats = index.chats.map((c) => (c.id === uuid(4) ? { ...c, lastActiveAt: ago(1) } : c))
    click(q('.chats-refresh'))
    await settle()
    expect(keys()[0]).toBe(`copilot:${uuid(4)}`)
    expect(document.getSelection()!.toString()).toBe('Alpha')
  })

  it('holds a repaint that would remove rows while a press is down in the list', async () => {
    const writeText = stubClipboard()
    await boot()
    await openChats()
    click(q('.chats-all input'))
    await settle()
    const gone = rowFor(6, 'copilot')!.querySelector<HTMLButtonElement>('.chats-copy')!
    gone.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    click(q('.chats-all input'))
    await settle()
    // the switch read the default list, but the row stays until the press ends
    expect(document.contains(gone)).toBe(true)
    gone.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    click(gone)
    await settle()
    expect(writeText).toHaveBeenCalledWith(`cd '/private/tmp/x' && copilot --resume=${uuid(6)}`)
    expect(document.contains(gone)).toBe(false)
    expect(keys()).toHaveLength(5)
  })
})
