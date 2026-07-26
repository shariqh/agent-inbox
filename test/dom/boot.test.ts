// @vitest-environment jsdom
// test/dom/boot.test.ts
// The smoke test for the whole harness, plus the first MECHANICAL enforcement of
// the "viewer escapes all agent-authored text" invariant — until now that had only
// public/esc.js unit coverage plus manual reading of ~40 interpolation sites.
import { describe, it, expect, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, upsertBoard, listBoards, annotateBoardRow } from '../../src/store.js'
import {
  advanceClock, badgeCount, bootApp, click, freshDb, pollTick, rowTitles, rows,
  setViewport, settle, tabCount, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

function open(): Database.Database {
  db = freshDb()
  return db
}

describe('viewer boots against a real DB', () => {
  it('renders the seeded question, sets the (1) badge and the Needs-you tab count', async () => {
    const d = open()
    insertItem(d, { project: 'alpha', stream: 'main', agent: 'claude', kind: 'question', title: 'hello' })

    await bootApp(d)

    expect(rowTitles()).toEqual(['hello'])
    expect(document.title).toBe('(1) Agent Inbox')
    expect(badgeCount()).toBe(1)
    expect(tabCount('needsYou')).toBe('1')
  })

  it('logs nothing to console.error on a clean boot, and #status stays empty', async () => {
    const d = open()
    insertItem(d, { project: 'alpha', stream: 'main', agent: 'claude', kind: 'question', title: 'hello' })

    await bootApp(d)

    // The console.error assertion itself lives in useDomTest()'s afterEach — it is the
    // guard on the guard: load()'s catch swallows every render() throw, so a broken
    // render presents as the far more confusing "nothing rendered".
    expect(document.getElementById('status')?.textContent).toBe('')
    expect(rows().length).toBe(1)
  })

  it('picks up an item inserted between polls', async () => {
    const d = open()
    insertItem(d, { project: 'alpha', stream: 'main', agent: 'claude', kind: 'question', title: 'first' })
    await bootApp(d)
    expect(rowTitles()).toEqual(['first'])

    advanceClock()
    insertItem(d, { project: 'alpha', stream: 'main', agent: 'claude', kind: 'question', title: 'second' })
    await pollTick()

    expect(rowTitles().sort()).toEqual(['first', 'second'])
    expect(badgeCount()).toBe(2)
  })
})

const XSS = '<img src=x onerror=alert(1)>'
const BREAKOUT = '</script><script>alert(2)</script>'

describe('agent-authored text is escaped end-to-end', () => {
  it('an item title, a board title, a row label/note and an annotation never become live nodes', async () => {
    const d = open()
    insertItem(d, {
      project: 'alpha', stream: 'main', agent: 'claude', kind: 'question',
      title: XSS, detail: BREAKOUT, context: XSS,
    })
    upsertBoard(d, {
      project: 'alpha', stream: 'main', agent: 'claude', title: XSS,
      rows: [{ label: XSS, status: 'blocked', note: BREAKOUT, context: XSS }],
    })
    const rowId = listBoards(d)[0]!.rows[0]!.id
    annotateBoardRow(d, rowId, XSS)

    await bootApp(d)
    // expand the Needs-you row (the item card) and open the Boards tab
    click(rows()[0])
    await settle()
    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()

    const live = document.querySelectorAll('#needsYouList img, #needsYouList script, #boards img, #boards script')
    expect(live.length, 'agent-authored markup became live DOM').toBe(0)
    // …and the payload survived as literal text, so escaping is not silent deletion
    expect(document.querySelector('#needsYouList .nrow-title')?.textContent).toBe(XSS)
    expect(document.querySelector('#boards .board-title')?.textContent).toContain(XSS)
    expect(document.querySelector('#boards .row-label')?.textContent).toBe(XSS)
  })
})

describe('spec §7 · a rail filter narrows the LIST, never the GLOBAL signal', () => {
  it('selecting one project shortens #needsYouList while the title badge stays global', async () => {
    const d = open()
    insertItem(d, { project: 'alpha', stream: 'main', agent: 'claude', kind: 'question', title: 'a-question' })
    advanceClock()
    insertItem(d, { project: 'beta', stream: 'main', agent: 'claude', kind: 'question', title: 'b-question' })

    await bootApp(d)
    expect(rows().length).toBe(2)
    expect(badgeCount()).toBe(2)

    click(document.querySelector('#rail button.rail-tab[data-project="alpha"]'))
    await settle()

    expect(rowTitles()).toEqual(['a-question'])
    expect(badgeCount(), 'the rail must never scope the badge').toBe(2)
    expect(tabCount('needsYou'), 'nor the Needs-you tab count').toBe('2')
  })
})

describe('spec §14 · the JS half of the responsive rail', () => {
  it('collapses rail labels to monograms at a narrow viewport', async () => {
    const d = open()
    insertItem(d, { project: 'alpha', stream: 'main', agent: 'claude', kind: 'question', title: 'q' })

    // BEFORE boot: `layout` is read at app.js module top level.
    setViewport('narrow')
    await bootApp(d)

    const label = document.querySelector('#rail button.rail-tab[data-project="alpha"] .rail-name')
    expect(label?.textContent).toBe('AL')
    // the full name stays reachable — colour/shape is never the only carrier (§2)
    expect(document.querySelector('#rail button.rail-tab[data-project="alpha"]')?.getAttribute('aria-label')).toBe('alpha')
  })

  it('keeps full project names at a wide viewport', async () => {
    const d = open()
    insertItem(d, { project: 'alpha', stream: 'main', agent: 'claude', kind: 'question', title: 'q' })

    setViewport('wide')
    await bootApp(d)

    expect(document.querySelector('#rail button.rail-tab[data-project="alpha"] .rail-name')?.textContent).toBe('alpha')
  })
})
