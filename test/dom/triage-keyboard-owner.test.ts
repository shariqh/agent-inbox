// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, listItems } from '../../src/store.js'
import { advanceClock, bootApp, click, freshDb, settle, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'copilot' } as const

function press(key: string, target: EventTarget): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

describe('Review queue keyboard ownership', () => {
  it('focuses the dialog, owns advertised shortcuts after navigation, and restores the opener', async () => {
    db = freshDb()
    const first = insertItem(db, {
      ...AGENT,
      kind: 'question',
      title: 'First review',
      options: [{ label: 'Approve first', recommended: true }, { label: 'Hold first' }],
    })
    advanceClock()
    insertItem(db, {
      ...AGENT,
      kind: 'question',
      title: 'Second review',
      options: [{ label: 'Approve second', recommended: true }, { label: 'Hold second' }],
    })
    await bootApp(db)

    const opener = document.querySelector<HTMLButtonElement>('.triage-btn')!
    opener.focus()
    const enter = press('Enter', opener)
    expect(enter.defaultPrevented).toBe(false)
    click(opener)
    await settle()

    const lightbox = document.getElementById('lightbox')!
    const panel = lightbox.querySelector<HTMLElement>('.lb-panel')!
    expect(lightbox.hidden).toBe(false)
    expect(document.activeElement).toBe(panel)

    press('j', panel)
    expect(lightbox.querySelector('.lb-count')?.textContent).toBe('2 of 2')
    press('k', panel)
    expect(lightbox.querySelector('.lb-count')?.textContent).toBe('1 of 2')

    const next = lightbox.querySelector<HTMLButtonElement>('.lb-next')!
    next.focus()
    click(next)
    expect(lightbox.querySelector('.lb-count')?.textContent).toBe('2 of 2')
    press('k', next)
    expect(lightbox.querySelector('.lb-count')?.textContent).toBe('1 of 2')

    const input = lightbox.querySelector<HTMLInputElement>('.lb-card .reply-input:not(.reply-context-input)')!
    input.focus()
    const inputOne = press('1', input)
    const inputJ = press('j', input)
    expect(inputOne.defaultPrevented).toBe(false)
    expect(inputJ.defaultPrevented).toBe(false)
    expect(lightbox.querySelector('.lb-count')?.textContent).toBe('1 of 2')

    panel.focus()
    press('1', panel)
    await settle()
    expect(listItems(db).find((item) => item.id === first)?.reply).toBe('Approve first')

    press('Escape', panel)
    expect(lightbox.hidden).toBe(true)
    expect(document.activeElement).toBe(opener)
  })
})
