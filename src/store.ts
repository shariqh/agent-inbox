import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdirSync } from 'node:fs'

export type Kind = 'question' | 'note' | 'done'
export type Status = 'open' | 'resolved' | 'dismissed'
// which channel the current answer came through: the human typed it into the
// inbox card, or an agent recorded what they said in chat (issue #29)
export type ReplySource = 'inbox' | 'agent'

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
  // The agent session that raised this item — lets the viewer tell whether the
  // asking agent is still alive (null on legacy rows and non-agent inserts).
  //
  // TWO ID SPACES LIVE IN THIS COLUMN. Normally it is an MCP session id (a
  // randomUUID minted in src/mcp.ts), which is also what `activity.session`
  // holds, so classifyLiveness can join them. A backstop item written by the
  // hooks runtime (src/hook.ts, issue #10) instead carries the *harness*
  // (Claude Code) session id, which is never in the activity table — so the
  // join always misses and the item can never classify 'waiting'. It gets
  // 'parked', and 'stale' once older than STALE_MS (72h); both are
  // non-escalating, which is the point. That degradation is deliberate and
  // load-bearing: a hook item can therefore never masquerade as a live blocked
  // agent or escalate a rail badge to red. Any future code that joins this
  // column against `activity` must know both spaces are here.
  session: string | null
  kind: Kind
  title: string
  detail: string
  context: string
  status: Status
  annotation: string | null
  options: QuestionOption[] | null
  reply: string | null
  reply_context: string | null
  replied_at: string | null
  reply_seen_at: string | null
  reply_source: ReplySource | null
  // issue #30 — the source-link identity inferred locally at write time:
  // `owner/name` for a github.com remote, and the issue number the BRANCH names.
  // Both null whenever the answer was not unambiguous, and null on every row
  // written before #30 (the additive migration backfills nothing — deliberately;
  // there is no way to know what a historical item's remote was).
  repo: string | null
  issue_ref: number | null
  created_at: string
  resolved_at: string | null
}

export interface NewItem {
  project: string
  stream: string
  agent: string
  session?: string
  kind: Kind
  title: string
  detail?: string
  context?: string
  options?: QuestionOption[]
  // optional on the WRITE shape: every pre-#30 call site passes neither
  repo?: string | null
  issue_ref?: number | null
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
    CREATE TABLE IF NOT EXISTS activity (
      session TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      stream TEXT NOT NULL DEFAULT '',
      agent TEXT NOT NULL DEFAULT 'unknown',
      doing TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      children TEXT,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      ended_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_activity_live ON activity(ended_at, updated_at);
    CREATE TABLE IF NOT EXISTS projects (
      project TEXT PRIMARY KEY,
      closed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_items_project_created ON items(project, created_at);
    CREATE TABLE IF NOT EXISTS source_links (
      repo TEXT NOT NULL,
      branch TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'github',
      pr_number INTEGER,
      pr_url TEXT,
      pr_title TEXT,
      pr_state TEXT,
      pr_draft INTEGER,
      review_decision TEXT,
      checks TEXT,
      issue_number INTEGER,
      issue_url TEXT,
      issue_title TEXT,
      tldr TEXT,
      fetched_at TEXT,
      checked_at TEXT NOT NULL,
      error TEXT,
      PRIMARY KEY (repo, branch)
    );
  `)
  ensureColumn(db, 'board_rows', 'context', `TEXT NOT NULL DEFAULT ''`)
  ensureColumn(db, 'board_rows', 'annotated_at', 'TEXT')
  ensureColumn(db, 'boards', 'last_read_at', 'TEXT')
  ensureColumn(db, 'activity', 'idle', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'items', 'context', `TEXT NOT NULL DEFAULT ''`)
  ensureColumn(db, 'items', 'options', 'TEXT')
  ensureColumn(db, 'items', 'reply', 'TEXT')
  ensureColumn(db, 'items', 'reply_context', 'TEXT')
  ensureColumn(db, 'items', 'replied_at', 'TEXT')
  ensureColumn(db, 'items', 'reply_seen_at', 'TEXT')
  ensureColumn(db, 'items', 'reply_source', 'TEXT')
  ensureColumn(db, 'items', 'session', 'TEXT')
  ensureColumn(db, 'items', 'repo', 'TEXT')
  ensureColumn(db, 'items', 'issue_ref', 'INTEGER')
  ensureColumn(db, 'boards', 'repo', 'TEXT')
  ensureColumn(db, 'boards', 'issue_ref', 'INTEGER')
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
    `INSERT INTO items (id, project, stream, agent, session, kind, title, detail, context, options, repo, issue_ref, status, created_at)
     VALUES (@id, @project, @stream, @agent, @session, @kind, @title, @detail, @context, @options, @repo, @issue_ref, 'open', @created_at)`,
  ).run({
    id,
    project: item.project,
    stream: item.stream,
    agent: item.agent,
    session: item.session ?? null,
    kind: item.kind,
    title: item.title,
    detail: item.detail ?? '',
    context: item.context ?? '',
    options: item.options?.length ? JSON.stringify(item.options) : null,
    repo: item.repo ?? null,
    issue_ref: item.issue_ref ?? null,
    created_at: new Date().toISOString(),
  })
  return id
}

// Returns false when the write was refused, true otherwise — so a caller
// (the viewer's POST handler) can surface a refusal instead of a silent no-op.
export function replyItem(db: Database.Database, id: string, text: string, context?: string): boolean {
  // a changed answer resets pickup — the agent must see the latest reply;
  // an empty answer reverts the question to unanswered (null, never '') — but
  // ONLY when the agent has not already picked the current reply up. Once
  // reply_seen_at is set, blanking the reply would silently erase an answer
  // the agent may already have read and acted on; refuse instead of losing
  // it. This is the authoritative guard — a client-side freshness check alone
  // is a TOCTOU window, not a fix (a stale client snapshot can still read
  // reply_seen_at as null right up until the request lands here).
  const reply = text.trim()
  const replyContext = context?.trim() ?? ''
  if (!reply) {
    // atomic: the guard condition (reply_seen_at IS NULL) is checked and acted on in the
    // SAME statement as the write, so a concurrent markReplySeen from another connection
    // (e.g. the MCP server's `pending` handler, its own OS process) can never land in a
    // window between a read and a later, unconditional write — there is no such window.
    const info = db
      .prepare(`UPDATE items SET reply = NULL, reply_context = NULL, replied_at = ?, reply_seen_at = NULL, reply_source = NULL WHERE id = ? AND reply_seen_at IS NULL`)
      .run(new Date().toISOString(), id)
    return info.changes > 0
  }
  // unconditional by design: the inbox is the higher-precedence channel, so the
  // human's own reply overwrites anything an agent recorded from chat (#29) and
  // resets pickup so that agent has to read the new one.
  db.prepare(`UPDATE items SET reply = ?, reply_context = ?, replied_at = ?, reply_seen_at = NULL, reply_source = 'inbox' WHERE id = ?`)
    .run(reply, replyContext || null, new Date().toISOString(), id)
  return true
}

export function markReplySeen(db: Database.Database, id: string): void {
  db.prepare(`UPDATE items SET reply_seen_at = ? WHERE id = ?`).run(new Date().toISOString(), id)
}

export type AnswerRefusal = 'empty' | 'not_found' | 'not_a_question' | 'not_open' | 'unread_inbox_answer'

export interface AnswerResult {
  ok: boolean
  reason?: AnswerRefusal
  // on 'unread_inbox_answer': the answer that is waiting, so the caller can act
  // on it without a second round-trip
  reply?: string | null
  reply_context?: string | null
}

// The agent-side answer channel (#29): an agent records onto the item what the
// human told it in chat. The precedence rule lives entirely in this statement's
// WHERE clause — an inbox answer the agent has NOT picked up outranks a chat
// answer, so this refuses rather than clobbering it; the human's own replyItem
// stays unconditional and outranks everything. Both orderings converge on the
// inbox answer without comparing clocks.
//
// An agent may RECORD an answer but never ERASE one: blank text is refused here,
// and blanking stays the human's guarded prerogative in replyItem. It MAY
// overwrite a human answer it has already picked up (they said something newer
// out loud) — that case is pinned in test/store.test.ts.
export function answerItem(db: Database.Database, id: string, text: string, context?: string): AnswerResult {
  const reply = text.trim()
  if (!reply) return { ok: false, reason: 'empty' }
  const now = new Date().toISOString()
  // ONE conditioned UPDATE, never SELECT-then-UPDATE and never two UPDATEs: the
  // viewer writes to this same WAL file from its own OS process and can land a
  // reply between two statements. reply_seen_at = replied_at because the agent IS
  // the reader — rendering "waiting for agent pickup" for an answer it authored
  // itself would be a lie. Status stays 'open': recording is not resolving.
  const info = db
    .prepare(
      `UPDATE items SET reply = ?, reply_context = ?, replied_at = ?, reply_seen_at = ?, reply_source = 'agent'
       WHERE id = ? AND kind = 'question' AND status = 'open'
         AND (reply IS NULL OR reply = '' OR reply_seen_at IS NOT NULL)`,
    )
    .run(reply, context?.trim() || null, now, now, id)
  if (info.changes > 0) return { ok: true }
  // Diagnosis is advisory and deliberately runs AFTER the write. Reading first to
  // decide would reopen exactly the TOCTOU window the conditioned UPDATE closes;
  // since nothing was written, a concurrent change here can only make the
  // explanation stale, never the stored state wrong.
  const row = db.prepare(`SELECT kind, status, reply, reply_context FROM items WHERE id = ?`).get(id) as
    | { kind: Kind; status: Status; reply: string | null; reply_context: string | null }
    | undefined
  if (!row) return { ok: false, reason: 'not_found' }
  if (row.kind !== 'question') return { ok: false, reason: 'not_a_question' }
  if (row.status !== 'open') return { ok: false, reason: 'not_open' }
  return { ok: false, reason: 'unread_inbox_answer', reply: row.reply, reply_context: row.reply_context }
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
  // issue #30 — same locally-inferred link identity items carry; null on every
  // board written before #30
  repo: string | null
  issue_ref: number | null
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
  // optional on the WRITE shape: every pre-#30 call site passes neither
  repo?: string | null
  issueRef?: number | null
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
    syncBoardStatus(db, boardId)
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
  repo?: string | null
  issueRef?: number | null
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
      syncBoardStatus(db, boardId)
      return { boardId, rowId: existing.id }
    }
    const rowId = randomUUID()
    const pos = (db.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM board_rows WHERE board_id = ?`).get(boardId) as { p: number }).p
    db.prepare(`INSERT INTO board_rows (id, board_id, label, status, note, context, position) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(rowId, boardId, inp.label, inp.status ?? 'tracked', inp.note ?? '', inp.context ?? '', pos)
    syncBoardStatus(db, boardId)
    return { boardId, rowId }
  })
  return run(input)
}

// After every agent write, a board's active/archived status follows its
// completeness: 100% (with countable rows) → archived immediately (the human's
// chosen lifecycle); anything less → active, which also resurrects an archived
// board the agent is still writing to (the "flickered to 100% mid-update" case).
function syncBoardStatus(db: Database.Database, boardId: string): void {
  const rows = db.prepare(`SELECT status FROM board_rows WHERE board_id = ?`).all(boardId) as { status: RowStatus }[]
  const p = computeProgress(rows as BoardRow[])
  const complete = p.countable > 0 && p.fraction === 1
  db.prepare(`UPDATE boards SET status = ?, updated_at = ? WHERE id = ?`)
    .run(complete ? 'archived' : 'active', new Date().toISOString(), boardId)
}

// Find-or-create the board row and stamp the last writer. Shared by upsertBoard/updateBoardRow.
function ensureBoard(
  db: Database.Database,
  inp: { project: string; stream: string; agent: string; title: string; repo?: string | null; issueRef?: number | null },
  now: string,
): string {
  const board = findBoard(db, inp.project, inp.title)
  // #30's repo/issue_ref are restamped on every write, exactly like stream and
  // agent — the board follows whoever is writing to it now. They belong on the
  // `boards` row and nowhere near board_rows, whose annotation column is the
  // human's and must survive every re-upsert untouched.
  if (board) {
    db.prepare(`UPDATE boards SET stream = ?, agent = ?, repo = ?, issue_ref = ?, updated_at = ? WHERE id = ?`)
      .run(inp.stream, inp.agent, inp.repo ?? null, inp.issueRef ?? null, now, board.id)
    return board.id
  }
  const boardId = randomUUID()
  db.prepare(`INSERT INTO boards (id, project, stream, agent, title, repo, issue_ref, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
    .run(boardId, inp.project, inp.stream, inp.agent, inp.title, inp.repo ?? null, inp.issueRef ?? null, now, now)
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

// ── live activity: ephemeral presence, one row per session ──────────────────

export interface ActivityChild {
  name: string
  doing: string
  state?: string
}

export interface Activity {
  session: string
  project: string
  stream: string
  agent: string
  doing: string
  detail: string
  children: ActivityChild[]
  idle: boolean
  started_at: string
  updated_at: string
}

export interface ActivityUpdate {
  session: string
  project: string
  stream: string
  agent: string
  doing: string
  detail?: string
  children?: ActivityChild[]
  idle?: boolean
}

export function upsertActivity(db: Database.Database, a: ActivityUpdate): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO activity (session, project, stream, agent, doing, detail, children, idle, started_at, updated_at)
     VALUES (@session, @project, @stream, @agent, @doing, @detail, @children, @idle, @now, @now)
     ON CONFLICT(session) DO UPDATE SET
       project = @project, stream = @stream, agent = @agent, doing = @doing,
       detail = COALESCE(NULLIF(@detail, ''), detail),
       children = COALESCE(@children, children),
       idle = @idle,
       updated_at = @now, ended_at = NULL`,
  ).run({
    session: a.session,
    project: a.project,
    stream: a.stream,
    agent: a.agent,
    doing: a.doing,
    detail: a.detail ?? '',
    children: a.children ? JSON.stringify(a.children) : null,
    idle: a.idle ? 1 : 0,
    now,
  })
  // housekeeping: rows dead (ended or silent) for over a day serve no one
  const dayAgo = new Date(Date.now() - 24 * 60 * 60000).toISOString()
  db.prepare(`DELETE FROM activity WHERE (ended_at IS NOT NULL AND ended_at < ?) OR updated_at < ?`).run(dayAgo, dayAgo)
}

export function endActivity(db: Database.Database, session: string): void {
  db.prepare(`UPDATE activity SET ended_at = ? WHERE session = ?`).run(new Date().toISOString(), session)
}

// heartbeat: keep a live session's row from going stale without changing it
export function touchActivity(db: Database.Database, session: string): void {
  db.prepare(`UPDATE activity SET updated_at = ? WHERE session = ? AND ended_at IS NULL`).run(new Date().toISOString(), session)
}

export function listActivity(db: Database.Database, opts: { staleMinutes?: number } = {}): Activity[] {
  const cutoff = new Date(Date.now() - (opts.staleMinutes ?? 15) * 60000).toISOString()
  const rows = db
    .prepare(`SELECT session, project, stream, agent, doing, detail, children, idle, started_at, updated_at
              FROM activity WHERE ended_at IS NULL AND updated_at >= ? ORDER BY idle ASC, started_at ASC`)
    .all(cutoff) as Array<Omit<Activity, 'children' | 'idle'> & { children: string | null; idle: number }>
  return rows.map((r) => ({ ...r, idle: r.idle === 1, children: r.children ? (JSON.parse(r.children) as ActivityChild[]) : [] }))
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

// ── source links: the cached live PR state, one row per (repo, branch) (#30) ──
//
// Written ONLY by the viewer process (src/prstate.ts, which shells out to `gh`);
// read by the viewer's /api/links and joined in the frontend against each item's
// own repo + stream. Keyed per BRANCH rather than per item so N items raised on
// one branch cost one `gh` call, and a merge updates all of them at once.

export interface SourceLink {
  repo: string
  branch: string
  provider: string
  pr_number: number | null
  pr_url: string | null
  pr_title: string | null
  pr_state: string | null
  pr_draft: boolean
  review_decision: string | null
  checks: string | null
  issue_number: number | null
  issue_url: string | null
  issue_title: string | null
  tldr: string | null
  // when the last SUCCESSFUL fetch landed vs when we last tried at all — the
  // gap between them is exactly how stale a still-rendered good row is
  fetched_at: string | null
  checked_at: string
  error: string | null
}

export interface NewSourceLink {
  repo: string
  branch: string
  provider?: string
  pr_number?: number | null
  pr_url?: string | null
  pr_title?: string | null
  pr_state?: string | null
  pr_draft?: boolean
  review_decision?: string | null
  checks?: string | null
  issue_number?: number | null
  issue_url?: string | null
  issue_title?: string | null
  tldr?: string | null
}

export interface LinkTarget {
  repo: string
  branch: string
}

// a cache row unchecked for this long belongs to a branch nobody works on
const LINK_TTL_DAYS = 30
// hard ceiling on how many branches one refresh pass can ever consider
const MAX_LINK_TARGETS = 50

// A successful fetch: writes every field, stamps BOTH timestamps and clears the
// error. Housekeeping rides along, mirroring upsertActivity's day-old sweep.
export function upsertSourceLink(db: Database.Database, link: NewSourceLink): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO source_links (repo, branch, provider, pr_number, pr_url, pr_title, pr_state, pr_draft,
       review_decision, checks, issue_number, issue_url, issue_title, tldr, fetched_at, checked_at, error)
     VALUES (@repo, @branch, @provider, @pr_number, @pr_url, @pr_title, @pr_state, @pr_draft,
       @review_decision, @checks, @issue_number, @issue_url, @issue_title, @tldr, @now, @now, NULL)
     ON CONFLICT(repo, branch) DO UPDATE SET
       provider = @provider, pr_number = @pr_number, pr_url = @pr_url, pr_title = @pr_title,
       pr_state = @pr_state, pr_draft = @pr_draft, review_decision = @review_decision, checks = @checks,
       issue_number = @issue_number, issue_url = @issue_url, issue_title = @issue_title, tldr = @tldr,
       fetched_at = @now, checked_at = @now, error = NULL`,
  ).run({
    repo: link.repo,
    branch: link.branch,
    provider: link.provider ?? 'github',
    pr_number: link.pr_number ?? null,
    pr_url: link.pr_url ?? null,
    pr_title: link.pr_title ?? null,
    pr_state: link.pr_state ?? null,
    pr_draft: link.pr_draft ? 1 : 0,
    review_decision: link.review_decision ?? null,
    checks: link.checks ?? null,
    issue_number: link.issue_number ?? null,
    issue_url: link.issue_url ?? null,
    issue_title: link.issue_title ?? null,
    tldr: link.tldr ?? null,
    now,
  })
  pruneSourceLinks(db)
}

// A FAILED fetch: touches checked_at and error and NOTHING else, so a laptop
// going offline can never blank a good cached row — the human keeps seeing the
// merged PR they saw a minute ago, with an honest "checked N ago" beside it.
// Every column except repo/branch/checked_at is nullable precisely so this
// INSERT half can succeed for a branch that has never been fetched.
export function recordLinkFailure(db: Database.Database, f: { repo: string; branch: string; error: string }): void {
  db.prepare(
    `INSERT INTO source_links (repo, branch, checked_at, error) VALUES (@repo, @branch, @now, @error)
     ON CONFLICT(repo, branch) DO UPDATE SET checked_at = @now, error = @error`,
  ).run({ repo: f.repo, branch: f.branch, error: f.error, now: new Date().toISOString() })
}

export function listSourceLinks(db: Database.Database): SourceLink[] {
  const rows = db.prepare(`SELECT * FROM source_links ORDER BY repo ASC, branch ASC`).all() as Array<
    Omit<SourceLink, 'pr_draft'> & { pr_draft: number | null }
  >
  return rows.map((r) => ({ ...r, pr_draft: r.pr_draft === 1 }))
}

// Which (repo, branch) pairs are worth spending a `gh` call on: the branches
// OPEN items and ACTIVE boards actually sit on. A resolved item's branch stops
// being refreshed but keeps whatever it last cached.
export function listLinkTargets(db: Database.Database): LinkTarget[] {
  const rows = db
    .prepare(
      `SELECT repo, stream AS branch FROM items  WHERE status = 'open'   AND repo IS NOT NULL AND repo <> '' AND stream <> ''
       UNION
       SELECT repo, stream AS branch FROM boards WHERE status = 'active' AND repo IS NOT NULL AND repo <> '' AND stream <> ''
       ORDER BY repo ASC, branch ASC`,
    )
    .all() as LinkTarget[]
  return rows.slice(0, MAX_LINK_TARGETS)
}

export function pruneSourceLinks(db: Database.Database, opts: { nowMs?: number } = {}): void {
  const cutoff = new Date((opts.nowMs ?? Date.now()) - LINK_TTL_DAYS * 24 * 60 * 60000).toISOString()
  db.prepare(`DELETE FROM source_links WHERE checked_at < ?`).run(cutoff)
}

// ── project closure: retiring a dead project tab without losing it (issue #32) ──
//
// Sparse by design: a row exists ONLY for a project the human explicitly closed.
// Closing is PRESENTATION ONLY — nothing is deleted, no item or board is touched,
// and every one of them comes straight back the moment the project is reopened.

export interface ClosedProject {
  project: string
  closed_at: string
}

// Idempotent: re-closing after an implicit reopen simply re-stamps closed_at.
export function closeProject(db: Database.Database, project: string): void {
  db.prepare(
    `INSERT INTO projects (project, closed_at) VALUES (?, ?)
     ON CONFLICT(project) DO UPDATE SET closed_at = excluded.closed_at`,
  ).run(project, new Date().toISOString())
}

export function reopenProject(db: Database.Database, project: string): void {
  db.prepare(`DELETE FROM projects WHERE project = ?`).run(project)
}

// The RAW rows, newest closure first — including projects the derived rule below
// has already reopened (nothing deletes those; the table is bounded by how many
// projects a human has ever closed, which is tiny). Anyone who wants the
// EFFECTIVE closed set must call closedProjects(), never this.
export function listClosedProjects(db: Database.Database): ClosedProject[] {
  return db.prepare(`SELECT project, closed_at FROM projects ORDER BY closed_at DESC`).all() as ClosedProject[]
}

// The EFFECTIVE closed set. Reopen is DERIVED, never written: a project stops
// being closed the moment new CONTENT is created in it.
//
// WHY derived rather than deleting the row inside insertItem: insertItem is the
// one path CLAUDE.md says must never lose a flag, and this way it gains no new
// write and no new failure mode; there is no window in which the item exists but
// the un-close has not run yet; and one rule covers boards and every future
// writer for free.
//
// created_at and closed_at are both ISO-8601 UTC strings from
// `new Date().toISOString()` everywhere in this file, so lexicographic `>` is
// chronologically correct — that is the load-bearing assumption here.
//
// Deliberately NOT reopening on: a board merely re-upserted (ensureBoard moves
// updated_at, never created_at) or a live session appearing (presence is not
// attention). KNOWN LIMITATION, accepted: an agent already blocked on a question
// raised BEFORE the close creates nothing new while it polls pending(), so
// closing that project mutes a genuinely-live blocking question until fresh
// content arrives. Closing is the human's explicit act, and one new flag undoes
// it — but "nothing can be permanently muted" is not true of that one case, and
// saying otherwise would be an overclaim.
export function closedProjects(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT p.project FROM projects p
        WHERE NOT EXISTS (SELECT 1 FROM items  i WHERE i.project = p.project AND i.created_at > p.closed_at)
          AND NOT EXISTS (SELECT 1 FROM boards b WHERE b.project = p.project AND b.created_at > p.closed_at)
        ORDER BY p.project`,
    )
    .all() as { project: string }[]
  return rows.map((r) => r.project)
}
