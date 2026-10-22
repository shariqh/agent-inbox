// @vitest-environment jsdom
// Issue #247: "Pin for later" in the More responses menu sets an unanswered ask
// aside with no return time. The one attention predicate drops it, so every
// count follows at once, and it waits in the Later section (slice 3, on by
// default) until the human brings it back or the ask ends. With the Later
// section turned off, existing pins wait in a "pinned" fold beside the snoozed
// fold (slice 2's layout); later-section.test.ts covers the setting itself.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { attentionEntries } from '../../public/attention.js'
import type { AttentionBoard, AttentionItem } from '../../public/attention.js'
import {
  advanceBoardRow, answerItem, getBoard, getItem, insertItem, pinBoardRow, pinItem, snoozeItem, updateBoardRow, upsertBoard,
} from '../../src/store.js'
import {
  advanceClock, answerInput, badgeCount, bootApp, buttonLabelled, click, freshDb, navigateToHash, pollTick, row,
  rows, sendButton, settle, showInbox, tabCount, type, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'claude' } as const
const HOUR = 60 * 60_000

function open(): Database.Database {
  db = freshDb()
  return db
}

const question = (d: Database.Database, title = 'Merge?') => insertItem(d, {
  ...AGENT,
  kind: 'question',
  title,
  detail: 'All gates are green.',
  next_step: `Choose: ${title}`,
  action_owner: 'approval',
  impact: 'Unblocks implementation.',
  options: [{ label: 'Merge', recommended: true }, { label: 'Hold' }],
})

const blockedRow = (label = 'Install test') => ({
  label,
  status: 'blocked' as const,
  note: 'The 1.4 build is ready.',
  next_step: `Do ${label}.`,
  action_owner: 'task' as const,
  impact: 'Gates the release.',
})

const fold = (name: 'pinned' | 'snoozed') => document.querySelector<HTMLDetailsElement>(`#needsYouList .${name}-fold`)
const openFold = (name: 'pinned' | 'snoozed') => {
  const el = fold(name)!
  el.open = true
  el.dispatchEvent(new Event('toggle'))
}
const later = () => document.querySelector<HTMLDetailsElement>('#needsYouList .later-section')
const openLater = () => {
  const el = later()!
  el.open = true
  el.dispatchEvent(new Event('toggle'))
}
const laterTitle = () => later()?.querySelector('.later-title')?.textContent ?? null
const laterOff = () => localStorage.setItem('agent-inbox-later-section', 'false')

function chipText(id: string): string {
  const chip = row(id)?.querySelector('.chip')
  return [...(chip?.childNodes ?? [])]
    .filter((node) => node.nodeType === 3)
    .map((node) => node.textContent ?? '')
    .join('')
    .trim()
}

const menuChoices = (id: string) => [...(row(id)?.querySelectorAll('.disposition-menu:not(.wait-menu) .disposition-actions button') ?? [])]
  .map((button) => button.textContent)

describe('Pin for later (#247)', () => {
  it('pins a question from More responses into Later, out of every count, and brings it back', async () => {
    const d = open()
    const id = question(d)
    const before = getItem(d, id)!
    await bootApp(d)
    await showInbox()
    expect(badgeCount()).toBe(1)
    expect(tabCount('needsYou')).toBe('1')

    click(row(id))
    await settle()
    expect(menuChoices(id)[0]).toBe('Pin for later')
    advanceClock(60_000)
    click(buttonLabelled('Pin for later', row(id)!))
    await settle()

    expect(getItem(d, id)).toMatchObject({ pinned_at: expect.any(String), updated_at: before.updated_at })
    expect(badgeCount()).toBe(0)
    expect(tabCount('needsYou')).toBe('')
    expect(row(id)?.closest('.later-section')).toBe(later())
    expect(laterTitle()).toBe('Later · 1')
    expect(later()?.open).toBe(false)
    expect(chipText(id)).toBe('Pinned moments ago')

    advanceClock(2 * 24 * HOUR)
    await pollTick()
    expect(chipText(id)).toBe('Pinned 2d ago')

    click(buttonLabelled('Back to inbox', row(id)!))
    await settle()
    expect(getItem(d, id)!.pinned_at).toBeNull()
    expect(badgeCount()).toBe(1)
    expect(later()).toBeNull()
    expect(row(id)?.closest('details')).toBeNull()
  })

  it('pins a blocked row with its row and board revisions, and moves neither', async () => {
    const d = open()
    upsertBoard(d, { ...AGENT, title: 'Release', rows: [blockedRow()] })
    const before = getBoard(d, 'alpha', 'Release')!
    const rowId = before.rows[0]!.id
    const bridge = await bootApp(d)
    await showInbox()
    expect(badgeCount()).toBe(1)

    click(row(rowId))
    await settle()
    click(buttonLabelled('Pin for later', row(rowId)!))
    await settle()

    const posted = bridge.posts.filter((post) => post.url.endsWith('/later'))
    expect(posted.map((post) => [post.url, JSON.parse(String(post.init?.body))])).toEqual([[
      `/api/boards/${before.id}/rows/${rowId}/later`,
      { pinned: true, expected_revision: before.rows[0]!.revision, expected_board_version: before.revision },
    ]])
    const after = getBoard(d, 'alpha', 'Release')!
    expect(after.rows[0]).toMatchObject({
      pinned_at: expect.any(String),
      revision: before.rows[0]!.revision,
      updated_at: before.rows[0]!.updated_at,
    })
    expect(after.revision).toBe(before.revision)
    expect(badgeCount()).toBe(0)
    expect(row(rowId)?.closest('.later-section')).not.toBeNull()

    click(buttonLabelled('Back to inbox', row(rowId)!))
    await settle()
    expect(getBoard(d, 'alpha', 'Release')!.rows[0]!.pinned_at).toBeNull()
    expect(badgeCount()).toBe(1)
    expect(row(rowId)?.closest('details')).toBeNull()
  })

  it('offers the pin only on an unanswered ask that is not already pinned', async () => {
    const d = open()
    const answered = question(d, 'Answered in chat?')
    expect(answerItem(d, answered, 'Merge')).toMatchObject({ ok: true })
    const pinned = question(d, 'Already pinned?')
    expect(pinItem(d, pinned, true)).toBe(true)
    await bootApp(d)
    await showInbox()

    click(row(answered))
    await settle()
    expect(answerInput(answered), 'the correction form is still there').not.toBeNull()
    expect(menuChoices(answered)).not.toContain('Pin for later')

    openLater()
    click(row(pinned))
    await settle()
    expect(menuChoices(pinned)).not.toContain('Pin for later')
    expect(menuChoices(pinned)).toContain('Tomorrow')
  })

  it('with the Later section off, keeps the snoozed and pinned folds side by side, each with its own way back', async () => {
    laterOff()
    const d = open()
    const stale = question(d, 'Nobody is listening')
    advanceClock(73 * HOUR)
    const snoozed = question(d, 'Snoozed?')
    const pinned = question(d, 'Pinned?')
    snoozeItem(d, snoozed, new Date(Date.now() + 4.5 * HOUR).toISOString())
    pinItem(d, pinned, true)
    await bootApp(d)
    await showInbox()

    const folds = [...document.querySelectorAll<HTMLDetailsElement>('#needsYouList details')]
    expect(folds.map((el) => el.querySelector('summary')?.textContent)).toEqual([
      'snoozed (1)', 'pinned (1)', 'stale — decide later (1)',
    ])
    expect(row(snoozed)?.closest('.snoozed-fold')).not.toBeNull()
    expect(row(pinned)?.closest('.pinned-fold')).not.toBeNull()
    expect(row(stale)?.closest('.stale-fold')).not.toBeNull()
    expect(chipText(snoozed)).toBe('Back in 4h')
    expect(buttonLabelled('Wake now', row(snoozed)!)).not.toBeNull()
    expect(buttonLabelled('Back to inbox', row(snoozed)!)).toBeNull()
    expect(buttonLabelled('Back to inbox', row(pinned)!)).not.toBeNull()
    expect(buttonLabelled('Wake now', row(pinned)!)).toBeNull()
    expect(buttonLabelled('Back to inbox', row(stale)!)).toBeNull()
    expect(badgeCount()).toBe(0)
  })

  it('returns a snoozed ask on its own once the clock passes, but never a pinned one', async () => {
    const d = open()
    const snoozed = question(d, 'Snoozed?')
    const pinned = question(d, 'Pinned?')
    snoozeItem(d, snoozed, new Date(Date.now() + HOUR).toISOString())
    pinItem(d, pinned, true)
    await bootApp(d)
    await showInbox()
    expect(badgeCount()).toBe(0)

    advanceClock(2 * HOUR)
    await pollTick()
    expect(badgeCount()).toBe(1)
    expect(row(snoozed)?.closest('details')).toBeNull()
    expect(row(pinned)?.closest('.later-section')).not.toBeNull()
  })

  it('with the Later section off, keeps the pinned fold open, its open card and the card draft across polls', async () => {
    laterOff()
    const d = open()
    const id = question(d)
    pinItem(d, id, true)
    await bootApp(d)
    await showInbox()

    openFold('pinned')
    click(row(id))
    await settle()
    const card = row(id)?.querySelector('.nrow-card')
    expect(card).toBeTruthy()

    advanceClock()
    question(d, 'Something new')
    await pollTick()
    expect(row(id)?.querySelector('.nrow-card')).not.toBe(card)
    expect(fold('pinned')?.open).toBe(true)
    expect(row(id)?.dataset.open).toBe('1')

    type(answerInput(id), 'Hold until Friday')
    advanceClock()
    question(d, 'Another one')
    await pollTick()
    expect(answerInput(id)?.value).toBe('Hold until Friday')
    expect(fold('pinned')?.open).toBe(true)
  })

  it('with the Later section off, answering from inside the pinned fold clears the pin and moves the ask to the replied foot', async () => {
    laterOff()
    const d = open()
    const id = question(d)
    pinItem(d, id, true)
    await bootApp(d)
    await showInbox()

    openFold('pinned')
    click(row(id))
    await settle()
    type(answerInput(id), 'Merge it')
    click(sendButton(id))
    await settle()

    expect(getItem(d, id)).toMatchObject({ reply: 'Merge it', pinned_at: null })
    expect(fold('pinned')).toBeNull()
    expect(row(id)?.closest('details')).toBeNull()
    expect(row(id)?.classList.contains('answered')).toBe(true)
    expect(badgeCount()).toBe(0)
  })

  it('with the Later section off, opens the pinned fold for a deep link into a pinned ask', async () => {
    laterOff()
    const d = open()
    const id = question(d)
    pinItem(d, id, true)
    await bootApp(d)

    navigateToHash(`#item/${id}`)
    await settle()
    await pollTick()
    expect(row(id)?.closest<HTMLDetailsElement>('.pinned-fold')?.open).toBe(true)
    expect(row(id)?.dataset.open).toBe('1')
  })

  it('brings a pinned row back to Needs you when the agent starts a new action', async () => {
    const d = open()
    upsertBoard(d, { ...AGENT, title: 'Release', rows: [blockedRow()] })
    let board = getBoard(d, 'alpha', 'Release')!
    const rowId = board.rows[0]!.id
    expect(pinBoardRow(d, rowId, true, board.rows[0]!.revision, board.revision)).toBe(true)
    await bootApp(d)
    await showInbox()
    expect(row(rowId)?.closest('.later-section')).not.toBeNull()
    expect(badgeCount()).toBe(0)

    board = getBoard(d, 'alpha', 'Release')!
    expect(advanceBoardRow(d, {
      project: 'alpha', title: 'Release', label: 'Install test', agent: 'claude',
      expectedBoardVersion: board.revision, expectedRevision: board.rows[0]!.revision,
      note: 'A new build is ready.', next_step: 'Install the new build.', action_owner: 'task', impact: 'Gates the release.',
    })).toMatchObject({ ok: true })
    await pollTick()
    expect(row(rowId)?.closest('details')).toBeNull()
    expect(badgeCount()).toBe(1)
  })

  it('says why when a stale click cannot pin a row, and pins nothing', async () => {
    const d = open()
    upsertBoard(d, { ...AGENT, title: 'Release', rows: [blockedRow()] })
    const board = getBoard(d, 'alpha', 'Release')!
    const rowId = board.rows[0]!.id
    await bootApp(d)
    await showInbox()
    click(row(rowId))
    await settle()
    updateBoardRow(d, {
      ...AGENT, title: 'Release', label: 'Install test',
      expectedBoardVersion: board.revision, expectedRevision: board.rows[0]!.revision,
      note: 'The 1.4.1 build is ready instead.',
    })

    click(buttonLabelled('Pin for later', row(rowId)!))
    await settle()
    expect(getBoard(d, 'alpha', 'Release')!.rows[0]!.pinned_at).toBeNull()
    expect(row(rowId)?.closest('details')).toBeNull()
    expect(row(rowId)?.querySelector('.write-error')?.textContent)
      .toBe('This action changed before your click; refreshed without applying it.')
  })

  it('keeps the badge, the tab count, Needs you and the dock projection in agreement with pins', async () => {
    const d = open()
    const kept = question(d, 'Still asking')
    const pinned = question(d, 'Set aside')
    upsertBoard(d, { ...AGENT, title: 'Release', rows: [blockedRow('Deploy'), blockedRow('Upload')] })
    await bootApp(d)
    await showInbox()

    const dockCount = async () => {
      const g = await (await fetch('/api/items?scope=attention')).json() as { needsYou: Array<{ items: AttentionItem[] }> }
      const boards = await (await fetch('/api/boards')).json() as AttentionBoard[]
      const closed = await (await fetch('/api/projects/closed')).json() as string[]
      return attentionEntries(g.needsYou.flatMap((group) => group.items), boards, Date.now(), [], closed).length
    }
    const surfaces = async () => ({
      badge: badgeCount(),
      tab: Number(tabCount('needsYou') || 0),
      queue: rows().filter((el) => !el.closest('details')).length,
      dock: await dockCount(),
    })
    expect(await surfaces()).toEqual({ badge: 4, tab: 4, queue: 4, dock: 4 })

    const board = getBoard(d, 'alpha', 'Release')!
    pinItem(d, pinned, true)
    pinBoardRow(d, board.rows[1]!.id, true, board.rows[1]!.revision, board.revision)
    await pollTick()
    expect(await surfaces()).toEqual({ badge: 2, tab: 2, queue: 2, dock: 2 })
    expect(laterTitle()).toBe('Later · 2')
    expect(row(kept)?.closest('details')).toBeNull()
  })
})

// #247 review: deferring an ask moves it into Later, which starts closed. A
// draft it holds still pauses the list (by design), so the draft must stay on
// screen: Later opens and the ask keeps the open card, from the list or the
// Review queue, for a pin or a snooze.
describe('a draft on a deferred ask stays in view (#247)', () => {
  const PAUSED = 'paused — updating when you\'re done'
  const lightbox = () => document.getElementById('lightbox')!
  const deckInput = () => lightbox().querySelector<HTMLTextAreaElement>('.reply-input:not(.reply-context-input)')

  function expectDraftInView(id: string, name: 'pinned' | 'snoozed', text: string) {
    expect(later()?.open, `Later is open for a ${name} ask`).toBe(true)
    expect(row(id)?.closest('.later-section')).toBe(later())
    expect(row(id)?.dataset.open, 'the ask keeps the open card').toBe('1')
    expect(answerInput(id)?.value).toBe(text)
    expect(answerInput(id)?.closest('details:not([open])')).toBeNull()
    expect(document.getElementById('pauseHint')?.hidden).toBe(false)
    expect(document.getElementById('pauseHint')?.textContent).toBe(PAUSED)
  }

  async function arriveWhilePaused(d: Database.Database) {
    advanceClock()
    const next = question(d, 'Arrived while paused')
    await pollTick()
    await pollTick()
    return next
  }

  it.each([
    ['Pin for later', 'pinned', 'question'],
    ['Not now · 4h', 'snoozed', 'question'],
    ['Pin for later', 'pinned', 'plan row'],
  ] as const)('keeps the draft in view after "%s" from the list (%s, %s)', async (choice, name, kind) => {
    const d = open()
    let id: string
    if (kind === 'question') {
      id = question(d)
    } else {
      upsertBoard(d, { ...AGENT, title: 'Release', rows: [blockedRow()] })
      id = getBoard(d, 'alpha', 'Release')!.rows[0]!.id
    }
    await bootApp(d)
    await showInbox()
    click(row(id))
    await settle()
    type(answerInput(id), 'Half an answer')
    click(buttonLabelled(choice, row(id)!))
    await settle()
    expect(badgeCount()).toBe(0)

    const next = await arriveWhilePaused(d)
    expect(badgeCount()).toBe(1)
    expectDraftInView(id, name, 'Half an answer')
    expect(row(next), 'the list stays paused while the draft exists').toBeNull()

    type(answerInput(id), '')
    await settle()
    expect(row(next), 'clearing the draft lets the list catch up').not.toBeNull()
  })

  // A row snooze moves the row revision, and a draft never answers a newer
  // revision, so the existing recovery keeps it: the unsent-responses list.
  it('keeps a plan row draft in view after a snooze, in the unsent responses', async () => {
    const d = open()
    upsertBoard(d, { ...AGENT, title: 'Release', rows: [blockedRow()] })
    const id = getBoard(d, 'alpha', 'Release')!.rows[0]!.id
    await bootApp(d)
    await showInbox()
    click(row(id))
    await settle()
    type(answerInput(id), 'Half an answer')
    click(buttonLabelled('Not now · 4h', row(id)!))
    await settle()

    const next = await arriveWhilePaused(d)
    const recovery = document.querySelector<HTMLDetailsElement>('#needsYouList .stale-drafts-fold')
    expect(recovery?.open).toBe(true)
    expect(recovery?.textContent).toContain('Half an answer')
    expect(later()?.open).toBe(true)
    expect(row(id)?.querySelector('.stale-draft')?.textContent).toContain('Preserved answer: Half an answer')
    expect(row(next), 'a recovered draft no longer pauses the list').not.toBeNull()
  })

  it.each(['question', 'plan row'] as const)('keeps the draft of a %s pinned from the Review queue in view once the deck moves on', async (kind) => {
    const d = open()
    const other = question(d, 'Reviewed next')
    advanceClock()
    let id: string
    if (kind === 'question') {
      id = question(d, 'Set aside with a draft')
    } else {
      upsertBoard(d, { ...AGENT, title: 'Release', rows: [blockedRow()] })
      id = getBoard(d, 'alpha', 'Release')!.rows[0]!.id
    }
    await bootApp(d)
    await showInbox()
    click(buttonLabelled('Review queue'))
    await settle()
    click(lightbox().querySelector('.lb-next'))
    await settle()
    type(deckInput(), 'Half an answer')
    click(buttonLabelled('Pin for later', lightbox()))
    await settle()

    expect(lightbox().hidden, 'the deck moves on').toBe(false)
    expect(lightbox().querySelector('.lb-count')?.textContent).toBe('1 of 1')
    expect(lightbox().textContent).toContain('Reviewed next')
    click(lightbox().querySelector('.lb-close'))
    await settle()

    await arriveWhilePaused(d)
    expectDraftInView(id, 'pinned', 'Half an answer')
    expect(row(other)?.dataset.open).toBeUndefined()
  })

  it('widens a list filter that would hide the ask the Review queue deferred', async () => {
    const d = open()
    const id = question(d)
    insertItem(d, { ...AGENT, project: 'beta', kind: 'question', title: 'Beta question' })
    await bootApp(d)
    await showInbox()
    click(document.querySelector('#rail button.rail-tab[data-project="beta"]'))
    await settle()
    expect(row(id)).toBeNull()

    click(buttonLabelled('Review queue'))
    await settle()
    expect(lightbox().textContent).toContain('Choose: Merge?')
    type(deckInput(), 'Half an answer')
    click(buttonLabelled('Pin for later', lightbox()))
    await settle()
    click(lightbox().querySelector('.lb-close'))
    await settle()

    await arriveWhilePaused(d)
    expect(document.querySelector('#rail [data-project="alpha"]')?.getAttribute('aria-selected')).toBe('true')
    expectDraftInView(id, 'pinned', 'Half an answer')
  })

  it('opens no fold when the deferral is refused, and the draft stays with its card', async () => {
    const d = open()
    const pinned = question(d, 'Already set aside')
    pinItem(d, pinned, true)
    upsertBoard(d, { ...AGENT, title: 'Release', rows: [blockedRow()] })
    const board = getBoard(d, 'alpha', 'Release')!
    const id = board.rows[0]!.id
    await bootApp(d)
    await showInbox()
    click(row(id))
    await settle()
    type(answerInput(id), 'Half an answer')
    updateBoardRow(d, {
      ...AGENT, title: 'Release', label: 'Install test',
      expectedBoardVersion: board.revision, expectedRevision: board.rows[0]!.revision,
      note: 'The 1.4.1 build is ready instead.',
    })

    click(buttonLabelled('Pin for later', row(id)!))
    await settle()
    expect(getBoard(d, 'alpha', 'Release')!.rows[0]!.pinned_at).toBeNull()
    expect(later()?.open).toBe(false)
    expect(row(id)?.closest('details')).toBeNull()
    expect(row(id)?.dataset.open).toBe('1')
    expect(row(id)?.textContent).toContain('Half an answer')
  })

  it('still files an ask without a draft into its closed fold and leaves the open card alone', async () => {
    const d = open()
    const reading = question(d, 'Being read')
    advanceClock()
    const snoozed = question(d, 'Snoozed bare')
    advanceClock()
    const pinned = question(d, 'Pinned bare')
    await bootApp(d)
    await showInbox()

    click(row(snoozed))
    await settle()
    click(buttonLabelled('Not now · 4h', row(snoozed)!))
    await settle()
    expect(later()?.open).toBe(false)

    click(row(reading))
    await settle()
    click(buttonLabelled('Review queue'))
    await settle()
    click(lightbox().querySelector('.lb-next'))
    await settle()
    expect(lightbox().textContent).toContain('Pinned bare')
    click(buttonLabelled('Pin for later', lightbox()))
    await settle()
    click(lightbox().querySelector('.lb-close'))
    await settle()

    expect(later()?.open).toBe(false)
    expect(row(pinned)?.closest('.later-section')).toBe(later())
    expect(row(pinned)?.dataset.open).toBeUndefined()
    expect(row(reading)?.dataset.open).toBe('1')
    expect(document.getElementById('pauseHint')?.hidden).toBe(true)
  })
})
