import { beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { createViewer } from '../src/viewer.js'
import { annotateBoardRow, getBoard, insertItem, listItems, openDb, updateBoardRow, upsertBoard } from '../src/store.js'
import { scratchDir } from './scratch.js'

function freshDb(): Database.Database {
  return openDb(join(scratchDir('action-viewer-'), 'inbox.db'))
}

describe('viewer action dispositions', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  it('records item clarification and snooze state through explicit routes', async () => {
    const id = insertItem(db, {
      project: 'p', stream: '', agent: 'a', kind: 'question', title: 'Which launch?',
    })
    const app = createViewer(db)
    let response = await app.request(`/api/items/${id}/snooze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ until: '2026-08-06T12:00:00.000Z' }),
    })
    expect(response.status).toBe(200)
    expect(listItems(db)[0]!.snoozed_until).toBe('2026-08-06T12:00:00.000Z')

    response = await app.request(`/api/items/${id}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Please name the exact environment.', kind: 'clarify' }),
    })
    expect(response.status).toBe(200)
    expect(listItems(db)[0]).toMatchObject({
      reply: 'Please name the exact environment.',
      reply_kind: 'clarify',
      snoozed_until: null,
    })
  })

  it('records row decline and snooze state through explicit routes', async () => {
    upsertBoard(db, {
      project: 'p', stream: '', agent: 'a', title: 'Launch',
      rows: [{ label: 'Recruit partners', status: 'blocked' }],
    })
    let board = getBoard(db, 'p', 'Launch')!
    let row = board.rows[0]!
    const app = createViewer(db)
    let response = await app.request(`/api/boards/x/rows/${row.id}/snooze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        until: '2026-08-06T12:00:00.000Z',
        expected_revision: row.revision,
        expected_board_version: board.revision,
      }),
    })
    expect(response.status).toBe(200)
    expect(getBoard(db, 'p', 'Launch')!.rows[0]!.snoozed_until).toBe('2026-08-06T12:00:00.000Z')

    board = getBoard(db, 'p', 'Launch')!
    row = board.rows[0]!
    response = await app.request(`/api/boards/x/rows/${row.id}/annotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'Declined: not this quarter.',
        kind: 'decline',
        expected_revision: row.revision,
        expected_board_version: board.revision,
      }),
    })
    expect(response.status).toBe(200)
    expect(getBoard(db, 'p', 'Launch')!.rows[0]).toMatchObject({
      annotation: 'Declined: not this quarter.',
      annotation_kind: 'decline',
      snoozed_until: null,
    })
  })

  it('snoozes a row with a cleared annotation and says why a current snapshot is refused', async () => {
    upsertBoard(db, {
      project: 'p', stream: '', agent: 'a', title: 'Launch',
      rows: [{ label: 'Upload build', status: 'blocked' }, { label: 'Merge', status: 'blocked' }],
    })
    const until = '2026-08-06T12:00:00.000Z'
    const current = (label: string) => {
      const board = getBoard(db, 'p', 'Launch')!
      return { board, row: board.rows.find((candidate) => candidate.label === label)! }
    }
    const app = createViewer(db)
    const snooze = async (label: string, staleRowBy = 0, staleBoardBy = 0) => {
      const { board, row } = current(label)
      const response = await app.request(`/api/boards/${board.id}/rows/${row.id}/snooze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          until,
          expected_revision: row.revision - staleRowBy,
          expected_board_version: board.revision - staleBoardBy,
        }),
      })
      expect(response.status).toBe(200)
      return response.json()
    }

    annotateBoardRow(db, current('Upload build').row.id, 'Uploaded')
    annotateBoardRow(db, current('Upload build').row.id, '')
    expect(await snooze('Upload build')).toEqual({ ok: true })
    expect(current('Upload build').row.snoozed_until).toBe(until)

    annotateBoardRow(db, current('Merge').row.id, 'Merge it')
    expect(await snooze('Merge')).toEqual({ ok: false, reason: 'not_snoozable' })
    expect(await snooze('Merge', 1)).toEqual({ ok: false, reason: 'version_mismatch' })
    expect(await snooze('Merge', 0, 1)).toEqual({ ok: false, reason: 'version_mismatch' })
    expect(current('Merge').row.snoozed_until).toBeNull()
  })

  it('refuses a stale human action after the row advances', async () => {
    upsertBoard(db, {
      project: 'p', stream: '', agent: 'a', title: 'Launch',
      rows: [{ label: 'Deploy', status: 'blocked' }],
    })
    let board = getBoard(db, 'p', 'Launch')!
    const original = board.rows[0]!
    updateBoardRow(db, {
      project: 'p', stream: '', agent: 'a', title: 'Launch', label: 'Deploy',
      status: 'partial',
      expectedBoardVersion: board.revision,
      expectedRevision: original.revision,
    })
    board = getBoard(db, 'p', 'Launch')!
    updateBoardRow(db, {
      project: 'p', stream: '', agent: 'a', title: 'Launch', label: 'Deploy',
      status: 'blocked',
      expectedBoardVersion: board.revision,
      expectedRevision: board.rows[0]!.revision,
      note: 'New action.',
      next_step: 'Do the new thing.',
      action_owner: 'task',
      impact: 'Required now.',
    })
    const app = createViewer(db)
    const response = await app.request(`/api/boards/x/rows/${original.id}/annotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'Old answer',
        expected_revision: original.revision,
        expected_board_version: 1,
      }),
    })
    expect(await response.json()).toEqual({ ok: false, reason: 'version_mismatch' })
    expect(getBoard(db, 'p', 'Launch')!.rows[0]!.annotation).toBeNull()
  })
})
