import { beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { createViewer } from '../src/viewer.js'
import {
  annotateBoardRow, archiveBoard, getBoard, getBoardByTitle, getItem, insertItem, listBoards, listItems, openDb, pinBoardRow,
  pinItem, replyItem, updateBoardRow, upsertBoard,
} from '../src/store.js'
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

// Issue #247 — the two `later` routes. Invalid input is a 400 before any store
// call (#163); a store refusal of a valid request is a 200 { ok:false } with the
// snooze route's reason split (#160); and a pin reaches every snapshot that
// carries the ask, whose validators move with it.
describe('pin for later routes (#247)', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  const post = (path: string, body: string, app = createViewer(db)) => app.request(path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  })
  async function expectInvalid(res: Response) {
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ ok: false, error: expect.any(String) })
  }

  const question = () => insertItem(db, { project: 'p', stream: '', agent: 'a', kind: 'question', title: 'Which launch?' })
  const plan = () => upsertBoard(db, {
    project: 'p', stream: '', agent: 'a', title: 'Launch',
    rows: [{ label: 'Upload', status: 'blocked' }, { label: 'Merge', status: 'blocked' }],
  })
  const current = (label: string) => {
    const board = getBoardByTitle(db, 'p', 'Launch')!
    const row = board.rows.find((candidate) => candidate.label === label)!
    return {
      board,
      row,
      path: `/api/boards/${board.id}/rows/${row.id}/later`,
      pins: { expected_revision: row.revision, expected_board_version: board.revision },
    }
  }

  // Each case receives the route's other fields, valid, so the field under test
  // is the ONLY thing wrong with the request.
  type BodyCase = [label: string, body: (valid: Record<string, unknown>) => string]
  const INVALID_PINNED: BodyCase[] = [
    ['malformed JSON', () => '{"pinned": '],
    ['a JSON null body', () => 'null'],
    ['a missing pinned', (valid) => JSON.stringify(valid)],
    ['a string pinned', (valid) => JSON.stringify({ ...valid, pinned: 'true' })],
    ['a numeric pinned', (valid) => JSON.stringify({ ...valid, pinned: 1 })],
    ['a null pinned', (valid) => JSON.stringify({ ...valid, pinned: null })],
  ]
  const INVALID_PINS: BodyCase[] = [
    ['no pins', () => JSON.stringify({ pinned: true })],
    ['a string revision', (valid) => JSON.stringify({ ...valid, pinned: true, expected_revision: String(valid['expected_revision']) })],
    ['a fractional board version', (valid) => JSON.stringify({ ...valid, pinned: true, expected_board_version: 1.5 })],
  ]

  // A pinned and an unpinned target: a body read as either instruction would
  // change one of them.
  it.each(INVALID_PINNED)('POST /api/items/:id/later refuses %s before any store call', async (_label, body) => {
    const pinned = question()
    expect(pinItem(db, pinned, true)).toBe(true)
    const unpinned = question()
    const before = listItems(db)
    await expectInvalid(await post(`/api/items/${pinned}/later`, body({})))
    await expectInvalid(await post(`/api/items/${unpinned}/later`, body({})))
    expect(listItems(db)).toEqual(before)
  })

  it.each([...INVALID_PINNED, ...INVALID_PINS])('POST /api/boards/:id/rows/:rowId/later refuses %s before any store call', async (_label, body) => {
    plan()
    const { board, row } = current('Upload')
    expect(pinBoardRow(db, row.id, true, row.revision, board.revision)).toBe(true)
    const before = listBoards(db)
    for (const label of ['Upload', 'Merge']) {
      const { path, pins } = current(label)
      await expectInvalid(await post(path, body(pins)))
    }
    expect(listBoards(db)).toEqual(before)
  })

  it('pins and unpins a question, and says why a valid request is refused', async () => {
    const id = question()
    let res = await post(`/api/items/${id}/later`, JSON.stringify({ pinned: true, ignored: 'extra fields are ignored' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(getItem(db, id)!.pinned_at).toMatch(/^\d{4}-/)
    res = await post(`/api/items/${id}/later`, JSON.stringify({ pinned: true }))
    expect(await res.json(), 'pinning again is not a refusal').toEqual({ ok: true })

    res = await post(`/api/items/${id}/later`, JSON.stringify({ pinned: false }))
    expect(await res.json()).toEqual({ ok: true })
    expect(getItem(db, id)!.pinned_at).toBeNull()
    res = await post(`/api/items/${id}/later`, JSON.stringify({ pinned: false }))
    expect(res.status, 'a refusal of a valid request is not an error').toBe(200)
    expect(await res.json()).toEqual({ ok: false, reason: 'not_pinnable' })

    replyItem(db, id, 'Ship it')
    res = await post(`/api/items/${id}/later`, JSON.stringify({ pinned: true }))
    expect(await res.json()).toEqual({ ok: false, reason: 'not_pinnable' })
    res = await post('/api/items/missing/later', JSON.stringify({ pinned: true }))
    expect(await res.json()).toEqual({ ok: false, reason: 'not_pinnable' })
    expect(getItem(db, id)!.pinned_at).toBeNull()
  })

  it('pins a row without moving its revisions, and splits a refusal into stale pins and an unpinnable row', async () => {
    plan()
    let target = current('Upload')
    let res = await post(target.path, JSON.stringify({ pinned: true, ...target.pins, expected_revision: target.pins.expected_revision - 1 }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: false, reason: 'version_mismatch' })
    res = await post(target.path, JSON.stringify({ pinned: true, ...target.pins, expected_board_version: target.pins.expected_board_version - 1 }))
    expect(await res.json()).toEqual({ ok: false, reason: 'version_mismatch' })
    expect(current('Upload').row.pinned_at).toBeNull()

    res = await post(target.path, JSON.stringify({ pinned: true, ...target.pins }))
    expect(await res.json()).toEqual({ ok: true })
    expect(current('Upload').row.pinned_at).toMatch(/^\d{4}-/)
    expect(current('Upload').pins, 'a pin is not content: both revisions stay put').toEqual(target.pins)
    res = await post(target.path, JSON.stringify({ pinned: false, ...target.pins }))
    expect(await res.json()).toEqual({ ok: true })
    expect(current('Upload').row.pinned_at).toBeNull()
    res = await post(target.path, JSON.stringify({ pinned: false, ...target.pins }))
    expect(await res.json(), 'nothing left to unpin').toEqual({ ok: false, reason: 'not_pinnable' })

    annotateBoardRow(db, current('Merge').row.id, 'Merged')
    target = current('Merge')
    res = await post(target.path, JSON.stringify({ pinned: true, ...target.pins }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: false, reason: 'not_pinnable' })
    expect(current('Merge').row.pinned_at).toBeNull()

    const { board } = current('Upload')
    expect(archiveBoard(db, board.id, board.revision)).toBe(true)
    target = current('Upload')
    res = await post(target.path, JSON.stringify({ pinned: true, ...target.pins }))
    expect(await res.json(), 'an archived plan takes no row actions').toEqual({ ok: false, reason: 'not_pinnable' })
    res = await post(`/api/boards/${board.id}/rows/missing/later`, JSON.stringify({ pinned: true, ...target.pins }))
    expect(await res.json(), 'a vanished row is a stale snapshot').toEqual({ ok: false, reason: 'version_mismatch' })
  })

  it('reaches /api/items, /api/boards and the dock’s attention reads of both, and moves each validator', async () => {
    const id = question()
    plan()
    const app = createViewer(db)
    const paths = ['/api/items', '/api/items?scope=attention', '/api/boards', '/api/boards?scope=attention']
    const read = async (path: string) => {
      const res = await app.request(path)
      return { etag: res.headers.get('ETag')!, body: await res.json() }
    }
    const before = await Promise.all(paths.map(read))
    expect(before[0]!.body.needsYou[0].items[0]).toMatchObject({ id, pinned_at: null })
    expect(before[1]!.body.needsYou[0].items[0]).toMatchObject({ id, pinned_at: null })
    expect(before[2]!.body[0].rows[0]).toMatchObject({ label: 'Upload', pinned_at: null })
    expect(before[3]!.body[0].rows[0]).toMatchObject({ label: 'Upload', pinned_at: null })

    expect(await (await post(`/api/items/${id}/later`, JSON.stringify({ pinned: true }), app)).json()).toEqual({ ok: true })
    const { path, pins } = current('Upload')
    expect(await (await post(path, JSON.stringify({ pinned: true, ...pins }), app)).json()).toEqual({ ok: true })

    const after = await Promise.all(paths.map(read))
    for (const [index, path] of paths.entries()) expect(after[index]!.etag, path).not.toBe(before[index]!.etag)
    expect(after[0]!.body.needsYou[0].items[0].pinned_at).toMatch(/^\d{4}-/)
    expect(after[1]!.body.needsYou[0].items[0].pinned_at).toMatch(/^\d{4}-/)
    expect(after[2]!.body[0].rows[0].pinned_at).toMatch(/^\d{4}-/)
    expect(after[3]!.body[0].rows[0].pinned_at).toMatch(/^\d{4}-/)
    for (const [index, path] of paths.entries()) {
      const res = await app.request(path, { headers: { 'If-None-Match': before[index]!.etag } })
      expect(res.status, `${path} answers the old validator with the new body`).toBe(200)
    }
  })
})
