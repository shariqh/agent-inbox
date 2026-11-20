// @vitest-environment jsdom
// UX pass, slice 1, point 7: shortcut tiles are drawn only while Show keys is
// on, and every shortcut of an ask works with them hidden. One boot in its own
// file: an earlier boot's document listeners in the same file would see these
// keys first (jsdom keeps one document per file).
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { getItem, insertItem } from '../../src/store.js'
import { answerInput, attachStylesheet, bootApp, click, freshDb, row, settle, showInbox, type, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

function question(d: Database.Database, title: string): string {
  return insertItem(d, {
    project: 'alpha', stream: 'main', agent: 'copilot', kind: 'question', title,
    options: [
      { label: 'Canary', detail: 'Check a small group first, then widen.', recommended: true },
      { label: 'Full rollout', detail: 'Update every customer at once.' },
    ],
  })
}

describe('shortcut tiles (UX ask, point 7)', () => {
  const press = (key: string, target: Element = document.activeElement ?? document.body, extra: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra })
    target.dispatchEvent(event)
    return event
  }
  const keysShown = () => document.documentElement.classList.contains('keys-shown')

  it('keeps every shortcut of an ask working with its tiles hidden: 1–4, r, submit, e, x and t', async () => {
    db = freshDb()
    const choose = question(db, 'Choose by key')
    const write = question(db, 'Write by key')
    const resolve = question(db, 'Resolve by key')
    const dismiss = question(db, 'Dismiss by key')
    attachStylesheet()
    await bootApp(db)
    await showInbox()
    expect(keysShown()).toBe(false)
    const openCard = async (id: string) => {
      click(row(id))
      await settle()
      const card = row(id)!.querySelector<HTMLElement>('.nrow-card')!
      card.focus()
      return card
    }

    await openCard(choose)
    press('2')
    await settle()
    expect(getItem(db, choose)?.reply).toBe('Full rollout')

    await openCard(write)
    press('r')
    const editor = answerInput(write)!
    expect(document.activeElement).toBe(editor)
    type(editor, 'Canary, then the rest')
    press('Enter', editor, { ctrlKey: true })
    await settle()
    expect(getItem(db, write)?.reply).toBe('Canary, then the rest')

    await openCard(resolve)
    press('e')
    await settle()
    expect(getItem(db, resolve)?.status).not.toBe('open')

    await openCard(dismiss)
    press('x')
    await vi.advanceTimersByTimeAsync(5_100)
    await settle()
    expect(getItem(db, dismiss)?.status).not.toBe('open')

    ;(document.activeElement as HTMLElement | null)?.blur?.()
    press('t', document.body)
    await settle()
    expect(document.getElementById('lightbox')?.hidden).toBe(false)
    expect(keysShown()).toBe(false)
  })
})
