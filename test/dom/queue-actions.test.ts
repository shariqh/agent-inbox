// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, listItems } from '../../src/store.js'
import { advanceClock, bootApp, click, freshDb, row, settle, showInbox, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'copilot' } as const

function open(): Database.Database {
  db = freshDb()
  return db
}

function press(key: string, target: EventTarget = document): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

describe('Needs-you inspector keyboard ownership', () => {
  it('targets the mouse-open inspector, then follows keyboard selection and actions', async () => {
    const d = open()
    const first = insertItem(d, { ...AGENT, kind: 'question', title: 'First target' })
    advanceClock()
    const second = insertItem(d, { ...AGENT, kind: 'question', title: 'Mouse target' })
    advanceClock()
    const third = insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Keyboard target',
      options: [{ label: 'Approve', recommended: true }, { label: 'Hold' }],
    })
    await bootApp(d)
    await showInbox()

    click(row(second))
    await settle()
    expect(row(second)?.dataset.open).toBe('1')
    press('e')
    await settle()

    expect(listItems(d).find((item) => item.id === second)?.status).toBe('resolved')
    expect(listItems(d).find((item) => item.id === first)?.status).toBe('open')

    press('j')
    expect(row(third)?.classList.contains('selected')).toBe(true)
    press('Enter')
    await settle()
    expect(row(third)?.dataset.open).toBe('1')
    press('1')
    await settle()

    expect(listItems(d).find((item) => item.id === third)?.reply).toBe('Approve')
    expect(listItems(d).find((item) => item.id === first)?.reply).toBeNull()
  })

  it('leaves Enter and Space native on buttons and links instead of expanding the selected row', async () => {
    const d = open()
    const id = insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Native controls',
      options: [{ label: 'Approve', recommended: true }, { label: 'Hold' }],
    })
    await bootApp(d)
    await showInbox()
    click(row(id))
    await settle()

    const controls: HTMLElement[] = [
      ...document.querySelectorAll<HTMLElement>('#needsYouList .triage-btn, #needsYouList .relay-btn'),
      ...row(id)!.querySelectorAll<HTMLElement>('.opt-pill, .reply-row button, .actions button'),
    ]
    const link = document.createElement('a')
    link.href = 'https://example.com'
    link.textContent = 'Source'
    document.body.appendChild(link)
    controls.push(link)

    expect(controls.length).toBeGreaterThan(5)
    for (const control of controls) {
      for (const key of ['Enter', ' ']) {
        control.focus()
        const event = press(key, control)
        expect(event.defaultPrevented, `${key} was intercepted on ${control.tagName}`).toBe(false)
        expect(row(id)?.dataset.open).toBe('1')
      }
    }
  })
})
