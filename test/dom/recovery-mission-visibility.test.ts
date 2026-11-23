// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { advanceBoardRow, getBoard, upsertBoard } from '../../src/store.js'
import {
  bootApp, buttonLabelled, click, freshDb, settle, type, useDomTest, reach,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'copilot' } as const

describe('draft recovery visibility from Plan flow', () => {
  it('closes the mission overlay and focuses recovery after a row revision refusal', async () => {
    db = freshDb()
    upsertBoard(db, {
      ...AGENT,
      title: 'Launch',
      rows: [{
        label: 'Approve launch',
        status: 'blocked',
        note: 'Original action',
        next_step: 'Choose.',
        action_owner: 'approval',
        impact: 'Unblocks launch.',
        context: 'Original mission context',
      }],
    })
    const original = getBoard(db, 'alpha', 'Launch')!
    await bootApp(db)

    click(document.querySelector('.tab[data-tab="boards"]'))
    click(await reach(() => buttonLabelled('Plan flow', document.querySelector('#boards .board')!)))
    await settle()
    click(document.querySelector('.mission-node'))
    await settle()
    const mission = document.getElementById('missionbox')!
    const detail = mission.querySelector<HTMLElement>('.mission-detail')!
    type(detail.querySelector<HTMLInputElement>('.reply-input'), 'Preserve mission response')
    expect(advanceBoardRow(db, {
      project: 'alpha',
      title: 'Launch',
      label: 'Approve launch',
      expectedBoardVersion: original.revision,
      expectedRevision: original.rows[0]!.revision,
      note: 'Replacement action',
      next_step: 'Choose again.',
      action_owner: 'approval',
      impact: 'Still blocks launch.',
      context: 'Replacement mission context',
    }).ok).toBe(true)

    click(buttonLabelled('Send', detail))
    await settle()

    // #636: the row asks again, so the text is kept beside it in the Inbox
    const kept = document.querySelector<HTMLElement>('#needsYouList .row-recovery')!
    expect(mission.hidden).toBe(true)
    expect(document.getElementById('needsYou')?.hidden).toBe(false)
    expect(kept?.textContent).toContain('Preserve mission response')
    expect(kept?.textContent).toContain('The ask changed before your text was sent.')
    expect(document.querySelector('.stale-drafts-fold')).toBeNull()
    expect(document.activeElement).toBe(kept)
    click(buttonLabelled('Discard', kept))
    await settle()
    expect(document.querySelector('#needsYouList .row-recovery')).toBeNull()
  })
})
