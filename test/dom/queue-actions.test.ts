// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { acknowledgeHandoff, insertItem, listItems } from '../../src/store.js'
import { advanceClock, answerInput, badgeCount, bootApp, buttonLabelled, click, freshDb, row, sendButton, settle, showInbox, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'copilot' } as const

function open(): Database.Database {
  db = freshDb()
  return db
}

function press(key: string, target: EventTarget = document): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

describe('Needs-you inspector keyboard ownership', () => {
  it('targets the mouse-open inspector, then follows keyboard selection and actions', async () => {
    const d = open()
    const first = insertItem(d, { ...AGENT, kind: 'question', title: 'First target' })
    advanceClock()
    const second = insertItem(d, { ...AGENT, kind: 'question', title: 'Mouse target' })
    advanceClock()
    const third = insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Keyboard target',
      options: [{ label: 'Approve', recommended: true }, { label: 'Hold' }],
    })
    await bootApp(d)
    await showInbox()

    click(row(second))
    await settle()
    expect(row(second)?.dataset.open).toBe('1')
    press('e')
    await settle()

    expect(listItems(d).find((item) => item.id === second)?.status).toBe('resolved')
    expect(listItems(d).find((item) => item.id === first)?.status).toBe('open')

    press('j')
    expect(row(third)?.classList.contains('selected')).toBe(true)
    press('Enter')
    await settle()
    expect(row(third)?.dataset.open).toBe('1')
    press('1')
    await settle()

    expect(listItems(d).find((item) => item.id === third)?.reply).toBe('Approve')
    expect(listItems(d).find((item) => item.id === first)?.reply).toBeNull()
  })

  it('leaves Enter and Space native on buttons and links instead of expanding the selected row', async () => {
    const d = open()
    const id = insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Native controls',
      options: [{ label: 'Approve', recommended: true }, { label: 'Hold' }],
    })
    await bootApp(d)
    await showInbox()
    click(row(id))
    await settle()

    const controls: HTMLElement[] = [
      ...document.querySelectorAll<HTMLElement>('#needsYouList .triage-btn, #needsYouList .relay-btn'),
      ...row(id)!.querySelectorAll<HTMLElement>('.opt-pill, .reply-row button, .actions button'),
    ]
    const link = document.createElement('a')
    link.href = 'https://example.com'
    link.textContent = 'Source'
    document.body.appendChild(link)
    controls.push(link)

    expect(controls.length).toBeGreaterThan(5)
    for (const control of controls) {
      for (const key of ['Enter', ' ']) {
        control.focus()
        const event = press(key, control)
        expect(event.defaultPrevented, `${key} was intercepted on ${control.tagName}`).toBe(false)
        expect(row(id)?.dataset.open).toBe('1')
      }
    }
  })
})

// Issue #612: a `done` flag with a real next step is a hand-off. It sits in the
// Inbox until the person presses Acknowledge, and has nothing to answer.
describe('hand-offs in the Inbox', () => {
  const handoff = (d: Database.Database, title: string, next_step = 'Review the draft in the preview.') => {
    advanceClock()
    return insertItem(d, { ...AGENT, kind: 'done', title, detail: 'The draft is written.', next_step })
  }

  it('lists a hand-off, not a milestone, and counts it', async () => {
    const d = open()
    const h = handoff(d, 'Draft is ready')
    const m = handoff(d, 'Shipped v2', 'No action')
    await bootApp(d)
    await showInbox()
    expect(row(h)).not.toBeNull()
    expect(row(m)).toBeNull()
    expect(badgeCount()).toBe(1)
    expect(row(h)!.textContent).toContain('Review the draft in the preview.')
  })

  it('opens to the title, TL;DR and next step with Acknowledge, Snooze and Pin, and no answer box', async () => {
    const d = open()
    const h = handoff(d, 'Draft is ready')
    await bootApp(d)
    await showInbox()
    click(row(h))
    await settle()
    const card = row(h)!
    expect(card.dataset.open).toBe('1')
    expect(card.textContent).toContain('Draft is ready')
    expect(card.textContent).toContain('The draft is written.')
    expect(card.textContent).toContain('Review the draft in the preview.')
    expect(buttonLabelled('Acknowledge', card)).not.toBeNull()
    expect(answerInput(h)).toBeNull()
    expect(sendButton(h)).toBeNull()
    expect(card.querySelector('textarea, .row-answer, .options, .opt-pill')).toBeNull()
    expect(buttonLabelled('Resolve', card)).toBeNull()
    click(card.querySelector('.disposition-menu > summary'))
    expect(buttonLabelled('Pin for later', card)).not.toBeNull()
    expect(buttonLabelled('Tomorrow', card)).not.toBeNull()
    // a hand-off is not an answerable ask: no clarify or decline
    expect(buttonLabelled('Needs clarification', card)).toBeNull()
    expect(buttonLabelled('Decline', card)).toBeNull()
  })

  it('Acknowledge resolves it with the outcome Acknowledged and clears it from the list and the count', async () => {
    const d = open()
    const h = handoff(d, 'Draft is ready')
    const other = handoff(d, 'Second draft', 'Try the second draft.')
    await bootApp(d)
    await showInbox()
    expect(badgeCount()).toBe(2)
    click(row(h))
    await settle()
    click(buttonLabelled('Acknowledge', row(h)!))
    await settle()
    expect(listItems(d).find((item) => item.id === h)).toMatchObject({ status: 'resolved', outcome: 'Acknowledged' })
    expect(listItems(d).find((item) => item.id === other)?.status).toBe('open')
    expect(row(h)).toBeNull()
    expect(badgeCount()).toBe(1)
  })

  it('Pin for later sets it aside, and Back to inbox returns it', async () => {
    const d = open()
    const h = handoff(d, 'Draft is ready')
    await bootApp(d)
    await showInbox()
    click(row(h))
    await settle()
    click(row(h)!.querySelector('.disposition-menu > summary'))
    click(buttonLabelled('Pin for later', row(h)!))
    await settle()
    expect(listItems(d).find((item) => item.id === h)?.pinned_at).not.toBeNull()
    expect(badgeCount()).toBe(0)
    expect(row(h)!.querySelector('.nrow-wake')).not.toBeNull()
    click(row(h)!.querySelector('.nrow-wake'))
    await settle()
    expect(listItems(d).find((item) => item.id === h)?.pinned_at).toBeNull()
    expect(badgeCount()).toBe(1)
  })

  it('draws no ★ quick answer, option pill or answer control on a hand-off, even one flagged with options', async () => {
    const d = open()
    advanceClock()
    const h = insertItem(d, {
      ...AGENT, kind: 'done', title: 'Draft is ready', detail: 'The draft is written.', next_step: 'Review the draft.',
      options: [{ label: 'Merge', recommended: true }, { label: 'Hold' }],
    })
    await bootApp(d)
    await showInbox()
    expect(row(h)!.querySelector('.nrow-star')!.children).toHaveLength(0)
    click(row(h))
    await settle()
    expect(row(h)!.querySelector('.nrow-star')!.children).toHaveLength(0)
    expect(row(h)!.querySelector('.opt-pill, .options, .reply-input, .reply-row')).toBeNull()
  })

  it('shows the finished work’s title on the opened card, and no duplicate when it equals the next step', async () => {
    const d = open()
    const h = handoff(d, 'Draft is ready')
    const same = handoff(d, 'Try the second draft.', 'Try the second draft.')
    await bootApp(d)
    await showInbox()
    click(row(h))
    await settle()
    const line = row(h)!.querySelector<HTMLElement>('.card-finished')
    expect(line?.textContent).toBe('Draft is ready')
    // between the headline and the TL;DR
    const card = row(h)!.querySelector('.nrow-card-scroll .card')!
    const order = [...card.querySelectorAll('.card-finished, .card-tldr')]
    expect(order.map((el) => el.className.split(' ')[0])).toEqual(['card-finished', 'card-tldr'])
    click(row(same))
    await settle()
    expect(row(same)!.querySelector('.card-finished')).toBeNull()
  })

  it('a window that shows an already-acknowledged hand-off gets a refusal and just reloads', async () => {
    const d = open()
    const h = handoff(d, 'Draft is ready')
    await bootApp(d)
    await showInbox()
    click(row(h))
    await settle()
    // another window acknowledged it first
    expect(acknowledgeHandoff(d, h)).toEqual({ ok: true })
    click(buttonLabelled('Acknowledge', row(h)!))
    await settle()
    expect(listItems(d).find((item) => item.id === h)).toMatchObject({ status: 'resolved', outcome: 'Acknowledged' })
    expect(row(h)).toBeNull()
    expect(badgeCount()).toBe(0)
    expect(document.getElementById('status')?.textContent ?? '').toBe('')
  })
})
