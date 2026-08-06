// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem } from '../../src/store.js'
import { bootApp, buttonLabelled, click, freshDb, pollTick, row, settle, useDomTest } from './harness.js'

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
