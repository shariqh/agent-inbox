// @vitest-environment jsdom
// UX pass, slice 4, step A: Find replaces Notes and History. One field, four chips (All,
// Answers, Notes, Plans) and one list whose rows open in place or go where the thing lives.
// Every press and key here is a real event through the harness, and what a person can
// reach is asserted explicitly: the test DOM ignores CSS and lets code reach into hidden
// or closed containers, a real browser does not.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import {
  closeProject, dismissItem, getItem, insertItem, replyItem, resolveItem, upsertBoard,
} from '../../src/store.js'
import {
  advanceClock, bootApp, buttonLabelled, changedPollTick, click, findFor, freshDb, navigateToHash, noteEditor, pollTick, settle,
  tabCount, type, unreachableReason, useDomTest,
} from './harness.js'
import type { BootOptions } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
})

const ATLAS = { project: 'atlas', stream: 'main', agent: 'claude' } as const
const LEDGER = { project: 'ledger', stream: 'main', agent: 'copilot' } as const

const field = () => document.getElementById('findQuery') as HTMLInputElement
const findRows = () => [...document.querySelectorAll<HTMLElement>('#findList > .find-row')]
const findKeys = () => findRows().map((el) => el.dataset.findKey)
const findTitles = () => findRows().map((el) => el.querySelector('.find-title')?.textContent ?? '')
const findRowEl = (key: string) => document.querySelector<HTMLElement>(`#findList > .find-row[data-find-key="${key}"]`)
const mainOf = (key: string) => findRowEl(key)?.querySelector<HTMLButtonElement>(':scope > .find-row-main') ?? null
const chip = (name: string) => document.querySelector<HTMLButtonElement>(`#find [data-find-chip="${name}"]`)
const status = () => {
  const el = document.getElementById('findStatus')!
  return el.hidden ? '' : el.textContent ?? ''
}
const foot = () => document.getElementById('findFoot')!

function key(target: EventTarget, keyName: string, init: KeyboardEventInit = {}) {
  const event = new window.KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

async function openFindTab() {
  click(document.querySelector('.tab[data-tab="find"]'))
  await settle()
}

async function pressChip(name: string) {
  click(chip(name))
  await settle()
}

async function pressRow(k: string) {
  const main = mainOf(k)
  expect(main && unreachableReason(main), 'the row is reachable').toBeNull()
  click(main)
  await settle()
}

async function goKey(second: string) {
  key(document.body, 'g')
  key(document.body, second)
  await settle()
}

// A small hub: an answered open ask, an answered closed ask, notes open and closed, a
// milestone, a plan, an open unanswered ask and a swept one.
function seed(d: Database.Database) {
  advanceClock()
  const swept = insertItem(d, { ...ATLAS, kind: 'question', title: 'Swept permission prompt' })
  dismissItem(d, swept)
  advanceClock()
  const closedAsk = insertItem(d, { ...LEDGER, kind: 'question', title: 'Keep 30 or 90 days of backups?', options: [{ label: '30 days' }, { label: '90 days' }] })
  replyItem(d, closedAsk, '30 days')
  resolveItem(d, closedAsk, 'Retention set to 30 days.')
  advanceClock()
  const oldNote = insertItem(d, { ...ATLAS, kind: 'note', title: 'Restore drill passed', detail: 'All five steps ran clean.' })
  resolveItem(d, oldNote)
  advanceClock()
  const milestone = insertItem(d, { ...ATLAS, kind: 'done', title: 'Shipped the exporter', next_step: 'No action' })
  advanceClock()
  upsertBoard(d, { ...LEDGER, title: 'Backups and restore drill', rows: [
    { label: 'Write the job', status: 'done' }, { label: 'Run the drill', status: 'partial' },
  ] })
  advanceClock()
  const openAsk = insertItem(d, { ...ATLAS, kind: 'question', title: 'Ship the backup job?' })
  advanceClock()
  const answered = insertItem(d, { ...ATLAS, kind: 'question', title: 'Where should staging live?', options: [{ label: 'Managed' }, { label: 'Self-hosted' }] })
  replyItem(d, answered, 'Managed')
  advanceClock()
  const note = insertItem(d, { ...ATLAS, kind: 'note', title: 'Backups now run nightly at 02:00', detail: 'The old cron job was removed.' })
  return { swept, closedAsk, oldNote, milestone, openAsk, answered, note }
}

describe('A1 · one tab, find', () => {
  it('sits after Plans with a magnifier, counts unread notes, and hides its heading but keeps it', async () => {
    db = freshDb()
    seed(db)
    await bootApp(db)
    const tabs = [...document.querySelectorAll<HTMLElement>('#tabs .tab')].map((t) => t.dataset.tab)
    expect(tabs.indexOf('find')).toBe(tabs.indexOf('boards') + 1)
    const tab = document.querySelector('.tab[data-tab="find"]')!
    expect(tab.querySelector('.tab-name')?.textContent).toBe('Find')
    expect(tab.querySelector('svg circle')).not.toBeNull()
    expect(tabCount('find')).toBe('1')
    await openFindTab()
    expect(document.getElementById('find')!.hidden).toBe(false)
    const heading = document.getElementById('pageTitle')!
    expect(heading.textContent).toBe('Find')
    expect(heading.classList.contains('visually-hidden')).toBe(true)
  })

  it('G F opens Find on the field; G N and G H open it with a chip, the query cleared, the list focused', async () => {
    db = freshDb()
    seed(db)
    await bootApp(db)
    await goKey('f')
    expect(document.getElementById('find')!.hidden).toBe(false)
    expect(document.activeElement).toBe(field())
    await findFor('backup')
    field().blur()

    await goKey('n')
    expect(chip('notes')?.getAttribute('aria-pressed')).toBe('true')
    expect(field().value).toBe('')
    expect(document.activeElement).toBe(document.getElementById('findList'))
    expect(findKeys().every((k) => findRowEl(k!)?.dataset.findType === 'note')).toBe(true)

    await goKey('h')
    expect(chip('all')?.getAttribute('aria-pressed')).toBe('true')
    expect(document.activeElement).toBe(document.getElementById('findList'))
  })

  it('puts the key tile on the Find tab only, and says the corrected key list', async () => {
    db = freshDb()
    await bootApp(db)
    click(document.getElementById('keyboardHints'))
    await settle()
    expect(document.querySelector('.tab[data-tab="find"]')?.getAttribute('data-shortcut')).toBe('G F')
    expect(document.querySelector('[data-shortcut="G N"]')).toBeNull()
    expect(document.querySelector('[data-shortcut="G H"]')).toBeNull()
    click(document.getElementById('keyboardHints'))
    await settle()
    key(document.body, 'g')
    const spoken = [...document.querySelectorAll('[aria-live]')].map((el) => el.textContent).join(' ')
    expect(spoken).toContain('F Find, N Find: Notes, H Find: All, C Chats')
    key(document.body, 'Escape')
  })
})

describe('A2 · the field', () => {
  it('is static markup that takes focus on entry, but not on an entry by touch', async () => {
    db = freshDb()
    seed(db)
    await bootApp(db)
    const input = field()
    document.querySelector('.tab[data-tab="find"]')!.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }))
    await openFindTab()
    expect(document.activeElement).not.toBe(input)
    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()
    document.querySelector('.tab[data-tab="find"]')!.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }))
    await openFindTab()
    expect(document.activeElement).toBe(input)
    advanceClock()
    insertItem(db, { ...ATLAS, kind: 'note', title: 'Another note' })
    await pollTick()
    expect(field(), 'a frame never rebuilds the field').toBe(input)
  })

  it('hides the top-bar search on Find; ⌘K and / focus Find’s field; the top bar’s text moves in', async () => {
    db = freshDb()
    seed(db)
    await bootApp(db)
    const top = document.getElementById('search') as HTMLInputElement
    type(top, 'staging')
    await vi.advanceTimersByTimeAsync(200)
    await openFindTab()
    expect(unreachableReason(top)).toMatch(/hidden/)
    expect(field().value).toBe('staging')
    expect(top.value).toBe('')
    await vi.advanceTimersByTimeAsync(200)
    await settle()
    expect(findTitles()).toEqual(['Where should staging live?'])
    field().blur()
    key(document.body, 'k', { metaKey: true })
    expect(document.activeElement).toBe(field())
    field().blur()
    key(document.body, '/')
    expect(document.activeElement).toBe(field())
  })

  it('arrows move a painted highlight, Enter opens it, Escape clears then blurs', async () => {
    db = freshDb()
    const ids = seed(db)
    await bootApp(db)
    await openFindTab()
    const first = findKeys()[0]!
    expect(findRowEl(first)?.dataset.active, 'the first row by default').toBe('true')
    key(field(), 'ArrowDown')
    const second = findKeys()[1]!
    expect(findRowEl(second)?.dataset.active).toBe('true')
    expect(findRowEl(first)?.dataset.active).toBeUndefined()
    expect(document.activeElement, 'focus stays in the field').toBe(field())
    await pollTick()
    expect(findRowEl(second)?.dataset.active, 'kept by key across a rebuild').toBe('true')

    await findFor('nightly')
    type(field(), 'nightly backups')
    key(field(), 'Enter')
    await settle()
    expect(findRowEl(`item:${ids.note}`)?.querySelector('.find-row-body'), 'Enter waits for the debounce').toBeNull()
    await vi.advanceTimersByTimeAsync(200)
    await settle()
    key(field(), 'Enter')
    await settle()
    expect(findRowEl(`item:${ids.note}`)?.querySelector('.find-row-body .card')).not.toBeNull()

    key(field(), 'Escape')
    await settle()
    expect(field().value).toBe('')
    expect(document.activeElement).toBe(field())
    key(field(), 'Escape')
    expect(document.activeElement).not.toBe(field())
  })

  it('takes the command forms of the palette: their rows lead the list', async () => {
    db = freshDb()
    seed(db)
    await bootApp(db)
    await openFindTab()
    await findFor('open plan backups')
    expect(findRows()[0]?.dataset.findType).toBe('action')
    expect(findTitles()[0]).toBe('Backups and restore drill')
    key(field(), 'Enter')
    await settle()
    expect(document.getElementById('boards')!.hidden).toBe(false)
  })

  it('keeps the query in module state across a return to Find', async () => {
    db = freshDb()
    seed(db)
    await bootApp(db)
    await openFindTab()
    await findFor('staging')
    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    await openFindTab()
    expect(field().value).toBe('staging')
    expect(findTitles()).toEqual(['Where should staging live?'])
  })
})

describe('A3, A4 · the chips and what the list holds', () => {
  it('lists each kind under its chips, newest first, with one small extra', async () => {
    db = freshDb()
    const ids = seed(db)
    await bootApp(db)
    await openFindTab()
    const group = document.querySelector('#find [role="group"]')!
    expect(group.getAttribute('aria-label')).toBe('Show')
    expect([...group.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['All', 'Answers', 'Notes', 'Plans'])
    expect(chip('all')?.getAttribute('aria-pressed')).toBe('true')
    // no open unanswered ask, no ask closed without a reply and no plan under All with no query
    expect(findKeys()).toEqual([
      `item:${ids.note}`, `item:${ids.answered}`, `item:${ids.milestone}`, `item:${ids.oldNote}`, `item:${ids.closedAsk}`,
    ])
    expect(findRowEl(`item:${ids.answered}`)?.querySelector('.find-extra')?.textContent).toBe('Managed')
    expect(findRowEl(`item:${ids.closedAsk}`)?.querySelector('.find-extra')?.textContent).toBe('30 days')
    expect(findRowEl(`item:${ids.oldNote}`)?.querySelector('.find-extra')?.textContent).toBe('Resolved')
    expect(findRowEl(`item:${ids.milestone}`)?.querySelector('.find-extra')?.textContent).toBe('Completed')
    expect(findRows().map((el) => el.querySelector('.find-icon')?.getAttribute('aria-label')))
      .toEqual(['Note', 'Answer', 'Finished', 'Note', 'Answer'])

    await pressChip('answers')
    expect(chip('answers')?.getAttribute('aria-pressed')).toBe('true')
    expect(findKeys()).toEqual([`item:${ids.answered}`, `item:${ids.closedAsk}`])
    await pressChip('notes')
    expect(findKeys()).toEqual([`item:${ids.note}`, `item:${ids.oldNote}`])
    await pressChip('plans')
    expect(findKeys()).toEqual([expect.stringMatching(/^board:/)])
    expect(findRows()[0]?.querySelector('.find-extra .plan-bar')?.getAttribute('aria-label')).toBe('1 of 2 steps done, 1 in progress')
  })

  it('leaves a plan out of the plain All list, but All with a query that matches it lists it', async () => {
    db = freshDb()
    seed(db)
    await bootApp(db)
    await openFindTab()
    expect(findKeys().filter((k) => k!.startsWith('board:'))).toEqual([])
    await pressChip('plans')
    expect(findKeys().filter((k) => k!.startsWith('board:'))).toHaveLength(1)
    await pressChip('all')
    await findFor('restore drill')
    expect(findKeys().filter((k) => k!.startsWith('board:'))).toHaveLength(1)
  })

  it('with a query, All also finds open asks and asks closed without a reply; they go where they live', async () => {
    db = freshDb()
    const ids = seed(db)
    await bootApp(db)
    await openFindTab()
    await findFor('swept')
    expect(findKeys()).toEqual([`item:${ids.swept}`])
    await findFor('ship the backup')
    expect(findKeys()[0]).toBe(`item:${ids.openAsk}`)
    expect(mainOf(`item:${ids.openAsk}`)?.hasAttribute('aria-expanded'), 'an open ask never expands on Find').toBe(false)
    await pressRow(`item:${ids.openAsk}`)
    expect(document.getElementById('needsYou')!.hidden).toBe(false)
    expect(document.querySelector(`#needsYouList .nrow[data-card-id="${ids.openAsk}"] .nrow-card`)).not.toBeNull()
  })

  it('sends an answered open ask to Home rather than opening a second live copy', async () => {
    db = freshDb()
    const ids = seed(db)
    await bootApp(db)
    await openFindTab()
    expect(mainOf(`item:${ids.answered}`)?.hasAttribute('aria-expanded')).toBe(false)
    await pressRow(`item:${ids.answered}`)
    expect(document.getElementById('find')!.hidden).toBe(true)
    expect(document.querySelector(`#needsYouList .nrow[data-card-id="${ids.answered}"]`)).not.toBeNull()
  })

  it('sends a plan to Plans, keeping the lens', async () => {
    db = freshDb()
    seed(db)
    await bootApp(db)
    await openFindTab()
    await pressChip('plans')
    const planKey = findKeys().find((k) => k!.startsWith('board:'))!
    await pressRow(planKey)
    expect(document.getElementById('boards')!.hidden).toBe(false)
    expect(document.getElementById('projectDisclosureName')?.textContent).toBe('All projects')
  })
})

describe('A5 · the lens', () => {
  it('follows the project rail; a query under All projects covers closed projects', async () => {
    db = freshDb()
    seed(db)
    advanceClock()
    insertItem(db, { project: 'retired', stream: 'main', agent: 'claude', kind: 'note', title: 'Retired project note' })
    closeProject(db, 'retired')
    await bootApp(db)
    await openFindTab()
    expect(findTitles()).not.toContain('Retired project note')
    await findFor('retired')
    expect(findTitles()).toContain('Retired project note')
    await findFor('')
    click(document.querySelector('#rail [data-project="ledger"]'))
    await settle()
    expect(findRows().every((el) => el.querySelector('.find-project-name')?.textContent === 'ledger')).toBe(true)
  })
})

describe('A6 · paging and the cut', () => {
  it('shows 20 rows, then "Show 20 more", whose press focuses the first row it revealed', async () => {
    db = freshDb()
    for (let i = 0; i < 25; i += 1) {
      advanceClock()
      insertItem(db, { ...ATLAS, kind: 'note', title: `Note ${i}` })
    }
    await bootApp(db)
    await openFindTab()
    expect(findRows()).toHaveLength(20)
    const more = buttonLabelled('Show 5 more', foot())
    expect(more).not.toBeNull()
    // a poll keeps the foot's button, and the focus on it
    more!.focus()
    advanceClock()
    insertItem(db, { ...LEDGER, kind: 'question', title: 'An unrelated ask' })
    await pollTick()
    expect(buttonLabelled('Show 5 more', foot())).toBe(more)
    expect(document.activeElement).toBe(more)
    click(more)
    await settle()
    expect(findRows()).toHaveLength(25)
    expect(document.activeElement).toBe(findRows()[20]!.querySelector('.find-row-main'))
  })

  it('never draws an empty list: closed history the page cannot place is read at once, then paged', async () => {
    db = freshDb()
    const swept: string[] = []
    for (let i = 0; i < 55; i += 1) {
      advanceClock()
      const id = insertItem(db, { ...ATLAS, kind: 'note', title: `Old note ${i}` })
      swept.push(id)
    }
    advanceClock()
    for (const id of swept) resolveItem(db, id)
    const reads: string[] = []
    const opts: BootOptions = {
      interceptFetch: async (input, init, next) => {
        if ((init?.method ?? 'GET') === 'GET') reads.push(String(input))
        return next()
      },
    }
    await bootApp(db, opts)
    await openFindTab()
    await pollTick()
    // every closed note shares the sweep's stamp, which is the omitted history's newest touch: all
    // are below the cut, so Find reads the history itself rather than draw nothing under "Show more"
    expect(reads.filter((r) => r === '/api/items/history').length).toBeGreaterThan(0)
    expect(findRows().length).toBe(20)
    expect(buttonLabelled('Show 20 more', foot())).not.toBeNull()
    expect(buttonLabelled('Show more', foot())).toBeNull()
  })
})

describe('A7, A8 · a row, and a row opened in place', () => {
  it('is a div with one main button of spans; it opens into the card and keeps its nodes across polls', async () => {
    db = freshDb()
    const ids = seed(db)
    await bootApp(db)
    await openFindTab()
    const k = `item:${ids.note}`
    const rowEl = findRowEl(k)!
    expect(rowEl.tagName).toBe('DIV')
    expect(rowEl.dataset.cardId).toBe(ids.note)
    const main = mainOf(k)!
    expect([...main.children].every((child) => child.tagName === 'SPAN')).toBe(true)
    expect(main.getAttribute('aria-expanded')).toBe('false')
    expect(rowEl.querySelector('.find-row-body'), 'the card is built only while open').toBeNull()
    await pressRow(k)
    expect(main.getAttribute('aria-expanded')).toBe('true')
    const body = rowEl.querySelector('.find-row-body')!
    expect(unreachableReason(buttonLabelled('Resolve', body)!)).toBeNull()
    expect(buttonLabelled('Dismiss', body)).not.toBeNull()
    expect(buttonLabelled('Note', body)).not.toBeNull()
    main.focus()
    advanceClock()
    insertItem(db, { ...LEDGER, kind: 'note', title: 'A newer note' })
    await pollTick()
    expect(findRowEl(k), 'the row node is reconciled, not rebuilt').toBe(rowEl)
    expect(mainOf(k)).toBe(main)
    expect(document.activeElement).toBe(main)
    expect(findKeys()[0], 'a new row joins at its sorted place').not.toBe(k)
  })

  it('a resolved note stays where it is, in its new state, until the person leaves Find', async () => {
    db = freshDb()
    advanceClock()
    const earlier = insertItem(db, { ...LEDGER, kind: 'note', title: 'An earlier open note' })
    const ids = seed(db)
    await bootApp(db)
    await openFindTab()
    await pressChip('notes')
    const k = `item:${ids.note}`
    await pressRow(k)
    const before = findKeys()
    click(buttonLabelled('Resolve', findRowEl(k)!.querySelector('.find-row-body')!))
    await settle()
    expect(getItem(db, ids.note)?.status).toBe('resolved')
    expect(findKeys()).toEqual(before)
    expect(findRowEl(k)?.querySelector('.find-extra')?.textContent).toBe('Resolved')
    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()
    await openFindTab()
    await pressChip('notes')
    // back on Find, the closed note sorts after the open ones
    expect(findKeys().indexOf(k)).toBeGreaterThan(findKeys().indexOf(`item:${earlier}`))
  })

  it('keeps a row whose Note editor holds text open and listed under any chip', async () => {
    db = freshDb()
    const ids = seed(db)
    await bootApp(db)
    await openFindTab()
    const k = `item:${ids.note}`
    await pressRow(k)
    click(buttonLabelled('Note', findRowEl(k)!.querySelector('.find-row-body')!))
    await settle()
    type(noteEditor(findRowEl(k)), 'half a thought')
    noteEditor(findRowEl(k))!.blur()
    await pressChip('plans')
    expect(findKeys()).toContain(k)
    expect(noteEditor(findRowEl(k))?.value).toBe('half a thought')
    await pressRow(k)
    expect(findRowEl(k)?.querySelector('.find-row-body'), 'unsent text keeps it open').not.toBeNull()
  })

  it('Escape on an open row closes it and focuses its main button, never leaving a project peek', async () => {
    db = freshDb()
    const ids = seed(db)
    closeProject(db, 'atlas')
    await bootApp(db)
    click(document.getElementById('closedProjectsTrigger') ?? document.querySelector('#rail details summary'))
    await settle()
    click(document.querySelector('#rail [data-project="atlas"]'))
    await settle()
    await openFindTab()
    const k = `item:${ids.note}`
    await pressRow(k)
    const resolve = buttonLabelled('Resolve', findRowEl(k)!.querySelector('.find-row-body')!)!
    resolve.focus()
    key(resolve, 'Escape')
    await settle()
    expect(findRowEl(k)?.querySelector('.find-row-body')).toBeNull()
    expect(document.activeElement).toBe(mainOf(k))
    key(mainOf(k)!, 'Escape')
    await settle()
    expect(document.getElementById('projectDisclosureName')?.textContent).toBe('atlas')
  })
})

describe('A9 · unread notes', () => {
  it('marks notes read only under the Notes chip with no query; New marks hold until the person leaves', async () => {
    db = freshDb()
    const ids = seed(db)
    await bootApp(db)
    expect(tabCount('find')).toBe('1')
    await openFindTab()
    await pollTick()
    expect(tabCount('find'), 'All does not mark notes read').toBe('1')
    await findFor('nightly')
    await pressChip('notes')
    expect(tabCount('find'), 'a query does not either').toBe('1')
    await findFor('')
    expect(tabCount('find')).toBe('')
    const mark = findRowEl(`item:${ids.note}`)?.querySelector('.find-new')
    expect(mark?.textContent).toBe('New')
    await pollTick()
    expect(findRowEl(`item:${ids.note}`)?.querySelector('.find-new')?.textContent, 'the mark holds on repaints').toBe('New')
    expect(findRowEl(`item:${ids.oldNote}`)?.querySelector('.find-new')?.textContent, 'the space is kept').toBe('')
    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    await openFindTab()
    expect(findRowEl(`item:${ids.note}`)?.querySelector('.find-new')?.textContent).toBe('')
  })

  it('Home’s chip opens Find with Notes selected and the query cleared', async () => {
    db = freshDb()
    seed(db)
    await bootApp(db)
    await openFindTab()
    await findFor('staging')
    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()
    click(document.querySelector('#needsYouList .notes-chip'))
    await settle()
    expect(document.getElementById('find')!.hidden).toBe(false)
    expect(chip('notes')?.getAttribute('aria-pressed')).toBe('true')
    expect(field().value).toBe('')
  })
})

describe('A10 · ways in', () => {
  it('lands #item/<id> on its row: opened, focused, the narrowest chip when the list did not hold it', async () => {
    db = freshDb()
    const ids = seed(db)
    await bootApp(db)
    await openFindTab()
    await findFor('staging')
    navigateToHash(`#item/${ids.oldNote}`)
    await settle()
    await vi.advanceTimersByTimeAsync(50)
    expect(document.getElementById('find')!.hidden).toBe(false)
    expect(field().value).toBe('')
    expect(chip('notes')?.getAttribute('aria-pressed')).toBe('true')
    const k = `item:${ids.oldNote}`
    expect(findRowEl(k)?.querySelector('.find-row-body .card')).not.toBeNull()
    expect(document.activeElement).toBe(mainOf(k))
  })

  it('keeps the query and chip when the target is in the list', async () => {
    db = freshDb()
    const ids = seed(db)
    await bootApp(db)
    await openFindTab()
    await findFor('backups')
    navigateToHash(`#item/${ids.closedAsk}`)
    await settle()
    await vi.advanceTimersByTimeAsync(50)
    expect(field().value).toBe('backups')
    expect(chip('all')?.getAttribute('aria-pressed')).toBe('true')
    expect(findRowEl(`item:${ids.closedAsk}`)?.querySelector('.find-row-body')).not.toBeNull()
  })
})

describe('A12 · texts', () => {
  it('says why the list is empty', async () => {
    db = freshDb()
    await bootApp(db)
    await openFindTab()
    expect(status()).toBe('Nothing here yet.')
    advanceClock()
    insertItem(db, { ...ATLAS, kind: 'note', title: 'Lone note' })
    await pollTick()
    await pressChip('answers')
    expect(status()).toBe('No answers yet.')
    await pressChip('plans')
    expect(status()).toBe('No plans.')
    await pressChip('notes')
    expect(status()).toBe('')
    await findFor('zebra')
    expect(status()).toBe('Nothing matches "zebra".')
  })
})

// ── the build review's fixes ────────────────────────────────────────────────

// One hashchange, as a real browser fires for one navigation: jsdom fires its own for a
// write to location.hash, and navigateToHash dispatches another on top of it.
function landOnce(id: string) {
  history.replaceState(null, '', `#item/${id}`)
  window.dispatchEvent(new window.HashChangeEvent('hashchange'))
}

describe('A8 · a row that stays in place leaves its place with the chip or the query', () => {
  it('a note resolved under All is not listed under Plans, and a query it misses lists nothing', async () => {
    db = freshDb()
    advanceClock()
    upsertBoard(db, { ...LEDGER, title: 'Backups plan', rows: [{ label: 'Write the job', status: 'done' }] })
    advanceClock()
    const note = insertItem(db, { ...ATLAS, kind: 'note', title: 'Nightly backups', detail: 'cron removed' })
    await bootApp(db)
    await openFindTab()
    const k = `item:${note}`
    await pressRow(k)
    click(buttonLabelled('Resolve', findRowEl(k)!.querySelector('.find-row-body')!))
    await settle()
    expect(findKeys(), 'it stays in place under All').toContain(k)
    await pressChip('plans')
    expect(findKeys()).toEqual([expect.stringMatching(/^board:/)])
    await findFor('zzzqqq')
    expect(findKeys()).toEqual([])
    expect(status()).toBe('Nothing matches "zzzqqq".')
  })

  it('Enter in the field opens the best match, not the row resolved a moment ago', async () => {
    db = freshDb()
    advanceClock()
    const milestone = insertItem(db, { ...ATLAS, kind: 'done', title: 'Shipped the exporter', next_step: 'No action' })
    advanceClock()
    const note = insertItem(db, { ...ATLAS, kind: 'note', title: 'Backups now run nightly' })
    await bootApp(db)
    await openFindTab()
    await pressRow(`item:${note}`)
    click(buttonLabelled('Resolve', findRowEl(`item:${note}`)!.querySelector('.find-row-body')!))
    await settle()
    await findFor('exporter')
    expect(findKeys()[0]).toBe(`item:${milestone}`)
    expect(findRowEl(`item:${milestone}`)?.dataset.active, 'the match takes the highlight').toBe('true')
    key(field(), 'Enter')
    await settle()
    expect(findRowEl(`item:${milestone}`)?.querySelector('.find-row-body')).not.toBeNull()
  })

  it('a press in an open row (Note, then Cancel) does not make it follow the person to another chip', async () => {
    db = freshDb()
    advanceClock()
    const ask = insertItem(db, { ...ATLAS, kind: 'question', title: 'Keep 30 or 90 days?', options: [{ label: '30 days' }] })
    replyItem(db, ask, '30 days')
    resolveItem(db, ask, 'Retention set to 30 days.')
    advanceClock()
    const milestone = insertItem(db, { ...LEDGER, kind: 'done', title: 'Shipped the exporter', next_step: 'No action' })
    await bootApp(db)
    await openFindTab()
    const k = `item:${milestone}`
    await pressRow(k)
    click(buttonLabelled('Note', findRowEl(k)!.querySelector('.find-row-body')!))
    await settle()
    click(buttonLabelled('Cancel', findRowEl(k)!.querySelector('.note-editor')!))
    await settle()
    expect(findKeys()).toContain(k)
    await pressChip('answers')
    expect(findKeys()).toEqual([`item:${ask}`])
  })

  it('the row a way in landed on does not lead a later query or hide "Nothing matches"', async () => {
    db = freshDb()
    advanceClock()
    const landed = insertItem(db, { ...ATLAS, kind: 'note', title: 'Nightly backups' })
    advanceClock()
    const zebra = insertItem(db, { ...ATLAS, kind: 'note', title: 'Zebra crossing rollout' })
    await bootApp(db)
    navigateToHash(`#item/${landed}`)
    await settle()
    await vi.advanceTimersByTimeAsync(50)
    expect(findRowEl(`item:${landed}`)?.querySelector('.find-row-body .card')).not.toBeNull()
    field().focus()
    await findFor('zebra')
    expect(findKeys()).toEqual([`item:${zebra}`])
    key(field(), 'Enter')
    await settle()
    expect(findRowEl(`item:${zebra}`)?.querySelector('.find-row-body')).not.toBeNull()
    await findFor('zzzqqq')
    expect(findKeys()).toEqual([])
    expect(status()).toBe('Nothing matches "zzzqqq".')
  })

  it('a row whose Note editor holds text stays listed with its text after leaving Find, and under another chip', async () => {
    db = freshDb()
    const ids = seed(db)
    await bootApp(db)
    await openFindTab()
    const k = `item:${ids.note}`
    await pressRow(k)
    click(buttonLabelled('Note', findRowEl(k)!.querySelector('.find-row-body')!))
    await settle()
    type(noteEditor(findRowEl(k)), 'half a thought')
    noteEditor(findRowEl(k))!.blur()
    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()
    await openFindTab()
    await pressChip('plans')
    expect(findKeys()).toContain(k)
    expect(noteEditor(findRowEl(k))?.value).toBe('half a thought')
    expect(unreachableReason(noteEditor(findRowEl(k))!)).toBeNull()
    await findFor('zzzqqq')
    expect(findKeys()).toEqual([k])
    expect(noteEditor(findRowEl(k))?.value).toBe('half a thought')
  })
})

describe('A10 · a landing finds its row', () => {
  it('lands on a note of a closed project while the query misses it: the project is peeked, the row drawn', async () => {
    db = freshDb()
    const note = insertItem(db, { ...ATLAS, kind: 'note', title: 'Backups now run nightly' })
    insertItem(db, { ...LEDGER, kind: 'note', title: 'Ledger note' })
    closeProject(db, 'atlas')
    await bootApp(db)
    await openFindTab()
    await findFor('ledger')
    landOnce(note)
    await settle()
    await vi.advanceTimersByTimeAsync(50)
    expect(document.getElementById('find')!.hidden).toBe(false)
    expect(field().value).toBe('')
    const k = `item:${note}`
    expect(findRowEl(k)?.querySelector('.find-row-body .card')).not.toBeNull()
    expect(document.activeElement).toBe(mainOf(k))
    expect(document.getElementById('projectDisclosureName')?.textContent).toBe('atlas')
  })

  it('keeps a target the list already holds at its sorted place', async () => {
    db = freshDb()
    advanceClock()
    const milestone = insertItem(db, { ...ATLAS, kind: 'done', title: 'Shipped the exporter', next_step: 'No action' })
    for (let i = 0; i < 3; i += 1) {
      advanceClock()
      insertItem(db, { ...LEDGER, kind: 'note', title: `Newer note ${i}` })
    }
    await bootApp(db)
    await openFindTab()
    const sorted = findKeys()
    expect(sorted.indexOf(`item:${milestone}`)).toBe(3)
    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()
    navigateToHash(`#item/${milestone}`)
    await settle()
    await vi.advanceTimersByTimeAsync(50)
    expect(findKeys(), 'the sorted order holds').toEqual(sorted)
    expect(findRowEl(`item:${milestone}`)?.querySelector('.find-row-body .card')).not.toBeNull()
    await pollTick()
    expect(findKeys()).toEqual(sorted)
  })

  it('places a target past the first page after it, still opened and focused', async () => {
    db = freshDb()
    const ids: string[] = []
    for (let i = 0; i < 25; i += 1) {
      advanceClock()
      ids.push(insertItem(db, { ...ATLAS, kind: 'note', title: `Note ${i}` }))
    }
    await bootApp(db)
    navigateToHash(`#item/${ids[0]}`)
    await settle()
    await vi.advanceTimersByTimeAsync(50)
    const k = `item:${ids[0]}`
    expect(findKeys()).toHaveLength(21)
    expect(findKeys()[20]).toBe(k)
    expect(findRowEl(k)?.querySelector('.find-row-body .card')).not.toBeNull()
    expect(document.activeElement).toBe(mainOf(k))
  })
})

describe('A6, A7 · the foot and the rows keep focus across a poll', () => {
  it('keeps the foot button, its focus and its place when a poll changes how many rows are left', async () => {
    db = freshDb()
    for (let i = 0; i < 25; i += 1) {
      advanceClock()
      insertItem(db, { ...ATLAS, kind: 'note', title: `Note ${i}` })
    }
    await bootApp(db)
    await openFindTab()
    const more = buttonLabelled('Show 5 more', foot())!
    more.focus()
    expect(document.activeElement).toBe(more)
    advanceClock()
    insertItem(db, { ...LEDGER, kind: 'note', title: 'One more note from an agent' })
    await pollTick()
    expect(foot().querySelector('button'), 'the same node').toBe(more)
    expect(more.textContent).toBe('Show 6 more')
    expect(document.activeElement).toBe(more)
    click(more)
    await settle()
    expect(findRows()).toHaveLength(26)
    expect(foot().querySelector('button')).toBeNull()
  })

  it('keeps focus on a plan row a poll re-sorts to the top', async () => {
    db = freshDb()
    advanceClock()
    upsertBoard(db, { ...ATLAS, title: 'Older plan', rows: [{ label: 'One', status: 'partial' }] })
    advanceClock()
    upsertBoard(db, { ...ATLAS, title: 'Newer plan', rows: [{ label: 'One', status: 'partial' }] })
    await bootApp(db)
    await openFindTab()
    await pressChip('plans')
    expect(findTitles()).toEqual(['Newer plan', 'Older plan'])
    const main = findRows()[1]!.querySelector<HTMLButtonElement>('.find-row-main')!
    main.focus()
    advanceClock()
    upsertBoard(db, { ...ATLAS, title: 'Older plan', expectedVersion: 1, rows: [{ label: 'One', status: 'partial', revision: 1 }, { label: 'Two', status: 'done' }] })
    await pollTick()
    expect(findTitles()).toEqual(['Older plan', 'Newer plan'])
    expect(document.activeElement, 'focus stays on the row it moved').toBe(findRows()[0]!.querySelector('.find-row-main'))
  })

  it('keeps focus on a row when a row above it leaves the list', async () => {
    db = freshDb()
    advanceClock()
    upsertBoard(db, { ...LEDGER, title: 'Older plan', rows: [{ label: 'One', status: 'done' }] })
    advanceClock()
    upsertBoard(db, { ...ATLAS, title: 'Newer plan', rows: [{ label: 'One', status: 'done' }] })
    await bootApp(db)
    await openFindTab()
    await pressChip('plans')
    expect(findTitles()).toEqual(['Newer plan', 'Older plan'])
    const planKey = findKeys()[1]!
    const planMain = mainOf(planKey)!
    planMain.focus()
    expect(document.activeElement).toBe(planMain)
    // an agent closes project atlas: the plan above leaves on the next poll
    closeProject(db, 'atlas')
    await pollTick()
    expect(findKeys()).toEqual([planKey])
    expect(mainOf(planKey)).toBe(planMain)
    expect(document.activeElement).toBe(planMain)
  })
})

describe('A9 · New marks follow the lens', () => {
  it('shows an unread note as New when the person narrows the rail to its project while on Find', async () => {
    db = freshDb()
    advanceClock()
    const atlasNote = insertItem(db, { ...ATLAS, kind: 'note', title: 'Atlas unread note' })
    advanceClock()
    insertItem(db, { ...LEDGER, kind: 'note', title: 'Ledger unread note' })
    await bootApp(db)
    expect(tabCount('find')).toBe('2')
    click(document.querySelector('#rail [data-project="ledger"]'))
    await settle()
    await openFindTab()
    await pressChip('notes')
    click(document.querySelector('#rail [data-project="atlas"]'))
    await settle()
    expect(findRowEl(`item:${atlasNote}`)?.querySelector('.find-new')?.textContent).toBe('New')
  })
})

describe('A2 · a query waiting on older history', () => {
  const OLD = 55
  function seedWaiting(d: Database.Database) {
    const closed: string[] = []
    for (let i = 0; i < OLD; i += 1) {
      advanceClock()
      closed.push(insertItem(d, { ...ATLAS, kind: 'note', title: `Old note ${i}` }))
    }
    for (const id of closed) {
      advanceClock()
      resolveItem(d, id)
    }
    advanceClock()
    const alpha = insertItem(d, { ...LEDGER, kind: 'note', title: 'Alpha open note' })
    advanceClock()
    const zebra = insertItem(d, { ...LEDGER, kind: 'note', title: 'Zebra open note' })
    return { alpha, zebra }
  }

  it('marks the rows of the previous list busy and inert while it waits, and frees them with the results', async () => {
    db = freshDb()
    const ids = seedWaiting(db)
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    let hold = false
    await bootApp(db, {
      interceptFetch: async (input, init, next) => {
        if (String(input) === '/api/items/history' && hold) await held
        return next()
      },
    })
    await openFindTab()
    expect(findKeys()).toEqual([`item:${ids.zebra}`, `item:${ids.alpha}`])
    hold = true
    field().focus()
    type(field(), 'zebra')
    await vi.advanceTimersByTimeAsync(200)
    expect(status()).toBe('Searching older history…')
    const list = document.getElementById('findList')!
    expect(list.getAttribute('aria-busy')).toBe('true')
    expect(list.dataset.updating).toBe('true')
    expect(field().hasAttribute('aria-activedescendant')).toBe(false)
    for (const el of findRows()) expect(el.querySelector(':scope > .find-row-main')?.getAttribute('aria-disabled')).toBe('true')
    click(mainOf(`item:${ids.alpha}`))
    await settle()
    expect(findRowEl(`item:${ids.alpha}`)?.querySelector('.find-row-body'), 'a press on a stale row does nothing').toBeNull()

    release()
    await settle()
    await pollTick()
    expect(findKeys()).toEqual([`item:${ids.zebra}`])
    expect(list.hasAttribute('aria-busy')).toBe(false)
    expect(list.hasAttribute('data-updating')).toBe(false)
    expect(mainOf(`item:${ids.zebra}`)?.hasAttribute('aria-disabled')).toBe(false)
    expect(field().getAttribute('aria-activedescendant')).toBe(mainOf(`item:${ids.zebra}`)?.id)
  })

  it('returns the rows to normal under the failure text when the read fails', async () => {
    db = freshDb()
    const ids = seedWaiting(db)
    await bootApp(db, {
      interceptFetch: async (input, init, next) => {
        if (String(input) === '/api/items/history') return new Response('nope', { status: 500 })
        return next()
      },
    })
    await openFindTab()
    field().focus()
    await findFor('zebra')
    await pollTick()
    expect(status()).toBe('Older history is unavailable right now.')
    const list = document.getElementById('findList')!
    expect(list.hasAttribute('data-updating')).toBe(false)
    expect(findRows().length).toBeGreaterThan(0)
    for (const el of findRows()) expect(el.querySelector(':scope > .find-row-main')?.hasAttribute('aria-disabled')).toBe(false)
    expect(ids.alpha).toBeTruthy()
  })
})

describe('A8 · what an open row says first', () => {
  it('opens with one quiet line naming the agent and stream, above the card, set as text', async () => {
    db = freshDb()
    const ids = seed(db)
    await bootApp(db)
    await openFindTab()
    const k = `item:${ids.note}`
    await pressRow(k)
    const body = findRowEl(k)!.querySelector('.find-row-body')!
    expect(body.firstElementChild?.className).toBe('find-row-origin')
    expect(body.firstElementChild?.textContent).toBe('claude · main')
    expect(body.firstElementChild?.nextElementSibling?.classList.contains('card')).toBe(true)
    const ledger = insertItem(db, { ...LEDGER, stream: '<b>hostile</b>', kind: 'note', title: 'A hostile stream' })
    await pollTick()
    await pressRow(`item:${ledger}`)
    const origin = findRowEl(`item:${ledger}`)!.querySelector('.find-row-origin')!
    expect(origin.textContent).toBe('copilot · <b>hostile</b>')
    expect(origin.querySelector('b')).toBeNull()
  })
})

describe('A7 · a frame that repaints for another reason leaves an open card alone', () => {
  it('does not rebuild an open card on every frame when the links read fails', async () => {
    db = freshDb()
    const ids = seed(db)
    await bootApp(db, {
      interceptFetch: async (input, init, next) => {
        if (String(input) === '/api/links') return new Response('nope', { status: 500 })
        return next()
      },
    })
    await openFindTab()
    const k = `item:${ids.note}`
    await pressRow(k)
    const card = findRowEl(k)!.querySelector('.find-row-body .card')!
    await changedPollTick(db)
    await changedPollTick(db)
    expect(findRowEl(k)!.querySelector('.find-row-body .card'), 'the same card node').toBe(card)
  })

  it('gives each drawn row its own id, stable while drawn, and a fresh one after the row left the list', async () => {
    db = freshDb()
    const ids = seed(db)
    await bootApp(db)
    await openFindTab()
    const k = `item:${ids.note}`
    const first = mainOf(k)!.id
    const all = () => findRows().map((el) => el.querySelector(':scope > .find-row-main')!.id)
    expect(new Set(all()).size).toBe(all().length)
    await pollTick()
    expect(mainOf(k)!.id).toBe(first)
    await findFor('zzzqqq')
    expect(findKeys()).toEqual([])
    await findFor('')
    expect(new Set(all()).size, 'ids stay unique').toBe(all().length)
    expect(mainOf(k)!.id, 'the id of a key no longer drawn is not kept').not.toBe(first)
  })
})
