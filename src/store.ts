import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdirSync } from 'node:fs'

export type Kind = 'question' | 'note' | 'done'
export type Status = 'open' | 'resolved' | 'dismissed'

// a proposed answer the agent attaches to a question; detail carries the
// tradeoffs shown in the viewer's compare view
export interface QuestionOption {
  label: string
  detail?: string
  recommended?: boolean
}

export interface Item {
  id: string
  project: string
  stream: string
  agent: string
  kind: Kind
  title: string
  detail: string
  context: string
  status: Status
  annotation: string | null
  options: QuestionOption[] | null
  reply: string | null
  replied_at: string | null
  reply_seen_at: string | null
  created_at: string
  resolved_at: string | null
}

export interface NewItem {
  project: string
  stream: string
  agent: string
  kind: Kind
  title: string
  detail?: string
  context?: string
  options?: QuestionOption[]
}

export function defaultDbPath(): string {
  return process.env.AGENT_INBOX_DB ?? join(homedir(), '.agent-inbox', 'inbox.db')
}

export function openDb(path: string = defaultDbPath()): Database.Database {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  migrate(db)
  return db
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      stream TEXT NOT NULL DEFAULT '',
      agent TEXT NOT NULL DEFAULT 'unknown',
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      annotation TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_items_status_project ON items(status, project);
    CREATE INDEX IF NOT EXISTS idx_items_created ON items(created_at);
    CREATE TABLE IF NOT EXISTS boards (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      stream TEXT NOT NULL DEFAULT '',
      agent TEXT NOT NULL DEFAULT 'unknown',
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_read_at TEXT,
      UNIQUE(project, title)
    );
    CREATE TABLE IF NOT EXISTS board_rows (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL,
      label TEXT NOT NULL,
      status TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      context TEXT NOT NULL DEFAULT '',
      annotation TEXT,
      annotated_at TEXT,
      position INTEGER NOT NULL,
      UNIQUE(board_id, label)
    );
    CREATE INDEX IF NOT EXISTS idx_boards_status_project ON boards(status, project);
    CREATE INDEX IF NOT EXISTS idx_board_rows_board ON board_rows(board_id, position);
  `)
  ensureColumn(db, 'board_rows', 'context', `TEXT NOT NULL DEFAULT ''`)
  ensureColumn(db, 'board_rows', 'annotated_at', 'TEXT')
  ensureColumn(db, 'boards', 'last_read_at', 'TEXT')
  ensureColumn(db, 'items', 'context', `TEXT NOT NULL DEFAULT ''`)
  ensureColumn(db, 'items', 'options', 'TEXT')
  ensureColumn(db, 'items', 'reply', 'TEXT')
  ensureColumn(db, 'items', 'replied_at', 'TEXT')
  ensureColumn(db, 'items', 'reply_seen_at', 'TEXT')
}

// additive migration for DBs created before the column existed
function ensureColumn(db: Database.Database, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
}

export function insertItem(db: Database.Database, item: NewItem): string {
  // milestones are announcements — re-announcing the same open milestone
  // (agent retries, re-runs) must not stack duplicates
  if (item.kind === 'done') {
    const existing = db
      .prepare(`SELECT id FROM items WHERE kind = 'done' AND status = 'open' AND project = ? AND title = ?`)
      .get(item.project, item.title) as { id: string } | undefined
    if (existing) return existing.id
  }
  const id = randomUUID()
  db.prepare(
    `INSERT INTO items (id, project, stream, agent, kind, title, detail, context, options, status, created_at)
     VALUES (@id, @project, @stream, @agent, @kind, @title, @detail, @context, @options, 'open', @created_at)`,
  ).run({
    id,
    project: item.project,
    stream: item.stream,
    agent: item.agent,
    kind: item.kind,
    title: item.title,
    detail: item.detail ?? '',
    context: item.context ?? '',
    options: item.options?.length ? JSON.stringify(item.options) : null,
    created_at: new Date().toISOString(),
  })
  return id
}

export function replyItem(db: Database.Database, id: string, text: string): void {
  // a changed answer resets pickup — the agent must see the latest reply;
  // an empty answer reverts the question to unanswered (null, never '')
  db.prepare(`UPDATE items SET reply = ?, replied_at = ?, reply_seen_at = NULL WHERE id = ?`)
    .run(text.trim() ? text : null, new Date().toISOString(), id)
}

export function markReplySeen(db: Database.Database, id: string): void {
  db.prepare(`UPDATE items SET reply_seen_at = ? WHERE id = ?`).run(new Date().toISOString(), id)
}

export function listPending(db: Database.Database, project: string): Item[] {
  const rows = db
    .prepare(`SELECT * FROM items WHERE status = 'open' AND kind = 'question' AND project = ? ORDER BY created_at ASC`)
    .all(project)
  return (rows as Array<Omit<Item, 'options'> & { options: string | null }>).map(parseItem)
}

function parseItem(row: Omit<Item, 'options'> & { options: string | null }): Item {
  return { ...row, options: row.options ? (JSON.parse(row.options) as QuestionOption[]) : null }
}

export function resolveItem(db: Database.Database, id: string): void {
  db.prepare(`UPDATE items SET status = 'resolved', resolved_at = ? WHERE id = ?`).run(new Date().toISOString(), id)
}

export function dismissItem(db: Database.Database, id: string): void {
  db.prepare(`UPDATE items SET status = 'dismissed' WHERE id = ?`).run(id)
}

export function annotateItem(db: Database.Database, id: string, text: string): void {
  db.prepare(`UPDATE items SET annotation = ? WHERE id = ?`).run(text, id)
}

export function listItems(db: Database.Database, opts: { status?: Status } = {}): Item[] {
  const rows = opts.status
    ? db.prepare(`SELECT * FROM items WHERE status = ? ORDER BY created_at DESC`).all(opts.status)
    : db.prepare(`SELECT * FROM items ORDER BY created_at DESC`).all()
  return (rows as Array<Omit<Item, 'options'> & { options: string | null }>).map(parseItem)
}

// 'blocked' = the row needs human input and escalates into the attention layer
export type RowStatus = 'done' | 'partial' | 'missing' | 'tracked' | 'na' | 'blocked'

export interface Board {
  id: string
  project: string
  stream: string
  agent: string
  title: string
  status: 'active' | 'archived'
  created_at: string
  updated_at: string
  last_read_at: string | null
}

export interface BoardRow {
  id: string
  label: string
  status: RowStatus
  note: string
  context: string
  annotation: string | null
  annotated_at: string | null
  position: number
  annotation_unseen: boolean
}

type BoardRowRecord = Omit<BoardRow, 'annotation_unseen'>

// an annotation is "unseen" until the agent reads the board after it was written
function withUnseen(rows: BoardRowRecord[], lastReadAt: string | null): BoardRow[] {
  return rows.map((r) => ({
    ...r,
    annotation_unseen:
      r.annotation != null && r.annotation !== '' &&
      (lastReadAt === null ? true : r.annotated_at !== null && r.annotated_at > lastReadAt),
  }))
}

export interface Progress {
  done: number
  partial: number
  missing: number
  tracked: number
  na: number
  blocked: number
  total: number
  countable: number
  fraction: number
}

export interface BoardWithRows extends Board {
  rows: BoardRow[]
  progress: Progress
}

export interface NewBoardRow {
  label: string
  status: RowStatus
  note?: string
  context?: string
}

export function findBoard(db: Database.Database, project: string, title: string): Board | undefined {
  return db.prepare(`SELECT * FROM boards WHERE project = ? AND title = ?`).get(project, title) as Board | undefined
}

interface UpsertBoardInput {
  project: string
  stream: string
  agent: string
  title: string
  rows: NewBoardRow[]
}

export function upsertBoard(db: Database.Database, input: UpsertBoardInput): { boardId: string; rowCount: number } {
  const run = db.transaction((inp: UpsertBoardInput): { boardId: string; rowCount: number } => {
    const now = new Date().toISOString()
    const boardId = ensureBoard(db, inp, now)
    const existing = db.prepare(`SELECT id, label FROM board_rows WHERE board_id = ?`).all(boardId) as { id: string; label: string }[]
    const idByLabel = new Map(existing.map((r) => [r.label, r.id]))
    const incoming = new Set<string>()
    inp.rows.forEach((r, i) => {
      incoming.add(r.label)
      const existingId = idByLabel.get(r.label)
      if (existingId) {
        // annotation column is deliberately NOT touched — human notes survive
        db.prepare(`UPDATE board_rows SET status = ?, note = ?, context = ?, position = ? WHERE id = ?`).run(r.status, r.note ?? '', r.context ?? '', i, existingId)
      } else {
        db.prepare(`INSERT INTO board_rows (id, board_id, label, status, note, context, position) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(randomUUID(), boardId, r.label, r.status, r.note ?? '', r.context ?? '', i)
      }
    })
    for (const r of existing) if (!incoming.has(r.label)) db.prepare(`DELETE FROM board_rows WHERE id = ?`).run(r.id)
    return { boardId, rowCount: inp.rows.length }
  })
  return run(input)
}

interface UpdateRowInput {
  project: string
  stream: string
  agent: string
  title: string
  label: string
  status?: RowStatus
  note?: string
  context?: string
}

export function updateBoardRow(db: Database.Database, input: UpdateRowInput): { boardId: string; rowId: string } {
  const run = db.transaction((inp: UpdateRowInput): { boardId: string; rowId: string } => {
    const now = new Date().toISOString()
    const boardId = ensureBoard(db, inp, now)
    const existing = db.prepare(`SELECT id FROM board_rows WHERE board_id = ? AND label = ?`).get(boardId, inp.label) as { id: string } | undefined
    if (existing) {
      if (inp.status !== undefined) db.prepare(`UPDATE board_rows SET status = ? WHERE id = ?`).run(inp.status, existing.id)
      if (inp.note !== undefined) db.prepare(`UPDATE board_rows SET note = ? WHERE id = ?`).run(inp.note, existing.id)
      if (inp.context !== undefined) db.prepare(`UPDATE board_rows SET context = ? WHERE id = ?`).run(inp.context, existing.id)
      return { boardId, rowId: existing.id }
    }
    const rowId = randomUUID()
    const pos = (db.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM board_rows WHERE board_id = ?`).get(boardId) as { p: number }).p
    db.prepare(`INSERT INTO board_rows (id, board_id, label, status, note, context, position) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(rowId, boardId, inp.label, inp.status ?? 'tracked', inp.note ?? '', inp.context ?? '', pos)
    return { boardId, rowId }
  })
  return run(input)
}

// Find-or-create the board row and stamp the last writer. Shared by upsertBoard/updateBoardRow.
function ensureBoard(db: Database.Database, inp: { project: string; stream: string; agent: string; title: string }, now: string): string {
  const board = findBoard(db, inp.project, inp.title)
  if (board) {
    db.prepare(`UPDATE boards SET stream = ?, agent = ?, updated_at = ? WHERE id = ?`).run(inp.stream, inp.agent, now, board.id)
    return board.id
  }
  const boardId = randomUUID()
  db.prepare(`INSERT INTO boards (id, project, stream, agent, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`)
    .run(boardId, inp.project, inp.stream, inp.agent, inp.title, now, now)
  return boardId
}

export function archiveBoard(db: Database.Database, boardId: string): void {
  db.prepare(`UPDATE boards SET status = 'archived', updated_at = ? WHERE id = ?`).run(new Date().toISOString(), boardId)
}

export function unarchiveBoard(db: Database.Database, boardId: string): void {
  db.prepare(`UPDATE boards SET status = 'active', updated_at = ? WHERE id = ?`).run(new Date().toISOString(), boardId)
}

export function annotateBoardRow(db: Database.Database, rowId: string, text: string): void {
  db.prepare(`UPDATE board_rows SET annotation = ?, annotated_at = ? WHERE id = ?`).run(text, new Date().toISOString(), rowId)
}

export function markBoardRead(db: Database.Database, boardId: string): void {
  db.prepare(`UPDATE boards SET last_read_at = ? WHERE id = ?`).run(new Date().toISOString(), boardId)
}

export function computeProgress(rows: BoardRow[]): Progress {
  const counts = { done: 0, partial: 0, missing: 0, tracked: 0, na: 0, blocked: 0 }
  for (const r of rows) counts[r.status]++
  const total = rows.length
  const countable = total - counts.na
  const fraction = countable > 0 ? (counts.done + 0.5 * counts.partial) / countable : 0
  return { ...counts, total, countable, fraction }
}

export function listBoards(db: Database.Database, opts: { status?: 'active' | 'archived' } = {}): BoardWithRows[] {
  const status = opts.status ?? 'active'
  const boards = db.prepare(`SELECT * FROM boards WHERE status = ? ORDER BY updated_at DESC`).all(status) as Board[]
  const rowStmt = db.prepare(`SELECT id, label, status, note, context, annotation, annotated_at, position FROM board_rows WHERE board_id = ? ORDER BY position ASC`)
  return boards.map((b) => {
    const rows = withUnseen(rowStmt.all(b.id) as BoardRowRecord[], b.last_read_at)
    return { ...b, rows, progress: computeProgress(rows) }
  })
}

export function getBoard(db: Database.Database, project: string, title: string): BoardWithRows | undefined {
  const board = findBoard(db, project, title)
  if (!board || board.status !== 'active') return undefined
  const rows = withUnseen(
    db.prepare(`SELECT id, label, status, note, context, annotation, annotated_at, position FROM board_rows WHERE board_id = ? ORDER BY position ASC`).all(board.id) as BoardRowRecord[],
    board.last_read_at,
  )
  return { ...board, rows, progress: computeProgress(rows) }
}
