// @vitest-environment jsdom
// UX pass, slice 4, step 0: the Note control on an item card is an editor in place.
// `prompt()` throws in the desktop app's own window and dialogs are off in another
// Mac's Inbox, so the native prompt never worked there. The card is shared by Home's
// asks, the Review queue and the item pages, so all of them get the editor.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { annotateItem, getItem, insertItem, resolveItem } from '../../src/store.js'
import {
  bootApp, buttonLabelled, click, freshDb, noteEditor, pollTick, row, settle, type, useDomTest, writeItemNote,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
})

const AGENT = { project: 'alpha', stream: 'main', agent: 'copilot' } as const
const PAUSED = 'paused — updating when you\'re done'

// Every way the old native prompt could still be reached fails the test loudly.
function forbidPrompt() {
  return vi.spyOn(window, 'prompt').mockImplementation(() => {
    throw new Error('window.prompt must not be called: the Note control is an editor in place')
  })
}

async function openAsk(d: Database.Database, title = 'Ship it?') {
  const id = insertItem(d, { ...AGENT, kind: 'question', title })
  await bootApp(d)
  click(row(id))
  await settle()
  return id
}

describe('the Note editor on an item card', () => {
  it('opens in place on a press of Note, prefilled with the stored note, and takes focus', async () => {
    db = freshDb()
    const id = insertItem(db, { ...AGENT, kind: 'question', title: 'Ship it?' })
    annotateItem(db, id, 'Earlier thought.')
    await bootApp(db)
    const prompt = forbidPrompt()
    click(row(id))
    await settle()
    expect(noteEditor(row(id)), 'no editor before Note is pressed').toBeNull()

    click(buttonLabelled('Note', row(id)!))
    await settle()
    const editor = noteEditor(row(id))
    expect(editor?.value).toBe('Earlier thought.')
    expect(document.activeElement).toBe(editor)
    expect(editor?.dataset.draftFocusKey).toBe(`note:${id}`)
    expect(buttonLabelled('Note', row(id)!)?.getAttribute('aria-expanded')).toBe('true')
    expect(buttonLabelled('Save', row(id)!.querySelector('.note-editor')!)).not.toBeNull()
    expect(buttonLabelled('Cancel', row(id)!.querySelector('.note-editor')!)).not.toBeNull()
    expect(prompt).not.toHaveBeenCalled()
  })

  it('never opens on focus or hover, only on the press', async () => {
    db = freshDb()
    const id = await openAsk(db)
    const note = buttonLabelled('Note', row(id)!)!
    note.focus()
    note.dispatchEvent(new window.PointerEvent('pointerover', { bubbles: true }))
    note.dispatchEvent(new window.MouseEvent('mouseenter'))
    await pollTick()
    expect(noteEditor(row(id))).toBeNull()
    expect(buttonLabelled('Note', row(id)!)?.getAttribute('aria-expanded')).toBe('false')
  })

  it('saves the typed text, clears with an empty save, and Cancel sends nothing', async () => {
    db = freshDb()
    const id = insertItem(db, { ...AGENT, kind: 'question', title: 'Ship it?' })
    const bridge = await bootApp(db)
    forbidPrompt()
    click(row(id))
    await settle()

    await writeItemNote(() => row(id), 'deploy after the freeze')
    expect(getItem(db, id)?.annotation).toBe('deploy after the freeze')
    expect(noteEditor(row(id)), 'Save closes the editor').toBeNull()
    expect(row(id)?.querySelector('.nrow-card .annotation')?.textContent).toContain('deploy after the freeze')

    click(buttonLabelled('Note', row(id)!))
    await settle()
    type(noteEditor(row(id)), 'never mind')
    click(buttonLabelled('Cancel', row(id)!.querySelector('.note-editor')!))
    await settle()
    expect(noteEditor(row(id))).toBeNull()
    expect(bridge.posts).toHaveLength(1)
    expect(getItem(db, id)?.annotation).toBe('deploy after the freeze')

    await writeItemNote(() => row(id), '')
    expect(getItem(db, id)?.annotation).toBe('')
    expect(row(id)?.querySelector('.nrow-card .annotation')?.textContent).toContain('Note cleared')
  })

  it('holds the typed text through a poll and keeps it across a rebuild', async () => {
    db = freshDb()
    const id = await openAsk(db)
    click(buttonLabelled('Note', row(id)!))
    await settle()
    type(noteEditor(row(id)), 'half a thought')
    advanceAndChange(db)
    await pollTick()
    expect(document.getElementById('pauseHint')?.textContent).toBe(PAUSED)
    expect(noteEditor(row(id))?.value).toBe('half a thought')
    noteEditor(row(id))!.blur()
    // a frame the person asks for rebuilds the card from module state
    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()
    expect(noteEditor(row(id))?.value).toBe('half a thought')
  })

  it('moves the typed text to the unsent responses when the item closes under it', async () => {
    db = freshDb()
    const id = await openAsk(db)
    click(buttonLabelled('Note', row(id)!))
    await settle()
    type(noteEditor(row(id)), 'too late')
    noteEditor(row(id))!.blur()
    resolveItem(db, id, 'Closed elsewhere.')
    // a draft nobody has touched for two minutes no longer holds the poll's frame
    await vi.advanceTimersByTimeAsync(130_000)
    await pollTick()
    const fold = document.querySelector('#needsYouList .stale-drafts-fold')
    expect(fold?.textContent).toContain('Note was not saved')
    expect(fold?.textContent).toContain('too late')
    expect(buttonLabelled('Retry', fold!)).toBeNull()
  })

  it('is the same editor in the Review queue', async () => {
    db = freshDb()
    const id = insertItem(db, { ...AGENT, kind: 'question', title: 'Ship it?' })
    await bootApp(db)
    forbidPrompt()
    click(document.querySelector('.triage-btn'))
    await settle()
    const deck = () => document.getElementById('lightbox')
    await writeItemNote(deck, 'from the queue')
    expect(getItem(db, id)?.annotation).toBe('from the queue')
  })

  it('on Home\'s opened ask the editor opens in the bar beside the Note button, not in the scrolling body', async () => {
    db = freshDb()
    const id = insertItem(db, { ...AGENT, kind: 'question', title: 'Ship it?', detail: 'x '.repeat(400) })
    await bootApp(db)
    click(row(id))
    await settle()
    const noteButton = buttonLabelled('Note', row(id)!)!
    expect(noteButton.closest('.nrow-card-compose')).not.toBeNull()
    click(noteButton)
    await settle()
    const editor = noteEditor(row(id))!
    expect(document.activeElement).toBe(editor)
    expect(editor.closest('.nrow-card-scroll'), 'not in the scrolling body').toBeNull()
    const compose = editor.closest('.nrow-card-compose')!
    expect(compose, 'in the bar').not.toBeNull()
    expect(compose.querySelector(':scope > .actions')?.nextElementSibling, 'after the actions').toBe(editor.closest('.note-editor'))
  })

  it('Cancel puts focus back on the Note button of the surface it was pressed in', async () => {
    db = freshDb()
    const id = insertItem(db, { ...AGENT, kind: 'question', title: 'Ship it?' })
    await bootApp(db)
    // Home
    click(row(id))
    await settle()
    click(buttonLabelled('Note', row(id)!))
    await settle()
    click(buttonLabelled('Cancel', row(id)!.querySelector('.note-editor')!))
    await settle()
    expect(document.activeElement).toBe(buttonLabelled('Note', row(id)!))
    // the Review queue, with Home's copy of the same ask behind it
    click(document.querySelector('.triage-btn'))
    await settle()
    const deck = document.getElementById('lightbox')!
    click(buttonLabelled('Note', deck))
    await settle()
    type(noteEditor(deck), 'never mind')
    click(buttonLabelled('Cancel', deck.querySelector('.note-editor')!))
    await settle()
    expect(document.activeElement, 'focus stays in the queue').toBe(buttonLabelled('Note', deck))
  })
})

function advanceAndChange(d: Database.Database) {
  vi.advanceTimersByTime(1000)
  insertItem(d, { ...AGENT, kind: 'question', title: 'Another ask' })
}
