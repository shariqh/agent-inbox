// @vitest-environment jsdom
// UX pass, slice 4: the harness refuses what a person cannot do, so a test that pins a
// removed tab, or types where nobody can reach, fails loudly instead of passing vacuously.
// The test DOM ignores CSS and lets code focus and fill controls inside hidden or closed
// containers; a real browser does not.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem } from '../../src/store.js'
import { bootApp, findFor, freshDb, searchFor, tabCount, type, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
})

describe('the stricter harness', () => {
  it('throws for a tab the page does not have, and reads a real one', async () => {
    db = freshDb()
    insertItem(db, { project: 'alpha', stream: 'main', agent: 'copilot', kind: 'question', title: 'Ship?' })
    await bootApp(db)
    expect(tabCount('dashboard')).toBe('1')
    expect(() => tabCount('nowhere')).toThrow(/no "nowhere" tab/)
  })

  it('refuses to type into a field a person cannot reach', async () => {
    db = freshDb()
    await bootApp(db)
    const input = document.getElementById('search') as HTMLInputElement
    input.closest('.floating-search')!.setAttribute('hidden', '')
    expect(() => type(input, 'x')).toThrow(/not reachable/)
    await expect(searchFor('x')).rejects.toThrow(/top-bar search is not drawn/)
    input.closest('.floating-search')!.removeAttribute('hidden')
    await searchFor('x')
    expect(input.value).toBe('x')
  })

  it('refuses findFor() while Find is not showing', async () => {
    db = freshDb()
    await bootApp(db)
    await expect(findFor('x')).rejects.toThrow(/Find|findQuery/)
  })
})
