// @vitest-environment jsdom
// Issue #247, slice 3: the Later section and its setting. With the setting on
// (the default) one Later section at the foot of the Inbox queue holds every
// pinned and snoozed ask, with one count, and "I'll take a while" defers the ask
// in the same write as the watch stop. With it off, today's layout stays: the
// snoozed fold, a pinned fold for pins that already exist, and no Pin control.
// The setting is layout only: no count, badge or dock projection ever moves.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { attentionEntries } from '../../public/attention.js'
import type { AttentionBoard, AttentionItem } from '../../public/attention.js'
import {
  closeProject, getBoard, getItem, insertItem, pinBoardRow, pinItem, snoozeItem, updateBoardRow, upsertBoard,
} from '../../src/store.js'
import {
  advanceClock, answerInput, badgeCount, bootApp, buttonLabelled, click, expectConsoleError, freshDb, navigateToHash,
  pollTick, row, rows, searchFor, sendButton, settle, showInbox, tabCount, type, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'claude' } as const
const COPILOT = { ...AGENT, agent: 'copilot' } as const
const HOUR = 60 * 60_000
const LATER_KEY = 'agent-inbox-later-section'
const PAUSED = 'paused — updating when you\'re done'

function open(): Database.Database {
  db = freshDb()
  return db
}

const question = (d: Database.Database, title = 'Merge?', over: Partial<Parameters<typeof insertItem>[1]> = {}) => insertItem(d, {
  ...AGENT,
  kind: 'question',
  title,
  detail: 'All gates are green.',
  next_step: `Choose: ${title}`,
  action_owner: 'approval',
  impact: 'Unblocks implementation.',
  options: [{ label: 'Merge', recommended: true }, { label: 'Hold' }],
  ...over,
})

const blockedRow = (label = 'Install test') => ({
  label,
  status: 'blocked' as const,
  note: 'The 1.4 build is ready.',
  next_step: `Do ${label}.`,
  action_owner: 'task' as const,
  impact: 'Gates the release.',
})

const laterSection = () => document.querySelector<HTMLDetailsElement>('#needsYouList .later-section')
const openLater = () => {
  const el = laterSection()!
  el.open = true
  el.dispatchEvent(new Event('toggle'))
}
const setOpen = (fold: HTMLDetailsElement | null, open: boolean) => {
  if (!fold) throw new Error('setOpen(): no fold')
  fold.open = open
  fold.dispatchEvent(new Event('toggle'))
}
const laterTitle = () => laterSection()?.querySelector('.later-title')?.textContent ?? null
const laterBreakdown = () => laterSection()?.querySelector('.later-breakdown')?.textContent ?? null
const fold = (name: 'pinned' | 'snoozed') => document.querySelector<HTMLDetailsElement>(`#needsYouList .${name}-fold`)
const inLater = (id: string) => Boolean(row(id)?.closest('.later-section'))
const inQueue = (id: string) => Boolean(row(id)) && row(id)?.closest('details') === null
const laterIds = () => [...(laterSection()?.querySelectorAll<HTMLElement>('.nrow[data-card-id]') ?? [])]
  .map((el) => el.dataset.cardId)
const calmHead = () => document.querySelector('#needsYouList .calm-head')?.textContent ?? null
const menuChoices = (id: string) => [...(row(id)?.querySelectorAll('.disposition-menu:not(.wait-menu) .disposition-actions button') ?? [])]
  .map((button) => button.textContent)
const lightbox = () => document.getElementById('lightbox')!
const deckInput = () => lightbox().querySelector<HTMLTextAreaElement>('.reply-input:not(.reply-context-input)')

function chipText(id: string): string {
  const chip = row(id)?.querySelector('.chip')
  return [...(chip?.childNodes ?? [])]
    .filter((node) => node.nodeType === 3)
    .map((node) => node.textContent ?? '')
    .join('')
    .trim()
}

function laterToggle(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('#setup .later-section-toggle')
  if (!input) throw new Error('the Later section setting is not rendered')
  return input
}
const laterHint = () => document.getElementById('later-section-hint')

async function chooseLater(on: boolean): Promise<void> {
  if (document.getElementById('setup')?.hidden) click(document.getElementById('gear'))
  const input = laterToggle()
  input.focus()
  input.checked = on
  input.dispatchEvent(new Event('change', { bubbles: true }))
  await settle()
}

// A fresh page against the same localStorage: a reload, View → Reload or a relaunch.
async function reopen(d: Database.Database): Promise<void> {
  vi.resetModules()
  await bootApp(d)
}

// The Inbox header's Review queue button runs the same openTriage() as the `t`
// key, and it exists while another tab is showing. A synthetic keydown on
// document would also reach the listeners of every earlier boot in this file
// (the harness cannot remove them), so tests here click the button;
// later-review-tab.test.ts presses `t` itself, as the only boot in its file.
async function openReviewQueue(): Promise<void> {
  click(buttonLabelled('Review queue'))
  await settle()
}

// Step the open Review queue to the card that shows `text`, refusing to loop past its end.
async function showInDeck(text: string): Promise<void> {
  for (let step = 0; step < 10; step++) {
    if (lightbox().hidden) throw new Error('the Review queue is not open')
    if (lightbox().querySelector('.lb-card')?.textContent?.includes(text)) return
    const next = lightbox().querySelector<HTMLButtonElement>('.lb-next')
    if (!next || next.disabled) break
    click(next)
    await settle()
  }
  throw new Error(`the Review queue never showed ${text}: ${lightbox().querySelector('.lb-count')?.textContent} ${lightbox().querySelector('.lb-card')?.textContent?.slice(0, 160)}`)
}

describe('the Later section (#247)', () => {
  it('gathers pinned and snoozed asks at the foot of the queue, after Show more and before the stale fold', async () => {
    const d = open()
    const stale = question(d, 'Nobody is listening')
    advanceClock(73 * HOUR)
    for (let index = 0; index < 11; index++) {
      question(d, `Asking ${index}`)
      advanceClock()
    }
    const snoozed = question(d, 'Snoozed?')
    const pinnedOld = question(d, 'Pinned first?')
    const pinnedNew = question(d, 'Pinned second?')
    snoozeItem(d, snoozed, new Date(Date.now() + 4.5 * HOUR).toISOString())
    pinItem(d, pinnedOld, true)
    advanceClock()
    pinItem(d, pinnedNew, true)
    await bootApp(d)
    await showInbox()

    const children = [...document.getElementById('needsYouList')!.children]
    const at = (selector: string) => children.findIndex((child) => child.matches(selector))
    expect(at('.show-more')).toBeGreaterThan(0)
    expect(at('.later-section')).toBe(at('.show-more') + 1)
    expect(at('.stale-fold')).toBe(at('.later-section') + 1)
    expect(fold('snoozed'), 'Later replaces the snoozed fold').toBeNull()
    expect(fold('pinned')).toBeNull()

    expect(laterSection()?.open, 'collapsed by default').toBe(false)
    expect(laterTitle()).toBe('Later · 3')
    expect(laterBreakdown()).toBe('2 pinned · 1 snoozed, next back in 4h')
    expect(laterIds()).toEqual([snoozed, pinnedOld, pinnedNew])
    for (const id of [snoozed, pinnedOld, pinnedNew]) {
      expect(buttonLabelled('Back to inbox', row(id)!), id).not.toBeNull()
      expect(buttonLabelled('Wake now', row(id)!), id).toBeNull()
    }
    expect(chipText(snoozed)).toBe('Back in 4h')
    expect(chipText(pinnedOld)).toBe('Pinned moments ago')
    expect(row(stale)?.closest('.stale-fold')).not.toBeNull()
    expect(badgeCount()).toBe(11)
    expect(tabCount('needsYou')).toBe('11')
  })

  it('orders Later by return and pin time, not by the Sort menu, and keeps that order across polls', async () => {
    const d = open()
    const pinnedNew = question(d, 'Pinned last')
    const backLate = question(d, 'Back late')
    const pinnedOld = question(d, 'Pinned first')
    const backSoon = question(d, 'Back soon')
    snoozeItem(d, backLate, new Date(Date.now() + 5 * HOUR).toISOString())
    snoozeItem(d, backSoon, new Date(Date.now() + 2 * HOUR).toISOString())
    pinItem(d, pinnedOld, true)
    advanceClock()
    pinItem(d, pinnedNew, true)
    await bootApp(d)
    await showInbox()
    const order = [backSoon, backLate, pinnedOld, pinnedNew]
    expect(laterIds()).toEqual(order)

    const select = document.querySelector<HTMLSelectElement>('#needsYouList .queue-sort select')!
    for (const value of ['newest', 'oldest']) {
      select.value = value
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await settle()
      expect(laterIds(), value).toEqual(order)
    }
    advanceClock()
    question(d, 'Arrives later')
    await pollTick()
    expect(laterIds()).toEqual(order)
    expect(laterBreakdown()).toBe('2 pinned · 2 snoozed, next back in 1h')
  })

  it('brings a snoozed ask back on its own once the clock passes, and the header follows', async () => {
    const d = open()
    const snoozed = question(d, 'Snoozed?')
    const pinned = question(d, 'Pinned?')
    snoozeItem(d, snoozed, new Date(Date.now() + HOUR).toISOString())
    pinItem(d, pinned, true)
    await bootApp(d)
    await showInbox()
    expect(laterTitle()).toBe('Later · 2')
    expect(badgeCount()).toBe(0)

    advanceClock(2 * HOUR)
    await pollTick()
    expect(inQueue(snoozed)).toBe(true)
    expect(inLater(pinned)).toBe(true)
    expect(laterTitle()).toBe('Later · 1')
    expect(laterBreakdown()).toBe('1 pinned')
    expect(badgeCount()).toBe(1)
  })

  it('names the Later count when nothing else needs you', async () => {
    const d = open()
    const pinned = question(d, 'Pinned?')
    const snoozed = question(d, 'Snoozed?')
    pinItem(d, pinned, true)
    snoozeItem(d, snoozed, new Date(Date.now() + HOUR).toISOString())
    await bootApp(d)
    await showInbox()
    expect(calmHead()).toBe('Nothing needs you now · 2 in Later')

    click(buttonLabelled('Back to inbox', row(pinned)!))
    await settle()
    expect(calmHead(), 'an ask in the queue is not an empty state').toBeNull()
    click(buttonLabelled('Back to inbox', row(snoozed)!))
    await settle()
    expect(calmHead()).toBeNull()
    expect(laterSection()).toBeNull()
    expect(getItem(d, snoozed)!.snoozed_until).toBeNull()
  })

  it('says the queue is clear when Later is empty too, or when the section is off', async () => {
    const d = open()
    await bootApp(d)
    await showInbox()
    expect(calmHead()).toBe('Your queue is clear')

    pinItem(d, question(d), true)
    await pollTick()
    expect(calmHead()).toBe('Nothing needs you now · 1 in Later')
    await chooseLater(false)
    await showInbox()
    expect(fold('pinned')).not.toBeNull()
    expect(calmHead(), 'with the section off there is no Later to name').toBe('Your queue is clear')
  })

  it('counts Later in the current lens only, never in the badge, the tab or the rail', async () => {
    const d = open()
    pinItem(d, question(d, 'Alpha pinned'), true)
    const betaPinned = question(d, 'Beta pinned', { project: 'beta' })
    pinItem(d, betaPinned, true)
    const kept = question(d, 'Beta asking', { project: 'beta' })
    await bootApp(d)
    await showInbox()
    expect(laterTitle()).toBe('Later · 2')
    expect(badgeCount()).toBe(1)
    expect(tabCount('needsYou')).toBe('1')
    const railBadge = (project: string) => document.querySelector(`#rail .rail-tab[data-project="${project}"] .rail-badge`)?.textContent
    expect(railBadge('beta')).toBe('1')
    expect(railBadge('alpha') ?? '').toBe('')

    click(document.querySelector('#rail .rail-tab[data-project="beta"]'))
    await settle()
    expect(laterTitle()).toBe('Later · 1')
    expect(inLater(betaPinned)).toBe(true)
    expect(inQueue(kept)).toBe(true)
    expect(badgeCount()).toBe(1)
    expect(tabCount('needsYou')).toBe('1')
  })

  it('keeps the badge, tab count, queue and dock projection in agreement with pins, with the setting on and off', async () => {
    const d = open()
    question(d, 'Still asking')
    const pinned = question(d, 'Set aside')
    const snoozed = question(d, 'Snoozed')
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
    expect(await surfaces()).toEqual({ badge: 5, tab: 5, queue: 5, dock: 5 })

    const board = getBoard(d, 'alpha', 'Release')!
    pinItem(d, pinned, true)
    snoozeItem(d, snoozed, new Date(Date.now() + HOUR).toISOString())
    pinBoardRow(d, board.rows[1]!.id, true, board.rows[1]!.revision, board.revision)
    await pollTick()
    expect(await surfaces()).toEqual({ badge: 2, tab: 2, queue: 2, dock: 2 })
    expect(laterTitle()).toBe('Later · 3')

    await chooseLater(false)
    expect(await surfaces()).toEqual({ badge: 2, tab: 2, queue: 2, dock: 2 })
    expect(laterSection()).toBeNull()
    expect(fold('pinned')?.querySelector('summary')?.textContent).toBe('pinned (2)')
    expect(fold('snoozed')?.querySelector('summary')?.textContent).toBe('snoozed (1)')
  })

  it('opens Later for a deep link into an ask it holds', async () => {
    const d = open()
    const id = question(d)
    pinItem(d, id, true)
    await bootApp(d)

    navigateToHash(`#item/${id}`)
    await settle()
    await pollTick()
    expect(laterSection()?.open).toBe(true)
    expect(inLater(id)).toBe(true)
    expect(row(id)?.dataset.open).toBe('1')
  })

  it('keeps Later open, its open card and the card draft across polls, and answers from inside it', async () => {
    const d = open()
    const id = question(d)
    pinItem(d, id, true)
    await bootApp(d)
    await showInbox()

    openLater()
    click(row(id))
    await settle()
    advanceClock()
    question(d, 'Something new')
    await pollTick()
    expect(laterSection()?.open).toBe(true)
    expect(row(id)?.dataset.open).toBe('1')

    type(answerInput(id), 'Hold until Friday')
    advanceClock()
    question(d, 'Another one')
    await pollTick()
    expect(answerInput(id)?.value).toBe('Hold until Friday')
    expect(laterSection()?.open).toBe(true)

    click(sendButton(id))
    await settle()
    expect(getItem(d, id)).toMatchObject({ reply: 'Hold until Friday', pinned_at: null })
    expect(laterSection()).toBeNull()
    expect(row(id)?.classList.contains('answered')).toBe(true)
  })
})

// #247 review: the fold that holds the open card always renders open, whatever
// moved its ask there: a deferral, the Later setting, another client or a
// native notification. One rule at render time, not one patch per transition,
// so an open card, and a draft in it, is never inside a closed fold.
describe('the fold that holds the open card renders open (#247)', () => {
  const visible = (id: string) => {
    const card = row(id)?.querySelector('.nrow-card')
    return Boolean(card) && card!.closest('details:not([open])') === null
  }

  it('keeps a drafted open card in view when the Later section is turned off, and after a poll', async () => {
    const d = open()
    const id = question(d)
    pinItem(d, id, true)
    await bootApp(d)
    await showInbox()
    openLater()
    click(row(id))
    await settle()
    type(answerInput(id), 'Half an answer')

    await chooseLater(false)
    await showInbox()
    expect(fold('pinned')?.open).toBe(true)
    expect(visible(id)).toBe(true)
    expect(answerInput(id)?.value).toBe('Half an answer')

    advanceClock()
    question(d, 'Arrived while paused')
    await pollTick()
    expect(fold('pinned')?.open).toBe(true)
    expect(visible(id)).toBe(true)
    expect(document.getElementById('pauseHint')?.textContent).toBe(PAUSED)
  })

  it('keeps a drafted open card in view when the Later section is turned on, and after a poll', async () => {
    localStorage.setItem(LATER_KEY, 'false')
    const d = open()
    const id = question(d)
    snoozeItem(d, id, new Date(Date.now() + 4 * HOUR).toISOString())
    await bootApp(d)
    await showInbox()
    setOpen(fold('snoozed'), true)
    click(row(id))
    await settle()
    type(answerInput(id), 'Half an answer')

    await chooseLater(true)
    await showInbox()
    expect(laterSection()?.open).toBe(true)
    expect(inLater(id)).toBe(true)
    expect(visible(id)).toBe(true)
    expect(answerInput(id)?.value).toBe('Half an answer')

    advanceClock()
    question(d, 'Arrived while paused')
    await pollTick()
    expect(laterSection()?.open).toBe(true)
    expect(visible(id)).toBe(true)
  })

  it('keeps the open card in view when another client pins its ask', async () => {
    const d = open()
    const id = question(d)
    await bootApp(d)
    await showInbox()
    click(row(id))
    await settle()

    const res = await fetch(`/api/items/${id}/later`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pinned: true }),
    })
    expect(await res.json()).toEqual({ ok: true })
    await pollTick()
    expect(inLater(id)).toBe(true)
    expect(laterSection()?.open).toBe(true)
    expect(visible(id)).toBe(true)
  })

  it('keeps a drafted open card in view on the next forced frame after another client pins its ask', async () => {
    const d = open()
    const id = question(d)
    await bootApp(d)
    await showInbox()
    click(row(id))
    await settle()
    type(answerInput(id), 'Half an answer')
    pinItem(d, id, true)
    await pollTick()
    expect(inLater(id), 'the draft holds the poll').toBe(false)

    await showInbox()
    expect(inLater(id)).toBe(true)
    expect(laterSection()?.open).toBe(true)
    expect(visible(id)).toBe(true)
    expect(answerInput(id)?.value).toBe('Half an answer')
  })

  it('files an ask that is not the open card into a closed fold', async () => {
    const d = open()
    const reading = question(d, 'Being read')
    advanceClock()
    const other = question(d, 'Pinned elsewhere')
    await bootApp(d)
    await showInbox()
    click(row(reading))
    await settle()
    pinItem(d, other, true)
    await pollTick()
    expect(inLater(other)).toBe(true)
    expect(laterSection()?.open).toBe(false)
    expect(visible(reading)).toBe(true)
  })

  it('keeps Later closed once the human closes it', async () => {
    const d = open()
    pinItem(d, question(d), true)
    await bootApp(d)
    await showInbox()
    openLater()
    setOpen(laterSection(), false)
    advanceClock()
    question(d, 'Arrives later')
    await pollTick()
    expect(laterSection()?.open).toBe(false)
  })

  it('keeps a fold the human closed closed when it does not hold the open card', async () => {
    const d = open()
    const reading = question(d, 'Being read')
    advanceClock()
    pinItem(d, question(d, 'Pinned'), true)
    await bootApp(d)
    await showInbox()
    openLater()
    click(row(reading))
    await settle()
    setOpen(laterSection(), false)
    advanceClock()
    question(d, 'Arrives later')
    await pollTick()
    expect(laterSection()?.open).toBe(false)
    expect(visible(reading)).toBe(true)
    await showInbox()
    expect(laterSection()?.open).toBe(false)
  })

  it.each([
    ['Later', 'on'],
    ['the pinned fold', 'off'],
  ] as const)('closing %s while it holds the open card closes the card too, and it stays closed', async (_label, mode) => {
    if (mode === 'off') localStorage.setItem(LATER_KEY, 'false')
    const d = open()
    const id = question(d)
    pinItem(d, id, true)
    await bootApp(d)
    await showInbox()
    const container = () => (mode === 'on' ? laterSection() : fold('pinned'))
    setOpen(container(), true)
    click(row(id))
    await settle()
    expect(visible(id)).toBe(true)

    setOpen(container(), false)
    await settle()
    expect(row(id)?.dataset.open).toBeUndefined()
    advanceClock()
    question(d, 'Arrives later')
    await pollTick()
    expect(container()?.open).toBe(false)
    expect(row(id)?.querySelector('.nrow-card')).toBeNull()
  })

  // The same rule holds for the stale fold ("stale — decide later"): an ask with
  // no live session turns stale on the clock alone, while its card is open.
  const staleFold = () => [...document.querySelectorAll<HTMLDetailsElement>('#needsYouList details.stale-fold')]
    .find((el) => !el.dataset.deferredFold && !el.classList.contains('stale-drafts-fold')) ?? null
  const STALE = 72 * HOUR

  it('keeps an open card in view when its ask turns stale, after a poll', async () => {
    const d = open()
    const id = question(d)
    advanceClock(STALE - 60_000)
    await bootApp(d)
    await showInbox()
    click(row(id))
    await settle()
    expect(staleFold()).toBeNull()

    advanceClock(2 * 60_000)
    await pollTick()
    expect(row(id)?.closest('details')).toBe(staleFold())
    expect(staleFold()?.open).toBe(true)
    expect(visible(id)).toBe(true)
  })

  it('keeps a drafted open card in view when its ask turns stale, on the next forced frame', async () => {
    const d = open()
    const id = question(d)
    advanceClock(STALE - 60_000)
    await bootApp(d)
    await showInbox()
    click(row(id))
    await settle()
    type(answerInput(id), 'Half an answer')

    advanceClock(2 * 60_000)
    await pollTick()
    expect(staleFold(), 'the draft holds the poll').toBeNull()
    expect(visible(id)).toBe(true)
    await showInbox()
    expect(row(id)?.closest('details')).toBe(staleFold())
    expect(staleFold()?.open).toBe(true)
    expect(visible(id)).toBe(true)
    expect(answerInput(id)?.value).toBe('Half an answer')
  })

  it('closing the stale fold while it holds the open card closes the card too, and it stays closed', async () => {
    const d = open()
    const id = question(d)
    advanceClock(STALE + HOUR)
    await bootApp(d)
    await showInbox()
    setOpen(staleFold(), true)
    click(row(id))
    await settle()
    expect(visible(id)).toBe(true)

    setOpen(staleFold(), false)
    await settle()
    expect(row(id)?.dataset.open).toBeUndefined()
    advanceClock()
    question(d, 'Arrives later')
    await pollTick()
    expect(staleFold()?.open).toBe(false)
    expect(row(id)?.querySelector('.nrow-card')).toBeNull()
  })

  it('keeps the draft of a card closed with its stale fold', async () => {
    const d = open()
    const id = question(d)
    advanceClock(STALE + HOUR)
    await bootApp(d)
    await showInbox()
    setOpen(staleFold(), true)
    click(row(id))
    await settle()
    type(answerInput(id), 'Half an answer')

    setOpen(staleFold(), false)
    await settle()
    expect(row(id)?.dataset.open).toBeUndefined()
    setOpen(staleFold(), true)
    click(row(id))
    await settle()
    expect(answerInput(id)?.value).toBe('Half an answer')
  })

  it('leaves a stale fold without the open card as the human left it', async () => {
    const d = open()
    question(d, 'Nobody is listening')
    advanceClock(STALE + HOUR)
    const reading = question(d, 'Being read')
    await bootApp(d)
    await showInbox()
    click(row(reading))
    await settle()
    advanceClock()
    question(d, 'Arrives first')
    await pollTick()
    expect(staleFold()?.open, 'closed by default').toBe(false)

    setOpen(staleFold(), true)
    advanceClock()
    question(d, 'Arrives second')
    await pollTick()
    expect(staleFold()?.open).toBe(true)

    setOpen(staleFold(), false)
    advanceClock()
    question(d, 'Arrives third')
    await pollTick()
    expect(staleFold()?.open).toBe(false)
    expect(visible(reading), 'closing it leaves a card outside it open').toBe(true)
  })
})

describe('the Later section setting (#247)', () => {
  it('is on by default, and a value it does not know reads as the default', async () => {
    localStorage.setItem(LATER_KEY, 'sideways')
    const d = open()
    pinItem(d, question(d), true)
    await bootApp(d)
    await showInbox()
    expect(laterSection()).not.toBeNull()
    expect(laterToggle().checked).toBe(true)
    expect(laterToggle().closest('.setup-block')?.querySelector('h3')?.textContent).toBe('Inbox')
    expect(laterToggle().closest('label')?.textContent)
      .toContain('Move pinned and snoozed asks to a Later section at the foot of the inbox')
    expect(laterHint()?.hidden).toBe(true)
  })

  it('turns off at once past a draft into the snoozed and pinned folds, hides the Pin control, and survives a reload', async () => {
    const d = open()
    const asking = question(d, 'Still asking')
    const pinned = question(d, 'Pinned?')
    const snoozed = question(d, 'Snoozed?')
    pinItem(d, pinned, true)
    snoozeItem(d, snoozed, new Date(Date.now() + HOUR).toISOString())
    await bootApp(d)
    await showInbox()
    click(row(asking))
    await settle()
    expect(menuChoices(asking)[0]).toBe('Pin for later')
    type(answerInput(asking), 'half-written answer')

    await chooseLater(false)
    expect(localStorage.getItem(LATER_KEY)).toBe('false')
    expect(laterSection()).toBeNull()
    expect(fold('snoozed')?.querySelector('summary')?.textContent).toBe('snoozed (1)')
    expect(fold('pinned')?.querySelector('summary')?.textContent).toBe('pinned (1)')
    expect(buttonLabelled('Wake now', row(snoozed)!)).not.toBeNull()
    expect(buttonLabelled('Back to inbox', row(pinned)!)).not.toBeNull()
    expect(answerInput(asking)?.value).toBe('half-written answer')
    expect(menuChoices(asking)).not.toContain('Pin for later')
    expect(menuChoices(asking)[0]).toBe('Not now · 4h')
    expect(document.activeElement).toBe(laterToggle())
    expect(laterHint()?.hidden).toBe(false)
    expect(laterHint()?.textContent).toBe('1 ask is still pinned. It stays in a pinned fold until you bring it back.')
    expect(document.getElementById('pauseHint')?.hidden).toBe(true)

    await reopen(d)
    await showInbox()
    expect(laterToggle().checked).toBe(false)
    expect(laterSection()).toBeNull()
    expect(fold('pinned')).not.toBeNull()

    click(buttonLabelled('Back to inbox', row(pinned)!))
    await settle()
    expect(laterHint()?.hidden, 'the hint follows the pins').toBe(true)

    await chooseLater(true)
    expect(localStorage.getItem(LATER_KEY)).toBe('true')
    expect(fold('snoozed')).toBeNull()
    expect(laterTitle()).toBe('Later · 1')
    expect(laterHint()?.hidden).toBe(true)
  })

  it('offers no Pin for later with the section off, on a question, a queue row or a plan panel', async () => {
    localStorage.setItem(LATER_KEY, 'false')
    const d = open()
    const id = question(d)
    upsertBoard(d, { ...AGENT, title: 'Release', rows: [blockedRow()] })
    const rowId = getBoard(d, 'alpha', 'Release')!.rows[0]!.id
    await bootApp(d)
    await showInbox()
    for (const ask of [id, rowId]) {
      click(row(ask))
      await settle()
      expect(menuChoices(ask), ask).not.toContain('Pin for later')
      expect(menuChoices(ask)[0], ask).toBe('Not now · 4h')
    }
    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    click(buttonLabelled('Answer', document.querySelector(`#boards [data-row-id="${rowId}"]`)!))
    await settle()
    const panel = document.querySelector(`#boards [data-row-id="${rowId}"] + .row-panel-row`)!
    expect(buttonLabelled('Not now · 4h', panel)).not.toBeNull()
    expect(buttonLabelled('Pin for later', panel)).toBeNull()
  })

  it('counts every pin left in the hint, and names none while the section is on', async () => {
    localStorage.setItem(LATER_KEY, 'false')
    const d = open()
    pinItem(d, question(d, 'One'), true)
    upsertBoard(d, { ...AGENT, title: 'Release', rows: [blockedRow()] })
    const board = getBoard(d, 'alpha', 'Release')!
    await bootApp(d)
    expect(laterHint()?.hidden).toBe(false)
    expect(laterHint()?.textContent).toBe('1 ask is still pinned. It stays in a pinned fold until you bring it back.')

    pinBoardRow(d, board.rows[0]!.id, true, board.rows[0]!.revision, board.revision)
    await pollTick()
    expect(laterHint()?.textContent).toBe('2 asks are still pinned. They stay in a pinned fold until you bring them back.')
  })

  it('keeps the layout when the choice cannot be saved', async () => {
    const d = open()
    pinItem(d, question(d), true)
    await bootApp(d)
    await showInbox()
    expectConsoleError(/Later section setting could not be saved/)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new Error('quota exceeded')
    })

    await chooseLater(false)
    expect(laterToggle().checked).toBe(true)
    expect(localStorage.getItem(LATER_KEY)).toBeNull()
    expect(laterSection()).not.toBeNull()
    expect(document.getElementById('status')?.textContent).toBe('later section setting not saved')
  })
})

describe('"I’ll take a while" with the Later section on (#247)', () => {
  const copilotQuestion = (d: Database.Database) => question(d, 'Approve the release?', { agent: 'copilot' })
  const waitChoice = (id: string, label: string) => [...(row(id)?.querySelectorAll<HTMLButtonElement>('.wait-menu button') ?? [])]
    .find((button) => button.textContent === label) ?? null

  it('"Stop waiting" stops the watcher and pins the question in one write, and keeps its draft in view', async () => {
    const d = open()
    const id = copilotQuestion(d)
    const bridge = await bootApp(d)
    await showInbox()
    click(row(id))
    await settle()
    expect(waitChoice(id, 'Stop waiting')?.title).toBe('The agent stops waiting. The ask moves to Later until you bring it back.')
    expect(waitChoice(id, 'Back in ~1 h')?.title)
      .toBe('The agent waits quietly and the ask waits in Later until then. Answering still wakes the agent.')
    type(answerInput(id), 'Half an answer')
    click(waitChoice(id, 'Stop waiting'))
    await settle()

    const posted = bridge.posts.filter((post) => post.url.endsWith('/stop-waiting'))
    expect(posted.map((post) => JSON.parse(String(post.init?.body)))).toEqual([{ until: null, defer: true }])
    expect(getItem(d, id)).toMatchObject({ watch_stopped_at: expect.any(String), watch_stopped_until: null, pinned_at: expect.any(String) })
    expect(badgeCount()).toBe(0)
    expect(inLater(id)).toBe(true)
    expect(laterSection()?.open).toBe(true)
    expect(row(id)?.dataset.open).toBe('1')
    expect(answerInput(id)?.value).toBe('Half an answer')
    expect(row(id)?.querySelector('.wait-stop-note')?.textContent)
      .toBe('Agent stopped waiting moments ago · message it after you answer')

    advanceClock()
    question(d, 'Arrived while paused')
    await pollTick()
    expect(document.getElementById('pauseHint')?.textContent).toBe(PAUSED)
  })

  it('"Back in ~3 h" makes the watcher wait quietly and snoozes the row to the same time, against its revisions', async () => {
    const d = open()
    upsertBoard(d, { ...COPILOT, title: 'Release', rows: [blockedRow()] })
    const before = getBoard(d, 'alpha', 'Release')!
    const rowId = before.rows[0]!.id
    const bridge = await bootApp(d)
    await showInbox()
    click(row(rowId))
    await settle()
    click(waitChoice(rowId, 'Back in ~3 h'))
    await settle()

    const posted = bridge.posts.filter((post) => post.url.endsWith('/stop-waiting'))
    const body = JSON.parse(String(posted[0]?.init?.body))
    expect(body).toMatchObject({
      defer: true, expected_revision: before.rows[0]!.revision, expected_board_version: before.revision,
    })
    const after = getBoard(d, 'alpha', 'Release')!
    expect(after.rows[0]!.watch_stopped_until).toBe(body.until)
    expect(after.rows[0]!.snoozed_until).toBe(body.until)
    expect(after.rows[0]!.revision, 'the snooze half moves the revision as a snooze does').toBe(before.rows[0]!.revision + 1)
    expect(badgeCount()).toBe(0)
    expect(inLater(rowId)).toBe(true)
    expect(laterSection()?.open, 'no draft, so Later stays as it was').toBe(false)
    expect(chipText(rowId)).toBe('Back in 3h · agent waits quietly')
  })

  it('shows the refusal and defers nothing when the row changed first', async () => {
    const d = open()
    upsertBoard(d, { ...COPILOT, title: 'Release', rows: [blockedRow()] })
    const board = getBoard(d, 'alpha', 'Release')!
    const rowId = board.rows[0]!.id
    await bootApp(d)
    await showInbox()
    click(row(rowId))
    await settle()
    updateBoardRow(d, {
      ...COPILOT, title: 'Release', label: 'Install test',
      expectedBoardVersion: board.revision, expectedRevision: board.rows[0]!.revision,
      note: 'The 1.4.1 build is ready instead.',
    })
    click(waitChoice(rowId, 'Stop waiting'))
    await settle()
    expect(getBoard(d, 'alpha', 'Release')!.rows[0]).toMatchObject({ watch_stopped_at: null, pinned_at: null })
    expect(inQueue(rowId)).toBe(true)
    expect(row(rowId)?.querySelector('.write-error')?.textContent)
      .toBe('This action changed before your click; refreshed without applying it.')
  })

  it('with the setting off, writes the watch stop only and keeps the ask in Needs you', async () => {
    localStorage.setItem(LATER_KEY, 'false')
    const d = open()
    const id = copilotQuestion(d)
    const bridge = await bootApp(d)
    await showInbox()
    click(row(id))
    await settle()
    expect(waitChoice(id, 'Stop waiting')?.title).toBe('The agent stops waiting and won’t wake on its own; message it after you answer.')
    click(waitChoice(id, 'Stop waiting'))
    await settle()
    const posted = bridge.posts.filter((post) => post.url.endsWith('/stop-waiting'))
    expect(posted.map((post) => JSON.parse(String(post.init?.body)))).toEqual([{ until: null }])
    expect(getItem(d, id)).toMatchObject({ watch_stopped_until: null, pinned_at: null })
    expect(badgeCount()).toBe(1)
    expect(inQueue(id)).toBe(true)
  })
})

describe('search with the Later section (#247)', () => {
  it('finds a pinned or snoozed ask under Open items with a Later chip, and an asking one without', async () => {
    const d = open()
    const pinned = question(d, 'Rollout pinned')
    const snoozed = question(d, 'Rollout snoozed')
    const asking = question(d, 'Rollout asking')
    pinItem(d, pinned, true)
    snoozeItem(d, snoozed, new Date(Date.now() + HOUR).toISOString())
    await bootApp(d)
    await showInbox()
    await searchFor('Rollout')
    await settle()

    const result = (id: string) => document.querySelector<HTMLElement>(`#searchResults [data-search-target="${id}"]`)
    const group = (id: string) => result(id)?.closest('.search-result-group')?.querySelector('.search-result-group-label')?.textContent
    for (const id of [pinned, snoozed, asking]) expect(group(id), id).toBe('Open items')
    expect(result(pinned)?.querySelector('.search-result-later')?.textContent).toBe('Later')
    expect(result(snoozed)?.querySelector('.search-result-later')?.textContent).toBe('Later')
    expect(result(asking)?.querySelector('.search-result-later')).toBeNull()

    advanceClock(2 * HOUR)
    await pollTick()
    expect(result(snoozed)?.querySelector('.search-result-later'), 'back from its snooze').toBeNull()
    expect(result(pinned)?.querySelector('.search-result-later')).not.toBeNull()

    click(result(pinned))
    await settle()
    await pollTick()
    expect(laterSection()?.open).toBe(true)
    expect(row(pinned)?.dataset.open).toBe('1')
  })

  it('draws no Later label for an ask of a closed project, which Later does not show either', async () => {
    const d = open()
    const id = question(d, 'Rollout beta', { project: 'beta' })
    pinItem(d, id, true)
    question(d, 'Alpha asking')
    closeProject(d, 'beta')
    await bootApp(d)
    await showInbox()
    expect(laterSection()).toBeNull()
    await searchFor('Rollout')
    await settle()
    const result = document.querySelector<HTMLElement>(`#searchResults [data-search-target="${id}"]`)
    expect(result?.closest('.search-result-group')?.querySelector('.search-result-group-label')?.textContent).toBe('Open items')
    expect(result?.querySelector('.search-result-later')).toBeNull()
  })

  it('draws no Later chip with the setting off', async () => {
    localStorage.setItem(LATER_KEY, 'false')
    const d = open()
    pinItem(d, question(d, 'Rollout pinned'), true)
    await bootApp(d)
    await searchFor('Rollout')
    await settle()
    expect(document.querySelector('#searchResults .search-result')).not.toBeNull()
    expect(document.querySelector('#searchResults .search-result-later')).toBeNull()
  })
})

// #247 part 2 review, carried into this slice. A deferral from the Review queue
// keeps a drafted ask in view by giving it the open card in the list, so the
// list lens must show it, and the list must be the visible tab.
describe('a drafted ask deferred from the Review queue lands in view (#247)', () => {
  async function pinFromDeck(text = 'Half an answer') {
    type(deckInput(), text)
    click(buttonLabelled('Pin for later', lightbox()))
    await settle()
    click(lightbox().querySelector('.lb-close'))
    await settle()
  }
  function expectDraftInLater(id: string, text = 'Half an answer') {
    expect(laterSection()?.open).toBe(true)
    expect(inLater(id)).toBe(true)
    expect(row(id)?.dataset.open).toBe('1')
    expect(answerInput(id)?.value).toBe(text)
  }

  it.each([
    ['Notes', 'notes'],
    ['History', 'done'],
    ['Dashboard', 'dashboard'],
  ])('switches to the Inbox from %s, without moving focus, once the write succeeds', async (_label, tab) => {
    const d = open()
    const id = question(d)
    await bootApp(d)
    click(document.querySelector(`.tab[data-tab="${tab}"]`))
    await settle()
    expect(document.getElementById('needsYou')?.hidden).toBe(true)
    await openReviewQueue()
    expect(lightbox().hidden).toBe(false)
    type(deckInput(), 'Half an answer')
    const focused = document.activeElement
    click(buttonLabelled('Pin for later', lightbox()))
    await settle()

    expect(document.querySelector('.tab[data-tab="needsYou"]')?.getAttribute('aria-selected')).toBe('true')
    expect(document.getElementById('needsYou')?.hidden).toBe(false)
    expect(document.getElementById(tab)?.hidden).toBe(true)
    expect(lightbox().hidden, 'the Review queue stays open').toBe(false)
    expect(document.activeElement === focused || lightbox().contains(document.activeElement)).toBe(true)
    click(lightbox().querySelector('.lb-close'))
    await settle()
    expectDraftInLater(id)
  })

  // Closing the queue returns focus to whatever opened it; after the switch that
  // is the Inbox's Review queue button, never a control on the tab that is gone.
  // The switch itself focuses nothing, even when the write lands while the
  // window is in the background.
  it('returns focus to the Inbox Review queue button after the switch, and moves none while in the background', async () => {
    const d = open()
    const id = question(d)
    await bootApp(d)
    const notesTab = document.querySelector<HTMLElement>('.tab[data-tab="notes"]')!
    click(notesTab)
    await settle()
    notesTab.focus()
    await openReviewQueue()
    type(deckInput(), 'Half an answer')
    const before = document.activeElement
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    click(buttonLabelled('Pin for later', lightbox()))
    await settle()
    expect(document.querySelector('.tab[data-tab="needsYou"]')?.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement, 'the switch moves no focus').toBe(before)

    hasFocus.mockRestore()
    click(lightbox().querySelector('.lb-close'))
    await settle()
    expect(document.activeElement).toBe(document.querySelector('#needsYou .triage-btn'))
    expect(document.activeElement).not.toBe(notesTab)
    expectDraftInLater(id)
  })

  it('stays on the tab when the deferred ask holds no draft', async () => {
    const d = open()
    const id = question(d)
    await bootApp(d)
    click(document.querySelector('.tab[data-tab="notes"]'))
    await settle()
    await openReviewQueue()
    click(buttonLabelled('Pin for later', lightbox()))
    await settle()
    expect(getItem(d, id)!.pinned_at).not.toBeNull()
    expect(document.getElementById('notes')?.hidden).toBe(false)
    expect(document.querySelector('.tab[data-tab="needsYou"]')?.getAttribute('aria-selected')).toBe('false')
  })

  it('stays on the tab when the deferral is refused', async () => {
    const d = open()
    const id = question(d)
    await bootApp(d, {
      interceptFetch: async (input, init, next) => (String(input).endsWith('/later')
        ? new Response(JSON.stringify({ ok: false, reason: 'not_pinnable' }), { headers: { 'content-type': 'application/json' } })
        : await next()),
    })
    click(document.querySelector('.tab[data-tab="notes"]'))
    await settle()
    await openReviewQueue()
    type(deckInput(), 'Half an answer')
    click(buttonLabelled('Pin for later', lightbox()))
    await settle()
    expect(getItem(d, id)!.pinned_at).toBeNull()
    expect(document.getElementById('notes')?.hidden).toBe(false)
    expect(document.querySelector('.tab[data-tab="needsYou"]')?.getAttribute('aria-selected')).toBe('false')
    expect(deckInput()?.value).toBe('Half an answer')
  })

  it('stays on Plans when a drafted row is set aside from its plan panel, where the draft still shows', async () => {
    const d = open()
    upsertBoard(d, { ...AGENT, title: 'Release', rows: [blockedRow()] })
    const rowId = getBoard(d, 'alpha', 'Release')!.rows[0]!.id
    await bootApp(d)
    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    click(buttonLabelled('Answer', document.querySelector(`#boards [data-row-id="${rowId}"]`)!))
    await settle()
    const panel = () => document.querySelector(`#boards [data-row-id="${rowId}"] + .row-panel-row`)
    type(panel()!.querySelector<HTMLTextAreaElement>('.reply-input'), 'Half an answer')
    click(buttonLabelled('Pin for later', panel()!))
    await settle()

    expect(getBoard(d, 'alpha', 'Release')!.rows[0]!.pinned_at).not.toBeNull()
    expect(document.getElementById('boards')?.hidden).toBe(false)
    expect(document.querySelector('.tab[data-tab="needsYou"]')?.getAttribute('aria-selected')).toBe('false')
    expect(panel()?.querySelector<HTMLTextAreaElement>('.reply-input')?.value).toBe('Half an answer')
  })

  it('clears an agent filter that would hide the ask', async () => {
    const d = open()
    const id = question(d)
    advanceClock()
    question(d, 'From another agent', { agent: 'codex' })
    await bootApp(d)
    await showInbox()
    const agents = document.getElementById('agentSelect') as HTMLSelectElement
    agents.value = 'codex'
    agents.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    expect(row(id)).toBeNull()

    await openReviewQueue()
    await showInDeck('Choose: Merge?')
    await pinFromDeck()
    expect((document.getElementById('agentSelect') as HTMLSelectElement).value).toBe('')
    expectDraftInLater(id)
  })

  it('keeps a project filter of All projects, and switches only a filter that would hide the ask', async () => {
    const d = open()
    const id = question(d)
    advanceClock()
    const beta = question(d, 'Beta question', { project: 'beta' })
    await bootApp(d)
    await showInbox()
    await openReviewQueue()
    await showInDeck('Choose: Merge?')
    await pinFromDeck()
    expect(document.querySelector('#rail .rail-tab[data-project="__all__"]')?.getAttribute('aria-selected')).toBe('true')
    expect(inQueue(beta)).toBe(true)
    expectDraftInLater(id)
  })

  it.each([
    ['resets an action filter that would hide the ask', 'task', 'all'],
    ['keeps an action filter that shows the ask', 'decision', 'decision'],
  ])('%s', async (_label, filter, expected) => {
    const d = open()
    const id = question(d)
    advanceClock()
    upsertBoard(d, { ...AGENT, title: 'Release', rows: [blockedRow()] })
    await bootApp(d)
    await showInbox()
    click(document.querySelector(`#needsYouList [data-action-filter="${filter}"]`))
    await settle()
    await openReviewQueue()
    await showInDeck('Choose: Merge?')
    await pinFromDeck()
    expect(document.querySelector('#needsYouList [data-action-filter].active')?.getAttribute('data-action-filter')).toBe(expected)
    expectDraftInLater(id)
  })

  it.each([
    ['turns off an Updates filter that would hide the ask', 'before', false],
    ['keeps an Updates filter that shows the ask', 'after', true],
  ])('%s', async (_label, asked, active) => {
    const d = open()
    const visit = Date.now() + HOUR
    localStorage.setItem('agent-inbox-last-visit', new Date(visit).toISOString())
    if (asked === 'after') advanceClock(2 * HOUR)
    const id = question(d)
    advanceClock(2 * HOUR)
    const fresh = question(d, 'Fresh since the last visit')
    await bootApp(d)
    await showInbox()
    click(document.querySelector('#needsYouList [data-changed-filter]'))
    await settle()
    expect(row(fresh)).not.toBeNull()
    await openReviewQueue()
    await showInDeck('Choose: Merge?')
    await pinFromDeck()
    expect(document.querySelector('#needsYouList [data-changed-filter]')?.classList.contains('active')).toBe(active)
    expectDraftInLater(id)
  })

  it('hands the list selection to the ask it keeps in view', async () => {
    const d = open()
    const first = question(d, 'Selected first')
    advanceClock()
    const id = question(d, 'Deferred with a draft')
    await bootApp(d)
    await showInbox()
    expect(row(first)?.classList.contains('selected')).toBe(true)
    click(buttonLabelled('Review queue'))
    await settle()
    click(lightbox().querySelector('.lb-next'))
    await settle()
    expect(lightbox().textContent).toContain('Choose: Deferred with a draft')
    await pinFromDeck()
    expectDraftInLater(id)
    expect(row(id)?.classList.contains('selected')).toBe(true)
    expect(row(id)?.getAttribute('aria-current')).toBe('true')
    expect(row(first)?.classList.contains('selected')).toBe(false)
  })
})
