// @vitest-environment jsdom
// test/dom/harness.test.ts
// The harness's own guarantees. Later DOM tests are written against these, so a
// silent regression here would weaken every one of them at once rather than
// failing loudly in one place.
import { describe, it, expect, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem } from '../../src/store.js'
import { bootApp, click, freshDb, row, rowTitles, settle, type, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'claude' } as const

describe('the harness gives every test a fresh module instance', () => {
  // These two run in order and are deliberately coupled: without vi.resetModules()
  // the second test re-uses the FIRST test's already-evaluated app.js — which is
  // still bound to the first DB — and renders zero rows against its own fixture.
  it('boot 1 sees only its own DB', async () => {
    db = freshDb()
    insertItem(db, { ...AGENT, kind: 'question', title: 'first-db-item' })
    await bootApp(db)
    expect(rowTitles()).toEqual(['first-db-item'])
  })

  it('boot 2 sees only ITS own DB, not the previous test\'s', async () => {
    db = freshDb()
    insertItem(db, { ...AGENT, kind: 'question', title: 'second-db-item' })
    await bootApp(db)
    expect(rowTitles()).toEqual(['second-db-item'])
  })
})

describe('the harness refuses stale nodes', () => {
  it('click() throws rather than silently acting on a node a re-render replaced', async () => {
    db = freshDb()
    const id = insertItem(db, { ...AGENT, kind: 'question', title: 'q' })
    await bootApp(db)

    const stale = row(id)!
    stale.remove() // stand in for the rebuild renderNeedsYou does on every render()

    expect(() => click(stale)).toThrow(/stale node/)
    expect(() => type(stale as unknown as HTMLInputElement, 'x')).toThrow(/stale node/)
    expect(() => click(null)).toThrow(/nothing to click/)
  })

  it('re-queried accessors keep working across a render', async () => {
    db = freshDb()
    const id = insertItem(db, { ...AGENT, kind: 'question', title: 'q' })
    await bootApp(db)

    click(row(id)) // open
    await settle()
    click(row(id)) // …and close, through a freshly-queried node
    await settle()

    expect(document.querySelectorAll('.nrow-card').length).toBe(0)
  })
})
