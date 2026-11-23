// @vitest-environment jsdom
// Find follow-ups: the list, landings, unsent Note text and what stays in place.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { closeProject, getBoardByTitle, insertItem, replyItem, resolveItem, upsertBoard } from '../../src/store.js'
import {
  advanceClock, bootApp, buttonLabelled, click, findFor, freshDb, noteEditor, pollTick, settle, tabCount, type, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
})

const ATLAS = { project: 'atlas', stream: 'main', agent: 'claude' } as const
const LEDGER = { project: 'ledger', stream: 'main', agent: 'copilot' } as const
const findRows = () => [...document.querySelectorAll<HTMLElement>('#findList > .find-row')]
const findKeys = () => findRows().map((el) => el.dataset.findKey)
const findRowEl = (key: string) => document.querySelector<HTMLElement>(`#findList > .find-row[data-find-key="${key}"]`)
const chip = (name: string) => document.querySelector<HTMLButtonElement>(`#find [data-find-chip="${name}"]`)
const status = () => {
  const el = document.getElementById('findStatus')!
  return el.hidden ? '' : el.textContent ?? ''
}
const field = () => document.getElementById('findQuery') as HTMLInputElement

async function openFindTab() {
  click(document.querySelector('.tab[data-tab="find"]'))
  await settle()
}
async function land(id: string) {
  // one hashchange, as a real browser fires for one navigation
  history.replaceState(null, '', `#item/${id}`)
  window.dispatchEvent(new window.HashChangeEvent('hashchange'))
  await settle()
  await vi.advanceTimersByTimeAsync(50)
}
const openRow = async (key: string) => {
  click(findRowEl(key)!.querySelector(':scope > .find-row-main'))
  await settle()
}

describe('stay in place: original scenarios', () => {
  it('NL-1a: after a landing, Enter on a query opens the best match', async () => {
    db = freshDb()
    advanceClock()
    const landed = insertItem(db, { ...ATLAS, kind: 'note', title: 'Nightly backups' })
    advanceClock()
    const zebra = insertItem(db, { ...ATLAS, kind: 'note', title: 'Zebra crossing rollout' })
    await bootApp(db)
    await land(landed)
    field().focus()
    await findFor('zebra')
    field().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await settle()
    expect(findKeys()).toEqual([`item:${zebra}`])
    expect(findRowEl(`item:${zebra}`)?.querySelector('.find-row-body')).not.toBeNull()
  })

  it('NL-1c/DOL-2b: a resolved note leaves under Plans and under a query that misses it', async () => {
    db = freshDb()
    advanceClock()
    upsertBoard(db, { ...LEDGER, title: 'Backups plan', rows: [{ label: 'Write the job', status: 'done' }] })
    advanceClock()
    const note = insertItem(db, { ...ATLAS, kind: 'note', title: 'Nightly backups' })
    await bootApp(db)
    await openFindTab()
    click(chip('notes'))
    await settle()
    const k = `item:${note}`
    await openRow(k)
    click(buttonLabelled('Resolve', findRowEl(k)!.querySelector('.find-row-body')!))
    await settle()
    click(chip('plans'))
    await settle()
    expect(findKeys()).not.toContain(k)
    click(chip('notes'))
    await settle()
    await findFor('qqqzzz')
    expect({ keys: findKeys(), said: status() }).toEqual({ keys: [], said: 'Nothing matches "qqqzzz".' })
  })

  it('DOL-2a: Note then Cancel on a milestone, then Answers lists only answers', async () => {
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
    await openRow(k)
    click(buttonLabelled('Note', findRowEl(k)!.querySelector('.find-row-body')!))
    await settle()
    click(buttonLabelled('Cancel', findRowEl(k)!.querySelector('.find-row-body')!))
    await settle()
    click(chip('answers'))
    await settle()
    expect(findRows().map((el) => el.dataset.findType)).toEqual(['answer'])
  })
})

describe('stay in place: what must still hold', () => {
  it('V1: a note resolved under Notes stays where it was across a poll and a new note arriving', async () => {
    db = freshDb()
    const ids: string[] = []
    for (let i = 0; i < 4; i += 1) {
      advanceClock()
      ids.push(insertItem(db, { ...ATLAS, kind: 'note', title: `Note ${i}` }))
    }
    await bootApp(db)
    await openFindTab()
    click(chip('notes'))
    await settle()
    const before = findKeys()
    const k = `item:${ids[2]}` // second from the top
    expect(before.indexOf(k)).toBe(1)
    await openRow(k)
    click(buttonLabelled('Resolve', findRowEl(k)!.querySelector('.find-row-body')!))
    await settle()
    await pollTick()
    expect(findKeys(), 'the resolved note stays second').toEqual(before)
    advanceClock()
    const fresh = insertItem(db, { ...LEDGER, kind: 'note', title: 'Fresh note' })
    await pollTick()
    expect(findKeys()).toEqual([`item:${fresh}`, ...before])
  })

  it('V2: typing a letter and deleting it inside the debounce (the same settled query) keeps the resolved note in place', async () => {
    db = freshDb()
    const ids: string[] = []
    for (let i = 0; i < 4; i += 1) {
      advanceClock()
      ids.push(insertItem(db, { ...ATLAS, kind: 'note', title: `Note ${i}` }))
    }
    await bootApp(db)
    await openFindTab()
    click(chip('notes'))
    await settle()
    const before = findKeys()
    const k = `item:${ids[2]}`
    await openRow(k)
    click(buttonLabelled('Resolve', findRowEl(k)!.querySelector('.find-row-body')!))
    await settle()
    expect(findKeys()).toEqual(before)
    type(field(), 'x')
    await vi.advanceTimersByTimeAsync(40)
    type(field(), '')
    await vi.advanceTimersByTimeAsync(200)
    expect(field().value).toBe('')
    expect(findKeys(), 'the query is what it was: nothing should move').toEqual(before)
  })
})

describe('unsent Note text', () => {
  it('V3: a row with unsent Note text is listed once and open under every chip and query, and after leaving and returning', async () => {
    db = freshDb()
    advanceClock()
    upsertBoard(db, { ...LEDGER, title: 'Backups plan', rows: [{ label: 'Write the job', status: 'done' }] })
    const others: string[] = []
    for (let i = 0; i < 3; i += 1) {
      advanceClock()
      others.push(insertItem(db, { ...LEDGER, kind: 'note', title: `Other note ${i}` }))
    }
    advanceClock()
    const note = insertItem(db, { ...ATLAS, kind: 'note', title: 'Nightly backups' })
    for (let i = 0; i < 2; i += 1) {
      advanceClock()
      others.push(insertItem(db, { ...LEDGER, kind: 'note', title: `Newer note ${i}` }))
    }
    await bootApp(db)
    await openFindTab()
    const k = `item:${note}`
    await openRow(k)
    click(buttonLabelled('Note', findRowEl(k)!.querySelector('.find-row-body')!))
    await settle()
    type(noteEditor(findRowEl(k)), 'half a thought')
    await settle()
    const seen: Record<string, unknown> = {}
    const snap = (label: string) => {
      const keys = findKeys()
      seen[label] = {
        count: keys.filter((x) => x === k).length,
        open: Boolean(findRowEl(k)?.querySelector('.find-row-body .note-editor')),
        text: noteEditor(findRowEl(k))?.value ?? null,
      }
    }
    for (const c of ['plans', 'answers', 'notes', 'all']) {
      click(chip(c))
      await settle()
      snap(c)
    }
    await findFor('zzzqqq')
    snap('query-miss')
    await findFor('backups')
    snap('query-hit')
    await findFor('')
    snap('cleared')
    await pollTick()
    snap('poll')
    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()
    await openFindTab()
    snap('returned')
    const want = { count: 1, open: true, text: 'half a thought' }
    expect(seen).toEqual({
      plans: want, answers: want, notes: want, all: want, 'query-miss': want, 'query-hit': want, cleared: want, poll: want, returned: want,
    })
  })

  it('V4: under All with no query a text-held row keeps its sorted place after a chip change (not first)', async () => {
    db = freshDb()
    advanceClock()
    const note = insertItem(db, { ...ATLAS, kind: 'note', title: 'Nightly backups' })
    const newer: string[] = []
    for (let i = 0; i < 2; i += 1) {
      advanceClock()
      newer.push(insertItem(db, { ...LEDGER, kind: 'note', title: `Newer note ${i}` }))
    }
    await bootApp(db)
    await openFindTab()
    const k = `item:${note}`
    await openRow(k)
    click(buttonLabelled('Note', findRowEl(k)!.querySelector('.find-row-body')!))
    await settle()
    type(noteEditor(findRowEl(k)), 'half a thought')
    click(chip('notes'))
    await settle()
    expect(findKeys()).toEqual([`item:${newer[1]}`, `item:${newer[0]}`, k])
  })

  it('V5: unsent text on a closed project\'s note found by a query stays listed when the query is cleared', async () => {
    db = freshDb()
    advanceClock()
    const note = insertItem(db, { ...ATLAS, kind: 'note', title: 'Retired project backups' })
    advanceClock()
    insertItem(db, { ...LEDGER, kind: 'note', title: 'Ledger note' })
    closeProject(db, 'atlas')
    await bootApp(db)
    await openFindTab()
    await findFor('retired')
    const k = `item:${note}`
    expect(findKeys()).toContain(k)
    await openRow(k)
    click(buttonLabelled('Note', findRowEl(k)!.querySelector('.find-row-body')!))
    await settle()
    type(noteEditor(findRowEl(k)), 'half a thought')
    await findFor('')
    expect(findKeys(), 'the row holding unsent text').toContain(k)
  })
})

describe('landings', () => {
  it('NL-2/DOL-1: a closed project\'s note, Find holding a query that misses it', async () => {
    db = freshDb()
    advanceClock()
    const note = insertItem(db, { ...ATLAS, kind: 'note', title: 'Retired project note' })
    advanceClock()
    insertItem(db, { ...LEDGER, kind: 'note', title: 'Where should staging live' })
    closeProject(db, 'atlas')
    await bootApp(db)
    await openFindTab()
    await findFor('staging')
    await land(note)
    const row = findRowEl(`item:${note}`)
    expect(row, `listed: ${findKeys().join(', ')}`).not.toBeNull()
    expect(document.activeElement).toBe(row!.querySelector('.find-row-main'))
  })

  it('V6: the same from Home (Find not showing, a query left in its field from an earlier visit)', async () => {
    db = freshDb()
    advanceClock()
    const note = insertItem(db, { ...ATLAS, kind: 'note', title: 'Retired project note' })
    resolveItem(db, note)
    advanceClock()
    insertItem(db, { ...LEDGER, kind: 'note', title: 'Where should staging live' })
    closeProject(db, 'atlas')
    await bootApp(db)
    await openFindTab()
    await findFor('staging')
    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()
    await land(note)
    expect(document.getElementById('find')!.hidden).toBe(false)
    const row = findRowEl(`item:${note}`)
    expect(row, `listed: ${findKeys().join(', ')}`).not.toBeNull()
    expect(row!.querySelector('.find-row-body')).not.toBeNull()
  })

  it('V7: a closed answered ask under Plans with a query: Answers, listed, open', async () => {
    db = freshDb()
    advanceClock()
    const ask = insertItem(db, { ...ATLAS, kind: 'question', title: 'Keep 30 or 90 days?', options: [{ label: '30 days' }] })
    replyItem(db, ask, '30 days')
    resolveItem(db, ask, 'Retention set.')
    await bootApp(db)
    await openFindTab()
    click(chip('plans'))
    await settle()
    await findFor('zzz')
    await land(ask)
    expect(chip('answers')?.getAttribute('aria-pressed')).toBe('true')
    expect(findRowEl(`item:${ask}`)?.querySelector('.find-row-body')).not.toBeNull()
  })

  it('V8: an OPEN answered ask goes to Home', async () => {
    db = freshDb()
    advanceClock()
    const ask = insertItem(db, { ...ATLAS, kind: 'question', title: 'Keep 30 or 90 days?', options: [{ label: '30 days' }] })
    replyItem(db, ask, '30 days')
    await bootApp(db)
    await openFindTab()
    await land(ask)
    expect(document.getElementById('find')!.hidden).toBe(true)
  })

  it('V9: an item outside the Agent select\'s lens, Find holding a query', async () => {
    db = freshDb()
    advanceClock()
    const note = insertItem(db, { ...ATLAS, kind: 'note', title: 'Claude note' })
    advanceClock()
    insertItem(db, { ...LEDGER, kind: 'note', title: 'Copilot staging note' })
    await bootApp(db)
    const agents = document.getElementById('agentSelect') as HTMLSelectElement
    agents.value = 'copilot'
    agents.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    await openFindTab()
    await findFor('staging')
    await land(note)
    expect(findRowEl(`item:${note}`)?.querySelector('.find-row-body'), `listed: ${findKeys().join(', ')}`).not.toBeNull()
  })

  it('NL-5: a landing on the oldest of four notes keeps newest-first order across polls', async () => {
    db = freshDb()
    const ids: string[] = []
    for (let i = 0; i < 4; i += 1) {
      advanceClock()
      ids.push(insertItem(db, { ...ATLAS, kind: 'note', title: `Note ${i}` }))
    }
    await bootApp(db)
    await land(ids[0]!)
    const want = [...ids].reverse().map((id) => `item:${id}`)
    expect(findKeys()).toEqual(want)
    await pollTick()
    expect(findKeys()).toEqual(want)
  })

  it('V10: a target past the first page goes right after the page, then stays there across polls', async () => {
    db = freshDb()
    const ids: string[] = []
    for (let i = 0; i < 30; i += 1) {
      advanceClock()
      ids.push(insertItem(db, { ...ATLAS, kind: 'note', title: `Note ${i}` }))
    }
    await bootApp(db)
    await land(ids[0]!)
    const keys = findKeys()
    expect(keys.length).toBe(21)
    expect(keys.slice(0, 20)).toEqual([...ids].reverse().slice(0, 20).map((id) => `item:${id}`))
    expect(keys[20]).toBe(`item:${ids[0]}`)
    await pollTick()
    expect(findKeys()).toEqual(keys)
    expect(document.getElementById('findFoot')!.textContent).toContain('Show 9 more')
  })
})

describe('New marks and the count', () => {
  it('DOL-4: a project picked on the rail while on Find shows its unread notes as New', async () => {
    db = freshDb()
    advanceClock()
    const atlasNote = insertItem(db, { ...ATLAS, kind: 'note', title: 'Atlas unread note' })
    advanceClock()
    insertItem(db, { ...LEDGER, kind: 'note', title: 'Ledger unread note' })
    await bootApp(db)
    click(document.querySelector('#rail [data-project="ledger"]'))
    await settle()
    await openFindTab()
    click(chip('notes'))
    await settle()
    click(document.querySelector('#rail [data-project="atlas"]'))
    await settle()
    expect(findRowEl(`item:${atlasNote}`)?.querySelector('.find-new')?.textContent).toBe('New')
  })

  it('V11: a closed project peeked on Find shows its unread note as New; the count follows the lens', async () => {
    db = freshDb()
    advanceClock()
    const atlasNote = insertItem(db, { ...ATLAS, kind: 'note', title: 'Atlas unread note' })
    advanceClock()
    insertItem(db, { ...LEDGER, kind: 'note', title: 'Ledger unread note' })
    closeProject(db, 'atlas')
    await bootApp(db)
    expect(tabCount('find')).toBe('1')
    await openFindTab()
    click(chip('notes'))
    await settle()
    const peek = document.querySelector('#rail [data-project="atlas"]')
    expect(peek, 'the rail offers the closed project').not.toBeNull()
    click(peek)
    await settle()
    expect(findRowEl(`item:${atlasNote}`)?.querySelector('.find-new')?.textContent).toBe('New')
  })
})

describe('All leaves plans out with no query', () => {
  it('V12: plans only under Plans with no query; a query under All finds a plan', async () => {
    db = freshDb()
    advanceClock()
    upsertBoard(db, { ...LEDGER, title: 'Backups plan', rows: [{ label: 'Write the job', status: 'done' }] })
    advanceClock()
    insertItem(db, { ...ATLAS, kind: 'note', title: 'A note' })
    await bootApp(db)
    await openFindTab()
    expect(findRows().map((el) => el.dataset.findType)).toEqual(['note'])
    await findFor('backups')
    expect(findRows().map((el) => el.dataset.findType)).toContain('plan')
  })

  it('V13: a lens holding only a plan never says "Nothing here yet."', async () => {
    db = freshDb()
    advanceClock()
    upsertBoard(db, { ...LEDGER, title: 'Backups plan', rows: [{ label: 'Write the job', status: 'done' }] })
    await bootApp(db)
    await openFindTab()
    const all = status()
    click(chip('notes'))
    await settle()
    const notes = status()
    expect({ all, notes }).toEqual({ all: 'No answers, notes or finished work yet.', notes: 'No notes.' })
  })
})

describe('NL-6: the agent and stream line', () => {
  it('an open row says agent · stream', async () => {
    db = freshDb()
    const note = insertItem(db, { ...ATLAS, kind: 'note', title: 'A note' })
    await bootApp(db)
    await openFindTab()
    await openRow(`item:${note}`)
    expect(findRowEl(`item:${note}`)?.querySelector('.find-row-origin')?.textContent).toBe('claude · main')
  })
})

describe('a poll never reorders rows under the pointer', () => {
  it('keeps the painted order under Plans while the pointer rests on the list, and sorts again once it has left', async () => {
    db = freshDb()
    advanceClock()
    upsertBoard(db, { ...ATLAS, title: 'Older plan', rows: [{ label: 'One', status: 'tracked' }] })
    advanceClock()
    upsertBoard(db, { ...ATLAS, title: 'Newer plan', rows: [{ label: 'One', status: 'tracked' }] })
    await bootApp(db)
    await openFindTab()
    click(chip('plans'))
    await settle()
    const titles = () => findRows().map((el) => el.querySelector('.find-title')?.textContent)
    expect(titles()).toEqual(['Newer plan', 'Older plan'])
    const list = document.getElementById('findList')!
    list.dispatchEvent(new window.Event('pointerenter'))
    // an agent writes to the older plan: sorted, it would now come first, under the person's press
    const before = getBoardByTitle(db, 'atlas', 'Older plan')!
    advanceClock()
    upsertBoard(db, {
      ...ATLAS, title: 'Older plan', expectedVersion: before.revision,
      rows: [{ label: 'One', status: 'done', revision: before.rows[0]!.revision }, { label: 'Two', status: 'tracked' }],
    })
    await pollTick()
    expect(titles()).toEqual(['Newer plan', 'Older plan'])
    list.dispatchEvent(new window.Event('pointerleave'))
    advanceClock()
    insertItem(db, { ...ATLAS, kind: 'note', title: 'Something else changed' })
    await pollTick()
    expect(titles()).toEqual(['Older plan', 'Newer plan'])
  })
})

describe('the Note editor on a Find row', () => {
  it('Escape in an empty editor ends it: the row closes and reopening it shows no editor', async () => {
    db = freshDb()
    advanceClock()
    const note = insertItem(db, { ...ATLAS, kind: 'note', title: 'A note' })
    await bootApp(db)
    await openFindTab()
    const k = `item:${note}`
    await openRow(k)
    click(buttonLabelled('Note', findRowEl(k)!.querySelector('.find-row-body')!))
    await settle()
    const box = noteEditor(findRowEl(k))!
    box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await settle()
    expect(findRowEl(k)!.querySelector('.find-row-body')).toBeNull()
    await openRow(k)
    expect(findRowEl(k)!.querySelector('.note-editor')).toBeNull()
  })
})
