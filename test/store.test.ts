import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import {
  openDb,
  insertItem,
  resolveItem,
  dismissItem,
  annotateItem,
  listItems,
  upsertBoard,
  updateBoardRow,
  findBoard,
  archiveBoard,
  unarchiveBoard,
  annotateBoardRow,
  listBoards,
  computeProgress,
  getBoard,
  markBoardRead,
} from '../src/store.js'
import type { BoardRow } from '../src/store.js'

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

describe('boards', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  const rows = [
    { label: 'theme', status: 'done' as const, note: 'both modes' },
    { label: 'stems', status: 'partial' as const },
    { label: 'mobile', status: 'tracked' as const, note: '#29' },
    { label: 'multi', status: 'missing' as const },
    { label: 'legacy', status: 'na' as const },
  ]

  it('upsert creates a board with rows, defaults note to empty', () => {
    const { boardId, rowCount } = upsertBoard(db, { project: 'p', stream: 'main', agent: 'claude-code', title: 'coverage', rows })
    expect(boardId).toBeTruthy()
    expect(rowCount).toBe(5)
    const board = listBoards(db)[0]!
    expect(board.title).toBe('coverage')
    expect(board.status).toBe('active')
    expect(board.rows.map((r) => r.label)).toEqual(['theme', 'stems', 'mobile', 'multi', 'legacy'])
    expect(board.rows[1]!.note).toBe('') // partial had no note
    expect(board.rows[0]!.annotation).toBeNull()
  })

  it('upsert is idempotent by (project, title) and reconciles rows by label', () => {
    const first = upsertBoard(db, { project: 'p', stream: 'main', agent: 'claude-code', title: 'coverage', rows })
    const second = upsertBoard(db, {
      project: 'p', stream: 'other', agent: 'claude-code', title: 'coverage',
      rows: [
        { label: 'theme', status: 'done', note: 'still good' }, // updated note
        { label: 'stems', status: 'done' },                     // partial → done
        { label: 'new', status: 'missing' },                    // added
      ],                                                          // 'mobile','multi','legacy' dropped
    })
    expect(second.boardId).toBe(first.boardId)          // same board
    expect(listBoards(db)).toHaveLength(1)
    const board = listBoards(db)[0]!
    expect(board.rows.map((r) => r.label)).toEqual(['theme', 'stems', 'new'])
    expect(board.rows[0]!.note).toBe('still good')
    expect(board.rows[1]!.status).toBe('done')
    expect(board.stream).toBe('other')                  // last writer recorded
  })

  it('upsert preserves a human annotation on a surviving row', () => {
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows })
    const themeId = listBoards(db)[0]!.rows.find((r) => r.label === 'theme')!.id
    annotateBoardRow(db, themeId, 'look here')
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'theme', status: 'partial' }] })
    const theme = listBoards(db)[0]!.rows.find((r) => r.label === 'theme')!
    expect(theme.status).toBe('partial')      // agent content updated
    expect(theme.annotation).toBe('look here') // human note preserved
  })

  it('updateBoardRow updates one row, and creates board+row when absent (default status tracked)', () => {
    updateBoardRow(db, { project: 'p', stream: '', agent: 'a', title: 'fresh', label: 'deploy', note: 'pending' })
    const board = listBoards(db)[0]!
    expect(board.title).toBe('fresh')
    expect(board.rows[0]!.status).toBe('tracked') // default for a new row with no status
    expect(board.rows[0]!.note).toBe('pending')
    updateBoardRow(db, { project: 'p', stream: '', agent: 'a', title: 'fresh', label: 'deploy', status: 'done' })
    const after = listBoards(db)[0]!.rows[0]!
    expect(after.status).toBe('done')
    expect(after.note).toBe('pending') // note untouched when omitted
  })

  it('rows carry an optional long-form context, defaulting to empty', () => {
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [
      { label: 'x', status: 'partial', context: 'tried A first; blocked on B — see PR #4' },
      { label: 'y', status: 'done' },
    ] })
    const b = listBoards(db)[0]!
    expect(b.rows[0]!.context).toBe('tried A first; blocked on B — see PR #4')
    expect(b.rows[1]!.context).toBe('')
  })

  it('upsert updates context like note, still preserving the human annotation', () => {
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'x', status: 'missing', context: 'v1' }] })
    const rowId = listBoards(db)[0]!.rows[0]!.id
    annotateBoardRow(db, rowId, 'human note')
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'x', status: 'partial', context: 'v2' }] })
    const row = listBoards(db)[0]!.rows[0]!
    expect(row.context).toBe('v2')            // agent-owned, last write wins
    expect(row.annotation).toBe('human note') // human-owned, preserved
  })

  it('updateBoardRow sets context, and leaves it when omitted', () => {
    updateBoardRow(db, { project: 'p', stream: '', agent: 'a', title: 'c', label: 'x', status: 'partial', context: 'long story' })
    expect(listBoards(db)[0]!.rows[0]!.context).toBe('long story')
    updateBoardRow(db, { project: 'p', stream: '', agent: 'a', title: 'c', label: 'x', status: 'done' })
    const row = listBoards(db)[0]!.rows[0]!
    expect(row.status).toBe('done')
    expect(row.context).toBe('long story') // untouched when omitted
  })

  it('openDb migrates a pre-context db by adding the column', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'inbox-legacy-')), 'inbox.db')
    const legacy = new Database(path)
    legacy.exec(`
      CREATE TABLE board_rows (
        id TEXT PRIMARY KEY,
        board_id TEXT NOT NULL,
        label TEXT NOT NULL,
        status TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        annotation TEXT,
        position INTEGER NOT NULL,
        UNIQUE(board_id, label)
      );
    `)
    legacy.close()
    const db2 = openDb(path)
    upsertBoard(db2, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'x', status: 'done', context: 'why' }] })
    expect(listBoards(db2)[0]!.rows[0]!.context).toBe('why')
  })

  it('archive hides a board from the default (active) list', () => {
    const { boardId } = upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows })
    archiveBoard(db, boardId)
    expect(listBoards(db)).toHaveLength(0)
    expect(listBoards(db, { status: 'archived' })).toHaveLength(1)
  })

  it('unarchive restores a board to the active list and bumps updated_at', () => {
    const { boardId } = upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows })
    archiveBoard(db, boardId)
    const archived = listBoards(db, { status: 'archived' })[0]!
    unarchiveBoard(db, boardId)
    expect(listBoards(db, { status: 'archived' })).toHaveLength(0)
    const active = listBoards(db)
    expect(active).toHaveLength(1)
    expect(active[0]!.status).toBe('active')
    expect(active[0]!.updated_at >= archived.updated_at).toBe(true)
  })

  it('computeProgress weights done=1, partial=0.5, missing/tracked=0, excludes na', () => {
    const board = (() => { upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows }); return listBoards(db)[0]! })()
    const p = board.progress
    expect(p.total).toBe(5)
    expect(p.na).toBe(1)
    expect(p.countable).toBe(4)                 // 5 - 1 na
    expect(p.done).toBe(1); expect(p.partial).toBe(1); expect(p.missing).toBe(1); expect(p.tracked).toBe(1)
    expect(p.fraction).toBeCloseTo((1 + 0.5) / 4) // 0.375
  })

  it('computeProgress of an empty board is fraction 0, not NaN', () => {
    expect(computeProgress([] as BoardRow[]).fraction).toBe(0)
  })
})

describe('unseen annotations', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  function seed(): { boardId: string; rowId: string } {
    const { boardId } = upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'x', status: 'missing' }] })
    return { boardId, rowId: listBoards(db)[0]!.rows[0]!.id }
  }

  it('an annotation on a never-read board is unseen and stamped', () => {
    const { rowId } = seed()
    annotateBoardRow(db, rowId, 'look here')
    const row = listBoards(db)[0]!.rows[0]!
    expect(row.annotated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(row.annotation_unseen).toBe(true)
  })

  it('rows without an annotation are never unseen', () => {
    seed()
    expect(listBoards(db)[0]!.rows[0]!.annotation_unseen).toBe(false)
  })

  it('markBoardRead clears unseen; a later annotation re-raises it', async () => {
    const { boardId, rowId } = seed()
    annotateBoardRow(db, rowId, 'first note')
    markBoardRead(db, boardId)
    const board = listBoards(db)[0]!
    expect(board.last_read_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(board.rows[0]!.annotation_unseen).toBe(false)
    await new Promise((r) => setTimeout(r, 5)) // let the clock tick past last_read_at
    annotateBoardRow(db, rowId, 'second note')
    expect(listBoards(db)[0]!.rows[0]!.annotation_unseen).toBe(true)
  })

  it('getBoard derives the same unseen flag', () => {
    const { rowId } = seed()
    annotateBoardRow(db, rowId, 'psst')
    expect(getBoard(db, 'p', 'c')!.rows[0]!.annotation_unseen).toBe(true)
  })

  it('openDb migrates legacy tables missing last_read_at/annotated_at', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'inbox-legacy2-')), 'inbox.db')
    const legacy = new Database(path)
    legacy.exec(`
      CREATE TABLE boards (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, stream TEXT NOT NULL DEFAULT '',
        agent TEXT NOT NULL DEFAULT 'unknown', title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(project, title)
      );
      CREATE TABLE board_rows (
        id TEXT PRIMARY KEY, board_id TEXT NOT NULL, label TEXT NOT NULL, status TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '', context TEXT NOT NULL DEFAULT '', annotation TEXT,
        position INTEGER NOT NULL, UNIQUE(board_id, label)
      );
    `)
    legacy.close()
    const db2 = openDb(path)
    const { boardId } = upsertBoard(db2, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'x', status: 'done' }] })
    annotateBoardRow(db2, listBoards(db2)[0]!.rows[0]!.id, 'note')
    markBoardRead(db2, boardId)
    expect(listBoards(db2)[0]!.rows[0]!.annotation_unseen).toBe(false)
  })
})

describe('getBoard (agent read)', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  it('returns one board with rows + progress, scoped by project+title', () => {
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'cov', rows: [
      { label: 'x', status: 'done' }, { label: 'y', status: 'partial' },
    ] })
    upsertBoard(db, { project: 'other', stream: '', agent: 'a', title: 'cov', rows: [{ label: 'z', status: 'missing' }] })
    const b = getBoard(db, 'p', 'cov')!
    expect(b.title).toBe('cov')
    expect(b.rows.map((r) => r.label)).toEqual(['x', 'y'])   // project-scoped, not 'other's row
    expect(b.progress.fraction).toBeCloseTo((1 + 0.5) / 2)
  })

  it('surfaces a human annotation and the row context to the reader', () => {
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'cov', rows: [{ label: 'x', status: 'missing', context: 'backstory' }] })
    const rowId = getBoard(db, 'p', 'cov')!.rows[0]!.id
    annotateBoardRow(db, rowId, 'do this next')
    const row = getBoard(db, 'p', 'cov')!.rows[0]!
    expect(row.annotation).toBe('do this next')
    expect(row.context).toBe('backstory')
  })

  it('returns undefined for a missing or archived board', () => {
    expect(getBoard(db, 'p', 'nope')).toBeUndefined()
    const { boardId } = upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'cov', rows: [{ label: 'x', status: 'done' }] })
    archiveBoard(db, boardId)
    expect(getBoard(db, 'p', 'cov')).toBeUndefined()
  })
})
