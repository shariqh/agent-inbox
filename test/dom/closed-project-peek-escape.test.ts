// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { closedProjects, insertItem } from '../../src/store.js'
import {
  advanceClock, bootApp, click, freshDb, rowTitles, settle, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const railTab = (project: string): HTMLElement | null =>
  document.querySelector(`#rail button.rail-tab[data-project="${project}"]`)

const rowAction = (project: string): HTMLElement | null =>
  railTab(project)?.parentElement?.querySelector('.rail-close') ?? null

it('exits a desktop archived-project peek on Escape', async () => {
  db = freshDb()
  insertItem(db, { project: 'alpha', stream: 'main', agent: 'copilot', kind: 'question', title: 'a-question' })
  advanceClock()
  insertItem(db, { project: 'beta', stream: 'main', agent: 'copilot', kind: 'question', title: 'b-question' })
  await bootApp(db)

  click(rowAction('beta'))
  await settle()
  click(document.querySelector('#rail .closed-fold button.rail-tab[data-project="beta"]'))
  await settle()
  expect(document.querySelector('.closed-banner')?.textContent).toContain('beta is closed')
  expect(rowTitles()).toEqual(['b-question'])

  document.dispatchEvent(new window.KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  }))
  await settle()

  expect(closedProjects(db), 'exiting a peek must not reopen the project').toEqual(['beta'])
  expect(document.querySelector('.closed-banner')).toBeNull()
  expect(rowTitles()).toEqual(['a-question'])
  expect(railTab('__all__')?.getAttribute('aria-selected')).toBe('true')
  expect(document.activeElement).toBe(document.querySelector('#rail .closed-fold > summary'))
})
