// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem } from '../../src/store.js'
import { bootApp, click, freshDb, setViewport, settle, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

function open(): Database.Database {
  db = freshDb()
  return db
}

const disclosure = (): HTMLElement => document.getElementById('projectDisclosure') as HTMLElement
const toggle = (): HTMLButtonElement => document.getElementById('projectDisclosureToggle') as HTMLButtonElement
const name = (): HTMLElement => document.getElementById('projectDisclosureName') as HTMLElement
const pointerDown = (el: Element): void => {
  el.dispatchEvent(new window.Event('pointerdown', { bubbles: true }))
}

describe('compact project menu', () => {
  it('summarises the current project and closes on selection, outside action, and Escape', async () => {
    const d = open()
    insertItem(d, { project: 'alpha-project', stream: 'main', agent: 'copilot', kind: 'question', title: 'Alpha question' })
    insertItem(d, { project: 'beta-project', stream: 'main', agent: 'copilot', kind: 'question', title: 'Beta question' })
    setViewport(900)
    await bootApp(d)

    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(name().textContent).toBe('All projects')
    expect(document.getElementById('projectDisclosureCount')?.textContent).toBe('2')

    click(toggle())
    expect(disclosure().dataset.open).toBe('true')
    expect(document.getElementById('rail')?.getAttribute('aria-orientation')).toBe('vertical')
    click(document.querySelector('#rail .rail-tab[data-project="alpha-project"]'))
    await settle()
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(name().textContent).toBe('alpha project')
    expect(document.getElementById('projectDisclosureDot')?.getAttribute('style')).toContain('background')
    expect(toggle().getAttribute('aria-label')).toBe('Choose project, current alpha project')
    expect(document.activeElement).toBe(toggle())

    click(toggle())
    pointerDown(document.getElementById('search')!)
    expect(toggle().getAttribute('aria-expanded')).toBe('false')

    click(toggle())
    document.getElementById('search')?.focus()
    expect(toggle().getAttribute('aria-expanded')).toBe('false')

    click(toggle())
    toggle().focus()
    toggle().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(toggle())
  })
})
