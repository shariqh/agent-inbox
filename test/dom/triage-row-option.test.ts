// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { getBoard, upsertBoard } from '../../src/store.js'
import { bootApp, buttonLabelled, click, freshDb, settle, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'copilot' } as const

function press(key: string, target: EventTarget): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

describe('Review queue row option shortcuts', () => {
  it('routes 1-4 through the revision-pinned board annotation path and advances the deck', async () => {
    db = freshDb()
    upsertBoard(db, {
      ...AGENT,
      title: 'Release',
      rows: [{
        label: 'Approve release',
        status: 'blocked',
        note: 'Choose a disposition.',
        action_owner: 'approval',
        options: [
          { label: 'Approve', recommended: true },
          { label: 'Hold' },
        ],
      }],
    })
    const original = getBoard(db, 'alpha', 'Release')!
    const originalRow = original.rows[0]!
    const bridge = await bootApp(db)

    click(buttonLabelled('Review queue'))
    await settle()
    const lightbox = document.getElementById('lightbox')!
    const panel = lightbox.querySelector<HTMLElement>('.lb-panel')!
    expect(lightbox.querySelector('.lb-card')?.textContent).toContain('Approve release')

    press('1', panel)
    await settle()

    const updated = getBoard(db, 'alpha', 'Release')!
    expect(updated.rows[0]?.annotation).toBe('Approve')
    expect(lightbox.querySelector('.lb-count')?.textContent).toBe('all clear')
    const post = bridge.posts.find((entry) => entry.url.endsWith(`/rows/${originalRow.id}/annotate`))
    expect(JSON.parse(String(post?.init?.body))).toMatchObject({
      text: 'Approve',
      kind: 'answer',
      expected_revision: originalRow.revision,
      expected_board_version: original.revision,
    })
  })
})
