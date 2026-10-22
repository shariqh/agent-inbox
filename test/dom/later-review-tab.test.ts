// @vitest-environment jsdom
// Issue #247 (part 2 review, 8a): the `t` key opens the Review queue from any
// tab. A draft on an ask it then defers lives in the Inbox list, so after a
// successful deferral the Inbox becomes the visible tab, without moving focus.
// Closing the queue then returns focus to the Inbox's Review queue button,
// never to the Notes tab that opened it. This is the only boot in its file, so
// its synthetic keydown on document reaches exactly one app instance's listener.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { getItem, insertItem } from '../../src/store.js'
import { answerInput, bootApp, buttonLabelled, click, freshDb, row, settle, type, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

describe('the Review queue opened with `t` on another tab (#247)', () => {
  it('shows the Inbox once a drafted ask is set aside, and leaves focus in the queue', async () => {
    db = freshDb()
    const id = insertItem(db, {
      project: 'alpha', stream: 'main', agent: 'claude', kind: 'question', title: 'Merge?',
      next_step: 'Choose whether to merge.', action_owner: 'approval', options: [{ label: 'Merge', recommended: true }],
    })
    await bootApp(db)
    const notesTab = document.querySelector<HTMLElement>('.tab[data-tab="notes"]')!
    click(notesTab)
    await settle()
    notesTab.focus()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true, cancelable: true }))
    await settle()
    const lightbox = document.getElementById('lightbox')!
    expect(lightbox.hidden).toBe(false)
    const panel = lightbox.querySelector('.lb-panel')
    expect(document.activeElement).toBe(panel)
    type(lightbox.querySelector<HTMLTextAreaElement>('.reply-input:not(.reply-context-input)'), 'Half an answer')
    click(buttonLabelled('Pin for later', lightbox))
    await settle()

    expect(getItem(db, id)!.pinned_at).not.toBeNull()
    expect(document.querySelector('.tab[data-tab="needsYou"]')?.getAttribute('aria-selected')).toBe('true')
    expect(document.getElementById('needsYou')?.hidden).toBe(false)
    expect(document.getElementById('notes')?.hidden).toBe(true)
    expect(lightbox.contains(document.activeElement), 'focus stays in the Review queue').toBe(true)

    click(lightbox.querySelector('.lb-close'))
    await settle()
    expect(document.activeElement, 'not the Notes tab, which is no longer showing').toBe(document.querySelector('#needsYou .triage-btn'))
    expect(document.querySelector<HTMLDetailsElement>('#needsYouList .later-section')?.open).toBe(true)
    expect(row(id)?.dataset.open).toBe('1')
    expect(answerInput(id)?.value).toBe('Half an answer')
  })
})
