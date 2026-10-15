// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem } from '../../src/store.js'
import {
  bootApp, buttonLabelled, click, freshDb, pollTick, row, setViewport, settle, showInbox, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

function press(key: string, extra: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra })
  document.activeElement!.dispatchEvent(event)
  return event
}

it('reveals explicit Tab targets only in their scrolling owner and leaves passive restoration alone', async () => {
  db = freshDb()
  const id = insertItem(db, {
    project: 'alpha', stream: 'main', agent: 'copilot', kind: 'question',
    title: 'Choose a release',
    options: [
      { label: 'Approve', detail: 'Continue with the verified build.', recommended: true },
      { label: 'Hold', detail: 'Leave the release unchanged.' },
    ],
  })
  setViewport(375)
  await bootApp(db)
  await showInbox()
  click(row(id))
  await settle()
  const card = row(id)!.querySelector<HTMLElement>('.nrow-card')!
  // jsdom cannot evaluate the phone container query or prove clipping geometry.
  card.style.position = 'fixed'
  card.style.overflow = 'hidden'
  const footer = card.querySelector<HTMLElement>('.nrow-card-compose')!
  footer.style.overflowY = 'auto'
  Object.defineProperties(footer, {
    clientTop: { configurable: true, value: 1 },
    clientHeight: { configurable: true, value: 293 },
    scrollHeight: { configurable: true, value: 463 },
  })
  vi.spyOn(footer, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 406, 375, 294))
  vi.spyOn(card, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 375, 700))
  const send = buttonLabelled('Send', card)!
  const context = card.querySelector<HTMLTextAreaElement>('.reply-context-input')!
  const more = [...card.querySelectorAll<HTMLElement>('summary')]
    .find((summary) => summary.textContent?.includes('More responses'))!
  const resolve = buttonLabelled('Resolve', card)!
  const dismiss = buttonLabelled('Dismiss', card)!
  const note = buttonLabelled('Note', card)!
  const close = card.querySelector<HTMLButtonElement>('.nrow-card-close')!
  for (const [target, top, height] of [
    [send, 642.5, 44], [context, 696.5, 49], [more, 761.5, 44],
    [resolve, 813.5, 44], [dismiss, 813.5, 44], [note, 813.5, 44],
  ] as const) {
    vi.spyOn(target, 'getBoundingClientRect')
      .mockImplementation(() => new DOMRect(14, top - footer.scrollTop, 100, height))
  }
  vi.spyOn(close, 'getBoundingClientRect').mockReturnValue(new DOMRect(317, 12, 44, 44))
  const tabTo = (target: HTMLElement, shiftKey = false) => {
    const focus = vi.spyOn(target, 'focus')
    expect(press('Tab', { shiftKey }).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(target)
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true })
    if (footer.contains(target)) {
      expect(target.getBoundingClientRect().top).toBeGreaterThanOrEqual(407)
      expect(target.getBoundingClientRect().bottom).toBeLessThanOrEqual(700)
    }
    expect(card.scrollTop).toBe(0)
    focus.mockRestore()
  }
  send.focus({ preventScroll: true })
  for (const target of [context, more, resolve, dismiss, note, close]) tabTo(target)
  for (const target of [note, dismiss, resolve, more, context, send]) tabTo(target, true)

  expect(footer.scrollTop).toBeGreaterThan(0)
  footer.scrollTop = 100
  const focus = vi.spyOn(HTMLElement.prototype, 'focus')
  await pollTick()
  const refreshed = row(id)!.querySelector<HTMLElement>('.nrow-card')!
  expect(card.isConnected).toBe(false)
  expect(document.activeElement).toBe(buttonLabelled('Send', refreshed))
  expect(refreshed.querySelector('.nrow-card-compose')!.scrollTop).toBe(100)
  expect(focus).toHaveBeenLastCalledWith({ preventScroll: true })

  vi.spyOn(document, 'hasFocus').mockReturnValue(false)
  focus.mockClear()
  await pollTick()
  expect(focus).not.toHaveBeenCalled()
})
