// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, upsertBoard } from '../../src/store.js'
import {
  advanceClock, bootApp, buttonLabelled, click, freshDb, pollTick, row, settle, showInbox, useDomTest,
} from './harness.js'

useDomTest()
let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null; vi.restoreAllMocks() })
const scope = { project: 'alpha', stream: 'main', agent: 'copilot' }

function question(database: Database.Database, title = 'Review this change') {
  return insertItem(database, { ...scope, kind: 'question', title })
}

describe('passive refresh while the viewer is unfocused', () => {
  it('does not restore inspector focus from a blurred webview, while arrivals still render', async () => {
    db = freshDb()
    const id = question(db)
    await bootApp(db)
    await showInbox()
    click(row(id))
    await settle()
    const before = buttonLabelled('Send', row(id)!)!
    before.focus()
    expect(document.activeElement).toBe(before)
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    advanceClock()
    const arrival = question(db, 'New arrival while I am typing elsewhere')
    await pollTick()
    expect(before.isConnected).toBe(false)
    expect(document.activeElement?.tagName).toBe('BODY')
    expect(row(id)?.getAttribute('aria-expanded')).toBe('true')
    expect(row(arrival)).not.toBeNull()
  })

  it('does not restore a queue row after the document loses keyboard ownership', async () => {
    db = freshDb()
    const id = question(db)
    await bootApp(db)
    await showInbox()
    const before = row(id)!
    before.focus()
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    await pollTick()
    expect(before.isConnected).toBe(false)
    expect(document.activeElement?.tagName).toBe('BODY')
    expect(row(id)).not.toBeNull()
  })

  it('does not refocus a project control during an ambient rail refresh', async () => {
    db = freshDb()
    question(db)
    await bootApp(db)
    const before = document.querySelector<HTMLButtonElement>('#rail .rail-tab[data-project="alpha"]')!
    before.focus()
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    advanceClock()
    insertItem(db, { ...scope, project: 'beta', kind: 'question', title: 'A new project' })
    await pollTick()
    expect(before.isConnected).toBe(false)
    expect(document.activeElement?.tagName).toBe('BODY')
    expect(document.querySelector('#rail .rail-tab[data-project="beta"]')).not.toBeNull()
  })

  it('does not restore Plan Flow focus from an inactive document', async () => {
    db = freshDb()
    upsertBoard(db, {
      ...scope, title: 'A plan', rows: [{ label: 'Review the plan', status: 'blocked' }],
    })
    await bootApp(db)
    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    click(buttonLabelled('Plan flow', document.querySelector('#boards .board')!))
    await settle()
    const before = buttonLabelled('Open details', document.getElementById('missionbox')!)!
    before.focus()
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    await pollTick()
    expect(before.isConnected).toBe(false)
    expect(document.activeElement?.tagName).toBe('BODY')
    expect(document.getElementById('missionbox')?.hidden).toBe(false)
  })

  it('still restores the same inspector control while the viewer owns focus', async () => {
    db = freshDb()
    const id = question(db)
    await bootApp(db)
    await showInbox()
    click(row(id))
    await settle()
    const before = buttonLabelled('Send', row(id)!)!
    before.focus()
    expect(document.hasFocus()).toBe(true)
    await pollTick()
    expect(before.isConnected).toBe(false)
    expect(document.activeElement).toBe(buttonLabelled('Send', row(id)!))
  })
})
