// @vitest-environment jsdom
// test/dom/focus-item.test.ts
// C1 (commit 21b16d0) — the deep-link freeze, asserted through the real
// hashchange → applyFocusHash → focusItem path instead of through source text.
//
// The bug: focusItem() called setOpenRow(id) for EVERY target. openRowId feeds
// shouldSuspendRender(), and its only clearing path is toggleRow — an affordance that
// exists only on a rendered `.nrow`. A board id (which electron/main.cjs deep-links for
// a blocked row, one notification click away) or a notes/done item id has none, so the
// poll suspended FOREVER: load() kept updating lastData while the DOM, all four tab
// counts and document.title froze.
//
// The companion source pins (which reconciliation function app.js calls, and that
// setOpenRow stays the single writer of openRowId) live in test/critical-fixes.test.ts.
import { describe, it, expect, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, upsertBoard, listBoards } from '../../src/store.js'
import {
  advanceClock, badgeCount, bootApp, click, freshDb, navigateToHash, pollTick,
  row, rowTitles, rows, settle, tabCount, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

function open(): Database.Database {
  db = freshDb()
  return db
}

const AGENT = { project: 'alpha', stream: 'main', agent: 'claude' } as const

/** one open question + one board carrying a blocked row (the electron deep-link shape) */
function seedQuestionAndBlockedBoard(d: Database.Database): { boardId: string } {
  insertItem(d, { ...AGENT, kind: 'question', title: 'first question' })
  advanceClock()
  upsertBoard(d, {
    ...AGENT,
    title: 'rollout',
    rows: [{ label: 'blocked row', status: 'blocked', note: 'needs a call' }],
  })
  return { boardId: listBoards(d)[0]!.id }
}

describe('C1 · a deep link must never freeze the poll', () => {
  it('a cold-launch deep link overrides stale filters and focuses its target', async () => {
    const d = open()
    insertItem(d, { ...AGENT, kind: 'question', title: 'alpha question' })
    advanceClock()
    const betaId = insertItem(d, {
      project: 'beta',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'beta question',
    })
    localStorage.setItem('agent-inbox-project-filter', 'alpha')
    localStorage.setItem('agent-inbox-agent-filter', 'claude')
    location.hash = `#item/${betaId}`

    await bootApp(d)

    expect(rowTitles()).toEqual(['beta question'])
    expect(document.querySelector('#rail [data-project="beta"]')?.getAttribute('aria-selected')).toBe('true')
    expect((document.getElementById('agentSelect') as HTMLSelectElement).value).toBe('')
    expect(row(betaId)?.dataset['open']).toBe('1')
  })

  it('a deep link to a BOARD leaves the poll running', async () => {
    const d = open()
    const { boardId } = seedQuestionAndBlockedBoard(d)
    await bootApp(d)
    expect(badgeCount()).toBe(2) // the question + the blocked row

    navigateToHash(`#item/${boardId}`)
    await settle()

    advanceClock()
    insertItem(d, { ...AGENT, kind: 'question', title: 'SECOND question' })
    await pollTick()

    expect(rowTitles()).toContain('SECOND question')
    expect(document.title).toBe('(3) Agent Inbox')
    expect(tabCount('needsYou')).toBe('3')
  })

  it('a deep link to a NOTES item leaves the poll running', async () => {
    const d = open()
    insertItem(d, { ...AGENT, kind: 'question', title: 'first question' })
    advanceClock()
    const noteId = insertItem(d, { ...AGENT, kind: 'note', title: 'an assumption' })
    await bootApp(d)

    navigateToHash(`#item/${noteId}`)
    await settle()
    expect(document.querySelector('#notes')?.hasAttribute('hidden'), 'the deep link should land on the Notes tab').toBe(false)

    advanceClock()
    insertItem(d, { ...AGENT, kind: 'question', title: 'SECOND question' })
    await pollTick()

    expect(rowTitles()).toContain('SECOND question')
    expect(badgeCount()).toBe(2)
  })

  it('a deep link to a real Needs-you row still opens it', async () => {
    // the fix must not degenerate into "never open anything"
    const d = open()
    const qid = insertItem(d, { ...AGENT, kind: 'question', title: 'a question' })
    await bootApp(d)

    navigateToHash(`#item/${qid}`)
    await settle()

    expect(row(qid)?.dataset['open']).toBe('1')
    expect(row(qid)?.querySelector('.nrow-card')).not.toBeNull()
    expect(document.querySelectorAll('.nrow-card').length, 'single-open accordion').toBe(1)
  })
})

describe('C1 layer 2 · render() reconciles openRowId against what it just rendered', () => {
  it('switching project drops the open row from a project the rail no longer shows', async () => {
    const d = open()
    const aId = insertItem(d, { ...AGENT, kind: 'question', title: 'alpha question' })
    advanceClock()
    insertItem(d, { project: 'beta', stream: 'main', agent: 'claude', kind: 'question', title: 'beta question' })
    await bootApp(d)

    click(row(aId))
    await settle()
    expect(document.querySelectorAll('.nrow[data-open="1"]').length).toBe(1)

    click(document.querySelector('#rail button.rail-tab[data-project="beta"]'))
    await settle()

    // the row is gone from the list, so nothing can ever toggle it shut again —
    // reconcileOpenRow (poll.js) is what stops that suspending the poll forever
    expect(rowTitles()).toEqual(['beta question'])
    expect(document.querySelectorAll('.nrow[data-open="1"]').length).toBe(0)

    advanceClock()
    insertItem(d, { project: 'beta', stream: 'main', agent: 'claude', kind: 'question', title: 'beta second' })
    await pollTick()

    expect(rowTitles().sort()).toEqual(['beta question', 'beta second'])
    expect(rows().length).toBe(2)
  })
})
