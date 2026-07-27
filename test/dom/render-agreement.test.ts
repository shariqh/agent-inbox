// @vitest-environment jsdom
// test/dom/render-agreement.test.ts
// The four render-level IMPORTANTs from commit 4f12144, stated as the tenets they
// serve rather than as source text:
//
//   I1 — the triage deck ran a SECOND attention predicate of its own, so it could read
//        "1 of 5" while the badge read 0. Tenet 3: ONE attention set.
//   I2 — an empty state claimed "no matches … or in any other tab" directly above a
//        collapsed fold holding the match. Tenet 2: the signal has to be honest.
//   I3 — read-marking stamped now() unconditionally, marking read every note behind the
//        pager AND every note the rail filter was hiding. §8: the count comes down
//        after you LOOK, not after the tab happens to be open.
//   I4 — an answered-but-not-yet-picked-up open question was rendered by NO tab while
//        search still counted it. Tenet 4: ranked, not uniform — but never invisible.
import { describe, it, expect, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import {
  annotateBoardRow, archiveBoard, insertItem, listBoards, listItems, markBoardRead,
  markReplySeen, replyItem, upsertBoard,
} from '../../src/store.js'
import {
  advanceClock, badgeCount, bootApp, click, freshDb, pollTick, row, rowTitles,
  searchFor, settle, tabCount, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

function open(): Database.Database {
  db = freshDb()
  return db
}

const AGENT = { project: 'alpha', stream: 'main', agent: 'claude' } as const

const createdAt = (d: Database.Database, id: string): string =>
  listItems(d).find((i) => i.id === id)!.created_at

describe('I1 · the triage deck runs the same attention predicate as the badge', () => {
  it('says "all clear" when the badge is 0', async () => {
    const d = open()
    // a blocked row the human already annotated AND the agent already saw is NOT
    // attention (attention.js isBlockedRowAttention) — the deck used to count it anyway
    upsertBoard(d, {
      ...AGENT, title: 'rollout',
      rows: [{ label: 'needs a call', status: 'blocked', note: 'which region?' }],
    })
    const board = listBoards(d)[0]!
    annotateBoardRow(d, board.rows[0]!.id, 'use eu-west')
    advanceClock()
    markBoardRead(d, board.id) // last_read_at now beats annotated_at → annotation_unseen false

    await bootApp(d)
    expect(document.title, 'the badge must rest at zero').toBe('Agent Inbox')
    expect(badgeCount()).toBe(0)
    expect(tabCount('needsYou')).toBe('')

    click(document.querySelector('.triage-btn'))
    await settle()

    const lb = document.getElementById('lightbox')
    expect(lb?.hidden).toBe(false)
    expect(lb?.querySelector('.lb-count')?.textContent, 'the deck size must equal the badge count').toBe('all clear')
  })

  it('opens a deck exactly as big as the badge when there IS work', async () => {
    const d = open()
    insertItem(d, { ...AGENT, kind: 'question', title: 'ship it?' })
    advanceClock()
    upsertBoard(d, {
      ...AGENT, title: 'rollout',
      rows: [{ label: 'needs a call', status: 'blocked', note: 'which region?' }],
    })

    await bootApp(d)
    expect(badgeCount()).toBe(2)

    click(document.querySelector('.triage-btn'))
    await settle()

    expect(document.querySelector('#lightbox .lb-count')?.textContent).toBe('1 of 2')
  })
})

describe('I4 · an answered question awaiting pickup is still rendered somewhere', () => {
  it('renders as a Needs-you row once the agent has picked the reply up', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'ship it?' })
    replyItem(d, id, 'yes')
    advanceClock()
    markReplySeen(d, id, listItems(d).find((i) => i.id === id)!.replied_at)

    await bootApp(d)

    expect(rowTitles()).toEqual(['ship it?'])
    expect(row(id)?.className).toContain('answered')
    // …but it is NOT attention: answering it is what took it out of the badge
    expect(badgeCount()).toBe(0)
    expect(tabCount('needsYou')).toBe('')
  })
})

describe('I2 · an empty state must never deny a match the fold below is holding', () => {
  it('Boards prints no "No boards." when the only match is archived', async () => {
    const d = open()
    // FIXTURE WARNING: store.ts's syncBoardStatus auto-archives any board whose rows are
    // all `done`, so give it a non-done row and archive it explicitly — otherwise
    // listBoards() comes back empty and the test passes for the wrong reason.
    upsertBoard(d, {
      ...AGENT, title: 'migration matrix',
      rows: [{ label: 'step one', status: 'tracked' }],
    })
    archiveBoard(d, listBoards(d, { status: 'active' })[0]!.id)
    advanceClock()
    insertItem(d, { ...AGENT, kind: 'question', title: 'unrelated question' })

    await bootApp(d)
    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    await searchFor('migration')

    expect(document.querySelector('#boards .boards p.empty'), 'claimed "no boards" above the fold holding the match').toBeNull()
    const fold = document.querySelector('#boards .archived-fold')
    expect(fold).not.toBeNull()
    expect(fold?.textContent).toContain('migration matrix')
  })

  it('Needs-you prints no "no matches" when the only match is in the stale fold', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'ancient question' })
    advanceClock()
    insertItem(d, { ...AGENT, kind: 'question', title: 'unrelated' })
    await bootApp(d)
    expect(row(id), 'precondition: it starts in the active list').not.toBeNull()

    // move the CLOCK, not the row: item created_at cannot be backdated through
    // store.ts, and store.ts is the only door to SQLite. attention.js STALE_MS = 72h.
    advanceClock(73 * 60 * 60 * 1000)
    await pollTick()
    expect(document.querySelector('#needsYouList .stale-fold'), 'precondition: it aged into the fold').not.toBeNull()

    await searchFor('ancient')

    expect(document.querySelector('#needsYouList > p.empty'), 'denied a match the stale fold is holding').toBeNull()
    expect(document.querySelector('#needsYouList .stale-fold')?.textContent).toContain('ancient question')
  })
})

describe('I3 · the notes watermark never advances past a note that stayed hidden', () => {
  it('stops below a note the rail filter was hiding', async () => {
    const d = open()
    // alpha-old · beta-hidden · alpha-newest. Selecting `alpha` renders the two alpha
    // notes and hides the BETA one — which is NEWER than alpha-old. seenWatermark may
    // therefore only advance as far as alpha-old; the old rule (stamp now() while the
    // tab is open) would have marked the hidden beta note read as well.
    //
    // The pager cannot exercise this branch at all: notes render newest-first, so the
    // hidden tail is always OLDER than everything on screen and `safe` comes out empty.
    const oldest = insertItem(d, { ...AGENT, kind: 'note', title: 'alpha old' })
    advanceClock()
    const hidden = insertItem(d, { project: 'beta', stream: 'main', agent: 'claude', kind: 'note', title: 'beta hidden' })
    advanceClock()
    const newest = insertItem(d, { ...AGENT, kind: 'note', title: 'alpha newest' })

    await bootApp(d)
    click(document.querySelector('#rail button.rail-tab[data-project="alpha"]'))
    await settle()
    click(document.querySelector('.tab[data-tab="notes"]'))
    // selectTab only routes; read-marking happens on the next render() the poll drives
    await pollTick()

    expect(document.querySelectorAll('#notes .item').length, 'both alpha notes rendered').toBe(2)
    expect(
      localStorage.getItem('agent-inbox-notes-seen'),
      'the watermark must stop below the newer note the rail filter hid',
    ).toBe(createdAt(d, oldest))

    // Issue #31.2 added the second read-mark, and it is what this case now turns on.
    // The watermark alone had to leave `alpha newest` looking unread even though it
    // was literally on screen — that under-marking is the bug §8 and tenet 2 forbid
    // (a tab count that can only grow), so the count DOES come down here now.
    // What I3 actually protects is the note the rail filter hid, and the per-id set
    // states that directly instead of inferring it from an inflated count.
    const seenIds = JSON.parse(localStorage.getItem('agent-inbox-notes-seen-ids') ?? '[]') as string[]
    expect([...seenIds].sort(), 'only what was on screen may be marked read').toEqual([oldest, newest].sort())
    expect(seenIds, 'the rail-hidden note must stay unread').not.toContain(hidden)
    expect(tabCount('notes'), 'both alpha notes were read, and alpha is the scope in view').toBe('')
  })
})
