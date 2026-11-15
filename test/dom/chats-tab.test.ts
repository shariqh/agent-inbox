// @vitest-environment jsdom
// The Chats tab (#586 PR 2): a list of Claude Code and Copilot CLI chats read from
// GET /api/chats only when the tab opens, on Refresh and on Show all. The real
// route runs over a fake chat index, so its hidden filter and ?all=1 are the
// server's own. Every fixture is synthetic.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem } from '../../src/store.js'
import type { ChatEntry, ChatIndex } from '../../src/chat-index.js'
import { TRUNCATED_TEXT } from '../../public/chats.js'
import {
  advanceClock, bootApp, changedPollTick, click, freshDb, pollTick, repaint, settle, T0, type, useDomTest,
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

const panel = () => document.getElementById('chats') as HTMLElement
const q = <T extends Element = HTMLElement>(sel: string) => panel().querySelector<T>(sel)
const keys = () => [...panel().querySelectorAll<HTMLElement>('tbody tr')].map((tr) => tr.dataset.chatKey)
const rowFor = (n: number, tool = 'claude') => q(`tr[data-chat-key="${tool}:${uuid(n)}"]`)
const cell = (n: number, name: string, tool = 'claude') => rowFor(n, tool)?.querySelector<HTMLElement>(`.chats-${name}`) ?? null

async function openChats() {
  click(document.querySelector('.tab[data-tab="chats"]'))
  await settle()
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

describe('Chats tab (#586 PR 2)', () => {
  it('sits after History, with G C', async () => {
    await boot()
    expect([...document.querySelectorAll<HTMLElement>('#tabs .tab')].map((t) => t.dataset.tab).slice(-3)).toEqual(['done', 'chats', 'agent'])
    const tab = document.querySelector('[data-tab="chats"]')!
    expect(tab.getAttribute('data-shortcut')).toBe('G C')
    expect(tab.querySelector('.tab-count')).toBeNull()
    ;(document.activeElement as HTMLElement | null)?.blur()
    press('g')
    press('c')
    await settle()
    expect(panel().hidden).toBe(false)
    expect(document.getElementById('pageTitle')?.textContent).toBe('Chats')
    expect(tab.getAttribute('aria-selected')).toBe('true')
  })

  it('reads nothing until the tab opens, and never from the poll', async () => {
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
    await openTab('done')
    await openTab('chats')
    expect(reads).toHaveLength(1)
    // re-selecting the open tab reads nothing either
    await openTab('chats')
    expect(reads).toHaveLength(1)
    advanceClock(61_000)
    await openTab('done')
    await openTab('chats')
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
    expect(panel().hidden).toBe(true)
    advanceClock(61_000)
    click(document.querySelector('.tab[data-tab="chats"]'))
    await settle()
    expect(panel().hidden).toBe(false)
    expect(reads).toHaveLength(2)
  })

  it('sorts by last active and shows the columns', async () => {
    await boot()
    await openChats()
    expect(keys()).toEqual([`claude:${uuid(1)}`, `copilot:${uuid(2)}`, `claude:${uuid(3)}`, `copilot:${uuid(4)}`, `claude:${uuid(5)}`])
    expect([...panel().querySelectorAll('thead th')].map((th) => th.textContent))
      .toEqual(['Tool', 'Title', 'Project', 'Branch', 'Folder', 'Last active', 'Live', 'Actions'])
    expect(cell(1, 'tool')?.textContent).toBe('Claude Code')
    expect(cell(2, 'tool', 'copilot')?.textContent).toBe('Copilot')
    expect(cell(1, 'folder')?.textContent).toBe('~/dev/alpha')
    expect(cell(1, 'folder')?.title).toBe('/Users/tester/dev/alpha')
    expect(cell(1, 'active')?.textContent).toBe('5m ago')
    expect(cell(1, 'active')?.title).toBe(new Date(ago(5)).toLocaleString())
    expect(cell(1, 'project')?.textContent).toBe('alpha')
    expect(cell(1, 'branch')?.querySelector('.chats-branch-text')?.textContent).toBe('main')
    expect(q('.chats-count')?.textContent).toBe('5 chats')
  })

  it('searches and filters by tool and project, and states the shown count', async () => {
    const { reads } = await boot()
    await openChats()
    const search = q<HTMLInputElement>('.chats-search')!
    expect(search.getAttribute('aria-label')).toBe('Search chats')
    search.focus()
    type(search, 'BETA')
    await settle()
    expect(keys()).toEqual([`copilot:${uuid(2)}`, `claude:${uuid(3)}`])
    expect(q('.chats-count')?.textContent).toBe('Showing 2 of 5 chats')

    const copilot = q('[data-chats-tool="copilot"]')!
    click(copilot)
    await settle()
    expect(keys()).toEqual([`copilot:${uuid(2)}`])
    expect([copilot.getAttribute('aria-pressed'), copilot.classList.contains('active')]).toEqual(['true', true])
    const allTools = q('[data-chats-tool="all"]')!
    expect([allTools.getAttribute('aria-pressed'), allTools.classList.contains('active')]).toEqual(['false', false])
    expect(q('.chats-count')?.textContent).toBe('Showing 1 of 5 chats')

    const select = q<HTMLSelectElement>('.chats-project select')!
    expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([['', 'All projects'], ['alpha', 'alpha'], ['beta', 'beta'], ['gamma', 'gamma']])
    type(q<HTMLInputElement>('.chats-search'), '')
    select.value = 'alpha'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    expect(keys()).toEqual([`copilot:${uuid(4)}`])

    // a poll that paints keeps the box, its value and its focus, and reads nothing
    const box = q<HTMLInputElement>('.chats-search')!
    box.focus()
    type(box, 'notes')
    await settle()
    await changedPollTick(db!)
    expect(q('.chats-search')).toBe(box)
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
    toggle.click()
    await settle()
    expect(reads.at(-1)).toBe('/api/chats?all=1')
    expect(keys()).toHaveLength(8)
    const reasons = (n: number, tool = 'claude') => [...rowFor(n, tool)!.querySelectorAll('.chats-reason')].map((el) => el.textContent)
    expect(reasons(6, 'copilot')).toEqual(['Temp folder', 'Empty'])
    expect(reasons(7)).toEqual(['Folder gone', 'Non-interactive'])
    expect(reasons(8)).toEqual(['Folder gone'])
    expect(reasons(1)).toEqual([])
    expect(rowFor(7)!.querySelector('.chats-reason')?.classList.contains('chip-neutral')).toBe(true)
    // the count stays visible with the switch on
    expect(q('.chats-all-label')?.textContent).toBe('Show all (3 hidden)')
    q<HTMLInputElement>('.chats-all input')!.click()
    await settle()
    expect(reads.at(-1)).toBe('/api/chats')
    expect(keys()).toHaveLength(5)
  })

  it('copies the resume command, and disables Copy for a chat it cannot resume', async () => {
    const writeText = stubClipboard()
    await boot()
    await openChats()
    const claude = cell(1, 'actions')!.querySelector<HTMLButtonElement>('.chats-copy')!
    // the visible text is the accessible name, so the confirmation is announced
    expect([claude.textContent, claude.hasAttribute('aria-label')]).toEqual(['Copy resume', false])
    expect(claude.title).toBe(`cd '/Users/tester/dev/alpha' && claude --resume ${uuid(1)}`)
    click(claude)
    await settle()
    expect(writeText).toHaveBeenLastCalledWith(`cd '/Users/tester/dev/alpha' && claude --resume ${uuid(1)}`)
    expect(claude.textContent).toBe('Copied')
    // a repaint inside the confirmation, from render() or the region, does not cut it short
    await repaint()
    type(q<HTMLInputElement>('.chats-search'), 'parser')
    await settle()
    type(q<HTMLInputElement>('.chats-search'), '')
    await settle()
    expect(claude.textContent).toBe('Copied')
    await vi.advanceTimersByTimeAsync(1500)
    expect(claude.textContent).toBe('Copy resume')

    // a live chat still copies; its title's first line is exactly what is copied
    const live = cell(2, 'actions', 'copilot')!.querySelector<HTMLButtonElement>('.chats-copy')!
    click(live)
    await settle()
    expect(writeText).toHaveBeenLastCalledWith(`cd '/Users/tester/dev/beta' && copilot --resume=${uuid(2)}`)
    expect(live.title.split('\n')).toEqual([writeText.mock.calls.at(-1)![0], 'This chat is live in another process; resuming it opens a second copy.'])

    q<HTMLInputElement>('.chats-all input')!.click()
    await settle()
    const calls = writeText.mock.calls.length
    const gone = cell(7, 'actions')!.querySelector<HTMLButtonElement>('.chats-copy')!
    expect([gone.getAttribute('aria-disabled'), gone.title]).toEqual(['true', "The chat's folder no longer exists, so it cannot be resumed there."])
    click(gone)
    await settle()
    const nowhere = cell(8, 'actions')!.querySelector<HTMLButtonElement>('.chats-copy')!
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
    expect([...panel().querySelectorAll('.chip.chats-live')].map((el) => el.closest('tr')?.dataset.chatKey)).toEqual([`copilot:${uuid(2)}`])
    expect(cell(2, 'live', 'copilot')?.textContent).toBe('Live')
    expect(cell(1, 'live')?.textContent).toBe('')
  })

  it('states the retention period, and says when the list is incomplete', async () => {
    const { index } = await boot()
    await openChats()
    expect(q('.chats-retention')?.textContent).toBe('Claude Code deletes chats that have been untouched for 21 days. Agent Inbox does not copy them.')
    expect(q('.chats-retention')?.hidden).toBe(false)
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
    const auto = cell(2, 'title', 'copilot')!.querySelector('.chats-title-text')!
    expect([auto.textContent, auto.classList.contains('chats-quiet'), auto.getAttribute('title')])
      .toEqual(['how do I rename', true, "Copilot's automatic name: the opening of the chat's first prompt"])
    const typed = cell(1, 'title')!.querySelector('.chats-title-text')!
    expect([typed.classList.contains('chats-quiet'), typed.hasAttribute('title')]).toEqual([false, false])
    const untitled = cell(3, 'title')!.querySelector('.chats-title-text')!
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
    expect(q('.chats-table')?.hidden).toBe(true)
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
    type(q<HTMLInputElement>('.chats-search'), 'no such chat')
    await settle()
    expect([q('.chats-state')?.textContent, q('.chats-table')?.hidden]).toEqual(['No chats match the search and filters.', true])

    type(q<HTMLInputElement>('.chats-search'), '')
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
    expect(cell(1, 'title')!.querySelector('.chats-title-text')?.textContent).toBe('<img src=x onerror="x()">')
    expect(cell(1, 'project')?.textContent).toBe('<b>p</b>')
    expect(cell(1, 'branch')!.querySelector('.chats-branch-text')?.textContent).toBe('<script>x()</script>')
    expect(cell(1, 'folder')?.textContent).toBe('~/<i>dir</i>')
    for (const tag of ['img', 'b', 'script', 'i']) expect(panel().querySelector(tag), tag).toBeNull()
    const links = cell(1, 'branch')!.querySelectorAll<HTMLAnchorElement>('a')
    expect(links).toHaveLength(1)
    expect([links[0]!.className, links[0]!.dataset.linkKind, links[0]!.getAttribute('href'), links[0]!.textContent])
      .toEqual(['structured-link', 'pr', 'https://github.com/o/r/pull/7', '#7'])
    expect(cell(2, 'branch')!.querySelector('a')).toBeNull()
  })

  it('paints only Chats when its own read settles', async () => {
    const { reads } = await boot()
    insertItem(db!, { project: 'alpha', stream: 'main', agent: 'copilot', kind: 'note', title: 'A note' })
    await pollTick()
    await openTab('notes')
    await openChats()
    const note = document.querySelector('#notes .groups')!.firstElementChild
    const dashboard = document.querySelector('#dashboard .dashboard')!.firstElementChild
    expect(note).not.toBeNull()
    click(q('.chats-refresh'))
    await settle()
    expect(reads).toHaveLength(2)
    expect(document.querySelector('#notes .groups')!.firstElementChild).toBe(note)
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
    q<HTMLInputElement>('.chats-all input')!.click()
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
    const text = cell(4, 'title', 'copilot')!.querySelector('.chats-title-text')!.firstChild!
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

  it('holds a repaint that would remove rows while a press is down in the region', async () => {
    const writeText = stubClipboard()
    await boot()
    await openChats()
    q<HTMLInputElement>('.chats-all input')!.click()
    await settle()
    const gone = cell(6, 'actions', 'copilot')!.querySelector<HTMLButtonElement>('.chats-copy')!
    gone.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    q<HTMLInputElement>('.chats-all input')!.click()
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
