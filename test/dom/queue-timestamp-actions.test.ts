// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, listItems } from '../../src/store.js'
import { bootApp, click, freshDb, row, settle, showInbox, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'copilot' } as const

function press(key: string, target: EventTarget): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

describe('Needs-you timestamp keyboard ownership', () => {
  it('selects its row on focus and click before destructive or option shortcuts run', async () => {
    db = freshDb()
    const first = insertItem(db, {
      ...AGENT,
      kind: 'question',
      title: 'Open inspector',
      options: [{ label: 'Proceed', recommended: true }, { label: 'Wait' }],
    })
    const second = insertItem(db, {
      ...AGENT,
      kind: 'question',
      title: 'Timestamp target',
      options: [{ label: 'Approve', recommended: true }, { label: 'Hold' }],
    })
    await bootApp(db)
    await showInbox()
    click(row(first))
    await settle()
    await settle()
    expect(row(first)?.dataset.open).toBe('1')
    expect(row(first)?.classList.contains('selected')).toBe(true)

    const asked = () => row(second)!.querySelector<HTMLElement>('.nrow-asked')!
    asked().focus()
    expect(document.activeElement).toBe(asked())
    expect(row(second)?.classList.contains('selected')).toBe(true)

    for (const key of ['Enter', ' ']) {
      const event = press(key, asked())
      expect(event.defaultPrevented).toBe(true)
      expect(row(second)?.dataset.open).toBeUndefined()
    }

    press('1', asked())
    await settle()
    expect(listItems(db).find((item) => item.id === second)?.reply).toBe('Approve')
    expect(listItems(db).find((item) => item.id === first)?.reply).toBeNull()

    const openInspector = row(first)!.querySelector<HTMLElement>('.nrow-card')!
    openInspector.focus()
    press('1', openInspector)
    await settle()
    expect(listItems(db).find((item) => item.id === first)?.reply).toBe('Proceed')

    click(asked())
    press('x', asked())
    expect(row(second)?.classList.contains('staged')).toBe(true)
    expect(row(first)?.classList.contains('staged')).toBe(false)

    press('e', asked())
    await settle()
    expect(listItems(db).find((item) => item.id === second)?.status).toBe('resolved')
    expect(listItems(db).find((item) => item.id === first)?.status).toBe('open')
  })
})
