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

  it('cold-opens Needs you across all projects, agents, and action types', async () => {
    const d = open()
    insertItem(d, { project: 'alpha', stream: 'main', agent: 'claude', kind: 'question', title: 'alpha decision' })
    advanceClock()
    upsertBoard(d, {
      project: 'beta',
      stream: 'main',
      agent: 'copilot',
      title: 'Beta launch',
      rows: [{
        label: 'beta task',
        status: 'blocked',
        action_owner: 'task',
        note: 'The handoff is ready.',
        next_step: 'Complete the handoff.',
        impact: 'Unblocks launch.',
      }],
    })
    localStorage.setItem('agent-inbox-project-filter', 'alpha')
    localStorage.setItem('agent-inbox-agent-filter', 'claude')

    await bootApp(d)

    expect(document.querySelector('.tab[data-tab="needsYou"]')?.getAttribute('aria-selected')).toBe('true')
    expect(document.querySelector('#rail [data-project="__all__"]')?.getAttribute('aria-selected')).toBe('true')
    expect((document.getElementById('agentSelect') as HTMLSelectElement).value).toBe('')
    expect(rowTitles().sort()).toEqual(['alpha decision', 'beta task'])
    expect(document.querySelector('.header-toggle.active')?.textContent).toBe('All')
    expect(document.querySelector('.nrow[data-open="1"]')).toBeNull()
    expect(localStorage.getItem('agent-inbox-project-filter')).toBeNull()
    expect(localStorage.getItem('agent-inbox-agent-filter')).toBeNull()
  })

  it('uses the editorial navigation and plain-language queue vocabulary', async () => {
    const d = open()
    insertItem(d, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Choose the launch window',
    })
    advanceClock()
    upsertBoard(d, {
      project: 'beta',
      stream: 'main',
      agent: 'copilot',
      title: 'Release plan',
      rows: [{
        label: 'Approve the rollout',
        status: 'blocked',
        action_owner: 'approval',
        note: 'The release is ready.',
        next_step: 'Approve the rollout.',
        impact: 'Unblocks publishing.',
      }],
    })

    await bootApp(d)

    expect(document.querySelector('.brand')?.textContent).toContain('Agent Inbox')
    expect(document.getElementById('pageTitle')?.textContent).toBe('Your queue')
    expect([...document.querySelectorAll('#tabs .tab')].map((tab) => tab.childNodes[0]?.textContent))
      .toEqual(['Inbox', 'Plans', 'Notes', 'History'])
    expect(document.querySelector('#needsYouList .tab-header')?.textContent)
      .toContain('AllDecisionsTo doUpdatesSortCurrent priorityAsked newestAsked oldestHandoffsReview queue')
    expect(document.querySelector('#needsYouList')?.textContent).not.toContain('blocked')
    expect(document.querySelector('#needsYouList')?.textContent).not.toContain('Agent acts after approval')
    expect(document.querySelector('#needsYouList')?.textContent).not.toContain('🚧')
    expect(document.querySelector('#needsYouList')?.textContent).toContain('Ready after approval')
  })

  it('restores pane widths and lets the keyboard resize or reset both splits', async () => {
    const d = open()
    setViewport('wide')
    localStorage.setItem('agent-inbox-sidebar-width', '260')
    localStorage.setItem('agent-inbox-inspector-width', '540')

    await bootApp(d)

    const root = document.documentElement.style
    const sidebar = document.getElementById('sidebarResize')!
    const inspector = document.getElementById('inspectorResize')!
    expect(root.getPropertyValue('--sidebar-width')).toBe('260px')
    expect(root.getPropertyValue('--inspector-width')).toBe('540px')
    expect(sidebar.getAttribute('aria-valuenow')).toBe('260')
    expect(inspector.getAttribute('aria-valuenow')).toBe('540')

    inspector.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    expect(root.getPropertyValue('--inspector-width')).toBe('556px')
    expect(localStorage.getItem('agent-inbox-inspector-width')).toBe('556')

    sidebar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(root.getPropertyValue('--sidebar-width')).toBe('276px')
    expect(localStorage.getItem('agent-inbox-sidebar-width')).toBe('276')

    inspector.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    sidebar.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(root.getPropertyValue('--inspector-width')).toBe('520px')
    expect(root.getPropertyValue('--sidebar-width')).toBe('220px')
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
  it('keeps compact project labels readable at a narrow viewport', async () => {
    const d = open()
    insertItem(d, { project: 'alpha-project', stream: 'main', agent: 'claude', kind: 'question', title: 'q' })

    // BEFORE boot: `layout` is read at app.js module top level.
    setViewport('narrow')
    await bootApp(d)

    const label = document.querySelector('#rail button.rail-tab[data-project="alpha-project"] .rail-name')
    expect(label?.textContent).toBe('alpha project')
    // the full name stays reachable — colour/shape is never the only carrier (§2)
    expect(document.querySelector('#rail button.rail-tab[data-project="alpha-project"]')?.getAttribute('aria-label')).toBe('alpha-project')
  })

  it('keeps full project names at a wide viewport', async () => {
    const d = open()
    insertItem(d, { project: 'alpha', stream: 'main', agent: 'claude', kind: 'question', title: 'q' })

    setViewport('wide')
    await bootApp(d)

    expect(document.querySelector('#rail button.rail-tab[data-project="alpha"] .rail-name')?.textContent).toBe('alpha')
  })
})
