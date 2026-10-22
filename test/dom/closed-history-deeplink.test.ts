// @vitest-environment jsdom
// Issue #184: a deep link to a closed item the page omitted. Its own file, so no
// earlier boot's window listeners answer its hash change with reads of their own
// (see harness.ts): the reads below are exactly this app's.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, resolveItem } from '../../src/store.js'
import { advanceClock, bootApp, freshDb, navigateToHash, pollTick, settle, useDomTest } from './harness.js'

useDomTest()
let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const HISTORY = '/api/items/history'

describe('deep link to omitted closed history (issue #184)', () => {
  it('reads the complete History once, opens the item, then revalidates it', async () => {
    db = freshDb()
    const archive: string[] = []
    for (let index = 0; index < 3; index += 1) {
      advanceClock()
      const id = insertItem(db, { project: 'archive', stream: 'legacy', agent: 'legacy-bot', kind: 'question', title: `Archived decision ${index}` })
      advanceClock()
      resolveItem(db, id, `Archived outcome ${index}`)
      archive.push(id)
    }
    // 60 newer closures fill the page's 50 recent slots, so the archive is omitted.
    for (let index = 0; index < 60; index += 1) {
      advanceClock()
      const id = insertItem(db, { project: 'alpha', stream: 'main', agent: 'copilot', kind: 'note', title: `Alpha closed ${index}` })
      advanceClock()
      resolveItem(db, id, `Alpha outcome ${index}`)
    }
    const reads: number[] = []
    await bootApp(db, {
      interceptFetch: async (input, _init, next) => {
        const response = await next()
        if (String(input) === HISTORY) reads.push(response.status)
        return response
      },
    })
    expect(reads).toEqual([])

    navigateToHash(`#item/${archive[0]}`)
    await settle()
    expect(reads).toEqual([200])
    expect(document.getElementById('done')?.hidden).toBe(false)
    expect(document.querySelector('#rail button.rail-tab[data-project="archive"]')?.getAttribute('aria-selected')).toBe('true')
    const card = () => document.querySelector<HTMLDetailsElement>(`#done [data-card-id="${archive[0]}"]`)
    expect(card()?.open).toBe(true)
    expect(document.activeElement).toBe(card()?.querySelector(':scope > summary'))

    await pollTick()
    expect(card()).not.toBeNull()
    expect(reads).toEqual([200, 304])
  })
})
