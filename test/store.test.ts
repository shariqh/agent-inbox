import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { openDb, insertItem, resolveItem, dismissItem, annotateItem, listItems } from '../src/store.js'

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-'))
  return openDb(join(dir, 'inbox.db'))
}

describe('store', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  it('inserts an open item and reads it back', () => {
    const id = insertItem(db, { project: 'social-agent', stream: 'main', agent: 'claude-code', kind: 'question', title: 'double jump or wall climb?' })
    const items = listItems(db)
    expect(items).toHaveLength(1)
    const it0 = items[0]!
    expect(it0.id).toBe(id)
    expect(it0.status).toBe('open')
    expect(it0.kind).toBe('question')
    expect(it0.detail).toBe('')
    expect(it0.annotation).toBeNull()
    expect(it0.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(it0.resolved_at).toBeNull()
  })

  it('resolve sets status + resolved_at, and is idempotent', () => {
    const id = insertItem(db, { project: 'p', stream: '', agent: 'copilot', kind: 'note', title: 'assumed X' })
    resolveItem(db, id)
    resolveItem(db, id) // no throw
    const it0 = listItems(db)[0]!
    expect(it0.status).toBe('resolved')
    expect(it0.resolved_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('dismiss sets status dismissed', () => {
    const id = insertItem(db, { project: 'p', stream: '', agent: 'claude-code', kind: 'note', title: 'tech debt here' })
    dismissItem(db, id)
    expect(listItems(db)[0]!.status).toBe('dismissed')
  })

  it('annotate stores my private note', () => {
    const id = insertItem(db, { project: 'p', stream: '', agent: 'claude-code', kind: 'question', title: 'which db?' })
    annotateItem(db, id, 'use sqlite')
    expect(listItems(db)[0]!.annotation).toBe('use sqlite')
  })

  it('listItems filters by status and returns newest first', () => {
    const a = insertItem(db, { project: 'p', stream: '', agent: 'claude-code', kind: 'note', title: 'first' })
    const b = insertItem(db, { project: 'p', stream: '', agent: 'claude-code', kind: 'note', title: 'second' })
    resolveItem(db, a)
    expect(listItems(db).map((i) => i.title)).toEqual(['second', 'first'])
    expect(listItems(db, { status: 'open' }).map((i) => i.id)).toEqual([b])
    expect(listItems(db, { status: 'resolved' }).map((i) => i.id)).toEqual([a])
  })

  it('resolve on unknown id is a no-op', () => {
    resolveItem(db, 'nope') // must not throw
    expect(listItems(db)).toHaveLength(0)
  })
})
