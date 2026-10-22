// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem } from '../../src/store.js'
import { bootApp, buttonLabelled, click, collapseRow, freshDb, pollTick, row, settle, showInbox, T0, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

describe('item inspector scroll', () => {
  const scrollHosts = ['.nrow-card-scroll', '.nrow-card-head', '.nrow-card-compose']

  it.each(scrollHosts)('keeps %s in position when the 3-second poll rebuilds the open card', async (selector) => {
    const d = freshDb()
    db = d
    const id = insertItem(d, {
      project: 'alpha',
      stream: 'viewer',
      agent: 'copilot',
      session: 'session-scroll',
      kind: 'question',
      title: 'Review the long proposal',
      detail: 'The full proposal extends below the inspector fold.',
      context: 'Long background '.repeat(100),
    })

    await bootApp(d)
    click(row(id))
    await settle()

    const before = row(id)?.querySelector<HTMLElement>(selector)
    before!.scrollTop = 240
    before!.dispatchEvent(new Event('scroll'))

    await pollTick()
    await settle()

    const after = row(id)?.querySelector<HTMLElement>(selector)
    expect(after, 'the open item should survive the poll rebuild').not.toBeNull()
    expect(after).not.toBe(before)
    expect(after?.scrollTop).toBe(240)
  })

  it('restores the footer against decorated geometry without moving its focused action', async () => {
    const nativeSet = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!.set!
    vi.spyOn(Element.prototype, 'scrollTop', 'set').mockImplementation(function (this: Element, value: number) {
      // jsdom does not lay out/clamp scroll containers. Model the measured phone
      // footer's shorter range until decoration and editor sizing are complete.
      const sized = [...this.querySelectorAll<HTMLTextAreaElement>('textarea')]
        .every((editor) => Boolean(editor.style.height))
      const maximum = this.matches('.nrow-card-compose')
        ? this.querySelector('.opt-pill[data-shortcut]') ? sized ? 170 : 149 : 99
        : Infinity
      nativeSet.call(this, Math.min(value, maximum))
    })
    db = freshDb()
    const id = insertItem(db, {
      project: 'alpha', stream: 'main', agent: 'copilot', kind: 'question',
      title: 'Keep the focused footer action visible',
      options: [
        { label: 'Approve', detail: 'Continue the rollout.', recommended: true },
        { label: 'Hold', detail: 'Keep it unchanged.' },
      ],
    })
    await bootApp(db)
    await showInbox()
    click(row(id))
    await settle()
    buttonLabelled('Note', row(id)!)!.focus()
    await settle()
    const before = row(id)!.querySelector<HTMLElement>('.nrow-card-compose')!
    expect(before.querySelector('.opt-pill[data-shortcut]')).not.toBeNull()
    before.scrollTop = 158
    before.dispatchEvent(new Event('scroll'))

    await pollTick()
    await settle()

    const after = row(id)!.querySelector<HTMLElement>('.nrow-card-compose')!
    expect(after).not.toBe(before)
    expect(after.querySelector('.opt-pill[data-shortcut]')).not.toBeNull()
    expect(after.scrollTop).toBe(158)
    expect(document.activeElement).toBe(buttonLabelled('Note', row(id)!))
  })

  it.each(scrollHosts)('does not replace the inspector while %s is still scrolling', async (selector) => {
    const d = freshDb()
    db = d
    const id = insertItem(d, {
      project: 'alpha',
      stream: 'viewer',
      agent: 'copilot',
      session: 'session-scroll',
      kind: 'question',
      title: 'Review the long proposal',
      context: 'Long background '.repeat(100),
    })

    await bootApp(d)
    click(row(id))
    await settle()

    const before = row(id)?.querySelector<HTMLElement>(selector)
    before!.scrollTop = 240

    // Land a scroll event immediately before the 3-second poll. Replacing this
    // node would stop Chromium's in-flight wheel/trackpad momentum even if the
    // replacement receives the same scrollTop.
    const untilNextPoll = 3000 - ((Date.now() - T0) % 3000)
    await vi.advanceTimersByTimeAsync(untilNextPoll - 50)
    before!.dispatchEvent(new Event('scroll'))
    await vi.advanceTimersByTimeAsync(50)
    await settle()

    expect(row(id)?.querySelector(selector)).toBe(before)

    // Continued momentum moves the quiet deadline instead of letting the first
    // event's timer replace the card underneath a still-moving gesture.
    await vi.advanceTimersByTimeAsync(100)
    before!.scrollTop = 320
    before!.dispatchEvent(new Event('scroll'))
    await vi.advanceTimersByTimeAsync(150)
    expect(row(id)?.querySelector(selector)).toBe(before)

    // Once scrolling has settled, the held fresh frame should paint normally.
    await vi.advanceTimersByTimeAsync(50)
    await settle()
    const after = row(id)?.querySelector<HTMLElement>(selector)
    expect(after).not.toBe(before)
    expect(after?.scrollTop).toBe(320)
  })

  it('keeps the expanded queue row at the same viewport position across a poll rebuild', async () => {
    const d = freshDb()
    db = d
    const id = insertItem(d, {
      project: 'alpha',
      stream: 'viewer',
      agent: 'copilot',
      session: 'session-page-scroll',
      kind: 'question',
      title: 'Keep this card visually anchored',
      context: 'Long background '.repeat(100),
    })

    await bootApp(d)
    click(row(id))
    await settle()

    const before = row(id)
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const top = this === before
          ? 420
          : this.classList.contains('nrow')
            ? 300
            : this.classList.contains('nrow-card')
              ? 116
              : 0
        return DOMRect.fromRect({ y: top, width: 400, height: 600 })
      })
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {})

    await pollTick()
    await settle()

    expect(row(id)).not.toBe(before)
    expect(scrollBy).toHaveBeenCalledWith(0, -120)
    rect.mockRestore()
    scrollBy.mockRestore()
  })

  it.each(scrollHosts)('starts %s at the top after the human changes or reopens the item', async (selector) => {
    const d = freshDb()
    db = d
    const firstId = insertItem(d, {
      project: 'alpha',
      stream: 'viewer',
      agent: 'copilot',
      session: 'session-scroll',
      kind: 'question',
      title: 'First proposal',
    })
    const secondId = insertItem(d, {
      project: 'alpha',
      stream: 'viewer',
      agent: 'copilot',
      session: 'session-scroll',
      kind: 'question',
      title: 'Second proposal',
    })

    await bootApp(d)
    click(row(firstId))
    await settle()
    row(firstId)!.querySelector<HTMLElement>(selector)!.scrollTop = 180

    click(row(secondId))
    await settle()
    expect(row(secondId)?.querySelector<HTMLElement>(selector)?.scrollTop).toBe(0)

    await collapseRow(secondId)
    click(row(firstId))
    await settle()
    expect(row(firstId)?.querySelector<HTMLElement>(selector)?.scrollTop).toBe(0)
  })

  it('restores the focused inspector control after a polling rebuild', async () => {
    const d = freshDb()
    db = d
    const id = insertItem(d, {
      project: 'alpha',
      stream: 'viewer',
      agent: 'copilot',
      session: 'session-focus',
      kind: 'question',
      title: 'Choose a release window',
    })

    await bootApp(d)
    click(row(id))
    await settle()

    const before = buttonLabelled('Send', row(id)!)
    before!.focus()
    expect(document.activeElement).toBe(before)

    await pollTick()
    await settle()

    const after = buttonLabelled('Send', row(id)!)
    expect(after).not.toBe(before)
    expect(document.activeElement).toBe(after)
  })
})
