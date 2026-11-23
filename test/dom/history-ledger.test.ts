// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, resolveItem } from '../../src/store.js'
import { advanceClock, bootApp, click, findFor, findRowFor, freshDb, settle, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

// UX pass, slice 4: History's ledger is Find's finished rows. A row rests closed with its
// outcome as the one extra; its other text is in the card it opens into.
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
    click(document.querySelector('.tab[data-tab="find"]'))
    await settle()

    const rows = () => [...document.querySelectorAll<HTMLElement>('#findList > .find-row')]
    expect(rows().every((row) => row.querySelector('.find-row-main')?.getAttribute('aria-expanded') === 'false')).toBe(true)
    expect(rows().map((row) => row.querySelector('.find-row-main')?.textContent ?? '').join(' ')).not.toContain('Next step')
    // the ask closed without a reply is found by a query; its outcome shows at rest
    await findFor('Verify the package')
    expect(rows()).toHaveLength(1)
    expect(findRowFor(question)?.querySelector('.find-extra')?.textContent).toBe('Every artifact matched its manifest.')
    expect(findRowFor(question)?.querySelector('.find-row-body')).toBeNull()
    await findFor('Release published')
    const release = rows()[0]!
    expect(release.querySelector('.find-extra')?.textContent).toBe('Completed')
    click(release.querySelector('.find-row-main'))
    await settle()
    expect(rows()[0]?.querySelector('.find-row-body')?.textContent).toContain('The signed release is available.')
  })
})
