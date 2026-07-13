import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { openDb, insertItem, listItems } from '../src/store.js'
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
