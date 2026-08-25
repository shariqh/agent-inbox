// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem } from '../../src/store.js'
import { bootApp, click, collapseRow, freshDb, row, rows, settle, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

describe('Needs-you row accessibility', () => {
  it('exposes one roving listbox option and keeps expanded state semantic', async () => {
    db = freshDb()
    const firstId = insertItem(db, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'First decision',
    })
    const secondId = insertItem(db, {
      project: 'beta',
      stream: 'main',
      agent: 'claude',
      kind: 'question',
      title: 'Second decision',
    })

    await bootApp(db)
    click(document.querySelector('.tab[data-tab="needsYou"]'))
    await settle()

    expect(document.getElementById('needsYouList')?.getAttribute('role')).toBe('list')
    expect(rows().every((entry) => entry.getAttribute('role') === 'listitem')).toBe(true)
    expect(rows().filter((entry) => entry.tabIndex === 0)).toHaveLength(1)
    expect(rows().filter((entry) => entry.getAttribute('aria-current') === 'true')).toHaveLength(1)

    const first = row(firstId)!
    first.focus()
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await settle()

    const second = row(secondId)!
    expect(document.activeElement).toBe(second)
    expect(second.getAttribute('aria-current')).toBe('true')
    expect(second.getAttribute('aria-expanded')).toBe('false')

    second.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await settle()
    expect(row(secondId)?.getAttribute('aria-expanded')).toBe('true')

    await collapseRow(secondId)
    expect(row(secondId)?.getAttribute('aria-expanded')).toBe('false')
  })
})
