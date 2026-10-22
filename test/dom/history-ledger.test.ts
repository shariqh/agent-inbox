// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, resolveItem } from '../../src/store.js'
import { advanceClock, bootApp, click, freshDb, settle, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

describe('History outcome ledger', () => {
  it('renders finished work as compact closed rows with visible outcomes', async () => {
    db = freshDb()
    const question = insertItem(db, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Verify the package',
      next_step: 'Inspect all artifacts.',
    })
    resolveItem(db, question, 'Every artifact matched its manifest.')
    advanceClock()
    insertItem(db, {
      project: 'beta',
      stream: 'main',
      agent: 'claude',
      kind: 'done',
      title: 'Release published',
      detail: 'The signed release is available.',
    })

    await bootApp(db)
    click(document.querySelector('.tab[data-tab="done"]'))
    await settle()

    const rows = [...document.querySelectorAll<HTMLDetailsElement>('#done .history-row')]
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => !row.open)).toBe(true)
    expect(document.querySelector('#done .history-row summary')?.textContent).not.toContain('Next step')
    expect(document.querySelector('#done')?.textContent).toContain('Every artifact matched its manifest.')
    expect(document.querySelector('#done')?.textContent).toContain('The signed release is available.')
  })
})
