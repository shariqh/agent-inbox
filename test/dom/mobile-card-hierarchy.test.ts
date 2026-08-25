// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, upsertBoard } from '../../src/store.js'
import {
  bootApp, click, freshDb, row, rows, setViewport, settle, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

describe('mobile expanded action hierarchy', () => {
  it('keeps a question in one DOM-stable shell with a close control and action footer', async () => {
    db = freshDb()
    const id = insertItem(db, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'Choose the release window',
      options: [
        { label: 'Tonight', recommended: true },
        { label: 'Tomorrow' },
      ],
    })
    setViewport(375)
    await bootApp(db)
    click(document.querySelector('.tab[data-tab="needsYou"]'))
    await settle()
    click(row(id))
    await settle()

    const card = row(id)?.querySelector('.nrow-card')
    expect(card?.children[0]?.classList.contains('nrow-card-head')).toBe(true)
    expect(card?.children[1]?.classList.contains('nrow-card-scroll')).toBe(true)
    expect(card?.children[2]?.classList.contains('nrow-card-compose')).toBe(true)
    expect(card?.querySelector('.nrow-card-scroll > .card')).not.toBeNull()
    expect(card?.querySelector('.nrow-card-compose > .options')).not.toBeNull()

    click(card?.querySelector('button[aria-label="Close action"]'))
    await settle()
    expect(row(id)?.querySelector('.nrow-card')).toBeNull()
    expect(row(id)?.getAttribute('aria-expanded')).toBe('false')
  })

  it('uses the same action footer hierarchy for a blocked plan row', async () => {
    db = freshDb()
    upsertBoard(db, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      title: 'Release plan',
      rows: [{
        label: 'Approve rollout',
        status: 'blocked',
        action_owner: 'approval',
        note: 'The build is ready.',
        next_step: 'Approve the rollout.',
        impact: 'Unblocks publishing.',
        outcome: 'Rollout verified.',
        options: [
          { label: 'Approve', detail: 'Publish after the final checks.', recommended: true },
          { label: 'Hold', detail: 'Keep the release paused.' },
          { label: 'Canary first', detail: 'Publish to the canary channel only.' },
          { label: 'Cancel', detail: 'Stop this rollout.' },
        ],
      }],
    })
    setViewport(320)
    await bootApp(db)
    click(document.querySelector('.tab[data-tab="needsYou"]'))
    await settle()
    click(rows()[0])
    await settle()

    const card = rows()[0]?.querySelector('.nrow-card')
    expect(card?.querySelector('.nrow-card-scroll > .lb-row-card')).not.toBeNull()
    expect(card?.querySelector('.nrow-card-compose > .row-answer')).not.toBeNull()
    expect(card?.querySelectorAll('.nrow-card-compose .row-options .option')).toHaveLength(4)
    expect(card?.querySelector('.nrow-card-compose .row-options.comparing')).toBeNull()
    expect(card?.querySelector('.nrow-card-compose .compare-toggle')?.textContent).toBe('Compare options')
    expect(card?.textContent?.match(/Rollout verified\./g)).toHaveLength(1)
  })
})
