// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem } from '../../src/store.js'
import { bootApp, buttonLabelled, click, freshDb, pollTick, row, settle, T0, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

describe('item inspector scroll', () => {
  it('keeps its position when the 3-second poll rebuilds the open card', async () => {
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

    const before = row(id)?.querySelector<HTMLElement>('.nrow-card')
    before!.scrollTop = 240
    before!.dispatchEvent(new Event('scroll'))

    await pollTick()
    await settle()

    const after = row(id)?.querySelector<HTMLElement>('.nrow-card')
    expect(after, 'the open item should survive the poll rebuild').not.toBeNull()
    expect(after).not.toBe(before)
    expect(after?.scrollTop).toBe(240)
  })

  it('does not replace the inspector while trackpad momentum is still scrolling it', async () => {
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

    const before = row(id)?.querySelector<HTMLElement>('.nrow-card')
    before!.scrollTop = 240

    // Land a scroll event immediately before the 3-second poll. Replacing this
    // node would stop Chromium's in-flight wheel/trackpad momentum even if the
    // replacement receives the same scrollTop.
    const untilNextPoll = 3000 - ((Date.now() - T0) % 3000)
    await vi.advanceTimersByTimeAsync(untilNextPoll - 50)
    before!.dispatchEvent(new Event('scroll'))
    await vi.advanceTimersByTimeAsync(50)
    await settle()

    expect(row(id)?.querySelector('.nrow-card')).toBe(before)

    // Continued momentum moves the quiet deadline instead of letting the first
    // event's timer replace the card underneath a still-moving gesture.
    await vi.advanceTimersByTimeAsync(100)
    before!.scrollTop = 320
    before!.dispatchEvent(new Event('scroll'))
    await vi.advanceTimersByTimeAsync(150)
    expect(row(id)?.querySelector('.nrow-card')).toBe(before)

    // Once scrolling has settled, the held fresh frame should paint normally.
    await vi.advanceTimersByTimeAsync(50)
    await settle()
    const after = row(id)?.querySelector<HTMLElement>('.nrow-card')
    expect(after).not.toBe(before)
    expect(after?.scrollTop).toBe(320)
  })

  it('starts at the top after the human changes or reopens the item', async () => {
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
    row(firstId)!.querySelector<HTMLElement>('.nrow-card')!.scrollTop = 180

    click(row(secondId))
    await settle()
    expect(row(secondId)?.querySelector<HTMLElement>('.nrow-card')?.scrollTop).toBe(0)

    click(row(secondId))
    await settle()
    click(row(firstId))
    await settle()
    expect(row(firstId)?.querySelector<HTMLElement>('.nrow-card')?.scrollTop).toBe(0)
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
