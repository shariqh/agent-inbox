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
  advanceClock, bootApp, buttonLabelled, click, findFor, freshDb, navigateToHash, noteEditor, pollTick, settle,
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
    // no open unanswered ask and no ask closed without a reply under All
    expect(findKeys()).toEqual([
      `item:${ids.note}`, `item:${ids.answered}`, expect.stringMatching(/^board:/), `item:${ids.milestone}`,
      `item:${ids.oldNote}`, `item:${ids.closedAsk}`,
    ])
    expect(findRowEl(`item:${ids.answered}`)?.querySelector('.find-extra')?.textContent).toBe('Managed')
    expect(findRowEl(`item:${ids.closedAsk}`)?.querySelector('.find-extra')?.textContent).toBe('30 days')
    expect(findRowEl(`item:${ids.oldNote}`)?.querySelector('.find-extra')?.textContent).toBe('Resolved')
    expect(findRowEl(`item:${ids.milestone}`)?.querySelector('.find-extra')?.textContent).toBe('Completed')
    expect(findRows()[2]?.querySelector('.find-extra .plan-bar')?.getAttribute('aria-label')).toBe('1 of 2 steps done, 1 in progress')
    expect(findRows().map((el) => el.querySelector('.find-icon')?.getAttribute('aria-label')))
      .toEqual(['Note', 'Answer', 'Plan', 'Finished', 'Note', 'Answer'])

    await pressChip('answers')
    expect(chip('answers')?.getAttribute('aria-pressed')).toBe('true')
    expect(findKeys()).toEqual([`item:${ids.answered}`, `item:${ids.closedAsk}`])
    await pressChip('notes')
    expect(findKeys()).toEqual([`item:${ids.note}`, `item:${ids.oldNote}`])
    await pressChip('plans')
    expect(findKeys()).toEqual([expect.stringMatching(/^board:/)])
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
    click(more)
    await settle()
    expect(findRows()).toHaveLength(25)
    expect(document.activeElement).toBe(findRows()[20]!.querySelector('.find-row-main'))
  })

  it('cuts closed history the page cannot place, and Show more reads it with its loading line', async () => {
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
    // every closed note shares the sweep's stamp, which is the omitted history's newest touch: all cut
    expect(reads.filter((r) => r === '/api/items/history')).toHaveLength(0)
    const older = buttonLabelled('Show more', foot())
    expect(older).not.toBeNull()
    click(older)
    await settle()
    await pollTick()
    expect(reads.filter((r) => r === '/api/items/history').length).toBeGreaterThan(0)
    expect(findRows().length).toBe(20)
    expect(buttonLabelled('Show 20 more', foot())).not.toBeNull()
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
