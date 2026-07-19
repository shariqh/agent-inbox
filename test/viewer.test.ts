import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { openDb, insertItem, listItems, upsertBoard, listBoards, annotateBoardRow } from '../src/store.js'
import { createViewer } from '../src/viewer.js'

function freshDb(): Database.Database {
  return openDb(join(mkdtempSync(join(tmpdir(), 'view-')), 'inbox.db'))
}

describe('viewer api', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  it('GET /api/items returns grouped items', async () => {
    insertItem(db, { project: 'p', stream: '', agent: 'claude-code', kind: 'question', title: 'q' })
    const app = createViewer(db)
    const res = await app.request('/api/items')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.needsYou[0].items[0].title).toBe('q')
  })

  it('POST resolve, dismiss, annotate mutate the row', async () => {
    const a = insertItem(db, { project: 'p', stream: '', agent: 'claude-code', kind: 'question', title: 'a' })
    const b = insertItem(db, { project: 'p', stream: '', agent: 'claude-code', kind: 'note', title: 'b' })
    const app = createViewer(db)
    expect((await app.request(`/api/items/${a}/resolve`, { method: 'POST' })).status).toBe(200)
    expect((await app.request(`/api/items/${b}/dismiss`, { method: 'POST' })).status).toBe(200)
    const annRes = await app.request(`/api/items/${a}/annotate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'noted' }),
    })
    expect(annRes.status).toBe(200)
    const rows = listItems(db)
    expect(rows.find((r) => r.id === a)!.status).toBe('resolved')
    expect(rows.find((r) => r.id === a)!.annotation).toBe('noted')
    expect(rows.find((r) => r.id === b)!.status).toBe('dismissed')
  })
})

describe('boards api', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  it('GET /api/boards returns active boards with rows + progress', async () => {
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'coverage', rows: [
      { label: 'theme', status: 'done', context: 'shipped in dark-mode PR' }, { label: 'stems', status: 'partial' }, { label: 'na-row', status: 'na' },
    ] })
    const res = await createViewer(db).request('/api/boards')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveLength(1)
    expect(body[0].title).toBe('coverage')
    expect(body[0].rows.map((r: { label: string }) => r.label)).toEqual(['theme', 'stems', 'na-row'])
    expect(body[0].rows[0].context).toBe('shipped in dark-mode PR')
    expect(body[0].progress.countable).toBe(2)
    expect(body[0].progress.fraction).toBeCloseTo(0.75) // (1 + 0.5)/2
  })

  it('POST archive removes the board from the active list', async () => {
    const { boardId } = upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'x', status: 'done' }] })
    const app = createViewer(db)
    expect((await app.request(`/api/boards/${boardId}/archive`, { method: 'POST' })).status).toBe(200)
    expect(listBoards(db)).toHaveLength(0)
  })

  it('POST unarchive returns the board to the active list', async () => {
    const { boardId } = upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'x', status: 'done' }] })
    const app = createViewer(db)
    expect((await app.request(`/api/boards/${boardId}/archive`, { method: 'POST' })).status).toBe(200)
    expect((await app.request(`/api/boards/${boardId}/unarchive`, { method: 'POST' })).status).toBe(200)
    expect(listBoards(db)).toHaveLength(1)
    expect(listBoards(db, { status: 'archived' })).toHaveLength(0)
  })

  it('GET /api/boards/archived returns archived boards with rows + progress', async () => {
    const { boardId } = upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'old effort', rows: [{ label: 'x', status: 'done' }] })
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'still active', rows: [{ label: 'y', status: 'tracked' }] })
    const app = createViewer(db)
    await app.request(`/api/boards/${boardId}/archive`, { method: 'POST' })
    const res = await app.request('/api/boards/archived')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveLength(1)
    expect(body[0].title).toBe('old effort')
    expect(body[0].status).toBe('archived')
    expect(body[0].rows[0].label).toBe('x')
    expect(body[0].progress.done).toBe(1)
    // active list is untouched by the archived endpoint
    const active = await (await app.request('/api/boards')).json()
    expect(active).toHaveLength(1)
    expect(active[0].title).toBe('still active')
  })

  it('POST row annotate sets the human note and survives a re-upsert', async () => {
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'x', status: 'missing' }] })
    const board = listBoards(db)[0]!
    const rowId = board.rows[0]!.id
    const app = createViewer(db)
    const res = await app.request(`/api/boards/${board.id}/rows/${rowId}/annotate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'do this next' }),
    })
    expect(res.status).toBe(200)
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'x', status: 'done' }] })
    expect(listBoards(db)[0]!.rows[0]!.annotation).toBe('do this next')
  })

  it('GET /api/boards exposes annotation_unseen and does not mark the board read', async () => {
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'x', status: 'missing' }] })
    annotateBoardRow(db, listBoards(db)[0]!.rows[0]!.id, 'new note')
    const app = createViewer(db)
    const first = await (await app.request('/api/boards')).json()
    expect(first[0].rows[0].annotation_unseen).toBe(true)
    const second = await (await app.request('/api/boards')).json() // human watching ≠ agent reading
    expect(second[0].rows[0].annotation_unseen).toBe(true)
  })
})
