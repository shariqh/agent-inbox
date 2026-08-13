// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { advanceBoardRow, getBoard, upsertBoard } from '../../src/store.js'
import {
  bootApp, buttonLabelled, click, freshDb, settle, type, useDomTest,
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
    click(buttonLabelled('Plan flow', document.querySelector('#boards .board')!))
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

    const fold = document.querySelector<HTMLDetailsElement>('.stale-drafts-fold')!
    expect(mission.hidden).toBe(true)
    expect(document.getElementById('needsYou')?.hidden).toBe(false)
    expect(fold?.textContent).toContain('Preserve mission response')
    expect(fold?.textContent).toContain('Original mission context')
    expect(document.activeElement).toBe(fold?.querySelector('summary'))
    click(buttonLabelled('Clear', fold))
    await settle()
    expect(document.querySelector('.stale-drafts-fold')).toBeNull()
  })
})
